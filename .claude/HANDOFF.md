# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #35 — **Cycle 38: ADR-055 RATIFIED + phase-b-form_4_v1
SPEC drafted — OQ-C37-3 RESOLVED (design-only; NO code).** OQ-C37-3 asked: given per-sector
insider-cluster events are too rare to ever calibrate a per-sector 5% tail, does the form_4
Phase-B aggregate need sector pooling, a longer baseline, or a different construct? **Answer:
cross-sectional POOLING** — the Phase-B signal becomes the index-level pooled cluster-rate
(Σ clustered tickers / Σ sector sizes = "fraction of the S&P 500 with an insider cluster"),
evaluated with the ADR-053 empirical-exceedance statistic + ADR-054 event-floor guard REUSED
VERBATIM (only the series changes: 11 per-sector → 1 index-level; ZERO new free parameters).
The 11 per-sector rates are demoted to dashboard-INFORMATIONAL (non-gated). Pooling removes
the implicit 11-way multiple-testing burden (HLZ 2016 §II), sharpens tail resolution, and
matches the regime consumer's market-level decision. **The honest, data-grounded twist
(measured AFTER deciding — anti-shopping):** pooling alone is NECESSARY but NOT SUFFICIENT
at current coverage. A live probe found per-sector events **max 2 buy / 3 sell (0/11
viable)**, and the pooled-union UPPER BOUND Σ = **15 buy / 19 sell — both BELOW the floor of
20.** The binding constraint is the short continuous baseline (n=203 admitted days), not the
unit; the real gate is **ADR-052 D7** (the ~18-month EDGAR backfill). Per-sector is hopeless
even post-D7 (~8-12 events); pooled is *projected* viable post-D7 (~20-60). **The floor stays
⌈1/α⌉=20 — we wait for data, we do NOT move the goalpost to 15** (the proximity is the
anti-shopping trap). Shipped two pure-docs artifacts (ADR-055 Accepted + the Phase-B SPEC);
NO code changed; tsc baseline preserved. The form_4 composite is STILL `form_4_insider_v4`
on disk + in CH — the pooled construct (v5) is a follow-on Composite-worker CODE cycle,
recommended AFTER D7. NEXT on `continue`: see "Next stage".

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
hot-reloading; restart after server-side edits. **Not running this session** (pure-docs
cycle — no UI to validate; the form_4 panel is unchanged from Cycle 37: `/#/form-4-insider`
renders the v4 `under_review` verdict, data route `/api/form-4-insider`).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the s96 #14 working model, every
routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **~130** unpushed commits to origin/main | Carry-over (+2 this session: `d6f63ad` design slice + the HANDOFF commit) | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not queue items — orchestration-owned, operator-PACED / for awareness):**
- **ADR-052 D7 — EDGAR Form 4 gap backfill (`2024-06 … 2025-11`).** Free source, throttled
  bulk op (per-IP rate-limited) — pace it. **NOW THE GATING ITEM for the form_4 aggregate.**
  Cycle 38 confirmed with live data that even the POOLED construct (ADR-055) is below the
  20-event floor at current coverage (pooled-union upper bound 15 buy / 19 sell). D7
  lengthens the continuous baseline so the pooled series can clear the floor (projected
  ~20-60 post-D7). For *Phase-B window parity* with the other 8 Layer-0 composites
  (2013-2026), form_4 likely needs a MULTI-YEAR EDGAR backfill beyond just the D7 gap
  (OQ-C38-2) — EDGAR Form 4 XML is free + historically available, so a throttled data op,
  NOT a paid-data blocker. NOT real-money.
- **ADR-055 — RATIFIED this cycle** (Phase-B construct decision for the Layer-0 form_4
  aggregate; calc-construct logic → operator-VISIBLE per ADR-044, orchestration owns the
  decision; HLZ/AFML/Aronson already Tier-1 → NOT operator-GATED. Here for awareness).

---

## What this session delivered (s96 #35 — Cycle 38)

| Commit | Slice |
| --- | --- |
| `d6f63ad` | **ADR-055 + phase-b-form_4_v1 SPEC** (pure-docs; resolves OQ-C37-3). `docs/specs/adr-055-form4-aggregate-cross-sectional-pooling.md` (Accepted) + `docs/specs/phase-b-form_4_v1.md` (spec-blocked-on-construct-and-coverage). 2 files, 653 insertions. No code; tsc baseline 13 preserved. |
| (this commit) | This HANDOFF rewrite. Pure docs. |

