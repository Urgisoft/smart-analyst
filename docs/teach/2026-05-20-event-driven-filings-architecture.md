# Event-driven filings — architecture choices for gap #7

> **Companion to:** [docs/specs/event-driven-filings-processor.md](../specs/event-driven-filings-processor.md)
> **Date:** 2026-05-20
> **Sources:** Lerman-Livnat 2010 *Review of Accounting Studies* (8-K information content); Cohen-Malloy-Pomorski 2012 *Journal of Finance* (opportunistic-vs-routine insiders); Lakonishok-Lee 2001 *RFS* (insider return predictability); Seyhun 1986 *JFE* (foundational); Brav-Jiang-Partnoy-Thomas 2008 *Journal of Finance* (activist 13D); 17 CFR 240.16a / 249.308.

This teach-doc walks the three load-bearing methodology choices in the gap #7 SPEC. Each is a "canon-thin fork" — multiple legitimate paths existed; I picked one and you should understand why before reviewing the SPEC. If any of these are wrong, the v1 composites will need substantive rework.

## 1 — Why two parallel composites, not one combined

**Intuition.** The gap doc and the HANDOFF frame gap #7 as a single workstream ("event-driven filings processor"). It's tempting to ship one composite that fuses everything — 8-K material events + Form 4 insider trades — into a unified "institutional conviction" signal per ticker. But fusing them forces an invented weighting (how much does an 8-K impairment matter relative to an insider's $2M open-market buy?), and there is no canon that prescribes that weighting. Whichever number you pick, you picked it by looking at the data — which is the textbook definition of in-sample tuning, and Bailey-Lopez de Prado 2014 + Harvey-Liu-Zhu 2016 are explicit that this is the path to inflated Sharpe ratios.

**Mechanism.** The three-criterion canon-thin test from CLAUDE.md:

1. **Canon foundations** — 8-K abnormal-return literature anchors on Lerman-Livnat 2010 (which classifies by SEC item code, not by free text). Form 4 literature anchors on Seyhun 1986 → Lakonishok-Lee 2001 → Cohen-Malloy-Pomorski 2012, all of which treat insider transactions as a standalone signal. No paper combines them.
2. **Methodology rigor** — combining heterogeneous event streams (binary event indicators vs dollar-weighted transactions) requires either (a) normalizing both to z-scores then averaging — which double-counts the deflation pipeline's variance assumptions — or (b) picking a $-weight equivalent for events — which is unbacked by any literature. Both paths break the deflation pipeline's free-parameter accounting.
3. **Free parameters** — two siblings: 0 cross-source weights. Combined: ≥1 cross-source weight. Each parameter is an extra degree of freedom that an honest deflation pipeline must "charge" against your reported Sharpe.

We picked Path α (two siblings). Each composite is internally self-consistent + grounded in its own Tier-1 canon citation. A future v2 ADR could fuse them once Phase B reveals empirical reasons to, but that ADR would need to confront the free-parameter cost openly rather than hide it inside a "combined signal."

**Failure mode.** The two-composite path doubles the slice count for gap #7 (~10-11 commits vs ~5-6). If we discover halfway through that the two signals are highly correlated empirically (e.g., 8-K material events and insider cluster-sells co-occur at >0.8 correlation), we will have shipped redundant infrastructure. This is the bet we're making: Phase B can decide later whether to keep both, drop one, or fuse them — but v1 ships with the honest accounting.

## 2 — Why daily-daemon, not event-driven polling

**Intuition.** The gap doc's whole framing is "event-driven" — the filings happen at any time of day, the SEC publishes them in real-time, so naturally the processor should poll EDGAR continuously and react to each new filing as it appears. The problem is that the operational cost of that architecture (process supervision, retry-under-failure, dedupe-under-concurrent-polling, poll-frequency tuning) is high, and there is no academic evidence that the intra-day latency matters for the institutional signals we're capturing.

**Mechanism.** The literature on event-study returns around 8-K filings (Lerman-Livnat 2010 + many follow-ups) and around Form 4 trades (Lakonishok-Lee 2001; CMP 2012) measures abnormal returns over windows of *days to weeks*, not hours. The 8-K Item 2.06 (material impairment) abnormal-return literature, for example, documents a 3-5% cumulative abnormal return over a 30-day post-filing window. Whether you capture the signal at filing time + 4 hours or filing time + 23 hours is essentially noise relative to the underlying signal.

Three-criterion test:

