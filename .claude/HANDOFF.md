# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-27 (session 96 #23 — **Cycle 29 closed with the
5-month form 4 backfill landed (143,628 rows / 4,552 tickers / 32,823
insiders) + four EDGAR-resilience fixes (S96-135 .. S96-137) + the
`_backfill_form_4_insider_snapshots.ts` driver.** Cycle 29 was a
diagnostic-pivot-deeper cycle: pre-cycle EDGAR probes surfaced a
SECOND silent-truncation bug on top of S96-132's per-page cap (10K
hits-per-query cap — `relation=gte` past that). Shipping the fix
exposed THIRD + FOURTH resilience holes (sustained-burst 5xx, then
TimeoutError on SSL read uncaught) — each surfaced by an attempted
multi-month --apply that crashed mid-body-fetch. The fourth fix held;
the 5-month apply completed in ~9.5h wall-clock (EDGAR archives
endpoint runs ~300ms per HTTP call empirically — 3× slower than the
nominal 10 req/s ceiling). **Net 95 unpushed commits** on top of
`origin/main` (`c0cda7c`) after this HANDOFF (Slice 4) ships.
**NEXT default on `continue`:** Cycle 30 — wire `gics_sector_map`
ingest + sp500 PIT history depth, then run the snapshot daemon-replay
backfill driver (already shipped, currently blocked on those two
tables).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

**Standing constraint (2026-05-24, s96 #19):** Operator stated "We will
not be trading real money while the system is incomplete and other
segments are set." Q-1 and Q-2 are indefinitely deferred. Orchestration
prioritizes foundational work — not real-money-readiness ramp.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-2 | Capital-deployment-ramp ADR sign-off | Operator self-assigned ~1 week per s96 #13 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 95 unpushed commits to origin/main (Cycle 21..29 + handoffs) | Carry-over; count +5 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — 4 of 9 composites now PARTIAL; no PASS-ALL + PBO<0.2 yet |

**That's the entire queue.** Q-4 count 90 → 95 (Cycle 29 added 5
commits: 4 slice commits + this HANDOFF). All other items unchanged.

---

## What this cycle delivered (s96 #23 Cycle 29)

**Cycle 29 was a backfill-execution cycle that surfaced three new EDGAR
resilience holes, each fixed in its own slice + tested, on top of the
pre-cycle 10K-cap discovery.** The 5-month form 4 raw-data backfill
completed on the fourth attempt (after killing two crashed runs +
shipping the relevant fix between each).

### Slice 1 — EDGAR FTS 10K hits-per-query cap (S96-135) — `ce7e999`

`scripts/_sec_edgar_helpers.py` + `scripts/sec_edgar_form4_ingest.py`
+ NEW `scripts/tests/test_sec_edgar_helpers.py`:

- Pre-cycle EDGAR probe discovered `fetch_edgar_search_paginated`
  (Cycle 28 S96-132) silently truncates ANY query past 10K total
  hits. `from + 100 > 10000` returns 0 hits with no error;
  `hits.total.relation` flips from `"eq"` to `"gte"` when the true
  count exceeds the cap. **SECOND silent-truncation bug in the EDGAR
  path on top of the 100-hit-per-page bug fixed in Cycle 28.**

- `fetch_edgar_search_paginated`: capture `.relation` alongside
  `.value`; detect cap; emit loud stderr WARN by default; new
  `raise_on_cap=True` kwarg converts to RuntimeError.

- NEW `fetch_edgar_search_dated_split` helper: template URL with
  `{startdt}/{enddt}` placeholders + auto-decomposes window into
  ≤max_chunk_days chunks with `raise_on_cap=True`.

- `sec_edgar_form4_ingest.py`: NEW `build_form4_search_url_template`;
  main flow refactored (`--from-file` > `--url` (legacy single-shot)
  > default (template + split helper)).

- 14 new helper tests pin cap-detection, split semantics, validation.

### Slice 1b — fetch_edgar 5xx retry (S96-136) — `74e8f23`

- Cycle 29 first-apply attempt crashed on FIRST chunk's mid-pagination
  with FATAL HTTP 500. Re-probe of same URL succeeded immediately —
  transient burst. **THIRD resilience hole**: fetch helper retried 429
  only.

- `fetch_edgar`: HTTPError handler now retries on 429 OR 5xx with
  same exponential backoff. Logs each retryable attempt for
  self-diagnostic background logs.

- 4 new tests: 500-retry, 503-retry, 404 propagates, 403 propagates.

### Slice 1c — backfill tuning + form_4 snapshot driver — `5690eee`

`scripts/_sec_edgar_helpers.py` + NEW
`scripts/_backfill_form_4_insider_snapshots.ts`:

- Subsequent multi-month dry-run hit TWO new problems:
  (a) EDGAR's transient 5xx bursts exceeded 3-retry / 7s cumulative
      backoff. `SEC_RATE_LIMIT_MAX_RETRIES` bumped 3 → 5 (31s
      cumulative).
  (b) 14-day default chunk size hit the 10K cap on Feb earnings-
      season windows. `max_chunk_days` default 14 → 7 (7-day peak
      = ~5500 hits / 55% of cap; safe headroom).

- NEW `_backfill_form_4_insider_snapshots.ts` (335 lines) mirrors
  Cycle 24-26 `_backfill_*_snapshots.ts` pattern:
  - Reuses canonical `runDaemonForm4InsiderEvaluation` (S96-117
    gate 3 — no logic re-implementation).
  - SPY_USD trading-day calendar.
  - Watch-universe-PIT caveat documented inline (load-bearing
    aggregate uses SP500 PIT correctly; per-ticker counts use
    today's universe — non-load-bearing leak).
  - **Blocked from running on the full window** (Cycle 30 task —
    see "Cycle 30 prerequisites" below).

### Slice 1d — fetch_edgar TimeoutError retry (S96-137) — `638b36e`

- Cycle 29 second-apply attempt crashed mid-body-fetch with
  `TimeoutError: The read operation timed out` (SSL read inside
  urllib.urlopen). **FOURTH resilience hole**: `TimeoutError` is a
  builtin / `OSError` subclass — NOT `urllib.error.HTTPError` or
  `URLError` — so neither the 5xx-retry handler (Slice 1b) nor the
  form4 body-fetch try/except intercepted it.

- `fetch_edgar`: new except clause catches `(TimeoutError,
  urllib.error.URLError)` and retries.

- `sec_edgar_form4_ingest.py`: extended FIVE try/except sites from
  `(HTTPError, URLError)` to `(HTTPError, URLError, TimeoutError)`.

- 3 new tests: TimeoutError retry-then-success, URLError retry-then-
  success, persistent-TimeoutError exhausts retries + propagates.

### Slice 2 — multi-month --apply (in-cycle execution, no commit)

```
.venv/Scripts/python.exe -u scripts/sec_edgar_form4_ingest.py \
    --start-date 2026-01-01 --end-date 2026-05-25 --apply
```

- 4 launch attempts (3 crashed before the right fix landed):
  - PID 33840 (stderr-buffered, killed by OS restart).
  - bsazxr5v3 (post-Slice-1c) — CRASHED on FATAL HTTP 500 exhausting
    3-retry budget.
  - (Slice 1b's MAX_RETRIES bump shipped)
  - bsr2vffko (post-Slice-1d) — **COMPLETED in ~9.5h wall-clock**
    2026-05-26 23:56 local. Exit 0.

- Final apply summary:
  ```
  [edgar-form4] built 146055 insider-trade rows (32814 unique insiders)
  [edgar-form4] OK | wrote 146055 rows to quantlab.insider_trades
  | cached 32814 insider CIK entries | cached 0 issuer CIK->ticker entries
  ```

- Post-apply CH state (`FROM insider_trades FINAL`):
  - **143,628 rows** (post-dedup with Cycle 28's 2,593 rows on
    2026-05-14/15 overlap).
  - **72,865 unique accessions** (84% of 86,645 search filings —
    missing ~14K are derivative-only filings with no
    `nonDerivativeTransaction`; 0 rows by design per F4-A1).
  - **4,552 unique tickers**.
  - **32,823 distinct insiders**.
  - **accepted_at**: 2026-01-02 .. 2026-05-22 (5 months ex-weekends).
  - **insider_ciks**: 32,823 rows.
  - **cik_ticker_map**: 0 issuer entries (Form 4 XML carries
    `issuerTradingSymbol` directly; submissions-API fallback rarely
    fires).

- Monthly distribution:
  | Month | Rows | Accessions | Tickers |
  |---|---:|---:|---:|
  | Jan | 21,714 | 11,368 | 2,242 |
  | Feb | 37,999 | 18,303 | 2,578 |
  | Mar | 39,939 | 19,190 | 2,853 |
  | Apr | 19,926 | 10,608 | 2,307 |
  | May | 24,050 | 13,396 | 2,608 |

- Transaction-code distribution (composite-eligible {P, S} = 43,855
  rows / 30% of total; rest stored for forensic access per F4-4):
  ```
  S: 35,958   A: 35,047   F: 32,664   M: 22,425   P:  7,897
  D:  3,389   J:  2,427   G:  1,993   C:  1,255   X:    178
  L:    153   U:    152   I:     56   W:     26   O:      4
  ```

- Failure rate: **5 retryable errors in 30 log lines** across ~120K
  HTTP calls (~0.004% retry rate). Slowness was pure EDGAR archives
  endpoint latency (~300ms per HTTP roundtrip vs nominal 100ms).

### Slice 3 — post-apply probes + Cycle 30 prerequisite discovery

- Aggregate + monthly + transaction-code probes recorded above.
- `gics_sector_map` table MISSING in CH —
  `_backfill_form_4_insider_snapshots.ts --dry-run` crashes
  (UNKNOWN_TABLE). Snapshot driver BLOCKED until GICS ingest wires
  the table.
- `sp500_constituents` PIT has only 1 effective_date (2026-05-09
  from `ivv_holdings`). For asOf < 2026-05-09 the PIT query returns
  zero constituents → empty `inputs.sectors` → load-bearing
  aggregate signal can't fire on historical snapshots. Cycle 30
  needs PIT history depth too.

### Slice 4 — this HANDOFF rewrite

### Cycle 29 outcomes per orchestration §3.1 + §6

| Slice | Verdict | Outcome |
| --- | --- | --- |
| Pre-cycle 10K-cap probe | orchestrator | Surfaced second silent-truncation hole |
| Slice 1 (3 files, +508/-29) | orchestrator-self-edit per §3.1 | Shipped + 14 tests |
| Slice 1b (2 files, +97/-5) | orchestrator-self-edit per §3.1 | Shipped + 4 tests |
| Slice 1c (2 files, +421/-10 incl. new TS script) | orchestrator-self-edit per §3.1 | Shipped + smoke-validated |
| Slice 1d (3 files, +95/-12) | orchestrator-self-edit per §3.1 | Shipped + 3 tests |
| Slice 2 5-month --apply | orchestrator-driven background run | 4 attempts; 4th completed in ~9.5h |
| Slice 3 post-apply probes | orchestrator-self-edit (no commit) | Coverage healthy; Cycle 30 deps surfaced |
| Slice 4 HANDOFF rewrite | orchestrator-self-edit per §3.1 (pure-docs) | This file |

### Verification gates at cycle close

```text
git status                                                           # clean
git log origin/main..HEAD                                            # 95 commits ahead (after this HANDOFF)
npx tsc --noEmit                                                     # 13 baseline errors unchanged
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_*.py # 147/147 pass (+21 from Cycle 28's 126)
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass
```

### Push state

- `origin/main` at `c0cda7c`; **95 unpushed commits** after this
  HANDOFF rewrite.
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#22 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1..28 | ✓ as documented |
| **Cycle 29 — 5-month form4 raw backfill (143K rows) + 4 EDGAR resilience fixes (S96-135..S96-137) + snapshot driver shipped** | **✓ s96 #23** |
| Cycle 30 — gics_sector_map + sp500 PIT history ingest, then snapshot daemon-replay backfill | ☐ NEXT default |
| Thursday 2026-05-28 stockanalysis day-3 observation | ☐ first trading day post-Memorial-Day window |
| Cycles 31+ — Phase B SPEC + campaign for form_4_insider_v1 | ☐ blocked on Cycle 30 snapshot backfill |
| Cycles 31+ — Phase B campaigns for remaining 4 Layer-0 composites | ☐ each requires data-ingest groundwork per audit §3 |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| Layer-0 Phase B statistical validation campaigns (4 of 9 done) | ✓ cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 (all PARTIAL) |
| `form_4_insider_v1` Phase B arc | 🚧 IN-PROGRESS — raw data shipped Cycle 29; snapshot backfill + SPEC = Cycle 30-31 |
| Phase C promotion of any Layer-0 composite | ⏸ operator-gated per Q-8; DORMANT |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #23 (Cycle 29 of multi-agent orchestration)

**S96-135. EDGAR Full-Text Search caps per-query results at 10,000 hits.**
`Why:` Empirically verified 2026-05-25 across multiple window sizes. EDGAR
FTS reports `hits.total.value` AND `.relation`; `.relation` flips from
`"eq"` (exact count) to `"gte"` (lower bound) once true count exceeds the
cap. Past offset 10000, `from=N` returns 0 hits silently (no error). The
S96-132 paginator (Cycle 28) would terminate at the short-page rule and
return ~10K filings — SECOND silent-truncation bug on top of per-page
100-hit cap. Empirical Form 4 thresholds:
  - 15-day window = 9785 hits (just under cap, relation=eq)
  - 14-day peak earnings = >10K (relation=gte)
  - 7-day peak = ~5500 hits (55% of cap; safe headroom).
`How to apply:`
(1) `fetch_edgar_search_paginated` detects cap (loud WARN by default;
`raise_on_cap=True` for backfill callers).
(2) `fetch_edgar_search_dated_split` is the new canonical pattern for
backfill — template URL with `{startdt}/{enddt}` + auto-decompose into
≤max_chunk_days chunks with `raise_on_cap=True`.
(3) `sec_edgar_form4_ingest.py` default-path uses split helper; override
paths (`--url` / `--from-file`) preserve single-shot semantics.
(4) Cycle 30-32 task — migrate other three EDGAR ingest scripts
(`sec_edgar_8k_event_ingest.py`, `sec_edgar_8k_item_5_02_ingest.py`,
`sec_edgar_13d_g_ingest.py`) to split helper before their Phase B arcs
open. Until migrated, do NOT run multi-month --apply on those ingests.

**S96-136. EDGAR exhibits transient 5xx bursts that exceed 3-retry budget;
5-retry / 31s cumulative backoff holds empirically.**
`Why:` Cycle 29 first multi-month apply crashed on 503 burst in SECOND
chunk; 3 retries (1s+2s+4s=7s) all failed but immediate re-probe
succeeded. After bumping `SEC_RATE_LIMIT_MAX_RETRIES` 3→5 (1+2+4+8+16=
31s cumulative), Slice 2 apply observed only ~5 retry events across
~120K HTTP calls, 0 fatal. `How to apply:` (1) `fetch_edgar` retries on
429 OR 5xx (no behavioral change for non-5xx HTTPErrors). (2) Multi-hour
backfills tractable with 5-retry budget; do NOT shorten back to 3
without empirical justification. (3) Sustained outages >31s still kill
a run — S96-138 batched-write checkpointing is the right answer there.

**S96-137. `fetch_edgar` must catch builtin `TimeoutError` AND
`urllib.error.URLError` in addition to `HTTPError`; the form4 ingest's
body-fetch + CIK-resolve try/except blocks must mirror the same set.**
`Why:` Cycle 29 third apply crashed mid-body-fetch with SSL read
TimeoutError. Python's `urllib.urlopen` raises builtin `TimeoutError`
(OSError subclass) — NOT urllib HTTPError or URLError — on SSL read
timeout. A single slow response kills multi-hour backfills if uncaught.
`How to apply:` (1) `fetch_edgar` catches `(TimeoutError,
urllib.error.URLError)` and retries identically to 5xx. (2) Five
try/except sites in `sec_edgar_form4_ingest.py` extended — body-fetch +
issuer-resolve + insider-resolve + `discover_form4_primary_xml_url`
index.json fetch + search-phase FATAL handlers. (3)
`test_fetch_edgar_exhausts_retries_on_persistent_timeout` pins
MAX_RETRIES + propagation. (4) Cycle 30-32 EDGAR script migrations
(S96-135 (4)) MUST also extend their body-fetch try/except blocks.

**S96-138 (architectural, not yet implemented). The form 4 ingest script
writes to CH only at the very END after all body-fetches complete. A
10h-scale crash loses all in-flight work.**
`Why:` Cycle 29 Slice 2 took ~9.5h wall-clock. After OS restart + two
crash-then-fix cycles, the architectural risk is plain: script holds
86K filings' body-fetch results in memory + single bulk
`write_insider_trades(client, rows)` call at end
([sec_edgar_form4_ingest.py:986](scripts/sec_edgar_form4_ingest.py#L986)).
Same posture on `insider_ciks` + `cik_ticker_map`. `How to apply:`
(1) Cycle 30 first slice candidate — batch body-fetch loop into chunks
of ~500-1000 filings; each chunk writes `insider_trades` +
`insider_ciks` (+ post-end or per-chunk `cik_ticker_map`).
ReplacingMergeTree(ingested_at) already supports overlapping rewrites.
(2) Add a `--resume-from-date YYYY-MM-DD` flag so crashed runs skip
already-processed filings. (3) Same pattern likely needed for the
other 3 EDGAR ingest scripts before they open Phase B arcs.

**Carry-overs (still in force):** S96-1..S96-134; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle (s96 #23 Cycle 29)

- **OQ-C29-1** — Should the form4 ingest write in batches per S96-138?
  Cycle 30 first-slice candidate. ~50 LOC change to ingest +1 new test
  for partial-apply resumability. Alternative: leave as-is since
  Cycle 30 backfills are smaller-scoped (snapshot daemon-replay vs raw
  EDGAR fetches), so risk delta is small.

- **OQ-C29-2** — Migrate other three EDGAR ingest scripts to split
  helper proactively, or wait until each's Phase B arc opens? See
  S96-135 (4). Recommend per-arc migration UNLESS operator wants a
  cross-cutting Tier-1 sweep in dedicated Cycle 30-alt.

- **OQ-C29-3** — `gics_sector_map` ingest needs wiring. Precedent for
  Wikipedia "List of S&P 500 companies" scrape per S94-1
  (`scripts/sp500_gics_sector_ingest.py` referenced in reconciliation
  audit). Cycle 30 task. Sub-questions:
  (a) Is the script implemented and ready to run, or only spec'd?
  (b) Coverage: only today's SP500, or historical depth?
  (c) Do we need a separate historical-depth slice before form_4
      snapshot backfill is "real"?

- **OQ-C29-4** — `sp500_constituents` has only 1 effective_date
  (2026-05-09 from ivv_holdings). For PIT-correctness on historical
  snapshot backfills we need depth. Sources:
  (a) `ingest_sp500_history.ts` (per orchestration §1 manifest) —
      is this script populated + tested?
  (b) iShares IVV historical holdings (vendor; might need paid sub)
      vs Wikipedia changelog (free per data-source policy).

- **OQ-C29-5** — Watch-universe PIT leak in
  `_backfill_form_4_insider_snapshots.ts`. Phase B Cycle 31+ must
  decide whether the load-bearing score axis depends on the leaked
  per-ticker counts. If so, a PIT-aware watch-universe override is
  required.

### CARRIED from earlier cycles

- **OQ-C28-1** — Migrate other 3 EDGAR ingest scripts to paginated
  helper (now superseded by S96-135 (4) which adds dated-split
  migration to the same agenda).
- **OQ-C28-2** — **CLOSED Cycle 29**: EDGAR FTS `dateRange` filters
  on `accepted_at` (calendar-day matching). Pre-Cycle-29 mystery
  (Cycle 28's 3-day apply showing zero 2026-05-13 rows) attributed
  to EDGAR FTS indexing lag at that apply's time — re-probe NOW
  returns 813 filings for 2026-05-13.
- **OQ-C28-3** — `--snapshot-date` default = today affects
  historical backfills. Not triggered in Cycle 29 Slice 2 (default
  worked fine for window ending today). Resolution deferred.
- **OQ-C27-1** — FINRA bulk short-interest CSV URL discovery — still
  the largest single blocker for `short_interest_v1` Phase B.
- **OQ-C27-2** — `executive_departure_v1` / `schedule_13d_g_v1`
  composites' score-axis question (categorical vs continuous-Φ).
- **OQ-C27-3** — Cross-composite meta-HLZ pass at 4 vs 9 composites.
- **OQ-C26-1** — BAMLH0A0HYM2 (HY-OAS) alternative-source ingest.
- **OQ-C26-2** — Cross-composite Pardo ranking interpretation.
- **OQ-C26-3** — QQQ PBO=0.089 cell anomaly investigation.
- **OQ-C25-1** — HLZ M=57 universal-blocker pattern.
- **OQ-C25-2** — IWM PBO=0.709 anomaly from sector_rot_v1.
- **OQ-C24-1** — HLZ M=57 cross-composite meta-HLZ pass (deferred
  per ADR-051).
- **OQ-C24-2** — KNOWN_COMPOSITES domain placement protocol.
- **OQ-C24-3** — `pickPrimaryPhaseCCandidate` tiebreaker.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases.
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051.
- **OQ-C21-1** — Q-5 quarantine row drop timing.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement.
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix + Cycle 24
  /#/phase-b + Cycle 25-26 verdicts deferred to operator dev-server
  restart.
- **OQ-C19-1** — `inputs_missing` UInt8 truncation at bits 8+.
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C17-1** — VOO source quality issue.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused.
- Capital-deployment-ramp ADR — Q-2 indefinitely deferred.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent.
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 30 candidate

Cycle 30 is a **dependency-wiring cycle** for `form_4_insider_v1` Phase
B SPEC (planned for Cycle 31). Three load-bearing sub-tasks:

**Task A (Cycle 30 Slice 1) — gics_sector_map ingest (OQ-C29-3).**
Steps:
1. Run `npm run health:check` first per ADR-044.
2. Inspect `scripts/sp500_gics_sector_ingest.py` (per orchestration §1
   Data-Ingest manifest): implementation status, PIT vs snapshot-only
   semantics, source URL stability.
3. `--dry-run` to verify Wikipedia scrape still parses.
4. `--apply` to populate `quantlab.gics_sector_map`.
5. Verify: post-ingest row count > 500 (SP500 coverage); spot-check
   ~10 known tickers' sector assignments.

**Task B (Cycle 30 Slice 2) — sp500_constituents PIT history depth
(OQ-C29-4).** Steps:
1. Inspect `scripts/ingest_sp500_history.ts`.
2. Confirm free-source path (Wikipedia + `fja05680/sp500` GitHub PIT
   data per CLAUDE.md data-source policy).
3. Historical backfill (target 2013-01-01 → today, matching Cycle
   24-26 backfill windows).
4. Verify: `countDistinct(effective_date)` shows multi-year history;
   PIT query for asOf=2024-06-15 returns ~500 constituents.

**Task C (Cycle 30 Slice 3) — run snapshot daemon-replay backfill.**
With Task A + B complete, the
`_backfill_form_4_insider_snapshots.ts` driver shipped in Cycle 29 can
finally run end-to-end:
1. `npx tsx scripts/_backfill_form_4_insider_snapshots.ts --start
   2026-01-01 --end 2026-05-25` (dry-run first).
2. Validate sample output.
3. `--apply` to persist snapshots.
4. Cycle 31 opens with `form_4_insider_v1` Phase B SPEC.

**Alternative — Task A' (architectural priority) — S96-138 batched
writes.** If operator wants resilience over near-term Phase B
progress, Cycle 30 Slice 1 instead modifies
`sec_edgar_form4_ingest.py` for ~500-1000-filing batched writes +
`--resume-from-date`. Cycle 29's 9.5h experience justifies this.
Recommend Task A first unless operator picks otherwise.

### Alternative Cycle 30 candidates (lower priority)

- **Path 2** — Proactive cross-cutting EDGAR migration (OQ-C28-1 +
  S96-135 (4)). ~3-4 hours; 3 small commits.
- **Path 3** — Tier-1 closure burst (OQ-C19-1 + OQ-C24-3 + GAP-7(a)).
- **Path 4** — Early cross-composite meta-HLZ pass (OQ-C24-1 +
  OQ-C27-3).
- **Path 5** — `short_interest_v1` FINRA URL discovery (audit §6
  Path 5; OQ-C27-1).

### Long-running options (no change)

- **Q-7 path execution** if operator picks Path.
- **OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest** — enables
  future cross_asset_v2.
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion.

---

## Files / code state

### New / modified this cycle (s96 #23 Cycle 29)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | +198 / -25 | Slices 1+1b+1c+1d: 10K-cap + dated-split + 5xx retry + 5-retry budget + TimeoutError/URLError retry |
| `scripts/sec_edgar_form4_ingest.py` | +98 / -19 | Slices 1+1d: template + main flow refactor + 5 try/except blocks extended |
| `scripts/tests/test_sec_edgar_helpers.py` | NEW +394 | 21 tests: paginated cap, split semantics, 5xx retry, 4xx propagation, TimeoutError retry, URLError retry, retry exhaustion |
| `scripts/_backfill_form_4_insider_snapshots.ts` | NEW +335 | Slice 1c: form_4 snapshot daemon-replay driver; blocked on gics_sector_map + sp500 PIT |
| `.claude/HANDOFF.md` | rewrite | Slice 4 — this file |

Total: **~1,025 LOC across 5 files (4 slice commits + this HANDOFF)**.
DDL not modified. No real-money path touched. No paid-data. No
authenticated scrape. **21 new tests added** (126 pre-Cycle-29 → 147).

### DB-state changes this cycle

- `quantlab.insider_trades`: **2,593 → 143,628 rows** (+141,035 net);
  549 → 4,552 distinct tickers; 1,423 → 72,865 distinct accessions;
  accepted_at extended to **2026-01-02 .. 2026-05-22** (5 months).
- `quantlab.insider_ciks`: +31,432 new entries (1,381 → 32,823).
- `quantlab.cik_ticker_map`: unchanged (Form 4 XML carries
  `issuerTradingSymbol`; submissions-API fallback rarely fires).

### Test + tsc state

- `npm test`: not re-run (Python-only changes). Baseline 3791/3808
  pass + 17 skip + 0 fail still holds.
- `npx tsc --noEmit`: **13 baseline errors unchanged**.
- `pytest scripts/tests/test_sec_edgar_*.py`: **147/147 pass** (+21).
- `node --import tsx --test scripts/tests/healthCheck.test.ts`:
  **37/37 pass**.

### Untouched-but-relevant for next session

- Q-5 quarantine row pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows.
- `quantlab.cycle_position_snapshots` 4,626 rows; 2008-01-02 →
  2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows.
- `quantlab.sector_rotation_snapshots` 3,367+ rows.
- `quantlab.cross_asset_snapshots` 3,368 rows.
- `quantlab.phase_b_trials` 228 rows; `quantlab.phase_b_verdicts`
  12 rows.
- **Empty/missing tables (pre-Cycle-29, still blocked):**
  `short_interest` MISSING, `executive_departure` MISSING,
  `schedule_13d_g` MISSING, `eight_k_events` 0 rows,
  `etf_shares_outstanding` 0 rows.
- **Cycle 29 prerequisite discoveries (Cycle 30 tasks):**
  `gics_sector_map` MISSING (OQ-C29-3), `sp500_constituents` PIT
  depth only 1 date (OQ-C29-4), `sp500_constituents_pit` MISSING.
- **Form_4 snapshot table:** `form_4_insider_snapshots` 0 rows
  (Cycle 30 Slice 3 — driver shipped, blocked on Slices 1+2).
- Operator dev server still needs `npm run dev` restart for
  Cycle 20-26 surfaces.

### Background-task / log artifacts

- `logs/form4_apply_2026-05-26.log` — successful Slice 2 run (30
  lines, 2,385 bytes, completed 2026-05-26 23:56 local).
- `logs/form4_apply_2026-05-26.partial1.log` — pre-Slice-1d crash
  (OS restart, 510 KB).
- `logs/form4_apply_2026-05-26.partial2.log` — Slice 1b
  TimeoutError crash (510 KB).
- Partials are useful forensic; safe to delete post-Cycle-30.

---

## Watch-outs

### NEW from this cycle (s96 #23 Cycle 29)

- **EDGAR FTS has TWO silent-truncation caps** (100 hits per page +
  10K hits per query). Both fixed in S96-132 (Cycle 28) + S96-135.
  Any new FTS caller MUST use `fetch_edgar_search_dated_split` for
  multi-day windows OR `fetch_edgar_search_paginated(...,
  raise_on_cap=True)` for single-window-known-≤-10K queries.

- **`fetch_edgar` retries on (429, 5xx, TimeoutError, URLError)** —
  S96-136 + S96-137. Non-retryable 4xx (403, 404) propagate.
  Cumulative backoff 31s (5 retries × exponential). Sustained EDGAR
  outages >31s WILL still kill a run.

- **Form4 ingest's 5 try/except sites ALL extended for TimeoutError**.
  Future edits MUST preserve `(HTTPError, URLError, TimeoutError)`
  at minimum.

- **EDGAR archives endpoint runs ~300ms per HTTP call empirically.**
  Nominal "10 req/s" estimate is OFF by 3×. Multi-month form 4
  backfills take ~8-12h wall-clock at this rate. Plan accordingly.

- **Form 4 ingest writes ALL rows in a SINGLE final bulk INSERT.**
  A crash mid-body-fetch loses ALL in-flight work (S96-138).
  Recommended Cycle 30-33 fix: batched writes + `--resume-from-date`.

- **Snapshot driver shipped but BLOCKED** by `gics_sector_map`
  missing + shallow `sp500_constituents` PIT history.

- **§3.1 deviation precedent (S96-134) extended this cycle.** Cycle
  29 shipped 4 orchestrator-self-edit slices touching 4 different
  files (helper + ingest + new backfill driver + new test file).
  Extends Cycle 28's 2-file ≤~100 LOC precedent to 4-file ≤~500 LOC
  envelope when ALL §3.1 gates hold. Greenfield multi-file edits OR
  methodology-canon-amending ADRs still spawn workers; this
  precedent is bounded to extensions of established patterns.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#28 + Cycle 28 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text (every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON
npm run health:check:strict            # Phase 1 strict — exit 1 on non-green
npm run system-health:check            # Phase 2 v1 dispatcher
# UI surface: http://localhost:3000/#/health
# Phase B UI surface: http://localhost:3000/#/phase-b
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                  # Includes §0c Phase B verdicts
npm run health:check
```

### Phase B campaigns (4 of 9 shipped)

```text
npm run phase_b:cycle_v1:dry
npm run phase_b:cycle_v1:apply
npm run phase_b:vol_struct_v1:dry
npm run phase_b:vol_struct_v1:apply
npm run phase_b:sector_rot_v1:dry
npm run phase_b:sector_rot_v1:apply
npm run phase_b:cross_asset_v1:dry
npm run phase_b:cross_asset_v1:apply
```

### EDGAR ingests (Cycle 29 split-helper + retry-pack shipped for form4 only)

```text
# Form 4 (PAGINATED + DATE-SPLIT — Cycle 29 fix S96-135..S96-137):
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --start-date YYYY-MM-DD --end-date YYYY-MM-DD --dry-run
.venv/Scripts/python.exe -u scripts/sec_edgar_form4_ingest.py --start-date YYYY-MM-DD --end-date YYYY-MM-DD --apply > logs/form4_apply_<date>.log 2>&1

# 8-K event (NOT YET PAGINATED OR SPLIT — single-shot; do NOT multi-day apply):
npm run edgar:8k-event:ingest

# 8-K Item 5.02 exec departures (NOT YET PAGINATED OR SPLIT):
npm run edgar:exec-departure:ingest

# Schedule 13D/G (NOT YET PAGINATED OR SPLIT):
npm run edgar:13d-g:ingest
```

### Tests + dev

```text
npm test                                                                                                  # 3791/3808 pass + 17 skip + 0 fail
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_*.py                                      # 147/147 pass (+21 in Cycle 29)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                      # 82/82 pass
node --import tsx --test scripts/tests/phaseBCampaignCrossAssetV1.test.ts                                 # 78/78 pass
node --import tsx --test scripts/tests/phaseBCampaignSectorRotV1.test.ts                                  # 79/79 pass
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts                                  # 59/59 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                                # 37/37 pass
npm run dev                                                                                               # http://localhost:3000 (OPERATOR RESTART NEEDED)
npx tsc --noEmit                                                                                          # 13 baseline errors
```

---

## For the next session — priority order

**Default on `continue` — Cycle 30 candidate:**

- **Task A (Slice 1):** wire `gics_sector_map` ingest (OQ-C29-3).
- **Task B (Slice 2):** sp500_constituents PIT history depth
  (OQ-C29-4).
- **Task C (Slice 3):** run snapshot daemon-replay backfill via
  `_backfill_form_4_insider_snapshots.ts` (shipped Cycle 29).

**Cycle 30 alternative (architectural priority):**

- **Task A' — S96-138 batched writes** to
  `sec_edgar_form4_ingest.py`.

**Other Cycle 30 alternatives (lower priority):**

- **Path 2** — Proactive cross-cutting EDGAR migration.
- **Path 3** — Tier-1 closure burst.
- **Path 4** — Early cross-composite meta-HLZ pass.
- **Path 5** — `short_interest_v1` FINRA URL discovery.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 95 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX (operator restart needed).
- Q-7 phase1_v3 yield-curve source persistence.
- Q-8 Phase C promotion — **DORMANT**.

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase C promotion of any Layer-0 composite to phase1_v3+.
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution.
- v1 primary read path flip.
- VOO-specific paid feed.
- Counterfactual rewrite of historical macro_regimes.
- cycle_v2 / vol_struct_v2 / sector_rot_v2 / cross_asset_v2 redesign.
- Relaxed Phase B thresholds.
- Alpaca / IBKR broker integration.
- Migration of other 3 EDGAR ingest scripts (OQ-C29-2 +
  S96-135 (4)).

---

## Important framing for the next chat

**Cycle 29 is closed.** Five commits: Slice 1 EDGAR FTS 10K-cap fix
(`ce7e999`), Slice 1b fetch_edgar 5xx retry (`74e8f23`), Slice 1c
backfill tuning + form_4 snapshot driver (`5690eee`), Slice 1d
TimeoutError retry (`638b36e`), Slice 4 this HANDOFF rewrite. Net 95
unpushed commits.

**Cycle 29 was a backfill-execution cycle that surfaced three EDGAR
resilience holes (S96-135 10K-cap, S96-136 5xx-retry-budget-too-short,
S96-137 TimeoutError-uncaught) on top of the pre-cycle 10K-cap
discovery, each fixed in its own commit + tested.** The 5-month form 4
raw-data backfill (2026-01-01..2026-05-25) completed on the 4th launch
attempt with **143,628 rows / 4,552 tickers / 32,823 insiders / 5
months of accepted_at coverage**. Total wall-clock for the successful
run: ~9.5h (EDGAR archives endpoint latency is ~300ms per HTTP call,
3× slower than the nominal 10 req/s ceiling).

**S96-138 is a known architectural debt** (single-bulk-insert at end
loses all in-flight work on crash) — recommended as Cycle 30-33 Slice
when next multi-hour backfill is imminent.

**The form_4 snapshot daemon-replay driver
(`_backfill_form_4_insider_snapshots.ts`) is shipped but currently
BLOCKED** on two missing dependencies (gics_sector_map missing;
sp500_constituents PIT depth only 1 date) — Cycle 30 Slices 1+2
unblock; Slice 3 runs it.

**The 9-arc:**

- ✓ cycle_v1 (Cycle 23 PARTIAL) + Cycle 27 OQ-C23-1 backport
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ✓ sector_rot_v1 (Cycle 25 PARTIAL)
- ✓ cross_asset_v1 (Cycle 26 PARTIAL; first AUTO-APPROVE)
- 🚧 form_4_insider_v1 (Cycle 28 = pagination fix + 3-day apply;
  Cycle 29 = 10K-cap fix + 5-month raw backfill + snapshot driver
  shipped; Cycle 30 = gics + sp500 PIT + snapshot backfill;
  Cycle 31 = Phase B SPEC + campaign)
- ☐ short_interest_v1 (3-5 cycle ingest; FINRA URL discovery
  largest blocker)
- ☐ exec_departure_v1 (2-3 cycle ingest; EDGAR family)
- ☐ etf_flow_v1 (Path 1 BLOCKED until Q-6 resolved)
- ☐ eight_k_classifier_v1 (2-3 cycle ingest; EDGAR family)

**Cycle 30 default path (recommended):**

- Slice 1: `gics_sector_map` ingest (OQ-C29-3).
- Slice 2: `sp500_constituents` PIT history depth (OQ-C29-4).
- Slice 3: snapshot daemon-replay backfill.
- Slice 4: HANDOFF rewrite; Cycle 31 opens with Phase B SPEC.

**Cycle 30 alternative (if next multi-month backfill imminent for
another EDGAR arc):**

- Slice 1: S96-138 batched writes to `sec_edgar_form4_ingest.py`.

**Per the S96-130 pre-SPEC data-coverage hard gate:** Cycle 31 (Phase
B SPEC for form_4_insider_v1) must run a CH probe of
`form_4_insider_snapshots` FIRST after Cycle 30 daemon-replay. If
continuous coverage isn't verified, Cycle 31 pivots back to fix.

**Worker-spawn / SPEC-on-main / worktree watch-outs** carried over
from Cycle 27-28 — see HANDOFF Cycle 27-28 Watch-outs sections + the
new S96-135..S96-138 watch-outs above.
