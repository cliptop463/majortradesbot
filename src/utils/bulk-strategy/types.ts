export type Risk = 'low' | 'medium' | 'high';
export type AccountKind = 'demo' | 'real';
/** Paper sends no orders and settles from the real tick stream; Live sends real buy orders. */
export type RunMode = 'paper' | 'live';

export interface MartingaleConfig {
    enabled: boolean;
    multiplier: number;
    maxSteps: number;
}

export interface BulkConfig {
    strategyId: string;
    symbol: string;
    risk: Risk;
    /** Contracts fired in parallel per round (1 to 10). */
    bulkSize: number;
    /** Stake per contract. */
    stake: number;
    profitTarget: number;
    maxLoss: number;
    martingale: MartingaleConfig;
    account: AccountKind;
    mode: RunMode;
    /** Optional "trade anyway" timeout in ms when no signal appears. null = off (default). */
    tradeAnywayAfterMs: number | null;
}

export interface ContractSpec {
    contract_type: string;
    duration: number;
    duration_unit: 't';
    selected_tick?: number;
}

export interface SignalResult {
    trade: boolean;
    confidence: number;
    reason: string;
}

/** A pluggable strategy: what to buy, when to enter, and how a paper contract settles. */
export interface BulkStrategy {
    id: string;
    label: string;
    description: string;
    /** Ticks required before the strategy may trade. */
    minTicks: number;
    /** Ticks kept in the rolling buffer. */
    bufferSize: number;
    /** Ticks after entry that decide the contract. */
    ticksToSettle: number;
    contract(config: BulkConfig): ContractSpec;
    evaluate(ticks: readonly number[]): SignalResult;
    /** Paper settlement from REAL ticks after entry. undefined while there are too few ticks. */
    settle(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined;
}

/** Minimal surface of the existing Deriv connection that the engine needs. */
export interface BulkApi {
    /** One request, one response. A Deriv error comes back as { error: { code, message } }. */
    send(request: Record<string, unknown>): Promise<any>;
    /** Stream messages for every subscription on the connection. Returns an unsubscribe function. */
    onMessage(handler: (data: any) => void): () => void;
}

export interface RoundLog {
    round: number;
    /** ISO timestamp when the round was started. */
    time: string;
    mode: RunMode;
    symbol: string;
    /** Contracts placed (or paper contracts) in this round. */
    contracts: number;
    stake: number;
    /** contracts x stake. */
    cost: number;
    won: number;
    lost: number;
    /** Contracts whose result was not tracked (stopped or unconfirmed). */
    interrupted: number;
    net: number;
    cumulative: number;
    confidence: number;
    note: string;
}

export interface Summary {
    mode: RunMode;
    symbol: string;
    rounds: number;
    contractsWon: number;
    contractsLost: number;
    contractsInterrupted: number;
    /** Per-contract win rate (0 to 1), or null when nothing settled. */
    winRate: number | null;
    net: number;
    /** Longest run of consecutive losing rounds (net < 0). */
    worstLossStreak: number;
    /** Average stake / payout seen on real quotes: the win rate needed to break even. */
    breakEvenWinRate: number | null;
    stopReason: string;
}

export type EngineStatus = 'idle' | 'connecting' | 'waiting' | 'trading' | 'stopped';

export interface EngineEvents {
    onStatus?(status: EngineStatus): void;
    onTick?(info: { last: number; ticks: number; confidence: number | null }): void;
    onRound?(log: RoundLog): void;
    onStop?(summary: Summary): void;
    onError?(message: string): void;
}
