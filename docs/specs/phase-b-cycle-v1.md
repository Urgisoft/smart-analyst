---
status: spec-complete
phase: phase-b
last_updated: 2026-05-24
session: 96 #20 Cycle 22
owner: Orchestrator (Vector Core); Composite worker executes Cycle 23+
type: spec
slice_id: adr-051-instance-cycle_v1
parent_adr: docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md
---

# SPEC — Phase B deflation-pipeline campaign for `cycle_v1`

> **First instance of the ADR-051 pattern.** This SPEC pins the cycle_v1-
> specific decisions (benchmarks, θ grid, score-rescaling, exact CH queries,
> file paths) and inherits everything else from
> [ADR-051](adr-051-layer0-phase-b-deflation-pipeline.md). Read ADR-051
> first; this SPEC is *only* the per-composite overlay.

---

## 1. Scope

**Builds** (Composite worker, Cycle 23):

1. Migration scripts for `quantlab.phase_b_trials` + `quantlab.phase_b_verdicts`
   (schemas pinned in ADR-051 §Decision 6; this SPEC adds the cycle_v1-
   specific test fixtures).
2. `scripts/phase_b_campaign_cycle_v1.ts` — the campaign harness running
   the 19-trial × 3-benchmark sweep, computing per-trial backtests +
   per-slice Sharpes, packaging trial-sets into `ValidatorRequest` shape,
   running `validator.ts` four-gate stack per benchmark, persisting trial +
   verdict rows.
3. Markdown report at `docs/analysis/phase-b-cycle-v1-deflation-2026-05.md`
   (post-campaign-run verdict + per-gate diagnostics).
4. Unit tests for the harness (≥30 tests covering golden-vector backtest
   outputs, walk-forward split correctness, slice-Sharpe parity with
   `bt_runs_slices` conventions, ValidatorRequest packaging).

**Builds** (Health worker, Cycle 24):

5. `/#/phase-b` dashboard route + `PhaseBApp.tsx` component (per ADR-051
   §Decision 7).
6. Morning brief §0c renderer addition to `src/server/operator_brief_render.ts`.

**Does NOT build:**

- Phase C promotion path (operator-gated; only triggers if Phase B verdict
  is `pass-all` AND `pbo_value < 0.2`).
- Cross-composite meta-HLZ pass.
- "Long-only-on-inverse-benchmark" sister campaign (not warranted for
  cycle_v1 — the bidirectional claim of cycle_v1 is "high score → bullish,
  low score → bearish/contractionary," which the long-only template tests
  honestly via the "stay flat in bearish periods → underperform/Sharpe-deflate
  if signal is noise" mechanism).
- Trading-cost model (deferred to Phase C per ADR-051 §What this ADR does NOT decide).

---

## 2. cycle_v1-specific decisions

### S-PBC1-1 — Score-rescaling: identity (no rescaling needed)

`cycle_v1` emits `score ∈ [0, 1]` per `cycle_position.ts:204` (the
`CyclePositionSnapshot.score` field). High score = "early cycle / expansion-
has-room" per `cycle_position.ts:229` (the 0.00..1.00 semantics docstring).

ADR-051 §Decision 1 strategy template applies directly:
`position(t) = LONG benchmark if score(t-1) > θ, else FLAT`.

### S-PBC1-2 — Benchmark universe: SPY + QQQ + IWM

Per ADR-051 §Decision 2. Three economically-distinct US equity benchmarks
spanning the business-cycle exposure surface:

| Benchmark | CH token_address (verify in `scripts/phase_b_campaign_cycle_v1.ts`) | Rationale |
| --- | --- | --- |
| SPY | resolve at campaign-start via `select distinct token_address from quantlab.candles where symbol = 'SPY' and interval = '1d' limit 1` | Broad market; canonical US-cycle exposure |
| QQQ | same resolution | NASDAQ-100; tech-heavy; growth-cycle-sensitive |
| IWM | same resolution | Russell 2000 small-cap; most business-cycle-sensitive |

**Token-address resolution caveat:** the `quantlab.candles` table uses
`token_address` as the primary instrument key. Equity ETFs are ingested
under symbol-derived addresses (e.g., `SPY_USD` per `scripts/yfinance_backfill.py`
convention). The campaign script MUST resolve these at startup and FAIL
LOUDLY if any benchmark cannot be resolved — no silent benchmark drops.

### S-PBC1-3 — θ trial grid: {0.05, 0.10, ..., 0.95}, 19 trials

Step = 0.05 per ADR-051 §Decision 1. Reasoning:

- cycle_v1 score distribution over the 2008-present window covers roughly
  [0.05, 0.85] with mass concentrated in [0.30, 0.70] per the
  `docs/analysis/cycle-position-validation-2026-05.md` artifact. Step 0.05
  covers the full domain with 19 trials.
- Per ADR-051: smallest defensible N. 19 trials is well below the regime
  where DSR's expected-max-of-19-IID-normals (≈ 1.86σ at N=19, Euler-
  Mascheroni-Embrechts approx) noise floor dominates the signal.

