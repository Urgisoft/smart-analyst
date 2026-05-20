# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 92 continued — **gap #9 A2 (pure composite + 57 tests) landed** as commit `e4592fe`. Full TS suite at 2267/2267 pass / 0 fail / 15 skipped (57 new). 52 commits ahead of `origin/main`, push still held. **Slice queue: gap #9 A3 (CH migration for `etf_flow_snapshots` + tests) NEXT**, then A4 (repository + daemon step 1j), A5 (brief section #13), then gap #7 event-driven-filings-processor (Form 4 lands there per gap #8 E-11).)

## What this turn delivered

Third commit at the head of the gap #9 etf-flow-monitoring arc (s92 #1 was SPEC `20da333`, s92 #2 was A1 ingest `ab724db`, this is s92 #3):

1. **A2 — pure composite** — commit `e4592fe`. `src/server/etf_flow.ts` (~430 LOC) + `scripts/tests/etfFlow.test.ts` (~480 LOC, 57 tests across the 20 SPEC §9.1 T-EF-N items + orchestrator integration + constants sanity). All tests pass; full TS suite 2267/2267 (0 new failures). tsc baseline holds at 13 errors (unchanged, all pre-existing).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring SPEC + teach-doc | ✓ DONE (s92 commit `20da333`) |
| Gap #9 A1 (yfinance shares-outstanding ingest) | ✓ DONE (s92 commit `ab724db`) |
| **Gap #9 A2 (pure composite + 57 tests)** | **✓ DONE (s92 commit `e4592fe`)** |
| **Gap #9 A3 (CH migration for `etf_flow_snapshots` + tests)** | **☐ NEXT** |
| Gap #9 A4 (repository + daemon step 1j + tests) | ☐ queued |
| Gap #9 A5 (brief section #13 + tests) | ☐ queued |
| Gap #7 event-driven-filings-processor | ☐ queued after gap #9 (Form 4 lands here per #8 E-11) |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 52 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 92 part 3 (this turn, this commit)

**S92-6. Per-ETF input shape: pre-assembled 21-element shares + closes panels.**
`Why:` The composite needs (a) shares_t, (b) shares_{t-20bd}, (c) the full 20-day daily-flow sum for the BFM 2018 fn 7 attribution-correct dollar flow. All three needs are satisfied by passing one 21-element panel per ETF where index 0 = D-20bd and index 20 = D. Carry-forward (F-CADENCE) is applied at the repository layer BEFORE the input is built — the pure function consumes the post-carry-forward panel. This keeps the composite IO-free + matches the s89/s90/s91 pattern of "repository does data assembly; composite does math only."
`How to apply:` A4 repository must build exactly 21 elements per ETF after carry-forward. `computeFlowDollar20bd` throws on wrong length (fail-loud per Vector Core canon — a silent mis-attribution would be worse than a crash). A backfill arc that fetches a partial panel will surface the partial-fill via this throw.

**S92-7. Population stddev (divide by N) for `sector_flow_dispersion`; sample stddev (divide by N-1) for `flow_z` z-scoring.**
`Why:` Semantic split: `sector_flow_dispersion` measures the spread across the 11 SPDR sector ETFs as a CROSS-SECTIONAL property at a single snapshot date — those 11 sectors ARE the population (the SPDR sector ETF universe), not a sample drawn from a larger population. Sample stddev's `n-1` Bessel correction is appropriate for unbiased estimation FROM a sample, which is the wrong framing here. Conversely, `flow_z` z-scoring against the 1y trailing baseline IS a sample-stddev question (the 1y panel is a sample of the population of possible daily prints). The SPEC F-5 threshold (>2.0) is empirically anchored; either choice would shift the threshold marginally but the semantic split is the clean answer.
`How to apply:` `computeSectorFlowDispersion` divides by N (population). `computeZ` divides by N-1 (sample). Both formulas pinned in `src/server/etf_flow.ts`; test fixtures verify both.

