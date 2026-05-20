# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 89 — **cycle-position Phase B verdict landed + new working-pattern rules codified**. Phase B validation arc ran end-to-end on cycle-position: 4624 rows backfilled across 2008-01-02 → 2026-05-19, analyze report written, headline result is **Phase C promotion BLOCKED** (0/8 NBER recessions signaled at threshold 0.40 across 6/12/18m leads). The independence-vs-phase1_v3 test PASSED (Pearson ρ = -0.19). Three operator-decision paths surfaced in the report. Concurrent with the Phase B work: **autonomous-execution protocol + data-source policy locked into project CLAUDE.md** as always-on rules — HANDOFF auto-writes pre-authorized, per-slice commits pre-authorized, free APIs (yfinance/SEC EDGAR/FRED/FINRA/CBOE archives/ETF.com/Stooq/Wikipedia) + Playwright public scraping pre-authorized, paid + authenticated-scrape blocked. Three commits landed: 692d31a (Phase B verdict) + c3443ee (CLAUDE.md rules) + (this handoff). Tests + tsc + check:help unchanged at baseline.**

## What this session delivered

Operator redirected three things in one message: (1) immediate work to cycle-position Phase B backfill + analyze (both pre-authorized), (2) workflow pattern to autonomous-execution (not /loop), (3) data-source policy to free-only with broad pre-authorization for free APIs + Playwright public scraping. All three landed.

### The Phase B arc (operator-directed slice)

1. `npm run backfill:cycle-position-history:apply` — 4624 trade-days inserted into `quantlab.cycle_position_snapshots`. Phase distribution: late=461, mid=1686, early=2432, contraction=45, unknown=0. All rows are "partial inputs" (6/8) because DFII10 and BAMLH0A0HYM2 have shorter FRED history than the rest; this is expected and the composite falls back to BAA10Y-only credit when HY OAS is null.
2. `npm run analyze:cycle-position-validation:write` — wrote `docs/analysis/cycle-position-validation-2026-05.md`.

**Phase B result:**

| Gate | Result | Verdict |
| --- | --- | --- |
| B3a — NBER lead-time backtest | 0/8 recessions signaled at any of {6, 12, 18}m leads (threshold 0.40) | ✗ FAIL |
| B3b — False-positive rate | 0/506 depressed days followed by an NBER peak within 18m | ✗ FAIL (no precision) |
| B4 — Independence vs phase1_v3 | Pearson ρ = -0.189, Spearman ρ = -0.159 (\|ρ\| < 0.7 gate) | ✓ PASS |
| **B5 — Phase C promotion** | Fails the load-bearing backtest gate | **BLOCKED** |

**Mechanism (not a bug):** SPEC §7 chose equal-weight bucket averaging (yield-curve / credit / employment, each 1/3) as a heuristic approximation of PCA. The data shows the watch-out has materialized — at the GFC 12m-lead point (2006-12-01), T10Y3M was already flat-to-inverted but BAA10Y credit + employment indicators were still benign, so the bucket average landed at score 0.600 (`mid`), well above the 0.40 depression threshold. Same dynamic at COVID 6m-lead (2019-08-01, score 0.556). The composite captures the **state** of the business cycle (where we are now) without **leading** it.

### Three operator-decision paths (surfaced in the report, NOT autonomous)

A. **`cycle_v2` with non-linear bucket weighting** — replace the equal-weight bucket average with a min-or-product aggregator so a single depressed bucket can pull the score down even when the others stay healthy. Needs new SPEC + re-run B3. Most methodology-faithful path; preserves the composite shape; new threshold-tuning required.

B. **`cycle_v2` with yield-curve-only Phase C category** — promote the `T10Y3M < 0` signal (per Estrella-Mishkin 1998) directly to a `phase1_v3+` category, keep the bucket-averaged composite as Layer-5 LLM context only. Narrows Phase C scope; reuses canon-load-bearing input directly; preserves cycle_v1 as informational.

C. **Lower the SPEC §6 0.40 threshold to 0.55** and re-run validation. GFC 12m landed at 0.600 — 0.55 would have JUST missed it; COVID 6m at 0.556 would have hit. Re-tuning is a composite-version bump (`cycle_v2`); validation must be re-run honestly on the new threshold.

