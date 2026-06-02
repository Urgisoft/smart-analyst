# Handoff brief — Vector Core / SignalForge

Last updated: 2026-06-01 (session 96 #39 — **infra recovered + a UI/data-integrity
session**: Docker/ClickHouse back with ZERO data loss; fixed 2 real yfinance API-drift bugs
(options IV + the daemon's 0/61 fetch break); refreshed all stale data; audited all 18 dashboard
pages in-browser (**data is NOT missing** — the zeros are legit large-cap-rare-event patterns);
wired a free NAV-implied ETF shares source (Q-6 primary un-darked, 21 rows); added an honest
`expected-empty` health status + reclassified the vestigial CUSIP cache. Validation conclusion
(ADR-056 null) is UNCHANGED — no new composites, no live trading.**) On `continue`: optional
loose ends only (see "Next stage"). Nothing is mid-build.

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop
ClickHouse runs in container `quantlab-clickhouse`. **Docker recovered after the 2026-05/06
factory-reset scare — the named volume survived, ZERO data loss** (verified: 1.99 GiB, 52 tables,
58.86M rows; candles 43.4M, equity_daily_polygon 5.66M, short_interest 2.94M all intact). On reboot:
`docker start quantlab-clickhouse` → wait `docker inspect --format '{{.State.Health.Status}}'` =
healthy → verify `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
**Dev server:** `npm run dev` → http://localhost:3000 (NO hot-reload — restart after ANY server-side
.ts edit; frontend picked up on restart too). Currently RUNNING (task b7kpie7sw).
**Python:** use `.venv\Scripts\python.exe` (yfinance/pandas live there, NOT base python).

---

## Operator queue (real-money triggers only)
| # | Item | Status |
| --- | --- | --- |
| Q-1 | First real-capital deployment | **INDEFINITELY DEFERRED** — nothing passed validation |
| Q-2 | Capital-deployment-ramp ADR | **INDEFINITELY DEFERRED** |
| Q-4 | Push **~155** unpushed commits to origin/main | OPEN — `git push` operator-gated (5 new this session) |
| Q-6 | ETF v1 primary broken | **RESOLVED this session** — operator chose "wire a free source"; now populated via yfinance `.info` NAV-implied shares (independent of secondary). Cross-validation activates once primary(today)+secondary(Fri) dates align (~1 day). |
| Q-7 | phase1_v3 yield-curve source | OPEN |
| Q-8 | Phase C promotion | **DORMANT — nothing Phase-C-eligible (0/6 pass)** |
| Q-9 | Single-stock survivorship-free test | **RESOLVED-null** (ADR-056); paid deep-history revisit optional, recommended-against |

---

## THE finding (unchanged — read first)
**6 Layer-0 composites validated via Phase B; 0 pass; the alternative-data market-timing thesis is
null (ADR-056, operator-ratified).** All degenerate to beta (~long-the-index) and fail DSR/HLZ; the
deflation pipeline correctly rejects them. **The deliverable = the validated pipeline + the honest
null.** Do NOT build more aggregate composites, do NOT relax gates, do NOT go live. Validation phase
is CLOSED. We are in the **UI / decision-support phase** (per memory `project-phase-ordering`).

---

## What session #39 delivered
- **Infra**: Docker/CH recovered, no data loss (factory reset spared the volume).
- **Bug `63ce716` (options IV)**: pre/post-market, Yahoo returns `impliedVolatility≈1e-5` sentinel.
  `yfinance_options_summary.py` now SOLVES IV from price via BSM bisection inversion (`bs_price` +
  `implied_vol_from_price` + `repair_iv`/`repair_chain_iv`) when Yahoo's is implausible (<1% or
  >1000%); marks unsolvable-implausible as null (never propagates the sentinel). Filters dte≤0.
  Surfaces `iv_repaired` count + UI disclosure. +11 tests. Validated live: NVDA 45% term structure.
- **Bug `a203deb` (daemon fetch 0/61)**: yfinance now returns an UNNAMED DatetimeIndex, so
  `reset_index()` yields a column named `index` not `Date` → `df[["ts",...]]` raised KeyError →
  silent 0/61 fetch + stale candles/macro. Fixed in `fetch_daily_yfinance.py` +
  `macro_regime_ingest.py` (rename `df.columns[0]`→`ts`). `adapters/yf_source.py` already handled it.
  +regression test. Daemon now fetches 61/61.
- **Data refresh**: ran `daemon:daily --no-telegram` ×2 → candles current (2026-06-01), macro/FRED/
  CBOE/FINRA/EDGAR + all 9 composites recomputed today.
- **Full 18-page browser audit** (Claude-in-Chrome): **data is NOT missing.** Most pages fully
  populated; the 8-K / exec-departure zeros are LEGIT (large caps rarely file distress 8-Ks; the
  per-ticker drill is the 62-name watch universe while the cluster verdict is broad-universe — a UX
  mismatch, not missing data). regime/cross-asset/cycle/short-interest/form-4/phase-b/paper-trading
  all healthy. single-stock works via `?ticker=NVDA` deep-link + input (NOT `/NVDA` path).
- **ETF primary wired (Q-6)**: `etf_flow_ingest.fetch_current_shares` — NAV-implied shares
  (`totalAssets/navPrice`, preferred over the wrong-for-ETFs `sharesOutstanding`), independent of the
  secondary. 21/21 tickers populated, 0 AUM sanity warnings. +5 tests.
- **`expected-empty` health status**: new neutral status for by-design-empty tables. CUSIP cache
  reclassified (FINRA feed is ticker-native → no CUSIPs to map → vestigial). Threaded through
  health_check / summarize / UI badge+chip / operator_brief. tsc=13.

---

## Decisions locked in (session #39)
- **yfinance daily fetch normalizes the unnamed index** by renaming `df.columns[0]`→`ts` (vendor-
  drift-proof), NOT a hard-coded `Date` match. Same fix in both daily fetchers.
- **Options IV trust policy**: use Yahoo's `impliedVolatility` iff in [1%, 1000%]; else BSM-invert
  from mid (or lastPrice); else null (skip). Yields to live IV when valid (intraday).
- **ETF primary shares source = `totalAssets/navPrice`** (NAV-implied), fallback `sharesOutstanding`.
  Empirically Yahoo's `sharesOutstanding` is stale/wrong for ETFs (TLT 4.5× low). Snapshot ingest:
  one row/run at latest close date, no fabricated backfill; daemon appends daily.
- **`expected-empty` ≠ `never-populated`**: by-design-empty tables (vestigial/superseded) don't block
  `allGreen`, never the brief's worst-source, render grey "expected" not amber EMPTY.

---

## Open questions / loose ends (none blocking; surface, don't auto-build)
- **F1 weekend-stale false-positives**: FRED/CBOE/SSGA/macro_regimes show stale/very-stale on a
  Monday because they're EOD-published sources whose latest data is Friday — the freshness threshold
  isn't business-day-aware. Auto-clears after tonight's run. OFFERED a business-day-aware calibration;
  operator hasn't taken it. Low priority (cosmetic, self-healing).
- **ETF cross-validation = 0 pairs** until primary(today's date) and secondary(Friday) share a date
  (~1 day as both publish forward). If active cross-val is wanted sooner, change
  `etf_flow_cross_validation.ts` to latest-vs-latest per ticker (follow-up, not done).
- **OQ-C41-2 — 13D base-filing ingest**: schedule_13d_g captures only amendments + 13G (zero base SC
  13D) → the activist cluster signal is identically zero. Page is HONEST about it. Real ingest bug;
  OFFERED a fix; low value given the null. Not done.
- **OQ-C41-3 — eight_k pooled construct**: 8-K composite uses the ADR-053/054/055-invalid per-sector
  max form; needs the pooled rebuild (mirror form_4_v5). Not done; low value given the null.

---

## Next stage
### On `continue` — NOTHING is mid-build. Pick from optional loose ends, or await operator direction.
1. **Most likely operator-initiated**: live per-symbol decision-support — "analyze \<TICKER\>" via
   the single-stock panel (`/#/single-stock?ticker=NVDA`) + Bigdata.com MCP. Works now, free.
2. **Optional polish** (operator's call, all flagged above): F1 business-day staleness; ETF
   latest-vs-latest cross-val; 13D base-filing ingest; eight_k pooled rebuild.
3. **Do NOT**: build more aggregate composites; relax DSR/PBO/HLZ; go live; `git push` (Q-4).

---

## Files / code state
- **Commits this session (on `main`, unpushed — Q-4):** `63ce716` (options IV), `a203deb` (yfinance
  ts), + ETF NAV-implied source, + expected-empty/CUSIP. ~155 total unpushed.
- **Touched**: `scripts/yfinance_options_summary.py` (+IV-repair), `scripts/fetch_daily_yfinance.py` +
  `scripts/macro_regime_ingest.py` (ts-normalize), `scripts/etf_flow_ingest.py` (+fetch_current_shares),
  `src/server/health_check.ts` (+expected-empty), `src/components/health/HealthApp.tsx`,
  `src/server/operator_brief.ts`, `src/server/single_stock_dashboard.ts` (+ivRepaired),
  `src/components/singleStock/SingleStockApp.tsx`. Tests: `test_yfinance_options_summary.py` (+11),
  `test_yfinance_fetch_ts_normalization.py` (new), `test_etf_flow_ingest.py` (+5),
  `singleStockDashboard.test.ts`, daemon/system health test summary literals.
- **Gates**: tsc=13 (baseline). Python: options 37, etf 29, ts-norm 4 — all green. TS: health 293,
  single-stock 16 — green.
- **Key CH facts**: candles 43.4M (current 2026-06-01), equity_daily_polygon 5.66M,
  etf_shares_outstanding NOW 21 rows (was 0), cusip_ticker_map 0 (expected-empty by design),
  phase_b_verdicts 6 versions / 0 phase_c_eligible.
- **npm scripts**: `npm run dev` / `daemon:daily [-- --no-telegram]` / `etf:flow:ingest` /
  `health:check`. Tests: `node --import tsx --test scripts/tests/<x>.test.ts` (TS);
  `.venv\Scripts\python.exe -m pytest scripts/tests/<x>.py` (py).

---

## Watch-outs
- **NO hot-reload** — restart `npm run dev` after ANY `.ts` edit (server OR component).
- **Browser audit gotcha**: hash-only nav (`/#/a`→`/#/b`) leaves STALE DOM via Claude-in-Chrome —
  hit a path-buster (`/audit-reset`) first to force a clean SPA mount, then the `#/route`.
- **single-stock deep-link is `?ticker=NVDA`** (query), NOT `/NVDA` (path) — the path form renders
  landing. The chips + input + `?ticker=` all work.
- **Options IV is now intraday-live-aware**: pre-market shows price-solved IVs (with a disclosure),
  intraday shows Yahoo's live IVs. Different runs legitimately differ.
- **ETF primary shares = NAV-implied**, will differ from the secondary by source-lag/timing (~2-10%);
  that's healthy cross-validation, not a bug. `sharesOutstanding` is the WRONG field for ETFs.
- **Commit messages via `git commit -F -` heredoc in the Bash tool** (PowerShell here-strings +
  `-Encoding utf8NoBOM` fail in PS5.1; plain `utf8` adds a BOM to the commit subject).
- Carried: EDGAR/FINRA per-IP throttle; transient yfinance rate-limits can fail a worker (relaunch);
  worktree merges leave changes uncommitted; anti-shopping paramount (6 fails on the board).

---

## For the next session
Session #39 was infrastructure-recovery + data-integrity hardening, NOT new strategy work. Two real
yfinance API-drift bugs fixed (options IV sentinel; the silent 0/61 daemon fetch), all stale data
refreshed, every dashboard page audited in-browser (**data is intact — nothing missing**; apparent
zeros are legitimate large-cap-rare-event patterns), the ETF primary un-darked via a free NAV-implied
source, and the dashboard made honest about the one genuinely-vestigial table (CUSIP cache). The
ADR-056 null stands. On `continue`, there is no pending build — offer the optional loose ends above or
await operator direction (most likely: live per-symbol "analyze \<TICKER\>" decision-support). Do not
go live, do not relax gates, do not push.
