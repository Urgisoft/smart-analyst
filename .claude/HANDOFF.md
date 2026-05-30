# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #34 — **Cycle 37: ADR-054 RATIFIED + IMPLEMENTED +
merged + v4 re-backfilled + VERIFIED + UI-validated.** OQ-C36-1 (event-run
autocorrelation) and OQ-C36-2 ("under review" intent vs guard reality) were the SAME
bug and are both RESOLVED. The ADR-053 empirical-exceedance guard counted NON-ZERO
baseline DAYS for its effective-sample floor; because each daily cluster-rate is a
trailing-30d window, one cluster event makes a ~30-day plateau of non-zero days, so the
day-count over-counted independent events by ~30× and sectors with m≈11-16 (really ~1-2
events) FIRED instead of reading under_review. ADR-054 sharpens the guard to count
**distinct independent EVENTS** = maximal runs of consecutive non-zero baseline values
(`countNonZeroRuns`; a 30d plateau → 1 event), floor `effectiveEvents ≥ EVENT_FLOOR =
⌈1/α⌉ = 20` (the α-derived representability minimum; AFML Ch.4 §4.3-4.4 concurrency).
**Zero new free parameters** (derives solely from the existing α=0.05). The ADR-053
statistic (p, zEmp, p≤α firing, MIN_Z_BASELINE=30, buy/sell symmetry) is UNCHANGED — only
the guard's effective-sample metric (days→events) + floor changed. Shipped via a
Composite worker + Critic (AUTO-APPROVE, HIGH), merged at `3b78379`, all 98 snapshots
re-backfilled to `form_4_insider_v4`. **VERIFIED on live CH:** buy/sell firing
**24/27 → 0/0**; rows with non-null `max_aggregate_z[_sell]` = **0/0**; every sector
guard-suppressed → dashboard `under_review` for all 85 history days (a-priori prediction
D3 held exactly). **UI-validated:** `/api/form-4-insider` → HTTP 200, v4, verdict
`under_review`, no NaN/Infinity. This is the honest [HEALTH] outcome: the aggregate
correctly reports "insufficient independent events to calibrate a 5% tail until D7
coverage" instead of firing on autocorrelated single-event plateaus. Quarantine kept
`accepted-as-warning` (statistic + guard now CORRECT, but the aggregate is correctly
SUPPRESSED, not yet a trustworthy Phase-B signal), NOT `corrected`. NEXT on `continue`:
see "Next stage".

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker Desktop.
On reboot:

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll engine up: loop `docker version`; then `docker start quantlab-clickhouse`;
   then wait `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse`
   = `healthy` (~10-40s after engine ready).
3. Verify before any CH work:
   `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
   (This session: CH was already up + healthy at start; no reboot.)

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT
hot-reloading; restart after server-side edits. **Not running at end of this session**
(started for the Cycle-37 UI validation, then stopped). `/#/form-4-insider` now renders
the v4 `under_review` verdict (maxAggregateZ null everywhere — every sector is
guard-suppressed under the event floor). The data route is `/api/form-4-insider`.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every
routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~128** unpushed commits to origin/main | Carry-over (+2 this session: `3b78379` code+ADR, + the HANDOFF commit) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not queue items — orchestration-owned, operator-PACED / for awareness):**
- **ADR-052 D7 — EDGAR Form 4 gap backfill (`2024-06 … 2025-11`).** Free source but a
  throttled bulk op (per-IP rate-limited) — pace it. NOW THE GATING ITEM for the form_4
  aggregate: ADR-054 made the aggregate correctly suppress to `under_review` because no
  sector has ≥20 distinct cluster events. D7 lengthens the baseline so sectors can
  eventually clear the event floor (though per OQ-C37-3 even post-D7 per-sector tails may
  be under-powered → possible sector pooling). form_4 aggregate is NOT Phase-B-ready
  until D7 + OQ-C37-3 resolve. NOT real-money.
- **ADR-054 — RATIFIED + IMPLEMENTED this cycle** (calc-guard logic → operator-VISIBLE per
  ADR-044, orchestration owns the decision; AFML Ch.4 is already Tier-1 so NOT
  operator-GATED. Here for awareness).

