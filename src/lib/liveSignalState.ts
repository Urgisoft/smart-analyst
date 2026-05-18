/**
 * Live signal-state evaluation + day-over-day diff for the paper-trading
 * daemon. Pure functions — no I/O — so the daemon's hot logic stays
 * unit-testable without ClickHouse, yfinance, or Telegram.
 *
 * Contract: takes the output of `runStrategy()` (a Trade[] with `reason`
 * tags on each sell) and returns the strategy's *current* position state
 * as of the final candle. The trick is detecting force-closes — the
 * backtest engine force-closes any open position on the last bar with
 * `reason: 'final'`. That force-close is a backtest convenience; for live
 * deployment the position is genuinely still open. We therefore treat a
 * trailing `reason='final'` sell as evidence of an open position, and
 * report the matching buy's price + time as the live entry.
 */
import type { Candle, Trade } from './indicators.js';

export type LiveState = 'flat' | 'long';

export interface LiveSignalState {
  /** 'long' iff the strategy holds a position as of the last evaluated bar. */
  state: LiveState;
  /**
   * Bar timestamp of the open position's entry. Defined only when state='long'.
   * Use to compute holding period at report time.
   */
  positionEntryTs?: number;
  /** Entry close price. Defined only when state='long'. */
  positionEntryPrice?: number;
  /** Bar time of the most recent candle evaluated (= candles[candles.length - 1].time). */
  latestBarTs: number;
  /** Close of the most recent candle. */
  latestClose: number;
}

/**
 * Determine whether the strategy is currently long or flat as of the final candle.
 *
 * Algorithm:
 *   1. If trades is empty (no entries ever) → flat.
 *   2. Walk trades to find the LAST sell. If its `reason === 'final'` AND it lands on
 *      candles[last].time, that exit was force-closed at end-of-stream and the position
 *      would not have closed in live deployment — re-pair to the matching buy and
 *      report state='long' with the buy as live entry.
 *   3. If trades end with a 'buy' (no later sell) → long. This happens when an entry
 *      fires on the very last bar: runCustomBacktest's loop processes the entry but
 *      has no subsequent iteration in which to force-close. The buy IS the live entry.
 *   4. Any other terminal `reason` (signal / stop_loss / take_profit, or 'final' on
 *      a non-final bar — the latter is a defensive case for data oddities) → flat.
 *
 * Empty candle array returns flat with latestBarTs/latestClose = 0; caller should
 * filter such tokens out before persisting.
 */
export function evaluateLiveState(candles: Candle[], trades: Trade[]): LiveSignalState {
  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const latestBarTs = last ? last.time : 0;
  const latestClose = last ? last.close : 0;

  if (trades.length === 0) {
    return { state: 'flat', latestBarTs, latestClose };
  }

  // The last trade tells us today's state. Three cases:
  //   1. Last trade is 'buy' → an entry fired with no closing iteration left
  //      (typically: entry on the very last bar). Position is live-open; the
  //      buy IS the live entry.
  //   2. Last trade is 'sell' with reason='final' on candles[last].time →
  //      backtest force-close at end-of-stream; position would have stayed
  //      open in live deployment. Re-pair to the matching buy.
  //   3. Last trade is 'sell' with reason='signal'/'stop_loss'/'take_profit'
  //      (or 'final' on a non-final bar — defensive case for data oddities)
  //      → strategy genuinely exited; flat.
  const lastTrade = trades[trades.length - 1];
  if (lastTrade.type === 'buy') {
    return {
      state: 'long',
      positionEntryTs: lastTrade.time,
      positionEntryPrice: lastTrade.price,
      latestBarTs,
      latestClose,
    };
  }

  // lastTrade is a sell at this point.
  if (lastTrade.reason === 'final' && last && lastTrade.time === last.time) {
    // Find the matching buy = the most recent 'buy' before this sell.
    let matchingBuyIdx = -1;
    for (let i = trades.length - 2; i >= 0; i--) {
      if (trades[i].type === 'buy') { matchingBuyIdx = i; break; }
    }
    if (matchingBuyIdx < 0) {
      // No matching buy — treat as flat (data inconsistency; log via caller).
      return { state: 'flat', latestBarTs, latestClose };
    }
    const buy = trades[matchingBuyIdx];
    return {
      state: 'long',
      positionEntryTs: buy.time,
      positionEntryPrice: buy.price,
      latestBarTs,
      latestClose,
    };
  }

  // Natural exit (signal/stop_loss/take_profit) or 'final' on a bar that is
  // not actually the final bar → strategy is flat.
  return { state: 'flat', latestBarTs, latestClose };
}

// ─── Day-over-day diff ───

export interface PriorState {
  tokenAddress: string;
  symbol: string;
  state: LiveState;
}

export interface CurrentState {
  tokenAddress: string;
  symbol: string;
  state: LiveState;
  positionEntryTs?: number;
  positionEntryPrice?: number;
  latestBarTs: number;
  latestClose: number;
}

