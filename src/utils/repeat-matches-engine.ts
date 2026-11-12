import type { BulkApi } from './bulk-strategy/types';

export const MAX_REPEAT_MATCHES_CONTRACTS = 5;

export interface RepeatMatchesConfig {
    symbol: string;
    stake: number;
    mode: 'paper' | 'live';
    currency?: string;
}

export interface RepeatMatchesEvents {
    onTick?(info: { digit: number | null; open: number; placed: number; skipped: number }): void;
    onContract?(info: { digit: number; contractId?: number; status: 'placed' | 'won' | 'lost' | 'failed' }): void;
    onError?(message: string): void;
    onStop?(): void;
}

type OpenContract = { contractId?: number; digit: number; subscriptionId?: string };

/** Places a one-tick DIGITMATCH contract for the digit on every tick, with five-slot back pressure. */
export class RepeatMatchesEngine {
    private readonly config: RepeatMatchesConfig;
    private readonly api: BulkApi;
    private readonly events: RepeatMatchesEvents;
    private readonly open = new Map<number, OpenContract>();
    private readonly paperOpen = new Set<number>();
    private nextSlot = 0;
    private tickSubscription: string | null = null;
    private pipSize: number | null = null;
    private offMessage: (() => void) | null = null;
    private running = false;
    private placed = 0;
    private skipped = 0;

    constructor(config: RepeatMatchesConfig, api: BulkApi, events: RepeatMatchesEvents = {}) {
        this.config = config;
        this.api = api;
        this.events = events;
    }

    getOpenCount() { return this.open.size; }

    async start() {
        if (this.running) throw new Error('This strategy is already running.');
        if (!this.config.symbol) throw new Error('Choose a market.');
        if (!Number.isFinite(this.config.stake) || this.config.stake <= 0) throw new Error('Stake must be greater than 0.');
        this.running = true;
        try {
            this.offMessage = this.api.onMessage(data => this.onMessage(data));
            const response = await this.api.send({ ticks_history: this.config.symbol, adjust_start_time: 1, count: 1, end: 'latest', style: 'ticks', subscribe: 1 });
            if (response?.error) throw new Error(response.error.message || 'Could not subscribe to ticks.');
            const pipSize = Number(response?.history?.pip_size ?? response?.pip_size);
            this.pipSize = Number.isInteger(pipSize) && pipSize >= 0 && pipSize <= 12 ? pipSize : null;
            this.tickSubscription = response?.subscription?.id ?? null;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop() {
        if (!this.running && !this.offMessage) return;
        this.running = false;
        const ids = [...this.open.values()].map(contract => contract.subscriptionId).filter(Boolean) as string[];
        if (this.tickSubscription) ids.push(this.tickSubscription);
        this.tickSubscription = null;
        this.offMessage?.();
        this.offMessage = null;
        await Promise.allSettled(ids.map(id => this.api.send({ forget: id })));
        this.open.clear();
        this.paperOpen.clear();
        this.events.onStop?.();
    }

    private onMessage(data: any) {
        if (!this.running || !data) return;
        if (data.msg_type === 'tick' && data.tick && (!this.tickSubscription || !data.subscription?.id || data.subscription.id === this.tickSubscription)) {
            void this.onTick(data.tick);
            return;
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
            const poc = data.proposal_open_contract;
            if (poc.is_sold || poc.status === 'sold') this.settle(Number(poc.contract_id), Number(poc.profit) > 0);
        }
    }

    private async onTick(tick: any) {
        const tickPipSize = Number(tick.pip_size);
        const pipSize = Number.isInteger(tickPipSize) ? tickPipSize : this.pipSize;
        const digit = pipSize === null ? null : finalDigit(Number(tick.quote), pipSize);
        this.paperOpen.forEach(slot => this.closePaper(slot));
        if (digit === null) {
            this.events.onTick?.({ digit: null, open: this.open.size, placed: this.placed, skipped: this.skipped });
            return;
        }
        if (this.open.size >= MAX_REPEAT_MATCHES_CONTRACTS) {
            this.skipped++;
            this.events.onTick?.({ digit, open: this.open.size, placed: this.placed, skipped: this.skipped });
            return;
        }
        const slot = this.nextSlot++;
        this.open.set(slot, { digit });
        if (this.config.mode === 'paper') {
            this.paperOpen.add(slot);
            this.placed++;
            this.events.onContract?.({ digit, status: 'placed' });
            this.events.onTick?.({ digit, open: this.open.size, placed: this.placed, skipped: this.skipped });
            return;
        }
        try {
            const proposal = await this.api.send({ proposal: 1, amount: this.config.stake, basis: 'stake', contract_type: 'DIGITMATCH', currency: this.config.currency ?? 'USD', duration: 1, duration_unit: 't', underlying_symbol: this.config.symbol, barrier: String(digit) });
            if (proposal?.error || !proposal?.proposal?.id) throw new Error(proposal?.error?.message || 'Could not get a contract proposal.');
            const buy = await this.api.send({ buy: proposal.proposal.id, price: this.config.stake });
            if (buy?.error || !buy?.buy?.contract_id) throw new Error(buy?.error?.message || 'Could not buy the contract.');
            const contractId = Number(buy.buy.contract_id);
            const poc = await this.api.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
            const subscriptionId = poc?.subscription?.id;
            this.open.set(slot, { digit, contractId, subscriptionId });
            this.placed++;
            this.events.onContract?.({ digit, contractId, status: 'placed' });
        } catch (error) {
            this.open.delete(slot);
            this.events.onContract?.({ digit, status: 'failed' });
            this.events.onError?.(error instanceof Error ? error.message : String(error));
        }
        this.events.onTick?.({ digit, open: this.open.size, placed: this.placed, skipped: this.skipped });
    }

    private closePaper(slot: number) { this.paperOpen.delete(slot); this.open.delete(slot); }

    private settle(contractId: number, won: boolean) {
        const entry = [...this.open.entries()].find(([, contract]) => contract.contractId === contractId);
        if (!entry) return;
        const [slot, contract] = entry;
        this.open.delete(slot);
        this.events.onContract?.({ digit: contract.digit, contractId, status: won ? 'won' : 'lost' });
    }
}

export function finalDigit(quote: number, pipSize: number): number | null {
    if (!Number.isFinite(quote) || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 12) return null;
    const [mantissa, exponentText = '0'] = Math.abs(quote).toString().toLowerCase().split('e');
    const [integerPart, fractionalPart = ''] = mantissa.split('.');
    const coefficient = BigInt(`${integerPart}${fractionalPart}`);
    const shift = pipSize + Number(exponentText) - fractionalPart.length;
    const scaled = shift >= 0 ? coefficient * 10n ** BigInt(shift) : (coefficient + 10n ** BigInt(-shift) / 2n) / 10n ** BigInt(-shift);
    return Number(scaled % 10n);
}
