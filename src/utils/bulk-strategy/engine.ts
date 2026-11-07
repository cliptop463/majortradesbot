import { nextStake, validateConfig } from './config';
import { getStrategy } from './strategies';
import type {
    BulkApi,
    BulkConfig,
    BulkStrategy,
    ContractSpec,
    EngineEvents,
    EngineStatus,
    RoundLog,
    SignalResult,
    Summary,
} from './types';

/**
 * Runs rounds of `bulkSize` identical contracts.
 *
 * Rules the engine enforces:
 *  - Live: each round sends `bulkSize` real buy requests in parallel and follows every contract with
 *    proposal_open_contract until it is sold. Paper: sends NO buy orders. It asks Deriv for a real
 *    proposal (to get the real payout) and settles from the real ticks that follow. Nothing is simulated.
 *  - Round net = sum of contract profits. A round is a loss only if net < 0.
 *  - After a loss the stake is base * multiplier^min(lossStreak, maxSteps); after a win it resets.
 *  - It stops on profit target or max loss, and never starts a round whose worst case would push the
 *    cumulative loss past the max loss.
 *  - Stop forgets every subscription it created.
 */

const SETTLE_TIMEOUT_MS = 120_000;
const round2 = (x: number) => Math.round(x * 100) / 100;

interface ContractOutcome {
    status: 'won' | 'lost' | 'interrupted';
    profit: number;
}

interface RoundOutcome {
    outcomes: ContractOutcome[];
    placed: number;
    errors: string[];
}

export interface EngineOptions {
    currency?: string;
    /** How long to wait for a contract to settle before treating its result as unconfirmed. */
    settleTimeoutMs?: number;
    now?: () => Date;
}

export class BulkEngine {
    private readonly config: BulkConfig;
    private readonly strategy: BulkStrategy;
    private readonly api: BulkApi;
    private readonly events: EngineEvents;
    private readonly currency: string;
    private readonly settleTimeoutMs: number;
    private readonly now: () => Date;

    private running = false;
    private finalized = false;
    private status: EngineStatus = 'idle';

    private ticks: number[] = [];
    private lastScore: number | null = null;
    private tickSubId: string | null = null;
    private passiveTicks = false;
    private subs = new Set<string>();
    private pocSubs = new Map<number, string>();
    private offBus: (() => void) | null = null;

    private cancelSignalWait: (() => void) | null = null;
    private onTickForSignal: (() => void) | null = null;
    private collector: { quotes: number[]; need: number; done: (quotes: number[] | null) => void } | null = null;
    private pocWaiters = new Map<number, (poc: any | null) => void>();
    private timers = new Set<ReturnType<typeof setTimeout>>();

    private logs: RoundLog[] = [];
    private stopReason = '';
    private loop: Promise<void> | null = null;

    private stats = {
        rounds: 0,
        won: 0,
        lost: 0,
        interrupted: 0,
        net: 0,
        lossStreak: 0,
        worstStreak: 0,
        ratioSum: 0,
        ratioCount: 0,
    };

    constructor(config: BulkConfig, api: BulkApi, events: EngineEvents = {}, options: EngineOptions = {}, strategy?: BulkStrategy) {
        const resolved = strategy ?? getStrategy(config.strategyId);
        if (!resolved) throw new Error('Choose a strategy.');
        this.config = { ...config, martingale: { ...config.martingale } };
        this.strategy = resolved;
        this.api = api;
        this.events = events;
        this.currency = options.currency ?? 'USD';
        this.settleTimeoutMs = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
        this.now = options.now ?? (() => new Date());
    }

    // ───────────────────────── public API ─────────────────────────

    isRunning() {
        return this.running;
    }

    getLogs(): RoundLog[] {
        return this.logs.map(l => ({ ...l }));
    }

