# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #25 — **Cycle 31 closed as a
data-plumbing cycle: discriminated OQ-C30-1 to root cause (gics_sector_map
had a single snapshot_date = 2026-05-27, invisible to every historical
asOf in the backfill window); inserted 503 PIT-anchor rows at
snapshot_date = 1996-01-02 via the same staleness-fallback pattern
ratified for sp500_constituents in S96-140-W; re-ran the snapshot
backfill against the fixed gics map, lifting form_4_cluster_flag day
coverage from 0/98 to 89/98 (90.8%) and form_4_sell_cluster_flag day
coverage from 0/98 to 82/98 (83.7%). Per-ticker sector attribution
now resolves (60/62 in spot-check). The pre-SPEC discriminator
SURFACED a NEW concern (OQ-C31-1): max_aggregate_z values are
artifact-driven outliers (max=27.0, mean=10.1) because the 2y baseline
window extends back to 2024 but `insider_trades` only has data from
2026-01-02 onwards, producing ~657/730 zero-inflated baseline days.
Phase B SPEC defers to Cycle 32+.** Net 98 unpushed commits on top of
`origin/main` (`c0cda7c`) after this HANDOFF (Slice 2) ships.
**NEXT default on `continue`:** Cycle 32 — extend `insider_trades`
coverage backward via multi-month EDGAR Form 4 backfill so the 2y
baseline window has real trade data (closes OQ-C31-1; restores Phase
B viability).

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
| Q-4 | Push 98 unpushed commits to origin/main (Cycle 21..31 + handoffs) | Carry-over; count +1 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — 4 of 9 composites PARTIAL; no PASS-ALL + PBO<0.2 yet |

**That's the entire queue.** Q-4 count 97 → 98 (Cycle 31 added 1 commit:
this HANDOFF; Slice 1b + 1c were pure-data fixes with no source-code
change). All other items unchanged.

---

## What this cycle delivered (s96 #25 Cycle 31)

**Cycle 31 was a data-plumbing cycle** that discriminated OQ-C30-1,
fixed the gics_sector_map PIT visibility issue, and re-ran the form_4
snapshot backfill. The fix transformed the aggregate signal from
structurally-zero to 89+/98 firing days but SURFACED a new artifact
that defers Phase B SPEC to Cycle 32+.

### Slice 1a — discriminator probe for OQ-C30-1

Probed `quantlab.form_4_insider_snapshots` to discriminate among the
three hypotheses for the Cycle-30 aggregate-flag-zero observation
(threshold-tight / sector-attribution-gap / window-quiet). Results:

```
n_snapshots               98
n_buy_z_nonnull           0   ← every snapshot had null max_aggregate_z
n_sell_z_nonnull          0   ← every snapshot had null max_aggregate_z_sell
n_buy_above_2             0   ← consistent with all-null z
n_sell_above_2            0
avg_inputs_aggregate      0.0 ← every snapshot had 0 valid sectors
avg_inputs_per_ticker     0.0 ← every per-ticker row had cik="" and/or sector=null
```

Spot-check 2026-04-15: all 62 per-ticker rows had `sector: null` and
`cik: ""`. `flagged_sectors_json` and `flagged_sell_sectors_json`
both empty `[]`.

Drilled into the source tables:
```
gics_sector_map snapshot_date distribution:  { 2026-05-27: 503 }
gics PIT-replay at asOf=2026-05-22: visible_rows = 0   ← ROOT CAUSE
gics PIT-replay at asOf=2026-05-27: visible_rows = 503
cik_ticker_map total rows:                   0          ← separate gap
```

**Root cause:** Cycle 30 Slice 1's `sp500_gics_sector_ingest.py`
wrote `snapshot_date=2026-05-27` (the script-run date) on every row.
The strict-PIT lookup in `readSectorMembershipPanel` +
`readGicsSectorTimeline` uses `WHERE snapshot_date <= asOfEnd` →
every historical asOf in [2026-01-02 .. 2026-05-22] returns zero
rows → empty membership panel → empty `inputs.sectors[]` →
`inputs_available_aggregate = 0` across all 98 snapshots → no z
ever computed → both cluster flags structurally false.

This is hypothesis (b) — sector-attribution-gap — but at a deeper
level than the original Cycle 30 watch-out (S96-140-W) anticipated.

### Slice 1b — gics_sector_map PIT-anchor insert (S96-141)

Per the canon-thin three-criterion fork analysis (autonomous-execution
protocol):

(1) **Canon foundations:** S96-140-W (Cycle 30 sp500_constituents
gap-window staleness-fallback) already ratified the "fall back to
nearest snapshot when no row ≤ asOf" pattern. Inserting a synthetic
PIT-anchor row at the earliest expected asOf is structurally
equivalent — same staleness semantic, same v1 cold-start approximation
that v2 Wikipedia changelog backfill will replace. NOT an ADR-042 §7
strict-PIT violation: when v2 PIT data lands (real snapshot_dates for
sector swaps), the strict-PIT lookup re-attributes correctly; the
anchor is the default-fallback row for any asOf before the first real
PIT event.

