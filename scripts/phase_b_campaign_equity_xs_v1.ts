/**
 * Phase B campaign for `equity_xs_v1` — cross-sectional single-stock equity ALPHA
 * (P0 universe + P1 institutional-positioning S_inst sub-score).
 *
 * Spec: docs/specs/single-stock-equity-analysis-scoping.md (P0 + P1 only).
 *
 * This is structurally DIFFERENT from the four macro campaign harnesses
 * (cycle_v1 / vol_struct_v1 / sector_rot_v1 / cross_asset_v1): those are
 * single-time-series long-only θ-threshold sweeps on ONE benchmark. This one is
 * a CROSS-SECTIONAL long-short portfolio over the S&P 500 PIT universe. The
 * common ground — and the thing reused VERBATIM — is the four-gate deflation
 * stack in `src/lib/validator.ts` (computeDsrGate / computePboGate /
 * computeHlzGate / computePardoGate) and the persistence layer
 * `src/server/phase_b_repository.ts`. NONE of the gate math is forked.
 *
 * The "trials" axis for HLZ/DSR (which need a sweep to estimate the selection-
 * bias noise floor) is the set of portfolio VARIANTS we evaluate, per spec §3.5:
 *   M = (variants) = {Q5−Q1 long-short, beta-neutral long-only} × {macro off}.
 * P1 keeps macro OFF, so M = 2. This is deliberately tiny (spec §2.3 ≤3 free
 * params; §3.5 "M < ~12"); a small M keeps the HLZ haircut honest rather than
 * inflating the trial count to manufacture significance.
 *
 * The PRIMARY validated series is Q5−Q1 (dollar-neutral long-short). The
 * long-only series is validated ONLY on its SPY-beta-neutralized residual
 * (spec §3.3). A PASS requires a BETA-NEUTRAL stream to clear DSR/HLZ; if only
 * the raw long-only (beta-laden) stream would clear, the verdict is
 * "FAIL — beta not alpha" (spec §3.3 acceptance criterion).
 *
 * --dry-run (default): compute + print; NO CH writes.
 * --apply             : also persist verdict rows + write the markdown report.
 *
 * ANTI-SHOPPING (ADR-051 §Decision 5 / spec §3.2): a FAIL is permanent. No
 * threshold is relaxed to force a pass. If the data walls (survivorship +
 * insider-window) make the result `insufficient`, that is reported honestly as a
 * cheap, early, money-saving null — NOT papered over.
 *
 * Canon: see src/server/equity_xs.ts header + validator.ts gate sources.
 */
import 'dotenv/config';
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  computeDsrGate,
  computePardoGate,
  computeHlzGate,
  computePboGate,
  DEFAULT_DSR_GATE,
  DEFAULT_PBO_GATE,
  DEFAULT_PARDO_GATE,
  DEFAULT_HLZ_ALPHA,
  DEFAULT_HLZ_METHOD,
  type GateOutcome,
} from '../src/lib/validator.js';
import {
  insertPhaseBVerdict,
  type PhaseBVerdictRow,
  type PhaseBVerdict,
} from '../src/server/phase_b_repository.js';
import {
  COMPOSITE_VERSION,
  INSIDER_WINDOW_DAYS,
  LIQUIDITY_FLOOR_PCT,
  ADV_LOOKBACK_DAYS,
  WINDOW_START_DATE,
  IS_END_DATE,
  OOS_START_DATE,
  SPY_TOKEN_ADDRESS,
  buildPortfolios,
  betaNeutralize,
  type RebalanceSnapshot,
  type TickerFeatureRow,
  type PriceSeries,
  type PortfolioReturns,
} from '../src/server/equity_xs.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'phase_b:equity_xs_v1:dry',
    category: 'Data quality',
    what:
      'Dry-run: build the PIT S&P 500 universe, measure delisted-candle ' +
      'coverage (survivorship), compute S_inst Q5−Q1 long-short + beta-neutral ' +
      'long-only, run the four-gate deflation stack, print verdict. NO CH writes.',
  },
  {
    npm: 'phase_b:equity_xs_v1:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus persist verdict rows to quantlab.phase_b_verdicts ' +
      "(composite_version='equity_xs_v1') and write the markdown report.",
  },
];

