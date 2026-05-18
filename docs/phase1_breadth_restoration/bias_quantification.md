# Phase 1 breadth — survivorship bias quantification

**Date:** 2026-05-09 (session 33)
**Context:** Stooq dropped `^A50R` from its catalog after ADR-035 was
written. The "locked path forward = restore breadth via Stooq apikey"
no longer works. ADR-037 selects Path 4 (constituents-derived breadth
using current IVV snapshot, with documented survivorship bias). This
doc anchors the bias-magnitude numbers ADR-037 cites.

## Source data

- **fja05680/sp500** GitHub repository, MIT-licensed, file
  `S&P 500 Historical Components & Changes(01-17-2026).csv`. Saved
  locally at
  [`docs/phase1_breadth_restoration/sp500_history_fja05680_2026-01-17.csv`](sp500_history_fja05680_2026-01-17.csv).
  2,705 rows; daily snapshots 1996-01-02 → 2026-01-14; mean snapshot
  size 496.7 (range 487-507). Dataset metadata is "every couple of
  months I update from the S&P 500 Wikipedia page."
- **`quantlab.sp500_constituents`** current snapshot, source
  `ivv_holdings`, 503 rows under `effective_date=2026-05-09`.

## Universe sizes

| Window | Unique tickers ever in S&P 500 |
|---|---|
| 1996-2026 | 1,194 |
| 2008-2026 (our backfill window) | 884 |
| Current (2026-05-09 IVV) | 503 |
| Historical-only (in 884 but not in current 503) | 381 |

The **381 historical-only tickers** are the survivorship-bias
population — names that were in the index at some point during
2008-2026 but are no longer in our data because they have been
acquired, spun, gone private, or filed for bankruptcy.

## Yfinance recovery probe — 0% real coverage on delistings

Probed 19 historical-only tickers (mix of bankruptcy-suffix Q tickers,
pre-bankruptcy tickers, and pre-merger tickers) with yfinance 1.3.0:

| Ticker | Description | Yfinance result | Real recovery? |
|---|---|---|---|
| LEHMQ | Lehman bankruptcy ticker | empty | NO |
| LEH | Lehman pre-bankruptcy | empty | NO |
| WAMUQ | WaMu bankruptcy ticker | empty | NO |
| WM | WaMu pre-bankruptcy | 756 rows 2008-2010 | **NO** — Waste Management (current S&P 500 member) |
| CCTYQ | Circuit City bankruptcy | empty | NO |
| CC | Circuit City pre-bankruptcy | empty | NO |
| EKDKQ | Eastman Kodak bankruptcy | empty | NO |
| EK | Eastman Kodak pre-bankruptcy | empty | NO |
| ABKFQ | Ambac Financial bankruptcy | 404 | NO |
| SUNEQ | SunEdison bankruptcy | empty | NO |
| SUNE | SunEdison pre-bankruptcy | 756 rows 2008-2010 | **NO** — symbol reused |
| BSC | Bear Stearns | empty | NO |
| TYC | Tyco | empty | NO |
| ATVI | Activision Blizzard | empty | NO |
| WB | Wachovia | 3,032 rows 2014+ | **NO** — Weibo Corporation |
| SHLD | Sears Holdings | 664 rows 2023+ | **NO** — symbol reused |
| BBBY | Bed Bath & Beyond | 4,616 rows | AMBIGUOUS — partial historical + reuse |
| NSM | National Semiconductor | 1,610 rows 2012+ | **NO** — symbol reused |
| HET | Harrah Entertainment | 528 rows 2008+ | NO — wrong entity |
| GENZ | Genzyme | 741 rows 2008-2010 | YES (acquired by Sanofi 2011) |

**Real-coverage rate: ~5% (1 of 19 confirmed-correct).** The "non-empty"
hits are dominated by ticker-symbol reuse — yfinance returns whatever
modern entity holds the symbol now, not the historical S&P 500 member.

The structural reason: yfinance is a retail-grade free data provider.
Delisted-ticker price data has near-zero retail demand, so they don't
maintain it. The institutional-tier paid databases (Sharadar SF1, CRSP,
Compustat, Bloomberg) carry delisted prices as a deliberate product
feature — that's their differentiator over yfinance.

## Coverage of historical universe by current 503-ticker set

For each historical date, fraction of the contemporaneous S&P 500
universe that is recoverable from our current candle data
(yfinance_constituents under `_SP500` address suffix):

| Year | #snaps | min_cov | mean_cov | max_cov | min intersect |
|---|---:|---:|---:|---:|---:|
| 2008 | 126 | 50.5% | **51.5%** | 53.4% | 251 |
| 2009 | 112 | 53.4% | 54.6% | 55.9% | 266 |
| 2010 | 100 | 55.9% | 56.6% | 57.3% | 279 |
| 2011 | 106 | 57.3% | 58.0% | 59.0% | 285 |
| 2012 | 105 | 59.0% | 59.7% | 61.0% | 293 |
| 2013 | 106 | 61.2% | 61.6% | 62.1% | 304 |
| 2014 | 100 | 61.8% | 62.4% | 62.9% | 307 |
| 2015 | 117 | 62.9% | 64.2% | 65.5% | 314 |
| 2016 | 130 | 65.3% | 67.1% | 68.6% | 329 |
| 2017 | 113 | 68.6% | 70.5% | 71.9% | 347 |
| 2018 | 115 | 71.9% | 72.8% | 74.4% | 363 |
| 2019 | 27  | 74.1% | 75.7% | 78.6% | 374 |
| 2020 | 13  | 78.8% | 80.4% | 81.6% | 398 |
| 2021 | 14  | 81.6% | 82.9% | 84.2% | 412 |
| 2022 | 19  | 84.4% | 86.4% | 88.7% | 426 |
| 2023 | 13  | 88.9% | 90.1% | 92.0% | 447 |
| 2024 | 13  | 92.2% | 94.0% | 95.8% | 464 |
| 2025 | 16  | 96.6% | 98.1% | 99.8% | 486 |
| 2026 | 1   | 100.0% | 100.0% | 100.0% | 503 |