---

## What this session delivered (s96 #34 — Cycle 37)

| Commit | Slice |
| --- | --- |
| `3b78379` | **ADR-054 form_4 v4** — distinct-event effective-sample guard replaces the non-zero-DAY count. `src/server/form_4_insider.ts` (+222/-…: `countNonZeroRuns`, `EVENT_FLOOR=⌈1/α⌉`, guard swap, v4 pin, interfaces, docstrings), `form_4_insider_repository.ts` (+19/-4: chronological-order load-bearing pin + JSON comment), `descriptors.ts`, `form_4_dashboard.ts` (doc only), `operator_brief.ts`, `operator_brief_render.ts` (Events + nz-days columns) + 5 test files; ADR-054 ratified (Accepted) in the same commit. Composite worker + Critic AUTO-APPROVE (HIGH). tsc 13 baseline (Δ0); 439 form4-suite tests green. 12 files, 819+/162-. |
| (this commit) | This HANDOFF rewrite. Pure docs. |
| (CH, not git) | v4 re-backfill: all 98 `form_4_insider_snapshots` → `form_4_insider_v4` (~79s). `health_quarantine` row re-versioned → `adr_ref='ADR-052,ADR-053,ADR-054'`, still `accepted-as-warning`, `cycle_ref='s96 #34 Cycle 37'`. No DDL. |

No DDL, no real-money path, no scrape. The CODE went through worker+critic (composite
guard logic). No worktree used (single worker, main checkout — Cycle-36 precedent +
worktree_merge_verify_base lesson). Dev server started for UI validation, then stopped.

---

## Decisions locked in

### s96 #34 Cycle 37 — ADR-054 RATIFIED + implemented (the code facts)
- **`FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v4'`** (ADR-051 D8 version-pin).
- **The fix:** the ADR-053 effective-sample guard now counts **distinct independent
  events**, not non-zero days. `countNonZeroRuns(series)` (exported pure fn in
  `form_4_insider.ts`) = number of maximal runs of consecutive `>0` values in the
  chronologically-ordered finite baseline (a 30d plateau → 1 event). Plumbed as
  `effectiveEvents` on `EmpiricalExceedanceResult` + `Form4InsiderFlaggedSector`.
- **The floor:** `EVENT_FLOOR = Math.ceil(1 / FORM_4_EXCEEDANCE_ALPHA)` = **20** — the
  α-derived representability minimum (an α-tail needs ≥⌈1/α⌉ independent observations:
  `1/(k+1) ≤ α ⇔ k ≥ 1/α−1`). Derived from α; **zero new free parameters**. Guard:
  `value invalid OR n < MIN_Z_BASELINE OR effectiveEvents < EVENT_FLOOR`. The old
  day-floor `m ≥ ⌈α(n+1)⌉` is REMOVED.
- **UNCHANGED (regression-checked by Critic):** `FORM_4_EXCEEDANCE_ALPHA=0.05`,
  `MIN_Z_BASELINE=30`, the exceedance `p=(#{r_i≥today}+1)/(n+1)`, `zEmp=max(0,
  invNormCDF(1−p))` + the `p===1` short-circuit, the `p≤α` firing test, buy/sell
  symmetry. `effectiveSample` (non-zero days) RETAINED as a diagnostic field only (no
  longer gates). `computeZ`/`flagForm4Cluster`/`FORM_4_CLUSTER_Z_THRESHOLD` stay
  `@deprecated`.
- **Storage = NO DDL:** `effectiveEvents` rides in the schemaless `flagged_sectors_json`
  / `flagged_sell_sectors_json`; `max_aggregate_z[_sell]` columns reused (now null when
  suppressed). Version tag disambiguates (ADR-051 D8).
- **Chronological baseline order is now LOAD-BEARING** (the run-count needs it; ADR-053's
  mean/exceedance were order-invariant). Repository `[...panelDays.keys()].sort()`
  ascending is the pinned contract (convention test `POPSEC-F4-ORDER`).
