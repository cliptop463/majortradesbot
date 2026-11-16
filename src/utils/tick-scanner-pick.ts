/** Blockly patching helpers for High/Low Tick scanner recommendations. */
export type TickPick = { symbol: string; direction: 'HIGH' | 'LOW'; selectedTick: number };

export type TickPickPreview = {
    ok: true;
    symbol: { before: any; after: string };
    category: { before: any; after: 'highlowticks' };
    tradeType: { before: any; after: 'highlowticks' };
    type: { before: any; after: 'TICKHIGH' | 'TICKLOW' };
    selectedTick: { before: any; after: number };
};

export type TickPickResult = TickPickPreview | { ok: false; reason: string };

const field = (block: any, name: string) => block?.getFieldValue?.(name) ?? null;
const set = (block: any, name: string, value: string | number) => block?.setFieldValue?.(String(value), name);
const blocksFor = (workspace: any, type: string) => (workspace?.getAllBlocks?.() ?? []).filter((b: any) => b?.type === type);

const required = (workspace: any) => {
    const market = blocksFor(workspace, 'trade_definition_market')[0];
    const type = blocksFor(workspace, 'trade_definition_contracttype')[0];
    const trade = blocksFor(workspace, 'trade_definition_tradetype')[0];
    const options = blocksFor(workspace, 'trade_definition_tradeoptions')[0];
    if (!market || !type || !trade || !options) return null;
    return { market, type, trade, options };
};

const prediction = (options: any) => options?.getInputTargetBlock?.('PREDICTION');
const fire = (block: any, name: string, before: any, after: any) => {
    if (before === after || !window?.Blockly?.Events) return;
    window.Blockly.Events.fire(new window.Blockly.Events.BlockChange(block, 'field', name, String(before ?? ''), String(after)));
};

export const previewTickPick = (workspace: any, pick: TickPick): TickPickResult => {
    if (!pick.symbol || !Number.isInteger(pick.selectedTick) || pick.selectedTick < 1 || pick.selectedTick > 5) {
        return { ok: false, reason: 'Selected tick must be a whole number from 1 to 5.' };
    }
    const found = required(workspace);
    if (!found) return { ok: false, reason: 'Required High/Low Tick trade blocks are missing from the workspace.' };
    const p = prediction(found.options);
    return {
        ok: true,
        symbol: { before: field(found.market, 'SYMBOL_LIST'), after: pick.symbol },
        category: { before: field(found.trade, 'TRADETYPECAT_LIST'), after: 'highlowticks' },
        tradeType: { before: field(found.trade, 'TRADETYPE_LIST'), after: 'highlowticks' },
        type: { before: field(found.type, 'TYPE_LIST'), after: pick.direction === 'HIGH' ? 'TICKHIGH' : 'TICKLOW' },
        selectedTick: { before: field(p, 'NUM'), after: pick.selectedTick },
    };
};

export const applyTickPick = async (workspace: any, pick: TickPick): Promise<TickPickResult> => {
    const preview = previewTickPick(workspace, pick);
    if (!preview.ok) return preview;
    if (window?.run_panel?.is_running) return { ok: false, reason: 'Cannot apply while the bot is running.' };
    const found = required(workspace)!;
    const p = prediction(found.options);
    try {
        const group = window?.Blockly?.Events?.getGroup?.() ?? null;
        window?.Blockly?.Events?.setGroup?.('tick-scanner-pick-apply');
        const changes: Array<[any, string, any, any]> = [
            [found.market, 'SYMBOL_LIST', field(found.market, 'SYMBOL_LIST'), pick.symbol],
            [found.trade, 'TRADETYPECAT_LIST', field(found.trade, 'TRADETYPECAT_LIST'), 'highlowticks'],
            [found.trade, 'TRADETYPE_LIST', field(found.trade, 'TRADETYPE_LIST'), 'highlowticks'],
            [found.type, 'TYPE_LIST', field(found.type, 'TYPE_LIST'), pick.direction === 'HIGH' ? 'TICKHIGH' : 'TICKLOW'],
            [p, 'NUM', field(p, 'NUM'), pick.selectedTick],
        ];
        changes.forEach(([block, name, before, after]) => { if (block && before !== after) { set(block, name, after); fire(block, name, before, after); } });
        if (group !== null) window?.Blockly?.Events?.setGroup?.(group);
        return preview;
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : 'Unable to apply High/Low Tick pick.' };
    }
};
