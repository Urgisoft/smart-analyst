# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 92 continued — **gap #9 A1 (yfinance shares-outstanding ingest) landed** as commit `ab724db`. 24 new pytest tests; full Python suite at 234/234. 51 commits ahead of `origin/main`, push still held. **Slice queue: gap #9 A2 (pure composite + ~20 TS tests) NEXT**, then A3-A5, then gap #7 event-driven-filings-processor (Form 4 lands there per gap #8 E-11).)

## What this turn delivered

Second commit at the head of the gap #9 etf-flow-monitoring arc (s92 #1 was SPEC `20da333`, this is s92 #2):

1. **A1 — yfinance shares-outstanding ingest** — commit `ab724db`. `scripts/etf_flow_ingest.py` (~370 LOC) + `scripts/tests/test_etf_flow_ingest.py` (24 tests) + `package.json` (2 new npm scripts) + `scripts/help.ts` (2 new entries). Self-contained source-table bootstrap; ReplacingMergeTree on (ticker, date); materialized AUM at ingest.

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
| **Gap #9 A1 (yfinance shares-outstanding ingest)** | **✓ DONE (s92 commit `ab724db`)** |
| **Gap #9 A2 (pure composite + ~20 TS tests)** | **☐ NEXT** |
| Gap #9 A3-A5 | ☐ queued |
| Gap #7 event-driven-filings-processor | ☐ queued after gap #9 (Form 4 lands here per #8 E-11) |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 51 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 92 part 2 (this turn, this commit)

**S92-3. F-DATA-SOURCE refinement: close is also fetched directly from yfinance (NOT from `quantlab.daily_bars`).**
`Why:` The SPEC §4 row 2 listed `quantlab.daily_bars` as the join target for close, but verification confirmed that table does NOT exist in this repo — daily OHLCV lives in `quantlab.candles` (token-address-keyed, `{TICKER}_USD` form). Co-fetching close from yfinance in A1 makes the ingest self-contained: no upstream candle-backfill dependency, and yfinance is already the single source for shares-outstanding. Matches the s91 EDGAR A1 self-contained-source-table pattern (`ensure_etf_shares_outstanding_table` mirrors `ensure_executive_departures_table`).
`How to apply:` `scripts/etf_flow_ingest.py` calls both `Ticker.get_shares_full(start, end)` AND `Ticker.history(start, end)` per ticker. A2 composite reads from `quantlab.etf_shares_outstanding` (which carries both columns + materialized AUM); it does NOT join against `daily_bars` or `candles` at read time.

**S92-4. A1 ingest test-seam pattern: `ticker_factory` parameter (defaults to `yf.Ticker`).**
`Why:` yfinance's `Ticker` class is heavyweight + network-bound. Pure unit tests need an injection seam. A `ticker_factory` kwarg on each fetch function (default `None` → uses `yf.Ticker`) lets tests inject a `MagicMock` factory returning stubbed Tickers with pre-built shares/close fixtures. Mirrors the s91 EDGAR `sub_items_resolver` / `ticker_resolver` injection pattern for the row-builder.
`How to apply:` All 24 new tests pass under this pattern with zero network calls. Future composites with yfinance dependencies should adopt the same seam.

**S92-5. T-EFI-8 partial-failure non-aborting semantics: per-ticker exceptions are logged + counted; the loop continues; main() exits 0 unless EVERY ticker failed.**
`Why:` SPEC §9.4 T-EFI-8 spec: "Universe coverage check: all 21 ETFs in F-UNIVERSE attempted; report partial-failure count without aborting." A single yfinance hiccup on one ETF (rate limit, temporary delisting, intra-day quote unavailability) must not block the other 20.
`How to apply:` `ingest_universe` returns a summary dict with `succeeded`/`attempted`/`failed`/`rows_total`/`aum_sanity_warnings`. Exit code 1 fires only when `succeeded == 0` AND `attempted > 0`. Operator reads the failed-tickers log line for triage.

### Session 92 part 1 (carried — SPEC commit `20da333`)

**S92-1. Gap #9 F-DATA-SOURCE canon-thin fork: v1 source = yfinance shares-outstanding panel.** ETF.com Playwright scrape and issuer-CSV multi-source paths remain pre-authorized fallbacks per CLAUDE.md but are deferred to v2. [Three-criterion analysis documented in SPEC §2 row F-DATA-SOURCE.]

**S92-2. Gap #9 universe (F-UNIVERSE) = 21 ETFs.** (a) broad-index (6) SPY/IVV/VOO/QQQ/IWM/DIA; (b) SPDR sector (11) XLK/XLF/XLE/XLV/XLY/XLP/XLU/XLI/XLB/XLRE/XLC; (c) style/risk (4) HYG/JNK/TLT/GLD.

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
- Push 51 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable; see s91 OQ).
- Gap #9 v2 cross-validation enhancement (ETF.com scrape OR issuer-CSV multi-source) — operator-pickable.

