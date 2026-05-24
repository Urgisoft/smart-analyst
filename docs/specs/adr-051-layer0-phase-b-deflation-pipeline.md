---
adr_id: 051
status: Accepted
date: 2026-05-24
session: 96 #20 Cycle 22
owner: Orchestrator (Vector Core)
ratification: Orchestration-resolved per multi-agent-orchestration §6.4 (routine
  methodology-canon-application; ADRs for routine architecture decisions are
  not operator-gated). Phase C **promotion** of any composite to `phase1_v3+`
  classifier input remains operator-gated per §7.1 item 8.
supersedes: none
superseded_by: none
---

# ADR-051 — Layer-0 Phase B deflation-pipeline pattern (cycle_v1 first instance)

## Context

The s96 #14 working-model change committed orchestration to executing
**Phase B statistical-validation campaigns for the nine Layer-0
informational composites** (`cycle_v1`, `vol_struct_v1`, `sector_rot_v1`,
`cross_asset_v1`, `short_interest_v1`, and four remaining gap composites).
The orchestration doc §7.3 defines "Phase B" as the canonical four-gate
deflation pipeline (AFML §11 / Bailey-LdP 2014 / HLZ 2016) running offline
against historical price panels — **distinct** from each composite's
domain-specific Phase B (e.g., cycle_v1 §S-MCP-Q5 was an NBER lead-time
backtest, which is a different methodology entirely).

There is **no prior precedent** in this codebase for applying the
DSR/PBO/HLZ deflation pipeline to a Layer-0 composite-as-signal. The
infrastructure to do so exists piecewise:

- DSR (Mertens parametric + Bailey-LdP §11.5 bootstrap) in `src/lib/psr.ts`.
- PBO via CSCV (BBLPZ 2014 §2) in `src/lib/cscv.ts`.
- HLZ BHY haircut (Harvey-Liu-Zhu 2016 §4.2) in `src/lib/hlzHaircut.ts`.
- Four-gate orchestrator (DSR + PBO + HLZ + OOS-IS Pardo) in
  `src/lib/validator.ts`.
- Walk-forward / param-sweep / per-trial-Sharpe persistence in
  `scripts/batch_backtest.ts` + `quantlab.bt_runs` + `quantlab.bt_runs_slices`.

What is **missing**:

1. A canonical "composite-as-signal → strategy" template. Layer-0 composites
   emit a daily score/label; they are not strategies. The Phase B campaign
   needs a SPEC-pinned mapping from `(composite output, parameters) → daily
   benchmark position`.
2. A persistence shape for composite-Phase-B trials that does not pollute
   `bt_runs` (which is per-strategy-per-token-per-interval and would conflate
   semantic categories).
3. A verdict-surfacing pattern that prevents the result-shopping failure
   mode (the cycle_v1 §S-MCP-Q5 anti-shopping rule: a failed Phase B is
   permanent; no `cycle_v2` redesign in response to an unflattering result).

This ADR locks in the **pattern** so all nine composites use the same
methodology and the same code paths, and applies it to `cycle_v1` as the
first instance. Per-composite execution is delegated to a Composite +
Health worker pair in subsequent cycles; the per-instance SPECs live in
`docs/specs/phase-b-<composite>.md`.

## Decision

The Layer-0 Phase B campaign for any composite follows this six-step
pipeline. **Each decision below is canon-cited and SPEC-pinned for every
composite that runs the pattern**; per-composite SPECs may override only
the items explicitly marked "per-composite" below.

### Decision 1 — Strategy template: long-only threshold on a benchmark

For composites whose score is bounded in [0, 1] with the "high = bullish"
convention (cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1,
short_interest_v1), the strategy template is:

```
position(t) = LONG benchmark if score(t-1) > θ, else FLAT
```

- **Single parameter θ.** Threshold sweep is the only knob.
- **Lag of one day** (`t-1` score for `t` position). Canonical no-look-ahead
  guard: yesterday's signal triggers today's position, no overnight peek.
