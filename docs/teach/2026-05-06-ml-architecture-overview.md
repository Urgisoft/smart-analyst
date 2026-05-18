# SignalForge ML architecture — what's learned, what's frozen, what's never trained

**Source:** López de Prado, *Advances in Financial Machine Learning* (2018),
Ch. 3 (meta-labeling), Ch. 7 (cross-validation in finance), Ch. 11 (backtest
overfitting). Pardo, *The Evaluation and Optimization of Trading Strategies*
(2008), §7–8 (walk-forward analysis). Harvey, Liu & Zhu, *…and the
Cross-Section of Expected Returns* (2016), §V (multiple-testing haircut).
Project ADRs 017–020 (meta-labeling pipeline + threshold tuning + promotion
guardrail), ADR-031 (regime-gate empirical rejection).

---

## Intuition

A common assumption when you hear "trading bot with ML" is that the model is
constantly absorbing new data and updating its beliefs. SignalForge does **not**
work that way — and the choice is deliberate, not a limitation.

There are three layers in the system, and only one of them is "learned":

1. **Strategies (M1)** — rule-based indicators with hard-coded thresholds.
   `mr_v1` and `trend_v1` are deterministic computations. Same candles in,
   same signal out, every time. **Nothing is learned. Nothing updates.**
2. **Behavioral clustering (HDBSCAN, unsupervised)** — groups tokens by their
   feature signatures into clusters. Re-fits **only when an operator runs
   `cluster_tokens_weekly.py`**. Between runs, cluster assignments are frozen.
3. **Meta-classifier (M2, supervised)** — LightGBM binary classifier that
   predicts "given M1 just signalled, will this trade work?" Trained offline
   on a fixed train/tune/OOS split. Stored in `quantlab.meta_models`. Frozen
   until an operator manually retrains. **Not currently in the live signal
   path** — it's research infrastructure used for promotion gating.

The daily paper-trading daemon (`npm run daemon:daily`) runs **only M1 inference**.
No model.predict() call. No retraining loop. No weight updates from yesterday's
fills. Data flows in (yfinance candles persist daily) — but it's stored, not
consumed by any learning process.

## Mechanism

### What the live daemon does each day

```
yfinance fetch (daily incremental)
  ↓
load universe (60 equity_midcap tickers from quantlab.tokens)
  ↓
for each deployed cell (mr_v1/p=14, trend_v1/p=30):
    for each ticker:
        runStrategy(candles, params)   ← deterministic rules
        evaluateLiveState(trades)      ← position genuinely open?
  ↓
diff vs prior quantlab.live_signals state
  ↓
write today's state to ClickHouse, send Telegram report
```

There is no model object loaded, no inference call, no weight update. The
phrase "machine learning" is not a fitting description of the live path —
it's pure rule-based signal generation with state diffing.

### How M2 would work if/when wired in

Per López de Prado AFML §3.5 ("Meta-labeling"):

> The primary model decides the *side* of the bet. The secondary model
> decides the *size* — including the option of size = 0 (skip).

Concretely:

```
runStrategy → candidate signal at bar t (M1 says BUY)
  ↓
extract features at bar t  (RSI level, regime flag, volatility z-score, …)
  ↓
M2 = load latest meta_models row for this cell_key
  ↓
p = M2.predict_proba(features)[1]    # prob of profitable trade
  ↓
if p >= cell's tuned threshold p*:
    take the trade
else:
    skip
```

M2 is trained by `scripts/train_meta_label.py` on a 3-way split:
- **m2_train** — purged k-fold + LightGBM hyperparam sweep, AUC scoring
- **m2_tune** — sweep threshold p*, pick the one maximising
  `trimmed_mean(native_pnl, 0.05) × n_kept` (ADR-020 robust objective)
- **oos** — apply (model, p*); record OOS metrics; persist to `meta_models`

