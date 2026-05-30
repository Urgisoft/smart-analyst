---
title: Single-Stock Equity Analysis — automation scoping spec
status: PROPOSED
date: 2026-05-30
session: 96 #37 (RESEARCH→SPEC, design-only)
owner: Orchestrator (Vector Core) — drafted by RESEARCH→SPEC architect worker
supersedes: none
superseded_by: none
canon:
  - López de Prado, AFML (2018) §11.3 (CSCV), §11.4 (DSR), §3 (meta-labeling), §1.6/§3.2 (survivorship/leakage)
  - Bailey & López de Prado, The Deflated Sharpe Ratio (2014) §3, §11.5
  - Bailey-Borwein-LdP-Zhu, Probability of Backtest Overfitting (2014) §2 (CSCV)
  - Harvey-Liu-Zhu (2016) §3-§4.2 (multiple-testing haircut, BHY)
  - Pardo (2008) §3 (walk-forward), §10 (OOS-IS)
---

# Single-Stock Equity Analysis — automation scoping spec

> **This is a SCOPING / DESIGN doc, not an implementation.** No code, no ingest, no
> file changes accompany it. It turns the *documented-but-never-built* six-dimension
> manual playbook (`docs/obsidian/symbol-analysis/`) into a phased, validatable,
> free-data-only automated pipeline. The single most important section is §3
> (validation), written specifically to avoid repeating the beta-not-alpha trap that
> just sank the four macro Layer-0 composites (`phase_b_verdicts`: all `partial`,
> DSR fails on 10/12 benchmarks, HLZ fails on 12/12).

---

## 0. The thesis shift the playbook needs (read before §1)

