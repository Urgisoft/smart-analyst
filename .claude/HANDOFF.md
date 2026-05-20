# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 92 open — **gap #9 etf-flow-monitoring SPEC + teach-doc landed** as commit `20da333`. Single-commit forward tick from the s91-end state. Tests unchanged (no source-code changes this turn). 50 commits ahead of `origin/main`, push still held. **Slice queue: gap #9 A1 (yfinance shares-outstanding ingest) NEXT**, then A2-A5, then gap #7 event-driven-filings-processor (Form 4 lands there per gap #8 E-11).)

## What this turn delivered

One commit at the head of the gap #9 etf-flow-monitoring arc:

1. **SPEC — etf-flow-monitoring (`etf_flow_v1`)** — commit `20da333`. `docs/specs/etf-flow-monitoring.md` (~480 LOC) + `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` (~150 LOC). Seventh Phase-9-gap Layer-0 informational composite. One canon-thin fork (F-DATA-SOURCE) resolved autonomously.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s90 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| **Gap #9 etf-flow-monitoring SPEC + teach-doc** | **✓ DONE (s92 commit `20da333`)** |
| **Gap #9 A1 (yfinance shares-outstanding ingest)** | **☐ NEXT** |
| Gap #9 A2-A5 | ☐ queued |
| Gap #7 event-driven-filings-processor | ☐ queued after gap #9 (Form 4 lands here per #8 E-11) |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 50 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 92 (this session, this commit)

**S92-1. Gap #9 F-DATA-SOURCE canon-thin fork: v1 source = yfinance shares-outstanding panel (`yf.Ticker(t).get_shares_full(start, end)`), joined with daily_bars close. ETF.com / ETFdb Playwright scrape and issuer-CSV multi-source paths remain pre-authorized fallbacks per CLAUDE.md but are deferred to v2.**
`Why:` Three-criterion analysis. (1) **Canon foundations** — Ben-David-Franzoni-Moussawi 2018 JoF §3 constructs ETF flows from the CRSP shares-outstanding panel; yfinance shares-outstanding IS the Yahoo-Finance-sourced equivalent. The methodology matches the load-bearing citation. (2) **Methodology rigor** — yfinance is a single library, schema-pinned (`pip freeze`), well-tested. Scrape requires per-page Playwright orchestration + schema validation + cache-last-good discipline. Issuer CSVs require 4+ parsers (iShares/SPDR/Invesco/Vanguard). (3) **Free parameters** — yfinance = 0 parsers. Scrape = 1 brittle parser + cache TTL. Multi-source CSV = 4+ parsers + 4+ schedules.
`How to apply:` A1 builds `scripts/etf_flow_ingest.py` against yfinance. v2 cross-validation deliverable can add ETF.com scrape OR issuer-CSV multi-source if Phase B reveals data-quality gaps. Documented in SPEC §2 row F-DATA-SOURCE + §11 OQ-1.

**S92-2. Gap #9 universe (F-UNIVERSE) = 21 ETFs** in three groups: (a) broad-index (6) SPY/IVV/VOO/QQQ/IWM/DIA; (b) SPDR sector (11) XLK/XLF/XLE/XLV/XLY/XLP/XLU/XLI/XLB/XLRE/XLC; (c) style/risk (4) HYG/JNK/TLT/GLD. Subset of gap-doc list (~30 ETFs) tight enough to keep first-ingest fast (~5300 rows) + cover load-bearing factor exposures.
`Why:` Universe expansion (country ETFs, factor ETFs, leveraged ETFs) requires a F-10 version bump and a new ADR; deferred to v2.
`How to apply:` A2 hard-codes the universe as a constant. A1 ingest loops over the 21 tickers. Brief section #13 renders all 21 in the per-ETF table (top-N=5 truncation on the flagged-ETFs sub-section).

**S92-3. Daemon step 1j wiring posture mirrors 1d-1i.** `NO_MACRO || DRY_RUN`-gated, absent-table-safe (via `etfFlowSnapshotsTableExists`), non-fatal try/catch with anomalies push. Standard Layer-0 informational evaluation cadence.
`Why:` Established pattern; predictable failure surface; no surprises in operator workflow.
`How to apply:` Same posture as exec-departure A4 step 1i (committed `db2f7b2`). Brief section #13 appended last to preserve byte-equal-stdout protection on #1-#12.

### Sessions 84-91 prior decisions (carried)

All prior decisions preserved unchanged. S91-7 through S91-10 (gap #8 lock-ins) + S89/S90 + earlier carry through. The implementation of those decisions is complete in the source tree + git history.

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
- Push 50 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable; see s91 OQ).

### NEW from this session

