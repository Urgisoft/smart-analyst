# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 89 continuation — **ADR-041 + gap #10 SPEC landed**. Operator picked Path B from the s89 Phase B verdict (cycle-position v2 = yield-curve-only category, Estrella-Mishkin 1998 canon foundation) and authorized the next slice queue: gap #10 short-interest-tracking → #8 executive-departure-signal → #9 etf-flow-monitoring → #7 filings-processor (will halt on #7's 4 scope questions). Push to origin/main remains operator-only — hold the 33 commits.)

## What this continuation delivered

Two slices landed end-to-end since the prior HANDOFF:

1. **ADR-041 (Proposed)** — cycle-position v2 = yield-curve-only Phase C category. Deprecates the `cycle_v1` composite for Phase C promotion; promotes `T10Y3M < 0` directly as a new `yield_curve_inverted` category in phase1_v3+, sourced from Estrella-Mishkin 1998 canon. Rejects Path A (in-sample bucket re-weighting) and Path C (in-sample threshold lowering) on selection-bias grounds (AFML §11, Bailey-LdP §11.5, Harvey-Liu-Zhu 2016). Four open questions deferred to Accept step (sustained-inversion requirement, buffer threshold, ADR-004 deflation-pipeline applicability, SPEC §4 Phase C explicit retirement). Commit `da45689`.

2. **Gap #10 SPEC** — `short_interest_v1` Phase A architecture. Mirrors the four prior Layer-0 informational SPECs (cycle-position s85, vol-structure s86, sector-rotation s87, cross-asset s88). Thirteen decisions locked at SPEC time (S-SI-1..S-SI-13): FINRA biweekly only (paid sources rejected; Reg SHO daily out-of-scope for v1), ROC-based per-stock signal (Diether-Lee-Werner 2009 canon, NOT level-based), SPY 500 PIT aggregate universe, settlement-date-aware lag (no 8-day forward-look leak), split-adjusted ROC, SEC EDGAR CUSIP→ticker resolution (pre-authorized per CLAUDE.md), brief section #11 (appended after cross-asset #10), 2y baseline + 30-print floor, `sentiment_short_extreme` at \|z\| > 2.0 symmetric. Six open questions DEFERRED to A1/A2 implementation (not blocking SPEC). Implementation phases A1-A5 enumerated with ~7 working days total effort. Commit `f7745c0`.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s88 lock-ins | ✓ as documented |
| C-12 Phase A | ✓ s84 |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| market-cycle-position Phase A | ✓ s85 |
| market-cycle-position Phase B | ✓ s89 — VERDICT: Phase C BLOCKED at cycle_v1 |
| **market-cycle-position v2 (ADR-041 Proposed)** | **✓ s89-cont — Proposed; Accept step opens implementation (4 OQs)** |
| expanded-vol-structure Phase A | ✓ s86 |
| sector-rotation-monitoring Phase A | ✓ s87 |
| cross-asset-signals Phase A | ✓ s88 |
| Daemon FRED-freshness patch | ✓ s88-cont #2 |
| 5-commit split of working tree | ✓ s88-cont #3 |
| Autonomous-execution + data-source policy | ✓ s89 — CLAUDE.md |
| **Gap #10 short-interest SPEC** | **✓ s89-cont — `docs/specs/short-interest-tracking.md`** |
| Gap #10 short-interest CODE (A1-A5) | ☐ NEXT SLICE |
| Gap #8 executive-departure-signal | ☐ queued after #10 |
| Gap #9 etf-flow-monitoring | ☐ queued after #8 |
| Gap #7 event-driven-filings-processor | ☐ queued after #9; will halt on 4 scope questions |
| Phase B for vol-structure / sector-rotation / cross-asset | ⏸ deferred — 60+ day observation OR historical-backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 33 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 89 continuation

