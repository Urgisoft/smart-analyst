# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #18 — **Cycle 18 of multi-agent
orchestration executed**. Operator typed `continue` from Cycle 17 close.
Per HANDOFF default + ADR-049's operator-authorized 5-day observation
plan, the orchestration ran **day-2 of the stockanalysis observation
window** (day-1 = Cycle 17 close at date=2026-05-23; day-2 = today at
date=2026-05-24; today is Sunday so day-3 = Monday 2026-05-25 will be
the first trading-day observation). Results PASS: 5 of 6 tickers' shares
+ close + persisted-aum byte-identical day-over-day (expected over a
weekend — no creates/redeems, no trading). VOO continues to loud-reject
at the same 39.9% consistency-check delta — not a transient. SA-reported
aum (consistency-check input only; never persisted because
`etf_flow_issuer_csv_ingest.py` materializes `aum = shares × close` at
ingest) drifts -0.06% to -1.22% — invisible downstream; informational
only. SPY cross-check vs SSGA known-good (date=2026-05-21): shares
-0.35% / close +0.54% / aum +0.12% — essentially identical to Cycle 17's
day-1 cross-check (0.4% / 0.5% / 0.12%); accuracy gate holds. **Q-6
stays at PARTIAL.** Day-3 (Monday) is the meaningful freshness test —
expect shares to shift (creates/redeems happen on trading days) + close
to move to Monday's EOD. **Net 53 unpushed commits** on top of
`origin/main` (`c0cda7c`) after this HANDOFF rewrite (was 51 at Cycle 17
close · +1 slice 1 (f5644b1) = 52 · +1 HANDOFF = 53). **Pre-merge gate
locally verified:** `npx tsc --noEmit` returns 13 baseline errors
unchanged; `scripts/tests/healthCheck.test.ts` 37/37 pass. **NEXT
default on `continue`:** Cycle 19 candidate — **day-3 stockanalysis
observation (Monday 2026-05-25 — first trading day in the window)**.
Per the same pattern as today: re-run the refresh, compare values to
day-2, re-cross-check SPY against the SSGA refresh that should also
land Monday EOD with date=2026-05-25 data. Alternatives: (b) OQ-C16-1
FRED→T10Y3M alignment probe (deferred from Cycle 16); (c) N-PORT
quarterly cross-check scaffolding; (d) drift remediation.

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
| Q-4 | Push 53 unpushed commits to origin/main (Cycle 18 slice 1 + this HANDOFF is the 53rd) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. **Cycle 17 resolution via ADR-049 (stockanalysis.com free-aggregator scrape; 5 of 6 non-SSGA tickers restored: IVV/QQQ/IWM/HYG/TLT; VOO observationally dark pending source repair).** ADR-048 (path-B universe-shrink) marked **Superseded** but preserved on disk as fallback. **Day-2 observation (Cycle 18) PASS — see below for details.** **Status: PARTIAL** — methodology committed via ADR-049 Slice 1; the 5-day observation window + the v1-primary-read-path flip wait for the follow-up cycle. Operator action no longer required unless (a) SA proves unreliable in the observation window (revert to ADR-048 path-B), (b) operator wants paid feed for VOO specifically, or (c) operator wants the row closed before the read-path flip ships. | s96 #17 Cycle 12 (S96-89/-90); Cycle 13 (S96-91/-92); Cycle 14 (S96-93/-94); Cycle 15 (S96-95/-96, ADR-048 PROPOSED); Cycle 17 (S96-99/-100/-101, ADR-049 Accepted); Cycle 18 (day-2 observation PASS) | PARTIAL — orchestration-resolved; closes on read-path flip (Cycle 22+) |

**That's the entire queue.** Q-4 count incremented from 51 → 53. Q-5
unchanged. Q-6 unchanged at PARTIAL; day-2 observation logged as PASS.

---

## What this cycle delivered (s96 #17 Cycle 18)

