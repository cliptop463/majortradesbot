// @ts-nocheck
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import BulkStrategyModal from '../bulk-strategy-modal';
import { STORAGE_KEY } from '@/utils/bulk-strategy/config';
import { FakeApi, flush, rising, tick } from '@/utils/bulk-strategy/testing/fake-api';

jest.mock('@deriv-com/translations', () => ({
    localize: (s: string, params?: Record<string, unknown>) =>
        params ? s.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(params[k])) : s,
}));

jest.mock('@/components/shared_ui/dialog', () => {
    const Dialog = ({ is_visible, children, cancel_button_text, onCancel }: any) =>
        is_visible ? (
            <div data-testid='mock-dialog'>
                {children}
                <button data-testid='dialog-cancel' onClick={onCancel}>
                    {cancel_button_text}
                </button>
            </div>
        ) : null;
    return Dialog;
});

jest.mock('@/utils/bulk-strategy/deriv-api', () => ({
    createDerivApi: jest.fn(),
    getAccountContext: jest.fn(),
}));

import { createDerivApi, getAccountContext } from '@/utils/bulk-strategy/deriv-api';

const WIN = [100, 101, 102, 103, 104];
const LOSS = [104, 103, 102, 101, 100];

const trainingTicks = () => {
    let price = 1000;
    const ticks: number[] = [];
    for (let block = 0; block < 41; block++) {
        const direction = block % 2 === 0 ? 1 : -1;
        for (let index = 0; index < 30; index++) {
            price += direction;
            ticks.push(price);
        }
    }
    return ticks.slice(-1200);
};

let api: FakeApi;
const scriptApi = () => {
    api = new FakeApi();
    let id = 1000;
    api.responders.push(req => {
        if (req.ticks_history && req.subscribe) return { history: { prices: trainingTicks() }, subscription: { id: 'tick-sub' } };
        if (req.proposal) return { proposal: { payout: 3.5 * req.amount, ask_price: req.amount } };
        if (req.buy) return { buy: { contract_id: ++id, buy_price: req.price, payout: 3.5 * req.price } };
        if (req.proposal_open_contract) return { subscription: { id: `poc-${req.contract_id}` }, proposal_open_contract: { contract_id: req.contract_id, is_sold: 0 } };
        return undefined;
    });
    (createDerivApi as jest.Mock).mockReturnValue(api);
};

const save = (patch: Record<string, unknown>) =>
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ stake: 1, bulkSize: 2, maxLoss: 1000, profitTarget: 1000, ...patch }));


// Settings are hidden until asked for, so the settings tests open them first.
const renderOpen = (ui: React.ReactElement) => {
    const result = render(ui);
    const toggle = screen.queryByTestId('dt_bulk_toggle_settings');
    if (toggle) fireEvent.click(toggle);
    return result;
};

const props = (extra = {}) => ({ isOpen: true, onClose: jest.fn(), is_running: false, onRunningChange: jest.fn(), ...extra });
const field = (name: string, value: string) => fireEvent.change(screen.getByTestId(`dt_bulk_${name}`), { target: { value } });
const buys = () => api.sent.filter(r => r.buy);
const proposals = () => api.sent.filter(r => r.proposal);

const startRun = async () => {
    await act(async () => {
        fireEvent.click(screen.getByTestId('dt_bulk_run'));
    });
    await act(async () => {
        await flush();
    });
};
const feed = async (quotes: number[]) => {
    await act(async () => {
        quotes.forEach(q => tick(api, q));
        await flush();
    });
};

beforeEach(() => {
    jest.resetAllMocks();
    localStorage.clear();
    scriptApi();
    (getAccountContext as jest.Mock).mockReturnValue({ kind: 'demo', currency: 'USD' });
});

