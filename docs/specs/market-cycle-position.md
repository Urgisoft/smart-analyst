# SPEC — Market Cycle Position (Layer 0 informational input)

> **Status:** SPEC complete; pending operator review before CODE start. **Author:** Claude (Vector Core). **Authority:** Session 84 operator pivot — "no live trading hook up yet. please move to gaps integration"; operator selected market-cycle-position as first gap. **Parent gap doc:** [docs/obsidian/gaps/market-cycle-position.md](../obsidian/gaps/market-cycle-position.md).

This SPEC operationalises the market-cycle-position gap as an **informational Layer-0 input** (Option A in the gap doc). Cycle-position context is computed daily, logged to ClickHouse, and surfaced in the morning brief + on a dashboard panel — but does NOT fire a kill-switch category in the existing `phase1_v3` classifier in v1. Promotion to direct classifier input (Option B) is deferred pending 90+ days of live observation per gap-doc Phase B.

---

## 1. Scope clarification — what this SPEC builds vs. what it doesn't

**Builds:**

- Extension of the existing FRED ingest pipeline to cover the additional series this composite needs.
- A pure-function composite that maps a snapshot of the inputs to a `CyclePositionSnapshot` (continuous score + discrete phase label + recession probability).
- A daemon hook that computes + persists the snapshot once per cycle into a new `quantlab.cycle_position_snapshots` table.
- A morning-brief panel rendering the latest snapshot with 30/90/365-day historical context.

**Does NOT build:**

- Direct integration into `phase1_v3` classifier as a counted category (Option B; deferred).
- Sector-allocation routing (gap doc §3 "sector allocation guidance"). Documentation-only deliverable; not implemented in code.
- Backtest validation against NBER (gap doc Phase C). Requires ALFRED vintage data; deferred.
- ISM Manufacturing PMI ingestion (licensed; operator decision needed before any path here).
- International cycle signals (Eurozone PMI, China PMI) — gap doc leaves open; deferred for v1.

---

## 2. Decisions baked into this SPEC

### Resolved by canon (no operator decision needed)

**S-MCP-1. Primary recession-spread signal = 10Y–3M (T10Y3M).** Estrella & Mishkin 1998 RES; Estrella & Trubin 2006 NY Fed Current Issues §3. The 3-month-end is more sensitive to Fed policy expectations; financial press uses 10Y-2Y for cultural-recognition reasons, not because it predicts better. Log T10Y2Y alongside for cross-checking, but the composite weighting privileges T10Y3M.

**S-MCP-2. Option A (informational) over Option B (direct classifier input).** Vector Core "fewer features, robustly." Promoting to direct classifier input on a paper-shakedown system is feature-additive without validation. Phase B's 90+ day observation window is the gate; promotion (if ever) lands as its own SPEC.

**S-MCP-3. NBER recession dates are for offline backtest only, not live signal.** NBER's 6-18 month dating lag means a live system using NBER state would be reading the wrong information. Live signal uses observable inputs only; NBER comparison happens in offline validation (deferred per §1).

### Operator decisions (LOCKED s85)

**S-MCP-Q1. ISM PMI handling — LOCKED: (a) skip in v1.** Composite ships with 7-8 inputs across yield-curve + credit + employment buckets. Manufacturing input is a candidate addition in a future cycle_v2 (regional Fed PMIs are free on FRED; ISM headline costs ~$500/year if operator subscribes later).

**S-MCP-Q2. Output shape — LOCKED: (c) both score + discrete phase label.** Compute and persist the score, derive the label via SPEC-pinned bands (see §6 `labelFromScore`). Same underlying composite; pinning bands makes the label deterministic and reviewable.

**S-MCP-Q3. Dashboard panel timing — LOCKED: bundle into Phase A.** Operator-facing output is the whole point. Without a view, Phase A is invisible.

**S-MCP-Q4. Validation approach — LOCKED s85 (operator PUSHBACK on initial SPEC): quantitative backtest, not calendar observation.** The original SPEC's "90-day live observation window" was over-conservative reasoning — it substituted "let it bake live" for proper backtest validation, which I had deferred due to ALFRED vintage-data concerns. Operator correctly challenged: we have historical FRED data, we have NBER recession dates, we can backtest immediately. **Revised phasing collapses calendar wait into ~1 week of validation code.** ALFRED rigor remains a known caveat (employment series have mild look-ahead bias under current-vintage); yield-curve bucket is vintage-clean.

---

## 3. Component diagram

