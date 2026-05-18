/**
 * Phase 2 RV_5d lead-lag pre-registration diagnostic.
 *
 * Critic-mandated pre-condition gate (HANDOFF session 32). The new
 * realized-stress family `realized_stress = 1 iff RV_5d_annualized > θ`
 * has a reason to exist ONLY if RV_5d crosses θ AHEAD of (or at minimum
 * the same session as) `vix_term_inverted` firing in fast-crash events.
 * Otherwise it is a near-duplicate of the volatility category Phase 1
 * already covers, and would be a wasted HLZ family budget.
 *
 * Methodology:
 *   K = {0.20, 0.25, 0.30, 0.35, 0.40} (locked before scoring).
 *   RV_5d_annualized = sqrt(252) * sample_stdev(SPY_log_return, last 5
 *     sessions) — Andersen-Bollerslev-Diebold-Labys (2003) Econometrica.
 *   For each crisis event window:
 *     - First session where RV_5d > θ (per θ in K).
 *     - First session where vix_term_inverted = 1.
 *     - lead = (vix_term_first_idx − rv_first_idx) in trading sessions.
 *     - Positive lead → RV_5d fired first.
 *
 * Pass criterion: for at least one θ in K, lead ≥ 1 in ≥ 2 of 3 events.
 *
 * Events: Feb-2018 Volmageddon, Mar-2020 COVID, Aug-2024 yen-carry.
 * Oct-1987 unavailable — SPY data starts 2008-01-02.
 */
import { getClickHouse } from '../src/server/clickhouse.js';

const K_THETA: readonly number[] = [0.20, 0.25, 0.30, 0.35, 0.40] as const;
const RV_WINDOW = 5;
const ANNUALIZATION = Math.sqrt(252);

interface EventWindow {
  name: string;
  start: string;
  end: string;
  prefixStart: string;
}

const EVENTS: readonly EventWindow[] = [
  { name: 'feb_2018_volmageddon', start: '2018-01-15', end: '2018-02-28', prefixStart: '2017-12-15' },
  { name: 'mar_2020_covid',       start: '2020-02-15', end: '2020-04-15', prefixStart: '2020-01-15' },
  { name: 'aug_2024_yen_carry',   start: '2024-07-15', end: '2024-08-31', prefixStart: '2024-06-15' },
] as const;

interface SpyRow { d: string; close: number; }
interface RegimeRow { d: string; vix_term_inverted: number; }

async function fetchSpy(ch: ReturnType<typeof getClickHouse>, fromD: string, toD: string): Promise<SpyRow[]> {
  const r = await ch.query({
    query: `
      SELECT toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles FINAL
      WHERE token_address = 'SPY_USD'
        AND interval = '1d'
        AND source = 'yfinance_regime'
        AND toDate(timestamp) >= toDate({fromD:String})
        AND toDate(timestamp) <= toDate({toD:String})
      ORDER BY timestamp ASC
    `,
    query_params: { fromD, toD },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string; close: number | string }>();
  return rows
    .map(x => ({ d: x.d, close: Number(x.close) }))
    .filter(x => Number.isFinite(x.close));
}

async function fetchVixTerm(ch: ReturnType<typeof getClickHouse>, fromD: string, toD: string): Promise<RegimeRow[]> {
  const r = await ch.query({
    query: `
      SELECT toString(trade_date) AS d, vix_term_inverted
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v2'
        AND trade_date >= toDate({fromD:String})
        AND trade_date <= toDate({toD:String})
      ORDER BY trade_date ASC
    `,
    query_params: { fromD, toD },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string; vix_term_inverted: number | string }>();
  return rows.map(x => ({ d: x.d, vix_term_inverted: Number(x.vix_term_inverted) }));
}

/**
 * RV_5d_annualized for each session given closes ordered earliest-to-
 * latest. First RV_WINDOW entries are NaN (insufficient log-return
 * history). Sample stdev (Bessel-corrected, denominator n-1).
 */
function computeRv5d(closes: number[]): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  const logRets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    logRets.push(Math.log(closes[i] / closes[i - 1]));
  }
  // logRets[i] = return from closes[i] -> closes[i+1].
  // RV at session t uses last RV_WINDOW returns ending at t: indices [t-RV_WINDOW, t-1].
  for (let t = RV_WINDOW; t < closes.length; t++) {
    const window = logRets.slice(t - RV_WINDOW, t);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / (window.length - 1);
    out[t] = Math.sqrt(variance) * ANNUALIZATION;
  }
  return out;
}

