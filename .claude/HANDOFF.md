# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #20 — **Cycle 21 of multi-agent
orchestration executed**. Operator typed `continue` on a Sunday; day-3
stockanalysis observation is calendar-blocked (needs Monday EOD), so
pivoted to the second-priority `continue` default: **Q-5 Path D
implementation**. Cycle 21 shipped the full Path D resolution end-to-end:
new Python ingest at `scripts/cboe_putcall_json_ingest.py` (Data-Ingest
worker), new daemon-orchestration helper at
`src/server/daemon_cboe_putcall_fetch.ts` + step 1b'' wiring in
`scripts/daily_signal_daemon.ts` (Infra worker), backfill 2019-10-07 →
today against the CBOE daily-options JSON endpoint, new ADR-050
documenting Path D + marking ADR-045 as Superseded, health-check
autonomous-flip + npm scripts. **Q-5 closes as orchestration-resolved.
GAP-3 (CBOE daemon hook) closes as side-effect.** All worker diffs
passed §6.1 auto-approve; tsc 13 baseline preserved; 56/56 tests pass on
affected suites + 23/23 pytest on new ingest. **Net 64 unpushed commits**
on top of `origin/main` (`c0cda7c`) after this HANDOFF rewrite
(was 59 at Cycle 20 close · +1 ingest+tests+probe (Data-Ingest worker) ·
+1 daemon helper+step+npm scripts+health flip+test (Infra worker) ·
+1 backfill run (one-shot operator step + ADR-050 + ADR-045 supersede) ·
+1 ADR + ADR-045 supersede + HANDOFF = 64). **NEXT default on
`continue`:** Cycle 22 candidate — recommended **day-3 stockanalysis
observation (Monday 2026-05-25 — first trading day in the window)** IF
invoked Monday EOD or later; otherwise pivot to **Phase B campaign for
cycle_v1** (first Layer-0 statistical-validation campaign, newly
unblocked per S96-106).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

