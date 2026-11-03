// ============================================================
// Bot XML patcher — complete, self-contained.
// Only mutates <field> elements whose `name` is present in the
// registry below. Everything else (stake, duration, currency,
// risk blocks, structure) is preserved byte-for-byte modulo
// whitespace reserialization by XMLSerializer.
// ============================================================

export interface BotPatch {
  symbol: string;
  direction: 'matches' | 'differs';
  digit: number;
}

export interface PlannedChange {
  blockType: string;
  field: string;
  from: string;
  to: string;
}

export interface PatchPlan {
  nextXml: string;
  changes: PlannedChange[];
  warnings: string[];
  blocked: boolean;
}

// ------------------------------------------------------------
// EDIT HERE if your bot XML uses different field names.
// These are the ONLY fields this patcher will ever touch.
// ------------------------------------------------------------
function registryFor(patch: BotPatch): Record<string, string> {
  return {
    SYMBOL_LIST: patch.symbol,
    TRADETYPE_LIST: 'digits',
    TYPE_LIST: 'matchesdiffers',
    CHECK_RESULT: patch.direction,     // 'matches' | 'differs' — adjust casing if your XML differs
    PREDICTION: String(patch.digit),
    DIGIT: String(patch.digit),
  };
}

export function planXmlPatch(xml: string, patch: BotPatch): PatchPlan {
  const warnings: string[] = [];
  let doc: Document;

  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return { nextXml: xml, changes: [], warnings: ['XML parser threw; nothing changed.'], blocked: true };
  }

  if (doc.getElementsByTagName('parsererror').length > 0) {
    return { nextXml: xml, changes: [], warnings: ['XML did not parse; nothing changed.'], blocked: true };
  }

  const registry = registryFor(patch);
  const changes: PlannedChange[] = [];
  let predictionWritten = false;
  let contractWritten = false;

  const blocks = Array.from(doc.getElementsByTagName('block'));
  for (const block of blocks) {
    const blockType = block.getAttribute('type') ?? 'unknown';
    for (const child of Array.from(block.children)) {
      if (child.tagName !== 'field') continue;
      const name = child.getAttribute('name');
      if (!name || !(name in registry)) continue;

      const to = registry[name];
      const from = child.textContent ?? '';
      if (from === to) continue;

      child.textContent = to;
      changes.push({ blockType, field: name, from, to });
      if (name === 'PREDICTION' || name === 'DIGIT') predictionWritten = true;
      if (name === 'CHECK_RESULT') contractWritten = true;
    }
  }

  if (!predictionWritten) warnings.push('No PREDICTION/DIGIT field found — digit was not written.');
  if (!contractWritten) warnings.push('No CHECK_RESULT field found — direction was not written.');
  if (!changes.length) warnings.push('No matching fields found; XML left untouched.');

  const blocked = !predictionWritten || !contractWritten;

  let nextXml = xml;
  if (changes.length) {
    nextXml = new XMLSerializer().serializeToString(doc);
  }

  return { nextXml, changes, warnings, blocked };
}