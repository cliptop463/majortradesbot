
// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md

import React from 'react';
import { observer } from 'mobx-react-lite';
import Dialog from '@/components/shared_ui/dialog';
import { useStore } from '@/hooks/useStore';
import { DBOT_TABS } from '@/constants/bot-contents';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';

// Correct component locations
import ToolbarButton from './toolbar/toolbar-button';
import WorkspaceGroup from './toolbar/workspace-group';
import DigitScannerModal from './digit-scanner-modal';
import MatchesDiffersModal from './matches-differs-modal';

// Load the existing toolbar styles
import './toolbar/toolbar.scss';

const Toolbar = observer(() => {
    const { run_panel, toolbar, quick_strategy, dashboard } = useStore();

    const { isDesktop } = useDevice();

    const {
        is_dialog_open,
        closeResetDialog,
        onResetOkButtonClick: onOkButtonClick,
    } = toolbar;

    const { is_running } = run_panel;
    const { setFormVisibility } = quick_strategy;
    const { setActiveTab } = dashboard;

    const confirm_button_text = is_running
        ? localize('Yes')
        : localize('OK');

    const cancel_button_text = is_running
        ? localize('No')
        : localize('Cancel');

    const [is_digit_scanner_open, setIsDigitScannerOpen] =
        React.useState(false);

    const [is_matches_differs_open, setIsMatchesDiffersOpen] =
        React.useState(false);

    // Open Quick Strategy
    const handleQuickStrategyOpen = () => {
        setFormVisibility(true);
    };

    // Digit Scanner handlers
    const handleDigitScannerOpen = () => {
        setIsDigitScannerOpen(true);
    };

    const handleDigitScannerClose = () => {
        setIsDigitScannerOpen(false);
    };

    const handleDigitScannerApplied = () => {
        setIsDigitScannerOpen(false);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    // Matches / Differs handlers
    const handleMatchesDiffersOpen = () => {
        setIsMatchesDiffersOpen(true);
    };

    const handleMatchesDiffersClose = () => {
        setIsMatchesDiffersOpen(false);
    };

    const handleMatchesDiffersApplied = () => {
        setIsMatchesDiffersOpen(false);
        setActiveTab(DBOT_TABS.BOT_BUILDER);
    };

    return (
        <React.Fragment>
            <div
                className='toolbar dashboard__toolbar'
                data-testid='dt_dashboard_toolbar'
            >
                <div className='toolbar__section'>

                    {!isDesktop && (
                        <ToolbarButton
                            popover_message={localize(
                                'Click here to start building your Deriv Bot.'
                            )}
                            button_id='db-toolbar__get-started-button'
                            button_classname='toolbar__btn toolbar__btn--icon toolbar__btn--start'
                            buttonOnClick={handleQuickStrategyOpen}
                            button_text={localize('Quick strategy')}
                            is_bot_running={is_running}
                        />
                    )}

                    {/* Digit Scanner */}
                    <ToolbarButton
                        popover_message={localize(
                            'Scan volatility markets for digit patterns.'
                        )}
                        button_id='db-toolbar__digit-scanner-button'
                        button_classname='toolbar__btn toolbar__btn--icon toolbar__btn--digit-scanner'
                        buttonOnClick={handleDigitScannerOpen}
                        button_text={localize('Digit Scanner')}
                        is_bot_running={is_running}
                    />

                    {/* Matches / Differs Analysis */}
                    <ToolbarButton
                        popover_message={localize(
                            "Analyse recent last digits for the bot's market and suggest a Match or Differ digit."
                        )}
                        button_id='db-toolbar__matches-differs-button'
                        button_classname='toolbar__btn toolbar__btn--icon toolbar__btn--digit-scanner'
                        buttonOnClick={handleMatchesDiffersOpen}
                        button_text={localize(
                            'Matches / Differs analysis'
                        )}
                        is_bot_running={is_running}
                    />

                    {isDesktop && <WorkspaceGroup />}
                </div>
            </div>

            {!isDesktop && <WorkspaceGroup />}

            {/* Workspace reset confirmation */}
            <Dialog
                portal_element_id='modal_root'
                title={localize('Are you sure?')}
                is_visible={is_dialog_open}
                confirm_button_text={confirm_button_text}
                onConfirm={onOkButtonClick}
                cancel_button_text={cancel_button_text}
                onCancel={closeResetDialog}
                is_mobile_full_width={false}
                className='toolbar__dialog'
                has_close_icon
            >
                {is_running ? (
                    <Localize
                        i18n_default_text='The workspace will be reset to the default strategy and any unsaved changes will be lost. <0>Note: This will not affect your running bot.</0>'
                        components={[
                            <div
                                key={0}
                                className='toolbar__dialog-text--second'
                                data-testid='dt_toolbar_dialog_text_second'
                            />,
                        ]}
                    />
                ) : (
                    <Localize
                        i18n_default_text='Any unsaved changes will be lost.'
                    />
                )}
            </Dialog>

            {/* Digit Scanner Modal */}
            <DigitScannerModal
                isOpen={is_digit_scanner_open}
                onClose={handleDigitScannerClose}
                onApplied={handleDigitScannerApplied}
                is_running={is_running}
            />

            {/* Matches / Differs Modal */}
            <MatchesDiffersModal
                isOpen={is_matches_differs_open}
                onClose={handleMatchesDiffersClose}
                onApplied={handleMatchesDiffersApplied}
                is_running={is_running}
                store_symbol={dashboard.bot_builder_symbol}
            />
        </React.Fragment>
    );
});

export default Toolbar;
                        
