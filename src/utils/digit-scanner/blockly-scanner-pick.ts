import { CONTRACTS, barrierError } from './digit-scanner/contracts';
import type { Direction } from './digit-scanner/types';

export type ScannerPickDirection = Direction;

export type ScannerPickInput = {
    symbol: string;
    direction: ScannerPickDirection;
    /** Prediction digit. Required for Matches/Differs and Over/Under; ignored for Even/Odd. */
    digit?: number | null;
};

export type ScannerPickFieldPreview = {
    before: string | number | null;
    after: string | number | null;
};

export type ScannerPickPreview = {
    ok: true;
    symbol: ScannerPickFieldPreview;
    /** Trade type category field (TRADETYPECAT_LIST), set to 'digits'. */
    category: ScannerPickFieldPreview;
    /** Trade type field (TRADETYPE_LIST): matchesdiffers, evenodd or overunder. */
    tradeType: ScannerPickFieldPreview;
    /** Contract type field (TYPE_LIST): DIGITMATCH/DIGITDIFF, DIGITEVEN/DIGITODD or DIGITOVER/DIGITUNDER. */
    type: ScannerPickFieldPreview;
    /** Prediction digit. null when the chosen contract has none (Even/Odd): the field is left untouched. */
    prediction: ScannerPickFieldPreview | null;
};

export type ScannerPickFailure = {
    ok: false;
    reason: string;
    /** True when a required block or field is missing: the patch is BLOCKED and nothing is written. */
    blocked?: boolean;
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
        await sleep(50);
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

const waitForFieldOption = async (
    block: any,
    fieldName: string,
    optionValue: string,
    timeoutMs = 3000
): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const field = block?.getField?.(fieldName);
        if (field && typeof field.getOptions === 'function') {
            const options = field.getOptions(false) ?? [];
            const optionValues = options.flatMap((option: any) => {
                if (Array.isArray(option)) {
                    return option.map(value => String(value));
                }
                return [String(option)];
            });
            if (optionValues.includes(String(optionValue))) {
                return true;
            }
        }
        await sleep(50);
    }
    return false;
};

const getPredictionBlock = (block: any): any => {
    if (!block) return null;
    const input = block.getInput?.('PREDICTION');
    if (!input) return null;
    return block.getInputTargetBlock?.('PREDICTION') ?? null;
};

const waitForPredictionInput = async (block: any, timeoutMs = 3000): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const input = block?.getInput?.('PREDICTION');
        const target = input ? block.getInputTargetBlock?.('PREDICTION') : null;
        if (input && target) {
            return target;
        }
        await sleep(50);
    }
    return null;
};

const getPredictionValue = (block: any): string | number | null => {
    const predictionBlock = getPredictionBlock(block);
    if (!predictionBlock) return null;
    return getFieldValue(predictionBlock, 'NUM');
};

const setPredictionValue = (block: any, value: number): boolean => {
    const predictionBlock = getPredictionBlock(block);
    if (!predictionBlock) return false;
    setFieldValue(predictionBlock, 'NUM', value);
    return true;
};

const getContractTypeValue = (block: any): string | number | null => {
    if (!block) return null;
    const value = getFieldValue(block, FIELD_NAMES.type);
    if (value !== null) return value;
    return getFieldValue(block, 'TYPE_LIST');
};

export const ensureTradeType = async (
    tradeTypeBlock: any,
    tradeType: string,
    label: string
): Promise<ScannerPickFailure | { ok: true }> => {
    if (!tradeTypeBlock) {
        return { ok: false, reason: 'Missing trade_definition_tradetype block.' };
    }

    const categoryBefore = getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory);
    if (String(categoryBefore ?? '').trim() !== 'digits') {
        const categoryReady = await waitForFieldOption(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory, 'digits');
        if (!categoryReady) {
            return { ok: false, reason: 'Digits trade type category is unavailable for this symbol.' };
        }
        setFieldValue(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory, 'digits');
        fireFieldChange(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory, categoryBefore, 'digits');
        await sleep(100);
    }

    const tradeTypeBefore = getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType);
    if (String(tradeTypeBefore ?? '').trim() !== tradeType) {
        const tradeTypeReady = await waitForFieldOption(tradeTypeBlock, FIELD_NAMES.tradeType, tradeType);
        if (!tradeTypeReady) {
            return { ok: false, reason: `${label} trade type is unavailable for this symbol.` };
        }
        setFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType, tradeType);
        fireFieldChange(tradeTypeBlock, FIELD_NAMES.tradeType, tradeTypeBefore, tradeType);
        await sleep(100);
    }

    return { ok: true };
};

/** Kept for existing callers. */
export const ensureMatchesDiffers = (tradeTypeBlock: any) =>
    ensureTradeType(tradeTypeBlock, 'matchesdiffers', 'Matches/Differs');

const blocked = (reason: string): ScannerPickFailure => ({ ok: false, blocked: true, reason: `BLOCKED: ${reason}` });

