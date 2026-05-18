# SPEC — Strategy-Tagged Drawdown State

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-18 · **Author:** producer (Claude) · **Authority:** [drawdown-response-framework.md §4.2 watch-out](drawdown-response-framework.md#§42--round-2-blended-portfolio-rescale-2026-05-17-amendment--session-77), [drawdown-response-framework.md §13 — per-strategy out-of-scope reservation](drawdown-response-framework.md), session 79 HANDOFF "Bucket 3 / strategy-tagged dd_state architectural SPEC"
>
> **Stage in Vector Core build:** SPEC — defines the contract; CODE lands in a separate slice. This document does NOT change live behavior.
>
> **Unblocks:** per-strategy graduated drawdown response, prerequisite for multi-strategy expansion beyond the current `mean_reversion_v1` + `trend_v1` pair, prerequisite for the `strategy-demotion.md` gap doc's per-strategy "performance decay trigger."

The current `drawdown-response-framework.md` (§3 through §4.2) operates at portfolio scope: ONE drawdown level is computed per daemon run from the aggregate trailing-30d P&L across all closed trades for a `source`. That level drives every cell's `sizingMultiplier` and the `newEntriesAllowed` gate uniformly.

This SPEC extends the framework to a SECOND scope — **per-strategy drawdown state** — that runs alongside the portfolio scope, not in place of it. Both scopes use the same six-level state machine (§3 of the parent SPEC) with strategy-specific thresholds where calibration warrants. The action layer (sizing multiplier, entry pause, review requirement) is dispatched per strategy at the cell level.

This is pre-work for two downstream initiatives: (a) the §4.2 100/0-drift failure mode (one strategy halts, portfolio composition shifts, blended thresholds no longer apply); (b) the `strategy-demotion.md` Phase 9+ gap doc, which needs a per-strategy decay signal to act on.

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the six-level state machine (§3 of parent SPEC) to compute and persist a drawdown level PER STRATEGY in addition to the existing portfolio level. Strategy = first '|'-segment of `cellKey` (the `bundleId`), matching the existing A4 kill-criterion convention ([paper_trading_kill_criteria.ts:404](../../src/server/paper_trading_kill_criteria.ts#L404)).
2. Calibrate per-strategy thresholds using the per-strategy SD-ratio measurements already on file (mr_v1 = 0.297 from s74, trend_v1 = 0.110 from s75), so per-strategy levels fire at the same σ-band semantics that §4.2 designed for the blended portfolio.
3. Define the action layer's strategy-scoped dispatch — sizing multiplier and entry-pause flag are applied PER CELL based on the cell's strategy's dd state, not the portfolio's.
4. Persist per-strategy state in a forward-compatible way: same `quantlab.drawdown_state_history` table, new `bundle_id` column, empty-string sentinel preserves the existing portfolio-aggregate rows.
5. Preserve the portfolio scope's existing wire-ups verbatim — ADR-039 stage gates, A5 kill-criterion byte-equality, halt-sentinel protocol, morning brief portfolio section — so this SPEC is additive, not disruptive.
6. Define the failure modes that strategy-tagging introduces (one strategy halts, portfolio drifts, single-source-per-call invariant) with enough operational precision to test.

**Non-goals:**

1. Per-cell drawdown levels. Cell variance is too tight to drive distinct ladders; per-cell would mostly idle at L0. Cells inherit their strategy's level.
2. Strategy demotion / removal from the allowlist. The `strategy-demotion.md` gap doc is the right home for that; this SPEC produces the SIGNAL it would consume, not the demotion action.
3. Per-strategy ADR-039 stage gates. The deployment ramp stays portfolio-anchored (one operator, one capital bucket, one stage). Per-strategy halts within a stage are framework-level, not stage-level.
4. Per-strategy A5 kill. A5 stays portfolio-scope; a single strategy losing 20% does not write `.daemon_halt`. The PORTFOLIO L5 ↔ A5 byte-equality (parent SPEC §7.1 + test #26) is preserved.
5. Retroactive reconstruction of per-strategy history. Pre-migration rows carry `bundle_id = ''` (portfolio) only; per-strategy series begins at the migration cut-over.
6. Cross-strategy regime-conditional thresholds. The regime is portfolio-level (one `macro_regimes` color per day); per-strategy review escalation reuses the same `regimeRedDays30` input.
7. Re-deriving the calibration RATIOS. s74/s75/s76 sweeps are the source; this SPEC consumes them, it does not replace them.

---

## §2 · Why this extension now

Three load-bearing reasons.

### §2.1 The §4.2 100/0-drift failure mode

[drawdown-response-framework.md §4.2 watch-outs](drawdown-response-framework.md#§42--round-2-blended-portfolio-rescale-2026-05-17-amendment--session-77) flagged: "if the framework halts one strategy via L4/A5 and the other absorbs its share, the actual portfolio drifts toward 100/0. In that regime the appropriate ratio is the single-strategy ratio (0.297 mr_v1 or 0.110 trend_v1), NOT the blended 0.141 — i.e., the framework would be ~2× too tight on the surviving strategy alone."

The framework's response was: "the design assumes the levels themselves are coarse enough to absorb this drift; if production halts become frequent under s77 thresholds, revisit." Per-strategy thresholds resolve the assumption: when one strategy halts, the survivor's dd state continues to be evaluated against ITS own per-strategy thresholds (0.297-derived for mr_v1, 0.110-derived for trend_v1), not the blended-portfolio thresholds. No drift in semantics.

### §2.2 Concentration risk that portfolio scope can't see

The current framework reads PORTFOLIO trailing-30d cum P&L. Consider two scenarios:

- **Scenario A** (visible): mr_v1 -5%, trend_v1 -5%, portfolio = -5%. Portfolio L1 fires. Both strategies get sizingMultiplier = 1.0 (L1 is logged-only).
- **Scenario B** (invisible): mr_v1 -15%, trend_v1 +5%, portfolio = -5%. Portfolio L1 fires. Both strategies get sizingMultiplier = 1.0.

Scenario B is a strategy-specific failure masked by averaging. Per-strategy state catches it: mr_v1 hits its own L3 (-1.5% under the per-strategy threshold scale; see §4 below) while trend_v1 stays L0. The L3 response (sizingMultiplier = 0.5, 7-day entry pause, strategy-review requirement) is dispatched ONLY to mr_v1 cells.

### §2.3 The `strategy-demotion.md` dependency

[docs/obsidian/gaps/strategy-demotion.md](../obsidian/gaps/strategy-demotion.md) Phase 9+ candidate proposes a "performance decay trigger" — strategy removed if 30-day live performance below 50% of backtest mean for 60 consecutive days. That detector needs a PER-STRATEGY trailing-30d performance signal. This SPEC's per-strategy `drawdown_30d_pct` is the natural input — it's already computed, persisted, and history-loaded with hysteresis. Demotion sits on top of this layer; without it, demotion has no canonical per-strategy signal to read.

---

## §3 · Tagging model

**Definition.** A strategy is identified by its `bundleId`, the first '|'-segment of a trade's `cellKey`. The deployed set today is `{mean_reversion_v1, trend_v1}` (short: `mr_v1`, `trend_v1`). Future strategies (e.g. `momentum_v1` per [paper_trading_dashboard.ts:99](../../src/server/paper_trading_dashboard.ts#L99)) join the set by adding rows to the per-strategy table without schema change.

**Helper.** `parseCellKey` ([paper_trading_dashboard.ts:108](../../src/server/paper_trading_dashboard.ts#L108)) is the established decoder. Per-strategy dd evaluation must use it (or the equivalent `cellKey.split('|')[0]`) to extract `bundleId` — the SPEC mandates the SAME convention as A4 to prevent drift between two parts of the codebase that need to agree on "what is a strategy."

**Portfolio sentinel.** The `bundle_id` column accepts an empty-string sentinel `''` to denote PORTFOLIO-AGGREGATE rows (the existing scope). All pre-migration history rows are portfolio rows; the migration backfills `bundle_id = ''` on those rows. Per-strategy rows use non-empty `bundleId` values (e.g. `'mean_reversion_v1'`, `'trend_v1'`).

**Why empty-string, not NULL.** Mirrors `regime_at_entry` in `live_trades` ([live_trade_repository.ts:151](../../src/server/live_trade_repository.ts#L151)), which uses `''` for "unknown / not classified." LowCardinality(String) on `bundle_id` lets ClickHouse store the cardinality cheaply. NULL would force a Nullable column and complicate FINAL semantics.

**Strategy enumeration.** The framework does NOT hard-code the strategy set. The set of bundles per evaluation is derived from the input trades' distinct `cellKey.split('|')[0]` values plus the always-present portfolio scope. Adding a third strategy to the daemon (e.g. `momentum_v1`) automatically produces a third per-strategy row without changing this module — the only required edit is the per-strategy threshold table in §4 (a new strategy needs a calibration ratio).

---

## §4 · Per-strategy threshold calibration

The parent SPEC's §4.2 blended-portfolio thresholds remain the PORTFOLIO scope's pinned values. This SPEC adds per-strategy thresholds derived by the same proportional-rescale methodology applied PER STRATEGY.

### §4.1 Methodology

Apply parent SPEC §4.1's proportional rescale (`thresholds = pre-s74 × ratio, rounded to nearest 0.5%, operational floor at -0.5%`) using each strategy's individually measured SIZER/LEGACY SD ratio:

| Strategy   | Ratio | Source         | Measurement script |
|------------|-------|----------------|--------------------|
| `mean_reversion_v1` | **0.297** | s74 (per-cell median across 15 cells) | [`scripts/_threshold_stability_sweep.ts`](../../scripts/_threshold_stability_sweep.ts) |
| `trend_v1` | **0.110** | s75 (per-cell median across 15 cells) | [`scripts/_threshold_stability_sweep_trend_v1.ts`](../../scripts/_threshold_stability_sweep_trend_v1.ts) |
| (portfolio scope) | 0.141 | s76 blended | [`scripts/_threshold_stability_sweep_blended.ts`](../../scripts/_threshold_stability_sweep_blended.ts) |

### §4.2 Per-strategy threshold tables

Computed values (pre-s74 anchor × ratio, rounded to nearest 0.5%, -0.5% operational floor):

**mean_reversion_v1 — ratio 0.297:**

| Level | Entry threshold | Exit threshold | Exit days |
|-------|-----------------|----------------|-----------|
| 1     | -0.01           | -0.005 (floor) | 5         |
| 2     | -0.02           | -0.015         | 5         |
| 3     | -0.035          | -0.03          | 5         |
| 4     | -0.055          | -0.045         | 10        |
| 5     | -0.20 (unchanged) | (no auto-exit) | n/a     |

(These are byte-identical to the s74 §4.1 portfolio values, by design — s74 was a `mr_v1`-only sweep, so per-strategy mr_v1 = the s74 measurement.)

**trend_v1 — ratio 0.110:**

| Level | Entry threshold | Exit threshold | Exit days |
|-------|-----------------|----------------|-----------|
| 1     | -0.005 (floor)  | -0.005 (floor) | 5         |
| 2     | -0.005 (floor)  | -0.005 (floor) | 5         |
| 3     | -0.015          | -0.01          | 5         |
| 4     | -0.02           | -0.015         | 10        |
| 5     | -0.20 (unchanged) | (no auto-exit) | n/a     |

(Trend_v1's lower ratio means thresholds are tighter; the operational floor binds at L1 entry, L1 exit, L2 entry, and L2 exit. Under floor-clipping, L1 and L2 collapse to the same entry threshold — see §4.4 watch-outs.)

### §4.3 Why per-strategy and not blended

Pardo (2008) §11 σ-band design fires the warning system at ~1-2σ of the realized P&L distribution. Strategies with different realized SDs need different absolute thresholds to fire at the same σ-band. Forcing both strategies through the blended (0.141) threshold means:

- mr_v1 (SIZER SD = 57.9% per s76) sees L3 entry at -1.5% — that's 0.026σ relative to its own SD (after the s76 absolute-SD inflation factor is applied). Effectively never fires.
- trend_v1 (SIZER SD = 107.0% per s76) sees L3 entry at -1.5% — that's 0.014σ. Even less likely.

The blended threshold is correctly tuned for the BLENDED portfolio's variance, but is structurally too lenient for each strategy in isolation. Per-strategy thresholds fix this.

### §4.4 Why Level 5 is unchanged per strategy

Same reasoning as parent SPEC §4.2: L5 (-0.20) is operator-preference "never lose 20% in a month, full stop." That semantic applies AT THE STRATEGY scope just as cleanly as at the portfolio scope — a single strategy losing 20% in a month is a strategy-level circuit breaker regardless of what the portfolio is doing. Byte-equality with `A5_KILL_THRESHOLD_PCT` is preserved at the PORTFOLIO level (test #26); per-strategy L5 is a NEW firing path that does NOT trigger A5 (does NOT write `.daemon_halt` — see §7.1).

### §4.5 What this is NOT

Not the §12 retune. The §12 retune of the parent SPEC will produce empirical-quantile thresholds from ≥90 days of paper-trading ledger. §4 of THIS SPEC is the same kind of stopgap §4.1/§4.2 of the parent SPEC are — proportional rescale against backtest-derived ratios. When §12 retune fires (~2026-08-29 earliest sizer-mode data), it must produce per-strategy quantiles ALONGSIDE the portfolio quantiles; the same retune ADR can supersede both this §4 and the parent's §4.2.

### §4.6 Watch-outs

- **Operational floor collapse at trend_v1's L1/L2.** Under the -0.5% floor, trend_v1's L1 entry, L1 exit, L2 entry, and L2 exit are all -0.005. The L1/L2 distinction collapses — any time trend_v1's trailing 30d cum P&L breaches -0.5%, the natural-down level is L2 (deepest level whose entry threshold the dd passes). L1 is structurally unreachable as a stable state for trend_v1 under these thresholds. This is a deliberate consequence of (a) trend_v1's measured low SD ratio, (b) the floor preventing noise firings. If the operator finds the L1 informational signal valuable for trend_v1 specifically, the floor can be relaxed in a follow-up amendment.
- **Per-strategy ratios are mr_v1-only and trend_v1-only measurements.** Any third strategy added (e.g. momentum_v1) requires its own SD-ratio measurement BEFORE per-strategy thresholds can be calibrated. Until measured, the new strategy must run with portfolio-blended thresholds as fallback, not naive copy of mr_v1's or trend_v1's table. CODE-slice TODO: a `STRATEGY_THRESHOLD_TABLES` lookup that throws on unknown bundleId rather than silently falling back, so adding a strategy without calibration is loud, not silent.
- **The s74/s75 ratios are per-cell medians across 15 cells, not deployed-cell measurements.** The portfolio-level §4.2 ratio used the blended deployed-cell measurement (0.141). For per-strategy thresholds, the per-cell median is what's currently on file from the sweeps — they ARE the right input to a `pre-s74 × ratio` rescale, but a future amendment could re-derive using deployed-cell-only measurements per strategy. The values would shift modestly; the framework structure does not.
- **Future strategies must run the per-strategy sweep, not just the blended sweep.** The §4.2 lesson (mr_v1-only ratio 0.297 did not generalize to the blended portfolio 0.141) cuts the other way too: a blended-portfolio sweep alone does not give the per-strategy ratios needed here. Adding a strategy requires both a blended-portfolio re-sweep (to update the parent SPEC's §4.2 ratio for the new N-strategy blend) AND a per-strategy sweep for the new strategy's calibration table.

---

## §5 · Per-strategy drawdown measurement

Mirrors parent SPEC §5, scoped to a single bundle.

### §5.1 Definition

```
drawdown_30d_pct_for_strategy(bundleId) =
  sum(realized_pnl_usd for closed trades WHERE
      cellKey.split('|')[0] == bundleId AND
      exit_ts IN [asOf - 30d, asOf]) /
  deployed_capital_usd
```

The denominator is the SAME `deployed_capital_usd` that the portfolio scope uses. Per-strategy P&L is expressed AS A FRACTION OF THE PORTFOLIO CAPITAL, not the strategy's allocated slice. Rationale: the threshold table in §4.2 was rescaled from pre-s74 anchors that themselves were portfolio-normalized; using the strategy's allocated slice as the denominator would re-scale by 1/strategy_weight and double-count the σ-band design.

### §5.2 Why portfolio capital, not strategy allocation

Two reasons:

1. **No persisted per-strategy capital allocation.** The framework does not currently track "mr_v1 was allocated $5k, trend_v1 was allocated $5k" — it tracks portfolio capital. Adding per-strategy capital tracking is a separate, larger workstream (touches sizing, retargeting, and stage-state ramp logic).
2. **Threshold semantics consistency.** The §4.2 thresholds are designed to fire when "the portfolio has lost X% of capital." Per-strategy thresholds in §4.2 are designed to fire when "this strategy alone has lost X% of capital (where X% of WHAT — portfolio capital, by §4 derivation)." A trend_v1 losing 1.5% of portfolio capital = trend_v1 losing 3% of its 50% allocation (under T0 equal-weight). The math is consistent; only the FRAMING is portfolio-normalized.

If a future workstream introduces per-strategy capital accounting, the strategy denominator can be revisited via amendment ADR; the framework structure does not change.

### §5.3 Window, sentinels, partial-window flag

All identical to parent SPEC §5:

- Trailing-30d window via `A_TRAILING_WINDOW_DAYS = 30` constant.
- `asOf` clock identical to parent.
- Source filter (`'paper'` vs `'live'`) applied BEFORE bundle filter — strategies do not span sources.
- `partialWindow` flag fires when the strategy's FIRST trade is inside the window (per-strategy partial-window, not portfolio-partial-window).
- Zero strategy trades in window → `drawdown_30d_pct = 0`, level = 0 (Normal). NOT insufficient_data.
- Strategy with zero closed trades EVER but other strategies have trades → returns a Level-0 row with `partialWindow = false`. The strategy genuinely has no losses.

---

## §6 · Per-strategy regime-conditional review

Regime classification is portfolio-wide (one `macro_regimes` row per UTC date). Per-strategy state inherits the SAME `regimeRedDays30` input as the portfolio state. The regime-explained flag (parent SPEC §6) applies per strategy with no change in semantics: a strategy-level L1/L2/L3 entry during a 14+/30 RED-heavy window is "regime-explained" for that strategy; outside that window the entry is "unexplained" and gets a strategy-specific review note.

No new per-strategy regime concept. Strategies do not have their own regime classifier.

---

## §7 · Integration

### §7.1 Kill criteria (A1-A5)

**Portfolio L5 ↔ A5 byte-equality is preserved.** Test #26 of the parent SPEC continues to byte-pin `A5_KILL_THRESHOLD_PCT / 100 === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5]` at -0.20. This SPEC adds NO new wiring between A5 and per-strategy L5.

**Per-strategy L5 does NOT write the halt sentinel.** A single strategy losing 20% in 30 days triggers a STRATEGY-LEVEL halt — sizingMultiplier = 0 for that strategy's cells, newEntriesAllowed = false for that strategy — but does NOT write `.daemon_halt` and does NOT halt the surviving strategy. Rationale: the kill criterion's purpose is to stop the SYSTEM when the SYSTEM is failing. A single-strategy 20% loss with the other strategy flat is bad, but it's a STRATEGY decision (let it bleed, retire it, or wait it out via §12 retune), not a system-shutdown decision. The operator can still manually invoke the halt sentinel; per-strategy L5 just doesn't auto-fire it.

**A4 (mr/trend correlation > +0.7) is orthogonal.** A4 already reads PER-STRATEGY P&L bucketed by bundleId ([paper_trading_kill_criteria.ts:404](../../src/server/paper_trading_kill_criteria.ts#L404)); this SPEC consumes the same convention but does not change A4's logic.

A1, A2, A3 remain portfolio-scope kill criteria. A future amendment could introduce per-strategy A2 (worst single-trade) or per-strategy A3 (max DD) — out of scope here.

### §7.2 Capital deployment stages (ADR-039)

**Stage gates remain portfolio-anchored.** Stage3.failDrawdown still reads `isLevel3EntryEvent` against the PORTFOLIO state, not against any strategy state. Rationale: stage rollback is an operator-confidence decision tied to the deployment ramp's overall capital commitment; one strategy bleeding is not "the deployment ramp is too aggressive." A strategy with sustained L3+ is a STRATEGY problem the demotion gap doc addresses; staying in stage3 with one half-halted strategy is the correct posture.

The `CONFIG_VERSION` string does NOT bump on per-strategy SPEC ship (no change to the portfolio-scope §4.2 numbers).

### §7.3 Daemon orchestration

Pipeline change (parent SPEC §7.3 plus per-strategy dispatch):

```
1. Once per run, compute portfolio dd_state (existing).
2. ALSO compute one dd_state PER STRATEGY (new — N evaluations, where
   N = distinct bundleIds across closedTrades).
3. Persist N+1 rows to drawdown_state_history (portfolio + per-strategy).
4. Cell-level dispatch: for each cell about to process trades, look up
   its bundleId's per-strategy state. The cell's effective sizing
   multiplier is min(portfolioMultiplier, strategyMultiplier). The
   cell's effective newEntriesAllowed is the AND of portfolio + strategy.
5. The halt-sentinel gate continues to read PORTFOLIO state only (per §7.1).
```

The `min(portfolio, strategy)` composition for sizing means a strategy at L3 (multiplier 0.5) operating under a portfolio at L0 (multiplier 1.0) results in 0.5× for that strategy's cells while the other strategy's cells stay at 1.0×. A portfolio L4 (multiplier 0.0) overrides any strategy state — the system-wide halt wins.

### §7.4 Morning brief

Existing portfolio dd-state panel is preserved verbatim (byte-equal stdout invariant per parent SPEC §7.4). NEW per-strategy section is APPENDED to the existing panel:

```
DRAWDOWN STATE (PORTFOLIO):
  level: 1 (Caution)  drawdown_30d: -0.7%  ...

DRAWDOWN STATE (PER STRATEGY):
  mean_reversion_v1: level 2 (Concern)  drawdown_30d: -1.2%  sizing: 0.75×
  trend_v1:           level 0 (Normal)   drawdown_30d:  0.1%  sizing: 1.00×
```

The per-strategy section MUST list strategies in deterministic order (alphabetical by bundleId) to preserve byte-equal-stdout testing.

### §7.5 Position sizing

The sizing multiplier consumed at `sizePositionFixedRisk` in `daemon_live_trades.ts` becomes:

```ts
const effectiveMultiplier = Math.min(
  portfolioDdState.sizingMultiplier,
  perStrategyDdState[cell.bundleId].sizingMultiplier,
);
const effectiveMaxRiskPerTrade = DEFAULT_RISK_CONFIG.maxRiskPerTrade × effectiveMultiplier;
```

The `min` semantics ensure the TIGHTER of the two scopes wins — a strategy at L3 (0.5×) in a portfolio at L0 (1.0×) sizes at 0.5×; a strategy at L0 (1.0×) in a portfolio at L3 (0.5×) also sizes at 0.5×. Pre-existing open positions are NOT resized (parent SPEC §7.5).

---

## §8 · State persistence

### §8.1 Schema migration

`quantlab.drawdown_state_history` gets ONE new column and an ORDER BY change:

```sql
-- Phase 1: ADD COLUMN with default empty-string (= portfolio sentinel).
ALTER TABLE quantlab.drawdown_state_history
  ADD COLUMN IF NOT EXISTS bundle_id LowCardinality(String) DEFAULT '';

-- Phase 2: Backfill is unnecessary — all existing rows are portfolio rows,
-- and the DEFAULT '' on the new column is byte-equal to the portfolio sentinel.

-- Phase 3: ORDER BY change. ClickHouse ALTER TABLE ... MODIFY ORDER BY
-- requires the new key to be a prefix-extension of the old key. Old key
-- is (source, evaluated_at); new key is (source, bundle_id, evaluated_at).
-- This is NOT a prefix extension — it inserts bundle_id in the middle.
-- The correct migration is:
--   (a) CREATE a new table with the desired ORDER BY,
--   (b) INSERT SELECT from old to new,
--   (c) RENAME old → old_v0_backup, new → drawdown_state_history,
--   (d) verify and drop the backup after one full daemon-run cycle.
-- This is a destructive operation (rename); requires explicit operator
-- authorization per the no-destructive-ops standing rule.
```

The CODE slice ships the migration script (`scripts/migrate_drawdown_state_history_per_strategy.ts`) with `--dry-run` and `--apply` modes. The `--apply` mode is operator-authorized only.

### §8.2 ReplacingMergeTree key

```sql
CREATE TABLE IF NOT EXISTS quantlab.drawdown_state_history (
  evaluated_at        DateTime64(3, 'UTC'),
  source              LowCardinality(String),
  bundle_id           LowCardinality(String),   -- NEW: '' = portfolio aggregate
  stage               LowCardinality(String),
  drawdown_30d_pct    Float64,
  deployed_capital    Float64,
  level               UInt8,
  level_entered_at    DateTime64(3, 'UTC'),
  regime_red_days_30  UInt8,
  config_version      String
)
ENGINE = ReplacingMergeTree(evaluated_at)
ORDER BY (source, bundle_id, evaluated_at);
```

Same-ms retries dedupe per (source, bundle_id, evaluated_at) tuple. FINAL semantics preserved.

### §8.3 Hysteresis state computation per strategy

`loadPriorHistory(source, bundleId)` walks the prior N rows for the specific (source, bundle_id) pair. The hysteresis count for a per-strategy level uses ONLY rows with matching bundle_id — per-strategy recovery does not consume portfolio rows or other-strategy rows. The 30-row default limit (parent SPEC §8.3) applies per-strategy: the per-strategy series can have its own 30-day window distinct from the portfolio's 30-day window.

At write time: the daemon writes N+1 rows per run (portfolio + per-strategy). All N+1 rows share the same `evaluated_at` timestamp (one wall-clock per run); they differ in `bundle_id`. ReplacingMergeTree dedupes on (source, bundle_id, evaluated_at) so retries within the same run write the same N+1 rows idempotently.

### §8.4 Storage cost

~1 row/day × (N+1) scopes × 10 years. For N=2 strategies: 10,950 rows. Trivial. The LowCardinality(String) on bundle_id makes the new column ~bytes per row.

### §8.5 Operator playbook — post-apply verification and drop-backup

After `--apply` completes, the canonical `quantlab.drawdown_state_history` carries the new sort key + `bundle_id` column, and `quantlab.drawdown_state_history_v0_backup` retains the pre-migration snapshot. The backup is the **only** rollback handle during the verification window. Do NOT run `--drop-backup` until both pre-conditions hold:

**Pre-condition 1 — wall-clock.** ≥24h has elapsed since `--apply` returned successfully. (Reason: at least one daily daemon cycle needs to land against the new schema; sub-daily checks don't exercise the path.)

**Pre-condition 2 — healthy daemon cycle.** At least one `npm run daemon:daily` has completed since the apply, and BOTH of these signals are present:

- **Daemon log shows per-strategy lines.** Expect `[drawdown-state strategy=<bid>]` lines, one per live strategy bundle, in addition to the portfolio line. If you see only the portfolio line, the bootstrap probe didn't flip and something is wrong — investigate before dropping the backup.
- **Morning brief renders the per-strategy panel.** Run `npm run brief:morning` and confirm the per-strategy drawdown panel renders with one row per live bundle (not just the portfolio row).

Verification commands to confirm both pre-conditions:

```text
npm run daemon:daily                        # external — Telegram. Watch for [drawdown-state strategy=<bid>] lines.
npm run brief:morning                       # stdout-only — confirm per-strategy panel renders.
npx tsx scripts/_paper_trading_review.ts    # optional cross-check that per-strategy state is consistent with live trades.
```

Once both pre-conditions hold, run the drop-backup command:

```text
npm run migrate:drawdown-state-history-per-strategy:drop-backup
```

The script is idempotent — running it when the backup is already absent is a no-op. The DROP runs in ~milliseconds (the backup table holds the pre-migration row count, typically <100 rows). No daemon-idle window is required since the backup is not touched by any live process. After drop-backup completes, the rollback option is gone — any forward fix must come from re-deriving state from `live_trades` + regime history.

Rollback procedure (only valid BEFORE `--drop-backup` runs): if verification surfaces a problem (e.g. the daemon flipped but per-strategy writes are obviously wrong, or the brief panel renders incorrect values), restore the pre-migration state via atomic two-table RENAME:

```sql
RENAME TABLE
  quantlab.drawdown_state_history          TO quantlab.drawdown_state_history_failed_new,
  quantlab.drawdown_state_history_v0_backup TO quantlab.drawdown_state_history;
```

After the swap-back, the daemon's bootstrap probe will see `bundle_id` absent on the next run → repository constructed with `bundleIdColumnPresent: false` → portfolio-only path → matches pre-Phase-C behavior. Inspect `quantlab.drawdown_state_history_failed_new` to diagnose, then DROP it once the issue is understood.

Post-drop terminal state, after `--drop-backup` runs successfully:

- `quantlab.drawdown_state_history` carries the new sort key + `bundle_id` column (post-Phase-C).
- `quantlab.drawdown_state_history_v0_backup` does NOT exist.
- Daemon continues writing N+1 rows per run.
- Phase C is fully closed; further changes to the table require a new migration script.

---

## §9 · Module surface

### §9.1 Functions

```typescript
// src/server/drawdown_state.ts — existing portfolio surface preserved.

// NEW: per-strategy evaluation API. Same shape as evaluateDrawdownState
// but scoped to a single bundleId.
export function evaluateStrategyDrawdownState(inputs: StrategyDrawdownStateInputs): DrawdownStateResult;

export interface StrategyDrawdownStateInputs {
  /** Closed trades pre-filtered by source AND by bundleId. */
  closedTrades: LiveTradeRow[];
  asOf: Date;
  /** Portfolio capital — see §5.2 for rationale. */
  deployedCapitalUsd: number;
  source: 'paper' | 'live';
  stage: DeploymentStage;
  /** Per-strategy prior history; same ASC ordering as portfolio. */
  priorHistory: DrawdownStateRow[];
  regimeRedDays30: number;
  /** Strategy identifier (e.g. 'mean_reversion_v1'); used for threshold lookup. */
  bundleId: string;
}

// NEW: per-strategy threshold tables. Lookup keyed by bundleId; throws on
// unknown strategy (no silent fallback per §4.6).
export function entryThresholdsForStrategy(
  bundleId: string,
): { 1: number; 2: number; 3: number; 4: number; 5: number };

export function exitThresholdsForStrategy(
  bundleId: string,
): { 1: { pct: number; days: number }; 2: ...; 3: ...; 4: ... };

// NEW: minor convenience — derives bundleIds from a trade list.
export function bundleIdsFromTrades(trades: LiveTradeRow[]): string[];
```

```typescript
// src/server/drawdown_state_repository.ts — extended.

// Existing methods unchanged in signature, but internally write/query with
// bundle_id='' for portfolio-scope.

// NEW: per-strategy variants.
async writeEvaluationPerStrategy(input: DrawdownStateWriteInput & { bundleId: string }): Promise<void>;

async loadPriorHistoryPerStrategy(opts: {
  source: 'paper' | 'live';
  bundleId: string;
  limit?: number;
}): Promise<DrawdownStateRow[]>;

async loadLatestPerStrategy(opts: {
  source: 'paper' | 'live';
  bundleId: string;
}): Promise<DrawdownStateRow | null>;

// NEW: load latest per-strategy + portfolio in one round-trip for morning brief.
async loadLatestAllScopes(opts: {
  source: 'paper' | 'live';
}): Promise<{
  portfolio: DrawdownStateRow | null;
  perStrategy: Record<string, DrawdownStateRow>;
}>;
```

### §9.2 Threshold constants (byte-pinned via test)

```typescript
// Per-strategy threshold tables. Byte-pinned by tests (see §11).
// Values: pre-s74 × ratio, rounded to nearest 0.5%, -0.5% operational floor.
// mr_v1 ratio = 0.297 (s74); trend_v1 ratio = 0.110 (s75).
export const STRATEGY_ENTRY_THRESHOLDS = Object.freeze({
  mean_reversion_v1: Object.freeze({
    1: -0.01,  2: -0.02,  3: -0.035, 4: -0.055, 5: -0.20,
  }),
  trend_v1: Object.freeze({
    1: -0.005, 2: -0.005, 3: -0.015, 4: -0.02,  5: -0.20,
  }),
} as const);

export const STRATEGY_EXIT_THRESHOLDS = Object.freeze({
  mean_reversion_v1: Object.freeze({
    1: { pct: -0.005, days: 5 },
    2: { pct: -0.015, days: 5 },
    3: { pct: -0.03,  days: 5 },
    4: { pct: -0.045, days: 10 },
  }),
  trend_v1: Object.freeze({
    1: { pct: -0.005, days: 5 },
    2: { pct: -0.005, days: 5 },
    3: { pct: -0.01,  days: 5 },
    4: { pct: -0.015, days: 10 },
  }),
} as const);
```

### §9.3 Wire-up points

| Caller                          | What it calls                                                |
|---------------------------------|--------------------------------------------------------------|
| `daily_signal_daemon.ts`        | `evaluateDrawdownState` (portfolio) + `evaluateStrategyDrawdownState` per distinct bundleId; persists N+1 rows |
| `daemon_live_trades.ts`         | At cell-level dispatch, `min(portfolioMultiplier, strategyMultiplier[cell.bundleId])` |
| `operator_brief.ts`             | Reads `loadLatestAllScopes` for portfolio + per-strategy section |
| `capital_deployment_config.ts`  | UNCHANGED — stage3.failDrawdown still reads portfolio state via `isLevel3EntryEvent` |

---

## §10 · Failure modes

- **Unknown bundleId.** `entryThresholdsForStrategy('unknown')` throws. No silent fallback — adding a strategy to production without measuring its SD ratio must fail loud.
- **All trades from one strategy, none from the other.** Per-strategy state for the absent strategy returns Level 0 with `drawdown_30d_pct = 0`, `partialWindow = false`. The strategy genuinely has no losses (and no wins) in the window.
- **Mixed-source trades in per-strategy input.** Same contract as parent SPEC §5: caller filters by source BEFORE bundle. Repository's per-strategy load methods enforce single-source.
- **Per-strategy `priorHistory` empty (fresh column).** First per-strategy evaluation. `prevLevel = 0`; recovery hysteresis requires N prior rows so cannot fire on first eval; down-transitions can. Same conservative-by-design semantics as parent SPEC.
- **Portfolio at L4/L5 with a strategy at L0.** `min` composition: cell sizing = 0× (portfolio wins), entry blocked. The strategy's L0 state is irrelevant operationally; it still gets persisted to history for audit/demotion-detector consumption.
- **Strategy at L5 with portfolio at L0.** The strategy's cells get sizing 0× and entries blocked. The other strategy's cells continue normally. The halt sentinel is NOT written.
- **`bundleId` derivation from `cellKey` returns empty / wrong.** If `cellKey.split('|')[0]` is unexpected (a bug elsewhere), the daemon would create per-strategy rows for the spurious bundleId. Mitigation: validate `bundleId ∈ STRATEGY_ENTRY_THRESHOLDS` keys at evaluation time; throw if not.
- **Migration not yet run.** Repository's per-strategy methods detect missing `bundle_id` column via `system.columns` query; graceful degrade — daemon proceeds with portfolio-only evaluation, anomalies-log a warning. Same pattern as the existing `drawdownStateHistoryTableExists` gate.

---

## §11 · Test plan

Pure-function tests in `scripts/tests/drawdownStateStrategy.test.ts` (new file). Repository tests in `scripts/tests/drawdownStateRepository.test.ts` (extension).

**Note:** dd values reflect the §4.2 per-strategy thresholds; if a future amendment re-calibrates, the test inputs scale alongside.

| #  | Test                                                                                          | Pinned behavior |
|----|-----------------------------------------------------------------------------------------------|-----------------|
| 1  | `entryThresholdsForStrategy('mean_reversion_v1')`                                             | returns mr_v1 table (byte-pin §4.2)
| 2  | `entryThresholdsForStrategy('trend_v1')`                                                      | returns trend_v1 table (byte-pin §4.2)
| 3  | `entryThresholdsForStrategy('unknown')`                                                       | throws
| 4  | `evaluateStrategyDrawdownState` — mr_v1 trades summing -$200/10000, bundleId='mean_reversion_v1' | level 1 (entry threshold -0.01)
| 5  | Same trades, bundleId='trend_v1' (mis-tagged)                                                 | level 2 under trend_v1's floor-collapsed table (drawdown -0.02 ≤ both L1 and L2 entry at -0.005)
| 6  | `evaluateStrategyDrawdownState` — empty closedTrades                                          | level 0, drawdown 0, partialWindow false
| 7  | `bundleIdsFromTrades([mr, mr, trend, mr])`                                                    | returns ['mean_reversion_v1', 'trend_v1'] sorted
| 8  | `bundleIdsFromTrades([])`                                                                     | returns []
| 9  | Per-strategy `priorHistory` empty                                                             | level computed from drawdown only; recovery cannot fire
| 10 | Per-strategy hysteresis — 5 consec rows at mr_v1 L2 with dd > exit threshold + today recovered | level → 1
| 11 | Per-strategy hysteresis — mixed mr_v1 + trend_v1 history rows (shouldn't happen) reach evaluator | only matching bundleId rows count toward recovery — implementation MUST filter via the repository, not the evaluator
| 12 | Per-strategy `regimeRedDays30 ≥ 14` at L2 entry                                                | regimeExplained = true (same as portfolio)
| 13 | Portfolio L0 + strategy L3                                                                    | morning brief shows portfolio: level 0, strategy: level 3
| 14 | Daemon `min` composition — portfolio L0 (1.0×) + mr_v1 L3 (0.5×) + trend_v1 L0 (1.0×)         | mr_v1 cells get effectiveMultiplier 0.5; trend_v1 cells get 1.0
| 15 | Daemon `min` composition — portfolio L3 (0.5×) + mr_v1 L0 (1.0×)                              | mr_v1 cells get 0.5 (portfolio dominates)
| 16 | Daemon `min` composition — portfolio L4 (0.0×) + any strategy state                            | all cells get 0.0 (portfolio wins)
| 17 | Per-strategy L5 entry                                                                          | sizing 0×, newEntries=false for that strategy; halt sentinel NOT written
| 18 | Portfolio L5 entry (existing path)                                                             | sizing 0× portfolio-wide; halt sentinel IS written (existing behavior preserved)
| 19 | `STRATEGY_ENTRY_THRESHOLDS` byte-pin                                                           | matches §4.2 mr_v1 + trend_v1 tables exactly
| 20 | `STRATEGY_EXIT_THRESHOLDS` byte-pin                                                            | matches §4.2 exit tables exactly
| 21 | Repository write-then-read per-strategy round-trip                                             | persisted row deserializes to identical fields
| 22 | Repository `loadLatestAllScopes` with portfolio + 2 strategies persisted                       | returns portfolio + 2-entry perStrategy map keyed by bundleId
| 23 | Repository `loadPriorHistoryPerStrategy(bundleId='mean_reversion_v1')`                         | returns ONLY rows where bundle_id='mean_reversion_v1' (NOT '' rows)
| 24 | Repository `loadPriorHistory` (existing portfolio method)                                      | returns ONLY rows where bundle_id='' (portfolio sentinel) — preserves existing semantics
| 25 | Migration script `--dry-run`                                                                   | prints planned ALTER + table-rename steps; no DDL executed
| 26 | Migration script `--apply` against fresh table                                                 | end state has bundle_id column with default '' and new ORDER BY
| 27 | Pre-migration daemon run (column absent)                                                       | logs anomaly, falls back to portfolio-only evaluation, does not crash

A separate cross-SPEC byte-equality test: `STRATEGY_ENTRY_THRESHOLDS['mean_reversion_v1'][5]` and `STRATEGY_ENTRY_THRESHOLDS['trend_v1'][5]` both equal `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5]` (= -0.20 = `A5_KILL_THRESHOLD_PCT / 100`). Drift fails CI.

---

## §12 · Calibration data + retune protocol

Two retunes need to land together at the parent SPEC's §12 milestone (~2026-08-29 earliest):

1. **Portfolio quantile retune** (parent SPEC §12, unchanged).
2. **Per-strategy quantile retune** (new): pin per-strategy entry/exit thresholds from the empirical per-strategy `drawdown_30d_pct` distributions in `drawdown_state_history WHERE bundle_id = '<bundleId>'`.

The retune ADR (ADR-040+) supersedes both this §4 and the parent's §4.2 with empirical pins. Until then, both stopgaps are byte-pinned and CI-enforced.

---

## §13 · Out of scope

- **Strategy demotion / allowlist removal.** [`strategy-demotion.md`](../obsidian/gaps/strategy-demotion.md) gap doc. Per-strategy dd state is the SIGNAL that demotion would consume; the demotion ACTION is separate.
- **Per-cell drawdown levels.** Cell variance too tight to drive distinct ladders.
- **Per-strategy ADR-039 stage gates.** Stage rollback stays portfolio-scope.
- **Per-strategy A1-A3 kill criteria.** Future amendment if needed.
- **Per-strategy capital accounting.** §5.2 explains why portfolio capital is the denominator; introducing per-strategy capital is a separate, larger workstream.
- **Per-strategy regime classifier.** Regime is portfolio-wide; per-strategy state inherits.
- **Cross-strategy correlation gates.** A4 already exists; the §4.2 ρ-doubles-under-sizer finding is informational, not actionable here.
- **Retroactive per-strategy history backfill.** Pre-migration rows are portfolio-only; per-strategy series begins at migration cut-over. A separate one-off script could reconstruct historical per-strategy levels from `live_trades` if needed, but is not part of this SPEC.

---

## §14 · Open questions (deferred to CODE slice or to amendment ADR)

1. **Should per-strategy L4/L5 halts auto-clear when the strategy's dd recovers?** Per parent SPEC §3, portfolio L4 has auto-recovery (10 consec days above exit threshold) but L5 is terminal. Per-strategy L5 mirrors that. But: if a single strategy hits L5 and the operator does NOT want to clear it manually (preferring to let the strategy stay halted permanently as a soft-demotion), is the auto-recovery-on-portfolio-L4 still the right default? Recommend per-strategy L5 stays terminal until operator clears, same as portfolio L5. Resolve in CODE slice.
2. **Migration sequencing under live daemon traffic.** The table-rename approach in §8.1 requires either a maintenance window or a dual-write transition. Recommend maintenance window — the daemon runs once daily; pause one daily run, migrate, resume. Operator-decision.
3. **What if a new strategy ships before §12 retune?** Per-strategy ratio must be measured (sweep) before per-strategy thresholds can pin. Until then, the new strategy must run with the portfolio-blended thresholds as fallback OR throw at evaluation. Recommend throw — adding a strategy without calibration is a methodology mistake worth surfacing loudly.
4. **Should `loadLatestAllScopes` cache results within a daemon run?** N+1 queries per morning-brief render. Recommend yes — one combined query that GROUPs BY bundle_id. CODE-slice decision.
5. **`bundle_id = ''` vs explicit `'__portfolio__'` sentinel.** Empty-string is cheaper but a bit magic. Recommend keep empty-string for consistency with `regime_at_entry`; add a `BUNDLE_ID_PORTFOLIO_SENTINEL = ''` exported constant so callers do not literal-string the sentinel.

These do NOT block the SPEC. Decisions deferred to the CODE slice or the first calibration retune.

---

## §15 · References

- [`docs/specs/drawdown-response-framework.md`](drawdown-response-framework.md) — parent SPEC; §3 state machine, §4.2 portfolio thresholds, §5 measurement, §7 integration, §11 test pattern
- [`docs/obsidian/gaps/strategy-demotion.md`](../obsidian/gaps/strategy-demotion.md) — downstream consumer; performance-decay trigger
- [`docs/obsidian/gaps/drawdown-response-framework.md`](../obsidian/gaps/drawdown-response-framework.md) — original gap doc (superseded by parent SPEC); this SPEC extends
- [`docs/decisions/README.md`](../decisions/README.md) ADR-039 — capital deployment ramp; portfolio anchor preserved
- [`src/server/paper_trading_dashboard.ts`](../../src/server/paper_trading_dashboard.ts) §`parseCellKey`, `deriveCellLabel` — bundleId derivation convention
- [`src/server/paper_trading_kill_criteria.ts`](../../src/server/paper_trading_kill_criteria.ts) §A4 — precedent for per-bundle P&L bucketing
- [`src/server/drawdown_state.ts`](../../src/server/drawdown_state.ts) — current portfolio implementation; surface extended in §9.1
- [`src/server/drawdown_state_repository.ts`](../../src/server/drawdown_state_repository.ts) — current persistence; extended in §9.1
- [`scripts/_threshold_stability_sweep.ts`](../../scripts/_threshold_stability_sweep.ts) — s74 mr_v1 ratio measurement
- [`scripts/_threshold_stability_sweep_trend_v1.ts`](../../scripts/_threshold_stability_sweep_trend_v1.ts) — s75 trend_v1 ratio measurement
- [`scripts/_threshold_stability_sweep_blended.ts`](../../scripts/_threshold_stability_sweep_blended.ts) — s76 blended sweep (portfolio scope reference)
- Pardo 2008 *Evaluation and Optimization of Trading Strategies* chapter 11 — σ-band operator-state response design; per-strategy thresholds apply the same logic at strategy scope
- López de Prado 2018 *Advances in Financial Machine Learning* chapter 11 — strategy decay framing; the per-strategy dd state is the canonical input

---

## §16 · What could break this

- **Per-strategy threshold drift between §4.2 and `STRATEGY_ENTRY_THRESHOLDS` constants.** Mitigation: byte-pinned tests #19, #20.
- **Adding a strategy without measuring its SD ratio.** Mitigation: `entryThresholdsForStrategy` throws on unknown bundleId; CI will catch the first production-path call.
- **`bundleId` typos at trade entry that produce ghost strategies.** Mitigation: validate `bundleId ∈ STRATEGY_ENTRY_THRESHOLDS` keys at daemon's per-strategy evaluation loop; throw with a clear message rather than persist a row for the typo.
- **Migration not atomic** — the table-rename step is a destructive op. Mitigation: dry-run validates the planned steps; operator-authorization required for apply; the old table is renamed (not dropped) for one full daemon-cycle before drop.
- **Repository `loadPriorHistory` (portfolio) accidentally returns per-strategy rows.** Mitigation: test #24 byte-pins the WHERE bundle_id = '' filter; test #23 byte-pins the per-strategy filter.
- **`min` composition order error in daemon.** Mitigation: test #14, #15, #16 cover the cross-product of portfolio + per-strategy multipliers; CI fails on regression.
- **Per-strategy L5 silently writing the halt sentinel.** Mitigation: test #17 pins "halt sentinel NOT written"; test #18 pins "portfolio L5 still writes."
- **Strategy-demotion gap doc's eventual implementation reading the wrong column.** Mitigation: this SPEC is a reference in [`strategy-demotion.md`](../obsidian/gaps/strategy-demotion.md); the doc should cite `bundle_id != ''` as the per-strategy filter explicitly when it ships.
- **Caller passing portfolio capital × strategy weight as `deployedCapitalUsd`.** Mitigation: §5.2 documents the convention; the framework cannot detect this. The recommended pattern is a helper co-located with `getStageConfig` (matching parent SPEC's session-53 watch-out).
- **Per-strategy thresholds inherit the parent SPEC's `pre-s74 anchor × ratio` derivation.** If a future amendment changes the pre-s74 anchors (it shouldn't — they're historical), the per-strategy values silently go stale. Mitigation: the threshold constants are byte-pinned per-strategy; if parent SPEC's anchors ever change, both SPECs amend in the same PR.
- **§12 retune fires only against portfolio quantiles, leaving per-strategy thresholds stale.** Mitigation: §12 in THIS SPEC mandates per-strategy retune alongside portfolio retune. CODE-slice for the retune must produce BOTH or fail CI.
