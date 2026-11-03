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

/**
 * Consensus rules:
 * 1) A strategy must return a well-formed signal to vote.
 * 2) The largest vote count wins before strength is considered.
 * 3) Equal vote counts are broken by mean strength, then DIFFERS before MATCHES,
 *    then the lower digit. This ordering is deterministic and input-order independent.
 * 4) The heuristic score is a ranking index, not a calibrated probability.
 */
export interface AnalyzeDigitsOptions {
    minAgree?: number;
    strategies?: readonly ((digits: readonly number[]) => StrategyResult)[];
    directionFilter?: 'ALL' | 'MATCHES' | 'DIFFERS';
}

const isValidSignal = (s: StrategyResult): s is StrategyResult & {
    direction: Direction;
    digit: number;
    strength: number;
} =>
    s.status === 'signal' &&
    (s.direction === 'MATCHES' || s.direction === 'DIFFERS') &&
    Number.isInteger(s.digit) &&
    (s.digit as number) >= 0 &&
    (s.digit as number) <= 9 &&
    Number.isFinite(s.strength) &&
    (s.strength as number) >= 0 &&
    (s.strength as number) <= 1;

export function analyzeDigits(
    digits: readonly number[],
    options?: AnalyzeDigitsOptions
): EnsembleResult {
    const directionFilter = options?.directionFilter ?? 'ALL';
    const minAgree = Math.max(1, Math.floor(options?.minAgree ?? 2));
    const strategiesList = options?.strategies ?? STRATEGIES;

    if (
        digits.length === 0 ||
        digits.some(d => !Number.isInteger(d) || d < 0 || d > 9)
    ) {
        return {
            strategies: [],
            recommendation: null,
            reason: 'Invalid digit sequence: expected a non-empty array of integers from 0 to 9.',
        };
    }

    const strategies: StrategyResult[] = strategiesList.map(fn => fn(digits));
    const eligible = strategies.filter(s => s.status !== 'ineligible');
    const eligibleCount = eligible.length;
    if (eligibleCount === 0) {
        return { strategies, recommendation: null, reason: 'No eligible strategies.' };
    }

    const signals = strategies.filter(isValidSignal);
    if (signals.length === 0) {
        return { strategies, recommendation: null, reason: 'No strategy produced a valid signal.' };
    }

    const groupsMap = new Map<string, GroupedVote>();
    for (const signal of signals) {
        const key = `${signal.direction}:${signal.digit}`;
        const group = groupsMap.get(key);
        if (group) {
            group.votes += 1;
            group.strengthSum += signal.strength;
        } else {
            groupsMap.set(key, {
                direction: signal.direction,
                digit: signal.digit,
                votes: 1,
                strengthSum: signal.strength,
            });
        }
    }

    let groups = [...groupsMap.values()];
    if (directionFilter !== 'ALL') {
        groups = groups.filter(g => g.direction === directionFilter);
    }
    if (groups.length === 0) {
        return {
            strategies,
            recommendation: null,
            reason: `No valid ${directionFilter} strategy signal.`,
        };
    }

    groups.sort((a, b) =>
        b.votes - a.votes ||
        (b.strengthSum / b.votes) - (a.strengthSum / a.votes) ||
        (a.direction === b.direction ? 0 : a.direction === 'DIFFERS' ? -1 : 1) ||
        a.digit - b.digit
    );

    const winner = groups[0];
    if (winner.votes < minAgree) {
        return {
            strategies,
            recommendation: null,
            reason: `Consensus not reached: ${winner.votes} vote(s); ${minAgree} required.`,
        };
    }

    const meanStrength = winner.strengthSum / winner.votes;
    const agreementShare = winner.votes / eligibleCount;
    // Transparent composite index: 70% consensus share + 30% mean heuristic strength.
    // It is not a probability of winning.
    const heuristicScore = Math.round(
        (100 * (0.7 * agreementShare + 0.3 * meanStrength)) * 10
    ) / 10;

    const recommendation: Recommendation = {
        direction: winner.direction,
        digit: winner.digit,
        agree: winner.votes,
        disagree: signals.filter(s =>
            s.direction !== winner.direction || s.digit !== winner.digit
        ).length,
        eligible: eligibleCount,
        heuristicScore,
    };

    return { strategies, recommendation };
}

/**
 * Deterministic market ranking:
 * 1) heuristic score descending, 2) agreeing-strategy count descending,
 * 3) eligible-strategy count descending, 4) market symbol ascending
 * (case-sensitive lexical order). No direction is privileged.
 * Failed, insufficient, or non-consensus markets are excluded, never scored as zero.
 */
export function rankMarkets(analyses: MarketAnalysis[]): RankingResult {
    const eligible = analyses.filter(
        (a): a is MarketAnalysis & { recommendation: Recommendation } =>
            a.status === 'ok' &&
            a.recommendation !== null &&
            Number.isFinite(a.recommendation.heuristicScore)
    );
    const excluded = analyses.filter(a => !(
        a.status === 'ok' &&
        a.recommendation !== null &&
        Number.isFinite(a.recommendation.heuristicScore)
    ));

    const sorted = [...eligible].sort((a, b) =>
        b.recommendation.heuristicScore - a.recommendation.heuristicScore ||
        b.recommendation.agree - a.recommendation.agree ||
        b.recommendation.eligible - a.recommendation.eligible ||
        (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)
    );

    const ranked: RankedMarket[] = sorted.map((analysis, index) => ({
        rank: index + 1,
        analysis,
        recommendation: analysis.recommendation,
    }));

    return { ranked, selected: ranked[0] ?? null, excluded };
}
