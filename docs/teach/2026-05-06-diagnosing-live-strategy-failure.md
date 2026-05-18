# Diagnosing live-strategy failure — distinguishing data issues from edge issues

**Source:** Aronson, *Evidence-Based Technical Analysis* (2006) Ch. 7
(transaction costs and the deployable-edge floor). López de Prado, *Advances
in Financial Machine Learning* (2018) Ch. 11 (probability of backtest
overfitting). Bailey, Borwein, López de Prado & Zhu, *The Probability of
Backtest Overfitting* (2014). Empirical case study: VB-Momentum
paper-trading on Solana memecoins, sister project, 2026-04-18 → 2026-05-07.

---

## Intuition

When a strategy with a great-looking backtest performs poorly live, the
psychologically natural reaction is **"there must be something wrong with
the live data."** That hypothesis is sometimes correct. Far more often,
it's the textbook rationalization for what statisticians call
*in-sample / out-of-sample collapse*: a backtest that was overfit to its
historical data, performing exactly as you should expect it to perform
on truly fresh data.

Distinguishing real data issues from real edge issues requires running a
small, ordered diagnostic procedure. Skipping the procedure and jumping
straight to "data must be wrong" is how retail traders convince themselves
to keep deploying a broken strategy.

This doc captures the procedure, using one concrete example.

## The case study — VB-Momentum live results

Live numbers from the sister project's paper-trading dashboard, 19 days
of operation, 114 closed trades:

```
Win rate:              46.5%   (53 / 114)
Avg win:               +$18.98
Avg loss:              -$20.82
Breakeven WR needed:    52.3%
Gross P&L:             +$419.08    ← strategy IS positive gross
Total fees:            -$682.77    ← but fees consume all of it + extra
Net P&L:               -$263.69
```

The original backtest claimed PF 2.02 portfolio-level. Live PF (gross-of-fees,
generous interpretation): $1086 wins / $1106 losses ≈ 0.98. Net-of-fees PF:
0.61. **PF collapsed from 2.02 → 0.61** between backtest and live — that is
a 70% drop in profit factor over one calendar month of trading.

The user's first hypothesis on seeing this result was *"the data probably
had issues."* The diagnostic below tested that hypothesis and rejected it.

## The diagnostic procedure (apply in this order)

### Step 1 — compute live expected value per trade. Does it match the loss?

```
EV_per_trade = WR × avg_win + (1 − WR) × avg_loss
            = 0.465 × 18.98 + 0.535 × (-20.82)
            = 8.83 − 11.14
            = -$2.31

Expected loss over 114 trades: 114 × -$2.31 = -$263
Actual loss:                              -$263.69
```

The actual loss matches the WR/avg_win/avg_loss prediction within $1.
**This is the first sign that the live result is exactly what those summary
stats say it should be — there is no mystery to explain by data error.**

If the actual loss were materially worse than EV_per_trade × n_trades, you
would have a fee, slippage, or data issue to investigate. If it matches,
the strategy is losing for the structural reason embedded in the win-rate
and trade-size distributions.

### Step 2 — compute breakeven WR. How far below breakeven are you?

```
breakeven_WR = avg_loss / (avg_win + avg_loss)
            = 20.82 / (18.98 + 20.82)
            = 52.3%
```

You're at 46.5%; you need 52.3% to stop bleeding. **A 5.8 percentage point
gap is not noise.** A real-edge strategy with a fair-tail-distribution should
sit comfortably above breakeven, not 6 pp below it. If you're below breakeven
on n=100+ trades, the gross edge is genuinely insufficient — not delayed,
not unlucky, not waiting on the next regime.

### Step 3 — split gross from net. How much of the loss is fees?

```
Avg position size:   $399
Avg fees per trade:  $5.99   (1.50% per round trip)
Avg gross per trade: +$3.68
Avg net per trade:   -$2.31
```

The strategy has a positive gross edge (+$3.68 per trade) but it's smaller
than the fee cost ($5.99). **Fees are the dominant cause of the live loss.**

This is the canonical Aronson §7 framing: a strategy whose gross edge is
less than 2× transaction costs has effectively zero deployable edge after
costs. Here gross edge / fees = 3.68 / 5.99 = 0.61×, far below the
deployable floor.

This is also a *fixable* finding. If you can lower transaction costs
(better venue routing, market-making rebates, larger position sizes that
amortize fixed fees, longer hold times that average down per-trade fees),
the gross edge could turn into a small net positive. But that's a
fundamentally different conclusion than "data was bad."

### Step 4 — split P&L by exit reason. Where do wins and losses come from?

For VB-Momentum:

```
trailing_stop   n=43   sum=+$876   ← all the wins
stop_loss       n=29   sum=-$889   ← almost the entire loss (eats all wins)
stale_position  n=28   sum=-$153   ← fee drag on flat trades
rug_pull        n=11   sum=-$46    ← real token deaths (acceptable)
```

Trailing-stop wins ≈ stop-loss losses. The strategy makes money on tokens
that move in your direction enough to trigger a profitable trail; it loses
that money back on tokens that move against you to your stop. The tail of
losers is slightly fatter than the tail of winners, and fees + stale-position
trades push the net negative.

