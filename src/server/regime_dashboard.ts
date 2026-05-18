/**
 * Regime dashboard orchestrator — Track C / Component 3.
 *
 * Powers `GET /api/regime/state` for the `/#/regime` route. Read-only view of
 * `quantlab.macro_regimes` under the active `CLASSIFIER_VERSION` (currently
 * `'phase1_v3'`; see macro_regime.ts header for the ramp history). Surfaces
 * today's regime + indicator strip + 5d rolling-union grid + 252d timeline +
 * regime distribution vs the active-version baseline, all in one response so
 * the bias-quarantine banner cannot desync from the regime label.
 *
 * SPEC: docs/specs/regime-dashboard-component3.md (§3).
 *
 * Design split:
 *   - Pure helpers (parseQuery, computeDaysInCurrentRegime, findPreviousRegime,
 *     buildFiveDayWindow, rollUpDistribution) — testable without ClickHouse.
 *   - One impure entry point (fetchRegimeState) — reuses
 *     fetchMacroRegimeRange + a small "latest date" probe from macro_regime.ts.
 *
 * Bias-quarantine note: the response carries `biasNote` and the UI MUST
 * render it. `BIAS_NOTE_PHASE1_V3` is the live note (survivorship-immune
 * via leading indicators); `BIAS_NOTE_PHASE1_V2` is kept as an exported
 * constant for backward references to archived phase1_v2 rows in
 * `bt_runs_regime` but is no longer the active banner.
 */
import {
  CLASSIFIER_VERSION,
  fetchMacroRegimeRange,
  type MacroRegimeRow,
  type Regime,
} from './macro_regime.js';
import { getClickHouse } from './clickhouse.js';

// ── Public types ────────────────────────────────────────────────────────────

export interface RegimeCounts {
  red: number;
  orange: number;
  yellow: number;
  green: number;
}

export interface BiasNote {
  headline: string;
  body: string;
  docLinks: { label: string; href: string }[];
  fixtureFailures: number;
}

export interface FiveDayWindowEntry {
  date: string;
  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;
  breadth_narrow: 0 | 1;
  realized_stress: 0 | 1;
  categories_firing: number;
}

export interface TimelineEntry {
  date: string;
  regime: Regime;
  signals_firing: number;
  categories_firing: number;
  categories_firing_5d: number;
}

export interface DistributionBucket {
  lookbackDays?: number;
  tradingDays: number;
  counts: RegimeCounts;
  pct: RegimeCounts;
}

export interface DistributionBaselineBucket {
  /**
   * Which ADR the baseline numbers come from. `'ADR-037'` is the
   * phase1_v2 archival baseline; `'ADR-038'` is the phase1_v3 live
   * baseline. The dashboard picks by the active `CLASSIFIER_VERSION`.
   */
  source: 'ADR-037' | 'ADR-038';
  tradingDays: number;
  counts: RegimeCounts;
  pct: RegimeCounts;
}

export interface RegimeDistribution {
  windowed: DistributionBucket;
  oneYear: DistributionBucket;
  fiveYear: DistributionBucket;
  allTime: DistributionBucket;
  baseline: DistributionBaselineBucket;
  /** windowed.pct - baseline.pct, in percentage points (signed). */
  deviation: RegimeCounts;
}

