# SPEC — Macro regime classifier phase1_v3

> **Status:** DRAFT — produced from the 2026-05-11 RESEARCH+PUSHBACK turn (session 38 turn 4) · **Author:** producer (Claude) · **Authority:** [ADR-037](../decisions/README.md), [HANDOFF](../../.claude/HANDOFF.md), session-38 turn-4 user direction to "skip Sharadar, use leading indicators"
>
> **Stage in Vector Core build:** SPEC. RESEARCH closed in the same turn. CODE follows over 2-3 turns (this turn = data layer; next turn = classifier rules + backfill; turn after = fixture verification + ramp).

phase1_v3 replaces the survivorship-biased breadth indicator with three free leading indicators that are immune to constituent-data bias. The new classifier needs zero paid data subscriptions — the cost path that was previously gated on Sharadar.

---

## 1. Motivation

The user's session-38 turn-4 insight was correct: 3 of 4 categories in phase1_v2 are pure macro market data (VIX, HYG/SPY, SPY drawdown) and only `breadth_narrow` depends on S&P 500 constituent membership. The breadth indicator is the source of the entire survivorship bias documented in ADR-037; dropping it removes the bias without requiring Sharadar.

But simply dropping breadth weakens the classifier by 25%. Better: replace it with stronger leading indicators that the canon (Estrella-Hardouvelis 1997 on yield curves, Gilchrist-Zakrajšek 2012 on credit spreads, Whaley 2009 on VIX as fear gauge) supports more cleanly than breadth.

---

## 2. Architectural decisions

### 2.1 Three new leading indicators + one risk-on/risk-off proxy

| New indicator | What it measures | Source | Lead/lag | Canon |
|---|---|---|---|---|
| **T10Y2Y** (10y-2y Treasury spread) | Yield curve inversion → recession lead | FRED API (free, public) | Lead 6-18 months | Estrella-Hardouvelis 1997, NY Fed |
| **BAMLH0A0HYM2** (ICE BofA HY OAS) | High-yield credit spread (stress in junk debt) | FRED API (free) | Coincident-to-leading | Gilchrist-Zakrajšek 2012 |
| **^CPC** (CBOE total put/call) | Options-market sentiment | CBOE direct CSV (primary) + VIX/VIX3M complacency (secondary) | Coincident contrarian | CBOE methodology + Whaley 2009 |
| **SPY/TLT ratio** (risk-on/risk-off) | Equity vs Treasury rotation | yfinance (already have SPY; add TLT) | Coincident-to-leading | Industry convention; proxy for ETF flow data |

Why these four:
- Yield curve and credit spreads are the two cleanest *leading* indicators in the academic literature
- Put/call adds a sentiment/positioning angle that none of the existing indicators capture
- SPY/TLT is a free proxy for the "real money rotating from risk to safety" signal the user described

**Put/call dual-source decision (session 39 turn 1)** — the user locked in BOTH sources rather than picking one:

- **CBOE direct CSV** is the primary path: `https://cdn.cboe.com/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv` (or the equivalent historical-data endpoint). This is the authoritative ^CPC series.
- **VIX/VIX3M term-structure complacency** is the secondary signal: when VIX/VIX3M ≤ 0.80 (recalibrated from 0.85 in session 40 to the empirical p05 of `vix_term_ratio` on the 2008-present corpus; see §2.3 footnote), front-end vol is being crushed relative to back-end vol — extreme complacency, the contrarian "calm before the storm" signal that mirrors low put/call. Already computable from existing `VIX_USD`/`VIX3M_USD` candles, zero new ingest.
- The two are **OR'd into a single `sentiment_extreme` category** (not two separate categories), so one robust positioning-extreme flag, with two independent sources of evidence. If the CBOE endpoint breaks or rate-limits, the VIX/VIX3M signal alone keeps the category alive.
- Why OR over AND: AND requires both signals to agree, which suppresses the signal during periods where one of the data sources is missing or stale (e.g., CBOE outages, pre-2008 ^CPC sparsity). OR is the fail-soft choice and matches how `sentiment_extreme` is meant to function — "anything telling us positioning is stretched."