```text
┌────────────────────────────────────────────────────────────────────────┐
│  FRED INGEST (existing — scripts/fred_ingest.py)                       │
│  Today: T10Y2Y                                                          │
│  Phase A adds: T10Y3M, DGS10, DGS3MO, BAA10Y, BAMLH0A0HYM2,            │
│                UNRATE, ICSA                                             │
│  Skipped: NAPM/ISM (S-MCP-Q1)                                          │
│  Storage: existing quantlab.fred_macro_indicators table                │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓ (read latest values + history)
┌────────────────────────────────────────────────────────────────────────┐
│  CYCLE-POSITION COMPOSITE (NEW — src/server/cycle_position.ts)         │
│  Pure function: snapshot of inputs → CyclePositionSnapshot             │
│  Inputs: latest values + multi-month trends per the gap doc §2         │
│  Outputs: score (0-1) + phaseLabel (early|mid|late|contraction)        │
│           + recessionProb (0-100%, from NY Fed series or recalibrated) │
│           + per-input contribution attribution                          │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌────────────────────────────────────────────────────────────────────────┐
│  PERSISTENCE (NEW — quantlab.cycle_position_snapshots table)           │
│  One row per daemon cycle. ReplacingMergeTree on (snapshot_date) so    │
│  re-runs collapse cleanly.                                              │
└────────────────────────────────────────────────────────────────────────┘
                                  ↓ (parallel, both consume the same row)
        ┌──────────────────────────┴──────────────────────────┐
        ↓                                                      ↓
┌──────────────────────────┐                  ┌──────────────────────────┐
│  MORNING BRIEF PANEL     │                  │  DASHBOARD PANEL         │
│  (NEW — operator_brief.  │                  │  (NEW — UI route +       │
│  ts extension)           │                  │  React component)        │
│  Shows: today's score +  │                  │  Shows: 365-day score    │
│  phase + recession-prob; │                  │  trend; per-input        │
│  30/90/365-d sparkline   │                  │  contribution stack;     │
│  context; flags large    │                  │  NBER recession bands    │
│  day-over-day moves      │                  │  overlaid (offline data) │
└──────────────────────────┘                  └──────────────────────────┘
```

---

## 4. Phased plan

### Phase A — Data + Composite + Persistence + Morning Brief (~1 week)

A1. **FRED ingest expansion.** Extend `scripts/fred_ingest.py` default series list. Optionally add a named series-set constant for "cycle-position v1" so the operator can run a single command to backfill the new series.

A2. **`src/server/cycle_position.ts` pure function** — input snapshot → `CyclePositionSnapshot`. Pure, deterministic, fully testable without CH.

A3. **CH schema migration** — new `quantlab.cycle_position_snapshots` table via the s84 simple-migration pattern (dry-run + apply, no CREATE-NEW ceremony needed since this is a new table not an alter).

A4. **Daemon hook** — once per cycle, call composite + persist. Wired into `scripts/daily_signal_daemon.ts` AFTER the macro-regime classify step (composite reads the FRED values that the regime step just refreshed).

A5. **Morning-brief panel** — extend `src/server/operator_brief.ts` with a `<Cycle Position>` section. Shows today's score + phase + recession-prob + 30/90/365-day sparkline.

A6. **Tests** — composite unit tests (≥30), migration tests (≥10), morning-brief render tests (≥4).

Phase A makes cycle-position observable to the operator. No classifier impact.

### Phase B — Quantitative validation (~1 week, immediately after Phase A ships)

Operator s85 PUSHBACK (S-MCP-Q4): substitute calendar observation with a real backtest. Yields faster, more rigorous validation. Phases below replace the original SPEC's "90-day observation + deferred backtest" with one integrated validation phase.

B1. **NBER backfill ingest.** New script `scripts/nber_recession_dates_ingest.py` (or `.ts` if simpler) — NBER publishes recession start/end dates as a small fixed list maintained at nber.org/research/data/us-business-cycle-expansions-and-contractions. Manual data entry (~12 recession pairs since 1970) is acceptable given the dataset is ~24 rows. Stored in a new `quantlab.nber_recessions` table.

B2. **Historical cycle-position computation.** Run the Phase A composite over the historical FRED dataset for 2008-present (matches `phase1_v3` history window from s79 backfill). Writes back-dated rows to `quantlab.cycle_position_snapshots`. Idempotent via ReplacingMergeTree.