(2) **Methodology rigor:** Zero new tunable parameters. Zero in-sample
tuning. Reuses an existing accepted approximation pattern from the
same Cycle 30 lineage.

(3) **Minimum free parameters:** Pure data INSERT (no code change, no
new schema, no new test). One new `source` label (`pit_anchor_synth_c31`)
preserves provenance.

Insert path (used Python `clickhouse_connect.insert(...)` not
`INSERT … SELECT FROM <self>` — the SELECT-from-self attempt was a
silent no-op, likely a CH self-reference quirk; fallback to
`SELECT-then-VALUES-INSERT` was bulletproof):

```python
# Read the 503 real Wikipedia rows
src_rows = c.query(\"\"\"
  SELECT ticker, gics_sector, gics_sub_industry
  FROM quantlab.gics_sector_map FINAL
  WHERE source = 'wikipedia_sp500' AND gics_sector != ''
\"\"\").result_rows  # → 503

# Build anchor rows: same (ticker, sector, sub_industry) but
# snapshot_date=1996-01-02 (matches sp500_history start, covers any
# foreseeable 2y baseline lookback) and source='pit_anchor_synth_c31'.
anchor_rows = [(t, s, sub, date(1996, 1, 2), 'pit_anchor_synth_c31')
               for (t, s, sub) in src_rows]
c.insert('gics_sector_map', anchor_rows, column_names=[...], database='quantlab')
```

Post-insert state of `quantlab.gics_sector_map`:
- Total rows: 503 → **1,006**
- snapshot_date distribution: `{ 1996-01-02: 503, 2026-05-27: 503 }`
- source distribution: `{ pit_anchor_synth_c31: 503, wikipedia_sp500: 503 }`

PIT-replay verification (AAPL):
```
asOf=2024-01-02: visible_rows= 503  AAPL → Information Technology @ 1996-01-02 (pit_anchor_synth_c31)
asOf=2026-05-22: visible_rows= 503  AAPL → Information Technology @ 1996-01-02 (pit_anchor_synth_c31)
asOf=2026-05-27: visible_rows=1006  AAPL → Information Technology @ 2026-05-27 (wikipedia_sp500)
```

ReplacingMergeTree ORDER BY `(ticker, snapshot_date)` keeps both rows
distinct (different sort keys). The PIT-DESC `LIMIT 1 BY ticker` in
the helper lookups picks the appropriate row per asOf — anchor for
historical, real Wikipedia row for 2026-05-27+.

### Slice 1c — re-run form_4 snapshot backfill (S96-141 verification)

Re-ran the canonical driver against the fixed gics map:

```
npx tsx scripts/_backfill_form_4_insider_snapshots.ts \
    --start 2026-01-01 --end 2026-05-25 --apply
```

Results (apply mode, all 98 snapshots overwritten via ReplacingMergeTree):

| Metric | Pre-Cycle-31 | Post-Cycle-31 | Δ |
| --- | --- | --- | --- |
| Trading days enumerated | 98 | 98 | — |
| Buy-cluster days (`form_4_cluster_flag`) | 0 | **89** | +89 |
| Sell-cluster days (`form_4_sell_cluster_flag` / F4-12) | 0 | **82** | +82 |
| Σ `insiderClusterBuyFlag` tickerdays | 18 | 18 | — |
| Σ `insiderClusterSellFlag` tickerdays | 1087 | 1087 | — |
| Elapsed | 65.8s | 86.0s | +20s |

Per-ticker totals unchanged — that path was already working
(joined via `issuer_ticker`, not `cik`). The aggregate path went
from structurally-zero to firing on ~90% of days.

Spot-check 2026-04-15 (the date that Slice 1a deep-dived):
```
per-ticker rows: 62  | sector null: 2  | non-null: 60
sectors observed: {IT: 8, Health Care: 10, Consumer Disc: 4, Financials: 10,
                   Industrials: 10, Energy: 10, Cons Staples: 6, Comm Svcs: 2}
form_4_cluster_flag (buy):       1
form_4_sell_cluster_flag:        1
max_aggregate_z (buy):           26.982 @ sector=Consumer Discretionary
max_aggregate_z_sell:            2.138  @ sector=Information Technology
```

### Slice 1c follow-up — z-distribution probe surfaces OQ-C31-1

Aggregate full-window z-distribution post-fix:

```
n_snapshots               98
n_buy_z_nonnull           96   (cold-start drops out 2 snapshots)
n_sell_z_nonnull          96
min_buy_z                 -0.207
max_buy_z                 26.982   ← OUTLIER
mean_buy_z                10.144   ← INFLATED MEAN
median_buy_z              8.662
min_sell_z                1.300
max_sell_z                26.982
mean_sell_z               8.394
median_sell_z             7.799
inputs_available_aggregate  min=11, max=11, avg=11.0   ← 11 GICS sectors per snapshot ✓
inputs_available_per_ticker min=0,  max=0,  avg=0.0    ← cik_ticker_map empty (S96-141-W2)
```

