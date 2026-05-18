/**
 * T-S1..T-S5 — Cluster scores endpoint (Phase 2 §5.5).
 *
 * Tests target the pure-function seam:
 *   - `parseScoresQuery`         — request validation
 *   - `composeScoresResponse`    — raw rows → response shape (sort + comparator + hint)
 *   - `deflationCollapseHint`    — server-side derivation rule
 *
 * Orchestrator-side error paths (NoPublishedFitError → 404) are smoke-verified
 * by SMK-1; the test below exercises the parsing of a request that, in
 * production, would lead to that 404.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScoresQuery,
  composeScoresResponse,
  deflationCollapseHint,
  dsrUntestableHint,
  buildResolveLatestFitSql,
  buildScoresSql,
  buildCohortSql,
  buildAdmittedCountSql,
  NoPublishedFitError,
  type RawScoreRow,
  type RawTierComparatorRow,
  type ScoresCohort,
} from '../../src/server/cluster_dashboard.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function rawScoreRow(over: Partial<RawScoreRow> = {}): RawScoreRow {
  return {
    strategy_type: 'mean_reversion_v1',
    cluster_id: 0,
    interval: '1d',
    best_param: 5,
    composite: 0.5,
    dsr: 0.0,
    psr: 1.0,
    pbo: null,
    hlz_t_passes: 1,
    oos_is_ratio: 0.4,
    oos_is_status: 'pass',
    gates_pass: 0,
    n_tokens_total: 50,
    n_tokens_traded: 30,
    n_tokens_winning: 18,
    n_tokens_in_cluster: 170,
    total_trades: 1234,
    wt_net_pct: 12.3,
    oos_wt_net_pct: 4.5,
    agg_pf: 1.2,
    oos_norm: 0.5,
    plateau: 0.4,
    tier_coverage: 0.6,
    trades_norm: 0.7,
    ...over,
  };
}

const cohortPublished: ScoresCohort = {
  dominantTier: 'mcap_micro',
  dominantPct: 0.7,
  isFragmented: false,
  nAdmitted: 91,
};

const cohortFragmented: ScoresCohort = {
  dominantTier: 'mcap_micro',
  dominantPct: 0.4,
  isFragmented: true,
  nAdmitted: 91,
};

function compose(over: Partial<Parameters<typeof composeScoresResponse>[0]> = {}) {
  return composeScoresResponse({
    fitId: 'fit-aaaa',
    weekStart: '2026-05-04',
    status: 'single_cohort',
    fitAgeDays: 0,
    staleFitDays: 8,
    rawRows: [],
    comparatorRows: [],
    cohort: cohortPublished,
    ...over,
  });
}

// ── T-S1 — empty rows → 200 with rows: [] (not 404) ──────────────────────────

describe('T-S1 — empty strategy_scores_by_cluster returns 200 with rows:[]', () => {
  test('composer accepts zero rawRows and returns empty rows array', () => {
    const r = compose({ rawRows: [], comparatorRows: [] });
    assert.deepEqual(r.rows, []);
    // The other fields (fitId, weekStart, status, cohort) still populated:
    assert.equal(r.fitId, 'fit-aaaa');
    assert.equal(r.weekStart, '2026-05-04');
  });

  test('isStale derived correctly even with no rows', () => {
    const fresh = compose({ rawRows: [], fitAgeDays: 3, staleFitDays: 8 });
    const stale = compose({ rawRows: [], fitAgeDays: 9, staleFitDays: 8 });
    assert.equal(fresh.isStale, false);
    assert.equal(stale.isStale, true);
  });

  test('boundary fitAgeDays = staleFitDays NOT stale (strict >)', () => {
    const r = compose({ rawRows: [], fitAgeDays: 8, staleFitDays: 8 });
    assert.equal(r.isStale, false);
  });
});

// ── T-S2 — no published/single_cohort fit → NoPublishedFitError ──────────────

describe('T-S2 — NoPublishedFitError shape', () => {
  test('error name + message support 404 mapping', () => {
    const e = new NoPublishedFitError();
    assert.equal(e.name, 'NoPublishedFitError');
    assert.equal(e.message, 'no_published_fit');
    assert.ok(e instanceof Error);
  });
});

// ── T-S3 — deflationCollapseHint rule ────────────────────────────────────────

describe('T-S3 — deflationCollapseHint: psr >= 0.95 && dsr <= 0.05', () => {
  test('canonical case (psr=1.0, dsr=0.0) → hint set', () => {
    const h = deflationCollapseHint(1.0, 0.0);
    assert.notEqual(h, null);
    assert.match(h!, /PSR=1\.00 \/ DSR=0\.00/);
    assert.match(h!, /selection-bias deflation/);
    assert.match(h!, /check\.md FB-01/);
  });

  test('boundary (psr=0.95, dsr=0.05) → hint set (inclusive thresholds)', () => {
    assert.notEqual(deflationCollapseHint(0.95, 0.05), null);
  });

  test('near-miss (psr=0.94, dsr=0.04) → null (outside bounds)', () => {
    assert.equal(deflationCollapseHint(0.94, 0.04), null);
  });

  test('high psr but high dsr (psr=0.96, dsr=0.10) → null (dsr too high)', () => {
    assert.equal(deflationCollapseHint(0.96, 0.10), null);
  });

  test('NaN inputs → null', () => {
    assert.equal(deflationCollapseHint(NaN, 0.05), null);
    assert.equal(deflationCollapseHint(0.99, NaN), null);
  });

  test('hint propagates onto the row in compose()', () => {
    const r = compose({ rawRows: [rawScoreRow({ psr: 1.0, dsr: 0.0 })] });
    assert.notEqual(r.rows[0].deflationCollapseHint, null);
  });

  test('row without the signature → hint null', () => {
    const r = compose({ rawRows: [rawScoreRow({ psr: 0.5, dsr: 0.5 })] });
    assert.equal(r.rows[0].deflationCollapseHint, null);
  });
});

// ── T-S4 — fragmented cohort ⇒ all tierAxisCompare null ──────────────────────

describe('T-S4 — fragmented cohort suppresses tier-axis comparator on every row', () => {
  test('isFragmented=true ⇒ every row has tierAxisCompare:null even when comparator data exists', () => {
    const rawRows: RawScoreRow[] = [
      rawScoreRow({ strategy_type: 'mean_reversion_v1', interval: '1d' }),
      rawScoreRow({ strategy_type: 'tsmom_vol_v1',      interval: '4h' }),
    ];
    const comparatorRows: RawTierComparatorRow[] = [
      { strategy_type: 'mean_reversion_v1', tier: 'mcap_micro', interval: '1d', composite: 0.4, dsr: 0.6, oos_is_ratio: 0.5 },
      { strategy_type: 'tsmom_vol_v1',      tier: 'mcap_micro', interval: '4h', composite: 0.3, dsr: 0.5, oos_is_ratio: 0.4 },
    ];
    const r = compose({ rawRows, comparatorRows, cohort: cohortFragmented });
    for (const row of r.rows) {
      assert.equal(row.tierAxisCompare, null,
        `row ${row.strategyType}|${row.interval} should have tierAxisCompare null when cohort is fragmented`);
    }
  });

  test('isFragmented=false + comparator present ⇒ tierAxisCompare populated with deltas', () => {
    const rawRows: RawScoreRow[] = [
      rawScoreRow({ strategy_type: 'mean_reversion_v1', interval: '1d', composite: 0.5, dsr: 0.0 }),
    ];
    const comparatorRows: RawTierComparatorRow[] = [
      { strategy_type: 'mean_reversion_v1', tier: 'mcap_micro', interval: '1d', composite: 0.3, dsr: 0.6, oos_is_ratio: 0.5 },
    ];
    const r = compose({ rawRows, comparatorRows, cohort: cohortPublished });
    const cmp = r.rows[0].tierAxisCompare;
    assert.notEqual(cmp, null);
    assert.equal(cmp!.tier, 'mcap_micro');
    assert.equal(cmp!.composite, 0.3);
    assert.equal(cmp!.dsr, 0.6);
    // deltas: row.dsr (0.0) - tier.dsr (0.6) = -0.6
    assert.ok(Math.abs(cmp!.deltaDsr - (-0.6)) < 1e-9);
    assert.ok(Math.abs(cmp!.deltaComposite - (0.5 - 0.3)) < 1e-9);
  });

  test('cohort=null ⇒ every row has tierAxisCompare null', () => {
    const rawRows: RawScoreRow[] = [rawScoreRow()];
    const comparatorRows: RawTierComparatorRow[] = [
      { strategy_type: 'mean_reversion_v1', tier: 'mcap_micro', interval: '1d', composite: 0.4, dsr: 0.6, oos_is_ratio: 0.5 },
    ];
    const r = compose({ rawRows, comparatorRows, cohort: null });
    assert.equal(r.rows[0].tierAxisCompare, null);
  });

  test('comparator missing for a row ⇒ that row has tierAxisCompare null (others can still match)', () => {
    const rawRows: RawScoreRow[] = [
      rawScoreRow({ strategy_type: 'mean_reversion_v1', interval: '1d' }),
      rawScoreRow({ strategy_type: 'tsmom_vol_v1',      interval: '4h' }),
    ];
    // Only one comparator row — the other row has no tier-axis sibling.
    const comparatorRows: RawTierComparatorRow[] = [
      { strategy_type: 'mean_reversion_v1', tier: 'mcap_micro', interval: '1d', composite: 0.4, dsr: 0.6, oos_is_ratio: 0.5 },
    ];
    const r = compose({ rawRows, comparatorRows, cohort: cohortPublished });
    const matched = r.rows.find(x => x.strategyType === 'mean_reversion_v1');
    const unmatched = r.rows.find(x => x.strategyType === 'tsmom_vol_v1');
    assert.notEqual(matched!.tierAxisCompare, null);
    assert.equal(unmatched!.tierAxisCompare, null);
  });
});

// ── T-S5 — sort order: composite DESC, dsr DESC, strategy_type ASC ───────────

describe('T-S5 — sort order is composite DESC, dsr DESC, strategy_type ASC', () => {
  test('three-row fixture in a wrong order is corrected by the composer', () => {
    // Pin the contract with three rows whose ordering exercises ALL three keys:
    // - rows[0] vs rows[1]: same composite, different dsr (dsr DESC tiebreaker)
    // - rows[1] vs rows[2]: same composite + dsr, different strategy (strategy ASC tiebreaker)
    const rawRows: RawScoreRow[] = [
      rawScoreRow({ strategy_type: 'zzz_low_comp', composite: 0.1, dsr: 0.9, interval: '1d' }),
      rawScoreRow({ strategy_type: 'b_strat',      composite: 0.5, dsr: 0.3, interval: '1d' }),
      rawScoreRow({ strategy_type: 'a_strat',      composite: 0.5, dsr: 0.3, interval: '1d' }),
      rawScoreRow({ strategy_type: 'c_higher_dsr', composite: 0.5, dsr: 0.6, interval: '1d' }),
    ];
    const r = compose({ rawRows });
    // Expected order: c_higher_dsr (composite=0.5, dsr=0.6, highest dsr at composite=0.5) →
    //                 a_strat       (composite=0.5, dsr=0.3, alpha tiebreak) →
    //                 b_strat       (composite=0.5, dsr=0.3) →
    //                 zzz_low_comp  (composite=0.1)
    const order = r.rows.map(x => x.strategyType);
    assert.deepEqual(order, ['c_higher_dsr', 'a_strat', 'b_strat', 'zzz_low_comp']);
  });
});

// ── parseScoresQuery (validation) ────────────────────────────────────────────

describe('parseScoresQuery — request validation', () => {
  test('default: no params → fitId=null, limit=50', () => {
    const r = parseScoresQuery({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.fitId, null);
      assert.equal(r.limit, 50);
    }
  });

  test('limit=0 rejected', () => {
    const r = parseScoresQuery({ limit: '0' });
    assert.equal(r.ok, false);
  });

  test('limit=999 rejected', () => {
    const r = parseScoresQuery({ limit: '999' });
    assert.equal(r.ok, false);
  });

  test('limit=200 (upper edge) accepted', () => {
    const r = parseScoresQuery({ limit: '200' });
    assert.equal(r.ok, true);
  });

  test('non-UUID fitId rejected', () => {
    const r = parseScoresQuery({ fitId: 'not-a-uuid' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, 'bad_query');
  });

  test('valid v4 UUID accepted', () => {
    const r = parseScoresQuery({ fitId: '550e8400-e29b-41d4-a716-446655440000' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.fitId, '550e8400-e29b-41d4-a716-446655440000');
  });

  test('empty-string fitId treated as absent', () => {
    const r = parseScoresQuery({ fitId: '' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.fitId, null);
  });
});

// ── pbo nullability + numeric coercion ───────────────────────────────────────

describe('numeric coercion', () => {
  test('pbo=null preserved as null (not coerced to 0)', () => {
    const r = compose({ rawRows: [rawScoreRow({ pbo: null })] });
    assert.equal(r.rows[0].pbo, null);
  });

  test('pbo=0.4 coerced to 0.4', () => {
    const r = compose({ rawRows: [rawScoreRow({ pbo: 0.4 })] });
    assert.equal(r.rows[0].pbo, 0.4);
  });

  test('hlz_t_passes=1 ⇒ hlzTPasses=true; =0 ⇒ false', () => {
    const trueRow = compose({ rawRows: [rawScoreRow({ hlz_t_passes: 1 })] });
    const falseRow = compose({ rawRows: [rawScoreRow({ hlz_t_passes: 0 })] });
    assert.equal(trueRow.rows[0].hlzTPasses, true);
    assert.equal(falseRow.rows[0].hlzTPasses, false);
  });

  test('gates_pass=1 ⇒ gatesPass=true; =0 ⇒ false', () => {
    const passRow = compose({ rawRows: [rawScoreRow({ gates_pass: 1 })] });
    const failRow = compose({ rawRows: [rawScoreRow({ gates_pass: 0 })] });
    assert.equal(passRow.rows[0].gatesPass, true);
    assert.equal(failRow.rows[0].gatesPass, false);
  });
});

// ── T-S6 — buildResolveLatestFitSql regression suite ────────────────────────
//
// Two SMK-1 findings against this builder:
//
// (a) Date/String alias-shadow — the inline `today() - week_start` resolved
//     `week_start` to the same-SELECT String alias (`toString(week_start) AS
//     week_start`) rather than the underlying Date column, producing "Illegal
//     types Date and String of arguments of function minus" under CH 24.8.
//     Fix: wrap the bare reference in `toDate(week_start)`.
//
// (b) UUID byte-order tiebreak — the original ORDER BY was `week_start DESC,
//     fit_id DESC`. CH's UUID ordering operates on internal byte layout
//     (variant-aware swap), NOT textual lex order. For weeks with two
//     `single_cohort` fits, the "later" fit by computed_at could lose the
//     tiebreak to an earlier orphan-equivalent. Fix: insert `computed_at DESC`
//     as the secondary sort so recency wins; fit_id stays as deterministic
//     final tiebreaker.
describe('buildResolveLatestFitSql — SMK-1 regression suite', () => {
  test('(a) subtracts toDate(week_start) so the alias String is recast to Date', () => {
    const sql = buildResolveLatestFitSql();
    assert.match(
      sql.query,
      /today\(\)\s*-\s*toDate\(week_start\)/,
      'fit_age_days must subtract toDate(week_start), not the bare aliased String',
    );
  });

  test('(b) ORDER BY puts computed_at DESC between week_start DESC and fit_id DESC', () => {
    const sql = buildResolveLatestFitSql();
    assert.match(
      sql.query,
      /ORDER BY\s+week_start DESC\s*,\s*computed_at DESC\s*,\s*fit_id DESC/,
      'ORDER BY must rank by recency (computed_at) before falling back to fit_id — UUID byte-order is not temporal',
    );
  });
});

// ── T-S6 — ADR-015 dsr_status / k_dsr_effective wiring ──────────────────────

describe('T-S6 — ADR-015: cluster route surfaces dsr_status, k_dsr_effective, and dsrUntestableHint', () => {
  test('buildScoresSql SELECTs k_dsr_effective and dsr_status (read-path parity with strategy_scores)', () => {
    const sql = buildScoresSql({ fitId: 'fit-aaaa', limit: 50 });
    assert.match(sql.query, /\bk_dsr_effective\b/,
      'cluster scores route must select k_dsr_effective (ADR-015) — was the missing piece the critic flagged');
    assert.match(sql.query, /\bdsr_status\b/,
      'cluster scores route must select dsr_status (ADR-015)');
  });

  test('dsrUntestableHint(\'untestable_few_trials\') names the K_dsr<2 regime + cites ADR-015', () => {
    const h = dsrUntestableHint('untestable_few_trials');
    assert.notEqual(h, null);
    assert.match(h!, /K_dsr<2|few_trials/i);
    assert.match(h!, /ADR-015/);
  });

  test('dsrUntestableHint(\'untestable_zero_variance\') names the σ_trials=0 regime + cites ADR-015', () => {
    const h = dsrUntestableHint('untestable_zero_variance');
    assert.notEqual(h, null);
    assert.match(h!, /σ_trials=0|zero_variance/i);
    assert.match(h!, /ADR-015/);
  });

  test('dsrUntestableHint(\'ok\') is null — the column is single-purpose', () => {
    assert.equal(dsrUntestableHint('ok'), null);
  });

  test('compose() propagates kDsrEffective + dsrStatus + dsrUntestableHint onto rows', () => {
    const r = compose({
      rawRows: [
        rawScoreRow({ psr: 1.0, dsr: 1.0, dsr_status: 'untestable_few_trials', k_dsr_effective: 1 }),
      ],
    });
    const row = r.rows[0];
    assert.equal(row.kDsrEffective, 1);
    assert.equal(row.dsrStatus, 'untestable_few_trials');
    assert.notEqual(row.dsrUntestableHint, null);
    // The OPPOSITE-regime hint must NOT fire — DSR is high, not low. Pre-ADR-015 this
    // cell would have been (psr=1, dsr=0) and trip deflationCollapseHint with the
    // wrong narrative. Post-ADR-015 it carries the correct dsrUntestableHint instead.
    assert.equal(row.deflationCollapseHint, null,
      'DSR is no longer 0 in the K=1 regime, so the deflation-collapse hint must not fire');
  });

  test('back-compat: rows without the new columns default to dsrStatus=\'ok\' and kDsrEffective=0', () => {
    const r = compose({ rawRows: [rawScoreRow({ psr: 0.8, dsr: 0.6 })] });
    const row = r.rows[0];
    assert.equal(row.dsrStatus, 'ok');
    assert.equal(row.kDsrEffective, 0);
    assert.equal(row.dsrUntestableHint, null);
  });
});

// ── CH-24.8 FINAL/UUID workaround regression pin ─────────────────────────────
//
// Comparing a UUID column with `{p:UUID}` parameter in a WHERE clause on a
// FINAL'd table raises `Code: 386 — no supertype for String, UUID` in CH 24.8.
// Workaround applied 2026-05-05: cast the column to String and compare with
// `{p:String}`. These tests pin the workaround so a future "clean-up" doesn't
// silently revert it and resurrect the 503.

describe('FINAL/UUID workaround regression pin (CH 24.8)', () => {
  test('buildCohortSql uses toString(fit_id) = {latestFitId:String}', () => {
    const sql = buildCohortSql({ latestWeek: '2026-05-04', latestFitId: 'b6f99cea-3872-454c-839e-b0a8e63363cb' });
    assert.match(sql.query, /toString\(fit_id\)\s*=\s*\{latestFitId:String\}/);
    assert.doesNotMatch(sql.query, /fit_id\s*=\s*\{latestFitId:UUID\}/,
      'must NOT use direct UUID compare on token_cluster_membership.fit_id under FINAL');
  });

  test('buildAdmittedCountSql uses toString(fit_id) = {fitId:String}', () => {
    const sql = buildAdmittedCountSql({ latestWeek: '2026-05-04', fitId: 'b6f99cea-3872-454c-839e-b0a8e63363cb' });
    assert.match(sql.query, /toString\(fit_id\)\s*=\s*\{fitId:String\}/);
    assert.doesNotMatch(sql.query, /fit_id\s*=\s*\{fitId:UUID\}/,
      'must NOT use direct UUID compare under FINAL');
  });
});
