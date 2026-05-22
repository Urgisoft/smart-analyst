/**
 * Schedule 13D / 13G activist-stake composite — Layer-0 informational input
 * (Phase A2). Third sibling under gap #7 v2, alongside `eight_k_classifier_v1`
 * (`eight_k_classifier.ts`) and `form_4_insider_v1` (`form_4_insider.ts`).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §§2.2, 5.1, 5.2, 5.3, 9.1.
 *
 * Purpose:
 *   Two scopes, both informational-only in v1 per gap #7 v2 SPEC §10 (log
 *   first, validate after Phase B independence test):
 *
 *   1. **Per-stock** (watch-universe filtered, e.g. equity-midcap): emit
 *      eight per-ticker fields capturing trailing-90d / trailing-30d
 *      activist-stake activity:
 *        - `new13DFilingFlag30d` / `new13GFilingFlag30d` — any qualifying
 *          filing in 30d window (INCLUDES amendments per XD-5).
 *        - `recent13DCount90d` / `recent13GCount90d` — count of filings
 *          (INCLUDES amendments per XD-5).
 *        - `new13DCount90d` — count of NEW 13D filings (EXCLUDES amendments,
 *          per XD-5 asymmetry).
 *        - `distinct13DFilers90d` — count of distinct `filerCik` across all
 *          {SC 13D, SC 13D/A} filings in 90d window.
 *        - `daysSinceLatest13D` / `daysSinceLatest13G` — integer-day
 *          truncated `(asOf - max(acceptedAt))` across the form-type's
 *          {base, /A} set in 90d window; null when window is empty.
 *
 *   2. **Aggregate** (SPY-500 PIT-as-of-D, sliced by GICS sector): emit
 *      `schedule13DClusterFlag` when ANY sector's NEW-13D event rate
 *      z-score against a 2y daily baseline exceeds |z| > 2.0 symmetrically.
 *
 *      **XD-5 asymmetric filter (load-bearing):** the aggregate counts ONLY
 *      `form_type = 'SC 13D' AND is_amendment = 0` (NEW 13D only). The
 *      per-stock metrics INCLUDE amendments. Brav-Jiang-Partnoy-Thomas
 *      2008 §2.2 documents the announcement effect is concentrated on the
 *      INITIAL SC 13D filing; per-stock forensic value is filing-volume-
 *      anchored which justifies including amendments.
 *
 * Canon:
 *   - Brav, Jiang, Partnoy & Thomas (2008) *J. Finance* 63(4):1729 §2.1-§2.2 —
 *     activist 13D return literature; SC 13D-as-activist proxy; announcement
 *     effect on initial filings.
 *   - Edmans, Fang & Zur (2013) *RFS* 26(6):1443 — 13D voice vs 13G exit;
 *     both generate value; 13G is NOT just passive noise (SPEC §11 watch-out
 *     #2).
 *   - Collin-Dufresne & Fos (2015) *J. Finance* 70(4):1555 — pre-filing
 *     informed-trading window is structurally unobtainable post-EDGAR
 *     acceptance (SPEC §11 watch-out #1).
 *   - 17 CFR 240.13d-101 vs 240.13d-102 — statutory backbone for the
 *     form-type partition (XD-1).
 *
 * Design choices (SPEC §2.2 / ADR-043 locks):
 *   - XD-1: activist-vs-passive proxy = SEC-encoded form-type (no NLP).
 *   - XD-3: v1 reads form-type + accession + CIKs + acceptedAt only.
 *   - XD-4: amendments treated additively (no supersession linking).
 *   - XD-5: aggregate uses NEW 13D only; per-stock includes amendments.
 *   - XD-6: 30d cluster trigger, 90d carrying window, 2y daily baseline
 *     (inherited from EDF-6; same as EK / F4).
 *   - XD-7: row dedupe key is `(issuerCik, accession)` — matches the
 *     ReplacingMergeTree ORDER BY at storage.
 *   - XD-8: version stamp `schedule_13d_g_v1`.
 *   - EDF-5: acceptedAt is the load-bearing anti-leak anchor. period_of_report
 *     is forensic only; using it for windowing injects look-ahead leakage per
 *     SPEC §11 watch-out #8 (SC 13G's `period_of_report` can predate
 *     acceptance by up to 45d).
 *   - EDF-7: MIN_Z_BASELINE = 30 (matches all eight prior Layer-0 composites).
 *
 * Pure-function layer:
 *   This module exposes only pure functions + type definitions. Z-score
 *   baselines are INPUTS (computed by the A4 repository from a 2y trailing
 *   panel), not computed inside this module. Same architectural separation
 *   as eight_k_classifier.ts and form_4_insider.ts.
 *
 * Field-name convention:
 *   Field names are camelCase (e.g. `new13DFilingFlag30d`) per the established
 *   Layer-0 sibling pattern (EK / F4 / executive_departure / etf_flow / etc.).
 *   The SPEC §5.3 typescript interface is illustrative; the code convention
 *   across all Layer-0 composites is camelCase.
 */

