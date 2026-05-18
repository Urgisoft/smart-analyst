# 05 — Sentiment & Options Positioning

> Sentiment tells you what other market participants believe — and whether they're crowded in the same direction. Extreme sentiment is often contrarian. When everyone's on one side of the boat, the boat tips.

## Options-based sentiment

### Put/call ratio

Ratio of put option volume to call option volume. Low ratio = bullish bias (more call buying); high ratio = bearish bias (more put buying).

- **Below 0.5** = extremely bullish sentiment (contrarian concern)
- **0.5 - 0.8** = bullish bias
- **0.8 - 1.2** = balanced
- **1.2 - 2.0** = bearish bias
- **Above 2.0** = extremely bearish sentiment (contrarian opportunity)

### Implied volatility (IV30)

Market's expectation of volatility over next 30 days. Higher IV = market expects bigger moves. Useful comparisons:

- IV vs historical volatility (HV) — is the market expecting more or less volatility than recently realized?
- IV percentile — where does current IV sit in the symbol's own IV history?
- Low IV percentile = options are cheap (good for option buyers)
- High IV percentile = options are expensive (good for option sellers, warning for stock buyers)

### Unusual options activity
- Large block trades on specific strikes — informed positioning?
- Out-of-money calls being bought aggressively — bullish bets
- Out-of-money puts being bought aggressively — bearish bets or hedging
- Use as sanity check only, not primary signal. Most "unusual activity" is noise.

## Technical sentiment aggregators

When multiple independent technical analysis sources all show maximum bullishness across all timeframes, you're at a sentiment extreme. The signal isn't "this stock is going up" — it's "everyone thinks this stock is going up."

## News and analyst sentiment
- Recent analyst rating changes — upgrades, downgrades, price target moves
- Earnings revision trend — are estimates being raised or lowered over recent months?
- News flow tone — recent headlines positive, negative, or mixed?
- Media coverage volume — is the symbol getting unusual attention?

## Institutional positioning (slow but valuable)

For individual symbol analysis, the basics:
- **13F filings** (quarterly, 45-day lag) — which institutions hold the position
- **Form 4 filings** (2-day lag) — insider buying/selling
- **13D filings** (10-day lag) — when investors cross 5% ownership
- Free aggregators: Whalewisdom (13F), OpenInsider (Form 4)

See [[../gaps/event-driven-filings-processor]] for the future automation of this.

## How to read sentiment

> **🟢 Moderate bullish sentiment + strong fundamentals** = healthy trend
>
> **🟡 Extreme bullish sentiment** (P/C < 0.3, all-timeframe Strong Buy, high IV percentile) = late-cycle warning
>
> **🟢 Extreme bearish sentiment** (P/C > 2.0, all-timeframe Strong Sell) = contrarian opportunity if fundamentals support
>
> **❓ Mixed sentiment** = no edge from this dimension; rely on other signals

## Next

→ [[06-structure]]
