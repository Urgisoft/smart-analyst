/**
 * T-D1..T-D4 — Cluster diagnostics endpoint (Phase 2 §5.5).
 *
 * The endpoint's testable surface is three pure functions in
 * `src/server/cluster_dashboard.ts`:
 *
 *   - `parseDiagnosticsQuery`       — request validation
 *   - `composeDiagnosticsResponse`  — raw CH rows → response shape
 *   - `buildCohortComposition`      — tier-count rollup
 *
 * The orchestrator (`fetchClusterDiagnostics`) is integration-tested by SMK-1
 * (manual browser open). T-D1..T-D4 below pin the contract that the SPEC
 * froze on 2026-05-04, with a fixture small enough to read at a glance.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiagnosticsQuery,
  composeDiagnosticsResponse,
  buildCohortComposition,
  buildDiagnosticsSql,
  buildOtherMethodSql,
  DASHBOARD_THRESHOLDS,
  type RawDiagnosticsRow,
  type RawOtherMethodRow,
  type RawCohortRow,
} from '../../src/server/cluster_dashboard.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal HDBSCAN diagnostic row in the shape CH returns from JSONEachRow. */
function rawRow(over: Partial<RawDiagnosticsRow> = {}): RawDiagnosticsRow {
  return {
    fit_id: '00000000-0000-0000-0000-000000000001',
    week_start: '2026-04-13',
    status: 'published',
    n_tokens_input: 200,
    n_tokens_clustered: 50,
    n_clusters: 2,
    n_noise: 150,
    silhouette: 0.42,
    calinski_harabasz: 100.5,
    q_score: 0.7,
    n_disagreement: 1,
    fit_seconds: 12.3,
    computed_at: '2026-04-13 12:00:00',
    n_admitted: 40,
    has_orphans: 0,
    ...over,
  };
}

// ── T-D1 — endpoint returns rows ordered weekStart ASC ───────────────────────

describe('T-D1 — diagnostics rows preserve weekStart ASC ordering', () => {
  test('composer keeps the SQL-side ordering intact', () => {
    // SQL builder emits ORDER BY week_start ASC. The composer must not reorder.
    // Three weeks ascending; assert the composer preserves that.
    const primaryRows: RawDiagnosticsRow[] = [
      rawRow({ week_start: '2026-04-13', fit_id: 'fit-a' }),
      rawRow({ week_start: '2026-04-20', fit_id: 'fit-b' }),
      rawRow({ week_start: '2026-04-27', fit_id: 'fit-c' }),
    ];
    const response = composeDiagnosticsResponse({
      primaryRows,
      otherRows: [],
      cohort: null,
      weeks: 12,
      method: 'hdbscan',
    });
    assert.deepEqual(
      response.rows.map(r => r.weekStart),
      ['2026-04-13', '2026-04-20', '2026-04-27'],
    );
  });
});

// ── T-D2 — weeks clamping (out-of-range → 400) ───────────────────────────────

describe('T-D2 — parseDiagnosticsQuery rejects out-of-range weeks', () => {
  test('weeks=0 returns bad_query', () => {
    const r = parseDiagnosticsQuery({ weeks: '0', method: 'hdbscan' });
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.status, 400);
      assert.equal(r.error, 'bad_query');
    }
  });

  test('weeks=999 returns bad_query', () => {
    const r = parseDiagnosticsQuery({ weeks: '999', method: 'hdbscan' });
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.status, 400);
      assert.equal(r.error, 'bad_query');
    }
  });

  test('weeks=12 (default) accepts', () => {
    const r = parseDiagnosticsQuery({ method: 'hdbscan' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.weeks, 12);
      assert.equal(r.method, 'hdbscan');
    }
  });

  test('weeks=1 (lower edge) and weeks=52 (upper edge) accept', () => {
    const lower = parseDiagnosticsQuery({ weeks: '1', method: 'hdbscan' });
    const upper = parseDiagnosticsQuery({ weeks: '52', method: 'hdbscan' });
    assert.equal(lower.ok, true);
    assert.equal(upper.ok, true);
  });

  test('non-integer weeks rejected', () => {
    const r = parseDiagnosticsQuery({ weeks: '12.5', method: 'hdbscan' });
    assert.equal(r.ok, false);
  });

  test('non-numeric weeks rejected', () => {
    const r = parseDiagnosticsQuery({ weeks: 'abc', method: 'hdbscan' });
    assert.equal(r.ok, false);
  });

  test('method outside enum rejected', () => {
    const r = parseDiagnosticsQuery({ weeks: '12', method: 'kmeans' });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.error, 'bad_query');
  });

  test('method=gmm_bic accepted', () => {
    const r = parseDiagnosticsQuery({ weeks: '12', method: 'gmm_bic' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.method, 'gmm_bic');
  });
});

