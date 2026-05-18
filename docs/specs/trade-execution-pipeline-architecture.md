# SPEC — Trade Execution Pipeline Architecture (Component 7+ roadmap)

> **Status:** ARCHITECTURE / ROADMAP — produced from the 2026-05-11 RESEARCH+PUSHBACK turn (session 38 turn 3) · **Author:** producer (Claude) · **Authority:** [HANDOFF](../../.claude/HANDOFF.md), [ADR-027](../decisions/README.md), [ADR-037](../decisions/README.md), session-38 turn-3 user direction
>
> **Stage in Vector Core build:** ARCHITECTURE — captures user's stated end-state pipeline so subsequent component SPECs can target it. Not a single-component SPEC; rather, the design contract that Components 7-N implement against.

This document captures the **end-state trade execution pipeline** the user wants Vector Core to converge to. The current daemon (sessions 17-37) is the minimum viable shell. This SPEC names the gates that must sit between a strategy's "BUY" signal and a real position open, in the order they should fire.

---

## 1. The pipeline (end state)

Four gates, executed sequentially per (cell, candidate ticker) on each daemon run. Each gate is a hard veto — failing any gate skips the entry. Gates are ordered cheapest → most expensive.

```
   ┌──────────────────────────────────────────────────────────────┐
   │  Strategy primary fires "BUY" signal on (cell, ticker)       │
   └──────────────────────────────────────────────────────────────┘
                                ↓
   ┌──────────────────────────────────────────────────────────────┐
   │  GATE 1 — Backtest allowlist                                 │
   │  Is (strategy, param, ticker) on the per-cell allowlist?     │
   │  Source: quantlab.cell_allowlist (populated from bt_runs)    │
   │  Cheapest gate — pure lookup.                                │
   └──────────────────────────────────────────────────────────────┘
                                ↓ pass
   ┌──────────────────────────────────────────────────────────────┐
   │  GATE 2 — Regime conditional                                 │
   │  Does the current regime match conditions the allowlist      │
   │  was built under?                                            │
   │  Source: macro_regimes (today's row) + bt_runs_regime        │
   │  Blocked under phase1_v2 (classifier is colorblind to red).  │
   │  Unlocks when phase1_v3 ships (Sharadar OR fja05680).        │
   └──────────────────────────────────────────────────────────────┘
                                ↓ pass
   ┌──────────────────────────────────────────────────────────────┐
   │  GATE 3 — ML probability (meta-labeling)                     │
   │  Trained per (strategy, param) on labeled OOS trades.        │
   │  Predicts probability the trade hits profit target before    │
   │  stop loss. Veto if p < threshold.                           │
   │  Source: quantlab.strategy_meta_models (already exists from  │
   │  ADR-027 work).                                              │
   │  Currently DISABLED — ADR-027 showed lift -1.07pp on         │
   │  equity_midcap. May change with expanded universe.           │
   └──────────────────────────────────────────────────────────────┘
                                ↓ pass
   ┌──────────────────────────────────────────────────────────────┐
   │  GATE 4 — LLM qualitative validator                          │
   │  Claude reviews ticker context: earnings calendar, recent    │
   │  corporate actions, news, halts, obvious red flags.          │
   │  EXCLUSION-ONLY: can VETO an entry, never approve one        │
   │  that quant gates rejected.                                  │
   │  Source: Claude API + structured prompt + (optional) web     │
   │  search. Logged for retrospective evaluation.                │
   └──────────────────────────────────────────────────────────────┘
                                ↓ pass
   ┌──────────────────────────────────────────────────────────────┐
   │  Position sizing → Order routing → Open                      │
   └──────────────────────────────────────────────────────────────┘
```

**Existing positions are NOT force-closed by the gates.** The gates govern NEW entries only. Strategy-defined exits (stop-loss, take-profit, signal-reversal) continue to apply to open positions. An operator audit step (Component 7B below) surfaces positions on tokens not currently on the allowlist so the human can decide whether to close manually.

---

## 2. Why this order

Gates are ordered so the cheapest filter fires first. Each subsequent gate sees only the candidates the previous gate passed.

| Gate | Latency | Cost | Discriminative power |
|---|---|---|---|
| 1 — Allowlist | <1ms (CH lookup) | $0 | High when based on robust backtests |
| 2 — Regime | <10ms (CH lookup) | $0 | Medium; depends on regime classifier quality |
| 3 — ML | ~100ms (inference) | $0 (CPU) | Variable; only useful when primary has many false positives |
| 4 — LLM | seconds (API call) | ~$0.01/check | Qualitative; catches what numbers miss |

