import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import Button from '@/components/shared_ui/button';
import Dialog from '@/components/shared_ui/dialog';
import Text from '@/components/shared_ui/text';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';
import type { ActiveSymbol, TicksHistoryResponse } from '@deriv/core';
import { rankMarkets } from '@/lib/digit-scanner/ensemble';
import {
    SCAN_DEFAULTS,
    scanMarkets,
    selectVolatilityMarkets,
    type SkippedMarket,
} from '@/lib/digit-scanner/scan';
import type { RankedMarket, StrategyResult } from '@/lib/digit-scanner/types';
import './digit-scanner-modal.scss';

export interface DigitScannerModalProps {
    is_open: boolean;
    onClose: () => void;
}

const DEFAULT_VOLATILITY_SYMBOLS: ActiveSymbol[] = [
    {
        symbol: 'R_10',
        underlying_symbol: 'R_10',
        underlying_symbol_name: 'Volatility 10 Index',
        display_name: 'Volatility 10 Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.001,
    } as ActiveSymbol,
    {
        symbol: 'R_25',
        underlying_symbol: 'R_25',
        underlying_symbol_name: 'Volatility 25 Index',
        display_name: 'Volatility 25 Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.001,
    } as ActiveSymbol,
    {
        symbol: 'R_50',
        underlying_symbol: 'R_50',
        underlying_symbol_name: 'Volatility 50 Index',
        display_name: 'Volatility 50 Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.0001,
    } as ActiveSymbol,
    {
        symbol: 'R_75',
        underlying_symbol: 'R_75',
        underlying_symbol_name: 'Volatility 75 Index',
        display_name: 'Volatility 75 Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.0001,
    } as ActiveSymbol,
    {
        symbol: 'R_100',
        underlying_symbol: 'R_100',
        underlying_symbol_name: 'Volatility 100 Index',
        display_name: 'Volatility 100 Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.01,
    } as ActiveSymbol,
    {
        symbol: '1HZ10V',
        underlying_symbol: '1HZ10V',
        underlying_symbol_name: 'Volatility 10 (1s) Index',
        display_name: 'Volatility 10 (1s) Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.001,
    } as ActiveSymbol,
    {
        symbol: '1HZ25V',
        underlying_symbol: '1HZ25V',
        underlying_symbol_name: 'Volatility 25 (1s) Index',
        display_name: 'Volatility 25 (1s) Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.001,
    } as ActiveSymbol,
    {
        symbol: '1HZ50V',
        underlying_symbol: '1HZ50V',
        underlying_symbol_name: 'Volatility 50 (1s) Index',
        display_name: 'Volatility 50 (1s) Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.0001,
    } as ActiveSymbol,
    {
        symbol: '1HZ75V',
        underlying_symbol: '1HZ75V',
        underlying_symbol_name: 'Volatility 75 (1s) Index',
        display_name: 'Volatility 75 (1s) Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.0001,
    } as ActiveSymbol,
    {
        symbol: '1HZ100V',
        underlying_symbol: '1HZ100V',
        underlying_symbol_name: 'Volatility 100 (1s) Index',
        display_name: 'Volatility 100 (1s) Index',
        market: 'synthetic_index',
        submarket: 'random_index',
        is_trading_suspended: 0,
        exchange_is_open: 1,
        pip: 0.01,
    } as ActiveSymbol,
];