/** Equity-constituent candle token suffix (TICKER_SP500), per candles inspection. */
export const CONSTITUENT_PRICE_SUFFIX = '_SP500';
export const CONSTITUENT_CANDLE_SOURCE = 'yfinance_constituents';

/** Sharpe (non-annual) — same convention as validator.ts:sharpeNonAnnual. */
function sharpeNonAnnual(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let varSum = 0;
  for (const r of returns) { const d = r - mean; varSum += d * d; }
  const variance = varSum / n;
  if (variance === 0) return 0;
  return mean / Math.sqrt(variance);
}

function skewness(returns: number[]): number {
  const n = returns.length;
  if (n < 3) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0;
  for (const r of returns) { const d = r - mean; m2 += d * d; m3 += d * d * d; }
  m2 /= n; m3 /= n;
  const sd3 = Math.pow(m2, 1.5);
  return sd3 === 0 ? 0 : m3 / sd3;
}
function kurtosis(returns: number[]): number {
  const n = returns.length;
  if (n < 4) return 3;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m4 = 0;
  for (const r of returns) { const d = r - mean; m2 += d * d; m4 += d * d * d * d; }
  m2 /= n; m4 /= n;
  return m2 === 0 ? 3 : m4 / (m2 * m2);
}

/** Split a return stream by isEndDate into IS/OOS halves. */
function splitIsOos(p: PortfolioReturns, isEndDate: string): { is: number[]; oos: number[] } {
  const is: number[] = [];
  const oos: number[] = [];
  for (let i = 0; i < p.dates.length; i++) {
    if (p.dates[i] <= isEndDate) is.push(p.returns[i]);
    else oos.push(p.returns[i]);
  }
  return { is, oos };
}

// ── Survivorship coverage measurement (spec §3.4 / P0) ────────────────────────

export interface SurvivorshipReport {
  everMembers: number;
  currentMembers: number;
  delistedNames: number;
  delistedWithCandles: number;
  delistedCoveragePct: number;
  /** True if the price universe is current-membership-biased → verdicts suspect. */
  survivorshipSuspect: boolean;
}

export async function measureSurvivorship(
  ch: ClickHouseClient = getClickHouse(),
): Promise<SurvivorshipReport> {
  const q = await ch.query({
    query: `
      WITH cur AS (
        SELECT DISTINCT ticker FROM quantlab.sp500_history
        WHERE trade_date = (SELECT max(trade_date) FROM quantlab.sp500_history)
      ),
      ever AS (SELECT DISTINCT ticker FROM quantlab.sp500_history),
      delisted AS (SELECT ticker FROM ever WHERE ticker NOT IN (SELECT ticker FROM cur)),
      cands AS (
        SELECT DISTINCT replaceRegexpOne(token_address, '${CONSTITUENT_PRICE_SUFFIX}$', '') AS tk
        FROM quantlab.candles
        WHERE source = {src:String} AND interval = '1d'
      )
      SELECT
        (SELECT count() FROM ever) AS ever_members,
        (SELECT count() FROM cur) AS current_members,
        (SELECT count() FROM delisted) AS delisted_names,
        (SELECT count() FROM delisted WHERE ticker IN (SELECT tk FROM cands)) AS delisted_covered
    `,
    query_params: { src: CONSTITUENT_CANDLE_SOURCE },
    format: 'JSONEachRow',
  });
  const [row] = await q.json<{
    ever_members: string | number;
    current_members: string | number;
    delisted_names: string | number;
    delisted_covered: string | number;
  }>();
  const everMembers = Number(row.ever_members);
  const currentMembers = Number(row.current_members);
  const delistedNames = Number(row.delisted_names);
  const delistedWithCandles = Number(row.delisted_covered);
  const delistedCoveragePct = delistedNames === 0 ? 1 : delistedWithCandles / delistedNames;
  // Suspect when < half the delisted names have price coverage (spec §3.4: a
  // current-membership-biased candle table optimistically biases long-short).
  const survivorshipSuspect = delistedCoveragePct < 0.5;
  return {
    everMembers, currentMembers, delistedNames, delistedWithCandles,
    delistedCoveragePct, survivorshipSuspect,
  };
}