**OQ-C31-1 root cause:** the 2y baseline window for asOf=2026-04-15
is [2024-04-15, 2026-04-14] = 730 days, but `insider_trades` only has
data from 2026-01-02 .. 2026-04-14 = ~73 days. The other ~657 baseline
days have ZERO trades → cluster_rate per-day = 0 for those days. The
baseline distribution is heavily zero-inflated (mean ≈ 0, std ≈ tiny).
Any positive realized cluster_rate produces an inflated z. The
flagged Consumer-Discretionary cell at 2026-04-15 has `clusterRateT =
0.0208` against `baselineSize = 730` (730 days included, ~657 of them
zero), yielding z = 27. This is a sampling artifact, NOT a real
signal — Phase B can't validate against forward returns when the
ranking axis is dominated by "first non-zero observation in 2y."

### Slice 2 — this HANDOFF rewrite

### Cycle 31 outcomes per orchestration §3.1 + §6

| Slice | Verdict | Outcome |
| --- | --- | --- |
| Slice 1a (no code; pure CH probe) | orchestrator-self-edit per §3.1 (pure-investigation) | Discriminator finding documented |
| Slice 1b (no code; 503-row CH INSERT via `clickhouse_connect.insert()`) | orchestrator-self-edit per §3.1 (pure-data closure) | Anchor landed + PIT-replay verified |
| Slice 1c (no code; ran existing driver shipped Cycle 29) | orchestrator-self-edit per §3.1 (closure cycle) | 89/98 buy-cluster + 82/98 sell-cluster days |
| Slice 2 HANDOFF rewrite | orchestrator-self-edit per §3.1 (pure-docs) | This file |

All four slices passed the §3.1 trivial-edit guards (no real-money path,
no DDL, no paid-data, tsc baseline preserved, no canon-cited
methodology ratification — the S96-140-W staleness-fallback pattern
was already ratified Cycle 30).

### Verification gates at cycle close

```text
git status                                                           # clean (pre-HANDOFF)
git log origin/main..HEAD                                            # 98 commits ahead (after this HANDOFF)
npx tsc --noEmit                                                     # 13 baseline errors unchanged (no source code changes)
node --import tsx --test scripts/tests/healthCheck.test.ts           # 37/37 pass (re-verified pre-cycle; no code change since)
```

### Push state

- `origin/main` at `c0cda7c`; **98 unpushed commits** after this
  HANDOFF rewrite (was 97; +1 = Slice 2).
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#24 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1..30 | ✓ as documented |
| **Cycle 31 — gics_sector_map PIT-anchor + form_4 snapshot re-backfill (S96-141 + S96-141-W + S96-141-W2)** | **✓ s96 #25** |
| Cycle 32 — `insider_trades` multi-year EDGAR Form 4 backfill (closes OQ-C31-1) | ☐ NEXT default |
| Cycles 33+ — Phase B SPEC + campaign for form_4_insider_v1 | ☐ blocked on Cycle 32 |
| Phase B campaigns for remaining 4 Layer-0 composites | ☐ each requires data-ingest groundwork per audit §3 |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| Layer-0 Phase B statistical validation campaigns (4 of 9 done) | ✓ cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 (all PARTIAL) |
| `form_4_insider_v1` Phase B arc | 🚧 **DATA PLUMBING HEALED, BASELINE SHALLOW** — SPEC blocked on OQ-C31-1 |
| Phase C promotion of any Layer-0 composite | ⏸ operator-gated per Q-8; DORMANT |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #25 (Cycle 31 of multi-agent orchestration)

