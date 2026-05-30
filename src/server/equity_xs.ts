/**
 * equity_xs — pure cross-sectional equity-alpha harness (P0 + P1).
 *
 * Spec: docs/specs/single-stock-equity-analysis-scoping.md §2 + §3 (P0 universe
 * builder + cross-sectional portfolio construction; P1 = S_inst institutional
 * positioning sub-score).
 *
 * This module is the **pure, I/O-free** core of the `equity_xs_v1` Phase B
 * campaign. The campaign script (`scripts/phase_b_campaign_equity_xs_v1.ts`)
 * does the ClickHouse reads, then feeds plain arrays into these functions, then
 * hands the per-variant return streams to the VERBATIM-reused deflation gates in
 * `src/lib/validator.ts`. Nothing here re-implements DSR/PBO/HLZ/Pardo — those
 * are imported, not forked.
 *
 * THE structural lesson this design encodes (spec §0, §3.3): the four macro
 * Layer-0 composites all came back `partial` because their Sharpe was long-equity
 * BETA, not alpha (DSR/HLZ correctly stripped it). The fix is cross-sectional:
 *   1. The PRIMARY test series is a dollar-neutral long-short (Q5 − Q1) return,
 *      which earns ≈0 for a pure-beta signal because both legs ride the market.
 *   2. The long-only top-quintile series is validated ONLY on its
 *      SPY-beta-neutralized residual (α + ε from r_p = α + β·r_SPY + ε), never on
 *      raw return.
 *
 * Canon:
 *   - López de Prado, AFML (2018) §3 (robust rank labels), §11.3/§11.4 (CSCV/DSR),
 *     §1.6/§3.2 (survivorship/leakage).
 *   - Bailey & López de Prado (2014) "The Deflated Sharpe Ratio" §3 — DSR.
 *   - Bailey-Borwein-LdP-Zhu (2014) "Probability of Backtest Overfitting" §2 — CSCV.
 *   - Harvey-Liu-Zhu (2016) §3-§4.2 — BHY multiple-testing haircut.
 *   - Pardo (2008) §10 — OOS/IS robustness ratio.
 *   - Jegadeesh & Titman (1993) "Returns to Buying Winners…" — 12-1 momentum (P2,
 *     not built here; named for the cross-sectional-anomaly framing only).
 *   - Insider-buying return-predictability literature (Lakonishok & Lee 2001 RFS;
 *     Cohen-Malloy-Pomorski 2012 J.Finance) — the motivation for S_inst. **NOT
 *     re-verified this session; cited only as the spec's prior, NOT as a committed
 *     methodology claim. The harness makes no quantitative claim sourced to them.**
 *
 * Free parameters (spec §2.3 budget ≤ 3): insider window = 90d; liquidity-floor
 * percentile; macro on/off. S_inst alone (P1) uses only the insider window +
 * liquidity floor; macro is OFF in P1.
 */

// ── Free-parameter constants (spec §2.2 / §2.3) ───────────────────────────────

/** Composite version pin (spec §3.2; anti-shopping per ADR-051 §Decision 5). */
export const COMPOSITE_VERSION = 'equity_xs_v1';

/** Trailing window for the net-insider-buy dollar sum (spec §2.2 S_inst). Free param #1. */
export const INSIDER_WINDOW_DAYS = 90;

/**
 * Liquidity-floor percentile (spec §2.1 eligibility filter). Names below this
 * 20-day dollar-volume percentile within the day's universe are dropped — a
 * tradeability gate, NOT a tuned score knob. Free param #2.
 */
export const LIQUIDITY_FLOOR_PCT = 0.10;

/** 20-day ADV lookback for the liquidity gate (canon-fixed, not swept). */
export const ADV_LOOKBACK_DAYS = 20;

/** Quintile cut for the long-short legs (spec §3.1; fixed at 5, not swept). */
export const N_QUANTILES = 5;

/** Backtest window caps (spec §2.1 / §3.5). Equity candles span 2008-01-02→2026. */
export const WINDOW_START_DATE = '2008-01-02';
/** IS/OOS fixed 70/30 split per spec §3.5 + ADR-051 §Decision 3. */
export const IS_END_DATE = '2020-12-31';
export const OOS_START_DATE = '2021-01-01';

/** SPY token-address for beta-neutralization (spec §3.3). */
export const SPY_TOKEN_ADDRESS = 'SPY_USD';

