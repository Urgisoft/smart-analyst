/**
 * Tests for src/server/etf_flow_cross_validation.ts (Gap #9 v2 framework).
 *
 * Pure-function tests + composite-orchestrator integration. No CH dependency.
 *
 * T-EFXV-1..T-EFXV-7 pin the comparator + summary contract;
 * T-EFXV-8 pins the composite-evaluator wiring (snapshot.crossValidation
 * populated on secondary-panel input; null when secondary panel is omitted
 * OR empty OR has no intersection with the primary panel).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySeverity,
  compareEtfFlowPanels,
  summarizeDivergences,
  XV_DIVERGENCE_ENTRY_THRESHOLD,
  XV_SEVERITY_INFO_UPPER,
  XV_SEVERITY_WARN_UPPER,
  XV_TOP_DIVERGENCES_N,
  type EtfFlowPrimaryPoint,
  type EtfFlowSecondaryPoint,
} from '../../src/server/etf_flow_cross_validation.js';
import {
  evaluateEtfFlowComposite,
  FLOW_WINDOW_BD,
  type EtfFlowInputs,
  type EtfFlowPerEtfInput,
} from '../../src/server/etf_flow.js';

const ASOF = new Date('2026-05-19T12:00:00Z');

/** A 21-element flat shares panel — sufficient to exercise the composite's
 *  computeFlowDollar20bd invariant without engaging baseline z-scoring. */
function flatPerEtfInput(ticker: string): EtfFlowPerEtfInput {
  return {
    ticker,
    shares21: Array.from({ length: FLOW_WINDOW_BD + 1 }, () => 1_000_000),
    closes21: Array.from({ length: FLOW_WINDOW_BD + 1 }, () => 100),
    baseline1yFlowPctAum: [],
    baseline1yReturn20bd: [],
    bdSinceShareUpdate: 0,
  };
}

describe('classifySeverity — boundary tests (T-EFXV-1)', () => {
  it('T-EFXV-1a info tier for sub-WARN-upper |pct|', () => {
    assert.equal(classifySeverity(0), 'info');
    assert.equal(classifySeverity(0.001), 'info');
    assert.equal(classifySeverity(XV_SEVERITY_INFO_UPPER - 1e-9), 'info');
  });
  it('T-EFXV-1b warn tier at [INFO_UPPER, WARN_UPPER)', () => {
    assert.equal(classifySeverity(XV_SEVERITY_INFO_UPPER), 'warn');
    assert.equal(classifySeverity(XV_SEVERITY_INFO_UPPER + 1e-9), 'warn');
    assert.equal(classifySeverity(XV_SEVERITY_WARN_UPPER - 1e-9), 'warn');
  });
  it('T-EFXV-1c critical tier at WARN_UPPER and above', () => {
    assert.equal(classifySeverity(XV_SEVERITY_WARN_UPPER), 'critical');
    assert.equal(classifySeverity(XV_SEVERITY_WARN_UPPER + 1e-9), 'critical');
    assert.equal(classifySeverity(0.5), 'critical');
  });
});

