/**
 * Tests for src/server/eight_k_classifier.ts — pure-function composite (Phase A2).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§2.2, 5.1, 5.2, 9.1
 *   (T-EK-1..T-EK-14).
 *
 * No CH dependency; in-memory composite tests only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EIGHT_K_CLASSIFIER_COMPOSITE_VERSION,
  ROLLING_WINDOW_DAYS,
  EIGHT_K_CLUSTER_Z_THRESHOLD,
  MIN_Z_BASELINE,
  HIGH_SIGNAL_ITEM_CODES,
  ITEM_CODE_FLAG_NAMES,
  dedupeEvents,
  filterEventsInWindow,
  countEventsForItem,
  flagItem,
  countDistinctAccessionsInHighSignalSet,
  daysSinceLatestHighSignalEvent,
  computeSectorEventRate,
  computeZ,
  flagEightKCluster,
  evaluateEightKClassifierComposite,
  type EightKEvent,
  type EightKClassifierInputs,
} from '../../src/server/eight_k_classifier.js';

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

/** Build a synthetic event with overrides. Defaults to an Item-2.06 event
 *  10 days before ASOF on AAPL — i.e. the simplest in-window high-signal row. */
function makeEvent(overrides: Partial<EightKEvent> = {}): EightKEvent {
  return {
    accession: overrides.accession ?? '0001-26-1',
    cik: overrides.cik ?? '0000320193',
    ticker: overrides.ticker ?? 'AAPL',
    itemCode: overrides.itemCode ?? '2.06',
    acceptedAt: overrides.acceptedAt ?? new Date(ASOF.getTime() - 10 * DAY_MS),
  };
}

/** Build composite inputs with overrides. */
function makeInputs(overrides: Partial<EightKClassifierInputs> = {}): EightKClassifierInputs {
  return {
    asOf: ASOF,
    lastEdgarQueryAt: new Date('2026-05-20T11:00:00Z'),
    bdSinceLastQuery: 0,
    perTicker: [],
    sectors: [],
    ...overrides,
  };
}

// ── T-EK-1: material_event_flag fires on ≥ 1 high-signal item in window ──────

describe('material_event_flag fires (T-EK-1)', () => {
  it('fires when exactly 1 high-signal event is in window', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
        events: [makeEvent({ itemCode: '2.06' })],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.perTickerRows[0].materialEventFlag, true);
    assert.equal(snap.perTickerRows[0].impairmentFlag, true);
    assert.equal(snap.perTickerRows[0].recentEventCount90d, 1);
  });

  it('fires when 2+ high-signal events present (different items)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
        events: [
          makeEvent({ accession: 'A', itemCode: '2.06' }),
          makeEvent({ accession: 'B', itemCode: '4.02' }),
        ],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.materialEventFlag, true);
    assert.equal(row.impairmentFlag, true);
    assert.equal(row.restatementFlag, true);
    assert.equal(row.recentEventCount90d, 2);
  });

  it('does NOT fire when no high-signal events are present', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
        events: [],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.perTickerRows[0].materialEventFlag, false);
    assert.equal(snap.perTickerRows[0].recentEventCount90d, 0);
  });

  it('flagItem helper returns true on count >= 1', () => {
    assert.equal(flagItem(1), true);
    assert.equal(flagItem(2), true);
    assert.equal(flagItem(0), false);
  });
});

// ── T-EK-2: does NOT fire when latest high-signal item is 91d outside window ─

describe('material_event_flag window-out (T-EK-2)', () => {
  it('does NOT fire when latest high-signal event is 91d before asOf', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
        events: [makeEvent({
          itemCode: '2.06',
          acceptedAt: new Date(ASOF.getTime() - 91 * DAY_MS),
        })],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.materialEventFlag, false);
    assert.equal(row.impairmentFlag, false);
    assert.equal(row.recentEventCount90d, 0);
    assert.equal(row.daysSinceLatestEvent, null);
  });
});

// ── T-EK-3: impairment_flag fires on 2.06; not on other items ────────────────

