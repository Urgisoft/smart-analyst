# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 91 mid-session — **gap #8 SPEC + A1 + A2 + A3 landed; A4 + A5 next.** Four commits this session under the autonomous-execution protocol with zero permission pauses (`c04b706` SPEC + `bdd4d4f` A1 + `84e69be` A2 + `c11edb3` A3). Tests grew 2070 → 2134 (+64 TS net new across A2 + A3) plus 182 → 210 (+28 pytest from A1). 47 commits ahead of `origin/main`, push still held. Slice queue: **gap #8 A4 + A5 next** to close the arc, then #9 etf-flow-monitoring, then #7 event-driven-filings-processor.)

## What this turn delivered

Four commits across the gap #8 executive-departure-signal arc:

1. **SPEC — executive-departure-signal (`exec_departure_v1`)** — commit `c04b706`. `docs/specs/executive-departure-signal.md` (~445 LOC). Sixth Layer-0 informational composite. Mirrors short-interest SPEC structure §1-§12. Decisions table E-1..E-14. Three canon-thin forks (E-2 sub-item-code-only classification, E-5 no role weighting, E-11 Form 4 deferred to gap #7) resolved autonomously per the CLAUDE.md three-criterion test.

2. **A1 — SEC EDGAR 8-K Item 5.02 ingest (Python)** — commit `bdd4d4f`. Three files:
   - `scripts/sec_edgar_8k_item_5_02_ingest.py` (~575 LOC). EDGAR full-text search API poll + Item 5.02 sub-item-code header regex + CIK→ticker resolution via submissions API + ReplacingMergeTree writes. Three operator paths (--url / --from-file / default) matching FINRA A1 precedent.
   - `scripts/tests/test_sec_edgar_8k_item_5_02_ingest.py` (~340 LOC, 28 pytest). SPEC §9.4 T-EDI-1..T-EDI-7 fully covered + helper coverage.
   - `package.json` — `edgar:exec-departure:ingest:dry`/`:apply` npm scripts.

3. **A2 — pure composite + 41 tests** — commit `84e69be`. Two files:
   - `src/server/executive_departure.ts` (~330 LOC). Pure functions: `dedupeEvents`, `filterEventsInWindow`, `countEventsInWindow`, `flagExecutiveDeparture`, `flagExecutiveAppointment`, `daysSinceLatestEvent`, `computeSectorDepartureRate`, `computeZ`, `flagExecutiveClusterDeparture`, `evaluateExecutiveDepartureComposite`. Composite version stamp = `exec_departure_v1`.
   - `scripts/tests/executiveDeparture.test.ts` (~370 LOC, 41 node:test). SPEC §9.1 T-ED-1..T-ED-13 fully covered + orchestrator-integration + constants-sanity.

4. **A3 — CH snapshot migration + 23 tests** — commit `c11edb3`. Four files:
   - `scripts/migrate_create_executive_departure_snapshots.ts` (~210 LOC). PLANNED_DDL byte-pinned per SPEC §6 (with Float32 / DateTime64(3) computed_at / composite_version / index_granularity 8192 deviations matching the short-interest A3 precedent).
   - `scripts/tests/migrateCreateExecutiveDepartureSnapshots.test.ts` (~220 LOC, 23 node:test). PLANNED_DDL byte-pin + EXPECTED_COLUMNS alignment + FakeClickHouse runPreChecks/runPostChecks + EXPLAIN PLAN grammar check (skipped when CH unreachable).
   - `scripts/help.ts` — EXTRA_HELP entries for edgar:exec-departure:ingest + the two A3 migrate scripts.
   - `package.json` — `migrate:create-executive-departure-snapshots:dry`/`:apply` npm scripts.

The CH snapshot table is created exclusively by A3; the raw event stream `executive_departures` + the `cik_ticker_map` cache are created lazily by A1's `ensure_*_table` calls on first --apply. Same separation as gap #10's FINRA precedent.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s90 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 SPEC — executive-departure-signal | ✓ s91 (`c04b706`) |
| Gap #8 A1 — SEC EDGAR 8-K Item 5.02 ingest + 28 pytest | ✓ s91 (`bdd4d4f`) |
| Gap #8 A2 — pure composite + 41 TS tests | ✓ s91 (`84e69be`) |
| Gap #8 A3 — CH snapshot migration + 23 TS tests | ✓ s91 (`c11edb3`) |
| **Gap #8 A4 — repository + daemon step 1i + tests** | **☐ NEXT** |
| Gap #8 A5 — brief section #12 + tests | ☐ queued after A4 |
| Gap #9 etf-flow-monitoring | ☐ queued after #8 |
| Gap #7 event-driven-filings-processor | ☐ queued after #9 (Form 4 deferred from gap #8 lands here) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 47 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 91 (this turn)

**S91-1. Gap #8 SPEC structure mirrors short-interest section-for-section.** §1-§12 with 14 decision lock-ins (E-1..E-14). Three new CH tables in SPEC §6: `executive_departures` (raw event stream), `executive_departure_snapshots` (per-snapshot composite output), `cik_ticker_map` (CIK↔ticker, separate from `cusip_ticker_map`).
`Why:` precedent-respecting matches the cross-asset / short-interest / sector-rotation pattern; uniformity speeds A1-A5 execution.
`How to apply:` A4 (next) reads SPEC §5 (composite formulas) + §7 (daemon hook position 1i) + §4 (input table); A5 reads §8 (brief panel mock) + §9.5-§9.6 (test plan).

**S91-2. Three canon-thin forks resolved (E-2 / E-5 / E-11) — documented in commit + SPEC.** No permission pauses; each resolution carries a three-criterion justification in the §2 decisions table.
`Why:` per CLAUDE.md autonomous-execution canon-thin rule; v1 is conservative-by-design (zero classification heuristics, zero role-weighting, zero free parameters beyond the inherited |z|>2 aggregate threshold).
`How to apply:` if Phase B reveals v1 lacks predictive power, a v2 ADR can re-open any of E-2 / E-5 / E-11 with explicit canon support (e.g. Cohen-Malloy-Pomorski 2012 for Form 4; Warner-Watts-Wruck-derived weights for CEO weighting).

**S91-3. A1 implementation: full-text search → body-parse → submissions-API resolution → CH write.** The EDGAR full-text search API gives the filing list with broad-item codes (e.g. "5.02"); the sub-item LETTER (a/b/c/d/e) requires per-filing body fetch + header regex `Item\s*5\.02\s*\(\s*([a-e])\s*\)`. CIK→ticker resolution uses the submissions API with `formerNames` preserved in `former_tickers` array. In-memory `ticker_cache` avoids duplicate fetches per ingest pass. Rate-limit: 429 → 1s backoff + retry up to 3 times.
`Why:` SEC requires User-Agent header (default `SignalForge/exec-departure-ingest u0249898@gmail.com`); 10 req/s rate limit. The two-tier fetch pattern (search → body-per-filing) is necessary because the broad items field in EDGAR's response does NOT include the sub-letter.
`How to apply:` A4 reads from `quantlab.executive_departures` (already populated by A1's --apply runs); never re-fetches the body. Daemon doesn't touch EDGAR.

**S91-4. A2 composite is dimensionally-agnostic about event sparsity per E-13.** Per-stock layer is BINARY (≥1 event in 90d → flag fires; otherwise false). The z-score baseline lives at the sector-aggregate layer ONLY. Same `computeZ` shape as short-interest with MIN_Z_BASELINE = 30 + 1e-12 degenerate-stddev guard.
`Why:` events are sparse (0-1 per ticker per year); a per-ticker z-score against trailing 2y would be ill-defined for most tickers (division by zero or near-zero stddev).
`How to apply:` A4 repository assembles `ExecutiveDepartureInputs` from CH reads; the composite consumes the assembled inputs unchanged. A5 brief renders the binary per-stock flags + the sector-aggregate flagged-sectors table.

**S91-5. A3 migration: snapshot table only (separation-of-concerns with A1).** A1's `ensure_executive_departures_table` + `ensure_cik_ticker_map_table` calls handle the raw event stream + CIK cache lazily on first --apply. A3 migration handles the snapshot table only. Same pattern as the short-interest A3 vs FINRA A1 division.
`Why:` snapshot table has a structurally different lifecycle (created when daemon first writes a snapshot; idempotently re-applied); raw event stream tables are created when ingest first runs.
`How to apply:` A4 reads from all three tables; the daemon's step 1i hook checks `executive_departure_snapshots` existence via the `executiveDepartureSnapshotsTableExists` gate (absent-table-safe), matching the short-interest A4 posture.

**S91-6. Sub-slice cadence sustained: SPEC + A1 + A2 + A3 each as own commit.** Four commits in one session matches the s90 mid-session HANDOFF cadence (which rewrote after A1+A2+A3 of gap #10). Atomic git history; `git bisect` precise.
`Why:` matches the prior Layer-0 composites' commit pattern (s86/s87/s88/s89/s90); the HANDOFF rewrite cadence is multi-commit-slice-boundary, not after-every-commit.
`How to apply:` A4 + A5 follow as the next two commits; HANDOFF rewrites at end-of-arc (after A5 lands).

### Sessions 84-90 + continuations (carried)

All prior decisions preserved unchanged. The s90 close-out brief is now in git history (`a5c0751`).

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
- Push 47 commits to origin/main — operator-gated.

### NEW from gap #8 SPEC (§11 — 10 implementation-deferred OQs)

1. EDGAR full-text search API exact query syntax (A1 first-run discovery posture; placeholder `?q="Item 5.02"&forms=8-K&dateRange=custom&startdt=...&enddt=...`).
2. GICS sector mapping source (reuse SPDR-sector map vs pull SIC from submissions). A4 implementation decision.
3. CIK-to-ticker fallback for delisted tickers (cache forever, mirror short-interest).
4. EDGAR rate-limit + User-Agent compliance (10 req/s, hard-coded SignalForge UA; ALREADY IMPLEMENTED in A1).
5. `8-K/A` amendment handling (additive-event treatment in v1; A1 sets is_amendment column; composite treats both equally).
6. Voluntary-vs-involuntary classification (v2 ADR; gap doc OQ).
7. Role-severity weighting (v2 ADR; gap doc OQ).
8. Form 4 integration (gap #7 OR v2 ADR; gap doc primary signal).
9. Snapshot retention (v1: no pruning, ~5.5MB/year cumulative).
10. Source-table retention (negligible, ~560 rows/year).

### Closed this session

- ~~Gap #8 SPEC~~ — DONE (`c04b706`).
- ~~Gap #8 A1 SEC EDGAR ingest~~ — DONE (`bdd4d4f`).
- ~~Gap #8 A2 pure composite~~ — DONE (`84e69be`).
- ~~Gap #8 A3 snapshot migration~~ — DONE (`c11edb3`).

## Next stage

### Default on "continue"

**Gap #8 A4 — repository + daemon step 1i.** Mirrors the short-interest A4 pattern (`src/server/short_interest_repository.ts` + `runDaemonShortInterestEvaluation`).

Concrete deliverables:

- `src/server/executive_departure_repository.ts` (~500-600 LOC). Will export:
  - `ExecutiveDepartureRepository` class with reads: `readLatestEvents` (rolling 90d window per ticker), `readDistinctSettlementDates` (not applicable here — EDGAR is real-time; use `readLatestAcceptedAt` instead), `readPerTickerEventsAsOf` (per-ticker event panel for the watch universe), `readSectorPanelAsOf` (SPY-500 PIT × GICS sector × event count), `readSectorDepartureRateBaseline2y` (trailing 2y daily panel of per-sector rates), `readSp500ConstituentsPIT` (already exists; reuse), `readEquityMidcapWatchUniverse` (already exists; reuse from short-interest A4).
  - `writeSnapshot` + `loadLatestSnapshot` (JSON-encoded per-ticker + flagged-sectors payload columns).
  - Module-level `executiveDepartureSnapshotsTableExists` absent-table-safe gate.
  - `runDaemonExecutiveDepartureEvaluation` orchestrator wiring repository reads → composite evaluation → snapshot write.
- `scripts/tests/executiveDepartureRepository.test.ts` — FakeClickHouse-backed coverage: query-shape regression (subquery-around-FINAL pattern per a52c964 regression class), parameter binding, snapshot round-trip, malformed-payload degradation, absent-table gate, EXPLAIN PLAN grammar.
- `scripts/daily_signal_daemon.ts` — wire step 1i between 1h (short-interest) and §2 (cells/bundles). Same posture as 1d-1h: `NO_MACRO || DRY_RUN`-gated, absent-table-safe, non-fatal anomaly-pushed on failure.

GICS sector mapping resolution (SPEC §11 OQ-2): the simplest path is to look at what cycle/cross-asset/sector-rotation already use. If that mapping exists in a reusable form, import it; otherwise A4 introduces a minimal per-ticker GICS sector lookup keyed off SPY constituents.

### After A4 ships

**Gap #8 A5 — brief section #12.** Mirrors short-interest A5 pattern (`renderShortInterestSection` + composer wiring + 12 tests). Brief section #12 appends AFTER section #11 (preserves byte-equal-stdout protection on #1-#11).

### After gap #8 ships

Per the locked queue:

- Gap #9 etf-flow-monitoring (ETF.com / ETF Database scrapers + flow analytics).
- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; Form 4 path arrives here per gap #8 E-11).

Then the deferred-but-on-queue work: ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the six Layer-0 composites.

## Files / code state

### NEW or EDITED this session (s91)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/executive-departure-signal.md` | NEW (`c04b706`) | 445 LOC, mirrors short-interest SPEC structure. §1-§12 complete; §2 decisions table E-1..E-14. |
| `scripts/sec_edgar_8k_item_5_02_ingest.py` | NEW (`bdd4d4f`) | ~575 LOC. EDGAR ingest + sub-item header regex + CIK→ticker resolve + RM-tree writes. |
| `scripts/tests/test_sec_edgar_8k_item_5_02_ingest.py` | NEW (`bdd4d4f`) | 28 pytest. SPEC §9.4 T-EDI-1..T-EDI-7 fully covered. |
| `src/server/executive_departure.ts` | NEW (`84e69be`) | ~330 LOC. Pure composite per SPEC §5. |
| `scripts/tests/executiveDeparture.test.ts` | NEW (`84e69be`) | 41 node:test. SPEC §9.1 T-ED-1..T-ED-13 fully covered. |
| `scripts/migrate_create_executive_departure_snapshots.ts` | NEW (`c11edb3`) | ~210 LOC. PLANNED_DDL byte-pinned per SPEC §6. |
| `scripts/tests/migrateCreateExecutiveDepartureSnapshots.test.ts` | NEW (`c11edb3`) | 23 node:test. PLANNED_DDL byte-pin + FakeClickHouse coverage + EXPLAIN PLAN. |
| `scripts/help.ts` | EDITED (`c11edb3`) | EXTRA_HELP entries for edgar:exec-departure:ingest + migrate:create-executive-departure-snapshots. |
| `package.json` | EDITED (`bdd4d4f` + `c11edb3`) | 4 new scripts: 2 ingest + 2 migrate (dry/apply each). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch. |

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); needs operator `npm run migrate:create-executive-departure-snapshots:apply`. A4 daemon hook (NEXT) will fail-safe (absent-table-safe gate) until migration applied.

### Tests

```text
npm test                       2134 / 2134 pass / 0 fail / 11 skipped   ✓ (was 2070 pre-A2; +64 net new from A2 + A3)
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   210 / 210 (was 182 pre-A1; +28 net new from A1)
```

## Watch-outs

### NEW from this session (s91)

- **EDGAR User-Agent compliance is hard-fail.** SEC explicitly bans programmatic access without a `User-Agent: name email@domain` header. A1 hard-codes `SignalForge/exec-departure-ingest u0249898@gmail.com` (operator-overridable via `--user-agent`); without it, all requests will 403. Already implemented; documented in script docstring.
- **EDGAR rate limit is 10 req/sec.** A1 implements back-off on 429 with 1s initial delay, doubling each retry, up to 3 retries. CIK→ticker resolution for ~60 equity-midcap tickers + ~500 SPY-500 tickers is ~560 total requests at first cold-cache run = ~60 seconds at 10 req/s. After cache populates, ongoing daemon runs do ~0 lookups (cache hits).
- **`accepted_at` vs `period_of_report` is the load-bearing anti-leak gate.** Per E-7, the daemon's snapshot-as-of-D filter MUST use `accepted_at` (the wall-clock EDGAR-acceptance moment), NOT `period_of_report`. A1's `filter_by_acceptance_date` enforces this. A2's `filterEventsInWindow` also operates on `acceptedAt`. A4 reads MUST not mix.
- **Item 5.02 sub-item parsing requires per-filing body fetch.** EDGAR's broad `items` field returns "5.02" not "5.02(b)". A1 fetches the filing's primary doc HTML and regex-matches the structurally-encoded `Item 5.02(X)` header. This is SEC-encoded structure per 17 CFR 249.308, NOT free-text NLP (E-2 fork).
- **CIK ≠ CUSIP.** CIK (Central Index Key) is EDGAR's primary key; CUSIP is FINRA's primary key. `cik_ticker_map` (gap #8) is a separate table from `cusip_ticker_map` (gap #10). Both coexist; both ReplacingMergeTree.
- **A2 per-ticker layer is BINARY.** Per E-13, no per-ticker z-score baseline. A4 repository reads must surface event-presence-in-window, not continuous per-ticker statistics. The composite's `inputsAvailablePerTicker` counts rows with both `cik` and `sector` populated (i.e., resolvable to GICS sector AND with a valid CIK→ticker mapping).
- **A2 `computeZ` uses sample stddev (n-1)** per López de Prado AFML §1.3 + 1e-12 degenerate-stddev guard, identical shape to short-interest A2. Sector baselines must contain ≥ 30 valid prints; below the floor, z is null and `executive_cluster_departure` is false.
- **A3 PLANNED_DDL has 10 columns** (vs short-interest A3's 12). The narrower column set reflects the simpler per-snapshot data: only one boolean flag + two JSON payloads + four metadata + composite version. NOT a missing column issue; the snapshot data is structurally simpler.
- **A3 creates the SNAPSHOT table only.** Source `executive_departures` + cache `cik_ticker_map` are created lazily by A1. Documented in commit message + migration docstring.
- **Section #12 byte-equal protection.** A5 (next) MUST append after `## 11.` to preserve byte-equality on sections #1-#11. Will follow same pattern as short-interest A5 (commit `1543d7d`).

### Carried (s89-s90 + earlier)

All s90 watch-outs preserved unchanged. Key carry-overs:

- 47 commits ahead of `origin/main`; push is operator-gated.
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
npm run daemon:daily                                    # all 5 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#11 with real data
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

### Gap #8 executive-departure activation (post-A4→A5-merge / per-operator-decision; PARTIALLY READY)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
# (daemon hook + brief panel pending A4 + A5)
```

### Tests + dev

```text
npm test                                                                       # TS — 2134 pass / 0 fail / 11 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 210 / 210
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #8 A4 — repository + daemon step 1i. First commit = `src/server/executive_departure_repository.ts` + `scripts/tests/executiveDepartureRepository.test.ts` + daemon-hook wiring in `scripts/daily_signal_daemon.ts`. Mirrors `src/server/short_interest_repository.ts` structurally; SPEC §4 + §7 + §9.2 are the contract.

After A4 lands, A5 follows immediately (brief section #12 in `src/server/operator_brief_render.ts` + composer wiring in `src/server/operator_brief.ts`).

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Push 47 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the six Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s91 opened with gap #10 short-interest closed end-to-end (s89-s90) and four commits of gap #8 landed this session under the autonomous-execution protocol (SPEC + A1 + A2 + A3). Zero permission pauses across all four; three canon-thin forks resolved autonomously (E-2 / E-5 / E-11).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #8 A4 — repository + daemon step 1i. Mirror the short-interest A4 pattern (`src/server/short_interest_repository.ts`). After A4 lands, A5 (brief section #12) follows immediately under the autonomous-execution protocol.

**Parallel-tracks posture continues.** This session did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s91 mid-session:**

```text
ALL S41-S90 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S90: HANDOFF rewrite                           ✓ committed (a5c0751)
S91: gap #8 SPEC executive-departure-signal    ✓ committed (c04b706) — 445 LOC, §1-§12
S91: gap #8 A1 EDGAR ingest + 28 pytest        ✓ committed (bdd4d4f)
S91: gap #8 A2 pure composite + 41 TS tests    ✓ committed (84e69be)
S91: gap #8 A3 snapshot migration + 23 tests   ✓ committed (c11edb3)
S91: HANDOFF rewrite                           ✓ this commit
  → next: gap #8 A4 repository + daemon step 1i
  → after A4: gap #8 A5 brief section #12
  → after #8 ships: gap #9 etf-flow → gap #7 event-driven-filings (Form 4 lands here)
  → operator-pickable insertion: ADR-041 implementation
  → background: daemon writes per-cycle snapshots for the five Layer-0 composites that have applied migrations
```
