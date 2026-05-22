---
status: done
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
slice_id: gap-9-etf-flow
---

# SPEC — ETF Flow Monitoring (etf_flow_v1)

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-19 · **Author:** Claude (Vector Core principal engineer) · **Phase:** 9-gap unfreeze (gap #9) · **Authority:** [gap doc](../obsidian/gaps/etf-flow-monitoring.md), Ben-David-Franzoni-Moussawi 2018 *Journal of Finance*, Brown-Davies-Ringgenberg 2021 *RFS*
>
> **Stage in Vector Core build:** SPEC → CODE (Phase A only — informational substrate). Phase B (validation with the standard deflation pipeline — DSR, PBO, HLZ — per operator directive) deferred per the cycle-position / vol-structure / sector-rotation / cross-asset / short-interest / executive-departure precedent: ship informational first, validate after 60+ days OR via a dedicated backfill arc.
>
> **Lineage:** The seventh Phase-9-gap Layer-0 informational signal, after `cycle_v1` (s85), `vol_struct_v1` (s86), `sector_rot_v1` (s87), `cross_asset_v1` (s88), `short_interest_v1` (s89-s90), `exec_departure_v1` (s91). Same architectural template: SPEC → A1 (yfinance shares-outstanding ingest) → A2 (pure composite + tests) → A3 (CH snapshot table) → A4 (repository + daemon hook) → A5 (morning brief section).
>
> **Canon strength.** Unlike executive-departure (which carried a canon-thin caveat), ETF-flow has a strong Tier-1 anchor: Ben-David-Franzoni-Moussawi 2018 (*Journal of Finance*, 73(6), 2471-2535) constructs ETF flows from the CRSP shares-outstanding panel and documents that ETF arbitrage transmits non-fundamental demand shocks into the prices of underlying securities. The methodology in §5 is the JoF-replication of their flow construction (Δ shares-outstanding × close) at the daily horizon, then z-scored against a 1y trailing baseline — the same construction used by Brown-Davies-Ringgenberg 2021 *Review of Financial Studies* for predictability tests.
>
> **One canon-thin fork resolved autonomously: F-DATA-SOURCE.** The gap doc lists four data-source options (ETF.com scrape / ETFdb scrape / issuer CSVs / paid Bloomberg-Refinitiv-FactSet). v1 locks **yfinance shares-outstanding-derived flows** under the CLAUDE.md three-criterion test. See §2 row F-DATA-SOURCE for the analysis.

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the Layer-0 informational substrate with ETF flow signals at two scopes:
   - **Per-ETF**: surface a 20bd cumulative net-flow figure (in shares + in dollars + as % of AUM) for each ETF in the v1 universe (21 ETFs — see F-UNIVERSE). Surface a `flow_z` (z-score of % of AUM flow against trailing 1y daily baseline). Surface a `flow_price_divergence_flag` (binary) per ETF when 20bd flow and 20bd return have opposite signs AND both |z|>1 (see F-DIVERGENCE).
   - **Aggregate**: surface a `sector_flow_dispersion` figure (cross-sector stddev of the 11 SPDR sector ETF flow z-scores) — high dispersion indicates an active rotation regime vs broad risk-on/off. Surface an `aggregate_risk_on_flow` figure (mean of broad-index ETF flow z-scores across SPY+IVV+VOO+QQQ+IWM+DIA) for risk-appetite characterization. Surface an `aggregate_flow_stress_flag` (binary) when `sector_flow_dispersion > 2.0` (active rotation) OR `|aggregate_risk_on_flow| > 2.0` (broad-flow stress).
2. Persist daily snapshots to `quantlab.etf_flow_snapshots` so the brief and (eventually) Phase B independence tests + deflation-pipeline validation can read history.
3. Surface a section in the morning operator brief (section #13, appended last to preserve byte-equal-stdout protection on sections #1-#12).

**Non-goals:**

1. **No `phase1_v3` modification.** Aggregate flags do NOT add a category in v1; promotion to classifier input gates on Phase B independence test + a new ADR. Matches the cycle/vol/sector/cross-asset/short-interest/exec-departure posture.
2. **No universe-filter gating.** Per Phase 9+ gap-inventory README principle #5 ("informational-first before gating"), per-ETF flags are LOGGED — no hard exclusion of any sector or ticker in v1. Gap-doc's "Option B" (universe-filter integration) deferred to Phase C.
3. **No paid data sources.** Bloomberg / Refinitiv Lipper / FactSet ETF Analytics blocked per CLAUDE.md data-source policy.
4. **No ETF.com / ETFdb scraping in v1.** Per F-DATA-SOURCE three-criterion analysis below, yfinance shares-outstanding-derived flows are the canon-load-bearing free path. The scrape path remains *available* under CLAUDE.md (public-source scraping pre-authorized with required discipline) but is deferred to v2 as cross-validation if Phase B reveals yfinance data-quality gaps.
5. **No constituent-level holdings reconstruction.** Gap doc OQ ("Sector ETF flows or constituent-level flows?") resolved to sector-level only — constituent flows would require fund-holdings backout (e.g., parsing N-PORT filings or scraping issuer holdings pages) and a separate ADR. Deferred to v2.
6. **No flow-volatility or higher-moment features.** v1 captures level + z-score + divergence. Flow-volatility-driven flags (e.g., abnormal-flow-spike detection at 5d horizon) deferred to v2.
7. **No dashboard React panel in v1** (carry from S-VOL-4 / S-SR-4 / S-CA-4 / S-SI-9 / S-ED-8 — operator attention budget is finite).
8. **No backfill of pre-existing historical flow events.** Like exec-departure, the ingest is forward-from-request-date in v1; backfill IS possible (yfinance shares-outstanding goes back ~5y for major ETFs) but is operator-deferred.

---

## §2 · Decisions (locked at SPEC time)

| ID | Decision | Rationale |
|----|----------|-----------|
| **F-1** | Per-ETF measurement = **20-business-day cumulative net flow**, decomposed into (a) net flow in shares = `shares_outstanding_t - shares_outstanding_{t-20bd}`, (b) net flow in dollars = sum over the 20bd window of `(shares_t - shares_{t-1}) × close_t`, (c) flow as % of AUM = `net_dollar_flow_20bd / AUM_t` where `AUM_t = shares_t × close_t`. | Matches Ben-David-Franzoni-Moussawi 2018 §3 construction. 20bd is the gap-doc-specified horizon ("20-day cumulative net flow … smooths daily noise"). Sum-of-daily-flows construction (vs `shares_t - shares_{t-20bd} × close_t`) correctly attributes flows to the price level at which they were created (per BFM 2018 footnote 7). |
| **F-2** | Per-ETF z-score baseline = **trailing 1-year daily history** of the % of AUM flow figure, with `MIN_Z_BASELINE = 30` prints floor (matches cross-asset / sector-rotation / short-interest / exec-departure). Below the floor, `flow_z = null` and divergence/dispersion flags involving that ETF are skipped. | Gap doc spec: "Flow z-score vs trailing 1-year history — same-comparable across ETFs of different sizes." % of AUM normalizes the absolute-dollar gap-doc OQ (resolved at F-3). |
| **F-3** | **Flow normalization: % of AUM** (not absolute $) is the load-bearing per-ETF measure for z-scoring. Absolute $ is logged for reference but the z-score operates on % of AUM. | Gap doc OQ ("absolute dollars vs % of AUM?") resolved. Three-criterion: (1) **Canon foundations** — BFM 2018 normalize by lagged AUM exactly because absolute-flow magnitudes are not cross-ETF comparable. (2) **Methodology rigor** — z-scoring an unnormalized series across ETFs of different size (SPY = ~$500B AUM; XLRE = ~$5B) conflates "big ETF" with "high flow"; % of AUM gives a unit-free comparable. (3) **Free parameters** — zero (a single normalization, no calibration). |
| **F-4** | **Flow-price divergence rule:** for each ETF, `divergence_flag = (sign(return_20bd) ≠ sign(flow_z)) AND (\|return_z_20bd\| > 1) AND (\|flow_z\| > 1)` where `return_z_20bd` is the 20bd return z-scored against the trailing 1y daily distribution of 20bd returns. NO calibrated threshold (gap doc says "calibrated threshold"). | Three-criterion canon-thin resolution: (1) **Canon** — the ±1σ threshold is the standard pre-multiple-testing-correction signal threshold (matches cross-asset / sector-rotation / short-interest signed-z thresholds in the existing composites). (2) **Methodology rigor** — calibrating a threshold against in-sample backtests would violate the no-in-sample-tuning canon (AFML §11, Bailey-Lopez de Prado 2014). Using a non-tuned ±1σ-on-both-sides threshold preserves the deflation pipeline's free-parameter accounting. (3) **Free parameters** — zero (the ±1σ choice is inherited from prior composites). |
| **F-5** | **Aggregate sector-flow-dispersion:** `sector_flow_dispersion_t = stddev({flow_z_t for ETF in {XLK, XLF, XLE, XLV, XLY, XLP, XLU, XLI, XLB, XLRE, XLC}})`. The 11-element cross-sectional stddev at time t. Flagged as "active rotation regime" when `sector_flow_dispersion > 2.0`. | Gap doc indicator #4: "Sector flow dispersion: standard deviation of sector ETF flow z-scores — high dispersion indicates active rotation regime vs broad risk-on/off." The `>2.0` threshold parallels the per-ETF |z|>2 thresholds used in short-interest / exec-departure aggregates. NOT z-scored against a baseline of dispersions — the stddev itself is a sufficient statistic (further z-scoring is a free-parameter-inflating second-order operation). |
| **F-6** | **Aggregate risk-on flow:** `aggregate_risk_on_flow_t = mean({flow_z_t for ETF in {SPY, IVV, VOO, QQQ, IWM, DIA}})`. Flagged as "broad-flow stress" when `|aggregate_risk_on_flow| > 2.0`. | Gap doc indicator #3 cousin: "20-day cumulative net flow … smooths daily noise." Mean of broad-index flow z-scores characterizes broad risk-appetite direction. \|z\|>2 threshold matches the per-ETF threshold. |
| **F-7** | **Aggregate flow stress flag:** `aggregate_flow_stress_flag = (sector_flow_dispersion > 2.0) OR (\|aggregate_risk_on_flow\| > 2.0)`. | OR-aggregation matches the cross-asset / sector-rotation flag-OR posture. Either signal alone is sufficient to surface in the brief. |
| **F-DATA-SOURCE** | **Data source = yfinance shares-outstanding panel (via `yf.Ticker(ticker).get_shares_full(start, end)`), combined with daily close from the existing `daily_bars` table (already populated via `scripts/fetch_daily_yfinance.py`).** Per-day `AUM = shares × close`; per-day `flow_shares = shares_t - shares_{t-1}`; per-day `flow_dollar = flow_shares × close_t`. | **Three-criterion autonomous resolution of the gap doc's primary OQ ("ETF.com scrape vs issuer JSON — which is more resilient?").** (1) **Canon foundations** — BFM 2018 §3 explicitly constructs ETF flows from the CRSP shares-outstanding panel; yfinance shares-outstanding is the Yahoo-Finance-sourced equivalent of CRSP for free public access. The methodology MATCHES the load-bearing citation. (2) **Methodology rigor** — yfinance is a single library, schema-pinned (via `pip freeze`), well-tested. Scraping ETF.com requires per-page Playwright orchestration + schema validation on every fetch + cache-last-good discipline (all required per CLAUDE.md). Issuer CSVs require 4+ different parsers (iShares / SPDR / Invesco / Vanguard). (3) **Free parameters** — yfinance derive = 0 parsers. ETF.com scrape = 1 brittle parser + cache TTL parameter. Issuer-CSV multi-source = 4+ parsers + 4+ cache schedules. Resolved to yfinance. Documented as canon-load-bearing; scrape paths remain pre-authorized fallbacks per CLAUDE.md but are operator-deferred to v2. |
| **F-UNIVERSE** | **v1 universe = 21 ETFs**, split into three groups: (a) **broad-index** (6): SPY, IVV, VOO, QQQ, IWM, DIA. (b) **SPDR sector** (11): XLK, XLF, XLE, XLV, XLY, XLP, XLU, XLI, XLB, XLRE, XLC. (c) **style/risk** (4): HYG, JNK, TLT, GLD. | Subset of gap doc list; tight enough to keep ingest fast (21 × 1y of daily shares-outstanding ≈ 5300 rows on first ingest) + cover the load-bearing factor exposures. The "expanded universe" (long-tail sector and country ETFs) deferred to v2 with explicit ADR. |
| **F-CADENCE** | Snapshot cadence = daemon-daily. The composite re-evaluates per-ETF flows + aggregate dispersions on every daemon run; on days yfinance has not yet updated the shares-outstanding panel for a given ETF, the prior-day value is used (carry-forward, NOT linear interpolation). Flag a staleness condition when `bd_since_last_share_update > 3` (matches the exec-departure 4bd statutory threshold). | Matches the daemon's daily snapshot pattern for all other Layer-0 composites. Carry-forward (vs interpolation) is honest: an unchanged shares-outstanding value DOES mean zero net flow on that day in the BFM construction; only the data-source-lagged case requires the staleness flag. |
| **F-9** | **Aggregate baseline floor:** for the `sector_flow_dispersion` and `aggregate_risk_on_flow`, both composites require ALL constituent ETFs to have valid (non-null) `flow_z` values. If any constituent's `flow_z = null` (below MIN_Z_BASELINE per F-2), the aggregate value = null and the aggregate flag = false. | Cold-start condition: until all 11 sector ETFs have 30+ days of flow history, `sector_flow_dispersion = null`. Matches the cross-asset / sector-rotation cold-start pattern. |
| **F-10** | Snapshot version stamp: `etf_flow_v1`. Bumps on universe change (add/remove an ETF), window change (20bd → 10bd or 60bd), threshold change (\|z\|>1 → \|z\|>1.5 for divergence, >2.0 → >2.5 for aggregate), normalization change (% of AUM → absolute $), or AUM construction change (current shares × current close → trailing-7d-average smoothed). | Bump triggers match the prior six Layer-0 composites. Each per-bump invalidates the prior baselines (a 20bd window cannot be reused for a 60bd computation). |
| **F-11** | Brief section = **#13**, appended last to preserve byte-equal-stdout protection on sections #1-#12 (cycle-position #7, vol-structure #8, sector-rotation #9, cross-asset #10, short-interest #11, exec-departure #12). | Established pattern across all six prior Layer-0 informational composites. |
| **F-12** | **Yfinance User-Agent + rate-limit compliance:** yfinance internally manages requests to Yahoo Finance; per yfinance ≥ 0.2.x default behavior is to use a polite User-Agent and back off on 429. v1 inherits this. Cold-cache 21-ETF × 1y first-run is ~30-60s sequential. | The yfinance package is established in this repo (`scripts/macro_regime_ingest.py`, `scripts/fetch_daily_yfinance.py`); same dependency, same compliance posture, no new infrastructure. |
| **F-13** | **Snapshot table design:** one row per daemon run, with per-ETF JSON + aggregate JSON. Mirrors short-interest A3 + exec-departure A3 precedent (single JSON column per logical block rather than row-per-ETF child tables). | Per-ETF block is ~21 rows × ~8 fields each ≈ ~5KB; aggregate block is ~6 scalars + flagged-sectors list ≈ ~1KB. Total snapshot row ~6KB; 252 trading days/year → ~1.5MB/year storage. Negligible. |
| **F-14** | **Source-table design:** the raw `etf_shares_outstanding` table holds the daily shares-outstanding + close panel per ETF (one row per (ticker, date)). Deduplication via ReplacingMergeTree keyed on (ticker, date). | Same pattern as the existing `quantlab.daily_bars` table for prices. The composite (A2) reads this table directly; it does NOT operate on the snapshot table for source-of-truth flow computation. |

---

## §3 · Component diagram

```text
            ┌──────────────────────┐
            │ Yahoo Finance        │
            │   (yfinance package, │     pre-authorized per
            │    shares-           │     CLAUDE.md data-source policy
            │    outstanding +     │
            │    close)            │
            └─────────┬────────────┘
                      │ shares-outstanding update cadence:
                      │   - ETFs: typically daily (after creation/redemption settles)
                      │   - Yahoo lag: T+1 to T+2 typically
                      ▼
            ┌──────────────────────┐
            │ scripts/             │   A1 — ingest unit
            │   etf_flow_ingest    │   - poll yfinance shares_full per ETF
            │   .py                │   - join with daily_bars close
                      ▼             │   - write to etf_shares_outstanding
            ┌──────────────────────┐
            │ quantlab.            │
            │   etf_shares_        │   - one row per (ticker, date)
            │   outstanding        │   - ReplacingMergeTree keyed on
            │   (per-day panel)    │     (ticker, date)
            └─────────┬────────────┘
                      │ daemon read
                      ▼
            ┌──────────────────────┐
            │ src/server/          │   A2 — pure composite
            │   etf_flow.ts        │   - per-ETF 20bd cumulative flow
            │                      │   - per-ETF flow_z (1y baseline)
            │                      │   - per-ETF divergence_flag (F-4)
            │                      │   - sector_flow_dispersion (F-5)
            │                      │   - aggregate_risk_on_flow (F-6)
            │                      │   - aggregate_flow_stress_flag (F-7)
            └─────────┬────────────┘
                      ▼
            ┌──────────────────────┐
            │ quantlab.            │   A3 — snapshot table
            │   etf_flow_          │   - one snapshot row per daemon run
            │   snapshots          │   - ReplacingMergeTree(version)
            │                      │     keyed on (snapshot_date)
            └─────────┬────────────┘
                      │ daemon write + brief read
                      ▼
            ┌──────────────────────┐
            │ scripts/             │   A4 — daemon hook
            │   daily_signal_      │   step 1j — between exec-departure (1i)
            │   daemon.ts          │   and the cells/bundles section (§2)
            └─────────┬────────────┘
                      ▼
            ┌──────────────────────┐
            │ src/server/          │   A5 — brief panel
            │   operator_brief*    │   section #13
            │   .ts                │
            └──────────────────────┘
```

---

## §4 · Inputs (per F-DATA-SOURCE / F-UNIVERSE / F-CADENCE)

| Source | Field | CH destination | Notes |
|--------|-------|----------------|-------|
| yfinance `Ticker.get_shares_full(start, end)` | shares outstanding (daily) | `etf_shares_outstanding.shares` | Float; ETFs typically integer-valued but float-preserving avoids precision-loss. Carry-forward on missing days (F-CADENCE). |
| yfinance `Ticker.history(start, end)` close | daily close | `etf_shares_outstanding.close` | Float; reuses or supplements `quantlab.daily_bars`. Joined on (ticker, date). |
| yfinance `Ticker.info["totalAssets"]` | current AUM (scalar) | NOT persisted (sanity check only) | Used during A1 to sanity-check that `shares_t × close_t ≈ totalAssets` on first-ingest day. Logged on mismatch >5%, not fatal. |
| Computed in A2 | 20bd cumulative flow shares = `shares_t - shares_{t-20bd}` | `etf_flow_snapshots.per_etf_json` | F-1 (a). |
| Computed in A2 | 20bd cumulative flow dollars = `sum_{i=t-19}^{t} ((shares_i - shares_{i-1}) × close_i)` | `etf_flow_snapshots.per_etf_json` | F-1 (b). |
| Computed in A2 | flow as % of AUM = `dollar_flow_20bd / AUM_t` where `AUM_t = shares_t × close_t` | `etf_flow_snapshots.per_etf_json` | F-1 (c). |
| Computed in A2 | flow_z = z-score of `flow_pct_aum_t` against trailing 1y daily history | `etf_flow_snapshots.per_etf_json` | F-2 + MIN_Z_BASELINE=30 floor. |
| Computed in A2 | return_20bd, return_z_20bd | `etf_flow_snapshots.per_etf_json` | F-4 inputs. |
| Computed in A2 | divergence_flag | `etf_flow_snapshots.per_etf_json` | F-4. |
| Computed in A2 | sector_flow_dispersion, aggregate_risk_on_flow, aggregate_flow_stress_flag | `etf_flow_snapshots.aggregate_json` | F-5, F-6, F-7. |

---

## §5 · Composite formulas

### §5.1 Per-ETF (per F-1 / F-2 / F-4)

For each ETF in the v1 universe (F-UNIVERSE), as of snapshot date D:

```text
let s_t      = shares_outstanding(ETF, D)
let close_t  = close(ETF, D)
let AUM_t    = s_t × close_t

let s_t-20  = shares_outstanding(ETF, D - 20bd)
let flow_shares_20bd  = s_t - s_t-20

let flow_dollar_20bd  = sum over i in [D-19bd, D] of:
                          (shares_outstanding(ETF, i) - shares_outstanding(ETF, i-1))
                          × close(ETF, i)

let flow_pct_aum_t    = flow_dollar_20bd / AUM_t

let return_20bd       = close_t / close(ETF, D - 20bd) - 1

let baseline_flow_pct = trailing(flow_pct_aum, 1y daily, ending at D)
let baseline_ret_20bd = trailing(return_20bd, 1y daily, ending at D)

if count(baseline_flow_pct) < MIN_Z_BASELINE (=30):
  flow_z = null
else:
  flow_z = (flow_pct_aum_t - mean(baseline_flow_pct)) / stddev(baseline_flow_pct)

if count(baseline_ret_20bd) < MIN_Z_BASELINE (=30):
  return_z_20bd = null
else:
  return_z_20bd = (return_20bd - mean(baseline_ret_20bd)) / stddev(baseline_ret_20bd)

let divergence_flag = (flow_z != null) AND (return_z_20bd != null)
                       AND (sign(flow_z) != sign(return_z_20bd))
                       AND (abs(flow_z) > 1)
                       AND (abs(return_z_20bd) > 1)
```

**Note on shares-outstanding sparsity.** Yahoo Finance's shares-outstanding panel updates on T+1 to T+2 typically; carry-forward (F-CADENCE) of the last-observed value is used for in-between days. A 0 daily flow during a carry-forward day reflects "no new data" not "zero creation/redemption activity" — operator must read the staleness indicator (per F-CADENCE, `bd_since_last_share_update > 3` flags as stale).

### §5.2 Aggregate (per F-5 / F-6 / F-7 / F-9)

For the 11 SPDR sector ETFs:

```text
let SECTOR_ETFs = ['XLK','XLF','XLE','XLV','XLY','XLP','XLU','XLI','XLB','XLRE','XLC']

if any(flow_z(etf) == null for etf in SECTOR_ETFs):
  sector_flow_dispersion = null
else:
  sector_flow_dispersion = stddev({flow_z(etf) for etf in SECTOR_ETFs})
```

For the 6 broad-index ETFs:

```text
let BROAD_ETFs = ['SPY','IVV','VOO','QQQ','IWM','DIA']

if any(flow_z(etf) == null for etf in BROAD_ETFs):
  aggregate_risk_on_flow = null
else:
  aggregate_risk_on_flow = mean({flow_z(etf) for etf in BROAD_ETFs})
```

Aggregate stress flag:

```text
let aggregate_flow_stress_flag = (sector_flow_dispersion != null AND sector_flow_dispersion > 2.0)
                                 OR
                                 (aggregate_risk_on_flow != null AND abs(aggregate_risk_on_flow) > 2.0)
```

When all baselines are below the 30-print floor (cold-start condition), `sector_flow_dispersion = null`, `aggregate_risk_on_flow = null`, `aggregate_flow_stress_flag = false`. Matches the cross-asset / sector-rotation / short-interest / exec-departure cold-start pattern.

### §5.3 Snapshot payload

```typescript
interface EtfFlowSnapshot {
  snapshot_date: Date;                                // YYYY-MM-DD
  last_yfinance_query_at: Date | null;                // wall-clock UTC of most-recent ingest
  bd_since_last_share_update: number | null;          // staleness across the universe (max)

  // Aggregate:
  sector_flow_dispersion: number | null;              // F-5
  aggregate_risk_on_flow: number | null;              // F-6
  aggregate_flow_stress_flag: boolean;                // F-7
  flagged_etfs: Array<{                               // ETFs with divergence_flag=true OR |flow_z|>2
    ticker: string;
    flow_z: number;
    return_z_20bd: number | null;
    flow_pct_aum_t: number;
    divergence_flag: boolean;
  }>;

  // Per-ETF (full universe):
  per_etf_rows: Array<{
    ticker: string;
    group: 'broad' | 'sector' | 'style';
    shares_outstanding_t: number;
    close_t: number;
    aum_t: number;
    flow_shares_20bd: number;
    flow_dollar_20bd: number;
    flow_pct_aum_t: number;
    flow_z: number | null;
    return_20bd: number;
    return_z_20bd: number | null;
    divergence_flag: boolean;
    bd_since_share_update: number;                    // 0 if shares updated today; >3 = stale
  }>;

  // Diagnostic:
  inputs_available: { aggregate_sector: number, aggregate_broad: number, per_etf: number };
  version: 'etf_flow_v1';
}
```

---

## §6 · CH snapshot table (Phase A3 migration)

```sql
CREATE TABLE quantlab.etf_flow_snapshots (
  snapshot_date              Date,
  last_yfinance_query_at     Nullable(DateTime),
  bd_since_last_share_update Nullable(Int32),

  sector_flow_dispersion     Nullable(Float64),
  aggregate_risk_on_flow     Nullable(Float64),
  aggregate_flow_stress_flag UInt8,                  -- 0/1

  flagged_etfs_json          String,                  -- JSON-encoded array (~ETFs with divergence or |z|>2)
  per_etf_json               String,                  -- JSON-encoded per-ETF rows (21 rows; ~6KB)
  aggregate_json             String,                  -- JSON-encoded aggregate block (mirror of scalars above)

  inputs_available_aggregate_sector UInt32,
  inputs_available_aggregate_broad  UInt32,
  inputs_available_per_etf          UInt32,

  version                    LowCardinality(String) DEFAULT 'etf_flow_v1',
  ingested_at                DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, version)
SETTINGS index_granularity = 1024;
```

A separate source table holds the per-day shares-outstanding + close panel:

```sql
CREATE TABLE quantlab.etf_shares_outstanding (
  ticker                LowCardinality(String),
  date                  Date,
  shares                Float64,                      -- shares outstanding (float-preserving)
  close                 Float64,                      -- close from yfinance
  aum                   Float64,                      -- materialized: shares × close (for query speed)
  source                LowCardinality(String) DEFAULT 'yfinance',
  ingested_at           DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (ticker, date)
SETTINGS index_granularity = 1024;
```

The `aum` column is materialized at ingest (NOT a computed expression) for read speed: the A2 composite scans 21 ETFs × 252 days (1y baseline) on every daemon run.

---

## §7 · Daemon hook position

Step **1j. ETF-flow evaluation** — between exec-departure (step 1i, s91) and the cells/bundles resolution (§2). Same posture as cycle-position / vol-structure / sector-rotation / cross-asset / short-interest / exec-departure: absent-table-safe, non-fatal, gated by `NO_MACRO || DRY_RUN`. The hook reads the latest `etf_shares_outstanding` panel-as-of-D for the v1 universe (21 ETFs), computes the composite, writes one row to `etf_flow_snapshots`.

The chain: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → §2 cells/bundles`.

---

## §8 · Brief panel (section #13)

```text
─────────────────────────────────────────────────────────────────────────
 §13 — ETF FLOWS (as of 2026-05-19, 20bd cumulative, 1y baseline)
─────────────────────────────────────────────────────────────────────────
  Aggregate:

    flow_stress_flag:           NO

    sector_flow_dispersion:     1.3    (rotation regime threshold = 2.0)
    aggregate_risk_on_flow:    +0.4σ   (broad-index mean across SPY/IVV/VOO/QQQ/IWM/DIA)

  Broad-index 20bd flows (% of AUM):

    SPY   +0.8%  z=+0.6σ  ret_20=+2.4% (z=+0.8σ)   ─
    QQQ   +2.1%  z=+1.4σ  ret_20=+3.1% (z=+1.1σ)   ─
    IWM   -1.4%  z=-1.2σ  ret_20=-0.6% (z=-0.3σ)   ─
    HYG   -0.3%  z=-0.4σ  ret_20=+0.1% (z=+0.0σ)   ─
    TLT   +1.2%  z=+0.9σ  ret_20=-1.2% (z=-0.6σ)   ←  DIVERGENCE (inflow vs price drop)

  Flagged ETFs (divergence or |z|>2):

    TLT   flow=+1.2% (z=+0.9σ)  ret=-1.2% (z=-0.6σ)  [divergence: flow-in / price-down ─ flight-to-safety?]
    XLE   flow=-3.4% (z=-2.3σ)  ret=+1.8% (z=+0.7σ)  [|z|>2: heavy outflow against rising price]

  Sector-flow z-scores (top by abs):

    XLE   -2.3σ
    XLU   +1.7σ
    XLK   +1.2σ
    ...

  Last yfinance query:          2026-05-19 14:23 UTC (today)
  Universe coverage:            21/21 ETFs current (no stale shares-outstanding)
```

The flagged-ETFs section truncates at the top-N most extreme on each side (N=5 default per panel, matching the short-interest / exec-departure A5 convention). Operators can read the full per-ETF table via the per-ETF JSON in the snapshot, or via the dashboard panel (out-of-scope for v1).

---

## §9 · Test plan

### §9.1 Pure-function (`scripts/tests/etfFlow.test.ts`)

- T-EF-1 — `flow_shares_20bd` computed correctly: `shares_t = 1000`, `shares_{t-20bd} = 950` → flow = 50.
- T-EF-2 — `flow_dollar_20bd` is sum-of-daily, NOT (shares_t - shares_{t-20bd}) × close_t (BFM 2018 footnote 7 attribution).
- T-EF-3 — `flow_pct_aum_t` = `flow_dollar_20bd / (shares_t × close_t)`.
- T-EF-4 — `flow_z` returns null when baseline < 30 prints (cold-start).
- T-EF-5 — `flow_z` with 30+ prints: known mean/stddev fixture, expected z to ε precision.
- T-EF-6 — `return_z_20bd` cold-start parity with `flow_z`.
- T-EF-7 — `divergence_flag` fires on (flow_z=+1.5, return_z=-1.5): opposite signs, both |z|>1.
- T-EF-8 — `divergence_flag` does NOT fire on (flow_z=+1.5, return_z=-0.5): magnitudes don't both clear 1.
- T-EF-9 — `divergence_flag` does NOT fire on (flow_z=+1.5, return_z=+1.5): same signs (no divergence).
- T-EF-10 — `divergence_flag` returns false when either z is null (cold-start).
- T-EF-11 — `sector_flow_dispersion` = stddev across 11 SPDR sector ETFs.
- T-EF-12 — `sector_flow_dispersion = null` when any sector ETF z is null.
- T-EF-13 — `aggregate_risk_on_flow` = mean across 6 broad-index ETFs.
- T-EF-14 — `aggregate_risk_on_flow = null` when any broad ETF z is null.
- T-EF-15 — `aggregate_flow_stress_flag` fires when `sector_flow_dispersion > 2.0`.
- T-EF-16 — `aggregate_flow_stress_flag` fires when `|aggregate_risk_on_flow| > 2.0`.
- T-EF-17 — `aggregate_flow_stress_flag = false` in cold-start (all aggregate scalars null).
- T-EF-18 — Carry-forward on shares-outstanding: missing day → use prior-day value; flow on that day = 0.
- T-EF-19 — `bd_since_last_share_update` increments on a stale-shares fixture.
- T-EF-20 — `flagged_etfs` correctly populated: divergence ETFs + |z|>2 ETFs both included; deduplicated.

### §9.2 Repository (`scripts/tests/etfFlowRepository.test.ts`)

- T-EFR-1..N — `writeSnapshot` round-trip with FakeClickHouse.
- T-EFR-Nplus — `readLatest` returns the most-recent snapshot per `(snapshot_date, version)`.
- T-EFR-Nplus2 — `etfFlowSnapshotsTableExists` returns true/false correctly (absent-table-safe gate).
- T-EFR-Nplus3 — Daemon-orchestration `runDaemonEtfFlowEvaluation` end-to-end.
- T-EFR-Nplus4 — `readSharesOutstandingForCycle` uses the subquery-around-FINAL pattern (a52c964 regression class).
- T-EFR-Nplus5 — Malformed `per_etf_json` and `aggregate_json` degrade gracefully (returns empty arrays/nulls, never throws).
- T-EFR-Nplus6 — EXPLAIN PLAN regression (skipped when CH unavailable).

### §9.3 Migration (`scripts/tests/migrateCreateEtfFlowSnapshots.test.ts`)

- T-EFM-1 — Dry-run mode reports planned DDL without executing.
- T-EFM-2 — Apply mode creates the table; re-apply is no-op.
- T-EFM-3 — DDL matches §6 schema exactly (field-by-field assertion).
- T-EFM-4 — Both tables (`etf_shares_outstanding`, `etf_flow_snapshots`) created idempotently.

### §9.4 Ingest (`scripts/tests/test_etf_flow_ingest.py` — Python)

- T-EFI-1 — yfinance `get_shares_full` response parse against fixture.
- T-EFI-2 — Join with `daily_bars` close on (ticker, date).
- T-EFI-3 — Materialized AUM column populated correctly at ingest.
- T-EFI-4 — Sanity-check log on `shares × close ≠ totalAssets` >5% mismatch (non-fatal).
- T-EFI-5 — Idempotent re-ingest under ReplacingMergeTree on (ticker, date).
- T-EFI-6 — Carry-forward behavior: missing day in yfinance shares panel → carry prior; explicit log line.
- T-EFI-7 — Rate-limit / 429 handling via yfinance built-in back-off (smoke-only).
- T-EFI-8 — Universe coverage check: all 21 ETFs in F-UNIVERSE attempted; report partial-failure count without aborting.

### §9.5 Brief (`scripts/tests/operatorBriefRender.test.ts` — extension)

- T-OBR-EF-1 — Section #13 renders at byte-equal protection (appended after section #12).
- T-OBR-EF-2 — Top-N flagged ETFs truncation at N=5 with "X more …" note.
- T-OBR-EF-3 — `aggregate_flow_stress_flag: YES` rendering on a fixture with high dispersion.
- T-OBR-EF-4 — Cold-start fallback: all-null aggregate renders "Aggregate baseline cold-start (n < 30) — no z-scores available."
- T-OBR-EF-5 — "No ETFs flagged." fallback when both arrays empty.
- T-OBR-EF-6 — Staleness indicator renders correctly on `bd_since_last_share_update > 3`.

### §9.6 Composer wiring (`scripts/tests/operatorBrief.test.ts` — extension)

- T-OB-EF-1 — `composeMorningBrief` threads `etfFlow` snapshot through `Promise.all`.
- T-OB-EF-2 — `fetchLatestEtfFlowFromCH` graceful-degrades on throw (mirrors short-interest / exec-departure A5 posture).
- T-OB-EF-3 — Null pass-through: `composeMorningBrief` with `fetchLatestEtfFlow: () => null` renders the "not yet evaluated" footer.

---

## §10 · Implementation phases

| Phase | Deliverable | Estimated effort |
|-------|-------------|------------------|
| **A1** | `scripts/etf_flow_ingest.py` (Python). yfinance `get_shares_full` poll for the v1 21-ETF universe + join with `daily_bars` close + materialized AUM + write to `quantlab.etf_shares_outstanding`. Migration script for the source table. Tests under `scripts/tests/` (pytest). | ~2 days |
| **A2** | `src/server/etf_flow.ts` (pure functions per §5). Tests under `scripts/tests/etfFlow.test.ts`. | ~1 day |
| **A3** | `scripts/migrate_create_etf_flow_snapshots.ts`. Migration test. Migration applied (dry-run + apply). | ~0.5 day |
| **A4** | `src/server/etf_flow_repository.ts` (read/write/exists/daemon-orchestration). `scripts/daily_signal_daemon.ts` step 1j hook. Tests. | ~1.5 days |
| **A5** | `src/server/operator_brief.ts` + `operator_brief_render.ts` section #13. Tests on byte-equal protection + flagged-ETFs rendering. | ~1 day |

Total: **~6 working days** (matches gap-doc's 2-week pre-Opus estimate; closer to 1 week of focused Opus execution under the autonomous-execution protocol).

Each sub-phase commits as its own commit. SPEC (this doc) lands as the first commit.

---

## §11 · Open questions (deferred to implementation)

1. **yfinance `get_shares_full` API stability.** The `shares_full(start, end)` method is in `yfinance ≥ 0.2.x`; the exact API surface may evolve. A1 hard-pins the yfinance version (compatible-major in `requirements.txt` if it exists; otherwise documented in the A1 script header). Operator can override the source via a `--source` flag in A1 (default `yfinance`, future `etfcom-scrape` for fallback).

2. **Shares-outstanding for new ETFs.** ETFs launched within the trailing 1y will have <252 days of shares-outstanding history → `flow_z = null` for their full first year. v1 accepts this — the universe is locked at 21 established ETFs (oldest = SPY launched 1993). No new-ETF handling needed.

3. **Yahoo Finance shares-outstanding accuracy vs creation/redemption truth.** Yahoo's shares-outstanding panel is sourced from issuer filings + creation/redemption notices; a 1-2 bd lag is typical. The F-CADENCE staleness flag handles the operator-visible signal; for forensic deep-dives, the operator can cross-validate against issuer pages (out-of-scope for v1).

4. **GICS sector mapping for SPDR ETFs.** The 11 SPDR sector ETFs map 1:1 to GICS sectors by construction (XLK → Information Technology, etc.). A2 hard-codes the mapping as a constant; no lookup table needed.

5. **Splits / dividends affecting shares-outstanding interpretation.** ETF splits are rare but possible (e.g., GLD had a 1:10 forward split in 2008). Yahoo's `shares_full` is split-adjusted post-event; the F-1 construction `(shares_t - shares_{t-1}) × close_t` remains correct when both shares AND close are split-adjusted consistently. Forensic-edge tests on a known split fixture deferred to A2 (T-EF-Nplus).

6. **20bd cumulative flow vs 5bd / 60bd horizons.** Gap doc OQ ("Does ETF flow z-score lead, lag, or coincide …"). v1 locks 20bd per gap-doc spec. Phase B lead-lag analysis (5bd vs 20bd vs 60bd) is its own dedicated arc.

7. **Constituent-level flow attribution.** Gap doc OQ ("Sector ETF flows or constituent-level flows? Constituent-level is cleaner but requires holdings reconstruction"). v1 = sector-level only. v2 ADR scope: parse N-PORT filings or issuer holdings to backout constituent-level flow attribution.

8. **Volatility / higher-moment flow features.** Gap doc indicator list is 4 items; v1 implements items 1-4. Higher-moment features (5bd flow stddev, flow skewness, flow auto-correlation as a momentum proxy) deferred to v2.

9. **Universe expansion.** v1 = 21 ETFs. Adding country ETFs (EFA, EEM, FXI, EWZ) or factor ETFs (MTUM, QUAL, USMV) requires a F-10 version bump and a new ADR (which ETFs add value beyond the v1 set is itself a Phase B question).

10. **Snapshot retention policy.** Daemon writes a snapshot per day; per-ETF JSON + aggregate JSON together ~6KB. At 252 trading days/year that's ~1.5MB/year of snapshot growth (smallest of all Layer-0 composites so far). No pruning needed.

11. **Source-table retention.** `etf_shares_outstanding` grows at 21 ETFs × 252 trading days/year ≈ 5300 rows/year. Negligible. No pruning needed.

---

## §12 · References

- **Ben-David, Franzoni, Moussawi 2018** — "Do ETFs Increase Volatility?" *Journal of Finance* 73(6), 2471-2535. Documents that ETF arbitrage transmits non-fundamental demand shocks into the prices of underlying securities. §3 defines flow construction as Δ shares-outstanding × close — the methodology this SPEC replicates at the daily horizon.
- **Brown, Davies, Ringgenberg 2021** — "ETF Arbitrage, Non-Fundamental Demand, and Return Predictability." *Review of Financial Studies* 34(7), 3145-3192. Tests flow-based predictability of underlying constituent returns at 5-20 day horizons; methodology directly applicable.
- **Stambaugh 2014** — "Presidential Address: Investment Noise and Trends." *Journal of Finance* 69(4), 1415-1453. Distinguishes "trends" (slow, informative) from "noise" (high-frequency, non-informative) in flow data — supports the 20bd cumulative horizon vs daily-flow noise.
- **ADR-037** — `phase1_v3` regime classifier design (current baseline; v1 ETF flow composite does NOT modify).
- **gap doc** — [`docs/obsidian/gaps/etf-flow-monitoring.md`](../obsidian/gaps/etf-flow-monitoring.md).
- **prior Layer-0 SPECs (architectural template):**
  - [`docs/specs/market-cycle-position.md`](./market-cycle-position.md) (s85)
  - [`docs/specs/expanded-vol-structure.md`](./expanded-vol-structure.md) (s86)
  - [`docs/specs/sector-rotation.md`](./sector-rotation.md) (s87)
  - [`docs/specs/cross-asset-signals.md`](./cross-asset-signals.md) (s88)
  - [`docs/specs/short-interest-tracking.md`](./short-interest-tracking.md) (s89-s90)
  - [`docs/specs/executive-departure-signal.md`](./executive-departure-signal.md) (s91)
- **yfinance package** — https://github.com/ranaroussi/yfinance ; pre-authorized per CLAUDE.md data-source policy. Existing repo usage in `scripts/macro_regime_ingest.py` + `scripts/fetch_daily_yfinance.py`.
- **CLAUDE.md data-source policy** — yfinance pre-authorized; ETF.com Playwright scrape pre-authorized as a scrape fallback per the public-source-scraping discipline (schema validation + parse-failure alerts + cached last-good + no silent stale-data propagation).
- Companion gap (next in queue): [`docs/obsidian/gaps/event-driven-filings-processor.md`](../obsidian/gaps/event-driven-filings-processor.md) (#7).
