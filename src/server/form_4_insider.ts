/**
 * Form 4 insider composite — Layer-0 informational input (Phase A2).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§2.3, 5.3, 5.4, 9.7.
 *
 * Purpose:
 *   Two scopes, both informational-only in v1 per the Phase 9+ gap-inventory
 *   README principle #5 (log first, gate after Phase B independence test):
 *
 *   1. **Per-stock** (watch-universe filtered, e.g. equity-midcap): emit
 *      `insiderBuyCount90d`, `insiderSellCount90d`, `insiderNetDollar90d`,
 *      `insiderBuyerCount90d`, `insiderSellerCount90d`, plus the cluster
 *      flags `insiderClusterBuyFlag` / `insiderClusterSellFlag`. The cluster
 *      flags fire when ≥ 3 distinct insiders (by `person_cik`) transacted in
 *      the same direction within the trailing 30-calendar-day window — same
 *      direction means same transaction code, so a 2-buy-1-sell cluster fires
 *      neither flag (F4-2 lock).
 *
 *   2. **Aggregate** (SPY-500 PIT-as-of-D, sliced by GICS sector): emit
 *      `form4ClusterFlag` when ANY sector's cluster-buy-rate (= tickers
 *      with `insiderClusterBuyFlag` in sector / sector_size) z-score
 *      against a 2y daily baseline exceeds |z| > 2 symmetrically. Per
 *      F4-6 (v1) the buy-side aggregate is load-bearing.
 *
 *      **F4-12 (v2, S95-1)**: a symmetric sell-side track runs in parallel.
 *      `form4SellClusterFlag` fires when any sector's cluster-sell-rate (=
 *      tickers with `insiderClusterSellFlag` in sector / sector_size) is
 *      anomalously high vs its OWN 2y daily baseline (`baseline2ySell`).
 *      Lakonishok-Lee 2001 §4 documents that the sell signal is ~30-50%
 *      diluted by tax/diversification/charity motives — informationally
 *      weaker than buys but non-zero. Two SEPARATE booleans + max-score
 *      sectors are emitted so downstream weighting (brief render, position
 *      sizing) can treat the two signals asymmetrically.
 *
 *      **ADR-053 (v3, S96-163)**: the aggregate anomaly statistic changed.
 *      The previous v1/v2 path z-scored the sector cluster-rate against its
 *      2y baseline with a Gaussian z-test (`computeZ`). On the EDGAR-only
 *      coverage-gated baseline (post-ADR-052 D2) that baseline is sparse and
 *      zero-inflated (e.g. Communication Services 2026-04-30: 202 of 203
 *      baseline days are exactly 0). The Gaussian z degenerates there: one
 *      ordinary clustered ticker (rate 1/22) z-scored to a fabricated 14.18σ
 *      because the lone non-zero baseline day collapses σ. The Gaussian z is
 *      the wrong statistic for a sparse, zero-inflated, bounded, discrete
 *      rate (Vector Core canon: a metric whose assumptions are violated by
 *      the data is not a metric). v3 replaces it with a one-sided EMPIRICAL
 *      UPPER-TAIL EXCEEDANCE statistic (`computeEmpiricalExceedance`) +
 *      validity guards. See that function's docstring and ADR-053 for the
 *      full SPEC. The firing test is now an empirical-tail threshold
 *      (`p ≤ α`, α = 0.05) instead of `|z| > 2`; the stored display value is
 *      a BOUNDED z-equivalent (`zEmp`), so a fabricated 14σ is impossible.
 *
 *      **ADR-054 (v4, OQ-C36-1 / OQ-C36-2)**: the effective-sample VALIDITY
 *      GUARD's counted unit changes — from non-zero baseline DAYS (`m`) to
 *      distinct independent EVENTS (`effectiveEvents` = maximal runs of
 *      consecutive non-zero values; `countNonZeroRuns`). ADR-053's verification
 *      showed the aggregate still fired ~24 buy / 27 sell days because each daily
 *      cluster-rate is computed over a trailing 30d window, so one cluster event
 *      produces a ~30-day plateau of non-zero days and the day-count guard
 *      over-counts independent events by the window length (López de Prado AFML
 *      Ch. 4 §4.3–§4.4: overlapping-window observations are concurrent, NOT IID).
 *      The guard now requires `effectiveEvents ≥ EVENT_FLOOR = ⌈1/α⌉ = 20`; the
 *      old day-count floor is removed. The exceedance statistic itself (`p`,
 *      `zEmp`, the firing test, the resolution floor, α, buy/sell symmetry) is
 *      UNCHANGED — only the effective-sample metric + floor change. Zero new free
 *      parameters (`EVENT_FLOOR` derives solely from α).
 *
 * Canon:
 *   - Lakonishok & Lee 2001 *Rev. Fin. Studies* §3 — open-market insider P/S
 *     filter; cluster effects strengthen the raw-trade signal.
 *   - Seyhun 1986 *J. Fin. Econ.* — raw insider-activity predictive content;
 *     foundation for the v1 raw-signal approach without CMP classifier.
 *   - Cohen, Malloy & Pomorski 2012 *J. Finance* — opportunistic-vs-routine
 *     classifier; deferred to v2 per F4-1 (requires per-insider history floor
 *     that cold-start violates).
 *
 * Design choices (SPEC §2.3 locks):
 *   - F4-1: NO routine-vs-opportunistic classifier in v1. All open-market
 *     trades count equally.
 *   - F4-2: Cluster threshold = ≥ 3 distinct insiders (by `personCik`) within
 *     30 calendar days, same direction. Distinct on insider identity, NOT on
 *     filing — a single insider with 3 separate buys counts as 1 insider.
 *   - F4-3: NO insider-role weighting in v1. `roleFlags` is stored at the
 *     ingest layer (per row) but NOT surfaced in the snapshot; v2 ADR can
 *     resurface for forensic queries.
 *   - F4-4: Open-market codes only = {"P", "S"}. Other codes (A grants, M
 *     option exercises, F payments, G gifts, etc.) are present in the ingest
 *     trade stream per S93-37 (carried-forward warning) but the composite
 *     MUST filter them out at read time. Relying on ingest-side filtering
 *     would dilute the signal with non-discretionary trading.
 *   - F4-5: Net dollar = Σ(P $ in 90d) − Σ(S $ in 90d). Sign matters.
 *   - F4-6: Aggregate counts tickers with `insiderClusterBuyFlag`, NOT raw
 *     trades. Correctly weights by issuer count not trade volume (avoids one
 *     mega-insider cluster dominating sector signal).
 *   - F4-12 (v2, S95-1): Sell-side aggregate mirrors F4-6 structurally —
 *     counts tickers with `insiderClusterSellFlag` per sector against a
 *     SEPARATE 2y baseline `baseline2ySell`. Same anomaly statistic, same
 *     MIN_Z_BASELINE=30, same cluster window (30d), same distinct-insider
 *     threshold (3). Zero new tuned parameters per Bailey-LdP 2014 selection-
 *     bias canon — the firing threshold is inherited from the buy-side, not
 *     refit against a validation set. ADR-053 (v3): both directions now use the
 *     empirical-exceedance `p ≤ α` firing rule instead of `|z| > 2.0`.
 *   - F4-7 / F4-8 / F4-9 / F4-10: ingest concerns, encoded at F4-A1.
 *   - F4-10: `acceptedAt` is the load-bearing window-membership anchor.
 *     `transactionDate` is forensic ONLY (can be 1-2bd before acceptance per
 *     17 CFR 240.16a-3). The composite is anchor-agnostic at the function
 *     boundary — the caller decides what to pass — but the SPEC mandates
 *     `acceptedAt` for windowing.
 *   - F4-11: Composite version = 'form_4_insider_v1'.
 *   - EDF-7: MIN_Z_BASELINE = 30 (matches all six prior Layer-0 composites).
 *   - ADR-053: aggregate anomaly statistic = one-sided empirical exceedance +
 *     effective-sample guard (replaces the Gaussian z on the cluster-rate);
 *     all thresholds derive from a single α = 0.05.
 *
 * Pure-function layer:
 *   This module exposes only pure functions + type definitions. Anomaly
 *   baselines are INPUTS (computed by the A4 repository from a 2y trailing
 *   panel), not computed inside this module. Same architectural separation
 *   as eight_k_classifier.ts, executive_departure.ts, etf_flow.ts,
 *   cross_asset_signals.ts, short_interest.ts.
 */
import { invNormCDF } from '../lib/psr.js';

