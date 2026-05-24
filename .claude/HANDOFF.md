# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 17 of multi-agent
orchestration executed**. Operator continued from Cycle 16 close. After
Cycle 16's Q-6 decision-rationale conversation the operator picked
**path-A ("the data is needed")** + explicitly rejected the paid
Sharadar/Polygon framing of ADR-048 path-A. The orchestration ran an
empirical free-aggregator survey (Yahoo / ETF.com / Nasdaq / etfdb / SA
REST — all blocked, empty, or JS-rendered) and surfaced
**stockanalysis.com** as the only free static-HTML source with parseable
`sharesOut`, `aum`, `chart.c` for all 6 non-SSGA tickers. SPY accuracy
gate PASSED (0.4% delta vs SSGA known-good). Live-run ingested 5/6
tickers (IVV, QQQ, IWM, HYG, TLT); VOO rejected loud by the 5% internal-
consistency check (SA's VOO sharesOut doesn't reconcile with aum/close —
39.9% delta; redundant with SPY+IVV so coverage materially intact).
**ADR-049 Accepted; ADR-048 Superseded** (kept on disk as a fallback if
SA later breaks). F-UNIVERSE stays at 21 (20 observable). Slice 1
(commit `d6220ec`, +1207/-5 across 8 files) shipped: new adapter
`scripts/etf_flow_stockanalysis_adapter.py` (mirrors SSGA pattern with
schema-anchor regex + 5% internal-consistency check); 16-test pytest
suite; ADR-049 (~250 lines); ADR-048 Status field flipped to Superseded;
`etf_flow_issuer_csv_ingest.py` extended with mandatory `--source-file`
filter (Cycle 17 empirically verified the regression — running
`--source-label stockanalysis --apply` without it silently relabeled
3756 SSGA rows as 'stockanalysis' source on merge; repaired + pinned by
2 new regression tests); 3 new npm scripts (`etf:flow:stockanalysis:*`);
existing `etf:flow:ssga-spdr:refresh` updated to use the `--source-file`
filter so it can't recur. **Net 51 unpushed commits** on top of
`origin/main` (`c0cda7c`) after this HANDOFF rewrite (was 49 at Cycle 16
close · +1 slice 1 = 50 · +1 HANDOFF = 51). **Pre-merge gate locally
verified:** `npx tsc --noEmit` returns 13 baseline errors unchanged;
`scripts/tests/healthCheck.test.ts` 0 fails / 0 skipped; pytest 55/55
(stockanalysis 16 + issuer CSV ingest 21 + SSGA adapter 18). **Q-6
status: PARTIAL — methodology change committed via ADR-049; the 5-day
observation window + the v1-primary-read-path flip wait for the
follow-up cycle.** Q-5 unchanged. **NEXT default on `continue`:** Cycle
18 candidate — open choice between (a) day-2 observation of the
stockanalysis adapter (re-run + diff vs day-1 to verify the feed is
actually daily-fresh and the values move sensibly day-over-day); (b)
SEC EDGAR N-PORT quarterly cross-check scaffolding (the authoritative
truth-check for daily SA readings); (c) the FRED→T10Y3M alignment probe
from OQ-C16-1 (deferred from Cycle 16); (d) drift remediation.
Recommended: (a) day-2 observation — minimal cost, lets the 5-day window
start accumulating data points; the orchestration can run it on each
session-start until day 5, then a follow-up cycle wires the daemon step
+ flips the primary read path.

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
| Q-4 | Push 51 unpushed commits to origin/main (Cycle 17 slice 1 + this HANDOFF is the 51st) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. **Cycle 17 resolution via ADR-049 (stockanalysis.com free-aggregator scrape; 5 of 6 non-SSGA tickers restored: IVV/QQQ/IWM/HYG/TLT; VOO observationally dark pending source repair).** ADR-048 (path-B universe-shrink) marked **Superseded** but preserved on disk as fallback. **Status: PARTIAL** — methodology committed via ADR-049 Slice 1; the 5-day observation window + the v1-primary-read-path flip wait for the follow-up cycle. Operator action no longer required unless (a) SA proves unreliable in the observation window (revert to ADR-048 path-B), (b) operator wants paid feed for VOO specifically, or (c) operator wants the row closed before the read-path flip ships. | s96 #17 Cycle 12 (S96-89/-90); Cycle 13 (S96-91/-92); Cycle 14 (S96-93/-94); Cycle 15 (S96-95/-96, ADR-048 PROPOSED); Cycle 17 (S96-99/-100/-101, ADR-049 Accepted) | PARTIAL — orchestration-resolved; closes on read-path flip (Cycle 18+) |

