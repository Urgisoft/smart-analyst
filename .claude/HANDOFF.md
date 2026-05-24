# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #19 — **Cycle 19 of multi-agent
orchestration executed**. Operator typed `continue` from Cycle 18 close.
HANDOFF default was **day-3 stockanalysis observation (Monday 2026-05-25)**,
but day-3 is calendar-blocked — today is still Sunday 2026-05-24 and day-3
needs Monday's EOD data. Per the listed alternatives, orchestration
pivoted to the next-listed alternative: **OQ-C16-1 FRED→T10Y3M
same-day-alignment probe**, a pure-investigation slice that Cycle 16
had recommended as a 10-15 min closure. **The probe falsified Cycle
16's hypothesis** — what looked like graceful-degradation under
FRED-stale turned out to be a real **Tier-2 correctness issue per
ADR-044**: macro_regimes.yield_curve_value for trade_dates 2026-05-15..
2026-05-21 carries T10Y2Y values, not the T10Y3M required by ADR-041
(Accepted 2026-05-19). Two compounding mechanisms produce the
wrong-source persistence: (1) **code-change race** — the T10Y2Y →
T10Y3M loader call shipped in commit `4406674` on 2026-05-21 21:42 MDT
(~ 2026-05-22 03:42 UTC); rows ingested before that commit are stuck
under T10Y2Y because the one-shot classifier-today daemon never
re-classifies; (2) **late-FRED race for 2026-05-20** — daemon ran
08:02 MDT before FRED's EOD publish (~18:00 ET); row written null +
bit 64, never refreshed. The 2026-05-22 row IS genuine graceful-
degradation (FRED has neither T10Y3M nor T10Y2Y for 2026-05-22 yet —
3.5d FRED stale per `npm run health:check`). Orchestration does NOT
auto-fix per ADR-044 ("never auto-fix calculation logic ... ADR-ratified
design choices"). Finding surfaced to operator queue as Q-7 with three
resolution paths (narrow re-classify / daemon refresh-stale loop /
daemon timing shift); orchestration recommends Path 1 + Path 2
follow-up. Full evidence + downstream consumer impact + side
observation (inputs_missing UInt8 truncation at bits 8+) in
`docs/analysis/fred-t10y3m-alignment-2026-05-24.md`. **Net 55 unpushed
commits** on top of `origin/main` (`c0cda7c`) after this HANDOFF
rewrite (was 53 at Cycle 18 close · +1 slice 1 (d65d4d3) = 54 · +1
HANDOFF = 55). **Pre-merge gate locally verified:** `npx tsc --noEmit`
returns 13 baseline errors unchanged; `scripts/tests/healthCheck.test.ts`
37/37 pass. **NEXT default on `continue`:** Cycle 20 candidate — **day-3
stockanalysis observation (Monday 2026-05-25 — first trading day in
the window)**, the originally-planned Cycle 19 default deferred by 1
day. Alternatives: (b) operator-picks Q-7 path → orchestration executes
the chosen path; (c) N-PORT quarterly cross-check scaffolding;
(d) drift remediation.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | OPEN — operator-defined timing |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | OPEN — operator drafting |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 55 unpushed commits to origin/main (Cycle 19 slice 1 + this HANDOFF is the 55th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. **Cycle 17 resolution via ADR-049 (stockanalysis.com free-aggregator scrape; 5 of 6 non-SSGA tickers restored: IVV/QQQ/IWM/HYG/TLT; VOO observationally dark pending source repair).** ADR-048 (path-B universe-shrink) marked **Superseded** but preserved on disk as fallback. **Day-2 observation (Cycle 18) PASS — weekend byte-identical baseline established; day-3 (Monday) is the meaningful freshness test.** **Status: PARTIAL** — methodology committed via ADR-049 Slice 1; the 5-day observation window + the v1-primary-read-path flip wait for the follow-up cycle. Operator action no longer required unless (a) SA proves unreliable in the observation window (revert to ADR-048 path-B), (b) operator wants paid feed for VOO specifically, or (c) operator wants the row closed before the read-path flip ships. | s96 #17 Cycle 12-17 (S96-89..S96-101); Cycle 18 (S96-102, day-2 obs PASS) | PARTIAL — orchestration-resolved; closes on read-path flip (Cycle 23+) |
| **Q-7 (NEW)** | **phase1_v3 yield-curve source persistence — macro_regimes.yield_curve_value carries T10Y2Y on trade_dates 2026-05-15..2026-05-21; ADR-041 (Accepted 2026-05-19) mandates T10Y3M. Three resolution paths: (1) narrow re-classify post-ADR-041 dates only (mechanical, no baseline shift); (2) daemon refresh-stale loop (architectural, closes root cause for future code changes + late-arriving data); (3) daemon timing shift after FRED EOD publish (partial fix to one of two mechanisms). Orchestration's recommendation: Path 1 immediate cleanup + Path 2 architectural follow-up cycle.** Full detail in `docs/analysis/fred-t10y3m-alignment-2026-05-24.md`. | s96 #18 Cycle 19 — OQ-C16-1 probe falsified Cycle 16 hypothesis; finding Tier-2 per ADR-044 + ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |

**That's the entire queue.** Q-4 count incremented from 53 → 55. Q-5 +
Q-6 unchanged. **Q-7 NEW** — surfaced by Cycle 19's probe.

---

## What this cycle delivered (s96 #18 Cycle 19)

### Slice 1 (`d65d4d3`) — OQ-C16-1 probe + Tier-2 finding surfaced

**Goal:** Execute the Cycle 16-recommended pure-investigation probe of
FRED→T10Y3M same-day alignment to resolve OQ-C16-1. Day-3 stockanalysis
observation (the HANDOFF default) was calendar-blocked (today is still
Sunday 2026-05-24; day-3 needs Monday's EOD data), so orchestration
pivoted to the next listed alternative.

**Procedure:**

1. Per ADR-044 mandate, ran `npm run health:check` first. Snapshot
   matched pre-Cycle-19 state — no NEW Tier-2 items at session start.
2. Read the classifier loader at
   [src/server/macro_regime_v3.ts:770-779](src/server/macro_regime_v3.ts#L770-L779)
   and [:1004](src/server/macro_regime_v3.ts#L1004) to map alignment
   logic: the loader iterates SPY trading dates and pulls T10Y3M via
   `bundle.t10y3mByDate.get(dt)` — strict same-day lookup, no
   carry-forward.
3. Wrote `scripts/_probe_fred_t10y3m_alignment.ts` to probe (a) FRED
   T10Y3M state, (b) recent SPY trading dates, (c) alignment diff
   via LEFT JOIN, (d) macro_regimes rows in the suspect window.
4. Discovered macro_regimes values didn't match T10Y3M; wrote
   `scripts/_probe_t10y2y_compare.ts` to check the T10Y2Y hypothesis.
5. Confirmed T10Y2Y values matched persisted yield_curve_value 1:1
   for 4 of 6 dates; the other 2 are null with bit 64 set.
6. Cross-referenced ingested_at against `git log --oneline -S
   "loadFredSeries(ch, 'T10Y3M'" --follow src/server/macro_regime_v3.ts`
   → commit `4406674` (s95 #5) on 2026-05-21 21:42 MDT changed the
   loader from T10Y2Y to T10Y3M.
7. Built the full per-row table mapping (trade_date × ingested_at ×
   code-at-classify × source-matched). Wrote
   `docs/analysis/fred-t10y3m-alignment-2026-05-24.md` with evidence,
   root cause, downstream consumer impact, three resolution paths,
   and a side observation on inputs_missing UInt8 truncation.

**Key finding (verbatim from analysis doc):**

> Cycle 16's "graceful-degradation under FRED-stale" hypothesis was
> wrong. macro_regimes.yield_curve_value for trade_dates 2026-05-15..
> 2026-05-21 carries T10Y2Y values, not T10Y3M. ADR-041 (Accepted
> 2026-05-19) mandates T10Y3M. The classifier-today daemon is
> one-shot per latest date — once a row exists for (trade_date,
> classifier_version) it is never re-written, even after a code
> change or after late-arriving FRED data lands.

**Per-row source mapping (full evidence in analysis doc):**

| trade_date | ingested_at (UTC) | code at classify | yield_curve_value | matches T10Y2Y? | matches T10Y3M? |
| --- | --- | --- | --- | --- | --- |
| 2026-05-15 | 2026-05-18 04:18 | OLD | 0.5 | YES | NO (T10Y3M=0.9) |
| 2026-05-18 | 2026-05-18 22:25 | OLD | 0.54 | YES | NO (T10Y3M=0.93) |
| 2026-05-19 | 2026-05-19 23:40 | OLD | 0.54 | YES | NO (T10Y3M=1.0) |
| **2026-05-20** | 2026-05-20 14:02 | OLD | **null + bit 64** | NO (race) | NO (race) |
| 2026-05-21 | 2026-05-22 01:25 | OLD (commit was 03:42 UTC) | 0.49 | YES | NO (T10Y3M=0.89) |
| 2026-05-22 | 2026-05-22 14:45 | NEW | null + bit 64 | n/a | YES (FRED truly stale) |

**Firing-signal impact (limited at this moment):** Both T10Y2Y and
T10Y3M are positive in the affected window, so `yield_curve_inverted`
fires the same (0 = not inverted) regardless of source. The
diagnostic counter `yield_curve_inversion_days_20d` on these rows is
computed from T10Y2Y not T10Y3M. **Forward inversions** (when one
series inverts before the other) would produce different firing
decisions on source-mix rows.

**Downstream consumers reading the stale `yield_curve_value`:**
`src/server/regime_dashboard.ts` (the `/#/regime` UI TodayPanel) +
`src/server/operator_brief_render.ts` (morning brief). NOT affected:
`src/server/cycle_position.ts` + `src/server/cross_asset_signals.ts`
both read `quantlab.macro_indicators_fred` directly for T10Y3M.

**Side observation (separate from OQ-C16-1):**
`quantlab.macro_regimes.inputs_missing` is `UInt8` at
[src/server/clickhouse.ts:712](src/server/clickhouse.ts#L712), but the
bitmask constants in macro_regime_v3.ts go up to bit 9 (512). Bits 8+
(TLT, PUT_CALL) would silently truncate at storage. Hasn't fired in
practice yet (T10Y3M bit 6 + BREADTH bit 4 dominate observed values),
but a row with TLT-missing or PUT_CALL-missing would lose those bits.
Tracked in the analysis doc; not actioned this cycle.

**Files in slice 1 (commit `d65d4d3`, +320/-0):**

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/_probe_fred_t10y3m_alignment.ts` | new (+91) | Re-runnable probe for FRED T10Y3M + SPY alignment + macro_regimes state |
| `scripts/_probe_t10y2y_compare.ts` | new (+38) | T10Y2Y comparison + ingested_at metadata probe |
| `docs/analysis/fred-t10y3m-alignment-2026-05-24.md` | new (+191) | Full finding: TL;DR, evidence, root cause, three resolution paths, side observation |

**Database-state changes this cycle:** NONE. All operations were
read-only.

### Cycle 19 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (§3.1 codified category 3 — pure-investigation; all 6 gates green: no real-money path / no DDL / no paid-data / tsc 13 baseline preserved / healthCheck convention pins 37/37 green / no methodology canon committed since the finding is SURFACED to operator queue, NOT decided) | Slice 1 — OQ-C16-1 probe + Tier-2 finding surface | AUTO-APPROVE (no critic spawn) | All gates green; commit `d65d4d3` |

**Decision: no critic spawn for slice 1.** Pure-investigation category
3 per §3.1. The finding's resolution paths are surfaced to the operator
queue (Q-7) per ADR-044's "never auto-fix calculation logic ...
ADR-ratified design choices" rule — orchestration explicitly defers
the methodology decision to operator, so no critic gate is needed
between probe + surface.

### Verification gates at cycle close

```text
git status                                                          # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                                            # 55 commits ahead (was 53)
npx tsc --noEmit                                                     # 13 baseline errors unchanged
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass (0 fail / 0 skip)
git worktree list                                                    # main only (no worker spawned)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail (last full run Cycle 14 — no new TS code in Cycles 17-19 modifies the broader suite)
test_etf_flow_stockanalysis_adapter.py (Cycle 17)     16/16 pass
test_etf_flow_issuer_csv_ingest.py (Cycle 17)         21/21 pass
test_etf_flow_ssga_spdr_adapter.py                    18/18 pass
test_cboe_putcall_ingest.py                           16/16 pass
healthCheck.test.ts                                   37/37 pass
etfFlow / etfFlowCrossValidation / etfFlowRepository /
daemonEtfFlowV1PrimaryRefresh                         146/146 pass (Cycle 14 baseline preserved)
migrateCreateHealthQuarantine / healthQuarantine       57/57 pass
gicsSectorRepositoryHelper.test.ts                    13/16 pass + 3 skip
btRunsRegime.test.ts                                  19/19 pass
test_train_meta_label.py                              33/33 pass
regimeDashboard.test.ts                               37/37 pass
```

### Post-Cycle-19 health snapshot

No new Tier-2 quarantine ROWS inserted (the Q-7 finding is surfaced to
operator queue + analysis doc; quarantine-row insertion is one of the
operator-pick paths under Q-7 — orchestration does not auto-insert a
calc-logic quarantine row per ADR-044). `quantlab.health_quarantine`
still 2 rows total (Q-5 + Q-6, both `accepted-as-warning`).
`quantlab.etf_shares_outstanding_secondary` unchanged at 3,766 rows /
20 tickers (15 SSGA + 5 stockanalysis at 2 dates; VOO absent).

### Push state

- `origin/main` at `c0cda7c`; **55 unpushed commits** after this
  HANDOFF rewrite (was 53 at Cycle 18 close · +1 slice 1 (d65d4d3) =
  54 · +1 HANDOFF = 55).
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
| **Cycle 19 — OQ-C16-1 probe → Q-7 surfaced** | **✓ s96 #18 (S96-103)** |
| Cycle 20 — day-3 stockanalysis observation (Monday — first trading day) | ☐ NEXT default (recommended) |
| Cycle 20-alt — Q-7 Path 1/2/3 execution (operator-gated) | ☐ alternative once operator picks Q-7 path |
| Cycle 20-alt — N-PORT quarterly cross-check scaffolding | ☐ alternative |
| Cycle 23+ — v1 primary read path flip (after 5-day window passes) | ⏸ blocked on 5-day observation completion |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation completion |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ⛔ low priority — source frozen per S96-88 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ⛔ EMPIRICALLY DEAD — Cycle 11 |
| Composite worker (Q-5-blocked phase1_v3 re-classify) | ⏸ blocked on Q-5 pick |
| Composite worker (Q-6-blocked etf-flow read-path flip) | ⏸ blocked on 5-day observation completion |
| **Q-7-blocked phase1_v3 yield-curve source persistence resolution** | **⏸ blocked on Q-7 pick** |
| Per-issuer free-data adapters (iShares + Vanguard + Invesco) | ⛔ EMPIRICALLY EXPENSIVE — Cycle 14 (S96-93); requires Playwright; not authorized + no longer needed (ADR-049 fills the gap differently) |
| VOO source repair | ⛔ ESCALATED — operator-gated (paid feed OR wait for SA to fix OR accept observational gap) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #18 (Cycle 19 of multi-agent orchestration)

**S96-103. OQ-C16-1 is RESOLVED with a falsified Cycle 16 hypothesis;
the real finding is a Tier-2 correctness issue on macro_regimes
yield-curve source persistence (Q-7 NEW operator queue row).** `Why:`
Cycle 16's smoke-test surface (`yield_curve_value: null` + bit 64 on
the 2026-05-22 macro_regimes row) was predicted to be graceful-
degradation under FRED-stale. Cycle 19's probe found this prediction
was correct ONLY for 2026-05-22 — FRED genuinely has no T10Y3M
observation for that date yet (max in CH = 2026-05-21). But the same
probe surfaced that the OTHER recent macro_regimes rows
(2026-05-15..2026-05-21) carry T10Y2Y values labeled as T10Y3M's
column, violating ADR-041's mandate. Root cause is a combination of
the T10Y2Y → T10Y3M code change shipping in commit `4406674` on
2026-05-21 21:42 MDT (so rows ingested before that commit are stuck
under the old source) PLUS the classifier-today daemon being one-shot
per latest date (so once a row exists, it's never refreshed even when
the underlying loader code OR upstream data changes). A separate
late-FRED race for 2026-05-20 (daemon ran 08:02 MDT before FRED's
~18:00 ET publish) produces a null + bit 64 that never got refreshed.
`How to apply:` (1) The smoke-test interpretation rule for future
cycles updates to: a null + bit 64 on the latest macro_regimes row is
suspicious until cross-checked against (a) `quantlab.macro_indicators_fred`
for T10Y3M's max(observation_date) AND (b) the row's `ingested_at` vs
the current loader-code commit time. (2) The Cycle 16 framing "likely
no-op; expected behavior under FRED-stale > 1 business day" is RETIRED
— it conflates two distinct mechanisms (genuine FRED-stale vs late-FRED
race + code-change race) that produce the same surface symptom but
have different root causes and different fix paths. (3) Probe scripts
(`_probe_fred_t10y3m_alignment.ts` + `_probe_t10y2y_compare.ts`) are
preserved on disk; re-runnable as smoke checks for any future FRED→
macro_regimes alignment question. (4) Per ADR-044, orchestration does
NOT auto-fix calc logic / ADR-ratified design — the finding is
surfaced as Q-7 with three resolution paths for operator pick; once
operator picks, orchestration executes via a follow-up cycle.

**Carry-overs (still in force):** S96-1..S96-102; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### CARRIED from earlier cycles

- **OQ-C17-1** — VOO source quality issue. stockanalysis.com publishes
  `sharesOut: 2.36B` for VOO that doesn't reconcile with current
  `aum: $973.41B` + `close: $686.53` (implied shares = 1.418B; 39.9%
  delta). Cycle 18 confirmed this is NOT a transient — same exact
  failure mode reproduces day-over-day. Hypotheses: (a) SA pulls
  sharesOut from a different vendor than aum/close and that vendor's
  data is stale for VOO specifically; (b) Vanguard reports sharesOut
  in a different unit/basis. Verifying requires either a paid feed
  comparison OR waiting for SEC N-PORT-P quarterly cross-check (next
  filing ~late-Aug 2026 with ~Feb 2026 data). Status: operator-gated;
  covered in Q-6 row.
- **OQ-C18-1** — SPY-specific SSGA freshness lag. SSGA's `max_date`
  across all 15 tickers in CH is 2026-05-22, but SPY-specific data
  only reaches 2026-05-21. Could indicate per-ticker freshness lag on
  the SSGA refresh, or could be a one-time skip on Thursday. Not
  actionable this cycle; surface in a future cycle if it persists for
  >1 trading day.
- **OQ-C19-1 (NEW)** — inputs_missing UInt8 truncation at bits 8+.
  `quantlab.macro_regimes.inputs_missing` is `UInt8` (cap 0-255) but
  bitmask constants in macro_regime_v3.ts go up to bit 9 (512). Bits
  8+ (TLT = 256, PUT_CALL = 512) would silently truncate at storage.
  Hasn't fired in practice yet (T10Y3M bit 6 + BREADTH bit 4 dominate
  observed values). Independent of Q-7 but related (would tighten the
  inputs_missing column's reliability as a debug signal). Resolution:
  ALTER COLUMN to UInt16 + add convention pin test. Tier-1
  mechanical-ish but touches a calc-adjacent column → defer to
  Composite + Infra workers, NOT an orchestrator self-edit. Cycle 21+
  candidate.
- **OQ-C16-1** — RESOLVED in Cycle 19 by `d65d4d3` (S96-103). Cycle
  16's hypothesis was falsified; the surface symptom turned out to be
  a real Tier-2 correctness issue surfaced as Q-7.
- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers — CLOSED
  Cycle 17 by ADR-049.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers — CLOSED Cycle 17 by ADR-049.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused (operator-gated).
- CBOE DataShop subscription — Q-5 path (A).
- Capital-deployment-ramp ADR — Q-2.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent (operator-call).
- Phase 2 v2 — deferred per S96-71.
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence.

---

## Next stage

### Default on `continue` — Cycle 20 candidate (recommended day-3 stockanalysis observation)

Today is still 2026-05-24 (Sunday). Day-3 needs Monday 2026-05-25 EOD
data. If `continue` is invoked Monday EOD or later, day-3 is the
meaningful freshness test. Expected:

1. **shares**: should shift day-over-day for at least some tickers
   (creates/redeems happen daily on trading days; SSGA's history shows
   day-over-day shifts of ~3M shares for SPY are typical for large
   liquid ETFs).
2. **close**: should advance to Monday's EOD value (not Friday's).
3. **aum (persisted)**: should grow consistent with both shares and
   close shifts.
4. **VOO**: should reproduce the 39.9% consistency failure if it's
   truly structural; if it suddenly passes, that's signal SA fixed
   their VOO sharesOut feed.
5. **SPY cross-check**: SSGA should also refresh Monday EOD (SSGA's
   daemon-cadence runs post-close); compare SA's SPY values to SSGA's
   fresh date=2026-05-25 row.

Procedure (same as Cycle 18, takes ~5 min):

1. `npm run health:check` first per ADR-044.
2. Probe day-2 baseline: `npx tsx scripts/_probe_stockanalysis_day_over_day.ts`.
3. Dry-run: `npm run etf:flow:stockanalysis:fetch:dry`.
4. Cross-check SPY: `.venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --tickers SPY --dry-run`.
5. Apply: `npm run etf:flow:stockanalysis:refresh`.
6. Verify: re-probe + diff vs day-2.
7. Commit + HANDOFF rewrite.

**Failure handling:** unchanged from Cycle 18.

### Alternative Cycle 20 candidates (in priority order if operator engaged)

- **If operator picks Q-7 path:** orchestration executes the chosen
  path in a dedicated cycle. Path 1 (narrow re-classify post-ADR-041
  dates only) is the lowest-blast-radius option and is the
  orchestration's recommendation for immediate cleanup. Path 2
  (daemon refresh-stale loop) is a follow-up architectural cycle that
  closes the root cause; recommendation is to do this AFTER Path 1.
  Path 3 (daemon timing shift) is a partial fix to one of two
  mechanisms and is the weakest standalone option.
- **N-PORT quarterly cross-check scaffolding.** Authoritative truth-
  check for ALL secondary-table sources. Substantial scope (~300-500
  LOC for EDGAR fetcher + reconciliation logic). Better deferred until
  the 5-day window completes + Q-7 path picked.
- **OQ-C19-1 inputs_missing UInt8 → UInt16.** Tier-1 mechanical
  schema widening + convention pin. NOT an orchestrator self-edit
  because it touches a calc-adjacent column under a quarantine-eligible
  ADR scope; defer to Composite + Infra worker pair.
- **Phase 2 v2 spec drafting.** Implementation deferred per S96-71.
- **Drift remediation.** Reactive.

---

## Files / code state

### New / modified this cycle (s96 #18 Cycle 19)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/_probe_fred_t10y3m_alignment.ts` | new (+91) | Slice 1 `d65d4d3` — re-runnable FRED→T10Y3M alignment probe |
| `scripts/_probe_t10y2y_compare.ts` | new (+38) | Slice 1 `d65d4d3` — T10Y2Y comparison + ingested_at metadata probe |
| `docs/analysis/fred-t10y3m-alignment-2026-05-24.md` | new (+191) | Slice 1 `d65d4d3` — full finding (TL;DR, evidence, root cause, three resolution paths, side observation) |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+320/-0 across 3 files (slice 1) + 1 HANDOFF rewrite**. No
ADR changes. No DDL changes. No real-money path touched. No production
code changed. No npm scripts added.

### DB-state changes this cycle

NONE. All operations were read-only.

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| `quantlab.macro_indicators_fred` | (read-only probe) | n/a | Probed T10Y3M + T10Y2Y for 2026-05-15..2026-05-21 |
| `quantlab.candles` | (read-only probe) | n/a | Probed SPY_USD recent trading dates |
| `quantlab.macro_regimes` | (read-only probe) | n/a | Probed phase1_v3 rows for 2026-05-15..2026-05-22 incl. ingested_at |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-7 surfaced to HANDOFF queue, NOT to quarantine table — operator-pick gate per ADR-044 + Q-7 row above |

### Test + tsc state

- `healthCheck.test.ts`: **37/37 pass**
- `npx tsc --noEmit`: **13 baseline errors unchanged**

### Untouched-but-relevant for next session

- Q-5, Q-6, Q-7 quarantine + tracking rows still loaded for first
  Telegram alerts on next live daemon run with valid creds.
- `quantlab.executive_departures` + `quantlab.finra_short_interest`
  raw source tables still missing (carry-overs).
- `bt_runs_regime` has full `phase1_v3` attribution coverage (Cycle 10).
- `quantlab.macro_indicators_cboe`: 4,018 rows, max=2019-10-04, source
  frozen per S96-88.
- `quantlab.macro_indicators_fred`: T10Y3M last=2026-05-21; T10Y2Y
  last=2026-05-21; FRED 3.5d stale per health:check.
- `quantlab.macro_regimes` phase1_v3: 6 recent rows carry T10Y2Y on 4
  of them + null+bit-64 on 2 of them; ADR-041-conformance gap per Q-7.
- `quantlab.etf_shares_outstanding`: 0 rows, v1 yfinance source dead
  per S96-89; adapter does NOT write here.
- `quantlab.etf_shares_outstanding_secondary`: 3,766 rows / 20 tickers
  (15 SSGA + 5 stockanalysis at 2 dates; VOO absent).
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #18 Cycle 19)

- **The classifier-today daemon is one-shot — code changes to the
  loader silently leave historical rows under the old source.** This
  is the architectural root cause behind Q-7 mechanism (1). Any future
  swap of an upstream series (T10Y2Y → T10Y3M was the latest; future
  examples could be a yield-curve series swap, a CBOE put/call URL
  swap that changes the canonical series name, a breadth-source
  fallback chain change) requires either an explicit re-backfill OR
  the architectural fix from Q-7 Path 2 (refresh-stale loop). Until
  Path 2 ships, ALL code changes to the macro classifier's loaders
  MUST be paired with an explicit re-backfill of post-ADR-acceptance
  rows OR the new-source intent must be flagged in the cycle's HANDOFF
  and docs/analysis for operator awareness.
- **The classifier-today daemon races FRED's EOD publish.** Mechanism
  (2) behind Q-7: daemon runs after NYSE close (~16:00 ET) but FRED
  publishes EOD T10Y3M / T10Y2Y at ~18:00 ET. Any morning-of-next-day
  classifier run will see the prior day's FRED data; any same-day
  evening classifier run could miss the same-day FRED publish. The
  Q-7 Path 3 (daemon timing shift after 18:00 ET) addresses this
  specific mechanism. Until then, the 2026-05-20 null+bit-64 row is
  the canonical example of this race.
- **Probe scripts in `scripts/_probe_*.ts` are reusable.** Two new
  ones added Cycle 19 (`_probe_fred_t10y3m_alignment.ts` +
  `_probe_t10y2y_compare.ts`). Cycle 18 added one
  (`_probe_stockanalysis_day_over_day.ts`). The pattern of writing
  small re-runnable read-only probes for investigation cycles is
  load-bearing — future cycles SHOULD continue this pattern rather
  than ad-hoc CH queries in conversation that vanish at cycle close.
- **Side observation OQ-C19-1 (inputs_missing UInt8 truncation).**
  The macro_regimes.inputs_missing column is UInt8 but bitmask
  constants go up to bit 9 (512). Bits 8+ would silently truncate.
  Hasn't fired but would silently corrupt the debug signal. A Tier-1
  schema widening + convention pin is the fix; defer to Composite +
  Infra worker pair when surfaced (Cycle 21+).

### Carried from earlier sessions

All prior watch-outs (s96 #1-#18 + Cycle 19 carry-overs) preserved.

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

### ETF flow ingest (post-Cycle-18 — Q-6 PARTIAL via ADR-049 + day-2 obs PASS)

```text
# v1 primary panel (yfinance) — STILL DEAD per Q-6 / S96-89
# Do NOT run this — kept for path-D re-activation if Yahoo restores
npm run etf:flow:ingest                                    # APPLY — 0/21 OK + S96-89 diagnostic + exit 1

# v3.1 SSGA secondary (15 tickers: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY — adapter + ingest with --source-file filter

# v3.1 stockanalysis secondary (5 tickers: IVV+QQQ+IWM+HYG+TLT)
npm run etf:flow:stockanalysis:fetch                       # adapter only (writes data/etf_flow_issuer_csv/stockanalysis.csv)
npm run etf:flow:stockanalysis:fetch:dry                   # dry-run, same
npm run etf:flow:stockanalysis:refresh                     # APPLY — adapter + ingest chain with --source-file filter
# Cycle 18 day-2 observation PASS — 5-day window now at day 2/5.
# Day-3 (Monday 2026-05-25) is the meaningful freshness test.
```

### CBOE put/call ingest (post-Cycle-11)

```text
npm run cboe:ingest                                                                  # fetches both totalpc.csv + totalpcarchive.csv
# S96-88 note: public file ends 2019-10-04; re-running does NOT advance max(observation_date).
```

### Quartz docs site

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080)
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # S96-78 CLOSED Cycle 10
```

### Cross-source probes (Cycle 17 + Cycle 18 + Cycle 19)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # post-OPTIMIZE source label counts in CH
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # per-ticker per-date stockanalysis rows (Cycle 18)
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED T10Y3M + SPY alignment + macro_regimes rows (Cycle 19)
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y comparison + ingested_at metadata (Cycle 19)
```

### SPY cross-check command (Cycle 17/18 pattern)

```text
.venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --tickers SPY --dry-run
# Compare output to SSGA latest SPY in CH:
#   SELECT ticker, date, shares, close, aum FROM quantlab.etf_shares_outstanding_secondary
#   FINAL WHERE ticker = 'SPY' AND source = 'ssga-spdr' ORDER BY date DESC LIMIT 3
```

### CI (Cycle 8 baseline)

```text
npx tsc --noEmit                                        # baseline ≤13 errors
npm test
pytest scripts/tests
# Workflow: .github/workflows/ci.yml (first CI run on push — Q-4)
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_stockanalysis_adapter.py -v             # 16/16 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py -v                # 21/21 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ssga_spdr_adapter.py -v                # 18/18 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors
```

### npm scripts touched this cycle

- (no changes — Cycle 19 added probe scripts only, no npm-script wiring)

---

## For the next session — priority order

**Default on `continue`:** Cycle 20 candidate — **recommended day-3
stockanalysis observation (Monday 2026-05-25, first trading day in
the window)**. Use the same procedure as Cycle 18; the meaningful test
is whether shares + close move appropriately for a trading day.

**Alternative Cycle 20 candidates:**

- **Day-3 stockanalysis observation** — see above (recommended).
- **If operator engaged Q-7 with a pick:** orchestration executes the
  chosen path (Path 1 / 2 / 3 / hybrid).
- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening; Composite + Infra worker pair.
- **N-PORT quarterly cross-check scaffolding** — for ALL
  secondary-table sources.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

**Calendar-gated (unchanged):**

- All Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (Q-1 through Q-7):**

- Q-1 first real-capital deployment.
- Q-2 capital-deployment-ramp ADR.
- Q-3 Stooq apikey gate decision.
- Q-4 push 55 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — A/B/C.
- Q-6 PARTIAL (orchestration-resolved via ADR-049; closes on read-path
  flip in Cycle 23+; VOO residual gap is operator-gated; Cycle 18
  day-2 obs PASS).
- **Q-7 NEW — phase1_v3 yield-curve source persistence — operator
  picks Path 1 / Path 2 / Path 3 (or hybrid). Recommendation: Path 1
  immediate cleanup + Path 2 architectural follow-up.**

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase B campaigns.
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-5-blocked work: phase1_v3 re-classify (Q-7 Path 1 is a NARROWER
  re-classify on post-ADR-041 dates only; still operator-gated).
- Phase 2 v2 plausibility-band probes.
- **v1 primary read path flip** — operator-gated via the 5-day
  observation window completing successfully.
- VOO-specific paid feed or alternative source.
- **Q-7 Path 1 / 2 / 3 execution** — operator-pick gate.

---

## Important framing for the next chat

**Cycle 19 is closed.** Two commits: slice 1 (`d65d4d3`, +320/-0)
added two probe scripts + a full analysis doc; this HANDOFF rewrite is
the 55th unpushed commit.

**Q-6 stays PARTIAL** (no change this cycle; the day-3 stockanalysis
observation is the next default).

**Q-7 is NEW.** The probe falsified Cycle 16's hypothesis and surfaced
a real Tier-2 correctness issue on phase1_v3's yield-curve source
persistence. Orchestration recommends Path 1 immediate + Path 2
follow-up. Operator decision required before resolution cycle ships.

**One new open question of LOW priority:** OQ-C19-1 — inputs_missing
UInt8 truncation at bits 8+. Hasn't fired in practice. Defer to
Composite + Infra worker pair.

**OQ-C16-1 is CLOSED** — but the closure outcome was "Cycle 16's
prediction was wrong, this IS a real issue." The smoke-test
interpretation rule for future cycles updates to: a null + bit 64
suspicious until cross-checked against FRED max(observation_date) AND
row ingested_at vs current loader-code commit time.

**S96-103 is the new lock-in.** Future cycles encountering a
yield_curve_value anomaly on a macro_regimes row follow the
S96-103 cross-check pattern (FRED max + ingested_at vs commit time)
before assuming graceful-degradation.

**Cycle 20 recommended path: day-3 stockanalysis observation (Monday
trading day)** — this is the meaningful freshness test the entire
ADR-049 path depends on, originally Cycle 19's default but
calendar-blocked to Cycle 20.

**Backward compat preserved this cycle:**

1. **CH:** No DDL change. No row writes. Only reads.
2. **Type:** No type-system changes. tsc baseline 13 errors unchanged.
3. **Brief:** No render-side changes.
4. **Tests:** All previously-passing suites still pass; no new tests
   this cycle (probe scripts are read-only one-shots).
5. **Code behavior on existing surfaces:** No code changes other than
   the new probe scripts (read-only).
6. **Operator UX:**
   - `/#/etf-flow` unchanged.
   - `/#/health` quarantine queue still shows 2 rows.
   - `/#/regime` TodayPanel still renders `yield_curve_value` from
     macro_regimes — this is the surface where Q-7's wrong-source
     values appear today. Until operator picks Q-7 path, the panel
     shows T10Y2Y values labeled as the T10Y3M column.
   - `npm run health:check` output unchanged from Cycle 18.
   - **NEW:** operator can run `npx tsx
     scripts/_probe_fred_t10y3m_alignment.ts` to see the per-row
     source-mix table. Or `npx tsx
     scripts/_probe_t10y2y_compare.ts` to confirm the T10Y2Y match
     and see ingested_at metadata.

**The chain through s96 #19:**

```text
ALL S41-S96#18 WORK                                       ✓ as documented
S96 #18 Cycle 18 (day-2 stockanalysis obs PASS)           ✓ as documented (S96-102)
S96 #18 Cycle 19:
  • Slice 1 — OQ-C16-1 probe + Tier-2 finding surface
    AUTO-APPROVE  → +320/-0 (2 probe scripts + 1 analysis doc);
                    NO db writes; NO code changes; NO methodology
                    committed.
       PROBE
       FINDINGS   → (a) FRED T10Y3M max in CH = 2026-05-21 (FRED 3.5d
                    stale per health:check). (b) macro_regimes
                    yield_curve_value for 2026-05-15..2026-05-21 carries
                    T10Y2Y values; ADR-041 mandates T10Y3M; conformance
                    gap. (c) 2026-05-20 row null+bit64 even though FRED
                    has both T10Y3M=0.92 + T10Y2Y=0.53 — daemon ran
                    08:02 MDT before FRED's ~18:00 ET publish, never
                    refreshed. (d) 2026-05-22 row null+bit64 IS genuine
                    graceful-degradation. (e) Root cause: T10Y2Y →
                    T10Y3M code change shipped commit 4406674 on
                    2026-05-21 21:42 MDT, AND classifier-today daemon
                    is one-shot per latest date — rows never refresh
                    after a code change OR after late-arriving data.
       RESOLUTION → Q-7 NEW operator queue row with three paths
                    (narrow re-classify / refresh-stale loop / timing
                    shift); orchestration recommends Path 1 immediate +
                    Path 2 follow-up. NO auto-fix per ADR-044 ("never
                    auto-fix calc logic ... ADR-ratified design").
       SIDE
       OBS        → inputs_missing UInt8 truncation at bits 8+ tracked
                    as OQ-C19-1.
  + S96-103 (OQ-C16-1 resolved with falsified Cycle 16 hypothesis;
    real finding surfaced as Q-7 + tightened smoke-test interpretation
    rule for future cycles) lock-in
  + 2 commits: slice 1 (d65d4d3) + this HANDOFF rewrite
  + Zero downstream consumer behavior change on existing surfaces
  + Q-6 stays at PARTIAL (no change this cycle); Q-4 count 53 → 55
  + Q-7 NEW (phase1_v3 yield-curve source persistence)
  + OQ-C16-1 CLOSED; OQ-C19-1 (inputs_missing UInt8) NEW low-priority
  → DEFAULT NEXT: Cycle 20 candidate — RECOMMENDED day-3 stockanalysis
    observation (Monday 2026-05-25 — first trading day in the window),
    originally Cycle 19's default but calendar-blocked to Cycle 20.
    If operator returned in the interim with a Q-7 path pick,
    orchestration executes the chosen path instead.
```
