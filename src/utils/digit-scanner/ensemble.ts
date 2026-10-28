import { STRATEGIES } from './strategies';
import type {
    Direction,
    EnsembleResult,
    MarketAnalysis,
    RankedMarket,
    RankingResult,
    Recommendation,
    StrategyResult,
} from './types';

interface GroupedVote {
    direction: Direction;
    digit: number;
    votes: number;
    strengthSum: number;
}

export interface AnalyzeDigitsOptions {
    minAgree?: number;
    strategies?: readonly ((digits: readonly number[]) => StrategyResult)[];
    directionFilter?: 'ALL' | 'MATCHES' | 'DIFFERS';
}

/**
 * Runs all provided strategies against the historical digit sequence and computes
 * an ensemble consensus.
 */
export function analyzeDigits(
    digits: readonly number[],
    options?: AnalyzeDigitsOptions
): EnsembleResult {
    const directionFilter = options?.directionFilter ?? 'ALL';
    const minAgree = options?.minAgree ?? (directionFilter === 'MATCHES' ? 1 : 2);
    const strategiesList = options?.strategies ?? STRATEGIES;

    const strategies: StrategyResult[] = strategiesList.map((fn) => fn(digits));
    const eligible = strategies.filter((s) => s.status !== 'ineligible');
    const eligibleCount = eligible.length;

    if (eligibleCount === 0) {
        return {
            strategies,
            recommendation: null,
            reason: 'No eligible strategies.',
        };
    }

    const signals = strategies.filter((s) => s.status === 'signal');
    if (signals.length === 0) {
        return {
            strategies,
            recommendation: null,
            reason: 'No strategy produced a signal.',
        };
    }

    const groupsMap = new Map<string, GroupedVote>();
    for (const sig of signals) {
        if (!sig.direction || sig.digit === undefined) continue;
        const key = `${sig.direction}:${sig.digit}`;
        const strength = sig.strength ?? 0;
        const existing = groupsMap.get(key);
        if (existing) {
            existing.votes++;
            existing.strengthSum += strength;
        } else {
            groupsMap.set(key, {
                direction: sig.direction,
                digit: sig.digit,
                votes: 1,
                strengthSum: strength,
            });
        }
    }

    let groups = Array.from(groupsMap.values());
    if (groups.length === 0) {
        return {
            strategies,
            recommendation: null,
            reason: 'No strategy produced a valid signal.',
        };
    }

    if (directionFilter !== 'ALL') {
        groups = groups.filter((g) => g.direction === directionFilter);
        if (groups.length === 0) {
            return {
                strategies,
                recommendation: null,
                reason: `No strategy produced a ${directionFilter} signal.`,
            };
        }
    }

    groups.sort((a, b) => {
        const strengthDiff = a.strengthSum - b.strengthSum;
        if (Math.abs(strengthDiff) > 1e-6) {
            return strengthDiff > 0 ? -1 : 1;
        }

        if (a.votes !== b.votes) {
            return b.votes - a.votes;
        }

        if (a.direction !== b.direction) {
            if (directionFilter === 'MATCHES') {
                return a.direction === 'MATCHES' ? -1 : 1;
            }
            return a.direction === 'DIFFERS' ? -1 : 1;
        }

        return a.digit - b.digit;
    });

    const winner = groups[0];

    if (winner.votes < minAgree) {
        return {
            strategies,
            recommendation: null,
            reason: `Consensus not reached: winner has ${winner.votes} vote(s), minimum required is ${minAgree}.`,
        };
    }

    const rawScore = (100 * winner.strengthSum) / eligibleCount;
    const heuristicScore = Math.round(rawScore * 10) / 10;

    const agree = winner.votes;
    const disagree = signals.length - agree;

    const recommendation: Recommendation = {
        direction: winner.direction,
        digit: winner.digit,
        agree,
        disagree,
        eligible: eligibleCount,
        heuristicScore,
    };

    return {
        strategies,
        recommendation,
    };
}

/**
 * Ranks market analyses according to heuristic score, agreement, eligible count, and symbol name.
 * Markets that are not 'ok' or lack a recommendation are placed into `excluded` in their original order.
 */
export function rankMarkets(analyses: MarketAnalysis[]): RankingResult {
    const okWithRec = analyses.filter(
        (a): a is MarketAnalysis & { recommendation: Recommendation } =>
            a.status === 'ok' && a.recommendation !== null
    );

    const excluded = analyses.filter((a) => a.status !== 'ok' || a.recommendation === null);

    const sorted = [...okWithRec].sort((a, b) => {
        if (a.recommendation.direction !== b.recommendation.direction) {
            return a.recommendation.direction === 'MATCHES' ? -1 : 1;
        }
        if (b.recommendation.heuristicScore !== a.recommendation.heuristicScore) {
            return b.recommendation.heuristicScore - a.recommendation.heuristicScore;
        }
        if (b.recommendation.agree !== a.recommendation.agree) {
            return b.recommendation.agree - a.recommendation.agree;
        }
        if (b.recommendation.eligible !== a.recommendation.eligible) {
            return b.recommendation.eligible - a.recommendation.eligible;
        }
        if (a.symbol < b.symbol) return -1;
        if (a.symbol > b.symbol) return 1;
        return 0;
    });

    const ranked: RankedMarket[] = sorted.map((analysis, index) => ({
        rank: index + 1,
        analysis,
        recommendation: analysis.recommendation,
    }));

    return {
        ranked,
        selected: ranked[0] ?? null,
        excluded,
    };
}
