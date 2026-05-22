# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 96 #3 — **Gap #7 v2 XD13-A2 — Schedule 13D/G pure composite + 22 tests SHIPPED**: second code slice of the third Layer-0 composite under gap #7. 2 commits `74c9d7f` (docs/index.md side-fix) + `afcc418` (XD13-A2 slice) / 3 files / +1585 LOC / 57 new sub-tests (22 SPEC-numbered T-XD13-1..22 + helper coverage). **66 commits ahead of `origin/main`** (was 64). **NEXT default on `continue`:** XD13-A3 — `quantlab.schedule_13d_g_snapshots` migration + `migrate_create_schedule_13d_g_snapshots.ts` + drift-test on the byte-pinned DDL. Alternative: Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter (operator-pickable).

## What this slice delivered

Implements the A2 sub-arc from the s96 #1 SPEC. Pure-function
composite + 22 unit tests; no CH wiring; no daemon changes. Plus
a small side-fix (docs/index.md) that resolves Quartz's
"missing index.md at content root" warning that was 404'ing `/`.

### Two commits (s96 #3)

**`74c9d7f` — docs/index.md — Quartz homepage landing for /.** 1 file, +30 LOC.
Handwritten landing page with curated links to dashboard.md (auto-generated
TOC), conventions, critic_workflow, and top-level sections
(`obsidian/_Index.md`, `specs/`, `decisions/`, `teach/`,
`obsidian/gaps/`, `components/`). Resolves the 404 on `http://localhost:8080/`
when running `npm run docs:serve`. Tangential to gap #7; committed
separately for clean blame.

**`afcc418` — Gap #7 v2 XD13-A2 — Schedule 13D/G pure composite + 22 tests.**
2 files, +1555 LOC:

- **NEW** `src/server/schedule_13d_g.ts` — ~450 LOC pure-function layer.
  Mirrors the EK composite's per-filing shape (closer to 13D/G than F4's
  per-transaction model). Key surface:
  - Form-type partition (XD-1) via `is13DForm` / `is13GForm` /
    `isNew13DForm` / `isAmendmentForm` predicates.
    `SCHEDULE_FORM_TYPES = ['SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A']`
    (the four pinned EDGAR strings).
  - `ScheduleFiling` row type — mirrors the s96 #2
    `schedule_13d_g_filings` raw-event schema (accession, issuerCik,
    issuerTicker, filerCik, filerName, formType, isAmendment, acceptedAt,
    periodOfReport).
  - Per-stock helpers: `dedupeFilings` keyed on `(issuerCik, accession)`
    + `filterFilingsToScheduleForms` (defense-in-depth alongside
    ingest-side filter) + `filterFilingsInWindow` (inclusive boundaries
    matching EK + F4 convention) + `countFilingsBy` +
    `countDistinctFilersBy` + `daysSinceLatestFilingBy`. All
    parameterized on a form-type predicate so one helper covers 13D /
    13G / NEW-13D paths.
  - Aggregate helpers: `computeSectorNew13DRate` (NEW-13D only per
    XD-5 asymmetric filter); `computeZ` + `flagSchedule13DCluster` —
    byte-identical shape to EK + F4 + executive_departure +
    etf_flow + cross_asset_signals + short_interest.
  - `evaluateSchedule13DGComposite` orchestrator — eight per-ticker
    fields per SPEC §5.1 (`new13DFilingFlag30d`, `new13GFilingFlag30d`,
    `recent13DCount90d`, `recent13GCount90d`, `new13DCount90d`,
    `distinct13DFilers90d`, `daysSinceLatest13D`,
    `daysSinceLatest13G`); aggregate per §5.2;
    `Schedule13DGSnapshot` payload per §5.3. Version stamp =
    `'schedule_13d_g_v1'`.
  - `inputsAvailableAggregate` per SPEC §5.3 = sum of finite baseline
    entries across sectors (`Σ_sectors |finite(baseline2y_s)|`); brief
    cold-start guard at `MIN_Z_BASELINE × sectorCount = 330` (11 GICS
    sectors). Differs from sibling EK + F4 which use "sectors with
    non-zero size"; the divergence is documented in the snapshot type
    docstring.
  - `inputsAvailablePerTicker` = rows with ≥ 1 in-window filing
    (informational, not a gate).
  - `maxAggregateZ` + `maxAggregateZSector` with lexicographic tie-break
    (matches EK + F4 brief contract).

