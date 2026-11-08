import { describe, expect, it } from '@jest/globals';
import { DEFAULT_CONFIG } from '../config';
import { BulkEngine } from '../engine';
import {
    createMatchIntents,
    extractFinalDigit,
    lastTicksMatches,
    validateMatchesTickCount,
} from '../strategies/last-ticks-matches';
import type { MarketTick } from '../types';
import { FakeApi, flush } from '../testing/fake-api';

const marketTick = (quote: number, pipSize = 1, sequence = 1): MarketTick => ({ quote, pipSize, sequence });
const ticksForDigits = (digits: number[]) => digits.map((digit, index) => marketTick(10 + digit / 10, 1, index + 1));

const engineConfig = (patch: Partial<typeof DEFAULT_CONFIG> = {}) => ({
    ...DEFAULT_CONFIG,
    strategyId: lastTicksMatches.id,
    mode: 'paper' as const,
    bulkSize: 1,
    matchesTickCount: 2,
    stake: 1,
    maxLoss: 100,
    profitTarget: 100,
    martingale: { enabled: false, multiplier: 2, maxSteps: 2 },
    ...patch,
});

const emitTick = (api: FakeApi, digit: number) =>
    api.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 10 + digit / 10, pip_size: 1 }, subscription: { id: 'tick-sub' } });

describe('Last-Ticks Matches strategy', () => {
    it.each([1, 5, 10])('creates exactly %i contracts', count => {
        const intents = createMatchIntents(ticksForDigits(Array.from({ length: 10 }, (_, index) => index)), count);
        expect(intents).toHaveLength(count);
    });

    it('selects only the newest N tick digits', () => {
        const intents = createMatchIntents(ticksForDigits([1, 2, 3, 4, 5, 6]), 3);
        expect(intents.map(intent => intent.spec.barrier)).toEqual(['4', '5', '6']);
    });

    it('preserves duplicate digits as separate contracts', () => {
        const intents = createMatchIntents(ticksForDigits([2, 7, 2, 4, 2]), 5);
        expect(intents.map(intent => intent.spec.barrier)).toEqual(['2', '7', '2', '4', '2']);
        expect(new Set(intents).size).toBe(5);
    });

    it('represents zero and nine barriers without changing them', () => {
        expect(createMatchIntents(ticksForDigits([0, 9]), 2).map(intent => intent.spec.barrier)).toEqual(['0', '9']);
    });

    it('configures every intent as an independent one-tick DIGITMATCH contract', () => {
        expect(createMatchIntents(ticksForDigits([2, 7, 2]), 3)).toEqual([
            { spec: { contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't', barrier: '2' }, sourceDigit: 2 },
            { spec: { contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't', barrier: '7' }, sourceDigit: 7 },
            { spec: { contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't', barrier: '2' }, sourceDigit: 2 },
        ]);
        expect(lastTicksMatches.contract(DEFAULT_CONFIG)).toMatchObject({ contract_type: 'DIGITMATCH', duration: 1, duration_unit: 't' });
    });

    it('rejects invalid counts and safely identifies valid counts', () => {
        for (const count of [0, 11, 1.5, Number.NaN]) {
            expect(validateMatchesTickCount(count)).toBe(false);
            expect(() => createMatchIntents(ticksForDigits([1, 2, 3]), count)).toThrow(RangeError);
        }
        expect([1, 5, 10].every(validateMatchesTickCount)).toBe(true);
    });

    it('waits for the configured number of quotes before producing a signal', () => {
        expect(lastTicksMatches.evaluate([10, 10.1], { ...DEFAULT_CONFIG, matchesTickCount: 3 }).trade).toBe(false);
        expect(lastTicksMatches.evaluate([10, 10.1, 10.2], { ...DEFAULT_CONFIG, matchesTickCount: 3 }).trade).toBe(true);
    });

    it('settles each contract against the next tick digit and its own barrier', () => {
        const [two, seven] = createMatchIntents(ticksForDigits([2, 7]), 2);
        const nextTick = [marketTick(99.2, 1, 3)];
        expect(lastTicksMatches.settleIntent?.(nextTick, two)).toBe(true);
        expect(lastTicksMatches.settleIntent?.(nextTick, seven)).toBe(false);
        expect(lastTicksMatches.settleIntent?.([], two)).toBeUndefined();
    });

    it('uses precision metadata to preserve trailing zero digits', () => {
        expect(extractFinalDigit({ quote: 123.45, pipSize: 2 })).toBe(5);
        expect(extractFinalDigit({ quote: 123.4, pipSize: 2 })).toBe(0);
        expect(extractFinalDigit({ quote: 123.456, pipSize: 3 })).toBe(6);
        expect(extractFinalDigit({ quote: 1.005, pipSize: 3 })).toBe(5);
        expect(extractFinalDigit({ quote: 123.4, pipSize: null })).toBeNull();
    });

    it('does not create contracts if the history is shorter than N', () => {
        expect(createMatchIntents(ticksForDigits([1, 2]), 3)).toEqual([]);
    });
});