The Phase B verdict makes cycle_v1 **permanent at the "Layer-0 informational" posture** per SPEC §6 fallback — the dashboard panel + brief section #7 keep rendering, but no Phase C promotion happens at cycle_v1.

### The new working-pattern rules (codified in CLAUDE.md)

Two new always-on sections in [CLAUDE.md](CLAUDE.md), locked 2026-05-19 by operator directive:

**1. Autonomous-execution protocol** — pre-authorizes:

- HANDOFF.md rewrites (no confirmation, no trigger-gating for this project)
- Per-slice git commits
- End-of-session close-out (commit → HANDOFF → end cleanly)
- "Continue" semantic (resume from HANDOFF without re-asking)

And enumerates the hard-stop list (these reverse the autonomous default):

- Destructive ops not previously authorized
- Broken builds or failing tests not fixable from current context
- Canon-thin methodology ambiguity
- ADR conflicts
- Real-money-execution path touches
- Paid subscriptions / vendor onboarding
- Authenticated / logged-in scraping
- `git push`

**2. Data-source policy** — pre-authorizes:

- Direct free APIs: yfinance, SEC EDGAR (full-text + RSS/Atom + submissions), FRED, FINRA (Reg-SHO + short-interest), CBOE archives, ETF.com, Yahoo Finance, Stooq, Wikipedia + fja05680/sp500
- Playwright public-source scraping (any public, unauthenticated page) with required discipline: schema validation on every fetch, alerts on parse failure, fallback to cached last-good values, no silent stale propagation

And blocks (require explicit operator approval):

- Paid subscriptions (Sharadar, CBOE DataShop, ISM PMI, Polygon, S&P CapIQ, Bloomberg, Refinitiv, FactSet, PitchBook, Crunchbase, CB Insights)
- Authenticated / logged-in scraping (Fidelity, broker portals, anything behind login)

And adds the **gap-evaluation rule** — never halt on "needs data" without first researching free + scrape alternatives.

### Memory updates

Two new memory entries point at CLAUDE.md as the authoritative source: `feedback_signalforge_autonomous_execution.md` + `feedback_signalforge_data_source_policy.md`. MEMORY.md index updated.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s88 lock-ins | ✓ as documented |
| C-12 Phase A | ✓ s84 |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| market-cycle-position Phase A | ✓ s85 |
| market-cycle-position Phase B | ✓ s89 — **VERDICT: Phase C BLOCKED at cycle_v1** |
| market-cycle-position Phase C / cycle_v2 redesign | ☐ THREE PATHS SURFACED — operator picks A / B / C |
| expanded-vol-structure Phase A | ✓ s86 |
| sector-rotation-monitoring Phase A | ✓ s87 |
| cross-asset-signals Phase A | ✓ s88 |
| Daemon FRED-freshness patch | ✓ s88-cont #2 |
| 5-commit split of working tree | ✓ s88-cont #3 |
| **Autonomous-execution protocol** | **✓ s89 — CLAUDE.md** |
| **Data-source policy (free + scrape)** | **✓ s89 — CLAUDE.md** |
| Phase B for vol-structure / sector-rotation / cross-asset | ⏸ deferred — 60+ day observation OR historical-backfill arc |
| drawdown-response-framework | ✓ shipped s54 + rescaled s74/s77 |
| Multi-agent / autonomous-workflow setup | ✓ s89 — autonomous-execution chosen over /loop |
| 8 remaining frozen Phase 9+ gap inventory items | ⚠ RE-EVALUATE under new data-source policy (see below) |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned to draft within ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

## Decisions locked in

### Session 89

**S89-1. cycle_v1 stays at Layer-0 informational posture.** Phase B verdict is final at this version stamp. No threshold tuning, no bucket-weighting change, no Phase C promotion happens at `cycle_v1`. The dashboard panel + brief section #7 keep rendering against `cycle_v1` snapshots; the validation report `docs/analysis/cycle-position-validation-2026-05.md` is the authoritative record.
`Why:` SPEC §4 Phase B is a binary gate. The composite failed the backtest at the SPEC-pinned threshold (0.40) and lead horizons (6/12/18m). Re-tuning at this point — moving the threshold, changing the bucket weights — would be a `cycle_v2` redesign per SPEC §6 fallback, requiring a new SPEC, new B3 backtest, and a new validation pass. Operator decision required to launch that redesign.
`How to apply:` future sessions referencing cycle-position should read this as "informational only; do not promote." If the operator chooses cycle_v2, that opens a fresh RESEARCH→SPEC→CODE arc; do not auto-launch.

