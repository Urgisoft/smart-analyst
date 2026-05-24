/**
 * ETF-flow dashboard orchestrator — Gap #9 v3.1 UI surface (s96 #11).
 *
 * Powers `GET /api/etf-flow/cross-validation` for the `/#/etf-flow` route.
 * Read-only view of the cross-validation comparator's output: per-ticker
 * shares-outstanding divergence between the v1 yfinance primary panel
 * (`quantlab.etf_shares_outstanding`) and the v3.1 issuer-CSV secondary
 * panel (`quantlab.etf_shares_outstanding_secondary`).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §11 OQ3 (yfinance accuracy
 *       cross-validation) + §13 brief panel — this route surfaces the
 *       same divergence data in browser form so the operator can
 *       validate s96 #7-#9 v3.1 work without tailing CLI brief output.
 *
 * Closes the methodology gap surfaced in s96 #11 — the s96 #7-#9 v3.1
 * arc shipped four consecutive backend-only slices without an operator-
 * visible validation surface (memory: feedback-ui-validation-each-slice).
 *
 * Design split (mirrors cycle_position_dashboard.ts):
 *   - Pure helpers (`buildEtfFlowCrossValidationState`) — testable
 *     without ClickHouse. Takes already-fetched primary + secondary
 *     panels + asOf and runs the existing pure cross-validation
 *     framework.
 *   - One impure entry point (`fetchEtfFlowCrossValidationState`) —
 *     wires the repository's I/O to the pure builder. Falls through to
 *     `hasData: false` on empty secondary panel (the v3.1 ingest has
 *     never run yet) — the route does NOT 500; the panel renders an
 *     "awaiting first SSGA refresh" state.
 *
 * No CH writes. No mutation of any existing state. Read-only by design.
 */
import {
  EtfFlowRepository,
  etfSharesOutstandingTableExists,
} from './etf_flow_repository.js';
import { ETF_UNIVERSE } from './etf_flow.js';
import {
  compareEtfFlowPanels,
  summarizeDivergences,
  type EtfFlowPrimaryPoint,
  type EtfFlowSecondaryPoint,
  type EtfFlowCrossValidationSummary,
} from './etf_flow_cross_validation.js';
import { getClickHouse } from './clickhouse.js';

// ── Public types ────────────────────────────────────────────────────────────

/** Cycle 20 (s96 #19): the panel renders in one of three modes.
 *  - `cross-validation`: both primary AND secondary panels have data; the
 *    UI renders the divergence summary + per-ticker comparison.
 *  - `secondary-only`: secondary panel has data but primary is dark (v1
 *    yfinance ETF SHO regression — S96-89 / Q-6 / ADR-049). The UI
 *    renders the secondary panel as the source-of-truth with an honest
 *    "primary dark" banner; the cross-validation sub-panels are hidden
 *    because the comparison is meaningless with one side empty.
 *  - `empty`: BOTH panels empty (or one of the tables doesn't exist yet);
 *    the UI renders the existing empty-state with operator instructions. */
export type EtfFlowPanelMode = 'cross-validation' | 'secondary-only' | 'empty';

/** One row in the secondary-only panel: per-ticker latest snapshot from
 *  the v3.1 secondary panel. AUM = shares × close. `previousShares` /
 *  `previousDate` enable a day-over-day delta column without the UI
 *  having to re-fetch the full series. */
export interface EtfFlowSecondaryLatestRow {
  ticker: string;
  /** ISO date `YYYY-MM-DD` of the latest secondary row for this ticker. */
  date: string;
  shares: number;
  close: number;
  /** Derived: shares × close. */
  aum: number;
  /** ISO date of the immediately-prior row (within the lookback window),
   *  or null if this is the only row. */
  previousDate: string | null;
  /** Shares from the previous row, or null. */
  previousShares: number | null;
  /** (current - previous) / previous; null when no previous row. */
  sharesPctDelta: number | null;
  /** Number of rows for this ticker in the lookback window. */
  rowCount: number;
}

