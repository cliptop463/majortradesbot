import React from 'react';
import Dialog from '@/components/shared_ui/dialog';
import { localize } from '@deriv-com/translations';
import { listStrategies } from '@/utils/bulk-strategy/strategies';
import type { BulkStrategy } from '@/utils/bulk-strategy/types';
import './strategy-library-modal.scss';

type Props = {
    isOpen: boolean;
    onClose: () => void;
    onUseStrategy: (strategyId: string) => void;
};

const REFERENCE_PREFIXES = ['nexus-', 'blueprint-', 'proanalyser-', 'tactics-'];
const EXPERIMENTAL_PREFIXES = ['blueprint-', 'proanalyser-', 'tactics-'];

const sourceFor = (strategyId: string) => {
    if (strategyId.startsWith('nexus-')) return localize('Nexus');
    if (strategyId.startsWith('blueprint-')) return localize('Blueprint-inspired');
    if (strategyId.startsWith('proanalyser-')) return localize('ProAnalyser-inspired');
    if (strategyId.startsWith('tactics-')) return localize('Tactics-inspired');
    return localize('Reference');
};

const StrategyLibraryModal: React.FC<Props> = ({ isOpen, onClose, onUseStrategy }) => {
    const strategies = React.useMemo(
        () => listStrategies().filter(strategy => REFERENCE_PREFIXES.some(prefix => strategy.id.startsWith(prefix))),
        []
    );
    const [selectedId, setSelectedId] = React.useState('nexus-digit-printer');
    const selected = strategies.find(strategy => strategy.id === selectedId) ?? strategies[0];

    return (
        <Dialog
            portal_element_id='modal_root'
            title={localize('Strategy library')}
            is_visible={isOpen}
            onCancel={onClose}
            onConfirm={() => undefined}
            login={() => undefined}
            has_close_icon
            cancel_button_text={localize('Close')}
            className='strategy-library-modal'
        >
            <div className='strategy-library-modal__content' data-testid='dt_strategy_library_modal'>
                <p className='strategy-library-modal__intro'>
                    {localize(
                        'Browse implemented strategies inspired by Nexus, Blueprint, ProAnalyser, and Tactics. Choose one to review its rules, then test it in Paper mode.'
                    )}
                </p>

                <div className='strategy-library-modal__layout'>
                    <div className='strategy-library-modal__list' role='group' aria-label={localize('Reference strategies')}>
                        {strategies.map(strategy => (
                            <button
                                key={strategy.id}
                                type='button'
                                aria-pressed={selected?.id === strategy.id}
                                className={`strategy-library-modal__option${selected?.id === strategy.id ? ' strategy-library-modal__option--selected' : ''}`}
                                data-testid={`dt_strategy_library_${strategy.id}`}
                                onClick={() => setSelectedId(strategy.id)}
                            >
                                <span className='strategy-library-modal__option-label'>{strategy.label}</span>
                                {(strategy.id === 'nexus-tick-striker' ||
                                    EXPERIMENTAL_PREFIXES.some(prefix => strategy.id.startsWith(prefix))) && (
                                    <span className='strategy-library-modal__badge'>
                                        {localize('Experimental')}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>

                    {selected && (
                        <StrategyDetails strategy={selected} source={sourceFor(selected.id)} onUse={() => onUseStrategy(selected.id)} />
                    )}
                </div>

                <p className='strategy-library-modal__notice' role='note'>
                    {localize(
                        'Reference-inspired strategies are independent implementations, not copied source code or verified reproductions. Signals and scores are historical heuristics, not win probabilities. This modal only opens Bulk Strategy; it never starts a trade.'
                    )}
                </p>
            </div>
        </Dialog>
    );
};

const StrategyDetails: React.FC<{ strategy: BulkStrategy; source: string; onUse: () => void }> = ({ strategy, source, onUse }) => (
    <section className='strategy-library-modal__details' aria-live='polite'>
        <h2>{strategy.label}</h2>
        <p className='strategy-library-modal__source'>{localize('Source inspiration: {{source}}', { source })}</p>
        <p>{strategy.description}</p>
        <dl className='strategy-library-modal__facts'>
            <div>
                <dt>{localize('Ticks required')}</dt>
                <dd>{strategy.minTicks}</dd>
            </div>
            <div>
                <dt>{localize('Tick window')}</dt>
                <dd>{strategy.bufferSize}</dd>
            </div>
            <div>
                <dt>{localize('Settlement length')}</dt>
                <dd>{localize('{{count}} tick(s)', { count: strategy.ticksToSettle })}</dd>
            </div>
        </dl>
        <button
            type='button'
            className='strategy-library-modal__use'
            data-testid='dt_strategy_library_use'
            onClick={onUse}
        >
            {localize('Use in Bulk Strategy')}
        </button>
    </section>
);

export default StrategyLibraryModal;
