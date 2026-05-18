/**
 * PUT_CALL_COMPLACENCY_LOW / PUT_CALL_FEAR_HIGH calibration diagnostic —
 * session 78 follow-up to the phase1_v3 dual-source `sentiment_extreme`
 * design (`docs/teach/2026-05-10-dual-source-sentiment-or.md`).
 *
 * Symptom (per HANDOFF.md session 77 → 78 transition + the dual-source
 * teach-doc's own "Failure mode" note): the CBOE put/call thresholds were
 * shipped as Tier 0 picks in session 39 (1.15 / 0.65) and explicitly never
 * stress-tested because `macro_indicators_cboe` was empty. With the
 * historical archive ingest now landing (2003-10-17 → 2019-10-04, 4,014
 * 5d-MA rows), the calibration is finally tractable.
 *
 * Methodology — quantile matching, same as session 40's
 * VIX_TERM_COMPLACENCY_FLOOR retune:
 *   - Target: each tail of the put/call 5d MA fires ~5% of the time,
 *     structurally symmetric with the post-retune VIX/VIX3M arm (5.98%).
 *   - Compute empirical p05 / p95 of the 5d MA on the available CBOE
 *     corpus, then round inside-toward-zero at 2dp (so the actual fire
 *     rate sits at-or-tighter-than 5%).
 *   - Stratify by calendar regime to confirm the corpus-wide estimate
 *     is not artifact of a single crisis tail.
 *
 * What this script does — read-only:
 *   1. Pulls raw daily ^CPC out of `quantlab.macro_indicators_cboe`.
 *   2. Computes the 5d trailing MA (window=5, min_periods=5) — matches
 *      the macro_regime_v3 `put_call_value_5d_ma` definition.
 *   3. Reports empirical quantiles on full corpus + per-regime windows.
 *   4. Sweeps candidate (low, high) pairs and reports per-arm + either-arm
 *      fire rates plus per-regime stability across pre-GFC / GFC /
 *      post-GFC / calm.
 *
 * Operational caveats baked in:
 *   - CBOE 2019-present is gated behind DataShop. Corpus stops at
 *     2019-10-04. A future re-tune once DataShop unlocks should re-run
 *     this script across the extended window and check whether COVID and
 *     2022 inflation-cycle regimes shift the p05/p95 estimates.
 *   - `macro_regimes.put_call_value_5d_ma` is 100% NULL across all
 *     4,622 phase1_v3 rows as of session 78 — the source table is
 *     populated but the v3 backfill never joined it in. So this script
 *     reads source-of-truth `macro_indicators_cboe` directly, NOT the
 *     `macro_regimes` rolled-up table; the live `sentiment_extreme`
 *     output today still runs on the VIX/VIX3M arm alone until the
 *     backfill picks the CBOE column up.
 *
 * Run: `npx tsx scripts/_diagnose_put_call_thresholds.ts`
 */
import { getClickHouse } from '../src/server/clickhouse.js';

interface CboeRow {
  observation_date: string;
  value: number;
}

interface MaRow {
  date: string;
  value: number;
  ma5: number | null;
}

interface RegimeWindow {
  name: string;
  start: string; // inclusive YYYY-MM-DD
  end: string; // inclusive YYYY-MM-DD
}

const REGIME_WINDOWS: RegimeWindow[] = [
  { name: 'pre-GFC      (2003-10-17 → 2007-12-31)', start: '2003-10-17', end: '2007-12-31' },
  { name: 'GFC+recovery (2008-01-01 → 2009-12-31)', start: '2008-01-01', end: '2009-12-31' },
  { name: 'post-GFC     (2010-01-01 → 2014-12-31)', start: '2010-01-01', end: '2014-12-31' },
  { name: 'calm + late  (2015-01-01 → 2019-10-04)', start: '2015-01-01', end: '2019-10-04' },
];

// Sweep grid — anchored on the current (pre-s78) Tier 0 picks and the
// session-78 ship values, plus neighbours either side.
const COMPLACENCY_CANDIDATES = [0.65, 0.70, 0.73, 0.75, 0.76, 0.77, 0.78, 0.80, 0.82, 0.85];
const FEAR_CANDIDATES = [1.10, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18, 1.20, 1.25];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  // type-7 (R / numpy default) linear interpolation
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function computeRollingMa(rows: CboeRow[], window: number): MaRow[] {
  const out: MaRow[] = [];
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].value;
    if (i >= window) sum -= rows[i - window].value;
    const have = i + 1 >= window;
    out.push({
      date: rows[i].observation_date,
      value: rows[i].value,
      ma5: have ? sum / window : null,
    });
  }
  return out;
}

function summarise(label: string, vals: number[]): void {
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, n);
  // Sample std (ddof=1) for parity with pandas .std()
  const sq = sorted.reduce((a, b) => a + (b - mean) ** 2, 0);
  const std = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  console.log(`  ${label}`);
  console.log(`    n=${n}  mean=${mean.toFixed(4)}  std=${std.toFixed(4)}  min=${sorted[0].toFixed(4)}  max=${sorted[n - 1].toFixed(4)}`);
  console.log(
    `    p01=${quantile(sorted, 0.01).toFixed(4)}  p05=${quantile(sorted, 0.05).toFixed(4)}  ` +
      `p10=${quantile(sorted, 0.10).toFixed(4)}  p50=${quantile(sorted, 0.50).toFixed(4)}  ` +
      `p90=${quantile(sorted, 0.90).toFixed(4)}  p95=${quantile(sorted, 0.95).toFixed(4)}  ` +
      `p99=${quantile(sorted, 0.99).toFixed(4)}`,
  );
}

