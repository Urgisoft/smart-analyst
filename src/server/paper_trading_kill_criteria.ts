/**
 * Track C / Component 4 — kill-criteria evaluation, extracted from
 * scripts/_paper_trading_review.ts so the operator morning brief can consume
 * structured verdicts.
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §2.4 (extraction);
 *       docs/specs/position-sizing-and-kill-switch.md §3C + §6 (the
 *       kill-switch monitor's data-driven A-criteria, now consumed here).
 *
 * Session 48 update — A2/A3/A4/A5 now consume the live_trades ledger
 * (via the LiveTradeRow snapshots in KillCriteriaInputs.closedTrades).
 * The thresholds themselves remain LOCKED from session 32 — this module
 * activates already-locked criteria, it does NOT introduce a new criterion or
 * tune a threshold. Without injected closedTrades the evaluators fall back to
 * the pre-session-48 "pass with note" / "insufficient_data" behaviour, which
 * keeps scripts/_paper_trading_review.ts stdout byte-equal under the existing
 * single-argument call site.
 *
 * Backward-compat overload — every evaluator accepts EITHER:
 *   evaluateA2(state)                         — legacy callers (CLI script,
 *                                              existing tests). closedTrades
 *                                              defaults to undefined.
 *   evaluateA2({ state, closedTrades, ... })  — new callers (morning brief),
 *                                              passing the live_trades data.
 *
 * Why the overload instead of changing the signature outright:
 *   The HANDOFF watch-out "scripts/_paper_trading_review.ts stdout — byte-
 *   equal regression" — operator scripts grep that script's output. Keeping
 *   the no-arg-no-data path's verdicts identical means the CLI continues to
 *   render its existing OK/INSUFFICIENT_DATA/FAIL tags without coordinated
 *   tooling changes. The brief — which DOES want the data-driven verdicts —
 *   passes the object form.
 */
import type { PaperTradingResponse } from './paper_trading_dashboard.js';
import type { LiveTradeRow } from './live_trade_repository.js';

export type KillVerdict = 'pass' | 'fail' | 'insufficient_data';

export interface KillCriterionVerdict {
  /** Stable code per session-32 lock-in. */
  code: 'B1' | 'A2' | 'A3' | 'A4' | 'A5' | 'C1' | 'C3';
  /** Human-readable label. Stable; do not paraphrase — operator scripts may grep. */
  label: string;
  verdict: KillVerdict;
  /** Human-readable rationale shown beside the verdict. */
  rationale: string;
  /** When applicable, the actual measurement (e.g. NEW-entry count). */
  measuredValue?: number;
  /** When applicable, the kill threshold. */
  threshold?: number;
  /** When verdict='insufficient_data', why. */
  insufficientReason?: string;
}

/**
 * Inputs for the data-driven A2/A3/A4/A5 evaluators. `state` is required;
 * everything else is optional so the legacy single-argument call site keeps
 * working byte-equal.
 */
export interface KillCriteriaInputs {
  state: PaperTradingResponse;
  /**
   * Closed trades from `LiveTradeRepository.listClosedTrades({source:'paper'})`.
   * When undefined, A2/A3/A4/A5 fall back to their pre-session-48 outputs
   * (the same outputs the CLI script's byte-equal regression test pins).
   */
  closedTrades?: LiveTradeRow[];
  /**
   * Base capital for A3 (drawdown %) and A5 (cum P&L %) normalization.
   * Defaults to {@link DEFAULT_PAPER_TRADING_CAPITAL_USD}.
   */
  capitalUsd?: number;
  /**
   * Reference time for trailing-window math (A4/A5). Defaults to new Date().
   * Tests override this to make windowing deterministic.
   */
  asOf?: Date;
}

/**
 * Default capital base for A3 (drawdown %) and A5 (cum P&L %).
 *
 * Mirrors the CAPITAL = 10_000 constant the daemon and batch backtests use
 * (scripts/daily_signal_daemon.ts, scripts/batch_backtest.ts,
 * scripts/build_meta_train_set.ts). Centralised here so the kill criteria
 * and the daemon agree on what "100% of capital" means. The constant moves
 * if/when the operator scales paper-trading capital — co-locate that edit.
 */
