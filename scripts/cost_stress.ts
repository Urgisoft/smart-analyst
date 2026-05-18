/**
 * Cost realism stress test (Step 0 — comes before Phase A regime conditioning).
 *
 * Why this script exists
 * ──────────────────────
 * The current backtest engine charges a flat `fee = 0.6%/side` per trade. That's a
 * reasonable CEX taker fee for a liquid major; it is wildly optimistic for `mcap_nano`
 * Solana memecoins on Jupiter, where a realistic round-trip is ~3–8% (priority fees +
 * spread + slippage + aggregator). Before we commit to a multi-week regime-conditioning
 * + meta-labeling build (Phase A + Phase B) on top of the rank-1 cell, we need to know:
 * does the signal even survive realistic costs, or does the +50.4% IS net evaporate?
 *
 * Pardo §6 ("Transaction Costs Will Determine Profitability") and AFML §13 (backtesting
 * on synthetic data) both insist that you validate against realistic frictions BEFORE any
 * further methodological build. This script operationalizes that.
 *
 * What it does
 * ────────────
 * Re-aggregates `bt_runs` cells under a sweep of additional per-side costs (default
 * 0%, 0.5%, 1%, 2%, 3% — round-trip totals 1.2% / 2.2% / 3.2% / 5.2% / 7.2% on top of
 * the 0.6%/side already in the modeled fee). For each cost level, prints:
 *
 *   1. How many cells stay net-positive on BOTH IS and OOS.
 *   2. The rank-1 cell's adjusted IS / OOS / oos_is_ratio.
 *   3. The five most cost-resilient cells.
 *   4. A single-line verdict: PROCEED / WALK AWAY / INSTRUMENT.
 *
 * What it intentionally doesn't do
 * ────────────────────────────────
 *   • No DSR / PSR / CSCV adjustment. DSR depends on per-trade variance, which we don't
 *     have at the aggregate level. The binary "does it survive at all?" question doesn't
 *     need DSR precision — if net % goes negative, DSR goes very negative, gate fails.
 *   • No re-simulation. Pure post-hoc on persisted bt_runs aggregates.
 *   • No size/liquidity-dependent slippage model. Constant per-trade cost is the right
 *     level of detail for the binary decision. Layer in liquidity if Step 0 says
 *     "survives 5% but dies at 8%".
 *   • No regime conditioning. Phase A territory.
 *
 * Math (log-space adjustment, the tricky part)
 * ────────────────────────────────────────────
 * `net_profit_pct` in bt_runs is the *compounded* return, not the sum of per-trade
 * returns. To subtract a per-trade cost cleanly, convert to per-trade log return space:
 *
 *   log_total           = ln(1 + net_profit_pct/100)
 *   log_per_trade       = log_total / n_trades
 *   cost_log_per_trade  = ln(1 - 2 * extra_per_side_pct / 100)   ← negative
 *   adjusted_log        = log_per_trade + cost_log_per_trade
 *   adjusted_net_pct    = (exp(adjusted_log * n_trades) - 1) * 100
 *
 * Done per token (per bt_runs row), then trade-weighted aggregated to the cell
 * (strategy × tier × interval × param), matching how `score_strategies.ts` aggregates.
 *
 * Usage
 * ─────
 *   npm run stress:costs
 *   npm run stress:costs -- --extra 0,0.005,0.01,0.02,0.03
 *   npm run stress:costs -- --rank-cell mean_reversion_v1/mcap_nano/1h/15
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'stress:costs',
    category: 'Backtest engine',
    what: 'Cost-realism stress test — re-aggregates bt_runs cells under a sweep of additional per-side trading costs. Answers "does the rank-1 signal survive realistic memecoin frictions?" before committing to Phase A/B build. Read-only on bt_runs.',
    example: 'npm run stress:costs -- --extra 0,0.005,0.01,0.02,0.03',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────────────

function arg(name: string, def?: string): string | undefined {
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return def;
}

function parseCsvNumbers(s: string): number[] {
  return s.split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .map(t => {
      const n = Number(t);
      if (!Number.isFinite(n)) throw new Error(`--extra: '${t}' is not a number`);
      if (n < 0) throw new Error(`--extra: '${t}' is negative; per-side cost must be ≥ 0`);
      if (n >= 0.5) throw new Error(`--extra: '${t}' ≥ 50%/side is unphysical (would zero out price)`);
      return n;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Math (pure functions — tested in scripts/tests/costStress.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subtract a per-trade extra cost from a compounded net return, in log space.
 *
 * @param netProfitPct  Compounded return, e.g. +50.4 means the strategy's equity grew 1.504×.
 *                      Must be > -100 (you can't lose more than 100%).
 * @param nTrades       Number of round-trip trades that produced the netProfitPct.
 * @param extraPerSide  Additional per-side fractional cost, e.g. 0.005 means add 0.5% per side
 *                      (so 1% per round trip).
 * @returns Adjusted compounded return in pct units. Returns NaN if inputs are invalid.
 *
 * Mechanism: convert net to log-return space, subtract 2*extra_per_side per trade in log
 * space (which is exact for additive log returns), exponentiate back.
 *
 * Failure mode: assumes per-trade log return is roughly constant across trades. For cells
 * with extreme single-trade jackpots (one +1000% trade dominating), the adjustment
 * understates the cost impact (because it amortizes the cost per trade as if all trades
 * were the same size). For broad-based cells like the rank-1 mean_reversion cell with 1,886
 * trades averaging ~0.027% per trade, the approximation is well under 1% relative error.
 */
