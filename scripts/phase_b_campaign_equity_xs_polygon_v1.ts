/**
 * Phase B campaign for `equity_xs_polygon_*` — the SURVIVORSHIP-FREE, CAP-TIER-
 * STRATIFIED re-run of the cross-sectional single-stock S_inst signal.
 *
 * This is the honest re-run of `phase_b_campaign_equity_xs_v1.ts`. Two changes:
 *
 *   (A) PRICE SOURCE: reads `quantlab.equity_daily_polygon` (full US daily cross-
 *       section, survivorship-free BY CONSTRUCTION — delisted names are retained)
 *       instead of `quantlab.candles` (the `_SP500`/`_USD`-suffixed,
 *       survivorship-BIASED source whose delisted coverage was ~0.1%, which is why
 *       `equity_xs_v1` came back `insufficient / survivorship-suspect`). Universe =
 *       every Polygon ticker (the full market), gated by the SAME fixed liquidity
 *       floor. SPY for beta-neutralization is read from Polygon too (consistent
 *       source). Plain Polygon tickers join directly to `insider_trades.issuer_ticker`
 *       / `schedule_13d_g_filings.issuer_ticker` / `short_interest.symbol` (all plain
 *       symbols — verified overlap before relying on the join).
 *
 *   (B) CAP-TIER STRATIFICATION: runs the FULL Q5−Q1 long-short + SPY-beta-neutral
 *       validation SEPARATELY within each fixed dollar-volume tier (mega / large /
 *       mid / small; micro excluded) PLUS a blended all-tier baseline, ranking and
 *       forming Q5−Q1 WITHIN each tier. Rationale (spec §0 + equity_xs.ts cap-tier
 *       header): the insider / cross-sectional anomaly is documented to concentrate
 *       in smaller, less-analyzed names, so a blended test can MASK a small/mid-cap
 *       signal — per-tier verdicts surface it. Each tier persists as a distinct
 *       `composite_version` (`equity_xs_polygon_{mega,large,mid,small,blended}`).
 *
 * WINDOW IS DATA-DRIVEN. Polygon free tier currently covers ~2024-06 → present and a
 * backfill is still filling toward 2026-05. This script reads min(date)/max(date)
 * from `equity_daily_polygon` and splits 70/30 chronologically WITHIN that window —
 * it does NOT reuse the 2008-based IS_END_DATE (which would put 100% of a 2024+ panel
 * in OOS). The window length (~1.5–2yr) is SHORT, so Phase B power is limited — this
 * is reported as a caveat, never hidden, and certainly not tuned around.
 *
 * The four-gate deflation stack (`src/lib/validator.ts`) and the persistence layer
 * (`src/server/phase_b_repository.ts`) are reused VERBATIM. NONE of the gate math,
 * the S_inst score, the portfolio construction, or the beta-neutralization is forked
 * — they are imported from `equity_xs.ts` and `phase_b_campaign_equity_xs_v1.ts`.
 *
 * --dry-run (default): compute + print; NO CH writes.
 * --apply             : also persist per-tier verdict rows + write the markdown report.
 *
 * ANTI-SHOPPING (ADR-051 §Decision 5 / spec §3.2): a FAIL is permanent. No threshold
 * is relaxed and no tier cut is tuned to manufacture a pass. The tier bands are FIXED
 * round dollar-volume thresholds. A FAIL/insufficient per tier is a valid, honest
 * outcome — this is the 7th single-stock validation attempt; the prior six failed.
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
  INSIDER_WINDOW_DAYS,
  LIQUIDITY_FLOOR_PCT,
  ADV_LOOKBACK_DAYS,
  buildPortfolios,
  betaNeutralize,
  bucketSnapshotByTier,
  CAP_TIERS,
  type CapTier,
  type RebalanceSnapshot,
  type TickerFeatureRow,
  type PriceSeries,
} from '../src/server/equity_xs.js';
import {
  runGatesForVariant,
  type VariantGateResult,
} from './phase_b_campaign_equity_xs_v1.js';
import {
  insertPhaseBVerdict,
  type PhaseBVerdictRow,
} from '../src/server/phase_b_repository.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'phase_b:equity_xs_polygon_v1:dry',
    category: 'Data quality',
    what:
      'Dry-run: build the survivorship-free Polygon full-market universe, ' +
      'bucket by fixed cap tier (mega/large/mid/small + blended), compute the ' +
      'within-tier S_inst Q5−Q1 long-short + beta-neutral long-only, run the ' +
      'four-gate deflation stack per tier, print verdicts. NO CH writes.',
  },
  {
    npm: 'phase_b:equity_xs_polygon_v1:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus persist one verdict row per tier to ' +
      'quantlab.phase_b_verdicts (composite_version=equity_xs_polygon_<tier>) ' +
      'and write the markdown report.',
  },
];

/** Polygon price source — plain tickers, NO suffix (unlike candles `_SP500`). */
export const POLYGON_PRICE_SUFFIX = '';
/** SPY in Polygon is the plain symbol (NOT the `SPY_USD` candles token). */
export const POLYGON_SPY_TICKER = 'SPY';
/** Composite-version prefix; tier is appended → `equity_xs_polygon_mega` etc. */
export const POLYGON_COMPOSITE_PREFIX = 'equity_xs_polygon';

