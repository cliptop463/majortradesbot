// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import React from 'react';
import { observer } from 'mobx-react-lite';
import Dialog from '@/components/shared_ui/dialog';
import { useStore } from '@/hooks/useStore';
import { DBOT_TABS } from '@/constants/bot-contents';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
/* [AI] - Analytics event tracking removed - see migrate-docs/MONITORING_PACKAGES.md for re-implementation guide */
/* [/AI] */
import ToolbarButton from './toolbar-button';
import WorkspaceGroup from './workspace-group';
import DigitScannerModal from '../digit-scanner-modal';

const Toolbar = observer(() => {
    const { run_panel, toolbar, quick_strategy, dashboard } = useStore();
    const { isDesktop } = useDevice();
    const { is_dialog_open, closeResetDialog, onResetOkButtonClick: onOkButtonClick } = toolbar;
    const { is_running } = run_panel;
    const { setFormVisibility } = quick_strategy;
    const { setActiveTab } = dashboard;
    const confirm_button_text = is_running ? localize('Yes') : localize('OK');
    const cancel_button_text = is_running ? localize('No') : localize('Cancel');
    const [is_digit_scanner_open, setIsDigitScannerOpen] = React.useState(false);

    const handleQuickStrategyOpen = () => {
        setFormVisibility(true);
        /* [AI] - Analytics event tracking removed - see migrate-docs/MONITORING_PACKAGES.md for re-implementation guide */
        /* [/AI] */
    };

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

    return (
        <React.Fragment>
            <div className='toolbar dashboard__toolbar' data-testid='dt_dashboard_toolbar'>
                <div className='toolbar__section'>
                    {!isDesktop && (
                        <ToolbarButton
                            popover_message={localize('Click here to start building your Deriv Bot.')}
                            button_id='db-toolbar__get-started-button'
                            button_classname='toolbar__btn toolbar__btn--icon toolbar__btn--start'
                            buttonOnClick={handleQuickStrategyOpen}
                            button_text={localize('Quick strategy')}
                            is_bot_running={is_running}
                        />
                    )}
                    <ToolbarButton
                        popover_message={localize('Scan volatility markets for digit patterns.')}
                        button_id='db-toolbar__digit-scanner-button'
                        button_classname='toolbar__btn toolbar__btn--icon toolbar__btn--digit-scanner'
                        buttonOnClick={handleDigitScannerOpen}
                        button_text={localize('Digit Scanner')}
                        is_bot_running={is_running}
                    />
                    {isDesktop && <WorkspaceGroup />}
                </div>
            </div>
            {!isDesktop && <WorkspaceGroup />}
            <Dialog
                portal_element_id='modal_root'
                title={localize('Are you sure?')}
                is_visible={is_dialog_open}
                confirm_button_text={confirm_button_text}
                onConfirm={onOkButtonClick}
                cancel_button_text={cancel_button_text}
                onCancel={closeResetDialog}
                is_mobile_full_width={false}
                className={'toolbar__dialog'}
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
                    <Localize i18n_default_text='Any unsaved changes will be lost.' />
                )}
            </Dialog>
            <DigitScannerModal
                isOpen={is_digit_scanner_open}
                onClose={handleDigitScannerClose}
                onApplied={handleDigitScannerApplied}
                is_running={is_running}
            />
        </React.Fragment>
    );
});

export default Toolbar;