A trained cell only gets *deployed* if it passes seven promotion criteria
(ADR-018 + ADR-019 distribution-robustness + HLZ multiple-testing haircut).

### How HDBSCAN clustering works

`scripts/cluster_tokens_weekly.py` (manual run) reads the past N weeks of
token-level features (return moments, vol regime, drawdown profile,
volume-on-volume ratios, etc.), runs HDBSCAN with the project's tuned
hyperparameters, and persists cluster assignments per (token, week) into
ClickHouse. Strategies are then evaluated *per cluster* (e.g., "mr_v1 over
mcap_micro cluster 0") so that statistical significance is tested at the
cluster level rather than smeared across heterogeneous tokens.

## Why it's NOT continuously learning — three canonical reasons

### 1. Online learning destroys clean walk-forward validation

López de Prado AFML §7 covers cross-validation in finance specifically because
standard k-fold leaks information across folds when the data is time-ordered
and serially correlated. Pardo §7–8 (walk-forward) gives the corresponding
discipline: train on past, lock the model, evaluate on the future you haven't
seen. A continuously-fitting model has, in effect, peeked at every bar of its
"OOS" data — your validation guarantee evaporates.

### 2. Every retrain is an implicit hyperparameter sweep

Harvey-Liu-Zhu (2016) §V: when you run M tests at α=0.05, you expect αM false
positives. The fix is the multiple-testing haircut (Bonferroni or BH-FDR):
divide your t-stat threshold by some function of M. This project tracks
M = 267 right now (the "HLZ M ratchet" in the handoff brief). Every model
re-fit, every threshold re-tune, every parameter sweep silently increments M.
A continuously-retraining live system inflates M without bookkeeping —
guaranteeing that what looks like a real signal is statistically indistinguishable
from noise after correction.

### 3. The project's north star is confidence over raw returns

Vector Core operating rules: "Deflated Sharpe of 1.2 with low PBO beats inflated
PF of 3. Always." A frozen-and-validated model with documented OOS performance
gives you that confidence. A continuously-adapting model gives you a moving
target you can never properly validate. The trade-off favours frozen.

## Failure mode (when does this design break?)

- **Regime change after training.** M2 was trained on data through some date X.
  If the market structure shifts after X (rates regime, vol regime, factor
  rotation), M2's gating becomes systematically miscalibrated. Mitigations
  attempted in this project: ADR-021's BTC-regime pre-filter overlay; Faber-
  style trend regime gate (ADR-031 — empirically *rejected*; preserved as a
  shelved infrastructure flag).
- **Stale clusters.** HDBSCAN runs weekly. A token whose behaviour shifts
  mid-week (memecoin pump, exchange listing, hack) keeps its old cluster
  assignment until the next refit.
- **Concept drift in M1's rules.** M1 is *not* learned, so it doesn't drift
  in the ML sense — but its *parameters* (p=14, p=30) were tuned on historical
  data. If `trend_v1`'s 30-day filter stops working in 2027, no automatic
  process catches that. Only the operator running periodic ADR-style robustness
  re-checks against new OOS data does.
- **Operator forgets to retrain.** The cost of "frozen by default" is that
  retraining is a deliberate operator action. If the operator stops doing
  it, the system slowly degrades. Mitigation: scheduled retrain cadence
  (e.g. every quarter as the OOS slice grows by 90 days of new data),
  documented as a recurring task.

## What "constantly being fed data" *does* mean here

To be precise — data **does** flow in continuously:

- The candle watcher daemon (`npm run watch`) ingests crypto candles in real
  time into `quantlab.candles`.
- The daily signal daemon pulls yfinance equity bars daily.
- These accumulate as the historical record.

That data is then used by:
- The live daemon, which runs *inference* (no learning) on it.
- Offline training jobs, which an operator runs manually when retraining
  M2 or refitting clusters.

The split is: **data flow is continuous; learning is event-triggered.**
That distinction is the whole point of the architecture.
