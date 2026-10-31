// @ts-nocheck
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import DigitScannerModal from '../digit-scanner-modal';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@/external/bot-skeleton', () => ({
    ApiHelpers: {
        instance: {
            active_symbols: {
                retrieveActiveSymbols: jest.fn(),
            },
        },
    },
}));

jest.mock('@/utils/digit-scanner/scan', () => ({
    selectVolatilityMarkets: jest.fn(),
    fetchHistory: jest.fn(),
    scanMarkets: jest.fn(),
}));

jest.mock('@/utils/digit-scanner/ensemble', () => ({
    ...jest.requireActual('@/utils/digit-scanner/ensemble'),
    rankMarkets: jest.fn(),
}));

jest.mock('@/utils/blockly-scanner-pick', () => ({
    previewScannerPick: jest.fn(),
    applyScannerPick: jest.fn(),
}));

jest.mock('@deriv-com/translations', () => ({
    localize: (s: string) => s,
}));

// Minimal Dialog shim that renders children and both action buttons
jest.mock('@/components/shared_ui/dialog', () => {
    const Dialog = ({
        is_visible,
        children,
        confirm_button_text,
        onConfirm,
        is_confirm_disabled,
        cancel_button_text,
        onCancel,
    }: any) => {
        if (!is_visible) return null;
        return (
            <div data-testid='mock-dialog'>
                {children}
                {confirm_button_text && (
                    <button data-testid='dialog-confirm' onClick={onConfirm} disabled={is_confirm_disabled}>
                        {confirm_button_text}
                    </button>
                )}
                <button data-testid='dialog-cancel' onClick={onCancel}>
                    {cancel_button_text}
                </button>
            </div>
        );
    };
    return Dialog;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

import { ApiHelpers } from '@/external/bot-skeleton';
import { selectVolatilityMarkets, scanMarkets } from '@/utils/digit-scanner/scan';
import { rankMarkets } from '@/utils/digit-scanner/ensemble';
import { previewScannerPick, applyScannerPick } from '@/utils/blockly-scanner-pick';

const makeAnalysis = (overrides = {}) => ({
    symbol: 'R_100',
    displayName: 'Volatility 100 Index',
    market: 'synthetic_index',
    submarket: 'random_index',
    pipSize: 2,
    observations: 500,
    dropped: 0,
    status: 'ok',
    strategies: [
        { id: 's1', name: 'FrequencyStrategy', status: 'signal', direction: 'MATCHES', digit: 5, strength: 0.7, reason: 'digit 5 appears 12%' },
    ],
    recommendation: { direction: 'MATCHES', digit: 5, agree: 2, disagree: 1, eligible: 3, heuristicScore: 45.3 },
    ...overrides,
});

const makeRanking = (analyses = [makeAnalysis()]) => {
    const okWithRec = analyses.filter((a: any) => a.status === 'ok' && a.recommendation);
    return {
        ranked: okWithRec.map((a: any, i: number) => ({ rank: i + 1, analysis: a, recommendation: a.recommendation })),
        selected: okWithRec[0] ? { rank: 1, analysis: okWithRec[0], recommendation: okWithRec[0].recommendation } : null,
        excluded: analyses.filter((a: any) => a.status !== 'ok' || !a.recommendation),
    };
};

const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onApplied: jest.fn(),
    is_running: false,
};

const setupScanMocks = (analyses = [makeAnalysis()]) => {
    (ApiHelpers.instance.active_symbols.retrieveActiveSymbols as jest.Mock).mockResolvedValue([{}]);
    (selectVolatilityMarkets as jest.Mock).mockReturnValue({ markets: [{}], skipped: [] });
    (scanMarkets as jest.Mock).mockResolvedValue(analyses);
    (rankMarkets as jest.Mock).mockReturnValue(makeRanking(analyses));
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DigitScannerModal', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (window as any).Blockly = { derivWorkspace: {} };
        (ApiHelpers.instance.active_symbols as any).has_initialization_error = false;
    });

    it('defaults to Matches/Differs with the statistical engine and hides the strategy chips', () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} />);
        expect(screen.getByTestId('dt_digit_scanner_kind_matches_differs').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_digit_scanner_engine_statistical').getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByTestId('dt_digit_scanner_strategy_hot_cold')).toBeNull();
    });

    it('lets the user pick Even/Odd and choose which pattern strategies run', async () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} />);

        fireEvent.click(screen.getByTestId('dt_digit_scanner_kind_even_odd'));
        // Even/Odd has no statistical engine, so strategies are shown straight away, all on.
        expect(screen.queryByTestId('dt_digit_scanner_engine_statistical')).toBeNull();
        expect(screen.getByTestId('dt_digit_scanner_strategy_hot_cold').getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByTestId('dt_digit_scanner_strategies_none'));
        fireEvent.click(screen.getByTestId('dt_digit_scanner_strategy_momentum'));
        fireEvent.click(screen.getByTestId('dt_digit_scanner_strategy_cycle'));
        expect(screen.getByTestId('dt_digit_scanner_strategy_hot_cold').getAttribute('aria-pressed')).toBe('false');

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        await waitFor(() => expect(scanMarkets).toHaveBeenCalled());
        const options = (scanMarkets as jest.Mock).mock.calls[0][2];
        expect(typeof options.analyze).toBe('function');

        // The analyzer handed to the scanner only runs the two chosen strategies for Even/Odd.
        const alternating = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 2 : 3));
        const result = options.analyze(alternating);
        expect(result.strategies.map((s: { id: string }) => s.id)).toEqual(['momentum', 'cycle']);
    });

    it('refuses to scan a pattern set with no strategies selected', async () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} />);
        fireEvent.click(screen.getByTestId('dt_digit_scanner_kind_over_under'));
        fireEvent.click(screen.getByTestId('dt_digit_scanner_strategies_none'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        expect(await screen.findByTestId('dt_digit_scanner_error')).toBeTruthy();
        expect(scanMarkets).not.toHaveBeenCalled();
    });

    const feedTicks = (symbols: string[]) =>
        (scanMarkets as jest.Mock).mockImplementation(async (_m: unknown, _f: unknown, options: any) => {
            symbols.forEach((symbol, k) => {
                let seed = 42 + k * 101;
                const digits = Array.from({ length: 1000 }, () => (seed = (seed * 1664525 + 1013904223) % 4294967296) % 10);
                options.onDigits?.(symbol, digits);
            });
            return [makeAnalysis()];
        });

    const scanAndValidate = async () => {
        render(<DigitScannerModal {...defaultProps} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        await waitFor(() => expect(screen.getByTestId('dt_digit_scanner_validate')).toBeTruthy());
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_digit_scanner_validate'));
        });
        await waitFor(() => expect(screen.getByTestId('dt_digit_scanner_validation_claim')).toBeTruthy());
        return screen.getByTestId('dt_digit_scanner_validation_claim').textContent as string;
    };

    it('validates the rising-share idea on the ticks the scan just fetched, pooled across markets', async () => {
        setupScanMocks();
        feedTicks(['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V']);
        const claim = await scanAndValidate();
        expect(claim).toContain('Rising-share idea');
        expect(claim).toContain('chance');
        expect(claim).toContain('Landing exactly on tick 10');
    });

    it('says plainly when there are too few rising-share events to judge', async () => {
        setupScanMocks();
        feedTicks(['R_10']);
        const claim = await scanAndValidate();
        expect(claim).toContain('Not enough rising-share events');
    });

    it('offers the two experimental strategies but leaves them off by default', () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} />);
        fireEvent.click(screen.getByTestId('dt_digit_scanner_engine_pattern'));
        expect(screen.getByTestId('dt_digit_scanner_strategy_hot_cold').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_digit_scanner_strategy_rising_share').getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('dt_digit_scanner_strategy_hot_fade').getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(screen.getByTestId('dt_digit_scanner_strategy_rising_share'));
        expect(screen.getByTestId('dt_digit_scanner_strategy_rising_share').getAttribute('aria-pressed')).toBe('true');
    });

    it('passes the configured minimum ticks to the scanner and defaults to 200', async () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} />);
        const input = screen.getByTestId('dt_digit_scanner_min_ticks') as HTMLInputElement;
        expect(input.value).toBe('200');

        fireEvent.change(input, { target: { value: '300' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => expect(scanMarkets).toHaveBeenCalled());
        const options = (scanMarkets as jest.Mock).mock.calls[0][2];
        expect(options.minObservations).toBe(300);
        expect(options.count).toBeGreaterThanOrEqual(300);
    });

    it('rejects an invalid minimum tick value without scanning', async () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} />);
        fireEvent.change(screen.getByTestId('dt_digit_scanner_min_ticks'), { target: { value: '10' } });
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        expect(await screen.findByTestId('dt_digit_scanner_error')).toBeTruthy();
        expect(scanMarkets).not.toHaveBeenCalled();
    });

    it('renders idle state with Scan button when first opened', () => {
        render(<DigitScannerModal {...defaultProps} />);
        expect(screen.getByTestId('dt_digit_scanner_modal_content')).toBeTruthy();
        expect(screen.getByTestId('dialog-confirm')).toBeTruthy();
    });

    it('renders ranked results table after a successful scan', async () => {
        setupScanMocks();
        const { container } = render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_results')).toBeTruthy();
        });

        expect(screen.getByTestId('dt_digit_scanner_ranked_row_R_100')).toBeTruthy();
        expect(container.querySelector('.digit-scanner-modal__results-table')?.textContent).toContain(
            'Heuristic score (not a win probability)'
        );
        expect(screen.getByText(/Heuristics describe past noise only/)).toBeTruthy();
        fireEvent.click(screen.getAllByLabelText('Expand strategies')[0]);
        expect(screen.getAllByText('Matches 5').length).toBeGreaterThan(1); // ranked row + strategy row
        expect(screen.getByText('digit 5 appears 12%')).toBeTruthy();
    });

    it('renders the same ranked markets in the desktop table and mobile cards', async () => {
        const secondMarket = makeAnalysis({
            symbol: 'R_200',
            displayName: 'Volatility 200 Index',
            recommendation: { direction: 'DIFFERS', digit: 3, agree: 3, disagree: 0, eligible: 3, heuristicScore: 60 },
        });
        setupScanMocks([makeAnalysis(), secondMarket]);
        const { container } = render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_ranked_row_R_100')).toBeTruthy();
            expect(screen.getByTestId('dt_digit_scanner_ranked_card_R_100')).toBeTruthy();
        });

        const table = container.querySelector('.digit-scanner-modal__results-table');
        const cards = container.querySelector('.digit-scanner-modal__results-cards');
        expect(table?.textContent).toContain('Volatility 100 Index');
        expect(table?.textContent).toContain('Volatility 200 Index');
        expect(cards?.textContent).toContain('Volatility 100 Index');
        expect(cards?.textContent).toContain('Volatility 200 Index');
        expect(cards?.textContent).toContain('Differs 3');
        expect(container.querySelector('.digit-scanner-modal__content')).toBeTruthy();
        expect(container.querySelector('.digit-scanner-confirm-modal__content')).toBeNull();
    });

    it('uses the mobile card Select button for the existing preview and apply flow', async () => {
        setupScanMocks();
        (previewScannerPick as jest.Mock).mockReturnValue({
            ok: true,
            symbol: { before: 'R_50', after: 'R_100' },
            type: { before: 'DIGITMATCH', after: 'DIGITMATCH' },
            prediction: { before: 3, after: 5 },
        });
        (applyScannerPick as jest.Mock).mockResolvedValue({ ok: true });

        render(<DigitScannerModal {...defaultProps} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        const cardSelect = await screen.findByTestId('dt_digit_scanner_card_select_R_100');
        fireEvent.click(cardSelect);

        expect(await screen.findByTestId('dt_digit_scanner_confirm_dialog')).toBeTruthy();
        expect(applyScannerPick).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(applyScannerPick).toHaveBeenCalledTimes(1);
            expect(defaultProps.onApplied).toHaveBeenCalled();
        });
    });

    it('disables the mobile card Select button while the bot is running', async () => {
        setupScanMocks();
        render(<DigitScannerModal {...defaultProps} is_running={true} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        expect(await screen.findByTestId('dt_digit_scanner_card_select_R_100')).toBeDisabled();
    });

    it('uses scanner layout classes instead of fixed inline minimum widths', async () => {
        setupScanMocks();
        const { container } = render(<DigitScannerModal {...defaultProps} />);

        const content = screen.getByTestId('dt_digit_scanner_modal_content');
        expect(content.classList.contains('digit-scanner-modal__content')).toBe(true);
        expect(content.style.minWidth).toBe('');
        expect(container.querySelector('.digit-scanner-confirm-modal__content')).toBeNull();

        (previewScannerPick as jest.Mock).mockReturnValue({
            ok: true,
            symbol: { before: 'R_50', after: 'R_100' },
            type: { before: 'DIGITMATCH', after: 'DIGITMATCH' },
            prediction: { before: 3, after: 5 },
        });
        setupScanMocks();
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        fireEvent.click(await screen.findByTestId('dt_digit_scanner_card_select_R_100'));

        const confirmContent = await screen.findByTestId('dt_digit_scanner_confirm_dialog');
        expect(confirmContent.classList.contains('digit-scanner-confirm-modal__content')).toBe(true);
        expect(confirmContent.style.minWidth).toBe('');
    });

    it('shows excluded markets with their status reasons', async () => {
        const excluded = makeAnalysis({
            symbol: 'R_200',
            displayName: 'Volatility 200 Index',
            status: 'insufficient_data',
            recommendation: null,
            message: 'Insufficient data: 150 valid tick(s), 200 required',
        });
        setupScanMocks([makeAnalysis(), excluded]);

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByText('Insufficient data')).toBeTruthy();
            expect(screen.getByText(/Insufficient data: 150/)).toBeTruthy();
        });
    });

    it('shows skipped markets with the reason they were excluded', async () => {
        (ApiHelpers.instance.active_symbols.retrieveActiveSymbols as jest.Mock).mockResolvedValue([{}]);
        (selectVolatilityMarkets as jest.Mock).mockReturnValue({
            markets: [{}],
            skipped: [{ symbol: 'R_25', displayName: 'Volatility 25 Index', reason: 'Market closed' }],
        });
        (scanMarkets as jest.Mock).mockResolvedValue([makeAnalysis()]);
        (rankMarkets as jest.Mock).mockReturnValue(makeRanking([makeAnalysis()]));

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        expect(await screen.findByText('Market closed')).toBeTruthy();
        expect(screen.getByText('R_25')).toBeTruthy();
    });

    it('shows connection errors for individual markets in the excluded list', async () => {
        const failedMarket = makeAnalysis({
            symbol: 'R_200',
            displayName: 'Volatility 200 Index',
            status: 'error',
            recommendation: null,
            message: 'Connection error for R_200',
            strategies: [],
        });
        setupScanMocks([failedMarket]);

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        expect(await screen.findByText('Connection error for R_200')).toBeTruthy();
    });

    it('shows error message when scan throws', async () => {
        (ApiHelpers.instance.active_symbols.retrieveActiveSymbols as jest.Mock).mockResolvedValue([{}]);
        (selectVolatilityMarkets as jest.Mock).mockReturnValue({ markets: [{}], skipped: [] });
        (scanMarkets as jest.Mock).mockRejectedValue(new Error('network timeout'));

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_error')).toBeTruthy();
            expect(screen.getByText('network timeout')).toBeTruthy();
        });
    });

    it('shows a connection error when active-symbol initialization fails', async () => {
        (ApiHelpers.instance.active_symbols.retrieveActiveSymbols as jest.Mock).mockResolvedValue([]);
        (ApiHelpers.instance.active_symbols as any).has_initialization_error = true;

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        expect(await screen.findByText(/Connection error: unable to load active symbols/)).toBeTruthy();
    });

    it('opens confirm dialog with before/after preview when a row is selected', async () => {
        setupScanMocks();
        (previewScannerPick as jest.Mock).mockReturnValue({
            ok: true,
            symbol: { before: 'R_50', after: 'R_100' },
            type: { before: 'DIGITMATCH', after: 'DIGITMATCH' },
            prediction: { before: 3, after: 5 },
        });

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_ranked_row_R_100')).toBeTruthy();
        });

        fireEvent.click(screen.getByTestId('dt_digit_scanner_select_row_R_100'));

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_confirm_dialog')).toBeTruthy();
        });
        expect(applyScannerPick).not.toHaveBeenCalled();

        // Before/after preview should be visible
        expect(screen.getByText('R_50')).toBeTruthy();
        expect(screen.getByText('R_100')).toBeTruthy();
        expect(screen.getByText('3')).toBeTruthy();
        expect(screen.getByText('5')).toBeTruthy();
    });

    it('shows failure reason when previewScannerPick returns ok: false', async () => {
        setupScanMocks();
        (previewScannerPick as jest.Mock).mockReturnValue({
            ok: false,
            reason: 'Refusing scanner pick: trade type must be matchesdiffers, found CALL.',
        });

        render(<DigitScannerModal {...defaultProps} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_ranked_row_R_100')).toBeTruthy();
        });

        fireEvent.click(screen.getByTestId('dt_digit_scanner_select_row_R_100'));

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_apply_error')).toBeTruthy();
            expect(screen.getByText(/trade type must be matchesdiffers/)).toBeTruthy();
        });

        // Confirm dialog must NOT open
        expect(screen.queryByTestId('dt_digit_scanner_confirm_dialog')).toBeNull();
    });

    it('waits for Apply to bot before applying and never runs the bot', async () => {
        setupScanMocks();
        (previewScannerPick as jest.Mock).mockReturnValue({
            ok: true,
            symbol: { before: null, after: 'R_100' },
            type: { before: null, after: 'DIGITMATCH' },
            prediction: { before: null, after: 5 },
        });
        (applyScannerPick as jest.Mock).mockResolvedValue({
            ok: true,
            symbol: { before: null, after: 'R_100' },
            type: { before: null, after: 'DIGITMATCH' },
            prediction: { before: null, after: 5 },
        });

        const onApplied = jest.fn();
        const runButtonClick = jest.fn();
        (window as any).run_panel = { onRunButtonClick: runButtonClick };
        render(<DigitScannerModal {...defaultProps} onApplied={onApplied} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_ranked_row_R_100')).toBeTruthy();
        });

        fireEvent.click(screen.getByTestId('dt_digit_scanner_select_row_R_100'));

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_confirm_dialog')).toBeTruthy();
        });
        expect(applyScannerPick).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(applyScannerPick).toHaveBeenCalledTimes(1);
            expect(onApplied).toHaveBeenCalledTimes(1);
        });

        expect(runButtonClick).not.toHaveBeenCalled();
    });

    it('disables Apply and shows warning when is_running is true', async () => {
        setupScanMocks();
        (previewScannerPick as jest.Mock).mockReturnValue({
            ok: true,
            symbol: { before: null, after: 'R_100' },
            type: { before: null, after: 'DIGITMATCH' },
            prediction: { before: null, after: 5 },
        });

        const { rerender } = render(<DigitScannerModal {...defaultProps} is_running={false} />);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_ranked_row_R_100')).toBeTruthy();
        });

        fireEvent.click(screen.getByTestId('dt_digit_scanner_select_row_R_100'));

        await waitFor(() => {
            expect(screen.getByTestId('dt_digit_scanner_confirm_dialog')).toBeTruthy();
        });

        // Warning text must be visible
        rerender(<DigitScannerModal {...defaultProps} is_running={true} />);
        expect(screen.getByTestId('dt_digit_scanner_bot_running_warning')).toBeTruthy();

        // The Apply button is disabled while running.
        const confirmBtn = screen.queryByTestId('dialog-confirm');
        expect(confirmBtn).toBeDisabled();
        if (confirmBtn) fireEvent.click(confirmBtn);

        expect(applyScannerPick).not.toHaveBeenCalled();
    });
});