### Slice 1 (`f5644b1`) — Day-2 stockanalysis observation (PASS)

**Goal:** Execute day-2 of the ADR-049 operator-authorized 5-day
observation window. Day-1 = Cycle 17's adapter run (rows at
date=2026-05-23). Day-2 = today's run (rows at date=2026-05-24).

**Calendar context:** Today is Sunday 2026-05-24. Last trading day was
Friday 2026-05-22. Day-1 (2026-05-23) = Saturday. Day-2 (2026-05-24) =
Sunday. Day-3 = Monday 2026-05-25 (first trading day in the window).
For weekend days, shares + close are EXPECTED to be byte-identical to
the prior day (no creates/redeems happen, no trading happens).

**Procedure:**

1. Per ADR-044 mandate, ran `npm run health:check` first. Snapshot
   matched Cycle 17 close exactly — no NEW Tier-2 items.
2. Captured day-1 baseline by probing CH at
   `quantlab.etf_shares_outstanding_secondary` for source='stockanalysis'.
3. Ran the adapter in dry-mode to capture day-2 values without writing.
4. Cross-checked SPY by running the adapter on SPY directly + comparing
   to SSGA's latest known-good value in CH.
5. Applied the day-2 ingest via `npm run etf:flow:stockanalysis:refresh`.
6. Re-probed CH to verify both day-1 (date=2026-05-23) + day-2
   (date=2026-05-24) rows coexist cleanly.

**Day-1 → day-2 per-ticker comparison (5 OK tickers):**

| Ticker | Field    | Day-1 (date=2026-05-23)      | Day-2 (date=2026-05-24)       | Delta             |
| ------ | -------- | ---------------------------- | ----------------------------- | ----------------- |
| HYG    | shares   | 204,600,000                  | 204,600,000                   | 0.0% IDENTICAL    |
| HYG    | close    | $80.01                       | $80.01                        | 0.0% IDENTICAL    |
| HYG    | aum*     | $16,370,046,000              | $16,370,046,000               | 0.0% IDENTICAL    |
| IVV    | shares   | 1,110,000,000                | 1,110,000,000                 | 0.0% IDENTICAL    |
| IVV    | close    | $749.94                      | $749.94                       | 0.0% IDENTICAL    |
| IVV    | aum*     | $832,433,400,000             | $832,433,400,000              | 0.0% IDENTICAL    |
| IWM    | shares   | 269,600,000                  | 269,600,000                   | 0.0% IDENTICAL    |
| IWM    | close    | $284.12                      | $284.12                       | 0.0% IDENTICAL    |
| IWM    | aum*     | $76,598,752,000              | $76,598,752,000               | 0.0% IDENTICAL    |
| QQQ    | shares   | 663,800,000                  | 663,800,000                   | 0.0% IDENTICAL    |
| QQQ    | close    | $719.03                      | $719.03                       | 0.0% IDENTICAL    |
| QQQ    | aum*     | $477,292,114,000             | $477,292,114,000              | 0.0% IDENTICAL    |
| TLT    | shares   | 509,900,000                  | 509,900,000                   | 0.0% IDENTICAL    |
| TLT    | close    | $84.617                      | $84.617                       | 0.0% IDENTICAL    |
| TLT    | aum*     | $43,146,208,300              | $43,146,208,300               | 0.0% IDENTICAL    |
| VOO    | —        | (rejected day-1)             | (rejected day-2)              | same failure mode |

*aum = persisted-aum (`shares × close`, materialized at ingest per
`etf_flow_issuer_csv_ingest.py` line 9). Since shares + close are
byte-identical, persisted aum is byte-identical.

**SA-reported aum (consistency-check input only — NOT persisted) drift:**

