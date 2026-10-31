# Digit scanner: assumptions and limitations

## Two strategy sets
- **Statistical (conservative)**: Matches/Differs only. Eight statistical heuristics (`strategies.ts`, `ensemble.ts`) with strict thresholds. Signals are rare by design.
- **Pattern strategies**: Matches/Differs, Even/Odd and Over/Under (`pattern-strategies.ts`). Eight strategies with looser thresholds, written independently from the user's reference strategy file. The user chooses the trade type, which strategies run (one to all eight) and how many must agree. Signals are much more frequent.

Both only describe past ticks. Contract details (trade type, contract type, barrier) live in `contracts.ts`; the Blockly patcher reads them from there.

## What it does
1. Fetches recent ticks per volatility market through the project's existing authorized connection (`api_base.api.send`).
2. Extracts the last displayed digit using the market's precision. Precision comes from the `active_symbols` pip value and is cross-checked against the prices themselves (`checkPrecision`). A mismatch, or a degenerate digit stream, excludes the market with a reason instead of analysing it.
3. Runs eight independent heuristics (frequency, recency, streak, momentum, distribution skew, transitions, gaps, cycles). Each returns `MATCHES`, `DIFFERS` or `ABSTAIN` with a reason.
4. Combines them: the most-voted `direction:digit` wins, and at least 2 votes are required. The heuristic score is `70% agreement share + 30% mean strength`. It is a ranking index, not a probability.
5. Ranks markets by score, agreeing strategies, eligible strategies, then symbol (deterministic).
6. Previews every Blockly field that would change and applies only after explicit confirmation. It never starts the bot or places a trade.

## Assumptions
- Digits are described by their recent history only. Thresholds are deliberately conservative (z >= 2.8, chi-square >= 21.67, streak >= 4, cycle z >= 3.8).
- Price history is ordered oldest to newest.

## Limitations
- **Volatility indices are designed to produce independent, uniformly distributed digits.** If that holds, no statistic of past digits predicts the next one, and no strategy has an edge. The scanner can only describe past samples.
- **Most scans find nothing, by design.** On fair random data roughly 1-2% of markets pass the consensus rule, so a 13-market scan shows a result about one time in six. Loosening thresholds only adds false signals.
- **False positives exist.** A market that passes on random data is noise. Scanning many markets and keeping the best one inflates apparent strength (selection bias).
- **Strategies are not fully independent.** Frequency, recency, skew and transitions are built from the same digit counts, so "N agree" overstates independent evidence.
- **Gaps never votes.** Treating a long gap as "due" is the gambler's fallacy, so it only reports the gap and abstains.
- **The score is uncalibrated.** It has not been validated as a win probability and must not be read as one.
- Nothing here guarantees profit. Backtest or walk-forward results describe one sample and do not guarantee future results.

## Pattern strategies: what to know
- **Looser thresholds mean more signals, not better signals.** On simulated fair random digits the pattern strategies signal often (about half of all windows for Even/Odd, nearly every window for Matches/Differs) and win at the fair baseline rate: about 50% for Even/Odd, and 10% for Matches / 90% for Differs.
- **Hot & Cold Frequency always votes for Matches/Differs.** With no hot digit it falls back to Differs on the last digit, which wins about 90% of the time on fair digits simply because Differs is the likelier outcome, not because of any pattern. Switch the strategy off to remove that vote.
- **Streak Reversal and Balance Reversion assume something is "due".** On independent digits that is the gambler's fallacy. They are included because the user chose to have them.
- **The score is a heuristic index (1 to 96), never a win probability.** It averages the agreeing strategies' strength and scales it by their share of total strength.
- **Consensus rule** (`analyzePattern`): votes group by direction; the direction with the highest `100 x agreeing + 30 x votes + total strength` wins; within it the most-voted digit wins, then total strength, then the lower digit. The result does not depend on the order strategies were selected.
- **Payouts are not modelled.** A pick that wins half the time at a payout below 2x still loses money in the long run.
- **Not ported:** the reference file's automatic trade placement (stake, take-profit, stop-loss). The scanner never starts the bot or places a trade.

## Validating
`backtestDigits(digits, { window, step, analyze })` scores each pick against the next tick and compares the hit rate with the fair baseline for that exact contract (for example 10% for Matches, 50% for Even, 70% for Under 7). Pass `analyze: d => analyzePattern(d, 'even_odd', { strategyIds })` to test a pattern selection.

## Rising share (experimental) and the Validate button
Observation from the user: digits whose share of recent ticks is *rising* (for example 9.4% to 10.5%) seem to show up in the next ticks more than digits already at 11% or more. This is implemented two ways in `share-trend.ts`:
- **Strategies** (Matches/Differs only, off by default): *Rising Share* matches the digit that gained at least 1 point over the last 50 ticks while staying under 11% (300-tick windows). *Hot Digit Fade* plays Differs on a digit holding 11% or more.
- **A test of the claim** (`shareTrendStudy`): using only past ticks it classifies digits as rising or high, then checks whether each appeared in the NEXT 10 ticks, and whether it landed exactly on tick 10, and compares both with fair-digit chance (65.1% and 10%). The modal's *Validate on these ticks* button pools this over every scanned market and also back-tests the user's current strategy selection.

What to expect: on fair digits both groups appear in the next 10 ticks about 65% of the time, so a rising share changes nothing. A digit showing up *somewhere* in 10 ticks is also not what a Matches contract pays on: Matches only checks the final tick (10% on fair digits). Treat a small-sample difference as noise until the pooled test says otherwise, and re-test on fresh ticks, because a result found by searching for patterns in the same data is easy to over-trust.
