---
status: accepted
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: adr
slice_id: adr-042
---

# ADR-042 — Per-sector daily rate baseline computation strategy for G2 aggregate-panel activation — RESEARCH note

**Status:** RESEARCH (pre-ADR, pre-SPEC) — informs the ADR-042 text that will land
in [`docs/decisions/README.md`](../decisions/README.md) and the small SPEC delta
that follows the operator's chosen option.
**Date:** 2026-05-20 (session 94 #5)
**Owner:** Vector Core
**Resolves:** HANDOFF OQ-G2-1 — *"Per-sector daily cluster-rate / event-rate /
departure-rate baseline computation strategy for aggregate-panel activation"* —
the sole remaining blocker for G2 (aggregate-panel activation across the F4,
EK, and XD composites).
**This note explicitly does NOT pick an option.** Per HANDOFF S94-7 the choice is
operator-decided; the next session writes the picked option's SPEC + CODE slice.

**Upstream SPECs that consume the chosen strategy:**
- [`docs/specs/executive-departure-signal.md`](executive-departure-signal.md) §5.2
  + §11 — XD aggregate per-sector departure-rate z-score.
- [`docs/specs/event-driven-filings-processor.md`](event-driven-filings-processor.md)
  §5.2 (8-K event-rate z-score) + §5.3 (Form 4 cluster-buy rate z-score).
- All three share the same trailing-2y per-sector rate computation shape;
  whatever ADR-042 picks applies byte-equally to all three composites.

**Canon (Tier 1):**
- López de Prado, *Advances in Financial Machine Learning* (2018), **Ch 1 §1.2
  ("look-ahead bias") + Ch 11 ("the dangers of backtesting")** — the
  point-in-time-correctness discipline that frames the EDGAR-amendment
  consideration in §3 of this note.
- Bailey & López de Prado (2014), *The Deflated Sharpe Ratio* — small-sample
  cautions that motivate the `MIN_Z_BASELINE = 30` floor (load-bearing across
  all three composites per EK-7 / E-14 / EDF-7).

**Canon-thin disclosure.** The recompute-vs-persist tradeoff itself is a
**systems-engineering** decision, not a methodology-canon decision. AFML §11
(backtest validation) is silent on the storage layer; Pardo §6 (walk-forward
analysis) assumes the rate series exists but does not specify how to materialize
it. Per Vector Core rule: *"when the canon is thin, say so out loud rather than
fabricating depth."* The recommendation framing below is engineering judgment +
project-local precedent, not canon.

---

## 1. Scope of ADR-042

For each of the three G2-blocked composites (XD, EK, F4), the daemon needs a
**trailing 2-year per-sector daily rate series** to compute today's z-score:

```
z_s_today = (rate_s_today − mean(rate_s_trailing_2y)) / stddev(rate_s_trailing_2y)
```

where `rate_s_t` is sector s's composite-specific rate on day t (XD =
departure-rate / 90d-window-count over SP500 sector members; EK = distinct
(ticker, accession) event-rate; F4 = cluster-buy rate). All three share the
same computation shape — only the numerator definition differs per composite.

The series has **~503 trading days × 11 GICS sectors = ~5,533 daily rate
points** per composite, refreshed every daemon cycle (currently daily).

**ADR-042 picks the storage + computation strategy.** Three pre-enumerated
options below.

**Out of scope for ADR-042:**
- The z-score floor (`MIN_Z_BASELINE = 30`) — already locked in
  EK-7 / E-14 / EDF-7.
- The rate-window length (90 calendar days for XD / EK; 30/90 for F4) —
  already locked in E-3 / EK-3 / F4 SPEC entries.
- Per-ticker sector annotation — already shipped in s94 #2/#3/#4 G1 arc;
  this slice handles the AGGREGATE layer only.
- Cross-composite z-score combination — out of scope; each composite has its
  own panel.
- EDGAR-amendment retroactive correction policy (touched in §3 watch-out but
  not policy-fixed here; see §6 OQ-G2-1-followup).

---

## 2. Option enumeration

### Option (a) — Re-compute on-the-fly from raw event history per daemon cycle

Each daemon cycle, the composite repository issues a single CH query of the
shape:

