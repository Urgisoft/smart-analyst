---
status: spec-complete
phase: phase-b
last_updated: 2026-05-24
session: 96 #20 Cycle 24
owner: Orchestrator (Vector Core); Composite worker executes Cycle 24
type: spec
slice_id: adr-051-instance-vol_struct_v1
parent_adr: docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md
predecessor_spec: docs/specs/phase-b-cycle-v1.md
---

# SPEC — Phase B deflation-pipeline campaign for `vol_struct_v1`

> **Second instance of the ADR-051 pattern.** Inherits all Cycle 23
> infrastructure (`phase_b_trials` + `phase_b_verdicts` tables, the
> `validator.ts` four-gate stack, the `phase_b_repository.ts` typed
> helpers, the `psr.ts`/`cscv.ts`/`hlzHaircut.ts` libraries). This SPEC
> pins ONLY the per-composite overlay: score selection, score-rescaling,
> benchmark universe, time window, file paths. Read
> [ADR-051](adr-051-layer0-phase-b-deflation-pipeline.md) and the
> predecessor [phase-b-cycle-v1.md](phase-b-cycle-v1.md) first; this
> SPEC is the delta.

---

## 1. Scope

**Builds** (Composite worker, Cycle 24):

1. `scripts/_probe_phase_b_vol_struct_v1_inputs.ts` — Step 0 pre-flight
   probe (mirrors cycle_v1's probe shape; checks `vol_structure_snapshots`
   row count + earliest date + curveSteepnessZ coverage).
2. **IF Step 0 probe finds the snapshots table empty or sparse:**
   `scripts/_backfill_vol_structure_snapshots.ts` — one-shot backfill
   computing daily `VolStructureSnapshot` for every trading day in the
   campaign window via the existing
   `VolStructureRepository.readInputsForCycle` + `computeVolStructure`
   path. Persists ~3,250 rows (2013-01-03 → today). Tier-1 auto-fix per
   ADR-044 + S96-117 precedent (missing-ingest-never-fired carve-out).
3. `scripts/phase_b_campaign_vol_struct_v1.ts` — campaign harness; ~70%
   shared infrastructure with `phase_b_campaign_cycle_v1.ts`, deltas
   confined to `loadScoreSeries()` (curveSteepnessZ → Φ-rescaled) and
   benchmark/window constants. Wires into `validator.ts` four-gate
   stack per benchmark; persists trial + verdict rows.
4. Markdown report at
   `docs/analysis/phase-b-vol_struct_v1-deflation-2026-05.md` (post-run
   verdict + per-gate diagnostics).
5. Unit tests for the harness (≥40 tests covering golden-vector backtest,
   Φ-rescaling identity + monotonicity, score-benchmark alignment,
   walk-forward split, slice-Sharpe parity, ValidatorRequest packaging,
   verdict-aggregation rule, convention-pin tests on the live CH schema).

**Builds** (UI worker, Cycle 24 — split spawn):

6. `/#/phase-b` dashboard route + `PhaseBApp.tsx` component (ADR-051
   §Decision 7, NOW UNBLOCKED — cycle_v1 verdict rows exist; this
   campaign adds vol_struct_v1 rows).

**Builds** (Health worker, Cycle 24 — split spawn):

7. Morning brief §0c renderer addition to
   `src/server/operator_brief_render.ts` (ADR-051 §Decision 7).

**Does NOT build:**

- Phase C promotion path (operator-gated per orchestration §7.1 item 8).
- `vol_struct_v2` composite redesign in response to whatever this Phase B
  returns (anti-shopping rule per ADR-051 §Decision 5).