### 2.2 Drop `breadth_narrow` from the classifier

`pct_above_50dma` continues to be COMPUTED (existing pipeline unchanged) and STORED in `macro_regimes` for backward compat and dashboard display. But it does NOT contribute to category counting in phase1_v3.

**Why not delete the breadth pipeline?** Backward compat for the dashboard (Component 3) and so phase1_v2 attributions in `bt_runs_regime` remain readable. Component 4 brief continues to surface the bias-note when reading phase1_v2 rows.

### 2.3 Seven categories (6 active + 1 dormant) — locked thresholds

phase1_v3 firing categories:

1. `vix_term_inverted` (unchanged from v2) — VIX/VIX3M > 1.0
2. `hyg_spy_divergence` (unchanged from v2) — HYG 20d return < 0 AND SPY 20d return > 0
3. `realized_stress` (unchanged from v2) — **dormant under null θ; contributes 0 under phase1_v3 just as under phase1_v2**. Threshold remains a Phase 2 commitment kept structurally separate.
4. `yield_curve_inverted` (NEW) — T10Y2Y < 0 for ≥3 **consecutive trading days** (persistence guard against intraday spikes; matches NY Fed monthly-average convention)
5. `credit_stress` (NEW) — 20-trading-day return of `HYG_close / LQD_close` ratio < **−3%** (absolute threshold; conservative initial pick)
6. `risk_off_rotation` (NEW) — `SPY 20d return − TLT 20d return < −10pp` (SPY underperforms TLT by ≥10pp in 20 trading days)
7. `sentiment_extreme` (NEW, **dual-source per §2.1**) — fires if EITHER:
   - CBOE ^CPC 5d MA ≥ **1.15** (extreme fear) OR ≤ **0.65** (extreme complacency) — both tails of the contrarian sentiment indicator (Whaley 2009 §3, CBOE methodology), OR
   - VIX/VIX3M ≤ **0.80** (extreme front-end vol crush = complacency) — recalibrated from 0.85 in session 40 by quantile matching against the empirical `vix_term_ratio` distribution (p05 = 0.7959 on the 2008-present phase1_v3 corpus). At 0.85 the arm fired on 25.77% of days; at 0.80 it lands on 5.98% — the bottom-5% complacency tail. Whaley 2009 §3 motivates "extreme tail" framing but does not prescribe the 5% number; that's the empirical quantile. See `VIX_TERM_COMPLACENCY_FLOOR` docstring in `src/server/macro_regime_v3.ts` and the diagnostic at `scripts/_diagnose_vix_term_complacency_floor.ts`.

**Active-category count is 6** (categories 1, 2, 4, 5, 6, 7); category 3 (realized_stress) remains structurally 0 unless/until Phase 2 plugs θ. That preserves the bias-quarantine separation between phase1 and phase2 work.

**Red regime rule:** `categories_firing_5d ≥ 4` (≥4 of the 6 active categories fired in the trailing 5 trading days). This matches the SPEC §2.3 v1 phrasing "≥4 firing for ≥3 consecutive days" in the existing engine's rolling-5d-window form, and preserves the Phase 1/Phase 2 `deriveRegime` engine semantics verbatim (just under a larger category set).

**Orange:** `categories_firing_today ≥ 2`. **Yellow:** `categories_firing_today ≥ 1`. **Green:** otherwise. (Same engine constants as phase1_v2; only the input category set widens.)