/** Fixed 70/30 IS/OOS split fraction (spec §3.5; matches ADR-051 §Decision 3). */
export const IS_FRACTION = 0.70;

// ── Sharpe / moments (same convention as the v1 campaign / validator.ts) ──────

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

/**
 * Chronologically split a date-keyed return stream into IS/OOS at the given
 * cut date (IS = dates ≤ cut, OOS = dates > cut). Pure.
 */
export function splitIsOosAt(
  p: { dates: string[]; returns: number[] },
  isEndDate: string,
): { is: number[]; oos: number[] } {
  const is: number[] = [];
  const oos: number[] = [];
  for (let i = 0; i < p.dates.length; i++) {
    if (p.dates[i] <= isEndDate) is.push(p.returns[i]);
    else oos.push(p.returns[i]);
  }
  return { is, oos };
}

// ── Data-driven window discovery (spec: do NOT hardcode an end) ────────────────

export interface PolygonWindow {
  minDate: string;
  maxDate: string;
  /** The chronological 70/30 IS/OOS cut date (a trading date in the window). */
  isEndDate: string;
  oosStartDate: string;
  nTradingDays: number;
}

/**
 * Read the available Polygon window from `equity_daily_polygon` and derive the
 * 70/30 IS/OOS cut as the trading date at the IS_FRACTION quantile of the
 * distinct trading-date list. This is window-data-driven so the orchestrator's
 * authoritative full-window re-run picks up new data automatically (no hardcoded
 * end date).
 */