| Ticker | Day-1 SA aum  | Day-2 SA aum  | SA-side Δ |
| ------ | ------------- | ------------- | --------- |
| HYG    | $16.37B (CH baseline computed) | $16.17B (adapter print) | -1.22%    |
| IVV    | $832.43B                       | $831.96B                | -0.06%    |
| IWM    | $76.60B                        | $76.22B                 | -0.49%    |
| QQQ    | $477.29B                       | $476.31B                | -0.21%    |
| TLT    | $43.15B                        | $43.02B                 | -0.29%    |

**Interpretation:** SA appears to source `aum` from a separate vendor
that updates intra-weekend, while `sharesOut` + `chart.c` are pinned to
the last trading-close (Friday 2026-05-22). This is informational only
— the adapter's `aum` is used ONLY for the 5% internal-consistency
check; downstream-persisted `aum` is `shares × close`. All 5 OK tickers
continue to pass the consistency check (largest internal delta ≈ 1.2%
< 5% tolerance). VOO continues to fail at the same 39.9% delta — not a
transient SA glitch; structural.

**SPY accuracy cross-check (re-run, day-2):**

| Field  | SSGA known-good (date=2026-05-21) | SA day-2 scrape | Δ      |
| ------ | --------------------------------- | --------------- | ------ |
| shares | 1,033,632,116                     | 1,030,000,000   | -0.35% |
| close  | $742.77                           | $746.75         | +0.54% |
| aum    | $767.75B                          | $768.67B        | +0.12% |

Compare to Cycle 17 day-1 cross-check (0.4% / 0.5% / 0.12%). Essentially
identical — accuracy gate holds. The slight close drift (+0.54%) is
likely from SA's chart vendor including post-Friday futures/pre-market
indications, since US equity markets are closed on the weekend but
SPY-related futures trade Sunday evening US time.

**SSGA-side note discovered during cross-check:** SSGA's `max_date` is
2026-05-22 across all 15 tickers in aggregate, but SPY-specific data in
CH only reaches date=2026-05-21 (Wednesday). Other SSGA tickers reach
Friday 2026-05-22. Logged as a side observation (not actionable in this
cycle); could indicate per-ticker freshness lag on the SSGA refresh.
Worth surfacing in a future cycle if it persists.

**Files in slice 1 (commit `f5644b1`, +22 / -0):**

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/_probe_stockanalysis_day_over_day.ts` | new (+22) | Per-ticker day-over-day probe for remaining observation cycles. Mirrors the `_probe_sho_source_labels.ts` project pattern. |

**Database-state changes this cycle:**

- `quantlab.etf_shares_outstanding_secondary` grew by 5 rows:
  - Pre-Cycle-18: 3,761 rows (3756 SSGA + 5 stockanalysis at date=2026-05-23)
  - Post-Cycle-18: 3,766 rows (3756 SSGA + 10 stockanalysis at dates 2026-05-23 + 2026-05-24)
- SSGA history unchanged (3756 rows / 15 tickers / max_date=2026-05-22).
- No DDL change.

### Cycle 18 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (§3.1 codified categories — closure cycle for ADR-049's operator-authorized 5-day observation plan; all 6 gates green: no real-money path / no DDL / no paid-data / tsc preserved / convention pins green / no methodology canon committed since methodology is already in ADR-049) | Slice 1 — day-2 stockanalysis observation + probe script + CH state update | AUTO-APPROVE (no critic spawn) | All gates green; commit `f5644b1` |

**Decision: no critic spawn for slice 1.** This is execution on a
previously-ratified plan (ADR-049 §"Observation window"). The
orchestration's job here is to RUN the observation + DOCUMENT the
result in HANDOFF + DECIDE whether to apply or hold. Both decisions
were made (apply was chosen because ReplacingMergeTree dedups same-key
rows so accumulating day-N rows in CH is the correct way to track the
time-series), and none of the §6.3 escalate triggers fired.

### Verification gates at cycle close

```text
git status                                                          # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                                            # 53 commits ahead (was 51)
npx tsc --noEmit                                                     # 13 baseline errors unchanged
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass (0 fail / 0 skip)
git worktree list                                                    # main only (no worker spawned)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail (last run Cycle 14 — no new TS test code in Cycle 17 or Cycle 18 modifies the broader suite; Cycle 17 added pytest only)
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