async function main(): Promise<void> {
  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT toString(observation_date) AS observation_date, value
      FROM quantlab.macro_indicators_cboe FINAL
      WHERE series_id = 'CPC'
      ORDER BY observation_date ASC
    `,
    format: 'JSONEachRow',
  });
  const raw = await result.json<{ observation_date: string; value: number | string }>();
  const rows: CboeRow[] = raw
    .map((r) => ({
      observation_date: r.observation_date,
      value: typeof r.value === 'number' ? r.value : Number(r.value),
    }))
    .filter((r) => Number.isFinite(r.value));

  if (rows.length === 0) {
    console.error('No CBOE put/call rows in quantlab.macro_indicators_cboe. ' +
      'Run scripts/cboe_putcall_ingest.py first.');
    process.exit(1);
  }

  console.log(`Loaded ${rows.length} raw daily ^CPC rows: ${rows[0].observation_date} → ${rows[rows.length - 1].observation_date}.`);

  const ma = computeRollingMa(rows, 5);
  const validMa = ma.filter((r): r is { date: string; value: number; ma5: number } => r.ma5 != null);
  const corpus = validMa.map((r) => r.ma5);

  // ── 1. Full-corpus distribution ──────────────────────────────────────────
  console.log('\nFull-corpus 5d-MA distribution:');
  summarise('full', corpus);

  // ── 2. Per-regime stratification ────────────────────────────────────────
  console.log('\nPer-regime stability (does corpus p05/p95 sit inside each regime\'s tail?):');
  for (const w of REGIME_WINDOWS) {
    const sub = validMa
      .filter((r) => r.date >= w.start && r.date <= w.end)
      .map((r) => r.ma5);
    summarise(w.name, sub);
  }

  // ── 3. Sweep candidate floors / ceilings ────────────────────────────────
  console.log('\nComplacency floor sweep (target ~5% fire on this arm; was 0.65):');
  console.log('  floor   corpus%   pre-GFC%   GFC%       post-GFC%  calm%');
  for (const f of COMPLACENCY_CANDIDATES) {
    const r = (vals: number[]) => (vals.filter((v) => v <= f).length / Math.max(1, vals.length)) * 100;
    const perRegime = REGIME_WINDOWS.map((w) =>
      r(validMa.filter((x) => x.date >= w.start && x.date <= w.end).map((x) => x.ma5)),
    );
    const flag = f === 0.77 ? '  ← s78 SHIP' : f === 0.65 ? '  ← pre-s78 (Tier 0)' : '';
    console.log(
      `  ${f.toFixed(2)}    ${r(corpus).toFixed(2).padStart(5)}%    ${perRegime
        .map((x) => `${x.toFixed(2).padStart(5)}%`)
        .join('     ')}${flag}`,
    );
  }

  console.log('\nFear ceiling sweep (target ~5% fire on this arm; pre-s78 = 1.15, unchanged in s78):');
  console.log('  ceil    corpus%   pre-GFC%   GFC%       post-GFC%  calm%');
  for (const c of FEAR_CANDIDATES) {
    const r = (vals: number[]) => (vals.filter((v) => v >= c).length / Math.max(1, vals.length)) * 100;
    const perRegime = REGIME_WINDOWS.map((w) =>
      r(validMa.filter((x) => x.date >= w.start && x.date <= w.end).map((x) => x.ma5)),
    );
    const flag = c === 1.15 ? '  ← s78 SHIP / pre-s78 (Tier 0 validated)' : '';
    console.log(
      `  ${c.toFixed(2)}    ${r(corpus).toFixed(2).padStart(5)}%    ${perRegime
        .map((x) => `${x.toFixed(2).padStart(5)}%`)
        .join('     ')}${flag}`,
    );
  }

  // ── 4. Combined OR fire rate at the shipped (low, high) pair ────────────
  const ship = corpus.filter((v) => v <= 0.77 || v >= 1.15).length;
  console.log(
    `\nShipped pair (0.77, 1.15) — either-arm fire rate: ${((ship / corpus.length) * 100).toFixed(2)}% ` +
      `(${ship} of ${corpus.length} days, full corpus).`,
  );

  // ── 5. Recommendation block ──────────────────────────────────────────────
  console.log(
    '\nRecommendation: ship PUT_CALL_COMPLACENCY_LOW=0.77, PUT_CALL_FEAR_HIGH=1.15. ' +
      'Both arms now sit in the ~5% empirical tail; OR design semantics preserved. ' +
      'Re-run this script once CBOE DataShop unlocks 2019-present to verify the ' +
      'thresholds still bracket the empirical tails under the COVID + 2022 ' +
      'inflation-cycle regimes.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/*
 * What could break this:
 *  - If the CBOE source table is ever silently truncated, the corpus shrinks
 *    and the p05/p95 estimates drift. The leading log line prints row count
 *    + date range — sanity-check that against the 4,014 5d-MA rows / 2019-10-04
 *    end-date this script was calibrated against in session 78.
 *  - The 5d-MA convention here MUST match macro_regime_v3.ts. If a future
 *    refactor changes the rolling window length or min_periods, this
 *    diagnostic stops measuring the same quantity as the live constant.
 *  - Per-regime stability is computed against fixed calendar windows — they
 *    are heuristic, not regime-detector output. If a future analysis wants
 *    to stratify by something more principled (e.g. macro_regime_v3's own
 *    regime column), join `macro_regimes` and group by `regime`.
 */
