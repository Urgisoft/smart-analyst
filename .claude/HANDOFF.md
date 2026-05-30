# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #36 — **Cycle 39: form_4_insider_v5 SHIPPED (ADR-055 pooled
construct, OQ-C37-3 IMPLEMENTED) + D7 full-market EDGAR backfill LAUNCHED (running in background).**
Two things happened this cycle. (1) The ADR-055 cross-sectional pooled construct is now IN CODE +
merged + UI-validated: `form_4_insider_v5` replaces the max-over-11-sectors gating with one
index-level pooled statistic `pooledRate = Σ clusterTickers / Σ sectorSize`, fed through the SAME
ADR-053 exceedance + ADR-054 event-floor guard VERBATIM (zero new params); per-sector demoted to
informational; NO DDL (pooled metadata rides in a `{sectors,pooled}` JSON wrapper). 451/451 tests,
tsc 13 baseline, Composite-worker + Critic AUTO-APPROVE, ff-merged `4e425e8`. The pre-D7 re-backfill
confirmed the honest state: pooled buy `effectiveEvents=3` (< 20) → `under_review`, exactly as
ADR-055 predicted. (2) **A [HEALTH] correction to D7's scope:** the 2024-07…2025-11 "gap" is NOT
empty — it was SP500-FILTERED-ingested (Cycle 32 OQ-C32-1), so its P/S volume sits below the ADR-052
D2 coverage floor (500/30d) and those days are NOT admitted. D7 therefore needs a **full-market**
re-ingest (~200k body-fetches, ~15-25h throttled), not a thin gap-fill. That backfill is **RUNNING
in the background now** (driver `scripts/_d7_form4_backfill_driver.sh`, backward month-loop
2025-11→2024-07). NEXT on `continue`: see "Next stage" — the headline is **when the backfill
finishes, re-backfill v5 snapshots + measure pooled `effectiveEvents` to resolve OQ-C38-1.**

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker Desktop. On reboot:
1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll engine up: loop `docker version`; then `docker start quantlab-clickhouse`; wait
   `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse` = `healthy` (~10-40s).
3. Verify: `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
   (This session: CH was up + healthy at start.)

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT hot-reloading; restart
after server-side edits. Started + used for v5 UI validation this cycle, then STOPPED (clean state).
Form 4 panel: `/#/form-4-insider`; data route `/api/form-4-insider` (now reports
`compositeVersion: form_4_insider_v5`, `verdict: under_review`).

### ⚠️ A LONG-RUNNING BACKGROUND BACKFILL MAY BE ORPHANED
The D7 full-market EDGAR backfill was launched this session as a background process. **If this chat
was `/clear`ed, that process is dead** (background bash does not survive a new session). On `continue`:
1. Check progress: `cat logs/d7_form4_backfill.progress` (one line per COMPLETED month) +
   `tail -20 logs/d7_form4_backfill.log` (look for `D7 backfill COMPLETE`).
2. Check rows landed: `curl -s ".../insider_trades" --data-binary "SELECT count() FROM quantlab.insider_trades"`
   (before-anchor = **296219**; grows as months complete).
3. **If not COMPLETE: resume** — open `scripts/_d7_form4_backfill_driver.sh`, delete the months already
   listed in `.progress` from the `months=(...)` array, then re-launch `bash scripts/_d7_form4_backfill_driver.sh`
   (run it in the background; idempotent — re-running a month is safe but wastes fetches).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every routine
decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~133** unpushed commits to origin/main | Carry-over (+2 this session: `4e425e8` v5 + `afab02e` driver, + the HANDOFF commit) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (orchestration-owned, operator-PACED / for awareness — NOT queue items):**
- **ADR-052 D7 — EDGAR Form 4 full-market backfill (2024-07…2025-11).** Free source, throttled
  (10rps). **NOW RUNNING in the background** (this session). [HEALTH] correction this cycle: D7 is a
  **full-market** re-ingest, not a thin gap-fill — the gap window was previously SP500-filtered
  (Cycle 32) and falls below the coverage floor. Still NOT real-money. The GATE for form_4 aggregate
  viability (OQ-C38-1).