export interface RegimeStateResponse {
  classifierVersion: string;
  biasNote: BiasNote;
  asOfDate: string;
  isLatest: boolean;
  today: MacroRegimeRow;
  daysInCurrentRegime: number;
  previousRegime: { regime: Regime; lastDate: string } | null;
  fiveDayWindow: FiveDayWindowEntry[];
  timeline: TimelineEntry[];
  distribution: RegimeDistribution;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** SPEC §3.1 query bounds. */
export const LOOKBACK_DAYS_MIN = 5;
export const LOOKBACK_DAYS_MAX = 5040;
export const LOOKBACK_DAYS_DEFAULT = 252;

/** Trading-days-per-year approximation used for fixed lookbacks (1Y, 5Y). */
export const TRADING_DAYS_PER_YEAR = 252;

/**
 * ADR-037 §5 baseline — verified empirically 2026-05-10 against
 * `quantlab.macro_regimes FINAL` under `phase1_v2`. Retained as an exported
 * constant for back-references to archived `phase1_v2` rows in
 * `bt_runs_regime` and for the phase1_v2 distribution test in
 * `regimeDashboard.test.ts`. Not the active dashboard baseline — see
 * `ADR_038_BASELINE` below.
 */
export const ADR_037_BASELINE: RegimeCounts = {
  red: 50,
  orange: 78,
  yellow: 1172,
  green: 3317,
};
export const ADR_037_BASELINE_TRADING_DAYS =
  ADR_037_BASELINE.red +
  ADR_037_BASELINE.orange +
  ADR_037_BASELINE.yellow +
  ADR_037_BASELINE.green;

/**
 * ADR-038 §2 baseline (Accepted 2026-05-15; retroactive write-up 2026-05-16)
 * — verified empirically against `quantlab.macro_regimes FINAL WHERE
 * classifier_version='phase1_v3'`. The v3 baseline is the active dashboard
 * comparator. See `docs/decisions/README.md` ADR-038 for the full record.
 *
 * **Re-pinned 2026-05-15 (session 45)** after a `macro:backfill:v3` rerun
 * over the now-populated CBOE put/call corpus (2003-2019). The session-44
 * PUSHBACK lock on the rerun was protecting against shifting the baseline
 * mid-corpus — but the pre-rerun CH state had drifted to a v2-shaped
 * distribution that didn't reflect v3 at all (the 4 stress-period fixtures
 * in `macroRegimeFixturesV3.test.ts` were failing 3/4 with 0 reds in
 * 2008/2011/2020). The drift was the bigger problem, so the rerun was the
 * fix.
 *
 * Activation of the CBOE `^CPC` arm for 2003-2019 adds `sentiment_extreme`
 * firings during those years (the VIX/VIX3M complacency arm alone could
 * not see them). 2019-10-04 → present remains CBOE-dark (paid product
 * gate) and continues to rely on the VIX/VIX3M arm only. The mid-corpus
 * shift in 2019 noted in session 44 is real but is now baked into this
 * pin until the CBOE 2019-present gap closes — at which point another
 * controlled rerun + re-pin should follow.
 *
 * Prior pins (kept here for forensic value):
 * - Session 40 (2026-05-10): `{red:32, orange:370, yellow:1406, green:2809}`
 *   after VIX_TERM_COMPLACENCY_FLOOR 0.85→0.80 ramp; pre CBOE-2003-2019
 *   ingest. The CBOE-arm of `sentiment_extreme` was structurally null
 *   for the entire 2008-2026 corpus at that pin's time.
 * - Session 45 (2026-05-15): `{red:127, orange:349, yellow:1392,
 *   green:2754}` — current. CBOE-arm active for 2003-2019, dark
 *   2019-present. Per-year reds:
 *     2008:34 2009:0 2010:9 2011:35 2012:0 2013:0 2014:11 2015:4
 *     2016:13 2017:0 2018:7 2019:10 2020:4 2021:0 2022:0 2023:0
 *     2024:0 2025:0 2026:0
 *
 * Test coverage in `scripts/tests/regimeDashboard.test.ts` test #9b —
 * drift triggers a clear test failure rather than a silent wrong-headline.
 * Any future PR that shifts the distribution (a re-tune of any other
 * threshold, a new category, a phase2_v1 flip, a CBOE gap-close rerun)
 * MUST update this constant in the same PR.
 */
export const ADR_038_BASELINE: RegimeCounts = {
  red: 127,
  orange: 349,
  yellow: 1392,
  green: 2754,
};
export const ADR_038_BASELINE_TRADING_DAYS =
  ADR_038_BASELINE.red +
  ADR_038_BASELINE.orange +
  ADR_038_BASELINE.yellow +
  ADR_038_BASELINE.green;

/**
 * Phase1_v2 bias-quarantine banner copy (ADR-037 §5). Retained as an
 * exported constant for back-references to archived `phase1_v2` rows and
 * for the v2 distribution test in `regimeDashboard.test.ts`; **no longer
 * the active banner** — the live classifier is `phase1_v3` and the
 * `fetchRegimeState` response carries `BIAS_NOTE_PHASE1_V3` below.
 */
export const BIAS_NOTE_PHASE1_V2: BiasNote = {
  headline: 'Survivorship-biased — phase1_v2',
  body:
    'Phase 1 of the macro regime classifier ships under classifier_version=phase1_v2 with documented ' +
    'survivorship bias in the breadth indicator: `pct_above_50dma` is computed against today\'s ' +
    'S&P 500 constituents back-projected through history, so survivors are over-represented and ' +
    'delisted names (the very tickers whose drops would have widened breadth-narrow) are absent. ' +
    'The principled fix (`phase1_v3`) is gated on Sharadar paid-data activation — see ADR-037.',
  docLinks: [
    { label: 'ADR-037', href: '/docs/decisions/README.md' },
    { label: 'Bias quantification', href: '/docs/phase1_breadth_restoration/bias_quantification.md' },
    { label: 'SPEC rev 3', href: '/docs/specs/macro-regime-classifier-phase1-rev3-breadth-amendment.md' },
  ],
  fixtureFailures: 4,
};

/**
 * Phase1_v3 bias-quarantine banner copy — the ACTIVE banner. The v3
 * classifier replaces `breadth_narrow` (the sole source of survivorship
 * bias in v2) with three free leading indicators (yield curve, HY OAS,
 * SPY/TLT spread) plus a dual-source sentiment_extreme category, none of
 * which depend on S&P 500 constituent membership. Per ADR-037 §5 the v3
 * stack is **explicitly permitted** for tuning loops, kill-switch
 * criteria, and downstream gating — the v2 fence does NOT apply.
 *
 * Polarity flip relative to BIAS_NOTE_PHASE1_V2: the headline announces a
 * positive property (survivorship-immune) rather than a documented flaw.
 * Test #10b in `regimeDashboard.test.ts` pins the constant to the
 * survivorship-immune phrasing so a future regression that drops the
 * caveat surface is caught.
 *
 * `fixtureFailures: 0` — all four ADR-037 fixture windows pass under v3
 * per `scripts/tests/macroRegimeFixturesV3.test.ts` (session 39 turn 3).
 */
export const BIAS_NOTE_PHASE1_V3: BiasNote = {
  headline: 'Survivorship-immune — phase1_v3',
  body:
    'Phase 1 v3 of the macro regime classifier ships under classifier_version=phase1_v3 and is ' +
    'survivorship-immune. The v2 `breadth_narrow` category (the sole source of survivorship bias ' +
    'per ADR-037) is dropped from the category count and replaced with four free leading indicators: ' +
    'yield_curve_inverted (T10Y2Y < 0 for ≥3 consecutive trading days; Estrella-Hardouvelis 1997), ' +
    'credit_stress (HYG/LQD 20d return < −3%; Gilchrist-Zakrajšek 2012 analogue), risk_off_rotation ' +
    '(SPY 20d − TLT 20d < −10pp), and sentiment_extreme (CBOE ^CPC 5d MA OR VIX/VIX3M ≤ 0.80; ' +
    'Whaley 2009). None depend on S&P 500 constituent membership — see ADR-037 ramp PR and SPEC ' +
    'phase1_v3 §2.',
  docLinks: [
    { label: 'ADR-037', href: '/docs/decisions/README.md' },
    { label: 'SPEC phase1_v3', href: '/docs/specs/macro-regime-classifier-phase1_v3.md' },
    { label: 'Bias quantification', href: '/docs/phase1_breadth_restoration/bias_quantification.md' },
  ],
  fixtureFailures: 0,
};

// ── Query parsing ───────────────────────────────────────────────────────────

export type ParsedRegimeQuery =
  | { ok: true; asOf: string | null; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(p: ParsedRegimeQuery): p is Extract<ParsedRegimeQuery, { ok: false }> {
  return !p.ok;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseQuery(input: { asOf?: unknown; lookbackDays?: unknown }): ParsedRegimeQuery {
  let asOf: string | null = null;
  if (input.asOf !== undefined && input.asOf !== '' && input.asOf !== null) {
    const s = String(input.asOf);
    if (!ISO_DATE.test(s)) {
      return { ok: false, status: 400, error: 'bad_query', detail: 'asOf must be YYYY-MM-DD' };
    }
    const d = new Date(s + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      return { ok: false, status: 400, error: 'bad_query', detail: `asOf=${s} is not a valid calendar date` };
    }
    asOf = s;
  }

  let lookbackDays = LOOKBACK_DAYS_DEFAULT;
  if (input.lookbackDays !== undefined && input.lookbackDays !== '' && input.lookbackDays !== null) {
    const n = Number(input.lookbackDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < LOOKBACK_DAYS_MIN || n > LOOKBACK_DAYS_MAX) {
      return {
        ok: false, status: 400, error: 'bad_query',
        detail: `lookbackDays must be an integer in [${LOOKBACK_DAYS_MIN}, ${LOOKBACK_DAYS_MAX}]`,
      };
    }
    lookbackDays = n;
  }

  return { ok: true, asOf, lookbackDays };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Count consecutive trading-day rows ending at `asOfDate` carrying the same
 * `regime` label as the row at `asOfDate`. Returns 0 if `rows` is empty or
 * if `asOfDate` is not the last row.
 *
 * Caller must pass an ASC-ordered window where `rows[length-1].trade_date ===
 * asOfDate`. `fetchRegimeState` widens the window once (by another 1Y) if
 * the streak count equals `rows.length` — i.e., the streak might extend
 * earlier than the loaded window.
 */
export function computeDaysInCurrentRegime(rows: MacroRegimeRow[], asOfDate: string): number {
  if (rows.length === 0) return 0;
  const last = rows[rows.length - 1];
  if (last.trade_date !== asOfDate) return 0;
  const target = last.regime;
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].regime !== target) break;
    streak++;
  }
  return streak;
}

/**
 * Walk back from `asOfDate` and return the most recent label that differs from
 * the asOfDate row's label, plus the date that label was last observed.
 * Returns null if no flip exists in the supplied rows (caller widens or accepts).
 */
export function findPreviousRegime(
  rows: MacroRegimeRow[],
  asOfDate: string,
): { regime: Regime; lastDate: string } | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  if (last.trade_date !== asOfDate) return null;
  const current = last.regime;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].regime !== current) {
      return { regime: rows[i].regime, lastDate: rows[i].trade_date };
    }
  }
  return null;
}

