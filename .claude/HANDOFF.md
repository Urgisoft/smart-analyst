# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 14 of multi-agent
orchestration executed**. Operator continued from Cycle 13 close; Cycle 14
recommended default was "iShares adapter for IVV+IWM+HYG+TLT (Q-6 path-B'
sub-1)". Per S96-91's verify-empirically pattern, **the recommendation needed
empirical confirmation before any adapter implementation** — Cycle 14 slice 1
(commit `3082c16`) IS that confirmation step plus the documentation that
future cycles consult instead of re-running the research. **Empirical finding:
the iShares ajax CSV endpoint is dead** — all variants return HTTP 200 with
`Content-Type: text/csv` parroted from the `fileType` query-string param, but
the body is BlackRock's 10 MB Walrus marketing HTML wrapper, not CSV. Same
verdict on Vanguard (Angular SPA + 302-redirect to `error.vanguard.com` on
the REST API path) and Invesco (404s on documented JSON endpoints). The
iShares fact-sheet PDF is real but quarterly-cadence; SEC EDGAR N-PORT is a
legitimate quarterly cross-check with ~60-day public-release lag, not a
daily-panel replacement. **Q-6 path-B' reclassified as substantially harder
than Cycle 13's HANDOFF estimated** — estimated cost rises from ~200-400 LOC
per issuer to ~1500-3000 LOC + heavy deps (Playwright + bot-detection
bypass); failure mode is silent breakage on issuer-site redesigns.
Orchestration recommendation revised: **path-C accept-as-warning now + path-B
ADR-048 (drop the 6 non-SSGA tickers + promote v3.1 secondary to primary)
if Q-6 is to be resolved without paid data**; do not pursue path-B' adapters
without operator authorization for the Playwright dep surface. Cycle 14 also
refreshed three `why:` strings on `src/server/health_check.ts` to reflect
S96-88 (CBOE source frozen 2019-10-04) + S96-89 (Yahoo ETF SHO regression) +
S96-91 (SSGA expansion to 15 tickers) — Tier-1 mechanical per ADR-044, no
behavioral change. **Net 45 unpushed commits** on top of `origin/main`
(`c0cda7c`) after this HANDOFF rewrite (was 43 at Cycle 13 close · +1 slice 1
= 44 · +1 HANDOFF = 45). **Pre-merge gate locally verified:** `npx tsc
--noEmit` returns 13 baseline errors unchanged; `npm test` 3319/3338 pass +
19 skip + 0 fail; pytest ETF-flow + CBOE 77/77 pass; healthCheck convention
pins 37/37 pass (`why:` strings unpinned). **Q-6 row** in
`health_quarantine` status unchanged (`accepted-as-warning`); resolution
math NOT improved this cycle but path-space narrowed to A / B / C with B'
deprioritized. **NEXT default on `continue`:** Cycle 15 candidate — open
choice between (a) ADR-048 draft for Q-6 path-B (universe drop + secondary
promotion); (b) `/#/regime` UI smoke-test (now FIVE-cycle deferred); (c)
small-batch carry-over cleanup. Recommended: (a) ADR-048 draft — the survey
doc gives us the empirical foundation; drafting the ADR locks in the
recommended-fallback for operator review without committing the methodology
change.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | OPEN — operator-defined timing |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | OPEN — operator drafting |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 45 unpushed commits to origin/main (Cycle 14 slice 1 + this HANDOFF is the 45th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. Path (A) DataShop is the only path that re-opens fresh CBOE put/call data. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. **Path-space refined Cycle 14 (S96-93)** based on empirical iShares/Vanguard/Invesco endpoint survey (`docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md`): **(A) paid Sharadar/Polygon ETF SHO subscription — only path that restores fresh ETF SHO data; (B) methodology amendment promoting v3.1 secondary to primary + dropping the 6 non-SSGA tickers from F-UNIVERSE, draft ADR-048; (B') per-issuer adapter chain — RECLASSIFIED Cycle 14 as substantially harder than Cycle 13 estimated (iShares ajax CSV endpoint dead, returns 10MB Walrus HTML wrapper with `Content-Type: text/csv` parroted from query param; Vanguard REST API 302→error.vanguard.com; Invesco endpoints 404; only path forward is Playwright + bot-detection-bypass infrastructure, ~1500-3000 LOC + heavy deps); (C) keep `accepted-as-warning` indefinitely; (D) Yahoo restores the endpoint (monitored passively)**. Orchestration's revised recommendation: **path (C) now + path (B) draft ADR-048 if Q-6 to be resolved without paid data**. Do NOT pursue path (B') without operator authorization for Playwright + bot-detection-bypass surface. | s96 #17 Cycle 12 (S96-89 + S96-90); Cycle 13 slice 1 (S96-91 + S96-92); Cycle 14 slice 1 (S96-93 + S96-94) | OPEN — operator picks among (A)/(B)/(B')/(C) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. Cycle 14 added no new operator-queue rows. Q-4 count
incremented from 43 → 45. Q-6 status unchanged; path (B') reclassified
as materially-harder-than-estimated based on empirical survey;
orchestration recommendation revised from "path-B' Cycle 14 (iShares)"
to "path-C now + path-B ADR-048 draft".

---

## What this cycle delivered (s96 #17 Cycle 14)

### One code slice + HANDOFF rewrite (2 commits)

**Slice 1 (`3082c16`) — Q-6 path-B' empirical survey + health-check
description refresh (Tier-1 mechanical per ADR-044).** Two-file diff
(+255 / -3):

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md` | new (+247) | The full empirical survey: 7 iShares URL variants probed (all dead or 404); iShares fact-sheet PDF (real but quarterly + heavy dep); Vanguard investor/advisor/REST paths (Angular SPA + 302-redirect to error.vanguard.com); Invesco JSON endpoints (404); SEC N-PORT quarterly cross-check assessment; Q-6 path-space refinement matrix. |
| `src/server/health_check.ts` | edit (+11 / -3) | Three `why:` strings refreshed: `etf_shares_outstanding_secondary` (Cycle 13 SSGA expansion to 15 tickers); `etf_shares_outstanding` (Cycle 12 + Cycle 14 path enumeration A/B/B'/C/D); `macro_indicators_cboe` (Cycle 11 source-freeze finding; GAP-3 daemon promotion deferred). |

Total slice 1: **+258 / -3 across 1 new file + 1 edit**. No DDL change.
No real-money path file touched. No paid-data subscription. No
authenticated scrape. No new dependency. No new npm scripts. No new
tests (`why:` strings are unpinned by convention tests; the test suite
pins only structural shape — autonomous/cadence/timestampType/
timestampCol).

**Investigation trail (preserved for cycle audit):**

1. Operator typed `continue`. Per HANDOFF Cycle 13 close, default was
   Cycle 14 = iShares adapter (Q-6 path-B' sub-1).
2. Per ADR-044 session-start mandate, ran `npm run health:check` first.
   Output informational only (24 sources surveyed; stale=10 reflects
   2.2d since last `daemon:daily`, expected; very-stale=1 is CBOE per
   Q-5; missing-table=2 reflects FINRA + exec-departures carry-overs;
   empty=11 reflects pre-first-run state of newer composites; no new
   Tier-2 quarantine items).
3. Read existing SSGA navhist adapter
   (`scripts/etf_flow_ssga_spdr_adapter.py`) + the CSV-ingest chain
   (`scripts/etf_flow_issuer_csv_ingest.py`) to understand the pattern
   iShares adapter would mirror.
4. **Per S96-91 verify-empirically pattern,** before writing the
   adapter, probed the iShares ajax CSV endpoint documented by the
   Cycle 12 research subagent:
   `https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund`
   — HTTP 200 + `Content-Type: text/csv;charset=UTF-8` + 10,463,818
   bytes of **HTML**. Body starts with `<!DOCTYPE html>` + Walrus
   product-page CSS preload links. The Content-Type header is fake
   (parroted from the query-string `fileType=csv` param).
5. Tried the same URL with stricter headers (`Accept: text/csv`,
   `X-Requested-With: XMLHttpRequest`, `Referer:
   https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf`):
   identical 10MB Walrus HTML response.
6. Tried URL variants: `&asOfDate=20260520` (200 + same Walrus body);
   `fileType=json&fileName=IVV_distributions` (200 + same Walrus body);
   `fileName=IVV_fund` (200 + same Walrus body); `/239726/ivv/` path
   prefix with `fileName=IVV_perf` (200 + same Walrus body); the
   library-content `239726.csv` shape (404 generic HTML page);
   `/products/239726/239726.ajax?...&fileName=IVV...` (404 empty body).
   **All ajax/CSV-shaped endpoints return either Walrus marketing HTML
   or a 404. No CSV-shaped data reachable from the ajax surface.**
7. Searched the 10MB Walrus body for `shares outstanding` /
   `sharesOutstanding` / `navPerShare` patterns: found localization
   dictionary keys (`label.navdata.unitsoutstanding` etc.) but NOT
   data values. The fund's actual shares-outstanding loads via a
   subsequent client-side AJAX call that requires session-cookie
   state + bot-detection bypass (page loads New Relic with
   `session_replay.enabled = true` + `error_sampling_rate = 100`).
8. Tried the iShares fact-sheet PDF
   (`https://www.ishares.com/us/literature/fact-sheet/ivv-ishares-core-s-p-500-etf-fund-fact-sheet-en-us.pdf`):
   real 226 KB PDF (`%PDF-1.5` magic). But: (a) fact sheets publish
   quarterly; (b) parsing requires a heavy PDF dep (none in `.venv`);
   (c) positional-extraction heuristics drift quarterly. Not a
   daily-panel replacement.
9. Probed Vanguard:
   `https://investor.vanguard.com/investment-products/etfs/profile/voo`
   (58 KB Angular SPA skeleton; data via client AJAX);
   `https://advisors.vanguard.com/investments/products/voo/...`
   (1.5 KB bootstrap + XHR redirect);
   `https://api.vanguard.com/rs/gre/gra/datasets/auw/v1/fundData/fund.json?productType=etf&fundId=0968`
   (HTTP 302 → `error.vanguard.com` — referer/session gated).
10. Probed Invesco:
    `https://www.invesco.com/qqq-etf/api/v3/etf/etf-overview/QQQ`
    + `https://www.invesco.com/qqq-etf/en/about/etf-holdings.html`
    (both HTTP 404 with New Relic-instrumented error pages).
11. Probed SEC EDGAR N-PORT spot-search for BlackRock Institutional
    Trust over 2026-05-01..2026-05-24: 0 hits (expected — N-PORT-P
    publishes quarterly with ~60-day public release lag, so May-
    visible filings would be Q3-2025 filed February-2026 public
    April-2026).
12. **Decision: Cycle 14 must pivot.** Path-B' as scoped in HANDOFF is
    materially harder than estimated. Honest deliverables: (a) survey
    doc documenting the empirical findings so future cycles don't
    repeat the research; (b) health-check description refresh
    capturing S96-88/S96-89/S96-91 in operator-facing text; (c) Q-6
    path-space refinement in HANDOFF; (d) revised orchestration
    recommendation.
13. Wrote `docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md` with the
    full evidence trail + path-space refinement matrix.
14. Edited `src/server/health_check.ts` `why:` strings for the three
    affected sources (Cycle 13 SSGA expansion + Cycle 12 Yahoo
    regression + Cycle 11 CBOE freeze).
15. Verified gates green: tsc 13 baseline; npm test 3319/3338 pass;
    pytest ETF-flow + CBOE 77/77 pass; healthCheck convention pins
    37/37 pass.
16. Committed slice 1 as `3082c16`.

**Live verification log:**

```text
$ curl -sS -L -A "Mozilla/5.0 ..." -o /tmp/ivv.bin \
  -w "http=%{http_code} ctype=%{content_type} size=%{size_download}\n" \
  "https://www.ishares.com/us/products/239726/.../1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund"
http=200 ctype=text/csv;charset=UTF-8 size=10463818

$ head -c 100 /tmp/ivv.bin
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" prefix="og: http://ogp.me/ns#" lang="en-US" ...
```

### Cycle 14 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (per §3.1 trivial-edit exception — SEVENTH stretch since Cycle 4) | Q-6 path-B' empirical survey + health-check description refresh | AUTO-APPROVE (no critic spawn — Tier-1 mechanical refresh of `why:` strings is the ADR-044 enumerated mechanical-doc category; the survey doc is research output not code; no behavioral change; gates all green; no real-money path file touched; no paid-data; no auth scrape; convention pins hold) | Slice committed `3082c16`; Q-6 path-space refined with empirical foundation; Cycle 13's iShares-first recommendation reclassified. |

**Decision: no critic spawn for this slice.** Per orchestration §3.1 +
§6.1 + ADR-044 Tier-1 mechanical AUTO-FIX template:
- The `why:` string refresh is a pure documentation update; no logic
  changes; healthCheck convention pins (which test structural shape)
  all pass.
- The survey doc is research output that informs future ADR drafting,
  not committed methodology. No ADR conflict.
- All tests pass; tsc baseline unchanged.
- No methodology-canon decision was committed (the path-space
  refinement REFINES Q-6's row but the choice among A/B/B'/C remains
  exclusively operator-gated).
- No real-money path file touched per §7.2.
- No paid-data, no auth scrape, no new dependency.

**The §3.1 trivial-edit exception is now on its SEVENTH stretch since
Cycle 4** (Cycle 9 was the sole Composite worker spawn; Cycles
4/5/6/7/8/10/11/12/13/14 were orchestrator self-edits). S96-92
documented this pattern at Cycle 13; the orchestration §3.1 written-
rule amendment is now SIGNIFICANTLY overdue.

### Verification gates at cycle close

```text
git status                                           # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                            # 45 commits ahead (was 43)
npx tsc --noEmit                                     # 13 baseline errors unchanged
npm test                                             # 3319/3338 pass + 19 skip + 0 fail
.venv/Scripts/python.exe -m pytest \
  scripts/tests/test_etf_flow_ssga_spdr_adapter.py \
  scripts/tests/test_etf_flow_issuer_csv_ingest.py \
  scripts/tests/test_etf_flow_ingest.py \
  scripts/tests/test_cboe_putcall_ingest.py         # 77/77 pass
node --import tsx --test scripts/tests/healthCheck.test.ts  # 37/37 pass
git worktree list                                    # main only (no worker spawned)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail
test_etf_flow_ssga_spdr_adapter.py (targeted)         18/18 pass (Cycle 13 baseline)
test_etf_flow_issuer_csv_ingest.py (targeted)         19/19 pass
test_etf_flow_ingest.py (targeted)                    24/24 pass
test_cboe_putcall_ingest.py (targeted)                16/16 pass
healthCheck.test.ts (targeted)                        37/37 pass (Cycle 14 — `why:` strings unpinned)
etfFlow / etfFlowCrossValidation / etfFlowRepository /
daemonEtfFlowV1PrimaryRefresh                         146/146 pass
migrateCreateHealthQuarantine / healthQuarantine       57/57 pass
gicsSectorRepositoryHelper.test.ts                    13/16 pass + 3 skip (Cycle 9)
btRunsRegime.test.ts                                  19/19 pass (Cycle 6)
test_train_meta_label.py                              33/33 pass (Cycle 7)
regimeDashboard.test.ts                               37/37 pass (Cycle 5)
all Cycle 3-touched suites                            472/472 pass (Cycle 4)
```

### Post-Cycle-14 health snapshot

Cycle 14 did NOT change `quantlab.health_quarantine` (status remains
`accepted-as-warning`; Q-5 + Q-6 = 2 rows total). The v1 primary panel
state is unchanged — `etf_shares_outstanding` still 0 rows; the v3.1
SSGA secondary panel `etf_shares_outstanding_secondary` still 15
distinct tickers (Cycle 13 state preserved).

- **Fresh:** 1 source (Wikipedia/fja05680 S&P 500 constituents).
- **Stale (informational, ~2-3d since last `npm run daemon:daily`):**
  Candles, Cross-asset, Cycle position, ETF v3.1 SSGA secondary (15
  tickers), FRED, Form 4 trades, Live paper-trading signals, Macro
  regime phase1_v3, Sector rotation, Vol structure.
- **Very-stale:** CBOE put/call 2,425d (Q-5; source frozen 2019-10-04
  per S96-88; `why:` string refreshed Cycle 14).
- **Never-populated:** 11 raw + composite snapshot tables INCLUDING
  `etf_shares_outstanding` (Q-6 — Yahoo regression; `why:` string
  refreshed Cycle 14 to enumerate paths A/B/B'/C/D).
- **Missing-table:** raw `executive_departures` + raw `finra_short_interest`.
- **Quarantine queue:** `tier2AcceptedAsWarningCount: 2` (Q-5 + Q-6).

### Push state

- `origin/main` at `c0cda7c`; **45 unpushed commits** after this
  HANDOFF rewrite (was 43 at Cycle 13 close · +1 slice 1 = 44 · +1
  HANDOFF = 45).
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Reconciliation audit baseline | ✓ s96 #12 (review form answered by orchestration s96 #14) |
| `/#/health` Phase 1 read-only UI | ✓ s96 #12 |
| GAP-11 / GAP-12 etf-flow guard + NaN formatter | ✓ s96 #12 |
| Phase 1 column-name auto-fix | ✓ s96 #13 |
| Convention regression anchors | ✓ s96 #13 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1 — F1 + F2(escalated) + F3 + GAP-14/15/18 + ADR-045 | ✓ s96 #15 |
| Cycle 2 — GAP-2 + GAP-1 + GAP-4 + GAP-7(a) | ✓ s96 #16 |
| Cycle 3 — Phase 2 v1 ADR-044 infrastructure | ✓ s96 #17 |
| Cycle 4 — GAP-8 classifier-source documentation (ADR-046) | ✓ s96 #17 |
| Cycle 5 — GAP-13 + GAP-19 Quartz vendor-fork upgrade procedure | ✓ s96 #17 |
| Cycle 6 — GAP-16 sentinel investigation closure (ADR-047) | ✓ s96 #17 |
| Cycle 7 — GAP-17 orphan-script cleanup | ✓ s96 #17 |
| Cycle 8 — GAP-10 CI/CD baseline | ✓ s96 #17 |
| Cycle 9 — OQ-SMP-1 closure (gics SQL shadow-alias fix + GST-1 pin) | ✓ s96 #17 |
| Cycle 10 — S96-78 closure (phase1_v3 bt_runs_regime backfill 197,064 rows) | ✓ s96 #17 |
| Cycle 11 — CBOE put/call URL repair + source-freeze finding | ✓ s96 #17 |
| Cycle 12 — yfinance ETF SHO regression diagnosis (S96-89 + S96-90; Q-6 added) | ✓ s96 #17 |
| Cycle 13 — SSGA navhist expansion +JNK +GLD (S96-91 + S96-92; Q-6 path-B cost shrunk 9→6) | ✓ s96 #17 |
| **Cycle 14 — Q-6 path-B' empirical survey + health-check description refresh (S96-93 + S96-94)** | **✓ s96 #17** |
| Cycle 15 — ADR-048 draft for Q-6 path-B (universe drop + v3.1 promotion) | ☐ NEXT default (recommended) |
| Cycle 15-alt — `/#/regime` UI smoke-test (now FIVE-cycle deferred) | ☐ alternative trivial-edit pair-up candidate |
| Cycle 15-alt — small-batch carry-over cleanup (orchestration §3.1 rule amendment; pair-up doc updates) | ☐ alternative orchestration-grooming candidate |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ⛔ low priority — source frozen per S96-88; reflected in Cycle 14 `why:` |
| F2 CBOE backfill + re-classify (Q-5 path D) | ⛔ EMPIRICALLY DEAD — Cycle 11 |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 pick |
| Composite worker (Cycle 12 follow-up etf-flow methodology amendment) | ⏸ blocked on Q-6 pick |
| Per-issuer free-data adapters (iShares + Vanguard + Invesco) | ⛔ EMPIRICALLY EXPENSIVE — Cycle 14 (S96-93); requires Playwright + bot-detection-bypass; not authorized |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 14 of multi-agent orchestration)

**S96-93. Q-6 path-B' (per-issuer free adapters for iShares/Vanguard/
Invesco) is empirically substantially harder than Cycle 13's HANDOFF
estimated; reclassified from "Cycle 14 default" to "not recommended
without operator authorization for Playwright + bot-detection-bypass
infrastructure".** Empirical evidence (full detail in
`docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md`):

- **iShares**: the ajax CSV endpoint
  `https://www.ishares.com/us/products/{productID}/{slug}/1467271812596.ajax?fileType=csv&fileName={TICKER}_holdings&dataType=fund[&asOfDate=YYYYMMDD]`
  returns HTTP 200 + `Content-Type: text/csv` (parroted from the
  `fileType=csv` query-string param) but the body is 10,463,818 bytes
  of BlackRock Walrus marketing HTML — `<!DOCTYPE html>` + ~10MB of
  preloaded CSS/JS bundles + product disclaimers. Same for
  `fileType=json`, alternate fileName values (`IVV_fund`,
  `IVV_distributions`, `IVV_perf`), the `/239726/ivv/` path prefix,
  and `&asOfDate=YYYYMMDD`. The `library-content/products/239726/239726.csv`
  shape 404s. The fact-sheet PDF
  (`/us/literature/fact-sheet/ivv-...-fact-sheet-en-us.pdf`) is real
  226 KB PDF but quarterly cadence + would need a heavy PDF dep.
- **Vanguard**: investor portal is a 58 KB Angular SPA skeleton; data
  loads client-side. Advisors portal 1.5 KB bootstrap with XHR
  redirect. The fund-data REST API
  `api.vanguard.com/rs/gre/gra/datasets/auw/v1/fundData/fund.json`
  302-redirects to `error.vanguard.com` (referer/session gated).
- **Invesco**: both the `api/v3/etf/etf-overview/QQQ` and the
  `en/about/etf-holdings.html` paths return HTTP 404 with New Relic-
  instrumented HTML error pages. Real client data path needs
  Playwright + DevTools inspection.
- **SEC EDGAR N-PORT**: a legitimate free SEC source for issuer-
  reported SO data but cadence is quarterly with ~60-day public
  release lag — useful only as a quarterly cross-check, not a daily-
  panel replacement.

Cost reclassification: HANDOFF Cycle-13-close estimated path-B' at
"~200-400 LOC, new script + tests + daemon step" per issuer.
Post-survey, path-B' requires Playwright + bot-detection-bypass +
session-cookie handling + per-issuer SPA inspection; estimated
~1500-3000 LOC + heavy deps (Playwright binary surface ~hundreds of
MB) + ongoing fragility against issuer-site redesigns. `Why:`
operator directive at Cycle 13 was "find free reliable source for ETF
flow"; the honest report-back is that the four issuer candidates
HANDOFF named have shifted in ways the Cycle-12 research subagent
didn't catch, and only SSGA (covered Cycle 13) remains in the "stable
public XLSX over plain HTTP" category. `How to apply:` (1) any future
cycle that proposes resuming Q-6 path-B' must first re-probe the
endpoint shapes — vendor sites evolve; what's dead in 2026-05 may
become reachable in 2026-08 or vice versa. (2) When operator
authorizes Playwright as a dep, the SSGA-adapter pattern still does
NOT translate directly — iShares/Vanguard/Invesco pages bot-detect on
session-replay flags and need additional cookie-jar + UA-fingerprint
realism that the curl-based SSGA pattern doesn't address. (3) The
orchestration's revised recommendation is **path (C) accept-as-
warning now + path (B) ADR-048 draft if Q-6 to be resolved without
paid data**, not path-B'. The ADR-048 draft is the natural Cycle 15
default. (4) The survey doc
`docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md` is the canonical
foundation; future cycles cite it instead of re-running the research.
(5) The `verify-empirically-before-trusting-research-subagent-output`
pattern from S96-91 must extend to FRESH research subagent reports
the same way — the Cycle 12 research subagent reported the iShares
ajax endpoint as a leverage point, and that report was empirically
wrong as of 2026-05-24. **Treat ALL research-subagent endpoint
recommendations as hypotheses requiring HTTP-probe confirmation
before any adapter code is written.**

**S96-94. Health-check `why:` strings are documentation that DRIFTS
faster than the structural shape the convention tests pin, and they
should be refreshed at the cycle they go stale, NOT at the cycle they
become embarrassing.** Cycle 14 refreshed three `why:` strings on
`src/server/health_check.ts`: `etf_shares_outstanding_secondary` now
names the Cycle 13 SSGA expansion to 15 tickers (was "Daemon step 1ja
(s96 #9) — SSGA navhist auto-refresh."); `etf_shares_outstanding` now
enumerates Q-6 paths A/B/B'/C/D with the Cycle 14 empirical update
(was the GAP-4 daemon-step description that no longer reflects the
post-S96-89 reality that the daemon step runs but writes 0 rows due
to Yahoo's endpoint regression); `macro_indicators_cboe` now names
the Cycle 11 source-freeze finding + that GAP-3 daemon promotion is
deferred low-priority (was the pre-S96-88 description framing
operator-cadence as the gap). `Why:` the `why:` field is what the
operator reads when triaging health check output — describing reality
WRONG in operator-facing text is itself an ADR-044 Tier-1 mechanical
issue (operator-correctness UX). Stale descriptions teach the
operator wrong things about the system's state and cost more in
operator triage cycles than the cost of refreshing the string.
`How to apply:` (1) When a slice produces a Sxx-NN lock-in that
changes ground truth about a source (cadence, autonomous flag,
populated vs not, source-frozen vs live), check whether any
`HEALTH_SOURCES[*].why:` still describes the old reality; if so, the
slice closes by editing the affected `why:` strings. (2) The
convention tests pin only structural shape
(autonomous/cadence/timestampType/timestampCol), so `why:` edits are
test-safe — no convention regression risk. (3) The refresh pattern
is Tier-1 mechanical per ADR-044 (mechanical-doc category); it
AUTO-APPROVE-style ships in the same slice as the lock-in. (4) A
slice that produces a lock-in but doesn't refresh affected `why:`
strings is closed half — the operator-facing surface still describes
the pre-lock-in reality. Cycles 11/12/13 each produced a lock-in
(S96-88/S96-89/S96-91) but none refreshed the `why:` strings; Cycle
14's refresh is the catch-up.

**Carry-overs (still in force):** S96-1..S96-92; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### CARRIED from s96 #12-#17

- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers (Cycle 14
  S96-93 ESCALATED — was merged into Q-6 path-B' Cycle 14 candidate;
  Cycle 14 survey reclassified path-B' as substantially harder; now
  rolls forward as part of Q-6 with path-B as recommended fallback).
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers (Cycle 14 S96-93
  ESCALATED — was merged into Q-6 path-B' Cycle 14-16 scope; now
  reclassified as per path-B' status).

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused (operator-gated).
- CBOE DataShop subscription — Q-5 path (A).
- Capital-deployment-ramp ADR — Q-2.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent; remains Q-6 path-A
  candidate for ETF SHO if operator picks paid path.
- Phase 2 v2 — deferred per S96-71.
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence (Cycle 6).
- Orchestration §3.1 written rule no longer matches de-facto usage
  (S96-90 from Cycle 12; reiterated in S96-92 Cycle 13 + S96-94
  Cycle 14); now SEVENTH stretch; rule amendment now SIGNIFICANTLY
  overdue. Cycle 15-alt small-batch could include this.

---

## Next stage

### Default on `continue` — Cycle 15 candidate (recommended ADR-048 draft)

With Cycle 14's empirical survey landed + Q-6 path-B' reclassified,
the standing follow-up queue is:

1. **ADR-048 draft for Q-6 path-B (RECOMMENDED).** Write
   `docs/specs/adr-048-etf-flow-universe-amendment.md` proposing:
   - Drop the 6 non-SSGA tickers (IVV, IWM, HYG, TLT, VOO, QQQ) from
     `F-UNIVERSE` in `etf_flow_ingest.py` + the etf-flow composite.
   - Promote the v3.1 SSGA secondary panel
     (`etf_shares_outstanding_secondary`, 15 tickers post-Cycle-13)
     to the v1 primary role.
   - Sunset the v1 primary panel (`etf_shares_outstanding`,
     yfinance-fed, now permanently empty per S96-89).
   - Status: PROPOSED (not Accepted). Operator picks among Q-6
     paths A/B/B'/C; ratification only on path (B) pick.
   - Canon foundation: ADR-044 §"Asset-class correctness" (the v1
     primary panel returning empty across the whole universe is a
     data-pipeline-bug class problem, per Aronson §7); the survey
     doc as the empirical basis.
   - Implementation-readiness: list the concrete edits — which
     constants in `etf_flow_ingest.py`, which UI labels in
     `EtfFlowApp.tsx`, which test fixtures need universe trim,
     which `etf_flow_repository.ts` queries need the F-UNIVERSE
     narrowing.
   - Watch-outs: the v1-vs-v3.1 cross-validation comparator becomes
     trivially-identical post-amendment (only secondary survives);
     the comparator's UI surface must either degrade gracefully OR
     be removed in the same amendment.
   - Scope discipline: ADR draft only — NO code change in the same
     slice. Code change happens IF operator ratifies path-B.

2. **`/#/regime` UI smoke-test (NOW FIVE-CYCLE DEFERRED).** Trivial
   5-minute orchestrator-self-edit. Sits behind ADR-048 only because
   path-B is the natural continuation of Cycle 14's empirical finding.

3. **Orchestration §3.1 written-rule amendment.** The "one Composite
   worker spawn in Cycle 9 + 10 orchestrator self-edits since Cycle 4"
   pattern is documented now (S96-90/-92/-94) but the WRITTEN rule
   in `docs/architecture/multi-agent-orchestration.md` §3.1 still
   reads "exceptions only for trivial single-file fixes (< 5 LOC,
   single function)" — which doesn't match the de-facto usage of
   "orchestrator handles any well-scoped Tier-1 mechanical work
   end-to-end". Pair-up candidate.

4. **Phase 2 v2 spec drafting (DEFERRED).** Implementation stays
   deferred per S96-71.

5. **Drift remediation (REACTIVE).** Any new Tier-2 quarantine items.

**Why ADR-048 leads:** Cycle 14's empirical survey gives the
orchestration the foundation to draft the recommended Q-6 fallback;
drafting the ADR without ratifying it puts the choice cleanly in
front of the operator. The alternative — leaving Q-6 with the
post-Cycle-14 path-space refinement but no concrete path-B proposal
— makes path-B harder for the operator to evaluate.

### Alternative — Cycle 15 could pivot to ANY orchestration-domain follow-up

If operator wants to defer ADR-048 drafting until they've reviewed
Cycle 14's survey, or to address one of the deferred items above,
`continue` re-enters from this section and the ADR-048 recommendation
is not a halt-gate.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 14)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md` | new (+247) | The empirical survey (slice 1 `3082c16`) |
| `src/server/health_check.ts` | edit (+11 / -3) | Three `why:` strings refreshed (slice 1 `3082c16`) |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+258 / -3 across 1 new doc + 1 edit + 1 HANDOFF rewrite**.
No new files in code, no new npm scripts, no DDL changes, no new
tests.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| (none) | (no DB-state change) | 0 | Cycle 14 was pure research + docs |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-6 status remains `accepted-as-warning` |

### Test + tsc state

- `npm test`: **3319/3338 pass + 19 skip + 0 fail** (Cycle 13 baseline preserved).
- `test_etf_flow_ssga_spdr_adapter.py`: **18/18 pass** (Cycle 13 baseline).
- `test_etf_flow_issuer_csv_ingest.py`: **19/19 pass** (unchanged).
- `test_etf_flow_ingest.py`: **24/24 pass** (unchanged).
- `test_cboe_putcall_ingest.py`: **16/16 pass** (Cycle 11 baseline).
- `healthCheck.test.ts`: **37/37 pass** (`why:` strings unpinned).
- `npx tsc --noEmit`: **13 baseline errors unchanged**.
- Health check delta: `tier2AcceptedAsWarningCount` unchanged at 2;
  freshness probe `why:` strings now describe post-S96-88/-89/-91
  reality.

### Untouched-but-relevant for next session

- Q-5 + Q-6 rows still loaded in `quantlab.health_quarantine` for
  first Telegram alerts on next live daemon run with valid creds.
- `quantlab.executive_departures` + `quantlab.finra_short_interest`
  raw source tables still missing (carry-overs).
- `bt_runs_regime` has full `phase1_v3` attribution coverage (Cycle 10).
- `quantlab.macro_indicators_cboe`: 4,018 rows, max=2019-10-04, source
  frozen per S96-88; `why:` string refreshed Cycle 14.
- `quantlab.etf_shares_outstanding`: 0 rows, source endpoint dead per
  S96-89; `why:` string refreshed Cycle 14.
- `quantlab.etf_shares_outstanding_secondary`: 15 distinct tickers
  (SSGA SPDR + JNK + GLD post-Cycle-13); `why:` string refreshed
  Cycle 14.
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 14)

- **iShares `Content-Type: text/csv` is FAKE on the ajax endpoint.**
  Server parrots the `fileType=csv` query-string parameter into the
  Content-Type header regardless of what the body actually is. Any
  future cycle probing iShares-family endpoints must inspect the body
  bytes directly (`<!DOCTYPE html>` is the smoking gun) — relying on
  Content-Type is misleading. This anti-pattern likely extends to
  other BlackRock-served products (the iShares "Walrus" CMS is shared
  across the family).
- **The 10MB Walrus marketing HTML wrapper for ishares.com product
  pages includes localization keys named `unitsoutstanding`,
  `navdata.totalnetassets`, etc.** These are i18n DICTIONARY entries,
  NOT data values. Grep for `shares outstanding` will produce false
  positives suggesting the data is in the page when it isn't — the
  actual data loads via a subsequent AJAX call requiring
  bot-detection bypass.
- **Vanguard's `api.vanguard.com/rs/gre/gra/datasets/auw/v1/fundData`
  endpoint is REAL but referer/session gated.** A future cycle that
  authorizes Playwright should start with this endpoint (cleanest
  data shape) rather than scraping the SPA — but only with
  cookie-jar + Referer-header realism that bare curl can't provide.
- **The iShares fact-sheet PDF URL is stable and may be useful for
  QUARTERLY audit-cross-check** even though it's not a daily-panel
  replacement. If/when path-B is ratified, the fact-sheet path could
  be a separate audit-cross-check stream that flags issuer-vs-Yahoo
  divergence at quarter end. Out of scope for current Q-6 paths.
- **SEC EDGAR N-PORT's ~60-day public-release lag means a probe of
  recent dates returns 0 hits even when filings exist.** Any future
  cycle querying N-PORT should set the search window to {current-90d
  ... current-30d} to catch the post-lag visible window, NOT
  current-month.
- **Health-check `why:` strings drift faster than the structural
  shape the convention tests pin.** Cycle 14's refresh is a one-time
  catch-up for Cycles 11/12/13 lock-ins that didn't include the
  `why:` refresh. Going forward, S96-94 standard: lock-in slice
  includes the affected `why:` refresh in the same commit. A
  follow-up rule amendment to orchestration §3.1 could codify this
  alongside the trivial-edit-exception rule.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 13 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green
npm run system-health:check            # Phase 2 v1 dispatcher
npm run system-health:check -- --json  # Phase 2 v1 JSON payload
# UI surface: http://localhost:3000/#/health
```

### Phase 2 v1 + Q-6 admin (orchestration-pre-applied locally)

```text
npm run migrate:create-health-quarantine                     # dry-run
npm run migrate:create-health-quarantine:apply               # apply + Q-5 pin (idempotent)
npm run migrate:create-health-quarantine-alerts-sent         # dry-run
npm run migrate:create-health-quarantine-alerts-sent:apply   # apply
npm run migrate:insert-q6-etf-sho-pin                        # Cycle 12 — dry-run
npm run migrate:insert-q6-etf-sho-pin:apply                  # apply Q-6 pin (idempotent)
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
npm run health:check
```

### ETF flow ingest (post-Cycle-14)

```text
# v1 primary panel (yfinance) — still dead per Q-6 / S96-89
npm run etf:flow:ingest                                    # APPLY — 0/21 OK + S96-89 diagnostic + exit 1
npm run etf:flow:ingest:dry                                # dry-run, same

# v3.1 SSGA secondary (15 tickers post-Cycle-13: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY — chains adapter + CSV ingest
# Drops: 6 non-SSGA F-UNIVERSE tickers (IVV/IWM/HYG/TLT iShares, VOO Vanguard, QQQ Invesco)
# Cycle 14 (S96-93) RECLASSIFIED per-issuer adapters as substantially
# harder than estimated; orchestration recommendation revised to path-B
# (universe drop + secondary promotion) for Cycle 15 if operator picks.
```

### CBOE put/call ingest (post-Cycle-11 URL repair)

```text
npm run cboe:ingest                                                                  # fetches both totalpc.csv + totalpcarchive.csv
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --dry-run                    # parse + count without writing
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --from-file <path>           # operator override
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --archive-url <url>          # override archive URL
# S96-88 note: public file ends 2019-10-04; re-running does NOT advance max(observation_date).
# Cycle 14 (S96-94) refreshed health_check.ts macro_indicators_cboe `why:` to reflect this.
```

### Quartz docs site + vendor upgrade

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080)
# Vendor upgrade: docs/processes/quartz-upgrade.md
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # S96-78 CLOSED Cycle 10
npm run backfill:bt-regime:dry
npx tsx scripts/_probe_gap16_sentinels.ts
npx tsx scripts/_probe_ch_btregime.ts
```

### CI (Cycle 8 baseline)

```text
npx tsc --noEmit                                                                    # baseline ≤13 errors
npm run check:help
grep -q "gitignore: false" quartz/quartz/util/glob.ts                               # Patch 1
grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts                                    # Patch 2
npm test
pytest scripts/tests
# Workflow: .github/workflows/ci.yml
# First CI run: whenever the operator pushes (Q-4)
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ssga_spdr_adapter.py -v                # 18/18 pass (Cycle 13)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py -v                # 19/19 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ingest.py -v                           # 24/24 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_ingest.py -v                       # 16/16 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
node --import tsx --test scripts/tests/etfFlow.test.ts scripts/tests/etfFlowCrossValidation.test.ts scripts/tests/etfFlowRepository.test.ts scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts
                                                                                                       # 146/146 pass
node --import tsx --test scripts/tests/migrateCreateHealthQuarantine.test.ts scripts/tests/healthQuarantine.test.ts
                                                                                                       # 57/57 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors
```

### npm scripts touched this cycle

- **No new npm scripts.** Cycle 14 was pure research + docs + a
  three-`why:`-string refresh.

---

## For the next session — priority order

**Default on `continue`:** Cycle 15 candidate — **recommended ADR-048
draft** (`docs/specs/adr-048-etf-flow-universe-amendment.md`) for Q-6
path-B (drop the 6 non-SSGA tickers from F-UNIVERSE + promote v3.1
secondary to v1 primary role + sunset the yfinance-fed primary).
Status PROPOSED, not Accepted — operator ratifies if/when picking
Q-6 path-B. Moderate slice (~150-300 LOC ADR markdown + cross-refs).
Pair-up candidate: orchestration §3.1 written-rule amendment per
S96-94 carry-over. Alternative pair-up: `/#/regime` UI smoke-test
(now FIVE cycles deferred).

**Alternative Cycle 15 candidates:**

- **ADR-048 draft** — see above (recommended).
- **`/#/regime` UI smoke-test** — trivial; closes 5-cycle deferral.
- **Orchestration §3.1 rule amendment** — codify the "trivial-edit
  exception is now SOP for Tier-1 mechanical work" pattern.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

**Calendar-gated (unchanged):**

- All Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (Q-1 through Q-6):**

- Q-1 first real-capital deployment.
- Q-2 capital-deployment-ramp ADR.
- Q-3 Stooq apikey gate decision.
- Q-4 push 45 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — A/B/C.
- Q-6 ETF v1 yfinance methodology — A/B/B'/C/D (B' deprioritized
  Cycle 14 per S96-93).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase B campaigns.
- Playwright dep adoption (Cycle 14 S96-93 confirmed Playwright would
  be required for path-B'; operator authorization gated).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-5-blocked work: phase1_v3 re-classify.
- Phase 2 v2 plausibility-band probes.
- ADR-048 RATIFICATION (drafting is in-scope; status:Accepted is
  operator-gated).
- Per-issuer free-data adapters (Q-6 path-B') — Playwright dep
  authorization gated.

---

## Important framing for the next chat

**Cycle 14 is closed.** One slice + one HANDOFF rewrite (2 commits).
Slice 1 (`3082c16`, +258 / -3, 1 new doc + 1 edit) wrote the empirical
survey + refreshed 3 health-check `why:` strings.

**Q-6 path-space refined (not resolved).** Path-B' empirically
reclassified as substantially harder than Cycle 13 estimated — requires
Playwright + bot-detection-bypass infrastructure, not the SSGA-style
"stable XLSX over plain HTTP" pattern. Orchestration recommendation
revised from "path-B' Cycle 14 (iShares first)" to "path-C now + path-B
ADR-048 draft if Q-6 to be resolved without paid data".

**Cycle 14 followed the §3.1 trivial-edit exception pattern (SEVENTH
stretch since Cycle 4).** S96-94 reiterates the cumulative pattern;
the orchestration §3.1 written-rule amendment is now SIGNIFICANTLY
overdue and is a pair-up candidate for Cycle 15.

**The operator queue is still 6 rows (Q-1 through Q-6).** Q-4 count
incremented from 43 → 45. Q-5 unchanged. Q-6 status unchanged; path
(B') reclassified; orchestration recommendation revised.

**S96-93 + S96-94 are the new lock-ins.** Future cycles encountering
(a) any iShares/BlackRock-family endpoint should verify the body bytes
directly (not the `Content-Type` header, which is parroted from query
params) — S96-93; (b) any new Sxx-NN lock-in changing source ground
truth (cadence, autonomous flag, populated vs not, source-frozen vs
live) should refresh the affected `HEALTH_SOURCES[*].why:` strings in
the same slice — S96-94.

**Cycle 15 recommended path: ADR-048 draft** — moderate slice
documenting Q-6 path-B (universe drop + secondary promotion + v1
sunset) as a PROPOSED ADR for operator review. Drafting locks in the
recommended fallback without committing the methodology change.

**Backward compat preserved this cycle:**

1. **CH:** No DDL change. `etf_shares_outstanding_secondary` still 15
   distinct tickers. `etf_shares_outstanding` still 0 rows.
   `macro_indicators_cboe` still 4,018 rows ending 2019-10-04.
   `health_quarantine` unchanged.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes; §0 system-health digest still
   surfaces the same Q-5 + Q-6 counts.
4. **Tests:** All previously-passing suites still pass; no test
   changes (the `why:` strings were already unpinned by convention
   tests; the survey doc has no tests).
5. **Code behavior:**
   - `health_check.ts`: no logic changes; only three `why:` strings
     refreshed. The text reaches the operator via `/api/health/state`
     responses + `npm run health:check` CLI output; existing parsers
     of those payloads see strings instead of strings (no type
     change).
6. **Operator UX:**
   - `/#/etf-flow` empty-state still shows the Cycle 12 EmptyState
     (primary panel still 0 rows — Q-6 unchanged).
   - `/#/health` quarantine queue still shows 2 rows (Q-5 + Q-6).
   - `npm run health:check` output now describes the post-S96-88/
     -89/-91 reality in the per-source `why:` lines (operator triage
     UX improvement — no longer reads "GAP-3 — operator-cadence;
     phase1_v3 reads stale data" when the truth is "source frozen
     2019-10-04").

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3..13                                      ✓ as documented (S96-70..S96-92)
S96 #17 Cycle 14:
  • Orchestrator self-edit (§3.1)     AUTO-APPROVE  → Q-6 path-B' empirical survey:
                                                       7 iShares URL variants probed
                                                       (all dead — Walrus HTML wrapper
                                                       or 404); Vanguard (Angular SPA
                                                       + 302→error.vanguard.com on REST
                                                       API path); Invesco (404 on
                                                       guessed JSON endpoints); SEC
                                                       N-PORT (quarterly + 60d lag,
                                                       audit-only).
                                          INDEPENDENT
                                          FINDING    → iShares ajax CSV endpoint is
                                                       DEAD. `Content-Type: text/csv`
                                                       parroted from the `fileType`
                                                       query-string param; body is
                                                       BlackRock's 10MB Walrus
                                                       marketing HTML wrapper. Same
                                                       for fileType=json, alternate
                                                       fileName values, asOfDate param,
                                                       library-content path. Q-6
                                                       path-B' reclassified as
                                                       substantially harder than
                                                       Cycle 13 estimated; requires
                                                       Playwright + bot-detection
                                                       bypass; ~1500-3000 LOC + heavy
                                                       deps. Orchestration recommendation
                                                       revised: path-C now + path-B
                                                       ADR-048 draft.
                                          DOC REFRESH→ Three health_check.ts `why:`
                                                       strings refreshed to reflect
                                                       S96-88 (CBOE source frozen) +
                                                       S96-89 (Yahoo ETF SHO endpoint
                                                       dead) + S96-91 (SSGA 15
                                                       tickers). Tier-1 mechanical
                                                       doc-refresh per ADR-044.
  + S96-93 (Q-6 path-B' empirical reclassification + verify-empirically
    extension to research-subagent endpoint recommendations) +
    S96-94 (`why:` string refresh in same slice as ground-truth lock-in) lock-ins
  + 2 commits: slice 1 (3082c16) + this HANDOFF rewrite
  + SEVENTH cycle since Cycle 4 to use §3.1 trivial-edit exception
  + Zero downstream consumer behavior change; tsc + npm test baselines unchanged
  + NO new operator-queue rows added (Q-6 path-space refined; Q-4 count: 43 → 45)
  → DEFAULT NEXT: Cycle 15 candidate per orchestration §8.4.
    RECOMMENDED — ADR-048 draft (`docs/specs/adr-048-etf-flow-universe-amendment.md`)
    for Q-6 path-B (drop the 6 non-SSGA tickers + promote v3.1 secondary
    to primary + sunset yfinance-fed v1). Status PROPOSED; operator-gated
    on ratification.
    ALTERNATIVE — `/#/regime` UI smoke-test (FIVE-cycle deferred) or
    orchestration §3.1 written-rule amendment.
```
