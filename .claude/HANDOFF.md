# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #33 — **Cycle 36: ADR-053 RATIFIED + IMPLEMENTED +
merged + v3 re-backfilled + VERIFIED.** The form_4 aggregate cluster-rate Gaussian
z-test (statistically invalid on the sparse zero-inflated EDGAR-only baseline — one
ticker → 14.18σ) has been replaced with a **one-sided empirical upper-tail exceedance**
statistic + an **α-derived effective-sample guard**. Shipped via a Composite worker +
Critic (AUTO-APPROVE, HIGH), merged at `445c62b`, all 98 snapshots re-backfilled to
`form_4_insider_v3`. **VERIFIED against the live table: table-wide max |zEmp| = 2.33
(was 14.18); the exact degenerate case (Comm Svcs 2026-04-30, m=1) is now SUPPRESSED to
insufficient_data and the day no longer fires.** The 14σ z-invalidity is FIXED.
**[HEALTH] caveat (do not gloss):** the aggregate now FIRES on 24 buy / 27 sell days —
honest per-day (genuine 2+-ticker clusters in the top ~5% of covered days), but with two
residual, SEPARATE, pre-existing issues that block Phase-B USABILITY (not correctness):
(a) **event-run autocorrelation** — the 30d cluster window smears ONE event across ~30
consecutive firing days; (b) low effective sample pre-D7. Quarantine kept
`accepted-as-warning` (statistic fixed, signal not yet trustworthy), NOT `corrected`.
NEXT on `continue`: see "Next stage".

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
hot-reloading; restart after server-side edits. **Not running at end of this session.**
`/#/form-4-insider` now renders the v3 bounded zEmp (≤ ~2.58). NOTE: the dashboard's
`under_review` verdict only triggers when BOTH aggregate scores are null; with the
current data most sectors are VALID (window-smeared baselines pass the guard), so the
panel shows real buy/sell-cluster firing labeled normally — see Open question OQ-C36-2.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every
routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~126** unpushed commits to origin/main | Carry-over (+2 this session: `445c62b` code+ADR, + the HANDOFF commit) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not queue items — orchestration-owned, operator-PACED / for awareness):**
- **ADR-052 D7 — EDGAR Form 4 gap backfill (`2024-06 … 2025-11`).** Free source but a
  throttled bulk op (per-IP rate-limited) — pace it. Lengthens the form_4 baseline so the
  (now-shipped) ADR-053 statistic has resolution. form_4 aggregate is NOT Phase-B-ready
  until D7 lands. NOT real-money.
- **ADR-053 — RATIFIED + IMPLEMENTED this cycle** (calc-logic → operator-VISIBLE per
  ADR-044, but orchestration owns the decision per the working model; here for awareness).

---

## What this session delivered (s96 #33 — Cycle 36)

| Commit | Slice |
| --- | --- |
| `445c62b` | **ADR-053 form_4 v3** — empirical-exceedance statistic replaces the invalid Gaussian z. `src/server/form_4_insider.ts` (+407/-…), `_repository.ts` (+5), `form_4_dashboard.ts`, `descriptors.ts`, `operator_brief.ts`, `operator_brief_render.ts` + 5 test files; ADR-053 ratified (PROPOSED→Accepted) in the same commit. Composite worker + Critic AUTO-APPROVE. tsc 13 baseline (Δ0); 432 form4-suite tests green. 12 files, 956+/284-. |
| (this commit) | This HANDOFF rewrite. Pure docs. |
| (CH, not git) | v3 re-backfill: all 98 `form_4_insider_snapshots` → `form_4_insider_v3` (~77s). `health_quarantine` row updated → category `sparse-rate-aggregate-under-review`, still `accepted-as-warning`. No DDL. |

