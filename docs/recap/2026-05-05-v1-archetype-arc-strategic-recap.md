---
status: active
phase: phase 9+
last_updated: 2026-05-05
owner: pejman
type: recap
---

# Strategic Recap — v1-Archetype Arc + Where to Go Next

**Date:** 2026-05-05 (end of session 10)
**Purpose:** Synthesize the v1-archetype research arc (sessions 3-10) into one document so the next strategic decision is informed without re-reading 26 ADRs. **This document does not make the strategic call** — it lays out options + trade-offs for user judgment per `feedback_full_delegation_mode`.

---

## TL;DR

- **What we tested:** v1 archetype family (`trend_v1`, `mean_reversion_v1`, `momentum_v1`) across 4 surface variants × 28 cell-trainings.
- **What we found:** ALL REJECT. No PROMOTE. The archetype family — not the universe, not the OOS window, not the param choice — is the bottleneck.
- **What's solid:** the methodology pipeline. Deflation gates, cluster framework, meta-labeling pipeline, two read-side dashboards, regression-pinned tests.
- **What's not solid:** any deployable strategy. There is none yet.
- **The decision in front of you:** {Track 3 fresh archetype RESEARCH} vs. {operational consolidation} vs. {accept-where-we-are}. All three are defensible.

---

## What we know — the v1-archetype arc

Five sessions of disciplined testing across two methodologically-orthogonal universes:

| Surface                            | Sessions  | Cell-trainings | Outcome                       | Headline finding |
| ---------------------------------- | --------- | -------------: | ----------------------------- | ---------------- |
| Solana mcap_micro / mcap_nano · 1d | 3-7       |             26 | All REJECT                    | OOS AUC ≈ chance across all params; ADR-018-024 |
| cex_major BTC/ETH/SOL · 4h         | 7         |              1 | REJECT (ADR-025)              | First C1 PASS in series (AUC 0.5560), but M1 primary baseline negative — meta-labeling prerequisite violated |
| Solana mcap_micro · 1h             | 10        |              1 | REJECT (ADR-026)              | AUC=0.4925 at chance even with 9,016 entries (19.8x the 1d sibling); M1 baseline strongly positive but meta-labeler removes winners |
| **Total**                          |           |         **28** | **All REJECT**                |                  |

**The three converging diagnostics:**

1. **AUC stays at chance regardless of sample size.** From 459 entries (1d/p=7) to 9,016 entries (1h/p=5), OOS AUC moves within [0.43, 0.56]. No threshold crossing 0.55 with C2 ≥ 100 simultaneously. The v0+v1 feature set carries no learnable signal for these archetypes on this universe.

2. **Distribution is universally tail-driven.** C6 (top-1 trade share ≤ 50%) fails on essentially every cell. One trade dominates 60-135% of the kept-sum on memecoin-tier data. This is universe-intrinsic, not strategy-correctable.

3. **HLZ haircut is brutal at M=258.** The Bonferroni critical t-stat is ≈4.15. No cell's t-stat exceeded 1.5. Even with a methodologically-perfect strategy and clean execution, these cells couldn't clear the multiple-testing correction the canon prescribes.

**What this means concretely:** there is no "tune a parameter, try a different cell, run another regime overlay" path forward on this archetype family. The methodology has spoken decisively. The single +5pp lift on ADR-023 didn't replicate on ADR-024; the cross-market test on cex_major (ADR-025) and intraday on Solana (ADR-026) confirmed the bottleneck is the archetype, not the surface.

---

## What's solid (the value)

**Methodology pipeline — production-grade:**

- **Deflation triple** (DSR + PBO + HLZ via CSCV) on the strategy axis — `src/lib/psr.ts` + `migrate_pbo_schema.ts` + scoring pipelines.
- **Cluster framework** — HDBSCAN weekly fits, admission rule, `cluster_diagnostics_weekly` + `strategy_scores_by_cluster` + `token_cluster_membership`. ADR-014 constants pinned.
- **Meta-labeling pipeline** — full LdP AFML §3 implementation. Triple-barrier labels (ADR-018), ADR-019 distribution-robustness criteria (C5/C6/C7), ADR-020 robust threshold-tuning, ADR-021 regime-overlay support, ADR-022-024 feature-extension framework.
- **7-criterion verdict persistence** (session 9 schema migration). All cell-trainings now have `c1_pass..c7_pass + trimmed_mean + top1_share + t_stat + hlz_bar + verdict_text` in `meta_models`. Idempotent migration script committed (session 10).
- **Two read-side dashboards** — `/#/cluster` (Phase 2 §5.5) + `/#/meta-labeling` (NEW session 8/9). Both surface honest "what we tried + what passed" without inventing edges.
- **540 TS + 62 Python = 602 tests passing.** Includes regression pins for the CH 24.8 FINAL/UUID quirk and ReplacingMergeTree FINAL semantics.
- **26 ADRs.** Each documents a methodologically-load-bearing decision with citation back to canon (LdP, Pardo, Harvey/Liu/Zhu, Bailey-LdP, Bergstra-Bengio, Aronson, Faber, Moskowitz/Ooi/Pedersen, Asness/Moskowitz/Pedersen, etc.).

