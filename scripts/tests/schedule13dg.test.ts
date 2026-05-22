/**
 * Tests for src/server/schedule_13d_g.ts — pure-function composite (Phase A2).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §§2.2, 5.1, 5.2, 5.3, 9.1
 *   (T-XD13-1..T-XD13-22).
 *
 * No CH dependency; in-memory composite tests only.
 *
 * Pattern: mirrors scripts/tests/eightKClassifier.test.ts (per-filing model) +
 * scripts/tests/form4Insider.test.ts (sector-aggregate baseline shape).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULE_13D_G_COMPOSITE_VERSION,
  CLUSTER_WINDOW_DAYS,
  ROLLING_WINDOW_DAYS,
  SCHEDULE_13D_CLUSTER_Z_THRESHOLD,
  MIN_Z_BASELINE,
  FORM_TYPE_13D,
  FORM_TYPE_13D_A,
  FORM_TYPE_13G,
  FORM_TYPE_13G_A,
  SCHEDULE_FORM_TYPES,
  is13DForm,
  is13GForm,
  isNew13DForm,
  isAmendmentForm,
  dedupeFilings,
  filterFilingsToScheduleForms,
  filterFilingsInWindow,
  countFilingsBy,
  countDistinctFilersBy,
  daysSinceLatestFilingBy,
  computeSectorNew13DRate,
  computeZ,
  flagSchedule13DCluster,
  evaluateSchedule13DGComposite,
  type ScheduleFiling,
  type Schedule13DGInputs,
} from '../../src/server/schedule_13d_g.js';

const ASOF = new Date('2026-05-20T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Floating-point-tolerant equality assertion. */
function assertClose(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual != null, `expected close to ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected close to ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

/** Build a synthetic filing with overrides. Defaults to an SC 13D filing 10
 *  days before ASOF on AAPL by a default filer CIK — i.e. the simplest
 *  in-window NEW-13D row. */
function makeFiling(overrides: Partial<ScheduleFiling> = {}): ScheduleFiling {
  const formType = overrides.formType ?? FORM_TYPE_13D;
  return {
    accession: overrides.accession ?? '0001234567-26-1',
    issuerCik: overrides.issuerCik ?? '0000320193',
    issuerTicker: overrides.issuerTicker ?? 'AAPL',
    filerCik: overrides.filerCik ?? '0001000001',
    filerName: overrides.filerName ?? '',
    formType,
    isAmendment: overrides.isAmendment ?? formType.endsWith('/A'),
    acceptedAt: overrides.acceptedAt ?? new Date(ASOF.getTime() - 10 * DAY_MS),
    periodOfReport: overrides.periodOfReport ?? new Date(ASOF.getTime() - 12 * DAY_MS),
  };
}

/** Build composite inputs with overrides. */
function makeInputs(overrides: Partial<Schedule13DGInputs> = {}): Schedule13DGInputs {
  return {
    asOf: ASOF,
    lastEdgarQueryAt: new Date('2026-05-20T11:00:00Z'),
    bdSinceLastQuery: 0,
    perTicker: [],
    sectors: [],
    ...overrides,
  };
}

// ── T-XD13-1: new_13d_filing_flag_30d fires when latest SC 13D in window ─────

describe('new13DFilingFlag30d fires on in-window SC 13D (T-XD13-1)', () => {
  it('fires for an SC 13D 10 days before asOf', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
        filings: [makeFiling({ formType: FORM_TYPE_13D })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].new13DFilingFlag30d, true);
    assert.equal(snap.perTickerRows[0].recent13DCount90d, 1);
    assert.equal(snap.perTickerRows[0].new13DCount90d, 1);
  });

  it('fires for an SC 13D/A 10 days before asOf (per-stock includes amendments)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({ formType: FORM_TYPE_13D_A })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.new13DFilingFlag30d, true);
    assert.equal(row.recent13DCount90d, 1);
    assert.equal(row.new13DCount90d, 0, 'amendments excluded from new13DCount90d (XD-5)');
  });
});

// ── T-XD13-2: does NOT fire when latest SC 13D is 31d outside the window ─────

describe('new13DFilingFlag30d does not fire on out-of-window filing (T-XD13-2)', () => {
  it('does NOT fire for an SC 13D 31 days before asOf', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 31 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].new13DFilingFlag30d, false);
    // 31d filing is still in the 90d carry window
    assert.equal(snap.perTickerRows[0].recent13DCount90d, 1);
  });

  it('does NOT fire for an SC 13D 91 days before asOf (outside both windows)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 91 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.new13DFilingFlag30d, false);
    assert.equal(row.recent13DCount90d, 0);
  });
});

// ── T-XD13-3: new_13g flag fires on SC 13G; does NOT fire on SC 13D ──────────

describe('new13GFilingFlag30d fires on SC 13G only (T-XD13-3)', () => {
  it('fires for SC 13G in window; new13DFilingFlag30d stays false', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({ formType: FORM_TYPE_13G })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.new13GFilingFlag30d, true);
    assert.equal(row.new13DFilingFlag30d, false);
  });

  it('SC 13D in window leaves new13GFilingFlag30d false', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({ formType: FORM_TYPE_13D })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].new13GFilingFlag30d, false);
    assert.equal(snap.perTickerRows[0].new13DFilingFlag30d, true);
  });

  it('predicate helpers partition the form-type set correctly', () => {
    assert.equal(is13DForm(FORM_TYPE_13D), true);
    assert.equal(is13DForm(FORM_TYPE_13D_A), true);
    assert.equal(is13DForm(FORM_TYPE_13G), false);
    assert.equal(is13DForm(FORM_TYPE_13G_A), false);
    assert.equal(is13GForm(FORM_TYPE_13G), true);
    assert.equal(is13GForm(FORM_TYPE_13G_A), true);
    assert.equal(is13GForm(FORM_TYPE_13D), false);
    assert.equal(isNew13DForm(FORM_TYPE_13D), true);
    assert.equal(isNew13DForm(FORM_TYPE_13D_A), false);
    assert.equal(isAmendmentForm(FORM_TYPE_13D_A), true);
    assert.equal(isAmendmentForm(FORM_TYPE_13G_A), true);
    assert.equal(isAmendmentForm(FORM_TYPE_13D), false);
  });
});

// ── T-XD13-4: recent_13d_count_90d includes /A; new_13d_count_90d excludes ───

describe('recent vs new counts (T-XD13-4)', () => {
  it('recent13DCount90d counts both SC 13D and SC 13D/A; new13DCount90d excludes /A', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13D,
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13D_A,
            acceptedAt: new Date(ASOF.getTime() - 20 * DAY_MS) }),
          makeFiling({ accession: 'C', formType: FORM_TYPE_13D_A,
            acceptedAt: new Date(ASOF.getTime() - 80 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.recent13DCount90d, 3, 'all three filings in 90d');
    assert.equal(row.new13DCount90d, 1, 'only the SC 13D row, /A excluded');
  });
});

// ── T-XD13-5: distinct_13d_filers_90d dedupes on filerCik ───────────────────

describe('distinct13DFilers90d dedupes on filerCik (T-XD13-5)', () => {
  it('two SC 13D filings from same filerCik count as one distinct filer', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13D,
            filerCik: '0001999999',
            acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13D_A,
            filerCik: '0001999999',
            acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].distinct13DFilers90d, 1);
    assert.equal(snap.perTickerRows[0].recent13DCount90d, 2);
  });

  it('two SC 13D filings from different filerCiks count as two distinct filers', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13D,
            filerCik: '0001111111' }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13D,
            filerCik: '0002222222' }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].distinct13DFilers90d, 2);
  });

  it('SC 13G filings do NOT contribute to distinct13DFilers90d', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13D,
            filerCik: '0001111111' }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13G,
            filerCik: '0002222222' }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].distinct13DFilers90d, 1);
  });
});

// ── T-XD13-6: days_since_latest_13d returns null on no qualifying filings ────

describe('daysSinceLatest13D null on empty 13D window (T-XD13-6)', () => {
  it('returns null when ticker has no filings at all', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].daysSinceLatest13D, null);
  });

  it('returns null when ticker has only 13G filings', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({ formType: FORM_TYPE_13G })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].daysSinceLatest13D, null);
  });

  it('returns integer days when ticker has an in-window SC 13D', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 7 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].daysSinceLatest13D, 7);
  });
});

// ── T-XD13-7: days_since_latest_13g returns null on no qualifying filings ────

describe('daysSinceLatest13G null on empty 13G window (T-XD13-7)', () => {
  it('returns null when ticker has only 13D filings', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({ formType: FORM_TYPE_13D })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].daysSinceLatest13G, null);
  });

  it('returns integer days for the most-recent SC 13G/A', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13G,
            acceptedAt: new Date(ASOF.getTime() - 22 * DAY_MS) }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13G_A,
            acceptedAt: new Date(ASOF.getTime() - 4 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].daysSinceLatest13G, 4,
      'picks the most-recent of {13G, 13G/A}');
  });
});

// ── T-XD13-8: filings outside the watch universe contribute zero rows ───────

describe('per-stock loop covers only inputs.perTicker (T-XD13-8)', () => {
  it('a ticker absent from inputs.perTicker yields no per-ticker row', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [],
      }],
      // No mention of MSFT — even if a sector path or upstream stage
      // happened to know about it, the per-stock output covers AAPL only.
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows.length, 1);
    assert.equal(snap.perTickerRows[0].ticker, 'AAPL');
  });

  it('empty perTicker yields zero per-ticker rows', () => {
    const inputs = makeInputs({ perTicker: [] });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows.length, 0);
    assert.equal(snap.inputsAvailablePerTicker, 0);
  });
});

// ── T-XD13-9: sector NEW-13D rate computed correctly ────────────────────────

describe('sector NEW-13D rate (T-XD13-9)', () => {
  it('4 distinct NEW SC 13D filings across 40 SPY constituents → rate = 0.10', () => {
    const filings: ScheduleFiling[] = [];
    for (let i = 0; i < 4; i++) {
      filings.push(makeFiling({
        accession: `A${i}`,
        issuerCik: `00000000${i}`,
        issuerTicker: `T${i}`,
        formType: FORM_TYPE_13D,
        acceptedAt: new Date(ASOF.getTime() - (i + 1) * DAY_MS),
      }));
    }
    const rate = computeSectorNew13DRate(filings, 40, ASOF);
    assertClose(rate, 0.10);
  });

  it('returns null for sectorSize <= 0', () => {
    assert.equal(computeSectorNew13DRate([], 0, ASOF), null);
    assert.equal(computeSectorNew13DRate([], -1, ASOF), null);
  });

  it('dedupes on (issuerTicker, accession)', () => {
    const dup: ScheduleFiling[] = [
      makeFiling({ accession: 'A', issuerTicker: 'T1', formType: FORM_TYPE_13D }),
      makeFiling({ accession: 'A', issuerTicker: 'T1', formType: FORM_TYPE_13D }),
    ];
    const rate = computeSectorNew13DRate(dup, 10, ASOF);
    assertClose(rate, 0.10);
  });
});

// ── T-XD13-10: aggregate sector z-score with 30-print baseline ──────────────

describe('aggregate z-score at MIN_Z_BASELINE floor (T-XD13-10)', () => {
  it('30-print baseline yields a valid (non-null) z', () => {
    // Baseline: 30 prints with mean 0.02 stdev ~0.01
    const baseline = Array.from({ length: 30 }, (_, i) => 0.02 + (i - 15) * 0.001);
    const { z, baselineSize } = computeZ(0.06, baseline);
    assert.equal(baselineSize, 30);
    assert.ok(z != null && Number.isFinite(z), `expected finite z, got ${z}`);
    assert.ok(z != null && z > 0, 'value above mean yields positive z');
  });

  it('MIN_Z_BASELINE constant is 30', () => {
    assert.equal(MIN_Z_BASELINE, 30);
  });
});

// ── T-XD13-11: aggregate z returns null when baseline < 30 prints (cold-start) ──

describe('aggregate z null on cold-start baseline (T-XD13-11)', () => {
  it('29-print baseline yields null z', () => {
    const baseline = Array.from({ length: 29 }, () => 0.02);
    const { z, baselineSize } = computeZ(0.06, baseline);
    assert.equal(z, null);
    assert.equal(baselineSize, 29);
  });

  it('empty baseline yields null z', () => {
    const { z, baselineSize } = computeZ(0.06, []);
    assert.equal(z, null);
    assert.equal(baselineSize, 0);
  });

  it('null value yields null z', () => {
    const baseline = Array.from({ length: 30 }, (_, i) => 0.02 + (i - 15) * 0.001);
    const { z } = computeZ(null, baseline);
    assert.equal(z, null);
  });

  it('zero-stddev (constant) baseline yields null z', () => {
    const baseline = Array.from({ length: 30 }, () => 0.02);
    const { z } = computeZ(0.06, baseline);
    assert.equal(z, null, 'degenerate stddev → null z');
  });
});

// ── T-XD13-12: schedule_13d_cluster_flag fires on ANY sector with |z| > 2.0 ──

describe('schedule13DClusterFlag fires on any |z| > 2.0 (T-XD13-12)', () => {
  it('fires when one sector exceeds threshold + others do not', () => {
    assert.equal(flagSchedule13DCluster([0.5, -1.2, 2.5]), true);
  });

  it('fires symmetrically (negative z)', () => {
    assert.equal(flagSchedule13DCluster([0.0, -2.5, 1.0]), true);
  });

  it('does NOT fire when all |z| <= 2.0', () => {
    assert.equal(flagSchedule13DCluster([1.5, -1.9, 2.0]), false,
      'z = 2.0 exactly is NOT above threshold per strict > 2.0');
  });

  it('integrates: composite-level flag matches sector z when synthesized', () => {
    // Build a baseline + a single sector with rate well above mean.
    const baseline = Array.from({ length: 60 }, () => 0.01);
    // Make it non-degenerate — replace half with 0.011 so stddev > 0.
    for (let i = 0; i < 30; i++) baseline[i] = 0.011;
    // 5 NEW-13D filings across 40 SPY constituents → rate 0.125, ~12σ above 0.0105
    const filings: ScheduleFiling[] = [];
    for (let i = 0; i < 5; i++) {
      filings.push(makeFiling({
        accession: `A${i}`,
        issuerCik: `00000000${i}`,
        issuerTicker: `T${i}`,
        formType: FORM_TYPE_13D,
        acceptedAt: new Date(ASOF.getTime() - (i + 1) * DAY_MS),
      }));
    }
    const inputs = makeInputs({
      sectors: [{
        sector: 'Energy', sectorSize: 40, filings, baseline2y: baseline,
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.schedule13DClusterFlag, true);
    assert.equal(snap.flaggedSectors.length, 1);
    assert.equal(snap.flaggedSectors[0].sector, 'Energy');
  });
});

// ── T-XD13-13: cluster flag does NOT fire when all sector z's are null ──────

describe('schedule13DClusterFlag false on cold-start (T-XD13-13)', () => {
  it('returns false when sectorZs are all null', () => {
    assert.equal(flagSchedule13DCluster([null, null, null]), false);
  });

  it('returns false when sectorZs are empty', () => {
    assert.equal(flagSchedule13DCluster([]), false);
  });

  it('composite-level: cold-start baselines → cluster flag false', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 40, filings: [], baseline2y: [] },
        { sector: 'IT',     sectorSize: 70, filings: [], baseline2y: [] },
      ],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.schedule13DClusterFlag, false);
    assert.equal(snap.flaggedSectors.length, 0);
  });
});

// ── T-XD13-14: amendments EXCLUDED from aggregate NEW-13D rate (XD-5) ───────

describe('aggregate excludes /A per XD-5 (T-XD13-14)', () => {
  it('only SC 13D contributes to sector NEW-13D rate; SC 13D/A excluded', () => {
    const filings: ScheduleFiling[] = [
      makeFiling({ accession: 'A', issuerTicker: 'T1', formType: FORM_TYPE_13D }),
      makeFiling({ accession: 'B', issuerTicker: 'T2', formType: FORM_TYPE_13D_A }),
      makeFiling({ accession: 'C', issuerTicker: 'T3', formType: FORM_TYPE_13D_A }),
    ];
    const rate = computeSectorNew13DRate(filings, 10, ASOF);
    // Only the SC 13D row counts → 1/10
    assertClose(rate, 0.10);
  });

  it('SC 13G + SC 13G/A also excluded from aggregate', () => {
    const filings: ScheduleFiling[] = [
      makeFiling({ accession: 'A', issuerTicker: 'T1', formType: FORM_TYPE_13G }),
      makeFiling({ accession: 'B', issuerTicker: 'T2', formType: FORM_TYPE_13G_A }),
      makeFiling({ accession: 'C', issuerTicker: 'T3', formType: FORM_TYPE_13D }),
    ];
    const rate = computeSectorNew13DRate(filings, 10, ASOF);
    // Only the SC 13D row counts
    assertClose(rate, 0.10);
  });
});

// ── T-XD13-15: amendments INCLUDED in per-stock recent_13d_count_90d ─────────

describe('per-stock includes /A per XD-5 asymmetry (T-XD13-15)', () => {
  it('recent13DCount90d includes both SC 13D and SC 13D/A; new13DCount90d does not', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13D }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13D_A,
            acceptedAt: new Date(ASOF.getTime() - 50 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.recent13DCount90d, 2, 'SC 13D + SC 13D/A both count');
    assert.equal(row.new13DCount90d, 1, 'SC 13D only');
  });
});

// ── T-XD13-16: window boundary inclusion at 90d ─────────────────────────────

describe('90d window boundary inclusion (T-XD13-16)', () => {
  it('filing at acceptedAt = asOf - 90d IS in 90d window', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 90 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].recent13DCount90d, 1);
  });

  it('filing at acceptedAt = asOf - 90d - 1ms is NOT in 90d window', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 90 * DAY_MS - 1),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].recent13DCount90d, 0);
  });

  it('filterFilingsInWindow helper boundary semantic', () => {
    const filings = [
      makeFiling({ accession: 'in', acceptedAt: new Date(ASOF.getTime() - 90 * DAY_MS) }),
      makeFiling({ accession: 'out', acceptedAt: new Date(ASOF.getTime() - 90 * DAY_MS - 1) }),
    ];
    const inWin = filterFilingsInWindow(filings, ASOF, 90);
    assert.equal(inWin.length, 1);
    assert.equal(inWin[0].accession, 'in');
  });
});

// ── T-XD13-17: window boundary inclusion at 30d ─────────────────────────────

describe('30d window boundary inclusion (T-XD13-17)', () => {
  it('filing at acceptedAt = asOf - 30d IS in 30d window', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].new13DFilingFlag30d, true);
  });

  it('filing at acceptedAt = asOf - 30d - 1ms is NOT in 30d window', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS - 1),
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.perTickerRows[0].new13DFilingFlag30d, false);
    assert.equal(snap.perTickerRows[0].recent13DCount90d, 1);
  });
});

// ── T-XD13-18: future-dated filings REJECTED at composite layer ─────────────

describe('composite-layer anti-leak gate (T-XD13-18)', () => {
  it('filing with acceptedAt > asOf is excluded from all per-stock metrics', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [makeFiling({
          formType: FORM_TYPE_13D,
          acceptedAt: new Date(ASOF.getTime() + 1 * DAY_MS),  // tomorrow
        })],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.new13DFilingFlag30d, false);
    assert.equal(row.recent13DCount90d, 0);
    assert.equal(row.new13DCount90d, 0);
    assert.equal(row.daysSinceLatest13D, null);
  });

  it('future filing also excluded from aggregate NEW-13D rate', () => {
    const filings: ScheduleFiling[] = [
      makeFiling({
        accession: 'F', issuerTicker: 'T1', formType: FORM_TYPE_13D,
        acceptedAt: new Date(ASOF.getTime() + 5 * DAY_MS),
      }),
    ];
    const rate = computeSectorNew13DRate(filings, 10, ASOF);
    assertClose(rate, 0.0);
  });
});

// ── T-XD13-19: SC 13G-only ticker yields the expected flag/count pattern ────

describe('SC 13G-only ticker (T-XD13-19)', () => {
  it('13G-only filings yield 13D-side zero + 13G-side non-zero', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13G,
            acceptedAt: new Date(ASOF.getTime() - 4 * DAY_MS) }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13G_A,
            acceptedAt: new Date(ASOF.getTime() - 22 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.new13DFilingFlag30d, false);
    assert.equal(row.new13GFilingFlag30d, true);
    assert.equal(row.recent13DCount90d, 0);
    assert.equal(row.recent13GCount90d, 2);
    assert.equal(row.new13DCount90d, 0);
    assert.equal(row.distinct13DFilers90d, 0);
    assert.equal(row.daysSinceLatest13D, null);
    assert.equal(row.daysSinceLatest13G, 4);
  });
});

// ── T-XD13-20: mixed SC 13D + SC 13G on same ticker — independent metrics ───

describe('mixed 13D + 13G on same ticker (T-XD13-20)', () => {
  it('both per-form flags + counts emerge independently', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        filings: [
          makeFiling({ accession: 'A', formType: FORM_TYPE_13D,
            filerCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 3 * DAY_MS) }),
          makeFiling({ accession: 'B', formType: FORM_TYPE_13G,
            filerCik: '0001000002',
            acceptedAt: new Date(ASOF.getTime() - 11 * DAY_MS) }),
          makeFiling({ accession: 'C', formType: FORM_TYPE_13D_A,
            filerCik: '0001000001',
            acceptedAt: new Date(ASOF.getTime() - 28 * DAY_MS) }),
        ],
      }],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.new13DFilingFlag30d, true);
    assert.equal(row.new13GFilingFlag30d, true);
    assert.equal(row.recent13DCount90d, 2, 'SC 13D + SC 13D/A');
    assert.equal(row.recent13GCount90d, 1);
    assert.equal(row.new13DCount90d, 1, 'SC 13D only');
    assert.equal(row.distinct13DFilers90d, 1, 'same filerCik for the two 13D rows');
    assert.equal(row.daysSinceLatest13D, 3);
    assert.equal(row.daysSinceLatest13G, 11);
  });
});

// ── T-XD13-21: snapshot version is locked ───────────────────────────────────

describe('snapshot version stamp (T-XD13-21)', () => {
  it('version equals "schedule_13d_g_v1"', () => {
    const snap = evaluateSchedule13DGComposite(makeInputs());
    assert.equal(snap.version, 'schedule_13d_g_v1');
    assert.equal(SCHEDULE_13D_G_COMPOSITE_VERSION, 'schedule_13d_g_v1');
  });

  it('constants pinned: 30d cluster, 90d carry, |z|>2.0 threshold', () => {
    assert.equal(CLUSTER_WINDOW_DAYS, 30);
    assert.equal(ROLLING_WINDOW_DAYS, 90);
    assert.equal(SCHEDULE_13D_CLUSTER_Z_THRESHOLD, 2.0);
  });

  it('SCHEDULE_FORM_TYPES has the four pinned strings', () => {
    assert.deepEqual([...SCHEDULE_FORM_TYPES], [
      'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A',
    ]);
  });
});

// ── T-XD13-22: inputs_available.aggregate semantics ─────────────────────────

describe('inputsAvailableAggregate semantics (T-XD13-22)', () => {
  it('sums non-NaN baseline entries across sectors per SPEC §5.3', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 40, filings: [],
          baseline2y: Array.from({ length: 30 }, () => 0.01) },
        { sector: 'IT', sectorSize: 70, filings: [],
          baseline2y: Array.from({ length: 100 }, () => 0.02) },
        { sector: 'Materials', sectorSize: 20, filings: [],
          baseline2y: [] },
      ],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.inputsAvailableAggregate, 130, '30 + 100 + 0');
  });

  it('NaN entries in baseline are filtered out', () => {
    const baseline = Array.from({ length: 50 }, () => 0.01);
    baseline[5] = Number.NaN;
    baseline[20] = Number.NaN;
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 40, filings: [], baseline2y: baseline },
      ],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.inputsAvailableAggregate, 48, '50 - 2 NaN');
  });

  it('inputsAvailablePerTicker counts rows with ≥ 1 in-window filing', () => {
    const inputs = makeInputs({
      perTicker: [
        { ticker: 'A', cik: '1', sector: 'IT',
          filings: [makeFiling({ issuerTicker: 'A' })] },
        { ticker: 'B', cik: '2', sector: 'IT',
          filings: [] },
        { ticker: 'C', cik: '3', sector: 'IT',
          filings: [makeFiling({
            issuerTicker: 'C', formType: FORM_TYPE_13G,
          })] },
      ],
    });
    const snap = evaluateSchedule13DGComposite(inputs);
    assert.equal(snap.inputsAvailablePerTicker, 2);
  });
});

// ── Sanity checks beyond the SPEC numbering ─────────────────────────────────

describe('dedupeFilings collapses (issuerCik, accession) duplicates', () => {
  it('two rows with identical (issuerCik, accession) collapse to one', () => {
    const filings = [
      makeFiling({ issuerCik: '0000320193', accession: 'X' }),
      makeFiling({ issuerCik: '0000320193', accession: 'X' }),
      makeFiling({ issuerCik: '0000320193', accession: 'Y' }),
    ];
    assert.equal(dedupeFilings(filings).length, 2);
  });
});

describe('filterFilingsToScheduleForms drops off-set form types', () => {
  it('keeps the four SCHEDULE_FORM_TYPES and drops everything else', () => {
    const filings = [
      makeFiling({ accession: 'A', formType: FORM_TYPE_13D }),
      makeFiling({ accession: 'B', formType: FORM_TYPE_13G_A }),
      makeFiling({ accession: 'C', formType: '8-K' }),
      makeFiling({ accession: 'D', formType: 'SC13D' /* no space — off-set */ }),
    ];
    const kept = filterFilingsToScheduleForms(filings);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map((f) => f.accession).sort(), ['A', 'B']);
  });
});

describe('countFilingsBy + countDistinctFilersBy + daysSinceLatestFilingBy direct helper coverage', () => {
  it('countFilingsBy on is13DForm partitions correctly', () => {
    const filings = [
      makeFiling({ accession: 'A', formType: FORM_TYPE_13D }),
      makeFiling({ accession: 'B', formType: FORM_TYPE_13D_A }),
      makeFiling({ accession: 'C', formType: FORM_TYPE_13G }),
    ];
    assert.equal(countFilingsBy(filings, is13DForm, ASOF, 90), 2);
    assert.equal(countFilingsBy(filings, is13GForm, ASOF, 90), 1);
    assert.equal(countFilingsBy(filings, isNew13DForm, ASOF, 90), 1);
  });

  it('countDistinctFilersBy partitions by predicate then dedupes', () => {
    const filings = [
      makeFiling({ accession: 'A', formType: FORM_TYPE_13D, filerCik: 'F1' }),
      makeFiling({ accession: 'B', formType: FORM_TYPE_13D_A, filerCik: 'F1' }),
      makeFiling({ accession: 'C', formType: FORM_TYPE_13D, filerCik: 'F2' }),
      makeFiling({ accession: 'D', formType: FORM_TYPE_13G, filerCik: 'F3' }),
    ];
    assert.equal(countDistinctFilersBy(filings, is13DForm, ASOF, 90), 2);
    assert.equal(countDistinctFilersBy(filings, is13GForm, ASOF, 90), 1);
  });

  it('daysSinceLatestFilingBy picks the most-recent qualifying filing', () => {
    const filings = [
      makeFiling({ accession: 'A', formType: FORM_TYPE_13D,
        acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS) }),
      makeFiling({ accession: 'B', formType: FORM_TYPE_13D_A,
        acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
    ];
    assert.equal(daysSinceLatestFilingBy(filings, is13DForm, ASOF, 90), 5);
    assert.equal(daysSinceLatestFilingBy(filings, isNew13DForm, ASOF, 90), 30);
    assert.equal(daysSinceLatestFilingBy(filings, is13GForm, ASOF, 90), null);
  });
});