- **NEW** `scripts/tests/schedule13dg.test.ts` — ~700 LOC, 57 sub-tests
  total. The 22 SPEC-numbered tests T-XD13-1..22 plus helper coverage:
  - T-XD13-1..3: per-stock flags fire on 30d windows + form-type
    partition; per-stock includes amendments (XD-5).
  - T-XD13-4..5: count semantics + filer dedup.
  - T-XD13-6..7: null days-since-latest on no qualifying filings.
  - T-XD13-8: universe-filter at composite layer.
  - T-XD13-9..15: aggregate sector NEW-13D rate + z-score at
    MIN_Z_BASELINE floor + cold-start null branches + cluster flag
    on |z|>2.0 + XD-5 asymmetric filter (BOTH sides — amendments OUT
    of aggregate, IN per-stock).
  - T-XD13-16..17: 30d / 90d boundary inclusion (inclusive at
    `acceptedAt = asOf - Nd 00:00:00`; exclusive at `asOf - Nd - 1ms`).
  - T-XD13-18: composite-side acceptance-date anti-leak.
  - T-XD13-19..20: 13G-only / mixed 13D+13G ticker.
  - T-XD13-21: version stamp = 'schedule_13d_g_v1'.
  - T-XD13-22: `inputsAvailableAggregate` semantics (sum of non-NaN
    baseline entries across sectors).
  - Plus helper-coverage suites for `dedupeFilings`,
    `filterFilingsToScheduleForms`, `countFilingsBy`,
    `countDistinctFilersBy`, `daysSinceLatestFilingBy`.

### What this slice does NOT ship (carried per SPEC §10)

- No `quantlab.schedule_13d_g_snapshots` table or migration —
  **XD13-A3** slice (NEXT).
- No `src/server/schedule_13d_g_repository.ts` — XD13-A4 slice.
- No daemon hook position 1m wired — XD13-A4 slice.
- No brief section #16 renderer — XD13-A5 slice.

### Verification gates at commit time (all green)

```text
npm test                                            # 2996 pass / 1 fail (pre-existing) / 28 skip
.venv/Scripts/python.exe -m pytest scripts/tests   # 377 pass (unchanged — no Python touched)
npx tsc --noEmit                                    # 13 baseline errors unchanged
npm run check:help                                  # green
```

The single `npm test` failure is the pre-existing CH-unreachable
`gicsSectorRepositoryHelper SMP-6` — confirmed NOT a regression
(persists across all recent slices).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted + implementation LIVE | ✓ s89c#2 + s95 #5 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow arc (v1 + v2 + v3) | ✓ DONE end-to-end (s92, s95 #8, s95 #9) |
| Gap #7 EK arc (A1..A5) + per-row + per-EVENT recency | ✓ DONE end-to-end (s93..s95 #7) |
| Gap #7 F4 arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93..s95 #4) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH/ACCEPTED | ✓ s94 #1-#6 |
| ADR-042 Steps 1-5 + OQ-G2-1 sub-slice | ✓ s94 #6-#11 |
| Gap #7 v2 sell-cluster F4 composite + G3 | ✓ s95 #1-#2 (F4 ARC FULLY CLOSED) |
| ADR-041 implementation | ✓ s95 #5 |
| Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions | ✓ s95 #6 |
| Gap #7 v2 per-EVENT EK recency | ✓ s95 #7 (EK v2 ARC FULLY CLOSED) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation FRAMEWORK | ✓ s95 #8 |
| Gap #9 v3 issuer-CSV live secondary panel ingest | ✓ s95 #9 (GAP #9 ARC FULLY CLOSED v1+v2+v3) |
| Gap #7 v2 Schedule 13D/13G arc — SPEC + ADR-043 | ✓ s96 #1 (`d68c2ab`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A1 (ingest) | ✓ s96 #2 (`3796fde`) |
| **Gap #7 v2 Schedule 13D/13G arc — XD13-A2 (pure composite + 22 tests)** | **✓ s96 #3 (`afcc418`) — 2 files / +1555 LOC / 57 sub-tests** |
| Quartz `/` 404 fix (docs/index.md) | ✓ s96 #3 (`74c9d7f`) — operator-side; restart `docs:serve` to pick up |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A3 (snapshot table + migration) | ☐ NEXT (recommended default on `continue`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A4..A5 | ☐ queued after A3 |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 66 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 96 #3 (this slice)

