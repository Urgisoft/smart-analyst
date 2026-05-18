# Meta-labeling framework pathologies — N=2 evidence

**Date:** 2026-05-04
**Source:** Empirical, this session. Builds on López de Prado, *Advances in Financial Machine Learning* (2018), chapter 3 (triple-barrier labeling) and chapter 5 (meta-labeling).
**Trigger:** N=2 evidence run (`trend_v1|mcap_nano|1d|5` then `momentum_v1|mcap_nano|1d|3`) revealed two distinct pathologies in the ADR-017 framework that need fixing before any further M2 work.

---

## Intuition

Meta-labeling, in the LdP formulation, is supposed to do exactly one job: take a primary strategy's already-fired entries and learn a secondary classifier that says "take this one" or "skip this one." The promise is volume reduction without quality loss — fewer trades, but the kept ones are systematically better.

Two design choices in the v0 framework looked innocent and were not:

1. **Using triple-barrier exits both as the label AND as the deployed exit rule.** The label needs a binary outcome (won / lost) for classification. Triple barrier (PT=2×ATR, SL=1×ATR, vertical=N bars) gives a clean binary. But then ADR-017 also said: at deployment, exit using those same barriers. That's a totally different decision — you've replaced the primary strategy's exit logic with one whose only purpose was to manufacture binary labels.
2. **Tuning the threshold against the label-derived PnL.** The trainer picks p\* by maximizing sum of triple-barrier PnL on a tune slice. But if the strategy is going to be DEPLOYED with native exits, that tuning is optimizing the wrong thing.

Both pathologies are visible in the empirical data once you ask the right question.

## Mechanism — Pathology 1: Label-vs-exit mismatch

A binary label only describes a YES/NO event. The triple-barrier label "did this trade hit +2×ATR before −1×ATR within N bars" answers a question about the early dynamics of a trade. It says nothing about what happens AFTER the barrier window.

For a tail-driven strategy (trend_v1: catch rare 100×+ pumps and let them run), most of the strategy's edge is in trades that:

- Take a long time to mature (much longer than the vertical barrier window).
- Have positive expectancy mainly through asymmetric upside, not by reliably hitting modest profit targets.

If you redeploy with PT=2×ATR exits, you systematically:

- Cut winners at 2×ATR — destroying the asymmetric-upside edge.
- Take SL hits at 1×ATR — removing the trades that would have eventually mean-reverted into a winner.

Empirically, on `trend_v1|mcap_nano|1d|5` OOS:

| exit rule | trades | sum PnL |
| --- | --- | --- |
| M1 native (EMA crossover) | 609 | **+27.14%** |
| M1 with triple-barrier exits | 609 | **−746.20%** |

Same entries, different exits. The exit choice flipped the strategy from positive to catastrophically negative. ADR-017's design assumed the label exit and the deployment exit could be the same rule. They cannot be, for tail-driven strategies.

## Mechanism — Pathology 2: Threshold-objective mismatch

This one is more subtle and was visible only in the momentum_v1 N=2 run.

Setup:
- v0 features have moderate predictive power on the LABEL (OOS AUC = 0.612).
- The model assigns each trade a probability of hitting PT.
- The trainer tunes p\* by sweeping thresholds on the m2_tune slice and picking the one that maximizes triple-barrier PnL of the kept trades.

Now look at OOS decile analysis (N=1437 OOS trades, bucketed by predicted P(PT-hit)):

| decile | n | p range | label rate | native mean PnL | native sum PnL |
| --- | --- | --- | --- | --- | --- |
| 0 (lowest) | 144 | 0.000–0.003 | 6.9% | −1.21% | −174% |
| 9 (highest) | 144 | 0.284–0.974 | 14.6% | **+7.32%** | **+1053%** |

The top decile is GOLD under native exits — +1053% sum on 144 trades. The model identified the most valuable trades.

But the trainer's chosen p\*=0.40 (tuned on triple-barrier PnL) keeps only the subset with p ≥ 0.40 from the top decile (and nothing from below). That subset is n=90, sum −531%, mean −5.91%. The remaining 54 top-decile trades (p ∈ [0.284, 0.40), excluded by the threshold) sum to **+1585%, mean +29.4%/trade**.

In other words: **the threshold cut OFF exactly the most valuable trades and KEPT the worst-under-native ones from the top decile.** The model is partially right about ranking, but the tuning objective steered the threshold to the wrong cut.

The mechanism: trades with very high P(PT-hit) under a 2-bar vertical barrier are characterized by "fast, sharp move expected." Under PT=2×ATR exits these win the label. Under native (EMA-crossover) exits, the same trades often overshoot, then mean-revert, and the slow EMA gives back gains plus more. The trades with MODERATELY high P(PT-hit) (decile 9 lower half) are setups that develop more steadily — they're worse under triple-barrier (they often fail to hit 2×ATR within 2 bars and time out at vertical barrier with mediocre PnL = label 0) but BETTER under native exits because the slow EMA captures the eventual trend.

## Failure mode

Both pathologies are silent. A practitioner running the v0 framework would see:

- Cell rejected because OOS sum negative.
- Conclude "features lack predictive power" or "this strategy can't be meta-labeled."

Both conclusions would be wrong if pathology 2 is the cause. The model HAS predictive power; it's the framework that's wrong.

How to distinguish:

- If OOS AUC is at chance (e.g. trend_v1 0.504), features really are weak. No threshold scheme will fix it.
- If OOS AUC is meaningfully > 0.55 (e.g. momentum_v1 0.612) but M2 native sum is still negative, run a decile analysis. If top deciles have positive native mean PnL, the framework is broken — features are fine.

## Implication for ADR-018

The right form of the framework, per LdP §3.6 and the empirical evidence above:

1. **Label** = triple-barrier outcome (binary; defines what "won this typical move" means; cleanly classifiable).
2. **Deploy exits** = M1 native exits (preserves the primary strategy's edge structure; especially load-bearing for tail-driven strategies).
3. **Threshold tuning objective** = sum of M2-filtered M1-native PnL on m2_tune (matches deployment metric to tuning metric).

The trainer already persists `m1_pnl_pct_actual` per row, so re-tuning against native PnL is a one-line change.

## Caveats

- Both findings are based on N=2 cells. The label-vs-exit mismatch is mechanistically clear and unlikely to depend on cell choice; the threshold-objective mismatch was only seen on momentum_v1 (trend_v1 had AUC at chance, so the question didn't apply). One additional cell with AUC > 0.55 would strengthen the second finding.
- The "+1585% sum on 54 trades" within decile 9 is a discovery without an OOS test of its own. If we re-tune against native PnL on tune and re-evaluate on OOS, that's the proper test.
- The `m1_pnl_pct_actual` numbers are full-stream M1 (EMA inherited from IS), not slice-warmed. Per the prior watch-out: this is more deployment-realistic but produces different per-trade means than slice-warmed diagnostics.