// ── T-D3 — staleFitDays threshold echoed at 8 ────────────────────────────────

describe('T-D3 — thresholds.staleFitDays is regression-pinned at 8', () => {
  test('every response carries the same frozen thresholds object', () => {
    const response = composeDiagnosticsResponse({
      primaryRows: [],
      otherRows: [],
      cohort: null,
      weeks: 12,
      method: 'hdbscan',
    });
    assert.equal(response.thresholds.staleFitDays, 8);
    // Pin the rest of the thresholds so a future drift trips this test —
    // these values are also load-bearing in cluster_tokens_weekly.py.
    assert.equal(response.thresholds.qScore, 0.5);
    assert.equal(response.thresholds.disagreement, 1);
    assert.equal(response.thresholds.tradeabilityVol, 0.10);
  });

  test('DASHBOARD_THRESHOLDS is frozen (mutation throws)', () => {
    assert.throws(() => {
      // @ts-expect-error — testing runtime immutability
      DASHBOARD_THRESHOLDS.staleFitDays = 99;
    }, TypeError);
  });
});

// ── T-D4 — cohortComposition non-null only on the latest row ─────────────────

describe('T-D4 — cohortComposition attaches only to the latest row', () => {
  test('three-row response: only rows[2] carries cohort', () => {
    const primaryRows: RawDiagnosticsRow[] = [
      rawRow({ week_start: '2026-04-13', fit_id: 'fit-a' }),
      rawRow({ week_start: '2026-04-20', fit_id: 'fit-b' }),
      rawRow({ week_start: '2026-04-27', fit_id: 'fit-c' }),
    ];
    const cohort = {
      dominantTier: 'mcap_micro',
      dominantPct: 0.65,
      isFragmented: false,
      breakdown: [{ tier: 'mcap_micro', pct: 0.65 }, { tier: 'mcap_nano', pct: 0.35 }],
    };
    const response = composeDiagnosticsResponse({
      primaryRows,
      otherRows: [],
      cohort,
      weeks: 12,
      method: 'hdbscan',
    });
    assert.equal(response.rows[0].cohortComposition, null);
    assert.equal(response.rows[1].cohortComposition, null);
    assert.deepEqual(response.rows[2].cohortComposition, cohort);
  });

  test('single-row response: rows[0] carries cohort', () => {
    const response = composeDiagnosticsResponse({
      primaryRows: [rawRow()],
      otherRows: [],
      cohort: {
        dominantTier: 'mcap_micro',
        dominantPct: 1.0,
        isFragmented: false,
        breakdown: [{ tier: 'mcap_micro', pct: 1.0 }],
      },
      weeks: 12,
      method: 'hdbscan',
    });
    assert.notEqual(response.rows[0].cohortComposition, null);
  });

  test('empty response: no rows, cohort discarded', () => {
    const response = composeDiagnosticsResponse({
      primaryRows: [],
      otherRows: [],
      cohort: {
        dominantTier: 'mcap_micro',
        dominantPct: 1.0,
        isFragmented: false,
        breakdown: [],
      },
      weeks: 12,
      method: 'hdbscan',
    });
    assert.deepEqual(response.rows, []);
  });
});

// ── Other-method n_clusters merge (supports T-D1..T-D4 indirectly) ───────────