describe('impairment_flag specificity (T-EK-3)', () => {
  it('fires on a single 2.06 event', () => {
    const events = [makeEvent({ itemCode: '2.06' })];
    const count = countEventsForItem(events, '2.06', ASOF);
    assert.equal(count, 1);
    assert.equal(flagItem(count), true);
  });

  it('does NOT fire when only non-2.06 items are present', () => {
    const events = [
      makeEvent({ accession: 'a', itemCode: '4.02' }),
      makeEvent({ accession: 'b', itemCode: '1.01' }),
    ];
    const count = countEventsForItem(events, '2.06', ASOF);
    assert.equal(count, 0);
    assert.equal(flagItem(count), false);
  });

  it('via composite: impairment fires only when 2.06 is present', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        events: [makeEvent({ itemCode: '4.02' })],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.impairmentFlag, false);
    assert.equal(row.restatementFlag, true);
    assert.equal(row.materialEventFlag, true);
  });
});

// ── T-EK-4: each per-item flag round-trips correctly ─────────────────────────

describe('per-item flags round-trip (T-EK-4)', () => {
  const cases: Array<{
    itemCode: string;
    flagField: keyof ReturnType<typeof evaluateEightKClassifierComposite>['perTickerRows'][number];
  }> = [
    { itemCode: '1.01', flagField: 'materialAgreementFlag' },
    { itemCode: '2.01', flagField: 'acquisitionFlag' },
    { itemCode: '2.06', flagField: 'impairmentFlag' },
    { itemCode: '3.01', flagField: 'delistingFlag' },
    { itemCode: '4.01', flagField: 'auditorChangeFlag' },
    { itemCode: '4.02', flagField: 'restatementFlag' },
    { itemCode: '5.01', flagField: 'controlChangeFlag' },
  ];

  for (const { itemCode, flagField } of cases) {
    it(`item ${itemCode} fires ${String(flagField)} and NOT the other 6 per-item flags`, () => {
      const inputs = makeInputs({
        perTicker: [{
          ticker: 'AAPL', cik: '0000320193', sector: 'IT',
          events: [makeEvent({ itemCode })],
        }],
      });
      const snap = evaluateEightKClassifierComposite(inputs);
      const row = snap.perTickerRows[0];

      assert.equal(row[flagField], true, `${flagField} should fire for item ${itemCode}`);
      // Confirm the other 6 are false.
      for (const other of cases) {
        if (other.itemCode === itemCode) continue;
        assert.equal(
          row[other.flagField], false,
          `${String(other.flagField)} should NOT fire for item ${itemCode}`,
        );
      }
      assert.equal(row.materialEventFlag, true);
    });
  }

  it('ITEM_CODE_FLAG_NAMES is byte-pinned to HIGH_SIGNAL_ITEM_CODES', () => {
    const codesInMapping = Object.keys(ITEM_CODE_FLAG_NAMES).sort();
    const codesInSpec = [...HIGH_SIGNAL_ITEM_CODES].sort();
    assert.deepEqual(codesInMapping, codesInSpec);
  });
});

// ── T-EK-5: items outside the high-signal set do NOT fire material_event ─────

describe('off-set items do not fire material_event_flag (T-EK-5)', () => {
  it('ignores 1.02, 5.02, 7.01, 8.01 (all off-set)', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        events: [
          makeEvent({ accession: 'a', itemCode: '1.02' }),
          makeEvent({ accession: 'b', itemCode: '5.02' }),
          makeEvent({ accession: 'c', itemCode: '7.01' }),
          makeEvent({ accession: 'd', itemCode: '8.01' }),
        ],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.materialEventFlag, false);
    assert.equal(row.recentEventCount90d, 0);
    assert.equal(row.daysSinceLatestEvent, null);
    // All per-item flags off as well.
    assert.equal(row.impairmentFlag, false);
    assert.equal(row.restatementFlag, false);
    assert.equal(row.auditorChangeFlag, false);
    assert.equal(row.delistingFlag, false);
    assert.equal(row.controlChangeFlag, false);
    assert.equal(row.materialAgreementFlag, false);
    assert.equal(row.acquisitionFlag, false);
  });

  it('mixed in-set + off-set: in-set fires, off-set ignored', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        events: [
          makeEvent({ accession: 'a', itemCode: '2.06' }),     // in-set
          makeEvent({ accession: 'b', itemCode: '7.01' }),     // off-set
          makeEvent({ accession: 'c', itemCode: '8.01' }),     // off-set
        ],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.materialEventFlag, true);
    assert.equal(row.impairmentFlag, true);
    assert.equal(row.recentEventCount90d, 1);
  });
});

// ── T-EK-6: days_since_latest_event returns null on no qualifying events ─────