- A "long-only-on-inverse-benchmark" sister campaign (not warranted for
  vol_struct_v1 — the bidirectional claim is "low steepness Z → flat;
  high → long" which the standard long-only template tests).
- Cross-composite meta-HLZ pass (deferred per ADR-051 §Consequences).

---

## 2. vol_struct_v1-specific decisions

### S-PBV1-1 — Score selection: `curveSteepnessZ`, NOT `regimeFlag`

ADR-051 §Decision 1 originally listed `vol_struct_v1` in the
"[0,1] score, high=bullish" bucket. **That listing was nominal.** Per
[`src/server/vol_structure.ts`](../../src/server/vol_structure.ts) the
actual composite emits:

- `regimeFlag: 'severe_stress' | 'moderate_stress' | 'event_risk' | 'complacent' | 'normal' | 'unknown'` (6-way categorical)
- 5 indicators: `monotonicBackwardation` (bool), `curveSteepnessZ`
  (continuous z), `inversionDepth` (continuous ≥0), `vixZ` (continuous z),
  `vvixZ` (continuous z), `vvixVixDivergence` (bool).

NONE is a native [0,1] high=bullish score. This SPEC invokes the
ADR-051 §Decision 1 last-paragraph provision: "Composites with
non-[0,1]-score outputs OR non-'high=bullish' semantics apply the same
template with the inequality reversed and the score rescaled to [0,1]
first. The per-composite SPEC documents the rescaling."

**Selected score: `curveSteepnessZ`** (column
`curve_steepness_z` in `quantlab.vol_structure_snapshots`).

**Why curveSteepnessZ over alternatives:**

| Candidate | Why rejected |
| --- | --- |
| `regimeFlag` (categorical) | 6 buckets → θ-grid degenerates to ≤5 trials; below ADR-051's "smallest defensible N" implicit floor (cycle_v1 = 19). PBO computation on ≤5 trials is degenerate (CSCV requires effectiveS ≥ 4 splits with ≥1 trial in each rank position). |
| `monotonicBackwardation` (bool) | Single-trial binary signal; no θ sweep; deflation pipeline has nothing to deflate. |
| `vvixVixDivergence` (bool) | Same problem as monotonicBackwardation. |
| `inversionDepth` (continuous ≥0) | Sparse — exactly 0 on most non-backwardation days (~95% of history). Φ-rescaling concentrates mass at 0.5 (the rescaled 0-value); θ sweep collapses to a near-binary decision. |
| `vixZ` (continuous z) | A measure of vol level, not vol-curve SHAPE; less specific to the vol-structure thesis. Could be a separate `vix_z_v1` composite. |
| `vvixZ` (continuous z) | Vol-of-vol level; same critique as vixZ. |
| `curveSteepnessZ` (continuous z) | **SELECTED.** Highest information density; directly captures the vol-structure thesis ("inverted vol curve → equity stress"); naturally polarity-aligned with "high z = calm = long-favorable"; same indicator the regimeFlag's severe_stress threshold gates on. |

**Polarity check.** `curveSteepnessZ = (VIX6M - VIX9D) / VIX` rescaled
by trailing-2y z-score baseline (per
[`vol_structure_repository.ts:183-193`](../../src/server/vol_structure_repository.ts#L183-L193)).

- High z (positive, steep contango) = long-end vol > short-end vol = calm
  market → **long-favorable** ✓
- Low z (negative, backwardation) = short-end vol > long-end vol = stress
  → **flat-favorable** ✓

Polarity matches cycle_v1's "high score = bullish" convention. **No
inequality reversal needed.** The ADR-051 standard template applies:
`position(t) = LONG benchmark if score(t-1) > θ, else FLAT`.

### S-PBV1-2 — Score-rescaling: Φ (standard normal CDF)

`curveSteepnessZ ∈ R` (theoretically unbounded; empirically ~[-4, +4]).
Rescale to `score ∈ [0, 1]` via:

```
score(t) = Φ(curveSteepnessZ(t))
```

where Φ is the standard normal CDF, implemented via Abramowitz & Stegun
26.2.17 polynomial approximation (~1e-7 accuracy):

```ts
function normalCdf(z: number): number {
  // Abramowitz & Stegun 26.2.17; max error ~7.5e-8
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const erfApprox = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * erfApprox);
}
```

**Why Φ over alternatives:**

| Rescaling | Why rejected |
| --- | --- |
| Linear clip `clip((z+3)/6, 0, 1)` | Arbitrary [-3,+3] window; θ has no probability interpretation; equal-θ-spacing doesn't track distribution mass. |
| Sigmoid `1/(1+exp(-z))` | Heavier-tailed than Φ; for the same θ grid {0.05,…,0.95} sigmoid covers approx z ∈ [-2.94, +2.94] vs Φ ∈ [-1.64, +1.64]. Either works, but Φ has cleaner cross-paper canon (Bailey-LdP 2014 §3 uses Φ throughout). |
| Empirical CDF (ECDF) on IS history | Best non-parametric option BUT introduces leakage management complexity (must fit ECDF on IS-only, apply to OOS). For Phase B v1 we accept the Gaussian-baseline approximation; if vol z-scores prove materially non-Gaussian in practice, future `vol_struct_v2` may switch to fit-IS ECDF rescaling (watch-out §8). |

**θ interpretation under Φ rescaling.** A θ of 0.5 means "go long when
curveSteepnessZ > 0" (above median historical steepness). θ = 0.84 means
"go long when curveSteepnessZ > +1σ." θ = 0.16 means "go long when
curveSteepnessZ > −1σ." The standard cycle_v1 θ grid {0.05, 0.10, …,
0.95} probes the [−1.64σ, +1.64σ] range — wide enough to span the bulk
of the empirical distribution.

### S-PBV1-3 — Benchmark universe: SPY + QQQ + IWM

Same as cycle_v1 (ADR-051 §Decision 2). Justification for vol_struct_v1:
the composite's claim is "vol-curve shape predicts US equity stress
episodes" — directly testable on US equity benchmarks. SPY (broad), QQQ
(tech/growth — most vol-sensitive), IWM (small-cap — most cyclically
sensitive). Same three economically-distinct benchmarks; same M=57
HLZ trial budget.

Benchmark token addresses + the QQQ/IWM yfinance backfill already
landed in CH per Cycle 23 S96-117 (composite_version='cycle_v1'
campaign). No further benchmark prep needed.

### S-PBV1-4 — θ trial grid: {0.05, 0.10, …, 0.95}, 19 trials

Same as cycle_v1 (ADR-051 §Decision 1). Justification: identical
small-N defensibility argument; identical M=57 = 19 × 3 HLZ
denominator.

### S-PBV1-5 — Time window + walk-forward split

Constraint: `curveSteepnessZ` requires VIX9D data, which YF publishes
starting ~2011-01-03 (per
[`vol_structure_repository.ts:108-144`](../../src/server/vol_structure_repository.ts#L108-L144)
`computeSteepnessSeries` "pre-2011 VIX9D" note). Each snapshot's
z-score additionally requires ≥30 baseline observations (per
[`computeZ`](../../src/server/vol_structure_repository.ts#L294-L305)),
with the trailing 2y window meaning ~504 trading-day baseline at full
strength. First z-score with full-strength baseline:
~2013-01-03.

**Full window:** 2013-01-03 → today (~13 years, ~3,250 trading days).
**IS:** 2013-01-03 → 2022-12-31 (~10 years, ~2,520 trading days).
**OOS:** 2023-01-01 → today (~3 years, ~730 trading days).

The split is narrower than cycle_v1 (IS ~13y / OOS ~5y) but stays
above the ADR-051 §Decision 3 implicit threshold (IS T sufficient for
CSCV effectiveS=16 per `cscv.ts:115` — threshold is T > 1024; 2520 > 1024
holds comfortably).

**Pinned constants:**
- `WINDOW_START_DATE = "2013-01-03"` (first trading day with full-strength
  trailing-2y curveSteepnessZ baseline).
- `IS_END_DATE = "2022-12-31"`.
- `OOS_START_DATE = "2023-01-03"` (first trading day of 2023 in US).

The OOS window covers a regime-mixed period: 2023 = AI-led rally
post-2022 bear; 2024 = mixed; 2025-2026 = expansion + consolidation
per `phase1_v3` history. Per the s96 #20 Cycle 23 verdict pattern this
mixed OOS is exactly the regime where a real signal should survive
the OOS-IS Pardo gate.

### S-PBV1-6 — CSCV slice configuration

Per `cscv.ts:115-117` auto-downshift logic: T ≈ 2520 → effectiveS = 16
(above the 1024 threshold) → C(16, 8) = 12,870 combos. Same as cycle_v1.

### S-PBV1-7 — Four-gate validator invocation

**Identical to cycle_v1 SPEC §S-PBC1-6** (inherited verbatim including
the parametric Mertens DSR path per S96-116). The only delta is the
input scores being Φ-rescaled curveSteepnessZ rather than raw cycle_v1
score; the validator stack is composite-agnostic.

DSR path: **parametric Mertens, NOT bootstrap.** Same rationale as
cycle_v1 SPEC §S-PBC1-6:
- `observedSharpe = bestTrial.is_sharpe` (argmax over θ trials, not
  median over assets).
- No cross-sectional asset panel; bootstrap `perAssetSharpes` path is
  not applicable.
- `bootstrapDSR()` in `psr.ts:185-186` requires
  `observedSharpe ≈ median(perAssetSharpes)`; here it would resample
  the selection-bias axis and produce a meaningless SE.

HLZ M = 19 × 3 = 57, BHY one-sided at α=0.05. Same threshold as cycle_v1.

### S-PBV1-8 — Verdict aggregation across benchmarks

Inherited verbatim from cycle_v1 SPEC §S-PBC1-7 / ADR-051 §Decision 5.
A composite passes Phase B iff ≥1 benchmark has `verdict='pass-all'`
AND `pbo_value < 0.2`. Otherwise PARTIAL or FAIL per the standard
verdict-tier rules.

Phase C eligibility is mechanical: `phase_c_eligible = 1 iff
verdict='pass-all' AND pbo_value < 0.2`. The orchestration does NOT
auto-promote on Phase C eligibility; Q-8 (operator queue) remains
the only path from eligibility to actual promotion.

### S-PBV1-9 — Composite version pinning

Every row written to `quantlab.phase_b_trials` and
`quantlab.phase_b_verdicts` MUST have
`composite_version = 'vol_struct_v1'`. Per ADR-051 §Decision 8
anti-shopping rule, a future `vol_struct_v2` redesign in response to
whatever this Phase B verdict returns would require independent
canon-cited evidence motivating the redesign. The CH version pin
makes any future `vol_struct_v2` row a single-query auditable event.

---

## 3. Strategy harness — exact signature

Identical to cycle_v1 EXCEPT for `loadScoreSeries()`. Reuses
`backtestTrial()` from `phase_b_campaign_cycle_v1.ts` verbatim if the
Composite worker chooses to extract it to a shared module; otherwise
fork-and-paste is acceptable per the "two of nine" stage of the 9-
composite arc (per S96-118 "after the 9th composite ships, evaluate
whether a generalized phase_b_campaign.ts abstraction is warranted").

```ts
// scripts/phase_b_campaign_vol_struct_v1.ts

/** Daily Φ-rescaled curveSteepnessZ, indexed by snapshot_date. Pulled
 *  from quantlab.vol_structure_snapshots. */
interface ScoreSeries {
  dates: Date[];          // ascending, daily, trading-day-aligned
  scores: number[];       // same length; values in [0, 1] post-Φ-rescaling
}

// loadScoreSeries — the ONLY substantive delta from cycle_v1:
async function loadScoreSeries(
  ch: ClickHouseClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `
      SELECT toString(snapshot_date) AS d,
             curve_steepness_z       AS z
      FROM quantlab.vol_structure_snapshots FINAL
      WHERE snapshot_date >= {start:Date}
        AND snapshot_date <= {end:Date}
        AND curve_steepness_z IS NOT NULL
        AND composite_version = 'vol_struct_v1'
      ORDER BY snapshot_date ASC
    `,
    query_params: { start: ymd(windowStart), end: ymd(windowEnd) },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; z: string | number }>();
  const dates: Date[] = [];
  const scores: number[] = [];
  for (const r of rows) {
    const z = typeof r.z === 'string' ? parseFloat(r.z) : r.z;
    if (!Number.isFinite(z)) continue;
    dates.push(new Date(r.d + 'T00:00:00Z'));
    scores.push(normalCdf(z));    // Φ-rescaling per S-PBV1-2
  }
  return { dates, scores };
}
```

`backtestTrial`, `score-benchmark alignment`, `trade counting`,
`walk-forward split`, `slice-Sharpe computation`, `ValidatorRequest
packaging`, and `verdict aggregation` are all identical to
`phase_b_campaign_cycle_v1.ts` and may be either imported (preferred,
per dry-not-WET) or fork-copied (acceptable, per S96-118).

---

## 4. Persistence — exact CH queries

Identical to cycle_v1 SPEC §4. Tables `quantlab.phase_b_trials` +
`quantlab.phase_b_verdicts` already exist (Cycle 23 migrations); no new
DDL.

Insert shape mirrors cycle_v1 with `composite_version = 'vol_struct_v1'`,
benchmark in {SPY, QQQ, IWM}, theta in {0.05, …, 0.95},
is_start/end/oos_start/end per S-PBV1-5.

---

## 5. Test plan (Composite-worker deliverable)

Target ≥40 tests across the new files:

- [ ] `_probe_phase_b_vol_struct_v1_inputs.test.ts` (~6 tests): probe
      output schema; convention-pin against live CH columns; failure
      modes (table absent → loud, table sparse → loud).
- [ ] `_backfill_vol_structure_snapshots.test.ts` (~6 tests): one-shot
      idempotency under ReplacingMergeTree; row-count expectation
      (~3,250 ± slack for trading-day calendar); fail-loud on candle
      data missing.
- [ ] `phaseBCampaignVolStructV1.test.ts` (≥28 tests):
  - `normalCdf` golden-vector parity (Φ(0)=0.5, Φ(1)≈0.8413, Φ(-1)≈0.1587,
    Φ(2)≈0.9772, max error <1e-6 across ±3σ).
  - `normalCdf` monotonicity (z1 > z2 ⇒ Φ(z1) > Φ(z2)).
  - `loadScoreSeries` skips null curve_steepness_z rows.
  - `loadScoreSeries` produces dates ASC + same-length scores.
  - Backtest correctness: golden-vector test mirroring cycle_v1
    (`flat-when-score≤θ`, `long-when-score>θ`, trade count =
    transitions, Sharpe matches hand-computed reference).
  - Score-benchmark alignment: 4-trading-day forward-fill cap inherited
    from cycle_v1 §3.
  - Walk-forward split: IS_END_DATE = 2022-12-31 cleanly divides; first
    OOS day = 2023-01-03.
  - CSCV slice configuration: T~2520 → effectiveS=16.
  - ValidatorRequest packaging: parametric Mertens DSR path (no
    `perAssetSharpes`); hlzNTests=57; hlzMethod='bhy'; hlzTwoSided=false.
  - Verdict-aggregation rule: 3-benchmark aggregation; PASS-ALL
    requires same benchmark passing all four gates AND PBO<0.2.
  - composite_version pin: every persisted row has
    composite_version='vol_struct_v1'.
- [ ] `phaseBVerdictRepository` reuse passes (no new test file
      required — repo is composite-agnostic from Cycle 23).
- [ ] Existing test suite stays at ≥3477 pass + 19 skip + 0 fail
      (Cycle 23 baseline).

Target post-Cycle-24: ~3477 + ~40 = ~3517 tests minimum.

---

## 6. Verification gates (Composite worker integration gate)

```text
# Pre-flight (Step 0):
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts                  # exit 0 + readable summary

# Backfill IF probe finds the table sparse:
npx tsx scripts/_backfill_vol_structure_snapshots.ts --apply             # ~3,250 rows written

# tsc + tests + campaign dry-run:
npx tsc --noEmit                                                          # ≤ 13 baseline
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts  # ≥28/28 pass
node --import tsx --test scripts/tests/_probe_phase_b_vol_struct_v1*.test.ts \
                                       scripts/tests/_backfill_vol_structure*.test.ts  # ≥12/12 pass
node --import tsx --test                                                  # full suite: ≥3517 pass + 19 skip + 0 fail
npm run health:check:strict                                               # exit 0 OR same Tier-2 set as pre-cycle

# End-to-end campaign run (orchestrator-executed after worker integration):
npx tsx scripts/phase_b_campaign_vol_struct_v1.ts --dry-run              # console summary only
npx tsx scripts/phase_b_campaign_vol_struct_v1.ts --apply                # writes 57 trial rows + 3 verdict rows

# Verify persisted state via the repository (no clickhouse-client needed):
npx tsx -e "import('./src/server/phase_b_repository.js').then(async m => { \
  const r = new m.PhaseBRepository(); \
  console.log(await r.readVerdicts({composite_version:'vol_struct_v1'})); \
})"
```

---

## 7. Files / code state at Cycle 24 close (target)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/phase-b-vol_struct_v1.md` | new | This SPEC |
| `scripts/_probe_phase_b_vol_struct_v1_inputs.ts` | new | Step 0 pre-flight |
| `scripts/_backfill_vol_structure_snapshots.ts` | new (conditional) | Tier-1 auto-fix per S96-117 precedent |
| `scripts/phase_b_campaign_vol_struct_v1.ts` | new | Harness — `loadScoreSeries` is the only substantive delta from cycle_v1 |
| `scripts/tests/phaseBCampaignVolStructV1.test.ts` | new | ≥28 tests |
| `scripts/tests/_probe_phase_b_vol_struct_v1_inputs.test.ts` | new | ~6 tests |
| `scripts/tests/_backfill_vol_structure_snapshots.test.ts` | new | ~6 tests |
| `docs/analysis/phase-b-vol_struct_v1-deflation-2026-05.md` | new (post-`--apply`) | Verdict report |
| `package.json` | modified | NPM scripts: `phase_b:vol_struct_v1:dry`, `phase_b:vol_struct_v1:apply`, `_probe:phase_b_vol_struct_v1`, `_backfill:vol_structure_snapshots` |
| `quantlab.vol_structure_snapshots` | +~3,250 rows | Backfill via repository (forward-only additive; ReplacingMergeTree idempotent) |
| `quantlab.phase_b_trials` | +57 rows | composite_version='vol_struct_v1' × 3 benchmarks × 19 θ trials |
| `quantlab.phase_b_verdicts` | +3 rows | composite_version='vol_struct_v1' × {SPY, QQQ, IWM} |

No real-money path touched. No paid data. No authenticated scraping.
All within data-source policy (yfinance + CH writes pre-authorized).

---

## 8. Watch-outs

- **The Gaussian assumption baked into Φ-rescaling is approximately
  correct, not exactly correct.** Empirical vol z-scores have heavier
  tails than N(0,1). The θ-grid resolution near θ=0.05 and θ=0.95 maps
  to true probability tail-events that occur more often than N(0,1)
  predicts. Mitigation: documented here; if future analysis shows
  Φ-rescaling biases the verdict materially, a v2 with ECDF fit on
  IS-only data is the canon-cited fallback (Bailey-LdP 2014 §A.1
  non-Gaussian PSR variants).
- **vol_structure_snapshots was forward-only before this cycle.** The
  Step 0 probe + conditional backfill is critical. If the worker
  skips the probe + runs straight into the campaign, the
  `loadScoreSeries` query will return ≤90 rows (the post-table-creation
  forward fill) and the campaign will fail with degenerate
  `effectiveS = 0` from CSCV. The probe MUST gate the campaign.
- **VIX9D data sparsity pre-2011.** `computeSteepnessSeries` drops
  any date missing VIX/VIX9D/VIX6M simultaneously. For dates
  2011-01-03 → ~2013-01-03 the trailing-2y baseline straddles the VIX9D
  start; `computeZ` returns null when baseline < 30 prints. Pinned
  WINDOW_START_DATE = 2013-01-03 in S-PBV1-5 avoids this; do NOT
  attempt to push the window earlier without re-evaluating baseline
  sufficiency.
- **The OOS window is shorter than cycle_v1's** (~730 trading days vs
  ~1,370). OOS-IS Pardo gate is computed on shorter samples → wider
  SE on the ratio. Documented as a campaign caveat in the verdict
  row's `notes` field.
- **Per S96-117, the Composite worker may invoke the backfill helper
  inside its scope as a Tier-1 auto-fix** (analogous to QQQ/IWM
  backfill in Cycle 23). However, if the probe surfaces ambiguous
  state (e.g., snapshots table has some rows but covers a partial
  window), the worker should NOT silently re-backfill the whole range
  — it should report the partial state in the return summary and let
  the critic decide whether to expand the backfill or accept the
  partial coverage. The default fallback is "if probe reports
  earliest_date > 2014 OR row_count < 2500, fail-loud and ask critic."
- **The harness's `pickPrimaryPhaseCCandidate` tiebreaker is still
  undocumented** (OQ-C23-3 carry-over). If vol_struct_v1 returns
  PASS-ALL on multiple benchmarks with tied DSR, the primary selection
  is ambiguous. Acceptable for this cycle; resolve in a future cycle.

---

## 9. Open questions — none for SPEC scope

Per orchestration §1 trivial-edit exception, this SPEC is closed for
Composite-worker execution. The worker takes this SPEC + ADR-051 +
the cycle_v1 SPEC as the constraint envelope and ships against them.
The worker MUST NOT relax any threshold or deviate from any decision
in §2-§7 without escalating per orchestration §7.1.5.

---

## 10. Cross-references

- Parent ADR: `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
- Predecessor SPEC: `docs/specs/phase-b-cycle-v1.md` (Cycle 23 first
  instance; this SPEC inherits ~70% of its structure)
- Composite implementation: `src/server/vol_structure.ts` (the
  `vol_struct_v1` composite this campaign validates)
- Composite I/O: `src/server/vol_structure_repository.ts`
- Validator orchestrator: `src/lib/validator.ts`
- DSR/PBO/HLZ library: `src/lib/psr.ts`, `src/lib/cscv.ts`,
  `src/lib/hlzHaircut.ts`
- Phase B repository (composite-agnostic, Cycle 23 deliverable):
  `src/server/phase_b_repository.ts`
- Reference campaign harness (cycle_v1):
  `scripts/phase_b_campaign_cycle_v1.ts`
- Snapshot data source: `quantlab.vol_structure_snapshots`
  (forward-only at SPEC-write time; backfill is part of this cycle)
- Benchmark data source: `quantlab.candles` (SPY/QQQ/IWM at `1d`
  interval; QQQ + IWM backfilled in Cycle 23 per S96-117)
- Original gap composite design: `docs/specs/expanded-vol-structure.md`