**S89c-1. cycle_v2 = Path B (yield-curve-only category).** Operator-selected path. ADR-041 (Proposed) lives at [`docs/decisions/README.md`](docs/decisions/README.md) — the v2 deprecates the composite's Phase C path, promotes `T10Y3M < 0` (Estrella-Mishkin 1998 canon) as a new phase1_v3+ category named `yield_curve_inverted`. `cycle_v1` composite continues unchanged as Layer-5 LLM context only.
`Why:` Path A and Path C both required in-sample tuning against the same NBER data that the failed Phase B gate used (selection-bias canon AFML §11, Bailey-LdP §11.5, Harvey-Liu-Zhu 2016 protect against this). Path B uses a single canon-load-bearing input with no tuning, 25+ years of Tier-1 literature support, and already in the daemon pipeline (T10Y3M is in fred_ingest.py DEFAULT_SERIES + auto-refreshed by daemon step 1b').
`How to apply:` ADR-041 is Proposed, not Accepted. Implementation does NOT proceed without operator Accept step. The four open questions (sustained-inversion requirement, buffer threshold, ADR-004 deflation-pipeline applicability, SPEC §4 retirement language) are resolved at Accept, not as blocking SPEC-time decisions.

**S89c-2. Gap-inventory slice order pre-committed: #10 → #8 → #9 → #7.** After gap #10 ships its CODE phases A1-A5, default-resume is gap #8 executive-departure-signal. After #8, gap #9 etf-flow-monitoring. After #9, gap #7 event-driven-filings-processor — which will halt on its 4 scope questions (operator chose to defer surfacing those questions until #7 is the active slice rather than pre-blocking).
`Why:` operator-directed prioritization based on the post-data-source-policy unblock analysis. #10/#8/#9 have clean data-source profiles (FINRA + SEC EDGAR + ETF.com all pre-authorized); #7 has the messiest scope so it's last, but not zero — the 4 scope questions surface when #7 is active rather than being pre-blockers.
`How to apply:` when gap #10 finishes, do NOT pause to ask "which gap next" — proceed directly to gap #8 RESEARCH→SPEC→CODE. Same pattern through #9. On #7's scope questions, surface them via AskUserQuestion when reached; don't pre-research them.

**S89c-3. Gap #10 SPEC uses the established Layer-0 architectural template.** A1-A5 phase decomposition + brief section append-at-tail + ReplacingMergeTree snapshot pattern + version stamp. Same shape as s86/s87/s88. The SPEC is at [`docs/specs/short-interest-tracking.md`](docs/specs/short-interest-tracking.md).
`Why:` consistency reduces operator review burden, makes test/repo/daemon patterns reusable, keeps the brief stable.
`How to apply:` when the CODE slice begins next session, follow the SPEC's A1-A5 order. A1 is the Python FINRA ingest script (data plumbing); A2-A5 build on top of A1's data.

### Sessions 84-89 + continuations (carried)

All prior decisions preserved unchanged (s89 Phase B verdict, autonomous-execution + data-source policy in CLAUDE.md, etc.).

## Open questions

### HIGH (new this continuation)

1. **ADR-041 Accept step** — four open questions in the ADR body (sustained-inversion requirement, buffer threshold, ADR-004 deflation applicability, SPEC §4 retirement language). Operator-gated.

2. **Gap #10 CODE A1 — corporate-actions data source choice.** SPEC §11 OQ #1: CH `corporate_actions` table vs yfinance live `actions` endpoint. Recommendation in SPEC: yfinance for v1 (zero-infra). To resolve at A1 implementation start.

3. **Gap #10 CODE A2 — aggregate weighting scheme.** SPEC §11 OQ #3: market-cap-weighted vs equal-weight aggregate SIR over SPY 500 constituents. The academic literature is typically equal-weighted; cap-weighted matches the SPY index methodology. To resolve at A2.

### CARRIED HIGH (unchanged)

- C-12 Phase B resume (Alpaca onboarding) — INDEFINITELY PAUSED.
- CBOE DataShop subscription — carried; blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned to draft within ~1 week. Not blocking.
- cycle_v2 path A / B / C — closed (Path B chosen, ADR-041 Proposed).
- Push 33 commits to origin/main — operator-gated.

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked.
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).

### Closed this continuation

- ~~cycle_v2 path decision~~ — Path B chosen, ADR-041 Proposed.
- ~~Gap #10 SPEC~~ — landed at `docs/specs/short-interest-tracking.md`.

## Next stage

### Operator-directed sequence (S89c-2)

**Default next slice on "continue":** Gap #10 short-interest-tracking CODE — start at Phase A1 (FINRA biweekly ingest Python script at `scripts/finra_short_interest_ingest.py`). The SPEC pins the deliverable; the A1 sub-deliverables are:

1. CSV parser for FINRA biweekly short interest reports (against fixture).
2. CUSIP→ticker resolution via SEC EDGAR submissions API (pre-authorized), cached in new CH `cusip_ticker_map` table.
3. Split-adjustment via yfinance `actions` endpoint (SPEC §11 OQ #1 default recommendation; revisit if reliability becomes an issue).
4. Write to `quantlab.short_interest` table (ReplacingMergeTree, keyed on `(cusip, settlement_date)`).
5. CLI: `python scripts/finra_short_interest_ingest.py [--start YYYY-MM-DD] [--dry-run]`.
6. Tests at `scripts/tests/finra_short_interest_ingest_test.py` (pytest) — 5 tests per SPEC §9.4.

After A1 ships: A2 (pure composite) → A3 (CH snapshot table migration) → A4 (repository + daemon step 1h hook) → A5 (brief section #11). The slice ends when A5 commits with byte-equal-protection verified on the brief.

### After Gap #10 ships

Per S89c-2: Gap #8 executive-departure-signal → Gap #9 etf-flow-monitoring → Gap #7 event-driven-filings-processor.

## Files / code state

### NEW or EDITED this continuation

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | EDITED (committed da45689) | +100 lines: ADR-041 (Proposed) + index updates. |
| `docs/specs/short-interest-tracking.md` | NEW (committed f7745c0) | 355 lines: gap #10 Phase A SPEC. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch per autonomous-execution protocol. |

### CH state

Unchanged from s89 close. Phase B backfill rows (4624 in `cycle_position_snapshots`) still present + idempotent. No new migrations this continuation.

### Tests

```text
npm test                       1924 / 1918 pass / 0 fail / 6 skipped   ✓ (unchanged baseline)
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   164/164 (unchanged baseline; not re-run)
```

The two commits this continuation are pure documentation (ADR + SPEC); no code changes; no test impact.

## Watch-outs

### NEW from this continuation

- **ADR-041 is Proposed, not Accepted.** Do NOT start implementation of the `yield_curve_inverted` category without an explicit operator Accept step. The four open questions in the ADR body resolve at Accept, not as inferred defaults.
- **Gap #10 SPEC has six DEFERRED open questions.** Most are resolvable at A1/A2 implementation start with the SPEC's recommended defaults. The operator's involvement is needed only if A1/A2 hits a path where the recommendation breaks (e.g., yfinance reliability for splits forces the CH-table fallback).
- **The slice queue (S89c-2) commits the operator to NOT pre-blocking on gap #7's 4 scope questions.** When gap #7 becomes active (after #9 ships), surface those questions then. Don't try to pre-resolve them while working on #10/#8/#9.
- **HANDOFF.md is now load-bearing for slice-queue resumption.** Per autonomous-execution rule "Continue means continue", the next session reads the "Next stage" section and starts A1. Do NOT re-summarize the HANDOFF back to the operator; just begin work.

### Carried (s89 + earlier)

All s89 and earlier watch-outs preserved unchanged. Key carry-overs:

- 33 commits ahead of `origin/main`; push is operator-gated.
- `cycle_v1` composite continues rendering as Layer-5 LLM context only — do NOT use for early-warning calls.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- DFII10/DFII5 history starts 2003-01-02; DTWEXBGS is weekly (lags 1-3 days).
- HY OAS (BAMLH0A0HYM2) FRED-capped to ~3y on free endpoint.
- Section #11 (this SPEC's new brief section) will append AFTER #10 (cross-asset) on Phase A5. Sections #1-#10 are byte-equal-protected.
- Repository reads use subquery-around-FINAL pattern.
- `/tmp/session-split-backup/` from s88-cont #3 is still present; can be deleted at operator discretion.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 4 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#10 with real data
```

### cycle-position arc (Phase B closed)

```text
npm run backfill:cycle-position-history[:apply]         # idempotent re-run; landed s89
npm run analyze:cycle-position-validation[:write]       # re-runnable; verdict at docs/analysis/
```

### Tests + dev

```text
npm test                                                                       # TS — 1924 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Resume gap #10 CODE at Phase A1 (FINRA ingest Python script). The SPEC at [`docs/specs/short-interest-tracking.md`](docs/specs/short-interest-tracking.md) §10 pins the deliverable and effort estimate. Six DEFERRED open questions (SPEC §11) resolve at A1/A2 with the SPEC's recommended defaults; operator only needs to be involved if a recommendation breaks empirically.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 Accept step (4 OQs; operator-gated).
- Push 33 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset Phase B — 60+ day observation OR historical-backfill arc.

**Background:**

- `npm run daemon:daily` writes all four Layer-0 composite snapshots per cycle AND self-refreshes FRED.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Proposed → Accepted gate).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the three other composites.
- `git push` to origin/main.
- Gap #7 scope-question pre-resolution.

## Important framing for the next chat

The s89 continuation closed two clean slices (ADR-041 Proposed + gap #10 SPEC) under the new autonomous-execution protocol — no permission pauses, no menu offers, no mid-slice confirmation requests. The pattern is working as designed. Five commits landed on top of the s89 chain.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, begin work on gap #10 Phase A1 (FINRA ingest Python script per [`docs/specs/short-interest-tracking.md`](docs/specs/short-interest-tracking.md) §10 + §9.4 test plan). Do NOT pause to ask "should I start with A1 or A2?" — A1 is pinned by the SPEC. Do NOT pause to ask "yfinance or CH table for splits?" — yfinance is the SPEC §11 OQ #1 recommendation. Slice ends naturally at context pressure or A5 completion; commit + rewrite HANDOFF + end cleanly.

**The slice queue is committed (S89c-2):** #10 → #8 → #9 → #7. When #10 finishes, the next session reads this HANDOFF (which will have been rewritten to reflect #10's completion) and proceeds to #8 without re-asking.

**Parallel-tracks posture continues.** This continuation did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s89 continuation:**

```text
ALL S41-S89-PRIOR WORK                        ✓ as documented
S89c: ADR-041 Proposed (cycle_v2 = Path B)    ✓ committed (da45689)
S89c: gap #10 SPEC (short_interest_v1)        ✓ committed (f7745c0)
S89c: HANDOFF rewrite                         ✓ this commit
S89c: tests + tsc + check:help                ✓ unchanged at baseline
  → next: gap #10 Phase A1 (FINRA ingest Python script)
  → after #10 ships: gap #8 → #9 → #7
  → background: daemon writes per-cycle snapshots for all four Layer-0 composites
```