// ── PIT universe + feature builder (P0 + P1) ──────────────────────────────────

/** Monthly rebalance dates = first trading day of each month present in candles. */
export async function loadRebalanceDates(
  ch: ClickHouseClient = getClickHouse(),
): Promise<string[]> {
  const q = await ch.query({
    query: `
      SELECT toString(min(toDate(timestamp))) AS d
      FROM quantlab.candles
      WHERE source = {src:String} AND interval = '1d'
        AND toDate(timestamp) >= {start:Date}
      GROUP BY toStartOfMonth(toDate(timestamp))
      ORDER BY d ASC
    `,
    query_params: { src: CONSTITUENT_CANDLE_SOURCE, start: WINDOW_START_DATE },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string }>();
  return rows.map(r => r.d);
}

/**
 * Build the per-rebalance universe + S_inst features. For each rebalance date:
 *   - PIT membership: tickers that were S&P 500 members as-of that date
 *     (sp500_history latest trade_date ≤ rebalance), INTERSECTED with names that
 *     have candle coverage (the survivorship-binding subset).
 *   - net trailing-90d insider buy $ (P − S, by accepted_at).
 *   - 13D/activist flag (any filing in trailing 90d).
 *   - short-interest change_pct (latest ≤ rebalance).
 *   - 20-day ADV dollar (from candles, trailing ADV_LOOKBACK_DAYS).
 */
export async function buildSnapshots(
  rebalanceDates: string[],
  ch: ClickHouseClient = getClickHouse(),
): Promise<RebalanceSnapshot[]> {
  const snapshots: RebalanceSnapshot[] = [];
  for (const date of rebalanceDates) {
    const q = await ch.query({
      query: `
        WITH
        asof AS (SELECT max(trade_date) AS d FROM quantlab.sp500_history WHERE trade_date <= {reb:Date}),
        members AS (
          SELECT DISTINCT ticker FROM quantlab.sp500_history
          WHERE trade_date = (SELECT d FROM asof)
        ),
        covered AS (
          SELECT DISTINCT replaceRegexpOne(token_address, '${CONSTITUENT_PRICE_SUFFIX}$', '') AS ticker
          FROM quantlab.candles
          WHERE source = {src:String} AND interval = '1d'
        ),
        univ AS (SELECT ticker FROM members WHERE ticker IN (SELECT ticker FROM covered)),
        insider AS (
          SELECT issuer_ticker AS ticker,
                 sum(if(transaction_code='P', dollar_amount, 0)) -
                 sum(if(transaction_code='S', dollar_amount, 0)) AS net_buy
          FROM quantlab.insider_trades
          WHERE issuer_ticker != ''
            AND transaction_code IN ('P','S')
            AND accepted_at < {reb:DateTime}
            AND accepted_at >= {reb:DateTime} - INTERVAL {win:UInt32} DAY
          GROUP BY issuer_ticker
        ),
        activist AS (
          SELECT issuer_ticker AS ticker, 1 AS flag
          FROM quantlab.schedule_13d_g_filings
          WHERE issuer_ticker != ''
            AND accepted_at < {reb:DateTime}
            AND accepted_at >= {reb:DateTime} - INTERVAL {win:UInt32} DAY
          GROUP BY issuer_ticker
        ),
        si AS (
          SELECT symbol AS ticker, argMax(change_pct, settlement_date) AS chg
          FROM quantlab.short_interest
          WHERE settlement_date <= {reb:Date} AND change_pct IS NOT NULL
          GROUP BY symbol
        ),
        adv AS (
          SELECT replaceRegexpOne(token_address, '${CONSTITUENT_PRICE_SUFFIX}$', '') AS ticker,
                 avg(close * volume) AS adv_dollar
          FROM (
            SELECT token_address, close, volume, toDate(timestamp) AS dt
            FROM quantlab.candles
            WHERE source = {src:String} AND interval = '1d' AND toDate(timestamp) < {reb:Date}
            ORDER BY token_address, dt DESC
            LIMIT {adv:UInt32} BY token_address
          )
          GROUP BY ticker
        )
        SELECT u.ticker AS ticker,
               ifNull(i.net_buy, 0) AS net_buy,
               ifNull(a.flag, 0) AS activist_flag,
               s.chg AS si_change,
               ifNull(adv.adv_dollar, 0) AS adv_dollar
        FROM univ u
        LEFT JOIN insider i ON u.ticker = i.ticker
        LEFT JOIN activist a ON u.ticker = a.ticker
        LEFT JOIN si s ON u.ticker = s.ticker
        LEFT JOIN adv ON u.ticker = adv.ticker
      `,
      query_params: {
        reb: date,
        src: CONSTITUENT_CANDLE_SOURCE,
        win: INSIDER_WINDOW_DAYS,
        adv: ADV_LOOKBACK_DAYS,
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{
      ticker: string;
      net_buy: string | number;
      activist_flag: string | number;
      si_change: string | number | null;
      adv_dollar: string | number;
    }>();
    const featureRows: TickerFeatureRow[] = rows.map(r => ({
      ticker: r.ticker,
      netInsiderBuyUsd: Number(r.net_buy),
      activistFlag: Number(r.activist_flag),
      shortInterestChangePct:
        r.si_change === null || r.si_change === undefined ? null : Number(r.si_change),
      advDollar: Number(r.adv_dollar),
    }));
    snapshots.push({ date, rows: featureRows });
  }
  return snapshots;
}

/** Load daily closes for every constituent + SPY into a PriceSeries. */
export async function loadPrices(
  ch: ClickHouseClient = getClickHouse(),
): Promise<{ prices: PriceSeries; spy: { dates: string[]; returns: number[] } }> {
  const q = await ch.query({
    query: `
      SELECT token_address AS ta, toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles
      WHERE interval = '1d'
        AND (source = {src:String} OR token_address = {spy:String})
        AND toDate(timestamp) >= {start:Date}
      ORDER BY token_address ASC, d ASC
    `,
    query_params: {
      src: CONSTITUENT_CANDLE_SOURCE,
      spy: SPY_TOKEN_ADDRESS,
      start: WINDOW_START_DATE,
    },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ ta: string; d: string; close: string | number }>();
  const byTicker = new Map<string, { dates: string[]; closes: number[] }>();
  for (const r of rows) {
    let e = byTicker.get(r.ta);
    if (!e) { e = { dates: [], closes: [] }; byTicker.set(r.ta, e); }
    e.dates.push(r.d);
    e.closes.push(typeof r.close === 'string' ? parseFloat(r.close) : r.close);
  }
  // SPY daily arithmetic returns.
  const spyRaw = byTicker.get(SPY_TOKEN_ADDRESS);
  const spy = { dates: [] as string[], returns: [] as number[] };
  if (spyRaw) {
    for (let i = 1; i < spyRaw.dates.length; i++) {
      const prev = spyRaw.closes[i - 1];
      const cur = spyRaw.closes[i];
      if (!(prev > 0) || !(cur > 0)) continue;
      spy.dates.push(spyRaw.dates[i]);
      spy.returns.push(cur / prev - 1);
    }
  }
  return { prices: { byTicker }, spy };
}

// ── Gate runner over the variant set ──────────────────────────────────────────

export interface VariantGateResult {
  variant: string;
  isSharpe: number;
  oosSharpe: number;
  dsr: GateOutcome;
  pbo: GateOutcome;
  hlz: GateOutcome;
  oosIs: GateOutcome;
  verdict: PhaseBVerdict;
}

/**
 * Run the four-gate deflation stack on one return stream. The "trials" for
 * DSR/HLZ noise-floor estimation are the M variant Sharpes (spec §3.5) — the
 * selection-bias correction is over the variant set, not a θ-grid. PBO uses
 * CSCV over the IS slice-Sharpes of THIS stream vs the other variants.
 */
export function runGatesForVariant(
  variant: string,
  isReturns: number[],
  oosReturns: number[],
  variantIsSharpes: number[],
  globalRank: number,
  mTotal: number,
  allVariantIsReturns: number[][],
): VariantGateResult {
  const isSharpe = sharpeNonAnnual(isReturns);
  const oosSharpe = sharpeNonAnnual(oosReturns);

  const dsr = computeDsrGate({
    trialSharpes: variantIsSharpes,
    chosenSharpe: isSharpe,
    chosenBars: isReturns.length,
    moments: { skewness: skewness(isReturns), kurtosis: kurtosis(isReturns) },
    gate: DEFAULT_DSR_GATE,
  });

  // PBO via CSCV over the variant return matrices (IS window). Requires ≥256
  // bars and ≥2 active configs; returns 'na' honestly otherwise.
  const pbo = computePboGate({
    returnsByConfig: allVariantIsReturns,
    gate: DEFAULT_PBO_GATE,
  });

  const hlz = computeHlzGate({
    chosenSharpe: isSharpe,
    chosenBars: isReturns.length,
    chosenRank: globalRank,
    nTrials: mTotal,
    method: DEFAULT_HLZ_METHOD,
    alpha: DEFAULT_HLZ_ALPHA,
  });

  const oosIs = computePardoGate({
    isSharpe,
    oosSharpe,
    isBars: isReturns.length,
    oosBars: oosReturns.length,
    gate: DEFAULT_PARDO_GATE,
  });

  const dsrPass = dsr.status === 'pass';
  const pboPass = pbo.status === 'pass';
  const hlzPass = hlz.status === 'pass';
  const oosIsPass = oosIs.status === 'pass';
  const allRan = [dsr, pbo, hlz, oosIs].every(g => g.status !== 'na');
  let verdict: PhaseBVerdict;
  if (!allRan) verdict = 'insufficient';
  else if (dsrPass && pboPass && hlzPass && oosIsPass) verdict = 'pass-all';
  else if (dsrPass || pboPass || hlzPass || oosIsPass) verdict = 'partial';
  else verdict = 'fail';

  return { variant, isSharpe, oosSharpe, dsr, pbo, hlz, oosIs, verdict };
}

// ── Campaign orchestrator ─────────────────────────────────────────────────────

export interface EquityXsCampaignResult {
  survivorship: SurvivorshipReport;
  nRebalances: number;
  nRebalancesWithBothLegs: number;
  medianEligibleUniverse: number;
  lsDates: number;
  loDates: number;
  betaNeutralBeta: number;
  betaNeutralAlphaDaily: number;
  betaNeutralN: number;
  variants: VariantGateResult[];
}

export async function runCampaign(
  ch: ClickHouseClient = getClickHouse(),
): Promise<EquityXsCampaignResult> {
  const survivorship = await measureSurvivorship(ch);
  const rebalanceDates = await loadRebalanceDates(ch);
  const snapshots = await buildSnapshots(rebalanceDates, ch);
  const { prices, spy } = await loadPrices(ch);

  const built = buildPortfolios({
    snapshots,
    prices,
    priceSuffix: CONSTITUENT_PRICE_SUFFIX,
  });

  // Beta-neutralize the long-only stream (spec §3.3) — this residual is what the
  // gates see for the long-only variant, NOT the raw long-only return.
  const bn = betaNeutralize(built.longOnly, spy);

  // Variant streams (P1: macro OFF → M = 2): LS = Q5−Q1; LO_bn = beta-neutral LO.
  const lsSplit = splitIsOos(built.longShort, IS_END_DATE);
  const loBnSplit = splitIsOos(bn.residual, IS_END_DATE);

  const variantStreams: { name: string; is: number[]; oos: number[] }[] = [
    { name: 'Q5-Q1_long_short', is: lsSplit.is, oos: lsSplit.oos },
    { name: 'long_only_beta_neutral', is: loBnSplit.is, oos: loBnSplit.oos },
  ];

  const variantIsSharpes = variantStreams.map(v => sharpeNonAnnual(v.is));
  const allVariantIsReturns = variantStreams.map(v => v.is);
  const mTotal = variantStreams.length;

  // Global HLZ rank (1-indexed) across variants by IS t-stat (SR·√(T-1)).
  const ranked = variantStreams
    .map((v, i) => ({ i, t: variantIsSharpes[i] * Math.sqrt(Math.max(1, v.is.length - 1)) }))
    .sort((a, b) => b.t - a.t);
  const rankOf = new Map<number, number>();
  ranked.forEach((r, pos) => rankOf.set(r.i, pos + 1));

  const variants: VariantGateResult[] = variantStreams.map((v, i) =>
    runGatesForVariant(
      v.name, v.is, v.oos, variantIsSharpes, rankOf.get(i)!, mTotal, allVariantIsReturns,
    ),
  );

  return {
    survivorship,
    nRebalances: built.meta.nRebalances,
    nRebalancesWithBothLegs: built.meta.nRebalancesWithBothLegs,
    medianEligibleUniverse: built.meta.medianEligibleUniverse,
    lsDates: built.longShort.dates.length,
    loDates: built.longOnly.dates.length,
    betaNeutralBeta: bn.beta,
    betaNeutralAlphaDaily: bn.alphaDaily,
    betaNeutralN: bn.n,
    variants,
  };
}

// ── Verdict-row mapping + persistence ─────────────────────────────────────────

export function variantToVerdictRow(
  v: VariantGateResult,
  survivorshipSuspect: boolean,
  windowNote: string,
): PhaseBVerdictRow {
  const note =
    `${windowNote} variant=${v.variant}; ` +
    `${survivorshipSuspect ? 'survivorship-suspect (delisted-candle coverage below floor); ' : ''}` +
    `gates: DSR=${v.dsr.status}, PBO=${v.pbo.status}, HLZ=${v.hlz.status}, OOS/IS=${v.oosIs.status}. ` +
    `P0+P1 only (S_inst); macro OFF; insider window=${INSIDER_WINDOW_DAYS}d; ` +
    `liquidity floor pct=${LIQUIDITY_FLOOR_PCT}.`;
  return {
    compositeVersion: COMPOSITE_VERSION,
    benchmark: v.variant, // the "benchmark" key here labels the variant
    bestTrialTheta: 0,     // no θ-sweep in a cross-sectional design
    bestIsSharpe: v.isSharpe,
    bestOosSharpe: v.oosSharpe,
    dsrValue: v.dsr.value,
    dsrPass: v.dsr.status === 'pass',
    pboValue: v.pbo.value,
    pboPass: v.pbo.status === 'pass',
    hlzTStat: v.hlz.value,
    hlzThreshold: v.hlz.threshold,
    hlzPass: v.hlz.status === 'pass',
    oosIsRatio: v.oosIs.value,
    oosIsPass: v.oosIs.status === 'pass',
    verdict: v.verdict,
    // Phase-C eligibility requires pass-all AND PBO<0.2 AND not survivorship-suspect.
    phaseCEligible:
      v.verdict === 'pass-all' &&
      v.pbo.value !== null && v.pbo.value < 0.2 &&
      !survivorshipSuspect,
    notes: note,
  };
}

export async function persistCampaign(
  result: EquityXsCampaignResult,
  windowNote: string,
  ch: ClickHouseClient = getClickHouse(),
): Promise<number> {
  let written = 0;
  for (const v of result.variants) {
    await insertPhaseBVerdict(
      variantToVerdictRow(v, result.survivorship.survivorshipSuspect, windowNote), ch,
    );
    written++;
  }
  return written;
}

// ── Markdown report ───────────────────────────────────────────────────────────

export function renderMarkdownReport(result: EquityXsCampaignResult): string {
  const s = result.survivorship;
  const fmt = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3));
  const lines: string[] = [];
  lines.push('# Phase B campaign — equity_xs_v1 (cross-sectional insider buying, P0+P1)');
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Composite version:** \`${COMPOSITE_VERSION}\``);
  lines.push(`**Scope:** P0 PIT universe + P1 S_inst (insider/13D/short-interest). Macro OFF.`);
  lines.push('');
  lines.push('## Survivorship (spec §3.4 — the binding risk)');
  lines.push('');
  lines.push(`- Ever-members (PIT): **${s.everMembers}**; current: **${s.currentMembers}**; delisted: **${s.delistedNames}**.`);
  lines.push(`- Delisted names WITH candle coverage: **${s.delistedWithCandles}** (${(s.delistedCoveragePct * 100).toFixed(1)}%).`);
  lines.push(`- **survivorship-suspect: ${s.survivorshipSuspect ? 'YES — every verdict below is optimistically biased' : 'no'}**.`);
  lines.push('');
  lines.push('## Portfolio construction');
  lines.push('');
  lines.push(`- Rebalances (monthly): ${result.nRebalances}; with both Q5+Q1 legs: ${result.nRebalancesWithBothLegs}.`);
  lines.push(`- Median eligible universe/day: ${result.medianEligibleUniverse}.`);
  lines.push(`- Long-short daily obs: ${result.lsDates}; long-only daily obs: ${result.loDates}.`);
  lines.push(`- Beta-neutralization (long-only on SPY): β=${fmt(result.betaNeutralBeta)}, α(daily)=${fmt(result.betaNeutralAlphaDaily)}, n=${result.betaNeutralN}.`);
  lines.push('');
  lines.push('## Per-variant deflation verdict');
  lines.push('');
  lines.push('| Variant | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict |');
  lines.push('| --- | ---: | ---: | --- | --- | --- | --- | --- |');
  for (const v of result.variants) {
    const g = (o: GateOutcome) => `${fmt(o.value)} ${o.status}`;
    lines.push(
      `| ${v.variant} | ${fmt(v.isSharpe)} | ${fmt(v.oosSharpe)} | ` +
      `${g(v.dsr)} | ${g(v.pbo)} | ${g(v.hlz)} | ${g(v.oosIs)} | **${v.verdict}** |`,
    );
  }
  lines.push('');
  lines.push('## Honest verdict (anti-shopping per spec §3.2 / ADR-051 §Decision 5)');
  lines.push('');
  const anyPass = result.variants.some(v => v.verdict === 'pass-all');
  if (anyPass && !s.survivorshipSuspect) {
    lines.push('- ≥1 variant PASSED all four gates AND the universe is not survivorship-suspect.');
  } else if (s.survivorshipSuspect) {
    lines.push(
      '- **No trustworthy PASS.** The candle universe is current-membership-biased ' +
      '(delisted names absent), so any apparent edge is optimistically biased; per spec ' +
      '§3.4 every verdict is annotated `survivorship-suspect`. Sourcing delisted-name ' +
      'daily bars (a likely free-data wall) is the prerequisite to a trustworthy verdict.',
    );
  } else {
    lines.push('- No variant passed all four gates. The composite stays informational at Layer-0.');
  }
  lines.push(
    '- **No threshold was relaxed.** A FAIL/insufficient is permanent; an `equity_xs_v2` ' +
    'would need INDEPENDENT a-priori motivation, not a retune (ADR-051 §Decision 5).',
  );
  lines.push('');
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1]?.startsWith('--') ? 'true' : (process.argv[idx + 1] ?? 'true');
  return undefined;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }
  console.log(`Phase B equity_xs_v1 campaign — ${apply ? 'APPLY' : 'DRY-RUN'} (P0+P1)`);
  console.log('');

  const tStart = Date.now();
  const result = await runCampaign();
  const elapsed = Date.now() - tStart;

  const s = result.survivorship;
  console.log('── Survivorship (spec §3.4) ──');
  console.log(`  ever-members=${s.everMembers}, current=${s.currentMembers}, delisted=${s.delistedNames}`);
  console.log(`  delisted with candles=${s.delistedWithCandles} (${(s.delistedCoveragePct * 100).toFixed(1)}%)`);
  console.log(`  survivorship-suspect: ${s.survivorshipSuspect ? 'YES' : 'no'}`);
  console.log('');
  console.log('── Portfolio construction ──');
  console.log(`  rebalances=${result.nRebalances} (both-leg=${result.nRebalancesWithBothLegs}), median eligible univ/day=${result.medianEligibleUniverse}`);
  console.log(`  long-short obs=${result.lsDates}, long-only obs=${result.loDates}`);
  console.log(`  beta-neutral: beta=${result.betaNeutralBeta.toFixed(3)}, alpha/day=${result.betaNeutralAlphaDaily.toExponential(3)}, n=${result.betaNeutralN}`);
  console.log('');
  console.log('── Per-variant deflation verdict ──');
  const fmt = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3));
  for (const v of result.variants) {
    console.log(
      `  ${v.variant}: verdict=${v.verdict}\n` +
      `    IS_SR=${fmt(v.isSharpe)} OOS_SR=${fmt(v.oosSharpe)}\n` +
      `    DSR=${fmt(v.dsr.value)}(${v.dsr.status}) PBO=${fmt(v.pbo.value)}(${v.pbo.status}) ` +
      `HLZ_t=${fmt(v.hlz.value)}(${v.hlz.status}) OOS/IS=${fmt(v.oosIs.value)}(${v.oosIs.status})`,
    );
  }
  console.log('');
  console.log(`  compute completed in ${elapsed}ms`);

  const windowNote = `IS≤${IS_END_DATE} / OOS≥${OOS_START_DATE};`;
  if (apply) {
    console.log('');
    console.log('Persisting verdict rows to CH...');
    const n = await persistCampaign(result, windowNote);
    console.log(`  verdict rows written: ${n}`);
    const reportPath = resolve(process.cwd(), 'docs/analysis/phase-b-equity_xs_v1-deflation-2026-05.md');
    writeFileSync(reportPath, renderMarkdownReport(result), 'utf-8');
    console.log(`  markdown report: ${reportPath}`);
  } else {
    console.log('');
    console.log('(Dry-run — no CH writes, no markdown. Re-run with --apply to persist.)');
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}

