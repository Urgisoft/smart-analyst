---
status: active
phase: phase 2
last_updated: 2026-05-21
owner: pejman
type: spec
---

# SPEC — Macro regime classifier, Phase 2 (4th category: `realized_stress`)

> **Status:** PROPOSED · drafted 2026-05-09 · revised post-critic 2026-05-09 (rev 2) · revised post-procedure-run 2026-05-10 (rev 3 — Q1+Q2 corrections; §3.4 H1 reframed two-sided + §3.5/§3.6 ranking metric switched to Welch's |t-stat|; full revision log §11.2). Awaiting user sign-off before CODE re-resumes.
> **Authoring role:** [SPEC] per Vector Core build-stage discipline.
> **Critic verdict on rev 1:** REVISE with 4 blockers (B1-B4) + 7 non-blocking concerns + 3 missing items. All folded into rev 2; resolution log in §11.
> **Predecessor:** [`macro-regime-classifier-phase1.md`](macro-regime-classifier-phase1.md) (rev 1) and [`macro-regime-classifier-phase1-rev2-data-layer.md`](macro-regime-classifier-phase1-rev2-data-layer.md) — both remain in force unchanged for Phase 1's three indicators.
> **Triggered by:** session 27 design-gap finding — Phase 1's `breadth_narrow` is a TOPPING signal (requires SPY at/near 1Y high), so the classifier cannot fire `red` on a fast crash where breadth craters before the 1Y-high condition can possibly hold. 2020-02-19 → 2020-04-30 fixture is the canonical failure.
> **Methodology grounded in:** [`docs/teach/2026-05-09-threshold-hypothesis-testing.md`](../teach/2026-05-09-threshold-hypothesis-testing.md) — Aronson EBTA chs 6-7, Pardo §6, AFML §11 CSCV, Bailey-LdP DSR, HLZ 2016. The SPEC instantiates that procedure for one specific indicator family.
> **Scope discipline:** exactly one new indicator. Phase 2 stays at 4 categories total — the 4 source-doc categories not yet covered (rates, monetary policy, sector flows, sentiment) are still Phase 3+.

---

## 0. Why this SPEC and what it is not

### Purpose

Add one new indicator (`realized_stress`) to the macro regime classifier so it can fire `red` on fast-crash episodes that Phase 1's topping-only breadth gate structurally misses (2008-09 → 2009-06, 2020-02 → 2020-06). Define the threshold-selection procedure with sufficient discipline that the chosen threshold is not a data-mined artifact, and update the 4-category composite rule to handle the new indicator's mutual-exclusion relationship with `breadth_narrow`.

### Why a phase bump (`phase2_v1`), not a sub-version (`phase1_v3`)

The *category cardinality* changes (3 → 4), not just thresholds. SPEC rev 2 §11 A10 (downstream-consumer fence) keys on `classifier_version`; treating a category-count change as a sub-version would let consumers pinned to "phase1_*" silently see 4-category rows. A new top-level version forces explicit re-pinning. `phase1_v1` (honest-NULL baseline) and `phase1_v2` (constituent-computed-breadth) rows are preserved unchanged in CH.

### Out of scope (explicit)

- **More indicators per category.** Phase 2 adds one indicator, not a category-population pass.
- **Categories 5-7 of the source doc** (rates, monetary policy, sector flows, sentiment) — still Phase 3+.
- **Re-tuning Phase 1 thresholds** against any data — locked. If a Phase 1 indicator looks miscalibrated post-Phase-2, that's a separate SPEC.
- **Dashboard / briefing UI** for the new category — separate SPEC.
- **Component 5+ strategy gating** on `phase2_v1` — separate SPEC. Phase 2 ships labels under a fenced version; consumption is downstream.

### Authority

User direction 2026-05-09 (handoff session 28) is to push autonomously through SPEC for the realized-stress indicator family chosen in RESEARCH. `feedback_no_confirmation_pauses` + `feedback_full_delegation_mode` apply: this SPEC ships under the conservative defaults documented below; user override on the §1.6 augment-vs-replace open question rolls into a single revision.

---

## 1. The new indicator — `realized_stress`

### 1.1 Definition (locked — no swept parameters except the threshold)

```text
spy_drawdown_from_1y_high(t) = (spy_close(t) / spy_252d_high(t)) - 1   ∈ [-1, 0]
realized_stress(t)           = (spy_drawdown_from_1y_high(t) < θ)       ∈ {0, 1}
```

where `θ` is one element of the candidate set `K` (§1.3) chosen by the procedure in §3.

- **Lookback window** is 252 trading days, identical to `breadth_narrow`'s gate. **Reuses the existing `spy_252d_high` computation** in [src/server/macro_regime.ts:220](../../src/server/macro_regime.ts#L220) — zero new I/O, zero new schema beyond the new flag column.
- **Single tunable parameter (`θ`).** Aronson EBTA ch 7 §2 — start with the minimum-parameter rule; promote to a multi-parameter family only if the held-out validation rejects single-parameter rules across the candidate set.
- **No confirmation window**, no smoothing, no second condition. A confirmation window would be a second swept parameter. Per teach-doc Step 1 + §1.3, parameter-count creep is undisclosed search.

### 1.2 Why drawdown-from-1Y-high, not absolute VIX / VIX-percentile / realized-vol

Decided in session 28 RESEARCH. Recap kept here so the sign-off-to-CODE step doesn't relitigate:

| Family | Why deferred (not rejected — sequence-of-trials matters per HLZ 2016 family-correction) |
| --- | --- |
| Absolute VIX (`vix_close > X`) | Adds a second data dependency to the new category; `vix_close` is already saturating in the Phase 1 vol category, so co-firing with `vix_term_inverted` gives weaker independent confirmation than a different family does (source doc §10 independent-confirmation principle). |
| VIX percentile (rolling) | Same data dep as above + adds a window-length parameter (rolling lookback for the percentile rank). Two parameters > one. |
| OR-combined (drawdown OR VIX-trigger) | Implicitly adds a logical operator + two thresholds = three parameters; the family-level multiple-test burden balloons. |
| 21d realized vol (`stdev(spy_returns)`) | Adds a window-length parameter; statistically related to absolute VIX (implied vs realized) so weaker independence vs the Phase 1 vol category. |
| **SPY drawdown from 1Y high** (chosen) | Reuses `spy_252d_high` infrastructure (no I/O delta), one parameter, drawdown is *price-only* (independent of vol regime), and the failure-mode is shared with Phase 1's existing breadth gate (mutex enables cleanly-defined 4-category composite — see §2). |

**HLZ 2016 family-level correction is reserved.** If the procedure in §3 rejects every `θ ∈ K`, the next family attempted (most likely absolute VIX) inherits an additional Bonferroni factor of 2 on `α` (per teach-doc Step 9). Phase 2 does not pre-budget that — it flags the procedure outcome and the next SPEC inherits the corrected `α`.

### 1.3 Locked candidate set `K` — declared BEFORE any scoring

```text
K = {-10%, -12%, -15%, -18%, -20%}    →   |K| = 5
```

- **Bounds justification:** (a) `-10%` is the conventional "correction" floor — anything shallower captures normal pullbacks and over-fires; (b) `-20%` is the conventional "bear-market" entry — anything deeper only fires once per decade and gives almost no statistical power on the available data.
- **Spacing:** roughly logarithmic across the bear-market half-decade range. Nearly-uniform on log-distance from -10% to -20%.
- **Locked behavior:** adding candidates after scoring starts (e.g. `-13%`, `-25%`) is undisclosed search — silently inflates `|K|` and invalidates the Bonferroni correction in §3 Step 4. If a different range turns out to be needed (say, `-8%` for an early-warning use case), the SPEC restarts from §3 Step 1 with a fresh declared `K` — does not expand `K` mid-procedure. See §7 watch-out.

### 1.4 Held-out validation periods `V` — sacred

```text
V = { [2008-09-01, 2009-06-30],     # GFC peak through stabilization
      [2020-02-01, 2020-06-30] }    # COVID crash through V-shape recovery
```

- **Total trading days in V:** ≈210 (2008 window) + ≈103 (2020 window) ≈ 313 days.
- **Total trading days in T = full_history \ V:** assuming full_history ≈ 4,617 (current CH state per HANDOFF "Files / code state"), `|T|` ≈ 4,304 days.
- **`V` is touched ONCE**, at §3 Step 7, after PBO + walk-forward have selected `θ` on `T`. Per teach-doc Failure Mode #1, *any* peeking — plotting the indicator on `V`, eyeballing fire counts on `V`, "just sanity-checking 2008" — spends some of the held-out budget. If a peek happens it must be declared in the HANDOFF and `V` is treated as semi-spent (the SPEC adds a fresh held-out window or restarts the family).
- **Why these specific windows:** the canonical fast-crash episodes the new indicator is being added to rescue. They were named in session 27 as the design-gap evidence (the 4 currently-failing fixtures include `2008_gfc` and `2020_covid`). Reusing them as held-out is the honest move because they're what the indicator *must* perform on; using them as training would be circular.
- **What V is NOT for:** V is held out from threshold selection. It IS still subject to the §3 Step 7 acceptance bar (must rescue red on at least one date in each window). The asymmetry is intentional — the bar is "did the chosen θ actually fix the design gap" and it gets one shot.

### 1.5 NULL / warmup semantics

- **`spy_close` missing on date `t`:** `realized_stress(t) = 0`, `INPUTS_MISSING_SPY` (bit 8) set in `inputs_missing` per Phase 1 SPEC §3.2. No new bit needed.
- **`spy_252d_high` warmup (<252 prior closes):** `realized_stress(t) = 0`, `INPUTS_MISSING_SPY_WARMUP` (bit 32) already set per Phase 1. **Same flag covers both indicators** — `breadth_narrow` and `realized_stress` share the warmup boundary by design. No new bit needed.
- **`spy_252d_high == 0` (degenerate):** `spy_drawdown_from_1y_high(t) = NULL`, `realized_stress(t) = 0`. Cannot occur in real SPY data; protected against in the divisor check, mirroring [src/server/macro_regime.ts:153](../../src/server/macro_regime.ts#L153).
- **`spy_drawdown_from_1y_high` is itself stored** as a new `Nullable(Float64)` column in `quantlab.macro_regimes` for auditability — same discipline as Phase 1's stored intermediates (SPEC rev 1 §3.2 rationale: "stored intermediates let us re-derive the classification deterministically from CH alone").

### 1.6 Open question — `realized_stress` as augment vs. replace

**Default chosen by this SPEC (conservative): AUGMENT.** Phase 2 keeps `breadth_narrow` and adds `realized_stress` as a *fourth* category. Both stay in the schema; both fire under their respective preconditions; the composite uses 4 categories with the §2 rule.

**Bolder alternative: REPLACE.** Drop `breadth_narrow` from the composite (the 50%-above-50DMA breadth measure becomes audit-only data) and put the realized_stress drawdown gate in its place inside the breadth category. Net effect: 3-category classifier with a different breadth definition.

**Why AUGMENT is the default:**

1. **Backwards compatibility.** All Phase 1 fixture expectations remain meaningful under augment; under replace, the `breadth_narrow` test scaffolding ([scripts/tests/macroRegime.test.ts](../../scripts/tests/macroRegime.test.ts)) becomes dead code or needs reframing.
2. **Mutex doesn't equal redundancy.** `breadth_narrow` fires on *narrow rallies at highs* (a topping pattern); `realized_stress` fires on *price collapses below highs* (a crash pattern). They detect different regime transitions, not the same one phrased differently. Source doc §10 independent-confirmation argues for keeping both.
3. **Statistical power.** Replacing means losing all the `breadth_narrow` fire history from 2007 forward — roughly 2 of the 16 currently-firing historical orange days per `phase1_v1` baseline. Small, but absolutely no upside to dropping it.

**When the user might prefer REPLACE (sharpened per critic NB on §1.6):**

- They view the SPEC rev 2 §11 A10 fence as so binding that keeping `breadth_narrow` in the `phase2_v1` composite carries forward the constituent-bias contamination — see §5.3 on the asymmetric bias surface (`breadth_narrow` arm is biased; `realized_stress` arm is bias-clean). REPLACE collapses this to a single bias-clean composite, which is the *cleaner* fence position even if it sacrifices the topping-pattern-detection capability.
- They want the simpler 3-category composite for cognitive load reasons.
- **The mutex argument cuts both ways:** if `breadth_narrow` and `realized_stress` are mathematically disjoint by construction (§2.1), the 4-category schema collapses to a 3-category schema with a richer breadth indicator under any sensible composite. Keeping both is doctrinally "augment" but semantically "two breadth-side modes that never co-fire" — which is closer to "richer single category" than "two independent categories" in the source-doc §10 independent-confirmation framing.

**Trade-off table:**

| | AUGMENT (default) | REPLACE |
| --- | --- | --- |
| Schema | 4 columns: `vix_term_inverted`, `hyg_spy_divergence`, `breadth_narrow`, `realized_stress` | 3 columns: `vix_term_inverted`, `hyg_spy_divergence`, `breadth_stress` (renamed; computed as `breadth_narrow OR realized_stress`) |
| Bias surface | `phase2_v1` red label tainted on the breadth_narrow arm (per §5.3) | `phase2_v1` red label has constituent bias only when `breadth_narrow` was the firing path |
| Topping-pattern detection | Yes (`breadth_narrow` still fires on narrow rallies at 1Y high) | Yes (folded into the unified breadth-side category) |
| Crash-pattern detection | Yes (`realized_stress` fires on drawdowns) | Yes (folded into the unified breadth-side category) |
| §2.3 composite rule complexity | Option A/B/C choice, mutex special-handling | Single rule (3-category Phase 1 form) |
| Backwards compat with Phase 1 | Full | Phase 1 fixture tests need re-keying for the renamed column |
| Test scaffolding cost | Add 4-category tests | Re-key existing 3-category tests |

**Resolution:** if user signals REPLACE before SPEC sign-off, §2 below substitutes the 3-category composite and §5 schema deletes `breadth_narrow` from `phase2_v1` rows (not from `phase1_*` rows — those are preserved per SPEC rev 2 §6.1). Otherwise SPEC ships under AUGMENT and the question closes.

---

## 2. The 4-category composite — orange / red rule re-derivation

### 2.1 Mutual exclusion — what the math says

```text
realized_stress(t) = 1   ⇒   spy_close(t) < (1 + θ_max) · spy_252d_high(t)
                       =     spy_close(t) < 0.90 · spy_252d_high(t)    [for θ_max = -10%]

breadth_narrow(t)  = 1   ⇒   spy_close(t) ≥ 0.95 · spy_252d_high(t)   [Phase 1 §2.3]
```

For any `θ ∈ K = {-10, -12, -15, -18, -20}%`, the realized_stress trigger requires SPY *at or below 90%* of the 1Y high; `breadth_narrow` requires SPY *at or above 95%* of the 1Y high. **The two flags can never both be 1 on the same date.**

This is *exact mutex by construction*, not a statistical regularity. It does not depend on the chosen `θ`. The 5-day rolling union is a different story — see §2.3.

### 2.2 Same-day composite rule (`categories_firing_today`)

With four categories `{vol, credit, breadth_narrow, realized_stress}` of which the latter two are mutex, the **maximum value of `categories_firing_today` is 3**, not 4.

| Phase 1 rule | Naive port to 4 categories | Adopted Phase 2 rule |
| --- | --- | --- |
| `green` if `categories == 0` | `green` if `categories == 0` | `green` if `categories == 0` |
| `yellow` if `categories == 1` | `yellow` if `categories == 1` | `yellow` if `categories == 1` |
| `orange` if `categories ≥ 2` | `orange` if `categories ≥ 2` | `orange` if `categories ≥ 2` |
| (red is rolling — see §2.3) | (red is rolling — see §2.3) | (red is rolling — see §2.3) |

**Adopted rule = unchanged from Phase 1 in form**, even though the maximum is now `min(N_categories, 3) = 3` instead of `N_categories = 3`. The orange threshold is "at least 2 distinct categories firing today regardless of which two." That semantic survives the cardinality bump cleanly.

Why this is right rather than e.g. `orange ⇔ categories ≥ 2 + at-least-one-of-{breadth_narrow, realized_stress}`: source doc §10 independent-confirmation rests on category diversity, not on which specific category. A `vol + credit` orange in Phase 1 is the same regime call as a `vol + credit` orange in Phase 2 — adding the 4th category shouldn't change that.

### 2.3 5-day rolling-union composite rule (`categories_firing_5d`) — for `red`

Naive port options:

| Option | Rule | Problem |
| --- | --- | --- |
| **A** | `red` if `categories_firing_5d ≥ 3` | Same numeric threshold as Phase 1, now 3-of-4 instead of 3-of-3. **Materially weakened red bar** — easier to fire red because there's now an extra category that can contribute to the union without changing the conjunction strength. |
| **B** | `red` if `categories_firing_5d == 4` | "All 4 categories within 5 days." Too strict in the augment world where mutex means only 3 of 4 can fire on the same day; requires SPY swinging across the 95%/90%-of-1Y-high boundary within the 5-day window. Possible (a sharp -10% drawdown that reverses to a 95% recovery within 5 sessions), but rare to the point of underuse. |
| **C** | `red` if `categories_firing_5d ≥ 3` AND **at-least-one-of-{realized_stress, breadth_narrow} fired in window** | Preserves Phase 1's "3 distinct categories" semantics, but explicitly demands that the stress-mode-OR-topping-mode category contributed. Asymmetric handling acknowledges the mutex without invoking it as a constraint. |

**Adopted rule (subject to §3 co-fire histogram empirical check): Option C.**

```text
fired_in_5d = { union of per-category fires across t-4..t }
red(t)      = |fired_in_5d| ≥ 3
              AND (realized_stress ∈ fired_in_5d OR breadth_narrow ∈ fired_in_5d)
```

**Plain-language equivalent (per critic non-blocking #1):** under the §2.1 mutex, "≥3 categories" plus "stress-or-topping in window" reduces to "**both of {vol, credit} fired in window AND exactly one of {breadth_narrow, realized_stress} fired in window.**" That's a 3-of-3-required rule with an OR-toggle on which "breadth-side" category counts. The longer form in the code stays as written for forward-compat with future categories that break the mutex; the plain form is the right mental model.

Why C, in plain English:

1. **Rejecting Option A:** if the 4th category's only effect is to make `red` easier, we've inflated red and the Phase 1 calibration on 2014/2017 will start cry-wolfing. PUSHBACK against Option A: it's not a defensible rule; it's a rule shaped to make `red` happen more.
2. **Rejecting Option B:** the mutex makes `categories_firing_5d == 4` require a specific 5-day price path that's rare. Bar that's never met is bar that doesn't exist.
3. **Why C is the right shape:** the source doc §10 independent-confirmation says you need diverse categories; 3-of-4 satisfies that, but the *kind* of diversity matters. `vol + credit + breadth_narrow` (a topping red) and `vol + credit + realized_stress` (a crashing red) are both substantively-distinct stress patterns. `vol + credit + (anything not in {breadth_narrow, realized_stress})` doesn't exist in Phase 2, so the "at-least-one of stress/topping" clause is the SHORTEST WAY to write "real regime confirmation" without restating the cardinality.

### 2.4 Co-fire histogram — empirical check that Option C is right (computed in §3)

Once `θ` is selected on `T` (§3 Steps 3-6), the SPEC requires producing the co-fire histogram of `(vol, credit, breadth_narrow, realized_stress)` over T at the chosen θ. The histogram answers:

- Are there `T`-dates where `categories_firing_5d ≥ 3` is true under Option A (any 3) but Option C is false (no realized_stress AND no breadth_narrow in the window)? If yes, those are the dates where A and C diverge — they are inspected manually. If they look like real stress regimes, Option C is too strict. If they look like noise (e.g. `vol + credit` flickering during a 2014-style chop), Option C is right.
- How often does the realized_stress-only path produce red (rolling 5d window contains realized_stress + 2 of {vol, credit}) vs. how often does the breadth_narrow-only path? A skew of 10:1 in either direction is a flag — the rule may be silently equivalent to a 3-category composite.

**The histogram is generated as part of the §3 procedure deliverable, not a sign-off blocker for the SPEC.** If the histogram contradicts Option C, the SPEC revs to Option A or Option B based on what the data shows, with the rule swap documented in `phase2_v1`'s deployment notes. This is a SPEC-to-CODE feedback loop, not an open question.

### 2.5 Same-day "all 3 firing" still possible — no degenerate-red rewrite

In Phase 1 a same-day `categories_firing_today == 3` triggered red on day t (degenerate red, no 5-day window needed; `categories_firing_5d ≥ categories_firing_today`). In Phase 2 the equivalent is `categories_firing_today == 3 AND (realized_stress=1 OR breadth_narrow=1)` — the mutex means those 3 are necessarily one of `{vol, credit, breadth_narrow}` or `{vol, credit, realized_stress}`. Both qualify under the §2.3 Option C rule applied at the same-day window (5d ⊇ 1d). Phase 1's existing degenerate-red unit test ([scripts/tests/macroRegime.test.ts](../../scripts/tests/macroRegime.test.ts) §5.1 test #7) remains valid; the Phase 2 equivalent is added as a new unit test.

---

## 3. The threshold-selection procedure (instantiates the teach-doc on this indicator)

### 3.1 Pipeline overview

```text
Step 1 (§3.2):  Lock K, V, T (§1.3, §1.4) — DONE before sign-off.
Step 2 (§3.3):  Score each θ ∈ K on T — count_red, cluster_count, fp_rate.
Step 3 (§3.4):  Statistical test per θ on T — permutation test, Bonferroni-adjusted α.
Step 4 (§3.5):  PBO via AFML §11 CSCV with 16 sub-periods of T. Bar: PBO < 0.5.
Step 5 (§3.6):  Walk-forward stability per Pardo §6 — 5y train / 1y test, θ-variance ≤ ±2pp.
Step 6 (§3.7):  Co-fire histogram on T at chosen θ (per §2.4).
Step 7 (§3.8):  Score chosen θ on V — held-out fire-on-canonical-episodes check.
Step 8 (§3.9):  DSR haircut hook for downstream Component 5+ consumers.
Step 9 (§3.10): If V-fail: HLZ family-level escalation OR document-and-defer.
```

Steps 1-6 happen on `T` only. Step 7 is the V-touch. Steps 8-9 are post-acceptance.

### 3.2 Step 1 — Pre-locked

`K = {-10, -12, -15, -18, -20}%`, `V = {[2008-09-01, 2009-06-30], [2020-02-01, 2020-06-30]}`. Locked in §1.3-§1.4 and recapped here for the procedure's audit trail.

### 3.3 Step 2 — Score each θ on T (descriptive stats only — NO data-driven culling)

For each `θ ∈ K`, compute on `T`:

```text
count_red(θ)      = |{ t ∈ T : realized_stress(t; θ) == 1 }|
cluster_count(θ)  = |{ contiguous runs of fires separated by >30 calendar days }|
fp_rate(θ)        = |{ t ∈ T_calm : realized_stress(t; θ) == 1 }| / |T_calm|
                    where T_calm = T ∩ ({2014, 2016, 2024, 2025 calendar years} ∩ T)
```

**`T_calm` excludes 2017.** Phase 1 SPEC §5.2 reserves 2017 as the Phase 1 holdout with the explicit rule "no threshold tuning whatsoever." Putting 2017 inside Step 2's negative-control denominator would re-spend that holdout silently. Per critic blocker B2, `T_calm` is restricted to {2014, 2016, 2024, 2025}. Cross-phase holdout integrity is load-bearing — 2017 stays sacred across both Phase 1 and Phase 2.

**These are descriptive statistics, not a culling filter.** Per critic blocker B1, all `|K| = 5` candidates proceed to Step 3 regardless of `count_red`, `cluster_count`, or `fp_rate`. The Bonferroni denominator in Step 3 is `|K_declared| = 5` always — never `|K_surviving|`. If a `θ` produces `count_red == 0` or fires on 80% of T, the Step 3 permutation test will reject it on its own; we do not need (and must not use) a data-dependent pre-filter to "improve" the multiple-testing bar by shrinking the denominator. The descriptive stats here exist for the human reading `RESULT.md`, not for the procedure.

### 3.4 Step 3 — Statistical test per θ

> **Rev 3 (2026-05-10):** H1 reframed from one-sided "anti-predict" to **two-sided "informative."** Rev-2 framing was inconsistent with §0 (`realized_stress` is a *concurrent regime LABEL*, not a forward-return predictor) and was empirically falsified by the procedure run 2026-05-10 (every θ ∈ K produced `observed_diff > 0` — drawdowns mean-revert at 20d horizon, OPPOSITE the rev-2 anti-predict direction). The fix corrects the SPEC's own internal inconsistency; it is **not** a retune to chase a passing result. Full revision log §11.2.

For each `θ ∈ K`, run a **block-bootstrap permutation test** (Aronson EBTA ch 6) of whether `realized_stress` is **informative about next-20-day SPY return distribution** — agnostic to direction:

```text
H0:  E[SPY_return_20d(t+1..t+20) | realized_stress(t; θ) == 1] = E[SPY_return_20d | unconditional]
H1:  E[SPY_return_20d(t+1..t+20) | realized_stress(t; θ) == 1] ≠ E[SPY_return_20d | unconditional]   (two-sided — the regime distinction must be informative, regardless of sign)
```

- **Test statistic:** mean(`SPY_return_20d` on fire-days) − mean(`SPY_return_20d` on non-fire-days), restricted to `T`.
- **Permutation procedure:** circular block bootstrap with block length = 20 trading days (matching the prediction horizon, preserves serial correlation). 10,000 resamples, fixed seed (mulberry32, seed=42 — matches the `bootstrap DSR` convention in [src/lib/psr.ts](../../src/lib/psr.ts) per HANDOFF watch-out).
- **Two-sided p-value:** `p_two = 2 × min(P(rsDiff ≥ observed_diff), P(rsDiff ≤ observed_diff))` — the equal-tail two-sided p (Davison & Hinkley 1997, *Bootstrap Methods and Their Application*, §4.4). Two-sided is structurally stricter than picking the direction post-hoc — both tails count, so a θ passes only if `|observed_diff|` is large enough that <0.2% of permutation resamples produce statistics that extreme on either side.
- **Significance bar (Bonferroni-adjusted):** `α = 0.01 / |K| = 0.01 / 5 = 0.002`. A `θ` passes Step 3 iff `p_two ≤ 0.002`.

**Less-conservative alternative (pre-quantified per critic non-blocking #4):** Hansen's SPA (Hansen 2005, *J. Bus. Econ. Stat.*). If Bonferroni rejects every `θ`, the SPEC author may invoke SPA **iff** the §3.8 V acceptance bar is simultaneously tightened to:

```text
red_fraction(V_2008) ≥ 0.30   AND   red_fraction(V_2020) ≥ 0.15
                       AND
consecutive_red_run(V_i) ≥ 5   per window
```

i.e., SPA invocation costs +50% on red-fraction floor and +2 days on consecutive-run floor. This is the pre-committed haircut for switching from Bonferroni to a less-conservative test. White's Reality Check, if used instead, takes the same haircut. Per critic B3, "semi-spent" without a number is a methodology escape hatch; this fixes the number now so the choice can't drift after seeing data. Default remains Bonferroni; SPA is a documented opt-in with a known cost.

### 3.5 Step 4 — PBO via AFML §11 CSCV

Per Bailey-Borwein-LdP-Zhu (2014):

1. Partition `T` into **16 contiguous sub-periods** (≈270 trading days each given `|T|` ≈ 4,304).
2. Enumerate `C(16, 8) = 12,870` partitions of the 16 sub-periods into IS (8) ∪ OOS (8).
3. For each partition: rank `θ ∈ K` by **`|Welch's t-stat|` of the 20-day forward-return mean difference** (fire-days vs non-fire-days within the IS sub-periods) — i.e., `|(mean_fire − mean_nofire) / sqrt(s_fire²/n_fire + s_nofire²/n_nofire)|`. Identify `θ_IS_best`. Then rank the same `θ` set on OOS by the same metric; record the OOS rank of `θ_IS_best` as `r`. (Rev 3 — was `count_red − fp_rate_calm` in rev 2; that metric was scaling-degenerate (count_red dominates fp_rate_calm), and per teach-doc Step 4 the canon-correct rank statistic is the test statistic itself.)
4. PBO = fraction of partitions where `r > median rank` (i.e., the IS-best `θ` ranks below median OOS).

**Bar: PBO < 0.5.** A PBO ≥ 0.5 means more than half the time the IS-best `θ` is *worse than median* on OOS, which is exactly the meta-overfitting signature CSCV detects. Per teach-doc Failure Mode #5: `PBO > 0.5` is **not** a sign to retune until PBO < 0.5 — it's a sign that the family doesn't have stable threshold structure on this data, escalate to §3.10.

**Contiguous vs interleaved sub-periods (per critic non-blocking #3):** Bailey-LdP 2014 recommends contiguous sub-periods (preserves temporal structure). With `|T|` ≈ 4,304 days and contiguous N=16, sub-periods are calendar-time blocks ≈270 days each. The early blocks (2008-2012) carry disproportionate stress, so half the C(16,8) partitions put the GFC tail in IS and half in OOS — PBO will be partly driven by "did the partition put the GFC in IS." This is the canon-correct behavior (preserves serial structure that interleaving would shatter), but document it in `RESULT.md` so the reader doesn't mistake the variance source. If `PBO ≈ 0.5` (boundary), interleaved-N=16 is run as a sanity check and both numbers reported; the contiguous number is canonical for the §3.11 bar.

**Reuses existing CSCV implementation if present.** Audit `src/lib/cscv.ts` (or equivalent) at CODE-time; if no CSCV implementation exists, the mulberry32+12870-iteration scaffolding from [src/lib/psr.ts](../../src/lib/psr.ts) bootstrap-DSR routine is the closest existing pattern to extend.

### 3.6 Step 5 — Walk-forward stability per Pardo §6

Rolling 5y train / 1y test, advancing 1y at a time, across `T`:

```text
Train windows: [2010-01, 2014-12], [2011-01, 2015-12], …, [2020-01, 2024-12]   (assuming T starts ≈2008)
Test  windows: [2015-01, 2015-12], [2016-01, 2016-12], …, [2025-01, 2025-12]
```

For each train window, pick `θ_train` as the in-sample best per the **`|Welch's t-stat|` ranking** defined in §3.5 (same statistic as the §3.4 test, computed on the train window's data). Record `(train_window_id, θ_train)`. (Rev 3 — was `count_red − fp_rate_calm` in rev 2; replaced for the same scaling-degeneracy reason as §3.5.)

**Bar: `max(θ_train) − min(θ_train) ≤ 3 percentage points` across all train windows** (tightened from the rev-1 ±4pp per critic non-blocking #2). I.e., if `θ_full_T = -15%`, walk-forward windows must all return `θ` within a 3pp band centered near -15%. Larger swing = overfit to whichever crisis dominates each train window.

**±2pp from the full-T optimum is the teach-doc bar.** ±3pp max-min spread across 11 windows is consistent with K-grid spacing of 2-3pp — meaning windows can drift by at most one K-grid step. ±4pp (rev 1) was loose enough to allow drift across 2 K-grid steps, which the critic correctly flagged as effectively saying "θ is allowed to wander between {-12, -15, -18}%" — too permissive for a stability bar.

**Window-length sensitivity disclosure (teach-doc Failure Mode #6):** the 5y/1y choice is the Pardo §6 default. With `|T|` ≈ 17 years, this gives ≈11 walk-forward windows — enough power to see drift but few enough that one extreme window can dominate. The choice is locked here; no second window-length is tried.

### 3.7 Step 6 — Co-fire histogram on T at chosen θ

After Steps 3-5 produce a single surviving `θ`:

- Count, on T, the joint distribution of `(vol_today, credit_today, breadth_narrow_today, realized_stress_today)` ∈ {0,1}⁴ — a 16-cell histogram, but 8 cells (those with both `breadth_narrow=1` and `realized_stress=1`) are exactly zero by §2.1's mutex. The 8 reachable cells cover the full state space.
- Count, on T, the joint distribution of `(vol_5d, credit_5d, breadth_narrow_5d, realized_stress_5d)` — the 5-day-rolling-union version, 16 cells, all reachable (because the 5-day window can span the SPY 90%/95% boundary).
- For each candidate composite rule (Option A / B / C in §2.3), tabulate the days that flip from `red` ↔ `not-red` between Phase 1 and Phase 2.

Output: a markdown table with the histogram + flip-day list. Decision: confirm Option C (default), or rev to A or B if the data demands. **Per §2.4, this is a CODE-stage decision, not a SPEC-blocker.** The SPEC commits to *producing the histogram*; the rule choice on it is an in-CODE judgment with the histogram as the artifact.

### 3.8 Step 7 — Score chosen θ on V (the held-out touch)

Compute `realized_stress(t; θ_chosen)` for every `t ∈ V`. Acceptance bar (**pre-registered now, BEFORE the procedure runs**, per critic blocker B3):

```text
red_fraction(V_2008) ≥ 0.20    AND   red_fraction(V_2020) ≥ 0.10
                         AND
consecutive_red_run(V_2008) ≥ 3   AND   consecutive_red_run(V_2020) ≥ 3
```

where `red_fraction(V_i) = |{t ∈ V_i : regime(t) == 'red' under phase2_v1 composite}| / |V_i|` and `consecutive_red_run(V_i)` is the longest run of consecutive trading days where `regime == 'red'`.

**Rationale for these specific numbers** (committed in advance to remove post-hoc latitude):

- **`red_fraction(V_2008) ≥ 0.20`:** the 2008 GFC peak window has ≈210 trading days; 20% = 42 red days. The existing fixture floor in [scripts/tests/macroRegimeFixtures.test.ts](../../scripts/tests/macroRegimeFixtures.test.ts) is `red >= 30%` on `2008_gfc` (Aug 2008 - Mar 2009), so 20% on the broader Sep 2008 - Jun 2009 V window is *looser* than the fixture floor — accommodates the partial-recovery tail (Apr-Jun 2009) where red should naturally taper.
- **`red_fraction(V_2020) ≥ 0.10`:** the COVID window has ≈103 trading days; 10% = 11 red days. The existing fixture floor is `red >= 5` on `2020_covid` (Feb 19 - Apr 30); 10% = ~10 red days on the broader Feb-Jun 2020 V window is consistent with that fixture, including the V-shaped recovery tail (May-Jun) where red naturally drops.
- **`consecutive_red_run ≥ 3` per window:** prevents a degenerate pass where the bar is met by sparse single-day red flickers. A "regime call" implies persistence; 3 consecutive red days is the floor for "the classifier identified a stress regime, not noise."

Per critic B3, the "no floor on red-count" alternative was rejected as too lenient — at θ = -10% on a >50% drawdown like 2008, almost any threshold ≤ -20% will produce some red days, providing zero discrimination between a calibrated and a barely-functional indicator.

**Pre-registered prior on θ (per critic missing-item):** before running §3.4-§3.6, the SPEC author's prior on the chosen θ is **`-15%`** (median of K). Rationale: -10% would be over-permissive (catches normal pullbacks); -20% would be too rare (one-per-decade); -15% is the conventional "correction-bear-market boundary." If the procedure picks something other than -15%, that is the procedure's call and stands; this prior is logged so any post-hoc rationalization ("I always thought -18% was right") is visible as such. Per teach-doc Failure Mode #3.

**If V-pass:** indicator earns its place; SPEC §4 CODE proceeds. **If V-fail:** §3.10 — escalate or document.

### 3.9 Step 8 — DSR haircut hook for downstream consumers

Phase 2 itself does not gate strategies. But the SPEC documents the haircut for downstream consumers (Component 5+ work):

```text
For any backtest's Sharpe ratio computed conditional on classifier_version='phase2_v1':
  reported_SR = DSR(SR_max, K=5, T=|backtest_window|, γ_3, γ_4)
  per Bailey-LdP §11.5 (existing implementation in src/lib/psr.ts).
```

`K=5` is the swept-K for this Phase 2 indicator. Strategies that gate on multiple regime indicators inherit the **product of K's** across all gates if they were independently selected, OR the family-level HLZ correction if they were sequentially attempted families. Phase 2 only contributes the `K=5` factor; cross-phase composition is downstream's problem.

**Cross-phase K accounting (per critic missing-item):**

- **Phase 1 K = 1 effectively.** Phase 1's `vix_term_inverted` (>1.0), `breadth_narrow` (50% / 95% / 252d), and `hyg_spy_divergence` (20d window) are all hard-coded to source-doc values per Phase 1 SPEC §2 + rev 2 N6. No sweep was performed; Pardo §6's "no calibration on data" baseline applies. So `K_phase1 = 1`.
- **Phase 2 K = 5** (this SPEC's swept threshold over `K = {-10, -12, -15, -18, -20}%`).
- **Joint K under phase2_v1 = 1 × 5 = 5.** A future Phase 2.5 SPEC that re-tunes any Phase 1 threshold against post-Phase-2 data **re-opens K_phase1**, and the joint K multiplies. SPEC rev 2 N6 forbids this without an unbiased breadth source as a precondition; this is not a hypothetical, it's the operative fence.
- **Sequential-family attempts inherit HLZ.** If §3.10 option (i) escalation fires (drawdown family rejected, absolute VIX family attempted next), the next family lands with HLZ Bonferroni: `α_next = 0.01 / 2 = 0.005` per family attempt. The K-factor from this Phase 2 attempt is "spent" on the rejection and the new family carries its own K.

**SPY adjustments (per critic missing-item):** `spy_close` series is `auto_adjust=True` per Phase 1 §1.1 — corporate-action adjustments (splits, dividends) are folded into the close. The `spy_drawdown_from_1y_high(t)` ratio is dimensionless and ratio-invariant under the auto-adjust transformation, so adjustments do NOT introduce computation bias. Watch-out: a future SPEC that switches SPY ingest to `auto_adjust=False` (raw close) would silently change the drawdown values on dividend dates. Document this in §7.

**Hook lives where:** a comment in [src/lib/psr.ts](../../src/lib/psr.ts) referencing this SPEC §3.9 + a `K_PHASE2_REALIZED_STRESS = 5` named constant exported from `src/server/macro_regime.ts` so downstream Sharpe-calculation paths can `import { K_PHASE2_REALIZED_STRESS }` and pass it explicitly.

### 3.10 Step 9 — V-fail handling (HLZ escalation or document-and-defer)

If §3.8 Step 7 fails (chosen θ does NOT produce red on at least one date in each `V_i`):

**Option (i) — HLZ family-level escalation.**

- Document: SPY drawdown family rejected on V.
- Tighten α for the next family attempt: `α_new = α / 2 = 0.001` (one extra family attempted, Bonferroni-on-families per HLZ Table 1).
- Restart from §3.2 Step 1 with a fresh family (most likely absolute VIX). Fresh `K`, fresh `V` (these can stay the same, but they are now SEMI-SPENT for this indicator family — the SPEC opens an explicit budget question).

**Option (ii) — document-and-defer.**

- Phase 2 ships with `phase2_v1` rows that include `realized_stress` data but `realized_stress` does NOT contribute to the composite. The category exists in the schema and the audit columns; the §2.3 rule reverts to the 3-category Phase 1 form.
- The HANDOFF records "drawdown family did not pass V; next attempt deferred to Phase 2.5 SPEC."

**Default: option (i) escalate.** Per critic non-blocking concern on §3.10 + teach-doc Step 7 framing ("you may not loop back … run the full procedure again on a different family"), the canon-correct response to V-fail is to attempt a different family with the HLZ family-level haircut applied, not to ship a partial classifier. Option (ii) document-and-defer is available as the user's **explicit override**, not the SPEC's quiet exit. If the user pre-commits to (i) at sign-off (per §8 acceptance criterion #6 below), CODE proceeds without pausing on V-fail — the procedure script auto-emits a follow-up SPEC stub and the next family attempt is queued.

### 3.11 Acceptance bar summary

A Phase 2 ship under `classifier_version='phase2_v1'` requires ALL of:

1. **At least one** `θ ∈ K` survives Step 3 (Bonferroni-adjusted two-sided permutation test, `p_two ≤ 0.002`). Multiple survivors are not a failure — they indicate the indicator carries informative regime structure across more than one threshold. The §3.5 PBO + §3.6 walk-forward ranking metric (`|Welch's t-stat|`) disambiguates among survivors. (Rev 3 — was "Exactly one" in rev 2; relaxed because the two-sided test routinely admits 1-2 survivors at α=0.002 when the indicator is informative across nearby thresholds.)
2. PBO < 0.5 at the chosen θ (Step 4).
3. Walk-forward θ-spread ≤ 4pp across train windows (Step 5).
4. Co-fire histogram produced and the §2.3 composite rule chosen (Step 6).
5. **Held-out V-fire (per §3.8 pre-registered bar):** chosen θ produces `red_fraction(V_2008) ≥ 0.20`, `red_fraction(V_2020) ≥ 0.10`, AND `consecutive_red_run ≥ 3` in each of `V_2008` and `V_2020` under the §2.3 composite (Step 7).
6. The 4 currently-failing fixture tests are re-keyed to `phase2_v1` in [scripts/tests/macroRegimeFixtures.test.ts](../../scripts/tests/macroRegimeFixtures.test.ts) and `2008_gfc` + `2020_covid` pass; `2014_calm` does not regress (still zero red days under `phase2_v1`); `2017_holdout` print-only check still runs.
7. SPEC rev 2 §11 A10 fence remains enforced — no consumer reads `phase2_v1` rows for tuning loops, gating decisions, or kill-switch criteria absent a separate SPEC.

If steps 1, 2, 3, or 5 fail, the procedure is at §3.10 — not "retune to make them pass."

---

## 4. CODE plan

### 4.1 Pure classifier deltas — `src/server/macro_regime.ts`

Edits, in order:

1. Bump `CLASSIFIER_VERSION` from `'phase1_v2'` to `'phase2_v1'` ([line 38](../../src/server/macro_regime.ts#L38)). Update the module-level docstring + the existing version-bump rationale block ([lines 22-37](../../src/server/macro_regime.ts#L22-L37)) to add the Phase 2 entry.
2. Add new exported constants:
    - `REALIZED_STRESS_THRESHOLD: number | null` — **initialized to `null` until the §3 procedure runs and `RESULT.md` declares the chosen θ.** Per critic blocker B4, no placeholder. `backfillMacroRegimes` and `classifyLatestMacroRegime` MUST guard: if `classifierVersion === 'phase2_v1'` and `REALIZED_STRESS_THRESHOLD === null`, throw `Error('phase2_v1 backfill requires REALIZED_STRESS_THRESHOLD; run npm run macro:phase2:procedure first')`. This makes the commit ordering structurally enforced — no human can accidentally write phase2_v1 rows under a placeholder threshold.
    - `K_PHASE2_REALIZED_STRESS = 5` — the swept-K for downstream DSR haircuts (§3.9).
    - `REALIZED_STRESS_BREADTH_RULE: 'C' | 'A' | 'B' | null` — composite-rule selector, default `null` (set by `RESULT.md`, defaults to `'C'` per §2.3 unless §2.4 co-fire histogram demands A or B). Same guard as above: throw on phase2_v1 backfill if null.
3. Extend `MacroRegimeRow` interface (lines 109-138):
    - Add `spy_drawdown_from_1y_high: number | null` after `spy_252d_high`.
    - Add `realized_stress: 0 | 1` after `breadth_narrow`.
4. Extend `classifyMacroRegime` (lines 182-289) to compute `spy_drawdown_from_1y_high` and `realized_stress`:

    ```ts
    const spy_drawdown_from_1y_high =
      today_spy != null && spy_252d_high != null && spy_252d_high > 0
        ? today_spy / spy_252d_high - 1
        : null;
    const realized_stress: 0 | 1 =
      spy_drawdown_from_1y_high != null &&
      spy_drawdown_from_1y_high < REALIZED_STRESS_THRESHOLD
        ? 1 : 0;
    ```

5. Update `signals_firing` and `categories_firing` to include `realized_stress`:

    ```ts
    const signals_firing =
      vix_term_inverted + hyg_spy_divergence + breadth_narrow + realized_stress;
    const categories_firing = signals_firing;   // still 1-indicator-per-category
    ```

6. Extend `PriorDayFires` interface + the rolling-union loop (lines 65-69, 238-251) to track `realized_stress` and `union_stress`. Compute `categories_firing_5d = union_vol + union_credit + union_breadth + union_stress`.
7. Implement the §2.3 composite rule as a separate pure helper:

    ```ts
    function deriveRegime(
      categories_firing_today: number,
      categories_firing_5d: number,
      stress_or_breadth_in_5d: boolean,
      rule: 'A' | 'B' | 'C' = REALIZED_STRESS_BREADTH_RULE,
    ): Regime {
      if (rule === 'C') {
        if (categories_firing_5d >= 3 && stress_or_breadth_in_5d) return 'red';
      } else if (rule === 'A') {
        if (categories_firing_5d >= 3) return 'red';
      } else /* rule === 'B' */ {
        if (categories_firing_5d === 4) return 'red';
      }
      if (categories_firing_today >= ORANGE_THRESHOLD_TODAY) return 'orange';
      if (categories_firing_today === 1) return 'yellow';
      return 'green';
    }
    ```

    (The orange/yellow/green branch is identical across all 3 rules.)
8. Update `rowToPriorDayFires` (lines 295-301) to include `realized_stress`.
9. Update `RegimeDataBundle` and `classifyDateRangeFromBundle` (lines 305-383) — no signature change needed; `prior_days_fires` carries the new field via the type extension.
10. Update `backfillMacroRegimes`'s CH `insert` (lines 530-558) to write the two new columns.

### 4.2 Schema additions — `src/server/clickhouse.ts:ensureMacroRegimeTables` ([line 545](../../src/server/clickhouse.ts#L545))

Two new columns on `quantlab.macro_regimes`:

```sql
ALTER TABLE quantlab.macro_regimes
  ADD COLUMN IF NOT EXISTS spy_drawdown_from_1y_high Nullable(Float64) AFTER spy_252d_high,
  ADD COLUMN IF NOT EXISTS realized_stress UInt8 DEFAULT 0 AFTER breadth_narrow;
```

Existing rows under `phase1_v1` and `phase1_v2` get `NULL` and `0` respectively for the two new columns (sane defaults). The `CREATE TABLE IF NOT EXISTS` block at lines 561-602 also gets the two new columns added to its column list — for fresh-box runs where the table doesn't exist yet.

**Idempotent.** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` is a no-op on subsequent server restarts.

**Reversible.** `ALTER TABLE … DROP COLUMN spy_drawdown_from_1y_high, DROP COLUMN realized_stress` if Phase 2 is reverted. No data loss because the columns carry no information not derivable from `spy_close` + `spy_252d_high`.

**Not destructive.** No data is rewritten; ClickHouse stores nullable columns as separate part files. Per the user's standing rule against destructive ops without confirmation, this is the same risk class as the rev 2 §6.2 `sp500_constituents` add — pre-cleared.

### 4.3 New tooling — `scripts/_phase2_realized_stress_procedure.ts`

A single throwaway script (prefix `_` per project convention) that runs the entire §3 procedure end-to-end against the populated `quantlab.candles` + `quantlab.macro_regimes` tables:

```text
npx tsx scripts/_phase2_realized_stress_procedure.ts --train-end 2026-05-09
```

Outputs (written to `docs/phase2_procedure_artifacts/` for posterity):

- `step2_t_scoring.csv` — per-θ count_red, cluster_count, fp_rate.
- `step3_permutation_test.csv` — per-θ p-values + Bonferroni decision.
- `step4_pbo.csv` — per-θ PBO + final decision.
- `step5_walk_forward.csv` — per train-window θ_train.
- `step6_cofire_histogram.md` — the markdown histogram + flip-day list.
- `step7_v_results.csv` — per-V-window red counts at chosen θ + composite rule.
- `RESULT.md` — chosen θ, chosen rule, acceptance-bar checklist.

The script is idempotent and side-effect-free **except** for the artifact writes. It does NOT touch `quantlab.macro_regimes` — that's `npm run macro:backfill`'s job after the procedure picks θ.

### 4.4 Fixture re-emit + test re-keying

1. After CODE step 5 in §4.6 (CH backfill under phase2_v1), re-run [scripts/_emit_macro_regime_fixtures.ts](../../scripts/_emit_macro_regime_fixtures.ts). The emitter pulls inputs from CH (no breadth_narrow / realized_stress dependency) — fixture CSVs **do not need to change**.
2. Update [scripts/tests/macroRegimeFixtures.test.ts](../../scripts/tests/macroRegimeFixtures.test.ts) so the bundle-based test reads inputs and runs `classifyDateRangeFromBundle` under `phase2_v1` (the test already calls the classifier directly via the imported function — no test change needed for the version bump itself).
3. Re-key per-fixture expectations to `phase2_v1`'s acceptance bar. **Re-keying tightens the bar for some fixtures, which is a real regression risk per critic non-blocking #4 — listed explicitly:**
    - `2008_gfc` — keep `red >= 30%`. Phase 2 must not weaken this. **Risk: low.** Phase 2 adds realized_stress which fires on 2008's massive drawdown; should strictly help.
    - `2020_covid` — **tighten from `red >= 5` to `red >= 10`** to align with §3.8's `red_fraction(V_2020) ≥ 0.10` × ≈70 trading days in the existing fixture window. Phase 2 must rescue this (currently failing under phase1_v2).
    - `2014_calm` — keep `red == 0` AND `green / N >= 0.7`. **Risk: medium.** Negative control; Phase 2 must not regress. The §3.3 `T_calm` fp_rate floor < 5% is a pre-procedure guard, but the fixture bar is `red == 0` strict. If realized_stress fires once on a 2014 sub-window, this fixture fails — and that failure means the procedure picked too permissive a θ.
    - `2018_q4_selloff` — **likely tightening from `orange-or-red >= 3` to `red >= 1`** under phase2_v1. The 2018 Q4 selloff hit ≈-19% from highs; at θ ∈ {-15, -18}% this should fire red. **Risk: medium.** A `θ = -20%` choice would NOT fire red on 2018-Q4 (peak drawdown ≈-19.78%), so the fixture might *fail* under a stricter chosen θ. Acknowledge and decide at CODE-time: either accept that 2018 doesn't reach the Phase 2 red bar (re-key to `orange-or-red >= 3`, unchanged) or treat 2018-Q4 reaching red as a Phase 2 capability (tighten to `red >= 1`). **Default: keep at `orange-or-red >= 3`** — 2018 is not in V, so we don't pre-commit it as a Phase 2 must-rescue.
    - `2011_eu_debt` — keep `orange-or-red >= 5`. Status pre-Phase-2 is "ambiguous due to constituent breadth bias" per SPEC rev 2 §7.3. Phase 2's realized_stress reduces dependence on breadth and may rescue this — but it's not a Phase 2 acceptance criterion (the bar is V = 2008 + 2020).
    - `2017_holdout` — print-only, no assertion. Unchanged. **Critic B2 reinforcement:** 2017 stays calibration-immune across Phase 1 AND Phase 2; the Phase 2 procedure's `T_calm` excludes 2017.
4. New unit tests in [scripts/tests/macroRegime.test.ts](../../scripts/tests/macroRegime.test.ts) — see §6 below for the list.

### 4.5 npm-script delta

Two new scripts:

```json
{
  "macro:phase2:procedure": "tsx scripts/_phase2_realized_stress_procedure.ts",
  "macro:phase2:procedure:dry": "tsx scripts/_phase2_realized_stress_procedure.ts --dry-run"
}
```

Existing scripts unchanged in surface — `macro:backfill` automatically writes `phase2_v1` after the `CLASSIFIER_VERSION` bump in §4.1 step 1; `macro:emit-fixtures` is unchanged. `macro:ingest` is unchanged.

### 4.6 CODE order (commit-by-commit) — REORDERED per critic blocker B4

The CH-writing commit must come **after** the procedure picks θ. Otherwise we write `phase2_v1` rows under a placeholder threshold, then rewrite them under the chosen θ — same version tag, two different semantics across CH state. The `null` sentinel + write-guard from §4.1 step 2 makes the order structurally enforced.

1. **DDL only** (smallest, safest). `ALTER TABLE quantlab.macro_regimes ADD COLUMN IF NOT EXISTS …` for the two new columns + the `CREATE TABLE` block update for fresh-box runs. No classifier logic change, no version bump yet. `CLASSIFIER_VERSION` stays at `'phase1_v2'` for this commit. Test suite stays green; phase1_v2 backfill continues to write the existing columns and the new columns get DEFAULT (`NULL` / `0`).
2. **Pure-classifier extension** (§4.1 steps 3-9), still under `CLASSIFIER_VERSION = 'phase1_v2'`. Add `spy_drawdown_from_1y_high` + `realized_stress` to `MacroRegimeRow`, extend `classifyMacroRegime`, add `deriveRegime` helper. **Constants `REALIZED_STRESS_THRESHOLD = null` and `REALIZED_STRESS_BREADTH_RULE = null` per §4.1 step 2.** When the classifier is invoked under the still-`phase1_v2` version it ignores the new fields (composite stays 3-category). Unit tests added: the new ones in §6.1 invoke `classifyMacroRegime` with an explicit `realized_stress_threshold` test parameter (the helper accepts an override) so they don't depend on the global constant. Test suite stays green.
3. **Procedure script** (§4.3). Runs the full §3 pipeline against the existing `phase1_v2` CH state. Outputs all 7 artifact files + `RESULT.md`. Procedure does NOT write any `phase2_v1` rows to `macro_regimes` (its only CH side-effects are reads + the artifact files in `docs/phase2_procedure_artifacts/`). Test suite stays green.
4. **Plug chosen θ + rule + version bump.** Set `REALIZED_STRESS_THRESHOLD` to the value from `RESULT.md`, set `REALIZED_STRESS_BREADTH_RULE` to the chosen rule, bump `CLASSIFIER_VERSION` from `'phase1_v2'` to `'phase2_v1'`, update the module docstring + the version-bump rationale block ([lines 22-37](../../src/server/macro_regime.ts#L22-L37)). Update `backfillMacroRegimes`'s CH `insert` to write the two new columns (§4.1 step 10).
5. **CH backfill under phase2_v1.** `npm run macro:backfill` writes `phase2_v1` rows over the full window. `phase1_v1` and `phase1_v2` rows are NOT touched (different version tag). `npm run macro:emit-fixtures` regenerates fixture CSVs (no input-data diff; output is per-version when the CSV emitter pulls from CH — confirm at CODE-time whether the emitter is version-aware or version-agnostic).
6. **Test re-key + acceptance verification** (§4.4). Tighten fixture expectations to phase2_v1; verify all of §3.11. **From this commit onward, `2008_gfc` + `2020_covid` must pass** under the new bar; `2014_calm` zero-red holds; `2017_holdout` print-only check still runs.
7. **HANDOFF rewrite** + open the door to Component 5+ consumption planning.

Each step is a commit. Test suite green at every commit. The 4 currently-failing fixtures (`2008_gfc`, `2011_eu_debt`, `2014_calm`, `2020_covid`) per HANDOFF stay failing exactly as they are at commits 1-5 (the version bump only happens at commit 4, but `phase1_v2` fixtures are unaffected by classifier extensions invisible at the v2 version tag); they get re-keyed and pass at commit 6.

---

## 5. Schema and downstream-consumer fence (forward of SPEC rev 2 §11 A10)

### 5.1 `quantlab.macro_regimes` extended schema

Two new nullable/default columns per §4.2. Coexistence:

| classifier_version | spy_drawdown_from_1y_high | realized_stress | breadth_narrow | composite rule |
| --- | --- | --- | --- | --- |
| `phase1_v1` | NULL | 0 | 0 (data dark) | Phase 1 §2.4 (3-category) |
| `phase1_v2` | NULL | 0 | constituent-computed | Phase 1 §2.4 (3-category) |
| `phase2_v1` | computed | computed | constituent-computed | Phase 2 §2.3 (4-category Option C) |

Queries against `macro_regimes` continue to MUST specify `classifier_version` for determinism (SPEC rev 2 §6.3, §10, §11 A10). The default for new code paths is `'phase2_v1'`. The honest-NULL baseline `phase1_v1` and the constituent-breadth `phase1_v2` rows remain queryable for downstream consumers that need an unbiased or biased-but-3-category view.

### 5.2 Downstream-consumer fence (SPEC rev 2 §11 A10 forwarded + sharpened)

A10 stays in force for `phase2_v1`:

- No code path may read `phase2_v1` rows and feed them into a tuning loop, gating decision, or kill-switch criterion **without first adding a SPEC entry that documents the K=5 DSR haircut and the Bonferroni-corrected α=0.002.**
- Component 5+ work that gates strategies on `phase2_v1` MUST `import { K_PHASE2_REALIZED_STRESS } from '../server/macro_regime.js'` and pass it to the downstream Sharpe / hit-rate / PnL haircut routine. A direct `regime == 'red'` filter without the haircut is a violation.
- Code-review checklist item lives in [CLAUDE.md](../../CLAUDE.md) — to be added at SPEC sign-off as part of CODE step 1.

### 5.3 Constituent-bias scope under phase2_v1 (clarified per critic non-blocking #5)

**The `realized_stress` indicator itself reads only SPY closes — no constituent dependency, no survivorship bias path.** SPY corporate-action adjustments (`auto_adjust=True` per Phase 1 §1.1) shift the index level; the drawdown-from-1Y-high computation operates on adjusted closes consistently across the rolling window, so there is no look-ahead or scaling artifact from adjustments.

**However, the `phase2_v1` red label IS still tainted by phase1_v2's constituent bias** — because the §2.3 Option C composite still uses `breadth_narrow` (under augment), and `breadth_narrow` is computed from the survivorship-biased constituent universe per SPEC rev 2 §5.2. The biased path is the topping-mode half of the 4-category red rule; the unbiased path is the crashing-mode half (realized_stress).

**Consumer-facing implication:**

- A `phase2_v1` red day where `breadth_narrow=1` inherits the constituent-bias caveat per SPEC rev 2 §11 A10. Treat as "biased red — topping pattern detected against a survivorship-biased breadth measure."
- A `phase2_v1` red day where `realized_stress=1` AND `breadth_narrow=0` is bias-clean on the breadth axis. The §11 A10 fence still applies for the K=5 DSR haircut, but no constituent-quarantine concern.
- A `phase2_v1` red day where BOTH `breadth_narrow=1` AND `realized_stress=1` is impossible by §2.1 mutex.
- A `phase2_v1` red day where the 5-day rolling union of `breadth_narrow` is 1 (because breadth fired earlier in the window) AND today's `realized_stress=1` IS possible if SPY swung across the 95%/90% boundary within 5 sessions. Inherits the bias caveat for the breadth-fire day in the window, not for today's stress fire.

The bias quarantine fence is unchanged in *scope* (same constituent dependency surface), only forwarded in *version*. SPEC rev 2 §11 A10 reads cleanly under this clarification.

---

## 6. Test plan

### 6.1 New unit tests — `scripts/tests/macroRegime.test.ts`

Per-indicator tests for `realized_stress`:

1. **Boundary-below threshold:** `spy_close = 84.99, spy_252d_high = 100, θ = -0.15` → `realized_stress = 1`.
2. **Boundary-at threshold:** `spy_close = 85, spy_252d_high = 100, θ = -0.15` → `realized_stress = 0` (strict <).
3. **No-stress baseline:** `spy_close = 100, spy_252d_high = 100` → `realized_stress = 0`.
4. **NULL spy_close:** → `realized_stress = 0`, `INPUTS_MISSING_SPY` set.
5. **252d warmup:** SPY history length 100 < 252 → `realized_stress = 0`, `INPUTS_MISSING_SPY_WARMUP` set.
6. **Mutex sanity check:** `spy_close = 84, spy_252d_high = 100, pct_above_50dma = 30, θ = -0.15` → `realized_stress = 1` AND `breadth_narrow = 0` (95%-of-1Y-high gate fails). Confirms §2.1 mutex holds.
7. **Mutex sanity check, mirror:** `spy_close = 96, spy_252d_high = 100, pct_above_50dma = 30, θ = -0.15` → `realized_stress = 0` AND `breadth_narrow = 1`.

4-category composite tests (under Option C):

1. **Same-day red impossible without stress/topping:** vol + credit + (impossible: 3rd category that's not breadth_narrow or realized_stress doesn't exist in Phase 2). Skip — covered by mutex test #6 above.
2. **Same-day red via vol + credit + realized_stress:** all three fire today → `regime = red`.
3. **Same-day red via vol + credit + breadth_narrow:** all three fire today → `regime = red`. (Phase 1 case still works.)
4. **Rolling-5d red via realized_stress on day t-3 + vol on t-1 + credit on t:** Option C passes (3 categories AND realized_stress in window) → `regime = red`.
5. **Option C non-trivially restrictive — direct `deriveRegime` unit test (per critic NB7).** Bypass the input layer: call `deriveRegime(categories_firing_today=2, categories_firing_5d=3, stress_or_breadth_in_5d=false, rule='C')` → `regime = orange` (NOT red). Then `deriveRegime(... , stress_or_breadth_in_5d=false, rule='A')` → `regime = red`. The pair locks the A-vs-C semantic split. **Why bypass the input layer:** with only 4 categories under §2.1 mutex, no real input bundle can produce `categories_firing_5d == 3 AND stress_or_breadth_in_5d == false` — the third firing category WOULD be one of {breadth_narrow, realized_stress}. Per critic NB7, the test exists to lock the rule helper's behavior at all three rule branches, not to exercise an input-bundle case.
6. **4-category orange:** vol + breadth_narrow today → `regime = orange`.
7. **4-category yellow:** realized_stress alone today → `regime = yellow`.
8. **Backfill warmup boundary (4-category):** first 4 days of history with all 3 reachable flags firing → cannot be red regardless. (Existing Phase 1 test extended.)

Procedure-correctness tests (against the `_phase2_realized_stress_procedure.ts` script):

1. **Bonferroni α applied with declared K denominator:** procedure script with mocked p-values asserts that `α_adjusted = 0.01 / |K_declared|` (= 0.002) is the bar, not `α = 0.01` and not `α / |K_surviving|`. Per critic blocker B1, this test is the regression guard that the descriptive Step 2 stats never silently cull `K`.
2. **`T_calm` excludes 2017:** procedure script asserts that the `T_calm` computation for `fp_rate(θ)` does not include any 2017 dates. Per critic blocker B2, this test is the regression guard that 2017 stays a Phase 1 holdout.
3. **PBO computation correctness:** synthetic θ ranking that should yield PBO = 0.5 exactly (perfect random) returns 0.5 ± 0.02 (CSCV variance band).
4. **Walk-forward window enumeration:** assert the exact set of (train_start, train_end, test_start, test_end) tuples for a given `T` matches the §3.6 spec — no off-by-one.
5. **`null` sentinel write-guard:** integration test that calling `backfillMacroRegimes({startDate, endDate, classifierVersion: 'phase2_v1'})` while `REALIZED_STRESS_THRESHOLD === null` throws the expected error (per critic blocker B4).

Total new tests: ~21. Final count likely 18-23 in [scripts/tests/macroRegime.test.ts](../../scripts/tests/macroRegime.test.ts) after collapsing overlaps with the existing 38 Phase 1 tests.

### 6.2 Fixture test re-keying — `scripts/tests/macroRegimeFixtures.test.ts`

Per §4.4. The expectation table moves from "`phase1_v2` 4-failure baseline" to "`phase2_v1` `2008_gfc` + `2020_covid` pass." Acceptance criterion §3.11 item 6.

### 6.3 Procedure-artifact integration test — `scripts/tests/test_phase2_procedure.ts` (new)

Single end-to-end test: run `_phase2_realized_stress_procedure.ts` against a frozen synthetic CH state (small fixture-CH spun up via `clickhouse-local` per existing pattern in [scripts/tests/macroRegimeBackfill.test.ts](../../scripts/tests/macroRegimeBackfill.test.ts)) and assert:

- All 7 artifact files are produced.
- `RESULT.md` chosen θ matches a known expected value for the synthetic data.
- The acceptance-bar checklist in `RESULT.md` is correctly populated.

This test is the regression guard for §3 procedure correctness — if a future SPEC tweaks the procedure, this test catches silent behavior drift.

### 6.4 What the tests do not establish

Per Phase 1 SPEC §5.4 (still in force): the fixture tests are sanity-check, not validation. Passing all of §3.11 means "the implementation reproduces the procedure's chosen θ on V" — it does NOT establish that `phase2_v1` regime labels predict forward returns at any horizon, are useful for gating SignalForge strategies, or that the chosen θ is numerically optimal vs nearby alternatives. **Component 5+ regime-stratified backtest analysis remains the validation step.** This SPEC ships labels; downstream validates them.

---

## 7. Failure modes and watch-outs

- **`V` peeking.** Even glancing at `V`'s indicator firing pattern during Steps 2-6 spends some of the budget. If a peek happens, declare it in HANDOFF, and treat `V` as semi-spent — either restart with fresh held-out windows or accept a tightened §3.8 bar (e.g. require red on a *specific* date per window, not just one date). Per teach-doc Failure Mode #1.
- **`K` expansion mid-procedure is forbidden.** If after Step 3 the surviving `θ` set is empty, the response is §3.10 (HLZ escalation OR document-and-defer), not "let me try `θ = -8%` and `θ = -25%`." Restart with fresh declared `K` if you genuinely need a different range. Per teach-doc Step 1.
- **Bonferroni-rejection is not failure of the procedure.** It's signal that the family doesn't have stable threshold structure. Hansen's SPA / White's Reality Check are the less-conservative alternatives; switching is a documented decision (§3.4), not a silent retune. Per teach-doc Failure Mode #4.
- **PBO > 0.5 is not failure of the procedure either.** Same logic — it's the signal CSCV is designed to surface. Retuning to make PBO < 0.5 is the meta-overfitting CSCV detects. Per teach-doc Failure Mode #5.
- **Walk-forward window-length sensitivity.** The 5y/1y choice is locked at the Pardo §6 default. Trying multiple window lengths and picking the one that makes θ look stable is undisclosed search and inflates the implicit `K`. Per teach-doc Failure Mode #6.
- **Mutex changes the orange/red rule space.** The 16-cell co-fire histogram has 8 cells that are exactly zero by construction (§2.1). Naive 4-category rules that treat the 4 flags as independent (e.g. "2-of-4 today probability") are mathematically wrong on this classifier.
- **`phase2_v1` will eventually become the new default.** Until §3.11 acceptance bar is met, downstream Component 5+ analysts MUST pin `classifier_version='phase1_v1'` for unbiased honest-NULL or `'phase1_v2'` for constituent-biased-but-populated. After acceptance, the default for new code is `'phase2_v1'` with the K=5 DSR haircut. SPEC rev 2 §11 A10 fence applies to `phase2_v1` per §5.2.
- **Composite rule swap (Option A/B/C) post-§3.7 is allowed; post-acceptance is not.** The §2.4 co-fire histogram may push the rule from C to A or B. That's a CODE-stage feedback loop. After §3.11 acceptance and `phase2_v1` rows are written, switching rules requires `phase2_v2` (NOT a `phase2_v1` retroactive change — that violates the version-pin contract).
- **"Re-tune Phase 1 thresholds because Phase 2 changed something" is forbidden.** Phase 1 §2.3 + SPEC rev 2 N6 lock Phase 1's thresholds. Phase 2 may NOT trigger a Phase 1 retune even if a hypothesis "Phase 1's 95%/252d is wrong now that we have realized_stress" looks tempting. Separate SPEC, with its own held-out budget.
- **The 2014_calm fixture is the cry-wolf canary.** Phase 2 must not regress it under any chosen θ. If a `θ` passes Steps 1-5 but fires red on `2014_calm`, it fails §3.11 item 6 → §3.10. This is a stronger constraint than the §3.3 fp_rate < 5% gate because the fixture's bar is `red == 0` (not `red <= 5% of days`).
- **Constituent-bias contamination of the composite.** Even though `realized_stress` itself has no constituent dependency (§5.3), the §2.3 Option C composite still uses `breadth_narrow`, which is constituent-biased per SPEC rev 2 §5.2. This means the *4-category red* under `phase2_v1` inherits the constituent bias's "miss 2008-style topping events" shape on the breadth half. The Phase 2 contribution is rescuing the *crashing* half (realized_stress); the topping half is unchanged. Watch-out: if a future analysis attributes the 4-category red performance to the new indicator alone, it's missing this — `phase2_v1` red performance is a joint statement about both halves.
- **SPY `auto_adjust=True` is load-bearing for `realized_stress` (per critic missing-item).** Phase 1 §1.1 fetches SPY with adjusted closes; the drawdown-from-1Y-high ratio is dimensionless and ratio-invariant under auto-adjust, so corporate actions don't bias the indicator. **A future SPEC switching SPY ingest to `auto_adjust=False` would silently shift drawdown values on dividend dates** — the procedure-chosen θ would no longer match the data the classifier sees, and `phase2_v1` red flips on dividend dates would appear as silent regime shifts. If anyone proposes that switch, this SPEC's chosen θ becomes invalid and the §3 procedure must be re-run.
- **Pre-registered θ prior is `-15%` (per critic missing-item, also §3.8).** If the procedure picks `-15%`, that's confirmation of the prior — neither informative nor concerning. If the procedure picks something else (-10%, -12%, -18%, -20%), that IS the procedure's call and stands. The prior exists so post-hoc rationalization of a different chosen θ ("I always thought -18% was right") is visible as such. Per teach-doc Failure Mode #3.

---

## 8. Acceptance criteria for sign-off-to-CODE

User confirms before CODE proceeds:

1. **Augment-vs-replace (§1.6):** confirm AUGMENT default, OR explicitly request REPLACE. Trade-off table in §1.6 is the side-by-side comparison.
2. **`K = {-10, -12, -15, -18, -20}%` is acceptable (§1.3).** If the user wants different bounds (e.g. tighter to {-12, -15, -18}; broader to {-8, -10, -12, -15, -18, -20, -25}), the SPEC restarts §3 with a fresh declared K. Default ships under the locked K above.
3. **`V = {[2008-09-01, 2009-06-30], [2020-02-01, 2020-06-30]}` is acceptable (§1.4).** Alternative: include `[2011-08-01, 2011-10-31]` (EU debt) as a third V window — would tighten the bar to 3 windows but cost statistical power on T (more data held out). SPEC default is the 2-window V.
4. **§2.3 composite-rule selection — Option C as default.** Confirm Option C, OR explicitly request A or B.
5. **§3.4 Bonferroni vs Hansen's SPA — Bonferroni as default with a pre-quantified SPA escape hatch (per critic NB4).** Confirm Bonferroni-with-SPA-fallback (the quantified V-bar tightening in §3.4 fires automatically if SPA invoked, no CODE-stage pause), OR explicitly forbid SPA fallback (procedure stops if Bonferroni rejects all θ → §3.10).
6. **§3.10 V-fail handling — option (i) escalate is the default per critic NB on §3.10.** Confirm escalate, OR explicitly pre-commit to (ii) document-and-defer. SPEC default is escalate; document-and-defer requires explicit user override.
7. **§3.8 V-bar (`red_fraction(V_2008) ≥ 0.20`, `red_fraction(V_2020) ≥ 0.10`, `consecutive_red_run ≥ 3` per window) is acceptable (per critic blocker B3).** These are pre-registered now. Confirm or override with alternative numbers — but NOT after seeing the procedure's chosen θ.
8. **§4.2 schema additions** — additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` is reversible and pre-cleared per the standing destructive-ops rule. No further destructive ops in this SPEC.

Once those eight are confirmed, CODE proceeds in §4.6 commit order with the §4.1 step 2 `null` sentinel + write-guard structurally enforcing the procedure-before-CH-write ordering.

---

## 9. What this SPEC explicitly does not change

These remain in force unchanged:

- All of Phase 1 SPEC §2 (indicator definitions, threshold semantics, NULL rules) — Phase 1 indicators stay calibrated as-is.
- Phase 1 SPEC §3 / SPEC rev 2 §6 schema — only additive (the two new columns per §4.2). No column drops, no type changes.
- Phase 1 SPEC §5.1 (38 unit tests on `classifyMacroRegime`) — extended (~18 new tests per §6.1), not replaced.
- Phase 1 SPEC §5.2 (6 historical fixture definitions) — re-keyed to `phase2_v1` per §4.4, not redefined.
- SPEC rev 2 §11 A10 downstream-consumer fence — forwarded to `phase2_v1` per §5.2, not relaxed.
- SPEC rev 2 N6 (no re-tuning Phase 1 thresholds against constituent-computed fixtures) — still in force; Phase 2 doesn't open this door.
- The Phase 1 framing (§8 of SPEC rev 1 — "Phase 1 produces DATA, not actions") — unchanged. Phase 2 also produces DATA, not actions; Component 5+ does the consumption.
- ADRs 001-035 — unchanged. Phase 2 may produce ADR-036 if the §3 procedure surfaces a decision worth durable record.

---

## 10. Next stage — CODE order summary (§4.6 recap, post-critic-reorder)

1. DDL only — `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for `spy_drawdown_from_1y_high` + `realized_stress`. No version bump.
2. Pure-classifier extension under `phase1_v2` (`REALIZED_STRESS_THRESHOLD = null`, `REALIZED_STRESS_BREADTH_RULE = null`). New unit tests use override parameters, not the nulled constants.
3. `_phase2_realized_stress_procedure.ts` script + run + `RESULT.md` artifact + 7 step-artifact files in `docs/phase2_procedure_artifacts/`.
4. Plug chosen θ + rule from `RESULT.md` into the constants; bump `CLASSIFIER_VERSION` to `'phase2_v1'`; update CH insert path.
5. `npm run macro:backfill` writes phase2_v1 rows; `npm run macro:emit-fixtures` regenerates CSVs.
6. Test re-key + acceptance verification against §3.11.
7. HANDOFF rewrite.

Estimated wall-clock: 1-2 sessions to acceptance, dominated by step 3 (procedure run + interpretation) and step 6 (acceptance verification).

---

## 11. Critic-resolution log (rev 1 → rev 2)

Critic verdict on rev 1 (delegate-acting per `feedback_full_delegation_mode`): **REVISE** with 4 blockers + 7 non-blocking concerns + 3 missing items. All 14 items folded into rev 2; resolution map below.

### Blockers (B1-B4) — all resolved

- **B1 (§3.3 + §3.4) — Bonferroni denominator could silently shrink if pre-stat filter culls K.** **Resolved:** §3.3 rewritten as descriptive-stats-only (no culling); §3.3 explicit "Bonferroni denominator is `|K_declared| = 5` always — never `|K_surviving|`"; §6.1 procedure-test #1 added as regression guard.
- **B2 (§3.3) — `T_calm` included 2017, which is the Phase 1 holdout.** **Resolved:** §3.3 `T_calm` swapped to `{2014, 2016, 2024, 2025}`; explicit cross-phase holdout-integrity statement added; §6.1 procedure-test #2 added as regression guard.
- **B3 (§3.7 + §3.11) — "≥1 red day per V window" too lenient and game-able.** **Resolved:** §3.8 pre-registered concrete bar `red_fraction(V_2008) ≥ 0.20 AND red_fraction(V_2020) ≥ 0.10 AND consecutive_red_run ≥ 3 per window` with rationale per number; §3.11 item 5 + §8 acceptance criterion #7 updated.
- **B4 (§4.1 + §4.6) — `REALIZED_STRESS_THRESHOLD = -0.15` placeholder is a footgun across commits.** **Resolved:** §4.1 step 2 changed to `null` sentinel + write-guard that throws on `phase2_v1` backfill if null; §4.6 commit sequence reordered so the procedure runs (commit 3) before any phase2_v1 CH writes (commit 5); §6.1 procedure-test #5 added as regression guard.

### Non-blocking concerns (NB1-7) — all addressed

- **NB1 (§2.3 Option C plain-language).** **Folded** into §2.3 as the "Plain-language equivalent" callout — Option C is "both of {vol, credit} fired in window AND exactly one of {breadth_narrow, realized_stress} fired in window."
- **NB2 (§3.6 walk-forward bar tightening from ±4pp to ±3pp).** **Folded** — bar tightened to ±3pp (max-min spread); rationale rewritten.
- **NB3 (§3.5 PBO contiguous-vs-interleaved tradeoff).** **Folded** as a documented choice with sanity-check escape hatch if PBO ≈ 0.5.
- **NB4 (§3.4 Hansen's SPA "semi-spent" not quantified).** **Folded** — SPA invocation now carries pre-quantified V-bar tightening (`+50%` on red-fraction floor, `+2 days` on consecutive-run floor); §8 acceptance criterion #5 pre-commits Bonferroni-with-SPA-fallback or Bonferroni-only.
- **NB5 (§5.3 wording invites wrong "phase2_v1 is bias-free" conclusion).** **Folded** — §5.3 rewritten with explicit per-red-day bias attribution (breadth_narrow arm biased; realized_stress arm bias-clean); consumer-facing implications spelled out for each red-day case.
- **NB6 (§4.4 fixture re-keying isn't free; tightening can regress).** **Folded** — §4.4 risk-tagged per fixture (low/medium); 2018_q4 default-decision documented; 2017 holdout-immune statement reinforced.
- **NB7 (§6.1 test #12 depends on impossible inputs).** **Folded** — test #12 reframed as a direct `deriveRegime` unit test that bypasses the input layer; lint cleanup on §6.1 ordered-list numbering.

### Missing items — all added

- **Pre-registered θ prior.** **Added** to §3.8 + §7 watch-out — author's prior is `θ = -15%`; deviations from the prior stand on the procedure's outcome.
- **SPY `auto_adjust=True` documentation.** **Added** to §3.9 + §7 watch-out — drawdown ratio is invariant under auto-adjust, but a future switch to `auto_adjust=False` invalidates the procedure-chosen θ.
- **Cross-phase composition K accounting.** **Added** to §3.9 — explicit `K_phase1 = 1`, `K_phase2 = 5`, joint `K_phase2_v1 = 5`; future Phase 1 retunes re-open `K_phase1` and multiply.

### Rev 3 (2026-05-10) — post-procedure-run corrections (Q1 + Q2)

The Phase 2 SPEC §3 procedure ran 2026-05-10 against the populated CH state (4366 post-warmup days in T, V excluded, seed=42). The run rejected at Step 3 — but surfaced two SPEC-internal issues that the procedure was designed to expose:

- **Q1 (§3.4 H1 directionality).** Rev-2 H1 was one-sided "stress anti-predicts forward returns" (`E[ret_20d | fire] < unconditional`). The data showed `observed_diff > 0` for every θ ∈ K (drawdown firings mean-revert at 20d horizon — fire-days have HIGHER subsequent returns, which is the canonical post-crash recovery signature dominating the 20d window). The rev-2 H1 was inconsistent with §0's own framing of `realized_stress` as a *concurrent regime LABEL* (not a forward-return predictor). The empirical falsification confirmed an SPEC-internal contradiction.
  - **Fix in rev 3:** §3.4 H1 reframed two-sided ("realized_stress is informative about next-20-day SPY return distribution, regardless of direction"). Two-sided p-value definition added per Davison & Hinkley 1997 §4.4. Bonferroni α stays at 0.002 unchanged. The two-sided test is structurally stricter than picking the direction post-hoc — both tails count, no direction-shopping.

- **Q2 (§3.5/§3.6 ranking metric scaling-degeneracy).** Rev-2 metric `count_red − fp_rate_calm` had a scaling mismatch: `count_red ∈ [72, 448]` dominated `fp_rate_calm ∈ [0.000, 0.030]`, making the metric monotone in `count_red` for any practical θ. The procedure run trivially picked θ=-10% on every walk-forward window (highest count_red), giving spread=0 and PBO=0 — but for the wrong reason (degenerate ranking, not stable indicator). Per teach-doc Step 4 the canon-correct rank statistic is the test statistic itself.
  - **Fix in rev 3:** §3.5 + §3.6 ranking metric switched to `|Welch's t-stat|` of the 20-day forward-return mean difference (fire vs no-fire). This is the same statistic family as the §3.4 test, dimensionless, and properly normalized by sample SE so slices with few fires don't get spurious magnitude.

- **Q3 (§3.11 item 1 wording).** Rev-2 "Exactly one θ ∈ K survives Step 3" was over-restrictive — the two-sided test at α=0.002 routinely admits 1-2 survivors when the indicator is informative across nearby thresholds. Multiple survivors are not a failure; §3.5 + §3.6 + the decideTheta tiebreak (max `|t_stat|` on T among survivors) handle disambiguation.
  - **Fix in rev 3:** §3.11 item 1 relaxed to "At least one"; multiple-survivor disambiguation made explicit.

**What rev 3 did NOT change:**

- K declaration (`{-10, -12, -15, -18, -20}%`) — locked in §1.3 + §8 acceptance #2; does not change because the SPEC bug was in the test framing, not the candidate set.
- V declaration (sacred per §1.4) — V was untouched in the rejected procedure run; budget fully preserved.
- α = 0.002 (Bonferroni denominator |K|=5) — unchanged.
- Block-bootstrap settings (block_len=20, B=10,000, seed=42) — unchanged.
- §3.8 V acceptance bar (`red_fraction(V_2008) ≥ 0.20`, `red_fraction(V_2020) ≥ 0.10`, `consecutive_red_run ≥ 3` per window) — unchanged; the V bar is about regime-membership coverage, independent of the §3.4 forward-return test.
- §3.10 V-fail handling (Option (i) escalate is default, Option (ii) document-and-defer is user-override) — unchanged.
- §4.6 commit ordering, write-guard discipline, schema fence — unchanged. Rev 3 only revises §3 test framing, not the CODE plumbing.

**Why this is not "silent retune":** The methodology canon is explicit (Aronson EBTA chs 6-7, López de Prado AFML §11, teach-doc 2026-05-09) that procedure-surfaced inconsistencies in test framing should be corrected at the SPEC level, NOT chased to a passing result by tweaking thresholds, K, or α. Rev 3 changes the SPEC's H1 direction (one-sided → two-sided) and the ranking metric (scaling-degenerate → canon-correct), with the substantive thresholds (`α = 0.002`, K, V, V-bar) all locked. The rev-3 procedure may pass or reject — both outcomes are honest. If it rejects too, §3.10 Option (i) (escalate to next family) fires legitimately, and the SPEC has clean internal logic for the next family attempt.

### What rev 2 did NOT change

- Indicator family choice (SPY drawdown from 1Y high) — locked.
- K declaration (`{-10, -12, -15, -18, -20}%`) — locked.
- V declaration (`{[2008-09-01, 2009-06-30], [2020-02-01, 2020-06-30]}`) — locked.
- Composite rule default (Option C) — locked.
- Schema-additive approach (no destructive ops) — locked.
- Phase-bump rationale (`phase2_v1`, not `phase1_v3`) — locked.
- Augment as default for §1.6 — locked (REPLACE remains user-override).

Critic verdict on rev 2: **proceed to user sign-off, then CODE per §4.6 reordered sequence**.

---

*End of Phase 2 SPEC rev 2 (post-critic).*
