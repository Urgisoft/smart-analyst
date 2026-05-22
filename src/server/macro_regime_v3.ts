/**
 * Track C / Component 1 — phase1_v3 macro regime classifier.
 *
 * Per `docs/specs/macro-regime-classifier-phase1_v3.md`, this is the
 * survivorship-bias-free successor to phase1_v2. The breadth indicator
 * (`pct_above_50dma` — the source of ADR-037's bias quarantine) is DROPPED
 * from the category count. Four free leading indicators replace it:
 *
 *   4. yield_curve_inverted (T10Y3M < 0 on the latest FRED observation;
 *                            single-day fire — no persistence required.
 *                            ADR-041 (Accepted 2026-05-19) replaces the
 *                            prior T10Y2Y/3-day rule with the Estrella-
 *                            Mishkin 1998 canon construct; `inversion_days_20d`
 *                            ships as a diagnostic-only counter alongside.)
 *   5. credit_stress        (20d return of HYG/LQD ratio < -3%)
 *   6. risk_off_rotation    (SPY 20d return - TLT 20d return < -10pp)
 *   7. sentiment_extreme    (CBOE ^CPC 5d MA extreme OR VIX/VIX3M <= 0.80)
 *
 * Three categories carry over from phase1_v2 unchanged:
 *
 *   1. vix_term_inverted    (VIX/VIX3M > 1.0)
 *   2. hyg_spy_divergence   (HYG 20d return < 0 AND SPY 20d return > 0)
 *   3. realized_stress      (Phase 2; dormant under null θ — contributes 0)
 *
 * Active-category count is 6 (categories 1, 2, 4, 5, 6, 7); category 3
 * remains structurally 0 unless/until Phase 2 plugs θ. Composite rule:
 *
 *   - RED if categories_firing_5d >= 4 (matches v2 engine semantics
 *     under a wider category set)
 *   - ORANGE if categories_firing_today >= 2
 *   - YELLOW if categories_firing_today >= 1
 *   - GREEN otherwise
 *
 * Why a separate file from `macro_regime.ts`: ADR-037 bias-quarantine.
 * The phase1_v2 classifier MUST stay byte-equal to its session-25 shape so
 * historical attribution remains queryable. Adding v3 alongside (rather
 * than inline) makes the version split structural, not policy.
 *
 * Sources:
 *   - Yield curve: Estrella & Mishkin (1998) "Predicting U.S. Recessions:
 *     Financial Variables as Leading Indicators," Review of Economics and
 *     Statistics 80(1), 45-61 — Tier 1 canon, T10Y3M identified as the
 *     single most reliable financial-variable leading indicator for U.S.
 *     recessions. Out-of-sample extension: Estrella-Trubin 2006 FRBNY
 *     Current Issues; Bauer-Mertens 2018 FRBSF Economic Letter. Locked
 *     by ADR-041 (docs/decisions/README.md).
 *   - Credit spreads via HYG/LQD ratio: Gilchrist-Zakrajšek 2012 (analogue;
 *     they use BAA-Treasury OAS, we use HYG/LQD as a free ETF proxy)
 *   - Sentiment via put/call: Whaley (2009) Understanding VIX §3
 *   - Risk-off rotation via SPY/TLT: industry convention (Tier 3 source —
 *     no peer-reviewed analogue; flagged in SPEC §6)
 */

import {
  CLASSIFIER_VERSION as PHASE1_V2_VERSION,
  HYG_SPY_DIVERGENCE_LOOKBACK,
  HYG_SPY_DIVERGENCE_LOOKBACK_AUDIT,
  SPY_NEAR_HIGH_LOOKBACK,
  ROLLING_UNION_DAYS,
  ORANGE_THRESHOLD_TODAY,
  INPUTS_MISSING_VIX,
  INPUTS_MISSING_VIX3M,
  INPUTS_MISSING_HYG,
  INPUTS_MISSING_SPY,
  INPUTS_MISSING_BREADTH,
  INPUTS_MISSING_SPY_WARMUP,
  type Regime,
} from './macro_regime.js';

// Re-export shared constants so v3 callers don't have to import from both files.
export {
  HYG_SPY_DIVERGENCE_LOOKBACK,
  SPY_NEAR_HIGH_LOOKBACK,
  ROLLING_UNION_DAYS,
  ORANGE_THRESHOLD_TODAY,
  INPUTS_MISSING_VIX,
  INPUTS_MISSING_VIX3M,
  INPUTS_MISSING_HYG,
  INPUTS_MISSING_SPY,
  INPUTS_MISSING_BREADTH,
  INPUTS_MISSING_SPY_WARMUP,
};

/**
 * Active classifier_version label written into `quantlab.macro_regimes` by
 * the v3 backfill. Distinct from `macro_regime.CLASSIFIER_VERSION`
 * (`phase1_v2`) so both versions can coexist queryably during the ramp.
 */
export const CLASSIFIER_VERSION_V3 = 'phase1_v3';

// Sanity check: importing the v2 constant prevents a typo where someone
// forgets to bump v3 here. Used only by the test harness.
export const _PHASE1_V2_REFERENCE = PHASE1_V2_VERSION;

// ── Phase 1 v3 threshold constants ──────────────────────────────────────────

/** Diagnostic window for the `yield_curve_inversion_days_20d` counter —
 *  count of T10Y3M observations < 0 in the trailing N trading days
 *  (inclusive of today). NOT part of the firing logic; surfaced for
 *  operator + LLM context to disambiguate flash vs sustained inversion
 *  per ADR-041 §Resolved at Accept item 1. Window picked at 20 trading
 *  days (≈1 calendar month) to match the existing 20d-return window
 *  conventions in this file. */
export const YIELD_CURVE_INVERSION_DAYS_WINDOW = 20;

/** Credit stress floor: 20-trading-day return of HYG/LQD ratio below this
 *  threshold (decimal, e.g. -0.03 = 3% decline) fires `credit_stress`. */
export const CREDIT_STRESS_20D_RETURN_FLOOR = -0.03;

/** Risk-off rotation floor: SPY 20d return MINUS TLT 20d return below this
 *  threshold (decimal, e.g. -0.10 = SPY trails TLT by 10pp) fires
 *  `risk_off_rotation`. */
export const RISK_OFF_SPREAD_FLOOR = -0.10;

/** Put/call extreme-fear ceiling: CBOE ^CPC 5-day MA >= this fires
 *  `sentiment_extreme`. Whaley 2009 §3 — contrarian "fear at extremes."
 *
 *  Calibration history:
 *   - 1.15 (session 39): initial Tier 0 pick. Coincidentally well-calibrated.
 *   - 1.15 (session 78, this constant): EMPIRICALLY VALIDATED, unchanged.
 *     2003-10-17 → 2019-10-04 CBOE corpus (4,014 5d-MA rows; the free
 *     historical archive — 2019-present is gated behind CBOE DataShop).
 *     Empirical p95 of 5d MA = 1.1540; inside-toward-zero 2dp round =
 *     1.15. Whole-corpus fire rate 5.46%; per-regime stability [4.75%,
 *     6.73%] across pre-GFC / GFC / post-GFC / 2015-2019-calm.
 *     Diagnostic: `scripts/_diagnose_put_call_thresholds.ts`. */