- **Coverage-gap simplification:** the baseline array is compacted (gap days skipped), so
  two non-zero days across a calendar gap are array-adjacent and merge into one event —
  UNDER-counts events → stricter guard → conservative/safe. Calendar-aware run-breaking
  deferred (OQ-C37-1).
- **Firing-run de-dup (manifestation A) OUT of scope** — moot at current coverage
  (nothing fires); a consumer/Phase-B concern (OQ-C37-2).

### Verification (the real story — [HEALTH] discipline)
- All 98 rows `form_4_insider_v4`. buy/sell firing **24/27 → 0/0**. Rows with non-null
  `max_aggregate_z` / `max_aggregate_z_sell` = **0 / 0**. Flagged-sector lists empty
  everywhere. → every sector guard-suppressed → `under_review`. The D3 a-priori
  prediction (stated in ADR-054 BEFORE measuring) held exactly.
- UI: `/api/form-4-insider?lookbackDays=120` → HTTP 200, `compositeVersion=
  form_4_insider_v4`, `verdict=under_review`, both flags false, maxZ null, 0 flagged
  sectors, **no NaN/Infinity**, all 85 history rows `under_review`. `sellClusterTickers=9`
  = the untouched per-ticker layer (correct).
- Per-ticker layer untouched: re-backfill reports Σ insiderClusterBuyFlag ticker-days=32,
  sell=1183 (the per-ticker cluster flags, computed exactly as v3 — ADR-054 only touched
  the AGGREGATE guard).

**Carry-overs:** ADR-052 D1-D7; ADR-053 (all D1-D6); S96-145/146/160/161/162/163;
S96-148/149; S96-1..S96-144; all prior s73-s95 lock-ins. ADR-050 (CBOE), ADR-051
(Phase-B harness + D8 version-pin).

---

## Open questions

### RESOLVED this session
- **OQ-C36-1 (event-run autocorrelation)** — RESOLVED by ADR-054 (count events not days).
- **OQ-C36-2 ("under review" intent vs guard reality)** — RESOLVED by construction (the
  event floor now suppresses all sectors → `under_review`, as ADR-053 intended).

### NEW this session (opened by ADR-054)
- **OQ-C37-1 / calendar-aware run-breaking** — the event count runs on the COMPACTED
  baseline array (coverage-gap days skipped), so two non-zero days across a real calendar
  gap merge into one event. Conservative as-is (under-counts → stricter). Refine to split
  runs on a calendar gap > 1 admitted day if a gap-straddling merge ever materially
  changes a verdict. Low priority while everything is suppressed anyway.
- **OQ-C37-2 / firing-run de-duplication (fire-on-onset)** — when the aggregate DOES fire
  (post-coverage), it will fire for a RUN of consecutive days on one event. De-dup to
  one-signal-per-onset is a consumer/Phase-B-harness concern (`loadHistory` already
  exposes per-day flags). Moot until coverage permits firing. Design a-priori (anti-shop).
- **OQ-C37-3 / per-sector tails may be structurally under-powered** — insider cluster
  events are infrequent per sector; even post-D7 a sector may have < 20 distinct events,
  so the per-sector empirical α-tail stays unresolvable → permanent `under_review`. Does
  the form_4 Phase-B aggregate need **sector pooling**, a longer baseline, or a different
  construct? A form_4 Phase-B SPEC question. **This is the key forward question for the
  form_4 aggregate.**

### STILL OPEN (carried)
- **OQ-052-3** — do `schedule_13d_g`/`eight_k`/`executive_departure`/`short_interest`
  share the provenance pattern AND the sparse-rate z-invalidity AND the event-run
  autocorrelation? Same structure in principle (all z/exceedance-on-cluster-rate over a
  rolling window); tables empty today; re-evaluate per composite when each ingest runs.
  ADR-052 + ADR-053 + **ADR-054** precedents all apply.
- **OQ-052-1** (D2 coverage-floor `EDGAR_COVERAGE_FLOOR=500`, window 30) — RESOLVED in
  code; re-document in the form_4 Phase-B SPEC when drafted.
- **OQ-052-2** (D6 readiness-gate N/G) — pin in the Phase-B SPEC.
- **CARRIED:** OQ-C31-4 (`INSERT…SELECT FROM <self>` no-ops — I used JSONEachRow for the
  quarantine re-version, NOT INSERT…SELECT), OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3,
  OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1.

