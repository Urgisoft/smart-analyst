/**
 * VIX_TERM_COMPLACENCY_FLOOR calibration diagnostic — session 40, follow-up
 * to the phase1_v3 ramp PR.
 *
 * Symptom (per HANDOFF.md session 39 turn 4): the current
 * `VIX_TERM_COMPLACENCY_FLOOR = 0.85` over-fires `sentiment_extreme`. CBOE
 * is empty, so the OR collapses to the VIX/VIX3M complacency arm alone:
 * about 25.8% of all phase1_v3 days fire sentiment_extreme, far above the
 * ~5% target "extreme tail" prevalence implied by Whaley 2009 §3
 * contrarian-fear / contrarian-complacency framing.
 *
 * What this script does — read-only:
 *   1. Pulls every phase1_v3 row out of `quantlab.macro_regimes` along with
 *      the per-category fire flags + vix_term_ratio.
 *   2. For each candidate floor in CANDIDATES, simulates a re-classification
 *      WITHOUT touching CH:
 *        - sentiment_extreme_sim = put_call_arm OR (vix_term_ratio <= floor)
 *          (put_call_arm is currently always false because CBOE table empty)
 *        - categories_firing_sim = sum of all 7 category flags (with new
 *          sentiment_extreme_sim replacing the stored value)
 *        - categories_firing_5d_sim = trailing-5d union over the simulated
 *          sentiment_extreme + the stored values of the other 6 categories
 *        - regime_sim = the v3 thresholding (red if 5d≥4, orange if today≥2,
 *          yellow if today==1, else green)
 *   3. Reports the regime distribution + the four ADR-037 fixture-window
 *      red counts (2008 GFC, 2011 EU debt, 2014 calm, 2020 COVID) at each
 *      candidate floor.
 *
 * Why simulating beats re-running the backfill 8 times:
 *   The other six categories (vix_term_inverted, hyg_spy_divergence,
 *   yield_curve_inverted, credit_stress, risk_off_rotation, realized_stress)
 *   are INDEPENDENT of VIX_TERM_COMPLACENCY_FLOOR — they read different
 *   indicators. Only sentiment_extreme is sensitive to this constant. So
 *   we only need to recompute sentiment_extreme + cascade the 5d-union
 *   semantics — every other firing flag is fixed.
 *
 * Run: `npx tsx scripts/_diagnose_vix_term_complacency_floor.ts`
 */
import { getClickHouse } from '../src/server/clickhouse.js';

interface PhaseV3Row {
  trade_date: string;
  vix_term_ratio: number | null;
  put_call_value_5d_ma: number | null;
  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;
  realized_stress: 0 | 1;
  yield_curve_inverted: 0 | 1;
  credit_stress: 0 | 1;
  risk_off_rotation: 0 | 1;
  sentiment_extreme: 0 | 1; // stored — comparison reference only
  regime: 'green' | 'yellow' | 'orange' | 'red'; // stored
}

const CANDIDATES = [0.85, 0.83, 0.82, 0.80, 0.78, 0.75, 0.73, 0.72, 0.70, 0.68, 0.65];

// Whaley 2009 §3 thresholds (kept from v3).
const PUT_CALL_FEAR_HIGH = 1.15;
const PUT_CALL_COMPLACENCY_LOW = 0.65;

// Engine constants — same as src/server/macro_regime.ts.
const ROLLING_UNION_DAYS = 5;
const ORANGE_THRESHOLD_TODAY = 2;

const FIXTURE_WINDOWS = [
  { name: '2008_gfc', start: '2008-08-01', end: '2009-03-31', floor: 5 },
  { name: '2011_eu_debt', start: '2011-07-01', end: '2011-10-31', floor: 1 },
  { name: '2014_calm', start: '2014-01-01', end: '2014-12-31', ceil: 10 },
  { name: '2020_covid', start: '2020-02-01', end: '2020-04-30', floor: 1 },
];

function simSentimentExtreme(
  put_call_5d_ma: number | null,
  vix_term_ratio: number | null,
  floor: number,
): 0 | 1 {
  const put_call_fires =
    put_call_5d_ma !== null &&
    (put_call_5d_ma >= PUT_CALL_FEAR_HIGH || put_call_5d_ma <= PUT_CALL_COMPLACENCY_LOW);
  const vix_fires = vix_term_ratio !== null && vix_term_ratio <= floor;
  return put_call_fires || vix_fires ? 1 : 0;
}

interface SimResult {
  floor: number;
  total: number;
  green: number;
  yellow: number;
  orange: number;
  red: number;
  sentiment_extreme_fires: number;
  sentiment_extreme_pct: number;
  fixture_reds: Record<string, number>;
}