```sql
-- shape, not exact; per-composite numerator differs
WITH daily_sector_rate AS (
  SELECT
    sm.sector AS sector,
    toDate(e.event_ts) AS day,
    countDistinct(e.ticker, e.accession_number) AS event_count,
    /* sector_size_s_t comes from the PIT constituents panel join */
    countDistinct(c.ticker) AS sector_size,
    event_count / nullIf(sector_size, 0) AS rate
  FROM quantlab.<events_table> AS e
  ASOF JOIN quantlab.gics_sector_map AS sm
    ON sm.ticker = e.ticker AND sm.as_of <= toDate(e.event_ts)
  ASOF JOIN quantlab.sp500_constituents AS c
    ON c.ticker = e.ticker AND c.as_of <= toDate(e.event_ts)
  WHERE toDate(e.event_ts) BETWEEN today() - INTERVAL 2 YEAR AND today()
  GROUP BY sector, day
)
SELECT sector, avg(rate) AS baseline_mean, stddevSamp(rate) AS baseline_std
FROM daily_sector_rate
GROUP BY sector;
```

Today's z-score is then `(rate_s_today − baseline_mean) / baseline_std`. No
new schema; the rate series exists only as a derived intermediate inside the
daemon's evaluation transaction.

**No backfill needed.** As soon as the raw events table has trailing-2y
coverage (which the operator-run first-apply EDGAR ingest delivers per the
existing s93 ingest scripts), z-scores fire on cycle 1. `MIN_Z_BASELINE = 30`
clears immediately because the trailing-2y window already has ~503 days × 11
sectors ≈ 5,533 daily rate prints in dense sectors.

### Option (b) — Persist a sibling table; daemon reads back trailing 2y

Three new tables (one per composite) of the shape:

```sql
CREATE TABLE quantlab.<composite>_sector_rate_baseline (
  composite       LowCardinality(String),  -- 'xd' | 'ek' | 'f4'
  sector          LowCardinality(String),
  snapshot_date   Date,
  rate            Float64,
  sector_size     UInt32,                  -- denominator at snapshot time
  event_count     UInt32,                  -- numerator at snapshot time
  ingested_at     DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (composite, sector, snapshot_date)
SETTINGS index_granularity = 8192;
```

Daemon cycle path: at end-of-cycle for each composite, INSERT one row per
(sector, today). Z-score for today uses a separate read:

```sql
SELECT sector, avg(rate) AS baseline_mean, stddevSamp(rate) AS baseline_std
FROM quantlab.<composite>_sector_rate_baseline FINAL
WHERE composite = '<xd|ek|f4>'
  AND snapshot_date >= today() - INTERVAL 2 YEAR
  AND snapshot_date < today()         -- exclude today to avoid self-reference
GROUP BY sector;
```

The historical rate series is **write-once**: once a `(composite, sector, day)`
row is materialized, subsequent ingest of amended source events does NOT
rewrite it. The trailing-2y baseline therefore reflects the daemon's
view-at-the-time, not the latest restated truth.

**Requires a one-time backfill script** that walks the events table once at
ADR-042 deployment, computes the trailing-2y of (sector, day) rates, and
writes them. Without the backfill, the baseline table is empty on day 1 and
takes 30 trading days before `MIN_Z_BASELINE` clears — see Option (c) for
that behavior.

### Option (c) — Hybrid: same schema as (b), but no backfill — daemon writes one row per cycle, accepts cold-start

Schema identical to Option (b). Daemon writes one new row per
(composite, sector) per cycle from cycle 1 forward. NO one-time backfill of
trailing-2y history.

Consequences:
- Day 1: baseline table contains 1 print per sector → `count < MIN_Z_BASELINE`
  → all z's = null → `*_cluster_*_flag = false` across all sectors.
- Day 30: baseline table contains 30 prints per sector → first sectors hit
  the floor; z's start firing.
- Day 730: baseline table contains the full trailing-2y → matches Option (a)
  on rolling-window content (modulo the EDGAR-amendment freeze-vs-live
  difference from §3).

Operator gets the "clean room start" property — no historical inference of
rates the daemon never actually saw — in exchange for ~30 trading days of
G2 cold-start across all three composites.

---

## 3. Tradeoff matrix

