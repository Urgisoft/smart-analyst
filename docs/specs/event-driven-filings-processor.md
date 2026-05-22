---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
slice_id: gap-7-event-driven-filings
---

# SPEC — Event-Driven Filings Processor (eight_k_classifier_v1 + form_4_insider_v1)

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-20 · **Author:** Claude (Vector Core principal engineer) · **Phase:** 9-gap unfreeze (gap #7) · **Authority:** [gap doc](../obsidian/gaps/event-driven-filings-processor.md), Lerman-Livnat 2010 *Review of Accounting Studies* (8-K information content), Cohen-Malloy-Pomorski 2012 *Journal of Finance* (opportunistic-vs-routine insiders), Lakonishok-Lee 2001 *RFS* (insider-trading return predictability), Seyhun 1986 *JFE* (foundational insider-trading evidence), 17 CFR 240.16a (Form 4 statutory basis), 17 CFR 249.308 (Form 8-K item structure)
>
> **Stage in Vector Core build:** SPEC → CODE (Phase A only — informational substrate). Phase B (validation with the standard deflation pipeline — DSR, PBO, HLZ — per operator directive) deferred per the cycle / vol-structure / sector-rotation / cross-asset / short-interest / exec-departure / etf-flow precedent: ship informational first, validate after 60+ days OR via a dedicated backfill arc.
>
> **Lineage:** The eighth Phase-9-gap arc, but the first to ship **two parallel Layer-0 composites** under one gap. Prior arcs (`cycle_v1`, `vol_struct_v1`, `sector_rot_v1`, `cross_asset_v1`, `short_interest_v1`, `exec_departure_v1`, `etf_flow_v1`) each shipped a single composite. Gap #7 ships:
>
> - **`eight_k_classifier_v1`** — extends gap #8's narrow Item 5.02 cut to the broader 8-K item space (1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01 as "material events"; rest tracked-but-not-flagged).
> - **`form_4_insider_v1`** — open-market insider purchases + sales per Form 4, with cluster-buy / cluster-sell flags. Cohen-Malloy-Pomorski opportunistic-vs-routine classifier deferred to v2 ADR.
>
> Same architectural template per composite: A1 (EDGAR ingest) → A2 (pure composite + tests) → A3 (CH snapshot table + raw-event migration) → A4 (repository + daemon hook) → A5 (morning brief section). 8-K composite ships first (steps 1k + section #14); Form 4 second (steps 1l + section #15).
>
> **Three canon-thin forks resolved autonomously under CLAUDE.md three-criterion test:**
>
> 1. **EDF-1 (composite shape)** — TWO parallel composites, not one combined. Combining 8-K events with Form 4 dollar flows would force an invented cross-source weighting with no canon backing. Resolved: ship as two siblings; each has its own canon-load-bearing citation; zero cross-source free parameters. (See §2 row EDF-1.)
> 2. **EDF-2 (cadence)** — daily-daemon, NOT event-driven polling. The gap doc's framing implies real-time architecture; v1 keeps the established Layer-0 daily-snapshot pattern. Latency cost bounded (worst 23h, typical 12h for a US-market-close filing). Event-driven promotion deferred to v2 ADR once Phase B validates the signal warrants infrastructure investment. (See §2 row EDF-2.)
> 3. **EDF-3 (13D / 13G inclusion)** — OUT-OF-SCOPE v1. Activist-13D canon (Brav-Jiang-Partnoy-Thomas 2008) is a distinct literature with its own filer-reputation classification problem (well-known activist vs first-time filer vs long-term holder). Deserves its own SPEC. Queued for v2 ADR or separate gap arc. (See §2 row EDF-3.)

---

## §1 · Goals and non-goals

**Goals:**

1. Extend the Layer-0 informational substrate with TWO event-driven filing signals:

   **(A) 8-K material-event classifier** — for each ticker in the equity-midcap universe, surface item-coded flags for high-signal 8-K filings within a trailing 90-calendar-day window:
   - `material_event_flag` — any high-signal item (1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01) in window
   - `impairment_flag` — Item 2.06 in window
   - `restatement_flag` — Item 4.02 in window
   - `auditor_change_flag` — Item 4.01 in window
   - `delisting_flag` — Item 3.01 in window
   - `control_change_flag` — Item 5.01 in window
   - `material_agreement_flag` — Item 1.01 in window
   - `acquisition_disposition_flag` — Item 2.01 in window

   Plus aggregate **sector-clustering**: count of material-event filings per GICS sector ∩ SPY-500 PIT panel, z-scored against trailing 2y baseline; `eight_k_cluster_flag` fires on any sector with `|z| > 2.0`.

   **(B) Form 4 insider-activity signal** — for each ticker in the equity-midcap universe, surface trailing-90d open-market insider activity:
   - `insider_buy_count_90d` — # Form 4 open-market purchases (transaction code "P")
   - `insider_sell_count_90d` — # Form 4 open-market sales (transaction code "S")
   - `insider_net_dollar_90d` — sum(buy $) − sum(sell $) over the window
   - `insider_buyer_count_90d` — # distinct insiders who bought in window
   - `insider_seller_count_90d` — # distinct insiders who sold in window
   - `insider_cluster_buy_flag` — ≥3 distinct insiders bought (transaction code "P") within trailing **30 calendar days**
   - `insider_cluster_sell_flag` — ≥3 distinct insiders sold (transaction code "S") within trailing **30 calendar days**

   Plus aggregate **sector-clustering**: count of cluster-buy events per GICS sector, z-scored against trailing 2y baseline; `form_4_cluster_flag` fires on any sector with `|z| > 2.0`.

2. Persist daily snapshots to TWO snapshot tables:
   - `quantlab.eight_k_classifier_snapshots`
   - `quantlab.form_4_insider_snapshots`

3. Surface two sections in the morning operator brief: **#14 (8-K classifier)** and **#15 (Form 4 insider)**, appended last to preserve byte-equal-stdout protection on sections #1-#13.

**Non-goals:**

1. **No `phase1_v3` modification.** Neither aggregate flag adds a category in v1; promotion to classifier input gates on Phase B independence test + a new ADR. Matches the cycle / vol / sector / cross-asset / short-interest / exec-departure / etf-flow posture.
2. **No universe-filter gating.** Per Phase 9+ gap-inventory principle #5 ("informational-first before gating"), per-stock flags are LOGGED — no hard exclusion of any ticker in v1.
3. **No paid data sources.** SEC EDGAR is the only data source for both composites (free, official, pre-authorized per CLAUDE.md data-source policy).
4. **No Form 4 routine-vs-opportunistic classifier in v1.** Cohen-Malloy-Pomorski 2012's classifier requires multi-year per-insider history to detect personal patterns; the cold-start problem is severe (the operator would have ~0 baseline insiders with sufficient history at first-run). v2 ADR with explicit free-parameter accounting. (See §2 row F4-1.)
5. **No insider-role weighting in v1.** Director vs Officer vs 10%-Holder roles logged at ingest; all weighted 1.0 in the composite. v2 ADR can add role weights if Phase B reveals value-add. (See §2 row F4-3.)
6. **No 8-K free-text NLP.** v1 reads item-code structure only. Free-text classification of "what happened in the 8-K" deferred (matches gap #8 E-2). (See §2 row EK-2.)
7. **No 13D / 13G inclusion (EDF-3 above).** Ownership-crossing filings have their own canon and their own filer-classification problem; queued for v2.
8. **No event-driven architecture (EDF-2 above).** Daily-daemon cadence v1; real-time polling deferred to v2.
9. **No backfill of pre-existing historical filings.** EDGAR's archive goes back to 1994; backfill IS possible but is operator-deferred (same posture as gap #8 / gap #9 / gap #10).
10. **No 8-K amendment-supersedure handling.** `8-K/A` filings are treated as new events additively; substantive correction-tracking deferred to v2.
11. **No dashboard React panel in v1** (carry from S-VOL-4 / S-SR-4 / S-CA-4 / S-SI-9 / S-ED-8 / F-PANEL — operator attention budget is finite).

---

## §2 · Decisions (locked at SPEC time)

### §2.1 · Gap-level decisions (govern both composites)

| ID | Decision | Rationale |
|----|----------|-----------|
| **EDF-1** | **Two parallel composites, not one combined.** Gap #7 ships `eight_k_classifier_v1` and `form_4_insider_v1` as siblings. Each has its own A1-A5 arc, its own snapshot table, its own brief section, its own version stamp. The 8-K composite ships before Form 4 to honor the HANDOFF's "8-K broader + Form 4" ordering. | Three-criterion canon-thin resolution: (1) **Canon foundations** — Lerman-Livnat 2010 anchors 8-K abnormal-return literature; Seyhun 1986 / Lakonishok-Lee 2001 / Cohen-Malloy-Pomorski 2012 anchor Form 4 literature. No single citation supports a combined signal. (2) **Methodology rigor** — combining heterogeneous streams (binary event indicators + dollar transaction flows) forces an invented aggregation rule that violates Bailey-Lopez de Prado 2014 no-in-sample-tuning canon (the weight would necessarily be chosen against the same data used to validate the combined signal). (3) **Free parameters** — two siblings = 0 cross-source weights; combined = ≥1 cross-source weight. Matches gap #8 E-11 precedent ("Path-α 8-K only over path-β 8-K+Form 4 combined"). |
| **EDF-2** | **Daily-daemon cadence, NOT event-driven polling.** Both composites re-evaluate on every daemon run; on days with no new filings, the rolling-window state is unchanged from the prior snapshot (events naturally age out of the 90d / 30d windows). | Three-criterion: (1) **Canon foundations** — no canon prescribes daily-vs-real-time cadence; Warner-Watts-Wruck 1988 event-study methodology operates at the daily event horizon. (2) **Methodology rigor** — switching to real-time polling adds process-supervision, retry, and dedupe-under-concurrent-polling complexity without canon backing. (3) **Free parameters** — daily-daemon = 0 new parameters; event-driven = N (poll interval, batch size, retry policy, dedupe window). Latency cost bounded: 8-K 4bd statutory deadline → daemon catches all filings within 1bd. Form 4 2bd deadline → daemon catches all within 1bd. v2 ADR can promote to event-driven if Phase B reveals 4-23h latency is decision-affecting. |
| **EDF-3** | **13D / 13G filings OUT-OF-SCOPE v1.** Queued for v2 ADR or separate gap arc. | Three-criterion: (1) **Canon foundations** — Brav-Jiang-Partnoy-Thomas 2008 ("Hedge Fund Activism, Corporate Governance, and Firm Performance") *J. Finance* anchors activist-13D canon; passive 13G has a separate (thinner) literature. The activist-vs-passive split is methodologically non-trivial. (2) **Methodology rigor** — meaningful 13D signal requires filer-reputation classification (well-known activist vs first-time vs long-term holder); the filer table is a heavy infrastructure addition without canon-prescribed taxonomy. (3) **Free parameters** — including 13D/13G in v1 would add the filer-reputation table + the activist-vs-passive weighting (≥2 free parameters) without offsetting canon backing. Defer. |
| **EDF-4** | **Reuse `quantlab.cik_ticker_map` from gap #8.** Both ingests resolve issuer CIK → ticker via the EDGAR submissions API and write to the existing `cik_ticker_map` table. No new resolution infrastructure. | Established pattern from gap #8 A1. The submissions API + `formerNames` chain handles ticker swaps / mergers. Cache is per-CIK; both 8-K-ingest and Form 4-ingest populate the same table; lookups are read-mostly. |
| **EDF-5** | **Acceptance-date anti-leak gate (matches gap #8 E-7).** Both ingests reject filings whose `accepted_at > snapshot_date`. `period_of_report` is forensic only; never used in window calculations or in the daemon-snapshot-as-of-D filter. | Load-bearing protection against look-ahead leakage in Phase B backtests. The acceptance date is the wall-clock moment EDGAR ingested the filing and made it public; the period-of-report can be retroactively dated up to 4bd earlier (8-K) or to the transaction date (Form 4). Bypassing this gate is the most common path to silent look-ahead bias. |
| **EDF-6** | **Window choices: 90d per-stock for 8-K + Form 4 cumulative metrics; 30d per-stock for Form 4 cluster-buy / cluster-sell; 2y per-sector baseline for aggregate z-scores.** Inherits the gap #8 + gap #9 + gap #10 90d / 2y conventions; the 30d window for Form 4 clustering is gap-doc-derived ("3 insiders in 30 days OR 5 in 60 days?" → picks 3-in-30 as the simpler floor; see §2 row F4-2). | 90d matches the quarter cadence; 2y matches the cycle / cross-asset / short-interest / exec-departure baseline standard. 30d for Form 4 cluster matches the gap doc's faster-signal posture for Form 4 specifically (insider trading windows are weeks, not months). All windows static + non-tunable. |
| **EDF-7** | **Aggregate baseline floor: `MIN_Z_BASELINE = 30` prints (matches all prior six Layer-0 composites).** Below the floor, `aggregate_z = null` and the cluster flag = false. | Established constant. Protects against early-life z-scores in newly-bootstrapped histories. Byte-identical to short-interest / exec-departure / etf-flow / cross-asset / sector-rotation. |
| **EDF-8** | **Per-stock universe: equity-midcap (~60 tickers, matches gap #8 + gap #9 / short-interest precedent). Aggregate universe: SPY-500 PIT constituents per `quantlab.sp500_constituents`, sliced by GICS sector via the existing SPDR-sector mapping.** Both composites share these universes. | Established convention from gap #8 E-6. Per-stock signals are narrowly applied to the watch universe; aggregate signals need broad coverage. Single source of truth for both composites avoids universe-drift issues. |
| **EDF-9** | **Daemon hook positions: 1k (8-K classifier), 1l (Form 4 insider). Brief sections: #14 (8-K), #15 (Form 4).** Appended last per the established byte-equal-stdout-protection invariant. | Hook chain: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → 1l form-4 → §2 cells/bundles`. Brief sections #1-#13 unchanged. |
| **EDF-10** | **EDGAR ingest infrastructure: extends `scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 A1).** Both new ingests reuse the rate-limit + 429-backoff + User-Agent + acceptance-date-filter helpers from that script, refactored into a shared module `scripts/_sec_edgar_helpers.py`. | The gap #8 ingest established the SEC EDGAR contract: 10 req/sec rate limit, contact-info User-Agent, 1.0s back-off + retry, ReplacingMergeTree on (cik, accession, ...) for idempotent re-runs. Refactoring into a shared helper module avoids duplication; the gap #8 script is updated to import-from-helpers (compatible — no behavior change). |

### §2.2 · 8-K classifier decisions (`eight_k_classifier_v1`)

| ID | Decision | Rationale |
|----|----------|-----------|
| **EK-1** | **High-signal item set = {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01}.** All other 8-K items are tracked at the ingest layer (forensic) but NOT flagged by the composite. | Lerman-Livnat 2010 §4 documents that abnormal-return reactions concentrate in a subset of 8-K items. The chosen set covers (a) negative-news items where Lerman-Livnat document material reactions: 2.06 (impairment), 3.01 (delisting), 4.02 (restatement); (b) high-information items where the disclosure itself is the news: 1.01 (material agreement), 2.01 (acquisition completion), 5.01 (change in control); (c) auditor change (4.01) where ~50% of cases are distress-flagged per Hennes-Leone-Miller 2014. Excluded: 2.02 (earnings — captured by separate price/volume signal), 5.07 (vote results — scheduled), 7.01 (Reg FD — heterogeneous), 8.01 (other events — catch-all). No 5.02 (gap #8 already covers it). |
| **EK-2** | **Item-code-only classification.** No free-text NLP / regex on the filing body to interpret "what happened" within an item. Each filing × item pair expands to one row in the source table; the composite reads counts of {(ticker, item) tuples}-in-window. | Three-criterion canon-thin resolution: (1) Item code is SEC-structurally encoded with zero ambiguity per 17 CFR 249.308. (2) Free-text NLP on 8-K bodies is fragile (SEC boilerplate changes; per-item phrasing varies). (3) Zero free parameters vs N for any text-pattern library. Matches gap #8 E-2. |
| **EK-3** | **Per-stock 90d window per high-signal item.** Per-stock flags fire if any qualifying 8-K (matching the item code) is in `[D - 90d, D]`. Multiple filings of the same item code within window count once toward the flag (the flag is binary); the underlying count is exposed in the snapshot for forensic inspection. | Window matches gap #8 E-3 + gap-level EDF-6. Binary flag matches gap #8 per-stock convention. |
| **EK-4** | **Aggregate clustering: per-sector count of `material_event_flag` events, z-scored against trailing 2y baseline.** `event_rate_s(t) = count(distinct (ticker, accession) filings : sector(ticker) = s, item ∈ high-signal-set, accepted_at ∈ [D - 90d, D]) / sector_size_s`. Cluster flag fires on `|z_s| > 2.0`. | Mirrors gap #8 E-4 structure (departure-rate per sector) and the cross-asset / short-interest |z|>2 aggregate threshold. Distinct on `(ticker, accession)` so a single filing with multiple high-signal items counts once (avoids double-counting an 8-K with both 2.06 + 4.02). |
| **EK-5** | **Storage: NEW table `quantlab.eight_k_events` (parallel to `executive_departures`).** Schema mirrors `executive_departures` byte-for-byte except `sub_item_code` is replaced by `item_code` (the broader 8-K item, e.g. `2.06` rather than `5.02(b)`). The gap #8 5.02-specific table stays unchanged; the new table holds ALL 8-K items including a redundant copy of 5.02. | The duplication is intentional: gap #8 composite continues to read `executive_departures` (it uses sub-item parsing the broader script doesn't do); gap #7 composite reads `eight_k_events`. Cost ~560 issuer × ~3-5 8-K filings per issuer per year ≈ ~2000 rows/year of duplication — negligible. Avoids destructive refactor of gap #8's working infrastructure. |
| **EK-6** | **Ingest: NEW script `scripts/sec_edgar_8k_event_ingest.py`** (sibling of gap #8's `sec_edgar_8k_item_5_02_ingest.py`). Uses `--items` flag (default = "1.01,2.01,2.06,3.01,4.01,4.02,5.01") to filter. Reuses gap #8 helpers (rate-limit, User-Agent, acceptance-date filter, CIK→ticker resolver, submissions cache). | Sibling script not refactor of gap #8 script. The two scripts share the helper module per EDF-10. The gap #8 script does sub-item-code body parsing (regex on "Item 5.02(b)"); the new script does ITEM-level parsing only (no sub-letter needed for 1.01-5.01). |
| **EK-7** | **Snapshot version stamp: `eight_k_classifier_v1`.** Bumps on high-signal-item-set change (add/remove items), window change (90d → 60d or 120d), aggregate threshold change (`|z|>2.0 → |z|>2.5`), universe change. | Matches the Layer-0 convention across all prior composites. |
| **EK-8** | **Brief section: #14.** Appended after section #13 (etf-flow). Renderer must not modify the byte-equal output of sections #1-#13. | Established byte-equal-protection invariant. The section type is shaped to render aggregate + per-ticker flagged list + universe-coverage line; per-ticker JSON full panel queryable from CH snapshot (not threaded through the brief). |

### §2.3 · Form 4 insider decisions (`form_4_insider_v1`)

| ID | Decision | Rationale |
|----|----------|-----------|
| **F4-1** | **No routine-vs-opportunistic classifier in v1.** All open-market Form 4 transactions count equally in the per-stock + aggregate metrics. Cohen-Malloy-Pomorski 2012 classifier deferred to v2 ADR. | Three-criterion canon-thin: (1) **Canon foundations** — CMP 2012 is the strong Tier-1 anchor for the opportunistic-vs-routine distinction; the v1-without-classifier signal still has Seyhun 1986 + Lakonishok-Lee 2001 as canon support for raw insider-activity predictive content (smaller magnitude but well-documented). (2) **Methodology rigor** — CMP's classifier requires multi-year per-insider history to detect personal seasonal patterns; the cold-start at first-run is severe (insiders need ≥5 historical trades for classification). v1 would be classifier-disabled for nearly all insiders. (3) **Free parameters** — classifier-included = N (history-length floor, pattern-detection bandwidth, opportunistic-vs-routine threshold); raw-activity-only = 0 free parameters beyond the cluster floor (F4-2). Resolved: ship raw signal first; v2 ADR adds classifier once per-insider history baseline exists. |
| **F4-2** | **Cluster-buy / cluster-sell flags: ≥3 distinct insiders within 30 calendar days, same direction.** Triggers `insider_cluster_buy_flag` (3+ distinct insiders bought, transaction code "P") or `insider_cluster_sell_flag` (3+ distinct insiders sold, transaction code "S"). Distinct on insider identity (`person_cik`), not on filing — a single insider filing 3 separate buys in 30d counts as 1 insider, not 3. | Three-criterion canon-thin: (1) **Canon foundations** — gap doc explicit OQ ("3 in 30 OR 5 in 60?"); Seyhun 1986 + Lakonishok-Lee 2001 document weak per-trade signal that strengthens with cluster patterns. The exact cluster threshold isn't canon-prescribed. (2) **Methodology rigor** — 3-in-30 is the simpler test (lower threshold, faster signal); 5-in-60 is more restrictive but introduces TWO free parameters where 3-in-30 introduces a single threshold (the window is fixed at gap-level EDF-6). (3) **Free parameters** — 3-in-30 = 1 parameter (the 3-insider count); 5-in-60 = 2 (count + window). Resolved: 3-in-30. v2 ADR can sensitivity-test if Phase B reveals miscalibration. |
| **F4-3** | **No insider-role weighting in v1.** Insider role (Director / Officer / 10%-Holder / Other) logged at ingest; the composite weights each at 1.0. | Three-criterion: (1) Canon-thin for role weighting (Lakonishok-Lee 2001 §4 documents weak role differentiation; CEO trades show slightly stronger predictability but not enough to anchor a weighting table). (2) Role-weight table = N free parameters (one per role tier). (3) Resolved: skip in v1; v2 ADR can add weights if Phase B reveals value-add. Matches gap #8 E-5 ("no severity weighting"). |
| **F4-4** | **Open-market transactions only: transaction codes "P" (purchase) and "S" (sale).** All other transaction codes (A grants, M exercises, F payments, G gifts, etc.) are stored at ingest but excluded from the composite. | Lakonishok-Lee 2001 §3 standard filter. CMP 2012 same filter. Stock-based-comp grants and option exercises are NOT informative about discretionary trading conviction (the timing is externally constrained); filtering to P + S isolates the discretionary signal. |
| **F4-5** | **Net dollar flow over 90d window:** `insider_net_dollar_90d = Σ(buy_$ for P trades in window) − Σ(sell_$ for S trades in window)`. Where `trade_$ = shares × price_per_share` per the Form 4 disclosed transaction details. | Per-stock dollar-net is the gap-doc-implied metric for size-weighted insider conviction. Standard construction (no canon dispute). |
| **F4-6** | **Aggregate clustering: per-sector count of `insider_cluster_buy_flag` events, z-scored against trailing 2y baseline.** Same shape as EK-4 but the underlying event is "ticker has cluster-buy flag fired today" rather than "ticker has material-event flag fired today". Cluster flag fires on `|z_s| > 2.0`. | Mirrors EK-4 + gap #8 E-4. The aggregate is a count-of-clusters not a count-of-trades; this correctly weights by issuer count not by trade volume (avoiding a single mega-insider mega-cluster dominating the sector signal). |
| **F4-7** | **Storage: NEW table `quantlab.insider_trades`.** One row per Form 4 disclosed transaction (a single Form 4 filing can disclose multiple transactions; each expands to its own row). | Form 4's data shape (transactional with $ + shares + insider ID per row) is fundamentally different from 8-K's (event indicator with item code). Separate table. ReplacingMergeTree on `(accession, transaction_id)` for idempotent re-runs (transaction_id is the per-Form-4-row index 0-based, since SEC doesn't assign a global transaction key). |
| **F4-8** | **Ingest: NEW script `scripts/sec_edgar_form4_ingest.py`.** Reuses gap #8 EDGAR helpers (rate-limit, User-Agent, CIK→ticker resolver) but Form 4 is XML-encoded (not HTML) — the XML namespace is `http://www.sec.gov/edgar/ownershipDocument`. New parser for the Form 4 XML schema. | Form 4 has a well-defined XSD; parsing is structural (xml.etree). The per-form-4 XML contains `<reportingOwner>` (insider identity + role) and `<nonDerivativeTable>` (transactions). Parser writes one `quantlab.insider_trades` row per `<nonDerivativeTransaction>` element with code "P" or "S". Derivative-table transactions (options) excluded per F4-4. |
| **F4-9** | **Insider identity: track `person_cik` (SEC's insider-level CIK, distinct from issuer CIK).** The distinct-insider count for cluster flags uses `person_cik` (NOT name string). The SEC submissions API also resolves insider CIK → insider name; we cache that in `quantlab.insider_ciks` (NEW). | Person CIKs are stable across name changes / role changes; name strings are not. Cluster threshold (F4-2) operates on distinct `person_cik`. The insider name cache supports brief rendering ("CEO bought 50K shares") in future enhancements; v1 brief uses ticker-level aggregates only. |
| **F4-10** | **Acceptance-date anti-leak gate (EDF-5).** Daemon snapshot dated D reads Form 4 filings with `accepted_at ≤ D`; rejects all later. The Form 4 disclosed `transactionDate` field can be 1-2 business days before `accepted_at` (insiders have 2bd to file post-trade). The transaction date is forensic only; window membership is determined by `accepted_at`. | Same load-bearing protection as gap #8 E-7. Bypassing this gate (e.g., using `transactionDate` for window membership) would inject look-ahead leakage in Phase B backtests. |
| **F4-11** | **Snapshot version stamp: `form_4_insider_v1`.** Bumps on transaction-code filter change (add/remove codes from {P, S}), cluster threshold change (3 → 5 insiders), cluster window change (30d → 60d), per-stock window change (90d → 60d), aggregate threshold change. | Matches Layer-0 convention. |
| **F4-12** | **Brief section: #15.** Appended after section #14 (8-K). Renderer must not modify sections #1-#14. | Established byte-equal-protection invariant. |

---

## §3 · Component diagram

```text
                              ┌──────────────────────┐
                              │ SEC EDGAR            │
                              │   - Full-text search │     pre-authorized per
                              │     API (efts...)    │     CLAUDE.md
                              │   - Submissions API  │     data-source policy
                              │     (data.sec.gov)   │
                              │   - Form 4 XML       │
                              │     (Archives/...)   │
                              └─────────┬────────────┘
                                        │ 8-K: 4bd deadline (Sarbanes-Oxley §409)
                                        │ Form 4: 2bd deadline (17 CFR 240.16a-3)
                            ┌───────────┴────────────┐
                            ▼                        ▼
              ┌──────────────────────┐   ┌──────────────────────┐
              │ scripts/             │   │ scripts/             │
              │   sec_edgar_8k_      │   │   sec_edgar_form4_   │
              │   event_ingest       │   │   ingest             │
              │   .py                │   │   .py                │
              └─────────┬────────────┘   └─────────┬────────────┘
                        │                          │
                        │ writes to                │ writes to
                        ▼                          ▼
              ┌──────────────────────┐   ┌──────────────────────┐
              │ quantlab.            │   │ quantlab.            │
              │   eight_k_events     │   │   insider_trades     │
              │   (per-filing)       │   │   (per-transaction)  │
              └─────────┬────────────┘   └─────────┬────────────┘
                        │ daemon read              │ daemon read
                        ▼                          ▼
              ┌──────────────────────┐   ┌──────────────────────┐
              │ src/server/          │   │ src/server/          │
              │   eight_k_           │   │   form_4_insider     │
              │   classifier.ts      │   │   .ts                │
              │   (pure composite)   │   │   (pure composite)   │
              └─────────┬────────────┘   └─────────┬────────────┘
                        ▼                          ▼
              ┌──────────────────────┐   ┌──────────────────────┐
              │ quantlab.            │   │ quantlab.            │
              │   eight_k_           │   │   form_4_insider_    │
              │   classifier_        │   │   snapshots          │
              │   snapshots          │   │                      │
              └─────────┬────────────┘   └─────────┬────────────┘
                        ▼                          ▼
                  daemon step 1k             daemon step 1l
                  scripts/daily_signal_daemon.ts
                        │                          │
                        ▼                          ▼
                  brief section #14          brief section #15
                  src/server/operator_brief*.ts


  Shared infrastructure (used by both ingests):
   - scripts/_sec_edgar_helpers.py   (rate-limit, User-Agent, 429 retry,
                                       acceptance-date filter, CIK→ticker
                                       submissions-API resolver)
   - quantlab.cik_ticker_map         (from gap #8, reused — same DDL)
   - quantlab.insider_ciks           (NEW for Form 4: insider person_cik → name)
```

---

## §4 · Inputs (per EDF-4 / EDF-5 / EK-5 / F4-7)

### §4.1 · 8-K classifier inputs

| Source | Field | CH destination | Notes |
|--------|-------|----------------|-------|
| SEC EDGAR full-text search API (`efts.sec.gov/LATEST/search-index`) | accession number | `eight_k_events.accession` | Unique per filing; primary key. |
| SEC EDGAR full-text search API | CIK | `eight_k_events.cik` | Issuer key; resolved via `cik_ticker_map`. |
| SEC EDGAR full-text search API | form type | `eight_k_events.form_type` | Always `8-K` or `8-K/A`. |
| SEC EDGAR full-text search API | item codes (from `items` field) | `eight_k_events.item_code` | One row per filing × item pair; item codes from {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01} (per EK-1). Other items in filing dropped at ingest time. |
| SEC EDGAR full-text search API | `accepted` datetime | `eight_k_events.accepted_at` | Wall-clock UTC of EDGAR acceptance. Load-bearing per EDF-5. |
| SEC EDGAR full-text search API | `periodOfReport` date | `eight_k_events.period_of_report` | Triggering-event date (forensic only; never used for window calc). |
| SEC EDGAR submissions API | CIK → ticker | `cik_ticker_map.ticker` (existing) | Reused from gap #8. |
| `quantlab.sp500_constituents` (PIT) | constituent panel as-of D | Aggregate universe | PIT-as-of-D, not today's panel. |
| GICS sector mapping (existing per cycle / cross-asset / sector-rotation / exec-departure) | ticker → sector | Aggregate sector slicing | No new infrastructure. |

### §4.2 · Form 4 insider inputs

| Source | Field | CH destination | Notes |
|--------|-------|----------------|-------|
| SEC EDGAR full-text search API (`efts.sec.gov/LATEST/search-index`) | accession number | `insider_trades.accession` | One per Form 4 filing. |
| SEC EDGAR full-text search API | issuer CIK | `insider_trades.issuer_cik` | The COMPANY's CIK. |
| Form 4 XML (`Archives/edgar/data/{cik}/{nodash}/...xml`) | `<reportingOwner>` CIK | `insider_trades.person_cik` | The INSIDER's CIK (distinct from issuer). |
| Form 4 XML | `<reportingOwner>` officer/director/10%-holder flags | `insider_trades.role_flags` | Bitmask: bit0=director, bit1=officer, bit2=10pct_holder, bit3=other. |
| Form 4 XML | `<nonDerivativeTransaction>` transaction code | `insider_trades.transaction_code` | One row per transaction within the form. v1 composite reads codes "P" + "S" only (per F4-4). |
| Form 4 XML | `<nonDerivativeTransaction>` shares + price-per-share | `insider_trades.shares`, `insider_trades.price_per_share` | Dollar amount = `shares × price_per_share`. |
| Form 4 XML | `<nonDerivativeTransaction>` transaction date | `insider_trades.transaction_date` | Forensic only (per F4-10). |
| SEC EDGAR submissions API (insider) | `person_cik → name` | `insider_ciks.name` (NEW) | Insider identity name cache; brief uses ticker aggregates only in v1. |
| SEC EDGAR full-text search API | `accepted` datetime | `insider_trades.accepted_at` | Wall-clock UTC. Load-bearing per F4-10. |
| `quantlab.sp500_constituents` (PIT) | constituent panel as-of D | Aggregate universe | Same as 8-K. |

---

## §5 · Composite formulas

### §5.1 · 8-K classifier per-stock (per EK-1 / EK-3)

For each ticker T in equity-midcap universe, as of snapshot date D:

```text
let events_t(item) = filings(T, item_code = item, accepted_at in [D - 90d, D])

let material_event_flag      = (count(events_t(item) for item in {1.01, 2.01, 2.06, 3.01,
                                                                   4.01, 4.02, 5.01}) ≥ 1)
let impairment_flag          = (count(events_t('2.06'))  ≥ 1)
let restatement_flag         = (count(events_t('4.02'))  ≥ 1)
let auditor_change_flag      = (count(events_t('4.01'))  ≥ 1)
let delisting_flag           = (count(events_t('3.01'))  ≥ 1)
let control_change_flag      = (count(events_t('5.01'))  ≥ 1)
let material_agreement_flag  = (count(events_t('1.01'))  ≥ 1)
let acquisition_flag         = (count(events_t('2.01'))  ≥ 1)

let recent_event_count_90d   = count(distinct accession in events_t(item) for any high-signal item)
let days_since_latest_event  = if all events_t.empty: null
                               else D - max(events_t.accepted_at).date
```

### §5.2 · 8-K classifier aggregate (per EK-4 / EDF-6 / EDF-7)

For SPY-500 PIT-as-of-D, sliced by GICS sector:

```text
let universe = sp500_constituents(asOf = D)
let sectors  = distinct(gics_sector(T) for T in universe)

for each sector s in sectors:
  let sector_size_s = count(T in universe : gics_sector(T) = s)
  let events_s      = filings(T in universe : gics_sector(T) = s,
                              item_code in high_signal_set,
                              accepted_at in [D - 90d, D])
  let event_rate_s_t = count(distinct (ticker, accession) in events_s) / sector_size_s

  let baseline_s = trailing(event_rate_s, 2y daily)
  if count(baseline_s) < MIN_Z_BASELINE (=30):
    z_s = null
  else:
    z_s = (event_rate_s_t - mean(baseline_s)) / stddev(baseline_s)

  cluster_event_s = (z_s != null) AND (abs(z_s) > 2.0)

let eight_k_cluster_flag = OR over sectors of cluster_event_s
let flagged_sectors_8k  = list of (sector, z_s, event_rate_s_t) where cluster_event_s
```

### §5.3 · Form 4 per-stock (per F4-2 / F4-4 / F4-5)

For each ticker T in equity-midcap universe, as of snapshot date D:

```text
let trades_t = transactions(issuer_ticker = T, transaction_code in {'P', 'S'},
                            accepted_at in [D - 90d, D])

let buys_t   = trades_t where transaction_code = 'P'
let sells_t  = trades_t where transaction_code = 'S'

let insider_buy_count_90d    = count(buys_t)
let insider_sell_count_90d   = count(sells_t)
let insider_net_dollar_90d   = Σ(shares × price_per_share over buys_t)
                              - Σ(shares × price_per_share over sells_t)
let insider_buyer_count_90d  = count(distinct person_cik in buys_t)
let insider_seller_count_90d = count(distinct person_cik in sells_t)

let buys_30d  = buys_t  where accepted_at in [D - 30d, D]
let sells_30d = sells_t where accepted_at in [D - 30d, D]
let distinct_buyers_30d  = count(distinct person_cik in buys_30d)
let distinct_sellers_30d = count(distinct person_cik in sells_30d)

let insider_cluster_buy_flag  = (distinct_buyers_30d  ≥ 3)
let insider_cluster_sell_flag = (distinct_sellers_30d ≥ 3)
```

### §5.4 · Form 4 aggregate (per F4-6 / EDF-6 / EDF-7)

For SPY-500 PIT-as-of-D, sliced by GICS sector:

```text
let universe = sp500_constituents(asOf = D)
let sectors  = distinct(gics_sector(T) for T in universe)

for each sector s in sectors:
  let sector_size_s   = count(T in universe : gics_sector(T) = s)
  let cluster_events_s = count(T in universe : gics_sector(T) = s
                                AND per_stock_cluster_buy_flag(T) = true)
  let cluster_rate_s_t = cluster_events_s / sector_size_s

  let baseline_s = trailing(cluster_rate_s, 2y daily)
  if count(baseline_s) < MIN_Z_BASELINE (=30):
    z_s = null
  else:
    z_s = (cluster_rate_s_t - mean(baseline_s)) / stddev(baseline_s)

  cluster_buy_s = (z_s != null) AND (abs(z_s) > 2.0)

let form_4_cluster_flag = OR over sectors of cluster_buy_s
let flagged_sectors_f4 = list of (sector, z_s, cluster_rate_s_t) where cluster_buy_s
```

### §5.5 · Snapshot payloads

```typescript
interface EightKClassifierSnapshot {
  snapshot_date: Date;
  last_edgar_query_at: Date | null;
  bd_since_last_query: number | null;

  // Aggregate (sector-sliced):
  flagged_sectors: Array<{
    sector: string;
    sector_size: number;
    event_rate_t: number;
    z: number;
    baseline_size: number;
  }>;
  eight_k_cluster_flag: boolean;

  // Per-ticker (equity-midcap universe):
  per_ticker_rows: Array<{
    ticker: string;
    cik: string;
    sector: string | null;
    recent_event_count_90d: number;
    days_since_latest_event: number | null;
    material_event_flag: boolean;
    impairment_flag: boolean;
    restatement_flag: boolean;
    auditor_change_flag: boolean;
    delisting_flag: boolean;
    control_change_flag: boolean;
    material_agreement_flag: boolean;
    acquisition_flag: boolean;
  }>;

  inputs_available: { aggregate: number; per_ticker: number };
  version: 'eight_k_classifier_v1';
}

interface Form4InsiderSnapshot {
  snapshot_date: Date;
  last_edgar_query_at: Date | null;
  bd_since_last_query: number | null;

  // Aggregate (sector-sliced):
  flagged_sectors: Array<{
    sector: string;
    sector_size: number;
    cluster_rate_t: number;
    z: number;
    baseline_size: number;
  }>;
  form_4_cluster_flag: boolean;

  // Per-ticker (equity-midcap universe):
  per_ticker_rows: Array<{
    ticker: string;
    cik: string;
    sector: string | null;
    insider_buy_count_90d: number;
    insider_sell_count_90d: number;
    insider_buyer_count_90d: number;
    insider_seller_count_90d: number;
    insider_net_dollar_90d: number;
    insider_cluster_buy_flag: boolean;
    insider_cluster_sell_flag: boolean;
  }>;

  inputs_available: { aggregate: number; per_ticker: number };
  version: 'form_4_insider_v1';
}
```

---

## §6 · CH tables (Phase A3 migrations)

### §6.1 · 8-K classifier tables

```sql
-- Raw event stream (parallel to executive_departures from gap #8)
CREATE TABLE quantlab.eight_k_events (
  accession             String,
  cik                   String,
  ticker                LowCardinality(String) DEFAULT '',
  form_type             LowCardinality(String),                -- '8-K' | '8-K/A'
  item_code             LowCardinality(String),                -- '1.01' | '2.06' | etc.
  accepted_at           DateTime,
  period_of_report      Date,
  filing_url            String DEFAULT '',
  is_amendment          UInt8 DEFAULT 0,
  source                LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
  ingested_at           DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (cik, accession, item_code)
SETTINGS index_granularity = 1024;

-- Daily snapshot (one row per daemon run)
CREATE TABLE quantlab.eight_k_classifier_snapshots (
  snapshot_date              Date,
  last_edgar_query_at        Nullable(DateTime),
  bd_since_last_query        Nullable(Int32),

  eight_k_cluster_flag       UInt8,
  flagged_sectors_json       String,                            -- ~11 sectors max

  per_ticker_json            String,                            -- ~60 rows
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,

  composite_version          LowCardinality(String) DEFAULT 'eight_k_classifier_v1',
  ingested_at                DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, composite_version)
SETTINGS index_granularity = 1024;
```

### §6.2 · Form 4 insider tables

```sql
-- Raw transaction stream
CREATE TABLE quantlab.insider_trades (
  accession             String,
  transaction_id        UInt32,                                 -- 0-based index within filing
  issuer_cik            String,
  issuer_ticker         LowCardinality(String) DEFAULT '',
  person_cik            String,                                 -- insider's CIK
  role_flags            UInt8 DEFAULT 0,                        -- bit0=director,1=officer,2=10pct,3=other
  transaction_code      LowCardinality(String),                 -- 'P' | 'S' | other
  transaction_date      Date,
  accepted_at           DateTime,
  shares                Float64,
  price_per_share       Float64,
  dollar_amount         Float64,                                -- shares × price_per_share
  filing_url            String DEFAULT '',
  source                LowCardinality(String) DEFAULT 'sec_edgar_form4_xml',
  ingested_at           DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (issuer_cik, accession, transaction_id)
SETTINGS index_granularity = 1024;

-- Insider person CIK → name cache
CREATE TABLE quantlab.insider_ciks (
  person_cik    String,
  name          String DEFAULT '',
  resolved_at   DateTime DEFAULT now(),
  source        LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'
) ENGINE = ReplacingMergeTree(resolved_at)
ORDER BY (person_cik)
SETTINGS index_granularity = 1024;

-- Daily snapshot
CREATE TABLE quantlab.form_4_insider_snapshots (
  snapshot_date              Date,
  last_edgar_query_at        Nullable(DateTime),
  bd_since_last_query        Nullable(Int32),

  form_4_cluster_flag        UInt8,
  flagged_sectors_json       String,

  per_ticker_json            String,
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,

  composite_version          LowCardinality(String) DEFAULT 'form_4_insider_v1',
  ingested_at                DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, composite_version)
SETTINGS index_granularity = 1024;
```

`cik_ticker_map` is reused unchanged from gap #8 (DDL preserved byte-for-byte).

Per-ticker rows + flagged sectors stored as JSON in single columns — matches gap #8 / #9 / #10 A3 precedent.

---

## §7 · Daemon hook positions

- **Step 1k — 8-K classifier evaluation**: between etf-flow (1j) and Form 4 (1l). Reads latest `eight_k_events` rows-as-of-D + `cik_ticker_map` + `sp500_constituents` PIT; computes composite per §5.1-§5.2; writes one row to `eight_k_classifier_snapshots`. Absent-table-safe, non-fatal, gated by `NO_MACRO || DRY_RUN`.
- **Step 1l — Form 4 insider evaluation**: between 8-K classifier (1k) and §2 cells/bundles. Reads `insider_trades` rows-as-of-D + `cik_ticker_map` + `sp500_constituents` PIT; computes composite per §5.3-§5.4; writes one row to `form_4_insider_snapshots`. Same absent-table-safe posture.

Chain: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → 1l form-4 → §2 cells/bundles`.

---

## §8 · Brief panels

### §8.1 · Section #14 (8-K classifier)

```text
─────────────────────────────────────────────────────────────────────────
 §14 — 8-K MATERIAL EVENTS (as of 2026-MM-DD, 90d rolling window)
─────────────────────────────────────────────────────────────────────────
  Aggregate (SPY 500 by GICS sector):

    eight_k_cluster: NO

    Top sector z-scores (2y baseline, |z| > 2 flagged):
      Information Technology  z=+1.6σ (rate=0.071, n=70 constituents)
      Financials              z=+0.4σ (rate=0.028, n=72 constituents)
      Health Care             z=-0.1σ (rate=0.016, n=64 constituents)
      ...

  Last EDGAR query:           2026-MM-DD HH:MM:SS UTC (today)

  Flagged tickers (universe filtered to equity-midcap):

    material_event (4):
      ABCD — restatement (4.02) 12d ago + auditor change (4.01) 18d ago
      EFGH — impairment (2.06) 7d ago
      IJKL — delisting (3.01) 32d ago
      MNOP — change in control (5.01) 41d ago

  Universe coverage:          58/60 mid-cap tickers have current CIK mapping
                              (2 missing: TICK1 / TICK2 — CIK map TBD)
```

Top-N truncation = 5 per side (matches gap #8 / #10 conventions). Per-ticker JSON full panel queryable directly from CH.

### §8.2 · Section #15 (Form 4 insider)

```text
─────────────────────────────────────────────────────────────────────────
 §15 — FORM 4 INSIDER ACTIVITY (as of 2026-MM-DD, 90d window / 30d cluster)
─────────────────────────────────────────────────────────────────────────
  Aggregate (SPY 500 cluster-buy rate by GICS sector):

    form_4_cluster: NO

    Top sector z-scores (2y baseline, |z| > 2 flagged):
      Energy                 z=+1.4σ (cluster rate=0.085, n=22)
      Real Estate            z=+0.7σ (cluster rate=0.034, n=31)
      ...

  Last EDGAR query:           2026-MM-DD HH:MM:SS UTC (today)

  Flagged tickers (universe filtered to equity-midcap):

    cluster_buy (2):
      QRST — 4 insiders bought (net +$2.3M, last 23d), code P
      UVWX — 3 insiders bought (net +$890K, last 17d), code P

    cluster_sell (1):
      YZ123 — 5 insiders sold (net -$11.2M, last 11d), code S

  Universe coverage:          58/60 mid-cap tickers have current CIK mapping
```

Same top-N truncation convention.

---

## §9 · Test plan

### §9.1 · 8-K classifier — pure function (`scripts/tests/eightKClassifier.test.ts`)

- T-EK-1 — `material_event_flag` fires when any high-signal item is in window.
- T-EK-2 — `material_event_flag` does NOT fire when latest high-signal item is 91d outside window.
- T-EK-3 — `impairment_flag` fires on 2.06; not on other items.
- T-EK-4 — Each per-item flag (impairment, restatement, auditor_change, delisting, control_change, material_agreement, acquisition) round-trips correctly.
- T-EK-5 — Per-stock filings with items outside the high-signal set do NOT fire `material_event_flag`.
- T-EK-6 — `days_since_latest_event` returns null on no qualifying events.
- T-EK-7 — Sector event-rate computed correctly: 3 distinct (ticker, accession) tuples across 30 SPY constituents in sector → rate = 0.1.
- T-EK-8 — Aggregate z-score with 30-print baseline.
- T-EK-9 — Aggregate z-score returns null when sector baseline < 30 prints (cold-start).
- T-EK-10 — `eight_k_cluster_flag` fires when ANY sector has `|z| > 2.0`.
- T-EK-11 — `eight_k_cluster_flag` does NOT fire when all sector z's are null (cold-start).
- T-EK-12 — Window boundary inclusion: event at exactly `accepted_at = D - 90d 00:00:00` IS in window.
- T-EK-13 — Single filing with multiple high-signal items counts ONCE toward sector rate (distinct on (ticker, accession)).
- T-EK-14 — Event deduplication: same `(cik, accession, item_code)` appearing twice in source counts once.

### §9.2 · 8-K classifier — repository (`scripts/tests/eightKClassifierRepository.test.ts`)

- T-EKR-1..N — `writeSnapshot` round-trip with FakeClickHouse.
- T-EKR-Nplus — `readLatest` returns most-recent per `(snapshot_date, composite_version)`.
- T-EKR-Nplus2 — `eightKClassifierSnapshotsTableExists` returns true/false correctly.
- T-EKR-Nplus3 — Daemon-orchestration `runDaemonEightKClassifierEvaluation` end-to-end.
- T-EKR-Nplus4 — `readEventsForCycle` uses subquery-around-FINAL (a52c964 regression class).
- T-EKR-Nplus5 — Malformed JSON columns degrade gracefully (returns empty arrays).
- T-EKR-Nplus6 — EXPLAIN PLAN regression (skipped when CH unavailable).

### §9.3 · 8-K classifier — migration (`scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts`)

- T-EKM-1 — Dry-run reports planned DDL without executing.
- T-EKM-2 — Apply mode creates the table; re-apply is no-op.
- T-EKM-3 — DDL matches §6.1 schema exactly.
- T-EKM-4 — Both `eight_k_events` + `eight_k_classifier_snapshots` created idempotently via co-bootstrap (gap #9 A3 precedent).

### §9.4 · 8-K classifier — ingest (`scripts/tests/secEdgar8kEventIngest.test.ts` — Python)

- T-EKI-1 — EDGAR full-text search response parse against fixture.
- T-EKI-2 — Item-code filter rejects filings reporting only items NOT in `--items` list.
- T-EKI-3 — CIK→ticker resolution via mocked submissions response.
- T-EKI-4 — `formerNames` follow on a ticker-swap fixture (reused from gap #8 fixture).
- T-EKI-5 — Idempotent re-ingest under ReplacingMergeTree on (cik, accession, item_code).
- T-EKI-6 — Acceptance-date filter rejects filings with `accepted_at > snapshot_date`.
- T-EKI-7 — 429 retry / back-off (User-Agent compliance + rate-limit posture).
- T-EKI-8 — Multi-item filing (one 8-K reporting both 2.06 + 4.02) expands to TWO rows.

### §9.5 · 8-K classifier — brief (`scripts/tests/operatorBriefRender.test.ts` — extension)

- T-OBR-EK-1 — Section #14 renders at byte-equal protection (after section #13).
- T-OBR-EK-2 — Top-N flagged-tickers truncation at N=5.
- T-OBR-EK-3 — `eight_k_cluster: YES` rendering on a fixture with a flagged sector.
- T-OBR-EK-4 — Cold-start fallback: no sectors with `z != null` renders one-line message.
- T-OBR-EK-5 — "No tickers flagged." fallback when per-ticker rows empty.
- T-OBR-EK-6 — Staleness arrow on `bd_since_last_query > 3`.
- T-OBR-EK-7 — Multi-item ticker renders both flagged items in one line ("restatement (4.02) 12d ago + auditor change (4.01) 18d ago").

### §9.6 · 8-K classifier — composer wiring (`scripts/tests/operatorBrief.test.ts` — extension)

- T-OB-EK-1 — `composeMorningBrief` threads `eightK` snapshot through `Promise.all`.
- T-OB-EK-2 — `fetchLatestEightKClassifierFromCH` graceful-degrades on throw.
- T-OB-EK-3 — Null pass-through renders "not yet evaluated" footer.

### §9.7 · Form 4 — pure function (`scripts/tests/form4Insider.test.ts`)

- T-F4-1 — `insider_buy_count_90d` counts only code "P" transactions in window.
- T-F4-2 — `insider_sell_count_90d` counts only code "S" transactions in window.
- T-F4-3 — Other transaction codes (A, M, F, G, etc.) excluded from composite.
- T-F4-4 — `insider_net_dollar_90d` = Σ(buy $) − Σ(sell $) computed correctly.
- T-F4-5 — `insider_buyer_count_90d` = distinct `person_cik` in window buys.
- T-F4-6 — `insider_cluster_buy_flag` fires on 3 distinct insiders in trailing 30d.
- T-F4-7 — `insider_cluster_buy_flag` does NOT fire on 2 distinct insiders (below threshold).
- T-F4-8 — `insider_cluster_buy_flag` does NOT fire on 1 insider filing 3 separate trades (distinct on person_cik, not on accession).
- T-F4-9 — `insider_cluster_sell_flag` mirror-test of T-F4-6.
- T-F4-10 — 30d window boundary: trade at `accepted_at = D - 30d` IS in window; at `D - 30d - 1s` NOT.
- T-F4-11 — Aggregate sector cluster-rate computed: 2 tickers with cluster-buy in sector of 20 constituents → rate = 0.1.
- T-F4-12 — Aggregate z-score with 30-print baseline.
- T-F4-13 — Aggregate z-score returns null on cold-start.
- T-F4-14 — `form_4_cluster_flag` fires when any sector |z| > 2.0.

### §9.8 · Form 4 — repository (`scripts/tests/form4InsiderRepository.test.ts`)

- T-F4R-1..N — `writeSnapshot` round-trip.
- T-F4R-Nplus — `readLatest` correctness.
- T-F4R-Nplus2 — `form4InsiderSnapshotsTableExists`.
- T-F4R-Nplus3 — `runDaemonForm4InsiderEvaluation` end-to-end.
- T-F4R-Nplus4 — `readTradesForCycle` uses subquery-around-FINAL.
- T-F4R-Nplus5 — Malformed JSON columns degrade gracefully.
- T-F4R-Nplus6 — EXPLAIN PLAN regression.

### §9.9 · Form 4 — migration (`scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts`)

- T-F4M-1 — Dry-run reports DDL.
- T-F4M-2 — Apply creates tables; re-apply no-op.
- T-F4M-3 — DDL matches §6.2.
- T-F4M-4 — All three tables (`insider_trades`, `insider_ciks`, `form_4_insider_snapshots`) created idempotently via co-bootstrap.

### §9.10 · Form 4 — ingest (`scripts/tests/secEdgarForm4Ingest.test.ts` — Python)

- T-F4I-1 — Form 4 XML parse against real-shape fixture.
- T-F4I-2 — `<nonDerivativeTransaction>` extraction with code/shares/price/date fields.
- T-F4I-3 — Filings with NO P/S transactions (only A, M, G, etc.) produce 0 composite-eligible rows BUT log the transactions to the raw table.
- T-F4I-4 — Insider role flags parsed correctly (Director / Officer / 10%-Holder bits).
- T-F4I-5 — Issuer CIK + person CIK resolved separately.
- T-F4I-6 — Idempotent re-ingest on (issuer_cik, accession, transaction_id).
- T-F4I-7 — Acceptance-date filter (F4-10).
- T-F4I-8 — Multi-transaction Form 4 (one filing with 3 P transactions) expands to 3 `insider_trades` rows.

### §9.11 · Form 4 — brief (`scripts/tests/operatorBriefRender.test.ts` — extension)

- T-OBR-F4-1 — Section #15 renders at byte-equal protection (after section #14).
- T-OBR-F4-2 — Top-N flagged truncation.
- T-OBR-F4-3 — `form_4_cluster: YES` rendering.
- T-OBR-F4-4 — Cold-start fallback.
- T-OBR-F4-5 — "No tickers flagged." fallback.
- T-OBR-F4-6 — Staleness arrow on `bd_since_last_query > 3`.
- T-OBR-F4-7 — Net dollar amount renders with sign + dollar formatting ("net +$2.3M" / "net -$11.2M").

### §9.12 · Form 4 — composer wiring (`scripts/tests/operatorBrief.test.ts` — extension)

- T-OB-F4-1 — `composeMorningBrief` threads `formFour` snapshot via `Promise.all`.
- T-OB-F4-2 — `fetchLatestForm4InsiderFromCH` graceful-degrades.
- T-OB-F4-3 — Null pass-through renders "not yet evaluated" footer.

---

## §10 · Implementation phases

| Phase | Deliverable | Estimated effort |
|-------|-------------|------------------|
| **SPEC + teach-doc** | THIS doc + `docs/teach/2026-05-20-event-driven-filings-architecture.md`. | 1 slice (this commit) |
| **EK-A1** | `scripts/sec_edgar_8k_event_ingest.py`. EDGAR full-text search + item-code filter + CIK→ticker resolve + write to `quantlab.eight_k_events` + reused `cik_ticker_map`. Migration script for the source table. Tests under `scripts/tests/` (pytest). Refactor: extract gap #8 helpers into `scripts/_sec_edgar_helpers.py` (compatible — no behavior change). | ~3 days |
| **EK-A2** | `src/server/eight_k_classifier.ts` (pure functions per §5.1-§5.2). Tests under `scripts/tests/eightKClassifier.test.ts`. | ~1 day |
| **EK-A3** | `scripts/migrate_create_eight_k_classifier_snapshots.ts` (co-bootstraps `eight_k_events` + `eight_k_classifier_snapshots`). Migration test. | ~0.5 day |
| **EK-A4** | `src/server/eight_k_classifier_repository.ts` (read/write/exists/daemon-orchestration). `scripts/daily_signal_daemon.ts` step 1k hook. Tests. | ~1.5 days |
| **EK-A5** | `src/server/operator_brief.ts` + `operator_brief_render.ts` section #14. Tests on byte-equal protection + flagged-tickers rendering. | ~1 day |
| **F4-A1** | `scripts/sec_edgar_form4_ingest.py`. EDGAR Form 4 XML fetch + parse + write to `quantlab.insider_trades` + `quantlab.insider_ciks` + reused `cik_ticker_map`. Migration for source tables. Tests. | ~3 days |
| **F4-A2** | `src/server/form_4_insider.ts` (pure functions per §5.3-§5.4). Tests. | ~1 day |
| **F4-A3** | `scripts/migrate_create_form_4_insider_snapshots.ts`. Migration test. | ~0.5 day |
| **F4-A4** | `src/server/form_4_insider_repository.ts` + daemon step 1l. Tests. | ~1.5 days |
| **F4-A5** | Brief section #15. Tests. | ~1 day |

Total: **~14 working days** (matches gap-doc's 2-3 week pre-Opus estimate). Each sub-phase commits as its own commit; SPEC + teach-doc (this slice) lands first. The 8-K arc (EK-A1 → EK-A5) ships fully before Form 4 begins; the operator can run the 8-K classifier end-to-end while Form 4 is mid-implementation.

---

## §11 · Open questions (deferred to implementation)

1. **EDGAR full-text search Item-code-filter query syntax (8-K ingest).** Per gap #8 OQ-1: the canonical endpoint syntax for filtering on `items` may need refinement on first-apply-run. Recommendation: EK-A1 implements best-guess query (e.g. `&forms=8-K&q="Item 2.06" OR "Item 4.02" OR ...`); first apply-run confirms. Operator paths: `--url`, `--from-file`, `--items` parametric override.

2. **Form 4 XML parser bootstrap on first-run.** The Form 4 XSD is stable but the wrapping `<edgarSubmissions>` envelope formats vary slightly (compressed vs uncompressed). F4-A1 should handle both and log clear errors on schema drift. Operator path: `--from-file` for browser-downloaded XML.

3. **Multi-issuer Form 4 (insider holding multiple companies).** Some Form 4 filings report transactions in multiple issuers (rare: cross-listings, holding companies). The parser should emit one row per (issuer, transaction) pair. Tests cover this.

4. **`bd_since_last_query` semantics for sparse-filing daemons.** On days with no new 8-K filings or Form 4 transactions, the snapshot's `last_edgar_query_at` reflects the most recent successful poll (typically today). The staleness arrow only fires if the daemon hasn't successfully polled in >3bd — distinct from "filings haven't moved" (which is normal).

5. **`insider_ciks` name cache cold-start.** First-run will resolve ~100-500 insider CIKs across the equity-midcap universe (3-10 insiders per company × 60 tickers). EDGAR submissions API rate limit (10 req/sec) caps this at ~10-50 seconds bursty fetches. F4-A1 batches + caches; subsequent runs only resolve new insiders.

6. **8-K item `5.02` redundancy across gap #8 + gap #7.** The new `eight_k_events` table will include a redundant copy of all 5.02 items (which gap #8's `executive_departures` also holds). Per EK-5, the duplication is intentional + negligible. Gap #8 composite unchanged; gap #7 composite reads broader table. Future ADR could unify if drift becomes a concern.

7. **Form 4 transaction-code edge cases.** Some filings use mixed codes (a single transaction reported as "P" but with footnote "exercise of options"). v1 filter is strict: code field = "P" or "S" exactly, no footnote inspection. Risks: very rare miscoded transactions get included. v2 ADR can add footnote-based exclusion if Phase B reveals issues.

8. **Aggregate baseline build-up time.** Both `eight_k_classifier` and `form_4_insider` aggregate z-scores require 30+ days of trailing sector-rate history before the cluster flag can fire (per EDF-7). First daemon run after migration: ALL flagged_sectors arrays empty + cluster flag false. Expected; matches gap #8 / #9 / #10 cold-start posture. Phase B validation cannot begin for ~6-8 weeks post-ingest.

9. **Cohen-Malloy-Pomorski opportunistic-vs-routine classifier (gap doc-cited).** Per F4-1, deferred. v2 ADR scope: per-insider seasonal-pattern detection (Fourier or season-of-year baseline) over trailing 5y history; trades deviating from personal pattern flagged opportunistic. Out-of-scope until per-insider history baseline exists (≥6 months of v1 data).

10. **13D / 13G filings (gap doc-cited).** Per EDF-3, deferred. Separate gap arc OR v2 ADR. Activist-13D canon is Brav-Jiang-Partnoy-Thomas 2008; passive 13G is thinner. Filer-reputation classification problem is non-trivial.

11. **Event-driven architecture promotion (gap doc primary framing).** Per EDF-2, deferred. v2 ADR can promote if Phase B reveals 4-23h daily-daemon latency is decision-affecting. Architecture would add: process supervision (PM2 or systemd), poll-frequency parameter (30min default), dedupe-under-concurrent-polling, retry policy. v1 daily-daemon is the minimum-viable signal.

---

## §12 · References

- **Lerman & Livnat 2010** — "The New Form 8-K Disclosures." *Review of Accounting Studies* 15(4), 752-778. Documents that abnormal-return reactions to 8-K filings concentrate in specific items (2.06, 4.02, 3.01, 5.01); item-code-based classification is canon-load-bearing.
- **Hennes, Leone, Miller 2014** — "The Determinants and Market Consequences of Auditor Dismissals." Documents ~50% of 4.01 auditor changes are distress-flagged.
- **Cohen, Malloy, Pomorski 2012** — "Decoding Inside Information." *Journal of Finance* 67(3), 1009-1043. Opportunistic-vs-routine insider classifier; opportunistic trades show ~6% annual return predictability. Deferred to v2 per F4-1.
- **Lakonishok & Lee 2001** — "Are Insider Trades Informative?" *Review of Financial Studies* 14(1), 79-111. Foundational insider-trading return-predictability evidence; cluster patterns strengthen the signal.
- **Seyhun 1986** — "Insiders' Profits, Costs of Trading, and Market Efficiency." *Journal of Financial Economics* 16(2), 189-212. The foundational insider-trading paper.
- **Brav, Jiang, Partnoy, Thomas 2008** — "Hedge Fund Activism, Corporate Governance, and Firm Performance." *Journal of Finance* 63(4), 1729-1775. Activist-13D canon; deferred per EDF-3.
- **17 CFR 249.308** — Form 8-K item structure (1.01 through 8.01).
- **17 CFR 240.16a-3** — Form 4 statutory basis + 2-business-day filing deadline.
- **Sarbanes-Oxley §409** (15 U.S.C. §78m(l)) — real-time disclosure mandate underlying both 8-K and Form 4.
- **SEC EDGAR full-text search API:** https://efts.sec.gov/LATEST/search-index (free, no API key, rate-limited).
- **SEC EDGAR submissions API:** https://data.sec.gov/submissions/CIK{cik}.json.
- **EDGAR User-Agent guidance:** https://www.sec.gov/os/accessing-edgar-data.
- Companion gap doc: [`docs/obsidian/gaps/event-driven-filings-processor.md`](../obsidian/gaps/event-driven-filings-processor.md).
- Predecessor SPEC (8-K Item 5.02 narrow cut): [`docs/specs/executive-departure-signal.md`](./executive-departure-signal.md).
- Companion teach-doc: [`docs/teach/2026-05-20-event-driven-filings-architecture.md`](../teach/2026-05-20-event-driven-filings-architecture.md).
- Form-4-canon (deferred per F4-1): Seyhun 1986; Lakonishok-Lee 2001; Cohen-Malloy-Pomorski 2012.
- 13D-canon (deferred per EDF-3): Brav-Jiang-Partnoy-Thomas 2008.
- Short-interest A4 Path A4-β shim precedent (s89-s90) — pattern for "single-source v1, deferred v2 enhancement" cited in EDF-1.