/** Returns the name of the first required field missing from its block, or null when all are present. */
const findMissingField = (marketBlock: any, tradeTypeBlock: any): string | null => {
    const checks: Array<[any, string]> = [
        [marketBlock, FIELD_NAMES.symbol],
        [tradeTypeBlock, FIELD_NAMES.tradeTypeCategory],
        [tradeTypeBlock, FIELD_NAMES.tradeType],
    ];
    for (const [block, fieldName] of checks) {
        if (typeof block?.getField === 'function' && !block.getField(fieldName)) {
            return fieldName;
        }
    }
    return null;
};

export const previewScannerPick = (workspace: any, pick: ScannerPickInput): ScannerPickResult => {
    try {
        const spec = CONTRACTS[pick.direction];
        if (!spec) {
            throw new RangeError(`Unsupported direction: ${pick.direction}`);
        }
        const digitProblem = barrierError(pick.direction, pick.digit);
        if (digitProblem) {
            throw new RangeError(digitProblem);
        }
        const required = findRequiredBlocks(workspace);
        if (!required.ok) {
            return blocked(required.reason);
        }

        const { marketBlock, contractTypeBlock, predictionBlock, tradeTypeBlock } = required;

        const missingField = findMissingField(marketBlock, tradeTypeBlock);
        if (missingField) {
            return blocked(`Required field ${missingField} was not found on its block.`);
        }

        const symbolBefore = getFieldValue(marketBlock, FIELD_NAMES.symbol);
        const typeBefore = getContractTypeValue(contractTypeBlock);
        const predictionBefore = getPredictionValue(predictionBlock);
        const categoryBefore = getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory);
        const tradeTypeBefore = getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType);

        const symbolAfter = pick.symbol;
        const typeAfter = spec.typeValue;

        return {
            ok: true,
            symbol: { before: symbolBefore, after: symbolAfter },
            category: { before: categoryBefore, after: 'digits' },
            tradeType: { before: tradeTypeBefore, after: spec.tradeType },
            type: { before: typeBefore, after: typeAfter },
            prediction: spec.hasBarrier ? { before: predictionBefore, after: pick.digit as number } : null,
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
            return blocked(required.reason);
        }

        const { marketBlock, contractTypeBlock, predictionBlock, tradeTypeBlock } = required;

        const spec = CONTRACTS[pick.direction];
        const targetType = spec.typeValue;
        const targetSymbol = pick.symbol;
        const targetDigit = spec.hasBarrier ? (pick.digit as number) : null;

        const originalGroup = window?.Blockly?.Events?.getGroup?.() ?? null;
        window.Blockly.Events.setGroup('scanner-pick-apply');

        try {
            const symbolBefore = getFieldValue(marketBlock, FIELD_NAMES.symbol);
            if (symbolBefore !== targetSymbol) {
                setFieldValue(marketBlock, FIELD_NAMES.symbol, targetSymbol);
                fireFieldChange(marketBlock, FIELD_NAMES.symbol, symbolBefore, targetSymbol);
            }

            await sleep(500);

            const categoryState = await ensureTradeType(tradeTypeBlock, spec.tradeType, spec.label);
            if (!categoryState.ok) {
                return categoryState;
            }

            await sleep(250);

            const typeBefore = getContractTypeValue(contractTypeBlock);
            if (typeBefore !== targetType) {
                const contractTypeReady = await waitForFieldOption(contractTypeBlock, FIELD_NAMES.type, targetType);
                if (!contractTypeReady) {
                    return {
                        ok: false,
                        reason: `${spec.label} contract type is unavailable for symbol ${targetSymbol}.`,
                    };
                }
                setFieldValue(contractTypeBlock, FIELD_NAMES.type, targetType);
                fireFieldChange(contractTypeBlock, FIELD_NAMES.type, typeBefore, targetType);
                await sleep(200);
            }

            let predictionBefore: string | number | null = null;
            if (spec.hasBarrier && targetDigit !== null) {
                const predictionTarget = await waitForPredictionInput(predictionBlock, 3000);
                if (!predictionTarget) {
                    return { ok: false, reason: 'Prediction input not available for this trade type.' };
                }

                predictionBefore = getPredictionValue(predictionBlock);
                if (predictionBefore !== targetDigit) {
                    setPredictionValue(predictionBlock, targetDigit);
                    fireFieldChange(predictionTarget, 'NUM', predictionBefore, targetDigit);
                }
            }

            workspace?.render?.();

            return {
                ok: true,
                symbol: { before: symbolBefore, after: targetSymbol },
                category: preview.category,
                tradeType: preview.tradeType,
                type: { before: typeBefore, after: targetType },
                prediction: targetDigit === null ? null : { before: predictionBefore, after: targetDigit },
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

export { getPredictionValue, setPredictionValue };

export const __testing__ = {
    waitForFieldOption,
    waitForPredictionInput,
    getPredictionBlock,
};

export default {
    previewScannerPick,
    applyScannerPick,
    ensureMatchesDiffers,
    ensureTradeType,
};