No DDL, no real-money path, no scrape. The CODE went through worker+critic (changes a
composite's persisted outputs). Two orphan locked worktrees from Cycle 35 were removed +
their branches deleted.

---

## Decisions locked in

### s96 #33 Cycle 36 — ADR-053 RATIFIED + implemented (the code facts)
- **`FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v3'`** (ADR-051 D8 version-pin).
- **Statistic** (`computeEmpiricalExceedance` in `form_4_insider.ts`): one-sided empirical
  upper-tail exceedance `p = (#{baseline rate ≥ today}+1)/(n+1)` (`≥` ties; North-et-al./
  Davison-Hinkley form), per direction (buy/sell), over the unchanged EDGAR-only
  coverage-gated `baseline2y`/`baseline2ySell`. Stored as a **bounded z-equivalent**
  `zEmp = max(0, invNormCDF(1−p))` (`src/lib/psr.ts` Acklam; `p===1` short-circuits to 0
  BEFORE invNormCDF so −∞ never leaks). Bounded ≈2.58 at n≈204 — a 14σ is impossible.
- **Storage = NO DDL:** reuse the existing Nullable `max_aggregate_z[_sector][_sell][...]`
  columns (now carry `zEmp`); the version tag disambiguates per ADR-051 D8. Raw
  `exceedance` + `effectiveSample` serialize into the schemaless `flagged_sectors_json`
  (the `Form4InsiderFlaggedSector` struct gained `zEmp`/`exceedance`/`effectiveSample`,
  dropped `z`).
- **Firing:** any VALID sector with `p ≤ α` (α=0.05). Legacy `|z|>2` retired.
- **Guards (both DERIVED from α=0.05 — zero new fit params, refined Option C from a
  "fixed K" to an α-derived ratio):** `n ≥ MIN_Z_BASELINE` (30, kept) AND
  `m ≥ ⌈α·(n+1)⌉` where `m = #{non-zero baseline days}`. Derivation: this is EXACTLY the
  threshold below which a minimal non-zero rate (1/N, one ticker) would auto-fire — so
  it suppresses "merely non-zero is anomalous." Comm-Svcs (n=203, m=1): ⌈0.05·204⌉=11 >1
  → insufficient_data.
- **Option A (Binomial): NOT computed** (independence violated; fewer-features).
- **UI:** `deriveVerdict` gained `'under_review'` (both maxZ null AND aggregateAvailable>0);
  the stale "~5.5σ surfacing is the point" dashboard note rewritten to cite ADR-053.
- **`computeZ`/`flagForm4Cluster`/`FORM_4_CLUSTER_Z_THRESHOLD`** kept as `@deprecated`
  dead-but-tested code (SPEC-sanctioned "may remain pending deletion").

### Verification (the real story — [HEALTH] discipline)
- Table-wide max |zEmp| = **2.33** (buy) / **2.33** (sell), was 14.18. ALL 98 rows v3.
- Comm-Svcs 2026-04-30 (the old 14.18σ): now SUPPRESSED (insufficient_data, not the max
  sector); day max = Consumer Disc zEmp=0.72 (exceedance ~0.24); buyflag=0, sellflag=0.
  **The fabricated σ is gone AND the day no longer fires.** ✓
- BUT 24 buy + 27 sell days STILL fire (e.g. Consumer Disc clusterRateT=2/48, exceedance
  0.02-0.045, effectiveSample 11-16). Honest per-day, but a single 2-ticker event fires
  for a RUN of consecutive days (the 30d cluster window).

**Carry-overs:** ADR-052 D1-D7; S96-145/146/160/161/162/163; S96-148/149; S96-1..S96-144;
all prior s73-s95 lock-ins. ADR-050 (CBOE), ADR-051 (Phase-B harness + D8 version-pin).

---

## Open questions

### NEW this session
- **OQ-C36-1 / event-run autocorrelation** — the per-day empirical exceedance treats the
  ~30 consecutive days a single cluster event spans (30d cluster window) as independent
  observations. This inflates `effectiveSample` and fires the aggregate for runs of days
  on ONE underlying event. It is a property of the BASELINE construction (ADR-052 D2 +
  30d window), PRE-EXISTING (the old z had it too), NOT introduced by ADR-053, and it
  matters for DOWNSTREAM weighting (Phase-B/C), not Layer-0 informational correctness.
  Candidate follow-up: fire on event-ONSET, or de-correlate the baseline, or count
  distinct events. **Must be designed a-priori, NOT tuned to a desired firing count
  (AFML §11.4 anti-shopping).**
- **OQ-C36-2 / "under review" intent vs guard reality** — ADR-053's PUSHBACK envisioned
  the aggregate rendering "insufficient data / under review" until D7. In practice the
  α-derived effective-sample guard PASSES for sectors whose baselines are window-smeared
  to m≈11-16, so the aggregate FIRES rather than showing `under_review` (which only
  triggers when both maxZ are null). Whether to broaden the "not-Phase-B-validated /
  under-review" framing on the panel is a follow-up UI/methodology decision. Do NOT
  resolve it by tuning the guard post-hoc.

### STILL OPEN (carried)
- **OQ-052-3** — do `schedule_13d_g`/`eight_k`/`executive_departure`/`short_interest`
  share BOTH the provenance pattern AND the sparse-rate z-invalidity? Same structure in
  principle (all z-on-cluster-rate); tables empty today; re-evaluate per composite when
  each ingest runs. ADR-052 + ADR-053 precedents both apply.
- **OQ-052-1** (D2 coverage-floor `EDGAR_COVERAGE_FLOOR=500`, window 30) — RESOLVED in
  code; re-document in the form_4 Phase-B SPEC when drafted.
- **OQ-052-2** (D6 readiness-gate N/G) — pin in the Phase-B SPEC.
- **CARRIED:** OQ-C31-4 (`INSERT…SELECT FROM <self>` no-ops — I used JSONEachRow for the
  quarantine update, NOT INSERT…SELECT, to avoid this), OQ-C29-1/2/5, OQ-C30-3,
  OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1.

---

## Next stage

### Default on `continue` — pick the highest-leverage of these (orchestration's call)
ADR-053 (the statistic) is DONE. The form_4 aggregate is now bounded + honest but NOT yet
Phase-B-usable (needs D7 coverage + the OQ-C36-1 event-run handling). Options, roughly
ordered:

1. **OQ-C36-1 event-run autocorrelation follow-up (RESEARCH→SPEC→ADR→CODE).** This is the
   most material remaining correctness-adjacent issue surfaced this cycle. Design (a-priori)
   how the aggregate should handle the 30d-window event persistence — fire-on-onset vs
   de-correlated baseline vs distinct-event count. Composite worker + Critic when it lands.
2. **D7 EDGAR gap backfill** (operator-paced; FYI item). Lengthens the baseline so the
   ADR-053 statistic has resolution. Bulk + throttled — pace it. Needed for Phase-B.
3. **Draft `docs/specs/phase-b-form_4_v1.md`** — the score axis is now pinned (zEmp /
   exceedance), so the SPEC is draftable, but it is GATED on D6 + D7 + (arguably) OQ-C36-1
   before a campaign runs.
4. **Apply the ADR-052 + ADR-053 precedents to another EDGAR/FINRA composite** once its
   ingest has run (OQ-052-3).
5. **Resume a deferred reconciliation gap** (GAP-16 sentinels; GAP-13 Quartz doc; GAP-10 CI/CD).

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `445c62b` | `src/server/form_4_insider.ts`, `form_4_insider_repository.ts`, `form_4_dashboard.ts`, `src/components/composite/descriptors.ts`, `src/server/operator_brief.ts`, `operator_brief_render.ts`, `scripts/tests/{form4Insider,form4InsiderRepository,compositeForm4Dashboard,operatorBrief,operatorBriefRender}.test.ts`, `docs/specs/adr-053-...md`. |
| (this commit) | `.claude/HANDOFF.md`. |

CH side-effects (not git): 98 `form_4_insider_snapshots` → v3; `health_quarantine`
ADR-052/053 row → `sparse-rate-aggregate-under-review` / `accepted-as-warning`. No DDL.
tsc baseline 13 (all `scripts/_*.ts`).

### Form 4 pipeline (current state post-merge)
- **Composite (pure):** `src/server/form_4_insider.ts` — `FORM_4_INSIDER_COMPOSITE_VERSION
  = 'form_4_insider_v3'`; `computeEmpiricalExceedance` (the live aggregate statistic);
  `FORM_4_EXCEEDANCE_ALPHA = 0.05`; `MIN_Z_BASELINE = 30`; per-ticker layer
  (EDGAR-canonical counts + cluster flags + source-mix) UNCHANGED from v2. `computeZ` +
  `flagForm4Cluster` + `FORM_4_CLUSTER_Z_THRESHOLD` = `@deprecated` dead-but-tested.
- **Repository (I/O):** `form_4_insider_repository.ts` — `populateSectorsForCycle`
  (ADR-052 D1/D2 baseline build) UNCHANGED; only a comment notes the columns now carry
  zEmp. `readEdgarPsDailyVolume`, `computeEdgarCoverageAdmittedDays`,
  `EDGAR_COVERAGE_FLOOR=500`, `EDGAR_COVERAGE_WINDOW_DAYS=30` unchanged.
- **Backfill:** `scripts/_backfill_form_4_insider_snapshots.ts` — `--apply` re-run
  (default window 2026-01-02→today; 98 days; ~77s). Re-run after any future composite change.
- **Pattern:** ADR-051 = Phase-B harness; ADR-052 = provenance; ADR-053 = statistic (the
  three layers of the form_4 aggregate fix).

### Key CH facts (unchanged from Cycle 35 unless noted)
- `insider_trades` ~296k rows; EDGAR P/S active-days ≈ 124 (7 in May-2024, 18-month gap,
  ~117 continuous Dec-2025→May-2026).
- `form_4_insider_snapshots`: 98 rows, ALL `form_4_insider_v3` now; max |max_aggregate_z|
  = **2.33** (bounded; ADR-053). 24 buy-cluster + 27 sell-cluster firing days (see
  OQ-C36-1 — event-run persistence, not 24/27 independent events).
- `health_quarantine`: 3 rows; ADR-052/053 row now `accepted-as-warning`,
  `category='sparse-rate-aggregate-under-review'`, `cycle_ref='s96 #33 Cycle 36'`.

### DB-state (session-start health:check, UNCHANGED at session end: fresh=3 stale=0
very-stale=12 missing=1 empty=9; migrations 20/20 — no NEW Tier-2 introduced this cycle)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron); operator-cadence `daemon:daily`.
- 9 empty + 1 missing = never-run EDGAR/FINRA ingests; intended empty-states.

