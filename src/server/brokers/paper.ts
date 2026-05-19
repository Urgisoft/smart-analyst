/**
 * PaperBrokerAdapter — BrokerAdapter implementation for paper trading.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §3.1 unit 5.
 *
 * Purpose:
 *   Wrap the current synthetic-fill paper-trading semantics in the same
 *   BrokerAdapter interface that AlpacaAdapter (Phase B) will implement.
 *   The daemon's Phase C migration ("if source === 'paper' { direct write }
 *   else { broker call }" → "broker = resolve(...); broker.placeOrder(...)")
 *   becomes a one-line change because both paths route through the same
 *   interface.
 *
 * Synthesis rules:
 *   - Market orders fill at the price returned by the injected
 *     `priceProvider(symbol)`. The daemon will pass a function that
 *     returns the next-bar-open (or current-bar-close, depending on the
 *     strategy cell's exit-on-open vs exit-on-close convention).
 *   - Limit orders fill at the limit price if `priceProvider`'s value
 *     would cross it on the favorable side; otherwise they stay
 *     'pending' (this mirrors a broker's marketable-vs-resting behavior
 *     in a way that's usefully testable).
 *   - All fills are instant from the adapter's perspective (no walk-the-
 *     book delay) — the daemon's bar cadence is the natural rate-limit.
 *
 * Idempotency:
 *   `placeOrder` dedupes on `clientOrderId`. A retry with the same ID
 *   returns the same OrderHandle and does not double-fill. This matches
 *   the contract Phase B's AlpacaAdapter must honor against the real
 *   broker (SPEC §7 item 3).
 *
 * State scope:
 *   In-memory only. State is per-adapter-instance; a new daemon process
 *   creates a fresh adapter and does NOT see prior synthetic fills. This
 *   is correct for paper mode — the persistent record of paper trades
 *   lives in `quantlab.live_trades`, not in the adapter. The adapter is
 *   the wire format, not the journal.
 */
import { randomUUID } from 'node:crypto';
import type {
  AccountSummary,
  BrokerAdapter,
  BrokerPosition,
  OrderHandle,
  OrderStatus,
  PlaceOrderInput,
} from './types.js';
import { quoteFees } from '../fee_model.js';

/** Price-provider hook injected at construction. */
export type PaperPriceProvider = (symbol: string) => number | Promise<number>;

/**
 * In-memory record of one synthetic order's full state. The adapter
 * keeps these so `getOrderStatus(handle)` is just a Map lookup — the
 * sythetic fill is decided at `placeOrder` time and frozen thereafter.
 */
interface PaperOrderRecord {
  handle: OrderHandle;
  input: PlaceOrderInput;
  status: OrderStatus;
}

export interface PaperBrokerAdapterOptions {
  /**
   * Returns the synthetic fill price for a symbol. The daemon will
   * inject a function that hits the existing bar-data cache. In tests,
   * pass a deterministic function.
   */
  priceProvider: PaperPriceProvider;
  /**
   * Synthetic account snapshot. Used by callers that ask the adapter
   * for account state (e.g. PDT checks). Defaults to a reasonable
   * fully-funded snapshot so paper code paths exercise the same shape
   * as live without configuration ceremony.
   */
  accountSnapshot?: AccountSummary;
}

const DEFAULT_PAPER_ACCOUNT: AccountSummary = {
  equityUsd: 100_000,
  cashUsd: 100_000,
  patternDayTrader: false,
};

export class PaperBrokerAdapter implements BrokerAdapter {
  readonly venue = 'paper' as const;

  private readonly priceProvider: PaperPriceProvider;
  private readonly accountSnapshot: AccountSummary;
  /** Indexed by clientOrderId for idempotency dedupe. */
  private readonly ordersByClientId = new Map<string, PaperOrderRecord>();
  /** Indexed by brokerOrderId for status-lookup. */
  private readonly ordersByBrokerId = new Map<string, PaperOrderRecord>();

  constructor(opts: PaperBrokerAdapterOptions) {
    this.priceProvider = opts.priceProvider;
    this.accountSnapshot = opts.accountSnapshot ?? DEFAULT_PAPER_ACCOUNT;
  }

