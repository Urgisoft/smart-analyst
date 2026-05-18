# Why parameter tuning isn't a fix — it's the failure mode

**Source:** Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014) §3.
Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest
Overfitting* (2014). Harvey, Liu & Zhu, *…and the Cross-Section of
Expected Returns* (2016) §V (multiple-testing haircut). López de Prado,
*Advances in Financial Machine Learning* (2018) Ch. 11 (backtest
overfitting). Bergstra & Bengio, *Random Search for Hyper-Parameter
Optimization* (2012) §3 (why grid search inflates noise). Pardo, *The
Evaluation and Optimization of Trading Strategies* (2008) §10 (parameter
robustness).

Related project teach-doc: [2026-05-02-trial-cardinality.md](2026-05-02-trial-cardinality.md).

---

## Intuition

The most natural reaction to "this strategy doesn't pass validation" is **"let's
tune the parameters until it does."** That instinct feels like engineering
discipline — "we just haven't found the right setting yet." It is, in fact,
the single most common way retail systematic traders blow themselves up.

Here's the reframe: **parameter tuning is not a path from "doesn't work" to
"works." Parameter tuning is the mechanism by which a strategy that doesn't
work *looks like it works*.** The harder you tune, the better the in-sample
result, the worse the out-of-sample reality, and the bigger your eventual
loss when you deploy real money.

The validation gauntlet (DSR, PBO, HLZ haircut, walk-forward efficiency,
parameter-stability check) is engineered specifically to **detect and reject
exactly this failure mode**. So when you ask "couldn't this work with more
tuning?", the methodology's answer is "if it needs more tuning to clear the
gate, it has, by definition, already failed the gate — because the gate
penalizes tuning."

## Mechanism — three formulas that say the same thing

### 1. The Harvey-Liu-Zhu Bonferroni haircut

You test M parameter combinations. Each is implicitly a hypothesis test at
significance level α. The probability that *at least one* false positive
survives is roughly `α × M`. To control family-wise error rate, your t-statistic
has to clear:

```
t_required(M, α) = Φ⁻¹(1 − α/M)
```

| M (trials) | t_required at α=0.05 |
|---|---|
| 1 | 1.96 |
| 10 | 2.81 |
| 100 | 3.48 |
| 1,000 | 3.89 |
| 17,496 | 4.55 |
| 100,000 | 4.42 |

**Read this as:** if you swept 17,496 parameter configurations (e.g. VB-VE's
sister-project sweep), your "winning" configuration's t-statistic has to be
above **~4.55** before you've cleared the noise floor. Most strategies in
the public literature sit around t = 1.5–2.5. Sweep-tuning a strategy from
"looks like noise" (t ≈ 1) to "looks profitable" (t ≈ 2) **doesn't move
you closer to the threshold — it moves you further from it**, because the
threshold is rising with M faster than your t-stat is rising with each
additional sweep.

### 2. The deflated Sharpe ratio

Bailey-LdP define DSR as the standardized distance between observed Sharpe
and expected best-of-M Sharpe under a null:

```
DSR = Φ( (SR̂ − E[max(SR)]) × √(T−1) / σ )

where E[max(SR)] ≈ (1 − γ) × Φ⁻¹(1 − 1/M) + γ × Φ⁻¹(1 − 1/(M·e))
γ = Euler-Mascheroni ≈ 0.5772
```

For M = 17,496 and N = 252 trading days, `E[max(SR)] ≈ 3.7`. That's the
*expected* best Sharpe even under a null where every strategy in your
sweep has true Sharpe = 0. So your observed Sharpe has to clear ~3.7 just
to be *distinguishable from noise* under that sweep cardinality. A reported
"PF = 3.15" sweep-tuned strategy is nowhere close to that bar.

### 3. The probability of backtest overfitting (PBO)

López de Prado et al. (2014) define PBO as the probability that the
strategy you selected as "best" in-sample will underperform the median
out-of-sample. The formula uses combinatorially symmetric cross-validation
(CSCV) — split the sample into S blocks, generate `C(S, S/2)` train/test
combinations, and count how often the in-sample winner is below the OOS
median.

**Empirical fact** (AFML §11, Table 11.1): in financial datasets, PBO
crosses 0.5 (worse than coin-flip) when M ≳ 100 and crosses 0.8 once
M ≳ 1,000 — even for *real* strategies. Sweep-tuning past those
cardinalities makes the OOS performance close to **anti-correlated** with
in-sample performance. You're literally selecting the strategies most
likely to fail.

## Empirical receipt — what happened in this project

### `mr_v1/p=14` — the right kind of "passing"

- Parameter source: declared ex-ante (Wilder 1978 canonical RSI period)
- Implicit M ≈ 1 (no sweep — one number was committed before testing)
- HLZ bar: ~1.96
- Parameter-stability check (ADR-028): PASSED — `p ∈ {12, 14, 16}` all
  profitable; the result isn't a knife-edge spike at exactly 14
- OOS verdict: PRESERVES at deployable threshold across mr_v1 / equity arc
  (ADRs 027–031)

The reason this passes is **structural**, not accidental: the parameter
was committed before the experiment, so M = 1, so the haircut is mild,
so a meaningful Sharpe → meaningful DSR → meaningful t-stat.