export interface EtfFlowCrossValidationStateResponse {
  /** True iff there is at least one panel to render (either
   *  cross-validation OR secondary-only). False only when both panels
   *  are empty / missing; UI then renders the empty-state.  */
  hasData: boolean;
  /** Cycle 20: which rendering mode the UI should use. See `EtfFlowPanelMode`. */
  mode: EtfFlowPanelMode;
  /** ISO date `YYYY-MM-DD` of the `asOf` cutoff used. Typically "today". */
  asOf: string;
  /** Lookback window in days requested by the client. */
  lookbackDays: number;
  /** Universe of ETFs compared (F-UNIVERSE v1, 21 tickers). */
  tickers: ReadonlyArray<string>;
  /** Cross-validation summary — populated only when `mode === 'cross-validation'`. */
  summary: EtfFlowCrossValidationSummary | null;
  /** Cycle 20: per-ticker latest snapshot from the secondary panel.
   *  Populated when `mode === 'secondary-only'`; null otherwise. Sorted
   *  by ticker ASC for deterministic rendering. */
  secondaryLatest: ReadonlyArray<EtfFlowSecondaryLatestRow> | null;
  /** Counts surfaced even when `hasData=false` for operator triage:
   *  - primaryRows: rows in the v1 yfinance panel in the window.
   *  - secondaryRows: rows in the v3.1 issuer-CSV panel in the window.
   *  - primaryTableExists: false if `migrate:create-etf-flow-snapshots`
   *    has never been applied OR `npm run etf:flow:ingest` has never run
   *    (the v1 primary table is created by either path — s92 design).
   *  - secondaryTableExists: false if the operator hasn't applied the
   *    `migrate:create-etf-shares-outstanding-secondary` yet.  */
  counts: {
    primaryRows: number;
    secondaryRows: number;
    primaryTableExists: boolean;
    secondaryTableExists: boolean;
  };
}

/** Pure builder — wraps the existing pure cross-validation framework with
 *  the dashboard's response shape. Extracted so unit tests can exercise
 *  the route's `hasData=false` branches without a live CH.
 *
 *  Cycle 20 (s96 #19): three-mode dispatch. Previously the builder used
 *  AND-logic on primary+secondary intersection and returned
 *  `hasData:false` whenever EITHER side was empty. With v1 yfinance dead
 *  since 2026-05-19 (S96-89) the primary is structurally empty and the
 *  panel was always empty-state in production. The new logic:
 *    - secondary empty AND primary empty (or tables absent) → `empty`
 *      mode (existing empty-state path).
 *    - secondary non-empty AND primary empty → `secondary-only` mode
 *      (ADR-049 fallback): render the secondary panel as source-of-truth
 *      with a "primary dark" banner; hide the cross-validation
 *      sub-panels because the comparison is meaningless.
 *    - both non-empty → `cross-validation` mode (the original path). */
export function buildEtfFlowCrossValidationState(opts: {
  asOf: Date;
  lookbackDays: number;
  tickers: ReadonlyArray<string>;
  primary: ReadonlyArray<EtfFlowPrimaryPoint>;
  secondary: ReadonlyArray<EtfFlowSecondaryPoint>;
  primaryTableExists: boolean;
  secondaryTableExists: boolean;
  secondarySourceLabel?: string;
}): EtfFlowCrossValidationStateResponse {
  const asOfStr = isoDate(opts.asOf);
  const counts = {
    primaryRows: opts.primary.length,
    secondaryRows: opts.secondary.length,
    primaryTableExists: opts.primaryTableExists,
    secondaryTableExists: opts.secondaryTableExists,
  };
  const primaryHasData = opts.primary.length > 0;
  const secondaryHasData = opts.secondary.length > 0;

  // Mode 3 — empty. Both panels empty (or one of the tables missing). UI
  // renders the existing empty-state with operator instructions.
  if (!primaryHasData && !secondaryHasData) {
    return {
      hasData: false,
      mode: 'empty',
      asOf: asOfStr,
      lookbackDays: opts.lookbackDays,
      tickers: opts.tickers,
      summary: null,
      secondaryLatest: null,
      counts,
    };
  }

  // Mode 2 — secondary-only fallback (Q-6 / ADR-049 / S96-89). Primary
  // is dark; render secondary as source-of-truth. Hide cross-validation
  // sub-panels (the comparison is meaningless with one side empty).
  if (!primaryHasData && secondaryHasData) {
    return {
      hasData: true,
      mode: 'secondary-only',
      asOf: asOfStr,
      lookbackDays: opts.lookbackDays,
      tickers: opts.tickers,
      summary: null,
      secondaryLatest: buildSecondaryLatest(opts.secondary),
      counts,
    };
  }

  // Mode 1 — cross-validation. Both panels have data. If the intersection
  // happens to be empty (asymmetric coverage), totalCompared will be 0
  // and the summary still renders (UI shows "0 pairs compared"); we keep
  // `hasData:true` because there IS data to show — the operator just
  // sees that no comparison was possible.
  const { divergences, totalCompared } = compareEtfFlowPanels(
    opts.primary,
    opts.secondary,
  );
  const summary = summarizeDivergences(
    divergences,
    totalCompared,
    opts.secondarySourceLabel ?? 'issuer-csv',
  );
  return {
    hasData: true,
    mode: 'cross-validation',
    asOf: asOfStr,
    lookbackDays: opts.lookbackDays,
    tickers: opts.tickers,
    summary,
    secondaryLatest: null,
    counts,
  };
}

