# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 96 #6 — **Gap #7 v2 XD13-A5 — brief section #16 + 15 tests SHIPPED; XD13 arc CLOSED end-to-end**: fifth and final code slice of the XD13 arc. 1 commit `7da5e2d` / 3 files / +928 LOC / 15 new sub-tests covering SPEC §9.4 T-OBR-XD13-1..7 + 8 additional contract sub-tests. **70 commits ahead of `origin/main`** (was 69). The XD13 arc (A1..A5) is now end-to-end LIVE — sibling to the EK arc (closed s95 #7) + the F4 arc (closed s95 #4). **NEXT default on `continue`:** operator-pick from the post-XD13 menu — Gap #9 v3.1 SSGA-SPDR XLSX adapter is recommended.

## What this slice delivered

Implements the A5 sub-arc from the s96 #1 SPEC. Brief section #16
renders the daily XD13 snapshot from step 1m (s96 #5); closes the
XD13 arc end-to-end (A1..A5).

### One commit (s96 #6)

**`7da5e2d` — Gap #7 v2 XD13-A5 — brief section #16 + 15 tests; XD13 arc CLOSED end-to-end.**
3 files, +928 LOC:

- **modified** `src/server/operator_brief_render.ts` (+316 LOC).
  Surface:
  - NEW `BriefSchedule13DGSection` interface — sibling of
    `BriefEightKClassifierSection` + `BriefForm4InsiderSection`.
    Carries: `evaluatedAt`, `snapshotDate`, `lastEdgarQueryAt`,
    `bdSinceLastQuery`, `flaggedSectors` (with `new13DRateT`),
    `schedule13DClusterFlag`, `maxAggregateZ` + `maxAggregateZSector`
    (derived from flaggedSectors at read time per S96-21),
    `perTickerRows` (11 fields: ticker, cik, sector, two 30d flags,
    three 90d counts, distinct-13D-filers, two days-since-latest),
    `inputsAvailableAggregate`, `inputsAvailablePerTicker`,
    `tickersWithCikCount` + `watchUniverseTickerCount` (composer-
    stamped per S93-28), `compositeVersion`.
  - NEW `MorningBrief.scheduleThirteenDG: BriefSchedule13DGSection | null`
    field appended after `formFour`.
  - NEW `renderScheduleThirteenDGSection` function. Three-branch §1.4
    aggregate panel (LIVE → table; NO-FLAG-BUT-CLEARED → "No sectors
    flagged today" line with max-|z|; COLD-START → SPEC §5.3 + §11
    watch-out #7 baseline-thin branch). Per-ticker subsections
    sorted by `daysSinceLatest13D` / `daysSinceLatest13G` ascending
    (most recent first); top-5 per side; remainder note. Universe-
    coverage line uses composer-stamped `tickersWithCikCount` + the
    sector-day-tuples-cleared ratio. Composite footer wording is
    XD13-tailored (NEW-13D-only at aggregate per XD-5; |z| > 2.0).
  - NEW exports: `SCHEDULE_13D_G_FLAGGED_TOP_N = 5`,
    `SCHEDULE_13D_G_STALENESS_BD_THRESHOLD = 4` (matches EK + F4),
    `SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR = 330`
    (= MIN_Z_BASELINE × SECTOR_COUNT per SPEC §5.3).
  - `renderBriefMarkdown` updated: appends call to
    `renderScheduleThirteenDGSection` after the F4 #15 call.

- **modified** `src/server/operator_brief.ts` (+97 LOC).
  - NEW `Schedule13DGRepository` + `schedule13dgSnapshotsTableExists`
    imports.
  - NEW `Schedule13DGSnapshot` type import.
  - NEW `BriefSchedule13DGSection` re-import.
  - NEW `fetchLatestSchedule13DG?: () => Promise<...>` field in
    `BriefDeps` (sibling of `fetchLatestForm4Insider`).
  - NEW `fetchLatestSchedule13DGFromCH` default — graceful-degrade
    posture: returns null on absent table OR any read error.
  - NEW `buildSchedule13DGSection` exported builder — stamps
    `tickersWithCikCount` + `watchUniverseTickerCount` per S93-28.
  - `composeMorningBrief` updated: `latestSchedule13DG` threaded
    through Promise.all + new field added to the returned object.

- **modified** `scripts/tests/operatorBriefRender.test.ts` (+517 LOC).
  Updates the base `brief()` factory with `scheduleThirteenDG: null`.
  Adds a NEW describe block 'renderBriefMarkdown — Schedule 13D/13G
  activist-stake panel' with 15 sub-tests covering:
  - 'not yet evaluated' null-fixture render
  - T-OBR-XD13-1: §16 renders when snapshot present (NORMAL header
    on cold-start cluster_flag=false per §11 watch-out #7)
  - T-OBR-XD13-2: cold-start branch when `inputsAvailableAggregate
    < 330` (literal threshold pinned at the test boundary)
  - T-OBR-XD13-3: byte-equal contract on LIVE branch (flagged
    sector + per-ticker subsections)
  - T-OBR-XD13-4: byte-equal-prefix protection on §§1-15 — slice
    `withoutXD13` and `withXD13` must produce identical prefixes
  - T-OBR-XD13-5: flagged_sectors order preserved + table renders
    in full when ≤ N (truncation lives at the composite layer)
  - T-OBR-XD13-6: `new_13d` per-ticker subsection truncation at
    top-5 + remainder note + non-flagged-row exclusion
  - T-OBR-XD13-7: `new_13g` per-ticker subsection truncation at
    top-5 + remainder note
  - section-ordering invariant: §16 after §15
  - NO-FLAG-BUT-CLEARED branch coverage
  - staleness ⚠ stale (≥4bd) warning at bdSinceLastQuery=5
  - staleness suppressed at bdSinceLastQuery<4
  - no-EDGAR-data fallback when lastEdgarQueryAt is null
  - "No tickers flagged." fallback
  - sector annotation omitted when row.sector is null

### What this slice does NOT ship (carried per SPEC §10)

- No CH apply of either XD13 table — operator-gated (still A1 + A3
  migrations pending).
- No v2 `max_aggregate_z` columns persistence — deferred per SPEC §6
  / S96-17 / S96-21. The renderer derives the value from
  `flaggedSectors` at read time (sectors with `|z| ≤ THRESHOLD` are
  lost on the cross-day round-trip).
- No filer-name surfacing in the brief — XD-2 v2 ADR; the raw layer
  carries the names when `--resolve-filer-names` was passed at
  ingest time, but the renderer keeps the SPEC §8 mockup's "by filer
  CIK XXX" deferred-to-v2 stance.
- No cover-page ownership % rendering — XD-15 deferred.

### Verification gates at commit time (all green)

```text
npm test                                            # 3092 pass / 1 fail (pre-existing) / 33 skip
.venv/Scripts/python.exe -m pytest scripts/tests   # 377 pass (unchanged — no Python touched)
npx tsc --noEmit                                    # 13 baseline errors unchanged
npm run check:help                                  # green
```

Pass-count diff +15 = exactly the new active sub-tests in this slice.
No regressions. The single `npm test` failure is the carry-forward
`gicsSectorRepositoryHelper SMP-6` infra-side EXPLAIN PLAN rejection.

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
| Gap #7 v2 Schedule 13D/13G arc — XD13-A4 (repository + daemon hook 1m) | ✓ s96 #5 (`5cf8c84`) |
| **Gap #7 v2 Schedule 13D/13G arc — XD13-A5 (brief renderer §16)** | **✓ s96 #6 (`7da5e2d`) — XD13 ARC FULLY CLOSED end-to-end** |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ NEXT (recommended default on `continue`) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 70 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 96 #6 (this slice)

**S96-24. XD13 brief section #16 — three-branch §1.4 aggregate panel under ADR-042 Option (a) parity with EK + F4.** The renderer reproduces the buy-side EK + F4 three-branch structure exactly: (a) `flaggedSectors.length > 0` → table; (b) `flaggedSectors === []` AND `inputsAvailableAggregate >= 330` → "No sectors flagged today" line with max-|z|; (c) `inputsAvailableAggregate < 330` → cold-start branch. Branches (a) + (b) match EK + F4's wording template; branch (c)'s wording is XD13-specific (cites SPEC §5.3 + §11 watch-out #7 instead of ADR-042 §"Watch-outs", because XD13's cold-start gate is sector-day-tuple-based rather than the EK/F4 sector-count-based threshold).
`Why:` SPEC §5.3 + §11 watch-out #7 prescribe the cold-start gate at `inputsAvailableAggregate < MIN_Z_BASELINE × 11 = 330`. EK + F4's `inputsAvailableAggregate` is sector-count (k/11); XD13's is sector-day-tuples (Σ_sectors |finite(baseline2y_s)|). Same three-branch shape, different threshold semantics. The wording reflects the semantics so a future ADR that retunes either composite's threshold doesn't get cross-wired.
`How to apply:` If a future v2 ADR adds the `max_aggregate_z` columns to the XD13 snapshot (S96-21 path), the NO-FLAG-BUT-CLEARED branch can be enhanced to surface the "next-closest sector" — the cold-start branch wording stays load-bearing for the sub-330 case. T-OBR-XD13-2 pins the literal 330 threshold so any retune surfaces explicitly.

**S96-25. `SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR = 330` lives in the renderer, NOT imported from the composite.** Self-contained — drift detection is a code-review concern + T-OBR-XD13-2 pins the value at the test boundary. Matches the etf-flow `ETF_FLOW_COLD_START_BD_SENTINEL` convention (S92-13) of duplicating a single load-bearing scalar between the repository and the pure renderer to avoid pulling a CH-heavy module into the pure-render boundary.
`Why:` The renderer is pure (`renderBriefMarkdown` has no I/O); importing the composite's `MIN_Z_BASELINE` value-export forces a transitive dependency on the schedule_13d_g module, which carries the CH-touching repository neighbor in many tooling configurations. Duplicating the literal + a test-boundary pin (T-OBR-XD13-2 asserts the rendered "X/330" ratio) catches drift without coupling.
`How to apply:` If MIN_Z_BASELINE OR SECTOR_COUNT changes (currently 30 × 11 = 330), update BOTH `schedule_13d_g.ts` AND `operator_brief_render.ts` AND `scripts/tests/operatorBriefRender.test.ts:T-OBR-XD13-2`. The test will fail loudly until the second + third locations are updated.

**S96-26. Per-ticker subsections sorted by `daysSinceLatest{13D,13G}` ASC (most recent first) with nulls last.** Defensive null-handling — when the 30d filing flag fires, the recency is guaranteed non-null (the 90d window subsumes 30d), but the sort survives an upstream-payload regression that breaks the invariant. Ties resolve by ticker for deterministic output.
`Why:` SPEC §8 mockup lists `ABCD — SC 13D filed 7d ago` ahead of `EFGH — SC 13D + SC 13D/A x2 in 90d (3 filings, 2 distinct filers)` — implicit ordering: smaller days-since = more recent = higher in the list. Matches EK + F4 conventions (`sortByRecency` is the shared helper). T-OBR-XD13-6 / T-OBR-XD13-7 assert the smallest-days row renders first.
`How to apply:` Subsection ordering is load-bearing for byte-equal-stdout protection across daemon runs. Do NOT switch to alphabetical or by-count without a SPEC update + test re-anchoring.

**S96-27. `tickersWithCikCount` stamping mirrors S93-28 byte-for-byte.** Composer-side count of perTickerRows where `cik !== ''`; renderer uses this for the universe-coverage line in place of `inputsAvailablePerTicker` (gated on ≥1 filing in 90d window; mostly 0 in cold-start; would render "0/60 with CIK mapping" misleadingly).
`Why:` Same fix as EK-A5 / F4-A5 (S93-28). The composite's `inputsAvailablePerTicker` semantics is "rows with at least one filing in 90d" per SPEC §5.3 — that's informational, not a CIK-coverage signal. The brief operator wants to know "how many of the mid-cap universe have current CIK mapping," which is a property of the per-ticker row's `cik` field.
`How to apply:` All future Layer-0 composite brief sections SHOULD stamp `tickersWithCikCount` + `watchUniverseTickerCount` at the composer boundary for the universe-coverage line. The pattern is now load-bearing across G1-A2/A3/A4 (sections #12 + #14 + #15 + #16).

**Carry-overs (still in force):** S96-1..S96-23 (all s96 #1-#5 decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### Newly opened (s96 #6)

None. The renderer is a mechanical implementation of SPEC §8 + §9.4 +
§11 watch-out #7; no canon-thin forks emerged at implementation time.
The three-branch §1.4 wording divergence (S96-24) is explicitly
spelled out in SPEC §5.3, not a canon-thin fork.

### CARRIED (unchanged from s96 #5)

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

### Default on `continue` — operator-pickable

The XD13 arc (A1..A5) is now CLOSED end-to-end. No single dominant
next slice. Operator-pick from this menu (recommended order):

1. **Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter**
   (~250-300 LOC, 1 commit). Automates the manual CSV drop for the
   SPDR ETF family (11 of 21 ETFs). Highest-leverage automation slice
   remaining among the operator-pickables.

2. **Phase B-gated** (no code possible today):
   - Gap #7 v2 event-driven cadence promotion.
   - Phase B campaigns for the nine Layer-0 composites (cycle,
     vol-structure, sector-rotation, cross-asset, short-interest,
     executive-departure, etf-flow, EK, F4, XD13).
   - Schedule 13D/G Phase B independence test (earliest ~2026-07-20).

3. **Calendar-gated**:
   - Form 4 CMP opportunistic-vs-routine classifier v2 ADR
     (earliest ~2026-11-20).
   - Event-driven cadence v2 ADR (earliest ~2026-08-20).
   - Drawdown framework §12 90d empirical retune (earliest
     2026-08-29).

4. **C-12 Phase B AlpacaAdapter** (operator-decision; paused
   indefinitely).

5. **Quartz docs site extensions** — live dashboard watcher, teach-
   doc frontmatter rollout, promote ADR-040 status, etc.

6. **Renderer docstring refresh** — `operator_brief_render.ts` has
   small stale comments for the EK section (s95 #7 carry).

### Operator-gated action items (carried + new)

**NEW from s96 #6:**

None — XD13-A5 ships with no new operator action beyond what s96
#3 + #4 already queued (`migrate:create-schedule-13d-g-filings:apply`
+ `migrate:create-schedule-13d-g-snapshots:apply` + the XD13-A1
ingest). Once those are applied + XD13 has ingest history, the
brief §16 renders the LIVE branch automatically.

**CARRIED (unchanged from s96 #5):**

- (carried) Apply the XD13-A3 migration once per environment:
  `npm run migrate:create-schedule-13d-g-snapshots:apply`.
- (carried) `docs/index.md` (s96 #3): restart any running
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
- (carried) Push 70 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW + modified this slice (s96 #6 — 1 commit)

| Path | LOC | Notes |
| --- | --- | --- |
| `src/server/operator_brief_render.ts` | +316 | NEW `BriefSchedule13DGSection` interface; NEW `MorningBrief.scheduleThirteenDG` field; NEW `renderScheduleThirteenDGSection` function (three-branch §1.4 + per-ticker subsections with top-5 truncation); 3 NEW exported constants (`SCHEDULE_13D_G_FLAGGED_TOP_N`, `SCHEDULE_13D_G_STALENESS_BD_THRESHOLD`, `SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR`); wired into `renderBriefMarkdown`. |
| `src/server/operator_brief.ts` | +97 | NEW `Schedule13DGRepository` + `schedule13dgSnapshotsTableExists` imports; NEW `Schedule13DGSnapshot` type import; NEW `BriefSchedule13DGSection` re-import; NEW `fetchLatestSchedule13DG` `BriefDeps` field; NEW `buildSchedule13DGSection` builder; NEW `fetchLatestSchedule13DGFromCH` default; `composeMorningBrief` threaded through. |
| `scripts/tests/operatorBriefRender.test.ts` | +517 | `brief()` factory updated with `scheduleThirteenDG: null`. NEW describe block 'renderBriefMarkdown — Schedule 13D/13G activist-stake panel' with 15 sub-tests covering T-OBR-XD13-1..7 + 8 additional contract sub-tests. |

### CH state (no apply this slice — operator-gated)

Migrations still pending operator apply (unchanged from s96 #5):
- `quantlab.schedule_13d_g_filings` (XD13-A1).
- `quantlab.schedule_13d_g_snapshots` (XD13-A3 — REQUIRED before
  daemon step 1m can write).
- Other carried pending migrations per s96 #5 HANDOFF.

### Tests (new this slice)

- `scripts/tests/operatorBriefRender.test.ts`: +15 active sub-tests
  under the new XD13 describe block.
- Full npm test at commit time: 3092 passed (was 3077; +15 new) /
  1 failed (pre-existing CH-side EXPLAIN PLAN gate on
  `gicsSectorRepositoryHelper`, NOT a regression) / 33 skipped
  (unchanged).
- Full pytest at commit time: 377 passed (unchanged — no Python touched).
- `npx tsc --noEmit` baseline: 13 errors unchanged.
- `npm run check:help`: green.

## Watch-outs

### NEW from this turn (s96 #6)

- **`SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR = 330` is duplicated
  between the renderer + the composite-derived semantic** (S96-25).
  The composite's `MIN_Z_BASELINE` is 30 and SECTOR_COUNT is 11; if
  either changes in a v2 ADR, BOTH `schedule_13d_g.ts` AND
  `operator_brief_render.ts` AND `T-OBR-XD13-2` must be updated.
  The test pins the literal at "330" so the drift will fail loudly.

- **The brief renderer expects `flaggedSectors` to be in descending
  `|z|` order; truncation is the composite's responsibility.**
  T-OBR-XD13-5 asserts the renderer is order-preserving, NOT that it
  enforces an ordering. A v2 change that gives the renderer responsibility
  for `|z|`-sorting must come with a SPEC update + test re-anchoring.

- **`maxAggregateZ` cross-day round-trip lossiness is load-bearing
  for the NO-FLAG-BUT-CLEARED branch wording.** The renderer reports
  "max-|z|=n/a" whenever every sector is below the threshold but the
  panel cleared baseline coverage (S96-21). The wording mentions
  "n/a" verbatim; downstream operators MUST understand this is a v1
  limitation, not a bug. v2 ADR + add-* migration will lift this.

- **`MorningBrief.scheduleThirteenDG` is REQUIRED, not optional.**
  All test fixtures must include `scheduleThirteenDG: null` (or a
  populated payload). The base `brief()` factory in
  `operatorBriefRender.test.ts` has been updated; future external
  callers MUST add this field. TypeScript will catch missed call
  sites at build time.

- **The cold-start branch wording cites "SPEC §5.3 + §11 watch-out
  #7", NOT "ADR-042 §Watch-outs".** This is intentional — XD13's
  cold-start gate is sector-day-tuple-based (Σ_sectors |finite|),
  whereas EK + F4's gate is sector-count-based (k/11). A "consolidate
  cold-start wording across the three composites" refactor would
  silently break the semantic clarity. Keep the wording specific
  to each composite's actual semantics.

- **The brief renderer DOES NOT surface filer names.** Even when
  XD13-A1 ingest was run with `--resolve-filer-names`, the v1 brief
  hides them per XD-2 (v2 ADR territory). A future v2 ADR will lift
  this; until then, the SPEC §8 mockup's "by Vanguard (annual)"
  shorthand is decoration, not a contract.

### Carried from s96 #5

All s96 #1-#5 watch-outs preserved unchanged. Key carry-overs:

- XD13 cold-start posture diverges from F4 + EK on purpose (S96-22).
- `writeSnapshot` does NOT write `max_aggregate_z` columns (S96-20).
- `loadLatestSnapshot` returns `maxAggregateZ = null` when no sector
  is flagged (|z| > THRESHOLD) — S96-21 limitation.
- `readFilingsForTickersInWindow` does NOT narrow on form_type at
  the SQL layer.
- Param-bound table-existence probes (test-route matching
  convention).
- The orchestrator's cold-start branch STILL writes the snapshot.
- XD-5 asymmetric filter (load-bearing at the composite layer).
- `inputsAvailableAggregate` diverges from sibling-composite semantics.
- `inputsAvailablePerTicker` does NOT discriminate 13D vs 13G.
- `assertClose(actual, expected, msg)` third-arg footgun.
- `docs/index.md` is hand-maintained.
- The SPEC is the contract — any divergence is a SPEC violation,
  not a SPEC update.
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
npm run daemon:daily                                    # all Layer-0 composites including XD13 step 1m (LIVE s96 #5)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # NOW renders §16 (XD13-A5 LIVE s96 #6)
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Gap #7 v2 Schedule 13D/G (A1..A5 ALL LIVE; arc CLOSED)

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
# XD13-A4 (LIVE s96 #5) — daemon step 1m writes a snapshot each cycle:
npm run daemon:daily                                    # populates schedule_13d_g_snapshots (cold-start safe)
# XD13-A5 (LIVE s96 #6) — brief renders §16:
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
npm test                                                                       # TS — last green at s96 #6 close: 3092 pass / 1 fail / 33 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #6 close: 377 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #6 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 301 emitted from 115 inputs
```

## For the next session — priority order

**Default on `continue`:** Operator-pickable from the menu in the
"Next stage" section above. The XD13 arc is now CLOSED end-to-end;
no single dominant default. Recommended: **Gap #9 v3.1 SSGA-SPDR
XLSX → canonical-CSV Playwright adapter** (~250-300 LOC, 1 commit).

**If operator reprioritizes:** any candidate from the menu above
can be the default-next.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider / Schedule-13D-G Phase B campaigns.
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

**Gap #7 v2 is now COMPLETE across all three parallel Layer-0
composites:**

- **EK (8-K classifier)** — DONE end-to-end (s93..s95 #7), with per-EVENT recency LIVE.
- **F4 (Form 4 insider)** — DONE end-to-end (s93..s95 #4), with sell-cluster + per-row recency LIVE.
- **XD13 (Schedule 13D/13G activist-stake)** — **DONE end-to-end
  (s96 #1..#6)**: SPEC + ADR (s96 #1) → ingest + raw table (s96 #2)
  → pure composite + 22 tests (s96 #3) → snapshot table + 34 tests
  (s96 #4) → repository + daemon hook 1m + 47 tests (s96 #5) →
  **brief §16 + 15 tests (s96 #6 — THIS SLICE)**. The arc CLOSES
  with this commit.

**The arc-shape parity is now load-bearing across THREE composites.**
Future "fourth gap-#7 composite" work (none currently scoped) would
follow the same A1..A5 template established by EK + F4 + XD13.

**The v2 layers (filer reputation, NLP, supersession, cover-page %
parse, max_aggregate_z persistence) remain gated on Phase B + their
own ADRs.** Do NOT auto-open them.

**Backward compat preserved on three fronts:**

1. **CH:** No DDL changes this slice. The XD13-A1 + A3 migrations
   remain the only pending operator actions for XD13 storage.
2. **Type:** NEW `BriefSchedule13DGSection` interface + NEW
   `MorningBrief.scheduleThirteenDG` field. The renderer + composer
   are wired through; any external caller building a `MorningBrief`
   directly MUST include the new field (TypeScript catches missed
   sites at build time).
3. **Brief:** Section #16 appended LAST after §15. Byte-equal-prefix
   protection on §§1-15 is pinned by T-OBR-XD13-4.

**Parallel-tracks posture continues.** s96 #6 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Code-only slice — brief
output extended with one new section; the morning brief now renders
§16 alongside the existing §§1-15.

**The chain through s96 #6:**

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
S96 #5 HANDOFF rewrite                                  ✓ committed (445934c)
S96 #6: XD13-A5 — brief section #16 + 15 tests          ✓ committed (7da5e2d)
        — src/server/operator_brief_render.ts (+316 LOC)
        — src/server/operator_brief.ts (+97 LOC)
        — scripts/tests/operatorBriefRender.test.ts (+517 LOC, 15 sub-tests)
        — XD13 ARC FULLY CLOSED (A1..A5 LIVE end-to-end)
S96 #6 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: operator-pickable. Recommended:
    Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright
    adapter (~250-300 LOC, 1 commit).
  → background: daily daemon writes a snapshot row each
    run (cold-start safe); brief §16 NOW renders the
    cold-start panel (pre-CH-apply) or LIVE panel (post-CH-apply
    + post-ingest).
```
