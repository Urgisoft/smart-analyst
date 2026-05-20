# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 91 close — **gap #8 executive-departure-signal arc DONE end-to-end.** Six commits this session under the autonomous-execution protocol with zero permission pauses (`c04b706` SPEC + `bdd4d4f` A1 + `84e69be` A2 + `c11edb3` A3 + `db2f7b2` A4 + `f96ff5c` A5). Tests grew 2070 → 2210 (+140 TS net new across A2/A3/A4/A5) plus 182 → 210 (+28 pytest from A1). 49 commits ahead of `origin/main`, push still held. Slice queue: **gap #9 etf-flow-monitoring next**, then gap #7 event-driven-filings-processor (Form 4 lands there per E-11).)

## What this session delivered

Six commits across the gap #8 executive-departure-signal arc:

1. **SPEC — executive-departure-signal (`exec_departure_v1`)** — commit `c04b706`. `docs/specs/executive-departure-signal.md` (~445 LOC). Sixth Layer-0 informational composite. Three canon-thin forks (E-2, E-5, E-11) resolved autonomously.

2. **A1 — SEC EDGAR 8-K Item 5.02 ingest (Python)** — commit `bdd4d4f`. `scripts/sec_edgar_8k_item_5_02_ingest.py` (~575 LOC) + 28 pytest + `package.json` ingest scripts.

3. **A2 — pure composite + 41 tests** — commit `84e69be`. `src/server/executive_departure.ts` (~330 LOC) + `scripts/tests/executiveDeparture.test.ts` (41 node:test).

4. **A3 — CH snapshot migration + 23 tests** — commit `c11edb3`. `scripts/migrate_create_executive_departure_snapshots.ts` + tests + help/npm registration.

5. **A4 — repository + daemon step 1i + 59 tests** — commit `db2f7b2`. `src/server/executive_departure_repository.ts` (~430 LOC) + `scripts/tests/executiveDepartureRepository.test.ts` (59 node:test) + step 1i wired between 1h (short-interest) and §2 (cells/bundles). Includes the GICS-sector autonomous resolution (SPEC §11 OQ-2): v1 ships with `sector = null` for all per-ticker rows; aggregate-sector layer dormant; per-ticker layer fully active. Three-criterion justification documented in repo + daemon.

6. **A5 — brief section #12 + 17 tests** — commit `f96ff5c`. `src/server/operator_brief_render.ts` BriefExecutiveDepartureSection + renderExecutiveDepartureSection + `src/server/operator_brief.ts` buildExecutiveDepartureSection + fetchLatestExecutiveDepartureFromCH composer wiring. 12 render tests + 3 composer tests + 2 sub-tests.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s90 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| **Gap #8 executive-departure-signal arc** | **✓ DONE end-to-end (s91)** |
| **Gap #9 etf-flow-monitoring** | **☐ NEXT** |
| Gap #7 event-driven-filings-processor | ☐ queued after #9 (Form 4 lands here per #8 E-11) |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 49 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 91 (this session, this commit)

**S91-7. Gap #8 A4 GICS-sector resolution (SPEC §11 OQ-2 canon-thin fork): v1 ships with `sector = null` for all per-ticker rows.** The aggregate-sector layer is structurally dormant in v1 — `inputs.sectors` is always an empty array, `executive_cluster_departure` never fires, and the brief panel renders a "GICS sector mapping deferred to v2" footer for the aggregate section. The per-ticker layer (binary in-window flag) is fully active.
`Why:` Neither the `sp500_constituents` table (ticker + effective_date only) nor the `cik_ticker_map` cache (ticker, CIK, former_tickers, company_name) carries a SIC code or GICS field. The existing SPDR-sector mapping in src/server/sector_rotation.ts is at the ETF level (XLK/XLF/...), not at the constituent level. Three-criterion analysis: (1) canon foundations equal across alternatives (SPEC §11 OQ-2 explicitly punts); (2) null path has zero ingest-time changes (no A1 schema bump, no separate Wikipedia scraper); (3) zero free parameters vs. 11+ for a SIC→GICS bridge or 503+ for a static ticker→sector table.
`How to apply:` v2 deliverable = a dedicated slice that either extends A1 to capture sicDescription from EDGAR submissions API + a SIC→GICS bridge, OR ships a separate `quantlab.gics_sector_map` table populated from Wikipedia + a daily refresh job. The composite's aggregate-layer math is already implemented + tested; v2 simply populates `inputs.sectors`. Documented in the executive_departure_repository.ts module header + the daemon step 1i comment block + the A5 brief rendering footer.