**S96-12. `inputsAvailableAggregate` semantic is sum-of-finite-baseline-entries across sectors, NOT count of non-null rates.** The metric is `Σ_sectors |{b ∈ baseline2y_s : Number.isFinite(b)}|`. Brief cold-start guard fires at `MIN_Z_BASELINE × sectorCount = 30 × 11 = 330` (11 GICS sectors).
`Why:` SPEC §5.3 wording: "count of (sector, day) tuples with non-null new_13d_rate over the 2y baseline used at this snapshot". The threshold value (330) only makes sense if summed across the panel, not the snapshot. This diverges from the EK + F4 sibling implementations (which use `if (s.sectorSize > 0) inputsAvailableAggregate++;`); the SPEC §5.3 contract for XD13 is more demanding because the aggregate uses a single track (NEW-13D rate) so the cold-start state needs richer panel-level evidence.
`How to apply:` Reuse `computeZ`'s `baselineSize` return value — it already filters non-NaN entries and is computed regardless of whether `z` is null. Accumulate `inputsAvailableAggregate += baselineSize` inside the per-sector loop. Test T-XD13-22 pins the semantic (sums + NaN-filtering).

**S96-13. Form-type predicates are 4-way partition with explicit asymmetric helpers.** `is13DForm` and `is13GForm` are inclusive of /A; `isNew13DForm` matches only 'SC 13D' (NOT '/A'); `isAmendmentForm` covers both /A variants.
`Why:` SPEC's XD-5 asymmetry (aggregate excludes amendments, per-stock includes them) is load-bearing. A single "is13D" predicate that ambiguously includes /A would force every caller to re-check `isAmendment` at the call site — easy to forget, easy to silently break the asymmetric filter. Two distinct predicates make the asymmetry explicit at the call site.
`How to apply:` Aggregate path uses `isNew13DForm`; per-stock path uses `is13DForm`. The orchestrator calls each exactly once. Future refactors that consolidate into a single predicate will silently break either the announcement-effect signal or the per-stock forensic coverage.

**S96-14. `inputsAvailablePerTicker` semantic = rows with ≥ 1 in-window filing across ANY form type.** The metric does NOT discriminate 13D from 13G; it counts ticker rows with non-empty 90d window coverage.
`Why:` Informational coverage gauge for the per-stock signal, not a gate. The brief renderer (XD13-A5) will use it to show "X/N tickers have current filings" — for that purpose, treating 13D + 13G as equal contributors is the right call (both are signal). The CIK-coverage gauge ("tickers with current CIK mapping") is a separate metric handled at the repository (XD13-A4) layer.
`How to apply:` Increment inside the per-ticker loop when `recent13DCount90d + recent13GCount90d > 0`. Test T-XD13-22 confirms the 13G-only ticker still counts toward `inputsAvailablePerTicker`.

**S96-15. Composite-layer acceptance-date anti-leak gate is defense in depth, NOT optional.** Filings with `acceptedAt > asOf` are rejected at composite-read time by `filterFilingsInWindow`, mirroring the ingest-layer rejection in `sec_edgar_13d_g_ingest.py`.
`Why:` SPEC §11 watch-out #8 + EDF-5 inheritance. The ingest layer enforces it at parse-time, but the composite is a separate reading boundary — a CH-rewind on the snapshot date would otherwise read tomorrow's ingest as today's window. Defense in depth.
`How to apply:` `filterFilingsInWindow` is the single source of truth. Test T-XD13-18 pins the composite-side gate via a synthetic future-dated filing.

**S96-16. Quartz `docs/` content root needs `index.md` to serve `/`.** Created handwritten landing page linking to dashboard.md (auto-generated TOC) + curated entry points to top-level sections.
`Why:` Quartz emits a warning ("missing index.md home page file") and 404s `/` without it. Auto-generated `dashboard.md` works at `/dashboard` but `/` is the natural entry point. The handwritten index doesn't conflict with the generator (only `dashboard.md` is auto-generated; `index.md` is hand-maintained).
`How to apply:` `docs/index.md` is a small (~30 LOC) hand-maintained landing page. Do NOT regenerate it from any script; future expansion (e.g. linking to new top-level sections) is a manual edit. If the operator later decides the dashboard SHOULD be the homepage, the cleanest refactor is to modify `scripts/generate_docs_dashboard.ts` to emit `docs/index.md` and delete the current handwritten file; the divergence is preserved for future judgment.

