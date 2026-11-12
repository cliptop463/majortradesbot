import type { BulkStrategy } from '../types';
import { lastTicksMatches } from './last-ticks-matches';
import { tickStriker } from './tick-striker';
import { tickStrikerV4 } from './tick-striker-v4';
import { nexusTickStriker } from './nexus-tick-striker';
import { nexusDigitPrinter, nexusOver8Sniper, nexusAutoSwitcher, nexusOver2Under7 } from './nexus-classic';
import { nexusEvenOdd, nexusRiseFall, nexusOverUnder, nexusMatchesDiffers } from './nexus-basic';

/** Add new strategies here. Each one only has to implement BulkStrategy. */
export const STRATEGIES: Record<string, BulkStrategy> = {
    [tickStriker.id]: tickStriker,
    [tickStrikerV4.id]: tickStrikerV4,
    [nexusTickStriker.id]: nexusTickStriker,
    [nexusDigitPrinter.id]: nexusDigitPrinter,
    [nexusOver8Sniper.id]: nexusOver8Sniper,
    [nexusAutoSwitcher.id]: nexusAutoSwitcher,
    [nexusOver2Under7.id]: nexusOver2Under7,
    [nexusEvenOdd.id]: nexusEvenOdd,
    [nexusRiseFall.id]: nexusRiseFall,
    [nexusOverUnder.id]: nexusOverUnder,
    [nexusMatchesDiffers.id]: nexusMatchesDiffers,
    [lastTicksMatches.id]: lastTicksMatches,
};

export const DEFAULT_STRATEGY_ID = tickStriker.id;
export const listStrategies = (): BulkStrategy[] => Object.values(STRATEGIES);
export const getStrategy = (id: string): BulkStrategy | undefined => STRATEGIES[id];
