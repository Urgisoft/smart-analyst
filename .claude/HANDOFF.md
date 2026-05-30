# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #36 — **Cycle 39: form_4_insider_v5 SHIPPED + D7 coverage gap
CLOSED via SEC bulk Form 345 data sets + OQ-C38-1 MEASURED (answer: still `under_review`).** Big
cycle. (1) **`form_4_insider_v5`** (ADR-055 cross-sectional pooled construct) is in code + merged +
UI-validated (`4e425e8`). (2) **D7 done the fast way:** instead of a ~15-25h per-filing EDGAR-XML
crawl, ingested SEC's **bulk Form 345 quarterly data sets** (`scripts/sec_edgar_form345_bulk_ingest.py`,
`5a578f2`) — 7 quarters (2024q2…2025q4) in ~2 min, SAME EDGAR-canonical provenance. The 2024-06…2025-10
EDGAR-P/S gap (which was Finnhub-only, NOT "SP500-filtered" as a prior handoff wrongly said) is now
fully populated; `insider_trades` 296k→**675,434** rows, EDGAR P/S continuous 2024-04→2026-05. (3)
**OQ-C38-1 measured, not asserted:** with the baseline now saturated at the full 730-day window, pooled
**BUY effectiveEvents=8, SELL=1 — still < 20 floor → `under_review`.** ADR-055 D3's "~4× coverage →
20-60 events" projection is FALSIFIED. Coverage is no longer the limiter; buy needs a longer baseline
WINDOW (multi-year, a-priori ADR), sell is structurally stuck at 1 (continuous plateau — needs a
different construct). (4) GAP-16 re-verified CLOSED (`901af94`). The floor was NOT moved anywhere.

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker Desktop. On reboot:
1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll engine up: loop `docker version`; then `docker start quantlab-clickhouse`; wait
   `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse` = `healthy` (~10-40s).
3. Verify: `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.

(This session the host crashed mid-cycle; recovery was clean — CH restarted in seconds, no data lost.)

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT hot-reloading; restart
after server-side edits. Used for v5 UI validation this cycle, then STOPPED (clean). Form 4 panel:
`/#/form-4-insider`; data route `/api/form-4-insider` (`compositeVersion: form_4_insider_v5`,
`verdict: under_review`).

**NO orphaned background jobs.** The slow XML crawl was killed + its driver removed; the bulk ingest is
a fast foreground op. Nothing is running in the background.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every routine
decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~137** unpushed commits to origin/main | Carry-over (+5 this session) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (orchestration-owned, for awareness — NOT queue items):**
- **ADR-052 D7 EDGAR coverage backfill — DONE this cycle** via the bulk Form 345 data sets (free,
  fast). Gap closed; still NOT real-money.
- **form_4_insider_v5 + the OQ-C38-1 measurement** — SHIPPED + measured (Layer-0 informational; not
  operator-gated). Result: still `under_review` (8 buy / 1 sell events < 20). Here for awareness.

---

## What this session delivered (s96 #36 — Cycle 39)

| Commit / action | Slice |
| --- | --- |
| `4e425e8` | **form_4_insider_v5** (ADR-055 pooled construct). Composite worker + Critic AUTO-APPROVE + ff-merge. 451/451 tests, tsc 13, NO DDL. |
| `12839bc` | (interim HANDOFF — superseded by this one) |
| `901af94` | **GAP-16 re-verified CLOSED** (ADR-047 addendum) — `phase1_v3` bt_runs_regime backfill since completed; sentinels stable + identical across v2/v3 (78,399 each); 0 shape violations; read-side guard intact. |
| `5a578f2` | **Bulk Form 345 ingest** `scripts/sec_edgar_form345_bulk_ingest.py` (+17 pytest) + ADR-052 addendum; removed the superseded slow-crawl driver. Data-Ingest worker + Critic AUTO-APPROVE. |
| (this commit) | ADR-055 addendum (OQ-C38-1 measured) + this HANDOFF. |
| (CH writes) | bulk-ingested 2024q2…2025q4 (471,296 trade rows) → `insider_trades` 675,434 FINAL; re-backfilled 98 v5 snapshots over the 730-day baseline. |