Method: RESEARCH-first (decided the construct a-priori from canon), THEN measured the live
power state with a throwaway probe (`scripts/_diag_form4_pooled_events.ts`, run + **deleted**
— numbers captured in ADR-055's power table). No worker spawned (pure-docs = orchestrator-
self-edit per multi-agent §3.1 trivial-edit exception: no real-money path, no DDL, no
paid-data, tsc preserved, no canon-cited methodology being *committed to code* — drafting a
RATIFIED Phase-B construct ADR is orchestration-owned per §6.4/§7.3). No CH writes. No DDL.

---

## Decisions locked in

### s96 #35 Cycle 38 — ADR-055 RATIFIED (the construct decision; OQ-C37-3 resolved)
- **The form_4 Phase-B aggregate UNIT is the cross-sectional pooled cluster-rate**:
  `pooledRate(t) = Σ_sectors clusterTickers_s(t) / Σ_sectors sectorSize_s(t)` per direction
  = the issuer-weighted pool = "fraction of the S&P 500 with an insider cluster today."
- **The statistic + guard are UNCHANGED** — `computeEmpiricalExceedance` (ADR-053) +
  `countNonZeroRuns` / `EVENT_FLOOR=20` / `MIN_Z_BASELINE=30` (ADR-054) run VERBATIM on the
  pooled series instead of 11 per-sector series. ZERO new free parameters. `form4ClusterFlag`
  / `form4SellClusterFlag` + `maxAggregateZ[Sell]` derive from the POOLED stat (not the
  max-over-sectors).
- **Per-sector demoted to INFORMATIONAL** (ADR-055 D2): the 11 per-sector rates + flagged
  lists are retained + rendered (which sectors cluster, with `effectiveEvents`) but are
  NON-GATED — no per-sector flag feeds the aggregate flag, the Phase-B campaign, or Phase-C.
  Dashboard MUST label them "informational — not statistically calibrated (ADR-055)".
- **Readiness gate (ADR-055 D3):** the pooled aggregate is Phase-B-ready iff pooled
  `effectiveEvents ≥ 20` AND CSCV `effectiveS ≥ 4`. **Measured today: FAILS** (pooled events
  ≤ 15/19 < 20). Gated on ADR-052 D7. **Floor NOT lowered** (anti-shopping).
- **Version pin (ADR-055 D4, at implementation):** `FORM_4_INSIDER_COMPOSITE_VERSION →
  'form_4_insider_v5'`. **NO DDL (D5)** — reuse existing Nullable `max_aggregate_z*` columns;
  pooled `effectiveEvents` + per-sector informational lists ride in `flagged_sectors_json`.
- **Implementation sequencing:** D7 backfill FIRST (so the v5 re-backfill verification can
  show the stat resolving), THEN v5. Shipping v5 before D7 is permitted but lower-value
  (only swaps "11 under_review sectors" → "1 under_review pooled stat"; forces two
  re-backfills).
- **The measured power finding (anti-shopping; diagnostic, post-decision):** per-sector
  events **max 2 buy / 3 sell**, 0/11 viable; pooled-union ∈ [max, Σ] = [2,15] buy / [3,19]
  sell — **both < 20.** Pooling necessary-but-not-sufficient at current coverage; the binding
  constraint is the short continuous baseline (n=203), not the unit. Falsifies the naïve
  "pool 11 sectors → ~11× events → clear the floor" (sector runs OVERLAP — insider clustering
  is partly market-wide). Captured in ADR-055 Context table.

**Carry-overs:** ADR-052 D1-D7; ADR-053 (D1-D6); ADR-054 (D1-D6); S96-145/146/160/161/162/163;
S96-148/149; S96-1..S96-144; all prior s73-s95 lock-ins. ADR-050 (CBOE), ADR-051 (Phase-B
harness + D8 version-pin). The form_4 four-layer template is now: ADR-052 provenance →
ADR-053 valid statistic → ADR-054 event-level effective sample → **ADR-055 cross-sectional
unit**.

---

## Open questions

### RESOLVED this session
- **OQ-C37-3 (per-sector tails structurally under-powered → which construct?)** — RESOLVED
  by ADR-055: cross-sectional pooling (necessary but D7-gated; per-sector demoted to
  informational; floor unchanged).

### NEW this session (opened by ADR-055 / the Phase-B SPEC)
- **OQ-C38-1** — does the POOLED series actually reach ≥20 events post-D7, and at what date?
  MEASURE on the v5 re-backfill; if it falls short, choose a multi-year EDGAR backfill
  (preferred, free) vs declaring the form_4 aggregate permanently informational. Do NOT
  pre-judge. **The key empirical question that decides whether form_4's aggregate is EVER
  Phase-B-viable.**
