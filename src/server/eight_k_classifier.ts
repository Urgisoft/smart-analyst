/**
 * 8-K classifier composite — Layer-0 informational input (Phase A2).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§2.2, 5.1, 5.2, 9.1.
 *
 * Purpose:
 *   Two scopes, both informational-only in v1 per the Phase 9+ gap-inventory
 *   README principle #5 (log first, gate after Phase B independence test):
 *
 *   1. **Per-stock** (watch-universe filtered, e.g. equity-midcap): emit
 *      `material_event_flag` + per-item flags (`impairment_flag`,
 *      `restatement_flag`, `auditor_change_flag`, `delisting_flag`,
 *      `control_change_flag`, `material_agreement_flag`, `acquisition_flag`)
 *      per ticker, sourced from `quantlab.eight_k_events` rows. Each per-item
 *      flag fires when ≥ 1 qualifying 8-K with that item code is within the
 *      trailing 90-calendar-day rolling window.
 *
 *   2. **Aggregate** (SPY-500 PIT-as-of-D, sliced by GICS sector): emit
 *      `eight_k_cluster_flag` when ANY sector's event-rate z-score against a
 *      2y daily baseline exceeds |z| > 2 symmetrically. Sector event rate =
 *      count(distinct (ticker, accession) in sector ∩ high-signal-item set ∩
 *      trailing 90d) / sector_size. A single 8-K filing with multiple
 *      high-signal items counts ONCE toward the sector rate per EK-2 + SPEC
 *      §5.2 distinct-on-(ticker, accession) rule (test T-EK-13).
 *
 * Canon (acknowledged thin for 8-K Item-level event studies):
 *   - Lerman & Livnat 2010 *Review of Accounting Studies* — 8-K abnormal
 *     return reactions broadly; high-signal subset {1.01, 2.01, 2.06, 3.01,
 *     4.01, 4.02, 5.01} concentrates the canon-supported items.
 *   - Hennes, Leone, Miller 2008 *Accounting Review* — 4.02 restatement
 *     announcements; large negative abnormal returns on the announcement day.
 *   - Francis et al. 2008 *J. Acc. Econ.* — 4.01 auditor change material
 *     information event.
 *
 * Design choices (SPEC §2.2 locks):
 *   - EK-1: high-signal item set = {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01}.
 *   - EK-2: item-code-only classification (no free-text NLP). Ingest filters
 *     to this set at write-time; the composite re-asserts the filter on read
 *     for defensive correctness (an off-set item-row in the source is
 *     ignored). No sub-item parsing (cheaper than gap #8's Item 5.02 sub-item
 *     extraction).
 *   - EK-3: 90 calendar-day rolling window (matches gap #8 + cycle-position
 *     retune-window convention; no academic anchor for the precise number).
 *   - EK-4: aggregate z-threshold |z| > 2.0 symmetric, OR across sectors.
 *   - EK-5: storage parallel to gap #8's `executive_departures` table — 5.02
 *     events live in BOTH tables (intentional duplication; do not consolidate
 *     per S93-12).
 *   - EDF-7: MIN_Z_BASELINE = 30 prints floor (matches the constant across
 *     all six Layer-0 composites).
 *
 * Pure-function layer:
 *   This module exposes only pure functions + type definitions. Z-score
 *   baselines are INPUTS (computed by the A4 repository from a 2y trailing
 *   panel), not computed inside this module. Same architectural separation
 *   as short_interest.ts, cross_asset_signals.ts, executive_departure.ts,
 *   and etf_flow.ts.
 */

/** Composite version. Bump on any change to window length, thresholds,
 *  aggregator, item-code scope, or universe definition. Stored alongside
 *  every snapshot for backtest reproducibility. */
export const EIGHT_K_CLASSIFIER_COMPOSITE_VERSION = 'eight_k_classifier_v1' as const;
export type EightKClassifierCompositeVersion = typeof EIGHT_K_CLASSIFIER_COMPOSITE_VERSION;