### S-PBC1-4 — Time window + walk-forward split

Per ADR-051 §Decision 3:

- **Full window:** 2008-01-02 → today (matches `cycle_position_snapshots`
  earliest snapshot from s85 backfill).
- **IS:** 2008-01-02 → 2020-12-31 (~13 years, ~3270 trading days).
- **OOS:** 2021-01-01 → today (~5 years, ~1370 trading days as of campaign-
  run date).
- **Split point pinned in DDL fixture** for test reproducibility:
  `IS_END_DATE = "2020-12-31"`, `OOS_START_DATE = "2021-01-01"`.

### S-PBC1-5 — CSCV slice configuration

Per `cscv.ts:115-117` auto-downshift logic:
- T = ~3270 IS days → S=16 (above 1024 threshold) → C(16, 8) = 12,870 combos.
- For each (composite × benchmark) cell, compute 16 per-slice IS Sharpes;
  pass directly to `computeCSCVFromSliceSharpes` (skipping `computeCSCV`'s
  rederivation from raw returns).

### S-PBC1-6 — Four-gate validator invocation

Per ADR-051 §Decision 4, call `validator.ts` with this shape per benchmark:

```ts
const trialSharpes = trialsForBenchmark.map(t => t.is_sharpe);
const bestTrialIdx = argmax(trialSharpes);
const bestTrial = trialsForBenchmark[bestTrialIdx];

const validatorRequest: ValidatorRequest = {
  // Best-trial IS metrics for DSR + HLZ
  observedSharpe: bestTrial.is_sharpe,
  nObservations: bestTrial.is_days,            // ~3270
  trialSharpes,                                 // length 19

  // DSR path = parametric Mertens (NOT bootstrap). Rationale:
  // `bootstrapDSR()` in `src/lib/psr.ts:185-186` requires that
  // `observedSharpe ≈ median(perTokenSharpes)` (cross-sectional aggregation
  // of per-asset Sharpes). Here `observedSharpe = bestTrial.is_sharpe` is
  // the ARGMAX of trialSharpes, not the median — feeding `trialSharpes` as
  // `perAssetSharpes` would resample the trial axis (which IS the selection-
  // bias axis) and produce a meaningless SE. For "composite-as-signal"
  // Phase B campaigns there is no cross-sectional asset panel; parametric
  // Mertens (PSR Eq.3, Bailey-LdP 2014 §3; AFML §11.4) is the correct path.
  // perAssetSharpes intentionally omitted → validator runs parametric DSR.

  // Per-slice IS Sharpes for PBO via CSCV
  sliceSharpesByConfig: trialsForBenchmark.map(t => JSON.parse(t.is_slice_sharpes)),

  // Sparse-filter trade counts
  tradeCounts: trialsForBenchmark.map(t => t.is_trades),
  minTrades: 10,                                // ADR-051 default

  // OOS-IS Pardo: OOS Sharpe / IS Sharpe ratio gate
  oosSharpe: bestTrial.oos_sharpe,

  // Moments for Mertens variance correction (use IS moments)
  skewness: bestTrial.skewness_is,
  kurtosis: bestTrial.kurtosis_is,

  // HLZ context: M = 19 trials × 3 benchmarks = 57; rank computed by validator
  hlzNTests: 57,                                // composite-level M
  hlzRank: rankWithinAllCompositeBenchmarks,    // 1-indexed
  hlzMethod: 'bhy',                             // ADR-051 default
  hlzAlpha: 0.05,
  hlzTwoSided: false,                           // one-sided per ADR-051 §Decision 4
};

const result = runValidator(validatorRequest);
```

