# SCOPING — Sharadar (Nasdaq Data Link) integration for SignalForge

**Status:** Draft scoping doc · **Date:** 2026-05-07 · **Author:** Vector Core engineering session

**Purpose:** Decide whether to opt into Sharadar's data subscription as the deferred-follow-up flagged across ADRs 028-033. Define what's needed for ingestion, what gaps it actually fills relative to the existing yfinance pipeline, and what the deployment-grade-card upgrade would look like once Sharadar data lands in `quantlab.candles`.

**Source:** Sharadar (sharadar.com) product documentation. Nasdaq Data Link (data.nasdaq.com) python library [github.com/Nasdaq/data-link-python](https://github.com/Nasdaq/data-link-python). Brown, Goetzmann & Ross (1995), *Survival*, *Journal of Finance* 50(3), 853-873 (the canonical survivorship-bias paper, ~2-4%/year inflation when ignored).

---

## §1 · Why we want Sharadar — gaps in the current data

The deployed `mr_v1 / equity_midcap / 1d` cell currently sources candles from yfinance via [scripts/fetch_daily_yfinance.py](../../scripts/fetch_daily_yfinance.py) and the `yfinance_backfill.py` predecessor. Three known gaps with this source:

1. **Survivorship bias.** yfinance returns price history only for currently-listed tickers. The 60-name `equity_midcap` universe is by construction a survivor cohort — names that died (delisting, bankruptcy, M&A acquisition) are absent. Brown-Goetzmann-Ross 1995 §III estimate this inflates returns by ~2-4 percentage points per year on broad equity universes. For our `mr_v1` headline of +6.75% per trade × ~12 trades per token-year = ~80%/year per token gross, the survivorship adjustment may be ~25-50 bps per trade, which is non-trivial but not catastrophic. The bigger concern is that the *worst regimes* (2008 GFC, dot-com bust) saw the highest delisting rates, so survivorship inflates calm-regime performance more than stress-regime performance — which is exactly the asymmetry that makes deployment claims fragile.

2. **Pre-2014 history is patchy.** yfinance's coverage for many of our 60 names goes back to ~2014; some go back further but inconsistently. This means the OOS slices we have (2014-2026) cover one full bull-cycle (post-GFC recovery + COVID dip + AI boom) but **NO 2008-style sustained bear** and **NO dot-com-style equity drawdown**. Two of the most stress-relevant regimes for evaluating a long-only mean-reversion strategy are absent from our test set entirely. Sharadar SEP provides "25 years of history" per their docs — meaning data back to ~2000-2001, including dot-com (2000-2002) and GFC (2008-2009).

3. **Survivor-cohort overstatement at the universe level.** The "equity_midcap" tier we use is defined by *currently being mid-cap*, which is itself a forward-looking filter (today's mid-caps are companies that grew from small-cap, OR that fell from large-cap and didn't keep falling). Sharadar's universe definitions are point-in-time, not forward-looking — so a backtest can use the universe that *was* mid-cap at the trade date, not the universe that *is* mid-cap today.

These three issues compound. The honest deployable claim cannot resolve until Sharadar data is integrated.

## §2 · Sharadar product matrix — what each product is

Sharadar bundles its data on the Nasdaq Data Link platform (formerly Quandl). Relevant products:

| Code | Product | What it is | Relevance to SignalForge |
|---|---|---|---|
| **SEP** | Sharadar Equity Prices | Daily OHLCV for ~10,000+ US equities, **including delisted names**, with dividend and split adjustments. ~25 years of history. | **Primary target.** This is what we actually need. |
| **SF1** | Sharadar Fundamentals | Quarterly and annual fundamental data (revenue, earnings, balance sheet) for the same universe. ~25 years. | Not currently needed — `mr_v1` is purely price-based. Future option for fundamental factor strategies. |
| **SF2** | Sharadar Insider Activity | Insider buy/sell transactions per the SEC Form 4 filings. | Not relevant. |
| **SF3** | Sharadar Institutional Holdings | 13F-derived institutional holdings. | Not relevant. |
| **SFP** | Sharadar Fund Prices | Daily prices for ETFs and mutual funds. | Possibly useful if we add ETF strategies (e.g. SPY for regime-asset). Currently SPY comes from yfinance. |
| **SFA** | Bundle | Combo of SF1 + SEP + others at "preferential pricing." | The natural opt-in if we want both fundamentals and prices. For now SEP-only is sufficient. |

**Important — terminology clarification:** the project's prior handoff and ADR text consistently mentions "Sharadar SF1 opt-in" as the deferred follow-up. Strictly speaking SF1 is fundamentals, not prices — what we actually want for the survivorship-corrected price history is **SEP**. Track this as a notation correction; the deferred-follow-up should be SEP, not SF1. (SF1 may be a useful future addition for fundamental factor strategies but is not what addresses our current data gap.)

## §3 · API access and ingestion mechanics

### Authentication

```bash
pip install nasdaq-data-link
```

```python
import nasdaqdatalink
nasdaqdatalink.ApiConfig.api_key = "YOUR_API_KEY"   # from free Nasdaq Data Link account, plus paid SEP subscription
```

API key obtained by creating a free Nasdaq Data Link account, then linking the paid SEP subscription. Key goes in env var `NASDAQ_DATA_LINK_API_KEY` (matching their convention), parallel to how we currently keep `TELEGRAM_BOT_TOKEN` etc.

### Two access patterns

**Per-row API** (low-volume queries):

```python
data = nasdaqdatalink.get_table('SHARADAR/SEP',
    ticker='AAPL',
    date={'gte': '2008-01-01', 'lte': '2009-12-31'})
# → pandas DataFrame
```

**Bulk download** (full table extract — recommended for our use case):

```bash
pip install ndlbulkdownload
```

```python
from ndlbulkdownload import bulk_download
bulk_download(table='SHARADAR/SEP', output_path='./sharadar_sep.zip')
# → downloads all rows for the table; unzip and bulk-load into ClickHouse
```

For our scale (60 active names + maybe 200-500 delisted names that were once mid-cap × 25 years × 252 trading days × OHLCV rows = ~3-5M rows), bulk download is the right pattern. One-time backfill, then daily incremental via the per-ticker API.

### Schema mapping

Sharadar SEP provides per row (per their docs):
- `ticker` (string) — symbol at the trade date (point-in-time, accounts for ticker changes)
- `date` (date) — trading date
- `open`, `high`, `low`, `close`, `volume` (numeric) — OHLCV
- `closeadj` (numeric) — close adjusted for dividends and splits
- `closeunadj` (numeric) — raw close
- `lastupdated` (date) — when Sharadar last updated this row

Maps cleanly to our existing `quantlab.candles` schema. New `source` value: `'sharadar_sep'` (parallel to `'yfinance'` and `'jupiter_v2'`). Handling of dividend-adjusted vs unadjusted: for backtesting strategies that hold across dividend-pay dates, the `closeadj` series is what we want (holding a stock that pays a $1 dividend doesn't actually reduce your wealth by $1 — the unadjusted close drops by $1 but you receive the cash). The current yfinance pipeline uses adjusted closes by default; Sharadar should match.

## §4 · Pricing — verify directly

Sharadar pricing is not visible on the public product pages I could access — the Nasdaq Data Link product pages are JavaScript-rendered and don't expose pricing without an authenticated session. **The user should verify pricing directly at https://data.nasdaq.com/databases/SEP** before committing.

Indicative range from third-party retail-quant community references (NOT verified by direct fetch in this session):

- **Personal / single-user tier**: SEP standalone is typically in the $50-150/month range for retail subscribers.
- **Bundles (SFA)**: usually have a discount vs purchasing each product separately.
- **Institutional / multi-seat**: significantly higher and not relevant for this project.

A 4-6 week shakedown commitment of ~$50-150 ($150-450 total over 3 months while we evaluate and integrate) is the relevant cost frame, not a one-year commitment.

**Action:** before subscribing, capture a screenshot of the actual pricing page and the licence terms (especially the redistribution clauses — most data providers prohibit republishing the underlying data, which affects whether we can commit ingest results to git or whether they need to live only in the local ClickHouse).

## §5 · Integration cost estimate

Assuming the SEP subscription is approved, the integration work:

| Step | Description | Cost |
|---|---|---|
| 1 | Add `nasdaq-data-link` + `ndlbulkdownload` to `requirements.txt`. Add `NASDAQ_DATA_LINK_API_KEY` to `.env.example`. | 30 min |
| 2 | Write `scripts/sharadar_backfill.py` — bulk download SEP, filter to our universe of interest (active equity_midcap + matching delisted historical), insert into `quantlab.candles` with `source='sharadar_sep'`. Mirror pattern from existing `yfinance_backfill.py`. | 2-3 hours |
| 3 | Add `'sharadar_sep'` to the `SOURCE_PRIORITY_SQL` priority list in `src/server/clickhouse.ts:1469` — give it priority 0 (highest) for equity tickers, since survivorship correction should preempt yfinance. Keep yfinance as fallback for tickers Sharadar doesn't cover. | 30 min |
| 4 | Define `equity_midcap_pit` (point-in-time) universe loader — query SEP for tickers that *were* mid-cap at each historical date, not just today's mid-caps. Requires market-cap snapshots, which Sharadar's `SHARADAR/TICKERS` table provides. | 2-3 hours |
| 5 | Re-run the threshold-stability sweep + per-year breakdown on `equity_midcap_pit`, 25y history. **This is the deliverable** — it answers whether the 30/70 deployable claim survives 2008 and dot-com. | 1 hour |
| 6 | Daily incremental updates — extend `fetch_daily_yfinance.py` to also pull SEP increments, OR write a sister `fetch_daily_sharadar.py`. Daemon coordinates both. | 2 hours |
| 7 | ADR documenting the integration + revised deployable verdict. | 1 hour |

**Total: ~9-12 hours** spread across 2 sessions. Most of the cost is in step 4 (the point-in-time universe), which is the actual methodological win Sharadar provides over yfinance. If we skip step 4 and just add the deeper history on the existing forward-looking universe, the work is ~5 hours but the survivorship bias is only partly fixed.

## §6 · What the deployable verdict could look like post-integration

Post-Sharadar integration produces one of three outcomes:

1. **Best case:** 30/70 mean-reversion holds up across 2000-2026 including dot-com and GFC. Deflated metrics improve (the 2014-2026 window is somewhat survivor-cohort-tilted; expanding to 2000-2026 with delisted names should slightly tighten Sharpe but also extend the OOS sample). **Deployable claim upgrades from CONDITIONAL to RESOLVED-CONDITIONAL.** This is the case for going to small-real-money paper testing after the shakedown.

2. **Middle case:** 30/70 holds up post-2010 but degrades 2000-2010 (different regime, fewer mid-cap mean-reversion opportunities, different fee structure). **Deployable claim stays CONDITIONAL but with explicit "epoch-conditioned" framing** — the strategy is deployable on post-2010 data style but not generally. Adds nuance to risk management.

3. **Worst case:** 30/70 collapses or significantly weakens with deeper history. **Deployable claim downgrades further** — possibly to "validation-rejected, do not deploy real money." This is information-positive even though emotionally negative; it tells us the apparent edge was epoch-specific and we should keep researching.

All three outcomes are useful. Each updates the prior in a meaningful direction. The current deferred-follow-up framing implicitly assumes case (1), but the methodology must be neutral to the outcome.

## §7 · Decision for the user

The Sharadar SEP integration should happen **after** the 4-6 week paper-trading shakedown completes — for two reasons:

1. **The shakedown gives us live operational evidence on top of the historical evidence.** Combining live + Sharadar 25y in one analysis pass is more informative than serially.
2. **Cost minimization on the subscription.** If we subscribe today, we pay ~3 months of subscription before integration even completes (factoring in the 2-session integration arc). Subscribing right after the shakedown ends means we pay exactly when we extract value.

**Pre-shakedown work that doesn't require the subscription:**

- Verify current pricing on the actual product page.
- Read the licence terms carefully — especially redistribution and data-storage clauses.
- Bookmark the SEP table fields documentation.
- Decide whether the project commits Sharadar data to git (probably NO — most data licences prohibit redistribution, and the data is large) or keeps it ClickHouse-only with a `_sharadar_data_local_only/` directory in `.gitignore`.

These are ~1 hour of pre-work the user can do anytime in the next 6 weeks.

## §8 · Recommendation

**Subscribe to SEP (not SF1) at the personal/single-user tier in approximately 4 weeks** (around the midpoint of the shakedown), so the data is downloaded and ready when the shakedown's 6-week mark arrives. Integration arc happens in the week immediately after shakedown end. Total elapsed time from shakedown-end to revised-deployable-verdict: ~2 weeks (1 for integration, 1 for re-run + ADR write-up).

If the shakedown surfaces a fatal kill-criterion trigger before week 4, re-evaluate — there's no point spending money on Sharadar to validate a strategy that has already failed live. The kill-switch infrastructure (per [position-sizing-and-kill-switch.md](position-sizing-and-kill-switch.md)) gives us a clean stopping criterion for this kind of decision.

**SF1 (fundamentals) is NOT recommended at this time.** The project has no fundamental-factor strategies in the deployable lineup or research queue. SF1 becomes relevant only if/when we test something like value-factor mean-reversion (P/E-conditioned RSI dips, e.g.) or factor-tilted versions of `mr_v1`. That's a future research arc, not the current bottleneck.