/** Composite version. Bump on form-type set change, window length, aggregate
 *  z-threshold, baseline floor, aggregate filter (NEW-13D vs ALL-13D vs blend),
 *  or universe change (XD-8). Stored alongside every snapshot for backtest
 *  reproducibility. */
export const SCHEDULE_13D_G_COMPOSITE_VERSION = 'schedule_13d_g_v1' as const;
export type Schedule13DGCompositeVersion = typeof SCHEDULE_13D_G_COMPOSITE_VERSION;

// ── SPEC-pinned thresholds (re-tuning bumps composite version) ──────────────

/** XD-6: 30d window for the per-stock `new13D/G_filing_flag_30d` triggers. */
export const CLUSTER_WINDOW_DAYS = 30;

/** XD-6: 90d carrying window for per-stock counts + days-since-latest +
 *  distinct-filers + aggregate sector NEW-13D rate. */
export const ROLLING_WINDOW_DAYS = 90;

/** XD-1 / inherited EDF-7: |z| > 2.0 symmetric for schedule_13d_cluster_flag. */
export const SCHEDULE_13D_CLUSTER_Z_THRESHOLD = 2.0;

/** EDF-7: minimum baseline prints for a valid z-score. Identical constant
 *  across all Layer-0 composites; do NOT re-tune for this composite (SPEC
 *  §11 watch-out #6). */
export const MIN_Z_BASELINE = 30;

/** Form-type tags. Pinned strings — EDGAR's full-text search emits exactly
 *  these (including the space + the '/A' suffix on amendments). */
export const FORM_TYPE_13D = 'SC 13D' as const;
export const FORM_TYPE_13D_A = 'SC 13D/A' as const;
export const FORM_TYPE_13G = 'SC 13G' as const;
export const FORM_TYPE_13G_A = 'SC 13G/A' as const;

/** The SPEC-pinned form-type set covered by this composite (XD-11). Any
 *  form type outside this set is silently filtered out at composite read
 *  (defense-in-depth alongside the ingest-side filter at
 *  `sec_edgar_13d_g_ingest.py` parse time). */
export const SCHEDULE_FORM_TYPES = [
  FORM_TYPE_13D,
  FORM_TYPE_13D_A,
  FORM_TYPE_13G,
  FORM_TYPE_13G_A,
] as const;
export type ScheduleFormType = (typeof SCHEDULE_FORM_TYPES)[number];

const SCHEDULE_FORM_TYPE_SET = new Set<string>(SCHEDULE_FORM_TYPES);
const FORM_TYPES_13D_ALL = new Set<string>([FORM_TYPE_13D, FORM_TYPE_13D_A]);
const FORM_TYPES_13G_ALL = new Set<string>([FORM_TYPE_13G, FORM_TYPE_13G_A]);

// ── Form-type predicates ────────────────────────────────────────────────────

/** True for {'SC 13D', 'SC 13D/A'}. Used by per-stock metrics which INCLUDE
 *  amendments per XD-5. */
export function is13DForm(formType: string): boolean {
  return FORM_TYPES_13D_ALL.has(formType);
}

/** True for {'SC 13G', 'SC 13G/A'}. Used by per-stock metrics. */
export function is13GForm(formType: string): boolean {
  return FORM_TYPES_13G_ALL.has(formType);
}