---

## Next stage

### Default on `continue` — pick the highest-leverage of these (orchestration's call)
The form_4 aggregate STATISTIC (ADR-053) + GUARD (ADR-054) are now both correct, and the
aggregate honestly reads `under_review` everywhere. The form_4 aggregate is blocked on
DATA (D7 coverage) + a STRUCTURAL question (OQ-C37-3, per-sector power). Options, roughly
ordered:

1. **OQ-C37-3 / form_4 Phase-B aggregate construct (RESEARCH).** The most material
   forward question: with per-sector cluster events so rare that even post-D7 a sector
   may lack 20 distinct events, does the aggregate need **sector pooling** (pool the
   cross-section into one daily "fraction of S&P-500 sectors clustering" rate with a
   pooled baseline), a different unit, or a longer baseline? This determines whether the
   form_4 aggregate is EVER Phase-B-viable. Design a-priori (anti-shopping). Pairs with
   drafting `docs/specs/phase-b-form_4_v1.md`. **Recommended next.**
2. **D7 EDGAR gap backfill** (operator-paced; FYI item). Free but throttled — pace it.
   Lengthens the baseline; necessary-but-maybe-not-sufficient for the aggregate (see
   OQ-C37-3). Independent of #1's research.
3. **Apply the ADR-052/053/054 precedents to another EDGAR/FINRA composite** once its
   ingest has run (OQ-052-3). The three-layer pattern (provenance → valid statistic →
   event-level effective sample) is now a reusable template for any z/exceedance-on-
   rolling-cluster-rate composite.
4. **Resume a deferred reconciliation gap** (GAP-16 sentinels; GAP-13 Quartz doc; GAP-10
   CI/CD).

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `3b78379` | `src/server/form_4_insider.ts`, `form_4_insider_repository.ts`, `form_4_dashboard.ts`, `src/components/composite/descriptors.ts`, `src/server/operator_brief.ts`, `operator_brief_render.ts`, `scripts/tests/{form4Insider,form4InsiderRepository,compositeForm4Dashboard,operatorBrief,operatorBriefRender}.test.ts`, `docs/specs/adr-054-...md`. |
| (this commit) | `.claude/HANDOFF.md`. |

CH side-effects (not git): 98 `form_4_insider_snapshots` → v4; `health_quarantine`
ADR-052/053/054 row re-versioned. No DDL. tsc baseline 13 (all `scripts/_*.ts`).

### Form 4 pipeline (current state post-merge)
- **Composite (pure):** `src/server/form_4_insider.ts` — `FORM_4_INSIDER_COMPOSITE_VERSION
  = 'form_4_insider_v4'`; `computeEmpiricalExceedance` (statistic + event-guard);
  `countNonZeroRuns` (the new event counter); `EVENT_FLOOR=⌈1/α⌉=20`;
  `FORM_4_EXCEEDANCE_ALPHA=0.05`; `MIN_Z_BASELINE=30`. Per-ticker layer UNCHANGED.
  `computeZ` + `flagForm4Cluster` + `FORM_4_CLUSTER_Z_THRESHOLD` = `@deprecated`
  dead-but-tested.
- **Repository (I/O):** `form_4_insider_repository.ts` — `populateSectorsForCycle`
  UNCHANGED in logic; baseline ascending order now a pinned contract (`POPSEC-F4-ORDER`).
  `readEdgarPsDailyVolume`, `computeEdgarCoverageAdmittedDays`, `EDGAR_COVERAGE_FLOOR=500`,
  `EDGAR_COVERAGE_WINDOW_DAYS=30`, `BASELINE_CALENDAR_DAYS=730` unchanged.
- **Backfill:** `scripts/_backfill_form_4_insider_snapshots.ts` — `--apply` re-run
  (default window 2026-01-02→today; 98 days; ~79s). Re-run after any future composite change.
- **Pattern (three layers, reusable):** ADR-051 = Phase-B harness; ADR-052 = provenance;
  ADR-053 = statistic; **ADR-054 = event-level effective sample (autocorrelation)**.