interface ThetaPoint {
  theta: number;
  rvFirstIdx: number | null;
  rvFirstDate: string | null;
  rvFirstValue: number | null;
  leadSessions: number | null;
}

interface EventResult {
  event: string;
  windowDates: string[];
  vixTermFirstIdx: number | null;
  vixTermFirstDate: string | null;
  perTheta: ThetaPoint[];
}

async function analyzeEvent(ch: ReturnType<typeof getClickHouse>, ev: EventWindow): Promise<EventResult> {
  const spy = await fetchSpy(ch, ev.prefixStart, ev.end);
  const regime = await fetchVixTerm(ch, ev.start, ev.end);

  const closes = spy.map(s => s.close);
  const rv5 = computeRv5d(closes);

  const windowDates: string[] = [];
  const windowRv: number[] = [];
  for (let i = 0; i < spy.length; i++) {
    if (spy[i].d >= ev.start && spy[i].d <= ev.end) {
      windowDates.push(spy[i].d);
      windowRv.push(rv5[i]);
    }
  }

  const vixByDate = new Map<string, number>();
  for (const r of regime) vixByDate.set(r.d, r.vix_term_inverted);

  let vixTermFirstIdx: number | null = null;
  let vixTermFirstDate: string | null = null;
  for (let i = 0; i < windowDates.length; i++) {
    if (vixByDate.get(windowDates[i]) === 1) {
      vixTermFirstIdx = i;
      vixTermFirstDate = windowDates[i];
      break;
    }
  }

  const perTheta: ThetaPoint[] = K_THETA.map(theta => {
    let rvFirstIdx: number | null = null;
    let rvFirstDate: string | null = null;
    let rvFirstValue: number | null = null;
    for (let i = 0; i < windowDates.length; i++) {
      const v = windowRv[i];
      if (Number.isFinite(v) && v > theta) {
        rvFirstIdx = i;
        rvFirstDate = windowDates[i];
        rvFirstValue = v;
        break;
      }
    }
    const leadSessions =
      rvFirstIdx != null && vixTermFirstIdx != null
        ? vixTermFirstIdx - rvFirstIdx
        : null;
    return { theta, rvFirstIdx, rvFirstDate, rvFirstValue, leadSessions };
  });

  return {
    event: ev.name,
    windowDates,
    vixTermFirstIdx,
    vixTermFirstDate,
    perTheta,
  };
}

function printEventResult(r: EventResult): void {
  const first = r.windowDates[0] ?? '(empty)';
  const last = r.windowDates[r.windowDates.length - 1] ?? '(empty)';
  console.log(`\n=== ${r.event} ===`);
  console.log(`  Window: ${first} → ${last} (${r.windowDates.length} sessions)`);
  console.log(`  vix_term_inverted first fire: ${r.vixTermFirstDate ?? 'NEVER'}`
              + (r.vixTermFirstIdx != null ? ` (window idx ${r.vixTermFirstIdx})` : ''));
  console.log(`  Per-θ RV_5d crossings:`);
  console.log(`     θ     RV_first_date   RV_first_val   lead   verdict`);
  for (const t of r.perTheta) {
    const rvVal = t.rvFirstValue == null ? '—' : (t.rvFirstValue * 100).toFixed(1) + '%';
    const rvDate = t.rvFirstDate ?? 'NEVER';
    const leadStr =
      t.leadSessions == null ? 'N/A'
      : t.leadSessions >= 0 ? `+${t.leadSessions}`
      : `${t.leadSessions}`;
    const interp =
      t.leadSessions == null ? (t.rvFirstIdx == null ? 'RV never crossed' : 'vix_term never fired')
      : t.leadSessions > 0   ? 'PASS (RV led)'
      : t.leadSessions === 0 ? 'TIE (co-fired)'
      : 'FAIL (vix_term led)';
    console.log(`    ${(t.theta * 100).toFixed(0).padStart(2)}%   ${rvDate.padEnd(12)}   ${rvVal.padStart(7)}      ${leadStr.padStart(4)}   ${interp}`);
  }
}

