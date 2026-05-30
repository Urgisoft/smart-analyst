# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #32 — **Cycle 35: ADR-052 IMPLEMENTED + merged
+ v2 re-backfilled — but verification re-characterized the artifact and opened
ADR-053.** The form_4 source-provenance normalization (ADR-052 D1-D5) shipped:
EDGAR-canonical cluster path + coverage-homogeneous baseline + `form_4_insider_v2`,
via a Composite worker + Critic (AUTO-APPROVE), merged at `bfec016`, all 98 snapshots
re-backfilled to v2. **The empirical verification then proved the z=5.57 artifact is
NOT resolved at the value level.** Removing provenance dropped Health-Care 5.57→4.73,
but the EDGAR-only coverage-gated baseline is so sparse/zero-inflated that the
Gaussian z-test degenerates: max |z| went to **14.18** (Comm Svcs 2026-04-30 — baseline
202/203 days = 0; today = ONE clustered ticker → 14σ). **Root cause re-characterized
(S96-163): the dominant driver is the z-STATISTIC's invalidity on sparse cluster-rates,
not provenance (now fixed).** That is calc-logic/methodology → a NEW ADR. **ADR-053
(PROPOSED) drafted** recommending an empirical-exceedance statistic + a min-effective-
sample guard. Quarantine re-characterized to `accepted-as-warning`. NEXT on `continue`:
ratify + implement ADR-053 (Composite worker), OR kick off the D7 EDGAR coverage
backfill (operator-paced). See "Next stage".

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker Desktop.
On reboot (this session rebooted 3×; recovery worked each time):

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll engine up: loop `docker version`; then `docker start quantlab-clickhouse`;
   then wait `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse`
   = `healthy` (~10-40s after engine ready).
3. Verify before any CH work:
   `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT
hot-reloading; restart after server-side edits. **Not running at end of this session.**
`/#/form-4-insider` now renders the v2 aggregate z (up to ~14σ) — honest
(coverage-homogeneous) but the aggregate statistic is under review per ADR-053
(quarantined + labeled). The per-ticker insider counts/flags on that panel are fine.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every
routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~124** unpushed commits to origin/main | Carry-over (+2 this session: `bfec016` code + the docs commit) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not queue items — orchestration-owned, operator-PACED):**
- **ADR-052 D7 — EDGAR Form 4 gap backfill (`2024-06 … 2025-11`).** Free source but a
  throttled bulk op (per-IP rate-limited) — pace it. Lengthens the form_4 baseline so
  the (post-ADR-053) statistic has resolution. form_4 is NOT Phase-B-ready until this
  + ADR-053 land. NOT real-money.
- **ADR-053 (PROPOSED)** — replaces the form_4 aggregate z-test with a sparse-rate
  statistic. Calc-logic change → operator-VISIBLE (ADR-044), but orchestration owns
  the decision per the working model; surfaced here only for awareness.

---

## What this session delivered (s96 #32 — Cycle 35)

| Commit | Slice |
| --- | --- |
| `bfec016` | **ADR-052 form_4 source-provenance normalization (D1-D5)** — `src/server/form_4_insider.ts` + `_repository.ts` + 4 test files. Composite worker + Critic AUTO-APPROVE. tsc 13 baseline; 482 form4 tests green. |
| (this commit) | ADR-053 (PROPOSED) + teach-doc + this HANDOFF. Pure docs. |
| (CH, not git) | v2 re-backfill: all 98 `form_4_insider_snapshots` rows → `form_4_insider_v2`. `health_quarantine` ADR-052 row updated → `accepted-as-warning`, `category=sparse-rate-z-invalidity`. |

