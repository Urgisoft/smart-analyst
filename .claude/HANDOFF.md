# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 96 #5 — **Gap #7 v2 XD13-A4 — Schedule 13D/G repository + daemon hook 1m + 47 tests SHIPPED**: fourth code slice of the XD13 arc. 1 commit `5cf8c84` / 3 files / +1888 LOC / 47 new sub-tests covering SPEC §9.2 T-XD13R-1..T-XD13R-Nplus5 + 5 EXPLAIN PLAN gates + a shared aggregateLogLine regex regression. **69 commits ahead of `origin/main`** (was 68). **NEXT default on `continue`:** XD13-A5 — brief renderer section #16 + `operatorBriefRender` tests (T-OBR-XD13-1..7). Alternative: Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter (operator-pickable).

## What this slice delivered

Implements the A4 sub-arc from the s96 #1 SPEC. New repository wires the
pure composite (XD13-A2) to CH storage + the daily daemon (step 1m,
between Form 4 / 1l and §2 cells/bundles per SPEC §7). No brief
renderer changes (XD13-A5 slice); no further CH apply (operator-gated).

### One commit (s96 #5)

**`5cf8c84` — Gap #7 v2 XD13-A4 — Schedule 13D/G repository + daemon hook 1m + 47 tests.**
3 files, +1888 LOC:

- **NEW** `src/server/schedule_13d_g_repository.ts` (~970 LOC).
  Sibling of `src/server/form_4_insider_repository.ts` +
  `src/server/eight_k_classifier_repository.ts`. Surface:
  - `Schedule13DGRepository` class: constructor (defaults to
    `quantlab.schedule_13d_g_filings` + the other Layer-0 default
    tables, all overridable for tests); `readLatestAcceptedAt` (latest
    `accepted_at <= asOf`, 1970 sentinel coerced to null);
    `readFilingsForTickersInWindow` (subquery-around-FINAL, NO
    form-type SQL narrow — composite is the only form-type gate,
    defense in depth); `readSp500ConstituentsPIT` (latest
    effective_date ≤ asOf, fallback pattern matches F4 / EK siblings);
    `readEquityMidcapWatchUniverse` (candles `^[A-Z]{1,5}_USD$` strip);
    `readCikByTicker` (subquery-around-FINAL); `readSectorByTicker`
    (thin wrapper over the shared `readGicsSectorByTicker` helper);
    `populateSectorsForCycle` (XD-5 asymmetric: `computeSectorNew13DRate`
    per panel day across the 2y baseline window, today's 90d filings
    sliced for `s.filings`); `readInputsForCycle` (Promise.all across
    the five readers); `writeSnapshot` (writes EXACTLY the 10 SPEC §6
    columns — NO `computed_at`, NO `max_aggregate_z` /
    `max_aggregate_z_sector`, NO explicit `ingested_at` since CH
    `DEFAULT now()` fills); `loadLatestSnapshot` (FINAL + ORDER BY
    snapshot_date DESC LIMIT 1; derives maxAggregateZ from
    flaggedSectors at read time — lexicographic tie-break matches
    composite convention); `filingsTableExists` instance method
    (respects custom filingsTable name for tests).
  - Module-level helpers: `schedule13dgSnapshotsTableExists`,
    `schedule13dgFilingsTableExists` (both via internal
    `tableExistsInternal` that splits `database.table` and binds via
    `query_params`); `businessDaysBetween` (Mon-Fri excluded-start,
    included-end, matches all Layer-0 siblings);
    `runDaemonSchedule13DGEvaluation` orchestrator with the SPEC §7
    cold-start branch — empty `Schedule13DGInputs` synthesized when
    source table absent, snapshot still persisted (daemon-side gates
    snapshots-absent separately).
  - aggregateLogLine emits `[xd-aggregate]` prefix matching the shared
    SPEC §5.5 regex pin `(xd|ek|f4)-aggregate\] … max_z=… cluster_flag=…`.

