// @ts-nocheck — Blockly/window globals follow the other bot-builder modals
import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import {
    DIFFER_BREAKEVEN_PAYOUT,
    MATCH_BREAKEVEN_PAYOUT,
    analyze,
    isVolatilitySymbol,
    volatilityName,
} from '@/utils/digit-scanner/matches-differs';
import type { MatchesDiffersAnalysis } from '@/utils/digit-scanner/matches-differs';
import { loadSample } from '@/utils/digit-scanner/matches-differs-load';
import type { LoadedSample } from '@/utils/digit-scanner/matches-differs-load';
import { applyScannerPick, getSelectedSymbol, previewScannerPick } from '@/utils/blockly-scanner-pick';
import { auditSequence } from '@/utils/digit-scanner/sequence-audit';
import type { ScannerPickPreview } from '@/utils/blockly-scanner-pick';
import './matches-differs-modal.scss';

type Props = {
    isOpen: boolean;
    onClose: () => void;
    onApplied: () => void;
    is_running: boolean;
    /** Symbol held by the dashboard store; used only when the Blockly market block cannot be read. */
    store_symbol?: string | null;
};

type Status = 'idle' | 'loading' | 'ready' | 'error';
type Pending = { direction: 'MATCHES' | 'DIFFERS'; digit: number; preview: ScannerPickPreview };

const CHART = { width: 300, height: 150, top: 18, bottom: 22, bar: 22, gap: 8, left: 4 };

const DigitChart: React.FC<{ result: MatchesDiffersAnalysis }> = ({ result }) => {
    const { stats, highest, lowest } = result;
    const max = Math.max(15, ...stats.map(s => s.percent * 1.15));
    const plotHeight = CHART.height - CHART.top - CHART.bottom;
    const y = (percent: number) => CHART.top + plotHeight * (1 - percent / max);
    const has_spread = highest !== lowest;

    return (
        <svg
            className='matches-differs-modal__chart'
            data-testid='dt_matches_differs_chart'
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            role='img'
            aria-label={localize('Share of recent ticks ending in each digit')}
        >
            <line className='matches-differs-modal__baseline' x1={0} x2={CHART.width} y1={y(10)} y2={y(10)} />
            <text className='matches-differs-modal__baseline-label' x={CHART.width - 2} y={y(10) - 3} textAnchor='end'>
                10%
            </text>
            {stats.map(s => {
                const x = CHART.left + s.digit * (CHART.bar + CHART.gap);
                const top = y(s.percent);
                const is_high = s.digit === highest && has_spread;
                const is_low = s.digit === lowest && has_spread;
                const modifier = is_high ? ' matches-differs-modal__bar--high' : is_low ? ' matches-differs-modal__bar--low' : '';
                return (
                    <g key={s.digit}>
                        <rect
                            className={`matches-differs-modal__bar${modifier}`}
                            x={x}
                            y={top}
                            width={CHART.bar}
                            height={Math.max(0, CHART.height - CHART.bottom - top)}
                            rx={2}
                        >
                            <title>{`${s.digit}: ${s.percent.toFixed(1)}% (${s.count})`}</title>
                        </rect>
                        <text className='matches-differs-modal__bar-value' x={x + CHART.bar / 2} y={top - 3} textAnchor='middle'>
                            {s.percent.toFixed(1)}
                        </text>
                        <text
                            className='matches-differs-modal__bar-digit'
                            x={x + CHART.bar / 2}
                            y={CHART.height - 6}
                            textAnchor='middle'
                        >
                            {s.digit}
                        </text>
                    </g>
                );
            })}
        </svg>
    );
};

