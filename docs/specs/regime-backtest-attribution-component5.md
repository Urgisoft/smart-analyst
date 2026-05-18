# SPEC — Track C / Component 5: bt_runs ↔ macro_regimes attribution

> **Status:** DRAFT — produced from the 2026-05-10 RESEARCH+SPEC turn (session 37); SPEC stage output, no critic pass yet · **Author:** producer (Claude) · **Authority:** [HANDOFF "Next stage" — C-Component-5](../../.claude/HANDOFF.md), [ADR-037](../decisions/README.md), [Component 3 SPEC §1 non-goal](regime-dashboard-component3.md), [v_bt_runs_by_cluster precedent](../../src/server/clickhouse.ts)
>
> **Stage in Vector Core build:** SPEC. RESEARCH closed in the same turn. CODE follows.

This SPEC defines a sidecar attribution table `quantlab.bt_runs_regime` and the helpers that populate and query it, so historical backtest runs can be filtered/grouped by the macro regime that prevailed during their data window. No widening of `bt_runs`. No edits to the classifier or `macro_regimes` schema.

---

## 1. Goal and exit gate

**Goal.** Tag every backtest run with the regime distribution over its actual data window so the operator can answer four downstream decisions:

- **D1.** "Did this strategy survive in *red* regimes, or only in green?" — filter `bt_runs` by `dominant_regime` or by a minimum red-share threshold.
- **D2.** "How does this strategy's Sharpe split across regimes?" — group-by `dominant_regime`, aggregate `sharpe_ratio` / `oos_sharpe_ratio`.
- **D3.** "Is this run's headline metric driven by a single benign regime stretch?" — read `regime_distribution` Map directly; flag runs whose dominant share > some threshold.
- **D4.** "Once `phase1_v3` lands, which `bt_runs` rows are attributed under the biased `phase1_v2` classifier?" — filter on `classifier_version`. ADR-037 bias-quarantine principle.

**Exit gate.** All of:

1. New table `quantlab.bt_runs_regime` exists (DDL in `ensureBacktestTables`); idempotent re-runs are no-ops.
2. `attributeBacktestRegime(runId, classifierVersion)` populates one (run_id, classifier_version) row from a `bt_runs` row + the `macro_regimes` window. Sums-to-1 invariant on `regime_distribution` Map (with float tolerance).
3. `backfillBacktestRegime(classifierVersion, options?)` covers all existing `bt_runs.run_id` values with no double-write hazards (ReplacingMergeTree resolves on `attributed_at`).
4. New batch sweep runs (`scripts/batch_backtest.ts`, `scripts/batch_backtest_xsmom.ts`) write attribution rows for the active classifier version automatically at the end of each sweep.
5. Reader helper `fetchBtRunsByRegime(filters)` returns a typed list of `bt_runs` rows joined to `bt_runs_regime` under a chosen `classifier_version`, with at minimum: filter by `dominant_regime IN […]` and by minimum-share-of-a-named-regime.
6. New tests green: ~12 TS unit tests on `bt_runs_regime.ts` (window derivation, distribution math, sums-to-1 invariant, classifier-version isolation, zero-trade fallback, delisted-token fallback, sums-to-1 under FINAL, dominant-tie-break stability, error pathways). 0 Python.
7. `npm test` baseline `655 passing, 4 failing` → `~667 passing, 4 failing` (net +12 passing, same 4 documented ADR-037 fixture failures). No drop in passing count outside the new file.
8. `npx tsc --noEmit` clean on all new files.

**Non-exit-gate.** No UI surface. No dashboard panel. The user's operational query path is via npm scripts and the existing Browse panel could later consume `fetchBtRunsByRegime`, but that's a follow-up Component (could be Component 6, not specced here).

