# 2026-05-05 — BTC regime-filter overlay experiment

**Status:** Complete. Result: REJECT (Track B-1 empirically off the table).

**ADR:** [ADR-021](../../decisions/README.md#adr-021--btc-regime-pre-filter-overlay--empirically-rejected-on-v1-cells-under-current-oos-window).

**Teach-doc:** [2026-05-05-regime-filter-overlay.md](../../teach/2026-05-05-regime-filter-overlay.md).

---

## Setup

Two cells × six runs each (1 baseline + 5 regime variants):

- `trend_v1|mcap_micro|1d|p=5` (sig=487bf85ca0439274) — files
  [00-baseline-none.txt](00-baseline-none.txt) +
  [01-btc_sma_50.txt](01-btc_sma_50.txt),
  [01-btc_sma_100.txt](01-btc_sma_100.txt),
  [01-btc_sma_200.txt](01-btc_sma_200.txt),
  [01-btc_drawdown_20.txt](01-btc_drawdown_20.txt),
  [01-btc_drawdown_30.txt](01-btc_drawdown_30.txt).
- `momentum_v1|mcap_nano|1d|p=3` (sig=36dd8391956cb6cb) — files
  [10-mom_nano-baseline-none.txt](10-mom_nano-baseline-none.txt) +
  [11-mom_nano-btc_sma_50.txt](11-mom_nano-btc_sma_50.txt),
  [11-mom_nano-btc_sma_100.txt](11-mom_nano-btc_sma_100.txt),
  [11-mom_nano-btc_sma_200.txt](11-mom_nano-btc_sma_200.txt),
  [11-mom_nano-btc_drawdown_20.txt](11-mom_nano-btc_drawdown_20.txt),
  [11-mom_nano-btc_drawdown_30.txt](11-mom_nano-btc_drawdown_30.txt).

Each variant runs the full ADR-018 + ADR-019 + ADR-020 pipeline with
the named regime filter applied as a pool pre-filter (drops rows whose
`signal_ts` is outside the named BTC regime). The M1 trade pool and
`m1_run_sig` are unchanged across variants.

---

## Headline result

**12 trainings, 12 REJECTs.** No regime variant unlocks either cell.

The diagnostic — OOS retention by filter — is the load-bearing finding:

| filter | trend_v1/mcap_micro OOS retain | momentum_v1/mcap_nano OOS retain |
| --- | --- | --- |
| btc_sma_50 | 47.1% | 47.5% |
| btc_sma_100 | 6.5% | 11.4% |
| btc_sma_200 | 0.3% | 2.4% |
| btc_drawdown_20 | 0.3% | 2.6% |
| btc_drawdown_30 | 26.5% | 27.3% |

The OOS window is overwhelmingly bear-regime by every reasonable BTC-
regime definition. Bull-regime filters destroy the OOS slice, leaving
nothing for the meta-labeler to evaluate. The cell's apparent baseline
edge (+574% on 16 trades for trend_v1/mcap_micro) was bear-regime-
conditional pump-luck, not a regime-conditional edge that a filter
could surface.

See [ADR-021](../../decisions/README.md#adr-021--btc-regime-pre-filter-overlay--empirically-rejected-on-v1-cells-under-current-oos-window)
for the full table, mechanism, caveats, and "what this DOES NOT prove."

---

## How to reproduce

```bash
# Baseline (no filter):
.venv/Scripts/python.exe scripts/train_meta_label.py \
  --cell-key 'trend_v1|mcap_micro|1d|5' \
  --m1-run-sig 487bf85ca0439274 \
  --regime-filter none

# Any regime variant:
.venv/Scripts/python.exe scripts/train_meta_label.py \
  --cell-key 'trend_v1|mcap_micro|1d|5' \
  --m1-run-sig 487bf85ca0439274 \
  --regime-filter btc_sma_100
```

Valid `--regime-filter` values: `none`, `btc_sma_50`, `btc_sma_100`,
`btc_sma_200`, `btc_drawdown_20`, `btc_drawdown_30`. Filter spec is in
`REGIME_FILTERS` in [scripts/train_meta_label.py](../../../scripts/train_meta_label.py).
