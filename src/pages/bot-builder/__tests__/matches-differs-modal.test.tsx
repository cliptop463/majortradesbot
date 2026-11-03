// @ts-nocheck
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import MatchesDiffersModal from '../matches-differs-modal';

jest.mock('@deriv-com/translations', () => ({
    localize: (s: string) => s,
}));

jest.mock('@/components/shared_ui/dialog', () => {
    const Dialog = ({ is_visible, children, confirm_button_text, onConfirm, is_confirm_disabled, cancel_button_text, onCancel }: any) => {
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

jest.mock('@/utils/digit-scanner/matches-differs-load', () => ({
    loadSample: jest.fn(),
}));

jest.mock('@/utils/blockly-scanner-pick', () => ({
    previewScannerPick: jest.fn(),
    applyScannerPick: jest.fn(),
    getSelectedSymbol: jest.fn(),
}));

import { loadSample } from '@/utils/digit-scanner/matches-differs-load';
import { previewScannerPick, applyScannerPick, getSelectedSymbol } from '@/utils/blockly-scanner-pick';

const withCounts = (counts: number[]) => counts.flatMap((count, digit) => Array(count).fill(digit));
const balanced = () => withCounts(Array(10).fill(100));
const skewed = () => {
    const counts = Array(10).fill(100);
    counts[7] = 190; // most frequent
    counts[2] = 10; // least frequent
    return withCounts(counts);
};
const sampleOf = (digits: number[], extra: Record<string, unknown> = {}) => ({
    symbol: 'R_50',
    digits,
    requested: 1000,
    received: digits.length,
    dropped: 0,
    decimals: 2,
    precisionSource: 'api',
    ...extra,
});

const okPreview = (before = 'digits') => ({
    ok: true,
    symbol: { before: 'R_10', after: 'R_50' },
    category: { before, after: 'digits' },
    tradeType: { before: before === 'digits' ? 'matchesdiffers' : 'risefall', after: 'matchesdiffers' },
    type: { before: 'DIGITDIFF', after: 'DIGITMATCH' },
    prediction: { before: 3, after: 7 },
});

const defaultProps = { isOpen: true, onClose: jest.fn(), onApplied: jest.fn(), is_running: false, store_symbol: null };

const openAndLoad = async (props = {}) => {
    render(<MatchesDiffersModal {...defaultProps} {...props} />);
    await waitFor(() => expect(screen.getByTestId('dt_matches_differs_stats')).toBeTruthy());
};

beforeEach(() => {
    jest.resetAllMocks();
    (window as any).Blockly = { derivWorkspace: { id: 'ws' } };
    (getSelectedSymbol as jest.Mock).mockReturnValue('R_50');
    (loadSample as jest.Mock).mockResolvedValue(sampleOf(skewed()));
    (previewScannerPick as jest.Mock).mockReturnValue(okPreview());
    (applyScannerPick as jest.Mock).mockResolvedValue({ ok: true });
});

describe('MatchesDiffersModal', () => {
    it('opens for the bot\'s selected market and loads its ticks', async () => {
        await openAndLoad();
        expect(loadSample).toHaveBeenCalledWith('R_50');
        expect(screen.getByTestId('dt_matches_differs_market').textContent).toContain('Volatility 50 Index');
        expect(screen.getByTestId('dt_matches_differs_sample').textContent).toBe('1000');
    });

    it('shows a loading state before the ticks arrive', async () => {
        (loadSample as jest.Mock).mockReturnValue(new Promise(() => undefined));
        render(<MatchesDiffersModal {...defaultProps} />);
        expect(await screen.findByTestId('dt_matches_differs_loading')).toBeTruthy();
        expect(screen.queryByTestId('dt_matches_differs_stats')).toBeNull();
    });

    it('falls back to the store symbol when the market block cannot be read', async () => {
        (getSelectedSymbol as jest.Mock).mockReturnValue(null);
        await openAndLoad({ store_symbol: '1HZ75V' });
        expect(loadSample).toHaveBeenCalledWith('1HZ75V');
        expect(screen.getByTestId('dt_matches_differs_market').textContent).toContain('Volatility 75 (1s) Index');
    });

    it('explains when the bot has no market selected, without fetching', async () => {
        (getSelectedSymbol as jest.Mock).mockReturnValue(null);
        render(<MatchesDiffersModal {...defaultProps} />);
        expect((await screen.findByTestId('dt_matches_differs_error')).textContent).toContain('No market is selected');
        expect(loadSample).not.toHaveBeenCalled();
    });

    it('shows chi-square, a skewed label, the chart, and Match / Differ buttons for a skewed sample', async () => {
        await openAndLoad();
        expect(screen.getByTestId('dt_matches_differs_chi2').textContent).toMatch(/^\d+\.\d{2}$/);
        expect(screen.getByTestId('dt_matches_differs_verdict').textContent).toContain('Skewed');
        expect(screen.getByTestId('dt_matches_differs_verdict').textContent).toContain('p<0.001');
        expect(screen.getByTestId('dt_matches_differs_chart')).toBeTruthy();
        expect(screen.getByTestId('dt_matches_differs_match').textContent).toContain('Match 7');
        expect(screen.getByTestId('dt_matches_differs_differ').textContent).toContain('Differ 2');
    });

    it('marks the highest bar green and the lowest red', async () => {
        await openAndLoad();
        const chart = screen.getByTestId('dt_matches_differs_chart');
        expect(chart.querySelectorAll('.matches-differs-modal__bar')).toHaveLength(10);
        expect(chart.querySelectorAll('.matches-differs-modal__bar--high')).toHaveLength(1);
        expect(chart.querySelectorAll('.matches-differs-modal__bar--low')).toHaveLength(1);
    });

    it('says "Consistent with random" for an even sample and highlights no bar', async () => {
        (loadSample as jest.Mock).mockResolvedValue(sampleOf(balanced()));
        await openAndLoad();
        expect(screen.getByTestId('dt_matches_differs_verdict').textContent).toContain('Consistent with random');
        expect(screen.getByTestId('dt_matches_differs_chart').querySelectorAll('.matches-differs-modal__bar--high')).toHaveLength(0);
    });

    it('always shows the disclaimer, including in error and loading states', async () => {
        (loadSample as jest.Mock).mockRejectedValue(new Error('boom'));
        render(<MatchesDiffersModal {...defaultProps} />);
        await screen.findByTestId('dt_matches_differs_error');
        expect(screen.getByTestId('dt_matches_differs_disclaimer').textContent).toBe(
            'Digits on Deriv synthetics are random. A skew in past ticks does not predict the next one.'
        );
    });

    it('does not present the score as a probability', async () => {
        await openAndLoad();
        const text = screen.getByTestId('dt_matches_differs_modal').textContent;
        expect(text).toContain('not a probability');
        expect(text).not.toMatch(/win probability of|probability: /i);
    });

    it('shows an error and recovers with Refresh', async () => {
        (loadSample as jest.Mock).mockRejectedValueOnce(new Error('Timed out after 10 s loading ticks for R_50.'));
        render(<MatchesDiffersModal {...defaultProps} />);
        expect((await screen.findByTestId('dt_matches_differs_error')).textContent).toContain('Timed out');
        expect(screen.queryByTestId('dt_matches_differs_stats')).toBeNull();

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        await waitFor(() => expect(screen.getByTestId('dt_matches_differs_stats')).toBeTruthy());
        expect(screen.queryByTestId('dt_matches_differs_error')).toBeNull();
    });

    it('notes when fewer ticks than requested were available', async () => {
        (loadSample as jest.Mock).mockResolvedValue(sampleOf(skewed().slice(0, 400), { received: 400 }));
        await openAndLoad();
        expect(screen.getByTestId('dt_matches_differs_short_sample')).toBeTruthy();
        expect(screen.getByTestId('dt_matches_differs_sample').textContent).toBe('400');
    });

    it('warns when the bot market is not a volatility index', async () => {
        (getSelectedSymbol as jest.Mock).mockReturnValue('frxEURUSD');
        await openAndLoad();
        expect(screen.getByTestId('dt_matches_differs_not_volatility')).toBeTruthy();
    });

    it('ignores a slow earlier response that finishes after the modal was closed and reopened', async () => {
        let resolveFirst: (v: unknown) => void = () => undefined;
        (loadSample as jest.Mock)
            .mockReturnValueOnce(new Promise(resolve => (resolveFirst = resolve)))
            .mockResolvedValueOnce(sampleOf(balanced()));
        const { rerender } = render(<MatchesDiffersModal {...defaultProps} />);
        await screen.findByTestId('dt_matches_differs_loading');

        rerender(<MatchesDiffersModal {...defaultProps} isOpen={false} />);
        rerender(<MatchesDiffersModal {...defaultProps} isOpen />);
        await waitFor(() => expect(screen.getByTestId('dt_matches_differs_verdict').textContent).toContain('Consistent'));

        await act(async () => {
            resolveFirst(sampleOf(skewed()));
        });
        expect(screen.getByTestId('dt_matches_differs_verdict').textContent).toContain('Consistent');
    });

    it('does not allow Refresh while a request is already running', async () => {
        (loadSample as jest.Mock).mockReturnValue(new Promise(() => undefined));
        render(<MatchesDiffersModal {...defaultProps} />);
        await screen.findByTestId('dt_matches_differs_loading');
        expect(screen.getByTestId('dialog-confirm').disabled).toBe(true);
    });
});

describe('applying a suggestion', () => {
    it('previews first, applies only after Confirm, and never calls anything but the patcher', async () => {
        const onApplied = jest.fn();
        await openAndLoad({ onApplied });

        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        expect(previewScannerPick).toHaveBeenCalledWith(expect.anything(), { symbol: 'R_50', direction: 'MATCHES', digit: 7 });
        expect(await screen.findByTestId('dt_matches_differs_confirm')).toBeTruthy();
        expect(applyScannerPick).not.toHaveBeenCalled();
        expect(onApplied).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        expect(applyScannerPick).toHaveBeenCalledWith(expect.anything(), { symbol: 'R_50', direction: 'MATCHES', digit: 7 });
        await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    });

    it('applies Differ with the least frequent digit', async () => {
        await openAndLoad();
        fireEvent.click(screen.getByTestId('dt_matches_differs_differ'));
        await screen.findByTestId('dt_matches_differs_confirm');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        expect(applyScannerPick).toHaveBeenCalledWith(expect.anything(), { symbol: 'R_50', direction: 'DIFFERS', digit: 2 });
    });

    it('shows every field that will change in a From > To table and says it does not start the bot', async () => {
        await openAndLoad();
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        const panel = await screen.findByTestId('dt_matches_differs_confirm');
        expect(panel.querySelectorAll('tbody tr')).toHaveLength(5);
        expect(panel.textContent).toContain('R_10');
        expect(panel.textContent).toContain('DIGITMATCH');
        expect(panel.textContent).toContain('does not start the bot');
    });

    it('warns before changing a bot that is not on Digits', async () => {
        (previewScannerPick as jest.Mock).mockReturnValue(okPreview('callput'));
        await openAndLoad();
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        const notice = await screen.findByTestId('dt_matches_differs_category_notice');
        expect(notice.textContent).toContain('Applying will change it to Digits > Matches/Differs');
        expect(applyScannerPick).not.toHaveBeenCalled();
    });

    it('shows no category warning when the bot is already on Digits', async () => {
        await openAndLoad();
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        await screen.findByTestId('dt_matches_differs_confirm');
        expect(screen.queryByTestId('dt_matches_differs_category_notice')).toBeNull();
    });

    it('Back returns to the analysis without applying', async () => {
        await openAndLoad();
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        await screen.findByTestId('dt_matches_differs_confirm');
        fireEvent.click(screen.getByTestId('dialog-cancel'));
        expect(screen.queryByTestId('dt_matches_differs_confirm')).toBeNull();
        expect(screen.getByTestId('dt_matches_differs_stats')).toBeTruthy();
        expect(applyScannerPick).not.toHaveBeenCalled();
    });

    it('shows the reason and stays open when the preview is blocked', async () => {
        (previewScannerPick as jest.Mock).mockReturnValue({ ok: false, blocked: true, reason: 'BLOCKED: No trade_definition block found in the workspace.' });
        await openAndLoad();
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        expect((await screen.findByTestId('dt_matches_differs_apply_error')).textContent).toContain('BLOCKED');
        expect(screen.queryByTestId('dt_matches_differs_confirm')).toBeNull();
    });

    it('shows the failure reason and does not close when Apply fails', async () => {
        (applyScannerPick as jest.Mock).mockResolvedValue({ ok: false, reason: 'Blockly did not keep the settings.' });
        const onApplied = jest.fn();
        await openAndLoad({ onApplied });
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        await screen.findByTestId('dt_matches_differs_confirm');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dialog-confirm'));
        });
        expect((await screen.findByTestId('dt_matches_differs_apply_error')).textContent).toContain('did not keep');
        expect(onApplied).not.toHaveBeenCalled();
    });

    it('disables the suggestions and explains while the bot is running', async () => {
        await openAndLoad({ is_running: true });
        expect(screen.getByTestId('dt_matches_differs_match').disabled).toBe(true);
        expect(screen.getByTestId('dt_matches_differs_differ').disabled).toBe(true);
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        expect(previewScannerPick).not.toHaveBeenCalled();
        expect(screen.getByTestId('dt_matches_differs_modal').textContent).toContain('Stop the bot');
    });

    it('cannot confirm if the bot starts running while the preview is open', async () => {
        const { rerender } = render(<MatchesDiffersModal {...defaultProps} />);
        await waitFor(() => expect(screen.getByTestId('dt_matches_differs_stats')).toBeTruthy());
        fireEvent.click(screen.getByTestId('dt_matches_differs_match'));
        await screen.findByTestId('dt_matches_differs_confirm');
        rerender(<MatchesDiffersModal {...defaultProps} is_running />);
        expect(screen.getByTestId('dt_matches_differs_running_warning')).toBeTruthy();
        expect(screen.getByTestId('dialog-confirm').disabled).toBe(true);
        expect(applyScannerPick).not.toHaveBeenCalled();
    });

    it('does nothing when closed', () => {
        render(<MatchesDiffersModal {...defaultProps} isOpen={false} />);
        expect(screen.queryByTestId('dt_matches_differs_modal')).toBeNull();
        expect(loadSample).not.toHaveBeenCalled();
    });
});