// ── Types ─────────────────────────────────────────────────────────────────────

/** One ticker's eligible-day feature row at a rebalance date. */
export interface TickerFeatureRow {
  ticker: string;
  /** Net trailing-90d insider open-market buy dollars (P $ − S $), by accepted_at. */
  netInsiderBuyUsd: number;
  /** 1 if a 13D/activist filing landed in the trailing window, else 0. */
  activistFlag: number;
  /** Short-interest change_pct (contrarian: falling SI = bullish → we negate at rank time). */
  shortInterestChangePct: number | null;
  /** 20-day average daily dollar-volume (for the liquidity gate). */
  advDollar: number;
}

/** One rebalance date's universe + features. */
export interface RebalanceSnapshot {
  /** Rebalance date 'YYYY-MM-DD' (first trading day of the month). */
  date: string;
  rows: TickerFeatureRow[];
}

/** Daily close series for one ticker, used to compute forward holding returns. */
export interface PriceSeries {
  /** token_address → { dates[], closes[] } ascending. */
  byTicker: Map<string, { dates: string[]; closes: number[] }>;
}

/** The output return streams for one portfolio variant. */
export interface PortfolioReturns {
  /** Trading dates 'YYYY-MM-DD' ascending (intersection of the holding calendar). */
  dates: string[];
  /** Daily portfolio return per date (arithmetic), same length as dates. */
  returns: number[];
}

// ── Rank-normalization (spec §2.2 — scale-free, outlier-robust, AFML §3) ──────

/**
 * Cross-sectional percentile rank in [0, 1] (fractional rank). Ties share the
 * average rank. Empty/singleton → all 0.5 (neutral). NaN/null handled by caller.
 *
 * AFML §3 favors rank labels over z-scores precisely because they are scale-free
 * and outlier-robust — one billionaire insider buy does not blow out the score.
 */
export function rankNormalize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  // Average-rank for ties: sort indices, assign 0..n-1, average over tie-groups,
  // then divide by (n-1) to land in [0,1].
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const rankOf = new Array<number>(n);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && idx[j + 1].v === idx[k].v) j++;
    const avgRank = (k + j) / 2; // 0-indexed average position
    for (let m = k; m <= j; m++) rankOf[idx[m].i] = avgRank;
    k = j + 1;
  }
  return rankOf.map(r => r / (n - 1));
}

// ── S_inst composite sub-score (spec §2.2 — P1) ───────────────────────────────

/**
 * Compute the per-ticker S_inst score for one rebalance snapshot AFTER the
 * liquidity-eligibility gate has been applied.
 *
 * S_inst = cross-sectional rank of an equal-weight rank-of-ranks composite of:
 *   - net trailing-90d insider open-market buying (higher = more bullish),
 *   - 13D/activist flag (1 = bullish),
 *   - short-interest change (CONTRARIAN: falling SI = bullish → we negate the
 *     change before ranking, so a large negative change_pct ranks high).
 *
 * Each sub-component is rank-normalized to [0,1] within the day's eligible
 * universe, the three ranks are averaged equal-weight, then the average is
 * itself rank-normalized to [0,1] (the final cross-sectional rank). Missing
 * short-interest is imputed to the neutral 0.5 rank for that name (not dropped —
 * dropping would shrink the universe and bias toward SI-covered names).
 *
 * Returns scores parallel to `rows`.
 */
export function computeSInst(rows: TickerFeatureRow[]): number[] {
  const n = rows.length;
  if (n === 0) return [];

  const insiderRank = rankNormalize(rows.map(r => r.netInsiderBuyUsd));
  const activistRank = rankNormalize(rows.map(r => r.activistFlag));
  // Contrarian: negate so that a FALLING short interest (negative change_pct)
  // ranks HIGH. Missing SI → neutral; we rank only the present ones and impute
  // 0.5 for the missing.
  const siPresent: { i: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const c = rows[i].shortInterestChangePct;
    if (c !== null && Number.isFinite(c)) siPresent.push({ i, v: -c });
  }
  const siRank = new Array<number>(n).fill(0.5);
  if (siPresent.length > 0) {
    const ranked = rankNormalize(siPresent.map(p => p.v));
    for (let j = 0; j < siPresent.length; j++) siRank[siPresent[j].i] = ranked[j];
  }

  const composite = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    composite[i] = (insiderRank[i] + activistRank[i] + siRank[i]) / 3;
  }
  return rankNormalize(composite);
}

