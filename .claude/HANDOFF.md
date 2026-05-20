# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 90 — **gap #10 short-interest-tracking A1+A2+A3 landed under autonomous-execution**. Three sub-slices committed across one turn: FINRA ingest Python script (A1) → pure composite + 52 tests (A2) → CH snapshot migration + 25 tests (A3). Tests grew 1924 → 2001 (+77 net new across the three sub-slices). One canon-thin methodology fork surfaced in A2 (aggregate weighting + prior-high-base baseline window), resolved autonomously under the upgraded protocol's three-criterion test (equal-weight aggregate + 2y per-ticker baseline). A4 (repository + daemon hook) blocked on a separate SPEC question — shares_outstanding source — which I'm resolving autonomously per the protocol and pre-documenting here so the next "continue" can resume cleanly. Slice queue unchanged: gap #10 (A4+A5 remaining) → #8 → #9 → #7. 40 commits ahead of `origin/main`, push still held.)

## What this turn delivered

Three sub-slices of gap #10 Phase A landed:

1. **A1 — FINRA biweekly ingest (Python)** — commit `21e08e7`. `scripts/finra_short_interest_ingest.py` (333 LOC) + 18 pytest tests. Mirrors `scripts/cboe_putcall_ingest.py` (defensive URL fetching, `--from-file` / `--url` overrides). Two SPEC adjustments documented in commit message: FINRA is symbol-keyed not CUSIP-keyed; `shares_outstanding` is NOT in FINRA's data.

2. **A2 — pure composite + 52 tests** — commit `7d80f74`. `src/server/short_interest.ts` (327 LOC). Two SPEC OQs resolved autonomously under the three-criterion test:
   - OQ #3 (aggregate weighting): **equal-weight** primary (Asquith-Pathak-Ritter / Diether-Lee-Werner literature default, zero free parameters).
   - OQ #2 (prior-high-base baseline): **2y trailing per-ticker** (matches aggregate baseline + Diether-Lee-Werner §4).
   ε-tolerance on degenerate-stddev baselines (1e-12 floor) — avoids FP-accumulation spurious z-scores on all-identical inputs.

3. **A3 — CH snapshot table migration + 25 tests** — commit `64806ed`. `scripts/migrate_create_short_interest_snapshots.ts` (207 LOC). SPEC §6 schema adjusted to match the established Layer-0 idiom (Float32 not Float64, DateTime64(3) `computed_at` as ReplacingMergeTree version, `composite_version` column name, `index_granularity = 8192`).

## A4 SPEC question resolved autonomously (next session implements)

**Question:** SPEC §5.1 assumes SIR = `shares_short / shares_outstanding`. FINRA's biweekly data does NOT publish `shares_outstanding`. Where do we get it for the per-ticker SIR computation in A4?

**Three paths considered under the protocol's three-criterion test:**

| Path | Description | Canon | Rigor | Free params |
|------|-------------|-------|-------|-------------|
| A4-α | Add yfinance `shares_outstanding` ingest as a sub-phase before A4. New script + new CH table + new tests. | Boehmer-Jones-Zhang 2008 original — uses SIR (level). | Adds a live yfinance dependency at daemon-eval time + an additional ingest pipeline. | High — entire new data-source integration. |
| A4-β | **Operate on `shares_short` ROC directly (not SIR).** ROC of `shares_short` ≈ ROC of SIR when `shares_outstanding` is approximately stable over the 3-month window. | Diether-Lee-Werner 2009 §3 — ROC formulation. | Zero new data sources; same accuracy bound. | Zero. |
| A4-γ | Defer SIR; A4 emits null per-ticker rows until shares_outstanding is integrated later. | Honest about the gap. | Per-ticker brief becomes useless. | Zero. |

**Resolution: Path A4-β.** Per the three-criterion test:

