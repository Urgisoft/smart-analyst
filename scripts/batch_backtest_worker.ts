/**
 * Batch backtest worker — one of N threads spawned by scripts/batch_backtest.ts.
 *
 * Each worker:
 *   1. Receives a cell { bundle, token, interval, paramGrid, ... }
 *   2. Pulls candles from ClickHouse (the CH client is per-worker singleton)
 *   3. Runs the strategy across every param in the grid
 *   4. Inserts ONE bt_runs row per (param) plus the trades for the BEST param
 *   5. Posts a summary back to the main thread
 *
 * Each worker holds its own CH client. CH handles thousands of concurrent connections,
 * so 16-32 workers are fine.
 */
import { parentPort } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import {
  fetchCandles,
  insertBacktestRun,
  insertBacktestTrades,
  insertBacktestSlices,
  type PersistSliceArgs,
} from '../src/server/clickhouse.js';
import { runStrategy, StrategyType, StrategyAdvancedCfg } from '../src/lib/indicators.js';
import { computeSliceMetrics } from '../src/lib/sliceMetrics.js';
import { isNoiseZoneTrade, computeDataSpanDays } from './_data_quality.js';

/** Below this bar count, computeSliceMetrics returns nSlices = 0 (CSCV not feasible),
 *  so the third full-window backtest pass would just be wasted CPU. Mirrors the threshold
 *  in src/lib/sliceMetrics.ts so this stays in lockstep with the slicer's own decision. */
const MIN_BARS_FOR_CSCV = 256;

export interface BatchCell {
  bundleId: string;             // 'momentum_v1', 'mean_reversion_v1', etc.
  strategyType: StrategyType;
  entry: string;
  exit: string;
  tokenAddress: string;
  symbol: string;
  tier: string;                 // tier label for logging only
  interval: string;
  paramGrid: number[];
  feePctPerSide: number;
  initialCapital: number;
  advanced?: StrategyAdvancedCfg;
  /** Sweep id used for the bt_runs sweep_id column. Encodes the batch run. */
  sweepId: string;
  /** When true, persist the trade list of the best-performing param. */
  persistBestTrades: boolean;
  /** Cap on number of candles pulled per cell. */
  candleLimit: number;
  /**
   * Walk-forward split point as a percentage (0-100). 0 disables the holdout —
   * IS metrics are computed on the full window and OOS columns are zeroed.
   * Default 70 means: train on first 70% of bars (IS, current `net_profit_pct`),
   * test on last 30% (OOS columns). Works as a holdout, not rolling walk-forward —
   * good enough for filtering overfit params in a personal lab.
   */
  splitPct: number;
  /**
   * Skip persisting bt_runs rows where 1 <= trades < minTradesToPersist (the noise zone).
   * 0 disables the filter entirely. trades == 0 rows ARE always kept — they're a useful
   * "this param never fired" signal and don't pollute leaderboards (they sort to bottom).
   * Recommend 5-10 to drop coin-flip results from thin memecoin samples.
   */
  minTradesToPersist: number;
}

export interface BatchCellResult {
  cellIndex: number;            // index in the input queue (for ordering)
  symbol: string;
  bundleId: string;
  interval: string;             // echoed from the cell so the orchestrator can group results
  paramsTried: number;
  /** Number of params whose result was DROPPED for being in the thin-sample noise zone
   *  (1 <= trades < minTradesToPersist). Persisted rows = paramsTried - paramsSkippedThin. */
  paramsSkippedThin: number;
  bestParam: number | null;
  bestNetProfit: number;
  bestProfitFactor: number;
  bestTrades: number;
  candlesFetched: number;
  ms: number;
  /** Set when fetch or insert fails. The cell is still marked done in the main loop. */
  error?: string;
}