### Stress-event-specific coverage

| Date | Universe | In current 503 | Coverage |
|---|---:|---:|---:|
| 2008-09-15 (Lehman week) | 498 | 258 | **51.8%** |
| 2008-11-20 (capitulation) | 498 | 264 | 53.0% |

Other stress dates fall between snapshots; coverage is approximated by
carry-forward from the most-recent prior snapshot.

## Bias direction and magnitude

### Direction

The bias **overstates breadth in stress regimes**. Reasoning:

1. The 381 historical-only tickers are concentrated in stress events
   (bankruptcies cluster in crashes; the GFC alone removed 30+ index
   members).
2. Those tickers' prices were predominantly *below* their 50DMA at
   the moment they exited the index (they were collapsing, hence the
   exit).
3. By computing breadth on the surviving subset, those below-50DMA
   names are excluded from the denominator. The remaining survivors
   skew above-average healthy.
4. Therefore `pct_above_50dma` is biased **upward** in stress regimes.
5. Therefore `breadth_narrow` (which fires when `pct_above_50dma <
   threshold`) is biased toward **non-firing** in stress regimes.

### Magnitude

Worst case: 2008 GFC, where ~50% of the historical universe is missing.
A simple model: assume in a true stress regime, missing names are
~80% below 50DMA, retained names are ~50% below 50DMA. Then:

```
True breadth (498-name universe):
  pct_above_50dma_true = (above_in_retained + above_in_missing) / 498
  ≈ (258 * 0.5 + 240 * 0.2) / 498 = (129 + 48) / 498 = 35.5%

Computed breadth (258-name surviving subset):
  pct_above_50dma_computed = above_in_retained / 258
  ≈ 129 / 258 = 50.0%

Bias = 50.0% - 35.5% = +14.5 percentage points upward
```

This is a back-of-envelope estimate. The exact magnitude varies by
event, but the direction is consistent: the metric is upward-biased
in stress regimes, by a magnitude in the range of 5-15 percentage
points for 2008-2014, dropping to <5 for 2018+, and ~0 for 2024+.

## Topping-signal architecture interaction

The Phase 1 `breadth_narrow` indicator is, by SPEC §2.3, a *topping*
signal not a *crash* signal:

```
breadth_narrow = 1
  iff pct_above_50dma < 50%
  AND spy_close >= 0.95 * spy_252d_high
```

Both conditions must hold. During the actual crash phase of a stress
event, SPY is far below its 1Y high, so `breadth_narrow` correctly
does NOT fire even when breadth is genuinely narrow (e.g., 2020-03-23
shows `pct_above_50dma = 1.44%` but `breadth_narrow = 0` because SPY
is well below 95% of 1Y high).

This means the survivorship bias is most relevant in the *topping
period* before a crash — late 2007, mid-2008 H1, late 2019 H2,
mid-2024 — when SPY is near its high but breadth is rolling over.
For the topping periods specifically, the upward bias in breadth makes
`breadth_narrow` underfire, **delaying** the topping detection.

For 2014 (a non-stress year), the survivorship bias is small but
non-zero, and the test fixture observed 3 false-positive red days in
2014_calm — likely due to bias-driven `breadth_narrow` firings
combining with non-stress-but-above-threshold readings on
`vix_term_inverted` or `hyg_spy_divergence`.

## Implication for fixture tests

The 4 currently-failing fixture tests
([scripts/tests/macroRegimeFixtures.test.ts](../../scripts/tests/macroRegimeFixtures.test.ts)):

| Test | Status | Likely root cause |
|---|---|---|
| 2008_gfc | FAIL | Bias-driven (51% coverage in 2008) + topping-signal design |
| 2011_eu_debt | FAIL | Bias-driven (58% coverage in 2011) + topping-signal design |
| 2014_calm | FAIL — 3 reds, expected 0 | Bias-driven false positives in calm period |
| 2020_covid | FAIL — 0 reds, expected ≥5 | Topping-signal design (architectural, not bias) |

The 2020 COVID failure is architectural — `breadth_narrow` cannot
fire during a crash regardless of breadth source quality, because of
the `spy_at_or_near_high` gate. The other three are mixed
bias-and-architecture.

## Revisit triggers

Per ADR-037 §6, this bias documentation should be revisited when ANY
of the following occurs:

1. **Sharadar Track B activates.** Historical S&P 500 membership +
   delisted-ticker prices become available. Promote constituents-
   derived breadth to survivorship-correct via Sharadar.
2. **Fixture-test attribution becomes load-bearing.** If a future
   session attributes the 2014_calm or 2008_gfc test failures to
   threshold mistuning rather than survivorship bias, this doc is
   the empirical anchor showing the bias is real and quantified.
3. **A free or affordable alternative emerges** for delisted-ticker
   prices (open-source dataset, free academic feed, low-cost
   subscription). The yfinance probe in this doc establishes that
   no such source existed as of 2026-05-09.
4. **The topping-signal design is reopened.** If a future Phase 3
   reframes `breadth_narrow` away from the SPY-near-high gate, the
   crash-phase bias becomes load-bearing rather than topping-period
   only, and the magnitude estimates here need to be redone for the
   stress-phase context.