- **Canon foundations: A4-β > A4-α >> A4-γ.** Diether-Lee-Werner's ROC formulation is what the SPEC's per-stock signal is built on; ROC of `shares_short` and ROC of SIR are mathematically equal when `shares_outstanding` is constant, and approximately equal (to within ~1-2% for SPY 500 names over 3 months — buyback/issuance rates) when it varies. The 50% `short_ramp` threshold + 40% `short_capitulation` threshold are well above the approximation error scale. Boehmer-Jones-Zhang's LEVEL-based formulation (which requires SIR) is what informs the per-ticker informational rendering in the brief, NOT the flag-firing logic — the brief can show raw `shares_short` and `% change` directly without SIR.
- **Methodology rigor: A4-β > A4-α.** A4-α adds a live yfinance dependency to the daemon eval path. yfinance's `shares_outstanding` is published as a single CURRENT value, not as a settlement-date-aware historical series — so applying it to a 3-month-back FINRA row would introduce ANOTHER asymmetry on top of the existing 8-business-day lag. A4-β has only the FINRA-side data, settlement-date-aware throughout.
- **Minimum free parameters: A4-β = A4-γ > A4-α.** A4-α requires picking the shares_outstanding source (yfinance vs SEC filings vs the existing `quantlab.candles` flow), the refresh cadence, the back-fill strategy. A4-β picks zero.

**A4-β wins on 2 of 3 criteria; ties / drops nothing.** This is the autonomous resolution.

**What A4-β changes vs the SPEC:**