Method: host crash mid-cycle → clean CH restart. Composite worker (v5) + Data-Ingest worker (bulk
ingest), each with a Critic AUTO-APPROVE; both worktrees hit the STALE-BASE hazard (see watch-outs) —
verified `merge-base==main HEAD` before integrating (v5 ff-merged; bulk-ingest copied as new files since
its worktree branch was 150 commits behind). All [HEALTH] findings verified on live CH, not asserted.

---

## Decisions locked in

### Cycle 39 — form_4_insider_v5 (ADR-055 pooled construct) SHIPPED
- `FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v5'`. Gated unit = index-level pooled rate
  `pooledRate = Σ_sectors clusterTickers / Σ_sectors sectorSize` (issuer-weighted, NOT mean-of-rates),
  through the SAME ADR-053 exceedance + ADR-054 `countNonZeroRuns`/`EVENT_FLOOR=20` guard VERBATIM.
  Flags + `maxAggregateZ[Sell]` from the pooled stat; `maxAggregateZSector[Sell]` = literal `'S&P 500'`.
  Per-sector retained INFORMATIONAL (non-gating). NO DDL (`{sectors,pooled}` JSON wrapper). Zero new params.

### Cycle 39 — D7 EDGAR coverage backfill DONE via SEC bulk Form 345 data sets (ADR-052 addendum)
- `scripts/sec_edgar_form345_bulk_ingest.py` parses SEC's bulk Form 345 quarterly ZIPs
  (`https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{YYYY}q{N}_form345.zip`,
  2019q1→present) → `insider_trades`. ~minutes vs the ~15-25h per-filing XML crawl; SAME EDGAR-canonical
  provenance (real reporting-person CIKs → `source='sec_edgar_form4_xml'`, the canonical equivalence
  class; zero composite/coverage change, no DDL). transaction_id 0-based by `NONDERIV_TRANS_SK` asc =
  XML doc order (100% match on 4,489 multi-txn filings → ReplacingMergeTree collapses cleanly).
  `accepted_at` from `SUBMISSION.FILING_DATE`@00:00 (F4-10 anchor). Cross-check (2025q4 vs live-XML
  Dec-2025): 99.31% key overlap; only diffs = SEC's own price rounding (1-2dp); bulk is MORE complete.
- **[HEALTH] corrected attribution:** the EDGAR-P/S gap was **2024-06…2025-10 (0 EDGAR P/S, Finnhub-only)**
  — D1 excludes Finnhub → not admitted. NOT "SP500-filtered Cycle-32" (an interim-handoff error).
  2025-11+ was already full EDGAR. Applied 2024q2…2025q4 → gap closed, EDGAR P/S continuous 2024-04→2026-05.

### Cycle 39 — OQ-C38-1 MEASURED (ADR-055 addendum): D3 projection FALSIFIED
- Post-D7, pooled baselineSize=**730** (saturated full window), pooled **BUY effectiveEvents=8, SELL=1**,
  both < `EVENT_FLOOR=20` → still `insufficientData` → `under_review`. The "~4× coverage → 20-60 events"
  projection is falsified (4× coverage gave 8 buy, not 20-60). **Floor NOT lowered.**
- **Buy:** coverage no longer binding (730 is the window cap). Lever = a longer baseline WINDOW
  (multi-year backfill, now trivial via bulk) + an a-priori `BASELINE_CALENDAR_DAYS` change (NEW ADR;
  must NOT be tuned to clear the floor). ~8 events/730d → reaching 20 plausibly needs ~3-5 years.
- **Sell: structurally stuck at 1 event.** The pooled sell-rate is non-zero EVERY admitted day (insider
  selling is continuous market-wide; Lakonishok-Lee §4) → `countNonZeroRuns` = one plateau = 1 event.
  More data extends the plateau, never adds runs → cannot reach the floor via coverage or window. Needs
  a DIFFERENT construct (onset/threshold-excess). New RESEARCH question **OQ-C39-1**.