**S91-8. A4 step 1i wiring posture mirrors 1d-1h byte-for-byte.** `NO_MACRO || DRY_RUN`-gated, absent-table-safe (via `executiveDepartureSnapshotsTableExists`), non-fatal try/catch with anomalies push. Standard Layer-0 informational evaluation cadence.
`Why:` Established pattern; predictable failure surface; no surprises in operator workflow.
`How to apply:` Same posture should be inherited by gap #9 (etf-flow-monitoring) when its step 1j lands.

**S91-9. A5 brief section #12 byte-equal protection preserved.** Section #12 renders AFTER section #11 (short-interest); sections #1-#11 are byte-for-byte unchanged. Test `section ordering: executive-departure renders AFTER short-interest` pins this.
`Why:` Established invariant across the prior five Layer-0 composites. Section-add-at-tail is the operator-visible protection against accidental panel-reordering churn.
`How to apply:` Gap #9 A5 will append section #13 after #12; same byte-equal-protection test applies.

**S91-10. EXECUTIVE_DEPARTURE_STALENESS_BD_THRESHOLD = 4 bd.** SEC's statutory 4bd filing deadline for Item 5.02 (Sarbanes-Oxley §409; 17 CFR 249.308) is the bright line. A `bdSinceLastQuery >= 4` means the daemon's ingest hasn't caught a filing that SEC has accepted as far back as 4bd — i.e. the ingest path itself is stale, not just the underlying data.
`Why:` Contrast with short-interest's 14bd threshold: FINRA biweekly publishes every 2 weeks, so 14bd ≈ one missed cycle. EDGAR is real-time → a 4bd threshold catches missed daemon ingest runs.
`How to apply:` Operator should re-run `npm run edgar:exec-departure:ingest:apply` if the brief shows the staleness warning. The script is idempotent under ReplacingMergeTree.

### Sessions 84-90 + S91 prior decisions (carried)

All prior decisions preserved unchanged. S91-1 through S91-6 (SPEC + A1-A3 lock-ins) are now historical context; the implementation is complete in the source tree + git history.

## Open questions

### HIGH (carried)

1. **C-12 Phase B Alpaca onboarding** — paused indefinitely.
2. **CBOE DataShop subscription** — blocked under data-source policy.
3. **#5 capital-deployment-ramp ADR** — operator self-assigned ~1 week; not blocking.

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push 49 commits to origin/main — operator-gated.

### NEW from this session

1. **Gap #8 v2 enhancement — GICS sector activation.** Operator-pickable insertion. Path α = extend A1 to capture `sicDescription` from EDGAR submissions API + ship a SIC→GICS bridge table (10-15 rows). Path β = separate Wikipedia ingest writing to `quantlab.gics_sector_map`. Path γ = SPDR fund-holdings scrape (most fragile; lowest-priority). All three activate the aggregate-sector panel; composite math + render are ready.

### Closed this session

- ~~Gap #8 SPEC~~ — DONE (`c04b706`).
- ~~Gap #8 A1 SEC EDGAR ingest~~ — DONE (`bdd4d4f`).
- ~~Gap #8 A2 pure composite~~ — DONE (`84e69be`).
- ~~Gap #8 A3 snapshot migration~~ — DONE (`c11edb3`).
- ~~Gap #8 A4 repository + daemon step 1i~~ — DONE (`db2f7b2`).
- ~~Gap #8 A5 brief section #12~~ — DONE (`f96ff5c`).
- ~~SPEC §11 OQ-2 (GICS sector mapping source)~~ — RESOLVED autonomously per S91-7 (v1 ships with sector=null; v2 deliverable defined).

## Next stage

### Default on "continue"

**Gap #9 — etf-flow-monitoring SPEC.** Per the locked queue. The seventh Layer-0 informational composite. Reuses the established template: SPEC (~400-500 LOC) → A1 (ingest from ETF.com / ETF Database public pages via Playwright per CLAUDE.md data-source policy) → A2 (pure composite + tests) → A3 (CH snapshot table) → A4 (repository + daemon step 1j) → A5 (brief section #13).

Concrete first move on "continue": open the gap doc (`docs/obsidian/gaps/etf-flow-monitoring.md` if it exists; otherwise read the broader gap inventory at `docs/obsidian/gaps/README.md`) → write `docs/specs/etf-flow-monitoring.md` mirroring the short-interest / executive-departure SPEC structure (§1 goals/non-goals, §2 decision lock-ins with three-criterion forks where canon-thin, §3 component diagram, §4 inputs, §5 composite formulas, §6 CH snapshot schema, §7 daemon hook position 1j, §8 brief panel mock-up, §9 test plan, §10 implementation phases, §11 deferred OQs, §12 references).

ETF.com + ETF Database are pre-authorized free public sources per CLAUDE.md; required scraper discipline (schema validation on every fetch + alert on parse failures + fallback to cached last-good + no silent stale-data propagation) is the established posture.