---

## Watch-outs

### NEW / re-confirmed this session — READ THESE
- **The form_4 aggregate is FIXED but NOT trustworthy yet.** max |zEmp| is now bounded
  (2.33) and the 1-ticker→14σ degenerate is suppressed (VERIFIED on Comm-Svcs 2026-04-30).
  But it FIRES 24 buy / 27 sell days driven by the 30d-window event-run persistence
  (OQ-C36-1) on a low-effective-sample baseline. Do NOT treat form_4 aggregate firing as a
  validated signal; it is Layer-0 informational, pre-Phase-B. Do NOT mark the quarantine
  `corrected` until OQ-C36-1 + D7 land and the signal is genuinely trustworthy.
- **Do NOT tune the ADR-053 guard (`m ≥ ⌈α(n+1)⌉`) or α to change the firing count.** It is
  pinned a-priori (anti-shopping; AFML §11.4). Any change to the aggregate's firing
  behavior must come from a NEW a-priori design decision (OQ-C36-1), documented in an ADR.
- **`zEmp` is one-sided + clamped ≥ 0.** A zero-rate-today sector → exceedance≈1 → zEmp=0
  (a VALID 0, distinct from null=insufficient_data). The old `|z|>2` was two-sided; a
  below-baseline rate is no longer treated as an anomaly. `deriveVerdict` distinguishes
  zEmp=0 (`normal`) from null (`under_review`).
