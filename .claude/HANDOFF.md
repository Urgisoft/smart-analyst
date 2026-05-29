# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-29 (session 96 #31 — **Cycle 34: S96-146 RESOLVED at the
decision level — ADR-052 ratified + the z=5.57 artifact quarantined.** This was
the form_4 Phase-B blocker. Empirically diagnosed (not theorised): the
`max_aggregate_z = 5.5706` persisted in `form_4_insider_snapshots` (2026-05-22,
Health Care) is a **data-provenance artifact**, not insider behaviour.
`insider_trades` is a union of EDGAR (real reporting-person CIK, 1.97 rows/filing,
complete coverage) + Finnhub (synthetic name-hash `person_cik`, 1.0 row/filing,
sparse). The 2y cluster-rate z-baseline straddles a **~15× coverage-density break**
(18 Finnhub-only months → 6 EDGAR-dominant months) plus an **identity split**
(8,998 humans under BOTH a numeric CIK and an `FH`-hash; 90 mixed-source tickers
in 2026). Proved a naïve `WHERE source=edgar` filter makes it WORSE (the 18-month
EDGAR gap → zero-cluster-rate days → baseline depressed further). **PUSHBACK
headline: form_4 is NOT Phase-B-ready** — ~124 clean EDGAR-active P/S days in one
recent 6-month block cannot support a DSR/PBO/HLZ campaign. NEXT on `continue`:
implement ADR-052 (Composite worker — coverage-regime-aware EDGAR-canonical
baseline + v1→v2 bump + re-backfill), then resolve the quarantine row, then draft
the form_4 Phase-B SPEC (execution gated on coverage). See "Next stage".

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker
Desktop. On reboot:

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll until up: `docker start quantlab-clickhouse` in a loop; then wait for
   `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse` =
   `healthy` (~30-60s after engine ready). This session: healthy at start.