### `volume_breakout_v1` — the wrong kind

- Parameter source: swept across `{5, 10, 30, 50}` × 4 timeframes × 4 universes
  = 23 cells scored
- Implicit M ≈ 23
- HLZ bar: ~3.18
- Best cell (mcap_nano / 1d / p=5):
  - In-sample: +622%
  - **Out-of-sample: −11.3%**
  - Walk-forward efficiency: −0.02 (worse than coin flip)
  - DSR: 0.88, PBO: 0.06, HLZ check: passed barely
  - Final gate: **REJECTED**

This is the diagnostic signature of overfitting: **massive IS gap, OOS
inversion, parameter knife-edge**. The +622% / −11.3% gap is doing all
the work the methodology is designed to detect.

### What "more tuning" would do

If you ran another 100 parameter configurations on top of these 23 (say,
finer granularity on the volume threshold and breakout-bar combinations),
you would, with very high probability:

1. Find a new "winner" with even higher in-sample profit.
2. Push M from 23 to 123, raising the HLZ bar from 3.18 to ~3.55.
3. Find that the new winner's OOS is still negative (PBO ~0.85 by now).
4. The DSR computation would deflate the new in-sample Sharpe by `E[max(SR)]`
   that grew from ~2.7 to ~3.4 — i.e., the new "improvement" gets
   immediately taxed away.

Net result: **you spent compute and analyst time, the in-sample number
got bigger, the OOS number didn't move, and the deflated metric got
worse**. This is the trap.

## Why "tune more" feels right but isn't

The temptation has a real cognitive logic:

1. *Strategy looks bad in-sample under default parameters.*
2. *I tune; strategy looks better in-sample.*
3. *Therefore tuning improved the strategy.*

The correct chain is:

1. *Strategy has real Sharpe SR_true (unknown).*
2. *Each parameter test draws a noisy estimate SR̂_i = SR_true + ε_i, where
   ε_i is mean-zero Gaussian-ish.*
3. *I select max_i SR̂_i = SR_true + max_i(ε_i).*
4. *max_i(ε_i) grows with M as `√(2 log M)`, so the more I tune, the more
   of my "improvement" is just the running maximum of pure noise.*
5. *Out-of-sample, ε_i is redrawn independently, so the cherry-picked
   max ε vanishes — and OOS performance reverts toward SR_true.*

Step 4 is the part that breaks the intuition. Selecting a maximum from
noisy draws *guarantees* an inflated estimate even when there's no real
signal — and the inflation grows with how hard you tune.

## Failure mode of *this* teaching

The temptation to "just tune more" is psychologically powerful because the
in-sample numbers are immediate and concrete (you can see the +622%) while
the OOS reality is abstract and delayed (you have to wait for new data
or trust the CSCV simulation). When the gap finally bites in production,
it's experienced as bad luck, not a foreseeable consequence of the method.

This is why systematic traders who survive long-term **internalize the
rule before they have personally lost money to it**: by the time the
market teaches you, you've already lost the money. The whole point of
the López de Prado framework is to teach the lesson cheaply — through
formulas — so you don't have to learn it expensively.

The corollary: when the methodology says "this strategy has been tuned
enough to lose its informativeness," the right move is **not** "tune in
a different direction" — it's **"accept the rejection and try a
different hypothesis."** The hypothesis "VB makes money on Solana
microcaps" was tested rigorously and rejected. That's a real result.
The hypothesis "VB-VE with KER/VWR/AVVC pre-breakout detection makes
money on Solana microcaps" can also be tested rigorously, but the
prior probability of survival is very low because (a) the related VB
hypothesis already failed and (b) VB-VE was selected via a 17,496-config
sweep so its starting HLZ deficit is enormous.

The **right** next move when a hypothesis is rejected is "what else
might be true?" — explore breadth (different asset classes, different
strategy archetypes) rather than depth (more tuning of the rejected
strategy). That's Bergstra-Bengio §3's actual lesson: random search of
the *hypothesis space* beats exhaustive grid search of the *parameter
space* of one hypothesis. The project's "wider not deeper" rule comes
from there.

## The one legitimate use of parameter exploration

Pardo (2008) §10 makes a careful distinction between *tuning* (choose the
single best parameter from a sweep, treat as discovery) and *robustness
testing* (sweep parameters as a check on whether your hypothesis is a
knife-edge or a plateau). The latter is fine and necessary — it's how
you confirm your declared-canonical parameter isn't accidentally on a
fragile spike. The former is the failure mode this teach-doc is about.

The signature of legitimate robustness testing:

- Parameter is declared **before** the test.
- Sweep is run **after**, only to check stability around the declared point.
- Final selection is **the originally-declared parameter**, not the
  sweep winner — even if sweep finds something that looks better.
- Stability is reported (e.g. "performance is positive across `p ∈ [12, 18]`,
  with deflation toward p > 25 and p < 8").

The signature of illegitimate tuning:

- Parameter is **chosen by the sweep**.
- The "best" cell is reported as the strategy.
- M is not declared, the HLZ haircut is not applied, DSR is not computed.
- Robustness is implicitly assumed because the sweep "found something."

The first is part of the validation gauntlet. The second is what causes
real-money losses.