### Key CH facts (unchanged from Cycle 36 unless noted)
- `insider_trades` ~296k rows; EDGAR P/S active-days ≈ 124 (7 in May-2024, 18-month gap,
  ~117 continuous Dec-2025→May-2026).
- `form_4_insider_snapshots`: 98 rows, ALL `form_4_insider_v4` now; max_aggregate_z[_sell]
  **null on every row** (all sectors guard-suppressed; ADR-054). **0 buy + 0 sell firing
  days** (was 24/27 under v3). Per-ticker layer unchanged.
- `health_quarantine`: 3 rows; form_4 row `accepted-as-warning`,
  `category='sparse-rate-aggregate-under-review'`, `adr_ref='ADR-052,ADR-053,ADR-054'`,
  `cycle_ref='s96 #34 Cycle 37'`.

### DB-state (session-start health:check, UNCHANGED at session end: fresh=3 stale=0
very-stale=12 missing=1 empty=9; migrations 20/20 — no NEW Tier-2 introduced this cycle)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron); operator-cadence `daemon:daily`.
- 9 empty + 1 missing = never-run EDGAR/FINRA ingests; intended empty-states.

---

## Watch-outs

### NEW / re-confirmed this session — READ THESE
- **The form_4 aggregate now FIRES ON ZERO DAYS, and that is CORRECT.** Every sector is
  guard-suppressed because no sector has ≥20 distinct independent cluster events in its
  EDGAR-only baseline. The dashboard `under_review` everywhere is the honest "not enough
  independent events to calibrate a 5% tail" — NOT a bug, NOT a regression. Do NOT "fix"
  it by lowering EVENT_FLOOR (that is anti-shopping — the floor is the α-derived
  representability limit). The aggregate becomes informative only when coverage (D7) +
  the construct question (OQ-C37-3) deliver ≥20 events.
- **Do NOT tune `EVENT_FLOOR` / α to make the aggregate fire.** Pinned a-priori (AFML
  §11.4 anti-shopping). `EVENT_FLOOR = Math.ceil(1/FORM_4_EXCEEDANCE_ALPHA)` — a constants
  test pins both the derivation AND the value 20. Any change to firing behavior must come
  from a NEW a-priori design decision (OQ-C37-3), documented in an ADR.
- **Chronological baseline order is LOAD-BEARING (ADR-054).** `countNonZeroRuns` runs over
  the ordered series; a regression that reordered `baseline2y`/`baseline2ySell` would
  corrupt the event count. Pinned by `POPSEC-F4-ORDER`. The repository's
  `[...panelDays.keys()].sort()` ascending is the contract.
- **`effectiveSample` (non-zero days) is now DIAGNOSTIC ONLY** — it no longer gates
  validity (`effectiveEvents` does). A reader/consumer that gates on `effectiveSample`
  would resurrect the OQ-C36-1 autocorrelation under-protection.
- **`loadLatestSnapshot` casts `flagged_sectors_json` without validation** — a pre-v4 (v3)
  JSON row deserializes with `effectiveEvents: undefined`. Read-only/forensic; the v4
  re-backfill rewrote all rows, so no live break. Same pattern as v2→v3.
- **`bash` ≠ PowerShell here-strings.** `git commit -m @'...'@` via the Bash tool inserts
  literal `@`s. Used `git commit -F <file>` this cycle (clean). The quarantine re-version
  used a temp JSON file + `curl --data-binary @file` to a `?query=INSERT…FORMAT
  JSONEachRow` URL (avoids INSERT…SELECT-from-self no-op, OQ-C31-4).
- **This cycle did NOT use `isolation:"worktree"`** — single Composite worker in the MAIN
  checkout (Cycle-36 precedent; avoids the Cycle-35 stale-base hazard, full `git diff`
  visibility, clean revert). No orphan worktrees.