- **modified** `scripts/daily_signal_daemon.ts` (+46 LOC).
  Step 1m wired between 1l form-4 and §2 cells/bundles per SPEC §7.
  Gated by `NO_MACRO || DRY_RUN`; `schedule13dgSnapshotsTableExists`
  gate at daemon side skips with operator nudge if absent; filings-
  table-absent handled inside the orchestrator (cold-start snapshot
  emitted + persisted, not skipped — diverges from F4 + EK posture).

- **NEW** `scripts/tests/schedule13dgRepository.test.ts` (~870 LOC, 52
  sub-tests: 47 active + 5 EXPLAIN PLAN gates that skip when CH or
  table is unreachable). Coverage:
  - Constants (FILING_WINDOW_DAYS = 90; BASELINE_CALENDAR_DAYS = 730).
  - businessDaysBetween parity (4 sub-tests).
  - readLatestAcceptedAt — 1970 sentinel + null + subquery-around-FINAL
    + param bind (4 sub-tests).
  - readFilingsForTickersInWindow — no SQL form-type narrow, ticker
    filter, accepted_at window bind, is_amendment UInt8 decoding,
    periodOfReport parsing, rejection of unparseable accepted_at,
    windowDays override (6 sub-tests).
  - readSp500ConstituentsPIT, readEquityMidcapWatchUniverse,
    readCikByTicker, readSectorByTicker (8 sub-tests across 4 readers).
  - readInputsForCycle — sector populated when gics_sector_map row
    exists; cold-start fallback (2 sub-tests).
  - writeSnapshot — T-XD13R-1 round-trip + explicit 10-column shape
    pin + non-presence assertions for `computed_at`, `max_aggregate_z`,
    `max_aggregate_z_sector`, `ingested_at` (4 sub-tests).
  - loadLatestSnapshot — T-XD13R-Nplus round-trip + malformed-JSON
    degrade + maxAggregateZ derivation from flaggedSectors +
    lexicographic tie-break (5 sub-tests).
  - schedule13dg{Snapshots,Filings}TableExists + instance probe +
    catch-all-on-error — T-XD13R-Nplus2 (5 sub-tests).
  - runDaemonSchedule13DGEvaluation — T-XD13R-Nplus3 happy path
    (write + summary line), T-XD13R-Nplus4 cold-start (snapshot
    written, no source reads emitted), T-XD13R-Nplus5 SQL-layer
    accepted_at filter, aggregateLogLine shape regression, universe
    resolution from CH (5 sub-tests).
  - EXPLAIN PLAN grammar gates (6 sub-tests; skip when CH unreachable
    or source table absent — same posture as F4 / EK siblings).

### What this slice does NOT ship (carried per SPEC §10)

- No CH apply of either XD13 table — operator-gated.
- No `operator_brief_render.ts` section #16 — **XD13-A5** slice (NEXT).
- No v2 `max_aggregate_z` columns persistence — deferred per SPEC §6
  / S96-17 (Schedule13DGSnapshot still carries `maxAggregateZ` +
  `maxAggregateZSector` in memory + in the daemon aggregate log line;
  loadLatestSnapshot derives them from flaggedSectors at read time).

### Verification gates at commit time (all green)

```text
npm test                                            # 3077 pass / 1 fail (pre-existing) / 33 skip
.venv/Scripts/python.exe -m pytest scripts/tests   # 377 pass (unchanged — no Python touched)
npx tsc --noEmit                                    # 13 baseline errors unchanged
npm run check:help                                  # green
```

Pass-count diff +47 = exactly the new active sub-tests in this slice;
skip-count diff +5 = exactly the new EXPLAIN PLAN gates that skip when
the live CH lacks the underlying tables. No regressions. The single
`npm test` failure is the carry-forward `gicsSectorRepositoryHelper
SMP-6` infra-side EXPLAIN PLAN rejection.

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
| Gap #7 v2 Schedule 13D/13G arc — XD13-A2 (pure composite + 22 tests) | ✓ s96 #3 (`afcc418`) |
| Quartz `/` 404 fix (docs/index.md) | ✓ s96 #3 (`74c9d7f`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A3 (snapshot table + migration) | ✓ s96 #4 (`90dd459`) |
| **Gap #7 v2 Schedule 13D/13G arc — XD13-A4 (repository + daemon hook 1m)** | **✓ s96 #5 (`5cf8c84`) — 3 files / +1888 LOC / 47 sub-tests** |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A5 (brief renderer §16) | ☐ NEXT (recommended default on `continue`) |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 69 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 96 #5 (this slice)

