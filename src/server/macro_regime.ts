/**
 * Track C / Component 1 — macro regime classifier (Phase 1 + Phase 2 plumbing).
 *
 * Pure-compute core: given the inputs for one trading day, return the
 * fully-populated `MacroRegimeRow` for that day. No I/O, no time, no
 * randomness — every threshold-edge case is a unit test on this entry
 * point. The I/O wrapper (`backfillMacroRegimes`) reads candles +
 * macro_breadth out of CH, builds the per-day input, calls this
 * function, and writes the result back to `quantlab.macro_regimes`.
 *
 * SPEC: `docs/specs/macro-regime-classifier-phase1.md` §2, §4.2 and
 * `docs/specs/macro-regime-classifier-phase2.md` §1, §2, §4.
 *
 * Sources:
 *   - VIX term inversion: source doc §2 + §16 row 1 (`vix/vix3m > 1.0`).
 *   - HYG/SPY divergence: source doc §3 (canonical 20-day window) + §16
 *     row 4 (10-day audit row); SPEC §2.2 reconciles the two.
 *   - Breadth narrow: source doc §4 + §16 row 6 (<50% above 50DMA at
 *     index highs); SPEC §2.3 locks 95%/252d as the "near highs" gate.
 *   - Realized stress (Phase 2): SPY drawdown from 1Y high; threshold θ
 *     selected by the procedure in Phase 2 SPEC §3 — see
 *     `_phase2_realized_stress_procedure.ts`.
 *   - Composite tiers: source doc §10; Phase 1 SPEC §2.4 + Phase 2
 *     SPEC §2.3 define the 5-day rolling-union semantics for `red`.
 */

/**
 * Phase 1 ramp history:
 *   - `phase1_v1` (session 24)   — pct_above_50dma NULL everywhere.
 *   - `phase1_v2` (session 25)   — constituent-computed breadth, documented
 *     survivorship bias per ADR-037; archived as the bias-quarantine
 *     reference but no longer the live classifier.
 *   - `phase1_v3` (session 39+)  — drops `breadth_narrow` and adds four
 *     free leading indicators (yield_curve_inverted, credit_stress,
 *     risk_off_rotation, sentiment_extreme). Survivorship-immune; built
 *     in `src/server/macro_regime_v3.ts` and emitted by
 *     `npm run macro:backfill:v3`. The v3 classifier is a separate module
 *     by design (ADR-037 quarantine — v2 logic stays byte-equal in this
 *     file so historical attribution remains queryable); flipping this
 *     constant just renames the *active* version label that dashboard /
 *     operator-brief consumers pin against, and the v2 classifier code
 *     in this file is now archive-only.
 *
 * Phase 2 plumbing remains valid under v3: the v3 classifier reuses the
 * same `realized_stress` category (dormant under null θ) and the same
 * `deriveRegime` engine semantics. `CLASSIFIER_VERSION` flips to
 * `'phase2_v1'` (a future move, not this ramp) only after the Phase 2
 * RESULT.md plugs the chosen θ.
 *
 * Per ADR-037 §5 A10 downstream-consumer fence: any code path that
 * feeds `phase1_v2` rows into a tuning loop, gating decision, or
 * kill-switch criterion violates the bias quarantine. `phase1_v3` is
 * **explicitly permitted** for tuning loops because the leading
 * indicators are survivorship-immune (yield curve + HY OAS are
 * macro-level series; SPY/TLT spread is index-level; sentiment is
 * nominal). The v2 fence remains in force for back-references to
 * `phase1_v2` rows still in `macro_regimes` / `bt_runs_regime`.
 */
export const CLASSIFIER_VERSION = 'phase1_v3';

