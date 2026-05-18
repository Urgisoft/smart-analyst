/**
 * Operator-run parity sweep for the daemon-evaluator-capital-retargeting
 * slice (session 61).
 *
 * SPEC: docs/specs/daemon-evaluator-capital-retargeting.md §10.8.
 *
 * Purpose: BEFORE the operator flips `--retarget-evaluator-capital` default
 * to `true`, prove that retargeting preserves cell rankings across the full
 * active cell × token universe. The segmented verdict gate is the protective
 * artifact — unit tests pin the WIRING (flag routing, log format, HALT
 * degenerate); they do NOT pin cell-ranking parity across the live universe.
 * Only this sweep can.
 *
 * Methodology:
 *   - Mirror the daemon's exact evaluator path: same DEFAULT_CELLS, same
 *     equity_midcap universe, same allowlist filter, same `runStrategy`
 *     invocation, same `feePctPerSide`. The only difference is the
 *     `initialBalance` argument value (flag-off → LIQUID_BUCKET_USD;
 *     flag-on → perCellCapital.cellCapitalUsd from stage-aware ramp).
 *   - For each (cell, token) tuple, run `runStrategy` twice and capture
 *     Sharpe, profitFactor, winRate, totalTrades.
 *   - Per-cell aggregation: mean Sharpe across tokens (mirrors how the
 *     daemon's brief surfaces cell health).
 *   - Compute Spearman ρ on per-(cell,token) Sharpe ranks AND on per-cell
 *     mean-Sharpe ranks.
 *   - Print a SEGMENTED verdict per §10.8: cells with `useRiskConfig=false`
 *     vs cells with `useRiskConfig=true`. Today's deployed cells (mr_v1,
 *     trend_v1) all sit in the false segment.
 *
 * Verdict gate (SPEC §10.8 + decision #3 from HANDOFF session 61):
 *   useRiskConfig=false segment (today's): ρ = 1.000 EXACTLY on Sharpe ranks,
 *     ZERO rank shifts of any magnitude. Any deviation = wiring bug, AUTO-BLOCK
 *     the default flip and investigate.
 *   useRiskConfig=true segment (post operator-pending daemon flip): ρ ≥ 0.95,
 *     per-shift investigation on shifts > ±2. Rank churn here is FIDELITY
 *     GAIN (share-floor break at low cellCap), not regression.
 *
 *   Both bars are TIGHTER than session 58's `_threshold_stability_sweep.ts`
 *   (ρ ≥ 0.85) because that compared two DIFFERENT sizing schemes; this
 *   sweep is a PURE SCALE change on the same scheme — under legacy path
 *   it must be lossless.
 *
 * Read-only: no CH writes, no Telegram, no live state mutation.
 *
 * Usage:
 *   npx tsx scripts/_evaluator_retarget_parity_sweep.ts
 *
 * Sequencing note (SPEC §14 + HANDOFF session 61 decision #4):
 *   The daemon `useRiskConfig` flip and the retarget default-on flip MUST be
 *   sequenced separately. Run this sweep BEFORE the retarget default flip.
 *   If/when the operator flips daemon `useRiskConfig: true` later, RE-RUN
 *   this sweep before the default flip — never confound two changes.
 */
import {
  runStrategy,
  type StrategyAdvancedCfg,
} from '../src/lib/indicators.js';
import {
  fetchCandles,
  fetchStrategies,
  getClickHouse,
  pingClickHouse,
} from '../src/server/clickhouse.js';
import {
  DEPLOYMENT_STAGES,
  type DeploymentStage,
} from '../src/server/capital_deployment_config.js';
import { LIQUID_BUCKET_USD } from '../src/server/daemon_constants.js';
import { computePerCellCapital } from '../src/server/per_cell_capital.js';

// ── Knobs (operator-tunable via env, but defaults match the daemon) ────────

const INTERVAL = '1d';
const CANDLE_LIMIT = 5000;
const MIN_BARS = 100;
const MIN_AGE_DAYS = 14;
const MAX_STALE_DAYS = 14;
const MIN_HISTORY_DAYS = 90;

// Mirror DEFAULT_CELLS from scripts/daily_signal_daemon.ts. Keep in lockstep.
interface CellCfg {
  bundleId: string;
  param: number;
  label: string;
}
const DEFAULT_CELLS: CellCfg[] = [
  { bundleId: 'mean_reversion_v1', param: 14, label: 'mr_v1/p=14' },
  { bundleId: 'trend_v1',          param: 30, label: 'trend_v1/p=30' },
];

