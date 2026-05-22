---
status: deferred
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: adr
slice_id: adr-017
---

# SPEC — ADR-017 meta-labeling pipeline

**Authority:** [ADR-017](../decisions/README.md#adr-017--meta-labeling-ldp-afml-ch-3-as-the-strategy-family-expansion-path-cell-agnostic-pipeline-first-applied-to-trend_v1mcap_nano1dp5)
is the design decision; this file is the function-level contract. If the
SPEC contradicts the ADR, the ADR wins and the SPEC is wrong; flag it.

**Date:** 2026-05-04 · **Status:** Drafted, ready for CODE.

---

## 1. Module map

```
src/lib/metaLabeling/
  tripleBarrier.ts       § 2  vol-scaled triple-barrier labeler
  features.ts            § 3  signal-time-only feature builder
  purgedKFold.ts         § 4  AFML §7.4 purged k-fold + embargo
  runMeta.ts             § 5  runtime: load M2, gate signals, drive triple-barrier exits
scripts/
  build_meta_train_set.ts § 6  TS — run M1 cell-wide, build features+labels, persist
  train_meta_label.py     § 7  Python — load training table, train M2, persist artifact
src/server/clickhouse.ts
  ensureMetaLabelingTables  § 8  idempotent schema for meta_train_trades + meta_models
scripts/tests/
  metaLabelingTripleBarrier.test.ts        § 9.1
  metaLabelingFeatures.test.ts             § 9.2
  metaLabelingFeatureLeakage.test.ts       § 9.3  (the audit that any future feature must pass)
  metaLabelingPurgedKFold.test.ts          § 9.4
  metaLabelingBuildTrainSet.test.ts        § 9.5  (integration smoke)
```

The Python training script is intentionally one-shot per cell — no daemon,
no API. Inputs and outputs are CH tables. ADR-003 compliance.

---

## 2. `tripleBarrier.ts`

Vol-scaled triple-barrier labels per LdP AFML §3.1.

### 2.1 Public surface

```ts
export interface TripleBarrierConfig {
  /** PT distance in units of ATR_pct. Default 2.0. */
  kPt: number;
  /** SL distance in units of ATR_pct. Default 1.0. */
  kSl: number;
  /** Vertical (max-holding) horizon in bars. Caller passes the cell's
   *  empirical median holding period; this module does not compute it. */
  verticalBars: number;
  /** ATR window in bars. Default 20 (LdP examples). */
  atrWindow: number;
}

export interface TripleBarrierLabel {
  /** Index into `candles` of the entry bar. */
  entryIdx: number;
  /** Index into `candles` of the exit bar. Equal to entryIdx + bars_to_exit. */
  exitIdx: number;
  /** Realized PT% used at signal time = kPt × ATR_pct(entryIdx). */
  ptPct: number;
  slPct: number;
  /** Number of bars held; bounded by verticalBars. */
  barsToExit: number;
  /** Which barrier triggered the exit. */
  barrierHit: 'pt' | 'sl' | 'vertical';
  /** Realized PnL% at exit = (exit_close − entry_close) / entry_close × 100,
   *  signed for a long-only entry (sell at exit_close). */
  pnlPctRealized: number;
  /** Binary label per LdP §3.1: 1 if `barrierHit === 'pt'`, else 0.
   *  Vertical exits at break-even or worse all label 0. */
  label: 0 | 1;
}

/** Compute triple-barrier labels for a list of long-only entry signals on a
 *  candle stream. Each `entryBarIdx` must be < candles.length − 1; signals
 *  that can't fit a 1-bar minimum hold are dropped (returned in `dropped`).
 *
 *  Caller responsibilities:
 *    - candles are pre-sorted by ts ascending, no gaps within the slice
 *    - entryBarIdxs are integers, monotonically non-decreasing
 *    - verticalBars ≥ 1
 *
 *  Edge cases handled inside:
 *    - entryIdx + verticalBars > candles.length → vertical pulled in to last bar
 *    - ATR_pct undefined (atrWindow bars not yet available at entry) → drop signal
 *    - candle high == low (zero-range bar) → still valid; PT/SL just don't trigger
 *    - PT and SL hit on the same bar → SL wins (canonical conservative call,
 *      mirrors LdP's "barrier-hitting tie goes to the less favorable") */
export function labelTrades(
  candles: Candle[],
  entryBarIdxs: number[],
  cfg: TripleBarrierConfig,
): {
  labels: TripleBarrierLabel[];
  dropped: { entryIdx: number; reason: 'no_atr' | 'past_end' }[];
};
```

### 2.2 ATR_pct computation

`atrPct(idx) = ATR(idx, atrWindow) / candles[idx].close`, where `ATR` is the
standard Wilder's average true range. Reuse `src/lib/indicators.ts`'s ATR
helper if it exists; otherwise inline a Wilder-EMA implementation. ATR is
defined for `idx ≥ atrWindow`; before that the helper returns `NaN` and the
signal is dropped.

### 2.3 Failure modes

- All signals dropped → `labels.length === 0`, `dropped.length === entryBarIdxs.length`.
  Caller must handle gracefully (no crash, just no training data from this token).
- `kPt < kSl` is allowed (bias toward closing winners early); not a special case.
- Negative `kPt` or `kSl` is a programming error; throw at the top of the function.

---

## 3. `features.ts`

Signal-time-only feature builder. Every feature is a function of `candles[0..signalIdx]`
and `btcContext[0..signalCalendarTime]`. **No bar after `signalIdx` is touched.**

### 3.1 Public surface

```ts
export interface FeatureRow {
  /** Token-level identifier; passed through. */
  tokenAddress: string;
  /** Index into the input candles. */
  signalIdx: number;
  /** Calendar time of the signal bar (ms since epoch). */
  signalTs: number;
  /** Feature name → numeric value. NaN for any feature undefined at signalIdx
   *  (e.g. trailing-window not yet warm). Caller decides whether to drop. */
  features: Record<string, number>;
}

export interface BtcContext {
  /** BTC daily candles aligned to UTC dates, ascending order. Used for
   *  market-regime features. The cell-builder fetches once and shares
   *  across all tokens. */
  daily: Candle[];
}

/** Build the v0 feature row for each (candles, signalIdx) pair.
 *
 *  v0 feature names (must match exactly — they're persisted as-is):
 *    vol_pct_30, vol_pct_90,
 *    btc_mom_30, btc_vol_pct_90,
 *    bars_since_first_seen, tok_volume_pct_90,
 *    m1_hit_rate_20, m1_pnl_mean_20, m1_signal_strength
 *
 *  m1_hit_rate_20 / m1_pnl_mean_20 require the caller to pass M1's prior
 *  closed trades (those exiting at or before each signalIdx). The caller
 *  is responsible for providing them in the priorTrades arg — the feature
 *  builder is otherwise stateless across signals.
 *
 *  m1_signal_strength is a function of the bar at signalIdx only, plus
 *  the strategy's param. The function signature accepts emaFastPeriod and
 *  emaSlowPeriod so it works for trend_v1 (param × 1, param × 3 per
 *  src/lib/indicators.ts) and any future EMA-crossover bundle that lands. */
export function buildFeatures(
  args: {
    tokenAddress: string;
    candles: Candle[];
    signalIdxs: number[];
    btc: BtcContext;
    priorTrades: { exitIdx: number; pnlPct: number }[];
    emaFastPeriod: number;
    emaSlowPeriod: number;
  },
): FeatureRow[];
```

### 3.2 Per-feature definitions

| name | formula at signalIdx i |
|------|------------------------|
| `vol_pct_30` | percentile rank of `atrPct(j)` for j in [i−30, i] within that 31-element window; 0..1 |
| `vol_pct_90` | percentile rank of `atrPct(j)` for j in [i−90, i] within window; 0..1 |
| `btc_mom_30` | `sign(btc.daily[d].close − btc.daily[d−30].close)` where d is the most recent btc.daily index ≤ candles[i].ts; ∈ {−1, 0, +1} |
| `btc_vol_pct_90` | percentile rank of BTC daily realized vol in trailing 90 daily bars; 0..1 |
| `bars_since_first_seen` | `log(1 + i)` |
| `tok_volume_pct_90` | percentile rank of `candles[j].volume` for j in [i−90, i]; 0..1 |
| `m1_hit_rate_20` | `priorTrades.filter(t => t.exitIdx ≤ i).slice(-20)` → fraction with `pnlPct > 0`; NaN if window < 5 trades |
| `m1_pnl_mean_20` | same window → mean of `pnlPct`; NaN if window < 5 trades |
| `m1_signal_strength` | `(emaFast(i) − emaSlow(i)) / atrPct(i) / candles[i].close`; NaN if ATR undefined |

### 3.3 Audit: feature leakage shuffle test

Tested by `metaLabelingFeatureLeakage.test.ts` — see § 9.3. The contract
the audit enforces is exactly: shuffle bars after `signalIdx`, all feature
values at `signalIdx` must be bitwise identical. Any future feature added
to v1+ must pass the same audit before merging.

---

## 4. `purgedKFold.ts`

Cross-validation split per LdP AFML §7.4.

### 4.1 Public surface

```ts
export interface KFoldRow {
  /** Time of the signal — used for ordering rows. */
  signalTs: number;
  /** Time of the trade's exit — used to detect label-window overlap. */
  exitTs: number;
}

export interface KFoldSplit {
  trainIdxs: number[];
  testIdxs: number[];
}

/** Purged k-fold split.
 *
 *  Steps per AFML §7.4:
 *    1. Sort rows by signalTs ascending.
 *    2. Partition into k equal-sized contiguous folds (last fold absorbs remainder).
 *    3. For fold i used as test: training = rows from folds j ≠ i, MINUS:
 *       a. PURGE: any training row whose [signalTs, exitTs] overlaps any test row's
 *          [signalTs, exitTs]. Both endpoints inclusive.
 *       b. EMBARGO: also drop any training row whose signalTs is within
 *          embargoMs after the latest exitTs in the test fold. embargoMs is
 *          caller-supplied (recommended: max test-fold vertical-barrier × 1.5).
 *
 *  Precondition: rows.length ≥ k × 2 (need at least 2 rows per fold to
 *  produce a non-trivial split). Throws if precondition violated.
 *
 *  Property: after purging+embargo, no training row's label window touches
 *  any test row's label window. The test asserts this directly. */
export function purgedKFoldSplit(
  rows: KFoldRow[],
  k: number,
  embargoMs: number,
): KFoldSplit[];
```

### 4.2 Edge cases

- All rows have the same signalTs (e.g., synchronized cross-sectional entries)
  → folds split arbitrarily but deterministically by input order; embargo
  may zero-out some training folds. Caller checks `trainIdxs.length === 0`
  and skips that fold.
- `embargoMs === 0` is allowed but discouraged; emits a warning to stderr.
- `k === 1` is rejected (no held-out fold).

---

## 5. `runMeta.ts`

Runtime side. Loads a trained M2 artifact for a given cell and exposes a
gating function the engine calls at signal time.

### 5.1 Public surface

```ts
export interface MetaModelArtifact {
  cellKey: string;          // 'trend_v1|mcap_nano|1d|5'
  modelFamily: 'lightgbm' | 'xgboost' | 'rf';
  featuresUsed: string[];
  thresholdChosen: number;
  /** Opaque inference function reconstructed from the persisted blob.
   *  For lightgbm: deserialized booster's predict_proba returning P(label=1). */
  predictProba: (features: Record<string, number>) => number;
  /** Echo of `verticalBars` chosen at training, so the engine uses the same
   *  exit horizon at runtime as the labels were generated under. */
  verticalBars: number;
  kPt: number;
  kSl: number;
  atrWindow: number;
}

/** Load the latest meta_models row for a cell key. Returns null if no
 *  trained model exists yet (cell hasn't been meta-trained). */
export async function loadMetaModel(cellKey: string): Promise<MetaModelArtifact | null>;

/** True if M2 says take this trade. Pure function once the model is loaded. */
export function shouldTakeTrade(
  artifact: MetaModelArtifact,
  features: Record<string, number>,
): boolean;
```

### 5.2 Engine integration

`runStrategy` (in `src/lib/indicators.ts`) gets one new branch:

```
if (bundle.family === 'meta') {
  const artifact = await loadMetaModel(`${primaryBundle}|${tier}|${interval}|${param}`);
  if (artifact === null) throw new Error('meta cell with no trained model');
  // run primary signal generation as today
  // for each signal:
  //   features = buildFeatures.singleSignal(...)
  //   if (!shouldTakeTrade(artifact, features)) continue
  //   exit via tripleBarrier from this entry, NOT the primary's exit logic
}
```

The branch is the only place the rest of the engine sees the meta family;
all other code paths are unchanged.

### 5.3 Failure modes

- `loadMetaModel` finds a row but the blob fails to deserialize → throw with
  a clear `MetaModelLoadError` that includes the cell key. Don't silently
  fall back to non-meta; that would be undisclosed behavior change.
- A required feature is NaN at signal time → `shouldTakeTrade` returns
  `false` (conservative — don't trade when we can't grade). The cell-level
  scorer will see this as a reduced trade count, not as a silent error.

---

## 6. `build_meta_train_set.ts`

TypeScript orchestrator. One CLI invocation per cell.

### 6.1 CLI

```
npx tsx scripts/build_meta_train_set.ts \
  --strategy trend_v1 \
  --tier mcap_nano \
  --interval 1d \
  --param 5 \
  --kpt 2.0 \
  --ksl 1.0 \
  --vert auto      # 'auto' = use M1's empirical median; or an integer in bars
  --atr-window 20
  --split-pct 70   # mirrors batch_backtest split semantics
```

### 6.2 Steps

1. Resolve M1 bundle from `quantlab.strategies` by `--strategy`.
2. Load token universe matching `--tier` × `--interval` (reuse exact SQL
   from `loadTokenUniverse` in [batch_backtest.ts](../../scripts/batch_backtest.ts);
   factor into `loadUniverseByTier` in [src/server/clickhouse.ts](../../src/server/clickhouse.ts)
   if not yet shared — leave the duplicate in `_diagnose_trend_v1_meta_target.ts`
   as throw-away).
3. Fetch BTC daily candles once; build `BtcContext`.
4. For each token:
   a. Fetch candles (limit 2000, same as production).
   b. Walk-forward split per `--split-pct`.
   c. Run M1 on the training slice → get entry signals + prior-trade list.
   d. Run M1 on the OOS slice with knowledge of the train-slice prior trades
      (so M1 self-state features are correct at the IS/OOS boundary).
   e. For all entries: triple-barrier label, build features, classify slice.
5. Pool across tokens. Within the IS pool, split first 60% / last 40% by
   signalTs into `m2_train` / `m2_tune`. The OOS pool is `oos`.
6. Insert into `quantlab.meta_train_trades` as a single batch.
7. Print a summary: `n_train`, `n_tune`, `n_oos`, label balance per slice,
   per-token row counts (first 20).

### 6.3 Idempotency

Re-running with the same cell key + the same `--kpt --ksl --vert --atr-window`
overwrites by ReplacingMergeTree(created_at). Re-running with different
params writes new rows; `m1_run_sig` distinguishes (currently:
`SHA1(strategy|tier|interval|param|kpt|ksl|vert|atr_window)`). The training
script reads the latest `m1_run_sig` row per (cell, run) — there's one
artifact per parameterized run.

### 6.4 Failure modes

- Universe is empty (tier filter excluded everything) → exit 1 with a clear
  error.
- A token's IS slice produces 0 M1 entries → token contributes 0 rows; not
  fatal.
- Total IS rows < 50 → exit 1 with the diagnostic verdict ("not enough
  signal to train"); explicitly aligned with the diagnostic guard in
  `_diagnose_trend_v1_meta_target.ts`.

---

## 7. `train_meta_label.py`

Python trainer. One-shot per cell.

### 7.1 CLI

```
.venv/Scripts/python.exe scripts/train_meta_label.py \
  --cell-key 'trend_v1|mcap_nano|1d|5' \
  --m1-run-sig <sha1>            # which build_meta_train_set run to read
  --model-family lightgbm
  --hyperparam-grid default      # 'default' = small ~12-config grid; or path to yaml
  --threshold-grid '0.4,0.5,0.6,0.7,0.8'
  --cv-folds 5
  --embargo-bars auto            # 'auto' = vertical_bars × 1.5
  --random-state 42
```

### 7.2 Steps

1. Read `meta_train_trades` for `(cell_key, m1_run_sig)`. Materialize as a
   pandas DataFrame.
2. Three-way split by `slice` column.
3. On the `m2_train` slice:
   a. Purged k-fold split per § 4 (signalTs, exitTs columns). Embargo in
      ms = `embargo_bars × bar_size_ms_for_interval`.
   b. For each (hyperparams ∈ grid):
      - For each fold: train lightgbm on (k−1) folds, predict on held-out
        fold. Aggregate AUC across folds.
   c. Pick best hyperparams by mean fold AUC.
4. Re-train on full `m2_train` with best hyperparams.
5. On the `m2_tune` slice:
   a. Predict probabilities.
   b. For each `p* ∈ threshold_grid`:
      - Filter signals to those with `p_hat ≥ p*`.
      - Compute realized net % using `pnl_pct_realized` of kept trades
        (compounding equity per token in calendar-time order).
      - Record the resulting net %.
   c. Pick `p*` that maximizes net % AND keeps ≥ 100 OOS trades when
      applied to the OOS slice (the 100-trade guard from ADR-017 §8 is
      enforced here, not at the engine level — failing the guard means
      the row written to `meta_models` has `oos_kept_trades < 100` and the
      consumer ignores it).
6. Apply chosen (model + threshold) to the `oos` slice → record
   `oos_kept_trades`, `oos_kept_net_pct`, `auc_oos`.
7. Compute baseline: `m1_oos_net_pct` = compounded net of ALL signals in
   `oos` (M1 with no meta filter, but using the SAME triple-barrier exits
   so the comparison is apples-to-apples — not vs M1's native exits).
8. Persist one row to `quantlab.meta_models` with all metadata + the
   serialized model blob (lightgbm `Booster.model_to_string()` →
   base64).
9. Print a one-page summary.

### 7.3 `n_meta_trials` counting

Per ADR-017 §7, `n_meta_trials` = `|hyperparam_grid| × |threshold_grid|`,
persisted on the meta_models row. Downstream HLZ uses this when computing
the M for the meta cell.

### 7.4 Failure modes

- `m2_train` < 50 rows → exit 1.
- All folds collapse to one class (label imbalance is total) → log a clear
  message, persist the row with `auc_*` = NaN, threshold = 1.0 (= reject
  all). Consumer sees `oos_kept_trades = 0` and ignores it.
- lightgbm not installed → exit with a message pointing to
  `requirements.txt`.

---

## 8. `ensureMetaLabelingTables` in `clickhouse.ts`

Idempotent CREATE TABLE for the two new tables defined in ADR-017 §10.
Plus one `ALTER TABLE … ADD COLUMN IF NOT EXISTS` block for each, so future
schema additions can land without DROP. Wire into the existing
`ensureBacktestTables` call chain so it runs at server startup.

---

## 9. Test list

Each test name maps directly to a deliverable file in `scripts/tests/`.

### 9.1 `metaLabelingTripleBarrier.test.ts`

- TB-01 PT hit before SL → label=1, barrier_hit='pt', pnl ≈ kPt × atrPct
- TB-02 SL hit before PT → label=0, barrier_hit='sl', pnl ≈ −kSl × atrPct
- TB-03 vertical hit (no barrier touched) → label=0, barrier_hit='vertical', bars=verticalBars
- TB-04 PT and SL hit on same bar → SL wins (label=0)
- TB-05 entry too close to end of candles → vertical clamps to last bar
- TB-06 ATR undefined at entry (atrWindow not warm) → signal dropped
- TB-07 zero-range bars in the middle → no PT/SL trigger; vertical works
- TB-08 negative kPt → throws
- TB-09 input signals out of order → still produces correct labels per signal (function should sort internally OR document the contract; I commit to NOT sorting and the test asserts the contract)

### 9.2 `metaLabelingFeatures.test.ts`

- F-01 vol_pct_30 with constant ATR returns 0.5 (median rank)
- F-02 vol_pct_30 with monotonically increasing ATR returns 1.0 at each new high
- F-03 btc_mom_30 with rising BTC = +1, falling = −1, flat = 0
- F-04 m1_hit_rate_20 with 5 of 10 trades positive → 0.5; with 0 trades → NaN
- F-05 m1_signal_strength with ema_fast == ema_slow → 0
- F-06 unknown feature names not present in output (we only emit the contract list)
- F-07 NaN propagation: when ATR undefined, m1_signal_strength is NaN

### 9.3 `metaLabelingFeatureLeakage.test.ts`

The audit. Single test; if it fails, every feature is suspect.

- L-01 For 100 random (token, signalIdx) pairs: build features at signalIdx,
  then shuffle every bar AT INDEX > signalIdx, then re-build features at
  the same signalIdx. Assert all feature values are bitwise-identical
  (or NaN ↔ NaN).

### 9.4 `metaLabelingPurgedKFold.test.ts`

- KF-01 With non-overlapping label windows and embargoMs=0, output reduces
  to plain k-fold (test fold ⊂ rows, train fold = complement)
- KF-02 With overlapping label windows, training rows whose [signalTs, exitTs]
  overlap any test row are removed; assert no overlap remains
- KF-03 embargoMs > 0 removes training rows whose signalTs ≤ max(test exitTs) + embargoMs
- KF-04 k=1 throws
- KF-05 rows.length < k × 2 throws
- KF-06 deterministic output for fixed input (same input → same output)
- KF-07 sum of test fold sizes equals rows.length (every row appears as
  test exactly once)

### 9.5 `metaLabelingBuildTrainSet.test.ts`

Integration smoke. Uses a small fixture (3 tokens, 200 bars each, fake
strategy that fires every 20 bars).

- BT-01 Builder runs end-to-end; meta_train_trades populated
- BT-02 Slice column distribution matches expected (m2_train ≈ 42% × pool,
  m2_tune ≈ 28%, oos ≈ 30%)
- BT-03 Re-running with same args is idempotent (row count unchanged
  after second run)
- BT-04 Re-running with different kPt produces a new m1_run_sig and writes
  a new set of rows alongside the old

### 9.6 (No test file for `train_meta_label.py` in this SPEC)

The Python trainer's correctness is verified end-to-end via the integration
run on the target cell (CODE phase). lightgbm itself is battle-tested. If
unit testing the Python side becomes useful later, add `test_train_meta_label.py`
under `scripts/tests/`.

---

## 10. Acceptance gate for CODE → done

CODE phase is complete when:

1. All test files in §9 pass (TS via `npm test`, no Python tests yet).
2. End-to-end on the target cell:
   - `npx tsx scripts/build_meta_train_set.ts --strategy trend_v1 --tier mcap_nano --interval 1d --param 5` runs to completion and writes ≥ 1500 rows to `meta_train_trades` (sanity floor below the diagnostic's 1897-trade total).
   - `.venv/Scripts/python.exe scripts/train_meta_label.py --cell-key 'trend_v1|mcap_nano|1d|5' --m1-run-sig <emitted by step 1>` writes one row to `meta_models` with non-NaN auc_train and auc_oos.
3. The meta_models row's reported `lift_pct` is recorded — POSITIVE or NEGATIVE
   (the empirical answer is the deliverable; positive lift is not the
   acceptance gate).
4. HANDOFF.md rewritten with the empirical result (one of: "meta-labeling
   lifted OOS materially → next is paper deployment per ADR-008", "meta-
   labeling did not lift OOS → next is regime-filter ADR or different M1
   family").

---

## 11. Out of scope for this SPEC (carried to future ADRs)

- Sizing by `p_hat` (LdP §3.7) — v0 is binary gate only.
- Multi-cell joint training (one M2 trained across cells) — v0 is one M2
  per cell.
- Online M2 retraining as new bars arrive — v0 is one-shot retrain.
- Calibration (Platt / isotonic on `p_hat`) — v0 trusts lightgbm's
  raw probabilities.
- Cluster-axis adaptation (separate `meta_models` for cluster cells) — v0
  works on tier-axis cells; cluster-axis can reuse the same machinery
  with a different `cell_key` schema.
