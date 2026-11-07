import { describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import { BulkEngine } from '../engine';
import { tickStriker } from '../strategies/tick-striker';
import type { BulkConfig, BulkStrategy, RoundLog, Summary } from '../types';
import { FakeApi, falling, flush, rising, tick } from '../testing/fake-api';

/** Always signals, so rounds start the moment the buffer is seeded. */
const alwaysTrade: BulkStrategy = {
    ...tickStriker,
    evaluate: () => ({ trade: true, confidence: 0.9, reason: 'test' }),
};

const config = (patch: Partial<BulkConfig> = {}): BulkConfig => ({
    ...DEFAULT_CONFIG,
    bulkSize: 2,
    stake: 1,
    profitTarget: 1000,
    maxLoss: 1000,
    martingale: { enabled: true, multiplier: 2, maxSteps: 2 },
    mode: 'paper',
    ...patch,
});

const WIN = [100, 101, 102, 103, 104];
const LOSS = [104, 103, 102, 101, 100];

function setup(cfg: BulkConfig, opts: { seed?: number[]; strategy?: BulkStrategy; settleTimeoutMs?: number } = {}) {
    const api = new FakeApi();
    const rounds: RoundLog[] = [];
    const stops: Summary[] = [];
    const errors: string[] = [];
    let nextId = 1000;
    api.responders.push(req => {
        if (req.ticks_history && req.subscribe) {
            return { history: { prices: opts.seed ?? rising(30) }, subscription: { id: 'tick-sub' } };
        }
        if (req.proposal) return { proposal: { payout: 3.5 * req.amount, ask_price: req.amount } };
        if (req.buy) return { buy: { contract_id: ++nextId, buy_price: req.price, payout: 3.5 * req.price } };
        if (req.proposal_open_contract) {
            return { subscription: { id: `poc-${req.contract_id}` }, proposal_open_contract: { contract_id: req.contract_id, is_sold: 0 } };
        }
        return undefined;
    });
    const engine = new BulkEngine(
        cfg,
        api,
        { onRound: l => rounds.push(l), onStop: s => stops.push(s), onError: e => errors.push(e) },
        { currency: 'USD', settleTimeoutMs: opts.settleTimeoutMs },
        opts.strategy ?? alwaysTrade
    );
    return { api, engine, rounds, stops, errors };
}

const proposals = (api: FakeApi) => api.sent.filter(r => r.proposal);
const buys = (api: FakeApi) => api.sent.filter(r => r.buy);
const feed = (api: FakeApi, quotes: number[]) => quotes.forEach(q => tick(api, q));

describe('paper mode (real ticks, no orders)', () => {
    it('never sends a buy order, only a real proposal, and settles from real ticks', async () => {
        const { api, engine, rounds } = setup(config({ profitTarget: 5 }));
        await engine.start();
        await flush();
        expect(proposals(api)).toHaveLength(1);
        expect(proposals(api)[0]).toMatchObject({
            contract_type: 'TICKHIGH',
            duration: 5,
            duration_unit: 't',
            selected_tick: 5,
            underlying_symbol: 'R_100',
            amount: 1,
            basis: 'stake',
        });
        feed(api, WIN);
        await flush();
        expect(buys(api)).toHaveLength(0);
        expect(rounds).toHaveLength(1);
        expect(rounds[0]).toMatchObject({ round: 1, contracts: 2, won: 2, lost: 0, net: 5, cumulative: 5, mode: 'paper' });
    });

    it('stops at the profit target and shows a summary', async () => {
        const { api, engine, stops } = setup(config({ profitTarget: 5 }));
        await engine.start();
        await flush();
        feed(api, WIN);
        await flush();
        expect(engine.isRunning()).toBe(false);
        expect(stops).toHaveLength(1);
        expect(stops[0]).toMatchObject({ rounds: 1, contractsWon: 2, contractsLost: 0, winRate: 1, net: 5, worstLossStreak: 0 });
        expect(stops[0].stopReason).toContain('Profit target reached');
        expect(stops[0].breakEvenWinRate).toBeCloseTo(1 / 3.5);
    });

    it('doubles the stake after each losing round up to maxSteps, then resets on a win', async () => {
        const { api, engine, rounds } = setup(config());
        await engine.start();
        for (const outcome of [LOSS, LOSS, LOSS, LOSS, WIN]) {
            await flush();
            feed(api, outcome);
            await flush();
        }
        await flush();
        const stakes = proposals(api).map(p => p.amount);
        expect(stakes.slice(0, 6)).toEqual([1, 2, 4, 4, 4, 1]); // capped at base * 2^2, reset after the win
        expect(rounds.map(r => r.net).slice(0, 5)).toEqual([-2, -4, -8, -8, 2 * (3.5 * 4 - 4)]);
        await engine.stop();
    });

    it('counts a round as a loss only if net < 0 and tracks the worst losing streak', async () => {
        const { api, engine, stops } = setup(config());
        await engine.start();
        for (const outcome of [LOSS, LOSS, WIN, LOSS]) {
            await flush();
            feed(api, outcome);
            await flush();
        }
        await engine.stop();
        expect(stops[0].worstLossStreak).toBe(2);
        expect(stops[0].contractsLost).toBe(6);
        expect(stops[0].contractsWon).toBe(2);
        expect(stops[0].winRate).toBeCloseTo(0.25);
    });

    it('stops at max loss without ever starting a round that could exceed it', async () => {
        const { api, engine, rounds, stops } = setup(config({ maxLoss: 5, martingale: { enabled: false, multiplier: 2, maxSteps: 2 } }));
        await engine.start();
        for (const outcome of [LOSS, LOSS]) {
            await flush();
            feed(api, outcome);
            await flush();
        }
        await flush();
        expect(proposals(api)).toHaveLength(2); // a third round (cost 2) would reach -6 > 5, so it is refused
        expect(rounds.map(r => r.cumulative)).toEqual([-2, -4]);
        expect(stops[0].stopReason).toContain('could take the loss past your max loss');
        expect(stops[0].net).toBe(-4);
    });

    it('stops with max loss reached when a round lands exactly on the limit', async () => {
        const { api, engine, stops } = setup(config({ maxLoss: 4, martingale: { enabled: false, multiplier: 2, maxSteps: 2 } }));
        await engine.start();
        for (const outcome of [LOSS, LOSS]) {
            await flush();
            feed(api, outcome);
            await flush();
        }
        await flush();
        expect(stops[0].net).toBe(-4);
        expect(stops[0].stopReason).toMatch(/Max loss reached|could take the loss past/);
    });

    it('refuses a round when no real payout quote is available (nothing is invented)', async () => {
        const { api, engine, stops, errors } = setup(config());
        api.responders.unshift(req => (req.proposal ? { error: { code: 'ContractBuyValidationError', message: 'No quote' } } : undefined));
        await engine.start();
        await flush();
        expect(errors[0]).toContain('No quote');
        expect(stops[0]).toMatchObject({ rounds: 0, net: 0 });
    });

    it('ignores ticks from other subscriptions', async () => {
        const { api, engine, rounds } = setup(config());
        await engine.start();
        await flush();
        api.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 1 }, subscription: { id: 'someone-else' } });
        feed(api, WIN.slice(0, 4));
        await flush();
        expect(rounds).toHaveLength(0); // still waiting for the 5th real tick of OUR stream
        await engine.stop();
    });
});

