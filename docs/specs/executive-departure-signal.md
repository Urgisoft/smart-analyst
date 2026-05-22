---
status: done
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
slice_id: gap-8-executive-departure
---

# SPEC — Executive Departure Signal (exec_departure_v1)

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-19 · **Author:** Claude (Vector Core principal engineer) · **Phase:** 9-gap unfreeze (gap #8) · **Authority:** [gap doc](../obsidian/gaps/executive-departure-signal.md), Warner-Watts-Wruck 1988 *JFE*, Denis-Denis 1995 *Journal of Finance*, Lerman-Livnat 2010 *Review of Accounting Studies*
>
> **Stage in Vector Core build:** SPEC → CODE (Phase A only — informational substrate). Phase B (validation with the standard deflation pipeline — DSR, PBO, HLZ — per operator directive) deferred per the cycle-position / vol-structure / sector-rotation / cross-asset / short-interest precedent: ship informational first, validate after 60+ days OR via a dedicated backfill arc.
>
> **Lineage:** The sixth Phase-9-gap Layer-0 informational signal, after `cycle_v1` (s85), `vol_struct_v1` (s86), `sector_rot_v1` (s87), `cross_asset_v1` (s88), `short_interest_v1` (s89-s90). Same architectural template: SPEC → A1 (SEC EDGAR ingest) → A2 (pure composite + tests) → A3 (CH snapshot table) → A4 (repository + daemon hook) → A5 (morning brief section).
>
> **Canon-thin caveat.** The supporting literature for *return predictability* of executive departures is thinner than for short-interest (Diether-Lee-Werner) or for volatility-term-structure (Bollerslev-Tauchen-Zhou). The gap doc explicitly flags this. Three forks below (E-2 type classification, E-3 rolling window, E-5 severity weighting) were resolved under the CLAUDE.md autonomous-execution canon-thin three-criterion test (canon foundations + methodology rigor + minimum free parameters). v1 is conservative-by-design: zero classification heuristics, zero role-weighting, zero free parameters beyond the |z|>2 aggregate threshold inherited from the four prior Layer-0 composites.

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the Layer-0 informational substrate with executive-departure signals at two scopes:
   - **Per-stock**: surface `executive_departure_flag` and `executive_appointment_flag` on each ticker in the equity-midcap watch universe, sourced from SEC EDGAR 8-K filings tagged with Item 5.02 ("Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers"). Each flag is a binary: any qualifying 8-K Item 5.02(b)/(c) within a trailing 90-calendar-day window.
   - **Aggregate**: surface `executive_cluster_departure` flag at the SPDR-sector slicing of the SPY 500 PIT constituent panel, z-scored against trailing 2y history of sector departure-rate. Cluster departures within a single sector are the gap-doc's primary aggregate signal ("Cluster of departures from same company = strong sell signal" generalized to sector-cluster).
2. Persist daily snapshots to `quantlab.executive_departure_snapshots` so the brief and (eventually) Phase B independence tests + deflation-pipeline validation can read history.
3. Surface a section in the morning operator brief (section #12, appended last to preserve byte-equal-stdout protection on sections #1-#11).

**Non-goals:**

1. **No `phase1_v3` modification.** The aggregate flag does NOT add a category in v1 (E-1 lock); promotion to classifier input gates on Phase B independence test + a new ADR. Matches the cycle/vol/sector/cross-asset/short-interest posture.
2. **No universe-filter gating.** Per Phase 9+ gap-inventory README principle #5 ("informational-first before gating"), per-stock flags are LOGGED alongside trades — strategies + universe filter consume them as features (or ignore) but no hard exclusion happens in v1.
3. **No paid data sources.** SEC EDGAR is the canon-load-bearing free source; LinkedIn (paid API), pre-IPO research firms, and CapIQ executive-movement feeds are out-of-scope.
4. **No Form 4 inclusion.** The gap doc emphasizes insider-selling-accelerations-as-departure-leading-indicator, but Form 4 has its own academic canon (Seyhun 1986; Lakonishok-Lee 2001; Cohen-Malloy-Pomorski 2012) and its own data path. Per the **E-11 fork resolution** below, Form 4 is queued into gap #7 event-driven-filings-processor or a v2 ADR. v1 reads 8-K Item 5.02 only.
5. **No free-text NLP classification.** The 8-K Item 5.02 free-text body (the prose explaining *why* the executive departed) is parseable but noisy — regex on "retire" vs "resign" vs "terminated" introduces brittle text-pattern dependencies. Per the **E-2 fork resolution** below, v1 uses the SEC-structured sub-item codes only (5.02(b) = officer departure, 5.02(c) = new officer appointment). Voluntary-vs-involuntary classification deferred to v2.
6. **No severity weighting.** Per the **E-5 fork resolution** below, v1 treats all 5.02(b) events equally regardless of role (CEO vs SVP). Role-weight tables introduce N free parameters without canon backing.
7. **No dashboard React panel in v1** (carry from S-VOL-4 / S-SR-4 / S-CA-4 / S-SI-9 — operator attention budget is finite).
8. **No backfill of pre-existing historical 8-K events.** SEC EDGAR's full-text search API is forward-from-request-date in v1. Backfill IS possible — EDGAR's historical archive goes back to 1994 — but is operator-deferred (same posture as the cycle-position Phase B backfill arc).

---

## §2 · Decisions (locked at SPEC time)

| ID | Decision | Rationale |
|----|----------|-----------|
| **E-1** | Data source: **SEC EDGAR 8-K filings filtered to Item 5.02** (free, official, real-time). Item 5.02 is the SEC's structurally-encoded code for "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers." v1 reads sub-items 5.02(b) (officer departure) + 5.02(c) (new officer appointment); 5.02(a)/(d)/(e) are OUT-OF-SCOPE in v1. | Free + pre-authorized per CLAUDE.md data-source policy (SEC EDGAR listed explicitly). 8-K Item 5.02 is the SEC-mandated disclosure for executive changes (Sarbanes-Oxley §409 real-time disclosure requirement, codified at 17 CFR 249.308). 4-business-day filing deadline = real-time relative to FINRA short-interest's 8-bd lag. |
| **E-2** | Type classification: **SEC-structured sub-item code only.** `executive_departure_flag` fires on any 8-K Item 5.02(b) within trailing 90 calendar days. `executive_appointment_flag` fires on any 8-K Item 5.02(c) within trailing 90 calendar days. NO free-text NLP / regex on the filing body to distinguish voluntary vs involuntary departures. | Three-criterion autonomous-resolution: (1) **Canon foundations** — structurally-encoded sub-items have zero ambiguity; free-text regex is fragile (SEC can change boilerplate). (2) **Methodology rigor** — no in-sample tuning needed; sub-item code is a discrete observation. (3) **Free parameters** — zero (vs N for a regex/NLP library). Voluntary-vs-involuntary distinction (gap doc OQ) deferred to v2 with explicit ADR. |
| **E-3** | Rolling window for "recent event": **90 calendar days.** Per-stock flags fire if any qualifying 8-K is in `[D - 90d, D]`. | Gap doc explicitly says "few high-value events per quarter" — 90d matches the quarter cadence operationally. Zero academic anchor for the precise number; defaulting to one quarter is the simplest non-tuned choice. Matches the cycle-position 90d retune-window convention already in the codebase. |
| **E-4** | Aggregate clustering metric: **departure-rate per sector**, z-scored against 2y trailing baseline. `departure_rate_s(t) = (# 5.02(b) filings in sector s ∩ SPY-500 ∩ trailing 90d) / (# SPY-500 constituents in sector s)`. The aggregate flag `executive_cluster_departure` fires on any sector with `|z| > 2.0` against the trailing 2y baseline of the same rate. | Matches the short-interest S-SI-11 z-score pattern (precedent + low free parameters). Departure-rate normalizes across sectors of different size (Information Technology has ~70 SPY components; Utilities has ~30). Per-sector z-score isolates sector-specific cluster departures from market-wide noise. |
| **E-5** | **No severity weighting.** All 5.02(b) events count as a single departure regardless of role (CEO=CFO=SVP=Director). | Three-criterion: (1) Canon-thin — Warner-Watts-Wruck 1988 documents abnormal returns around CEO turnover but does NOT compare CEO vs other-C-suite turnover magnitudes; (2) zero in-sample tuning; (3) zero free parameters. Role-weight table would be 6-10 free parameters without academic backing. Gap doc OQ "How to weight different roles?" RESOLVED: don't, in v1. v2 ADR can add weighting if Phase B reveals a value-add. |
| **E-6** | **Per-stock universe:** equity-midcap universe (~60 tickers, matches existing daemon watch list, matches the short-interest A4 precedent). **Aggregate universe:** SPY 500 PIT constituents (per `quantlab.sp500_constituents`), sliced by GICS sector via the SPDR-sector mapping already maintained in the cycle/cross-asset/sector-rotation composites. | Per-stock signal is narrowly applied; aggregate is broad. Different universes for different scopes is correct — the per-stock signal needs to be tracked on the tickers we actually trade, the aggregate signal needs broad coverage. Gap doc's "top 50 tech + top 25 healthcare" is a paid-research-firm-style framing that doesn't match our existing infrastructure; SPY-500 PIT + GICS-sector slicing is the canon-load-bearing choice. |
| **E-7** | **8-K filing date is the snapshot's as-of-date anchor with no lag.** Item 5.02 filings are due within 4 business days of the triggering event (17 CFR 249.308) and are typically filed within 1-2 business days. The daemon snapshot dated T reads all 8-K Item 5.02 filings whose **acceptance date (`accepted` field on the EDGAR submission record) ≤ T**. No look-ahead-leak risk: the acceptance date is the wall-clock moment EDGAR ingested the filing and made it public. | Contrast with short-interest S-SI-5 settlement-date-aware 8bd lag. 8-K is real-time + pre-publication-restricted, so there is no equivalent leak vector. The acceptance-date filter (NOT the period-of-report date, which can be retroactively dated to the triggering event up to 4bd earlier) is the load-bearing protection against accidentally backfilling future filings into a historical snapshot. |
| **E-8** | **CIK-to-ticker resolution:** SEC EDGAR submissions API (`data.sec.gov/submissions/CIK{cik}.json`) returns the issuer's current ticker(s) + `formerNames`. Cached in CH `cik_ticker_map` table (reusing the same pattern as `cusip_ticker_map` from short-interest A1). Ticker changes are reconciled by following the `formerNames` list. | EDGAR-natural key is CIK (Central Index Key); internal symbol space is ticker. Same shape as the short-interest CUSIP-to-ticker resolution. Cache avoids re-fetching submissions JSON; `formerNames` handles ticker swaps from mergers / re-listings. |
| **E-9** | Snapshot version stamp: `exec_departure_v1`. Bumps on any threshold / window / aggregator / universe-definition change per the Layer-0 convention. | Bump triggers: rolling window (90d → 60d or 120d), aggregate threshold (\|z\| > 2.0 → \|z\| > 2.5), universe (equity-midcap → SPY 500), sub-item-code scope (add 5.02(a) or drop 5.02(c)). Established pattern across all five prior Layer-0 composites. |
| **E-10** | Brief section = **#12**, appended last to preserve byte-equal-stdout protection on sections #1-#11 (cycle-position #7, vol-structure #8, sector-rotation #9, cross-asset #10, short-interest #11). | Established pattern across all five prior Layer-0 informational composites. Section-add-at-tail is the byte-equal-protection invariant. |
| **E-11** | **Form 4 inclusion: OUT-OF-SCOPE in v1.** The gap doc's "Form 4 selling pattern detection" framing is a legitimate but separate signal with its own academic canon (Seyhun 1986; Lakonishok-Lee 2001; Cohen-Malloy-Pomorski 2012). Form 4 is queued into the gap #7 event-driven-filings-processor scope or a future v2 enhancement ADR. | Three-criterion: (1) Combining 8-K + Form 4 in a single composite creates multi-source aggregation without a single load-bearing canon source. (2) Form 4 deserves its own SPEC with its own free-parameter accounting (cluster size, price-direction filtering, opportunistic-vs-routine classifier — Cohen-Malloy-Pomorski's specific technique). (3) Path-α (8-K only) has fewer free parameters than path-β (8-K + Form 4 combined). Single-source v1 is simpler + more honest. |
| **E-12** | Snapshot cadence: daemon-daily, even though 8-K filings are sparse (few events per company per year). The composite re-evaluates per-stock flags + aggregate sector z-scores on every daemon run; on days with no new 5.02 filings, the rolling-window state is unchanged from the prior snapshot (events naturally age out of the 90d window). | Matches the daemon's daily snapshot pattern for all other Layer-0 composites. The "stale-on-non-event-day" behavior is honest (the snapshot reflects the state of the 90d window as of that wall-clock day; events still in the window from 89d ago will roll out tomorrow). |
| **E-13** | **Per-ticker baseline = none.** Unlike short-interest (continuous SIR time series with a per-ticker z-score baseline), departure events are sparse — most tickers have 0-1 5.02(b) filings per year. A per-ticker z-score against trailing 2y would be ill-defined (division by zero or near-zero stddev). v1 uses binary flags only at the per-stock layer; the z-score baseline lives at the sector-aggregate layer only. | Acknowledges the data-shape difference vs short-interest. The per-stock signal is necessarily coarser (binary in/out of window) than short-interest's per-stock continuous SIR. Consistent with Warner-Watts-Wruck 1988's event-study methodology (binary event indicator + abnormal returns measured around the event date) rather than continuous-signal methodology. |
| **E-14** | **Minimum baseline floor for aggregate z-score:** `MIN_Z_BASELINE = 30` prints (matches cross-asset / sector-rotation / short-interest constant). Below the floor, `aggregate_z = null` and `executive_cluster_departure = false`. | The 30-print floor protects against early-life z-scores in newly-bootstrapped histories. Matches the prior four Layer-0 composites byte-for-byte. |

---

## §3 · Component diagram

```text
            ┌──────────────────────┐
            │ SEC EDGAR            │
            │   - Full-text search │     pre-authorized per
            │     API (efts...)    │     CLAUDE.md data-source policy
            │   - Submissions API  │
            │     (data.sec.gov)   │
            └─────────┬────────────┘
                      │ ≤ 4 business-day filing deadline (Sarbanes-Oxley §409);
                      │ typically 1-2 bd in practice
                      ▼
            ┌──────────────────────┐
            │ scripts/             │   A1 — ingest unit
            │   sec_edgar_8k_      │   - poll EDGAR for 8-K filings
            │   item_5_02_ingest   │   - parse Item 5.02 sub-item codes
            │   .py                │   - resolve CIK → ticker via EDGAR
                      ▼             │     submissions API + formerNames
            ┌──────────────────────┐
            │ quantlab.            │
            │   executive_         │   - one row per 8-K Item 5.02 filing
            │   departures         │   - ReplacingMergeTree(version) keyed
            │   (per-event)        │     on (cik, accession, sub_item_code)
            └─────────┬────────────┘
                      │ daemon read
                      ▼
            ┌──────────────────────┐
            │ src/server/          │   A2 — pure composite
            │   executive_         │   - per-ticker 90d rolling-window flags
            │   departure.ts       │   - sector departure-rate
            │                      │   - aggregate sector z-scores
            │                      │   - flag derivation per E-2 / E-4
            └─────────┬────────────┘
                      ▼
            ┌──────────────────────┐
            │ quantlab.            │   A3 — snapshot table
            │   executive_         │   - one snapshot row per daemon run
            │   departure_         │   - ReplacingMergeTree(version)
            │   snapshots          │     keyed on (snapshot_date)
            └─────────┬────────────┘
                      │ daemon write + brief read
                      ▼
            ┌──────────────────────┐
            │ scripts/             │   A4 — daemon hook
            │   daily_signal_      │   step 1i — between short-interest (1h)
            │   daemon.ts          │   and the cells/bundles section (§2)
            └─────────┬────────────┘
                      ▼
            ┌──────────────────────┐
            │ src/server/          │   A5 — brief panel
            │   operator_brief*    │   section #12
            │   .ts                │
            └──────────────────────┘
```

---

## §4 · Inputs (per E-1 / E-7 / E-8)

| Source | Field | CH destination | Notes |
|--------|-------|----------------|-------|
| SEC EDGAR full-text search API (`efts.sec.gov/LATEST/search-index`) | accession number | `executive_departures.accession` | Unique per filing; primary key. |
| SEC EDGAR full-text search API | CIK | `executive_departures.cik` | Issuer key; resolved to ticker via EDGAR submissions API. |
| SEC EDGAR full-text search API | form type | `executive_departures.form_type` | Always `8-K` or `8-K/A` (amendment); filter at ingest. |
| SEC EDGAR full-text search API | Item 5.02 sub-item code | `executive_departures.sub_item_code` | One of `5.02(a)`, `5.02(b)`, `5.02(c)`, `5.02(d)`, `5.02(e)`. v1 composite reads `5.02(b)` and `5.02(c)` only. |
| SEC EDGAR full-text search API | `accepted` datetime | `executive_departures.accepted_at` | The wall-clock UTC moment EDGAR accepted the filing for public dissemination. Used by the daemon to enforce real-time lag per E-7. |
| SEC EDGAR full-text search API | `periodOfReport` date | `executive_departures.period_of_report` | The triggering-event date (typically the executive's last day or the board action date). Can be up to 4bd before `accepted_at`. Used for forensic analysis only; the daemon's snapshot-as-of-D filter uses `accepted_at`, not `period_of_report`. |
| SEC EDGAR submissions API (`data.sec.gov/submissions/CIK{cik}.json`) | CIK → ticker | `cik_ticker_map.ticker` | Lazy-cached on first encounter; followed via `formerNames` for ticker swaps. |
| `quantlab.sp500_constituents` (PIT) | constituent panel as-of snapshot date | Aggregate universe | Constituent list at the SNAPSHOT date, NOT today's. |
| GICS sector mapping (existing per cycle/cross-asset/sector-rotation; SPDR-sector → GICS-sector reference table) | ticker → sector | Aggregate sector slicing | Reuses the existing mapping; no new infrastructure. |

---

## §5 · Composite formulas

### §5.1 Per-stock (per E-2 / E-3)

For each ticker T in the equity-midcap universe, as of snapshot date D:

```text
let events_t = filings(T, sub_item_code = '5.02(b)', accepted_at in [D - 90d, D])
let appts_t  = filings(T, sub_item_code = '5.02(c)', accepted_at in [D - 90d, D])

let executive_departure_flag    = (count(events_t) ≥ 1)
let executive_appointment_flag  = (count(appts_t)  ≥ 1)

let recent_departure_count_90d  = count(events_t)
let recent_appointment_count_90d = count(appts_t)
let days_since_latest_departure = if events_t.empty: null
                                  else D - max(events_t.accepted_at).date
```

**Note on event sparsity.** The 90d rolling-window count is the load-bearing per-stock measurement. Per E-13 there is NO per-ticker z-score baseline — most tickers have 0-1 5.02(b) filings per year, so a trailing-2y stddev would be ill-defined.

### §5.2 Aggregate (per E-4, E-6, E-14)

For SPY-500 constituents PIT-as-of D, sliced by GICS sector:

```text
let universe   = sp500_constituents(asOf = D)
let sectors    = distinct(gics_sector(T) for T in universe)

for each sector s in sectors:
  let sector_size_s = count(T in universe : gics_sector(T) = s)
  let events_s      = filings(T in universe : gics_sector(T) = s,
                              sub_item_code = '5.02(b)',
                              accepted_at in [D - 90d, D])
  let departure_rate_s_t = count(events_s) / sector_size_s

  let baseline_s = trailing(departure_rate_s, 2y daily)
                   # i.e., the same calc rolled daily over the trailing 2y
  if count(baseline_s) < MIN_Z_BASELINE (=30):
    z_s = null
  else:
    z_s = (departure_rate_s_t - mean(baseline_s)) / stddev(baseline_s)

  cluster_departure_s = (z_s != null) AND (abs(z_s) > 2.0)

let executive_cluster_departure = OR over sectors of cluster_departure_s
let flagged_sectors = list of (sector, z_s, departure_rate_s_t) where cluster_departure_s
```

When all sector baselines are below the 30-print floor (cold-start condition), `executive_cluster_departure = false` and `flagged_sectors = []`. Matches the cross-asset / sector-rotation / short-interest cold-start pattern.

### §5.3 Snapshot payload

```typescript
interface ExecutiveDepartureSnapshot {
  snapshot_date: Date;                                // YYYY-MM-DD
  last_edgar_query_at: Date | null;                   // wall-clock UTC of most-recent EDGAR poll
  bd_since_last_query: number | null;                 // 0-3 typical; 4+ indicates ingest stale

  // Aggregate (sector-sliced):
  flagged_sectors: Array<{
    sector: string;                                   // e.g. 'Information Technology'
    sector_size: number;                              // # SPY-500 constituents in sector at D
    departure_rate_t: number;                         // events_in_90d / sector_size
    z: number;                                        // 2y-baseline z-score
    baseline_size: number;                            // # of prints in baseline
  }>;
  executive_cluster_departure: boolean;               // ANY sector with |z| > 2.0

  // Per-ticker (equity-midcap universe):
  per_ticker_rows: Array<{
    ticker: string;
    cik: string;
    sector: string | null;                            // GICS sector if mapped, else null
    recent_departure_count_90d: number;
    recent_appointment_count_90d: number;
    days_since_latest_departure: number | null;
    executive_departure_flag: boolean;
    executive_appointment_flag: boolean;
  }>;

  // Diagnostic:
  inputs_available: { aggregate: number, per_ticker: number };
                                                      // count of valid inputs per panel
  version: 'exec_departure_v1';
}
```

---

## §6 · CH snapshot table (Phase A3 migration)

```sql
CREATE TABLE quantlab.executive_departure_snapshots (
  snapshot_date            Date,
  last_edgar_query_at      Nullable(DateTime),
  bd_since_last_query      Nullable(Int32),

  executive_cluster_departure UInt8,                  -- 0/1
  flagged_sectors_json     String,                    -- JSON-encoded array
                                                      -- (~11 GICS sectors max;
                                                      --  ~2KB typical)

  per_ticker_json          String,                    -- JSON-encoded per-ticker rows
                                                      -- (equity-midcap = ~60 rows;
                                                      --  ~20KB typical)
  inputs_available_aggregate   UInt32,
  inputs_available_per_ticker  UInt32,

  version                  LowCardinality(String) DEFAULT 'exec_departure_v1',
  ingested_at              DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, version)
SETTINGS index_granularity = 1024;
```

Per-ticker rows + flagged-sectors are stored as JSON in single columns rather than exploding into row-per-ticker child tables. Rationale: matches the short-interest A3 precedent. The daemon writes ~60 per-ticker rows + ≤11 flagged-sector rows per snapshot; row-per-ticker child tables would inflate cardinality unnecessarily for what is fundamentally a single-snapshot read pattern.

A separate source table holds the raw event stream:

```sql
CREATE TABLE quantlab.executive_departures (
  accession             String,                       -- e.g. '0001193125-26-123456'
  cik                   String,                       -- e.g. '0000320193' (Apple)
  ticker                LowCardinality(String),       -- resolved via EDGAR submissions
  form_type             LowCardinality(String),       -- '8-K' | '8-K/A'
  sub_item_code         LowCardinality(String),       -- '5.02(a)' .. '5.02(e)'
  accepted_at           DateTime,                     -- EDGAR acceptance timestamp (UTC)
  period_of_report      Date,                         -- triggering-event date
  filing_url            String,                       -- direct EDGAR URL for forensic ref
  version               LowCardinality(String) DEFAULT 'exec_departure_v1',
  ingested_at           DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (cik, accession, sub_item_code)
SETTINGS index_granularity = 1024;
```

And the CIK-ticker map (separate from `cusip_ticker_map`; CIK ≠ CUSIP):

```sql
CREATE TABLE quantlab.cik_ticker_map (
  cik                   String,
  ticker                LowCardinality(String),
  former_tickers        Array(String) DEFAULT [],     -- from EDGAR formerNames
  resolved_at           DateTime DEFAULT now(),
  version               LowCardinality(String) DEFAULT 'v1'
) ENGINE = ReplacingMergeTree(resolved_at)
ORDER BY (cik)
SETTINGS index_granularity = 1024;
```

---

## §7 · Daemon hook position

Step **1i. Executive-departure evaluation** — between short-interest (step 1h, s90) and the cells/bundles resolution (§2). Same posture as cycle-position / vol-structure / sector-rotation / cross-asset / short-interest: absent-table-safe, non-fatal, gated by `NO_MACRO || DRY_RUN`. The hook reads the latest `executive_departures` rows-as-of-D, computes the composite, writes one row to `executive_departure_snapshots`.

The chain: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → §2 cells/bundles`.

---

## §8 · Brief panel (section #12)

```text
─────────────────────────────────────────────────────────────────────────
 §12 — EXECUTIVE DEPARTURES (as of 2026-05-19, 90d rolling window)
─────────────────────────────────────────────────────────────────────────
  Aggregate (SPY 500 by GICS sector):

    cluster_departure: NO

    Top sector z-scores (2y baseline):
      Information Technology     z=+1.4σ (rate=0.057, n=70 constituents)
      Health Care                z=+0.9σ (rate=0.041, n=64 constituents)
      Financials                 z=-0.3σ (rate=0.027, n=72 constituents)
      ...

  Last EDGAR query:           2026-05-19 14:23:11 UTC (today)

  Flagged tickers (universe filtered to equity-midcap):

    executive_departure (3):
      ABCD — 1 departure, 14 days ago     [5.02(b)]
      XYZW — 2 departures, latest 41d ago [5.02(b) x2]
      PQRS — 1 departure, 67 days ago     [5.02(b)]

    executive_appointment (2):
      ABCD — 1 new appointment, 12 days ago  [5.02(c)]
      MNOP — 1 new appointment, 8 days ago   [5.02(c)]

  Universe coverage:          58/60 mid-cap tickers have current CIK mapping
                              (2 missing: TICK1 / TICK2 — CIK map TBD)
```

The flagged-tickers section truncates at the top-N most recent on each side (N=5 default per panel, matching the short-interest A5 convention). Operators can read the full list via the dashboard panel (out-of-scope for v1) or by querying `executive_departures` directly.

---

## §9 · Test plan

### §9.1 Pure-function (`scripts/tests/executiveDeparture.test.ts`)

- T-ED-1 — `executive_departure_flag` fires when exactly 1 5.02(b) event is within window.
- T-ED-2 — `executive_departure_flag` does NOT fire when latest 5.02(b) event is 91d outside window.
- T-ED-3 — `executive_appointment_flag` fires on 5.02(c); does NOT fire on 5.02(b) only.
- T-ED-4 — Per-stock 5.02(d)/(e)/(a) sub-items are ignored at the composite layer.
- T-ED-5 — `days_since_latest_departure` returns null on no qualifying events.
- T-ED-6 — Sector departure-rate computed correctly: 3 events across 30 SPY constituents in sector → rate = 0.1.
- T-ED-7 — Aggregate z-score with 30-print baseline.
- T-ED-8 — Aggregate z-score returns null when sector baseline < 30 prints (cold-start).
- T-ED-9 — `executive_cluster_departure` fires when ANY sector has \|z\| > 2.0.
- T-ED-10 — `executive_cluster_departure` does NOT fire when all sector z's are null (cold-start).
- T-ED-11 — Null per-ticker rows (missing CIK map) propagate as `null` sector, not as zero-events.
- T-ED-12 — Window boundary inclusion: event at exactly `accepted_at = D - 90d 00:00:00` IS in window; event at `D - 90d - 1s` is NOT.
- T-ED-13 — Event-deduplication: same `(cik, accession, sub_item_code)` appearing twice in the source is counted once.

### §9.2 Repository (`scripts/tests/executiveDepartureRepository.test.ts`)

- T-EDR-1..N — `writeSnapshot` round-trip with FakeClickHouse.
- T-EDR-Nplus — `readLatest` returns the most-recent snapshot per `(snapshot_date, version)`.
- T-EDR-Nplus2 — `executiveDepartureSnapshotsTableExists` returns true/false correctly (absent-table-safe gate).
- T-EDR-Nplus3 — Daemon-orchestration `runDaemonExecutiveDepartureEvaluation` end-to-end.
- T-EDR-Nplus4 — `readEventsForCycle` uses the subquery-around-FINAL pattern (a52c964 regression class).
- T-EDR-Nplus5 — Malformed `per_ticker_json` and `flagged_sectors_json` degrade gracefully (returns empty arrays, never throws).
- T-EDR-Nplus6 — EXPLAIN PLAN regression (skipped when CH unavailable).

### §9.3 Migration (`scripts/tests/migrateCreateExecutiveDepartureSnapshots.test.ts`)

- T-EDM-1 — Dry-run mode reports planned DDL without executing.
- T-EDM-2 — Apply mode creates the table; re-apply is no-op.
- T-EDM-3 — DDL matches §6 schema exactly (field-by-field assertion).
- T-EDM-4 — All three tables (`executive_departures`, `executive_departure_snapshots`, `cik_ticker_map`) created idempotently.

### §9.4 Ingest (`scripts/tests/secEdgar8kItem502Ingest.test.ts` — Python)

- T-EDI-1 — EDGAR full-text search response parse against fixture (real EDGAR JSON shape).
- T-EDI-2 — Item 5.02 sub-item code extraction (5.02(a)/(b)/(c)/(d)/(e) parsing).
- T-EDI-3 — CIK→ticker resolution via mocked EDGAR submissions response.
- T-EDI-4 — `formerNames` follow on a ticker-swap fixture.
- T-EDI-5 — Idempotent re-ingest under ReplacingMergeTree on (cik, accession, sub_item_code).
- T-EDI-6 — Acceptance-date filter (E-7) rejects filings with `accepted_at > snapshot_date`.
- T-EDI-7 — Rate-limit / 429 handling on EDGAR API (User-Agent header required per SEC guidance; back-off on 429).

### §9.5 Brief (`scripts/tests/operatorBriefRender.test.ts` — extension)

- T-OBR-ED-1 — Section #12 renders at byte-equal protection (appended after section #11).
- T-OBR-ED-2 — Top-N flagged tickers truncation at N=5 with "X more …" note.
- T-OBR-ED-3 — `executive_cluster_departure: YES` rendering on a fixture with a flagged sector.
- T-OBR-ED-4 — Cold-start fallback: no sectors with `z != null` renders "Aggregate baseline cold-start (n < 30) — no z-scores available."
- T-OBR-ED-5 — "No tickers flagged." fallback when both arrays empty.
- T-OBR-ED-6 — Staleness indicator renders correctly on `bd_since_last_query > 3`.

### §9.6 Composer wiring (`scripts/tests/operatorBrief.test.ts` — extension)

- T-OB-ED-1 — `composeMorningBrief` threads `executiveDeparture` snapshot through `Promise.all`.
- T-OB-ED-2 — `fetchLatestExecutiveDepartureFromCH` graceful-degrades on throw (mirrors short-interest A5 posture).
- T-OB-ED-3 — Null pass-through: `composeMorningBrief` with `fetchLatestExecutiveDeparture: () => null` renders the "not yet evaluated" footer.

---

## §10 · Implementation phases

| Phase | Deliverable | Estimated effort |
|-------|-------------|------------------|
| **A1** | `scripts/sec_edgar_8k_item_5_02_ingest.py` (Python). EDGAR full-text search API poll + Item 5.02 sub-item parse + CIK→ticker resolve + write to `quantlab.executive_departures` + `quantlab.cik_ticker_map` tables. Migration script for both source tables. Tests under `scripts/tests/` (pytest). | ~3 days |
| **A2** | `src/server/executive_departure.ts` (pure functions per §5). Tests under `scripts/tests/executiveDeparture.test.ts`. | ~1 day |
| **A3** | `scripts/migrate_create_executive_departure_snapshots.ts`. Migration test. Migration applied (dry-run + apply). | ~0.5 day |
| **A4** | `src/server/executive_departure_repository.ts` (read/write/exists/daemon-orchestration). `scripts/daily_signal_daemon.ts` step 1i hook. Tests. | ~1.5 days |
| **A5** | `src/server/operator_brief.ts` + `operator_brief_render.ts` section #12. Tests on byte-equal protection + flagged-tickers rendering. | ~1 day |

Total: **~7 working days** (matches gap-doc's 2-3 week pre-Opus estimate; closer to 1 week of focused Opus execution under the autonomous-execution protocol).

Each sub-phase commits as its own commit. SPEC (this doc) lands as the first commit.

---

## §11 · Open questions (deferred to implementation)

1. **EDGAR full-text search API exact endpoint + query syntax.** The canonical endpoint is `https://efts.sec.gov/LATEST/search-index?q=...&forms=8-K&dateRange=custom&...`. The exact query string for "Item 5.02" filtering may need refinement on first-run-with-real-data (matches FINRA's OQ-1 pattern from short-interest A1). Recommendation: A1 implements the best-guess query with operator-overridable `--query` flag; first apply-run confirms.

2. **GICS sector mapping source.** The cycle / cross-asset / sector-rotation composites use a SPDR-sector mapping (`SPY → XLK → Information Technology` indirection). Whether to reuse that exact mapping or to pull GICS directly from EDGAR submissions API (which includes `sicDescription` — SIC, not GICS, but mappable) is a A2 implementation decision. Recommendation: reuse the existing SPDR-sector map in A2; if coverage gaps appear, augment with SIC→GICS in A1 ingest.

3. **CIK-to-ticker for tickers that left the SPY 500 mid-history.** The PIT constituent panel handles this for the aggregate, but per-ticker mapping for delisted-mid-window tickers may need a fallback. Recommendation: cache `cik_ticker_map` forever; never evict — matches the short-interest A1 cusip-ticker map.

4. **EDGAR rate limit + User-Agent compliance.** SEC requires a `User-Agent: name email@domain` header on all requests; rate limit is 10 req/sec. Recommendation: A1 hard-codes a SignalForge User-Agent (operator-overridable via `--user-agent`), backs off on 429, and never parallelizes beyond 5 concurrent requests.

5. **Amendment handling (`8-K/A`).** Amended 8-Ks can correct or supersede the original filing. v1 treats `8-K/A` filings as new events (additive) rather than mutations of the original — the underlying `(cik, accession, sub_item_code)` deduplication handles the simple amendment-republication case; substantively-corrected amendments are rare for Item 5.02. Recommendation: log a separate `is_amendment: boolean` field at A1 time; A2 composite treats both equally in v1; revisit if amendment-driven double-counting appears in Phase B.

6. **Voluntary vs involuntary classification (gap doc OQ).** Per E-2, v1 does NOT classify. v2 ADR scope: NLP / regex on the Item 5.02 free-text body (typically a ~200-1000-word paragraph in the 8-K) to extract "retired" vs "resigned" vs "terminated" vs "mutually agreed to depart" patterns. Out-of-scope until Phase B reveals the simpler v1 lacks predictive power.

7. **Severity weighting by role (gap doc OQ).** Per E-5, v1 does NOT weight. v2 ADR scope: role-weight table (CEO=1.0, CFO=0.8, COO=0.7, others=0.5). Out-of-scope until canon backing emerges (gap doc explicitly notes "less academic backing than other signals").

8. **Form 4 integration (gap doc primary signal).** Per E-11, Form 4 is OUT-OF-SCOPE in v1 and queued for gap #7 event-driven-filings-processor scope OR a separate v2 ADR. The Form 4 signal has its own academic canon (Seyhun / Lakonishok-Lee / Cohen-Malloy-Pomorski) and warrants its own SPEC.

9. **Snapshot retention policy.** Daemon writes a snapshot per day; per-ticker JSON + flagged-sectors JSON together ~22KB. At 252 trading days/year that's ~5.5MB/year of snapshot growth (smaller than short-interest's ~20MB/year). Recommendation: no pruning in v1; match the other Layer-0 composites.

10. **Source-table retention.** `executive_departures` grows monotonically with 8-K Item 5.02 filings. Rough estimate: SPY-500 + equity-midcap ≈ 560 issuers × ~1 5.02 filing per issuer per year = ~560 rows/year. Negligible storage. No pruning needed.

---

## §12 · References

- **Warner, Watts, Wruck 1988** — "Stock Prices and Top Management Changes." *Journal of Financial Economics* 20, 461-492. Event-study evidence: small but positive abnormal returns around forced CEO departures.
- **Denis & Denis 1995** — "Performance Changes Following Top Management Dismissals." *Journal of Finance* 50(4), 1029-1057. Forced departures associated with subsequent improving operating performance.
- **Huson, Malatesta, Parrino 2004** — "Managerial Succession and Firm Performance." *Journal of Financial Economics* 74(2), 237-275. Extension of Denis-Denis with broader sample.
- **Lerman & Livnat 2010** — "The New Form 8-K Disclosures." *Review of Accounting Studies* 15(4), 752-778. 8-K filings broadly have abnormal-return reactions; Item 5.02 specifically less studied (this is the closest direct evidence + the canon-thin caveat).
- **Sarbanes-Oxley §409** (15 U.S.C. §78m(l)) — real-time disclosure requirement underlying the 8-K Item 5.02 4-business-day filing deadline.
- **17 CFR 249.308** — Form 8-K regulation, including the Item 5.02 sub-item structure (a/b/c/d/e).
- **SEC EDGAR full-text search API:** https://efts.sec.gov/LATEST/search-index (free, no API key, rate-limited).
- **SEC EDGAR submissions API:** https://data.sec.gov/submissions/CIK{cik}.json (CIK→ticker→formerNames).
- **EDGAR User-Agent guidance:** https://www.sec.gov/os/accessing-edgar-data — required for all programmatic access.
- Companion gap doc: [`docs/obsidian/gaps/executive-departure-signal.md`](../obsidian/gaps/executive-departure-signal.md).
- Companion gap (next in queue per operator): [`docs/obsidian/gaps/etf-flow-monitoring.md`](../obsidian/gaps/etf-flow-monitoring.md) (#9), [`docs/obsidian/gaps/event-driven-filings-processor.md`](../obsidian/gaps/event-driven-filings-processor.md) (#7).
- Form-4-canon (deferred per E-11): Seyhun 1986 *JFE*; Lakonishok-Lee 2001 *RFS*; Cohen-Malloy-Pomorski 2012 *Journal of Finance*.
- Short-interest A4 Path A4-β precedent (s89-s90) — load-bearing pattern for "single-source v1, deferred v2 enhancement" cited in E-11.