**Threshold calibration** — the four initial picks (T10Y2Y persistence days, HYG/LQD 20d return, SPY/TLT 20pp gap, sentiment-extreme bounds) are **conservative Tier 0 thresholds**. Turn C of the implementation plan re-evaluates them against the four ADR-037 fixtures (2008_gfc, 2011_eu_debt, 2020_covid, 2014_calm) and may adjust before the v3 ramp lands. Any threshold tuning is documented in a new ADR and the SPEC §2.3 list is updated in the same PR. Per ADR-037 "threshold tuning under bias is forbidden" — since v3 has no survivorship bias in the leading indicators, the post-fixture tuning is **explicitly permitted**.

### 2.4 New classifier_version label

Active version becomes `phase1_v3`. Old `phase1_v2` rows in `macro_regimes` AND `bt_runs_regime` remain queryable under their old classifier_version. The C-5 sweep-attribution hook will start writing `phase1_v3` rows for new sweeps once the classifier core is flipped.

The BIAS_NOTE_PHASE1_V2 constant is RETIRED in production but kept in the codebase as a historical reference. A new BIAS_NOTE_PHASE1_V3 may exist if any residual bias is documented (e.g., "yield curve is FRED-published and survivorship-immune; HY OAS is index-level and survivorship-immune; sentiment readings are nominal and time-stable; therefore phase1_v3 carries no survivorship bias").

---

## 3. Implementation plan (across 2-3 turns)

### Turn A (this turn) — Data layer

1. New CH table `quantlab.macro_indicators_fred` for FRED series (date, series_id, value).
2. Extend `quantlab.candles` ingest to add TLT and ^CPC under `source='yfinance_regime'`.
3. Python script: `scripts/fred_ingest.py` — pulls T10Y2Y + BAMLH0A0HYM2 (and any future FRED series via config) using `pandas_datareader` (no API key needed for public series).
4. TS script extension: `scripts/macro_regime_ingest.py` adds TLT + ^CPC to ticker list.
5. Run ingests; verify data shape.

### Turn B — Classifier rule update + schema migration (session 39 turns 1+)

1. **CBOE put/call ingest script** — `scripts/cboe_putcall_ingest.py`. Pulls daily ^CPC history from CBOE direct CSV, writes to a new CH table `quantlab.macro_indicators_cboe` (mirrors `macro_indicators_fred` shape — `observation_date | series_id | value | source | ingested_at`). Fail-soft: if CBOE 404s or rate-limits, log and exit non-zero; phase1_v3 still works via the VIX/VIX3M complacency fallback alone.
2. **Schema migration** — additive ALTER on `quantlab.macro_regimes` (uses `ADD COLUMN IF NOT EXISTS` for idempotency, matching the Phase 2 migration pattern):
   - `yield_curve_value Nullable(Float64)` (T10Y2Y from `macro_indicators_fred`)
   - `hyg_lqd_ratio_20d_return Nullable(Float64)` (computed)
   - `spy_minus_tlt_20d_return Nullable(Float64)` (computed; SPY 20d return − TLT 20d return)
   - `put_call_value_5d_ma Nullable(Float64)` (CBOE ^CPC 5-day MA; null if CBOE ingest absent)
   - `yield_curve_inverted UInt8 DEFAULT 0`
   - `credit_stress UInt8 DEFAULT 0`
   - `risk_off_rotation UInt8 DEFAULT 0`
   - `sentiment_extreme UInt8 DEFAULT 0`
3. **Extend `inputs_missing` bitmask** with new flags (`INPUTS_MISSING_T10Y2Y=64`, `_LQD=128`, `_TLT=256`, `_CBOE_PUT_CALL=512`).
4. **Extend `classifyMacroRegime`** in `src/server/macro_regime.ts`:
   - Add new fields to `ClassifierInput` and `MacroRegimeRow` interfaces.
   - Extend `RegimeDataBundle` with `lqdDates/lqdByDate`, `tltDates/tltByDate`, `t10y2yByDate`, `putCallByDate` (5d MA pre-computed by the loader).
   - Add named threshold constants (`YIELD_CURVE_PERSISTENCE_DAYS=3`, `CREDIT_STRESS_20D_RETURN_FLOOR=-0.03`, `RISK_OFF_SPREAD_FLOOR_PP=-0.10`, `PUT_CALL_FEAR_HIGH=1.15`, `PUT_CALL_COMPLACENCY_LOW=0.65`, `VIX_TERM_COMPLACENCY_FLOOR=0.80` — initial pick was 0.85; recalibrated to 0.80 in session 40 per §2.3 footnote).
   - Compute the four new flags + the OR'd `sentiment_extreme`.
   - `categories_firing` now sums 7 flags; engine semantics unchanged.