**Non-goal.** Component 5 does NOT alter the `bt_runs` schema. It does NOT change the classifier or any backtest-engine logic. It does NOT define regime-conditional strategy gating (that's a Validator concern, downstream).

---

## 2. Architectural decisions

### 2.1 Sidecar table, not ALTER `bt_runs`

`bt_runs` is widened only when the column is intrinsic to the run (e.g. `data_span_days` was added because every engine knows it at write time). `classifier_version` is *dimensional* under ADR-037: the same `run_id` should attribute under `phase1_v2` (today, biased) and `phase1_v3` (post-Sharadar, principled) without one clobbering the other. A widened `bt_runs` with single-version columns can't represent that. Sidecar table keyed by `(run_id, classifier_version)` mirrors `macro_regimes` itself (keyed by `(trade_date, classifier_version)`).

**Rejected alternative.** ALTER `bt_runs` ADD COLUMN `macro_regime`, `classifier_version`. Forces re-attribution to overwrite (defeats bias-quarantine), pollutes the central table with a denormalized join column, and forces every read of `bt_runs` to consider whether the regime tag is current under the active classifier version.

### 2.2 Attribution over the run's data window, not at `started_at`

This is a **deliberate divergence from `v_bt_runs_by_cluster`** ([src/server/clickhouse.ts:415](../../src/server/clickhouse.ts#L415)). The cluster view's SPEC §4.4 divergence note (lines 386-392) accepts "run-time attribution" — joining at `bt_runs.started_at` — because admitted-token cluster_id is stable for ≥ 3 weeks (the §5.2 admission rule). Within a multi-week backtest, cluster membership barely shifts, so attributing at `started_at` ≈ attributing across the run window.

**That simplification does not transfer to regime.** Regimes shift daily. `started_at` is wall-clock-now (run executed today against, say, 2014 candles). Attributing today's regime to a 2014 backtest is actively wrong and would destroy D1-D3.

**Rule.** For each run:

```
data_end_date   := toDate(bt_runs.started_at)
data_start_date := data_end_date - toIntervalDay(toUInt32(round(bt_runs.data_span_days)))
```

Then aggregate `macro_regimes FINAL WHERE classifier_version = $cv AND trade_date BETWEEN data_start_date AND data_end_date` into a regime distribution.

**Heuristic caveats and fallbacks** (load-bearing — must be implemented):

- **Legacy rows** (`data_span_days = 0`): the engine pre-dating Phase 5 walk-forward did not write this column. Fallback: derive `[data_start_date, data_end_date]` from `bt_trades` JOIN — `min(toDate(ts))`, `max(toDate(ts))` for the matching `(sweep_id, token_address, strategy_type, param)`. If `bt_trades` also has no rows for the run (zero-trade legacy run), skip attribution entirely (write a sentinel row — see §3.4).
- **Delisted token / token max-candle earlier than `started_at`**: under ASOF semantics, `started_at = now()` overestimates `data_end_date`. Optional second-pass refinement: `data_end_date := min(toDate(started_at), max(toDate(candles.ts)) WHERE token_address = $t)`. Implemented as an **opt-in** flag (`refineWithCandles: true`) on the helper. Default OFF — keeps the attribution cheap and deterministic; flag ON for runs where the diff matters (delisted-ticker work, post-Sharadar).
- **Empty regime window** (window covers dates before macro_regimes coverage starts, e.g. pre-2008): write the run with `regime_distribution = {}` and `dominant_regime = 'unknown'`, `dominant_regime_share = 0`. Caller can filter these out with a single predicate.

### 2.3 Lossy summary AND full distribution

Store both:

- `dominant_regime LowCardinality(String)` — single label (cheap to filter and group by).
- `dominant_regime_share Float32` — fraction of the window in the dominant regime (proxy for "how representative is the label").
- `regime_distribution Map(LowCardinality(String), Float32)` — full normalized distribution (red, orange, yellow, green, plus `unknown` for missing-classifier-data days within the window).
- `total_days UInt32` — denominator the distribution was normalized against (lets you see warmup-shortened windows).

**Why both.** Dominant-regime alone is too lossy for D2/D3. Distribution alone is expensive to use in WHERE clauses (Map subscripting per row). Storing both is ~24 bytes per row of redundancy in exchange for cheap filters AND full retainment. ClickHouse Map(LowCardinality(String), Float32) is well-optimized.

**Tie-break for dominant_regime when two regimes have equal shares.** Lexicographic ASC on the regime string, deterministically. Test #8 enforces this.

### 2.4 Single attribution per (run_id, classifier_version), refreshable

`bt_runs_regime` is `ReplacingMergeTree(attributed_at)` ordered by `(run_id, classifier_version)`. A re-attribution under the same classifier version (e.g. after fixing a bug in the helper) overwrites cleanly. A new classifier version (`phase1_v3`) writes alongside the existing `phase1_v2` row — both queryable.

---

## 3. Component contracts

### 3.1 Schema — `quantlab.bt_runs_regime`

DDL added to [src/server/clickhouse.ts](../../src/server/clickhouse.ts) `ensureBacktestTables`, after the `macro_regimes` block.

```sql
CREATE TABLE IF NOT EXISTS quantlab.bt_runs_regime (
  run_id                UUID,
  classifier_version    LowCardinality(String),

  -- The window the run covered (inferred per §2.2 rule + fallbacks).
  data_start_date       Date,
  data_end_date         Date,
  total_days            UInt32,             -- count of macro_regimes rows in [start, end]

  -- Attribution outputs.
  dominant_regime       LowCardinality(String),  -- 'red' | 'orange' | 'yellow' | 'green' | 'unknown'
  dominant_regime_share Float32,                  -- fraction in [0, 1]; 0 iff dominant_regime = 'unknown'
  regime_distribution   Map(LowCardinality(String), Float32),

  -- Bookkeeping.
  attribution_source    LowCardinality(String),   -- 'window' | 'trades_fallback' | 'sentinel_no_trades'
  attributed_at         DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(attributed_at)
ORDER BY (run_id, classifier_version)
```

**Notes.**

- `Map(LowCardinality(String), Float32)` — CH ≥ 21.x. The dashboard's existing schema uses `LowCardinality(String)` heavily; this is consistent.
- ORDER BY `(run_id, classifier_version)` matches the dimensional key. Looking up a single run's attribution under a chosen version is a primary-key probe.
- `attribution_source` is a debug field — lets operators triage anomalous rows by tracing which fallback path produced them. Not load-bearing for queries.

### 3.2 Writer helper — `attributeBacktestRegime`

New file [src/server/bt_runs_regime.ts](../../src/server/bt_runs_regime.ts).

```ts
export type AttributeOptions = {
  /** When true, refine data_end_date by max(toDate(candles.ts)) for the token. Default false. */
  refineWithCandles?: boolean;
};

export type AttributionResult = {
  run_id: string;
  classifier_version: string;
  data_start_date: string;     // YYYY-MM-DD
  data_end_date: string;
  total_days: number;
  dominant_regime: string;
  dominant_regime_share: number;
  regime_distribution: Record<string, number>;
  attribution_source: 'window' | 'trades_fallback' | 'sentinel_no_trades';
};

/** Compute and persist regime attribution for a single run. Idempotent (ReplacingMergeTree). */
export async function attributeBacktestRegime(
  runId: string,
  classifierVersion: string,
  options?: AttributeOptions
): Promise<AttributionResult>;
```

**Algorithm (procedural, single-pass).**

1. Fetch the bt_runs row by `run_id`. Throw `BtRunsRegimeError('run_not_found', runId)` if missing.
2. Compute the window per §2.2:
   - If `data_span_days > 0`: `data_end_date = toDate(started_at)`, `data_start_date = data_end_date - toIntervalDay(round(data_span_days))`. Set `attribution_source = 'window'`.
   - Else: query `bt_trades` for `min(toDate(ts)), max(toDate(ts)) WHERE sweep_id = $sw AND token_address = $tok AND strategy_type = $st AND param = $p`. If both non-null → set `attribution_source = 'trades_fallback'`. If null → write sentinel row with `dominant_regime='unknown'`, `regime_distribution={}`, `total_days=0`, `attribution_source='sentinel_no_trades'`. Return.
   - If `options.refineWithCandles`: `data_end_date = min(data_end_date, max(toDate(candles.ts)) WHERE token_address = $tok)`. If this pulls `data_end_date < data_start_date`, swap to sentinel (the window collapsed; almost certainly a delisted-token edge case).
3. Aggregate `macro_regimes FINAL` over `[data_start_date, data_end_date]` for the requested `classifier_version`:
   ```sql
   SELECT regime, count() AS days
   FROM quantlab.macro_regimes FINAL
   WHERE classifier_version = $cv
     AND trade_date BETWEEN $start AND $end
   GROUP BY regime
   ```
4. Build the distribution Map. Normalize by `total_days = sum(days)`. If `total_days = 0` (no macro_regimes coverage in window) → sentinel.
5. Pick `dominant_regime` = argmax of the Map; tie-break by string ASC. `dominant_regime_share = distribution[dominant_regime]`.
6. INSERT into `bt_runs_regime`. ReplacingMergeTree dedup happens at merge time; query helpers must use `FINAL` or `argMax`-style aggregation.

**Performance.** Single bt_runs lookup (PK probe) + one macro_regimes window aggregation (small — ≤ 252 rows per typical 1Y window) + one INSERT. ~5-15 ms per run. Backfill of N runs ≈ N × 10 ms; for N = 100k runs that's ~17 minutes — acceptable for a one-off backfill, OK to run unparallelized at first.

### 3.3 Backfill helper — `backfillBacktestRegime`

```ts
export type BackfillOptions = {
  classifierVersion: string;
  /** Skip runs that already have an attribution row for this classifier_version. Default true. */
  skipExisting?: boolean;
  /** Limit total rows attributed in this call (paging). Default unlimited. */
  limit?: number;
  /** Cap concurrency. Default 4. */
  concurrency?: number;
  /** Pass-through to attributeBacktestRegime. */
  refineWithCandles?: boolean;
  /** Optional progress callback. */
  onProgress?: (done: number, total: number) => void;
};

export async function backfillBacktestRegime(opts: BackfillOptions): Promise<{
  total: number;
  attributed: number;
  skipped: number;
  errors: number;
}>;
```

**Procedure.**

1. SELECT all `run_id`s from `bt_runs` (DISTINCT under ReplacingMergeTree's effective row set) optionally filtered to those without an existing `bt_runs_regime` row at the requested `classifier_version` (`skipExisting`).
2. Process in chunks of `concurrency` runs in parallel, each calling `attributeBacktestRegime`.
3. Aggregate the returns into the summary `{total, attributed, skipped, errors}`.

**Wrapper script.** `scripts/backfill_bt_runs_regime.ts` — thin CLI: `npx tsx scripts/backfill_bt_runs_regime.ts [--classifier-version=phase1_v2] [--refine-candles] [--limit=N]`. Default classifier_version = the current `CLASSIFIER_VERSION` constant from `src/server/macro_regime.ts`. New npm script `backfill:bt-regime` and `backfill:bt-regime:dry`.

### 3.4 Reader helper — `fetchBtRunsByRegime`

Used by future dashboard surfaces, scoring scripts, and ad-hoc validation.

```ts
export type RegimeFilter = {
  classifierVersion: string;
  /** OR-list of dominant_regime values to include. */
  dominantRegimeIn?: string[];
  /** Minimum share of a named regime within the run's window. */
  minShareOf?: { regime: string; share: number };
  /** Standard bt_runs filters passed through. */
  strategyType?: string;
  symbol?: string;
  tier?: string;
  interval?: string;
  /** Limit rows returned. Default 1000 (the existing Browse-panel cap). */
  limit?: number;
};

export type BtRunWithRegime = {
  // All bt_runs columns the existing Browse code returns (re-export the existing type), PLUS:
  classifier_version: string;
  data_start_date: string;
  data_end_date: string;
  total_days: number;
  dominant_regime: string;
  dominant_regime_share: number;
  regime_distribution: Record<string, number>;
  attribution_source: string;
};

export async function fetchBtRunsByRegime(f: RegimeFilter): Promise<BtRunWithRegime[]>;
```

**SQL shape** — INNER JOIN bt_runs to `bt_runs_regime FINAL` on `run_id` filtered by `classifier_version`. `INNER` (not LEFT) by design — un-attributed runs do not surface here; the operator must run backfill first. Surface `attribution_source = 'sentinel_no_trades'` if requested via a separate filter (default exclude).

### 3.5 Writer integration — batch_backtest sweeps

After [scripts/batch_backtest.ts](../../scripts/batch_backtest.ts) and [scripts/batch_backtest_xsmom.ts](../../scripts/batch_backtest_xsmom.ts) finish writing `bt_runs` rows for a sweep:

```ts
// At the end of the sweep, after all bt_runs rows are committed:
import { backfillBacktestRegime } from '../src/server/bt_runs_regime';
import { CLASSIFIER_VERSION } from '../src/server/macro_regime';

await backfillBacktestRegime({
  classifierVersion: CLASSIFIER_VERSION,
  // Only this sweep's runs — paging via skipExisting=true is enough since
  // no prior rows exist for fresh sweep_ids.
  skipExisting: true,
});
```

**Failure mode.** If the macro_regimes table is unavailable (CH down, classifier_version not present), the call throws but does NOT roll back the bt_runs writes. The sweep is the source of truth; attribution is denormalization. The next `backfill:bt-regime` run will pick up the missing rows. Log the error but exit the sweep with `0` (the sweep itself succeeded).

---

## 4. Test contract

New file [scripts/tests/btRunsRegime.test.ts](../../scripts/tests/btRunsRegime.test.ts) — unit tests against in-memory fixtures (no live CH needed). Helpers MUST be pure where possible to test without CH; the impure entry points (`attributeBacktestRegime`, `backfillBacktestRegime`) are split into a pure core + thin CH-binding shell.

| # | Test | Asserts |
|---|---|---|
| 1 | `deriveWindow(startedAt, dataSpanDays)` returns expected `[start, end]` | `data_span_days = 90, started_at = '2025-04-10 17:00 UTC'` → `start = '2025-01-10', end = '2025-04-10'` (toDate truncates UTC). Edge: `data_span_days = 0` returns null. |
| 2 | `deriveWindow` rounds non-integer `data_span_days` half-up | `89.4` → 89 days; `89.6` → 90 days. (Convention: `Math.round`.) |
| 3 | `computeDistribution(rows)` normalizes counts to shares summing to 1 | Input `[{regime: 'green', count: 60}, {regime: 'yellow', count: 30}, {regime: 'red', count: 10}]` → `{green: 0.6, yellow: 0.3, red: 0.1}`; `Math.abs(sum - 1) < 1e-6`. |
| 4 | `computeDistribution([])` returns sentinel | `regime_distribution = {}`, `dominant_regime = 'unknown'`, `dominant_regime_share = 0`, `total_days = 0`. |
| 5 | `dominantRegime(distribution)` picks argmax | `{green: 0.4, yellow: 0.4, red: 0.2}` → `'green'` (lex ASC on tie). `{green: 0.6, ...}` → `'green'`. |
| 6 | `dominantRegime` is deterministic under tie | Same input twice → same output. (Property-based, 100 random tied inputs.) |
| 7 | `attributeBacktestRegime` writes one row per (run_id, classifier_version) | Mock CH; assert single INSERT with the expected row shape. |
| 8 | Re-attribution under same classifier_version overwrites cleanly | Two calls with same args → after FINAL, one row visible. |
| 9 | Re-attribution under different classifier_version coexists | `phase1_v2` then `phase1_v3` → after FINAL, two rows visible. |
| 10 | `attributeBacktestRegime` falls back to bt_trades when `data_span_days = 0` | Mocked bt_runs has `data_span_days = 0`, mocked bt_trades has min/max ts → derived window matches; `attribution_source = 'trades_fallback'`. |
| 11 | `attributeBacktestRegime` writes sentinel for zero-trade legacy run | Mocked bt_runs has `data_span_days = 0`, mocked bt_trades returns `null/null` → `dominant_regime = 'unknown'`, `attribution_source = 'sentinel_no_trades'`, no error. |
| 12 | `fetchBtRunsByRegime` filter: `dominantRegimeIn=['green']` | Returns only rows where `dominant_regime = 'green'`. |
| 13 | `fetchBtRunsByRegime` filter: `minShareOf = {regime: 'red', share: 0.05}` | Returns only rows whose `regime_distribution['red'] >= 0.05`. |
| 14 | `BtRunsRegimeError('run_not_found', id)` thrown when bt_runs row absent | Caller can pattern-match on `error.code`. |

**Total: 14 tests** (slight expansion vs. exit gate's "~12"; the property-based tie-break test counts as one).

---

## 5. Files / code state

### NEW

- [src/server/bt_runs_regime.ts](../../src/server/bt_runs_regime.ts) — pure helpers (`deriveWindow`, `computeDistribution`, `dominantRegime`) + impure entry points (`attributeBacktestRegime`, `backfillBacktestRegime`, `fetchBtRunsByRegime`) + `BtRunsRegimeError` class.
- [scripts/backfill_bt_runs_regime.ts](../../scripts/backfill_bt_runs_regime.ts) — CLI wrapper with `--classifier-version`, `--refine-candles`, `--limit`, `--dry-run` flags.
- [scripts/tests/btRunsRegime.test.ts](../../scripts/tests/btRunsRegime.test.ts) — 14 `it()` blocks across ~5 describe-suites.
- This SPEC: [docs/specs/regime-backtest-attribution-component5.md](regime-backtest-attribution-component5.md).

### MODIFIED

- [src/server/clickhouse.ts](../../src/server/clickhouse.ts) — add `bt_runs_regime` DDL block in `ensureBacktestTables` after the existing `macro_regimes` block.
- [scripts/batch_backtest.ts](../../scripts/batch_backtest.ts), [scripts/batch_backtest_xsmom.ts](../../scripts/batch_backtest_xsmom.ts) — at end-of-sweep, call `backfillBacktestRegime({classifierVersion, skipExisting: true})`. Error logged, not propagated (the sweep is the source of truth).
- [package.json](../../package.json) — add `backfill:bt-regime` and `backfill:bt-regime:dry` scripts.

### NO CHANGES TO

`bt_runs` schema. `macro_regimes` schema. `bt_trades` schema. The classifier (`src/server/macro_regime.ts`). The Component-3 dashboard (`/#/regime` route).

---

## 6. Watch-outs

- **`data_end_date` heuristic over-shoots for delisted tokens.** A run executed today against a token whose last candle is from 2022 will get `data_end_date = today`. Distribution is still well-defined (macro_regimes covers today), but the *attributed regime* will reflect 2022→today's mix, not 2022's mix. Mitigation: `refineWithCandles: true` flag; opt-in because it costs an extra candles MAX query per run. **Consider turning ON by default once Sharadar lands** and delisted-ticker work becomes common — at that point the diff matters and the cost is negligible vs the rest of the Sharadar pipeline.
- **`started_at` semantics in legacy rows.** Pre-Phase-5 rows may have `started_at` from years ago (the original sweep that wrote them). For those rows, `started_at` is approximately the data window's end — coincidentally the right thing. Confirmed by examining `started_at` distribution during backfill QA. Watch-out only if the engine ever changes to write `started_at = sweep-launch-time` for replays of historical data.
- **`macro_regimes FINAL` is required.** ReplacingMergeTree-without-FINAL can return duplicate (trade_date, classifier_version) rows mid-merge, inflating `total_days`. Test #3's distribution math assumes deduped input. Helper SQL must always say `FROM quantlab.macro_regimes FINAL`. Code review must catch any reads that drop FINAL.
- **`Map(LowCardinality(String), Float32)` requires CH ≥ 21.4** for the LowCardinality-key support. Existing schema uses LC strings extensively; if a CH instance fails the DDL with "Map keys cannot be LowCardinality", swap to `Map(String, Float32)` — no semantic change, slightly more storage. Test #3 should pass either way.
- **Map subscripting in WHERE clauses is row-by-row.** `regime_distribution['red'] >= 0.05` does a Map lookup per row. Acceptable at bt_runs cardinality (currently <1M rows); if cardinality grows, add a SKIP index on the dominant_regime column or denormalize per-regime shares into 4 Float32 columns. Watch-out captured for re-evaluation post-backfill.
- **Bias-quarantine discipline lives in the *query*, not the schema.** This SPEC stores `classifier_version` per row but does NOT enforce that downstream consumers filter on it. Any new code that queries `bt_runs_regime` without a `classifier_version` predicate will silently mix `phase1_v2` and `phase1_v3` attributions once both exist. Consider a lint rule or type-level guard in `fetchBtRunsByRegime` that requires `classifierVersion` in the filter (already enforced via the type — `classifierVersion` is non-optional on `RegimeFilter`).
- **Classifier version bump = mandatory backfill.** When `phase1_v3` lands (post-Sharadar), running `npm run backfill:bt-regime -- --classifier-version=phase1_v3` is required to populate v3 attributions. Document this in the Sharadar SOP next to the existing `BIAS_NOTE_PHASE1_V2`/`ADR_037_BASELINE` constant-update step.

---

## 7. Out of scope (explicitly)

- UI surface for regime-conditional bt_runs filtering (Browse panel update). Future Component 6 candidate.
- Validator integration (regime-conditional gates on the strategy validator). The validator already has tier/cluster axes; a regime axis is a natural extension but materially larger work — separate SPEC.
- Per-trade regime tagging in `bt_trades`. Different design choice (regime-at-entry vs. regime-at-exit vs. regime-at-bar). Not needed for D1-D4. If pursued, separate SPEC.
- Daily AI briefing (Component 4). Specced separately when scoping is resolved.

---

**Approval expected before CODE.** This SPEC adds one DDL (idempotent), one helper module, one CLI script, one test file, two existing-script edits, and two npm scripts. CODE pass writes those files in that order, with `npx tsc --noEmit` and `npm test` green at the end. Estimated CODE-pass scope: ~600 LOC across 6 touched files, ~14 unit tests.
