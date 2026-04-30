/**
 * Sweep worker — runs the parameter sweep (and the optional $E/$X threshold grid) off the
 * main thread so heavy combos don't freeze the UI. Receives a job, posts the result back.
 *
 * Vite resolves the indicators import via the regular module graph; runs as an ES module
 * worker (`type: 'module'`).
 */
import {
  runParameterSweep,
  runMultiAssetBacktest,
  type Candle,
  type StrategyType,
  type StrategyAdvancedCfg,
  type SweepResult,
} from '../lib/indicators';

export interface SweepRequest {
  jobId: number;
  tierData: { symbol: string; candles: Candle[] }[];
  strategy: StrategyType;
  periods: number[];
  customEntry: string;
  customExit: string;
  initialCapital: number;
  feePctPerSide: number;
  advanced?: StrategyAdvancedCfg;
  /** When set, run the (param × $E × $X) grid; results carry winning {bestE, bestX} per param. */
  grid?: { eVals: number[]; xVals: number[] };
}

export interface SweepResponse {
  jobId: number;
  results: (SweepResult & { bestE?: number; bestX?: number })[];
  /** Wall-clock time the job took, for telemetry. */
  ms: number;
}

const sub = (logic: string, e: number, x: number): string =>
  logic.replace(/\$E\b/g, String(e)).replace(/\$X\b/g, String(x));

self.onmessage = (e: MessageEvent<SweepRequest>) => {
  const { jobId, tierData, strategy, periods, customEntry, customExit, initialCapital, feePctPerSide, advanced, grid } = e.data;
  const t0 = Date.now();

  let results: (SweepResult & { bestE?: number; bestX?: number })[];

  if (!grid) {
    results = runParameterSweep(tierData, strategy, periods, customEntry, customExit, initialCapital, feePctPerSide, advanced);
  } else {
    const { eVals, xVals } = grid;
    results = periods.map(p => {
      let best = { profit: -Infinity, e: eVals[0], x: xVals[0], winRate: 0, trades: 0, sharpe: 0 };
      for (const ev of eVals) {
        for (const xv of xVals) {
          const bt = runMultiAssetBacktest(
            tierData, strategy, p, sub(customEntry, ev, xv), sub(customExit, ev, xv),
            initialCapital, feePctPerSide, advanced
          );
          if (bt.aggregated.netProfit > best.profit) {
            best = {
              profit: bt.aggregated.netProfit, e: ev, x: xv,
              winRate: bt.aggregated.winRate, trades: bt.aggregated.totalTrades, sharpe: bt.aggregated.sharpeRatio,
            };
          }
        }
      }
      return {
        parameter: p,
        avgNetProfit: best.profit,
        avgWinRate: best.winRate,
        totalTrades: best.trades,
        avgSharpeRatio: best.sharpe,
        bestE: best.e,
        bestX: best.x,
      };
    });
  }

  const response: SweepResponse = { jobId, results, ms: Date.now() - t0 };
  (self as unknown as { postMessage: (msg: SweepResponse) => void }).postMessage(response);
};

// Marker so Vite treats this as a worker module.
export {};