- **`bash` ≠ PowerShell here-strings.** `git commit -m @'...'@` via the Bash tool inserts
  literal `@`s into the message (it is NOT a here-string in bash). Use `-F <file>` or
  multiple `-m` flags. (Caught + amended this cycle: 8de869c → 445c62b.)
- **This cycle did NOT use `isolation:"worktree"`** — the single Composite worker ran in
  the MAIN checkout to avoid the Cycle-35 stale-base hazard (memory: worktree_merge_verify_base).
  Single worker + clean tree = no collision risk; full `git diff` visibility; clean revert.
  The two Cycle-35 orphan worktrees + branches were removed this cycle (none remain).

### Carried (still load-bearing)
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory`.
- **Finnhub `person_cik` is a name-hash (S96-145)** — unfit for cluster-distinctness; demoted
  from the cluster path (ADR-052 D1).
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
npm run dev                                      # http://localhost:3000/#/form-4-insider
# Form4 tests + tsc (the slice's gate):
node --import tsx --test scripts/tests/form4Insider.test.ts scripts/tests/form4InsiderRepository.test.ts scripts/tests/compositeForm4Dashboard.test.ts scripts/tests/operatorBrief.test.ts scripts/tests/operatorBriefRender.test.ts
npx tsc --noEmit                                 # 13 baseline (all scripts/_*.ts)
# Re-backfill after a composite change:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply   # ~77s, 98 days
# health:
npm run health:check
```