- **OQ-C38-2** — multi-year EDGAR Form 4 XML backfill (beyond the D7 gap) for Phase-B window
  parity (2013-2026) with the other 8 Layer-0 composites. Free + throttled = a pacing op,
  not a paid-data blocker.

### STILL OPEN (carried)
- **OQ-C37-1** — calendar-aware run-breaking (the event count runs on the COMPACTED baseline;
  gap-straddling non-zero days merge into one event). Conservative as-is. Now also applies to
  the pooled series. Low priority while suppressed.
- **OQ-C37-2** — firing-run de-dup / fire-on-onset — now lives on the POOLED series (a
  consumer/Phase-B-harness concern); moot until coverage permits firing.
- **OQ-052-3** — do `schedule_13d_g`/`eight_k`/`executive_departure`/`short_interest` share
  the provenance + sparse-rate z-invalidity + event-autocorrelation + per-sector-underpower
  pattern? Same structure in principle; the **four-layer template (ADR-052/053/054/055)** now
  applies to each once its ingest runs. Tables empty today.
- **OQ-052-1** (D2 coverage-floor=500, window 30) — RESOLVED in code; re-documented in the
  Phase-B SPEC (§S-PBF1 / inherited from ADR-052).
- **OQ-052-2** (D6 readiness-gate) — now pinned in `phase-b-form_4_v1.md` §3.
- **CARRIED:** OQ-C31-4 (`INSERT…SELECT FROM <self>` no-ops), OQ-C29-1/2/5, OQ-C30-3,
  OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1.

---

## Next stage

### Default on `continue` — pick the highest-leverage of these (orchestration's call)
OQ-C37-3 is resolved at the DESIGN level (ADR-055 + the SPEC). The form_4 aggregate is now
blocked on (a) the v5 construct IMPLEMENTATION and (b) DATA coverage (D7 / multi-year
backfill). Options, roughly ordered:

1. **Implement `form_4_insider_v5` (the ADR-055 pooled construct) — Composite worker + Critic
   (CODE).** Per `docs/specs/phase-b-form_4_v1.md` §1 Part A. This is composite logic →
   spawn a Composite worker (NOT orchestrator-self-edit). Ships the pooled reducer +
   per-sector-informational UI label + v5 re-backfill + tests. **Caveat (ADR-055
   sequencing):** observably it just swaps "11 under_review sectors" → "1 under_review pooled
   stat" until D7 lands, and forces two re-backfills. Higher-value AFTER D7. Choose this if
   you want the construct locked in code now regardless.
2. **Kick off the operator-paced D7 EDGAR gap backfill** (FYI item; free, throttled). The
   true gate for form_4 viability. Independent of #1. Then OQ-C38-1 becomes measurable.
   **Recommended if you want to unblock form_4 for real** — pairs naturally with then doing
   #1 so the v5 verification shows resolution.
3. **Apply the four-layer template (ADR-052/053/054/055) to another EDGAR/FINRA composite**
   once its ingest has run (OQ-052-3). The provenance → valid-statistic → event-effective-
   sample → cross-sectional-pooling pattern is now a reusable template.
4. **Resume a deferred reconciliation gap** (GAP-16 sentinels; GAP-13 Quartz doc; GAP-10
   CI/CD).

---

## Files / code state

### Commits this session (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `d6f63ad` | `docs/specs/adr-055-form4-aggregate-cross-sectional-pooling.md` (new, Accepted), `docs/specs/phase-b-form_4_v1.md` (new). |
| (this commit) | `.claude/HANDOFF.md`. |

No CH writes, no DDL this cycle. tsc baseline 13 (all `scripts/_*.ts`). The throwaway probe
`scripts/_diag_form4_pooled_events.ts` was created, run, and deleted (no trace in git).

### Form 4 pipeline (current on-disk + CH state — UNCHANGED from Cycle 37; v5 is FUTURE)
- **Composite (pure):** `src/server/form_4_insider.ts` — `FORM_4_INSIDER_COMPOSITE_VERSION =
  'form_4_insider_v4'` (ADR-055 v5 NOT yet implemented). `computeEmpiricalExceedance`
  (statistic + event-guard); `countNonZeroRuns`; `EVENT_FLOOR=⌈1/α⌉=20`;
  `FORM_4_EXCEEDANCE_ALPHA=0.05`; `MIN_Z_BASELINE=30`. Per-ticker layer unchanged.
  `computeZ`/`flagForm4Cluster`/`FORM_4_CLUSTER_Z_THRESHOLD` = `@deprecated`.
  **v5 (ADR-055) will add the index-level pooled reducer + demote per-sector to
  informational — see `docs/specs/phase-b-form_4_v1.md` §1 Part A for the build contract.**