**S89-2. Autonomous-execution + data-source policy codified in CLAUDE.md.** The rules are in the project's auto-loaded CLAUDE.md file, not memory. Memory entries are breadcrumbs pointing back at CLAUDE.md.
`Why:` operator explicitly directed "add to persistent rules (.claude/CLAUDE.md), not session-level" — meaning the rules should travel with the repo and apply uniformly across sessions, surviving memory pruning or new-conversation context. The CLAUDE.md is auto-loaded at session start, so the rules fire on every chat in this repo without depending on memory recall.
`How to apply:` at session start, the rules are already in your context via the @CLAUDE.md import. Treat the "hard stops" list as the only reasons to halt the autonomous default; everything else proceeds without confirmation.

**S89-3. The /loop pattern is deprecated for this project.** s88-cont #3's /loop iteration halted on gap #7 over a fabricated "data-source decision" (SEC EDGAR was the answer all along, but the loop had no data-source policy to read against). Direct autonomous execution against pre-authorized scope is the replacement pattern.
`Why:` the failure mode of /loop was that the loop's stop-conditions were too conservative — every gap looked like a "data-source decision" because the loop didn't know what data sources were authorized. The new pattern fixes the failure mode at the source (CLAUDE.md data-source policy) and removes the indirection (loop wrapper) that produced the false stop.
`How to apply:` for multi-session work, the autonomous pattern is "operator says 'continue' → resume HANDOFF → push slice to completion → commit + HANDOFF + end cleanly." Do NOT invoke /loop. /schedule remains available for genuinely cron'd tasks (e.g., daily-ops trio if the operator chooses to set that up), but is not the default.

### Sessions 84-88 + continuations (carried)

All prior decisions preserved unchanged.

## Open questions

### HIGH (new this session)

1. **cycle_v2 redesign path** — A (non-linear bucket weighting) vs B (yield-curve-only Phase C category) vs C (threshold lowering to 0.55 + re-run). Operator picks; the report's "Paths forward" section enumerates the trade-offs.

2. **Phase 9+ gap re-evaluation under new data-source policy.** The /loop halted on gap #7 because of perceived data-source ambiguity — under the new free+scrape policy, that ambiguity is resolved. Re-evaluation:
   - **#7 event-driven-filings-processor** — *partially unblocks.* SEC EDGAR is pre-authorized; the data-source blocker is gone. Architecture decision (separate service vs daemon hook for <4h latency) is mine to make per [DESIGN] role. 4 open spec questions remain (international filings, 13G vs 13D weighting, 13F-HR amendments, Form 4 cluster threshold); most have canon defaults per Cohen-Malloy-Pomorski 2012, but international + 13F-HR are scope decisions.
   - **#10 short-interest-tracking** — *unblocks.* FINRA Reg-SHO + short-interest feeds are pre-authorized. Bi-monthly cadence is daemon-hook-compatible. Some methodology choices (per-stock vs aggregate, threshold definition) are RESEARCH-stage, not operator-gated.
   - **#8 executive-departure-signal** — *unblocks.* SEC EDGAR Form 4 captures CEO/CFO departures + supplements (e.g., 8-K Item 5.02). Public-source news scraping is an option for finer-grained signal. Implementable end-to-end without operator data-source decision.
   - **#9 etf-flow-monitoring** — *unblocks.* ETF.com is pre-authorized; public exchange archives + Yahoo finance ETF endpoints cover the rest. Previous PUSHBACK on "scrape debt" is now obsolete — the data-source policy explicitly authorizes Playwright public scraping with discipline.

3. **C-12 Phase B resume** (when ready): Alpaca account onboarding. INDEFINITELY PAUSED.