1. **Canon foundations** — no canon prescribes daily-vs-real-time cadence. Event-study methodology (Warner-Watts-Wruck 1988) operates at daily resolution.
2. **Methodology rigor** — switching to event-driven adds operational complexity that has to be debugged, monitored, and maintained. The complexity has no upstream methodology requirement.
3. **Free parameters** — daily daemon = 0 new parameters (it reuses the existing daemon's machinery). Event-driven adds: poll interval (default 30min? 15min? 1h?), batch size, retry policy, dedupe-window, max-concurrent-polls. Each is a knob; each is unbacked by canon.

We picked daily-daemon for v1. The latency cost is bounded — worst case 23h, typical 12h for a US-market-close filing.

**Failure mode.** If Phase B reveals that the signal decays sharply within the first few hours post-filing (e.g., institutional flow has front-run the signal by the next daemon run), we will need to revisit. A reasonable test for v2 ADR: run a daily-daemon snapshot + an event-driven snapshot in parallel for 90 days, compare per-event lag distributions, and measure whether the daily-snapshot signal's predictive power degrades meaningfully. If it does, promote to event-driven; if it doesn't, don't.

## 3 — Why no Cohen-Malloy-Pomorski opportunistic-vs-routine classifier in v1

**Intuition.** Cohen-Malloy-Pomorski 2012 is *the* foundational refinement of the Form 4 signal. They showed that lumping all insider trades together masks a sharp distinction: insiders have personal patterns (Q1 sells for taxes, vesting-period sells, scheduled diversification), and trades that *deviate* from those personal patterns predict returns far more strongly (~6% annualized) than trades that fit the pattern (near-zero). It's the strongest single piece of insider-trading literature in the canon. Why are we deferring it?

**Mechanism.** The CMP classifier has a structural cold-start problem. To classify a new trade as "opportunistic" (deviating from personal pattern) or "routine" (fitting it), you need a sufficient personal history for that insider — CMP use 5+ trades over 3+ years per their methodology. At first-run of `form_4_insider_v1`, our `insider_trades` table is empty. Even after 6 months of ingest, most insiders in the equity-midcap universe will have 0-3 trades in our system, well below the classifier's threshold.

Three-criterion test:

1. **Canon foundations** — CMP is *the* canon. This is the strongest "yes, do this" path of the three forks. But — the canon assumes a fully-warmed-up history that we don't have.
2. **Methodology rigor** — running the classifier on insufficient histories produces noisy / wrong classifications. CMP themselves use a 5-trade-minimum + 3-year-history filter; below the floor, the classifier is silent. v1 with the classifier would be silent on >95% of insiders.
3. **Free parameters** — the classifier adds: history-length floor, pattern-detection bandwidth (months of seasonal pattern smoothing), deviation threshold. ~3 new parameters with no canon-prescribed defaults.

We picked the raw-activity-only path (no classifier) for v1. The Seyhun 1986 + Lakonishok-Lee 2001 canon does support a weaker but legitimate signal at the raw-cluster level (3+ insiders buying in 30d, the gap-doc-named threshold). It's a meaningfully smaller predictive signal than CMP's opportunistic-trade signal, but it's an honest v1.

**Failure mode.** If Phase B (after ~6+ months of v1 ingest builds up per-insider history) reveals that the raw-cluster signal has ~0 predictive power and only the CMP-classifier signal would, we shipped an informational signal that doesn't actually inform. A v2 ADR enabled by 6 months of accumulated history would then add the classifier. The risk is real but bounded — v1 still captures the bigger gap (we have no insider signal at all today), and the Phase B validation gates on real data anyway.

## Why these matter for review

If you push back on any of these three choices, here's what changes:

- **Push back on "two composites, not one":** I rework §2.1 + §3 + §10 to ship a single combined composite. ~3 fewer slices but the SPEC's free-parameter accounting gets uglier (need to specify the cross-source weight + justify it). Phase B validation becomes harder because the combined signal can't be decomposed back into its sources.
- **Push back on "daily daemon, not event-driven":** I rework §3 + §7 + §10 to ship an event-driven poller. Adds ~3-4 slices (process supervisor + state-machine + dedupe layer + tests). Operationally heavier to maintain. v1 ships later.
- **Push back on "no CMP classifier":** I rework §2.3 + §5.3 to ship the classifier. Add ~1 slice for the per-insider history-fitter. v1 signal becomes much sparser (most insiders below history floor) but theoretically stronger when it does fire. Phase B can't validate until ~6 months of warm-up.

Any one of these is reversible at SPEC time. After A1 ships, they become harder to unwind.

Other choices in the SPEC that are *not* canon-thin and don't warrant teach-doc treatment (settled by code-as-canon — established Layer-0 conventions across the seven prior composites): 90d window, 2y baseline, MIN_Z_BASELINE=30, equity-midcap per-stock universe, SPY-500 PIT aggregate universe, ReplacingMergeTree dedupe, acceptance-date anti-leak gate, |z|>2 cluster threshold, JSON-payload snapshot schema, byte-equal section-append discipline. These follow the same convention as cycle / vol / sector / cross-asset / short-interest / exec-departure / etf-flow.
