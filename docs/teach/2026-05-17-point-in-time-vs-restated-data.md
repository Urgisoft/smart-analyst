# Point-in-Time (PIT) vs Restated Data

**Source citations:** López de Prado, *Advances in Financial Machine Learning* (2018) ch. 1 "Financial Data Structures" — discusses raw vs derived data integrity and the principle that data cleaning hides things. Bali, Engle & Murray, *Empirical Asset Pricing* (2016) ch. 1-2 — covers PIT requirements for cross-sectional return prediction. Compustat documentation distinguishes PIT vs non-PIT product lines explicitly (this is the most concrete vendor-side treatment). Fama & French (1992, "The Cross-Section of Expected Stock Returns") quietly assumes PIT availability when constructing book/market factors.

## Intuition

A "point-in-time" (PIT) data record answers the question: *"What did the world know on date X?"* It is the snapshot you would have actually seen if you had been there with a Bloomberg terminal at 4pm on that day. "Restated" data answers a different question: *"What do we now believe about the financials of period X, given everything reported since?"* The two questions sound similar; they are not.

The trap: a backtest that uses restated data is silently using information the algorithm couldn't have known on the date it pretends to be trading. The numbers look better than reality. Sharpe inflates, hit rate inflates, profit factor inflates — and the inflation is invisible because there's no separate variable to look at. The algorithm just appears to be skilled. It isn't. It's reading the answer key.

This is a special case of **look-ahead bias** (also called **information leakage** or **the lookahead fallacy**). It's one of the canonical ways a backtest lies to you.

## Mechanism

### Where restated data comes from

Companies routinely revise prior quarters' financial statements:

- **Restatements** — material corrections (errors, fraud, accounting policy changes). Filed as a 10-K/A or 10-Q/A amendment. SEC requires these to be tagged as amendments with their own filing dates.
- **Reclassifications** — non-material moves between line items (e.g., reclassifying a cost as COGS vs SG&A). Usually appear in the next regular filing's comparative period without an amendment.
- **Acquired-business retroactive integration** — when a company acquires another, the combined entity's prior periods are often restated to show the combined picture.
- **Discontinued operations** — when a segment is sold or wound down, prior periods are commonly restated to exclude it from continuing operations.

Most free data providers (yfinance, Google Finance historically) pull the most recent filing's view of every prior period. When you query "Q1 2020 earnings for AAPL" in 2024, you get the 2024 view of Q1 2020 — i.e., whatever has been restated, reclassified, or revised since.

### Why this poisons backtests

Suppose your algorithm buys stocks with the highest trailing-12-month earnings growth, rebalanced monthly. You backtest with yfinance fundamentals. The algorithm "discovers" that Company X had spectacular Q2 2019 earnings — but in the real Q2 2019 release, Company X reported numbers that were later restated upward (perhaps because a contingent revenue recognition resolved favorably in 2020). Your backtest buys X in Q3 2019 based on the restated numbers; the algorithm appears skilled. In live trading, you'd never have seen those restated numbers in Q3 2019 — you'd have seen the original (lower) numbers and the buy signal wouldn't have fired.

The bias is systematic, not random: restatements tend to clean up noisy ambiguity in the direction that matches what later turned out to be true. Backtests on restated data over-weight the kinds of signals that companies are most likely to later "confirm" via restatement, which is a category of look-ahead.

### How PIT vendors implement the discipline

Sharadar SF1, S&P Compustat (the "PIT" product line, not the standard one), and Capital IQ are the standard paid sources for PIT fundamentals. They implement the discipline by:

1. Storing every reported value with the date of the filing that reported it.
2. Never overwriting historical values. A Q1 2020 EPS value reported in May 2020 stays at $1.23 even after the company restates it to $1.45 in November 2020 — the November value is a NEW record with its own filing date.
3. Exposing a query interface that takes an "as-of" date and returns the values that were most-recently known on or before that date.

SEC EDGAR has all the same primary data for free (every 10-K, 10-Q, 10-K/A, 10-Q/A is timestamped at submission). The paid vendors are charging for the PIT-storage layer + the XBRL parsing + the ticker/CIK mapping. You can replicate this yourself from EDGAR; the engineering is real (XBRL is verbose, fundamentals coverage requires parsing 100+ tags carefully, ticker history requires reconciling against multiple sources), but the data itself is free.

## Failure mode

PIT discipline assumes the **filing date** is the right "as-of" date. This is usually true but not always:

- **Pre-announcement leaks** — material information sometimes leaks before the official filing. PIT on filing date understates the actual look-ahead some traders had.
- **Post-close releases** — companies often release earnings after market close. Strict PIT users sometimes lag by one trading day to account for the fact that you couldn't have acted on after-close info until the next morning's open.
- **Restatement detection** — if your PIT pipeline misses a restatement amendment (10-K/A vs 10-K), you'll silently fall back to the original — usually safer for backtest integrity than the inverse but not the right answer either.
- **PIT data is still imperfect** — even paid PIT vendors occasionally backfill corrections, especially for older periods where data is sparse. PIT reduces look-ahead; it doesn't eliminate it.

The most insidious failure mode is **partial PIT** — a dataset that's PIT for some fields and restated for others. Many free / freemium fundamentals APIs do this without telling you. If you're using one, the only safe assumption is "treat the whole thing as restated unless I can verify the field-level PIT discipline."

For SignalForge specifically: if a future Phase wires fundamentals into the equity-backtest universe, the choice between (a) SEC EDGAR direct, (b) FinancialModelingPrep / SimFin free tier, (c) Sharadar / Compustat paid, should be made with eyes open on this tradeoff. (a) is the only free path that's PIT-correct; (b) is convenient but its PIT discipline is opaque; (c) is the easy button if the budget is there.
