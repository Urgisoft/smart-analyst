/**
 * Fee model for live + paper equity execution.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §3.1 unit 3, §5 contracts,
 *       §7 watch-out #2 (fee schedule changes annually).
 *
 * Purpose:
 *   Replace the hardcoded `0.5%` fee reserve in src/lib/risk.ts (sizer)
 *   and the `feesUsd: 0` stub at src/server/daemon_live_trades.ts:232.
 *   Both the sizer (pre-trade reserve) and the live_trade recorder
 *   (post-trade actual) consume the same quote from this module so paper
 *   and live stay fee-symmetric.
 *
 * Scope:
 *   Equity venue ('alpaca' and 'paper') only. Crypto branch is an
 *   explicit throw — kept loud so silent fall-through cannot smuggle a
 *   crypto strategy into the equity fee path when the crypto adapter
 *   ships later.
 *
 * Fee schedule sourcing (2026-05):
 *   The numeric values in `ALPACA_EQUITY_FEE_SCHEDULE` are documented
 *   constants taken from Alpaca's "Fees and Charges" docs page as of
 *   2026-05. They are derived from US regulatory fee schedules (SEC
 *   Section 31, FINRA TAF) which the broker passes through unchanged.
 *   Re-verify annually — these change. SPEC §7 item 2.
 */

/** Supported venues this module knows the fee math for. */
export type FeeVenue = 'alpaca' | 'paper';

export interface FeeQuoteInput {
  /** Which venue's fee schedule to apply. */
  venue: FeeVenue;
  /** 'buy' is fee-free on equities; 'sell' triggers regulatory fees. */
  side: 'buy' | 'sell';
  /**
   * Notional dollar amount of the order (price × shares). Must be > 0.
   * SEC fee scales with notional (sells only).
   */
  notionalUsd: number;
  /**
   * Whole-share quantity. Must be > 0. Phase A is whole-shares-only per
   * SPEC §7 item 5 — fractional handling is deferred to Phase B.1.
   * TAF (FINRA) scales with share count (sells only).
   */
  shares: number;
}

export interface FeeQuote {
  /** Total fees, summed across all components, in USD. */
  feeUsd: number;
  /**
   * TAF component (FINRA Trading Activity Fee) — per-share, sells only.
   * Surfaced separately so the sizer can attribute caps correctly.
   */
  perShareUsd: number;
  /**
   * SEC Section 31 transaction fee — per-notional, sells only.
   * Surfaced separately for the same reason.
   */
  regulatoryFeeUsd: number;
  /**
   * Broker commission. $0 for Alpaca equities; kept explicit so other
   * venues with non-zero commission slot in cleanly without changing
   * the quote shape.
   */
  brokerCommissionUsd: number;
}

/**
 * Alpaca equity fee schedule (2026-05). Re-verify annually.
 *   - SEC fee: 0.0000278 × notional (sells only). $27.80 per $1M.
 *   - TAF:     0.000119  × shares   (sells only), capped at $7.27/trade.
 *   - Commission: $0 (both buys and sells).
 *
 * The cap and per-share/per-notional rates can change; the structure
 * (sells-only, per-share + per-notional + commission) has been stable
 * for many years and reflects how FINRA + SEC structure the passthrough.
 */
export const ALPACA_EQUITY_FEE_SCHEDULE = {
  secFeeRatePerNotional: 0.0000278,
  tafRatePerShare: 0.000119,
  tafCapUsdPerTrade: 7.27,
  brokerCommissionUsd: 0,
} as const;

/**
 * Quote the total fees for a single equity order at the named venue.
 *
 * Paper venue uses the same schedule as Alpaca so the paper→live
 * transition is fee-neutral (SPEC §3.1) — i.e. paper-trading PnL is
 * already reduced by the fees the live broker will charge, and the
 * sizer's reserve matches across both modes.
 *
 * @throws if `venue` is not equity-supported (e.g. 'crypto' or 'kraken').
 * @throws if `notionalUsd <= 0` or `shares <= 0`.
 */
export function quoteFees(input: FeeQuoteInput): FeeQuote {
  if (input.venue !== 'alpaca' && input.venue !== 'paper') {
    // Loud-fail rather than silent fall-through. SPEC §3 router behavior.
    throw new Error(
      `quoteFees: venue '${input.venue}' is not equity-supported. ` +
      `Crypto / other venues land in Phase B.crypto+ (SPEC §3.2 stub).`,
    );
  }
  if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0) {
    throw new Error(`quoteFees: notionalUsd must be a positive finite number, got ${input.notionalUsd}`);
  }
  if (!Number.isFinite(input.shares) || input.shares <= 0) {
    throw new Error(`quoteFees: shares must be a positive finite number, got ${input.shares}`);
  }

  const schedule = ALPACA_EQUITY_FEE_SCHEDULE;
  const brokerCommissionUsd = schedule.brokerCommissionUsd;

  if (input.side === 'buy') {
    return {
      feeUsd: brokerCommissionUsd,
      perShareUsd: 0,
      regulatoryFeeUsd: 0,
      brokerCommissionUsd,
    };
  }

  // Sells: SEC + TAF, both regulatory passthrough.
  const regulatoryFeeUsd = input.notionalUsd * schedule.secFeeRatePerNotional;
  const perShareUsdUncapped = input.shares * schedule.tafRatePerShare;
  const perShareUsd = Math.min(perShareUsdUncapped, schedule.tafCapUsdPerTrade);
  const feeUsd = regulatoryFeeUsd + perShareUsd + brokerCommissionUsd;

  return { feeUsd, perShareUsd, regulatoryFeeUsd, brokerCommissionUsd };
}

/**
 * What could break this:
 *   - Fee schedule changes: SEC / FINRA adjust rates periodically. The
 *     numbers in ALPACA_EQUITY_FEE_SCHEDULE are 2026-05 values; review
 *     annually. A mismatch with broker-reported fees will show up in
 *     fill-reconciliation drift (Phase C) — that's the safety net, but
 *     this module should be updated when drift is detected.
 *   - Whole-share assumption: fractional-share orders (Alpaca supports
 *     them) need a non-cap TAF semantic; deferred to Phase B.1.
 *   - Crypto: the explicit throw is by design. When the crypto branch
 *     ships, add a separate fee schedule and route by venue, not by an
 *     'else' branch.
 */
