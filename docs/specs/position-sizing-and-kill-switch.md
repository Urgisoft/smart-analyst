# SPEC — Position sizing & kill-switch infrastructure (paper→live precondition)

**Status:** Draft · **Date:** 2026-05-07 · **Author:** Vector Core engineering session

**Scope:** The minimum infrastructure required to transition `mr_v1 / equity_midcap / 1d` (30/70 post-shakedown) from paper trading to real money, without building the full PaperBroker / LiveBroker abstraction. This is a deliberate-spike spec — production-grade infrastructure is acknowledged in §11 and out of scope here.

**Source:** Kelly (1956), *A New Interpretation of Information Rate*. Thorp (1969 / 2017 *A Man for All Markets*) on fractional Kelly. Perold & Sharpe (1988), *Dynamic Strategies for Asset Allocation*, *Financial Analysts Journal*. López de Prado AFML (2018) Ch. 17 (risk-budgeting). Aronson EBTA (2006) Ch. 7 (fee floor for sizing decisions). Project ADRs 027-033.

---

## §1 · Goals and non-goals

### Goals

1. **Limit single-trade catastrophic loss.** Backtest worst single trade is -64.9% (30/70 baseline). Without sizing, that's -64.9% of total capital on one trade. The spec's first job is to make any single-trade tail loss bounded at ≤ −2% of total portfolio capital.
2. **Cap simultaneous open positions.** Currently the daemon iterates all 60 tokens independently and could in principle hold 60 simultaneous positions at 100% capital each — i.e. 60× total leverage, which is impossible but conceptually exposes the system to undefined behaviour.
3. **Codify the kill-switch criteria** from `.claude/HANDOFF.md` (A1-A6, B1-B3, C1-C3) as machine-checkable conditions, with auto-halt rather than operator-vigilance.
4. **Preserve backtest-vs-live comparability.** Whatever sizing layer ships in production must also be applicable in backtest, so historical OOS metrics remain valid for the deployed configuration.

### Non-goals

1. Building a full PaperBroker / LiveBroker abstraction.
2. Multi-strategy portfolio optimisation (Markowitz, risk-parity across cells, etc.).
3. Real-money execution adapter (broker API integration). Real-money trading is out-of-scope until paper validates.
4. Tax-aware position management.
5. Multi-asset-class (crypto + equity) portfolio sizing.

## §2 · Current state — what's missing

[scripts/daily_signal_daemon.ts](../../scripts/daily_signal_daemon.ts) and [src/lib/indicators.ts](../../src/lib/indicators.ts) currently have:

```typescript
// inside runMeanReversionBacktest:
position = { entryPrice: candle.close, size: balance / candle.close, ... }
// → 100% of the cell's capital allocated to one trade, no stop-loss
```

Specifically absent:
- Position-size logic (always 100%)
- Stop-loss exits (only RSI-based exits)
- Per-position max-loss bound (no tail-event circuit-breaker)
- Portfolio-level concurrent-position cap
- Auto-halt on kill-criteria triggers
- Persistent risk-state tracking across daemon runs

## §3 · Target state — minimal viable

Three components, layered:

### (A) Position-sizer

Pure function that takes (signal, capital, risk_config, market_state) and returns a position size. No state of its own.

```typescript
interface SizingInputs {
  totalCapital: number;          // total portfolio NAV at entry
  cellCapital: number;           // capital allocated to this cell (e.g. cellCapital = totalCapital / nCells)
  entryPrice: number;
  stopPrice: number;             // computed stop-loss price (see §3B)
  maxRiskPerTrade: number;       // fraction of total capital, e.g. 0.02 for 2%
}
interface SizingOutputs {
  shares: number;                // number of shares to buy
  notional: number;              // shares × entryPrice
  riskUsd: number;               // worst-case loss = shares × (entryPrice − stopPrice)
}

function sizePositionFixedRisk(in: SizingInputs): SizingOutputs;
```