### After gap #9 SPEC lands

A1-A5 phases mirror the prior five Layer-0 arcs structurally. Estimated 5-7 commits to gap #9 end-to-end at the established cadence.

### After gap #9 ships

Per the locked queue:

- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; **Form 4 path arrives here per gap #8 E-11**).

Then the deferred-but-on-queue work: gap #8 v2 GICS-sector activation, ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the six Layer-0 composites.

## Files / code state

### NEW or EDITED this session (s91)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/executive-departure-signal.md` | NEW (`c04b706`) | 445 LOC, §1-§12, 14 decision lock-ins. |
| `scripts/sec_edgar_8k_item_5_02_ingest.py` | NEW (`bdd4d4f`) | ~575 LOC. EDGAR ingest + sub-item header regex + CIK→ticker resolve + RM-tree writes. |
| `scripts/tests/test_sec_edgar_8k_item_5_02_ingest.py` | NEW (`bdd4d4f`) | 28 pytest. SPEC §9.4 T-EDI-1..T-EDI-7 fully covered. |
| `src/server/executive_departure.ts` | NEW (`84e69be`) | ~330 LOC. Pure composite per SPEC §5. |
| `scripts/tests/executiveDeparture.test.ts` | NEW (`84e69be`) | 41 node:test. SPEC §9.1 T-ED-1..T-ED-13 fully covered. |
| `scripts/migrate_create_executive_departure_snapshots.ts` | NEW (`c11edb3`) | ~210 LOC. PLANNED_DDL byte-pinned per SPEC §6. |
| `scripts/tests/migrateCreateExecutiveDepartureSnapshots.test.ts` | NEW (`c11edb3`) | 23 node:test. PLANNED_DDL byte-pin + FakeClickHouse coverage + EXPLAIN PLAN. |
| `src/server/executive_departure_repository.ts` | NEW (`db2f7b2`) | ~430 LOC. SPEC §11 OQ-2 GICS-deferred autonomous resolution in module header. |
| `scripts/tests/executiveDepartureRepository.test.ts` | NEW (`db2f7b2`) | 59 node:test. Subquery-around-FINAL + writeSnapshot round-trip + EXPLAIN PLAN. |
| `scripts/daily_signal_daemon.ts` | EDITED (`db2f7b2`) | Step 1i wired between 1h short-interest + §2 cells/bundles. |
| `src/server/operator_brief_render.ts` | EDITED (`f96ff5c`) | BriefExecutiveDepartureSection + renderExecutiveDepartureSection + #12 section ordering. |
| `src/server/operator_brief.ts` | EDITED (`f96ff5c`) | buildExecutiveDepartureSection + fetchLatestExecutiveDepartureFromCH + Promise.all thread. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`f96ff5c`) | brief() fixture extended + 12 rendering tests. |
| `scripts/tests/operatorBrief.test.ts` | EDITED (`f96ff5c`) | 3 composer-wiring tests (null + populated + graceful-degrade). |
| `scripts/help.ts` | EDITED (`c11edb3`) | EXTRA_HELP entries for edgar ingest + migrate scripts. |
| `package.json` | EDITED (`bdd4d4f` + `c11edb3`) | 4 new scripts: 2 ingest + 2 migrate (dry/apply each). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-arc state. |

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); needs operator `npm run migrate:create-executive-departure-snapshots:apply`. Daemon step 1i is absent-table-safe; until operator runs migration, step 1i logs the "table absent" message + skips.

### Tests

```text
npm test                       2210 / 2210 pass / 0 fail / 15 skipped   ✓ (was 2070 pre-A2; +140 net new from A2 + A3 + A4 + A5)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   210 / 210 (was 182 pre-A1; +28 net new from A1)
```

## Watch-outs

### NEW from this session (s91)