**Carry-overs (still in force):** S96-1..S96-11 (all s96 #1 + s96 #2 decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### Newly opened (s96 #3)

None. The composite is a mechanical implementation of SPEC §5.1-§5.3
locked at s96 #1; no canon-thin forks emerged at implementation time.

### CARRIED (unchanged from s96 #2)

- **OQ-XD13-1.** Phase B independence-test threshold for form-type-only signal. Estimated gate: ~6-8 weeks of `schedule_13d_g_filings` ingest history after XD13-A1 (LIVE s96 #2) + a backfill arc to populate historical baseline. Calendar clock started s96 #2.
- **OQ-XD13-2.** v2 filer-reputation table sourcing: hand-maintained vs auto-learned. UNCHANGED.
- **OQ-XD13-3.** Sector-only vs cap-tier-overlay aggregate slicing. UNCHANGED.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- Push commits to origin/main — operator-gated.
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD13 arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- OQ-G2-2 — EDGAR-amendment forensic tooling default (LOW priority, deferred).
- OQ-G9-1 — issuer-specific schema mappers. RECOMMEND State Street SPDR.

## Next stage

### Default on `continue` — recommended: XD13-A3 (snapshot table + migration)

The composite + raw-event ingest are live; the natural next code slice
is XD13-A3 (snapshot table migration). This is the SQL/storage half;
no composite changes.

1. **NEW** `scripts/migrate_create_schedule_13d_g_snapshots.ts` —
   ~190-220 LOC. Source-table migration matching the byte-pinned DDL
   from SPEC §6 lines 384-400:

   ```sql
   CREATE TABLE quantlab.schedule_13d_g_snapshots (
     snapshot_date              Date,
     last_edgar_query_at        Nullable(DateTime),
     bd_since_last_query        Nullable(Int32),
     schedule_13d_cluster_flag  UInt8,
     flagged_sectors_json       String,
     per_ticker_json            String,
     inputs_available_aggregate UInt32,
     inputs_available_per_ticker UInt32,
     composite_version          LowCardinality(String) DEFAULT 'schedule_13d_g_v1',
     ingested_at                DateTime DEFAULT now()
   ) ENGINE = ReplacingMergeTree(ingested_at)
   ORDER BY (snapshot_date, composite_version)
   SETTINGS index_granularity = 1024;
   ```

   Pattern mirrors `scripts/migrate_create_schedule_13d_g_filings.ts`
   from s96 #2: pre-checks (table absence + pending mutations) +
   post-checks (all 10 expected columns present); idempotent
   `CREATE TABLE IF NOT EXISTS`; inline `help: HelpEntry[]` exports
   for the npm-script wrapper.

2. **NEW** `scripts/tests/migrateCreateSchedule13DGSnapshots.test.ts`
   — ~250-300 LOC. T-XD13M-1..5 per SPEC §9.5:
   - T-XD13M-1: dry-run prints planned DDL without executing.
   - T-XD13M-2: apply executes `CREATE TABLE IF NOT EXISTS`.
   - T-XD13M-3: pre-checks validate CH connectivity + database
     existence.
   - T-XD13M-4: post-checks validate table existence via
     `system.tables` probe.
   - T-XD13M-5: re-run is idempotent.

3. **modified** `package.json` — 2 new npm scripts:
   - `migrate:create-schedule-13d-g-snapshots` (dry-run)
   - `migrate:create-schedule-13d-g-snapshots:apply` (apply)

Estimated: 2-3 files / ~500-600 LOC / 5 tests / 1 commit.

### Alternative slices (operator-pickable)

If operator prefers a different next slice:

- **Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter** —
  ~250-300 LOC. Automates the manual CSV drop for the SPDR ETF
  family (11 of 21 ETFs).

- **Gap #7 v2 event-driven cadence promotion** — Phase B-gated.

- **Gap #7 v2 CMP opportunistic-vs-routine classifier** —
  calendar-gated ≥6mo from F4-A1 first apply-run.

- **C-12 Phase B AlpacaAdapter** — operator-decision; paused.

- **Phase B campaigns for the nine Layer-0 composites** — calendar
  OR backfill arc.

- **Quartz docs site extensions** — live dashboard watcher,
  teach-doc frontmatter rollout, promote ADR-040 status, etc.

- **Renderer docstring refresh** — `operator_brief_render.ts` stale
  comment for the EK section (carry).

### Operator-gated action items (carried + new)

**NEW from s96 #3:**

- **`docs/index.md`** (s96 #3, `74c9d7f`): restart any running
  `npm run docs:serve` process to pick up the new landing page;
  no further action needed.

**CARRIED (unchanged from s96 #2):**

- (carried) Run `npm run migrate:create-schedule-13d-g-filings:apply`
  once per environment.
- (carried) Run `npm run edgar:13d-g:ingest --apply` to populate the
  raw-event table. Recommend `--start-date <D-180>` on first run for
  ~6mo backfill. Optional `--resolve-filer-names` to populate names
  today (or defer to v2 ADR).
- (carried) Run `npm run docs:install` once (per clone).
- (carried) Re-run `npm run macro:backfill:v3` (non-blocking).
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply the pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3).
  - `migrate:create-etf-shares-outstanding-secondary:apply`.
- (carried) Create `data/etf_flow_issuer_csv/` + drop canonical-schema CSVs.
- (carried) Push 66 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this slice (s96 #3 — 2 commits)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/index.md` | +30 (NEW) | Quartz landing page; resolves `/` 404. Hand-maintained. Tangential to gap #7. |
| `src/server/schedule_13d_g.ts` | +~450 (NEW) | Pure-function composite. Form-type partition + per-stock metrics + aggregate NEW-13D rate per XD-5 asymmetric filter + snapshot type + orchestrator. Mirrors EK shape (per-filing). |
| `scripts/tests/schedule13dg.test.ts` | +~700 (NEW) | 22 SPEC-numbered tests T-XD13-1..22 + helper-coverage suites. 57 sub-tests, all green. |

### CH state (no apply this slice — operator-gated)

Migrations still pending operator apply:
- `quantlab.schedule_13d_g_filings` — DDL ready in
  `scripts/migrate_create_schedule_13d_g_filings.ts` (from s96 #2).
- `quantlab.schedule_13d_g_snapshots` — NOT YET MIGRATED (XD13-A3
  ships the migration).
- Other carried pending migrations per s96 #2 HANDOFF.

### Tests (new this slice)

- `scripts/tests/schedule13dg.test.ts`: 57 sub-tests pass.
- Full npm test at commit time: 2996 passed (was 2939; +57 new) / 1
  failed (pre-existing CH-unreachable, NOT a regression) / 28 skipped.
- Full pytest at commit time: 377 passed (unchanged — no Python touched).
- `npx tsc --noEmit` baseline: 13 errors unchanged.
- `npm run check:help`: green.

## Watch-outs

### NEW from this turn (s96 #3)

- **XD-5 asymmetric filter (load-bearing at the composite layer).**
  `computeSectorNew13DRate` filters to `isNew13DForm` (excludes /A);
  per-stock helpers (`countFilingsBy(..., is13DForm, ...)`) include /A.
  Any refactor that consolidates the two paths into a single "use this
  filter everywhere" approach will silently break either the
  announcement-effect signal (Brav-Jiang-Partnoy-Thomas 2008) or the
  per-stock forensic coverage. The two helpers + four-way form-type
  predicates make the asymmetry explicit at the call site.

- **`inputsAvailableAggregate` diverges from sibling-composite
  semantics.** EK + F4 + others use "sectors with non-zero size"; XD13
  uses "sum of finite baseline entries across sectors" per SPEC §5.3.
  Future refactors that consolidate the metric across composites would
  silently break the XD13 cold-start guard (threshold 330, not
  "11 non-null sectors"). Documented in the snapshot type docstring.

- **`inputsAvailablePerTicker` does NOT discriminate 13D vs 13G.** Both
  contribute to the gauge. The brief's "X/N tickers have current
  filings" message should NOT be interpreted as "X tickers with
  activist activity"; for that, gate on `recent13DCount90d > 0`
  per-row.

- **`assertClose(actual, expected, msg)` is wrong — msg is `eps`.**
  Initial test draft passed message strings as the third arg, which
  caused `Math.abs(...) < "string"` → NaN → false. Fixed before commit;
  future tests should use `assertClose(actual, expected)` without a
  message arg (the assertion-failure message is sufficient).

- **`docs/index.md` is hand-maintained.** The Quartz dashboard
  generator (`scripts/generate_docs_dashboard.ts`) writes
  `docs/dashboard.md`; do NOT extend it to also write `docs/index.md`
  without operator sign-off. The two files serve different purposes
  (TOC vs landing page) and conflating them risks losing the
  hand-curated entry points.

### Carried from s96 #2

All s96 #1 + s96 #2 watch-outs preserved unchanged. Key carry-overs:

- The SPEC is the contract for XD13-A3..A5 — any divergence is a SPEC
  violation, not a SPEC update.
- Issuer/filer split structural (s96 #2 watch-out).
- Filer-name resolution is opt-in via `--resolve-filer-names`.
- DDL byte-pinned across Python ingest + TS migration.
- `is_amendment` derived from `form_type` suffix (now also tested at
  composite layer via `isAmendmentForm` predicate).
- Filer CIK ≠ issuer CIK at every layer.
- Pre-filing return capture is structurally impossible.
- 13G is canon-documented to carry signal (Edmans-Fang-Zur 2013).
- All earlier s89-s95 #9 watch-outs preserved.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Quartz docs site (carried + docs/index.md added)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080 (now serves / via docs/index.md)
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Gap #7 v2 Schedule 13D/G (A1 + A2 LIVE; A3 NEXT)

```text
# Operator-pending (XD13-A1 first run):
npm run migrate:create-schedule-13d-g-filings           # dry-run
npm run migrate:create-schedule-13d-g-filings:apply     # apply DDL
npm run edgar:13d-g:ingest:dry                          # dry-run
npm run edgar:13d-g:ingest                              # apply ingest
# Optional: resolve filer names today (v2 ADR will lift this default):
.venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py --resolve-filer-names --apply
# Once XD13-A3 lands (NEXT):
npm run migrate:create-schedule-13d-g-snapshots:apply
# Once XD13-A4 lands:
npm run daemon:daily                                    # populates schedule_13d_g_snapshots
# Once XD13-A5 lands:
npm run brief:morning                                   # §16 renders
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE; per-row + per-EVENT recency BOTH LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow (v1 + v2 + v3 ALL LIVE)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest                                          # v1 yfinance primary
npm run migrate:create-etf-flow-snapshots:apply
npm run migrate:create-etf-shares-outstanding-secondary:apply    # v3 — one-time
# Drop canonical-schema CSVs (header: ticker,date,shares,close) in data/etf_flow_issuer_csv/, then:
npm run etf:flow:issuer-csv:ingest:dry
npm run etf:flow:issuer-csv:ingest
npm run daemon:daily
npm run brief:morning                                            # §13 sub-section
```

### macro_regime_v3 — re-backfill (operator-pending)

```text
npm run macro:backfill:v3
```

### Tests + dev

```text
npm test                                                                       # TS — last green at s96 #3 close: 2996 pass / 1 fail / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #3 close: 377 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #3 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 301 emitted from 115 inputs (after docs/index.md)
```

## For the next session — priority order

**Default on `continue`:** **XD13-A3** — `quantlab.schedule_13d_g_snapshots`
migration + drift-tested DDL. Pattern established from the s96 #2
sibling migration `scripts/migrate_create_schedule_13d_g_filings.ts`.
Estimated 2-3 files / ~500-600 LOC / 5 tests / 1 commit.

**Acceptance criteria** for XD13-A3:

- ✓ `npm test` green at +5 new migration tests.
- ✓ `npx tsc --noEmit` baseline-clean.
- ✓ `npm run check:help` green.
- ✓ `migrate_create_schedule_13d_g_snapshots.ts` follows the s96 #2
  migration template exactly (pre/post checks, idempotent
  `CREATE IF NOT EXISTS`, inline help exports).
- ✓ DDL matches SPEC §6 lines 384-400 byte-for-byte (column names,
  types, defaults, ENGINE, ORDER BY, SETTINGS).
- ✓ 2 new npm scripts (`migrate:create-schedule-13d-g-snapshots` +
  `:apply`).
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6`
  failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the
default-next:

- **Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter** (~250-300 LOC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions**.
- **Renderer docstring refresh** for the EK section (stale).

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- **Schedule 13D/G Phase B independence test** — earliest ~2026-07-20
  (assumes first apply-run lands in s96 + ~6-8 weeks of ingest
  history; backfill arc could compress this).

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**Gap #7 now has THREE parallel Layer-0 composites with the same shape
of progress:**

- **EK (8-K classifier)** — DONE end-to-end (s93..s95 #7), with per-EVENT recency LIVE.
- **F4 (Form 4 insider)** — DONE end-to-end (s93..s95 #4), with sell-cluster + per-row recency LIVE.
- **XD13 (Schedule 13D/13G activist-stake)** — **A1 + A2 LIVE
  (s96 #2 + s96 #3); A3 NEXT.** SPEC + ADR shipped s96 #1; ingest +
  raw-event table shipped s96 #2; pure composite + 22 tests shipped
  s96 #3. A3..A5 queued.

**The arc-shape parity is load-bearing.** XD13-A3 is the sibling of
F4-A3 + EK-A3. The shared infrastructure (`_sec_edgar_helpers.py`,
`cik_ticker_map`, acceptance-date anti-leak gate, ReplacingMergeTree
idempotency, version stamps, snapshot table structure) is established
across EK + F4 + XD13. The XD13 differences (carried from s96 #2 +
extended by s96 #3):

- **Form type set.** XD13 = `{SC 13D, SC 13D/A, SC 13G, SC 13G/A}`.
- **Schema shape.** XD13's raw-event table has no item_code; has
  `filer_cik` + `filer_name`. Snapshot table mirrors EK + F4 shape
  but with `flagged_sectors_json` (NEW-13D rate per sector) + a
  per-ticker JSON column (no per-form sub-flags — they're in the JSON).
- **Composite logic.** XD13 = form-type-only proxy (XD-1) with the
  XD-5 asymmetric filter (aggregate = NEW-13D only; per-stock includes
  amendments).
- **`inputsAvailableAggregate` semantic** diverges from EK + F4 —
  XD13 sums baseline entries across sectors per SPEC §5.3 (cold-start
  guard at 330).
- **Brief section** (XD13-A5 ships this). XD13 = #16.

**The v2 layers (filer reputation, NLP, supersession, cover-page %
parse) are all gated on Phase B + their own ADRs.** Do NOT auto-open
them.

**Backward compat preserved on three fronts:**

1. **CH:** No DDL apply this slice (operator-gated). The XD13-A3
   slice (NEXT) ships an idempotent `CREATE IF NOT EXISTS`
   migration safe to apply at any time.
2. **Type:** New TS types this slice (`ScheduleFiling`,
   `Schedule13DGPerTickerRow`, `Schedule13DGFlaggedSector`,
   `Schedule13DGInputs`, `Schedule13DGSnapshot`). All additive;
   nothing existing changed.
3. **Daemon:** Code untouched this slice. Future A4 slice wires step 1m.

**Parallel-tracks posture continues.** s96 #3 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Code-only slice — daemon
output unchanged + brief output unchanged.

**The chain through s96 #3:**

```text
ALL S41-S95 WORK                                        ✓ as documented
S96 #1: SPEC + ADR-043                                  ✓ committed (d68c2ab)
S96 #2: XD13-A1 — ingest + raw-event table              ✓ committed (3796fde)
S96 #3: docs/index.md — Quartz landing                  ✓ committed (74c9d7f)
S96 #3: XD13-A2 — pure composite + 22 tests             ✓ committed (afcc418)
        — src/server/schedule_13d_g.ts (~450 LOC)
        — scripts/tests/schedule13dg.test.ts (~700 LOC, 57 sub-tests)
S96 #3 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: XD13-A3 (snapshot table + migration).
                  Sibling of F4-A3 + EK-A3. Pattern
                  established; ~2-3 files, ~500-600 LOC,
                  5 tests, 1 commit.
  → background: brief §16 placeholder; activates as
                soon as XD13-A5 lands. Until then,
                daily daemon runs unchanged.
```