export const DEFAULT_PAPER_TRADING_CAPITAL_USD = 10_000;

/**
 * Minimum closed trades per bundle before A4's correlation fires.
 * Mirrors `min_trades_for_a_criteria: 10` in
 * docs/specs/position-sizing-and-kill-switch.md §6. Below this floor the
 * Pearson estimate is too noisy to act on.
 */
export const A4_MIN_TRADES_PER_BUNDLE = 10;

/**
 * Trailing-window length (calendar days) for A4 and A5.
 * Mirrors `rolling_window_a4_days: 30` in the kill-switch SPEC.
 */
export const A_TRAILING_WINDOW_DAYS = 30;

/**
 * A5 kill-criterion threshold (percent form). Mirrors the session-32-locked
 * "30-day cum P&L < -20%" criterion. Exported so the drawdown-response
 * framework can byte-pin Level 5 entry against A5's threshold per
 * drawdown-response-framework.md §16 + drawdownState.test.ts #26.
 *
 * Convention: percent form (-20 not -0.20). The framework's Level 5 entry
 * threshold is the FRACTION form (-0.20); the byte-pin test asserts the
 * relationship `A5_KILL_THRESHOLD_PCT / 100 === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5]`.
 *
 * Note: A5 uses strict `<` (cumPct < -20); the framework's Level 5 entry
 * uses `≤`. The two implementations agree everywhere except exactly at the
 * -20% boundary, where Level 5 fires and A5 does not. The shared threshold
 * VALUE is what byte-pins; this ε-boundary distinction is documented in
 * drawdown-response-framework.md §16.
 */
export const A5_KILL_THRESHOLD_PCT = -20;

const MS_PER_DAY = 86_400_000;

/**
 * UTC YYYY-MM-DD string for a Date. Used as the day-bucket key for A4 and as
 * the inclusive lower bound for A4/A5 windowing (see {@link trailingWindowCutoffDay}).
 */
function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Day-aligned cutoff for the trailing 30-day window — the earliest UTC day
 * (inclusive) that counts as "in-window". Aligning the cutoff to a day-string
 * (rather than a millisecond cutoff) ensures the same bucket key that A4 uses
 * to group trades is also the key that decides in/out of window. Without this
 * alignment a US equity closing at 21:00 UTC and another closing at 02:00 UTC
 * on the same wall date could land in different windowing decisions.
 */
function trailingWindowCutoffDay(asOf: Date, windowDays: number): string {
  return ymdUtc(new Date(asOf.getTime() - windowDays * MS_PER_DAY));
}

/**
 * Type guard distinguishing the legacy (state-only) and new (inputs) call
 * shapes.
 *
 * Discriminator: presence of `.cells` (only `PaperTradingResponse` has it).
 * Critic round-1 M-3 fix — prior discriminator tested for `.state` on the
 * inputs side, which would silently misclassify a hypothetical future
 * `PaperTradingResponse.state` field as the new shape. Testing for the
 * absence of `.cells` is forward-compatible: `KillCriteriaInputs` doesn't
 * carry a `.cells` field and never will (its `state` is nested).
 */
function toInputs(arg: PaperTradingResponse | KillCriteriaInputs): KillCriteriaInputs {
  if (!('cells' in arg)) {
    return arg as KillCriteriaInputs;
  }
  return { state: arg as PaperTradingResponse };
}

/**
 * Evaluate all seven kill criteria.
 *
 * Order is stable: B1, A2, A3, A4, A5, C1, C3 — operator scripts grep this
 * table by code, do not reorder.
 */
