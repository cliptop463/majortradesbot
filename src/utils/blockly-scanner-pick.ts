export type ScannerPickDirection = 'MATCHES' | 'DIFFERS';

export type ScannerPickInput = {
    symbol: string;
    direction: ScannerPickDirection;
    digit: number;
};

export type ScannerPickFieldPreview = {
    before: string | number | null;
    after: string | number | null;
};

export type ScannerPickPreview = {
    ok: true;
    symbol: ScannerPickFieldPreview;
    type: ScannerPickFieldPreview;
    prediction: ScannerPickFieldPreview;
};

export type ScannerPickFailure = {
    ok: false;
    reason: string;
};

export type ScannerPickResult = ScannerPickPreview | ScannerPickFailure;

const FIELD_NAMES = {
    symbol: 'SYMBOL_LIST',
    type: 'TYPE_LIST',
    prediction: 'PREDICTION',
    tradeTypeCategory: 'TRADETYPECAT_LIST',
    tradeType: 'TRADETYPE_LIST',
};

const BLOCK_TYPES = {
    tradeDefinition: 'trade_definition',
    tradeDefinitionMarket: 'trade_definition_market',
    tradeDefinitionType: 'trade_definition_tradetype',
    tradeDefinitionContractType: 'trade_definition_contracttype',
    tradeDefinitionTradeOptions: 'trade_definition_tradeoptions',
};

const getFieldValue = (block: any, fieldName: string): string | number | null => {
    if (!block || typeof block.getFieldValue !== 'function') return null;
    const value = block.getFieldValue(fieldName);
    return value === undefined || value === null ? null : value;
};

const setFieldValue = (block: any, fieldName: string, value: string | number) => {
    if (!block || typeof block.setFieldValue !== 'function') return;
    block.setFieldValue(String(value), fieldName);
};

const fireFieldChange = (block: any, fieldName: string, before: string | number | null, after: string | number | null) => {
    if (!block || !window?.Blockly?.Events) return;
    if (before === after) return;

    const event = new window.Blockly.Events.BlockChange(block, 'field', fieldName, before, after);
    window.Blockly.Events.fire(event);
};

const waitForFieldPopulation = async (block: any, fieldName: string, timeoutMs = 1500): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const value = getFieldValue(block, fieldName);
        if (value !== null && value !== undefined && String(value).trim() !== '') {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
};

const findRequiredBlocks = (workspace: any) => {
    const blocks = workspace?.getAllBlocks?.() ?? [];

    const tradeDefinitions = blocks.filter((block: any) => block?.type === BLOCK_TYPES.tradeDefinition);
    if (tradeDefinitions.length !== 1) {
        return {
            ok: false as const,
            reason:
                tradeDefinitions.length === 0
                    ? 'No trade_definition block found in the workspace.'
                    : 'Multiple trade_definition blocks found. Refusing to apply the scanner pick.',
        };
    }

    const tradeDefinition = tradeDefinitions[0];

    const marketBlocks = blocks.filter((block: any) => block?.type === BLOCK_TYPES.tradeDefinitionMarket);
    if (marketBlocks.length !== 1) {
        return {
            ok: false as const,
            reason:
                marketBlocks.length === 0
                    ? 'Missing trade_definition_market block.'
                    : 'Duplicate trade_definition_market blocks found.',
        };
    }

    const contractTypeBlocks = blocks.filter((block: any) => block?.type === BLOCK_TYPES.tradeDefinitionContractType);
    if (contractTypeBlocks.length !== 1) {
        return {
            ok: false as const,
            reason:
                contractTypeBlocks.length === 0
                    ? 'Missing trade_definition_contracttype block.'
                    : 'Duplicate trade_definition_contracttype blocks found.',
        };
    }

    const tradeOptionBlocks = blocks.filter((block: any) => block?.type === BLOCK_TYPES.tradeDefinitionTradeOptions);
    if (tradeOptionBlocks.length !== 1) {
        return {
            ok: false as const,
            reason:
                tradeOptionBlocks.length === 0
                    ? 'Missing trade_definition_tradeoptions block.'
                    : 'Duplicate trade_definition_tradeoptions blocks found.',
        };
    }

    const tradeTypeBlocks = blocks.filter((block: any) => block?.type === BLOCK_TYPES.tradeDefinitionType);
    if (tradeTypeBlocks.length !== 1) {
        return {
            ok: false as const,
            reason:
                tradeTypeBlocks.length === 0
                    ? 'Missing trade_definition_tradetype block.'
                    : 'Duplicate trade_definition_tradetype blocks found.',
        };
    }

    return {
        ok: true as const,
        tradeDefinition,
        marketBlock: marketBlocks[0],
        contractTypeBlock: contractTypeBlocks[0],
        predictionBlock: tradeOptionBlocks[0],
        tradeTypeBlock: tradeTypeBlocks[0],
    };
};