| Dimension | (a) Recompute on-the-fly | (b) Persist + backfill | (c) Persist, no backfill |
| --- | --- | --- | --- |
| **CH read amplification per daemon cycle** | ~5,533 daily rate computations under a 2y GROUP BY + ASOF JOIN to PIT constituents + GICS map. Per composite, per cycle. **Heaviest.** Estimated ~100-500 ms per composite on the existing 8192-granularity tables; ~0.3-1.5 s per cycle across three composites. | One ~8 KB SELECT of 5,533 pre-materialized rows (11 sectors × 503 days × ~1.4 B/row). **Lightest.** Estimated <50 ms per composite, <200 ms per cycle across three. | Identical to (b) once warm; same <200 ms/cycle. |
| **CH write amplification per daemon cycle** | None (no new rows). | 11 sector rows per composite per cycle = 33 rows/cycle total. Trivial. | Same as (b). |
| **Cold-start window** | **0 trading days** if the operator runs the existing trailing-2y EDGAR / Form 4 backfills before first daemon cycle (which the EK / F4 / XD A1 SPECs already require for first-apply ingest). | **0 trading days** with the new baseline-backfill script run as part of deployment. | **~30 trading days** before `MIN_Z_BASELINE` first clears for any sector; **~120-180 trading days** before the baseline is statistically robust under Bailey-LdP small-sample guidance. |
| **Schema cost** | Zero new tables. Zero new migrations. Zero new ingest scripts. | Three new tables OR one unified table (recommendation: one unified table with `composite` discriminator column — see §4). One new migration. One new backfill script. | Same as (b) minus the backfill script. |
| **Backfill simplicity** | N/A — nothing to backfill. | New idempotent script `scripts/backfill_sector_rate_baseline.ts` per HANDOFF data-source-policy discipline (schema validation + dry-run + apply gating). ~5,500 rows × 3 composites = ~16,500 INSERTs; runs in seconds. Re-runnable. | N/A — no backfill by design. |
| **Point-in-time correctness under late-arriving EDGAR amendments** | **Re-derived every cycle.** A late EDGAR amendment that changes a past day's event count silently mutates the baseline mean/std on the NEXT daemon cycle. Today's z-score uses the latest-known truth, not the daemon's view-at-the-time. Forward-bias-clean by construction (no use of future-of-today data), but historically inconsistent. | **Frozen.** Backfilled rates reflect the source state at backfill time. Subsequent cycles never re-write historical rate rows. Operationally replayable. | **Frozen.** Same as (b). |
| **Replayability for Phase B independence tests** | Hard. To replay a past daemon cycle's z-score, you'd need a frozen snapshot of the events table as-of that cycle's run-time. The existing events tables are append-only but EDGAR amendments DO produce new rows; ASOF reconstruction is possible but expensive. | Trivial. Read `<composite>_sector_rate_baseline FINAL WHERE snapshot_date < <replay_date>` and recompute z from the frozen rate series. | Trivial (same as (b)) for any day after the cold-start window cleared. |
| **Operator-facing observability** | The rate series exists only as an intermediate; cannot be inspected post-hoc without re-running the query. | The rate series IS the table; `SELECT * FROM ... ORDER BY composite, sector, snapshot_date DESC LIMIT N` is the inspection path. Plays into the operator-morning-brief panels naturally. | Same as (b) for days after first write. |
| **Composability with future composites** (13D/13G arc, sell-cluster sector aggregation per S93-44) | New composite ⇒ new GROUP BY query in its repository. No shared infrastructure. | New composite ⇒ same baseline table, new `composite` discriminator value. Backfill script extended once. | Same as (b); new composite accepts its own 30-day cold-start. |
| **Migration reversibility** | Trivial — no migration to reverse. | Reversible by DROP TABLE (the events table is the source of truth; baseline can be regenerated). | Same as (b). |
| **Daemon-cycle latency budget** | Adds ~0.3-1.5 s per cycle to a daily-cadence daemon currently running well under its budget. **Not a bottleneck today; could become one if daemon cadence promotes to event-driven (Phase B-gated per E-9-DEPLOY).** | <200 ms — negligible. | <200 ms — negligible. |
| **Implementation slice size** | Smallest. One method per composite repository (~30 LOC) + 3-5 unit tests per composite + 1 EXPLAIN-PLAN gate. ~150 LOC + ~12 tests total across three composites. | Largest. Shared baseline table migration (~120 LOC + ~25 tests, mirroring `migrate_create_gics_sector_map.ts` structure) + backfill script (~150 LOC + ~15 tests) + three composite repository wirings (~30 LOC + ~12 tests each, mirroring s94 #2/#3/#4 G1 arc). ~450 LOC + ~85 tests total. | Same as (b) minus the backfill script (~300 LOC + ~70 tests). |

---

## 4. Cross-cutting design notes (apply to whichever option is picked)

### 4.1 Unified table vs three sibling tables (if Option b or c)

If the operator picks (b) or (c), strong recommendation to use **one unified
table with a `composite` discriminator column** rather than three sibling
tables. Rationale:

- One migration, one backfill script, one daemon write helper, one operator
  inspection query. Three sibling tables triple the maintenance surface
  without adding value.
- ClickHouse `LowCardinality(String)` for `composite` keeps the discriminator
  ~1 byte after dictionary encoding; the storage tax is zero.
- A future fourth composite (13D/13G, sell-cluster sector aggregation per
  S93-44) adds one discriminator value + one INSERT — no schema change.
- Pattern mirrors `quantlab.gics_sector_map` from s94 #1 G1-A1 (shared infra
  for three downstream composites).