/** True only for 'SC 13D' (NOT 'SC 13D/A'). Used by the aggregate
 *  sector-rate computation per XD-5 — the announcement effect is
 *  concentrated on INITIAL filings, so amendments are excluded from
 *  the aggregate signal but retained at the per-stock layer. */
export function isNew13DForm(formType: string): boolean {
  return formType === FORM_TYPE_13D;
}

/** True for any form type ending '/A' (the amendment marker per
 *  17 CFR 240.13d-2). Derivation matches the ingest-side
 *  `is_amendment` column population — that column is also computed
 *  from the form-type suffix per SPEC §11 watch-out #5. */
export function isAmendmentForm(formType: string): boolean {
  return formType.endsWith('/A');
}

// ── Filing-level pure functions ─────────────────────────────────────────────

/** A single Schedule 13D / 13G filing row as consumed by the composite. The
 *  repository assembles these from `quantlab.schedule_13d_g_filings`; one row
 *  per `(issuerCik, accession)` tuple matching the ReplacingMergeTree ORDER
 *  BY (XD-7 / XD-14). */
export interface ScheduleFiling {
  /** EDGAR accession number, e.g. "0001234567-26-123456". Globally unique
   *  per filing (SEC's own guarantee); leads the dedupe key. */
  accession: string;
  /** Issuer (company being filed on) 10-digit zero-padded CIK. Resolved to
   *  ticker via `cik_ticker_map`. */
  issuerCik: string;
  /** Resolved issuer ticker (may be '' when the CIK→ticker map has no
   *  entry). */
  issuerTicker: string;
  /** Filer (beneficial owner) 10-digit zero-padded CIK. Distinct from
   *  `issuerCik` per SPEC §11 watch-out #4. Used for the
   *  `distinct13DFilers90d` per-stock metric; reserved for v2
   *  filer-reputation work (XD-2) at the snapshot layer. */
  filerCik: string;
  /** Filer entity name; optional v1 enrichment per XD-12. Default ''.
   *  Forensic only — not consumed by any v1 composite formula. */
  filerName: string;
  /** Form type — one of SCHEDULE_FORM_TYPES. Off-set form types are
   *  silently filtered at composite read (defense in depth alongside the
   *  ingest filter). */
  formType: string;
  /** Derived from `formType.endsWith('/A')` per SPEC §11 watch-out #5.
   *  Stored on the row for parity with the CH schema; the composite ALSO
   *  re-derives via `isAmendmentForm` for defense in depth. */
  isAmendment: boolean;
  /** EDGAR acceptance datetime — the load-bearing anti-leak anchor per
   *  EDF-5 / XD-7 / SPEC §11 watch-out #8. All rolling-window math uses
   *  this, NEVER period_of_report. */
  acceptedAt: Date;
  /** Period-of-report date. Forensic only; SC 13G can have a
   *  period_of_report up to 45d earlier than acceptedAt — using it for
   *  windowing injects look-ahead leakage. */
  periodOfReport: Date;
}

/** Deduplicate filings by `(issuerCik, accession)`. The ReplacingMergeTree
 *  ORDER BY at storage handles physical dedupe, but a re-ingest race or
 *  upstream replay can still emit duplicate logical rows to this pure
 *  function. Same defensive posture as `eight_k_classifier.dedupeEvents`
 *  + `form_4_insider.dedupeTrades`. */
