# Leading indicators vs. breadth — why we don't need delisted prices to detect red regimes

> Sources:
> - Estrella, A. & Hardouvelis, G. (1997), *The Term Structure as a Predictor of Real Economic Activity*, Journal of Finance — yield curve inversion → recession lead
> - Gilchrist, S. & Zakrajšek, E. (2012), *Credit Spreads and Business Cycle Fluctuations*, American Economic Review — HY OAS as leading stress indicator
> - Whaley, R. (2009), *Understanding VIX*, Journal of Portfolio Management — VIX as fear gauge
> - NY Fed yield-curve recession probability model — operational use of T10Y2Y / T10Y3M

## Intuition (plain language)

Imagine your job is to put a thermometer on the U.S. economy and tell people whether today is a hot day, a warm day, or a cold day (with cold = recession risk). You have many possible thermometers:

1. **VIX** — How nervous are options traders right now?
2. **Yield curve** — Do bondholders think short rates will fall in 12-18 months (which they usually do during recessions)?
3. **Credit spreads** — Are lenders demanding more compensation to lend to risky companies vs. safe ones?
4. **Drawdown** — How far is the S&P 500 below its recent high?
5. **Market breadth** — Of the 500 stocks in the S&P 500, what fraction are above their 50-day average?

The first four thermometers are "stock-agnostic." They look at the *market as a whole*. The fifth one is different — it cares about the membership of "the 500 stocks in the S&P 500." If your list of 500 is wrong, the thermometer reads wrong.

That's the entire survivorship-bias problem. The breadth thermometer is the *only* one that depends on the list. And the list is hard to fix without paid data (Sharadar would give you historical membership + prices for delisted names).

**The insight you arrived at session 38 turn 5:** if four out of five thermometers don't have this problem, why are we fighting to fix the one that does? Just stop using it. Use the other four (and add even better ones).

## Mechanism (what the canonical indicators actually measure)

### Yield curve (T10Y2Y = 10-year yield minus 2-year yield)

When this number goes negative ("yield curve inversion"), it means investors think long-term rates will FALL — which usually happens when the economy slows enough that the Fed cuts rates. Historically this has preceded every U.S. recession since 1955 with a lead of 6-18 months. The NY Fed publishes a "recession probability" model based on the 3m10y version of this spread.

- Going **negative** = stress signal building
- Going **positive again** = the curve "un-inverts," often coincides with the actual recession starting
- Source: FRED series `T10Y2Y`, daily back to 1976

### Credit spreads (HY OAS or HYG vs LQD)

When the economy looks shaky, lenders demand a bigger premium to lend to junk-rated companies vs. investment-grade ones. The spread between high-yield bond yields and Treasury yields widens. You can measure this either:

- Directly via ICE's BofA HY OAS series (`BAMLH0A0HYM2` on FRED) — but free access is limited
- Via the price ratio of HYG (high-yield bond ETF) and LQD (investment-grade bond ETF). When HYG underperforms LQD, junk is selling off relative to safer credit → spread widening → stress

Source: yfinance for HYG/LQD ETFs, both available daily back to 2002.

### Put/call ratio

When too many options traders buy puts (downside protection) relative to calls (upside bets), the ratio spikes. Two interpretations:

- **Contrarian:** when EVERYONE is bearish, the bottom is usually near (extreme reading)
- **Stress signal:** elevated readings DURING a sell-off confirm panic

Source: CBOE publishes the daily CSV (note: yfinance does NOT carry this — has to be fetched from CBOE directly).

### Risk-on/risk-off rotation (SPY vs TLT)

When stocks fall and Treasuries rise simultaneously, money is rotating from risk assets (equities) to safety (Treasuries). The 20-day return spread between SPY and TLT, or their ratio, captures this rotation.

This is a **proxy for ETF flow data** — true creation/redemption flow data is paid (Lipper, ICI weekly), but the price-level rotation captures most of the signal you'd extract from flows.

Source: yfinance for both SPY and TLT (TLT launched 2002).

## Failure modes / when these break

### Yield curve

- **Doesn't predict the *severity* of the recession**, only the existence. The 2020 COVID recession was preceded by a brief inversion in 2019; the curve "told" you a recession was coming but said nothing about whether it'd be deep or shallow.
- **Times wrong sometimes:** the 2022-2023 inversion preceded a Fed pause that delayed the recession by ~2 years (still ongoing debate whether one occurred).
- **Distorted by QE/QT.** When the Fed actively manipulates the long end via balance-sheet operations, the signal weakens.

### Credit spreads

- **Coincident-leading.** Tends to widen alongside equity sell-offs, not before. Better as a confirmation than as a forecaster.
- **Energy-sector heavy in HY.** When oil crashes (2014-2016, 2020) HY spreads widen on energy-credit concerns even if broader credit is fine. Watch the sector composition.
- **HYG/LQD ratio is imperfect** because LQD has duration risk (rate sensitivity) that HY doesn't have to the same degree. In rising-rate environments LQD falls for non-credit reasons.

### Put/call ratio

- **Mean reverts quickly.** Single-day extremes aren't actionable; look at 5-day or 10-day rolling averages.
- **Index put/call vs equity put/call diverge** during specific events (hedging vs speculation).
- **Inversion at extremes:** very high readings can persist during sustained sell-offs; they're not a reliable bottom call.

### SPY/TLT rotation

- **Treasury safe-haven bid is regime-dependent.** During the 2022 bear market, both SPY AND TLT fell because rates rose; the "rotation" signal would have stayed flat or even inverted. So this indicator works when bonds are risk-off; doesn't work when bonds are themselves the source of stress.
- **Use as confirmation, not primary signal.**

### Common to all leading indicators

- **They don't all fire on the same day.** Real stress events typically have 2-4 of these going off in sequence (yield curve first, then credit, then VIX, then breakdown). The classifier should look for *multiple categories firing*, not any single one.
- **Calibration matters.** "Yield curve inverted" needs a threshold (does it need to be below -0.1%? -0.3%? for how many consecutive days?). Calibration is empirical, not theoretical.

## How this changes our project

The original phase1_v2 classifier used 4 categories: VIX term, HYG/SPY, breadth_narrow, realized_stress. Three of those (everything except breadth_narrow) are stock-agnostic — they work fine without constituent data.

The phase1_v3 design (SPEC: `docs/specs/macro-regime-classifier-phase1_v3.md`) drops `breadth_narrow` and adds:

- **T10Y2Y** (FRED) — yield curve
- **HYG/LQD ratio** (yfinance) — credit spread proxy
- **SPY/TLT ratio** (yfinance) — risk-on/off proxy

This gives 6 categories (will be 7 once put/call is added next turn). The classifier sees red regimes it couldn't see before, no paid data required.

**The deeper methodology lesson:** when a data-layer problem blocks you, ask whether the *indicator that uses the contaminated data* is essential to the analysis, or whether better indicators exist that don't depend on it. Often the answer is "better indicators exist and we just hadn't wired them up."