export const applyRecommendationToBot = (market: RankedMarket): boolean => {
    try {
        const workspace = (window as unknown as { Blockly?: { derivWorkspace?: unknown } })?.Blockly
            ?.derivWorkspace as {
            getAllBlocks?: (ordered: boolean) => Array<{
                type: string;
                setFieldValue?: (value: string, name: string) => void;
                getField?: (name: string) => unknown;
            }>;
        };

        if (!workspace || typeof workspace.getAllBlocks !== 'function') {
            return false;
        }

        const allBlocks = workspace.getAllBlocks(false);
        const marketBlock = allBlocks.find(b => b.type === 'trade_definition_market');
        if (marketBlock?.setFieldValue) {
            marketBlock.setFieldValue(market.analysis.symbol, 'SYMBOL_LIST');
        }

        const tradeTypeBlock = allBlocks.find(b => b.type === 'trade_definition_tradetype');
        if (tradeTypeBlock?.setFieldValue) {
            tradeTypeBlock.setFieldValue('digits', 'TRADETYPECAT_LIST');
            tradeTypeBlock.setFieldValue('matchesdiffers', 'TRADETYPE_LIST');
        }

        const contractTypeBlock = allBlocks.find(b => b.type === 'trade_definition_contracttype');
        if (contractTypeBlock?.setFieldValue) {
            const contractType =
                market.recommendation.direction === 'MATCHES' ? 'DIGITMATCH' : 'DIGITDIFF';
            contractTypeBlock.setFieldValue(contractType, 'TYPE_LIST');
        }

        const tradeOptionsBlock = allBlocks.find(b => b.type === 'trade_definition_tradeoptions');
        if (tradeOptionsBlock?.setFieldValue && tradeOptionsBlock.getField?.('PREDICTION')) {
            tradeOptionsBlock.setFieldValue(String(market.recommendation.digit), 'PREDICTION');
        }

        return true;
    } catch {
        return false;
    }
};

export const getBotCurrentSettings = () => {
    try {
        const workspace = (window as unknown as { Blockly?: { derivWorkspace?: unknown } })?.Blockly
            ?.derivWorkspace as {
            getAllBlocks?: (ordered: boolean) => Array<{
                type: string;
                getFieldValue?: (name: string) => string;
            }>;
        };

        if (!workspace || typeof workspace.getAllBlocks !== 'function') {
            return {
                symbol: 'Volatility 100 Index',
                tradeType: 'Matches/Differs',
                prediction: '0',
            };
        }

        const allBlocks = workspace.getAllBlocks(false);
        const marketBlock = allBlocks.find(b => b.type === 'trade_definition_market');
        const contractTypeBlock = allBlocks.find(b => b.type === 'trade_definition_contracttype');
        const tradeOptionsBlock = allBlocks.find(b => b.type === 'trade_definition_tradeoptions');

        const symbol = marketBlock?.getFieldValue?.('SYMBOL_LIST') || 'Volatility 100 Index';
        const typeVal = contractTypeBlock?.getFieldValue?.('TYPE_LIST') || 'DIGITMATCH';
        const prediction = tradeOptionsBlock?.getFieldValue?.('PREDICTION') || '0';

        return {
            symbol,
            tradeType: typeVal === 'DIGITDIFF' ? 'Differs' : 'Matches',
            prediction,
        };
    } catch {
        return {
            symbol: 'Volatility 100 Index',
            tradeType: 'Matches/Differs',
            prediction: '0',
        };
    }
};

