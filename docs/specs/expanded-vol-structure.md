---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
slice_id: gap-expanded-vol-structure
---

# SPEC — Expanded Volatility Term Structure

> **Status:** SPEC complete; CODE proceeds in this session per autonomous-progression rule. **Author:** Claude (Vector Core). **Authority:** [docs/obsidian/gaps/expanded-vol-structure.md](../obsidian/gaps/expanded-vol-structure.md) gap doc; session 85 end-of-arc operator delegation ("please proceed with phase 9 implementation continuation").
>
> **Stage in Vector Core build:** SPEC + CODE in this beat.
>
> **Carry:** Per cycle-position template (SPEC §11 S-MCP-Q5 locked at "accept as terminal"), this composite ships in **informational mode only** — Option B (additive sibling) per gap doc §"Integration into phase1_v3". It does NOT modify the existing `vix_term_inverted` category and does NOT fire a new `phase1_v3+` category in v1. Promotion to a direct classifier input gates on a Phase B independence test + a NEW SPEC.

---

## §1 · Scope clarification

**Builds:**

- Extension of `scripts/macro_regime_ingest.py` to ingest `^VIX9D`, `^VIX6M`, `^VVIX` from Yahoo Finance into `quantlab.candles` (alongside the existing `^VIX`, `^VIX3M`).
- A pure-function composite (`src/server/vol_structure.ts`) that maps a snapshot of the five VIX-family inputs to a `VolStructureSnapshot`: 5 indicators per the gap doc + a discrete `regimeFlag`.
- A `quantlab.vol_structure_snapshots` table for daily persistence.
- A daemon hook that computes + writes one snapshot per cycle.
- A morning-brief section (#8, appended) surfacing the snapshot.

**Does NOT build:**

- Replacement / modification of the existing `vix_term_inverted` category in `phase1_v3` (Option A in the gap doc — rejected per gap doc's own recommendation).
- A new `phase1_v3+` `vol_structure_divergence` category (Option B's classifier-promotion arm — gated on independence test + new SPEC).
- Dashboard React panel (deferred; the cycle-position dashboard already absorbs operator attention for Layer-0 informational composites — a second one would compete without adding clarity).
- Independence test against `phase1_v3` categories (Phase B — deferred per gap doc's 60-90 day observation gate; the cycle-position Phase B validation is fresh evidence that the canonical Phase B order is "ship informational first, validate second").
- Historical backfill of vol-structure snapshots (deferred; daemon writes forward-from-now and we accumulate ~252 trading days before any validation step).

---

## §2 · Decisions baked into this SPEC

### Resolved by canon (no operator decision needed)

**S-VOL-1. Yahoo Finance, not CBOE DataShop.** Yahoo Finance publishes `^VIX9D`, `^VIX`, `^VIX3M`, `^VIX6M`, `^VVIX` for free with the same shape as the already-ingested `^VIX` / `^VIX3M`. CBOE's DataShop is paid; the operator deferred that decision in s79+. Free data covers the entire backtest window we care about.

**S-VOL-2. Informational-only in v1.** The cycle-position arc (s85) validated honestly that even academically-canon Layer-0 informational signals can fail the leading-indicator gate. Adding a second informational composite is acceptable; promoting EITHER to direct classifier input requires its own independence test + SPEC.

**S-VOL-3. Option B (additive sibling), not Option A (replace `vix_term_inverted`).** Per gap doc's own recommendation. Option A re-deflates `phase1_v3`. Option B is rollback-safe and lets the operator A/B against the legacy binary flag.

**S-VOL-4. Pure composite + thin daemon hook + brief panel. No dashboard React panel in v1.** Carry from cycle-position: the substrate is what runs every day; the dashboard is operator-attention infrastructure that competes for screen real estate. If the operator wants a dashboard later, fold the panel into the existing `/#/cycle-position` route as a tab — don't build a new route.

### Indicator definitions (load-bearing)

The composite computes five indicators per gap doc §"Indicators to add":

| # | Name | Definition | Reading |
|---|------|------------|---------|
| 1 | `monotonicBackwardation` | (VIX9D > VIX) AND (VIX > VIX3M) AND (VIX3M > VIX6M) | boolean |
| 2 | `curveSteepnessZ` | (VIX6M - VIX9D) / VIX, z-scored vs trailing 2y mean+sd | float (z) |
| 3 | `inversionDepth` | When backwardated: max(0, VIX9D - VIX6M); else 0 | float (vol points) |
| 4 | `vvixZ` | VVIX value, z-scored vs trailing 2y mean+sd | float (z) |
| 5 | `vvixVixDivergence` | (vvixZ > +1.0) AND (vixZ < 0) | boolean — leading event-risk |

Plus a discrete `regimeFlag` derived from the indicators:

```
'severe_stress' if monotonicBackwardation AND curveSteepnessZ < -2.0
'moderate_stress' if monotonicBackwardation
'event_risk' if vvixVixDivergence AND NOT monotonicBackwardation
'complacent' if curveSteepnessZ > +1.5  (steep contango → complacency)
'normal' otherwise
'unknown' if T10Y3M-equivalent input (VIX) missing
```

**Why these thresholds:** ±1σ z-scores are textbook "noticeably above/below"; the +1.5 contango threshold matches the existing `vix_term_complacency` floor pattern in `phase1_v3` (consistency across signals); the -2σ steepness cutoff for "severe" requires both backwardation AND extreme curve shape (defense in depth against single-noise spikes).

---

## §3 · Component diagram

```text
┌──────────────────────────────────────────────────────────────────┐
│ YF INGEST (extends existing scripts/macro_regime_ingest.py)      │
│ Adds: ^VIX9D, ^VIX6M, ^VVIX → quantlab.candles                   │
│ Existing: ^VIX, ^VIX3M, HYG, SPY, LQD, TLT                       │
└──────────────────────────────────────────────────────────────────┘
                              ↓ (read latest values + 2y history)
┌──────────────────────────────────────────────────────────────────┐
│ VOL-STRUCTURE COMPOSITE (NEW — src/server/vol_structure.ts)      │
│ Pure function: 5 VIX-family values → VolStructureSnapshot         │
│ Indicators: monotonicBackwardation, curveSteepnessZ,              │
│             inversionDepth, vvixZ, vvixVixDivergence              │
│ + regimeFlag (severe/moderate/event_risk/complacent/normal)       │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│ PERSISTENCE (NEW — quantlab.vol_structure_snapshots)             │
│ One row per daemon cycle. ReplacingMergeTree on (snapshot_date). │
└──────────────────────────────────────────────────────────────────┘
                              ↓ (consumed by …)
                  ┌─────────────────────────┐
                  │ MORNING BRIEF SECTION 8 │
                  │ (NEW — operator_brief)   │
                  │ Shows curve + indicators │
                  └─────────────────────────┘
```

---

## §4 · Phased plan

### Phase A — Substrate + brief panel (this beat)

| Unit | Deliverable | Tests |
|------|-------------|-------|
| A1 | Extend YF_TICKERS in `scripts/macro_regime_ingest.py` with VIX9D/VIX6M/VVIX. Backfill against live YF. | manual smoke (Python) |
| A2 | Pure `src/server/vol_structure.ts` with `computeVolStructure(inputs) → VolStructureSnapshot`; z-score helper; `regimeFlag` derivation. | ≥25 unit tests |
| A3 | Migration script `scripts/migrate_create_vol_structure_snapshots.ts` (s84 simple-migration pattern). | ≥10 tests + EXPLAIN |
| A4 | Repository (`src/server/vol_structure_repository.ts`) + daemon hook in `daily_signal_daemon.ts` after the macro-classify step. | ≥15 tests + smoke |
| A5 | Morning-brief section #8 (`renderVolStructureSection` in `operator_brief_render.ts`; `buildVolStructureSection` builder + injection point in `operator_brief.ts`). | ≥8 tests |

### Phase B — Quantitative validation (deferred, separate beat)

Independence test against `phase1_v3` categories (especially `vix_term_inverted` and `sentiment_extreme`) + historical validation against known stress episodes (Feb-2018, Q4-2018, March-2020, 2022) once 60+ daemon-written snapshots accumulate.

### Phase C — Option B promotion (gated)

If Phase B shows |ρ| < 0.7 against existing categories AND demonstrable lead-time on known stress episodes, promote `vvixVixDivergence` or `regimeFlag='severe_stress'` to a `phase1_v3+` `vol_structure_divergence` category via a new SPEC. NOT authorized in this beat.

---

## §5 · Schema — `quantlab.vol_structure_snapshots`

```sql
CREATE TABLE IF NOT EXISTS quantlab.vol_structure_snapshots
(
  snapshot_date           Date,
  computed_at             DateTime64(3),
  -- Raw inputs (Nullable when a series is missing for the date)
  vix9d                   Nullable(Float32),
  vix                     Nullable(Float32),
  vix3m                   Nullable(Float32),
  vix6m                   Nullable(Float32),
  vvix                    Nullable(Float32),
  -- Indicators
  monotonic_backwardation UInt8,                   -- 0/1
  curve_steepness_z       Nullable(Float32),
  inversion_depth         Nullable(Float32),
  vix_z                   Nullable(Float32),
  vvix_z                  Nullable(Float32),
  vvix_vix_divergence     UInt8,                   -- 0/1
  -- Discrete label
  regime_flag             LowCardinality(String),  -- severe_stress|moderate_stress|event_risk|complacent|normal|unknown
  -- Version
  inputs_present          UInt8,                   -- bitmask over VIX9D/VIX/VIX3M/VIX6M/VVIX
  composite_version       LowCardinality(String)   -- 'vol_struct_v1'
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192
```

---

## §6 · Function signatures

```ts
// src/server/vol_structure.ts

export type VolStructureRegimeFlag =
  | 'severe_stress' | 'moderate_stress' | 'event_risk'
  | 'complacent'    | 'normal'          | 'unknown';

export interface VolStructureInputs {
  asOf: Date;
  vix9d: number | null;
  vix:   number | null;
  vix3m: number | null;
  vix6m: number | null;
  vvix:  number | null;
  /** Trailing-2y z-score baseline for VIX (mean + stddev). Null = unavailable. */
  vixZScore: number | null;
  /** Trailing-2y z-score baseline for VVIX. Null = unavailable. */
  vvixZScore: number | null;
  /** Trailing-2y z-score baseline for curveSteepness = (VIX6M-VIX9D)/VIX. */
  curveSteepnessZScore: number | null;
}

export interface VolStructureSnapshot {
  asOf: Date;
  monotonicBackwardation: boolean;
  curveSteepnessZ: number | null;
  inversionDepth: number | null;
  vixZ: number | null;
  vvixZ: number | null;
  vvixVixDivergence: boolean;
  regimeFlag: VolStructureRegimeFlag;
  inputsPresent: number;       // bitmask
  compositeVersion: 'vol_struct_v1';
}

export function computeVolStructure(inputs: VolStructureInputs): VolStructureSnapshot;
```

**Why z-scores are inputs (not computed inside):** matches the `cycle_position.ts` pattern. Z-score requires a trailing window of historical data; pure-function composite stays I/O-free and trivially testable. The repository handles the windowed baseline lookups.

---

## §7 · Test plan (Phase A)

- `vol_structure.test.ts` (≥25 tests):
  - Indicator-1 (monotonic backwardation): all-4-pairs orderings exercised; partial orderings rejected.
  - Indicator-2 (curve steepness z): pass-through of injected z-score; null when input null.
  - Indicator-3 (inversion depth): non-zero only when monotonic backwardation true; magnitude correct.
  - Indicator-4 (VVIX z): pass-through; null path.
  - Indicator-5 (VVIX/VIX divergence): correct AND logic (vvixZ>+1 AND vixZ<0); robust to nulls.
  - `regimeFlag` band table: every label transition tested at boundary values.
  - `inputsPresent` bitmask matches present-input set.
  - Composite version pin: `'vol_struct_v1'`.
- `vol_structure_repository.test.ts` (≥15 tests):
  - Read latest values per series (subquery-around-FINAL pattern; a52c964 regression test).
  - Z-score baseline computation matches the repository's `claims4wMaZscoreAsOf` shape.
  - `readInputsForCycle` composes both reads.
  - Write + read round-trip; EXPLAIN PLAN clean.
- `migrate_create_vol_structure_snapshots.test.ts` (≥10 tests):
  - DDL byte-pin, EXPECTED_COLUMNS pin, pre/post-check happy paths + missing-table path.
  - EXPLAIN PLAN check.
- `operatorBriefVolStructure.test.ts` (≥8 tests):
  - Section renders with snapshot; renders friendly "not yet evaluated" with null; renders each regime flag distinctly; section number is #8.

Phase A target: existing baseline + ~60 new tests.

---

## §8 · Watch-outs

- **VIX9D ticker history starts ~2011 on Yahoo Finance** — backfill prior to 2011 will be sparse / empty for VIX9D, leaving the curve incomplete. The composite handles this via `inputsPresent` bitmask + null-safe indicator logic.
- **VVIX history starts 2007.** Comfortably covers the 2008-present backtest window we'd want for Phase B.
- **VIX z-scores require a 2y rolling baseline.** For the first 2y of any backfill, z-scores resolve to `null` — `regimeFlag` falls back to `'unknown'` for any indicator dependent on z.
- **`monotonic_backwardation` is binary and discards depth.** Use the `inversion_depth` indicator alongside; the boolean alone misleads on borderline curves (curveSteepnessZ at -0.5 looks identical to -2.0).
- **The composite is informational. Do not gate real-money decisions on `regime_flag` directly.** Same posture as cycle-position. Promotion to a kill-switch input requires SPEC §4 Phase C + operator authorization.

---

## §9 · What could break this

- **Yahoo Finance ticker rename / delisting.** ^VIX9D / ^VVIX have been stable for 15+ years; risk is low but non-zero. Mitigation: the YF ingest already logs per-ticker failures and continues with available ones.
- **Z-score divergence over short windows.** With <504 trading days of baseline, z-scores can swing wildly. Fail-loud on `null` baseline rather than computing a misleading z.
- **Indicator interactions.** `vvixVixDivergence` AND `monotonicBackwardation` simultaneously could indicate either a regime-shift signal OR a noise spike. Phase B independence test will surface this in correlation patterns.

---

## §10 · Open questions

All locked at SPEC time:

1. ~~**S-VOL-Q1 (data source)**~~ — LOCKED: Yahoo Finance (S-VOL-1).
2. ~~**S-VOL-Q2 (integration mode)**~~ — LOCKED: Option B additive sibling, informational-only in v1 (S-VOL-3).
3. ~~**S-VOL-Q3 (dashboard panel)**~~ — LOCKED: not in v1 scope (S-VOL-4).
4. ~~**S-VOL-Q4 (Phase C promotion path)**~~ — LOCKED: deferred to a separate SPEC after Phase B independence test (§4 Phase C).

---

## §11 · Sequencing summary

| Phase | What | Duration | Blocks on |
|-------|------|----------|-----------|
| A | Substrate + brief panel | This beat | Nothing |
| B | Independence test + historical validation | After 60+ days of daemon snapshots OR via a historical backfill of pre-2026 vol-structure | Phase A complete |
| C | Option B promotion to direct classifier category | Open | Phase B passes AND operator green-lights |

Phase A is autonomous-safe per the cycle-position template. Phase B + C are operator-gated.