- **Long-only, not long/short.** Rationale: short selling adds carry-cost
  + borrow-cost methodology dependencies that confound the Sharpe; doubling
  trial count by adding a short threshold raises the DSR noise floor without
  adding evidence the signal works. AFML §11.4 explicitly warns against
  inflating trial count for selection-bias-correction purposes.
- **Flat, not always-long.** "Flat when score is bearish" is the testable
  claim of an informational composite: when the score warns of contraction,
  staying out should add value vs buy-and-hold. If the signal carries no
  predictive power, the strategy degenerates to buy-and-hold minus
  flat-period returns and Sharpe deflates accordingly — exactly the right
  failure mode.

Composites with non-[0,1]-score outputs OR non-"high=bullish" semantics
(e.g., a score where "low = bullish") apply the same template with the
inequality reversed and the score rescaled to [0,1] first. The per-composite
SPEC documents the rescaling.

**Why this template over alternatives:**

| Alternative | Why rejected |
| --- | --- |
| Dual-threshold long/flat/short (θ_long, θ_short) | Doubles trial count → DSR noise floor inflates → harder to deflate; short-selling carry/borrow costs add methodology dependencies that confound the Sharpe; the bidirectional claim ("low score predicts negative returns") is testable separately via a long-only-on-inverse-benchmark variant if needed. |
| Phase-label categorical (early/mid/late/contraction → weights) | Compresses the underlying continuous information; assigns information weight to an arbitrary band-cut; the band cut itself is a free parameter that should be in the sweep. |
| Continuous score-weighted exposure (position = score × benchmark) | Variable leverage complicates Sharpe interpretation; effectively a beta = score backtest where the metric of interest is hidden in a leverage choice. |

**θ trial grid (per-composite):** `cycle_v1` uses
θ ∈ {0.05, 0.10, ..., 0.95}, 19 trials. Step 0.05 is fine-enough to span the
score distribution; trial count is small enough that DSR's expected-max-of-N
noise floor stays modest. Per-composite SPECs may use a different grid
density if the composite's empirical score distribution warrants it
(documented in the SPEC, justified against the "smallest defensible N"
principle of AFML §11.4).

### Decision 2 — Benchmark universe (per-composite, ≤3 benchmarks)

Each composite is tested on **at most 3 benchmark assets** that span the
natural domain the composite claims to inform. The three must be
*economically distinct*, not three flavors of the same exposure.

For `cycle_v1` (US business-cycle composite): **SPY + QQQ + IWM**.
- SPY = S&P 500 (broad-market, the natural "US cycle plays out in").
- QQQ = NASDAQ-100 (tech-heavy, different cyclical sensitivity).
- IWM = Russell 2000 (small-cap, most business-cycle-sensitive).

Per-composite SPECs override the benchmark list per composite domain
(e.g., `sector_rot_v1` would use sector ETFs; `cross_asset_v1` would use
SPY + TLT + GLD).

**Trial count budget**: `N_trials_total = N_θ × N_benchmarks`. For
cycle_v1: 19 × 3 = 57 cells. This is the M that feeds HLZ haircut.

### Decision 3 — Time window + walk-forward split

Each campaign uses the maximum overlap of (composite history × benchmark
history). For `cycle_v1`:

- **Composite window:** 2008-01-02 → today (per `cycle_position_snapshots`
  backfill from s85 Phase B; ~18.4 years).
- **Benchmark window:** SPY/QQQ/IWM all trade continuously through this
  period; constraint is the composite, not the benchmark.

**Walk-forward split: 70/30 IS/OOS** per Pardo §3, fixed split (not rolling).
- IS = 2008-01-02 → 2020-12-31 (~13 years, ~3270 trading days).
- OOS = 2021-01-01 → today (~5 years, ~1370 trading days).

The fixed split is chosen over rolling walk-forward for the Phase B
campaign because: (a) the composite is daily-snapshot-only (not a
re-trainable model), so rolling adds no information about parameter
stability over time, (b) a single IS/OOS split keeps the OOS-IS Pardo
gate's numerator/denominator well-defined and comparable across composites,
(c) AFML §11.3 says CSCV is the appropriate substitute for rolling
walk-forward when the trial count is small relative to T.

