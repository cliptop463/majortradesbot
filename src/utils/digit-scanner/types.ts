import type { ActiveSymbols } from '@deriv/api-types';

export type ActiveSymbol = ActiveSymbols[number] & {
    symbol?: string;
    underlying_symbol?: string;
    underlying_symbol_name?: string;
    display_name?: string;
    market?: string;
    submarket?: string;
    pip_size?: number | string;
    is_trading_suspended?: 0 | 1 | boolean;
    exchange_is_open?: 0 | 1 | boolean;
};

export type Direction = 'MATCHES' | 'DIFFERS';

export type StrategySignal = Direction | 'ABSTAIN';

export interface StrategyResult {
    id: string;
    name: string;
    status: 'signal' | 'abstain' | 'ineligible';
    /** Independent per-strategy vote: MATCHES / DIFFERS, or ABSTAIN when preconditions are not met. */
    signal: StrategySignal;
    direction?: Direction;
    digit?: number;
    strength?: number;
    reason: string;
}

export interface Recommendation {
    direction: Direction;
    digit: number;
    agree: number;
    disagree: number;
    eligible: number;
    heuristicScore: number;
}

export interface EnsembleResult {
    strategies: StrategyResult[];
    recommendation: Recommendation | null;
    reason?: string;
}

export interface MarketAnalysis {
    symbol: string;
    displayName: string;
    market: string;
    submarket: string;
    pipSize: number | null;
    observations: number;
    dropped: number;
    status: 'ok' | 'no_consensus' | 'insufficient_data' | 'error';
    message?: string;
    strategies: StrategyResult[];
    recommendation: Recommendation | null;
}

export interface RankedMarket {
    rank: number;
    analysis: MarketAnalysis;
    recommendation: Recommendation;
}

export interface RankingResult {
    ranked: RankedMarket[];
    selected: RankedMarket | null;
    excluded: MarketAnalysis[];
}