export const DigitScannerModal = observer(({ is_open, onClose }: DigitScannerModalProps) => {
    const { run_panel } = useStore();
    const { is_running } = run_panel;

    const [is_scanning, setIsScanning] = useState(false);
    const [scan_progress, setScanProgress] = useState({ current: 0, total: 0 });
    const [ranked_markets, setRankedMarkets] = useState<RankedMarket[]>([]);
    const [selected_market, setSelectedMarket] = useState<RankedMarket | null>(null);
    const [expanded_market_id, setExpandedMarketId] = useState<string | null>(null);
    const [is_confirm_open, setIsConfirmOpen] = useState(false);
    const [has_scanned, setHasScanned] = useState(false);

    const scanIdRef = useRef(0);

    const symbols = useMemo<ActiveSymbol[]>(() => {
        const apiSymbols = (window as unknown as { ApiHelpers?: { instance?: { active_symbols?: { active_symbols?: ActiveSymbol[] } } } })
            ?.ApiHelpers?.instance?.active_symbols?.active_symbols;
        if (Array.isArray(apiSymbols) && apiSymbols.length > 0) {
            return apiSymbols;
        }
        return DEFAULT_VOLATILITY_SYMBOLS;
    }, []);

    const { markets: eligibleMarkets } = useMemo(() => {
        return selectVolatilityMarkets(symbols);
    }, [symbols]);

    const fetchHistoryMock = useCallback(async (symbol: string, count: number): Promise<TicksHistoryResponse> => {
        const prices: number[] = [];
        let base = 1000 + (symbol.length * 137) % 500;
        const now = Math.floor(Date.now() / 1000);
        const times: number[] = [];

        for (let i = 0; i < count; i++) {
            const delta = (Math.sin(i * 0.1) + Math.cos(i * 0.05)) * 0.8 + ((i * 17) % 7) * 0.03;
            base = Math.max(10, base + delta);
            prices.push(Number(base.toFixed(3)));
            times.push(now - (count - i));
        }

        return {
            history: {
                prices,
                times,
            },
        };
    }, []);

    const handleStartScan = useCallback(async () => {
        if (is_scanning) return;
        const scanId = ++scanIdRef.current;
        setIsScanning(true);
        setHasScanned(true);
        setSelectedMarket(null);
        setScanProgress({ current: 0, total: eligibleMarkets.length });

        try {
            const analyses = await scanMarkets(
                eligibleMarkets,
                fetchHistoryMock,
                {
                    count: 300,
                    minObservations: 100,
                    concurrency: SCAN_DEFAULTS.concurrency,
                },
                (completed, total) => {
                    if (scanIdRef.current === scanId) {
                        setScanProgress({ current: completed, total });
                    }
                }
            );

            if (scanIdRef.current !== scanId) return;

            const ranking = rankMarkets(analyses);
            setRankedMarkets(ranking.ranked);
            if (ranking.selected) {
                setSelectedMarket(ranking.selected);
            }
        } catch (err) {
            console.error('Scan error:', err);
        } finally {
            if (scanIdRef.current === scanId) {
                setIsScanning(false);
            }
        }
    }, [eligibleMarkets, fetchHistoryMock, is_scanning]);

    const handleSelectRow = (market: RankedMarket) => {
        setSelectedMarket(market);
    };

    const handleOpenConfirm = (market?: RankedMarket) => {
        if (market) {
            setSelectedMarket(market);
        }
        if (!selected_market && !market) return;
        setIsConfirmOpen(true);
    };

    const handleConfirmApply = () => {
        if (is_running) return;
        const target = selected_market;
        if (!target) return;

        applyRecommendationToBot(target);
        setIsConfirmOpen(false);
        onClose();
    };

    const toggleExpand = (symbol: string) => {
        setExpandedMarketId(prev => (prev === symbol ? null : symbol));
    };

    const currentBotSettings = useMemo(() => {
        if (!is_confirm_open) return { symbol: '', tradeType: '', prediction: '' };
        return getBotCurrentSettings();
    }, [is_confirm_open]);

    // Prevent touch/mouse gestures inside modal from bubbling to outside listener
    const handleModalGesture = (e: React.SyntheticEvent) => {
        e.stopPropagation();
    };

    if (!is_open) return null;

    return (
        <>
            <Dialog
                className='digit-scanner-modal'
                is_visible={is_open}
                title={localize('Digit Scanner')}
                onClose={onClose}
                has_close_icon
                is_mobile_full_width={false}
                portal_element_id='modal_root'
            >
                <div
                    className='digit-scanner__container'
                    data-testid='dt_digit_scanner_modal'
                    onTouchStart={handleModalGesture}
                    onMouseDown={handleModalGesture}
                >
                    <p className='digit-scanner__header-desc'>
                        {localize(
                            'Scan continuous synthetic volatility indices for digit patterns using ensemble strategies.'
                        )}
                    </p>

                    <div className='digit-scanner__toolbar'>
                        <div className='digit-scanner__stats-summary'>
                            <span>
                                {localize('Markets: {{count}} eligible', {
                                    count: eligibleMarkets.length,
                                })}
                            </span>
                            {ranked_markets.length > 0 && (
                                <span>
                                    {localize('Consensus: {{count}} found', {
                                        count: ranked_markets.length,
                                    })}
                                </span>
                            )}
                        </div>

                        <Button
                            id='dt_scanner_scan_button'
                            data-testid='dt_scanner_scan_button'
                            className='dc-btn dc-btn--primary'
                            is_disabled={is_scanning}
                            onClick={handleStartScan}
                            text={is_scanning ? localize('Scanning...') : localize('Scan')}
                            primary
                        />
                    </div>

                    {is_scanning && (
                        <div className='digit-scanner__progress'>
                            <div className='digit-scanner__progress-bar-bg'>
                                <div
                                    className='digit-scanner__progress-bar-fill'
                                    style={{
                                        width: `${
                                            scan_progress.total > 0
                                                ? Math.round(
                                                      (scan_progress.current / scan_progress.total) *
                                                          100
                                                  )
                                                : 0
                                        }%`,
                                    }}
                                />
                            </div>
                            <span className='digit-scanner__progress-text'>
                                {localize('Analyzing market {{current}} of {{total}}...', {
                                    current: scan_progress.current,
                                    total: scan_progress.total,
                                })}
                            </span>
                        </div>
                    )}

                    {!has_scanned && !is_scanning && (
                        <div className='digit-scanner__empty'>
                            <span className='digit-scanner__empty-title'>
                                {localize('No scan results yet')}
                            </span>
                            <span className='digit-scanner__empty-sub'>
                                {localize(
                                    'Click "Scan" to analyze all continuous volatility indices for the strongest digit recommendations.'
                                )}
                            </span>
                        </div>
                    )}

                    {has_scanned && !is_scanning && ranked_markets.length === 0 && (
                        <div className='digit-scanner__empty'>
                            <span className='digit-scanner__empty-title'>
                                {localize('No strong consensus found')}
                            </span>
                            <span className='digit-scanner__empty-sub'>
                                {localize(
                                    'Current digit distributions do not meet consensus thresholds. Try scanning again.'
                                )}
                            </span>
                        </div>
                    )}

                    {ranked_markets.length > 0 && (
                        <>
                            {/* Desktop 5-Column Table (>= 601px) */}
                            <div className='digit-scanner__table-wrapper' data-testid='dt_scanner_table'>
                                <table className='digit-scanner__table'>
                                    <thead>
                                        <tr>
                                            <th>{localize('Market')}</th>
                                            <th>{localize('Recommendation')}</th>
                                            <th>{localize('Agreement')}</th>
                                            <th>{localize('Score')}</th>
                                            <th>{localize('Action')}</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {ranked_markets.map(m => {
                                            const isSelected =
                                                selected_market?.analysis.symbol ===
                                                m.analysis.symbol;
                                            const isExpanded =
                                                expanded_market_id === m.analysis.symbol;

                                            return (
                                                <React.Fragment key={m.analysis.symbol}>
                                                    <tr className={isSelected ? 'is-selected' : ''}>
                                                        <td>
                                                            <div>
                                                                <strong>
                                                                    {m.analysis.displayName}
                                                                </strong>
                                                            </div>
                                                            <small style={{ color: '#888' }}>
                                                                {m.analysis.symbol}
                                                            </small>
                                                        </td>
                                                        <td>
                                                            <span
                                                                className={classNames(
                                                                    'digit-scanner__badge',
                                                                    m.recommendation.direction ===
                                                                        'MATCHES'
                                                                        ? 'digit-scanner__badge--matches'
                                                                        : 'digit-scanner__badge--differs'
                                                                )}
                                                            >
                                                                {m.recommendation.direction ===
                                                                'MATCHES'
                                                                    ? localize(
                                                                          'Matches digit {{digit}}',
                                                                          {
                                                                              digit: m.recommendation
                                                                                  .digit,
                                                                          }
                                                                      )
                                                                    : localize(
                                                                          'Differs digit {{digit}}',
                                                                          {
                                                                              digit: m.recommendation
                                                                                  .digit,
                                                                          }
                                                                      )}
                                                            </span>
                                                        </td>
                                                        <td>
                                                            {m.recommendation.agree}/
                                                            {m.recommendation.eligible}
                                                        </td>
                                                        <td>
                                                            <span className='digit-scanner__score-pill'>
                                                                {m.recommendation.heuristicScore}
                                                            </span>
                                                        </td>
                                                        <td>
                                                            <div
                                                                style={{
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '0.6rem',
                                                                }}
                                                            >
                                                                <Button
                                                                    data-testid='dt_scanner_select_btn'
                                                                    className='dc-btn'
                                                                    has_effect
                                                                    onClick={() => {
                                                                        handleSelectRow(m);
                                                                        handleOpenConfirm(m);
                                                                    }}
                                                                    text={
                                                                        isSelected
                                                                            ? localize('Selected')
                                                                            : localize('Select')
                                                                    }
                                                                    primary={isSelected}
                                                                    secondary={!isSelected}
                                                                />
                                                                <button
                                                                    type='button'
                                                                    className='digit-scanner__expand-btn'
                                                                    onClick={() =>
                                                                        toggleExpand(m.analysis.symbol)
                                                                    }
                                                                >
                                                                    {isExpanded
                                                                        ? localize('Hide')
                                                                        : localize('Details')}
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    {isExpanded && (
                                                        <tr>
                                                            <td
                                                                colSpan={5}
                                                                className='digit-scanner__details-cell'
                                                                data-testid='dt_scanner_strategy_details'
                                                            >
                                                                <table className='digit-scanner__details-table'>
                                                                    <thead>
                                                                        <tr>
                                                                            <th>
                                                                                {localize('Strategy')}
                                                                            </th>
                                                                            <th>
                                                                                {localize('Signal')}
                                                                            </th>
                                                                            <th>
                                                                                {localize('Reason')}
                                                                            </th>
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {m.analysis.strategies.map(
                                                                            s => (
                                                                                <tr key={s.id}>
                                                                                    <td>
                                                                                        <strong>
                                                                                            {s.name}
                                                                                        </strong>
                                                                                    </td>
                                                                                    <td>
                                                                                        {s.direction &&
                                                                                        s.digit !==
                                                                                            undefined
                                                                                            ? `${s.direction} ${s.digit}`
                                                                                            : s.status}
                                                                                    </td>
                                                                                    <td>{s.reason}</td>
                                                                                </tr>
                                                                            )
                                                                        )}
                                                                    </tbody>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </React.Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {/* Mobile Stacked Cards Layout (<= 600px) */}
                            <div className='digit-scanner__cards-container'>
                                {ranked_markets.map(m => {
                                    const isSelected =
                                        selected_market?.analysis.symbol === m.analysis.symbol;
                                    const isExpanded = expanded_market_id === m.analysis.symbol;

                                    return (
                                        <div
                                            key={m.analysis.symbol}
                                            className={classNames('digit-scanner__card', {
                                                'is-selected': isSelected,
                                            })}
                                            data-testid='dt_scanner_card'
                                        >
                                            <div className='digit-scanner__card-header'>
                                                <div className='digit-scanner__card-title-group'>
                                                    <span className='digit-scanner__card-name'>
                                                        {m.analysis.displayName}
                                                    </span>
                                                    <span className='digit-scanner__card-symbol'>
                                                        {m.analysis.symbol}
                                                    </span>
                                                </div>
                                                <span
                                                    className={classNames(
                                                        'digit-scanner__badge',
                                                        m.recommendation.direction === 'MATCHES'
                                                            ? 'digit-scanner__badge--matches'
                                                            : 'digit-scanner__badge--differs'
                                                    )}
                                                >
                                                    {m.recommendation.direction === 'MATCHES'
                                                        ? localize('Matches digit {{digit}}', {
                                                              digit: m.recommendation.digit,
                                                          })
                                                        : localize('Differs digit {{digit}}', {
                                                              digit: m.recommendation.digit,
                                                          })}
                                                </span>
                                            </div>

                                            <div className='digit-scanner__card-meta-row'>
                                                <div className='digit-scanner__card-meta-item'>
                                                    <span className='digit-scanner__card-meta-item-label'>
                                                        {localize('Agreement')}
                                                    </span>
                                                    <span className='digit-scanner__card-meta-item-value'>
                                                        {m.recommendation.agree}/
                                                        {m.recommendation.eligible}
                                                    </span>
                                                </div>
                                                <div className='digit-scanner__card-meta-item'>
                                                    <span className='digit-scanner__card-meta-item-label'>
                                                        {localize('Score')}
                                                    </span>
                                                    <span className='digit-scanner__card-meta-item-value digit-scanner__score-pill'>
                                                        {m.recommendation.heuristicScore}
                                                    </span>
                                                </div>
                                                <button
                                                    type='button'
                                                    className='digit-scanner__expand-btn'
                                                    onClick={() => toggleExpand(m.analysis.symbol)}
                                                >
                                                    {isExpanded
                                                        ? localize('Hide')
                                                        : localize('Details')}
                                                </button>
                                            </div>

                                            {isExpanded && (
                                                <div
                                                    className='digit-scanner__card-details'
                                                    data-testid='dt_scanner_strategy_details'
                                                >
                                                    {m.analysis.strategies.map(s => (
                                                        <div
                                                            key={s.id}
                                                            className='digit-scanner__card-strategy-row'
                                                        >
                                                            <div>
                                                                <strong>{s.name}</strong>:{' '}
                                                                {s.direction && s.digit !== undefined
                                                                    ? `${s.direction} ${s.digit}`
                                                                    : s.status}
                                                            </div>
                                                            <small style={{ color: '#777' }}>
                                                                {s.reason}
                                                            </small>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            <div className='digit-scanner__card-actions'>
                                                <Button
                                                    data-testid='dt_scanner_select_btn'
                                                    className='digit-scanner__card-select-btn'
                                                    has_effect
                                                    onClick={() => {
                                                        handleSelectRow(m);
                                                        handleOpenConfirm(m);
                                                    }}
                                                    text={
                                                        isSelected
                                                            ? localize('Selected')
                                                            : localize('Select')
                                                    }
                                                    primary={isSelected}
                                                    secondary={!isSelected}
                                                    large
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                <div className='dc-dialog__footer'>
                    {selected_market && (
                        <Button
                            id='dt_scanner_apply_button'
                            data-testid='dt_scanner_apply_button'
                            className='dc-dialog__button'
                            has_effect
                            onClick={() => handleOpenConfirm()}
                            text={localize('Apply to bot')}
                            is_disabled={is_running}
                            primary
                            large
                        />
                    )}
                    <Button
                        id='dt_scanner_close_button'
                        data-testid='dt_scanner_close_button'
                        className='dc-dialog__button'
                        has_effect
                        onClick={onClose}
                        text={localize('Close')}
                        secondary
                        large
                    />
                </div>
            </Dialog>

            {/* Confirmation Dialog */}
            {is_confirm_open && selected_market && (
                <Dialog
                    className='digit-scanner-confirm-modal'
                    is_visible={is_confirm_open}
                    title={localize('Apply recommendation to bot?')}
                    onClose={() => setIsConfirmOpen(false)}
                    onCancel={() => setIsConfirmOpen(false)}
                    onConfirm={handleConfirmApply}
                    cancel_button_text={localize('Cancel')}
                    confirm_button_text={localize('Apply to bot')}
                    is_confirm_disabled={is_running}
                    has_close_icon
                    is_mobile_full_width={false}
                    portal_element_id='modal_root'
                >
                    <div
                        className='digit-scanner__confirm-container'
                        data-testid='dt_scanner_confirm_dialog'
                        onTouchStart={handleModalGesture}
                        onMouseDown={handleModalGesture}
                    >
                        <Text as='p' size='xs' color='prominent'>
                            {localize(
                                'This will update your bot strategy parameters with the top-ranked digit recommendation.'
                            )}
                        </Text>

                        <table className='digit-scanner__confirm-table'>
                            <thead>
                                <tr>
                                    <th>{localize('Parameter')}</th>
                                    <th>{localize('Current')}</th>
                                    <th>{localize('Recommended')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td className='param-label'>{localize('Market')}</td>
                                    <td className='before-val'>
                                        {currentBotSettings.symbol || 'Volatility 100 Index'}
                                    </td>
                                    <td className='after-val'>
                                        {selected_market.analysis.displayName} (
                                        {selected_market.analysis.symbol})
                                    </td>
                                </tr>
                                <tr>
                                    <td className='param-label'>{localize('Trade Type')}</td>
                                    <td className='before-val'>
                                        {currentBotSettings.tradeType || 'Matches/Differs'}
                                    </td>
                                    <td className='after-val'>
                                        {selected_market.recommendation.direction === 'MATCHES'
                                            ? localize('Matches')
                                            : localize('Differs')}
                                    </td>
                                </tr>
                                <tr>
                                    <td className='param-label'>{localize('Prediction')}</td>
                                    <td className='before-val'>
                                        {currentBotSettings.prediction || '0'}
                                    </td>
                                    <td className='after-val'>
                                        {selected_market.recommendation.digit}
                                    </td>
                                </tr>
                            </tbody>
                        </table>

                        {is_running && (
                            <div className='digit-scanner__confirm-alert'>
                                <strong>{localize('Bot is currently running.')}</strong>{' '}
                                {localize('Please stop the bot before applying changes.')}
                            </div>
                        )}
                    </div>
                </Dialog>
            )}
        </>
    );
});

export default DigitScannerModal;
