# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 92 continued — **gap #9 A5 (brief section #13 + 20 tests) landed** as commit `61b61dd`. **Gap #9 etf-flow-monitoring arc ships END-TO-END** (SPEC `20da333` → A1 `ab724db` → A2 `e4592fe` → A3 `41ab834` → A4 `5ebee05` → A5 `61b61dd`). Full TS suite at 2364/2364 pass / 0 fail / 19 skipped (+20 new). 63 commits ahead of `origin/main`, push still held. **Slice queue: gap #7 event-driven-filings-processor (8-K classifier broader than gap #8 + Form 4) NEXT**, then deferred operator-pickable insertions.)

## What this turn delivered

Sixth and final slice of the gap #9 etf-flow-monitoring arc (s92 #1 was SPEC `20da333`, s92 #2 was A1 ingest `ab724db`, s92 #3 was A2 composite `e4592fe`, s92 #4 was A3 migration `41ab834`, s92 #5 was A4 repository + daemon hook `5ebee05`, this is s92 #6):

1. **A5 — brief section #13 + 20 tests** — commit `61b61dd`. ~221 LOC of renderer addition (BriefEtfFlowSection type + 3 constants + renderEtfFlowSection function) + ~77 LOC of composer addition (fetchLatestEtfFlow dep + Promise.all arm + buildEtfFlowSection + fetchLatestEtfFlowFromCH default) + ~308 LOC of new render tests (14 tests covering T-OBR-EF-1..6 + 8 supporting cases) + ~145 LOC of new composer tests (6 tests covering T-OB-EF-1..3 + 3 buildEtfFlowSection unit tests). All tests pass; full TS suite 2364/2364; check:help exit 0; tsc baseline unchanged.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| **Gap #9 etf-flow-monitoring arc** | **✓ DONE end-to-end (s92, 6 commits)** |
| **Gap #7 event-driven-filings-processor (8-K + Form 4)** | **☐ NEXT** |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 63 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 92 part 6 (this turn, this commit)

**S92-15. Brief section #13 v1 panel renders aggregate scalars + flagged list + universe coverage; the per-ETF table is intentionally NOT threaded through the section type.**
`Why:` The full per-ETF panel (21 rows × ~14 fields each) would consume disproportionate brief real-estate for what is operationally a "scan the flagged list" panel in v1. SPEC §8 shows broader content (broad-index 20bd flows table + sector z-score top-N table) but those are illustrative of v2 enhancement direction; the v1 panel test list (T-OBR-EF-1..6) only requires aggregate + flagged + truncation + coverage. Operators who want the full per-ETF view can query `etf_flow_snapshots.per_etf_json` directly (a single CH SELECT). A future v2 panel slice can add the broad-index + sector tables without changing the BriefEtfFlowSection type — the snapshot's full payload remains queryable in CH.
`How to apply:` A v2 panel slice should add `perEtfRows` to BriefEtfFlowSection (mirroring short-interest's perTickerRows), threaded from EtfFlowSnapshot through buildEtfFlowSection. Renderer changes add the table; existing 14 tests remain byte-equal (the new section appends content, doesn't modify existing strings).