- **Repository (I/O):** `form_4_insider_repository.ts` — `populateSectorsForCycle` builds
  per-sector baselines (ascending chronological order pinned, `POPSEC-F4-ORDER`).
  `EDGAR_COVERAGE_FLOOR=500`, `EDGAR_COVERAGE_WINDOW_DAYS=30`, `BASELINE_CALENDAR_DAYS=730`.
  v5 will additionally emit the pooled baseline over the same admitted-day set.
- **Backfill:** `scripts/_backfill_form_4_insider_snapshots.ts --apply` (default window
  2026-01-02→today; 98 days; ~79s). Re-run after the v5 change.
- **Design docs (NEW this cycle):** `docs/specs/adr-055-…` (construct decision),
  `docs/specs/phase-b-form_4_v1.md` (Phase-B SPEC, Part A construct + Part B campaign +
  readiness gate).

### Key CH facts (UNCHANGED from Cycle 37)
- `insider_trades` ~296k rows; EDGAR P/S admitted baseline ≈ 203 days (the n in the Cycle-38
  probe). Continuous coverage ≈ Dec-2025→May-2026 (~6mo) + scattered May-2024.
- `form_4_insider_snapshots`: 98 rows, ALL `form_4_insider_v4`; `max_aggregate_z[_sell]`
  **null on every row** (all sectors guard-suppressed; ADR-054). 0 buy + 0 sell firing days.
  Per-ticker layer usable.
- `health_quarantine`: 3 rows; form_4 row `accepted-as-warning`,
  `category='sparse-rate-aggregate-under-review'`, `adr_ref='ADR-052,ADR-053,ADR-054'`
  (ADR-055 will be appended when v5 ships), `cycle_ref='s96 #34 Cycle 37'`.

### DB-state (session-start health:check, UNCHANGED at session end: fresh=3 stale=0
very-stale=12 missing=1 empty=9; migrations 20/20 — no Tier-2 introduced this cycle)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron); operator-cadence `daemon:daily`.
- 9 empty + 1 missing = never-run EDGAR/FINRA ingests; intended empty-states.

---

## Watch-outs

### NEW / re-confirmed this session — READ THESE
- **Pooling does NOT rescue the form_4 aggregate at current coverage — and that is the
  honest [HEALTH] finding.** Pooled-union event upper bound = 15 buy / 19 sell, BELOW the
  floor of 20. The signal stays `under_review`; Part B (the deflation campaign) is genuinely
  BLOCKED on coverage (D7), not deferred for convenience. Do NOT let a future cycle mistake
  "ADR-055 pooled construct decided/shipped" for "form_4 is Phase-B-ready."
- **Do NOT lower `EVENT_FLOOR` (20) or relax HLZ/PBO/DSR to force a verdict.** 15/19 sitting
  just under 20 is the anti-shopping TRAP, not a justification. The floor is the α-derived
  representability limit (⌈1/α⌉). Any firing-behavior change must come from a NEW a-priori
  ADR decision, never from fitting the floor to a desired outcome (AFML §11.4; ADR-051 D5;
  ADR-054 D3; ADR-055 alternatives).
- **Per-sector form_4 flags are INFORMATIONAL ONLY post-ADR-055.** Any future reader/consumer
  that gates on a per-sector form_4 flag is using a NON-calibrated signal. The (future) UI
  label + ADR-055 D2 + the SPEC are the guardrails. The GATED signal is the pooled stat.
- **Phase-B rescaling for form_4 should be ECDF, not Gaussian Φ (SPEC §S-PBF1-2).** The
  pooled rate is bounded, sparse, zero-inflated, right-skewed — NOT approximately normal (the
  exact reason ADR-053 rejected the Gaussian z). Defaulting to the S96-120 Φ would re-import
  a Gaussian assumption the form_4 chain has rejected three times. Default ECDF; justify any Φ
  fallback with a three-criterion block at Part-B build.
- **form_4 cannot match the 2013-2026 cross-composite window from current data.** Continuous
  coverage is ~6 months. Window parity needs a multi-year EDGAR backfill (OQ-C38-2) — free +
  throttled, a pacing op. A degraded sub-window campaign is permitted (documented in the
  verdict `notes`) but the GATES are never relaxed.
- **This cycle was pure-docs (orchestrator-self-edit).** The v5 IMPLEMENTATION is composite
  logic → MUST go through a Composite worker + Critic (multi-agent §3.1; not self-edit).