describe('defaults and saved settings', () => {
    it('opens on Demo + Paper, with the trade-anyway timeout off and a worst-case cost shown', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        expect(screen.getByTestId('dt_bulk_account_demo').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_bulk_mode_paper').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_bulk_trade_anyway').checked).toBe(false);
        expect(screen.getByTestId('dt_bulk_worst_case').textContent).toContain('7.35'); // 3 x 0.35 x (1+2+4)
        expect(screen.queryByTestId('dt_bulk_problems')).toBeNull();
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(false);
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run Paper strategy');
        expect(screen.getByTestId('dt_bulk_run_bar')).toBeTruthy();
        expect(screen.getByTestId('dt_bulk_setup').textContent).toContain('saved automatically when you start');
        expect(screen.getByTestId('dt_bulk_disclaimer').textContent).toContain('No strategy changes the odds');
    });

    it('offers the volatility indices and the pluggable strategy list', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        const markets = Array.from(screen.getByTestId('dt_bulk_market').options).map(o => o.value);
        expect(markets).toEqual(expect.arrayContaining(['R_100', '1HZ100V']));
        expect(Array.from(screen.getByTestId('dt_bulk_strategy').options).map(o => o.textContent)).toEqual([
            'Tick Striker V3',
            'Last-Ticks Matches',
        ]);
    });

    it('shows and saves a separate Matches digit count only for that strategy', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        expect(screen.queryByTestId('dt_bulk_matchesTickCount')).toBeNull();
        fireEvent.change(screen.getByTestId('dt_bulk_strategy'), { target: { value: 'last-ticks-matches' } });
        expect(screen.getByTestId('dt_bulk_matchesTickCount').value).toBe('5');
        field('matchesTickCount', '8');
        fireEvent.click(screen.getByTestId('dt_bulk_save'));
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toMatchObject({ matchesTickCount: 8, bulkSize: 3 });
        fireEvent.change(screen.getByTestId('dt_bulk_strategy'), { target: { value: 'tick-striker' } });
        expect(screen.queryByTestId('dt_bulk_matchesTickCount')).toBeNull();
    });

    it('reloads the saved config on load, but never restores Real', () => {
        save({ symbol: '1HZ50V', stake: 2.5, mode: 'live', account: 'real' });
        renderOpen(<BulkStrategyModal {...props()} />);
        expect(screen.getByTestId('dt_bulk_market').value).toBe('1HZ50V');
        expect(screen.getByTestId('dt_bulk_stake').value).toBe('2.5');
        expect(screen.getByTestId('dt_bulk_mode_live').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_bulk_account_demo').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run Live strategy');
    });

    it('saves to localStorage, with no secrets in it', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        field('stake', '1.5');
        fireEvent.change(screen.getByTestId('dt_bulk_market'), { target: { value: 'R_50' } });
        fireEvent.click(screen.getByTestId('dt_bulk_save'));
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(stored).toMatchObject({ stake: 1.5, symbol: 'R_50', account: 'demo', mode: 'paper' });
        expect(localStorage.getItem(STORAGE_KEY)).not.toMatch(/token|secret/i);
        expect(screen.getByTestId('dt_bulk_save').textContent).toBe('Saved');
    });

    it('lets you type decimals without the field fighting you', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        field('stake', '0.');
        expect(screen.getByTestId('dt_bulk_stake').value).toBe('0.');
        field('stake', '0.5');
        expect(screen.getByTestId('dt_bulk_stake').value).toBe('0.5');
    });
});