/**
 * Last up-to-5 rows projected to the 5d-window shape that mirrors the
 * classifier's `red` rolling-union input. No padding — length is min(5,
 * rows.length); the UI is responsible for rendering missing slots as a
 * neutral hatch rather than zero-fills (zero-fill would lie about whether
 * the indicator fired).
 */
export function buildFiveDayWindow(rows: MacroRegimeRow[]): FiveDayWindowEntry[] {
  const tail = rows.slice(-5);
  return tail.map(r => ({
    date: r.trade_date,
    vix_term_inverted: r.vix_term_inverted,
    hyg_spy_divergence: r.hyg_spy_divergence,
    breadth_narrow: r.breadth_narrow,
    realized_stress: r.realized_stress,
    categories_firing: r.categories_firing,
  }));
}

/**
 * Histogram by `regime`. Defensive: rows with an unrecognized label are
 * dropped (this should be impossible under the `phase1_v2` / `phase1_v3`
 * enum which both use {green, yellow, orange, red}), so the count sum
 * equals the row count only for well-formed input.
 */
export function rollUpDistribution(rows: MacroRegimeRow[]): RegimeCounts {
  const out: RegimeCounts = { red: 0, orange: 0, yellow: 0, green: 0 };
  for (const r of rows) {
    if (r.regime === 'red' || r.regime === 'orange' || r.regime === 'yellow' || r.regime === 'green') {
      out[r.regime]++;
    }
  }
  return out;
}

