import { describe, expect, it } from '@jest/globals';
import { RepeatMatchesEngine } from '../repeat-matches-engine';
import { FakeApi, flush } from '../bulk-strategy/testing/fake-api';

describe('RepeatMatchesEngine', () => {
    it('uses history precision and places a paper match on each tick', async () => {
        const api = new FakeApi();
        api.responders.push(request =>
            request.ticks_history ? { history: { pip_size: 2 }, subscription: { id: 'tick-sub' } } : undefined
        );
        const placed: number[] = [];
        const engine = new RepeatMatchesEngine({ symbol: 'R_100', stake: 0.35, mode: 'paper' }, api, {
            onContract: info => info.status === 'placed' && placed.push(info.digit),
        });

        await engine.start();
        api.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 123.45 }, subscription: { id: 'tick-sub' } });
        api.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 123.46 }, subscription: { id: 'tick-sub' } });
        await flush();

        expect(placed).toEqual([5, 6]);
        expect(api.sent.filter(request => request.buy)).toHaveLength(0);
        await engine.stop();
    });

    it('uses the correct underlying symbol in live proposals', async () => {
        const api = new FakeApi();
        api.responders.push(request => {
            if (request.ticks_history) return { history: { pip_size: 2 }, subscription: { id: 'tick-sub' } };
            if (request.proposal) return { proposal: { id: 'proposal-id' } };
            if (request.buy) return { buy: { contract_id: 42 } };
            if (request.proposal_open_contract) return { subscription: { id: 'poc-sub' } };
            return undefined;
        });
        const engine = new RepeatMatchesEngine({ symbol: 'R_100', stake: 0.35, mode: 'live' }, api);

        await engine.start();
        api.emit({ msg_type: 'tick', tick: { symbol: 'R_100', quote: 123.45 }, subscription: { id: 'tick-sub' } });
        await flush(10);

        expect(api.sent.find(request => request.proposal)).toMatchObject({ underlying_symbol: 'R_100', contract_type: 'DIGITMATCH', barrier: '5' });
        await engine.stop();
    });
});