describe('risk presets and the safety cap', () => {
    it('High fills x2 with 3 steps and is blocked until the max loss covers the worst case', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_risk_high'));
        expect(screen.getByTestId('dt_bulk_bulkSize').value).toBe('5');
        expect(screen.getByTestId('dt_bulk_multiplier').value).toBe('2');
        expect(screen.getByTestId('dt_bulk_maxSteps').value).toBe('3');
        expect(screen.getByTestId('dt_bulk_worst_case').textContent).toContain('26.25');
        expect(screen.getByTestId('dt_bulk_problems').textContent).toContain('exceeds your max loss');
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(true);

        field('maxLoss', '30');
        expect(screen.queryByTestId('dt_bulk_problems')).toBeNull();
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(false);
    });

    it('explains the blocked Run button and offers an explicit max-loss adjustment', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_risk_high'));
        field('stake', '1');
        field('maxLoss', '50');

        expect(screen.getByTestId('dt_bulk_worst_case').textContent).toContain('75.00');
        expect(screen.getByTestId('dt_bulk_limit_help').textContent).toContain('Run is blocked');
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(true);

        fireEvent.click(screen.getByTestId('dt_bulk_set_max_loss'));

        expect(screen.getByTestId('dt_bulk_maxLoss').value).toBe('75');
        expect(screen.queryByTestId('dt_bulk_limit_help')).toBeNull();
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(false);
    });

    it('Low turns martingale off and hides its fields', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_risk_low'));
        expect(screen.getByTestId('dt_bulk_martingale').checked).toBe(false);
        expect(screen.queryByTestId('dt_bulk_multiplier')).toBeNull();
    });

    it('rejects an out-of-range bulk size', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        field('bulkSize', '11');
        expect(screen.getByTestId('dt_bulk_problems').textContent).toContain('Bulk size');
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(true);
    });
});

describe('Real account confirmation', () => {
    it('stays on Demo until the confirmation is acknowledged', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_account_real'));
        expect(screen.getByTestId('dt_bulk_real_confirm')).toBeTruthy();
        expect(screen.getByTestId('dt_bulk_account_demo').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('dt_bulk_real_enable').disabled).toBe(true);

        fireEvent.click(screen.getByTestId('dt_bulk_real_ack'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_enable'));
        expect(screen.queryByTestId('dt_bulk_real_confirm')).toBeNull();
        expect(screen.getByTestId('dt_bulk_account_real').getAttribute('aria-pressed')).toBe('true');
    });

    it('Keep Demo cancels without enabling Real', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_account_real'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_ack'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_cancel'));
        expect(screen.queryByTestId('dt_bulk_real_confirm')).toBeNull();
        expect(screen.getByTestId('dt_bulk_account_demo').getAttribute('aria-pressed')).toBe('true');
    });

    it('shows a clear banner for Real + Live', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_account_real'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_ack'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_enable'));
        fireEvent.click(screen.getByTestId('dt_bulk_mode_live'));
        expect(screen.getByTestId('dt_bulk_real_banner').textContent).toContain('REAL ACCOUNT');
    });

    it('Live refuses to start when the logged-in account is not the one chosen', async () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_account_real'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_ack'));
        fireEvent.click(screen.getByTestId('dt_bulk_real_enable'));
        fireEvent.click(screen.getByTestId('dt_bulk_mode_live'));
        await startRun();
        expect(screen.getByTestId('dt_bulk_error').textContent).toContain('logged in to a Demo account');
        expect(api.sent).toHaveLength(0); // nothing was sent
    });

    it('Live needs a logged-in account', async () => {
        (getAccountContext as jest.Mock).mockReturnValue({ kind: null, currency: 'USD' });
        renderOpen(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_mode_live'));
        await startRun();
        expect(screen.getByTestId('dt_bulk_error').textContent).toContain('Log in first');
        expect(api.sent).toHaveLength(0);
    });
});

