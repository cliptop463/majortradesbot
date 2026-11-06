import type { BulkApi } from '../types';

type Responder = (request: any) => any | Promise<any> | undefined;

/** A scripted stand-in for the Deriv connection. Messages are only ever sent by the test. */
export class FakeApi implements BulkApi {
    handlers = new Set<(data: any) => void>();
    sent: any[] = [];
    responders: Responder[] = [];

    async send(request: any) {
        this.sent.push(request);
        for (const responder of this.responders) {
            const out = responder(request);
            if (out !== undefined) return out;
        }
        return {};
    }

    onMessage(handler: (data: any) => void) {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    emit(message: any) {
        [...this.handlers].forEach(handler => handler(message));
    }

    count(predicate: (request: any) => boolean) {
        return this.sent.filter(predicate).length;
    }
}

export const flush = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

export const tick = (api: FakeApi, quote: number, symbol = 'R_100', subId = 'tick-sub') =>
    api.emit({ msg_type: 'tick', tick: { symbol, quote }, subscription: { id: subId } });

export const rising = (n: number, start = 100) => Array.from({ length: n }, (_, i) => start + i);
export const falling = (n: number, start = 200) => Array.from({ length: n }, (_, i) => start - i);