**S96-141. `quantlab.gics_sector_map` carries a PIT-anchor row per
ticker at `snapshot_date = 1996-01-02` with `source =
'pit_anchor_synth_c31'`, in addition to the real Wikipedia snapshot at
`snapshot_date = 2026-05-27` with `source = 'wikipedia_sp500'`.**
`Why:` Without the anchor, every historical asOf in
`[1996-01-02 .. 2026-05-26]` returns zero rows from
`readSectorMembershipPanel` + `readGicsSectorTimeline` (strict-PIT
`WHERE snapshot_date <= asOfEnd`), producing
`inputs_available_aggregate = 0` and structurally-false cluster flags
in every form_4 snapshot. The anchor restores sector resolution at
every historical asOf using "today's sector for the ticker," which is
the same staleness-fallback approximation ratified in S96-140-W for
`sp500_constituents`. The PIT-DESC `LIMIT 1 BY ticker` semantic
preserves strict-PIT ordering: for asOf >= 2026-05-27 the real
Wikipedia row wins; for earlier asOf the anchor wins. When v2
Wikipedia-changelog PIT backfill lands, intermediate snapshot_dates
slot in correctly and the anchor recedes to the default-fallback row
for pre-first-event asOf.
`How to apply:`
(1) Treat the anchor row as a structurally-required v1 cold-start
default. Future re-runs of `sp500_gics_sector_ingest.py --apply` will
add new `wikipedia_sp500` rows at fresh snapshot_dates; the anchor
row coexists (different sort key) and remains the fallback for asOf
< all-real-snapshots.
(2) Strict-PIT semantic compliance: ADR-042 §7 is preserved because
v1 has NO real PIT-event data; the anchor approximation is the v1
default. A v2 PIT-aware ingest (Wikipedia changelog scrape, free per
data-source policy) replaces the anchor with real swap-event rows
when scheduled. Mirrors the s2g sp500_history PIT lift pattern from
Cycle 30.
(3) Reproducibility risk: the anchor INSERT was a one-shot manual data
fix this cycle — NOT wrapped in a named TS script. See OQ-C31-2;
mirrors the deferred OQ-C30-2 pattern (sp500_history →
sp500_constituents propagation).

**S96-141-W (watch-out — NOT a decision; surfaces OQ-C31-1).
`max_aggregate_z` values across the 98-day form_4 snapshot window are
artifact-driven outliers (min=-0.21, max=26.98, mean=10.14,
median=8.66). The 2y baseline window for the earliest snapshot
(2026-01-02) extends back to 2024-01-02, but `quantlab.insider_trades`
only has data starting 2026-01-02. The other ~657 of 730 baseline
days have zero trades → cluster_rate per-day = 0 for those days → the
baseline distribution is heavily zero-inflated → any non-zero realized
cluster_rate produces an inflated z. Phase B SPEC cannot proceed
against the current snapshot set; the ranking axis is dominated by
"first non-zero observation in 2y" rather than real
information-content variation. Cycle 32 must extend `insider_trades`
coverage backward via multi-month EDGAR Form 4 backfill so the
baseline has real trade data.**

**S96-141-W2 (watch-out — NOT a decision; surfaces OQ-C31-3).
`quantlab.cik_ticker_map` is EMPTY (0 rows). The form_4 composite's
per-ticker row payload populates `cik` from a `readCikByTicker`
lookup; with the table empty, every per-ticker row has `cik = ""`.
`inputs_available_per_ticker` is structurally 0 (the composite's
counter requires both non-empty `cik` AND non-null `sector` — see
`src/server/form_4_insider.ts:589-590`). NOT blocking the per-ticker
cluster flag logic (cluster distinctness counts `person_cik` which
comes directly from `insider_trades`, no map lookup). NOT blocking
the aggregate path (sp500 + gics joins are ticker-keyed). But the
forensic `cik` field on per-ticker rows is empty, and downstream
consumers that filter on `inputs_available_per_ticker > 0` (e.g. UI
panels, brief renderer) will see zero qualifying rows. Cycle 32+
should ingest `cik_ticker_map` from the SEC EDGAR company_tickers.json
(free, pre-authorized) — separately from the OQ-C31-1 trade-coverage
fix.**