// ── Liquidity-eligibility gate (spec §2.1) ────────────────────────────────────

/**
 * Drop names below the LIQUIDITY_FLOOR_PCT percentile of 20-day dollar ADV
 * within the rebalance day's universe. Returns the surviving subset (a new
 * array; input not mutated). A tradeability gate, not a score input.
 */
export function applyLiquidityGate(
  rows: TickerFeatureRow[],
  floorPct: number = LIQUIDITY_FLOOR_PCT,
): TickerFeatureRow[] {
  const n = rows.length;
  if (n === 0) return [];
  const advRanks = rankNormalize(rows.map(r => r.advDollar));
  return rows.filter((_, i) => advRanks[i] >= floorPct);
}

// ── Quintile leg assignment (spec §3.1) ───────────────────────────────────────

/**
 * Assign each scored ticker to a leg for the long-short portfolio.
 *   long  = top quintile (Q5, highest score)
 *   short = bottom quintile (Q1, lowest score)
 * Equal-weight within each leg. Returns the ticker→weight maps for long and
 * short legs. Quintile boundaries by fractional rank: a name with score-rank
 * ≥ 0.8 is long; ≤ 0.2 is short. With < N_QUANTILES eligible names the legs may
 * be empty (the caller treats an empty-leg day as 0 contribution).
 */
export function assignQuintileLegs(
  tickers: string[],
  scores: number[],
): { long: Map<string, number>; short: Map<string, number> } {
  const n = tickers.length;
  const long = new Map<string, number>();
  const short = new Map<string, number>();
  if (n < N_QUANTILES) return { long, short };
  // Rank the scores cross-sectionally to get robust quintile cuts even if
  // scores are already ranks (idempotent).
  const r = rankNormalize(scores);
  const longTickers: string[] = [];
  const shortTickers: string[] = [];
  const hi = 1 - 1 / N_QUANTILES; // 0.8 for quintiles
  const lo = 1 / N_QUANTILES;     // 0.2
  for (let i = 0; i < n; i++) {
    if (r[i] >= hi) longTickers.push(tickers[i]);
    else if (r[i] <= lo) shortTickers.push(tickers[i]);
  }
  if (longTickers.length > 0) {
    const w = 1 / longTickers.length;
    for (const t of longTickers) long.set(t, w);
  }
  if (shortTickers.length > 0) {
    const w = 1 / shortTickers.length;
    for (const t of shortTickers) short.set(t, w);
  }
  return { long, short };
}

// ── Forward daily return per ticker over a holding period ─────────────────────

/**
 * Arithmetic close-to-close daily returns for a ticker between [startDate,
 * endDate) (endDate exclusive — it's the next rebalance date). Returns parallel
 * arrays of trading dates + returns. The first available trading date on/after
 * startDate has no prior in-window close → its return is the close[start]/
 * close[start-1] step IF a prior close exists, else skipped. We compute returns
 * indexed at the END date of each daily step (standard convention).
 */
export function tickerDailyReturns(
  series: { dates: string[]; closes: number[] } | undefined,
  startDate: string,
  endDate: string,
): { dates: string[]; returns: number[] } {
  if (!series) return { dates: [], returns: [] };
  const { dates, closes } = series;
  const out: { dates: string[]; returns: number[] } = { dates: [], returns: [] };
  // Find first index with date >= startDate.
  let i = 0;
  while (i < dates.length && dates[i] < startDate) i++;
  // We need a prior close for the first return; step from i (using close[i-1]→close[i]).
  for (; i < dates.length; i++) {
    if (dates[i] >= endDate) break;
    if (i === 0) continue; // no prior close
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!(prev > 0) || !Number.isFinite(cur) || !(cur > 0)) continue;
    out.dates.push(dates[i]);
    out.returns.push(cur / prev - 1);
  }
  return out;
}

// ── Portfolio assembly across rebalances (spec §3.1) ──────────────────────────

export interface BuildPortfolioOptions {
  snapshots: RebalanceSnapshot[];
  prices: PriceSeries;
  /** token_address suffix appended to a ticker to look up its price series. */
  priceSuffix: string;
  liquidityFloorPct?: number;
}