B3. **NBER backtest validation.** For each NBER recession, compute the cycle-position score on the date 6 / 12 / 18 months BEFORE the recession's NBER-dated start. Estrella-Mishkin's canonical claim: a healthy signal shows the score dropping (or yield-curve component dropping) by these lead horizons. Output: a verdict table per recession + an aggregate hit/miss rate. False-positive count: dates where score went below threshold but no recession followed within 18 months.

B4. **Independence test against `phase1_v3`.** Pearson + Spearman correlation between daily cycle-position score and `phase1_v3` `categories_firing_today` over 2008-present. SPEC-pinned threshold: if |ρ| > 0.7, the two are redundant and Phase C promotion is blocked even if the signal "feels" useful. Surfaces redundancy quantitatively.

B5. **Validation report.** Single markdown artifact at `docs/analysis/cycle-position-validation-2026-05.md` (or similar dated slug) — captures the verdict table, independence-test results, and a recommendation on whether to proceed to Phase C.

**Vintage-data caveat:** Phase B uses current-vintage FRED data, not ALFRED archival vintages. Series with material revision history (UNRATE, ICSA) have mild look-ahead bias in the backtest. Yield-curve series (T10Y3M, T10Y2Y, DGS10, DGS3MO) and Treasury rates are essentially revision-free, so the curve bucket of the composite is vintage-clean. The caveat is documentable; an ALFRED upgrade can be a follow-on iteration if Phase B results are marginal and rigor matters.

### Phase C — Option B promotion (gates on Phase B verdict)

IF Phase B validates (acceptable hit rate on NBER backtest AND |ρ| < 0.7 against `phase1_v3`):

C1. Promote cycle-position to a direct `phase1_v3+` category (`late_cycle_warning` firing when score < 0.25 for N consecutive days). Requires its own SPEC.

C2. Document in ADR.

IF Phase B fails on either criterion: cycle-position stays informational (Option A) permanently. The output still has value as Layer 5 LLM context and operator-brief signal, just not as a kill-switch input.

---

## 5. Schema — `quantlab.cycle_position_snapshots`

```sql
CREATE TABLE IF NOT EXISTS quantlab.cycle_position_snapshots
(
  snapshot_date      Date,
  computed_at        DateTime64(3),
  score              Float32,                          -- 0..1; 0 = late-cycle / contraction
  phase_label        LowCardinality(String),           -- 'early' | 'mid' | 'late' | 'contraction' | 'unknown'
  recession_prob_pct Float32,                          -- 0..100; NY Fed series passed through (Phase A) or recalibrated (Phase D)
  inputs_present     UInt8,                            -- bitmask: which inputs were non-null this snapshot
  -- Per-input raw values (denormalised; null when source series missing for the date)
  t10y3m             Nullable(Float32),
  t10y2y             Nullable(Float32),
  baa10y             Nullable(Float32),
  hy_oas             Nullable(Float32),
  unrate             Nullable(Float32),
  unrate_12m_chg     Nullable(Float32),
  claims_4w_ma_zscore Nullable(Float32),
  -- Per-input contributions to score (denormalised; sums to 1.0 across non-null inputs)
  contrib_yield_curve   Nullable(Float32),
  contrib_credit        Nullable(Float32),
  contrib_employment    Nullable(Float32),
  composite_version  LowCardinality(String),           -- e.g. 'cycle_v1' — bumps on weighting/formula changes
  classifier_version LowCardinality(String)            -- mirror of phase1_v3 version at snapshot time for alignment
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192
```

**Migration pattern**: simple `CREATE TABLE IF NOT EXISTS` — no migration ceremony needed (new table; nothing to back up). `scripts/migrate_create_cycle_position_snapshots.ts` follows the same dry-run + apply pattern as s84.

---

## 6. Function signatures