**That's the entire queue.** Q-4 count incremented from 49 → 51. Q-5
unchanged. Q-6 transitioned OPEN → PARTIAL.

---

## What this cycle delivered (s96 #17 Cycle 17)

### Slice 1 (`d6220ec`) — ADR-049 implementation: stockanalysis.com adapter

**Goal:** resolve Q-6 by ingesting fresh daily SHO data for the 6
non-SSGA F-UNIVERSE tickers from a free, reliable, non-Playwright,
non-authenticated source — implementing the path-A-free choice operator
made in Cycle 16's decision-rationale conversation.

**Pre-build empirical surveys + gates:**

1. **Free aggregator survey** (Cycle 14 issuer-direct survey did NOT
   cover these). Probed 6 candidate sources:
   - `finance.yahoo.com/quote/{T}/key-statistics/` — HTTP 302 (cookie/auth)
   - `etf.com/{T}` — HTTP 200 but `aum: ''` empty (runtime API)
   - `nasdaq.com/market-activity/etf/{T}` — European wrappers, not US
     ETF data
   - `etfdb.com/etf/{T}/` — JS-rendered (Playwright needed)
   - `api.stockanalysis.com/api/symbol/e/{t}/statistics` — 404 (no public
     REST API)
   - `stockanalysis.com/etf/{t}/` — **HTTP 200 with inline JS blob
     containing `aum:"$X",sharesOut:"...",chart:{...c:N...}` for all 6
     tickers** ✓
2. **SPY accuracy cross-check** (the pre-build gate):
   - SA `sharesOut: "1.03B"` (1,030,000,000) vs SSGA known-good
     1,033,632,116 → **0.4% delta** ✓
   - SA `aum: "$768.67B"` vs SSGA $767,753,782,727 → **0.12% delta** ✓
   - SA `chart.c: $746.75` vs SSGA $742.77 EOD 5-21 → 0.5% (intraday
     drift) ✓
   - Internal: `aum / chart.c` = 1.030B ≈ sharesOut ✓
   - SA's `nav: $379.41` is STALE (likely inception-NAV); adapter does
     NOT parse it; uses `chart.c` for close ✓
3. **Live-run on all 6 tickers** with 5% internal-consistency check:
   - IVV: 1.110B shares × $749.94 close, $831.96B AUM, 0.05% delta ✓
   - QQQ: 663.8M shares × $719.03 close, $476.31B AUM, 0.2% delta ✓
   - IWM: 269.6M shares × $284.12 close, $76.22B AUM, 0.5% delta ✓
   - HYG: 204.6M shares × $80.01 close, $16.17B AUM, 1.2% delta ✓
   - TLT: 509.9M shares × $84.62 close, $43.02B AUM, 0.3% delta ✓
   - VOO: 2.36B shares × $686.53 close, $973.41B AUM, **39.9% delta** ✗
     (rejected loud — SA's VOO sharesOut field is stale/wrong;
     reconciliation: AUM/close = 1.418B, NOT 2.36B; confirmed only one
     sharesOut marker on the page so not a parser ambiguity)
   - 5/6 OK; VOO redundant with SPY+IVV so coverage materially intact