Putting the LLM gate last means: most candidates never reach it, so the API spend stays small. Putting the regime gate before the ML gate means: the ML model trained per regime doesn't get noise from candidates that already failed regime conditions.

---

## 3. Components — current state and what needs building

| Component | What | Status | SPEC |
|---|---|---|---|
| C-1 | Macro regime classifier | Shipped (phase1_v2, biased) | macro-regime-classifier-phase1.md |
| C-2 | Regime ingest pipeline | Shipped | (in classifier spec) |
| C-3 | Regime dashboard | Shipped | regime-dashboard-component3.md |
| C-4 | Operator morning brief | Shipped session 38 turn 2 | operator-morning-brief-component4.md |
| C-5 | bt_runs ↔ regime attribution | Shipped session 38 turn 1 | regime-backtest-attribution-component5.md |
| **C-7A** | **Per-cell allowlist + daemon filter** | **building this turn (session 38 turn 3)** | (this SPEC §4 below) |
| **C-7B** | **Allowlist audit + open-position reconciliation** | building this turn | (this SPEC §5 below) |
| C-8 | phase1_v3 — survivorship-corrected classifier | Pending (fja05680 OR Sharadar) | (existing rev3 amendment) |
| C-9 | Universe expansion (503 S&P tickers, then ETFs) | Planned | (TBD) |
| C-10 | ML meta-labeling gate at runtime | Pending — DISABLED at runtime; offline-validate first | (ADR-027 framing) |
| C-11 | LLM qualitative validator | Pending; SPEC §6 below | (TBD per this SPEC) |
| C-12 | Real broker integration (live money) | Pending; out of scope until C-7 through C-11 close | (TBD) |

---

## 4. C-7A — Per-cell allowlist + daemon filter (BUILDING NOW)

### Goal

Stop the daemon from opening positions on (strategy, param, ticker) combinations whose backtest validation is negative or absent.

### Schema

New table `quantlab.cell_allowlist`:

```sql
CREATE TABLE quantlab.cell_allowlist (
  strategy_type     LowCardinality(String),
  param             Int32,
  symbol            LowCardinality(String),
  oos_pct           Float64,
  oos_sharpe        Float64,
  oos_trades        UInt32,
  is_pct            Float64,
  profit_factor     Float64,
  source_sweep_id   String,
  threshold_tier    LowCardinality(String),   -- 'exclude_negatives' | 'lenient' | 'moderate' | 'strict'
  approved_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(approved_at)
ORDER BY (strategy_type, param, symbol)
```

`ReplacingMergeTree` on `approved_at` means a re-run of the populator overrides the prior allowlist for the same (strategy, param, symbol) row.

### Threshold tiers

Documented for transparency. The active threshold for the daemon filter is `exclude_negatives`:

| Tier | Filter | Use |
|---|---|---|
| `exclude_negatives` | `oos_pct > 0 AND oos_sharpe >= 0` | **DEFAULT.** Minimum reasonable: don't trade backtest-losers. |
| `lenient` | `oos_pct > 0` | Permits tiny-positive Sharpes. Weaker. |
| `moderate` | `oos_sharpe >= 0.3` | Borderline filter. |
| `strict` | `oos_sharpe >= 0.5 AND oos_trades >= 10` | Strong-evidence-only. May produce zero tickers under current OOS sample size. |

Threshold change requires re-running the populator with the new tier and overrides the prior rows via ReplacingMergeTree on `approved_at`.

### Daemon integration

In `scripts/daily_signal_daemon.ts`, at the universe-load step for each cell:

1. Load the equity universe as today.
2. Query `cell_allowlist` for the cell's `(strategy_type, param)`.
3. Filter the universe to retain only tickers present in the allowlist.
4. Log: `[allowlist <cell>] N/M tickers allowlisted; skipping K`.
5. Persist `live_signals` rows only for allowlisted tickers — the daemon evaluates and tracks state for the allowlisted subset only.

### Failure modes

- **Empty allowlist for a cell** → daemon evaluates zero tickers, logs warning, no entries. Operator must populate via `npm run populate:allowlist`.
- **Allowlist table missing** → ensureBacktestTables creates it; first daemon run after deploy is the bootstrap.
- **Concurrent populator + daemon** → ReplacingMergeTree's FINAL read at daemon-time always sees the latest version per (strategy, param, symbol). No locking required.

---

## 5. C-7B — Allowlist audit + open-position reconciliation (BUILDING NOW)

