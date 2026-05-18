# SPEC — Macro regime classifier, Phase 1 data layer (rev 2)

> **Status:** ACCEPTED · 2026-05-09 (session 24, post-critic-pass) · CODE may begin.
> **Authoring role:** [RESEARCH→SPEC] per Vector Core; revised post-critic pass per `feedback_full_delegation_mode`.
> **Supersedes:** §1, §1.3, §6 of [`macro-regime-classifier-phase1.md`](macro-regime-classifier-phase1.md) (rev 1). All other sections (§2 indicators, §3 schema, §4 DDL, §5 tests, §7 acceptance, §8 framing) of rev 1 remain in force unchanged.
> **Triggered by:** ADR-035 (Stooq `^A50R` bulk-CSV endpoint went captcha-apikey-gated 2026-05-09) and user request 2026-05-09 to rebuild the data layer source-agnostically.
> **Critic pass:** see §13 for the resolved verdicts on the original five open questions plus four cross-cutting concerns. Six SPEC revisions were folded in before CODE began.
> **Scope discipline:** the *classifier* stays at three indicators in three categories. This rev only changes how the *data* gets in. No classifier logic changes; no second concrete adapter beyond yfinance.

---

## 0. Where this fits

Rev 1 specified a single-source-per-input data wiring (`yfinance` for VIX/VIX3M/HYG/SPY, Stooq `^A50R` for breadth) and forbade survivorship-biased fallbacks for backfill. Stooq's policy change made the locked breadth path unreachable. The first ingest (session 24) ran breadth-dark across 4,617 trading days, leaving red structurally unreachable and 4 of 6 historical fixtures failing.

User direction (2026-05-09) was to:

1. Build a source-agnostic adapter layer so any single source going stale is a one-line config swap, not a SPEC revision.
2. Wire yfinance for ETF/index inputs (vol + credit + the SPY arm of breadth).
3. Build a breadth chain that works without Stooq.

This SPEC defines that contract. The original direction also named FRED for macro data; the critic ruled it out of Phase 1 scope as YAGNI (§13 Q3) — the adapter *interface* in §3 is the forward-compat investment; a concrete second implementation isn't needed to prove the interface works (the iShares→Wikipedia split inside the constituent-breadth source already exercises multi-source composition). Phase 1 ships with one concrete adapter (yfinance) and one composite adapter (constituent-breadth, which uses yfinance internally).

This SPEC does **not** revisit the classifier's tier rules, threshold semantics, or NULL handling — those remain governed by rev 1 §2.

---

## 1. Verified availability landscape (RESEARCH summary)

Probed 2026-05-09 against the live yfinance API. Results determine which paths are real.

| Symbol | Provider | Result | Phase 1 use |
| --- | --- | --- | --- |
| `^VIX` | yfinance | 4,617 days 2008-01-02 → 2026-05-08 | volatility — primary |
| `^VIX3M` | yfinance | 4,617 days 2008-01-02 → 2026-05-08 (starts 2007-12-04 in source) | volatility — primary |
| `HYG` | yfinance | 4,617 days 2008-01-02 → 2026-05-08 (starts 2007-04-11 in source) | credit — primary |
| `SPY` | yfinance | 4,617 days 2008-01-02 → 2026-05-08 | credit + breadth-anchor — primary |
| `^A50R` | yfinance | **404 / not carried** | breadth — UNAVAILABLE |
| `^NYAD`, `^NYHL`, `^USHL`, `^A200R`, `^A50RU` | yfinance | **404** | not available as fallback |
| `^VXN` | yfinance | 6,361 days from 2001-01 | scaffolded by interface; not Phase 1 classifier |
| `^VVIX` | yfinance | 4,859 days from 2007-01 | scaffolded by interface; not Phase 1 classifier |
| `^A50R` | Stooq | apikey-gated since 2026-05-09; ADR-035 | optional primary if `STOOQ_APIKEY` set |
| IVV holdings (current) | iShares CSV | assumed accessible (verified-at-CODE-time per §8.1 fallback test) | breadth — Phase 1 fallback |
| S&P 500 list (current) | Wikipedia scrape | assumed accessible (verified-at-CODE-time per §8.1 fallback test) | breadth constituent fallback if iShares URL fails |
| PIT S&P 500 constituents (free) | none | Wikipedia changes-log scraping feasible but multi-day work | breadth — Phase 1 NOT pursued |