// Stage the sweep simulates the retarget against. The current production
// stage (post-ramp default per HANDOFF) is `paper` — under `paper` the
// retarget value is identical to LIQUID_BUCKET_USD so the sweep would be
// trivially bit-identical. For a meaningful test of the retargeting code
// path, the operator should pass `--stage stage1` (or another non-paper
// stage) to verify rankings under the deployment-scale capital.
const STAGE: DeploymentStage = ((): DeploymentStage => {
  const i = process.argv.indexOf('--stage');
  if (i >= 0 && i + 1 < process.argv.length) {
    const v = process.argv[i + 1];
    if (v === 'paper' || v === 'stage1' || v === 'stage2' || v === 'stage3' || v === 'stage4') {
      return v;
    }
  }
  return 'stage1';
})();

// ── Universe loader (mirrors daemon's loadEquityUniverse) ──────────────────

interface TokenInfo { tokenAddress: string; symbol: string; }

async function loadEquityUniverse(): Promise<TokenInfo[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        c.token_address AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6)) AS symbol
      FROM (
        SELECT token_address
        FROM quantlab.candles
        WHERE interval = {interval:String}
          AND match(token_address, '^[A-Z]{1,5}_USD$')
          AND source = 'yfinance'
        GROUP BY token_address
        HAVING count() >= {minBars:UInt32}
           AND max(timestamp) >= now() - toIntervalDay({maxStaleDays:UInt32})
           AND min(timestamp) <= now() - toIntervalDay({minAgeDays:UInt32})
           AND dateDiff('day', min(timestamp), max(timestamp)) >= {minHistoryDays:UInt32}
      ) AS c
      LEFT JOIN (SELECT token_address, symbol FROM quantlab.token_metadata FINAL) AS m
        ON m.token_address = c.token_address
      ORDER BY token_address
    `,
    query_params: {
      interval: INTERVAL,
      minBars: MIN_BARS,
      maxStaleDays: MAX_STALE_DAYS,
      minAgeDays: MIN_AGE_DAYS,
      minHistoryDays: MIN_HISTORY_DAYS,
    },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string }>();
  return rows.map(r => ({ tokenAddress: r.token_address, symbol: r.symbol }));
}

async function loadAllowlist(strategyType: string, param: number): Promise<Set<string> | null> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT symbol
      FROM quantlab.cell_allowlist FINAL
      WHERE strategy_type = {st:String}
        AND param = {p:Int32}
    `,
    query_params: { st: strategyType, p: param },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ symbol: string }>();
  if (rows.length === 0) return null;
  return new Set(rows.map(r => r.symbol));
}

// ── Spearman rank correlation (Bailey-LdP §13.2 cites parametric Sharpe ─────
// ranking; Spearman is the standard non-parametric alternative when only
// rank-order matters. Pure helper, no external deps.) ────────────────────────

function rankAverage(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(n).fill(0);
  let j = 0;
  while (j < n) {
    let k = j;
    while (k + 1 < n && indexed[k + 1].v === indexed[j].v) k++;
    const avg = (j + k) / 2 + 1;          // 1-indexed average rank
    for (let p = j; p <= k; p++) ranks[indexed[p].i] = avg;
    j = k + 1;
  }
  return ranks;
}

function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const rx = rankAverage(xs);
  const ry = rankAverage(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  if (dx2 === 0 || dy2 === 0) return NaN;
  return num / Math.sqrt(dx2 * dy2);
}

/** Count of (cell,token) pairs whose Sharpe rank shifted by > k positions. */
function rankShiftsAbove(xs: number[], ys: number[], k: number): number {
  if (xs.length !== ys.length) return -1;
  const rx = rankAverage(xs);
  const ry = rankAverage(ys);
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(rx[i] - ry[i]) > k) n++;
  }
  return n;
}

// ── Main sweep ─────────────────────────────────────────────────────────────

interface CellTokenResult {
  cellLabel: string;
  symbol: string;
  useRiskConfig: boolean;
  legacy: { sharpe: number; trades: number; pf: number; winRate: number; netProfit: number };
  retarget: { sharpe: number; trades: number; pf: number; winRate: number; netProfit: number };
}

