# SPEC — Short Interest Tracking (short_interest_v1)

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-19 · **Author:** Claude (Vector Core principal engineer) · **Phase:** 9-gap unfreeze (gap #10) · **Authority:** [gap doc](../obsidian/gaps/short-interest-tracking.md), Boehmer-Jones-Zhang 2008 *Journal of Finance*, Diether-Lee-Werner 2009 *Review of Financial Studies*, Asquith-Pathak-Ritter 2005 *JFE*
>
> **Stage in Vector Core build:** SPEC → CODE (Phase A only — informational substrate). Phase B (validation with standard deflation pipeline — DSR, PBO, HLZ — per operator directive) deferred per the cycle-position / vol-structure / sector-rotation / cross-asset precedent: ship informational first, validate after 60+ days OR via a dedicated backfill arc.
>
> **Lineage:** The fifth Phase-9-gap Layer-0 informational signal, after `cycle_v1` (s85), `vol_struct_v1` (s86), `sector_rot_v1` (s87), `cross_asset_v1` (s88). Same architectural template: SPEC → A1 (FINRA ingest) → A2 (pure composite + tests) → A3 (CH snapshot table) → A4 (repository + daemon hook) → A5 (morning brief section).

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the Layer-0 informational substrate with short-interest signals at two scopes:
   - **Per-stock**: surface `short_ramp` and `short_capitulation` flags on each ticker in the equity-midcap watch universe, sourced from FINRA biweekly short-interest reports. Diether-Lee-Werner 2009 evidence: short interest *rate of change* is predictive (Boehmer-Jones-Zhang 2008 is the level evidence, but the level signal is largely priced in for stable cohorts; the ROC is the bearish predictive edge).
   - **Aggregate**: surface a `sentiment_short_extreme` flag at the SPY-constituents level, z-scored against trailing 2y history. Treated as weakly contrarian (high aggregate short = mildly bullish over 60+ days) per Asquith-Pathak-Ritter 2005 §4.
2. Persist daily snapshots to `quantlab.short_interest_snapshots` so the brief and (eventually) Phase B independence tests + deflation-pipeline validation can read history.
3. Surface a section in the morning operator brief (section #11, appended last to preserve byte-equal-stdout protection on sections #1-#10).

**Non-goals:**

1. **No `phase1_v3` modification.** The aggregate flag does NOT add a category in v1 (S-SI-2 lock); promotion to classifier input gates on Phase B independence test + a new ADR.
2. **No universe-filter gating.** Per Phase 9+ gap-inventory README principle #5 ("informational-first before gating"), per-stock flags are LOGGED alongside trades — strategies + universe filter consume them as features (or ignore) but no hard exclusion happens in v1.
3. **No paid data sources.** FINRA biweekly is the canon-load-bearing free source; S3 Partners / IHS Markit / Hazeltree intraday cuts are out-of-scope. The academic evidence (Boehmer-Jones-Zhang, Diether-Lee-Werner) is built on biweekly data — paid daily cuts add cadence, not predictive power.
4. **No dashboard React panel in v1** (carry from S-VOL-4 / S-SR-4 / S-CA-4 — operator attention budget is finite).
5. **No backfill of pre-existing historical short-interest data.** FINRA publishes only forward from request date. Backfill IS possible from FINRA's archive (data goes back to ~1990) but is operator-deferred — same posture as the cycle-position Phase B backfill arc (s89).

---

## §2 · Decisions (locked at SPEC time)

| ID | Decision | Rationale |
|----|----------|-----------|
| **S-SI-1** | Data source: FINRA biweekly short interest reports (free, official, ~8 business day publication lag from settlement date). Reg SHO daily short volume is a separate optional intra-period confirmation, OUT-OF-SCOPE in v1. | Free + pre-authorized per the CLAUDE.md data-source policy (FINRA Reg-SHO + short-interest listed explicitly). Academic evidence is built on biweekly cadence. Reg SHO daily can be added in v2 if intra-period confirmation proves valuable. |
| **S-SI-2** | Composite is **informational only in v1**. Does NOT fire a `phase1_v3` category. | Same posture as `cycle_v1` / `vol_struct_v1` / `sector_rot_v1` / `cross_asset_v1`. Rollback-safe. Phase B validation (with DSR + PBO + HLZ deflation per operator directive) gates promotion. |
| **S-SI-3** | Per-stock signal: ROC-based, NOT level-based. **Short ramp:** ROC over 3 months (6 biweekly reports) > +50% AND days-to-cover > 5. **Short capitulation:** ROC < -40% from a high base (defined as: prior-period SIR > median + 1σ of trailing 2y per-ticker SIR). | Diether-Lee-Werner 2009 §3 — "It is the change in short interest that matters, not the level." Level-only filters (`SIR > 20%`) do NOT reproduce the academic results. The high-base qualifier on capitulation prevents misfires on tickers with chronically low SIR. |
| **S-SI-4** | Aggregate signal universe: SPY 500 constituents (PIT via `quantlab.sp500_constituents`). Russell 3000 expansion is operator-deferred (gap-doc open question #3). | SPY constituent panel is already PIT-maintained for backtests. Russell 3000 would broaden coverage but adds noise from micro-caps where SIR is structurally higher and less informative — Asquith-Pathak-Ritter 2005 §5 documents the small-cap noise floor. |
| **S-SI-5** | **Lag-adjustment is settlement-date-aware.** The daemon snapshot dated T reads only FINRA reports whose settlement date ≤ T-8 business days (the typical publication lag). NEVER read a report dated T-N if it wasn't yet published as of the snapshot's wall-clock day. | Gap doc watch-out: "using a report dated the 15th on the 16th is a 9-day forward-look leak." A naive panel join would inject look-ahead bias into any Phase B backtest. Settlement-date-aware lag is the load-bearing protection. |
| **S-SI-6** | **Split-adjustment is share-count-aware.** SIR is computed as `shares_short / shares_outstanding`, both pulled from FINRA's report (NOT from yfinance's adjusted close — that adjusts price, not share count). For ROC, both numerator and denominator are split-adjusted to the latest split factor; corporate-action history maintained in a small `corporate_actions` table OR pulled live from yfinance's `actions` endpoint per ingest. | Gap doc watch-out: "rate of change can spike artificially around stock splits." Adjusting for splits BEFORE computing ROC is the load-bearing correction. |
| **S-SI-7** | CUSIP-to-symbol mapping: FINRA reports are keyed by CUSIP. Internal symbol space is ticker-based. Mapping via SEC EDGAR submissions API on first encounter (pre-authorized per CLAUDE.md), cached in CH `cusip_ticker_map` table. Ticker changes (mergers, ticker swaps) are reconciled by following the SEC's `formerNames` list. | FINRA does not publish ticker mappings directly; SEC EDGAR is the canon-load-bearing source for the CUSIP↔company↔ticker chain. The cache avoids repeated lookups; the `formerNames` follow handles corporate actions. |
| **S-SI-8** | Per-stock universe: equity-midcap universe (~60 tickers, matches existing daemon watch list). Aggregate universe: SPY 500 constituents. | Per-stock signal is narrowly applied; aggregate is broad. Different universes for different scopes is correct — the per-stock signal needs to be tracked on the tickers we actually trade, the aggregate signal needs broad coverage to be representative. |
| **S-SI-9** | Brief section = **#11**, appended last to preserve byte-equal-stdout protection on sections #1-#10 (cycle-position #7, vol-structure #8, sector-rotation #9, cross-asset #10). | Established pattern across all four prior Layer-0 informational composites. Section-add-at-tail is the byte-equal-protection invariant. |
| **S-SI-10** | Z-score baseline: 2y trailing per-ticker (per-stock) + 2y trailing aggregate (aggregate). Minimum baseline = 30 prints (matches `MIN_Z_BASELINE` constant in cross-asset / sector-rotation repos). | 2y matches Diether-Lee-Werner 2009 §4 baseline. The 30-print floor protects against early-life z-scores on newly-listed tickers or freshly-ingested-history scenarios. |
| **S-SI-11** | `sentiment_short_extreme` fires at aggregate z-score \|z\| > 2.0 (either direction). | Symmetric threshold. The flag is a "regime is unusual on the short-interest axis" signal; high (\|z\| > 2) is mildly contrarian-bullish, low (z < -2) means short interest has collapsed (potentially bearish via short-squeeze unwind). The interpretation is downstream-consumer's responsibility; the flag is unsigned. |
| **S-SI-12** | Snapshot cadence: daemon-daily even though FINRA is biweekly. The composite re-reads the latest FINRA-data-as-of-snapshot-date on every daemon run; on days between FINRA publication dates, the per-ticker SIR is the most recent published value and the ROC is unchanged from the prior snapshot. | Matches the daemon's daily snapshot pattern for all other Layer-0 composites. The "stale-on-non-publication-day" behavior is honest (the snapshot reflects best-available data as-of that day) and the brief shows `lastFinraPublication: 2026-05-15` so the operator can see staleness directly. |
| **S-SI-13** | Snapshot version stamp: `short_interest_v1`. Bumps on any threshold / aggregator / universe-definition change per the Layer-0 convention. | Established pattern. Bump triggers: ROC window (3m → 6m), threshold (\|z\| > 2 → \|z\| > 2.5), universe (SPY 500 → Russell 3000), basket definition (SPY constituents → equal-weighted). |

---

## §3 · Component diagram

```text
            ┌──────────────────────┐
            │ FINRA biweekly       │
            │ short-interest CSV   │     pre-authorized
            │ (settlement-dated)   │     per CLAUDE.md data-source policy
            └─────────┬────────────┘
                      │ 8-business-day publication lag
                      ▼
            ┌──────────────────────┐
            │ scripts/             │   A1 — ingest unit
            │   finra_short_       │   - parse CSV
            │   interest_ingest.py │   - reconcile CUSIP→ticker via SEC EDGAR
                      ▼             │   - split-adjust historical SIR
            ┌──────────────────────┐
            │ quantlab.            │
            │   short_interest     │   - per-ticker biweekly SIR rows
            │   (per-ticker)       │   - ReplacingMergeTree(version) keyed on
            │                      │     (cusip, settlement_date)
            └─────────┬────────────┘
                      │ daemon read
                      ▼
            ┌──────────────────────┐
            │ src/server/          │   A2 — pure composite
            │   short_interest.ts  │   - per-ticker SIR / ROC / D2C
            │                      │   - aggregate SIR + z-score over SPY 500
            │                      │   - flag derivation per S-SI-3 / S-SI-11
            └─────────┬────────────┘
                      ▼
            ┌──────────────────────┐
            │ quantlab.            │   A3 — snapshot table
            │   short_interest_    │   - one snapshot row per daemon run
            │   snapshots          │   - ReplacingMergeTree(version)
            │                      │     keyed on (snapshot_date)
            └─────────┬────────────┘
                      │ daemon write + brief read
                      ▼
            ┌──────────────────────┐
            │ scripts/             │   A4 — daemon hook
            │   daily_signal_      │   step 1h — between cross-asset (1g)
            │   daemon.ts          │   and the cells/bundles section (§2)
            └─────────┬────────────┘
                      ▼
            ┌──────────────────────┐
            │ src/server/          │   A5 — brief panel
            │   operator_brief*    │   section #11
            │   .ts                │
            └──────────────────────┘
```

---

## §4 · Inputs (per S-SI-1 / S-SI-7)

| Source | Field | CH destination | Notes |
|--------|-------|----------------|-------|
| FINRA biweekly CSV | CUSIP | `short_interest.cusip` | Lookup key. |
| FINRA biweekly CSV | settlement date | `short_interest.settlement_date` | The data point's authoritative date. |
| FINRA biweekly CSV | publication date | `short_interest.published_at` | Computed: settlement + 8 business days (FINRA's typical lag). Used by the daemon to enforce settlement-date-aware lag (S-SI-5). |
| FINRA biweekly CSV | shares short | `short_interest.shares_short` | Pre-split-adjustment. |
| FINRA biweekly CSV | shares outstanding | `short_interest.shares_outstanding` | Pre-split-adjustment. |
| FINRA biweekly CSV | average daily volume | `short_interest.adv_20d` | Used for days-to-cover. |
| SEC EDGAR submissions API | CUSIP → ticker | `cusip_ticker_map.ticker` | Lazy-cached on first encounter; followed via `formerNames` for ticker swaps. |
| `quantlab.sp500_constituents` (PIT) | constituent panel as-of snapshot date | Aggregate basket | Constituent list at the SNAPSHOT date, NOT today's. |
| `quantlab.candles` | 20-day volume per ticker | days-to-cover numerator | Already in ingest path. |
| `quantlab.corporate_actions` (NEW small table) OR yfinance `actions` endpoint | split factor history | SIR split-adjustment (S-SI-6) | Decision deferred to A1 — CH-table is faster + offline-safe; yfinance is simpler but adds a live dependency. |

---

## §5 · Composite formulas

### §5.1 Per-stock (per S-SI-3)

For each ticker T in the equity-midcap universe, as of snapshot date D:

```text
let report_t      = latest_finra_report(T, asOf = D - 8bd)         # S-SI-5 lag
let report_t6     = finra_report(T, settlementDate = report_t.settlementDate - 6 reports)
                    # ~3 months back (6 biweekly cycles)
let split_factor  = product_of_splits_between(report_t6, report_t)
let SIR_t         = report_t.shares_short / report_t.shares_outstanding
let SIR_t6_adj    = (report_t6.shares_short * split_factor) /
                    (report_t6.shares_outstanding * split_factor)
                  = report_t6.shares_short / report_t6.shares_outstanding
                    # (split cancels — the ratio is split-invariant)
let SIR_roc       = (SIR_t / SIR_t6_adj) - 1.0
let d2c_t         = report_t.shares_short / candles.20d_avg_vol(T, D)

# Flag definitions:
let short_ramp           = (SIR_roc > 0.50) AND (d2c_t > 5.0)
let prior_high_base      = (SIR_t6_adj > median(SIR(T, trailing 2y))
                                       + stddev(SIR(T, trailing 2y)))
let short_capitulation   = (SIR_roc < -0.40) AND prior_high_base
```

**Note on split-invariance:** The SIR ratio is mathematically split-invariant — both shares-short and shares-outstanding scale identically. The S-SI-6 split-adjustment matters only for the ROC denominator IF the FINRA report's `shares_short` field is reported in pre-split units while `shares_outstanding` is in post-split units (or vice-versa). In practice FINRA reports both as-of-settlement-date and they scale together, but we adjust defensively to protect against vendor data quirks.

### §5.2 Aggregate (per S-SI-4, S-SI-10, S-SI-11)

For SPY-constituents-PIT-as-of D:

```text
let universe       = sp500_constituents(asOf = D)
let SIR_panel      = [per-ticker SIR_t for ticker in universe]
let aggregate_SIR  = market_cap_weighted_mean(SIR_panel)
                     # weights from SPY index methodology;
                     # fallback equal-weight when cap data unavailable
let aggregate_baseline_2y = trailing(aggregate_SIR, 2y * 26 biweekly reports = 52 prints)
                            # 2y of biweekly reports
let z              = (aggregate_SIR - mean(aggregate_baseline_2y))
                     / stddev(aggregate_baseline_2y)

# Flag:
let sentiment_short_extreme = abs(z) > 2.0
```

When the baseline has fewer than `MIN_Z_BASELINE = 30` valid prints, `z = null` and `sentiment_short_extreme = false` (do NOT fire on under-sampled baseline). Matches the cross-asset / sector-rotation pattern.

### §5.3 Snapshot payload

```typescript
interface ShortInterestSnapshot {
  snapshot_date: Date;                                // YYYY-MM-DD
  last_finra_publication: Date | null;                // staleness indicator
  bd_since_last_publication: number | null;           // 0-13 typical; 14+ means missed cycle

  aggregate_sir: number | null;                       // weighted SIR across SPY 500
  aggregate_z: number | null;                         // 2y baseline z-score
  aggregate_baseline_size: number;                    // # of prints in baseline
  sentiment_short_extreme: boolean;                   // |z| > 2.0

  // Per-ticker (equity-midcap universe):
  per_ticker_rows: Array<{
    ticker: string;
    cusip: string;
    sir_t: number;                                    // current period SIR
    sir_t6: number | null;                            // 6-report-prior SIR (may be null on new listings)
    sir_roc: number | null;                           // ROC over the 6 reports
    d2c_t: number | null;                             // days-to-cover
    short_ramp: boolean;
    short_capitulation: boolean;
  }>;

  // Diagnostic:
  inputs_available: { aggregate: number, per_ticker: number };
                                                      // count of valid inputs per panel
  version: 'short_interest_v1';
}
```

---

## §6 · CH snapshot table (Phase A3 migration)

```sql
CREATE TABLE quantlab.short_interest_snapshots (
  snapshot_date          Date,
  last_finra_publication Nullable(Date),
  bd_since_publication   Nullable(Int32),

  aggregate_sir          Nullable(Float64),
  aggregate_z            Nullable(Float64),
  aggregate_baseline_size UInt32,
  sentiment_short_extreme UInt8,                      -- 0/1

  per_ticker_json        String,                     -- JSON-encoded per-ticker rows
                                                     -- (variable-length; SPY-500
                                                     -- + watch universe = ~560 rows;
                                                     -- ~80KB JSON typical)
  inputs_available_aggregate  UInt32,
  inputs_available_per_ticker UInt32,

  version                LowCardinality(String) DEFAULT 'short_interest_v1',
  ingested_at            DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, version)
SETTINGS index_granularity = 1024;
```

Per-ticker rows are stored as JSON in a single column rather than exploding into a row-per-ticker child table. Rationale: the daemon writes ~560 per-ticker rows per snapshot; storing them as a row-per-ticker would inflate table cardinality unnecessarily for what is fundamentally a single-snapshot read pattern. The brief renders the top-N flagged rows; deep per-ticker historical analysis is a separate query against the source `quantlab.short_interest` table.

---

## §7 · Daemon hook position

Step **1h. Short-interest evaluation** — between cross-asset (step 1g, s88) and the cells/bundles resolution (§2). Same posture as cycle-position / vol-structure / sector-rotation / cross-asset: absent-table-safe, non-fatal, gated by `NO_MACRO || DRY_RUN`. The hook reads the latest `short_interest` rows-as-of-D, computes the composite, writes one row to `short_interest_snapshots`.

---

## §8 · Brief panel (section #11)

```text
─────────────────────────────────────────────────────────────────────────
 §11 — SHORT-INTEREST (as of 2026-05-19)
─────────────────────────────────────────────────────────────────────────
  Aggregate (SPY 500):       sir=4.21% | z=+1.4σ (2y baseline n=52)
                             sentiment_short_extreme: NO

  Last FINRA publication:    2026-05-14 (5 business days ago)

  Flagged tickers (universe filtered to equity-midcap):

    short_ramp (5):          ABCD (+72% ROC, d2c=8.3)
                             XYZW (+58% ROC, d2c=6.1)
                             ...

    short_capitulation (1):  PQRS (-43% ROC from 22% base)

  Universe coverage:         59/60 mid-cap tickers have current data
                             (1 missing: TICK — CUSIP map TBD)
```

The flagged-tickers section truncates at the top-N most extreme on each side (N=5 default per panel). Operators can read the full list via the dashboard panel (out-of-scope for v1) or by querying `short_interest_snapshots` directly.

---

## §9 · Test plan

### §9.1 Pure-function (`scripts/tests/shortInterest.test.ts`)

- T-SI-1 — SIR computation under split-invariance (pre + post split data → same SIR).
- T-SI-2 — ROC over exactly 6 biweekly reports (synthetic fixture).
- T-SI-3 — ROC under split adjustment (synthetic 2:1 split mid-window).
- T-SI-4 — `short_ramp` flag fires on ROC > 50 AND d2c > 5; does NOT fire on ROC > 50 AND d2c = 4.
- T-SI-5 — `short_capitulation` requires high base AND ROC < -40; does NOT fire on low-base capitulation.
- T-SI-6 — Aggregate z-score with 52-print baseline.
- T-SI-7 — Aggregate z-score returns null when baseline < 30 prints.
- T-SI-8 — `sentiment_short_extreme` fires symmetrically on |z| > 2.
- T-SI-9 — Settlement-date-aware lag rejects reports published-after-snapshot.
- T-SI-10 — Null per-ticker rows (missing CUSIP map) propagate as null SIR, not as zero.

### §9.2 Repository (`scripts/tests/shortInterestRepository.test.ts`)

- T-SIR-1..N — `writeSnapshot` round-trip with FakeClickHouse.
- T-SIR-Nplus — `readLatest` returns the most-recent snapshot per `(snapshot_date, version)`.
- T-SIR-Nplus2 — `shortInterestSnapshotsTableExists` returns true/false correctly.
- T-SIR-Nplus3 — Daemon-orchestration `runDaemonShortInterestEvaluation` end-to-end.
- T-SIR-Nplus4 — EXPLAIN PLAN regression covers (post-migration activation).

### §9.3 Migration (`scripts/tests/migrateCreateShortInterestSnapshots.test.ts`)

- T-SIM-1 — Dry-run mode reports planned DDL without executing.
- T-SIM-2 — Apply mode creates the table; re-apply is no-op.
- T-SIM-3 — DDL matches §6 schema exactly (field-by-field assertion).

### §9.4 Ingest (`scripts/tests/finraShortInterestIngest.test.ts`)

- T-SII-1 — CSV parse against fixture (real FINRA file format).
- T-SII-2 — CUSIP→ticker resolution via mocked SEC EDGAR response.
- T-SII-3 — Split adjustment on a known split (synthetic).
- T-SII-4 — Idempotent re-ingest under ReplacingMergeTree.
- T-SII-5 — Publication-date computation (settlement + 8 business days).

### §9.5 Brief (`scripts/tests/operatorBriefRender.test.ts` — extension)

- T-OBR-SI-1 — Section #11 renders at byte-equal protection (appended after section #10).
- T-OBR-SI-2 — Top-N flagged tickers truncation at N=5.
- T-OBR-SI-3 — `sentiment_short_extreme: YES` rendering on a fixture with |z| > 2.
- T-OBR-SI-4 — Staleness indicator renders correctly on `bd_since_publication > 14`.

---

## §10 · Implementation phases

| Phase | Deliverable | Estimated effort |
|-------|-------------|------------------|
| **A1** | `scripts/finra_short_interest_ingest.py` (Python). FINRA biweekly CSV parse + CUSIP→ticker resolve + split-adjustment + write to `quantlab.short_interest` table. Migration script for the source table. Tests under `scripts/tests/` (Python). | ~3 days |
| **A2** | `src/server/short_interest.ts` (pure functions per §5). Tests under `scripts/tests/shortInterest.test.ts`. | ~1 day |
| **A3** | `scripts/migrate_create_short_interest_snapshots.ts`. Migration test. Migration applied (dry-run + apply). | ~0.5 day |
| **A4** | `src/server/short_interest_repository.ts` (read/write/exists/daemon-orchestration). `scripts/daily_signal_daemon.ts` step 1h hook. Tests. | ~1.5 days |
| **A5** | `src/server/operator_brief.ts` + `operator_brief_render.ts` section #11. Tests on byte-equal protection + flagged-tickers rendering. | ~1 day |

Total: **~7 working days** (matches gap-doc's 1-2 week estimate; closer to 1 week of focused Opus execution).

Each sub-phase commits as its own commit. SPEC (this doc) lands as the first commit.

---

## §11 · Open questions (deferred to Accept / implementation)

1. **Corporate-actions data source.** §4 / S-SI-6 split-adjustment: CH `corporate_actions` table OR yfinance live `actions` endpoint? Recommendation: yfinance for v1 (zero-infra), cache locally per ingest run. Migrate to a CH-managed table if yfinance reliability becomes an issue.

2. **Per-ticker baseline window for `prior_high_base` qualifier on `short_capitulation`.** SPEC §5.1 uses "trailing 2y per-ticker SIR median + 1σ." Alternatives: 1y (more responsive), all-time (more stable). 2y matches the aggregate baseline and Diether-Lee-Werner §4.

3. **Aggregate weighting scheme.** SPEC §5.2 uses market-cap-weighted across SPY-PIT constituents. Equal-weight is a simpler fallback when cap data unavailable. Open question: should equal-weight be the primary aggregation (matches the academic literature, which is typically un-weighted) and cap-weight be the fallback? Decision deferred to A2.

4. **Per-stock snapshot retention policy.** Daemon writes a snapshot per day; the per-ticker JSON payload is ~80KB. At 252 trading days/year that's ~20MB/year of cumulative snapshot growth. Trade-off: keep all snapshots indefinitely (current default per all other Layer-0 composites) vs prune old snapshots after a retention window. Recommendation: match the other Layer-0 composites (no pruning in v1; revisit at Phase B if storage becomes an issue).

5. **CUSIP-to-ticker for tickers that left the SPY 500 mid-history.** The PIT constituent panel handles this for the aggregate, but the per-ticker mapping for delisted tickers may need a fallback (CUSIP→legacy-ticker mapping cached forever). Decision deferred to A1 implementation.

6. **Days-to-cover when 20d volume is zero or very low.** Edge case: thinly traded ticker with `adv_20d = 0` → division by zero. Recommendation: clamp to a floor (e.g., d2c capped at 999 or returned as null) — clamping is preferable to null because the flag check uses `d2c > 5` which evaluates false on null anyway; clamping at 999 surfaces the extreme value in the brief for operator visibility.

---

## §12 · References

- **Boehmer, Jones, Zhang 2008** — "Which Shorts Are Informed?" *Journal of Finance* 63(2), 491-527. Level evidence: heavily-shorted stocks underperform.
- **Diether, Lee, Werner 2009** — "Short-Sale Strategies and Return Predictability." *Review of Financial Studies* 22(2), 575-607. **ROC evidence: it is the change that matters, not the level.** Load-bearing for S-SI-3.
- **Asquith, Pathak, Ritter 2005** — "Short Interest, Institutional Ownership, and Stock Returns." *Journal of Financial Economics* 78(2), 243-276. Small-cap noise floor (S-SI-4).
- **FINRA short-interest data:** https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data — free, official, biweekly.
- **SEC EDGAR submissions API:** https://data.sec.gov/submissions/ — CUSIP→company→ticker chain via `formerNames`.
- Companion gap doc: [`docs/obsidian/gaps/short-interest-tracking.md`](../obsidian/gaps/short-interest-tracking.md).
- Companion gap (next in queue per operator): [`docs/obsidian/gaps/executive-departure-signal.md`](../obsidian/gaps/executive-departure-signal.md) (#8), [`docs/obsidian/gaps/etf-flow-monitoring.md`](../obsidian/gaps/etf-flow-monitoring.md) (#9).
- ADR-041 (Proposed) — cycle-position v2; cited as the canon for "informational-only v1; Phase B validation gates promotion."