### 4.2 Reuse of the s94 #1 shared GICS helper (Option a only)

If Option (a) is picked, the rate-computation query needs to join to
`quantlab.gics_sector_map` for the sector denominator. The repository-level
sector lookup already lives in
[`src/server/gics_sector_repository_helper.ts`](../../src/server/gics_sector_repository_helper.ts)
(per S94-12 rule-of-three extraction). However, the helper currently returns
per-ticker sector lookups (`Map<ticker, GicsSectorEntry>`), not a per-day
sector-membership panel. Option (a) needs a **new helper function** in the
same module — e.g., `readSectorMembershipPanel(asOf_start, asOf_end)` —
returning the (sector, day, member_count) panel used for the rate denominator.

Estimated marginal helper cost: ~80 LOC + ~6 tests (similar shape to the
existing helper).

### 4.3 EDGAR-amendment policy (newly opened follow-up question regardless of pick)

The §3 row "Point-in-time correctness under late-arriving EDGAR amendments"
surfaces a question the v1 SPECs don't address directly. EDGAR amendments are
**rare but real** for 8-K Item 5.02 (issuers occasionally amend with
additional officer-list detail) and **more common** for Form 4 (insiders
correct trade prices, share counts, transaction codes). The amended filing
gets a NEW accession number AND a NEW `acceptedAt` timestamp; the original
remains in EDGAR.

Whichever ADR-042 option is picked, a follow-up open question opens (call it
**OQ-G2-2** for tracking):

- Should amendments re-write the day's rate, or augment, or be ignored?
- If Option (a) is picked, this becomes the default behavior (amendments
  re-write baseline silently); ADR-042 should pin whether that's intentional.
- If Option (b) or (c) is picked, the question becomes: does the daemon
  detect new amendments and rewrite the baseline row, or is the baseline
  frozen at first-write? Frozen is the safer default; rewrite needs a
  separate ADR.

ADR-042 only needs to pin the **default** amendment behavior; the
forensic-tooling question (how does the operator inspect amendment impact)
is a deferred Bucket-3 enhancement.

### 4.4 `MIN_Z_BASELINE = 30` interaction

The floor is enforced at z-computation time regardless of which option fires.
The relevant question is **when does the floor first clear**:

- Option (a) with backfilled events table: cycle 1 — clears immediately
  for any sector with ≥30 days of nonzero rates in the trailing-2y window.
- Option (b) with backfilled baseline table: cycle 1 — same as (a).
- Option (c): ~30 trading days after first cycle; sectors with sparse
  activity (e.g., Utilities in F4 insider activity) may take longer.

### 4.5 Daemon-cycle ordering (affects all options)

Today's z-score should exclude today's own rate from the baseline (to avoid
the trivial self-reference where rate_t is one of the points used to compute
mean/std). The CH query in §2 Option (a) already includes the proper
`< today()` clause; Option (b)/(c)'s read query needs the same predicate.
SPEC delta should pin this in the test list.

---

## 5. What the operator's choice actually optimizes for

Frame the decision as: **which property matters most for the next 12 months
of G2 operation?**

- **"I want G2 live this week with the smallest possible deployment surface
  + zero new schema"** → **Option (a)**. Smallest slice; ships fastest;
  acceptable read amplification under daily-cadence daemon; no backfill
  script; no migration. The EDGAR-amendment quirk is a known wart but
  operationally rare. Best if you expect to evolve the rate formula in
  the next ~6 months (Phase B cadence promotion, F4 v2 CMP classifier
  layering, etc.) — schemaless flexibility wins.

