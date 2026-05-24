---
status: spec-complete
phase: phase-b
last_updated: 2026-05-24
session: 96 #20 Cycle 25
owner: Orchestrator (Vector Core); Composite worker executes Cycle 25
type: spec
slice_id: adr-051-instance-sector_rot_v1
parent_adr: docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md
predecessor_specs:
  - docs/specs/phase-b-cycle-v1.md
  - docs/specs/phase-b-vol_struct_v1.md
---

# SPEC — Phase B deflation-pipeline campaign for `sector_rot_v1`

> **Third instance of the ADR-051 pattern.** Inherits all Cycle 23-24
> infrastructure (`phase_b_trials` + `phase_b_verdicts` tables, the
> `validator.ts` four-gate stack, the `phase_b_repository.ts` typed
> helpers, the `psr.ts`/`cscv.ts`/`hlzHaircut.ts` libraries, the
> `phase_b_dashboard.ts` UI roster — `sector_rot_v1` is already
> registered at line 72 pointing here). This SPEC pins ONLY the
> per-composite overlay: score selection (continuous indicator chosen
> from the composite's 9-measurement output), score-rescaling with
> **polarity flip** (the first per-composite SPEC in the arc to require
> negation — see S-PBSR1-2), benchmark universe, time window, file
> paths. Read [ADR-051](adr-051-layer0-phase-b-deflation-pipeline.md)
> and the predecessor SPECs ([phase-b-cycle-v1.md](phase-b-cycle-v1.md),
> [phase-b-vol_struct_v1.md](phase-b-vol_struct_v1.md)) first; this
> SPEC is the delta.

---

## 1. Scope

**Builds** (Composite worker, Cycle 25):

1. `scripts/_probe_phase_b_sector_rot_v1_inputs.ts` — Step 0 pre-flight
   probe (mirrors the vol_struct_v1 probe; checks
   `sector_rotation_snapshots` row count + earliest date +
   `defensive_cyclical_spread_z` coverage; classifies state as
   full / empty / ambiguous per S96-117 + Cycle 24 refinement).
2. **IF Step 0 probe finds the snapshots table empty or sparse:**
   `scripts/_backfill_sector_rotation_snapshots.ts` — one-shot backfill
   computing daily `SectorRotationSnapshot` for every trading day in the
   campaign window via the existing
   `SectorRotationRepository.readInputsForCycle` +
   `computeSectorRotation` path. Persists ~3,250 rows
   (2013-01-03 → today). Tier-1 auto-fix per ADR-044 + S96-117
   precedent (missing-ingest-never-fired carve-out); refer to the
   Cycle 24 vol_struct_v1 backfill helper as the structural template.
3. `scripts/phase_b_campaign_sector_rot_v1.ts` — campaign harness; ~70%
   shared infrastructure with `phase_b_campaign_cycle_v1.ts` /
   `phase_b_campaign_vol_struct_v1.ts`. The substantive deltas are
   confined to `loadScoreSeries()` (defensiveCyclicalSpreadZ →
   **negated-Φ-rescaled**) and benchmark/window constants. Wires into
   `validator.ts` four-gate stack per benchmark; persists trial + verdict
   rows with `composite_version = 'sector_rot_v1'`.
4. Markdown report at
   `docs/analysis/phase-b-sector_rot_v1-deflation-2026-05.md` (post-run
   verdict + per-gate diagnostics).
5. Unit tests for the harness (≥40 tests covering golden-vector backtest,
   Φ-rescaling identity + monotonicity, **polarity-flip identity
   `Φ(-z) = 1 - Φ(z)` golden-vector pin**, score-benchmark alignment,
   walk-forward split, slice-Sharpe parity, ValidatorRequest packaging,
   verdict-aggregation rule, convention-pin tests on the live CH schema
   for `sector_rotation_snapshots`).

**Does NOT build:**

- Any UI-domain edits. `phase_b_dashboard.ts` line 72 already
  registers `sector_rot_v1` with `specPath:
  'docs/specs/phase-b-sector_rot_v1.md'` (the path this SPEC lives at);
  the dashboard will surface this campaign's verdict rows automatically
  once persisted. **S96-121 critic-enforceable invariant pre-satisfied
  for this cycle.**
- Phase C promotion path (operator-gated per orchestration §7.1 item 8;
  Q-8 remains DORMANT — no Layer-0 composite has returned PASS-ALL yet).
- `sector_rot_v2` composite redesign in response to whatever this Phase B
  returns (anti-shopping rule per ADR-051 §Decision 5 / §Decision 8).
- A "long-only-on-inverse-benchmark" sister campaign (the standard
  long-only template + polarity-flip rescaling tests the bidirectional
  claim "low defensive-cyclical spread → long; high → flat" within the
  established harness; no sister campaign needed).
- Cross-composite meta-HLZ pass (deferred per ADR-051 §Consequences;
  3 of 9 composites with shipped verdicts after this cycle; revisit at
  9-arc completion per OQ-C24-1 + OQ-C22-2).

---

## 2. sector_rot_v1-specific decisions

### S-PBSR1-1 — Score selection: `defensiveCyclicalSpreadZ`, NOT `regimeFlag`

Per [`src/server/sector_rotation.ts`](../../src/server/sector_rotation.ts)
the composite emits a 5-way categorical `regimeFlag` (severe_rotation /
concentration_extreme / defensive_leadership / normal / unknown), 2
boolean flags (`defensiveLeadActive`, `concentrationExtremeActive`),
and 9 continuous measurements (defensive_20d_return,
cyclical_20d_return, defensive_cyclical_spread,
**defensive_cyclical_spread_z**, top_sector_volume_share,
top_sector_volume_share_z, spy_pct_off_52w_high, growth_20d_return,
value_20d_return, plus the boolean spy_within_5pct_of_52w_high).

NONE is a native [0,1] high=bullish score. This SPEC invokes ADR-051
§Decision 1 last-paragraph + S96-120 (Φ default) + the per-composite
SPEC's discretion to apply polarity-flip rescaling for non-high=bullish
semantics:

> "Composites with non-[0,1]-score outputs OR non-'high=bullish'
> semantics apply the same template with the inequality reversed and
> the score rescaled to [0,1] first. The per-composite SPEC documents
> the rescaling."

**Selected score: `defensiveCyclicalSpreadZ`** (column
`defensive_cyclical_spread_z` in `quantlab.sector_rotation_snapshots`).

**Why defensiveCyclicalSpreadZ over alternatives:**

| Candidate | Why rejected |
| --- | --- |
| `regimeFlag` (5-way categorical) | θ-grid degenerates to ≤4 trials; below ADR-051's "smallest defensible N" implicit floor (cycle_v1 = 19). PBO computation on ≤4 trials is degenerate (CSCV requires effectiveS ≥ 4 splits with ≥1 trial in each rank position). Same critique that ruled out vol_struct_v1's regimeFlag in Cycle 24 (S96-119). |
| `defensiveLeadActive` (bool) | Single-trial binary signal; no θ sweep; deflation pipeline has nothing to deflate. |
| `concentrationExtremeActive` (bool) | Same problem as defensiveLeadActive. |
| `spyWithin5PctOf52wHigh` (bool) | Same problem; single-trial binary. |
| `topSectorVolumeShareZ` (continuous z) | A measure of trading-volume concentration, not the sector-rotation thesis directly. The composite's primary thesis is "defensives lead → late-cycle stress"; concentration is a secondary signal. Could be a separate `vol_concentration_v1` composite. |
| `spyPctOff52wHigh` (continuous) | A SPY-derived stretch measure, not specific to sector rotation. Bleeds across thesis boundaries; better tested as part of a hypothetical `index_distance_v1` composite. |
| `growthValueSpread` (continuous) | Bidirectional ambiguous: growth-leading is historically bullish in expansions but bubble-prone at late-cycle. The cycle_v1 / vol_struct_v1 standard long-only template tests one direction at a time; growth/value would require a separate two-sided campaign. Out of scope. |
| `defensiveCyclicalSpreadZ` (continuous z) | **SELECTED.** Directly captures the sector-rotation thesis ("defensives leading cyclicals → late-cycle stress → equity exposure should reduce"). Continuous → full 19-trial θ-sweep available. z-scored against 1y baseline → distribution-aware. Same indicator type (continuous z) that the regimeFlag's `defensive_leadership` threshold gates on. |

**Polarity check.** `defensiveCyclicalSpreadZ = z(defensive20dReturn −
cyclical20dReturn)`, z-scored against a trailing 1y baseline (per
[`sector_rotation_repository.ts:547-558`](../../src/server/sector_rotation_repository.ts#L547-L558)
`computeZ`). Polarity from the source composite ([`sector_rotation.ts:163`](../../src/server/sector_rotation.ts#L163)
`defensiveLeadActive = defensiveCyclicalSpreadZ > +1.0`):

- High z (positive, defensives leading) = late-cycle stress signal =
  **flat-favorable / bearish on equity exposure**
- Low z (negative, cyclicals leading) = early/mid-expansion signal =
  **long-favorable / bullish on equity exposure**

**Polarity is INVERTED** versus cycle_v1 and vol_struct_v1 (which both
have "high score = bullish" semantics). This is the first per-composite
SPEC in the 9-arc to require a polarity flip. See S-PBSR1-2 for how the
flip is implemented (negate the z BEFORE Φ-rescaling, so the validator
stack remains composite-agnostic with the standard "LONG if score > θ"
threshold rule).

### S-PBSR1-2 — Score-rescaling with polarity flip: `score = Φ(−defensiveCyclicalSpreadZ)`

`defensiveCyclicalSpreadZ ∈ R` (theoretically unbounded; empirically
~[-3, +3] in modern data). Rescale to `score ∈ [0, 1]` via the
**negated-Φ** transform:

```
score(t) = Φ(−defensiveCyclicalSpreadZ(t)) = 1 − Φ(defensiveCyclicalSpreadZ(t))
```

The identity `Φ(−z) = 1 − Φ(z)` is exact (standard normal CDF
symmetry; Abramowitz & Stegun 26.2). The harness MAY implement either
form; tests pin equivalence via a golden-vector parity check.

**Why negate (Option B) rather than reverse the inequality (Option A):**

| Option | Description | Verdict |
| --- | --- | --- |
| **A — Reverse inequality** | Keep `score = Φ(defensiveCyclicalSpreadZ)`; backtest with `LONG if score < θ`. | **Rejected.** Forces a `polarityFlipped: boolean` flag through the validator stack + backtest harness; introduces a code path divergence from cycle_v1 / vol_struct_v1; the verdict aggregator's "best trial = argmax IS Sharpe" remains correct only because Sharpe is invariant to threshold direction, but the trial-ordering on θ becomes reversed (θ=0.05 means "long when defensives barely lead" not "long when cyclicals strongly lead") — confusing to read in the verdict report. |
| **B — Negate score (selected)** | `score = Φ(−defensiveCyclicalSpreadZ)`; backtest with the standard `LONG if score > θ`. | **Selected.** Validator stack composite-agnostic; harness identical to cycle_v1 / vol_struct_v1 except `loadScoreSeries`; θ-grid interpretation is preserved (θ=0.84 means "long when cyclicals lead by >+1σ"); no flag propagation. |

This is the second exercise of the ADR-051 §Decision 1 last-paragraph
provision; vol_struct_v1 used straight Φ (no negation) because its
polarity was already aligned. Future per-composite SPECs facing
polarity inversion default to Option B per this precedent (S-PBSR1-2
becomes the locked pattern for polarity-flip composites).

**Φ implementation.** Use the same Abramowitz & Stegun 26.2.17
polynomial approximation that lives in `phase_b_campaign_vol_struct_v1.ts:normalCdf` (max
error ~7.5e-8). Either import + reuse (preferred, per DRY-not-WET) or
fork-copy (acceptable per S96-118 "after the 9th composite ships,
evaluate whether a generalized phase_b_campaign.ts abstraction is
warranted"). Tests pin Φ(0)=0.5, Φ(±1)≈0.8413/0.1587, Φ(±2)≈0.9772/0.0228
golden vectors AND the polarity-flip identity Φ(−z) = 1 − Φ(z) to
double-precision agreement.

**θ interpretation under negated-Φ rescaling.** A θ of 0.5 means "go long
when defensiveCyclicalSpreadZ < 0" (cyclicals net leading defensives in
recent 20d return). θ = 0.84 means "go long when
defensiveCyclicalSpreadZ < −1σ" (cyclicals strongly leading). θ = 0.16
means "go long when defensiveCyclicalSpreadZ < +1σ" (defensives only
mildly leading or below). The standard 19-trial θ grid
{0.05, 0.10, …, 0.95} probes z ∈ [+1.64σ, −1.64σ] — spanning the bulk
of the empirical distribution from "defensives clearly leading" through
"cyclicals clearly leading."

### S-PBSR1-3 — Benchmark universe: SPY + QQQ + IWM

Same as cycle_v1 / vol_struct_v1 (ADR-051 §Decision 2 + S-PBC1-3 +
S-PBV1-3). Justification for sector_rot_v1: the composite's claim is
"US equity sector-rotation predicts US equity stress episodes" —
directly testable on US equity benchmarks. SPY (broad), QQQ
(tech/growth — peaks when cyclical leadership rotates), IWM (small-cap
— peaks when cyclical leadership broadens). Same three economically-
distinct benchmarks; same M=57 HLZ trial budget.

Benchmark token addresses + the QQQ/IWM yfinance backfill already
landed in CH per Cycle 23 S96-117. No further benchmark prep needed.

### S-PBSR1-4 — θ trial grid: {0.05, 0.10, …, 0.95}, 19 trials

Same as cycle_v1 / vol_struct_v1 (ADR-051 §Decision 1). Identical
small-N defensibility argument; identical M=57 = 19 × 3 HLZ
denominator.

### S-PBSR1-5 — Time window + walk-forward split

Constraint: `defensiveCyclicalSpreadZ` requires the 6 sector ETFs
XLP / XLU / XLV (defensive basket) + XLY / XLK / XLF (cyclical basket).
All six launched 1998-12-22 (Select Sector SPDR family inception); SPY
1993-01-22. The composite needs 20-trading-day return windows + 252-day
baseline for the z-score → first defensiveCyclicalSpreadZ with
full-strength baseline ≈ 2000-01-03.

**However**, the snapshots TABLE (`quantlab.sector_rotation_snapshots`)
is forward-only — populated from when the daemon step 1f was added.
Backfill is required (per S-PBSR1 §1.2 above). Per the data window
selected:

**Full window:** 2013-01-03 → today (~13 years, ~3,250 trading days).
**IS:** 2013-01-03 → 2022-12-31 (~10 years, ~2,520 trading days).
**OOS:** 2023-01-03 → today (~3 years, ~730 trading days).

**Why match vol_struct_v1's window rather than extend to 2000:**

| Consideration | Verdict |
| --- | --- |
| Statistical power: longer IS = more trials in CSCV slice budget | Marginal benefit; CSCV `effectiveS` caps at 16 once T > 1024 (per `cscv.ts:115`). 2520 days already saturates. |
| Regime diversity: longer window = more bull/bear/recession regimes | Real benefit; 2000-2013 includes dot-com, GFC, taper-tantrum — 3 major drawdowns absent from 2013-2022. **BUT** drawdowns ≠ "sector-rotation signal regimes"; the composite's late-cycle thesis works regardless of crash mechanism. |
| Cross-composite comparability: same window as cycle_v1 / vol_struct_v1 → cleaner future meta-HLZ + meta-PSR aggregation | **Decisive.** OQ-C22-2 / OQ-C24-1 deferred cross-composite meta-HLZ to 9-arc completion; matching windows makes that aggregation mechanical. |
| Backfill cost: each year × ~250 days × repository round-trips | Linear; both 13y and 26y are O(seconds) per the existing `readInputsForCycle` cost. Negligible. |

**Decision:** match vol_struct_v1's window for cross-composite parity.
The 9-arc completion's meta-HLZ pass (M_meta = 9 × 57 = 513) requires
consistent windows; deviating now would propagate complication.

**Pinned constants:**
- `WINDOW_START_DATE = "2013-01-03"` (first trading day of 2013 in US;
  matches vol_struct_v1 + cycle_v1 alignment).
- `IS_END_DATE = "2022-12-31"`.
- `OOS_START_DATE = "2023-01-03"` (first trading day of 2023 in US).

**Note on `regimeFlag` 'unknown' window pre-XLC/XLRE.** The composite's
`regimeFlag` requires ALL 11 sector volumes (including XLC and XLRE);
XLC launched 2018-09-24, XLRE 2015-10-08, so `regimeFlag='unknown'`
across 2013-01-03 → ~2015-10-08 and the `concentrationExtremeActive`
flag is unavailable for that window. **However**,
`defensiveCyclicalSpreadZ` only requires the 6 sectors XLP/XLU/XLV +
XLY/XLK/XLF (all pre-1999) — so the selected score is computable
throughout the entire window. The campaign harness's `loadScoreSeries`
filters on `defensive_cyclical_spread_z IS NOT NULL`; rows with null
spread-z (none expected in 2013+) would be skipped silently per S-PBV1
§3 pattern.

### S-PBSR1-6 — CSCV slice configuration

Per `cscv.ts:115-117` auto-downshift logic: T ≈ 2520 → effectiveS = 16
(above the 1024 threshold) → C(16, 8) = 12,870 combos. Same as cycle_v1
and vol_struct_v1.

### S-PBSR1-7 — Four-gate validator invocation

**Identical to cycle_v1 SPEC §S-PBC1-6** (inherited verbatim including
the parametric Mertens DSR path per S96-116). The only delta is the
input scores being negated-Φ-rescaled defensiveCyclicalSpreadZ rather
than raw cycle_v1 score; the validator stack is composite-agnostic.

DSR path: **parametric Mertens, NOT bootstrap.** Same rationale as
cycle_v1 / vol_struct_v1 SPECs:
- `observedSharpe = bestTrial.is_sharpe` (argmax over θ trials, not
  median over assets).
- No cross-sectional asset panel; bootstrap `perAssetSharpes` path is
  not applicable.
- `bootstrapDSR()` in `psr.ts:185-186` requires
  `observedSharpe ≈ median(perAssetSharpes)`; here it would resample
  the selection-bias axis and produce a meaningless SE.

HLZ M = 19 × 3 = 57, BHY one-sided at α=0.05. Same threshold as cycle_v1
+ vol_struct_v1.

### S-PBSR1-8 — Verdict aggregation across benchmarks

Inherited verbatim from cycle_v1 SPEC §S-PBC1-7 / vol_struct_v1 SPEC
§S-PBV1-8 / ADR-051 §Decision 5. A composite passes Phase B iff ≥1
benchmark has `verdict='pass-all'` AND `pbo_value < 0.2`. Otherwise
PARTIAL or FAIL per the standard verdict-tier rules.

Phase C eligibility is mechanical: `phase_c_eligible = 1 iff
verdict='pass-all' AND pbo_value < 0.2`. The orchestration does NOT
auto-promote on Phase C eligibility; Q-8 (operator queue) remains the
only path from eligibility to actual promotion.

### S-PBSR1-9 — Composite version pinning

Every row written to `quantlab.phase_b_trials` and
`quantlab.phase_b_verdicts` MUST have
`composite_version = 'sector_rot_v1'`. Per ADR-051 §Decision 8
anti-shopping rule, a future `sector_rot_v2` redesign in response to
whatever this Phase B verdict returns would require independent
canon-cited evidence motivating the redesign. The CH version pin
makes any future `sector_rot_v2` row a single-query auditable event.

---

## 3. Strategy harness — exact signature

Identical to vol_struct_v1 EXCEPT for `loadScoreSeries()` (negated-Φ
rescaling) + benchmark/window constants. Reuses `backtestTrial`,
walk-forward split, slice-Sharpe computation, ValidatorRequest
packaging, and verdict aggregation from
`phase_b_campaign_cycle_v1.ts` / `phase_b_campaign_vol_struct_v1.ts`.
Either import + reuse (preferred per DRY-not-WET) or fork-copy
(acceptable per S96-118).

```ts
// scripts/phase_b_campaign_sector_rot_v1.ts

/** Daily negated-Φ-rescaled defensiveCyclicalSpreadZ, indexed by
 *  snapshot_date. Pulled from quantlab.sector_rotation_snapshots. */
interface ScoreSeries {
  dates: Date[];          // ascending, daily, trading-day-aligned
  scores: number[];       // same length; values in [0, 1] post-rescaling
}

// loadScoreSeries — the ONLY substantive delta from vol_struct_v1:
async function loadScoreSeries(
  ch: ClickHouseClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `
      SELECT toString(snapshot_date)         AS d,
             defensive_cyclical_spread_z     AS z
      FROM quantlab.sector_rotation_snapshots FINAL
      WHERE snapshot_date >= {start:Date}
        AND snapshot_date <= {end:Date}
        AND defensive_cyclical_spread_z IS NOT NULL
        AND composite_version = 'sector_rot_v1'
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
    scores.push(normalCdf(-z));    // negated-Φ rescaling per S-PBSR1-2
  }
  return { dates, scores };
}
```

`backtestTrial`, `score-benchmark alignment`, `trade counting`,
`walk-forward split`, `slice-Sharpe computation`, `ValidatorRequest
packaging`, and `verdict aggregation` are all identical to
`phase_b_campaign_cycle_v1.ts` / `phase_b_campaign_vol_struct_v1.ts`
and may be either imported (preferred) or fork-copied (acceptable).

---

## 4. Persistence — exact CH queries

Identical to cycle_v1 / vol_struct_v1 SPEC §4. Tables
`quantlab.phase_b_trials` + `quantlab.phase_b_verdicts` already exist
(Cycle 23 migrations); no new DDL.

Insert shape mirrors predecessors with
`composite_version = 'sector_rot_v1'`, benchmark in {SPY, QQQ, IWM},
theta in {0.05, …, 0.95}, is_start/end/oos_start/end per S-PBSR1-5.

---

## 5. Test plan (Composite-worker deliverable)

Target ≥40 tests across the new files:

- [ ] `_probe_phase_b_sector_rot_v1_inputs.test.ts` (~6 tests): probe
      output schema; convention-pin against live CH columns;
      state-classifier (full / empty / ambiguous) under simulated
      inputs; failure modes (table absent → loud, table sparse → loud).
- [ ] `_backfill_sector_rotation_snapshots.test.ts` (~6 tests): one-shot
      idempotency under ReplacingMergeTree; row-count expectation
      (~3,250 ± slack for trading-day calendar); ambiguous-state guard
      (does NOT silently re-backfill a partially-populated table); fail-
      loud on candle data missing for required series (XLP, XLU, XLV,
      XLY, XLK, XLF).
- [ ] `phaseBCampaignSectorRotV1.test.ts` (≥28 tests):
  - `normalCdf` golden-vector parity (Φ(0)=0.5, Φ(±1)≈0.8413/0.1587,
    Φ(±2)≈0.9772/0.0228, max error <1e-6 across ±3σ).
  - `normalCdf` monotonicity (z1 > z2 ⇒ Φ(z1) > Φ(z2)).
  - **Polarity-flip identity:** Φ(−z) + Φ(z) = 1.0 ± 1e-12 across
    z ∈ {−3, −2, −1, 0, +1, +2, +3} (S-PBSR1-2 golden-vector pin).
  - `loadScoreSeries` skips null defensive_cyclical_spread_z rows.
  - `loadScoreSeries` produces dates ASC + same-length scores.
  - `loadScoreSeries` applies negation BEFORE Φ (test: high z input →
    low score output; low z input → high score output).
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
    composite_version='sector_rot_v1'.
- [ ] Existing test suite stays at ≥3589 pass + 17 skip + 0 fail
      (Cycle 24 baseline).

Target post-Cycle-25: ~3589 + ~40 = ~3629 tests minimum.

---

## 6. Verification gates (Composite worker integration gate)

```text
# Pre-flight (Step 0):
npx tsx scripts/_probe_phase_b_sector_rot_v1_inputs.ts                  # exit 0 + readable summary

# Backfill IF probe finds the table sparse:
npx tsx scripts/_backfill_sector_rotation_snapshots.ts --apply           # ~3,250 rows written

# tsc + tests + campaign dry-run:
npx tsc --noEmit                                                          # ≤ 13 baseline
node --import tsx --test scripts/tests/phaseBCampaignSectorRotV1.test.ts  # ≥28/28 pass
node --import tsx --test scripts/tests/_probe_phase_b_sector_rot_v1*.test.ts \
                                       scripts/tests/_backfill_sector_rotation*.test.ts  # ≥12/12 pass
node --import tsx --test                                                  # full suite: ≥3629 pass + 17 skip + 0 fail
npm run health:check:strict                                               # exit 0 OR same Tier-2 set as pre-cycle

# End-to-end campaign run (orchestrator-executed after worker integration):
npx tsx scripts/phase_b_campaign_sector_rot_v1.ts --dry-run              # console summary only
npx tsx scripts/phase_b_campaign_sector_rot_v1.ts --apply                # writes 57 trial rows + 3 verdict rows

# Verify persisted state via the repository (no clickhouse-client needed):
npx tsx -e "import('./src/server/phase_b_repository.js').then(async m => { \
  const r = new m.PhaseBRepository(); \
  console.log(await r.readVerdicts({composite_version:'sector_rot_v1'})); \
})"
```

---

## 7. Files / code state at Cycle 25 close (target)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/phase-b-sector_rot_v1.md` | new | This SPEC |
| `scripts/_probe_phase_b_sector_rot_v1_inputs.ts` | new | Step 0 pre-flight |
| `scripts/_backfill_sector_rotation_snapshots.ts` | new (conditional) | Tier-1 auto-fix per S96-117 precedent |
| `scripts/phase_b_campaign_sector_rot_v1.ts` | new | Harness — `loadScoreSeries` is the only substantive delta from vol_struct_v1 |
| `scripts/tests/phaseBCampaignSectorRotV1.test.ts` | new | ≥28 tests |
| `scripts/tests/_probe_phase_b_sector_rot_v1_inputs.test.ts` | new | ~6 tests |
| `scripts/tests/_backfill_sector_rotation_snapshots.test.ts` | new | ~6 tests |
| `docs/analysis/phase-b-sector_rot_v1-deflation-2026-05.md` | new (post-`--apply`) | Verdict report |
| `package.json` | modified | NPM scripts: `phase_b:sector_rot_v1:dry`, `phase_b:sector_rot_v1:apply`, `_probe:phase_b_sector_rot_v1`, `_backfill:sector_rotation_snapshots` |
| `quantlab.sector_rotation_snapshots` | +~3,250 rows | Backfill via repository (forward-only additive; ReplacingMergeTree idempotent) |
| `quantlab.phase_b_trials` | +57 rows | composite_version='sector_rot_v1' × 3 benchmarks × 19 θ trials |
| `quantlab.phase_b_verdicts` | +3 rows | composite_version='sector_rot_v1' × {SPY, QQQ, IWM} |
| `src/server/phase_b_dashboard.ts` | UNCHANGED | `sector_rot_v1` already in KNOWN_COMPOSITES roster at line 72 per Cycle 24 |

No real-money path touched. No paid data. No authenticated scraping.
All within data-source policy (yfinance + CH writes pre-authorized).
No UI-domain edits (S96-121 critic-enforceable invariant satisfied at
SPEC-write time via Cycle 24's KNOWN_COMPOSITES pre-population).

---

## 8. Watch-outs

- **Polarity-flip is the highest-risk delta in this cycle.** The
  negation MUST happen BEFORE Φ-rescaling, NOT after. Tests pin both
  the identity `Φ(−z) = 1 − Φ(z)` AND the directional behavior (high z
  input → low score output). A worker that drops the minus sign or
  applies negation post-Φ would silently invert the test (`LONG when
  defensives lead` instead of `LONG when cyclicals lead`) and produce a
  verdict that's mechanically valid but interpretation-inverted. Critic
  MUST verify the negation site in `loadScoreSeries` and the
  golden-vector test.
- **The Gaussian assumption baked into Φ-rescaling is approximately
  correct, not exactly correct.** Same caveat as vol_struct_v1 SPEC
  §S-PBV1-2. defensiveCyclicalSpreadZ has approximately N(0,1)
  distribution by construction (it IS a z-score) so the assumption
  holds tighter here than for raw vol z-scores. Documented; no v2 ECDF
  fallback planned unless empirical tail behavior shows material bias.
- **sector_rotation_snapshots was forward-only before this cycle.** The
  Step 0 probe + conditional backfill is critical. If the worker skips
  the probe + runs straight into the campaign, the `loadScoreSeries`
  query will return ≤90 rows (the post-table-creation forward fill) and
  the campaign will fail with degenerate `effectiveS = 0` from CSCV.
  The probe MUST gate the campaign.
- **The probe's state classifier (full / empty / ambiguous) MUST honor
  the Cycle 24 refinement:** if the table has SOME rows but coverage is
  partial (earliest_date > 2014 OR row_count < 2500), the worker should
  NOT silently re-backfill the whole range — it should report the
  partial state in the return summary and let the critic decide whether
  to expand the backfill or accept the partial coverage. The default
  fallback is "fail-loud and ask critic."
- **XLC + XLRE backfill carve-outs** (2018-09-24 / 2015-10-08
  respectively). The `regimeFlag` column will be `'unknown'` for
  ~2013-01-03 through 2015-10-08 (no XLRE means
  `INPUT_SECTOR_VOLUMES = 0` → unknown). This does NOT affect the
  selected score `defensiveCyclicalSpreadZ`, which only requires the 6
  sectors XLP/XLU/XLV + XLY/XLK/XLF (all pre-1999). The harness's
  `loadScoreSeries` filters on `defensive_cyclical_spread_z IS NOT
  NULL` and is unaffected; the snapshot-row backfill simply persists
  rows where the spread-z is computable and the regime-flag is
  unknown — this is intended graceful-degrade behavior per
  [`sector_rotation_repository.ts:602-612`](../../src/server/sector_rotation_repository.ts#L602-L612).
- **The OOS window is shorter than cycle_v1's** (~730 trading days vs
  ~1,370) but identical to vol_struct_v1's. OOS-IS Pardo gate is
  computed on shorter samples → wider SE on the ratio. Documented as a
  campaign caveat in the verdict row's `notes` field.
- **HLZ M=57 has blocked all 2 of 2 shipped composites at rank-1.**
  Per HANDOFF OQ-C24-1 the M=57 threshold appears to be the dominant
  failure mode for the Layer-0 arc. sector_rot_v1's defensiveCyclicalSpreadZ
  has stronger canon support than cycle_v1's leading-indicator composite
  (Asness et al. 2000 + Sassetti & Tani 2006 are peer-reviewed; the
  cycle composite's source `bus_cycle_composite_index` had thinner
  canon). The composite MAY clear HLZ where the predecessors did not.
  Verdict report MUST surface the HLZ-failure pattern across all 3
  composites once this cycle completes.
- **Per S96-117, the Composite worker may invoke the backfill helper
  inside its scope as a Tier-1 auto-fix** (analogous to QQQ/IWM
  backfill in Cycle 23 + vol_structure_snapshots backfill in Cycle 24).
  However, the ambiguous-state guard (above) MUST hold.
- **The harness's `pickPrimaryPhaseCCandidate` tiebreaker is still
  undocumented** (OQ-C23-3 / OQ-C24-3 carry-over). If sector_rot_v1
  returns PASS-ALL on multiple benchmarks with tied DSR, the primary
  selection is ambiguous. Acceptable for this cycle; resolve in a
  future cycle.
- **NPM-script-file-renaming risk.** vol_struct_v1's harness exposes
  exports (`normalCdf`, types) that this cycle's harness imports. If
  the worker chooses the "import + reuse" path (preferred), it MUST
  verify those exports exist + are stable in
  `phase_b_campaign_vol_struct_v1.ts`. If a Cycle 23-24 worker renamed
  the symbol since this SPEC was drafted, the import will fail —
  fork-copy is the fallback.

---

## 9. Open questions — none for SPEC scope

Per orchestration §1 trivial-edit exception, this SPEC is closed for
Composite-worker execution. The worker takes this SPEC + ADR-051 + the
predecessor SPECs as the constraint envelope and ships against them.
The worker MUST NOT relax any threshold or deviate from any decision
in §2-§7 without escalating per orchestration §7.1.5.

---

## 10. Cross-references

- Parent ADR: `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
- Predecessor SPECs:
  - `docs/specs/phase-b-cycle-v1.md` (Cycle 23 first instance; PARTIAL)
  - `docs/specs/phase-b-vol_struct_v1.md` (Cycle 24 second instance;
    PARTIAL; established Φ-rescaling default per S96-120)
- Composite implementation: `src/server/sector_rotation.ts` (the
  `sector_rot_v1` composite this campaign validates)
- Composite I/O: `src/server/sector_rotation_repository.ts`
- Validator orchestrator: `src/lib/validator.ts`
- DSR/PBO/HLZ library: `src/lib/psr.ts`, `src/lib/cscv.ts`,
  `src/lib/hlzHaircut.ts`
- Phase B repository (composite-agnostic, Cycle 23 deliverable):
  `src/server/phase_b_repository.ts`
- Reference campaign harnesses:
  - `scripts/phase_b_campaign_cycle_v1.ts`
  - `scripts/phase_b_campaign_vol_struct_v1.ts` (closest template —
    same Φ-rescaling pattern minus the negation)
- Snapshot data source: `quantlab.sector_rotation_snapshots`
  (forward-only at SPEC-write time; backfill is part of this cycle)
- Benchmark data source: `quantlab.candles` (SPY/QQQ/IWM at `1d`
  interval; QQQ + IWM backfilled in Cycle 23 per S96-117)
- Original gap composite design: `docs/specs/sector-rotation.md`
- Phase B UI surface: `src/server/phase_b_dashboard.ts` (KNOWN_COMPOSITES
  line 72 already registers `sector_rot_v1` → this SPEC's path)
- Canon foundations:
  - Asness, Friedman, Krail, Liew 2000 "Style Timing: Value vs Growth"
    (growth/value rotation as regime signal)
  - Sassetti & Tani 2006 "Dynamic Asset Allocation Using Systematic
    Sector Rotation" *Journal of Wealth Management*
  - Stovall, *Standard & Poor's Sector Investing* (late-cycle
    defensives-lead pattern)
  - Ben-David, Franzoni, Moussawi 2018 "Do ETFs Increase Volatility?"
    *Journal of Finance* (justifies volume-concentration indicator,
    though that indicator is not the selected score for this campaign)
