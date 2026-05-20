# ETF Flow Divergence as a Leading Indicator

> **Source:** Ben-David, Franzoni, Moussawi 2018 "Do ETFs Increase Volatility?" *Journal of Finance* 73(6), 2471-2535 (Tier 1).
> Brown, Davies, Ringgenberg 2021 "ETF Arbitrage, Non-Fundamental Demand, and Return Predictability" *Review of Financial Studies* 34(7), 3145-3192 (Tier 1, predictability extension).
> **Why this is in the canon:** ETFs aggregate the trading desks of large allocators in a way no other instrument does. When pension funds rotate from QQQ into XLP, that rotation is observable AT THE DOLLAR in real time — not via 13F filings 45 days later, not via flow-of-funds reports a quarter later.

---

## Intuition

The price of an ETF is anchored to its NAV (the value of the underlying basket) by an arbitrage mechanism: authorized participants (APs) create new ETF shares when the ETF trades above NAV and redeem shares when it trades below. Each creation is the AP buying the underlying basket and delivering it to the issuer in exchange for fresh ETF shares; each redemption is the reverse.

The number of shares outstanding for a given ETF therefore moves up when net demand exceeds net supply — i.e., when allocators are net-buying the ETF — and moves down when net redemptions dominate. **Shares outstanding is the cleanest available measure of net dollar flow into the ETF**, because the AP arbitrage chain has no informational filter: it just trades whatever the imbalance demands.

The leading-indicator intuition: when **price moves up while flows move out** (positive return, negative flow), the move is structurally weak — there is no allocator-conviction support behind it; somebody is selling INTO strength, and the price will roll over. The mirror case (price down while flows in) is the value-buyer footprint — allocators are stepping in below the market, and the price will mean-revert up.

This is what "flow vs price divergence" means in BFM 2018's language: the two series carry different information when they disagree, and the disagreement is informative for the next 5-20 trading days.

---

## Mechanism

### Constructing the flow series (BFM 2018 §3)

For each ETF `e` and each trading day `t`:

```
shares_t            = shares-outstanding of e at end-of-day t  (Yahoo Finance shares_full)
close_t             = closing price of e on day t              (Yahoo Finance history)
AUM_t               = shares_t × close_t                       (assets under management)

flow_shares_t       = shares_t - shares_{t-1}                  (one-day net creation/redemption)
flow_dollar_t       = flow_shares_t × close_t                  (dollar value of one-day net flow)

flow_dollar_20bd_t  = sum over i in [t-19, t] of flow_dollar_i (cumulative dollar flow over 20bd)
flow_pct_aum_t      = flow_dollar_20bd_t / AUM_t               (normalized by current AUM)
```

The normalization by AUM matters: SPY's $500B AUM and XLRE's $5B AUM mean that an absolute $100M flow is a noise-level event for SPY and a regime-shift event for XLRE. Dividing by AUM gives a unit-free comparable across ETFs of different sizes.

The cumulative-flow construction (sum over the window) is intentionally NOT computed as `(shares_t - shares_{t-20bd}) × close_t`. The latter would attribute all the 20bd flow to today's close, which is wrong when prices have moved during the window — flows that happened 18 days ago at a 5% lower price should be valued at THAT price. BFM 2018 footnote 7 makes this explicit.

### The z-score (against 1y daily baseline)

The raw `flow_pct_aum_t` is then z-scored against its trailing 1-year daily history:

```
flow_z_t = (flow_pct_aum_t - mean_1y) / stddev_1y
```

This gives a unit-free comparable across both ETFs AND time. A `flow_z = +2.0` on QQQ in 2026 means QQQ is currently in the top 2.3% of 20bd flow magnitudes seen over the last year — regardless of whether QQQ historically averages $5B/quarter inflows or $50B/quarter inflows.

The MIN_Z_BASELINE = 30 floor on baseline size matches all other Layer-0 composites — a z-score against <30 prints is not statistically meaningful and degrades to `null`.

### The divergence flag

For each ETF, the 20bd return is similarly z-scored:

```
return_20bd_t        = close_t / close_{t-20bd} - 1
return_z_20bd_t      = (return_20bd_t - mean_1y) / stddev_1y
```

The divergence flag fires when:

```
sign(flow_z_t) ≠ sign(return_z_20bd_t)    # the two series disagree on direction
AND |flow_z_t| > 1                        # flow is at least 1σ from mean
AND |return_z_20bd_t| > 1                 # return is at least 1σ from mean
```

The ±1σ thresholds are inherited from the cross-asset / sector-rotation / short-interest composites (not calibrated against in-sample backtests, which would violate the no-tuning canon). The choice to require BOTH series to clear 1σ is what makes the signal a divergence rather than just a flow-or-return tail event — when both are extreme AND in opposite directions, the disagreement carries information.

### The aggregate measures

**Sector flow dispersion** = cross-sectional stddev of the 11 SPDR sector flow z-scores at time t:

```
sector_flow_dispersion_t = stddev({flow_z(XLK_t), flow_z(XLF_t), ..., flow_z(XLC_t)})
```

When all sectors move the same way (broad risk-on or broad risk-off), dispersion is low. When some sectors get heavy inflows while others get heavy outflows (active rotation regime), dispersion is high. The `> 2.0` threshold flags an active-rotation environment — useful for momentum strategies (rotation regime favors trend-followers) vs mean-reversion strategies (rotation regime is hostile because the cross-section is genuinely changing, not just oscillating).

**Aggregate risk-on flow** = mean of broad-index ETF flow z-scores:

```
aggregate_risk_on_flow_t = mean({flow_z(SPY), flow_z(IVV), flow_z(VOO), flow_z(QQQ), flow_z(IWM), flow_z(DIA)})
```

Captures broad risk-appetite direction. A `+2σ` reading is the broad market getting hosed with inflows; `-2σ` is the broad market in net-outflow stress.

---

## Failure mode

**(1) Yahoo Finance shares-outstanding lag.** Yahoo publishes shares outstanding on T+1 to T+2 typically — issuers report creation/redemption activity to NYSE ARCA next-day, and Yahoo's data pipeline takes another business day to reflect it. The composite uses carry-forward when shares don't update (the F-CADENCE staleness flag fires when >3 business days have passed without a shares update). **What this can hide:** a creation/redemption spike that happened on day T isn't visible in the flow series until T+1 or T+2 — i.e., the leading-indicator horizon is shortened by 1-2 days relative to a real-time feed (Bloomberg). For 20bd cumulative windows, this is small; for hypothetical 5bd windows, it'd matter more.

**(2) Equity-only-ETF coverage.** The v1 universe is 21 ETFs covering broad-index + SPDR sectors + style/credit/duration. Currency-hedged ETFs, leveraged ETFs (TQQQ, SQQQ), and inverse ETFs are excluded. **Why this matters:** leveraged ETF flows are a known signal in their own right (Pessina-Whaley 2021 documents that levered-ETF rebalancing flows distort underlying volatility) but are NOT a substitute for ordinary-ETF flow; they measure something different (speculator positioning, not allocator positioning).

**(3) Creation/redemption arbitrage timing.** The AP creation/redemption process is T+2 settle. Shares outstanding records the trade-date moment; the cash side settles two days later. **What this hides:** an AP can commit to creation on day T (recorded in the shares panel) and then have the AUM-backing cash side fail-to-deliver. Yahoo's panel still shows the creation. Fail-to-delivers in ETFs are rare for the v1 universe (high-liquidity ETFs) but not zero — they're tracked in the SEC's FAILS-TO-DELIVER data. Out-of-scope for v1; a forensic-deep-dive signal only.

**(4) Same-name multi-listings.** SPY (NYSE ARCA), IVV (NYSE ARCA), VOO (NYSE ARCA) all track the S&P 500. They have correlated but distinct flow patterns — IVV is dominated by BlackRock's iShares retail + advisor channel; VOO is dominated by Vanguard's index investor channel; SPY is dominated by institutional + hedge-fund + day-trader flow. **What this hides:** the methodology's aggregate-broad-index mean treats them as 6 independent observations when they have ~0.7 cross-flow correlations. The standard error of the mean is overstated under independence assumption. This is documented but accepted in v1; Phase B regression can decorrelate via factor extraction or PCA on the broad-index flow panel.