### Carried (still load-bearing)
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory`.
- **Finnhub `person_cik` is a name-hash (S96-145)** — unfit for cluster-distinctness;
  demoted from the cluster path (ADR-052 D1).
- **`accepted_at` (NOT `transaction_date`) is the load-bearing anti-leak anchor** (F4-10).
- **D5/ReplacingMergeTree:** `form_4_insider_snapshots ORDER BY snapshot_date` → a future
  re-backfill REPLACES rows (not preserves). Audit trail = quarantine + ADRs + git, not the
  snapshots table. Do NOT rebuild the table engine (destructive, operator-gated).
- **Dev server** does NOT hot-reload server edits — restart after `*_dashboard.ts`/`server.ts`.
- All prior watch-outs preserved (EDGAR/FINRA per-IP throttle; gics PIT-anchor; CH-Date
  range; sp500 PIT gap-window; executive_departure dedupe key).

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot (engine often needs ~5-40s):
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse                 # loop until healthy
curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"
# Dev server (visual validation):
npm run dev                                      # http://localhost:3000/#/form-4-insider ; data = /api/form-4-insider
# Form4 tests + tsc (the slice's gate):
node --import tsx --test scripts/tests/form4Insider.test.ts scripts/tests/form4InsiderRepository.test.ts scripts/tests/compositeForm4Dashboard.test.ts scripts/tests/operatorBrief.test.ts scripts/tests/operatorBriefRender.test.ts
npx tsc --noEmit                                 # 13 baseline (all scripts/_*.ts)
# Re-backfill after a composite change:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply   # ~79s, 98 days
# health:
npm run health:check
```

---

## For the next session — priority order

**ADR-054 is DONE (ratified + merged `3b78379` + v4 backfill + verified + UI-validated).**
OQ-C36-1 + OQ-C36-2 are RESOLVED. The form_4 aggregate's statistic AND guard are now both
correct; the aggregate honestly reads `under_review` everywhere (0 firing days, all
sectors below the 20-event floor). The real remaining form_4 work is the STRUCTURAL
question **OQ-C37-3** (per-sector tails are likely under-powered even post-D7 → does the
aggregate need sector pooling / a different construct?) + **D7** coverage. On `continue`,
the recommended default is to RESEARCH OQ-C37-3 (a-priori) and draft
`docs/specs/phase-b-form_4_v1.md` — this decides whether the form_4 aggregate is ever
Phase-B-viable. Alternatives: kick off the operator-paced D7 backfill, apply the
ADR-052/053/054 three-layer precedent to another EDGAR/FINRA composite (OQ-052-3), or
resume a deferred reconciliation gap.

**Do NOT auto-open without operator green-light:** Phase C promotion (Q-8); ALTER
DROP/DELETE; `git push` (Q-4 — ~128 commits); real-money path. **Do NOT tune EVENT_FLOOR /
α to a desired firing outcome** (anti-shopping).

---

## Important framing for the next chat

**Cycle 37 closed the loop OQ-C36-1 opened — and again refused to overclaim.** ADR-053
(Cycle 36) fixed the per-VALUE σ fabrication (14.18→2.33); ADR-054 (this cycle) fixed the
GUARD that decided which sectors were trustworthy — it had been counting autocorrelated
days (~30 per event) as if independent, so single-event plateaus passed the floor and
fired. Counting distinct EVENTS (AFML Ch.4 concurrency) with an α-derived floor of 20
collapsed firing 24/27 → 0/0 and put every sector in the honest `under_review` state
ADR-053 originally intended. The verification measured the live table, confirmed the
a-priori prediction held, UI-validated the panel (HTTP 200, no NaN, under_review), and
**declined to mark the quarantine `corrected`** — because a correctly-suppressed signal is
honest, not yet trustworthy. The form_4 aggregate's three-layer fix is now complete at the
methodology level (provenance ADR-052 → statistic ADR-053 → effective-sample ADR-054) but
the signal remains blocked on DATA (D7) and a STRUCTURAL question (OQ-C37-3: per-sector
cluster events may simply be too rare to ever calibrate a per-sector 5% tail — the next
real research question). The per-ticker insider layer (EDGAR-canonical counts + cluster
flags) is usable today; the aggregate is not, and won't be claimed as such until D7 +
OQ-C37-3 land. **UI coverage unchanged = 10 live panels.** No new panel this cycle.