function simulate(rows: PhaseV3Row[], floor: number): SimResult {
  const sentSim = rows.map((r) =>
    simSentimentExtreme(r.put_call_value_5d_ma, r.vix_term_ratio, floor),
  );

  let green = 0,
    yellow = 0,
    orange = 0,
    red = 0;
  let sentFires = 0;

  // For categories_firing_5d we need a rolling window. We have rows sorted
  // ASC by trade_date.
  const fixtureReds: Record<string, number> = {};
  for (const f of FIXTURE_WINDOWS) fixtureReds[f.name] = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sent_today = sentSim[i];
    if (sent_today) sentFires++;

    const cats_today =
      r.vix_term_inverted +
      r.hyg_spy_divergence +
      r.realized_stress +
      r.yield_curve_inverted +
      r.credit_stress +
      r.risk_off_rotation +
      sent_today;

    // 5d rolling union over the seven categories. For sentiment_extreme,
    // use the simulated values; for the others, use stored.
    let u_vix = 0,
      u_credit_v2 = 0,
      u_stress = 0,
      u_yc = 0,
      u_credit_v3 = 0,
      u_rotation = 0,
      u_sentiment = 0;
    const startIdx = Math.max(0, i - (ROLLING_UNION_DAYS - 1));
    for (let j = startIdx; j <= i; j++) {
      const rj = rows[j];
      if (rj.vix_term_inverted) u_vix = 1;
      if (rj.hyg_spy_divergence) u_credit_v2 = 1;
      if (rj.realized_stress) u_stress = 1;
      if (rj.yield_curve_inverted) u_yc = 1;
      if (rj.credit_stress) u_credit_v3 = 1;
      if (rj.risk_off_rotation) u_rotation = 1;
      if (sentSim[j]) u_sentiment = 1;
    }
    const cats5d =
      u_vix + u_credit_v2 + u_stress + u_yc + u_credit_v3 + u_rotation + u_sentiment;

    let regime: 'green' | 'yellow' | 'orange' | 'red';
    if (cats5d >= 4) regime = 'red';
    else if (cats_today >= ORANGE_THRESHOLD_TODAY) regime = 'orange';
    else if (cats_today === 1) regime = 'yellow';
    else regime = 'green';

    if (regime === 'green') green++;
    else if (regime === 'yellow') yellow++;
    else if (regime === 'orange') orange++;
    else red++;

    for (const f of FIXTURE_WINDOWS) {
      if (r.trade_date >= f.start && r.trade_date <= f.end && regime === 'red') {
        fixtureReds[f.name]++;
      }
    }
  }

  return {
    floor,
    total: rows.length,
    green,
    yellow,
    orange,
    red,
    sentiment_extreme_fires: sentFires,
    sentiment_extreme_pct: (sentFires / rows.length) * 100,
    fixture_reds: fixtureReds,
  };
}