export const PUT_CALL_FEAR_HIGH = 1.15;

/** Put/call extreme-complacency floor: CBOE ^CPC 5-day MA <= this also
 *  fires `sentiment_extreme`. Contrarian "complacency before storm" tail.
 *
 *  Calibration history:
 *   - 0.65 (session 39): initial Tier 0 pick. Empirically over-tight —
 *     fired only 0.17% (7 of 4,014 days) on 2003-2019 CBOE corpus,
 *     effectively dormant. Calibrated to bottom-1.7% tail, far below
 *     the design ~5% target that the symmetric `PUT_CALL_FEAR_HIGH`
 *     and the post-retune `VIX_TERM_COMPLACENCY_FLOOR` both sit at.
 *   - 0.77 (session 78, this constant): selected by quantile matching
 *     against the empirical put/call 5d-MA distribution on the
 *     2003-10-17 → 2019-10-04 CBOE corpus (p05 = 0.7620). 0.77 is the
 *     smallest two-decimal floor at or above p05 (inside-toward-zero
 *     2dp round), so firings genuinely sit in the bottom-5% complacency
 *     tail — that empirical 5% is the source of the prevalence target,
 *     NOT Whaley. Whole-corpus post-tune fire rate 6.23%; per-regime
 *     p05 range [0.711, 0.826] brackets 0.77, with the calm 2015-2019
 *     regime running tighter than corpus (consistent with Whaley §3:
 *     complacency floors should be relative to long-run norms, not the
 *     calm-cycle's own internal norm). Same methodology as session 40's
 *     `VIX_TERM_COMPLACENCY_FLOOR` retune. Diagnostic:
 *     `scripts/_diagnose_put_call_thresholds.ts`.
 *
 *  Operational caveat: gate (a) was closed in session 79 —
 *  `macro_regimes.put_call_value_5d_ma` is now populated for the
 *  2003-2019 CBOE archive window after the s79 `macro:backfill:v3` run
 *  joined CBOE into macro_regimes (see ADR-038 amendment v3 and the
 *  `ADR_038_BASELINE` re-pin). Live `sentiment_extreme` now fires off
 *  this constant for that historical window. Gate (b) — CBOE put/call
 *  2019-present via DataShop subscription — remains open; until that
 *  gate closes, post-2019 days fall through to the VIX/VIX3M arm alone,
 *  and a second backfill will extend live coverage once DataShop
 *  ingest is restored. */
export const PUT_CALL_COMPLACENCY_LOW = 0.77;

/** VIX/VIX3M complacency floor: ratio <= this means front-end vol is
 *  crushed relative to back-end (steep contango), the structural
 *  complement to `vix_term_inverted`. Companion firing path for
 *  `sentiment_extreme` when CBOE data is missing.
 *
 *  Calibration history:
 *   - 0.85 (session 39): initial guess. Empirically over-fired —
 *     25.77% of phase1_v3 days fired `sentiment_extreme` via this arm
 *     alone (CBOE empty). Whaley 2009 §3 motivates the "extreme tail"
 *     framing for `sentiment_extreme` but does not prescribe a specific
 *     prevalence target.
 *   - 0.80 (session 40, this constant): selected by quantile matching
 *     against the empirical `vix_term_ratio` distribution on the
 *     2008-01-01 → present phase1_v3 corpus (p05 = 0.7959). 0.80 is
 *     the smallest two-decimal floor at or above p05, so firings
 *     genuinely sit in the bottom-5% complacency tail — that empirical
 *     5% is the source of the prevalence target, NOT Whaley. Observed
 *     post-tune prevalence is 5.98%, sanity-checked by re-backfill.
 *     ADR-037 fixture floors (2008 GFC >=5, 2011 EU >=1, 2020 COVID
 *     >=1) all preserved; 2014 calm 6 reds → 5 reds (still well under
 *     the <=10 ceiling). Diagnostic + sweep:
 *     `scripts/_diagnose_vix_term_complacency_floor.ts`.
 *
 *  Watch-out: below ~0.78 the arm goes effectively dormant (2.25% at
 *  0.78, 0.26% at 0.75). At ~0.70 it never fires — at which point the
 *  fail-soft "CBOE absent" branch of `sentiment_extreme` is dead and
 *  the category becomes a CBOE-only signal. */
export const VIX_TERM_COMPLACENCY_FLOOR = 0.80;

/** Window length for HYG/LQD ratio return + SPY/TLT spread. Same as the
 *  existing HYG/SPY divergence window for engine consistency. */
export const CREDIT_AND_ROTATION_LOOKBACK = HYG_SPY_DIVERGENCE_LOOKBACK;

// ── inputs_missing extension ────────────────────────────────────────────────

/** Bit 6: T10Y3M missing on this date (FRED). Replaces the prior
 *  T10Y2Y bit per ADR-041 — same numeric value (64) preserved so any
 *  historical-row decode of pre-ADR-041 inputs_missing snapshots still
 *  surfaces as "yield-curve input absent" (the bit semantic is the same
 *  even though the underlying FRED series changed). */
export const INPUTS_MISSING_T10Y3M = 1 << 6;       // 64
/** Bit 7: LQD close missing on this date. */
export const INPUTS_MISSING_LQD = 1 << 7;          // 128
/** Bit 8: TLT close missing on this date. */
export const INPUTS_MISSING_TLT = 1 << 8;          // 256
/** Bit 9: CBOE put/call missing on this date (fall back to VIX/VIX3M alone). */
export const INPUTS_MISSING_PUT_CALL = 1 << 9;     // 512

// ── Types ───────────────────────────────────────────────────────────────────

export interface PriorDayFiresV3 {
  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;
  /** Dormant under null Phase 2 θ; included for forward-compat with Phase 2. */
  realized_stress?: 0 | 1;
  yield_curve_inverted: 0 | 1;
  credit_stress: 0 | 1;
  risk_off_rotation: 0 | 1;
  sentiment_extreme: 0 | 1;
}

export interface ClassifierInputV3 {
  /** ISO date string, YYYY-MM-DD. */
  trade_date: string;

  // ── Shared with phase1_v2 ────────────────────────────────────────────
  vix_close: number | null;
  vix3m_close: number | null;
  hyg_history: (number | null)[];
  spy_history: (number | null)[];
  /** Carried for backward-compat / dashboard display only. NOT counted in
   *  v3 categories — that's the entire point of the v3 migration. */
  pct_above_50dma: number | null;
  pct_above_50dma_source: string;