1. **Gap #9 v2 cross-validation enhancement.** Operator-pickable insertion after v1 ships. Path α = ETF.com Playwright scrape as a flow-figure cross-validator (1 brittle parser + cache TTL). Path β = issuer-CSV multi-source (iShares + SPDR + Invesco + Vanguard, 4+ parsers + 4+ schedules). Activates if Phase B reveals yfinance shares-outstanding data-quality gaps (lag, coverage, or accuracy). v1 is canon-load-bearing and operationally simplest; v2 is hedge against future yfinance API breakage.

### Closed this session

- ~~Gap #9 SPEC~~ — DONE (`20da333`).
- ~~F-DATA-SOURCE source-selection fork~~ — RESOLVED autonomously per S92-1.

## Next stage

### Default on "continue"

**Gap #9 A1 — yfinance shares-outstanding ingest (`scripts/etf_flow_ingest.py`).** Per the SPEC §10 Phase A1 deliverable. The Python ingest unit polls `yf.Ticker(t).get_shares_full(start, end)` for the 21-ETF v1 universe (F-UNIVERSE), joins with the existing `quantlab.daily_bars` close prices on (ticker, date), materializes the AUM column (`shares × close`), and writes to `quantlab.etf_shares_outstanding` (ReplacingMergeTree keyed on (ticker, date)). Mirrors the s91 EDGAR ingest A1 structure (`scripts/sec_edgar_8k_item_5_02_ingest.py`) for table-bootstrap-on-first-run + idempotent re-ingest + dry-run flag.

Concrete first move on "continue":

1. Read `scripts/macro_regime_ingest.py` + `scripts/fetch_daily_yfinance.py` to confirm the yfinance integration pattern already established in the repo.
2. Read the s91 A1 ingest (`scripts/sec_edgar_8k_item_5_02_ingest.py`) for the structural template (table-bootstrap, --dry-run flag, --apply flag, idempotent ReplacingMergeTree writes, help/npm registration pattern).
3. Write `scripts/etf_flow_ingest.py` per SPEC §4 inputs + §6 source-table DDL.
4. Write `scripts/tests/test_etf_flow_ingest.py` covering SPEC §9.4 T-EFI-1..T-EFI-8.
5. Add 2 npm scripts to `package.json`: `etf:flow:ingest:dry-run` + `etf:flow:ingest:apply`.
6. Update `scripts/help.ts` with the EXTRA_HELP entries.
7. Run pytest to confirm green.
8. Commit as the second commit of the gap #9 arc.

### After A1 lands

- **A2** — `src/server/etf_flow.ts` pure composite + `scripts/tests/etfFlow.test.ts` (~20 tests per SPEC §9.1).
- **A3** — `scripts/migrate_create_etf_flow_snapshots.ts` + migration tests (per SPEC §9.3).
- **A4** — `src/server/etf_flow_repository.ts` + daemon step 1j + repository tests (per SPEC §9.2).
- **A5** — `src/server/operator_brief.ts` + `operator_brief_render.ts` section #13 + brief tests (per SPEC §9.5 + §9.6).

Estimated ~6 working days at the established cadence (one commit per phase; phase boundary = natural model-turn boundary).

### After gap #9 ships

Per the locked queue:

- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; **Form 4 path arrives here per gap #8 E-11**).

Then deferred-but-on-queue work: gap #8 v2 GICS-sector activation, gap #9 v2 cross-validation, ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW or EDITED this turn (s92)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/etf-flow-monitoring.md` | NEW (`20da333`) | ~480 LOC, §1-§12, 14 decision lock-ins (F-1..F-14, F-DATA-SOURCE, F-UNIVERSE, F-CADENCE). |
| `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` | NEW (`20da333`) | ~150 LOC. BFM 2018 §3 flow construction + divergence-as-leading-indicator intuition + 7 failure modes + comparison table across all seven Layer-0 composites. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-turn state. |

### From s91 (carried; status unchanged)

