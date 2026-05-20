# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 90 close-out — **gap #10 short-interest-tracking COMPLETE end-to-end**. A4 + A5 landed under the autonomous-execution protocol; two commits across this continuation (`d4f07ea` A4 repository + daemon hook + SPEC amendment, `1543d7d` A5 brief section #11 + tests). The full A1→A5 arc shipped across s89-s90 with zero permission pauses + the Path A4-β shares_short ROC reinterpretation documented in commits + SPEC. Tests grew 2001 → 2070 (+69 net new across A4 and A5 in this continuation; +146 total across the gap #10 arc). 42 commits ahead of `origin/main`, push still held. Slice queue: **gap #8 executive-departure-signal next**, then #9 etf-flow-monitoring, then #7 event-driven-filings-processor.)

## What this turn delivered

Two sub-slices completed gap #10:

1. **A4 — repository + daemon hook + SPEC amendment** — commit `d4f07ea`. Four files:
   - `src/server/short_interest_repository.ts` (~565 LOC). `ShortInterestRepository` with `readLatestPublication`, `readDistinctSettlementDates`, `readLatestFinraRowsAsOf`, `readFinraRowsAtDate`, `readPerTickerShortShortBaseline`, `readSp500ConstituentsPIT`, `readEquityMidcapWatchUniverse`, `readAggregateBaseline`, `readInputsForCycle`, `writeSnapshot`, `loadLatestSnapshot`. All reads use the subquery-around-FINAL pattern (a52c964 regression class). Aggregate baseline uses CURRENT SP500 constituents (v1 simplification; per-historical-date PIT reconstruction deferred to v2). Module-level `shortInterestSnapshotsTableExists` absent-table-safe gate + `runDaemonShortInterestEvaluation` orchestrator with auto-resolution of watch universe + constituents.
   - `scripts/tests/shortInterestRepository.test.ts` (~570 LOC, 63 tests). FakeClickHouse-backed coverage: query-shape regression, parameter binding, Path A4-β semantics (sharesOutstandingT === 1), JSON round-trip, malformed-payload degradation, summary-line shape, table-exists gate, EXPLAIN PLAN grammar (skipped when CH / FINRA tables absent).
   - `scripts/daily_signal_daemon.ts` — step **1h** wired between 1g (cross-asset) and §2 (cells/bundles). Same posture as 1d-1g: `NO_MACRO || DRY_RUN`-gated, absent-table-safe, non-fatal anomaly-pushed on evaluation failure.
   - `docs/specs/short-interest-tracking.md` — §5.1 "v1 implementation note — Path A4-β" added; §11 OQs #1/#2/#3 marked RESOLVED.