- **form_4_insider_v5 — SHIPPED this cycle** (ADR-055 pooled construct; calc-construct logic →
  operator-VISIBLE per ADR-044, orchestration owns the decision; HLZ/AFML/Aronson already Tier-1 →
  NOT operator-GATED). Here for awareness.

---

## What this session delivered (s96 #36 — Cycle 39)

| Commit / action | Slice |
| --- | --- |
| `4e425e8` | **form_4_insider_v5** (ADR-055 Part A). Composite worker (worktree-isolated) + Critic AUTO-APPROVE + ff-merge. 8 files, +1056/−311. 451/451 tests (+12), tsc 13 baseline, NO DDL. |
| `afab02e` | **D7 backfill driver** `scripts/_d7_form4_backfill_driver.sh` (full-market, paced, resumable). |
| (this commit) | This HANDOFF rewrite. |
| (CH write) | v5 re-backfill: `form_4_insider_snapshots` → 98 rows `form_4_insider_v5` (PRE-D7 baseline). |
| (background) | D7 full-market EDGAR backfill LAUNCHED + running (2025-11→2024-07, backward month-loop). |

Method: session-start `health:check` (clean — matched baseline, no new Tier-2). Then a [HEALTH]
coverage-floor investigation that corrected D7's scope. Then the v5 construct via a Composite worker
+ Critic (multi-agent §3.1 — composite logic ⇒ NOT orchestrator-self-edit), ff-merged after base
verification + independent tsc/test gate. v5 re-backfill + browser UI-validation. D7 backfill driver
written + launched in parallel.

---

## Decisions locked in

### s96 #36 Cycle 39 — form_4_insider_v5 SHIPPED (ADR-055 pooled construct IMPLEMENTED)
- **`FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v5'`.** The GATED aggregate unit is now the
  index-level pooled rate `pooledRate(t) = Σ_sectors clusterTickers_s / Σ_sectors sectorSize_s`
  (issuer-weighted; **NOT** mean-of-per-sector-rates — pinned by a dedicated test using size-20/80
  sectors). Today's pooled rate is accumulated in the composite's sector loop
  (`pooledNumBuy += computeSectorClusterCount(...)`, `pooledDen += sectorSize`); the pooled baseline
  is built in `populateSectorsForCycle` per admitted day (`Σ count / Σ memberCount`, ascending
  chronological — POPSEC-F4-POOL-2). Both directions run `computeEmpiricalExceedance` + the ADR-054
  `countNonZeroRuns`/`EVENT_FLOOR=20` guard **VERBATIM**. Zero new free parameters.
- **`form4ClusterFlag`/`form4SellClusterFlag` + `maxAggregateZ[Sell]` derive from the POOLED stat**
  (no longer max-over-sectors). `maxAggregateZSector[Sell]` = literal `'S&P 500'` when the pooled
  stat is valid, else null (`POOLED_AGGREGATE_LABEL`).
- **Per-sector demoted to INFORMATIONAL (ADR-055 D2):** `flaggedSectors`/`flaggedSellSectors` still
  computed + rendered, but NON-gating (a per-sector sector clearing α does NOT fire the flag — pinned
  by the "per-sector does NOT gate" test). UI descriptor relabelled "informational — not statistically
  calibrated (ADR-055)".
- **NO DDL (ADR-055 D5):** pooled `{pooledRateT, zEmp, exceedance, effectiveEvents, effectiveSample,
  baselineSize, insufficientData}` + the per-sector list ride in the existing
  `flagged_sectors_json`/`flagged_sell_sectors_json` via a backward-compatible `{sectors, pooled}`
  wrapper. `decodeFlaggedJson` accepts wrapper OR legacy bare-array (→ pooled cold-start) OR malformed.
- **EVENT_FLOOR NOT lowered.** Measured pre-D7 pooled buy `effectiveEvents=3` < 20 → honest
  `under_review`. The proximity of 15/19 (ADR-055 probe) to 20 stays the anti-shopping trap, not an
  excuse to cut the floor.