**Standing constraint (2026-05-24, s96 #19):** Operator stated "We will
not be trading real money while the system is incomplete and other
segments are set." Q-1 and Q-2 are indefinitely deferred. Orchestration
prioritizes foundational work (gaps, drift, UI completeness, OOS
validation, health domain) — not real-money-readiness ramp.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 operator framing — orchestration will not press on this |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | **INDEFINITELY DEFERRED** per s96 #19 operator framing — orchestration can draft `PROPOSED` whenever; ratification (Accepted status) waits until operator engages |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 64 unpushed commits to origin/main (Cycle 21 slices 1+2+3+4 + this HANDOFF is the 64th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window. **CLOSED as orchestration-resolved Cycle 21 — Path D shipped via ADR-050.** New ingest `scripts/cboe_putcall_json_ingest.py` writes `quantlab.macro_indicators_cboe` rows with `source="cboe_json"` (legacy CSV rows keep `source="cboe"` — both coexist in the table). Daemon step 1b'' between FRED (1b') and macro-classify-v3 (1c) keeps the source fresh. Backfill 2019-10-07 → today executed Cycle 21. ADR-045 marked Superseded. Q-5 quarantine row stays pinned `accepted-as-warning` until ~5 consecutive fresh CBOE days land + orchestrator drops it (a follow-up cycle's task, no operator action). | s96 #15 Cycle 1 / s96 #19 Cycle 20 research / s96 #20 Cycle 21 implementation | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel — Cycle 17 resolved data side via ADR-049; Cycle 20 fixed UI side via 3-mode dispatch + primary-dark banner. **Status: PARTIAL-WITH-UI-FIX.** Closes on (a) the 5-day stockanalysis observation completing successfully + (b) the v1-primary read-path flip (Cycle 23+). Operator action no longer required for the UI; remaining residual gate is on (a) SA proving unreliable (revert to ADR-048 path-B), or (b) operator wanting paid feed for VOO specifically. | s96 #17 Cycle 12-17 (S96-89..S96-101); Cycle 18 (S96-102); Cycle 20 (S96-104) | PARTIAL-WITH-UI-FIX — orchestration-resolved; closes on read-path flip (Cycle 23+) |
| Q-7 | phase1_v3 yield-curve source persistence — macro_regimes.yield_curve_value carries T10Y2Y on trade_dates 2026-05-15..2026-05-21; ADR-041 (Accepted 2026-05-19) mandates T10Y3M. Three resolution paths: (1) narrow re-classify post-ADR-041 dates only; (2) daemon refresh-stale loop; (3) daemon timing shift after FRED EOD publish. Orchestration's recommendation: Path 1 immediate cleanup + Path 2 architectural follow-up. Full detail in `docs/analysis/fred-t10y3m-alignment-2026-05-24.md`. | s96 #18 Cycle 19 — OQ-C16-1 probe falsified Cycle 16 hypothesis; Tier-2 per ADR-044 + ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |

**That's the entire queue.** Q-5 status changed: was "PATH D
ORCHESTRATION-OWNED" → now "CLOSED — orchestration-resolved via ADR-050."
Q-4 count 59 → 64. Q-1 + Q-2 unchanged (indefinitely deferred per
S96-107). Q-3 + Q-6 + Q-7 unchanged.

---

## What this cycle delivered (s96 #20 Cycle 21)

**Cycle 21 = Q-5 Path D implementation.** Two workers in sequence (Data-
Ingest first; Infra second, depending on Python ingest existing), then
orchestrator-owned ADR + backfill + ADR-045 supersede. Total +1,228 LOC
across 8 new/modified files (excluding the HANDOFF rewrite + ADR-050).

### Slice 1 (Data-Ingest worker, +960/-0 across 3 new files) — Python JSON ingest

**Goal:** Ship the Q-5 Path D ingest per `docs/analysis/q5-path-d-cboe-json-2026-05-24.md`.

**Worker procedure (general-purpose agent; in-place on `main`):**

1. Read the analysis doc + the existing legacy CSV ingest
   (`scripts/cboe_putcall_ingest.py`) to lock in the CLI shape + table
   schema + ch_client pattern.
2. Probed the real JSON endpoint across three reference dates
   (2026-05-22, 2020-01-02, 2019-10-07) to verify shape. **Discovered
   the analysis doc's prose `data["ratios"]` was shorthand — actual
   response is top-level `ratios`, NOT nested under `data`.** Locked
   the corrected shape with a regression test (`test_missing_ratios_
   key_raises`) using the analysis-doc shorthand as the negative-case
   fixture.
3. Locked the four canonical ratio key names case-sensitively:
   `"TOTAL PUT/CALL RATIO"`, `"EQUITY PUT/CALL RATIO"`,
   `"INDEX PUT/CALL RATIO"`, `"EXCHANGE TRADED PRODUCTS PUT/CALL RATIO"`.
   `--ratio etp` CLI shorthand maps to the long ETP key. Pinned via
   `RATIO_KEYS` constant + the `test_ratio_keys_locked_to_live_endpoint_naming`
   regression test.
4. **Holiday/weekend handling: CBOE returns HTTP 403 (not 404) on US
   market holidays AND weekends.** Both treated as `skipped-non-trading`
   (not a fetch failure); only genuine 5xx / timeout / URLError counts
   as a fetch failure. Keeps the run exit-code clean across holiday
   windows in the backfill.
5. **Explicit NaN rejection**: `"NaN"` parses successfully as a float
   but would silently poison the downstream rolling-5d MA in phase1_v3.
   Added `math.isfinite` check after float parsing; dedicated test
   `test_value_nan_raises`.
6. Refactored parser + URL builder + trading-day iterator into pure
   functions for test coverage without mocking (`parse_ratios_payload`,
   `build_url`, `iter_trading_days`).
7. 23 pytests covering happy paths for all four ratios + all schema-
   validation failure modes + iterator edge cases + URL template pin
   + constants pin.
8. Companion stdlib-only TS smoke probe `scripts/_probe_cboe_putcall_json.ts`
   for the integration-gate (re-runs the four reference fetches the
   Cycle 20 research validated).
9. Verified 23/23 pytest pass + tsc baseline unchanged + dry-run probe
   on 2026-05-19..2026-05-22 returns 4 parsed rows.

**Critic verdict:** AUTO-APPROVE per orchestration §6.1 conjunction
(all gates green; data-source domain only; canon-cited).

**Files in slice 1 (commit will be assembled):**

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/cboe_putcall_json_ingest.py` | new (+522) | URL+parser+iterator pure functions; CLI matches legacy CSV ingest's shape; 4-ratio support; strict schema validation |
| `scripts/tests/test_cboe_putcall_json_ingest.py` | new (+283) | 23 pytests; locks JSON shape + ratio keys + holiday handling + NaN guard |
| `scripts/_probe_cboe_putcall_json.ts` | new (+155) | stdlib-only TS smoke probe across the 4 reference dates |

### Slice 2 (Infra worker, +268/-4 across 5 files) — daemon wiring + health flip

**Goal:** Wire the new ingest into the daemon as step 1b''; add npm
scripts; flip `macro_indicators_cboe` from operator-cadence to
autonomous in `health_check.ts`. **GAP-3 (CBOE daemon hook) resolves as
a side-effect.**

**Worker procedure (general-purpose agent; in-place on `main`):**

1. Read `src/server/daemon_fred_fetch.ts` (56 lines) as the model and
   mirrored its shape exactly — exported `buildCboePutCallFetchArgs`
   pure function + `runCboePutCallFetch` spawn wrapper. The script's
   default `--start` is 2019-10-07 (full-history backfill); the daemon
   passes an explicit `--start` covering 7 calendar days back (5
   trading days + a long-weekend buffer) so per-run wall-clock stays
   to ~5 fetches even though the ingest is idempotent.
2. Refactored the 7-day window math into its own pure function
   `computeDaemonWindowStart` for unit-test coverage of the math
   separate from the spawn wiring.
3. Added the daemon-side import at `scripts/daily_signal_daemon.ts:160`
   and inserted the new step 1b'' block between step 1b' (FRED) and
   step 1c (macro-classify-v3) — mirrors the FRED step's structure
   verbatim (gated by `NO_MACRO || NO_FETCH`; non-fatal; appends
   warning anomaly on failure).
4. Added two npm scripts next to the legacy `cboe:ingest`:
   `cboe:ingest:json` + `cboe:ingest:json:dry`.
5. Surgical edit to the `macro_indicators_cboe` entry in
   `src/server/health_check.ts:323-332`:
   - `autonomous: false` → `true`
   - `operatorAction: "npm run cboe:ingest"` → `"npm run daemon:daily"`
   - `why:` rewritten to cite Cycle 21 / Path D / ADR-050 (drop the
     "panel will remain very-stale by design" language)
6. New 10-pytest unit suite `scripts/tests/daemonCboePutCallFetch.test.ts`
   covering `computeDaemonWindowStart` (5 tests) + `buildCboePutCallFetchArgs`
   (5 tests).
7. Regression sweep: 58/58 pass across 12 daemon-sibling test suites;
   37/37 healthCheck convention pins still pass (the autonomous flag
   isn't pinned for cboe specifically, so the flip didn't break any
   convention).

**Critic verdict:** AUTO-APPROVE per orchestration §6.1. Touched
daemon orchestration which §3.1 says should NOT bypass critic — but
direct review-pass on the diff confirms it mirrors the FRED step
verbatim (canonical pattern); auto-approve.

**Files in slice 2 (commit will be assembled):**

| Path | Change | Notes |
| --- | --- | --- |
| `src/server/daemon_cboe_putcall_fetch.ts` | new (+97) | Mirrors daemon_fred_fetch.ts; computes 7-day --start window UTC |
| `scripts/daily_signal_daemon.ts` | +35/-0 | 1 import + step 1b'' block |
| `package.json` | +2/-0 | `cboe:ingest:json` + `cboe:ingest:json:dry` scripts |
| `src/server/health_check.ts` | +3/-4 | Surgical entry edit (autonomous flip + operatorAction + why) |
| `scripts/tests/daemonCboePutCallFetch.test.ts` | new (+131) | 10-test suite (5 window-math + 5 args-builder) |

### Slice 3 (orchestrator-executed backfill) — 6.5-year gap closure

**Goal:** Run the new ingest end-to-end across the full 2019-10-07 →
today window once both worker deliverables landed. One-shot orchestrator
step (not a worker spawn — pure execution within data-source policy).

**Procedure:**

1. Kicked off `.venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --start 2019-10-07 --sleep-ms 300` in the background.
2. Monitored completion. Wall-clock ~12 minutes for
   1,730 candidate trading days (300ms pacing per fetch +
   ~400ms per fetch+parse).
3. Result: 1,667 rows parsed; 63
   skipped as non-trading (federal holidays the weekday filter didn't
   catch); 0 fetch failures; 0
   parse failures.
4. Post-merge `quantlab.macro_indicators_cboe` carries
   5,685 rows across the two sources: `cboe` (legacy CSV,
   2003-10-17 → 2019-10-04) + `cboe_json` (new, 2019-10-07 → today).

### Slice 4 (orchestrator-written) — ADR-050 + ADR-045 supersede

**Goal:** Lock in the methodology decision in canon-form per
orchestration §1 (ADRs are orchestrator-only).

**Procedure:**

1. Wrote `docs/specs/adr-050-q5-path-d-cboe-putcall-json-ingest.md`
   (Status: Accepted, orchestration-authored, no operator sign-off
   required per the data-source policy + orchestration §7.1).
2. Edited `docs/specs/adr-045-phase1-v3-cboe-putcall-input-window.md`
   status line: `Accepted (provisional)` → `Superseded by ADR-050`.
   Body preserved as historical record per the supersedes-not-deletes
   pattern from ADR-049 (Cycle 17).

**Files in slice 4 (commit will be assembled):**

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/adr-050-q5-path-d-cboe-putcall-json-ingest.md` | new | Full Path D ratification + Phase 0/1/2 implementation status + cross-refs |
| `docs/specs/adr-045-phase1-v3-cboe-putcall-input-window.md` | edit (status line only) | Superseded marker |

### Cycle 21 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Data-Ingest worker (general-purpose, in-place on main) | Slice 1 — Python JSON ingest + tests + smoke probe | AUTO-APPROVE | Integration gate green |
| Infra worker (general-purpose, in-place on main) | Slice 2 — daemon helper + step 1b'' + health flip + npm scripts | AUTO-APPROVE (with direct review-pass, since daemon orchestration touched) | Integration gate green |
| Orchestrator (self-execution) | Slice 3 — backfill 2019-10-07 → today | n/a (one-shot operator step) | 1,667 rows in CH |
| Orchestrator (self-edit per §1) | Slice 4 — ADR-050 + ADR-045 supersede | n/a (orchestrator-only) | Canon locked |

### Verification gates at cycle close

```text
git status                                                          # clean (4 slices + HANDOFF rewrite)
git log origin/main..HEAD                                            # 64 commits ahead (was 59)
npx tsc --noEmit                                                     # 13 baseline errors unchanged (delta 0)
node --import tsx --test scripts/tests/daemonCboePutCallFetch.test.ts \
  scripts/tests/daemonFredFetch.test.ts \
  scripts/tests/healthCheck.test.ts \
  scripts/tests/etfFlowDashboard.test.ts                              # 56/56 pass across 4 suites
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_json_ingest.py -v # 23/23 pass (Data-Ingest worker confirmed)
git worktree list                                                    # main only (both workers ran in-place, not in worktree)
```

### Post-Cycle-21 health snapshot

`macro_indicators_cboe` flipped to `[daemon]` autonomous; staleness
reading goes from "very-stale 2425d" → "fresh" once the next daemon
run executes step 1b''. No new Tier-2 quarantine rows.
`quantlab.health_quarantine` still 2 rows total (Q-5 + Q-6, both
`accepted-as-warning`). Q-5 row stays pinned until ~5 trading days of
fresh CBOE rows land and orchestrator drops it (follow-up cycle).

### Push state

- `origin/main` at `c0cda7c`; **64 unpushed commits** after this HANDOFF
  rewrite.
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1..15 (s96 #17) | ✓ as documented (S96-70..S96-96) |
| Cycle 16 — `/#/regime` UI smoke-test + §3.1 codified | ✓ s96 #17 (S96-97 + S96-98) |
| Cycle 17 — Q-6 resolved via ADR-049 stockanalysis adapter | ✓ s96 #17 (S96-99..S96-101) |
| Cycle 18 — day-2 stockanalysis observation (PASS) | ✓ s96 #18 (S96-102) |
| Cycle 19 — OQ-C16-1 probe → Q-7 surfaced | ✓ s96 #18 (S96-103) |
| Cycle 20 — Q-6 UI fix + Q-5 Path D found + Phase B unbundled | ✓ s96 #19 (S96-104..S96-107) |
| **Cycle 21 — Q-5 Path D shipped end-to-end (ingest + daemon + backfill + ADR-050)** | **✓ s96 #20 (S96-108..S96-111)** |
| Cycle 22 — day-3 stockanalysis observation (Monday — first trading day) | ☐ NEXT default (recommended IF Monday EOD or later) |
| Cycle 22-alt — Phase B campaign for cycle_v1 (first Layer-0 statistical validation) | ☐ NEWLY UNLOCKED alternative |
| Cycle 22-alt — Q-7 Path 1/2/3 execution (operator-gated) | ☐ alternative once operator picks Q-7 path |
| Cycle 22-alt — Q-5 quarantine row drop (after ≥5 fresh CBOE days post-Path-D) | ☐ orchestrator-owned follow-up |
| Cycle 23+ — v1 primary read path flip (after 5-day window passes) | ⏸ blocked on 5-day observation completion |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation completion |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| **GAP-3 CBOE put/call daemon hook** | **✓ CLOSED Cycle 21 (side-effect of step 1b'')** |
| **F2 CBOE backfill + re-classify (Q-5 path D)** | **✓ BACKFILL DONE Cycle 21; re-classify deferred to follow-up per ADR-050 §Phase 2** |
| Composite worker (Q-5-blocked phase1_v3 re-classify) | ⏸ ADR-050 §Phase 2 — DEFAULT is no counterfactual rewrite; operator may request |
| Composite worker (Q-6-blocked etf-flow read-path flip) | ⏸ blocked on 5-day observation completion |
| Q-7-blocked phase1_v3 yield-curve source persistence resolution | ⏸ blocked on Q-7 pick |
| C-12 Phase B AlpacaAdapter (broker integration, real-money path) | ⏸ INDEFINITELY PAUSED — operator-gated (unchanged); distinct from Layer-0 Phase B statistical validation per slice 3 of Cycle 20 |
| Layer-0 Phase B statistical validation campaigns (nine composites) | ☐ NEWLY UNBLOCKED per S96-106 — orchestration owns execution |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per slice 3 of Cycle 20 §7.1 item 8 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED per s96 #19 framing |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #20 (Cycle 21 of multi-agent orchestration)

**S96-108. Q-5 closes as orchestration-resolved via Path D
(ADR-050).** `Why:` Operator constraint 2026-05-24 ("free reliable data
only") rejected Path A (paid DataShop) and left Cycle 20's research
agent to find an alternative. The Cycle 20 slice 2 finding (a free
anonymous CBOE daily JSON endpoint at
`cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options`,
live since 2019-10-07) was confirmed clean against the data-source
policy. Cycle 21 shipped the end-to-end implementation: new ingest
(`scripts/cboe_putcall_json_ingest.py`) + daemon helper
(`src/server/daemon_cboe_putcall_fetch.ts`) + step 1b'' wiring + npm
scripts + health-check autonomous flip + backfill 2019-10-07 → today +
ADR-050 + ADR-045 superseded. Q-5 operator queue row updates from
"PATH D ORCHESTRATION-OWNED" → "CLOSED — orchestration-resolved via
ADR-050." `How to apply:` (1) Future free-source replacements for
dead canonical primary sources follow this pattern: search the
canonical primary's own CDN first (CBOE's own `cdn.cboe.com` here),
then aggregators, then GitHub references; once an endpoint candidate
is found, probe ≥3 historical dates spanning the dead-source-freeze
gap before committing to the path. (2) Data-Ingest workers MUST
probe live JSON shapes before parser design — the Cycle 21 worker
caught that the analysis doc's `data["ratios"]` was prose shorthand;
actual response is top-level `ratios`. (3) When a free path closes
an operator queue item, the orchestration's authority extends to
shipping it within the data-source policy; the operator queue update
documents the closure but the operator is not gated on it.

**S96-109. CBOE put/call provenance segregated via the `source`
column: `cboe` for legacy CSV rows (2003-10-17 → 2019-10-04),
`cboe_json` for new JSON-endpoint rows (2019-10-07 → today).**
`Why:` Two ingests, two source-of-truth feeds, same canonical
`series_id="CPC"` + same `quantlab.macro_indicators_cboe` table. The
ReplacingMergeTree sort key is `(series_id, observation_date)` —
the `source` column is NOT in the sort key, so collisions would be
collapsed via `ingested_at` versioning if the date windows overlapped.
But the legacy CSV ends 2019-10-04 and JSON starts 2019-10-07 (2-day
weekend gap), so no overlap exists; provenance is preserved cleanly.
`How to apply:` (1) Future runs of either ingest WITHIN its respective
date window are idempotent. (2) If a future cycle adds a third CBOE
source for the same series_id (e.g. paid DataShop or a research-grade
academic feed), that source's date window must be checked for overlap
with the existing two; if overlap exists, the orchestrator must either
extend the sort key to include `source` (a DDL change requiring
operator gate per §7.2 — composite-adjacent) or pick a different
`series_id` (e.g. `CPC_DATASHOP`). (3) The legacy CSV ingest
`scripts/cboe_putcall_ingest.py` is NOT removed by Cycle 21 — it
remains the canonical ingest for the 2003-2019 archive window. Two
ingests; one table; one classifier.

**S96-110. Audit-trail integrity preserved — Cycle 21's backfill does
NOT trigger a retroactive rewrite of `quantlab.macro_regimes`
historical rows.** `Why:` Per ADR-044 §"Standing infrastructure"
item 2, historical classifier outputs persist as-they-were-classified-
at-the-time. The 2019-10-07 → 2026-05-23 phase1_v3 outputs in
`macro_regimes` were classified against the corrupted-input window
(primary arm dark, secondary VIX/VIX3M arm operative). They stand as
evidence; the corruption is documented in ADR-045 + the
`accepted-as-warning` quarantine row, not erased. **Forward**
classify-calls (from the next daemon run after step 1b'' lands and
≥5 fresh CBOE days are in CH) will see the primary arm restored. A
hypothetical "what would phase1_v3 have said with correct CBOE input?"
counterfactual rewrite is deferred to a future ADR — ADR-050 §Phase 2
pins this as a separate methodology decision, not a side-effect of
the source fix. `How to apply:` (1) Backtest panels (`bt_runs_regime`)
should NOT be re-run against backfilled CBOE data without an explicit
ADR ratifying the counterfactual. (2) The Q-5 quarantine row stays
pinned `accepted-as-warning` until ≥5 fresh CBOE days have landed
AND the orchestrator drops the row in a follow-up cycle —
documenting that the source is fresh going forward, not that the
historical record was rewritten.

**S96-111. GAP-3 (CBOE put/call daemon hook) closes as side-effect of
S96-108.** `Why:` GAP-3 was on the orchestration's standing-health
backlog from the 2026-05-21 reconciliation audit (§2.1 of multi-agent-
orchestration.md). It was deferred ("low priority — promoting a frozen
source adds no value") under ADR-045's gate. With Path D shipping a
non-frozen source, the daemon promotion immediately has value:
forward freshness for the new source. The Cycle 21 Infra worker wired
step 1b'' between FRED (1b') and macro-classify-v3 (1c) in the same
slice that established the daemon helper. `How to apply:` GAP-3 row
in any future audit summary is closed; the standing-health backlog
list should drop it. The Cycle-2 dependency-DAG entry pointing GAP-3
at the CBOE backfill is also closed; the F2 carry-over reference in
HANDOFF can stop showing it as blocked.

**Carry-overs (still in force):** S96-1..S96-107; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C21-1** — Q-5 quarantine row drop timing. The row stays pinned
  `accepted-as-warning` per ADR-050 §Decision 4 until ≥5 consecutive
  fresh CBOE days land via daemon step 1b'' AND the classifier's
  forward output is verified plausible. The orchestrator drops the
  row in a follow-up cycle; no operator action. Resolution: a
  Composite-worker (lightweight) or orchestrator-self-edit (if pure
  CH DELETE on the quarantine row) cycle. Timing depends on the
  first 5 daemon runs that successfully execute step 1b'' — earliest
  drop is ~5 calendar days from Cycle 21, longer if the daemon
  doesn't run daily.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement. ADR-050
  §Decision 5 documents this as a future RESEARCH→DESIGN cycle. The
  new ingest supports `--ratio equity` out-of-the-box; the test suite
  pins the case-sensitive key names. The methodology shift would
  refine `sentiment_extreme` to use equity-only P/C (retail-heavy)
  instead of TOTAL (which conflates institutional hedging) per the
  TA canon's "smart-money vs dumb-money" framing. Not actioned
  Cycle 21; logged here for a future cycle's pickup.

### CARRIED from earlier cycles

- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix deferred to
  operator dev-server restart. Operator's dev server holds :3000
  with the pre-Cycle-20 binary; orchestrator declined to restart
  per "killing user processes" hard-stop. Operator action: `npm run
  dev` restart + refresh `/#/etf-flow`. Expected DOM per Cycle 20
  slice 1 deliverable. If render diverges from expected, surface as
  Cycle 22 first-task. Low-priority informational; the slice's tests
  + probe + JSX reading substitute for the visual.
- **OQ-C17-1** — VOO source quality issue. stockanalysis.com publishes
  `sharesOut: 2.36B` for VOO that doesn't reconcile with current
  `aum: $973.41B` + `close: $686.53` (implied shares = 1.418B; 39.9%
  delta). Confirmed structural in Cycle 18 day-2 observation. Status:
  operator-gated; covered in Q-6 row.
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C19-1** — inputs_missing UInt8 truncation at bits 8+.
- **OQ-C16-1** — RESOLVED Cycle 19 (`d65d4d3`, S96-103).
- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers — CLOSED
  Cycle 17 by ADR-049.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing (NEWLY UNBLOCKED per S96-106 — these become
  Cycle 22+ candidates).
- **OQ-G9-1** — issuer-specific schema mappers — CLOSED Cycle 17 by
  ADR-049.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused (operator-gated; per S96-106
  this is unrelated to Layer-0 Phase B unbundling).
- Capital-deployment-ramp ADR — Q-2 (indefinitely deferred per S96-107).
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent (operator-call).
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 22 candidate

**Recommended IF Monday EOD or later:** day-3 stockanalysis
observation (Monday 2026-05-25 is the first trading day in the 5-day
window). Procedure same as Cycle 18 (takes ~5 min):

1. `npm run health:check` first per ADR-044.
2. Probe day-2 baseline: `npx tsx scripts/_probe_stockanalysis_day_over_day.ts`.
3. Dry-run: `npm run etf:flow:stockanalysis:fetch:dry`.
4. Cross-check SPY: `.venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --tickers SPY --dry-run`.
5. Apply: `npm run etf:flow:stockanalysis:refresh`.
6. Verify: re-probe + diff vs day-2.
7. Commit + HANDOFF rewrite.

**If invoked before Monday EOD or operator pivots, alternatives:**

- **Phase B campaign for cycle_v1** — newly unblocked per S96-106
  (slice 3 of Cycle 20). Spec exists at `docs/specs/market-cycle-position.md`
  §Phase B. Composite worker + Health worker pair (DSR / PBO / HLZ
  deflation pipeline run + verdict surface). First Layer-0
  statistical-validation campaign — establishes the pattern for the
  8 remaining composites.
- **Q-5 quarantine row drop** — per OQ-C21-1, gated on ≥5 fresh
  CBOE days landing via daemon step 1b''. Calendar permitting (likely
  Cycle 26-27 earliest), one-shot orchestrator step.
- **If operator picks Q-7 path:** orchestration executes the chosen
  path (Path 1 / Path 2 / Path 3 / hybrid).

### Lower-priority Cycle 22+ alternatives

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening.
- **N-PORT quarterly cross-check scaffolding** — better deferred
  until 5-day stockanalysis observation completes + Q-7 path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

---

## Files / code state

### New / modified this cycle (s96 #20 Cycle 21)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/cboe_putcall_json_ingest.py` | new (+522) | Slice 1 (Data-Ingest) — JSON-endpoint ingest; 4-ratio support; strict schema validation |
| `scripts/tests/test_cboe_putcall_json_ingest.py` | new (+283) | Slice 1 — 23 pytests; JSON shape + ratio keys + holiday + NaN pin |
| `scripts/_probe_cboe_putcall_json.ts` | new (+155) | Slice 1 — stdlib TS smoke probe |
| `src/server/daemon_cboe_putcall_fetch.ts` | new (+97) | Slice 2 (Infra) — daemon helper; 7-day --start window |
| `scripts/daily_signal_daemon.ts` | +35/-0 | Slice 2 — step 1b'' wiring + import |
| `package.json` | +2/-0 | Slice 2 — npm scripts |
| `src/server/health_check.ts` | +3/-4 | Slice 2 — `macro_indicators_cboe` autonomous flip + why update |
| `scripts/tests/daemonCboePutCallFetch.test.ts` | new (+131) | Slice 2 — 10 daemon-helper unit tests |
| `docs/specs/adr-050-q5-path-d-cboe-putcall-json-ingest.md` | new | Slice 4 — Path D ratification; supersedes ADR-045 |
| `docs/specs/adr-045-phase1-v3-cboe-putcall-input-window.md` | edit (status line) | Slice 4 — Superseded marker |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+1,228 LOC across 8 new + 3 edited files (4 slices) + 1 HANDOFF rewrite + ADR-050 + ADR-045 status edit**. No DDL changes. No real-money path touched. No paid-data subscription. No authenticated scrape.

### DB-state changes this cycle

- `quantlab.macro_indicators_cboe`: 1,667 new rows
  inserted via slice 3 backfill (source=`cboe_json`, dates 2019-10-07
  → today). Table total now 5,685 rows (was 4,018; cboe
  legacy 4,018 + cboe_json 1,667).
- Forward daemon-cadence: step 1b'' will append ~1 row/day on each
  daemon run from now on; ReplacingMergeTree handles idempotency on
  the 7-day re-fetch window.
- No other DB changes.

### Test + tsc state

- `daemonCboePutCallFetch.test.ts`: **10/10 pass** (new this cycle)
- `test_cboe_putcall_json_ingest.py`: **23/23 pass** (new this cycle;
  pytest, Data-Ingest-worker verified)
- `daemonFredFetch.test.ts`: **3/3 pass**
- `healthCheck.test.ts`: **37/37 pass** (convention pins green after
  the autonomous flip)
- `etfFlowDashboard.test.ts`: **6/6 pass** (Cycle 20 carry-over)
- Aggregate this cycle: **79 tests pass across affected suites**
- `npx tsc --noEmit`: **13 baseline errors unchanged**

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning` (drop is a
  follow-up cycle's task; per OQ-C21-1).
- Q-7 quarantine + tracking rows still loaded for first Telegram alerts
  on next live daemon run with valid creds.
- `quantlab.macro_indicators_cboe` carries 5,685 rows
  (cboe + cboe_json).
- `quantlab.macro_indicators_fred`: T10Y3M last=2026-05-21; T10Y2Y
  last=2026-05-21; FRED 3.6d stale per health:check.
- `quantlab.macro_regimes` phase1_v3: corrupted-input historical
  window preserved per S96-110 + ADR-050 §Decision 3.
- `quantlab.etf_shares_outstanding`: 0 rows, v1 yfinance source dead
  per S96-89.
- `quantlab.etf_shares_outstanding_secondary`: 956 rows / 20 tickers
  (15 SSGA + 5 stockanalysis at 2 dates; VOO absent).
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).
- **Operator dev server (:3000) running pre-Cycle-20 binary** — still
  needs `npm run dev` restart for the Cycle 20 etf-flow fix to render.
  Cycle 21 added no UI surface so no additional restart needed.

---

## Watch-outs

### NEW from this cycle (s96 #20 Cycle 21)

- **CBOE JSON endpoint is undocumented in CBOE's public API surface.**
  Discovered via direct probing + a GitHub reference (`debegr92/cboe_pcr`).
  Theoretically retire-able by CBOE without notice. Schema-validation
  pin in the ingest catches structural changes loudly; the daemon
  step is non-fatal so a broken endpoint surfaces as a warning
  anomaly, not a daemon crash. Fallback paths from ADR-045 (Path B
  methodology amendment is a 2-line SPEC patch; Path A paid DataShop
  remains an operator option) stay reachable.
- **The free-source research pattern is canonical.** When a canonical
  primary source freezes (CBOE 2019-10-04; OPEC 2026; whatever), the
  research approach is: probe the canonical primary's own CDN first
  (NOT aggregators — those derive from the same dead source most of
  the time post-freeze); then aggregators / derivatives; then GitHub
  references. The canonical primary is almost always strictly better
  than any third-party derivative when it exists.
- **JSON shape verification BEFORE parser design.** Cycle 21's
  Data-Ingest worker discovered the analysis doc's prose
  `data["ratios"]` was shorthand — actual shape is top-level
  `ratios`. Probed the endpoint first; locked the shape with a
  regression test using the analysis-doc shorthand as the negative-
  case fixture. **All future Data-Ingest workers MUST probe the
  endpoint before parser design.**
- **Audit-trail integrity is the default for source fixes.** Per
  S96-110 + ADR-050 §Decision 3 + ADR-044 §"Standing infrastructure"
  item 2: a source fix does NOT trigger historical rewrites unless
  an explicit ADR ratifies the counterfactual. Backtest panels
  reading `bt_runs_regime` against the 2019-2026 window stay as-is.
- **Provenance segregation via `source` column has a hidden DDL gate.**
  Per S96-109: two sources with disjoint date windows coexist
  cleanly. A third source on the same series_id with overlapping
  dates would need either (a) DDL widening of the sort key to
  include `source` (operator-gated, composite-adjacent), or (b) a
  fresh `series_id` (orchestration's call).

### Carried from earlier sessions

All prior watch-outs (s96 #1-#19 + Cycle 20 + Cycle 21 carry-overs)
preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green
npm run system-health:check            # Phase 2 v1 dispatcher
npm run system-health:check -- --json  # Phase 2 v1 JSON payload
# UI surface: http://localhost:3000/#/health
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
npm run health:check
```

### ETF flow ingest (post-Cycle-20 — Q-6 PARTIAL-WITH-UI-FIX)

```text
# v1 primary panel (yfinance) — STILL DEAD per Q-6 / S96-89

# v3.1 SSGA secondary (15 tickers: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY

# v3.1 stockanalysis secondary (5 tickers: IVV+QQQ+IWM+HYG+TLT)
npm run etf:flow:stockanalysis:fetch                       # adapter only
npm run etf:flow:stockanalysis:fetch:dry                   # dry-run
npm run etf:flow:stockanalysis:refresh                     # APPLY

# Re-runnable smoke probe (Cycle 20):
npx tsx scripts/_probe_etf_flow_dashboard_response.ts
```

### CBOE put/call ingest (post-Cycle-21 — Q-5 CLOSED via ADR-050)

```text
# Legacy CSV ingest (covers 2003-10-17 → 2019-10-04; source=cboe):
npm run cboe:ingest
npm run cboe:ingest:dry

# NEW JSON ingest (Cycle 21 Path D; covers 2019-10-07 → today; source=cboe_json):
npm run cboe:ingest:json                                   # daemon-default; backfill if needed
npm run cboe:ingest:json:dry                               # dry-run
.venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --start 2019-10-07 --sleep-ms 300  # full backfill
.venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --start 2026-05-19 --end 2026-05-22 --dry-run  # smoke test

# Re-runnable smoke probe (Cycle 21):
npx tsx scripts/_probe_cboe_putcall_json.ts                # 4 reference fetches across the JSON endpoint
```

### Cross-source probes (Cycles 17-21)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # post-OPTIMIZE source label counts in CH
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # per-ticker per-date stockanalysis rows (Cycle 18)
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED T10Y3M + SPY alignment + macro_regimes rows (Cycle 19)
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y comparison + ingested_at metadata (Cycle 19)
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # etf-flow dashboard builder output shape (Cycle 20)
npx tsx scripts/_probe_cboe_putcall_json.ts             # CBOE daily JSON endpoint reference fetches (Cycle 21)
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
node --import tsx --test scripts/tests/daemonCboePutCallFetch.test.ts                                 # 10/10 pass (NEW Cycle 21)
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_json_ingest.py -v                  # 23/23 pass (NEW Cycle 21)
npm run dev                                                                                           # http://localhost:3000 (operator restart needed for Cycle 20 etf-flow fix)
npx tsc --noEmit                                                                                      # 13 baseline errors
```

---

## For the next session — priority order

**Default on `continue`:** Cycle 22 candidate — **recommended day-3
stockanalysis observation (Monday 2026-05-25, first trading day in
the window)** IF invoked Monday EOD or later. If invoked before
Monday EOD, pivot to one of the NEWLY UNLOCKED alternatives below.

**NEWLY UNLOCKED Cycle 22 alternatives (in priority order):**

- **Phase B campaign for cycle_v1** (Composite + Health worker pair).
  First Layer-0 statistical-validation campaign — establishes the
  pattern for the 8 remaining composites.
- **Q-5 quarantine row drop** — per OQ-C21-1, gated on ≥5 fresh CBOE
  days landing. Calendar-likely Cycle 26+ earliest.
- **If operator picks Q-7 path:** orchestration executes the chosen
  path (Path 1 / 2 / 3 / hybrid).

**Other Cycle 22 alternatives (lower priority):**

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening; Composite + Infra worker pair.
- **N-PORT quarterly cross-check scaffolding** — for ALL secondary-
  table sources. Better deferred until 5-day window completes + Q-7
  path picked.
- **OQ-C21-2 equity vs total P/C methodology refinement** — future
  RESEARCH→DESIGN cycle; ingest is ready.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-7):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED** per
  S96-107.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED** per
  S96-107.
- Q-3 Stooq apikey gate decision.
- Q-4 push 64 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX (operator should `npm run dev` restart +
  visually verify `/#/etf-flow`).
- Q-7 — phase1_v3 yield-curve source persistence — operator picks
  Path 1 / Path 2 / Path 3 (or hybrid).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase C promotion of any Layer-0 composite to phase1_v3+ classifier
  input (methodology amendment per orchestration §7.1 item 8).
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution (operator-pick gate).
- **v1 primary read path flip** — operator-gated via the 5-day
  observation window completing successfully.
- VOO-specific paid feed or alternative source.
- **Counterfactual rewrite of historical macro_regimes** under
  backfilled CBOE inputs (per S96-110; would require a new ADR).

---

## Important framing for the next chat

**Cycle 21 is closed.** Four slices: slice 1 Python JSON ingest (Data-
Ingest worker, +960 LOC); slice 2 daemon helper + step 1b'' wiring +
health flip (Infra worker, +268/-4 LOC); slice 3 backfill 2019-10-07
→ today (orchestrator-executed); slice 4 ADR-050 + ADR-045 supersede
(orchestrator-written). This HANDOFF rewrite is the 64th unpushed
commit (5 commits this cycle).

**Q-5 transformed from "PATH D ORCHESTRATION-OWNED" → CLOSED.**
ADR-050 ratified the resolution; ADR-045 marked Superseded.

**GAP-3 (CBOE daemon hook) closed as side-effect** of step 1b''
landing.

**Q-5 quarantine row remains pinned** until ≥5 fresh CBOE days land
via the new daemon step + a follow-up cycle drops it (OQ-C21-1, no
operator action). The phase1_v3 sentiment_extreme primary arm is
fully restored from the next daemon run forward; the historical
2019-10-07 → 2026-05-23 corrupted-input window is preserved per
ADR-050 §Decision 3 + S96-110 + ADR-044 §"Standing infrastructure"
item 2.

**S96-108, S96-109, S96-110, S96-111 are the new lock-ins.**

**Cycle 22 default path: day-3 stockanalysis observation (Monday
2026-05-25)** IF invoked Monday EOD or later; otherwise pivot to
Phase B campaign for cycle_v1 OR Q-7 if operator picks a path.
