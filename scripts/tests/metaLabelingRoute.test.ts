/**
 * Tests for the meta-labeling research-log endpoint.
 *
 * Targets the pure-function seam:
 *   - `parseCellsQuery`  — request validation
 *   - `deriveRow`        — raw CH row → response row shape with verdict derivation
 *                          (uses persisted columns when verdict_text != '',
 *                          falls back to headline-only otherwise)
 *   - `summarize`        — pass-counts across rows
 *   - `buildCellsSql`    — SQL shape regression-pin (param-name + ordering + projection)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCellsQuery,
  isCellsQueryFailure,
  deriveRow,
  summarize,
  buildCellsSql,
  VERDICT_THRESHOLDS,
  LIMIT_DEFAULT,
  LIMIT_MIN,
  LIMIT_MAX,
  type RawCellsRow,
  type MetaLabelingRow,
} from '../../src/server/meta_labeling_dashboard.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function rawRow(over: Partial<RawCellsRow> = {}): RawCellsRow {
  return {
    cell_key: 'mean_reversion_v1|mcap_micro|1d|7',
    m1_run_sig: '9abf581c7542a6cc',
    trained_at: '2026-05-05 18:00:00.000',
    model_family: 'lightgbm',
    n_train: 196,
    n_tune: 131,
    n_oos: 132,
    auc_oos: 0.4970,
    threshold_chosen: 0.75,
    oos_kept_trades: 3,
    oos_kept_net_pct: -91.31,
    m1_oos_net_pct: 582.77,
    lift_pct: -674.07,
    n_meta_trials: 256,
    // Schema-migrated columns (post-2026-05-05). Default to "verdict not persisted"
    // so individual tests can opt-in by setting verdict_text + flags as needed.
    c1_pass: 0,
    c2_pass: 0,
    c3_pass: 0,
    c4_pass: 0,
    c5_pass: 0,
    c6_pass: 0,
    c7_pass: 0,
    trimmed_mean_native: 0,
    top1_share_pct: 0,
    t_stat_native: 0,
    hlz_bar: 0,
    verdict_text: '',
    ...over,
  };
}

function persistedRow(over: Partial<RawCellsRow> = {}): RawCellsRow {
  // A row WITH verdict persisted (verdict_text non-empty + pass flags set).
  return rawRow({
    c1_pass: 0,
    c2_pass: 0,
    c3_pass: 1,
    c4_pass: 0,
    c5_pass: 0,
    c6_pass: 1,
    c7_pass: 0,
    trimmed_mean_native: -30.4,
    top1_share_pct: -50.0,
    t_stat_native: -0.5,
    hlz_bar: 4.146,
    verdict_text: 'REJECT (no learned signal)',
    ...over,
  });
}

// ── parseCellsQuery ──────────────────────────────────────────────────────────

describe('parseCellsQuery', () => {
  test('absent limit → default', () => {
    const r = parseCellsQuery({});
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.limit, LIMIT_DEFAULT);
  });

  test('empty-string limit → default (Express coerces ?limit= to "")', () => {
    const r = parseCellsQuery({ limit: '' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.limit, LIMIT_DEFAULT);
  });

  test('valid limit echoed back', () => {
    const r = parseCellsQuery({ limit: '25' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.limit, 25);
  });

  test('limit at MIN/MAX boundary accepted', () => {
    for (const v of [LIMIT_MIN, LIMIT_MAX]) {
      const r = parseCellsQuery({ limit: String(v) });
      assert.equal(r.ok, true, `limit=${v} should be accepted`);
    }
  });

  test('limit below MIN rejected', () => {
    const r = parseCellsQuery({ limit: String(LIMIT_MIN - 1) });
    assert.equal(r.ok, false);
    if (isCellsQueryFailure(r)) {
      assert.equal(r.status, 400);
      assert.equal(r.error, 'bad_query');
    }
  });

  test('limit above MAX rejected', () => {
    const r = parseCellsQuery({ limit: String(LIMIT_MAX + 1) });
    assert.equal(r.ok, false);
    if (isCellsQueryFailure(r)) assert.equal(r.status, 400);
  });

  test('non-numeric limit rejected', () => {
    const r = parseCellsQuery({ limit: 'abc' });
    assert.equal(r.ok, false);
  });

  test('non-integer limit rejected', () => {
    const r = parseCellsQuery({ limit: '12.5' });
    assert.equal(r.ok, false);
  });
});

// ── deriveRow — fallback path (verdict NOT persisted) ────────────────────────

describe('deriveRow — verdict NOT persisted (legacy rows)', () => {
  test('verdictPersisted=false when verdict_text is empty', () => {
    const r = deriveRow(rawRow());
    assert.equal(r.verdictPersisted, false);
    assert.equal(r.verdictText, '');
  });

  test('falls back to headline-only derivation for c1/c2/c4', () => {
    const r = deriveRow(rawRow({ auc_oos: 0.6, oos_kept_trades: 150, oos_kept_net_pct: 5 }));
    assert.equal(r.c1Pass, true);
    assert.equal(r.c2Pass, true);
    assert.equal(r.c4Pass, true);
    // c3, c5, c6, c7 cannot be derived from headline → must be false.
    assert.equal(r.c3Pass, false);
    assert.equal(r.c5Pass, false);
    assert.equal(r.c6Pass, false);
    assert.equal(r.c7Pass, false);
  });

  test('C1 PASS at exactly 0.55 (boundary inclusive)', () => {
    const r = deriveRow(rawRow({ auc_oos: VERDICT_THRESHOLDS.c1AucFloor }));
    assert.equal(r.c1Pass, true);
  });

  test('C1 FAIL just below threshold', () => {
    const r = deriveRow(rawRow({ auc_oos: VERDICT_THRESHOLDS.c1AucFloor - 0.0001 }));
    assert.equal(r.c1Pass, false);
  });

  test('C2 PASS at exactly 100 (boundary inclusive)', () => {
    const r = deriveRow(rawRow({ oos_kept_trades: VERDICT_THRESHOLDS.c2OosTradesFloor }));
    assert.equal(r.c2Pass, true);
  });

  test('C4 PASS strictly positive — exactly 0 fails (breakeven not enough)', () => {
    const r = deriveRow(rawRow({ oos_kept_net_pct: 0 }));
    assert.equal(r.c4Pass, false);
    const r2 = deriveRow(rawRow({ oos_kept_net_pct: 0.0001 }));
    assert.equal(r2.c4Pass, true);
  });

  test('NaN / non-finite numeric fields default to 0', () => {
    const r = deriveRow(rawRow({ auc_oos: 'NaN', oos_kept_net_pct: 'Infinity' }));
    assert.equal(r.aucOos, 0);
    assert.equal(r.oosKeptNetPct, 0);
    assert.equal(r.c1Pass, false);
    assert.equal(r.c4Pass, false);
  });
});

// ── deriveRow — persisted path (verdict_text != '') ──────────────────────────

describe('deriveRow — verdict persisted', () => {
  test('verdictPersisted=true when verdict_text is non-empty', () => {
    const r = deriveRow(persistedRow());
    assert.equal(r.verdictPersisted, true);
    assert.equal(r.verdictText, 'REJECT (no learned signal)');
  });

  test('persisted c1..c7 take precedence over header derivation', () => {
    // headline says C1 should pass (auc 0.6 >= 0.55) BUT persisted column says fail.
    // The persisted column wins.
    const r = deriveRow(persistedRow({ auc_oos: 0.6, c1_pass: 0 }));
    assert.equal(r.c1Pass, false, 'persisted c1_pass=0 must override headline-derived pass');
  });

  test('all 7 pills are populated from persisted columns', () => {
    const r = deriveRow(persistedRow({
      c1_pass: 1, c2_pass: 1, c3_pass: 1, c4_pass: 1,
      c5_pass: 1, c6_pass: 1, c7_pass: 1,
      verdict_text: 'PROMOTE',
    }));
    assert.equal(r.c1Pass, true);
    assert.equal(r.c2Pass, true);
    assert.equal(r.c3Pass, true);
    assert.equal(r.c4Pass, true);
    assert.equal(r.c5Pass, true);
    assert.equal(r.c6Pass, true);
    assert.equal(r.c7Pass, true);
    assert.equal(r.nPass, 7);
    assert.equal(r.allPass, true);
  });

  test('nPass counts persisted pass flags', () => {
    const r = deriveRow(persistedRow());  // 2/7 pass per fixture
    assert.equal(r.nPass, 2);
    assert.equal(r.allPass, false);
  });

  test('distribution stats populated from persisted columns', () => {
    const r = deriveRow(persistedRow({
      trimmed_mean_native: -10.5,
      top1_share_pct: 75.0,
      t_stat_native: -1.2,
      hlz_bar: 4.146,
    }));
    assert.equal(r.trimmedMeanNative, -10.5);
    assert.equal(r.top1SharePct, 75.0);
    assert.equal(r.tStatNative, -1.2);
    assert.equal(r.hlzBar, 4.146);
  });

  test('numeric coercion from string-typed CH columns', () => {
    const r = deriveRow(persistedRow({
      c1_pass: '1' as unknown as number,
      c2_pass: '0' as unknown as number,
      trimmed_mean_native: '-30.4',
    }));
    assert.equal(r.c1Pass, true);
    assert.equal(r.c2Pass, false);
    assert.equal(r.trimmedMeanNative, -30.4);
  });
});

// ── summarize ────────────────────────────────────────────────────────────────

describe('summarize', () => {
  test('counts per-criterion pass-flags across rows', () => {
    const rows: MetaLabelingRow[] = [
      // Persisted, all pass
      deriveRow(persistedRow({
        c1_pass: 1, c2_pass: 1, c3_pass: 1, c4_pass: 1,
        c5_pass: 1, c6_pass: 1, c7_pass: 1,
        verdict_text: 'PROMOTE',
      })),
      // Persisted, only C3 + C6 pass (mirrors fixture)
      deriveRow(persistedRow()),
      // Legacy / unpersisted, c1 derives to pass from headline
      deriveRow(rawRow({ auc_oos: 0.7 })),
    ];
    const s = summarize(rows);
    assert.equal(s.total, 3);
    assert.equal(s.c1Pass, 2);  // 1 (PROMOTE) + 1 (legacy auc=0.7)
    assert.equal(s.c2Pass, 1);  // PROMOTE only (legacy oos_kept=3 doesn't clear 100)
    assert.equal(s.c3Pass, 2);  // PROMOTE + persistedRow default
    assert.equal(s.c4Pass, 1);
    assert.equal(s.c5Pass, 1);
    assert.equal(s.c6Pass, 2);
    assert.equal(s.c7Pass, 1);
    assert.equal(s.allPass, 1);
    assert.equal(s.verdictPersistedCount, 2);
  });

  test('empty input → all zeros', () => {
    const s = summarize([]);
    assert.equal(s.total, 0);
    assert.equal(s.c1Pass, 0);
    assert.equal(s.c2Pass, 0);
    assert.equal(s.c3Pass, 0);
    assert.equal(s.c4Pass, 0);
    assert.equal(s.c5Pass, 0);
    assert.equal(s.c6Pass, 0);
    assert.equal(s.c7Pass, 0);
    assert.equal(s.allPass, 0);
    assert.equal(s.verdictPersistedCount, 0);
  });
});

// ── buildCellsSql ────────────────────────────────────────────────────────────

describe('buildCellsSql', () => {
  test('SQL is parameter-bound (no string interpolation of `limit`)', () => {
    const sql = buildCellsSql({ limit: 99 });
    assert.equal(sql.query.includes('99'), false, 'limit value must not be interpolated');
    assert.equal(sql.query.includes('{limit:UInt32}'), true, 'limit must be parameter-bound');
    assert.deepEqual(sql.query_params, { limit: 99 });
  });

  test('SQL filters out n_train=0 rows (defensive)', () => {
    const sql = buildCellsSql({ limit: 50 });
    assert.match(sql.query, /WHERE\s+n_train\s*>\s*0/);
  });

  test('SQL orders by trained_at DESC for "newest first" front-end read', () => {
    const sql = buildCellsSql({ limit: 50 });
    assert.match(sql.query, /ORDER\s+BY\s+trained_at\s+DESC/);
  });

  test('SQL applies FINAL on meta_models (ReplacingMergeTree dedup)', () => {
    const sql = buildCellsSql({ limit: 50 });
    assert.match(sql.query, /FROM\s+quantlab\.meta_models\s+FINAL/);
  });

  test('SQL projects all 12 schema-migrated verdict columns', () => {
    const sql = buildCellsSql({ limit: 50 });
    assert.match(sql.query, /c1_pass/);
    assert.match(sql.query, /c2_pass/);
    assert.match(sql.query, /c3_pass/);
    assert.match(sql.query, /c4_pass/);
    assert.match(sql.query, /c5_pass/);
    assert.match(sql.query, /c6_pass/);
    assert.match(sql.query, /c7_pass/);
    assert.match(sql.query, /trimmed_mean_native/);
    assert.match(sql.query, /top1_share_pct/);
    assert.match(sql.query, /t_stat_native/);
    assert.match(sql.query, /hlz_bar/);
    assert.match(sql.query, /verdict_text/);
  });
});