**S96-20. XD13 repository `writeSnapshot` writes EXACTLY 10 columns; non-presence is asserted in tests.** The XD13 snapshot table omits `computed_at DateTime64(3)`, `max_aggregate_z`, `max_aggregate_z_sector`, and `ingested_at` (CH DEFAULT-filled). The test file pins this via `assert.equal('computed_at' in row, false)` (etc.) so any future "consolidate snapshot writers into a shared base" refactor will hard-fail at write time rather than silently re-introducing the EK/F4 columns into a SPEC-violating shape.
`Why:` SPEC §6 is prescriptive (10 columns; ORDER BY (snapshot_date, composite_version); RMT(ingested_at); index_granularity = 1024). The EK + F4 snapshot tables have evolved away from SPEC defaults via ADR-042 + s95 #2 add-* migrations; XD13 has NOT yet taken that evolution. The test pin enforces the SPEC contract end-to-end.
`How to apply:` If a future v2 ADR adds `max_aggregate_z` columns to XD13 (the natural next step for cross-day brief-renderer observability), it MUST ship as a separate add-* migration + relax the assertions in the test file. Until then, the 10-column shape is load-bearing.

**S96-21. v1 cross-day max-z recovery is derived from `flaggedSectors` at read time.** `loadLatestSnapshot` walks the JSON-stored `flaggedSectors` array (sectors with `|z| > THRESHOLD` only) and picks max-|z| with lexicographic tie-break, matching the composite convention. Sectors with non-null z but |z| ≤ THRESHOLD are LOST on a round-trip.
`Why:` SPEC §6 doesn't persist max_aggregate_z columns in v1. The brief renderer (XD13-A5) needs SOME cross-day signal for the section #16 panel; the choice was either (a) ship the columns, or (b) derive from flaggedSectors. Option (b) is correct for v1 because the brief only renders flagged sectors anyway; the "next closest" panel is a v2 feature, not v1.
`How to apply:` XD13-A5 brief renderer can rely on `loadLatestSnapshot().maxAggregateZ` for the "today's biggest sector signal" annotation, with full awareness that it's null when no sector exceeds threshold (cold-start branch in the renderer). If a v2 ADR adds the columns + the renderer adds a "next closest" panel, the read-time derivation can be replaced with the persisted column value transparently.

**S96-22. Orchestrator `runDaemonSchedule13DGEvaluation` handles source-table-absent INTERNALLY (not at the daemon-side gate).** Diverges from F4 + EK posture where daemon-side `*EventsTableExists` / `insiderTradesTableExists` checks gate the orchestrator entirely. XD13's orchestrator instead checks `filingsTableExists` internally; on absence, synthesizes empty `Schedule13DGInputs` (no perTicker, no sectors, lastEdgarQueryAt=null) and falls through to `evaluateSchedule13DGComposite` → `writeSnapshot`.
`Why:` SPEC §7 wording is explicit: "Absent-table-safe + non-fatal: if `schedule_13d_g_filings` is missing, the hook returns a cold-start snapshot ... and continues." This is a deliberate divergence from F4/EK to ensure the brief renderer (A5) ALWAYS has a recent XD13 snapshot to render, even when XD13-A1 ingest has never run. F4/EK's "skip entirely" posture leaves their sections in a "previous-snapshot or absent" state; XD13 wants "always today's snapshot, possibly cold-start."
`How to apply:` Daemon-side at step 1m gates ONLY on `schedule13dgSnapshotsTableExists` (the write target). If snapshots table is absent → skip with operator nudge (matches F4/EK at the snapshots side). The orchestrator gates filings absence. Tests T-XD13R-Nplus3 (happy path) + T-XD13R-Nplus4 (cold-start) pin both branches.