### s96 #36 Cycle 39 — [HEALTH] D7 is a FULL-MARKET backfill, not a thin gap-fill
- The 2024-07…2025-11 window has data but it was ingested **SP500-filtered** (Cycle 32 OQ-C32-1,
  533-CIK allowlist), producing ~239–654 P/S rows/month — far below the **ADR-052 D2 coverage floor
  (500 system-wide P/S filings / trailing-30d)**. So most of those days are NOT admitted (e.g.
  Oct-2024 / Jan-2025 / Jul-2025 / Oct-2025 = 0 admitted days). The LIVE daemon ingest is full-market
  (no allowlist) — that is why 2024-01…05 and 2025-12…2026-05 clear the floor.
- **Therefore D7 = a full-market re-ingest of 2024-07…2025-11** (no `--issuer-cik-file`). Dry-run
  measured ~5,313 filings / 14d (~380/day) → ~200k body-fetches over the window → ~15-25h at the
  10rps throttle. The 500 floor is NOT lowered (anti-shopping).
- **Execution:** backward month-loop (2025-11 first) so each completed month extends the continuous
  admitted block contiguously backward from the existing Dec-2025+ coverage — partial progress is
  durable + useful. Driver `_d7_form4_backfill_driver.sh`; idempotent (ReplacingMergeTree); per-month
  `.progress` for cross-session resume.

**Carry-overs:** ADR-055 (D1-D5, now implemented); ADR-052 D1-D7; ADR-053; ADR-054; ADR-050/051;
S96-* all prior; all s73-s95 lock-ins. The form_4 four-layer template is complete in code:
ADR-052 provenance → ADR-053 valid statistic → ADR-054 event-level sample → ADR-055 cross-sectional
unit (v5).

---

## Open questions

### THE key one (measure post-backfill)
- **OQ-C38-1 — does the POOLED series reach ≥20 events after D7, and at what date?** **MEASURE when
  the backfill completes:** re-backfill v5 snapshots (`npx tsx scripts/_backfill_form_4_insider_snapshots.ts
  --apply`, ~79s) then read pooled `effectiveEvents` from `flagged_sectors_json`
  (`pooled.effectiveEvents`). PRE-D7 baseline = **3** (buy). If post-D7 ≥ 20 → form_4 aggregate is
  Phase-B-ready (Part B unblocks). If still < 20 → OQ-C38-2 (multi-year backfill). Do NOT pre-judge;
  do NOT lower the floor.

### Carried / opened
- **OQ-C38-2** — multi-year EDGAR backfill (beyond 2024-07) for Phase-B window parity (2013-2026)
  with the other 8 Layer-0 composites. Free + throttled. The driver covers 2024-07…2025-11 only; for
  full parity extend the `months=()` array further back (verify pre-2024 EDGAR FTS coverage first).
- **OQ-C37-1** (calendar-aware run-breaking — now also on the pooled series; conservative, low pri),
  **OQ-C37-2** (firing-run de-dup on the pooled series; moot until coverage permits firing).
- **OQ-052-3** — the four-layer template (ADR-052/053/054/055) now applies to `schedule_13d_g` /
  `eight_k` / `executive_departure` / `short_interest` once each ingest runs (tables empty today).
- **CARRIED:** OQ-C31-4, OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3,
  OQ-C19-1, OQ-C18-1, OQ-C17-1.

---

## Next stage

### Default on `continue` — pick the highest-leverage (orchestration's call)
1. **Finish / resume + verify the D7 backfill, then resolve OQ-C38-1 (RECOMMENDED).** Check
   `.progress` / log (see Restart-recovery ⚠️). If running, let it finish (or resume if orphaned).
   When `D7 backfill COMPLETE`: re-backfill v5 snapshots (~79s) + read pooled `effectiveEvents` per
   direction → answer "is form_4 aggregate Phase-B-viable?" honestly. **This is the whole point of the
   cycle's work.**
