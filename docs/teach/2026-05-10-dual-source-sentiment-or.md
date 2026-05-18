# Dual-source sentiment extremes — why OR, not AND, not two categories

> Source citations: Whaley (2009) *Understanding VIX* §3 (term-structure
> semantics); CBOE methodology bulletin on put/call ratio interpretation;
> Aronson (2006) *Evidence-Based Technical Analysis* ch. 6 (data-mining
> bias warning that informs the "fewer features robustly" principle).
> Context: session 39 turn 1, phase1_v3 SPEC §2.1 and the user's
> "use both CBOE and VIX/VIX3M" direction.

## Intuition

When you want to know if the options market is positioned extremely,
you can ask two questions:

1. **Are traders buying lots of puts relative to calls?** (CBOE put/call
   ratio.) High = fear. Low = complacency. Both extremes have historically
   marked turning points — fear extremes near bottoms, complacency extremes
   before tops.
2. **Is the VIX curve unusually flat or inverted?** (VIX/VIX3M ratio.)
   Front-end vol > back-end vol (ratio > 1) = current panic. Front-end
   << back-end (ratio ≤ 0.80) = extreme calm, contango selling itself, the
   "no one is hedging" signal. (Initial threshold was 0.85; recalibrated
   to 0.80 in session 40 by quantile matching against the empirical
   `vix_term_ratio` p05 — see `VIX_TERM_COMPLACENCY_FLOOR` docstring in
   `src/server/macro_regime_v3.ts`.)

These two questions measure different things. Put/call is *positioning*
(what did traders actually do today). VIX/VIX3M is *expectations* (what
forward-vol levels does the market price). They can disagree — put/call
can be elevated while VIX/VIX3M stays mid-range, and vice versa. So one
signal that fires on either is more robust than one signal that requires
both.

The user's framing — "use both CBOE and VIX/VIX3M" — could have meant any
of three things. We picked the OR-into-one-category design because it's
the smallest hypothesis that uses both: two independent sources of
evidence, one regime flag. The two alternatives (AND-into-one-category,
two-separate-categories) were rejected for specific reasons below.

## Mechanism

The phase1_v3 `sentiment_extreme` category fires when ANY of these is
true:

```
put_call_5d_ma >= 1.15        (extreme fear, CBOE)
put_call_5d_ma <= 0.65        (extreme complacency, CBOE)
vix_term_ratio <= 0.80        (extreme front-end vol crush, VIX/VIX3M;
                               was 0.85 — see §"Failure mode" below for
                               why it was retuned)
```

In code (`src/server/macro_regime_v3.ts`):

```ts
const put_call_fires =
  put_call_5d_ma !== null &&
  (put_call_5d_ma >= PUT_CALL_FEAR_HIGH || put_call_5d_ma <= PUT_CALL_COMPLACENCY_LOW);
const vix_term_fires =
  vix_term_ratio !== null && vix_term_ratio <= VIX_TERM_COMPLACENCY_FLOOR;
return put_call_fires || vix_term_fires ? 1 : 0;
```

When CBOE data is missing (NULL `put_call_5d_ma`), the VIX/VIX3M path
alone keeps the indicator alive — fail-soft. When VIX data is missing,
the put/call path alone fires. When both are missing, the category
returns 0 (cannot determine).

The category contributes 1 to `categories_firing` if it fires today, and
1 to `categories_firing_5d` if it fires on any of the trailing 5 trading
days. Same rolling-union semantics as every other category in the v2/v3
engine.

## Why not the alternatives

### AND-into-one-category — REJECTED

`fires only if BOTH put_call AND vix_term_ratio show extremes`.

Why we didn't: AND is the *strict* combination — both sources must agree.
That sounds safer (fewer false positives) but it has a hidden failure
mode: when one of the data sources is missing or stale, AND collapses to
0 even if the present source is screaming. Specifically:

- CBOE put/call has historical sparsity pre-2008 and CBOE has changed its
  CSV URL twice in the last decade. AND under put/call missing → category
  permanently silent until ingest is repaired.