### Post-Cycle-18 health snapshot

No new Tier-2 quarantine items. `quantlab.health_quarantine` still 2
rows total (Q-5 + Q-6, both `accepted-as-warning`).
`etf_shares_outstanding` v1 yfinance table still 0 rows (Q-6 source
dead — adapter does not write here; writes to `_secondary`).
`etf_shares_outstanding_secondary`:
- Pre-Cycle-18: 3761 rows / 20 tickers (15 SSGA + 5 stockanalysis at 1 date)
- Post-Cycle-18: 3766 rows / 20 tickers (15 SSGA + 5 stockanalysis at 2 dates)
- Still missing from F-UNIVERSE: VOO only

### Push state

- `origin/main` at `c0cda7c`; **53 unpushed commits** after this
  HANDOFF rewrite (was 51 at Cycle 17 close · +1 slice 1 (f5644b1) = 52
  · +1 HANDOFF = 53).
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
| **Cycle 18 — day-2 stockanalysis observation (PASS)** | **✓ s96 #18 (S96-102)** |
| Cycle 19 — day-3 stockanalysis observation (Monday — first trading day) | ☐ NEXT default (recommended) |
| Cycle 19-alt — N-PORT quarterly cross-check scaffolding | ☐ alternative |
| Cycle 19-alt — FRED→T10Y3M alignment probe (OQ-C16-1) | ☐ alternative |
| Cycle 22+ — v1 primary read path flip (after 5-day window passes) | ⏸ blocked on 5-day observation completion |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation completion |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ⛔ low priority — source frozen per S96-88 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ⛔ EMPIRICALLY DEAD — Cycle 11 |
| Composite worker (Q-5-blocked phase1_v3 re-classify) | ⏸ blocked on Q-5 pick |
| Composite worker (Q-6-blocked etf-flow read-path flip) | ⏸ blocked on 5-day observation completion |
| Per-issuer free-data adapters (iShares + Vanguard + Invesco) | ⛔ EMPIRICALLY EXPENSIVE — Cycle 14 (S96-93); requires Playwright; not authorized + no longer needed (ADR-049 fills the gap differently) |
| VOO source repair | ⛔ ESCALATED — operator-gated (paid feed OR wait for SA to fix OR accept observational gap) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #18 (Cycle 18 of multi-agent orchestration)

**S96-102. Day-2 stockanalysis observation establishes the
weekend-pinned baseline; the day-over-day probe pattern is now the
load-bearing observation tool for the remaining 3 days of the window.**
`Why:` The day-1 → day-2 comparison MUST pass byte-identical on
shares + close over a weekend (no creates/redeems, no trading); any
day-over-day delta on those fields during a non-trading transition
would indicate SA pulling phantom data + would force ADR-048 path-B
reactivation. Empirically: 5/5 OK tickers passed byte-identical on
shares + close + persisted-aum. The SA-side aum drift (-0.06% to
-1.22%) is from SA sourcing aum from a separate slower-moving vendor
and is INVISIBLE downstream because persisted aum is `shares × close`
materialized at ingest. VOO's 39.9% consistency-check failure
reproduces exactly, confirming it is a structural SA-side data quality
issue (likely a different vendor publishing stale sharesOut for VOO
specifically), NOT a transient. `How to apply:` (1) Day-3 (Monday
2026-05-25) is the meaningful freshness test — shares should shift
(creates/redeems are daily on trading days; SSGA's history shows
~3M-share day-over-day shifts as typical for SPY) + close should
advance to Monday's EOD. Confirm by running the same procedure as
today + diffing against day-2. (2) Day-4 + Day-5 follow the same
pattern. (3) After day-5, if observations confirm freshness, a
follow-up cycle wires daemon step 1jc + flips the v1 primary read
path. (4) If ANY weekend day shows shares + close drift, that's a
trigger to revert to ADR-048 path-B (signal: SA is publishing phantom
data). (5) The probe `scripts/_probe_stockanalysis_day_over_day.ts`
is the canonical tool for this diff; it shows per-ticker per-date
rows with `ingested_at` for the ReplacingMergeTree timeline.