**S92-8. `flagged_etfs` deduplication via ticker Set; dedup-belt-and-suspenders even though repository delivers one row per ticker.**
`Why:` An ETF satisfying BOTH the divergence condition AND |flow_z|>2 would appear twice in a naive concat. The SPEC §5.3 `flagged_etfs` shape implies one entry per ticker. The dedupe is also defensive against an accidental duplicate-ticker row from a future repository bug.
`How to apply:` `flaggedSeen` Set in `evaluateEtfFlowComposite`; first-row-wins on duplicates.

### Session 92 part 2 (carried — A1 ingest commit `ab724db`)

**S92-3 through S92-5** carried unchanged: yfinance-direct close fetch (not `daily_bars`), `ticker_factory` test-seam pattern, T-EFI-8 partial-failure non-aborting semantics.

### Session 92 part 1 (carried — SPEC commit `20da333`)

**S92-1 and S92-2** carried unchanged: F-DATA-SOURCE = yfinance, F-UNIVERSE = 21 ETFs.

### Sessions 84-91 prior decisions (carried)

All prior decisions preserved unchanged. S91-7 through S91-10 + S89/S90 + earlier carry through.

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
- Push 52 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable; see s91 OQ).
- Gap #9 v2 cross-validation enhancement (ETF.com scrape OR issuer-CSV multi-source) — operator-pickable.

### Closed this turn

- ~~Gap #9 A2 pure composite + tests~~ — DONE (`e4592fe`).
- ~~Stddev convention for sector_flow_dispersion vs flow_z~~ — RESOLVED per S92-7 (population for cross-section, sample for time-series-based z).

## Next stage

### Default on "continue"

**Gap #9 A3 — CH migration for the snapshot table (`scripts/migrate_create_etf_flow_snapshots.ts` + migration tests).** Per the SPEC §10 Phase A3 deliverable + §9.3 T-EFM-1..T-EFM-4.

Note: A1 ingest already creates the SOURCE table (`etf_shares_outstanding`) via `ensure_etf_shares_outstanding_table` (self-contained bootstrap pattern). A3 creates the SNAPSHOT table (`etf_flow_snapshots`) ONLY — and per SPEC §9.3 T-EFM-4 should also be idempotent on the source table (it can co-bootstrap both for operator convenience, with separate idempotent CREATE IF NOT EXISTS clauses).

Concrete first move on "continue":

1. Read s91 sibling migration `scripts/migrate_create_executive_departure_snapshots.ts` for the structural template (dry-run / apply / DDL-assertion test pattern).
2. Read s89-s90 sibling migration `scripts/migrate_create_short_interest_snapshots.ts` for an additional reference.
3. Write `scripts/migrate_create_etf_flow_snapshots.ts` per SPEC §6 DDL exactly (both tables: `etf_flow_snapshots` AND idempotent re-create of `etf_shares_outstanding` for operator convenience).
4. Write `scripts/tests/migrateCreateEtfFlowSnapshots.test.ts` covering SPEC §9.3 T-EFM-1..T-EFM-4.
5. Add npm scripts to `package.json`: `migrate:create-etf-flow-snapshots` (dry) + `:apply` (apply).
6. Add EXTRA_HELP entries to `scripts/help.ts`.
7. Run `npm test` + `npm run check:help`.
8. Commit as A3 of the gap #9 arc.

### After A3 lands

- **A4** — `src/server/etf_flow_repository.ts` + daemon step 1j + repository tests (per SPEC §9.2 T-EFR-1..T-EFR-Nplus6). Critical: subquery-around-FINAL pattern per a52c964 regression class. Repository assembles the 21-element shares/close panels per ETF after carry-forward; threads through to `evaluateEtfFlowComposite`.
- **A5** — `src/server/operator_brief.ts` + `operator_brief_render.ts` section #13 + brief tests (per SPEC §9.5 + §9.6 T-OBR-EF-1..6 + T-OB-EF-1..3). Section appended LAST to preserve byte-equal-stdout protection on sections #1-#12.

Estimated ~2-3 working days remaining at the established cadence (one commit per phase; phase boundary = natural model-turn boundary).

### After gap #9 ships

Per the locked queue:

- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; **Form 4 path arrives here per gap #8 E-11**).