- **A4 GICS-sector resolution is structurally dormant.** The composite's aggregate-sector layer + the brief's flagged-sectors table render code paths are implemented + tested but receive zero inputs in v1. A regression test (`renders the v1 GICS-deferred footer when flaggedSectors is empty`) catches an accidental activation that doesn't populate the GICS mapping. v2 activation lands when either A1's SIC capture or a separate gics_sector_map ingest goes in.
- **EDGAR User-Agent compliance is hard-fail.** A1 hard-codes `SignalForge/exec-departure-ingest u0249898@gmail.com`; without a properly-formed UA header, SEC returns 403. Documented in A1 docstring + watch-out preserved from prior HANDOFF.
- **EDGAR rate limit is 10 req/sec.** A1 backs off on 429; cold-cache first run for ~560 unique CIKs is ~60 seconds.
- **`accepted_at` vs `period_of_report` is the load-bearing anti-leak gate.** The daemon's snapshot-as-of-D filter MUST use `accepted_at` (the wall-clock EDGAR-acceptance moment), NOT `period_of_report`. A4 reads enforce this; A2 composite operates on `acceptedAt`. A refactor that swapped to `period_of_report` would introduce a look-ahead-leak vector.
- **Item 5.02 sub-item parsing requires per-filing body fetch.** EDGAR's broad `items` field returns "5.02" not "5.02(b)". A1 fetches the filing's primary doc HTML and regex-matches the structurally-encoded `Item 5.02(X)` header per 17 CFR 249.308.
- **CIK ≠ CUSIP.** `cik_ticker_map` (gap #8) is a separate table from `cusip_ticker_map` (gap #10). Both coexist; both ReplacingMergeTree.
- **A2 per-ticker layer is BINARY.** Per E-13, no per-ticker z-score baseline. A4 repository reads surface event-presence-in-window, not continuous per-ticker statistics.
- **A3 PLANNED_DDL has 10 columns** (vs short-interest A3's 12). The narrower column set reflects the simpler per-snapshot data: boolean cluster flag + two JSON payloads + four metadata + composite version.
- **A3 creates the SNAPSHOT table only.** Source `executive_departures` + cache `cik_ticker_map` are created lazily by A1's `ensure_*_table` calls on first --apply.
- **A5 byte-equal protection on sections #1-#11.** Test pins #12 to render AFTER #11. Future composites (#13 etf-flow, #14+) MUST append at the tail.
- **A5 staleness threshold = 4bd** (vs short-interest's 14bd). Tighter because EDGAR is real-time + filings are statutorily due within 4 business days. A 4bd-stale ingest is a missed daemon run, not a publication-cadence artifact.

### Carried (s89-s90 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 49 commits ahead of `origin/main`; push is operator-gated.
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- FINRA ingest's default endpoint URL is a placeholder; same posture applies to EDGAR A1 (`q="Item 5.02"` query default may need refinement on first-run-with-real-data).
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- `/tmp/session-split-backup/` from s88-cont #3 is still present.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 6 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#12 with real data
```

### Gap #10 short-interest activation (post-merge / per-operator-decision)

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation (post-merge / per-operator-decision; FULLY READY)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily       # step 1i fires; populates executive_departure_snapshots
npm run brief:morning      # section #12 renders the per-ticker flagged-tickers panel
```

### Tests + dev

```text
npm test                                                                       # TS — 2210 pass / 0 fail / 15 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 210 / 210
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #9 — etf-flow-monitoring SPEC. First commit = `docs/specs/etf-flow-monitoring.md` mirroring the executive-departure SPEC structure (§1-§12). Read the gap doc (`docs/obsidian/gaps/etf-flow-monitoring.md` if present; else the broader gap inventory) first; resolve any canon-thin forks autonomously per the CLAUDE.md three-criterion test.

After the SPEC commits, A1-A5 phases follow at the established cadence (one commit per phase).

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Push 49 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the six Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s91 closed with gap #8 executive-departure-signal DONE end-to-end. Six commits this session under the autonomous-execution protocol; zero permission pauses across all six. Four autonomous canon-thin forks resolved (E-2 sub-item-code classification, E-5 no role weighting, E-11 Form 4 deferred to gap #7, A4 GICS-sector deferral per §11 OQ-2).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #9 etf-flow-monitoring. Write `docs/specs/etf-flow-monitoring.md` mirroring the executive-departure SPEC structure. After SPEC lands, A1-A5 follow at the established cadence.

**Parallel-tracks posture continues.** s91 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s91 close:**

```text
ALL S41-S90 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S90: HANDOFF rewrite                           ✓ committed (a5c0751)
S91: gap #8 SPEC executive-departure-signal    ✓ committed (c04b706) — 445 LOC, §1-§12
S91: gap #8 A1 EDGAR ingest + 28 pytest        ✓ committed (bdd4d4f)
S91: gap #8 A2 pure composite + 41 TS tests    ✓ committed (84e69be)
S91: gap #8 A3 snapshot migration + 23 tests   ✓ committed (c11edb3)
S91: gap #8 A4 repository + daemon step 1i     ✓ committed (db2f7b2) + 59 tests
S91: gap #8 A5 brief section #12 + 17 tests    ✓ committed (f96ff5c)
S91: HANDOFF rewrite                           ✓ this commit
  → next: gap #9 etf-flow-monitoring SPEC
  → after SPEC: A1 (ETF.com / ETF Database scraper) → A2-A5 at established cadence
  → after #9 ships: gap #7 event-driven-filings-processor (Form 4 lands here)
  → operator-pickable insertions: ADR-041 impl, Gap #8 v2 GICS activation
  → background: daemon writes per-cycle snapshots for the six Layer-0 composites that have applied migrations
```