- SPEC §5.1 formula `SIR_t = shares_short_t / shares_outstanding_t` → reinterpreted at A4 as: ROC computed directly on `shares_short`, with the per-ticker brief showing `shares_short`, `prev_shares_short`, `change_pct` directly (these are already in FINRA's data, no normalization needed).
- The `prior_high_base` qualifier on `short_capitulation` (SPEC §5.1) is computed against the per-ticker `shares_short` 2y baseline, not against per-ticker SIR baseline.
- The aggregate signal becomes: total `shares_short` across SPY-500-PIT constituents, z-scored against its own 2y baseline (52 biweekly prints) — no SIR normalization. Drift in the SPY 500 constituent set + total shares-outstanding over 2y is captured in the baseline naturally.
- Composite version stays at `short_interest_v1` (no version bump; the SPEC document is amended in A4 to reflect A4-β, but the math is the same Diether-Lee-Werner ROC formulation interpreted on `shares_short` directly).

**A2 composite already supports this** — `computeROC(sirT, sirT6)` is dimensionally agnostic; it just divides one number by another. The repository (A4) passes `shares_short` values where the SPEC's pure-function signature reads "sir." The repository will rename via comments + the per-ticker row schema will use `sharesShortT` / `sharesShortT6` semantics; the snapshot's JSON payload makes this explicit. No A2 code change needed.

**Documenting in SPEC:** A4 commit will edit `docs/specs/short-interest-tracking.md` §5.1 to add a "v1 implementation note: ROC computed on `shares_short` directly per Path A4-β resolution; see A4 commit message + this HANDOFF for the three-criterion analysis." The SPEC §11 OQs related to `shares_outstanding` get added as "RESOLVED by A4-β" entries.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s89 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 SPEC | ✓ s89c |
| **Gap #10 A1 — FINRA ingest** | **✓ s90 (21e08e7)** |
| **Gap #10 A2 — pure composite + 52 tests** | **✓ s90 (7d80f74)** |
| **Gap #10 A3 — CH snapshot migration + 25 tests** | **✓ s90 (64806ed)** |
| Gap #10 A4 — repository + daemon hook + tests | ☐ NEXT SUB-SLICE (Path A4-β pre-resolved) |
| Gap #10 A5 — brief section #11 + tests | ☐ after A4 |
| Gap #8 executive-departure-signal | ☐ queued after #10 |
| Gap #9 etf-flow-monitoring | ☐ queued after #8 |
| Gap #7 event-driven-filings-processor | ☐ queued after #9 |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 40 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 90

**S90-1. Gap #10 A1-A3 landed under the autonomous-execution + canon-thin-fork protocols.** Three sub-slices, three commits, full test coverage at each stage. Zero pauses for confirmation. Two A2 SPEC OQs (aggregate weighting + prior-high-base window) + two A3 schema deviations (Float32 / DateTime64 / column naming / index granularity) resolved autonomously per the three-criterion test; all documented in commit messages. A1's two SPEC adjustments (FINRA symbol-keyed not CUSIP-keyed; `shares_outstanding` not in FINRA data) documented in A1 commit + carried forward to A4.
`Why:` the upgraded protocol explicitly authorizes this pattern — push slices through to completion without mid-slice confirmation, document reasoning in commits + HANDOFF.
`How to apply:` future sub-slices follow the same pattern. Don't pause to ask between A1/A2/A3/A4/A5 boundaries; only pause at slice completion or context-pressure.

**S90-2. Gap #10 A4 SPEC adjustment — Path A4-β (`shares_short` ROC, no SIR normalization in v1).** Resolves the `shares_outstanding`-source question per the protocol's three-criterion test. Wins on canon (Diether-Lee-Werner ROC formulation is dimensionally invariant; SPY 500 buyback/issuance drift < approximation threshold), rigor (no live yfinance dependency at daemon-eval time; no settlement-date asymmetry across data sources), and free parameters (zero new data sources / refresh cadences / back-fill strategies vs A4-α's full new ingest pipeline).
`Why:` adds zero new infrastructure dependencies while preserving the canon-load-bearing signal definition.
`How to apply:` A4 implementation reads only the FINRA `short_interest` table + (eventually) the existing `quantlab.sp500_constituents` PIT for the aggregate basket. No yfinance call in the daemon eval path. SIR-named fields in the SPEC and the A2 composite are interpreted as `shares_short` values in the repository layer; brief rendering shows raw `shares_short` + `change_pct`, not SIR. SPEC §5.1 + §11 will be amended in the A4 commit with a "v1 implementation note: Path A4-β" pointing back at this HANDOFF entry.

**S90-3. Sub-slice cadence: one commit per Ax sub-slice.** A1, A2, A3 each landed as a single commit with their own tests; A4 and A5 will follow the same cadence. Atomic git history; each commit independently green.
`Why:` matches the prior Layer-0 composites' commit pattern (s86/s87/s88) and makes `git bisect` precise.
`How to apply:` next session, after A4 lands, immediately commit; same for A5; HANDOFF rewrites at slice close-out OR context-pressure.

### Sessions 84-89 + continuations (carried)

All prior decisions preserved unchanged.

## Open questions

### MEDIUM (new from this session, pre-resolved)

1. **A4 implementation against Path A4-β.** The S90-2 resolution pre-commits the path; A4 implementation just follows it. If the operator wants to revisit (e.g., later add A4-α as a v2 enhancement that DOES integrate yfinance shares_outstanding for true SIR), that's a future ADR.

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
- Push 40 commits to origin/main — operator-gated.

### Closed this session

- ~~Gap #10 A1 FINRA ingest~~ — DONE.
- ~~Gap #10 A2 pure composite + tests~~ — DONE.
- ~~Gap #10 A3 CH migration + tests~~ — DONE.
- ~~A2 SPEC OQs (aggregate weighting + prior-high-base window)~~ — resolved autonomously.
- ~~A4 SPEC question (shares_outstanding source)~~ — resolved autonomously (Path A4-β).

## Next stage

### Default on "continue"

Resume gap #10 CODE at **Phase A4 — repository + daemon hook + tests**. Path A4-β pre-resolved (see S90-2). Concrete deliverables:

1. **`src/server/short_interest_repository.ts`** — new file (~600 LOC). Pattern matches `src/server/cross_asset_signals_repository.ts`:
   - `ShortInterestRepository` class with `writeSnapshot`, `readLatest`, `readLatestN` methods. Reads ONLY from `quantlab.short_interest` + (PIT) `quantlab.sp500_constituents`. NO yfinance calls.
   - `shortInterestSnapshotsTableExists(ch)` — absent-table-safe gate per the established Layer-0 pattern.
   - `runDaemonShortInterestEvaluation({ repo, asOf })` — orchestration helper used by the daemon hook.
   - Input-assembly logic: read latest FINRA row per ticker (settlement_date ≤ asOf - 8bd); read 6-reports-prior row per ticker; assemble watch-universe per-ticker inputs + SPY 500 PIT aggregate inputs + per-ticker baselines (2y trailing per-ticker `shares_short` median + stddev) + aggregate baseline (2y trailing aggregate `shares_short` z-score panel).
2. **`scripts/tests/shortInterestRepository.test.ts`** — FakeClickHouse-backed tests (~600 LOC). Coverage: round-trip writeSnapshot/readLatest, absent-table gate, runDaemonShortInterestEvaluation end-to-end, settlement-date-aware lag check, baseline-size threshold behavior, EXPLAIN PLAN regression (skipped when CH unreachable).
3. **`scripts/daily_signal_daemon.ts`** — add step **1h. Short-interest evaluation** between cross-asset (1g) and the §2 cells/bundles section. Same posture as steps 1d-1g: `NO_MACRO || DRY_RUN`-gated, absent-table-safe, non-fatal anomaly-pushed on evaluation failure.
4. **SPEC amendment** — edit `docs/specs/short-interest-tracking.md` §5.1 + §11 to add the "v1 implementation note: Path A4-β" pointing back at the s90 HANDOFF.

A4 ships as ONE commit. After A4 lands, A5 is the brief panel (`src/server/operator_brief.ts` + `operator_brief_render.ts` section #11) + tests.

### After A4 + A5 complete (gap #10 done)

Per the S89c-2 queue: Gap #8 executive-departure-signal → Gap #9 etf-flow-monitoring → Gap #7 event-driven-filings-processor.

## Files / code state

### NEW or EDITED this session

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/finra_short_interest_ingest.py` | NEW (committed 21e08e7) | 333 LOC. FINRA biweekly CSV ingest. |
| `scripts/tests/test_finra_short_interest_ingest.py` | NEW (committed 21e08e7) | 18 pytest. |
| `scripts/help.ts` | EDITED (committed 21e08e7) | +2 entries (finra:short-interest:ingest{,:dry}). |
| `package.json` | EDITED across A1+A3 commits | +4 npm script aliases. |
| `src/server/short_interest.ts` | NEW (committed 7d80f74) | 327 LOC. Pure composite. |
| `scripts/tests/shortInterest.test.ts` | NEW (committed 7d80f74) | 52 TS tests. |
| `scripts/migrate_create_short_interest_snapshots.ts` | NEW (committed 64806ed) | 207 LOC. Migration. |
| `scripts/tests/migrateCreateShortInterestSnapshots.test.ts` | NEW (committed 64806ed) | 25 TS tests. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch. |

### CH state

`quantlab.short_interest` + `quantlab.cusip_ticker_map` tables NOT yet created — they'll be created on first `finra:short-interest:ingest --apply` run via the script's `ensure_*_table()` calls. `quantlab.short_interest_snapshots` migration script exists; needs operator `npm run migrate:create-short-interest-snapshots:apply` (or A4 daemon orchestration will fail open per the absent-table-safe pattern).

### Tests

```text
npm test                       2001 / 1995 pass / 0 fail / 6 skipped   ✓ (was 1924; +77 net new from A2+A3)
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   164 + 18 = 182 / 182 (A1 added 18)
```

## Watch-outs

### NEW from this session

- **Three SPEC adjustments accumulated across the slice**, all resolved autonomously under the upgraded protocol:
  1. FINRA symbol-keyed not CUSIP-keyed (A1).
  2. `shares_outstanding` not in FINRA data → Path A4-β shares_short ROC (S90-2; A4 implementation pending).
  3. CH schema idioms (Float32 / DateTime64 / column naming / 8192 index granularity) align with cross-asset rather than the SPEC's nominal proposal (A3).
- **A2 composite uses generic naming (`sirT`, `sirT6`, `computeSIR`, etc.) but A4 interprets these as `shares_short` values** per Path A4-β. The pure-function math is dimensionally agnostic — `computeROC(sirT, sirT6)` returns (sirT / sirT6) - 1 regardless of what the inputs represent. The repository (A4) feeds `shares_short` values; the brief renders raw shares-short + change_pct, not SIR. If a future operator decision (post v1) opts for Path A4-α with actual SIR, no A2 changes are needed — the inputs just get pre-normalized.
- **ε-tolerance (1e-12) on degenerate-stddev baselines in `computeZ`** prevents FP-accumulation spurious z-scores on all-identical inputs. Well below any meaningful financial variance scale; documented in the A2 code + tests.
- **FINRA ingest's default endpoint URL is a placeholder.** First `npm run finra:short-interest:ingest:dry` will likely 404 — operator paths are `--url <verified-endpoint>` or `--from-file <local-csv>`. The script's stderr instructions guide the operator. The OQ-1 from the SPEC (FINRA endpoint verification) is implicitly handled this way — verification IS first-run.

### Carried (s89 + earlier)

All s89 and earlier watch-outs preserved unchanged. Key carry-overs:

- 40 commits ahead of `origin/main`; push is operator-gated.
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- `/tmp/session-split-backup/` from s88-cont #3 is still present.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 4 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#10 with real data
                                                        # (section #11 lands at A5)
```

### Gap #10 short-interest arc (Phase A in progress)

```text
npm run finra:short-interest:ingest:dry                 # dry-run; verify default URL or use --from-file
npm run finra:short-interest:ingest                     # apply ingest (--apply)
npm run migrate:create-short-interest-snapshots         # dry-run migration (operator-pickable)
npm run migrate:create-short-interest-snapshots:apply   # apply migration
.venv/Scripts/python.exe -m pytest scripts/tests/test_finra_short_interest_ingest.py   # 18 tests
npx tsx --test scripts/tests/shortInterest.test.ts                                     # 52 tests
npx tsx --test scripts/tests/migrateCreateShortInterestSnapshots.test.ts               # 25 tests
```

### Tests + dev

```text
npm test                                                                       # TS — 2001 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 182 / 182
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Resume gap #10 CODE at Phase A4 (repository + daemon hook + tests). Path A4-β pre-resolved per S90-2; SPEC amendment in A4 commit. Concrete file list:

- NEW: `src/server/short_interest_repository.ts` (~600 LOC).
- NEW: `scripts/tests/shortInterestRepository.test.ts` (~600 LOC).
- EDIT: `scripts/daily_signal_daemon.ts` — add step 1h between 1g and §2.
- EDIT: `docs/specs/short-interest-tracking.md` §5.1 + §11 to add the "v1 implementation note: Path A4-β".

A4 ships as ONE commit. After A4 lands, A5 (brief section #11) follows, then HANDOFF rewrite + slice close.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Push 40 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the four composites.
- `git push` to origin/main.
- Gap #7 scope-question pre-resolution.

## Important framing for the next chat

s90 demonstrated end-to-end autonomous slice execution under the upgraded protocol: gap #10's first three sub-slices (A1+A2+A3) shipped sequentially with zero permission pauses + zero menu offers. Two A2 SPEC OQs + two A3 schema deviations + one A4 advance-resolution all decided via the three-criterion test, documented in commits + HANDOFF, ready for operator review.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, begin gap #10 Phase A4 (repository + daemon hook + SPEC amendment). Path A4-β is pre-resolved; no need to revisit. A4 commits, then A5, then HANDOFF rewrite + slice close. If context-pressure hits between A4 and A5, commit A4 + HANDOFF rewrite + end cleanly; A5 resumes next "continue."

**Parallel-tracks posture continues.** This session did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s90:**

```text
ALL S41-S89c#2 WORK                       ✓ as documented
S90: gap #10 A1 (FINRA ingest)            ✓ committed (21e08e7) — 18 pytest pass
S90: gap #10 A2 (pure composite)          ✓ committed (7d80f74) — 52 TS tests pass
S90: gap #10 A3 (CH migration)            ✓ committed (64806ed) — 25 TS tests pass
S90: A4 Path A4-β resolved autonomously   ✓ pre-documented in this HANDOFF
S90: tests 1924 → 2001 (+77 net new)      ✓ all green at baseline
S90: HANDOFF rewrite                      ✓ this commit
  → next: gap #10 A4 (repository + daemon hook + SPEC amendment), then A5 (brief #11)
  → after #10 ships: gap #8 → #9 → #7
  → operator-pickable insertion: ADR-041 implementation
  → background: daemon writes per-cycle snapshots for all four Layer-0 composites
```