No DDL, no real-money path, no scrape. The CODE went through a worker+critic (NOT
orchestrator self-edit — it changes a composite's persisted outputs).

---

## Decisions locked in

### s96 #32 Cycle 35 — ADR-052 IMPLEMENTED (the code facts)
- **`FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v2'`** (D5). `EDGAR_CANONICAL_SOURCE
  = 'sec_edgar_form4_xml'`.
- **D1 (cluster path EDGAR-only):** new pure `filterTradesToCanonicalSource`; per-ticker
  cluster flags derive from EDGAR-only trades; sector `computeSectorClusterRate` fed
  EDGAR-only. Per-ticker RAW counts stay dual-source (D3/D4) behind a new
  `insiderCountSourceMix:{edgar,finnhub}` per-ticker field (serializes into
  per_ticker_json; no DDL).
- **D2 (coverage-homogeneous baseline) — repository:** new `readEdgarPsDailyVolume`
  (system-wide EDGAR P/S daily volume) + `computeEdgarCoverageAdmittedDays`. A baseline
  day is admitted iff trailing-`EDGAR_COVERAGE_WINDOW_DAYS=30` system-wide EDGAR P/S
  volume ≥ **`EDGAR_COVERAGE_FLOOR=500`**; gap days EXCLUDED (never zero-filled); covered
  days with zero sector trades still push rate=0. Floor pinned a-priori from cadence
  (any value in [1,~5000] separates the hard-zero gap from ≫5000 steady-state; AFML §11.4,
  anti-shopping). `readTradesForTickersInWindow` gained a `canonicalSourceOnly` 4th param.
- **Critic verdict:** AUTO-APPROVE, HIGH confidence on the D2 gate (exclude-vs-zero-fill
  correct; candidate-day set spans all calendar days via the membership panel).

### S96-163 (the verification finding — the real story of this cycle)
- ADR-052 fixed PROVENANCE; it did NOT resolve the VALUE. Post-v2 table: max |z|=**14.18**,
  16/98 days |z|>5, 61/98 |z|>2. Health-Care 2026-05-22: 5.57→4.73 (down) but
  Comm-Svcs 2026-04-30 = 14.18 (up).
- **Mechanism (measured):** the EDGAR-only coverage-gated baseline is zero-inflated.
  Comm-Svcs example: 203 admitted days, **202 = 0**, 1 non-zero; today = **1/22 = one
  clustered ticker** → z = (0.0455−0.000224)/0.00319 = 14.18. `MIN_Z_BASELINE=30` passes
  on day-count but the EFFECTIVE (non-zero) sample is 1. The Gaussian z-test is invalid
  on a sparse zero-inflated discrete cluster-rate.
- **Root cause re-characterized:** z-STATISTIC choice, not provenance, not solely coverage.

### ADR-053 (PROPOSED) — the recommendation
- Replace the Gaussian z with **empirical exceedance / rank** (non-parametric;
  `(#{baseline ≥ today}+1)/(n+1)`; Aronson EBTA empirical-significance canon) as PRIMARY,
  **layered with a min-effective-sample guard** (null when non-zero baseline obs < K).
  Three-criterion test: B has 0 free params + on-point canon; B+C = 1 a-priori-pinned K.
- **PUSHBACK (do not paper over):** no statistic manufactures signal from ~124 EDGAR days.
  form_4 aggregate needs BOTH ADR-053 (statistic) AND ADR-052 D7 (coverage). Until both,
  the aggregate should render "insufficient data / under review," not a number.

**Carry-overs:** all ADR-052 decisions D1-D7; S96-145/146/160/161/162; S96-148/149;
S96-1..S96-144; all prior s73-s95 lock-ins.

---

## Open questions

### NEW this session
- **S96-163 / ADR-053** — which sparse-rate statistic + the a-priori K (min effective
  sample) + the empirical-tail firing threshold. PROPOSED = empirical exceedance + guard;
  ratification + implementation is the next gated Composite slice.
- The form_4 **Phase-B SPEC is now gated on D6 (readiness) + D7 (coverage) + ADR-053
  (statistic)** — drafting it is deferred until the statistic is decided (it pins the
  score axis).

### STILL OPEN (carried)
- **OQ-052-1** (D2 coverage-floor value) — RESOLVED in code (`EDGAR_COVERAGE_FLOOR=500`,
  window 30); to be re-documented in the Phase-B SPEC when drafted.
- **OQ-052-2** (D6 readiness-gate N/G) — pin in the Phase-B SPEC.
- **OQ-052-3** — do `schedule_13d_g`/`eight_k`/`executive_departure`/`short_interest`
  share BOTH the provenance pattern AND the sparse-rate z-invalidity? Same structure in
  principle (all z-on-cluster-rate); tables empty today; re-evaluate per composite when
  each ingest runs. ADR-052 + ADR-053 precedents both apply.
- **CARRIED:** OQ-C31-4 (`INSERT…SELECT FROM <self>` no-ops — relevant: I used JSONEachRow
  for the quarantine update, NOT INSERT…SELECT, to avoid this trap), OQ-C29-1/2/5,
  OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3, OQ-C19-1, OQ-C18-1,
  OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — ratify + implement ADR-053 (RESEARCH→SPEC→CODE)
1. **Finalize the statistic** (RESEARCH, mostly done in ADR-053): empirical exceedance +
   min-effective-sample guard. Pin K + the firing threshold a-priori from observed
   sparsity (NOT from the z outcome).
2. **Composite-worker slice (CODE)** — in `src/server/form_4_insider.ts` replace/augment
   `computeZ`-on-cluster-rate with the empirical-exceedance statistic + guard; bump
   `form_4_insider_v2` → `v3` (ADR-051 D8). Repository: `populateSectorsForCycle` already
   delivers the EDGAR-only coverage-gated baseline series — the statistic consumes the
   same `baseline2y`/`baseline2ySell`. Update the snapshot's aggregate fields semantics
   (the `max_aggregate_z*` columns can carry the new score, or add new fields — decide in
   the SPEC). **Spawn a Composite worker + Critic** (calc-logic; operator-visible ADR).
   Tests: zero-inflation case (1 ticker → bounded tail, NOT 14σ), cold-start null, the
   guard boundary, version pin v3.
3. **Re-backfill** to v3; verify max |tail-score| is bounded + the degenerate sectors
   render "insufficient data." Update the quarantine row toward `corrected` only if the
   value is genuinely honest now.
4. THEN draft `docs/specs/phase-b-form_4_v1.md` (gated on D6+D7+ADR-053).

### Alternative stages the operator could pick instead
- Kick off **D7 EDGAR gap backfill** (operator-paced) so the post-ADR-053 statistic has
  baseline resolution. Both are needed; order is flexible.
- Apply the ADR-052 + ADR-053 precedents to another EDGAR/FINRA composite once populated.
- Resume a deferred reconciliation gap (GAP-16 sentinels; GAP-13 Quartz doc; GAP-10 CI/CD).

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `bfec016` | `src/server/form_4_insider.ts` (+128), `_repository.ts` (+261), `scripts/tests/form4Insider.test.ts` (+162), `form4InsiderRepository.test.ts` (+175), `compositeForm4Dashboard.test.ts` (+7), `operatorBrief.test.ts` (+28). |
| (this commit) | `docs/specs/adr-053-form4-aggregate-sparse-rate-statistic.md` (new, PROPOSED), `docs/teach/2026-05-30-zero-inflated-rate-ztest.md` (new), `.claude/HANDOFF.md`. |

CH side-effects (not git): 98 `form_4_insider_snapshots` rows → v2; `health_quarantine`
ADR-052 row → `accepted-as-warning`. No DDL. tsc baseline 13 (all `scripts/_*.ts`).

### Form 4 pipeline (current state post-merge)
- **Composite (pure):** `src/server/form_4_insider.ts` — `FORM_4_INSIDER_COMPOSITE_VERSION
  = 'form_4_insider_v2'`; `EDGAR_CANONICAL_SOURCE`; `filterTradesToCanonicalSource`;
  per-ticker cluster flags EDGAR-only; `insiderCountSourceMix` per-ticker field; aggregate
  defense-in-depth EDGAR filter. `computeZ` (the now-invalid Gaussian z) is what ADR-053
  replaces.
- **Repository (I/O):** `_repository.ts` — `readEdgarPsDailyVolume`,
  `computeEdgarCoverageAdmittedDays`, `EDGAR_COVERAGE_FLOOR=500`,
  `EDGAR_COVERAGE_WINDOW_DAYS=30`; `readTradesForTickersInWindow(...,canonicalSourceOnly)`;
  `populateSectorsForCycle` builds the EDGAR-only coverage-gated `baseline2y`/`baseline2ySell`.
- **Backfill:** `scripts/_backfill_form_4_insider_snapshots.ts` — `--apply` re-ran
  (default window 2026-01-01→today; 98 days; ~84s). Re-run after the v3 change.
- **Pattern:** ADR-051 = Phase-B harness; ADR-052 = provenance; ADR-053 (PROPOSED) =
  statistic.

### Key CH facts (unchanged from Cycle 34 unless noted)
- `insider_trades` 296,219 rows; EDGAR P/S active-days in `[2024-05-22,2026-05-21]` ≈ 124
  (7 in May-2024, 18-month gap, ~117 continuous Dec-2025→May-2026).
- `form_4_insider_snapshots`: 98 rows, ALL `form_4_insider_v2` now; max |max_aggregate_z|
  = **14.18** (Comm Svcs 2026-04-30; known/quarantined, sparse-rate z-invalidity).
- `health_quarantine`: 3 rows; ADR-052 row now `accepted-as-warning`,
  `adr_ref='ADR-052,ADR-053'`.

### DB-state (session-start health:check: fresh=3 stale=0 very-stale=12 missing=1 empty=9;
migrations 20/20 — IDENTICAL to s96 #31, no NEW Tier-2 at start)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron); operator-cadence `daemon:daily`.
- 9 empty + 1 missing = never-run EDGAR/FINRA ingests; intended empty-states.

---

## Watch-outs

### NEW this session — READ THESE
- **⚠️ Agent `isolation:"worktree"` can spawn at a STALE base commit.** This cycle's
  Composite worktree was based at `c0cda7c` (s96 #7, 2026-05-22) — a WEEK behind `main`
  (`3a7b37d`). A blind `git merge --ff-only` would have REVERTED a week of work. **Always
  verify `git merge-base main <worktree-branch> == main HEAD` BEFORE merging an agent
  worktree.** The fix used: commit the worker changes, then `git rebase --onto main
  <stale-base>` (git's 3-way handles non-overlapping divergence cleanly), then ff-merge.
  Two orphan locked worktrees remain (`agent-a9cfcb6ea446a9fb5`@c0cda7c,
  `agent-a9df63a19695f81da`@3a7b37d) — harmless dangling refs; remove with
  `git worktree remove --force` + unlock if they accumulate.
- **⚠️ `git add -A` in a worktree can sweep scratch files into the commit.** A 1240-line
  `.tmpdiff/full.diff` (the diff I generated for the Critic) got committed then removed
  via `git rm --cached` + amend. Write scratch to `.git/`-internal paths, or `git add`
  specific files, not `-A`.
- **The form_4 aggregate z is INVALID, not just contaminated.** 1 clustered ticker → 14σ
  on a 202/203-zero baseline. Do NOT "fix" it by tuning the floor or MIN_Z_BASELINE —
  the statistic itself is wrong (ADR-053). Do NOT mark the quarantine `corrected` until a
  valid statistic ships.
- **`MIN_Z_BASELINE=30` counts DAYS, not effective sample.** On a zero-inflated baseline
  it passes with ~1 real observation. ADR-053's guard counts NON-ZERO obs.
- **The v2 re-backfill made the displayed values LARGER (max 14.18 vs 5.57) but HONEST.**
  This is intentional: coverage-homogeneous + provenance-clean beats contaminated-but-
  smaller. The quarantine + dashboard label carry the honesty. Do NOT revert to v1.

### Carried
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory` (form_4's new `readEdgarPsDailyVolume` follows it).
- **Finnhub `person_cik` is a name-hash (S96-145)** — unfit for cluster-distinctness (the
  ADR-052 D1 reason); now demoted from the cluster path.
- **`accepted_at` (NOT `transaction_date`) is the load-bearing anti-leak anchor** (F4-10).
- **D5/ReplacingMergeTree:** `form_4_insider_snapshots ORDER BY snapshot_date` → a v3
  re-backfill will REPLACE v2 rows (not preserve them). Audit trail = quarantine + ADRs +
  git, not the snapshots table. Do NOT rebuild the table engine (destructive, operator-gated).
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
npm run dev                                      # http://localhost:3000/#/form-4-insider
# Form4 tests + tsc (the slice's gate):
node --import tsx --test scripts/tests/form4Insider.test.ts scripts/tests/form4InsiderRepository.test.ts scripts/tests/compositeForm4Dashboard.test.ts scripts/tests/operatorBrief.test.ts
npx tsc --noEmit                                 # 13 baseline (all scripts/_*.ts)
# Re-backfill after a composite change:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply   # ~84s, 98 days
# health:
npm run health:check
```

---

## For the next session — priority order

**ADR-052 is DONE (merged `bfec016` + v2 backfill).** The real open work is **ADR-053**:
the form_4 aggregate cluster-rate z-test is statistically invalid on sparse zero-inflated
data (1 ticker → 14σ). On `continue`, ratify + implement ADR-053 via a **Composite worker
+ Critic**: empirical-exceedance statistic + min-effective-sample guard + v2→v3 bump +
re-backfill, then (only once honest) move the quarantine toward `corrected`, then draft the
form_4 Phase-B SPEC (gated on D6+D7+ADR-053). Alternatively kick off the operator-paced D7
EDGAR gap backfill first — both are required for Phase-B usability.

**Do NOT auto-open without operator green-light:** D7 EDGAR gap backfill (bulk, throttled —
pace); Phase C promotion (Q-8); ALTER DROP/DELETE; `git push` (Q-4 — ~124 commits);
real-money path.

---

## Important framing for the next chat

**Cycle 35 shipped the ratified plan AND surfaced that the plan was incomplete — the right
way.** ADR-052 (provenance) was implemented exactly as designed, worker+critic, tests green,
merged. Then the [HEALTH] discipline did its job at the verification step: instead of
declaring victory because "the z changed," it measured the actual re-backfilled table, found
the residual was WORSE (14σ), diagnosed it to the bone (202/203-zero baseline; 1 ticker →
14σ), and refused to mark the quarantine `corrected`. The honest conclusion — the Gaussian
z-test is the wrong statistic for sparse insider-cluster-rates — became ADR-053 + a teach-doc,
not a papered-over "fixed."

**The deeper truth (S96-162 → S96-163):** form_4's aggregate cluster signal is blocked on
BOTH a valid statistic (ADR-053) AND real coverage (D7). Neither alone makes it usable; the
orchestration will not run a Phase-B campaign on it until both land. The per-ticker insider
layer (EDGAR-canonical counts + cluster flags) is usable today.

**UI coverage unchanged = 10 live panels.** No panel work this cycle.
