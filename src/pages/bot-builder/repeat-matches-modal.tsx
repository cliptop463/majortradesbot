// @ts-nocheck — Blockly/window globals follow the other bot-builder modals
import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { createDerivApi, getAccountContext } from '@/utils/bulk-strategy/deriv-api';
import { RepeatMatchesEngine, MAX_REPEAT_MATCHES_CONTRACTS } from '@/utils/repeat-matches-engine';
import './repeat-matches-modal.scss';

const MARKETS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];

export default function RepeatMatchesModal({ isOpen, onClose, is_running, onRunningChange }) {
    const [symbol, setSymbol] = React.useState('R_100');
    const [stake, setStake] = React.useState('0.35');
    const [mode, setMode] = React.useState('paper');
    const [running, setRunning] = React.useState(false);
    const [open, setOpen] = React.useState(0);
    const [placed, setPlaced] = React.useState(0);
    const [skipped, setSkipped] = React.useState(0);
    const [lastDigit, setLastDigit] = React.useState(null);
    const [error, setError] = React.useState('');
    const engine = React.useRef(null);
    const mounted = React.useRef(true);

    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; engine.current?.stop(); }; }, []);
    React.useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);

    const start = async () => {
        if (is_running || running) return;
        setError('');
        const amount = Number(stake);
        if (!Number.isFinite(amount) || amount <= 0) { setError(localize('Stake must be greater than 0.')); return; }
        if (mode === 'live') {
            const account = getAccountContext();
            if (!account.kind) { setError(localize('Log in first: Live mode needs an authorized account.')); return; }
        }
        const instance = new RepeatMatchesEngine({ symbol, stake: amount, mode, currency: getAccountContext().currency }, createDerivApi(), {
            onTick: info => { if (!mounted.current) return; setLastDigit(info.digit); setOpen(info.open); setPlaced(info.placed); setSkipped(info.skipped); },
            onError: message => mounted.current && setError(message),
            onStop: () => mounted.current && setRunning(false),
        });
        engine.current = instance;
        try { await instance.start(); if (mounted.current) setRunning(true); }
        catch (e) { if (mounted.current) { setError(e.message || String(e)); setRunning(false); } }
    };
    const stop = async () => { await engine.current?.stop(); setRunning(false); };
    const close = () => { if (!running) onClose(); };

    return <Dialog portal_element_id='modal_root' title={localize('Repeat Matches')} is_visible={isOpen} onCancel={close} has_close_icon>
        <div className='repeat-matches-modal'>
            <p className='repeat-matches-modal__intro'>{localize('On every tick, buy a one-tick Matches contract using that tick’s last digit. Contracts continue independently and are capped at five open slots.')}</p>
            <div className='repeat-matches-modal__fields'>
                <label>{localize('Market')}<select value={symbol} disabled={running} onChange={e => setSymbol(e.target.value)}>{MARKETS.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
                <label>{localize('Stake')}<input type='number' min='0.35' step='0.01' value={stake} disabled={running} onChange={e => setStake(e.target.value)} /></label>
                <label>{localize('Mode')}<select value={mode} disabled={running} onChange={e => setMode(e.target.value)}><option value='paper'>{localize('Paper')}</option><option value='live'>{localize('Live')}</option></select></label>
            </div>
            <div className='repeat-matches-modal__status' data-testid='dt_repeat_matches_status'>
                <span>{localize('Last digit')}: <strong>{lastDigit ?? '—'}</strong></span>
                <span>{localize('Open')}: <strong>{open}/{MAX_REPEAT_MATCHES_CONTRACTS}</strong></span>
                <span>{localize('Placed')}: <strong>{placed}</strong></span>
                <span>{localize('Skipped at cap')}: <strong>{skipped}</strong></span>
            </div>
            {mode === 'paper' && <p className='repeat-matches-modal__hint'>{localize('Paper mode shows simulated placements and sends no buy orders. Choose Live to place real contracts.')}</p>}
            {mode === 'live' && <p className='repeat-matches-modal__warning'>{localize('Live mode places real contracts on every tick. Losses are possible.')}</p>}
            {error && <p className='repeat-matches-modal__error' role='alert'>{error}</p>}
            <div className='repeat-matches-modal__actions'>
                {!running ? <button type='button' onClick={start} disabled={is_running}>{localize('Start')}</button> : <button type='button' onClick={stop}>{localize('Stop')}</button>}
                <button type='button' onClick={close} disabled={running}>{localize('Close')}</button>
            </div>
        </div>
    </Dialog>;
}