This pattern is a **strategy-edge profile**, not a data anomaly. If the data
were broken (e.g. fake price spikes), you'd expect highly anomalous trade
P&Ls — single trades at +200% or -90% from price oracle errors. None of
those are present. The exit reasons are mundane and consistent.

### Step 5 — look for re-entry patterns. Is the strategy compounding losses?

```
FWC     trades=7    wins=4/7    net=-$181.64    ← entered FWC 7 times
ROAF    trades=8    wins=1/8    net=-$25        ← lost 7 of 8 times on ROAF
POCK    trades=4    wins=1/4    net=-$42        ← lost 3 of 4 times on POCK
PUPS    trades=4    wins=1/4    net=-$20        ← lost 3 of 4 times on PUPS
401JK   trades=5    wins=2/5    net=-$61
```

Multiple entries on the same losing token, with no apparent cooldown after a
stop-loss exit, means the strategy keeps firing on tokens that just demonstrated
they don't reverse. This is a **strategy-logic gap** — typically remedied by
adding a per-token cooldown timer or a recent-loss blacklist. Again,
fixable; not a data problem.

### Step 6 — actual data quality checks (last, not first)

Only after the above 5 steps point inward at the strategy do you check for
real data issues. The minimum checks:

| Check | What you're looking for |
|---|---|
| NULL entry_price / exit_price | Missing data (= rare; obvious bug if present) |
| Zero prices | Token-died-at-entry mis-recorded |
| Negative position_size | Sign-flip bugs |
| Hold time > expected max | Stuck positions / missed exits |
| Hold time near zero | Either real fast-trail-stop OR same-bar entry+exit data glitch |
| \|return\| > some threshold (50%? 100%?) | Price oracle skew or real outlier |
| Duplicate signal_id rows | Logging bug |

For the VB-Momentum case study: **all checks passed.** No NULLs, no zero
prices, no negative sizes, no extreme returns. 4 trades under 1 minute hold
which on inspection were fast trailing-stop fires (legitimate behavior of
the strategy when momentum reverses inside the entry candle), not data
glitches.

The headline "105 trades show exit_time < entry_time" was a SQL
string-comparison artifact — entry_time stored as `2026-04-18T14:56:35.852Z`
(ISO with `T`), exit_time stored as `2026-04-18 15:36:16` (no `T`); SQLite
sorts `T` after space in lexicographic comparison, making chronologically-
later exit_time values appear "earlier" than entry_time when you string-
compare them. The actual hold-time math via `julianday()` showed every trade
has a positive hold duration. **A formatting inconsistency, not a data
inconsistency.** This kind of false-positive data flag is exactly what makes
"data issues" so seductive as an excuse — there's always *something* that
looks weird until you check it.

## Failure mode of this teaching

The procedure above only works if you actually run it. The failure mode is
**stopping at step 0 because the answer is unpleasant.** A strategy with
positive backtest PF and negative live PnL is genuinely uncomfortable to
sit with — the natural impulse is to find a reason the live result is
"wrong." Steps 1-5 above are designed to make that rationalization
empirically untenable: by the time you've computed EV_per_trade and seen it
match the actual loss, broken P&L into gross-and-fees, and identified the
re-entry pattern, you have nowhere to hide.

The deeper lesson is the López de Prado / Bailey-Borwein result: **a backtest
that doesn't pass a rigorous overfitting check (PBO ≤ 0.5, deflated Sharpe
> 0, walk-forward efficiency > 0) almost certainly will collapse in
live trading.** The collapse will look like "data issues" or "regime
change" or "bad luck" because those are emotionally easier explanations
than "the backtest was overfit." But the math says: if you ran a sweep
across N parameter configurations and selected the best, the expected
out-of-sample performance is dramatically below the in-sample best.

The VB-Momentum case is a textbook empirical demonstration: 17,496-config
sweep on the entry side, claimed PF 2.02, live PF 0.61. The IS-OOS gap
isn't an aberration; it's the prediction.

## What to do when the diagnostic confirms edge failure

Three legitimate moves:

1. **Lower fees.** If gross edge is positive but fees consume it, every
   basis point off the round-trip is a basis point of net edge recovered.
   Better venue routing, larger position sizes, longer holds, market-making
   rebates. This works only if gross edge is positive (here it is, just barely).

2. **Add re-entry controls.** Per-token cooldown after a stop-loss exit;
   bad-token blacklist after N consecutive losses on the same name;
   regime-aware sizing. These are strategy-logic fixes, not parameter sweeps.

3. **Stop deploying it.** If gross edge is too small to clear fees + slippage
   + selection bias, the honest answer is to shelve the strategy and look
   elsewhere. The temptation to "tune more" is exactly the failure mode the
   project's other teach-doc
   ([2026-05-06-parameter-tuning-overfitting-trap.md](2026-05-06-parameter-tuning-overfitting-trap.md))
   is about.

The wrong move is to claim "data issues" without running steps 1-5 first,
keep deploying, and watch the loss compound. That is how retail systematic
trading destroys capital while feeling productive.
