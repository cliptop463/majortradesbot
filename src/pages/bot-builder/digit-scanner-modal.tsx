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
} | null;

const directionLabel = (d: string) => (d === 'MATCHES' ? 'Matches' : 'Differs');

const StatusBadge: React.FC<{ status: MarketAnalysis['status'] | 'skipped' }> = ({ status }) => {
    const colours: Record<string, string> = {
        ok: '#4caf50',
        no_consensus: '#ff9800',
        insufficient_data: '#9e9e9e',
        error: '#f44336',
        skipped: '#9e9e9e',
    };
    const labels: Record<string, string> = {
        ok: 'OK',
        no_consensus: 'No consensus',
        insufficient_data: 'Insufficient data',
        error: 'Error',
        skipped: 'Skipped',
    };
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '0.15rem 0.5rem',
                borderRadius: '0.3rem',
                backgroundColor: colours[status] ?? '#9e9e9e',
                color: '#fff',
                fontSize: '1.1rem',
                fontWeight: 600,
            }}
        >
            {labels[status] ?? status}
        </span>
    );
};

const StrategyRow: React.FC<{ s: StrategyResult }> = ({ s }) => (
    <tr style={{ fontSize: '1.1rem', color: 'var(--text-less-prominent)' }}>
        <td style={{ padding: '0.2rem 0.8rem' }}>{s.name}</td>
        <td style={{ padding: '0.2rem 0.8rem' }}>
            {s.status === 'signal' && s.direction !== undefined && s.digit !== undefined
                ? `${directionLabel(s.direction)} ${s.digit}`
                : s.status}
        </td>
        <td style={{ padding: '0.2rem 0.8rem', fontStyle: 'italic' }}>{s.reason}</td>
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
                style={{ cursor: isRunning ? 'not-allowed' : 'pointer', opacity: isRunning ? 0.6 : 1 }}
                onClick={() => !isRunning && onSelect(analysis)}
            >
                <td style={{ padding: '0.6rem 0.8rem', fontWeight: 600 }}>
                    <button
                        aria-label={expanded ? localize('Collapse strategies') : localize('Expand strategies')}
                        onClick={e => {
                            e.stopPropagation();
                            setExpanded(x => !x);
                        }}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            marginRight: '0.4rem',
                            fontSize: '1rem',
                            color: 'var(--text-prominent)',
                        }}
                    >
                        {expanded ? '▼' : '▶'}
                    </button>
                    #{ranked.rank} {analysis.displayName}
                    <span
                        style={{
                            display: 'block',
                            fontSize: '1rem',
                            color: 'var(--text-less-prominent)',
                        }}
                    >
                        {analysis.symbol}
                    </span>
                </td>
                <td style={{ padding: '0.6rem 0.8rem' }}>
                    <strong>{directionLabel(recommendation.direction)}</strong> digit{' '}
                    <strong>{recommendation.digit}</strong>
                </td>
                <td style={{ padding: '0.6rem 0.8rem' }}>
                    {recommendation.agree}/{recommendation.eligible} agree
                </td>
                <td
                    title={localize('Heuristic score — not a win probability')}
                    style={{ padding: '0.6rem 0.8rem' }}
                >
                    {recommendation.heuristicScore.toFixed(1)}
                    <span style={{ fontSize: '1rem', marginLeft: '0.3rem', color: 'var(--text-less-prominent)' }}>
                        ℹ️
                    </span>
                </td>
                <td style={{ padding: '0.6rem 0.8rem' }}>
                    <button
                        data-testid={`dt_digit_scanner_select_row_${analysis.symbol}`}
                        disabled={isRunning}
                        onClick={e => {
                            e.stopPropagation();
                            if (!isRunning) onSelect(analysis);
                        }}
                        style={{
                            padding: '0.3rem 0.8rem',
                            borderRadius: '0.4rem',
                            border: '1px solid var(--button-primary-default)',
                            background: 'transparent',
                            color: 'var(--button-primary-default)',
                            cursor: isRunning ? 'not-allowed' : 'pointer',
                            fontSize: '1.1rem',
                        }}
                    >
                        {localize('Select')}
                    </button>
                </td>
            </tr>
            {expanded && (
                <tr>
                    <td colSpan={5} style={{ padding: '0 1.6rem 0.8rem' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr
                                    style={{
                                        fontSize: '1rem',
                                        color: 'var(--text-less-prominent)',
                                        textAlign: 'left',
                                    }}
                                >
                                    <th style={{ padding: '0.2rem 0.8rem' }}>{localize('Strategy')}</th>
                                    <th style={{ padding: '0.2rem 0.8rem' }}>{localize('Signal')}</th>
                                    <th style={{ padding: '0.2rem 0.8rem' }}>{localize('Reason')}</th>
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
            <tr style={{ background: 'var(--general-section-1)', opacity: 0.7 }}>
                <td style={{ padding: '0.5rem 0.8rem' }}>
                    {analysis.strategies.length > 0 && (
                        <button
                            aria-label={expanded ? localize('Collapse') : localize('Expand')}
                            onClick={() => setExpanded(x => !x)}
                            style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                marginRight: '0.4rem',
                                fontSize: '1rem',
                            }}
                        >
                            {expanded ? '▼' : '▶'}
                        </button>
                    )}
                    {analysis.displayName}
                </td>
                <td style={{ padding: '0.5rem 0.8rem' }} colSpan={2}>
                    <StatusBadge status={analysis.status} />
                    {analysis.message && (
                        <span style={{ marginLeft: '0.6rem', fontSize: '1.1rem', color: 'var(--text-less-prominent)' }}>
                            {analysis.message}
                        </span>
                    )}
                </td>
                <td colSpan={2} />
            </tr>
            {expanded && analysis.strategies.length > 0 && (
                <tr style={{ background: 'var(--general-section-1)' }}>
                    <td colSpan={5} style={{ padding: '0 1.6rem 0.8rem' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
    <tr style={{ background: 'var(--general-section-1)', opacity: 0.7 }}>
        <td style={{ padding: '0.5rem 0.8rem' }}>
            {market.displayName}
            <span style={{ display: 'block', fontSize: '1rem', color: 'var(--text-less-prominent)' }}>
                {market.symbol}
            </span>
        </td>
        <td style={{ padding: '0.5rem 0.8rem' }} colSpan={2}>
            <StatusBadge status='skipped' />
            <span style={{ marginLeft: '0.6rem', fontSize: '1.1rem', color: 'var(--text-less-prominent)' }}>
                {market.reason}
            </span>
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

    const handleScan = async () => {
        if (scan_status === 'scanning') return;
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
                count: 500,
                minObservations: 200,
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
        const workspace = window?.Blockly?.derivWorkspace;
        const preview = previewScannerPick(workspace, pick);
        if (!preview.ok) {
            setApplyError(preview.reason);
            return;
        }
        setApplyError('');
        setConfirmState({ pick, preview });
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
                    {scan_status === 'scanning' && (
                        <div
                            data-testid='dt_digit_scanner_scanning'
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.8rem',
                                padding: '1.6rem',
                                color: 'var(--text-prominent)',
                            }}
                        >
                            <span
                                className='digit-scanner-spinner'
                                aria-label={localize('Scanning…')}
                                style={{
                                    display: 'inline-block',
                                    width: '1.6rem',
                                    height: '1.6rem',
                                    border: '2px solid var(--button-primary-default)',
                                    borderTopColor: 'transparent',
                                    borderRadius: '50%',
                                    animation: 'digit-scanner-spin 0.8s linear infinite',
                                }}
                            />
                            {localize('Scanning volatility markets…')}
                        </div>
                    )}

                    {scan_status === 'error' && (
                        <p
                            data-testid='dt_digit_scanner_error'
                            style={{ color: 'var(--status-danger)', padding: '0.8rem' }}
                        >
                            {error_msg}
                        </p>
                    )}

                    {scan_status === 'idle' && !ranking && (
                        <p style={{ padding: '0.8rem', color: 'var(--text-less-prominent)' }}>
                            {localize(
                                'Click Scan to analyse the last 500 ticks of each volatility market and find digit patterns.'
                            )}
                        </p>
                    )}

                    {apply_error && (
                        <p
                            data-testid='dt_digit_scanner_apply_error'
                            style={{ color: 'var(--status-danger)', padding: '0.8rem' }}
                        >
                            {apply_error}
                        </p>
                    )}

                    {ranking && (
                        <div data-testid='dt_digit_scanner_results'>
                            {ranking.ranked.length === 0 && (
                                <p
                                    style={{ padding: '0.8rem', color: 'var(--text-less-prominent)' }}
                                    data-testid='dt_digit_scanner_no_results'
                                >
                                    {skippedMarkets.length > 0 && ranking.excluded.length === 0
                                        ? localize('No open volatility markets were available to scan.')
                                        : localize('No consensus found across any volatility market.')}
                                </p>
                            )}

                            {ranking.ranked.length > 0 && (
                                <>
                                    <table className='digit-scanner-modal__results-table'>
                                        <thead>
                                            <tr
                                                style={{
                                                    borderBottom: '1px solid var(--border-normal)',
                                                    textAlign: 'left',
                                                    color: 'var(--text-less-prominent)',
                                                    fontSize: '1.1rem',
                                                }}
                                            >
                                                <th style={{ padding: '0.4rem 0.8rem' }}>{localize('Market')}</th>
                                                <th style={{ padding: '0.4rem 0.8rem' }}>
                                                    {localize('Recommendation')}
                                                </th>
                                                <th style={{ padding: '0.4rem 0.8rem' }}>{localize('Agreement')}</th>
                                                <th
                                                    title={localize('Heuristic score, not a win probability')}
                                                    style={{ padding: '0.4rem 0.8rem' }}
                                                >
                                                    {localize('Heuristic score (not a win probability)')}
                                                </th>
                                                <th style={{ padding: '0.4rem 0.8rem' }} />
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
                                    <p
                                        style={{
                                            padding: '0.8rem',
                                            fontSize: '1.1rem',
                                            color: 'var(--text-less-prominent)',
                                            marginTop: '1.2rem',
                                        }}
                                    >
                                        {localize('Excluded markets')}
                                    </p>
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
                    <p
                        style={{
                            padding: '0.4rem 0.8rem',
                            fontSize: '1.1rem',
                            color: 'var(--text-less-prominent)',
                            fontStyle: 'italic',
                        }}
                    >
                        {localize(
                            'Heuristics describe past noise only; they do not imply an edge or guarantee profit.'
                        )}
                    </p>
                </div>
            </Dialog>

            {/* Confirm-before-apply dialog */}
            <Dialog
                portal_element_id='modal_root'
                title={localize('Apply to bot?')}
                is_visible={!!confirm_state}
                confirm_button_text={localize('Apply to bot')}
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
                        <p style={{ color: 'var(--status-danger)', marginBottom: '0.8rem' }}>{apply_error}</p>
                    )}
                    {preview && (
                        <table className='digit-scanner-confirm-modal__table'>
                            <thead>
                                <tr style={{ color: 'var(--text-less-prominent)', fontSize: '1.1rem' }}>
                                    <th style={{ padding: '0.4rem 0.8rem', textAlign: 'left' }}>
                                        {localize('Field')}
                                    </th>
                                    <th style={{ padding: '0.4rem 0.8rem', textAlign: 'left' }}>
                                        {localize('Before')}
                                    </th>
                                    <th style={{ padding: '0.4rem 0.8rem', textAlign: 'left' }}>
                                        {localize('After')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td style={{ padding: '0.5rem 0.8rem' }}>{localize('Symbol')}</td>
                                    <td style={{ padding: '0.5rem 0.8rem', color: 'var(--text-less-prominent)' }}>
                                        {preview.symbol.before ?? '—'}
                                    </td>
                                    <td style={{ padding: '0.5rem 0.8rem', fontWeight: 600 }}>
                                        {preview.symbol.after}
                                    </td>
                                </tr>
                                <tr>
                                    <td style={{ padding: '0.5rem 0.8rem' }}>{localize('Contract type')}</td>
                                    <td style={{ padding: '0.5rem 0.8rem', color: 'var(--text-less-prominent)' }}>
                                        {preview.type.before ?? '—'}
                                    </td>
                                    <td style={{ padding: '0.5rem 0.8rem', fontWeight: 600 }}>
                                        {preview.type.after}
                                    </td>
                                </tr>
                                <tr>
                                    <td style={{ padding: '0.5rem 0.8rem' }}>{localize('Prediction digit')}</td>
                                    <td style={{ padding: '0.5rem 0.8rem', color: 'var(--text-less-prominent)' }}>
                                        {preview.prediction.before ?? '—'}
                                    </td>
                                    <td style={{ padding: '0.5rem 0.8rem', fontWeight: 600 }}>
                                        {preview.prediction.after}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    )}
                    {is_running && (
                        <p
                            data-testid='dt_digit_scanner_bot_running_warning'
                            style={{ marginTop: '1rem', color: 'var(--status-danger)', fontSize: '1.1rem' }}
                        >
                            {localize('Cannot apply while the bot is running.')}
                        </p>
                    )}
                    {is_applying && (
                        <p style={{ marginTop: '0.8rem', color: 'var(--text-less-prominent)', fontSize: '1.1rem' }}>
                            {localize('Applying…')}
                        </p>
                    )}
                </div>
            </Dialog>

            <style>{`@keyframes digit-scanner-spin { to { transform: rotate(360deg); } }`}</style>
        </>
    );
};

export default DigitScannerModal;