**Carry-overs (still in force):** S96-1..S96-140; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle (s96 #25 Cycle 31)

- **OQ-C31-1** (blocking Phase B SPEC) — `insider_trades` coverage
  window [2026-01-02 .. 2026-05-22] is shorter than the composite's
  2y baseline window (730d), producing zero-inflated baselines and
  artifact-driven z-scores (max=27, mean=10). Cycle 32 default path:
  extend `insider_trades` backward via multi-month EDGAR Form 4
  backfill. Per S96-138 watch-out (single bulk-insert architectural
  risk in `sec_edgar_form4_ingest.py`) — backfill must be split per
  the S96-135 (4) dated-split pattern. Suggested first window:
  2024-01-01 .. 2026-01-01 (2y, ~24 months, ~24 sub-runs at 1-month
  splits) to satisfy MIN_Z_BASELINE = 30 for asOf >= 2024-04-01 and
  give a full 2y baseline for asOf >= 2026-01-01.

- **OQ-C31-2** — When (or whether) to wrap the Slice 1b PIT-anchor
  INSERT in a named `scripts/_anchor_gics_sector_pit.ts` script for
  reproducibility on database wipe / re-bootstrap. Mirrors OQ-C30-2
  (sp500_history → sp500_constituents propagation). Defer until next
  bootstrap or until next Tier-1 closure burst.

- **OQ-C31-3** — Ingest `cik_ticker_map` from SEC EDGAR
  `company_tickers.json` (free, pre-authorized). Currently EMPTY (0
  rows). Not blocking aggregate path; blocks downstream
  `inputs_available_per_ticker > 0` filtering. Suggested Cycle 32+
  follow-on to OQ-C31-1 (same EDGAR ingest neighborhood). Source:
  `https://www.sec.gov/files/company_tickers.json` (well-known free
  endpoint).

- **OQ-C31-4** — Why did `INSERT INTO X SELECT FROM X` no-op silently
  in Slice 1b? Both `count()` and `count() FINAL` showed unchanged
  total post-INSERT despite the SELECT subquery clearly returning 503
  rows when run standalone. Switched to `clickhouse_connect.insert()`
  with explicit rows, which worked. Defer investigation; document the
  workaround (`SELECT-then-VALUES-INSERT` is bulletproof for
  self-referencing INSERTs in this CH deployment).

### CARRIED from earlier cycles

- **OQ-C30-1** — **CLOSED Cycle 31 Slice 1a**: discriminated to
  hypothesis (b) at deeper level than originally anticipated. The
  Cycle 30 S96-140-W watch-out about sp500_constituents staleness
  was correct in principle but missed that gics_sector_map had the
  same single-snapshot pathology with no fallback wired. Slice 1b
  fixed via the same staleness-anchor pattern.
- **OQ-C30-2** — When/whether to wrap the Cycle 30 Slice 2
  INSERT…SELECT (sp500_history → sp500_constituents) in a named TS
  script. NOT triggered this cycle. Still deferred. Now paired with
  OQ-C31-2 (gics anchor wrap) for a future cross-cutting
  bootstrap-script-wrap mini-cycle.
- **OQ-C30-3** — Refresh fja05680 CSV beyond 2026-01-14 to close
  4-month sp500_constituents gap-window. NOT triggered. Cycle 31 did
  not regress on this. Now lower-priority given Cycle 32's OQ-C31-1
  multi-year EDGAR backfill will likely surface the next big data-
  coverage discussion.
- **OQ-C29-1** — Should the form4 ingest write in batches per S96-138?
  Likely TRIGGERED by Cycle 32's multi-month backfill — see OQ-C31-1
  recommendation to use the S96-135 (4) dated-split pattern, which is
  the partial-mitigation path. Full S96-138 architectural batching is
  the upper-bound fix. Cycle 32 SPEC must decide between
  dated-split-only vs dated-split + batched-writes.
- **OQ-C29-2** — Migrate other 3 EDGAR ingest scripts (8K event, 8K
  Item 5.02, 13D/G) to the dated-split helper per S96-135 (4). NOT
  triggered Cycle 31. Now reclassified: if Cycle 32 has to expand the
  helper to handle multi-year windows, the per-arc migration could
  bundle in.
- **OQ-C29-5** — Watch-universe PIT leak in
  `_backfill_form_4_insider_snapshots.ts`. Phase B Cycle 32+ must
  decide whether the load-bearing score axis depends on the leaked
  per-ticker counts. With S96-141-W2 showing
  `inputs_available_per_ticker = 0`, the per-ticker path is currently
  unused; the leak is moot until cik_ticker_map is ingested
  (OQ-C31-3). Re-evaluate when that lands.
- **OQ-C28-1** — Migrate other 3 EDGAR ingest scripts to paginated
  helper (now superseded by S96-135 (4) dated-split).
- **OQ-C28-3** — `--snapshot-date` default = today. Not triggered.
- **OQ-C27-1** — FINRA bulk short-interest CSV URL discovery.
- **OQ-C27-2** — `executive_departure_v1` / `schedule_13d_g_v1`
  composites' score-axis question (categorical vs continuous-Φ).
- **OQ-C27-3** — Cross-composite meta-HLZ pass at 4 vs 9 composites.
- **OQ-C26-1** — BAMLH0A0HYM2 (HY-OAS) alternative-source ingest.
- **OQ-C26-2** — Cross-composite Pardo ranking interpretation.
- **OQ-C26-3** — QQQ PBO=0.089 cell anomaly investigation.
- **OQ-C25-1** — HLZ M=57 universal-blocker pattern.
- **OQ-C25-2** — IWM PBO=0.709 anomaly from sector_rot_v1.
- **OQ-C24-1** — HLZ M=57 cross-composite meta-HLZ pass.
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

### Default on `continue` — Cycle 32 candidate

Cycle 32 closes **OQ-C31-1** by extending `quantlab.insider_trades`
coverage backward via multi-month EDGAR Form 4 backfill. Without this
extension, the form_4_insider_v1 Phase B SPEC cannot proceed: the 2y
baseline window is zero-inflated and produces artifact z-scores.

**Cycle 32 Slice 1 (planning + first run):** decide window depth.
Suggested baseline: 2024-01-01 .. 2026-01-01 (24 months, fills the 2y
baseline that the existing 2026-01-02+ snapshots need). The
sec_edgar_form4_ingest.py script ships the S96-135..S96-137 dated-
split + paginated + retry-pack scaffolding (Cycle 29 deliverables),
so 24 sub-runs at 1-month splits is the standard path. Per S96-138
watch-out: single bulk INSERT to insider_trades at the end of each
sub-run is at risk of CH OOM if any single month has > ~100K trades;
empirically Cycle 29's 5-month run handled ~28K trades/month without
issue, so 1-month sub-runs should be safe. If a sub-run errors,
batched-write architectural fix (S96-138) becomes Cycle 32 in-scope
instead of deferred.

**Cycle 32 Slice 2 (snapshot re-backfill):** after insider_trades has
24+ months of data, re-run `_backfill_form_4_insider_snapshots.ts` to
regenerate snapshots with the now-non-degenerate baseline. The
snapshots backfill window stays at [2026-01-01 .. 2026-05-25] — the
baseline window is what changed depth, not the snapshot window.

**Cycle 32 Slice 3 (z-distribution re-probe):** verify
max_aggregate_z distribution is now in expected range (e.g.,
quantile(0.95) < 3 — Lakonishok-Lee 2001 § baseline). If still
inflated, deeper analysis required.

**Cycle 32 Slice 4 (HANDOFF rewrite).**

### Alternative Cycle 32 candidates (lower priority)

- **Path 2 — Bootstrap-script-wrap mini-cycle** (OQ-C30-2 + OQ-C31-2):
  write `scripts/_propagate_sp500_history_to_constituents.ts` +
  `scripts/_anchor_gics_sector_pit.ts` as named idempotent helpers
  so the Cycle 30-31 one-shot data fixes are reproducible on
  database wipe. ~150-200 LOC across 2 files; low risk. Worth doing
  before the next major data refresh.
- **Path 3 — Tier-1 closure burst** (OQ-C19-1 + OQ-C24-3 + GAP-7(a) +
  OQ-C31-3 cik_ticker_map ingest).
- **Path 4 — Proactive cross-cutting EDGAR migration** (OQ-C28-1 +
  S96-135 (4)) — sweep 8K event, 8K Item 5.02, 13D/G ingest scripts.
  Likely bundled with Cycle 32 if S96-135 helper expansion is
  required for multi-year window.
- **Path 5 — Early cross-composite meta-HLZ pass** (OQ-C24-1 +
  OQ-C27-3) — defer until 5th composite (form_4_insider_v1) is
  PARTIAL.
- **Path 6 — `short_interest_v1` FINRA URL discovery** (OQ-C27-1).
- **Path 7 — `cik_ticker_map` ingest only** (OQ-C31-3) as a focused
  micro-cycle. Trivial: SEC EDGAR's `company_tickers.json` is a
  small JSON file (~10K entries). ~80 LOC TS script + a
  schema-validation pin test.

### Long-running options (no change)

- **Q-7 path execution** if operator picks Path.
- **OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest** — enables
  future cross_asset_v2.
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion.

---

## Files / code state

### New / modified this cycle (s96 #25 Cycle 31)

| Path | Change | Notes |
| --- | --- | --- |
| `.claude/HANDOFF.md` | rewrite | Slice 2 — this file |

Total: **0 LOC of source code change**. All three pre-HANDOFF slices
(1a probe, 1b anchor insert, 1c backfill re-run) were pure-data
operations; the one commit this cycle is this HANDOFF rewrite.
DDL not modified. No real-money path touched. No paid-data. No
authenticated scrape. **0 new tests added** (no code change to test).

### DB-state changes this cycle

- `quantlab.gics_sector_map`: **503 → 1,006 rows** (Cycle 31 Slice 1b);
  snapshot_date distribution expanded {2026-05-27} → {1996-01-02,
  2026-05-27}; sources {wikipedia_sp500 503} → {wikipedia_sp500 503,
  pit_anchor_synth_c31 503}.
- `quantlab.form_4_insider_snapshots`: **98 rows overwritten** (Slice
  1c re-backfill at NEWER computed_at; ReplacingMergeTree dedup);
  buy-cluster days 0 → 89; sell-cluster days 0 → 82; aggregate-axis
  z values now non-trivial across 96/98 days (was 0/98).

### Test + tsc state

- `npm test`: not re-run (no TypeScript changes). Baseline 3791/3808
  pass + 17 skip + 0 fail still holds.
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in
  pre-existing `_*constituent*.ts` cleanup scripts).