describe('other-method n_clusters merge', () => {
  test('method=hdbscan: nClustersGmm filled from otherRows', () => {
    const primaryRows: RawDiagnosticsRow[] = [rawRow({ n_clusters: 2 })];
    const otherRows: RawOtherMethodRow[] = [{ week_start: '2026-04-13', n_clusters: 3 }];
    const response = composeDiagnosticsResponse({
      primaryRows, otherRows, cohort: null, weeks: 12, method: 'hdbscan',
    });
    assert.equal(response.rows[0].nClustersHdb, 2);
    assert.equal(response.rows[0].nClustersGmm, 3);
  });

  test('method=hdbscan, no GMM row: nClustersGmm is null (per SPEC)', () => {
    const primaryRows: RawDiagnosticsRow[] = [rawRow({ n_clusters: 2 })];
    const response = composeDiagnosticsResponse({
      primaryRows, otherRows: [], cohort: null, weeks: 12, method: 'hdbscan',
    });
    assert.equal(response.rows[0].nClustersGmm, null);
  });

  test('method=gmm_bic: roles flip — primary fills nClustersGmm', () => {
    const primaryRows: RawDiagnosticsRow[] = [rawRow({ n_clusters: 4 })];
    const otherRows: RawOtherMethodRow[] = [{ week_start: '2026-04-13', n_clusters: 2 }];
    const response = composeDiagnosticsResponse({
      primaryRows, otherRows, cohort: null, weeks: 12, method: 'gmm_bic',
    });
    assert.equal(response.rows[0].nClustersGmm, 4);
    assert.equal(response.rows[0].nClustersHdb, 2);
  });
});

// ── NaN coercion (silent corruption guard) ──────────────────────────────────

describe('NaN coercion for q_score / silhouette / calinski_harabasz', () => {
  test('CH-side NaN string maps to JSON null', () => {
    const primaryRows: RawDiagnosticsRow[] = [rawRow({
      q_score: 'nan',
      silhouette: 'nan',
      calinski_harabasz: 'nan',
    })];
    const response = composeDiagnosticsResponse({
      primaryRows, otherRows: [], cohort: null, weeks: 12, method: 'hdbscan',
    });
    assert.equal(response.rows[0].qScore, null);
    assert.equal(response.rows[0].silhouette, null);
    assert.equal(response.rows[0].calinskiHarabasz, null);
  });

  test('finite numbers pass through unchanged', () => {
    const primaryRows: RawDiagnosticsRow[] = [rawRow({
      q_score: 0.7,
      silhouette: 0.42,
      calinski_harabasz: 100.5,
    })];
    const response = composeDiagnosticsResponse({
      primaryRows, otherRows: [], cohort: null, weeks: 12, method: 'hdbscan',
    });
    assert.equal(response.rows[0].qScore, 0.7);
    assert.equal(response.rows[0].silhouette, 0.42);
    assert.equal(response.rows[0].calinskiHarabasz, 100.5);
  });

  test('has_orphans accepts 1/0 and true/false', () => {
    const fromInt = composeDiagnosticsResponse({
      primaryRows: [rawRow({ has_orphans: 1 })],
      otherRows: [], cohort: null, weeks: 12, method: 'hdbscan',
    });
    const fromBool = composeDiagnosticsResponse({
      primaryRows: [rawRow({ has_orphans: true })],
      otherRows: [], cohort: null, weeks: 12, method: 'hdbscan',
    });
    assert.equal(fromInt.rows[0].hasOrphans, true);
    assert.equal(fromBool.rows[0].hasOrphans, true);
  });
});

// ── Cohort composition rollup ────────────────────────────────────────────────