/*
 * What could break this:
 * - **Survivorship bias is the headline risk (spec §3.4).** This session's probe
 *   found delisted-candle coverage near 0% — the verdict is correctly flagged
 *   survivorship-suspect and Phase-C eligibility is forced off regardless of gate
 *   outcome. A future delisted-bar ingest (likely a free-data wall) is the fix.
 * - **Insider-data window.** `insider_trades` P-code rows exist only for recent
 *   years; the IS window (2008-2020) therefore carries near-zero S_inst signal,
 *   so the IS leg is dominated by the 13D/SI components (also recent-only) or by
 *   the neutral 0.5 imputation. The honest consequence is a thin/`insufficient`
 *   verdict — NOT something to tune away.
 * - **CSCV PBO needs ≥256 IS bars + ≥2 active variants.** With only M=2 variants
 *   AND short usable history, PBO commonly returns 'na', which makes the verdict
 *   'insufficient' by design — the right behavior, not a bug.
 * - **The monthly-rebalance per-snapshot CH query loops once per month (~220).**
 *   It is read-only and idempotent; on a cold cache the full run is a few minutes.
 * - **token_address suffix convention.** Constituents are `TICKER_SP500`; SPY is
 *   `SPY_USD`. A schema change to that convention would silently empty the price
 *   joins — the survivorship + median-universe diagnostics would show it
 *   immediately (both would collapse to ~0).
 */