// ── SPEC-pinned thresholds (re-tuning bumps composite version) ──────────────

/** EK-3: rolling-window length for "recent event" detection (calendar days). */
export const ROLLING_WINDOW_DAYS = 90;

/** EK-4: |z| > 2.0 symmetric for eight_k_cluster_flag (any sector). */
export const EIGHT_K_CLUSTER_Z_THRESHOLD = 2.0;

/** EDF-7: minimum baseline prints for a valid z-score. Matches the
 *  MIN_Z_BASELINE constant across all Layer-0 composites. */
export const MIN_Z_BASELINE = 30;

/** EK-1: high-signal item subset per Lerman-Livnat 2010 §4. The composite
 *  ignores filings whose item codes fall outside this set. Order-preserving
 *  so the constant doubles as a stable enumeration for tests + briefs.
 *
 *  Byte-pinned to scripts/sec_edgar_8k_event_ingest.py:DEFAULT_HIGH_SIGNAL_ITEMS
 *  via test T-EK (DEFAULT_HIGH_SIGNAL_ITEMS_matches_spec_ek_1) and the cross-
 *  language parity by SPEC §2.2 EK-1. */
export const HIGH_SIGNAL_ITEM_CODES = [
  '1.01', '2.01', '2.06', '3.01', '4.01', '4.02', '5.01',
] as const;
export type HighSignalItemCode = (typeof HIGH_SIGNAL_ITEM_CODES)[number];

const HIGH_SIGNAL_ITEM_SET = new Set<string>(HIGH_SIGNAL_ITEM_CODES);

/** Per-item code → per-flag-name mapping per SPEC §5.1.
 *  Acquisition-disposition + material-agreement deliberately stripped of the
 *  "_disposition" half — SPEC §5.5 names the per-ticker payload field
 *  `acquisition_flag` (covers both acquisitions AND dispositions per Item 2.01).
 */
export const ITEM_CODE_FLAG_NAMES = {
  '1.01': 'materialAgreementFlag',
  '2.01': 'acquisitionFlag',
  '2.06': 'impairmentFlag',
  '3.01': 'delistingFlag',
  '4.01': 'auditorChangeFlag',
  '4.02': 'restatementFlag',
  '5.01': 'controlChangeFlag',
} as const satisfies Record<HighSignalItemCode, string>;

// ── Event-level pure functions ──────────────────────────────────────────────

/** A single 8-K event row as consumed by the composite. The repository
 *  assembles these from `quantlab.eight_k_events`; one row per
 *  (cik, accession, item_code) tuple. */
export interface EightKEvent {
  /** EDGAR accession number, e.g. "0001193125-26-123456". Used for
   *  event-deduplication per EK-2: same (cik, accession, itemCode) twice
   *  collapses to one event. */
  accession: string;
  /** Issuer 10-digit zero-padded CIK. */
  cik: string;
  /** Resolved ticker (may be '' when the CIK→ticker map has no entry). */
  ticker: string;
  /** Item code; the composite filters to HIGH_SIGNAL_ITEM_CODES only. */
  itemCode: string;
  /** EDGAR acceptance datetime — the load-bearing anti-leak anchor per
   *  EDF-5 / EDF-7. All rolling-window math uses this, NEVER period_of_report. */
  acceptedAt: Date;
}

/** Deduplicate events by (cik, accession, itemCode) — same tuple appearing
 *  twice in the input is counted once. SPEC §9.1 T-EK-14. */