describe('running', () => {
    it('starts with edited settings without requiring a separate save', async () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        field('stake', '0.5');
        expect(screen.getByTestId('dt_bulk_save').textContent).toBe('Save');

        await startRun();

        expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toMatchObject({ stake: 0.5, mode: 'paper' });
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Stop');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_stop'));
            await flush();
        });
    });

    it('Paper: sends no buy orders, fills the log table from real ticks and stops cleanly', async () => {
        save({});
        const p = props();
        renderOpen(<BulkStrategyModal {...p} />);
        await startRun();
        expect(p.onRunningChange).toHaveBeenLastCalledWith(true);
        expect(screen.getByTestId('dt_bulk_status').textContent).toContain('Paper');

        await feed(WIN);
        expect(proposals().length).toBeGreaterThanOrEqual(1);
        expect(buys()).toHaveLength(0);
        const rows = screen.getAllByTestId('dt_bulk_log_row');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('2/0'); // 2 contracts won, 0 lost
        expect(screen.getByTestId('dt_bulk_export').disabled).toBe(false);

        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_stop'));
            await flush();
        });
        expect(api.sent.filter(r => r.forget === 'tick-sub')).toHaveLength(1);
        expect(api.handlers.size).toBe(0);
        expect(screen.getByTestId('dt_bulk_summary')).toBeTruthy();
        expect(screen.getByTestId('dt_bulk_sum_rounds').textContent).toBe('1');
        expect(screen.getByTestId('dt_bulk_sum_won').textContent).toBe('2');
        expect(screen.getByTestId('dt_bulk_sum_winrate').textContent).toBe('100.0%');
        expect(screen.getByTestId('dt_bulk_sum_net').textContent).toBe('5.00');
        expect(p.onRunningChange).toHaveBeenLastCalledWith(false);
    });

    it('stops by itself at the profit target and shows the summary with the reason', async () => {
        save({ profitTarget: 5 });
        renderOpen(<BulkStrategyModal {...props()} />);
        await startRun();
        await feed(WIN);
        await waitFor(() => expect(screen.getByTestId('dt_bulk_summary')).toBeTruthy());
        expect(screen.getByTestId('dt_bulk_sum_reason').textContent).toContain('Profit target reached');
        expect(screen.getByTestId('dt_bulk_sum_breakeven').textContent).toMatch(/28\.6%/); // 1 / 3.5
    });

    it('shows a losing round in the table and counts it in the summary', async () => {
        save({});
        renderOpen(<BulkStrategyModal {...props()} />);
        await startRun();
        await feed(LOSS);
        const rows = screen.getAllByTestId('dt_bulk_log_row');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('0/2');
        expect(rows[0].textContent).toContain('-2.00');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_stop'));
            await flush();
        });
        expect(screen.getByTestId('dt_bulk_sum_lost').textContent).toBe('2');
        expect(screen.getByTestId('dt_bulk_sum_streak').textContent).toBe('1');
        expect(screen.getByTestId('dt_bulk_sum_net').textContent).toBe('-2.00');
    });

    it('Live: places real buys and locks the settings while running', async () => {
        save({ mode: 'live', bulkSize: 3 });
        renderOpen(<BulkStrategyModal {...props()} />);
        await startRun();
        expect(buys()).toHaveLength(3);
        expect(buys()[0].parameters).toMatchObject({ contract_type: 'TICKHIGH', selected_tick: 5, currency: 'USD' });
        expect(screen.getByTestId('dt_bulk_stake').disabled).toBe(true);
        expect(screen.getByTestId('dt_bulk_mode_paper').disabled).toBe(true);
        expect(screen.getByTestId('dt_bulk_save').disabled).toBe(true);
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_stop'));
            await flush();
        });
        expect(screen.getByTestId('dt_bulk_summary').textContent).toContain('not tracked');
    });

    it('will not start beside a running Blockly bot', async () => {
        renderOpen(<BulkStrategyModal {...props({ is_running: true })} />);
        await startRun();
        expect(screen.getByTestId('dt_bulk_error').textContent).toContain('Stop the Blockly bot first');
        expect(api.sent).toHaveLength(0);
    });

    it('shows the engine error when the subscription fails, and can try again', async () => {
        save({});
        api.responders.unshift(req => (req.ticks_history ? { error: { code: 'InvalidSymbol', message: 'Symbol is invalid.' } } : undefined));
        renderOpen(<BulkStrategyModal {...props()} />);
        await startRun();
        expect(screen.getByTestId('dt_bulk_error').textContent).toContain('Symbol is invalid.');
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run Paper strategy');
    });

    it('stops and cancels subscriptions when the page is left', async () => {
        save({});
        const { unmount } = renderOpen(<BulkStrategyModal {...props()} />);
        await startRun();
        unmount();
        await act(async () => {
            await flush();
        });
        expect(api.sent.filter(r => r.forget === 'tick-sub')).toHaveLength(1);
        expect(api.handlers.size).toBe(0);
    });

    it('Hide keeps it running; the panel can be closed without stopping', async () => {
        save({});
        const p = props();
        renderOpen(<BulkStrategyModal {...p} />);
        await startRun();
        expect(screen.getByTestId('dialog-cancel').textContent).toBe('Hide');
        fireEvent.click(screen.getByTestId('dialog-cancel'));
        expect(p.onClose).toHaveBeenCalled();
        expect(api.sent.some(r => r.forget)).toBe(false);
        await act(async () => {
            await flush();
        });
    });
});

