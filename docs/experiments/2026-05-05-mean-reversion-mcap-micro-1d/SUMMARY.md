# Mean-reversion archetype on `mcap_micro × 1d` — empirical test

Date: 2026-05-05
ADR: ADR-022
Track: B-2 (per session-4 strategic fork)

## Motivation

Track B-1 (BTC regime pre-filter overlay, ADR-021) was empirically rejected
because the OOS window IS the bear regime. The diagnostic finding —
`mcap_micro` trades during the bear OOS were structurally pump-driven — raised
the hypothesis that mean-reversion entries (RSI<30) might be the more natural
archetype for that tier × interval, and that the trend_v1 baseline was just
mis-fitting reverter behavior as trend.

Track B-2 tests this: run the same ADR-018+020 meta-labeling pipeline on
`mean_reversion_v1` × `mcap_micro` × `1d` × p∈{3,5,7,10}, see if any cell PROMOTES.

## Cells trained

| cell-key                                       | m1_run_sig          | n_rows | m2_train | m2_tune | oos | embargo (bars) |
| ---------------------------------------------- | ------------------- | -----: | -------: | ------: | --: | -------------: |
| `mean_reversion_v1\|mcap_micro\|1d\|3`         | f91ddba84eaab6ab    |  1555  |    635   |    424  | 496 |              9 |
| `mean_reversion_v1\|mcap_micro\|1d\|5`         | 9cf7dcb273f3c1c3    |   746  |    322   |    216  | 208 |             16 |
| `mean_reversion_v1\|mcap_micro\|1d\|7`         | 9abf581c7542a6cc    |   459  |    196   |    131  | 132 |             27 |
| `mean_reversion_v1\|mcap_micro\|1d\|10`        | c7e0a9f20a0cabc1    |   236  |    101   |     68  |  67 |             46 |

Universe: 71 tokens at `mcap_micro/1d` (same loadUniverse as production sweeps).
BTC daily: 1825 bars for regime context features.

## Verdict — ALL REJECT

| cell    | p* (chosen) | n_kept (OOS) | OOS AUC | M1-native unfilt sum | M2-native sum | C1 | C2 | C3 | C4 | C5 | C6 | C7 | verdict |
| ------- | ----------: | -----------: | ------: | -------------------: | ------------: | -: | -: | -: | -: | -: | -: | -: | ------- |
| p=3     |  0.50       |  167         |  0.5026 |  −119.45%            |  +215.50%     | F  | P  | P  | P  | P  | F  | F  | REJECT  |
| p=5     |  0.50       |   18         |  0.4412 |  +233.08%            |  −162.00%     | F  | F  | F  | F  | F  | P  | F  | REJECT  |
| p=7     |  0.70       |    7         |  0.4476 |  +582.77%            |   −74.80%     | F  | F  | F  | F  | F  | P  | F  | REJECT  |
| p=10    |  0.50       |   28         |  0.4274 |   −45.27%            |  −257.50%     | F  | F  | F  | F  | F  | P  | F  | REJECT  |

Criterion legend (per ADR-018 §verdict + ADR-019):

- C1 — M2 OOS AUC ≥ 0.55
- C2 — OOS kept-trade count ≥ 100
- C3 — M2-filtered M1-native per-trade mean > unfiltered M1-native per-trade mean
- C4 — M2-filtered M1-native OOS sum > 0
- C5 — 5%-trimmed M2-kept native mean > 0
- C6 — top-1 trade share ≤ 50% of sum
- C7 — t-stat ≥ HLZ Bonferroni bar (M=240 → 4.117)

## Load-bearing diagnostics

### 1. v0 features are anti-predictive on mean-reversion entries

- 3 of 4 cells (p=5, 7, 10) have **OOS AUC < 0.50**. The meta-labeler
  doesn't merely fail to learn — it learns the WRONG side. p=10 is at
  AUC=0.4274 (worse than random by 7.3pp).
- Only p=3 lands at chance (0.5026). It's the broadest signal generator
  (1555 rows) so the lower-resolution learner approximation washes
  cleanly to chance.

### 2. p=7 has a strong unfiltered M1 baseline that meta-labeling destroys

p=7 is the strongest unfiltered M1 result across the entire 24-cell-training
v1-framework experiment series:

- OOS native sum: **+582.77%**
- OOS native trades: **132**
- OOS native per-trade mean: **+4.42%**
- M2 keeps only 7 trades at p*=0.70, gets −74.80%

This is a finding, not a deployable result. The unfiltered cell would PROMOTE
if we could trust the +4.42% per-trade is structural rather than tail-pump-
driven (which it is — see §3). And the v0-feature meta-labeler INVERTS this
edge rather than amplifying it.

### 3. Mean-reversion entries on `mcap_micro × 1d` are tail-driven, contradicting the archetype theory

Track B-2's premise was that bear-regime alt-coin behavior is more reverter
than trender. The data contradicts this for `mcap_micro × 1d`:

- p=5 M1-native sum +233% but M1-TB sum +24% — RSI<30 entries are RSI-
  oversold-bounce signals, but the bounces continue into long pumps that
  triple-barrier kills. ADR-018 watch-out reproduces.