**Default rule (recommended for mr_v1):** **Fixed-fractional risk per trade.**
- `riskUsd = totalCapital × maxRiskPerTrade` (e.g. $200 on $10,000 portfolio at 2% risk per trade)
- `shares = riskUsd / (entryPrice − stopPrice)`
- `notional = shares × entryPrice`
- If `notional > cellCapital`, clamp shares so `notional = cellCapital` (sizing is risk-bounded *and* capital-bounded).

**Why fixed-fractional, not Kelly:** Kelly requires accurate `(p, win/loss ratio)` estimates and is destructive when those estimates are off. For mr_v1/p=14 30/70, the empirical numbers (WR 77.7%, mean win 6.75%, n=710) give a *full Kelly* of roughly 30% per trade, which is far too aggressive given parameter uncertainty and the 12y sample. Thorp recommends fractional Kelly (½ to ¼ of full) when estimates are uncertain. Fixed 2% per trade is approximately ¼ Kelly here, conservative and operator-tunable.

**Configuration:**
- `maxRiskPerTrade: number` — default 0.02 (2% per trade). Live operator can lower without code changes.
- `feeReserve: number` — reserve fraction for fees. Default 0.005 (0.5%).

### (B) Stop-loss layer

Pure function that takes (entry_price, market_state) and returns a stop-loss price.

```typescript
interface StopInputs {
  entryPrice: number;
  atr14: number;                 // 14-day ATR at entry; standard volatility measure
  config: {
    atrMultiple: number;         // default 2.5
    fixedPctFloor: number;       // default 0.05 (5% — never wider than 5%)
  };
}

function computeStop(in: StopInputs): { stopPrice: number; method: 'atr' | 'fixed' };
```

**Default rule:** `stopPrice = max(entryPrice − atrMultiple × atr14, entryPrice × (1 − fixedPctFloor))`. ATR-based stops adapt to volatility regime; the fixed-pct floor caps the worst case at 5% adverse move per trade.

This decouples stop calibration from strategy logic. The same stop function works for any cell.

### (C) Kill-switch monitor

Stateful component that runs at the END of each daemon run, evaluates the kill criteria from HANDOFF §"Kill criteria for the paper-trading shakedown", and either:
- Returns `OK` → daemon proceeds normally next run.
- Returns `HALT` → writes a halt sentinel file (e.g. `.daemon_halt`), which the daemon checks at startup and refuses to run until the sentinel is removed by an operator.

```typescript
interface KillCheckInputs {
  recentRuns: Array<{
    runId: string;
    timestamp: Date;
    perCellResults: Map<string, CellResult>;   // existing daemon output
  }>;
  liveTradeHistory: ClosedTrade[];             // from quantlab.live_trades (new table, see §5)
  config: KillSwitchConfig;
}

interface KillCheckResult {
  status: 'OK' | 'HALT';
  triggeredCriteria: string[];                 // e.g. ['A2', 'B1']
  diagnostic: string;                          // human-readable reason
}

function checkKillCriteria(in: KillCheckInputs): KillCheckResult;
```

**Triggers (from HANDOFF kill criteria):**
- A1-A6 (statistical degradation): require ≥ N closed trades for triggering.
- B1-B3 (signal-quality red flags): can trigger on a single run.
- C1-C3 (pipeline failure): observed by the daemon's run loop directly.

**Halt protocol (already in HANDOFF):** stop the daemon, write a triage doc, decide fix-and-resume vs accept vs reject. The kill-switch monitor's job is to ENFORCE the halt, not decide what comes next — that's an operator decision.

## §4 · Integration with the existing daemon

The daemon's main loop becomes:

```
1. Pre-flight: check halt sentinel; abort if present.
2. yfinance fetch (existing)
3. For each cell, for each ticker:
   a. runStrategy → trades, equity, signal_at_close
   b. If new entry signal:
      stop_price = computeStop(...)
      sizing    = sizePositionFixedRisk(...)
      record proposed_position {ticker, shares, stop_price, sizing}
   c. If new exit signal: record proposed_exit {ticker, ...}
4. Aggregate: sum proposed positions; check portfolio-level constraints
   (max concurrent positions, max gross exposure).
5. Apply approved actions to live_trades table (new — see §5).
6. Run kill-switch monitor on all data including this run.
7. If HALT: write sentinel, send Telegram halt notice, exit.
8. Compose + send daily report (existing, augmented with sizing/risk info).
```

