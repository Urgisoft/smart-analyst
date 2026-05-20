/**
 * Tests for src/server/cycle_position_dashboard.ts — the Phase A6 orchestrator
 * powering /api/cycle-position.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram, dashboard
 * panel branch), §6 (function signatures).
 *
 * Contract pinned here:
 *   - parseQuery rejects non-integer / out-of-range lookbackDays.
 *   - parseQuery accepts the SPEC defaults + bounds.
 *   - fetchCyclePositionState returns hasData=false (NOT 503) when the
 *     snapshots table is absent OR when the table is empty.
 *   - fetchCyclePositionState anchors history to the latest snapshot date
 *     (NOT wall clock) so a stale daemon still shows useful data.
 *   - latest payload projects the CyclePositionSnapshot shape onto the
 *     wire shape correctly (composite version, ISO date strings).
 *
 * No CH dependency — pure helpers + injected fakes. Live CH is hit only by
 * the manual smoke after panel ship.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  isQueryFailure,
  fetchCyclePositionState,
  LOOKBACK_DAYS_DEFAULT,
  LOOKBACK_DAYS_MIN,
  LOOKBACK_DAYS_MAX,
} from '../../src/server/cycle_position_dashboard.js';
import type { CyclePositionSnapshot } from '../../src/server/cycle_position.js';
import type { CyclePositionHistoryRow } from '../../src/server/cycle_position_repository.js';

// ───── parseQuery ────────────────────────────────────────────────────

describe('parseQuery', () => {
  it('applies the SPEC default when lookbackDays is absent', () => {
    const r = parseQuery({});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.lookbackDays, LOOKBACK_DAYS_DEFAULT);
  });

  it('accepts a valid lookbackDays inside the bounds', () => {
    const r = parseQuery({ lookbackDays: '90' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.lookbackDays, 90);
  });

  it('accepts the MIN bound exactly', () => {
    const r = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MIN) });
    assert.equal(r.ok, true);
  });

  it('accepts the MAX bound exactly', () => {
    const r = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MAX) });
    assert.equal(r.ok, true);
  });

  it('rejects lookbackDays below MIN', () => {
    const r = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MIN - 1) });
    assert.equal(r.ok, false);
    if (!isQueryFailure(r)) return;
    assert.equal(r.status, 400);
    assert.equal(r.error, 'bad_query');
    assert.match(r.detail, /lookbackDays/);
  });

  it('rejects lookbackDays above MAX', () => {
    const r = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MAX + 1) });
    assert.equal(r.ok, false);
  });

  it('rejects non-integer lookbackDays', () => {
    const r = parseQuery({ lookbackDays: '90.5' });
    assert.equal(r.ok, false);
  });

  it('rejects non-numeric lookbackDays', () => {
    const r = parseQuery({ lookbackDays: 'one-year' });
    assert.equal(r.ok, false);
  });

  it('treats undefined / null / empty string as default', () => {
    for (const v of [undefined, null, '']) {
      const r = parseQuery({ lookbackDays: v });
      assert.equal(r.ok, true, `expected ok for ${JSON.stringify(v)}`);
      if (!r.ok) continue;
      assert.equal(r.lookbackDays, LOOKBACK_DAYS_DEFAULT);
    }
  });
});

// ───── fetchCyclePositionState ──────────────────────────────────────

function makeSnapshot(overrides: Partial<CyclePositionSnapshot> = {}): CyclePositionSnapshot {
  return {
    asOf: new Date('2026-05-19T13:30:00.000Z'),
    score: 0.42,
    phaseLabel: 'late',
    recessionProbPct: 35.6,
    inputsPresent: 0b01111111,
    contributions: { yieldCurve: 0.4, credit: 0.5, employment: 0.36 },
    compositeVersion: 'cycle_v1',
    ...overrides,
  };
}

function makeHistoryRow(date: string, score: number): CyclePositionHistoryRow {
  return {
    snapshotDate: date,
    score,
    phaseLabel: 'mid',
    recessionProbPct: 20,
    inputsPresent: 127,
    contributions: { yieldCurve: score, credit: score, employment: score },
    inputs: {
      t10y3m: 1.5, t10y2y: 1.2, baa10y: 2.0, hyOas: 4.5,
      unrate: 4.0, unrate12mChange: 0.1, claims4wMaZscore: -0.3,
    },
    compositeVersion: 'cycle_v1',
  };
}

describe('fetchCyclePositionState', () => {
  it('returns hasData=false + empty payload when the snapshots table is absent', async () => {
    const res = await fetchCyclePositionState(
      { lookbackDays: 365 },
      {
        tableExists: async () => false,
        repo: {
          async loadLatestSnapshot() { throw new Error('should not be called'); },
          async loadHistory() { throw new Error('should not be called'); },
        },
      },
    );
    assert.equal(res.hasData, false);
    assert.equal(res.lookbackDays, 365);
    assert.equal(res.latest, null);
    assert.deepEqual(res.history, []);
  });

  it('returns hasData=false when the table exists but no rows yet', async () => {
    const res = await fetchCyclePositionState(
      { lookbackDays: 365 },
      {
        tableExists: async () => true,
        repo: {
          async loadLatestSnapshot() { return null; },
          async loadHistory() { throw new Error('should not be called when latest is null'); },
        },
      },
    );
    assert.equal(res.hasData, false);
    assert.equal(res.latest, null);
    assert.deepEqual(res.history, []);
  });

  it('returns hasData=true with latest + history when data is present', async () => {
    const snapshot = makeSnapshot();
    let historyCalledWith: { asOf: Date; lookbackDays: number } | null = null;
    const history = [
      makeHistoryRow('2026-05-15', 0.5),
      makeHistoryRow('2026-05-16', 0.55),
      makeHistoryRow('2026-05-19', 0.42),
    ];
    const res = await fetchCyclePositionState(
      { lookbackDays: 90 },
      {
        tableExists: async () => true,
        repo: {
          async loadLatestSnapshot() { return snapshot; },
          async loadHistory(asOf: Date, lookbackDays: number) {
            historyCalledWith = { asOf, lookbackDays };
            return history;
          },
        },
        now: () => new Date('2026-05-20T13:30:00.000Z'),
      },
    );
    assert.equal(res.hasData, true);
    assert.equal(res.lookbackDays, 90);
    assert.equal(res.history.length, 3);
    assert.deepEqual(res.history.map(h => h.snapshotDate), ['2026-05-15', '2026-05-16', '2026-05-19']);
    // History anchored to latest snapshot's asOf, not wall clock.
    assert.equal(historyCalledWith!.asOf.getTime(), snapshot.asOf.getTime());
    assert.equal(historyCalledWith!.lookbackDays, 90);
  });

  it('projects latest into wire shape (ISO date + composite version + contributions)', async () => {
    const snapshot = makeSnapshot();
    const res = await fetchCyclePositionState(
      { lookbackDays: 30 },
      {
        tableExists: async () => true,
        repo: {
          async loadLatestSnapshot() { return snapshot; },
          async loadHistory() { return []; },
        },
      },
    );
    assert.ok(res.latest);
    assert.equal(res.latest!.snapshotDate, '2026-05-19');
    assert.equal(res.latest!.evaluatedAt, '2026-05-19T13:30:00.000Z');
    assert.equal(res.latest!.score, 0.42);
    assert.equal(res.latest!.phaseLabel, 'late');
    assert.equal(res.latest!.recessionProbPct, 35.6);
    assert.equal(res.latest!.inputsPresent, 0b01111111);
    assert.equal(res.latest!.compositeVersion, 'cycle_v1');
    assert.equal(res.latest!.contributions.yieldCurve, 0.4);
    assert.equal(res.latest!.contributions.credit, 0.5);
    assert.equal(res.latest!.contributions.employment, 0.36);
  });

  it('falls back to wall clock when the latest snapshot date is somehow in the future', async () => {
    // Defensive case: snapshot.asOf > now. anchor should clamp to wall clock.
    const futureSnap = makeSnapshot({ asOf: new Date('2099-01-01T00:00:00.000Z') });
    let anchor: Date | null = null;
    await fetchCyclePositionState(
      { lookbackDays: 30 },
      {
        tableExists: async () => true,
        repo: {
          async loadLatestSnapshot() { return futureSnap; },
          async loadHistory(asOf: Date) { anchor = asOf; return []; },
        },
        now: () => new Date('2026-05-20T00:00:00.000Z'),
      },
    );
    assert.equal(anchor!.toISOString(), '2026-05-20T00:00:00.000Z');
  });
});