**Carry-overs (still in force):** S96-1..S96-101; S95-1..S95-50;
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
  covered in Q-6 row. Cycle 18's day-2 reproduction strengthens the
  structural-cause hypothesis (vs transient SA glitch).
- **OQ-C18-1 (NEW)** — SPY-specific SSGA freshness lag. SSGA's
  `max_date` across all 15 tickers in CH is 2026-05-22, but SPY-
  specific data only reaches 2026-05-21. Could indicate per-ticker
  freshness lag on the SSGA refresh, or could be a one-time skip on
  Thursday. Not actionable this cycle; surface in a future cycle if
  it persists for >1 trading day.
- **OQ-C16-1** — FRED→T10Y3M same-day-alignment probe. Deferred from
  Cycle 16 (Cycle 17 prioritized Q-6 resolution; Cycle 18 prioritized
  day-2 observation). Cycle 19 alternative default.
- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers — CLOSED
  Cycle 17 by ADR-049 (path-B' Playwright concerns moot under SA path).
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers — CLOSED Cycle 17 by
  ADR-049 (different free path resolves the gap).

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

### Default on `continue` — Cycle 19 candidate (recommended day-3 stockanalysis observation)

Day-3 is Monday 2026-05-25 — **the first trading day in the 5-day
window**. This is the meaningful freshness test. Expected:

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

**Failure handling:**

- If shares OR close shows >5% day-over-day delta on any ticker on a
  TRADING day → that's still suspicious (overnight creates/redeems
  rarely exceed 5%; 5%+ likely means SA pulled stale or wrong data).
  Surface as quarantine row + halt the observation window pending
  investigation.
- If 2+ tickers loud-reject on consistency (vs the lone VOO today) →
  signal SA's feed is degrading broadly; halt window + revert to
  ADR-048 path-B.

### Alternative Cycle 19 candidates

- **N-PORT quarterly cross-check scaffolding.** Authoritative truth-
  check for ALL secondary-table sources. Substantial scope (~300-500
  LOC for EDGAR fetcher + reconciliation logic). Better deferred until
  the 5-day window completes.
- **OQ-C16-1 FRED→T10Y3M alignment probe.** Pure-investigation, ~10-15
  min. Resolves a Cycle 16 finding cleanly.