- VIX/VIX3M is rock-solid since 2007-12-04 but a single missing day during
  an outage would silence the indicator under AND.

OR is the fail-soft choice that matches how `sentiment_extreme` is
*meant* to function — "anything telling us positioning is stretched."

### Two separate categories — REJECTED

`put_call_extreme` and `vix_term_complacency` as two of the seven
categories.

Why we didn't: This doubles the indicator's contribution to the
composite count when both fire simultaneously, which is double-counting
the same underlying phenomenon (positioning is stretched). The composite
engine (`categories_firing >= 4` for red) is calibrated against the
intent "4 distinct phenomena are present." Two sentiment flags would
make a red regime achievable with effectively 3 phenomena +
double-counted sentiment — silently lowering the red bar without a
deliberate threshold tune.

Also: Aronson §6 specifically warns against expanding the feature set
without a confirmed predictive benefit ("more features ≠ better
classifier; more features = more degrees of freedom for overfitting").
Splitting one phenomenon into two flags is precisely that anti-pattern.

The disciplined version is: one category, two independent firing paths.

## Failure mode

What this design ASSUMES:

1. **The two sources are not perfectly correlated.** If they were, OR
   would be pointless (just pick one). The Whaley 2009 framing supports
   their independence — put/call measures realized positioning, VIX/VIX3M
   measures forward-vol expectations. They diverge during specific
   episodes (the "no one is hedging" silent complacency periods have low
   VIX/VIX3M without elevated put/call buying).
2. **OR doesn't produce too many false positives.** A single source
   firing is enough. This is fine when the indicators are well-calibrated
   (extreme thresholds, not casual ones) — but if either threshold is too
   loose, OR will fire often. Initial picks (1.15 / 0.65 / 0.85) were
   conservative Tier 0; the VIX/VIX3M floor was retuned to 0.80 in
   session 40 (see "Compressed VIX regimes" below). Post-tune the
   put/call thresholds remain Tier 0 — they are not yet stress-tested
   because CBOE ingest is still empty.
3. **The 5-day moving average on put/call is enough to filter noise.**
   Raw daily put/call is volatile. The 5d MA matches CBOE's own
   smoothing convention. If the post-fixture calibration shows the 5d MA
   is too laggy (missing fast vol regimes), drop to 3d or raw.

What can break this:

- **CBOE data drift.** If CBOE renames the file or moves the endpoint and
  the operator doesn't notice, put/call goes silent and the classifier
  runs degraded (VIX/VIX3M-only). The `INPUTS_MISSING_PUT_CALL` bit flag
  in `inputs_missing` is the operator-facing surface — check it on
  recent rows to detect silent degradation.
- **Compressed VIX regimes** (this is what happened — see follow-up
  below). If VIX/VIX3M trades in a permanently low range (e.g., post-2020
  low-vol regime), the complacency floor at 0.85 might fire too often.
  Adjust the floor as a separate threshold tune if the post-fixture
  diagnostic shows >5% of days firing on this path alone in calm
  periods.
  **Session 40 follow-up:** the predicted failure mode materialized —
  at floor=0.85 the arm fired on 25.77% of all phase1_v3 days
  (CBOE empty, so the arm was firing alone). Recalibrated to 0.80 by
  quantile matching: empirical p05 of `vix_term_ratio` on the
  2008-present corpus is 0.7959, so 0.80 is the smallest 2-decimal
  floor at or above p05. Post-tune prevalence is 5.98%. Note: the
  5% target is the empirical quantile, not Whaley 2009 §3 (Whaley
  motivates "extreme tail" framing but doesn't prescribe a specific
  prevalence). Citation honesty matters per the Vector Core sourcing
  rules.
- **Persistent CBOE extremes.** If put/call stays above 1.15 for weeks
  (extended fear regime), `sentiment_extreme` is stuck-on. That's not
  wrong — it IS extreme — but it does reduce the indicator's marginal
  information content during the persistence. The rolling-5d union
  semantics in the engine partly mitigate this (the category contributes
  the same to categories_firing_5d whether it fired 1 day or all 5).
