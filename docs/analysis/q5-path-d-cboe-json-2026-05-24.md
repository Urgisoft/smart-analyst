# Q-5 Path D — free CBOE put/call source found

**Date:** 2026-05-24 (session 96 #19, Cycle 20 slice 2)
**Status:** RESEARCH complete; implementation candidate for Cycle 21+
**Authority:** Operator constraint 2026-05-24 ("Q-5 needs to have free reliable
data" — paid CBOE DataShop subscription rejected). Orchestration tasked with
finding a free, reliable, like-for-like replacement for the dead `totalpc.csv`
feed.
**Predecessor:** [ADR-045](../specs/adr-045-phase1-v3-cboe-putcall-input-window.md)
documents the 2019-10-04 source-freeze + the corrupted-input quarantine.

---

## TL;DR

**Path D exists and is robust.** CBOE publishes a **free, anonymous, daily
JSON endpoint** that:

- Has been live continuously since **2019-10-07** — the first trading day
  after the legacy CSV froze (zero overlap-conflict; backfill window is the
  exact gap behind Q-5).
- Returns the **TOTAL P/C ratio, EQUITY P/C, INDEX P/C, ETP P/C, plus raw
  call/put volume and open interest** for every trading day.
- Is **like-for-like** with the dead `totalpc.csv` feed — same scalar,
  same convention, same scale.
- Requires **no methodology amendment** to phase1_v3 or ADR-045.
- Per the SignalForge data-source policy, the endpoint is pre-authorized
  (anonymous CDN-served JSON; CBOE-direct; no API key; no auth).

**URL template:**

```
https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options
```

**Effort to ship:** ~400-500 LOC + 1 ADR. No new Python or TS dependencies.
~5 minutes wall-clock for the full 2019-10-07 → today backfill at 1 req/s
pacing (no rate-limit observed across 20 rapid sequential fetches).

**Recommendation:** Cycle 21 candidate — implement the new ingest in a
Data-Ingest + Infra worker pair, drop the Q-5 `accepted-as-warning`
quarantine row once the rolling-5d MA window has 5 fresh days post-source-
swap (~2019-10-11 onward in backfill terms; ~5 trading days from first
successful daemon run for forward classification).

---

## Per-candidate table

| # | Source | What it publishes | Reliability | Access | Fit | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **1 — WINNER** | **CBOE daily-options JSON** — `cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options` | TOTAL / INDEX / ETP / EQUITY / VIX / SPX+SPXW / per-product P/C ratios + raw call/put volume + open interest. One JSON file per trading day. | CBOE-direct (cdn.cboe.com). Live 2019-10-07 → today (verified across 2019-10-07, 2019-11, 2019-12, 2020, 2023, 2024, 2025, 2026-05-22 — all HTTP 200). 20 rapid sequential fetches succeeded with no throttle. Independent confirmation via the public `debegr92/cboe_pcr` crawler (2026-03-29). | Anonymous HTTPS GET; no key; no cookie; no rate limit observed; burstable; ~6KB per file. | Like-for-like. TOTAL P/C ratio matches the legacy `totalpc.csv` "P/C Ratio" semantic. Classifier's downstream rolling-5d MA consumes ratio scalars — same shape. Zero gap to the existing 2019-10-04 cutoff. | **Prototype this first.** |
| 2 | **OCC weekly volume** — `marketdata.theocc.com/weekly-volume-reports?…` | Weekly TOTAL puts + calls (sums equity + index reports). | OCC-direct (the clearinghouse upstream of CBOE). Used by `smileys21/CBOE-Options-Total-Put-Call-Ratio` Streamlit dashboard (2026-04-22). Decades of archive. | Anonymous HTTPS GET; CSV format. | Methodology mismatch — weekly cadence, not daily. Daemon today runs daily; switching to weekly would break the 5d MA window the classifier consumes. Could supplement, not replace. | **Skip unless candidate 1 fails.** |
| 3 | CBOE legacy CSVs (`totalpc.csv`, `equitypc.csv`, `indexpc.csv`) on the same CDN host. | TOTAL / EQUITY / INDEX P/C with raw call/put volume; covers 2006-11-01 → 2019-10-04 only. | CBOE-direct but FROZEN 2019-10-04 (re-verified live this session — all three CSVs are frozen at the same date). | Anonymous HTTPS CSV. | Dead for the post-2019 window. Already fully ingested per S96-88. | **Already exhausted.** |
| 4 | Yahoo Finance / yfinance | Yahoo does NOT publish a CBOE put/call symbol. `^CPC` is an internal SignalForge series_id, not a Yahoo symbol. `PCR` is a Simplify ETF, not a ratio. | n/a | n/a | Would require aggregating all option chains daily (~10K underlyings × dozens of expiries) — huge, brittle, and OCC weekly is strictly better if we ever need that route. | **Skip.** |
| 5 | Stooq `^cpc` | Symbol does not exist (302 → search page returned). | n/a | n/a | n/a | **Skip.** |
| 6 | FRED release 200 (CBOE Market Statistics) | 21 series including VIX, VXEEM, VXTYN; NO put/call ratio series surfaced in any search. | n/a | n/a | Not in scope — release contains volatility indices only. | **Skip — FRED doesn't host this.** |
| 7 | MacroMicro / YCharts / Barchart / Investing.com / AlphaQuery | Display CBOE P/C charts. | All third-party derivatives — quality depends on whether they still source from a live CBOE feed (most don't post-2019). AlphaQuery + YCharts + Barchart behind paywall for CSV download. | HTML scrape; some require login. | Authenticated → blocked by data-source policy. Even the free public chart-only pages are one extra hop from CBOE's own JSON. | **Skip — strictly worse than candidate 1.** |
| 8 | `debegr92/cboe_pcr` (GitHub, 2026-03-29) | Python crawler around candidate 1. Reference only, no hosted data. | — | — | Confirms candidate 1's endpoint is publicly known and works. | **Use as design reference, not a dependency.** |
| 9 | `smileys21/CBOE-Options-Total-Put-Call-Ratio` (GitHub, 2026-04-22) | Streamlit dashboard around OCC weekly. Reference only, no hosted data. | — | — | Confirms candidate 2 is a legitimate weekly fallback. | **Reference only.** |

---

## Recommended implementation shape (Cycle 21+)

1. **New ingest** — `scripts/cboe_putcall_json_ingest.py` (or extend
   `cboe_putcall_ingest.py` with a `--json` mode). Per-date fetch of the
   URL template above for every trading day in the 2019-10-07 → today
   window, with both a backfill mode + a daily-cadence mode for the daemon.
   Parse `data["ratios"]` for the entry where `name == "TOTAL PUT/CALL
   RATIO"`; write to `quantlab.macro_indicators_cboe` with
   `series_id="CPC"` (unchanged). The ReplacingMergeTree engine handles
   any future re-fetches idempotently.
2. **Daemon step 1b''** — finally fills the slot Cycle 2 had pencilled in
   for the dead CSV. GAP-3 resolves alongside Q-5.
3. **Schema validation per data-source policy** — require `data["ratios"]`
   to contain `{"name": "TOTAL PUT/CALL RATIO", "value":
   <str-parseable-float>}`; raise loud on absence; cache last-good
   per-date locally with explicit TTL (free since ReplacingMergeTree-
   versioned).
4. **Drop the Q-5 `accepted-as-warning` quarantine row** once the
   classifier produces non-corrupted-input output (~5 trading days after
   the backfill completes and forward daemon runs land fresh CBOE rows).
5. **Write ADR-050** — Path D resolution + ADR-045 amendment / supersession;
   document the source-swap; preserve ADR-045 on disk per the supersedes-
   not-deletes pattern from ADR-049.

---

## Effort estimate

| Item | Estimate |
| --- | --- |
| New ingest script (`cboe_putcall_json_ingest.py` or `--json` mode on existing) | ~150-200 LOC |
| Schema-validation block + parse-failure alert | ~30 LOC |
| Backfill driver: trading-calendar walk 2019-10-07 → today | ~40 LOC (use `pandas_market_calendars` already in `requirements.txt`, or `dt.weekday() < 5` + 403-handler for non-trading days) |
| Daemon step 1b'' wiring in `scripts/daily_signal_daemon.ts` | ~20 LOC TS, mirrors existing CBOE step shape |
| Unit tests (`scripts/tests/test_cboe_putcall_json_ingest.py`) | ~100 LOC — fixture-driven JSON-shape pin (catches CBOE renaming "TOTAL PUT/CALL RATIO" → something else) |
| ADR-050 documenting Path D resolution + retiring Q-5 quarantine row | ~80 lines |
| **Total** | **~400-500 LOC + 1 ADR**. **No new Python dependencies** (`requests` already present). **No new TypeScript dependencies**. |

**Scraping risk: very low.** The endpoint is a CDN-served static JSON file
(not a scraped HTML page); shape change risk exists but is detected loudly
by the schema pin. Fallback paths: legacy CSV resurrection (unlikely), OCC
weekly as candidate 2, manual `--from-file` already in script.

---

## Methodology concerns

**None for TOTAL P/C.** The legacy `totalpc.csv` file's `"P/C Ratio"` column
and the new JSON file's `data["ratios"]` entry `"TOTAL PUT/CALL RATIO"` are
the same CBOE-computed scalar. Spot-checks: 2026-05-22 = 0.85; 2020-01-02
= 0.83. Same convention, same scale, same semantic. The classifier's
`sentiment_extreme` category per ADR-045 / phase1_v3 SPEC §2.1 + §3 Turn B
consumes a 5d-MA of this scalar — identical input, no methodology
adjustment.

**Optional future upgrade (NOT required for the Q-5 fix):** the JSON
publishes EQUITY P/C separately. The canonical "smart-money vs dumb-money"
framing in the TA literature distinguishes equity-only P/C (retail-heavy)
from index P/C (institutional hedging). The current classifier uses TOTAL,
which conflates both. If the operator wants to refine `sentiment_extreme`
later, the JSON gives us EQUITY P/C at zero additional ingest cost. This
is a **future methodology question** for its own RESEARCH→DESIGN cycle —
not a blocker for the Q-5 fix.

**One implementation watch-out:** the legacy CSV used MM/DD/YYYY date format;
the JSON endpoint uses YYYY-MM-DD in the URL path, so the parser's
`_parse_cboe_date` doesn't need to round-trip a date string from the JSON
body. Storage continues using `series_id="CPC"` with `source="cboe"` (or
bump to `source="cboe_json"` if operator wants source-provenance segregation
— both work under the ReplacingMergeTree).

---

## Sources

- [CBOE Historical Options Data Download](https://www.cboe.com/us/options/market_statistics/historical_data/)
- [CBOE Daily Market Statistics](https://www.cboe.com/us/options/market_statistics/daily/)
- [cdn.cboe.com totalpc.csv (frozen 2019-10-04 — verified)](https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv)
- [debegr92/cboe_pcr — CBOE daily JSON endpoint reference (GitHub, 2026-03-29)](https://github.com/debegr92/cboe_pcr)
- [smileys21/CBOE-Options-Total-Put-Call-Ratio — OCC weekly fallback (GitHub, 2026-04-22)](https://github.com/smileys21/CBOE-Options-Total-Put-Call-Ratio)
- [FRED CBOE Market Statistics release 200](https://fred.stlouisfed.org/release?rid=200)

---

## What this finding changes in the operator queue

- **Q-5** narrows from `{A: paid DataShop, B: methodology amendment removing
  CBOE put/call, C: keep accepted-as-warning indefinitely}` to:
  - **Path D (NEW, RECOMMENDED)** — implement the CBOE JSON ingest. Free,
    reliable, like-for-like. Orchestration's call to ship in Cycle 21+
    (data-source policy pre-authorizes the source).
  - Paths B and C remain as fallbacks if Path D's prototype surfaces a
    blocker (none expected based on the research).
  - Path A stays dead per operator constraint.
- The operator queue Q-5 row updates to reflect Path D as the active
  resolution; no operator decision is required to ship Path D (orchestration
  owns ingest changes within the data-source policy).