  // ── New for phase1_v3 ────────────────────────────────────────────────
  /** T10Y3M values, oldest first; today is `length-1`. The firing logic
   *  reads only today's value (`length-1`) per ADR-041 §2/§5 (single-day
   *  fire, no persistence). The full window is consumed by the
   *  diagnostic `yield_curve_inversion_days_20d` counter — loader should
   *  supply ≥ YIELD_CURVE_INVERSION_DAYS_WINDOW values so the counter is
   *  not truncated. */
  t10y3m_history: (number | null)[];
  /** LQD closes, oldest first; today is `length-1`. Aligned with
   *  `hyg_history` by date in the loader. */
  lqd_history: (number | null)[];
  /** TLT closes, oldest first; today is `length-1`. Aligned with
   *  `spy_history` by date in the loader. */
  tlt_history: (number | null)[];
  /** CBOE ^CPC 5-day moving average for today. Pre-computed by the
   *  loader so the pure classifier doesn't have to track a put/call
   *  history. Null if CBOE ingest is missing — sentiment_extreme falls
   *  back to the VIX/VIX3M complacency path alone. */
  put_call_value_5d_ma: number | null;

  /** Per-category fire flags from up to the previous 4 trading days,
   *  oldest first. Width matches `ROLLING_UNION_DAYS - 1 = 4`. */
  prior_days_fires: PriorDayFiresV3[];
}

export interface MacroRegimeRowV3 {
  trade_date: string;
  classifier_version: string;

  // ── Shared with phase1_v2 row shape ──────────────────────────────────
  vix_close: number | null;
  vix3m_close: number | null;
  hyg_close: number | null;
  spy_close: number | null;
  pct_above_50dma: number | null;
  pct_above_50dma_source: string;

  vix_term_ratio: number | null;
  hyg_20d_return: number | null;
  spy_20d_return: number | null;
  hyg_10d_return: number | null;
  spy_10d_return: number | null;
  spy_252d_high: number | null;
  spy_drawdown_from_1y_high: number | null;

  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;
  hyg_spy_divergence_10d: 0 | 1;
  /** Dropped from v3 category count; still computed for backward compat. */
  breadth_narrow: 0 | 1;
  /** Dormant under null Phase 2 θ. Reads 0 under v3 just as under v2. */
  realized_stress: 0 | 1;

  // ── New for phase1_v3 ────────────────────────────────────────────────
  /** Today's T10Y3M observation (the firing input under ADR-041). The
   *  database column is still named `yield_curve_value`; the underlying
   *  FRED series changed from T10Y2Y to T10Y3M on the ADR-041 acceptance
   *  cut. Pre-ADR-041 rows in this column carry T10Y2Y values — see
   *  `clickhouse.ts` migration notes + ADR-041 §Consequences. */
  yield_curve_value: number | null;
  /** Diagnostic counter, NOT part of the firing logic. Count of T10Y3M
   *  observations < 0 in the trailing `YIELD_CURVE_INVERSION_DAYS_WINDOW`
   *  trading days (inclusive of today). Null when the loader supplied
   *  fewer than the window's worth of non-null values. Surfaced under
   *  ADR-041 §Resolved at Accept item 1 to give the operator + LLM the
   *  "flash vs sustained" distinction at-a-glance without inserting a
   *  tuning knob into the firing rule. */
  yield_curve_inversion_days_20d: number | null;
  hyg_lqd_ratio_20d_return: number | null;
  spy_minus_tlt_20d_return: number | null;
  put_call_value_5d_ma: number | null;
  vix_term_complacency: 0 | 1;
  yield_curve_inverted: 0 | 1;
  credit_stress: 0 | 1;
  risk_off_rotation: 0 | 1;
  sentiment_extreme: 0 | 1;

  inputs_missing: number;

