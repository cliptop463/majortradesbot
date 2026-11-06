import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { getAccountId, isDemoAccount } from '@/utils/account-helpers';
import type { AccountKind, BulkApi } from './types';

/**
 * Adapter onto the app's EXISTING authorized Deriv connection. It opens no socket and never touches
 * tokens: it only calls api_base.api.send and api_base.api.onMessage.
 */
export function createDerivApi(): BulkApi {
    return {
        async send(request) {
            const api = (api_base as any).api;
            if (!api) throw new Error('Not connected to Deriv. Reload the page and try again.');
            try {
                return await api.send(request);
            } catch (error) {
                // deriv-api rejects with the response itself when Deriv answers with an error.
                if (error && typeof error === 'object' && 'error' in (error as object)) return error;
                throw error;
            }
        },
        onMessage(handler) {
            const api = (api_base as any).api;
            if (!api) throw new Error('Not connected to Deriv. Reload the page and try again.');
            const subscription = api.onMessage().subscribe(({ data }: { data: unknown }) => handler(data));
            return () => subscription.unsubscribe();
        },
    };
}

export interface AccountContext {
    /** Type of the account the app is currently authorized with, or null when unknown. */
    kind: AccountKind | null;
    currency: string;
}

export function getAccountContext(): AccountContext {
    const loginid = getAccountId();
    const kind: AccountKind | null = loginid ? (isDemoAccount(loginid) ? 'demo' : 'real') : null;
    const currency = (api_base as any)?.account_info?.currency || 'USD';
    return { kind, currency };
}