/** Rolling window length for the divergence "clean trigger" (SPEC §2.2). */
export const HYG_SPY_DIVERGENCE_LOOKBACK = 20;
/** Audit-only divergence window. SPEC §2.2 keeps it for forward compat. */
export const HYG_SPY_DIVERGENCE_LOOKBACK_AUDIT = 10;
/** Rolling window for the "near 1Y high" gate. SPEC §2.3 locks 252. */
export const SPY_NEAR_HIGH_LOOKBACK = 252;
/** Fraction-of-1Y-high required for `breadth_narrow` to fire. SPEC §2.3. */
export const SPY_NEAR_HIGH_FRACTION = 0.95;
/** Breadth threshold below which breadth is "narrow." Source doc §4. */
export const BREADTH_NARROW_THRESHOLD = 50;
/** Tier rule — categories firing in the trailing 5 trading days for `red`. */
export const ROLLING_UNION_DAYS = 5;
/** Tier rule — categories firing today for `orange`. */
export const ORANGE_THRESHOLD_TODAY = 2;

/**
 * Phase 2 — `realized_stress` threshold (`θ`) on the SPY drawdown-from-1Y-high
 * indicator. Phase 2 SPEC §1.1 + §3.
 *
 * Initialized to `null` until the §3 procedure script
 * (`scripts/_phase2_realized_stress_procedure.ts`) runs and
 * `docs/phase2_procedure_artifacts/RESULT.md` declares the chosen θ
 * (one of `K = {-0.10, -0.12, -0.15, -0.18, -0.20}`, the locked
 * candidate set per Phase 2 SPEC §1.3). The `null` sentinel is
 * structural enforcement of the procedure-before-CH-write commit
 * ordering — see the write-guard at the top of `backfillMacroRegimes`.
 * Phase 2 SPEC §4.1 step 2 + §4.6 commit ordering (post-critic B4).
 *
 * Under `phase1_v2` the threshold is null → `realized_stress = 0` for
 * every row → the 4-category composite collapses to Phase 1's 3-category
 * rule. Tests that exercise the new code path pass an explicit override
 * via `ClassifierInput.realized_stress_threshold`.
 */
export const REALIZED_STRESS_THRESHOLD: number | null = null;

/**
 * Phase 2 — composite-rule selector for the 4-category red branch.
 * Phase 2 SPEC §2.3 — Option C (default): `categories_firing_5d ≥ 3 AND
 * (realized_stress OR breadth_narrow) fired in the 5d window`.
 * Plain-language equivalent (§2.3): "both of {vol, credit} fired in
 * window AND exactly one of {breadth_narrow, realized_stress} fired in
 * window."
 *
 * Initialized to `null` until §3 procedure picks the rule (defaults to
 * 'C' unless §2.4 co-fire histogram demands A or B). Same write-guard
 * as the threshold above. Under `null`, `deriveRegime` falls back to
 * Phase 1's "categories_firing_5d ≥ 3" rule — preserves Phase 1
 * semantics on `phase1_v2` rows verbatim.
 */
export const REALIZED_STRESS_BREADTH_RULE: 'A' | 'B' | 'C' | null = null;

/**
 * Phase 2 — swept-K cardinality for the realized_stress threshold
 * search (size of `K` declared in Phase 2 SPEC §1.3 = 5). Exported for
 * downstream Component 5+ consumers that compute Bailey-LdP DSR
 * haircuts on Sharpe ratios conditional on `classifier_version =
 * 'phase2_v1'` — see Phase 2 SPEC §3.9.
 *
 * A `regime == 'red'` filter on `phase2_v1` rows without DSR
 * haircutting against this K is an A10-fence violation.
 */
export const K_PHASE2_REALIZED_STRESS = 5;

export type Regime = 'green' | 'yellow' | 'orange' | 'red';

/** Bitmask flags for the `inputs_missing` audit column. SPEC §3.2. */
export const INPUTS_MISSING_VIX = 1 << 0;        // 1
export const INPUTS_MISSING_VIX3M = 1 << 1;      // 2
export const INPUTS_MISSING_HYG = 1 << 2;        // 4
export const INPUTS_MISSING_SPY = 1 << 3;        // 8
export const INPUTS_MISSING_BREADTH = 1 << 4;    // 16
export const INPUTS_MISSING_SPY_WARMUP = 1 << 5; // 32

export interface PriorDayFires {
  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;
  breadth_narrow: 0 | 1;
  /**
   * Phase 2 — realized_stress fire flag for the prior day. Optional for
   * backward compat with Phase 1 callers that construct prior windows
   * by hand (existing tests). Reading sites use `?? 0` so a missing
   * flag is read as "did not fire" — which is the truth under
   * `phase1_v2` rows. Phase 2 SPEC §4.1 step 6.
   */
  realized_stress?: 0 | 1;
}