The rank `hlzRank` is computed across the union of all (benchmark × θ)
trials for the composite, sorted by IS t-stat descending. Each benchmark's
BEST trial has a distinct rank in [1, 57]; the haircut threshold is
rank-dependent per `hlzHaircut.ts:62-92`.

### S-PBC1-7 — Verdict aggregation across benchmarks

A composite passes Phase B iff there exists ≥1 benchmark where:

```
verdict[benchmark] == 'pass-all' AND pbo_value[benchmark] < 0.2
```

If multiple benchmarks satisfy this, the campaign reports the one with the
highest DSR as "primary Phase-C-eligible candidate." If none satisfy this,
the campaign falls through to PARTIAL or FAIL per ADR-051 §Decision 5.

---

## 3. Strategy harness — exact signature

```ts
// scripts/phase_b_campaign_cycle_v1.ts

/** Daily cycle-position score, indexed by snapshot_date. Pulled from
 *  `quantlab.cycle_position_snapshots`. Nulls forward-filled where the
 *  snapshot is missing (e.g., FRED publishing gaps). */
interface ScoreSeries {
  dates: Date[];          // ascending, daily, trading-day-aligned
  scores: number[];       // same length; values in [0, 1]
}

/** Daily benchmark close-to-close returns. Pulled from `quantlab.candles`
 *  for the resolved (SPY|QQQ|IWM) token_address. */
interface BenchmarkSeries {
  symbol: string;         // 'SPY', 'QQQ', 'IWM'
  dates: Date[];
  returns: number[];      // log-returns; same length as dates
}

/** One trial backtest. Pure function — no I/O, no global state. */
export function backtestTrial(
  score: ScoreSeries,
  benchmark: BenchmarkSeries,
  theta: number,
  isEndDate: Date,
): {
  is_sharpe: number;
  oos_sharpe: number;
  is_trades: number;
  oos_trades: number;
  is_days_in_market: number;
  oos_days_in_market: number;
  is_net_return_pct: number;
  oos_net_return_pct: number;
  skewness_is: number;
  kurtosis_is: number;
  is_slice_sharpes: number[];      // length effectiveS (16 for T~3270)
}
```

The harness:
1. Aligns `score.dates` to `benchmark.dates` by intersection
   (forward-fill score within trading week if benchmark trades on a day
   the score is missing; if score is missing for ≥5 consecutive trading
   days, raise — FRED publishing gaps of that length are anomalous).
2. Lags score by one day (`score(t-1)` decides `position(t)`).
3. Computes daily strategy return: `r_strategy(t) = position(t) × r_benchmark(t)`
   where `position(t) ∈ {0, 1}`.
4. Counts a "trade" each time `position(t) ≠ position(t-1)`.
5. Splits returns at `isEndDate`; computes Sharpe + skewness + kurtosis
   on each window (no annualization — Sharpe is daily; constant scalar
   cancels in all DSR/HLZ comparisons).
6. Slices the IS window into `effectiveS=16` equal-length slices;
   computes per-slice Sharpes via the same `sliceSharpe` helper convention
   as `cscv.ts:268-282`.

---

## 4. Persistence — exact CH queries

Per ADR-051 §Decision 6 schemas. Insert pattern for `phase_b_trials`:

```sql
INSERT INTO quantlab.phase_b_trials (
  composite_version, benchmark, theta, trial_idx,
  is_start_date, is_end_date, oos_start_date, oos_end_date,
  is_sharpe, oos_sharpe, is_trades, oos_trades,
  is_days_in_market, oos_days_in_market,
  is_net_return_pct, oos_net_return_pct,
  skewness_is, kurtosis_is,
  is_slice_sharpes, computed_at
) VALUES (
  'cycle_v1', :benchmark, :theta, :trial_idx,
  '2008-01-02', '2020-12-31', '2021-01-01', :today,
  :is_sharpe, :oos_sharpe, :is_trades, :oos_trades,
  :is_days_in_market, :oos_days_in_market,
  :is_net_return_pct, :oos_net_return_pct,
  :skewness_is, :kurtosis_is,
  :is_slice_sharpes_json, now64(3)
)
```

Insert pattern for `phase_b_verdicts`:

```sql
INSERT INTO quantlab.phase_b_verdicts (
  composite_version, benchmark, best_trial_theta,
  best_is_sharpe, best_oos_sharpe,
  dsr_value, dsr_pass,
  pbo_value, pbo_pass,
  hlz_t_stat, hlz_threshold, hlz_pass,
  oos_is_ratio, oos_is_pass,
  verdict, phase_c_eligible, campaign_run_at, notes
) VALUES (
  'cycle_v1', :benchmark, :best_theta,
  :best_is_sharpe, :best_oos_sharpe,
  :dsr_value, :dsr_pass,
  :pbo_value, :pbo_pass,
  :hlz_t_stat, :hlz_threshold, :hlz_pass,
  :oos_is_ratio, :oos_is_pass,
  :verdict, :phase_c_eligible, now64(3), :notes
)
```

---

## 5. Test plan (Phase B Composite-worker deliverable)

- [ ] `migrate_create_phase_b_trials.test.ts` (~12 tests): DDL byte-pin,
      pre/post-check paths, EXPLAIN PLAN grammar.
- [ ] `migrate_create_phase_b_verdicts.test.ts` (~12 tests): same shape.
- [ ] `phaseBCampaignCycleV1.test.ts` (≥30 tests):
  - Backtest correctness: golden-vector test on a known score series +
    benchmark — flat-when-score-below-θ; long-when-above; trade-count
    matches transitions; Sharpe matches hand-computed reference.
  - Score-benchmark alignment: score on Monday, benchmark trades Tuesday;
    position(Tuesday) = score(Monday) > θ.
  - Missing-score handling: gap of 4 trading days → forward-fill (passes);
    gap of 6 trading days → raises.
  - Walk-forward split: IS_END_DATE = 2020-12-31 cleanly divides; first
    OOS day = 2021-01-04 (first trading day of 2021).
  - CSCV slice configuration: T=3270 → effectiveS=16 (above 1024
    threshold per cscv.ts:115).
  - ValidatorRequest packaging: trial-set → request shape matches
    `validator_request.ts` schema byte-for-byte.
  - Verdict-aggregation rule: 3 benchmarks; 1 PASS-ALL with PBO=0.18;
    1 PARTIAL; 1 FAIL → composite verdict = PASS-ALL on the
    PBO<0.2 benchmark.
- [ ] `phaseBVerdictRepository.test.ts` (~8 tests): write + read roundtrip;
      latest-verdict-per-composite query.
- [ ] Existing test suite stays at 3319/3338 pass + 19 skip + 0 fail.

Target post-Cycle-23: ~3319 + ~62 = ~3381 tests.

---

## 6. Verification gates (Composite worker integration gate)

```text
npx tsc --noEmit                                                        # ≤ 13 baseline
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts     # ≥30/30 pass
node --import tsx --test scripts/tests/migrate_create_phase_b_*.test.ts  # ≥24/24 pass
node --import tsx --test scripts/tests/phaseBVerdictRepository.test.ts   # ≥8/8 pass
node --import tsx --test                                                 # full suite: ≥3381 pass + 19 skip + 0 fail
npm run health:check:strict                                              # exit 0
# End-to-end campaign run (orchestrator-executed after worker integration):
npx tsx scripts/phase_b_campaign_cycle_v1.ts --apply
# Then read verdicts:
clickhouse-client --query "SELECT * FROM quantlab.phase_b_verdicts WHERE composite_version='cycle_v1' ORDER BY benchmark"
```

---