describe('CSV export and scrolling holders', () => {
    it('exports the round log as CSV', async () => {
        save({});
        const created: Blob[] = [];
        (URL as any).createObjectURL = jest.fn((blob: Blob) => {
            created.push(blob);
            return 'blob:test';
        });
        (URL as any).revokeObjectURL = jest.fn();
        renderOpen(<BulkStrategyModal {...props()} />);
        await startRun();
        await feed(WIN);
        fireEvent.click(screen.getByTestId('dt_bulk_export'));
        expect(created).toHaveLength(1);
        const text = await new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsText(created[0]);
        });
        expect(text.split('\n')[0]).toContain('round,time,mode,symbol');
        expect(text.split('\n')).toHaveLength(2); // header + one round
        expect(text).toContain('paper,R_100,2');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_stop'));
            await flush();
        });
    });

    it('keeps the buttons in a dedicated holder that can scroll', () => {
        renderOpen(<BulkStrategyModal {...props()} />);
        const holder = screen.getByTestId('dt_bulk_actions');
        expect(holder.className).toContain('bulk-strategy-modal__actions');
        expect(holder.querySelectorAll('button').length).toBeGreaterThanOrEqual(3);
        expect(screen.getByTestId('dt_bulk_log').className).toContain('bulk-strategy-modal__table-wrap');
    });

    it('renders nothing when closed', () => {
        renderOpen(<BulkStrategyModal {...props({ isOpen: false })} />);
        expect(screen.queryByTestId('dt_bulk_modal')).toBeNull();
    });
});