### Decision 4 — Four-gate validator stack

The campaign runs the existing `src/lib/validator.ts` four-gate stack on
the IS-best trial in each benchmark. Thresholds and configuration:

| Gate | Source | Threshold | Notes |
| --- | --- | --- | --- |
| **DSR** | Bailey-LdP 2014 §3; AFML §11.4 | DSR > 0.95 | Bootstrap path (Bailey-LdP §11.5) preferred when per-day equity-curve resamples are feasible; otherwise Mertens parametric. |
| **PBO** | BBLPZ 2014 §2; AFML §11.3 | PBO < 0.5 (BBLPZ explicit) | More-demanding PBO < 0.2 required for Phase C eligibility per §Decision 5. |
| **HLZ BHY** | Harvey-Liu-Zhu 2016 §4.2; BHY 2001 | passes BHY threshold at alpha=0.05, one-sided | M = N_trials_total across all benchmarks for the composite (e.g., M=57 for cycle_v1). One-sided because "is signal better than zero" is the test. |
| **OOS-IS Pardo** | Pardo 2008 §10 | OOS Sharpe / IS Sharpe > 0.5 | Project-deviation: ratio of Sharpes, not net-profit, per validator.ts §15. |

Each gate is run **per-benchmark independently**; a composite "passes" a
gate iff ≥1 benchmark passes that gate. A composite passes Phase B iff
**all four gates pass on the same benchmark** (composite + benchmark pair
that survives all gates is the candidate for Phase C promotion).