2. **If pooled ≥ 20 post-D7:** unblock Part B — implement `scripts/phase_b_campaign_form_4_v1.ts` per
   `docs/specs/phase-b-form_4_v1.md` Part B (the ADR-051 DSR/PBO/HLZ overlay on the pooled score;
   ECDF rescaling per S-PBF1-2, polarity-aligned). Composite/harness worker cycle.
3. **If pooled < 20 post-D7-gap:** OQ-C38-2 — extend the backfill multi-year (edit the driver's months
   array further back), then re-measure. Do NOT lower the floor.
4. **Else (independent):** apply the four-layer template to another EDGAR/FINRA composite (OQ-052-3);
   or resume a deferred reconciliation gap (GAP-13 Quartz doc; GAP-10 CI/CD). **GAP-16 sentinels is
   CLOSED** — ADR-047 (Cycle 6) decided keep/documentation-only; re-verified Cycle 39 (the `phase1_v3`
   backfill since completed, sentinel pattern stable + identical across v2/v3 at 78,399 each, 0
   content-shape violations, read-side `includeSentinels=false` guard intact). Do NOT re-investigate.

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `4e425e8` | `src/server/form_4_insider.ts`, `src/server/form_4_insider_repository.ts`, `src/components/composite/descriptors.ts`, `scripts/tests/form4Insider.test.ts`, `scripts/tests/form4InsiderRepository.test.ts`, `scripts/tests/compositeForm4Dashboard.test.ts`, `scripts/tests/operatorBrief.test.ts`, `scripts/tests/operatorBriefRender.test.ts`. |
| `afab02e` | `scripts/_d7_form4_backfill_driver.sh` (new). |
| (this commit) | `.claude/HANDOFF.md`. |

### Form 4 pipeline (current on-disk + CH state — v5 LIVE)
- **Composite (pure):** `src/server/form_4_insider.ts` — `FORM_4_INSIDER_COMPOSITE_VERSION =
  'form_4_insider_v5'`. New: `computeSectorClusterCount` (integer numerator; `computeSectorClusterRate`
  now `= count/size`, byte-identical behavior pinned); pooled reducer in `evaluateForm4InsiderComposite`;
  `pooledBaseline2y`/`pooledBaseline2ySell` top-level inputs; `pooledBuyStat`/`pooledSellStat` snapshot
  fields; `POOLED_AGGREGATE_LABEL='S&P 500'`. Statistic + guard (`computeEmpiricalExceedance`,
  `countNonZeroRuns`, `EVENT_FLOOR=20`, `MIN_Z_BASELINE=30`, α=0.05) UNCHANGED.
- **Repository (I/O):** `form_4_insider_repository.ts` — `populateSectorsForCycle` now also builds the
  pooled baseline (`PopulateSectorsResult`); `encodeFlaggedJson`/`decodeFlaggedJson` `{sectors,pooled}`
  no-DDL wrapper (legacy-compatible). `EDGAR_COVERAGE_FLOOR=500`, `EDGAR_COVERAGE_WINDOW_DAYS=30`,
  `BASELINE_CALENDAR_DAYS=730`. Chronological baseline order LOAD-BEARING (POPSEC-F4-ORDER + -POOL).
- **Backfill (snapshots):** `scripts/_backfill_form_4_insider_snapshots.ts --apply` (window
  2026-01-02→today, 98 days, ~79s). **Re-run after D7 completes** for OQ-C38-1.
- **D7 driver:** `scripts/_d7_form4_backfill_driver.sh` — full-market month-loop; log
  `logs/d7_form4_backfill.log`; progress `logs/d7_form4_backfill.progress` (both gitignored).

### Key CH facts
- `insider_trades`: **296,219 rows at session start (before-anchor)** — GROWS as the D7 backfill
  completes months. Admitted-day before-anchor: **377 total / 274 in trailing-730d** (trailing-30d
  P/S ≥ 500). Continuous full-market coverage: 2024-01…05 + 2025-12…2026-05; SP500-thin (mostly
  non-admitted): 2024-07…2025-11 (the D7 target).