export interface CellDiff {
  newEntries: string[];     // symbols flat→long
  newExits: string[];       // symbols long→flat
  stillOpen: string[];      // symbols long→long with fresh data today
  staleOpen: string[];      // symbols prior=long but absent from today's universe (carry-forward; data outage, NOT a phantom EXIT)
  flatBoth: number;         // count of tokens flat→flat (kept as a number, not a list)
  newlyTracked: string[];   // symbols not seen in prior state but currently long
}

/**
 * Compute the day-over-day event set for one cell. Symbols (not addresses) are
 * returned for human-readable Telegram output; the caller handles ordering.
 *
 * Tokens absent from `priorByAddr` are treated as new-to-the-universe: if their
 * current state is 'long' they go into `newlyTracked` (not `newEntries`), so the
 * report can distinguish "the strategy just signaled" from "this token just got
 * added and was already long when we started watching."
 */
export function diffCellStates(
  priorByAddr: Map<string, PriorState>,
  current: CurrentState[],
): CellDiff {
  const newEntries: string[] = [];
  const newExits: string[] = [];
  const stillOpen: string[] = [];
  const staleOpen: string[] = [];
  const newlyTracked: string[] = [];
  let flatBoth = 0;

  const seen = new Set<string>();
  for (const cur of current) {
    seen.add(cur.tokenAddress);
    const prior = priorByAddr.get(cur.tokenAddress);
    if (!prior) {
      if (cur.state === 'long') newlyTracked.push(cur.symbol);
      // flat-and-untracked: invisible event, ignore.
      continue;
    }
    if (prior.state === 'flat' && cur.state === 'long') newEntries.push(cur.symbol);
    else if (prior.state === 'long' && cur.state === 'flat') newExits.push(cur.symbol);
    else if (prior.state === 'long' && cur.state === 'long') stillOpen.push(cur.symbol);
    else flatBoth++;
  }
  // Tokens in priorByAddr that disappeared from `current` (e.g. delisted, fetch
  // failed today, ticker dropped from MIN_HISTORY_DAYS filter): carry-forward
  // a long state into `staleOpen`, NOT a phantom EXIT event. Symbols stay
  // structured (no embedded text) so downstream parsers don't choke; the
  // distinction between fresh-open and stale-open lives at the field level.
  for (const [addr, prior] of priorByAddr) {
    if (seen.has(addr)) continue;
    if (prior.state === 'long') staleOpen.push(prior.symbol);
  }

  newEntries.sort();
  newExits.sort();
  stillOpen.sort();
  staleOpen.sort();
  newlyTracked.sort();
  return { newEntries, newExits, stillOpen, staleOpen, flatBoth, newlyTracked };
}

// ─── Telegram report formatting ───

export interface CellReport {
  /** Short label, e.g. 'mr_v1/p=14'. Caller chooses the convention. */
  label: string;
  diff: CellDiff;
}

export interface DaemonReport {
  date: string;             // YYYY-MM-DD (UTC) of the daemon run
  barsFetched: number;
  barsExpected: number;
  fetchErrors: number;
  fetchSeconds: number;
  totalSeconds: number;
  cells: CellReport[];
  /** Optional per-cell warnings (e.g. "no new bars"). */
  warnings?: string[];
}

/**
 * Compose the Telegram report body. HTML mode; the only metacharacters at risk
 * are inside symbol strings, which are already-validated A-Z/_ tickers (yfinance
 * universe) — but we still escape defensively in case of a future universe with
 * exotic characters.
 *
 * Format (per HANDOFF "Day 1-2"):
 *   [SignalForge] 2026-05-DD daily report
 *   bars fetched: 60/60  errors: 0  fetch_dt: 4.2s  total_dt: 12.9s
 *   mr_v1/p=14: NEW [TGT, JNJ]  EXIT [HD]  OPEN: 4
 *   trend_v1/p=30: NEW []  EXIT []  OPEN: 2
 */
export function formatDaemonReport(r: DaemonReport): string {
  const lines: string[] = [];
  lines.push(`<b>[SignalForge]</b> ${r.date} daily report`);
  lines.push(
    `bars fetched: ${r.barsFetched}/${r.barsExpected}  ` +
    `errors: ${r.fetchErrors}  ` +
    `fetch_dt: ${r.fetchSeconds.toFixed(1)}s  ` +
    `total_dt: ${r.totalSeconds.toFixed(1)}s`
  );
  for (const cell of r.cells) {
    const d = cell.diff;
    const fmtList = (xs: string[]) => xs.length === 0 ? '[]' : `[${xs.map(escapeForReport).join(', ')}]`;
    let line = `<b>${escapeForReport(cell.label)}</b>: NEW ${fmtList(d.newEntries)}  EXIT ${fmtList(d.newExits)}  OPEN: ${d.stillOpen.length}`;
    if (d.staleOpen.length > 0) line += `  STALE ${fmtList(d.staleOpen)}`;
    if (d.newlyTracked.length > 0) line += `  NEW-TRACKED ${fmtList(d.newlyTracked)}`;
    lines.push(line);
  }
  if (r.warnings && r.warnings.length > 0) {
    for (const w of r.warnings) lines.push(`WARN: ${escapeForReport(w)}`);
  }
  return lines.join('\n');
}

function escapeForReport(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
