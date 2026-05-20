# SPEC — Sector Rotation Monitoring

> **Status:** SPEC complete; CODE proceeds in this session per autonomous-progression rule. **Author:** Claude (Vector Core). **Authority:** [docs/obsidian/gaps/sector-rotation-monitoring.md](../obsidian/gaps/sector-rotation-monitoring.md) gap doc; session 86 end-of-arc operator delegation ("continue").
>
> **Stage in Vector Core build:** SPEC + CODE in this beat.
>
> **Carry:** Per the cycle-position (s85) and vol-structure (s86) templates, this composite ships in **informational mode only** — Phase A per gap doc §"Implementation phases". It does NOT modify the existing `phase1_v3` categories and does NOT fire a new `phase1_v3+` category in v1. Promotion to a direct classifier input gates on a Phase B independence test + a NEW SPEC.

---

## §1 · Scope clarification

**Builds:**

- Extension of `scripts/macro_regime_ingest.py` to ingest the 11 SPDR sector ETFs (`XLK`, `XLF`, `XLE`, `XLV`, `XLY`, `XLP`, `XLU`, `XLI`, `XLB`, `XLRE`, `XLC`) + `IWF` (Russell 1000 Growth) + `IWD` (Russell 1000 Value) from Yahoo Finance into `quantlab.candles`.
- A pure-function composite (`src/server/sector_rotation.ts`) that maps a snapshot of the sector + style inputs to a `SectorRotationSnapshot`: 9 measurements + 2 boolean flags + a discrete `regimeFlag`.
- A `quantlab.sector_rotation_snapshots` table for daily persistence.
- A daemon hook that computes + writes one snapshot per cycle.
- A morning-brief section (#9, appended) surfacing the snapshot.

**Does NOT build:**

- The third gap-doc composite indicator (`rotation_dispersion_high`). That indicator depends on per-ETF capital-flow z-scores; we don't ingest ETF flows (companion gap `etf-flow-monitoring.md`, scrape-worker debt deferred). v1 ships the two flow-independent regime indicators.
- A new `phase1_v3+` `sector_rotation` category (Phase C — gated on independence test + new SPEC).
- Dashboard React panel (carry from S-VOL-4: the cycle-position dashboard already absorbs operator attention for Layer-0 informational composites).
- Independence test against `phase1_v3` categories (Phase B — deferred per gap doc's 60-90 day observation gate; the cycle-position Phase B validation is fresh evidence that the canonical Phase B order is "ship informational first, validate second").
- Historical backfill of sector-rotation snapshots (deferred; daemon writes forward-from-now and we accumulate ~252 trading days before any validation step).
- Factor ETFs (`MTUM`, `USMV`, `QUAL`). Gap doc §"Open questions" flagged these as candidates but with shorter history and weaker liquidity. SPDR sectors are the locked v1 scope.

---

## §2 · Decisions baked into this SPEC

### Resolved by canon (no operator decision needed)

**S-SR-1. Yahoo Finance + SPDR sector ETFs.** Same data substrate as the existing `scripts/macro_regime_ingest.py` ingest. The SPDR family is the practitioner standard for sector exposure (cleanest factor exposure per the gap doc); their YF history extends to 1998 for the original 9 sectors, 2015 for XLRE, and 2018 for XLC. iShares (sector funds) is an alternative but with a different sector definition scheme; per gap doc §"Watch-outs" — pick one and stay consistent. SPDRs are the lock.

**S-SR-2. Informational-only in v1.** Same posture as the cycle-position (s85) and vol-structure (s86) composites. The Layer-0 informational substrate now carries three parallel composites; promoting any to direct classifier input requires its own independence test + SPEC.

**S-SR-3. Two of three gap-doc composite indicators in v1.** `rotation_defensive_lead` and `rotation_concentration_extreme` are buildable from price + volume data already in the YF ingest. `rotation_dispersion_high` requires per-ETF capital-flow z-scores from the companion `etf-flow-monitoring.md` gap, which has a scrape-worker cost. v1 ships without flow-dispersion; v2 (if ever) adds it after etf-flow-monitoring lands.

**S-SR-4. No dashboard React panel in v1.** Carry from S-VOL-4 (s86). If the operator wants a dashboard later, fold a tab into the existing `/#/cycle-position` route — don't build a new route.

### Indicator definitions (load-bearing)

The composite computes 9 measurements:

| # | Name | Definition |
|---|------|------------|
| 1 | `defensive20dReturn` | mean(20d total-return for XLP, XLU, XLV) |
| 2 | `cyclical20dReturn` | mean(20d total-return for XLY, XLK, XLF) |
| 3 | `defensiveCyclicalSpread` | `defensive20dReturn − cyclical20dReturn` (decimal; +0.03 = defensives outperformed cyclicals by 3pp over 20d) |
| 4 | `defensiveCyclicalSpreadZ` | z-score of the spread vs trailing 1-year baseline |
| 5 | `topSectorSymbol` | argmax over 11 sectors of 20d-avg($-volume) |
| 6 | `topSectorVolumeShare` | top sector's 20d-avg $-volume / total 11-sector 20d-avg $-volume |
| 7 | `topSectorVolumeShareZ` | z-score of share vs trailing 1-year baseline |
| 8 | `spyPctOff52wHigh` | (spyClose − spy52wHigh) / spy52wHigh (negative; -0.03 = 3% below high) |
| 9 | `growthValueSpread` | (IWF 20d return − IWD 20d return); informational, not gated |

Two boolean flags:

- `defensiveLeadActive`: `defensiveCyclicalSpreadZ > +1.0` AND `spyPctOff52wHigh > −0.05` (within 5% of 52w high)
- `concentrationExtremeActive`: `topSectorVolumeShareZ > +1.5`

Discrete `regimeFlag` derived via priority order (severity-first, same pattern as vol-structure):

```
'severe_rotation'         if defensiveLeadActive AND concentrationExtremeActive
'concentration_extreme'   if concentrationExtremeActive AND NOT defensiveLeadActive
'defensive_leadership'    if defensiveLeadActive AND NOT concentrationExtremeActive
'normal'                  if neither flag active
'unknown'                 if any required input missing (z-scores null / SPY context null / required sector closes null)
```

**Why these thresholds:**
- Z-score thresholds match the vol-structure pattern (+1.0σ ≈ 84th percentile; +1.5σ ≈ 93rd percentile). Gap doc called for 80th + 90th percentile; +1.0/+1.5 are the closest z-equivalents that preserve the existing cross-composite consistency.
- The 5% proximity-to-52w-high gate is the gap doc's exact value (§"Composite indicators for regime input" #1). It distinguishes "defensives leading from highs" (late-cycle pattern, classic) from "defensives leading from a drawdown" (already in a risk-off, not a leading signal).
- Priority `severe > concentration > defensive` because concentration-extreme is structural fragility (one sector = 1y-high share of volume) while defensive-lead is regime-rotation; both together = both fragility AND rotation = severe. The cycle-position lesson (equal-weight diluted leading signals) is avoided here: each flag is its own threshold-pinned binary; the regime label is the disjunction with severity ordering, not a weighted sum.

### Constants (locked)

- `DEFENSIVE_SECTORS = ['XLP', 'XLU', 'XLV']`
- `CYCLICAL_SECTORS = ['XLY', 'XLK', 'XLF']`
- `TRACKED_SECTORS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLU', 'XLI', 'XLB', 'XLRE', 'XLC']` (11 SPDR sectors)
- `RETURN_WINDOW_DAYS = 20`
- `VOLUME_WINDOW_DAYS = 20`
- `BASELINE_WINDOW_DAYS = 252` (1 trading year)
- `DEFENSIVE_LEAD_Z_THRESHOLD = +1.0`
- `CONCENTRATION_EXTREME_Z_THRESHOLD = +1.5`
- `SPY_HIGH_PROXIMITY_THRESHOLD = 0.05`

---

## §3 · Component diagram

```text
┌──────────────────────────────────────────────────────────────────┐
│ YF INGEST (extends existing scripts/macro_regime_ingest.py)      │
│ Adds: 11 SPDR sectors + IWF + IWD → quantlab.candles             │
│ Existing: ^VIX, ^VIX3M, ^VIX9D, ^VIX6M, ^VVIX, HYG, SPY, LQD, TLT│
└──────────────────────────────────────────────────────────────────┘
                              ↓ (read 20d trailing closes + 20d trailing volumes + 1y baselines)
┌──────────────────────────────────────────────────────────────────┐
│ SECTOR-ROTATION COMPOSITE (NEW — src/server/sector_rotation.ts)  │
│ Pure function: 13 ETF inputs + baselines → SectorRotationSnapshot│
│ Indicators: def/cyc spread + z, top sector + share + z,          │
│             SPY 52w context, growth/value spread                  │
│ + regimeFlag (severe_rotation/concentration_extreme/             │
│                defensive_leadership/normal/unknown)               │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│ PERSISTENCE (NEW — quantlab.sector_rotation_snapshots)           │
│ One row per daemon cycle. ReplacingMergeTree on (snapshot_date). │
└──────────────────────────────────────────────────────────────────┘
                              ↓ (consumed by …)
                  ┌─────────────────────────┐
                  │ MORNING BRIEF SECTION 9 │
                  │ (NEW — operator_brief)   │
                  │ Shows regime + top sector│
                  └─────────────────────────┘
```

---

## §4 · Phased plan

### Phase A — Substrate + brief panel (this beat)

| Unit | Deliverable | Tests |
|------|-------------|-------|
| A1 | Extend YF_TICKERS in `scripts/macro_regime_ingest.py` with 11 SPDR + IWF + IWD. Backfill against live YF (full window per ticker; SPDR sectors back to 1998-2018 depending on the carve-out). | manual smoke (Python) |
| A2 | Pure `src/server/sector_rotation.ts` with `computeSectorRotation(inputs) → SectorRotationSnapshot`; 9 measurements + 2 flags + `regimeFlag` derivation. | ≥25 unit tests |
| A3 | Migration `scripts/migrate_create_sector_rotation_snapshots.ts` (s84 simple-migration pattern). | ≥10 tests + EXPLAIN |
| A4 | Repository (`src/server/sector_rotation_repository.ts`) + daemon hook in `daily_signal_daemon.ts` after step 1e vol-structure (step 1f). | ≥15 tests + live smoke |
| A5 | Morning-brief section #9 (`renderSectorRotationSection` in `operator_brief_render.ts`; `buildSectorRotationSection` builder + injection point in `operator_brief.ts`). | ≥8 tests |

### Phase B — Quantitative validation (deferred, separate beat)

Independence test against `phase1_v3` categories (especially `risk_off_rotation` and `hyg_spy_divergence`) + historical validation against known late-cycle / rotation episodes (2000 dot-com top, 2007 financials-led top, 2018 vol-mageddon, 2022 tech-de-rate) once 60+ daemon-written snapshots accumulate OR via a historical backfill arc.

### Phase C — Promotion (gated)

If Phase B shows |ρ| < 0.7 against existing categories AND demonstrable lead-time on known rotation episodes, promote `regimeFlag='severe_rotation'` or `defensiveLeadActive` to a `phase1_v3+` `sector_rotation` category via a new SPEC. NOT authorized in this beat.

---

## §5 · Schema — `quantlab.sector_rotation_snapshots`

```sql
CREATE TABLE IF NOT EXISTS quantlab.sector_rotation_snapshots
(
  snapshot_date                Date,
  computed_at                  DateTime64(3),
  -- Defensive/cyclical
  defensive_20d_return         Nullable(Float32),
  cyclical_20d_return          Nullable(Float32),
  defensive_cyclical_spread    Nullable(Float32),
  defensive_cyclical_spread_z  Nullable(Float32),
  -- Concentration
  top_sector_symbol            LowCardinality(String),  -- 'XLK' | ... | ''
  top_sector_volume_share      Nullable(Float32),
  top_sector_volume_share_z    Nullable(Float32),
  -- SPY context
  spy_pct_off_52w_high         Nullable(Float32),
  spy_within_5pct_of_52w_high  UInt8,                   -- 0/1
  -- Growth/value (informational)
  growth_20d_return            Nullable(Float32),
  value_20d_return             Nullable(Float32),
  growth_value_spread          Nullable(Float32),
  -- Flags
  defensive_lead_active        UInt8,                   -- 0/1
  concentration_extreme_active UInt8,                   -- 0/1
  -- Discrete label
  regime_flag                  LowCardinality(String),  -- severe_rotation|concentration_extreme|defensive_leadership|normal|unknown
  -- Version
  inputs_present               UInt8,                   -- bitmask (see §6)
  composite_version            LowCardinality(String)   -- 'sector_rot_v1'
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192
```

---

## §6 · Function signatures

```ts
// src/server/sector_rotation.ts

export type SectorRotationRegimeFlag =
  | 'severe_rotation'
  | 'concentration_extreme'
  | 'defensive_leadership'
  | 'normal'
  | 'unknown';

export type TrackedSectorSymbol =
  | 'XLK' | 'XLF' | 'XLE' | 'XLV' | 'XLY' | 'XLP'
  | 'XLU' | 'XLI' | 'XLB' | 'XLRE' | 'XLC';

export interface SectorRotationInputs {
  asOf: Date;
  // 20-day total returns per ETF (decimal; 0.05 = 5%). Null = data missing.
  sectorReturns20d: Record<TrackedSectorSymbol, number | null>;
  // 20-day average $-volume per sector ETF (USD). Null = data missing.
  sectorAvgDollarVolume20d: Record<TrackedSectorSymbol, number | null>;
  // SPY context.
  spyClose: number | null;
  spy52wHigh: number | null;
  // Growth/value (Russell 1000 G/V) 20-day returns.
  iwfReturn20d: number | null;
  iwdReturn20d: number | null;
  // Trailing-1y z-score baselines (mean + stddev) — computed by repository.
  // `null` = baseline insufficient (<30 prints); z-derived flags fall back to `unknown`.
  defensiveCyclicalSpreadZScore: number | null;
  topSectorVolumeShareZScore: number | null;
}

export interface SectorRotationSnapshot {
  asOf: Date;
  defensive20dReturn: number | null;
  cyclical20dReturn: number | null;
  defensiveCyclicalSpread: number | null;
  defensiveCyclicalSpreadZ: number | null;
  topSectorSymbol: TrackedSectorSymbol | '';
  topSectorVolumeShare: number | null;
  topSectorVolumeShareZ: number | null;
  spyPctOff52wHigh: number | null;
  spyWithin5PctOf52wHigh: boolean;
  growth20dReturn: number | null;
  value20dReturn: number | null;
  growthValueSpread: number | null;
  defensiveLeadActive: boolean;
  concentrationExtremeActive: boolean;
  regimeFlag: SectorRotationRegimeFlag;
  inputsPresent: number;          // bitmask, see below
  compositeVersion: 'sector_rot_v1';
}

export function computeSectorRotation(inputs: SectorRotationInputs): SectorRotationSnapshot;
```

**`inputsPresent` bitmask layout (6 bits):**

| bit | meaning |
|----:|---------|
| 0   | all 3 defensive returns present |
| 1   | all 3 cyclical returns present |
| 2   | all 11 sector volumes present |
| 3   | SPY context present (close + 52w high) |
| 4   | growth/value returns present |
| 5   | z-score baselines present |

A fully present snapshot = `0b111111` = `63`. The regime falls to `'unknown'` if bit 5 is 0 (no z baselines), or if bit 0/1 is 0 (return inputs missing), or if bit 3 is 0 (no SPY context — `defensiveLeadActive` cannot be evaluated).

**Why z-scores are inputs (not computed inside):** matches the `cycle_position.ts` and `vol_structure.ts` pattern. Z-score requires a trailing window of historical data; pure-function composite stays I/O-free and trivially testable. The repository handles the windowed baseline lookups.

---

## §7 · Test plan (Phase A)

- `sector_rotation.test.ts` (≥25 tests):
  - `defensive20dReturn` = mean of XLP/XLU/XLV; missing-input handling.
  - `cyclical20dReturn` = mean of XLY/XLK/XLF; missing-input handling.
  - `defensiveCyclicalSpread` arithmetic; null propagation.
  - `topSectorSymbol` argmax + volume-share arithmetic across all 11 sectors.
  - `spyWithin5PctOf52wHigh` boundary at exactly 5% off.
  - `growthValueSpread` arithmetic.
  - `defensiveLeadActive` AND-gate (both z>1.0 AND within 5% of high).
  - `concentrationExtremeActive` threshold (z>1.5).
  - `regimeFlag` priority-order table: every transition tested at boundary.
  - `inputsPresent` bitmask matches present-input set.
  - Composite version pin: `'sector_rot_v1'`.
- `sector_rotation_repository.test.ts` (≥15 tests):
  - `readLatestCloses` returns per-symbol latest close (subquery-around-FINAL pattern; a52c964 regression test).
  - `readTrailingCloses` / `readTrailingVolumes` returns windowed history.
  - Z-score baseline computation matches the `cycle_position_repository.ts` shape.
  - `readInputsForCycle` composes all reads into `SectorRotationInputs`.
  - Write + read round-trip; EXPLAIN PLAN clean.
- `migrateCreateSectorRotationSnapshots.test.ts` (≥10 tests):
  - DDL byte-pin, EXPECTED_COLUMNS pin, pre/post-check happy paths + missing-table path.
  - EXPLAIN PLAN check.
- `operatorBriefRender.test.ts` additions (≥7 tests in a `sector-rotation panel` describe block):
  - Section renders with snapshot; renders friendly "not yet evaluated" with null; renders each regime flag distinctly; section number is #9.
- `operatorBrief.test.ts` additions (≥3 tests for wiring):
  - Default fetcher returns null when CH returns nothing; builder maps a snapshot to the section; injection point lands at index 8 (zero-indexed).

Phase A target: existing baseline + ~60 new tests.

---

## §8 · Watch-outs

- **XLC was carved out 2018-09-24; XLRE on 2015-10-08.** Backfills earlier than those dates will have those tickers absent → `inputsPresent` bit 2 = 0 (sector volumes incomplete) → `regimeFlag` falls to `'unknown'`. The composite gracefully degrades.
- **SPDR sector ETFs have rebalances that briefly distort 20d returns** (e.g., REITs being added/removed). The 20d window is long enough that single-day rebalance jumps don't dominate, but a Phase B historical backtest should mask rebalance days if visible.
- **Volume share is sensitive to overall market volume.** During quiet markets, small absolute volumes can produce noisy share readings — gap doc §"Watch-outs" called this out. v1 does not apply a min-volume filter; if Phase B finds excess noise in low-volume regimes, add a daily minimum-$-volume floor before computing share.
- **"Defensives leading from highs" can fire false positives in low-volatility steady-uptrend regimes.** Gap doc §"Watch-outs". The `spyWithin5PctOf52wHigh` gate already filters out post-drawdown defensive leadership, but very mild defensive outperformance during a quiet uptrend (z just above +1.0) is the false-positive risk. Phase B independence test against `phase1_v3` `risk_off_rotation` will quantify this.
- **The composite is informational. Do not gate real-money decisions on `regimeFlag` directly.** Same posture as cycle-position and vol-structure. Promotion to a kill-switch input requires SPEC §4 Phase C + operator authorization.
- **`sector_rot_v1` is the version stamp.** Any change to thresholds (`DEFENSIVE_LEAD_Z_THRESHOLD`, `CONCENTRATION_EXTREME_Z_THRESHOLD`, `SPY_HIGH_PROXIMITY_THRESHOLD`), basket definitions (defensive / cyclical sector membership), or `regimeFlag` derivation requires a version bump. Stored snapshots remain queryable by version.

---

## §9 · What could break this

- **Yahoo Finance ticker rename / delisting.** Eleven SPDR sectors + IWF + IWD have been stable for 7-25 years; risk is low but non-zero. Mitigation: the YF ingest already logs per-ticker failures and continues with available ones.
- **Z-score baseline divergence over short windows.** With <252 trading days of baseline, z-scores can swing wildly. Fail-loud on `null` baseline rather than computing a misleading z.
- **Top-sector argmax instability.** If two sectors are within 0.5% of each other's 20d-avg-$-volume, the `topSectorSymbol` can flip day-to-day. v1 emits whichever is on top each day; downstream consumers should treat the symbol as informational, not as a stable label.
- **Indicator interactions with vol-structure.** `defensiveLeadActive` and vol-structure's `monotonic_backwardation` could both fire in a real stress regime; the two composites are NOT independent. Phase B independence test will surface this in the correlation matrix.

---

## §10 · Open questions

All locked at SPEC time:

1. ~~**S-SR-Q1 (data source / sector slicing)**~~ — LOCKED: Yahoo Finance + SPDR sector ETFs (S-SR-1).
2. ~~**S-SR-Q2 (integration mode)**~~ — LOCKED: informational-only in v1 (S-SR-2).
3. ~~**S-SR-Q3 (third indicator)**~~ — LOCKED: `rotation_dispersion_high` deferred until etf-flow-monitoring lands (S-SR-3).
4. ~~**S-SR-Q4 (dashboard panel)**~~ — LOCKED: not in v1 scope (S-SR-4).
5. ~~**S-SR-Q5 (factor ETFs)**~~ — LOCKED: SPDR sectors only; factor ETFs (MTUM, USMV, QUAL) rejected for v1 due to shorter history and weaker liquidity.

---

## §11 · Sequencing summary

| Phase | What | Duration | Blocks on |
|-------|------|----------|-----------|
| A | Substrate + brief panel | This beat | Nothing |
| B | Independence test + historical validation | After 60+ days of daemon snapshots OR via a historical backfill of pre-2026 sector-rotation | Phase A complete |
| C | Promotion to direct classifier category | Open | Phase B passes AND operator green-lights |

Phase A is autonomous-safe per the cycle-position + vol-structure templates. Phase B + C are operator-gated.
