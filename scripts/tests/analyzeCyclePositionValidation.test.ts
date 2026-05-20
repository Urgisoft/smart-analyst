/**
 * Tests for scripts/analyze_cycle_position_validation.ts — Phase B3 + B4.
 *
 * SPEC: docs/specs/market-cycle-position.md §4 Phase B.
 *
 * Contract pinned here:
 *   - pearson + spearman against known-answer vectors.
 *   - monthsBefore handles end-of-month carry correctly.
 *   - runBacktest hit/miss table per recession × lead horizon.
 *   - runFalsePositive precision/TP/FP math.
 *   - runIndependence joins on snapshot_date == trade_date AND skips
 *     'unknown' phase rows + dates missing from the regimes side.
 *   - renderReport produces a markdown string with the expected sections.
 *
 * No live CH; pure helpers + in-memory test fixtures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pearson,
  spearman,
  ranks,
  monthsBefore,
  runBacktest,
  runFalsePositive,
  runIndependence,
  renderReport,
  DEPRESSED_THRESHOLD,
  LEAD_MONTHS,
  INDEPENDENCE_THRESHOLD,
  type NberRecessionRow,
  type SnapshotsRow,
  type MacroRegimesRow,
  type ValidationReport,
} from '../analyze_cycle_position_validation.js';
import { CYCLE_FRED_SERIES } from '../../src/server/cycle_position_repository.js';
import type { FredCache } from '../backfill_cycle_position_history.js';

// ───── pearson / spearman / ranks ────────────────────────────────────

describe('pearson', () => {
  it('returns 1.0 for perfectly correlated vectors', () => {
    const p = pearson([1, 2, 3, 4], [2, 4, 6, 8]);
    assert.ok(p !== null && Math.abs(p - 1) < 1e-12);
  });

  it('returns -1.0 for perfectly anti-correlated vectors', () => {
    const p = pearson([1, 2, 3, 4], [4, 3, 2, 1]);
    assert.ok(p !== null && Math.abs(p + 1) < 1e-12);
  });

  it('returns null when one input has zero variance', () => {
    const p = pearson([1, 1, 1, 1], [1, 2, 3, 4]);
    assert.equal(p, null);
  });

  it('returns null on length mismatch', () => {
    assert.equal(pearson([1, 2], [1, 2, 3]), null);
  });

  it('matches a known-answer case (Wikipedia textbook example)', () => {
    // x = [1, 2, 3, 5, 8], y = [0.11, 0.12, 0.13, 0.15, 0.18]
    const p = pearson([1, 2, 3, 5, 8], [0.11, 0.12, 0.13, 0.15, 0.18]);
    assert.ok(p !== null && Math.abs(p - 1) < 1e-6, `expected ≈1, got ${p}`);
  });
});

describe('ranks', () => {
  it('assigns mid-rank to tied values', () => {
    const r = ranks([1, 2, 2, 4]);
    assert.deepEqual(r, [1, 2.5, 2.5, 4]);
  });

  it('preserves input ordering in the output indexing', () => {
    const r = ranks([3, 1, 2]);
    assert.deepEqual(r, [3, 1, 2]);
  });
});

describe('spearman', () => {
  it('returns 1.0 for monotonically increasing pair', () => {
    const sp = spearman([1, 2, 3, 4], [10, 20, 30, 40]);
    assert.ok(sp !== null && Math.abs(sp - 1) < 1e-12);
  });

  it('is robust to non-linear monotone (where Pearson is < 1)', () => {
    const xs = [1, 2, 3, 4];
    const ys = [1, 4, 9, 16];
    const p = pearson(xs, ys);
    const sp = spearman(xs, ys);
    assert.ok(sp !== null && Math.abs(sp - 1) < 1e-12);
    // Pearson on the squared series is slightly below 1.
    assert.ok(p !== null && p < 1);
  });
});

// ───── monthsBefore ──────────────────────────────────────────────────

describe('monthsBefore', () => {
  it('subtracts months and preserves day-of-month when possible', () => {
    assert.equal(monthsBefore('2026-05-19', 6), '2025-11-19');
    assert.equal(monthsBefore('2026-05-19', 12), '2025-05-19');
    assert.equal(monthsBefore('2026-05-19', 18), '2024-11-19');
  });

  it('clamps to end-of-target-month on overflow (e.g. Mar 31 - 1m = Feb 28/29)', () => {
    // Going from 2023-03-31 back 1 month → February 2023 has 28 days.
    assert.equal(monthsBefore('2023-03-31', 1), '2023-02-28');
    // Going from 2024-03-31 (leap year) back 1 month → February 2024 has 29 days.
    assert.equal(monthsBefore('2024-03-31', 1), '2024-02-29');
  });

  it('crosses year boundaries', () => {
    assert.equal(monthsBefore('2026-01-15', 18), '2024-07-15');
  });
});

// ───── runBacktest ───────────────────────────────────────────────────

function emptyCache(): FredCache { return new Map(); }

function syntheticCacheWithT10y3m(value: number, fromDate: string = '2000-01-01'): FredCache {
  const cache: FredCache = new Map();
  cache.set(CYCLE_FRED_SERIES.t10y3m, [{ date: fromDate, value }]);
  return cache;
}

describe('runBacktest', () => {
  const recessions: NberRecessionRow[] = [
    { peakDate: '2020-02-01', troughDate: '2020-04-01', notes: 'COVID' },
  ];

  it('emits one row per (recession × LEAD_MONTHS) pair', () => {
    const cache = emptyCache();
    const v = runBacktest(recessions, cache, '1996-01-01');
    assert.equal(v.leadPoints.length, recessions.length * LEAD_MONTHS.length);
  });

  it('flags lead points below the FRED min-date as "no data"', () => {
    const cache = emptyCache();
    // FRED min = 1995-01-01 → all COVID lead points (2018-2019) are AFTER, so all should produce snapshots.
    const v = runBacktest(recessions, cache, '1995-01-01');
    // No T10Y3M in cache → inputsAvailable=false for all.
    for (const lp of v.leadPoints) {
      assert.equal(lp.inputsAvailable, false);
    }
  });

  it('marks pre-FRED lead points as snapshot=null', () => {
    const cache = emptyCache();
    // FRED min = 2100-01-01 → all lead points are pre-FRED.
    const v = runBacktest(recessions, cache, '2100-01-01');
    for (const lp of v.leadPoints) {
      assert.equal(lp.snapshot, null);
      assert.equal(lp.inputsAvailable, false);
    }
  });

  it('signals "yes" when score < threshold at a lead point', () => {
    // T10Y3M = -0.5 (inverted) → yield curve sub-score = 0 → composite = 0 → 'contraction'.
    const cache = syntheticCacheWithT10y3m(-0.5, '2018-01-01');
    const v = runBacktest(recessions, cache, '1996-01-01');
    const allSignaled = v.leadPoints.every(lp => lp.signaled);
    assert.ok(allSignaled, 'expected all lead points to signal with deeply inverted curve');
    assert.equal(v.perRecessionAnySignal.get('2020-02-01'), true);
  });

  it('signals "no" when score > threshold at all lead points', () => {
    const cache = syntheticCacheWithT10y3m(2.5, '2018-01-01'); // healthy curve
    const v = runBacktest(recessions, cache, '1996-01-01');
    const anySignaled = v.leadPoints.some(lp => lp.signaled);
    assert.equal(anySignaled, false);
    assert.equal(v.perRecessionAnySignal.get('2020-02-01'), false);
  });
});

// ───── runFalsePositive ──────────────────────────────────────────────

describe('runFalsePositive', () => {
  const recessions: NberRecessionRow[] = [
    { peakDate: '2020-02-01', troughDate: '2020-04-01', notes: 'COVID' },
  ];

  it('counts only depressed-score days (< threshold)', () => {
    const snapshots: SnapshotsRow[] = [
      { snapshotDate: '2018-01-01', score: 0.30, phaseLabel: 'late' },
      { snapshotDate: '2018-02-01', score: 0.60, phaseLabel: 'mid' },
      { snapshotDate: '2019-01-01', score: 0.10, phaseLabel: 'contraction' },
    ];
    const v = runFalsePositive(snapshots, recessions);
    assert.equal(v.depressedDays, 2);
  });

  it('classifies depressed days followed by an NBER peak within 18m as true positives', () => {
    const snapshots: SnapshotsRow[] = [
      { snapshotDate: '2019-09-01', score: 0.30, phaseLabel: 'late' }, // peak 2020-02 within 18m → TP
      { snapshotDate: '2010-01-01', score: 0.30, phaseLabel: 'late' }, // no peak within 18m → FP
    ];
    const v = runFalsePositive(snapshots, recessions);
    assert.equal(v.depressedDays, 2);
    assert.equal(v.truePositives, 1);
    assert.equal(v.falsePositives, 1);
    assert.equal(v.precision, 0.5);
  });

  it('ignores rows with phase_label=unknown', () => {
    const snapshots: SnapshotsRow[] = [
      { snapshotDate: '2010-01-01', score: 0.10, phaseLabel: 'unknown' },
    ];
    const v = runFalsePositive(snapshots, recessions);
    assert.equal(v.depressedDays, 0);
  });

  it('returns 0 precision when no depressed days exist', () => {
    const snapshots: SnapshotsRow[] = [
      { snapshotDate: '2010-01-01', score: 0.80, phaseLabel: 'early' },
    ];
    const v = runFalsePositive(snapshots, recessions);
    assert.equal(v.precision, 0);
  });
});

// ───── runIndependence ──────────────────────────────────────────────

describe('runIndependence', () => {
  it('joins only on matching dates AND skips unknown rows', () => {
    const snapshots: SnapshotsRow[] = [
      { snapshotDate: '2020-01-01', score: 0.5, phaseLabel: 'mid' },
      { snapshotDate: '2020-01-02', score: 0.6, phaseLabel: 'mid' },
      { snapshotDate: '2020-01-03', score: 0.4, phaseLabel: 'late' },
      { snapshotDate: '2020-01-04', score: 0.0, phaseLabel: 'unknown' }, // skipped
      { snapshotDate: '2020-01-05', score: 0.7, phaseLabel: 'early' },   // no regime row
    ];
    const regimes: MacroRegimesRow[] = [
      { tradeDate: '2020-01-01', categoriesFiringToday: 0 },
      { tradeDate: '2020-01-02', categoriesFiringToday: 1 },
      { tradeDate: '2020-01-03', categoriesFiringToday: 2 },
      { tradeDate: '2020-01-04', categoriesFiringToday: 3 },
    ];
    const v = runIndependence(snapshots, regimes);
    assert.equal(v.joinedRows, 3); // only Jan 1, 2, 3
  });

  it('marks redundant when |ρ| > 0.7', () => {
    // Build a synthetic perfectly anti-correlated pair (real-world expectation:
    // high score = healthy = low categories firing).
    const snapshots: SnapshotsRow[] = [];
    const regimes: MacroRegimesRow[] = [];
    for (let i = 0; i < 50; i++) {
      const d = `2020-01-${String(i + 1).padStart(2, '0')}`;
      snapshots.push({ snapshotDate: d, score: 1 - i / 50, phaseLabel: 'mid' });
      regimes.push({ tradeDate: d, categoriesFiringToday: i / 50 });
    }
    const v = runIndependence(snapshots, regimes);
    assert.ok(v.pearson !== null && v.pearson < -0.99);
    assert.equal(v.redundant, true);
  });

  it('marks NOT redundant when |ρ| <= 0.7', () => {
    const snapshots: SnapshotsRow[] = [
      { snapshotDate: '2020-01-01', score: 0.5, phaseLabel: 'mid' },
      { snapshotDate: '2020-01-02', score: 0.7, phaseLabel: 'early' },
      { snapshotDate: '2020-01-03', score: 0.6, phaseLabel: 'mid' },
      { snapshotDate: '2020-01-04', score: 0.4, phaseLabel: 'late' },
    ];
    const regimes: MacroRegimesRow[] = [
      { tradeDate: '2020-01-01', categoriesFiringToday: 1 },
      { tradeDate: '2020-01-02', categoriesFiringToday: 2 },
      { tradeDate: '2020-01-03', categoriesFiringToday: 0 },
      { tradeDate: '2020-01-04', categoriesFiringToday: 3 },
    ];
    const v = runIndependence(snapshots, regimes);
    // Manually computed: scores [0.5,0.7,0.6,0.4] vs cats [1,2,0,3] → low |ρ|.
    assert.equal(v.redundant, false);
  });
});

// ───── renderReport ─────────────────────────────────────────────────

describe('renderReport', () => {
  const minimalReport: ValidationReport = {
    generatedAt: '2026-05-19T13:30:00.000Z',
    windowStart: '2008-01-02',
    windowEnd: '2026-05-18',
    backtest: {
      leadPoints: [
        {
          recession: { peakDate: '2020-02-01', troughDate: '2020-04-01', notes: 'COVID' },
          leadMonths: 12,
          asOf: '2019-02-01',
          snapshot: {
            asOf: new Date('2019-02-01T12:00:00Z'),
            score: 0.55, phaseLabel: 'mid', recessionProbPct: 25,
            inputsPresent: 0b01111111,
            contributions: { yieldCurve: 0.5, credit: 0.6, employment: 0.55 },
            compositeVersion: 'cycle_v1',
          },
          inputsAvailable: true,
          signaled: false,
        },
      ],
      perRecessionAnySignal: new Map([['2020-02-01', false]]),
    },
    falsePositive: {
      depressedDays: 100, truePositives: 25, falsePositives: 75, precision: 0.25,
    },
    independence: {
      joinedRows: 4623, pearson: -0.42, spearman: -0.39, redundant: false,
    },
  };

  it('renders a markdown report with section headers + summary table', () => {
    const md = renderReport(minimalReport);
    assert.match(md, /# Cycle-position validation/);
    assert.match(md, /## Summary/);
    assert.match(md, /## B3a — NBER lead-time backtest/);
    assert.match(md, /## B3b — False-positive rate/);
    assert.match(md, /## B4 — Independence vs `phase1_v3`/);
    assert.match(md, /## Caveats/);
  });

  it('includes the SPEC-pinned thresholds in the body', () => {
    const md = renderReport(minimalReport);
    assert.match(md, new RegExp(`score < ${DEPRESSED_THRESHOLD}`));
    assert.match(md, new RegExp(`\\|ρ\\| > ${INDEPENDENCE_THRESHOLD}`));
  });

  it('renders a per-recession lead-point row', () => {
    const md = renderReport(minimalReport);
    assert.match(md, /COVID.*2020-02-01.*12m.*2019-02-01.*0\.550.*mid/);
  });

  it('marks Phase C verdict as BLOCKED when independence test flags redundant', () => {
    const blocked = { ...minimalReport, independence: { ...minimalReport.independence, redundant: true } };
    const md = renderReport(blocked);
    assert.match(md, /BLOCKED for Phase C/);
  });
});