The existing `live_signals` table records *state* (long/flat). A new `live_trades` table records the *executed action ledger* (entries, exits, sizes, stops, P&L). They serve different purposes; both are needed.

## §5 · Schema additions

### New table: `quantlab.live_trades`

```sql
CREATE TABLE quantlab.live_trades (
  trade_id        UUID,
  run_id          UUID,                    -- daemon run that opened or closed
  cell_key        String,                  -- e.g. mean_reversion_v1|equity_midcap|1d|14
  token_address   String,
  symbol          String,
  side            Enum8('buy'=1, 'sell'=2),
  entry_ts        DateTime,
  entry_price     Float64,
  exit_ts         Nullable(DateTime),
  exit_price      Nullable(Float64),
  shares          Float64,
  notional_usd    Float64,
  stop_price      Float64,
  fees_usd        Float64,
  realized_pnl_usd Nullable(Float64),
  exit_reason     Nullable(Enum8(
    'rsi_exit'=1, 'stop_loss'=2, 'kill_switch'=3,
    'cell_halt'=4, 'rebalance'=5, 'final_bar'=6
  )),
  created_at      DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (cell_key, token_address, entry_ts);
```

Trade lifecycle: insert with `exit_*` NULL on entry; update with exit info on close. ReplacingMergeTree dedupes on `(cell_key, token_address, entry_ts)` if the same trade is reported twice; `created_at` is the version key.

### Halt sentinel: filesystem, not DB

A simple `.daemon_halt` file in the project root, with content describing the trigger reason. Daemon checks for this at startup. Halts cleanly until operator removes the file.

## §6 · Configuration

A new file `config/risk.yml` (or env vars):

```yaml
position_sizing:
  max_risk_per_trade: 0.02          # 2% of total capital per trade
  fee_reserve: 0.005                # 0.5% reserved for fees
  max_concurrent_positions_per_cell: 10
  max_concurrent_positions_total: 20
  max_gross_exposure_pct: 1.0       # 100% — no leverage

stop_loss:
  atr_period: 14
  atr_multiple: 2.5
  fixed_pct_floor: 0.05             # never tighter than 5%

kill_switch:
  min_trades_for_a_criteria: 10     # A1, A4 require sample size before firing
  rolling_window_a1_days: 90
  rolling_window_a4_days: 30
  consecutive_pipeline_fails_b3: 1
  consecutive_telegram_fails_c1: 3

operator:
  telegram_halt_chat_id: ${TELEGRAM_ALERT_CHAT_ID}
```

## §7 · Failure modes

| Mode | Detection | Response |
|---|---|---|
| Sizer returns 0 shares (sub-1-share notional) | `shares < 1` | Skip the trade with `[size=0]` log entry. Not a halt. |
| ATR computation fails (insufficient history) | `atr14 === undefined` or `< 0` | Use `fixed_pct_floor` for stop. Log `[stop=fixed]`. |
| Stop price ≥ entry price (data error) | `stopPrice >= entryPrice` | Skip the trade, log error. Possible price data corruption. |
| Halt sentinel exists but operator forgot to remove | Daemon startup check | Refuse to run, print sentinel content. Operator removes file when ready. |
| Kill-switch monitor itself errors | catch block | Treat as HALT (fail-closed); operator must investigate. |
| Live trade record fails to write to CH | catch on insert | Halt (fail-closed); state is inconsistent and continuing would corrupt the audit trail. |
| Concurrent-position cap exceeded | aggregate check in step 4 | Reject lower-priority signals; record `cap_exceeded` events for review. |

## §8 · Test plan

### Unit tests (new file `scripts/tests/positionSizing.test.ts`)

