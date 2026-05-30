# ADR-056 — Layer-0 + single-stock validation: comprehensive null result

**Status:** PROPOSED (operator ratification required — this concludes the project's core research thesis).
**Date:** 2026-05-30 (s96 #38, Cycles 40-41).
**Owner:** Vector Core orchestrator. **Supersedes:** none. **Related:** ADR-051 (deflation pipeline),
ADR-052/053/054/055 (form_4 four-layer template).

## Context
SignalForge's thesis: alternative-data composites (macro regime, sector rotation, cross-asset, cycle,
vol structure, ETF flow, insider/Form-4, 13D/G, 8-K, executive departures, short interest) could produce
tradeable signals. Phase B (ADR-051) validates each via deflation gates — Deflated Sharpe (Bailey-LdP
2014), PBO/CSCV (Bailey et al. 2014), Harvey-Liu-Zhu multiple-testing haircut (2016), Pardo OOS/IS — so a
"pass" means alpha that survives selection-bias correction, not raw backtest performance.

Cycles 40-41 completed the data work (repaired + backfilled the 4 dark EDGAR/FINRA ingests; built a
survivorship-free price panel via Polygon free tier) and ran Phase B across the full signal set, including
a survivorship-free, cap-tier-stratified single-stock cross-sectional test.

## Finding (the decision)
**Zero composites clear the bar. The alternative-data signal set, as constructed, does not produce
tradeable alpha that survives deflation.**

| Composite | Phase B result | Why |
|---|---|---|
| cross_asset_v1, cycle_v1, sector_rot_v1, vol_struct_v1 | PARTIAL (beta) | High raw Sharpe = long-equity beta; fail DSR/HLZ |
| short_interest_v1 | PARTIAL (beta) | At IS-best θ degenerates to buy-and-hold |
| form_4 (insider pooled) | insufficient | pooled events 8 < 20 floor (sparse) |
| executive_departures | insufficient | ~1.4 events/day market-wide (sparse) |
| schedule_13d_g | not viable | ingest captures only amendments, zero base filings → signal identically zero (data bug) |
| eight_k | not run | construct is the ADR-053/054/055-invalidated per-sector max-over-sectors form; needs pooled rebuild |
| **single-stock cross-sectional (equity_xs, survivorship-free Polygon, mega/large/mid/small)** | **NULL** | no tier passes 4 gates; mid-cap closest (DSR+PBO pass) but fails HLZ (t≈1.5) + OOS sign-flip = IS artifact; all tiers β≈0.77-1.11 |

No methodology gate was relaxed and no parameter was tuned to chase a pass (anti-shopping, AFML §11.4) —
that discipline is precisely why the negative result is trustworthy.

## Consequences
- **Do NOT deploy capital.** Nothing is Phase-C-eligible; Q-1/Q-2 remain indefinitely deferred. The system
  worked as designed: it refused to trade beta/noise *before* any money was risked.
- **The deliverable is the validated pipeline + the honest negative**, not a live strategy. A rigorous,
  survivorship-free, deflation-gated research apparatus that reaches truthful conclusions is the asset.
- **Stop building more aggregate market-timing composites** expecting a different result — 5/5 came back beta.

## The one open caveat (operator paid-data decision — Q-9)
The survivorship-free single-stock test ran on a **~1.7-year window** (Polygon FREE tier covers only
~2024-06→present; deep history is paid). That window has limited statistical power — it rules out a
*strong* survivorship-free edge but cannot definitively exclude a *faint* one (e.g. the mid-cap cell that
passed 2 of 4 gates). Resolving that would require **paid deep-history data** (Polygon Starter / Sharadar /
CRSP) for a 2008-2026 survivorship-free panel — a paid-data trigger, operator-gated.
**Orchestrator recommendation: NOT worth the spend on current evidence** — the mid-cap cell's OOS
sign-flip is a stronger signal of overfitting than of latent alpha. Concluding the null is the honest call;
the paid-data path is documented as the only legitimate (non-shopping) way to revisit it later.

## What this ADR does NOT decide
- Whether to pursue paid deep-history (operator's call; recommended against).
- Whether to keep the live per-symbol *analysis* tool (Bigdata.com-based decision-support, unaffected by
  this null — it makes no alpha claim).
- The 13d_g base-filing ingest bug + eight_k pooled rebuild (deferred; low priority given the null).