/** Composite version. Bump on any change to window length, cluster threshold,
 *  transaction-code filter, aggregator, or universe definition. Stored
 *  alongside every snapshot for backtest reproducibility.
 *
 *  **v2 (ADR-052 D5 — S96-146 resolution):** the cluster-path input population
 *  changes (EDGAR-canonical source restriction + coverage-homogeneous baseline,
 *  D1+D2), which is a universe-definition change per the rule above. v1
 *  snapshots (carrying the z=5.57 source-provenance artifact) persist as
 *  historical record; the re-backfill writes v2 rows. Per ADR-051 Decision 8
 *  the version bump keeps the "did the composite change after a bad result?"
 *  audit a single CH query. The bump is provenance hygiene, NOT a formula search
 *  against a bad backtest, so it is permitted under ADR-051 Decision 5
 *  (anti-shopping).
 *
 *  **v3 (ADR-053 D6 — S96-163 resolution):** the aggregate ANOMALY STATISTIC
 *  changes — from the Gaussian z on the sector cluster-rate to a one-sided
 *  empirical upper-tail exceedance + effective-sample guard
 *  (`computeEmpiricalExceedance`). v2 verification proved the provenance fix
 *  did NOT resolve the fabricated-σ artifact at the value level (the EDGAR-only
 *  coverage-gated baseline is zero-inflated, so the Gaussian z still produced
 *  up to 14.18σ from one ordinary clustered ticker). This is a calculation-logic
 *  change to the anomaly statistic, version-pinned per ADR-051 Decision 8. The
 *  α = 0.05 firing threshold is conventional (NOT fit to form_4 data), so the
 *  bump is permitted under ADR-051 Decision 5 (anti-shopping). The stored
 *  `max_aggregate_z[_sell]` columns now carry the BOUNDED z-equivalent `zEmp`,
 *  disambiguated by this version tag.
 *
 *  **v4 (ADR-054 D4 — OQ-C36-1 / OQ-C36-2 resolution):** the ADR-053
 *  effective-sample guard's COUNTED UNIT changes — from NON-ZERO baseline DAYS
 *  (`m`) to distinct independent EVENTS (`effectiveEvents` = maximal runs of
 *  consecutive non-zero values in the chronologically-ordered baseline). Because
 *  each daily cluster-rate is computed over a trailing 30-day window, one cluster
 *  event produces a ~30-day plateau of non-zero days; counting days therefore
 *  over-counts independent events by the window length (López de Prado AFML
 *  Ch. 4 §4.3–§4.4: overlapping-window observations are concurrent, NOT IID, and
 *  the effective sample is deflated by the average concurrency). The guard now
 *  requires `effectiveEvents ≥ EVENT_FLOOR = ⌈1/α⌉ = 20` (the α-derived
 *  representability minimum); the old day-count floor `m ≥ ⌈α(n+1)⌉` is removed.
 *  This changes which sectors are valid, hence which fire and the persisted
 *  `max_aggregate_z[_sell]` / `flagged_sectors_json` content, so it is
 *  version-pinned per ADR-051 Decision 8. The exceedance `p`, the `zEmp`, the
 *  resolution floor (`n ≥ MIN_Z_BASELINE`), the firing test (`p ≤ α`), and α
 *  itself are ALL unchanged — zero new free parameters (`EVENT_FLOOR` derives
 *  solely from the existing α; anti-shopping per ADR-051 Decision 5 / AFML
 *  §11.4). v3 snapshots persist as historical record; the re-backfill writes v4
 *  rows.
 *
 *  **v5 (ADR-055 D4 — OQ-C37-3 resolution):** the gated UNIT of the aggregate
 *  signal changes — from a MAX over 11 per-sector empirical-exceedance tests to a
 *  SINGLE cross-sectional POOLED test. The pooled (index-level) cluster-rate is
 *  `pooledRate(t) = Σ_sectors clusterTickers_s(t) / Σ_sectors sectorSize_s(t)` per
 *  direction = "the fraction of the S&P 500 with an insider cluster at t" — the
 *  ISSUER-WEIGHTED pool of the per-sector rates (weights = sector sizes), NOT the
 *  unweighted mean. `form4ClusterFlag` / `form4SellClusterFlag` +
 *  `maxAggregateZ[Sell]` now derive from THIS pooled statistic, fed through the
 *  ADR-053 `computeEmpiricalExceedance` + the ADR-054 `countNonZeroRuns` /
 *  `EVENT_FLOOR` guard — both REUSED VERBATIM (only the series changes: 11 → 1).
 *  The 11 per-sector rates + flagged-sector lists are RETAINED for the dashboard
 *  as INFORMATIONAL color (ADR-055 D2) but NEVER individually statistically gated
 *  — no per-sector flag feeds the aggregate flag, the Phase-B campaign, or
 *  Phase-C. Rationale (ADR-055): pooling removes the implicit 11-way
 *  multiple-testing burden at the source (Harvey-Liu-Zhu 2016 §II), has sharper
 *  empirical-tail resolution (a near-continuous index-level rate vs a coarse
 *  small-denominator per-sector rate; Aronson Ch. 6–7), and matches the regime
 *  consumer's market-level "are insiders, in aggregate, accumulating or
 *  distributing?" decision. ZERO new free parameters (same α, `MIN_Z_BASELINE`,
 *  `EVENT_FLOOR`; one series instead of 11 — anti-shopping per AFML §11.4 /
 *  ADR-051 Decision 5). The empirical-exceedance statistic + the event-floor
 *  guard + α + the firing test are ALL unchanged; only the series changes. This
 *  changes the aggregate-flag + `max_aggregate_z[_sell]` semantics, so it is
 *  version-pinned per ADR-051 Decision 8. NO DDL (ADR-055 D5): the existing
 *  Nullable `max_aggregate_z[_sector][_sell][_sell_sector]` columns now carry the
 *  POOLED values (`_sector` becomes the literal "S&P 500" or null); the pooled
 *  `effectiveEvents`/`baselineSize`/`exceedance` + the per-sector informational
 *  lists ride in the existing schemaless `flagged_sectors_json` /
 *  `flagged_sell_sectors_json`. v4 snapshots persist as historical record; the
 *  re-backfill writes v5. NOTE: the pooled event count is BELOW `EVENT_FLOOR` at
 *  current EDGAR coverage (ADR-055 D3 measured pooled events ≤ 15 buy / 19 sell <
 *  20), so the aggregate is honestly `under_review` until ADR-052 D7 lengthens the
 *  continuous baseline — the construct is correct; the data is not yet sufficient,
 *  and the floor is NOT lowered (anti-shopping). */
export const FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v5' as const;
export type Form4InsiderCompositeVersion = typeof FORM_4_INSIDER_COMPOSITE_VERSION;

/** ADR-052 D1 — the canonical source for all cluster-identity computations.
 *
 *  `quantlab.insider_trades` is a UNION of two provenance schemes:
 *    - `sec_edgar_form4_xml` — the real SEC reporting-person CIK (numeric); the
 *      ONLY identity scheme under which "distinct insider" (F4-2/F4-9) is
 *      well-defined.
 *    - `finnhub` — a synthetic `"FH"+sha1(upper(name))[:10]` name-hash that
 *      collides distinct people sharing a name AND splits one person across
 *      spelling variants (S96-145). It is unfit as a cluster-distinctness
 *      identity, independent of its sparse coverage.
 *
 *  Per Lakonishok & Lee 2001 *Rev. Fin. Studies* §3 the cluster effect that
 *  strengthens the insider signal is defined over DISTINCT INSIDERS; a name-hash
 *  identity breaks that construct. The cluster-rate z, the per-ticker cluster
 *  flags, and every downstream aggregate (`form4ClusterFlag` /
 *  `form4SellClusterFlag` / `maxAggregateZ[Sell]`) are therefore computed from
 *  this source ONLY (ADR-052 D1/D4). Finnhub is demoted to coverage/forensic
 *  (D3) and may still power identity-agnostic per-ticker raw counts WITH a
 *  source-mix label. */
export const EDGAR_CANONICAL_SOURCE = 'sec_edgar_form4_xml' as const;

/** ADR-055 D5 (v5) — the unit of the gated aggregate signal is now the
 *  cross-sectional INDEX, not a GICS sector. `maxAggregateZSector` /
 *  `maxAggregateZSellSector` carry this literal (instead of a GICS sector name)
 *  when the pooled statistic is valid, and null when it is guard-suppressed. */
export const POOLED_AGGREGATE_LABEL = 'S&P 500' as const;

// ── SPEC-pinned thresholds (re-tuning bumps composite version) ──────────────

/** Main per-stock window for net-dollar + per-direction counts (F4-5). */
export const ROLLING_WINDOW_DAYS = 90;

/** Cluster-detection window per F4-2: ≥ 3 distinct insiders within 30d. */
export const CLUSTER_WINDOW_DAYS = 30;

/** Cluster threshold per F4-2: distinct `personCik` count required. */
export const CLUSTER_INSIDER_THRESHOLD = 3;

/** @deprecated ADR-053 (S96-163) retired the Gaussian z-threshold firing rule.
 *  The aggregate flag now fires on the empirical-exceedance tail (`p ≤
 *  FORM_4_EXCEEDANCE_ALPHA`), NOT on `|z| > 2`. Kept only for the constants-
 *  sanity pin + backward-reference; no live code path reads it. Remove when the
 *  v1/v2 historical-comparison code is fully retired. */
export const FORM_4_CLUSTER_Z_THRESHOLD = 2.0;

/** ADR-053 (S96-163) — the single conventional one-sided significance level
 *  from which BOTH validity guards AND the firing threshold derive (zero new
 *  free parameters; α is NOT fit to form_4 data — anti-shopping per AFML §11.4 /
 *  ADR-051 Decision 5). The aggregate cluster flag fires iff ANY valid sector
 *  has empirical-exceedance `p ≤ α`. The effective-sample guard (ADR-054)
 *  requires `effectiveEvents ≥ EVENT_FLOOR = ⌈1/α⌉` distinct independent events
 *  (see `EVENT_FLOOR` + `computeEmpiricalExceedance`). */
export const FORM_4_EXCEEDANCE_ALPHA = 0.05;

/** ADR-054 D2 (OQ-C36-1 / OQ-C36-2) — the α-derived effective-sample floor:
 *  the minimum number of distinct INDEPENDENT baseline events
 *  (`effectiveEvents`, see `countNonZeroRuns`) required for the empirical α-tail
 *  to be representable. Derives SOLELY from α — there is NO new tunable
 *  parameter (anti-shopping per AFML §11.4 / ADR-051 Decision 5).
 *
 *  Derivation (a-priori, NOT fit to form_4 data): an empirical upper-tail test at
 *  level α can only be RESOLVED from `k` independent observations if the smallest
 *  achievable exceedance `1/(k+1)` can reach α — i.e. `1/(k+1) ≤ α ⇔ k ≥ 1/α − 1`.
 *  More fundamentally, you cannot empirically identify a "1-in-(1/α)" tail event
 *  from fewer than ≈ `1/α` independent observations; with `< 1/α` events the
 *  rarest thing the data can express ("today exceeds everything seen") is itself
 *  only a 1-in-`(k+1)` event, not an α-tail. `⌈1/α⌉ = 20` is the clean
 *  conservative pin of this representability limit. This REPLACES ADR-053's
 *  day-count floor `m ≥ ⌈α(n+1)⌉`, which counted ~30 autocorrelated days per ONE
 *  independent event (the 30d cluster window) and thus under-protected (OQ-C36-1).
 *
 *  MUST be computed from α, never hardcoded — re-deriving it on an α change keeps
 *  the zero-free-parameter contract. */
export const EVENT_FLOOR = Math.ceil(1 / FORM_4_EXCEEDANCE_ALPHA);

/** EDF-7: minimum baseline prints for a valid anomaly statistic. Matches the
 *  MIN_Z_BASELINE constant across all Layer-0 composites. Under ADR-053 this is
 *  the RESOLUTION floor (the ECDF needs ≥ ⌈1/α⌉ = 20 days to represent a 5% tail;
 *  30 ≥ 20, conservative — no constant change). */
export const MIN_Z_BASELINE = 30;

/** F4-4: open-market transaction codes admitted to the composite. Ingest
 *  per S93-37 stores ALL codes — this filter is enforced at READ time.
 *
 *  Byte-pinned to scripts/sec_edgar_form4_ingest.py:DEFAULT_HIGH_SIGNAL_CODES.
 *  Cross-language parity is uncaught at compile time; the constant value is
 *  pinned in the constants-sanity test (T-F4-CONST). */
export const HIGH_SIGNAL_TRANSACTION_CODES = ['P', 'S'] as const;
export type HighSignalTransactionCode = (typeof HIGH_SIGNAL_TRANSACTION_CODES)[number];

const HIGH_SIGNAL_CODE_SET = new Set<string>(HIGH_SIGNAL_TRANSACTION_CODES);