### Goal

Surface positions currently long on tokens that the allowlist would no longer permit. The operator decides whether to close manually or let the strategy's own exit logic handle it.

### CLI

`npm run audit:positions` — emits a markdown report:

```
Live positions vs allowlist:

mr_v1/p=14:
  ✓ on allowlist:    BA, DE, MMM, ...        (these match the backtest's positive subset)
  ⚠ NOT on allowlist: <ticker>, ...           (review: close or accept the drawdown)

trend_v1/p=30:
  ✓ on allowlist:    WMT, GILD, ...
  ⚠ NOT on allowlist: NKE, CRM, CVX, ...      (these are losing in the current corpus)
```

Recommended action per violator is operator-decided: close, hold, or override.

### Integration with Component 4 brief

The morning brief's watch-list section (SPEC §2.5) should additionally highlight allowlist violations. Future iteration; not in scope this turn.

---

## 6. C-11 — LLM qualitative validator (FUTURE)

### Purpose

Catch qualitative red flags that quantitative gates miss: earnings tomorrow, recent CEO indictment, trading halt, M&A in progress, regulatory action.

### Operating principle: EXCLUSION ONLY

The LLM gate can VETO an entry. It CANNOT approve one that quant gates rejected. This is a load-bearing constraint per session-38 turn-3 discussion:

- LLM hallucinations + adversarial inputs + inconsistency make it unsafe as the primary decision-maker
- LLM strength is unstructured qualitative analysis — perfect for excluding obvious red flags, dangerous for inclusion logic

### Inputs to the validator

Per entry candidate, the LLM gets:

- Strategy + ticker + signal context (e.g., "mr_v1/p=14 signaled BUY on AAPL")
- Recent quantitative state (current regime, allowlist position, OOS Sharpe)
- Optional: web search results for "<ticker> news last 7 days"

### Structured output

```json
{
  "verdict": "pass" | "veto",
  "rationale": "...",
  "flags": [{"severity": "info"|"warning"|"critical", "category": "earnings"|"news"|"halt"|...}]
}
```

`verdict='veto'` blocks the entry. `verdict='pass'` defers to the quant gates' decision.

### Caveats (in the SPEC for the future implementer)

- **Knowledge cutoff:** the LLM's training data has a date. Anything past that requires web search.
- **Logging:** every LLM call MUST log inputs + output for retrospective evaluation. Without this, you can't tell whether the validator is helping or hurting.
- **Cost monitoring:** budget per day, alert if exceeded.
- **Determinism check:** periodically re-run historical decisions and check that the LLM's verdict is consistent. Divergence > X% = recalibrate the prompt or pin a model version.
- **Adversarial test:** before live deployment, run the validator against a known-good and known-bad ticker corpus. Measure false-positive / false-negative rates.

### What this is NOT

- Not a position-sizing model.
- Not a strategy primary.
- Not a substitute for the backtest allowlist.
- Not safe for unsupervised use at scale without retrospective logging.

---

## 7. Open questions / decisions deferred

| Question | When to decide | Notes |
|---|---|---|
| Should the allowlist be regime-conditional? | After phase1_v3 lands | Today regime info is unusable per phase1_v2 bias |
| How often should the allowlist be re-populated? | After observing drift | Likely: every fresh sweep; OR cron weekly |
| What threshold should the daemon use? | After observing live performance under `exclude_negatives` | Start coarse, tighten with evidence |
| Should ML meta-labeling be revived? | After universe expansion to 503 tickers | ADR-027 said no; expanded data might say yes |
| Which intraday data source? | When intraday strategies are designed | Polygon ($29/mo) is the recommended pick if needed |
| Should we wire fja05680? | User-decided; estimated 2-4 hours of work | Unblocks phase1_v3 + point-in-time universe |

---

## 8. Watch-outs

- **Allowlist is only as good as the backtest.** Garbage-in: if the backtest universe is biased (today: 60 mid-caps, survivors), the allowlist inherits that bias. Address by Layer 3 (503-ticker sweep) and Layer 2 (phase1_v3).
- **Per-ticker OOS sample sizes are tiny** (1-5 trades) at 1d intervals. The allowlist is a coarse filter, not a precision predictor. Treat it as such.
- **The LLM gate must never be allowed to override quant gates.** Single most important rule for that component. Codify it as a test in the LLM gate's implementation.
- **Don't add ML or LLM gates until simpler gates have been observed in production for ≥ 4 weeks.** Layered complexity without observation = compounded uncertainty.