  signals_firing: number;
  categories_firing: number;
  categories_firing_5d: number;
  regime: Regime;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function nthFromLast(arr: (number | null)[], n: number): number | null {
  if (arr.length <= n) return null;
  const v = arr[arr.length - 1 - n];
  return v == null ? null : v;
}

function trailingReturn(arr: (number | null)[], n: number): number | null {
  const today = nthFromLast(arr, 0);
  const past = nthFromLast(arr, n);
  if (today == null || past == null || past === 0) return null;
  return today / past - 1;
}

function trailingMax(arr: (number | null)[], n: number): number | null {
  if (arr.length < n) return null;
  let best: number | null = null;
  for (let i = arr.length - n; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

/**
 * Compute the 20-day return of a date-aligned ratio of two series.
 *
 * `numer_history` and `denom_history` MUST be aligned by date (same length,
 * each index a corresponding trading day). The loader is responsible for
 * the alignment; here we only require equal length.
 *
 * Returns null on any of: length mismatch, length < n+1, missing endpoint
 * value, or zero denominator at either endpoint (which would otherwise
 * yield Infinity/NaN).
 */
export function ratio20dReturn(
  numer_history: (number | null)[],
  denom_history: (number | null)[],
  n: number,
): number | null {
  if (numer_history.length !== denom_history.length) return null;
  const len = numer_history.length;
  if (len < n + 1) return null;

  const today_num = numer_history[len - 1];
  const today_den = denom_history[len - 1];
  const past_num = numer_history[len - 1 - n];
  const past_den = denom_history[len - 1 - n];

  if (
    today_num == null || today_den == null ||
    past_num == null || past_den == null ||
    today_den === 0 || past_den === 0
  ) {
    return null;
  }
  const today_ratio = today_num / today_den;
  const past_ratio = past_num / past_den;
  if (past_ratio === 0) return null;
  return today_ratio / past_ratio - 1;
}

/**
 * Yield-curve inversion check per ADR-041 (Accepted 2026-05-19).
 *
 * Fires (returns 1) iff today's T10Y3M observation is strictly < 0.
 * Returns 0 on >= 0, null, or empty history. No persistence requirement
 * per ADR-041 §Resolved at Accept item 1 — the "flash vs sustained"
 * distinction is surfaced separately via `computeInversionDays20d`.
 *
 * Strict `< 0` boundary per ADR-041 §Resolved at Accept item 2:
 *  - 0.00 → 0 (not inverted)
 *  - +0.01 → 0
 *  - -0.01 → 1 (inverted)
 *  - null/absent → 0
 *
 * Canon: Estrella-Mishkin 1998 §3 (probit framework treats sign-change
 * as the inflection); FRED publishes T10Y3M to 2-decimal precision so
 * basis-point measurement noise is below the canon's threshold of
 * concern.
 */
export function checkYieldCurveInverted(
  t10y3m_history: (number | null)[],
): 0 | 1 {
  if (t10y3m_history.length === 0) return 0;
  const today = t10y3m_history[t10y3m_history.length - 1];
  return today != null && today < 0 ? 1 : 0;
}

/**
 * Diagnostic counter: how many of the trailing
 * `YIELD_CURVE_INVERSION_DAYS_WINDOW` T10Y3M observations were strictly
 * < 0 (inclusive of today). NOT part of the firing logic; surfaced for
 * operator + LLM context per ADR-041 §Resolved at Accept item 1.
 *
 * Returns null when the history has fewer non-null values than the
 * window length — the count would be misleading on a truncated window.
 * Null entries inside an otherwise-full window are treated as "not
 * inverted" (they don't increment the counter) since FRED's
 * business-day calendar produces legitimate nulls on weekends/holidays
 * the loader passes through.
 */
export function computeInversionDays20d(
  t10y3m_history: (number | null)[],
  window: number = YIELD_CURVE_INVERSION_DAYS_WINDOW,
): number | null {
  if (t10y3m_history.length < window) return null;
  const tail = t10y3m_history.slice(t10y3m_history.length - window);
  // Reject if the window is mostly nulls — the counter would understate
  // sustained inversion. Require ≥ window non-null values; FRED business-
  // day cadence means ~20 trading days has ≥20 non-null values when the
  // loader supplies a sufficient prefix.
  let nonNull = 0;
  let inverted = 0;
  for (const v of tail) {
    if (v == null) continue;
    nonNull++;
    if (v < 0) inverted++;
  }
  if (nonNull < window) return null;
  return inverted;
}

/**
 * Sentiment-extreme fire logic (dual-source OR per SPEC §2.1).
 *
 * Fires if EITHER:
 *  - CBOE ^CPC 5d MA >= PUT_CALL_FEAR_HIGH (extreme fear), OR
 *  - CBOE ^CPC 5d MA <= PUT_CALL_COMPLACENCY_LOW (extreme complacency), OR
 *  - vix_term_ratio is non-null and <= VIX_TERM_COMPLACENCY_FLOOR.
 *
 * If both data sources are absent, returns 0 (cannot determine).
 */
export function checkSentimentExtreme(
  put_call_5d_ma: number | null,
  vix_term_ratio: number | null,
): 0 | 1 {
  const put_call_fires =
    put_call_5d_ma !== null &&
    (put_call_5d_ma >= PUT_CALL_FEAR_HIGH || put_call_5d_ma <= PUT_CALL_COMPLACENCY_LOW);
  const vix_term_fires =
    vix_term_ratio !== null && vix_term_ratio <= VIX_TERM_COMPLACENCY_FLOOR;
  return put_call_fires || vix_term_fires ? 1 : 0;
}

// ── Pure classifier (v3) ────────────────────────────────────────────────────

/**
 * Classify one trading day under phase1_v3. NULL-input semantics mirror
 * phase1_v2: a NULL input cannot fire its category and is recorded in
 * `inputs_missing`.
 *
 * Engine semantics (categories_firing / categories_firing_5d / regime) are
 * identical to v2 — only the input category set widens. RED rule
 * `categories_firing_5d >= 4` is the SPEC §2.3 lock.
 */
export function classifyMacroRegimeV3(input: ClassifierInputV3): MacroRegimeRowV3 {
  const today_hyg = nthFromLast(input.hyg_history, 0);
  const today_spy = nthFromLast(input.spy_history, 0);

  let inputs_missing = 0;
  if (input.vix_close == null) inputs_missing |= INPUTS_MISSING_VIX;
  if (input.vix3m_close == null) inputs_missing |= INPUTS_MISSING_VIX3M;
  if (today_hyg == null) inputs_missing |= INPUTS_MISSING_HYG;
  if (today_spy == null) inputs_missing |= INPUTS_MISSING_SPY;
  if (input.pct_above_50dma == null) inputs_missing |= INPUTS_MISSING_BREADTH;
  if (input.spy_history.length < SPY_NEAR_HIGH_LOOKBACK) {
    inputs_missing |= INPUTS_MISSING_SPY_WARMUP;
  }
  if (nthFromLast(input.t10y3m_history, 0) == null) inputs_missing |= INPUTS_MISSING_T10Y3M;
  if (nthFromLast(input.lqd_history, 0) == null) inputs_missing |= INPUTS_MISSING_LQD;
  if (nthFromLast(input.tlt_history, 0) == null) inputs_missing |= INPUTS_MISSING_TLT;
  if (input.put_call_value_5d_ma == null) inputs_missing |= INPUTS_MISSING_PUT_CALL;

  // ── Shared with v2 ───────────────────────────────────────────────────
  const vix_term_ratio =
    input.vix_close != null && input.vix3m_close != null && input.vix3m_close !== 0
      ? input.vix_close / input.vix3m_close
      : null;
  const vix_term_inverted: 0 | 1 =
    vix_term_ratio != null && vix_term_ratio > 1.0 ? 1 : 0;

  // VIX/VIX3M complacency is the structural mirror of vix_term_inverted.
  // Note: NOT a counted category by itself; folded into sentiment_extreme.
  const vix_term_complacency: 0 | 1 =
    vix_term_ratio != null && vix_term_ratio <= VIX_TERM_COMPLACENCY_FLOOR ? 1 : 0;

  const hyg_20d_return = trailingReturn(input.hyg_history, HYG_SPY_DIVERGENCE_LOOKBACK);
  const spy_20d_return = trailingReturn(input.spy_history, HYG_SPY_DIVERGENCE_LOOKBACK);
  const hyg_10d_return = trailingReturn(input.hyg_history, HYG_SPY_DIVERGENCE_LOOKBACK_AUDIT);
  const spy_10d_return = trailingReturn(input.spy_history, HYG_SPY_DIVERGENCE_LOOKBACK_AUDIT);

  const hyg_spy_divergence: 0 | 1 =
    hyg_20d_return != null && spy_20d_return != null &&
    hyg_20d_return < 0 && spy_20d_return > 0
      ? 1 : 0;
  const hyg_spy_divergence_10d: 0 | 1 =
    hyg_10d_return != null && spy_10d_return != null &&
    hyg_10d_return < 0 && spy_10d_return > 0
      ? 1 : 0;

  const spy_252d_high = trailingMax(input.spy_history, SPY_NEAR_HIGH_LOOKBACK);
  // breadth_narrow is preserved for backward compat (written to CH for
  // dashboard backward-compat) but NOT counted in v3 categories.
  const spy_at_or_near_high =
    today_spy != null && spy_252d_high != null
      ? today_spy >= 0.95 * spy_252d_high
      : false;
  const breadth_narrow: 0 | 1 =
    input.pct_above_50dma != null &&
    input.pct_above_50dma < 50 &&
    spy_at_or_near_high
      ? 1 : 0;

  const spy_drawdown_from_1y_high =
    today_spy != null && spy_252d_high != null && spy_252d_high > 0
      ? today_spy / spy_252d_high - 1
      : null;
  // realized_stress is dormant under phase1_v3 (Phase 2 θ remains null);
  // contributes 0 to categories_firing. Phase 2 commitment is kept
  // structurally separate so v3 doesn't accidentally bundle a stress θ pick.
  const realized_stress: 0 | 1 = 0;

  // ── New v3 categories ────────────────────────────────────────────────
  const t10y3m_today = nthFromLast(input.t10y3m_history, 0);
  const yield_curve_value = t10y3m_today;
  const yield_curve_inverted = checkYieldCurveInverted(input.t10y3m_history);
  const yield_curve_inversion_days_20d = computeInversionDays20d(input.t10y3m_history);

  const hyg_lqd_ratio_20d_return = ratio20dReturn(
    input.hyg_history,
    input.lqd_history,
    CREDIT_AND_ROTATION_LOOKBACK,
  );
  const credit_stress: 0 | 1 =
    hyg_lqd_ratio_20d_return !== null &&
    hyg_lqd_ratio_20d_return < CREDIT_STRESS_20D_RETURN_FLOOR
      ? 1 : 0;

  const tlt_20d_return = trailingReturn(input.tlt_history, CREDIT_AND_ROTATION_LOOKBACK);
  const spy_minus_tlt_20d_return =
    spy_20d_return !== null && tlt_20d_return !== null
      ? spy_20d_return - tlt_20d_return
      : null;
  const risk_off_rotation: 0 | 1 =
    spy_minus_tlt_20d_return !== null &&
    spy_minus_tlt_20d_return < RISK_OFF_SPREAD_FLOOR
      ? 1 : 0;

  const sentiment_extreme = checkSentimentExtreme(
    input.put_call_value_5d_ma,
    vix_term_ratio,
  );

  // ── Composite (v3 — 6 active categories) ─────────────────────────────
  const signals_firing =
    vix_term_inverted + hyg_spy_divergence + realized_stress +
    yield_curve_inverted + credit_stress + risk_off_rotation + sentiment_extreme;
  const categories_firing = signals_firing; // 1:1 mapping per SPEC §2.3.

  const today_fires: PriorDayFiresV3 = {
    vix_term_inverted,
    hyg_spy_divergence,
    realized_stress,
    yield_curve_inverted,
    credit_stress,
    risk_off_rotation,
    sentiment_extreme,
  };
  const window: PriorDayFiresV3[] = [
    ...input.prior_days_fires,
    today_fires,
  ].slice(-ROLLING_UNION_DAYS);

  let union_vix = 0, union_credit_v2 = 0, union_stress = 0;
  let union_yc = 0, union_credit_v3 = 0, union_rotation = 0, union_sentiment = 0;
  for (const d of window) {
    if (d.vix_term_inverted) union_vix = 1;
    if (d.hyg_spy_divergence) union_credit_v2 = 1;
    if ((d.realized_stress ?? 0) === 1) union_stress = 1;
    if (d.yield_curve_inverted) union_yc = 1;
    if (d.credit_stress) union_credit_v3 = 1;
    if (d.risk_off_rotation) union_rotation = 1;
    if (d.sentiment_extreme) union_sentiment = 1;
  }
  const categories_firing_5d =
    union_vix + union_credit_v2 + union_stress +
    union_yc + union_credit_v3 + union_rotation + union_sentiment;

  // RED rule per SPEC §2.3: >=4 of the (up to) 7 categories firing in the
  // 5-day window. Engine semantics (orange/yellow/green) match v2 verbatim.
  let regime: Regime;
  if (categories_firing_5d >= 4) regime = 'red';
  else if (categories_firing >= ORANGE_THRESHOLD_TODAY) regime = 'orange';
  else if (categories_firing === 1) regime = 'yellow';
  else regime = 'green';

  return {
    trade_date: input.trade_date,
    classifier_version: CLASSIFIER_VERSION_V3,

    vix_close: input.vix_close,
    vix3m_close: input.vix3m_close,
    hyg_close: today_hyg,
    spy_close: today_spy,
    pct_above_50dma: input.pct_above_50dma,
    pct_above_50dma_source: input.pct_above_50dma_source,

    vix_term_ratio,
    hyg_20d_return,
    spy_20d_return,
    hyg_10d_return,
    spy_10d_return,
    spy_252d_high,
    spy_drawdown_from_1y_high,

    vix_term_inverted,
    hyg_spy_divergence,
    hyg_spy_divergence_10d,
    breadth_narrow,
    realized_stress,

    yield_curve_value,
    yield_curve_inversion_days_20d,
    hyg_lqd_ratio_20d_return,
    spy_minus_tlt_20d_return,
    put_call_value_5d_ma: input.put_call_value_5d_ma,
    vix_term_complacency,
    yield_curve_inverted,
    credit_stress,
    risk_off_rotation,
    sentiment_extreme,

    inputs_missing,

    signals_firing,
    categories_firing,
    categories_firing_5d,
    regime,
  };
}

export function rowToPriorDayFiresV3(row: MacroRegimeRowV3): PriorDayFiresV3 {
  return {
    vix_term_inverted: row.vix_term_inverted,
    hyg_spy_divergence: row.hyg_spy_divergence,
    realized_stress: row.realized_stress,
    yield_curve_inverted: row.yield_curve_inverted,
    credit_stress: row.credit_stress,
    risk_off_rotation: row.risk_off_rotation,
    sentiment_extreme: row.sentiment_extreme,
  };
}

// ── Bundle-driven classifier ────────────────────────────────────────────────

export interface RegimeDataBundleV3 {
  /** Sorted ASC list of trading dates to classify. */
  classifyDates: string[];

  /** SPY/HYG dates + close maps. Each `*Dates` array is sorted ASC and
   *  includes the full prefix needed for the 252d SPY high + 21d HYG
   *  return. */
  spyDates: string[];
  spyByDate: Map<string, number>;
  hygDates: string[];
  hygByDate: Map<string, number>;

  vixByDate: Map<string, number>;
  vix3mByDate: Map<string, number>;
  breadthByDate: Map<string, { pct: number; source: string }>;

  /** LQD dates + close map; aligned with hygDates for the HYG/LQD ratio. */
  lqdDates: string[];
  lqdByDate: Map<string, number>;
  /** TLT dates + close map; aligned with spyDates for the SPY/TLT spread. */
  tltDates: string[];
  tltByDate: Map<string, number>;

  /** T10Y3M observation dates + value map (FRED). Sorted ASC. Replaces
   *  the prior T10Y2Y bundle field per ADR-041. */
  t10y3mDates: string[];
  t10y3mByDate: Map<string, number>;

  /** CBOE ^CPC 5-day MA by date. Loader is responsible for the rolling
   *  average (date-aligned with the CBOE calendar; missing days fall
   *  through to put_call_value_5d_ma = null). */
  putCall5dMaByDate: Map<string, number>;
}

function alignByDate<T>(
  classifyDate: string,
  refDates: string[],
  refIdx: Map<string, number>,
  byDate: Map<string, T>,
  lookback: number,
): (T | null)[] {
  const idx = refIdx.get(classifyDate);
  if (idx == null) return [];
  return refDates
    .slice(Math.max(0, idx - lookback), idx + 1)
    .map(d => byDate.get(d) ?? null);
}

export function classifyDateRangeFromBundleV3(
  bundle: RegimeDataBundleV3,
): MacroRegimeRowV3[] {
  const spyIdx = new Map<string, number>();
  for (let i = 0; i < bundle.spyDates.length; i++) spyIdx.set(bundle.spyDates[i], i);
  const hygIdx = new Map<string, number>();
  for (let i = 0; i < bundle.hygDates.length; i++) hygIdx.set(bundle.hygDates[i], i);
  const t10y3mIdx = new Map<string, number>();
  for (let i = 0; i < bundle.t10y3mDates.length; i++) {
    t10y3mIdx.set(bundle.t10y3mDates[i], i);
  }
  void t10y3mIdx; // bundle is consumed via byDate map below; idx kept for parity with other series

  const out: MacroRegimeRowV3[] = [];
  let priors: PriorDayFiresV3[] = [];

  for (const d of bundle.classifyDates) {
    // SPY history: 252d trailing window for the 1Y-high gate.
    const spy_history = alignByDate(
      d, bundle.spyDates, spyIdx, bundle.spyByDate, SPY_NEAR_HIGH_LOOKBACK - 1,
    );
    // TLT aligned to SPY's calendar so the 20d returns share the same
    // trading-day denominator. (TLT trades on the same NYSE calendar.)
    const tlt_history = alignByDate(
      d, bundle.spyDates, spyIdx, bundle.tltByDate, CREDIT_AND_ROTATION_LOOKBACK,
    );

    const hyg_history = alignByDate(
      d, bundle.hygDates, hygIdx, bundle.hygByDate, HYG_SPY_DIVERGENCE_LOOKBACK,
    );
    const lqd_history = alignByDate(
      d, bundle.hygDates, hygIdx, bundle.lqdByDate, HYG_SPY_DIVERGENCE_LOOKBACK,
    );

    // T10Y3M: FRED publishes only on business days; missing dates → null
    // entries. The firing logic reads only today's value (no persistence
    // per ADR-041) but `computeInversionDays20d` consumes the trailing
    // YIELD_CURVE_INVERSION_DAYS_WINDOW values aligned to the SPY
    // (NYSE) calendar. Loader supplies that full window so the counter
    // is not silently truncated.
    const t10y3m_history: (number | null)[] = [];
    const sIdx = spyIdx.get(d);
    if (sIdx != null) {
      const startIdx = Math.max(0, sIdx - (YIELD_CURVE_INVERSION_DAYS_WINDOW - 1));
      for (let i = startIdx; i <= sIdx; i++) {
        const dt = bundle.spyDates[i];
        const v = bundle.t10y3mByDate.get(dt);
        t10y3m_history.push(v == null ? null : v);
      }
    }

    const breadth = bundle.breadthByDate.get(d);
    const putCallMa = bundle.putCall5dMaByDate.get(d);

    const input: ClassifierInputV3 = {
      trade_date: d,
      vix_close: bundle.vixByDate.get(d) ?? null,
      vix3m_close: bundle.vix3mByDate.get(d) ?? null,
      hyg_history,
      spy_history,
      pct_above_50dma: breadth?.pct ?? null,
      pct_above_50dma_source: breadth?.source ?? '',
      t10y3m_history,
      lqd_history,
      tlt_history,
      put_call_value_5d_ma: putCallMa == null ? null : putCallMa,
      prior_days_fires: priors,
    };
    const row = classifyMacroRegimeV3(input);
    out.push(row);
    priors = [...priors, rowToPriorDayFiresV3(row)].slice(-(ROLLING_UNION_DAYS - 1));
  }

  return out;
}

// ── ClickHouse-backed I/O wrapper ───────────────────────────────────────────

async function chBindings() {
  const mod = await import('./clickhouse.js');
  return { getClickHouse: mod.getClickHouse };
}

const SPY_ADDR = 'SPY_USD';
const HYG_ADDR = 'HYG_USD';
const VIX_ADDR = 'VIX_USD';
const VIX3M_ADDR = 'VIX3M_USD';
const LQD_ADDR = 'LQD_USD';
const TLT_ADDR = 'TLT_USD';
const REGIME_SOURCE = 'yfinance_regime';

const SPY_PREFIX_DAYS = 380;
const HYG_PREFIX_DAYS = 40;
/** T10Y3M is published on every business day. Pad enough wall-clock
 *  days so the 20-trading-day diagnostic counter
 *  (`yield_curve_inversion_days_20d`) is fully warmed up from the very
 *  first classify date — 20 trading days fits inside ~30 wall-clock
 *  days even with two weekends + a holiday. */
const T10Y3M_PREFIX_DAYS = 35;
/** CBOE put/call 5d MA — need 5 trading days of prefix. Generous wall-clock
 *  buffer covers weekends + holidays. */
const PUTCALL_PREFIX_DAYS = 12;

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface CandleQueryRow { d: string; close: number | string }
interface BreadthQueryRow { d: string; source: string; pct: number | string }
interface FredQueryRow { d: string; value: number | string }
interface CboeQueryRow { d: string; value: number | string }

async function loadCandleSeries(
  ch: ReturnType<Awaited<ReturnType<typeof chBindings>>['getClickHouse']>,
  tokenAddr: string,
  fromDate: string,
  toDate: string,
): Promise<{ dates: string[]; byDate: Map<string, number> }> {
  const result = await ch.query({
    query: `
      SELECT toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles FINAL
      WHERE token_address = {addr:String}
        AND interval = '1d'
        AND source = {src:String}
        AND toDate(timestamp) >= toDate({fromD:String})
        AND toDate(timestamp) <= toDate({toD:String})
      ORDER BY timestamp ASC
    `,
    query_params: { addr: tokenAddr, src: REGIME_SOURCE, fromD: fromDate, toD: toDate },
    format: 'JSONEachRow',
  });
  const rows = await result.json<CandleQueryRow>();
  const dates: string[] = [];
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const c = Number(r.close);
    if (!Number.isFinite(c)) continue;
    if (!byDate.has(r.d)) dates.push(r.d);
    byDate.set(r.d, c);
  }
  return { dates, byDate };
}

async function loadBreadthSeries(
  ch: ReturnType<Awaited<ReturnType<typeof chBindings>>['getClickHouse']>,
  fromDate: string,
  toDate: string,
): Promise<Map<string, { pct: number; source: string }>> {
  const result = await ch.query({
    query: `
      SELECT toString(trade_date) AS d, source, pct_above_50dma AS pct
      FROM quantlab.macro_breadth FINAL
      WHERE trade_date >= toDate({fromD:String})
        AND trade_date <= toDate({toD:String})
      ORDER BY trade_date ASC, (source = 'stooq_a50r') DESC
    `,
    query_params: { fromD: fromDate, toD: toDate },
    format: 'JSONEachRow',
  });
  const rows = await result.json<BreadthQueryRow>();
  const out = new Map<string, { pct: number; source: string }>();
  for (const r of rows) {
    if (out.has(r.d)) continue;
    const pct = Number(r.pct);
    if (!Number.isFinite(pct)) continue;
    out.set(r.d, { pct, source: String(r.source) });
  }
  return out;
}

async function loadFredSeries(
  ch: ReturnType<Awaited<ReturnType<typeof chBindings>>['getClickHouse']>,
  seriesId: string,
  fromDate: string,
  toDate: string,
): Promise<{ dates: string[]; byDate: Map<string, number> }> {
  const result = await ch.query({
    query: `
      SELECT toString(observation_date) AS d, value
      FROM quantlab.macro_indicators_fred FINAL
      WHERE series_id = {sid:String}
        AND observation_date >= toDate({fromD:String})
        AND observation_date <= toDate({toD:String})
      ORDER BY observation_date ASC
    `,
    query_params: { sid: seriesId, fromD: fromDate, toD: toDate },
    format: 'JSONEachRow',
  });
  const rows = await result.json<FredQueryRow>();
  const dates: string[] = [];
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    if (!byDate.has(r.d)) dates.push(r.d);
    byDate.set(r.d, v);
  }
  return { dates, byDate };
}

async function loadCboeSeriesAsMa(
  ch: ReturnType<Awaited<ReturnType<typeof chBindings>>['getClickHouse']>,
  seriesId: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, number>> {
  // Pull raw values then compute the 5-day trailing MA in app code.
  // ClickHouse's window-function path would require an explicit calendar
  // join; doing the MA in TS keeps the loader self-contained.
  const result = await ch.query({
    query: `
      SELECT toString(observation_date) AS d, value
      FROM quantlab.macro_indicators_cboe FINAL
      WHERE series_id = {sid:String}
        AND observation_date >= toDate({fromD:String})
        AND observation_date <= toDate({toD:String})
      ORDER BY observation_date ASC
    `,
    query_params: { sid: seriesId, fromD: fromDate, toD: toDate },
    format: 'JSONEachRow',
  });
  const rows = await result.json<CboeQueryRow>();
  const dates: string[] = [];
  const values: number[] = [];
  for (const r of rows) {
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    dates.push(r.d);
    values.push(v);
  }
  const out = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) {
    if (i < 4) continue; // need 5 entries for the MA; skip warmup
    let sum = 0;
    for (let j = i - 4; j <= i; j++) sum += values[j];
    out.set(dates[i], sum / 5);
  }
  return out;
}

/**
 * Backfill `quantlab.macro_regimes` under `classifier_version='phase1_v3'`.
 * Reads SPY/HYG/VIX/VIX3M/LQD/TLT candles, breadth, T10Y3M (FRED, per
 * ADR-041; T10Y2Y is no longer consumed by this classifier), and
 * CBOE put/call out of CH, classifies every SPY trading day in
 * [startDate, endDate], writes results back. Idempotent.
 *
 * Coexists with `phase1_v2` rows (ADR-037 quarantine) — different
 * `classifier_version` → different sort key → no clobbering.
 */
export async function backfillMacroRegimesV3(args: {
  startDate: string;
  endDate: string;
  dryRun?: boolean;
}): Promise<{ rowsWritten: number; firstDate: string; lastDate: string }> {
  const { getClickHouse } = await chBindings();
  const ch = getClickHouse();

  const spyFrom = isoMinusDays(args.startDate, SPY_PREFIX_DAYS);
  const hygFrom = isoMinusDays(args.startDate, HYG_PREFIX_DAYS);
  const t10y3mFrom = isoMinusDays(args.startDate, T10Y3M_PREFIX_DAYS);
  const cboeFrom = isoMinusDays(args.startDate, PUTCALL_PREFIX_DAYS);

  const [spy, hyg, vix, vix3m, lqd, tlt, breadth, t10y3m, putCallMa] = await Promise.all([
    loadCandleSeries(ch, SPY_ADDR, spyFrom, args.endDate),
    loadCandleSeries(ch, HYG_ADDR, hygFrom, args.endDate),
    loadCandleSeries(ch, VIX_ADDR, args.startDate, args.endDate),
    loadCandleSeries(ch, VIX3M_ADDR, args.startDate, args.endDate),
    loadCandleSeries(ch, LQD_ADDR, hygFrom, args.endDate),
    loadCandleSeries(ch, TLT_ADDR, spyFrom, args.endDate),
    loadBreadthSeries(ch, args.startDate, args.endDate),
    loadFredSeries(ch, 'T10Y3M', t10y3mFrom, args.endDate),
    loadCboeSeriesAsMa(ch, 'CPC', cboeFrom, args.endDate),
  ]);

  const classifyDates = spy.dates.filter(d => d >= args.startDate && d <= args.endDate);

  const bundle: RegimeDataBundleV3 = {
    classifyDates,
    spyDates: spy.dates,
    spyByDate: spy.byDate,
    hygDates: hyg.dates,
    hygByDate: hyg.byDate,
    vixByDate: vix.byDate,
    vix3mByDate: vix3m.byDate,
    breadthByDate: breadth,
    lqdDates: lqd.dates,
    lqdByDate: lqd.byDate,
    tltDates: tlt.dates,
    tltByDate: tlt.byDate,
    t10y3mDates: t10y3m.dates,
    t10y3mByDate: t10y3m.byDate,
    putCall5dMaByDate: putCallMa,
  };
  const rows = classifyDateRangeFromBundleV3(bundle);

  if (!args.dryRun && rows.length > 0) {
    await ch.insert({
      table: 'quantlab.macro_regimes',
      values: rows.map(r => ({
        trade_date: r.trade_date,
        classifier_version: r.classifier_version,
        vix_close: r.vix_close,
        vix3m_close: r.vix3m_close,
        hyg_close: r.hyg_close,
        spy_close: r.spy_close,
        pct_above_50dma: r.pct_above_50dma,
        pct_above_50dma_source: r.pct_above_50dma_source,
        vix_term_ratio: r.vix_term_ratio,
        hyg_20d_return: r.hyg_20d_return,
        spy_20d_return: r.spy_20d_return,
        hyg_10d_return: r.hyg_10d_return,
        spy_10d_return: r.spy_10d_return,
        spy_252d_high: r.spy_252d_high,
        spy_drawdown_from_1y_high: r.spy_drawdown_from_1y_high,
        vix_term_inverted: r.vix_term_inverted,
        hyg_spy_divergence: r.hyg_spy_divergence,
        hyg_spy_divergence_10d: r.hyg_spy_divergence_10d,
        breadth_narrow: r.breadth_narrow,
        realized_stress: r.realized_stress,
        yield_curve_value: r.yield_curve_value,
        yield_curve_inversion_days_20d: r.yield_curve_inversion_days_20d,
        hyg_lqd_ratio_20d_return: r.hyg_lqd_ratio_20d_return,
        spy_minus_tlt_20d_return: r.spy_minus_tlt_20d_return,
        put_call_value_5d_ma: r.put_call_value_5d_ma,
        vix_term_complacency: r.vix_term_complacency,
        yield_curve_inverted: r.yield_curve_inverted,
        credit_stress: r.credit_stress,
        risk_off_rotation: r.risk_off_rotation,
        sentiment_extreme: r.sentiment_extreme,
        inputs_missing: r.inputs_missing,
        signals_firing: r.signals_firing,
        categories_firing: r.categories_firing,
        categories_firing_5d: r.categories_firing_5d,
        regime: r.regime,
      })),
      format: 'JSONEachRow',
    });
  }

  return {
    rowsWritten: rows.length,
    firstDate: rows.length > 0 ? rows[0].trade_date : '',
    lastDate: rows.length > 0 ? rows[rows.length - 1].trade_date : '',
  };
}

/**
 * Fetch the most recent phase1_v3 row at or before `asOfDate`.
 * Mirrors `fetchMacroRegime` in `macro_regime.ts` but typed to the v3 row.
 */
export async function fetchMacroRegimeV3(
  asOfDate: string,
): Promise<MacroRegimeRowV3 | null> {
  const { getClickHouse } = await chBindings();
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT *
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = {cv:String}
        AND trade_date <= toDate({d:String})
      ORDER BY trade_date DESC
      LIMIT 1
    `,
    query_params: { cv: CLASSIFIER_VERSION_V3, d: asOfDate },
    format: 'JSONEachRow',
  });
  const rows = await r.json<MacroRegimeRowV3>();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Daily one-shot — classify the most recent date for which all six v3
 * candle sources (VIX, VIX3M, HYG, SPY, LQD, TLT) have a close. Skips
 * silently (returns null) if any candle source is missing today's bar —
 * protects against the daemon firing before Yahoo's official close
 * lands (mirrors the v2 fail-soft from SPEC §6).
 *
 * FRED T10Y3M and CBOE ^CPC are NOT in the date-readiness check because
 * the classifier handles them as fail-soft inputs (yield_curve fails
 * suppress rather than firing; CBOE-dark arm of sentiment_extreme is
 * the operational norm post-2019-10-04). The six candle sources are
 * the hard prerequisites because they drive 4 of the 5 active categories
 * (or 5 of 6 when CBOE is dark — which it is today).
 *
 * Internal logic:
 * 1. Find the latest date `t` where all six tickers exist in
 *    `quantlab.candles` under `source='yfinance_regime'`.
 * 2. Reuse `backfillMacroRegimesV3({startDate: t, endDate: t})` so the
 *    full v3 pipeline (with 380-day SPY prefix, FRED/CBOE prefix
 *    windows, all the same plumbing) is exercised — no separate code
 *    path that could drift from the backfill.
 * 3. Return the resulting row via `fetchMacroRegimeV3(t)`.
 *
 * Writing a single row for today is safe with respect to
 * `ADR_038_BASELINE` (the test pins a literal constant, not a live
 * count). Re-running across the historical corpus is what would shift
 * the baseline; this single-row write only appends.
 */
export async function classifyLatestMacroRegimeV3(): Promise<MacroRegimeRowV3 | null> {
  const { getClickHouse } = await chBindings();
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(toDate(latest_t)) AS d
      FROM (
        SELECT min(latest_per_addr) AS latest_t FROM (
          SELECT max(timestamp) AS latest_per_addr
          FROM quantlab.candles
          WHERE token_address IN ({addrs:Array(String)})
            AND interval = '1d'
            AND source = {src:String}
          GROUP BY token_address
        )
      )
    `,
    query_params: {
      addrs: [SPY_ADDR, HYG_ADDR, VIX_ADDR, VIX3M_ADDR, LQD_ADDR, TLT_ADDR],
      src: REGIME_SOURCE,
    },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string | null }>();
  if (rows.length === 0 || !rows[0].d) return null;
  const t = rows[0].d;

