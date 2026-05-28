# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #24 — **Cycle 30 closed with three
dependency-unblock slices: gics_sector_map populated (503 rows / 11
GICS sectors), sp500_constituents PIT depth backfilled from
sp500_history (1.34M rows / 2706 effective_dates / 1996-01-02 ..
2026-05-09), and form_4_insider_snapshots populated (98 daily rows /
2026-01-02 .. 2026-05-22, continuous coverage). One Tier-1 mechanical
fix shipped — Py3.14 argparse `%`-format compat in the gics ingest
(S96-139). The S96-130 pre-SPEC data-coverage hard gate for
form_4_insider_v1 Phase B is now SATISFIED.** Net 97 unpushed commits
on top of `origin/main` (`c0cda7c`) after this HANDOFF (Slice 4)
ships. **NEXT default on `continue`:** Cycle 31 — open Phase B SPEC
for form_4_insider_v1 (mirrors the cycle_v1 / vol_struct_v1 /
sector_rot_v1 / cross_asset_v1 SPEC pattern, scoring axis = aggregate
form_4_cluster_flag + per-ticker insiderClusterBuyFlag /
insiderClusterSellFlag).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

**Standing constraint (2026-05-24, s96 #19):** Operator stated "We will
not be trading real money while the system is incomplete and other
segments are set." Q-1 and Q-2 are indefinitely deferred. Orchestration
prioritizes foundational work — not real-money-readiness ramp.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-2 | Capital-deployment-ramp ADR sign-off | Operator self-assigned ~1 week per s96 #13 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 97 unpushed commits to origin/main (Cycle 21..30 + handoffs) | Carry-over; count +2 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — 4 of 9 composites PARTIAL; no PASS-ALL + PBO<0.2 yet |

**That's the entire queue.** Q-4 count 95 → 97 (Cycle 30 added 2
commits: Slice 1 + this HANDOFF). All other items unchanged.

---

## What this cycle delivered (s96 #24 Cycle 30)

**Cycle 30 was a dependency-wiring cycle** that unblocked the
`_backfill_form_4_insider_snapshots.ts` driver shipped (but blocked)
in Cycle 29. Three pre-stated tasks all completed in the same session,
plus one Tier-1 Py3.14 compat fix surfaced at first dry-run.

### Slice 1 — gics_sector_map ingest (Task A) + Py3.14 argparse fix
(S96-139) — `ed8c35a`

`scripts/sp500_gics_sector_ingest.py` (+4 / -2):

- **S96-139** (pre-Slice-1 mechanical):
  `.venv/Scripts/python.exe sp500_gics_sector_ingest.py --dry-run`
  crashed with `ValueError: unsupported format character 'P' (0x50)
  at index 99` inside `argparse._check_help`. Python 3.14 added strict
  `%`-format validation to argparse help strings; the `--url` help
  embedded `{DEFAULT_WIKIPEDIA_URL!r}` which contains `%26P`
  (URL-encoded `&P` from `List_of_S%26P_500_companies`).

- Fix: escape `%` as `%%` in the default-URL substitution. 26/26
  existing tests still pass.

- Post-fix dry-run + apply: 503 rows scraped from Wikipedia,
  validation alerts = 0, ingested to `quantlab.gics_sector_map` with
  `snapshot_date=2026-05-27`.

- Sector distribution (verifies all 11 GICS sectors present):
  ```
  Industrials              79    Real Estate              31
  Financials               76    Materials                26
  Information Technology   73    Communication Services   23
  Health Care              59    Energy                   21
  Consumer Discretionary   48    Utilities                31
  Consumer Staples         36
  ```

### Slice 2 — sp500_constituents PIT history depth (Task B; S96-140)

No source code change. Single `INSERT … SELECT` to backfill the
existing `sp500_constituents` table from the already-populated
`sp500_history` (fja05680 CSV PIT membership, 1996-01-02 .. 2026-01-14,
2705 distinct change-event dates):

```sql
INSERT INTO sp500_constituents (effective_date, ticker, source, weight_pct)
SELECT trade_date AS effective_date, ticker, 'fja05680' AS source, 0.0 AS weight_pct
FROM sp500_history FINAL
```

Post-INSERT state of `quantlab.sp500_constituents`:
- total rows: 1,344,210 (was 503)
- distinct effective_dates: 2,706 (was 1)
- date range: 1996-01-02 .. 2026-05-09 (was {2026-05-09})
- source breakdown: `fja05680` 1,343,707 rows / 2,705 dates +
  `ivv_holdings` 503 rows / 1 date (existing)