describe('round limit (quick test)', () => {
    it('stops by itself after maxRounds and reports why', async () => {
        const { api, engine, rounds, stops } = setup(config({ maxRounds: 3 }));
        await engine.start();
        for (let i = 0; i < 3; i++) {
            await flush();
            feed(api, WIN);
            await flush();
        }
        await flush();
        expect(rounds).toHaveLength(3);
        expect(proposals(api)).toHaveLength(3); // no fourth round
        expect(stops[0].stopReason).toBe('Finished 3 rounds.');
        expect(engine.isRunning()).toBe(false);
    });

    it('runs until stopped when no limit is set', async () => {
        const { api, engine, rounds } = setup(config());
        await engine.start();
        for (let i = 0; i < 4; i++) {
            await flush();
            feed(api, WIN);
            await flush();
        }
        expect(rounds.length).toBeGreaterThanOrEqual(4);
        expect(engine.isRunning()).toBe(true);
        await engine.stop();
    });
});

describe('live mode', () => {
    const liveCfg = (patch: Partial<BulkConfig> = {}) => config({ mode: 'live', ...patch });

    it('sends all bulk buy requests in parallel before any response arrives', async () => {
        const { api, engine } = setup(liveCfg({ bulkSize: 4 }));
        const gates: Array<(v: unknown) => void> = [];
        api.responders.unshift(req =>
            req.buy ? new Promise(resolve => gates.push(() => resolve({ buy: { contract_id: 500 + gates.length, buy_price: 1, payout: 3.5 } }))) : undefined
        );
        await engine.start();
        await flush();
        expect(buys(api)).toHaveLength(4); // every buy dispatched while none has responded yet
        expect(buys(api)[0]).toMatchObject({
            buy: '1',
            price: 1,
            parameters: { contract_type: 'TICKHIGH', selected_tick: 5, duration: 5, duration_unit: 't', amount: 1, underlying_symbol: 'R_100' },
        });
        const stopped = engine.stop();
        gates.forEach(open => open(null)); // the buys complete AFTER Stop was requested
        await stopped; // must not hang waiting for contracts it was told to stop following
        expect(engine.getSummary().contractsInterrupted).toBe(4);
        expect(api.count(r => r.proposal_open_contract)).toBe(0); // and it never started following them
    });

    it('follows each contract with proposal_open_contract and sums real profits', async () => {
        const { api, engine, rounds } = setup(liveCfg({ bulkSize: 2, profitTarget: 2 }));
        await engine.start();
        await flush();
        const ids = buys(api).length ? [1001, 1002] : [];
        expect(api.count(r => r.proposal_open_contract && ids.includes(r.contract_id))).toBe(2);
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 1001, is_sold: 1, profit: 2.5, status: 'won' } });
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 1002, is_sold: 1, profit: -1, status: 'lost' } });
        await flush();
        expect(rounds[0]).toMatchObject({ contracts: 2, won: 1, lost: 1, net: 1.5, mode: 'live' });
        // forgets each contract subscription once it is sold
        expect(api.count(r => r.forget === 'poc-1001')).toBe(1);
        expect(api.count(r => r.forget === 'poc-1002')).toBe(1);
        await engine.stop();
    });

    it('a net 0 round is not a loss and resets the stake', async () => {
        const { api, engine } = setup(liveCfg({ bulkSize: 2 }));
        await engine.start();
        await flush();
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 1001, is_sold: 1, profit: 1, status: 'won' } });
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 1002, is_sold: 1, profit: -1, status: 'lost' } });
        await flush();
        expect(buys(api).slice(-1)[0].price).toBe(1); // next round is back at the base stake
        await engine.stop();
    });

    it('uses the result Deriv reports when a contract is already sold in the subscribe response', async () => {
        const { api, engine, rounds } = setup(liveCfg({ bulkSize: 1, profitTarget: 2 }));
        api.responders.unshift(req =>
            req.proposal_open_contract
                ? { subscription: { id: 'p1' }, proposal_open_contract: { contract_id: req.contract_id, is_sold: 1, profit: 2.5 } }
                : undefined
        );
        await engine.start();
        await flush();
        expect(rounds[0].net).toBe(2.5);
    });

    it('stops after a failed buy, still settles the ones that went through, and reports the error', async () => {
        const { api, engine, rounds, errors, stops } = setup(liveCfg({ bulkSize: 3 }));
        let n = 0;
        api.responders.unshift(req => {
            if (!req.buy) return undefined;
            n++;
            return n === 2
                ? { error: { code: 'InsufficientBalance', message: 'Your account balance is insufficient.' } }
                : { buy: { contract_id: 700 + n, buy_price: 1, payout: 3.5 } };
        });
        await engine.start();
        await flush();
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 701, is_sold: 1, profit: -1 } });
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 703, is_sold: 1, profit: -1 } });
        await flush();
        expect(rounds[0]).toMatchObject({ contracts: 2, lost: 2, net: -2 });
        expect(rounds[0].note).toContain('insufficient');
        expect(errors[0]).toContain('insufficient');
        expect(stops[0].stopReason).toContain('Buy failed');
        expect(buys(api)).toHaveLength(3); // no second round
    });

    it('Stop mid-round forgets every subscription and counts open contracts as not tracked', async () => {
        const { api, engine, rounds, stops } = setup(liveCfg({ bulkSize: 2 }));
        await engine.start();
        await flush();
        await engine.stop();
        expect(api.count(r => r.forget === 'tick-sub')).toBe(1);
        expect(api.count(r => r.forget === 'poc-1001')).toBe(1);
        expect(api.count(r => r.forget === 'poc-1002')).toBe(1);
        expect(api.handlers.size).toBe(0);
        expect(rounds[0]).toMatchObject({ interrupted: 2, won: 0, lost: 0, net: 0 });
        expect(rounds[0].note).toContain('not tracked');
        expect(stops).toHaveLength(1);
        expect(stops[0]).toMatchObject({ contractsInterrupted: 2, stopReason: 'Stopped by user' });
    });

    it('stops (does not guess) when a contract result is never confirmed', async () => {
        const { engine, stops, errors } = setup(liveCfg({ bulkSize: 1 }), { settleTimeoutMs: 40 });
        await engine.start();
        await flush();
        await new Promise(resolve => setTimeout(resolve, 80));
        await flush();
        expect(errors.join(' ')).toContain('could not be confirmed');
        expect(stops[0].contractsInterrupted).toBe(1);
        expect(stops[0].net).toBe(0);
    });
});