**S92-16. ETF_FLOW_COLD_START_BD_SENTINEL = 9999 duplicated at the render layer (not imported from the repository).**
`Why:` Importing the constant from etf_flow_repository would pull a ClickHouse-heavy module into the pure renderer (operator_brief_render.ts is pure-functional + has no I/O imports). The duplication is a deliberate contract between the data layer and the render layer; the comment in operator_brief_render.ts explicitly flags the drift concern + names code review as the detection mechanism. Same pattern as SHORT_INTEREST_STALENESS_BD_THRESHOLD (defined locally at render layer; conceptual mirror of staleness thresholds in the upstream composite).
`How to apply:` A v2 bump that changes the sentinel (e.g., the rare case where 9999 starts colliding with a real bd value — won't happen, but if it did) must update both etf_flow_repository.ts + operator_brief_render.ts in the same commit. PR review checklist: search-and-replace for the constant name.

**S92-17. Cold-start sentinel rendered as "no current data" (not "9999 business days ago") AND skips the stale arrow.**
`Why:` Per S92-13 "How to apply" — operator-facing brief should not show "9999bd" raw. Rendering "no current data" is honest (the daemon literally has no row for that ticker in the read window), and skipping the stale arrow keeps the cold-start case visually distinct from the merely-stale case (where bd is finite but > 3). Test `'special-cases bdSinceLastShareUpdate cold-start sentinel (>=9999) as "no current data"'` pins this behavior + the assert.doesNotMatch /9999/ guard prevents the raw sentinel from leaking into the operator-facing output.
`How to apply:` A future ingest enhancement that distinguishes "no rows in window" from "all rows >9999bd stale" (which would require a longer read window than 500cd) should bump the sentinel value to avoid collision; the render-layer constant must follow.

**S92-18. Cold-start fallback path (both aggregates null) renders ONLY the single "Aggregate baseline cold-start (n < 30) — no z-scores available." line, omitting the YES/NO flag + dispersion + risk-on lines.**
`Why:` On cold-start the flag is structurally false (cold-start cascade per F-9), and the dispersion + risk-on are both null. Rendering "**Aggregate flow stress flag:** NO" + "**Sector flow dispersion:** —" + "**Aggregate risk-on flow:** —" would be three uninformative lines + would obscure the single-line cold-start message. The cold-start path collapses to one line. Pinned by T-OBR-EF-4 (`assert.doesNotMatch(md, /Aggregate flow stress flag:\*\*/)`).
`How to apply:` A v2 scheme that wanted to surface partial-aggregate states (e.g., sector dispersion present but broad risk-on null, or vice versa) would need to break out the "fully cold" vs "partially cold" cases. v1's `coldStart = sectorFlowDispersion === null && aggregateRiskOnFlow === null` collapses these into one branch.

### Session 92 parts 1-5 (carried)

**S92-1..S92-14** carried unchanged. Key load-bearings:

- F-DATA-SOURCE=yfinance + F-UNIVERSE=21 ETFs (s92#1 SPEC lock).
- A1 ingest: yfinance-direct close fetch + ticker_factory test seam + T-EFI-8 non-aborting partial-failure (s92#2).
- A2 composite: 21-element pre-assembled panels + population-stddev for cross-section / sample-stddev for time-series z + flagged_etfs deduplication (s92#3).
- A3 migration: BOTH tables co-bootstrapped idempotently + snapshot-table DDL deviations from raw SPEC §6 follow s89-s91 Layer-0 idiom byte-for-byte (s92#4).
- A4 repository: defensive carry-forward at the repository layer (S92-11) + `version`→`composite_version` write mapping (S92-12) + COLD_START_BD_SENTINEL=9999 (S92-13) + daemon double-gate on source + snapshot table existence (S92-14).

### Sessions 84-91 prior decisions (carried)

All prior decisions preserved unchanged. S91-7..S91-10 + S89/S90 + earlier carry through.

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
- Push 63 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable).
- Gap #9 v2 cross-validation enhancement — operator-pickable.

### Closed this turn

- ~~Gap #9 A5 brief section #13 + tests~~ — DONE (`61b61dd`).
- ~~A5 brief renderer "no data" handling for bd=9999~~ — RESOLVED per S92-17 (cold-start sentinel → "no current data" + no stale arrow).
- ~~Cold-start cascade rendering (single fallback line vs three null lines)~~ — RESOLVED per S92-18.
- ~~Per-ETF table threading vs aggregate+flagged only~~ — RESOLVED per S92-15 (v1 panel = aggregate + flagged + coverage; per-ETF table queryable from per_etf_json).

### Newly opened

- **v2 panel enhancement: broad-index 20bd flows table + sector z-score top-N table** (SPEC §8 illustrates; deferred-but-defined operator-pickable). When promoted, thread perEtfRows through BriefEtfFlowSection + add 2 new sub-sections to renderEtfFlowSection. v1 14 tests remain byte-equal.

## Next stage

### Default on "continue"

**Gap #7 — event-driven-filings-processor.** The 8-K classifier is broader than gap #8's narrow Item 5.02 cut; **Form 4 insider-trading filings also land here per gap #8 E-11**. Architectural pattern follows the established Phase 9 gap arc: SPEC → A1 (EDGAR full-text / RSS / submissions API ingest, extending the gap #8 EDGAR ingest infrastructure) → A2 (pure composite + classifier rules + tests) → A3 (CH snapshot table + raw filings cache) → A4 (repository + daemon hook step 1k) → A5 (brief section #14 appended last).

Concrete first move on "continue":

1. Read `docs/obsidian/gaps/event-driven-filings-processor.md` to anchor the gap doc spec + open questions + canon citations.
2. Read `scripts/sec_edgar_8k_item_5_02_ingest.py` (s91 gap #8 A1) for the EDGAR ingest infrastructure to extend (full-text endpoints, header set, rate-limit posture, schema-validation discipline).
3. Read the existing gap-doc cross-references in `docs/specs/executive-departure-signal.md` §3 (component diagram) for the SIC/CIK mapping pattern.
4. Draft `docs/specs/event-driven-filings-processor.md` SPEC + the gap-7-companion teach-doc.
5. Commit SPEC + teach-doc as the first slice of the gap #7 arc.

### After SPEC lands

Standard arc: A1 ingest → A2 composite → A3 migration → A4 repository + daemon → A5 brief section #14. Each commits as its own slice. Estimated ~6 working days at the established cadence (matches the gap #8 + gap #9 pre-Opus estimates of ~2 weeks each).

### After gap #7 ships

Operator-pickable deferred insertions (no auto-open):

- Gap #8 v2 enhancement — GICS sector activation (sector-aggregate panel slots).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF table threading per S92-15.
- ADR-041 implementation slot — `yield_curve_inverted` category in `phase1_v3`.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the seven Layer-0 composites (calendar-gated OR backfill arcs).

## Files / code state

### NEW or EDITED this turn (s92 part 6)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/operator_brief_render.ts` | EDITED (`61b61dd`) | +221 LOC. New BriefEtfFlowSection type + 3 constants (ETF_FLOW_FLAGGED_TOP_N=5, ETF_FLOW_STALENESS_BD_THRESHOLD=3, ETF_FLOW_COLD_START_BD_SENTINEL=9999) + renderEtfFlowSection. MorningBrief.etfFlow field added. renderBriefMarkdown appends section #13. |
| `src/server/operator_brief.ts` | EDITED (`61b61dd`) | +77 LOC. fetchLatestEtfFlow dep + Promise.all arm + buildEtfFlowSection + fetchLatestEtfFlowFromCH default. EtfFlowRepository + etfFlowSnapshotsTableExists imports. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`61b61dd`) | +308 LOC, 14 new tests. T-OBR-EF-1..6 (per SPEC §9.5) + supporting cases (NORMAL/NO branch, flagged table, sentinel special-case, no-data fallback, coverage line, footer). |
| `scripts/tests/operatorBrief.test.ts` | EDITED (`61b61dd`) | +145 LOC, 6 new tests. T-OB-EF-1..3 (per SPEC §9.6) + buildEtfFlowSection unit tests (null input, full mapping, null pass-through). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-A5 state. |

### From s92 parts 1-5 (carried; unchanged)

- `src/server/etf_flow_repository.ts` — A4 repository (~580 LOC) + tests (~765 LOC, 55 tests).
- `scripts/daily_signal_daemon.ts` — A4 daemon hook step 1j.
- `scripts/migrate_create_etf_flow_snapshots.ts` — A3 migration (~290 LOC) + tests (~310 LOC, 41 tests).
- `src/server/etf_flow.ts` — A2 pure composite (~430 LOC) + tests (57 tests).
- `scripts/etf_flow_ingest.py` — A1 ingest (~370 LOC) + tests (24 tests).
- `package.json` — `etf:flow:ingest` / `:dry` + `migrate:create-etf-flow-snapshots` / `:apply` npm scripts.
- `scripts/help.ts` — 4 EXTRA_HELP entries for etf-flow scripts.
- `docs/specs/etf-flow-monitoring.md` — SPEC (~480 LOC).
- `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` — teach-doc (~150 LOC).

### From s91 (carried; status unchanged)

All s91 files (`executive_departure*`, EDGAR ingest, brief section #12) preserved.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists; not yet applied.
- `quantlab.etf_shares_outstanding` — NOT yet created. A1 ingest creates it lazily; A3 migration ALSO creates it idempotently via co-bootstrap.
- `quantlab.etf_flow_snapshots` — NOT yet created. A3 migration script exists; not yet applied.

### Tests

```text
npm test                       2383 / 2364 pass / 0 fail / 19 skipped   ✓ (+20 new over the 2344 A4-end baseline)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   234 / 234 (unchanged from A2)
```

## Watch-outs

### NEW from this turn (s92 A5)

- **BriefEtfFlowSection intentionally omits `perEtfRows`.** Per S92-15 the v1 panel ships aggregate + flagged + coverage only; the full per-ETF table is queryable from the snapshot's `per_etf_json` column but NOT threaded through the brief section type. A v2 enhancement that adds per-ETF rendering must extend the type + buildEtfFlowSection mapping (additive — existing tests remain byte-equal since they don't query the new field).
- **ETF_FLOW_COLD_START_BD_SENTINEL = 9999 is deliberately duplicated** in operator_brief_render.ts (as a render-layer constant) AND etf_flow_repository.ts (as the data-layer constant). The renderer cannot import from the repository without pulling ClickHouse into a pure-functional module. Drift detection is code-review-only. A v2 sentinel bump (rare; unlikely needed) MUST update both files in one commit.
- **Cold-start fallback path renders ONE line** ("Aggregate baseline cold-start..."), omitting the YES/NO flag + dispersion + risk-on triple. Pinned by T-OBR-EF-4 `assert.doesNotMatch` guards. A refactor that wants to show partial-aggregate states (e.g., sector dispersion present + broad risk-on null) would break the binary cold-start branch.
- **`Aggregate flow stress flag: YES/NO` rendering omitted on cold-start** for the same reason — operator should see the cold-start message, not a flag of NO that's structurally always-false. A v2 enhancement that wants to distinguish "truly normal" from "cold-start normal" would need a second sub-state in the section type.
- **Staleness threshold > 3 (not ≥ 3).** Matches A2's `STALENESS_BD_THRESHOLD = 3` semantic; renders `⚠ stale (>3bd)` when bd is 4, 5, ... up to 9998. The sentinel 9999 is the cold-start branch (separate render path). T-OBR-EF-6 fixture uses bd=5 to cross the threshold; "omits staleness warning" test uses bd=2 to stay under.
- **Flagged-ETFs sort order is composite-determined (input order through evaluateEtfFlowComposite).** A2's iteration order over `perEtfRows` populates `flaggedEtfs` in the order ETFs appear in the EtfFlowInputs. The renderer slices the FIRST N — there's no re-sorting. If the operator wanted "top N by |z|" or "most-recent first" rendering, that's a render-layer addition. v1 ships the input-order semantic.
- **The `abs(z)>2` trigger label uses `abs(z)` not `|z|`** to avoid markdown-table pipe-character collisions. T-OBR-EF flagged table tests pin the literal label.
- **`### Flagged ETFs (divergence or |z| > 2.0)` heading uses literal `|z|`** — pipes in markdown headings are valid (not table cells); the test regex escapes them. Future refactor that converts the heading to a table caption would need to swap the label.

### Carried (s89-s92 part 5 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 63 commits ahead of `origin/main`; push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`. A1 sidesteps by fetching close directly from yfinance.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate in gap #8.
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1).
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- A5 byte-equal protection on sections #1-#12 PLUS now #13; future #14 (gap #7) MUST append at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite + threaded by A4 repository + rendered by A5 with ETF_FLOW_STALENESS_BD_THRESHOLD = 3.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side; shares-outstanding side is also split-adjusted post-event.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between A1 and A3 source-table creation (must stay byte-identical; PR review must catch drift).
- `composite_version` vs `version` mapping at the A4 write boundary (load-bearing translation).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters).
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#13 with real data once migrations applied
```

### Gap #9 etf-flow activation (FULLY READY end-to-end)

```text
# A1 ingest (READY):
npm run etf:flow:ingest:dry
npm run etf:flow:ingest

# A3 migration (READY — creates both etf_flow_snapshots AND co-bootstraps etf_shares_outstanding):
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# A4 daemon hook (READY — populates etf_flow_snapshots per daemon cycle):
npm run daemon:daily       # step 1j fires; populates etf_flow_snapshots

# A5 brief panel (READY this commit):
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
npm test                                                                       # TS — 2364 pass / 0 fail / 19 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 234 / 234
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 — event-driven-filings-processor. First commit = `docs/specs/event-driven-filings-processor.md` SPEC + the companion teach-doc. The 8-K classifier extends gap #8's narrow Item 5.02 cut to the broader 8-K item space (Items 1.01, 1.02, 2.01, 2.02, 2.03, 2.04, 2.05, 2.06, 3.01, 3.02, 3.03, 4.01, 4.02, 5.01, 5.02 already in gap #8, 5.03, 5.04, 5.07, 7.01, 8.01); Form 4 (insider transactions) lands here per gap #8 E-11. Architectural pattern: SPEC → A1 (extend EDGAR ingest from gap #8) → A2 (composite + classifier rules) → A3 (CH snapshot + raw-filings cache) → A4 (repository + daemon step 1k) → A5 (brief section #14 appended last). Estimated ~6 working days at established cadence.

After gap #7 ships, the natural queue is empty — operator-pickable insertions take over.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 63 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s92 closes with gap #9 etf-flow-monitoring shipped end-to-end (6 commits: SPEC `20da333` → A1 `ab724db` → A2 `e4592fe` → A3 `41ab834` → A4 `5ebee05` → A5 `61b61dd`). The morning brief now renders section #13 (ETF flows) with full graceful-degrade across the three states: not-yet-evaluated (no snapshot), cold-start (no baselines), and operational (full aggregate + flagged list). Once the operator runs `etf:flow:ingest` + applies the A3 migration, `npm run daemon:daily` populates `etf_flow_snapshots` per cycle and `npm run brief:morning` renders the panel.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #7 event-driven-filings-processor. Draft `docs/specs/event-driven-filings-processor.md` + the companion teach-doc as the first commit of the gap #7 arc. The architectural pattern is locked at this point — 6 prior gap arcs have shipped the same SPEC → A1 → A2 → A3 → A4 → A5 sequence.

**Parallel-tracks posture continues.** s92 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s92 part 6:**

```text
ALL S41-S91 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc     ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                           ✓ committed (6e9ffe0)
S92 #1: gap #9 SPEC + teach-doc                ✓ committed (20da333)
S92 #2: gap #9 A1 ingest + 24 tests            ✓ committed (ab724db)
S92 #3: gap #9 A2 composite + 57 tests         ✓ committed (e4592fe)
S92 #4: gap #9 A3 migration + 41 tests         ✓ committed (41ab834)
S92 #5: gap #9 A4 repository + daemon + 55 t   ✓ committed (5ebee05)
S92 #6: gap #9 A5 brief section #13 + 20 t     ✓ committed (61b61dd)
S92 HANDOFF rewrite (this commit)              ✓ this commit
  → next: gap #7 event-driven-filings-processor SPEC + teach-doc
  → gap #7 arc: SPEC → A1 → A2 → A3 → A4 → A5 (Form 4 lands here per gap #8 E-11)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS activation,
                                  gap #9 v2 cross-validation + per-ETF panel
  → background: daemon writes per-cycle snapshots for all 7 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow)
```