describe('daysSinceLatestHighSignalEvent (T-EK-6)', () => {
  it('returns null when no qualifying events exist', () => {
    assert.equal(daysSinceLatestHighSignalEvent([], ASOF), null);
  });

  it('returns null when all events are off-set', () => {
    const events = [
      makeEvent({ accession: 'a', itemCode: '7.01' }),
      makeEvent({ accession: 'b', itemCode: '8.01' }),
    ];
    assert.equal(daysSinceLatestHighSignalEvent(events, ASOF), null);
  });

  it('returns 0 for a high-signal event accepted exactly at asOf', () => {
    const ev = makeEvent({ itemCode: '2.06', acceptedAt: ASOF });
    assert.equal(daysSinceLatestHighSignalEvent([ev], ASOF), 0);
  });

  it('returns the integer days-since-latest across multiple in-set events', () => {
    const events = [
      makeEvent({ accession: 'old', itemCode: '4.02',
        acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS) }),
      makeEvent({ accession: 'mid', itemCode: '2.06',
        acceptedAt: new Date(ASOF.getTime() - 12 * DAY_MS) }),
      makeEvent({ accession: 'new', itemCode: '1.01',
        acceptedAt: new Date(ASOF.getTime() - 4 * DAY_MS) }),
    ];
    assert.equal(daysSinceLatestHighSignalEvent(events, ASOF), 4);
  });

  it('via composite: row.daysSinceLatestEvent is null when no high-signal events', () => {
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        events: [],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.perTickerRows[0].daysSinceLatestEvent, null);
  });
});

// ── T-EK-7: sector event-rate (3 distinct (ticker, accession) / 30 = 0.1) ────

describe('computeSectorEventRate (T-EK-7)', () => {
  it('returns count(distinct (ticker, accession)) / sectorSize for in-set in-window events', () => {
    const events = [
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '2.06' }),
      makeEvent({ ticker: 'BBB', accession: 'X2', cik: '222', itemCode: '4.02' }),
      makeEvent({ ticker: 'CCC', accession: 'X3', cik: '333', itemCode: '1.01' }),
    ];
    const rate = computeSectorEventRate(events, 30, ASOF);
    assertClose(rate, 0.1);
  });

  it('returns 0 when sector has zero events', () => {
    const rate = computeSectorEventRate([], 30, ASOF);
    assert.equal(rate, 0);
  });

  it('returns null when sectorSize <= 0 (degenerate sector)', () => {
    assert.equal(computeSectorEventRate([], 0, ASOF), null);
    assert.equal(computeSectorEventRate([], -1, ASOF), null);
  });

  it('excludes events outside the rolling window from the rate', () => {
    const inWindow = makeEvent({
      ticker: 'AAA', accession: 'a', itemCode: '2.06',
      acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS),
    });
    const outOfWindow = makeEvent({
      ticker: 'BBB', accession: 'b', itemCode: '4.02',
      acceptedAt: new Date(ASOF.getTime() - 100 * DAY_MS),
    });
    const rate = computeSectorEventRate([inWindow, outOfWindow], 50, ASOF);
    assertClose(rate, 0.02); // 1/50
  });

  it('excludes off-set items from the rate', () => {
    const inSet = makeEvent({ ticker: 'AAA', accession: 'a', itemCode: '2.06' });
    const offSet = makeEvent({ ticker: 'BBB', accession: 'b', itemCode: '7.01' });
    const rate = computeSectorEventRate([inSet, offSet], 10, ASOF);
    assertClose(rate, 0.1); // 1/10, not 2/10
  });
});

// ── T-EK-8: aggregate z with 30-print baseline ───────────────────────────────

describe('computeZ aggregate (T-EK-8)', () => {
  it('returns a meaningful z when baseline has >= MIN_Z_BASELINE prints', () => {
    // Build a baseline where mean ~ 0.02 with non-degenerate stddev
    const baseline: number[] = [];
    for (let i = 0; i < 40; i++) {
      baseline.push(0.02 + ((i % 5) - 2) * 0.002);
    }
    const result = computeZ(0.08, baseline);
    assert.ok(result.z != null);
    assert.ok(result.z > 2, `expected z > 2 for outlier high rate, got ${result.z}`);
    assert.equal(result.baselineSize, 40);
  });

  it('returns negative z for an outlier-low value (sector below baseline)', () => {
    const baseline: number[] = [];
    for (let i = 0; i < 40; i++) {
      baseline.push(0.10 + ((i % 5) - 2) * 0.005);
    }
    const result = computeZ(0.02, baseline);
    assert.ok(result.z != null);
    assert.ok(result.z < -2, `expected z < -2, got ${result.z}`);
  });
});