export interface BuiltPortfolios {
  /** Q5 − Q1 dollar-neutral long-short daily returns (the PRIMARY test series). */
  longShort: PortfolioReturns;
  /** Long-only top-quintile daily returns (validated only beta-neutral). */
  longOnly: PortfolioReturns;
  /** Diagnostics for the report. */
  meta: {
    nRebalances: number;
    nRebalancesWithBothLegs: number;
    medianLongLegSize: number;
    medianShortLegSize: number;
    medianEligibleUniverse: number;
  };
}

/**
 * Build the long-short (Q5−Q1) and long-only (Q5) daily return streams across
 * all rebalances. For each rebalance the legs are formed from the PRIOR
 * rebalance's score (lagged t-1, no look-ahead per spec §3.1 step 1) and held to
 * the next rebalance. Daily portfolio return = equal-weighted mean of the held
 * names' daily returns.
 *
 * t-1 LAG mechanics: the legs traded over holding period [reb[k], reb[k+1]) are
 * decided by the score computed at reb[k-1]. So the first holding period
 * [reb[1], reb[2]) uses reb[0]'s scores. reb[0] is warm-up only.
 */
export function buildPortfolios(opts: BuildPortfolioOptions): BuiltPortfolios {
  const { snapshots, prices, priceSuffix } = opts;
  const floorPct = opts.liquidityFloorPct ?? LIQUIDITY_FLOOR_PCT;

  // Pre-score each snapshot (post liquidity gate).
  const scored = snapshots.map(s => {
    const elig = applyLiquidityGate(s.rows, floorPct);
    const scores = computeSInst(elig);
    const legs = assignQuintileLegs(elig.map(r => r.ticker), scores);
    return { date: s.date, legs, eligN: elig.length };
  });

  const lsByDate = new Map<string, number>();
  const loByDate = new Map<string, number>();
  let nBoth = 0;
  const longSizes: number[] = [];
  const shortSizes: number[] = [];
  const eligSizes: number[] = [];
  for (const sc of scored) eligSizes.push(sc.eligN);

  // Holding period k spans [snapshots[k].date, snapshots[k+1].date); legs from
  // snapshots[k-1] (t-1 lag).
  for (let k = 1; k + 1 < snapshots.length; k++) {
    const decision = scored[k - 1];
    const holdStart = snapshots[k].date;
    const holdEnd = snapshots[k + 1].date;
    const { long, short } = decision.legs;
    if (long.size > 0) longSizes.push(long.size);
    if (short.size > 0) shortSizes.push(short.size);
    if (long.size > 0 && short.size > 0) nBoth++;

    // Gather per-ticker daily returns over the holding window, keyed by date.
    const accumulate = (
      legWeights: Map<string, number>,
      target: Map<string, { sum: number; wsum: number }>,
    ) => {
      for (const [ticker, w] of legWeights) {
        const series = prices.byTicker.get(`${ticker}${priceSuffix}`);
        const { dates, returns } = tickerDailyReturns(series, holdStart, holdEnd);
        for (let d = 0; d < dates.length; d++) {
          const e = target.get(dates[d]) ?? { sum: 0, wsum: 0 };
          e.sum += w * returns[d];
          e.wsum += w;
          target.set(dates[d], e);
        }
      }
    };
    const longAcc = new Map<string, { sum: number; wsum: number }>();
    const shortAcc = new Map<string, { sum: number; wsum: number }>();
    accumulate(long, longAcc);
    accumulate(short, shortAcc);

    // Long-only daily return = weighted mean (weights already sum to 1 when all
    // names trade; renormalize by wsum to handle names missing a bar that day).
    for (const [date, e] of longAcc) {
      if (e.wsum <= 0) continue;
      const lo = e.sum / e.wsum;
      loByDate.set(date, lo);
    }
    // Long-short = longLeg − shortLeg (dollar-neutral). A date present in only
    // one leg contributes that leg's return minus 0 for the missing leg — but
    // that breaks dollar-neutrality, so we require BOTH legs present that day.
    for (const [date, le] of longAcc) {
      const se = shortAcc.get(date);
      if (!se || le.wsum <= 0 || se.wsum <= 0) continue;
      const longR = le.sum / le.wsum;
      const shortR = se.sum / se.wsum;
      lsByDate.set(date, longR - shortR);
    }
  }

  const toSorted = (m: Map<string, number>): PortfolioReturns => {
    const dates = [...m.keys()].sort();
    return { dates, returns: dates.map(d => m.get(d)!) };
  };

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const v = [...xs].sort((a, b) => a - b);
    const n = v.length;
    return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
  };

  return {
    longShort: toSorted(lsByDate),
    longOnly: toSorted(loByDate),
    meta: {
      nRebalances: snapshots.length,
      nRebalancesWithBothLegs: nBoth,
      medianLongLegSize: median(longSizes),
      medianShortLegSize: median(shortSizes),
      medianEligibleUniverse: median(eligSizes),
    },
  };
}

