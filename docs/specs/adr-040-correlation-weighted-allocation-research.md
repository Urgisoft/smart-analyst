# ADR-040 — Correlation-weighted per-cell allocation — RESEARCH note

**Status:** RESEARCH (pre-ADR, pre-SPEC) — informs both the ADR-040 text that
will land in [`docs/decisions/README.md`](../decisions/README.md) and the
companion SPEC that will follow.
**Date:** 2026-05-17 (session 68)
**Owner:** Vector Core
**Resolves:** [ADR-039](../decisions/README.md#adr-039-) Open Question #3 — *"If
`mr_v1` and `trend_v1` deploy concurrently in stage 2+, should total exposure be
capped by their realized correlation? Recommendation: this is a separate ADR;
ADR-039 fixes the total allocation only and leaves intra-allocation sizing to
the per-strategy logic."*
**Companion docs:**
- [`docs/specs/per-cell-stage-sizing.md`](per-cell-stage-sizing.md) §11.1 — pins
  equal-weight as the default this ADR-040 amendment will replace; §17 L-3
  records the deferred critic finding ("equal-weight pin is honest but stage-4
  correlated — ADR-040 amendment can introduce correlation-weighted allocation
  when stage 4 is operationally near").
- [`docs/obsidian/gaps/cross-strategy-correlation.md`](../obsidian/gaps/cross-strategy-correlation.md) —
  Phase 9+ gap doc that motivated ADR-039 OQ #3.
- [`docs/teach/2026-05-17-hrp-erc-ivw-correlation-weighted-allocation.md`](../teach/2026-05-17-hrp-erc-ivw-correlation-weighted-allocation.md) —
  session-68 teach-doc covering HRP / ERC / IVW intuition + mechanism + failure modes.

**Canon (Tier 1):**
- López de Prado, *Advances in Financial Machine Learning* (2018), **Ch 16 —
  Machine Learning Asset Allocation** (HRP construction; Snippet 16.4 reference
  implementation; §16.4.5 "small-sample failure mode").
- López de Prado (2016), "Building Diversified Portfolios that Outperform Out
  of Sample," *Journal of Portfolio Management* 42(4) — the original HRP paper
  with the OOS-variance comparison table that ranks HRP > min-variance > IVW >
  equal-weight at T=520, N=10.
- Maillard, Roncalli, Teïletche (2010), "The Properties of Equally Weighted
  Risk Contribution Portfolios," *JPM* 36(4) — ERC definition and N=2 closed
  form.
- Ledoit & Wolf (2003), "Improved estimation of the covariance matrix…,"
  *Journal of Empirical Finance* 10(5) — shrinkage estimator for Markowitz
  stability, the canonical fix that ERC/HRP also benefit from.
- Meucci (2009), "Managing Diversification," *Risk* 22(5) — Effective Number
  of Bets diagnostic, the right *measurement* of diversification independent
  of the *allocation* rule.
- AFML §11-12 (López de Prado 2018) — selection bias and the case for sample
  weighting; the lens through which backtest-derived correlations must be
  read.

**Canon (Tier 2):** Carver, *Systematic Trading* (2015), chapter on
diversification multipliers — the practitioner framing for how a systematic
trading book actually composes correlation-aware sizing in production.

---

## 1. Scope of ADR-040

ADR-040 resolves the **intra-stage-allocation split rule**: given that ADR-039
§1 fixes the total stage allocation (e.g. stage 1 = 5% of liquid SignalForge
capital, stage 2 = 15%, …), how does the daemon split that stage budget across
N concurrently-deployed cells?

The current pinned default ([per-cell-stage-sizing.md §11.1](per-cell-stage-sizing.md))
is **equal-weight**: `cellCapitalUsd = stageDeployedUsd / numCells`. ADR-040
either ratifies that default with explicit pre-commitment, replaces it with
a correlation-weighted rule, or specifies a trigger-gated transition between
the two.

**Out of scope for ADR-040:**
- The stage-level total allocation schedule itself (that's ADR-039).
- Per-trade sizing within a cell (that stays with `sizePositionFixedRisk` in
  [src/server/position_sizing.ts](../../src/server/position_sizing.ts)).
- Concentration limits across cells (single-name, sector — these are the
  cross-strategy-correlation.md gap doc's "concentration limits" section, a
  separate slice).
- Diversification *measurement* (Meucci ENB on the brief panel — useful but
  separable; a future Bucket-3 brief enhancement, not an allocation rule).

---

## 2. Recommendation (pre-decisional — to be ratified in ADR-040 + companion SPEC)

**Staged rollout with explicit pre-commitment of all three tiers and the
trigger conditions between them.** ADR-040 fixes the policy now; the policy
self-activates as data sufficiency and N grow.

| Tier | Rule | Trigger to activate | Estimation method |
| --- | --- | --- | --- |
| **T0 — Equal-weight** | `wᵢ = 1/N` | DEFAULT — active until T1 fires | None — pinned constant |
| **T1 — Inverse-variance (IVW)** | `wᵢ ∝ 1/σᵢ²` | (a) N ≥ 2 AND (b) ≥ 90 trading days of live (non-paper) daily returns per cell AND (c) at least 30 closed trades per cell over that window | Rolling 60-day or 90-day window of daily cell-level P&L from `live_trades` (NOT `bt_trades`) |
| **T2 — Hierarchical Risk Parity (HRP)** | AFML Snippet 16.4: hierarchical-cluster → quasi-diagonalize → recursive bisection | (a) N ≥ 4 AND (b) ≥ 180 trading days of live returns per cell AND (c) at least 60 closed trades per cell over that window | Same rolling window, full N×N covariance |

**Why staged, not "go straight to HRP":**

1. **At N=2 (today and for the foreseeable future), HRP collapses to IVW.**
   The hierarchical clustering on 2 assets is trivial; the recursive bisection
   has exactly one split. HRP machinery adds zero edge over IVW until N ≥ 4.
   See teach-doc §"Failure mode" — using a richer method on too-thin data adds
   noise without adding signal.
2. **At T < 60 daily observations, ALL correlation-aware methods fail.**
   Variance estimates have ~20%+ standard error below T=60; full covariance
   estimates are worse. López de Prado AFML §16.4.5 explicitly recommends
   falling back to equal-weight when the sample is too thin. The trigger
   conditions encode this canon constraint.
3. **Backtest-derived correlations are biased by sweep-selection.** The cells
   in the allowlist were picked because they performed well; their joint
   behavior is conditioned on that survival. Using `bt_trades`-derived
   correlations for live allocation is the exact selection-bias trap AFML
   §11-12 warns against. The trigger conditions require LIVE data only.
4. **Pre-commitment per ADR-039 §6.** Writing the trigger thresholds NOW —
   while there's no operational pressure — is structurally adversarial to a
   future operator who, mid-deployment, might be tempted to "just go straight
   to HRP, the data is fine" with 45 days of live returns. The trigger
   thresholds are the cool-head version of that decision.

---

## 3. Why the handoff-asserted urgency ("when stage 4 is operationally near") is overstated — [PUSHBACK]

The session-67 handoff and the per-cell-stage-sizing §17 critic finding both
frame ADR-040 as "needed when stage 4 is operationally near." That framing
inflates the urgency:

- **Stage 4 is far away.** ADR-039 §1's stage-4 row requires "1 year of
  validated operation across stages 1-3." Earliest possible stage-1 entry is
  the 2026-06-29 paper-trading verdict-flip boundary (per [ADR-039](../decisions/README.md#adr-039-)
  Dependencies). Stage 2 requires 90 days minimum at stage 1. Stage 3 requires
  180 days minimum at stage 2. **Earliest possible stage-4 entry: ~2027-12-29
  if no stage fails its window.** That's ~19 months from today.
- **The real concern is stage 2+, not stage 4.** ADR-039 OQ #3 explicitly says
  "*If `mr_v1` and `trend_v1` deploy concurrently in stage 2+*." Stage 2 entry
  is no earlier than ~2026-09-29 (60 days of stage 1 after the earliest
  2026-06-29 stage 1 entry). That's ~4.5 months out.
- **At N=2 cells (current and near-term), the choice is binary: equal-weight
  vs IVW.** Equal-weight is approximately optimal IF cell variances are
  similar AND correlation is near 0. IVW gains over equal-weight ONLY when
  the variance ratio is far from 1 — and even then, the gain is modest at
  N=2 (typically 5-15% portfolio-variance reduction for variance ratios of
  2× to 4×).
- **HRP's edge is well-documented at N=10+ assets.** López de Prado (2016)
  Table 1 shows HRP's OOS-variance edge over min-variance widens as N grows.
  At N=2, HRP = IVW exactly. At N=4, HRP ≈ IVW + small clustering bonus
  (1-3% typically). The full HRP machinery is overkill for SignalForge until
  the strategy registry has ≥4 active cells.

**The correct urgency claim is: "ADR-040 should be RATIFIED before stage 2
operationally engages (~2026-09-29 earliest)." That's ~4 months out, not
"stage 4 is near."** RATIFIED = ADR text + companion SPEC + the pure helper
`computeCellWeights` exists and is tested, EVEN IF the trigger conditions
keep T0 active in production. Pre-commitment is the point; activation is data-
driven.

---

## 4. Methodology survey

### 4.1 Inverse-Variance Weighting (IVW) — T1

Formula:
```
wᵢ = (1 / σᵢ²) / Σⱼ (1 / σⱼ²)
```

where σᵢ² is the sample variance of cell i's daily returns over a rolling
window.

**Pros:** Uses only the diagonal of the covariance matrix (N numbers, not
N(N+1)/2). Estimation error per cell is ~1/√T, so 60 days gives ~13% standard
error on σᵢ² — acceptable. Closed form, no optimization, no matrix inversion.
Robust to outliers if winsorized.

**Cons:** Ignores cross-cell correlation. Two highly-correlated cells both
get weight — the portfolio's *effective* number of bets (Meucci ENB) drops
below N even though weights look diversified. At N=2 with corr(cell1, cell2)
= 0.7 and equal variances, IVW gives 50/50 weight but ENB ≈ 1.18 — barely
more than 1 effective bet.

**Failure mode at low T:** Below T=60, σᵢ² estimates have wide error bars;
weights flip-flop month-to-month as the window rolls. Mitigation: enforce
T ≥ 60 in the trigger condition (the ADR-040 amendment specifies T ≥ 90 for
extra margin).

### 4.2 Equal Risk Contribution (ERC) — considered, NOT recommended for the next slice

Formula (implicit): pick w such that for all i, j:
```
wᵢ × (Σ w)ᵢ = wⱼ × (Σ w)ⱼ
```

For N=2 there's a closed form (Maillard et al. 2010, eq 5). For N>2, iterative
optimization with `scipy.optimize.minimize` or `cvxpy`.

**Pros:** Each cell contributes the same to portfolio variance. Robust to
expected-return errors (no μ in the formula). Established practitioner choice
for multi-strategy book sizing.

**Cons:** Requires the full N×N covariance matrix Σ, not just diagonal. With
T=90 days and N=4 strategies, Σ has N(N+1)/2 = 10 numbers; the condition
number of the sample Σ can hit 50-100, making the optimization sensitive to
estimation noise. Ledoit-Wolf shrinkage helps but doesn't eliminate this.

**Why skip for the staged rollout:** ERC's edge over IVW shows up most
clearly when correlations are non-trivial AND the sample is large enough to
estimate them reliably. At N=4 and T=90, the estimation noise on
off-diagonal Σ entries dominates the ERC vs IVW gap. The ADR-040 amendment
should skip ERC entirely and go IVW → HRP as N and T grow — HRP's
clustering step is more sample-efficient than ERC's optimization on the
same data.

### 4.3 Hierarchical Risk Parity (HRP) — T2

AFML Snippet 16.4 reference implementation, three steps:

1. **Tree clustering.** From the N×N correlation matrix ρ, compute distance
   `d(i,j) = √(½(1 - ρ(i,j)))`. Run single-linkage agglomerative clustering
   (`scipy.cluster.hierarchy.linkage`) to produce a tree.
2. **Quasi-diagonalization.** Reorder Σ rows/columns according to the tree's
   leaf ordering. Large covariances concentrate near the diagonal.
3. **Recursive bisection.** Walk the tree top-down. At each split into left
   subcluster L and right subcluster R:
   - σ²(L) = w_L' Σ_LL w_L using IVW within L: w_L_i ∝ 1/σ_i²
   - σ²(R) likewise
   - αₗ = 1 - σ²(L) / (σ²(L) + σ²(R)); αᵣ = 1 - αₗ
   - Multiply αₗ into the weights of all leaves under L; αᵣ for R.

**Pros:** Avoids inverting Σ entirely. AFML §16.5 Monte Carlo: HRP's OOS
portfolio variance is ~50% lower than equal-weight and ~30% lower than
minimum-variance Markowitz at T=520, N=10. The win is OOS *stability*, not
in-sample Sharpe.

**Cons:** Single-linkage clustering is sensitive to outliers; one outlier
observation can rearrange the tree (AFML §16.4.3 flags this). For small N
(≤4), the tree is shallow enough that rearrangement is rare; for large N
(50+) it's a real problem.

**Failure mode at low T:** Same as ERC — below T=60, the correlation matrix
itself is noisy, and the tree built from it is noisy. Mitigation: T ≥ 180
in the trigger condition gives ~7.5% standard error on a true correlation of
0.3, adequate to recover stable cluster structure.

### 4.4 Markowitz with Ledoit-Wolf shrinkage — considered, NOT recommended at all

Standard min-variance Markowitz: minimize w' Σ w subject to Σ wᵢ = 1, wᵢ ≥ 0.
Requires inverting Σ. Ledoit-Wolf (2003) shrinks the sample Σ toward a
constant-correlation target to stabilize the inversion.

**Pros:** Closed-form-ish (small QP); textbook canonical choice.

**Cons:** Inversion-sensitive; even with shrinkage, weights can swing 20-30%
month-to-month at typical T=90 small-N portfolios. López de Prado (2016)
Table 1 shows min-variance Markowitz BEATEN by HRP OOS even with shrinkage
applied. **No reason to ship Markowitz over HRP** — HRP is strictly more
sample-efficient at the same N, T.

### 4.5 Effective Number of Bets (Meucci ENB) — diagnostic, not allocation

```
ENB = exp(-Σᵢ pᵢ log pᵢ)
```

where pᵢ is the proportion of total portfolio variance attributable to the
i-th principal component of Σ.

**Use:** ENB tells you how many *uncorrelated* bets your portfolio actually
holds, regardless of how many positions are open. Equal-weight on 2 cells
with corr = 0.9 has ENB ≈ 1.05 — operationally one bet.

**Where to surface:** Brief panel ("currently 1.18 effective bets across 2
cells") — separate slice, NOT part of ADR-040's allocation rule. The brief
panel is a deferred Bucket-3 enhancement.

---

## 5. Data inventory — what we have, what we need

### 5.1 What exists today

| Source | Granularity | Coverage | Suitable for? |
| --- | --- | --- | --- |
| [`quantlab.bt_trades`](../../scripts/migrate_live_trades.ts) (CH) | Per-trade events: ts, price, pnl_pct, balance_after, strategy_type, param | Full sweep history (years of synthetic backtests across multiple cells × params × tokens) | **Biased — do NOT use for live allocation correlations.** Selection bias from sweep survival, no out-of-sample correction. Could be used to seed an *initial* correlation estimate when live data is thin, but the bias makes this dangerous. |
| [`quantlab.live_trades`](../../scripts/migrate_live_trades.ts) (CH) | Per-trade events with `cell_key`, `realized_pnl_usd`, entry/exit timestamps | ~3 days of paper trades as of 2026-05-17 (paper trading started ~2026-05-14) | **Right source, wrong sample size today.** Will be the correct estimation source once T ≥ 60 days. |
| `bt_runs` (CH) | One row per backtest — summary stats only (Sharpe, PF, win_rate, etc.) | Full sweep history | **Not useful for correlation** — no daily returns; aggregates only. |

### 5.2 What's missing

A **per-cell daily P&L time series** does not exist as a materialized table.
For T1/T2 to activate, the SPEC needs to specify how it's computed:

**Option A — On-the-fly aggregation from `live_trades`.** Query:
```sql
SELECT cell_key,
       toDate(exit_ts) AS day,
       sum(realized_pnl_usd) AS daily_pnl
FROM quantlab.live_trades FINAL
WHERE source = 'paper' OR source = 'live'
  AND exit_ts IS NOT NULL
  AND exit_ts >= today() - INTERVAL <window_days> DAY
GROUP BY cell_key, day
ORDER BY cell_key, day
```
Convert to log returns using rolling notional. Compute σᵢ and ρ from there.
Pros: no new table; cheap query; always up-to-date. Cons: returns are sparse
(no trade on day X → no row); needs forward-fill / zero-fill discipline.

**Option B — Materialize a `cell_daily_pnl` table.** Daemon writes one row per
(cell_key, trading_day) at end of each daemon run, summing P&L on closed
positions that day. Pros: dense, time-aligned, fast to query. Cons: new
schema, migration, backfill from `live_trades` history.

**Recommendation:** Start with **Option A** at SPEC time (no new schema; just
a helper function in `src/server/cell_pnl_history.ts` that returns the
aligned time series). If query performance becomes an issue at the brief
layer, materialize later as Option B. Keep the SPEC's contract on the helper
function — the storage decision is reversible.

### 5.3 Open-position P&L (the un-closed-trade question)

`live_trades.exit_ts` is NULL until a trade closes. For an open trade, the
"unrealized P&L" requires a current price. The right denominator for daily
return is **realized + mark-to-market unrealized**, computed using each day's
closing price for held positions.

This is a non-trivial side question — the SPEC should either:
- Defer it (only count realized P&L; this loses fidelity but is simple), or
- Wire in a daily mark-to-market loop (uses existing `candles` table for
  closing prices on held tokens).

**Recommendation:** Defer it — start with realized-only daily P&L. Cell-level
daily returns from closed trades are noisy but unbiased; adding MTM
introduces dependence on candle-availability that complicates the SPEC.
Revisit once trade frequency is high enough that realized-only obscures
significant intra-trade variance.

---

## 6. Pre-commitment / trigger-condition framing

Per ADR-039 §6 ("Pre-commitment is the point. Once accepted, this ADR's stage
parameters change only via a new ADR"), the same discipline applies here. The
ADR-040 amendment commits NOW to:

1. **The tier ladder** (T0 → T1 → T2; no skipping, no inserting Markowitz).
2. **The numeric trigger thresholds** (T1: N ≥ 2, T ≥ 90 live days, ≥30
   closed trades per cell; T2: N ≥ 4, T ≥ 180 live days, ≥60 closed trades
   per cell).
3. **The estimation source** (LIVE only — `live_trades` table with `source IN
   ('paper', 'live')` — never `bt_trades`).
4. **The rolling window** (60 days for variance/covariance, with T-required
   ≥90 / ≥180 as the minimum data buffer).
5. **The data hygiene rules** (Option A aggregation; realized-only P&L for v1;
   forward-fill zero-trade days as zero-return).

The trigger thresholds are **pinned constants** in a single source file
(`src/server/cell_weights_config.ts` proposed) that the pure helper consumes.
A future ADR can amend them; manual override is not authorized.

---

## 7. Failure modes per tier — what could break this in production

| Failure | Tier | Detection | Mitigation |
| --- | --- | --- | --- |
| Variance estimate explodes after a single fat-tail day | T1, T2 | σᵢ² > 4× rolling-365-day σᵢ² | Cap the weight delta at ±25% per re-estimation cycle (smoothing); alternatively, use a longer window (90d instead of 60d). |
| Two cells become perfectly correlated (corr ≈ 1) | T2 | corr(i,j) > 0.95 in window | HRP cluster step naturally collapses them; their *combined* weight is what matters operationally. Surface in brief panel as "effective bets dropped below numCells." |
| Sample becomes too thin (a cell pauses trading) | T1, T2 | A cell goes ≥30 days without a closed trade | Fall back to equal-weight ACROSS THE PAUSED CELLS' BUDGET; don't re-allocate (would change opening-trade size for the paused cell when it resumes). |
| Selection bias creeps in via "deactivate underperformers" | T0, T1, T2 | Operator removes a cell after a drawdown; weights recompute on remaining cells | Document in the ADR-040 watch-outs: removing a cell mid-stage is itself an operational decision that re-baselines the weight calculation; the per-cell-stage-sizing equal-weight rebalance behavior carries through to IVW/HRP. |
| Live-data and paper-data are mixed in the window | T1, T2 | Window spans the paper→live source flip | The recommended source filter is `source IN ('paper', 'live')` so both are included; document that paper-stage returns are smaller-scale but same-process, so combining is acceptable for variance estimation. Operator can override the filter if a paper-vs-live regime change is suspected. |
| HRP cluster tree flips when a new cell is added | T2 | Cluster IDs change run-over-run | Pin cluster IDs by a deterministic re-ordering rule (cell_key alphabetical within each cluster); document that adding/removing cells is itself a re-baselining event. |

---

## 8. What ships NOW vs. what ships LATER

### Ships NOW (in the ADR-040 + companion SPEC + CODE slice)

1. **ADR-040 text** in `docs/decisions/README.md` — the policy.
2. **Companion SPEC** `docs/specs/correlation-weighted-per-cell-allocation.md` —
   contracts, function signatures, test plan. Follows the pattern of
   per-cell-stage-sizing.md.
3. **Pure helper** `src/server/cell_weights.ts` exporting
   `computeCellWeights(inputs)` that:
   - Inputs: `{ cellKeys: string[], dailyReturns: Map<cellKey, number[]>,
     tier: 'T0' | 'T1' | 'T2' | 'auto' }`
   - Output: `{ tierActive: 'T0'|'T1'|'T2', weights: Map<cellKey, number>,
     diagnostics: { observedT: number, observedN: number, sufficientForT1:
     boolean, sufficientForT2: boolean, ... } }`
   - `tier: 'auto'` (the default) applies the trigger conditions to pick the
     active tier; explicit T0/T1/T2 force the tier (for testing).
4. **Data accessor** `src/server/cell_pnl_history.ts` exporting
   `getCellDailyReturns(cellKeys, windowDays)` — Option A query from §5.2.
5. **Daemon wire-up** — `daily_signal_daemon.ts` calls `computeCellWeights`
   ONCE per run, AFTER stage eval, BEFORE the per-cell loop. Multiplies the
   stage's `stageDeployedUsd` by each cell's weight to derive that cell's
   `cellCapitalUsd`. Replaces the current equal-weight `stageDeployedUsd /
   numCells` computation in [src/server/per_cell_capital.ts](../../src/server/per_cell_capital.ts).
6. **Test plan** — at minimum:
   - 6-8 unit tests for `computeCellWeights` at each tier (T0 trivial; T1
     IVW closed-form; T2 HRP against an AFML §16.4 reference output).
   - 4-6 trigger-condition tests (N just below threshold → T0; N just above
     → T1; T below threshold → T0; etc.).
   - 3-4 data-hygiene tests (cell with no closed trades in window; cell
     with single-day fat tail; cell paused for 30+ days).
   - 1-2 integration tests with `resolvePerCellSizingForRun` showing the
     weights compose correctly with HALT, drawdown sizing, and the existing
     §6.3 halt-zeros-cellCap semantic.

### Ships LATER (separate slices, NOT in ADR-040)

1. **Meucci ENB on the brief panel.** Diagnostic, not allocation. Brief
   enhancement slice.
2. **Concentration limits** (single-name, sector exposure caps across cells).
   The cross-strategy-correlation.md gap doc's "concentration limits" section
   is its own slice — solves a different problem (multi-cell same-name
   exposure) than the allocation rule.
3. **Operator-set per-cell weights override.** Already deferred by
   per-cell-stage-sizing.md §2; would be a separate slice introducing a
   per-cell-weights JSON config. ADR-040 stays algorithmic; operator override
   is a follow-up.
4. **Materialized `cell_daily_pnl` table** (Option B from §5.2). Performance
   optimization; only if Option A query becomes a brief-rendering bottleneck.
5. **Daily mark-to-market unrealized P&L** in the daily return computation.
   Fidelity improvement; only if realized-only proves to obscure significant
   intra-trade variance.

---

## 9. Open questions for the SPEC stage

1. **Source filter — `paper` only, `live` only, or both?** Recommendation:
   both (`source IN ('paper', 'live')`), since paper is the same execution
   path with the same risk model. Operator can override.
2. **Window length — 60 or 90 days?** Recommendation: 90 days. Trades off a
   bit of responsiveness for tighter variance estimates. Pinned constant.
3. **Re-estimation cadence — every daemon run, weekly, monthly?**
   Recommendation: every daemon run (i.e., daily). The pure helper is cheap;
   no reason to add stale-weight risk. Weights smoothed by the rolling
   window naturally.
4. **Weight smoothing across re-estimation cycles — none, EWMA, hard cap?**
   Recommendation: hard cap at ±25% per cycle (the failure-mode §7
   mitigation). Simple, auditable.
5. **What happens during HALT?** The existing per-cell-stage-sizing §6.3
   semantic (`cellCapital = 0` on HALT) should compose cleanly: weights are
   computed FIRST, then HALT zeros `cellCapital` for all cells. Document
   explicitly.
6. **Does the SPEC need a daemon-side log line per cell weight?**
   Recommendation: yes, mirroring §8.5 of per-cell-stage-sizing:
   `[cell-weights] tier=T0 cells=2 weights=mr_v1:0.500,trend_v1:0.500`.
7. **Brief panel surface for the active tier and observed weights?**
   Recommendation: yes, one line under the existing `deployed=$X.XX across
   N cells (cellCap=$Y.YY each)` line. Format: `weighting=equal` (T0) /
   `weighting=IVW (T=90, N=2)` (T1) / `weighting=HRP (T=180, N=4)` (T2).
8. **Should the trigger evaluation persist?** I.e., once T1 fires, does it
   stay active even if a future re-estimation has thinner data?
   Recommendation: yes, ratchet-up only (T0→T1→T2, never T1→T0). Prevents
   tier flapping. Document explicitly.

---

## 10. Next stage

**SPEC** (`docs/specs/correlation-weighted-per-cell-allocation.md`) following
the per-cell-stage-sizing.md template:

1. Status / Date / Owner / Source ADR (ADR-040 once written)
2. Goal — replace `cellCapitalUsd = stageDeployedUsd / numCells` with
   `cellCapitalUsd = stageDeployedUsd × weights[cellKey]`
3. Non-goals (Meucci ENB, concentration limits, operator weight overrides,
   MTM unrealized P&L, materialized `cell_daily_pnl` table)
4. Tier ladder + trigger conditions (from §2 above)
5. Inputs to the pure helper `computeCellWeights`
6. Outputs (weights + diagnostics)
7. Pure-function semantics for each tier
8. Edge-case throws
9. Data accessor `getCellDailyReturns` contract
10. Daemon wire-up (one helper call, log line, per-cell-loop substitution)
11. Brief panel surface
12. Test plan (per §8 of this RESEARCH note)
13. ADR-039 extension flags
14. What this slice does NOT change (regression budget)
15. Done criteria
16. Watch-outs

**Then CODE** — the pure helper + tests first (provable in isolation), then
the daemon wire-up, then the brief panel.

**Then the ADR-040 entry in `docs/decisions/README.md`** that points at the
SPEC and pins the policy. The ADR text is short (decision + alternatives +
open questions + watch-outs); the substantive material lives in the SPEC.

---

## 11. Watch-outs

- **Don't backfill T1 or T2 from `bt_trades`.** Even if "we have years of
  data, just use it" is tempting, the sweep-selection bias is real and the
  resulting weights would be wrong (cells appear LESS correlated than they
  actually are because correlated cells were pruned during the sweep). The
  trigger conditions are a feature, not a bug.
- **Don't allow operator override of the tier.** The whole ADR-039 §6 pre-
  commitment ethos applies. If the operator wants T2 active before triggers
  fire, the correct response is a superseding ADR amendment, not a CLI flag.
  This is the same discipline as the existing stage CLI's no-jump rule.
- **The trigger thresholds (N, T, trade-count) are pinned constants, not
  config-file values.** Otherwise they're operationally overridable from
  outside the ADR process. Same discipline as `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS`
  in the drawdown framework.
- **The IVW closed-form at N=2 is `w₁ = σ₂² / (σ₁² + σ₂²)`.** Pin this in a
  test so a future "optimization" rewrite of the helper can't silently break
  the math.
- **HRP's tree clustering is order-dependent in the leaf ordering even when
  the tree itself is stable.** Two implementations of single-linkage
  clustering can produce different leaf orderings for the same tree. Pin the
  AFML Snippet 16.4 leaf-ordering procedure in the SPEC and in a test.
- **`getCellDailyReturns` time-aligning across cells.** If cell A has trades
  on days {Mon, Wed} and cell B on {Tue, Thu}, the daily-returns series for
  each cell needs forward-fill (or zero-fill, see open question #1) to align
  to the union of trading days. Document the chosen rule.
- **Adding/removing a cell mid-stage is a re-baselining event.** The
  weight recomputation absorbs the new cell count automatically — no
  smoothing across the cell-set change. Document that an operator who adds
  a third cell should expect existing cells' capital to drop on the next
  daemon run.
- **HALT composes ON TOP of weights, not instead of them.** Existing §6.3
  semantic: `cellCapital = 0` on HALT. New SPEC: `cellCapital = weights[i]
  × stageDeployedUsd`, then HALT zeros it. Test order matters.

---

## 12. Cost / value check before moving to SPEC

**What does writing the SPEC + CODE buy us before stage 2 (~2026-09-29
earliest)?**

- **Today (N=2, T < 5 days):** activates T0 = equal-weight = no behavior
  change vs. status quo. Zero operational benefit, but the helper is
  in place and tested.
- **Once stage 1 starts (~2026-06-29 + 60-90 days for T1 trigger ~=
  2026-08-29 to 2026-09-29):** the trigger fires automatically. Weights
  may diverge from 50/50 if `mr_v1` and `trend_v1` have different realized
  volatilities. Operationally relevant.
- **Once stage 2 starts (~2026-09-29 earliest):** ADR-040's pre-committed
  policy is in force. No operator decision in the moment. **This is the
  payoff window.**

**Cost:** ~2-3 sessions for SPEC + CODE + tests. One Python reference (in
`scripts/_compute_cell_weights_reference.py` or similar) for the HRP test
vector. Brief render extension. Daemon wire-up. ~15-25 new tests.

**Verdict:** Worth shipping in the next 4-month window before stage 2 entry
becomes possible. Not urgent today; doable as 2-3 focused sessions whenever
the operator green-lights the SPEC.

---

## 13. Why this is RESEARCH, not SPEC, not CODE

Per the Vector Core canon (RESEARCH → DESIGN → SPEC → CODE), this note pins:

- **The canon** (Tier 1 citations with specific chapter/section).
- **The data inventory** (what exists, what's missing, with the bias
  warning on `bt_trades`).
- **The PUSHBACK** on the handoff-asserted urgency (stage 4 is not near;
  stage 2 is, but ~4 months out, not weeks).
- **The recommended policy shape** (staged rollout with explicit triggers).
- **The failure modes per tier**.
- **The open questions the SPEC stage must resolve**.

It does NOT pin:
- The exact function signatures (SPEC).
- The exact test list with byte-pinned numbers (SPEC).
- The implementation (CODE).
- The reference HRP test vector (the Python reference script that the SPEC
  byte-pins against).

The next session, with this RESEARCH in context, can move directly to SPEC
without re-deriving any of the canon survey or data inventory.