    getSummary(): Summary {
        const settled = this.stats.won + this.stats.lost;
        return {
            mode: this.config.mode,
            symbol: this.config.symbol,
            rounds: this.stats.rounds,
            contractsWon: this.stats.won,
            contractsLost: this.stats.lost,
            contractsInterrupted: this.stats.interrupted,
            winRate: settled > 0 ? this.stats.won / settled : null,
            net: round2(this.stats.net),
            worstLossStreak: this.stats.worstStreak,
            breakEvenWinRate: this.stats.ratioCount > 0 ? this.stats.ratioSum / this.stats.ratioCount : null,
            stopReason: this.stopReason,
        };
    }

    /** Validates, subscribes to real ticks, then starts running rounds. Rejects with the reason if it cannot start. */
    async start(): Promise<void> {
        if (this.running || this.finalized) throw new Error('This run has already been started.');
        const problems = validateConfig(this.config);
        if (problems.length > 0) throw new Error(problems.join(' '));

        this.running = true;
        this.setStatus('connecting');
        try {
            this.offBus = this.api.onMessage(data => this.onMessage(data));
            await this.subscribeTicks();
        } catch (error) {
            this.stopReason = error instanceof Error ? error.message : String(error);
            this.running = false;
            await this.finalize();
            throw error;
        }
        this.loop = this.run();
    }

    /** Stops placing rounds, forgets every subscription and resolves once everything is cleaned up. */
    async stop(reason = 'Stopped by user'): Promise<void> {
        this.requestStop(reason);
        if (this.loop) await this.loop;
        else await this.finalize();
    }

    // ───────────────────────── lifecycle ─────────────────────────

    private requestStop(reason: string) {
        if (!this.stopReason) this.stopReason = reason;
        this.running = false;
        this.cancelSignalWait?.();
        this.collector?.done(null);
        this.pocWaiters.forEach(waiter => waiter(null));
    }

    private async finalize() {
        if (this.finalized) return;
        this.finalized = true;
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
        const ids = [...this.subs];
        this.subs.clear();
        this.pocSubs.clear();
        await Promise.allSettled(ids.map(id => this.api.send({ forget: id })));
        try {
            this.offBus?.();
        } catch {
            /* connection already gone */
        }
        this.offBus = null;
        this.setStatus('stopped');
        this.events.onStop?.(this.getSummary());
    }

    private setStatus(status: EngineStatus) {
        this.status = status;
        this.events.onStatus?.(status);
    }

    private fail(message: string) {
        this.events.onError?.(message);
        this.requestStop(message);
    }

    // ───────────────────────── real tick stream ─────────────────────────

    private async subscribeTicks() {
        const { symbol } = this.config;
        const count = this.strategy.bufferSize;
        const request = { ticks_history: symbol, adjust_start_time: 1, count, end: 'latest', style: 'ticks' };

        const response = await this.api.send({ ...request, subscribe: 1 });
        if (response?.error) {
            if (response.error.code !== 'AlreadySubscribed') {
                throw new Error(response.error.message || `Could not load ticks for ${symbol}.`);
            }
            // The app already streams this market. Seed from history and listen to its ticks without forgetting them.
            const history = await this.api.send(request);
            if (history?.error) throw new Error(history.error.message || `Could not load ticks for ${symbol}.`);
            this.passiveTicks = true;
            this.seed(history);
            return;
        }
        this.tickSubId = response?.subscription?.id ?? null;
        if (this.tickSubId) this.subs.add(this.tickSubId);
        else this.passiveTicks = true;
        this.seed(response);
    }

    private seed(response: any) {
        const prices: unknown[] = Array.isArray(response?.history?.prices) ? response.history.prices : [];
        prices.forEach(price => {
            const quote = Number(price);
            if (Number.isFinite(quote)) this.ticks.push(quote);
        });
        this.ticks = this.ticks.slice(-this.strategy.bufferSize);
        this.emitTick();
    }