**(5) Regime breaks in the 1y baseline.** A 1y trailing baseline is short by the standards of equity-volatility regimes — a sharp regime break in the past 1y (e.g., a 2020-pandemic-style flow shock) inflates the baseline stddev for the subsequent year, suppressing flow z-scores to near-zero. **What this hides:** in the second half of 2026, if a March 2026 shock baselined into the 1y window, current flow z-scores would understate the surprise. The 1y window is the gap-doc-specified choice; longer windows (3y, 5y) lose recency and over-anchor to old regimes. v2 ADR scope: GARCH-based or EWMA-baselined alternatives.

**(6) Flow-leading-price is canon for 5-20bd; NOT for longer horizons.** BFM 2018 and BDR 2021 both measure predictability at 5-20 bd. Extending the divergence signal to 60+ bd horizons would extrapolate beyond the canon. The composite operates strictly at 20bd; longer-horizon claims should NOT be made from this signal alone.

**(7) Style / credit / duration ETF flows are NOT homogeneous with equity ETF flows.** HYG (high yield credit), JNK (high yield credit), TLT (long Treasuries), GLD (gold) are in the v1 universe for risk-on-off characterization but their flow signals carry different information than SPDR sector ETF flows. HYG flow is partly a credit-spread signal (the cross-asset composite covers this independently); TLT flow is partly a duration / inflation signal (also independently surfaced in cross-asset). **What this means:** the cross-asset composite and the etf-flow composite WILL share some information through these four ETFs. Phase B independence testing per the gap doc is the load-bearing check; if correlation >0.7, the etf-flow composite gets demoted or the overlapping ETFs get dropped.

---

## How this composite differs from the prior six Layer-0 composites

| Composite | Per-element signal | Aggregate signal | Canon strength |
|-----------|--------------------|-----------------|----------------|
| cycle_v1 | yield curve inversion (binary) | (none — single signal) | Tier 1 (Estrella-Hardouvelis, Adrian-Estrella) |
| vol_struct_v1 | term-structure backwardation | VIX z-score | Tier 1 (Bollerslev-Tauchen-Zhou) |
| sector_rot_v1 | per-sector momentum z-score | dispersion-of-momentum-z | Tier 1 (Moskowitz-Grinblatt, Asness-Moskowitz-Pedersen) |
| cross_asset_v1 | cross-asset signed-z (credit, FX, vol) | OR-aggregate of flagged | Tier 1 (Chen-Roll-Ross factor model lineage) |
| short_interest_v1 | per-ticker SIR z-score | sector-aggregate SIR z | Tier 1 (Diether-Lee-Werner 2009) |
| exec_departure_v1 | binary in-window flag (per-ticker) | sector cluster z-score | Tier 1 thin (Warner-Watts-Wruck; canon-thin caveat) |
| **etf_flow_v1** | **per-ETF flow_z + divergence_flag** | **sector dispersion + broad mean** | **Tier 1 (Ben-David-Franzoni-Moussawi 2018)** |

The etf-flow composite has the strongest canon footing of the post-cycle Layer-0 set (BFM 2018 is one of the most-cited ETF-markets papers of the past decade). It is also the lowest-storage-cost (~1.5MB/year snapshot growth vs short-interest's ~20MB/year) and the most operationally simple (single Python library, no scraping, no schema brittleness).

---

## Bottom line

When ETF flows and price returns disagree on direction AND both are >1σ from baseline, you're looking at a leading indicator with 5-20 trading day predictive horizon. The aggregate sector-flow dispersion characterizes the regime (rotation vs broad risk-on-off), and the aggregate broad-index flow mean characterizes risk-appetite direction. All measurements live at 20 business day cumulative windows, z-scored against trailing 1y daily history. None of it gates trading in v1 — it's informational substrate for Phase B independence validation and eventual ADR-driven promotion to phase1_v3 categories.