// ── Beta-neutralization (spec §3.3 — the explicit alpha test) ─────────────────

/**
 * Regress a portfolio daily excess return on SPY daily excess return:
 *   r_p = α + β·r_SPY + ε
 * Return the RESIDUAL alpha stream (α + ε) aligned to the shared dates. The
 * Sharpe of THIS stream — not of r_p — is fed to DSR/HLZ (spec §3.3 point 2). A
 * signal whose return is pure beta has α≈0 and a residual stream with ≈0 mean →
 * fails DSR exactly as it should.
 *
 * Single-factor CAPM-style neutralization (v1); FF multi-factor is a v2 move
 * (spec §7). Excess return uses a zero risk-free proxy (daily rf ≈ 0 over the
 * window is immaterial to the residual's mean/vol — the regression absorbs any
 * constant into α). OLS via closed-form (no library dep; mirrors the project's
 * preference for transparent small-N math).
 *
 * Returns the residual stream + the fitted α (daily) and β for the report.
 */
export function betaNeutralize(
  portfolio: PortfolioReturns,
  spy: { dates: string[]; returns: number[] },
): { residual: PortfolioReturns; alphaDaily: number; beta: number; n: number } {
  // Align on shared dates.
  const spyByDate = new Map<string, number>();
  for (let i = 0; i < spy.dates.length; i++) spyByDate.set(spy.dates[i], spy.returns[i]);
  const xs: number[] = []; // SPY
  const ys: number[] = []; // portfolio
  const dates: string[] = [];
  for (let i = 0; i < portfolio.dates.length; i++) {
    const m = spyByDate.get(portfolio.dates[i]);
    if (m === undefined || !Number.isFinite(m)) continue;
    xs.push(m);
    ys.push(portfolio.returns[i]);
    dates.push(portfolio.dates[i]);
  }
  const n = xs.length;
  if (n < 2) {
    return { residual: { dates, returns: [...ys] }, alphaDaily: 0, beta: 0, n };
  }
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  const beta = sxx === 0 ? 0 : sxy / sxx;
  const alpha = my - beta * mx;
  // Residual stream = α + ε = y - β·x  (keeps the intercept α in the stream so
  // its Sharpe reflects the alpha level, per spec §3.3 "α + ε").
  const residual = ys.map((y, i) => y - beta * xs[i]);
  return { residual: { dates, returns: residual }, alphaDaily: alpha, beta, n };
}

/*
 * What could break this:
 * - **Survivorship (the binding risk per spec §3.4).** If the price universe is
 *   current-membership-biased (delisted names absent from `candles`), the
 *   long-short result is optimistically biased and the verdict MUST be annotated
 *   `survivorship-suspect`. This module computes correctly on whatever universe
 *   it's handed; it cannot detect the bias — the campaign script measures
 *   delisted-candle coverage and sets the annotation.
 * - **Insider-data window.** S_inst is only as good as `insider_trades` coverage.
 *   If P-code rows exist only for recent years, the IS window (2008-2020) carries
 *   near-zero signal and the gates will (correctly) return `insufficient`/fail.
 *   That is an honest data-wall verdict, NOT something to paper over.
 * - **Empty-leg days.** When < N_QUANTILES names are eligible, both legs are
 *   empty and the day contributes nothing. A long stretch of empty days shrinks
 *   the effective sample below CSCV's 256-bar floor → PBO returns `na` honestly.
 * - **Beta-neutralization with tiny n.** OLS with n<2 returns a passthrough; the
 *   campaign reports n so a degenerate fit is visible, not silent.
 * - **Rank ties.** Average-rank handling keeps the [0,1] mapping monotone; a
 *   day where every score is identical maps all to 0.5 → empty legs → 0
 *   contribution (correct: no cross-sectional dispersion = no signal that day).
 */