**S96-23. The 5 SPEC T-XD13R labels structure 47 sub-tests, NOT 5.** Each SPEC label (T-XD13R-1, T-XD13R-Nplus, T-XD13R-Nplus2, T-XD13R-Nplus3, T-XD13R-Nplus4, T-XD13R-Nplus5) is satisfied by multiple granular sub-tests grouped under `describe()` blocks named per the SPEC label. Pattern matches the s96 #4 migration test file convention (S96-18).
`Why:` SPEC §9.2's T-XD13R labels are intentionally coarse (one per responsibility — writeSnapshot, loadLatest, tableExists, orchestrator, orchestrator cold-start, anti-leak). Granular sub-tests under each label make individual failure modes self-locating. Net test count is allowed to exceed the SPEC's coarse label count.
`How to apply:` Future slices (XD13-A5 renderer tests) should follow the same convention: SPEC labels at the describe-block level; granular assertions at the `it()` level.

**Carry-overs (still in force):** S96-1..S96-19 (all s96 #1 + s96 #2 + s96 #3 + s96 #4 decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### Newly opened (s96 #5)

None. The repository is a mechanical implementation of SPEC §3 + §5
+ §7; no canon-thin forks emerged at implementation time. The
divergence from F4/EK cold-start posture (S96-22) is explicitly
spelled out in SPEC §7, not a canon-thin fork.

### CARRIED (unchanged from s96 #4)

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

### Default on `continue` — recommended: XD13-A5 (brief renderer section #16)

The repository + daemon hook are live; the natural next code slice is
XD13-A5 (brief renderer). This makes the daily snapshot visible in the
morning brief and closes the XD13 arc end-to-end (A1..A5).

1. **modified** `src/server/operator_brief_render.ts` — add a new
   section #16 renderer. Surface:
   - Header: "§16 — SCHEDULE 13D / 13G ACTIVIST-STAKE (as of YYYY-MM-DD,
     90d window / 30d cluster)"
   - Aggregate block: `schedule_13d_cluster: YES/NO`; top sector
     z-scores ordered descending by |z| with top-5 truncation;
     "Last EDGAR query" timestamp.
   - Per-stock block: "Flagged tickers (universe filtered to equity-
     midcap)": `new_13d` (top 5 by daysSinceLatest13D ascending),
     `new_13g` (top 5 same).
   - "Universe coverage": M/N mid-cap tickers with current CIK mapping.
   - Cold-start branch: when `inputsAvailableAggregate < MIN_Z_BASELINE
     × 11` (= 330), emit a degraded "cold-start" version of the panel.
   - Load snapshot via `new Schedule13DGRepository().loadLatestSnapshot()`
     (sibling of `loadLatestEightKClassifierSnapshot` /
     `loadLatestForm4InsiderSnapshot`).

2. **modified** `scripts/tests/operatorBriefRender.test.ts` — covers
   SPEC §9.4 T-OBR-XD13-1..7:
   - T-OBR-XD13-1: §16 renders when `schedule_13d_g_v1` snapshot present.
   - T-OBR-XD13-2: §16 cold-start when `inputsAvailableAggregate <
     MIN_Z_BASELINE × 11`.
   - T-OBR-XD13-3: byte-equal to fixture (non-cold-start).
   - T-OBR-XD13-4: byte-equal-stdout protection on §§1-15 (no
     interaction with previous sections).
   - T-OBR-XD13-5: top-5 truncation on flagged_sectors (descending |z|).
   - T-OBR-XD13-6: `new_13d` per-ticker subsection truncation.
   - T-OBR-XD13-7: `new_13g` per-ticker subsection truncation.

Estimated: 2 files / ~300-400 LOC delta / 7+ tests / 1 commit. This
closes the XD13 arc end-to-end (A1..A5).

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

**NEW from s96 #5:**

None — XD13-A4 ships with no new operator action beyond what s96 #4
already queued (`migrate:create-schedule-13d-g-snapshots:apply`).
Once that migration is applied + XD13-A1 ingest has populated the
filings table, the daily daemon's new step 1m will start writing
non-cold-start snapshots automatically.