All s91 files (`exec_departure*`, `executive_departure*`, EDGAR ingest, brief section #12) preserved. See prior HANDOFF for the full s91 file delta.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); not yet applied.
- `quantlab.etf_shares_outstanding` + `quantlab.etf_flow_snapshots` — **NOT yet created.** A1 ingest builds the source table on first --apply run; A3 migration builds the snapshot table. Both still pending creation.

### Tests

```text
npm test                       2210 / 2210 pass / 0 fail / 15 skipped   ✓ (unchanged from s91)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   210 / 210 (unchanged from s91)
```

## Watch-outs

### NEW from this session (s92)

- **F-DATA-SOURCE locked yfinance v1 path.** The composite's correctness depends on yfinance `get_shares_full` returning accurate shares-outstanding for the 21 ETF universe. yfinance lag is typically T+1 to T+2 (Yahoo's data pipeline reflects issuer reports next-day); the F-CADENCE `bd_since_last_share_update > 3` staleness flag handles operator-visible signal. A real-time-flow Bloomberg replacement is paid; not in scope.
- **Carry-forward semantics on missing shares-outstanding days.** When yfinance returns no shares update for day D, A2 carries forward the prior value. The 1-day flow on that day = 0. This is correct under BFM 2018 construction. Operator should not interpret "0 flow" on a carry-forward day as "no creation/redemption activity"; the staleness flag is the load-bearing operator signal.
- **AUM column materialized at ingest (NOT computed at read).** The `etf_shares_outstanding.aum = shares × close` column is materialized at A1-ingest for read speed. A future shares-outstanding back-correction (Yahoo data revision) would NOT auto-update the materialized AUM unless the row is re-ingested. ReplacingMergeTree on (ticker, date) handles this — re-running A1 with --apply over a date range overwrites; A1 doesn't auto-replay history.
- **HYG/JNK/TLT/GLD overlap with the cross-asset composite.** The four style/risk ETFs in F-UNIVERSE carry information already partially surfaced by the cross-asset signed-z composite (s88). Phase B independence testing (Pearson correlation < 0.7) is the load-bearing check; if etf-flow correlates >0.7 with cross-asset on this overlap, the etf-flow composite gets demoted or HYG/JNK/TLT/GLD get dropped. Documented in SPEC §1 non-goal #4 + teach-doc failure mode #7.
- **Splits affect shares-outstanding interpretation.** ETF splits are rare (GLD 1:10 in 2008) but possible. Yahoo's `shares_full` is split-adjusted post-event; the F-1 sum-of-daily construction remains correct ONLY when both shares AND close are split-adjusted consistently. Forensic edge-case tests deferred to A2 (T-EF-Nplus).

### Carried (s89-s91 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 50 commits ahead of `origin/main`; push is operator-gated.
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

### Gap #9 etf-flow activation (NOT YET READY — pending A1 through A5)

```text
# After A1+A3 land:
.venv/Scripts/python.exe scripts/etf_flow_ingest.py --dry-run
.venv/Scripts/python.exe scripts/etf_flow_ingest.py --apply
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
# After A4 lands:
npm run daemon:daily       # step 1j fires; populates etf_flow_snapshots
# After A5 lands:
npm run brief:morning      # section #13 renders the ETF flow panel
```

### Tests + dev

```text
npm test                                                                       # TS — 2210 pass / 0 fail / 15 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 210 / 210
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #9 — A1 yfinance shares-outstanding ingest. First commit = `scripts/etf_flow_ingest.py` + `scripts/tests/test_etf_flow_ingest.py` + 2 npm script entries + help entries. Read the s91 EDGAR A1 (`scripts/sec_edgar_8k_item_5_02_ingest.py`) as the structural template; read `scripts/macro_regime_ingest.py` + `scripts/fetch_daily_yfinance.py` to confirm the established yfinance integration pattern.

After A1 commits, A2-A5 follow at the established cadence (one commit per phase).

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation (operator-pickable insertion).
- Push 50 commits to origin/main (operator-gated, HOLD).

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

s92 opened with gap #9 etf-flow-monitoring SPEC + teach-doc landed as commit `20da333`. One canon-thin fork (F-DATA-SOURCE) resolved autonomously: yfinance shares-outstanding panel is the v1 source; ETF.com scrape + issuer-CSV multi-source remain pre-authorized fallbacks deferred to v2.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #9 A1. Write `scripts/etf_flow_ingest.py` mirroring the s91 EDGAR A1 structural template. Test under `scripts/tests/test_etf_flow_ingest.py` per SPEC §9.4. Add 2 npm scripts + help entries. Commit as the second commit of the gap #9 arc.

**Parallel-tracks posture continues.** s92 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s92 open:**

```text
ALL S41-S91 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc     ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                           ✓ committed (6e9ffe0)
S92: gap #9 SPEC + teach-doc                   ✓ committed (20da333)
S92: HANDOFF rewrite                           ✓ this commit
  → next: gap #9 A1 (yfinance shares-outstanding ingest + pytest + npm/help)
  → after A1: A2 (pure composite + ~20 TS tests) → A3 (CH migration + tests) →
              A4 (repository + daemon step 1j + tests) →
              A5 (brief section #13 + tests)
  → after gap #9 ships: gap #7 event-driven-filings-processor (Form 4 lands here)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS activation,
                                  gap #9 v2 cross-validation
  → background: daemon writes per-cycle snapshots for the seven Layer-0 composites
                that have applied migrations
```