export function adjustNetPct(netProfitPct: number, nTrades: number, extraPerSide: number): number {
  if (!Number.isFinite(netProfitPct) || !Number.isFinite(nTrades) || !Number.isFinite(extraPerSide)) return NaN;
  if (nTrades <= 0) return NaN;
  // Defensive: a return of <= -100% means total loss; log(1 + x) is undefined.
  if (netProfitPct <= -100) return NaN;
  // 2 * extraPerSide < 1 is enforced at CLI parse time; doublecheck for direct callers.
  if (extraPerSide < 0 || 2 * extraPerSide >= 1) return NaN;

  const logTotal = Math.log(1 + netProfitPct / 100);
  const logPerTrade = logTotal / nTrades;
  const costLogPerTrade = Math.log(1 - 2 * extraPerSide); // ≈ -2*extraPerSide for small extra
  const adjLogPerTrade = logPerTrade + costLogPerTrade;
  return (Math.exp(adjLogPerTrade * nTrades) - 1) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell aggregation
// ─────────────────────────────────────────────────────────────────────────────

export interface RunRowLite {
  strategy_type: string;
  tier: string;
  interval: string;
  param: number;
  token_address: string;
  net_profit_pct: number;
  trades: number;
  oos_net_profit_pct: number;
  oos_trades: number;
}

export interface CellAdjusted {
  strategy: string;
  tier: string;
  interval: string;
  param: number;
  nTokens: number;
  isWtNetPct: number;
  oosWtNetPct: number;
  isTrades: number;
  oosTrades: number;
  /** Pardo §3.4: clamp to 0 when IS is non-positive — WFE undefined without IS edge. */
  oosIsRatio: number;
}

/** Cell key string for grouping. */
export function cellKey(r: { strategy_type: string; tier: string; interval: string; param: number }): string {
  return `${r.strategy_type}/${r.tier}/${r.interval}/${r.param}`;
}

/**
 * Aggregate per-token bt_runs rows to a per-cell adjusted summary at a given extra-cost level.
 * Trade-weighted across tokens, matching `score_strategies.ts`'s `oos_wt_net_pct` semantics.
 */
export function aggregateCells(rows: RunRowLite[], extraPerSide: number): CellAdjusted[] {
  const buckets = new Map<string, RunRowLite[]>();
  for (const r of rows) {
    const k = cellKey(r);
    const list = buckets.get(k) ?? [];
    list.push(r);
    buckets.set(k, list);
  }

  const out: CellAdjusted[] = [];
  for (const [, group] of buckets) {
    let isWeightedSum = 0;
    let oosWeightedSum = 0;
    let isTradesTotal = 0;
    let oosTradesTotal = 0;

    for (const r of group) {
      const adjIs = adjustNetPct(r.net_profit_pct, r.trades, extraPerSide);
      const adjOos = adjustNetPct(r.oos_net_profit_pct, r.oos_trades, extraPerSide);

      // Trade-weight: a token with more trades pulls the cell average more.
      // If adjustment returned NaN (e.g., n_trades=0 or net <= -100), skip that side
      // for this token but still count the other side if valid.
      if (Number.isFinite(adjIs)) {
        isWeightedSum += adjIs * r.trades;
        isTradesTotal += r.trades;
      }
      if (Number.isFinite(adjOos)) {
        oosWeightedSum += adjOos * r.oos_trades;
        oosTradesTotal += r.oos_trades;
      }
    }

    const isWt = isTradesTotal > 0 ? isWeightedSum / isTradesTotal : 0;
    const oosWt = oosTradesTotal > 0 ? oosWeightedSum / oosTradesTotal : 0;
    // Pardo §3.4: oos_is_ratio meaningless when IS edge is non-positive.
    const oosIsRatio = isWt > 0 ? Math.max(0, oosWt) / isWt : 0;

    out.push({
      strategy: group[0].strategy_type,
      tier: group[0].tier,
      interval: group[0].interval,
      param: group[0].param,
      nTokens: group.length,
      isWtNetPct: isWt,
      oosWtNetPct: oosWt,
      isTrades: isTradesTotal,
      oosTrades: oosTradesTotal,
      oosIsRatio,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────────

export interface VerdictInput {
  /** Rank-1 cell's adjusted IS net pct at each cost level, indexed by extraPerSide. */
  rankIsNetByCost: Map<number, number>;
  rankOosNetByCost: Map<number, number>;
}

export type Verdict =
  | { kind: 'proceed'; reason: string }
  | { kind: 'walk-away'; reason: string }
  | { kind: 'instrument'; reason: string };

/**
 * Verdict thresholds (judgment calls, see SPEC):
 *   • Survives extra=0.02 per-side (5.2% round trip) on BOTH IS and OOS  → PROCEED
 *   • Dies by extra=0.01 per-side (3.2% round trip) on EITHER IS or OOS  → WALK AWAY
 *   • Anything in between (survives 3.2% but dies at 5.2%)              → INSTRUMENT
 */
export function decideVerdict(v: VerdictInput): Verdict {
  const at = (extra: number): { is: number | undefined; oos: number | undefined } => ({
    is: v.rankIsNetByCost.get(extra),
    oos: v.rankOosNetByCost.get(extra),
  });
  const a02 = at(0.02);
  const a01 = at(0.01);
  const survivesAt = (level: { is?: number; oos?: number }): boolean =>
    typeof level.is === 'number' && typeof level.oos === 'number' && level.is > 0 && level.oos > 0;
  const diesAt = (level: { is?: number; oos?: number }): boolean =>
    (typeof level.is === 'number' && level.is <= 0) || (typeof level.oos === 'number' && level.oos <= 0);

  if (survivesAt(a02)) {
    return { kind: 'proceed', reason: 'Rank-1 cell remains net-positive on both IS and OOS at 5.2% round-trip cost.' };
  }
  if (diesAt(a01)) {
    return { kind: 'walk-away', reason: 'Rank-1 cell goes net-negative by 3.2% round-trip cost. Modeled signal does not carry realistic memecoin frictions.' };
  }
  return {
    kind: 'instrument',
    reason: 'Rank-1 survives 3.2% round-trip but dies by 5.2%. Cost-model error bar is too wide to decide on alone — recommend deploying a paper-trade harness to measure actual Jupiter slippage on this universe before deciding.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const extraStr = arg('extra', '0,0.005,0.01,0.02,0.03')!;
  const extras = parseCsvNumbers(extraStr).sort((a, b) => a - b);
  const rankCellArg = arg('rank-cell', 'mean_reversion_v1/mcap_nano/1h/15')!;

  console.log(`Cost realism stress test`);
  console.log(`  extra/side  : ${extras.map(e => (e * 100).toFixed(2) + '%').join(', ')}`);
  console.log(`  rank cell   : ${rankCellArg}`);
  console.log(`  reads       : bt_runs only. No writes.`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.'); process.exit(1);
  }
  const ch = getClickHouse();

  // Same universe pruning as score_strategies.ts buildBtRunsFilter() — keeps the cost-stress
  // population identical to the scoring population so survivor counts are apples-to-apples.
  const r = await ch.query({
    query: `
      SELECT strategy_type, tier, interval, param, token_address,
             net_profit_pct, trades, oos_net_profit_pct, oos_trades
      FROM quantlab.bt_runs FINAL
      WHERE abs(net_profit_pct) < 1000000
        AND abs(oos_net_profit_pct) < 1000000
        AND tier NOT IN ('mcap_large', 'mcap_unknown')
        AND interval != '4h'
        AND net_profit_pct > -100
    `,
    format: 'JSONEachRow',
  });
  const raw = await r.json<any>();
  const rows: RunRowLite[] = raw.map((x: any): RunRowLite => ({
    strategy_type: String(x.strategy_type),
    tier: String(x.tier),
    interval: String(x.interval),
    param: Number(x.param),
    token_address: String(x.token_address),
    net_profit_pct: Number(x.net_profit_pct),
    trades: Number(x.trades),
    oos_net_profit_pct: Number(x.oos_net_profit_pct ?? 0),
    oos_trades: Number(x.oos_trades ?? 0),
  })).filter((r: RunRowLite) => r.trades > 0);

  console.log(`  bt_runs rows: ${rows.length} (post-universe-filter, trades>0)`);
  console.log();

  // Aggregate at every cost level once.
  const cellsByCost = new Map<number, CellAdjusted[]>();
  for (const e of extras) cellsByCost.set(e, aggregateCells(rows, e));

  const distinctCells = cellsByCost.get(extras[0])!.length;
  console.log(`  distinct cells (strategy × tier × interval × param): ${distinctCells}`);
  console.log();

  // ─── Per cost level: survivor counts + rank cell's row ────────────────────
  const rankIsByCost = new Map<number, number>();
  const rankOosByCost = new Map<number, number>();

  console.log(`Per-cost-level survival`);
  console.log();
  console.log(`  extra/side  round-trip  survivors    rank1_IS_net   rank1_OOS_net   rank1_oos/is`);
  console.log(`  ──────────  ──────────  ─────────    ──────────────  ──────────────  ────────────`);

  for (const e of extras) {
    const cells = cellsByCost.get(e)!;
    const survivors = cells.filter(c => c.isWtNetPct > 0 && c.oosWtNetPct > 0).length;
    const rank = cells.find(c => `${c.strategy}/${c.tier}/${c.interval}/${c.param}` === rankCellArg);

    const rt = (0.6 * 2 + e * 200).toFixed(2); // baseline 0.6%/side already in the modeled fee, doubled for round trip, plus 2*extra (in pct)
    const sgn = (n: number) => n >= 0 ? '+' : '';
    const fmt = (n: number, w: number, d = 2) => n.toFixed(d).padStart(w);

    if (rank) {
      rankIsByCost.set(e, rank.isWtNetPct);
      rankOosByCost.set(e, rank.oosWtNetPct);
      console.log(
        `  ${(`+${(e * 100).toFixed(2)}%`).padStart(10)}  ` +
        `${(rt + '%').padStart(10)}  ` +
        `${String(survivors).padStart(9)}    ` +
        `${(sgn(rank.isWtNetPct) + fmt(rank.isWtNetPct, 8, 2) + '%').padStart(14)}  ` +
        `${(sgn(rank.oosWtNetPct) + fmt(rank.oosWtNetPct, 8, 2) + '%').padStart(14)}  ` +
        `${fmt(rank.oosIsRatio, 11, 3).padStart(12)}`
      );
    } else {
      console.log(
        `  ${(`+${(e * 100).toFixed(2)}%`).padStart(10)}  ` +
        `${(rt + '%').padStart(10)}  ` +
        `${String(survivors).padStart(9)}    ` +
        `${'(rank cell not found)'.padStart(40)}`
      );
    }
  }
  console.log();
  console.log(`  Round-trip = 2 × (0.6% baseline fee + extra/side). ` +
              `Survivor = adj_IS_wt_net > 0 AND adj_OOS_wt_net > 0.`);
  console.log();

  // ─── Top-5 most cost-resilient cells ─────────────────────────────────────
  // For each cell, find the largest extra at which it stays IS+OOS positive.
  type Resilience = { cell: CellAdjusted; maxExtra: number };
  const resilience: Resilience[] = [];
  const cellsAtZero = cellsByCost.get(extras[0])!;
  for (const c of cellsAtZero) {
    let maxE = -Infinity;
    for (const e of extras) {
      const cellsHere = cellsByCost.get(e)!;
      const here = cellsHere.find(x =>
        x.strategy === c.strategy && x.tier === c.tier && x.interval === c.interval && x.param === c.param
      );
      if (here && here.isWtNetPct > 0 && here.oosWtNetPct > 0) maxE = e;
    }
    if (maxE > -Infinity) resilience.push({ cell: c, maxExtra: maxE });
  }
  resilience.sort((a, b) => b.maxExtra - a.maxExtra || b.cell.isWtNetPct - a.cell.isWtNetPct);
  const top5 = resilience.slice(0, 5);

  console.log(`Top 5 most cost-resilient cells`);
  console.log();
  console.log(`  rank  cell                                                       max_extra/side  rt_at_max`);
  console.log(`  ────  ─────────────────────────────────────────────────────────  ──────────────  ─────────`);
  if (top5.length === 0) {
    console.log(`  (none — no cell stays IS+OOS positive at any tested cost level)`);
  } else {
    for (let i = 0; i < top5.length; i++) {
      const t = top5[i];
      const cellStr = `${t.cell.strategy} / ${t.cell.tier} / ${t.cell.interval} / p=${t.cell.param}`;
      const rtAtMax = (0.6 * 2 + t.maxExtra * 200).toFixed(2) + '%';
      console.log(
        `  ${String(i + 1).padStart(4)}  ` +
        `${cellStr.padEnd(57)}  ` +
        `${(`+${(t.maxExtra * 100).toFixed(2)}%`).padStart(14)}  ` +
        `${rtAtMax.padStart(9)}`
      );
    }
  }
  console.log();

  // ─── Verdict ──────────────────────────────────────────────────────────────
  const verdict = decideVerdict({
    rankIsNetByCost: rankIsByCost,
    rankOosNetByCost: rankOosByCost,
  });
  console.log(`Verdict`);
  console.log();
  switch (verdict.kind) {
    case 'proceed':
      console.log(`  PROCEED to Phase A (regime conditioning).`);
      console.log(`  ${verdict.reason}`);
      break;
    case 'walk-away':
      console.log(`  WALK AWAY from this cell.`);
      console.log(`  ${verdict.reason}`);
      console.log(`  Recommendation: look at whether ANY cell stays survivor-positive at 5%+ round-trip.`);
      console.log(`  If none: try a structurally different strategy family (volume_breakout_v1 is`);
      console.log(`  already seeded; microstructure-based families are not).`);
      break;
    case 'instrument':
      console.log(`  INSTRUMENT before deciding.`);
      console.log(`  ${verdict.reason}`);
      break;
  }
  console.log();
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}

/*
 * What could break this
 * ─────────────────────
 *   • Approximation error from log-space adjustment. For high-jackpot cells (e.g. +1441% IS
 *     dominated by one outlier trade), the per-trade-equal-cost amortization understates the
 *     cost impact. For broad-based cells like the rank-1 mean_reversion cell (1,886 trades,
 *     ~0.027% mean per-trade), error is well under 1% relative — fine for a binary decision.
 *   • bt_runs `n_trades` differs from actual fired trade count by ~30% for some cells (per
 *     the diagnose_rank1_regime simulation-vs-bt_runs gap). For the cost adjustment, using
 *     bt_runs's n_trades is correct because that's the number of fees the engine deducted.
 *   • Constant per-trade cost ignores intra-day priority-fee variance and size-dependent
 *     slippage. The binary decision is robust to ±0.5% on the cost estimate; if the verdict
 *     lands on INSTRUMENT, that's the trigger to layer in a more realistic cost model.
 *   • PBO/CSCV is held constant (computed at baseline cost). If a cost level radically reshapes
 *     the param landscape, PBO might differ — but selection-bias diagnosis ≠ friction-sensitivity
 *     diagnosis, so it's fine to decouple them at this stage.
 */