Then deferred-but-on-queue work: gap #8 v2 GICS-sector activation, gap #9 v2 cross-validation, ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW or EDITED this turn (s92 part 3)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/etf_flow.ts` | NEW (`e4592fe`) | ~430 LOC. Constants (composite version, thresholds, F-UNIVERSE sets). `resolveEtfGroup`. Per-ETF pure funcs (`computeFlowShares20bd`, `computeFlowDollar20bd` with sum-of-daily BFM 2018 fn 7 attribution + length-check throw, `computeFlowPctAum`, `computeReturn20bd`, `computeZ` with sample-stddev). `flagDivergence`. Aggregate pure funcs (`computeSectorFlowDispersion` population-stddev, `computeAggregateRiskOnFlow`, `flagAggregateFlowStress`). Types `EtfFlowPerEtfRow`, `EtfFlowFlaggedEtf`, `EtfFlowPerEtfInput`, `EtfFlowInputs`, `EtfFlowSnapshot`. Orchestrator `evaluateEtfFlowComposite` (builds per-ETF rows, runs aggregate layer, constructs deduplicated `flagged_etfs` list). |
| `scripts/tests/etfFlow.test.ts` | NEW (`e4592fe`) | ~480 LOC, 57 tests covering T-EF-1..T-EF-20 (all 20 SPEC §9.1 items) + orchestrator integration + constants sanity. All pass; full TS suite 2267/2267. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-A2 state. |

### From s92 part 2 (carried; unchanged)

- `scripts/etf_flow_ingest.py` — A1 ingest, ~370 LOC.
- `scripts/tests/test_etf_flow_ingest.py` — 24 tests.
- `package.json` — +2 npm scripts (`etf:flow:ingest` + `etf:flow:ingest:dry`).
- `scripts/help.ts` — +2 EXTRA_HELP entries.

### From s92 part 1 (carried; unchanged)

- `docs/specs/etf-flow-monitoring.md` — SPEC, ~480 LOC.
- `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` — teach-doc, ~150 LOC.

### From s91 (carried; status unchanged)

All s91 files (`executive_departure*`, EDGAR ingest, brief section #12) preserved.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); not yet applied.
- `quantlab.etf_shares_outstanding` — NOT yet created. A1 ingest creates it on first `--apply` run via `ensure_etf_shares_outstanding_table`. Source-table bootstrap, no separate migration.
- `quantlab.etf_flow_snapshots` — **NOT yet created.** A3 migration (NEXT) will create it.

### Tests

```text
npm test                       2267 / 2267 pass / 0 fail / 15 skipped   ✓ (+57 new from this commit)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green (s92 #2 scripts still registered)
.venv/Scripts/python.exe -m pytest scripts/tests   234 / 234 (unchanged from A1)
```

## Watch-outs

### NEW from this turn (s92 A2)

- **21-element panel-length invariant.** `computeFlowDollar20bd` throws on wrong panel length. A4 repository MUST assemble exactly 21 elements per ETF after carry-forward (index 0 = D-20bd; index 20 = D). A backfill arc that fetches a partial panel will hit this throw — that's the correct fail-loud semantic per Vector Core canon, but operator must be ready to handle it on first historical backfill.
- **Sample vs population stddev split.** `computeZ` uses sample stddev (n-1, baseline-as-sample). `computeSectorFlowDispersion` uses population stddev (N, cross-section-as-population). The split is semantically clean but easy to flip in a refactor. Test fixtures pin both formulas independently. Don't unify without re-running the cross-asset/sector-rotation/short-interest threshold calibrations.
- **Divergence sign-comparison edge.** Uses `Math.sign` which returns 0 for zero values. The `|z|>1` guard short-circuits before any zero-sign comparison can fire (since `Math.abs(0)` is not `> 1`). Safe at current threshold (1.0); any future relaxation to >0 must re-examine the zero-sign edge.
- **Cold-start cascade in aggregate.** A single sector ETF missing from `flowZByTicker` (e.g., A4 read returned only 10 of the 11 sector ETFs) drops `sectorFlowDispersion` to null per F-9. Operator sees this via `inputsAvailableAggregateSector < 11` in the snapshot; A5 brief will render a cold-start fallback. Until A4 + A5 land, this state isn't surfaced — but the composite handles it correctly.
- **`flowZByTicker` dedupe by ticker.** If the input list contains the same ticker twice (mis-assembled by repository), the aggregate-layer Map sees only the second row's flow_z, but `perEtfRows` would contain BOTH duplicates. The `flagged_etfs` list deduplicates as belt-and-suspenders. A4 repository must deliver one row per ticker; a soft-validate could be added in A4 but would fight the pure-function discipline here.
- **`evaluateEtfFlowComposite` returns mutable arrays.** Output `perEtfRows` and `flaggedEtfs` are typed `ReadonlyArray<...>` but constructed as mutable arrays internally. Don't mutate at consumer sites — TS type system enforces this at compile time only.

### Carried (s89-s92 part 2 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 52 commits ahead of `origin/main`; push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1; failure surface is single `RuntimeError` per ticker, easy triage).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine; back-to-back historical re-ingest could hit 429).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`. A1 sidesteps by fetching close directly from yfinance; A2 reads from `etf_shares_outstanding` only (which carries materialized close).
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target). Not a concern for v1 (oldest SPY 1993; youngest XLC 2018) but watch-out for v2 universe expansion.
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate in gap #8.
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1).
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- A5 byte-equal protection on sections #1-#12; future #13+ MUST append at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite (now landed: STALENESS_BD_THRESHOLD constant + threaded through `bdSinceLastShareUpdate` max scalar).
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side; shares-outstanding side is also split-adjusted post-event.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 6 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#12 with real data
```

### Gap #9 etf-flow activation (PARTIALLY READY — A1+A2 done; pending A3 through A5)

```text
# A1 ingest (READY now):
npm run etf:flow:ingest:dry
npm run etf:flow:ingest