const MatchesDiffersModal: React.FC<Props> = ({ isOpen, onClose, onApplied, is_running, store_symbol }) => {
    const [status, setStatus] = React.useState<Status>('idle');
    const [error_msg, setErrorMsg] = React.useState('');
    const [symbol, setSymbol] = React.useState<string | null>(null);
    const [sample, setSample] = React.useState<LoadedSample | null>(null);
    const [result, setResult] = React.useState<MatchesDiffersAnalysis | null>(null);
    const [pending, setPending] = React.useState<Pending | null>(null);
    const [apply_error, setApplyError] = React.useState('');
    const [is_applying, setIsApplying] = React.useState(false);
    const request_id = React.useRef(0);

    const resolveSymbol = () => getSelectedSymbol(window?.Blockly?.derivWorkspace) || store_symbol || null;

    const load = async () => {
        const current = resolveSymbol();
        setSymbol(current);
        setPending(null);
        setApplyError('');
        if (!current) {
            setStatus('error');
            setErrorMsg(localize('No market is selected in the bot. Choose a market in the Trade Definition block first.'));
            return;
        }
        const id = ++request_id.current;
        setStatus('loading');
        setErrorMsg('');
        setSample(null);
        setResult(null);
        try {
            const loaded = await loadSample(current);
            if (id !== request_id.current) return; // a newer request replaced this one
            setSample(loaded);
            setResult(analyze(loaded.digits));
            setStatus('ready');
        } catch (e) {
            if (id !== request_id.current) return;
            setErrorMsg(e instanceof Error ? e.message : String(e));
            setStatus('error');
        }
    };

    React.useEffect(() => {
        if (isOpen) {
            load();
        } else {
            request_id.current += 1; // ignore anything still in flight
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const handlePick = (direction: 'MATCHES' | 'DIFFERS') => {
        if (!result || !symbol || is_running) return;
        const digit = direction === 'MATCHES' ? result.highest : result.lowest;
        const preview = previewScannerPick(window?.Blockly?.derivWorkspace, { symbol, direction, digit });
        if (!preview.ok) {
            setApplyError(preview.reason);
            return;
        }
        setApplyError('');
        setPending({ direction, digit, preview });
    };

    const handleApply = async () => {
        if (!pending || !symbol || is_running || is_applying) return;
        setIsApplying(true);
        setApplyError('');
        try {
            const outcome = await applyScannerPick(window?.Blockly?.derivWorkspace, {
                symbol,
                direction: pending.direction,
                digit: pending.digit,
            });
            if (!outcome.ok) {
                setApplyError(outcome.reason);
                return;
            }
            setPending(null);
            onApplied();
        } catch (e) {
            setApplyError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsApplying(false);
        }
    };

    const handleClose = () => {
        request_id.current += 1;
        setPending(null);
        setApplyError('');
        onClose();
    };

    const is_confirming = !!pending;
    const audit = React.useMemo(() => (sample ? auditSequence(sample.digits, { side: 'digit' }) : null), [sample]);
    const category_before = pending?.preview.category?.before;
    const is_not_digits = is_confirming && category_before && String(category_before).trim() !== 'digits';

    const rows = pending
        ? [
              [localize('Symbol'), pending.preview.symbol],
              [localize('Trade type category'), pending.preview.category],
              [localize('Trade type'), pending.preview.tradeType],
              [localize('Contract type'), pending.preview.type],
              [localize('Prediction digit'), pending.preview.prediction],
          ].filter(([, field]) => field)
        : [];

    return (
        <Dialog
            portal_element_id='modal_root'
            title={localize('Matches / Differs analysis')}
            is_visible={isOpen}
            cancel_button_text={is_confirming ? localize('Back') : localize('Close')}
            onCancel={is_confirming ? () => setPending(null) : handleClose}
            confirm_button_text={
                is_confirming
                    ? is_applying
                        ? localize('Applying…')
                        : localize('Confirm & apply')
                    : status === 'loading'
                      ? localize('Loading…')
                      : localize('Refresh')
            }
            onConfirm={is_confirming ? handleApply : load}
            is_confirm_disabled={is_confirming ? is_running || is_applying : status === 'loading'}
            is_mobile_full_width={false}
            has_close_icon
            className='matches-differs-modal'
        >
            <div className='matches-differs-modal__content' data-testid='dt_matches_differs_modal'>
                {symbol && (
                    <p className='matches-differs-modal__market' data-testid='dt_matches_differs_market'>
                        <strong>{volatilityName(symbol)}</strong>
                        <span className='matches-differs-modal__symbol'>{symbol}</span>
                    </p>
                )}

                {symbol && !isVolatilitySymbol(symbol) && (
                    <p className='matches-differs-modal__notice' data-testid='dt_matches_differs_not_volatility'>
                        {localize(
                            'This market is not a Deriv volatility index, so last-digit statistics may not be meaningful.'
                        )}
                    </p>
                )}

                {status === 'loading' && (
                    <p className='matches-differs-modal__message' data-testid='dt_matches_differs_loading'>
                        <span className='matches-differs-modal__spinner' aria-hidden='true' />
                        {localize('Loading recent ticks…')}
                    </p>
                )}

                {status === 'error' && (
                    <p
                        className='matches-differs-modal__message matches-differs-modal__message--error'
                        data-testid='dt_matches_differs_error'
                    >
                        {error_msg}
                    </p>
                )}

                {status === 'ready' && result && sample && !is_confirming && (
                    <>
                        {sample.received < sample.requested && (
                            <p className='matches-differs-modal__notice' data-testid='dt_matches_differs_short_sample'>
                                {localize('Only {{received}} of {{requested}} requested ticks were available.', {
                                    received: sample.received,
                                    requested: sample.requested,
                                })}
                            </p>
                        )}

                        <dl className='matches-differs-modal__stats' data-testid='dt_matches_differs_stats'>
                            <div>
                                <dt>{localize('Sample')}</dt>
                                <dd data-testid='dt_matches_differs_sample'>{result.sample}</dd>
                            </div>
                            <div>
                                <dt>{localize('Deviation')}</dt>
                                <dd data-testid='dt_matches_differs_deviation'>{result.deviation.toFixed(1)}</dd>
                            </div>
                            <div>
                                <dt>{localize('Chi-square')}</dt>
                                <dd data-testid='dt_matches_differs_chi2'>{result.chi2.toFixed(2)}</dd>
                            </div>
                            <div>
                                <dt>{localize('Score')}</dt>
                                <dd data-testid='dt_matches_differs_score'>{result.score.toFixed(0)}</dd>
                            </div>
                        </dl>

                        <p
                            className={`matches-differs-modal__verdict${
                                result.significant ? ' matches-differs-modal__verdict--skewed' : ''
                            }`}
                            data-testid='dt_matches_differs_verdict'
                        >
                            {result.significant
                                ? `${localize('Skewed')} (${result.significance})`
                                : localize('Consistent with random')}
                        </p>
                        <p className='matches-differs-modal__hint'>
                            {localize(
                                'Score is a heuristic, not a probability of winning. Fair random digits typically score about {{noise}} at this sample size.',
                                { noise: result.expectedNoiseScore.toFixed(0) }
                            )}
                        </p>

                        <DigitChart result={result} />

                        {audit && (
                            <section className='matches-differs-modal__audit' data-testid='dt_matches_differs_audit'>
                                <h3>{localize('Sequence audit')}</h3>
                                <p>
                                    {localize('Latest digit')}: <strong>{audit.lastDigit ?? '?'}</strong> ? {localize('same-digit streak')}:{' '}
                                    <strong>{audit.currentStreak}</strong>
                                </p>
                                <p>
                                    {localize('Recent leader')} ({audit.recentWindow}): <strong>{audit.recentLeader ?? '?'}</strong>{' '}
                                    {audit.recentLeaderShare === null ? '' : `${(audit.recentLeaderShare * 100).toFixed(1)}%`} ?{' '}
                                    {localize('previous window')}: <strong>{audit.previousLeader ?? '?'}</strong>
                                </p>
                                <p>
                                    {audit.transitionLeader === null
                                        ? localize('Not enough transition history for the latest digit.')
                                        : localize('After the latest digit, {{digit}} followed {{count}} of {{sample}} observed times.', {
                                              digit: audit.transitionLeader,
                                              count: audit.transitionCount,
                                              sample: audit.transitionSample,
                                          })}
                                </p>
                                <p className={audit.reversalSignal ? 'matches-differs-modal__audit-warning' : ''}>
                                    {audit.reversalNote}
                                </p>
                            </section>
                        )}

                        <div className='matches-differs-modal__actions'>
                            <button
                                type='button'
                                className='matches-differs-modal__action matches-differs-modal__action--match'
                                data-testid='dt_matches_differs_match'
                                disabled={is_running}
                                onClick={() => handlePick('MATCHES')}
                            >
                                {localize('Match')} {result.highest}
                                <span>{result.matchPercent.toFixed(1)}%</span>
                            </button>
                            <button
                                type='button'
                                className='matches-differs-modal__action matches-differs-modal__action--differ'
                                data-testid='dt_matches_differs_differ'
                                disabled={is_running}
                                onClick={() => handlePick('DIFFERS')}
                            >
                                {localize('Differ')} {result.lowest}
                                <span>{result.differPercent.toFixed(1)}%</span>
                            </button>
                        </div>
                        {is_running && (
                            <p className='matches-differs-modal__message matches-differs-modal__message--error'>
                                {localize('Stop the bot before applying a suggestion.')}
                            </p>
                        )}
                        <p className='matches-differs-modal__hint'>
                            {localize(
                                'On fair digits Match wins 10% of the time and Differ 90%. Break-even payout is at least {{match}}x stake for Match and {{differ}}x for Differ; Deriv pays less than fair value.',
                                {
                                    match: MATCH_BREAKEVEN_PAYOUT,
                                    differ: DIFFER_BREAKEVEN_PAYOUT.toFixed(2),
                                }
                            )}
                        </p>
                    </>
                )}

                {is_confirming && (
                    <div data-testid='dt_matches_differs_confirm'>
                        <p className='matches-differs-modal__summary'>
                            {`${volatilityName(symbol)} · ${pending.direction === 'MATCHES' ? localize('Match') : localize('Differ')} ${pending.digit}`}
                        </p>
                        {is_not_digits && (
                            <p className='matches-differs-modal__notice' data-testid='dt_matches_differs_category_notice'>
                                {localize(
                                    'Your bot is currently set to {{category}} > {{type}}. Applying will change it to Digits > Matches/Differs.',
                                    {
                                        category: String(category_before),
                                        type: String(pending.preview.tradeType?.before ?? '-'),
                                    }
                                )}
                            </p>
                        )}
                        <table className='matches-differs-modal__table'>
                            <thead>
                                <tr>
                                    <th>{localize('Field')}</th>
                                    <th>{localize('From')}</th>
                                    <th>{localize('To')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(([label, field]) => (
                                    <tr key={String(label)}>
                                        <td>{label}</td>
                                        <td className='matches-differs-modal__before'>{field.before ?? '—'}</td>
                                        <td className='matches-differs-modal__after'>{field.after}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p className='matches-differs-modal__hint'>
                            {localize('Applying only edits the trade block. It does not start the bot.')}
                        </p>
                        {is_running && (
                            <p
                                className='matches-differs-modal__message matches-differs-modal__message--error'
                                data-testid='dt_matches_differs_running_warning'
                            >
                                {localize('Cannot apply while the bot is running.')}
                            </p>
                        )}
                    </div>
                )}

                {apply_error && (
                    <p
                        className='matches-differs-modal__message matches-differs-modal__message--error'
                        data-testid='dt_matches_differs_apply_error'
                    >
                        {apply_error}
                    </p>
                )}

                <p className='matches-differs-modal__disclaimer' data-testid='dt_matches_differs_disclaimer'>
                    {localize('Digits on Deriv synthetics are random. A skew in past ticks does not predict the next one.')}
                </p>
            </div>
        </Dialog>
    );
};

export default MatchesDiffersModal;