The four gates are not equally informative:
- DSR is the headline; a failed DSR with passes elsewhere is a permanent
  fail (the signal isn't significant after selection-bias correction).
- PBO < 0.5 is a sanity floor; a PBO ≥ 0.5 is a hard fail regardless of
  the other gates (the IS ranking is selecting noise).
- HLZ haircut is the cross-composite stringency layer; if a composite
  passes HLZ at M=57, that's evidence robust to "we tested several
  composites and this is the one that worked" multiple-testing inflation.
- OOS-IS Pardo is the temporal stability check; a strong IS Sharpe that
  collapses OOS fails this gate even if the in-sample DSR is large.

### Decision 5 — Verdict semantics and the anti-shopping rule

Three terminal outcomes for any composite's Phase B campaign:

| Verdict | Definition | Consequence |
| --- | --- | --- |
| **PASS-ALL** | All four gates pass on ≥1 (composite × benchmark) pair AND PBO < 0.2 on that pair | Composite is **eligible** for Phase C operator-decision per orchestration §7.1 item 8. Verdict surfaces to operator queue. |
| **PARTIAL** | ≥1 gate passes on the IS-best trial in the best benchmark, ≥1 gate fails | Composite stays informational (Layer-0 / Layer-5 LLM context). Verdict surfaces on the `/#/phase-b` dashboard with per-gate breakdown. |
| **FAIL** | DSR ≤ 0.95 in all benchmarks OR PBO ≥ 0.5 in all benchmarks OR HLZ fails in all benchmarks | Composite stays informational **permanently**. Verdict surfaces with the explicit "this composite is not Phase-C-eligible without a redesign that itself requires independent evidence" annotation. |

**Anti-shopping rule (from cycle_v1 §S-MCP-Q5, generalized here):**
Redesigning a composite in response to a FAIL or PARTIAL verdict is
forbidden without independent evidence the redesign would predict the
benchmark. A failed Phase B closes the v1 composite; a `cycle_v2`
(or analog) is a separate composite with a separate Phase B campaign,
not a re-run of v1's campaign with a tuned formula.

**What "independent evidence" means:** the redesign must be motivated by
an upstream methodology paper or canon source that did NOT see the v1
backtest result. A reader of AFML §11 or Bailey-LdP 2014 should be able
to recognize the redesign as "an a-priori-motivated methodology change"
rather than "a search over alternative formulas until one passes Phase B."

This rule is non-negotiable. Without it, every composite is one
re-parameterization away from "passing" and Phase B becomes ceremonial.

### Decision 6 — Persistence shape

Two new tables per the Phase B pattern:

**`quantlab.phase_b_trials`** — one row per (composite × benchmark × θ-trial):

```sql
CREATE TABLE quantlab.phase_b_trials
(
  composite_version  LowCardinality(String),    -- 'cycle_v1', 'vol_struct_v1', ...
  benchmark          LowCardinality(String),    -- 'SPY', 'QQQ', 'IWM', ...
  theta              Float32,                   -- threshold value
  trial_idx          UInt16,                    -- 0-indexed position in the trial grid
  is_start_date      Date,
  is_end_date        Date,
  oos_start_date     Date,
  oos_end_date       Date,
  is_sharpe          Float32,
  oos_sharpe         Float32,
  is_trades          UInt32,                    -- count of position transitions in IS
  oos_trades         UInt32,
  is_days_in_market  UInt32,                    -- days the strategy was LONG in IS
  oos_days_in_market UInt32,
  is_net_return_pct  Float32,
  oos_net_return_pct Float32,
  skewness_is        Float32,
  kurtosis_is        Float32,
  -- Per-slice IS Sharpes for CSCV — JSON-encoded array, length = effectiveS (typically 8 or 16)
  is_slice_sharpes   String,
  computed_at        DateTime64(3)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (composite_version, benchmark, trial_idx)
SETTINGS index_granularity = 8192
```

**`quantlab.phase_b_verdicts`** — one row per (composite × benchmark) summarizing the four-gate outcome:

```sql
CREATE TABLE quantlab.phase_b_verdicts
(
  composite_version    LowCardinality(String),
  benchmark            LowCardinality(String),
  best_trial_theta     Float32,                 -- θ of the IS-best trial
  best_is_sharpe       Float32,
  best_oos_sharpe      Float32,
  dsr_value            Nullable(Float32),       -- DSR ∈ [0,1]
  dsr_pass             UInt8,                   -- 0/1
  pbo_value            Nullable(Float32),       -- PBO ∈ [0,1]
  pbo_pass             UInt8,
  hlz_t_stat           Nullable(Float32),
  hlz_threshold        Nullable(Float32),
  hlz_pass             UInt8,
  oos_is_ratio         Nullable(Float32),
  oos_is_pass          UInt8,
  verdict              LowCardinality(String),  -- 'pass-all' | 'partial' | 'fail' | 'insufficient'
  phase_c_eligible     UInt8,                   -- 1 iff verdict='pass-all' AND pbo_value < 0.2
  campaign_run_at      DateTime64(3),
  notes                String                   -- per-campaign caveats (e.g., 'recession-period included in OOS')
)
ENGINE = ReplacingMergeTree(campaign_run_at)
ORDER BY (composite_version, benchmark)
SETTINGS index_granularity = 8192
```

Both tables are **ReplacingMergeTree on computed_at / campaign_run_at**, so
re-runs collapse cleanly. The HLZ aggregation across benchmarks within a
composite is computed at read-time from the `phase_b_trials` rows (each
trial's t-stat is `is_sharpe × sqrt(IS_days - 1) / sqrt(1 + 0.5 × is_sharpe²)`
using the Gaussian PSR approximation, sorted descending across all M
trials, BHY haircut applied).

### Decision 7 — Verdict surfacing

Two surfaces per the standard ADR-044 pattern:

1. **`/#/phase-b` dashboard panel** (UI worker, post-Cycle-23):
   - One row per composite, one column per benchmark; cells show the
     four-gate sparkline + verdict label.
   - Drill-in: per-(composite × benchmark) page showing the trial-Sharpe
     distribution, the IS-best trial's equity curve, the CSCV omega
     distribution, and the per-gate intuition/explanation/failure-mode
     text (already produced by `validator.ts` GateOutcome).
2. **Morning brief §0c** (Health worker, post-Cycle-23, appended after
   the daily health digest §0a/§0b):
   - One-line per composite: `cycle_v1: PASS-ALL on SPY (DSR=0.97, PBO=0.18, HLZ=passes, OOS/IS=0.62) — Phase C eligible (operator queue Q-NEW)`.
   - Only composites with PASS-ALL (eligible for Phase C) auto-surface to the
     operator queue. PARTIAL and FAIL verdicts surface only on the
     `/#/phase-b` dashboard.

### Decision 8 — Composite version pinning and the "no-result-shopping" auditable trail

Every (composite × campaign run) writes a row with the EXACT
`composite_version` string the v1 composite committed to. Any subsequent
methodology change to the composite REQUIRES a version bump (`v1` → `v2`).
The old v1 verdict row persists in `phase_b_verdicts`; the v2 campaign
writes a new row. This makes "did you redesign in response to a failed
Phase B?" a single CH query: are there `phase_b_verdicts` rows with the
same composite name but different versions? If yes, the v2 SPEC must
cite the independent-evidence justification per Decision 5.

## Consequences

**Positive:**
- Establishes one canon pattern for all 9 composite Phase B campaigns;
  the next 8 reuse the harness with per-composite SPECs that swap only
  benchmark + θ grid + score-rescaling.
- Each composite's verdict is auditable, version-pinned, and resistant to
  result-shopping via the §Decision 8 trail.
- DSR/PBO/HLZ/Pardo all use the same code paths as the rest of the
  validator (so a bug fix in `psr.ts` / `cscv.ts` / `hlzHaircut.ts`
  propagates automatically).
- Phase C eligibility is mechanically defined (PASS-ALL + PBO < 0.2) so
  operator decisions on Phase C promotion start from an unambiguous gate,
  not an orchestrator narrative.

**Negative:**
- The long-only template is **one** way to test the composite's claim,
  not the only way. A composite that "works" only on the short side
  (low-score → negative returns) would FAIL Phase B under this template
  and get permanently shelved. Mitigation: per-composite SPECs may include
  a "long-only-on-inverse-benchmark" variant as a sister campaign if the
  composite's claim is bidirectional. The variant counts as a separate
  composite-version (e.g., `cycle_v1_inverse`) for HLZ purposes.
- HLZ aggregation across multiple composites is **not** implemented in v1.
  Each composite's campaign deflates only against its own trial grid (M =
  N_θ × N_benchmarks). If a future operator wants to ask "the BEST of all
  9 composites — is it really significant given we tested 9?", a
  meta-HLZ pass is needed. ADR-051 leaves this for a future cycle; v1
  campaigns are per-composite-self-contained.

