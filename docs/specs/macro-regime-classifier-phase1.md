# SPEC — Macro regime classifier, Component 1 / Phase 1

> **Source doc:** [`regime_reference.html`](../../regime_reference.html) (project root).
> **Status:** PROPOSED · revised post-critic 2026-05-09 · awaiting user sign-off before CODE.
> **Date:** 2026-05-09 (initial draft + critic-revision pass).
> **Authoring role:** [SPEC] per Vector Core build-stage discipline.
> **Critic verdict:** CONDITIONAL PASS on initial draft; blockers (items 1, 2, 3, 7) resolved in this revision; non-blocking items (4, 5, 6, 8, 9, 10) also addressed.
> **Scope discipline:** Phase 1 only. Three indicators in three categories.
> Section 12 of the source doc rules out building all eight categories at
> once. Section 12 also names this exact phasing.

## 0. Why this SPEC and what it is not

### Purpose

Define the contract for an end-to-end macro regime classifier that classifies
each US trading day into one of `{green, yellow, orange, red}` based on three
indicators across three categories (volatility, credit, breadth). The contract
is what's needed before any code is written; CODE follows after sign-off.

### Phase 1 produces the canonical "strongest historical setup" signal

The source doc Section 10 closing callout names the strongest historical
setup for "meaningful equity drawdown is coming" as the conjunction of:
(1) VIX/VIX3M > 1.0, (2) HYG/SPY divergence, (3) breadth below 50%. Those
are the three indicators in this Phase 1. **Phase 1 is therefore the
narrowest configuration that can produce the source doc's strongest red
signal end-to-end** — not a stripped-down toy version.

### Out of scope (explicit)

The following are deliberately excluded from Phase 1 to honor the
"fewer features done robustly" discipline (project CLAUDE.md):

- Categories 4-7 of the source doc (rates, monetary policy, sector flows,
  sentiment) — all deferred to Phase 2/3/4 of the source doc's Section 12.