**Why `sp500_constituents` and not a new `sp500_constituents_pit`
table** (per Cycle 29 HANDOFF wording): the five repository PIT
helpers (form_4_insider_repository / executive_departure_repository /
schedule_13d_g_repository / eight_k_classifier_repository /
short_interest_repository) all read from `${this.sp500ConstituentsTable}
?? 'quantlab.sp500_constituents'`. Path of zero blast radius. The
`sp500_constituents_pit` reference in
`scripts/_backfill_form_4_insider_snapshots.ts:391` is a naming
artifact in the watch-out comment — actual code path resolves to
`quantlab.sp500_constituents` via the default helper.

**Why fja05680 over IVV vendor historical** (canon-thin fork
resolution): three-criterion test —
(1) canon foundations: PIT-correctness invariance per AFML §11;
both sources satisfy this.
(2) methodology rigor: fja05680 is the CSV of point-in-time
membership the project's existing `ingest_sp500_history.ts` already
loaded; IVV historical holdings would require a separate vendor sub
(paid; blocked per Q-3-adjacent).
(3) minimum free parameters: zero — no schema change, no new
script, no new dependency.

PIT-smoke-test result (Cycle 30 form4 backfill window endpoints):
```
asOf=2026-01-01 -> effective_date=2025-12-22 (503 tickers)
asOf=2026-01-14 -> effective_date=2026-01-14 (503 tickers)
asOf=2026-02-15 -> effective_date=2026-01-14 (503 tickers)   ← gap-window staleness ≤ 1 mo
asOf=2026-03-15 -> effective_date=2026-01-14 (503 tickers)   ← gap-window staleness ≤ 2 mo
asOf=2026-04-15 -> effective_date=2026-01-14 (503 tickers)   ← gap-window staleness ≤ 3 mo
asOf=2026-05-09 -> effective_date=2026-05-09 (503 tickers)
asOf=2026-05-25 -> effective_date=2026-05-09 (503 tickers)
```

**Gap-window staleness (Jan 14 → May 9 2026)** is bounded at ≤ ~4
months; SP500 membership turnover is ~25 names/yr so ≤ ~8 names drift
in the window. Acceptable for the form_4 aggregate signal (which
reads the ticker LIST, not weights). Documented as Cycle 30 watch-out
S96-140-W.

### Slice 3 — snapshot daemon-replay backfill (Task C)

No source code change. Ran the driver shipped in Cycle 29:

```
npx tsx scripts/_backfill_form_4_insider_snapshots.ts \
    --start 2026-01-01 --end 2026-05-25 --apply
```

