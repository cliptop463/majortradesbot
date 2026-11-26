// @ts-nocheck — window/store globals follow the other bot-builder modals
import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { volatilityName } from '@/utils/digit-scanner/matches-differs';
import { DEFAULT_CONFIG, MARKETS, QUICK_ROUNDS, TRADE_ANYWAY_MS, applyRiskPreset, loadConfig, quickConfig, saveConfig, validateConfig, worstCaseCost } from '@/utils/bulk-strategy/config';
import { toCsv } from '@/utils/bulk-strategy/csv';
import { createDerivApi, getAccountContext } from '@/utils/bulk-strategy/deriv-api';
import { BulkEngine } from '@/utils/bulk-strategy/engine';
import { getStrategy, listStrategies } from '@/utils/bulk-strategy/strategies';
import { bestQualifiedMarket, MIN_MARKET_SCORE, rankMarkets, scoreMarket, SCAN_HISTORY_SIZE } from '@/utils/bulk-strategy/market-scanner';
import type { ScanStrategyId, MarketScanResult } from '@/utils/bulk-strategy/market-scanner';
import type { AccountKind, BulkConfig, EngineStatus, RoundLog, Risk, RunMode, Summary } from '@/utils/bulk-strategy/types';
import './bulk-strategy-modal.scss';

type Props = {
    isOpen: boolean;
    onClose: () => void;
    is_running: boolean;
    onRunningChange?: (running: boolean) => void;
    initialStrategyId?: string | null;
};

type RunState = 'idle' | 'starting' | 'running' | 'stopping';

type NumberText = {
    stake: string;
    profitTarget: string;
    maxLoss: string;
    bulkSize: string;
    matchesTickCount: string;
    multiplier: string;
    maxSteps: string;
};

const SCANNER_STRATEGY_MAP: Record<string, ScanStrategyId> = {
    'tick-striker': 'tick-striker',
    'tick-striker-v4': 'tick-striker-v4',
    'nexus-rise-fall': 'nexus-rise-fall',
    'nexus-even-odd': 'nexus-even-odd',
};

export const scannerStrategyForUi = (
    strategyId: string
): ScanStrategyId | null => SCANNER_STRATEGY_MAP[strategyId] ?? null;

const parse = (text: string) => text.trim() === '' ? NaN : Number(text);

const toText = (c: BulkConfig): NumberText => ({
    stake: String(c.stake),
    profitTarget: String(c.profitTarget),
    maxLoss: String(c.maxLoss),
    bulkSize: String(c.bulkSize),
    matchesTickCount: String(c.matchesTickCount),
    multiplier: String(c.martingale.multiplier),
    maxSteps: String(c.martingale.maxSteps),
});

const money = (x: number) => Number.isFinite(x) ? x.toFixed(2) : '–';