- **"I want G2 operationally replayable + frozen historical rates for
  Phase B independence tests"** → **Option (b)**. Heavier deployment slice
  (~3x LOC of Option a), but the baseline table doubles as a forensic
  artifact + composable infra for the gap-#7 v2 13D/13G arc + sell-cluster
  sector aggregation arc. Best if you expect Phase B tests to be the next
  big validation step and want frozen-rate guarantees for those tests.

- **"I want operational replayability AND a clean-room start where the
  daemon never infers history it didn't see"** → **Option (c)**. Same
  infra as (b), but accept the ~30-day cold-start as a feature: the rates
  reflect ONLY the daemon's lived experience. Best if you're philosophically
  uncomfortable with the backfill script's implicit "this is what the
  daemon WOULD have seen" assertion. Operationally, the 30-day cold-start
  means G2 cluster flags don't fire until ~mid-June 2026 across all three
  composites.

**The three composites do NOT need to share an option.** ADR-042 could pin
Option (a) for F4 (smallest events table → smallest recompute cost) and
Option (b) for XD + EK (heaviest events tables → biggest read-amplification
savings). Mixed picks add complexity, but they're available.

---

## 6. Open questions for the chosen-option SPEC stage

(Per the Vector Core canon, the RESEARCH note flags what the SPEC must
resolve. These apply specifically once the operator picks (a), (b), or (c).)

1. **PIT-correctness of the constituents JOIN.** The denominator
   `sector_size_s_t` requires the SP500 constituents AS-OF day t, not today.
   `quantlab.sp500_constituents` already supports the ASOF JOIN per the
   existing s73 PIT panel infrastructure; the SPEC needs to test that the
   trailing-2y window correctly picks historical sector members (not today's
   panel applied retroactively).
2. **Sector-membership treatment of mid-window swaps.** If ticker X was in
   the Energy sector for the first 6 months of the window and got
   reclassified to Materials (Wikipedia GICS revision), how is X's
   contribution to each sector's daily rate counted? Recommendation:
   strict PIT — X contributes to Energy's rate on days it was Energy and
   Materials's rate on days it was Materials. Test pins this.
3. **Empty-sector days.** For sparse sectors (e.g., Utilities in F4 insider
   buys), most days have rate = 0. The baseline `stddevSamp` over 503 days
   of mostly-zeros yields a small denominator → today's first nonzero rate
   produces a large z. Mitigation: floor the z-magnitude OR require a
   minimum-nonzero-count in the trailing-2y baseline ABOVE the 30-floor.
   This is a SPEC decision per the chosen option; flag for SPEC stage.
4. **Daemon-cycle log line shape.** Each composite needs a one-line cycle
   log emit like `[xd-aggregate] sectors_with_z=11/11 floor_cleared=10/11
   max_z=Energy:2.34 cluster_flag=true`. Format pin for SPEC.
5. **Brief panel surface for the active baseline-window state.** The s94
   #2/#3/#4 footers currently say "Aggregate-cluster panel awaits OQ-G2-1
   ADR." Once ADR-042 lands, the footer needs replacement wording per S94-14
   coordinated triple-edit. The chosen-option SPEC pins the exact wording.
6. **OQ-G2-2 (newly opened per §4.3): amendment behavior.** Once Option
   (a)/(b)/(c) picks, the amendment-handling default needs an explicit pin
   (silent re-write under (a); frozen baseline under (b)/(c)). Whether to
   open ADR-043 for the deeper amendment-detection tooling is itself a
   deferred decision.

---

## 7. What ships NOW vs. what ships LATER

### Ships NOW (this RESEARCH note)

- The option enumeration, tradeoff matrix, and surfacing to operator.
- HANDOFF rewrite that pins ADR-042 as the next-default and removes the
  S94-14 footer-coupling note's "blocked on operator decision" wording
  once the decision is made.

### Ships AFTER operator picks (the next slice)

1. **ADR-042 text** in `docs/decisions/README.md` — the pinned decision +
   one-paragraph rationale.
2. **Companion SPEC** `docs/specs/gics-sector-baseline-computation.md` —
   contracts, function signatures, test list (per the chosen option).