describe('compareEtfFlowPanels — comparator contract', () => {
  it('T-EFXV-2 emits zero divergences when panels match exactly', () => {
    const primary: EtfFlowPrimaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1_000_000_000, close: 500 },
      { ticker: 'QQQ', date: '2026-05-19', shares: 500_000_000,   close: 450 },
    ];
    const secondary: EtfFlowSecondaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1_000_000_000, close: 500 },
      { ticker: 'QQQ', date: '2026-05-19', shares: 500_000_000,   close: 450 },
    ];
    const { divergences, totalCompared } = compareEtfFlowPanels(primary, secondary);
    assert.equal(divergences.length, 0);
    assert.equal(totalCompared, 2);
  });

  it('T-EFXV-3 emits divergence above shares-pct threshold; severity correct', () => {
    // 3% shares delta is in WARN tier (>= 2%, < 5%); close matches so AUM
    // delta is also ~3% (driven by shares); severity should be 'warn'.
    const primary: EtfFlowPrimaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1_000_000_000, close: 500 },
    ];
    const secondary: EtfFlowSecondaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1_030_000_000, close: 500 },
    ];
    const { divergences, totalCompared } = compareEtfFlowPanels(primary, secondary);
    assert.equal(totalCompared, 1);
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0].severity, 'warn');
    // sharesPctDiff = (1000 - 1030) / max(1000, 1030) = -30/1030 ≈ -0.02913.
    assert.ok(Math.abs(divergences[0].sharesPctDiff + 30 / 1030) < 1e-9);
    // Sub-threshold (< 0.5%) divergences MUST NOT emit.
    const subPrimary: EtfFlowPrimaryPoint[] = [
      { ticker: 'IVV', date: '2026-05-19', shares: 1_000_000_000, close: 500 },
    ];
    const subSecondary: EtfFlowSecondaryPoint[] = [
      { ticker: 'IVV', date: '2026-05-19', shares: 1_001_000_000, close: 500 },
    ];
    const sub = compareEtfFlowPanels(subPrimary, subSecondary);
    assert.equal(sub.divergences.length, 0);
    assert.equal(sub.totalCompared, 1);
  });

  it('T-EFXV-4 emits divergence above AUM-pct threshold even when shares match', () => {
    // Shares identical; close differs by 10% ⇒ AUM diverges by 10% ⇒ critical.
    const primary: EtfFlowPrimaryPoint[] = [
      { ticker: 'TLT', date: '2026-05-19', shares: 500_000_000, close: 90 },
    ];
    const secondary: EtfFlowSecondaryPoint[] = [
      { ticker: 'TLT', date: '2026-05-19', shares: 500_000_000, close: 100 },
    ];
    const { divergences, totalCompared } = compareEtfFlowPanels(primary, secondary);
    assert.equal(totalCompared, 1);
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0].severity, 'critical');
    assert.equal(divergences[0].sharesPctDiff, 0);
    // |aumPctDiff| = |(45e9 - 50e9) / 50e9| = 0.10 ≥ 0.05 ⇒ critical.
    assert.ok(Math.abs(divergences[0].aumPctDiff + 0.10) < 1e-9);
  });

  it('T-EFXV-5 skips (ticker, date) pairs missing from either panel', () => {
    // Primary has 3 (ticker, date) pairs; secondary has 2; intersection = 1.
    const primary: EtfFlowPrimaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1e9,  close: 500 },
      { ticker: 'SPY', date: '2026-05-18', shares: 1e9,  close: 499 },
      { ticker: 'QQQ', date: '2026-05-19', shares: 5e8,  close: 450 },
    ];
    const secondary: EtfFlowSecondaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1.1e9, close: 500 }, // intersect
      { ticker: 'IWM', date: '2026-05-19', shares: 3e8,   close: 220 }, // primary-absent
    ];
    const { divergences, totalCompared } = compareEtfFlowPanels(primary, secondary);
    assert.equal(totalCompared, 1, 'only (SPY, 2026-05-19) intersects');
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0].ticker, 'SPY');
    assert.equal(divergences[0].date, '2026-05-19');
    // (SPY, 2026-05-18) is primary-only — no divergence row.
    // (IWM, 2026-05-19) is secondary-only — no divergence row.
  });

  it('T-EFXV-6 severity = max(shares-severity, aum-severity) when both diverge', () => {
    // Shares diverge by 1% (info-tier) AND close diverges by 6% (critical).
    // Combined severity should be critical (the higher tier).
    const primary: EtfFlowPrimaryPoint[] = [
      { ticker: 'GLD', date: '2026-05-19', shares: 100_000_000, close: 200 },
    ];
    const secondary: EtfFlowSecondaryPoint[] = [
      { ticker: 'GLD', date: '2026-05-19', shares: 101_000_000, close: 188 },
    ];
    const { divergences } = compareEtfFlowPanels(primary, secondary);
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0].severity, 'critical');
  });
});

describe('summarizeDivergences — aggregation contract (T-EFXV-7)', () => {
  it('T-EFXV-7 aggregates byTicker + bySeverity correctly + sorts topDivergences', () => {
    const primary: EtfFlowPrimaryPoint[] = [
      { ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 },
      { ticker: 'SPY', date: '2026-05-18', shares: 1e9, close: 500 },
      { ticker: 'QQQ', date: '2026-05-19', shares: 5e8, close: 450 },
      { ticker: 'IWM', date: '2026-05-19', shares: 3e8, close: 220 },
    ];
    const secondary: EtfFlowSecondaryPoint[] = [
      // SPY 2026-05-19: 0.6% shares diff (info)
      { ticker: 'SPY', date: '2026-05-19', shares: 1.006e9, close: 500 },
      // SPY 2026-05-18: 3% shares diff (warn)
      { ticker: 'SPY', date: '2026-05-18', shares: 1.03e9,  close: 500 },
      // QQQ 2026-05-19: 8% shares diff (critical)
      { ticker: 'QQQ', date: '2026-05-19', shares: 5.4e8,   close: 450 },
      // IWM 2026-05-19: identical (NO divergence row)
      { ticker: 'IWM', date: '2026-05-19', shares: 3e8,     close: 220 },
    ];
    const { divergences, totalCompared } = compareEtfFlowPanels(primary, secondary);
    assert.equal(totalCompared, 4);
    assert.equal(divergences.length, 3, 'IWM identical pair must NOT count');
    const summary = summarizeDivergences(divergences, totalCompared, 'issuer-csv');
    assert.equal(summary.totalCompared, 4);
    assert.equal(summary.divergenceCount, 3);
    assert.equal(summary.bySeverity.critical, 1, 'QQQ 8% shares diff');
    assert.equal(summary.bySeverity.warn, 1, 'SPY 2026-05-18 3% shares diff');
    assert.equal(summary.bySeverity.info, 1, 'SPY 2026-05-19 0.6% shares diff');
    assert.equal(summary.byTicker.SPY?.diverged, 2);
    assert.equal(summary.byTicker.QQQ?.diverged, 1);
    assert.equal(summary.byTicker.IWM, undefined, 'IWM had no divergences');
    assert.equal(summary.secondarySourceLabel, 'issuer-csv');
    // topDivergences sorted by max(|sharesPct|, |aumPct|) descending — QQQ
    // 8% > SPY 3% > SPY 0.6%. Pinned for byte-equal-stdout downstream.
    assert.equal(summary.topDivergences.length, Math.min(3, XV_TOP_DIVERGENCES_N));
    assert.equal(summary.topDivergences[0].ticker, 'QQQ');
    assert.equal(summary.topDivergences[1].ticker, 'SPY');
    assert.equal(summary.topDivergences[1].date, '2026-05-18');
    assert.equal(summary.topDivergences[2].date, '2026-05-19');
    // maxAbs scalars match the worst row.
    assert.ok(summary.maxAbsSharesPctDiff > 0.07);
    assert.ok(summary.maxAbsSharesPctDiff < 0.08);
  });
});