5. **Flip `CLASSIFIER_VERSION`** to `'phase1_v3'`. Keep `phase1_v2` rows readable.
6. **`BIAS_NOTE_PHASE1_V3`** — replace the survivorship banner with a positive note: "Survivorship-immune leading-indicator classifier; no bias quarantine." `fixtureFailures: 0` (or whatever the Turn C fixture run shows). Wire into both consumers (`regime_dashboard.ts` and `operator_brief.ts`). Tests #10 + #15 enforce both update together.
7. **Run** `npm run macro:backfill -- --classifier-version=phase1_v3`.

Two-turn allocation OK if Turn B doesn't all fit in one chat: split between (i) ingest + schema + classifier core + tests, and (ii) BIAS_NOTE swap + backfill + fixture verification.

### Turn C — Fixture verification + ramp

1. Re-run fixture tests; expect the 3 phase1_v2 failures (2008_gfc, 2011_eu_debt, 2020_covid) to flip green.
2. If 2014_calm still fails (false positives in calm period), investigate threshold over-sensitivity separately.
3. Update Component 3 dashboard + Component 4 brief to read phase1_v3 by default; phase1_v2 readable as historical comparison.
4. Update C-5 sweep attribution: future sweeps tag under phase1_v3; existing rows preserved under phase1_v2.
5. ~~Mark ADR-037 as superseded by the new ADR-038 (phase1_v3 shipped).~~ **Historical drift (resolved 2026-05-16):** ADR-037 was *not* superseded — it remains the active record of the `phase1_v2` bias quarantine and the `ADR_037_BASELINE` archival comparator. ADR-038 (Accepted 2026-05-15, written up 2026-05-16) covers the post-CBOE-rerun `phase1_v3` distribution pin `{127/349/1392/2754}`, not the v3 ship-and-supersede this spec line had anticipated. The v3 ship is implicitly captured across ADR-037, ADR-038, and this spec; no standalone "v3 shipped" ADR exists.

---

## 4. Free-data verification — what we can and can't measure

Crucial honest accounting per the [SOURCING RULES] in Vector Core:

**What's solid (do this):**
- VIX, VIX3M, HYG, SPY, TLT (yfinance, all current and historical)
- ^CPC (yfinance, historical sometimes shaky pre-2008; will verify)
- FRED T10Y2Y, BAMLH0A0HYM2 (rock solid, daily data since 1970s and 1996 respectively)

**What we DON'T add despite being requested:**
- MOVE index — ICE proprietary, no clean free historical access
- True ETF inflow/outflow series — ICI weekly + paid services; replaced by SPY/TLT proxy
- AAII sentiment — public but weekly only; tier-2 source; defer

**What's permanently out of scope without Sharadar:**
- Point-in-time S&P 500 membership (`quantlab.sp500_history` from fja05680 ingested but unused for breadth recompute under v3)
- Historical delisted-ticker prices

---

## 5. Tests

