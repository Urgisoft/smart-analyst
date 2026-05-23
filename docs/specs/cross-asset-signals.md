---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
slice_id: gap-cross-asset
---

# SPEC — Cross-Asset Signal Integration (cross_asset_v1)

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-19 · **Author:** Claude (Vector Core principal engineer) · **Phase:** 9-gap unfreeze (gap #6) · **Authority:** [gap doc](../obsidian/gaps/cross-asset-signals.md), Ilmanen 2011 *Expected Returns*, Asness-Moskowitz-Pedersen 2013 *Value and Momentum Everywhere*
>
> **Stage in Vector Core build:** SPEC → CODE (Phase A only — informational substrate). Phase B (independence test + historical validation) deferred per the cycle-position / vol-structure / sector-rotation precedent.
>
> **Lineage:** The fourth Phase-9-gap Layer-0 informational composite, after `cycle_v1` (s85), `vol_struct_v1` (s86), `sector_rot_v1` (s87). Same architectural template: SPEC → A1 (ingest extension) → A2 (pure composite + tests) → A3 (CH snapshot table) → A4 (repository + daemon hook) → A5 (morning brief section).

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the Layer-0 informational substrate with cross-asset stress detection. `phase1_v3` reads broad-market and credit indicators that are equity-derived; this composite reads currency, real-rate, commodity, and credit-internals dynamics to surface stress regimes that show up in non-equity markets before equity classifiers fire.
2. Emit five binary flags (one per indicator type) + a discrete `regimeFlag` with severity-ordered priority. The composite is **informational only in v1** — does NOT fire a `phase1_v3` category (S-CA-2 lock).
3. Persist daily snapshots to `quantlab.cross_asset_snapshots` so the brief and (eventually) Phase B independence tests can read history.
4. Surface a section in the morning operator brief (section #10, appended last to preserve byte-equal-stdout protection on sections #1-#9).

**Non-goals:**

1. No `phase1_v3` modification. The composite does NOT add a category, does NOT change `regimeRedDays30`, does NOT alter the existing classifier's union-count math.
2. No dashboard React panel in v1 (carry from S-VOL-4 and S-SR-4 — operator attention budget is finite; the `/#/cycle-position` route already absorbs Layer-0 informational attention).
3. No Phase B validation in v1 (carry from cycle-position lesson — ship informational first, validate after 60+ days or via a dedicated backfill arc).
4. No agricultural commodities (corn, wheat). Gap doc open question deferred — the v1 commodity signal is copper/gold ratio + broad-commodity ETF, which the canon (Ilmanen ch. 14) treats as the primary growth/inflation indicator pair.
5. No options-implied or vol-surface inputs. Vol-structure (s86) already owns that domain.

---

## §2 · Decisions (locked at SPEC time)

| ID | Decision | Rationale |
|----|----------|-----------|
| **S-CA-1** | Data sources: FRED for rates/dollar/credit; YF for commodity ETFs + currency pairs. All free. | Consistency with existing ingest substrate (cycle-position + sector-rotation already use FRED; vol-structure + sector-rotation already use YF). No new operational debt. |
| **S-CA-2** | Composite is **informational only in v1**. Does NOT fire a `phase1_v3` category. | Same posture as `cycle_v1` / `vol_struct_v1` / `sector_rot_v1`. Rollback-safe; promotion to classifier input gates on Phase B independence test + new SPEC. |
| **S-CA-3** | Five binary indicator flags: `dxy_strength`, `real_rate_spike`, `commodity_growth_collapse`, `credit_internals_divergence`, `curve_distortion`. | Direct extraction of the four gap-doc candidates + a fifth (credit-internals) operationalized as HY-OAS minus BAA-spread divergence — both inputs already in FRED. |
| **S-CA-4** | Regime-flag derivation: priority-ordered binary disjunction with `'severe_cross_asset_stress'` for 2+ flags active, else single-flag label, else `'normal'`, else `'unknown'`. | Mirrors the sector-rotation pattern (S-SR-Q2). Each flag is its own threshold-pinned binary; the regime label is the disjunction with severity ordering, not a weighted sum. Cycle-position's equal-weight-diluted-leading-signals lesson honored. |
| **S-CA-5** | Currency: DXY via FRED `DTWEXBGS` (broad index). USDJPY + EURUSD via YF for context only — not flag-gated. | DTWEXBGS is the canonical broad dollar index and is already free on FRED. USDJPY/EURUSD are kept as informational measurements so the brief can show them, but the flag uses only DXY to avoid double-counting. |
| **S-CA-6** | Commodities: copper proxy via YF `COPX` (copper-miners ETF); gold via YF `GLD`. Copper/Gold ratio is the flag input. Broad-commodity ETF `DBC` and oil `USO` are informational measurements. | YF spot copper (`HG=F`) is futures-only and has thin history; `COPX` is the practitioner standard ETF proxy. Same reasoning for gold (`GLD` over `GC=F`). |
| **S-CA-7** | Real rates: FRED `DFII10` (10-year TIPS). 20-day change > +50bps fires `real_rate_spike` (gap doc threshold). `DFII5` is informational only. | 10y TIPS is the canonical duration-asset discount rate signal (Ilmanen ch. 3). 5y is kept for the brief but doesn't add an independent flag. |
| **S-CA-8** | Curve distortion: count of inverted spreads among (T10Y2Y, T10Y3M). Flag fires when both ≤ 0. | Both spreads already in FRED. `T10Y3M` is the Estrella-Mishkin primary recession signal (already used by cycle-position); `T10Y2Y` is the legacy signal. Both inverted = curve distortion across multiple tenors per gap doc. |
| **S-CA-9** | Credit internals: z-score of (HY-OAS − BAA-spread) against trailing 2y baseline. Flag fires when z > +1.5. | Both inputs already in FRED. The differential captures when HY widens faster than IG — risk-off through the credit stack. 2y baseline mirrors `claims4wMaZscore` (cycle-position §3). |
| **S-CA-10** | Composite version: `cross_asset_v1`. Bumps on any threshold / basket / regime-flag-priority change. | Same versioning discipline as `cycle_v1` / `vol_struct_v1` / `sector_rot_v1`. Stored snapshots remain queryable by version. |
| **S-CA-11** | Daemon hook: step 1g (after step 1f sector-rotation). Non-fatal posture — failure logs an info-level anomaly and continues. | Mirrors step 1e / 1f. Layer-0 informational composites are never load-bearing for the daemon's main classifier path. |

---

## §3 · Component diagram

```
 ┌─ FRED ingest (npm run fred:ingest) ─────────────────────────────────┐
 │  DTWEXBGS (NEW)  DFII10 (NEW)  DFII5 (NEW)                          │
 │  T10Y2Y (exist) T10Y3M (exist) BAA10Y (exist) BAMLH0A0HYM2 (exist)  │
 └──────────────────────────────┬──────────────────────────────────────┘
                                ▼
                       quantlab.macro_indicators_fred
                                │
 ┌─ YF ingest (npm run macro:ingest) ──────────────────────────────────┐
 │  GLD (NEW)  COPX (NEW)  USO (NEW)  DBC (NEW)                        │
 │  JPY=X (NEW)  EURUSD=X (NEW)                                        │
 │  Existing: VIX/HYG/SPY/SPDR sectors/IWF/IWD                         │
 └──────────────────────────────┬──────────────────────────────────────┘
                                ▼
                          quantlab.candles
                                │
                                ▼
 ┌─ src/server/cross_asset_snapshots_repository.ts ──────────────────────┐
 │  readLatestSeriesValuesAsOf (FRED, subquery-around-FINAL)           │
 │  readSeries20dChange (FRED, computes Δ from N-day-lookback value)   │
 │  readLatestCloses (candles, subquery-around-FINAL)                  │
 │  readTrailingCloses (candles, 60d back; 20d return)                 │
 │  readTrailing2yCreditInternals (FRED, baseline for z-score)         │
 │  readInputsForCycle → CrossAssetSignalsInputs                       │
 │  writeSnapshot / loadLatestSnapshot                                 │
 └──────────────────────────────┬──────────────────────────────────────┘
                                ▼
 ┌─ src/server/cross_asset_signals.ts (pure) ──────────────────────────┐
 │  computeCrossAssetSignals(inputs) → CrossAssetSignalsSnapshot       │
 │    flags: dxyStrengthActive, realRateSpikeActive,                   │
 │           commodityGrowthCollapseActive,                            │
 │           creditInternalsDivergenceActive, curveDistortionActive    │
 │    regimeFlag (priority-ordered)                                    │
 │    inputsPresent bitmask                                            │
 │    compositeVersion = 'cross_asset_v1'                              │
 └──────────────────────────────┬──────────────────────────────────────┘
                                ▼
                quantlab.cross_asset_snapshots
                                │
                                ▼
 ┌─ scripts/daily_signal_daemon.ts step 1g ────────────────────────────┐
 │  runDaemonCrossAssetEvaluation({ repo, asOf })                      │
 │  Non-fatal — failure logs info anomaly, daemon continues.           │
 └──────────────────────────────┬──────────────────────────────────────┘
                                ▼
 ┌─ src/server/operator_brief.ts ──────────────────────────────────────┐
 │  fetchLatestCrossAssetFromCH (graceful-degrade null)                │
 │  buildCrossAssetSection(snapshot) → BriefCrossAssetSection | null   │
 │  composeMorningBrief writes brief.crossAsset                        │
 └──────────────────────────────┬──────────────────────────────────────┘
                                ▼
 ┌─ src/server/operator_brief_render.ts §10 ───────────────────────────┐
 │  renderCrossAssetSection (appended after section #9)                │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## §4 · Phased plan

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **A1** | Extend [`scripts/fred_ingest.py`](../../scripts/fred_ingest.py) DEFAULT_SERIES with `DTWEXBGS`, `DFII10`, `DFII5`. Extend [`scripts/macro_regime_ingest.py`](../../scripts/macro_regime_ingest.py) YF_TICKERS with `GLD`, `COPX`, `USO`, `DBC`, `JPY=X`, `EURUSD=X`. | SPEC'd here |
| **A2** | [`src/server/cross_asset_signals.ts`](../../src/server/cross_asset_signals.ts) — pure composite. Unit tests cover measurements + 5 flags + regime-flag priority order + inputsPresent bitmask + composite-version pin. | SPEC'd here |
| **A3** | [`scripts/migrate_create_cross_asset_snapshots.ts`](../../scripts/migrate_create_cross_asset_snapshots.ts) + DDL byte-pin test + EXPECTED_COLUMNS pin + EXPLAIN-PLAN grammar tests. | SPEC'd here |
| **A4** | [`src/server/cross_asset_snapshots_repository.ts`](../../src/server/cross_asset_snapshots_repository.ts) — repository + `runDaemonCrossAssetEvaluation` orchestration helper. Daemon step 1g wired into [`scripts/daily_signal_daemon.ts`](../../scripts/daily_signal_daemon.ts). | SPEC'd here |
| **A5** | Morning brief section #10 — `BriefCrossAssetSection` interface, `renderCrossAssetSection` function, `buildCrossAssetSection` builder, `fetchLatestCrossAssetFromCH` default fetcher, injection into `composeMorningBrief`. | SPEC'd here |
| **B (deferred)** | Independence test (correlation matrix vs `cycle_v1` / `vol_struct_v1` / `sector_rot_v1` / `phase1_v3` categories) + historical backfill + retune. | NOT in this beat |
| **C (deferred)** | Promotion to `phase1_v3` category. Gates on Phase B verdict + new SPEC. | NOT in this beat |

---

## §5 · Snapshot schema (CH DDL — byte-pinned in A3)

```sql
CREATE TABLE IF NOT EXISTS quantlab.cross_asset_snapshots
(
  snapshot_date Date,
  computed_at DateTime64(3),
  -- Currency
  dxy_close Nullable(Float32),
  dxy_20d_change_pct Nullable(Float32),
  usdjpy_close Nullable(Float32),
  usdjpy_20d_change_pct Nullable(Float32),
  eurusd_close Nullable(Float32),
  eurusd_20d_change_pct Nullable(Float32),
  -- Real rates
  real_rate_10y Nullable(Float32),
  real_rate_10y_20d_change_bps Nullable(Float32),
  real_rate_5y Nullable(Float32),
  -- Curve
  t10y2y Nullable(Float32),
  t10y3m Nullable(Float32),
  inverted_segment_count UInt8,
  -- Commodities
  gld_close Nullable(Float32),
  gld_20d_return Nullable(Float32),
  copx_close Nullable(Float32),
  copx_20d_return Nullable(Float32),
  copper_gold_ratio_20d_change_pct Nullable(Float32),
  uso_close Nullable(Float32),
  dbc_close Nullable(Float32),
  -- Credit internals
  hy_oas Nullable(Float32),
  baa10y Nullable(Float32),
  credit_internals_diff Nullable(Float32),
  credit_internals_diff_z Nullable(Float32),
  -- Flags
  dxy_strength_active UInt8,
  real_rate_spike_active UInt8,
  commodity_growth_collapse_active UInt8,
  credit_internals_divergence_active UInt8,
  curve_distortion_active UInt8,
  active_flag_count UInt8,
  -- Regime
  regime_flag LowCardinality(String),
  inputs_present UInt8,
  composite_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192
```

---

## §6 · Function signatures (pinned)

### Composite (pure)

```ts
export const CROSS_ASSET_COMPOSITE_VERSION = 'cross_asset_v1' as const;

export type CrossAssetRegimeFlag =
  | 'severe_cross_asset_stress'      // 2+ flags active
  | 'dollar_shock'                   // only dxy_strength active
  | 'real_rate_spike'                // only real_rate_spike active
  | 'commodity_growth_collapse'      // only commodity flag active
  | 'credit_internals_divergence'    // only credit-internals flag active
  | 'curve_distortion'               // only curve flag active
  | 'normal'                         // no flags active
  | 'unknown';                       // required inputs missing

// Thresholds (SPEC §2 locks; bump composite version on change).
export const DXY_STRENGTH_THRESHOLD_PCT          = 0.03;   // +3% 20d
export const REAL_RATE_SPIKE_THRESHOLD_BPS       = 50;     // +50bps 20d
export const COMMODITY_GROWTH_COLLAPSE_THRESHOLD = -0.05;  // -5% 20d on copper/gold
export const CREDIT_INTERNALS_Z_THRESHOLD        = 1.5;    // +1.5σ on HY-IG diff
export const CURVE_DISTORTION_MIN_INVERTED       = 2;      // both T10Y2Y + T10Y3M inverted

// Bitmask flags.
export const INPUT_DXY                  = 1 << 0;
export const INPUT_REAL_RATES           = 1 << 1;
export const INPUT_CURVE_SEGMENTS       = 1 << 2;
export const INPUT_COMMODITIES          = 1 << 3;
export const INPUT_CREDIT_INTERNALS_Z   = 1 << 4;
export const INPUT_CONTEXTUAL_CURRENCY  = 1 << 5; // USDJPY + EURUSD; informational

export interface CrossAssetSignalsInputs {
  asOf: Date;
  // Currency
  dxyClose: number | null;
  dxy20dChangePct: number | null;
  usdjpyClose: number | null;
  usdjpy20dChangePct: number | null;
  eurusdClose: number | null;
  eurusd20dChangePct: number | null;
  // Real rates
  realRate10y: number | null;
  realRate10y20dChangeBps: number | null;
  realRate5y: number | null;
  // Curve
  t10y2y: number | null;
  t10y3m: number | null;
  // Commodities
  gldClose: number | null;
  gld20dReturn: number | null;
  copxClose: number | null;
  copx20dReturn: number | null;
  copperGoldRatio20dChangePct: number | null;
  usoClose: number | null;
  dbcClose: number | null;
  // Credit internals
  hyOas: number | null;
  baa10y: number | null;
  creditInternalsDiff: number | null;
  /** Z-score of (HY-OAS − BAA-spread) vs trailing 2y baseline. */
  creditInternalsDiffZ: number | null;
}

export interface CrossAssetSignalsSnapshot {
  asOf: Date;
  // Currency pass-through
  dxyClose: number | null;
  dxy20dChangePct: number | null;
  usdjpyClose: number | null;
  usdjpy20dChangePct: number | null;
  eurusdClose: number | null;
  eurusd20dChangePct: number | null;
  // Real rates pass-through
  realRate10y: number | null;
  realRate10y20dChangeBps: number | null;
  realRate5y: number | null;
  // Curve
  t10y2y: number | null;
  t10y3m: number | null;
  invertedSegmentCount: number;
  // Commodities pass-through
  gldClose: number | null;
  gld20dReturn: number | null;
  copxClose: number | null;
  copx20dReturn: number | null;
  copperGoldRatio20dChangePct: number | null;
  usoClose: number | null;
  dbcClose: number | null;
  // Credit
  hyOas: number | null;
  baa10y: number | null;
  creditInternalsDiff: number | null;
  creditInternalsDiffZ: number | null;
  // Flags
  dxyStrengthActive: boolean;
  realRateSpikeActive: boolean;
  commodityGrowthCollapseActive: boolean;
  creditInternalsDivergenceActive: boolean;
  curveDistortionActive: boolean;
  activeFlagCount: number;
  regimeFlag: CrossAssetRegimeFlag;
  inputsPresent: number;
  compositeVersion: typeof CROSS_ASSET_COMPOSITE_VERSION;
}

export function computeCrossAssetSignals(
  inputs: CrossAssetSignalsInputs,
): CrossAssetSignalsSnapshot;
```

### Repository

```ts
export class CrossAssetSignalsRepository {
  async readLatestSeriesValuesAsOf(asOf: Date, seriesIds: readonly string[]): Promise<Map<string, number>>;
  async readSeriesValueOnOrBefore(asOf: Date, seriesId: string): Promise<number | null>;
  async readSeries20dChangeBps(asOf: Date, seriesId: string): Promise<number | null>;
  async readLatestCloses(asOf: Date, addrs: readonly string[]): Promise<Map<string, number>>;
  async readTrailingClose(asOf: Date, addr: string, daysAgo: number): Promise<number | null>;
  async readCreditInternalsBaseline(asOf: Date, days: number): Promise<number[]>;
  async readInputsForCycle(asOf: Date): Promise<CrossAssetSignalsInputs>;
  async writeSnapshot(snapshot: CrossAssetSignalsSnapshot): Promise<void>;
  async loadLatestSnapshot(): Promise<CrossAssetSignalsSnapshot | null>;
}

export async function crossAssetSnapshotsTableExists(ch?: ClickHouseClient): Promise<boolean>;

export async function runDaemonCrossAssetEvaluation(opts: {
  repo: CrossAssetSignalsRepository;
  asOf: Date;
}): Promise<{
  snapshot: CrossAssetSignalsSnapshot;
  inputs: CrossAssetSignalsInputs;
  summaryLine: string;
}>;
```

### Brief

```ts
export interface BriefCrossAssetSection {
  evaluatedAt: string;
  snapshotDate: string;
  regimeFlag: CrossAssetRegimeFlag;
  activeFlagCount: number;
  dxy20dChangePct: number | null;
  realRate10y20dChangeBps: number | null;
  copperGoldRatio20dChangePct: number | null;
  creditInternalsDiffZ: number | null;
  invertedSegmentCount: number;
  dxyStrengthActive: boolean;
  realRateSpikeActive: boolean;
  commodityGrowthCollapseActive: boolean;
  creditInternalsDivergenceActive: boolean;
  curveDistortionActive: boolean;
  inputsPresent: number;
  compositeVersion: typeof CROSS_ASSET_COMPOSITE_VERSION;
}

export function buildCrossAssetSection(snapshot: CrossAssetSignalsSnapshot | null): BriefCrossAssetSection | null;
```

---

## §7 · Test plan (byte-pin where possible)

### A2 composite tests (pure)

- All-null inputs → `regimeFlag = 'unknown'`, all flags false, `inputsPresent = 0b000000`.
- All inputs present, no thresholds crossed → `regimeFlag = 'normal'`, all flags false.
- Single-flag isolation (one per flag): exactly that flag active → regime label matches single-flag bucket.
- Multi-flag active (2 flags) → `regimeFlag = 'severe_cross_asset_stress'`.
- Multi-flag active (3+) → `regimeFlag = 'severe_cross_asset_stress'`.
- Threshold-edge tests: each flag input at `(threshold − epsilon)` does NOT activate; `(threshold + epsilon)` activates.
- Curve distortion: only T10Y2Y inverted → flag false. Both inverted → flag true.
- Credit internals: z exactly at +1.5 → flag false (strict >). z > +1.5 → true.
- Inputs partial: missing only `dxyClose` → `dxyStrengthActive = false`, regime falls through; other flags evaluate normally; `INPUT_DXY` bit = 0.
- Composite version pin: snapshot.compositeVersion === 'cross_asset_v1'.
- `activeFlagCount` matches the sum of booleans.

### A3 migration tests

- PLANNED_DDL byte-equal pin.
- EXPECTED_COLUMNS pin (28 columns).
- EXPLAIN PLAN smoke tests for the pre-check + post-check queries (skipped when CH down).

### A4 repository tests

- `readLatestSeriesValuesAsOf` returns expected map; subquery-around-FINAL pattern present in EXPLAIN PLAN.
- `readSeries20dChangeBps` computes correctly across simulated daily series.
- `readLatestCloses` for candle addresses.
- `readTrailingClose` 20-day-back lookup.
- `readCreditInternalsBaseline` returns sorted daily HY-IG diff prints.
- `readInputsForCycle` composes a populated `CrossAssetSignalsInputs`.
- `writeSnapshot` round-trips through `loadLatestSnapshot`.
- `runDaemonCrossAssetEvaluation` happy-path + repo-throw → propagation (daemon-side wraps non-fatal).
- `crossAssetSnapshotsTableExists` true/false.

### A5 brief tests

- `buildCrossAssetSection(null)` returns null.
- `buildCrossAssetSection(snapshot)` mirrors all fields.
- `renderCrossAssetSection` null snapshot → "not yet evaluated" message.
- `renderCrossAssetSection` populated snapshot → section header reads regime upper-case + indicator table with reading bands.
- Section #10 appended last; sections #1-#9 byte-equal.
- 3 wiring tests in `operatorBrief.test.ts` (default fetcher null → snapshot, stub → matches, error → null).

---

## §8 · Watch-outs

1. **DFII10/DFII5 history.** FRED TIPS series start 2003-01-02 (10y) / 2003-12-31 (5y). Backfills earlier than those dates will have `INPUT_REAL_RATES = 0` → real_rate flag false (silent) but `inputsPresent` bit 1 = 0 → regime can still resolve from other flags. Intended graceful-degrade.
2. **COPX inception 2009-11-19.** Copper-miners ETF didn't exist before. Backfills earlier set `copx*` to null → commodity flag silent; regime falls through. Same posture as XLC/XLRE in sector-rotation.
3. **DBC inception 2006-02-03; USO inception 2006-04-10.** Both contextual (not flag-gated), but missing values render as "—" in the brief.
4. **Currency YF symbols are exchange-traded crosses, not spot rates.** `JPY=X` is technically USDJPY at YF's data vendor; `EURUSD=X` is EURUSD. Both update in 24/7 fashion but daily candles are valid for 20d-change comparisons. Same precision posture as the existing YF candles substrate.
5. **DTWEXBGS is weekly-released in some FRED revisions.** The broad dollar index can lag by a few days. The repository's `readSeriesValueOnOrBefore` returns the most recent print on-or-before `asOf` — same posture as `readLatestSeriesValuesAsOf` in cycle-position. No SLA on freshness; staleness is handled gracefully.
6. **HY OAS (BAMLH0A0HYM2) history is FRED-capped.** Cycle-position §3 documents this: BAMLH0A0HYM2 history may be limited to ~3 years on the free endpoint. Credit-internals z-score requires 2y baseline; on a fresh ingest the flag stays silent until enough history accumulates.
7. **Credit-internals z-score baseline boundary.** 2y baseline; `MIN_Z_BASELINE = 30` daily prints. First ~30 trading days after a fresh ingest return null → flag silent. After 30 days the z fires; FIRST few weeks of post-enablement flags may be biased toward the early calibration window.
8. **Cross-asset composite IS correlated with cycle-position by construction.** Both use T10Y2Y and T10Y3M. Phase B independence test will surface this; Phase C promotion (if ever) must explicitly handle the overlap (the curve flag may be redundant once both ship).
9. **Cross-asset composite IS correlated with phase1_v3's `credit_stress` category by construction.** Both use BAA10Y + BAMLH0A0HYM2. Same Phase B caveat as above.
10. **`cross_asset_v1` is the version stamp.** Any change to thresholds, basket membership, ETF substitution (e.g., replacing COPX with a different copper proxy), regime-flag derivation order, or z-baseline window requires a version bump.
11. **All repository reads use subquery-around-FINAL pattern (a52c964 fix class).** Tests pin the shape — a "simplifying" refactor that flattens any read query will fail. Same rule as the three prior composites.
12. **Daemon hook is non-fatal.** A repository throw logs an info anomaly and the daemon continues. The brief section gracefully degrades to "not yet evaluated" when no snapshot exists.

---

## §9 · What could break this

- **FRED ingest stale.** If `npm run fred:ingest` hasn't run for the daemon's asOf date, the latest read returns yesterday's (or older) value. The 20-day-change computation degrades but doesn't fail.
- **YF currency tickers renamed.** YF has historically renamed `JPY=X` and similar tickers. The per-ticker error handling in `macro_regime_ingest.py` is non-fatal — a renamed ticker logs a warning and the composite's currency flag goes silent.
- **TIPS yield convention drift.** DFII10 is quoted as a percentage. The 20-day-change computation is in basis points (multiply by 100). A future FRED format change to decimal would silently break the threshold. Threshold-edge tests catch this.
- **Copper/gold ratio sign convention.** `copperGoldRatio20dChangePct < -0.05` fires the flag (copper falling vs gold = growth weakness). A future inverted-ratio refactor would flip the flag's polarity. The test suite pins the inequality direction.
- **Brief section #10 appended last.** Same byte-equal-protection pattern as sections #7/#8/#9. A future mid-brief insertion would shift section numbering — must go BEFORE section #7, not displacing existing sections.
- **Cross-asset composite is informational, not gating.** Do not gate real-money decisions on `regimeFlag` directly. Phase B independence test + new SPEC required for any phase1_v3 promotion (S-CA-2 lock).

---

## §10 · Open questions

1. **USDJPY vs DXY for US tech specifically.** Gap doc open question — DXY is broad; USDJPY is the carry-trade unwind proxy. v1 keeps both as informational; the flag uses DXY. If Phase B shows USDJPY adds independent signal, a `cross_asset_v2` adds a `carry_unwind` flag.
2. **Agricultural commodities (corn, wheat) for inflation regime.** Gap doc open question. Deferred — DBC already captures broad commodity exposure; carving out agriculturals adds a flag with thin canon (Ilmanen doesn't separate agriculturals from energy/metals).
3. **Real rates vs nominal rates.** Gap doc open question. v1 uses real rates (DFII10) for the spike flag because the canon (Ilmanen ch. 3) is clear that real rates drive duration-asset discount rates. Nominal rates are already in the cycle-position composite (DGS10).
4. **Single-flag-bucket priority order.** Currently arbitrary (dxy > real_rate > commodity > credit > curve). If operator observation shows one stress mode is more actionable than another, the order can be re-tuned in `cross_asset_v2`.

---

## §11 · Sequencing

Same template as s85/s86/s87:

1. SPEC (this document — done).
2. A1 ingest extension (1 PR worth of file edits; YF + FRED scripts).
3. A2 pure composite + tests (~40 tests target).
4. A3 migration script + tests (~20 tests target).
5. A4 repository + daemon hook + tests (~30 tests target).
6. A5 brief section + tests (~10 tests target — 7 render + 3 wiring).
7. Tests/tsc/check:help all green; brief renders "not yet evaluated" until operator applies the migration + runs `daemon:daily`.
8. HANDOFF.md rewritten.

**Phase B / Phase C NOT in this beat.** Same posture as prior composites — operator-gated.
