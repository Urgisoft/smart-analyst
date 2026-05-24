# Q-6 ETF SHO non-SSGA issuer endpoint survey — 2026-05-24

**Status:** Survey (not a ratified ADR). Empirical findings from session 96 #17
Cycle 14. Material input for any future ADR-048 (if/when operator picks Q-6
path B or B').
**Author:** Vector Core orchestrator (assistant).
**Date:** 2026-05-24.
**Trigger:** Cycle 14 default per HANDOFF (s96 #17 Cycle 13 close) recommended
"iShares adapter for IVV+IWM+HYG+TLT (Q-6 path-B' sub-1)". The recommendation
itself derived from a Cycle 12 research subagent's "report under 350 words"
that named the iShares ajax CSV endpoint as the leverage point. **Per S96-91's
verify-empirically pattern, that recommendation needed empirical confirmation
before any adapter implementation — this survey is that confirmation step.**

## Background

Q-6 was added to the operator queue at session 96 #17 Cycle 12 (S96-89 +
S96-90) when yfinance's `Ticker.get_shares_full` ETF endpoint regressed
(empty DataFrame returned for the full F-UNIVERSE). The v1 yfinance primary
panel (`etf_shares_outstanding`) stays empty; the v3.1 SSGA secondary panel
(`etf_shares_outstanding_secondary`) is the only populated SHO source.

Cycle 13 (S96-91 + S96-92) expanded the SSGA navhist adapter from 13 → 15
tickers (added JNK + GLD, both confirmed served by SSGA's CDN). That left
6 non-SSGA F-UNIVERSE tickers requiring alternative sources:

| Ticker | Fund | Issuer | Cycle-14-recommended path |
| --- | --- | --- | --- |
| IVV | iShares Core S&P 500 ETF | BlackRock / iShares | per-issuer adapter |
| IWM | iShares Russell 2000 ETF | BlackRock / iShares | per-issuer adapter |
| HYG | iShares iBoxx High Yield Corporate Bond ETF | BlackRock / iShares | per-issuer adapter |
| TLT | iShares 20+ Year Treasury Bond ETF | BlackRock / iShares | per-issuer adapter |
| VOO | Vanguard S&P 500 ETF | Vanguard | per-issuer adapter |
| QQQ | Invesco QQQ Trust Series 1 | Invesco | per-issuer adapter |

Q-6 path-B' (per-issuer free adapters) was the Cycle 14 recommendation
because it kept the F-UNIVERSE intact AND the path-(A) DataShop-equivalent
paid subscription would still need operator gate.

## What this survey tested

For each of the three remaining issuers, the orchestrator probed:

1. **Known historical CSV endpoints** documented in archived BlackRock /
   Vanguard / Invesco fund-data API docs + the Cycle 12 research-subagent
   report.
2. **Alternative ajax fileType variants** (`csv`, `json`, fund vs holdings
   vs distributions vs performance).
3. **PDF fact-sheet downloads** (where applicable).
4. **SEC EDGAR N-PORT filings** as a quarterly cross-check fallback.

All probes used a real-browser User-Agent (Chrome 126 on Windows 10), the
`Accept: text/csv,application/json,*/*;q=0.9` header, and the appropriate
`X-Requested-With: XMLHttpRequest` + `Referer` headers that mirror the
issuer site's first-party AJAX calls.

## Findings — iShares (IVV / IWM / HYG / TLT)

### iShares ajax CSV endpoint (the Cycle 12 recommendation): DEAD

The endpoint the research subagent named:

```
https://www.ishares.com/us/products/{productID}/{slug}/1467271812596.ajax
  ?fileType=csv&fileName={TICKER}_holdings&dataType=fund&asOfDate=YYYYMMDD
```

For IVV (productID 239726), this URL returns:

- HTTP **200** with `Content-Type: text/csv;charset=UTF-8`.
- Body: **10,463,818 bytes** of HTML. Specifically the BlackRock "Walrus"
  marketing wrapper for the product page — `<!DOCTYPE html>` followed by
  ~10MB of preloaded CSS/JS bundles + product disclaimers.

The `Content-Type: text/csv` header is **parroted from the `fileType=csv`
query-string parameter**, not derived from the actual response body. This
behavior is consistent across every variant tested:

| URL variant | HTTP | Content-Type (server-claimed) | Actual body |
| --- | --- | --- | --- |
| `fileType=csv&fileName=IVV_holdings&dataType=fund` | 200 | `text/csv` | Walrus HTML |
| Same + `&asOfDate=20260520` | 200 | `text/csv` | Walrus HTML |
| `fileType=json&fileName=IVV_distributions&dataType=fund` | 200 | `application/json` | Walrus HTML |
| `fileType=csv&fileName=IVV_fund&dataType=fund` | 200 | `text/csv` | Walrus HTML |
| `fileType=csv&fileName=IVV_perf&dataType=fund` (under `/239726/ivv/`) | 200 | `text/csv` | Walrus HTML |
| `library-content/products/239726/239726.csv` | 404 | `text/html` | Generic 404 HTML |
| `/products/239726/239726.ajax?fileType=csv&fileName=IVV&dataType=fund` | 404 | (empty) | (empty) |

**Conclusion:** the documented iShares ajax CSV/JSON endpoint has been
deprecated or sunset. Every URL variant returns either the Walrus marketing
HTML wrapper (with a misleading content-type header) or a 404. **No
CSV-shaped data is reachable from the ajax surface.**

### iShares fact-sheet PDF: REAL but cadence-unsuitable

```
https://www.ishares.com/us/literature/fact-sheet/{slug}-fund-fact-sheet-en-us.pdf
```

For IVV this returns a real **226 KB PDF** (`%PDF-1.5` magic + valid
content). The PDF likely includes a shares-outstanding figure as of the
report date, but:

1. **iShares fact sheets are published quarterly** (typical industry
   cadence; the URL has no `asOfDate` parameter).
2. **PDF parsing requires a heavy dep** (`pdfplumber` / `PyMuPDF`/ `pypdf`)
   — none currently in `.venv`. Adopting a PDF dep adds substantial
   surface area (positional-extraction heuristics; quarterly layout drift;
   font fallback handling).
3. **Quarterly cadence is not a replacement for the v1 daily SHO panel** —
   it would be a quarterly cross-check at best.

**Conclusion:** the fact-sheet PDF is the only iShares free public data
path that exposes shares-outstanding, but its cadence + extraction cost
preclude it as a daily-panel source.

### iShares "investor portal" SPA: requires Playwright

The `/us/products/239726/ishares-core-sp-500-etf` page itself is a
JavaScript-rendered SPA. The shares-outstanding figure is loaded
client-side via AJAX calls the browser makes after rendering. Capturing it
requires:

1. Playwright (browser binaries ~hundreds of MB).
2. Cookie handling for first-party session state.
3. Bot-detection bypass — the page loads New Relic with
   `session_replay.enabled = true` and `error_sampling_rate = 100`, which
   suggests active fingerprinting. Cycle-13's `etf_flow_ssga_spdr_adapter`
   pattern (stable XLSX over plain HTTP) does not apply here.

**Conclusion:** technically achievable but materially more expensive than
the SSGA pattern. Not recommended as a Q-6 path-B' adapter.

## Findings — Vanguard (VOO)

### Vanguard investor product page: Angular SPA

```
https://investor.vanguard.com/investment-products/etfs/profile/voo
```

Returns 58 KB of Angular SPA skeleton — `<doctype html>` + Angular
critters-container marker + a `<base href="/">`. All fund data loads
client-side.

### Vanguard advisors portal: redirect-protected

```
https://advisors.vanguard.com/investments/products/voo/vanguard-s-p-500-etf
```

Returns 1.5 KB of bootstrap HTML that fires a `launch-*.min.js` script
which redirects via XMLHttpRequest. Not parseable from a bare-curl client.

### Vanguard fund-data REST API: blocked

```
https://api.vanguard.com/rs/gre/gra/datasets/auw/v1/fundData/fund.json
  ?productType=etf&fundId=0968
```

Returns HTTP **302** redirect to `https://error.vanguard.com/...` — a
client-error landing page. The API exists but is gated by either
session-cookie auth or referer-validation (or both). Not a free public
endpoint.

**Conclusion:** Vanguard offers no free public REST endpoint for
shares-outstanding. All paths require Playwright + session-cookie handling.

## Findings — Invesco (QQQ)

```
https://www.invesco.com/qqq-etf/api/v3/etf/etf-overview/QQQ
https://www.invesco.com/qqq-etf/en/about/etf-holdings.html
```

Both return **HTTP 404** with New-Relic-instrumented HTML error pages
(109 KB of NREUM init + product chrome). The Cycle-12 research subagent's
endpoint guess was wrong; an empirical-DevTools discovery pass against
qqq.com would be needed to find the real client-side data path, with the
same Playwright/bot-detection cost as iShares/Vanguard.

**Conclusion:** Invesco does not expose a free public REST/CSV endpoint
for QQQ shares-outstanding from a URL we could discover without
Playwright-driven browser inspection.

## SEC EDGAR N-PORT as a quarterly fallback

A spot probe of EDGAR's full-text-search index for `"BlackRock Institutional Trust"
+ formType=NPORT-P` over 2026-05-01..2026-05-24 returned 0 hits. N-PORT-P
filings publish **quarterly with a ~60-day public release lag** — the
expected May 2026 visible window would be Q3-2025 filings (filed February
2026, public ~April 2026), not May 2026 dates.

N-PORT-P + N-PORT-NP filings DO include shares-outstanding for the filing
fund (a 1933-Act ETF reports its own SO on Form N-PORT Part B Item B.3).
But cadence is **quarterly** (filed within 60 days of each fiscal quarter
end, public ~60 days after that), making N-PORT useful only as:

1. **A quarterly audit cross-check** — confirm SSGA navhist + any future
   per-issuer adapters agree with the SEC-filed SO figure.
2. **Historical backfill** for periods where issuer-direct sources are
   unavailable.

**Conclusion:** N-PORT is a legitimate free SEC source for SHO data but
not a daily-panel replacement. It belongs in a separate cross-validation
layer if/when Q-6 is resolved.

## What this survey changes for Q-6 path-space

| Path | Pre-survey HANDOFF reading | Post-survey reading |
| --- | --- | --- |
| **A — Paid Sharadar/Polygon ETF SHO subscription** | Recommended only if operator authorizes paid path | Unchanged — only path that restores fresh daily data |
| **B — Drop the 6 non-SSGA tickers from F-UNIVERSE + promote v3.1 secondary to primary** | Methodology amendment; ADR-048 draft | **Now the orchestration's leading fallback** if operator does not authorize paid path |
| **B' — Per-issuer free adapters (iShares + Vanguard + Invesco)** | Sub-1 iShares = "biggest marginal value, ~200-400 LOC" | **Materially harder than HANDOFF estimated.** iShares ajax surface is dead; Vanguard + Invesco require Playwright + session-cookie + bot-detection bypass infrastructure. **Estimated cost: ~1500-3000 LOC plus heavy deps** (Playwright + N-PORT XML parsing); failure mode is silent breakage on issuer-site redesigns. Not recommended without explicit operator authorization for the dep surface |
| **C — Keep `accepted-as-warning` indefinitely** | Status quo | Unchanged — viable while operator deliberates |
| **D — Yahoo restores `Ticker.get_shares_full` for ETFs** | Monitored passively by daemon step 1jb anomaly | Unchanged — passive watch continues |

**Cycle-14 orchestration recommendation revision:** previously the
orchestration recommended **path-B' (Cycle 14 = iShares first)**. This
survey reclassifies path-B' as substantially harder than estimated. The
revised recommendation is:

> Path (C) `accepted-as-warning` for now + path (B) draft ADR-048 (drop
> the 6 non-SSGA tickers + promote v3.1 secondary to primary) if Q-6
> is to be resolved without paid data. **Do not pursue path-B' adapters
> without operator authorization** for the Playwright + bot-detection-
> bypass dep surface.

## Future cycles that depend on this survey

- **If operator picks path-A (paid):** survey is moot beyond the
  fact-sheet PDF + N-PORT audit-cross-check rows.
- **If operator picks path-B (universe drop):** survey informs the
  ADR-048 "why we're dropping" rationale + the SEC N-PORT audit-
  cross-check design.
- **If operator picks path-B' (per-issuer adapters anyway):** survey is
  the empirical foundation showing what infrastructure is required;
  starts with the Playwright dep adoption decision.

## Cross-references

- Q-6 row in `.claude/HANDOFF.md` operator queue
- ADR-044 (standing system-health mandate) — Q-6 quarantine row
- S96-89 + S96-90 (Cycle 12 lock-ins — Yahoo ETF SHO regression)
- S96-91 + S96-92 (Cycle 13 lock-ins — SSGA adapter expansion to 15
  tickers + verify-empirically pattern)
- `scripts/etf_flow_ssga_spdr_adapter.py` — the only working free SHO
  source for SSGA-managed F-UNIVERSE tickers
- `src/server/health_check.ts` — Cycle 14 updated the `etf_shares_outstanding`
  + `etf_shares_outstanding_secondary` + `macro_indicators_cboe` `why:`
  fields to reflect S96-88/-89/-91 findings