/** Transaction-code semantic: P = open-market purchase (buy direction),
 *  S = open-market sale (sell direction). Pinned for self-documentation. */
export const BUY_CODE = 'P' as const;
export const SELL_CODE = 'S' as const;

// ── Trade-level pure functions ──────────────────────────────────────────────

/** A single Form 4 transaction row as consumed by the composite. The
 *  repository assembles these from `quantlab.insider_trades`; one row per
 *  (issuerCik, accession, transactionId) tuple matching the ReplacingMergeTree
 *  ORDER BY. */
export interface InsiderTrade {
  /** EDGAR accession number, e.g. "0001234567-26-123456". One per Form 4
   *  filing. */
  accession: string;
  /** 0-based index of this transaction within the parent Form 4 filing.
   *  Per S93-40: NOT a global key — `(issuerCik, accession, transactionId)`
   *  is the unique tuple. */
  transactionId: number;
  /** Issuer (company) 10-digit zero-padded CIK. */
  issuerCik: string;
  /** Resolved issuer ticker (may be '' when the CIK→ticker map has no
   *  entry). The repository slots both XML-supplied (primary, per S93-41)
   *  and submissions-API-supplied (fallback) values here. */
  issuerTicker: string;
  /** Insider's 10-digit zero-padded CIK. Distinct from `issuerCik` per F4-9
   *  + S93-39. Cluster-distinct-count operates on this field. */
  personCik: string;
  /** UInt8 bitmask of insider roles per F4-3 / S93 watch-out:
   *  bit0=director (1), bit1=officer (2), bit2=10pct_owner (4), bit3=other (8).
   *  v1 composite does not consume this field; pass-through documentation. */
  roleFlags: number;
  /** Transaction code: 'P' (open-market purchase), 'S' (open-market sale),
   *  or other (A, M, F, G, ...). The composite filters to {P, S} on read. */
  transactionCode: string;
  /** EDGAR acceptance datetime — the load-bearing anti-leak anchor per
   *  F4-10. All rolling-window math uses this, NEVER `transactionDate`. */
  acceptedAt: Date;
  /** Shares transacted. */
  shares: number;
  /** Per-share price disclosed in the Form 4. */
  pricePerShare: number;
  /** Dollar amount = shares × pricePerShare. Pre-computed at ingest per F4-5
   *  + S93 ("dollar_amount computed at ingest layer, not deferred to CH
   *  DEFAULT") so downstream consumers don't need to recompute. The
   *  composite trusts this field as authoritative. */
  dollarAmount: number;
  /** Provenance: 'sec_edgar_form4_xml' (real CIK) or 'finnhub' (synthetic
   *  name-hash). Cluster-identity computations admit EDGAR only per ADR-052 D1.
   *  The repository carries this through from `insider_trades.source`; absent
   *  rows default to '' (treated as non-canonical → excluded from cluster
   *  identity by `filterTradesToCanonicalSource`). */
  source: string;
}

/** Deduplicate trades by `(issuerCik, accession, transactionId)`. The
 *  ReplacingMergeTree ORDER BY at storage handles physical dedupe, but a
 *  re-ingest race or upstream replay can still emit duplicate logical rows
 *  to this pure function. Same defensive posture as
 *  eight_k_classifier.dedupeEvents. */