const isBotRunning = () => !!window?.run_panel?.is_running;

const normalizeDigit = (digit: number) => {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
        throw new RangeError(`Digit must be an integer from 0 to 9, received: ${digit}`);
    }
    return digit;
};

const getPredictionValue = (block: any): string | number | null => {
    if (!block) return null;
    const direct = getFieldValue(block, FIELD_NAMES.prediction);
    if (direct !== null) return direct;
    const nested = getFieldValue(block, 'NUM');
    return nested !== null ? nested : null;
};

const getContractTypeValue = (block: any): string | number | null => {
    if (!block) return null;
    const value = getFieldValue(block, FIELD_NAMES.type);
    if (value !== null) return value;
    return getFieldValue(block, 'TYPE_LIST');
};

export const previewScannerPick = (workspace: any, pick: ScannerPickInput): ScannerPickResult => {
    try {
        const validatedDigit = normalizeDigit(pick.digit);
        const required = findRequiredBlocks(workspace);
        if (!required.ok) {
            return { ok: false, reason: required.reason };
        }

        const { marketBlock, contractTypeBlock, predictionBlock, tradeTypeBlock } = required;

        const currentTradeType = getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType);
        if (currentTradeType !== 'matchesdiffers') {
            return {
                ok: false,
                reason: `Refusing scanner pick: trade type must be matchesdiffers, found ${String(currentTradeType ?? 'missing')}.`,
            };
        }

        const symbolBefore = getFieldValue(marketBlock, FIELD_NAMES.symbol);
        const typeBefore = getContractTypeValue(contractTypeBlock);
        const predictionBefore = getPredictionValue(predictionBlock);

        const targetType = pick.direction === 'MATCHES' ? 'DIGITMATCH' : 'DIGITDIFF';
        const symbolAfter = pick.symbol;
        const typeAfter = targetType;
        const predictionAfter = validatedDigit;

        return {
            ok: true,
            symbol: { before: symbolBefore, after: symbolAfter },
            type: { before: typeBefore, after: typeAfter },
            prediction: { before: predictionBefore, after: predictionAfter },
        };
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : 'Unable to preview scanner pick.',
        };
    }
};

export const applyScannerPick = async (workspace: any, pick: ScannerPickInput): Promise<ScannerPickResult> => {
    try {
        const preview = previewScannerPick(workspace, pick);
        if (!preview.ok) {
            return preview;
        }

        if (isBotRunning()) {
            return { ok: false, reason: 'Refusing scanner pick while the bot is running.' };
        }

        const required = findRequiredBlocks(workspace);
        if (!required.ok) {
            return { ok: false, reason: required.reason };
        }

        const { marketBlock, contractTypeBlock, predictionBlock } = required;

        const targetType = pick.direction === 'MATCHES' ? 'DIGITMATCH' : 'DIGITDIFF';
        const targetSymbol = pick.symbol;
        const targetDigit = normalizeDigit(pick.digit);

        const originalGroup = window?.Blockly?.Events?.getGroup?.() ?? null;
        window.Blockly.Events.setGroup('scanner-pick-apply');

        try {
            const symbolBefore = getFieldValue(marketBlock, FIELD_NAMES.symbol);
            if (symbolBefore !== targetSymbol) {
                setFieldValue(marketBlock, FIELD_NAMES.symbol, targetSymbol);
                fireFieldChange(marketBlock, FIELD_NAMES.symbol, symbolBefore, targetSymbol);
            }

            await new Promise(resolve => setTimeout(resolve, 250));

            const typeBefore = getContractTypeValue(contractTypeBlock);
            if (typeBefore !== targetType) {
                setFieldValue(contractTypeBlock, FIELD_NAMES.type, targetType);
                fireFieldChange(contractTypeBlock, FIELD_NAMES.type, typeBefore, targetType);
            }

            await new Promise(resolve => setTimeout(resolve, 150));

            const predictionBefore = getPredictionValue(predictionBlock);
            if (predictionBefore !== targetDigit) {
                setFieldValue(predictionBlock, FIELD_NAMES.prediction, targetDigit);
                fireFieldChange(predictionBlock, FIELD_NAMES.prediction, predictionBefore, targetDigit);
            }

            workspace?.render?.();

            return {
                ok: true,
                symbol: { before: symbolBefore, after: targetSymbol },
                type: { before: typeBefore, after: targetType },
                prediction: { before: predictionBefore, after: targetDigit },
            };
        } finally {
            if (window?.Blockly?.Events) {
                window.Blockly.Events.setGroup(originalGroup);
            }
        }
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : 'Unable to apply scanner pick.',
        };
    }
};