export async function loadPolygonWindow(
  ch: ClickHouseClient = getClickHouse(),
): Promise<PolygonWindow> {
  const q = await ch.query({
    query: `
      SELECT toString(date) AS d
      FROM quantlab.equity_daily_polygon
      GROUP BY date
      ORDER BY date ASC
    `,
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string }>();
  const dates = rows.map(r => r.d);
  if (dates.length === 0) {
    return { minDate: '', maxDate: '', isEndDate: '', oosStartDate: '', nTradingDays: 0 };
  }
  // IS = first IS_FRACTION of distinct trading dates; cut at that index.
  const cutIdx = Math.max(0, Math.min(dates.length - 1, Math.floor(dates.length * IS_FRACTION) - 1));
  const isEndDate = dates[cutIdx];
  const oosStartDate = dates[Math.min(dates.length - 1, cutIdx + 1)];
  return {
    minDate: dates[0],
    maxDate: dates[dates.length - 1],
    isEndDate,
    oosStartDate,
    nTradingDays: dates.length,
  };
}

/**
 * Monthly rebalance dates = first trading day of each month present in the
 * Polygon panel within [minDate, maxDate].
 */
export async function loadPolygonRebalanceDates(
  window: PolygonWindow,
  ch: ClickHouseClient = getClickHouse(),
): Promise<string[]> {
  const q = await ch.query({
    query: `
      SELECT toString(min(date)) AS d
      FROM quantlab.equity_daily_polygon
      WHERE date >= {start:Date} AND date <= {end:Date}
      GROUP BY toStartOfMonth(date)
      ORDER BY d ASC
    `,
    query_params: { start: window.minDate, end: window.maxDate },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string }>();
  return rows.map(r => r.d);
}

// ── Matched-universe diagnostic ───────────────────────────────────────────────

export interface MatchedUniverseReport {
  polygonTickers: number;
  insiderTickers: number;
  matchedInsider: number;
  /** Per-tier eligible ticker count (median over rebalances, post liquidity gate). */
  tierCounts: Record<Exclude<CapTier, 'blended'>, number>;
}

/**
 * Count tickers present in BOTH `equity_daily_polygon` and `insider_trades`
 * (the matched universe with both prices and insider features). This is the
 * join-key-overlap sanity check the spec demands.
 */
export async function measureMatchedUniverse(
  ch: ClickHouseClient = getClickHouse(),
): Promise<{ polygonTickers: number; insiderTickers: number; matchedInsider: number }> {
  const q = await ch.query({
    query: `
      WITH
        pol AS (SELECT DISTINCT ticker AS t FROM quantlab.equity_daily_polygon),
        ins AS (SELECT DISTINCT issuer_ticker AS t FROM quantlab.insider_trades WHERE issuer_ticker != '')
      SELECT
        (SELECT count() FROM pol) AS polygon_tickers,
        (SELECT count() FROM ins) AS insider_tickers,
        (SELECT count() FROM ins WHERE t IN (SELECT t FROM pol)) AS matched
    `,
    format: 'JSONEachRow',
  });
  const [row] = await q.json<{ polygon_tickers: string | number; insider_tickers: string | number; matched: string | number }>();
  return {
    polygonTickers: Number(row.polygon_tickers),
    insiderTickers: Number(row.insider_tickers),
    matchedInsider: Number(row.matched),
  };
}

// ── PIT universe + feature builder over the Polygon panel (full market) ────────

/**
 * Build the per-rebalance universe + S_inst features over the SURVIVORSHIP-FREE
 * Polygon panel. For each rebalance date:
 *   - universe = every Polygon ticker with a bar in the trailing ADV window
 *     (NO sp500_history filter — the full market, survivorship-free).
 *   - net trailing-90d insider buy $ (P − S, by accepted_at).
 *   - 13D/activist flag (any filing in the trailing window).
 *   - short-interest change_pct (latest ≤ rebalance).
 *   - 20-day ADV dollar (from Polygon close×volume, trailing ADV_LOOKBACK_DAYS).
 * The liquidity gate + the cap-tier partition both key off `advDollar`.
 */
export async function buildPolygonSnapshots(
  rebalanceDates: string[],
  ch: ClickHouseClient = getClickHouse(),
): Promise<RebalanceSnapshot[]> {
  const snapshots: RebalanceSnapshot[] = [];
  for (const date of rebalanceDates) {
    const q = await ch.query({
      query: `
        WITH
        adv AS (
          SELECT ticker, avg(close * volume) AS adv_dollar
          FROM (
            SELECT ticker, close, volume, date
            FROM quantlab.equity_daily_polygon
            WHERE date < {reb:Date}
            ORDER BY ticker, date DESC
            LIMIT {adv:UInt32} BY ticker
          )
          GROUP BY ticker
          HAVING adv_dollar > 0
        ),
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
        )
        SELECT adv.ticker AS ticker,
               ifNull(i.net_buy, 0) AS net_buy,
               ifNull(a.flag, 0) AS activist_flag,
               s.chg AS si_change,
               adv.adv_dollar AS adv_dollar
        FROM adv
        LEFT JOIN insider i ON adv.ticker = i.ticker
        LEFT JOIN activist a ON adv.ticker = a.ticker
        LEFT JOIN si s ON adv.ticker = s.ticker
      `,
      query_params: {
        reb: date,
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

/**
 * Load daily closes for every Polygon ticker + SPY into a PriceSeries (plain
 * ticker keys, no suffix). SPY daily arithmetic returns are derived from the
 * SAME Polygon source for consistent beta-neutralization.
 */
export async function loadPolygonPrices(
  window: PolygonWindow,
  ch: ClickHouseClient = getClickHouse(),
): Promise<{ prices: PriceSeries; spy: { dates: string[]; returns: number[] } }> {
  const q = await ch.query({
    query: `
      SELECT ticker AS ta, toString(date) AS d, close
      FROM quantlab.equity_daily_polygon
      WHERE date >= {start:Date} AND date <= {end:Date}
      ORDER BY ticker ASC, d ASC
    `,
    query_params: { start: window.minDate, end: window.maxDate },
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
  const spyRaw = byTicker.get(POLYGON_SPY_TICKER);
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

// ── Per-tier campaign ─────────────────────────────────────────────────────────

export interface TierResult {
  tier: CapTier;
  /** Median eligible (post-liquidity-gate) universe size within the tier. */
  medianEligibleUniverse: number;
  nRebalancesWithBothLegs: number;
  lsDates: number;
  loDates: number;
  betaNeutralBeta: number;
  betaNeutralAlphaDaily: number;
  betaNeutralN: number;
  variants: VariantGateResult[];
}

export interface PolygonCampaignResult {
  window: PolygonWindow;
  matched: { polygonTickers: number; insiderTickers: number; matchedInsider: number };
  tiers: TierResult[];
}

/**
 * Run the within-tier (or blended) Q5−Q1 + beta-neutral long-only validation for
 * one set of per-rebalance snapshots. Mirrors the v1 campaign's variant logic
 * exactly, only the input snapshots differ (a tier slice vs the full universe).
 */
export function runTier(
  tier: CapTier,
  snapshots: RebalanceSnapshot[],
  prices: PriceSeries,
  spy: { dates: string[]; returns: number[] },
  isEndDate: string,
): TierResult {
  const built = buildPortfolios({ snapshots, prices, priceSuffix: POLYGON_PRICE_SUFFIX });
  const bn = betaNeutralize(built.longOnly, spy);

  const lsSplit = splitIsOosAt(built.longShort, isEndDate);
  const loBnSplit = splitIsOosAt(bn.residual, isEndDate);

  const variantStreams: { name: string; is: number[]; oos: number[] }[] = [
    { name: 'Q5-Q1_long_short', is: lsSplit.is, oos: lsSplit.oos },
    { name: 'long_only_beta_neutral', is: loBnSplit.is, oos: loBnSplit.oos },
  ];

  const variantIsSharpes = variantStreams.map(v => sharpeNonAnnual(v.is));
  const allVariantIsReturns = variantStreams.map(v => v.is);
  const mTotal = variantStreams.length;

  const ranked = variantStreams
    .map((v, i) => ({ i, t: variantIsSharpes[i] * Math.sqrt(Math.max(1, v.is.length - 1)) }))
    .sort((a, b) => b.t - a.t);
  const rankOf = new Map<number, number>();
  ranked.forEach((r, pos) => rankOf.set(r.i, pos + 1));

  const variants = variantStreams.map((v, i) =>
    runGatesForVariant(
      v.name, v.is, v.oos, variantIsSharpes, rankOf.get(i)!, mTotal, allVariantIsReturns,
    ),
  );

  return {
    tier,
    medianEligibleUniverse: built.meta.medianEligibleUniverse,
    nRebalancesWithBothLegs: built.meta.nRebalancesWithBothLegs,
    lsDates: built.longShort.dates.length,
    loDates: built.longOnly.dates.length,
    betaNeutralBeta: bn.beta,
    betaNeutralAlphaDaily: bn.alphaDaily,
    betaNeutralN: bn.n,
    variants,
  };
}

export async function runPolygonCampaign(
  ch: ClickHouseClient = getClickHouse(),
): Promise<PolygonCampaignResult> {
  const window = await loadPolygonWindow(ch);
  const matched = await measureMatchedUniverse(ch);
  const rebalanceDates = await loadPolygonRebalanceDates(window, ch);
  const snapshots = await buildPolygonSnapshots(rebalanceDates, ch);
  const { prices, spy } = await loadPolygonPrices(window, ch);

  const tiers: TierResult[] = [];

  // Per-tier: bucket each snapshot, then run the within-tier portfolio. A tier's
  // snapshot for a given rebalance is the subset of that rebalance's rows whose
  // advDollar falls in the tier's fixed band.
  for (const tier of CAP_TIERS) {
    const tierSnapshots: RebalanceSnapshot[] = snapshots.map(s => {
      const buckets = bucketSnapshotByTier(s);
      return buckets.get(tier)!;
    });
    tiers.push(runTier(tier, tierSnapshots, prices, spy, window.isEndDate));
  }

  // Blended baseline: the full universe, micro names still dropped (so the
  // blended test is over the same tradeable set as the union of the four tiers).
  const blendedSnapshots: RebalanceSnapshot[] = snapshots.map(s => {
    const buckets = bucketSnapshotByTier(s);
    const rows: TickerFeatureRow[] = [];
    for (const t of CAP_TIERS) rows.push(...buckets.get(t)!.rows);
    return { date: s.date, rows };
  });
  tiers.push(runTier('blended', blendedSnapshots, prices, spy, window.isEndDate));

  return { window, matched, tiers };
}

// ── Verdict-row mapping + persistence (one composite_version per tier) ─────────

export function tierVariantToVerdictRow(
  tier: CapTier,
  v: VariantGateResult,
  window: PolygonWindow,
): PhaseBVerdictRow {
  const note =
    `survivorship-FREE (equity_daily_polygon); cap-tier=${tier}; ` +
    `window=${window.minDate}..${window.maxDate} (${window.nTradingDays}d, ~${(window.nTradingDays / 252).toFixed(1)}yr — ` +
    `SHORT: Phase B power limited); IS≤${window.isEndDate}/OOS≥${window.oosStartDate}; ` +
    `variant=${v.variant}; gates: DSR=${v.dsr.status}, PBO=${v.pbo.status}, HLZ=${v.hlz.status}, OOS/IS=${v.oosIs.status}. ` +
    `S_inst only; macro OFF; insider window=${INSIDER_WINDOW_DAYS}d; liquidity floor pct=${LIQUIDITY_FLOOR_PCT}; ` +
    `tier bands FIXED (not tuned).`;
  return {
    compositeVersion: `${POLYGON_COMPOSITE_PREFIX}_${tier}`,
    benchmark: v.variant,
    bestTrialTheta: 0,
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
    // Survivorship-free now → no survivorship-suspect gate. Phase-C eligibility =
    // pass-all AND PBO<0.2 (per spec §3.2; same bar as the macro composites).
    phaseCEligible:
      v.verdict === 'pass-all' && v.pbo.value !== null && v.pbo.value < 0.2,
    notes: note,
  };
}

export async function persistPolygonCampaign(
  result: PolygonCampaignResult,
  ch: ClickHouseClient = getClickHouse(),
): Promise<number> {
  let written = 0;
  for (const t of result.tiers) {
    for (const v of t.variants) {
      await insertPhaseBVerdict(tierVariantToVerdictRow(t.tier, v, result.window), ch);
      written++;
    }
  }
  return written;
}

// ── Markdown report ───────────────────────────────────────────────────────────

export function renderPolygonReport(result: PolygonCampaignResult): string {
  const fmt = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3));
  const w = result.window;
  const lines: string[] = [];
  lines.push('# Phase B campaign — equity_xs_polygon_* (survivorship-FREE, cap-tier stratified)');
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Price source:** \`quantlab.equity_daily_polygon\` — survivorship-FREE full US daily cross-section.`);
  lines.push(`**Window (data-driven):** ${w.minDate} → ${w.maxDate} (${w.nTradingDays} trading days, ~${(w.nTradingDays / 252).toFixed(1)}yr).`);
  lines.push(`**IS/OOS (70/30):** IS ≤ ${w.isEndDate} / OOS ≥ ${w.oosStartDate}.`);
  lines.push('');
  lines.push('> **Window-length caveat (NOT hidden):** ~1.5–2yr is SHORT for Phase B. CSCV/DSR power is limited; '
    + 'an `insufficient` here is an honest data-thinness verdict, not a pass and not a fail to tune around.');
  lines.push('');
  lines.push('## Matched universe (join-key overlap)');
  lines.push('');
  lines.push(`- Polygon tickers: **${result.matched.polygonTickers}**; insider_trades tickers: **${result.matched.insiderTickers}**.`);
  lines.push(`- Matched (both Polygon prices AND insider data): **${result.matched.matchedInsider}**.`);
  lines.push('');
  lines.push('## Per-tier deflation verdict (within-tier Q5−Q1 + beta-neutral long-only)');
  lines.push('');
  lines.push('Tier bands (FIXED daily $-volume, not tuned): mega ≥ $1B/d · large $100M–1B · mid $10–100M · small $1–10M · micro <$1M EXCLUDED.');
  lines.push('');
  lines.push('| Tier | Median univ/day | Variant | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | Phase-C |');
  lines.push('| --- | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |');
  for (const t of result.tiers) {
    for (const v of t.variants) {
      const g = (o: VariantGateResult['dsr']) => `${fmt(o.value)} ${o.status}`;
      const pc = v.verdict === 'pass-all' && v.pbo.value !== null && v.pbo.value < 0.2 ? 'YES' : 'no';
      lines.push(
        `| ${t.tier} | ${t.medianEligibleUniverse} | ${v.variant} | ${fmt(v.isSharpe)} | ${fmt(v.oosSharpe)} | ` +
        `${g(v.dsr)} | ${g(v.pbo)} | ${g(v.hlz)} | ${g(v.oosIs)} | **${v.verdict}** | ${pc} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Beta-vs-alpha read (per tier, long-only neutralization)');
  lines.push('');
  lines.push('| Tier | β (long-only on SPY) | α/day | n | Read |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const t of result.tiers) {
    const read = t.betaNeutralAlphaDaily > 0 && t.variants.some(v => v.variant === 'long_only_beta_neutral' && v.dsr.status === 'pass')
      ? 'residual α clears DSR — possible alpha'
      : 'residual α does NOT clear DSR — beta/noise';
    lines.push(`| ${t.tier} | ${fmt(t.betaNeutralBeta)} | ${t.betaNeutralAlphaDaily.toExponential(2)} | ${t.betaNeutralN} | ${read} |`);
  }
  lines.push('');
  lines.push('## Honest verdict (anti-shopping per spec §3.2 / ADR-051 §Decision 5)');
  lines.push('');
  const anyPass = result.tiers.some(t => t.variants.some(v => v.verdict === 'pass-all'));
  if (anyPass) {
    lines.push('- ≥1 tier×variant PASSED all four gates on the survivorship-FREE panel. '
      + 'Given the SHORT window, treat a single pass as a hypothesis worth a deeper (paid-history) test, NOT a green light.');
  } else {
    lines.push('- **No tier passed all four gates.** On a survivorship-free panel, the cross-sectional '
      + 'single-stock S_inst signal does not clear the deflation bar in any cap tier on this window. '
      + 'Consistent with the 6 prior Layer-0 nulls — this is the 7th. A FAIL/insufficient is HONEST and FINAL.');
  }
  lines.push('- **No threshold was relaxed; no tier band was tuned.** The bands are fixed round $-volume cuts. '
    + 'An `equity_xs_polygon_v2` would need INDEPENDENT a-priori motivation, not a retune (ADR-051 §Decision 5).');
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
  console.log(`Phase B equity_xs_polygon campaign — ${apply ? 'APPLY' : 'DRY-RUN'} (survivorship-free, cap-tier)`);
  console.log('');

  const tStart = Date.now();
  const result = await runPolygonCampaign();
  const elapsed = Date.now() - tStart;

  const w = result.window;
  console.log('── Window (data-driven) ──');
  console.log(`  ${w.minDate} → ${w.maxDate} (${w.nTradingDays} trading days, ~${(w.nTradingDays / 252).toFixed(1)}yr)`);
  console.log(`  IS ≤ ${w.isEndDate} / OOS ≥ ${w.oosStartDate}`);
  console.log('');
  console.log('── Matched universe ──');
  console.log(`  polygon=${result.matched.polygonTickers} insider=${result.matched.insiderTickers} matched=${result.matched.matchedInsider}`);
  console.log('');
  const fmt = (x: number | null) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3));
  for (const t of result.tiers) {
    console.log(`── tier=${t.tier} (median univ/day=${t.medianEligibleUniverse}, both-leg rebal=${t.nRebalancesWithBothLegs}, LS obs=${t.lsDates}) ──`);
    console.log(`   beta-neutral: beta=${fmt(t.betaNeutralBeta)} alpha/day=${t.betaNeutralAlphaDaily.toExponential(3)} n=${t.betaNeutralN}`);
    for (const v of t.variants) {
      console.log(
        `   ${v.variant}: verdict=${v.verdict} | IS_SR=${fmt(v.isSharpe)} OOS_SR=${fmt(v.oosSharpe)} | ` +
        `DSR=${fmt(v.dsr.value)}(${v.dsr.status}) PBO=${fmt(v.pbo.value)}(${v.pbo.status}) ` +
        `HLZ_t=${fmt(v.hlz.value)}(${v.hlz.status}) OOS/IS=${fmt(v.oosIs.value)}(${v.oosIs.status})`,
      );
    }
  }
  console.log('');
  console.log(`  compute completed in ${elapsed}ms`);

  if (apply) {
    console.log('');
    console.log('Persisting per-tier verdict rows to CH...');
    const n = await persistPolygonCampaign(result);
    console.log(`  verdict rows written: ${n}`);
    const reportPath = resolve(process.cwd(), 'docs/analysis/phase-b-equity_xs_polygon_v1-deflation-2026-05.md');
    writeFileSync(reportPath, renderPolygonReport(result), 'utf-8');
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
 * - **Short window (the headline caveat).** Polygon free tier ≈ 2024-06→present
 *   (~1.5–2yr). CSCV PBO needs ≥256 IS bars; a 70/30 split of ~500 trading days
 *   gives ~350 IS bars — just over the floor, so PBO can run, but the trial power
 *   is thin. An `insufficient` (PBO 'na') is the honest outcome, not a bug.
 * - **Tier flicker.** A name near a band edge can change tier rebalance-to-
 *   rebalance. Using 20-day ADV (not a single session) as the partition key
 *   minimizes this; it cannot eliminate it. Tier membership is recomputed each
 *   rebalance (PIT-correct), so a name that grew into mega is treated as mega from
 *   that rebalance on — this is correct, not leakage.
 * - **Small/mid tiers may have thin both-leg coverage.** If a tier has < 5
 *   eligible names on most rebalances, its Q5−Q1 legs are empty → 0-contribution
 *   days → an honest `insufficient`. The median-universe diagnostic surfaces this.
 * - **Join-key mismatch.** Polygon uses plain tickers; insider_trades has some
 *   dirty symbols (quotes/parens) that simply won't join (LEFT JOIN → net_buy=0,
 *   a neutral S_inst contribution, not an error). The matched-universe diagnostic
 *   reports the real overlap so a silent join collapse would be visible.
 * - **No SPY in Polygon would empty beta-neutralization.** SPY is the plain
 *   `SPY` ticker here (NOT the candles `SPY_USD`); betaNeutralN would collapse to
 *   ~0 if absent — visible in the per-tier beta-neutral n.
 * - **Survivorship is NO LONGER the binding risk** (the whole point of this
 *   re-run): the Polygon panel retains delisted names by construction, so the
 *   long-short is not optimistically biased the way the candles run was.
 */
