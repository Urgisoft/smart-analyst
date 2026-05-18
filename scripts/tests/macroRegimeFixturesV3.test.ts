/**
 * Phase1_v3 historical regime fixtures — ADR-037 follow-up
 * (handoff session 39 turn 2).
 *
 * UNLIKE [macroRegimeFixtures.test.ts](./macroRegimeFixtures.test.ts) which
 * re-runs the v2 classifier on in-memory CSV bundles, this suite reads the
 * persisted phase1_v3 backfill output directly:
 *
 *     SELECT … FROM quantlab.macro_regimes FINAL
 *     WHERE classifier_version = 'phase1_v3'
 *       AND trade_date BETWEEN <window-start> AND <window-end>
 *
 * Rationale: v3 ingests 6+ additional indicators (T10Y2Y, ICE BofA HY OAS,
 * sector ETFs XLK/XLY/XLP/XLU, EFA/EEM/IWM/IEF, VIX3M, CBOE put/call) that
 * are unmanageable to fixture-CSV in the same VIX/HYG/SPY/breadth shape the
 * v2 test uses. The 4,617-row v3 backfill is an on-disk artifact from
 * `npm run macro:backfill:v3`; this test pins its red-day distribution
 * against the 4 ADR-037 windows so a future v3-tuning PR can detect
 * regressions.
 *
 * Skip behaviour mirrors the v2 fixture test's defensive posture:
 *  - If ClickHouse is unreachable, every sub-test skips with a clear note.
 *  - If a window has zero phase1_v3 rows (backfill never ran), that
 *    sub-test skips with the npm-script to fix it.
 *  Both are documented bootstrap states, not failures.
 *
 * The v2 fixture test is intentionally NOT mutated. Its 4 documented
 * failures still pin v2 behavior until the ramp PR flips
 * `CLASSIFIER_VERSION` to 'phase1_v3'.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { getClickHouse, pingClickHouse } from '../../src/server/clickhouse.js';

type Regime = 'green' | 'yellow' | 'orange' | 'red';

interface RegimeRow {
  trade_date: string;
  regime: Regime;
}

async function queryRegimeRows(
  windowStart: string,
  windowEnd: string,
): Promise<RegimeRow[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT trade_date, regime
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
        AND trade_date BETWEEN {windowStart:String} AND {windowEnd:String}
      ORDER BY trade_date
    `,
    query_params: { windowStart, windowEnd },
    format: 'JSONEachRow',
  });
  return await r.json<RegimeRow>();
}

interface FixtureSpec {
  name: string;
  windowStart: string;
  windowEnd: string;
  /** Returns null on pass, error message on fail. */
  expect: (rows: RegimeRow[]) => string | null;
}