/** Cycle 20 (s96 #19): collapse a full secondary panel into per-ticker
 *  latest-row rows for the secondary-only display mode. Sorted by ticker
 *  ASC for deterministic rendering. Each row carries the latest (date,
 *  shares, close, aum) PLUS the immediately-prior (date, shares) within
 *  the window so the UI can render a day-over-day shares delta column
 *  without re-fetching. */
export function buildSecondaryLatest(
  secondary: ReadonlyArray<EtfFlowSecondaryPoint>,
): EtfFlowSecondaryLatestRow[] {
  // Group by ticker; within each group, sort dates ASC (the repository
  // already returns ticker-then-date ASC, but we don't rely on it here so
  // the helper is robust to caller ordering).
  const byTicker = new Map<string, EtfFlowSecondaryPoint[]>();
  for (const p of secondary) {
    const arr = byTicker.get(p.ticker) ?? [];
    arr.push(p);
    byTicker.set(p.ticker, arr);
  }
  const out: EtfFlowSecondaryLatestRow[] = [];
  for (const ticker of [...byTicker.keys()].sort()) {
    const rows = byTicker.get(ticker)!;
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const latest = rows[rows.length - 1];
    const prior = rows.length >= 2 ? rows[rows.length - 2] : null;
    const aum = Number.isFinite(latest.shares) && Number.isFinite(latest.close)
      ? latest.shares * latest.close
      : Number.NaN;
    let sharesPctDelta: number | null = null;
    if (prior != null && prior.shares !== 0 && Number.isFinite(prior.shares) && Number.isFinite(latest.shares)) {
      sharesPctDelta = (latest.shares - prior.shares) / prior.shares;
    }
    out.push({
      ticker,
      date: latest.date,
      shares: latest.shares,
      close: latest.close,
      aum,
      previousDate: prior?.date ?? null,
      previousShares: prior?.shares ?? null,
      sharesPctDelta,
      rowCount: rows.length,
    });
  }
  return out;
}

/** Impure entry point — fetch both panels from CH and build the response.
 *  Default asOf = now (UTC). Default lookback = 90 days. */
export async function fetchEtfFlowCrossValidationState(opts: {
  asOf?: Date;
  lookbackDays?: number;
} = {}): Promise<EtfFlowCrossValidationStateResponse> {
  const asOf = opts.asOf ?? new Date();
  const lookbackDays = opts.lookbackDays ?? 90;
  const tickers = ETF_UNIVERSE;
  const ch = getClickHouse();
  // GAP-11 (s96 #12): probe BOTH tables before reading. Without the primary
  // guard, a fresh clone that never ran the v1 migration crashes the route
  // with an unguarded CH error (the s96 #11 screenshot bug). Mirrors the
  // secondary guard pattern already in place. Both probes run in parallel.
  const [primaryTableExists, secondaryTableExists] = await Promise.all([
    etfSharesOutstandingTableExists(ch),
    new EtfFlowRepository({ ch }).secondaryTableExists(),
  ]);
  const repo = new EtfFlowRepository({ ch });
  const [panelByTicker, secondaryPanel] = await Promise.all([
    primaryTableExists
      ? repo.readSharesPanelForTickers(asOf, tickers, lookbackDays)
      : Promise.resolve(new Map() as Map<string, Array<{ date: string; shares: number; close: number }>>),
    secondaryTableExists
      ? repo.readSecondaryPanelForTickers(asOf, tickers, lookbackDays)
      : Promise.resolve([] as EtfFlowSecondaryPoint[]),
  ]);
  const primary: EtfFlowPrimaryPoint[] = [];
  for (const [ticker, rows] of panelByTicker) {
    for (const r of rows) {
      const shares = typeof r.shares === 'number' ? r.shares : Number(r.shares);
      const close = typeof r.close === 'number' ? r.close : Number(r.close);
      if (!Number.isFinite(shares) || !Number.isFinite(close)) continue;
      primary.push({ ticker, date: r.date, shares, close });
    }
  }
  return buildEtfFlowCrossValidationState({
    asOf,
    lookbackDays,
    tickers,
    primary,
    secondary: secondaryPanel,
    primaryTableExists,
    secondaryTableExists,
  });
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