3. Verify `SELECT 1` before any CH work. (HTTP probe used this session:
   `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.)

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT
hot-reloading; restart after server-side edits (client .tsx HMR-reloads). **Not
running at end of this session** (Cycle 34 was RESEARCH/DESIGN — no UI slice).
The form_4 panel `/#/form-4-insider` currently renders the contaminated z=5.57
until the ADR-052 re-backfill lands (it's quarantined + explained, not silently
wrong).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model change
ratified 2026-05-23 (s96 #14), every routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **122** unpushed commits to origin/main | Carry-over; +2 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not a queue item — orchestration-owned, but operator-PACED):** **ADR-052
D7 — EDGAR Form 4 gap backfill (`2024-06 … 2025-11`).** This is the coverage-
restoration step that makes form_4 Phase-B-ready. It's a free source (pre-
authorized) but a **throttled bulk op** (per-IP rate-limited) — pace it, don't
bulk-backfill — so it needs an operator to kick off / babysit the long run. NOT
real-money; surfaced here only so the operator knows form_4's Phase-B clock
doesn't start until this lands.

---

## What this session delivered (s96 #31 — Cycle 34, S96-146 resolution)

| Commit | Slice |
| --- | --- |
| `89adb2c` | ADR-052 — form_4 source-provenance normalization (S96-146 RESOLVED at decision level). Pure docs. |
| (CH, not git) | `health_quarantine` row: z=5.57 artifact, `adr_ref='ADR-052'`, `status='pending'`. |

No code change, no DDL, no real-money path, no scrape. tsc baseline 13 preserved
(touched zero `.ts`). This was a RESEARCH→DESIGN milestone: empirical diagnosis
→ quarantine → ratified decision. Implementation is the next slice (deliberately
NOT an orchestrator self-edit — it changes a composite's persisted outputs, so it
goes through a Composite worker + critic).

---

## Decisions locked in

### Session 96 #31 — ADR-052 (S96-146 resolution)

**S96-160 (the z=5.57 is a measured data-provenance artifact, not a signal).**
`form_4_insider_snapshots` FINAL 2026-05-22 carries `max_aggregate_z=5.5705819`
(Health Care). Dual root cause, both quantified against live CH:
- **Coverage-density break:** P/S volume `[2024-05-22,2026-05-21]` = 18 months
  100% Finnhub (~300-650/mo) then 6 months dominantly EDGAR (~6.7-11.2k/mo) — a
  ~15× jump from the SOURCE switch, not insider activity. Current 90d value sits
  in the high-density EDGAR regime; baseline mean/std depressed by the Finnhub
  months → blow-out.
- **Identity split:** EDGAR `person_cik` = real numeric CIK; Finnhub =
  `"FH"+sha1(upper(name))[:10]`. 8,998 humans (86.5% of Finnhub's 10,401 names)
  appear under BOTH → cluster-distinctness double-counts them in straddle
  windows (90 tickers mixed-source in 2026).
- Granularity (1.97 vs 1.0 rows/filing) inflates per-ticker **counts** but is
  **count-invariant for the cluster metric** (distinct persons) → display-only,
  not the z driver.

**S96-161 (naïve source-filter is WRONG).** `WHERE source=edgar` makes it worse:
EDGAR's own coverage in the 2y window is two disjoint islands (7 days May-2024;
18-month GAP; ~117 continuous days Dec-2025→May-2026). Gap days → empty EDGAR 30d
windows → cluster-rate=0 → baseline depressed FURTHER. Fix must be
**coverage-regime-aware** (exclude gap days; never zero-fill).

**S96-162 (form_4 is NOT Phase-B-ready — PUSHBACK).** ~124 clean EDGAR-active
P/S days in one recent 6-month block. ADR-051's DSR/PBO/HLZ on <1yr of
event-sparse, provenance-fractured data is statistical theatre (AFML §11
noise-floor swamps it). Campaign is WRITTEN now (unblocks pattern) but EXECUTION
is gated on coverage (D6 readiness gate; D7 backfill).

**ADR-052 decisions (the resolution):**
- **D1** — cluster path (sector z + per-ticker cluster flags + `maxAggregateZ[Sell]`
  + `form4[Sell]ClusterFlag`) computed from **`source='sec_edgar_form4_xml'` ONLY**
  (real CIK is the only valid cluster-distinctness identity; Lakonishok-Lee 2001 §3).
- **D2** — **coverage-homogeneous baseline**: admit a baseline day only if EDGAR
  coverage is active in its window (system-wide EDGAR P/S volume floor — one
  SPEC-pinned knob); exclude gap days, never zero-fill. `MIN_Z_BASELINE=30` on
  admitted days; sparse sector → `z=null` (honest cold-start).
- **D3** — Finnhub demoted to coverage/forensic; stays in table (no delete) but
  excluded from every identity-dependent computation.
- **D4** — per-layer source rules table (cluster path EDGAR-only; per-ticker raw
  counts may be dual-source WITH a source-mix label; staleness anchor EDGAR-only).
- **D5** — composite version bump **`form_4_insider_v1` → `form_4_insider_v2`**
  (universe-definition change; v1 snapshots persist as historical record; ADR-051
  D8 version-pin trail).
- **D6** — Phase-B readiness gate (mechanical precondition: EDGAR P/S coverage ≥ N
  continuous months, no gap > G days; N/G pinned in the Phase-B SPEC).
- **D7** — coverage restoration target = EDGAR continuous 2024→today via gap
  backfill (operator-paced; then Finnhub fully retired from reads).

**Carry-overs:** S96-145 (Finnhub synthetic person_cik = v1 approximation — now
the identity-split root cause), S96-157/158 (composite-shape divergences),
S96-153 (READ the shape; shared field names ≠ shared semantics), S96-148/149
(reusable CompositeDetailApp + subquery-around-FINAL), S96-1..S96-144; all prior
s73-s95 lock-ins.

---

## Open questions

### RESOLVED this session
- **S96-146** — form_4 source-granularity normalization. **RESOLVED at the
  decision level (ADR-052).** Implementation pending (next slice).

### STILL OPEN (gate the implementation + the campaign)
- **OQ-052-1** — the D2 coverage-floor value + window (the one knob). Pin in the
  form_4 Phase-B SPEC from EDGAR's observable ingest cadence, NOT from the z
  outcome (anti-shopping; AFML §11.4).
- **OQ-052-2** — the D6 readiness-gate thresholds (N continuous months / max gap
  G days). Pin in the Phase-B SPEC.
- **OQ-052-3** — do the other four EDGAR/FINRA composites (`schedule_13d_g`,
  `eight_k`, `executive_departure`, `short_interest`) need the same
  normalization? Same cross-source pattern in principle; tables empty today
  (never-run ingests) so deferred — re-evaluate per-composite when populated.
- **OQ-C32-2** — Finnhub coverage caveats. Now subsumed by ADR-052 D3 (Finnhub
  demoted); close when the v2 implementation lands.
- **EDGAR/FINRA throttle** — applies to D7 backfill + all five family ingests
  (still EMPTY). Pace; never bulk.
- **CARRIED:** OQ-C31-4 (`INSERT…SELECT FROM <self>` no-ops), OQ-C29-1/2/5,
  OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3, OQ-C19-1,
  OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — implement ADR-052 (CODE), serial after the ratified decision

1. **Composite-worker slice (CODE)** — implement ADR-052 D1-D5 in
   `src/server/form_4_insider.ts` (bump `FORM_4_INSIDER_COMPOSITE_VERSION` →
   `form_4_insider_v2`; add `EDGAR_CANONICAL_SOURCE`) +
   `src/server/form_4_insider_repository.ts` (restrict the cluster-path reads +
   `populateSectorsForCycle` baseline to the canonical source; implement D2
   coverage-day admission; keep per-ticker counts dual-source behind a source-mix
   label per D4). **Spawn a Composite worker + Critic** (NOT an orchestrator
   self-edit — it changes a composite's persisted outputs, outside the
   trivial-edit exception). Tests: source-filter, gap-exclusion (a synthetic gap
   day is NOT zero-filled), version pin, coverage-floor boundary.
2. **Re-backfill** `_backfill_form_4_insider_snapshots.ts` → writes v2 rows;
   verify the Health-Care 2026-05-22 z is no longer ~5.57 (or honestly null if
   the EDGAR-only baseline is too sparse for that sector).
3. **Resolve the quarantine row** (`adr_ref='ADR-052'`, `pending` → `corrected`)
   once the re-backfill confirms the artifact is gone; `resolution_note` → the
   v2 backfill.
4. **Draft `docs/specs/phase-b-form_4_v1.md`** — benchmark universe (SPY + sector
   ETFs), score derivation from v2, the D6 readiness gate, pinning
   `form_4_insider_v2`. Campaign EXECUTION stays gated on D6/D7.

### Alternative stages the operator could pick instead
- Kick off the **D7 EDGAR gap backfill** (operator-paced) so form_4's Phase-B
  clock can start.
- Apply the ADR-052 normalization PRECEDENT to one of the other four EDGAR/FINRA
  composites once its ingest has run (OQ-052-3).
- Resume a deferred reconciliation gap (GAP-16 sentinels; GAP-13 Quartz upgrade
  doc; GAP-10 CI/CD baseline) — all orchestration-owned, independent.

---

## Files / code state

### This session's commit (on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `89adb2c` | `docs/specs/adr-052-form4-source-provenance-normalization.md` (new). Pure docs. |

CH side-effect (not git): one `quantlab.health_quarantine` row (`adr_ref=ADR-052`).
No DDL. No real-money path. No scrape. tsc baseline 13 (all pre-existing
`scripts/_*.ts`).

### Form 4 pipeline map (read this session — for the implementation slice)
- **Composite (pure):** `src/server/form_4_insider.ts` — `computeSectorClusterRate`
  (distinct `person_cik` ≥ 3 → ticker flagged; rate = cluster-tickers/sectorSize),
  `computeZ` (sample stddev, MIN_Z_BASELINE=30), `evaluateForm4InsiderComposite`.
  Reads ALL rows regardless of source (the bug surface).
- **Repository (I/O):** `src/server/form_4_insider_repository.ts` —
  `readTradesForTickersInWindow` (cluster path + baseline both flow through it);
  `populateSectorsForCycle` builds `baseline2y`/`baseline2ySell` per business day
  → THIS is where D1+D2 land (add source filter + coverage-day admission).
- **Ingests:** `scripts/sec_edgar_form4_ingest.py` (EDGAR, real CIK, multi-row/filing),
  `scripts/finnhub_insider_ingest.py` (synthetic `person_cik`, 1 row/filing,
  cross-source dedup skips accessions EDGAR already has).
- **Backfill:** `scripts/_backfill_form_4_insider_snapshots.ts` (canonical daemon
  path; re-run after the v2 change).
- **Pattern:** ADR-051 (`docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`)
  is the Phase-B harness; per-composite SPECs exist for cycle/cross_asset/
  sector_rot/vol_struct (4 of 9). form_4's is the next to draft (gated).

### Key CH facts measured this session (`insider_trades`, 296,219 rows)
- EDGAR `sec_edgar_form4_xml`: 232,286 rows / 117,900 accessions / 41,067 persons;
  1.97 rows/accession (max 52). Finnhub: 63,933 rows = 63,933 accessions = 9,846
  persons; exactly 1.0 row/accession.
- P/S by source: EDGAR P=13,282 S=61,305; Finnhub P=1,260 S=8,153.
- EDGAR P/S active-days in `[2024-05-22,2026-05-21]`: 7 (2024-05), then GAP, then
  ~117 continuous (2025-12→2026-05). **~124 clean days total.**

### DB-state (session-start `npm run health:check`: fresh=3 stale=0 very-stale=12 missing=1 empty=9; migrations 20/20 — IDENTICAL to s96 #30, no NEW Tier-2)
- 12 very-stale = known dev-box daemon-lag (GAP-9, no cron). Tier-1 remediation =
  `npm run daemon:daily` on operator cadence; NOT auto-run (heavy/network; doesn't
  block SPEC work; staleness honestly labelled).
- 9 empty + 1 missing-table = never-run EDGAR/FINRA ingests; panels ship intended
  empty-states. (form_4_insider_snapshots is NOT empty — 98 rows, ~7d stale.)
- `health_quarantine`: now **3 rows** (the new ADR-052 z=5.57 row + the 2 prior
  ADR-045/Q-6 rows).

---

## Watch-outs

### NEW this session
- **The z=5.57 is QUARANTINED + EXPLAINED, not fixed.** Until the ADR-052
  re-backfill lands, `form_4_insider_snapshots` still carries the contaminated z
  and `/#/form-4-insider` renders it. Do not "re-quarantine" it; the row exists
  (`adr_ref='ADR-052'`).
- **Never z-score across a source-provenance boundary** (ADR-052 precedent). The
  baseline and the current value must be the same population — same source-
  identity scheme AND same coverage regime. This generalises to all five
  EDGAR/FINRA composites.
- **A `WHERE source=edgar` filter ALONE is a trap** — it zero-fills the 18-month
  EDGAR gap and worsens the z. The fix is coverage-DAY admission (D2), not a
  row-source filter alone.
- **D5 version bump is mandatory** — the v2 implementation MUST bump
  `FORM_4_INSIDER_COMPOSITE_VERSION`; the constants-sanity test + ADR-051 D8
  trail depend on it. The Phase-B SPEC pins `form_4_insider_v2`.
- **Implementation is a Composite-worker slice, not orchestrator self-edit** — it
  changes a composite's persisted outputs (outside §3.1 trivial-edit exception);
  critic gates it.

### Carried
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every
  composite `loadHistory` (form_4 already follows it).
- **Finnhub `person_cik` is a name-hash (S96-145)** — collides distinct people
  sharing a name; splits one person across spelling variants; unfit for
  cluster-distinctness (the ADR-052 D1 reason).
- **`accepted_at` (NOT `transaction_date`) is the load-bearing anti-leak anchor**
  (F4-10) — a refactor to `transaction_date` injects look-ahead leak.
- **Dev server** does NOT hot-reload server edits — restart after `*_dashboard.ts`
  / `server.ts` edits. Browser-visual validation is the one gate I can't run
  headlessly.
- All prior watch-outs (EDGAR/FINRA per-IP throttle on bulk backfills; gics
  PIT-anchor on wipe; CH-Date range; sp500_constituents PIT gap-window;
  executive_departure dedupe key uses the escape not a literal NUL) preserved.

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot:
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse   # loop until healthy
# CH HTTP probe (used for the S96-146 diagnosis this session):
curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"
# Dev server (visual validation):
npm run dev                        # http://localhost:3000/#/form-4-insider
# After the ADR-052 implementation slice:
#   (Composite worker edits form_4_insider.ts + form_4_insider_repository.ts)
node --import tsx --test scripts/tests/form4InsiderRepository.test.ts \
     scripts/tests/compositeForm4Dashboard.test.ts
node --import tsx scripts/_backfill_form_4_insider_snapshots.ts   # re-backfill v2
# Gates:
npx tsc --noEmit                   # 13 baseline (all in scripts/_*.ts)
npm run health:check
```

---

## For the next session — priority order

**S96-146 is RESOLVED at the decision level (ADR-052).** On `continue`, do the
**CODE** stage: spawn a **Composite worker + Critic** to implement ADR-052 D1-D5
(EDGAR-canonical cluster path + coverage-homogeneous baseline + v1→v2 bump),
re-backfill snapshots, resolve the quarantine row, then draft
`docs/specs/phase-b-form_4_v1.md` (execution gated on D6/D7).

**Do NOT auto-open without operator green-light:** D7 EDGAR gap backfill (bulk,
throttled — pace it); Phase C promotion (Q-8); ALTER DROP/DELETE; `git push`
(Q-4 — 122 commits); broker integration; real-money path.

---

## Important framing for the next chat

**Cycle 34 was a RESEARCH→DESIGN cycle, not a build.** It closed the single
named Phase-B blocker (S96-146) the right way: empirical diagnosis against live
CH → Tier-2 quarantine → a ratified ADR with canon-cited decisions → no silent
calc edit. The artifact (z=5.57) is understood, quarantined, and the resolution
is locked; the implementation is a clean, well-scoped CODE slice for the next
cycle.

**The real story under S96-146:** form_4's clean history is too short and too
provenance-fractured for a meaningful deflation campaign. The honest path is
(1) normalize the composite so the live z stops lying, (2) backfill EDGAR over
the 18-month gap (operator-paced), (3) only THEN run Phase B. The orchestration
will not run a ceremonial campaign on contaminated data — that's the whole point
of the canon.

**UI coverage unchanged = 10 live panels** (regime, cycle_position, etf_flow
+overlay, vol_structure, sector_rotation, cross_asset, form_4, schedule_13d_g,
eight_k, short_interest, executive_departure). No panel work this cycle.
