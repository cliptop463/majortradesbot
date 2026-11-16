// High/Low Tick scanner built on the Digit Scanner's Over/Under pattern strategies.
import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { ApiHelpers } from '@/external/bot-skeleton';
import { fetchHistory, scanMarkets, selectVolatilityMarkets } from '@/utils/digit-scanner/scan';
import { analyzePattern, DEFAULT_PATTERN_STRATEGY_IDS, PATTERN_STRATEGY_IDS, PATTERN_STRATEGY_INFO } from '@/utils/digit-scanner/pattern-strategies';
import type { MarketAnalysis } from '@/utils/digit-scanner/types';
import { applyTickPick, previewTickPick } from '@/utils/tick-scanner-pick';
import './ticks-modal.scss';

type Props = { isOpen: boolean; onClose: () => void; onApplied: () => void; is_running: boolean };
type Pick = { symbol: string; direction: 'HIGH' | 'LOW'; selectedTick: number };

const toPick = (a: MarketAnalysis, selectedTick: number): Pick | null => {
    const direction = a.recommendation?.direction;
    if (direction !== 'OVER' && direction !== 'UNDER') return null;
    return { symbol: a.symbol, direction: direction === 'OVER' ? 'HIGH' : 'LOW', selectedTick };
};

const TicksModal: React.FC<Props> = ({ isOpen, onClose, onApplied, is_running }) => {
    const [scanning, setScanning] = React.useState(false);
    const [results, setResults] = React.useState<MarketAnalysis[]>([]);
    const [strategies, setStrategies] = React.useState<string[]>([...DEFAULT_PATTERN_STRATEGY_IDS]);
    const [minTicks, setMinTicks] = React.useState('200');
    const [selectedTick, setSelectedTick] = React.useState('5');
    const [error, setError] = React.useState('');
    const [applying, setApplying] = React.useState(false);

    const scan = async () => {
        const minimum = Number.parseInt(minTicks, 10);
        if (!Number.isInteger(minimum) || minimum < 50 || minimum > 5000) { setError(localize('Minimum ticks must be between 50 and 5000.')); return; }
        if (!strategies.length) { setError(localize('Select at least one strategy.')); return; }
        setScanning(true); setError(''); setResults([]);
        try {
            const active = ApiHelpers?.instance?.active_symbols;
            if (!active?.retrieveActiveSymbols) throw new Error(localize('Connection error: active symbols are unavailable.'));
            const symbols = await active.retrieveActiveSymbols(false);
            const { markets } = selectVolatilityMarkets(Array.isArray(symbols) ? symbols : []);
            const analyses = await scanMarkets(markets, fetchHistory, {
                count: Math.max(minimum, 1000), minObservations: minimum, concurrency: 3,
                analyze: digits => analyzePattern(digits, 'over_under', { strategyIds: strategies, minAgree: 1 }),
                audit: { side: 'over_under' },
            });
            setResults(analyses);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setScanning(false); }
    };

    const select = async (analysis: MarketAnalysis) => {
        const tick = Number.parseInt(selectedTick, 10);
        const pick = toPick(analysis, tick);
        if (!pick) { setError(localize('No Over/Under consensus was found for this market.')); return; }
        const preview = previewTickPick(window?.Blockly?.derivWorkspace, pick);
        if (!preview.ok) { setError(preview.reason); return; }
        setApplying(true);
        const result = await applyTickPick(window?.Blockly?.derivWorkspace, pick);
        setApplying(false);
        if (!result.ok) { setError(result.reason); return; }
        onApplied();
    };

    const close = () => { setError(''); setResults([]); onClose(); };
    return <Dialog portal_element_id='modal_root' title={localize('High/Low Ticks Scanner')} is_visible={isOpen} onCancel={close} has_close_icon cancel_button_text={localize('Close')} className='ticks-modal'>
        <div className='ticks-modal__content' data-testid='dt_ticks_scanner_modal'>
            <p className='ticks-modal__intro'>{localize('Runs the Digit Scanner Over/Under strategies and converts the consensus into a High Tick or Low Tick contract.')}</p>
            <div className='ticks-modal__controls'>
                <label>{localize('Minimum ticks')}<input type='number' min={50} max={5000} value={minTicks} onChange={e => setMinTicks(e.target.value)} /></label>
                <label>{localize('Selected tick')}<input type='number' min={1} max={5} value={selectedTick} onChange={e => setSelectedTick(e.target.value)} /><small>1–5</small></label>
            </div>
            <div className='ticks-modal__strategies'><strong>{localize('Strategies')}</strong>{PATTERN_STRATEGY_INFO.map(s => <label key={s.id}><input type='checkbox' checked={strategies.includes(s.id)} onChange={() => setStrategies(x => x.includes(s.id) ? x.filter(id => id !== s.id) : [...x, s.id])} />{s.name}</label>)}</div>
            <button type='button' className='ticks-modal__scan' onClick={scan} disabled={scanning || is_running}>{scanning ? localize('Scanning…') : localize('Scan for High/Low Ticks')}</button>
            {error && <p className='ticks-modal__error'>{error}</p>}
            {results.length > 0 && <table className='ticks-modal__table'><thead><tr><th>{localize('Market')}</th><th>{localize('Recommendation')}</th><th>{localize('Agreement')}</th><th /></tr></thead><tbody>{results.map(a => <tr key={a.symbol}><td>{a.displayName}<small>{a.symbol}</small></td><td>{a.recommendation ? (a.recommendation.direction === 'OVER' ? 'High Tick' : a.recommendation.direction === 'UNDER' ? 'Low Tick' : 'No signal') : 'No signal'}</td><td>{a.recommendation ? `${a.recommendation.agree}/${a.recommendation.eligible}` : '—'}</td><td><button type='button' onClick={() => select(a)} disabled={!a.recommendation || applying}>{localize('Use')}</button></td></tr>)}</tbody></table>}
            {!scanning && !results.length && <p className='ticks-modal__hint'>{localize('Choose your strategies and selected tick, then scan recent volatility-index ticks.')}</p>}
            <p className='ticks-modal__disclaimer'>{localize('These are historical heuristics, not a prediction or guarantee of profit.')}</p>
        </div>
    </Dialog>;
};

export default TicksModal;