  await backfillMacroRegimesV3({ startDate: t, endDate: t });
  return await fetchMacroRegimeV3(t);
}

/**
 * What could break this:
 *  - CBOE CSV URL drift: if `cboe_putcall_ingest.py` returns 0 rows because
 *    CBOE rotated the file, `put_call_value_5d_ma` will be null for every
 *    date and `sentiment_extreme` collapses to the VIX/VIX3M complacency
 *    path alone. That's an intended fail-soft, but the operator should
 *    check `INPUTS_MISSING_PUT_CALL` bit on a recent row to confirm the
 *    classifier is running degraded, not silently green.
 *  - FRED T10Y3M date alignment: FRED publishes on weekdays the bond
 *    market is open, which mostly but not always matches NYSE. Missing
 *    dates are aligned to the SPY (NYSE) calendar with null fallback;
 *    today's null suppresses the indicator (returns 0, sets the
 *    INPUTS_MISSING_T10Y3M bit), so single-day FRED gaps do NOT flip
 *    fire/no-fire. The trailing-20d diagnostic counter
 *    (`yield_curve_inversion_days_20d`) requires a full window of
 *    non-null values and returns null on truncated histories — that's
 *    surfaced via the column rather than a separate inputs_missing bit
 *    because the counter is purely diagnostic, not part of the firing
 *    logic.
 *  - Pre-ADR-041 historical rows (T10Y2Y) coexist with post-ADR-041
 *    rows (T10Y3M) in the same `yield_curve_value` column. A re-backfill
 *    rewrites the historical rows under the new T10Y3M source; until
 *    that runs, `quantlab.macro_regimes` carries a mix of T10Y2Y values
 *    (older trade_date) and T10Y3M values (newer trade_date) under the
 *    same column. Consumers that read this column historically should
 *    expect a step-change in semantic at the trade_date of the first
 *    classifier run post-ADR-041 — see HANDOFF for the re-backfill
 *    operator action.
 *  - HYG/LQD ratio length mismatch: ratio20dReturn returns null if the
 *    two histories aren't equal length. The bundle loader uses HYG's
 *    calendar for both (LQD trades on NYSE too), so mismatch should only
 *    happen if LQD is missing days that HYG has — then the helper falls
 *    through to null and credit_stress doesn't fire.
 *  - phase1_v3 row coexisting with phase1_v2 row at the same trade_date:
 *    ReplacingMergeTree keys by (trade_date, classifier_version) — they're
 *    distinct sort keys, so both rows persist independently. This is the
 *    bias-quarantine pattern carried forward from ADR-037 / phase2_v1.
 */
