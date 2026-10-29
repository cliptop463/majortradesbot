// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import React from 'react';
import { ApiHelpers } from '@/external/bot-skeleton';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { fetchHistory, scanMarkets, selectVolatilityMarkets } from '@/utils/digit-scanner/scan';
import type { SkippedMarket } from '@/utils/digit-scanner/scan';
import { rankMarkets } from '@/utils/digit-scanner/ensemble';
import type { MarketAnalysis, RankingResult, RankedMarket, StrategyResult } from '@/utils/digit-scanner/types';
import { previewScannerPick, applyScannerPick } from '@/utils/blockly-scanner-pick';
import type { ScannerPickPreview } from '@/utils/blockly-scanner-pick';
import './digit-scanner-modal.scss';

type Props = {
    isOpen: boolean;
    onClose: () => void;
    onApplied: () => void;
    is_running: boolean;
};

type ScanStatus = 'idle' | 'scanning' | 'done' | 'error';

type ConfirmState = {
    pick: { symbol: string; direction: 'MATCHES' | 'DIFFERS'; digit: number };
    preview: ScannerPickPreview;
    displayName?: string;
} | null;

const directionLabel = (d: string) => (d === 'MATCHES' ? 'Matches' : 'Differs');

const DEFAULT_MIN_TICKS = 200;
const MIN_TICKS_FLOOR = 50;
const MAX_TICKS = 5000;
const DEFAULT_FETCH_COUNT = 500;

const StatusBadge: React.FC<{ status: MarketAnalysis['status'] | 'skipped' }> = ({ status }) => {
    const labels: Record<string, string> = {
        ok: 'OK',
        no_consensus: 'No consensus',
        insufficient_data: 'Insufficient data',
        error: 'Error',
        skipped: 'Skipped',
    };
    return (
        <span className={`digit-scanner-modal__badge digit-scanner-modal__badge--${status}`}>
            {labels[status] ?? status}
        </span>
    );
};

const StrategyRow: React.FC<{ s: StrategyResult }> = ({ s }) => (
    <tr className='digit-scanner-modal__strategy-table-row'>
        <td>{s.name}</td>
        <td>
            {s.status === 'signal' && s.direction !== undefined && s.digit !== undefined
                ? `${directionLabel(s.direction)} ${s.digit}`
                : s.status}
        </td>
        <td className='digit-scanner-modal__strategy-table-reason'>{s.reason}</td>
    </tr>
);