export function dedupeFilings(
  filings: ReadonlyArray<ScheduleFiling>,
): ScheduleFiling[] {
  const seen = new Set<string>();
  const out: ScheduleFiling[] = [];
  for (const f of filings) {
    const key = `${f.issuerCik} ${f.accession}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Filter filings to the SPEC form-type set (defense in depth alongside the
 *  ingest-side filter at parse time per T-XD13I-12). Off-set form types
 *  silently dropped here. */
export function filterFilingsToScheduleForms(
  filings: ReadonlyArray<ScheduleFiling>,
): ScheduleFiling[] {
  return filings.filter((f) => SCHEDULE_FORM_TYPE_SET.has(f.formType));
}

/** Filter filings to a rolling window `[asOf - windowDays, asOf]` (inclusive
 *  on both boundaries per SPEC §9.1 T-XD13-16/17).
 *  - A filing at `acceptedAt = asOf - windowDays 00:00:00` IS in window.
 *  - A filing at `acceptedAt = asOf - windowDays - 1ms` is NOT in window.
 *  - A filing at `acceptedAt > asOf` is NOT in window — the composite-layer
 *    half of the EDF-5 / XD-7 anti-leak gate (T-XD13-18); the ingest layer
 *    enforces the same condition at parse time. Defense in depth. */
export function filterFilingsInWindow(
  filings: ReadonlyArray<ScheduleFiling>,
  asOf: Date,
  windowDays: number,
): ScheduleFiling[] {
  const asOfMs = asOf.getTime();
  const windowStartMs = asOfMs - windowDays * 24 * 60 * 60 * 1000;
  return filings.filter((f) => {
    const t = f.acceptedAt.getTime();
    return t >= windowStartMs && t <= asOfMs;
  });
}

/** Count filings whose form type passes `predicate` within the window. */
export function countFilingsBy(
  filings: ReadonlyArray<ScheduleFiling>,
  predicate: (formType: string) => boolean,
  asOf: Date,
  windowDays: number,
): number {
  return filterFilingsInWindow(filings, asOf, windowDays).filter(
    (f) => predicate(f.formType),
  ).length;
}

/** Count distinct `filerCik` values across filings whose form type passes
 *  `predicate` within the window. Per SPEC §5.1 `distinct_13d_filers_90d`:
 *  same filer with two 13D filings counts as 1.
 *
 *  Empty-string filerCik is treated as a distinct identity (rare-case
 *  fallback per the ingest's degenerate-CIK-collapse path; preserves
 *  forensic access without silently merging rows). */
export function countDistinctFilersBy(
  filings: ReadonlyArray<ScheduleFiling>,
  predicate: (formType: string) => boolean,
  asOf: Date,
  windowDays: number,
): number {
  const distinct = new Set<string>();
  for (const f of filterFilingsInWindow(filings, asOf, windowDays)) {
    if (predicate(f.formType)) distinct.add(f.filerCik);
  }
  return distinct.size;
}

/** Days since the most-recent filing matching `predicate` within the
 *  window. Returns null when the window contains zero qualifying filings
 *  (the "no signal" branch — distinct from "0 days" which means a filing
 *  happened today).
 *
 *  Used to populate `daysSinceLatest13D` / `daysSinceLatest13G` for the
 *  per-ticker row payload. Floor (not round / ceil) so the integer count
 *  matches the SPEC's "Xd ago" semantic — a filing 23h59m ago is "0d"
 *  (today), a filing 24h00m + 1ms ago is "1d". Mirrors
 *  `eight_k_classifier.daysSinceLatestHighSignalEvent` +
 *  `form_4_insider.daysSinceLatestTradeByCode`. */
export function daysSinceLatestFilingBy(
  filings: ReadonlyArray<ScheduleFiling>,
  predicate: (formType: string) => boolean,
  asOf: Date,
  windowDays: number,
): number | null {
  let latestMs = -Infinity;
  for (const f of filterFilingsInWindow(filings, asOf, windowDays)) {
    if (!predicate(f.formType)) continue;
    const t = f.acceptedAt.getTime();
    if (t > latestMs) latestMs = t;
  }
  if (latestMs === -Infinity) return null;
  const MS_PER_DAY = 86_400_000;
  return Math.floor((asOf.getTime() - latestMs) / MS_PER_DAY);
}

// ── Sector-aggregate pure functions ─────────────────────────────────────────

/** Sector NEW-13D event rate per XD-5: `count(distinct (issuerTicker,
 *  accession) where form_type = 'SC 13D' AND is_amendment = 0 ∧
 *  acceptedAt ∈ window) / sectorSize`.
 *
 *  Distinct on `(issuerTicker, accession)` — a single SC 13D with a
 *  duplicate-ingest row contributes 1, not N. Returns null when
 *  `sectorSize <= 0` (degenerate sector).
 *
 *  Off-set form types AND amendments are filtered out here — this is the
 *  load-bearing XD-5 asymmetric-filter implementation. Per-stock callers
 *  that want the SC 13D + SC 13D/A union should use `countFilingsBy(...,
 *  is13DForm, ...)` instead. */
export function computeSectorNew13DRate(
  sectorFilings: ReadonlyArray<ScheduleFiling>,
  sectorSize: number,
  asOf: Date,
  windowDays: number = ROLLING_WINDOW_DAYS,
): number | null {
  if (sectorSize <= 0) return null;
  const inWindow = filterFilingsInWindow(sectorFilings, asOf, windowDays);
  const distinctPairs = new Set<string>();
  for (const f of inWindow) {
    if (!isNew13DForm(f.formType)) continue;
    distinctPairs.add(`${f.issuerTicker} ${f.accession}`);
  }
  return distinctPairs.size / sectorSize;
}

/** Z-score = (value - mean(baseline)) / stddev(baseline).
 *  Returns null + baselineSize when baseline has fewer than MIN_Z_BASELINE
 *  prints OR stddev is degenerate (≤ 1e-12).
 *
 *  Byte-identical shape to `eight_k_classifier.computeZ` +
 *  `form_4_insider.computeZ` + `executive_departure.computeZ` +
 *  `etf_flow.computeZ`. Sample stddev (n-1) per López de Prado AFML §1.3. */
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

/** `schedule13DClusterFlag`: ANY sector with |z| > 2.0. Returns false when
 *  all sector z-scores are null (cold-start; SPEC §11 watch-out #7). */
export function flagSchedule13DCluster(
  sectorZs: ReadonlyArray<number | null>,
): boolean {
  for (const z of sectorZs) {
    if (z != null && Math.abs(z) > SCHEDULE_13D_CLUSTER_Z_THRESHOLD) return true;
  }
  return false;
}

// ── Snapshot types ──────────────────────────────────────────────────────────

/** A single ticker's row in the snapshot's per_ticker payload.
 *  Mirrors SPEC §5.3 Schedule13DGSnapshot.per_ticker_rows[i]. */
export interface Schedule13DGPerTickerRow {
  ticker: string;
  cik: string;
  sector: string | null;

  /** `count(filings_13d_30d) >= 1`, INCLUDES amendments (SPEC §5.1). */
  new13DFilingFlag30d: boolean;
  /** `count(filings_13g_30d) >= 1`, INCLUDES amendments (SPEC §5.1). */
  new13GFilingFlag30d: boolean;

  /** `count(filings_13d_90d)`, INCLUDES amendments (XD-5 per-stock side). */
  recent13DCount90d: number;
  /** `count(filings_13g_90d)`, INCLUDES amendments. */
  recent13GCount90d: number;
  /** `count(filings_new_13d_90d)`, EXCLUDES amendments (XD-5 asymmetry). */
  new13DCount90d: number;
  /** `count(distinct filerCik in filings_13d_90d)`, includes amendments. */
  distinct13DFilers90d: number;

  /** Integer-day truncated `(asOf - max(acceptedAt of 13D-family in 90d
   *  window))`. Null when window contains no qualifying 13D filings. */
  daysSinceLatest13D: number | null;
  /** Integer-day truncated `(asOf - max(acceptedAt of 13G-family in 90d
   *  window))`. Null when window contains no qualifying 13G filings. */
  daysSinceLatest13G: number | null;
}

/** A flagged sector row — only emitted for sectors with |z| > 2.0. */
export interface Schedule13DGFlaggedSector {
  sector: string;
  sectorSize: number;
  /** NEW-13D event rate at this snapshot (per XD-5 aggregate filter). */
  new13DRateT: number;
  z: number;
  baselineSize: number;
}

/** Inputs to the composite evaluator. The repository (A4) assembles these
 *  from CH reads of `schedule_13d_g_filings` + `cik_ticker_map` +
 *  `sp500_constituents` PIT + the GICS-sector mapping + per-sector
 *  trailing-2y daily NEW-13D-rate panels. */
export interface Schedule13DGInputs {
  asOf: Date;

  /** Wall-clock UTC of the most-recent EDGAR poll. Null when ingest has
   *  never run. */
  lastEdgarQueryAt: Date | null;

  /** Business days between lastEdgarQueryAt and asOf. Used as a staleness
   *  indicator in the brief (healthy = 0-3; 4+ means ingest is stale). */
  bdSinceLastQuery: number | null;

  /** Per-ticker inputs for the watch universe (e.g. equity_midcap).
   *  `filings` is the FULL trailing-90d filing panel for the ticker (any
   *  form type allowed; the composite filters internally per XD-1
   *  defensive read). */
  perTicker: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    filings: ReadonlyArray<ScheduleFiling>;
  }>;

  /** Sector-aggregate inputs. One entry per GICS sector represented in the
   *  SPY-500 constituent panel as-of asOf. */
  sectors: ReadonlyArray<{
    sector: string;
    /** Number of SPY-500 constituents in this sector at asOf. */
    sectorSize: number;
    /** All trailing-90d filings for tickers in this sector. Any form type
     *  allowed; the composite filters internally. */
    filings: ReadonlyArray<ScheduleFiling>;
    /** Trailing 2y daily panel of per-day NEW-13D-rate (one value per
     *  business day in the trailing 2y window). Used for the z-score
     *  baseline per XD-5 / XD-6. */
    baseline2y: ReadonlyArray<number>;
  }>;
}

/** Output snapshot — mirrors SPEC §5.3 + CH column shape (see A3 migration). */
export interface Schedule13DGSnapshot {
  snapshotDate: Date;
  lastEdgarQueryAt: Date | null;
  bdSinceLastQuery: number | null;

  flaggedSectors: ReadonlyArray<Schedule13DGFlaggedSector>;
  schedule13DClusterFlag: boolean;

  /** Signed z of the sector with max |z| across all sectors with non-null
   *  z. Null when all sector z's are null (cold-start). Same posture as
   *  EK / F4 — consumed by the brief renderer's "No sectors flagged
   *  today" branch. Ties broken lexicographically (earlier sector name
   *  wins; deterministic across runs). */
  maxAggregateZ: number | null;
  maxAggregateZSector: string | null;

  perTickerRows: ReadonlyArray<Schedule13DGPerTickerRow>;

  /** Count of `(sector, day)` tuples with non-null new13DRate across the 2y
   *  daily baseline panel used at this snapshot, summed across sectors per
   *  SPEC §5.3. Equivalent to `Σ_sectors |finite(baseline2y_s)|`. The brief
   *  uses `inputsAvailableAggregate < MIN_Z_BASELINE × sectorCount` as the
   *  cold-start guard (sectorCount = 11 GICS sectors → threshold 330). */
  inputsAvailableAggregate: number;
  /** Count of per-ticker rows with at least one filing in the 90d window
   *  (across any form type). Informational — NOT a gate. */
  inputsAvailablePerTicker: number;
  version: Schedule13DGCompositeVersion;
}

// ── Composite orchestrator ──────────────────────────────────────────────────

/** Evaluate the Schedule 13D / 13G composite end-to-end.
 *
 *  Steps:
 *    1. Per-ticker: dedupe + form-type-filter filings; derive the eight
 *       per-ticker fields per SPEC §5.1 — two 30d flags, three 90d counts
 *       (13D / 13G / NEW-13D), one 90d filer-dedup count, two
 *       days-since-latest values.
 *    2. Sector-aggregate: per sector, compute new13DRate (NEW-13D only per
 *       XD-5) and z-score against the trailing 2y baseline; emit a
 *       flaggedSectors row when |z| > 2.0.
 *    3. Compose into the snapshot shape.
 *
 *  No I/O. No side effects. Re-runnable with identical inputs.
 */
export function evaluateSchedule13DGComposite(
  inputs: Schedule13DGInputs,
): Schedule13DGSnapshot {
  // Per-ticker layer
  const perTickerRows: Schedule13DGPerTickerRow[] = [];
  let inputsAvailablePerTicker = 0;
  for (const row of inputs.perTicker) {
    const deduped = dedupeFilings(row.filings);
    const scoped = filterFilingsToScheduleForms(deduped);

    const new13DFilingFlag30d = countFilingsBy(
      scoped, is13DForm, inputs.asOf, CLUSTER_WINDOW_DAYS,
    ) >= 1;
    const new13GFilingFlag30d = countFilingsBy(
      scoped, is13GForm, inputs.asOf, CLUSTER_WINDOW_DAYS,
    ) >= 1;

    const recent13DCount90d = countFilingsBy(
      scoped, is13DForm, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const recent13GCount90d = countFilingsBy(
      scoped, is13GForm, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const new13DCount90d = countFilingsBy(
      scoped, isNew13DForm, inputs.asOf, ROLLING_WINDOW_DAYS,
    );

    const distinct13DFilers90d = countDistinctFilersBy(
      scoped, is13DForm, inputs.asOf, ROLLING_WINDOW_DAYS,
    );

    const daysSinceLatest13D = daysSinceLatestFilingBy(
      scoped, is13DForm, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const daysSinceLatest13G = daysSinceLatestFilingBy(
      scoped, is13GForm, inputs.asOf, ROLLING_WINDOW_DAYS,
    );

    // inputsAvailablePerTicker counts rows with ≥ 1 in-window filing across
    // any form type — informational coverage of the per-stock signal.
    if (recent13DCount90d + recent13GCount90d > 0) inputsAvailablePerTicker++;

    perTickerRows.push({
      ticker: row.ticker,
      cik: row.cik,
      sector: row.sector,
      new13DFilingFlag30d,
      new13GFilingFlag30d,
      recent13DCount90d,
      recent13GCount90d,
      new13DCount90d,
      distinct13DFilers90d,
      daysSinceLatest13D,
      daysSinceLatest13G,
    });
  }

  // Sector-aggregate layer (XD-5 NEW-13D-only filter)
  const flaggedSectors: Schedule13DGFlaggedSector[] = [];
  const sectorZs: (number | null)[] = [];
  let inputsAvailableAggregate = 0;
  let maxAbsZ = -Infinity;
  let maxAggregateZ: number | null = null;
  let maxAggregateZSector: string | null = null;
  for (const s of inputs.sectors) {
    const dedupedSectorFilings = dedupeFilings(s.filings);
    const scopedSectorFilings = filterFilingsToScheduleForms(dedupedSectorFilings);

    const rate = computeSectorNew13DRate(
      scopedSectorFilings, s.sectorSize, inputs.asOf, ROLLING_WINDOW_DAYS,
    );
    const { z, baselineSize } = computeZ(rate, s.baseline2y);
    sectorZs.push(z);
    // SPEC §5.3: inputsAvailableAggregate = Σ_sectors |finite(baseline2y_s)|.
    // baselineSize is `computeZ`'s validBaseline.length — non-NaN entries.
    inputsAvailableAggregate += baselineSize;
    if (z != null) {
      const absZ = Math.abs(z);
      // Tie-break: lexicographically earlier sector name wins. Order-independent
      // across permutations of inputs.sectors per the EK / F4 convention.
      if (
        absZ > maxAbsZ ||
        (absZ === maxAbsZ && (maxAggregateZSector == null || s.sector < maxAggregateZSector))
      ) {
        maxAbsZ = absZ;
        maxAggregateZ = z;
        maxAggregateZSector = s.sector;
      }
    }
    if (z != null && Math.abs(z) > SCHEDULE_13D_CLUSTER_Z_THRESHOLD && rate != null) {
      flaggedSectors.push({
        sector: s.sector,
        sectorSize: s.sectorSize,
        new13DRateT: rate,
        z,
        baselineSize,
      });
    }
  }
  const schedule13DClusterFlag = flagSchedule13DCluster(sectorZs);

  return {
    snapshotDate: inputs.asOf,
    lastEdgarQueryAt: inputs.lastEdgarQueryAt,
    bdSinceLastQuery: inputs.bdSinceLastQuery,

    flaggedSectors,
    schedule13DClusterFlag,
    maxAggregateZ,
    maxAggregateZSector,

    perTickerRows,

    inputsAvailableAggregate,
    inputsAvailablePerTicker,
    version: SCHEDULE_13D_G_COMPOSITE_VERSION,
  };
}

/**
 * What could break this:
 *   - **XD-5 asymmetric filter (load-bearing).** Aggregate uses NEW-13D only;
 *     per-stock includes amendments. Inverting either path silently corrupts
 *     the announcement-effect signal: the announcement effect literature
 *     (Brav-Jiang-Partnoy-Thomas 2008 §2.2) is concentrated on INITIAL
 *     filings, but per-stock forensic value tracks filing volume. Any
 *     refactor that consolidates the two helpers into a single "use this
 *     filter everywhere" path will silently break one side.
 *   - **Filer CIK ≠ issuer CIK (SPEC §11 watch-out #4).** The composite
 *     reads `filerCik` only for the `distinct13DFilers90d` metric and
 *     trusts the ingest's `extract_issuer_and_filer_ciks` helper to have
 *     populated the two distinct columns correctly. A regression at the
 *     ingest layer that confuses the two would make `distinct13DFilers90d`
 *     meaningless without throwing.
 *   - **Form-type string drift.** EDGAR's full-text search emits exactly
 *     'SC 13D' / 'SC 13D/A' / 'SC 13G' / 'SC 13G/A'. Any case-folding,
 *     whitespace-trim, or punctuation variation at the ingest layer
 *     (e.g. 'SC13D' no-space) silently filters out at composite read via
 *     `filterFilingsToScheduleForms`. The ingest is responsible for
 *     emitting the pinned strings; T-XD13I-12 + the SPEC §11 watch-out #5
 *     pin this on the ingest side.
 *   - **`isAmendment` derivation MUST be from form-type suffix (SPEC §11
 *     watch-out #5).** The composite trusts `formType.endsWith('/A')` and
 *     never reads the row's stored `isAmendment` column. Some EDGAR JSON
 *     responses have an `is_amendment` field but it is NOT universally
 *     populated — relying on it would silently drop /A filings out of
 *     amendment-aware paths.
 *   - **Acceptance-date is the only windowing anchor (SPEC §11 watch-out
 *     #8).** SC 13G's `period_of_report` can predate `acceptedAt` by up
 *     to 45d (Rule 13d-1(b) — institutions file 45d after year-end).
 *     Using `period_of_report` for window membership injects look-ahead
 *     leakage into Phase B backtests. The composite uses `acceptedAt`
 *     end-to-end; `periodOfReport` is on the row for forensic completeness
 *     only.
 *   - **30d / 90d boundary inclusivity (T-XD13-16/17).** A filing at
 *     `acceptedAt = asOf - 30d 00:00:00.000Z` IS in the 30d window; at
 *     `asOf - 30d - 1ms` is NOT. Same convention as EK / F4.
 *   - **Cold-start cascade in aggregate.** A single missing-baseline
 *     sector forces its z to null but `schedule13DClusterFlag` still
 *     fires if any OTHER sector exceeds threshold. Mirrors EK + F4 +
 *     gap #8 + gap #9 posture. Operator sees the cold-start via
 *     `inputsAvailableAggregate < sectorCount` in the snapshot.
 *   - **Distinct-on-(issuerTicker, accession) in aggregate.** Dedupe key
 *     uses `${ticker} ${accession}`. A ticker containing a literal space
 *     (shouldn't for real EDGAR data, but defensive) would make the key
 *     ambiguous. Acceptable for v1; if a future universe expands to
 *     include space-containing tickers, switch to a tuple-keyed Map.
 *   - **No 13G in the aggregate.** XD-5 deliberately excludes 13G from
 *     the aggregate signal. A reader expecting "any activist-stake
 *     clustering, including passive" should NOT use
 *     `schedule13DClusterFlag` — that's an active-intent signal.
 *     Per-stock metrics cover 13G separately via `recent13GCount90d` /
 *     `new13GFilingFlag30d` / `daysSinceLatest13G`.
 *   - **`distinct13DFilers90d` treats empty-string filerCik as distinct.**
 *     The ingest's degenerate-CIK-collapse path sets `filerCik =
 *     issuerCik` when the EDGAR `ciks` array is degenerate (rare); the
 *     resulting empty-or-collapsed value is treated as a distinct filer
 *     identity here. Preserves forensic access without silently merging
 *     rows; the alternative — dropping these — would under-count the
 *     metric at the same rate as the rare-case incidence.
 */
