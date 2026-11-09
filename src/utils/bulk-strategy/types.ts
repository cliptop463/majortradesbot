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
    /** Historical digits used by Last-Ticks Matches (1 to 10). */
    matchesTickCount: number;
    /** Stake per contract. */
    stake: number;
    profitTarget: number;
    maxLoss: number;
    martingale: MartingaleConfig;
    account: AccountKind;
    mode: RunMode;
    /** Optional "trade anyway" timeout in ms when no signal appears. null = off (default). */
    tradeAnywayAfterMs: number | null;
    /** Optional: stop on their own after this many rounds. Not saved; used by the quick test. */
    maxRounds?: number | null;
}

export interface ContractSpec {
    contract_type: string;
    duration: number;
    duration_unit: 't';
    selected_tick?: number;
    barrier?: string;
}

export interface MarketTick {
    quote: number;
    pipSize: number | null;
    sequence: number;
}

export interface TradeIntent {
    spec: ContractSpec;
    sourceDigit?: number;
}

export interface TradeResult {
    status: 'won' | 'lost' | 'interrupted' | 'failed';
    sourceDigit?: number;
    barrier?: string;
    contractId?: number;
    stake: number;
    payout: number | null;
    profit: number;
    message?: string;
}

export interface SignalResult {
    trade: boolean;
    /** A strategy score; null means the strategy cannot score the available data yet. */
    score: number | null;
    reason: string;
    /** Optional structured diagnostics for strategies that expose their model state. */
    diagnostics?: SignalDiagnostics;
    /** Entries forced by an explicitly enabled test timeout are not model signals. */
    testingOnly?: boolean;
}

export interface SignalDiagnostics {
    tickCount: number;
    trainingSampleCount: number;
    positiveExamples: number;
    negativeExamples: number;
    positiveOutcomeRate: number | null;
    negativeOutcomeRate: number | null;
    currentModelScore: number | null;
    entryThreshold: number;
    modelTrained: boolean;
    signalAvailable: boolean;
    rejectionCode: string | null;
    rejectionReason: string | null;
}

export interface SignalEvaluationStats {
    evaluations: number;
    modelSignals: number;
    signalRate: number;
    rejectionsByReason: Record<string, number>;
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
    /** Optional config-aware evaluation without changing legacy strategy parameters. */
    evaluateWithConfig?(ticks: readonly number[], config: BulkConfig): SignalResult;
    /** Paper settlement from REAL ticks after entry. undefined while there are too few ticks. */
    settle(ticksAfterEntry: readonly number[], spec: ContractSpec): boolean | undefined;
    /** Optional per-contract instructions for strategies whose batch contains different specs. */
    createTradeIntents?(ticks: readonly MarketTick[], config: BulkConfig): TradeIntent[];
    /** Optional precision-aware settlement for independently configured contracts. */
    settleIntent?(ticksAfterEntry: readonly MarketTick[], intent: TradeIntent): boolean | undefined;
    /** Optional contract count used by risk validation and exposure limits. */
    batchSize?(config: BulkConfig): number;
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
    /** Purchases or paper quotes that failed before becoming open contracts. */
    failed: number;
    /** Per-intent result records for strategies that use independent contract specs. */
    tradeResults?: TradeResult[];
    stake: number;
    /** contracts x stake. */
    cost: number;
    won: number;
    lost: number;
    /** Contracts whose result was not tracked (stopped or unconfirmed). */
    interrupted: number;
    net: number;
    cumulative: number;
    /** Strategy score; null means no score was available when the round was started. */
    score: number | null;
    /** True when the optional test timeout, rather than the model, triggered this round. */
    testingOnly?: boolean;
    note: string;
}

export interface Summary {
    mode: RunMode;
    symbol: string;
    rounds: number;
    contractsWon: number;
    contractsLost: number;
    contractsInterrupted: number;
    contractsFailed: number;
    /** Per-contract win rate (0 to 1), or null when nothing settled. */
    winRate: number | null;
    net: number;
    /** Longest run of consecutive losing rounds (net < 0). */
    worstLossStreak: number;
    /** Average stake / payout seen on real quotes: the win rate needed to break even. */
    breakEvenWinRate: number | null;
    /** Results from model-triggered contracts only; excludes testing-only timeout entries. */
    modelContractsWon: number;
    modelContractsLost: number;
    modelWinRate: number | null;
    stopReason: string;
}

export type EngineStatus = 'idle' | 'connecting' | 'waiting' | 'trading' | 'stopped';

export interface EngineEvents {
    onStatus?(status: EngineStatus): void;
    onTick?(info: {
        last: number;
        ticks: number;
        ticksSeen: number;
        score: number | null;
        diagnostics: SignalDiagnostics | null;
        signalStats: SignalEvaluationStats;
    }): void;
    onRound?(log: RoundLog): void;
    onStop?(summary: Summary): void;
    onError?(message: string): void;
}