async function main(): Promise<number> {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    return 1;
  }
  if (STAGE === 'paper') {
    console.log('[warn] --stage paper → retarget value == legacy LIQUID_BUCKET_USD == $10000.');
    console.log('[warn] The sweep will report ρ=1.000 trivially. Use --stage stage1..stage4 for a real test.');
  }
  console.log(`[parity-sweep] stage=${STAGE} bucket=$${LIQUID_BUCKET_USD}`);

  const cells = DEFAULT_CELLS;
  const perCell = computePerCellCapital({
    liquidBucketUsd: LIQUID_BUCKET_USD,
    stage: STAGE,
    numCells: cells.length,
    halted: false,
  });
  console.log(
    `[parity-sweep] perCellCapital: total=$${perCell.totalCapitalUsd.toFixed(2)} ` +
    `cell=$${perCell.cellCapitalUsd.toFixed(2)} ` +
    `(stage.allocationPct=${DEPLOYMENT_STAGES[STAGE].allocationPct})`,
  );

  const bundles = await fetchStrategies(false);
  const universe = await loadEquityUniverse();
  console.log(`[parity-sweep] universe: ${universe.length} equity_midcap/1d tokens`);

  const results: CellTokenResult[] = [];
  const skipped: { cell: string; symbol: string; reason: string }[] = [];

  for (const cell of cells) {
    const bundle = bundles.find(b => b.bundleId === cell.bundleId);
    if (!bundle) {
      console.warn(`[parity-sweep] skip ${cell.label}: bundle "${cell.bundleId}" not found in quantlab.strategies`);
      continue;
    }
    const adv: StrategyAdvancedCfg = {};
    if (bundle.positionSizePct != null) adv.positionSizePct = bundle.positionSizePct;
    if (bundle.stopLossPct != null)    adv.stopLossPct    = bundle.stopLossPct;
    if (bundle.takeProfitPct != null)  adv.takeProfitPct  = bundle.takeProfitPct;
    const useRiskConfig = adv.useRiskConfig === true;
    const fee = bundle.feePctPerSide ?? 0.6;

    const allowed = await loadAllowlist(cell.bundleId, cell.param);
    const filtered = allowed === null
      ? universe
      : universe.filter(t => allowed.has(t.symbol));
    if (allowed === null) {
      console.warn(`[parity-sweep] ${cell.label}: no allowlist rows; falling back to full universe (${filtered.length} tokens)`);
    } else {
      console.log(`[parity-sweep] ${cell.label}: ${filtered.length}/${universe.length} allowlisted`);
    }

    let evaluated = 0;
    for (const tok of filtered) {
      const candles = await fetchCandles(tok.tokenAddress, INTERVAL, CANDLE_LIMIT);
      if (candles.length < Math.max(50, cell.param * 4)) {
        skipped.push({ cell: cell.label, symbol: tok.symbol, reason: 'insufficient_history' });
        continue;
      }

      const legacy = runStrategy(
        bundle.family, candles, LIQUID_BUCKET_USD, tok.symbol,
        cell.param, bundle.entryLogic, bundle.exitLogic, fee, adv,
      );
      const retarget = runStrategy(
        bundle.family, candles, perCell.cellCapitalUsd, tok.symbol,
        cell.param, bundle.entryLogic, bundle.exitLogic, fee, adv,
      );
      results.push({
        cellLabel: cell.label,
        symbol: tok.symbol,
        useRiskConfig,
        legacy: {
          sharpe: legacy.sharpeRatio,
          trades: legacy.totalTrades,
          pf: legacy.profitFactor,
          winRate: legacy.winRate,
          netProfit: legacy.netProfit,
        },
        retarget: {
          sharpe: retarget.sharpeRatio,
          trades: retarget.totalTrades,
          pf: retarget.profitFactor,
          winRate: retarget.winRate,
          netProfit: retarget.netProfit,
        },
      });
      evaluated++;
    }
    console.log(`[parity-sweep] ${cell.label}: evaluated=${evaluated} skipped=${filtered.length - evaluated}`);
  }

  if (results.length === 0) {
    console.error('[parity-sweep] zero (cell, token) pairs evaluated — cannot compute verdict.');
    return 1;
  }

  // ── Segmented verdict (SPEC §10.8) ────────────────────────────────────────

  const segFalse = results.filter(r => !r.useRiskConfig);
  const segTrue  = results.filter(r =>  r.useRiskConfig);

  function reportSegment(label: string, items: CellTokenResult[], expectedExact: boolean): { ok: boolean; details: string } {
    if (items.length === 0) {
      return { ok: true, details: `(no cells in this segment)` };
    }
    const legacySharpe = items.map(r => Number.isFinite(r.legacy.sharpe) ? r.legacy.sharpe : 0);
    const retargetSharpe = items.map(r => Number.isFinite(r.retarget.sharpe) ? r.retarget.sharpe : 0);
    const rho = spearman(legacySharpe, retargetSharpe);
    const shifts0 = rankShiftsAbove(legacySharpe, retargetSharpe, 0);   // any shift
    const shifts2 = rankShiftsAbove(legacySharpe, retargetSharpe, 2);   // > ±2

    // Trade-count delta: under the legacy path with current strategies (none
    // useRiskConfig today), trade count MUST be byte-equal. Under
    // useRiskConfig=true, trade-count drift at high-priced assets is the
    // expected fidelity gain.
    let tradeCountDiff = 0;
    let maxAbsTradeDiff = 0;
    for (const r of items) {
      const d = r.retarget.trades - r.legacy.trades;
      if (d !== 0) tradeCountDiff++;
      if (Math.abs(d) > maxAbsTradeDiff) maxAbsTradeDiff = Math.abs(d);
    }

    let ok: boolean;
    let verdict: string;
    if (expectedExact) {
      // useRiskConfig=false segment: ρ MUST be exactly 1.000, zero shifts,
      // zero trade-count diffs. Any deviation is a wiring bug.
      ok = rho === 1 && shifts0 === 0 && tradeCountDiff === 0;
      verdict = ok
        ? 'PASS (ρ=1.000 exact, 0 rank shifts, 0 trade-count diffs)'
        : `AUTO-BLOCK — expected ρ=1.000 with 0 shifts, got ρ=${rho.toFixed(6)} shifts=${shifts0} tradeCountDiffs=${tradeCountDiff} (wiring bug — investigate before flipping default)`;
    } else {
      // useRiskConfig=true segment: ρ ≥ 0.95, shifts > ±2 trigger per-shift
      // investigation but do NOT auto-block. Trade-count diffs are expected
      // FIDELITY at high-priced assets.
      ok = rho >= 0.95;
      verdict = ok
        ? `PASS (ρ=${rho.toFixed(4)} ≥ 0.95; ${shifts2} shifts > ±2 to investigate; ${tradeCountDiff} trade-count diffs — fidelity gain at share-floor)`
        : `BLOCK — ρ=${rho.toFixed(4)} < 0.95; rankings not preserved enough; investigate before flipping default`;
    }

    const details =
      `${label}: n=${items.length}\n` +
      `  Spearman ρ (Sharpe) = ${rho.toFixed(6)}\n` +
      `  rank shifts (>0)    = ${shifts0}\n` +
      `  rank shifts (>±2)   = ${shifts2}\n` +
      `  trade-count diffs   = ${tradeCountDiff} (max |Δ| = ${maxAbsTradeDiff})\n` +
      `  verdict             = ${verdict}`;
    return { ok, details };
  }

  console.log('');
  console.log('─── PARITY VERDICT (SPEC §10.8 — segmented gate) ───');
  const falseSeg = reportSegment('useRiskConfig=false segment', segFalse, true);
  const trueSeg  = reportSegment('useRiskConfig=true segment',  segTrue,  false);
  console.log(falseSeg.details);
  console.log('');
  console.log(trueSeg.details);
  console.log('');

  // Top-5 per-cell mean Sharpe stability — auxiliary check.
  const byCell = new Map<string, { legacy: number[]; retarget: number[] }>();
  for (const r of results) {
    const e = byCell.get(r.cellLabel) ?? { legacy: [], retarget: [] };
    if (Number.isFinite(r.legacy.sharpe))   e.legacy.push(r.legacy.sharpe);
    if (Number.isFinite(r.retarget.sharpe)) e.retarget.push(r.retarget.sharpe);
    byCell.set(r.cellLabel, e);
  }
  console.log('Per-cell mean Sharpe (legacy → retarget):');
  for (const [cellLabel, e] of byCell) {
    const meanL = e.legacy.reduce((a, b) => a + b, 0) / Math.max(1, e.legacy.length);
    const meanR = e.retarget.reduce((a, b) => a + b, 0) / Math.max(1, e.retarget.length);
    console.log(`  ${cellLabel}: ${meanL.toFixed(4)} → ${meanR.toFixed(4)} (Δ=${(meanR - meanL).toFixed(6)})`);
  }

  if (skipped.length > 0) {
    console.log('');
    console.log(`[parity-sweep] skipped ${skipped.length} (cell, token) pairs for insufficient history`);
  }

  console.log('');
  const overallOk = falseSeg.ok && trueSeg.ok;
  console.log(`[parity-sweep] overall: ${overallOk ? 'PASS — safe to flip --retarget-evaluator-capital default to true' : 'BLOCK — do NOT flip the default; investigate findings above'}`);
  return overallOk ? 0 : 1;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