/** counts -> percent of total (rounded to 2 decimals). All-zero counts -> all-zero pct. */
export function pctOf(counts: RegimeCounts): RegimeCounts {
  const total = counts.red + counts.orange + counts.yellow + counts.green;
  if (total === 0) return { red: 0, orange: 0, yellow: 0, green: 0 };
  const r2 = (n: number) => Math.round((n / total) * 10000) / 100;
  return {
    red: r2(counts.red),
    orange: r2(counts.orange),
    yellow: r2(counts.yellow),
    green: r2(counts.green),
  };
}

function projectTimeline(rows: MacroRegimeRow[]): TimelineEntry[] {
  return rows.map(r => ({
    date: r.trade_date,
    regime: r.regime,
    signals_firing: r.signals_firing,
    categories_firing: r.categories_firing,
    categories_firing_5d: r.categories_firing_5d,
  }));
}

// ── Impure entry point ──────────────────────────────────────────────────────

/** Read the most recent classified date under the active CLASSIFIER_VERSION. */
async function fetchLatestClassifiedDate(): Promise<string | null> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(max(trade_date)) AS d
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = {cv:String}
    `,
    query_params: { cv: CLASSIFIER_VERSION },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string | null }>();
  if (rows.length === 0 || !rows[0].d) return null;
  return rows[0].d;
}

/** Return ISO YYYY-MM-DD `n` calendar days before `iso`. */
function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Orchestrate the response for `/api/regime/state`.
 *
 * Loading strategy:
 *   1. Resolve `asOfDate` — query if omitted; otherwise clamp to latest row
 *      (server bumps `isLatest=false` if the request asked for a date past
 *      the latest available).
 *   2. Load rows in `[asOfDate - calendarBuffer(max(lookbackDays, 1Y)) ..
 *      asOfDate]`. We pull a generous calendar buffer so trading-day counts
 *      land near the requested lookback after weekend/holiday compression.
 *   3. Pre-compute 1Y / 5Y / all-time tradingDays + counts. 1Y and 5Y are
 *      derived from row positions (not calendar arithmetic), so they're
 *      robust to holiday gaps. All-time runs a separate query to avoid
 *      materializing 4617 rows just to count them.
 *   4. If `daysInCurrentRegime === windowed rows.length`, widen the window
 *      by another 252-trading-day calendar buffer once. Documented in SPEC
 *      §4 watch-out.
 *
 * Error semantics per SPEC §3.1:
 *   - 503 on empty CH (caller should run `npm run macro:backfill`).
 *   - 400 on `asOf` earlier than first available date.
 */
export async function fetchRegimeState(args: {
  asOf: string | null;
  lookbackDays: number;
}): Promise<RegimeStateResponse> {
  const latest = await fetchLatestClassifiedDate();
  if (!latest) {
    throw new RegimeDashboardError(
      503,
      'no_regime_rows',
      `no rows in quantlab.macro_regimes under classifier_version=${CLASSIFIER_VERSION}; ` +
      `run npm run macro:backfill first`,
    );
  }

  // asOf resolution: clamp to latest. isLatest is true unless asOf was specified
  // and refers to an earlier date that exists in CH.
  const requested = args.asOf;
  let asOfDate = latest;
  let isLatest = true;
  if (requested) {
    if (requested > latest) {
      // asOf later than latest — clamp + flag
      asOfDate = latest;
      isLatest = false; // user explicitly asked for the future; signal we clamped
    } else {
      asOfDate = requested;
      isLatest = requested === latest;
    }
  }

  // Calendar buffer: pull max(lookbackDays, 1Y) trading days, with calendar
  // padding so weekends/holidays don't truncate. ~1.45x trading→calendar ratio.
  const targetTradingDays = Math.max(args.lookbackDays, TRADING_DAYS_PER_YEAR);
  const calendarBuffer = Math.ceil(targetTradingDays * 1.5) + 14;
  let windowStart = isoMinusDays(asOfDate, calendarBuffer);
  let rows = await fetchMacroRegimeRange(windowStart, asOfDate, CLASSIFIER_VERSION);

  if (rows.length === 0) {
    // asOf precedes earliest row OR the buffer happened to land in a gap.
    // Probe for the earliest row to disambiguate.
    const ch = getClickHouse();
    const r = await ch.query({
      query: `
        SELECT toString(min(trade_date)) AS d
        FROM quantlab.macro_regimes FINAL
        WHERE classifier_version = {cv:String}
      `,
      query_params: { cv: CLASSIFIER_VERSION },
      format: 'JSONEachRow',
    });
    const probe = await r.json<{ d: string | null }>();
    const earliest = probe.length > 0 ? probe[0].d : null;
    if (earliest && asOfDate < earliest) {
      throw new RegimeDashboardError(
        400, 'bad_query',
        `asOf precedes earliest classified date ${earliest}`,
      );
    }
    // Fall through with empty rows; orchestrator will produce an honest
    // empty-state response below.
  }

  // Widen-once if streak might extend before the loaded window.
  if (rows.length > 0 && computeDaysInCurrentRegime(rows, asOfDate) === rows.length) {
    const wider = isoMinusDays(asOfDate, calendarBuffer + 365);
    if (wider < windowStart) {
      windowStart = wider;
      rows = await fetchMacroRegimeRange(windowStart, asOfDate, CLASSIFIER_VERSION);
    }
  }

  // Locate the today-row. Most of the time rows[length-1].trade_date === asOfDate;
  // if a holiday or non-trading-day asOf lands in a gap, fall to the latest <= asOfDate.
  const todayIdx = (() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].trade_date <= asOfDate) return i;
    }
    return -1;
  })();
  if (todayIdx === -1) {
    throw new RegimeDashboardError(
      400, 'bad_query',
      `no classified rows at-or-before ${asOfDate} (window ${windowStart}..${asOfDate})`,
    );
  }
  const today = rows[todayIdx];
  // Use the actual row date when surfacing asOfDate so downstream consumers see truth.
  const surfacedAsOfDate = today.trade_date;
  if (surfacedAsOfDate !== asOfDate) isLatest = false;

  // Slice rows to "[..., today]" — drop any rows after asOfDate (defensive;
  // happens only if asOf is an actual non-trading day).
  const through = rows.slice(0, todayIdx + 1);

  const daysInCurrentRegime = computeDaysInCurrentRegime(through, surfacedAsOfDate);
  const previousRegime = findPreviousRegime(through, surfacedAsOfDate);
  const fiveDayWindow = buildFiveDayWindow(through);

  // Timeline: trim to lookbackDays trading days. through is ASC; trading days
  // == row count, since macro_regimes only has rows for SPY trading dates.
  const timelineRows = through.slice(Math.max(0, through.length - args.lookbackDays));
  const timeline = projectTimeline(timelineRows);

  // Distribution rollups.
  const windowedCounts = rollUpDistribution(timelineRows);
  const oneYearRows = through.slice(Math.max(0, through.length - TRADING_DAYS_PER_YEAR));
  const oneYearCounts = rollUpDistribution(oneYearRows);
  const fiveYearRows = through.slice(Math.max(0, through.length - 5 * TRADING_DAYS_PER_YEAR));
  const fiveYearCounts = rollUpDistribution(fiveYearRows);

  const allTime = await fetchAllTimeDistribution();

  const baselinePct = pctOf(ADR_038_BASELINE);
  const windowedPct = pctOf(windowedCounts);
  const deviation: RegimeCounts = {
    red:    Math.round((windowedPct.red    - baselinePct.red)    * 100) / 100,
    orange: Math.round((windowedPct.orange - baselinePct.orange) * 100) / 100,
    yellow: Math.round((windowedPct.yellow - baselinePct.yellow) * 100) / 100,
    green:  Math.round((windowedPct.green  - baselinePct.green)  * 100) / 100,
  };

  const distribution: RegimeDistribution = {
    windowed: {
      lookbackDays: args.lookbackDays,
      tradingDays: timelineRows.length,
      counts: windowedCounts,
      pct: windowedPct,
    },
    oneYear: {
      tradingDays: oneYearRows.length,
      counts: oneYearCounts,
      pct: pctOf(oneYearCounts),
    },
    fiveYear: {
      tradingDays: fiveYearRows.length,
      counts: fiveYearCounts,
      pct: pctOf(fiveYearCounts),
    },
    allTime: {
      tradingDays: allTime.tradingDays,
      counts: allTime.counts,
      pct: pctOf(allTime.counts),
    },
    baseline: {
      source: 'ADR-038',
      tradingDays: ADR_038_BASELINE_TRADING_DAYS,
      counts: ADR_038_BASELINE,
      pct: baselinePct,
    },
    deviation,
  };

  return {
    classifierVersion: CLASSIFIER_VERSION,
    biasNote: BIAS_NOTE_PHASE1_V3,
    asOfDate: surfacedAsOfDate,
    isLatest,
    today,
    daysInCurrentRegime,
    previousRegime,
    fiveDayWindow,
    timeline,
    distribution,
  };
}

async function fetchAllTimeDistribution(): Promise<{ tradingDays: number; counts: RegimeCounts }> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT regime, count() AS n
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = {cv:String}
      GROUP BY regime
    `,
    query_params: { cv: CLASSIFIER_VERSION },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ regime: string; n: number | string }>();
  const counts: RegimeCounts = { red: 0, orange: 0, yellow: 0, green: 0 };
  let tradingDays = 0;
  for (const row of rows) {
    const n = Number(row.n);
    if (!Number.isFinite(n)) continue;
    if (row.regime === 'red' || row.regime === 'orange' || row.regime === 'yellow' || row.regime === 'green') {
      counts[row.regime] = n;
      tradingDays += n;
    }
  }
  return { tradingDays, counts };
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class RegimeDashboardError extends Error {
  status: number;
  error: string;
  detail: string;
  constructor(status: number, error: string, detail: string) {
    super(`${error}: ${detail}`);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

/**
 * What could break this:
 *   - `BIAS_NOTE_PHASE1_V3` and `ADR_038_BASELINE` are snapshots; they will
 *     drift if `npm run macro:backfill:v3` re-runs over a wider window or
 *     if a threshold tuning PR (e.g. `VIX_TERM_COMPLACENCY_FLOOR`) shifts
 *     the v3 red/orange/yellow/green counts. Tests #9b and #10b catch the
 *     mechanical part; the human discipline is to update both constants
 *     in the same PR as any classifier-version bump or threshold change.
 *   - The widen-once heuristic for `daysInCurrentRegime` covers streaks up
 *     to ~750 calendar days. ADR-037's all-time distribution shows green
 *     can run >1Y; if a future regime label is observed running >2Y, the
 *     widen-once fails to capture the true streak. Mitigation: log a warn
 *     line, return the loaded streak (still correct on the lower bound).
 *   - `fetchAllTimeDistribution` is a small aggregate (4 rows) but un-cached;
 *     hits CH on every dashboard fetch. Acceptable for a personal-tool route
 *     refresh cadence; if usage scales, add a 60s in-memory TTL.
 */