// ── T-EK-9: aggregate z null when baseline < 30 prints (cold-start) ──────────

describe('computeZ baseline floor (T-EK-9)', () => {
  it('returns null z when baseline has fewer than MIN_Z_BASELINE prints', () => {
    const baseline = Array.from({ length: MIN_Z_BASELINE - 1 }, (_, i) => i / 100);
    const result = computeZ(0.10, baseline);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, MIN_Z_BASELINE - 1);
  });

  it('returns null z on empty baseline', () => {
    const result = computeZ(0.05, []);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, 0);
  });

  it('returns null z when value is null', () => {
    const baseline = Array.from({ length: 50 }, () => 0.05);
    const result = computeZ(null, baseline);
    assert.equal(result.z, null);
  });

  it('returns null z when stddev is degenerate (all-identical baseline)', () => {
    const baseline = Array.from({ length: 50 }, () => 0.05);
    const result = computeZ(0.10, baseline);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, 50);
  });
});

// ── T-EK-10: eight_k_cluster_flag fires when ANY sector has |z| > 2.0 ────────

describe('flagEightKCluster (T-EK-10)', () => {
  it('fires when at least one sector z exceeds the threshold', () => {
    assert.equal(flagEightKCluster([0.5, 1.2, 2.5, -1.0]), true);
  });

  it('fires symmetrically on negative z (sector below baseline)', () => {
    assert.equal(flagEightKCluster([0.5, -2.5, 1.0]), true);
  });

  it('does not fire when all |z| <= threshold', () => {
    assert.equal(flagEightKCluster([0.5, 1.2, -1.9, 1.99]), false);
  });

  it('via composite: surfaces flaggedSectors when |z| > 2', () => {
    // Build a baseline where mean ~ 0.02, stddev > 0
    const baseline: number[] = [];
    for (let i = 0; i < 60; i++) baseline.push(0.02 + ((i % 4) - 1.5) * 0.005);
    // 6 distinct (ticker, accession) events => rate = 6/30 = 0.20
    const events = [
      makeEvent({ ticker: 'T1', accession: 'X1', cik: '111', itemCode: '2.06',
        acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
      makeEvent({ ticker: 'T2', accession: 'X2', cik: '222', itemCode: '4.02',
        acceptedAt: new Date(ASOF.getTime() - 8 * DAY_MS) }),
      makeEvent({ ticker: 'T3', accession: 'X3', cik: '333', itemCode: '1.01',
        acceptedAt: new Date(ASOF.getTime() - 20 * DAY_MS) }),
      makeEvent({ ticker: 'T4', accession: 'X4', cik: '444', itemCode: '2.01',
        acceptedAt: new Date(ASOF.getTime() - 30 * DAY_MS) }),
      makeEvent({ ticker: 'T5', accession: 'X5', cik: '555', itemCode: '3.01',
        acceptedAt: new Date(ASOF.getTime() - 40 * DAY_MS) }),
      makeEvent({ ticker: 'T6', accession: 'X6', cik: '666', itemCode: '4.01',
        acceptedAt: new Date(ASOF.getTime() - 50 * DAY_MS) }),
    ];
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        events,
        baseline2y: baseline,
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.flaggedSectors.length, 1);
    const flagged = snap.flaggedSectors[0];
    assert.equal(flagged.sector, 'Information Technology');
    assert.equal(flagged.sectorSize, 30);
    assertClose(flagged.eventRateT, 6 / 30);
    assert.ok(Math.abs(flagged.z) > EIGHT_K_CLUSTER_Z_THRESHOLD);
    assert.equal(snap.eightKClusterFlag, true);
  });
});

// ── T-EK-11: eight_k_cluster_flag does NOT fire when all sector z's are null ─

describe('flagEightKCluster cold-start (T-EK-11)', () => {
  it('does not fire when all sector z-scores are null', () => {
    assert.equal(flagEightKCluster([null, null, null]), false);
  });

  it('does not fire when some are null and the non-null ones are below threshold', () => {
    assert.equal(flagEightKCluster([null, 1.5, null, -1.8]), false);
  });

  it('via composite: cold-start baseline does NOT flag cluster', () => {
    const events = [
      makeEvent({ ticker: 'T1', accession: 'X1', cik: '111', itemCode: '2.06',
        acceptedAt: new Date(ASOF.getTime() - 5 * DAY_MS) }),
    ];
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        events,
        baseline2y: [],   // cold start
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.flaggedSectors.length, 0);
    assert.equal(snap.eightKClusterFlag, false);
  });
});