**Carry-overs:** ADR-052 (+ addendum), ADR-053, ADR-054, ADR-055 (+ addendum), ADR-050/051, ADR-047
(+ Cycle-39 re-verification), all prior. The form_4 four-layer template (052 provenance → 053 statistic
→ 054 event-sample → 055 pooled unit) is complete in code.

---

## Open questions

### form_4 arc — the honest state + the fork (read this)
form_4's aggregate has now consumed FOUR ADRs (052-055) + a full coverage backfill and **remains
`under_review`** with the data lever exhausted (coverage saturated). [PUSHBACK for next session] Before
investing further, weigh: is form_4's aggregate worth the remaining levers vs. redirecting to the other
8 Layer-0 composites (which have viable continuous data + ready Phase-B campaigns)? The three honest paths:
- **OQ-C38-2 (buy lever)** — multi-year EDGAR backfill (now trivial: `--quarters 2019q1,…` etc.) + an
  a-priori ADR extending `BASELINE_CALENDAR_DAYS` beyond 730. Uncertain payoff (buy ~8/730d → ~20 needs
  ~3-5y). Do NOT extend the window to hit the floor — decide the window a-priori on its own merits.
- **OQ-C39-1 (sell lever, NEW)** — a different sell-side construct that breaks the continuous-plateau
  (onset detection / threshold-excess events). RESEARCH-first; the pooled-rate+countNonZeroRuns unit is
  structurally wrong for the always-on sell side.
- **Accept form_4 aggregate as permanently-informational** for now; move to other Layer-0 Phase-B work /
  reconciliation gaps. Defensible given the investment-to-date vs. remaining uncertainty.

### Carried
- **OQ-052-3** — the four-layer template applies to `schedule_13d_g`/`eight_k`/`executive_departure`/
  `short_interest` once each ingest runs (tables empty today). The bulk-dataset pattern (this cycle)
  is the fast ingest path for any of them too.
- **OQ-C37-1/2** (calendar-aware run-breaking / firing de-dup — moot until firing).
- **CARRIED:** OQ-C31-4, OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3,
  OQ-C19-1, OQ-C18-1, OQ-C17-1.

---

## Next stage

### Default on `continue` — orchestration's call
The form_4 data lever is exhausted (coverage saturated; OQ-C38-1 answered). The highest-leverage next
move is most likely **NOT** more form_4 — pick one:
1. **Redirect to another Layer-0 Phase-B campaign or reconciliation gap (RECOMMENDED).** The other 8
   composites have continuous data; GAP-13 (Quartz upgrade doc) + GAP-10 (CI/CD) are independent and
   ready. (GAP-16 is CLOSED — do not re-investigate.)