    private onMessage(data: any) {
        if (!data || !this.running) return;
        if (data.msg_type === 'tick' && data.tick) {
            const own = this.tickSubId
                ? data.subscription?.id === this.tickSubId
                : this.passiveTicks && data.tick.symbol === this.config.symbol;
            if (own) this.pushTick(Number(data.tick.quote));
        } else if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
            const poc = data.proposal_open_contract;
            const waiter = this.pocWaiters.get(Number(poc.contract_id));
            if (waiter && this.isSold(poc)) waiter(poc);
        }
    }

    private pushTick(quote: number) {
        if (!Number.isFinite(quote)) return;
        this.ticks.push(quote);
        if (this.ticks.length > this.strategy.bufferSize) this.ticks.shift();
        if (this.collector) {
            this.collector.quotes.push(quote);
            if (this.collector.quotes.length >= this.collector.need) this.collector.done(this.collector.quotes);
        }
        this.onTickForSignal?.();
        this.emitTick();
    }

    private emitTick() {
        this.events.onTick?.({
            last: this.ticks[this.ticks.length - 1] ?? NaN,
            ticks: this.ticks.length,
            score: this.lastScore,
        });
    }

    // ───────────────────────── main loop ─────────────────────────

    private async run() {
        try {
            while (this.running) {
                this.setStatus('waiting');
                const signal = await this.waitForSignal();
                if (!signal || !this.running) break;

                const stake = nextStake(this.config, this.stats.lossStreak);
                const cost = round2(stake * this.config.bulkSize);
                // Hard cap: never start a round that could take the cumulative loss past the max loss.
                if (this.stats.net - cost < -this.config.maxLoss) {
                    this.fail(
                        `Stopped: the next round (cost ${cost.toFixed(2)}) could take the loss past your max loss of ${this.config.maxLoss.toFixed(2)}.`
                    );
                    break;
                }

                this.setStatus('trading');
                await this.playRound(signal, stake);

                if (!this.running) break;
                if (this.config.maxRounds && this.stats.rounds >= this.config.maxRounds) {
                    this.requestStop(`Finished ${this.stats.rounds} round${this.stats.rounds === 1 ? '' : 's'}.`);
                } else if (this.stats.net >= this.config.profitTarget) {
                    this.requestStop(`Profit target reached (${this.stats.net.toFixed(2)}).`);
                } else if (this.stats.net <= -this.config.maxLoss) {
                    this.requestStop(`Max loss reached (${this.stats.net.toFixed(2)}).`);
                }
            }
        } catch (error) {
            this.fail(error instanceof Error ? error.message : String(error));
        } finally {
            await this.finalize();
        }
    }

    private waitForSignal(): Promise<SignalResult | null> {
        return new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = (signal: SignalResult | null) => {
                if (timer) {
                    clearTimeout(timer);
                    this.timers.delete(timer);
                }
                this.onTickForSignal = null;
                this.cancelSignalWait = null;
                resolve(signal);
            };
            const check = () => {
                const signal = this.strategy.evaluate(this.ticks);
                this.lastScore = signal.score;
                this.emitTick(); // show the current score straight away, not on the next tick
                if (signal.trade) finish(signal);
            };
            this.cancelSignalWait = () => finish(null);
            this.onTickForSignal = check;
            check();

            const timeout = this.config.tradeAnywayAfterMs;
            if (this.onTickForSignal && timeout) {
                const arm = () => {
                    timer = setTimeout(() => {
                        if (timer) this.timers.delete(timer);
                        if (!this.onTickForSignal) return; // already resolved
                        if (this.ticks.length < this.strategy.minTicks) {
                            arm(); // not enough real ticks yet: keep waiting
                            return;
                        }
                        finish({
                            trade: true,
                            score: this.lastScore,
                            reason: `No signal for ${(timeout / 1000).toFixed(0)} s: trading anyway (timeout enabled).`,
                        });
                    }, timeout);
                    this.timers.add(timer);
                };
                arm();
            }
        });
    }

    // ───────────────────────── one round ─────────────────────────

    private contractParams(stake: number, spec: ContractSpec) {
        return {
            amount: stake,
            basis: 'stake',
            contract_type: spec.contract_type,
            currency: this.currency,
            duration: spec.duration,
            duration_unit: spec.duration_unit,
            underlying_symbol: this.config.symbol,
            ...(spec.selected_tick !== undefined ? { selected_tick: spec.selected_tick } : {}),
        };
    }

    private async playRound(signal: SignalResult, stake: number) {
        const startedAt = this.now();
        const spec = this.strategy.contract(this.config);
        const roundNumber = this.stats.rounds + 1;

        const result =
            this.config.mode === 'live' ? await this.playLive(stake, spec) : await this.playPaper(stake, spec);

        const won = result.outcomes.filter(o => o.status === 'won').length;
        const lost = result.outcomes.filter(o => o.status === 'lost').length;
        const interrupted = result.outcomes.filter(o => o.status === 'interrupted').length;
        const net = round2(result.outcomes.reduce((sum, o) => sum + (o.status === 'interrupted' ? 0 : o.profit), 0));

        const notes: string[] = [];
        if (signal.reason.startsWith('No signal')) notes.push(signal.reason);
        if (interrupted > 0) {
            notes.push(
                `${interrupted} contract(s) not tracked to the end${
                    this.config.mode === 'live' ? ' (check Reports on Deriv for the real result)' : ''
                }.`
            );
        }
        result.errors.forEach(message => notes.push(`Buy failed: ${message}`));

        // A round with nothing placed is not a round (for example a failed proposal).
        if (result.placed === 0 && result.errors.length === 0 && interrupted === 0) return;

        this.stats.rounds = roundNumber;
        this.stats.won += won;
        this.stats.lost += lost;
        this.stats.interrupted += interrupted;
        this.stats.net = round2(this.stats.net + net);

        if (interrupted === 0 && result.errors.length === 0) {
            if (net < 0) {
                this.stats.lossStreak += 1;
                this.stats.worstStreak = Math.max(this.stats.worstStreak, this.stats.lossStreak);
            } else {
                this.stats.lossStreak = 0;
            }
        }

        const log: RoundLog = {
            round: roundNumber,
            time: startedAt.toISOString(),
            mode: this.config.mode,
            symbol: this.config.symbol,
            contracts: result.placed,
            stake,
            cost: round2(stake * result.placed),
            won,
            lost,
            interrupted,
            net,
            cumulative: this.stats.net,
            score: signal.score,
            note: notes.join(' '),
        };
        this.logs.push(log);
        this.events.onRound?.({ ...log });

        if (result.errors.length > 0) this.fail(`Buy failed: ${result.errors[0]}`);
        else if (interrupted > 0 && this.running) {
            this.fail('A contract result could not be confirmed, so the run was stopped. Check Reports on Deriv.');
        }
    }

    // Live: real buy orders, fired in parallel, each followed to the end with proposal_open_contract.
    private async playLive(stake: number, spec: ContractSpec): Promise<RoundOutcome> {
        const parameters = this.contractParams(stake, spec);
        // All requests are dispatched in the same tick, before any response is awaited.
        const buys = Array.from({ length: this.config.bulkSize }, () =>
            this.api.send({ buy: '1', price: stake, parameters })
        );
        const settled = await Promise.allSettled(buys);

        const ids: number[] = [];
        const errors: string[] = [];
        settled.forEach(item => {
            if (item.status === 'fulfilled') {
                const response = item.value;
                if (response?.error) errors.push(response.error.message || response.error.code || 'Unknown error');
                else if (response?.buy?.contract_id) {
                    ids.push(Number(response.buy.contract_id));
                    this.noteRatio(Number(response.buy.buy_price), Number(response.buy.payout));
                } else errors.push('Deriv returned no contract.');
            } else {
                errors.push(item.reason instanceof Error ? item.reason.message : String(item.reason));
            }
        });

        const outcomes = await Promise.all(ids.map(id => this.trackContract(id)));
        return { outcomes, placed: ids.length, errors };
    }

    // Paper: validate the proposal first, then settle from the following real ticks.
    private async playPaper(stake: number, spec: ContractSpec): Promise<RoundOutcome> {
        const response = await this.api.send({ proposal: 1, ...this.contractParams(stake, spec) });
        if (!this.running) return { outcomes: [], placed: 0, errors: [] };

        const payout = Number(response?.proposal?.payout);
        const ask = Number(response?.proposal?.ask_price);
        if (response?.error || !Number.isFinite(payout) || !Number.isFinite(ask) || payout <= 0 || ask <= 0) {
            this.fail(response?.error?.message || 'Deriv returned no usable quote, so the paper round was not run.');
            return { outcomes: [], placed: 0, errors: [] };
        }
        this.noteRatio(ask, payout);

        let resolveTicks: (quotes: number[] | null) => void = () => undefined;
        const collected = new Promise<number[] | null>(resolve => (resolveTicks = resolve));
        this.collector = { quotes: [], need: this.strategy.ticksToSettle, done: resolveTicks };
        const timer = setTimeout(() => this.collector?.done(null), this.settleTimeoutMs);
        this.timers.add(timer);

        let quotes: number[] | null;
        try {
            quotes = await collected;
        } finally {
            clearTimeout(timer);
            this.timers.delete(timer);
            this.collector = null;
        }

        if (!quotes) {
            if (!this.running) return { outcomes: [], placed: 0, errors: [] };
            const interrupted: ContractOutcome[] = Array.from({ length: this.config.bulkSize }, () => ({
                status: 'interrupted' as const,
                profit: 0,
            }));
            return { outcomes: interrupted, placed: this.config.bulkSize, errors: [] };
        }

        const won = this.strategy.settle(quotes, spec);
        if (won === undefined) {
            this.fail('Paper settlement did not receive the complete contract window.');
            return { outcomes: [], placed: 0, errors: [] };
        }

        const profit = won ? round2(payout - ask) : round2(-ask);
        const outcomes: ContractOutcome[] = Array.from({ length: this.config.bulkSize }, () => ({
            status: won ? ('won' as const) : ('lost' as const),
            profit,
        }));
        return { outcomes, placed: this.config.bulkSize, errors: [] };
    }

    private noteRatio(price: number, payout: number) {
        if (Number.isFinite(price) && Number.isFinite(payout) && payout > 0) {
            this.stats.ratioSum += price / payout;
            this.stats.ratioCount += 1;
        }
    }

    private isSold(poc: any) {
        return poc?.is_sold === 1 || poc?.is_sold === true || poc?.status === 'won' || poc?.status === 'lost';
    }

    private fromPoc(poc: any): ContractOutcome {
        const profit = Number(poc?.profit);
        if (!Number.isFinite(profit)) return { status: 'interrupted', profit: 0 };
        return { status: profit > 0 ? 'won' : 'lost', profit: round2(profit) };
    }

    // Follows one real contract until it is sold, then forgets its subscription.
    private trackContract(contractId: number): Promise<ContractOutcome> {
        // Stop was requested while the buy was still in flight: do not start following it. The contract is
        // already bought, so it is reported as "not tracked" and settles on Deriv by itself.
        if (!this.running) return Promise.resolve({ status: 'interrupted', profit: 0 });
        return new Promise(resolve => {
            let done = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = (outcome: ContractOutcome) => {
                if (done) return;
                done = true;
                if (timer) {
                    clearTimeout(timer);
                    this.timers.delete(timer);
                }
                this.pocWaiters.delete(contractId);
                const subId = this.pocSubs.get(contractId);
                if (subId) {
                    this.pocSubs.delete(contractId);
                    this.subs.delete(subId);
                    void this.api.send({ forget: subId }).catch(() => undefined);
                }
                resolve(outcome);
            };

            this.pocWaiters.set(contractId, poc => finish(poc ? this.fromPoc(poc) : { status: 'interrupted', profit: 0 }));
            timer = setTimeout(() => finish({ status: 'interrupted', profit: 0 }), this.settleTimeoutMs);
            this.timers.add(timer);

            this.api
                .send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
                .then(response => {
                    const subId = response?.subscription?.id;
                    if (subId) {
                        this.subs.add(subId);
                        this.pocSubs.set(contractId, subId);
                    }
                    if (done) return;
                    if (response?.error) finish({ status: 'interrupted', profit: 0 });
                    else if (response?.proposal_open_contract && this.isSold(response.proposal_open_contract)) {
                        finish(this.fromPoc(response.proposal_open_contract));
                    }
                })
                .catch(() => finish({ status: 'interrupted', profit: 0 }));
        });
    }
}