```ts
// src/server/cycle_position.ts

/** All input series for one snapshot date. Null = series missing / not yet released. */
export interface CyclePositionInputs {
  asOf: Date;
  t10y3m: number | null;
  t10y2y: number | null;           // logged for cross-check; not weighted into score
  baa10y: number | null;
  hyOas: number | null;
  unrate: number | null;
  unrate12mChange: number | null;
  claims4wMaZscore: number | null;
  nyFedRecessionProb: number | null;  // null = pass-through unavailable; composite still works
}

export type CyclePhaseLabel = 'early' | 'mid' | 'late' | 'contraction' | 'unknown';

export interface CyclePositionSnapshot {
  asOf: Date;
  score: number;                    // 0..1; 0 = late-cycle/contraction
  phaseLabel: CyclePhaseLabel;
  recessionProbPct: number;         // 0..100
  /** Per-bucket contributions to the score. Sum to 1.0 across non-null inputs. */
  contributions: {
    yieldCurve: number | null;
    credit: number | null;
    employment: number | null;
  };
  /** Bitmask of inputs that were non-null in this snapshot. */
  inputsPresent: number;
  /** Composite version — bumps on weighting/formula changes. */
  compositeVersion: 'cycle_v1';
}

/**
 * Pure-function composite. Maps an input snapshot to a cycle-position
 * snapshot. Deterministic; no I/O.
 *
 * Score semantics:
 *   0.00 — deeply late-cycle / actively contracting; recession near/here
 *   0.25 — late-cycle warning; multiple inputs softening
 *   0.50 — mid-cycle; no clear directional signal
 *   0.75 — mid-to-early; expansion has room
 *   1.00 — early-cycle / recovery; broad easing of recession risk
 *
 * Missing inputs degrade the score's confidence (logged via inputsPresent
 * bitmask) but the composite still produces a value as long as the
 * yield-curve bucket has T10Y3M.
 */
export function computeCyclePosition(inputs: CyclePositionInputs): CyclePositionSnapshot;

/**
 * Discrete phase-label classifier. Fixed bands on `score`:
 *   score < 0.20 → 'contraction'
 *   score in [0.20, 0.40) → 'late'
 *   score in [0.40, 0.65) → 'mid'
 *   score >= 0.65 → 'early'
 *   inputsPresent zero/missing yield curve → 'unknown'
 *
 * Bands are SPEC-pinned to make label transitions deterministic and
 * reviewable. Re-tuning bands is a composite-version bump.
 */
export function labelFromScore(score: number, inputsPresent: number): CyclePhaseLabel;
```

---

## 7. Composite weighting (cycle_v1)

Three buckets, each contributing equally when all inputs present. Within each bucket, equal weight on its inputs. Missing inputs re-normalize within the bucket.

| Bucket | Weight | Inputs | Mapping to [0,1] |
|---|---|---|---|
| **Yield curve** | 1/3 | T10Y3M (NY Fed prob passes through), 2Y-5Y segment | Higher spread → higher score. T10Y3M < 0 maps to score 0; T10Y3M > +2.5% maps to 1; linear in between. |
| **Credit** | 1/3 | BAA10Y, HY OAS | Tighter spread → higher score. BAA10Y < 1.5% → 1; > 4% → 0; linear. HY OAS < 3% → 1; > 8% → 0; linear. Average. |
| **Employment** | 1/3 | UNRATE 12m change, ICSA 4w MA z-score | Falling unemployment + low claims z-score → higher score. UNRATE Δ12m < -0.3 → 1; > +0.5 → 0. Claims z < -0.5 → 1; z > +2.0 → 0. Average. |

**Why three buckets, not nine inputs equally weighted:** information overlap. The two curve inputs are tightly correlated; the two credit inputs are tightly correlated; the two employment inputs are tightly correlated. Equal-weight bucketing approximates principal-component weighting without doing PCA. SPEC §6 admits this is a heuristic; the alternative (PCA on the inputs over a rolling window) is a Phase B refinement after we have 90+ days of observation to fit it on.

**Why no PMI in cycle_v1**: S-MCP-Q1 deferred. If operator picks (b) regional Fed PMIs, the manufacturing bucket is a 4th weighted slot in cycle_v2.

---

## 8. Test plan (Phase A)

- [ ] `cycle_position.test.ts` (≥30 tests):
  - All-inputs-present green path: known input → known score (golden-vector tests at canonical historical dates: 2008 GFC peak, 2020 COVID trough, 2017 mid-expansion, 2019 yield-curve inversion).
  - Per-bucket isolation: zero out two buckets, verify the third drives the score correctly.
  - Missing-input degradation: each input separately nulled, verify graceful degrade + inputsPresent bitmask correct.
  - Yield-curve-only fallback: only T10Y3M present → still produces a score (with reduced confidence flagged).
  - Phase label band transitions: golden vectors at 0.19/0.20/0.39/0.40/0.64/0.65 boundaries.
  - Score monotonicity: increasing T10Y3M with all else fixed monotonically raises score.
  - Composite version pin: SPEC pins `'cycle_v1'`; test asserts on the string.
- [ ] `migrate_create_cycle_position_snapshots.test.ts` (≥10 tests):
  - DDL byte-pin.
  - Pre-check ok / table-already-exists / pending-mutations paths.
  - Post-check column/type verification.
  - EXPLAIN PLAN grammar check (s83 pattern) on the pre/post-check queries.