describe('buildCohortComposition — tier rollup', () => {
  test('empty input → null (F-1)', () => {
    assert.equal(buildCohortComposition([]), null);
  });

  test('all-zero counts → null', () => {
    const rows: RawCohortRow[] = [{ tier: 'mcap_micro', n: 0 }];
    assert.equal(buildCohortComposition(rows), null);
  });

  test('single tier → dominantPct=1.0, isFragmented=false', () => {
    const rows: RawCohortRow[] = [{ tier: 'mcap_micro', n: 100 }];
    const c = buildCohortComposition(rows);
    assert.notEqual(c, null);
    assert.equal(c!.dominantTier, 'mcap_micro');
    assert.equal(c!.dominantPct, 1.0);
    assert.equal(c!.isFragmented, false);
  });

  test('dominant ≥ 0.60 → not fragmented', () => {
    const rows: RawCohortRow[] = [
      { tier: 'mcap_micro', n: 65 },
      { tier: 'mcap_nano', n: 35 },
    ];
    const c = buildCohortComposition(rows);
    assert.equal(c!.isFragmented, false);
    assert.equal(c!.dominantTier, 'mcap_micro');
  });

  test('dominant < 0.60 → fragmented (OQ-D2)', () => {
    const rows: RawCohortRow[] = [
      { tier: 'mcap_micro', n: 40 },
      { tier: 'mcap_nano', n: 35 },
      { tier: 'mcap_small', n: 25 },
    ];
    const c = buildCohortComposition(rows);
    assert.equal(c!.isFragmented, true);
  });

  test('breakdown limited to top 5, sorted by pct desc', () => {
    const rows: RawCohortRow[] = [
      { tier: 'a', n: 1 }, { tier: 'b', n: 2 }, { tier: 'c', n: 3 },
      { tier: 'd', n: 4 }, { tier: 'e', n: 5 }, { tier: 'f', n: 6 },
    ];
    const c = buildCohortComposition(rows);
    assert.equal(c!.breakdown.length, 5);
    assert.equal(c!.breakdown[0].tier, 'f');
    assert.equal(c!.breakdown[4].tier, 'b');
  });

  test('ties broken by tier name ASC for determinism', () => {
    const rows: RawCohortRow[] = [
      { tier: 'mcap_nano', n: 50 },
      { tier: 'mcap_micro', n: 50 },
    ];
    const c = buildCohortComposition(rows);
    // 'mcap_micro' sorts ASC before 'mcap_nano' on the tie.
    assert.equal(c!.dominantTier, 'mcap_micro');
  });
});

// ── T-D5 — UUID byte-order regression on latest_fits ────────────────────────
//
// SMK-1 finding 2026-05-04: Panel A surfaced fit `0c02a267` (unstable, no
// memberships) for week 2026-05-04 instead of fit `12095c59` (single_cohort,
// 91 admitted, computed ~70 minutes later). Root cause: `latest_fits` used
// `max(fit_id)` which in CH compares UUIDs by INTERNAL byte layout (variant-
// aware swap), not textual lex and not temporal. For these two UUIDs the
// internal byte ranking inverts the expected order.
//
// Fix: use `argMax(fit_id, (computed_at, fit_id))` so recency wins. Same fix
// applied to `buildOtherMethodSql`'s `latest_other`. T-D5 pins both — a future
// "let's go back to max(fit_id)" refactor will fail the test, not silently
// re-introduce the bug.
describe('T-D5 — latest_fits/latest_other use argMax(computed_at) not max(UUID)', () => {
  test('buildDiagnosticsSql replaces max(fit_id) with argMax(fit_id, (computed_at, fit_id))', () => {
    const sql = buildDiagnosticsSql({ weeks: 12, method: 'hdbscan' });
    assert.match(
      sql.query,
      /argMax\(fit_id,\s*\(computed_at,\s*fit_id\)\)\s*AS\s+fit_id/,
      'latest_fits must use argMax(fit_id, (computed_at, fit_id)) — recency-first, fit_id as deterministic tiebreak',
    );
    assert.doesNotMatch(
      sql.query,
      /max\(fit_id\)\s*AS\s+fit_id/,
      'max(fit_id) must NOT appear — CH max(UUID) is byte-order, not temporal',
    );
  });

  test('buildOtherMethodSql replaces max(fit_id) with argMax(fit_id, (computed_at, fit_id))', () => {
    const sql = buildOtherMethodSql({ weeks: 12, method: 'hdbscan' });
    assert.match(
      sql.query,
      /argMax\(fit_id,\s*\(computed_at,\s*fit_id\)\)\s*AS\s+fit_id/,
      'latest_other must use argMax(fit_id, (computed_at, fit_id)) for the same reason as latest_fits',
    );
    assert.doesNotMatch(
      sql.query,
      /max\(fit_id\)\s*AS\s+fit_id/,
      'max(fit_id) must NOT appear in latest_other either',
    );
  });
});