2. **form_4 buy-side window extension** — only if you first write an a-priori ADR justifying a longer
   `BASELINE_CALENDAR_DAYS` on its own merits, THEN multi-year bulk-backfill + re-measure. Anti-shopping
   discipline applies (don't pick the window to clear 20).
3. **form_4 sell-side construct research (OQ-C39-1)** — RESEARCH a plateau-breaking sell aggregate.

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `4e425e8` | `form_4_insider.ts`, `form_4_insider_repository.ts`, `descriptors.ts`, 5 form4 test files. |
| `901af94` | `adr-047-…md` (re-verification addendum), `.claude/HANDOFF.md`. |
| `5a578f2` | `scripts/sec_edgar_form345_bulk_ingest.py` (new), `scripts/tests/test_sec_edgar_form345_bulk_ingest.py` (new), `adr-052-…md` (addendum); removed `scripts/_d7_form4_backfill_driver.sh`. |
| (this commit) | `adr-055-…md` (addendum), `.claude/HANDOFF.md`. |

### Form 4 pipeline (current on-disk + CH state)
- **Composite:** `src/server/form_4_insider.ts` — v5 pooled construct (see Decisions). Statistic+guard
  (`computeEmpiricalExceedance`, `countNonZeroRuns`, `EVENT_FLOOR=20`, `MIN_Z_BASELINE=30`, α=0.05) UNCHANGED.
- **Repository:** `form_4_insider_repository.ts` — pooled baseline in `populateSectorsForCycle`;
  `{sectors,pooled}` JSON wrapper. `EDGAR_COVERAGE_FLOOR=500`, `_WINDOW_DAYS=30`, `BASELINE_CALENDAR_DAYS=730`.
- **Bulk ingest:** `scripts/sec_edgar_form345_bulk_ingest.py` — `--quarters a,b,c` or `--start-quarter/--end-quarter`;
  `--dry-run` (default) / `--apply`; `--cross-check-month YYYY-MM`. Cache → `logs/_form345_cache/` (gitignored).
  THE form_4 (and template for any EDGAR-filing) backfill mechanism now.
- **Snapshot backfill:** `scripts/_backfill_form_4_insider_snapshots.ts --apply` (~98 days, ~80-145s).

### Key CH facts
- `insider_trades`: **675,434 rows FINAL** (was 296k). EDGAR P/S continuous 2024-04→2026-05 (5.5k-13.3k/mo,
  all clear the 500/30d floor). Finnhub P/S rows persist in 2024-06…2025-10 but are EDGAR-D1-excluded.
- `form_4_insider_snapshots`: 98 rows `form_4_insider_v5`. Latest (2026-05-22): pooled buy
  effectiveEvents=**8**, sell=**1**, baselineSize=**730**, insufficientData=true → `maxAggregateZ` null,
  flags false, `under_review`.
- `health_quarantine`: 3 rows; form_4 row `accepted-as-warning`, `sparse-rate-aggregate-under-review`.

### DB-state (session-start health:check: fresh=3 stale=0 very-stale=12 missing=1 empty=9; migrations 20/20)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron). 9 empty + 1 missing = never-run EDGAR/FINRA ingests.

---

## Watch-outs

### NEW this cycle
- **The bulk Form 345 ingest is the fast EDGAR-filing backfill mechanism** — `--quarters` (idempotent,
  ReplacingMergeTree). Source-tagged `'sec_edgar_form4_xml'` (canonical class; the tag gates identity
  validity, not fetch mechanism — see ADR-052 addendum). Price is rounded 1-2dp in SEC's bulk TSV
  (immaterial to the identity-based cluster path; minor on the informational net-dollar).
- **OQ-C38-1 is ANSWERED: form_4 aggregate is NOT Phase-B-ready even at saturated coverage** (8 buy / 1
  sell < 20). Do NOT mistake "D7 done" for "form_4 viable." Do NOT lower EVENT_FLOOR / extend the
  baseline window to chase the floor (anti-shopping; ADR-055 addendum).
- **The sell-side pooled aggregate is structurally a single plateau (1 event)** — any consumer must treat
  the form_4 sell aggregate as non-viable under the current construct (OQ-C39-1).
- **Per-sector form_4 flags are INFORMATIONAL ONLY (v5/ADR-055 D2).** The gated signal is the pooled stat.
- **`flagged_sectors_json` is a `{sectors,pooled}` wrapper** — use `decodeFlaggedJson` (handles wrapper +
  legacy bare-array + malformed). Don't assume a bare array.

### Carried (still load-bearing)
- **WORKTREE STALE-BASE HAZARD — hit TWICE this cycle** (both Agent `isolation:"worktree"` spawns started
  at `c0cda7c`, ~150 commits behind). ALWAYS verify `merge-base==main HEAD` before integrating. The v5
  worker reset its branch to main (clean ff-merge); the bulk-ingest worker did NOT (its only output was 2
  NEW files → copied onto main, branch NOT merged — a blind merge would have reverted 150 commits).
  `ExitWorktree` is a no-op on Agent worktrees → `git worktree remove --force` + `git branch -D`.
- **Chronological baseline order LOAD-BEARING** (ADR-054 D1 + pooled series). `effectiveEvents` (runs)
  gates validity; `effectiveSample` (non-zero days) is DIAGNOSTIC only.
- **Finnhub `person_cik` is a name-hash (S96-145)** — EDGAR canonical source only for the cluster path
  (ADR-052 D1). **`accepted_at` (NOT `transaction_date`) is the anti-leak anchor** (F4-10).
- **S96-149 alias-shadowing** — subquery-around-FINAL for every composite `loadHistory`.
- **CH em-dash on the wire is correct UTF-8** (`E2 80 94`); curl→python cp1252 shows mojibake — display
  artifact, not a bug. **`bash`≠PowerShell here-strings** — use `git commit -F` / single-line `-m`.
- **Dev server** does NOT hot-reload server edits. ReplacingMergeTree re-backfills REPLACE rows.
- All prior watch-outs preserved (EDGAR/FINRA per-IP throttle; gics PIT-anchor; CH-Date range; sp500 PIT gap).

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot:
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse                 # loop until healthy
curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"
# Bulk Form345 ingest (the EDGAR-filing backfill mechanism):
.venv/Scripts/python.exe scripts/sec_edgar_form345_bulk_ingest.py --quarters 2024q3,2024q4 --dry-run --cross-check-month 2025-12
.venv/Scripts/python.exe scripts/sec_edgar_form345_bulk_ingest.py --quarters <list> --apply
# Re-backfill v5 snapshots + read pooled events:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply
curl -s ".../quantlab" --data-binary "SELECT JSONExtractInt(flagged_sectors_json,'pooled','effectiveEvents') FROM quantlab.form_4_insider_snapshots FINAL ORDER BY snapshot_date DESC LIMIT 1"
# Form4 tests + tsc + health:
node --import tsx --test scripts/tests/form4Insider.test.ts scripts/tests/form4InsiderRepository.test.ts scripts/tests/compositeForm4Dashboard.test.ts scripts/tests/operatorBrief.test.ts scripts/tests/operatorBriefRender.test.ts
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form345_bulk_ingest.py -q
npx tsc --noEmit                                 # 13 baseline (all scripts/_*.ts)
npm run health:check
```

---

## For the next session — priority order

**Cycle 39 closed the form_4 data question.** v5 (the correct pooled construct) is shipped; D7 coverage
is done (fast, via the bulk Form 345 data sets) and saturated; and OQ-C38-1 is MEASURED: form_4's
aggregate is still `under_review` (8 buy / 1 sell events < 20) — the binding constraint is no longer
coverage but (buy) baseline-window length and (sell) a structural plateau. The honest recommendation is
to **redirect** effort: the remaining form_4 levers (a multi-year window for buy, a new construct for
sell) have uncertain payoff after four ADRs of investment, while the other 8 Layer-0 composites and the
GAP-13/GAP-10 reconciliation items are ready and independent. Pick per "Next stage."

**Do NOT auto-open without operator green-light:** Phase C promotion (Q-8); ALTER DROP/DELETE; `git push`
(Q-4, ~137 commits); real-money path. **Do NOT tune EVENT_FLOOR / α / the baseline window to a desired
outcome** (anti-shopping — ADR-055 addendum is explicit).

---

## Important framing for the next chat

**This cycle did the work AND got an honest "no."** form_4_insider_v5 (ADR-055 pooled construct) is
correct and shipped. D7 — the coverage backfill that everything hinged on — is DONE, and done ~1000×
faster than planned by switching from a per-filing EDGAR-XML crawl to SEC's bulk Form 345 data sets
(same provenance, verified equivalent). With coverage now saturated, the pooled aggregate was MEASURED
(not assumed) and it still does not clear the event floor: 8 buy / 1 sell vs 20. That falsifies ADR-055's
own projection and, crucially, was surfaced honestly rather than papered over by moving the floor. The
form_4 aggregate's remaining path is genuinely uncertain (a multi-year window for buy; a brand-new
construct for sell), so the framing for next time is a real fork: keep investing in form_4, or redirect
to the 8 composites that already have viable data. UI coverage unchanged = 10 live panels. No floor moved.