- [ ] `cyclePositionRepository.test.ts` (~10 tests): write + read round-trip; latest snapshot retrieval; query shape via byte-pin + EXPLAIN PLAN.
- [ ] `operatorBriefCyclePosition.test.ts` (~4 tests): brief renders the section; handles missing snapshot (pre-Phase-A days) gracefully; sparkline shape; large-day-over-day-move flag.
- [ ] Existing 1392 tests must continue to pass.

Phase A test target: 1392 + ~55 = ~1447 tests.

---

## 9. Watch-outs (carried + new)

Carried from gap doc:
- **NBER lag** — recession dates land 6-18 months late. Live signal must use observable data only. Backtest comparison (deferred) is the only legitimate use of NBER state.
- **10Y-3M false positives** — 1966 inverted, no recession. The signal is "elevated risk," not "guaranteed recession." Score 0 ≠ "recession is here."
- **Curve inversions can resolve without recession** — 1966 and 1998 both un-inverted. Steepening from inversion is itself a signal worth surfacing separately in Phase B dashboard.
- **Real-time vintage** — many FRED series get revised. Phase A pulls current values (correct for live forward use). Phase C (deferred) requires ALFRED vintage data.

New from this SPEC:
- **The three-bucket weighting is a heuristic.** Equal-weight bucketing approximates PCA but isn't PCA. A 90+ day Phase B observation window is enough data to fit a rolling-PCA weighting; the cycle_v2 refinement is a candidate after Phase B.
- **NY Fed recession-prob series may be unavailable on some dates.** It's published monthly with a lag; days where it's missing trigger pass-through-null. Composite is unaffected (recessionProbPct just goes null too).
- **`inputsPresent` bitmask is load-bearing for operator interpretation.** A score of 0.4 with all 6 inputs present means something very different from a score of 0.4 with only the yield-curve bucket non-null. The morning brief must render the bitmask, not just the score.
- **Composite-version pinning matters for backtest.** Any change to weights / bands / formula MUST bump `cycle_v1` → `cycle_v2`. Stored snapshots remain queryable by their version. Same pattern as `phase1_v2` → `phase1_v3`.

---

## 10. What could break this

- **FRED API limits** — pandas-datareader / FRED API is rate-limited. Adding 7 new series per backfill request multiplies the request count. Spread backfill over multiple runs if needed; the existing ingest script is idempotent.
- **ICSA week alignment** — initial claims is weekly (Thursday release for prior-week data). The 4-week MA z-score needs alignment with daily snapshot dates. Use the most-recent-as-of weekly value with forward-fill within the week.
- **NY Fed recession-prob lookup** — series isn't on FRED directly; it's on the NY Fed site. May need scraping or an alternative source. Investigate before Phase A starts; if unavailable, derive a local logit on T10Y3M (Estrella-Mishkin §3 specifies the parameters).
- **Phase B observation window** — 90+ days is calendar time, not negotiable. If we ship Phase A and the operator wants to skip to Phase B/D promotion early, push back. The 90 days are the validation; shortening them defeats the purpose.

---

## 11. Open questions — all LOCKED (s85 close)

1. ~~**S-MCP-Q1 (ISM PMI)**~~ — LOCKED s85: skip in v1.
2. ~~**S-MCP-Q2 (output shape)**~~ — LOCKED s85: both score + discrete phase label.
3. ~~**S-MCP-Q3 (dashboard panel timing)**~~ — LOCKED s85: bundle into Phase A.
4. ~~**S-MCP-Q4 (validation approach)**~~ — LOCKED s85 via operator PUSHBACK: quantitative backtest against NBER (Phase B), not 90-day live observation.

No open questions remain. Phase A is unblocked.

---

## 12. Sequencing summary

| Phase | What | Duration | Blocks on |
|---|---|---|---|
| **A** | FRED ingest expansion + composite + persistence + brief panel + dashboard panel | ~1 week | Nothing — §11 LOCKED |
| **B** | NBER backfill + historical composite + backtest validation + independence test + report | ~1 week | Phase A complete |
| **C** | Option B promotion to direct classifier input (own SPEC) | Open | Phase B validates AND operator green-lights |

**Net arc: ~2 weeks** (was 2-3 months in the original SPEC; collapsed by replacing calendar observation with backtest validation per S-MCP-Q4). Phase A and Phase B are both autonomous-safe; Phase C is operator-gated by Phase B verdict.
