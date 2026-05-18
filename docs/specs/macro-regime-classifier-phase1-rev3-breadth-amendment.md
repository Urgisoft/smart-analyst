# Macro regime classifier — Phase 1 SPEC rev 3 (breadth amendment)

**Status:** Accepted · **Date:** 2026-05-09 · **Author:** Vector Core
session 33 · **Supersedes:** [phase1.md](macro-regime-classifier-phase1.md)
§1.3 prohibition on constituents-computed breadth for backfill ·
**Authority:** [ADR-037](../decisions/README.md#adr-037).

This is an **amendment** to the Phase 1 SPEC, not a full rewrite.
SPEC §1.3 is replaced; all other sections are unchanged unless
explicitly noted below.

## Summary

ADR-035's locked path forward (restore breadth via Stooq apikey) is
invalidated — Stooq removed `^A50R` from its catalog after ADR-035
was written. No free programmatic alternate source exists at the
required quality (verified 2026-05-09 against Yahoo Finance,
Investing.com, FRED, StockCharts free tier). Sharadar (Track B)
remains the principled fix but is blocked on subscription activation.

This amendment **lifts the §1.3 prohibition on constituents-computed
breadth for historical backfill**, conditional on explicit bias
documentation and revisit triggers. The constituents-derived breadth
already shipped in code via [`scripts/macro_compute_breadth.py`](../../scripts/macro_compute_breadth.py)
becomes the canonical Phase 1 breadth source under
`source='yfinance_constituents'` until Sharadar enables a survivorship-
correct upgrade.

## §1.3 — REPLACED

### Old §1.3 (rev 1, lines preserved here for git history)

> Breadth source: Stooq `^A50R` is the primary; constituents-computed
> fallback (`compute_breadth_from_constituents`) is **forbidden for
> historical backfill** because applying the current S&P 500
> constituent list to historical dates omits delisted names whose
> <50DMA collapse defined past stress regimes. Survivorship bias is
> the exact failure mode the SPEC is built to avoid. Fallback may be
> used for current-day classification only.

### New §1.3 (rev 3)

**Primary source: `source='yfinance_constituents'`** in
`quantlab.macro_breadth`. Computed by
[`scripts/macro_compute_breadth.py`](../../scripts/macro_compute_breadth.py)
from S&P 500 constituent close histories under the current
`sp500_constituents` snapshot (`source='ivv_holdings'`).

**Stooq `^A50R` is no longer a viable source.** Removed from Stooq's
catalog 2026 (verified by HTTP redirect from
`stooq.com/q/?s=^a50r` → search-not-found page). Any code path that
prefers `source='stooq_a50r'` over `source='yfinance_constituents'`
in `quantlab.macro_breadth` is operationally inert — `stooq_a50r`
rows do not exist for any post-2026-05 date. The preference ordering
in [`src/server/macro_regime.ts`](../../src/server/macro_regime.ts)
`loadBreadthSeries` (Stooq first, constituents second) is preserved
verbatim so that a future restoration of `^A50R` (Stooq policy
reversal, paid feed substitute writing under the same source label)
would auto-promote.

**Survivorship bias is acknowledged and documented.** Bias direction
and magnitude are quantified in
[`docs/phase1_breadth_restoration/bias_quantification.md`](../phase1_breadth_restoration/bias_quantification.md).
Summary:

- Universe coverage by current 503 names ranges from **51.5% mean in
  2008 → 100% in 2026**.
- The 381 historical-only tickers that are missing from the current
  503 cluster around stress events (bankruptcies; pre-merger tickers;
  pre-spinoff parents). Their absence biases `pct_above_50dma`
  **upward** in stress regimes, by ~5-15 percentage points for
  2008-2014, <5 for 2018+, ~0 for 2024+.
- Yfinance coverage of delisted tickers is ~5% real (most "non-empty"
  responses are ticker-symbol reuse by other entities — `WB` returns
  Weibo not Wachovia, `WM` returns Waste Management not Washington
  Mutual, etc.). This precludes a free best-effort recovery of the
  missing names.

**Bias quarantine remains via classifier_version.** The `phase1_v2`
classifier label denotes "constituents-derived breadth, current-IVV
snapshot, survivorship-biased." Any future survivorship-correct
classifier (e.g., post-Sharadar Phase 1 rev 4) MUST use a new
classifier_version label (e.g., `phase1_v3`) so downstream consumers
can distinguish biased from unbiased breadth without reading SPEC
metadata.

**Threshold tuning prohibition (preserved from rev 1).**
[N6 in macro_regime_ingest.py:24-28](../../scripts/macro_regime_ingest.py#L24-L28)
remains in force: **do not tune `BREADTH_NARROW_THRESHOLD` or
`SPY_NEAR_HIGH_FRACTION` against fixture-test failures driven by the
biased series.** A failed fixture test under `phase1_v2` is evidence
of bias, not of threshold mistuning. The thresholds are anchored to
the source-doc literature (50% breadth threshold, 95% near-high
gate); they are not tunable parameters under `phase1_v2`. Tuning may
resume only when a survivorship-correct breadth source enables a
meaningful regression test (post-Sharadar `phase1_v3`).

**Fixture-test handling.** The four currently-failing tests
([2008_gfc, 2011_eu_debt, 2014_calm, 2020_covid](../../scripts/tests/macroRegimeFixtures.test.ts))
are left **as failing, not skipped.** Per ADR-035 §3 precedent:
skipping silently lets the regression that breadth-correctness must
reverse pass undetected; leaving them failing visibly signals the
known-incomplete state. The 4 failures are documented as
expected-under-`phase1_v2` in [ADR-037 §5](../decisions/README.md#adr-037)
with attribution:

- **2014_calm** (3 reds vs expected 0) — bias-driven false positive.
- **2020_covid** (0 reds vs expected ≥5) — topping-signal architecture
  (`breadth_narrow` requires `spy_at_or_near_high`); not bias-driven.
- **2008_gfc, 2011_eu_debt** — mixed bias + architecture.

## §1.6 — UNCHANGED

Methodology-era handling (CBOE VIX 2014 construction break per
Pardo §6) remains as rev 2.

## §2 — UNCHANGED

Indicator definitions (`vix_term_inverted`, `hyg_spy_divergence`,
`breadth_narrow` topping-signal logic, composite tier rule)
unchanged from rev 2. The amendment changes the **breadth source**
and **acceptable bias level**, not the breadth indicator's firing
logic.

## §3 — UNCHANGED

## §4 — UNCHANGED

Schema and write-paths unchanged. `quantlab.macro_breadth` continues
to support multiple `source` values via the `(trade_date, source)`
sort key; the only operational change is that `source='stooq_a50r'`
will not be written under foreseeable conditions.

## §5.2 — AMENDED expected distributions

Old §5.2 expected ≥30% red days in 2008 GFC and ≥5 red days in
2020 COVID — these targets assumed Stooq breadth was available and
survivorship-correct. Under `phase1_v2` (constituents-derived,
biased), those distributions are not achievable; the topping-signal
architecture (§2.3) further constrains red firing during the crash
phase regardless of breadth quality.

**New §5.2 (rev 3):** Expected distributions under `phase1_v2`:

| Event | Old target | Rev 3 target | Reason |
|---|---|---|---|
| 2008 GFC | ≥30% red | TBD when Sharadar lands | Bias + topping-signal |
| 2011 EU debt | ≥10% red | TBD | Bias + topping-signal |
| 2014 calm | 0 red | 0 red (still) | Bias produces false positives — KNOWN limitation |
| 2018 Volmageddon | (no target) | (no target) | |
| 2020 COVID | ≥5 red | 0 red (architectural) | Topping-signal — not bias |
| 2022 selloff | (no target) | (no target) | |

The "TBD when Sharadar lands" entries are the principled targets
the SPEC was originally written against. They become testable under
`phase1_v3` (post-Sharadar). Under `phase1_v2`, the four known
failures stand and must not be relitigated.

## §6 — UNCHANGED

NULL-input contract and `inputs_missing` bitmask preserved. Bit 16
(`INPUTS_MISSING_BREADTH`) continues to mark dates where no breadth
row exists for the trade date — this is now expected only for the
warmup period before the first 50-day MA computation
(approximately 2008-01-02 → 2008-03-12).

## §7 — UNCHANGED

Acceptance criteria and operational checks preserved.

## §11 — AMENDED A4 acceptance + A10 fence

### Old §11 A10 (rev 1)

> The constituents-computed fallback is fenced behind
> `classifier_version='phase1_v2'`. Do not promote to active default
> classifier.

### New §11 A10 (rev 3)

**`phase1_v2` IS the active default classifier.** Fence reversed
under ADR-037: the previously-fenced bias is now the canonical Phase
1 source (Stooq `^A50R` no longer exists; alternate free sources
absent; Sharadar Track B blocked). The original §11 A10 fence framed
constituents-computed as "fallback when Stooq is down today." The
new framing: constituents-computed is the operational default; any
survivorship-correct upgrade requires a new classifier_version.

The semantic preservation: **`phase1_v2` always means
"constituents-derived, current-IVV-snapshot, survivorship-biased."**
A future `phase1_v3` (post-Sharadar) means "constituents-derived,
point-in-time-membership, survivorship-correct." The classifier_version
label remains the bias-quarantine boundary; what changed is which
boundary is on the active side.

### A4 acceptance (target row count)

`quantlab.macro_breadth` row count target: **~4,400-4,600 rows**
covering 2008-03-13 → today (warmup-clipped at the start). Current
state per session-33 query: **4,568 rows** under
`source='yfinance_constituents'`, satisfying A4.

## What this amendment does NOT do

1. **Does not implement Wikipedia-membership / point-in-time
   correctness.** That is a deferred improvement on top of `phase1_v2`,
   trackable as a future work item (e.g., revisit when Sharadar
   activates and superseded entirely there).
2. **Does not change `BREADTH_NARROW_THRESHOLD` (50%) or
   `SPY_NEAR_HIGH_FRACTION` (0.95).** Threshold-tuning under bias is
   explicitly forbidden (§1.3 N6 preserved).
3. **Does not change the topping-signal architecture.** The
   `breadth_narrow` logic requires `spy_at_or_near_high`. The 2020
   COVID test expectation is incompatible with this design and is
   removed from §5.2.
4. **Does not modify the daemon, the dashboard, or any consumer of
   `phase1_v2` rows.** Existing readers transparently consume the
   biased breadth.

## Revisit triggers

Per ADR-037 §6, this amendment should be revisited when:

1. Sharadar Track B activates (point-in-time membership +
   delisted-ticker prices become available).
2. A free or affordable alternative emerges for delisted-ticker
   prices.
3. The topping-signal architecture is reopened in a Phase 3 (changing
   `breadth_narrow` away from the near-high gate would change the
   bias profile materially).
4. A specific operational limitation manifests that traces to the
   bias (e.g., daily classifier produces a regime decision the user
   suspects is biased; downstream backtest validation produces
   anomalous regime-conditioned PnL).

The user has explicitly stated (session 33): "We'll revisit Sharadar
if and when we hit a specific limitation that requires it." This
amendment defers the survivorship-correct upgrade to that trigger.