export interface ClassifierInput {
  /** ISO date string, YYYY-MM-DD. */
  trade_date: string;

  /** End-of-day close on `trade_date`. Null if not yet available. */
  vix_close: number | null;
  vix3m_close: number | null;

  /**
   * HYG closes ending on `trade_date`, oldest first. Index `length-1` is
   * today's close. The 20-day return uses index `length-21`. Pass
   * whatever length is available; if shorter than 21, no 20-day return
   * is computed and `hyg_spy_divergence` is non-firing.
   */
  hyg_history: (number | null)[];

  /**
   * SPY closes ending on `trade_date`, oldest first. Index `length-1` is
   * today's close. The 252d high uses up to the trailing 252 entries.
   * If fewer than 252 entries are present, `spy_252d_warmup` is set in
   * `inputs_missing` and `breadth_narrow` is non-firing.
   */
  spy_history: (number | null)[];

  /** % of S&P 500 above 50DMA on `trade_date`. Null if breadth row missing. */
  pct_above_50dma: number | null;
  /** Provenance label, e.g. 'stooq_a50r' / 'computed_constituents' / ''. */
  pct_above_50dma_source: string;

  /**
   * Per-category fire flags from up to the previous 4 trading days,
   * oldest first. `length === 4` for typical use; `length < 4` is a
   * backfill-warmup boundary where the rolling window naturally
   * shrinks (SPEC §2.4 — first 4 days cannot be red).
   */
  prior_days_fires: PriorDayFires[];

  /**
   * Phase 2 — per-call override of the module-level
   * `REALIZED_STRESS_THRESHOLD` constant. Used by Phase 2 unit tests
   * (Phase 2 SPEC §6.1) to exercise the new code path without
   * depending on the global constant being set, and by the
   * `_phase2_realized_stress_procedure.ts` script to score every
   * candidate `θ ∈ K` against historical data without mutating module
   * state. `undefined` (the default) means "use the module constant."
   * `null` explicitly means "no threshold; realized_stress = 0
   * always" (matches the module default state).
   */
  realized_stress_threshold?: number | null;

  /**
   * Phase 2 — per-call override of the module-level
   * `REALIZED_STRESS_BREADTH_RULE` constant. Used by Phase 2 unit
   * tests + the procedure script's co-fire histogram (Phase 2 SPEC
   * §3.7). `undefined` → use the module constant. Phase 2 SPEC §4.1
   * step 7.
   */
  realized_stress_breadth_rule?: 'A' | 'B' | 'C' | null;
}

export interface MacroRegimeRow {
  trade_date: string;
  classifier_version: string;

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
  /**
   * Phase 2 — `(spy_close / spy_252d_high) - 1`, in `[-1, 0]`.
   * Stored intermediate per Phase 2 SPEC §1.5; `null` during the SPY
   * 252d warmup or when `spy_close` is missing.
   */
  spy_drawdown_from_1y_high: number | null;

  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;       // canonical 20d
  hyg_spy_divergence_10d: 0 | 1;   // audit
  breadth_narrow: 0 | 1;
  /**
   * Phase 2 — fires when `spy_drawdown_from_1y_high < θ` (the
   * `REALIZED_STRESS_THRESHOLD` constant, or a per-call override).
   * Always 0 under `phase1_v2` rows (threshold null).
   * Phase 2 SPEC §1.1 — `θ ∈ K = {-0.10, -0.12, -0.15, -0.18, -0.20}`.
   */
  realized_stress: 0 | 1;

  inputs_missing: number;

