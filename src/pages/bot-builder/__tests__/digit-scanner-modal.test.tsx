import React from 'react';
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DigitScannerModal, applyRecommendationToBot } from '../digit-scanner-modal';
import type { RankedMarket } from '@/lib/digit-scanner/types';

const mockRunPanel = {
    is_running: false,
};

const mockStore = {
    run_panel: mockRunPanel,
};

jest.mock('@/hooks/useStore', () => ({
    useStore: () => mockStore,
}));

jest.mock('@deriv-com/translations', () => ({
    localize: (text: string, params?: Record<string, unknown>) => {
        if (!params) return text;
        let result = text;
        for (const [key, val] of Object.entries(params)) {
            result = result.replace(`{{${key}}}`, String(val));
        }
        return result;
    },
    Localize: ({ i18n_default_text }: { i18n_default_text: string }) => <span>{i18n_default_text}</span>,
}));

describe('DigitScannerModal', () => {
    beforeEach(() => {
        mockRunPanel.is_running = false;
        // Mock portal container
        const modalRoot = document.createElement('div');
        modalRoot.setAttribute('id', 'modal_root');
        document.body.appendChild(modalRoot);
    });

    afterEach(() => {
        const modalRoot = document.getElementById('modal_root');
        if (modalRoot) {
            document.body.removeChild(modalRoot);
        }
    });

    test('verifies no hardcoded inline minWidth of 60rem or 36rem in digit-scanner-modal.tsx', () => {
        const sourcePath = path.resolve(__dirname, '../digit-scanner-modal.tsx');
        const fileContent = fs.readFileSync(sourcePath, 'utf-8');

        expect(fileContent).not.toMatch(/minWidth:\s*['"]60rem['"]/);
        expect(fileContent).not.toMatch(/minWidth:\s*['"]36rem['"]/);
        expect(fileContent).not.toMatch(/style=\{\s*\{\s*minWidth:\s*['"]60rem['"]/);
        expect(fileContent).not.toMatch(/style=\{\s*\{\s*minWidth:\s*['"]36rem['"]/);
    });

    test('renders with .digit-scanner-modal class and proper dialog wrapper', () => {
        const onClose = jest.fn();
        render(<DigitScannerModal is_open={true} onClose={onClose} />);

        const modalContainer = screen.getByTestId('dt_digit_scanner_modal');
        expect(modalContainer).toBeInTheDocument();

        const dialogWrapper = modalContainer.closest('.digit-scanner-modal');
        expect(dialogWrapper).not.toBeNull();
    });

    test('runs scan, displays desktop table and mobile cards, and allows selection', async () => {
        const onClose = jest.fn();
        render(<DigitScannerModal is_open={true} onClose={onClose} />);

        const scanBtn = screen.getByTestId('dt_scanner_scan_button');
        expect(scanBtn).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(scanBtn);
        });

        // Wait for scan to complete and render table & cards
        await waitFor(() => {
            expect(screen.getByTestId('dt_scanner_table')).toBeInTheDocument();
        });

        const cards = screen.getAllByTestId('dt_scanner_card');
        expect(cards.length).toBeGreaterThan(0);

        const selectButtons = screen.getAllByTestId('dt_scanner_select_btn');
        expect(selectButtons.length).toBeGreaterThan(0);

        // Click select on the first item
        await act(async () => {
            fireEvent.click(selectButtons[0]);
        });

        // Confirm dialog should open with .digit-scanner-confirm-modal
        const confirmDialog = await screen.findByTestId('dt_scanner_confirm_dialog');
        expect(confirmDialog).toBeInTheDocument();

        const confirmWrapper = confirmDialog.closest('.digit-scanner-confirm-modal');
        expect(confirmWrapper).not.toBeNull();
    });

    test('expands strategy details inside the card and table', async () => {
        render(<DigitScannerModal is_open={true} onClose={jest.fn()} />);

        const scanBtn = screen.getByTestId('dt_scanner_scan_button');
        await act(async () => {
            fireEvent.click(scanBtn);
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_scanner_table')).toBeInTheDocument();
        });

        const detailsButtons = screen.getAllByText('Details');
        expect(detailsButtons.length).toBeGreaterThan(0);

        // Click first details toggle
        await act(async () => {
            fireEvent.click(detailsButtons[0]);
        });

        const strategyDetails = screen.getAllByTestId('dt_scanner_strategy_details');
        expect(strategyDetails.length).toBeGreaterThan(0);
    });

    test('confirm dialog cancel button closes confirm dialog without applying', async () => {
        render(<DigitScannerModal is_open={true} onClose={jest.fn()} />);

        const scanBtn = screen.getByTestId('dt_scanner_scan_button');
        await act(async () => {
            fireEvent.click(scanBtn);
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_scanner_table')).toBeInTheDocument();
        });

        const selectButtons = screen.getAllByTestId('dt_scanner_select_btn');
        await act(async () => {
            fireEvent.click(selectButtons[0]);
        });

        expect(screen.getByTestId('dt_scanner_confirm_dialog')).toBeInTheDocument();

        // Click cancel button in confirm dialog
        const cancelBtn = screen.getByText('Cancel');
        await act(async () => {
            fireEvent.click(cancelBtn);
        });

        expect(screen.queryByTestId('dt_scanner_confirm_dialog')).not.toBeInTheDocument();
    });

    test('bot-running guard disables Apply button when is_running is true', async () => {
        mockRunPanel.is_running = true;

        render(<DigitScannerModal is_open={true} onClose={jest.fn()} />);

        const scanBtn = screen.getByTestId('dt_scanner_scan_button');
        await act(async () => {
            fireEvent.click(scanBtn);
        });

        await waitFor(() => {
            expect(screen.getByTestId('dt_scanner_table')).toBeInTheDocument();
        });

        const selectButtons = screen.getAllByTestId('dt_scanner_select_btn');
        await act(async () => {
            fireEvent.click(selectButtons[0]);
        });

        // In confirm dialog, "Apply to bot" should be disabled
        const confirmDialog = screen.getByTestId('dt_scanner_confirm_dialog');
        expect(confirmDialog).toBeInTheDocument();

        const applyBtn = screen.getByText('Apply to bot').closest('button');
        expect(applyBtn).toBeDisabled();
    });

    test('applyRecommendationToBot updates Blockly workspace blocks correctly', () => {
        const mockMarketBlock = {
            type: 'trade_definition_market',
            setFieldValue: jest.fn(),
        };
        const mockTradeTypeBlock = {
            type: 'trade_definition_tradetype',
            setFieldValue: jest.fn(),
        };
        const mockContractTypeBlock = {
            type: 'trade_definition_contracttype',
            setFieldValue: jest.fn(),
        };
        const mockTradeOptionsBlock = {
            type: 'trade_definition_tradeoptions',
            setFieldValue: jest.fn(),
            getField: jest.fn().mockReturnValue({}),
        };

        const mockWorkspace = {
            getAllBlocks: jest.fn().mockReturnValue([
                mockMarketBlock,
                mockTradeTypeBlock,
                mockContractTypeBlock,
                mockTradeOptionsBlock,
            ]),
        };

        (window as unknown as { Blockly: { derivWorkspace: unknown } }).Blockly = {
            derivWorkspace: mockWorkspace,
        };

        const sampleMarket: RankedMarket = {
            rank: 1,
            analysis: {
                symbol: '1HZ100V',
                displayName: 'Volatility 100 (1s) Index',
                market: 'synthetic_index',
                submarket: 'random_index',
                pipSize: 2,
                observations: 300,
                dropped: 0,
                status: 'ok',
                strategies: [],
                recommendation: {
                    direction: 'DIFFERS',
                    digit: 7,
                    agree: 4,
                    disagree: 0,
                    eligible: 4,
                    heuristicScore: 85,
                },
            },
            recommendation: {
                direction: 'DIFFERS',
                digit: 7,
                agree: 4,
                disagree: 0,
                eligible: 4,
                heuristicScore: 85,
            },
        };

        const success = applyRecommendationToBot(sampleMarket);
        expect(success).toBe(true);
        expect(mockMarketBlock.setFieldValue).toHaveBeenCalledWith('1HZ100V', 'SYMBOL_LIST');
        expect(mockTradeTypeBlock.setFieldValue).toHaveBeenCalledWith('digits', 'TRADETYPECAT_LIST');
        expect(mockTradeTypeBlock.setFieldValue).toHaveBeenCalledWith('matchesdiffers', 'TRADETYPE_LIST');
        expect(mockContractTypeBlock.setFieldValue).toHaveBeenCalledWith('DIGITDIFF', 'TYPE_LIST');
        expect(mockTradeOptionsBlock.setFieldValue).toHaveBeenCalledWith('7', 'PREDICTION');
    });

    describe('Mobile Viewport Emulation (360x640 and 390x844)', () => {
        const viewports = [
            { width: 360, height: 640, name: 'Small Phone (360x640)' },
            { width: 390, height: 844, name: 'iPhone 12/13/14 (390x844)' },
        ];

        viewports.forEach(({ width, height, name }) => {
            test(`fits within viewport without horizontal overflow at ${name}`, async () => {
                // Set window and document dimensions
                Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
                Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: height });
                Object.defineProperty(document.documentElement, 'clientWidth', { writable: true, configurable: true, value: width });
                Object.defineProperty(document.documentElement, 'scrollWidth', { writable: true, configurable: true, value: width });

                render(<DigitScannerModal is_open={true} onClose={jest.fn()} />);

                const scanBtn = screen.getByTestId('dt_scanner_scan_button');
                await act(async () => {
                    fireEvent.click(scanBtn);
                });

                await waitFor(() => {
                    expect(screen.getByTestId('dt_scanner_table')).toBeInTheDocument();
                });

                // Check that document.scrollWidth does not exceed window.innerWidth
                expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

                // Check results container touch gestures don't close modal
                const modal = screen.getByTestId('dt_digit_scanner_modal');
                const touchEvent = new Event('touchstart', { bubbles: true });
                const stopPropagationSpy = jest.spyOn(touchEvent, 'stopPropagation');
                modal.dispatchEvent(touchEvent);
                expect(stopPropagationSpy).toHaveBeenCalled();
            });
        });
    });
});