4. **CBOE DataShop subscription** — carried; still blocked under the new policy (paid).

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- **#5 capital-deployment-ramp ADR** — operator self-assigned to draft within ~1 week. Not blocking.

### Closed this session

- ~~cycle-position Phase B validation run~~ — DONE. Verdict: BLOCKED at cycle_v1.
- ~~Multi-agent workflow choice~~ — autonomous-execution chosen, codified in CLAUDE.md.
- ~~Data-source policy~~ — codified in CLAUDE.md.

## Next stage

### Operator picks one of these on next "continue"

1. **cycle_v2 path A / B / C** — operator picks; I launch RESEARCH→SPEC→CODE on the chosen path.
2. **Unfreeze gap #10 short-interest-tracking** — cleanest data-source profile under new policy, bi-monthly cadence fits daemon-hook pattern, methodology questions are RESEARCH-stage not operator-gated. **My recommendation if no other input.**
3. **Unfreeze gap #8 executive-departure-signal** — also clean under new policy.
4. **Unfreeze gap #9 etf-flow-monitoring** — newly unblocked under scrape policy; previous PUSHBACK obsolete.
5. **Unfreeze gap #7 event-driven-filings-processor** — partially unblocked (data source settled); operator still owes 4 scope decisions before SPEC. Lowest velocity option.
6. **Run Phase B historical-backfill arcs for vol-structure / sector-rotation / cross-asset** — analogous to what just landed for cycle-position. Higher likelihood of similar "informational-only at v1" verdicts given the same equal-weight composite shape, but valuable data either way.
7. **Drawdown framework §12 retune prep** — operator-deferred to 2026-08-29 calendar gate, but prep work (data assembly, baseline metrics) can happen now.
8. **Land #5 capital-deployment-ramp ADR draft** — operator said "drafting in ~1 week when rested"; if the operator wants me to take a first pass, that's available.
9. **Push to origin/main** — operator-gated (31 commits ahead now). Single command.

### If operator just says "continue" without picking

Per [PUSHBACK]: the cycle_v2 decision is canon-thin (three legitimate paths with different trade-offs, no canon default). I should NOT auto-pick that. The gap unfreezings are within autonomous scope under the new policy. Default next-slice if "continue" with no further input: **start gap #10 short-interest-tracking RESEARCH→SPEC→CODE arc** (highest velocity per the analysis above).

## Files / code state

### NEW or EDITED this session

| Path | Status | Notes |
| --- | --- | --- |
| `docs/analysis/cycle-position-validation-2026-05.md` | EDITED (committed 692d31a) | Rewritten by analyze:cycle-position-validation:write. Phase B verdict. |
| `CLAUDE.md` | EDITED (committed c3443ee) | +88 lines: autonomous-execution protocol + data-source policy. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch per autonomous-execution protocol. |
| memory: `feedback_signalforge_autonomous_execution.md` | NEW | Points back at CLAUDE.md as source of truth. |
| memory: `feedback_signalforge_data_source_policy.md` | NEW | Points back at CLAUDE.md as source of truth. |
| memory: `MEMORY.md` | EDITED | Two new index entries. |

### CH state

`quantlab.cycle_position_snapshots` now has 4624 historical rows in addition to the per-cycle daemon writes. ReplacingMergeTree dedupes on (snapshot_date) — re-running the backfill is safe. OPTIMIZE TABLE … FINAL ran cleanly post-insert.

### Tests

```text
npm test                       1924 / 1918 pass / 0 fail / 6 skipped   ✓ (s88-cont #2 baseline, unchanged)
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   164/164 (s88-cont #2 baseline; not re-run)
```

The Phase B work is pure data + a regenerated markdown report. No code changes; no test impact.

## Watch-outs

### NEW from this session