3. **G2-A1 / G2-A2 / G2-A3 slice triple** — repository wiring for F4 / EK
   / XD per S94-14 coordinated atomic triple-edit (footer wording +
   composite-tagline + repository annotations + brief panel surface).
4. **If Option (b)**: migration script + backfill script + their tests.
5. **If Option (c)**: migration script + its tests (no backfill).
6. **If Option (a)**: new helper function in
   `gics_sector_repository_helper.ts` for the membership-panel read +
   tests.

---

## 8. Watch-outs

- **Do not auto-pick.** Per HANDOFF S94-7 explicit framing, this ADR is
  operator-decided. The next session presents this note + waits for the
  pick before writing the chosen option's SPEC. The Vector Core canon-thin
  autonomous-resolution rule applies to methodology forks, NOT to
  systems-engineering forks where the operator's preference between
  schema-cost vs read-amplification matters more than the canon.
- **The recommendation in §5 is framed as "what matters most," not as a
  ranked preference.** All three options are operationally viable. The
  pushback in §5 against Option (c)'s 30-day cold-start is mild — it's a
  real cost, but for a Layer-0 informational composite (not yet wired into
  any tradable rule per the cycle/vol/sector/etc. pattern), the cold-start
  is operationally cheap.
- **EDGAR-amendment behavior is a real wart for Option (a).** Forensic
  replay of a past daemon cycle's z-score may produce a different number
  if EDGAR amended in the interim. Acceptable for current Layer-0
  informational use; would matter MORE if F4 or EK becomes a Phase B
  Layer-1 input to `phase1_v3`. Pin in the watch-outs of whichever ADR
  lands.
- **The shared `composite` discriminator (§4.1) is the right pattern for
  Option (b)/(c).** Three sibling tables would re-introduce the rule-of-
  three drift problem that S94-12 just solved at the helper level. Don't
  regress here.
- **The s94 #4 footers are now drift-coupled across THREE consumers per
  S94-14.** The chosen-option slice MUST land coordinated atomic triple-
  edits — section #12 footer (XD) + section #14 footer (EK) + section #15
  footer (F4) + their composite-taglines + their repository annotations.
  Single-composite incremental rollout would visibly drift the operator-
  facing wording.
- **`stddevSamp` not `stddevPop`.** The trailing-2y sample is a sample,
  not the population. Use `stddevSamp` in CH (Bessel correction). Pin in
  the SPEC test list; a regression here would be a silent z-score scale
  drift.
- **Today's rate must be EXCLUDED from the baseline.** Self-reference
  trivially deflates z-magnitude as the sample grows. The §2 Option (a)
  query and the §4.5 daemon-cycle ordering note both flag this; the SPEC
  test list pins.
- **The PIT constituents panel join can silently 0-out sectors on cold-
  start of the constituents table.** If `quantlab.sp500_constituents`
  doesn't yet have trailing-2y coverage at ADR-042-deployment time, the
  rate denominator is 0 for those days → division by 0 → null rate →
  baseline-count drops below `MIN_Z_BASELINE` → z = null. Verify
  constituents-table coverage before deploying.

---

## 9. Why this is RESEARCH, not SPEC, not CODE

Per the Vector Core canon (RESEARCH → DESIGN → SPEC → CODE), this note pins:

- **The canon** (Tier-1 citations; canon-thin disclosure for the
  systems-engineering portion).
- **The option enumeration** with the requested tradeoff matrix
  (CH read amplification, cold-start window, schema cost, backfill
  simplicity — plus PIT correctness, replayability, observability,
  composability, slice size).
- **The cross-cutting design notes** (unified table vs siblings; helper
  reuse; amendment policy; `MIN_Z_BASELINE` interaction; daemon ordering).
- **The framing for the operator's pick** (what each option actually
  optimizes for).
- **The SPEC-stage open questions** the chosen-option SPEC must resolve.
- **The PUSHBACK** on auto-picking (per S94-7) and on three-sibling-table
  drift regression (per S94-12).

It does NOT pin:
- The picked option (operator-decided per S94-7).
- The exact CH DDL for the baseline table (SPEC, only if Option b/c picked).
- The exact function signatures for the helper / daemon hook (SPEC).
- The byte-pinned test list (SPEC).
- The migration script + backfill script (CODE, only if Option b/c picked).

The next session, with this RESEARCH in context + the operator's pick,
moves directly to ADR-042 text + the chosen-option SPEC without
re-deriving any of the canon or option analysis.
