/**
 * Unit tests for bt_runs_regime pure helpers.
 *
 * SPEC: docs/specs/regime-backtest-attribution-component5.md §4.
 *
 * No ClickHouse connection — every test exercises a pure function. The
 * impure entry points (attributeBacktestRegime, backfillBacktestRegime,
 * fetchBtRunsByRegime) are covered by manual smoke against a live CH after
 * backfill runs in a future session.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWindow,
  computeDistribution,
  dominantRegime,
  buildAttributionResult,
  buildSentinelResult,
  BtRunsRegimeError,
  type RegimeDayCount,
} from '../../src/server/bt_runs_regime.js';

// ── deriveWindow ────────────────────────────────────────────────────────────

describe('deriveWindow', () => {
  it('returns expected [start, end] for a 90-day window ending mid-day UTC', () => {
    // SPEC test #1.
    const w = deriveWindow({
      startedAt: '2025-04-10T17:00:00.000Z',
      dataSpanDays: 90,
    });
    assert.deepEqual(w, {
      data_start_date: '2025-01-10',
      data_end_date: '2025-04-10',
    });
  });

  it('returns null for legacy rows with dataSpanDays = 0', () => {
    // SPEC test #1 edge case — caller falls back to bt_trades.
    const w = deriveWindow({ startedAt: '2025-04-10T00:00:00Z', dataSpanDays: 0 });
    assert.equal(w, null);
  });

  it('returns null for negative or NaN dataSpanDays defensively', () => {
    assert.equal(deriveWindow({ startedAt: '2025-04-10T00:00:00Z', dataSpanDays: -1 }), null);
    assert.equal(deriveWindow({ startedAt: '2025-04-10T00:00:00Z', dataSpanDays: NaN }), null);
  });

  it('rounds non-integer dataSpanDays half-up via Math.round', () => {
    // SPEC test #2 — convention pinned.
    const a = deriveWindow({ startedAt: '2025-04-10T00:00:00Z', dataSpanDays: 89.4 });
    const b = deriveWindow({ startedAt: '2025-04-10T00:00:00Z', dataSpanDays: 89.6 });
    assert.equal(a?.data_start_date, '2025-01-11');  // 90-89 = 1 day later than b
    assert.equal(b?.data_start_date, '2025-01-10');  // 90 days back from 2025-04-10
  });

  it('truncates UTC time on the end date deterministically', () => {
    // 23:59 UTC and 00:00 the next day must produce different end_dates.
    const eveOf10 = deriveWindow({ startedAt: '2025-04-10T23:59:59.999Z', dataSpanDays: 1 });
    const startOf11 = deriveWindow({ startedAt: '2025-04-11T00:00:00.000Z', dataSpanDays: 1 });
    assert.equal(eveOf10?.data_end_date, '2025-04-10');
    assert.equal(startOf11?.data_end_date, '2025-04-11');
  });

  it('throws BtRunsRegimeError for unparseable startedAt', () => {
    assert.throws(
      () => deriveWindow({ startedAt: 'not-a-date', dataSpanDays: 30 }),
      (err: unknown) => err instanceof BtRunsRegimeError && err.code === 'invalid_window',
    );
  });
});

// ── computeDistribution ─────────────────────────────────────────────────────

describe('computeDistribution', () => {
  it('normalizes counts to shares summing to 1 (within float tolerance)', () => {
    // SPEC test #3.
    const rows: RegimeDayCount[] = [
      { regime: 'green', count: 60 },
      { regime: 'yellow', count: 30 },
      { regime: 'red', count: 10 },
    ];
    const { distribution, total } = computeDistribution(rows);
    assert.equal(total, 100);
    assert.equal(distribution.green, 0.6);
    assert.equal(distribution.yellow, 0.3);
    assert.equal(distribution.red, 0.1);
    const sum = Object.values(distribution).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `sum should be 1, got ${sum}`);
  });

  it('returns sentinel shape for empty input', () => {
    // SPEC test #4.
    const { distribution, total } = computeDistribution([]);
    assert.deepEqual(distribution, {});
    assert.equal(total, 0);
  });

  it('skips zero-count rows in the output', () => {
    const rows: RegimeDayCount[] = [
      { regime: 'green', count: 50 },
      { regime: 'orange', count: 0 },
      { regime: 'red', count: 50 },
    ];
    const { distribution } = computeDistribution(rows);
    assert.equal(distribution.orange, undefined);
    assert.equal(distribution.green, 0.5);
    assert.equal(distribution.red, 0.5);
  });

  it('handles a single-regime window (share = 1)', () => {
    const { distribution, total } = computeDistribution([{ regime: 'green', count: 252 }]);
    assert.equal(total, 252);
    assert.equal(distribution.green, 1);
    assert.equal(Object.keys(distribution).length, 1);
  });
});

// ── dominantRegime ──────────────────────────────────────────────────────────

describe('dominantRegime', () => {
  it('picks argmax with simple distinct shares', () => {
    // SPEC test #5.
    const { regime, share } = dominantRegime({ green: 0.6, yellow: 0.3, red: 0.1 });
    assert.equal(regime, 'green');
    assert.equal(share, 0.6);
  });

  it('breaks ties by lex ASC on the regime string', () => {
    // SPEC test #5 — tie-break.
    const { regime, share } = dominantRegime({ green: 0.4, yellow: 0.4, red: 0.2 });
    assert.equal(regime, 'green', `green sorts before yellow; got ${regime}`);
    assert.equal(share, 0.4);
  });

  it('returns sentinel for an empty distribution', () => {
    const { regime, share } = dominantRegime({});
    assert.equal(regime, 'unknown');
    assert.equal(share, 0);
  });

  it('is deterministic under a tie across 100 randomly-permuted insertion orders', () => {
    // SPEC test #6 — property-based check on tie-break determinism.
    const labels = ['green', 'orange', 'red', 'yellow'];
    for (let trial = 0; trial < 100; trial++) {
      // Build a tied distribution with all 4 regimes at 0.25 each, but in
      // randomized property insertion order.
      const shuffled = [...labels].sort(() => Math.random() - 0.5);
      const dist: Record<string, number> = {};
      for (const k of shuffled) dist[k] = 0.25;
      const { regime } = dominantRegime(dist);
      assert.equal(
        regime,
        'green',
        `trial ${trial} (insertion order ${shuffled.join(',')}): expected lex-min 'green', got '${regime}'`,
      );
    }
  });

  it('returns the unique max when one share strictly dominates', () => {
    const { regime } = dominantRegime({ red: 0.51, green: 0.49 });
    assert.equal(regime, 'red');
  });
});

// ── buildAttributionResult ──────────────────────────────────────────────────

describe('buildAttributionResult', () => {
  it('assembles a row with distribution, dominant fields, and source tag', () => {
    // SPEC test #7 — pure assembly without CH.
    const r = buildAttributionResult({
      run_id: 'aaa-bbb-ccc',
      classifier_version: 'phase1_v2',
      window: { data_start_date: '2024-01-01', data_end_date: '2024-04-10' },
      rows: [
        { regime: 'green', count: 70 },
        { regime: 'yellow', count: 25 },
        { regime: 'red', count: 5 },
      ],
      attribution_source: 'window',
    });
    assert.equal(r.run_id, 'aaa-bbb-ccc');
    assert.equal(r.classifier_version, 'phase1_v2');
    assert.equal(r.dominant_regime, 'green');
    assert.equal(r.dominant_regime_share, 0.7);
    assert.equal(r.total_days, 100);
    assert.equal(r.attribution_source, 'window');
    assert.equal(r.regime_distribution.green, 0.7);
    assert.equal(r.data_start_date, '2024-01-01');
    assert.equal(r.data_end_date, '2024-04-10');
  });

  it('produces an empty-distribution + unknown-dominant when rows are empty', () => {
    // No CH coverage in window — caller will see `unknown` as the label.
    const r = buildAttributionResult({
      run_id: 'x',
      classifier_version: 'phase1_v2',
      window: { data_start_date: '1990-01-01', data_end_date: '1990-12-31' },
      rows: [],
      attribution_source: 'window',
    });
    assert.equal(r.dominant_regime, 'unknown');
    assert.equal(r.dominant_regime_share, 0);
    assert.equal(r.total_days, 0);
    assert.deepEqual(r.regime_distribution, {});
  });
});

// ── buildSentinelResult ─────────────────────────────────────────────────────

describe('buildSentinelResult', () => {
  it('produces a zero-trade sentinel keyed to started_at date', () => {
    // SPEC test #11 — zero-trade legacy run path.
    const r = buildSentinelResult({
      run_id: 'zero-trade-run',
      classifier_version: 'phase1_v2',
      asOfDate: '2024-06-15',
    });
    assert.equal(r.dominant_regime, 'unknown');
    assert.equal(r.dominant_regime_share, 0);
    assert.equal(r.total_days, 0);
    assert.equal(r.attribution_source, 'sentinel_no_trades');
    assert.equal(r.data_start_date, '2024-06-15');
    assert.equal(r.data_end_date, '2024-06-15');
    assert.deepEqual(r.regime_distribution, {});
  });
});

// ── BtRunsRegimeError ───────────────────────────────────────────────────────

describe('BtRunsRegimeError', () => {
  it('exposes structured `code` for caller pattern-matching', () => {
    // SPEC test #14.
    const err = new BtRunsRegimeError('run_not_found', 'abc-123');
    assert.equal(err.code, 'run_not_found');
    assert.equal(err.detail, 'abc-123');
    assert.equal(err.name, 'BtRunsRegimeError');
    assert.match(err.message, /run_not_found.*abc-123/);
    // `instanceof` survives transpilation — Vector Core relies on this for
    // route-handler error branches.
    assert.ok(err instanceof BtRunsRegimeError);
    assert.ok(err instanceof Error);
  });
});
