# Options-implied probability — the market's risk-neutral odds (and why they're not real odds)

**Source:** Hull, *Options, Futures, and Other Derivatives* (10th ed.) ch. 15 (N(d2) = the risk-
neutral probability an option expires ITM); Breeden & Litzenberger (1978), *Prices of State-
Contingent Claims Implicit in Option Prices* (JoB 51:621 — the risk-neutral density is the second
strike-derivative of the call price); Jackwerth (2000), *Recovering Risk Aversion from Option
Prices and Realized Returns* (RFS 13:433 — the gap between risk-neutral and physical probabilities).
Implemented in `scripts/implied_probability.py`.

## Intuition (what it's *for*)
Every strike on the options chain is a bet the market has *already priced*. If you read those prices
the right way, you can back out the market's **odds**: *"the options market is pricing a ~25% chance
FTEC is more than 5% lower by Friday."* That number isn't my forecast and it isn't from any model we
fit — it's the **crowd's own capital-backed estimate**, extracted from what they're paying for puts
and calls. That's why it's the honest version of "predictability": instead of adding another doomed
predictor (the ADR-056 null), you read the price the market has *already* set on each outcome.

## Mechanism (the formula)
For an option expiring in `T` years, the risk-neutral probability the price ends **below** a level `L`:

```
P(S_T < L) = N(-d2),   d2 = [ ln(S/L) + (r − σ_L²/2)·T ] / ( σ_L·√T )
```

where `S` is spot, `r` the risk-free rate, `N` the normal CDF, and **`σ_L` is the implied vol of the
strike nearest `L`** — using each strike's *own* IV is what makes this **skew-aware**: out-of-the-
money puts trade at higher IV (crash insurance is bid up), which fattens the left tail exactly as the
market prices it. `implied_probability.py` takes `σ_L` from the **puts below spot and the calls above
spot** (the more-liquid OTM side each way), then scans strikes to report P(down >5/10%), P(up >5/10%),
and the implied middle-50% range (where the CDF crosses 0.25 and 0.75). `N(d2)` being the risk-neutral
P(ITM) is the standard Black-Scholes result (Hull ch. 15); the full density is Breeden-Litzenberger.

## Failure mode (the one that matters most)
**Risk-neutral ≠ real-world.** This is the load-bearing caveat. The probabilities are computed under
the *risk-neutral measure*, which bakes in investors' **risk premium** — people pay *more* than fair
odds for downside protection, so the priced (risk-neutral) probability of a big drop is **higher than
the true physical probability** of that drop. Empirically (Jackwerth 2000) the risk-neutral left tail
is materially fatter than what actually happens. So:

- Read "P(down >5%) = 25%" as **"the market is *pricing* a 25% chance"**, not "there's a 25% chance."
  The real-world number is somewhat lower; the gap *is* the fear premium.
- It's still useful precisely *because* it's the market's pricing — it tells you how much protection
  costs and where the crowd's money sits, which is what you'd weigh around a catalyst.

Other caveats: **(1)** it's a *terminal* (expiry-date) probability, not "will it touch this level
intraday" (touch probabilities are ~2× higher). **(2)** Thin/stale chains (FTEC's own options, or
any chain pre/post-market) give unreliable IVs — the tool falls back to liquid XLK as a tech proxy and
re-solves IV from price, but a dead chain still yields junk. **(3)** It assumes the BSM lognormal form
per-strike; the smile corrects for skew but not for everything (jumps, etc.).

**Bottom line for SignalForge:** the catalyst calendar says *when*, expected-move says *how big*, and
this says *the market's odds on each outcome* — three honest, market-sourced inputs to your decision.
None of them is a prediction or a buy/sell signal (ADR-056). Not investment advice.
