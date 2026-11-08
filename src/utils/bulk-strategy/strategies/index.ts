import type { BulkStrategy } from '../types';
import { lastTicksMatches } from './last-ticks-matches';
import { tickStriker } from './tick-striker';

/** Add new strategies here. Each one only has to implement BulkStrategy. */
export const STRATEGIES: Record<string, BulkStrategy> = {
    [tickStriker.id]: tickStriker,
    [lastTicksMatches.id]: lastTicksMatches,
};

export const DEFAULT_STRATEGY_ID = tickStriker.id;
export const listStrategies = (): BulkStrategy[] => Object.values(STRATEGIES);
export const getStrategy = (id: string): BulkStrategy | undefined => STRATEGIES[id];