- `form_4_insider_snapshots`: **98 rows `form_4_insider_v5`** (PRE-D7 baseline; + 3 pre-merge v4
  ReplacingMergeTree ghosts, harmless — latest-per-date is v5). Latest (2026-05-22): pooled buy
  `effectiveEvents=3`, `baselineSize=203`, `pooledRateT=0.018`, `insufficientData=true` →
  `maxAggregateZ` null, both flags false, `under_review`. **Must be re-backfilled post-D7.**
- `health_quarantine`: 3 rows; form_4 row `accepted-as-warning`,
  `category='sparse-rate-aggregate-under-review'`. (Worker did NOT touch it this cycle; per ADR-055
  the `adr_ref += ADR-055` re-version is a follow-up when the pooled stat clears the readiness gate —
  optional housekeeping, NOT load-bearing.)

### DB-state (session-start health:check, no Tier-2 introduced: fresh=3 stale=0 very-stale=12
missing=1 empty=9; migrations 20/20)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron). 9 empty + 1 missing = never-run
  EDGAR/FINRA ingests (intended empty-states).

---

## Watch-outs

### NEW this cycle — READ THESE
- **The D7 backfill is ~15-25h and may be ORPHANED if the chat was `/clear`ed.** See Restart-recovery
  ⚠️. It is idempotent + resumable via the driver + `.progress`. EDGAR transient HTTP 500s during the
  run are NORMAL (handled by the script's 5x exponential-backoff retry — observed this cycle).
- **The 98 v5 snapshots are a PRE-D7 baseline (pooled buy events=3).** They MUST be re-backfilled
  AFTER the D7 backfill completes for the OQ-C38-1 measurement — the pooled events only grow as
  admitted days grow. Re-backfilling MID-backfill reads partial data (fine — it gets overwritten;
  ReplacingMergeTree on `snapshot_date`).
- **v5 is the CORRECT construct even though it's still `under_review` today.** Do NOT mistake "v5
  shipped" for "form_4 is Phase-B-ready" — it is NOT until pooled `effectiveEvents ≥ 20` (OQ-C38-1).
  The implementation only swaps "11 under_review sectors" → "1 under_review pooled stat" until D7.
- **Do NOT lower EVENT_FLOOR / α / relax HLZ-PBO-DSR to force a verdict** (anti-shopping; AFML §11.4 /
  ADR-051 D5 / ADR-054 D3 / ADR-055 alternatives). Any firing-behavior change needs a NEW a-priori ADR.
- **Per-sector form_4 flags are INFORMATIONAL ONLY post-v5.** Any consumer that gates on a per-sector
  flag is using a non-calibrated signal. The gated signal is the POOLED stat.
- **NO DDL was added (ADR-055 D5).** The pooled metadata lives in the `{sectors,pooled}` JSON wrapper.
  A future reader of `flagged_sectors_json` must use `decodeFlaggedJson` (handles wrapper + legacy
  bare-array + malformed); do NOT assume the column is a bare array.

### Carried (still load-bearing)
- **Chronological baseline order is LOAD-BEARING** (ADR-054 D1; now extends to the pooled series —
  POPSEC-F4-POOL-2). `countNonZeroRuns` runs over the ordered series.
- **`effectiveSample` (non-zero days) is DIAGNOSTIC ONLY** — `effectiveEvents` (runs) gates validity.
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite `loadHistory`.
- **Finnhub `person_cik` is a name-hash (S96-145)** — EDGAR canonical source only for the cluster path
  (ADR-052 D1). **`accepted_at` (NOT `transaction_date`) is the anti-leak anchor** (F4-10).
- **Worktree stale-base hazard (CONFIRMED AGAIN this cycle):** the Agent `isolation:"worktree"` spawned
  at `c0cda7c` (s96 #7, ~150 commits behind). The worker reset its branch to main HEAD before starting;
  the orchestrator independently verified `merge-base == main HEAD == 3b58f87` before ff-merge. ALWAYS
  verify before merging. `ExitWorktree` is a no-op on Agent-spawned worktrees → use `git worktree remove
  --force` + `git branch -D`.
- **`bash` ≠ PowerShell here-strings.** Used `git commit -F`/single-line `-m` (clean) — the
  `git commit -m @'...'@` via the Bash tool inserts literal `@`s.
- **Dev server** does NOT hot-reload server edits — restart after `*_dashboard.ts`/`server.ts`.
- **CH em-dash on the wire is correct UTF-8** (`E2 80 94`); curl→python cp1252 pipes show it as
  mojibake `â€"` — a display artifact, not a bug (verified this cycle).
- All prior watch-outs preserved (EDGAR/FINRA per-IP throttle; gics PIT-anchor; CH-Date range; sp500
  PIT gap-window; executive_departure dedupe key; D5/ReplacingMergeTree re-backfill REPLACES rows).

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot (engine often needs ~5-40s):
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse                 # loop until healthy
curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"
# D7 backfill — check progress / resume:
cat logs/d7_form4_backfill.progress ; tail -20 logs/d7_form4_backfill.log
bash scripts/_d7_form4_backfill_driver.sh        # resume (edit months=() to drop completed); run in background
# After D7 COMPLETE — resolve OQ-C38-1:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply   # ~79s, 98 days -> v5
curl -s ".../quantlab" --data-binary "SELECT JSONExtractInt(flagged_sectors_json,'pooled','effectiveEvents') FROM quantlab.form_4_insider_snapshots ORDER BY snapshot_date DESC LIMIT 1"
# Form4 tests + tsc (the slice gate):
node --import tsx --test scripts/tests/form4Insider.test.ts scripts/tests/form4InsiderRepository.test.ts scripts/tests/compositeForm4Dashboard.test.ts scripts/tests/operatorBrief.test.ts scripts/tests/operatorBriefRender.test.ts
npx tsc --noEmit                                 # 13 baseline (all scripts/_*.ts)
# Dev server (visual validation): npm run dev -> http://localhost:3000/#/form-4-insider
npm run health:check
```

---

## For the next session — priority order

**form_4_insider_v5 (ADR-055) is SHIPPED + merged + UI-validated** (`4e425e8`); the pooled construct
is live in code + CH and correctly suppresses to `under_review` (pooled buy events=3 < 20). **The D7
full-market EDGAR backfill is RUNNING in the background** (`afab02e` driver). On `continue`, the
recommended default is: **check/resume the D7 backfill → when COMPLETE, re-backfill v5 snapshots +
measure pooled `effectiveEvents` → resolve OQ-C38-1** (is form_4's aggregate Phase-B-viable?). If
yes, Part B (the deflation campaign, `phase-b-form_4_v1.md` Part B) unblocks. If still < 20, extend
to a multi-year backfill (OQ-C38-2). Do NOT pre-judge; do NOT lower the floor.

**Do NOT auto-open without operator green-light:** Phase C promotion (Q-8); ALTER DROP/DELETE;
`git push` (Q-4 — ~133 commits); real-money path. **Do NOT tune EVENT_FLOOR / α / HLZ-PBO-DSR gates
to a desired outcome** (anti-shopping).

---

## Important framing for the next chat

**Cycle 39 turned ADR-055 from a ratified design into shipped, verified code — and started the real
gate.** The pooled construct is now live (`form_4_insider_v5`): one index-level statistic, the same
exceedance + event-floor guard reused verbatim, per-sector demoted to informational, zero new
parameters, no DDL. The pre-D7 re-backfill confirmed exactly what ADR-055 predicted — pooled buy
`effectiveEvents=3` < 20 → honest `under_review`. So the construct is RIGHT and the data is the
binding constraint, as designed. The session's [HEALTH] catch was that D7 is bigger than the prior
handoff implied: the 2024-07…2025-11 "gap" is SP500-filtered-thin (below the coverage floor), so D7
is a full-market ~15-25h re-ingest, now running in the background. The honest verdict remains:
**form_4's aggregate is not Phase-B-ready until the pooled events clear 20 (OQ-C38-1), which we will
MEASURE on the post-D7 re-backfill — not assert.** UI coverage unchanged = 10 live panels (the form_4
panel now shows the v5 pooled stat + per-sector informational label). No floor was moved.