**Files in slice 1 (commit `d6220ec`, +1207 / -5):**

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/etf_flow_stockanalysis_adapter.py` | new (+366) | The adapter; mirrors SSGA pattern with schema-anchor regex (`aum:"$X"`, `sharesOut:"..."`, `chart.{...c:N`) + 5% internal-consistency check |
| `scripts/tests/test_etf_flow_stockanalysis_adapter.py` | new (+192) | 16-test pytest suite (T-SA-1..T-SA-13) |
| `scripts/etf_flow_issuer_csv_ingest.py` | edit (+20 / -6) | Mandatory `--source-file` filter; otherwise running `--source-label stockanalysis --apply` silently relabels ALL CSVs in the dir on ReplacingMergeTree merge |
| `scripts/tests/test_etf_flow_issuer_csv_ingest.py` | edit (+33 / -0) | 2 new regression-pin tests on the filter (happy-path + error-on-missing) |
| `package.json` | edit (+3 / -1) | 3 new npm scripts (`etf:flow:stockanalysis:fetch`, `:fetch:dry`, `:refresh`); existing `etf:flow:ssga-spdr:refresh` updated to use `--source-file ssga-spdr.csv` |
| `docs/specs/adr-049-q6-stockanalysis-free-feed.md` | new (+~250) | The ADR — Status: Accepted |
| `docs/specs/adr-048-etf-flow-universe-amendment.md` | edit (small) | Status PROPOSED → Superseded; ADR-049 cross-link added |
| `scripts/_probe_sho_source_labels.ts` | new (+~20) | Ad-hoc probe used to verify source-label distribution in CH (kept per project pattern alongside `_probe_gap16_sentinels.ts` etc.) |

**Database-state changes this cycle:**

- `quantlab.etf_shares_outstanding_secondary` now contains 3761 rows
  across 20 distinct tickers — 3756 SSGA-sourced (15 tickers, range
  2025-05-23..2026-05-22) + 5 stockanalysis-sourced (5 tickers, all
  date=2026-05-23). Single source-label cleanly: post-OPTIMIZE FINAL
  the table groups cleanly by `source ∈ {'ssga-spdr', 'stockanalysis'}`.
- One mis-labeling incident during the cycle: an initial test run of
  `etf_flow_issuer_csv_ingest.py --source-label stockanalysis --apply`
  (no source-file filter) silently relabeled all 3756 SSGA rows as
  `source='stockanalysis'` because the ingest globbed the dir + applied
  the CLI source-label to every file. Repaired same-cycle by adding
  `--source-file` filter + re-running each adapter with isolation.
  Pinned by `test_ingest_directory_source_file_filter_*` regression
  tests.

**Investigation trail (preserved for cycle audit):**

1. Operator typed `continue` (from Cycle 16 close).
2. Ran `npm run health:check` first per ADR-044 mandate. Snapshot
   matched Cycle 16 close exactly (no new Tier-2 items).
3. Cycle 16 had ended in a decision-rationale conversation on Q-6.
   Operator picked path-A ("the data is needed") but rejected the
   paid framing. Asked the orchestration to find a free + reliable
   source.
4. Read the Cycle 14 issuer-direct survey doc to ground in what was
   already ruled out (iShares ajax dead, Vanguard 302, Invesco 404).
5. Probed 6 free aggregator candidates not covered by Cycle 14. Only
   stockanalysis.com landing-page returned parseable static-HTML data.
6. Reported findings + asked for go-ahead with implementation gates
   (SPY accuracy cross-check + 5-day observation window + build adapter
   only if accuracy passes).
7. Operator: "please go ahead with implementation." Treated as
   ratification of all three gates.
8. Ran the SPY accuracy cross-check (PASS — 0.4% delta on shares;
   0.12% on AUM; `nav` field stale + unsafe so used `chart.c`).
9. Built the adapter mirroring the SSGA pattern byte-equal where
   applicable. Test suite covers schema drift on all 3 regex anchors +
   magnitude expansion + internal-consistency check + data-source
   policy 4-discipline gate behavior.
10. Pytest: 13/16 pass on first run; 1 fail on the K-magnitude
    parametrize because the test fixture's AUM in B-units rounds to
    zero for K-shares. Fixed by retargeting that test to the helper
    function level.
11. Live dry-run on all 6 tickers: 5 OK + VOO rejected by consistency
    check.
12. Live apply: wrote 5-row CSV. Ingested via the existing
    `etf_flow_issuer_csv_ingest.py --source-label stockanalysis`.
13. **Verified CH state via `_probe_sho_source_labels.ts` — discovered
    the cross-labeling regression.** All 3761 rows tagged as
    `stockanalysis`, including the 3756 SSGA-historical rows that
    should have stayed `ssga-spdr`.
14. Added `--source-file` filter to the ingest. Re-ran SSGA ingest with
    `--source-file ssga-spdr.csv --source-label ssga-spdr` to restore.
    Re-ran stockanalysis with isolation. Verified clean state.
15. Added 2 regression-pin tests for the filter.
16. Updated `package.json`: 3 new scripts + the existing SSGA refresh
    fixed to use the filter (it would have re-broken on the next run
    otherwise).
17. Drafted ADR-049 (~250 lines) + flipped ADR-048 to Superseded.
18. Ran integration gates: tsc 13 baseline ✓ / healthCheck 37/37 ✓ /
    pytest 55/55 ✓.
19. Committed slice 1 (`d6220ec`).

### Cycle 17 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (§3.1 codified categories — closure cycle for Tier-1 deferred Q-6 implementation, with the operator-ratified methodology choice from Cycle 16's conversation; all 6 gates green: no real-money path / no DDL / no paid-data / tsc preserved / convention pins green / methodology choice was operator's not committed-by-orchestration) | Slice 1 — stockanalysis adapter + tests + ADR-049 + `--source-file` filter + npm scripts | AUTO-APPROVE (no critic spawn) | All gates green; commit `d6220ec` |

**Decision: no critic spawn for slice 1.** Per the codified §3.1 the
six-gate ALL-of guard is satisfied. The slice fits exception category
4 (closure cycle for a previously-deferred Tier-1 item) with the
methodology choice already made by the operator (Cycle 16 + Cycle 17
back-and-forth). The orchestration's job is execution + ADR drafting
for the record. The cross-labeling regression discovered during the
slice was repaired same-cycle + pinned by regression tests — exactly
the discipline ADR-044 §"Data integrity" demands.

### Verification gates at cycle close

```text
git status                                                          # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                                            # 51 commits ahead (was 49)
npx tsc --noEmit                                                     # 13 baseline errors unchanged
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass (0 fail / 0 skip)
git worktree list                                                    # main only (no worker spawned)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_stockanalysis_adapter.py scripts/tests/test_etf_flow_issuer_csv_ingest.py scripts/tests/test_etf_flow_ssga_spdr_adapter.py
                                                                     # 55/55 pass
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail (last run Cycle 14 — no NEW test code in this cycle's slice modifies the broader suite)
test_etf_flow_stockanalysis_adapter.py (NEW)          16/16 pass
test_etf_flow_issuer_csv_ingest.py (extended)         21/21 pass (+2 regression-pin tests this cycle)
test_etf_flow_ssga_spdr_adapter.py (untouched)        18/18 pass
test_cboe_putcall_ingest.py (targeted)                16/16 pass
healthCheck.test.ts (targeted)                        37/37 pass
etfFlow / etfFlowCrossValidation / etfFlowRepository /
daemonEtfFlowV1PrimaryRefresh                         146/146 pass (Cycle 14 baseline preserved)
migrateCreateHealthQuarantine / healthQuarantine       57/57 pass
gicsSectorRepositoryHelper.test.ts                    13/16 pass + 3 skip
btRunsRegime.test.ts                                  19/19 pass
test_train_meta_label.py                              33/33 pass
regimeDashboard.test.ts                               37/37 pass
```

### Post-Cycle-17 health snapshot

No new Tier-2 quarantine items. `quantlab.health_quarantine` still 2
rows total (Q-5 + Q-6, both `accepted-as-warning`). `etf_shares_outstanding`
v1 yfinance table still 0 rows (Q-6 source dead — adapter does not
write here; writes to `_secondary`). `etf_shares_outstanding_secondary`:
- Pre-Cycle-17: 3756 rows / 15 tickers (SSGA-only)
- Post-Cycle-17: 3761 rows / 20 tickers (15 SSGA + 5 stockanalysis)
- Still missing from F-UNIVERSE: VOO only

### Push state

- `origin/main` at `c0cda7c`; **51 unpushed commits** after this
  HANDOFF rewrite (was 49 at Cycle 16 close · +1 slice 1 = 50 · +1
  HANDOFF = 51).
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
| **Cycle 17 — Q-6 resolved via ADR-049 stockanalysis adapter (S96-99..S96-101)** | **✓ s96 #17** |
| Cycle 18 — day-2 stockanalysis observation + diff vs day-1 | ☐ NEXT default (recommended) |
| Cycle 18-alt — N-PORT quarterly cross-check scaffolding | ☐ alternative |
| Cycle 18-alt — FRED→T10Y3M alignment probe (OQ-C16-1) | ☐ alternative |
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

### Session 96 #17 (Cycle 17 of multi-agent orchestration)

**S96-99. Q-6 resolves via ADR-049 (stockanalysis.com free-aggregator
scrape) for 5 of 6 non-SSGA F-UNIVERSE tickers; ADR-048 path-B
(universe-shrink) is Superseded but preserved on disk as a fallback.**
`Why:` Operator's Cycle 17 pick of path-A + rejection of paid framing
forced the orchestration to find a free + reliable source. Empirical
survey of free aggregators (Yahoo / ETF.com / Nasdaq / etfdb / SA REST
— all blocked, empty, or JS-rendered) surfaced stockanalysis.com as
the only free static-HTML source with parseable `sharesOut`, `aum`,
`chart.c` for all 6 tickers. SPY accuracy gate PASSED (0.4% delta vs
SSGA known-good). Live-run ingested 5/6 (IVV, QQQ, IWM, HYG, TLT);
VOO rejected loud by the 5% internal-consistency check. ADR-049 keeps
the full 21-ticker F-UNIVERSE (vs ADR-048 path-B's 15) + restores
F-6's broad-index aggregate to 5 constituents (vs path-B's 2) + does
NOT bump the composite version (vs path-B's v1 → v1.1) + is reversible
(if SA breaks, fall back to path-B). `How to apply:` (1) The new adapter
is `scripts/etf_flow_stockanalysis_adapter.py`; the npm chained
pipeline is `npm run etf:flow:stockanalysis:refresh`. (2) The CH state
post-Cycle-17 has 5 stockanalysis-sourced rows for date=2026-05-23.
(3) The 5-day observation window is the operator-authorized
verification gate before the v1-primary-read-path flip; manual runs
each session-start until day-5 (Cycle 22+). (4) If observation
window surfaces freshness drift OR accuracy divergence > 5% on the
SSGA-cross-check of SPY (re-run periodically), reactivate ADR-048
path-B by flipping its Status back to PROPOSED + operator
re-ratifying. (5) Per-issuer free-data adapters (Q-6 path-B'
iShares+Vanguard+Invesco direct) are no longer needed; the
Playwright-dep concern from Cycle 14 S96-93 is moot under this
path. (6) VOO remains observationally dark; operator may revisit
under a separate decision (paid VOO feed, wait for SA to fix, or
accept the gap given SPY+IVV redundancy).

**S96-100. The `etf_flow_issuer_csv_ingest.py` `--source-file` filter
is mandatory companion infrastructure for multi-source secondary-panel
ingest; the cross-labeling regression discovered during Cycle 17 is
pinned by 2 regression tests.** `Why:` The secondary table's
ReplacingMergeTree on `(ticker, date)` means same-key rows from
different source CSVs collapse to last-merge-wins. The ingest script
walks all `*.csv` files in the directory and writes them all with the
single CLI `--source-label`. So running
`--source-label stockanalysis --apply` with both `ssga-spdr.csv` and
`stockanalysis.csv` in the dir silently relabels the SSGA history as
'stockanalysis' source. Verified empirically Cycle 17. Repaired
same-cycle by adding the filter + re-running each adapter with
isolation + pinning by `test_ingest_directory_source_file_filter_*`.
`How to apply:` (1) Any future per-issuer adapter following the
secondary-table pattern MUST use `--source-file` to scope its ingest.
(2) The npm scripts `etf:flow:ssga-spdr:refresh` and
`etf:flow:stockanalysis:refresh` are pre-wired with the correct
filters; operator manual runs should mirror them. (3) If a future
adapter forgets the filter, the regression tests catch it (one
test per code-path: happy-path filtering to one file + error-on-
missing-file). (4) The narrower lesson: anywhere a directory-scanning
ingest writes a CLI-supplied attribute that intersects with the
table's dedup key, the scanning must be scoped — otherwise the
attribute leaks across rows. This is a general pattern worth
remembering for future ingest design.

**S96-101. The 5% internal-consistency check (AUM / close ≈ shares)
is the load-bearing reliability gate of the stockanalysis path.**
`Why:` Without the check, a future SA snapshot drift (sharesOut
from an older day pinned alongside current aum + current close) would
silently produce wrong data. Cycle 17's live-run already surfaced
exactly this class of failure (VOO: aum/close = 1.418B vs
sharesOut = 2.36B → 39.9% delta → rejected loud). The 5% tolerance
is operator-readable + NOT in-sample-tuned; chosen to be loose enough
that intraday-vs-EOD snapshot jitter doesn't trip false rejects
(delta < 1.2% on the 5 OK tickers) and tight enough to catch the
VOO-class failure. `How to apply:` (1) Do NOT lower the tolerance
without N days of observation history to characterize the noise
floor. (2) Do NOT widen the tolerance — silent stale data is worse
than loud failure. (3) Future cycles may add a separate "did the
consistency-failure pattern persist for N consecutive days" alert
to detect chronic source-quality decay (vs transient single-day
drift). (4) The consistency check is the orchestration's hedge
against single-point-of-failure on stockanalysis.com — if SA's data
quality decays we see it in the rejection rate first; the operator
gets a Telegram alert before silent corruption can propagate.

**Carry-overs (still in force):** S96-1..S96-98; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW from this cycle (s96 #17 Cycle 17)

- **OQ-C17-1** — VOO source quality issue. stockanalysis.com publishes
  `sharesOut: 2.36B` for VOO that doesn't reconcile with current
  `aum: $973.41B` + `close: $686.53` (implied shares = 1.418B; 39.9%
  delta). The mismatch is on the single sharesOut field, not the
  parser (only one marker on the page). Two hypotheses: (a) SA pulls
  sharesOut from a different vendor than aum/close and the vendor
  data is stale for VOO specifically; (b) Vanguard reports sharesOut
  in a different unit/basis (e.g. including authorized-but-unissued).
  Verifying requires either a paid feed comparison OR waiting for SEC
  N-PORT-P quarterly cross-check (next filing ~late-Aug 2026 with
  ~Feb 2026 data). Status: operator-gated; covered in Q-6 row.

### CARRIED from earlier cycles

- **OQ-C16-1** — FRED→T10Y3M same-day-alignment probe. Deferred from
  Cycle 16 (Cycle 17 prioritized Q-6 resolution). Cycle 18 alternative
  default.
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

### Default on `continue` — Cycle 18 candidate (recommended day-2 stockanalysis observation)

With Cycle 17 shipping the stockanalysis adapter as day-1 data, the
5-day observation window starts now. Each session-start until day-5
should:

1. **Re-run the adapter**: `npm run etf:flow:stockanalysis:refresh`.
2. **Compare day-N reading to day-(N-1)**: probe CH for the latest 2
   distinct dates per ticker; verify the values move sensibly (typical
   daily SHO drift for liquid ETFs is 0-2% range; >5% delta is
   suspicious; sustained zero-delta across multiple days suggests SA's
   field isn't actually updating daily).
3. **Re-cross-check SPY** against SSGA's known-good (which IS daily-
   fresh) to confirm SA's accuracy hasn't drifted.
4. **Log to HANDOFF**: one line per day with the freshness verdict.

After day-5 (Cycle 22 at earliest), if the observations confirm
freshness + accuracy, a follow-up cycle wires:

- Daemon step 1jc (post-close stockanalysis refresh, before SSGA's 1ja).
- v1 primary read path filter to consume from `_secondary` with
  `source IN ('ssga-spdr', 'stockanalysis')`.

If observations surface freshness or accuracy issues, revert to ADR-048
path-B (reactivate by flipping its Status PROPOSED + operator
re-ratifying).

**Why day-2 observation leads as Cycle 18 default:** It's the only
work that the 5-day window REQUIRES (the alternatives — N-PORT
scaffolding, FRED probe, drift remediation — can wait). Minimal cost
(~5 min per session). Builds the observation history the
read-path-flip cycle depends on.

### Alternative Cycle 18 candidates

- **N-PORT quarterly cross-check scaffolding.** Builds the
  authoritative truth-check for ALL secondary-table sources (SSGA +
  stockanalysis). Separate concern from daily ingest; substantial
  scope (~300-500 LOC for the EDGAR fetcher + reconciliation logic).
  Better deferred until after the 5-day window completes and we know
  the ADR-049 path is stable.
- **OQ-C16-1 FRED→T10Y3M alignment probe.** Pure-investigation, ~10-15
  min. Resolves a Cycle 16 finding cleanly.
- **Phase 2 v2 spec drafting.** Implementation deferred per S96-71.
- **Drift remediation.** Reactive.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 17)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/etf_flow_stockanalysis_adapter.py` | new (+366) | Slice 1 `d6220ec` |
| `scripts/tests/test_etf_flow_stockanalysis_adapter.py` | new (+192) | Slice 1; 16-test pytest |
| `scripts/etf_flow_issuer_csv_ingest.py` | edit (+20 / -6) | Slice 1; `--source-file` filter |
| `scripts/tests/test_etf_flow_issuer_csv_ingest.py` | edit (+33 / 0) | Slice 1; 2 regression-pin tests |
| `package.json` | edit (+3 / -1) | Slice 1; 3 new npm scripts + 1 updated |
| `docs/specs/adr-049-q6-stockanalysis-free-feed.md` | new (+~250) | Slice 1; ADR Status: Accepted |
| `docs/specs/adr-048-etf-flow-universe-amendment.md` | edit (small) | Slice 1; Status PROPOSED → Superseded |
| `scripts/_probe_sho_source_labels.ts` | new (+~20) | Slice 1; ad-hoc probe (kept per project pattern) |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+1207 / -5 across 8 modified-or-new files (slice 1) + 1 HANDOFF
rewrite**. One new ADR (ADR-049 Accepted). One status flip (ADR-048
Superseded). No DDL changes. No real-money path touched.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| `quantlab.etf_shares_outstanding_secondary` | INSERT (5 rows; +1 source label `stockanalysis`) | 5 new rows for 2026-05-23 | IVV/QQQ/IWM/HYG/TLT. VOO rejected by consistency check. SSGA history unchanged (15 tickers, 3756 rows). |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-6 row stays as `accepted-as-warning` until the read-path flip cycle (Cycle 22+); the methodology amendment via ADR-049 is committed but the daemon step + primary read aren't yet wired |

### Test + tsc state

- `pytest scripts/tests/test_etf_flow_stockanalysis_adapter.py`: **16/16 pass**
- `pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py`: **21/21 pass** (+2 new this cycle)
- `pytest scripts/tests/test_etf_flow_ssga_spdr_adapter.py`: **18/18 pass** (untouched)
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
- `quantlab.etf_shares_outstanding_secondary`: 3,761 rows / 20 tickers
  (15 SSGA + 5 stockanalysis; VOO absent).
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 17)

- **Stockanalysis.com is a single point of failure.** If SA changes
  HTML structure (renames `sharesOut`, splits the JS blob, etc.), all
  5 currently-ingesting tickers go dark loud (schema-anchor reject).
  Recovery is a one-line regex update + re-test. Mitigation: the
  loud-fail behavior preserves last-good CSV at the data-source-policy
  level + ADR-048 path-B is preserved on disk as the formal fallback
  if SA proves unreliable over time.
- **The `--source-file` filter is now load-bearing for any future
  per-issuer adapter following the secondary-table pattern.** Without
  it, the ingest will silently relabel everything in the directory.
  The 2 new regression tests catch this at CI time; the existing SSGA
  refresh chain has been retrofitted to use the filter so it can't
  recur on routine runs.
- **VOO is observationally dark until either source repair, paid
  feed, or operator-accepted gap.** SPY + IVV both track S&P 500 so
  the asset-class read is preserved; the F-6 broad-index aggregate
  has 5 constituents (vs ADR-048 path-B's 2) so statistical power is
  intact. Operator should be aware of the gap when reading the
  per-ETF panel.
- **The 5% internal-consistency tolerance is not in-sample-tuned.**
  It's an operator-readable round number chosen to (a) survive
  intraday-vs-EOD snapshot jitter (≤1.2% in live-run) and (b) catch
  the VOO-class failure (39.9%). Future cycles may tighten as
  observation history accumulates BUT should not loosen — silent
  stale data is the failure mode the check exists to prevent.
- **The 5-day observation window is the operator-authorized gate
  before the read-path flip.** Skipping it means the v1 primary read
  path silently changes to consume from a feed whose freshness +
  accuracy haven't been verified day-over-day. Do not skip without
  explicit operator re-authorization.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 16 carry-overs) preserved.

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

### ETF flow ingest (post-Cycle-17 — Q-6 RESOLVED via ADR-049)

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
# Cycle 17 (ADR-049): the new free-aggregator scrape replaces ADR-048's
# universe-shrink. F-UNIVERSE stays at 21; 20 observable; VOO dark.
# 5-trading-day observation window is the gate before primary-read-path flip.
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

### Cross-source probe (Cycle 17)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # post-OPTIMIZE source label counts in CH
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
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_stockanalysis_adapter.py -v             # 16/16 pass (NEW Cycle 17)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py -v                # 21/21 pass (+2 regression pins this cycle)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ssga_spdr_adapter.py -v                # 18/18 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors
```

### npm scripts touched this cycle

- **NEW**: `etf:flow:stockanalysis:fetch`, `etf:flow:stockanalysis:fetch:dry`,
  `etf:flow:stockanalysis:refresh`.
- **UPDATED**: `etf:flow:ssga-spdr:refresh` now uses `--source-file
  ssga-spdr.csv` (mandatory companion fix to prevent the cross-labeling
  regression from recurring on routine SSGA runs after the
  stockanalysis CSV starts coexisting in the dir).

---

## For the next session — priority order

**Default on `continue`:** Cycle 18 candidate — **recommended day-2
stockanalysis observation**. Re-run `npm run etf:flow:stockanalysis:refresh`,
diff vs day-1 (2026-05-23) reading, re-cross-check SPY against SSGA's
known-good, log the freshness verdict.

**Alternative Cycle 18 candidates:**

- **Day-2 stockanalysis observation** — see above (recommended).
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
- Q-4 push 51 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — A/B/C.
- Q-6 — **PARTIAL** (orchestration-resolved via ADR-049; closes on
  read-path flip in Cycle 22+; VOO residual gap is operator-gated).

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

**Cycle 17 is closed.** One slice + one HANDOFF rewrite (2 commits).
Slice 1 (`d6220ec`, +1207/-5 across 8 files) implemented ADR-049:
new stockanalysis.com adapter for 5 of 6 non-SSGA tickers; mandatory
`--source-file` filter on the existing issuer-csv ingest; ADR-049
Accepted; ADR-048 Superseded.

**Q-6 is now PARTIAL not OPEN.** Methodology change committed via
ADR-049; the daemon step + primary-read-path flip wait for the 5-day
observation window completion (Cycle 22 at earliest).

**One NEW open question:** OQ-C17-1 — VOO source quality (SA's
sharesOut field doesn't reconcile with aum/close). Operator-gated
under Q-6 row.

**The operator queue is still 6 rows.** Q-4 count incremented 49 →
51. Q-5 unchanged. Q-6 transitioned OPEN → PARTIAL.

**S96-99 + S96-100 + S96-101 are the new lock-ins.** Future cycles
encountering (a) a Q-6-class problem with multiple free-aggregator
candidates should follow the Cycle 17 survey + accuracy-gate +
internal-consistency pattern; (b) any multi-source secondary-table
ingest must use `--source-file` to scope the source-label application
(S96-100 pinned by regression tests); (c) load-bearing source
reliability gates (like the 5% internal-consistency check) should be
operator-readable round numbers, not in-sample-tuned (S96-101).

**Cycle 18 recommended path: day-2 stockanalysis observation** — the
5-day window MUST be observed; everything else can wait.

**Backward compat preserved this cycle:**

1. **CH:** No DDL change. `etf_shares_outstanding_secondary` schema
   unchanged; just gained 5 rows with new `source='stockanalysis'`
   label. SSGA history still 3,756 rows / 15 tickers / source
   `ssga-spdr`.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes.
4. **Tests:** All previously-passing suites still pass + 18 new tests
   (16 stockanalysis adapter + 2 ingest filter regression-pins).
5. **Code behavior on existing surfaces:** SSGA refresh chain
   continues to work + is now hardened against the
   cross-labeling regression.
6. **Operator UX:**
   - `/#/etf-flow` unchanged (5-day observation window before
     read-path flip; primary still reads from the empty yfinance
     table).
   - `/#/health` quarantine queue still shows 2 rows.
   - `npm run health:check` output unchanged from Cycle 16 (the new
     stockanalysis data is in `_secondary` which is tracked but the
     `why:` strings don't mention the new sub-source yet — that's a
     follow-up cycle's task).
   - **NEW**: operator can run `npm run etf:flow:stockanalysis:refresh`
     manually each session-start to accumulate observation history;
     can probe source-label distribution via
     `npx tsx scripts/_probe_sho_source_labels.ts`.

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3..16                                      ✓ as documented (S96-70..S96-98)
S96 #17 Cycle 17:
  • Slice 1 — Q-6 resolved via ADR-049 stockanalysis adapter
    AUTO-APPROVE  → +1207/-5 across 8 files; new adapter + 16-test
                    pytest + ADR-049 Accepted + ADR-048 Superseded +
                    mandatory --source-file filter on ingest + 2
                    regression-pin tests + 3 new npm scripts + 1
                    updated existing script.
       LIVE-RUN
       OUTCOME    → 5/6 tickers ingested clean (IVV/QQQ/IWM/HYG/TLT);
                    VOO rejected loud by 5% internal-consistency check
                    (sharesOut doesn't reconcile with aum/close); CH
                    state post-Cycle-17: 3761 rows / 20 tickers / 2
                    distinct sources.
       CROSS-
       LABELING
       INCIDENT   → Empirically verified during slice that running
                    `--source-label stockanalysis --apply` without the
                    filter silently relabels 3756 SSGA rows on merge.
                    Repaired same-cycle by adding the filter + re-
                    running each adapter with isolation + pinning by 2
                    regression tests + retrofitting the existing SSGA
                    refresh chain. The full repair lives in the slice 1
                    diff.
  + S96-99 (Q-6 resolved via stockanalysis path; ADR-048 superseded
    but preserved as fallback) + S96-100 (`--source-file` filter is
    mandatory companion infrastructure; regression-pinned) + S96-101
    (5% internal-consistency tolerance is the load-bearing reliability
    gate, operator-readable round number) lock-ins
  + 2 commits: slice 1 (d6220ec) + this HANDOFF rewrite
  + Zero downstream consumer behavior change on existing surfaces;
    `_secondary` table unchanged in schema; npm test + tsc + health
    baselines all preserved
  + Q-6 transitioned OPEN → PARTIAL (closes on read-path flip in
    Cycle 22+); Q-4 count 49 → 51
  + ONE new open question: OQ-C17-1 (VOO source quality)
  → DEFAULT NEXT: Cycle 18 candidate — RECOMMENDED day-2 stockanalysis
    observation. The 5-day window MUST be observed; the alternatives
    (N-PORT scaffolding, FRED probe, Phase 2 v2) can wait. Day-N tasks
    accumulate freshness + accuracy evidence; after day-5 a follow-up
    cycle wires daemon step 1jc + flips the v1 primary read path.
```