const RankedRow: React.FC<{
    ranked: RankedMarket;
    onSelect: (a: MarketAnalysis) => void;
    isRunning: boolean;
}> = ({ ranked, onSelect, isRunning }) => {
    const [expanded, setExpanded] = React.useState(false);
    const { analysis, recommendation } = ranked;

    return (
        <>
            <tr
                data-testid={`dt_digit_scanner_ranked_row_${analysis.symbol}`}
                className={`digit-scanner-modal__ranked-row${isRunning ? ' digit-scanner-modal__ranked-row--disabled' : ''}`}
                onClick={() => !isRunning && onSelect(analysis)}
            >
                <td className='digit-scanner-modal__cell digit-scanner-modal__cell--market'>
                    <button
                        type='button'
                        className='digit-scanner-modal__row-toggle'
                        aria-label={expanded ? localize('Collapse strategies') : localize('Expand strategies')}
                        onClick={e => {
                            e.stopPropagation();
                            setExpanded(x => !x);
                        }}
                    >
                        {expanded ? '▼' : '▶'}
                    </button>
                    #{ranked.rank} {analysis.displayName}
                    <span className='digit-scanner-modal__row-symbol'>{analysis.symbol}</span>
                </td>
                <td className='digit-scanner-modal__cell'>
                    <strong>{directionLabel(recommendation.direction)}</strong> digit{' '}
                    <strong>{recommendation.digit}</strong>
                </td>
                <td className='digit-scanner-modal__cell'>
                    {recommendation.agree}/{recommendation.eligible} agree
                </td>
                <td className='digit-scanner-modal__cell' title={localize('Heuristic score — not a win probability')}>
                    {recommendation.heuristicScore.toFixed(1)}
                    <span className='digit-scanner-modal__info-icon'>ℹ️</span>
                </td>
                <td className='digit-scanner-modal__cell'>
                    <button
                        type='button'
                        className='digit-scanner-modal__row-select'
                        data-testid={`dt_digit_scanner_select_row_${analysis.symbol}`}
                        disabled={isRunning}
                        onClick={e => {
                            e.stopPropagation();
                            if (!isRunning) onSelect(analysis);
                        }}
                    >
                        {localize('Select')}
                    </button>
                </td>
            </tr>
            {expanded && (
                <tr>
                    <td colSpan={5} className='digit-scanner-modal__expanded-cell'>
                        <table className='digit-scanner-modal__strategy-table'>
                            <thead>
                                <tr className='digit-scanner-modal__strategy-table-head'>
                                    <th>{localize('Strategy')}</th>
                                    <th>{localize('Signal')}</th>
                                    <th>{localize('Reason')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {analysis.strategies.map(s => (
                                    <StrategyRow key={s.id} s={s} />
                                ))}
                            </tbody>
                        </table>
                    </td>
                </tr>
            )}
        </>
    );
};

const RankedCard: React.FC<{
    ranked: RankedMarket;
    onSelect: (a: MarketAnalysis) => void;
    isRunning: boolean;
}> = ({ ranked, onSelect, isRunning }) => {
    const [expanded, setExpanded] = React.useState(false);
    const { analysis, recommendation } = ranked;

    return (
        <article className='digit-scanner-modal__ranked-card' data-testid={`dt_digit_scanner_ranked_card_${analysis.symbol}`}>
            <header className='digit-scanner-modal__market-header'>
                <div className='digit-scanner-modal__market-meta'>
                    <div className='digit-scanner-modal__market-name'>
                        #{ranked.rank} {analysis.displayName}
                    </div>
                    <div className='digit-scanner-modal__market-symbol'>{analysis.symbol}</div>
                </div>
                <button
                    type='button'
                    className='digit-scanner-modal__expand-button'
                    aria-label={expanded ? localize('Collapse strategies') : localize('Expand strategies')}
                    aria-expanded={expanded}
                    onClick={() => setExpanded(x => !x)}
                >
                    {expanded ? '▼' : '▶'}
                </button>
            </header>

            <div className='digit-scanner-modal__market-card-grid'>
                <div className='digit-scanner-modal__card-metric'>
                    <span className='digit-scanner-modal__card-label'>{localize('Recommendation')}</span>
                    <strong>
                        {directionLabel(recommendation.direction)} {localize('digit')} {recommendation.digit}
                    </strong>
                </div>
                <div className='digit-scanner-modal__card-metric'>
                    <span className='digit-scanner-modal__card-label'>{localize('Agreement')}</span>
                    <strong>
                        {recommendation.agree}/{recommendation.eligible}
                    </strong>
                </div>
                <div className='digit-scanner-modal__card-metric'>
                    <span className='digit-scanner-modal__card-label'>
                        {localize('Heuristic score (not a win probability)')}
                    </span>
                    <strong>{recommendation.heuristicScore.toFixed(1)}</strong>
                </div>
            </div>

            {expanded && (
                <div className='digit-scanner-modal__strategy-list'>
                    {analysis.strategies.map(strategy => (
                        <div className='digit-scanner-modal__strategy-item' key={strategy.id}>
                            <div className='digit-scanner-modal__strategy-row'>
                                <span className='digit-scanner-modal__strategy-row-label'>{localize('Strategy')}</span>
                                <span className='digit-scanner-modal__strategy-row-value'>{strategy.name}</span>
                            </div>
                            <div className='digit-scanner-modal__strategy-row'>
                                <span className='digit-scanner-modal__strategy-row-label'>{localize('Signal')}</span>
                                <span className='digit-scanner-modal__strategy-row-value'>
                                    {strategy.status === 'signal' &&
                                    strategy.direction !== undefined &&
                                    strategy.digit !== undefined
                                        ? `${directionLabel(strategy.direction)} ${strategy.digit}`
                                        : strategy.status}
                                </span>
                            </div>
                            <div className='digit-scanner-modal__strategy-row'>
                                <span className='digit-scanner-modal__strategy-row-label'>{localize('Reason')}</span>
                                <span className='digit-scanner-modal__strategy-row-value'>{strategy.reason}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <button
                type='button'
                className='digit-scanner-modal__select-button'
                data-testid={`dt_digit_scanner_card_select_${analysis.symbol}`}
                disabled={isRunning}
                onClick={() => {
                    if (!isRunning) onSelect(analysis);
                }}
            >
                {localize('Select')}
            </button>
        </article>
    );
};

const ExcludedRow: React.FC<{ analysis: MarketAnalysis }> = ({ analysis }) => {
    const [expanded, setExpanded] = React.useState(false);
    return (
        <>
            <tr className='digit-scanner-modal__excluded-row'>
                <td className='digit-scanner-modal__cell digit-scanner-modal__cell--compact'>
                    {analysis.strategies.length > 0 && (
                        <button
                            type='button'
                            className='digit-scanner-modal__row-toggle'
                            aria-label={expanded ? localize('Collapse') : localize('Expand')}
                            onClick={() => setExpanded(x => !x)}
                        >
                            {expanded ? '▼' : '▶'}
                        </button>
                    )}
                    {analysis.displayName}
                </td>
                <td className='digit-scanner-modal__cell digit-scanner-modal__cell--compact' colSpan={2}>
                    <StatusBadge status={analysis.status} />
                    {analysis.message && <span className='digit-scanner-modal__excluded-reason'>{analysis.message}</span>}
                </td>
                <td colSpan={2} />
            </tr>
            {expanded && analysis.strategies.length > 0 && (
                <tr className='digit-scanner-modal__excluded-detail'>
                    <td colSpan={5} className='digit-scanner-modal__expanded-cell'>
                        <table className='digit-scanner-modal__strategy-table'>
                            <tbody>
                                {analysis.strategies.map(s => (
                                    <StrategyRow key={s.id} s={s} />
                                ))}
                            </tbody>
                        </table>
                    </td>
                </tr>
            )}
        </>
    );
};

const SkippedRow: React.FC<{ market: SkippedMarket }> = ({ market }) => (
    <tr className='digit-scanner-modal__excluded-row'>
        <td className='digit-scanner-modal__cell digit-scanner-modal__cell--compact'>
            {market.displayName}
            <span className='digit-scanner-modal__row-symbol'>{market.symbol}</span>
        </td>
        <td className='digit-scanner-modal__cell digit-scanner-modal__cell--compact' colSpan={2}>
            <StatusBadge status='skipped' />
            <span className='digit-scanner-modal__excluded-reason'>{market.reason}</span>
        </td>
        <td colSpan={2} />
    </tr>
);

const DigitScannerModal: React.FC<Props> = ({ isOpen, onClose, onApplied, is_running }) => {
    const [scan_status, setScanStatus] = React.useState<ScanStatus>('idle');
    const [error_msg, setErrorMsg] = React.useState('');
    const [ranking, setRanking] = React.useState<RankingResult | null>(null);
    const [skippedMarkets, setSkippedMarkets] = React.useState<SkippedMarket[]>([]);
    const [confirm_state, setConfirmState] = React.useState<ConfirmState>(null);
    const [apply_error, setApplyError] = React.useState('');
    const [is_applying, setIsApplying] = React.useState(false);
    const [min_ticks_input, setMinTicksInput] = React.useState(String(DEFAULT_MIN_TICKS));

    const parsed_min_ticks = Number.parseInt(min_ticks_input, 10);
    const is_min_ticks_valid =
        Number.isInteger(parsed_min_ticks) && parsed_min_ticks >= MIN_TICKS_FLOOR && parsed_min_ticks <= MAX_TICKS;

    const handleScan = async () => {
        if (scan_status === 'scanning') return;
        if (!is_min_ticks_valid) {
            setErrorMsg(
                localize('Minimum ticks must be a whole number between {{min}} and {{max}}.', {
                    min: MIN_TICKS_FLOOR,
                    max: MAX_TICKS,
                })
            );
            setScanStatus('error');
            return;
        }
        setScanStatus('scanning');
        setErrorMsg('');
        setRanking(null);
        setSkippedMarkets([]);
        setApplyError('');

        try {
            const apiSymbols = ApiHelpers?.instance?.active_symbols;
            if (!apiSymbols || typeof apiSymbols.retrieveActiveSymbols !== 'function') {
                throw new Error(localize('Connection error: active symbols are unavailable.'));
            }
            const rawSymbols = await apiSymbols.retrieveActiveSymbols(false);
            if (apiSymbols.has_initialization_error) {
                throw new Error(localize('Connection error: unable to load active symbols. Check your connection.'));
            }
            if (!Array.isArray(rawSymbols)) {
                throw new Error(localize('Connection error: active symbols response was invalid.'));
            }
            const { markets, skipped } = selectVolatilityMarkets(rawSymbols);
            setSkippedMarkets(skipped);

            if (markets.length === 0) {
                if (skipped.length > 0) {
                    setRanking(rankMarkets([]));
                    setScanStatus('done');
                    return;
                }
                setErrorMsg(localize('No volatility markets available for scanning.'));
                setScanStatus('error');
                return;
            }

            const analyses = await scanMarkets(markets, fetchHistory, {
                count: Math.min(MAX_TICKS, Math.max(DEFAULT_FETCH_COUNT, parsed_min_ticks)),
                minObservations: parsed_min_ticks,
                concurrency: 3,
                timeout: 10000,
            });

            setRanking(rankMarkets(analyses));
            setScanStatus('done');
        } catch (e) {
            setErrorMsg(e instanceof Error ? e.message : String(e));
            setScanStatus('error');
        }
    };

    const handleRowSelect = (analysis: MarketAnalysis) => {
        if (!analysis.recommendation) return;
        const pick = {
            symbol: analysis.symbol,
            direction: analysis.recommendation.direction,
            digit: analysis.recommendation.digit,
        };
        const display_name = analysis.displayName;
        const workspace = window?.Blockly?.derivWorkspace;
        const preview = previewScannerPick(workspace, pick);
        if (!preview.ok) {
            setApplyError(preview.reason);
            return;
        }
        setApplyError('');
        setConfirmState({ pick, preview, displayName: display_name });
    };

    const handleApply = async () => {
        if (!confirm_state || is_running) return;
        setIsApplying(true);
        setApplyError('');
        try {
            const workspace = window?.Blockly?.derivWorkspace;
            const result = await applyScannerPick(workspace, confirm_state.pick);
            if (!result.ok) {
                setApplyError(result.reason);
                setIsApplying(false);
                return;
            }
            setConfirmState(null);
            onApplied();
        } catch (e) {
            setApplyError(e instanceof Error ? e.message : String(e));
        } finally {
            setIsApplying(false);
        }
    };

    const handleClose = () => {
        setScanStatus('idle');
        setErrorMsg('');
        setRanking(null);
        setSkippedMarkets([]);
        setConfirmState(null);
        setApplyError('');
        onClose();
    };

    const preview = confirm_state?.preview;

    return (
        <>
            {/* Main scanner modal */}
            <Dialog
                portal_element_id='modal_root'
                title={localize('Digit Scanner')}
                is_visible={isOpen && !confirm_state}
                cancel_button_text={localize('Close')}
                onCancel={handleClose}
                confirm_button_text={scan_status === 'scanning' ? localize('Scanning…') : localize('Scan')}
                onConfirm={handleScan}
                is_confirm_disabled={scan_status === 'scanning'}
                is_mobile_full_width={false}
                has_close_icon
                className='digit-scanner-modal'
            >
                <div
                    className='digit-scanner-modal__content'
                    data-testid='dt_digit_scanner_modal_content'
                >
                    <div className='digit-scanner-modal__settings'>
                        <label className='digit-scanner-modal__settings-label' htmlFor='digit-scanner-min-ticks'>
                            {localize('Minimum ticks per market')}
                        </label>
                        <input
                            id='digit-scanner-min-ticks'
                            data-testid='dt_digit_scanner_min_ticks'
                            className={`digit-scanner-modal__settings-input${
                                is_min_ticks_valid ? '' : ' digit-scanner-modal__settings-input--invalid'
                            }`}
                            type='number'
                            inputMode='numeric'
                            min={MIN_TICKS_FLOOR}
                            max={MAX_TICKS}
                            step={50}
                            value={min_ticks_input}
                            disabled={scan_status === 'scanning'}
                            onChange={e => setMinTicksInput(e.target.value)}
                        />
                    </div>

                    {scan_status === 'scanning' && (
                        <div className='digit-scanner-modal__scanning' data-testid='dt_digit_scanner_scanning'>
                            <span className='digit-scanner-spinner' aria-label={localize('Scanning…')} />
                            {localize('Scanning volatility markets…')}
                        </div>
                    )}

                    {scan_status === 'error' && (
                        <p className='digit-scanner-modal__message digit-scanner-modal__message--error' data-testid='dt_digit_scanner_error'>
                            {error_msg}
                        </p>
                    )}

                    {scan_status === 'idle' && !ranking && (
                        <p className='digit-scanner-modal__message'>
                            {localize(
                                'Click Scan to analyse recent ticks of each volatility market and find digit patterns.'
                            )}
                        </p>
                    )}

                    {apply_error && (
                        <p
                            className='digit-scanner-modal__message digit-scanner-modal__message--error'
                            data-testid='dt_digit_scanner_apply_error'
                        >
                            {apply_error}
                        </p>
                    )}

                    {ranking && (
                        <div data-testid='dt_digit_scanner_results'>
                            {ranking.selected && (
                                <p className='digit-scanner-modal__selected' data-testid='dt_digit_scanner_selected'>
                                    {`${localize('Selected')}: ${ranking.selected.analysis.symbol} · ${directionLabel(
                                        ranking.selected.recommendation.direction
                                    )} ${ranking.selected.recommendation.digit}`}
                                </p>
                            )}

                            {ranking.ranked.length === 0 && (
                                <p className='digit-scanner-modal__message' data-testid='dt_digit_scanner_no_results'>
                                    {skippedMarkets.length > 0 && ranking.excluded.length === 0
                                        ? localize('No open volatility markets were available to scan.')
                                        : localize('No consensus found across any volatility market.')}
                                </p>
                            )}

                            {ranking.ranked.length > 0 && (
                                <>
                                    <table className='digit-scanner-modal__results-table'>
                                        <thead>
                                            <tr className='digit-scanner-modal__results-head'>
                                                <th>{localize('Market')}</th>
                                                <th>{localize('Recommendation')}</th>
                                                <th>{localize('Agreement')}</th>
                                                <th title={localize('Heuristic score, not a win probability')}>
                                                    {localize('Heuristic score (not a win probability)')}
                                                </th>
                                                <th />
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {ranking.ranked.map(r => (
                                                <RankedRow
                                                    key={r.analysis.symbol}
                                                    ranked={r}
                                                    onSelect={handleRowSelect}
                                                    isRunning={is_running}
                                                />
                                            ))}
                                        </tbody>
                                    </table>
                                    <div className='digit-scanner-modal__results-cards'>
                                        {ranking.ranked.map(r => (
                                            <RankedCard
                                                key={r.analysis.symbol}
                                                ranked={r}
                                                onSelect={handleRowSelect}
                                                isRunning={is_running}
                                            />
                                        ))}
                                    </div>
                                </>
                            )}

                            {(ranking.excluded.length > 0 || skippedMarkets.length > 0) && (
                                <>
                                    <p className='digit-scanner-modal__excluded-title'>{localize('Excluded markets')}</p>
                                    <table className='digit-scanner-modal__excluded-table'>
                                        <tbody>
                                            {ranking.excluded.map(a => (
                                                <ExcludedRow key={a.symbol} analysis={a} />
                                            ))}
                                            {skippedMarkets.map(market => (
                                                <SkippedRow key={market.symbol} market={market} />
                                            ))}
                                        </tbody>
                                    </table>
                                </>
                            )}
                        </div>
                    )}
                    <p className='digit-scanner-modal__disclaimer'>
                        {localize('Heuristics describe past noise only; they do not imply an edge or guarantee profit.')}
                    </p>
                </div>
            </Dialog>

            {/* Confirm-before-apply dialog */}
            <Dialog
                portal_element_id='modal_root'
                title={localize('Apply to bot?')}
                is_visible={!!confirm_state}
                confirm_button_text={localize('Confirm & apply')}
                onConfirm={handleApply}
                is_confirm_disabled={is_running || is_applying}
                cancel_button_text={localize('Cancel')}
                onCancel={() => {
                    setConfirmState(null);
                    setApplyError('');
                }}
                is_mobile_full_width={false}
                has_close_icon
                className='digit-scanner-confirm-modal'
            >
                <div
                    className='digit-scanner-confirm-modal__content'
                    data-testid='dt_digit_scanner_confirm_dialog'
                >
                    {apply_error && (
                        <p className='digit-scanner-modal__message digit-scanner-modal__message--error'>{apply_error}</p>
                    )}
                    {confirm_state && (
                        <p className='digit-scanner-confirm-modal__summary'>
                            {`${confirm_state.displayName ? `${confirm_state.displayName} (${confirm_state.pick.symbol})` : confirm_state.pick.symbol} · ${directionLabel(
                                confirm_state.pick.direction
                            )} · ${localize('digit')} ${confirm_state.pick.digit}`}
                        </p>
                    )}
                    {preview && (
                        <table className='digit-scanner-confirm-modal__table'>
                            <thead>
                                <tr className='digit-scanner-confirm-modal__head'>
                                    <th>{localize('Field')}</th>
                                    <th>{localize('From')}</th>
                                    <th>{localize('To')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>{localize('Symbol')}</td>
                                    <td className='digit-scanner-confirm-modal__before'>{preview.symbol.before ?? '—'}</td>
                                    <td className='digit-scanner-confirm-modal__after'>{preview.symbol.after}</td>
                                </tr>
                                {preview.category && (
                                    <tr>
                                        <td>{localize('Trade type category')}</td>
                                        <td className='digit-scanner-confirm-modal__before'>
                                            {preview.category.before ?? '—'}
                                        </td>
                                        <td className='digit-scanner-confirm-modal__after'>{preview.category.after}</td>
                                    </tr>
                                )}
                                {preview.tradeType && (
                                    <tr>
                                        <td>{localize('Trade type')}</td>
                                        <td className='digit-scanner-confirm-modal__before'>
                                            {preview.tradeType.before ?? '—'}
                                        </td>
                                        <td className='digit-scanner-confirm-modal__after'>{preview.tradeType.after}</td>
                                    </tr>
                                )}
                                <tr>
                                    <td>{localize('Contract type')}</td>
                                    <td className='digit-scanner-confirm-modal__before'>{preview.type.before ?? '—'}</td>
                                    <td className='digit-scanner-confirm-modal__after'>{preview.type.after}</td>
                                </tr>
                                <tr>
                                    <td>{localize('Prediction digit')}</td>
                                    <td className='digit-scanner-confirm-modal__before'>
                                        {preview.prediction.before ?? '—'}
                                    </td>
                                    <td className='digit-scanner-confirm-modal__after'>{preview.prediction.after}</td>
                                </tr>
                            </tbody>
                        </table>
                    )}
                    {is_running && (
                        <p
                            className='digit-scanner-modal__message digit-scanner-modal__message--error'
                            data-testid='dt_digit_scanner_bot_running_warning'
                        >
                            {localize('Cannot apply while the bot is running.')}
                        </p>
                    )}
                    {is_applying && <p className='digit-scanner-modal__message'>{localize('Applying…')}</p>}
                </div>
            </Dialog>
        </>
    );
};

export default DigitScannerModal;