The manual playbook is a **single-symbol, absolute "should I own this?" decision tool**
(its decision framework outputs a position size). That framing is *exactly* the trap
that failed Phase B: "buy good stocks in a bull market" produces a high raw Sharpe that
is pure long-equity beta and is correctly rejected by DSR/HLZ. The macro composites'
`phase_b_verdicts` rows make this concrete — `cross_asset_v1` had OOS/IS = 1.4–1.9
(performance *held up* OOS, so it wasn't overfit) yet DSR failed everywhere: the Sharpe
was real but it was beta, and beta does not survive deflation.

**Therefore the automated playbook is re-cast as a CROSS-SECTIONAL ALPHA signal, not a
single-name verdict.** Each playbook dimension becomes a *per-ticker cross-sectional
sub-score*; the unit of validation is the **return of a beta-neutral long-short
portfolio** built by ranking the S&P 500 universe on the combined score every rebalance.
The single-name "scorecard + position size" UI from `08-decision-framework.md` is
retained as an **informational drill-in** (Layer-5 LLM context / operator-facing
explanation), NOT as the thing that gets a Phase-B verdict. The thing that gets validated
is the ranking's alpha. This is the only re-framing that makes the macro lesson binding.

---

## 1. Dimension → data-source mapping

Verified live against ClickHouse `quantlab` (2026-05-30). Counts/columns below are
inspected, not assumed.

| # | Playbook dimension | Classification | Source (table / endpoint) | Notes & effort |
|---|---|---|---|---|
| **1** | **What is it** (security type, sponsor, structure) | **READY** | `gics_sector_map` (503 tkr, sector+sub-industry), `sp500_history` (PIT membership 1996–2026), `cik_ticker_map` (12,638), `token_metadata` | For the S&P 500 equity universe this dimension is trivially "individual common stock." Security-type branching (ETF/leveraged/bond) is **out of scope for v1** — v1 is stocks-only. Effort: none. |
| **2** | **Fundamentals** (EPS/rev growth, margins, ROE, FCF, debt, beat/miss) | **FREE-NEW** | **SEC EDGAR XBRL `companyfacts` API** — `https://data.sec.gov/api/xbrl/companyfacts/CIK{10-digit-zero-padded}.json` (free, no auth, ~10 req/s w/ `User-Agent` header). Gives every us-gaap tag (Revenues, NetIncomeLoss, EPS, Assets, Liabilities, StockholdersEquity, NetCashProvidedByOperatingActivities, etc.) with the **filing date** for PIT. | The single biggest FREE-NEW build. **Effort: HIGH** (1 ingest script + a new `equity_fundamentals` table keyed `(cik, fiscal_period_end, filed_date, tag, value)`, careful PIT on `filed_date`, restatement handling). CIK↔ticker via existing `cik_ticker_map`. yfinance `Ticker().financials` is a faster but lower-quality fallback (no clean filed-date → leakage risk; EDGAR preferred). |
| **3** | **Valuation** (P/E, P/B, P/S, P/FCF, EV/EBITDA, PEG, div yld) | **FREE-NEW** | EDGAR `companyfacts` (the denominators: earnings, book equity, sales, FCF) **×** `candles` equity daily close (the price numerator — see §1 note). Ratios computed, not ingested. | **Effort: MEDIUM** once §2 lands — valuation is a derived view over fundamentals + price. PEG needs a growth estimate (use realized trailing growth, not analyst consensus, to stay free + leak-free). "Vs own 5y history" and "vs peer/sector median" are cross-sectional/temporal aggregates over the same table. |
| **4** | **Technicals** (52w range, 50/200 MA, RSI, MACD, ROC, volume) | **READY** | `candles` — equity daily bars already ingested: **503 S&P 500 constituents** (`source='yfinance_constituents'`, `token_address='TICKER_SP500'`, `interval='1d'`, **2008-01-02 → 2026-05-08**, 4,617 bars each) **+ 89 benchmark/sector ETFs & single names** (`source IN ('yfinance_regime','yfinance')`, `token_address='TICKER_USD'`, incl. SPY/QQQ/IWM/XLK…XLY/TLT/GLD/HYG/LQD/VIX). | **Effort: LOW.** All indicators are pure functions of the existing OHLCV series. **Watch-out:** equity tickers live under suffixed `token_address` (`AAPL_SP500`, `SPY_USD`) in a table named `candles`/`token_address` — asset-class-correctness rule (ADR-044 domain 3) demands a documented suffix convention so equity math never touches crypto rows. |
| **5** | **Sentiment & options** (put/call, IV, analyst revisions, news) **+ institutional positioning** | **MIXED** → split into two: | | |
| 5a | — Options sentiment (per-name put/call, IV30, IV percentile) | **BLOCKED** | Fidelity/Barchart/MarketChameleon options analytics are auth/paid. CBOE archives give **index-level** P/C only (already in `macro_indicators_cboe`), **not per-name**. | **Per-name options sentiment is BLOCKED on free data.** Recommendation: **drop per-name options from v1** (do not fabricate it). The index P/C stays a macro-regime input only. Mark this dimension **degraded**. |
| 5b | — Institutional positioning (insiders, activists, short interest) | **READY** | `insider_trades` (Form 4, **822,177** rows, 6,316 tickers, 2014–2026, `accepted_at` PIT anchor, `transaction_code` P=open-mkt-buy / S=sell), `schedule_13d_g_filings` (2,955 activist/5% stakes, `accepted_at`), `short_interest` (FINRA, **2,938,092** rows, 43,508 symbols, 2020–2026, `days_to_cover`, `change_pct`), `eight_k_events` (18,683), `executive_departures` (639). | **Effort: LOW–MED.** This is the **highest-signal, fully-ready** slice and the playbook itself flags it (`05-sentiment-options.md`: 13F/Form4/13D, OpenInsider cluster buying). **Build this dimension FIRST** (§4 Phase 1). |
| **6** | **Structure** (concentration, moat, liquidity, costs, insider ownership) | **MIXED** | Liquidity = **READY** (`daily_volume`/`mv_daily_volume` + `candles` → ADV, dollar-volume). Insider ownership trend ≈ **READY** (derivable from `insider_trades` holdings deltas, approximate). Moat/business-model/factor-profile = **BLOCKED-soft** (qualitative; Morningstar Factor Profile is paid). | **Effort: LOW** for the quantifiable parts (liquidity, size). Qualitative "moat" is **dropped from the score** (not automatable on free data); size/liquidity become *eligibility filters*, not score inputs (low-liquidity names excluded, per AFML-style tradeability gate). |
| **7** | **Macro fit** (regime, sector sensitivity) | **READY** | `macro_regimes` (phase1_v3 classifier output, daily 2008–2026, `regime` label + all sub-signals) × `gics_sector_map` (per-ticker sector). | **Effort: LOW.** Macro fit becomes a **regime-conditioning layer** on the cross-sectional score (e.g., favor cyclical sectors in RISK_ON, defensives in RISK_OFF), per the `07-macro-fit.md` sector-sensitivity table encoded as a static sector×regime tilt. **Anti-overfit caution:** this table is a *free-parameter farm* — see §2 (kept OFF by default in v1; tested as a single on/off switch, not a tunable matrix). |
| **DF** | **Decision framework** (combine 7 dims → position) | **RE-CAST** | Combination logic (§2) over the per-dimension sub-scores. | The manual "position size by conviction" table is retained as informational only; the validated object is the cross-sectional rank (§3). |

### Mapping summary

- **READY (in ClickHouse now): 4 dimensions** — #1 what-is-it, #4 technicals, #5b institutional positioning, #7 macro-fit. Plus the liquidity slice of #6.
- **FREE-NEW (buildable, free, not yet ingested): 2 dimensions** — #2 fundamentals + #3 valuation, both gated on one EDGAR `companyfacts` ingest.
- **BLOCKED / DEGRADED: 1.5 dimensions** — #5a per-name options sentiment (BLOCKED, drop), and the qualitative half of #6 structure (moat/factor-profile, dropped from score; quantitative liquidity/size half is READY).

**Headline:** Two of the playbook's three "soft" dimensions (sentiment, structure) are
*mostly* salvageable on free data because the **hard, filing-based** parts (insider/13D/
short-interest, liquidity) are already ingested; only **per-name options** is genuinely
BLOCKED. Fundamentals+valuation are free via EDGAR XBRL but are the real build cost.

---

## 2. Per-stock SCORE design

### 2.1 Universe (cross-sectional, point-in-time)

- **Universe = S&P 500 point-in-time constituents** from `sp500_history` (PIT membership
  1996–2026, 1,194 distinct tickers ever-members — this *includes delisted names*, which
  is what defeats survivorship bias; see §3.4). Daily membership is reconstructable.
- **Price/feature coverage** caps the usable window at the `yfinance_constituents` candle
  span (**2008-01-02 → 2026-05-08**). Pre-2008 membership exists but has no equity candles
  → the backtest window is **2008→present**, matching the macro composites' window for
  cross-comparability.
- **Eligibility filter (not a score input):** drop names below a liquidity floor (ADV
  20-day dollar-volume below a fixed percentile) — a tradeability gate, not a tuned knob.

### 2.2 Per-dimension sub-scores (each a cross-sectional rank in [0,1])

Every sub-score is computed **per rebalance date**, then **cross-sectionally rank-
normalized to [0,1]** (percentile within that day's eligible universe). Rank-normalization
(not z-score) is deliberate: it is scale-free, outlier-robust (AFML §3 favors robust
labels), and makes dimensions combinable without per-dimension tuning.

| Sub-score | Definition (all PIT, all free) | Free params |
|---|---|---|
| **S_inst (institutional positioning)** | Composite of: trailing-90d net insider open-market buying (`transaction_code='P'` $ minus `'S'` $, by `accepted_at`), recent 13D/activist filing flag (`schedule_13d_g_filings`), and short-interest *change* (`short_interest.change_pct`, contrarian: falling SI = bullish). Cross-sectional rank. | window=90d (1) |
| **S_value (valuation)** | Cross-sectional rank of a cheapness composite: trailing E/P, B/P, S/P, FCF/P (inverses of P/E etc.) — equal-weighted rank-of-ranks. **Requires §2 EDGAR ingest.** | none (equal-weight) |
| **S_quality (fundamentals)** | Cross-sectional rank of: trailing ROE, gross-margin trend, FCF-positive flag, low debt/equity. Equal-weighted. **Requires EDGAR ingest.** | none |
| **S_tech (technicals)** | Cross-sectional rank of 12-1 month price momentum (skip last month, the canonical Jegadeesh-Titman construction) + above-200dMA flag. Momentum is the most-replicated cross-sectional equity anomaly. | lookback=12m, skip=1m (fixed, canon) |
| **S_macro (macro fit)** | Sector×regime tilt from `macro_regimes` × `gics_sector_map`. **OFF by default in v1** (single on/off switch tested in §3, not a tuned matrix). | 1 switch |

### 2.3 Combination → composite score

```
score(ticker, t) = mean over INCLUDED sub-scores of S_*(ticker, t)
```

- **Equal-weight mean, no learned weights, in v1.** Rationale (three-criterion test per
  CLAUDE.md): (a) canon — equal-weight beats estimated-weight out-of-sample for small N
  (the "1/N" robustness result, DeMiguel-Garlappi-Uppal 2009, *RFS* — I'm confident this
  paper exists; if the worker can't verify, describe it rather than cite); (b) rigor —
  learned weights are fit on the same data as the validation gate = selection bias (AFML
  §11.4 forbids); (c) min params — equal-weight has ZERO tunable weights.
- **Total free-parameter budget for v1: ≤ 3** (insider window, liquidity floor percentile,
  macro on/off). Everything else is canon-fixed. This is deliberately near the floor — the
  macro composites failed *despite* being near-parameter-free, so adding knobs here would
  be strictly worse.
- **Dimension inclusion is phased** (§4): Phase 1 ships `score = S_inst` alone (READY data
  only); later phases add S_tech, then S_value+S_quality after the EDGAR ingest.

---

## 3. Validation design (THE section — learn from the macro failure)

### 3.1 Cross-sectional portfolio construction (the object under test)

Each rebalance (monthly, first trading day — fixed, not swept):

1. Rank eligible universe by `score(ticker, t-1)` (lagged one rebalance; **no look-ahead**,
   mirrors ADR-051 Decision 1's `t-1` rule).
2. Form **long = top quintile (Q5)**, **short = bottom quintile (Q1)**, equal-weighted
   within leg. Hold to next rebalance.
3. **The test series is the LONG-SHORT (Q5 − Q1) daily return.** This is the alpha proxy:
   long-short is dollar-neutral by construction, so a signal that merely "buys high-beta
   names in a bull market" earns ~0 in Q5−Q1 (both legs rise with the market). **This is
   the structural fix for the beta-not-alpha trap.**

A **long-only top-quintile** variant is computed as a secondary series **but only validated
net of beta** (§3.3), never on raw return.

### 3.2 The four deflation gates (identical thresholds to ADR-051 §Decision 4 — NOT relaxed)

Reuse `src/lib/validator.ts` + `psr.ts` + `cscv.ts` + `hlzHaircut.ts` verbatim. Persist
into the **existing** `phase_b_trials` / `phase_b_verdicts` tables with
`composite_version = 'equity_xs_v1'` so the result sits next to the macro failures and is
directly comparable.

| Gate | Source | Threshold | Applied to |
|---|---|---|---|
| **DSR** | Bailey-LdP 2014 §3; AFML §11.4 | DSR > 0.95 | the Q5−Q1 (and beta-neutral long-only) Sharpe |
| **PBO** | BBLPZ 2014 §2; AFML §11.3 | PBO < 0.5 (eligible at < 0.2) | CSCV over the rebalance-slice Sharpes |
| **HLZ BHY** | Harvey-Liu-Zhu 2016 §4.2; BHY 2001 | passes BHY @ α=0.05, one-sided | M = total trials across all variants (see §3.5) |
| **OOS-IS Pardo** | Pardo 2008 §10 | OOS Sharpe / IS Sharpe > 0.5 | fixed 70/30 split |

PASS-ALL requires all four on the same portfolio variant. Anti-shopping rule (ADR-051
§Decision 5) applies verbatim: a FAIL is permanent; `equity_xs_v2` is a *new* composite
needing independent a-priori motivation, not a re-tuned re-run.

### 3.3 The explicit ALPHA test (the lesson made mechanical)

This is the part the macro campaign lacked. Two complementary alpha definitions; the
signal must clear **both**:

1. **Long-short dollar-neutrality (structural):** the primary series is Q5−Q1, which has
   ≈0 net market exposure by construction. A pure-beta signal scores ≈0 here.
2. **Beta-neutralization (statistical, for the long-only series):** regress the long-only
   top-quintile daily excess return on SPY daily excess return (`candles SPY_USD`):
   `r_p = α + β·r_SPY + ε`. The Sharpe fed to the DSR/HLZ gates is the Sharpe of the
   **residual α-stream** (`α + ε`), NOT of `r_p`. A signal whose return is explained by β
   has α≈0 → fails DSR exactly as it should. (Single-factor CAPM-style neutralization in
   v1; multi-factor FF-style neutralization is a v2 extension, kept out to hold the
   parameter floor.)

> **Acceptance criterion, stated bluntly:** `equity_xs_v1` PASSES only if a *beta-neutral*
> return stream clears DSR/HLZ. If the only thing that clears the bar is the raw long-only
> series (which carries beta), the verdict is **FAIL — beta not alpha**, identical to the
> macro composites. We will write that verdict honestly if that's what the data says.

### 3.4 PIT discipline & survivorship bias

- **PIT anchors (reuse project conventions):** fundamentals keyed on EDGAR `filed_date`
  (never `period_of_report`); insider/13D on `accepted_at` (never `transaction_date` —
  the project's F4-10 anti-leak rule); membership from `sp500_history` as-of the rebalance
  date. Score at `t-1`, trade at `t`.
- **Survivorship:** the universe MUST be drawn from PIT `sp500_history` (which retains
  delisted tickers — 1,194 ever-members vs ~503 current), per the project's
  `docs/teach/2026-05-09-survivorship-bias-and-delisted-tickers.md` (AFML §3.2 index-
  membership survivorship). **Known gap to flag:** delisted-name *price* coverage in
  `candles` is the binding risk — `yfinance_constituents` may under-cover names that left
  the index pre-2026 (the same coverage hole the survivorship teach-doc describes). The
  worker MUST measure delisted-name candle coverage before trusting any backtest; if
  coverage is current-membership-biased, the long-short result is optimistically biased
  and the verdict must be annotated `notes='survivorship-suspect'`.

### 3.5 IS/OOS, trial budget, multiple-testing honesty

- **70/30 fixed split** identical to ADR-051 §Decision 3: IS 2008→2020, OOS 2021→present
  (spans 2022 bear + 2024-26 expansion).
- **Trial budget (the M for HLZ):** v1 keeps it tiny on purpose — quintile cut is fixed at
  5, rebalance fixed monthly, weights fixed equal. The only legitimate "trials" are the
  phased dimension-inclusion sets (§4) and the macro on/off switch. M ≈ number of
  (dimension-set × {LS, beta-neutral-LO} × macro on/off) cells, deliberately kept < ~12.
  **Every cell counts toward M** — phasing does not let us hide trials from HLZ.

---

## 4. Build phasing (each phase ends at a validation gate)

> Principle: **validate the READY data FIRST**, before paying for the EDGAR ingest. If the
> fully-ready institutional-positioning signal can't clear the bar alone, that's a cheap,
> early, money-saving FAIL — and a strong prior that the fundamentals build won't rescue it.

| Phase | Dimensions in score | Data status | Deliverable | Gate |
|---|---|---|---|---|
| **P0 — scaffolding** | — | READY | Migration-free: a pure `applyEquityXsStrategy(scores, rebal, q)` harness mirroring ADR-051's `applyStrategyTemplate`; reuse `phase_b_*` tables (`composite_version='equity_xs_v1'`). PIT universe builder over `sp500_history`. Delisted-candle-coverage measurement (§3.4). | coverage report; harness unit-tested |
| **P1 — institutional-positioning-only** | S_inst | **READY** (no new ingest) | `score = S_inst`; run §3 full deflation on Q5−Q1 + beta-neutral LO. | **DSR/PBO/HLZ/Pardo verdict #1.** The cheapest, highest-prior-support signal. |
| **P2 — + technicals (momentum)** | S_inst, S_tech | **READY** | add 12-1 momentum sub-score; re-rank; re-validate (counts as new HLZ trial). | verdict #2 |
| **P3 — + fundamentals & valuation** | + S_value, S_quality | **FREE-NEW** (EDGAR `companyfacts` ingest — the one real build) | only if P1/P2 show signal worth extending; ingest `equity_fundamentals`, add value+quality sub-scores. | verdict #3 |
| **P4 — macro conditioning (optional switch)** | + S_macro on | READY | single on/off test of the sector×regime tilt. | verdict #4 |
| **UI (each phase)** | — | — | per ADR-044 UI-validation rule + the project's "UI surface every slice" memory: `/#/equity-xs` panel — universe coverage strip, Q5−Q1 equity curve, per-gate sparkline, and the single-name drill-in (the retained playbook scorecard as informational). | renders, honest empty states |

---

## 5. Honest feasibility verdict

**Can a free-data-only single-stock signal clear the DSR/PBO/HLZ bar the macro composites
failed?** Cautiously yes — *more plausibly than the macro composites*, for a specific
structural reason: the macro composites were **single time-series timing signals**, where
the only way to "win" was to time the index, and index-timing alpha is famously thin (their
DSR failures were the canonical result). This pipeline is **cross-sectional**, where the
academic evidence for real, deflation-surviving alpha is far stronger (momentum, value,
and insider-trading anomalies are among the most-replicated in the literature). The
long-short construction + beta-neutralization (§3.3) structurally strips the beta that
defeated the macro composites, so a pass here would actually *mean* alpha. **But** the bar
is genuinely high and the most likely outcome for any *single* dimension is still PARTIAL/
FAIL — the realistic hope is that **2–3 individually-faint, low-correlation cross-sectional
edges combined** clear a bar none clears alone (the meta-labeling path, AFML §3, that the
verdict teach-doc names as the legitimate next move after a wall of "partial").

**Strongest sub-hypothesis to build & validate FIRST:** **cross-sectional insider open-
market cluster-buying** (`S_inst` from `insider_trades` P-code clusters). It is (a) the
*only* dimension whose data is 100% ready (822k rows, clean PIT `accepted_at`), and (b) the
one with the deepest academic support — the insider-trading return-predictability literature
(Lakonishok & Lee 2001 *RFS*; Jeng-Metrick-Zeckhauser 2003 *REStat*; Cohen-Malloy-Pomorski
2012 "Decoding Inside Information" *J. Finance* on *routine-vs-opportunistic* insiders) is
substantial and specifically cross-sectional. **Honesty caveat:** I'm recalling these by
title/venue from memory and have NOT re-verified them in this session — the worker MUST
confirm each before citing in committed code/ADRs (per the project's forbidden-citations
rule); if a citation can't be verified, describe the result and drop the cite.

**Most likely to fail / where I'd bet against:** **S_value and S_quality** (the expensive
EDGAR build). Cross-sectional value has been a well-documented *drawdown decade* (2010s–
early 2020s) and would likely fail or go PARTIAL on the 2008–2026 window; quality is largely
a low-beta repackaging that beta-neutralization (§3.3) will strip. This is precisely why
phasing puts them LAST (P3) — **do not pay for the fundamentals ingest until P1/P2 prove
there's a cross-sectional edge worth extending.**

---

## 6. Items needing orchestrator / operator decision

1. **EDGAR `companyfacts` ingest scope (FREE-NEW, P3).** Free + unauthenticated + clearly
   within the data-source policy (SEC EDGAR is pre-authorized), but it's the only material
   build cost (new table + ~500-CIK backfill, ~10 rps throttle, multi-hour). **Orchestrator
   call** whether to greenlight P3 *only after* P1/P2 verdicts — recommended to defer.
2. **Per-name options sentiment is BLOCKED.** Confirm the design decision to **drop** it
   from v1 (the alternative — paid Barchart/MarketChameleon or Fidelity-auth scraping — is
   operator-gated/blocked and not recommended). Index P/C stays macro-only.
3. **Delisted-name price coverage (§3.4).** If the worker's P0 coverage measurement shows
   `candles` is current-membership-biased, the honest path is to annotate every verdict
   `survivorship-suspect` and/or source delisted-name daily bars (yfinance often lacks them
   for acquired/bankrupt names — may itself be a free-data wall). Flagging as a known risk,
   not a blocker.
4. **`cusip_ticker_map` is EMPTY (0 rows).** `short_interest` is keyed by `cusip` + `symbol`;
   the symbol field is usable directly, so this isn't blocking, but if a CUSIP-only join is
   ever needed the map must be populated. Informational.
5. **No methodology threshold is relaxed.** This spec reuses ADR-051's gates verbatim. If a
   future phase ever proposes loosening DSR/PBO/HLZ to manufacture a pass, that escalates to
   operator per orchestration §7.1.5 (anti-shopping). Stated here so it's on record.

---

## 7. What this spec does NOT decide

- The exact `equity_fundamentals` table DDL (deferred to the P3 SPEC if greenlit).
- ETF / leveraged / bond branching from `01-what-is-it.md` (v1 is common-stock-only).
- Learned dimension weights / meta-labeling combination (AFML §3) — explicitly a v2 move
  *after* v1 establishes which individual dimensions carry any edge; weights fit on the
  validation data would be selection bias.
- Multi-factor (FF) beta-neutralization — v1 is single-factor CAPM-style; FF is v2.
- Trading-cost model — Phase B is signal-quality, not execution (per ADR-051 §"does NOT decide").
