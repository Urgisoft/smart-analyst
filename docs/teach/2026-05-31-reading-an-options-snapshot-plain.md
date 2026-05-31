# Reading an options snapshot in plain English

**Source:** Hull, *Options, Futures, and Other Derivatives* (the standard text — implied volatility,
the volatility smile/skew, and the Greeks). This is decision-support framing, **not** a validated
alpha signal (per ADR-056).

> The options market on a stock is a giant **betting + insurance** market. Four readings tell you the
> crowd's *mood and positioning* — never the future.

## Intuition (what each reading means in human terms)

1. **Implied Volatility (IV) — "how big a move are people paying up for?"**
   The market's bet on how much the stock will swing. High IV = options are expensive = people expect
   big moves (fear or excitement). Low IV = calm. It's like an **insurance premium**: it spikes before
   storms and drops when calm.
   - **Term structure** = IV across different expiration dates. *Contango* (further-out costs more) is
     the normal calm shape. A **bump** in a specific month = the market is pricing a known event then
     (earnings, a ruling). No bump near-term = **no imminent surprise expected.**

2. **Put/Call ratio — "are people betting up or down?"**
   Calls = up-bets. Puts = down-bets (or protection). Ratio **below 1 = call-heavy = crowd leaning
   bullish**; above 1 = put-heavy = bearish/hedged. (Open interest = standing bets; volume = today's
   trading — OI is the steadier gauge.)

3. **Skew — "how much are people paying for crash protection?"**
   Usually puts (downside insurance) cost more than calls — people pay up to protect against a crash;
   that gap is the **skew**. A **steep** skew = lots of fear priced in. A **flat** skew = cheap
   protection = **complacency** (nobody's worried). Counterintuitively, a calm/flat skew can be a
   yellow flag: everyone relaxed and long → a bad surprise has more room to hurt.

4. **The Greeks — "how twitchy is the option's price?"**
   - **Delta** ≈ how much the option moves per $1 in the stock (also ≈ odds of finishing in-the-money).
   - **Gamma** = how fast delta itself changes — *highest* for short-dated, near-the-money options
     (they're the twitchiest).
   - **Theta** = daily time-decay — options bleed value each day; brutal near expiry.
   - **Vega** = sensitivity to IV — *bigger* for longer-dated options.
   These are computed from the chain's IV via Black-Scholes; you mostly read them to see *where* the
   sensitivity (and the open bets) are concentrated.

## Mechanism (how to combine them into a read)
Line up the four: Is vol calm or stressed? Is the crowd betting up or down? Is protection cheap
(complacent) or dear (fearful)? Where's the open interest (Greeks)? Then sanity-check against a
**second source** — e.g. institutional 13F call/put holdings — and note any **divergence** (fast money
vs slow money disagreeing is itself information).

## Failure mode (what this canNOT tell you)
- It's a **snapshot of mood/positioning, not a forecast.** Crowds are often wrong; "everyone bullish"
  is not "it will go up."
- **Model Greeks** assume Black-Scholes (European exercise, constant vol, continuous dividends); real
  US equity options are American with discrete dividends — so Greeks near ex-div / deep ITM are
  approximations.
- **Put/call and "net delta from open interest" don't know who is long vs short** — a rough gauge, not
  a true dealer book.
- Volume after-hours/pre-open reflects the *prior* session; OI is the stabler measure.
- A spot snapshot is not a time series — the *change* over days often matters more than the level.