export function dedupeTrades(trades: ReadonlyArray<InsiderTrade>): InsiderTrade[] {
  const seen = new Set<string>();
  const out: InsiderTrade[] = [];
  for (const t of trades) {
    const key = `${t.issuerCik} ${t.accession} ${t.transactionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Filter trades to {P, S} per F4-4. This is the load-bearing read-time
 *  filter that S93-37 mandates: ingest stores ALL codes; the composite
 *  enforces the open-market subset here.
 *
 *  Exact string equality — leading/trailing whitespace or case drift
 *  silently filters out. Ingest is responsible for normalizing
 *  `transaction_code` (`scripts/sec_edgar_form4_ingest.py` does so). */
export function filterTradesToHighSignalCodes(
  trades: ReadonlyArray<InsiderTrade>,
): InsiderTrade[] {
  return trades.filter((t) => HIGH_SIGNAL_CODE_SET.has(t.transactionCode));
}

/** ADR-052 D1 — the cluster-identity gate. Retains ONLY rows whose `source`
 *  is the EDGAR canonical provenance (`sec_edgar_form4_xml`). Every computation
 *  whose correctness depends on distinct-insider identity (the 30d cluster
 *  flags, the sector cluster-rate, hence the z and the aggregate flags) MUST
 *  run on the output of this filter.
 *
 *  Finnhub rows are excluded because their `person_cik` is a synthetic
 *  `"FH"+sha1(name)` name-hash (S96-145) that collides/splits real people —
 *  counting "distinct `person_cik`" across the Finnhub population double-counts
 *  the 8,998 humans who appear under BOTH a numeric EDGAR CIK and an FH-hash
 *  (ADR-052 Context §2). Per Lakonishok & Lee 2001 §3 the cluster construct is
 *  defined over real distinct insiders, so the name-hash identity is invalid
 *  here independent of coverage.
 *
 *  Exact string equality on `EDGAR_CANONICAL_SOURCE`. Rows with an empty/absent
 *  `source` are treated as non-canonical and dropped (fail-closed). */
export function filterTradesToCanonicalSource(
  trades: ReadonlyArray<InsiderTrade>,
): InsiderTrade[] {
  return trades.filter((t) => t.source === EDGAR_CANONICAL_SOURCE);
}

/** Filter trades to a rolling window `[asOf - windowDays, asOf]` (inclusive
 *  on both boundaries per SPEC §9.7 T-F4-10).
 *  - A trade with `acceptedAt = asOf - windowDays 00:00:00` IS in window.
 *  - A trade with `acceptedAt = asOf - windowDays - 1ms` is NOT in window.
 *  - A trade with `acceptedAt > asOf` is NOT in window (F4-10 leak guard
 *    typically applied upstream at the repository; defensive here). */
export function filterTradesInWindow(
  trades: ReadonlyArray<InsiderTrade>,
  asOf: Date,
  windowDays: number,
): InsiderTrade[] {
  const asOfMs = asOf.getTime();
  const windowStartMs = asOfMs - windowDays * 24 * 60 * 60 * 1000;
  return trades.filter((t) => {
    const ms = t.acceptedAt.getTime();
    return ms >= windowStartMs && ms <= asOfMs;
  });
}

/** Count of trades with `transactionCode === code` in window. Used for
 *  `insiderBuyCount90d` (code=P) and `insiderSellCount90d` (code=S). */
export function countTradesByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  return filterTradesInWindow(trades, asOf, windowDays).filter(
    (t) => t.transactionCode === code,
  ).length;
}

/** Sum of `dollarAmount` for trades with `transactionCode === code` in
 *  window. Used for the per-direction sums inside `insiderNetDollar90d`. */
export function sumDollarsByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  let sum = 0;
  for (const t of filterTradesInWindow(trades, asOf, windowDays)) {
    if (t.transactionCode === code) sum += t.dollarAmount;
  }
  return sum;
}

/** Net dollar flow over the 90d window per F4-5:
 *  `Σ(buy_$ for P) − Σ(sell_$ for S)`. Sign matters; can be positive
 *  (net buying), negative (net selling), or zero. */
export function computeInsiderNetDollar(
  trades: ReadonlyArray<InsiderTrade>,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  return (
    sumDollarsByCode(trades, BUY_CODE, asOf, windowDays) -
    sumDollarsByCode(trades, SELL_CODE, asOf, windowDays)
  );
}

/** Count of distinct `personCik` values among trades with `transactionCode
 *  === code` within window. Per F4-2 + F4-9: cluster distinctness is on
 *  insider identity, NOT on filing or accession. A single insider filing 3
 *  separate trades counts as 1. */
export function countDistinctInsidersByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number,
): number {
  const distinct = new Set<string>();
  for (const t of filterTradesInWindow(trades, asOf, windowDays)) {
    if (t.transactionCode === code) distinct.add(t.personCik);
  }
  return distinct.size;
}

/** Cluster flag for a given direction. Fires when distinct-insider count
 *  in the cluster window meets or exceeds the threshold. Same direction
 *  semantic per F4-2 / HANDOFF watch-out: a 2-buy-1-sell mix does NOT fire
 *  either flag because each direction has < 3 distinct insiders alone. */
export function flagInsiderCluster(distinctInsiderCount: number): boolean {
  return distinctInsiderCount >= CLUSTER_INSIDER_THRESHOLD;
}

/** Days since the most-recent trade of `code` within the rolling window.
 *  Returns null when the window contains zero trades of that code (the
 *  "no signal" branch — distinct from "0 days since most recent" which
 *  means a trade happened today).
 *
 *  Used by `evaluateForm4InsiderComposite` to populate
 *  `daysSinceLatestBuy` / `daysSinceLatestSell` for the per-ticker
 *  row payload. Surfaced by the brief renderer as the SPEC §8.2 "last
 *  23d" recency hint:
 *
 *      QRST — 4 insiders bought (net +$2.3M, last 23d), code P
 *
 *  Math: `floor((asOf.getTime() - max(acceptedAt).getTime()) / 86_400_000)`.
 *  Floor (not round / ceil) so the integer count matches the SPEC's
 *  "Xd ago" semantic — a trade 23h59m ago is "0d" (today), a trade
 *  24h00m + 1ms ago is "1d". The F4-10 leak guard upstream prevents
 *  future-dated trades; a defensive negative result is theoretically
 *  possible but not observed in practice.
 *
 *  Direction isolation: a P-code (buy) trade in window does NOT
 *  contribute to `daysSinceLatestSell` and vice versa. */
export function daysSinceLatestTradeByCode(
  trades: ReadonlyArray<InsiderTrade>,
  code: string,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number | null {
  const inWindow = filterTradesInWindow(trades, asOf, windowDays);
  let latestMs = -Infinity;
  for (const t of inWindow) {
    if (t.transactionCode !== code) continue;
    const ms = t.acceptedAt.getTime();
    if (ms > latestMs) latestMs = ms;
  }
  if (latestMs === -Infinity) return null;
  const MS_PER_DAY = 86_400_000;
  return Math.floor((asOf.getTime() - latestMs) / MS_PER_DAY);
}

// ── Sector-aggregate pure functions ─────────────────────────────────────────

/** Count of UNIQUE tickers in a sector with an insider cluster of `direction`
 *  per F4-6 (buy) / F4-12 (sell): a ticker counts iff ≥ `CLUSTER_INSIDER_THRESHOLD`
 *  distinct `personCik` transacted in `direction` within the trailing
 *  `CLUSTER_WINDOW_DAYS` window. The INTEGER numerator of the cluster rate.
 *
 *  Counts UNIQUE tickers (not raw trades) — a single mega-insider mega-cluster
 *  on one ticker contributes 1 regardless of trade volume.
 *
 *  ADR-055 D1 — extracted from `computeSectorClusterRate` so the cross-sectional
 *  POOLED rate (`Σ clusterTickers / Σ sectorSize` across sectors) can accumulate
 *  the INTEGER numerator per sector without re-deriving the by-ticker grouping.
 *  `computeSectorClusterRate` is now `count / size` over this function, so its
 *  observable behavior is byte-identical (the existing per-sector tests pin it).
 *
 *  `direction` defaults to `BUY_CODE` ('P'); pass `SELL_CODE` ('S') for the
 *  sell-side. Direction is enforced at the type level via the
 *  `HighSignalTransactionCode` union — A/M/F/G/etc. cannot be passed. */
export function computeSectorClusterCount(
  sectorTrades: ReadonlyArray<InsiderTrade>,
  asOf: Date,
  direction: HighSignalTransactionCode = BUY_CODE,
): number {
  // Group trades by issuerTicker, then compute per-ticker cluster flag.
  const byTicker = new Map<string, InsiderTrade[]>();
  for (const t of sectorTrades) {
    const list = byTicker.get(t.issuerTicker);
    if (list) list.push(t);
    else byTicker.set(t.issuerTicker, [t]);
  }
  let clusterTickerCount = 0;
  for (const [, tickerTrades] of byTicker) {
    const distinctInsiders = countDistinctInsidersByCode(
      tickerTrades,
      direction,
      asOf,
      CLUSTER_WINDOW_DAYS,
    );
    if (flagInsiderCluster(distinctInsiders)) clusterTickerCount++;
  }
  return clusterTickerCount;
}

/** Sector cluster rate per F4-6 (buy-side) and F4-12 (v2 sell-side):
 *  `count(tickers in sector with insiderCluster<Direction>Flag) / sectorSize`.
 *
 *  Counts UNIQUE tickers (not raw trades) — a single mega-insider mega-cluster
 *  on one ticker contributes 1 to the numerator regardless of trade volume.
 *  Returns null when `sectorSize <= 0` (degenerate sector).
 *
 *  ADR-055 D1 — now a thin `count / size` wrapper over `computeSectorClusterCount`
 *  (the by-ticker grouping lives there) so the pooled numerator can reuse the same
 *  count without duplication. Observable behavior is UNCHANGED (byte-identical to
 *  the pre-v5 inline implementation; pinned by the existing T-F4-11 + the
 *  refactor-identity test).
 *
 *  `direction` defaults to `BUY_CODE` ('P') so existing call sites + tests
 *  retain byte-equal behavior. Pass `SELL_CODE` ('S') for the v2 sell-side
 *  aggregate (S95-1). Direction is enforced at the type level via the
 *  `HighSignalTransactionCode` union — A/M/F/G/etc. cannot be passed. */
export function computeSectorClusterRate(
  sectorTrades: ReadonlyArray<InsiderTrade>,
  sectorSize: number,
  asOf: Date,
  direction: HighSignalTransactionCode = BUY_CODE,
): number | null {
  if (sectorSize <= 0) return null;
  return computeSectorClusterCount(sectorTrades, asOf, direction) / sectorSize;
}

/** Count the number of maximal runs of consecutive strictly-positive (`> 0`)
 *  values in a finite, CHRONOLOGICALLY-ORDERED series.
 *
 *  ADR-054 D1 (OQ-C36-1) — this is the discrete specialization of López de
 *  Prado's average-uniqueness count (AFML Ch. 4 §4.3 "Number of Concurrent
 *  Labels" / §4.4 "Average Uniqueness of a Label"): consecutive daily
 *  cluster-rate observations share 29/30 of their trailing-30d window, so they
 *  are CONCURRENT (overlapping), NOT IID. One underlying cluster event elevates
 *  the sector rate for a RUN of ~30 consecutive admitted days — that whole
 *  30-day plateau is ONE near-unique event, not 30. The maximal-non-zero-run
 *  count is the number of distinct INDEPENDENT events the baseline contains,
 *  which is the right "effective sample" for the validity guard.
 *
 *  Examples: `[0,0]`→0; `[1,1,1]`→1 (a plateau collapses to one event);
 *  `[1,0,1,0,1]`→3; `[0,2,2,0,3]`→2.
 *
 *  Operates on the series IN ARRAY ORDER — chronological ordering is LOAD-BEARING
 *  (the repository builds the baseline ascending; see
 *  `populateSectorsForCycle`). A reorder would corrupt the event count.
 *
 *  Coverage-gap simplification (ADR-054 D1): the baseline array is COMPACTED
 *  (coverage-gap days are skipped at build time), so two non-zero admitted days
 *  separated by a real calendar gap are array-adjacent and would merge into one
 *  run. This UNDER-counts events across gaps → a STRICTER guard → safe (it can
 *  only suppress more, never fire more). Calendar-aware run-breaking is the
 *  documented refinement OQ-C37-1, deferred. */
export function countNonZeroRuns(series: ReadonlyArray<number>): number {
  let runs = 0;
  let inRun = false;
  for (const v of series) {
    if (v > 0) {
      if (!inRun) {
        runs++;
        inRun = true;
      }
    } else {
      inRun = false;
    }
  }
  return runs;
}

/** Result of the ADR-053 empirical-exceedance anomaly statistic (ADR-054 guard). */
export interface EmpiricalExceedanceResult {
  /** One-sided empirical upper-tail p-value, `(#{r_i ≥ today} + 1)/(n + 1)`.
   *  Null when a validity guard fails (insufficient data). Bounded
   *  `[1/(n+1), 1]`; smaller = more anomalous. */
  exceedance: number | null;
  /** Bounded z-equivalent for display continuity, `max(0, invNormCDF(1 − p))`.
   *  Null when a guard fails. One-sided (clamped ≥ 0 — "less clustering than
   *  usual" is not an anomaly). Bounded by the baseline resolution
   *  (`≤ invNormCDF(n/(n+1))` ≈ 2.58 at n≈204) — a fabricated 14σ is impossible. */
  zEmp: number | null;
  /** Count of finite baseline observations `n`. */
  baselineSize: number;
  /** ADR-054 — the GUARD metric: count of distinct INDEPENDENT events
   *  (`countNonZeroRuns` = maximal runs of consecutive non-zero baseline values).
   *  A ~30-day cluster-window plateau collapses to ONE event. The validity guard
   *  requires `effectiveEvents ≥ EVENT_FLOOR`. */
  effectiveEvents: number;
  /** Count of NON-ZERO baseline observations `m = #{r_i > 0}` — DIAGNOSTIC ONLY
   *  post-ADR-054 (the guard now uses `effectiveEvents`). Retained for forensic
   *  transparency / the brief table; it over-counts independent events by the
   *  cluster-window length and no longer gates validity. */
  effectiveSample: number;
  /** True when ANY validity guard failed → emit an honest insufficient-data
   *  state rather than a number. */
  insufficientData: boolean;
}

/** ADR-053 (S96-163) — one-sided empirical upper-tail exceedance anomaly
 *  statistic for the sector cluster-rate, with an effective-sample guard.
 *
 *  REPLACES `computeZ` on the aggregate cluster-rate path. The Gaussian z is
 *  invalid on the EDGAR-only coverage-gated baseline because that baseline is
 *  sparse, bounded, discrete, and zero-inflated (75–99% zeros): a single
 *  clustered ticker collapses σ and fabricates a 5–14σ "event." The empirical
 *  exceedance makes NO distributional assumption — it just asks where today's
 *  rate falls in the sector's own historical ECDF.
 *
 *  Statistic (Aronson, *Evidence-Based Technical Analysis* 2006, Monte-Carlo /
 *  bootstrap empirical p-value for technical rules on non-normal data — Tier-1
 *  canon; the conservative `≥`-tie / `+1`-numerator form is the standard
 *  North-et-al. / Davison-Hinkley empirical p-value):
 *
 *      p = ( #{ i : r_i ≥ r_today } + 1 ) / ( n + 1 )
 *
 *  Bounded `[1/(n+1), 1]`; smaller = more anomalous. The display value is the
 *  bounded z-equivalent `zEmp = max(0, invNormCDF(1 − p))` (one-sided), which
 *  is genuinely a normal quantile of the empirical tail probability (no
 *  Gaussian-moment fiction) and is bounded by the baseline resolution.
 *
 *  Validity guards — BOTH must pass, else `insufficientData = true` (null
 *  exceedance + null zEmp). Both derive from a single α (= FORM_4_EXCEEDANCE_ALPHA),
 *  so there are ZERO new free parameters (anti-shopping; AFML §11.4 /
 *  ADR-051 Decision 5):
 *    1. **Resolution floor:** `n ≥ MIN_Z_BASELINE` (= 30; the ECDF needs enough
 *       days to represent an α-tail).
 *    2. **Effective-sample floor (ADR-054 — the core fix):** `effectiveEvents ≥
 *       EVENT_FLOOR = ⌈1/α⌉` where `effectiveEvents = countNonZeroRuns(finite)`
 *       (the number of distinct INDEPENDENT events = maximal runs of consecutive
 *       non-zero baseline values). This REPLACES ADR-053's day-count floor
 *       `m ≥ ⌈α(n+1)⌉`, which counted ~30 autocorrelated days per ONE event (each
 *       daily rate is computed over a trailing 30d window, so one cluster event
 *       elevates the rate for a ~30-day plateau; AFML Ch. 4 §4.3–§4.4: those
 *       overlapping observations are concurrent, NOT IID). Counting events, not
 *       days, measures the independent-sample count the α-tail actually needs.
 *       Derivation of the floor: an α-tail is only representable from ≥ `⌈1/α⌉`
 *       independent observations (see `EVENT_FLOOR`). Worked example
 *       (Comm-Svcs 2026-04-30): the entire baseline is a single ~30-day plateau
 *       (one cluster event) → effectiveEvents = 1 < 20 → insufficient_data, not
 *       z=14.18 (and not the v3 "m=1 < 11" day-count rejection either — the
 *       fix generalizes to ANY single-plateau baseline, including those window-
 *       smeared to m ≈ 11–16 that the v3 day-count floor wrongly PASSED). ✓
 *
 *  `value == null` (degenerate sector, sectorSize ≤ 0) → insufficient_data.
 *  NaN/Infinity baseline entries are filtered out of `n` (mirrors computeZ).
 *  `baseline` is consumed IN ORDER for the event count — chronological ordering
 *  is LOAD-BEARING (ADR-054 D1; the order-invariant mean/exceedance from ADR-053
 *  are unchanged, but the run-count is not order-invariant). */
export function computeEmpiricalExceedance(
  value: number | null,
  baseline: ReadonlyArray<number>,
): EmpiricalExceedanceResult {
  const finite = baseline.filter((b) => Number.isFinite(b));
  const n = finite.length;
  let m = 0;
  for (const b of finite) if (b > 0) m++;
  // ADR-054 D1 — the GUARD metric: distinct independent events = maximal runs of
  // consecutive non-zero baseline values (a 30d cluster-window plateau → 1 event).
  // The non-zero day count `m` is RETAINED as a diagnostic only (it over-counts
  // events by the window length). `finite` is in chronological order (D1).
  const effectiveEvents = countNonZeroRuns(finite);
  // Guard 1 (resolution) + value validity + Guard 2 (ADR-054 event floor). The
  // event floor `EVENT_FLOOR = ⌈1/α⌉` derives solely from α — no new free param.
  if (
    value == null ||
    !Number.isFinite(value) ||
    n < MIN_Z_BASELINE ||
    effectiveEvents < EVENT_FLOOR
  ) {
    return {
      exceedance: null,
      zEmp: null,
      baselineSize: n,
      effectiveEvents,
      effectiveSample: m,
      insufficientData: true,
    };
  }
  let geCount = 0;
  for (const b of finite) if (b >= value) geCount++;
  const p = (geCount + 1) / (n + 1);
  // 1 − p ∈ [0, n/(n+1)]. invNormCDF returns +Infinity only at arg ≥ 1, which
  // cannot happen here (p ≥ 1/(n+1) > 0). At p === 1 (value below every baseline
  // day → geCount = n) the arg is 0 and invNormCDF returns −Infinity; max(0, …)
  // clamps zEmp to 0 (an honest "not anomalous", distinct from null).
  const oneMinusP = 1 - p;
  const zEmp = oneMinusP <= 0 ? 0 : Math.max(0, invNormCDF(oneMinusP));
  return {
    exceedance: p,
    zEmp,
    baselineSize: n,
    effectiveEvents,
    effectiveSample: m,
    insufficientData: false,
  };
}

/** @deprecated ADR-053 retired the Gaussian z on the cluster-rate. Use
 *  `computeEmpiricalExceedance`. Kept for the v1/v2 historical comparison + the
 *  T-F4-12/13 regression tests; NOT used by `evaluateForm4InsiderComposite`.
 *
 *  Z-score = (value - mean(baseline)) / stddev(baseline).
 *  Returns null + baselineSize when baseline has fewer than MIN_Z_BASELINE
 *  prints OR stddev is degenerate (≤ 1e-12).
 *
 *  Byte-identical shape to eight_k_classifier.computeZ +
 *  executive_departure.computeZ + etf_flow.computeZ. Sample stddev (n-1) per
 *  López de Prado AFML §1.3. */
export function computeZ(
  value: number | null,
  baseline: ReadonlyArray<number>,
): { z: number | null; baselineSize: number } {
  const validBaseline = baseline.filter((b) => Number.isFinite(b));
  const baselineSize = validBaseline.length;
  if (value == null || !Number.isFinite(value) || baselineSize < MIN_Z_BASELINE) {
    return { z: null, baselineSize };
  }
  let sum = 0;
  for (const b of validBaseline) sum += b;
  const mean = sum / baselineSize;
  let sumSq = 0;
  for (const b of validBaseline) {
    const d = b - mean;
    sumSq += d * d;
  }
  const stddev = Math.sqrt(sumSq / (baselineSize - 1));
  if (stddev < 1e-12) {
    return { z: null, baselineSize };
  }
  return { z: (value - mean) / stddev, baselineSize };
}

/** @deprecated ADR-053 retired the `|z| > 2` firing rule. Firing is now per
 *  the empirical-exceedance tail (`flagForm4ClusterEmpirical`). Kept for the
 *  T-F4-14 regression test only; NOT used by `evaluateForm4InsiderComposite`.
 *
 *  `form4ClusterFlag` (buy-side) / `form4SellClusterFlag` (v2 sell-side):
 *  ANY sector with |z| > 2.0. Returns false when all sector z-scores are
 *  null (cold-start). */
export function flagForm4Cluster(
  sectorZs: ReadonlyArray<number | null>,
): boolean {
  for (const z of sectorZs) {
    if (z != null && Math.abs(z) > FORM_4_CLUSTER_Z_THRESHOLD) return true;
  }
  return false;
}

/** ADR-053 firing rule — `form4ClusterFlag` / `form4SellClusterFlag` fire iff
 *  ANY VALID sector has empirical-exceedance `p ≤ α` (= FORM_4_EXCEEDANCE_ALPHA).
 *  Guard-suppressed sectors carry `null` exceedance and CANNOT fire (an
 *  insufficient-data sector is not an anomaly). Returns false when every sector
 *  is null (cold-start / all guard-suppressed). Direction-agnostic — the
 *  orchestrator calls this twice, once per direction. */
export function flagForm4ClusterEmpirical(
  sectorExceedances: ReadonlyArray<number | null>,
): boolean {
  for (const p of sectorExceedances) {
    if (p != null && p <= FORM_4_EXCEEDANCE_ALPHA) return true;
  }
  return false;
}

// ── Snapshot types ──────────────────────────────────────────────────────────

/** A single ticker's row in the snapshot's per_ticker payload.
 *  Mirrors SPEC §5.5 Form4InsiderSnapshot.per_ticker_rows[i]. */
export interface Form4InsiderPerTickerRow {
  ticker: string;
  cik: string;
  sector: string | null;
  insiderBuyCount90d: number;
  insiderSellCount90d: number;
  insiderBuyerCount90d: number;
  insiderSellerCount90d: number;
  insiderNetDollar90d: number;
  insiderClusterBuyFlag: boolean;
  insiderClusterSellFlag: boolean;
  /** Days since the most-recent P-code (buy) trade for this ticker in the
   *  90d rolling window. Null when `insiderBuyCount90d === 0` (no signal).
   *  Surfaced by the brief renderer as the SPEC §8.2 "last 23d" hint on
   *  cluster_buy per-ticker rows. v2 add per gap #7 v2 per-row recency. */
  daysSinceLatestBuy: number | null;
  /** Days since the most-recent S-code (sell) trade for this ticker in the
   *  90d rolling window. Null when `insiderSellCount90d === 0`. Surfaced on
   *  cluster_sell per-ticker rows in the brief. v2 add per gap #7 v2
   *  per-row recency. */
  daysSinceLatestSell: number | null;
  /** ADR-052 D3/D4 — source-mix label for the dual-source raw counts.
   *  Counts the in-window 90d P/S trades by provenance:
   *    - `edgar`   = trades with `source === EDGAR_CANONICAL_SOURCE`
   *    - `finnhub` = the rest (synthetic-identity Finnhub coverage).
   *  The raw counts (`insiderBuyCount90d` etc.) remain dual-source (EDGAR ∪
   *  Finnhub) for coverage value where identity precision does not matter; the
   *  CLUSTER flags are EDGAR-only (D1). This label makes that split honest —
   *  e.g. "5 buys but cluster flag off because only 2 were EDGAR." It serializes
   *  into `per_ticker_json` (no DDL change). */
  insiderCountSourceMix: { edgar: number; finnhub: number };
}

/** A flagged sector row — only emitted for VALID sectors that FIRE under
 *  ADR-053 (empirical-exceedance `p ≤ α`). The legacy `z` (Gaussian) field is
 *  replaced by `zEmp` (bounded empirical z-equivalent); the raw `exceedance`
 *  (tail p), `effectiveEvents` (ADR-054 guard metric), and `effectiveSample`
 *  (m = non-zero baseline days, diagnostic) are carried for forensic
 *  transparency. Serializes into the schemaless `flagged_sectors_json`
 *  / `flagged_sell_sectors_json` String columns (no DDL). */
export interface Form4InsiderFlaggedSector {
  sector: string;
  sectorSize: number;
  clusterRateT: number;
  /** Bounded empirical z-equivalent, `max(0, invNormCDF(1 − exceedance))`
   *  (ADR-053). Replaces the legacy Gaussian `z`. zEmp ≥ 0; a fabricated 14σ is
   *  impossible (bounded by the baseline resolution). */
  zEmp: number;
  /** One-sided empirical upper-tail p-value (ADR-053). `≤ α` for every flagged
   *  sector (that is the firing condition). */
  exceedance: number;
  /** ADR-054 guard metric — distinct INDEPENDENT events (maximal non-zero runs
   *  in the chronologically-ordered baseline). The validity guard that admitted
   *  this sector required `effectiveEvents ≥ EVENT_FLOOR`. */
  effectiveEvents: number;
  /** Effective sample = NON-ZERO baseline days `m` (DIAGNOSTIC ONLY post-ADR-054;
   *  the guard now uses `effectiveEvents`). Retained for forensic transparency. */
  effectiveSample: number;
  baselineSize: number;
}

/** ADR-055 D2 (v5) — the GATED pooled (index-level) statistic's metadata, per
 *  direction, surfaced so the dashboard can show "the fraction of the S&P 500
 *  with an insider cluster + its empirical-tail p" as THE gated signal (the
 *  per-sector list is informational only). Rides in the existing schemaless
 *  `flagged_sectors_json` / `flagged_sell_sectors_json` (NO DDL — ADR-055 D5).
 *  `pooledRateT` is null when the pool denominator was ≤ 0 (degenerate); the
 *  exceedance/zEmp fields are null when the ADR-053/054 guard suppressed
 *  (insufficient data — the honest pre-D7 state). */
export interface Form4InsiderPooledStat {
  /** Today's pooled rate `Σ clusterTickers / Σ sectorSize` (issuer-weighted),
   *  or null when the pool denominator was ≤ 0. */
  pooledRateT: number | null;
  /** Bounded empirical z-equivalent of the pooled exceedance (ADR-053). Null when
   *  the guard suppressed (insufficient data). Identical to `maxAggregateZ[Sell]`
   *  when non-null (this IS the gated stat post-v5). */
  zEmp: number | null;
  /** One-sided empirical upper-tail p-value of the pooled rate (ADR-053). Null
   *  when guard-suppressed. `≤ α` ⟺ the aggregate flag fired. */
  exceedance: number | null;
  /** ADR-054 guard metric — distinct INDEPENDENT events (maximal non-zero runs)
   *  in the chronologically-ordered POOLED baseline. The aggregate is Phase-B-
   *  ready iff this `≥ EVENT_FLOOR` (ADR-055 D3). Below the floor today. */
  effectiveEvents: number;
  /** Diagnostic — non-zero days `m` in the pooled baseline (over-counts events
   *  by the cluster-window length; NOT a gate post-ADR-054). */
  effectiveSample: number;
  /** Count of finite pooled-baseline observations `n`. */
  baselineSize: number;
  /** True when a validity guard failed → the aggregate is `under_review`. */
  insufficientData: boolean;
}

/** Inputs to the composite evaluator. The repository (A4) assembles these
 *  from CH reads of `insider_trades` + `cik_ticker_map` + `sp500_constituents`
 *  PIT + the GICS-sector mapping + per-sector trailing-2y daily cluster-rate
 *  panels. */
export interface Form4InsiderInputs {
  asOf: Date;

  /** Wall-clock UTC of the most-recent EDGAR poll. Null when ingest has
   *  never run. */
  lastEdgarQueryAt: Date | null;

  /** Business days between lastEdgarQueryAt and asOf. Used as a staleness
   *  indicator in the brief (healthy = 0-3; 4+ means ingest is stale). */
  bdSinceLastQuery: number | null;

  /** Per-ticker inputs for the watch universe (e.g. equity_midcap).
   *  `trades` is the FULL trailing-90d trade panel for the ticker (any
   *  transaction code admitted; the composite filters to {P, S} internally
   *  per F4-4 defensive read). */
  perTicker: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    trades: ReadonlyArray<InsiderTrade>;
  }>;

  /** Sector-aggregate inputs. One entry per GICS sector represented in the
   *  SPY-500 constituent panel as-of asOf. */
  sectors: ReadonlyArray<{
    sector: string;
    /** Number of SPY-500 constituents in this sector at asOf. */
    sectorSize: number;
    /** All trailing-90d trades for tickers in this sector. Any transaction
     *  code admitted; the composite filters to {P, S} internally. */
    trades: ReadonlyArray<InsiderTrade>;
    /** Trailing 2y daily panel of per-day cluster-BUY-rate (one value per
     *  business day in the trailing 2y window). Used for the buy-side
     *  z-score baseline per F4-6. */
    baseline2y: ReadonlyArray<number>;
    /** Trailing 2y daily panel of per-day cluster-SELL-rate (one value
     *  per business day in the trailing 2y window). Used for the v2
     *  sell-side z-score baseline per F4-12 (S95-1). Independent of
     *  `baseline2y` — the two metrics have different historical
     *  distributions (sell-cluster events are typically more frequent
     *  than buy-cluster events per Lakonishok-Lee 2001 §4). Pass `[]`
     *  for cold-start / pre-G2 wiring; the composite handles a
     *  short/empty baseline via the MIN_Z_BASELINE=30 floor. */
    baseline2ySell: ReadonlyArray<number>;
  }>;

  /** ADR-055 D1 (v5) — the INDEX-LEVEL pooled cluster-rate baseline for the
   *  GATED aggregate signal. One value per ADMITTED baseline day (the SAME
   *  ADR-052-D2 coverage-admitted day set the per-sector baselines use), in
   *  ASCENDING CHRONOLOGICAL ORDER (load-bearing per ADR-054 D1 —
   *  `countNonZeroRuns` runs over the ordered series). Each value is the
   *  issuer-weighted pool `Σ_sectors clusterTickers_s(day) / Σ_sectors
   *  memberCount_s(day)` over sectors with `memberCount > 0` that day = "fraction
   *  of the S&P 500 with an insider BUY cluster on that day." This is NOT the mean
   *  of the per-sector rates (which would equal-weight sectors of size 21..79);
   *  it is `Σ numerator / Σ denominator` (issuer-weighted). The pooled aggregate
   *  flag / `maxAggregateZ` derive from `computeEmpiricalExceedance(today's pooled
   *  rate, this baseline)`. Pass `[]` for cold-start / pre-v5 wiring; the
   *  composite handles a short/empty baseline via the MIN_Z_BASELINE + EVENT_FLOOR
   *  guards (it suppresses to insufficient-data). The per-sector `baseline2y[]`
   *  arrays survive as INFORMATIONAL color (ADR-055 D2). */
  pooledBaseline2y: ReadonlyArray<number>;
  /** ADR-055 D1 (v5) — the sell-side index-level pooled cluster-rate baseline.
   *  Mirror of `pooledBaseline2y` for the cluster-SELL rate; same admitted-day
   *  set, same ascending chronological order, same issuer-weighted pool. Pass
   *  `[]` for cold-start. */
  pooledBaseline2ySell: ReadonlyArray<number>;
}

/** Output snapshot — mirrors SPEC §5.5 + CH column shape (see A3 migration). */
export interface Form4InsiderSnapshot {
  snapshotDate: Date;
  lastEdgarQueryAt: Date | null;
  bdSinceLastQuery: number | null;

  /** ADR-055 D2 (v5): the per-sector flagged list is now INFORMATIONAL ONLY —
   *  retained + rendered (which sectors are clustering, with their `effectiveEvents`)
   *  but NEVER statistically gated. It does NOT drive `form4ClusterFlag` (which now
   *  derives from the pooled stat). The dashboard MUST label it "informational —
   *  not statistically calibrated (per-sector events too sparse; see ADR-055)".
   *  Pre-v5 (ADR-053/054) this was the gating list; post-v5 it is color. */
  flaggedSectors: ReadonlyArray<Form4InsiderFlaggedSector>;
  /** ADR-055 D1 (v5): fires iff the index-level POOLED cluster-BUY rate's
   *  empirical-exceedance `p ≤ α` (the gated unit is now the cross-sectional pool,
   *  NOT a max over 11 per-sector tests). A per-sector sector clearing α does NOT
   *  fire this flag (per-sector is informational, ADR-055 D2). False when the
   *  pooled stat is guard-suppressed (insufficient data — the honest pre-D7
   *  `under_review` state). Pre-v5 this was `ANY sector p ≤ α`. */
  form4ClusterFlag: boolean;

  /** ADR-055 D1 (v5): the BOUNDED empirical z-equivalent (`zEmp`) of the
   *  index-level POOLED cluster-BUY rate (no longer the max over per-sector
   *  zEmp). Null when the pooled stat is guard-suppressed/cold-start (insufficient
   *  data). Stored in `max_aggregate_z`; a fabricated 14σ is impossible (bounded by
   *  baseline resolution). Per SPEC docs/specs/phase-b-form_4_v1.md §1 Part A;
   *  consumed by the brief renderer's §1.4 branch + the composite dashboard. */
  maxAggregateZ: number | null;
  /** ADR-055 D5 (v5): the literal `'S&P 500'` when the pooled buy stat is VALID
   *  (the unit is the index, not a GICS sector), else null. Stored in
   *  `max_aggregate_z_sector`. (Pre-v5 this named the per-sector argmax.) */
  maxAggregateZSector: string | null;

  /** ADR-055 D2 (v5) — sell-side per-sector flagged list, INFORMATIONAL ONLY
   *  (mirror of `flaggedSectors`; non-gating). F4-12 (S95-1). */
  flaggedSellSectors: ReadonlyArray<Form4InsiderFlaggedSector>;
  /** ADR-055 D1 (v5): sell-side `form4ClusterFlag` mirror — fires iff the
   *  index-level POOLED cluster-SELL rate's empirical-exceedance `p ≤ α`.
   *  Independent of `form4ClusterFlag`; both can fire simultaneously or in
   *  isolation. False when the pooled sell stat is guard-suppressed. */
  form4SellClusterFlag: boolean;
  /** ADR-055 D1 (v5): the BOUNDED `zEmp` of the index-level POOLED cluster-SELL
   *  rate (no longer max-over-sectors). Null when the pooled sell stat is
   *  guard-suppressed/cold-start (incl. empty `pooledBaseline2ySell`). */
  maxAggregateZSell: number | null;
  /** ADR-055 D5 (v5): the literal `'S&P 500'` when the pooled sell stat is VALID,
   *  else null. (Pre-v5 this named the per-sector sell argmax.) */
  maxAggregateZSellSector: string | null;

  /** ADR-055 D2 (v5) — the GATED pooled BUY statistic's metadata (pooled rate +
   *  exceedance + `effectiveEvents` + baselineSize), so the dashboard can show the
   *  index-level signal explicitly. Rides in `flagged_sectors_json` (NO DDL). */
  pooledBuyStat: Form4InsiderPooledStat;
  /** ADR-055 D2 (v5) — the GATED pooled SELL statistic's metadata. Rides in
   *  `flagged_sell_sectors_json` (NO DDL). */
  pooledSellStat: Form4InsiderPooledStat;

  perTickerRows: ReadonlyArray<Form4InsiderPerTickerRow>;

  inputsAvailableAggregate: number;
  inputsAvailablePerTicker: number;
  version: Form4InsiderCompositeVersion;
}

// ── Composite orchestrator ──────────────────────────────────────────────────

/** Evaluate the Form 4 insider composite end-to-end.
 *
 *  Steps:
 *    1. Per-ticker: dedupe + code-filter + window-filter trades; derive
 *       per-direction counts, distinct-insider counts, net dollar, and the
 *       30d cluster flags (per direction).
 *    2. Sector-aggregate (ADR-055 v5): the GATED unit is the cross-sectional
 *       POOLED cluster-rate `pooledRate = Σ_sectors clusterTickers / Σ_sectors
 *       sectorSize` (issuer-weighted), fed through the ADR-053 empirical-exceedance
 *       statistic + ADR-054 event-floor guard (reused verbatim). `form4ClusterFlag`
 *       / `form4SellClusterFlag` + `maxAggregateZ[Sell]` derive from THIS pooled
 *       stat. The per-sector exceedances are STILL computed → `flaggedSectors[]` /
 *       `flaggedSellSectors[]` survive as INFORMATIONAL color (ADR-055 D2) but never
 *       gate. `maxAggregateZSector` = the literal 'S&P 500' when the pooled stat is
 *       valid (the unit is the index, ADR-055 D5).
 *    3. Compose into the snapshot shape.
 *
 *  No I/O. No side effects. Re-runnable with identical inputs.
 */
export function evaluateForm4InsiderComposite(
  inputs: Form4InsiderInputs,
): Form4InsiderSnapshot {
  // Per-ticker layer
  const perTickerRows: Form4InsiderPerTickerRow[] = [];
  let inputsAvailablePerTicker = 0;
  for (const row of inputs.perTicker) {
    const deduped = dedupeTrades(row.trades);
    const psFiltered = filterTradesToHighSignalCodes(deduped);

    // Raw counts + net-dollar stay DUAL-SOURCE (EDGAR ∪ Finnhub) per ADR-052
    // D3/D4 — coverage value where insider-identity precision does not matter.
    const insiderBuyCount90d = countTradesByCode(psFiltered, BUY_CODE, inputs.asOf);
    const insiderSellCount90d = countTradesByCode(psFiltered, SELL_CODE, inputs.asOf);
    const insiderBuyerCount90d = countDistinctInsidersByCode(
      psFiltered, BUY_CODE, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const insiderSellerCount90d = countDistinctInsidersByCode(
      psFiltered, SELL_CODE, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const insiderNetDollar90d = computeInsiderNetDollar(psFiltered, inputs.asOf);

    // Cluster flags become EDGAR-ONLY per ADR-052 D1 — the cluster metric
    // counts DISTINCT INSIDERS (distinct `person_cik` ≥ 3), and only the EDGAR
    // reporting-person CIK is a valid distinct-insider identity (Finnhub's
    // name-hash collides/splits people, S96-145). Derive the 30d distinct
    // counts from the canonical-source slice, NOT from the dual-source slice.
    const edgarPsFiltered = filterTradesToCanonicalSource(psFiltered);
    const distinctBuyers30d = countDistinctInsidersByCode(
      edgarPsFiltered, BUY_CODE, inputs.asOf, CLUSTER_WINDOW_DAYS,
    );
    const distinctSellers30d = countDistinctInsidersByCode(
      edgarPsFiltered, SELL_CODE, inputs.asOf, CLUSTER_WINDOW_DAYS,
    );

    const insiderClusterBuyFlag = flagInsiderCluster(distinctBuyers30d);
    const insiderClusterSellFlag = flagInsiderCluster(distinctSellers30d);

    const daysSinceLatestBuy = daysSinceLatestTradeByCode(
      psFiltered, BUY_CODE, inputs.asOf,
    );
    const daysSinceLatestSell = daysSinceLatestTradeByCode(
      psFiltered, SELL_CODE, inputs.asOf,
    );

    // ADR-052 D3/D4 source-mix label: count in-window 90d P/S trades by
    // provenance so the dual-source raw counts are honest about how many of
    // them carry EDGAR (cluster-valid) identity. Computed over the same
    // in-window slice the raw counts use.
    const inWindowPs = filterTradesInWindow(psFiltered, inputs.asOf, ROLLING_WINDOW_DAYS);
    let edgarMix = 0;
    for (const t of inWindowPs) {
      if (t.source === EDGAR_CANONICAL_SOURCE) edgarMix++;
    }
    const insiderCountSourceMix = {
      edgar: edgarMix,
      finnhub: inWindowPs.length - edgarMix,
    };

    if (row.sector != null && row.cik !== '') inputsAvailablePerTicker++;

    perTickerRows.push({
      ticker: row.ticker,
      cik: row.cik,
      sector: row.sector,
      insiderBuyCount90d,
      insiderSellCount90d,
      insiderBuyerCount90d,
      insiderSellerCount90d,
      insiderNetDollar90d,
      insiderClusterBuyFlag,
      insiderClusterSellFlag,
      daysSinceLatestBuy,
      daysSinceLatestSell,
      insiderCountSourceMix,
    });
  }

  // Sector-aggregate layer (ADR-055 v5) — the GATED unit is the cross-sectional
  // POOLED cluster-rate, NOT a max over 11 per-sector tests. Two things happen in
  // the sector loop:
  //   1. Per-sector exceedances are STILL computed → `flaggedSectors[]` /
  //      `flaggedSellSectors[]` survive as INFORMATIONAL color (ADR-055 D2). They
  //      no longer gate anything (no `form4ClusterFlag` derivation, no max reducer).
  //   2. The pooled NUMERATOR (Σ clusterTickers) and DENOMINATOR (Σ sectorSize) are
  //      accumulated across sectors so the index-level pooled rate
  //      `pooledRate = Σ num / Σ den` (issuer-weighted, NOT mean-of-rates) can be
  //      fed through `computeEmpiricalExceedance` against the pooled baseline.
  // The Gaussian z (`computeZ`) stays RETIRED; the ADR-053 statistic + ADR-054
  // event-floor guard are reused VERBATIM — only the series changes (11 → 1).
  const flaggedSectors: Form4InsiderFlaggedSector[] = [];
  const flaggedSellSectors: Form4InsiderFlaggedSector[] = [];
  let inputsAvailableAggregate = 0;
  // ADR-055 D1 — pooled (index-level) numerator + denominator accumulators. The
  // numerator is the INTEGER clustered-ticker count (computeSectorClusterCount);
  // the denominator is the sector size. The pooled rate is Σnum/Σden — issuer-
  // weighted, NOT the unweighted mean of per-sector rates (which would equal-weight
  // a size-21 sector with a size-79 one and is WRONG; ADR-055 D1 load-bearing).
  let pooledNumBuy = 0;
  let pooledNumSell = 0;
  let pooledDen = 0;
  for (const s of inputs.sectors) {
    const dedupedSectorTrades = dedupeTrades(s.trades);
    const psFilteredSectorTrades = filterTradesToHighSignalCodes(dedupedSectorTrades);
    const inWindowSectorTrades = filterTradesInWindow(
      psFilteredSectorTrades, inputs.asOf, ROLLING_WINDOW_DAYS,
    );

    // ADR-052 D1/D4 defense-in-depth: the sector cluster-rate is an
    // identity-dependent metric, so it must run on EDGAR-canonical rows only.
    // The repository (populateSectorsForCycle) already delivers EDGAR-only
    // trades for the sector path, but filtering here makes the composite robust
    // if it is ever fed a dual-source panel.
    const edgarSectorTrades = filterTradesToCanonicalSource(inWindowSectorTrades);

    // ADR-055 D1 — accumulate the pooled numerator (INTEGER clustered-ticker count)
    // + denominator (sector size). Only sectors with sectorSize > 0 contribute to
    // the pool (a degenerate sector has no issuers to cluster). The clustered-ticker
    // count is well-defined even for sectorSize ≤ 0 (it's a count over the trades),
    // but it can only enter the pool alongside a positive denominator.
    if (s.sectorSize > 0) {
      pooledNumBuy += computeSectorClusterCount(edgarSectorTrades, inputs.asOf, BUY_CODE);
      pooledNumSell += computeSectorClusterCount(edgarSectorTrades, inputs.asOf, SELL_CODE);
      pooledDen += s.sectorSize;
      inputsAvailableAggregate++;
    }

    // ADR-053 per-sector statistic — RETAINED but INFORMATIONAL ONLY (ADR-055 D2).
    // A guard-suppressed sector returns null exceedance/zEmp and is excluded from
    // the (informational) flagged list. NO max reducer, NO flag derivation here.
    const rateBuy = computeSectorClusterRate(
      edgarSectorTrades, s.sectorSize, inputs.asOf, BUY_CODE,
    );
    const rateSell = computeSectorClusterRate(
      edgarSectorTrades, s.sectorSize, inputs.asOf, SELL_CODE,
    );
    const buyStat = computeEmpiricalExceedance(rateBuy, s.baseline2y);
    const sellStat = computeEmpiricalExceedance(rateSell, s.baseline2ySell);
    // Informational flagged list (per-sector p ≤ α). Does NOT gate the aggregate.
    if (
      !buyStat.insufficientData &&
      buyStat.exceedance != null &&
      buyStat.exceedance <= FORM_4_EXCEEDANCE_ALPHA &&
      buyStat.zEmp != null &&
      rateBuy != null
    ) {
      flaggedSectors.push({
        sector: s.sector,
        sectorSize: s.sectorSize,
        clusterRateT: rateBuy,
        zEmp: buyStat.zEmp,
        exceedance: buyStat.exceedance,
        effectiveEvents: buyStat.effectiveEvents,
        effectiveSample: buyStat.effectiveSample,
        baselineSize: buyStat.baselineSize,
      });
    }
    if (
      !sellStat.insufficientData &&
      sellStat.exceedance != null &&
      sellStat.exceedance <= FORM_4_EXCEEDANCE_ALPHA &&
      sellStat.zEmp != null &&
      rateSell != null
    ) {
      flaggedSellSectors.push({
        sector: s.sector,
        sectorSize: s.sectorSize,
        clusterRateT: rateSell,
        zEmp: sellStat.zEmp,
        exceedance: sellStat.exceedance,
        effectiveEvents: sellStat.effectiveEvents,
        effectiveSample: sellStat.effectiveSample,
        baselineSize: sellStat.baselineSize,
      });
    }
  }

  // ADR-055 D1 — the GATED pooled statistic. pooledRate = Σ clusterTickers / Σ
  // sectorSize (issuer-weighted). Null when no sector had a positive denominator
  // (cold-start / degenerate). The ADR-053 exceedance + ADR-054 event-floor guard
  // run VERBATIM on the pooled rate vs the pooled baseline (the only change from
  // v4: the series is the index-level pool, not a per-sector series).
  const pooledRateBuyT = pooledDen > 0 ? pooledNumBuy / pooledDen : null;
  const pooledRateSellT = pooledDen > 0 ? pooledNumSell / pooledDen : null;
  const pooledBuyExc = computeEmpiricalExceedance(pooledRateBuyT, inputs.pooledBaseline2y);
  const pooledSellExc = computeEmpiricalExceedance(pooledRateSellT, inputs.pooledBaseline2ySell);

  // The aggregate flags derive from the POOLED exceedance ONLY (ADR-055 D1). A
  // per-sector sector clearing α does NOT fire the flag (it's informational).
  const form4ClusterFlag =
    pooledBuyExc.exceedance != null && pooledBuyExc.exceedance <= FORM_4_EXCEEDANCE_ALPHA;
  const form4SellClusterFlag =
    pooledSellExc.exceedance != null && pooledSellExc.exceedance <= FORM_4_EXCEEDANCE_ALPHA;
  // `maxAggregateZ[Sell]` = the pooled `zEmp` (no longer max-over-sectors).
  // `_sector` is the literal 'S&P 500' when the pooled stat is valid (ADR-055 D5 —
  // the unit is the index), else null.
  const maxAggregateZ = pooledBuyExc.zEmp;
  const maxAggregateZSector = pooledBuyExc.zEmp != null ? POOLED_AGGREGATE_LABEL : null;
  const maxAggregateZSell = pooledSellExc.zEmp;
  const maxAggregateZSellSector = pooledSellExc.zEmp != null ? POOLED_AGGREGATE_LABEL : null;

  const pooledBuyStat: Form4InsiderPooledStat = {
    pooledRateT: pooledRateBuyT,
    zEmp: pooledBuyExc.zEmp,
    exceedance: pooledBuyExc.exceedance,
    effectiveEvents: pooledBuyExc.effectiveEvents,
    effectiveSample: pooledBuyExc.effectiveSample,
    baselineSize: pooledBuyExc.baselineSize,
    insufficientData: pooledBuyExc.insufficientData,
  };
  const pooledSellStat: Form4InsiderPooledStat = {
    pooledRateT: pooledRateSellT,
    zEmp: pooledSellExc.zEmp,
    exceedance: pooledSellExc.exceedance,
    effectiveEvents: pooledSellExc.effectiveEvents,
    effectiveSample: pooledSellExc.effectiveSample,
    baselineSize: pooledSellExc.baselineSize,
    insufficientData: pooledSellExc.insufficientData,
  };

  return {
    snapshotDate: inputs.asOf,
    lastEdgarQueryAt: inputs.lastEdgarQueryAt,
    bdSinceLastQuery: inputs.bdSinceLastQuery,

    flaggedSectors,
    form4ClusterFlag,
    maxAggregateZ,
    maxAggregateZSector,

    flaggedSellSectors,
    form4SellClusterFlag,
    maxAggregateZSell,
    maxAggregateZSellSector,

    pooledBuyStat,
    pooledSellStat,

    perTickerRows,

    inputsAvailableAggregate,
    inputsAvailablePerTicker,
    version: FORM_4_INSIDER_COMPOSITE_VERSION,
  };
}

/**
 * What could break this:
 *   - **Cross-sectional POOLED unit (ADR-055 — OQ-C37-3; v5).** The aggregate flag
 *     + `maxAggregateZ[Sell]` now derive from the INDEX-LEVEL pooled cluster-rate
 *     `Σ_sectors clusterTickers / Σ_sectors sectorSize` (issuer-weighted), NOT a
 *     MAX over 11 per-sector tests. The pool MUST be `Σ numerator / Σ denominator`
 *     (issuer-weighted) — `mean(per-sector rate)` is WRONG (it equal-weights a
 *     size-21 sector against a size-79 one). A regression that reverted to the
 *     max-over-sectors reducer would resurrect the 11-way multiple-testing burden
 *     (HLZ 2016 §II) ADR-055 closed. The per-sector `flaggedSectors[]` lists are
 *     INFORMATIONAL ONLY (ADR-055 D2) — any consumer/reader that gates on a
 *     per-sector form_4 flag is using a NON-calibrated signal. The pooled stat is
 *     the gated unit; `maxAggregateZSector` = 'S&P 500' (the index) when valid. At
 *     current EDGAR coverage the pooled event count is BELOW `EVENT_FLOOR` (ADR-055
 *     D3: pooled events ≤ 15 buy / 19 sell < 20), so the aggregate honestly
 *     suppresses to `under_review`; the floor is NOT lowered (anti-shopping —
 *     AFML §11.4). The construct is correct; coverage (ADR-052 D7) is the gate.
 *   - **Aggregate anomaly statistic (ADR-053 — S96-163) + effective-sample guard
 *     (ADR-054 — OQ-C36-1).** The pooled aggregate flag + `maxAggregateZ[Sell]`
 *     derive from the one-sided EMPIRICAL EXCEEDANCE statistic
 *     (`computeEmpiricalExceedance`), NOT the Gaussian z (`computeZ`, retired from
 *     this path). The Gaussian z is invalid on the sparse, zero-inflated
 *     EDGAR-only coverage-gated baseline (one ordinary clustered ticker fabricated
 *     up to 14.18σ). Two guards (both α-derived, zero new free params) gate
 *     validity: the resolution floor `n ≥ MIN_Z_BASELINE` and the EFFECTIVE-sample
 *     floor — which under ADR-054 counts distinct INDEPENDENT EVENTS
 *     (`effectiveEvents = countNonZeroRuns(baseline) ≥ EVENT_FLOOR = ⌈1/α⌉`), NOT
 *     non-zero days. CHRONOLOGICAL BASELINE ORDERING IS NOW LOAD-BEARING: the
 *     run-count is order-sensitive (unlike the order-invariant exceedance), so a
 *     reorder of the baseline corrupts the event count. A regression that
 *     re-routed the aggregate through `computeZ`, OR that counted DAYS instead of
 *     EVENTS for the effective-sample guard (e.g. reverting to ADR-053's
 *     `m ≥ ⌈α(n+1)⌉`), would resurrect the autocorrelation under-protection — one
 *     30-day plateau would read as ~30 "effective" observations when it is ONE
 *     event. The stored `zEmp` is BOUNDED (≤ ~2.58 at n≈204) by construction; a
 *     value past ~3 on a normal baseline would itself be a bug signal. PUSHBACK
 *     note: even valid, the statistic is DATA-LIMITED (resolution floor
 *     `1/(n+1)`) AND now requires ≥ 20 independent events; at current EDGAR
 *     coverage essentially every sector falls below `EVENT_FLOOR` →
 *     `under_review` (the honest pre-D7 state). The form_4 aggregate is not
 *     Phase-B-usable until ADR-052 D7 (EDGAR coverage backfill) lands AND a sector
 *     actually clears the event floor.
 *   - **Source-provenance boundary (ADR-052 D1/D2/D3/D4 — S96-146).** The
 *     cluster path (per-ticker cluster flags, the sector cluster-rate, hence
 *     `form4ClusterFlag` / `form4SellClusterFlag` / `maxAggregateZ[Sell]`) is
 *     EDGAR-ONLY: it runs on `filterTradesToCanonicalSource(...)` output because
 *     "distinct insider" is only well-defined under the real EDGAR
 *     reporting-person CIK (Finnhub's name-hash collides/splits people,
 *     S96-145). The raw per-ticker counts (`insiderBuyCount90d` etc.) remain
 *     DUAL-SOURCE (EDGAR ∪ Finnhub) for coverage value, carrying an
 *     `insiderCountSourceMix` label (D3/D4) so the split is honest. The
 *     coverage-homogeneous baseline (D2) is built in the repository
 *     (`populateSectorsForCycle`): the baseline admits only days where EDGAR
 *     was actively ingesting, never zero-filling gap days.
 *     `EDGAR_CANONICAL_SOURCE` uses exact string equality; an empty/absent
 *     `source` fails closed (row dropped from the cluster path).
 *   - **Cross-language drift on the {P, S} filter (S93-37 load-bearing).**
 *     Python ingest's `DEFAULT_HIGH_SIGNAL_CODES = ("P", "S")` and this
 *     module's `HIGH_SIGNAL_TRANSACTION_CODES` are conceptually byte-pinned
 *     but there's no compile-time link. If a future v2 widens the code set
 *     (e.g., adds "M" exercises) without changing this constant, the
 *     composite silently filters them out at read — even though ingest
 *     stores them. The constants-sanity test pins both values to {P, S}
 *     for v1; a v2 widening MUST update both ends + the test.
 *   - **Same-direction cluster semantic (F4-2 + HANDOFF watch-out).** A
 *     2-buy-1-sell mix has < 3 distinct insiders in each direction alone,
 *     so neither `insiderClusterBuyFlag` nor `insiderClusterSellFlag`
 *     fires. A reader expecting "any 3 insiders in 30d" semantic would be
 *     surprised. Per F4-2 lock: direction matters because mixed clusters
 *     don't carry directional conviction.
 *   - **Distinct on personCik, NOT on accession (F4-2 + S93-39 + HANDOFF
 *     watch-out).** A single insider filing 3 separate buys counts as 1.
 *     Person CIK ≠ Issuer CIK ≠ filing accession. The natural-person-CIK
 *     resolution at ingest is load-bearing for this semantic.
 *   - **Two-track aggregate (F4-6 buy + F4-12 v2 sell).** `form4ClusterFlag`
 *     fires on concentrated insider BUYING activity (bullish surprise);
 *     `form4SellClusterFlag` (S95-1) fires on concentrated SELLING activity.
 *     The two flags are INDEPENDENT — both can fire simultaneously, neither
 *     can fire, or either can fire alone. Downstream consumers (brief
 *     render, position sizing) should weight the sell signal asymmetrically
 *     per Lakonishok-Lee 2001 §4 (sell signal is ~30-50% diluted by
 *     tax/diversification/charity motives — informationally weaker than
 *     buys but non-zero). The composite intentionally does NOT collapse
 *     the two tracks into a single "any anomalous activity" flag because
 *     the information content differs.
 *   - **Sell-side baseline is INDEPENDENT of buy-side baseline.**
 *     `baseline2y` and `baseline2ySell` track different historical
 *     distributions; a sector's typical sell-cluster-rate is typically
 *     higher than its typical buy-cluster-rate (sells are more frequent
 *     in steady-state). Mixing the two baselines would distort the z-test
 *     in either direction.
 *   - **Off-set codes silently filtered at composite layer.** A regression
 *     that read the raw insider_trades stream WITHOUT calling
 *     `filterTradesToHighSignalCodes` first would dilute counts with
 *     grants, option exercises, gifts, etc. The orchestrator enforces the
 *     filter; direct callers of `countTradesByCode` etc. must filter
 *     themselves OR pass an already-filtered slice.
 *   - **Window inclusivity on both ends.** A trade at `acceptedAt = asOf -
 *     90d 00:00:00.000Z` IS in window; at `asOf - 90d - 1ms` is NOT.
 *     Repository-layer leak guards (F4-10) typically run before this; the
 *     composite is defense-in-depth.
 *   - **`acceptedAt` is the load-bearing anchor (F4-10).** Using
 *     `transactionDate` for windowing would inject look-ahead leakage —
 *     insiders have 2 business days to file post-trade per 17 CFR
 *     240.16a-3. The composite trusts the caller to pass `acceptedAt`;
 *     downstream verification is at the repository layer.
 *   - **Cold-start / guard-suppression cascade in aggregate.** A sector whose
 *     baseline fails either ADR-053 guard returns null exceedance/zEmp and is
 *     excluded from the flagged list + the max reducer, but `form4ClusterFlag`
 *     still fires if any OTHER VALID sector clears the α-tail. When EVERY sector
 *     is guard-suppressed, `maxAggregateZ[Sell]` is null AND both flags are
 *     false — the honest "insufficient data / statistic under review" state
 *     (dashboard `under_review` verdict per ADR-053 §7). Operator sees the
 *     cold-start via `inputsAvailableAggregate < sector count` in the snapshot.
 *   - **`dollarAmount` trusted as-is.** F4-5 pre-computes `shares ×
 *     pricePerShare` at ingest per S93. If a future ingest regression sets
 *     `dollarAmount = 0` while preserving shares + price, net-dollar math
 *     silently zeroes. Round-trip tests at the ingest layer pin this; the
 *     composite is downstream.
 *   - **`roleFlags` pass-through only.** v1 weights each role at 1.0 per
 *     F4-3; the field is on `InsiderTrade` for forensic completeness but
 *     not consumed by any composite formula. v2 ADR can resurface for
 *     CEO-weighted variants.
 */