**Risks + mitigations:**
- **Composite worker writes a different strategy harness than the SPEC.**
  Mitigation: per-composite SPEC pins the strategy template signature; the
  worker output must include `applyStrategyTemplate(scores, benchmarks, θ)
  → trial_returns` as a pure-function unit-tested entry point.
- **Per-composite SPECs drift the four-gate thresholds.** Mitigation:
  thresholds in §Decision 4 are SPEC-pinned for the pattern. Per-composite
  SPECs are NOT permitted to relax them; only to override the strategy
  template (Decision 1), benchmark universe (Decision 2), or score-rescaling.
  A per-composite SPEC that proposes a relaxed threshold escalates to
  operator per orchestration §7.1.5.
- **The 70/30 fixed split picks up regime-specific OOS performance.**
  The OOS window 2021-2026 includes the 2022 bear market, the post-COVID
  recovery, and the 2024-2026 expansion — diverse regimes by construction.
  But a single split is a single test; rolling walk-forward would average
  over splits. Mitigation: documented as a campaign caveat in the verdict
  row's `notes` field; if a future operator wants rolling-WFA, it's a
  separate composite-version (e.g., `cycle_v1_wfa`) running a different
  campaign template.

## Canon foundations

The pattern is a direct application — not an amendment — of:

- **AFML §11.3** (CSCV via slice-Sharpes) and **§11.4** (DSR via
  expected-max-of-N-IID-normals + Mertens PSR variance) by López de Prado
  (2018). The deflation pipeline IS the §11 canon.
- **Bailey-López de Prado (2014)** "The Deflated Sharpe Ratio" §3 (PSR
  Eq. 3) + §11.5 (bootstrap SE variant).