- `sizePositionFixedRisk` produces correct shares for canonical inputs ($10k, 2% risk, $100 entry, $95 stop → 40 shares).
- Zero-distance stop (entry==stop) produces 0 shares without divide-by-zero.
- Risk-cap and capital-cap both binding produces the smaller of the two.
- Negative inputs throw.
- `computeStop` ATR-based vs fixed-floor selects the higher-priced stop (i.e. tighter).
- ATR=NaN falls back to fixed-floor.
- `checkKillCriteria` triggers on each criterion in isolation (A1-A6, B1-B3, C1-C3).
- `checkKillCriteria` does NOT trigger when below `min_trades_for_a_criteria`.

### Integration tests (extending `scripts/tests/liveSignalState.test.ts`)

- Daemon happy path with sizing layer: 1 entry signal → 1 position recorded with correct sizing.
- Daemon entry signal with stop_price ≥ entry_price → trade skipped, error logged.
- Halt sentinel present at startup → daemon exits cleanly without running pipeline.
- Kill-switch triggers A2 → halt sentinel written, Telegram notified, exit code 1.
- Concurrent-position cap exceeded → signals rejected in priority order, count = cap.

## §9 · Migration path

Sequence (each step shippable independently):

1. **Add `live_trades` table migration** — idempotent CREATE IF NOT EXISTS, similar to `migrate_live_signals.ts`. Daemon does NOT yet write to it.
2. **Add position-sizer + stop-loss as pure modules** in `src/lib/risk.ts`. No daemon integration yet. Unit tests pass.
3. **Refactor backtest to optionally consume the sizing layer.** Backwards-compatible: existing tests still pass at default config (100% capital, no stop). New config flag `--use-risk-config` enables the sizing layer.
4. **Re-run threshold-stability sweep with sizing layer.** Confirm OOS metrics are stable under the new sizing (Sharpe should drop because lower notional = lower returns, but risk-adjusted profile should be similar).
5. **Daemon integration** — daemon writes proposed entries/exits to `live_trades`, applies the sizing layer, respects portfolio caps. Keeps writing to `live_signals` for backwards compatibility.
6. **Add kill-switch monitor as a post-run hook.** Initially DISABLED in config (monitor runs but doesn't halt) for one week, to validate the trigger logic against real data without blocking the shakedown. Then ENABLE.
7. **Add halt sentinel logic** to daemon startup. After 1 week of disabled monitor, enable.

The user can stop at any step and still have a coherent system.

### §9.4 execution log — sweep run 2026-05-16 (session 58)

**Verdict: ✓ PRESERVED.** Spearman ρ on Sharpe rank across the 15 (entry, exit) cells between LEGACY (`useRiskConfig=false`, 100% capital, no stop) and SIZER (`useRiskConfig=true`, DEFAULT_RISK_CONFIG: 2% risk / ATR(14)×2.5 stop / 5% fixed-pct floor) = **0.921**. Top 5 by Sharpe are the **same 5 cells** in both variants with one ordering swap; the deployed (30/60) cell ranks 10/15 (legacy) and 11/15 (sizer), confirming the prior finding that the deployed cell sits in the middle of the surface, not on a peak.

Mean% rank correlation = 0.989; port_DD rank correlation = 0.900. All three signals agree.

| Rank | LEGACY top 5 | SIZER top 5 |
| --- | --- | --- |
| 1 | (35/75) Sharpe=0.757 | (35/75) Sharpe=0.635 |
| 2 | (25/75) Sharpe=0.679 | (30/75) Sharpe=0.628 |
| 3 | (30/75) Sharpe=0.646 | (25/75) Sharpe=0.599 |
| 4 | (35/70) Sharpe=0.584 | (30/70) Sharpe=0.508 |
| 5 | (30/70) Sharpe=0.553 | (35/70) Sharpe=0.474 |

**Sharpe spread under sizer is slightly WIDER than legacy** (0.632 vs 0.536). Counterintuitive at first glance but consistent: the sizer's stop converts deep losers into shallow losers, which surfaces the underlying edge differential between cells more clearly. Cells that depended on fat-tailed wins to redeem fat-tailed losses (e.g. 35/55) are revealed as edge-less — sizer Sharpe = 0.003, legacy Sharpe = 0.235.

**WR% drops sharply** from ~70-81% (legacy) to ~25-44% (sizer). This is the SPEC §3B-intended behavior, **not a signal of edge erosion**:

- The ATR/floor stop cuts losing trades short instead of holding to the exit signal. Worst-case single-trade loss is clamped to ~-6.13% (5% floor × 1 + fee impact) across **every** sizer cell.
- Mean% per trade stays positive in every cell; raw EV is intact. The trade distribution reshapes: many small losses replace fewer big losses.
- A higher trade count under sizer (e.g. 30/60: 945 trades legacy vs 2,056 trades sizer) confirms the engine is re-entering after stop-outs more often than the legacy "ride to signal" path was closing positions.

**Deploy rate = 100% for all 30 cells (15 × 2 variants).** No token was iced out by sub-share rounding on the 1-share floor; the equity_midcap yfinance universe is liquid enough that 2% risk × $10k = $200 risk budget produces ≥1 share at all reasonable price points.

**Operational implication for §9 step 5/6:** Flipping the daemon evaluator to `useRiskConfig: true` does NOT scramble cell selection. Cells already promoted under legacy will mostly remain promoted under sizer; the deployed (30/60) cell remains mid-table (consistent with its prior CONDITIONAL grade per ADR-032). Re-promotion is **not required** before the flip — promotion-grade comparison is rank-stable.

**Operational implication for §6 kill-switch / drawdown framework:** Sizer port_DD compresses from -20.82..-29.43% (legacy) to -6.72..-14.63% (sizer). The drawdown-response-framework levels in [docs/specs/drawdown-response-framework.md](drawdown-response-framework.md) were calibrated **before** the sizer ramp landed; with the sizer attenuating portfolio DD by ~50%, the drawdown levels are now CONSERVATIVE relative to the actual deployable equity curve. This is the right direction (false alarms, not missed alarms) but worth a follow-up calibration review if the daemon spends an extended period at level 1+ without operational stress.

Reproduce: `npx tsx scripts/_threshold_stability_sweep.ts` (read-only, ~2 minutes).

### §9.5 enforce-mode flip readiness — HALT smoke test (session 59)

The dev-side gate on the §9 step 6 enforce-mode flip (`enforce: true` in `runHaltMonitor`) is a synthetic-condition rehearsal of the full kill-switch pipeline: evaluator → halt-monitor → real-fs sentinel write → pre-flight read → resume on delete. Unit tests cover each layer with stubbed IO; this rehearsal exercises the **integration on the REAL filesystem with SYNTHETIC kill-trigger fixtures that breach each locked threshold** — the failure mode unit tests cannot catch.

Run: `npx tsx scripts/_halt_smoke_test.ts` (read-only, <5 seconds, exit code 0 on full pass).

**Isolation contract.** The sentinel path is always under `os.tmpdir()` with a per-run UUID directory. The real `.daemon_halt` at the project root is never touched. The script does not construct a ClickHouse client, does not import `dotenv`, and does not spawn the daemon — it is safe to run on a host with a live paper-trading daemon.

**Scenarios (9 total).**

| # | Scenario | Trigger fixture | Pipeline assertion |
| --- | --- | --- | --- |
| 1 | `OK_baseline` | populated state, no closed trades | sentinel NOT written; pre-flight clear |
| 2 | `A2_worst_trade_breach` | one trade, notional=1000, pnl=-700 (pct=-70%) | A2 fail; sentinel written; pre-flight halt |
| 3 | `A3_max_dd_breach` | 4-trade sequence, capital=1000, equity 1100→700 (DD=-36%) | A3 fail; sentinel written; pre-flight halt |
| 4 | `A4_mr_trend_correlation_breach` | 20-trade ledger over 10 distinct UTC days; mr_v1 and trend_v1 each trade once per day with IDENTICAL pnl → Pearson=+1.000; per-trade notional=1000 so worst pct=-12.5% (clears A2); combined max DD=-2.83% on cap=10000 (clears A3); no pre-window trade so A5=insufficient_data | A4 fail; sentinel written; pre-flight halt |
| 5 | `A5_cum_pnl_breach` | 6-trade ledger (one >30d back to satisfy history guard, five in-window summing to -250 on cap=1000) | A5 fail; sentinel written; pre-flight halt |
| 6 | `C3_empty_live_signals` | `state.cells: []` | C3 fail; sentinel written; pre-flight halt |
| 7 | `multi_trigger_A2_A3_C3` | empty state + 2-trade ledger (worst -70%, DD -58%) | A2 + A3 + C3 all fail; order preserved as B1/A2/A3/A4/A5/C1/C3 |
| 8 | `observe_mode_no_write` | A2 fixture but `enforce: false` | A2 fail; sentinel NOT written; would-be content surfaced for logging |
| 9 | `resume_after_sentinel_delete` | direct sentinel write, then unlink | pre-flight halt before delete; pre-flight clear after |

**Coverage gaps (intentional).** B1 (NEW-ENTRY > 20) and C1 (Telegram fail 3 days running) are not exercised — both are still stub-pass paths in the current evaluator (`evaluateB1` and `evaluateC1` have no failable verdict). When either grows a real failable path, add a synthetic-fixture scenario here.

**What this gates.** The smoke test is a pre-condition for the operator's enforce-mode flip:

- PASS on every scenario → the pipeline is wired end-to-end; the flip's behavior is predictable.
- FAIL on any scenario → STOP. Investigate before flipping. A halt that doesn't halt is worse than no kill-switch.

**Verdict (2026-05-16, session 59).** Initial 8 scenarios PASS on the current `paper_trading_kill_criteria.ts` + `paper_trading_halt_monitor.ts` + `daemon_live_trades.ts` (pre-flight helper) versions. Verdict line: `pipeline wired end-to-end; enforce-mode flip behaviour predictable.` Dev-side gate cleared.

**Verdict (2026-05-16, session 60 — A4 coverage closure).** All 9 scenarios PASS after adding `A4_mr_trend_correlation_breach`. A4 fixture relies on identical-day-bucketed pnls between the two bundles to drive Pearson to +1.000 without tripping A2/A3/A5 — see `a4FixtureTrades()` in [scripts/_halt_smoke_test.ts](../../scripts/_halt_smoke_test.ts) for the day grid and pnl sequence. All five data-driven failable codes (A2/A3/A4/A5/C3) now have isolated single-trigger smoke coverage. Dev-side gate remains cleared; A4 coverage gap from session 59 closed.

## §10 · Out of scope (production-grade extensions)

- **PaperBroker / LiveBroker abstraction** — proper broker-side simulation with slippage, partial fills, order rejection, halts. Required for actual real-money deployment.
- **Vol-targeted position sizing** — size each position so it contributes equal *risk* (not capital) to the portfolio. Requires per-position vol forecast.
- **Cross-cell portfolio optimisation** — currently each cell gets a fixed capital allocation; production might want dynamic allocation based on relative cell performance.
- **Drawdown-conditional sizing** — reduce per-trade risk when the portfolio is in drawdown (Markowitz-Sharpe constant-mix variant).
- **Tax-loss harvesting** — irrelevant for paper, relevant for real money.
- **Position-aging logic** — auto-close positions held longer than N bars regardless of strategy signal.

These are all worth building — but only after the minimal-viable system has been live with paper for the full shakedown and proven robust.

## §11 · Estimated implementation cost

- Position-sizer + stop-loss pure modules + tests: **3-4 hours**
- `live_trades` table + migration: **1 hour**
- Daemon integration: **3-4 hours**
- Kill-switch monitor + tests: **2-3 hours**
- Halt sentinel + Telegram notify: **1 hour**
- Config loading + validation: **1 hour**

**Total: ~12-15 hours over 2-3 sessions.** Significantly less than the multi-week estimate for a full PaperBroker / LiveBroker spec.

The minimum to go live (without the kill-switch monitor or production polish): just the position-sizer and stop-loss layer plus daemon integration — **~7 hours**, ~1 focused session.