**This is the achievement.** The methodology investment is real. It's reusable for any future archetype research.

---

## What's not solid

- **Zero deployable strategies.** The v1 family is exhausted. No cell PROMOTEs.
- **Cross-market validation as a methodology** — implemented (ADR-025) but produced a clean negative. The reference doc's gold-standard test (Section 4) was applied honestly and said "the hypothesis doesn't transfer."
- **No paper-trade infrastructure / position-sizing module / live divergence monitor.** Deferred until a passing strategy exists. Currently no driving need.

---

## The strategic fork

Three defensible directions. None is wrong; the choice is values-driven.

### Option A — Track 3: Fresh archetype RESEARCH

**Premise:** Build a strategy with fundamentally different signal structure from `trend_v1`/`mean_reversion_v1`/`momentum_v1`. Three canonical candidates, ranked by my read of {effort, prior-probability, methodological distinctness}:

#### A1. Pairs cointegration on cex_major (Engle/Granger 1987; Vidyamurthy 2004)

| | |
|---|---|
| **Canon** | Engle/Granger 1987 (cointegration test); Vidyamurthy 2004 *Pairs Trading* (textbook); LdP AFML ch.16 (mean-reversion-on-spread microstructure) |
| **Signal structure** | Statistical-arb on the BTC-ETH cointegration residual. Trade the spread when it's > 2σ from mean; exit when it reverts. |
| **Infrastructure cost** | Low. Use existing `cex_major` data (5 years of BTC/ETH/SOL on 1d/1h/4h). Need: ADF unit-root test, Engle-Granger 2-step regression, OU mean-reversion estimation. ~1 week of code. |
| **Methodological distinctness** | High. NO overlap with v1 archetypes — different signal generator, different label structure (z-score crossings, not RSI extremes), different risk profile (market-neutral spread vs directional). |
| **Prior probability of clearing C5/C6/C7** | Moderate. Pairs trades have known tail behavior (cointegration breaks during regime shifts) but normally diversifies single-token tail risk. Should escape C6 (top-1 dominance) reliably. |
| **Risk** | BTC-ETH cointegration may have decayed since the 2017-2020 papers documented it. Need to test stationarity of the relationship over our actual OOS window. |

**Recommendation if option A is picked: A1 is the smallest scope-creep that's methodologically distinct.**

#### A2. Volume-confirmed trend (Blume/Easley/O'Hara 1994; Aronson 2006 §6)

| | |
|---|---|
| **Canon** | Blume/Easley/O'Hara 1994 (volume as informational signal); Aronson 2006 *Evidence-Based Technical Analysis* §6 |
| **Signal structure** | Same `trend_v1` EMA crossover, BUT entry conditional on volume > X × 30d-median-volume at the crossover bar. |
| **Infrastructure cost** | Very low. Incremental change to existing `trend_v1` strategy. ~1 day of code. |
| **Methodological distinctness** | LOW. Same archetype family + a volume gate. |
| **Prior probability of clearing C5/C6/C7** | LOW. Same memecoin universe + same EMA archetype. C6 (top-1 dominance) is universe-intrinsic; volume gate doesn't fix that. May reduce trade count too aggressively → fail C2. |
| **Risk** | Worst-of-all-worlds: smallest scope but lowest prior. Could end the arc with another REJECT and no methodological learnings. |

**Recommendation if option A is picked: A2 is **NOT** the right pick despite being cheapest. The bottleneck is universe-archetype interaction, not feature gating.**

#### A3. Cross-sectional momentum portfolio (Asness/Moskowitz/Pedersen 2013)

| | |
|---|---|
| **Canon** | Asness/Moskowitz/Pedersen 2013 *Value and Momentum Everywhere* (gold standard); Jegadeesh/Titman 1993 (founding paper); LdP AFML ch.20 (microstructure/portfolio) |
| **Signal structure** | Long top-decile of past 12-month returns, short bottom-decile. Rebalance monthly. Portfolio-level signal; aggregate across all admitted tokens. |
| **Infrastructure cost** | HIGH. Need to build: portfolio backtest engine (current engine is per-token), ranking/decile machinery, cross-token correlation matrix, monthly rebalancing scheduler, position-sizing module, sector neutralization. ~3-4 weeks of code. |
| **Methodological distinctness** | MAXIMUM. Different evaluation surface (portfolio vs per-token), different signal aggregation (cross-section vs single-asset), different risk decomposition (factor exposure vs trade-level). |
| **Prior probability of clearing C5/C6/C7** | HIGH. Portfolio diversification mechanically reduces single-token tail risk → C6 should clear easily. The Asness et al. paper explicitly demonstrated value/momentum across 8 markets and 4 asset classes — the closest match to our universe is mid-cap equities, where the strategy worked. |
| **Risk** | Largest infrastructure investment. If A3 also REJECTs, we've spent weeks for another negative result. But the negative would itself be informative — it'd suggest the *universe* is too noisy for ANY conventional alpha, and the project should pivot to data-collection or universe-curation. |

