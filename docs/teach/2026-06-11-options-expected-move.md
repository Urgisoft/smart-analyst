# Expected move (options-implied) — the market's priced range around an event

**Source:** Hull, *Options, Futures, and Other Derivatives* (10th ed.), ch. 15 (Black-Scholes-Merton)
+ ch. 19 (the Greeks); Natenberg, *Option Volatility & Pricing* (2nd ed.), ch. 4-6 (volatility as the
priced standard deviation). Implemented in `scripts/expected_move.py` (reuses the IV machinery in
`scripts/yfinance_options_summary.py`).

## Intuition (what it's *for*)
Before an event (earnings, CPI, an FOMC decision), the options market has *already* put a price on
"how much will this thing move." You can read that price straight off the chain: the cost of an
at-the-money **straddle** (buy the ATM call + the ATM put) is what the market charges for a bet that
the stock moves at all, in either direction. A pricey straddle = the market expects a big move; a
cheap one = a small move. So the **expected move is not our forecast — it's the market's own pricing**,
and it's a **magnitude, not a direction** (the straddle pays off whether it goes up or down). This is
the one genuinely *forward-looking* number in the whole system, precisely because we're reading the
market's price rather than predicting anything ourselves.

## Mechanism (the formula)
For an option expiring in `T` calendar days, with at-the-money implied volatility `σ` (annualized):

- **1-sigma expected move** = `S × σ × √(T/365)` — the ±range the market prices with ~**68%**
  probability the actual move stays inside it (the normal-distribution 1-σ band). This is the
  headline number `expected_move.py` reports.
- **ATM straddle** ≈ `S × σ × √(T/365) × √(2/π)` ≈ `0.8 ×` the 1-σ move. The straddle equals the
  *expected absolute move* `E|ΔS|/S` (the average move size), which is why it's a bit smaller than
  the 1-σ band. The tool prints it as a cross-check; the two should roughly agree.

Worked example (live, 2026-06-11): MU's June-26 options (15 days, ATM IV ≈ 117%) imply
`S × 1.17 × √(15/365) ≈ ±23.7%` into the June 24 earnings — i.e. the market is pricing a roughly
±$176 move on a ~$936 stock, with ~68% odds it lands inside that.

## Failure mode (when it misleads)
1. **It is NOT a direction.** A ±24% expected move says nothing about up vs down — only size.
2. **Fat tails.** Real returns aren't perfectly normal; the actual move lands *outside* the 1-σ band
   about **1 day in 3**, and a genuine surprise can blow well past it. The band is a center of mass,
   not a ceiling.
3. **IV crush.** Implied vol is inflated *before* a known event and collapses right after (the
   uncertainty resolves). So the pre-event expected move is large by design; don't read it as a
   standing volatility level.
4. **Far expiry ≠ event move.** If the nearest expiry after an earnings date is 90 days out, its
   expected move reflects ~90 days of vol, *not* the one-day earnings reaction. `expected_move.py`
   refuses to quote a number when earnings are >25 days out for exactly this reason.
5. **Thin / stale chains.** Illiquid options (wide bid-ask, no recent trades) make both the IV and
   the straddle unreliable — Yahoo's IV field also goes to a ~0 sentinel pre/post-market (the tool
   re-solves IV from price, but a truly dead chain still yields garbage). FTEC's own options are
   thin, so the fund's expected move falls back to XLK as a liquid tech proxy.
6. **Model assumptions.** The 1-σ formula assumes lognormal returns and constant vol over the window;
   US single-name options are American and pay discrete dividends, so it's an approximation near
   ex-div or for deep-ITM strikes.

**Bottom line for SignalForge:** the catalyst calendar tells you *when*; the expected move tells you
*how big a move the market has already priced* — together they're preparation, never a prediction or
a buy/sell signal (ADR-056). Not investment advice.