## 7. Files / code state at Cycle 22 close (this SPEC's commit)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` | new | Pattern lock-in for all 9 Layer-0 composites |
| `docs/specs/phase-b-cycle-v1.md` | new | This SPEC — cycle_v1 instance of the pattern |

No code changes this cycle. Composite-worker execution is Cycle 23.

---

## 8. Watch-outs

- **Benchmark token-address resolution is fragile.** The
  `quantlab.candles` table's `token_address` convention for equity ETFs
  is `<SYMBOL>_USD` per the yfinance ingest, BUT this is not pinned in
  schema and may differ across past ingests. The campaign script MUST
  resolve at start and FAIL LOUDLY (not silently drop a benchmark) if
  resolution mismatches. The worker adds a convention-pin test
  (`scripts/tests/phaseBCampaignCycleV1.test.ts → test_benchmark_token_address_convention`)
  comparing the live CH state to the documented convention; future drift
  surfaces in the convention-pin test, not in a quietly-skipped benchmark.
- **Slice-Sharpe JSON encoding adds a parse step.** Storing per-slice
  Sharpes as a JSON-encoded string in CH (rather than as `Array(Float32)`)
  is a deliberate simplification — `Array(Float32)` columns add
  serialization complexity to the existing ch_client wrapper. The parse
  step on read is O(16 floats per row); negligible. Documented here so
  the Composite worker doesn't try to "improve" it to a typed Array column.
- **Skewness/kurtosis on long-only equity returns are moderate.** The
  long-only daily-rebalance on SPY/QQQ/IWM has skewness ≈ -0.5 and
  kurtosis ≈ 6-12 over multi-year windows. This is within the regime
  where the Mertens variance correction in `psr.ts:110-115` is well-
  conditioned; the bootstrap DSR path is also reliable. NEITHER PSR path
  gives a numerically degenerate result on this regime. This is the
  primary reason the long-only-on-equity template was chosen over an
  on-crypto variant where γ₄ in the 20-50 range would push Mertens
  toward its accuracy limit.
- **The 2008-2020 IS window contains two large drawdowns (GFC + COVID).**
  Cycle_v1's score went very low during both; if the long-only strategy
  was flat through both, the IS Sharpe will be flattered relative to
  buy-and-hold. The validator gates DO NOT compare to buy-and-hold —
  they compare to a noise floor + a selection-bias correction + an OOS
  collapse — so this isn't a methodology bug. But the verdict markdown
  report MUST mention the IS-window drawdown coverage as context.
- **OOS window (2021-2026) is regime-mixed.** 2021 = recovery; 2022 =
  bear; 2023-2024 = AI-led rally; 2025-2026 = consolidation + the
  expansion phase per `phase1_v3` regime history. A signal that "works"
  only in regime X would fail OOS even if cycle_v1's IS Sharpe was real.
  This is a feature, not a bug — OOS-IS Pardo gate is designed to catch
  exactly this.

---

## 9. Open questions — none

The SPEC is closed for Composite-worker execution. Per orchestration §1
"trivial-edit exception" + §3.1 worker spawn criteria, the Cycle 23
Composite worker takes this SPEC + the ADR-051 pattern doc as its
constraint envelope and ships against them. The worker MUST NOT relax
any threshold or deviate from any decision in §2-§6 without escalating
per orchestration §7.1.5.

---

## 10. Cross-references

- Parent ADR: `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
- Composite implementation: `src/server/cycle_position.ts` (the
  `cycle_v1` composite this campaign validates)
- Validator orchestrator: `src/lib/validator.ts`
- DSR/PBO/HLZ library: `src/lib/psr.ts`, `src/lib/cscv.ts`,
  `src/lib/hlzHaircut.ts`
- Original cycle_v1 NBER-backtest Phase B (different methodology;
  closed `informational permanently` per S-MCP-Q5):
  `docs/analysis/cycle-position-validation-2026-05.md` +
  `docs/specs/market-cycle-position.md` §11
- Snapshot data source: `quantlab.cycle_position_snapshots`
  (~6700 rows, 2008-01-02 → today)
- Benchmark data source: `quantlab.candles` (SPY/QQQ/IWM at `1d`
  interval, ≥18.4-year depth)