// ── T-EK-12: window boundary inclusion ───────────────────────────────────────

describe('window boundary inclusion (T-EK-12)', () => {
  it('event at exactly asOf - 90d 00:00:00 IS in window', () => {
    const ev = makeEvent({
      itemCode: '2.06',
      acceptedAt: new Date(ASOF.getTime() - ROLLING_WINDOW_DAYS * DAY_MS),
    });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 1);
  });

  it('event 1 ms before asOf - 90d is NOT in window', () => {
    const ev = makeEvent({
      itemCode: '2.06',
      acceptedAt: new Date(ASOF.getTime() - ROLLING_WINDOW_DAYS * DAY_MS - 1),
    });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 0);
  });

  it('event at exactly asOf IS in window', () => {
    const ev = makeEvent({ itemCode: '2.06', acceptedAt: ASOF });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 1);
  });

  it('event 1 ms after asOf is NOT in window (defensive — EDF-5 normally upstream)', () => {
    const ev = makeEvent({ itemCode: '2.06', acceptedAt: new Date(ASOF.getTime() + 1) });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 0);
  });
});

// ── T-EK-13: single filing × multiple items counts ONCE toward sector rate ───

describe('sector rate distinct-on-(ticker, accession) (T-EK-13)', () => {
  it('one filing with three high-signal items contributes 1 to the rate, not 3', () => {
    // Same ticker + same accession, three different item codes
    const events = [
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '2.06' }),
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '4.02' }),
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '1.01' }),
    ];
    const rate = computeSectorEventRate(events, 50, ASOF);
    assertClose(rate, 1 / 50);
  });

  it('via composite: aggregate event_rate_t reflects distinct accessions', () => {
    const baseline: number[] = [];
    for (let i = 0; i < 60; i++) baseline.push(0.02 + ((i % 4) - 1.5) * 0.001);
    // Two distinct filings, but the first one has 3 items + the second has 2.
    // Distinct (ticker, accession): 2 across the in-set events.
    const events = [
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '2.06' }),
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '4.02' }),
      makeEvent({ ticker: 'AAA', accession: 'X1', cik: '111', itemCode: '1.01' }),
      makeEvent({ ticker: 'BBB', accession: 'X2', cik: '222', itemCode: '2.06' }),
      makeEvent({ ticker: 'BBB', accession: 'X2', cik: '222', itemCode: '3.01' }),
    ];
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        events,
        baseline2y: baseline,
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    // 2 distinct (ticker, accession) / 30 = 0.0667
    // Only emitted as flagged if |z|>2; the test asserts the rate path, not the flag.
    // We can directly read the rate from the helper:
    const rate = computeSectorEventRate(events, 30, ASOF);
    assertClose(rate, 2 / 30);
    // sanity: snapshot was built (orchestrator path)
    assert.equal(snap.version, EIGHT_K_CLASSIFIER_COMPOSITE_VERSION);
  });

  it('per-ticker recentEventCount90d also dedupes accession across items', () => {
    const events = [
      makeEvent({ accession: 'X1', itemCode: '2.06' }),
      makeEvent({ accession: 'X1', itemCode: '4.02' }),
      makeEvent({ accession: 'X1', itemCode: '1.01' }),
      makeEvent({ accession: 'X2', itemCode: '3.01' }),
    ];
    const count = countDistinctAccessionsInHighSignalSet(events, ASOF);
    assert.equal(count, 2);
  });
});

// ── T-EK-14: event-deduplication on (cik, accession, item_code) ──────────────

describe('dedupeEvents (T-EK-14)', () => {
  it('collapses duplicate (cik, accession, itemCode) tuples to one event', () => {
    const events = [
      makeEvent({ cik: '111', accession: 'A', itemCode: '2.06' }),
      makeEvent({ cik: '111', accession: 'A', itemCode: '2.06' }),
      makeEvent({ cik: '111', accession: 'B', itemCode: '2.06' }),
    ];
    const deduped = dedupeEvents(events);
    assert.equal(deduped.length, 2);
  });

  it('preserves distinct item codes from the same filing', () => {
    const events = [
      makeEvent({ cik: '111', accession: 'A', itemCode: '2.06' }),
      makeEvent({ cik: '111', accession: 'A', itemCode: '4.02' }),
    ];
    const deduped = dedupeEvents(events);
    assert.equal(deduped.length, 2);
  });

  it('preserves distinct CIKs from the same accession (rare but possible)', () => {
    const events = [
      makeEvent({ cik: '111', accession: 'A', itemCode: '2.06' }),
      makeEvent({ cik: '222', accession: 'A', itemCode: '2.06' }),
    ];
    const deduped = dedupeEvents(events);
    assert.equal(deduped.length, 2);
  });

  it('via composite: per-item count is correct after upstream duplicate input', () => {
    // Duplicate Item 2.06 events in the input array — countEventsForItem
    // operates on the DEDUPED list inside the orchestrator.
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'IT',
        events: [
          makeEvent({ accession: 'A', itemCode: '2.06' }),
          makeEvent({ accession: 'A', itemCode: '2.06' }), // duplicate
        ],
      }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.impairmentFlag, true);
    assert.equal(row.recentEventCount90d, 1);
  });
});