- p=7 same pattern: M1-native +582% / M1-TB +342% — moderately tail-driven
  but TB still preserves >half the edge, the most reasonable ratio in the
  set.
- p=10 M1-native −45% / M1-TB +10.6% — TB outperforms native for the only
  time in the set, but the cell is too small (67 OOS trades) to interpret.

Conclusion: RSI<30 entries on `mcap_micro × 1d` are not a clean
mean-reversion archetype. They're "buy oversold mcap_micro tokens during a
bear OOS window" which is mostly trend continuation (down) punctuated by
occasional pump-on-bounces. This is what ADR-021's diagnostic predicted: the
OOS window is the bear regime, and entries during it inherit the regime's
tail-PnL profile regardless of strategy archetype.

## Combined N=24 v1-framework cell-trainings — ALL REJECT

| Session | ADR | Cell-trainings | Outcome |
| ------- | --- | -------------: | ------- |
| 3       | 018,020      |  8 | All REJECT |
| 4       | 021          | 12 | All REJECT |
| 5       | 022          |  4 | All REJECT |
| **Total** |   | **24** | **All REJECT** |

Cumulative HLZ bar update: M=240 + 4 (this session) = 244 → bar at α=0.05 ≈
4.130 (negligible move from 4.117).

## What this DOES NOT prove

- It does NOT prove the canonical mean-reversion archetype is dead in crypto.
  Different universe (mcap_liquid, large-cap CEX majors), different interval
  (4h, 1h), different entry rule (RSI thresholds other than 30, Bollinger
  bands, statistical-arb pairs) could all show edge.
- It does NOT prove v0 features are useless. The features were designed for
  trend-following primaries. The 3-of-4 anti-predictive AUC on mean-reversion
  cells is at least partially a "wrong feature set for this M1 archetype"
  problem — the EMA-fast/slow features, in particular, are tied to PARAM via
  `EMA_FAST = PARAM, EMA_SLOW = PARAM*3`, which made some sense for trend_v1
  but is forced when PARAM is an RSI period.
- It does NOT prove the OOS window is unrecoverable. A v1 feature set that
  encodes regime-conditional state more directly (BTC drawdown DEPTH as a
  numeric, vol regime) might surface conditional edge that the v0 features
  miss. ADR-021's finding (the OOS IS the bear regime) means a feature has to
  learn within a single regime — it can't learn across regimes the OOS doesn't
  contain.

## What this DOES tell us

1. **The v0+meta-labeling pipeline has now been tested across 3 strategy
   archetypes (trend, momentum, mean-reversion) × multiple tiers × multiple
   params. None of the 24 trainings PROMOTE.** This is the most direct
   evidence yet that **v0 features are the bottleneck**, not the strategy
   archetype.

2. **p=7's unfiltered M1 baseline (+582%, +4.4%/trade, 132 trades) is the
   strongest unfiltered cell in the whole series.** It still doesn't deploy
   without robustness checks (it's the bear-OOS, so the +582% is conditional
   on bear regime; tail-driven; t-stat haven't been computed for the
   unfiltered population since the verdict pipeline only does it for the M2-
   kept set). But it's a more interesting starting point for a v1-feature
   experiment than the trend cells were.

3. **Track A (v1 features) becomes more attractive than before.** If v0 is
   the bottleneck, the next legitimate move is to upgrade features rather
   than continue archetype-shopping. Track A starts with ONE high-priority
   feature (BTC drawdown DEPTH as continuous numeric) on the strongest
   cell from this series — `mean_reversion_v1|mcap_micro|1d|p=7`.

## Files

| file                                       | purpose                                  |
| ------------------------------------------ | ---------------------------------------- |
| `build_p3.log` / `build_p5.log` / `build_p7.log` / `build_p10.log` | stdout from `build_meta_train_set.ts` per cell |
| `train_p3.log` / `train_p5.log` / `train_p7.log` / `train_p10.log` | stdout from `train_meta_label.py` per cell    |
| `SUMMARY.md` (this file)                   | experiment writeup                       |

## Reproducibility

```text
# build (per cell)
npx tsx scripts/build_meta_train_set.ts --strategy mean_reversion_v1 --tier mcap_micro --interval 1d --param <p>

# train (per cell)
.venv/Scripts/python.exe scripts/train_meta_label.py --cell-key 'mean_reversion_v1|mcap_micro|1d|<p>' --m1-run-sig <sig>
```

Sigs are captured in the cells table above; they are deterministic given
`(strategy, tier, interval, param, kPt, kSl, verticalBars, atrWindow, splitPct)`
where defaults are kPt=2, kSl=1, vert=auto, atrWindow=20, splitPct=70.

## DB state after experiment

- `quantlab.meta_train_trades`: +2996 rows (1555+746+459+236) for the four
  cell-keys.
- `quantlab.meta_models`: 4 rows inserted (one per cell). Each row's
  `hyperparams_json._regime_filter = 'none'` (carried from ADR-021's
  registry).
- `quantlab.bt_runs`, `bt_trades`, `strategy_scores*`, `candles`: UNCHANGED.