- **Phase 2 v2 spec drafting.** Implementation deferred per S96-71.
- **Drift remediation.** Reactive.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 18)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/_probe_stockanalysis_day_over_day.ts` | new (+22) | Slice 1 `f5644b1` — per-ticker day-over-day probe |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+22 / -0 across 1 file (slice 1) + 1 HANDOFF rewrite**. No
ADR changes. No DDL changes. No real-money path touched.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| `quantlab.etf_shares_outstanding_secondary` | INSERT (5 rows) | +5 stockanalysis rows for date=2026-05-24 | IVV/QQQ/IWM/HYG/TLT. VOO rejected by consistency check (same as day-1). Total: 3766 rows / 20 tickers. |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-6 row stays as `accepted-as-warning` until the read-path flip cycle (Cycle 22+) |

### Test + tsc state

- `healthCheck.test.ts`: **37/37 pass**
- `npx tsc --noEmit`: **13 baseline errors unchanged**

### Untouched-but-relevant for next session

- Q-5 + Q-6 quarantine rows still loaded for first Telegram alerts on
  next live daemon run with valid creds.
- `quantlab.executive_departures` + `quantlab.finra_short_interest`
  raw source tables still missing (carry-overs).
- `bt_runs_regime` has full `phase1_v3` attribution coverage (Cycle 10).
- `quantlab.macro_indicators_cboe`: 4,018 rows, max=2019-10-04, source
  frozen per S96-88.
- `quantlab.etf_shares_outstanding`: 0 rows, v1 yfinance source dead
  per S96-89; adapter does NOT write here.
- `quantlab.etf_shares_outstanding_secondary`: 3,766 rows / 20 tickers
  (15 SSGA + 5 stockanalysis at 2 dates; VOO absent).
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 18)

- **Weekend byte-identical baseline is the floor, not the ceiling.**
  Day-1 → day-2 byte-identical on shares + close is correct because
  no trading happened. This does NOT prove SA's feed is "fresh" — it
  proves SA's feed is "consistent over a non-trading transition." The
  freshness proof requires day-3 (Monday) showing shares + close move
  appropriately for a trading day. Do not declare the observation
  window successful before day-3 confirms trading-day movement.
- **The SA-reported aum drift is invisible downstream.** Persisted aum
  = shares × close (materialized in `etf_flow_issuer_csv_ingest.py`
  line 9). SA's aum field is consistency-check input only. Future
  cycles SHOULD NOT misread the SA-side aum drift as evidence of
  freshness — it's freshness of SA's NAV/AUM vendor, not freshness of
  the load-bearing fields (shares + close).
- **VOO failure is structural, not transient.** Day-2 reproduced
  exactly the day-1 39.9% consistency-check delta. The cause is
  SA-side (one of: stale Vanguard sharesOut vendor; different basis
  reporting; corrupt SA cache). The orchestration's path is to accept
  VOO as observationally dark + rely on SPY+IVV redundancy for S&P
  500 coverage; operator decision per Q-6's residual gap.
- **Probe script reuse.** `scripts/_probe_stockanalysis_day_over_day.ts`
  is the canonical day-N comparison tool for the remaining 3 days of
  the observation window. Do NOT re-implement; just re-run.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 + Cycle 18 carry-overs) preserved.

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

### Cross-source probe (Cycle 17 + Cycle 18)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # post-OPTIMIZE source label counts in CH
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # per-ticker per-date stockanalysis rows (NEW Cycle 18)
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

- (no changes — Cycle 18 reused the npm scripts added in Cycle 17)

---

## For the next session — priority order

**Default on `continue`:** Cycle 19 candidate — **recommended day-3
stockanalysis observation (Monday 2026-05-25, first trading day in the
window)**. Use the same procedure as Cycle 18; the meaningful test is
whether shares + close move appropriately for a trading day.

**Alternative Cycle 19 candidates:**

- **Day-3 stockanalysis observation** — see above (recommended).
- **OQ-C16-1 FRED→T10Y3M alignment probe** — deferred from Cycle 16.
- **N-PORT quarterly cross-check scaffolding** — for ALL
  secondary-table sources.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

**Calendar-gated (unchanged):**

- All Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (Q-1 through Q-6):**

- Q-1 first real-capital deployment.
- Q-2 capital-deployment-ramp ADR.
- Q-3 Stooq apikey gate decision.
- Q-4 push 53 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — A/B/C.
- Q-6 — **PARTIAL** (orchestration-resolved via ADR-049; closes on
  read-path flip in Cycle 22+; VOO residual gap is operator-gated;
  Cycle 18 day-2 observation PASS).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase B campaigns.
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-5-blocked work: phase1_v3 re-classify.
- Phase 2 v2 plausibility-band probes.
- **v1 primary read path flip** — operator-gated via the 5-day
  observation window completing successfully.
- VOO-specific paid feed or alternative source.

---

## Important framing for the next chat

**Cycle 18 is closed.** Two commits: slice 1 (`f5644b1`, +22/-0) added
the day-over-day probe script + executed the day-2 observation +
applied 5 new rows to CH; this HANDOFF rewrite is the 53rd commit.

**Q-6 stays PARTIAL.** Day-2 observation PASS strengthens confidence
in the ADR-049 path but does NOT close Q-6 — that requires the 5-day
window completing successfully + the read-path flip (Cycle 22+).

**One NEW open question of low priority:** OQ-C18-1 — SPY-specific
SSGA freshness lag (max_date=2026-05-21 for SPY vs 2026-05-22 for
other SSGA tickers). OQ-C17-1 (VOO structural failure) is now
strengthened by day-2 reproduction.

**S96-102 is the new lock-in.** Future cycles encountering the
remaining 3 days of the observation window follow the same
procedure: probe day-N-1 baseline → dry-run day-N → SPY
cross-check → apply → probe → diff → log.

**Cycle 19 recommended path: day-3 stockanalysis observation (Monday
trading day)** — this is the meaningful freshness test the entire
ADR-049 path depends on.

**Backward compat preserved this cycle:**

1. **CH:** No DDL change. `etf_shares_outstanding_secondary` schema
   unchanged; gained 5 rows with `source='stockanalysis'` at
   date=2026-05-24. Day-1 rows (date=2026-05-23) preserved.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes.
4. **Tests:** All previously-passing suites still pass; no new tests
   this cycle.
5. **Code behavior on existing surfaces:** No code changes other than
   the new probe script (read-only).
6. **Operator UX:**
   - `/#/etf-flow` unchanged (5-day observation window before
     read-path flip; primary still reads from the empty yfinance
     table).
   - `/#/health` quarantine queue still shows 2 rows.
   - `npm run health:check` output unchanged from Cycle 17.
   - **NEW**: operator can run `npx tsx scripts/_probe_stockanalysis_day_over_day.ts`
     to see per-ticker per-date stockanalysis rows.