// ── Composite orchestrator integration ───────────────────────────────────────

describe('evaluateEightKClassifierComposite (orchestrator)', () => {
  it('returns the expected snapshot shape on empty inputs', () => {
    const snap = evaluateEightKClassifierComposite(makeInputs());
    assert.equal(snap.version, EIGHT_K_CLASSIFIER_COMPOSITE_VERSION);
    assert.deepEqual([...snap.flaggedSectors], []);
    assert.equal(snap.eightKClusterFlag, false);
    assert.deepEqual([...snap.perTickerRows], []);
    assert.equal(snap.inputsAvailableAggregate, 0);
    assert.equal(snap.inputsAvailablePerTicker, 0);
  });

  it('inputsAvailablePerTicker counts only rows with non-null sector + non-empty CIK', () => {
    const inputs = makeInputs({
      perTicker: [
        { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology', events: [] },
        { ticker: 'NOSEC', cik: '0000123456', sector: null, events: [] },          // null sector
        { ticker: 'NOCIK', cik: '', sector: 'Health Care', events: [] },            // empty cik
        { ticker: 'BOTH',  cik: '', sector: null, events: [] },                     // both missing
      ],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.inputsAvailablePerTicker, 1);
    assert.equal(snap.perTickerRows.length, 4);
  });

  it('inputsAvailableAggregate counts sectors with sectorSize > 0', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'A', sectorSize: 30, events: [], baseline2y: [] },
        { sector: 'B', sectorSize: 0, events: [], baseline2y: [] },  // degenerate
        { sector: 'C', sectorSize: 50, events: [], baseline2y: [] },
      ],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.inputsAvailableAggregate, 2);
  });

  it('threads lastEdgarQueryAt + bdSinceLastQuery through to the snapshot', () => {
    const queryAt = new Date('2026-05-20T08:00:00Z');
    const inputs = makeInputs({ lastEdgarQueryAt: queryAt, bdSinceLastQuery: 2 });
    const snap = evaluateEightKClassifierComposite(inputs);
    assert.equal(snap.lastEdgarQueryAt, queryAt);
    assert.equal(snap.bdSinceLastQuery, 2);
  });

  it('per-ticker layer derives multiple flags from a single 8-K with two items', () => {
    const events = [
      makeEvent({ accession: 'A', itemCode: '2.06',
        acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
      makeEvent({ accession: 'A', itemCode: '4.02',
        acceptedAt: new Date(ASOF.getTime() - 10 * DAY_MS) }),
    ];
    const inputs = makeInputs({
      perTicker: [{ ticker: 'AAPL', cik: '0000320193', sector: 'IT', events }],
    });
    const snap = evaluateEightKClassifierComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.materialEventFlag, true);
    assert.equal(row.impairmentFlag, true);
    assert.equal(row.restatementFlag, true);
    assert.equal(row.recentEventCount90d, 1);  // ONE distinct accession
    assert.equal(row.daysSinceLatestEvent, 10);
  });
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe('constants (sanity)', () => {
  it('exposes the expected SPEC-pinned values', () => {
    assert.equal(EIGHT_K_CLASSIFIER_COMPOSITE_VERSION, 'eight_k_classifier_v1');
    assert.equal(ROLLING_WINDOW_DAYS, 90);
    assert.equal(EIGHT_K_CLUSTER_Z_THRESHOLD, 2.0);
    assert.equal(MIN_Z_BASELINE, 30);
    assert.deepEqual(
      [...HIGH_SIGNAL_ITEM_CODES],
      ['1.01', '2.01', '2.06', '3.01', '4.01', '4.02', '5.01'],
    );
  });
});
