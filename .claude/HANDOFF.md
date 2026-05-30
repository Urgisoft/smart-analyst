# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #37 — **Cycle 40: EDGAR + FINRA ingests REPAIRED → 3 of 4
empty composites POPULATED (all 4 EDGAR/FINRA ingests now repaired — 13D/G fix merged `767901f`);
historical backfills RUNNING in background + a 30-min watchdog cron (`ad36d490`).**) This cycle began the operator-directed **completion phase**
(validate/complete EVERYTHING → THEN human-readable UI layer → THEN live trading, dead last — strict
order, saved to memory `project-phase-ordering-completion-ui-live`). Found that the "empty" Layer-0
composites were not empty by accident — they were silently broken: FINRA's download endpoint had
moved (404); a shared EDGAR helper bug 404'd every 8-K body-fetch. Both repaired (free sources, no
auth, no paid). All four now populate — the fourth (13D/G) was a separate FTS-token bug, also fixed +
merged (`767901f`). Historical backfills launched to give Phase B a real window. **NEXT on `continue`:**
see "Next stage" — resume the backfills + watchdog if the session died, then move populated composites
toward validation.

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container. On reboot:
1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. `docker start quantlab-clickhouse`; wait `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse` = `healthy`.
3. Verify: `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
   (This session: CH up + healthy throughout.)

**Dev server:** `npm run dev` → http://localhost:3000 (not hot-reloading; restart after server edits). NOT running now.

### ⚠️⚠️ BACKGROUND BACKFILLS + WATCHDOG DIE ON `/clear` — RESUME THEM FIRST
Cycle 40 launched three historical backfills as **background bash** + a **session-only cron watchdog**
(`ad36d490`, every 30 min). **All of these are DEAD if this chat was `/clear`ed or Claude was closed.**
They are idempotent + resumable. On `continue`, FIRST:
1. Check liveness: `tasklist | grep -ic python` (0 = dead). Check progress:
   `cat logs/backfill_finra_short_interest.progress`, `cat logs/backfill_exec-departure.progress`,
   `cat logs/backfill_8k-event.progress` (one line per completed month; look for `=== ... COMPLETE ===` in the `.log`).
2. If dead and NOT complete, RELAUNCH in background (skips done months via `.progress`):
   - `bash scripts/_backfill_finra_short_interest.sh 2020-01`
   - `bash scripts/_backfill_edgar_monthly.sh exec-departure 2021-01`
   - `bash scripts/_backfill_edgar_monthly.sh 8k-event 2019-01`  ← only AFTER exec-departure COMPLETE (shared EDGAR rate limit)
   - `bash scripts/_backfill_edgar_monthly.sh 13d-g 2020-01`  ← only AFTER 8k-event COMPLETE (same shared EDGAR rate limit)
3. RE-CREATE the watchdog: re-run the `loop` skill — `/loop 30m <the watchdog prompt>` (the prompt is
   in CronCreate job `ad36d490`; reproduced in "Files / code state"). It is session-only by design.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every routine decision
is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) — reaffirmed s96 #37: NO live trading until everything validated/bug-free |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~140** unpushed commits to origin/main | Carry-over (+6 this session: `4872430`, `72a5978`, `defbccf`, `59bc1ee`, `767901f`, `c01c8e0` + this HANDOFF) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary BROKEN (Yahoo `get_shares_full` empty for all 21 ETFs) | s96 #17/+ | **OPEN — orchestration plan set:** replace the dead Yahoo aggregator with **issuer-direct** daily shares-outstanding feeds (iShares cash-flows CSV, ProShares downloads, Vanguard/Invesco) — same free no-auth posture as the working SSGA secondary. Queued behind the current backfills. NOT a paid-data item. |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

---

## What this session delivered (s96 #37 — Cycle 40)

| Commit / action | Slice |
| --- | --- |
| `4872430` | **EDGAR body-fetch 404 fix.** Shared helper `parse_edgar_search_response` fell back to a non-existent `primary.htm` → every 8-K body-fetch 404'd → `executive_departures` empty. Generalized form4's index.json resolution into `_sec_edgar_helpers.discover_primary_doc_url` + `select_primary_html_from_directory`. + UTF-8 stdio fix (cp1252 `→` crash). 5 files, +410/−6. Data-Ingest worker + orchestrator gate (85/85 helper+form4 tests; form4 untouched; tsc 13). |
| `72a5978` | **FINRA scraper repair.** Dead bulk-CSV URL → free anonymous DAPI `POST api.finra.org/data/group/otcMarket/name/consolidatedShortInterest`. Caught a 5,000-row server-cap truncation trap (naive request lost ~77%). Maps onto existing `short_interest` schema (no DDL). 2 files, +837/−123. 39 py tests + 9/9 daemon-wrapper TS. |
| `defbccf` | **Backfill drivers** `_backfill_finra_short_interest.sh` + `_backfill_edgar_monthly.sh` (resumable backward month-loop, idempotent). |
| (background, RUNNING) | FINRA backfill 2020-01..now; EDGAR exec-departure 2021-01..now THEN 8k-event 2019-01..now (sequential). |
| (cron `ad36d490`) | 30-min watchdog (session-only): checks/resumes backfills, fixes Tier-1 ingest bugs, reports. |
| (worker IN FLIGHT) | Schedule-13D/G query-bug fix (worktree-isolated). |
| (memory) | `project-phase-ordering-completion-ui-live` saved (completion → UI → live, strict). |
| (this commit) | This HANDOFF rewrite. |

Method: session-start `health:check` (clean — 12 very-stale = known daemon-lag GAP-9; the never-populated
EDGAR/FINRA composites were the completion-phase target). Dry-run-then-apply-then-validate per source surfaced
the silent breakages (a dry-run looked healthy; only `--apply` revealed the body-fetch 404s — the "validate,
don't just ingest" discipline). Two Data-Ingest workers (FINRA + EDGAR) + orchestrator critic/gate, both
ff-merged after independent tsc/test gates. A third worker (13D/G) is in flight.

---

## Decisions locked in

### s96 #37 Cycle 40 — completion phase started; 3 composites repaired
- **Operator phase order (strict):** (1) validate/complete EVERYTHING — source-RELIABILITY validation
  (not just "free + parses") + calc-correctness + Phase B + correct/latest/auto-ingested + bug-free; (2)
  human-readable UI layer, handed to Opus with operator's specific confusions; (3) live trading dead last.
  During completion, verdicts are reported in **plain-language chat**, NOT a built UI (operator overrode
  building a "readable verdict" UI early). Saved to memory.
- **EDGAR body-fetch is now robust** via `discover_primary_doc_url` (index.json resolution). 8k-event +
  13d-g were confirmed to NOT body-fetch (FTS-envelope only) so were never hit by the 404 bug — the helper
  fix future-proofs any new body-fetching caller. Form4 keeps its own (frozen) resolver.
- **FINRA short interest source = the free DAPI** (`api.finra.org/.../consolidatedShortInterest`), POST
  with `dateRangeFilters` on `settlementDate`, paged in 5,000-row steps (server hard-caps). No auth, no key.
- **ETF v1 (Q-6) decision:** the Yahoo `get_shares_full` regression is persistent; replace it with
  **issuer-direct** daily shares-outstanding feeds (authoritative source — the bug is a nudge to fix a
  fragile aggregator dependency). Queued behind the current backfills. Free, no auth.

**Carry-overs:** form_4_insider_v5 (ADR-055 pooled) shipped Cycle 39, pooled buy events=8 < 20 floor →
still `under_review` (the form4 D7 data gap was CLOSED via bulk Form345 — `insider_trades`=787,869; pooled
still short of the 20-event floor — OQ-C38-1 ANSWERED: not Phase-B-viable yet, see OQ-C38-2). ADR-052/053/054/055
four-layer template; ADR-050/051; all prior s73-s96 lock-ins.

---

## Open questions

### Cycle 40
- **OQ-C40-1 — do the populated composites reach a usable Phase-B window after backfill?** FINRA short
  interest needs ≥2y; exec-departure/8k-event likewise. MEASURE when backfills complete (watchdog reports).
- **OQ-C40-2 — Schedule 13D/G retrieval path.** EDGAR FTS returns 0 hits for `SC 13D/G` form tokens; the
  in-flight worker is determining the correct free path (FTS token fix vs submissions API vs full-index).
- **OQ-C40-3 — backfill depth.** Launched from 2020/2021/2019; for full window parity (2013-2026, matching
  the other Layer-0 composites) extend the drivers' START_YM further back once the first pass lands.

### Carried (form_4)
- **OQ-C38-2** — multi-year EDGAR backfill for form_4 pooled events to clear 20 (currently 8). Free + throttled.
- OQ-C37-1/2, OQ-052-3 (four-layer template applies to schedule_13d_g / eight_k / executive_departure /
  short_interest once populated — NOW being populated), and all prior carried OQs.

---

## Next stage

### Default on `continue` — orchestration's call
0. **FIRST: resume the backfills + watchdog if the session died** (see Restart-recovery ⚠️).
1. **Schedule-13D/G fix is MERGED** (`767901f`, FTS token `SCHEDULE 13D`→normalize→`SC 13D`, 76 rows).
   Its deep backfill runs via the watchdog EDGAR chain (`13d-g`, after 8k-event). Nothing to merge here.
2. **Let the backfills finish** (watchdog auto-reports/resumes). When COMPLETE, measure the available history
   window per composite (OQ-C40-1) and report in plain language.
3. **Then begin VALIDATION** of the now-populated composites: calc-correctness checks → Phase B deflation
   campaigns (DSR/PBO/HLZ per AFML §11 / Bailey-LdP 2014 / Harvey-Liu-Zhu 2016, offline, orchestration-owned).
   Phase B can reject — report honestly.
4. **ETF v1 issuer-direct rebuild** (Q-6) — queued; pick up after the EDGAR/FINRA set is validated, OR sooner
   if the backfills are idle.
5. Deeper backfill (OQ-C40-3 / OQ-C38-2) for full 2013-2026 window parity.

**Do NOT:** lower EVENT_FLOOR/α/PBO-DSR gates to force a verdict (anti-shopping); build the human-readable UI
layer yet (operator: after completion); auto-open Phase C (Q-8); `git push` (Q-4); touch real-money path.

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
- `4872430` — `scripts/_sec_edgar_helpers.py`, `scripts/sec_edgar_8k_item_5_02_ingest.py`,
  `scripts/sec_edgar_8k_event_ingest.py`, `scripts/sec_edgar_13d_g_ingest.py`, `scripts/tests/test_sec_edgar_helpers.py`.
- `72a5978` — `scripts/finra_short_interest_ingest.py`, `scripts/tests/test_finra_short_interest_ingest.py`.
- `defbccf` — `scripts/_backfill_edgar_monthly.sh`, `scripts/_backfill_finra_short_interest.sh` (NEW).
- (pending) 13D/G worker merge + this HANDOFF.

### Backfill / watchdog operational state
- **Drivers:** `scripts/_backfill_edgar_monthly.sh <exec-departure|8k-event> [START_YM]`,
  `scripts/_backfill_finra_short_interest.sh [START_YM]`. Logs `logs/backfill_*.log`, progress
  `logs/backfill_*.progress` (both gitignored). Backward month-loop; idempotent (ReplacingMergeTree).
- **Watchdog cron `ad36d490`** (session-only, every 30 min). Its prompt: check the three `.progress`/`.log`
  + CH row counts; classify PROGRESSING/COMPLETE/STUCK; resume dead drivers; fix Tier-1 ingest bugs (worker
  if >1-liner), flag correctness issues; report one line each; CronDelete when all COMPLETE. Re-create with
  the `loop` skill after a `/clear`.

### Live CH row counts (Cycle 40, mid-backfill — GROWING)
- `short_interest` = ~688k+ and climbing (FINRA, back to ~2025-01 and going to 2020).
- `executive_departures` = 32+ (exec-departure, ~3-4 months in, going to 2021).
- `eight_k_events` = 45 (8k-event backfill not started yet — waits for exec-departure).
- `schedule_13d_g_filings` = 76 (FTS-token fix MERGED `767901f`; recent-window only — needs backfill via watchdog chain `13d-g`).
- `insider_trades` = 787,869 (form_4, from Cycle 39 bulk Form345 — unchanged this cycle).

### CLIs (for backfill/driver edits)
- `finra_short_interest_ingest.py`: `--settlement-date YYYY-MM-DD --apply` (auto-discovers latest if omitted;
  `--from-file`, `--url` overrides). **Note:** prints "FATAL refusing to write empty settlement" + exits
  non-zero for a non-settlement date — HARMLESS in the driver (it continues to the next candidate); a
  follow-up could make no-data a clean skip rather than FATAL.
- `sec_edgar_8k_item_5_02_ingest.py` (exec-departure) + `sec_edgar_8k_event_ingest.py`: `--start-date --end-date --apply` (+ `--snapshot-date`, `--items`).
- `sec_edgar_13d_g_ingest.py`: being fixed by the worker.

### Health (session-start health:check — no new Tier-2)
- 12 very-stale = dev-box daemon-lag (GAP-9, no cron). The completion-phase work is reducing the
  never-populated set (was 9 empty + 1 missing; now short_interest table exists + 3 composites populating).

---

## Watch-outs

### NEW this cycle — READ THESE
- **Backfills + watchdog are session-bound — they die on `/clear`/close.** Idempotent + resumable; see
  Restart-recovery ⚠️. EDGAR transient HTTP 429/500 during runs are NORMAL (helper retries 5× w/ backoff).
- **`populated` ≠ `validated`.** The repaired composites have data but the backfills only just started; a
  usable Phase-B window needs ≥2y. Do NOT treat "3 composites populated" as "ready" — the validation ladder
  (calc-correctness → Phase B) is still ahead and Phase B can reject.
- **A dry-run can lie.** exec-departure's dry-run reported "parsed 99 filings" while `--apply` 404'd on every
  body-fetch and wrote 0 rows. ALWAYS verify rows actually land + sanity-check, not just "ingest ran."
- **Two EDGAR backfills must NOT run concurrently** (shared per-IP 10rps limit) — the driver launch serializes
  them (`exec-departure ; 8k-event`). FINRA is a different host (parallel-safe).
- **Worktree merges:** workers leave changes UNCOMMITTED in the worktree (verified twice this cycle). The
  orchestrator brings the diff to main via `git diff main > patch; git apply`, gates (tests+tsc), commits.
  Worktrees lock under the agent pid → `git worktree remove --force` + `git branch -D` + `git worktree prune`.
- **Cosmetic:** `executive_departures.filing_url` stores the original `primary.htm` sentinel (resolved URL
  used for fetch, not written back). Composite reads cik/accession/sub_item/ticker — harmless.

### Carried (still load-bearing)
- form_4: pooled `effectiveEvents` (runs) gates validity, NOT `effectiveSample` (days); chronological baseline
  order LOAD-BEARING; per-sector flags INFORMATIONAL post-v5; `decodeFlaggedJson` handles `{sectors,pooled}`
  wrapper + legacy. `accepted_at` (not `transaction_date`) is the anti-leak anchor.
- S96-149 alias-shadowing — subquery-around-FINAL for every composite `loadHistory`.
- EDGAR/FINRA per-IP throttle; gics PIT-anchor; CH-Date range; sp500 PIT gap-window; D5/ReplacingMergeTree
  re-backfill REPLACES rows. `bash` ≠ PowerShell here-strings (use `git commit -F -`). Dev server no hot-reload.

---

## For the next session — priority order

Cycle 40 began the **completion phase**: repaired the silently-broken EDGAR + FINRA ingests (free sources, no
auth), populated 3 of 4 empty Layer-0 composites, and launched resumable historical backfills under a 30-min
watchdog. On `continue`: **(0) resume backfills + watchdog if the session died** (Restart-recovery ⚠️);
**(1) merge the 13D/G fix worker; (2) let backfills finish + measure the window; (3) begin validation →
Phase B** (which can reject — report honestly). The ETF v1 issuer-direct rebuild (Q-6) is queued.

**Do NOT auto-open without operator green-light:** the human-readable UI layer (comes AFTER completion per
the locked phase order); Phase C promotion (Q-8); `git push` (Q-4, ~138 commits); real-money path. **Do NOT
tune EVENT_FLOOR/α/PBO-DSR to a desired outcome** (anti-shopping). **Do NOT build pretty UI on unvalidated data.**
