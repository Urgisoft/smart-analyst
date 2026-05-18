# Equicorrelation as a regime indicator — Pollet-Wilson and "tickers move together in stress"

**Source:** Pollet & Wilson (2010), *Average Correlation and Stock Market
Returns*, *Journal of Financial Economics* 96, 364-380. Driessen, Maenhout
& Vilkov (2009), *The Price of Correlation Risk: Evidence from Equity
Options*, *Journal of Finance*. Buraschi, Porchia & Trojani (2010),
*Correlation Risk and Optimal Portfolio Choice*, *JoF*. Hamilton (1989),
*A New Approach to the Economic Analysis of Nonstationary Time Series*,
*Econometrica* (foundational regime-switching). Ang & Bekaert (2002),
*International Asset Allocation with Regime Shifts*, *Review of Financial
Studies*. ADR-031 (regime-gated trend_v1, empirically rejected on
equity_midcap).

User-triggered context: "the trend of market is that market tickers move
together. I have observed that multiple times."

---

## Intuition — what the user observed

You noticed that when the market is stressed, individual stocks stop
moving on their own news and start moving in lockstep. AAPL, JPM, XOM,
JNJ — usually they trade on their own factors (product cycles, rate
exposure, oil prices, drug pipelines respectively) — but during March
2020 or late 2022, they all sold off in unison. That observation is
real, has a name (*equicorrelation* or *average pairwise correlation*),
has been formalized in academic finance, and has predictive power
distinct from VIX and from broad-market trend filters.

This matters because it's the most theoretically grounded answer to
"what regime measure might have flagged 2020?" — and 2020 is exactly the
regime where `mr_v1/p=14` lost money in our backtest (-2.21% / 58.8% WR).
The Faber-style SPY 200d filter (ADR-031) didn't help because by the
time SPY drops below its 200d MA, the V-recovery is already underway.
Equicorrelation rises *earlier* and stays elevated *longer* than
trend-based regime measures.

## Mechanism — what equicorrelation actually measures

For a universe of N stocks, define average pairwise correlation over a
rolling window:

```
ρ̄_t = (2 / N(N-1)) × Σ_{i<j} ρ_ij(t)

where ρ_ij(t) = rolling Pearson correlation between
                stock i and stock j daily returns over a
                K-day window ending at t (typical K = 30 or 60)
```

Properties:

- ρ̄_t ∈ [0, 1] in practice (rarely negative for equity universes).
- **Low values** (~0.15-0.25 for US equities historically): individual
  stocks moving on idiosyncratic news; "stockpicker's market";
  diversification benefits work.
- **High values** (>0.50): stocks moving together; common-factor
  risk dominating; "everything sells off in sync"; diversification
  benefits collapse.
- **The 2020 spike**: average pairwise correlation among S&P 500
  components went from ~0.3 in February 2020 to over 0.7 by mid-March
  and stayed elevated through Q3.
- **The 2022 spike**: correlations rose throughout the Fed-tightening
  drawdown, peaking around mid-2022.
- **The 2008 spike**: peaked around 0.8 during the depths of the GFC.

Each of these is a regime mr_v1 mean-reversion would lose money in.

## Why it works as a regime indicator

Pollet & Wilson (2010) §3 give the theoretical and empirical case:

1. **Theoretical**: total stock-market variance =
   `(1/N) × avg_var + ((N-1)/N) × avg_cov`. With N large, market variance
   is dominated by `avg_cov`, which is `avg_pairwise_corr × avg_var`.
   So average correlation is the dominant determinant of market-level
   risk when individual variances are stable.
2. **Empirical**: their Table 4 shows that **average correlation
   negatively predicts future market returns** on horizons up to one
   quarter, with t-statistics 2.5-3.0 after controlling for VIX, P/E,
   default spread, term spread, and lagged returns. The predictive
   power survives standard out-of-sample checks.

This is unusual — most "regime indicators" don't survive rigorous
predictive testing. Average correlation does. It's one of a small set of
measures (alongside VIX, term spread, default spread) with documented
forward-looking predictive content for equity markets.

3. **Behavioral interpretation**: when correlations spike, investors
   are trading the market factor rather than individual names. This
   typically happens during liquidity events (forced selling, margin
   calls, panic), which are precisely the regimes where mean-reversion
   strategies fail because the "snap back" doesn't materialize — the
   selling pressure is structural, not sentiment-driven.

## How this would have helped `mr_v1/p=14` in 2020

The mr_v1 backtest losing -2.21% / 58.8% WR in calendar year 2020 is
concentrated in the Apr-Dec V-recovery slice (-2.67% / 55.6% WR over 54
trades). Looking at SPX-component average correlation through 2020:

- Pre-COVID (Feb 2020): ρ̄ ≈ 0.28 (normal stockpicker regime)
- COVID crash (Mar 2020): ρ̄ spiked to ~0.72 within two weeks
- April-September 2020: ρ̄ stayed elevated, ~0.45-0.55
- Q4 2020: gradually declined back to ~0.35

A `mr_v1` entry filter of "ρ̄ < 0.40" would have:

- Filtered out essentially all entries during the Mar-Sep 2020 window
- Re-enabled entries Q4 2020 onward when correlations normalized
- Lost some 2020 trades (mostly the losing ones)
- Preserved 2014-2019 and 2021-2025 entries (low-correlation regimes)

This is testable on historical equity_midcap data; we have all 60
tickers' daily returns. The implementation is ~50 lines of code.

## Implementation sketch

```typescript
// Pseudocode for equicorrelation regime filter

function rollingAvgCorrelation(returns: Map<Symbol, number[]>, t: number, K: number): number {
  const symbols = Array.from(returns.keys());
  const window = symbols.map(s => returns.get(s)!.slice(t - K + 1, t + 1));
  let sum = 0, n = 0;
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const ρ = pearson(window[i], window[j]);
      if (!Number.isNaN(ρ)) { sum += ρ; n++; }
    }
  }
  return sum / n;
}

// In the strategy entry rule:
//   entry: RSI(14) < 30 AND rho_bar(t) < 0.40
//   exit:  RSI(14) > 60   (unchanged)
```

Sweep across `K ∈ {20, 30, 60}` and `threshold ∈ {0.30, 0.35, 0.40, 0.45, 0.50}`
gives a 15-cell stability check. Apply parameter-stability test
(Pardo §10): is the deflated metric a smooth function of (K, threshold)
or a knife-edge spike? If smooth, the regime filter is structurally
real; if knife-edge, it's tuning artifact.

## Failure mode

Three things to watch for:

### 1. Look-ahead bias in correlation computation

The naive computation uses returns through time `t` to filter at time
`t`. This is correct as long as the returns are computed from
already-closed bars. But there's a subtle bias: `ρ̄_t` is computed
using the most-recent K bars *including* the current bar's return. If
the strategy enters at the close of bar `t`, that's fine — the return
through bar `t-1` is fully realized. If the strategy were to enter
intrabar, look-ahead creeps in. Use returns through `t-1` to compute
the filter for entry decisions at `t`.

### 2. Universe-dependent thresholds

The "ρ̄ ≈ 0.40" threshold is calibrated for SPX components. The 60-name
equity_midcap universe is broader and more heterogeneous; its baseline
correlation will be lower. Threshold needs to be re-calibrated for the
specific universe. Use the universe's empirical 70th-percentile or
80th-percentile of historical ρ̄ as a starting point rather than
copying SPX numbers.

### 3. Multiple-testing burden

Adding a regime filter to mr_v1 introduces a new sweep dimension. The
HLZ haircut grows. The deflated Sharpe needs to clear the inflated bar
to count as a real improvement. Pollet-Wilson is academic literature
(Tier 1 source per Vector Core canon) so the *concept* is pre-validated
and counts toward M ≈ 1 on the conceptual choice — but the *threshold
calibration* is a sweep, M ≥ 5 there, t-stat bar rises ~0.3-0.5
points. Plan for that in the deflated metric expectation.

### 4. The Faber-style failure mode could repeat

ADR-031 specifically tested SPY-200d-MA regime gating for trend_v1 and
found it (a) didn't rescue trend_v1's drawdown profile and (b) actively
hurt the deployable mr_v1 baseline. That's an important prior:
**simple, intuitive regime filters have already been tested in this
project and didn't work.** Equicorrelation has stronger theoretical
backing than SPY-200d (Pollet-Wilson is a peer-reviewed JFE paper;
Faber is a working-paper-tier blog-post-derived rule), but the prior
should be calibrated skeptically, not enthusiastically. Expected
verdict: 50-60% likelihood of survival, not the 80%+ that the
theoretical case might suggest.

## When to actually run this

Per project standing rule and ADR-032 deferred-follow-up list, this
goes after:

1. The 4-6 week paper-trading shakedown completes and produces clean
   operational data.
2. Sharadar SF1 opt-in completes and extends the dataset to 2008.

Running it before #1 contaminates the operational signal we're
collecting. Running it before #2 means the regime calibration has 12y
of equity history rather than 16+y including 2008. Both delays are
worth it.

When the time comes, the experiment is bounded: ~1 hour of compute,
diagnostic write-up, ADR if it survives. If it does survive, mr_v1
gets re-graded; if it doesn't, equicorrelation is documented as
"strong theoretical case, doesn't survive validation on this universe"
and the ADR archive captures that finding.

## Why this teach-doc was triggered

The user observed an empirical phenomenon ("market tickers move
together in stress") independently and proposed it as a regime
filter. That observation has substantial academic backing the user
didn't reference (Pollet-Wilson 2010 in particular), and it
specifically addresses the failure regime (2020 V-recovery) that the
existing project's regime-gating attempt (ADR-031, Faber-style) did
not address. Capturing this lineage so:

- Future sessions can reference "user proposed equicorrelation
  filter on 2026-05-06" rather than re-deriving it.
- The Pollet-Wilson source is on the canon list for this project.
- The deferred-follow-up list (ADR-032 and HANDOFF.md) has a clear
  pointer to "this is the highest-priority new regime filter to test
  post-shakedown."