**Implication:** the user's proposed breadth chain {yf `^A50R` → IVV-constituent-computed → NYSE A/D} collapses to **{IVV-constituent-computed}** as the only Phase-1-viable path on a free stack with no operator action. This contradicts rev 1 §1.3 (which forbade constituent-computed breadth for backfill on survivorship-bias grounds). §5 documents the bias trade-off and §11 quarantines it from downstream consumers.

---

## 2. Goals and non-goals

### 2.1 Goals (Phase 1)

- G1. Source-agnostic adapter interface so providers are swappable.
- G2. Concrete yfinance adapter, used for VIX, VIX3M, HYG, SPY in the Phase 1 classifier path.
- G3. Composite breadth adapter (`IvvConstituentBreadthSource`) using yfinance for constituent histories and iShares (with Wikipedia fallback) for the constituent list. This adapter exercises the multi-source composition pattern that proves the interface design.
- G4. Optional Stooq adapter (`StooqApikeyBreadthSource`) — primary when `STOOQ_APIKEY` is set, absent otherwise. Per critic verdict §13 Q2.
- G5. ClickHouse cache layer with idempotent re-ingest; no silent re-fetch. Refresh is explicit (`--refresh-from <date>`).
- G6. Existing populated CH state (4,617 macro_regimes rows under `phase1_v1` from session 24) is preserved as the honest-NULL baseline. New rows under `phase1_v2` (this SPEC's iteration with constituent-computed breadth) coexist via ReplacingMergeTree's `(trade_date, classifier_version)` ordering. Per critic verdict cross-cutting #4.

### 2.2 Non-goals (Phase 1)

- N1. Adding a 4th classifier indicator. Phase 1 stays at 3.
- N2. Reconstructing point-in-time S&P 500 constituents. Survivorship bias is acknowledged, not solved.
- N3. Auto-detecting Stooq policy reversal and re-routing. The `STOOQ_APIKEY` env-var path stays available; promotion to primary when keyed is the registry-order default.
- N4. Wiring a FRED adapter. Per critic verdict §13 Q3, FRED is fully deferred to a separate Phase 2 SPEC. The adapter *interface* (§3) is forward-compatible; a concrete FRED implementation lands when an indicator that uses it is being wired.
- N5. Real-time / intraday breadth. Constituent-computed breadth runs end-of-day after the 500 closes are confirmed.
- **N6. (NEW per critic cross-cutting #2) Re-tuning rev 1 §2.3 thresholds against constituent-computed fixtures.** Any future threshold revision requires an unbiased breadth source (Stooq apikey, paid feed, or PIT reconstruction) as a precondition. This is the foot-in-the-door Pardo-vulnerability the critic flagged, fenced off explicitly here.

---

## 3. Adapter interface

The interface is the contract. Every concrete adapter in §4 implements it.

### 3.1 Python protocol (ingest layer)

```python
from typing import Protocol, Iterable
from datetime import date
import pandas as pd

class CandleSource(Protocol):
    """Adapter for daily OHLC-style series."""
    name: str   # provenance label, e.g. 'yfinance' / 'ivv_holdings' / 'stooq_a50r'

    def fetch_daily(
        self,
        symbol: str,
        start: date,
        end: date,
    ) -> pd.DataFrame:
        """Return columns ['ts','open','high','low','close','volume'].
        Empty DataFrame on missing data — never raise on a single-symbol
        404. Raises only on auth / config errors that block the whole run.
        Index-style series (FRED-style indices when those land in Phase 2)
        populate close=value with open/high/low equal to close and
        volume=0."""
        ...

    def supports(self, symbol: str) -> bool:
        """Cheap pre-check — does this provider claim to carry this symbol?"""
        ...
```

### 3.2 Registry + fallback chain

```python
class SourceRegistry:
    def register(self, source: CandleSource) -> None: ...
    def resolve(self, symbol: str) -> list[CandleSource]:
        """Return ordered list of providers willing to fetch `symbol`,
        primary first. Caller iterates until one returns non-empty."""
        ...

def fetch_with_fallback(
    registry: SourceRegistry,
    symbol: str,
    start: date,
    end: date,
) -> tuple[pd.DataFrame, str]:
    """Walk the chain; return (df, provenance_label). Empty df + ''
    means every adapter returned empty — caller decides whether that
    is fatal."""
```

**Why a registry, not a hard-coded chain:** rev 1 hard-coded Stooq and broke when Stooq broke. The registry lets us reorder providers in config, add a new one without code, and surface provenance per-row in CH (`source` column already exists in `quantlab.candles` and `quantlab.macro_breadth`).

### 3.3 Error semantics

- 404 / "symbol not found" → empty DataFrame, no exception. Caller falls back.
- 5xx / network timeout → retry 3× with exponential backoff (1s, 4s, 16s); then empty DataFrame + WARN to stderr.
- Auth failure → raise. Misconfig is a fail-loud condition; we do NOT silently skip a missing key. (Phase 1 has no auth requirement — `STOOQ_APIKEY` is optional, not required; the Stooq adapter's `supports()` returns False when the env var is unset.)
- Rate limit (yfinance 429) → exponential backoff up to 60s, then empty + WARN. yfinance batches up to 200 symbols per call; respect that.

---

## 4. Concrete adapters (Phase 1 ships exactly three)

### 4.1 `YFinanceCandleSource` (`scripts/adapters/yf_source.py`, new)

- Wraps `yfinance.download(...)`.
- Symbol validation is the pre-check: `Ticker(symbol).fast_info` lookup; failure → `supports() = False`. Cache the supports result for the process lifetime.
- Treats `^VIX` and `^VIX3M` (indices, no volume) as a special case — fills volume=0, never raises on missing volume column. Reuses the existing logic in `scripts/macro_regime_ingest.py:fetch_yfinance_series`.
- Symbols claimed: anything starting with `^`, plus the equity ETFs explicitly registered (HYG, SPY, IVV, etc.) and individual S&P 500 constituent tickers needed for breadth backfill.

### 4.2 `IvvConstituentBreadthSource` (`scripts/adapters/ivv_breadth.py`, new)

This is the load-bearing adapter — the Phase 1 default breadth path when `STOOQ_APIKEY` is unset. The survivorship-bias caveat that rev 1 §1.3 used to forbid this path is now an explicit accepted trade-off; see §5.

- **Constituent fetch:**
  - Primary: iShares official CSV at `https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund` (URL captured here for reproducibility; verified at CODE time via §8.1 unit test).
  - Fallback: scraped Wikipedia "List of S&P 500 companies" (current snapshot only, no PIT). Per critic cross-cutting #3, this fallback path is exercised by a unit test in §8.1, not deferred to "TBD-at-CODE-time."
  - Cache the constituent list to `quantlab.sp500_constituents` (new table; see §6.2). Refresh is explicit (`--refresh-constituents`). Default cadence is monthly.
- **Per-constituent close history:** for each ticker, fetch via the yfinance adapter (i.e., `IvvConstituentBreadthSource` calls `YFinanceCandleSource` — adapters can compose). Cache to `quantlab.candles` under `source='yfinance_constituents'`.
- **%-above-50DMA computation:**

  ```text
  for each trade_date d in window:
      eligible = {t in constituents : t has >=50 closes ending on d}
      pct_above_50dma(d) = |{t in eligible : close[t,d] > mean(close[t, d-49..d])}| / |eligible|
  ```

  - `eligible` excludes tickers that didn't trade yet on `d` (TSLA pre-2020, META pre-2013, PLTR pre-2024). Denominator shrinks naturally backward in time.
  - `eligible` cannot include tickers no longer in the current IVV holdings list (Lehman, Bear, Wachovia, WaMu, AIG-pre-bailout, GM, Merrill, Countrywide). This is the survivorship bias.
- **Optional manual reinstatement of known-failed-from-S&P names:** out of Phase 1 scope, but the adapter takes an optional `reinstatement_list: list[Ticker]` parameter so a future Phase 1.5 SPEC can hand-curate the load-bearing pre-2015 names back in. Not used in Phase 1.

### 4.3 `StooqApikeyBreadthSource` (`scripts/adapters/stooq_breadth.py`, repurposed from existing `scripts/macro_regime_ingest.py:fetch_stooq_breadth`)

- Reads `STOOQ_APIKEY` from env. If unset, `supports() = False` and the source is skipped — invisible to the chain.
- If set, `supports('^A50R') = True` and the source becomes available at registry's primary slot for breadth (per §3.2 default order below).

### 4.4 Default registry order (REVISED per critic verdict §13 Q2)

When the registry resolves the breadth symbol:

```text
if STOOQ_APIKEY is set:    chain = [Stooq, IvvConstituent]
else:                      chain = [IvvConstituent]
```

Rationale: an operator who set `STOOQ_APIKEY` opted in to the cleaner data; their action shouldn't be silently overwritten by ReplacingMergeTree races. Stooq-when-keyed is canonical; constituent-computed is the always-on fallback. Per critic verdict §13 Q2.

The ordering is **config, not hard-coded** — see §10 watch-out. Future SPECs can rebalance via env var or registry-config without touching code.

---

## 5. Breadth path — explicit trade-off (supersedes rev 1 §1.3)

### 5.1 Decision

**Constituent-computed breadth is permitted for backfill in Phase 1, gated behind a classifier-version tag.** Survivorship bias is acknowledged, made loud in `pct_above_50dma_source` provenance (`yfinance_constituents` vs `stooq_a50r`), and accepted as a Phase 1 trade-off. The bias is *quarantined* from downstream consumers via the `phase1_v2` classifier-version tag (per §6 cache contract and §11 A6+A10 acceptance fence) — consumers requiring unbiased data pin to `phase1_v1` (the breadth-dark / honest-NULL baseline from session 24, retained in CH).

### 5.2 Why (load-bearing reasoning, kept brief)

1. The alternative is breadth-dark (NULL on every row), which is what session 24 produced and which makes red structurally unreachable. NULL is honest but useless.
2. The constituent-computed signal is **biased low** in stress regimes (per critic: meaningful through ~2015, severe pre-2010): the missing-from-current-IVV names are exactly the ones whose <50DMA collapse defined those regimes, so removing them from the denominator inflates pct_above_50dma. `breadth_narrow` will under-fire in 2008 and 2020. Direction of bias is known and consistent (López de Prado AFML §11.3).
3. The bias trajectory is non-trivial: at ~4-5% S&P annual turnover, applying IVV-2026 to 2014 is missing roughly 12 × 4% = 48% of the 2014 universe (per critic). Bias is **not** "decays to zero approaching today" — it's "decays approaching today, but materially nonzero through ~2018." This was the critic's sharpest pushback on the rev 2 first draft and is corrected here.
4. Rev 1 §2.3's threshold-locking discipline is preserved by N6 (above): no re-tuning of `breadth_narrow`'s 50% / 95% thresholds against the constituent-computed series. If a fixture distribution doesn't match SPEC §5.2 expectations after re-ingest, **first** assume the survivorship signature, **second** consider Stooq apikey, **third** treat it as an unbiased-breadth-source question, **never** retune thresholds against biased fixtures.

### 5.3 Operator escape hatch

If the operator wants the unbiased path, they obtain `STOOQ_APIKEY` via the captcha at `https://stooq.com/q/d/?s=^a50r&get_apikey`, export it, and re-run ingest. The §4.4 chain now puts Stooq primary; constituent-computed becomes documented fallback for dates Stooq doesn't cover. Existing CH idempotency (ReplacingMergeTree on `(trade_date, source)`) handles the upgrade transparently.

### 5.4 Last-resort fallback

If both constituent-computed AND Stooq fail (e.g. iShares URL also breaks AND Wikipedia scrape fails AND no `STOOQ_APIKEY`), the adapter writes nothing for breadth on those days. `INPUTS_MISSING_BREADTH` (bit 16) is set per rev 1 §3.2. The classifier degrades exactly as session 24 did. NYSE A/D differential is **not** a substitutable last-resort in Phase 1 (different scale, different denominator, different mechanism — would require threshold recalibration which N6 forbids).

---

## 6. ClickHouse cache contract

### 6.1 Existing tables (unchanged)

- `quantlab.candles` — already used. New rows under `source='yfinance_constituents'` for the ~500 constituent histories. Existing `source='yfinance_regime'` rows for VIX/VIX3M/HYG/SPY remain valid.
- `quantlab.macro_breadth` — already created (DDL session 23). New ingest writes under `source='yfinance_constituents'`. Stooq path uses `source='stooq_a50r'`.
- `quantlab.macro_regimes` — already created. **New rows write under `classifier_version='phase1_v2'`. Existing 4,617 rows under `phase1_v1` remain queryable as the honest-NULL baseline.** Per critic cross-cutting #4. Idempotent re-classification within v2 per ReplacingMergeTree(ingested_at).

### 6.2 New table

```sql
CREATE TABLE IF NOT EXISTS quantlab.sp500_constituents (
  ingested_at  DateTime DEFAULT now(),
  effective_date Date,           -- date the constituent list was retrieved
  ticker       LowCardinality(String),
  source       LowCardinality(String),  -- 'ivv_holdings' / 'wikipedia'
  weight_pct   Float32 DEFAULT 0.0      -- IVV holdings weight, optional
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (effective_date, ticker, source);
```

Phase 1 stores only the most recent `effective_date`. Future PIT support is enabled by the `(effective_date, ticker)` ordering — historical lists slot in without schema change.

### 6.3 Cache invariants

- **No silent re-fetch.** A symbol that already has rows covering the requested window is not re-fetched. Operator forces a refresh via `--refresh-from <date>` per source.
- **Idempotent re-runs.** Re-running the full ingest pipeline with no flags is safe. ReplacingMergeTree collapses duplicate rows on `(token_address, interval, timestamp)` keeping the latest `ingested_at`.
- **Classifier-version coexistence.** `phase1_v1` and `phase1_v2` rows coexist in `quantlab.macro_regimes`. Queries against `macro_regimes` MUST specify `classifier_version` to be deterministic — the helper `fetchMacroRegimeRange` already takes this as a parameter. Default for new code paths is `phase1_v2`.
- **Source provenance is stored, not derived.** `source` column on every row is the adapter's `name`. A query can always answer "where did this row come from?" without re-fetching.

### 6.4 Constituent-history backfill bound

The 500-ticker × 17-year backfill is ~3-5 GB raw, ~500 MB-1 GB compressed (LowCardinality + ReplacingMergeTree). Acceptable on the user's hardware (per memory `user_hardware`).

---

## 7. Migration / re-ingest plan

### 7.1 Existing state (session 24)

- 4,617 macro_regimes rows present under `classifier_version='phase1_v1'`, `breadth_narrow=0` everywhere, `INPUTS_MISSING_BREADTH` set. **Preserved as-is per §6.1.**
- 18,468 yfinance_regime candle rows present (VIX/VIX3M/HYG/SPY).
- 0 macro_breadth rows.
- 0 sp500_constituents rows (table doesn't exist yet).

### 7.2 Migration steps

```text
0a. Bump CLASSIFIER_VERSION constant from 'phase1_v1' to 'phase1_v2'
    in src/server/macro_regime.ts. Tests under v2 tag.
1.  CODE the new adapters (yf_source, ivv_breadth, stooq_breadth).
2.  CODE the registry + fallback chain.
3.  CODE the new sp500_constituents DDL (extend ensureMacroRegimeTables).
4.  Run constituent-list ingest (one-time): fetch IVV holdings → write
    sp500_constituents.
5.  Run constituent-history ingest: ~500 yfinance calls, write to candles
    under source='yfinance_constituents'. Estimated 30-60 minutes via
    sequential-with-backoff per critic verdict §13 Q4.
6.  Run breadth computation: read constituent histories, compute
    pct_above_50dma per trade_date, write to macro_breadth under
    source='yfinance_constituents'.
7.  Run macro:backfill: classifies all 4,617 days under phase1_v2
    with breadth ON. phase1_v1 rows from session 24 are NOT touched.
8.  Run macro:emit-fixtures: re-emits the 6 CSVs with breadth populated.
9.  Run npm test: 4 currently-failing fixtures should improve. Whether
    they pass entirely depends on the survivorship-signature size (see
    §11 A6 for the new acceptance bar).
```

### 7.3 Expected post-migration test outcomes

- `2014_calm`: PASS (was already passing; breadth-on shouldn't regress it).
- `2017_holdout`: PASS (print-only, unchanged).
- `2020_covid`: most likely PASS — modern regime, IVV close to 2020 reality.
- `2018_q4_selloff`: most likely PASS — minor survivorship signature for 2018.
- `2011_eu_debt`: AMBIGUOUS — 2011 IVV included names like Bank of America-pre-restructure, Wachovia/Wells Fargo merger artifacts. Real signal probably partial.
- `2008_gfc`: LIKELY FAIL — Lehman, Bear, WaMu, AIG, Wachovia, Merrill, GM, Countrywide all missing from IVV-2026. Bias most severe here.

If `2008_gfc` and/or `2011_eu_debt` fail post-migration, that is **not** a CODE bug — it's the documented survivorship signature. Acceptance per §11 A6 explicitly tightens the bar so a 2-of-2 stress-fixture pass on the post-2015 fixtures alone is **insufficient** — at least one pre-2015 stress fixture must pass too, OR the bar falls to the simpler "non-zero red days exist" criterion.

---

## 8. Test plan

### 8.1 New unit tests (Python, pytest)

- `scripts/tests/test_yf_source.py` — adapter contract: 404 → empty, success → expected columns, supports() prefilter, volume=NaN handling for indices.
- `scripts/tests/test_ivv_breadth.py` — synthetic 5-ticker universe with hand-computed pct_above_50dma; eligible-set correctness across different lookback warmup states; reinstatement_list parameter is a no-op in Phase 1 but takes-and-returns expected shape.
- **`scripts/tests/test_constituent_fetch_fallback.py`** — iShares URL → Wikipedia fallback chain. Mock both endpoints; assert correct fallthrough on iShares 404, Wikipedia parse success, and final empty-DataFrame on both-failed. Per critic cross-cutting #3 (no "TBD-at-CODE-time" deferrals).
- `scripts/tests/test_registry.py` — chain order, fallback walk, provenance return; explicit test for "STOOQ_APIKEY set vs unset changes default order" per §4.4.
- `scripts/tests/test_stooq_apikey_source.py` — supports() returns False when env unset; URL construction with apikey appended; captcha-notice body detected as empty (regression test for ADR-035 surface error).

### 8.2 Existing tests preserved

- All 38 TS unit/integration tests on the classifier (rev 1 §5.1) — unchanged. Classifier logic is not touched.
- All 6 historical fixture tests (rev 1 §5.2) — unchanged definitions. Pass/fail semantics evolve with breadth signal as documented in §7.3.

### 8.3 New CH integration test

- `scripts/tests/test_cache_idempotency.py` — populate macro_breadth, re-run ingest, assert row count is unchanged (ReplacingMergeTree collapse).
- `scripts/tests/test_classifier_version_coexistence.py` — populate both `phase1_v1` and `phase1_v2` rows for the same trade_date; assert query helpers return the correct set per `classifier_version` parameter.

---

## 9. CLI / npm-script delta

Existing scripts updated to use the registry. New scripts for the new adapters:

```text
npm run macro:ingest                # unchanged surface; honors registry order + STOOQ_APIKEY
npm run macro:ingest:dry            # unchanged
npm run macro:ingest:breadth-only   # NEW — populate sp500_constituents + constituent histories + macro_breadth
npm run macro:refresh-constituents  # NEW — explicit refresh of IVV holdings; default monthly cadence
npm run macro:backfill              # unchanged surface; writes phase1_v2 rows
npm run macro:emit-fixtures         # unchanged surface
```

The `--refresh-from <date>` flag is the only blessed way to bypass the no-silent-re-fetch invariant.

---

## 10. Watch-outs

- **Survivorship bias is direction-of-error-known and meaningful through ~2018.** Per critic correction. Bias is toward overstating breadth in stress regimes pre-2015. Don't re-tune `breadth_narrow` thresholds against the constituent-computed series (N6). ADR-035 + this SPEC §5.2 record this.
- **iShares holdings URL is single-source-fragile.** The same fragility we got bitten by with Stooq. Mitigation: the Wikipedia fallback in §4.2 IS exercised by the §8.1 fallback test — not a paper guarantee. Per critic cross-cutting #3.
- **yfinance rate limits.** 500-ticker backfill uses batching (≤200 per call). Backoff per §3.3. Real-world: expect 30-60 minutes for the first full run. Sequential-with-backoff per critic verdict §13 Q4 — parallelization rejected as 429-storm risk for a one-time job.
- **Constituent-list refresh is monthly, not daily.** Daily refresh churns the holdings table for noise (IVV's daily holdings file changes by ~0.1% per day from share class adjustments). Monthly is enough for the regime classifier; the SPEC tier rules don't depend on real-time S&P 500 membership.
- **The registry's ordering is config, not code.** Once `STOOQ_APIKEY` lands, the env-var presence flips the default chain order automatically per §4.4. This is a design property, not a feature; the implementation must NOT hard-code an order in Python.
- **No PIT constituents in Phase 1.** Don't be tempted to manually curate a 2008-PIT list mid-implementation. Listed as Phase 1.5 option in §4.2 via the `reinstatement_list` parameter.
- **Classifier-version pinning matters for downstream consumers.** Any code or query touching `quantlab.macro_regimes` MUST specify `classifier_version` (`phase1_v1` for honest-NULL baseline, `phase1_v2` for breadth-on with constituent-bias-flagged). Defaulting to "latest" silently lets bias contaminate analyses. Per critic cross-cutting #4.

---

## 11. Acceptance criteria (revised §7 of rev 1, post-critic)

Phase 1 is acceptance-ready when:

- A1. All three adapters (`YFinanceCandleSource`, `IvvConstituentBreadthSource`, `StooqApikeyBreadthSource`) implement the `CandleSource` protocol and have unit tests per §8.1.
- A2. `quantlab.sp500_constituents` table exists; current IVV holdings are populated.
- A3. `quantlab.candles` has ~500 × 4,400 ≈ 2-2.5 M new rows under `source='yfinance_constituents'` (some constituents have less history, so total < 2.5M).
- A4. `quantlab.macro_breadth` has ~4,400 rows under `source='yfinance_constituents'`.
- A5. `quantlab.macro_regimes` has new rows under `classifier_version='phase1_v2'` (4,400+ rows) coexisting with the preserved `phase1_v1` rows. Distribution under v2 is materially different from session 24's 0/16/956/3645 — expect non-zero red and orange.
- **A6 (REVISED per critic cross-cutting #1).** **At least one pre-2015 stress fixture passes** (`2008_gfc` or `2011_eu_debt`) AND **non-zero red days exist** in the post-migration distribution. The rev-2-first-draft "≥4 of 6" bar was rejected as gameable: 2 of those 6 (`2014_calm`, `2017_holdout`) are gimmes (negative-control + print-only), so the bar effectively passed on `2018_q4` + `2020_covid` (post-2015, mildest survivorship) without ever testing the regime where the classifier most needs to work. The replacement criterion forces the test where it counts.
- A7. **DELETED** (was: FRED end-to-end test). Per critic verdict §13 Q3, FRED is fully out of Phase 1.
- A8. Re-running `npm run macro:ingest` with no flags is a no-op (no re-fetch, no row count change).
- A9. Setting `STOOQ_APIKEY` and re-running ingest writes Stooq rows alongside constituent-computed rows; the registry's chain order (Stooq primary when keyed) determines which `pct_above_50dma_source` value wins per date.
- **A10 (NEW per critic verdict §13 Q1 + cross-cutting #4).** **Downstream-consumer fence enforced.** No code or query in the codebase reads `macro_regimes` rows WHERE `pct_above_50dma_source = 'yfinance_constituents'` for threshold-derivation purposes. Enforcement is twofold: (i) the `phase1_v2` classifier-version tag means any consumer that explicitly pins to `phase1_v1` is automatically clean; (ii) a code-review checklist item is added to the project's CLAUDE.md or equivalent to flag any new Component-5+ code paths that query the v2 distribution and feed the result into a tuning loop, gating decision, or kill-switch criterion. The §8 framing of rev 1 ("Phase 1 produces DATA, not actions") is preserved by this enforcement.

If A6's "non-zero red days" passes but no pre-2015 fixture passes, the SPEC delivers but flags the fixture distribution as a separate Phase 1.5 RESEARCH question (PIT reconstruction or paid feed). Document in HANDOFF and do not relitigate at fixture-fail time.

---

## 12. What this SPEC explicitly does not change

These rev 1 sections remain in force unchanged:

- §2 (indicator definitions, threshold semantics, NULL rules).
- §3.1 (DDL for `quantlab.macro_regimes`).
- §3.2 (`inputs_missing` bitmask).
- §4 (TS classifier interface).
- §5.1 (38 unit tests on `classifyMacroRegime`).
- §5.2 (6 historical fixture definitions). **Note:** thresholds may NOT be revisited in any follow-up SPEC unless the breadth source is unbiased (per N6).
- §7 (acceptance criteria — superseded by §11 above; the rev 1 list and this list compose).
- §8 (Phase 1 framing — DATA not actions, no kill-switch wiring). **Reinforced by A10 above.**

---

## 13. Resolved questions (post-critic-pass 2026-05-09)

The five open questions in the rev-2-first-draft were closed by a critic-agent verdict per `feedback_full_delegation_mode`. Verdicts and integration:

1. **Q1 — Survivorship bias as accepted Phase 1 trade-off.** Critic verdict: **REVISE** (accept the trade-off, but add a hard fence keeping breadth-tagged rows out of any threshold-tuning, gating, or kill-switch consumer until PIT lands). **Integrated:** §5.1 quarantine framing, §6.1+§6.3 classifier-version separation (`phase1_v1` honest-NULL baseline preserved alongside `phase1_v2` constituent-breadth iteration), §11 A10 downstream-consumer fence.
2. **Q2 — Default registry order: IVV-constituent before Stooq.** Critic verdict: **REVISE** (flip — Stooq primary when keyed; constituent-computed always-on fallback). **Integrated:** §4.4 default chain.
3. **Q3 — FRED Phase 1 scope.** Critic verdict: **REVISE** (drop FRED from Phase 1 entirely; YAGNI; the adapter interface is the forward-compat investment, no second concrete adapter needed to prove it). **Integrated:** §2.1 G3 dropped, §2.2 N4 strengthened, §4.2 deleted (was FRED), §11 A7 deleted.
4. **Q4 — Constituent-history backfill cost.** Critic verdict: **ACCEPT** (sequential-with-backoff is correct; parallelization buys minutes at the cost of 429-storm risk). **No change.**
5. **Q5 — No PIT scraping in Phase 1.** Critic verdict: **ACCEPT** (defer PIT to Phase 1.5; pulling it into Phase 1 is multi-day scope creep). **No change.**

Plus four cross-cutting concerns identified by the critic:

- **CC#1 — A6 acceptance bar gameable.** **Integrated:** §11 A6 revised to require at least one pre-2015 stress fixture pass + non-zero red days criterion.
- **CC#2 — Pardo-vulnerability foot-in-the-door for threshold retuning.** **Integrated:** §2.2 N6 explicit non-goal.
- **CC#3 — iShares URL fragility paper guarantee.** **Integrated:** §4.2 + §8.1 explicit Wikipedia-fallback unit test.
- **CC#4 — Migration step 7 silently overwrites breadth-dark baseline.** **Integrated:** §6.1 classifier-version separation, §7.2 step 0a (CLASSIFIER_VERSION bump), §10 watch-out on classifier-version pinning, §11 A5+A10.

Critic overall verdict: **proceed with revisions**. All revisions integrated above. CODE may begin per §14.

---

## 14. Next stage — CODE order (post-critic-pass)

CODE may begin in this order:

1. **Adapter interface + registry + unit tests** (§3, §4.1, §4.2, §4.3, §8.1).
   - `scripts/adapters/__init__.py`, `scripts/adapters/base.py` (Protocol + Registry), `scripts/adapters/yf_source.py`, `scripts/adapters/ivv_breadth.py`, `scripts/adapters/stooq_breadth.py`.
   - Unit tests for each (`test_yf_source.py`, `test_ivv_breadth.py`, `test_constituent_fetch_fallback.py`, `test_stooq_apikey_source.py`, `test_registry.py`).
   - Bump `CLASSIFIER_VERSION` to `phase1_v2` in `src/server/macro_regime.ts` (§7.2 step 0a).
2. **Constituent table DDL + IVV holdings fetch** (§6.2, §11 A2).
   - Extend `ensureMacroRegimeTables` in `src/server/clickhouse.ts` to create `quantlab.sp500_constituents`.
   - Run one-time IVV holdings ingest.
3. **Constituent-history backfill** (§7.2 step 5, §11 A3).
   - ~500 yfinance calls via the new adapter.
4. **Breadth computation** (§7.2 step 6, §11 A4).
   - Read constituent histories from CH; compute pct_above_50dma; write to macro_breadth.
5. **Re-run macro pipeline + fixture verification** (§7.2 steps 7-9, §11 A5-A6).
   - macro:backfill writes phase1_v2 rows; macro:emit-fixtures regenerates CSVs; npm test verifies §11 A6.
6. **Idempotency + Stooq-promotion regression tests** (§8.3, §11 A8-A9).

Estimated wall-clock: 2-3 sessions to acceptance, dominated by step 3 (constituent backfill) and step 5 (fixture-distribution analysis).

---

*End of SPEC rev 2, post-critic.*
