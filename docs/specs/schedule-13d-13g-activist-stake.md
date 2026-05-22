---
status: active
phase: phase 9+
last_updated: 2026-05-22
owner: pejman
type: spec
slice_id: gap-7-13d-13g
---

# SPEC — Schedule 13D / 13G activist-stake composite (`schedule_13d_g_v1`)

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-22 · **Author:**
> Claude (Vector Core principal engineer) · **Phase:** 9-gap unfreeze (gap #7 v2) ·
> **Authority:** [ADR-043](adr-043-13d-13g-activist-stake-research.md), Brav-Jiang-
> Partnoy-Thomas 2008 *J. Finance* 63(4):1729 (activist 13D return literature),
> Edmans-Fang-Zur 2013 *RFS* 26(6):1443 (13D voice vs 13G exit), Collin-Dufresne-Fos
> 2015 *J. Finance* 70(4):1555 (informed-trading pre-filing window), 17 CFR
> 240.13d-1 to 240.13d-102 + 15 U.S.C. §78m(d)+(g) (statutory backbone), Lerman-
> Livnat 2010 / Seyhun 1986 / Lakonishok-Lee 2001 / Cohen-Malloy-Pomorski 2012
> (sibling gap-#7 canon — already established under EK + F4)
>
> **Stage in Vector Core build:** SPEC → CODE (Phase A only — informational
> substrate). Phase B (validation with deflated Sharpe + PBO + HLZ haircut)
> deferred per the established cycle / vol-structure / sector-rotation /
> cross-asset / short-interest / exec-departure / etf-flow / EK / F4 precedent:
> ship informational first, validate after ≥60 days OR via a dedicated backfill
> arc.
>
> **Lineage.** This is the THIRD parallel composite under gap #7 (after
> `eight_k_classifier_v1` and `form_4_insider_v1` from
> [event-driven-filings-processor.md](event-driven-filings-processor.md)). EDF-3
> in that SPEC explicitly deferred 13D/13G to a v2 ADR / separate arc; this
> document is that v2 arc.
>
> The architectural template per composite is established and unchanged:
> **A1 (EDGAR ingest) → A2 (pure composite + tests) → A3 (CH snapshot table +
> raw-event migration) → A4 (repository + daemon hook) → A5 (morning brief
> section)**. This SPEC ships the FULL contract before any code. Each sub-arc
> (XD13-A1 .. XD13-A5) becomes its own slice + commit; this document is the
> SPEC slice itself (no production code, no migrations, no daemon wiring).
>
> **Six canon-thin forks resolved autonomously** under the CLAUDE.md
> three-criterion test. All resolutions documented in
> [ADR-043 §3](adr-043-13d-13g-activist-stake-research.md). The forks:
> XD-1 (form-type proxy), XD-2 (filer reputation), XD-3 (Item 4 NLP),
> XD-4 (amendment supersedure), XD-5 (asymmetric aggregate / per-stock
> filter), XD-6 (window inheritance).

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the Layer-0 informational substrate with a Schedule 13D / 13G
   activist-stake signal:

   **Per-stock** — for each ticker T in the equity-midcap universe, surface
   trailing-90d / trailing-30d activist-stake activity:
   - `new_13d_filing_flag_30d` — any SC 13D filing in `[D - 30d, D]`
   - `new_13g_filing_flag_30d` — any SC 13G filing in `[D - 30d, D]`
   - `recent_13d_count_90d` — # SC 13D filings (including amendments) in
     `[D - 90d, D]`
   - `recent_13g_count_90d` — # SC 13G filings (including amendments) in
     `[D - 90d, D]`
   - `new_13d_count_90d` — # NEW SC 13D filings (excluding amendments) in
     `[D - 90d, D]`
   - `distinct_13d_filers_90d` — # distinct filer CIKs (any 13D form) in
     `[D - 90d, D]`
   - `days_since_latest_13d` — `D − max(SC 13D accepted_at).date`, null on
     no qualifying filings
   - `days_since_latest_13g` — `D − max(SC 13G accepted_at).date`, null on
     no qualifying filings

   **Aggregate** — SPY-500 PIT panel sliced by GICS sector:
   - per-sector NEW-13D event-rate, z-scored against trailing 2y baseline;
     `schedule_13d_cluster_flag` fires on any sector with `|z_s| > 2.0` and
     `baseline_size ≥ MIN_Z_BASELINE = 30`.

2. Persist daily snapshots to NEW table `quantlab.schedule_13d_g_snapshots`.

3. Surface section **#16** in the morning operator brief, appended LAST to
   preserve byte-equal-stdout protection on sections #1-#15.

**Non-goals:**

1. **No `phase1_v3` modification.** No new category added in v1; promotion to
   classifier input gates on Phase B independence test + a new ADR. Matches
   the established Layer-0 posture.
2. **No universe-filter gating.** Per-stock flags are LOGGED — no hard
   exclusion of any ticker in v1.
3. **No paid data sources.** SEC EDGAR is the only data source (free,
   official, pre-authorized per CLAUDE.md data-source policy).
4. **No filer-reputation classifier in v1.** (See ADR-043 XD-2.) Filer CIK
   + filer name stored at the raw-event layer (forensic) but not used in
   the composite.
5. **No free-text NLP on cover-page Item 4 / Item 5 / Item 6.** (See
   ADR-043 XD-3.) v1 reads SEC-structural envelope only: form-type +
   accession + CIKs + acceptance datetime.
6. **No 13D-vs-13G weighting beyond the form-type partition.** Both
   form-types feed per-stock metrics; only NEW-13D feeds the aggregate
   (per ADR-043 XD-5).
7. **No amendment supersedure.** SC 13D/A and SC 13G/A treated additively
   (per ADR-043 XD-4).
8. **No pre-filing return capture.** Structurally unobtainable per
   Collin-Dufresne-Fos 2015 — the activists' informed-trading window is
   closed by the time EDGAR receives the filing.
9. **No event-driven cadence v1.** Daily-daemon (matches EDF-2). Latency
   bounded: SC 13D 10bd statutory deadline → daemon catches all filings
   within 1bd of EDGAR acceptance.
10. **No backfill of pre-existing historical filings.** EDGAR archive goes
    back to 1994; backfill IS possible but is operator-deferred (same
    posture as gap #7 v1 EK / F4 + gap #8 / gap #9 / gap #10).
11. **No dashboard React panel in v1** (carry from S-VOL-4 / S-SR-4 /
    S-CA-4 / S-SI-9 / S-ED-8 / F-PANEL / EK-PANEL / F4-PANEL — operator
    attention budget is finite).

---

## §2 · Decisions (locked at SPEC time)

### §2.1 · Gap-level decisions (inherited unchanged from EDF + EK + F4)

| ID | Decision | Source |
|----|----------|--------|
| **(inherits EDF-1)** | Sibling composite, NOT combined with EK or F4. Each has its own snapshot table, brief section, version stamp. | `event-driven-filings-processor.md` §2.1 EDF-1 |
| **(inherits EDF-2)** | Daily-daemon cadence. Event-driven promotion deferred. | EDF-2 |
| **(inherits EDF-4)** | Reuses `quantlab.cik_ticker_map` (gap #8). No new issuer-CIK resolution infrastructure. | EDF-4 |
| **(inherits EDF-5)** | **Acceptance-date anti-leak gate.** Daemon snapshot dated D reads filings with `accepted_at ≤ D`; rejects all later. `period_of_report` is forensic only. | EDF-5 |
| **(inherits EDF-6)** | Windows: 30d cluster trigger, 90d carrying window, 2y baseline. | EDF-6 |
| **(inherits EDF-7)** | `MIN_Z_BASELINE = 30` floor. Aggregate z-cluster threshold `|z| > 2.0`. | EDF-7 |
| **(inherits EDF-8)** | Per-stock universe = equity-midcap (~60 tickers). Aggregate universe = SPY-500 PIT constituents via `quantlab.sp500_constituents`, sliced by GICS sector via the existing SPDR-sector mapping. | EDF-8 |
| **(inherits EDF-10)** | EDGAR ingest infrastructure reuses `scripts/_sec_edgar_helpers.py` (rate-limit + 429 retry + User-Agent + acceptance-date filter + CIK resolver). | EDF-10 |

### §2.2 · 13D/13G-specific decisions (locked here)

| ID | Decision | Rationale |
|----|----------|-----------|
| **XD-1** | **Activist-vs-passive proxy = SEC-encoded form-type.** SC 13D ⇒ active intent; SC 13G ⇒ passive intent. No free-text parsing of Item 4. | ADR-043 XD-1. Three-criterion: (1) Brav-Jiang-Partnoy-Thomas 2008 §2.1 uses SC 13D-vs-SC 13G as the primary proxy; Edmans-Fang-Zur 2013 explicitly relies on the form-type distinction; 17 CFR 240.13d-101 vs 240.13d-102 is the tight statutory split. (2) Form-type is structurally encoded with zero ambiguity; free-text classification is HIGH variance at first-run. (3) 0 free parameters (form-type proxy) vs N (NLP regex / reputation list). |
| **XD-2** | **No filer-reputation classifier in v1.** Filer CIK + name stored at raw-event layer (forensic + future use); composite weights all filers 1.0. | ADR-043 XD-2. Three-criterion: (1) Canon-rich (Brav-Jiang 2010 documents 2-3× return for well-known activists) but the LAYER on top of v1, not a replacement for it. (2) Hand-list bakes in operator priors; learned scores need ≥2y per-filer history that doesn't exist at first-run. (3) 0 free parameters in v1; v2 ADR re-runs the test once history exists. |
| **XD-3** | **No cover-page free-text parsing in v1.** v1 reads form-type + accession + CIKs + acceptance datetime only (SEC-structural envelope). | ADR-043 XD-3. Three-criterion: (1) Canon mature on Item 4 sub-categories but parsing is fragile (attorney-drafted, no SEC-imposed structure). (2) Pattern libraries are HIGH variance + would need labeled corpus we don't have. (3) 0 free parameters vs N. |
| **XD-4** | **Amendments treated additively, not as supersessions.** SC 13D/A and SC 13G/A each count as one row in `schedule_13d_g_filings` with `is_amendment = 1`. No retrospective linking of amendment → original filing. | ADR-043 XD-4. Three-criterion: (1) Brav-Jiang-Partnoy-Thomas 2008 treats amendments as separate filings (statutorily required on material change per 17 CFR 240.13d-2). (2) Supersession requires accession-link recovery + collapse rule. (3) Additive = 0 free parameters; supersession = N. Matches EK / 8-K amendment handling. |
| **XD-5** | **Aggregate uses NEW 13D only; per-stock uses ALL filings.** Aggregate per-sector NEW-13D event-rate counts only `form_type = 'SC 13D' AND is_amendment = 0`. Per-stock metrics include amendments (`recent_13d_count_90d`, `recent_13g_count_90d`). | ADR-043 XD-5. Three-criterion: (1) Brav-Jiang-Partnoy-Thomas 2008 §2.2 — announcement effect concentrated on INITIAL SC 13D filing; per-stock forensic value is filing-volume-anchored. (2) Asymmetric choice canon-supported by announcement-effect literature being initial-filing-anchored. (3) Single design choice (no runtime tunable parameter). |
| **XD-6** | **Window choice inherited from EDF-6.** 30d cluster trigger, 90d carrying window, 2y daily baseline. | ADR-043 XD-6 + EDF-6. Three-criterion: (1) Single Layer-0 window convention across gap-#7 composites avoids per-composite tuning that would constitute multiple-testing free parameters. (2) Operator interpretation simpler. (3) 0 new free parameters. |
| **XD-7** | **Raw event table: NEW `quantlab.schedule_13d_g_filings`.** One row per (issuer CIK, accession) tuple. Schema mirrors `eight_k_events` byte-for-byte except `item_code` is removed (13D/G have no per-item code structure equivalent) and `filer_cik` + `filer_name` are added. `form_type` carries the full SEC string ('SC 13D' \| 'SC 13D/A' \| 'SC 13G' \| 'SC 13G/A'). | ADR-043 §5 implementation order. ReplacingMergeTree on `(issuer_cik, accession)` for idempotent re-runs. Idempotency contract identical to `eight_k_events`. |
| **XD-8** | **Snapshot version stamp: `schedule_13d_g_v1`.** Bumps on: form-type set change (e.g. adding SC 13F-HR — out of scope v1), window change (30d/90d/2y), aggregate z-threshold change (`\|z\|>2.0 → \|z\|>2.5`), aggregate baseline floor change (`MIN_Z_BASELINE=30`), aggregate filter change (NEW-13D vs ALL-13D vs 13D+13G blend), universe change. | Matches Layer-0 convention across all prior composites. Version-stamp bumps are how the daemon's downstream consumers know to re-compute. |
| **XD-9** | **Daemon hook position: 1m (after 1l Form 4, before §2 cells/bundles).** | Chain becomes: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → 1l form-4 → 1m schedule-13d-g → §2 cells/bundles`. Appended last among signal hooks. |
| **XD-10** | **Brief section: #16.** Appended after section #15 (Form 4 insider). Renderer must not modify the byte-equal output of sections #1-#15. | Established byte-equal-protection invariant. |
| **XD-11** | **Ingest script: NEW `scripts/sec_edgar_13d_g_ingest.py`.** Sibling of `sec_edgar_form4_ingest.py`; reuses `_sec_edgar_helpers.py` for rate-limit + User-Agent + 429 retry + acceptance-date filter + CIK resolver. Uses EDGAR full-text search filtered to `forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A`. | Sibling script, not refactor. The Form 4 ingest does XML body parsing; this ingest only needs the full-text search response envelope (accession + cik + form_type + accepted + period_of_report + primary_doc). Cover-page text body NOT fetched in v1 (XD-3 — no NLP). |
| **XD-12** | **Filer CIK resolution: full-text search response carries the filer-CIK alongside the issuer-CIK.** Both are stored on the raw row. Filer-name resolution via submissions API (re-used resolver from EDGAR helpers) is OPTIONAL in v1 — populates an `entity_name` field if available, otherwise empty string. | EDGAR full-text search returns both `cik` (issuer) and a filer entity record per response item. Filer-name resolution adds N+1 submissions-API calls per ingest cycle; gated by a `--resolve-filer-names` flag (default false) to keep the v1 ingest cycle fast. v2 ADR (XD-2) will lift this when the reputation classifier needs the names. |
| **XD-13** | **No `quantlab.activist_filer_table` in v1.** Filer-reputation registry deferred to v2 ADR (per XD-2). | Single source of truth for "v1 has no filer-classification anywhere"; the absence of this table is a load-bearing v1 invariant. |
| **XD-14** | **Idempotency: ReplacingMergeTree on `(issuer_cik, accession)`.** Re-running the ingest over an overlapping window does not duplicate rows. | Standard ingest contract across all gap-#7 / gap-#8 / gap-#10 tables. The accession is the global unique key per filing. |
| **XD-15** | **Cover-page % beneficially owned NOT parsed in v1.** Items 11-12 on Schedule 13D carry the `% of class beneficially owned` field but extracting it requires the body fetch + parsing. v1 does NOT compute or store ownership percentages; v1 trusts the SEC's 5% threshold trigger (`15 U.S.C. §78m(d)`). | A v2 ADR can add cover-page % parsing if Phase B reveals a need (e.g. distinguishing "just crossed 5%" from "stake at 18%"). v1 ships threshold-trigger-aware only. |

---

## §3 · Component diagram

```text
                              ┌──────────────────────┐
                              │ SEC EDGAR            │
                              │   - Full-text search │     pre-authorized per
                              │     API (efts...)    │     CLAUDE.md
                              │   - Submissions API  │     data-source policy
                              │     (data.sec.gov)   │
                              └─────────┬────────────┘
                                        │ SC 13D: 10bd statutory deadline (Rule 13d-1(a))
                                        │ SC 13G: 45d post year-end (Rule 13d-1(b)/(c))
                                        │ SC 13D/A: promptly (≤1d typical)
                                        │ SC 13G/A: 45d post year-end + threshold crossings
                                        ▼
                          ┌──────────────────────────┐
                          │ scripts/                 │
                          │   sec_edgar_13d_g_ingest │
                          │   .py                    │
                          └────────────┬─────────────┘
                                       │ writes to
                                       ▼
                          ┌──────────────────────────┐
                          │ quantlab.                │
                          │   schedule_13d_g_filings │
                          │   (per-filing)           │
                          └────────────┬─────────────┘
                                       │ daemon read
                                       ▼
                          ┌──────────────────────────┐
                          │ src/server/              │
                          │   schedule_13d_g.ts      │
                          │   (pure composite)       │
                          └────────────┬─────────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │ quantlab.                │
                          │   schedule_13d_g_        │
                          │   snapshots              │
                          └────────────┬─────────────┘
                                       ▼
                              daemon step 1m
                       scripts/daily_signal_daemon.ts
                                       │
                                       ▼
                              brief section #16
                       src/server/operator_brief_render.ts


  Shared infrastructure (reused unchanged from gap #7 v1 / gap #8):
   - scripts/_sec_edgar_helpers.py   (rate-limit, User-Agent, 429 retry,
                                       acceptance-date filter, CIK→ticker
                                       submissions-API resolver)
   - quantlab.cik_ticker_map         (from gap #8 / gap #7 v1 EK + F4)
   - quantlab.sp500_constituents     (PIT panel)
   - GICS sector mapping             (from G1 arc s94 #2-#4)
```

---

## §4 · Inputs

### §4.1 · Per-row raw ingest (EDGAR full-text search response)

| Source | Field | CH destination | Notes |
|--------|-------|----------------|-------|
| EDGAR full-text search (`efts.sec.gov/LATEST/search-index`) | accession number | `schedule_13d_g_filings.accession` | Primary key. |
| EDGAR full-text search | issuer CIK | `schedule_13d_g_filings.issuer_cik` | The COMPANY being filed on. Resolved to ticker via `cik_ticker_map`. |
| EDGAR full-text search | filer CIK | `schedule_13d_g_filings.filer_cik` | The BENEFICIAL OWNER doing the filing. Stored forensic; not used in v1 composite (XD-2). |
| EDGAR full-text search | filer entity name | `schedule_13d_g_filings.filer_name` | Optional v1 enrichment via submissions API; default = '' (XD-12). |
| EDGAR full-text search | form type | `schedule_13d_g_filings.form_type` | 'SC 13D' \| 'SC 13D/A' \| 'SC 13G' \| 'SC 13G/A'. Drives the activist-vs-passive proxy (XD-1). |
| EDGAR full-text search | `accepted` datetime | `schedule_13d_g_filings.accepted_at` | Wall-clock UTC of EDGAR acceptance. Load-bearing per EDF-5 / XD-14. |
| EDGAR full-text search | `periodOfReport` date | `schedule_13d_g_filings.period_of_report` | Forensic only; never used for window calc. |
| EDGAR full-text search | primary doc URL | `schedule_13d_g_filings.filing_url` | Built from `cik` + accession-nodash + primary-doc per EDGAR Archives convention. Optional v1; default = ''. |
| Submissions API | issuer CIK → ticker | `cik_ticker_map.ticker` (existing) | Reused unchanged from gap #8. |
| Submissions API | filer CIK → name | `schedule_13d_g_filings.filer_name` (XD-12) | Optional v1 enrichment. v2 will lift this to a `quantlab.activist_filers` table. |

### §4.2 · Daemon-time inputs (per snapshot)

| Source | Field | Used by | Notes |
|--------|-------|---------|-------|
| `schedule_13d_g_filings` (NEW) | all rows where `accepted_at ≤ D` | Composite per-stock + aggregate | The acceptance-date filter is the load-bearing anti-leak gate. |
| `cik_ticker_map` (existing) | `issuer_cik → ticker` | Composite per-stock + aggregate | Drops issuer rows that don't resolve to a ticker in the v1 universe. |
| `sp500_constituents` (existing) | PIT constituent panel as-of D | Composite aggregate | Used for sector membership computation. |
| GICS sector mapping (existing) | `ticker → sector` | Composite aggregate | No new infra. |
| Equity-midcap universe (existing) | universe roster | Composite per-stock | ~60 tickers, matches EK + F4. |

---

## §5 · Composite formulas

### §5.1 · Per-stock (per XD-1 / XD-5 / XD-6)

For each ticker T in equity-midcap universe, as of snapshot date D:

```text
let filings_t  = filings(issuer_ticker = T, accepted_at ≤ D)

let filings_t_30d = filings_t where accepted_at ∈ [D - 30d, D]
let filings_t_90d = filings_t where accepted_at ∈ [D - 90d, D]

let filings_13d_30d = filings_t_30d where form_type ∈ {'SC 13D', 'SC 13D/A'}
let filings_13g_30d = filings_t_30d where form_type ∈ {'SC 13G', 'SC 13G/A'}
let filings_13d_90d = filings_t_90d where form_type ∈ {'SC 13D', 'SC 13D/A'}
let filings_13g_90d = filings_t_90d where form_type ∈ {'SC 13G', 'SC 13G/A'}
let filings_new_13d_90d = filings_t_90d where form_type = 'SC 13D'   -- excludes /A (XD-5)

let new_13d_filing_flag_30d = (count(filings_13d_30d) ≥ 1)
let new_13g_filing_flag_30d = (count(filings_13g_30d) ≥ 1)

let recent_13d_count_90d    = count(filings_13d_90d)
let recent_13g_count_90d    = count(filings_13g_90d)
let new_13d_count_90d       = count(filings_new_13d_90d)

let distinct_13d_filers_90d = count(distinct filer_cik in filings_13d_90d)

let days_since_latest_13d   = if filings_13d_90d.empty: null
                              else D - max(filings_13d_90d.accepted_at).date
let days_since_latest_13g   = if filings_13g_90d.empty: null
                              else D - max(filings_13g_90d.accepted_at).date
```

### §5.2 · Aggregate (per XD-5 / XD-6 / inherited EDF-7)

For SPY-500 PIT-as-of-D, sliced by GICS sector:

```text
let universe = sp500_constituents(asOf = D)
let sectors  = distinct(gics_sector(T) for T in universe)

for each sector s in sectors:
  let sector_size_s = count(T in universe : gics_sector(T) = s)

  let events_s = filings(issuer_ticker in universe : gics_sector(issuer_ticker) = s,
                         form_type = 'SC 13D',           -- NEW 13D only (XD-5)
                         is_amendment = 0,
                         accepted_at ∈ [D - 90d, D])

  let new_13d_rate_s_t = count(distinct (issuer_ticker, accession) in events_s)
                          / sector_size_s

  let baseline_s = trailing(new_13d_rate_s, 2y daily)
  if count(baseline_s) < MIN_Z_BASELINE (=30):
    z_s = null
  else:
    z_s = (new_13d_rate_s_t - mean(baseline_s)) / stddev(baseline_s)

  cluster_event_s = (z_s != null) AND (abs(z_s) > 2.0)

let schedule_13d_cluster_flag = OR over sectors of cluster_event_s
let flagged_sectors_13d_g     = list of (sector, z_s, new_13d_rate_s_t,
                                          sector_size_s, baseline_size)
                                  where cluster_event_s
```

### §5.3 · Snapshot payload

```typescript
interface Schedule13DGSnapshot {
  snapshot_date: Date;
  last_edgar_query_at: Date | null;
  bd_since_last_query: number | null;

  // Aggregate (sector-sliced):
  flagged_sectors: Array<{
    sector: string;
    sector_size: number;
    new_13d_rate_t: number;
    z: number;
    baseline_size: number;
  }>;
  schedule_13d_cluster_flag: boolean;

  // Per-ticker (equity-midcap universe):
  per_ticker_rows: Array<{
    ticker: string;
    cik: string;
    sector: string | null;

    new_13d_filing_flag_30d: boolean;
    new_13g_filing_flag_30d: boolean;
    recent_13d_count_90d: number;
    recent_13g_count_90d: number;
    new_13d_count_90d: number;
    distinct_13d_filers_90d: number;
    days_since_latest_13d: number | null;
    days_since_latest_13g: number | null;
  }>;

  inputs_available: { aggregate: number; per_ticker: number };
  version: 'schedule_13d_g_v1';
}
```

`inputs_available.aggregate` = `count of (sector, day) tuples with non-null
new_13d_rate` over the 2y baseline used at this snapshot. Operator brief
renders cold-start when `inputs_available.aggregate < MIN_Z_BASELINE × 11`
(sectors).

`inputs_available.per_ticker` = `count(rows with at least one filing in 90d
window)` — informational, NOT a gate.

---

## §6 · CH tables (Phase XD13-A3 migrations)

```sql
-- Raw filing stream (parallel to eight_k_events from EK-A1 / gap #7 v1)
CREATE TABLE quantlab.schedule_13d_g_filings (
  accession             String,
  issuer_cik            String,
  filer_cik             String,
  filer_name            String DEFAULT '',                  -- optional v1 enrichment (XD-12)
  issuer_ticker         LowCardinality(String) DEFAULT '',
  form_type             LowCardinality(String),             -- 'SC 13D' | 'SC 13D/A' | 'SC 13G' | 'SC 13G/A'
  is_amendment          UInt8 DEFAULT 0,                    -- 1 if form_type ends '/A'
  accepted_at           DateTime,
  period_of_report      Date,
  filing_url            String DEFAULT '',
  source                LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
  ingested_at           DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (issuer_cik, accession)
SETTINGS index_granularity = 1024;

-- Daily snapshot (one row per daemon run)
CREATE TABLE quantlab.schedule_13d_g_snapshots (
  snapshot_date              Date,
  last_edgar_query_at        Nullable(DateTime),
  bd_since_last_query        Nullable(Int32),

  schedule_13d_cluster_flag  UInt8,
  flagged_sectors_json       String,                        -- ~11 sectors max

  per_ticker_json            String,                        -- ~60 rows
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,

  composite_version          LowCardinality(String) DEFAULT 'schedule_13d_g_v1',
  ingested_at                DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, composite_version)
SETTINGS index_granularity = 1024;
```

`cik_ticker_map` is reused unchanged from gap #8 (no DDL change). Per-ticker
rows + flagged sectors stored as JSON in single columns — matches the EK / F4
A3 convention.

**Both migrations are non-destructive:** the existing daemon at the moment
this slice closes does NOT read either new table; the daemon-side wiring is
gated to a separate XD13-A4 slice (no behavior change at A3-only landing).

---

## §7 · Daemon hook position

- **Step 1m — Schedule 13D/G evaluation**: between Form 4 (1l) and §2
  cells/bundles. Reads latest `schedule_13d_g_filings` rows-as-of-D +
  `cik_ticker_map` + `sp500_constituents` PIT; computes the composite per
  §5.1-§5.2; writes one row to `schedule_13d_g_snapshots`. Absent-table-safe
  + non-fatal: if `schedule_13d_g_filings` is missing, the hook returns a
  cold-start snapshot (all per-ticker flags = false, aggregate cluster_flag
  = false, `inputs_available = 0`) and continues. Gated by `NO_MACRO ||
  DRY_RUN`.

Chain becomes:

```text
1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset
   → 1h short-interest → 1i exec-departure → 1j etf-flow
   → 1k eight-k → 1l form-4 → 1m schedule-13d-g
   → §2 cells/bundles
```

---

## §8 · Brief panel (section #16)

```text
─────────────────────────────────────────────────────────────────────────
 §16 — SCHEDULE 13D / 13G ACTIVIST-STAKE (as of 2026-MM-DD,
                                          90d window / 30d cluster)
─────────────────────────────────────────────────────────────────────────
  Aggregate (SPY 500 NEW-13D event-rate by GICS sector, 2y baseline):

    schedule_13d_cluster: NO

    Top sector z-scores (|z| > 2 flagged):
      Consumer Discretionary  z=+1.7σ (rate=0.038, n=53 constituents)
      Energy                  z=+1.1σ (rate=0.045, n=22 constituents)
      Real Estate             z=-0.2σ (rate=0.013, n=31 constituents)
      ...

  Last EDGAR query:           2026-MM-DD HH:MM:SS UTC (today)

  Flagged tickers (universe filtered to equity-midcap):

    new_13d (2):
      ABCD — SC 13D filed 7d ago by filer CIK 0001234567
             ($EntityName if XD-12 resolved, else blank)
      EFGH — SC 13D + SC 13D/A x2 in 90d (3 filings, 2 distinct filers)

    new_13g (3):
      IJKL — SC 13G filed 4d ago by Vanguard (annual)
      MNOP — SC 13G filed 11d ago by BlackRock (annual)
      QRST — SC 13G filed 22d ago by Capital Research

  Universe coverage:          58/60 mid-cap tickers have current CIK mapping
                              (2 missing: TICK1 / TICK2 — CIK map TBD)
```

Top-N truncation = 5 per side (matches gap #7 v1 / gap #8 / #10 conventions).
Per-ticker JSON full panel queryable directly from CH.

---

## §9 · Test plan (full enumeration; tests land in XD13-A2/A4/A5 slices)

### §9.1 · Composite pure-function (`scripts/tests/schedule13dg.test.ts` — A2)

- **T-XD13-1** — `new_13d_filing_flag_30d` fires when latest SC 13D in window.
- **T-XD13-2** — `new_13d_filing_flag_30d` does NOT fire when latest SC 13D is 31d outside window.
- **T-XD13-3** — `new_13g_filing_flag_30d` fires on SC 13G; does NOT fire on SC 13D in window.
- **T-XD13-4** — `recent_13d_count_90d` includes amendments; `new_13d_count_90d` excludes them.
- **T-XD13-5** — `distinct_13d_filers_90d` deduplicates on `filer_cik` (two filings from same filer count once).
- **T-XD13-6** — `days_since_latest_13d` returns null on no qualifying filings.
- **T-XD13-7** — `days_since_latest_13g` returns null on no qualifying filings.
- **T-XD13-8** — Per-stock filings outside the equity-midcap universe contribute zero rows.
- **T-XD13-9** — Sector NEW-13D rate computed correctly: 4 distinct (issuer_ticker, accession) NEW 13D filings across 40 SPY constituents in sector → rate = 0.10.
- **T-XD13-10** — Aggregate sector z-score with 30-print baseline (smallest acceptable baseline).
- **T-XD13-11** — Aggregate z-score returns null when sector baseline < 30 prints (cold-start).
- **T-XD13-12** — `schedule_13d_cluster_flag` fires when ANY sector has `|z| > 2.0`.
- **T-XD13-13** — `schedule_13d_cluster_flag` does NOT fire when all sector z's are null (cold-start).
- **T-XD13-14** — Amendments (`form_type` ending '/A') are EXCLUDED from the aggregate NEW-13D rate (XD-5).
- **T-XD13-15** — Amendments ARE INCLUDED in per-stock `recent_13d_count_90d` (XD-5 asymmetry).
- **T-XD13-16** — Window boundary inclusion: filing at exactly `accepted_at = D - 90d 00:00:00` IS in 90d window.
- **T-XD13-17** — Window boundary inclusion: filing at `accepted_at = D - 30d 00:00:00` IS in 30d window.
- **T-XD13-18** — Filing with `accepted_at > D` is REJECTED at composite layer (EDF-5 / XD-7 anti-leak gate).
- **T-XD13-19** — SC 13G ONLY filings yield `new_13d_filing_flag_30d = false` + `new_13g_filing_flag_30d = true` + `recent_13d_count_90d = 0` + `recent_13g_count_90d > 0`.
- **T-XD13-20** — SC 13D and SC 13G mixed on same ticker → both per-form flags + counts independent.
- **T-XD13-21** — Snapshot payload `version === 'schedule_13d_g_v1'` (locked).
- **T-XD13-22** — `inputs_available.aggregate` = count of (sector, day) tuples with non-null `new_13d_rate` over 2y baseline.

### §9.2 · Composite repository (`scripts/tests/schedule13dgRepository.test.ts` — A4)

- **T-XD13R-1..N** — `writeSnapshot` round-trip with FakeClickHouse.
- **T-XD13R-Nplus** — `readLatest` returns most-recent per `(snapshot_date, composite_version)`.
- **T-XD13R-Nplus2** — `schedule13dgSnapshotsTableExists` returns true/false correctly.
- **T-XD13R-Nplus3** — Daemon-orchestration `runDaemonSchedule13DGEvaluation` end-to-end.
- **T-XD13R-Nplus4** — Daemon-orchestration cold-start: missing `schedule_13d_g_filings` table → returns cold-start snapshot, NOT a throw.
- **T-XD13R-Nplus5** — Acceptance-date filter at repository layer: row with `accepted_at > snapshot_date` does NOT contribute to today's snapshot.

### §9.3 · Ingest script (`scripts/tests/test_sec_edgar_13d_g_ingest.py` — A1)

- **T-XD13I-1** — Full-text search URL builder: includes `forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A`.
- **T-XD13I-2** — Response parser: extracts (accession, issuer_cik, filer_cik, form_type, accepted, period_of_report).
- **T-XD13I-3** — `is_amendment` is derived: `form_type` ending '/A' → 1; otherwise 0.
- **T-XD13I-4** — Rate limit + 429 retry: helper integration unchanged from EK / F4 ingest.
- **T-XD13I-5** — Acceptance-date filter at ingest: filings with `accepted_at > --end-date` are rejected.
- **T-XD13I-6** — Idempotency: re-running with overlapping window does not duplicate rows in `schedule_13d_g_filings`.
- **T-XD13I-7** — `cik_ticker_map` integration: issuer_cik resolved to ticker via existing helper.
- **T-XD13I-8** — Apply mode writes via client.insert; dry mode short-circuits.
- **T-XD13I-9** — `ensure_schedule_13d_g_filings_table` calls client.command with byte-pinned DDL.
- **T-XD13I-10** — `--resolve-filer-names` flag triggers submissions-API resolution; default false leaves `filer_name = ''`.
- **T-XD13I-11** — Filer-CIK extraction from full-text search response (the `filer.cik` or equivalent field per EDGAR JSON schema).
- **T-XD13I-12** — Filter at parse time: response items with `forms` outside the SC 13D/G set are dropped.

### §9.4 · Brief renderer (`scripts/tests/operatorBriefRender.test.ts` — A5, NEW tests)

- **T-OBR-XD13-1** — Section #16 renders when `schedule_13d_g_v1` snapshot present.
- **T-OBR-XD13-2** — Section #16 cold-start render when `schedule_13d_g_v1.inputs_available.aggregate < MIN_Z_BASELINE × 11`.
- **T-OBR-XD13-3** — Section #16 byte-equal to fixture when snapshot present + non-cold-start.
- **T-OBR-XD13-4** — Sections #1-#15 byte-equal regardless of section #16 state (byte-equal-stdout protection).
- **T-OBR-XD13-5** — `flagged_sectors` ordered descending by `|z|`; top-5 truncation enforced.
- **T-OBR-XD13-6** — `new_13d` per-ticker subsection lists tickers with `new_13d_filing_flag_30d = true`; top-5 truncation.
- **T-OBR-XD13-7** — `new_13g` per-ticker subsection lists tickers with `new_13g_filing_flag_30d = true`; top-5 truncation.

### §9.5 · Migration (`scripts/tests/migrateCreateSchedule13DGFilings.test.ts` — A3)

- **T-XD13M-1** — Dry-run prints planned DDL without executing.
- **T-XD13M-2** — Apply executes `CREATE TABLE IF NOT EXISTS` for both `schedule_13d_g_filings` + `schedule_13d_g_snapshots`.
- **T-XD13M-3** — Pre-checks: validates CH connectivity + database existence.
- **T-XD13M-4** — Post-checks: validates table existence via `system.tables` probe.
- **T-XD13M-5** — Re-run is idempotent (no error on second apply).

---

## §10 · Phase A vs Phase B

**Phase A (this SPEC).** Layer-0 informational substrate:

- XD13-A1 — ingest + raw-event table + migration.
- XD13-A2 — pure-function composite + tests.
- XD13-A3 — snapshot table + migration.
- XD13-A4 — repository + daemon hook.
- XD13-A5 — brief section #16.

Each sub-arc its own slice + commit. Five commits total expected for Phase A
completion.

**Phase B (gated, deferred).** Validation: deflated Sharpe + PBO + HLZ
haircut applied to per-stock + aggregate flags as binary classifiers
against forward-realized returns. Gate: ≥60 days of ingest history OR
backfill arc to populate `schedule_13d_g_filings` with ≥6mo retrospective
data.

**Phase C (gated, deferred).** Promotion to `phase1_v3` category — IF
Phase B independence test reveals additive predictive value over existing
Layer-0 categories. Requires its own ADR (per ADR-027 / ADR-042
convention).

---

## §11 · Watch-outs

1. **Pre-filing return is structurally unobtainable.** Collin-Dufresne-Fos
   2015 documents that activists use limit orders in liquid market windows
   BEFORE the SC 13D 10-day-deadline disclosure. The signal we capture is
   the ANNOUNCEMENT, not the underlying informed-trading window. Do NOT
   misinterpret Phase B results as "we can ride the pre-announcement
   drift" — by EDGAR-acceptance time, that window is closed.

2. **13G is NOT just "passive noise".** Edmans-Fang-Zur 2013 shows SC 13G
   filings generate positive announcement returns + operating-performance
   improvements, especially in liquid firms. v1 surfaces both 13D and 13G
   per-stock; downstream consumers must NOT discard 13G as "informational
   only" without re-reading Edmans-Fang-Zur.

3. **Statutory deadlines vary by form type.** SC 13D: 10 business days
   after the 5% crossing (Rule 13d-1(a)). SC 13G: 45 days after year-end
   for institutions (Rule 13d-1(b)); 10bd for passive investors who cross
   5% (Rule 13d-1(c)). SC 13D/A: promptly (≤1bd practical) on material
   change. SC 13G/A: 45d after year-end + on threshold crossings. The
   acceptance-date IS the wall-clock moment EDGAR makes the filing public
   — that's what we use, not the period-of-report which can be up to 45d
   earlier for SC 13G.

4. **Filer CIK ≠ issuer CIK.** The full-text search response carries both;
   they MUST be parsed into distinct columns. Confusing the two would
   make `distinct_13d_filers_90d` meaningless and corrupt any future
   filer-reputation work.

5. **`is_amendment` derivation MUST be from `form_type`, not from a
   separate field.** EDGAR's full-text search exposes form type as the
   full string including the '/A' suffix. Computing `is_amendment` from
   the suffix is the only canonical source; some EDGAR JSON responses
   have an `is_amendment` field but it is NOT universally populated.

6. **`MIN_Z_BASELINE = 30` baseline floor is load-bearing.** Without it,
   newly-bootstrapped histories produce wildly noisy z-scores in the first
   30 days. The floor is byte-identical to EK-7 / F4 / EDF-7 across all
   Layer-0 composites; do NOT re-tune for this composite.

7. **`schedule_13d_cluster_flag` cold-start = false.** When every sector z
   is null due to baseline-too-thin, the cluster flag is false (NOT
   null). Downstream consumers gate on the explicit `inputs_available`
   field — same convention as EK / F4 / etc.

8. **Acceptance-date anti-leak gate is non-negotiable.** Any composite-side
   read that uses `period_of_report` for window membership instead of
   `accepted_at` is BROKEN. The period_of_report can predate the
   acceptance by up to 45d (SC 13G); using it for windowing injects
   look-ahead leakage into Phase B backtests.

9. **No `schedule_13d_g_v2` until v1 is Phase B-validated.** Do NOT
   prematurely add filer-reputation / Item 4 NLP / amendment supersession
   layers. Each is its own ADR with its own three-criterion test once
   Phase B reveals the v1 form-type-only signal is decision-affecting
   (or decision-distorted).

10. **CIK 10-digit normalization is delegated to the shared helper.** Both
    issuer_cik and filer_cik are stored normalized; downstream consumers
    that bypass the helper risk join failures against `cik_ticker_map`.

---

## §12 · Operator-gated action items (for A1..A5 slices)

- **A1 close:** Run `npm run migrate:create-schedule-13d-g-filings:apply` once
  per environment. Idempotent.
- **A1 close:** Run `npm run edgar:13d-g:ingest --apply` to populate the
  raw-event table. Optional `--start-date` to bound the first ingest window
  (recommended ~6mo lookback to populate the aggregate baseline at faster
  pace than 60d-daemon-only cold-start).
- **A3 close:** Run `npm run migrate:create-schedule-13d-g-snapshots:apply`
  once per environment. Idempotent.
- **A5 close:** Operator inspects brief section #16 in the first daemon
  output; confirms cold-start + populated states render correctly.

---

## §13 · References

- Brav, Jiang, Partnoy & Thomas (2008), *Hedge Fund Activism, Corporate
  Governance, and Firm Performance*, J. Finance 63(4):1729-1775. (Activist
  13D return literature; sample construction; SC 13D-as-activist proxy.)
- Edmans, Fang & Zur (2013), *The Effect of Liquidity on Governance*, RFS
  26(6):1443-1482. (13D voice vs 13G exit; both generate value.)
- Collin-Dufresne & Fos (2015), *Do Prices Reveal the Presence of Informed
  Trading?*, J. Finance 70(4):1555-1582. (Pre-filing informed-trading
  window; structurally unobtainable post-EDGAR.)
- Brav & Jiang (2010), *Hedge Fund Activism: A Review*, Annual Review of
  Financial Economics. (Filer-reputation effects; well-known-activist
  premium; deferred to v2 ADR per XD-2.)
- Klein & Zur (2009), *Entrepreneurial Shareholder Activism: Hedge Funds
  and Other Private Investors*, J. Finance 64:187. (Activist sample
  construction methodology.)
- Bebchuk, Brav & Jiang (2015), *The Long-Term Effects of Hedge Fund
  Activism*, Columbia Law Review 115:1085. (Persistence-of-activism
  literature; rejection of "short-termism" criticism.)
- 17 CFR 240.13d-1 to 240.13d-102. (Statutory backbone; form-type
  partition.)
- 15 U.S.C. §78m(d) + §78m(g). (Securities Exchange Act §13(d) + §13(g)
  authority.)
- [ADR-043](adr-043-13d-13g-activist-stake-research.md) — RESEARCH note
  enumerating the six canon-thin forks resolved at SPEC time.
- [event-driven-filings-processor.md](event-driven-filings-processor.md) —
  parent SPEC (gap #7 v1; EK + F4 siblings; EDF-3 deferral resolved here).