Results (apply mode):
- trading days enumerated: 98
- snapshots computed: 98
- snapshots written: 98
- buy-cluster days (aggregate `form_4_cluster`): 0
- sell-cluster days (aggregate F4-12): 0
- Σ insiderClusterBuyFlag tickerdays: 18
- Σ insiderClusterSellFlag tickerdays: 1087
- elapsed: 65,770ms (~66s; well under the 2-5min projection in
  the driver's "What could break this" note)

Post-apply CH state of `quantlab.form_4_insider_snapshots`:
- 98 rows / 98 distinct snapshot_dates
- 2026-01-02 .. 2026-05-22 (continuous coverage; matches the
  raw insider_trades window)

**Aggregate-flag-zero observation (Cycle 31 SPEC must verify):** the
98-day window saw zero firings of the load-bearing aggregate
`form_4_cluster_flag` or F4-12 sell-cluster, despite 18 + 1087
per-ticker flag-days. Three hypotheses Cycle 31 SPEC should
discriminate:
(a) **Threshold genuinely tight** — the aggregate sector-z threshold
needs the per-ticker count to spike across MULTIPLE tickers in a
single sector on a single day, and the 5-month window's clustering
profile didn't cross that bar. Plausible — sell concentration may be
spread across sectors rather than concentrated.
(b) **Sector-bin attribution gap** — `gics_sector_map` was just
populated this cycle; daemon-replay reads the table with the today's
snapshot, so historical asOf may have null sectors for some tickers
that joined the SP500 mid-window. Should cross-check.
(c) **Sample window is genuinely quiet** — 98 days is a relatively
short Phase B window for a Form-4 composite (vs cycle_v1's multi-year
panel).

### Slice 4 — this HANDOFF rewrite

### Cycle 30 outcomes per orchestration §3.1 + §6

| Slice | Verdict | Outcome |
| --- | --- | --- |
| Slice 1 (1 file, +4/-2; data write to CH) | orchestrator-self-edit per §3.1 | Shipped + 26 existing tests pass |
| Slice 2 (no code; pure CH backfill via INSERT…SELECT) | orchestrator-self-edit per §3.1 trivial-edit (pure-data closure) | Shipped + PIT smoke-test |
| Slice 3 (no code; ran driver shipped Cycle 29) | orchestrator-self-edit per §3.1 (closure cycle) | Shipped + CH verification |
| Slice 4 HANDOFF rewrite | orchestrator-self-edit per §3.1 (pure-docs) | This file |

### Verification gates at cycle close

```text
git status                                                           # clean
git log origin/main..HEAD                                            # 97 commits ahead (after this HANDOFF)
npx tsc --noEmit                                                     # 13 baseline errors unchanged
.venv/Scripts/python.exe -m pytest scripts/tests/test_sp500_gics_sector_ingest.py  # 26/26 pass
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass
```

### Push state

- `origin/main` at `c0cda7c`; **97 unpushed commits** after this
  HANDOFF rewrite (was 95; +2 = Slice 1 + Slice 4).
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#23 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1..29 | ✓ as documented |
| **Cycle 30 — gics ingest + sp500 PIT depth + form4 snapshot backfill + Py3.14 argparse compat (S96-139..S96-140)** | **✓ s96 #24** |
| Cycle 31 — Phase B SPEC for form_4_insider_v1 | ☐ NEXT default |
| Thursday 2026-05-28 stockanalysis day-3 observation | ☐ first trading day post-Memorial-Day window |
| Cycles 32+ — Phase B campaign run for form_4_insider_v1 | ☐ blocked on Cycle 31 SPEC |
| Cycles 31+ — Phase B campaigns for remaining 4 Layer-0 composites | ☐ each requires data-ingest groundwork per audit §3 |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| Layer-0 Phase B statistical validation campaigns (4 of 9 done) | ✓ cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 (all PARTIAL) |
| `form_4_insider_v1` Phase B arc | 🚧 **DATA READY** — raw + snapshot tables populated; SPEC = Cycle 31 |
| Phase C promotion of any Layer-0 composite | ⏸ operator-gated per Q-8; DORMANT |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #24 (Cycle 30 of multi-agent orchestration)

**S96-139. Python 3.14 strict-checks argparse help strings via
`_check_help` and rejects bare `%`-character sequences as malformed
format strings.**
`Why:` Empirically observed 2026-05-27 on first Cycle-30 dry-run:
`sp500_gics_sector_ingest.py --dry-run` crashed with
`ValueError: unsupported format character 'P' (0x50) at index 99`.
The `--url` help string embedded `{DEFAULT_WIKIPEDIA_URL!r}` which
contains `%26P` (URL-encoded `&P` from `List_of_S%26P_500_companies`).
Python 3.13 was lenient. Python 3.14 added strict format-string
validation via `argparse.ArgumentParser._check_help`.
`How to apply:`
(1) Any argparse help that embeds a string with literal `%`
characters (URLs, format-token examples) MUST escape via
`.replace('%', '%%')` before f-string substitution.
(2) Sweep other ingest scripts in the next Cycle-30-adjacent
opportunity — `sec_edgar_*_ingest.py` family especially since they
often print URLs in `--help`. Tier-1 mechanical; orchestrator can
self-edit per §3.1 when surfaced.
(3) No CI test was added for this — the gics test suite covers
parser invariants but not the argparse construction (which is the
crash site). A possible Cycle-30-adjacent Tier-1 add: a single
test that just runs `parse_args` with `['--help']` and asserts no
ValueError. Open question: worth the test maintenance vs the
empirical signal of next-script-crashes-on-Py3.14? Leave deferred
until next argparse-help failure.

**S96-140. The form4/exec-departure/13d_g/8K-classifier/short-interest
repository family resolves `sp500ConstituentsTable` to
`quantlab.sp500_constituents` (a single ReplacingMergeTree on
`(effective_date, ticker, source)`), NOT to a separately-named
`sp500_constituents_pit` table.**
`Why:` Cycle 29 HANDOFF (and the
`_backfill_form_4_insider_snapshots.ts:391` watch-out comment) named
the table `sp500_constituents_pit` — that was a naming artifact, not
an actual table. The five PIT helpers all use
`${this.sp500ConstituentsTable} ?? 'quantlab.sp500_constituents'`.
PIT depth is backfilled by writing fja05680-source rows into the
existing table; the ReplacingMergeTree sorting key
`(effective_date, ticker, source)` keeps the existing ivv_holdings
2026-05-09 snapshot as a separate row from the new fja05680
historical rows, so no collision risk.
`How to apply:`
(1) Treat `quantlab.sp500_constituents` as the canonical PIT
membership table for all SEC-EDGAR-family composites.
(2) `sp500_history` remains a separate raw-CSV holding table — the
relation is `sp500_constituents (effective_date, source=fja05680) :=
SELECT (trade_date, ticker, 'fja05680', 0.0) FROM sp500_history`.
Re-runs of `ingest_sp500_history.ts` will REQUIRE re-running the
Slice 2 INSERT…SELECT to flow new rows through; idempotent per
ReplacingMergeTree.
(3) Future enhancement (deferred): wrap the INSERT…SELECT in a
named TS script `scripts/_propagate_sp500_history_to_constituents.ts`
to make the dependency executable and CI-testable. Not load-bearing
for Cycle 30; would close out the implicit one-shot pattern.

**S96-140-W (watch-out, not decision). The
`sp500_constituents.effective_date` PIT depth has a gap window
2026-01-14 → 2026-05-09 where the latest available row is
`effective_date=2026-01-14` (~ 4-month staleness at gap upper bound).
The `_backfill_form_4_insider_snapshots.ts` driver's PIT-helper
read pattern (`max(effective_date) WHERE effective_date <= asOf`)
gracefully falls back, but the composite aggregate sector-z
calculation uses a ticker list that is up to ~4 months stale during
the gap. SP500 membership turnover ~25 names/yr → ≤ ~8 names drift
in the window; acceptable for aggregate purposes but should be
recomputed if/when `sp500_history` is refreshed beyond 2026-01-14
OR a more current PIT source (Wikipedia changelog scrape, fresh
fja05680 CSV) is wired.**

**Carry-overs (still in force):** S96-1..S96-138; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle (s96 #24 Cycle 30)

- **OQ-C30-1** — `form_4_insider_snapshots` aggregate flag zero
  across the entire 98-day window (0 buy-cluster + 0 sell-cluster days
  vs 18 + 1087 per-ticker flag-days). Cycle 31 SPEC must discriminate:
  (a) threshold genuinely tight in this window, (b) sector-bin
  attribution gap from gics_sector_map snapshot_date semantics, or
  (c) sample window is genuinely quiet. See Slice 3 narrative for
  hypothesis details.

- **OQ-C30-2** — When (or whether) to wrap the Slice 2 INSERT…SELECT
  in a named `scripts/_propagate_sp500_history_to_constituents.ts`
  script to make the dependency executable + CI-testable. Not
  load-bearing for Cycle 30. Defer to next sp500_history refresh.

- **OQ-C30-3** — When (or whether) to refresh the fja05680 CSV beyond
  2026-01-14 to close the 4-month gap-window staleness in S96-140-W.
  Source dataset (`fja05680/sp500` GitHub repo) is free per
  data-source policy; orchestration can wire a fresh CSV download +
  re-run `ingest_sp500_history.ts` + Slice 2 INSERT…SELECT. Defer
  until Cycle 31 SPEC verdict comes back — if hypothesis (a) is
  correct, this fix is moot; if (b), this could close the gap.

### CARRIED from earlier cycles

- **OQ-C29-1** — Should the form4 ingest write in batches per S96-138
  (single bulk-insert architectural risk)? Not triggered in Cycle 30
  (no EDGAR re-fetches). Deferred until next multi-month EDGAR backfill.
- **OQ-C29-2** — Migrate other 3 EDGAR ingest scripts (8K event, 8K
  Item 5.02, 13D/G) to the dated-split helper per S96-135 (4). Not
  triggered in Cycle 30. Recommend per-arc migration UNLESS operator
  wants a cross-cutting Tier-1 sweep in dedicated cycle.
- **OQ-C29-3** — **CLOSED Cycle 30 Slice 1**: gics_sector_map ingest
  shipped + populated.
- **OQ-C29-4** — **CLOSED Cycle 30 Slice 2**: sp500_constituents PIT
  depth backfilled from sp500_history.
- **OQ-C29-5** — Watch-universe PIT leak in
  `_backfill_form_4_insider_snapshots.ts`. Phase B Cycle 31+ must
  decide whether the load-bearing score axis depends on the leaked
  per-ticker counts. If so, a PIT-aware watch-universe override is
  required.
- **OQ-C28-1** — Migrate other 3 EDGAR ingest scripts to paginated
  helper (now superseded by S96-135 (4) which adds dated-split).
- **OQ-C28-2** — **CLOSED Cycle 29**.
- **OQ-C28-3** — `--snapshot-date` default = today. Not triggered
  in Cycle 30. Resolution deferred.
- **OQ-C27-1** — FINRA bulk short-interest CSV URL discovery —
  largest single blocker for `short_interest_v1` Phase B.
- **OQ-C27-2** — `executive_departure_v1` / `schedule_13d_g_v1`
  composites' score-axis question (categorical vs continuous-Φ).
- **OQ-C27-3** — Cross-composite meta-HLZ pass at 4 vs 9 composites.
- **OQ-C26-1** — BAMLH0A0HYM2 (HY-OAS) alternative-source ingest.
- **OQ-C26-2** — Cross-composite Pardo ranking interpretation.
- **OQ-C26-3** — QQQ PBO=0.089 cell anomaly investigation.
- **OQ-C25-1** — HLZ M=57 universal-blocker pattern.
- **OQ-C25-2** — IWM PBO=0.709 anomaly from sector_rot_v1.
- **OQ-C24-1** — HLZ M=57 cross-composite meta-HLZ pass (deferred
  per ADR-051).
- **OQ-C24-2** — KNOWN_COMPOSITES domain placement protocol.
- **OQ-C24-3** — `pickPrimaryPhaseCCandidate` tiebreaker.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases.
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051.
- **OQ-C21-1** — Q-5 quarantine row drop timing.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement.
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix + Cycle 24
  /#/phase-b + Cycle 25-26 verdicts deferred to operator dev-server
  restart.
- **OQ-C19-1** — `inputs_missing` UInt8 truncation at bits 8+.
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C17-1** — VOO source quality issue.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused.
- Capital-deployment-ramp ADR — Q-2 indefinitely deferred.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent.
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 31 candidate

Cycle 31 opens the **Phase B SPEC for `form_4_insider_v1`** — the
fifth of nine Layer-0 informational composites. Data prerequisites
all green:
- `quantlab.insider_trades`: 143,628 rows / 4,552 tickers / 2026-01-02
  .. 2026-05-22 (Cycle 28-29 raw backfill).
- `quantlab.gics_sector_map`: 503 tickers / 11 sectors (Cycle 30
  Slice 1).
- `quantlab.sp500_constituents`: 1.34M rows / 2,706 PIT dates / depth
  1996-01-02 .. 2026-05-09 (Cycle 30 Slice 2).
- `quantlab.form_4_insider_snapshots`: 98 daily snapshots / continuous
  coverage 2026-01-02 .. 2026-05-22 (Cycle 30 Slice 3).

**Cycle 31 Slice 1 (SPEC):** mirror the cycle_v1 / vol_struct_v1 /
sector_rot_v1 / cross_asset_v1 SPEC pattern (per AFML §11 + Bailey-LdP
DSR + Harvey-Liu-Zhu deflation). Score axes:
- **Aggregate axis:** `form_4_cluster_flag` (binary) + the underlying
  continuous Z-score `max_aggregate_z` / `max_aggregate_z_sell`.
- **Per-ticker axis:** `insiderClusterBuyFlag` / `insiderClusterSellFlag`
  (binary), with continuous Z-score lift readable from `per_ticker_json`.

**Cycle 31 Slice 1a (pre-SPEC discriminator for OQ-C30-1):** before
finalizing the SPEC, run a quick probe to discriminate among the
three aggregate-flag-zero hypotheses (threshold-tight vs
sector-attribution-gap vs window-quiet). Trivial CH query against
`form_4_insider_snapshots.max_aggregate_z` distribution. If
hypothesis (b) holds, the SPEC must include a gics-sector-map
re-populate at each historical asOf (which requires Wikipedia
historical sector data — a free-data scrape path, but new scope).

**Cycle 31 Slice 2 (campaign):** run `phase_b:form_4_insider_v1:dry`
+ `:apply` (npm scripts to be added in Slice 1). Mirror cross_asset_v1
campaign's first-AUTO-APPROVE precedent if results meet PASS criteria.

**Cycle 31 Slice 3 (HANDOFF rewrite).**

### Alternative Cycle 31 candidates (lower priority)

- **Path 1 — sp500_history refresh closure (OQ-C30-3).** Re-fetch
  fja05680 CSV beyond 2026-01-14; re-run `ingest_sp500_history.ts`
  + Slice 2 INSERT…SELECT to close the 4-month gap-window staleness.
  Cheap (~30 min); justified only if Cycle 31 Slice 1a hypothesis (b)
  is correct.
- **Path 2 — Proactive cross-cutting EDGAR migration (OQ-C28-1 +
  S96-135 (4)).** Sweep `sec_edgar_8k_event_ingest.py`,
  `sec_edgar_8k_item_5_02_ingest.py`, `sec_edgar_13d_g_ingest.py` to
  the dated-split + retry-pack pattern. ~3-4 hours; 3 small commits.
- **Path 3 — S96-138 architectural fix.** Batched writes +
  `--resume-from-date` for `sec_edgar_form4_ingest.py`. Justified
  only when next multi-month EDGAR backfill is imminent.
- **Path 4 — Tier-1 closure burst** (OQ-C19-1 + OQ-C24-3 + GAP-7(a)).
- **Path 5 — Early cross-composite meta-HLZ pass** (OQ-C24-1 +
  OQ-C27-3).
- **Path 6 — `short_interest_v1` FINRA URL discovery** (audit §6
  Path 5; OQ-C27-1).

### Long-running options (no change)

- **Q-7 path execution** if operator picks Path.
- **OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest** — enables
  future cross_asset_v2.
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion.

---

## Files / code state

### New / modified this cycle (s96 #24 Cycle 30)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/sp500_gics_sector_ingest.py` | +4 / -2 | Slice 1 (S96-139): escape `%` in argparse help for Py3.14 strict-check |
| `.claude/HANDOFF.md` | rewrite | Slice 4 — this file |

Total: **~6 LOC across 1 file + 1 HANDOFF rewrite**. Two pure-data
slices (Slice 2 + Slice 3) added zero source code — they are CH
state changes only, documented in DB-state below. DDL not modified.
No real-money path touched. No paid-data. No authenticated scrape.
**0 new tests added** (Slice 1 reuses 26 existing gics-parse tests
which all continue to pass; Slices 2 + 3 are pure-data closures
gated by post-write CH verification).

### DB-state changes this cycle

- `quantlab.gics_sector_map`: **0 → 503 rows** (Cycle 30 Slice 1
  first-apply); 11 distinct gics_sector values (all GICS-2018 canon
  members); snapshot_date=2026-05-27.
- `quantlab.sp500_constituents`: **503 → 1,344,210 rows** (Cycle 30
  Slice 2); 1 → 2,706 distinct effective_date values; date range
  expanded 2026-05-09 → {1996-01-02 .. 2026-05-09}; sources
  {ivv_holdings 503} → {ivv_holdings 503, fja05680 1,343,707}.
- `quantlab.form_4_insider_snapshots`: **0 → 98 rows** (Cycle 30
  Slice 3 first-apply); snapshot_date range 2026-01-02 .. 2026-05-22
  (continuous; matches insider_trades window).

### Test + tsc state

- `npm test`: not re-run (no TypeScript changes). Baseline 3791/3808
  pass + 17 skip + 0 fail still holds.
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in
  pre-existing `_*constituent*.ts` cleanup scripts).
- `pytest scripts/tests/test_sp500_gics_sector_ingest.py`: **26/26 pass**.
- `pytest scripts/tests/test_sec_edgar_*.py`: 147/147 pass (no change
  from Cycle 29).
- `node --import tsx --test scripts/tests/healthCheck.test.ts`:
  **37/37 pass**.

### Untouched-but-relevant for next session

- Q-5 quarantine row pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (CBOE put/call stale
  6.0d per health:check — daemon hasn't run today; not a Cycle 30
  regression).
- `quantlab.cycle_position_snapshots` 4,627 rows; 2008-01-02 →
  2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows.
- `quantlab.sector_rotation_snapshots` 3,367+ rows.
- `quantlab.cross_asset_snapshots` 3,368 rows.
- `quantlab.phase_b_trials` 228 rows; `quantlab.phase_b_verdicts`
  12 rows.
- `quantlab.insider_trades` 143,628 rows; `quantlab.insider_ciks`
  32,823 rows.
- **Empty/missing tables (Cycle 30 closes 3 of 5; remaining):**
  `short_interest` MISSING, `executive_departure` MISSING,
  `schedule_13d_g` MISSING, `eight_k_events` 0 rows,
  `etf_shares_outstanding` 0 rows.
- Operator dev server still needs `npm run dev` restart for
  Cycle 20-26 surfaces.

### Background-task / log artifacts

- No background-task logs generated this cycle (snapshot apply ran
  foreground in 65s).
- Cycle 29 forensic logs still on disk
  (`logs/form4_apply_2026-05-26*.log`); safe to delete post-Cycle-30.

---

## Watch-outs

### NEW from this cycle (s96 #24 Cycle 30)

- **Python 3.14 strict-checks argparse help format strings** (S96-139).
  Sweep other ingest scripts at next Tier-1 opportunity. Any URL
  embedded in `--help` is at risk.

- **`sp500_constituents` PIT gap window 2026-01-14 → 2026-05-09**
  (S96-140-W). Bounded staleness ≤ 4 months in the gap. Refresh
  fja05680 CSV beyond 2026-01-14 OR scrape Wikipedia changelog to
  close. Defer until Cycle 31 SPEC verdict (OQ-C30-3).

- **Slice 2 INSERT…SELECT is not yet a named script** (S96-140 (3)).
  Future re-runs of `ingest_sp500_history.ts` REQUIRE manually
  re-running the INSERT…SELECT to flow new rows through. Wrap in
  `scripts/_propagate_sp500_history_to_constituents.ts` at next
  refresh opportunity.

- **OQ-C30-1 aggregate-flag zero** — `form_4_insider_snapshots` has
  zero days where the aggregate `form_4_cluster_flag` or F4-12
  sell-cluster fired, despite 18 + 1087 per-ticker flag-days.
  Cycle 31 Slice 1a must discriminate among threshold-tight /
  sector-attribution-gap / window-quiet hypotheses BEFORE
  finalizing the SPEC.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#23 + Cycle 29 carry-overs including
S96-135..S96-138 EDGAR resilience pack) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text (every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON
npm run health:check:strict            # Phase 1 strict — exit 1 on non-green
npm run system-health:check            # Phase 2 v1 dispatcher
# UI surface: http://localhost:3000/#/health
# Phase B UI surface: http://localhost:3000/#/phase-b
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                  # Includes §0c Phase B verdicts
npm run health:check
```

### Phase B campaigns (4 of 9 shipped)

```text
npm run phase_b:cycle_v1:dry
npm run phase_b:cycle_v1:apply
npm run phase_b:vol_struct_v1:dry
npm run phase_b:vol_struct_v1:apply
npm run phase_b:sector_rot_v1:dry
npm run phase_b:sector_rot_v1:apply
npm run phase_b:cross_asset_v1:dry
npm run phase_b:cross_asset_v1:apply
```

### Cycle 30 data-prep one-liners (for repeat / refresh)

```text
.venv/Scripts/python.exe scripts/sp500_gics_sector_ingest.py --apply

# After re-running ingest_sp500_history.ts (when fja05680 CSV refreshes):
# RUN THE FOLLOWING TO FLOW NEW PIT ROWS INTO sp500_constituents:
.venv/Scripts/python.exe -c "import clickhouse_connect, os; c=clickhouse_connect.get_client(host=os.getenv('CLICKHOUSE_HOST','127.0.0.1'),port=int(os.getenv('CLICKHOUSE_PORT','8123')),username=os.getenv('CLICKHOUSE_USER','quantlab'),password=os.getenv('CLICKHOUSE_PASSWORD','quantlab'),database='quantlab'); c.command(\"INSERT INTO sp500_constituents (effective_date, ticker, source, weight_pct) SELECT trade_date, ticker, 'fja05680', 0.0 FROM sp500_history FINAL\")"

# Re-run form_4_insider snapshot backfill (idempotent per ReplacingMergeTree):
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --start 2026-01-01 --end 2026-05-25 --apply
```

### EDGAR ingests (Cycle 29 split-helper + retry-pack shipped for form4 only)

```text
# Form 4 (PAGINATED + DATE-SPLIT — Cycle 29 fix S96-135..S96-137):
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --start-date YYYY-MM-DD --end-date YYYY-MM-DD --dry-run
.venv/Scripts/python.exe -u scripts/sec_edgar_form4_ingest.py --start-date YYYY-MM-DD --end-date YYYY-MM-DD --apply > logs/form4_apply_<date>.log 2>&1

# 8-K event (NOT YET PAGINATED OR SPLIT — single-shot; do NOT multi-day apply):
npm run edgar:8k-event:ingest

# 8-K Item 5.02 exec departures (NOT YET PAGINATED OR SPLIT):
npm run edgar:exec-departure:ingest

# Schedule 13D/G (NOT YET PAGINATED OR SPLIT):
npm run edgar:13d-g:ingest
```

### Tests + dev

```text
npm test                                                                                                  # 3791/3808 pass + 17 skip + 0 fail
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_*.py                                      # 147/147 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_sp500_gics_sector_ingest.py                         # 26/26 pass
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                      # 82/82 pass
node --import tsx --test scripts/tests/phaseBCampaignCrossAssetV1.test.ts                                 # 78/78 pass
node --import tsx --test scripts/tests/phaseBCampaignSectorRotV1.test.ts                                  # 79/79 pass
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts                                  # 59/59 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                                # 37/37 pass
npm run dev                                                                                               # http://localhost:3000 (OPERATOR RESTART NEEDED)
npx tsc --noEmit                                                                                          # 13 baseline errors
```

---

## For the next session — priority order

**Default on `continue` — Cycle 31 Phase B SPEC for form_4_insider_v1:**

- Slice 1a (pre-SPEC discriminator): probe `form_4_insider_snapshots`
  for OQ-C30-1 aggregate-flag-zero root cause among threshold-tight /
  sector-attribution-gap / window-quiet.
- Slice 1 (SPEC): mirror cycle_v1 / vol_struct_v1 / sector_rot_v1 /
  cross_asset_v1 pattern. Both axes (aggregate flag + per-ticker flag).
- Slice 2 (campaign run): `phase_b:form_4_insider_v1:dry` + `:apply`.
- Slice 3 (HANDOFF rewrite).

**Cycle 31 alternatives (lower priority):**

- Path 1 — sp500_history refresh (OQ-C30-3).
- Path 2 — Proactive cross-cutting EDGAR migration.
- Path 3 — S96-138 batched writes.
- Path 4 — Tier-1 closure burst.
- Path 5 — Early cross-composite meta-HLZ pass.
- Path 6 — `short_interest_v1` FINRA URL discovery.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 97 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX (operator restart needed).
- Q-7 phase1_v3 yield-curve source persistence.
- Q-8 Phase C promotion — **DORMANT**.

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase C promotion of any Layer-0 composite to phase1_v3+.
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution.
- v1 primary read path flip.
- VOO-specific paid feed.
- Counterfactual rewrite of historical macro_regimes.
- cycle_v2 / vol_struct_v2 / sector_rot_v2 / cross_asset_v2 redesign.
- Relaxed Phase B thresholds.
- Alpaca / IBKR broker integration.
- Migration of other 3 EDGAR ingest scripts (OQ-C29-2 +
  S96-135 (4)).

---

## Important framing for the next chat

**Cycle 30 is closed.** Two commits: Slice 1 gics ingest Py3.14
argparse fix (`ed8c35a`) + Slice 4 this HANDOFF rewrite. Net 97
unpushed commits.

**Cycle 30 was a dependency-unblock cycle** that flipped three
load-bearing tables from missing/shallow to populated/deep, all in
one session:
- `gics_sector_map`: 0 → 503 rows / 11 GICS sectors.
- `sp500_constituents`: 1 effective_date → 2,706 effective_dates
  (1996-01-02 .. 2026-05-09) via fja05680 backfill.
- `form_4_insider_snapshots`: 0 → 98 daily rows (continuous coverage
  2026-01-02 .. 2026-05-22).

**The S96-130 pre-SPEC data-coverage hard gate for `form_4_insider_v1`
Phase B is SATISFIED.** Cycle 31 can open the SPEC immediately.

**Cycle 30 surfaced one Python-3.14-compat Tier-1 fix** (S96-139:
argparse `%`-format escape) and two methodology lock-ins (S96-140 +
S96-140-W: `sp500_constituents` is canonical PIT table; gap-window
staleness bounded ≤ 4 months until next fja05680 refresh).

**The 9-arc:**

- ✓ cycle_v1 (Cycle 23 PARTIAL) + Cycle 27 OQ-C23-1 backport
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ✓ sector_rot_v1 (Cycle 25 PARTIAL)
- ✓ cross_asset_v1 (Cycle 26 PARTIAL; first AUTO-APPROVE)
- 🚧 form_4_insider_v1 (Cycle 28 = pagination fix + 3-day apply;
  Cycle 29 = 10K-cap fix + 5-month raw backfill + snapshot driver
  shipped; Cycle 30 = gics + sp500 PIT + snapshot backfill;
  **Cycle 31 = Phase B SPEC opens**)
- ☐ short_interest_v1 (3-5 cycle ingest; FINRA URL discovery
  largest blocker)
- ☐ exec_departure_v1 (2-3 cycle ingest; EDGAR family)
- ☐ etf_flow_v1 (Path 1 BLOCKED until Q-6 resolved)
- ☐ eight_k_classifier_v1 (2-3 cycle ingest; EDGAR family)

**Cycle 31 default path (recommended):**

- Slice 1a: discriminate OQ-C30-1 aggregate-flag-zero hypothesis.
- Slice 1: Phase B SPEC.
- Slice 2: campaign dry + apply.
- Slice 3: HANDOFF rewrite.

**Cycle 31 watch-out priority:** if Slice 1a concludes hypothesis
(b) — sector-attribution-gap from gics_sector_map snapshot semantics
— then the SPEC must include a historical gics-sector replay path
(free-data scrape of Wikipedia changelog OR alternative). If
hypothesis (a) or (c), proceed with SPEC as patterned after the
cross_asset_v1 first-AUTO-APPROVE template.

**Per the S96-130 pre-SPEC data-coverage hard gate:** Cycle 31 Slice
1a's CH probe IS the data-coverage verification. Snapshot table has
98/98 continuous coverage so this is just a sanity re-check, but the
hard gate posture is preserved.

**Worker-spawn / SPEC-on-main / worktree watch-outs** carried over
from Cycle 27-29 — see HANDOFF Cycle 27-29 Watch-outs sections + the
new S96-135..S96-140 watch-outs above.
