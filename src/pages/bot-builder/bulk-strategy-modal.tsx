// @ts-nocheck — window/store globals follow the other bot-builder modals
import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { volatilityName } from '@/utils/digit-scanner/matches-differs';
import {
    DEFAULT_CONFIG,
    MARKETS,
    QUICK_ROUNDS,
    TRADE_ANYWAY_MS,
    applyRiskPreset,
    loadConfig,
    quickConfig,
    saveConfig,
    validateConfig,
    worstCaseCost,
} from '@/utils/bulk-strategy/config';
import { toCsv } from '@/utils/bulk-strategy/csv';
import { createDerivApi, getAccountContext } from '@/utils/bulk-strategy/deriv-api';
import { BulkEngine } from '@/utils/bulk-strategy/engine';
import { getStrategy, listStrategies } from '@/utils/bulk-strategy/strategies';
import type {
    AccountKind,
    BulkConfig,
    EngineStatus,
    RoundLog,
    Risk,
    RunMode,
    SignalDiagnostics,
    SignalEvaluationStats,
    Summary,
} from '@/utils/bulk-strategy/types';
import './bulk-strategy-modal.scss';

type Props = {
    isOpen: boolean;
    onClose: () => void;
    /** True while the Blockly bot is running: Bulk Strategy will not start beside it. */
    is_running: boolean;
    /** Lets the toolbar show a "running" marker while the engine keeps going with the panel closed. */
    onRunningChange?: (running: boolean) => void;
};

type RunState = 'idle' | 'starting' | 'running' | 'stopping';
type NumberText = { stake: string; profitTarget: string; maxLoss: string; bulkSize: string; matchesTickCount: string; multiplier: string; maxSteps: string };

const parse = (text: string) => (text.trim() === '' ? NaN : Number(text));
const toText = (c: BulkConfig): NumberText => ({
    stake: String(c.stake),
    profitTarget: String(c.profitTarget),
    maxLoss: String(c.maxLoss),
    bulkSize: String(c.bulkSize),
    matchesTickCount: String(c.matchesTickCount),
    multiplier: String(c.martingale.multiplier),
    maxSteps: String(c.martingale.maxSteps),
});