# After A3 lands:
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# After A4 lands:
npm run daemon:daily       # step 1j fires; populates etf_flow_snapshots

# After A5 lands:
npm run brief:morning      # section #13 renders the ETF flow panel
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
npm test                                                                       # TS — 2267 pass / 0 fail / 15 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 234 / 234
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #9 — A3 CH migration. First commit = `scripts/migrate_create_etf_flow_snapshots.ts` + `scripts/tests/migrateCreateEtfFlowSnapshots.test.ts` (per SPEC §9.3 T-EFM-1..T-EFM-4). Read s91 `migrate_create_executive_departure_snapshots.ts` for the structural template + s89-s90 `migrate_create_short_interest_snapshots.ts` for an additional reference. Plus `package.json` npm scripts + `scripts/help.ts` entries.

After A3 commits, A4 (repository + daemon step 1j), A5 (brief section #13) follow at the established cadence.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation (operator-pickable insertion).
- Push 52 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s92 continues with gap #9 A2 landed as commit `e4592fe`. The pure composite + 57 tests are in; the composite reads from a 21-element shares/close panel per ETF (assembled by the upcoming A4 repository after carry-forward) and emits per-ETF rows + aggregate scalars + a deduplicated `flagged_etfs` list.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #9 A3. Write `scripts/migrate_create_etf_flow_snapshots.ts` + tests per SPEC §9.3. Idempotent CREATE IF NOT EXISTS for both `etf_flow_snapshots` AND `etf_shares_outstanding` (the latter as a co-bootstrap convenience — A1 already creates it but having both in one migration script is operator-friendly). Commit as the fifth commit of the gap #9 arc.

**Parallel-tracks posture continues.** s92 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s92 part 3:**

```text
ALL S41-S91 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc     ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                           ✓ committed (6e9ffe0)
S92 #1: gap #9 SPEC + teach-doc                ✓ committed (20da333)
S92 #2: gap #9 A1 ingest + 24 tests            ✓ committed (ab724db)
S92 #3: gap #9 A2 composite + 57 tests         ✓ committed (e4592fe)
S92 HANDOFF rewrite (this commit)              ✓ this commit
  → next: gap #9 A3 (CH migration + tests per SPEC §9.3)
  → after A3: A4 (repository + daemon step 1j + tests) →
              A5 (brief section #13 + tests)
  → after gap #9 ships: gap #7 event-driven-filings-processor (Form 4 lands here)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS activation,
                                  gap #9 v2 cross-validation
  → background: daemon writes per-cycle snapshots for the seven Layer-0 composites
                that have applied migrations
```