- **Bailey-Borwein-López de Prado-Zhu (2014)** "The Probability of Backtest
  Overfitting" §2 (CSCV procedure definition 2).
- **Harvey-Liu-Zhu (2016)** "...and the Cross-Section of Expected Returns"
  §3-§4, §4.2 (BHY default for correlated tests).
- **Benjamini-Yekutieli (2001)** (BHY FDR control under arbitrary
  dependence) — used by HLZ §4.2.
- **Pardo (2008)** §3 (walk-forward) + §10 (OOS-IS evaluation).

The single project-specific decision (long-only threshold template) is
canon-thin (no published paper defines "the canonical strategy template
for validating a macro signal on equity benchmarks"). Resolved via the
three-criterion test (canon foundations / methodology rigor / minimum free
parameters) per CLAUDE.md autonomous-execution protocol:

- **Canon foundations:** Long-only is the simplest strategy form (Pardo
  §1; AFML §1; Aronson §3 — long-only momentum is the most-replicated
  finding in EBTA).
- **Methodology rigor:** Single-parameter sweep is the smallest possible
  trial space → minimal selection-bias inflation → most defensible DSR.
- **Minimum free parameters:** Single θ vs dual (θ_long, θ_short) vs
  continuous-exposure vs phase-categorical — long-only wins by trial
  count.

## Implementation plan (post-ADR)

- **Cycle 22 (this cycle):** ADR-051 ratified (this doc). Per-composite
  SPEC for cycle_v1 drafted at `docs/specs/phase-b-cycle-v1.md`.
- **Cycle 23+:** Composite worker implements the cycle_v1 instance:
  1. Migration script + tests for `phase_b_trials` + `phase_b_verdicts`
     tables.
  2. `scripts/phase_b_campaign_cycle_v1.ts` — backtest harness running
     the 19-trial × 3-benchmark sweep against `cycle_position_snapshots`
     + `candles` (SPY/QQQ/IWM).
  3. Validator integration: package each (composite × benchmark) trial
     set as a `ValidatorRequest`; persist verdict rows.
  4. Markdown report at `docs/analysis/phase-b-cycle-v1-deflation-2026-05.md`.
- **Cycle 24+:** Health worker implements the UI surface:
  1. `/#/phase-b` dashboard route + React panel.
  2. Morning brief §0c verdict-line renderer.
- **Cycles 25+ (one per composite):** Repeat steps 1-3 for
  vol_struct_v1, sector_rot_v1, cross_asset_v1, short_interest_v1, and
  the four remaining gap composites. Per-composite SPECs reuse most of
  cycle_v1's harness; deltas are the score-rescaling + benchmark universe.

## What this ADR does NOT decide

- The PASS-ALL → Phase C promotion **decision**. That is operator-gated
  per orchestration §7.1 item 8.
- The cross-composite meta-HLZ pass (deflating "best of 9"). Deferred
  to a future cycle.
- The "long-only-on-inverse-benchmark" sister campaign. Per-composite
  SPECs may add it; not required by the pattern.
- The retire-old-composite-version policy (when a v2 ships, is v1
  dropped from the dashboard, or kept as historical record?). Default:
  keep v1 forever in `phase_b_verdicts`; UI shows the latest version
  per composite.
- The trading-cost model (transaction costs, slippage) for the long-only
  strategy. Default: zero-cost backtest (Phase B is a *signal-quality*
  test, not a trade-execution test). A "would this be profitable after
  costs" follow-up is a Phase C concern, not Phase B.

## Cross-references

- `docs/architecture/multi-agent-orchestration.md` §7.3 (Phase B
  unbundling from operator queue) + §7.1 item 8 (Phase C still operator-
  gated).
- `docs/specs/market-cycle-position.md` §S-MCP-Q5 (anti-shopping rule
  origin for cycle_v1 specifically).
- `src/lib/psr.ts`, `src/lib/cscv.ts`, `src/lib/hlzHaircut.ts`,
  `src/lib/validator.ts` (the four-gate stack).
- `docs/specs/phase-b-cycle-v1.md` (per-composite SPEC, drafted in this
  cycle for Composite-worker execution in Cycle 23+).