### Carried (still load-bearing)
- **Chronological baseline order is LOAD-BEARING (ADR-054)** — `countNonZeroRuns` runs over
  the ordered series; pinned by `POPSEC-F4-ORDER`. Extends to the pooled series in v5.
- **`effectiveSample` (non-zero days) is DIAGNOSTIC ONLY** — `effectiveEvents` gates validity.
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory`.
- **Finnhub `person_cik` is a name-hash (S96-145)** — unfit for cluster-distinctness; EDGAR
  canonical source only for the cluster path (ADR-052 D1).
- **`accepted_at` (NOT `transaction_date`) is the load-bearing anti-leak anchor** (F4-10).
- **D5/ReplacingMergeTree:** `form_4_insider_snapshots ORDER BY snapshot_date` → a re-backfill
  REPLACES rows. Audit trail = quarantine + ADRs + git, not the snapshots table. Do NOT
  rebuild the table engine (destructive, operator-gated).
- **`bash` ≠ PowerShell here-strings.** `git commit -m @'...'@` via the Bash tool inserts
  literal `@`s. Used `git commit -F <file>` this cycle (clean).
- **Dev server** does NOT hot-reload server edits — restart after `*_dashboard.ts`/`server.ts`.
- **Worktree merge:** verify merge-base == main HEAD before merging (stale-base hazard); this
  cycle used no worktree (pure-docs, main checkout).
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
# Form4 tests + tsc (the slice's gate when v5 is implemented):
node --import tsx --test scripts/tests/form4Insider.test.ts scripts/tests/form4InsiderRepository.test.ts scripts/tests/compositeForm4Dashboard.test.ts scripts/tests/operatorBrief.test.ts scripts/tests/operatorBriefRender.test.ts
npx tsc --noEmit                                 # 13 baseline (all scripts/_*.ts)
# Re-backfill after a composite change:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply   # ~79s, 98 days
# health:
npm run health:check
```

---

## For the next session — priority order

**OQ-C37-3 is RESOLVED at the design level (ADR-055 RATIFIED + `phase-b-form_4_v1.md`
drafted, both committed `d6f63ad`).** The construct is cross-sectional pooling; per-sector is
demoted to informational; the floor stays 20; the aggregate is honestly `under_review` today
because even pooled the event count (≤15/19) is below 20. The form_4 aggregate is now blocked
on (1) the v5 construct IMPLEMENTATION (a Composite-worker CODE cycle per the SPEC §1 Part A)
and (2) DATA coverage (ADR-052 D7 + likely a multi-year EDGAR backfill, OQ-C38-1/2).

On `continue`, the recommended default is **D7 EDGAR gap backfill (operator-paced) THEN
implement `form_4_insider_v5`** — so the v5 re-backfill verification can show the pooled stat
actually resolving (or honestly confirm it still doesn't, and by how much). Acceptable
alternatives: implement v5 now regardless (construct-in-code; lower observable value
pre-D7), apply the four-layer template to another EDGAR/FINRA composite (OQ-052-3), or resume
a deferred reconciliation gap.

**Do NOT auto-open without operator green-light:** Phase C promotion (Q-8); ALTER
DROP/DELETE; `git push` (Q-4 — ~130 commits); real-money path. **Do NOT tune EVENT_FLOOR / α
/ HLZ-PBO-DSR gates to a desired outcome** (anti-shopping).

---

## Important framing for the next chat

**Cycle 38 answered ADR-054's forward question and, once again, refused to overclaim.** The
form_4 four-layer fix is now complete at the methodology level: ADR-052 (provenance) →
ADR-053 (valid per-value statistic) → ADR-054 (event-level effective sample) → **ADR-055
(the correct cross-sectional unit)**. The decision was made a-priori from canon (pooling
removes the 11-way multiple test, matches the regime consumer, adds zero parameters), and
then the live data was measured — which DELIVERED A SURPRISE worth keeping honest: pooling
alone does NOT clear the 20-event floor at current coverage (pooled upper bound 15 buy / 19
sell). The binding constraint is the short EDGAR baseline, not the unit. So the honest verdict
is "pooling is the right construct AND we must wait for D7," not "pooling fixes it." The
floor stayed at 20 (the proximity of 15/19 was explicitly treated as the anti-shopping trap,
not an excuse to cut it). NO code shipped — the v5 implementation is a Composite-worker cycle
best run after D7. The per-ticker insider layer remains usable today; the aggregate is
honestly `under_review` and will stay so until D7 + the pooled events clear 20 (OQ-C38-1).
**UI coverage unchanged = 10 live panels.** No new panel this cycle (pure-docs / design).
