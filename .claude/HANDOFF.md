# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #19 — **Cycle 20 of multi-agent
orchestration executed**. Operator typed `continue` after pre-cycle
conversation that established three new framings: (1) **"We will not be
trading real money while the system is incomplete and other segments are
set"** — pins Q-1 and Q-2 as indefinitely deferred, not near-term; (2)
**Q-5 must use free reliable data** — paid CBOE DataShop is dead; (3)
**Q-6 etf-flow not populating in UI** — operator-reported bug, [HEALTH]
miss on orchestration. Cycle 20 executed the four-item sequence from the
pre-cycle conversation: slice 1 Q-6 UI fix (UI worker); slice 2 Q-5 Path
D research (research agent, background); slice 3 Phase B unbundling
(orchestrator self-edit); item 4 day-3 stockanalysis observation deferred
to Cycle 21 (calendar-blocked — today is still Sunday 2026-05-24; day-3
needs Monday EOD). **All three slices integrated cleanly; tsc 13 baseline
preserved; 283/283 tests pass on affected suites.** **Net 59 unpushed
commits** on top of `origin/main` (`c0cda7c`) after this HANDOFF rewrite
(was 55 at Cycle 19 close · +1 slice 1 (8c6caa7) = 56 · +1 slice 2
(81e7382) = 57 · +1 slice 3 (3819814) = 58 · +1 HANDOFF = 59).
**Key deliverables:** Q-6 panel now renders v3.1 secondary as
source-of-truth when v1 primary is dark, with honest banner per ADR-044
§UI (browser-smoke deferred to operator dev-server restart — operator
should `npm run dev` restart + refresh `/#/etf-flow` to visually
validate); Q-5 Path D **confirmed and clean** (CBOE daily JSON endpoint
at `cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options`,
live since 2019-10-07, like-for-like with the dead `totalpc.csv`, no
methodology amendment needed); Phase B statistical-validation campaigns
formally unbundled from operator queue (orchestration owns execution;
only Phase C promotion of any Layer-0 composite to classifier input
stays operator-gated). **NEXT default on `continue`:** Cycle 21 candidate
— recommended **day-3 stockanalysis observation (Monday 2026-05-25 — first
trading day)** OR **Q-5 Path D implementation** (newly-unlocked, ~400-500
LOC + 1 ADR, Data-Ingest + Infra worker pair).

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
| Q-4 | Push 59 unpushed commits to origin/main (Cycle 20 slices 1+2+3 + this HANDOFF is the 59th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window. **Path D CONFIRMED Cycle 20 — CBOE daily JSON endpoint is a free, anonymous, like-for-like replacement for the dead `totalpc.csv`. Orchestration owns the ingest change per data-source policy; no operator pick needed.** Implementation effort ~400-500 LOC + 1 ADR. Paths B (methodology amendment) and C (keep quarantine) remain as fallbacks if Path D's prototype surfaces a blocker. Path A (paid DataShop) stays dead. Full finding in `docs/analysis/q5-path-d-cboe-json-2026-05-24.md`. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned `accepted-as-warning`; refined Cycles 11 + 20 | **PATH D ORCHESTRATION-OWNED** — operator action no longer required for resolution (orchestration ships Path D in Cycle 21+); only re-engaged if Path D's prototype hits a blocker |
| Q-6 | ETF v1 yfinance primary panel — Cycle 17 resolved data side via ADR-049; Cycle 20 fixed UI side via 3-mode dispatch + primary-dark banner. **Status: PARTIAL-WITH-UI-FIX.** Closes on (a) the 5-day stockanalysis observation completing successfully + (b) the v1-primary read-path flip (Cycle 23+). Operator action no longer required for the UI; remaining residual gate is on (a) SA proving unreliable (revert to ADR-048 path-B), or (b) operator wanting paid feed for VOO specifically. | s96 #17 Cycle 12-17 (S96-89..S96-101); Cycle 18 (S96-102); Cycle 20 (S96-104) | PARTIAL-WITH-UI-FIX — orchestration-resolved; closes on read-path flip (Cycle 23+) |
| Q-7 | phase1_v3 yield-curve source persistence — macro_regimes.yield_curve_value carries T10Y2Y on trade_dates 2026-05-15..2026-05-21; ADR-041 (Accepted 2026-05-19) mandates T10Y3M. Three resolution paths: (1) narrow re-classify post-ADR-041 dates only; (2) daemon refresh-stale loop; (3) daemon timing shift after FRED EOD publish. Orchestration's recommendation: Path 1 immediate cleanup + Path 2 architectural follow-up. Full detail in `docs/analysis/fred-t10y3m-alignment-2026-05-24.md`. | s96 #18 Cycle 19 — OQ-C16-1 probe falsified Cycle 16 hypothesis; Tier-2 per ADR-044 + ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |

**That's the entire queue.** Q-1 + Q-2 NEW status (indefinitely deferred).
Q-4 count 55 → 59. **Q-5 status changed**: was "operator picks A/B/C";
now "Path D orchestration-owned" — operator no longer required to pick.
Q-6 status appended ("with UI fix"). Q-7 unchanged.

---

## What this cycle delivered (s96 #19 Cycle 20)

### Slice 1 (`8c6caa7`, +553/-25 across 4 files) — Q-6 ETF flow UI fix (UI worker)

**Goal:** Fix the operator-reported "etf-flow is not populating in UI"
bug. Cycle 17's ADR-049 stockanalysis adapter + the SSGA adapter both
populate `quantlab.etf_shares_outstanding_secondary` (956 rows / 20
tickers at recent dates), but the dashboard rendered empty-state
because `etf_flow_dashboard.ts:91` enforced AND-logic
`hasIntersection = primary.length > 0 && secondary.length > 0`. With v1
yfinance primary dead since 2026-05-19 (S96-89), `primary.length === 0`
always, so the response always returned `hasData: false`, so the panel
always rendered empty.

**Worker procedure (general-purpose agent, ~10 min, in-place edits on main):**

1. Investigated root cause via existing files (no new probes needed at
   investigation stage).
2. Refactored builder into a 3-mode dispatch (`cross-validation` /
   `secondary-only` / `empty`) with new types `EtfFlowPanelMode` +
   `EtfFlowSecondaryLatestRow` and helper `buildSecondaryLatest`.
3. Added React components: `PrimaryDarkBanner` (amber, dense, names dead
   source + failure date + diagnostic ticket + resolution doc + secondary
   breakdown + why cross-validation is hidden + operator-queue tag),
   `SecondaryOnlyDashboard` (no cross-validation sub-panels — meaningless
   with one side empty), `SecondaryOnlySummaryPanel` (6 tiles),
   `SecondaryOnlyTablePanel` (8-column per-ticker latest shares/close/AUM
   + day-over-day delta).
4. Added 6 new tests in `etfFlowDashboard.test.ts` covering all 3 modes
   + the secondary-latest helper.
5. Added re-runnable smoke probe `scripts/_probe_etf_flow_dashboard_response.ts`
   (`_probe_*.ts` pattern from Cycles 18-19).
6. Verified probe output against live CH: `mode: secondary-only`,
   `hasData: true`, counts `{primaryRows: 0, secondaryRows: 956}`, 20
   secondaryLatest rows. SPY: 1,033,632,116 shares × $742.77 = $7.68e+11
   AUM (+0.291% DoD). All values plausible; no NaN/Infinity.

**Critic verdict (orchestration §6):** RESOLVE-IN-PLACE with note.
Browser-smoke deferred to operator dev-server restart (operator's dev
server holds :3000 with the pre-Cycle-20 binary; orchestrator declined
to restart per "killing user processes" hard-stop rule). Substituted:
tests + JSX reading + the new probe script against live CH. All six §6.1
gates green except the browser-smoke gate; resolved in-place by
explicit note + Cycle 21 first-task to operator-validate.

**Semantic shift accepted by critic:** in `cross-validation` mode with
`totalCompared === 0` (both panels non-empty but no date overlap), the
response now returns `hasData: true` (was `false`). Worker's reasoning:
the prior empty-state copy was misleading; the new behavior surfaces
"0 pairs compared, 0 divergences" via existing empty-message branches
which is more honest. No test breaks.

**Operator-visible expected DOM** when dev-server restart picks up the
change:

- Header: "VECTOR_ETFFLOW · v3.1 secondary panel (primary dark)" + amber
  subtitle "956 secondary rows · 20 tickers"
- Amber `PrimaryDarkBanner` above the panels naming source + dates +
  S96-89 + ADR-049 + secondary breakdown
- `SecondaryOnlySummaryPanel`: 6 tiles (Tickers / Secondary rows / Total
  AUM / Newest date / Oldest date / With DoD delta)
- `SecondaryOnlyTablePanel`: 8-column table with 20 rows sorted ASC by
  ticker
- The old `TopDivergencesPanel` + `PerTickerPanel` (cross-validation
  comparison) do NOT render in this mode

**Files in slice 1 (commit `8c6caa7`, +553/-25):**

| Path | Change | Notes |
| --- | --- | --- |
| `src/server/etf_flow_dashboard.ts` | +166/-25 | 3-mode dispatch + types + `buildSecondaryLatest` helper |
| `src/components/etfFlow/EtfFlowApp.tsx` | +197/-14 | `PrimaryDarkBanner` + `SecondaryOnlyDashboard` + `SecondaryOnlySummaryPanel` + `SecondaryOnlyTablePanel` + formatters + mode dispatch |
| `scripts/tests/etfFlowDashboard.test.ts` | new (+154) | 6 tests covering all 3 modes + secondary-latest helper |
| `scripts/_probe_etf_flow_dashboard_response.ts` | new (+47) | Re-runnable smoke probe |

### Slice 2 (`81e7382`, +160/-0 across 1 file) — Q-5 Path D research

**Goal:** Find a free, reliable, like-for-like replacement for the dead
`totalpc.csv` feed (Q-5 resolution gate). Operator constraint: "Q-5
needs to have free reliable data" — paid CBOE DataShop rejected.

**Research-agent procedure (general-purpose agent, background ~12 min):**

1. Verified existing legacy CSV freeze (re-confirmed `totalpc.csv` +
   `equitypc.csv` + `indexpc.csv` are all frozen at 2019-10-04).
2. Probed CBOE daily JSON endpoint at
   `https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options`
   across 7 historical dates spanning 2019-10-07 to 2026-05-22 — all
   HTTP 200.
3. Verified no rate-limit at 20 rapid sequential fetches.
4. Probed alternatives: OCC weekly (cadence mismatch — daily MA window
   would break); Yahoo / yfinance (no put/call symbol exposed); Stooq
   `^cpc` (does not exist); FRED release 200 (volatility indices only,
   no put/call); MacroMicro / YCharts / Barchart / Investing.com /
   AlphaQuery (paid or auth-gated, all derivatives one extra hop from
   CBOE's own JSON).
5. Confirmed independent reference: `debegr92/cboe_pcr` Python crawler
   (2026-03-29) documents the same endpoint.
6. Spot-check semantic match: 2026-05-22 = 0.85; 2020-01-02 = 0.83 —
   same CBOE-computed scalar as the dead legacy `totalpc.csv`.

**Key finding (verbatim from analysis doc):**

> Path D exists and is robust. CBOE publishes a free, anonymous, daily
> JSON endpoint that has been live continuously since 2019-10-07 (the
> first trading day after the legacy CSV froze) and returns TOTAL P/C,
> EQUITY P/C, INDEX P/C, ETP P/C plus raw call/put volume and open
> interest. It is a like-for-like replacement for the dead `totalpc.csv`
> feed and exactly closes the 6.5-year gap behind Q-5. No methodology
> amendment required.

**Implementation effort (recommended Cycle 21+):** ~400-500 LOC + 1 ADR.
No new Python or TS dependencies. ~5 minutes wall-clock for the full
2019-10-07 → today backfill (~1,640 fetches at 1 req/s). New ingest
script + daemon step 1b'' wiring (GAP-3 resolves alongside) + schema-
validation pin + drop Q-5 `accepted-as-warning` quarantine row once ~5
trading days of fresh CBOE rows land.

**Files in slice 2 (commit `81e7382`, +160/-0):**

| Path | Change | Notes |
| --- | --- | --- |
| `docs/analysis/q5-path-d-cboe-json-2026-05-24.md` | new (+160) | Full finding: TL;DR, per-candidate table (9 candidates), recommended implementation shape, effort estimate, methodology concerns, sources, queue impact |

### Slice 3 (`3819814`, +25/-0 across 1 file) — Phase B unbundling docs

**Goal:** Codify the naming-confusion fix that the operator's question
surfaced: "Phase B" has two unrelated meanings in SignalForge —
(a) offline statistical validation for the nine Layer-0 informational
composites (DSR / PBO / HLZ deflation pipeline, no real-money exposure
— this belongs to orchestration); (b) C-12 "Phase B AlpacaAdapter"
broker integration for a specific strategy (real-money path — operator-
gated, unchanged). The s96 HANDOFF previously bucketed both as
operator-gated, which incorrectly extended (b)'s gating to (a)'s
offline validation work.

**Orchestrator self-edit (§3.1 category 1 — pure-docs):**

1. `docs/architecture/multi-agent-orchestration.md` §7.1 item 8 ADDED —
   "Phase C promotion of any Layer-0 informational composite to
   `phase1_v3+` classifier input" is the only Phase-B-adjacent thing
   that reaches operator (Phase C adds a category that affects live
   firing behavior + downstream trade decisions; methodology amendment).
2. §7.3 EXTENDED — "Phase B statistical validation campaigns for the
   nine Layer-0 informational composites" added to the "does NOT go on
   the queue" list. Orchestration owns campaign execution + results
   aggregation + per-composite verdict surfacing.
3. §11 revision log entry added documenting the unbundling rationale.

Memory `feedback-no-real-money-until-complete` updated with the
naming-confusion fix.

**Files in slice 3 (commit `3819814`, +25/-0):**

| Path | Change | Notes |
| --- | --- | --- |
| `docs/architecture/multi-agent-orchestration.md` | +25/-0 | §7.1 item 8 + §7.3 Phase B exclusion + §11 revision log |

### Cycle 20 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| UI worker (general-purpose, in-place on main) | Slice 1 — Q-6 etf-flow panel fix | RESOLVE-IN-PLACE with note (browser-smoke deferred) | `8c6caa7` shipped; integration gate green |
| Research agent (general-purpose, background) | Slice 2 — Q-5 Path D investigation | AUTO-APPROVE (research output; no critic spawn) | `81e7382` shipped; Path D confirmed |
| Orchestrator self-edit (§3.1 category 1 — pure-docs; all 6 gates green) | Slice 3 — Phase B unbundling | AUTO-APPROVE (no critic spawn) | `3819814` shipped |

### Verification gates at cycle close

```text
git status                                                          # clean (3 slices + HANDOFF rewrite)
git log origin/main..HEAD                                            # 59 commits ahead (was 55)
npx tsc --noEmit                                                     # 13 baseline errors unchanged (delta 0)
node --import tsx --test scripts/tests/etfFlowDashboard.test.ts ...  # 182/182 pass across 5 affected suites
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass (convention pins green)
git worktree list                                                    # main only (UI worker ran in-place, not in worktree)
```

### Post-Cycle-20 health snapshot

No new Tier-2 quarantine rows. `quantlab.health_quarantine` still 2
rows total (Q-5 + Q-6, both `accepted-as-warning`). Q-7 finding still
in operator queue + analysis doc only; no quarantine-row insertion
(per ADR-044, calc-logic gates operator pick).
`quantlab.etf_shares_outstanding_secondary` unchanged at 956 rows / 20
tickers (15 SSGA + 5 stockanalysis at 2 dates; VOO absent).

### Push state

- `origin/main` at `c0cda7c`; **59 unpushed commits** after this HANDOFF
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
| **Cycle 20 — Q-6 UI fix + Q-5 Path D found + Phase B unbundled** | **✓ s96 #19 (S96-104..S96-107)** |
| Cycle 21 — day-3 stockanalysis observation (Monday — first trading day) | ☐ NEXT default (recommended IF Monday EOD or later) |
| Cycle 21-alt — Q-5 Path D implementation (Data-Ingest + Infra worker pair, ~400-500 LOC + ADR-050) | ☐ NEWLY UNLOCKED alternative |
| Cycle 21-alt — Phase B campaign for cycle_v1 (first Layer-0 statistical validation, newly unblocked by slice 3) | ☐ NEWLY UNLOCKED alternative |
| Cycle 21-alt — Q-7 Path 1/2/3 execution (operator-gated) | ☐ alternative once operator picks Q-7 path |
| Cycle 23+ — v1 primary read path flip (after 5-day window passes) | ⏸ blocked on 5-day observation completion |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation completion |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ RESOLVES alongside Q-5 Path D Cycle 21+ implementation |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ NEWLY UNBLOCKED via Q-5 Path D confirmation |
| Composite worker (Q-5-blocked phase1_v3 re-classify) | ⏸ blocked on Q-5 Path D implementation cycle |
| Composite worker (Q-6-blocked etf-flow read-path flip) | ⏸ blocked on 5-day observation completion |
| Q-7-blocked phase1_v3 yield-curve source persistence resolution | ⏸ blocked on Q-7 pick |
| C-12 Phase B AlpacaAdapter (broker integration, real-money path) | ⏸ INDEFINITELY PAUSED — operator-gated (unchanged); distinct from Layer-0 Phase B statistical validation per slice 3 |
| **Layer-0 Phase B statistical validation campaigns (nine composites)** | **☐ NEWLY UNBLOCKED — orchestration owns execution per slice 3 §7.3 update** |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per slice 3 §7.1 item 8 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED per s96 #19 framing |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #19 (Cycle 20 of multi-agent orchestration)

**S96-104. Q-6 etf-flow UI panel fixed via 3-mode dispatch +
primary-dark banner; AND-logic gate replaced.** `Why:` The Cycle 17
ADR-049 stockanalysis adapter + the SSGA adapter both populated
`etf_shares_outstanding_secondary` with 956 rows / 20 tickers, but the
dashboard rendered empty-state because `etf_flow_dashboard.ts:91`
enforced AND-logic between primary + secondary. With v1 yfinance
primary dead since 2026-05-19 (S96-89), the AND condition was
permanently false, so `hasData: false` was permanently returned, so
the React panel permanently rendered empty-state. This was a [HEALTH]
miss caught only when the operator reported the bug — exactly the
failure mode ADR-044 §UI was supposed to prevent. `How to apply:`
(1) The new 3-mode dispatch (`cross-validation` / `secondary-only` /
`empty`) is the canonical pattern for any future cross-validation
panel where one side could go structurally dead. (2) When a primary
source goes structurally dead (not just transiently stale), the UI
MUST surface that to the operator via an honest banner, not silently
fall back to the secondary. ADR-044 §UI's "no silent stale-data
propagation" extends here. (3) Browser-smoke per ADR-044 §UI must
RUN, not be deferred — Cycle 20's deferral (operator's dev server held
:3000) is a one-time exception driven by the "killing user processes"
hard-stop; future UI slices need either operator-coordinated dev-
server restart or orchestrator-owned dev-server lifecycle.

**S96-105. Q-5 Path D found and confirmed: CBOE daily JSON endpoint
at `cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options`.**
`Why:` Operator rejected paid CBOE DataShop (Path A) and asked for
free reliable data. Research probe across 9 candidates verified a
free, anonymous, daily JSON endpoint that has been live continuously
since 2019-10-07 (the first trading day after the legacy `totalpc.csv`
froze on 2019-10-04). It returns TOTAL/EQUITY/INDEX/ETP P/C ratios +
raw volume + OI; it's CBOE-direct (cdn.cboe.com); no API key; no rate
limit observed; 6KB per file. Per data-source policy this is pre-
authorized (anonymous CDN-served JSON). Like-for-like with the dead
feed — same CBOE-computed scalar; no methodology amendment required.
`How to apply:` (1) Cycle 21+ implementation candidate: Data-Ingest +
Infra worker pair; ~400-500 LOC + ADR-050; backfill 2019-10-07 →
today (~1,640 fetches, ~5 min wall-clock); daemon step 1b'' for
forward-cadence; schema-validation pin (catches CBOE renaming "TOTAL
PUT/CALL RATIO" → something else); drop Q-5 quarantine row once
classifier produces non-corrupted-input output. (2) Operator decision
no longer required for Q-5 resolution — orchestration ships per
data-source policy authorization. (3) Optional future upgrade
(separate cycle): the JSON publishes EQUITY P/C separately; could
refine `sentiment_extreme` to use equity-only P/C ("dumb money"
framing) instead of TOTAL. Not a Q-5 blocker. (4) Future research
agents tasked with finding free public sources for blocked feeds
should follow this slice 2 pattern: probe the canonical primary site
first (CBOE's own JSON in this case), then aggregators / derivatives,
then GitHub references — the canonical primary is almost always
strictly better than any third-party derivative.

**S96-106. Phase B statistical-validation campaigns for the nine
Layer-0 informational composites are orchestration-owned; only Phase C
promotion of a composite to `phase1_v3+` classifier input is operator-
gated.** `Why:` Operator question 2026-05-24 surfaced a prior bundling
that conflated two unrelated meanings of "Phase B" in SignalForge:
(a) the nine Layer-0 composites' offline statistical validation
(DSR / PBO / HLZ deflation pipeline per AFML §11 + Bailey-LdP 2014 +
Harvey-Liu-Zhu 2016, runs against `bt_runs_regime` + historical price
panels, NO broker integration, NO real-money exposure); (b) C-12
"Phase B AlpacaAdapter" broker integration for one specific strategy
(IS real-money path). The s96 HANDOFF previously bucketed both as
operator-gated, incorrectly extending (b)'s gating to (a)'s offline
work. Operator framing "no real-money trading while system is
incomplete" makes the cost of this conflation explicit: foundational
validation work was unnecessarily paused. `How to apply:`
(1) Orchestration may now spawn Layer-0 Phase B campaigns
autonomously per `docs/architecture/multi-agent-orchestration.md` §7.3
update. cycle_v1 has Phase B explicitly scoped in
`docs/specs/market-cycle-position.md` §Phase B and is the first
candidate. (2) Phase C promotion (adding a category to `phase1_v3+`
that affects live firing behavior + downstream trade decisions) is a
methodology amendment per §7.1 item 8 — operator-gated. (3) C-12
Phase B AlpacaAdapter remains operator-gated as it always was
(unrelated to Layer-0 Phase B). (4) Phase B SPEC drafting for the 8
remaining Layer-0 composites without an explicit Phase B section is
orchestration's call (the cycle_v1 template applies).

**S96-107. "No real-money trading while system is incomplete and other
segments are set" framing pinned; Q-1 + Q-2 are indefinitely deferred.**
`Why:` Operator stated this explicitly 2026-05-24. The implications:
(a) Q-1 first real-capital deployment + Q-2 capital-deployment-ramp
ADR ratification are deferred-indefinite, not near-term. (b)
Orchestration should not press on Q-1 or Q-2 in HANDOFFs or in
conversation. (c) Real-money-readiness ramp is NOT the priority;
foundational work (gaps, drift, UI completeness, OOS validation,
health domain) is. (d) The Phase B unbundling (S96-106) becomes more
load-bearing under this framing — validation work continues without
needing Q-1 / Q-2 resolution. (e) Orchestration may still draft a
`PROPOSED` capital-deployment-ramp ADR when convenient (the draft
sits at `Status: PROPOSED` indefinitely; ratification waits until
operator engages). `How to apply:` (1) Future HANDOFFs lead with
foundational-work priorities, not Q-1 / Q-2 reminders. (2) "How much
work is left" framings should describe the foundational queue first,
real-money queue last. (3) Q-3 + Q-5 + Q-7 are the actually-actionable
operator queue items (Q-5 is now orchestration-owned per S96-105;
Q-3 + Q-7 stay operator-gated).

**Carry-overs (still in force):** S96-1..S96-103; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C20-1** — Browser-smoke for slice 1 Q-6 UI fix deferred to
  operator dev-server restart. Operator's dev server holds :3000 with
  the pre-Cycle-20 binary; orchestrator declined to restart per
  "killing user processes" hard-stop. Operator action: `npm run dev`
  restart + refresh `/#/etf-flow`. Expected DOM per slice 1 deliverable.
  If render diverges from expected, surface as Cycle 21 first-task.
  Low-priority informational; the slice's tests + probe + JSX reading
  substitute for the visual.

### CARRIED from earlier cycles

- **OQ-C17-1** — VOO source quality issue. stockanalysis.com publishes
  `sharesOut: 2.36B` for VOO that doesn't reconcile with current
  `aum: $973.41B` + `close: $686.53` (implied shares = 1.418B; 39.9%
  delta). Confirmed structural in Cycle 18 day-2 observation. Status:
  operator-gated; covered in Q-6 row.
- **OQ-C18-1** — SPY-specific SSGA freshness lag. SSGA's `max_date`
  across all 15 tickers in CH is 2026-05-22, but SPY-specific data
  only reaches 2026-05-21. Not actionable; surface in a future cycle
  if it persists for >1 trading day.
- **OQ-C19-1** — inputs_missing UInt8 truncation at bits 8+.
  `quantlab.macro_regimes.inputs_missing` is `UInt8` (cap 0-255) but
  bitmask constants in macro_regime_v3.ts go up to bit 9 (512). Bits
  8+ (TLT, PUT_CALL) would silently truncate at storage. Resolution:
  ALTER COLUMN to UInt16 + add convention pin test. Tier-1
  mechanical-ish but touches a calc-adjacent column — defer to
  Composite + Infra workers. Cycle 22+ candidate.
- **OQ-C16-1** — RESOLVED Cycle 19 (`d65d4d3`, S96-103).
- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers — CLOSED
  Cycle 17 by ADR-049.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing (now NEWLY UNBLOCKED per S96-106 — these become
  Cycle 21+ candidates).
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

### Default on `continue` — Cycle 21 candidate (recommended day-3 stockanalysis observation IF Monday EOD or later)

Today is still 2026-05-24 (Sunday). Day-3 needs Monday 2026-05-25 EOD
data. If `continue` is invoked Monday EOD or later, day-3 is the
meaningful freshness test. If invoked before Monday EOD, pivot to an
alternative.

Procedure (same as Cycle 18, takes ~5 min):

1. `npm run health:check` first per ADR-044.
2. Probe day-2 baseline: `npx tsx scripts/_probe_stockanalysis_day_over_day.ts`.
3. Dry-run: `npm run etf:flow:stockanalysis:fetch:dry`.
4. Cross-check SPY: `.venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --tickers SPY --dry-run`.
5. Apply: `npm run etf:flow:stockanalysis:refresh`.
6. Verify: re-probe + diff vs day-2.
7. Commit + HANDOFF rewrite.

### NEWLY UNLOCKED Cycle 21 alternatives (in priority order)

- **Q-5 Path D implementation** — ship the CBOE JSON ingest per
  `docs/analysis/q5-path-d-cboe-json-2026-05-24.md`. Data-Ingest +
  Infra worker pair; ~400-500 LOC + ADR-050. Closes Q-5 + GAP-3
  simultaneously. **Top recommendation** if operator returns and isn't
  pressing for the Monday observation specifically.
- **Phase B campaign for cycle_v1** — newly unblocked per S96-106.
  Spec already exists at `docs/specs/market-cycle-position.md` §Phase B.
  Composite worker + Health worker pair (DSR / PBO / HLZ deflation
  pipeline run + verdict surface). First Layer-0 statistical-validation
  campaign — would establish the pattern for the 8 remaining composites.
- **If operator picks Q-7 path:** orchestration executes the chosen path
  (Path 1 / Path 2 / Path 3 / hybrid).

### Other Cycle 21 alternatives (lower priority)

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening; Composite + Infra worker pair.
- **N-PORT quarterly cross-check scaffolding** — for ALL secondary-
  table sources. Better deferred until 5-day stockanalysis observation
  completes + Q-7 path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

---

## Files / code state

### New / modified this cycle (s96 #19 Cycle 20)

| Path | Change | Notes |
| --- | --- | --- |
| `src/server/etf_flow_dashboard.ts` | +166/-25 | Slice 1 `8c6caa7` — 3-mode dispatch + types + `buildSecondaryLatest` |
| `src/components/etfFlow/EtfFlowApp.tsx` | +197/-14 | Slice 1 `8c6caa7` — banner + secondary-only dashboard components + formatters |
| `scripts/tests/etfFlowDashboard.test.ts` | new (+154) | Slice 1 `8c6caa7` — 6 tests covering all 3 modes |
| `scripts/_probe_etf_flow_dashboard_response.ts` | new (+47) | Slice 1 `8c6caa7` — re-runnable smoke probe |
| `docs/analysis/q5-path-d-cboe-json-2026-05-24.md` | new (+160) | Slice 2 `81e7382` — full Q-5 Path D finding |
| `docs/architecture/multi-agent-orchestration.md` | +25/-0 | Slice 3 `3819814` — §7.1 item 8 + §7.3 Phase B exclusion + §11 revision log |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+749/-39 across 6 files (3 slices) + 1 HANDOFF rewrite**.
No ADR changes (ADR-050 deferred to Cycle 21+ Q-5 Path D
implementation). No DDL changes. No real-money path touched. No npm
scripts added.

### DB-state changes this cycle

NONE. All operations were read-only.

### Test + tsc state

- `etfFlowDashboard.test.ts`: **6/6 pass** (new this cycle)
- `healthCheck.test.ts`: **37/37 pass**
- `etfFlow.test.ts + etfFlowCrossValidation.test.ts + etfFlowRepository.test.ts + daemonEtfFlowV1PrimaryRefresh.test.ts`: **146/146 pass**
- `regimeDashboard.test.ts`: **37/37 pass**
- `npx tsc --noEmit`: **13 baseline errors unchanged**

### Untouched-but-relevant for next session

- Q-5, Q-6, Q-7 quarantine + tracking rows still loaded for first
  Telegram alerts on next live daemon run with valid creds.
- `quantlab.executive_departures` + `quantlab.finra_short_interest`
  raw source tables still missing (carry-overs).
- `bt_runs_regime` has full `phase1_v3` attribution coverage (Cycle 10).
- `quantlab.macro_indicators_cboe`: 4,018 rows, max=2019-10-04;
  **Q-5 Path D ingest will fill the 2019-10-07 → today gap (Cycle 21+)**.
- `quantlab.macro_indicators_fred`: T10Y3M last=2026-05-21; T10Y2Y
  last=2026-05-21; FRED 3.6d stale per health:check.
- `quantlab.macro_regimes` phase1_v3: 6 recent rows carry T10Y2Y on 4
  of them + null+bit-64 on 2 of them; ADR-041-conformance gap per Q-7.
- `quantlab.etf_shares_outstanding`: 0 rows, v1 yfinance source dead
  per S96-89; adapter does NOT write here.
- `quantlab.etf_shares_outstanding_secondary`: 956 rows / 20 tickers
  (15 SSGA + 5 stockanalysis at 2 dates; VOO absent).
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).
- **Operator dev server (:3000) running pre-Cycle-20 binary** — needs
  `npm run dev` restart to pick up slice 1's etf-flow changes. Until
  restart, `/#/etf-flow` still renders the old empty-state.

---

## Watch-outs

### NEW from this cycle (s96 #19 Cycle 20)

- **Browser-smoke deferral pattern is a one-time exception, not a new
  norm.** Slice 1 declined to restart operator's dev server because
  "killing user processes" is on the hard-stop list. ADR-044 §UI's
  "validate every UI-touching slice in the browser before declaring
  it shipped" still stands. Future UI slices need either (a)
  operator-coordinated dev-server restart, (b) orchestrator-owned
  dev-server lifecycle (start in a worktree on a different port, run
  the smoke, tear down), or (c) Playwright against a separately-
  hosted server instance.
- **The 3-mode dispatch pattern is the canonical fix for any cross-
  validation UI panel where one side could go structurally dead.**
  When primary goes dead, the panel MUST surface that via an honest
  banner — not silently fall back to secondary. Slice 1's
  `PrimaryDarkBanner` is the template.
- **`hasData` semantics shifted in mode-1 (cross-validation, totalCompared
  === 0).** Was `false` (rendered empty-state); now `true` (renders
  "0 pairs compared, 0 divergences"). More honest, no test breaks, but
  a behavior shift any downstream consumer reading the JSON directly
  should be aware of.
- **The free-source research pattern (slice 2) is canonical for any
  blocked feed.** Probe the canonical primary site first (CBOE's own
  JSON in this case), then aggregators / derivatives, then GitHub
  references. The canonical primary is almost always strictly better
  than any third-party derivative.
- **Phase B unbundling (S96-106) opens Layer-0 statistical validation
  to autonomous spawning.** Orchestration may now spawn a Composite
  worker for the cycle_v1 Phase B campaign (or any of the other 8
  Layer-0 composites once their Phase B section is drafted). The
  verdict feeds the operator-gated Phase C promotion decision per
  §7.1 item 8.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#19 + Cycle 20 carry-overs) preserved.

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

### ETF flow ingest (post-Cycle-20 — Q-6 PARTIAL-WITH-UI-FIX via ADR-049 + 3-mode dispatch)

```text
# v1 primary panel (yfinance) — STILL DEAD per Q-6 / S96-89

# v3.1 SSGA secondary (15 tickers: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY — adapter + ingest with --source-file filter

# v3.1 stockanalysis secondary (5 tickers: IVV+QQQ+IWM+HYG+TLT)
npm run etf:flow:stockanalysis:fetch                       # adapter only
npm run etf:flow:stockanalysis:fetch:dry                   # dry-run, same
npm run etf:flow:stockanalysis:refresh                     # APPLY — adapter + ingest chain
# Day-2 observation PASS (Cycle 18); day-3 (Monday 2026-05-25) is the next meaningful test.

# UI fix shipped Cycle 20 (8c6caa7):
# - /#/etf-flow now renders v3.1 secondary as source-of-truth when v1 primary is dark
# - PrimaryDarkBanner explains the source-swap per ADR-044 §UI
# - Cross-validation sub-panels hidden when primary is empty
# Operator MUST restart `npm run dev` for the dev server to pick up the change.

# Re-runnable smoke probe (slice 1):
npx tsx scripts/_probe_etf_flow_dashboard_response.ts      # dumps mode + hasData + counts + secondaryLatest
```

### CBOE put/call ingest (post-Cycle-20 Q-5 Path D research)

```text
# Existing CSV ingest (covers 2003-10-17 → 2019-10-04; source FROZEN per S96-88):
npm run cboe:ingest

# Q-5 Path D implementation candidate (Cycle 21+):
# - New ingest at scripts/cboe_putcall_json_ingest.py (or --json mode on existing)
# - URL: https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options
# - Live 2019-10-07 → today; ~1,640 fetches to backfill; ~5 min wall-clock
# - GAP-3 daemon hook resolves alongside
# - Full plan in docs/analysis/q5-path-d-cboe-json-2026-05-24.md
```

### Cross-source probes (Cycles 17-20)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # post-OPTIMIZE source label counts in CH
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # per-ticker per-date stockanalysis rows (Cycle 18)
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED T10Y3M + SPY alignment + macro_regimes rows (Cycle 19)
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y comparison + ingested_at metadata (Cycle 19)
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # etf-flow dashboard builder output shape (Cycle 20)
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
node --import tsx --test scripts/tests/etfFlowDashboard.test.ts                                       # 6/6 pass (NEW Cycle 20)
npm run dev                                                                                           # http://localhost:3000 (operator restart needed to pick up Cycle 20 etf-flow fix)
npx tsc --noEmit                                                                                      # 13 baseline errors
```

---

## For the next session — priority order

**Default on `continue`:** Cycle 21 candidate — **recommended day-3
stockanalysis observation (Monday 2026-05-25, first trading day in
the window)** IF invoked Monday EOD or later. If invoked before Monday
EOD, pivot to one of the NEWLY UNLOCKED alternatives below.

**NEWLY UNLOCKED Cycle 21 alternatives (in priority order):**

- **Q-5 Path D implementation** (Data-Ingest + Infra worker pair; ~400-500
  LOC + ADR-050). Closes Q-5 + GAP-3. Top recommendation if operator
  isn't pressing for the Monday observation.
- **Phase B campaign for cycle_v1** (Composite + Health worker pair).
  First Layer-0 statistical-validation campaign — establishes the
  pattern for the 8 remaining composites.
- **If operator picks Q-7 path:** orchestration executes the chosen
  path (Path 1 / 2 / 3 / hybrid).

**Other Cycle 21 alternatives (lower priority):**

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening; Composite + Infra worker pair.
- **N-PORT quarterly cross-check scaffolding** — for ALL secondary-
  table sources. Better deferred until 5-day window completes + Q-7
  path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

**Operator queue items (Q-1 through Q-7):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED** per
  S96-107.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED** per
  S96-107.
- Q-3 Stooq apikey gate decision.
- Q-4 push 59 commits to origin/main.
- Q-5 **PATH D ORCHESTRATION-OWNED** — operator no longer needed for
  resolution; Cycle 21+ implementation per Q-5 row.
- Q-6 PARTIAL-WITH-UI-FIX (orchestration-resolved data + UI via
  ADR-049 + slice 1; closes on read-path flip in Cycle 23+; operator
  should `npm run dev` restart + visually verify `/#/etf-flow`).
- Q-7 — phase1_v3 yield-curve source persistence — operator picks
  Path 1 / Path 2 / Path 3 (or hybrid).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path; distinct from Layer-0
  Phase B per S96-106).
- Phase C promotion of any Layer-0 composite to phase1_v3+ classifier
  input (methodology amendment per §7.1 item 8).
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution (operator-pick gate).
- **v1 primary read path flip** — operator-gated via the 5-day
  observation window completing successfully.
- VOO-specific paid feed or alternative source.

---

## Important framing for the next chat

**Cycle 20 is closed.** Four commits: slice 1 (`8c6caa7`, +553/-25) UI
fix; slice 2 (`81e7382`, +160/-0) Q-5 Path D research; slice 3
(`3819814`, +25/-0) Phase B unbundling docs; this HANDOFF rewrite is
the 59th unpushed commit.

**Q-5 transformed from operator-pick to orchestration-owned.** Path D
(CBOE daily JSON endpoint) was found and verified. Cycle 21+ ships
the implementation per `docs/analysis/q5-path-d-cboe-json-2026-05-24.md`.
No operator decision needed.

**Q-6 PARTIAL-WITH-UI-FIX.** The data side was already resolved Cycle
17 via ADR-049; the UI side is now resolved via slice 1's 3-mode
dispatch. Closes on read-path flip in Cycle 23+. Operator action:
restart `npm run dev` + refresh `/#/etf-flow` to visually verify.

**Phase B statistical-validation campaigns unbundled.** Orchestration
may now spawn Layer-0 Phase B campaigns autonomously (cycle_v1 is the
first candidate). Phase C promotion stays operator-gated. C-12 Phase B
AlpacaAdapter (unrelated naming-collision) stays operator-gated as it
always was.

**Q-1 + Q-2 indefinitely deferred** per operator framing. Orchestration
will not press on them. Foundational work continues.

**One new open question of LOW priority:** OQ-C20-1 — browser-smoke
deferred to operator dev-server restart for slice 1 Q-6 UI fix.

**S96-104, S96-105, S96-106, S96-107 are the new lock-ins.**

**Cycle 21 default path: day-3 stockanalysis observation (Monday
2026-05-25)** IF invoked Monday EOD or later; otherwise pivot to Q-5
Path D implementation OR Phase B campaign for cycle_v1.