  signals_firing: number;
  categories_firing: number;
  categories_firing_5d: number;
  regime: Regime;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Return arr[length-1-n] or null if out of range / element is null. */
function nthFromLast(arr: (number | null)[], n: number): number | null {
  if (arr.length <= n) return null;
  const v = arr[arr.length - 1 - n];
  return v == null ? null : v;
}

/** N-bar return ending on the last element. Null if either endpoint missing. */
function trailingReturn(arr: (number | null)[], n: number): number | null {
  const today = nthFromLast(arr, 0);
  const past = nthFromLast(arr, n);
  if (today == null || past == null || past === 0) return null;
  return today / past - 1;
}

/**
 * Trailing max over the last `n` elements (inclusive). Null if `n` exceeds
 * the array length (warmup) or every candidate slot is null.
 */
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
 * Phase 2 — derive the final regime from per-day + 5d-rolling category
 * counts under one of three composite rules (Phase 2 SPEC §2.3). The
 * `rule` argument is `null` only under `phase1_v2` rows where the §3
 * procedure has not yet picked a rule; in that state the helper
 * collapses to Phase 1's exact 3-category rule (`categories_firing_5d
 * ≥ 3` for red).
 *
 * Decoupled from `classifyMacroRegime` so Phase 2 SPEC §6.1 unit test
 * #5 can exercise all three rule branches at synthetic input layers
 * that the input-bundle path can't reach (the §2.1 mutex eliminates
 * some 4-tuple inputs from real-data realizability — the helper-level
 * test is the only way to lock the rule semantics directly).
 *
 * - Option C (default for phase2_v1): `≥3 categories in window AND
 *   (realized_stress OR breadth_narrow) fired in window`. Plain-language
 *   equivalent under §2.1 mutex: "both of {vol, credit} fired in window
 *   AND exactly one of {breadth_narrow, realized_stress} fired in
 *   window."
 * - Option A: `≥3 categories in window` (PUSHBACK rejected — see SPEC
 *   §2.3, materially weaker red bar).
 * - Option B: `==4 categories in window` (PUSHBACK rejected — too
 *   strict; §2.1 mutex makes this require a specific 5-day price path
 *   that's rare).
 * - `null`: Phase 1 rule. Only legitimate under phase1_v2 rows.
 */
export function deriveRegime(
  categories_firing_today: number,
  categories_firing_5d: number,
  stress_or_breadth_in_5d: boolean,
  rule: 'A' | 'B' | 'C' | null,
): Regime {
  let isRed: boolean;
  if (rule === 'C') {
    isRed = categories_firing_5d >= 3 && stress_or_breadth_in_5d;
  } else if (rule === 'A') {
    isRed = categories_firing_5d >= 3;
  } else if (rule === 'B') {
    isRed = categories_firing_5d === 4;
  } else {
    // rule === null: Phase 1 behavior. Identical to the original
    // classifier's `categories_firing_5d >= 3` red rule (the
    // realized_stress arm contributes 0 when threshold is null, so
    // categories_firing_5d caps at 3 anyway — the helper is still a
    // semantic match, not just a numeric one).
    isRed = categories_firing_5d >= 3;
  }
  if (isRed) return 'red';
  if (categories_firing_today >= ORANGE_THRESHOLD_TODAY) return 'orange';
  if (categories_firing_today === 1) return 'yellow';
  return 'green';
}

// ── Pure classifier ─────────────────────────────────────────────────────────

/**
 * Compute the full `MacroRegimeRow` for one trading day from already-built
 * inputs. Threshold edges and NULL semantics match SPEC §2 verbatim.
 *
 * @returns A fully-populated row. Caller writes it to CH (or asserts on it
 *   in tests). All NULL-input rules are silent: a NULL input cannot make
 *   its category fire and is recorded in `inputs_missing` for audit.
 */
export function classifyMacroRegime(input: ClassifierInput): MacroRegimeRow {
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

  // ── Volatility (§2.1) ────────────────────────────────────────────────
  const vix_term_ratio =
    input.vix_close != null && input.vix3m_close != null && input.vix3m_close !== 0
      ? input.vix_close / input.vix3m_close
      : null;
  const vix_term_inverted: 0 | 1 =
    vix_term_ratio != null && vix_term_ratio > 1.0 ? 1 : 0;

  // ── Credit (§2.2) ────────────────────────────────────────────────────
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

  // ── Breadth (§2.3) ───────────────────────────────────────────────────
  const spy_252d_high = trailingMax(input.spy_history, SPY_NEAR_HIGH_LOOKBACK);
  const spy_at_or_near_high =
    today_spy != null && spy_252d_high != null
      ? today_spy >= SPY_NEAR_HIGH_FRACTION * spy_252d_high
      : false;
  const breadth_narrow: 0 | 1 =
    input.pct_above_50dma != null &&
    input.pct_above_50dma < BREADTH_NARROW_THRESHOLD &&
    spy_at_or_near_high
      ? 1 : 0;

  // ── Realized stress / Phase 2 §1.1 ───────────────────────────────────
  // `spy_drawdown_from_1y_high` is computed on every row regardless of
  // threshold — it's a stored intermediate for auditability per Phase 2
  // SPEC §1.5. NULL under SPY warmup or when `spy_close` is missing
  // (already flagged via `INPUTS_MISSING_SPY` / _SPY_WARMUP).
  const spy_drawdown_from_1y_high =
    today_spy != null && spy_252d_high != null && spy_252d_high > 0
      ? today_spy / spy_252d_high - 1
      : null;
  // `θ` resolution — per-call override wins; `undefined` falls back to the
  // module constant; `null` (either explicit or constant default) means
  // "no threshold; realized_stress = 0 always" (the phase1_v2 state).
  const stress_threshold =
    input.realized_stress_threshold !== undefined
      ? input.realized_stress_threshold
      : REALIZED_STRESS_THRESHOLD;
  const realized_stress: 0 | 1 =
    stress_threshold !== null &&
    spy_drawdown_from_1y_high !== null &&
    spy_drawdown_from_1y_high < stress_threshold
      ? 1 : 0;

  // ── Composite (§2.4 / Phase 2 §2.3) ──────────────────────────────────
  const signals_firing =
    vix_term_inverted + hyg_spy_divergence + breadth_narrow + realized_stress;
  // Phase 1: every category contains exactly one indicator, so categories
  // == signals. Phase 2 keeps that 1:1 mapping (realized_stress is its own
  // category — see Phase 2 SPEC §1.1 + §2). Note: §2.1 mutex means
  // categories_firing_today maxes at 3, not 4, but no defensive code is
  // needed — the math forbids the 4th by construction.
  const categories_firing = signals_firing;

  const today_fires: PriorDayFires = {
    vix_term_inverted,
    hyg_spy_divergence,
    breadth_narrow,
    realized_stress,
  };
  const window: PriorDayFires[] = [
    ...input.prior_days_fires,
    today_fires,
  ].slice(-ROLLING_UNION_DAYS);

  let union_vix = 0;
  let union_credit = 0;
  let union_breadth = 0;
  let union_stress = 0;
  for (const d of window) {
    if (d.vix_term_inverted) union_vix = 1;
    if (d.hyg_spy_divergence) union_credit = 1;
    if (d.breadth_narrow) union_breadth = 1;
    // `?? 0` covers Phase 1 callers that construct `PriorDayFires`
    // without the optional field (existing tests).
    if ((d.realized_stress ?? 0) === 1) union_stress = 1;
  }
  const categories_firing_5d =
    union_vix + union_credit + union_breadth + union_stress;
  const stress_or_breadth_in_5d = union_stress === 1 || union_breadth === 1;

  // Rule resolution mirrors the threshold resolution above: per-call
  // override wins; `undefined` → module constant; `null` (either
  // explicit or constant default) → Phase 1 fallback in `deriveRegime`.
  const rule =
    input.realized_stress_breadth_rule !== undefined
      ? input.realized_stress_breadth_rule
      : REALIZED_STRESS_BREADTH_RULE;
  const regime = deriveRegime(
    categories_firing,
    categories_firing_5d,
    stress_or_breadth_in_5d,
    rule,
  );

  return {
    trade_date: input.trade_date,
    classifier_version: CLASSIFIER_VERSION,

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

    inputs_missing,

    signals_firing,
    categories_firing,
    categories_firing_5d,
    regime,
  };
}

/**
 * Convenience — extract a row's PriorDayFires. Used by `backfillMacroRegimes`
 * when chaining classifications across consecutive days.
 */
export function rowToPriorDayFires(row: MacroRegimeRow): PriorDayFires {
  return {
    vix_term_inverted: row.vix_term_inverted,
    hyg_spy_divergence: row.hyg_spy_divergence,
    breadth_narrow: row.breadth_narrow,
    realized_stress: row.realized_stress,
  };
}

// ── Bundle-driven classifier (pure; testable without ClickHouse) ────────────

export interface RegimeDataBundle {
  /** Trading dates (ISO `YYYY-MM-DD`) we want to classify, sorted ASC. */
  classifyDates: string[];
  /**
   * Sorted ASC list of all dates for which SPY has a close, INCLUDING the
   * 252-day prefix before `classifyDates[0]`. Drives the slicing window for
   * the breadth indicator's 1Y-high gate.
   */
  spyDates: string[];
  spyByDate: Map<string, number>;
  /** Same shape as SPY but only ~21+ entries of prefix needed. */
  hygDates: string[];
  hygByDate: Map<string, number>;
  /** Point-in-time close maps. Missing date → input value is null. */
  vixByDate: Map<string, number>;
  vix3mByDate: Map<string, number>;
  /** Per-date breadth + provenance (the source label from `quantlab.macro_breadth`). */
  breadthByDate: Map<string, { pct: number; source: string }>;
}

/**
 * Iterate `bundle.classifyDates` in order, building a `ClassifierInput` per
 * date by slicing prefix history out of the bundle's sorted SPY/HYG arrays
 * and threading the rolling 4-day priors window through. Returns one
 * `MacroRegimeRow` per date.
 *
 * Pure — no I/O, no globals. The integration test for SPEC §5.3 calls this
 * directly with synthetic bundles and asserts the no-cry-wolf property in
 * a calm fixture.
 */
export function classifyDateRangeFromBundle(
  bundle: RegimeDataBundle
): MacroRegimeRow[] {
  const spyIdx = new Map<string, number>();
  for (let i = 0; i < bundle.spyDates.length; i++) spyIdx.set(bundle.spyDates[i], i);
  const hygIdx = new Map<string, number>();
  for (let i = 0; i < bundle.hygDates.length; i++) hygIdx.set(bundle.hygDates[i], i);

  const out: MacroRegimeRow[] = [];
  let priors: PriorDayFires[] = [];

  for (const d of bundle.classifyDates) {
    const sIdx = spyIdx.get(d);
    const hIdx = hygIdx.get(d);

    const spy_history: (number | null)[] =
      sIdx == null
        ? []
        : bundle.spyDates
            .slice(Math.max(0, sIdx - (SPY_NEAR_HIGH_LOOKBACK - 1)), sIdx + 1)
            .map(x => bundle.spyByDate.get(x) ?? null);

    // HYG only needs 21 entries (t-20..t inclusive).
    const hyg_history: (number | null)[] =
      hIdx == null
        ? []
        : bundle.hygDates
            .slice(Math.max(0, hIdx - HYG_SPY_DIVERGENCE_LOOKBACK), hIdx + 1)
            .map(x => bundle.hygByDate.get(x) ?? null);

    const breadth = bundle.breadthByDate.get(d);

    const input: ClassifierInput = {
      trade_date: d,
      vix_close: bundle.vixByDate.get(d) ?? null,
      vix3m_close: bundle.vix3mByDate.get(d) ?? null,
      hyg_history,
      spy_history,
      pct_above_50dma: breadth?.pct ?? null,
      pct_above_50dma_source: breadth?.source ?? '',
      prior_days_fires: priors,
    };
    const row = classifyMacroRegime(input);
    out.push(row);
    priors = [...priors, rowToPriorDayFires(row)].slice(-(ROLLING_UNION_DAYS - 1));
  }

  return out;
}

// ── ClickHouse-backed I/O wrapper ────────────────────────────────────────────

/**
 * Lazily-loaded CH bindings — keeps `src/server/macro_regime` importable from
 * test files without dragging in clickhouse-connect at module-evaluation time.
 */
async function chBindings() {
  const mod = await import('./clickhouse.js');
  return { getClickHouse: mod.getClickHouse };
}

const SPY_ADDR = 'SPY_USD';
const HYG_ADDR = 'HYG_USD';
const VIX_ADDR = 'VIX_USD';
const VIX3M_ADDR = 'VIX3M_USD';
const REGIME_SOURCE = 'yfinance_regime';

/** Buffer days of SPY history before `startDate` for the 252-day lookback. */
const SPY_PREFIX_DAYS = 380; // generous wall-clock buffer (covers weekends/holidays)
/** Buffer for HYG (only 21 trading days needed; pad for calendar gaps). */
const HYG_PREFIX_DAYS = 40;

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface CandleQueryRow { d: string; close: number | string }
interface BreadthQueryRow { d: string; source: string; pct: number | string }

async function loadCandleSeries(
  ch: ReturnType<Awaited<ReturnType<typeof chBindings>>['getClickHouse']>,
  tokenAddr: string,
  fromDate: string,
  toDate: string
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
  toDate: string
): Promise<Map<string, { pct: number; source: string }>> {
  // Pick the most recent (highest ingested_at) row per (trade_date, source);
  // then prefer 'stooq_a50r' over 'computed_constituents' when both present.
  const result = await ch.query({
    query: `
      SELECT toString(trade_date) AS d, source, pct_above_50dma AS pct
      FROM quantlab.macro_breadth FINAL
      WHERE trade_date >= toDate({fromD:String})
        AND trade_date <= toDate({toD:String})
      ORDER BY trade_date ASC,
               -- Stooq ranks first when both sources exist for a given date.
               (source = 'stooq_a50r') DESC
    `,
    query_params: { fromD: fromDate, toD: toDate },
    format: 'JSONEachRow',
  });
  const rows = await result.json<BreadthQueryRow>();
  const out = new Map<string, { pct: number; source: string }>();
  for (const r of rows) {
    if (out.has(r.d)) continue; // first row per date wins (Stooq-preferred)
    const pct = Number(r.pct);
    if (!Number.isFinite(pct)) continue;
    out.set(r.d, { pct, source: String(r.source) });
  }
  return out;
}

/**
 * End-to-end backfill: load candles + breadth from ClickHouse for the
 * requested window (with sufficient prefix for the 252-day SPY high),
 * iterate trading dates, classify each, and write rows back to
 * `quantlab.macro_regimes`. Idempotent re-runs over the same window write
 * fresh rows that collapse via `ReplacingMergeTree(ingested_at)`.
 */
export async function backfillMacroRegimes(args: {
  startDate: string;
  endDate: string;
  classifierVersion?: string;
  dryRun?: boolean;
}): Promise<{ rowsWritten: number; firstDate: string; lastDate: string }> {
  // Phase 2 SPEC §4.1 step 2 / §4.6 commit-ordering enforcement (post-critic
  // blocker B4). The `phase2_v1` version tag is only legitimate after the
  // threshold-selection procedure has run and `RESULT.md` has plugged θ
  // (and the composite rule) into the module constants. Refusing to write
  // phase2_v1 rows under null constants makes "ran the procedure first" a
  // structural guarantee — no human can silently emit phase2_v1 rows under
  // a placeholder θ and then later "fix" them in place with a different θ
  // under the same version tag. Guard runs BEFORE the CH binding load so
  // the write-guard test doesn't need a live CH connection.
  const targetVersion = args.classifierVersion ?? CLASSIFIER_VERSION;
  if (targetVersion === 'phase2_v1') {
    if (REALIZED_STRESS_THRESHOLD === null) {
      throw new Error(
        'phase2_v1 backfill requires REALIZED_STRESS_THRESHOLD; ' +
          'run npm run macro:phase2:procedure first and plug the value from ' +
          'docs/phase2_procedure_artifacts/RESULT.md into src/server/macro_regime.ts.',
      );
    }
    if (REALIZED_STRESS_BREADTH_RULE === null) {
      throw new Error(
        'phase2_v1 backfill requires REALIZED_STRESS_BREADTH_RULE; ' +
          'run npm run macro:phase2:procedure first and plug the chosen ' +
          'composite rule (A/B/C) from RESULT.md into src/server/macro_regime.ts.',
      );
    }
  }

  const { getClickHouse } = await chBindings();
  const ch = getClickHouse();

  const spyFrom = isoMinusDays(args.startDate, SPY_PREFIX_DAYS);
  const hygFrom = isoMinusDays(args.startDate, HYG_PREFIX_DAYS);

  const [spy, hyg, vix, vix3m, breadth] = await Promise.all([
    loadCandleSeries(ch, SPY_ADDR, spyFrom, args.endDate),
    loadCandleSeries(ch, HYG_ADDR, hygFrom, args.endDate),
    loadCandleSeries(ch, VIX_ADDR, args.startDate, args.endDate),
    loadCandleSeries(ch, VIX3M_ADDR, args.startDate, args.endDate),
    loadBreadthSeries(ch, args.startDate, args.endDate),
  ]);

  // Classify every SPY trading date that falls in [startDate, endDate].
  // SPY is the canonical equity calendar; missing VIX/VIX3M/HYG/breadth on
  // any given day is handled by the classifier's NULL semantics + the
  // `inputs_missing` audit bitmask.
  const classifyDates = spy.dates.filter(d => d >= args.startDate && d <= args.endDate);

  const bundle: RegimeDataBundle = {
    classifyDates,
    spyDates: spy.dates,
    spyByDate: spy.byDate,
    hygDates: hyg.dates,
    hygByDate: hyg.byDate,
    vixByDate: vix.byDate,
    vix3mByDate: vix3m.byDate,
    breadthByDate: breadth,
  };
  const rows = classifyDateRangeFromBundle(bundle);

  if (targetVersion !== CLASSIFIER_VERSION) {
    for (const r of rows) r.classifier_version = targetVersion;
  }

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
        vix_term_inverted: r.vix_term_inverted,
        hyg_spy_divergence: r.hyg_spy_divergence,
        hyg_spy_divergence_10d: r.hyg_spy_divergence_10d,
        breadth_narrow: r.breadth_narrow,
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
 * Read the latest classified row at-or-before `asOfDate`.
 * Returns `null` if no row exists for the requested classifier version.
 */
export async function fetchMacroRegime(asOfDate: string): Promise<MacroRegimeRow | null> {
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
    query_params: { cv: CLASSIFIER_VERSION, d: asOfDate },
    format: 'JSONEachRow',
  });
  const rows = await r.json<MacroRegimeRow>();
  return rows.length > 0 ? rows[0] : null;
}

export async function fetchMacroRegimeRange(
  startDate: string,
  endDate: string,
  classifierVersion: string = CLASSIFIER_VERSION
): Promise<MacroRegimeRow[]> {
  const { getClickHouse } = await chBindings();
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT *
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = {cv:String}
        AND trade_date >= toDate({s:String})
        AND trade_date <= toDate({e:String})
      ORDER BY trade_date ASC
    `,
    query_params: { cv: classifierVersion, s: startDate, e: endDate },
    format: 'JSONEachRow',
  });
  return await r.json<MacroRegimeRow>();
}

/**
 * Daily one-shot — classify the most recent date for which all four
 * candle sources (VIX, VIX3M, HYG, SPY) have a close. Skips silently
 * (returns null) if any source is missing today's bar — protects against
 * the 4:05 PM ET daemon firing before Yahoo's official close lands
 * (SPEC §6 stale-data guard).
 *
 * Internal logic:
 * 1. Find the latest date `t` where SPY, HYG, VIX, VIX3M all exist.
 * 2. Reuse `backfillMacroRegimes(t, t)` so the full classification
 *    pipeline (with prefix history) is exercised — no separate code path.
 * 3. Return the resulting row. Backfill writes to CH as a side effect.
 */
export async function classifyLatestMacroRegime(): Promise<MacroRegimeRow | null> {
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
      addrs: [SPY_ADDR, HYG_ADDR, VIX_ADDR, VIX3M_ADDR],
      src: REGIME_SOURCE,
    },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string | null }>();
  if (rows.length === 0 || !rows[0].d) return null;
  const t = rows[0].d;

  // backfillMacroRegimes loads its own SPY 252d prefix; we don't need to
  // pre-buffer here. Use t as both endpoints.
  await backfillMacroRegimes({ startDate: t, endDate: t });
  return await fetchMacroRegime(t);
}
