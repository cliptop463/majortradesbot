// ============================================================
// Digit Scanner Modal — complete, self-contained.
// Props are the only external wiring needed. Never calls
// start_bot, never submits a trade, never auto-confirms.
//

 ============================================================

import React, { useState } from 'react';
import {
  scanMarkets,
  DEFAULT_MARKETS,
  type ScanReport,
  type MarketScanResult,
} from '../services/digitScanner';
import {
  scanMarkets, DEFAULT_MARKETS, planXmlPatch,
  type ScanReport, type MarketScanResult, type PatchPlan,
} from '../services/digitScanner';

export interface DigitScannerModalProps {
  open: boolean;
  onClose: () => void;
  sendRequest: (payload: Record<string, unknown>) => Promise<any>;
  getXml: () => string;
  applyXml: (xml: string) => void;
  botRunning?: boolean;
}

export function DigitScannerModal({
  open, onClose, sendRequest, getXml, applyXml, botRunning = false,
}: DigitScannerModalProps) {
  const [report, setReport] = useState<ScanReport | null>(null);
  const [selected, setSelected] = useState<MarketScanResult | null>(null);
  const [plan, setPlan] = useState<PatchPlan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const runScan = async () => {
    setScanning(true);
    setReport(null);
    setSelected(null);
    setPlan(null);
    setApplied(false);
    setError(null);
    try {
      const r = await scanMarkets({
        sendRequest,
        markets: DEFAULT_MARKETS,
        tickCount: 1000,
        minTicks: 200,
      });
      setReport(r);
      setSelected(r.winner);
    } catch (e: any) {
      setError(e?.message ?? 'Scan failed.');
    } finally {
      setScanning(false);
    }
  };

  const preview = () => {
    if (!selected?.ensemble) return;
    const p = planXmlPatch(getXml(), {
      symbol: selected.symbol,
      direction: selected.ensemble.signal === 'MATCHES' ? 'matches' : 'differs',
      digit: selected.ensemble.digit,
    });
    setPlan(p);
    setApplied(false);
  };

  const confirmApply = () => {
    if (!plan || plan.blocked) return;
    applyXml(plan.nextXml);
    setApplied(true);
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <span style={styles.title}>Digit Scanner</span>
          <button style={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        {botRunning && (
          <div style={styles.blockBanner}>
            Bot is running. Stop it before applying changes.
          </div>
        )}

        {!report && !scanning && (
          <button style={styles.primaryBtn} onClick={runScan} disabled={botRunning}>
            Scan markets
          </button>
        )}

        {scanning && <div style={styles.status}>Scanning markets…</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {report && (
          <div style={styles.body}>
            {report.excluded.length > 0 && (
              <div style={styles.warnBlock}>
                <div style={styles.warnTitle}>Excluded markets</div>
                {report.excluded.map((m) => (
                  <div key={m.symbol} style={styles.warnRow}>
                    <b>{m.displayName}</b> ({m.symbol}) — {m.message ?? m.status}
                  </div>
                ))}
              </div>
            )}

            {report.ranked.length === 0 && (
              <div style={styles.errorBanner}>
                No market produced a valid signal.
              </div>
            )}

            {report.ranked.length > 0 && (
              <>
                <div style={styles.sectionTitle}>Ranked markets</div>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Market</th>
                      <th style={styles.th}>Call</th>
                      <th style={styles.th}>Score</th>
                      <th style={styles.th}>Agree</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.ranked.map((m) => (
                      <tr
                        key={m.symbol}
                        style={selected?.symbol === m.symbol ? styles.rowSelected : styles.row}
                        onClick={() => { setSelected(m); setPlan(null); setApplied(false); }}
                      >
                        <td style={styles.td}>{m.displayName}</td>
                        <td style={styles.td}>
                          {m.ensemble!.signal} {m.ensemble!.digit}
                        </td>
                        <td style={styles.td}>
                          {m.ensemble!.score}/100
                          <div style={styles.tiny}>not a probability</div>
                        </td>
                        <td style={styles.td}>
                          {m.ensemble!.agreeCount}/{m.ensemble!.eligibleCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {selected?.ensemble && (
              <>
                <div style={styles.sectionTitle}>
                  Selected: {selected.displayName} — {selected.ensemble.signal} {selected.ensemble.digit}
                </div>
                <div style={styles.tiny}>
                  Heuristic score: {selected.ensemble.score}/100 (not a win probability)
                </div>

                <div style={styles.sectionTitle}>Strategy signals</div>
                {selected.ensemble.strategies.map((s) => (
                  <div key={s.id} style={styles.strategyRow}>
                    <div>
                      <b>{s.name}</b>{' '}
                      {s.signal === 'ABSTAIN'
                        ? <span style={styles.abstain}>ABSTAIN</span>
                        : <span>{s.signal} {s.digit}</span>}
                    </div>
                    <div style={styles.tiny}>{s.reason}</div>
                  </div>
                ))}

                <div style={styles.sectionTitle}>Apply to bot</div>
                {!plan && (
                  <button
                    style={styles.primaryBtn}
                    onClick={preview}
                    disabled={botRunning}
                  >
                    Preview XML changes
                  </button>
                )}

                {plan && (
                  <div style={styles.previewBox}>
                    <div>
                      Market: <b>{selected.symbol}</b> &nbsp;|&nbsp;
                      Direction: <b>{selected.ensemble.signal === 'MATCHES' ? 'matches' : 'differs'}</b> &nbsp;|&nbsp;
                      Digit: <b>{selected.ensemble.digit}</b>
                    </div>

                    {plan.changes.length > 0 && (
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Block</th>
                            <th style={styles.th}>Field</th>
                            <th style={styles.th}>From</th>
                            <th style={styles.th}>To</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.changes.map((c, i) => (
                            <tr key={i} style={styles.row}>
                              <td style={styles.td}>{c.blockType}</td>
                              <td style={styles.td}>{c.field}</td>
                              <td style={styles.td}>{c.from || '(empty)'}</td>
                              <td style={styles.td}>{c.to}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {plan.warnings.map((w, i) => (
                      <div key={i} style={styles.warnRow}>⚠ {w}</div>
                    ))}

                    {!plan.blocked && !applied && (
                      <button
                        style={styles.primaryBtn}
                        onClick={confirmApply}
                        disabled={botRunning}
                      >
                        Confirm &amp; apply
                      </button>
                    )}
                    {applied && <div style={styles.okBanner}>Applied. Bot was not started.</div>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Inline styles — zero external CSS dependency.
// ------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#fff', color: '#111', width: 'min(760px, 96vw)',
    maxHeight: '92vh', overflowY: 'auto', borderRadius: 10, padding: 16,
    fontFamily: 'system-ui, sans-serif', fontSize: 14 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12 },
  title: { fontSize: 18, fontWeight: 700 },
  closeBtn: { background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer' },
  body: { display: 'flex', flexDirection: 'column', gap: 10 },
  sectionTitle: { fontWeight: 700, marginTop: 8 },
  status: { padding: 12, color: '#555' },
  tiny: { fontSize: 11, color: '#666' },
  primaryBtn: { background: '#0a66ff', color: '#fff', border: 'none',
    padding: '10px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 600 },
  table: { width: '100%', borderCollapse: 'collapse', marginTop: 6 },
  th: { textAlign: 'left', borderBottom: '1px solid #ddd', padding: 6, fontSize: 12, color: '#444' },
  td: { borderBottom: '1px solid #eee', padding: 6, verticalAlign: 'top' },
  row: { cursor: 'pointer' },
  rowSelected: { cursor: 'pointer', background: '#eaf1ff' },
  strategyRow: { padding: '6px 0', borderBottom: '1px dashed #eee' },
  abstain: { color: '#999', fontWeight: 600 },
  previewBox: { border: '1px solid #ccc', borderRadius: 6, padding: 10,
    display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 },
  warnBlock: { background: '#fff5e5', border: '1px solid #f0c36d',
    padding: 10, borderRadius: 6 },
  warnTitle: { fontWeight: 700, marginBottom: 4 },
  warnRow: { color: '#8a5b00', fontSize: 12, marginTop: 4 },
  blockBanner: { background: '#ffdede', border: '1px solid #e38a8a',
    padding: 10, borderRadius: 6, color: '#7a1111', marginBottom: 8 },
  errorBanner: { background: '#ffdede', border: '1px solid #e38a8a',
    padding: 10, borderRadius: 6, color: '#7a1111' },
  okBanner: { background: '#e3f6e6', border: '1px solid #8fd39a',
    padding: 10, borderRadius: 6, color: '#175c25' },
};