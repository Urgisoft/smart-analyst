---
status: spec-complete
phase: phase-b
last_updated: 2026-05-24
session: 96 #20 Cycle 26
owner: Orchestrator (Vector Core); Composite worker executes Cycle 26
type: spec
slice_id: adr-051-instance-cross_asset_v1
parent_adr: docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md
predecessor_specs:
  - docs/specs/phase-b-cycle-v1.md
  - docs/specs/phase-b-vol_struct_v1.md
  - docs/specs/phase-b-sector_rot_v1.md
---

# SPEC — Phase B deflation-pipeline campaign for `cross_asset_v1`

> **Fourth instance of the ADR-051 pattern.** Inherits all Cycle 23-25
> infrastructure (`phase_b_trials` + `phase_b_verdicts` tables, the
> `validator.ts` four-gate stack, the `phase_b_repository.ts` typed
> helpers, the `psr.ts` / `cscv.ts` / `hlzHaircut.ts` libraries, the
> `phase_b_dashboard.ts` UI roster — `cross_asset_v1` is already
> registered at [`phase_b_dashboard.ts:73`](../../src/server/phase_b_dashboard.ts#L73)
> pointing here, **S96-121 critic-enforceable invariant pre-satisfied
> at SPEC-write time**). This SPEC pins ONLY the per-composite overlay:
> score selection (which continuous indicator from the composite's
> multi-domain output to test), score-rescaling (standard Φ — polarity-
> aligned this cycle, NO S96-124 negation), benchmark universe, time
> window, file paths. Read [ADR-051](adr-051-layer0-phase-b-deflation-pipeline.md)
> and the predecessor SPECs first; this SPEC is the delta.

---

## 1. Scope

**Builds** (Composite worker, Cycle 26):

1. `scripts/_probe_phase_b_cross_asset_v1_inputs.ts` — Step 0 pre-flight
   probe (mirrors the sector_rot_v1 probe; checks
   `cross_asset_snapshots` row count + earliest date +
   `copper_gold_ratio_20d_change_pct` coverage; classifies state as
   full / empty / ambiguous per S96-117 + Cycle 24-25 refinements).
2. **IF Step 0 probe finds the snapshots table empty or sparse** (it
   will — pre-cycle row count is 4 rows; see §8 for the orchestrator's
   pre-SPEC probe result): `scripts/_backfill_cross_asset_snapshots.ts`
   — one-shot backfill computing daily `CrossAssetSignalsSnapshot` for
   every trading day in the campaign window via the existing
   `CrossAssetSignalsRepository.readInputsForCycle` +
   `computeCrossAssetSignals` path. Persists ~3,250 rows
   (2013-01-03 → today). Tier-1 auto-fix per ADR-044 + S96-117
   precedent (missing-ingest-never-fired carve-out); refer to the
   Cycle 25 sector_rot_v1 backfill helper as the structural template.
3. `scripts/phase_b_campaign_cross_asset_v1.ts` — campaign harness;
   ~70% shared infrastructure with `phase_b_campaign_cycle_v1.ts` /
   `phase_b_campaign_vol_struct_v1.ts` / `phase_b_campaign_sector_rot_v1.ts`.
   The substantive deltas are confined to `loadScoreSeries()`
   (copperGoldRatio20dChangePct → Φ-rescaled, polarity-aligned no
   negation) and benchmark/window constants. Wires into `validator.ts`
   four-gate stack per benchmark; persists trial + verdict rows with
   `composite_version = 'cross_asset_v1'`.
4. Markdown report at
   `docs/analysis/phase-b-cross_asset_v1-deflation-2026-05.md`
   (post-run verdict + per-gate diagnostics).
5. Unit tests for the harness (≥40 tests covering golden-vector
   backtest, Φ-rescaling identity + monotonicity,
   `loadScoreSeries` shape + filter behavior, score-benchmark
   alignment, walk-forward split, slice-Sharpe parity,
   ValidatorRequest packaging, verdict-aggregation rule,
   convention-pin tests on the live CH schema for
   `cross_asset_snapshots`).

**Does NOT build:**

- Any UI-domain edits. [`phase_b_dashboard.ts:73`](../../src/server/phase_b_dashboard.ts#L73)
  already registers `cross_asset_v1` with `specPath:
  'docs/specs/phase-b-cross_asset_v1.md'` (the path this SPEC lives
  at); the dashboard will surface this campaign's verdict rows
  automatically once persisted. **S96-121 critic-enforceable
  invariant pre-satisfied for this cycle** (same as Cycle 25 for
  sector_rot_v1).
- Phase C promotion path (operator-gated per orchestration §7.1
  item 8; Q-8 remains DORMANT — no Layer-0 composite has returned
  PASS-ALL yet; 3 of 3 shipped are PARTIAL).
- `cross_asset_v2` composite redesign in response to whatever this
  Phase B returns (anti-shopping rule per ADR-051 §Decision 5 /
  §Decision 8; the version pin `composite_version='cross_asset_v1'`
  on every persisted row makes any future `cross_asset_v2` row a
  single-query auditable event).
- A "long-only-on-inverse-benchmark" sister campaign (the standard
  long-only template + polarity-aligned Φ rescaling tests the
  unidirectional claim "high copper/gold momentum → long; low → flat"
  within the established harness; no sister campaign needed).
- Cross-composite meta-HLZ pass (deferred per ADR-051
  §Consequences; 4 of 9 composites with shipped verdicts after this
  cycle; revisit at 9-arc completion per OQ-C24-1 + OQ-C22-2 +
  OQ-C25-1).
- A multi-signal composite-score axis (e.g. weighted combination of
  DXY-Δ + real-rate-Δ + copper/gold-Δ + curve-segments). That would
  introduce a second tunable knob (the weights) and violate the
  "minimum free parameters" criterion in CLAUDE.md autonomous-
  execution protocol's three-criterion test. The per-composite SPEC
  tests cross_asset_v1's STRONGEST single-signal axis under the
  current data coverage (copper/gold ratio); if the composite as
  designed clears on that single axis the verdict is conservative;
  if it fails on that axis it may still have aggregate predictive
  value across signals (out of scope for this SPEC). Documented
  under §S-PBCA1-1.

---

## 2. cross_asset_v1-specific decisions

### S-PBCA1-1 — Score selection: `copperGoldRatio20dChangePct`, NOT `regimeFlag` / `creditInternalsDiffZ`

Per [`src/server/cross_asset_signals.ts`](../../src/server/cross_asset_signals.ts)
the composite emits an 8-way categorical `regimeFlag`
(severe_cross_asset_stress / dollar_shock / real_rate_spike /
commodity_growth_collapse / credit_internals_divergence /
curve_distortion / normal / unknown), 5 boolean flags
(dxyStrengthActive, realRateSpikeActive,
commodityGrowthCollapseActive, creditInternalsDivergenceActive,
curveDistortionActive), one discrete count (activeFlagCount ∈ 0..5),
one discrete count (invertedSegmentCount ∈ 0..2), and 14 continuous
measurements (dxy_close, dxy_20d_change_pct, usdjpy_20d_change_pct,
eurusd_20d_change_pct, real_rate_10y, real_rate_10y_20d_change_bps,
real_rate_5y, t10y2y, t10y3m, gld_20d_return, copx_20d_return,
**copper_gold_ratio_20d_change_pct**, credit_internals_diff,
credit_internals_diff_z).

NONE is a native [0,1] high=bullish score. This SPEC invokes
ADR-051 §Decision 1 last-paragraph + S96-120 (Φ default).

**Selected score: `copperGoldRatio20dChangePct`** (column
`copper_gold_ratio_20d_change_pct` in
`quantlab.cross_asset_snapshots`).

**Why copperGoldRatio20dChangePct over alternatives:**

| Candidate | Why rejected |
| --- | --- |
| `regimeFlag` (8-way categorical) | θ-grid degenerates to ≤7 trials; below ADR-051's "smallest defensible N" implicit floor (cycle_v1 = 19). PBO computation on ≤7 trials is degenerate (CSCV requires `effectiveS ≥ 4` splits with ≥1 trial in each rank position). Same critique that ruled out vol_struct_v1's 6-way regimeFlag (S96-119) + sector_rot_v1's 5-way regimeFlag (S96-123). |
| `activeFlagCount` (discrete 0..5) | Six distinct values; same degeneracy as regimeFlag. With Φ rescaling on a 6-value discrete input the score has only 6 distinct values regardless of θ-grid density. |
| `invertedSegmentCount` (discrete 0..2) | Three distinct values; same degeneracy. |
| Any of the 5 boolean `*Active` flags | Single-trial binary signal; no θ sweep; deflation pipeline has nothing to deflate. |
| `creditInternalsDiffZ` (continuous z) | **First-choice candidate per direct analogy with sector_rot_v1's `defensiveCyclicalSpreadZ` (already a z-score; baseline computed inside the repository). REJECTED for DATA-COVERAGE reasons:** the underlying FRED series `BAMLH0A0HYM2` (ICE BofA US HY OAS) on the free FRED endpoint is capped at ~3y of history (see [`cross_asset_signals_repository.ts:660`](../../src/server/cross_asset_signals_repository.ts#L660) docstring + pre-SPEC probe: `n=788, earliest=2023-05-19`). The z requires a 2y baseline → first valid `creditInternalsDiffZ` ≈ 2025-05-19 → only ~12 months of valid score inside our 13y campaign window. After filtering `IS NOT NULL` the IS/OOS split degenerates (effectiveS = 0). A future `cross_asset_v2` SPEC may re-test with `creditInternalsDiffZ` once FRED data coverage extends OR the orchestration ingests HY-OAS from an alternative free source. |
| `dxy20dChangePct` (continuous %) | Viable candidate — DTWEXBGS coverage from 2006-01-02 covers our window. Polarity-INVERTED (high DXY-Δ = dollar strength = equity-bearish via Ilmanen ch. 3 discount-rate channel). Would require S96-124 negate-before-Φ rescaling (Option B). REJECTED in favor of `copperGoldRatio20dChangePct` because the latter is polarity-aligned (simpler harness fork — no S96-124 negation), has equally strong canon (Ilmanen ch. 14 commodity factor structure), and has a more direct "growth → equity" thesis link than the DXY's "dollar → discount rate → equity" indirect path. DXY is informational-only at the composite level and reserved as a fallback if copperGoldRatio probes degenerate. |
| `realRate10y20dChangeBps` (continuous bps) | Viable candidate — DFII10 coverage from 2003-01-02 covers our window. Polarity-INVERTED (high real-rate-Δ = duration discount-rate spike = equity-bearish via Bauer & Rudebusch 2020 AER). Would require S96-124 negate-before-Φ rescaling. REJECTED for same reasons as DXY — polarity-inverted adds complexity vs the polarity-aligned copperGoldRatio. Strong canon support; reserved as fallback. |
| `copperGoldRatio20dChangePct` (continuous %) | **SELECTED.** Polarity-ALIGNED with cycle_v1 / vol_struct_v1 (high score = bullish): high ratio change = copper outperforming gold = growth signal = bullish equity exposure; low (negative) change = copper underperforming gold = growth weakness = flat-favorable. Continuous → full 19-trial θ-sweep available. Direct canon-cited "growth → equity" thesis (Ilmanen 2011 ch. 14 commodity factor structure; Erb & Harvey 2006 commodity carry). Both COPX (inception 2009-11-19) + GLD (inception 2004-11-18) cover the 2013-01-03 → today window with no data gaps. Standard Φ rescaling per S96-120 (NO negation; the simplest possible harness fork). |

**Polarity check.** `copperGoldRatio20dChangePct = (copxClose /
gldClose at t) / (copxClose / gldClose at t-20) − 1`, computed in
[`cross_asset_signals_repository.ts:570-591`](../../src/server/cross_asset_signals_repository.ts#L570-L591)
`computeCopperGoldRatioChange`. Polarity is documented in the
function docstring ("copper falling vs gold = growth weakness =
change < 0; the flag at SPEC §2 fires when change < -0.05"):

- High change (positive, copper outperforming gold) = growth signal
  = **long-favorable / bullish on equity exposure**
- Low change (negative, copper underperforming gold) = growth
  weakness = **flat-favorable / bearish on equity exposure**

**Polarity is ALIGNED** with cycle_v1 (high cycle logit = bullish)
and vol_struct_v1 (high VIX-term-structure-z = bullish vol normalization).
Standard Φ rescaling per S96-120 default applies; **no S96-124
negation needed** for this cycle. The Composite worker's harness is
the simplest possible fork of vol_struct_v1's harness (drop the
"first per-composite SPEC to negate" provision; use straight `Φ(z)`).

### S-PBCA1-2 — Score-rescaling: `score = Φ(copperGoldRatio20dChangePct)`

Per S96-120 (Φ default for continuous unbounded score axes lacking a
native [0,1] form):

```
score(t) = Φ(copperGoldRatio20dChangePct(t))
```

Φ implementation: Abramowitz & Stegun 26.2.17 polynomial
approximation (max error ~7.5e-8). Either import + reuse from
`phase_b_campaign_sector_rot_v1.ts:normalCdf` (preferred per
DRY-not-WET) or fork-copy (acceptable per S96-118 "after the 9th
composite ships, evaluate whether a generalized phase_b_campaign.ts
abstraction is warranted"). Tests pin Φ(0)=0.5, Φ(±1)≈0.8413/0.1587,
Φ(±2)≈0.9772/0.0228 golden vectors. **No polarity-flip identity
test required this cycle** (negation not used); the Φ(0)=0.5 +
monotonicity tests suffice.

**Numeric domain caveat.** `copperGoldRatio20dChangePct` is bounded
roughly [-0.30, +0.30] empirically (20-day relative-price moves on
~3-4σ envelope are rare). Mapping through Φ collapses the dynamic
range to roughly [0.38, 0.62] — i.e. the θ-grid will mostly
discriminate small differences in the bulk of the distribution.
This is acceptable: the θ-sweep is selection-bias-deflated by HLZ
and the validator finds whichever θ maximizes IS Sharpe; the
specific units don't affect the test mechanics. **However**, the
empirical θ* values in the verdict report are NOT directly
interpretable as "long when copper-gold ratio change > X" — they
must be re-mapped through Φ⁻¹ to get the raw threshold. The
verdict-rendering code (inherited from cycle_v1) reports both θ
(post-Φ-rescaling) and the implied raw threshold for operator
review.

**θ interpretation under straight-Φ rescaling.** A θ of 0.5 means
"go long when copperGoldRatio20dChangePct > 0" (copper outperforming
gold on net 20d basis). θ = 0.84 means "go long when ratio change
> +1σ of the daily distribution" (copper strongly outperforming
gold). θ = 0.16 means "go long unless ratio change < −1σ" (only
flat when copper sharply underperforms gold). The standard 19-trial
θ grid {0.05, 0.10, …, 0.95} probes ratio-change z ∈ [−1.64σ,
+1.64σ] — spanning the bulk of the empirical distribution.

### S-PBCA1-3 — Benchmark universe: SPY + QQQ + IWM

Same as cycle_v1 / vol_struct_v1 / sector_rot_v1 (ADR-051 §Decision
2 + S-PBC1-3 + S-PBV1-3 + S-PBSR1-3). Justification for
cross_asset_v1: the composite's claim is "non-equity cross-asset
signals predict US equity stress episodes" — directly testable on
US equity benchmarks. Same three economically-distinct benchmarks
(SPY broad / QQQ tech-growth / IWM small-cap); same M=57 HLZ
trial budget.

Benchmark token addresses + the QQQ/IWM yfinance backfill already
landed in CH per Cycle 23 S96-117 (verified at SPEC-write time:
QQQ_USD 4,783 rows + IWM_USD 4,783 rows + SPY_USD 4,627 rows, all
through 2026-05-22). No further benchmark prep needed.

### S-PBCA1-4 — θ trial grid: {0.05, 0.10, …, 0.95}, 19 trials

Same as cycle_v1 / vol_struct_v1 / sector_rot_v1 (ADR-051 §Decision
1). Identical small-N defensibility argument; identical M=57 =
19 × 3 HLZ denominator.

### S-PBCA1-5 — Time window + walk-forward split

**Data-coverage constraints (pre-SPEC probe at SPEC-write time):**

- `DTWEXBGS` (DXY): 2006-01-02 → 2026-05-15 (5,107 rows). Covers
  window; lags ~7d on FRED's weekly batches but acceptable for an
  informational composite.
- `DFII10` / `DFII5` (real rates): 2003-01-02 → 2026-05-21 (5,851 rows).
  Covers window.
- `T10Y2Y` / `T10Y3M` (curve): 1996-01-02 → 2026-05-22 (7,604 rows).
  Covers window.
- `BAA10Y`: 1996-01-02 → 2026-05-21 (7,597 rows). Covers window.
- `BAMLH0A0HYM2` (HY-OAS): 2023-05-19 → 2026-05-21 (**788 rows**).
  Does NOT cover the 2013-01-03 → 2023-05-19 portion — the FRED
  free-endpoint history cap. Drives §S-PBCA1-1's rejection of
  `creditInternalsDiffZ` as score axis.
- `GLD_USD`: 2008-01-02 → 2026-05-22 (4,627 rows). Covers window.
- `COPX_USD`: probed via the same query — covers window
  (Composite worker MUST verify COPX_USD coverage in Step 0
  probe; if pre-2013 sparse, the campaign degrades gracefully via
  `loadScoreSeries`'s `IS NOT NULL` filter).
- `SPY_USD` / `QQQ_USD` / `IWM_USD`: all covered (Cycle 23 S96-117).

**Window** (matches predecessors for cross-composite meta-HLZ parity
per OQ-C22-2 / OQ-C24-1 / OQ-C25-1):

- **Full:** 2013-01-03 → today (~13 years, ~3,250 trading days).
- **IS:** 2013-01-03 → 2022-12-31 (~10 years, ~2,520 trading days).
- **OOS:** 2023-01-03 → today (~3 years, ~730 trading days).

**Why match the predecessor window rather than extend earlier:**

| Consideration | Verdict |
| --- | --- |
| Statistical power: longer IS = more CSCV slices | Marginal benefit; CSCV `effectiveS` caps at 16 once T > 1024 (per `cscv.ts:115`). 2520 days already saturates. |
| Cross-composite meta-HLZ + meta-PSR aggregation | **Decisive.** Matching windows across all 9 Layer-0 composites makes the 9-arc-completion meta-HLZ pass (M_meta = 9 × 57 = 513) mechanical. Deviating now propagates complication. |
| Regime diversity | 2013-2022 IS includes 2015-16 China growth scare, 2018 Q4 risk-off, 2020 COVID, 2022 inflation regime; 2023-2026 OOS includes the post-Fed-pivot rally + 2024 mini-yen-carry-unwind. Adequate diversity. |

**Pinned constants:**

- `WINDOW_START_DATE = "2013-01-03"` (first trading day of 2013 US;
  matches all predecessors).
- `IS_END_DATE = "2022-12-31"`.
- `OOS_START_DATE = "2023-01-03"` (first trading day of 2023 US).

**Note on `creditInternalsDiffZ` and `regimeFlag` 'unknown'.** The
composite's `regimeFlag` requires ALL flag-driving inputs present
(DXY + real-rate + curve + commodities + credit-internals-z). Pre-
2025 the credit-internals-z is null due to BAMLH0A0HYM2 history;
`regimeFlag = 'unknown'` for almost the entire campaign window.
**However**, the selected score `copperGoldRatio20dChangePct` only
requires GLD + COPX (both covered) — so the score is computable
throughout. The campaign harness's `loadScoreSeries` filters on
`copper_gold_ratio_20d_change_pct IS NOT NULL`; rows where the
score is null (a handful of edge dates with one-side trading-day
gaps) would be skipped silently per S-PBV1 §3 pattern.

### S-PBCA1-6 — CSCV slice configuration

Per `cscv.ts:115-117` auto-downshift logic: T ≈ 2520 → effectiveS =
16 (above the 1024 threshold) → C(16, 8) = 12,870 combos. Same as
cycle_v1 / vol_struct_v1 / sector_rot_v1.

### S-PBCA1-7 — Four-gate validator invocation

**Identical to cycle_v1 SPEC §S-PBC1-6** (inherited verbatim
including the parametric Mertens DSR path per S96-116). The only
delta is the input scores being straight-Φ-rescaled
copperGoldRatio20dChangePct rather than raw cycle_v1 score; the
validator stack is composite-agnostic.

DSR path: **parametric Mertens, NOT bootstrap.** Same rationale as
predecessors:

- `observedSharpe = bestTrial.is_sharpe` (argmax over θ trials, not
  median over assets).
- No cross-sectional asset panel; bootstrap `perAssetSharpes` path
  is not applicable.
- `bootstrapDSR()` in `psr.ts:185-186` requires
  `observedSharpe ≈ median(perAssetSharpes)`; here it would
  resample the selection-bias axis and produce a meaningless SE.

HLZ M = 19 × 3 = 57, BHY one-sided at α=0.05. Same threshold as
predecessors. **OQ-C25-1 reinforces the watch:** if HLZ M=57 blocks
this 4th cycle as well, the cross-composite meta-HLZ at 9-arc
completion becomes the primary diagnostic (potentially relaxing per-
composite-self-contained HLZ in favor of pooled-power) — but DO NOT
relax HLZ this cycle (anti-shopping per ADR-051 §Decision 5).

### S-PBCA1-8 — Verdict aggregation across benchmarks

Inherited verbatim from cycle_v1 SPEC §S-PBC1-7 / vol_struct_v1
SPEC §S-PBV1-8 / sector_rot_v1 SPEC §S-PBSR1-8 / ADR-051 §Decision
5. A composite passes Phase B iff ≥1 benchmark has
`verdict='pass-all'` AND `pbo_value < 0.2`. Otherwise PARTIAL or
FAIL per the standard verdict-tier rules.

Phase C eligibility is mechanical: `phase_c_eligible = 1 iff
verdict='pass-all' AND pbo_value < 0.2`. The orchestration does
NOT auto-promote on Phase C eligibility; Q-8 (operator queue)
remains the only path from eligibility to actual promotion.

### S-PBCA1-9 — Composite version pinning

Every row written to `quantlab.phase_b_trials` and
`quantlab.phase_b_verdicts` MUST have
`composite_version = 'cross_asset_v1'`. Per ADR-051 §Decision 8
anti-shopping rule, a future `cross_asset_v2` redesign in response
to whatever this Phase B verdict returns would require independent
canon-cited evidence motivating the redesign (e.g. the FRED HY-OAS
history extending to enable `creditInternalsDiffZ` as a
materially-different score axis). The CH version pin makes any
future `cross_asset_v2` row a single-query auditable event.

---

## 3. Strategy harness — exact signature

Identical to sector_rot_v1 EXCEPT for `loadScoreSeries()` (straight Φ,
no negation) + composite_version pin + window constants (same as
predecessor). Reuses `backtestTrial`, walk-forward split,
slice-Sharpe computation, ValidatorRequest packaging, and verdict
aggregation from `phase_b_campaign_cycle_v1.ts` /
`phase_b_campaign_vol_struct_v1.ts` /
`phase_b_campaign_sector_rot_v1.ts`. Either import + reuse
(preferred per DRY-not-WET) or fork-copy (acceptable per S96-118).

```ts
// scripts/phase_b_campaign_cross_asset_v1.ts

/** Daily Φ-rescaled copperGoldRatio20dChangePct, indexed by
 *  snapshot_date. Pulled from quantlab.cross_asset_snapshots. */
interface ScoreSeries {
  dates: Date[];          // ascending, daily, trading-day-aligned
  scores: number[];       // same length; values in [0, 1] post-rescaling
}

// loadScoreSeries — the ONLY substantive delta from sector_rot_v1:
//   - reads copper_gold_ratio_20d_change_pct instead of
//     defensive_cyclical_spread_z
//   - applies straight normalCdf(x) — NO negation (polarity-aligned)
//   - filters composite_version = 'cross_asset_v1'
async function loadScoreSeries(
  ch: ClickHouseClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `
      SELECT toString(snapshot_date)                AS d,
             copper_gold_ratio_20d_change_pct       AS x
      FROM quantlab.cross_asset_snapshots FINAL
      WHERE snapshot_date >= {start:Date}
        AND snapshot_date <= {end:Date}
        AND copper_gold_ratio_20d_change_pct IS NOT NULL
        AND composite_version = 'cross_asset_v1'
      ORDER BY snapshot_date ASC
    `,
    query_params: { start: ymd(windowStart), end: ymd(windowEnd) },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; x: string | number }>();
  const dates: Date[] = [];
  const scores: number[] = [];
  for (const r of rows) {
    const x = typeof r.x === 'string' ? parseFloat(r.x) : r.x;
    if (!Number.isFinite(x)) continue;
    dates.push(new Date(r.d + 'T00:00:00Z'));
    scores.push(normalCdf(x));    // straight Φ per S-PBCA1-2; NO negation
  }
  return { dates, scores };
}
```

`backtestTrial`, `score-benchmark alignment`, `trade counting`,
`walk-forward split`, `slice-Sharpe computation`, `ValidatorRequest
packaging`, and `verdict aggregation` are all identical to the
predecessor harnesses and may be either imported (preferred) or
fork-copied (acceptable).

---

## 4. Persistence — exact CH queries

Identical to cycle_v1 / vol_struct_v1 / sector_rot_v1 SPEC §4.
Tables `quantlab.phase_b_trials` + `quantlab.phase_b_verdicts`
already exist (Cycle 23 migrations); no new DDL.

Insert shape mirrors predecessors with
`composite_version = 'cross_asset_v1'`, benchmark in {SPY, QQQ,
IWM}, theta in {0.05, …, 0.95}, is_start/end/oos_start/end per
S-PBCA1-5.

---

## 5. Test plan (Composite-worker deliverable)

Target ≥40 tests across the new files:

- [ ] `_probe_phase_b_cross_asset_v1_inputs.test.ts` (~6 tests):
      probe output schema; convention-pin against live CH columns;
      state-classifier (full / empty / ambiguous) under simulated
      inputs; failure modes (table absent → loud, table sparse →
      loud).
- [ ] `_backfill_cross_asset_snapshots.test.ts` (~6 tests):
      one-shot idempotency under ReplacingMergeTree; row-count
      expectation (~3,250 ± slack for trading-day calendar);
      ambiguous-state guard (does NOT silently re-backfill a
      partially-populated table); fail-loud on candle data missing
      for required series (GLD_USD, COPX_USD).
- [ ] `phaseBCampaignCrossAssetV1.test.ts` (≥28 tests):
  - `normalCdf` golden-vector parity (Φ(0)=0.5, Φ(±1)≈0.8413/0.1587,
    Φ(±2)≈0.9772/0.0228, max error <1e-6 across ±3σ).
  - `normalCdf` monotonicity (z1 > z2 ⇒ Φ(z1) > Φ(z2)).
  - **Polarity-aligned source-text pin:** grep for literal
    `normalCdf(x)` in `loadScoreSeries`; REJECT any `normalCdf(-x)`
    standing alone (would indicate a worker mistakenly copied
    sector_rot_v1's negate-before-Φ pattern when this cycle is
    polarity-ALIGNED). The pin is the inverse of sector_rot_v1's
    test for the same reason.
  - `loadScoreSeries` skips null `copper_gold_ratio_20d_change_pct`
    rows.
  - `loadScoreSeries` produces dates ASC + same-length scores.
  - `loadScoreSeries` applies NO negation (test: high ratio-change
    input → high score output; low ratio-change input → low score
    output — DIRECT relationship, opposite of sector_rot_v1's
    inverse relationship).
  - Backtest correctness: golden-vector test mirroring cycle_v1
    (`flat-when-score≤θ`, `long-when-score>θ`, trade count =
    transitions, Sharpe matches hand-computed reference).
  - Score-benchmark alignment: 4-trading-day forward-fill cap
    inherited from cycle_v1 §3.
  - Walk-forward split: IS_END_DATE = 2022-12-31 cleanly divides;
    first OOS day = 2023-01-03.
  - CSCV slice configuration: T~2520 → effectiveS=16.
  - ValidatorRequest packaging: parametric Mertens DSR path (no
    `perAssetSharpes`); hlzNTests=57; hlzMethod='bhy';
    hlzTwoSided=false.
  - Verdict-aggregation rule: 3-benchmark aggregation; PASS-ALL
    requires same benchmark passing all four gates AND PBO<0.2.
  - composite_version pin: every persisted row has
    composite_version='cross_asset_v1'.
- [ ] Existing test suite stays at ≥3689 pass + 17 skip + 0 fail
      (Cycle 25 baseline).

Target post-Cycle-26: ~3689 + ~40 = ~3729 tests minimum.

---

## 6. Verification gates (Composite worker integration gate)

```text
# Pre-flight (Step 0):
npx tsx scripts/_probe_phase_b_cross_asset_v1_inputs.ts                  # exit 0 + readable summary

# Backfill IF probe finds the table sparse:
npx tsx scripts/_backfill_cross_asset_snapshots.ts --apply               # ~3,250 rows written

# tsc + tests + campaign dry-run:
npx tsc --noEmit                                                          # ≤ 13 baseline
node --import tsx --test scripts/tests/phaseBCampaignCrossAssetV1.test.ts # ≥28/28 pass
node --import tsx --test scripts/tests/_probe_phase_b_cross_asset_v1*.test.ts \
                                       scripts/tests/_backfill_cross_asset*.test.ts  # ≥12/12 pass
node --import tsx --test                                                  # full suite: ≥3729 pass + 17 skip + 0 fail
npm run health:check:strict                                               # exit 0 OR same Tier-2 set as pre-cycle

# End-to-end campaign run (orchestrator-executed after worker integration):
npx tsx scripts/phase_b_campaign_cross_asset_v1.ts --dry-run              # console summary only
npx tsx scripts/phase_b_campaign_cross_asset_v1.ts --apply                # writes 57 trial rows + 3 verdict rows

# Verify persisted state via the repository (no clickhouse-client needed):
npx tsx -e "import('./src/server/phase_b_repository.js').then(async m => { \
  const r = new m.PhaseBRepository(); \
  console.log(await r.readVerdicts({composite_version:'cross_asset_v1'})); \
})"
```

---

## 7. Files / code state at Cycle 26 close (target)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/phase-b-cross_asset_v1.md` | new | This SPEC |
| `scripts/_probe_phase_b_cross_asset_v1_inputs.ts` | new | Step 0 pre-flight |
| `scripts/_backfill_cross_asset_snapshots.ts` | new (conditional) | Tier-1 auto-fix per S96-117 precedent |
| `scripts/phase_b_campaign_cross_asset_v1.ts` | new | Harness — `loadScoreSeries` is the only substantive delta from sector_rot_v1 |
| `scripts/tests/phaseBCampaignCrossAssetV1.test.ts` | new | ≥28 tests |
| `scripts/tests/_probe_phase_b_cross_asset_v1_inputs.test.ts` | new | ~6 tests |
| `scripts/tests/_backfill_cross_asset_snapshots.test.ts` | new | ~6 tests |
| `docs/analysis/phase-b-cross_asset_v1-deflation-2026-05.md` | new (post-`--apply`) | Verdict report |
| `package.json` | modified | NPM scripts: `phase_b:cross_asset_v1:dry`, `phase_b:cross_asset_v1:apply`, `_probe:phase_b_cross_asset_v1`, `_backfill:cross_asset_snapshots` |
| `quantlab.cross_asset_snapshots` | +~3,250 rows | Backfill via repository (forward-only additive; ReplacingMergeTree idempotent) |
| `quantlab.phase_b_trials` | +57 rows | composite_version='cross_asset_v1' × 3 benchmarks × 19 θ trials |
| `quantlab.phase_b_verdicts` | +3 rows | composite_version='cross_asset_v1' × {SPY, QQQ, IWM} |
| `src/server/phase_b_dashboard.ts` | UNCHANGED | `cross_asset_v1` already in KNOWN_COMPOSITES roster at line 73 per Cycle 24 pre-population (S96-121 invariant pre-satisfied) |

No real-money path touched. No paid data. No authenticated scraping.
All within data-source policy (yfinance + FRED + CH writes
pre-authorized). No UI-domain edits (S96-121 critic-enforceable
invariant satisfied at SPEC-write time via Cycle 24's
KNOWN_COMPOSITES pre-population).

---

## 8. Watch-outs

- **The score axis chosen here is narrower than cross_asset_v1's
  full composite output.** The composite emits 5 flags + 1
  regimeFlag spanning 5 economically-distinct domains (currency,
  real rates, curve, commodities, credit internals). This Phase B
  tests ONE continuous axis (copper/gold ratio momentum) from one
  domain (commodities). A PARTIAL/FAIL verdict on this axis does
  NOT condemn the composite as a whole — it specifically condemns
  the copper-gold ratio change as a standalone θ-sweep signal at
  the 13y / SPY+QQQ+IWM benchmark / M=57 HLZ envelope. The verdict
  report MUST surface this scope explicitly to prevent
  misinterpretation. Other domains may carry verifiable signal
  that this campaign can't test (DXY-Δ, real-rate-Δ as polarity-
  inverted single-domain campaigns; or a future multi-domain
  weighted-score `cross_asset_v2` if and when canon support
  emerges). Reserved per S-PBCA1-1 alternatives table.
- **The Gaussian assumption baked into Φ-rescaling is approximately
  correct, not exactly correct.** Same caveat as predecessors.
  copperGoldRatio20dChangePct is NOT a z-score (unlike sector_rot_v1's
  defensiveCyclicalSpreadZ which already has built-in N(0,1)
  semantics). Its empirical distribution is approximately normal
  with skew toward negative tails (commodity collapses are sharper
  than gradual outperformance). The Φ rescaling will compress the
  positive tail more than the negative, biasing θ-grid resolution
  toward the negative side of the dispersion. Documented; no v2
  ECDF fallback planned unless empirical tail behavior shows
  material bias. (A future `cross_asset_v2` SPEC could re-test
  with ECDF rescaling as an alternative; out of scope here.)
- **cross_asset_snapshots was forward-only before this cycle (4 rows,
  2026-05-19 → 2026-05-24).** The Step 0 probe + conditional
  backfill is critical. If the worker skips the probe + runs
  straight into the campaign, the `loadScoreSeries` query will
  return ≤4 rows and the campaign will fail with degenerate
  `effectiveS = 0` from CSCV. The probe MUST gate the campaign.
- **The probe's state classifier (full / empty / ambiguous) MUST
  honor the Cycle 24-25 refinement:** if the table has SOME rows
  but coverage is partial (earliest_date > 2014 OR row_count <
  2500), the worker should NOT silently re-backfill the whole
  range — it should report the partial state in the return summary
  and let the critic decide whether to expand the backfill or
  accept the partial coverage. The default fallback is "fail-loud
  and ask critic."
- **BAMLH0A0HYM2 (HY-OAS) history cap → creditInternalsDiffZ null
  almost everywhere in window.** The backfill will populate
  cross_asset_snapshots with `credit_internals_diff` and
  `credit_internals_diff_z` columns that are mostly NULL pre-2025.
  The selected score `copper_gold_ratio_20d_change_pct` is
  unaffected. The composite's `regime_flag` column will be
  `'unknown'` for most of the pre-2025 backfill (regimeFlag
  requires ALL inputs present) — this is **intended graceful-
  degrade behavior** per [`cross_asset_signals.ts:240-262`](../../src/server/cross_asset_signals.ts#L240-L262)
  and does NOT block this campaign.
- **The OOS window is short** (~730 trading days) — same as
  predecessors. OOS-IS Pardo gate is computed on shorter samples
  → wider SE on the ratio. Documented as a campaign caveat in the
  verdict row's `notes` field.
- **HLZ M=57 has blocked 3 of 3 shipped composites at rank-1.**
  Per HANDOFF OQ-C25-1, the M=57 threshold appears to be the
  dominant failure mode for the Layer-0 arc. If cross_asset_v1's
  copper-gold ratio change clears HLZ where the predecessors did
  not, that would be a strong differential signal that the
  commodity-growth-collapse thesis has more standalone power than
  the cycle-position / vol-structure / sector-rotation theses.
  If it doesn't clear, the 4-of-4 pattern strengthens OQ-C25-1's
  case that cross-composite meta-HLZ at 9-arc completion is the
  primary diagnostic. **Either outcome is informative; the SPEC
  takes no position.** Verdict report MUST surface the HLZ-
  failure pattern across all 4 composites once this cycle
  completes.
- **Per S96-117, the Composite worker may invoke the backfill
  helper inside its scope as a Tier-1 auto-fix** (analogous to
  QQQ/IWM backfill in Cycle 23 + vol_structure_snapshots backfill
  in Cycle 24 + sector_rotation_snapshots backfill in Cycle 25).
  However, the ambiguous-state guard (above) MUST hold.
- **The harness's `pickPrimaryPhaseCCandidate` tiebreaker is still
  undocumented** (OQ-C23-3 / OQ-C24-3 / OQ-C25 carry-over). If
  cross_asset_v1 returns PASS-ALL on multiple benchmarks with tied
  DSR, the primary selection is ambiguous. Acceptable for this
  cycle; resolve in a future cycle.
- **NPM-script-file-renaming risk.** sector_rot_v1's harness
  exports symbols (`normalCdf`, types) that this cycle's harness
  imports. If the worker chooses the "import + reuse" path
  (preferred), it MUST verify those exports exist + are stable in
  `phase_b_campaign_sector_rot_v1.ts`. If a Cycle 25 worker
  renamed the symbol since this SPEC was drafted, the import will
  fail — fork-copy is the fallback.
- **CANON-THIN DECISIONS block required per S96-125.** If the
  Composite worker makes ≥1 canon-thin pick (e.g. fork-copy
  normalCdf per S96-118; trading-day calendar source SPY_USD per
  "composite's own load-bearing series" rule extended to "US
  trading-day calendar for US-traded inputs"), the harness header
  MUST include a `// CANON-THIN DECISIONS (three-criterion
  justification per CLAUDE.md):` block enumerating each pick with
  the three criteria. Critic enforces presence; absence is a
  RESOLVE-IN-PLACE flag.

---

## 9. Open questions — none for SPEC scope

Per orchestration §1 trivial-edit exception, this SPEC is closed
for Composite-worker execution. The worker takes this SPEC +
ADR-051 + the predecessor SPECs as the constraint envelope and
ships against them. The worker MUST NOT relax any threshold or
deviate from any decision in §2-§7 without escalating per
orchestration §7.1.5.

---

## 10. Cross-references

- Parent ADR: `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
- Predecessor SPECs:
  - `docs/specs/phase-b-cycle-v1.md` (Cycle 23 first instance; PARTIAL)
  - `docs/specs/phase-b-vol_struct_v1.md` (Cycle 24 second instance;
    PARTIAL; established Φ-rescaling default per S96-120)
  - `docs/specs/phase-b-sector_rot_v1.md` (Cycle 25 third instance;
    PARTIAL; established polarity-flip default per S96-124 for
    polarity-inverted composites — does NOT apply this cycle)
- Composite implementation: `src/server/cross_asset_signals.ts` (the
  `cross_asset_v1` composite this campaign validates)
- Composite I/O: `src/server/cross_asset_signals_repository.ts`
- Validator orchestrator: `src/lib/validator.ts`
- DSR/PBO/HLZ library: `src/lib/psr.ts`, `src/lib/cscv.ts`,
  `src/lib/hlzHaircut.ts`
- Phase B repository (composite-agnostic, Cycle 23 deliverable):
  `src/server/phase_b_repository.ts`
- Reference campaign harnesses:
  - `scripts/phase_b_campaign_cycle_v1.ts`
  - `scripts/phase_b_campaign_vol_struct_v1.ts`
  - `scripts/phase_b_campaign_sector_rot_v1.ts` (closest template —
    same overall structure; this cycle drops the polarity-flip)
- Snapshot data source: `quantlab.cross_asset_snapshots`
  (forward-only at SPEC-write time; backfill is part of this cycle)
- Benchmark data source: `quantlab.candles` (SPY/QQQ/IWM at `1d`
  interval; backfilled in Cycle 23 per S96-117)
- Original gap composite design: `docs/specs/cross-asset-signals.md`
- Phase B UI surface: `src/server/phase_b_dashboard.ts`
  (KNOWN_COMPOSITES line 73 already registers `cross_asset_v1` →
  this SPEC's path; S96-121 invariant pre-satisfied)
- Canon foundations:
  - Ilmanen 2011 *Expected Returns* ch. 3 (currency / real rates
    as duration-asset discount-rate channel — informational for
    the composite as a whole)
  - Ilmanen 2011 *Expected Returns* ch. 14 (commodity factor
    structure — primary canon for the selected score axis)
  - Asness, Moskowitz, Pedersen 2013 "Value and Momentum
    Everywhere" *Journal of Finance* — cross-asset signal
    correlation structure
  - Erb & Harvey 2006 "The Strategic and Tactical Value of
    Commodity Futures" *FAJ* — commodity-momentum support for the
    selected score axis
  - Bauer & Rudebusch 2020 "Interest Rates Under Falling Stars"
    *AER* — real rates → equity multiples (informational; rejected
    alternative)
  - Bailey & López de Prado 2014 "Deflated Sharpe Ratio" §3 — DSR
  - Bailey, Borwein, López de Prado, Zhu 2014 "Probability of
    Backtest Overfitting" §IV — CSCV
  - Harvey, Liu, Zhu 2016 "…and the Cross-Section of Expected
    Returns" §II.B — BHY one-sided multiple-testing haircut
  - Pardo 2008 *Evaluation and Optimization of Trading Strategies*
    §2-3 — walk-forward IS/OOS protocol
  - Abramowitz & Stegun *Handbook of Mathematical Functions*
    26.2.17 — Φ polynomial approximation
