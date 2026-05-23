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

export interface EtfFlowCrossValidationStateResponse {
  /** True iff both primary AND secondary panels have at least one
   *  intersecting (ticker, date) pair. When false, the UI renders an
   *  empty-state panel with operator instructions. */
  hasData: boolean;
  /** ISO date `YYYY-MM-DD` of the `asOf` cutoff used. Typically "today". */
  asOf: string;
  /** Lookback window in days requested by the client. */
  lookbackDays: number;
  /** Universe of ETFs compared (F-UNIVERSE v1, 21 tickers). */
  tickers: ReadonlyArray<string>;
  /** Cross-validation summary — populated when `hasData=true`. */
  summary: EtfFlowCrossValidationSummary | null;
  /** Counts surfaced even when `hasData=false` for operator triage:
   *  - primaryRows: rows in the v1 yfinance panel in the window.
   *  - secondaryRows: rows in the v3.1 issuer-CSV panel in the window.
   *  - secondaryTableExists: false if the operator hasn't applied the
   *    `migrate:create-etf-shares-outstanding-secondary` yet.  */
  counts: {
    primaryRows: number;
    secondaryRows: number;
    secondaryTableExists: boolean;
  };
}

/** Pure builder — wraps the existing pure cross-validation framework with
 *  the dashboard's response shape. Extracted so unit tests can exercise
 *  the route's `hasData=false` branches without a live CH. */
export function buildEtfFlowCrossValidationState(opts: {
  asOf: Date;
  lookbackDays: number;
  tickers: ReadonlyArray<string>;
  primary: ReadonlyArray<EtfFlowPrimaryPoint>;
  secondary: ReadonlyArray<EtfFlowSecondaryPoint>;
  secondaryTableExists: boolean;
  secondarySourceLabel?: string;
}): EtfFlowCrossValidationStateResponse {
  const asOfStr = isoDate(opts.asOf);
  const hasIntersection = opts.primary.length > 0 && opts.secondary.length > 0;
  if (!hasIntersection) {
    return {
      hasData: false,
      asOf: asOfStr,
      lookbackDays: opts.lookbackDays,
      tickers: opts.tickers,
      summary: null,
      counts: {
        primaryRows: opts.primary.length,
        secondaryRows: opts.secondary.length,
        secondaryTableExists: opts.secondaryTableExists,
      },
    };
  }
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
    hasData: totalCompared > 0,
    asOf: asOfStr,
    lookbackDays: opts.lookbackDays,
    tickers: opts.tickers,
    summary,
    counts: {
      primaryRows: opts.primary.length,
      secondaryRows: opts.secondary.length,
      secondaryTableExists: opts.secondaryTableExists,
    },
  };
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
  const repo = new EtfFlowRepository({ ch });
  const secondaryTableExists = await repo.secondaryTableExists();
  const [panelByTicker, secondaryPanel] = await Promise.all([
    repo.readSharesPanelForTickers(asOf, tickers, lookbackDays),
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
    secondaryTableExists,
  });
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
