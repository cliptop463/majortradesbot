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

/** Symbol currently chosen in the bot's market block, or null when it cannot be read. */
export const getSelectedSymbol = (workspace: any): string | null => {
    const blocks = workspace?.getAllBlocks?.() ?? [];
    const market = blocks.find((block: any) => block?.type === BLOCK_TYPES.tradeDefinitionMarket);
    const value = getFieldValue(market, FIELD_NAMES.symbol);
    return typeof value === 'string' && value.trim() !== '' ? value : null;
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

/** Option values currently offered by a dropdown field, for error messages. */
const optionValuesOf = (block: any, fieldName: string): string[] => {
    const field = block?.getField?.(fieldName);
    if (!field || typeof field.getOptions !== 'function') return [];
    const options = field.getOptions(false) ?? [];
    return options.map((option: any) => (Array.isArray(option) ? String(option[1] ?? option[0]) : String(option)));
};

const listOptions = (block: any, fieldName: string) => {
    const values = optionValuesOf(block, fieldName).filter(value => value !== '');
    return values.length ? ` Available: ${values.join(', ')}.` : ' No options are loaded yet.';
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
            return {
                ok: false,
                reason: `Digits trade type category is unavailable for this symbol.${listOptions(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory)}`,
            };
        }
        setFieldValue(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory, 'digits');
        fireFieldChange(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory, categoryBefore, 'digits');
        await sleep(100);
    }

    const tradeTypeBefore = getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType);
    if (String(tradeTypeBefore ?? '').trim() !== tradeType) {
        const tradeTypeReady = await waitForFieldOption(tradeTypeBlock, FIELD_NAMES.tradeType, tradeType);
        if (!tradeTypeReady) {
            return {
                ok: false,
                reason: `${label} trade type is unavailable for this symbol.${listOptions(tradeTypeBlock, FIELD_NAMES.tradeType)}`,
            };
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

const MAX_APPLY_ATTEMPTS = 3;
const SETTLE_MS = 350;

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

        const readState = () => ({
            symbol: getFieldValue(marketBlock, FIELD_NAMES.symbol),
            category: getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeTypeCategory),
            tradeType: getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType),
            type: getContractTypeValue(contractTypeBlock),
            prediction: getPredictionValue(predictionBlock),
        });
        type State = ReturnType<typeof readState>;

        // Blockly refreshes these dropdowns asynchronously after the contracts API answers, and a late
        // refresh can put an older value back. A pick only counts once every field holds the target.
        const matchesTarget = (st: State) =>
            st.symbol === targetSymbol &&
            String(st.category ?? '').trim() === 'digits' &&
            String(st.tradeType ?? '').trim() === spec.tradeType &&
            st.type === targetType &&
            (targetDigit === null || String(st.prediction) === String(targetDigit));

        const describeState = (st: State) =>
            `symbol ${st.symbol ?? '-'}, trade type ${st.category ?? '-'} > ${st.tradeType ?? '-'}, contract ${st.type ?? '-'}` +
            (targetDigit !== null ? `, digit ${st.prediction ?? '-'}` : '');

        const initial = readState();

        const applySteps = async (): Promise<ScannerPickFailure | { ok: true }> => {
            const symbolNow = getFieldValue(marketBlock, FIELD_NAMES.symbol);
            if (symbolNow !== targetSymbol) {
                setFieldValue(marketBlock, FIELD_NAMES.symbol, targetSymbol);
                fireFieldChange(marketBlock, FIELD_NAMES.symbol, symbolNow, targetSymbol);
                await sleep(500);
            }

            const categoryState = await ensureTradeType(tradeTypeBlock, spec.tradeType, spec.label);
            if (!categoryState.ok) {
                return categoryState;
            }

            await sleep(250);

            const typeNow = getContractTypeValue(contractTypeBlock);
            if (typeNow !== targetType) {
                const contractTypeReady = await waitForFieldOption(contractTypeBlock, FIELD_NAMES.type, targetType);
                if (!contractTypeReady) {
                    return {
                        ok: false,
                        reason: `${spec.label} contract type is unavailable for symbol ${targetSymbol}. Trade type is currently ${
                            getFieldValue(tradeTypeBlock, FIELD_NAMES.tradeType) ?? '-'
                        }.${listOptions(contractTypeBlock, FIELD_NAMES.type)}`,
                    };
                }
                setFieldValue(contractTypeBlock, FIELD_NAMES.type, targetType);
                fireFieldChange(contractTypeBlock, FIELD_NAMES.type, typeNow, targetType);
                await sleep(200);
            }

            if (spec.hasBarrier && targetDigit !== null) {
                const predictionTarget = await waitForPredictionInput(predictionBlock, 3000);
                if (!predictionTarget) {
                    return { ok: false, reason: 'Prediction input not available for this trade type.' };
                }
                const predictionNow = getPredictionValue(predictionBlock);
                if (predictionNow !== targetDigit && String(predictionNow) !== String(targetDigit)) {
                    setPredictionValue(predictionBlock, targetDigit);
                    fireFieldChange(predictionTarget, 'NUM', predictionNow, targetDigit);
                }
            }
            return { ok: true };
        };

        const originalGroup = window?.Blockly?.Events?.getGroup?.() ?? null;
        window.Blockly.Events.setGroup('scanner-pick-apply');

        try {
            let failure: ScannerPickFailure | null = null;

            for (let attempt = 1; attempt <= MAX_APPLY_ATTEMPTS; attempt++) {
                const stepResult = await applySteps();
                if (!stepResult.ok) {
                    failure = stepResult as ScannerPickFailure;
                    if (attempt < MAX_APPLY_ATTEMPTS) await sleep(600);
                    continue;
                }

                // Let any late Blockly refresh land, then require the values to still be there.
                await sleep(SETTLE_MS);
                if (matchesTarget(readState())) {
                    await sleep(SETTLE_MS);
                    const final = readState();
                    if (matchesTarget(final)) {
                        workspace?.render?.();
                        return {
                            ok: true,
                            symbol: { before: initial.symbol, after: targetSymbol },
                            category: preview.category,
                            tradeType: preview.tradeType,
                            type: { before: initial.type, after: targetType },
                            prediction:
                                targetDigit === null ? null : { before: initial.prediction, after: targetDigit },
                        };
                    }
                }
                failure = {
                    ok: false,
                    reason: `Blockly did not keep the ${spec.label} settings after ${attempt} attempt(s). Expected ${spec.tradeType} > ${targetType}; found ${describeState(
                        readState()
                    )}.`,
                };
            }

            return failure ?? { ok: false, reason: 'Unable to apply scanner pick.' };
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