const downloadCsv = (logs: RoundLog[]) => {
    const csv = toCsv(logs);
    try {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `bulk-strategy-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    } catch {
        /* no download support: nothing to do */
    }
};

const money = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');

const BulkStrategyModal: React.FC<Props> = ({ isOpen, onClose, is_running, onRunningChange }) => {
    const [base, setBase] = React.useState<BulkConfig>(() => loadConfig());
    const [text, setText] = React.useState<NumberText>(() => toText(loadConfig()));
    const [saved, setSaved] = React.useState(false);

    const [run_state, setRunState] = React.useState<RunState>('idle');
    const [engine_status, setEngineStatus] = React.useState<EngineStatus>('idle');
    const [logs, setLogs] = React.useState<RoundLog[]>([]);
    const [summary, setSummary] = React.useState<Summary | null>(null);
    const [tick_info, setTickInfo] = React.useState<{
        last: number;
        ticks: number;
        ticksSeen: number;
        score: number | null;
        diagnostics: SignalDiagnostics | null;
        signalStats: SignalEvaluationStats;
    } | null>(null);
    const [error_msg, setErrorMsg] = React.useState('');

    const [real_confirm_open, setRealConfirmOpen] = React.useState(false);
    const [real_ack, setRealAck] = React.useState(false);
    const [account_kind, setAccountKind] = React.useState<AccountKind | null>(null);

    // The simple path comes first: settings stay hidden until asked for.
    const [show_settings, setShowSettings] = React.useState(false);
    const [quick_symbol, setQuickSymbol] = React.useState(() => loadConfig().symbol);
    const [running_config, setRunningConfig] = React.useState<BulkConfig | null>(null);

    const engine = React.useRef<BulkEngine | null>(null);
    const is_mounted = React.useRef(true);

    const config: BulkConfig = React.useMemo(
        () => ({
            ...base,
            stake: parse(text.stake),
            profitTarget: parse(text.profitTarget),
            maxLoss: parse(text.maxLoss),
            bulkSize: parse(text.bulkSize),
            matchesTickCount: parse(text.matchesTickCount),
            martingale: { ...base.martingale, multiplier: parse(text.multiplier), maxSteps: parse(text.maxSteps) },
        }),
        [base, text]
    );

    const problems = React.useMemo(() => validateConfig(config), [config]);
    const worst_case = problems.length === 0 || Number.isFinite(config.stake) ? worstCaseCost(config) : NaN;
    const worst_case_exceeds_limit =
        Number.isFinite(worst_case) && Number.isFinite(config.maxLoss) && worst_case > config.maxLoss;
    const is_active = run_state !== 'idle';
    const locked = is_active;

    React.useEffect(() => {
        is_mounted.current = true;
        return () => {
            is_mounted.current = false;
            // Leaving the page must not leave subscriptions or a running bot behind.
            engine.current?.stop('Page closed');
        };
    }, []);

    React.useEffect(() => {
        onRunningChange?.(run_state === 'running' || run_state === 'starting');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [run_state]);

    React.useEffect(() => {
        if (isOpen) setAccountKind(getAccountContext().kind);
    }, [isOpen]);

    const touch = () => setSaved(false);
    const patch = (changes: Partial<BulkConfig>) => {
        setBase(current => ({ ...current, ...changes }));
        touch();
    };
    const setField = (key: keyof NumberText) => (e: React.ChangeEvent<HTMLInputElement>) => {
        setText(current => ({ ...current, [key]: e.target.value }));
        touch();
    };

    const chooseRisk = (risk: Risk) => {
        const next = applyRiskPreset(base, risk);
        setBase(next);
        setText(current => ({
            ...current,
            bulkSize: String(next.bulkSize),
            multiplier: String(next.martingale.multiplier),
            maxSteps: String(next.martingale.maxSteps),
        }));
        touch();
    };

    const chooseAccount = (account: AccountKind) => {
        if (account === 'demo') {
            setRealConfirmOpen(false);
            setRealAck(false);
            patch({ account: 'demo' });
        } else if (base.account !== 'real') {
            setRealConfirmOpen(true); // never switched on without an explicit confirmation
        }
    };

    const confirmReal = () => {
        if (!real_ack) return;
        patch({ account: 'real' });
        setRealConfirmOpen(false);
    };

    const handleSave = () => {
        if (saveConfig(config)) setSaved(true);
        else setErrorMsg(localize('Settings could not be saved in this browser.'));
    };

    const start = async (override?: BulkConfig) => {
        if (is_active) return;
        setErrorMsg('');
        const run_config: BulkConfig = override ?? config;
        const run_problems = override ? validateConfig(override) : problems;
        if (is_running) {
            setErrorMsg(localize('Stop the Blockly bot first. Bulk Strategy will not run beside it.'));
            return;
        }
        if (run_problems.length > 0) {
            setErrorMsg(run_problems[0]);
            return;
        }
        const context = getAccountContext();
        setAccountKind(context.kind);
        if (run_config.mode === 'live') {
            if (!context.kind) {
                setErrorMsg(localize('Log in first: Live mode needs an authorized account.'));
                return;
            }
            if (context.kind !== run_config.account) {
                setErrorMsg(
                    localize('You chose a {{chosen}} account but the app is logged in to a {{active}} account. Switch account in the app, then try again.', {
                        chosen: run_config.account === 'real' ? localize('Real') : localize('Demo'),
                        active: context.kind === 'real' ? localize('Real') : localize('Demo'),
                    })
                );
                return;
            }
        }

        if (!override) {
            // The quick test never overwrites the settings you saved.
            const config_saved = saveConfig(run_config);
            setSaved(config_saved);
            if (!config_saved) {
                setErrorMsg(localize('Settings could not be saved in this browser. This run will still use the current settings.'));
            }
        }
        setRunningConfig(run_config);
        setLogs([]);
        setSummary(null);
        setTickInfo(null);
        setRunState('starting');

        const instance = new BulkEngine(
            run_config,
            createDerivApi(),
            {
                onStatus: s => is_mounted.current && setEngineStatus(s),
                onTick: info => is_mounted.current && setTickInfo(info),
                onRound: log => is_mounted.current && setLogs(current => [...current, log]),
                onError: message => is_mounted.current && setErrorMsg(message),
                onStop: result => {
                    if (!is_mounted.current) return;
                    setSummary(result);
                    setRunState('idle');
                    setEngineStatus('stopped');
                },
            },
            { currency: context.currency }
        );
        engine.current = instance;
        try {
            await instance.start();
            if (is_mounted.current) setRunState(current => (current === 'starting' ? 'running' : current));
        } catch (e) {
            if (is_mounted.current) {
                setErrorMsg(e instanceof Error ? e.message : String(e));
                setRunState('idle');
            }
        }
    };

    const stop = async () => {
        if (!engine.current || run_state === 'stopping') return;
        setRunState('stopping');
        await engine.current.stop();
    };

    const startQuick = () => start(quickConfig(quick_symbol));
    const resetToDefaults = () => {
        if (is_active) return;
        const fresh = { ...DEFAULT_CONFIG, martingale: { ...DEFAULT_CONFIG.martingale } };
        setBase(fresh);
        setText(toText(fresh));
        setRealConfirmOpen(false);
        setRealAck(false);
        setSaved(false);
        setErrorMsg('');
    };

    const is_busy = run_state === 'running' || run_state === 'stopping' || run_state === 'starting';
    const action_label = is_busy
        ? run_state === 'stopping'
            ? localize('Stopping…')
            : run_state === 'starting'
              ? localize('Starting…')
              : localize('Stop')
        : !show_settings
          ? localize('Run quick test')
          : config.mode === 'paper'
            ? localize('Run Paper strategy')
            : localize('Run Live strategy');
    // The quick test is always valid, so only the advanced path can be blocked by its settings.
    const action_disabled =
        run_state === 'starting' || run_state === 'stopping' || (run_state === 'idle' && show_settings && problems.length > 0);
    const handleAction = () => {
        if (run_state === 'running') return stop();
        return show_settings ? start() : startQuick();
    };

    const strategy = getStrategy(base.strategyId);

    // Plain words for what the engine is doing right now.
    const status_text = (() => {
        if (run_state === 'stopping') return localize('Stopping…');
        if (run_state === 'starting' || engine_status === 'connecting') return localize('Connecting to Deriv…');
        if (engine_status === 'trading') {
            return localize('Round {{n}} running: waiting for contracts to settle…', { n: logs.length + 1 });
        }
        if (engine_status === 'waiting') {
            const have = tick_info?.ticks ?? 0;
            const minTicks = strategy?.batchSize?.(running_config ?? config) ?? strategy?.minTicks ?? 0;
            if (have < minTicks) return localize('Collecting real ticks ({{have}}/{{minimum}})…', { have, minimum: minTicks });
            const reason =
                tick_info?.diagnostics?.rejectionReason ??
                localize('Model has not produced a signal yet.');
            return localize('Waiting for a signal: {{reason}}{{timeout}}…', {
                reason,
                timeout: running_config?.tradeAnywayAfterMs ? localize(', or the 5 s timeout') : '',
            });
        }
        return '';
    })();

    const net = logs.length ? logs[logs.length - 1].cumulative : 0;
    const is_real_live = config.account === 'real' && config.mode === 'live';

    return (
        <Dialog
            portal_element_id='modal_root'
            title={localize('Bulk Strategy')}
            is_visible={isOpen}
            cancel_button_text={is_active ? localize('Hide') : localize('Close')}
            onCancel={onClose}
            onConfirm={handleAction}
            is_mobile_full_width={false}
            has_close_icon
            className='bulk-strategy-modal'
        >
            <div className='bulk-strategy-modal__layout'>
                <div className='bulk-strategy-modal__content' data-testid='dt_bulk_modal'>
                    <section className='bulk-strategy-modal__quick' data-testid='dt_bulk_quick'>
                        <p className='bulk-strategy-modal__quick-title'>{localize('Try it in one tap')}</p>
                        <p className='bulk-strategy-modal__hint' data-testid='dt_bulk_setup'>
                            {show_settings
                                ? localize(
                                      'Choose a strategy and market, set your stake and stop limits, then start. Paper is selected by default and places no orders. Your current settings are saved automatically when you start.'
                                  )
                                : localize(
                                      'Runs {{n}} Paper rounds on real ticks. It places no orders and uses no money. Nothing to set up.',
                                      { n: QUICK_ROUNDS }
                                  )}
                        </p>
                        {!show_settings && (
                            <>
                                <label className='bulk-strategy-modal__label' htmlFor='bulk-quick-market'>
                                    {localize('Market')}
                                </label>
                                <select
                                    id='bulk-quick-market'
                                    data-testid='dt_bulk_quick_market'
                                    className='bulk-strategy-modal__select'
                                    value={quick_symbol}
                                    disabled={is_busy}
                                    onChange={e => setQuickSymbol(e.target.value)}
                                >
                                    {MARKETS.map(symbol => (
                                        <option key={symbol} value={symbol}>
                                            {`${volatilityName(symbol)} (${symbol})`}
                                        </option>
                                    ))}
                                </select>
                            </>
                        )}
                        <div className='bulk-strategy-modal__actions'>
                            <button
                                type='button'
                                className='bulk-strategy-modal__button'
                                data-testid='dt_bulk_toggle_settings'
                                disabled={is_busy}
                                onClick={() => setShowSettings(v => !v)}
                            >
                                {show_settings ? localize('Hide settings') : localize('Show settings')}
                            </button>
                            {show_settings && (
                                <button
                                    type='button'
                                    className='bulk-strategy-modal__button'
                                    data-testid='dt_bulk_reset'
                                    disabled={is_busy}
                                    onClick={resetToDefaults}
                                >
                                    {localize('Reset to defaults')}
                                </button>
                            )}
                        </div>
                    </section>

                    {status_text && (
                        <p className='bulk-strategy-modal__live-status' data-testid='dt_bulk_status_text' role='status'>
                            {status_text}
                        </p>
                    )}

                    {show_settings && (
                        <>
                {/* ─── Strategy and market ─── */}
                <section className='bulk-strategy-modal__section'>
                    <label className='bulk-strategy-modal__label' htmlFor='bulk-strategy'>
                        {localize('Strategy')}
                    </label>
                    <select
                        id='bulk-strategy'
                        data-testid='dt_bulk_strategy'
                        className='bulk-strategy-modal__select'
                        value={base.strategyId}
                        disabled={locked}
                        onChange={e => patch({ strategyId: e.target.value })}
                    >
                        {listStrategies().map(s => (
                            <option key={s.id} value={s.id}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                    {strategy && <p className='bulk-strategy-modal__hint'>{strategy.description}</p>}
                    {base.strategyId === 'last-ticks-matches' && (
                        <label className='bulk-strategy-modal__field' htmlFor='bulk-matches-tick-count'>
                            <span>{localize('Number of Recent Tick Digits')}</span>
                            <input
                                id='bulk-matches-tick-count'
                                data-testid='dt_bulk_matchesTickCount'
                                type='number'
                                min={1}
                                max={10}
                                step={1}
                                inputMode='numeric'
                                value={text.matchesTickCount}
                                disabled={locked}
                                onChange={setField('matchesTickCount')}
                            />
                        </label>
                    )}

                    <label className='bulk-strategy-modal__label' htmlFor='bulk-market'>
                        {localize('Market')}
                    </label>
                    <select
                        id='bulk-market'
                        data-testid='dt_bulk_market'
                        className='bulk-strategy-modal__select'
                        value={base.symbol}
                        disabled={locked}
                        onChange={e => patch({ symbol: e.target.value })}
                    >
                        {MARKETS.map(symbol => (
                            <option key={symbol} value={symbol}>
                                {`${volatilityName(symbol)} (${symbol})`}
                            </option>
                        ))}
                    </select>
                </section>

                {/* ─── Risk, sizing and limits ─── */}
                <section className='bulk-strategy-modal__section'>
                    <p className='bulk-strategy-modal__label'>{localize('Risk level')}</p>
                    <div className='bulk-strategy-modal__segment' role='group' aria-label={localize('Risk level')}>
                        {(['low', 'medium', 'high'] as Risk[]).map(risk => (
                            <button
                                key={risk}
                                type='button'
                                data-testid={`dt_bulk_risk_${risk}`}
                                aria-pressed={base.risk === risk}
                                disabled={locked}
                                className={`bulk-strategy-modal__segment-button${base.risk === risk ? ' bulk-strategy-modal__segment-button--active' : ''}`}
                                onClick={() => chooseRisk(risk)}
                            >
                                {risk === 'low' ? localize('Low') : risk === 'medium' ? localize('Medium') : localize('High')}
                            </button>
                        ))}
                    </div>
                    <p className='bulk-strategy-modal__hint'>
                        {localize('A risk level only fills the bulk size and martingale below. Edit any field afterwards.')}
                    </p>

                    <div className='bulk-strategy-modal__grid'>
                        {[
                            ['bulkSize', localize('Bulk size (1–10)')],
                            ['stake', localize('Stake per contract')],
                            ['profitTarget', localize('Profit target')],
                            ['maxLoss', localize('Max loss')],
                        ].map(([key, label]) => (
                            <label key={key} className='bulk-strategy-modal__field'>
                                <span>{label}</span>
                                <input
                                    data-testid={`dt_bulk_${key}`}
                                    type='text'
                                    inputMode={key === 'bulkSize' ? 'numeric' : 'decimal'}
                                    autoComplete='off'
                                    aria-label={label}
                                    value={text[key]}
                                    disabled={locked}
                                    onChange={setField(key)}
                                />
                            </label>
                        ))}
                    </div>
                </section>

                {/* ─── Martingale ─── */}
                <section className='bulk-strategy-modal__section'>
                    <label className='bulk-strategy-modal__check'>
                        <input
                            data-testid='dt_bulk_martingale'
                            type='checkbox'
                            checked={base.martingale.enabled}
                            disabled={locked}
                            onChange={e => {
                                setBase(current => ({ ...current, martingale: { ...current.martingale, enabled: e.target.checked } }));
                                touch();
                            }}
                        />
                        <span>{localize('Martingale: raise the stake after a losing round')}</span>
                    </label>
                    {base.martingale.enabled && (
                        <div className='bulk-strategy-modal__grid'>
                            <label className='bulk-strategy-modal__field'>
                                <span>{localize('Multiplier')}</span>
                                <input
                                    data-testid='dt_bulk_multiplier'
                                    type='text'
                                    inputMode='decimal'
                                    autoComplete='off'
                                    value={text.multiplier}
                                    disabled={locked}
                                    onChange={setField('multiplier')}
                                />
                            </label>
                            <label className='bulk-strategy-modal__field'>
                                <span>{localize('Max steps')}</span>
                                <input
                                    data-testid='dt_bulk_maxSteps'
                                    type='text'
                                    inputMode='numeric'
                                    autoComplete='off'
                                    value={text.maxSteps}
                                    disabled={locked}
                                    onChange={setField('maxSteps')}
                                />
                            </label>
                        </div>
                    )}
                    <p className='bulk-strategy-modal__hint'>
                        {localize('Martingale makes losses bigger. It does not change the odds of any contract.')}
                    </p>
                </section>

                {/* ─── Account and mode ─── */}
                <section className='bulk-strategy-modal__section'>
                    <p className='bulk-strategy-modal__label'>{localize('Account')}</p>
                    <div className='bulk-strategy-modal__segment' role='group' aria-label={localize('Account')}>
                        {(['demo', 'real'] as AccountKind[]).map(kind => (
                            <button
                                key={kind}
                                type='button'
                                data-testid={`dt_bulk_account_${kind}`}
                                aria-pressed={base.account === kind}
                                disabled={locked}
                                className={`bulk-strategy-modal__segment-button${base.account === kind ? ' bulk-strategy-modal__segment-button--active' : ''}${kind === 'real' ? ' bulk-strategy-modal__segment-button--danger' : ''}`}
                                onClick={() => chooseAccount(kind)}
                            >
                                {kind === 'demo' ? localize('Demo') : localize('Real')}
                            </button>
                        ))}
                    </div>
                    <p className='bulk-strategy-modal__hint' data-testid='dt_bulk_connected_account'>
                        {account_kind
                            ? localize('The app is logged in to a {{kind}} account.', {
                                  kind: account_kind === 'real' ? localize('Real') : localize('Demo'),
                              })
                            : localize('No logged-in account detected. Paper mode still works; Live needs a login.')}
                    </p>

                    {real_confirm_open && (
                        <div className='bulk-strategy-modal__warning' data-testid='dt_bulk_real_confirm' role='alertdialog'>
                            <p>
                                <strong>{localize('Enable Real account trading?')}</strong>
                            </p>
                            <p>
                                {localize(
                                    'In Live mode this places real contracts with real money. You can lose more than your stake across a martingale run. Test on Demo first.'
                                )}
                            </p>
                            <label className='bulk-strategy-modal__check'>
                                <input
                                    data-testid='dt_bulk_real_ack'
                                    type='checkbox'
                                    checked={real_ack}
                                    onChange={e => setRealAck(e.target.checked)}
                                />
                                <span>{localize('I understand and want to use a Real account.')}</span>
                            </label>
                            <div className='bulk-strategy-modal__actions'>
                                <button
                                    type='button'
                                    className='bulk-strategy-modal__button bulk-strategy-modal__button--danger'
                                    data-testid='dt_bulk_real_enable'
                                    disabled={!real_ack}
                                    onClick={confirmReal}
                                >
                                    {localize('Enable Real')}
                                </button>
                                <button
                                    type='button'
                                    className='bulk-strategy-modal__button'
                                    data-testid='dt_bulk_real_cancel'
                                    onClick={() => {
                                        setRealConfirmOpen(false);
                                        setRealAck(false);
                                    }}
                                >
                                    {localize('Keep Demo')}
                                </button>
                            </div>
                        </div>
                    )}

                    <p className='bulk-strategy-modal__label'>{localize('Mode')}</p>
                    <div className='bulk-strategy-modal__segment' role='group' aria-label={localize('Mode')}>
                        {(['paper', 'live'] as RunMode[]).map(mode => (
                            <button
                                key={mode}
                                type='button'
                                data-testid={`dt_bulk_mode_${mode}`}
                                aria-pressed={base.mode === mode}
                                disabled={locked}
                                className={`bulk-strategy-modal__segment-button${base.mode === mode ? ' bulk-strategy-modal__segment-button--active' : ''}`}
                                onClick={() => patch({ mode })}
                            >
                                {mode === 'paper' ? localize('Paper') : localize('Live')}
                            </button>
                        ))}
                    </div>
                    <p className='bulk-strategy-modal__hint'>
                        {base.mode === 'paper'
                            ? base.strategyId === 'last-ticks-matches'
                                ? localize('Paper sends no orders. It obtains a separate Deriv quote for every barrier and settles each contract on its next real tick.')
                                : localize('Paper sends no orders. It asks Deriv for a real quote and settles from the real tick stream. A tie for highest tick counts as a loss.')
                            : localize('Live sends real buy orders on the account the app is logged in to.')}
                    </p>

                    <label className='bulk-strategy-modal__check'>
                        <input
                            data-testid='dt_bulk_trade_anyway'
                            type='checkbox'
                            checked={base.tradeAnywayAfterMs !== null}
                            disabled={locked}
                            onChange={e => patch({ tradeAnywayAfterMs: e.target.checked ? TRADE_ANYWAY_MS : null })}
                        />
                        <span>{localize('TESTING ONLY: force a test entry after 5 s without a signal (off by default)')}</span>
                    </label>
                    <p className='bulk-strategy-modal__hint'>
                        {localize('Testing-only timeout entries are marked in the log and excluded from model win-rate statistics.')}
                    </p>
                </section>

                {/* ─── Safety ─── */}
                <section className='bulk-strategy-modal__section' data-testid='dt_bulk_safety'>
                    <p className='bulk-strategy-modal__worst' data-testid='dt_bulk_worst_case'>
                        {localize('Worst case before the max-loss stop: {{amount}}', { amount: money(worst_case) })}
                    </p>
                    {worst_case_exceeds_limit && (
                        <div className='bulk-strategy-modal__limit-help' data-testid='dt_bulk_limit_help'>
                            <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error'>
                                {localize(
                                    'Run is blocked because Max loss is below the worst-case cost. Raise Max loss to at least {{amount}}, or reduce your stake, batch size, or martingale settings.',
                                    { amount: money(worst_case) }
                                )}
                            </p>
                            <button
                                type='button'
                                className='bulk-strategy-modal__button'
                                data-testid='dt_bulk_set_max_loss'
                                disabled={locked}
                                onClick={() => {
                                    setText(current => ({ ...current, maxLoss: String(worst_case) }));
                                    touch();
                                }}
                            >
                                {localize('Set Max loss to {{amount}}', { amount: money(worst_case) })}
                            </button>
                        </div>
                    )}
                    {is_real_live && (
                        <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error' data-testid='dt_bulk_real_banner'>
                            {localize('REAL ACCOUNT + LIVE: this will place real contracts.')}
                        </p>
                    )}
                    {problems.length > 0 && (
                        <ul className='bulk-strategy-modal__problems' data-testid='dt_bulk_problems'>
                            {problems.map(problem => (
                                <li key={problem}>{problem}</li>
                            ))}
                        </ul>
                    )}
                    {is_running && (
                        <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error'>
                            {localize('The Blockly bot is running. Stop it before starting Bulk Strategy.')}
                        </p>
                    )}
                </section>

                        </>
                    )}

                {/* ─── Actions (scrolls sideways on narrow screens) ─── */}
                <div className='bulk-strategy-modal__actions' data-testid='dt_bulk_actions'>
                    {show_settings && (
                        <button type='button' className='bulk-strategy-modal__button' data-testid='dt_bulk_save' disabled={locked} onClick={handleSave}>
                            {saved ? localize('Saved') : localize('Save')}
                        </button>
                    )}
                    <button
                        type='button'
                        className='bulk-strategy-modal__button bulk-strategy-modal__button--danger'
                        data-testid='dt_bulk_stop'
                        disabled={run_state !== 'running'}
                        onClick={stop}
                    >
                        {localize('Stop')}
                    </button>
                    <button
                        type='button'
                        className='bulk-strategy-modal__button'
                        data-testid='dt_bulk_export'
                        disabled={logs.length === 0}
                        onClick={() => downloadCsv(logs)}
                    >
                        {localize('Export CSV')}
                    </button>
                </div>

                {error_msg && (
                    <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error' data-testid='dt_bulk_error'>
                        {error_msg}
                    </p>
                )}

                {/* ─── Live status ─── */}
                {(is_active || logs.length > 0) && (
                    <section className='bulk-strategy-modal__section' data-testid='dt_bulk_status'>
                        <p className='bulk-strategy-modal__status'>
                            <strong>{`${config.mode === 'paper' ? localize('Paper') : localize('Live')} · ${engine_status}`}</strong>
                            {tick_info && (
                                <span>
                                    {` · ${tick_info.ticksSeen} ${localize('ticks seen')} (${tick_info.ticks} ${localize('in buffer')}) · ${localize('last')} ${tick_info.last}`}
                                    {tick_info.score !== null && ` · score ${tick_info.score.toFixed(2)}`}
                                </span>
                            )}
                            <span>{` · ${localize('rounds')} ${logs.length} · ${localize('net')} ${money(net)}`}</span>
                        </p>
                        {tick_info?.diagnostics && (
                            <details className='bulk-strategy-modal__diagnostics' data-testid='dt_bulk_diagnostics'>
                                <summary>{localize('Signal diagnostics')}</summary>
                                <p>
                                    {localize('Training outcomes: {{samples}} samples · {{positive}} positive ({{positiveRate}}) · {{negative}} negative ({{negativeRate}})', {
                                        samples: tick_info.diagnostics.trainingSampleCount,
                                        positive: tick_info.diagnostics.positiveExamples,
                                        positiveRate:
                                            tick_info.diagnostics.positiveOutcomeRate === null
                                                ? '–'
                                                : `${(tick_info.diagnostics.positiveOutcomeRate * 100).toFixed(1)}%`,
                                        negative: tick_info.diagnostics.negativeExamples,
                                        negativeRate:
                                            tick_info.diagnostics.negativeOutcomeRate === null
                                                ? '–'
                                                : `${(tick_info.diagnostics.negativeOutcomeRate * 100).toFixed(1)}%`,
                                    })}
                                </p>
                                <p>
                                    {localize('Model {{trained}} · score {{score}} · entry threshold {{threshold}} (its own baseline)', {
                                        trained: tick_info.diagnostics.modelTrained ? localize('trained') : localize('not trained'),
                                        score:
                                            tick_info.diagnostics.currentModelScore === null
                                                ? '–'
                                                : tick_info.diagnostics.currentModelScore.toFixed(3),
                                        threshold: tick_info.diagnostics.entryThreshold.toFixed(2),
                                    })}
                                </p>
                                <p>
                                    {localize(
                                        'The score is uncalibrated, not a win probability. Entries happen when the score reaches its own baseline (about half the time), so signals appear. This does not improve the odds: in testing on random ticks, entries above the baseline won as often as any other round.'
                                    )}
                                </p>
                                <p>
                                    {localize('Evaluations {{evaluations}} · model signals {{signals}} ({{rate}}) · signal available: {{available}}', {
                                        evaluations: tick_info.signalStats.evaluations,
                                        signals: tick_info.signalStats.modelSignals,
                                        rate: `${(tick_info.signalStats.signalRate * 100).toFixed(1)}%`,
                                        available: tick_info.diagnostics.signalAvailable ? localize('yes') : localize('no'),
                                    })}
                                </p>
                                {tick_info.diagnostics.rejectionReason && (
                                    <p data-testid='dt_bulk_rejection_reason'>
                                        {localize('Entry rejected: {{reason}}', {
                                            reason: tick_info.diagnostics.rejectionReason,
                                        })}
                                    </p>
                                )}
                                {Object.keys(tick_info.signalStats.rejectionsByReason).length > 0 && (
                                    <p>
                                        {localize('Rejected evaluations: {{rejections}}', {
                                            rejections: Object.entries(tick_info.signalStats.rejectionsByReason)
                                                .map(([reason, count]) => `${reason}: ${count}`)
                                                .join(', '),
                                        })}
                                    </p>
                                )}
                            </details>
                        )}
                    </section>
                )}

                {/* ─── Round log ─── */}
                <section className='bulk-strategy-modal__section'>
                    <p className='bulk-strategy-modal__label'>{localize('Round log')}</p>
                    <div className='bulk-strategy-modal__table-wrap' data-testid='dt_bulk_log'>
                        <table className='bulk-strategy-modal__table'>
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>{localize('Time')}</th>
                                    <th>{localize('Contracts')}</th>
                                    <th>{localize('Stake')}</th>
                                    <th>{localize('Won/Lost')}</th>
                                    <th>{localize('Net')}</th>
                                    <th>{localize('Total')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className='bulk-strategy-modal__empty'>
                                            {localize('No rounds yet.')}
                                        </td>
                                    </tr>
                                ) : (
                                    logs.map(log => (
                                        <tr key={log.round} data-testid='dt_bulk_log_row' title={log.note || undefined}>
                                            <td>{log.round}</td>
                                            <td>{new Date(log.time).toLocaleTimeString()}</td>
                                            <td>
                                                {log.testingOnly && <strong>{localize('TEST ONLY')} · </strong>}
                                                {log.contracts}
                                            </td>
                                            <td>{money(log.stake)}</td>
                                            <td>{`${log.won}/${log.lost}${log.failed ? ` (${log.failed} failed)` : ''}${log.interrupted ? ` (+${log.interrupted}?)` : ''}`}</td>
                                            <td className={log.net < 0 ? 'bulk-strategy-modal__neg' : 'bulk-strategy-modal__pos'}>{money(log.net)}</td>
                                            <td>{money(log.cumulative)}</td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>

                {/* ─── Summary ─── */}
                {summary && (
                    <section className='bulk-strategy-modal__section' data-testid='dt_bulk_summary'>
                        <p className='bulk-strategy-modal__label'>{localize('Summary')}</p>
                        <dl className='bulk-strategy-modal__summary'>
                            <div><dt>{localize('Rounds')}</dt><dd data-testid='dt_bulk_sum_rounds'>{summary.rounds}</dd></div>
                            <div><dt>{localize('Contracts won')}</dt><dd data-testid='dt_bulk_sum_won'>{summary.contractsWon}</dd></div>
                            <div><dt>{localize('Contracts lost')}</dt><dd data-testid='dt_bulk_sum_lost'>{summary.contractsLost}</dd></div>
                            <div><dt>{localize('Contracts failed')}</dt><dd data-testid='dt_bulk_sum_failed'>{summary.contractsFailed}</dd></div>
                            <div>
                                <dt>{localize('Win rate (per contract)')}</dt>
                                <dd data-testid='dt_bulk_sum_winrate'>{summary.winRate === null ? '–' : `${(summary.winRate * 100).toFixed(1)}%`}</dd>
                            </div>
                            <div>
                                <dt>{localize('Model-triggered win rate (test-only entries excluded)')}</dt>
                                <dd data-testid='dt_bulk_sum_model_winrate'>
                                    {summary.modelWinRate === null ? '–' : `${(summary.modelWinRate * 100).toFixed(1)}%`}
                                </dd>
                            </div>
                            <div><dt>{localize('Net P/L')}</dt><dd data-testid='dt_bulk_sum_net'>{money(summary.net)}</dd></div>
                            <div><dt>{localize('Worst losing streak')}</dt><dd data-testid='dt_bulk_sum_streak'>{summary.worstLossStreak}</dd></div>
                            <div>
                                <dt>{localize('Break-even win rate')}</dt>
                                <dd data-testid='dt_bulk_sum_breakeven'>{summary.breakEvenWinRate === null ? '–' : `${(summary.breakEvenWinRate * 100).toFixed(1)}%`}</dd>
                            </div>
                        </dl>
                        {summary.contractsInterrupted > 0 && (
                            <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error'>
                                {localize('{{n}} contract(s) were not tracked to the end. Check Reports on Deriv for their real result.', {
                                    n: summary.contractsInterrupted,
                                })}
                            </p>
                        )}
                        <p className='bulk-strategy-modal__hint' data-testid='dt_bulk_sum_reason'>
                            {summary.stopReason}
                        </p>
                    </section>
                )}

                    <p className='bulk-strategy-modal__disclaimer' data-testid='dt_bulk_disclaimer'>
                        {localize(
                            'No strategy changes the odds. The entry filter only looks at past ticks, and martingale makes losses bigger. Stop leaves contracts already bought open on Deriv. Start on a Demo account.'
                        )}
                    </p>
                </div>
                <div className='bulk-strategy-modal__run-bar' data-testid='dt_bulk_run_bar'>
                    <button
                        type='button'
                        className='bulk-strategy-modal__run-button'
                        data-testid='dt_bulk_run'
                        disabled={action_disabled}
                        onClick={handleAction}
                    >
                        {action_label}
                    </button>
                </div>
            </div>
        </Dialog>
    );
};

export default BulkStrategyModal;