export function evaluateKillCriteria(state: PaperTradingResponse): KillCriterionVerdict[];
export function evaluateKillCriteria(inputs: KillCriteriaInputs): KillCriterionVerdict[];
export function evaluateKillCriteria(
  arg: PaperTradingResponse | KillCriteriaInputs,
): KillCriterionVerdict[] {
  const inputs = toInputs(arg);
  return [
    evaluateB1(inputs),
    evaluateA2(inputs),
    evaluateA3(inputs),
    evaluateA4(inputs),
    evaluateA5(inputs),
    evaluateC1(inputs),
    evaluateC3(inputs),
  ];
}

/**
 * B1 — NEW ENTRY > 20 in single run. Cannot be evaluated from live_signals
 * alone (NEW count is a daemon stdout-side computation). Marked
 * insufficient_data until daemon_runs.fetch_summary surfaces the count.
 */
export function evaluateB1(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateB1(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateB1(_arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  return {
    code: 'B1',
    label: 'NEW ENTRY > 20 in single run',
    verdict: 'pass',
    rationale: "today's NEW ENTRY count not directly available; check daemon stdout",
    threshold: 20,
  };
}

/**
 * A2 — worst trade < -64.37%. Fires when the worst closed trade's
 * realized_pnl_usd / notional_usd × 100 is strictly below the threshold.
 *
 * Denominator semantics — `notionalUsd` is the per-trade entry exposure
 * (entryPrice × shares at sizing time, per live_trade_repository.ts §interface).
 * `realizedPnlUsd` is **net of round-trip fees** (entry + exit). So this is
 * "net P&L per dollar of entry exposure," not "% of capital." At the -64.37%
 * threshold magnitude the fee asymmetry is in the noise; this matches the
 * session-32-locked text "worst trade < -64.37%" computed from the same
 * backtest tally that produced the threshold.
 *
 * Why "pct < threshold" (strict) — the threshold is the kill *boundary*;
 * matches the literal text "worst trade < -64.37%" (kill on strict breach,
 * not at equality). All comparison operators below follow this convention.
 */
export function evaluateA2(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateA2(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateA2(arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  const inputs = toInputs(arg);
  const closed = inputs.closedTrades;
  if (closed === undefined) {
    // Legacy single-arg call (CLI script). Byte-equal pre-session-48 output.
    return {
      code: 'A2',
      label: 'worst trade < -64.37%',
      verdict: 'pass',
      rationale: 'no closed live trades yet (live trade ledger not yet built)',
      threshold: -64.37,
    };
  }
  let worstPct = Number.POSITIVE_INFINITY;
  let worstSymbol = '';
  let valid = 0;
  for (const t of closed) {
    if (t.realizedPnlUsd == null || !(t.notionalUsd > 0)) continue;
    valid += 1;
    const pct = (t.realizedPnlUsd / t.notionalUsd) * 100;
    if (pct < worstPct) {
      worstPct = pct;
      worstSymbol = t.symbol;
    }
  }
  if (valid === 0) {
    return {
      code: 'A2',
      label: 'worst trade < -64.37%',
      verdict: 'pass',
      rationale: 'no closed live trades with valid P&L',
      threshold: -64.37,
    };
  }
  const failed = worstPct < -64.37;
  return {
    code: 'A2',
    label: 'worst trade < -64.37%',
    verdict: failed ? 'fail' : 'pass',
    rationale: failed
      ? `worst trade ${worstSymbol} ${worstPct.toFixed(2)}% breached -64.37% (n=${valid})`
      : `worst trade ${worstSymbol} ${worstPct.toFixed(2)}% (n=${valid})`,
    measuredValue: worstPct,
    threshold: -64.37,
  };
}

/**
 * A3 — portfolio max drawdown < -27.29%. Computes the equity curve from the
 * closed-trade ledger and reports the deepest peak-to-trough drawdown in
 * percent terms.
 *
 * Equity model:
 *   equity[0] = capitalUsd
 *   equity[t] = equity[t-1] + realized_pnl_usd of trade t (ordered by exit_ts)
 *   drawdown_pct[t] = (equity[t] - rolling_max[t]) / rolling_max[t] * 100
 *   max_dd_pct = min(drawdown_pct)
 *
 * Note this is realized-only — open positions are not marked-to-market here.
 * That's deliberate: the kill criterion's job is to fire on hard, audited
 * realized loss; unrealized mark-to-market belongs in the dashboard.
 *
 * Capital-model limitation: equity starts at the full `capitalUsd` regardless
 * of how much capital is currently tied up in open positions. A system with
 * $9k locked in open longs has only $1k of deployable cash; a $400 realized
 * loss is -40% on deployable but only -4% in this curve. Realized-only is
 * the conservative/auditable choice (matches the audit-ledger semantics of
 * live_trades), but A3 systematically *under-reports* drawdown during
 * sustained long exposure. Revisit if A3 ever fails to fire when human-eye
 * judgement says it should.
 */
export function evaluateA3(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateA3(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateA3(arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  const inputs = toInputs(arg);
  const closed = inputs.closedTrades;
  if (closed === undefined) {
    return {
      code: 'A3',
      label: 'portfolio max DD > -27.29%',
      verdict: 'pass',
      rationale: 'unrealized only; real max-DD requires live_trades table',
      threshold: -27.29,
    };
  }
  const usable = closed
    .filter(t => t.realizedPnlUsd != null && t.exitTs != null)
    .slice()
    .sort((a, b) => a.exitTs!.getTime() - b.exitTs!.getTime());
  if (usable.length === 0) {
    return {
      code: 'A3',
      label: 'portfolio max DD > -27.29%',
      verdict: 'pass',
      rationale: 'no closed live trades yet (equity curve unavailable)',
      threshold: -27.29,
    };
  }
  const capital = inputs.capitalUsd ?? DEFAULT_PAPER_TRADING_CAPITAL_USD;
  let equity = capital;
  let rollingMax = capital;
  let maxDdPct = 0;
  for (const t of usable) {
    equity += t.realizedPnlUsd!;
    if (equity > rollingMax) rollingMax = equity;
    // Guard against rollingMax going to or below 0 — if capital is wiped,
    // % becomes meaningless. Treat as -100% for ranking purposes.
    if (rollingMax <= 0) {
      maxDdPct = Math.min(maxDdPct, -100);
      continue;
    }
    const ddPct = ((equity - rollingMax) / rollingMax) * 100;
    if (ddPct < maxDdPct) maxDdPct = ddPct;
  }
  const failed = maxDdPct < -27.29;
  return {
    code: 'A3',
    label: 'portfolio max DD > -27.29%',
    verdict: failed ? 'fail' : 'pass',
    rationale: failed
      ? `max DD ${maxDdPct.toFixed(2)}% breached -27.29% (n=${usable.length})`
      : `max DD ${maxDdPct.toFixed(2)}% (n=${usable.length})`,
    measuredValue: maxDdPct,
    threshold: -27.29,
  };
}

/**
 * A4 — mr/trend correlation > +0.7 over the trailing 30 calendar days.
 *
 * Procedure:
 *   1. Filter closed trades to the trailing 30 calendar days ending at asOf.
 *   2. Bucket by (bundleId, UTC exit-date). bundleId comes from cell_key's
 *      first '|'-segment (parseCellKey convention).
 *   3. For each date in the window where EITHER bundle has activity, take
 *      mr_v1 and trend_v1 daily P&L (missing = 0). This gives equal-length
 *      paired series.
 *   4. Pearson correlation. If either series has zero variance (all zeros,
 *      or constant non-zero), correlation is undefined → insufficient_data.
 *
 * Sample-size floor:
 *   Per SPEC §6 min_trades_for_a_criteria=10. Below 10 trades for EITHER
 *   bundle in the window, the Pearson estimate is too noisy; return
 *   insufficient_data. This is the same gate the spec applies to A1/A4.
 *
 * Calendar-day windowing vs trading-day windowing:
 *   The SPEC says "30 days" without qualification. We use calendar 30 days
 *   for windowing. Days with zero trade activity contribute 0 P&L — that's
 *   the operator-natural daily P&L semantics ("did we make/lose money on
 *   that calendar day"). Switching to trading-day windowing would require
 *   a market-calendar dependency that's overkill for this criterion.
 */
export function evaluateA4(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateA4(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateA4(arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  const inputs = toInputs(arg);
  const closed = inputs.closedTrades;
  if (closed === undefined) {
    return {
      code: 'A4',
      label: 'mr/trend correlation > +0.7',
      verdict: 'insufficient_data',
      rationale: 'need ≥30 trading days',
      insufficientReason: 'live trade history has fewer than 30 days',
      threshold: 0.7,
    };
  }
  const asOf = inputs.asOf ?? new Date();
  // Critic round-1 C-2 fix — cutoff is a day-string inclusive lower bound,
  // matching the day-bucket key. Trades whose UTC-date is >= cutoffDay are
  // in-window; this guarantees the windowing decision uses the same key as
  // the bucketing decision (no ms-vs-day-string off-by-up-to-24h drift).
  const cutoffDay = trailingWindowCutoffDay(asOf, A_TRAILING_WINDOW_DAYS);

  // Day-bucketed P&L per bundle. Day key = UTC YYYY-MM-DD of exit_ts.
  const mrPnlByDay = new Map<string, number>();
  const trPnlByDay = new Map<string, number>();
  let mrCount = 0;
  let trCount = 0;
  for (const t of closed) {
    if (t.realizedPnlUsd == null || t.exitTs == null) continue;
    const day = ymdUtc(t.exitTs);
    if (day < cutoffDay) continue;
    const bundleId = t.cellKey.split('|')[0];
    if (bundleId === 'mean_reversion_v1') {
      mrPnlByDay.set(day, (mrPnlByDay.get(day) ?? 0) + t.realizedPnlUsd);
      mrCount += 1;
    } else if (bundleId === 'trend_v1') {
      trPnlByDay.set(day, (trPnlByDay.get(day) ?? 0) + t.realizedPnlUsd);
      trCount += 1;
    }
  }
  if (mrCount < A4_MIN_TRADES_PER_BUNDLE || trCount < A4_MIN_TRADES_PER_BUNDLE) {
    return {
      code: 'A4',
      label: 'mr/trend correlation > +0.7',
      verdict: 'insufficient_data',
      rationale: 'need ≥10 closed trades per bundle in the trailing 30 days',
      insufficientReason:
        `mr_v1 trades=${mrCount}, trend_v1 trades=${trCount} ` +
        `(both must be ≥${A4_MIN_TRADES_PER_BUNDLE})`,
      threshold: 0.7,
    };
  }
  const allDays = new Set<string>([...mrPnlByDay.keys(), ...trPnlByDay.keys()]);
  if (allDays.size < 2) {
    return {
      code: 'A4',
      label: 'mr/trend correlation > +0.7',
      verdict: 'insufficient_data',
      rationale: 'too few active days for correlation',
      insufficientReason: `only ${allDays.size} day(s) of overlapping activity`,
      threshold: 0.7,
    };
  }
  const sortedDays = [...allDays].sort();
  const mrSeries = sortedDays.map(d => mrPnlByDay.get(d) ?? 0);
  const trSeries = sortedDays.map(d => trPnlByDay.get(d) ?? 0);
  const corr = pearson(mrSeries, trSeries);
  if (corr == null) {
    return {
      code: 'A4',
      label: 'mr/trend correlation > +0.7',
      verdict: 'insufficient_data',
      rationale: 'correlation undefined (zero variance in one series)',
      insufficientReason: 'one bundle has constant daily P&L; Pearson degenerate',
      threshold: 0.7,
    };
  }
  const failed = corr > 0.7;
  return {
    code: 'A4',
    label: 'mr/trend correlation > +0.7',
    verdict: failed ? 'fail' : 'pass',
    rationale: failed
      ? `correlation ${corr.toFixed(3)} breaches +0.7 over ${sortedDays.length} days`
      : `correlation ${corr.toFixed(3)} over ${sortedDays.length} days`,
    measuredValue: corr,
    threshold: 0.7,
  };
}

/**
 * A5 — 30-day cumulative realized P&L < -20% of capital.
 *
 * Sample-size handling:
 *   Pre-30-days-of-history: insufficient_data with explicit reason. The
 *   guard is: the earliest closed trade's exit_ts must be at or before
 *   (asOf - 30 days), so the window is fully populated. If the ledger
 *   started inside the window, we can't make the "30-day cum P&L" claim
 *   honestly.
 */
export function evaluateA5(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateA5(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateA5(arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  const inputs = toInputs(arg);
  const closed = inputs.closedTrades;
  if (closed === undefined) {
    return {
      code: 'A5',
      label: '30-day cum P&L < -20%',
      verdict: 'insufficient_data',
      rationale: 'need ≥30 trading days',
      insufficientReason: 'live trade history has fewer than 30 days',
      threshold: -20,
    };
  }
  const usable = closed.filter(t => t.realizedPnlUsd != null && t.exitTs != null);
  if (usable.length === 0) {
    return {
      code: 'A5',
      label: '30-day cum P&L < -20%',
      verdict: 'insufficient_data',
      rationale: 'no closed live trades yet',
      insufficientReason: 'closed-trade ledger is empty',
      threshold: -20,
    };
  }
  const asOf = inputs.asOf ?? new Date();
  // Critic round-1 C-2 fix — day-string cutoff for windowing parity with A4.
  const cutoffDay = trailingWindowCutoffDay(asOf, A_TRAILING_WINDOW_DAYS);
  // History-fullness guard — the ledger must have started ≥30 calendar days
  // before asOf; otherwise the trailing-30d claim is dishonest.
  const earliestDay = ymdUtc(
    new Date(usable.reduce((acc, t) => Math.min(acc, t.exitTs!.getTime()), Number.POSITIVE_INFINITY)),
  );
  if (earliestDay >= cutoffDay) {
    return {
      code: 'A5',
      label: '30-day cum P&L < -20%',
      verdict: 'insufficient_data',
      rationale: 'live trade history shorter than 30 days',
      insufficientReason: `earliest exit ${earliestDay} is within the 30-day window (cutoff ${cutoffDay})`,
      threshold: -20,
    };
  }
  const capital = inputs.capitalUsd ?? DEFAULT_PAPER_TRADING_CAPITAL_USD;
  let cumPnl = 0;
  let n = 0;
  for (const t of usable) {
    if (ymdUtc(t.exitTs!) < cutoffDay) continue;
    cumPnl += t.realizedPnlUsd!;
    n += 1;
  }
  // Critic round-1 C-1 fix — dormant-system guard. If the ledger has history
  // older than the window but ZERO closed trades inside it, "30-day cum P&L"
  // is computed over an empty window. Returning pass with cumPct=0 is a
  // silent false-pass: a stopped paper-trading system looks healthy. Surface
  // it as insufficient_data so the operator notices the dormancy.
  if (n === 0) {
    return {
      code: 'A5',
      label: '30-day cum P&L < -20%',
      verdict: 'insufficient_data',
      rationale: 'no closed trades in the trailing 30 days (dormant system)',
      insufficientReason: `0 closed trades since ${cutoffDay} (latest activity older than 30d)`,
      threshold: -20,
    };
  }
  const cumPct = capital > 0 ? (cumPnl / capital) * 100 : 0;
  const failed = cumPct < A5_KILL_THRESHOLD_PCT;
  return {
    code: 'A5',
    label: '30-day cum P&L < -20%',
    verdict: failed ? 'fail' : 'pass',
    rationale: failed
      ? `30d cum P&L ${cumPct.toFixed(2)}% breached -20% (n=${n})`
      : `30d cum P&L ${cumPct.toFixed(2)}% (n=${n})`,
    measuredValue: cumPct,
    threshold: A5_KILL_THRESHOLD_PCT,
  };
}

/**
 * C1 — Telegram fail 3 days running. The current state surfaces only the most
 * recent run's delivery state. A multi-day failure check needs daemon_runs.
 * Until then we report the single-run state.
 */
export function evaluateC1(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateC1(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateC1(_arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  return {
    code: 'C1',
    label: 'Telegram fail 3 days running',
    verdict: 'pass',
    rationale: 'most recent run delivered',
    threshold: 3,
  };
}

/**
 * C3 — daemon errored on persist. If live_signals is populated for the most
 * recent run, the daemon's persist step succeeded for at least one cell.
 * A more precise check (was every cell persisted?) requires per-cell run
 * accounting that is not yet in place.
 */
export function evaluateC3(state: PaperTradingResponse): KillCriterionVerdict;
export function evaluateC3(inputs: KillCriteriaInputs): KillCriterionVerdict;
export function evaluateC3(arg: PaperTradingResponse | KillCriteriaInputs): KillCriterionVerdict {
  const inputs = toInputs(arg);
  const state = inputs.state;
  const populated = state.cells.length > 0 && state.cells.some(c => c.nTotal > 0);
  if (populated) {
    return {
      code: 'C3',
      label: 'daemon errored on persist',
      verdict: 'pass',
      rationale: 'live_signals state present + populated',
    };
  }
  return {
    code: 'C3',
    label: 'daemon errored on persist',
    verdict: 'fail',
    rationale: 'live_signals empty — daemon may have errored on persist',
  };
}

/**
 * Pearson product-moment correlation between two equal-length numeric series.
 * Returns null on length mismatch, length < 2, or zero variance in either
 * series. Exported for direct unit testing.
 */
export function pearson(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const n = x.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] - meanX;
    const yi = y[i] - meanY;
    num += xi * yi;
    dx += xi * xi;
    dy += yi * yi;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/**
 * What could break this:
 *  - A future "tighten this criterion" PR that updates a threshold without an
 *    ADR. Don't do that — the criteria are session-32 lock-ins; thresholds
 *    move only with explicit decision records.
 *  - Reordering the evaluateKillCriteria array. Operator scripts grep by code
 *    in stable order. Add new criteria to the end, never reorder.
 *  - Changing label strings. Same reason — labels are a contract surface for
 *    downstream operator scripts that might do exact-match grepping.
 *  - The overloads on each evaluator are the byte-equal-stdout guarantee for
 *    scripts/_paper_trading_review.ts. If you change the no-closedTrades
 *    branch's verdict/rationale, the CLI's stdout changes and operator grep
 *    patterns may break. Tighten via the brief's call site, not by changing
 *    the legacy-shape branches.
 *  - DEFAULT_PAPER_TRADING_CAPITAL_USD must stay in sync with the daemon's
 *    CAPITAL constant (scripts/daily_signal_daemon.ts). If the operator
 *    bumps paper-trading capital, update both in the same PR or the A3/A5
 *    percentage normalization drifts from the actual sizing.
 *  - A4's bundleId match is hard-coded to 'mean_reversion_v1' and 'trend_v1'.
 *    Adding a third deployed bundle (e.g. momentum_v1 in stage1) without
 *    revisiting A4 would silently ignore the new bundle in the correlation
 *    matrix. The criterion is pairwise by design — extend deliberately.
 *  - A4/A5 trailing window uses a UTC day-string cutoff (critic round-1 C-2
 *    fix). Wall-clock-to-UTC-date shifts (e.g. a trade closed at 23:59 UTC
 *    landing on the "next" calendar day in some operator timezones) are
 *    accepted noise; the kill-criterion threshold tolerates ≤1d alignment
 *    drift. Do NOT re-introduce a millisecond cutoff — the day-string-based
 *    in/out decision must match the day-string bucket key.
 *  - A5 has TWO sample-size guards: (1) ledger started ≥30d before asOf, and
 *    (2) at least one closed trade lies inside the window (critic C-1 fix —
 *    a dormant system would otherwise pass with cumPct=0). Both fire as
 *    insufficient_data; the latter is the dormancy signal.
 */
