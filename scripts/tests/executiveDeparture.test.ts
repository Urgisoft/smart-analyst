/**
 * Tests for src/server/executive_departure.ts — pure-function composite (Phase A2).
 *
 * SPEC: docs/specs/executive-departure-signal.md §§2, 5, 9.1.
 *
 * No CH dependency; in-memory composite tests only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTIVE_DEPARTURE_COMPOSITE_VERSION,
  ROLLING_WINDOW_DAYS,
  EXEC_CLUSTER_Z_THRESHOLD,
  MIN_Z_BASELINE,
  COMPOSITE_DEPARTURE_SUB_ITEM,
  COMPOSITE_APPOINTMENT_SUB_ITEM,
  dedupeEvents,
  filterEventsInWindow,
  countEventsInWindow,
  flagExecutiveDeparture,
  flagExecutiveAppointment,
  daysSinceLatestEvent,
  computeSectorDepartureRate,
  computeZ,
  flagExecutiveClusterDeparture,
  evaluateExecutiveDepartureComposite,
  type ExecutiveDepartureEvent,
  type ExecutiveDepartureInputs,
} from '../../src/server/executive_departure.js';

const ASOF = new Date('2026-05-19T12:00:00Z');

/** Floating-point-tolerant equality assertion. */
function assertClose(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual != null, `expected close to ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected close to ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

/** Build a synthetic event with overrides. */
function makeEvent(overrides: Partial<ExecutiveDepartureEvent> = {}): ExecutiveDepartureEvent {
  return {
    accession: overrides.accession ?? '0001-26-1',
    cik: overrides.cik ?? '0000320193',
    ticker: overrides.ticker ?? 'AAPL',
    subItemCode: overrides.subItemCode ?? COMPOSITE_DEPARTURE_SUB_ITEM,
    acceptedAt: overrides.acceptedAt ?? new Date('2026-05-15T16:30:12Z'),
  };
}

/** Build composite inputs with overrides. */
function makeInputs(overrides: Partial<ExecutiveDepartureInputs> = {}): ExecutiveDepartureInputs {
  return {
    asOf: ASOF,
    lastEdgarQueryAt: new Date('2026-05-19T11:00:00Z'),
    bdSinceLastQuery: 0,
    perTicker: [],
    sectors: [],
    ...overrides,
  };
}

// ── T-ED-1: executive_departure_flag fires on ≥ 1 event in window ───────────

describe('flagExecutiveDeparture (T-ED-1)', () => {
  it('fires when exactly 1 5.02(b) event is within window', () => {
    assert.equal(flagExecutiveDeparture(1), true);
  });
  it('fires when 2+ events present', () => {
    assert.equal(flagExecutiveDeparture(2), true);
  });
  it('does not fire on count = 0', () => {
    assert.equal(flagExecutiveDeparture(0), false);
  });
});

// ── T-ED-2: does not fire on event 91d outside window ────────────────────────

describe('countEventsInWindow / window boundary (T-ED-2)', () => {
  it('counts an event exactly 89d before asOf as in-window', () => {
    const ev = makeEvent({
      acceptedAt: new Date(ASOF.getTime() - 89 * 24 * 60 * 60 * 1000),
    });
    const count = countEventsInWindow([ev], COMPOSITE_DEPARTURE_SUB_ITEM, ASOF);
    assert.equal(count, 1);
  });
  it('does not count an event 91d before asOf', () => {
    const ev = makeEvent({
      acceptedAt: new Date(ASOF.getTime() - 91 * 24 * 60 * 60 * 1000),
    });
    const count = countEventsInWindow([ev], COMPOSITE_DEPARTURE_SUB_ITEM, ASOF);
    assert.equal(count, 0);
  });
});

// ── T-ED-3: appointment flag fires on 5.02(c); not on 5.02(b) only ───────────

describe('5.02(c) appointment flag (T-ED-3)', () => {
  it('fires on a single 5.02(c) event', () => {
    const ev = makeEvent({ subItemCode: COMPOSITE_APPOINTMENT_SUB_ITEM });
    const count = countEventsInWindow([ev], COMPOSITE_APPOINTMENT_SUB_ITEM, ASOF);
    assert.equal(flagExecutiveAppointment(count), true);
  });
  it('does NOT fire when only 5.02(b) events are present', () => {
    const ev = makeEvent({ subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM });
    const count = countEventsInWindow([ev], COMPOSITE_APPOINTMENT_SUB_ITEM, ASOF);
    assert.equal(flagExecutiveAppointment(count), false);
  });
});

// ── T-ED-4: 5.02(a)/(d)/(e) sub-items ignored at composite layer ─────────────

describe('sub-item filtering (T-ED-4)', () => {
  it('5.02(a), 5.02(d), 5.02(e) do NOT trigger departure or appointment flags', () => {
    const events = [
      makeEvent({ subItemCode: '5.02(a)' }),
      makeEvent({ subItemCode: '5.02(d)' }),
      makeEvent({ subItemCode: '5.02(e)' }),
    ];
    const depCount = countEventsInWindow(events, COMPOSITE_DEPARTURE_SUB_ITEM, ASOF);
    const apptCount = countEventsInWindow(events, COMPOSITE_APPOINTMENT_SUB_ITEM, ASOF);
    assert.equal(depCount, 0);
    assert.equal(apptCount, 0);
  });
});

// ── T-ED-5: daysSinceLatestDeparture null on empty ───────────────────────────

describe('daysSinceLatestEvent (T-ED-5)', () => {
  it('returns null when no qualifying events exist', () => {
    assert.equal(daysSinceLatestEvent([], COMPOSITE_DEPARTURE_SUB_ITEM, ASOF), null);
  });
  it('returns 0 for an event accepted today', () => {
    const ev = makeEvent({ acceptedAt: ASOF });
    assert.equal(daysSinceLatestEvent([ev], COMPOSITE_DEPARTURE_SUB_ITEM, ASOF), 0);
  });
  it('returns correct day count for a 5-days-ago event', () => {
    const ev = makeEvent({
      acceptedAt: new Date(ASOF.getTime() - 5 * 24 * 60 * 60 * 1000),
    });
    assert.equal(daysSinceLatestEvent([ev], COMPOSITE_DEPARTURE_SUB_ITEM, ASOF), 5);
  });
  it('returns the days-since-latest when multiple events exist', () => {
    const events = [
      makeEvent({ accession: 'old', acceptedAt: new Date(ASOF.getTime() - 30 * 24 * 60 * 60 * 1000) }),
      makeEvent({ accession: 'new', acceptedAt: new Date(ASOF.getTime() - 3 * 24 * 60 * 60 * 1000) }),
    ];
    assert.equal(daysSinceLatestEvent(events, COMPOSITE_DEPARTURE_SUB_ITEM, ASOF), 3);
  });
});

// ── T-ED-6: sector departure rate ────────────────────────────────────────────

describe('computeSectorDepartureRate (T-ED-6)', () => {
  it('returns count/sectorSize when both non-zero', () => {
    const events = [
      makeEvent({ accession: 'a', cik: '111' }),
      makeEvent({ accession: 'b', cik: '222' }),
      makeEvent({ accession: 'c', cik: '333' }),
    ];
    const rate = computeSectorDepartureRate(events, 30, ASOF);
    assertClose(rate, 0.1);
  });
  it('returns 0 when sector has zero events', () => {
    const rate = computeSectorDepartureRate([], 30, ASOF);
    assert.equal(rate, 0);
  });
  it('returns null when sectorSize is zero (degenerate sector)', () => {
    assert.equal(computeSectorDepartureRate([], 0, ASOF), null);
  });
  it('excludes events outside the rolling window from the rate', () => {
    const inWindow = makeEvent({
      accession: 'a',
      acceptedAt: new Date(ASOF.getTime() - 30 * 24 * 60 * 60 * 1000),
    });
    const outOfWindow = makeEvent({
      accession: 'b',
      acceptedAt: new Date(ASOF.getTime() - 100 * 24 * 60 * 60 * 1000),
    });
    const rate = computeSectorDepartureRate([inWindow, outOfWindow], 50, ASOF);
    assertClose(rate, 0.02); // 1/50
  });
  it('excludes 5.02(c) appointment events from the departure rate', () => {
    const dep = makeEvent({ accession: 'a', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM });
    const appt = makeEvent({ accession: 'b', subItemCode: COMPOSITE_APPOINTMENT_SUB_ITEM });
    const rate = computeSectorDepartureRate([dep, appt], 10, ASOF);
    assertClose(rate, 0.1); // 1/10, not 2/10
  });
});

// ── T-ED-7: aggregate z with 30-print baseline ───────────────────────────────

describe('computeZ aggregate (T-ED-7)', () => {
  it('returns a meaningful z when baseline has ≥ MIN_Z_BASELINE prints', () => {
    // Build a baseline where mean = 0.05, stddev approximately 0.01
    const baseline: number[] = [];
    for (let i = 0; i < 40; i++) {
      baseline.push(0.05 + (i % 5 - 2) * 0.005); // -0.01, -0.005, 0, 0.005, 0.01 around mean
    }
    const result = computeZ(0.10, baseline);
    assert.ok(result.z != null);
    assert.ok(result.z > 2, `expected z > 2 for outlier high rate, got ${result.z}`);
    assert.equal(result.baselineSize, 40);
  });
});

// ── T-ED-8: aggregate z null when baseline < 30 prints ───────────────────────

describe('computeZ baseline floor (T-ED-8)', () => {
  it('returns null z when baseline has fewer than MIN_Z_BASELINE prints', () => {
    const baseline = Array.from({ length: MIN_Z_BASELINE - 1 }, (_, i) => i / 100);
    const result = computeZ(0.10, baseline);
    assert.equal(result.z, null);
    assert.equal(result.baselineSize, MIN_Z_BASELINE - 1);
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

// ── T-ED-9: executive_cluster_departure fires when any sector |z| > 2 ────────

describe('flagExecutiveClusterDeparture (T-ED-9)', () => {
  it('fires when at least one sector z exceeds the threshold', () => {
    const zs = [0.5, 1.2, 2.5, -1.0];
    assert.equal(flagExecutiveClusterDeparture(zs), true);
  });
  it('fires symmetrically on negative z (sector below baseline)', () => {
    const zs = [0.5, -2.5, 1.0];
    assert.equal(flagExecutiveClusterDeparture(zs), true);
  });
  it('does not fire when all |z| <= threshold', () => {
    const zs = [0.5, 1.2, -1.9, 1.99];
    assert.equal(flagExecutiveClusterDeparture(zs), false);
  });
});

// ── T-ED-10: does not fire when all z's are null (cold-start) ────────────────

describe('cluster departure cold-start (T-ED-10)', () => {
  it('does not fire when all sector z-scores are null', () => {
    const zs = [null, null, null];
    assert.equal(flagExecutiveClusterDeparture(zs), false);
  });
  it('does not fire when some are null and the non-null ones are below threshold', () => {
    const zs = [null, 1.5, null, -1.8];
    assert.equal(flagExecutiveClusterDeparture(zs), false);
  });
});

// ── T-ED-11: missing CIK map propagates as null sector ───────────────────────

describe('inputsAvailable accounting (T-ED-11)', () => {
  it('null sector + empty cik propagates as inputsAvailablePerTicker = 0', () => {
    const inputs = makeInputs({
      perTicker: [
        { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology', events: [] },
        { ticker: 'UNKNOWN', cik: '', sector: null, events: [] },
      ],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    assert.equal(snap.inputsAvailablePerTicker, 1);  // only AAPL has both cik + sector
    assert.equal(snap.perTickerRows.length, 2);     // both ticker rows still emitted
    const unknown = snap.perTickerRows.find((r) => r.ticker === 'UNKNOWN');
    assert.ok(unknown);
    assert.equal(unknown.sector, null);
    assert.equal(unknown.recentDepartureCount90d, 0);
    assert.equal(unknown.executiveDepartureFlag, false);
  });
});

// ── T-ED-12: window boundary inclusion ───────────────────────────────────────

describe('window boundary inclusion (T-ED-12)', () => {
  it('event at exactly asOf - 90d 00:00:00 IS in window', () => {
    const ev = makeEvent({
      acceptedAt: new Date(ASOF.getTime() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 1);
  });
  it('event 1 ms before asOf - 90d is NOT in window', () => {
    const ev = makeEvent({
      acceptedAt: new Date(ASOF.getTime() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1),
    });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 0);
  });
  it('event at exactly asOf IS in window', () => {
    const ev = makeEvent({ acceptedAt: ASOF });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 1);
  });
  it('event 1 ms after asOf is NOT in window (defensive filter — E-7 typically applied upstream)', () => {
    const ev = makeEvent({ acceptedAt: new Date(ASOF.getTime() + 1) });
    const filtered = filterEventsInWindow([ev], ASOF);
    assert.equal(filtered.length, 0);
  });
});

// ── T-ED-13: event-deduplication ─────────────────────────────────────────────

describe('dedupeEvents (T-ED-13)', () => {
  it('collapses duplicate (cik, accession, subItemCode) tuples to one event', () => {
    const events = [
      makeEvent({ accession: 'A', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM }),
      makeEvent({ accession: 'A', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM }),
      makeEvent({ accession: 'B', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM }),
    ];
    const deduped = dedupeEvents(events);
    assert.equal(deduped.length, 2);
  });
  it('preserves distinct sub_item_codes from the same filing', () => {
    const events = [
      makeEvent({ accession: 'A', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM }),
      makeEvent({ accession: 'A', subItemCode: COMPOSITE_APPOINTMENT_SUB_ITEM }),
    ];
    const deduped = dedupeEvents(events);
    assert.equal(deduped.length, 2);
  });
  it('preserves distinct CIKs from the same accession (rare but possible)', () => {
    const events = [
      makeEvent({ cik: '111', accession: 'A', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM }),
      makeEvent({ cik: '222', accession: 'A', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM }),
    ];
    const deduped = dedupeEvents(events);
    assert.equal(deduped.length, 2);
  });
});

// ── Composite orchestrator integration ───────────────────────────────────────

describe('evaluateExecutiveDepartureComposite (orchestrator)', () => {
  it('returns the expected snapshot shape on empty inputs', () => {
    const snap = evaluateExecutiveDepartureComposite(makeInputs());
    assert.equal(snap.version, EXECUTIVE_DEPARTURE_COMPOSITE_VERSION);
    assert.deepEqual([...snap.flaggedSectors], []);
    assert.equal(snap.executiveClusterDeparture, false);
    assert.deepEqual([...snap.perTickerRows], []);
    assert.equal(snap.inputsAvailableAggregate, 0);
    assert.equal(snap.inputsAvailablePerTicker, 0);
  });

  it('per-ticker layer derives both flags from a single 8-K with two sub-items', () => {
    const events = [
      makeEvent({
        accession: 'A', subItemCode: COMPOSITE_DEPARTURE_SUB_ITEM,
        acceptedAt: new Date(ASOF.getTime() - 10 * 24 * 60 * 60 * 1000),
      }),
      makeEvent({
        accession: 'A', subItemCode: COMPOSITE_APPOINTMENT_SUB_ITEM,
        acceptedAt: new Date(ASOF.getTime() - 10 * 24 * 60 * 60 * 1000),
      }),
    ];
    const inputs = makeInputs({
      perTicker: [{
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology', events,
      }],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    const aapl = snap.perTickerRows[0];
    assert.equal(aapl.recentDepartureCount90d, 1);
    assert.equal(aapl.recentAppointmentCount90d, 1);
    assert.equal(aapl.executiveDepartureFlag, true);
    assert.equal(aapl.executiveAppointmentFlag, true);
    assert.equal(aapl.daysSinceLatestDeparture, 10);
  });

  it('sector-aggregate layer surfaces flaggedSectors when |z| > 2', () => {
    // Build a baseline where mean = 0.02, stddev > 0
    const baseline: number[] = [];
    for (let i = 0; i < 60; i++) baseline.push(0.02 + (i % 4 - 1.5) * 0.005);
    const events = [
      makeEvent({ cik: '111', accession: 'X1', acceptedAt: new Date(ASOF.getTime() - 5 * 24 * 60 * 60 * 1000) }),
      makeEvent({ cik: '222', accession: 'X2', acceptedAt: new Date(ASOF.getTime() - 8 * 24 * 60 * 60 * 1000) }),
      makeEvent({ cik: '333', accession: 'X3', acceptedAt: new Date(ASOF.getTime() - 20 * 24 * 60 * 60 * 1000) }),
      makeEvent({ cik: '444', accession: 'X4', acceptedAt: new Date(ASOF.getTime() - 30 * 24 * 60 * 60 * 1000) }),
      makeEvent({ cik: '555', accession: 'X5', acceptedAt: new Date(ASOF.getTime() - 40 * 24 * 60 * 60 * 1000) }),
      makeEvent({ cik: '666', accession: 'X6', acceptedAt: new Date(ASOF.getTime() - 50 * 24 * 60 * 60 * 1000) }),
    ];
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        events,
        baseline2y: baseline,
      }],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    assert.equal(snap.flaggedSectors.length, 1);
    const flagged = snap.flaggedSectors[0];
    assert.equal(flagged.sector, 'Information Technology');
    assert.equal(flagged.sectorSize, 30);
    assertClose(flagged.departureRateT, 6 / 30);
    assert.ok(Math.abs(flagged.z) > EXEC_CLUSTER_Z_THRESHOLD);
    assert.equal(snap.executiveClusterDeparture, true);
  });

  it('cold-start (empty baseline) does NOT flag cluster departure', () => {
    const events = [
      makeEvent({ cik: '111', accession: 'X1', acceptedAt: new Date(ASOF.getTime() - 5 * 24 * 60 * 60 * 1000) }),
    ];
    const inputs = makeInputs({
      sectors: [{
        sector: 'Information Technology',
        sectorSize: 30,
        events,
        baseline2y: [],   // cold start
      }],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    assert.equal(snap.flaggedSectors.length, 0);
    assert.equal(snap.executiveClusterDeparture, false);
  });

  it('inputsAvailableAggregate counts sectors with sectorSize > 0', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'A', sectorSize: 30, events: [], baseline2y: [] },
        { sector: 'B', sectorSize: 0, events: [], baseline2y: [] },  // degenerate
        { sector: 'C', sectorSize: 50, events: [], baseline2y: [] },
      ],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    assert.equal(snap.inputsAvailableAggregate, 2);
  });

  it('threads lastEdgarQueryAt + bdSinceLastQuery through to the snapshot', () => {
    const queryAt = new Date('2026-05-19T08:00:00Z');
    const inputs = makeInputs({ lastEdgarQueryAt: queryAt, bdSinceLastQuery: 2 });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    assert.equal(snap.lastEdgarQueryAt, queryAt);
    assert.equal(snap.bdSinceLastQuery, 2);
  });
});

// ── MAXZ-XD-{1..4} aggregate-layer max-|z| observability ────────────────────
// SPEC docs/specs/gics-sector-baseline-computation.md §5.2 + §2.
// ADR-042 §1 Decision §1 — maxAggregateZ / maxAggregateZSector exposed at the
// composite-evaluator boundary for the brief renderer's §1.4 LIVE branch.

describe('aggregate-layer maxAggregateZ + maxAggregateZSector (MAXZ-XD-1..4)', () => {
  // A 60-print baseline with deterministic mean + non-zero stddev so computeZ
  // returns finite z's. Pattern matches the existing T-ED-7 baseline shape.
  function makeBaseline(): number[] {
    const b: number[] = [];
    for (let i = 0; i < 60; i++) b.push(0.02 + ((i % 4) - 1.5) * 0.005);
    return b;
  }

  function makeSectorEvents(count: number): ExecutiveDepartureEvent[] {
    const events: ExecutiveDepartureEvent[] = [];
    for (let i = 0; i < count; i++) {
      events.push(makeEvent({
        cik: `c${i.toString().padStart(3, '0')}`,
        accession: `acc-${i}`,
        acceptedAt: new Date(ASOF.getTime() - (5 + i) * 24 * 60 * 60 * 1000),
      }));
    }
    return events;
  }

  it('MAXZ-XD-1: maxAggregateZ is the signed z of the max-|z| sector', () => {
    const baseline = makeBaseline();
    // Three sectors with distinct event counts → distinct rates → distinct z's.
    // Energy has the largest event count → largest positive z.
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, events: makeSectorEvents(8), baseline2y: baseline },
        { sector: 'Health Care', sectorSize: 30, events: makeSectorEvents(2), baseline2y: baseline },
        { sector: 'Materials', sectorSize: 30, events: makeSectorEvents(4), baseline2y: baseline },
      ],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    // Compute expected externally with same arithmetic — byte-identical to evaluator.
    const expectedZs = inputs.sectors.map((s) => ({
      sector: s.sector,
      z: computeZ(computeSectorDepartureRate(s.events, s.sectorSize, inputs.asOf), s.baseline2y).z,
    }));
    let bestZ: number | null = null;
    let bestAbs = -Infinity;
    for (const r of expectedZs) {
      if (r.z != null && Math.abs(r.z) > bestAbs) {
        bestAbs = Math.abs(r.z);
        bestZ = r.z;
      }
    }
    assert.ok(bestZ != null, 'expected at least one non-null z in test setup');
    assert.equal(snap.maxAggregateZ, bestZ);
  });

  it('MAXZ-XD-2: maxAggregateZSector names the sector with max |z|', () => {
    const baseline = makeBaseline();
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, events: makeSectorEvents(8), baseline2y: baseline },
        { sector: 'Health Care', sectorSize: 30, events: makeSectorEvents(2), baseline2y: baseline },
        { sector: 'Materials', sectorSize: 30, events: makeSectorEvents(4), baseline2y: baseline },
      ],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    const expectedZs = inputs.sectors.map((s) => ({
      sector: s.sector,
      z: computeZ(computeSectorDepartureRate(s.events, s.sectorSize, inputs.asOf), s.baseline2y).z,
    }));
    let bestAbs = -Infinity;
    let expectedSector: string | null = null;
    for (const r of expectedZs) {
      if (r.z != null && Math.abs(r.z) > bestAbs) {
        bestAbs = Math.abs(r.z);
        expectedSector = r.sector;
      }
    }
    assert.equal(snap.maxAggregateZSector, expectedSector);
    assert.equal(snap.maxAggregateZSector, 'Energy'); // sanity: highest event count
  });

  it('MAXZ-XD-3: both fields null when all sector z\'s are null (cold-start)', () => {
    const inputs = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 30, events: makeSectorEvents(8), baseline2y: [] },
        { sector: 'Materials', sectorSize: 30, events: makeSectorEvents(4), baseline2y: [] },
      ],
    });
    const snap = evaluateExecutiveDepartureComposite(inputs);
    assert.equal(snap.maxAggregateZ, null);
    assert.equal(snap.maxAggregateZSector, null);
  });

  it('MAXZ-XD-4: ties broken lexicographically (earlier sector name wins; input order-independent)', () => {
    const baseline = makeBaseline();
    const events = makeSectorEvents(5);
    // Two sectors with IDENTICAL inputs → identical rate → identical z.
    // 'Energy' < 'Materials' lexicographically → Energy wins regardless of input order.
    const inputsA = makeInputs({
      sectors: [
        { sector: 'Materials', sectorSize: 40, events, baseline2y: baseline },
        { sector: 'Energy', sectorSize: 40, events, baseline2y: baseline },
      ],
    });
    const inputsB = makeInputs({
      sectors: [
        { sector: 'Energy', sectorSize: 40, events, baseline2y: baseline },
        { sector: 'Materials', sectorSize: 40, events, baseline2y: baseline },
      ],
    });
    const snapA = evaluateExecutiveDepartureComposite(inputsA);
    const snapB = evaluateExecutiveDepartureComposite(inputsB);
    assert.equal(snapA.maxAggregateZSector, 'Energy');
    assert.equal(snapB.maxAggregateZSector, 'Energy');
    assert.equal(snapA.maxAggregateZ, snapB.maxAggregateZ);
  });
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe('constants (sanity)', () => {
  it('exposes the expected SPEC-pinned values', () => {
    assert.equal(EXECUTIVE_DEPARTURE_COMPOSITE_VERSION, 'exec_departure_v1');
    assert.equal(ROLLING_WINDOW_DAYS, 90);
    assert.equal(EXEC_CLUSTER_Z_THRESHOLD, 2.0);
    assert.equal(MIN_Z_BASELINE, 30);
    assert.equal(COMPOSITE_DEPARTURE_SUB_ITEM, '5.02(b)');
    assert.equal(COMPOSITE_APPOINTMENT_SUB_ITEM, '5.02(c)');
  });
});