- `pytest scripts/tests/test_sec_edgar_*.py`: 147/147 pass (unchanged).
- `pytest scripts/tests/test_sp500_gics_sector_ingest.py`: 26/26 pass
  (unchanged).
- `node --import tsx --test scripts/tests/healthCheck.test.ts`:
  **37/37 pass** (re-verified pre-cycle).

### Untouched-but-relevant for next session

- Q-5 quarantine row pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (CBOE put/call stale
  6.1d — daemon hasn't run today; not a Cycle 31 regression).
- `quantlab.cycle_position_snapshots` 4,627 rows; 2008-01-02 →
  2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows.
- `quantlab.sector_rotation_snapshots` 3,367+ rows.
- `quantlab.cross_asset_snapshots` 3,368 rows.
- `quantlab.phase_b_trials` 228 rows; `quantlab.phase_b_verdicts`
  12 rows.
- `quantlab.insider_trades` 146,168 rows (was 143,628 Cycle 30 — small
  organic growth from latest daemon-cadence runs; not a Cycle 31 ingest).
- `quantlab.insider_ciks` 32,823 rows.
- `quantlab.sp500_constituents` 1,344,711 rows (was 1,344,210; +501
  from one daemon cycle that touched the IVV-holdings snapshot — not
  Cycle 31 work).
- `quantlab.candles` 43,400,523 rows (unchanged; daemon hasn't refreshed).
- **Empty/missing tables (after Cycle 31):**
  `cik_ticker_map` 0 rows (S96-141-W2 / OQ-C31-3),
  `short_interest` MISSING,
  `executive_departure` MISSING,
  `schedule_13d_g` MISSING,
  `eight_k_events` 0 rows,
  `etf_shares_outstanding` 0 rows.
- Operator dev server still needs `npm run dev` restart for
  Cycle 20-26 surfaces.

### Background-task / log artifacts

- No background-task logs generated this cycle (snapshot backfill ran
  foreground in 86s).
- Cycle 29 forensic logs still on disk
  (`logs/form4_apply_2026-05-26*.log`); safe to delete post-Cycle-32.

---

## Watch-outs

### NEW from this cycle (s96 #25 Cycle 31)

- **gics_sector_map PIT-anchor row is REQUIRED for historical
  asOf < 2026-05-27** (S96-141). On database wipe / re-bootstrap, the
  Slice 1b INSERT must be re-run — current state is one-shot manual,
  not wrapped in a script (OQ-C31-2). Failure mode if not re-run:
  silent regression to Cycle-30 state (all form_4 snapshots have
  `inputs_available_aggregate=0`, no aggregate signal fires).

- **`max_aggregate_z` values in `form_4_insider_snapshots` are
  ARTIFACT-DRIVEN** (S96-141-W). Mean=10, max=27. NOT real signal.
  Phase B SPEC blocked until OQ-C31-1 resolved (multi-year
  insider_trades backfill).

- **`cik_ticker_map` empty** (S96-141-W2). Per-ticker `cik` field
  is `""` on every form_4 snapshot row.
  `inputs_available_per_ticker = 0` structurally. NOT blocking
  composite logic; blocking downstream consumers that filter on
  `inputs_available_per_ticker > 0`.

- **`INSERT … SELECT FROM <self>` silently no-op'd in this CH
  deployment** (OQ-C31-4 watch-out). Workaround: always use
  `SELECT` → Python rows → `clickhouse_connect.insert()` with
  explicit `column_names`. Same pattern as `c.insert(...)` used in
  Slice 1b. Future data-fix slices should follow this idiom rather
  than the SELF-INSERT shortcut.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#24 + Cycle 30 carry-overs including
S96-135..S96-140 EDGAR resilience pack and S96-140-W
sp500_constituents PIT gap-window) preserved.

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

### Cycle 31 data-prep one-liners (for repeat / refresh)

```text
# RECOMPUTE THE PIT-ANCHOR ROWS in quantlab.gics_sector_map
# (run after any sp500_gics_sector_ingest.py re-run OR on database wipe):
.venv/Scripts/python.exe -c "
import clickhouse_connect, os, datetime
c = clickhouse_connect.get_client(host=os.getenv('CLICKHOUSE_HOST','127.0.0.1'),
    port=int(os.getenv('CLICKHOUSE_PORT','8123')),username=os.getenv('CLICKHOUSE_USER','quantlab'),
    password=os.getenv('CLICKHOUSE_PASSWORD','quantlab'),database='quantlab')
src = c.query(\"SELECT ticker, gics_sector, gics_sub_industry FROM quantlab.gics_sector_map FINAL WHERE source='wikipedia_sp500' AND gics_sector != ''\").result_rows
anchor = [(t, s, sub, datetime.date(1996,1,2), 'pit_anchor_synth_c31') for (t,s,sub) in src]
c.insert('gics_sector_map', anchor, column_names=['ticker','gics_sector','gics_sub_industry','snapshot_date','source'], database='quantlab')
print(f'Inserted {len(anchor)} anchor rows.')
"

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

**Default on `continue` — Cycle 32 = `insider_trades` multi-year EDGAR
Form 4 backfill (closes OQ-C31-1):**

- Slice 1: 24-month backfill in 1-month sub-runs (2024-01-01 ..
  2026-01-01) using the S96-135 dated-split scaffolding. Log to
  `logs/form4_apply_c32_<batch>.log`. Verify total
  insider_trades growth and per-month row counts.
- Slice 2: re-run `_backfill_form_4_insider_snapshots.ts` at the
  existing 2026-01-01 .. 2026-05-25 window — the snapshots are the
  same dates, but their 2y baseline now has real trade data.
- Slice 3: z-distribution re-probe; verify quantile(0.95) < 3.
- Slice 4: HANDOFF rewrite.

**Cycle 32 alternatives (lower priority):**

- Path 2 — Bootstrap-script-wrap mini-cycle (OQ-C30-2 + OQ-C31-2).
- Path 3 — Tier-1 closure burst.
- Path 4 — Proactive cross-cutting EDGAR migration.
- Path 5 — Early cross-composite meta-HLZ pass.
- Path 6 — `short_interest_v1` FINRA URL discovery.
- Path 7 — `cik_ticker_map` ingest micro-cycle (OQ-C31-3).

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 98 commits to origin/main.
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

**Cycle 31 is closed.** One commit: Slice 2 this HANDOFF rewrite. Net
98 unpushed commits.

**Cycle 31 was a data-plumbing cycle** that discriminated OQ-C30-1 to
its root cause (`gics_sector_map` had a single snapshot_date =
2026-05-27, invisible to every historical asOf in the form_4 snapshot
backfill window), fixed it via a PIT-anchor INSERT (Slice 1b, 503 rows
at snapshot_date = 1996-01-02, source = `pit_anchor_synth_c31`), and
re-ran the snapshot backfill (Slice 1c). The aggregate signal flipped
from structurally-zero to 89/98 buy-cluster + 82/98 sell-cluster
days. Per-ticker sector attribution healed (60/62 in 2026-04-15
spot-check).

**The pre-SPEC discriminator probe SURFACED a NEW concern** (OQ-C31-1):
the 2y baseline window extends back to 2024 but `insider_trades` only
has 2026-01-02+ data, producing zero-inflated baselines and
artifact-driven z-scores (max=27, mean=10). Phase B SPEC blocked
until Cycle 32 extends insider_trades coverage backward via a 24-month
EDGAR Form 4 backfill (S96-135 dated-split scaffolding makes this
operationally straightforward).

**Cycle 31 also surfaced** S96-141-W2 (cik_ticker_map is empty;
OQ-C31-3 ingest from EDGAR's free company_tickers.json) and OQ-C31-4
(`INSERT … SELECT FROM <self>` no-op'd silently; use Python
clickhouse_connect.insert() workaround).

**The 9-arc:**

- ✓ cycle_v1 (Cycle 23 PARTIAL) + Cycle 27 OQ-C23-1 backport
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ✓ sector_rot_v1 (Cycle 25 PARTIAL)
- ✓ cross_asset_v1 (Cycle 26 PARTIAL; first AUTO-APPROVE)
- 🚧 form_4_insider_v1 (Cycle 28 = pagination + 3-day apply;
  Cycle 29 = 10K-cap + 5-month raw + snapshot driver; Cycle 30 = gics
  + sp500 PIT + snapshot backfill; Cycle 31 = gics PIT-anchor fix +
  snapshot re-backfill, **aggregate signal healed but baseline
  shallow per OQ-C31-1**; **Cycle 32 = 24-month insider_trades
  backfill**, then Cycle 33+ Phase B SPEC)
- ☐ short_interest_v1 (3-5 cycle ingest; FINRA URL discovery
  largest blocker)
- ☐ exec_departure_v1 (2-3 cycle ingest; EDGAR family)
- ☐ etf_flow_v1 (Path 1 BLOCKED until Q-6 resolved)
- ☐ eight_k_classifier_v1 (2-3 cycle ingest; EDGAR family)

**Cycle 32 default path (recommended):**

- Slice 1: 24-month form4 ingest in 1-month sub-runs (S96-135
  dated-split, the same scaffold Cycle 29 used for 5-month).
- Slice 2: re-run snapshot backfill (same script, same window).
- Slice 3: z-distribution re-probe + verify quantile(0.95) < 3.
- Slice 4: HANDOFF rewrite + decide if Phase B SPEC ships Cycle 33
  or further data-coverage work needed.

**Cycle 32 watch-out priority:** if Slice 1's 24-month backfill
exceeds Cycle 29's empirical 28K-trades-per-month upper bound for
any single sub-run, the S96-138 architectural batched-write fix
becomes Cycle 32 in-scope rather than deferred. Cycle 32 SPEC must
explicitly decide between dated-split-only and dated-split +
batched-writes before the first apply.

**Per the gics_sector_map PIT-anchor requirement (S96-141):** on
database wipe / re-bootstrap, the Slice 1b INSERT must be re-run.
Reproduction one-liner is in this HANDOFF's "Cycle 31 data-prep
one-liners" section. Until OQ-C31-2 wraps this into a named TS
script, it stays a copy-paste hazard.

**Worker-spawn / SPEC-on-main / worktree watch-outs** carried over
from Cycle 27-30 — see HANDOFF Cycle 27-30 Watch-outs sections + the
new S96-141..S96-141-W2 watch-outs above.