**Recommendation if option A is picked: A3 has the highest expected information value but the highest cost. If the user is committed to "find a passing strategy" — A3. If unsure between A1 and A3 — A1 first as a smaller test.**

### Option B — Operational consolidation

**Premise:** Don't pursue more alpha research. Polish what's built; deploy the methodology framework as the deliverable.

| | |
|---|---|
| **What this looks like** | (1) CSCV/PBO computation for meta-labeling cells (~2-3h, closes the deflation pipeline for the meta verdict). (2) Per-cell experiment-log auto-matching in the panel. (3) Deployment infrastructure: paper-trade adapter, position-sizing module, live-vs-backtest divergence monitor. |
| **When this is right** | If the project's value is the methodology investment + research log, not a deployable trading system. Defensible per quant_reference.html: many quant systems live for a long time without finding edge; the methodology rigor is itself the asset. |
| **What you give up** | The chance of finding a passing strategy on this universe. May be moot since N=28 says we're not finding one with v1. |
| **Effort** | 1-2 weeks. Bounded. |

### Option C — Accept where we are; pause

**Premise:** Stop active development. The methodology is solid; the universe doesn't have edge for the archetypes tested; further investment without a clear hypothesis is speculation.

| | |
|---|---|
| **When this is right** | If your goals have shifted (project is now a learning vehicle, time is better spent elsewhere). Or if you want to wait for new data, new market regime, new canon to emerge before re-engaging. |
| **What you give up** | Forward momentum. The codebase will rot at the rate dependencies update. |
| **What you keep** | Everything that's built. The repo is in a clean state — handoff current, all tests pass, all ADRs final. |

---

## My read (input to your judgment, not a decision)

If pressed for a single recommendation: **Option A1 (pairs cointegration on cex_major)**. Reasoning:

1. Smallest scope creep that's methodologically distinct.
2. Uses infrastructure already built (cex_major data + meta-labeling pipeline reusable for any cell).
3. Highest prior-probability of C6/C7 PASS (statistical-arb diversifies tail risk by construction).
4. If it also REJECTs, the result is informative: it'd suggest the v1-RSI/EMA archetype family wasn't the only thing exhausted; need to step further outside conventional technical analysis (microstructure, on-chain features, alternative data).
5. If it PASSES (low but non-zero prior), the project becomes "we have a deployable pairs strategy on liquid CEX majors with deflation-corrected positive expectancy" — a real, shippable result.

But this is canon-thin per `feedback_full_delegation_mode`. The decision among A/B/C is yours; the decision among A1/A2/A3 if you pick A is yours.

---

## What to do today (decision-cost ≈ low)

1. **Read this doc + glance at the two review docs** ([cluster](../reviews/2026-05-05-cluster-dashboard.md) + [meta-labeling](../reviews/2026-05-05-meta-labeling-research-log.md)).
2. **Open `/#/meta-labeling`** in the browser. Verify the 7-pill verdict + sig-copy buttons + experiment-logs hint feel right.
3. **Pick one of {A, B, C}.** State the choice in your next message.
4. If A: pick one of {A1, A2, A3}.
5. The next session executes per your choice. If A → RESEARCH stage with citation-grounded SPEC. If B → CSCV/PBO computation kicks off. If C → repo stays clean, this doc is the bookmark.

**Estimated time to read this doc + decide: 15-30 minutes.** No code changes required to make the call.

---

## Files referenced

- ADRs: [docs/decisions/README.md](../decisions/README.md) — 26 entries (most relevant: ADR-018-026 for v1 arc).
- Reference: [quant_reference.html](../../quant_reference.html) — Bloomberg-style methodology canon.
- Master roadmap: [MASTER.html](../../MASTER.html) — full project structure, currently up to Phase 2 §5.5.
- Recent dashboard reviews:
  - [docs/reviews/2026-05-05-cluster-dashboard.md](../reviews/2026-05-05-cluster-dashboard.md)
  - [docs/reviews/2026-05-05-meta-labeling-research-log.md](../reviews/2026-05-05-meta-labeling-research-log.md)
- Experiment captures: [docs/experiments/](../experiments/) — 5 dated subdirectories, each a captured stdout from a live experiment.
- Handoff (auto-loads on every session): [.claude/HANDOFF.md](../../.claude/HANDOFF.md).