- Position monitor (Component 2 in user's request) — deferred pending
  decision on the SignalForge-research vs portfolio-manager line drawn in
  [`docs/teach/2026-05-07-research-project-vs-portfolio-manager.md`](../teach/2026-05-07-research-project-vs-portfolio-manager.md).
- Regime dashboard UI (Component 3) — deferred to a separate SPEC after
  Phase 1 lands and produces stable data.
- Daily AI briefing cron (Component 4) — deferred to a separate SPEC.
- `bt_runs.macro_regime` join column + helper functions (Component 5) —
  deferred to a parallel SPEC. Phase 1 is read-only-from-bt_runs's POV.
- Real-time / intraday classification — Phase 1 is end-of-day only.
- Auto-trading / kill-switch wiring into the daemon — Phase 1 produces
  data, not actions.

### Authority

User request 2026-05-09 asked for SPEC-first-then-sign-off. Vector Core
build-stage discipline (RESEARCH → DESIGN → SPEC → CODE) requires the
written contract before any implementation. This document is that contract.
ADR-034 records the deviation from the Track A/B path that this introduces.

---

## 1. Inputs — data sources

### 1.1 Volatility — VIX and VIX3M

- **Series:** `^VIX` (CBOE 30-day implied vol on SPX), `^VIX3M` (3-month
  equivalent). Both Yahoo-resolvable.
- **Fetcher:** existing `yfinance` Python infra mirrored from
  [`scripts/yfinance_backfill.py`](../../scripts/yfinance_backfill.py). Use
  `auto_adjust=True` (no-op for indices but defensive). Daily 1d candles.
- **Storage:** `quantlab.candles`, synthetic `token_address` per existing
  convention (`VIX_USD`, `VIX3M_USD`), `source='yfinance_regime'` (already
  registered with priority 51 in `SOURCE_PRIORITY_SQL`). Field mapping
  identical to `yfinance_backfill.py`. Token metadata seeded once.
- **History available:** `^VIX` from 1990-01-02; `^VIX3M` from 2007-12-04.
  Backfill ceiling for VIX3M = 2007-12-04 → today, ≈18 years. SPY-only or
  VIX-only days before VIX3M existed are excluded from classification.
- **Failure mode:** Yahoo returns empty / partial — same handling as
  `yfinance_backfill.fetch_ticker` (per-ticker try/except, log + continue).

### 1.2 Credit — HYG and SPY

- **Series:** `HYG` (iShares iBoxx High Yield Corporate Bond ETF), `SPY`
  (S&P 500 SPDR). Yahoo-resolvable.
- **Fetcher:** same yfinance pipeline.
- **Storage:** `quantlab.candles` with synthetic addresses `HYG_USD`,
  `SPY_USD`. **`SPY_USD` already exists** under `source='yfinance_regime'`
  per [`scripts/_backfill_spy_regime.py`](../../scripts/_backfill_spy_regime.py).
  Phase 1 reuses it; `HYG_USD` is new, also under `yfinance_regime`.
- **History available:** `HYG` from 2007-04-11. Backfill ceiling = 2007-04-11.
- **Failure mode:** same as 1.1.

### 1.3 Breadth — % of S&P 500 above 50-day moving average

**This indicator's data source is the only Phase 1 sourcing decision that
needs explicit user sign-off.** The source doc lists "Various"; the practical
options each have trade-offs.

| Option | Source | Pros | Cons |
|--------|--------|------|------|
| **A** (recommend) | Stooq `%a50r` (S&P 500 % above 50DMA) historical CSV | Native breadth series, no compute, ~17y history (2007+) | Stooq URL stability, single-source dependency |
| **B** | Compute from current S&P 500 constituents × yfinance daily closes | Self-contained, no external dep beyond yfinance | **Severely survivorship-biased going backward** — 2008 GFC computed against 2026 constituents omits Lehman, Bear Stearns, WaMu, Wachovia, AIG-pre-bailout — exactly the names whose <50DMA collapse defined the regime. Computed breadth for 2008-09 will overstate % above 50DMA materially. **Forbidden for fixture-derived threshold tuning.** |
| **C** | NYSE breadth proxy (`^NYAD` advance-decline cumulative) | Long history, Yahoo-resolvable | Different denominator (NYSE vs S&P 500), behavior diverges from the source doc's threshold |

**Recommendation:** Option A primary, Option B as fallback only when Stooq
is unreachable, with a stored `source` column on `quantlab.macro_breadth` so
mixed-source rows are detectable in queries. Option B's survivorship bias is
acceptable for *current* regime detection (today's S&P 500 IS the universe
that matters); it's only contaminating for *historical* threshold calibration,
which Phase 1 does. Option C is not a substitute — it measures something
different.

**OPEN QUESTION (sign-off blocker):** confirm Option A. If user prefers B,
the test fixtures section needs different historical regime thresholds
(survivorship inflates breadth in past stress periods).

- **Storage:** new table `quantlab.macro_breadth` (DDL in §3). Daily one
  row per (date, source). Idempotent re-ingest via `ReplacingMergeTree`.
- **Failure mode:** Stooq unreachable → fall back to Option B with a logged
  warning + `source='computed_constituents'` on the row. If both fail:
  classification for that day records `pct_above_50dma = NULL`, and the
  breadth signal is `NULL`/non-firing for that day (NOT silently zero).

---

## 2. Indicator definitions and threshold logic

All three indicators are computed from end-of-day closes. All thresholds
come directly from the source doc Sections 2-4 and Section 16's quick
reference card.

### 2.1 Volatility — VIX term inversion

```
vix_term_ratio(t)    = vix_close(t) / vix3m_close(t)
vix_term_inverted(t) = vix_term_ratio(t) > 1.0
```

- **Lookback:** none (point-in-time).
- **Edge case:** if either close is NULL/missing for date `t`,
  `vix_term_inverted(t) = NULL` and the volatility category does not fire.
- **Source:** Section 2 (VIX term structure), Section 16 row 1.

### 2.2 Credit — HYG/SPY divergence

The source doc is internally inconsistent on the lookback window: Section
3 body text says **"the clean trigger: HYG 20-day return turning negative
while SPY 20-day return is still positive"** (paired with the "1-4 week
lead time" claim); Section 16 quick-reference row 4 says **"HYG 10d
negative while SPY+"**. Rather than pick one and risk silent threshold
drift in either direction, Phase 1 **computes both and stores both**, with
the 20-day pairing as the canonical fire condition and the 10-day pairing
as audit data.

```
ret_n(series, t, n)  = (close(t) / close(t - n trading days)) - 1
hyg_20d(t)           = ret_n(HYG, t, 20)
spy_20d(t)           = ret_n(SPY, t, 20)
hyg_10d(t)           = ret_n(HYG, t, 10)
spy_10d(t)           = ret_n(SPY, t, 10)
hyg_spy_divergence_20d(t) = (hyg_20d(t) < 0) AND (spy_20d(t) > 0)
hyg_spy_divergence_10d(t) = (hyg_10d(t) < 0) AND (spy_10d(t) > 0)
hyg_spy_divergence(t)     = hyg_spy_divergence_20d(t)   # canonical for Phase 1
```

- **Lookback:** 20 trading days canonical, 10 trading days audit. Both
  stored.
- **Why 20d canonical:** Section 3 body text is the most explicit
  statement in the source doc and it pairs the 20-day window with the
  "clean trigger" + "1-4 week lead time" language. Section 16's "10d"
  row appears to be a cell-formatting compaction, not a contradicting
  threshold. If empirical fixtures show 20d trails the historical
  regime transition meaningfully, Phase 2 SPEC reopens this.
- **Edge case:** any required close missing → corresponding
  `hyg_spy_divergence_*` is 0 (non-firing) AND the row's `inputs_missing`
  bitmask flags it (see §3.2). The composite uses the canonical 20d.
- **Source:** Section 3 (HYG/SPY divergence body), Section 16 row 4.

### 2.3 Breadth — narrow rally at index highs

```
spy_252d_high(t)       = max(SPY close over t-251..t)        # inclusive both ends
spy_at_or_near_high(t) = SPY_close(t) >= 0.95 * spy_252d_high(t)
breadth_narrow(t)      = (pct_above_50dma(t) < 50) AND spy_at_or_near_high(t)
```

**The 95%-of-1Y-high gate is a Phase 1 design choice, not a translation
from the source doc.** Section 4 says "at all-time highs"; Section 16
row 6 says "<50% at index highs." The doc does not specify a numerical
"at or near highs" threshold. Phase 1 hard-codes 95%/252d. Alternatives
considered:

| Alt | Spec | Reason rejected |
| --- | --- | --------------- |
| 100% / 252d (true new high) | `close(t) == max over t-251..t` | Too strict — never fires unless an actual new 1Y high prints, missing the "near highs" semantics in Section 4 |
| 95% / 60d | shorter lookback | Triggers "at highs" too easily in choppy ranges; doesn't capture the "extended rally" sense |
| 90% / 252d | wider band | Triggers in moderate drawdowns, defeating the purpose of gating |
| Distance-to-ATH-in-percent (Yahoo-derivable) | uses true ATH not 1Y high | Adds another data dependency for marginal gain; 1Y high is a reasonable proxy when the trend is up |

**95%/252d is locked for Phase 1.** Per Bergstra-Bengio (2012), every
silently-tuned hyperparameter expands the implicit search space.
**Changing 95%/252d post-hoc against a known-stress fixture is forbidden**
under the same multiple-testing discipline that governs ADR-004.
A Phase 2 SPEC may revisit if Phase 1 fixtures show systematic miscall.

- **Lookback:** 252 trading days (1 year) for the high reference,
  inclusive of both endpoints.
- **Edge case:** insufficient SPY history (<252 trading days) →
  `spy_at_or_near_high(t)` is 0 (non-firing) and `inputs_missing`
  flags the warmup state. Category does not fire during warmup.
- **Source:** Section 4 (% above 50DMA), Section 16 row 6.

### 2.4 Composite classifier — tier rules

Per source doc Section 10. With three indicators in three categories,
the rules are:

```
categories_firing_today(t) = sum of {vix_term_inverted(t),
                                     hyg_spy_divergence(t),
                                     breadth_narrow(t)}
                              treating NULL as 0 (non-firing)

categories_firing_5d(t)    = | union over t-4..t of fired-categories |

regime(t) =
  red    if categories_firing_5d(t) >= 3
  orange if categories_firing_today(t) >= 2
  yellow if categories_firing_today(t) == 1
  green  otherwise
```

- **Why union-over-5-days for red:** the source doc defines red as "3+
  indicators from different categories within a 5-day window." The window
  is rolling end-of-day. Once a category fires within the 5-day window, it
  contributes to the red count regardless of whether it's firing on day `t`
  itself. This matches "red is the regime that just demonstrated stress
  across all three categories within a week" rather than "red requires all
  three to fire on the same calendar day."
- **Categories vs indicators:** in Phase 1 every category contains exactly
  one indicator, so `categories_firing == signals_firing` for every Phase 1
  row. The two columns are kept distinct in the schema for Phase 2+ forward-
  compat: in Phase 2+ the source doc's "independent confirmation across
  categories" principle (Section 10) means multiple indicators within one
  category count as ONE category-firing for the composite. Don't simplify
  the schema by dropping one column — the next phase needs both.
- **Edge case at boundaries:** before there are 5 trading days of regime
  history (i.e., the first 4 days of the historical backfill), the 5-day
  union is computed over the trading days available so far, not padded.
  These early days cannot be `red` regardless of input — flagged in the
  test list.
- **Source:** Section 10 (tier structure + independent confirmation);
  Section 16 closing callout (composite tier rules).

---

## 3. ClickHouse schema

Two new tables, additive (no migration of existing tables in Phase 1).

### 3.1 `quantlab.macro_breadth`

```sql
CREATE TABLE IF NOT EXISTS quantlab.macro_breadth (
  trade_date       Date,
  source           LowCardinality(String),  -- 'stooq_a50r' | 'computed_constituents'
  pct_above_50dma  Float64,                 -- 0..100, NULL not allowed (use missing-row instead)
  ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (trade_date, source);
```

Idempotent re-ingest: same `(trade_date, source)` collapses to most recent
`ingested_at`. Multiple sources for the same date allowed (so we can compare
Stooq vs computed when both are available).

### 3.2 `quantlab.macro_regimes`

```sql
CREATE TABLE IF NOT EXISTS quantlab.macro_regimes (
  trade_date            Date,
  classifier_version    LowCardinality(String),  -- 'phase1_v1', evolves with classifier changes

  -- Raw inputs (kept for auditability)
  vix_close             Nullable(Float64),
  vix3m_close           Nullable(Float64),
  hyg_close             Nullable(Float64),
  spy_close             Nullable(Float64),
  pct_above_50dma       Nullable(Float64),
  pct_above_50dma_source LowCardinality(String) DEFAULT '',

  -- Derived metrics
  vix_term_ratio        Nullable(Float64),
  hyg_20d_return        Nullable(Float64),
  spy_20d_return        Nullable(Float64),
  hyg_10d_return        Nullable(Float64),  -- audit, not used in canonical fire
  spy_10d_return        Nullable(Float64),  -- audit, not used in canonical fire
  spy_252d_high         Nullable(Float64),

  -- Per-category fire flags (UInt8: 0 = no, 1 = yes; NULL inputs treated as 0)
  vix_term_inverted         UInt8,
  hyg_spy_divergence        UInt8,            -- canonical, 20-day
  hyg_spy_divergence_10d    UInt8,            -- audit
  breadth_narrow            UInt8,

  -- Auditability — bitmask of which inputs were missing or warming up.
  -- Bits: 1=vix_close, 2=vix3m_close, 4=hyg_close, 8=spy_close,
  --       16=pct_above_50dma, 32=spy_252d_warmup (<252 prior closes).
  -- Lets queries distinguish 'flag=0 because conditions did not hold' from
  -- 'flag=0 because input was missing/warmup' without re-fetching source data.
  inputs_missing        UInt8 DEFAULT 0,

  -- Composite outputs
  signals_firing        UInt8,                   -- count of fire flags today
  categories_firing     UInt8,                   -- == signals_firing in Phase 1
  categories_firing_5d  UInt8,                   -- union over t-4..t
  regime                LowCardinality(String),  -- 'green' | 'yellow' | 'orange' | 'red'

  ingested_at           DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (trade_date, classifier_version);
```

Why store all the intermediates (`vix_close`, `hyg_20d_return`, etc.) and not
just the final classification: auditability. When a future ADR challenges a
Phase 1 regime label, the stored intermediates let us re-derive the
classification deterministically from CH alone — no need to re-fetch
yfinance. This is the same discipline that paid off when the 2020 "losing
year" was reframed in ADR-033.

Why `classifier_version`: when Phase 2 adds indicators, the classifier
evolves, and we want both `phase1_v1` and `phase2_v1` rows to coexist in
the table for a transition period (so dashboards / backtests can pin to a
version). The sort key includes it for that reason.

### 3.3 Where the DDL lives

Both DDLs go into [`src/server/clickhouse.ts`](../../src/server/clickhouse.ts)
behind a new `ensureMacroRegimeTables()` exported function, called once at
server startup alongside `ensureBacktestTables()`. Same idempotent
`CREATE TABLE IF NOT EXISTS` pattern as the rest of the file.

---

## 4. End-to-end pipeline — components and signatures

### 4.1 Ingestion script — `scripts/macro_regime_ingest.py`

```python
def fetch_yfinance_series(ticker: str, start: date, end: date) -> pd.DataFrame
def fetch_stooq_breadth(start: date, end: date) -> pd.DataFrame  # returns trade_date, pct_above_50dma
def compute_breadth_from_constituents(start: date, end: date, ch) -> pd.DataFrame  # fallback
def insert_yfinance_regime_candles(client, ticker: str, df: pd.DataFrame) -> int
def insert_macro_breadth(client, df: pd.DataFrame, source: str) -> int
def main() -> int
```

Behaviour:

- CLI: `--start YYYY-MM-DD` (default = 2008-01-01), `--end YYYY-MM-DD`
  (default = today), `--dry-run`, `--breadth-only`, `--skip-breadth`.
- Default run = **15-year backfill** to capture 2008 GFC, 2011 EU, 2015
  China devaluation, 2018 Vol-mageddon, 2020 COVID, 2022 rate-shock — six
  stress regimes vs the 2-3 a 5-year window would catch. Per [PUSHBACK]
  flag in the conversation; user signed off as part of SPEC review.
- Per-ticker error isolation (one ticker's failure does not abort the run).
- All inserts via `clickhouse_connect.insert_df` with
  `max_partitions_per_insert_block=1000` (matches `yfinance_backfill.py`).
- Idempotent re-runs: `ReplacingMergeTree` collapses on `ingested_at`.

### 4.2 Classifier — `src/server/macro_regime.ts`

```typescript
export interface MacroRegimeRow {
  trade_date: string;                       // 'YYYY-MM-DD'
  classifier_version: string;
  vix_close: number | null;
  vix3m_close: number | null;
  hyg_close: number | null;
  spy_close: number | null;
  pct_above_50dma: number | null;
  pct_above_50dma_source: string;
  vix_term_ratio: number | null;
  hyg_20d_return: number | null;
  spy_20d_return: number | null;
  spy_252d_high: number | null;
  vix_term_inverted: 0 | 1;
  hyg_spy_divergence: 0 | 1;
  breadth_narrow: 0 | 1;
  signals_firing: number;
  categories_firing: number;
  categories_firing_5d: number;
  regime: 'green' | 'yellow' | 'orange' | 'red';
}

export const CLASSIFIER_VERSION = 'phase1_v1';

/**
 * Pure compute: given inputs for date t and t-20/t-251 history, return the
 * classification row. No I/O. Test entry point.
 */
export function classifyMacroRegime(input: ClassifierInput): MacroRegimeRow;

/**
 * Classify a date range end-to-end. Reads candles + macro_breadth from CH,
 * computes classifications, writes to macro_regimes. Idempotent.
 */
export async function backfillMacroRegimes(args: {
  startDate: string;             // YYYY-MM-DD
  endDate: string;
  classifierVersion?: string;    // default CLASSIFIER_VERSION
  dryRun?: boolean;
}): Promise<{ rowsWritten: number; firstDate: string; lastDate: string }>;

/**
 * Classify just the latest date. Called once per day after data ingestion.
 * Returns null if the data needed is not yet available.
 */
export async function classifyLatestMacroRegime(): Promise<MacroRegimeRow | null>;

/**
 * Read interface for downstream consumers (dashboard, briefing, bt_runs join).
 */
export async function fetchMacroRegime(asOfDate: string): Promise<MacroRegimeRow | null>;
export async function fetchMacroRegimeRange(
  startDate: string,
  endDate: string,
  classifierVersion?: string
): Promise<MacroRegimeRow[]>;
```

The split between `classifyMacroRegime` (pure) and `backfillMacroRegimes`
(I/O wrapper) is the contract that makes testing tractable: every threshold
edge case is a `classifyMacroRegime` unit test with hand-built input;
`backfillMacroRegimes` is tested at the integration level against a fixture
CH database.

### 4.3 Daily-run wrapper — `scripts/macro_regime_classify_today.ts`

Thin shell that:
1. Calls `npm run macro:ingest` (today's bar only) under the hood, OR
   assumes upstream ingestion already ran.
2. Calls `classifyLatestMacroRegime()`.
3. Logs the classification, exits.

No Telegram, no email, no UI. Phase 1 is data-only. Briefings come in
Component 4.

### 4.4 Wiring

- `server.ts`: call `ensureMacroRegimeTables()` at startup alongside
  `ensureBacktestTables()`. No new HTTP routes in Phase 1.
- `package.json`: add three scripts:
  - `"macro:ingest": "python scripts/macro_regime_ingest.py"` (with the
    Windows venv path resolution the project already uses).
  - `"macro:classify:today": "tsx scripts/macro_regime_classify_today.ts"`
  - `"macro:backfill": "tsx scripts/macro_regime_backfill.ts --start 2008-01-01"`

---

## 5. Tests — the contract that gates sign-off-to-CODE

Three layers. All must pass before Phase 1 is considered shipped.

### 5.1 Unit tests on `classifyMacroRegime` — `scripts/tests/macroRegime.test.ts`

Per-indicator threshold tests:

1. `vix_term_inverted` — true when `vix/vix3m > 1.0`, false at 1.0
   exactly, false when either input null, true on synthetic 1.001.
2. `hyg_spy_divergence` — true on `hyg_20d=-0.01, spy_20d=+0.01`; false
   when both negative; false when both positive; null/false when any
   input null; false at boundary (`hyg_20d=0` is not negative).
3. `breadth_narrow` — true on `pct=49, spy_at_high=true`; false on
   `pct=49, spy_at_high=false`; false on `pct=51, spy_at_high=true`;
   false at boundary `pct=50` exactly; null when pct null.

Composite tests:

4. Green = no signals.
5. Yellow = exactly one signal today.
6. Orange = two signals today.
7. Red same-day = three signals today (degenerate red).
8. **Red across 5 days** — three different categories firing on
   non-overlapping days within a 5-day window: t-4 vol, t-2 credit, t
   breadth → red on day t. (Critical test; the rolling-union logic is
   the most error-prone part.)
9. Boundary — same scenario as #8 but window is 6 days apart → orange
   (or yellow, depending on day t's same-day count).
10. Backfill warmup — first 4 days of history cannot be red even if
    every category fires every day.
11. NULL handling — vix_close=NULL, hyg/spy/breadth all firing →
    categories_firing == 2, regime = orange (not red).

Total target: ~15 unit tests.

### 5.2 Historical regime fixtures — `scripts/tests/fixtures/macro_regime_known_dates.test.ts`

Hand-curated dates with expected regime, derived by reading the source-doc
thresholds and checking the historical record. Each fixture is a synthetic
mini-CSV checked into `scripts/tests/fixtures/macro_regime/` containing the
input series, NOT a query against live CH. The test asserts that running
`backfillMacroRegimes` over that fixture produces the expected regime
sequence.

Fixtures to build:

- **2020 COVID crash** (2020-02-19 → 2020-04-30) — expect red within
  several days of 2020-02-24 (VIX inversion + breadth collapse +
  HYG-SPY divergence in the lead-up week). ~50 trading days.
- **2018 Q4 selloff** (2018-09-01 → 2018-12-31) — expect yellow→orange
  progression in October as VIX inverts and breadth narrows. ~85
  trading days.
- **2008 GFC peak** (2008-08-01 → 2009-03-31) — expect sustained red.
  Note: VIX3M data starts 2007-12-04, so the fixture spans available
  history. ~170 trading days.
- **Quiet 2014** (2014-04-01 → 2014-09-30) — expect majority green,
  occasional yellow. Negative-control fixture: classifier shouldn't
  cry wolf in calm regimes. ~125 trading days.
- **2011 EU debt crisis** (2011-07-01 → 2011-10-31) — expect orange/red
  in August. ~85 trading days.
- **Pure holdout: 2017 full year** (2017-01-03 → 2017-12-29) — used
  for **NO threshold tuning whatsoever**. After every other fixture
  passes, run this last and report what regime distribution comes out.
  Documented expectation only ("majority green, the historical record
  shows 2017 as the calmest year of the 2009-2024 stretch"); no failing
  the test if the distribution surprises. This is the closest thing to
  out-of-sample we get with 5 calibrated regimes plus 1 holdout.

If user picked breadth Option B (constituent-computed) over Option A,
fixtures are regenerated from constituent data and thresholds may shift
slightly; this is one of the reasons the breadth source choice is a
sign-off blocker.

### 5.3 Integration test — `scripts/tests/macroRegimeBackfill.test.ts`

Single end-to-end test: spin up an in-memory equivalent (or temp CH
schema), insert known synthetic candles + breadth rows, run
`backfillMacroRegimes(2014-01-01, 2014-06-30)`, assert the resulting
`macro_regimes` rows match expected counts and the no-cry-wolf property
(no red regime cells in this calm period).

### 5.4 What tests can and cannot establish

**Passing all fixtures is a necessary, not sufficient, condition for
Phase 1 sign-off.** Per Bailey-Borwein-LdP-Zhu (2014, PBO via CSCV) and
Harvey-Liu-Zhu (2016, multiple-testing haircuts), a regime classifier
with N indicators × M thresholds × P composite rules is a hypothesis-
search engine with a non-trivial implicit search space. Phase 1 has 3
indicators with locked thresholds, but Phase 2+ will expand both axes,
and the historical fixtures here will be reused — making them part of
the search space whether or not we want them to be.

**What the fixtures establish:** that the implementation reproduces the
intended classification on known-stress regimes the author already
believes are red, and on a known-calm regime the author already believes
is green. That is sanity-check, not validation.

**What the fixtures do NOT establish:**

- That the regime labels predict forward equity returns at any horizon.
- That the labels are useful for gating SignalForge strategies.
- That the 95%/252d, < 50% breadth, > 1.0 VIX-term thresholds are
  numerically optimal vs nearby alternatives — they are taken from the
  source doc, not optimized here.

**Statistical validity of regime labels** for downstream use (gating
strategies, regime-stratified bt_runs analysis) requires (a) regime-
stratified backtest analysis with strategy-level metrics tracked per
regime, and (b) PBO / DSR adjustment that counts the regime dimension
in the trial space when comparing strategies across regimes. **That is
Component 5 work, not Phase 1.** Phase 1 ships labels; validation of
the labels is downstream.

### 5.4 Self-check before sign-off-to-CODE

Producer self-check items (per `check.md` discipline):

- [ ] Source doc thresholds match the SPEC verbatim — no silent
      adjustments from the doc's stated values.
- [ ] Every NULL-input edge case has a unit test.
- [ ] Composite rule tests cover all four regimes + warmup boundary.
- [ ] Historical fixtures cover at least one stress regime, one calm
      regime, and the GFC pre-VIX3M boundary.
- [ ] No new test depends on live yfinance / Stooq fetches at runtime
      (deterministic fixtures only).
- [ ] DDL is `IF NOT EXISTS` and idempotent re-run does not raise.
- [ ] `pct_above_50dma` source choice (Option A vs B) is documented in
      a header comment of `macro_regime_ingest.py`.

---

## 6. Failure modes and watch-outs

- **Yahoo / Stooq go down** — Phase 1 daily classification logs a warning
  and skips, does not write a partial row. Backfill resumes on next run.
- **VIX3M data starts 2007-12-04** — backfill before that date returns
  rows with `vix_term_inverted = 0` regardless (NULL input → 0 fire);
  this is why the GFC fixture starts 2008-08-01 (VIX3M is available).
  Document this in the script header.
- **Stooq URL drift** — the `%a50r` URL is not under our control. Fallback
  to constituent-computed (Option B) on 404. If both fail twice in a row,
  log loud and exit non-zero so cron picks it up.
- **Survivorship bias in Option B** — a real watch-out if Stooq is down
  long-term. The fallback is acceptable for current-day classification
  but historical backfill quality drifts. ADR-035 (or whatever number)
  records the choice if Option B becomes the durable source.
- **Daylight savings / timezone** — all dates are US Eastern trading days.
  `trade_date` is the date Yahoo returns (which is the New York close
  date). Stooq returns ISO dates aligned with US sessions. No timezone
  arithmetic needed at the daily granularity.
- **Re-classification when historical data is corrected** — Yahoo
  occasionally restates historical data. Re-running `backfillMacroRegimes`
  on the affected range writes new rows with later `ingested_at`;
  `ReplacingMergeTree` collapses on `(trade_date, classifier_version)`.
  Downstream consumers using `FINAL` see the corrected version.
- **No look-ahead** — every threshold uses ONLY data with timestamp
  ≤ classification date `t`. Verified by unit tests that hand-build
  input arrays of length 21 (for 20-day return) and 252 (for 252-day
  high) with the date-`t` value as the last element.
- **Stale-data guard for daily classification** — `classifyLatestMacroRegime`
  must verify that the source candle for date `t` (specifically:
  vix_close, vix3m_close, hyg_close, spy_close all exist with
  `timestamp = t`) before classifying. If any source row is missing for
  date `t`, log a warning and skip — do NOT classify against partial /
  stale data. This protects against the daemon running at 4:05 PM ET
  before Yahoo's official close prints land. Backfill (which runs on
  full historical data) is exempt from this check.

---

## 7. Acceptance criteria for sign-off-to-CODE

User confirms:

1. **Breadth source = Option A (Stooq) primary, Option B (constituents)
   fallback** — or alternative explicitly chosen.
2. **15-year backfill window (start 2008-01-01)** — or alternative.
3. **Composite "red" definition = 3+ categories within rolling 5-day
   union** — or alternative interpretation of the source doc's "within
   a 5-day window" phrasing.
4. **Component 2 (position monitor / FTEC firm-level) is on hold** until
   the SignalForge-research vs portfolio-manager line is re-evaluated.
5. **Critic-agent review of this SPEC has been completed and its
   blocking items resolved.** Critic verdict on 2026-05-09 was
   CONDITIONAL PASS with items 1, 2, 3, 7 as blockers. All four are
   now resolved in this revision: HYG/SPY 10d-vs-20d ambiguity made
   explicit and both stored (item 1, §2.2); 95%/252d named as a Phase 1
   design choice with alternatives (item 2, §2.3); `inputs_missing`
   bitmask added to schema for NULL-vs-fail-vs-warmup distinction (item
   3, §3.2); schema committed to audit-grade with named consumers (item
   7). Non-blocking critic items (4 fixture coverage, 6 Option B
   strengthening, 8 acceptance-criteria sharpening, 9 multiple-testing
   acknowledgment, 10 categories vs signals) also addressed.

Once those five are confirmed, CODE proceeds in this order:

1. DDL + `ensureMacroRegimeTables` (smallest, safest first).
2. `scripts/macro_regime_ingest.py` (gets data into CH; verifiable by
   eyeballing CH).
3. Pure `classifyMacroRegime` + unit tests (~15 tests).
4. `backfillMacroRegimes` + integration test.
5. Historical fixture tests.
6. `classifyLatestMacroRegime` + daily wrapper script.
7. `npm run` script wiring.

Each step is a commit. Test suite green at every commit.

---

## 8. What this SPEC deliberately does not promise

- That the regime labels will be useful for FTEC protection. Validation
  is post-implementation; the SPEC ships data, not edge.
- That the thresholds are right for crypto strategies. The source doc
  is built around US equities; no claim made about Solana memecoins
  or BTC's relationship to these regimes.
- That Phase 1 alone is enough to make trading decisions. Per source
  doc Section 15, regime detection is calibration, not commands; and
  Phase 1 is three of seven categories. The independent-confirmation
  principle (Section 10) means a Phase 1 "red" signal is real but
  weaker than a Phase 4 "red" signal would be.