| Test | What it checks |
|---|---|
| FRED ingest unit tests | Mock pandas_datareader, verify schema + idempotency |
| yfinance ^CPC + TLT ingest | Existing ingest pattern; one extension test |
| Classifier phase1_v3 unit tests | Mock indicator values, check category-firing logic across boundary cases |
| Fixture regression — 2008_gfc | Expected: ≥5 red days. v2 fails; v3 should pass. |
| Fixture regression — 2011_eu_debt | Expected: red days during Aug-Sep 2011. v2 fails; v3 should pass. |
| Fixture regression — 2020_covid | Expected: ≥5 red days Feb-Apr 2020. v2 has 0; v3 should fix. |
| Fixture regression — 2014_calm | Expected: 0 red days. v2 has 3 false positives. Investigate separately if v3 still fails. |
| BIAS_NOTE freshness test | If CLASSIFIER_VERSION = phase1_v3, the dashboard banner must reference v3 (or be empty/positive), NOT phase1_v2 bias language. |

---

## 6. Watch-outs

- **FRED series IDs are case-sensitive.** Confirm `T10Y2Y` and `BAMLH0A0HYM2` exact strings before ingest. Mistyped series ID returns 404.
- **pandas_datareader.fred returns sparse data on weekends/holidays.** Need to forward-fill or join to a trading-day calendar (use SPY trading days).
- **^CPC has limited history pre-2008.** May start the v3 classifier from 2008-01-01 (matches phase1_v2's start).
- **TLT has limited history pre-2003** (ETF launch). The SPY/TLT rotation indicator should be marked null pre-2003, not zero.
- **Threshold calibration is the big unknown.** Initial picks will need refinement against the fixtures. Be prepared to iterate.
- **The `2014_calm` false positive may persist.** It's NOT a survivorship-bias issue; it's a classifier sensitivity issue (probably VIX or HYG over-reacting to a minor wobble). If it doesn't fix itself when breadth is dropped, investigate separately — could need a persistence requirement or threshold widening.

---

## 7. RESEARCH log (closed)

- **Canon citations for new indicators:**
  - Estrella, Hardouvelis (1997) — *The Term Structure as a Predictor of Real Economic Activity* — yield curve inversion → recession lead.
  - Gilchrist, Zakrajšek (2012) — *Credit Spreads and Business Cycle Fluctuations* (American Economic Review) — HY OAS as leading stress indicator.
  - Whaley (2009) — *Understanding VIX* — VIX as fear gauge; supports VIX-related categories.
  - NY Fed's recession probability model uses 3m10y spread; T10Y2Y is the canonical 2s10s; either works. Picking T10Y2Y for cleaner economic interpretation.
- **Data quality verification done this turn:**
  - fja05680 ingested as `quantlab.sp500_history`: 1,343,707 rows, 1,194 unique tickers, 1996-2026. Confirms the survivorship gap (691 tickers in history not in today's 503) but also confirms we don't have price data for those 691 — hence the pivot to leading indicators instead of breadth-correction.
- **Cost decision:**
  - Sharadar at $49/mo: NOT needed for the macro classifier under phase1_v3.
  - Sharadar would only add value for the equity-backtest side (point-in-time universe for sweeps). Lower priority; revisit if equity backtest results show systematic bias.

---

## 8. Future-iteration roadmap — Phase 9+ candidates

When iteration on this classifier eventually resumes (current focus is paper-trading shakedown + v3 validation), the curated short list of academically-grounded candidate components is documented in [regime-classifier-phase9-candidates.md](./regime-classifier-phase9-candidates.md). Recorded so future-Opus and future-user have a reviewed list to choose from rather than reaching for whatever sounds interesting at the time. **Documentation only — no Phase 9 component is authorized for implementation.**

Quick index:

1. Margin debt growth rate (FINRA monthly, % of Wilshire 5000 — rate of change, not level)
2. Aggregate short interest rate of change (FINRA biweekly — rate of change, aggregate-only)
3. CFTC COT positioning (weekly SPX/Nasdaq e-mini — percentile rank within 3-year rolling)
4. ETF flow divergence (SPY/QQQ/IWM/XLK — flow-vs-price divergence)

Rejected: Form 4 insider transactions, options dealer gamma, prime-broker exposure surveys. See Phase 9 spec §6 for reasons.