2. **A5 — brief section #11 + tests** — commit `1543d7d`. Four files:
   - `src/server/operator_brief_render.ts` — `BriefShortInterestSection` type + `SHORT_INTEREST_FLAGGED_TOP_N` + `SHORT_INTEREST_STALENESS_BD_THRESHOLD` exported constants + `renderShortInterestSection` + 3 small formatters. Section #11 appended after #10; byte-equal protection preserved.
   - `src/server/operator_brief.ts` — `BriefDeps.fetchLatestShortInterest` optional dep; `composeMorningBrief` threads the snapshot through `Promise.all`; `buildShortInterestSection` + `fetchLatestShortInterestFromCH` default helpers (mirror cross-asset graceful-degrade posture).
   - `scripts/tests/operatorBriefRender.test.ts` — 12 new tests covering: null → "not yet evaluated"; EXTREME vs NORMAL header; aggregate scientific notation + z formatting; staleness warning fires at bd ≥ 14 + omitted < 14; no-FINRA-data fallback; "No tickers flagged."; flagged-tickers table; top-N truncation with "X more …" note; universe coverage + Path A4-β caveat; evaluatedAt/snapshotDate footer; null aggregate "—"; byte-equal section ordering (## 11 after ## 10). Existing `brief()` fixture extended with `shortInterest: null`.
   - `scripts/tests/operatorBrief.test.ts` — 3 new tests covering composer wiring (null pass-through + populated round-trip + graceful-degrade-on-throw).

Section #11 rendering convention per Path A4-β: aggregate as scientific notation (e.g. `4.23e+6` shares-short), per-ticker rows show raw `shares_short` (scientific) + `ROC` (percent) + `D2C` (1dp). Field names retain the SIR shape from A2; magnitudes are shares-short per the v1 implementation note. The composite caveat line surfaces "Path A4-β: per-stock ROC computed on `shares_short` directly, no SIR normalization in v1; see SPEC §5.1."

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s89c#2 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 SPEC | ✓ s89c |
| Gap #10 A1 — FINRA ingest | ✓ s89 (`21e08e7`) |
| Gap #10 A2 — pure composite + 52 tests | ✓ s89 (`7d80f74`) |
| Gap #10 A3 — CH snapshot migration + 25 tests | ✓ s89 (`64806ed`) |
| **Gap #10 A4 — repository + daemon hook + 63 tests + SPEC amendment** | **✓ s90 (`d4f07ea`)** |
| **Gap #10 A5 — brief section #11 + 15 tests** | **✓ s90 (`1543d7d`)** |
| **Gap #10 short-interest-tracking arc** | **✓ DONE end-to-end** |
| Gap #8 executive-departure-signal | ☐ NEXT (RESEARCH → SPEC → A1→An arc) |
| Gap #9 etf-flow-monitoring | ☐ queued after #8 |
| Gap #7 event-driven-filings-processor | ☐ queued after #9 |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 42 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 90 (this continuation, A4 + A5)

**S90-3. Gap #10 A4 landed under the autonomous-execution + Path A4-β resolution.** The S90-2 pre-resolution (HANDOFF s90 mid-session) carried through cleanly: the repository passes `sharesOutstanding = 1` into the A2 composite so `computeSIR(shares_short, 1) === shares_short` — the pure-function math is dimensionally agnostic, ROC/D2C/`prior_high_base`/`short_ramp`/`short_capitulation`/aggregate-z all work unchanged. SPEC §5.1 amended with the "v1 implementation note — Path A4-β" paragraph; §11 OQs #1 (corporate-actions source) / #2 (per-ticker baseline window) / #3 (aggregate weighting) all marked RESOLVED with pointers to the s89/s90 commits.
`Why:` keeps the v1 free of any live yfinance shares_outstanding dependency at daemon-eval time and the associated settlement-date asymmetry.
`How to apply:` future A4 maintenance reads only from `quantlab.short_interest` + `quantlab.sp500_constituents` + `quantlab.candles`; the daemon path has no yfinance call for short-interest. If a v2 ADR later opts for true SIR (Path A4-α), the repo layer becomes the only file that needs to change — the A2 composite math stays identical because it's dimensionally agnostic.

**S90-4. Gap #10 A5 brief section #11 rendering convention.** Per Path A4-β, the brief surfaces raw `shares_short` (scientific notation) + ROC (percent) + D2C (1dp) per ticker, and mean(shares_short) (scientific) + z-score for the aggregate. Field names retain the SIR shape from A2; magnitudes are shares-short. The composite caveat line is mandatory ("Path A4-β: per-stock ROC computed on `shares_short` directly, no SIR normalization in v1; see SPEC §5.1") — it's the operator-facing pointer to the SPEC's v1 implementation note.
`Why:` honest about the v1 interpretation; the operator can read raw shares-short + change-pct without being misled by SIR-shaped field labels in the snapshot.
`How to apply:` if a v2 enhancement re-integrates true SIR (Path A4-α), update `renderShortInterestSection`'s formatters + `BriefShortInterestSection` JSDoc + the caveat line; the renderer is otherwise naive about magnitudes.

**S90-5. Sub-slice cadence held across A1→A5.** Five commits, one per sub-slice; each committed independently green; HANDOFF rewrites at slice close-out (A1+A2+A3 mid-session, A4+A5 at gap close). Atomic git history; `git bisect` precise.
`Why:` matches the prior Layer-0 composites' commit pattern (s86/s87/s88).
`How to apply:` gap #8 (next) follows the same cadence — SPEC → A1 → ... → An → HANDOFF.

### Sessions 84-89 + continuations (carried)

All prior decisions preserved unchanged.

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
- Push 42 commits to origin/main — operator-gated.

### Closed this session

- ~~Gap #10 A4 repository + daemon hook + SPEC amendment~~ — DONE.
- ~~Gap #10 A5 brief section #11~~ — DONE.
- ~~Gap #10 short-interest-tracking arc~~ — **DONE end-to-end**.
- ~~SPEC §11 OQs #1/#2/#3~~ — RESOLVED in SPEC amendment.

## Next stage

### Default on "continue"

**Resume queue at gap #8 — executive-departure-signal.** Per the s89c#2 queue (gap #10 → #8 → #9 → #7), gap #8 is up. The work begins with **RESEARCH → SPEC** since no SPEC exists yet for gap #8.

Pre-known scope (from the gap-doc + earlier project notes):

- **Source:** SEC EDGAR Item 5.02 8-K filings (executive departures + new hires). Pre-authorized per CLAUDE.md data-source policy. EDGAR full-text search API + the company submissions index are the two viable read paths; both are free.
- **Signal scope:** per-stock; the per-stock outputs flag tickers with a recent (configurable window, likely 90d-or-shorter) involuntary executive departure. Layer-0 informational per the gap-doc; same SPEC contract as the prior four Layer-0 composites (informational v1 → Phase B validation later).
- **Likely SPEC OQs to surface:** (1) involuntary-vs-voluntary classification heuristic (8-K Item 5.02 text often signals "departed" vs "retired" vs "named president of …"); (2) ticker universe (equity-midcap watch list vs SPY 500 PIT vs full Russell 3000 — same trade-off as gap #10); (3) per-ticker baseline (do we keep a rolling departure rate per industry?); (4) aggregate signal (does cluster departure across a sector fire a regime category?). Each OQ is canon-thin enough to fall under the three-criterion autonomous-resolution rule.

Concrete first task: write `docs/specs/executive-departure-signal.md` mirroring the structure of `docs/specs/short-interest-tracking.md` (sections §1–§12). After SPEC lands as commit #1, A1 = SEC EDGAR ingest Python script (mirroring `scripts/finra_short_interest_ingest.py` + `scripts/cboe_putcall_ingest.py` patterns).

### After gap #8 ships

Per the locked queue:

- Gap #9 etf-flow-monitoring (ETF.com / ETF Database scrapers + flow analytics).
- Gap #7 event-driven-filings-processor (8-K classifier with broader scope than gap #8's narrow exec-departure cut).

Then the deferred-but-on-queue work: ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the five Layer-0 composites.

## Files / code state

### NEW or EDITED this continuation (s90 A4 + A5)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/short_interest_repository.ts` | NEW (committed `d4f07ea`) | 565 LOC repository + Path A4-β. |
| `scripts/tests/shortInterestRepository.test.ts` | NEW (committed `d4f07ea`) | 63 TS tests. |
| `scripts/daily_signal_daemon.ts` | EDITED (committed `d4f07ea`) | Step 1h wired. |
| `docs/specs/short-interest-tracking.md` | EDITED (committed `d4f07ea`) | §5.1 v1 note + §11 OQs resolved. |
| `src/server/operator_brief_render.ts` | EDITED (committed `1543d7d`) | Section #11 + types + formatters. |
| `src/server/operator_brief.ts` | EDITED (committed `1543d7d`) | Composer + buildShortInterestSection + fetch. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (committed `1543d7d`) | +12 section-#11 tests. |
| `scripts/tests/operatorBrief.test.ts` | EDITED (committed `1543d7d`) | +3 composer-wiring tests. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch. |

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created. Created on first `finra:short-interest:ingest --apply` run via A1's `ensure_*_table()` calls.
- `quantlab.short_interest_snapshots` — migration script exists (`scripts/migrate_create_short_interest_snapshots.ts`); needs operator `npm run migrate:create-short-interest-snapshots:apply`. A4 daemon hook fails-safe (absent-table-safe `shortInterestSnapshotsTableExists` gate) until the migration is applied.

### Tests

```text
npm test                       2070 / 2070 pass / 0 fail / 11 skipped   ✓ (was 1924 pre-gap-#10; +146 net new across A1+A2+A3+A4+A5)
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   182 / 182
```

## Watch-outs

### NEW from this continuation (s90 A4 + A5)

- **Path A4-β shim is in the repository layer ONLY.** The A2 composite's `computeSIR(sharesShort, sharesOutstanding)` is called with `sharesOutstanding = 1`, so the SIR field carries `shares_short` magnitudes. If a v2 ADR opts for Path A4-α (true SIR with yfinance integration), the change is local to `src/server/short_interest_repository.ts` + the `renderShortInterestSection` formatters in `src/server/operator_brief_render.ts`. The A2 composite math is dimensionally agnostic and does NOT need to change.
- **Section #11 byte-equal protection.** Adding any new section to the brief MUST go AFTER `## 11.` to preserve byte-equality on sections #1-#11. The test `section ordering: short-interest renders AFTER cross-asset` enforces #11-after-#10 explicitly; the existing tests enforce #10-after-#9 / #9-after-#8 / etc. A future #12 would extend the chain.
- **Aggregate baseline uses CURRENT SP500 constituents.** Per-historical-date PIT reconstruction is deferred to v2 if drift evidence accumulates. SPY 500 turnover is ~3% / year so the 2y baseline drift is small relative to the |z| > 2 threshold; documented in `src/server/short_interest_repository.ts` watch-out.
- **Snapshot's `per_ticker_json` malformed-payload guard.** The repo's `loadLatestSnapshot` degrades gracefully (returns empty `perTickerRows` array) on `JSON.parse` failure; the brief renders "No tickers flagged." in that case rather than crashing. Test `handles malformed per_ticker_json by degrading to empty array` pins this.
- **FINRA ingest's default endpoint URL is a placeholder.** First `npm run finra:short-interest:ingest:dry` will likely 404 — operator paths are `--url <verified-endpoint>` or `--from-file <local-csv>`. The OQ-1 from the SPEC (FINRA endpoint verification) is implicitly handled this way — verification IS first-run.
- **The brief renders short-interest's `aggregateSir` in scientific notation** (e.g. `4.23e+6`). This is intentional per Path A4-β — the underlying value is mean shares-short, not a 0-1 SIR ratio. If a v2 enhancement switches to true SIR, the renderer's `formatShortInterestShares` formatter + the BriefShortInterestSection JSDoc need a coordinated update.

### Carried (s89 + earlier)

All s89 and earlier watch-outs preserved unchanged. Key carry-overs:

- 42 commits ahead of `origin/main`; push is operator-gated.
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern.
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
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run   # verify endpoint or use --from-file
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply     # apply ingest (creates short_interest + cusip_ticker_map)
npm run migrate:create-short-interest-snapshots                              # dry-run migration
npm run migrate:create-short-interest-snapshots:apply                        # apply (creates short_interest_snapshots)
npm run daemon:daily                                                         # populates short_interest_snapshots
npm run brief:morning                                                        # renders section #11 with real data
```

### Tests + dev

```text
npm test                                                                       # TS — 2070 pass / 0 fail / 11 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 182 / 182
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Open gap #8 — executive-departure-signal. Stage = RESEARCH → SPEC. First concrete deliverable: `docs/specs/executive-departure-signal.md` mirroring the structure of `docs/specs/short-interest-tracking.md` (sections §1–§12). Land SPEC as commit #1. Then A1 = SEC EDGAR 8-K Item 5.02 ingest Python script.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Push 42 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the five Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s90 ended with gap #10 short-interest-tracking shipped end-to-end. Five commits across s89-s90 (`21e08e7` A1 → `7d80f74` A2 → `64806ed` A3 → `d4f07ea` A4 → `1543d7d` A5) under the autonomous-execution protocol — zero permission pauses across the full arc, three canon-thin methodology forks resolved autonomously (A2 aggregate weighting + A2 per-ticker baseline + A4 Path A4-β shares_outstanding source), all documented in commits + SPEC + HANDOFF.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #8 (executive-departure-signal) at RESEARCH → SPEC stage. First commit = `docs/specs/executive-departure-signal.md`; subsequent commits follow the A1→An sub-slice cadence per the locked Layer-0 template.

**Parallel-tracks posture continues.** This continuation did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s90 close:**

```text
ALL S41-S89c#2 WORK                            ✓ as documented
S89: gap #10 SPEC (s89c)                       ✓ committed (cdeb94c…187f4a5)
S89: gap #10 A1 FINRA ingest                   ✓ committed (21e08e7) — 18 pytest pass
S89: gap #10 A2 pure composite                 ✓ committed (7d80f74) — 52 TS tests pass
S89: gap #10 A3 CH migration                   ✓ committed (64806ed) — 25 TS tests pass
S90: A4 Path A4-β resolved autonomously        ✓ pre-documented in s90 mid-session HANDOFF
S90: gap #10 A4 repo + daemon + SPEC           ✓ committed (d4f07ea) — 63 TS tests pass
S90: gap #10 A5 brief section #11              ✓ committed (1543d7d) — 15 TS tests pass
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end
S90: tests 1924 → 2070 (+146 net new)          ✓ all green at baseline
S90: HANDOFF rewrite                           ✓ this commit
  → next: gap #8 executive-departure-signal SPEC, then A1→An arc
  → after #8 ships: gap #9 → #7
  → operator-pickable insertion: ADR-041 implementation
  → background: daemon writes per-cycle snapshots for all five Layer-0 composites
```
