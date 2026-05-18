# Correlation-weighted per-cell allocation — SPEC

**Status:** Proposed (with critic fixes applied)
**Date:** 2026-05-17 (session 68; in-session critic-fix pass — see §17)
**Owner:** Vector Core
**Source ADR:** [`docs/decisions/README.md`](../decisions/README.md) — **ADR-040 (forthcoming)**; resolves [ADR-039](../decisions/README.md#adr-039-) Open Question #3 ("intra-stage-allocation split rule").
**Source RESEARCH:** [`docs/specs/adr-040-correlation-weighted-allocation-research.md`](adr-040-correlation-weighted-allocation-research.md) — canon, methodology survey, data inventory, PUSHBACK on urgency, recommended policy shape. The SPEC below pins the open questions §9 of that RESEARCH note left open.
**Companion SPECs:**
- [`docs/specs/per-cell-stage-sizing.md`](per-cell-stage-sizing.md) §§4-7, §11.1 — supplies the equal-weight default that this SPEC replaces; the wire-up extends `resolvePerCellSizingForRun` (same file, same orchestrator).
- [`docs/specs/stage-state-machine.md`](stage-state-machine.md) — supplies `stageAfter` and `decision === 'halt'` for the upstream half of the orchestration.
- [`docs/specs/drawdown-response-framework.md`](drawdown-response-framework.md) — `sizingMultiplier` continues to compose with `maxRiskPerTrade`; this SPEC does not touch that composition path.
- [`docs/specs/position-sizing-and-kill-switch.md`](position-sizing-and-kill-switch.md) — §3A `sizePositionFixedRisk` consumes the weighted `cellCapitalUsd` produced here.
- [`docs/specs/trade-execution-pipeline-architecture.md`](trade-execution-pipeline-architecture.md) — §9 ordering: stage eval → **cell-weight resolution (NEW)** → per-cell split → per-cell loop.

**Canon (Tier 1):**
- López de Prado, *Advances in Financial Machine Learning* (2018), **Ch 16** — HRP construction; Snippet 16.4 reference; §16.4.5 small-sample failure mode.
- López de Prado (2016), "Building Diversified Portfolios that Outperform Out of Sample," *JPM* 42(4) — OOS-variance ranking (HRP > min-variance > IVW > equal-weight at T=520, N=10).
- Maillard, Roncalli, Teïletche (2010) — ERC closed form at N=2 (background — ERC is explicitly excluded from this tier ladder; see §3).
- AFML §11-12 (López de Prado 2018) — selection-bias canon that motivates the LIVE-only data filter in §8.

**Implementation:** lands as
- `src/server/cell_weights.ts` (pure) — `computeCellWeights` + `selectCellWeightsTier`
- `src/server/cell_pnl_history.ts` — `getCellDailyReturns` data accessor (Option A from RESEARCH §5.2)
- `scripts/_compute_cell_weights_reference.py` — Python reference for T2/HRP test fixtures
- extension to `src/server/per_cell_capital.ts` — new `resolveCellWeightsForRun` orchestration + new fields on `ResolvePerCellSizingResult`
- one new call inside `scripts/daily_signal_daemon.ts` (between stage eval and per-cell loop)
- extension to the brief stage panel (one new line)

This SPEC pins the contract; CODE follows.

---

## 1. Goal

Replace the pinned equal-weight intra-stage split (per-cell-stage-sizing.md §6.2: `cellCapitalUsd = totalCapitalUsd / numCells`) with a **tiered, data-sufficiency-gated, correlation-aware split**: `cellCapitalUsd[i] = totalCapitalUsd × weights[i]`, where `weights` come from a pure helper that auto-selects between three tiers based on observed N (number of active cells) and T (days of live data per cell):

- **T0 — Equal-weight** (default, always available): `weights[i] = 1 / N`
- **T1 — Inverse-Variance Weighting** (activates when triggers fire): `weights[i] ∝ 1 / σᵢ²`
- **T2 — Hierarchical Risk Parity** (activates when triggers fire): AFML Snippet 16.4

After this slice:

1. The daemon computes per-cell weights ONCE per run, AFTER stage eval, BEFORE the per-cell loop.
2. The weights are routed through `resolvePerCellSizingForRun` so that `perCellCapital.cellCapitalUsd` becomes per-cell, NOT a single shared value across cells.
3. The brief stage panel shows the active tier and the resolved weights.
4. ADR-039 §6 pre-commitment discipline applies: the tier ladder, trigger thresholds, source filter, window length, and ratchet behavior are all pinned constants in this slice's code, NOT operator-overridable config.

This SPEC is the consumer of session 56's `resolvePerCellSizingForRun` — without the new `weights` field on that orchestrator's result, the per-cell loop has no per-cell capital values to consume.

---

## 2. Non-goals

- **No correlation cap on TOTAL exposure.** ADR-039 §1 fixes the stage allocation; this slice only redistributes that fixed pie. A correlation-driven cap on the stage total itself is a separate (and harder) ADR.
- **No operator-set per-cell weights override.** ADR-039 §6 pre-commitment ethos: if the operator wants a manual weight, the correct response is a superseding ADR amendment, not a CLI flag. (Same discipline as the existing stage CLI's no-jump rule.)
- **No ERC tier.** RESEARCH §4.2: ERC's edge over IVW is marginal at the data scales we'll plausibly reach (N=2-8, T=90-180), and ERC's covariance-matrix-inversion sensitivity makes it strictly dominated by HRP at the same data budget. The tier ladder has exactly THREE rungs; do not let a critic add a fourth.
- **No Meucci ENB on the brief panel.** Diagnostic, not allocation — separable slice. The brief renders the *active weights*, not the diversification *measurement*.
- **No materialized `cell_daily_pnl` table.** Option A from RESEARCH §5.2: on-the-fly query from `live_trades`. If brief render becomes slow at scale, Option B (materialization) is a follow-up.
- **No daily mark-to-market unrealized P&L.** Realized-only for v1. The variance estimate ignores intra-trade P&L volatility on currently-open positions; the bias is toward UNDER-estimating variance for slow-trading cells (their realized P&L is a less-frequent series). Documented in §15 watch-outs; revisit when trade frequency makes realized-only obscure significant intra-trade variance.
- **No weight smoothing across re-estimation cycles** (no EWMA, no hard-cap-per-cycle). Reasoning: at the pinned 90-day rolling window, a single new day's data shifts σᵢ² by at most ~1.1% (1/90 weight on the new observation), so weight oscillation is naturally bounded without an explicit cap. Smoothing would require persisting prior weights (new schema) AND introducing a state-dependent rule that's harder to reason about — defer to a follow-up slice if oscillation is observed in production. (Resolves RESEARCH §9 OQ #4 — see §3.)
- **No change to `maxRiskPerTrade`.** Drawdown framework's `sizingMultiplier` continues to compose with `maxRiskPerTrade` unchanged.
- **No retroactive resize of OPEN positions.** Identical to per-cell-stage-sizing.md §2 convention: weight changes affect NEW opens only. Existing opens carry their original `notionalUsd` until exit.
- **No change to the HALT semantic.** Per per-cell-stage-sizing.md §6.3, HALT zeros `cellCapitalUsd` for ALL cells regardless of weights. Composition order: weights computed first → per-cell capital computed second → HALT zeros third.

---

## 3. Tier ladder and trigger conditions

Three tiers, ratchet-up only. The pure helper `selectCellWeightsTier` returns the active tier given (`observedN`, `observedDaysWithTrades`, `observedMinClosedTrades`, `priorActiveTier`).

**Critical semantic — `observedDaysWithTrades` ≠ calendar window length.** The data accessor (`getCellDailyReturns`, §8) returns ZERO-FILLED daily-return series of length `windowDays` (always 180 — see §9.1). The CALENDAR-coverage length of the series is therefore identically `windowDays` for every run from day 1, which makes it a meaningless trigger. The trigger instead consumes `observedDaysWithTrades` = `min` across cells of `observedDays[cellKey]` (the §8 diagnostic field), which counts only days in the window where the cell had AT LEAST ONE closed trade — i.e., the genuine signal-content of the series, not its zero-padded length.

| Tier | Rule | Trigger to activate (ALL must be true) | Estimation method |
| --- | --- | --- | --- |
| **T0 — Equal-weight** | `wᵢ = 1/N` | DEFAULT — active until T1 fires | None |
| **T1 — IVW** | `wᵢ ∝ 1/σᵢ²` | `observedN ≥ 2` AND `observedDaysWithTrades ≥ 90` AND `observedMinClosedTrades ≥ 30` | Most recent 90 elements (`.slice(-90)`) of the zero-filled 180-day series — see §6.2 |
| **T2 — HRP** | AFML Snippet 16.4 | `observedN ≥ 4` AND `observedDaysWithTrades ≥ 180` AND `observedMinClosedTrades ≥ 60` | Full 180-element zero-filled series — see §6.3 |

Source filter for both T1 and T2: `live_trades.source IN ('paper', 'live')` only — never `bt_trades`.

**Ratchet-up only.** If `priorActiveTier === 'T1'` and the current trigger evaluation would return `'T0'` (e.g. a cell paused and dropped below 30 closed trades in window), the helper returns `'T1'`. Reason: tier flapping would produce weight discontinuities that confuse audit and brief. The only legitimate way to ratchet DOWN is an explicit ADR amendment. (Resolves RESEARCH §9 OQ #8.)

**Pinned constants in `cell_weights.ts`** (single source of truth):

```ts
export const TIER_TRIGGERS = {
  T1: { minN: 2, minDaysWithTrades: 90, minClosedTrades: 30 } as const,
  T2: { minN: 4, minDaysWithTrades: 180, minClosedTrades: 60 } as const,
} as const;
export const ROLLING_WINDOW_DAYS_T1 = 90;   // .slice(-90) of the fetched 180-day series for T1 variance
export const ROLLING_WINDOW_DAYS_T2 = 180;  // full 180-day series for T2 covariance
export const SOURCE_FILTER: ReadonlyArray<'paper' | 'live'> = ['paper', 'live'] as const;
```

These constants are NOT exported via config files, environment variables, or CLI flags. A future amendment changes them by editing this file under a new ADR.

**Resolutions of RESEARCH §9 open questions, captured for the record:**

| OQ | Recommendation | Pinned in SPEC |
| --- | --- | --- |
| #1 source filter | `source IN ('paper', 'live')` | §3 `SOURCE_FILTER` constant |
| #2 window length | 90 days (T1) / 180 days (T2) | §3 `ROLLING_WINDOW_DAYS_T1/T2` |
| #3 re-estimation cadence | Every daemon run (daily) | §9 daemon wire-up |
| #4 weight smoothing | NONE — 90-day window naturally smooths | §2 non-goal + §15 watch-out |
| #5 HALT composition | Weights first → cellCap × weight → HALT zeros all | §7.3 + §9.3 |
| #6 daemon log line | Yes — exact byte format pinned at §9.5 (`[cell-weights] tier=… cells=… weights=… obsDaysWithTrades=… minClosedTrades=… ratchetHeld=…`) | §9.5 |
| #7 brief panel surface | Yes: one line under the existing `deployed=$X.XX across N cells` line | §10 |
| #8 ratchet behavior | Ratchet-up only (T0→T1→T2, never backwards) | §3 above |

**Plus RESEARCH §5.2 + §5.3 deferred decisions, resolved here:**

| Decision | Resolution | Pinned in SPEC |
| --- | --- | --- |
| Zero-trade-day fill | Zero-fill (no trade → realized P&L = 0 → daily return = 0) | §8.4 |
| Realized vs MTM | Realized-only for v1; MTM deferred | §2 non-goal + §15 watch-out |
| Storage of priorActiveTier | New CH table `cell_weights_history(run_ts, tier, weights_json)`; helper reads last row | §11 |

---

## 4. Inputs to the pure helper (`computeCellWeights`)

```ts
interface ComputeCellWeightsInputs {
  /** Stable cell identifiers (e.g. 'mean_reversion_v1__p14'). Order pins the output Map iteration order. */
  cellKeys: readonly string[];
  /**
   * Daily realized log-return series per cell, zero-filled to a common date
   * grid of length `windowDays` (always 180 — see §9.1). Each series MUST
   * have identical length and identical implicit date alignment (the caller —
   * `getCellDailyReturns` — is responsible for the alignment, per §8.3).
   *
   * NOTE: series length is fixed at 180 and is therefore NOT a data-sufficiency
   * signal. The trigger ladder uses `observedDays` below as the genuine
   * signal-content metric.
   */
  dailyReturns: ReadonlyMap<string, ReadonlyArray<number>>;
  /**
   * Per-cell count of closed trades in the window. Used for the trigger
   * condition; NOT used in the variance estimate.
   */
  closedTradeCounts: ReadonlyMap<string, number>;
  /**
   * Per-cell count of DAYS WITH AT LEAST ONE CLOSED TRADE in the window
   * (i.e., the count of non-zero-fill days for each cell — sourced from
   * `getCellDailyReturns`'s `observedDays` diagnostic). This is the
   * authoritative "data sufficiency" signal the trigger ladder gates on,
   * NOT `dailyReturns[cell].length` (which is always 180 after zero-fill).
   */
  observedDays: ReadonlyMap<string, number>;
  /**
   * Forces a specific tier regardless of triggers. `'auto'` (default) applies
   * the §3 trigger ladder with the ratchet-up rule. Explicit tiers ('T0' /
   * 'T1' / 'T2') are for testing the math at each tier independently.
   *
   * **No production call site MAY pass `tier !== 'auto'`.** Forced tiers exist
   * only for unit-test math isolation. `resolveCellWeightsForRun` hardcodes
   * `tier: 'auto'` and is the only canonical production caller — see §9.1
   * step 2. A future contributor introducing a `--force-tier` CLI flag would
   * be operating against this SPEC and ADR-040's pre-commitment ethos. (L-4
   * fix — pinning the implicit assumption explicitly.)
   */
  tier: 'auto' | 'T0' | 'T1' | 'T2';
  /**
   * The tier active on the most recent prior daemon run. Used for the
   * ratchet-up rule under `tier='auto'`. `null` means "no prior history" →
   * the helper starts at T0.
   */
  priorActiveTier: 'T0' | 'T1' | 'T2' | null;
}
```

**Callers:** the daemon orchestrator (one call per run, inside `resolveCellWeightsForRun`). Tests inject all fields directly.

---

## 5. Outputs (`computeCellWeights`)

```ts
interface ComputeCellWeightsResult {
  /** The tier the helper actually applied this call. */
  tierActive: 'T0' | 'T1' | 'T2';
  /**
   * Per-cell weights, summing to 1.0 (subject to floating-point tolerance
   * ≤ 1e-9). Map iteration order matches `inputs.cellKeys` order.
   */
  weights: ReadonlyMap<string, number>;
  /**
   * Trigger-gating data-sufficiency metric: min across cells of
   * `observedDays[cell]`. See §3 for why this is the authoritative signal
   * rather than the (always-180) `dailyReturns[cell].length`.
   */
  observedDaysWithTrades: number;
  /** Observed N — `cellKeys.length`. Echoed for brief / log. */
  observedN: number;
  /** Min across cells of `closedTradeCounts[cell]`. */
  observedMinClosedTrades: number;
  /**
   * Length of the zero-filled `dailyReturns` arrays consumed for variance /
   * covariance estimation. Always 180 (= `ROLLING_WINDOW_DAYS_T2`). Echoed
   * for audit so a future SPEC reader can confirm the variance window was
   * not narrowed silently.
   */
  computeWindowDays: number;
  /** True iff T1 trigger conditions are met (independent of ratchet). */
  sufficientForT1: boolean;
  /** True iff T2 trigger conditions are met (independent of ratchet). */
  sufficientForT2: boolean;
  /**
   * True iff `tier='auto'` AND `selectCellWeightsTier` returned a tier
   * STRICTLY HIGHER than what the current sample alone would have produced,
   * because the ratchet-up rule held the prior tier. Surfaces for audit /
   * brief — "we're holding T1 even though the sample dropped below threshold."
   */
  ratchetHeld: boolean;
}
```

**Invariants** (asserted in tests, not in production code — tests catch regressions; production trusts the math):

- `Σ weights[i] === 1.0` (within 1e-9)
- `weights[i] > 0` for all i (no zero weights from T0/T1/T2 — zeros come from HALT, which is downstream)
- `weights[i] = 1/N` exactly when `tierActive === 'T0'`
- `weights.size === cellKeys.length`

---

## 6. Pure-function semantics

### §6.1 T0 — Equal-weight

`weights[i] = 1 / N` for all i, where N = `cellKeys.length`. Independent of `dailyReturns`, `closedTradeCounts`. Returned with `tierActive='T0'` whenever the trigger ladder selects T0 OR `tier='T0'` is forced.

### §6.2 T1 — Inverse-Variance Weighting

Per §8.3, `dailyReturns[cell]` is chronologically ascending (index 0 = oldest day in window; last index = `refDate`). For T1, slice the most recent 90 elements:

```ts
const t1Window = dailyReturns.get(cellKey)!.slice(-ROLLING_WINDOW_DAYS_T1);
```

Then:

```
σᵢ² = sample variance of t1Window (Bessel-corrected: ddof=1)
wᵢ_raw = 1 / σᵢ²
wᵢ = wᵢ_raw / Σⱼ wᵢ_raw
```

**`.slice(-90)`, not `.slice(0, 90)` — pinned explicitly because reading the OLDEST 90 days defeats the rolling-window purpose entirely. A CODE author who reverses this destroys the variance estimate's responsiveness.**

**Closed-form pin for N=2:** `w₁ = σ₂² / (σ₁² + σ₂²)`. Pinned in test #T1-2 / #T1-3.

**Variance floor:** if a cell's σᵢ² < 1e-12 (numerical zero — pathological), the helper throws (caller bug — shouldn't happen with zero-fill on a non-degenerate sample). Real cells with brief flat periods land at σᵢ² ≥ ~1e-8 from the zero-fill rule (the variance of mostly-zeros-with-a-few-nonzeros is bounded below by the nonzero square divided by sample size).

### §6.3 T2 — HRP (AFML Snippet 16.4)

For T2, use the FULL `dailyReturns[cell]` array (no slicing — the array is already exactly `ROLLING_WINDOW_DAYS_T2 = 180` elements per §9.1). Three steps, byte-pinned against the AFML reference:

1. **Correlation → distance** (AFML Snippet 16.4 step 1). Compute the N×N sample correlation matrix ρ from the 180-element series. Distance: `d(i,j) = sqrt((1 - ρ(i,j)) / 2)`.
2. **Tree clustering** (AFML Snippet 16.2 `getIVP` → Snippet 16.3 input). Single-linkage agglomerative cluster on `d` via scipy `cluster.hierarchy.linkage(d_condensed, method='single')`. The TS implementation MUST produce a byte-identical linkage matrix for the same input — see §6.3.1.
3. **Quasi-diagonalize** (AFML Snippet 16.3 `getQuasiDiag`) — derives the leaf-order permutation from the linkage matrix.
4. **Recursive bisection** (AFML Snippet 16.4 `getRecBipart`). Walk the tree top-down; at each split into subclusters L and R, compute within-subcluster IVW variances, allocate `α_L = 1 - σ²(L)/(σ²(L)+σ²(R))`, `α_R = 1 - α_L`; multiply αs through to leaf weights.

**§6.3.1 — Determinism and the alphabetize-input canonicalization.** scipy's `linkage(method='single')` has a defined tie-breaking convention but it depends on the INPUT ROW ORDER of the distance matrix. Two implementations that pass the same N=4 input in different cellKey orderings produce different linkage matrices (and therefore different leaf orderings, weights). To make weights cell-identity-canonical rather than insertion-order-canonical:

1. **Canonicalize input order.** BEFORE constructing the correlation matrix, sort `cellKeys` alphabetically and re-key `dailyReturns` to that order. This guarantees the row/column ordering of the distance matrix passed to linkage is determined by cell identity, not by daemon-call insertion order.
2. **Use scipy's default tie-break.** With canonicalized input, scipy's deterministic tie-break produces a unique linkage matrix.
3. **`getQuasiDiag` is then fully deterministic.** No additional tie-break logic in the leaf-ordering step.
4. **Output weights are keyed by ORIGINAL `cellKeys` order** (not the alphabetized order) so the §5 invariant "Map iteration order matches `inputs.cellKeys` order" still holds. The alphabetize-permutation lives entirely inside the math layer.

Implementation strategy:

- Ship `scripts/_compute_cell_weights_reference.py` that takes a JSON input (cellKeys + dailyReturns + closedTradeCounts + observedDays) and emits a JSON output (tierActive + weights + diagnostics) using scipy/numpy.
- Generate 5 reference fixtures covering (a) N=2 collapse to IVW, (b) N=4 uncorrelated, (c) N=4 two correlated pairs, (d) N=6 with one outlier cell, (e) N=4 with cellKeys passed in NON-alphabetical order (pins the canonicalization).
- Commit fixtures under `scripts/tests/fixtures/cell_weights/`.
- TS implementation is byte-pinned against the fixtures (weights agree to 1e-9).
- If the TS implementation cannot match scipy's tie-breaking for some pathological input, that input is a test case (fail the test, document the divergence, decide whether to special-case).

Pinned in test #T2-3 (alphabetize canonicalization) and #T2-fixture-suite (5 fixtures).

### §6.4 Auto tier selection (`selectCellWeightsTier`)

Pure function that takes `(observedN, observedDaysWithTrades, observedMinClosedTrades, priorActiveTier)` and returns `'T0' | 'T1' | 'T2'`:

```ts
function selectCellWeightsTier(
  observedN: number,
  observedDaysWithTrades: number,
  observedMinClosedTrades: number,
  priorActiveTier: 'T0' | 'T1' | 'T2' | null,
): 'T0' | 'T1' | 'T2' {
  const sufficientT1 =
    observedN >= TIER_TRIGGERS.T1.minN &&
    observedDaysWithTrades >= TIER_TRIGGERS.T1.minDaysWithTrades &&
    observedMinClosedTrades >= TIER_TRIGGERS.T1.minClosedTrades;
  const sufficientT2 =
    observedN >= TIER_TRIGGERS.T2.minN &&
    observedDaysWithTrades >= TIER_TRIGGERS.T2.minDaysWithTrades &&
    observedMinClosedTrades >= TIER_TRIGGERS.T2.minClosedTrades;

  const triggerSays: 'T0' | 'T1' | 'T2' = sufficientT2 ? 'T2' : sufficientT1 ? 'T1' : 'T0';

  // Ratchet-up only: never fall back to a lower tier than the prior run.
  const tierOrder = { T0: 0, T1: 1, T2: 2 } as const;
  if (priorActiveTier !== null && tierOrder[priorActiveTier] > tierOrder[triggerSays]) {
    return priorActiveTier;
  }
  return triggerSays;
}
```

This separation (math helper vs. tier selector) is intentional — it lets tests independently pin (i) the trigger thresholds, (ii) the ratchet rule, (iii) the per-tier math, without combinatorial explosion.

---

## 7. Edge-case throws (caller bugs, not silent zeroes)

The pure helper `computeCellWeights` throws on:

| Condition | Reason |
|---|---|
| `cellKeys.length === 0` | No cells → no weights to compute. Daemon never passes empty cells. |
| `cellKeys` contains duplicates | Map keys would collide; weight assignment ambiguous. |
| `dailyReturns.size !== cellKeys.length` | Caller didn't align series to cells. |
| Any `cellKey` missing from `dailyReturns` or `closedTradeCounts` | Same alignment bug. |
| Per-cell `dailyReturns[cell].length === 0` and `tier !== 'T0'` | T1/T2 forced without data. T0 is the legitimate empty-data path. |
| Per-cell `dailyReturns[cell].length !== dailyReturns[cellKeys[0]].length` | Series not aligned to common date grid. `getCellDailyReturns` must align before calling. |
| Any `dailyReturns[cell][k]` is non-finite (NaN / Infinity) | Upstream data hygiene bug. Zero-fill should produce zeros, not NaN. |
| `tier === 'T1'` AND `observedN < 2` | Single cell + IVW is degenerate — weight = 1.0 regardless of σ, equivalent to T0. Forcing T1 at N=1 is a test bug. |
| `tier === 'T2'` AND `observedN < 2` | HRP requires ≥2 cells to cluster. |
| `σᵢ² < 1e-12` for any cell under T1/T2 | Numerical zero variance — pathological data (all returns exactly equal). Indicates upstream bug. |

§7 throws are caller-bug signals — silent zeroes / fallbacks would let wire-up bugs slip past tests.

---

## 8. Data accessor (`getCellDailyReturns`)

```ts
interface GetCellDailyReturnsInputs {
  cellKeys: readonly string[];
  /** Window length in days. Pinned to ROLLING_WINDOW_DAYS_T2 (180) so the same query supports T1 + T2 evaluation. */
  windowDays: number;
  /** Reference date for the window end (inclusive). The window is `[refDate - windowDays + 1, refDate]`. */
  refDate: Date;
  /** Test injection point — defaults to the module-internal CH client. */
  executor?: (sql: string) => Promise<Array<Record<string, unknown>>>;
}

interface GetCellDailyReturnsResult {
  /** Cell → daily realized log-return series, zero-filled to a common date grid of length `windowDays`. */
  dailyReturns: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Cell → count of trades that CLOSED inside the window. */
  closedTradeCounts: ReadonlyMap<string, number>;
  /** Diagnostic: per-cell count of non-zero-fill days (i.e. days with at least one closed trade). */
  observedDays: ReadonlyMap<string, number>;
}
```

### §8.1 SQL query (Option A — on-the-fly aggregation)

```sql
SELECT cell_key,
       toDate(exit_ts) AS day,
       sum(realized_pnl_usd) AS realized_pnl_usd,
       count() AS closed_trade_count
FROM quantlab.live_trades FINAL
WHERE source IN ('paper', 'live')
  AND exit_ts IS NOT NULL
  AND toDate(exit_ts) >= toDate(<refDate> - INTERVAL <windowDays - 1> DAY)
  AND toDate(exit_ts) <= toDate(<refDate>)
  AND cell_key IN (<cellKeys>)
GROUP BY cell_key, day
ORDER BY cell_key, day
```

`FINAL` ensures deduplication on the `ReplacingMergeTree`-style table per session-55 conventions.

### §8.2 Log-return computation

For each cell, on each day in the window:
- `daily_pnl_usd = sum(realized_pnl_usd)` from the SQL above (0 if no row for that day)
- `daily_return = daily_pnl_usd / cellCapitalUsd_atEntry_proxy`

**Proxy for `cellCapitalUsd_atEntry`** (the per-cell deployed capital at the time of the trade entry): use the most recent `cell_weights_history` row at-or-before that day's date, joined to the active `stage_state_history` row's `totalCapitalUsd × weight`. If `cell_weights_history` is empty (cold start — no prior runs persisted weights yet), the proxy falls back to `LIQUID_BUCKET_USD × stage.allocationPct / numCells` (T0 equal-weight against the historical stage-active-on-that-day).

**Rationale:** dollar-denominated P&L is not directly comparable across days where the cell capital changed. Log-returns normalize this. The proxy is imperfect — it assumes the historical stage and weights persisted across the day — but is good enough for variance estimation (variance is invariant to constant scaling, and intra-day capital changes are rare in this system).

**Sensitivity check:** for the operationally-relevant range (T1 in stage 1, paper trading), `cellCapitalUsd` is constant at `LIQUID_BUCKET_USD = $10_000` and the proxy is exact. The complexity matters only once the stage state machine actively promotes/rolls back, by which time `cell_weights_history` is populated.

### §8.3 Date alignment

The output `dailyReturns` is keyed by `cellKey`, valued by an array of length `windowDays`. Index 0 = `refDate - (windowDays - 1)`; index `windowDays - 1` = `refDate`. Days with no closed-trade row in the SQL output are zero-filled.

### §8.4 Zero-fill rationale (RESEARCH §7 deferred decision)

A day with no closed trade has `realized_pnl_usd = 0` (no realization) → `daily_return = 0`. This is the **honest realized-only convention**: variance reflects what the cell HAS realized, not what it MIGHT realize if open positions were marked to market.

Forward-fill (carry forward the most recent non-zero return) would be wrong: it would propagate a single non-zero P&L into every subsequent zero-trade day's variance computation, inflating apparent variance for slow-trading cells.

This convention has a known side effect: slow-trading cells (multi-day-hold strategies) get many zero-fill days punctuated by occasional large realizations. Their σᵢ² is high; IVW weights them DOWN. The bias is conservative (under-allocates to slow traders) and revisitable if it materially hurts performance — the §15 watch-outs flag this.

### §8.5 Caching policy

NONE. The query runs once per daemon run; no cross-run cache. CH query is cheap (single `live_trades` scan with date filter, ~ms latency at expected row volumes through 2027). If brief render hot-path becomes a bottleneck, add a per-process LRU cache keyed by `(cellKeys, refDate)` — but only after observing the bottleneck.

---

## 9. Daemon orchestrator wire-up

### §9.1 New helper `resolveCellWeightsForRun`

Lives in `src/server/per_cell_capital.ts` (same module as `resolvePerCellSizingForRun` — they're peers in the orchestration sequence).

```ts
interface ResolveCellWeightsInputs {
  cellKeys: readonly string[];
  refDate: Date;
  /** From `cell_weights_history` lookup; null if no prior run. */
  priorActiveTier: 'T0' | 'T1' | 'T2' | null;
  /** Test injection — defaults to `getCellDailyReturns` with the live CH client. */
  fetchDailyReturns?: (
    input: { cellKeys: readonly string[]; windowDays: number; refDate: Date },
  ) => Promise<GetCellDailyReturnsResult>;
}

interface ResolveCellWeightsResult {
  /** Pass-through from `computeCellWeights`. */
  tierActive: 'T0' | 'T1' | 'T2';
  weights: ReadonlyMap<string, number>;
  observedDaysWithTrades: number;
  observedN: number;
  observedMinClosedTrades: number;
  ratchetHeld: boolean;
  /** True iff CH unavailable / data fetch threw (§9.6). */
  degraded: boolean;
  /** Single-line operator log per §9.5. */
  logLine: string;
}
```

The orchestrator:

1. Calls `getCellDailyReturns({ cellKeys, windowDays: ROLLING_WINDOW_DAYS_T2, refDate })` — always queries the larger window so the same result supports both T1 evaluation (slice the last 90) and T2 evaluation (full 180).
2. Calls `computeCellWeights({ cellKeys, dailyReturns: result.dailyReturns, closedTradeCounts: result.closedTradeCounts, tier: 'auto', priorActiveTier })`.
3. Formats the log line per §9.5.

### §9.2 Extension to `resolvePerCellSizingForRun`

Add an OPTIONAL field to `ResolvePerCellSizingResult`:

```ts
interface ResolvePerCellSizingResult {
  // ... existing fields ...
  /**
   * Per-cell capital values, keyed by cellKey. Replaces the single
   * `perCellCapital.cellCapitalUsd` value for per-cell-loop consumption.
   * Each entry is `perCellCapital.totalCapitalUsd × weights[cellKey]`,
   * with the existing HALT zeroing applied. NULL when `cellWeights` is
   * not provided (backward-compatible fallback to equal-weight via
   * existing `perCellCapital.cellCapitalUsd`).
   */
  perCellCapitalByCell: ReadonlyMap<string, number> | null;
}
```

`resolvePerCellSizingForRun` gains an optional input:

```ts
interface ResolvePerCellSizingInputs {
  // ... existing fields ...
  /** From `resolveCellWeightsForRun`. When omitted, falls back to existing equal-weight semantic. */
  cellWeights?: ResolveCellWeightsResult;
}
```

When `cellWeights` is provided, the orchestrator:
1. Computes `perCellCapital` as today (the stage-aware total split equally — for legacy-consumer compatibility this single value remains the "average per-cell" reference).
2. Computes `perCellCapitalByCell[cellKey] = perCellCapital.totalCapitalUsd × cellWeights.weights.get(cellKey)`.
3. If `perCellCapital.haltedZeroed === true`, every entry of `perCellCapitalByCell` is zeroed.

### §9.3 Per-cell-loop substitution in `daily_signal_daemon.ts`

```diff
- totalCapital: perCellCapital.totalCapitalUsd,
- cellCapital: perCellCapital.cellCapitalUsd,
+ totalCapital: perCellCapital.totalCapitalUsd,
+ cellCapital: resolvePerCellCellCapital(perCellCapital, perCellCapitalByCell, rt.cellKey),
```

Where `resolvePerCellCellCapital` is a pure helper exported alongside `resolvePerCellSizingForRun`:

```ts
export function resolvePerCellCellCapital(
  perCellCapital: ComputePerCellCapitalResult,
  perCellCapitalByCell: ReadonlyMap<string, number> | null,
  cellKey: string,
): number {
  // Legacy path — no cellWeights provided; existing equal-weight behavior.
  if (perCellCapitalByCell === null) {
    return perCellCapital.cellCapitalUsd;
  }
  // Per-cell-weights path — the contract guarantees every cellKey is in the map.
  // A missing key is a wire-up bug (mismatch between cellRuntimes and the
  // cellKeys passed to resolveCellWeightsForRun); throw loudly rather than
  // fall back to equal-weight, which would silently over-allocate one cell
  // and break ADR-040 pre-commitment. (H-3 fix.)
  const value = perCellCapitalByCell.get(cellKey);
  if (value === undefined) {
    throw new Error(
      `resolvePerCellCellCapital: cellKey "${cellKey}" missing from perCellCapitalByCell ` +
        `(map has keys: ${Array.from(perCellCapitalByCell.keys()).join(', ')}). ` +
        `Wire-up bug — cellRuntimes contains a cell that was not weighted.`,
    );
  }
  return value;
}
```

**The throw is load-bearing.** §7 explicitly disavows silent fallbacks for the pure helper — this composition seam deserves the same discipline. An earlier draft used `??` fallback, which would have silently given the missing cell the equal-weight capital (potentially OVER-allocating a cell that should have received e.g. 0.2 of total) and broken the HALT zeroing for that cell. Pinned in test #ORCH-MISMATCH.

### §9.4 Order of operations in the daemon

```text
1. Stage state eval → stageEvalResult                  (existing)
2. Cell weights resolution → cellWeightsResult         (NEW — this slice)
3. Per-cell sizing resolution → perCellSizingResult    (extended — this slice)
4. Persist cell_weights_history row                     (NEW — this slice)
5. for (const rt of cellRuntimes) processCellLiveTrades (existing)
```

Step 4 writes ONE row to `cell_weights_history` AFTER the per-cell loop completes successfully (so a failed run doesn't pollute the audit log). DEGRADED runs DO write a row (with `degraded=1`) — they succeeded operationally, they just bypassed the tier ladder; the §11.2 lookup query filters DEGRADED rows out at read time, NOT at write time. Schema in §11.

### §9.5 Daemon log line

```text
[cell-weights] tier=T1 cells=2 weights=mean_reversion_v1__p14:0.667,trend_v1__p30:0.333 obsDaysWithTrades=92 minClosedTrades=42 ratchetHeld=no
```

Always six fields, always this order, always these separators. Tests pin against a byte-equal string (not regex), so any format drift surfaces as a test failure (same discipline as `formatEvaluatorCapitalLogLine` in `per_cell_capital.ts`).

`obsDaysWithTrades` is the §3-trigger-authoritative metric — the count of days in the window where the cell with the FEWEST trade-active days had at least one closed trade. (NOT the calendar window length, which is fixed at 180.)

Format expressed as a pure helper `formatCellWeightsLogLine(result: ResolveCellWeightsResult): string` so daemon and tests share one source of truth.

**Weight rendering:** `cellKey:weight.toFixed(3)` in cellKeys-input order, comma-separated. `0.667` (3 dp) gives operator-readable precision without false precision.

### §9.6 Graceful degrade

If `getCellDailyReturns` throws (CH outage, table absent), `resolveCellWeightsForRun` catches, returns `tierActive='T0', weights={uniform}, ratchetHeld=false, degraded=true`, and logs:

```text
[cell-weights] tier=T0 cells=2 weights=mean_reversion_v1__p14:0.500,trend_v1__p30:0.500 obsDaysWithTrades=0 minClosedTrades=0 ratchetHeld=no  (DEGRADED: CH unavailable)
```

The DEGRADED suffix is the operator-visible signal that the trigger ladder was bypassed due to infrastructure failure, not because the sample is genuinely thin. This is the failure mode where equal-weight is the right fallback — it's the conservative default that ADR-039 §1 already authorizes for stage allocation under uncertainty.

**The DEGRADED row IS still persisted to `cell_weights_history`** with `degraded=1`, so the audit log captures the outage event. The §11.2 prior-tier lookup filters `WHERE degraded = 0`, so the persisted DEGRADED row does NOT poison the next run's ratchet — it is forensic-only. (H-2 fix.) Without this discipline, a single CH outage would silently downgrade a T1- or T2-active system to T0 on the next run.

---

## 10. Brief panel surface

### §10.1 New fields on `BriefStageSection`

Add:

```ts
cellWeightsTier: 'T0' | 'T1' | 'T2';
cellWeightsObservedDaysWithTrades: number;
cellWeightsObservedMinClosedTrades: number;
cellWeightsRatchetHeld: boolean;
cellWeightsByCell: ReadonlyMap<string, number>;
cellWeightsDegraded: boolean;
```

### §10.2 Source of truth

Re-compute at brief time, NOT persisted on `stage_state_history`. Same discipline as per-cell-stage-sizing.md §9.2 — operationally-visible numbers reflect CURRENT configuration. The brief composer calls `resolveCellWeightsForRun` directly with the same module-pinned constants the daemon uses.

The `cell_weights_history` table (§11) is for the helper's prior-tier lookup, NOT for brief rendering of past runs. The brief renders the CURRENT-as-of-now weights.

### §10.3 Renderer

`renderStageSection` appends a one-line tier summary right under the existing `deployed=$X.XX across N cells (cellCap=$Y.YY each)` line.

- **T0:** `weighting=equal (T0, obsDays=0, minTrades=0)`
- **T1:** `weighting=IVW (T1, obsDays=92, minTrades=42) — mean_reversion_v1__p14:0.667 / trend_v1__p30:0.333`
- **T2:** `weighting=HRP (T2, obsDays=180, minTrades=78) — mean_reversion_v1__p14:0.310 / trend_v1__p30:0.220 / mr_v2__p21:0.245 / trend_v2__p60:0.225`
- **Ratchet held:** trailing `[ratchet:T1 held]` suffix
- **DEGRADED:** trailing `[DEGRADED: CH unavailable]` suffix

When `halted === true`, the weighting line is OMITTED — the `(cellCap=$0.00 — HALT)` line communicates that the weights are operationally moot.

Byte-pinned by extensions to `operatorBriefRender.test.ts`.

---

## 11. New table `cell_weights_history`

CH schema (single new migration, idempotent — bootstrap-only per session-66 convention):

```sql
CREATE TABLE IF NOT EXISTS quantlab.cell_weights_history (
  run_ts          DateTime64(3, 'UTC'),
  ref_date        Date,
  tier_active     Enum8('T0' = 0, 'T1' = 1, 'T2' = 2),
  cell_keys_json  String,                -- JSON-stringified array, in input order
  weights_json    String,                -- JSON-stringified {cellKey: weight, ...}
  observed_days_with_trades UInt32,
  observed_n      UInt32,
  observed_min_closed_trades UInt32,
  ratchet_held    UInt8,                 -- 0 / 1
  degraded        UInt8,                 -- 0 / 1 — DEGRADED rows are filtered out of the prior-tier lookup (§11.2)
  daemon_run_id   String,                -- joins to existing daemon-run audit; dedup key for ReplacingMergeTree
  version         UInt32 DEFAULT toUInt32(toUnixTimestamp64Milli(run_ts))
) ENGINE = ReplacingMergeTree(version)
ORDER BY (ref_date, daemon_run_id);
```

**`ReplacingMergeTree(version)`**, not plain `MergeTree`. The `daemon_run_id` is the dedup key (`ORDER BY` second column); the `version` column resolves which row wins on retry. Retries within a single daemon run (same `daemon_run_id`) collapse to the highest-version row at next merge. `MergeTree` + `FINAL` would have been a no-op (M-3 fix).

**Why JSON-string columns and not arrays?** CH `Array(Tuple(String, Float64))` would be schema-cleaner but harder to extend (e.g. adding per-cell diagnostics later). JSON-strings keep the schema flat; the helper parses on read. Read volume is at most one row per daemon run; parse cost negligible.

**`cell_keys_json` is audit-only** (L-2). No production read path consumes it; the prior-tier lookup §11.2 returns only `tier_active`. The column exists for post-hoc forensics on tier-change events ("which cells were active when we ratcheted T1→T2?").

### §11.2 Prior-tier lookup query (used by `resolveCellWeightsForRun`)

```sql
SELECT tier_active
FROM quantlab.cell_weights_history FINAL
WHERE ref_date <= <currentRefDate>
  AND degraded = 0
ORDER BY run_ts DESC
LIMIT 1
```

**The `degraded = 0` filter is load-bearing** (H-2 fix). On a CH-outage day, §9.6 records `tier_active='T0'` AND `degraded=1`. Without the filter, the next run's lookup would return `T0` as `priorActiveTier`, breaking the ratchet's "ensures we don't downgrade because of one bad run" guarantee.

Empty result (cold start OR every prior row is DEGRADED) → `priorActiveTier = null`. Per §6.4 the ratchet rule treats `null` as "no prior history" → starts at T0; this is correct because the system has no live record of ever having achieved T1/T2.

`FINAL` is kept here because `ReplacingMergeTree` does honor it for read-time collapse (single-row LIMIT 1 will get the latest version of the most recent `(ref_date, daemon_run_id)` tuple). On a quiet cluster the merge may not have happened yet; `FINAL` makes the lookup deterministic.

**Idempotent migration script:** `scripts/migrate_cell_weights_history.ts` (dry-run) + `:apply` variant, pattern from session-55+57 stage-state/kill-criteria migrations. Help entry: `npm run migrate:cell-weights-history` + `:apply`.

---

## 12. Test plan (`scripts/tests/cellWeights.test.ts`)

All run via `node --import tsx --test`. Total: **56 numbered tests in `cellWeights.test.ts`** (T0-1 through 50c — including the 6 critic-fix-added tests 28a, 28b, 36a, 50a, 50b, 50c) + 5 numbered extensions to `operatorBriefRender.test.ts` (51-55) + 1 migration smoke test (56). (L-5 reconciliation post-critic-fix.)

### Pure helper `computeCellWeights` — T0 forced

1. **T0-1.** `tier='T0', N=1` → `weights={a:1.0}, tierActive='T0'`
2. **T0-2.** `tier='T0', N=2` → `weights={a:0.5, b:0.5}`
3. **T0-3.** `tier='T0', N=4` → `weights={a:0.25, b:0.25, c:0.25, d:0.25}`
4. **T0-4.** `tier='T0', N=3` → `weights[a]+weights[b]+weights[c] === 1.0` (sum invariant)

### Pure helper `computeCellWeights` — T1 forced

5. **T1-1.** N=2, σ²={a:1.0, b:1.0} → `weights={a:0.5, b:0.5}` (equal variance = equal weight)
6. **T1-2.** N=2, σ²={a:1.0, b:2.0} → `weights={a:0.6667, b:0.3333}` (within 1e-4) — IVW closed-form pin: `w_a = σ_b² / (σ_a² + σ_b²) = 2/3`
7. **T1-3.** N=2, σ²={a:4.0, b:1.0} → `weights={a:0.20, b:0.80}` — large variance differential
8. **T1-4.** N=4, σ²={a:1, b:1, c:1, d:4} → `weights={a:0.3077, b:0.3077, c:0.3077, d:0.0769}` (per RESEARCH §4.1 formula)
9. **T1-5.** Variance computed Bessel-corrected (ddof=1) — fixture series `[1, 2, 3, 4, 5]` should give σ² = 2.5, NOT 2.0
10. **T1-6.** N=1 + tier='T1' → throws `/T1.*N.*2/i`
11. **T1-7.** σ²<1e-12 (all-zeros series) → throws `/variance/i`

### Pure helper `computeCellWeights` — T2 forced (against Python reference fixture)

12. **T2-1.** Fixture: N=4, T=200, known correlation block-structure (two pairs of correlated cells) → `weights` agree with `_compute_cell_weights_reference.py` output to 1e-9
13. **T2-2.** Fixture: N=4, T=180, all-uncorrelated cells → HRP ≈ IVW (collapse case)
14. **T2-3.** Fixture: N=6, T=200, single outlier cell → leaf-ordering uses ALPHABETICAL cellKey tiebreak; weights pin against reference
15. **T2-4.** N=1 + tier='T2' → throws `/T2.*N.*2/i`
16. **T2-5.** N=3 + tier='T2' (forced below T2 trigger N≥4) → SHOULD STILL EXECUTE (forced-tier bypasses trigger; pin that the math runs at N=3) — fixture against reference
17. **T2-6.** Weight sum invariant for all T2 fixtures: `Σ weights[i] = 1.0 ± 1e-9`

### `selectCellWeightsTier` — trigger conditions

(`obsDays` = `observedDaysWithTrades` per §3 / §6.4 — NOT calendar window length.)

18. **TRIG-1.** N=2, obsDays=89, trades=30, prior=null → `'T0'` (obsDays just below)
19. **TRIG-2.** N=2, obsDays=90, trades=29, prior=null → `'T0'` (trades just below)
20. **TRIG-3.** N=1, obsDays=90, trades=30, prior=null → `'T0'` (N below)
21. **TRIG-4.** N=2, obsDays=90, trades=30, prior=null → `'T1'` (just at thresholds)
22. **TRIG-5.** N=4, obsDays=180, trades=60, prior=null → `'T2'` (just at T2 thresholds)
23. **TRIG-6.** N=4, obsDays=179, trades=60, prior=null → `'T1'` (T2 obsDays just below; T1 satisfied)
24. **TRIG-7.** N=3, obsDays=180, trades=60, prior=null → `'T1'` (T2 N below; T1 satisfied)
25. **TRIG-8.** N=2, obsDays=30, trades=10, prior='T1' → `'T1'` (ratchet holds — sample dropped, would have been T0)
26. **TRIG-9.** N=4, obsDays=30, trades=10, prior='T2' → `'T2'` (ratchet holds T2 even with thin sample; N=4 retained — note: TRIG-9 with N=2 would imply cells removed after T2 activated, which is itself a re-baselining event covered by RATCHET-N-CHANGE below)
27. **TRIG-10.** N=4, obsDays=180, trades=60, prior='T2' → `'T2'` (trigger says T2, prior is T2 → T2)
28. **TRIG-11.** N=2, obsDays=90, trades=30, prior='T0' → `'T1'` (trigger upgrades from T0)
28a. **TRIG-DATA.** (H-1 byte-pin.) Synthesized full pipeline test: `dailyReturns` series of length 180 (zero-filled, `dailyReturns[cell].length === 180` for both cells), `closedTradeCounts={a:5, b:5}`, `observedDays={a:3, b:3}`, prior=null → `tierActive='T0'` (gated by `observedDaysWithTrades=3 < 90`, NOT by series length). This pins that a 3-day-old paper-trading deployment does NOT trip T1 just because the SQL has fetched 180 zero-filled days of history.
28b. **RATCHET-N-CHANGE.** N transitions from 4 → 2 between runs (cell removed). Run 1: N=4, obsDays=180, trades=60, prior='T1' → tier='T2' (upgrades). Run 2: N=2, obsDays=180, trades=60, prior='T2' → tier='T2' (ratchet holds T2, but the T2 math at N=2 collapses to IVW per RESEARCH §4.2 — pin that the helper still executes cleanly).

### `computeCellWeights` — auto-tier with ratchet

29. **AUTO-1.** `tier='auto', priorActiveTier='T1'` but sample thin (T=30) → `tierActive='T1', ratchetHeld=true` (returns IVW computed on the thin sample — operator-visible warning via ratchetHeld)
30. **AUTO-2.** `tier='auto', priorActiveTier=null, N=2, T=90, trades=30` → `tierActive='T1', ratchetHeld=false`
31. **AUTO-3.** `tier='auto', priorActiveTier=null, N=2, T=5` → `tierActive='T0', ratchetHeld=false`

### Edge-case throws (§7)

32. **EDGE-1.** `cellKeys=[]` → throws `/cellKeys/i`
33. **EDGE-2.** `cellKeys=['a','a']` (duplicate) → throws `/duplicate/i`
34. **EDGE-3.** `cellKeys=['a','b']` but `dailyReturns={a:[...]}` (missing 'b') → throws `/missing/i`
35. **EDGE-4.** Series length mismatch → throws `/length/i`
36. **EDGE-5.** Non-finite in series → throws `/non-finite/i`
36a. **EDGE-6.** `tier='T0', cellKeys=['a','b'], dailyReturns={a:[], b:[]}, closedTradeCounts={a:0, b:0}, observedDays={a:0, b:0}` → returns `{tierActive:'T0', weights:{a:0.5, b:0.5}, observedDaysWithTrades:0}` WITHOUT throwing. (M-6 fix — cold-start path: paper-only with no closed trades is the most-exercised production state today. Must not throw.)

### Data accessor `getCellDailyReturns` (with injected executor)

37. **DATA-1.** Mock SQL returns 2 cells × 5 days each → zero-fill produces 2 cells × `windowDays` arrays
38. **DATA-2.** Mock returns one cell only → other cell's series is all zeros, length `windowDays`
39. **DATA-3.** Mock returns rows outside the window → throws or silently filters? Pin: helper trusts SQL date filter, does not re-validate.
40. **DATA-4.** `cellKeys` ordering pin: result Map iteration matches input order.

### `formatCellWeightsLogLine` — byte-pinned format

41. **LOG-1.** T0, N=2 → `[cell-weights] tier=T0 cells=2 weights=mr_v1:0.500,trend_v1:0.500 T=0 minClosedTrades=0 ratchetHeld=no`
42. **LOG-2.** T1, N=2, weights {0.667, 0.333} → exact byte-match per §9.5
43. **LOG-3.** Ratchet-held → trailing `ratchetHeld=yes`
44. **LOG-4.** DEGRADED → trailing `  (DEGRADED: CH unavailable)`

### Orchestration `resolveCellWeightsForRun` (with injected `fetchDailyReturns`)

45. **ORCH-1.** Happy path T1 → returns tierActive='T1', weights computed against fetched series
46. **ORCH-2.** `fetchDailyReturns` throws → returns tierActive='T0', `logLine` ends with DEGRADED
47. **ORCH-3.** Prior tier from injected `priorActiveTier='T1'` honored through ratchet

### Integration with `resolvePerCellSizingForRun`

48. **INT-1.** (M-5 byte-pinned regression.) `resolvePerCellSizingForRun({ stageEvalResult: {decision:'hold', stageAfter:'stage1'}, haltSentinelPresent:false, drawdownNewEntriesAllowed:true, numCells:2, liquidBucketUsd:10_000, cellWeights: undefined })` → `result.perCellCapital.totalCapitalUsd === 500 && result.perCellCapital.cellCapitalUsd === 250 && result.perCellCapitalByCell === null`. Identical byte-pin to existing `perCellCapital.test.ts` test #4 — confirms the legacy path is byte-identical to pre-this-slice behavior when `cellWeights` is omitted.
49. **INT-2.** `cellWeights` provided, T1 active with σ²={mr_v1:1.0, trend_v1:2.0} → IVW closed-form `weights={mr_v1: 2/3, trend_v1: 1/3}`. Stage=stage1, bucket=$10k, N=2 → totalCapital=$500. `perCellCapitalByCell={mr_v1: 500 × (2/3) === 333.3333..., trend_v1: 500 × (1/3) === 166.6666...}`. Sum is $500.0 exactly (IEEE 754 preserves the sum because the two values are complementary representations of the same exact rational). Test asserts exact float equality, NOT a rounded approximation.
50. **INT-3.** `cellWeights` provided AND `halted=true` → every entry of `perCellCapitalByCell === 0` (HALT zeros after weighting per §10.3 composition order).
50a. **ORCH-MISMATCH.** (H-3 byte-pin.) `resolvePerCellCellCapital(perCellCapital, perCellCapitalByCell={mr_v1: 333.50}, cellKey='trend_v1')` → throws `/missing from perCellCapitalByCell/i`. Pins that a cellRuntimes/weights-map mismatch is a loud failure, not a silent equal-weight fallback.
50b. **ORCH-LEGACY.** `resolvePerCellCellCapital(perCellCapital, perCellCapitalByCell=null, cellKey='trend_v1')` → returns `perCellCapital.cellCapitalUsd`. Pins legacy-path passthrough.
50c. **DEGRADED-RATCHET.** (H-2 byte-pin.) Two-run sequence: (run 1) prior=null, `fetchDailyReturns` succeeds with T1-eligible data → persisted row tier='T1', degraded=0. (Run 2) prior-tier lookup returns 'T1', `fetchDailyReturns` THROWS → ResolveCellWeightsResult has `tierActive='T0', degraded=true`, but the test ALSO asserts that the §11.2 prior-tier lookup (executed by the test's mock CH client) correctly filters `WHERE degraded=0` and still returns 'T1' for run 3. (Cf. §9.6 / §11.2.)

### Brief renderer extension (`operatorBriefRender.test.ts`)

51. T0 weighting line: `weighting=equal (T0, T=0, minTrades=0)`
52. T1 weighting line with weights enumerated
53. Ratchet-held suffix on the weighting line
54. DEGRADED suffix on the weighting line
55. HALT omits the weighting line entirely

### Migration script test

56. `npm run migrate:cell-weights-history` dry-run prints the CREATE TABLE without applying

---

## 13. ADR-039 / ADR-040 extension flags

This slice introduces ONE policy extension beyond the existing ADR text:

**§13.1 Tier-ladder pre-commitment.** ADR-039 OQ #3 left "intra-stage-allocation split rule" open and deferred to a separate ADR. This SPEC pins:
- The three-tier ladder (T0 → T1 → T2; no skipping; no ERC tier)
- The trigger thresholds (T1: N≥2, T≥90, trades≥30; T2: N≥4, T≥180, trades≥60)
- The source filter (`source IN ('paper', 'live')` only — never `bt_trades`)
- The rolling-window lengths (90d for T1, 180d for T2)
- The ratchet-up-only rule
- The zero-fill convention for zero-trade days
- Realized-only daily returns (MTM deferred — per RESEARCH §5.3 "noisy but unbiased" rationale; §15 watch-out documents the data-dependent bias direction)

All of the above are pinned in source code (`cell_weights.ts`, `cell_pnl_history.ts`) and referenced by the forthcoming ADR-040 entry in `docs/decisions/README.md`. A future amendment changes them via a superseded ADR + code edit.

**§13.2 No other ADR extensions.** Equal-weight (T0) remains operationally identical to per-cell-stage-sizing.md §11.1 — this slice is strict superset. HALT semantic, paper-stage special case, stage-aware totalCapital, drawdown framework composition: all unchanged.

---

## 14. What this slice does NOT change (regression budget)

- **`live_trades` schema:** unchanged. `cell_key`, `realized_pnl_usd`, `source`, `exit_ts` already exist (per migrate_live_trades.ts).
- **`stage_state_history` schema:** unchanged. Weights are NOT persisted there.
- **`kill_criteria_daily` schema:** unchanged.
- **Stage state machine:** unchanged. This slice consumes `stageAfter` + `decision === 'halt'`; does not produce new state-machine inputs.
- **Drawdown framework:** unchanged. `sizingMultiplier` continues to multiply `maxRiskPerTrade`; orthogonal axis.
- **Backtest engine (`runStrategy`):** unchanged. `--use-risk-config` flow independent.
- **Per-trade sizer (`sizePositionFixedRisk`):** unchanged. New `cellCapitalUsd` values come from `perCellCapitalByCell` rather than `perCellCapital.cellCapitalUsd`; the sizer's contract is identical.
- **HALT sentinel mechanic:** unchanged. HALT composes ON TOP of weights (weights → cellCap → HALT zeros).
- **`maxRiskPerTrade`:** unchanged.
- **Allowlist, kill-switch monitor, halt smoke test:** unchanged.
- **`evaluateCell`'s internal `CAPITAL`:** unchanged (same §8.6-style carve-out as per-cell-stage-sizing.md). Evaluator-side capital retargeting (session 62) and useRiskConfig flip (session 63) are independent.

---

## 15. Watch-outs

- **Realized-only daily returns introduce a bias whose direction depends on per-trade magnitude scaling with hold-time.** (M-2 fix — earlier draft asserted a direction without supporting math.) Two competing effects:
  - **Zero-fill effect (DEFLATES sparse-cell variance):** for two cells with equal per-trade σ but different trade frequencies, the sparse trader's daily σ ≈ frequent trader's σ × √(tradingDays/windowDays). Pure zero-fill makes sparse-trader's σ² LOWER → IVW would OVER-allocate to it.
  - **Lumpy-realization effect (INFLATES sparse-cell variance):** a multi-day-hold strategy whose per-realization P&L scales with hold-time has LARGER per-day-of-trading σ than a high-frequency strategy with the same total return — its realized days carry compressed multi-day variance.
  Which effect dominates depends on whether per-trade dollar magnitude scales with hold-time (Kelly-like) or is fixed (per-trade-σ-fixed). For SignalForge's current cells (mr_v1: hours-to-days holds; trend_v1: days-to-weeks holds), the empirical direction is **unknown a priori** and must be measured once live data accumulates. The conservative read: monitor `[cell-weights]` logs for a persistent weight asymmetry that doesn't match the operator's intuition about cell risk, then reopen MTM unrealized P&L as a follow-up slice if the bias materially mis-allocates capital.
- **Tier ratchet locks in a tier even when sample thins.** If a cell pauses for 60 days, `T < 90` and trades drop below 30, BUT the ratchet keeps T1 active using whatever data IS in the window. This is intentional (avoid tier flapping) but means a paused cell continues to contribute its OLD variance estimate to the weighting. Mitigation: the `ratchetHeld=yes` log/brief signal is the operator's cue to consider whether to disable the paused cell entirely (which would be a re-baselining event — see next bullet).
- **Adding/removing a cell mid-stage is a re-baselining event.** Weights recompute over the new cell set. Existing cells will see their capital shift on the next daemon run. This is the same equal-weight behavior described in per-cell-stage-sizing.md §3; the IVW/HRP rules ALSO recompute over the new set. No smoothing across cell-set changes — by design.
- **The `cellCapitalUsd_atEntry` proxy in §8.2 is only as good as `cell_weights_history`.** Before this slice's first deployment, `cell_weights_history` is empty; the proxy falls back to T0 equal-weight historically. That's correct, because pre-this-slice WAS equal-weight. After this slice ships, every daemon run persists a row; the proxy becomes exact.
- **The 90-day window naturally smooths weights, but a single fat-tail day can still shift IVW noticeably.** A 5% daily loss in cell A on day N+1 adds ~0.0025 to σ_A² (assuming σ_A ≈ 1% baseline). σ_A² shifts from ~1e-4 to ~3.5e-4 — a 3.5× variance estimate jump from a single day. w_A under N=2 with σ_B² unchanged at 1e-4 shifts from 0.5 to ~0.22. **That's a 28pp weight swing from one day.** The §2 non-goal explicitly defers smoothing; this is the watch-out for the operator to consider whether smoothing should be reopened if observed in production.
- **HRP's single-linkage clustering is sensitive to outliers** (AFML §16.4.3). For our N≤8 regime this is manageable but the Python reference + fixture pinning is the only thing keeping the TS implementation matched. **Do NOT rewrite the HRP math without re-generating fixtures from `_compute_cell_weights_reference.py` and comparing byte-for-byte.**
- **`cell_weights_history` table is the prior-tier source of truth.** A future contributor who "cleans up" by truncating or dropping the table will cause the next daemon run to reset to T0 (cold start) and the ratchet to lose its memory. Operator-side disaster recovery should treat this table as load-bearing — back it up alongside `live_trades` and `stage_state_history`.
- **The DEGRADED fallback (§9.6) is OPERATIONALLY SILENT except for the log line / brief suffix.** A CH outage during a daemon run produces equal-weight allocation that day; the persisted `cell_weights_history` row carries `degraded=1`, and the §11.2 lookup filters those rows out, so the NEXT daemon run with CH restored re-reads the last NON-DEGRADED row as `priorActiveTier` and the ratchet correctly resumes from there. Operators must watch for repeated DEGRADED suffixes — that's the signal that CH is unreliable, not just a transient. If MANY consecutive runs are DEGRADED, the prior-tier lookup will eventually exhaust non-DEGRADED history (cold-start fallback) and the system will genuinely reset to T0 — at that point CH reliability is the operational gate, not this slice.
- **`source IN ('paper', 'live')` filter assumes paper and live executions are statistically equivalent for variance estimation.** They use the same code path, same risk model, same sizer — but paper's small notional ($10k bucket vs. eventually a larger real-money bucket) might produce subtly different fill behavior under stress. The §3 SOURCE_FILTER constant is pinned, but a future amendment could split to `live` only when sufficient `live` data exists. Until then, mixing is documented and accepted.
- **`computeCellWeights` is a ~150-line module. Resist inlining.** Same discipline as per-cell-stage-sizing.md §14 — the helper exists primarily as a TEST SURFACE. Pinning the trigger ladder, IVW math, HRP fixtures, and ratchet rule in one place is the audit anchor for ADR-040's pre-commitment.

---

## 16. Done criteria

1. `src/server/cell_weights.ts` exists with `computeCellWeights`, `selectCellWeightsTier`, `formatCellWeightsLogLine`, and the pinned constants (`TIER_TRIGGERS`, `ROLLING_WINDOW_DAYS_T1`, `ROLLING_WINDOW_DAYS_T2`, `SOURCE_FILTER`) exported.
2. `src/server/cell_pnl_history.ts` exists with `getCellDailyReturns` (default executor uses the live CH client; tests inject a mock).
3. `scripts/_compute_cell_weights_reference.py` exists; emits JSON-in, JSON-out HRP fixtures via scipy/numpy. Three committed fixtures under `scripts/tests/fixtures/cell_weights/`.
4. `src/server/per_cell_capital.ts` extended: `resolveCellWeightsForRun` exported; `resolvePerCellSizingForRun` accepts optional `cellWeights` input and emits `perCellCapitalByCell` output.
5. `scripts/tests/cellWeights.test.ts` exists with the 56 numbered tests of §12 (T0-1 through 50c); all pass via `node --import tsx --test`.
6. `scripts/tests/perCellCapital.test.ts` extended with 3 new tests pinning the `cellWeights`-provided integration path (§12 tests INT-1/2/3).
7. `scripts/tests/operatorBriefRender.test.ts` extended with 5 new tests (§12 tests 51-55).
8. `scripts/daily_signal_daemon.ts` calls `resolveCellWeightsForRun` once per run, passes the result to `resolvePerCellSizingForRun`, persists `cell_weights_history` row AFTER the per-cell loop succeeds, routes `perCellCapitalByCell[cellKey]` into each `processCellLiveTrades.cellCapital` argument.
9. `[cell-weights] …` log line appears in daemon stdout per §9.5.
10. `BriefStageSection` carries the six new fields; `renderStageSection` shows the weighting line per §10.3.
11. `scripts/migrate_cell_weights_history.ts` exists (dry-run + `:apply`); `package.json` exposes `npm run migrate:cell-weights-history` and `:apply` with `help` exports per session-66 conventions.
12. `npm test` shows no new regressions in files this slice touches. Pre-existing failing tests (CH-state-dependent macro fixtures) remain unchanged.
13. `npx tsc --noEmit` error count ≤ session-67 baseline (13).
14. `npm run check:help` GREEN; `npm run help` clean.
15. `npm run daemon:daily:dry` manual smoke shows the new `[cell-weights]` log line firing with T0 weighting (since no live data exists yet — the trigger ladder correctly returns T0).
16. ADR-040 entry written into `docs/decisions/README.md` after SPEC + CODE land — points at this SPEC, pins the policy in ADR language.
17. HANDOFF rewritten at session boundary.

---

## 17. Out-of-scope / deferred (companion to §2)

- **Cross-strategy correlation cap on TOTAL exposure** (ADR-039 deferred — not OQ #3; a separate cap idea).
- **Operator-set per-cell weights override** (per §2 non-goal; same ADR-039 §6 reasoning).
- **Meucci ENB diagnostic on brief panel** (RESEARCH §4.5 — separable slice; could ship as a "weighting line +1: ENB=1.18" addition).
- **Daily MTM unrealized P&L in daily returns** (per §15 watch-out; reopen if realized-only obscures variance).
- **Weight smoothing across cycles** (per §2 non-goal; reopen if oscillation observed).
- **Materialized `cell_daily_pnl` table** (RESEARCH §5.2 Option B; reopen if Option A query becomes a bottleneck).
- **Ratchet-DOWN rule** (per §3; intentional non-feature — change via superseded ADR).
- **Per-cell weights in `stage_state_history`** (per §10.2; re-derive at brief, don't persist twice).
- **Operator CLI override for tier** (per §15 — anti-pre-commitment).
- **Cross-cell concentration limits** (RESEARCH §1 — separate problem from allocation rule).
- **Brief composer integration test as a dedicated file** (per per-cell-stage-sizing.md §15 precedent — the §12 test 51-55 extensions cover the surface).
- **Daemon-integration test for the wire-up** (per per-cell-stage-sizing.md §15 precedent — pure-helper tests + manual smoke are the current control).

---

## 18. Why this slice closes ADR-039 OQ #3 end-to-end

Before this slice:

```text
ADR-039 §1: "stage 1 = 5% of liquid bucket" ✓ pinned
SPEC per-cell-stage-sizing.md §11.1: equal-weight split ✓ pinned (T0)
ADR-039 OQ #3: "intra-stage split rule when N≥2"     ✗ deferred to ADR-040
```

After this slice (SPEC + CODE):

```text
ADR-039 §1: "stage 1 = 5% of liquid bucket"          ✓ pinned (unchanged)
SPEC correlation-weighted-…md §3: T0/T1/T2 ladder    ✓ pinned (NEW)
ADR-040 entry: policy pre-committed                  ✓ pinned (in `docs/decisions/README.md`)
                                                       — text short; SPEC carries detail
cell_weights.ts: TIER_TRIGGERS + IVW + HRP math      ✓ shipped (NEW)
cell_weights_history table: prior-tier audit         ✓ shipped (NEW)
Daemon: [cell-weights] line every run                ✓ shipped (NEW)
Brief: weighting line under deployed line            ✓ shipped (NEW)
```

The operational behavior today (T0 equal-weight, since live data is ~3 days) is unchanged. The POLICY is pinned ahead of time, per ADR-039 §6 pre-commitment ethos. When the trigger conditions fire (T1 no earlier than ~2026-08-29 under the earliest paper-to-stage1 path), the helper auto-activates without any operator decision in the moment. **That's the ADR-040 payoff window.**

The only remaining ADR-039 / ADR-040 open items after this slice:
- **ADR-039 operator sign-off** (hard deadline 2026-06-29) — unaffected by this slice
- **Real-money flip** — independent, gated by operator decisions on `live` source plumbing
- **Stage-2+ activation** — earliest ~2026-09-29 under the perfectly-aligned path
- **T1 auto-activation** — naturally follows once paper trading accumulates 90 days + 30 closed trades per cell

This SPEC pins the contract; CODE follows in the next ~1-2 sessions.

---

## 17. Critic-fix addendum (session 68 component-done review)

The Vector Core component-done critic (run as a general-purpose subagent per the autonomous-progression rule) returned **FIX-THEN-SHIP** with 3 HIGH + 6 MEDIUM + 5 LOW findings. All HIGH and MEDIUM addressed in-SPEC before CODE starts; LOW addressed where trivially applicable. Resolution log:

**H-1 — `observedT` trigger threshold meaningless because zero-fill pads every cell to `windowDays`.** Pre-fix: §3 trigger said `min(perCellObservedT) ≥ 90` and §5 defined `observedT: min across cells of dailyReturns[cell].length`. But §8.3 zero-fills every series to `windowDays = 180`; therefore `observedT === 180` from the very first daemon run, making the trigger fire on day-1 paper trading. The trigger was supposed to encode AFML §16.4.5 "fall back to equal-weight when sample is too thin," but did not. **Resolution:** added `observedDays` field to §4 inputs (sourced from `getCellDailyReturns.observedDays` — count of days WITH at least one closed trade). Renamed `observedT` → `observedDaysWithTrades` throughout (§3, §5, §6.4, §9.1, §9.5, §10.1, §10.3). Added test TRIG-DATA (28a): synthesized full pipeline with `dailyReturns.length === 180` BUT `observedDays === 3` → `tierActive='T0'`. Updated TIER_TRIGGERS constant `minObservedT` → `minDaysWithTrades`.

**H-2 — DEGRADED fallback (§9.6) silently broke the ratchet by persisting `tier_active='T0'` to `cell_weights_history`.** Pre-fix: a single CH-outage day would write a DEGRADED row; §11 lookup `ORDER BY run_ts DESC LIMIT 1` would return that row as `priorActiveTier='T0'` on the NEXT run; the ratchet would lose its T1/T2 memory. §15 watch-out's claim "the ratchet ensures we don't downgrade because of one bad run" was WRONG as originally specified. **Resolution:** §11 schema renamed to §11 + new §11.2, with the lookup query gaining `WHERE degraded = 0` so DEGRADED rows are filtered at READ time but preserved for audit. §9.6 + §9.4 step 4 + §15 updated to document the "write all rows, filter on read" discipline. Added test DEGRADED-RATCHET (50c) pinning the three-run sequence.

**H-3 — §9.3 daemon substitution used `?? perCellCapital.cellCapitalUsd` silent fallback, masking wire-up bugs §7 forbids.** Pre-fix: `perCellCapitalByCell.get(rt.cellKey) ?? perCellCapital.cellCapitalUsd` would silently give a missing cell the equal-weight capital, potentially OVER-allocating a cell that should have received e.g. 0.2 of total — and breaking HALT zeroing. **Resolution:** extracted `resolvePerCellCellCapital` pure helper that throws on missing keys when `perCellCapitalByCell !== null`. §9.3 diff updated to use the helper. Added test ORCH-MISMATCH (50a) byte-pinning the throw, and test ORCH-LEGACY (50b) pinning the legacy-path passthrough.

**M-1 — §6.3.1 conflated single-linkage tie-break with leaf ordering and mis-cited the canonical procedure.** Pre-fix: "rebrand the AFML quasi-diagonalization to use ALPHABETICAL cellKey ordering as the tie-breaker" was implementation-ambiguous — `getQuasiDiag` derives leaf order deterministically from the linkage matrix; the tie-break decision lives one level up at `linkage(method='single')`. **Resolution:** §6.3 + §6.3.1 rewritten to specify the alphabetize-INPUT canonicalization (sort `cellKeys` alphabetically before constructing the distance matrix passed to linkage), cite AFML Snippet 16.2 / 16.3 / 16.4 by number, and pin the output-weights-keyed-by-original-cellKeys-order invariant. Fixture count bumped from 3 to 5 (added: collapse-to-IVW at N=2, non-alphabetical-input canonicalization pin).

**M-2 — §15 first watch-out asserted bias direction without supporting math.** Pre-fix: "zero-fill days inflate σᵢ² and IVW down-weights it" — but under pure zero-fill, the sparse trader's σ² is LOWER, not higher (variance scales with √(tradingDays/windowDays)). The text contradicted itself between sentences. **Resolution:** §15 first bullet rewritten to acknowledge TWO competing effects (zero-fill DEFLATES; lumpy-realization INFLATES) and that the net direction depends on per-trade magnitude scaling with hold-time — UNKNOWN a priori for SignalForge cells. Conservative read: monitor logs for unexpected asymmetry; reopen MTM as follow-up if measured bias mis-allocates capital.

**M-3 — `MergeTree` schema with `FINAL` in the query is a no-op for dedup.** Pre-fix: §11 used `ENGINE = MergeTree`; the `FINAL` in §11.2 had no effect. Retries within the same daemon run could leave duplicate rows. **Resolution:** schema changed to `ENGINE = ReplacingMergeTree(version) ORDER BY (ref_date, daemon_run_id)` with `daemon_run_id` as the dedup key and `version DEFAULT toUInt32(toUnixTimestamp64Milli(run_ts))` to resolve which row wins on retry.

**M-4 — §6.2 slice direction was ambiguous.** Pre-fix: "the last `min(ROLLING_WINDOW_DAYS_T1, len)` observations" — "last" needed explicit mapping to "most recent" given §8.3's chronological-ascending ordering. A CODE author could have implemented `slice(0, 90)` and silently destroyed the rolling-window purpose. **Resolution:** §6.2 + §6.3 now contain explicit `.slice(-90)` (T1) and "full array" (T2 = 180) callouts with the rationale spelled out.

**M-5 — INT-1 test only asserted `perCellCapitalByCell=null` without pinning legacy byte-identity.** Pre-fix: the backward-compat claim was narrative, not test-enforced. **Resolution:** INT-1 rewritten as a numerically-pinned regression test asserting `totalCapitalUsd === 500 && cellCapitalUsd === 250 && perCellCapitalByCell === null` for the canonical stage1/N=2/$10k case. Now byte-identical to existing `perCellCapital.test.ts` test #4.

**M-6 — No test pinned the `tier='T0'` + empty-data legitimacy.** Pre-fix: §7 said empty data + `tier !== 'T0'` throws, implying T0 + empty data succeeds, but no test covered the cold-start path (which is the most-exercised production state today). **Resolution:** added EDGE-6 (36a) pinning `tier='T0', dailyReturns={a:[], b:[]}, ...` returns `weights={a:0.5, b:0.5}` without throwing.

**L-1 — log-line field-name drift in §3 OQ #6 row.** Pre-fix: example used `minN=30` and omitted `ratchetHeld`; §9.5 used `minClosedTrades` and included `ratchetHeld`. **Resolution:** §3 OQ #6 row updated to point at §9.5 canonical format rather than re-stating a stale example.

**L-2 — `cell_keys_json` column written but never read.** Pre-fix: schema included the column but the lookup query didn't use it. **Resolution:** §11 now explicitly documents `cell_keys_json` as audit-only.

**L-3 — Realized-only pin lacked citation.** Pre-fix: §13.1 listed "Realized-only daily returns (MTM deferred)" without a source. **Resolution:** added citation to RESEARCH §5.3 + cross-reference to §15.

**L-4 — `tier: 'auto' | 'T0' | 'T1' | 'T2'` was a latent pre-commitment leak.** Pre-fix: §2 non-goal implied no production override but the §4 input docstring didn't state it. **Resolution:** §4 docstring now explicitly forbids `tier !== 'auto'` in production and pins `resolveCellWeightsForRun` as the canonical caller.

**L-5 — Test count claim slipped.** Pre-fix: §12 header said "~40 tests"; done-criterion #5 said "~50 tests (numbering allows ~5 slack)"; actual count was 56 numbered items. **Resolution:** both updated to 56 (in cellWeights.test.ts) + 5 brief-render extensions + 1 migration smoke test, all reconciled.

**Files added/modified by this critic-fix pass (in-SPEC text only — no source code yet):**

| Section | Pre-fix issue | Post-fix state |
|---|---|---|
| §3 trigger table + OQ resolution table | observedT meaningless; OQ #6 example drift | observedDaysWithTrades pinned as authoritative; OQ #6 row points at §9.5 |
| §4 ComputeCellWeightsInputs | missing observedDays; tier latent override | observedDays added; tier docstring forbids override |
| §5 ComputeCellWeightsResult | observedT field meaningless | observedDaysWithTrades + computeWindowDays |
| §6.2 / §6.3 / §6.3.1 | slice direction ambiguous; HRP procedure conflated | explicit `.slice(-90)`; AFML Snippet 16.2/16.3/16.4 separated; alphabetize-input canonicalization |
| §6.4 selectCellWeightsTier | param naming wrong | renamed to observedDaysWithTrades; TIER_TRIGGERS field renamed |
| §7 edge throws | cold-start path under-pinned | (no spec change; test EDGE-6 added) |
| §9.1 ResolveCellWeightsResult | missing degraded field | degraded added |
| §9.3 daemon substitution | silent `??` fallback | resolvePerCellCellCapital helper with throw |
| §9.4 / §9.6 | write/read discipline unclear | DEGRADED rows persisted but filtered on read |
| §9.5 daemon log line | T= field meaningless | obsDaysWithTrades= |
| §10.1 / §10.3 brief | field rename downstream | observedDaysWithTrades; obsDays= |
| §11 schema | MergeTree no-op; cell_keys_json undocumented | ReplacingMergeTree(version); audit-only note |
| §11.2 (new) prior-tier query | DEGRADED rows would poison ratchet | `WHERE degraded = 0` filter |
| §12 test plan | INT-1 not byte-pinned; EDGE-6/TRIG-DATA/DEGRADED-RATCHET/ORCH-MISMATCH missing | all added; total 56 in cellWeights.test.ts |
| §13.1 ADR extension | realized-only no citation | citation added |
| §15 watch-outs | bias direction asserted without math; ratchet claim wrong | bias direction acknowledged as data-dependent; ratchet mechanism corrected |
| §16 done criteria | test count slipped | 56 numbered tests |
| §17 (new) | n/a | this addendum |

**No deferred LOW findings.** All 5 LOW findings addressed in-SPEC. The critic's "Notes for the engineer" advisory items (structural completeness OK, RESEARCH-§3 PUSHBACK carried implicitly, source-filter tightening is a deliberate departure from RESEARCH) are accepted as-is; no SPEC text change needed.

**Critic verdict re-confirmed:** SHIP. Ready for CODE.

---

## 18. Why this slice closes ADR-039 OQ #3 end-to-end