async function runOneCell(cell: BatchCell, cellIndex: number): Promise<BatchCellResult> {
  const t0 = Date.now();
  try {
    const candles = await fetchCandles(cell.tokenAddress, cell.interval, cell.candleLimit);
    if (candles.length < 50) {
      return {
        cellIndex, symbol: cell.symbol, bundleId: cell.bundleId, interval: cell.interval,
        paramsTried: 0, paramsSkippedThin: 0,
        bestParam: null, bestNetProfit: 0, bestProfitFactor: 1, bestTrades: 0,
        candlesFetched: candles.length, ms: Date.now() - t0,
        error: `only ${candles.length} candles`,
      };
    }

    let bestNet = -Infinity;
    let bestParam: number | null = null;
    let bestPF = 1;
    let bestTradeList: any[] = [];
    let bestTradeCount = 0;
    let bestWinRate = 0;
    let bestSharpe = 0;
    let bestGrossProfit = 0;
    let bestGrossLoss = 0;
    let paramsSkippedThin = 0;

    // Walk-forward split: train on first splitPct% of candles (IS), test on the remainder (OOS).
    // splitPct=0 disables the split entirely — IS = full window, OOS = zeros.
    // We compute IS on the train slice (NOT the full window) when split is on, so the IS metric
    // can be honestly compared against OOS. This is a deliberate semantic change: prior runs had
    // IS = full-window. Browse-Results queries that mix old and new rows will see this difference.
    const splitPctClamped = Math.min(99, Math.max(0, cell.splitPct ?? 0));
    const wfEnabled = splitPctClamped > 0 && candles.length >= 100;
    const splitIdx = wfEnabled ? Math.floor((candles.length * splitPctClamped) / 100) : candles.length;
    const trainCandles = wfEnabled ? candles.slice(0, splitIdx) : candles;
    const testCandles  = wfEnabled ? candles.slice(splitIdx)    : [];
    // Span of the FULL candle window — same value for every param row in this cell. Persisted
    // so the Browse panel can filter rows from short-history tokens that produce statistically
    // weak metrics (regime + survivorship bias).
    const dataSpanDays = computeDataSpanDays(candles);

    // Try every param. We persist ONE bt_runs row per param so the table can be queried as
    // "best param per (bundle × token)" — and now also "best OOS param per token".
    const runs: Parameters<typeof insertBacktestRun>[0][] = [];
    const sliceRows: PersistSliceArgs[] = [];
    const cscvFeasible = candles.length >= MIN_BARS_FOR_CSCV;
    for (const param of cell.paramGrid) {
      // IS run — on train slice when WF is enabled, otherwise on the full window.
      const bt = runStrategy(
        cell.strategyType, trainCandles, cell.initialCapital, cell.symbol, param,
        cell.entry, cell.exit, cell.feePctPerSide, cell.advanced
      );
      const profitPct = (bt.netProfit / cell.initialCapital) * 100;
      const pf = Number.isFinite(bt.profitFactor) ? bt.profitFactor : 999;

      // OOS run — only if we actually have a test slice with enough bars.
      let oosNet = 0, oosNetPct = 0, oosPF = 0, oosWin = 0, oosTrades = 0, oosSharpe = 0;
      if (wfEnabled && testCandles.length >= 30) {
        const btOos = runStrategy(
          cell.strategyType, testCandles, cell.initialCapital, cell.symbol, param,
          cell.entry, cell.exit, cell.feePctPerSide, cell.advanced
        );
        oosNet = btOos.netProfit;
        oosNetPct = (btOos.netProfit / cell.initialCapital) * 100;
        oosPF = Number.isFinite(btOos.profitFactor) ? btOos.profitFactor : 999;
        oosWin = btOos.winRate;
        oosTrades = btOos.totalTrades;
        oosSharpe = btOos.sharpeRatio;
      }

      // Drop the thin-sample noise zone — see scripts/_data_quality.ts. Logic lives there
      // so unit tests pin the boundary behavior (n=0 keeps, n=1..min-1 drops, n>=min keeps).
      if (isNoiseZoneTrade(bt.totalTrades, cell.minTradesToPersist ?? 0)) {
        paramsSkippedThin++;
        // Skip both the persist AND the best-tracking. If a result isn't trustworthy enough
        // to write, it isn't trustworthy enough to claim "best of cell" either — otherwise
        // the orchestrator's progress log keeps surfacing PF=∞ from noise-zone params even
        // though those rows never reach bt_runs.
        continue;
      }

      // Third pass: full-window backtest produces the equity curve we slice for CSCV.
      // Skipped when T < 256 (slicer would return nSlices=0 with no rows persisted anyway).
      const runId = randomUUID();
      let nSlices = 0;
      if (cscvFeasible) {
        const btFull = runStrategy(
          cell.strategyType, candles, cell.initialCapital, cell.symbol, param,
          cell.entry, cell.exit, cell.feePctPerSide, cell.advanced
        );
        const sliceMetrics = computeSliceMetrics(candles, btFull.equity, btFull.trades);
        nSlices = sliceMetrics.nSlices;
        for (let s = 0; s < nSlices; s++) {
          sliceRows.push({
            runId,
            sliceIdx: s,
            sliceReturn: sliceMetrics.perSliceReturns[s],
            sliceSharpe: sliceMetrics.perSliceSharpes[s],
            sliceNTrades: sliceMetrics.perSliceTradeCounts[s],
            sliceStartTs: sliceMetrics.perSliceStartTs[s],
            sliceEndTs: sliceMetrics.perSliceEndTs[s],
          });
        }
      }

      runs.push({
        sweepId: cell.sweepId,
        runId,
        symbol: cell.symbol,
        tokenAddress: cell.tokenAddress,
        tier: cell.tier,
        strategyType: cell.bundleId,        // store bundleId here so search/filter is per-version
        entryLogic: cell.entry,
        exitLogic: cell.exit,
        param,
        interval: cell.interval,
        initialCapital: cell.initialCapital,
        feePctPerSide: cell.feePctPerSide,
        netProfit: bt.netProfit,
        netProfitPct: profitPct,
        grossProfit: bt.grossProfit,
        grossLoss: bt.grossLoss,
        profitFactor: pf,
        winRate: bt.winRate,
        trades: bt.totalTrades,
        sharpeRatio: bt.sharpeRatio,
        positionSizePct: cell.advanced?.positionSizePct,
        stopLossPct: cell.advanced?.stopLossPct,
        takeProfitPct: cell.advanced?.takeProfitPct,
        splitPct: wfEnabled ? splitPctClamped : 0,
        oosNetProfit: oosNet,
        oosNetProfitPct: oosNetPct,
        oosProfitFactor: oosPF,
        oosWinRate: oosWin,
        oosTrades,
        oosSharpeRatio: oosSharpe,
        dataSpanDays,
        skewness: bt.skewness,
        kurtosis: bt.kurtosis,
        nSlices,
      });

      // Best-tracking only over PERSISTED results — the orchestrator logs the bestNetProfit
      // from this cell, and that has to match what's actually in bt_runs.
      if (bt.netProfit > bestNet) {
        bestNet = bt.netProfit;
        bestParam = param;
        bestPF = pf;
        bestTradeList = bt.trades;
        bestTradeCount = bt.totalTrades;
        bestWinRate = bt.winRate;
        bestSharpe = bt.sharpeRatio;
        bestGrossProfit = bt.grossProfit;
        bestGrossLoss = bt.grossLoss;
      }
    }

    // Persist all rows. Sequential to keep memory tight; CH likes batched JSONEachRow.
    for (const r of runs) {
      try { await insertBacktestRun(r); } catch (e) {
        // Don't kill the cell on an insert hiccup — log and continue.
        return {
          cellIndex, symbol: cell.symbol, bundleId: cell.bundleId, interval: cell.interval,
          paramsTried: cell.paramGrid.length, paramsSkippedThin, bestParam, bestNetProfit: bestNet,
          bestProfitFactor: bestPF, bestTrades: bestTradeCount,
          candlesFetched: candles.length, ms: Date.now() - t0,
          error: `bt_runs insert: ${(e as Error).message}`,
        };
      }
    }

    // Slices land in one batched insert per cell — typically 16 slices × N persisted params,
    // so a few hundred rows. Failure here is non-fatal for the bt_runs row that's already in;
    // CSCV is just degraded for that run (it'll be NULL pbo at scoring time).
    if (sliceRows.length > 0) {
      try { await insertBacktestSlices(sliceRows); } catch (e) {
        return {
          cellIndex, symbol: cell.symbol, bundleId: cell.bundleId, interval: cell.interval,
          paramsTried: cell.paramGrid.length, paramsSkippedThin, bestParam, bestNetProfit: bestNet,
          bestProfitFactor: bestPF, bestTrades: bestTradeCount,
          candlesFetched: candles.length, ms: Date.now() - t0,
          error: `bt_runs_slices insert: ${(e as Error).message}`,
        };
      }
    }

    if (cell.persistBestTrades && bestTradeList.length > 0 && bestParam != null) {
      try {
        // Tag the trades with (strategy, param) so RL training can join trades back to the
        // exact backtest row that produced them, and the UI can show "trades for the best param"
        // without looking up the run.
        await insertBacktestTrades(cell.sweepId, cell.symbol, cell.tokenAddress, bestTradeList, cell.bundleId, bestParam);
      } catch (e) {
        return {
          cellIndex, symbol: cell.symbol, bundleId: cell.bundleId, interval: cell.interval,
          paramsTried: cell.paramGrid.length, paramsSkippedThin, bestParam, bestNetProfit: bestNet,
          bestProfitFactor: bestPF, bestTrades: bestTradeCount,
          candlesFetched: candles.length, ms: Date.now() - t0,
          error: `bt_trades insert: ${(e as Error).message}`,
        };
      }
    }

    // Suppress unused-warning lints — these are returned indirectly via CH inserts.
    void bestWinRate; void bestSharpe; void bestGrossProfit; void bestGrossLoss;

    return {
      cellIndex, symbol: cell.symbol, bundleId: cell.bundleId, interval: cell.interval,
      paramsTried: cell.paramGrid.length, paramsSkippedThin, bestParam, bestNetProfit: bestNet,
      bestProfitFactor: bestPF, bestTrades: bestTradeCount,
      candlesFetched: candles.length, ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      cellIndex, symbol: cell.symbol, bundleId: cell.bundleId, interval: cell.interval,
      paramsTried: 0, paramsSkippedThin: 0, bestParam: null, bestNetProfit: 0, bestProfitFactor: 1, bestTrades: 0,
      candlesFetched: 0, ms: Date.now() - t0,
      error: (e as Error).message,
    };
  }
}

if (!parentPort) throw new Error('batch_backtest_worker must be run as a Worker thread');

parentPort.on('message', async (msg: { kind: 'cell'; cell: BatchCell; cellIndex: number } | { kind: 'shutdown' }) => {
  if (msg.kind === 'shutdown') {
    process.exit(0);
  }
  const result = await runOneCell(msg.cell, msg.cellIndex);
  parentPort!.postMessage(result);
});

parentPort.postMessage({ kind: 'ready' });