const downloadCsv = (logs: RoundLog[]) => {
    try {
        const blob = new Blob([toCsv(logs)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = `bulk-strategy-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    } catch {
        /* browser download unavailable */
    }
};

const scoreText = (score: number | null) =>
    score === null ? '–' : score.toFixed(3);

const BulkStrategyModal: React.FC<Props> = ({
    isOpen,
    onClose,
    is_running,
    onRunningChange,
    initialStrategyId,
}) => {
    const [base, setBase] = React.useState<BulkConfig>(() => loadConfig());
    const [text, setText] = React.useState<NumberText>(() => toText(loadConfig()));
    const [saved, setSaved] = React.useState(false);
    const [runState, setRunState] = React.useState<RunState>('idle');
    const [engineStatus, setEngineStatus] = React.useState<EngineStatus>('idle');
    const [logs, setLogs] = React.useState<RoundLog[]>([]);
    const [summary, setSummary] = React.useState<Summary | null>(null);
    const [tickInfo, setTickInfo] = React.useState<any>(null);
    const [errorMsg, setErrorMsg] = React.useState('');
    const [realConfirmOpen, setRealConfirmOpen] = React.useState(false);
    const [realAck, setRealAck] = React.useState(false);
    const [accountKind, setAccountKind] = React.useState<AccountKind | null>(null);
    const [showSettings, setShowSettings] = React.useState(false);
    const [quickSymbol, setQuickSymbol] = React.useState(() => loadConfig().symbol);
    const [runningConfig, setRunningConfig] = React.useState<BulkConfig | null>(null);

    // Scanner state is independent of the trading engine.
    const [isScanning, setIsScanning] = React.useState(false);
    const [scanProgress, setScanProgress] = React.useState(0);
    const [scanResults, setScanResults] = React.useState<MarketScanResult[]>([]);
    const [scanMessage, setScanMessage] = React.useState('');
    const [scanStrategyId, setScanStrategyId] = React.useState<string | null>(null);

    const engine = React.useRef<BulkEngine | null>(null);
    const mounted = React.useRef(true);
    const scanGeneration = React.useRef(0);
    const startLock = React.useRef(false);

    const config: BulkConfig = React.useMemo(() => ({
        ...base,
        stake: parse(text.stake),
        profitTarget: parse(text.profitTarget),
        maxLoss: parse(text.maxLoss),
        bulkSize: parse(text.bulkSize),
        matchesTickCount: parse(text.matchesTickCount),
        martingale: {
            ...base.martingale,
            multiplier: parse(text.multiplier),
            maxSteps: parse(text.maxSteps),
        },
    }), [base, text]);

    const problems = React.useMemo(() => validateConfig(config), [config]);

    const worstCase =
        problems.length === 0 || Number.isFinite(config.stake)
            ? worstCaseCost(config)
            : NaN;

    const isActive = runState !== 'idle';
    const locked = isActive;

    const scanStrategy = scannerStrategyForUi(base.strategyId);

    const resultsMatchStrategy =
        scanStrategy !== null &&
        scanStrategyId === base.strategyId &&
        scanResults.every(row => row.strategy === scanStrategy);

    const selectedScanResult = resultsMatchStrategy
        ? scanResults.find(row => row.symbol === base.symbol)
        : null;

    React.useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
            scanGeneration.current++;
            void engine.current?.stop('Page closed');
        };
    }, []);

    React.useEffect(() => {
        onRunningChange?.(runState === 'running' || runState === 'starting');
    }, [runState]);

    React.useEffect(() => {
        if (isOpen) setAccountKind(getAccountContext().kind);
    }, [isOpen]);

    React.useEffect(() => {
        if (!isOpen || !initialStrategyId || !getStrategy(initialStrategyId)) return;

        scanGeneration.current++;
        setScanResults([]);
        setScanStrategyId(null);
        setScanMessage('');

        setBase(current => ({
            ...current,
            strategyId: initialStrategyId,
        }));

        setShowSettings(true);
        setSaved(false);
    }, [isOpen, initialStrategyId]);

    const touch = () => setSaved(false);

    const patch = (changes: Partial<BulkConfig>) => {
        setBase(current => ({ ...current, ...changes }));
        touch();
    };

    const changeStrategy = (strategyId: string) => {
        scanGeneration.current++;
        setScanResults([]);
        setScanStrategyId(null);
        setScanMessage('');
        setScanProgress(0);

        patch({ strategyId });
    };

    const setField =
        (key: keyof NumberText) =>
        (event: React.ChangeEvent<HTMLInputElement>) => {
            setText(current => ({
                ...current,
                [key]: event.target.value,
            }));
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
            setRealConfirmOpen(true);
        }
    };

    const confirmReal = () => {
        if (!realAck) {
            setErrorMsg(localize('Tick the acknowledgment box before enabling Live trading.'));
            return;
        }

        patch({ account: 'real' });
        setRealConfirmOpen(false);
    };

    const handleSave = () =>
        saveConfig(config)
            ? setSaved(true)
            : setErrorMsg(localize('Settings could not be saved in this browser.'));

    // ============================================================
    // MARKET SCANNER
    // Scanner is an independent tool.
    // It only ranks and displays market information.
    // It does not control whether the strategy can start.
    // ============================================================

    const scanMarkets = async () => {
        const scannerId = scannerStrategyForUi(base.strategyId);

        if (isScanning || isActive || is_running) return;

        if (!scannerId) {
            setScanMessage(
                localize(
                    'Market scanner does not support this strategy. Choose Tick Striker V3/V4, Nexus Rise/Fall, or Nexus Even/Odd.'
                )
            );
            return;
        }

        const generation = ++scanGeneration.current;
        const strategyIdAtStart = base.strategyId;

        setIsScanning(true);
        setScanStrategyId(strategyIdAtStart);
        setScanProgress(0);
        setScanResults([]);

        setScanMessage(
            localize('Scanning markets with strategy-specific validation…')
        );

        const api = createDerivApi();
        const results = new Array<MarketScanResult>(MARKETS.length);

        let cursor = 0;
        let completed = 0;

        const worker = async () => {
            while (true) {
                const index = cursor++;

                if (
                    index >= MARKETS.length ||
                    generation !== scanGeneration.current
                ) {
                    return;
                }

                const symbol = MARKETS[index];

                try {
                    const response = await api.send({
                        ticks_history: symbol,
                        adjust_start_time: 1,
                        count: SCAN_HISTORY_SIZE,
                        end: 'latest',
                        style: 'ticks',
                    });

                    if (response?.error) {
                        throw new Error(
                            response.error.message ||
                            response.error.code ||
                            'Deriv returned an error.'
                        );
                    }

                    const rawPrices = response?.history?.prices;

                    if (!Array.isArray(rawPrices)) {
                        throw new Error(
                            'History response did not contain prices.'
                        );
                    }

                    const prices = rawPrices.map(value =>
                        typeof value === 'number' ? value : Number(value)
                    );

                    const pipSizeValue =
                        response?.history?.pip_size ??
                        response?.pip_size ??
                        response?.tick?.pip_size;

                    const pipSize = Number(pipSizeValue);

                    const validPrecision =
                        Number.isInteger(pipSize) &&
                        pipSize >= 0 &&
                        pipSize <= 12;

                    const marketTicks = validPrecision
                        ? prices.map((quote, sequence) => ({
                              quote,
                              pipSize,
                              sequence,
                          }))
                        : undefined;

                    results[index] = scoreMarket(
                        symbol,
                        scannerId,
                        prices,
                        marketTicks
                    );
                } catch (error) {
                    results[index] = scoreMarket(
                        symbol,
                        scannerId,
                        [],
                        undefined
                    );

                    results[index] = {
                        ...results[index],
                        rejectionReason:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        evaluatedAtTick: 0,
                    };
                }

                completed++;

                if (
                    mounted.current &&
                    generation === scanGeneration.current
                ) {
                    setScanProgress(completed);
                }
            }
        };

        try {
            await Promise.all(
                Array.from(
                    { length: Math.min(3, MARKETS.length) },
                    () => worker()
                )
            );

            if (
                !mounted.current ||
                generation !== scanGeneration.current ||
                base.strategyId !== strategyIdAtStart
            ) {
                return;
            }

            const ranked = rankMarkets(results);

            setScanResults(ranked);

            const best = bestQualifiedMarket(ranked);

            if (best) {
                patch({ symbol: best.symbol });

                setScanMessage(
                    localize(
                        'Qualified {{market}} for {{strategy}} with score {{score}} (quality gate {{threshold}}).',
                        {
                            market: best.symbol,
                            strategy: strategyIdAtStart,
                            score: scoreText(best.score),
                            threshold: MIN_MARKET_SCORE.toFixed(2),
                        }
                    )
                );
            } else {
                setScanMessage(
                    localize('NO QUALIFIED MARKET — WAITING FOR A VALID SIGNAL')
                );
            }
        } catch (error) {
            if (
                mounted.current &&
                generation === scanGeneration.current
            ) {
                setScanMessage(
                    error instanceof Error
                        ? error.message
                        : String(error)
                );
            }
        } finally {
            if (
                mounted.current &&
                generation === scanGeneration.current
            ) {
                setIsScanning(false);
            }
        }
    };

    // ============================================================
    // START BULK STRATEGY
    // Scanner qualification is intentionally NOT used here.
    // ============================================================
    const start = async (override?: BulkConfig) => {
    // Synchronous guard: prevents duplicate starts before React state updates.
    if (startLock.current || isActive) return;

    startLock.current = true;
    setErrorMsg('');

    const runConfig: BulkConfig = override ?? config;

    // Scanner is independent of strategy execution.
    // No scanner qualification or scanning state is required.

    if (is_running) {
        setErrorMsg(
            localize(
                'Stop the Blockly bot first. Bulk Strategy will not run beside it.'
            )
        );
        startLock.current = false;
        return;
    }

    const runProblems = override
        ? validateConfig(override)
        : problems;

    if (runProblems.length) {
        setErrorMsg(runProblems[0]);
        startLock.current = false;
        return;
    }

    const context = getAccountContext();

    setAccountKind(context.kind);

    if (runConfig.mode === 'live') {
        if (!context.kind) {
            setErrorMsg(
                localize(
                    'Log in first: Live mode needs an authorized account.'
                )
            );
            startLock.current = false;
            return;
        }

        if (context.kind !== runConfig.account) {
            setErrorMsg(
                localize(
                    'You chose a {{chosen}} account but the app is logged in to a {{active}} account. Switch account in the app, then try again.',
                    {
                        chosen:
                            runConfig.account === 'real'
                                ? localize('Real')
                                : localize('Demo'),
                        active:
                            context.kind === 'real'
                                ? localize('Real')
                                : localize('Demo'),
                    }
                )
            );
            startLock.current = false;
            return;
        }
    }

    if (!override) {
        const didSave = saveConfig(runConfig);
        setSaved(didSave);

        if (!didSave) {
            setErrorMsg(
                localize(
                    'Settings could not be saved in this browser. This run will still use the current settings.'
                )
            );
        }
    }

    setRunningConfig(runConfig);
    setLogs([]);
    setSummary(null);
    setTickInfo(null);
    setRunState('starting');

    let instance: BulkEngine | null = null;

    try {
        instance = new BulkEngine(
            runConfig,
            createDerivApi(),
            {
                onStatus: status => {
                    if (mounted.current) {
                        setEngineStatus(status);
                    }
                },

                onTick: info => {
                    if (mounted.current) {
                        setTickInfo(info);
                    }
                },

                onRound: log => {
                    if (mounted.current) {
                        setLogs(current => [...current, log]);
                    }
                },

                onError: message => {
                    if (mounted.current) {
                        setErrorMsg(message);
                    }
                },

                onStop: result => {
                    if (!mounted.current) return;

                    setSummary(result);
                    setRunState('idle');
                    setEngineStatus('stopped');
                    startLock.current = false;
                },
            },
            { currency: context.currency }
        );

        engine.current = instance;

        await instance.start();

        if (mounted.current) {
            setRunState(current =>
                current === 'starting'
                    ? 'running'
                    : current
            );
        }
    } catch (error) {
        if (mounted.current) {
            setErrorMsg(
                error instanceof Error
                    ? error.message
                    : String(error)
            );

            setRunState('idle');
            setEngineStatus('stopped');
        }

        startLock.current = false;

        // Clean up any engine instance that failed during startup.
        if (instance) {
            try {
                await instance.stop('Startup failed');
            } catch {
                // Ignore secondary cleanup errors.
            }
        }

        if (engine.current === instance) {
            engine.current = null;
        }
    }
};

    const stop = async () => {
        if (!engine.current || runState === 'stopping') return;

        setRunState('stopping');

        await engine.current.stop();
    };

    const startQuick = () => start(quickConfig(quickSymbol));

    const resetToDefaults = () => {
        if (isActive) return;

        const fresh = {
            ...DEFAULT_CONFIG,
            martingale: {
                ...DEFAULT_CONFIG.martingale,
            },
        };

        scanGeneration.current++;

        setScanResults([]);
        setScanStrategyId(null);
        setScanMessage('');

        setBase(fresh);
        setText(toText(fresh));
        setRealConfirmOpen(false);
        setRealAck(false);
        setSaved(false);
        setErrorMsg('');
    };

    const isBusy =
        runState === 'running' ||
        runState === 'stopping' ||
        runState === 'starting';

    const actionLabel = isBusy
        ? runState === 'stopping'
            ? localize('Stopping…')
            : runState === 'starting'
                ? localize('Starting…')
                : localize('Stop')
        : !showSettings
            ? localize('Run quick test')
            : config.mode === 'paper'
                ? localize('Run Paper strategy')
                : localize('Run Live strategy');

    // Scanner activity does NOT disable the Run button.
    const actionDisabled =
        runState === 'starting' ||
        runState === 'stopping' ||
        (
            runState === 'idle' &&
            showSettings &&
            problems.length > 0
        );

    const handleAction = () =>
        runState === 'running'
            ? stop()
            : showSettings
                ? start()
                : startQuick();

    const strategy = getStrategy(base.strategyId);

    const statusText = (() => {
        if (runState === 'stopping') {
            return localize('Stopping…');
        }

        if (
            runState === 'starting' ||
            engineStatus === 'connecting'
        ) {
            return localize('Connecting to Deriv…');
        }

        if (engineStatus === 'trading') {
            return localize(
                'Round {{n}} running: waiting for contracts to settle…',
                { n: logs.length + 1 }
            );
        }

        if (engineStatus === 'waiting') {
            const have = tickInfo?.ticks ?? 0;

            const minimum =
                strategy?.batchSize?.(runningConfig ?? config) ??
                strategy?.minTicks ??
                0;

            if (have < minimum) {
                return localize(
                    'Collecting real ticks ({{have}}/{{minimum})…',
                    { have, minimum }
                );
            }

            return localize(
                'Waiting for a signal: {{reason}}{{timeout}}…',
                {
                    reason:
                        tickInfo?.diagnostics?.rejectionReason ??
                        localize('Model has not produced a signal yet.'),
                    timeout: runningConfig?.tradeAnywayAfterMs
                        ? localize(', or the 5 s timeout')
                        : '',
                }
            );
        }

        return '';
    })();

    const net = logs.length
        ? logs[logs.length - 1].cumulative
        : 0;

    const isRealLive =
        config.account === 'real' &&
        config.mode === 'live';

    const validationStatus = (row: MarketScanResult) =>
        row.validation.status === 'validated'
            ? localize('Validated')
            : row.validation.status === 'insufficient data'
                ? localize('Insufficient data')
                : localize('Validation failed');

    const scanState = !scanStrategy
        ? localize('Unsupported strategy — no scanner model is available.')
        : isScanning
            ? localize('Scanning')
            : !scanResults.length
                ? localize('Not scanned')
                : selectedScanResult?.qualified
                    ? localize('Qualified')
                    : selectedScanResult?.rejectionReason?.toLowerCase().includes('reversal')
                        ? localize('Reversal detected')
                        : selectedScanResult?.validation.status === 'insufficient data'
                            ? localize('Insufficient data')
                            : localize('No qualified market');

    return (
        <Dialog
            portal_element_id='modal_root'
            title={localize('Bulk Strategy')}
            is_visible={isOpen}
            cancel_button_text={isActive ? localize('Hide') : localize('Close')}
            onCancel={onClose}
            onConfirm={handleAction}
            is_mobile_full_width={false}
            has_close_icon
            className='bulk-strategy-modal'
        >
            <div className='bulk-strategy-modal__layout'>
                <div
                    className='bulk-strategy-modal__content'
                    data-testid='dt_bulk_modal'
                >
                    <section
                        className='bulk-strategy-modal__quick'
                        data-testid='dt_bulk_quick'
                    >
                        <p className='bulk-strategy-modal__quick-title'>
                            {localize('Try it in one tap')}
                        </p>

                        <p
                            className='bulk-strategy-modal__hint'
                            data-testid='dt_bulk_setup'
                        >
                            {showSettings
                                ? localize(
                                    'Choose a strategy and market, set your stake and stop limits, then start. Paper is selected by default and places no orders. Your current settings are saved automatically when you start.'
                                )
                                : localize(
                                    'The one-tap test always runs {{n}} Demo + Paper rounds and places no orders. To place Live orders, log in to a Real Deriv account, then open account and mode settings and select Real + Live.',
                                    { n: QUICK_ROUNDS }
                                )}
                        </p>

                        {!showSettings && (
                            <>
                                <label
                                    className='bulk-strategy-modal__label'
                                    htmlFor='bulk-quick-market'
                                >
                                    {localize('Market')}
                                </label>

                                <select
                                    id='bulk-quick-market'
                                    data-testid='dt_bulk_quick_market'
                                    className='bulk-strategy-modal__select'
                                    value={quickSymbol}
                                    disabled={isBusy}
                                    onChange={event =>
                                        setQuickSymbol(event.target.value)
                                    }
                                >
                                    {MARKETS.map(symbol => (
                                        <option
                                            key={symbol}
                                            value={symbol}
                                        >
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
                                disabled={isBusy}
                                onClick={() =>
                                    setShowSettings(value => !value)
                                }
                            >
                                {showSettings
                                    ? localize('Hide settings')
                                    : localize('Configure account and mode')}
                            </button>

                            {showSettings && (
                                <button
                                    type='button'
                                    className='bulk-strategy-modal__button'
                                    data-testid='dt_bulk_reset'
                                    disabled={isBusy}
                                    onClick={resetToDefaults}
                                >
                                    {localize('Reset to defaults')}
                                </button>
                            )}
                        </div>
                    </section>

                    {statusText && (
                        <p
                            className='bulk-strategy-modal__live-status'
                            data-testid='dt_bulk_status_text'
                            role='status'
                        >
                            {statusText}
                        </p>
                    )}

                    {showSettings && (
                        <>
                            <section className='bulk-strategy-modal__section'>
                                <label
                                    className='bulk-strategy-modal__label'
                                    htmlFor='bulk-strategy'
                                >
                                    {localize('Strategy')}
                                </label>

                                <select
                                    id='bulk-strategy'
                                    data-testid='dt_bulk_strategy'
                                    className='bulk-strategy-modal__select'
                                    value={base.strategyId}
                                    disabled={locked || isScanning}
                                    onChange={event =>
                                        changeStrategy(event.target.value)
                                    }
                                >
                                    {listStrategies().map(item => (
                                        <option
                                            key={item.id}
                                            value={item.id}
                                        >
                                            {item.label}
                                        </option>
                                    ))}
                                </select>

                                {strategy && (
                                    <p className='bulk-strategy-modal__hint'>
                                        {strategy.description}
                                    </p>
                                )}

                                {base.strategyId === 'last-ticks-matches' && (
                                    <label
                                        className='bulk-strategy-modal__field'
                                        htmlFor='bulk-matches-tick-count'
                                    >
                                        <span>
                                            {localize('Unique Matches per Batch')}
                                        </span>

                                        <input
                                            id='bulk-matches-tick-count'
                                            data-testid='dt_bulk_matchesTickCount'
                                            type='number'
                                            min={1}
                                            max={10}
                                            step={1}
                                            value={text.matchesTickCount}
                                            disabled={locked}
                                            onChange={setField('matchesTickCount')}
                                        />
                                    </label>
                                )}

                                <label
                                    className='bulk-strategy-modal__label'
                                    htmlFor='bulk-market'
                                >
                                    {localize('Market')}
                                </label>

                                <select
                                    id='bulk-market'
                                    data-testid='dt_bulk_market'
                                    className='bulk-strategy-modal__select'
                                    value={base.symbol}
                                    disabled={locked || isScanning}
                                    onChange={event =>
                                        patch({ symbol: event.target.value })
                                    }
                                >
                                    {MARKETS.map(symbol => (
                                        <option
                                            key={symbol}
                                            value={symbol}
                                        >
                                            {`${volatilityName(symbol)} (${symbol})`}
                                        </option>
                                    ))}
                                </select>

                                <div className='bulk-strategy-modal__actions'>
                                    <button
                                        type='button'
                                        className='bulk-strategy-modal__button'
                                        data-testid='dt_bulk_scan_markets'
                                        disabled={
                                            locked ||
                                            isScanning ||
                                            is_running ||
                                            !scanStrategy
                                        }
                                        onClick={scanMarkets}
                                    >
                                        {isScanning
                                            ? localize(
                                                'Scanning markets ({{done}}/{{total}})…',
                                                {
                                                    done: scanProgress,
                                                    total: MARKETS.length,
                                                }
                                            )
                                            : localize('Scan markets')}
                                    </button>
                                </div>

                                <p
                                    className='bulk-strategy-modal__hint'
                                    data-testid='dt_bulk_scan_supported'
                                >
                                    {scanStrategy
                                        ? localize(
                                            'Strategy-specific market quality score; 0.73 is a qualification gate, not a win probability.'
                                        )
                                        : localize(
                                            'Scanner unsupported for this strategy. Supported: Tick Striker V3/V4, Nexus Rise/Fall, Nexus Even/Odd.'
                                        )}
                                </p>

                                <p
                                    className='bulk-strategy-modal__status'
                                    data-testid='dt_bulk_scan_status'
                                    role='status'
                                >
                                    {isScanning
                                        ? localize(
                                            'Scanning {{done}}/{{total}} markets…',
                                            {
                                                done: scanProgress,
                                                total: MARKETS.length,
                                            }
                                        )
                                        : scanMessage || scanState}
                                </p>

                                {scanResults.length > 0 &&
                                    resultsMatchStrategy && (
                                        <ol
                                            className='bulk-strategy-modal__scan-results'
                                            data-testid='dt_bulk_scan_results'
                                        >
                                            {rankMarkets(scanResults).map(row => (
                                                <li
                                                    key={`${row.strategy}-${row.symbol}`}
                                                    className={
                                                        row.qualified
                                                            ? 'bulk-strategy-modal__scan-qualified'
                                                            : 'bulk-strategy-modal__scan-rejected'
                                                    }
                                                >
                                                    <button
                                                        type='button'
                                                        data-testid={`dt_bulk_scan_result_${row.symbol}`}
                                                        data-market={row.symbol}
                                                        aria-pressed={
                                                            base.symbol === row.symbol
                                                        }
                                                        disabled={
                                                            isScanning ||
                                                            !row.qualified
                                                        }
                                                        onClick={() =>
                                                            row.qualified &&
                                                            patch({ symbol: row.symbol })
                                                        }
                                                    >
                                                        <span>
                                                            {`${volatilityName(row.symbol)} (${row.symbol}) · ${row.strategy}`}
                                                        </span>

                                                        <strong>
                                                            {scoreText(row.score)}
                                                        </strong>

                                                        <small>
                                                            {localize(
                                                                'Status: {{status}} · Direction: {{direction}} · Volatility: {{volatility}}',
                                                                {
                                                                    status: row.qualified
                                                                        ? localize('Qualified')
                                                                        : validationStatus(row),
                                                                    direction: row.direction ?? '–',
                                                                    volatility: row.volatility,
                                                                }
                                                            )}
                                                        </small>

                                                        <small>
                                                            {localize(
                                                                'OOS {{rate}} · {{samples}} samples · lift {{lift}} · {{contract}}',
                                                                {
                                                                    rate:
                                                                        row.validation.outOfSampleRate === null
                                                                            ? '–'
                                                                            : `${(
                                                                                row.validation.outOfSampleRate * 100
                                                                            ).toFixed(1)}%`,
                                                                    samples:
                                                                        row.validation.outOfSampleSamples,
                                                                    lift:
                                                                        row.validation.lift === null
                                                                            ? '–'
                                                                            : row.validation.lift.toFixed(3),
                                                                    contract:
                                                                        row.contract
                                                                            ? `${row.contract.contract_type}, ${row.contract.duration}${row.contract.duration_unit}${row.contract.selected_tick ? `, selected tick ${row.contract.selected_tick}` : ''}`
                                                                            : '–',
                                                                }
                                                            )}
                                                        </small>

                                                        <small>
                                                            {localize(
                                                                'Streak UP {{up}} / DOWN {{down}} · reversals (20) {{reversals}}',
                                                                {
                                                                    up: row.currentUpStreak,
                                                                    down: row.currentDownStreak,
                                                                    reversals: row.reversalCounts[20],
                                                                }
                                                            )}
                                                        </small>

                                                        {!row.qualified && (
                                                            <small>
                                                                {row.rejectionReason ??
                                                                    validationStatus(row)}
                                                            </small>
                                                        )}
                                                    </button>
                                                </li>
                                            ))}
                                        </ol>
                                    )}
                            </section>

                            <section className='bulk-strategy-modal__section'>
                                <p className='bulk-strategy-modal__label'>
                                    {localize('Risk level')}
                                </p>

                                <div
                                    className='bulk-strategy-modal__segment'
                                    role='group'
                                    aria-label={localize('Risk level')}
                                >
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
                                            {risk === 'low'
                                                ? localize('Low')
                                                : risk === 'medium'
                                                    ? localize('Medium')
                                                    : localize('High')}
                                        </button>
                                    ))}
                                </div>

                                <p className='bulk-strategy-modal__hint'>
                                    {base.strategyId === 'last-ticks-matches'
                                        ? localize(
                                            'A risk level fills the martingale settings. The unique matches count controls the batch size.'
                                        )
                                        : localize(
                                            'A risk level only fills the bulk size and martingale below. Edit any field afterwards.'
                                        )}
                                </p>

                                <div className='bulk-strategy-modal__grid'>
                                    {[
                                        ...(base.strategyId === 'last-ticks-matches'
                                            ? []
                                            : [['bulkSize', localize('Bulk size (1–10)']]]),
                                        ['stake', localize('Stake per contract')],
                                        ['profitTarget', localize('Profit target')],
                                        ['maxLoss', localize('Max loss')],
                                    ].map(([key, label]) => (
                                        <label
                                            key={key}
                                            className='bulk-strategy-modal__field'
                                        >
                                            <span>{label}</span>

                                            <input
                                                data-testid={`dt_bulk_${key}`}
                                                type='text'
                                                inputMode={
                                                    key === 'bulkSize'
                                                        ? 'numeric'
                                                        : 'decimal'
                                                }
                                                autoComplete='off'
                                                value={text[key]}
                                                disabled={locked}
                                                onChange={setField(key)}
                                            />
                                        </label>
                                    ))}
                                </div>
                            </section>

                            <section className='bulk-strategy-modal__section'>
                                <label className='bulk-strategy-modal__check'>
                                    <input
                                        data-testid='dt_bulk_martingale'
                                        type='checkbox'
                                        checked={base.martingale.enabled}
                                        disabled={locked}
                                        onChange={event => {
                                            setBase(current => ({
                                                ...current,
                                                martingale: {
                                                    ...current.martingale,
                                                    enabled: event.target.checked,
                                                },
                                            }));
                                            touch();
                                        }}
                                    />

                                    <span>
                                        {localize(
                                            'Martingale: raise the stake after a losing round'
                                        )}
                                    </span>
                                </label>

                                {base.martingale.enabled && (
                                    <div className='bulk-strategy-modal__grid'>
                                        <label className='bulk-strategy-modal__field'>
                                            <span>{localize('Multiplier')}</span>

                                            <input
                                                data-testid='dt_bulk_multiplier'
                                                type='text'
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
                                                value={text.maxSteps}
                                                disabled={locked}
                                                onChange={setField('maxSteps')}
                                            />
                                        </label>
                                    </div>
                                )}

                                <p className='bulk-strategy-modal__hint'>
                                    {localize(
                                        'Martingale makes losses bigger. It does not change the odds of any contract.'
                                    )}
                                </p>
                            </section>

                            <section className='bulk-strategy-modal__section'>
                                <p className='bulk-strategy-modal__label'>
                                    {localize('Account')}
                                </p>

                                <div
                                    className='bulk-strategy-modal__segment'
                                    role='group'
                                    aria-label={localize('Account')}
                                >
                                    {(['demo', 'real'] as AccountKind[]).map(kind => (
                                        <button
                                            key={kind}
                                            type='button'
                                            data-testid={`dt_bulk_account_${kind}`}
                                            aria-pressed={base.account === kind}
                                            disabled={locked}
                                            className={`bulk-strategy-modal__segment-button${base.account === kind ? ' bulk-strategy-modal__segment-button--active' : ''}`}
                                            onClick={() => chooseAccount(kind)}
                                        >
                                            {kind === 'demo'
                                                ? localize('Demo')
                                                : localize('Real')}
                                        </button>
                                    ))}
                                </div>

                                <p
                                    className='bulk-strategy-modal__hint'
                                    data-testid='dt_bulk_connected_account'
                                >
                                    {accountKind
                                        ? localize(
                                            'The app is logged in to a {{kind}} account.',
                                            {
                                                kind:
                                                    accountKind === 'real'
                                                        ? localize('Real')
                                                        : localize('Demo'),
                                            }
                                        )
                                        : localize(
                                            'No logged-in account detected. Paper mode still works; Live needs a login.'
                                        )}
                                </p>

                                {realConfirmOpen && (
                                    <div
                                        className='bulk-strategy-modal__warning'
                                        data-testid='dt_bulk_real_confirm'
                                        role='alertdialog'
                                    >
                                        <p>
                                            <strong>
                                                {localize('Enable Real account trading?')}
                                            </strong>
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
                                                checked={realAck}
                                                onChange={event =>
                                                    setRealAck(event.target.checked)
                                                }
                                            />

                                            <span>
                                                {localize(
                                                    'I understand and want to use a Real account.'
                                                )}
                                            </span>
                                        </label>

                                        <div className='bulk-strategy-modal__actions'>
                                            <button
                                                type='button'
                                                className='bulk-strategy-modal__button bulk-strategy-modal__button--danger'
                                                data-testid='dt_bulk_real_enable'
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

                                <p className='bulk-strategy-modal__label'>
                                    {localize('Mode')}
                                </p>

                                <div
                                    className='bulk-strategy-modal__segment'
                                    role='group'
                                    aria-label={localize('Mode')}
                                >
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
                                            {mode === 'paper'
                                                ? localize('Paper')
                                                : localize('Live')}
                                        </button>
                                    ))}
                                </div>

                                <p className='bulk-strategy-modal__hint'>
                                    {base.mode === 'paper'
                                        ? localize(
                                            'Paper sends no buy orders. It asks Deriv for a real proposal and settles from the real tick stream.'
                                        )
                                        : localize(
                                            'Live sends real buy orders on the account the app is logged in to.'
                                        )}
                                </p>

                                <label className='bulk-strategy-modal__check'>
                                    <input
                                        data-testid='dt_bulk_trade_anyway'
                                        type='checkbox'
                                        checked={base.tradeAnywayAfterMs !== null}
                                        disabled={locked}
                                        onChange={event =>
                                            patch({
                                                tradeAnywayAfterMs: event.target.checked
                                                    ? TRADE_ANYWAY_MS
                                                    : null,
                                            })
                                        }
                                    />

                                    <span>
                                        {localize(
                                            'TESTING ONLY: force a test entry after 5 s without a signal (off by default)'
                                        )}
                                    </span>
                                </label>

                                <p className='bulk-strategy-modal__hint'>
                                    {localize(
                                        'Testing-only timeout entries are marked in the log and excluded from model win-rate statistics.'
                                    )}
                                </p>
                            </section>

                            <section
                                className='bulk-strategy-modal__section'
                                data-testid='dt_bulk_safety'
                            >
                                <p
                                    className='bulk-strategy-modal__worst'
                                    data-testid='dt_bulk_worst_case'
                                >
                                    {localize(
                                        'Worst case before the max-loss stop: {{amount}}',
                                        { amount: money(worstCase) }
                                    )}
                                </p>

                                {Number.isFinite(worstCase) &&
                                    Number.isFinite(config.maxLoss) &&
                                    worstCase > config.maxLoss && (
                                        <div
                                            className='bulk-strategy-modal__limit-help'
                                            data-testid='dt_bulk_limit_help'
                                        >
                                            <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error'>
                                                {localize(
                                                    'Run is blocked because Max loss is below the worst-case cost. Raise Max loss to at least {{amount}}, or reduce your stake, bulk size, or martingale settings.',
                                                    { amount: money(worstCase) }
                                                )}
                                            </p>

                                            <button
                                                type='button'
                                                className='bulk-strategy-modal__button'
                                                data-testid='dt_bulk_set_max_loss'
                                                disabled={locked}
                                                onClick={() =>
                                                    setText(current => ({
                                                        ...current,
                                                        maxLoss: String(worstCase),
                                                    })
                                                    )
                                                }
                                            >
                                                {localize(
                                                    'Set Max loss to {{amount}}',
                                                    { amount: money(worstCase) }
                                                )}
                                            </button>
                                        </div>
                                    )}

                                {isRealLive && (
                                    <p
                                        className='bulk-strategy-modal__message bulk-strategy-modal__message--error'
                                        data-testid='dt_bulk_real_banner'
                                    >
                                        {localize(
                                            'REAL ACCOUNT + LIVE: this will place real contracts.'
                                        )}
                                    </p>
                                )}

                                {problems.length > 0 && (
                                    <ul
                                        className='bulk-strategy-modal__problems'
                                        data-testid='dt_bulk_problems'
                                    >
                                        {problems.map(problem => (
                                            <li key={problem}>{problem}</li>
                                        ))}
                                    </ul>
                                )}

                                {is_running && (
                                    <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error'>
                                        {localize(
                                            'The Blockly bot is running. Stop it before starting Bulk Strategy.'
                                        )}
                                    </p>
                                )}
                            </section>
                        </>
                    )}

                    <div
                        className='bulk-strategy-modal__actions'
                        data-testid='dt_bulk_actions'
                    >
                        {showSettings && (
                            <button
                                type='button'
                                className='bulk-strategy-modal__button'
                                data-testid='dt_bulk_save'
                                disabled={locked}
                                onClick={handleSave}
                            >
                                {saved
                                    ? localize('Saved')
                                    : localize('Save')}
                            </button>
                        )}

                        <button
                            type='button'
                            className='bulk-strategy-modal__button bulk-strategy-modal__button--danger'
                            data-testid='dt_bulk_stop'
                            disabled={runState !== 'running'}
                            onClick={stop}
                        >
                            {localize('Stop')}
                        </button>

                        <button
                            type='button'
                            className='bulk-strategy-modal__button'
                            data-testid='dt_bulk_export'
                            disabled={!logs.length}
                            onClick={() => downloadCsv(logs)}
                        >
                            {localize('Export CSV')}
                        </button>
                    </div>

                    {errorMsg && (
                        <p
                            className='bulk-strategy-modal__message bulk-strategy-modal__message--error'
                            data-testid='dt_bulk_error'
                        >
                            {errorMsg}
                        </p>
                    )}

                    {(isActive || logs.length > 0) && (
                        <section
                            className='bulk-strategy-modal__section'
                            data-testid='dt_bulk_status'
                        >
                            <p className='bulk-strategy-modal__status'>
                                <strong>
                                    {`${config.mode === 'paper' ? localize('Paper') : localize('Live')} · ${engineStatus}`}
                                </strong>

                                {tickInfo && (
                                    <span>
                                        {` · ${tickInfo.ticksSeen} ${localize('ticks seen')} (${tickInfo.ticks} ${localize('in buffer')}) · ${localize('last')} ${tickInfo.last}${tickInfo.score !== null ? ` · score ${tickInfo.score.toFixed(2)}` : ''}`}
                                    </span>
                                )}

                                <span>
                                    {` · ${localize('rounds')} ${logs.length} · ${localize('net')} ${money(net)}`}
                                </span>
                            </p>

                            {tickInfo?.diagnostics && (
                                <details
                                    className='bulk-strategy-modal__diagnostics'
                                    data-testid='dt_bulk_diagnostics'
                                >
                                    <summary>
                                        {localize('Signal diagnostics')}
                                    </summary>

                                    <p>
                                        {localize(
                                            'Training outcomes: {{samples}} samples · {{positive}} positive · {{negative}} negative',
                                            {
                                                samples: tickInfo.diagnostics.trainingSampleCount,
                                                positive: tickInfo.diagnostics.positiveExamples,
                                                negative: tickInfo.diagnostics.negativeExamples,
                                            }
                                        )}
                                    </p>

                                    <p>
                                        {localize(
                                            'Model {{trained}} · score {{score}} · entry threshold {{threshold}}',
                                            {
                                                trained: tickInfo.diagnostics.modelTrained
                                                    ? localize('trained')
                                                    : localize('not trained'),
                                                score:
                                                    tickInfo.diagnostics.currentModelScore === null
                                                        ? '–'
                                                        : tickInfo.diagnostics.currentModelScore.toFixed(3),
                                                threshold: tickInfo.diagnostics.entryThreshold.toFixed(2),
                                            }
                                        )}
                                    </p>

                                    <p>
                                        {localize(
                                            'Uncalibrated model score, not a win probability.'
                                        )}
                                    </p>

                                    {tickInfo.diagnostics.rejectionReason && (
                                        <p
                                            data-testid='dt_bulk_rejection_reason'
                                        >
                                            {localize(
                                                'Entry rejected: {{reason}}',
                                                {
                                                    reason: tickInfo.diagnostics.rejectionReason,
                                                }
                                            )}
                                        </p>
                                    )}
                                </details>
                            )}
                        </section>
                    )}

                    <section className='bulk-strategy-modal__section'>
                        <p className='bulk-strategy-modal__label'>
                            {localize('Round log')}
                        </p>

                        <div
                            className='bulk-strategy-modal__table-wrap'
                            data-testid='dt_bulk_log'
                        >
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
                                            <td
                                                colSpan={7}
                                                className='bulk-strategy-modal__empty'
                                            >
                                                {localize('No rounds yet.')}
                                            </td>
                                        </tr>
                                    ) : (
                                        logs.map(log => (
                                            <tr
                                                key={log.round}
                                                data-testid='dt_bulk_log_row'
                                                title={log.note || undefined}
                                            >
                                                <td>{log.round}</td>

                                                <td>
                                                    {new Date(log.time).toLocaleTimeString()}
                                                </td>

                                                <td>
                                                    {log.testingOnly && (
                                                        <strong>
                                                            {localize('TEST ONLY')} ·
                                                        </strong>
                                                    )}
                                                    {log.contracts}
                                                </td>

                                                <td>{money(log.stake)}</td>

                                                <td>
                                                    {`${log.won}/${log.lost}${log.failed ? ` (${log.failed} failed)` : ''}${log.interrupted ? ` (+${log.interrupted}?)` : ''}`}
                                                </td>

                                                <td
                                                    className={
                                                        log.net < 0
                                                            ? 'bulk-strategy-modal__neg'
                                                            : 'bulk-strategy-modal__pos'
                                                    }
                                                >
                                                    {money(log.net)}
                                                </td>

                                                <td>{money(log.cumulative)}</td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    {summary && (
                        <section
                            className='bulk-strategy-modal__section'
                            data-testid='dt_bulk_summary'
                        >
                            <p className='bulk-strategy-modal__label'>
                                {localize('Summary')}
                            </p>

                            <dl className='bulk-strategy-modal__summary'>
                                <div>
                                    <dt>{localize('Rounds')}</dt>
                                    <dd data-testid='dt_bulk_sum_rounds'>
                                        {summary.rounds}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Contracts won')}</dt>
                                    <dd data-testid='dt_bulk_sum_won'>
                                        {summary.contractsWon}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Contracts lost')}</dt>
                                    <dd data-testid='dt_bulk_sum_lost'>
                                        {summary.contractsLost}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Contracts failed')}</dt>
                                    <dd data-testid='dt_bulk_sum_failed'>
                                        {summary.contractsFailed}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Win rate (per contract)')}</dt>
                                    <dd data-testid='dt_bulk_sum_winrate'>
                                        {summary.winRate === null
                                            ? '–'
                                            : `${(summary.winRate * 100).toFixed(1)}%`}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Model-triggered win rate')}</dt>
                                    <dd data-testid='dt_bulk_sum_model_winrate'>
                                        {summary.modelWinRate === null
                                            ? '–'
                                            : `${(summary.modelWinRate * 100).toFixed(1)}%`}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Net P/L')}</dt>
                                    <dd data-testid='dt_bulk_sum_net'>
                                        {money(summary.net)}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Worst losing streak')}</dt>
                                    <dd data-testid='dt_bulk_sum_streak'>
                                        {summary.worstLossStreak}
                                    </dd>
                                </div>

                                <div>
                                    <dt>{localize('Break-even win rate')}</dt>
                                    <dd data-testid='dt_bulk_sum_breakeven'>
                                        {summary.breakEvenWinRate === null
                                            ? '–'
                                            : `${(summary.breakEvenWinRate * 100).toFixed(1)}%`}
                                    </dd>
                                </div>
                            </dl>

                            {summary.contractsInterrupted > 0 && (
                                <p className='bulk-strategy-modal__message bulk-strategy-modal__message--error'>
                                    {localize(
                                        '{{n}} contract(s) were not tracked to the end. Check Reports on Deriv for their real result.',
                                        { n: summary.contractsInterrupted }
                                    )}
                                </p>
                            )}

                            <p
                                className='bulk-strategy-modal__hint'
                                data-testid='dt_bulk_sum_reason'
                            >
                                {summary.stopReason}
                            </p>
                        </section>
                    )}

                    <p
                        className='bulk-strategy-modal__disclaimer'
                        data-testid='dt_bulk_disclaimer'
                    >
                        {localize(
                            'No strategy changes the odds. Scanner scores are quality gates, not guarantees. Stop leaves contracts already bought open on Deriv. Start with Demo + Paper.'
                        )}
                    </p>
                </div>

                <div
                    className='bulk-strategy-modal__run-bar'
                    data-testid='dt_bulk_run_bar'
                >
                    <button
                        type='button'
                        className='bulk-strategy-modal__run-button'
                        data-testid='dt_bulk_run'
                        disabled={actionDisabled}
                        onClick={handleAction}
                    >
                        {actionLabel}
                    </button>
                </div>
            </div>
        </Dialog>
    );
};

export default BulkStrategyModal;
