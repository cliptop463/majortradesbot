// High/Low Tick scanner based on price-direction t-statistics.
import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { ApiHelpers } from '@/external/bot-skeleton';
import { fetchHistory, selectVolatilityMarkets } from '@/utils/digit-scanner/scan';
import { scanDirections } from '@/utils/tick-direction/scan-directions';
import type { DirectionScanRow } from '@/utils/tick-direction/scan-directions';
import { applyTickPick, previewTickPick } from '@/utils/tick-scanner-pick';
import './ticks-modal.scss';

type Props = { isOpen: boolean; onClose: () => void; onApplied: () => void; is_running: boolean };
type Pick = { symbol: string; direction: 'HIGH' | 'LOW'; selectedTick: number };

const toPick = (analysis: DirectionScanRow, selectedTick: number): Pick | null =>
    analysis.recommendation ? { symbol: analysis.symbol, direction: analysis.recommendation, selectedTick } : null;

const TicksModal: React.FC<Props> = ({ isOpen, onClose, onApplied, is_running }) => {
    const [scanning, setScanning] = React.useState(false);
    const [results, setResults] = React.useState<DirectionScanRow[]>([]);
    const [minutes, setMinutes] = React.useState('1');
    const [minT, setMinT] = React.useState('2.5');
    const [selectedTick, setSelectedTick] = React.useState('1');
    const [error, setError] = React.useState('');
    const [applying, setApplying] = React.useState(false);
    const [selected, setSelected] = React.useState<DirectionScanRow | null>(null);

    const scan = async () => {
        const timeframe = Number(minutes);
        const threshold = Number(minT);
        if (!Number.isFinite(timeframe) || timeframe < 0.5 || timeframe > 5) {
            setError(localize('Timeframe must be between 0.5 and 5 minutes.'));
            return;
        }
        if (!Number.isFinite(threshold) || threshold < 1 || threshold > 6) {
            setError(localize('Minimum |t| must be between 1 and 6.'));
            return;
        }
        setScanning(true); setError(''); setResults([]); setSelected(null);
        try {
            const active = ApiHelpers?.instance?.active_symbols;
            if (!active?.retrieveActiveSymbols) throw new Error(localize('Connection error: active symbols are unavailable.'));
            const symbols = await active.retrieveActiveSymbols(false);
            const { markets } = selectVolatilityMarkets(Array.isArray(symbols) ? symbols : []);
            setResults(await scanDirections(markets, fetchHistory, { minutes: timeframe, minT: threshold, concurrency: 3 }));
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setScanning(false); }
    };

    const select = (analysis: DirectionScanRow) => {
        setError('');
        setSelected(analysis);
    };

    const apply = async () => {
        if (!selected) return;
        const tick = Number(selectedTick);
        if (!Number.isInteger(tick) || tick < 1 || tick > 5) {
            setError(localize('Selected tick must be a whole number from 1 to 5.'));
            return;
        }
        const pick = toPick(selected, tick);
        if (!pick) { setError(localize('This market has no directional move.')); return; }
        const preview = previewTickPick(window?.Blockly?.derivWorkspace, pick);
        if ('reason' in preview) { setError(preview.reason); return; }
        setApplying(true);
        try {
            const result = await applyTickPick(window?.Blockly?.derivWorkspace, pick);
            if ('reason' in result) { setError(result.reason); return; }
            onApplied();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setApplying(false);
        }
    };

    const close = () => { setError(''); setResults([]); setSelected(null); onClose(); };
    return <Dialog portal_element_id='modal_root' title={localize('High/Low Ticks Scanner')} is_visible={isOpen} onCancel={close} onConfirm={() => undefined} login={() => undefined} has_close_icon cancel_button_text={localize('Close')} className='ticks-modal'>
        <div className='ticks-modal__content' data-testid='dt_ticks_scanner_modal'>
            <p className='ticks-modal__intro'>{localize('Scans recent prices for a statistically significant directional move using nested-window t-statistics. A falling move maps to High Tick; a rising move maps to Low Tick.')}</p>
            <div className='ticks-modal__controls'>
                <label>{localize('Timeframe (min)')}<input type='number' min={0.5} max={5} step={0.5} value={minutes} onChange={e => setMinutes(e.target.value)} /></label>
                <label>{localize('Minimum |t|')}<input type='number' min={1} max={6} step={0.1} value={minT} onChange={e => setMinT(e.target.value)} /></label>
                <label>{localize('Selected tick')}<input type='number' min={1} max={5} value={selectedTick} onChange={e => setSelectedTick(e.target.value)} /><small>1–5</small></label>
            </div>
            <button type='button' className='ticks-modal__scan' onClick={scan} disabled={scanning || is_running}>{scanning ? localize('Scanning…') : localize('Scan for High/Low Ticks')}</button>
            {error && <p className='ticks-modal__error'>{error}</p>}
            {selected?.recommendation && <section className='ticks-modal__selection' data-testid='dt_ticks_scanner_selection'><div><span className='ticks-modal__selection-label'>{localize('Selected analysis')}</span><strong>{selected.displayName}</strong><small>{selected.symbol}</small></div><div className='ticks-modal__selection-pick'>{selected.recommendation === 'HIGH' ? localize('High Tick') : localize('Low Tick')} <span>{localize('selected tick')} {selectedTick}</span></div><button type='button' className='ticks-modal__apply' onClick={apply} disabled={applying || is_running}>{applying ? localize('Applying…') : localize('Apply to bot')}</button></section>}
            {results.length > 0 && <table className='ticks-modal__table'><thead><tr><th>{localize('Market')}</th><th>{localize('Move')}</th><th>{localize('t-score')}</th><th>{localize('Recommendation')}</th><th /></tr></thead><tbody>{results.map(a => <tr key={a.symbol} className={selected?.symbol === a.symbol ? 'ticks-modal__row--selected' : ''} onClick={() => a.recommendation && select(a)} title={a.reason}><td>{a.displayName}<small>{a.symbol}</small></td><td>{a.direction === 'UP' ? '↑' : a.direction === 'DOWN' ? '↓' : '—'}</td><td>{a.ticks && Number.isFinite(a.t) ? `${a.t > 0 ? '+' : ''}${a.t.toFixed(2)}` : '—'}<small>{a.ticks ? `${a.window} ticks` : ''}</small></td><td>{a.recommendation === 'HIGH' ? localize('High Tick') : a.recommendation === 'LOW' ? localize('Low Tick') : localize('No signal')}</td><td><button type='button' onClick={e => { e.stopPropagation(); if (a.recommendation) select(a); }} disabled={!a.recommendation || applying}>{selected?.symbol === a.symbol ? localize('Selected') : localize('Select')}</button></td></tr>)}</tbody></table>}
            {!scanning && !results.length && <p className='ticks-modal__hint'>{localize('Set the timeframe and selected tick, then scan recent volatility-index ticks for a directional move.')}</p>}
            <p className='ticks-modal__disclaimer'>{localize('A directional signal describes recent ticks. Validate in Paper mode against the break-even win rate before staking.')}</p>
        </div>
    </Dialog>;
};

export default TicksModal;