describe('signal gating with the real Tick Striker', () => {
    it('waits while confidence is below 0.5 and trades once it recovers', async () => {
        const { api, engine } = setup(config({ mode: 'paper' }), { seed: falling(40), strategy: tickStriker });
        await engine.start();
        await flush();
        expect(proposals(api)).toHaveLength(0); // conf 0 on a falling series
        feed(api, rising(60, 1000));
        await flush();
        expect(proposals(api).length).toBeGreaterThanOrEqual(1);
        await engine.stop();
    });

    it('does not trade anyway by default, even after waiting', async () => {
        const { api, engine } = setup(config(), { seed: falling(40), strategy: tickStriker });
        await engine.start();
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(proposals(api)).toHaveLength(0);
        await engine.stop();
    });

    it('trades anyway after the optional timeout when it is switched on', async () => {
        const { api, engine, rounds } = setup(config({ tradeAnywayAfterMs: 30 }), { seed: falling(40), strategy: tickStriker });
        await engine.start();
        await new Promise(resolve => setTimeout(resolve, 90));
        expect(proposals(api)).toHaveLength(1);
        feed(api, WIN);
        await flush();
        expect(rounds[0].note).toContain('trading anyway');
        await engine.stop();
    });

    it('does not trade before 18 real ticks exist, even with the timeout on', async () => {
        const { api, engine } = setup(config({ tradeAnywayAfterMs: 20 }), { seed: falling(5), strategy: tickStriker });
        await engine.start();
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(proposals(api)).toHaveLength(0);
        await engine.stop();
    });
});