describe('evaluateEtfFlowComposite — secondary-panel wiring (T-EFXV-8)', () => {
  function baseInputs(): EtfFlowInputs {
    return {
      asOf: ASOF,
      lastYfinanceQueryAt: ASOF,
      perEtf: [flatPerEtfInput('SPY')],
    };
  }

  it('T-EFXV-8a crossValidation = null when no secondaryPanel provided (v1 default)', () => {
    const snap = evaluateEtfFlowComposite(baseInputs());
    assert.equal(snap.crossValidation, null);
  });

  it('T-EFXV-8b crossValidation = null when secondaryPanel is empty array', () => {
    const snap = evaluateEtfFlowComposite({
      ...baseInputs(),
      primaryPanel: [{ ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 }],
      secondaryPanel: [],
    });
    assert.equal(snap.crossValidation, null);
  });

  it('T-EFXV-8c crossValidation = null when intersection is empty (no overlap)', () => {
    // Both panels populated but on different dates ⇒ intersection = 0.
    const snap = evaluateEtfFlowComposite({
      ...baseInputs(),
      primaryPanel: [{ ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 }],
      secondaryPanel: [
        { ticker: 'SPY', date: '2026-05-12', shares: 1e9, close: 500 },
      ],
    });
    assert.equal(snap.crossValidation, null);
  });

  it('T-EFXV-8d crossValidation populated when secondaryPanel + intersection both non-empty', () => {
    const snap = evaluateEtfFlowComposite({
      ...baseInputs(),
      primaryPanel: [
        { ticker: 'SPY', date: '2026-05-19', shares: 1.000e9, close: 500 },
        { ticker: 'QQQ', date: '2026-05-19', shares: 5.000e8, close: 450 },
      ],
      secondaryPanel: [
        // SPY: identical pair — should NOT count as divergence
        { ticker: 'SPY', date: '2026-05-19', shares: 1.000e9, close: 500 },
        // QQQ: 4% shares diff — should fire as WARN
        { ticker: 'QQQ', date: '2026-05-19', shares: 5.200e8, close: 450 },
      ],
      secondarySourceLabel: 'fake-ssa-csv',
    });
    assert.ok(snap.crossValidation != null);
    const xv = snap.crossValidation!;
    assert.equal(xv.totalCompared, 2);
    assert.equal(xv.divergenceCount, 1);
    assert.equal(xv.bySeverity.warn, 1);
    assert.equal(xv.bySeverity.critical, 0);
    assert.equal(xv.bySeverity.info, 0);
    assert.equal(xv.topDivergences[0].ticker, 'QQQ');
    assert.equal(xv.secondarySourceLabel, 'fake-ssa-csv');
  });

  it('T-EFXV-8e default secondarySourceLabel when not specified', () => {
    const snap = evaluateEtfFlowComposite({
      ...baseInputs(),
      primaryPanel: [{ ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 }],
      secondaryPanel: [
        { ticker: 'SPY', date: '2026-05-19', shares: 1.05e9, close: 500 },
      ],
    });
    assert.ok(snap.crossValidation != null);
    assert.equal(snap.crossValidation!.secondarySourceLabel, 'issuer-csv');
  });

  it('T-EFXV-8f entry-threshold constant is in [1bp, 1%] range (sanity-pin)', () => {
    // SPEC-pin: protects against an accidental zero-or-negative threshold
    // that would let every (ticker, date) pair register as a divergence,
    // OR an over-large threshold (>1%) that would silently suppress all
    // real signal. The default must stay small enough to surface real
    // ingest mismatches but large enough to ignore T+1 settlement noise.
    assert.ok(XV_DIVERGENCE_ENTRY_THRESHOLD > 0.0001);
    assert.ok(XV_DIVERGENCE_ENTRY_THRESHOLD < 0.01);
  });
});