describe('quick test (the simple path)', () => {
    it('opens with the settings hidden and a single obvious button', () => {
        render(<BulkStrategyModal {...props()} />);
        expect(screen.getByTestId('dt_bulk_quick')).toBeTruthy();
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run quick test');
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(false);
        expect(screen.queryByTestId('dt_bulk_stake')).toBeNull();
        expect(screen.queryByTestId('dt_bulk_risk_high')).toBeNull();
        expect(screen.getByTestId('dt_bulk_setup').textContent).toContain('places no orders');
    });

    it('runs with one tap: Paper, no buy orders, and settles from the real tick stream', async () => {
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        expect(proposals()[0]).toMatchObject({ contract_type: 'TICKHIGH', selected_tick: 5, underlying_symbol: 'R_100', amount: 1 });
        await feed(WIN);
        expect(screen.getAllByTestId('dt_bulk_log_row')).toHaveLength(1);
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_stop'));
            await flush();
        });
        expect(buys()).toHaveLength(0);
        expect(screen.getByTestId('dt_bulk_sum_rounds').textContent).toBe('1');
        expect(api.sent.filter(r => r.forget === 'tick-sub')).toHaveLength(1);
    });

    it('uses the market you pick on the quick card', async () => {
        render(<BulkStrategyModal {...props()} />);
        fireEvent.change(screen.getByTestId('dt_bulk_quick_market'), { target: { value: '1HZ50V' } });
        await startQuick();
        expect(api.sent.find(r => r.ticks_history).ticks_history).toBe('1HZ50V');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
    });

    it('is never blocked by a bad or half-edited setup in the settings', async () => {
        save({ stake: 5, bulkSize: 10, maxLoss: 1, mode: 'live' }); // would be refused: worst case far above max loss
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        expect(screen.queryByTestId('dt_bulk_error')).toBeNull();
        expect(proposals().length).toBeGreaterThanOrEqual(1);
        expect(buys()).toHaveLength(0); // still Paper, whatever was saved
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
    });

    it('never overwrites the settings you saved', async () => {
        save({ stake: 2.5, symbol: 'R_75' });
        const before = localStorage.getItem(STORAGE_KEY);
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
        expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
    });

    it('tells you in plain words what it is doing while it waits for ticks', async () => {
        api.responders.unshift(req => (req.ticks_history && req.subscribe ? { history: { prices: rising(10) }, subscription: { id: 'tick-sub' } } : undefined));
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        expect(screen.getByTestId('dt_bulk_status_text').textContent).toContain('Collecting real ticks (10/300)');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
    });

    it('says what the signal is when it is waiting for one', async () => {
        const falling = Array.from({ length: 300 }, (_, i) => 500 - i);
        api.responders.unshift(req => (req.ticks_history && req.subscribe ? { history: { prices: falling }, subscription: { id: 'tick-sub' } } : undefined));
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        const text = screen.getByTestId('dt_bulk_status_text').textContent;
        expect(text).toContain('Waiting for a signal: Insufficient TICKHIGH outcome classes');
        expect(text).toContain('5 s timeout'); // the quick test turns the timeout on so something visibly happens
        expect(screen.getByTestId('dt_bulk_diagnostics').textContent).toContain('entry threshold 0.50');
        expect(screen.getByTestId('dt_bulk_rejection_reason').textContent).toContain('Insufficient TICKHIGH outcome classes');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
    });

    it('shows the round in progress while it settles', async () => {
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        expect(screen.getByTestId('dt_bulk_status_text').textContent).toContain('Round 1 running');
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
    });

    it('shows a clear error, and stays usable, when Deriv gives no usable data', async () => {
        api.responders.unshift(req => (req.ticks_history ? { error: { code: 'WrongResponse', message: 'Deriv is not responding.' } } : undefined));
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        expect(screen.getByTestId('dt_bulk_error').textContent).toContain('Deriv is not responding.');
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run quick test');
        expect(screen.getByTestId('dt_bulk_run').disabled).toBe(false);
    });

    it('Show settings reveals every setting, relabels the button, and Reset restores the defaults', async () => {
        save({ stake: 9, symbol: '1HZ25V' });
        render(<BulkStrategyModal {...props()} />);
        fireEvent.click(screen.getByTestId('dt_bulk_toggle_settings'));
        expect(screen.getByTestId('dt_bulk_stake').value).toBe('9');
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run Paper strategy');
        expect(screen.queryByTestId('dt_bulk_quick_market')).toBeNull();
        fireEvent.click(screen.getByTestId('dt_bulk_reset'));
        expect(screen.getByTestId('dt_bulk_stake').value).toBe('0.35');
        expect(screen.getByTestId('dt_bulk_market').value).toBe('R_100');
        expect(screen.getByTestId('dt_bulk_account_demo').getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByTestId('dt_bulk_toggle_settings'));
        expect(screen.getByTestId('dt_bulk_run').textContent).toBe('Run quick test');
    });

    it('cannot change the view or the market while a run is active', async () => {
        render(<BulkStrategyModal {...props()} />);
        await startQuick();
        expect(screen.getByTestId('dt_bulk_toggle_settings').disabled).toBe(true);
        expect(screen.getByTestId('dt_bulk_quick_market').disabled).toBe(true);
        await act(async () => {
            fireEvent.click(screen.getByTestId('dt_bulk_run'));
            await flush();
        });
    });

    it('will not start beside a running Blockly bot, and says so', async () => {
        render(<BulkStrategyModal {...props({ is_running: true })} />);
        await startQuick();
        expect(screen.getByTestId('dt_bulk_error').textContent).toContain('Stop the Blockly bot first');
        expect(api.sent).toHaveLength(0);
    });
});

async function startQuick() {
    await act(async () => {
        fireEvent.click(screen.getByTestId('dt_bulk_run'));
    });
    await act(async () => {
        await flush();
    });
}