### Closed this turn

- ~~Gap #9 A1 ingest~~ — DONE (`ab724db`).
- ~~F-DATA-SOURCE close-table choice~~ — RESOLVED per S92-3 (yfinance, not `daily_bars` which doesn't exist).

## Next stage

### Default on "continue"

**Gap #9 A2 — pure composite (`src/server/etf_flow.ts` + ~20 TS tests).** Per the SPEC §10 Phase A2 deliverable.

The pure composite implements SPEC §5.1 (per-ETF: 20bd cumulative flow shares/dollars/% of AUM + flow_z + divergence_flag) and §5.2 (aggregate: sector_flow_dispersion, aggregate_risk_on_flow, aggregate_flow_stress_flag). Cold-start handling per F-2 + F-9. Returns the `EtfFlowSnapshot` shape defined in SPEC §5.3.

Concrete first move on "continue":

1. Read the s91 sibling composite (`src/server/exec_departure.ts`) for the structural template (pure functions, no IO, no CH dependency).
2. Read `src/server/cross_asset.ts` (s88) for the z-score + signed-z pattern with cold-start floor.
3. Read `src/server/short_interest.ts` (s89-s90) for the flagged-rows + aggregate dispersion pattern.
4. Write `src/server/etf_flow.ts` per SPEC §5.1 + §5.2 + §5.3.
5. Write `scripts/tests/etfFlow.test.ts` covering SPEC §9.1 T-EF-1..T-EF-20.
6. Run `npm test` to confirm green.
7. Commit as A2 of the gap #9 arc.

### After A2 lands

- **A3** — `scripts/migrate_create_etf_flow_snapshots.ts` + migration tests (per SPEC §9.3). Note: A1 already creates the SOURCE table (`etf_shares_outstanding`); A3 creates the SNAPSHOT table (`etf_flow_snapshots`) only.
- **A4** — `src/server/etf_flow_repository.ts` + daemon step 1j + repository tests (per SPEC §9.2).
- **A5** — `src/server/operator_brief.ts` + `operator_brief_render.ts` section #13 + brief tests (per SPEC §9.5 + §9.6).

Estimated ~4-5 working days remaining at the established cadence (one commit per phase; phase boundary = natural model-turn boundary).

### After gap #9 ships

Per the locked queue:

- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; **Form 4 path arrives here per gap #8 E-11**).

Then deferred-but-on-queue work: gap #8 v2 GICS-sector activation, gap #9 v2 cross-validation, ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW or EDITED this turn (s92 part 2)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/etf_flow_ingest.py` | NEW (`ab724db`) | ~370 LOC. F-UNIVERSE constants (BROAD_INDEX_ETFS / SPDR_SECTOR_ETFS / STYLE_RISK_ETFS, total 21). `ETF_UNIVERSE` tuple. `ensure_etf_shares_outstanding_table` source-table bootstrap. `fetch_shares_outstanding` / `fetch_daily_close` / `fetch_total_assets` (all with `ticker_factory` test seam). `build_panel` forward-fill + AUM materialization. `sanity_check_aum` 5% threshold WARN. `write_panel` via `client.insert`. `ingest_universe` driver with partial-failure summary. CLI: `--dry-run` / `--apply` / `--start-date` / `--end-date` / `--tickers`. Default lookback 400 days. |
| `scripts/tests/test_etf_flow_ingest.py` | NEW (`ab724db`) | 24 tests covering T-EFI-1..T-EFI-8 (and supplemental boundary cases). All pass; full Python suite 234/234. |
| `package.json` | EDITED (`ab724db`) | +2 npm scripts: `etf:flow:ingest` + `etf:flow:ingest:dry`. |
| `scripts/help.ts` | EDITED (`ab724db`) | +2 EXTRA_HELP entries describing the ingest. `npm run check:help` green. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-A1 state. |

### From s92 part 1 (carried; unchanged)

- `docs/specs/etf-flow-monitoring.md` — SPEC, ~480 LOC.
- `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` — teach-doc, ~150 LOC.

### From s91 (carried; status unchanged)

All s91 files (`exec_departure*`, `executive_departure*`, EDGAR ingest, brief section #12) preserved. See prior HANDOFF s91 file delta.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); not yet applied.
- `quantlab.etf_shares_outstanding` — **NOT yet created.** A1 ingest creates it on first `--apply` run via `ensure_etf_shares_outstanding_table`. Source-table bootstrap, no separate migration.
- `quantlab.etf_flow_snapshots` — **NOT yet created.** A3 migration (pending) will create it.

### Tests

```text
npm test                       2210 / 2210 pass / 0 fail / 15 skipped   ✓ (unchanged from s91)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green (with the 2 new entries)
.venv/Scripts/python.exe -m pytest scripts/tests   234 / 234 (s91 210 + s92-A1 24)
```

## Watch-outs

### NEW from this turn (s92 A1)

- **yfinance API surface for `get_shares_full`.** yfinance ≥ 0.2.x exposes `Ticker.get_shares_full(start, end)`. The method may evolve. A1 uses the `ticker_factory` seam to mock in tests; in production the default `yf.Ticker` is wired directly. If yfinance changes the method name (e.g., `shares_full` → `shares_outstanding_history`), the failure surface is a single `RuntimeError` per ticker (caught + logged + counted in failed-tickers); the whole universe will fail loudly + simultaneously, easy to triage.
- **`Ticker.info` is heavyweight + rate-limited.** `fetch_total_assets` calls `info` once per ticker per ingest run. 21 calls per run × 1 daily run = 21 info-calls/day, well below Yahoo's polite-burst threshold. If operator runs A1 in a tight loop (e.g., back-to-back historical re-ingest), watch for 429 — yfinance back-off should handle but is opaque.
- **`quantlab.daily_bars` does NOT exist** despite being referenced in SPEC §4 row 2 + §6 docstrings. Daily OHLCV in this repo lives in `quantlab.candles` (token-address-keyed: SPY → SPY_USD). The A1 ingest sidesteps the issue by fetching close directly from yfinance + storing it on `etf_shares_outstanding` itself. A2 reads exclusively from `etf_shares_outstanding`; no cross-table join required.
- **Materialized AUM column is stale on shares-outstanding back-corrections.** If Yahoo revises a historical shares-outstanding value, A1 re-running with `--apply` over the affected date range overwrites the AUM column (ReplacingMergeTree merges; latest `ingested_at` wins). But A1 does NOT auto-replay history on its own — operator must invoke with the correct `--start-date` to cover the revised range.
- **`build_panel` drops pre-first-print rows.** Trading days BEFORE the first shares-outstanding print are dropped (no carry-forward target). Test `test_carry_forward_drops_pre_first_print_rows` enforces this. For ETFs launched <1y ago, the leading rows of the close history are silently absent from `etf_shares_outstanding`. Not a concern for the v1 21-ETF universe (oldest SPY 1993; youngest XLC 2018) but a watch-out for future v2 universe expansion.

### Carried (s89-s92 part 1 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 51 commits ahead of `origin/main`; push is operator-gated.
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
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite, NOT A1 ingest. A1 only persists the panel; A2 computes the staleness scalar at evaluation time.
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

### Gap #9 etf-flow activation (NOT YET READY — pending A2 through A5)

```text
# A1 ingest (READY now after this commit):
.venv/Scripts/python.exe scripts/etf_flow_ingest.py --dry-run
.venv/Scripts/python.exe scripts/etf_flow_ingest.py --apply
# or equivalently:
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
npm test                                                                       # TS — 2210 pass / 0 fail / 15 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 234 / 234
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #9 — A2 pure composite. First commit = `src/server/etf_flow.ts` + `scripts/tests/etfFlow.test.ts` (~20 tests per SPEC §9.1). Read s91 `exec_departure.ts` for the structural template; read `cross_asset.ts` for the z-score with cold-start floor; read `short_interest.ts` for the flagged-rows + aggregate dispersion pattern.

After A2 commits, A3 (CH migration for the snapshot table), A4 (repository + daemon step 1j), A5 (brief section #13) follow at the established cadence (one commit per phase).

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation (operator-pickable insertion).
- Push 51 commits to origin/main (operator-gated, HOLD).

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

s92 continues with gap #9 A1 landed as commit `ab724db`. The yfinance shares-outstanding panel + daily close are now ingestible into `quantlab.etf_shares_outstanding`; the source table is self-contained-bootstrap (no separate migration); A2 composite reads from it directly.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #9 A2. Write `src/server/etf_flow.ts` per SPEC §5.1/§5.2/§5.3. Test under `scripts/tests/etfFlow.test.ts` per SPEC §9.1 (~20 T-EF-N tests). Commit as the third commit of the gap #9 arc.

**Parallel-tracks posture continues.** s92 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s92 part 2:**

```text
ALL S41-S91 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc     ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                           ✓ committed (6e9ffe0)
S92 #1: gap #9 SPEC + teach-doc                ✓ committed (20da333)
S92 #2: gap #9 A1 ingest + 24 tests            ✓ committed (ab724db)
S92 HANDOFF rewrite (this commit)              ✓ this commit
  → next: gap #9 A2 (pure composite + ~20 TS tests per SPEC §9.1)
  → after A2: A3 (CH migration + tests) →
              A4 (repository + daemon step 1j + tests) →
              A5 (brief section #13 + tests)
  → after gap #9 ships: gap #7 event-driven-filings-processor (Form 4 lands here)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS activation,
                                  gap #9 v2 cross-validation
  → background: daemon writes per-cycle snapshots for the seven Layer-0 composites
                that have applied migrations
```