async function main(): Promise<void> {
  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT
        toString(trade_date) AS trade_date,
        vix_term_ratio,
        put_call_value_5d_ma,
        vix_term_inverted,
        hyg_spy_divergence,
        realized_stress,
        yield_curve_inverted,
        credit_stress,
        risk_off_rotation,
        sentiment_extreme,
        regime
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
      ORDER BY trade_date ASC
    `,
    format: 'JSONEachRow',
  });
  const rows = await result.json<{
    trade_date: string;
    vix_term_ratio: number | string | null;
    put_call_value_5d_ma: number | string | null;
    vix_term_inverted: number;
    hyg_spy_divergence: number;
    realized_stress: number;
    yield_curve_inverted: number;
    credit_stress: number;
    risk_off_rotation: number;
    sentiment_extreme: number;
    regime: string;
  }>();

  console.log(`Loaded ${rows.length} phase1_v3 rows.`);

  const typed: PhaseV3Row[] = rows.map((r) => {
    const v = r.vix_term_ratio == null ? null : Number(r.vix_term_ratio);
    const p = r.put_call_value_5d_ma == null ? null : Number(r.put_call_value_5d_ma);
    return {
      trade_date: r.trade_date,
      vix_term_ratio: v != null && Number.isFinite(v) ? v : null,
      put_call_value_5d_ma: p != null && Number.isFinite(p) ? p : null,
      vix_term_inverted: (Number(r.vix_term_inverted) ? 1 : 0) as 0 | 1,
      hyg_spy_divergence: (Number(r.hyg_spy_divergence) ? 1 : 0) as 0 | 1,
      realized_stress: (Number(r.realized_stress) ? 1 : 0) as 0 | 1,
      yield_curve_inverted: (Number(r.yield_curve_inverted) ? 1 : 0) as 0 | 1,
      credit_stress: (Number(r.credit_stress) ? 1 : 0) as 0 | 1,
      risk_off_rotation: (Number(r.risk_off_rotation) ? 1 : 0) as 0 | 1,
      sentiment_extreme: (Number(r.sentiment_extreme) ? 1 : 0) as 0 | 1,
      regime: r.regime as PhaseV3Row['regime'],
    };
  });

  // ── 1. Histogram of vix_term_ratio ────────────────────────────────────
  const ratios = typed
    .map((r) => r.vix_term_ratio)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const nullCount = typed.length - ratios.length;
  console.log(
    `\nvix_term_ratio: ${ratios.length} non-null, ${nullCount} null (VIX or VIX3M missing).`,
  );
  if (ratios.length > 0) {
    const pct = (p: number) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];
    console.log('  Percentiles (lower = more complacent):');
    console.log(`    p01: ${pct(0.01).toFixed(4)}`);
    console.log(`    p05: ${pct(0.05).toFixed(4)}    <- target sentiment_extreme prevalence`);
    console.log(`    p10: ${pct(0.10).toFixed(4)}`);
    console.log(`    p25: ${pct(0.25).toFixed(4)}`);
    console.log(`    p50: ${pct(0.50).toFixed(4)}`);
    console.log(`    p75: ${pct(0.75).toFixed(4)}`);
    console.log(`    p95: ${pct(0.95).toFixed(4)}`);
    console.log(`    max: ${ratios[ratios.length - 1].toFixed(4)}`);
  }

  // ── 2. Verify stored baseline matches the (current) 0.85 simulation ──
  const baseline = simulate(typed, 0.85);
  const storedReds = typed.filter((r) => r.regime === 'red').length;
  const storedGreens = typed.filter((r) => r.regime === 'green').length;
  const storedYellows = typed.filter((r) => r.regime === 'yellow').length;
  const storedOranges = typed.filter((r) => r.regime === 'orange').length;
  console.log(
    `\nSanity: stored regime distribution (r/o/y/g) = ${storedReds}/${storedOranges}/${storedYellows}/${storedGreens}`,
  );
  console.log(
    `        sim-at-0.85 distribution        (r/o/y/g) = ${baseline.red}/${baseline.orange}/${baseline.yellow}/${baseline.green}`,
  );
  const drift =
    Math.abs(baseline.red - storedReds) +
    Math.abs(baseline.orange - storedOranges) +
    Math.abs(baseline.yellow - storedYellows) +
    Math.abs(baseline.green - storedGreens);
  console.log(
    `        Δ total = ${drift} ${drift === 0 ? '✓ simulation matches stored' : '✗ simulation drift — bug or input mismatch'}`,
  );

  // ── 3. Sweep candidate floors ─────────────────────────────────────────
  console.log('\nCalibration sweep:');
  console.log(
    'floor   total  green  yellow  orange  red    sent_e%  2008_gfc  2011_eu  2014_calm  2020_covid',
  );
  console.log(
    '-----   -----  -----  ------  ------  ---    -------  --------  -------  ---------  ----------',
  );
  for (const floor of CANDIDATES) {
    const s = simulate(typed, floor);
    const fr = s.fixture_reds;
    console.log(
      `${floor.toFixed(2)}    ${s.total}   ${s.green.toString().padStart(4)}   ${s.yellow
        .toString()
        .padStart(4)}    ${s.orange.toString().padStart(4)}    ${s.red.toString().padStart(3)}   ${s.sentiment_extreme_pct
        .toFixed(2)
        .padStart(6)}%   ${fr['2008_gfc'].toString().padStart(6)}    ${fr['2011_eu_debt']
        .toString()
        .padStart(5)}    ${fr['2014_calm'].toString().padStart(7)}    ${fr['2020_covid']
        .toString()
        .padStart(8)}`,
    );
  }

  // ── 4. Fixture-floor crosswalk ────────────────────────────────────────
  console.log(
    '\nFixture floors (red >= floor for crisis windows; red <= ceil for 2014 calm):',
  );
  for (const f of FIXTURE_WINDOWS) {
    const tag = f.floor != null ? `>=${f.floor}` : `<=${f.ceil}`;
    console.log(`  ${f.name}: ${tag}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/*
 * What could break this:
 *  - If a future PR introduces a category whose firing depends on the
 *    VIX_TERM_COMPLACENCY_FLOOR (none today — by design sentiment_extreme
 *    is the only consumer), the "independent of floor" assumption above
 *    breaks and the simulation drifts from the stored regime.
 *  - The sanity check at step 2 catches that automatically: if drift > 0
 *    against the 0.85 baseline (the current live constant), do not trust
 *    the sweep.
 *  - put_call_value_5d_ma being 100% null is a precondition for the
 *    closed-form simulation. The moment CBOE ingest lights up, the
 *    `put_call_fires` arm starts contributing — at that point this script
 *    still simulates correctly (it reads put_call from CH and runs the
 *    OR) but the answer changes; re-run before deciding on a new floor.
 */