export function dedupeEvents(events: ReadonlyArray<EightKEvent>): EightKEvent[] {
  const seen = new Set<string>();
  const out: EightKEvent[] = [];
  for (const e of events) {
    const key = `${e.cik} ${e.accession} ${e.itemCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Filter events to a rolling window `[asOf - windowDays, asOf]` (inclusive
 *  on both boundaries per SPEC §9.1 T-EK-12).
 *  - An event with `acceptedAt = asOf - 90d 00:00:00` IS in window.
 *  - An event with `acceptedAt = asOf - 90d - 1ms` is NOT in window.
 *  - An event with `acceptedAt > asOf` is NOT in window (EDF-5 leak guard
 *    typically applied upstream at the repository layer; this function is
 *    defensive). */
export function filterEventsInWindow(
  events: ReadonlyArray<EightKEvent>,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): EightKEvent[] {
  const asOfMs = asOf.getTime();
  const windowStartMs = asOfMs - windowDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => {
    const t = e.acceptedAt.getTime();
    return t >= windowStartMs && t <= asOfMs;
  });
}

/** Count of events matching a specific item code within the window. Per-item
 *  flags are derived from this (count ≥ 1 ⇒ flag fires). */
export function countEventsForItem(
  events: ReadonlyArray<EightKEvent>,
  itemCode: string,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  const matched = events.filter((e) => e.itemCode === itemCode);
  return filterEventsInWindow(matched, asOf, windowDays).length;
}

/** Single-event-count → boolean flag derivation. Symmetric across per-item
 *  flags (impairment / restatement / auditor_change / delisting /
 *  control_change / material_agreement / acquisition). */
export function flagItem(count: number): boolean {
  return count >= 1;
}

/** Count of DISTINCT accession numbers within the rolling window for events
 *  whose item codes fall in the high-signal set. Per SPEC §5.1
 *  `recent_event_count_90d`: a single 8-K with multiple high-signal items
 *  counts ONCE.
 *
 *  Filters to the high-signal set BEFORE deduping so that an accession with
 *  one high-signal item and one off-set item counts as one event (correct
 *  semantic — the off-set item is irrelevant). */
export function countDistinctAccessionsInHighSignalSet(
  events: ReadonlyArray<EightKEvent>,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  const inWindow = filterEventsInWindow(events, asOf, windowDays);
  const distinctAccessions = new Set<string>();
  for (const e of inWindow) {
    if (HIGH_SIGNAL_ITEM_SET.has(e.itemCode)) {
      distinctAccessions.add(e.accession);
    }
  }
  return distinctAccessions.size;
}

/** Calendar days between the most-recent high-signal event's `acceptedAt`
 *  and `asOf`. Returns null when no qualifying high-signal events exist
 *  within the window. Uses integer-day truncation per gap #8 convention. */
export function daysSinceLatestHighSignalEvent(
  events: ReadonlyArray<EightKEvent>,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number | null {
  const inWindow = filterEventsInWindow(
    events.filter((e) => HIGH_SIGNAL_ITEM_SET.has(e.itemCode)),
    asOf,
    windowDays,
  );
  if (inWindow.length === 0) return null;
  let latestMs = -Infinity;
  for (const e of inWindow) {
    const t = e.acceptedAt.getTime();
    if (t > latestMs) latestMs = t;
  }
  const diffMs = asOf.getTime() - latestMs;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// ── Sector-aggregate pure functions ─────────────────────────────────────────

/** Sector event rate = count(distinct (ticker, accession) in sector ∩
 *  high-signal-item set ∩ window) / sectorSize. Returns null when
 *  sectorSize <= 0 (degenerate sector).
 *
 *  The distinct-on-(ticker, accession) rule (SPEC §5.2 + T-EK-13) means a
 *  single 8-K with multiple high-signal items contributes 1 to the numerator,
 *  not N. Off-set items are filtered before deduplication. */
export function computeSectorEventRate(
  sectorEvents: ReadonlyArray<EightKEvent>,
  sectorSize: number,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number | null {
  if (sectorSize <= 0) return null;
  const inWindow = filterEventsInWindow(sectorEvents, asOf, windowDays);
  const distinctPairs = new Set<string>();
  for (const e of inWindow) {
    if (!HIGH_SIGNAL_ITEM_SET.has(e.itemCode)) continue;
    distinctPairs.add(`${e.ticker} ${e.accession}`);
  }
  return distinctPairs.size / sectorSize;
}

/** Z-score = (value - mean(baseline)) / stddev(baseline).
 *  Returns null + baselineSize when baseline has fewer than MIN_Z_BASELINE
 *  prints OR stddev is zero (degenerate baseline).
 *
 *  Identical shape to executive_departure.ts:computeZ + etf_flow.ts:computeZ.
 *  Sample stddev (n-1) per López de Prado AFML §1.3. Sub-1e-12 stddev treated
 *  as degenerate to avoid FP-noise-driven spurious z-scores. */
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

/** `eight_k_cluster_flag`: ANY sector with |z| > 2.0. Returns false when all
 *  sector z-scores are null (cold-start). */
export function flagEightKCluster(
  sectorZs: ReadonlyArray<number | null>,
): boolean {
  for (const z of sectorZs) {
    if (z != null && Math.abs(z) > EIGHT_K_CLUSTER_Z_THRESHOLD) return true;
  }
  return false;
}

// ── Snapshot types ──────────────────────────────────────────────────────────

/** A single ticker's row in the snapshot's per_ticker payload.
 *  Mirrors SPEC §5.5 EightKClassifierSnapshot.per_ticker_rows[i]. */
export interface EightKClassifierPerTickerRow {
  ticker: string;
  cik: string;
  sector: string | null;
  recentEventCount90d: number;
  daysSinceLatestEvent: number | null;
  materialEventFlag: boolean;
  impairmentFlag: boolean;
  restatementFlag: boolean;
  auditorChangeFlag: boolean;
  delistingFlag: boolean;
  controlChangeFlag: boolean;
  materialAgreementFlag: boolean;
  acquisitionFlag: boolean;
}

/** A flagged sector row — only emitted for sectors with |z| > 2.0. */
export interface EightKClassifierFlaggedSector {
  sector: string;
  sectorSize: number;
  eventRateT: number;
  z: number;
  baselineSize: number;
}

/** Inputs to the composite evaluator. The repository (A4) assembles these
 *  from CH reads of `eight_k_events` + `cik_ticker_map` + `sp500_constituents`
 *  PIT + the GICS-sector mapping + per-sector trailing-2y daily event-rate
 *  panels. */
export interface EightKClassifierInputs {
  asOf: Date;

  /** Wall-clock UTC of the most-recent EDGAR poll. Null when ingest has
   *  never run. */
  lastEdgarQueryAt: Date | null;

  /** Business days between lastEdgarQueryAt and asOf. Used as a staleness
   *  indicator in the brief (healthy = 0-3; 4+ means ingest is stale). */
  bdSinceLastQuery: number | null;

  /** Per-ticker inputs for the watch universe (e.g. equity_midcap).
   *  `events` is the FULL trailing-90d event panel for the ticker (item
   *  codes inside AND outside the high-signal set both allowed; the
   *  composite filters internally per SPEC §5.1 EK-2 defensive read). */
  perTicker: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    events: ReadonlyArray<EightKEvent>;
  }>;

  /** Sector-aggregate inputs. One entry per GICS sector represented in the
   *  SPY-500 constituent panel as-of asOf. */
  sectors: ReadonlyArray<{
    sector: string;
    /** Number of SPY-500 constituents in this sector at asOf. */
    sectorSize: number;
    /** All 90d-rolling-window events for tickers in this sector. */
    events: ReadonlyArray<EightKEvent>;
    /** Trailing 2y daily panel of `event_rate_s` (one value per business
     *  day in the trailing 2y window). Used for z-score baseline. */
    baseline2y: ReadonlyArray<number>;
  }>;
}

/** Output snapshot — mirrors SPEC §5.5 + CH column shape (see A3 migration). */
export interface EightKClassifierSnapshot {
  snapshotDate: Date;
  lastEdgarQueryAt: Date | null;
  bdSinceLastQuery: number | null;

  flaggedSectors: ReadonlyArray<EightKClassifierFlaggedSector>;
  eightKClusterFlag: boolean;

  /** Signed z of the sector with max |z| across all sectors with non-null z.
   *  Null when all sector z's are null (cold-start). Per ADR-042 §1 Decision §1
   *  + SPEC docs/specs/gics-sector-baseline-computation.md §2; consumed by the
   *  brief renderer's §1.4 "No sectors flagged today" branch. */
  maxAggregateZ: number | null;
  /** Sector name with max |z|. Null when all z's are null. Ties broken
   *  lexicographically (earlier sector name wins; deterministic across runs). */
  maxAggregateZSector: string | null;

  perTickerRows: ReadonlyArray<EightKClassifierPerTickerRow>;

  inputsAvailableAggregate: number;
  inputsAvailablePerTicker: number;
  version: EightKClassifierCompositeVersion;
}

// ── Composite orchestrator ──────────────────────────────────────────────────

/** Evaluate the 8-K classifier composite end-to-end.
 *
 *  Steps:
 *    1. Per-ticker: dedupe + window-filter events; derive per-item flags
 *       (count ≥ 1 for each high-signal item code), the disjunction
 *       `material_event_flag`, the distinct-accession count
 *       `recent_event_count_90d`, and the recency `days_since_latest_event`.
 *    2. Sector-aggregate: per sector, compute event_rate_t (distinct
 *       (ticker, accession) over high-signal item set) and z-score against
 *       the trailing 2y baseline; emit a flaggedSectors row when |z| > 2.0.
 *    3. Compose into the snapshot shape.
 *
 *  No I/O. No side effects. Re-runnable with identical inputs.
 */
export function evaluateEightKClassifierComposite(
  inputs: EightKClassifierInputs,
): EightKClassifierSnapshot {
  // Per-ticker layer
  const perTickerRows: EightKClassifierPerTickerRow[] = [];
  let inputsAvailablePerTicker = 0;
  for (const row of inputs.perTicker) {
    const deduped = dedupeEvents(row.events);

    const impairmentCount = countEventsForItem(deduped, '2.06', inputs.asOf);
    const restatementCount = countEventsForItem(deduped, '4.02', inputs.asOf);
    const auditorChangeCount = countEventsForItem(deduped, '4.01', inputs.asOf);
    const delistingCount = countEventsForItem(deduped, '3.01', inputs.asOf);
    const controlChangeCount = countEventsForItem(deduped, '5.01', inputs.asOf);
    const materialAgreementCount = countEventsForItem(deduped, '1.01', inputs.asOf);
    const acquisitionCount = countEventsForItem(deduped, '2.01', inputs.asOf);

    const recentEventCount90d = countDistinctAccessionsInHighSignalSet(deduped, inputs.asOf);
    const daysSinceLatestEvent = daysSinceLatestHighSignalEvent(deduped, inputs.asOf);

    const materialEventFlag = recentEventCount90d >= 1;

    if (row.sector != null && row.cik !== '') inputsAvailablePerTicker++;

    perTickerRows.push({
      ticker: row.ticker,
      cik: row.cik,
      sector: row.sector,
      recentEventCount90d,
      daysSinceLatestEvent,
      materialEventFlag,
      impairmentFlag: flagItem(impairmentCount),
      restatementFlag: flagItem(restatementCount),
      auditorChangeFlag: flagItem(auditorChangeCount),
      delistingFlag: flagItem(delistingCount),
      controlChangeFlag: flagItem(controlChangeCount),
      materialAgreementFlag: flagItem(materialAgreementCount),
      acquisitionFlag: flagItem(acquisitionCount),
    });
  }

  // Sector-aggregate layer
  const flaggedSectors: EightKClassifierFlaggedSector[] = [];
  const sectorZs: (number | null)[] = [];
  let inputsAvailableAggregate = 0;
  let maxAbsZ = -Infinity;
  let maxAggregateZ: number | null = null;
  let maxAggregateZSector: string | null = null;
  for (const s of inputs.sectors) {
    const rate = computeSectorEventRate(s.events, s.sectorSize, inputs.asOf);
    const { z, baselineSize } = computeZ(rate, s.baseline2y);
    sectorZs.push(z);
    if (s.sectorSize > 0) inputsAvailableAggregate++;
    if (z != null) {
      const absZ = Math.abs(z);
      // Tie-break: lexicographically earlier sector name wins. Order-independent
      // across permutations of inputs.sectors per SPEC §5.2 MAXZ-*-4.
      if (
        absZ > maxAbsZ ||
        (absZ === maxAbsZ && (maxAggregateZSector == null || s.sector < maxAggregateZSector))
      ) {
        maxAbsZ = absZ;
        maxAggregateZ = z;
        maxAggregateZSector = s.sector;
      }
    }
    if (z != null && Math.abs(z) > EIGHT_K_CLUSTER_Z_THRESHOLD && rate != null) {
      flaggedSectors.push({
        sector: s.sector,
        sectorSize: s.sectorSize,
        eventRateT: rate,
        z,
        baselineSize,
      });
    }
  }
  const eightKClusterFlag = flagEightKCluster(sectorZs);

  return {
    snapshotDate: inputs.asOf,
    lastEdgarQueryAt: inputs.lastEdgarQueryAt,
    bdSinceLastQuery: inputs.bdSinceLastQuery,

    flaggedSectors,
    eightKClusterFlag,
    maxAggregateZ,
    maxAggregateZSector,

    perTickerRows,

    inputsAvailableAggregate,
    inputsAvailablePerTicker,
    version: EIGHT_K_CLASSIFIER_COMPOSITE_VERSION,
  };
}

/**
 * What could break this:
 *   - Off-set item codes in the source: the composite defensively filters to
 *     HIGH_SIGNAL_ITEM_SET on every read path (sector aggregate + recent-
 *     accession count + days-since-latest), but per-item flag counts use
 *     `countEventsForItem` which matches by exact string equality. If a
 *     malformed source row carries an item like " 2.06" (leading space) or
 *     "2.06 " (trailing), the per-item flag silently does not fire. Ingest is
 *     responsible for normalizing — the composite trusts the source schema.
 *   - HIGH_SIGNAL_ITEM_CODES + ITEM_CODE_FLAG_NAMES drift: if a future v2 adds
 *     a new high-signal item (e.g. 8.01), both constants need to gain the new
 *     code AND the snapshot type needs a new flag field. The TypeScript
 *     `satisfies Record<HighSignalItemCode, string>` constraint on
 *     ITEM_CODE_FLAG_NAMES catches the keys side at compile-time; the snapshot
 *     type does NOT (no compile-time link to HIGH_SIGNAL_ITEM_CODES).
 *   - Distinct-on-(ticker, accession): aggregate dedupe uses `${ticker} ${accession}`
 *     as the key. If a ticker contains a literal space (shouldn't for real
 *     EDGAR data, but defensive), the key becomes ambiguous. Acceptable for
 *     v1; if a future universe expands to include space-containing tickers,
 *     switch to a tuple-keyed Map.
 *   - Cold-start cascade in aggregate: a single missing-baseline sector forces
 *     its z-score to null but the OR-flag still fires if any OTHER sector
 *     exceeds threshold. Matches gap #8 cold-start posture. Operator sees the
 *     cold-start via inputsAvailableAggregate < sector count in the snapshot.
 *   - `materialEventFlag` is derived from `recentEventCount90d >= 1`, NOT from
 *     the OR of per-item flags. This matters when an item NOT in the high-
 *     signal set somehow appears in the per-ticker counts (it can't if the
 *     ingest filter is honored, but defense-in-depth says compute the disjunct
 *     from the distinct-accession count which already filters to the set).
 *   - The recentEventCount90d uses pre-dedupe accessions — but `dedupeEvents`
 *     runs ahead of it for ALL per-ticker math. If a future caller invokes
 *     `countDistinctAccessionsInHighSignalSet` on raw events, the result is
 *     still correct (Set semantics absorb duplicates), but item-flag counts
 *     would double-count without explicit dedupe. The orchestrator dedupes
 *     once and reuses; direct callers must dedupe themselves.
 */