describe('Last-Ticks Matches engine batches', () => {
    it('prices barriers independently and settles each contract on a tick after entry', async () => {
        const api = new FakeApi();
        const rounds: any[] = [];
        api.responders.push(request => {
            if (request.ticks_history) return { history: { prices: [10.1, 10.2], pip_size: 1 }, subscription: { id: 'tick-sub' } };
            if (request.proposal) {
                return { proposal: { payout: request.barrier === '1' ? 2 : 4, ask_price: 1 } };
            }
            return undefined;
        });
        const engine = new BulkEngine(engineConfig({ maxRounds: 1 }), api, { onRound: round => rounds.push(round) });
        await engine.start();
        await flush();

        const proposals = api.sent.filter(request => request.proposal);
        expect(proposals.map(request => request.barrier)).toEqual(['1', '2']);
        expect(proposals.every(request => request.contract_type === 'DIGITMATCH' && request.duration === 1 && request.duration_unit === 't')).toBe(true);
        expect(rounds).toHaveLength(0);

        emitTick(api, 1);
        await flush();
        expect(rounds[0]).toMatchObject({ contracts: 2, won: 1, lost: 1, net: 0 });
        expect(rounds[0].tradeResults.map((result: any) => [result.barrier, result.payout, result.status, result.profit])).toEqual([
            ['1', 2, 'won', 1],
            ['2', 4, 'lost', -1],
        ]);
        await engine.stop();
    });

    it('uses the first tick after each paper contract enters, even when proposal responses straddle ticks', async () => {
        const api = new FakeApi();
        const rounds: any[] = [];
        let resolveFirstProposal: ((response: unknown) => void) | undefined;
        api.responders.push(request => {
            if (request.ticks_history) return { history: { prices: [10.1, 10.2], pip_size: 1 }, subscription: { id: 'tick-sub' } };
            if (request.proposal && request.barrier === '1') {
                return new Promise(resolve => {
                    resolveFirstProposal = resolve;
                });
            }
            if (request.proposal) return { proposal: { payout: 4, ask_price: 1 } };
            return undefined;
        });
        const engine = new BulkEngine(engineConfig({ maxRounds: 1 }), api, { onRound: round => rounds.push(round) });
        await engine.start();
        await flush();
        expect(resolveFirstProposal).toBeDefined();

        emitTick(api, 2);
        resolveFirstProposal?.({ proposal: { payout: 3, ask_price: 1 } });
        await flush();
        expect(rounds).toHaveLength(0);

        emitTick(api, 1);
        await flush();
        expect(rounds[0].tradeResults.map((result: any) => [result.barrier, result.status, result.profit])).toEqual([
            ['1', 'won', 2],
            ['2', 'won', 3],
        ]);
        await engine.stop();
    });

    it('does not begin another batch while any prior live contract remains open', async () => {
        const api = new FakeApi();
        let nextContractId = 100;
        api.responders.push(request => {
            if (request.ticks_history) return { history: { prices: [10.1, 10.2], pip_size: 1 }, subscription: { id: 'tick-sub' } };
            if (request.buy) return { buy: { contract_id: ++nextContractId, buy_price: 1, payout: request.parameters.barrier === '3' ? 2 : 3 } };
            if (request.proposal_open_contract) {
                return { subscription: { id: `poc-${request.contract_id}` }, proposal_open_contract: { contract_id: request.contract_id, is_sold: 0 } };
            }
            return undefined;
        });
        const engine = new BulkEngine(engineConfig({ mode: 'live', maxRounds: 2 }), api);
        await engine.start();
        await flush();
        expect(api.sent.filter(request => request.buy)).toHaveLength(2);

        emitTick(api, 3);
        emitTick(api, 4);
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 101, is_sold: 1, profit: 1, status: 'won' } });
        await flush();
        expect(api.sent.filter(request => request.buy)).toHaveLength(2);

        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 102, is_sold: 1, profit: -1, status: 'lost' } });
        await flush();
        expect(api.sent.filter(request => request.buy)).toHaveLength(2);
        emitTick(api, 3);
        await flush();
        expect(api.sent.filter(request => request.buy)).toHaveLength(2);
        emitTick(api, 4);
        await flush();
        const buys = api.sent.filter(request => request.buy);
        expect(buys).toHaveLength(4);
        expect(buys.slice(2).map(request => request.parameters.barrier)).toEqual(['3', '4']);
        await engine.stop();
    });

    it('records a failed purchase without treating it as open or losing the successful contract', async () => {
        const api = new FakeApi();
        const rounds: any[] = [];
        const errors: string[] = [];
        api.responders.push(request => {
            if (request.ticks_history) return { history: { prices: [10.1, 10.2], pip_size: 1 }, subscription: { id: 'tick-sub' } };
            if (request.buy) {
                return request.parameters.barrier === '1'
                    ? { buy: { contract_id: 501, buy_price: 1, payout: 2 } }
                    : { error: { code: 'PurchaseFailed', message: 'Purchase failed.' } };
            }
            if (request.proposal_open_contract) {
                return { subscription: { id: 'poc-501' }, proposal_open_contract: { contract_id: 501, is_sold: 0 } };
            }
            return undefined;
        });
        const engine = new BulkEngine(
            engineConfig({ mode: 'live', maxRounds: 1 }),
            api,
            { onRound: round => rounds.push(round), onError: message => errors.push(message) }
        );
        await engine.start();
        await flush();
        expect(api.sent.filter(request => request.buy)).toHaveLength(2);
        expect(api.sent.filter(request => request.proposal_open_contract)).toHaveLength(1);
        api.emit({ msg_type: 'proposal_open_contract', proposal_open_contract: { contract_id: 501, is_sold: 1, profit: 1, status: 'won' } });
        await flush();
        expect(rounds[0]).toMatchObject({ contracts: 1, failed: 1, won: 1, lost: 0 });
        expect(rounds[0].tradeResults.map((result: any) => result.status)).toEqual(['won', 'failed']);
        expect(engine.getSummary().contractsFailed).toBe(1);
        expect(errors).toEqual([]);
        await engine.stop();
    });
});