function applyPassCriterion(results: EventResult[]): { theta: number; passEvents: number; passing: boolean } {
  let bestTheta = K_THETA[0];
  let bestPassCount = -1;
  for (const theta of K_THETA) {
    let passCount = 0;
    for (const r of results) {
      const t = r.perTheta.find(x => x.theta === theta)!;
      if (t.leadSessions != null && t.leadSessions >= 1) passCount++;
    }
    if (passCount > bestPassCount) {
      bestPassCount = passCount;
      bestTheta = theta;
    }
  }
  return { theta: bestTheta, passEvents: bestPassCount, passing: bestPassCount >= 2 };
}

async function main() {
  const ch = getClickHouse();
  console.log('PHASE 2 RV_5d LEAD-LAG PRE-REGISTRATION DIAGNOSTIC');
  console.log('==================================================');
  console.log(`K = ${K_THETA.map(t => (t * 100).toFixed(0) + '%').join(', ')} (locked before scoring)`);
  console.log(`Pass criterion: for at least one θ, lead ≥ 1 session in ≥ 2 of 3 events.`);

  const results: EventResult[] = [];
  for (const ev of EVENTS) {
    results.push(await analyzeEvent(ch, ev));
  }
  for (const r of results) printEventResult(r);

  const verdict = applyPassCriterion(results);
  console.log('\n=== VERDICT ===');
  console.log(`Best θ by pass count: ${(verdict.theta * 100).toFixed(0)}% (lead ≥ 1 in ${verdict.passEvents}/3 events)`);
  console.log(`Pre-registration: ${verdict.passing ? 'PASS' : 'FAIL'}`);
  if (!verdict.passing) {
    console.log('\nRV_5d does NOT lead vix_term_inverted in ≥ 2 of 3 events for any θ in K.');
    console.log('Per pre-committed escalation order, escalate to VVIX (with critic §3 mods forced).');
  } else {
    console.log('\nRV_5d leads vix_term_inverted in ≥ 2 of 3 events for at least one θ in K.');
    console.log('Family hypothesis survives pre-registration. Proceed to SPEC rev 1 drafting.');
  }
}

main().catch(e => {
  console.error('DIAGNOSTIC FAILED:', e);
  process.exitCode = 1;
});

/*
 * What could break this:
 *   - First-crossing-only is a coarse summary. A family that crosses
 *     marginally before vix_term_inverted but reverts immediately is
 *     not actually predictive; the procedure (Steps 3-5) tests
 *     persistence and statistical significance, not just first-crossing.
 *     The diagnostic is a CHEAP gate, not a proof. A "PASS" here is a
 *     necessary but not sufficient condition.
 *   - Event window boundaries are judgment calls. If a θ is sensitive
 *     to where the window starts (e.g. first-crossing differs by ±2
 *     sessions when window starts a week earlier), the lead is fragile.
 *     Robustness to start date is NOT tested here; flagged as a SPEC
 *     concern for the post-pre-reg work.
 *   - vix_term_inverted comes from the active phase1_v2 classifier
 *     rows. If those rows are missing (NULL) for the event window
 *     dates due to ingest gaps, the diagnostic will silently treat
 *     them as not-firing and may misreport the lead. The sample-size
 *     check in printEventResult flags empty windows; per-day NULL
 *     handling is by Number(null)=0 which is correct (treats NULL as
 *     not firing, matching the production behavior).
 */