const FIXTURES: FixtureSpec[] = [
  {
    // 2008 GFC — the headline ADR-037 failure under v2 (0 reds).
    // v3 fires 34 red days post-session-45 backfill (CBOE 2003-2019
    // activation added sentiment_extreme firings; pre-session-45 number
    // was 18). Both Lehman cluster (Sep-Dec 2008) and the early-2009
    // continuation are captured. Lower bound 5 keeps comfortable headroom.
    name: '2008_gfc',
    windowStart: '2008-08-01',
    windowEnd: '2009-03-31',
    expect: (rows) => {
      const reds = rows.filter((r) => r.regime === 'red').length;
      return reds >= 5
        ? null
        : `expected >=5 red days during 2008 GFC under phase1_v3, got ${reds}`;
    },
  },
  {
    // 2011 EU debt crisis — v3 fires 32 red days in this window
    // post-session-45 (CBOE 2003-2019 activation; pre-rerun was 2).
    // August 2011 was the canonical month (S&P US downgrade, EU sovereign
    // debt panic). Lower bound 1 keeps the test stable across future
    // calibration; the absolute count is documented here for forensic
    // value but not asserted.
    name: '2011_eu_debt',
    windowStart: '2011-07-01',
    windowEnd: '2011-10-31',
    expect: (rows) => {
      const reds = rows.filter((r) => r.regime === 'red').length;
      return reds >= 1
        ? null
        : `expected >=1 red day during 2011 EU debt crisis under phase1_v3, got ${reds}`;
    },
  },
  {
    // 2020 COVID crash — v3 fires 4 red days. Lower bound 1 today;
    // handoff queues a tighten to >=5 once Phase 2 `realized_stress`
    // wires in and adds its own firings to this window.
    name: '2020_covid',
    windowStart: '2020-02-01',
    windowEnd: '2020-04-30',
    expect: (rows) => {
      const reds = rows.filter((r) => r.regime === 'red').length;
      return reds >= 1
        ? null
        : `expected >=1 red day during 2020 COVID crash under phase1_v3, got ${reds}`;
    },
  },
  {
    // 2014 "calm" full year. Under VIX_TERM_COMPLACENCY_FLOOR=0.80 and
    // the session-45 CBOE-2003-2019 activation, v3 now fires 11 red
    // days clustered in two legitimate macro stress episodes:
    //   - 2014-10-15 → 2014-10-22 (6 days): the Ebola/Bullard-dovish-pivot
    //     VIX spike. categories firing: vix_term_inverted +
    //     credit_stress + risk_off_rotation + sentiment_extreme (CBOE
    //     put/call now visible in this window thanks to session-44
    //     CBOE ingest).
    //   - 2014-12-16 → 2014-12-22 (5 days): the oil crash ($77 → $55
    //     WTI) + Russian-ruble collapse risk-off episode driven by
    //     credit_stress + vix_term_inverted + hyg_spy_divergence (this
    //     cluster existed at session-40 backfill time too).
    // Pre-session-45 the October cluster was structurally invisible —
    // the CBOE-arm of sentiment_extreme had no data for 2014, so the
    // 5d-≥4 union couldn't form. Activating CBOE 2003-2019 revealed
    // these as real stress days that v3 should fire on. Loosened cap
    // from <=10 → <=15 gives 4-day headroom for future calibration.
    // Green-floor 50% catches the "classifier flipped to chronic stress"
    // regression (full-year green share is now ~70%, well above 50%).
    name: '2014_calm',
    windowStart: '2014-01-01',
    windowEnd: '2014-12-31',
    expect: (rows) => {
      const reds = rows.filter((r) => r.regime === 'red').length;
      const greens = rows.filter((r) => r.regime === 'green').length;
      if (reds > 15) {
        return `2014 calm fixture must have <=15 red days under phase1_v3, got ${reds}`;
      }
      if (greens / rows.length < 0.5) {
        return `2014 should be majority green under phase1_v3, got ${((greens / rows.length) * 100).toFixed(1)}%`;
      }
      return null;
    },
  },
];

let chAvailable = false;

describe('macro regime — phase1_v3 historical fixtures (handoff session 39 turn 2)', () => {
  before(async () => {
    chAvailable = await pingClickHouse();
  });

  for (const f of FIXTURES) {
    it(`${f.name} (${f.windowStart} → ${f.windowEnd})`, async (t) => {
      if (!chAvailable) {
        t.skip(
          'ClickHouse unreachable — phase1_v3 fixture tests require the on-disk macro_regimes backfill',
        );
        return;
      }
      const rows = await queryRegimeRows(f.windowStart, f.windowEnd);
      if (rows.length === 0) {
        t.skip(
          `no phase1_v3 rows in [${f.windowStart}, ${f.windowEnd}] — run \`npm run macro:backfill:v3\``,
        );
        return;
      }
      const err = f.expect(rows);
      assert.equal(err, null, err ?? '');
    });
  }
});

/*
 * What could break this
 * ---------------------
 * - `npm run macro:backfill:v3` has not been run (or was run before the
 *   v3 ALTER added `yield_curve_inverted`, `credit_stress`, etc.). The
 *   row-count guard catches the no-data case; the silent-dropped-columns
 *   case (HANDOFF watch-out: `input_format_skip_unknown_fields=1`) still
 *   passes this test because we only assert on `regime`, which is the
 *   pre-v3 column. If the per-category columns are silently zero, this
 *   test cannot detect it — a separate schema-coverage test should.
 * - Re-tuning of `VIX_TERM_COMPLACENCY_FLOOR` (currently 0.80 — recalibrated
 *   from 0.85 in session 40 to land sentiment_extreme at 5.98% prevalence,
 *   matching the Whaley 2009 §3 extreme-tail target). The 0.85→0.80 ramp
 *   verified every fixture floor here (2008 GFC 18 reds, 2011 EU 2 reds,
 *   2020 COVID 4 reds, 2014 calm 6→5 reds). Further tuning below 0.78
 *   makes the VIX/VIX3M arm of sentiment_extreme effectively dormant
 *   (<2.3% prevalence at 0.78, <0.3% at 0.75); re-run this suite + the
 *   ADR_038_BASELINE pin after any tuning PR.
 * - ClickHouse running but the `macro_regimes` table dropped/renamed —
 *   surfaces as a query error, not a skip. That's intentional: a missing
 *   table is a real failure, not a bootstrap state.
 */
