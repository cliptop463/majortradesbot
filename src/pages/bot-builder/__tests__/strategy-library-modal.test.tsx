import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, jest } from '@jest/globals';
import StrategyLibraryModal from '../strategy-library-modal';

jest.mock('@deriv-com/translations', () => ({
    localize: (text: string, params?: Record<string, unknown>) =>
        params ? text.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(params[key])) : text,
}));

jest.mock('@/components/shared_ui/dialog', () => {
    const Dialog = ({ is_visible, children, title }: any) =>
        is_visible ? (
            <div data-testid='mock-dialog'>
                <h1>{title}</h1>
                {children}
            </div>
        ) : null;
    return Dialog;
});

describe('StrategyLibraryModal', () => {
    it('lists the four reference sources and shows details for the selected strategy', () => {
        render(<StrategyLibraryModal isOpen onClose={jest.fn()} onUseStrategy={jest.fn()} />);

        expect(screen.getByTestId('dt_strategy_library_modal')).toBeTruthy();
        expect(screen.getByTestId('dt_strategy_library_nexus-digit-printer')).toBeTruthy();
        expect(screen.getByTestId('dt_strategy_library_nexus-tick-striker')).toBeTruthy();
        expect(screen.getByTestId('dt_strategy_library_blueprint-recent-pattern')).toBeTruthy();
        expect(screen.getByTestId('dt_strategy_library_proanalyser-frequency')).toBeTruthy();
        expect(screen.getByTestId('dt_strategy_library_tactics-weighted-frequency')).toBeTruthy();
        expect(screen.queryByTestId('dt_strategy_library_tick-striker')).toBeNull();
        expect(screen.getByText('Transition-weighted DIGITMATCH using recent last-digit behaviour.')).toBeTruthy();

        fireEvent.click(screen.getByTestId('dt_strategy_library_nexus-over8-sniper'));
        expect(screen.getByText('DIGITOVER 8 when recent digit-9 frequency is elevated.')).toBeTruthy();
        expect(screen.getByTestId('dt_strategy_library_nexus-over8-sniper').getAttribute('aria-pressed')).toBe('true');
    });

    it('opens the selected strategy in Bulk Strategy when requested', () => {
        const onUseStrategy = jest.fn();
        render(<StrategyLibraryModal isOpen onClose={jest.fn()} onUseStrategy={onUseStrategy} />);

        fireEvent.click(screen.getByTestId('dt_strategy_library_tactics-weighted-frequency'));
        expect(screen.getByText('Source inspiration: Tactics-inspired')).toBeTruthy();
        fireEvent.click(screen.getByTestId('dt_strategy_library_use'));

        expect(onUseStrategy).toHaveBeenCalledWith('tactics-weighted-frequency');
    });
});