**CARRIED (unchanged from s96 #4):**

- (carried) Apply the XD13-A3 migration once per environment:
  `npm run migrate:create-schedule-13d-g-snapshots:apply`. Idempotent;
  safe to re-run. Required before daemon step 1m writes anything.
- (carried) `docs/index.md` (s96 #3, `74c9d7f`): restart any running
  `npm run docs:serve` process to pick up the new landing page.
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
- (carried) Push 69 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW + modified this slice (s96 #5 — 1 commit)

| Path | LOC | Notes |
| --- | --- | --- |
| `src/server/schedule_13d_g_repository.ts` | +~970 (NEW) | Sibling of F4/EK repository. 10-column SPEC §6 writeSnapshot; flaggedSectors-derived maxAggregateZ on read; orchestrator-internal cold-start branch per SPEC §7. |
| `scripts/daily_signal_daemon.ts` | +46 | Step 1m wired between 1l form-4 and §2 cells/bundles. Gated on snapshots-table-existence + NO_MACRO/DRY_RUN. |
| `scripts/tests/schedule13dgRepository.test.ts` | +~870 (NEW) | 52 sub-tests covering SPEC §9.2 T-XD13R-1..T-XD13R-Nplus5 + EXPLAIN PLAN gates. |

### CH state (no apply this slice — operator-gated)

Migrations still pending operator apply (unchanged from s96 #4):
- `quantlab.schedule_13d_g_filings` (XD13-A1).
- `quantlab.schedule_13d_g_snapshots` (XD13-A3 — REQUIRED before
  daemon step 1m can write).
- Other carried pending migrations per s96 #4 HANDOFF.

### Tests (new this slice)

- `scripts/tests/schedule13dgRepository.test.ts`: 52 sub-tests, 47 pass + 5 EXPLAIN skips on this dev env.
- Full npm test at commit time: 3077 passed (was 3030; +47 new) / 1
  failed (pre-existing CH-side EXPLAIN PLAN gate on
  `gicsSectorRepositoryHelper`, NOT a regression) / 33 skipped
  (was 28; +5 = the 5 new EXPLAIN PLAN gates that skip when the
  underlying tables don't exist on the dev CH yet).
- Full pytest at commit time: 377 passed (unchanged — no Python touched).
- `npx tsc --noEmit` baseline: 13 errors unchanged.
- `npm run check:help`: green.

## Watch-outs

### NEW from this turn (s96 #5)

- **XD13 cold-start posture diverges from F4 + EK on purpose (S96-22).**
  F4 / EK daemon-side gate skips the orchestrator entirely when source
  table missing. XD13 daemon-side gate ONLY checks the snapshots table;
  the orchestrator's internal cold-start branch handles filings-absent
  by writing a cold-start snapshot. A "consolidate Layer-0 daemon
  hooks into a shared base" refactor will silently break the SPEC §7
  contract for XD13 unless it preserves the per-composite gate split.

- **`writeSnapshot` does NOT write `max_aggregate_z` or
  `max_aggregate_z_sector` (S96-20).** The XD13 snapshot table doesn't
  have those columns. ClickHouse default behavior with JSONEachRow is
  to error on unknown keys — including those keys in the insert object
  would break the write. Test pins this via explicit
  `'max_aggregate_z' in row === false` assertions. A future v2 ADR that
  adds these columns must also relax these assertions.

- **`loadLatestSnapshot` returns `maxAggregateZ = null` when no sector
  is flagged (|z| > THRESHOLD).** This is a v1 limitation, not a bug.
  The "next-closest sector to flagging" is lost on a round-trip.
  Acceptable for the brief renderer's section #16 cold-start branch;
  if a future feature needs the "next-closest" annotation, the v2 add-*
  migration is the path.

- **`readFilingsForTickersInWindow` does NOT narrow on form_type at
  the SQL layer.** Unlike EK (which narrows on `item_code IN
  HIGH_SIGNAL_ITEM_CODES`) and F4 (which narrows on `transaction_code
  IN {P, S}`), this repository returns ALL form types in the window.
  Defense in depth happens in the composite via
  `filterFilingsToScheduleForms`. The XD13-A1 ingest already filters
  at parse time to the SPEC set (T-XD13I-12), so this is correct — but
  a regression in the ingest filter would silently widen the composite
  input, and the composite's filter would still narrow correctly.

- **Param-bound table-existence probes.** `tableExistsInternal` binds
  `{db:String}` + `{tbl:String}` as query params, so the SQL string
  does NOT contain the table name literally. Test routes that match on
  `q.includes('schedule_13d_g_filings')` for the existence probe will
  NEVER fire — match on `q.includes('system.tables')` instead. (Fixed
  in the test file at write time; documented here to prevent
  re-introducing the bug in future slices.)

- **The orchestrator's cold-start branch STILL writes the snapshot.**
  This is load-bearing for the SPEC §7 contract. If the snapshots
  table is also missing, the write throws — daemon-side gate at
  `scripts/daily_signal_daemon.ts` step 1m handles this case. Tests
  T-XD13R-Nplus3 + T-XD13R-Nplus4 both assert `fake.inserts.length
  === 1`.

### Carried from s96 #4

All s96 #1 + s96 #2 + s96 #3 + s96 #4 watch-outs preserved unchanged.
Key carry-overs:

- XD-5 asymmetric filter (load-bearing at the composite layer).
- `inputsAvailableAggregate` diverges from sibling-composite semantics.
- `inputsAvailablePerTicker` does NOT discriminate 13D vs 13G.
- `assertClose(actual, expected, msg)` third-arg footgun.
- `docs/index.md` is hand-maintained.
- The SPEC is the contract for XD13-A5 — any divergence is a SPEC
  violation, not a SPEC update.
- Issuer/filer split structural.
- Filer-name resolution is opt-in via `--resolve-filer-names`.
- DDL byte-pinned across Python ingest + TS migration.
- `is_amendment` derived from `form_type` suffix.
- Filer CIK ≠ issuer CIK at every layer.
- Pre-filing return capture is structurally impossible.
- 13G is canon-documented to carry signal (Edmans-Fang-Zur 2013).
- All earlier s89-s95 #9 watch-outs preserved.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all Layer-0 composites including XD13 step 1m (NEW s96 #5)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Gap #7 v2 Schedule 13D/G (A1 + A2 + A3 + A4 LIVE; A5 NEXT)

```text
# Operator-pending (XD13-A1 first run):
npm run migrate:create-schedule-13d-g-filings           # dry-run
npm run migrate:create-schedule-13d-g-filings:apply     # apply DDL
npm run edgar:13d-g:ingest:dry                          # dry-run
npm run edgar:13d-g:ingest                              # apply ingest
# Optional: resolve filer names today (v2 ADR will lift this default):
.venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py --resolve-filer-names --apply
# Operator-pending (XD13-A3):
npm run migrate:create-schedule-13d-g-snapshots         # dry-run
npm run migrate:create-schedule-13d-g-snapshots:apply   # apply DDL
# XD13-A4 (LIVE s96 #5) — daemon step 1m now writes a snapshot each cycle:
npm run daemon:daily                                    # populates schedule_13d_g_snapshots (cold-start safe)
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
npm test                                                                       # TS — last green at s96 #5 close: 3077 pass / 1 fail / 33 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #5 close: 377 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #5 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 301 emitted from 115 inputs
```

## For the next session — priority order

**Default on `continue`:** **XD13-A5** — `src/server/operator_brief_render.ts`
section #16 + `scripts/tests/operatorBriefRender.test.ts` (T-OBR-XD13-1..7).
This closes the XD13 arc end-to-end (A1..A5). Pattern matches the EK
section #14 + F4 section #15 renderers; ~2 files, ~300-400 LOC delta,
7+ tests, 1 commit.

**Acceptance criteria** for XD13-A5:

- ✓ `npm test` green at +7 (or more) new renderer tests.
- ✓ `npx tsc --noEmit` baseline-clean.
- ✓ `npm run check:help` green.
- ✓ `brief:morning` renders §16 when the XD13 snapshot is present;
  emits cold-start panel when `inputsAvailableAggregate <
  MIN_Z_BASELINE × 11`.
- ✓ Top-5 truncation on flagged_sectors + per-ticker `new_13d` /
  `new_13g` subsections (matches gap #7 v1 / gap #8 / #10 conventions).
- ✓ Byte-equal regression on §§1-15 (renderer parity protection).
- ✓ Pre-existing 1 `gicsSectorRepositoryHelper` failure is NOT a
  regression — ignore.

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

**Gap #7 now has THREE parallel Layer-0 composites; XD13 closes A4 +
needs only A5 to reach end-to-end parity with EK + F4:**

- **EK (8-K classifier)** — DONE end-to-end (s93..s95 #7), with per-EVENT recency LIVE.
- **F4 (Form 4 insider)** — DONE end-to-end (s93..s95 #4), with sell-cluster + per-row recency LIVE.
- **XD13 (Schedule 13D/13G activist-stake)** — **A1 + A2 + A3 + A4
  LIVE (s96 #2 + s96 #3 + s96 #4 + s96 #5); A5 NEXT.** SPEC + ADR
  shipped s96 #1; ingest + raw-event table s96 #2; pure composite +
  22 tests s96 #3; snapshot table + 34 tests s96 #4; repository +
  daemon hook 1m + 47 tests s96 #5. A5 (brief renderer) is the final
  slice.

**The arc-shape parity is load-bearing.** XD13-A5 is the sibling of
F4-A5 + EK-A5. The shared infrastructure across EK + F4 + XD13 (raw
event ingest → composite → snapshot table → repository → daemon hook
→ brief renderer) is now fully established. The XD13 differences
relevant to A5:

- **Brief section.** XD13 = #16 (EK = #14; F4 = #15).
- **Cold-start branch.** `inputsAvailableAggregate < MIN_Z_BASELINE
  × 11` (= 330) triggers cold-start render. Per SPEC §11 watch-out #7.
- **maxAggregateZ source.** Derived from `flaggedSectors` at read
  time (S96-21) — v1 limitation. Brief renderer must handle null
  cleanly (which it would anyway for the no-flagged-sector case).
- **Top-5 truncation.** Matches gap #7 v1 / gap #8 / #10 conventions
  on both per-stock subsections (`new_13d` + `new_13g`).

**The v2 layers (filer reputation, NLP, supersession, cover-page %
parse, max_aggregate_z persistence) are all gated on Phase B + their
own ADRs.** Do NOT auto-open them.

**Backward compat preserved on three fronts:**

1. **CH:** No DDL changes this slice. The XD13-A3 migration remains
   the only pending operator action for XD13 storage.
2. **Type:** New `Schedule13DGRepository` class + `Schedule13DGSectorEntry`
   type alias added; no existing types changed.
3. **Daemon:** Step 1m added between 1l form-4 and §2 cells/bundles.
   No existing step changed. Pre-snapshots-table-apply: skip with
   operator nudge (matches F4/EK posture).

**Parallel-tracks posture continues.** s96 #5 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Code-only slice — daemon
output extended with one new line; brief output unchanged until A5
lands.

**The chain through s96 #5:**

```text
ALL S41-S95 WORK                                        ✓ as documented
S96 #1: SPEC + ADR-043                                  ✓ committed (d68c2ab)
S96 #2: XD13-A1 — ingest + raw-event table              ✓ committed (3796fde)
S96 #3: docs/index.md — Quartz landing                  ✓ committed (74c9d7f)
S96 #3: XD13-A2 — pure composite + 22 tests             ✓ committed (afcc418)
S96 #3 HANDOFF rewrite                                  ✓ committed (fb119a4)
S96 #4: XD13-A3 — snapshot table + migration + 34 tests ✓ committed (90dd459)
S96 #4 HANDOFF rewrite                                  ✓ committed (abfd4d0)
S96 #5: XD13-A4 — repository + daemon hook 1m + 47 tests ✓ committed (5cf8c84)
        — src/server/schedule_13d_g_repository.ts (~970 LOC)
        — scripts/daily_signal_daemon.ts (+46 LOC, step 1m)
        — scripts/tests/schedule13dgRepository.test.ts (~870 LOC, 52 sub-tests)
S96 #5 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: XD13-A5 (brief renderer section #16).
                  Sibling of F4-A5 + EK-A5. Pattern
                  established; ~2 files, ~300-400 LOC,
                  7+ tests, 1 commit. Closes the XD13
                  arc end-to-end (A1..A5).
  → background: daily daemon now writes a snapshot row
                each run (cold-start safe). Brief §16
                placeholder; activates with A5.
```