  async placeOrder(input: PlaceOrderInput): Promise<OrderHandle> {
    // Idempotency: identical clientOrderId returns the existing handle
    // without re-synthesising a fill. SPEC §7 item 3.
    const existing = this.ordersByClientId.get(input.clientOrderId);
    if (existing) return existing.handle;

    if (input.orderType === 'limit' && input.limitPrice == null) {
      throw new Error(
        `PaperBrokerAdapter.placeOrder: limit order requires limitPrice (clientOrderId=${input.clientOrderId})`,
      );
    }
    if (input.orderType === 'market' && input.limitPrice != null) {
      // Loud-fail rather than silently dropping the price. Catches operator-error class.
      throw new Error(
        `PaperBrokerAdapter.placeOrder: market order must not carry a limitPrice (clientOrderId=${input.clientOrderId})`,
      );
    }
    if (!Number.isFinite(input.qty) || input.qty <= 0) {
      throw new Error(
        `PaperBrokerAdapter.placeOrder: qty must be a positive finite number, got ${input.qty}`,
      );
    }

    const marketPrice = await this.priceProvider(input.symbol);
    const fillPrice = this.resolveFillPrice(input, marketPrice);
    const handle: OrderHandle = {
      brokerOrderId: `paper-${randomUUID()}`,
      venue: this.venue,
      clientOrderId: input.clientOrderId,
      placedAt: new Date(),
    };

    let status: OrderStatus;
    if (fillPrice == null) {
      // Limit order that wouldn't cross — stays pending. (Operator can
      // later call cancelOrder or it can stay open across the test run.)
      status = { status: 'pending', filledQty: 0, avgFillPrice: null, feesUsd: 0 };
    } else {
      const notionalUsd = fillPrice * input.qty;
      const fee = quoteFees({
        venue: 'paper',
        side: input.side,
        notionalUsd,
        shares: input.qty,
      });
      status = {
        status: 'filled',
        filledQty: input.qty,
        avgFillPrice: fillPrice,
        feesUsd: fee.feeUsd,
      };
    }
    const record: PaperOrderRecord = { handle, input, status };
    this.ordersByClientId.set(input.clientOrderId, record);
    this.ordersByBrokerId.set(handle.brokerOrderId, record);
    return handle;
  }

  async getOrderStatus(handle: OrderHandle): Promise<OrderStatus> {
    const rec = this.ordersByBrokerId.get(handle.brokerOrderId);
    if (!rec) {
      // Unknown handle = "rejected" rather than throwing. Matches what a
      // broker would say for a stale/unknown ID. Reconciliation handles it.
      return { status: 'rejected', filledQty: 0, avgFillPrice: null, feesUsd: 0,
        rejectionReason: `paper: no order with brokerOrderId=${handle.brokerOrderId}` };
    }
    return rec.status;
  }

  async cancelOrder(handle: OrderHandle): Promise<void> {
    const rec = this.ordersByBrokerId.get(handle.brokerOrderId);
    if (!rec) return; // no-op on unknown; matches broker idiom.
    if (rec.status.status === 'filled' || rec.status.status === 'canceled' ||
        rec.status.status === 'rejected') {
      // Terminal — no-op.
      return;
    }
    rec.status = { ...rec.status, status: 'canceled' };
  }

  async getAccount(): Promise<AccountSummary> {
    return { ...this.accountSnapshot };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    // PaperBrokerAdapter doesn't track positions — the daemon journals
    // them in `quantlab.live_trades`. Return [] explicitly; this is the
    // correct answer (the broker doesn't know), not a bug.
    return [];
  }

  /**
   * Decide the synthetic fill price for an order.
   *   - Market: always fills at marketPrice.
   *   - Limit BUY: fills if marketPrice <= limitPrice (favorable cross).
   *   - Limit SELL: fills if marketPrice >= limitPrice (favorable cross).
   *   - Non-crossing limit: returns null → order stays pending.
   *
   * The "fills at limit price on cross" rule is the conservative choice:
   * a real broker may fill at any marketable price between limit and
   * market, but pinning to limit means the paper PnL is at worst as good
   * as live, never better. (We never want paper to flatter live.)
   */
  private resolveFillPrice(input: PlaceOrderInput, marketPrice: number): number | null {
    if (input.orderType === 'market') return marketPrice;
    const limit = input.limitPrice as number; // checked in placeOrder
    if (input.side === 'buy') {
      return marketPrice <= limit ? limit : null;
    }
    return marketPrice >= limit ? limit : null;
  }
}

/**
 * What could break this:
 *   - In-memory state is per-process: a daemon restart loses pending
 *     limit orders. Acceptable for paper (the actual journal lives in
 *     `live_trades`); Phase B's AlpacaAdapter inherits durability from
 *     the real broker.
 *   - The conservative-fill rule (fills at limit on cross) means paper
 *     PnL slightly understates what a market-following limit fill might
 *     have captured. This is the intended bias; paper should under-
 *     estimate, not flatter, live behavior.
 *   - The `priceProvider` is awaited; if the daemon's injected provider
 *     blocks on I/O, `placeOrder` blocks. Phase C's daemon refactor
 *     should ensure the provider is cache-backed.
 */