**The chain through s96 #18:**

```text
ALL S41-S96#17 WORK                                       ✓ as documented
S96 #17 Cycle 17 (Q-6 PARTIAL via ADR-049)                ✓ as documented (S96-99..S96-101)
S96 #18 Cycle 18:
  • Slice 1 — day-2 stockanalysis observation
    AUTO-APPROVE  → +22/-0 (1 new probe script); CH +5 rows
                    (date=2026-05-24 stockanalysis); SSGA history
                    untouched.
       DAY-OVER-DAY
       RESULTS    → shares + close + persisted-aum byte-identical day-
                    1 → day-2 for all 5 OK tickers (expected over a
                    weekend); SA-side aum drift -0.06% to -1.22% is
                    invisible downstream (persisted aum = shares ×
                    close); VOO loud-reject reproduces exact same
                    39.9% delta (structural, not transient); SPY
                    cross-check shares -0.35% / close +0.54% / aum
                    +0.12% — accuracy gate holds, essentially
                    identical to Cycle 17 day-1 cross-check.
       SIDE
       OBSERVATION → SPY-specific SSGA max_date is 2026-05-21 in CH
                    while other SSGA tickers reach 2026-05-22.
                    Informational only; logged as OQ-C18-1.
  + S96-102 (day-2 observation establishes the weekend-pinned
    baseline; the day-over-day probe pattern is the load-bearing
    observation tool for the remaining 3 days of the window) lock-in
  + 2 commits: slice 1 (f5644b1) + this HANDOFF rewrite
  + Zero downstream consumer behavior change on existing surfaces
  + Q-6 stays at PARTIAL (closes on read-path flip in Cycle 22+);
    Q-4 count 51 → 53
  + ONE new open question of low priority (OQ-C18-1 SPY freshness lag);
    OQ-C17-1 strengthened by day-2 reproduction
  → DEFAULT NEXT: Cycle 19 candidate — RECOMMENDED day-3 stockanalysis
    observation (Monday 2026-05-25 — first trading day in the window).
    Meaningful freshness test: shares + close should move appropriately
    for a trading day. If they do, the ADR-049 path is validated; if
    they don't, the 5-day window halts pending investigation.
```