---

## For the next session — priority order

**ADR-053 is DONE (ratified + merged `445c62b` + v3 backfill + verified).** The 14σ
form_4 aggregate z-invalidity is FIXED (max |zEmp| 2.33; degenerate case suppressed). The
real remaining work is **OQ-C36-1 (event-run autocorrelation)** + **D7 (coverage)** — both
needed before the form_4 aggregate is a trustworthy Phase-B signal. On `continue`, the
default is to design OQ-C36-1 a-priori (RESEARCH→SPEC→ADR→Composite worker+Critic), OR kick
off the operator-paced D7 EDGAR gap backfill, OR draft the form_4 Phase-B SPEC (score axis
now pinned; gated on D6+D7). Alternatively apply the ADR-052/053 precedents to another
EDGAR/FINRA composite, or resume a deferred reconciliation gap.

**Do NOT auto-open without operator green-light:** Phase C promotion (Q-8); ALTER
DROP/DELETE; `git push` (Q-4 — ~126 commits); real-money path. **Do NOT tune the ADR-053
guard/α to a desired firing outcome** (anti-shopping).

---

## Important framing for the next chat

**Cycle 36 shipped the ratified plan AND the verification refused to overclaim.** ADR-053
was implemented exactly as designed (worker+critic, AUTO-APPROVE, tests green, merged) and
the core defect is verifiably gone: the 14.18σ from one clustered ticker is now a
suppressed insufficient_data, and the table-wide max is a bounded 2.33. But the [HEALTH]
verification did not stop at "the σ shrank" — it measured the re-backfilled table, found
the aggregate still fires 24/27 days, traced that to the 30d-window event-run persistence
(a pre-existing baseline property, not an ADR-053 regression), and **declined to mark the
quarantine `corrected`** because a bounded-but-autocorrelated-and-data-starved signal is
honest, not trustworthy. The honest conclusion became OQ-C36-1 + OQ-C36-2, not a
papered-over "fixed."

**The deeper truth (S96-162 → S96-163 → OQ-C36-1):** form_4's aggregate cluster signal is
blocked on a VALID statistic (ADR-053, ✓ done), real coverage (D7, pending), AND
event-run de-correlation (OQ-C36-1, new). The per-ticker insider layer (EDGAR-canonical
counts + cluster flags) is usable today; the aggregate is not, and won't be claimed as
such until all three land. **UI coverage unchanged = 10 live panels.** No new panel this cycle.
