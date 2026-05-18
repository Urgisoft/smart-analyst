# 99 — Glossary

Quick reference for the terms used across SignalForge. For depth, see [docs/teach/](../teach/).

## Statistics / overfit correction

**DSR — Deflated Sharpe Ratio** *(Bailey & López de Prado 2014)*
A Sharpe estimate corrected for selection bias: when you pick the best of N strategies, the naive Sharpe is inflated. DSR discounts it back toward the truth using the count of trials, the moments of the trial distribution, and the variance of the returns. Implementation: [src/lib/psr.ts](../../src/lib/psr.ts).

**PBO — Probability of Backtest Overfitting** *(Bailey, Borwein, LdP, Zhu 2014)*
The probability that a strategy picked as "best" in-sample will rank below median out-of-sample. Computed via CSCV (below). A high PBO (>0.5) means the IS ranking carries no information about OOS performance — the sweep is noise. Implementation: [src/lib/cscv.ts](../../src/lib/cscv.ts).

**CSCV — Combinatorially Symmetric Cross-Validation** *(same paper)*
The procedure that produces PBO. Split the return series into S segments, generate all (S choose S/2) train-test partitions, rank strategies on train, look up the ranks of the winners on test. The mass of below-median ranks gives PBO.

**HLZ haircut** *(Harvey, Liu, Zhu 2016)*
A multiple-testing correction on t-stats: if you tested 1,000 strategies, the t-stat needed to claim significance is much higher than the textbook 1.96. SignalForge applies the Bonferroni / Holm / BHY adjustments. Implementation: [src/lib/hlzHaircut.ts](../../src/lib/hlzHaircut.ts).

**Walk-forward OOS** *(Pardo 2008)*
Train on the first 70% of history, test on the last 30% (`--split-pct 70` in the backtest sweep). The 30% test window is the only one that produces honest performance estimates.

## SignalForge concepts

**Cell**
The atomic unit of a backtest: a (strategy, parameter, ticker, interval) tuple. Example: `(mean_reversion_v1, RSI_period=14, NVDA, 1d)`. Sweeps generate thousands of cells; the allowlist promotes a handful.

**Bundle**
A grouping of cells by strategy family — currently `mean_reversion_v1` (52 tickers) and `trend_v1` (106 tickers). The [[05 - Trade Execution Pipeline|Gate 1]] lookup is bundle-keyed.

**Allowlist**
The promoted-survivor table: which (strategy, param, ticker) cells passed scoring (DSR, PBO, OOS-trade count). Lives in [`quantlab.cell_allowlist`](02%20-%20Storage%20%28ClickHouse%29.md). Source of truth for Gate 1.

**Regime** *(phase1_v3)*
A daily 🔴/🟠/🟡/🟢 label on the market driven by six categorical risk-off arms. See [[04 - Regime Classifier (phase1_v3)]].

**ADR**
Architecture Decision Record — short markdown notes in [docs/decisions/](../decisions/) capturing a binding decision with its rationale and date. Once written, ADRs are not re-litigated unless the user reopens.

**Meta-labeling** *(López de Prado, AFML ch. 3)*
A secondary classifier that decides whether to trust a primary strategy's signal. Inputs: features at signal time. Output: probability the trade hits profit-target before stop-loss. SignalForge's [[05 - Trade Execution Pipeline|Gate 3]] is a meta-labeler — currently deferred per ADR-027.

## Vector Core roles

**[RESEARCH]** — Ground methodology in the canon (LdP, Bailey, Pardo, HLZ…). Cite specifically.
**[DESIGN]** — Information-dense dashboard / decision-supporting panels.
**[SPEC]** — Write the contract before code: I/O schemas, edge cases, test list.
**[CODE]** — Match the spec; type hints + docstrings citing sources.
**[TEACH]** — Pause and explain when the user is about to use a concept they haven't shown they know. Triggers a doc in [docs/teach/](../teach/).
**[PUSHBACK]** — Say "this is the wrong move because X" directly. Don't soften disagreement.

See the full prompt at [.claude/vector_core_system_prompt.md](../../.claude/vector_core_system_prompt.md).

## Operational shorthand

| Term | Meaning |
|---|---|
| Track A | The 30-trading-day paper-trading shakedown that started 2026-05-11. Day 3/30 as of 2026-05-16. |
| `ADR_038_BASELINE` | Pinned regime distribution `{red:127, orange:349, yellow:1392, green:2754}` from the session-45 v3 backfill. Test #9b enforces. |
| `VIX_TERM_COMPLACENCY_FLOOR` | `0.80` — VIX/VIX3M ratio at which `vix_term_inverted` arm fires. Empirical p05. |
| STALE | Daemon-run terminology — positions matching the carried 24-violation baseline. Not a regression. |
| Bootstrap-only ALTER | Schema migration that only runs at `npm run dev` startup via `bootstrapClickHouseSchema()`. |