- **cycle_v1 will keep firing as `mid` during the early innings of the next real recession.** That's the headline failure mode of the v1 composite — the equal-weight bucket average masks single-bucket inversions. Until cycle_v2 lands, treat the `cycle_v1` brief section #7 as state-not-lead and do NOT use it for early-warning calls.
- **The validation report has a UTC-vs-local date stamp quirk.** The report's "Generated:" timestamp is `2026-05-20T01:20:27.391Z` even though local date is 2026-05-19. Not a bug; just a heads-up if anyone wonders why the doc looks like it ran tomorrow.
- **The backfill's "with full 8 inputs: 0" line is expected.** DFII10 starts 2003 + BAMLH0A0HYM2 has FRED-cap ~3y, so no row in the 2008-onwards window has all 8 inputs simultaneously available. All 4624 rows show 6/8 or 7/8 — the composite correctly falls back to BAA10Y-only credit when HY OAS is null.
- **CLAUDE.md is now ~140 lines instead of ~50.** The two new sections add weight to the always-on context. If the operator notices a token-budget impact, consider trimming the data-source policy section to a pointer + a shorter doc somewhere under `docs/`.

### Carried (s88-cont #3 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- The 5 commits from s88-cont #3 are NOT pushed; main is now 31 commits ahead of origin.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- DFII10/DFII5 history starts 2003-01-02; DTWEXBGS is weekly (lags 1-3 days).
- HY OAS (BAMLH0A0HYM2) FRED-capped to ~3y history on free endpoint.
- Section #10 appended last in the brief (byte-equal-protection).
- Repository reads use subquery-around-FINAL pattern on all 4 cross-asset read methods.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 4 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#10 with real data
```

### cycle-position arc (all NOW LANDED)

```text
npm run backfill:cycle-position-history[:apply]         # done s89 — 4624 rows in CH
npm run analyze:cycle-position-validation[:write]       # done s89 — verdict BLOCKED, report committed
npm run seed:nber-recessions[:apply]                    # available, idempotent
```

### Tests + dev

```text
npm test                                                                       # TS — 1924 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Default if operator just says "continue":** start gap #10 short-interest-tracking RESEARCH→SPEC→CODE per the new autonomous-execution + data-source policy. Halt only on the codified hard-stop list, not on data-source ambiguity.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (carried; blocked under new policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- cycle_v2 path A / B / C (new this session; load-bearing for cycle-position Phase C).
- Push 31 commits to origin/main (operator-gated).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset Phase B — 60+ day observation OR historical-backfill arc (operator can authorize the backfill arc anytime; matches what just ran for cycle-position).

**Background:**

- `npm run daemon:daily` writes all four Layer-0 composite snapshots per cycle AND self-refreshes FRED.

**DO NOT auto-open without operator green-light:**

- cycle_v2 redesign (any of paths A/B/C — canon-thin choice).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the three other composites (compute-heavy + operator-gated).
- `git push` to origin/main.

## Important framing for the next chat

s89 closed the cycle-position Phase B arc and codified the autonomous-execution + data-source rules that the operator wanted as standing project policy. Working tree is clean; three new commits land on top of the s88-cont #3 chain. The cycle-position composite is now permanently informational at cycle_v1 — the brief panel + dashboard keep rendering, but no Phase C promotion happens without a cycle_v2 redesign.

The deeper shift this session: **/loop is deprecated**. The replacement pattern is direct autonomous execution against pre-authorized scope, halting only on the codified hard-stop list. The data-source policy in CLAUDE.md prevents the failure mode that killed /loop's first iteration — gap-evaluation no longer halts on "needs data" without first checking the free + scrape catalogue.

**The chain through s89:**

```text
ALL S41-S88-CONT-#3 WORK                  ✓ as documented
S89: backfill:cycle-position-history:apply    ✓ 4624 rows in CH
S89: analyze:cycle-position-validation:write  ✓ verdict BLOCKED, report committed (692d31a)
S89: CLAUDE.md autonomous-execution rules     ✓ committed (c3443ee)
S89: CLAUDE.md data-source policy             ✓ committed (c3443ee, same commit)
S89: memory pointers                          ✓ feedback_signalforge_*.md + MEMORY.md
S89: HANDOFF rewrite                          ✓ this commit
S89: tests + tsc + check:help                 ✓ unchanged at baseline
  → next: operator picks cycle_v2 path OR "continue" → gap #10 short-interest by default
  → background: daemon writes per-cycle snapshots for all four composites
```

**Parallel-tracks posture continues.** s89 added the autonomous-execution backbone but did NOT change the C-12 / paper-trading / real-money-flip arc — those remain operator-gated independent of the new rules.