describe('start and stop', () => {
    it('refuses to start when the worst case exceeds the max loss, and touches nothing', async () => {
        const { api, engine } = setup(config({ bulkSize: 10, stake: 1, maxLoss: 20 }));
        await expect(engine.start()).rejects.toThrow(/Worst-case cost/);
        expect(api.sent).toHaveLength(0);
        expect(api.handlers.size).toBe(0);
    });

    it('cleans up and rejects when the tick subscription fails', async () => {
        const { api, engine } = setup(config());
        api.responders.unshift(req => (req.ticks_history ? { error: { code: 'InvalidSymbol', message: 'Symbol is invalid.' } } : undefined));
        await expect(engine.start()).rejects.toThrow('Symbol is invalid.');
        expect(api.handlers.size).toBe(0);
        expect(engine.isRunning()).toBe(false);
    });

    it('shares the app tick stream when the market is already subscribed, and never forgets it', async () => {
        const { api, engine, rounds } = setup(config());
        api.responders.unshift(req => {
            if (req.ticks_history && req.subscribe) return { error: { code: 'AlreadySubscribed', message: 'Already subscribed' } };
            if (req.ticks_history) return { history: { prices: rising(30) } };
            return undefined;
        });
        await engine.start();
        await flush();
        api.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 100 }, subscription: { id: 'app-sub' } });
        // A tick from another market must not count towards our contract: if it did, this round would be a loss.
        api.emit({ msg_type: 'tick', tick: { symbol: 'R_50', quote: 5000 }, subscription: { id: 'app-sub-2' } });
        feed(api, WIN.slice(1)); // 4 more R_100 ticks (any subscription id is accepted in shared mode)
        await flush();
        expect(rounds).toHaveLength(1);
        expect(rounds[0]).toMatchObject({ won: 2, lost: 0 });
        await engine.stop();
        expect(api.sent.some(r => r.forget)).toBe(false); // the app's own stream is left alone
    });

    it('cannot be started twice, and stop is safe to call more than once', async () => {
        const { engine, stops } = setup(config());
        await engine.start();
        await expect(engine.start()).rejects.toThrow('already been started');
        await engine.stop();
        await engine.stop();
        expect(stops).toHaveLength(1);
    });

    it('Stop cancels every subscription it opened, including the tick stream', async () => {
        const { api, engine } = setup(config({ mode: 'paper' }));
        await engine.start();
        await flush();
        await engine.stop();
        expect(api.count(r => r.forget === 'tick-sub')).toBe(1);
        expect(api.handlers.size).toBe(0);
        // nothing is processed after stop
        feed(api, WIN);
        await flush();
        expect(proposals(api)).toHaveLength(1);
    });

    it('log rows are copies, so callers cannot change the engine history', async () => {
        const { api, engine } = setup(config({ profitTarget: 5 }));
        await engine.start();
        await flush();
        feed(api, WIN);
        await flush();
        const logs = engine.getLogs();
        logs[0].net = 999;
        expect(engine.getLogs()[0].net).toBe(5);
    });
});

void jest;
