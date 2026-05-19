# SPEC — Live-trade broker integration (Component C-12)

> **Status:** SPEC complete; pending Phase A code start. **Author:** Claude (Vector Core). **Authority:** Session 83 close-of-session operator direction (equity-first, Alpaca, cheap-branch crypto separation pattern). Parent: [trade-execution-pipeline-architecture.md](trade-execution-pipeline-architecture.md) — this fills in §3 row C-12.

This SPEC defines the broker-integration component that sits **after** the four execution-pipeline gates (allowlist → regime → ML → LLM) and **before** the real-money fill. It is the foundation that "real money" requires. The parent architecture SPEC marked C-12 "out of scope until C-7 through C-11 close" — this SPEC deviates from that sequencing; rationale in §1.

---

## 1. Why now (deviation from parent SPEC §3)

The parent SPEC ordered C-12 after C-9/C-10/C-11 because the original framing was that those gates *protect* live money — so they must exist first. That framing is correct for **enabling real-money flow**, but inverted for **building the foundation real-money flow runs on**.

Specifically:
- **C-9 (universe expansion), C-10 (ML at runtime), C-11 (LLM validator)** are each additional gates that **plug into a broker integration**. None of them changes the broker-integration surface.
- **C-12 (broker integration)** is the substrate everything routes through.
- Building C-9/C-10/C-11 first means they accumulate technical debt against an unfinished substrate; retrofitting the broker integration under them later is more rework than building them on top of a finished substrate.
- The operator's stated intent (session 83 close): finish live-trade code FIRST so paper-trading (Track A) tests the eventual live-trade shape, then ship C-9/C-10/C-11 incrementally on top with their own paper-validation windows.

The real-money flip itself remains gated on paper-trading verdict + ADR sign-offs per s63 directive. **Shipping C-12 does NOT flip to real money.** It builds the path; the flip is a separate operator decision later.

---

## 2. Decisions locked in (session 83 close)

| Decision | Value | Why |
|---|---|---|
| **Asset focus** | **Equity-first** | The two production-running strategies (`mean_reversion_v1`, `trend_v1`) operate on equity data. Crypto is deferred. |
| **Broker** | **Alpaca** | Free paper account, clean REST + websocket, free market data, official TypeScript SDK, supports both equity + crypto under one API. |
| **Crypto separation pattern** | **Branch on `strategy.assetClass` at the broker-adapter boundary** | Cheap, reversible, reads naturally. Promote to a venue-abstraction interface only if a third venue is ever added. Vector Core "fewer features, robustly" rule. |
| **Real-money gate** | **Unchanged: paper-trading verdict + ADR** | C-12 shipping does NOT flip `source='paper' → 'live'`. The flip is a separate operator action. |
| **C-12 sequencing vs parent SPEC** | **C-12 ships BEFORE C-9/C-10/C-11** | Substrate before plugins. See §1. |

---

## 3. Components to build (Phase A → E)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  STRATEGY signal fires + 4 gates pass (parent SPEC §1)                  │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  ROUTER (NEW)                                                           │
│  Reads strategy.asset_class.                                            │
│  Resolves a BrokerAdapter:                                              │
│    asset_class='equity', source='paper' → PaperBrokerAdapter           │
│    asset_class='equity', source='live'  → AlpacaAdapter                │
│    asset_class='crypto', source='live'  → (future; throws today)        │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  SIZER (existing; src/lib/risk.ts) — unchanged surface                  │
│  Now consumes a FEE QUOTE from fee_model.ts (NEW) instead of            │
│  hardcoded 0.5% reserve.                                                │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  BrokerAdapter.placeOrder(input) → OrderHandle                          │
│    PaperBroker: synthetic fill at next-bar open (current behavior).     │
│    Alpaca: REST POST /v2/orders → returns Alpaca order ID.              │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  FILL RECONCILIATION LOOP (NEW)                                         │
│  Runs every daemon cycle. Pulls open-order status from broker;          │
│  matches against open live_trades in CH; updates fill_price /           │
│  fees_usd when broker confirms; logs drift if CH and broker disagree.   │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  LIVE_TRADES TABLE (existing) — write semantics unchanged for paper;    │
│  for live, fields update through fill-reconciliation rather than at     │
│  the synthetic-fill instant.                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Phase A — Foundations (non-broker, fully testable without Alpaca)

1. **CH column add — destructive (operator green-light required at apply time)**
   - `quantlab.strategies` gets `asset_class LowCardinality(String) DEFAULT 'equity'`.
   - Backfill: handled by default value. Both running strategies are equity → no manual rows. `upsertStrategy` (clickhouse.ts:1026) gets a new field.
   - Migration script follows the s82 Phase C pattern: `scripts/migrate_strategies_add_asset_class.ts` with dry-run / apply / drop-backup modes, 19 tests, 3 npm aliases.

2. **`StrategyBundle.assetClass: 'equity' | 'crypto'`** TypeScript field in [src/server/clickhouse.ts](src/server/clickhouse.ts).

3. **Fee model — pure module, no broker dependency**
   - New file: `src/server/fee_model.ts`.
   - Surface: `quoteFees({ venue, side, notionalUsd, shares }): { feeUsd, perShareUsd, regulatoryFeeUsd }`.
   - Alpaca equities: $0 commission + SEC fee `0.0000278 * notionalUsd` (sells only) + TAF `0.000119 * shares` (sells only, capped at $7.27). Source: Alpaca docs.
   - Paper broker: same fee model (so paper-to-live transition is fee-neutral).
   - Crypto venues: throws "venue not yet supported" — kept as a stub for the future branch.
   - Replaces the hardcoded `0.5%` reserve in [src/lib/risk.ts](src/lib/risk.ts) sizer logic.

4. **`BrokerAdapter` interface — types only, no behavior**
   - New file: `src/server/brokers/types.ts`.
   - Surface:
     ```ts
     export interface BrokerAdapter {
       readonly venue: 'alpaca' | 'paper' | 'kraken' | 'hyperliquid' | string;
       placeOrder(input: PlaceOrderInput): Promise<OrderHandle>;
       getOrderStatus(handle: OrderHandle): Promise<OrderStatus>;
       cancelOrder(handle: OrderHandle): Promise<void>;
       getAccount(): Promise<AccountSummary>;
       getPositions(): Promise<BrokerPosition[]>;
     }
     ```
   - `OrderStatus` enum: `'pending' | 'filled' | 'partially_filled' | 'canceled' | 'rejected'`.

5. **`PaperBrokerAdapter`** — implements `BrokerAdapter` with synthetic next-bar-open fills. Reproduces today's implicit paper-mode behavior with the new interface so the daemon switch in Phase C is a one-line change.
   - New file: `src/server/brokers/paper.ts`.

6. **`--source=live` CLI flag on the daemon** — wired but DEFAULTS TO `'paper'`.
   - File: [scripts/daily_signal_daemon.ts:1270](scripts/daily_signal_daemon.ts#L1270).
   - When `--source=live` is passed AND no broker adapter is wired for the strategy's `assetClass`, the daemon **refuses to start** with a clear error message (fail-loud, not fail-quiet).
   - The flag works in Phase A but does nothing different yet because only PaperBrokerAdapter exists. Phase A ends with `--source=live` resolving to PaperBrokerAdapter (i.e. no-op vs `--source=paper`).

**Phase A is purely additive** — no behavior change to current paper trading. Test baseline 1338/0/6 must hold + new tests.

### 3.2 Phase B — Alpaca adapter (the actual broker client)

1. **`AlpacaAdapter`** implements `BrokerAdapter` against Alpaca's REST API.
   - New file: `src/server/brokers/alpaca.ts`.
   - SDK choice: `@alpacahq/typescript-sdk` (official) — preferred. Fallback: direct `fetch` against documented REST endpoints if SDK has issues.
   - Auth: API key + secret via `ALPACA_API_KEY` / `ALPACA_API_SECRET` env vars. Add `.env.example` entries.
   - Base URL: `process.env.ALPACA_BASE_URL` (`https://paper-api.alpaca.markets` for paper, `https://api.alpaca.markets` for live). The Alpaca *paper* mode is a separate concept from Vector Core's `source='paper'` — they're orthogonal:
     - `source='paper'` (Vector Core) + AlpacaPaper (Alpaca env) = **dry-run against Alpaca's sandbox** (Phase B testing, no real money).
     - `source='live'` (Vector Core) + AlpacaLive (Alpaca env) = **real money** (Phase D+).
   - Order types: `market` and `limit` initially. `stop` / `stop_limit` deferred to a Phase B.1 follow-up.
   - Time-in-force: `day` (matches typical daemon cadence).

2. **Operator runbook**: `docs/specs/alpaca-onboarding-runbook.md` — how to create the Alpaca account, generate keys, configure env vars, verify connectivity with `scripts/_alpaca_smoke.ts`. Operator-facing only.

3. **Smoke test**: `scripts/_alpaca_smoke.ts` — equivalent to `scripts/_halt_smoke_test.ts`'s pattern. Connects to Alpaca paper sandbox, places a $1 BUY order, polls fill, sells, checks the round-trip. Manual run only; not in `npm test`.

### 3.3 Phase C — Wire the daemon for source='live'

1. **Daemon refactor at [scripts/daily_signal_daemon.ts:1270](scripts/daily_signal_daemon.ts#L1270)**:
   - Replace hardcoded `source: 'paper'` with resolved source from `--source` flag.
   - Replace direct call to `processCellLiveTrades` with: resolve `BrokerAdapter` from `(strategy.assetClass, source)` → call adapter's `placeOrder`.

2. **Fill reconciliation loop**:
   - New file: `src/server/fill_reconciliation.ts`.
   - Per daemon cycle: list open `live_trades` rows where `source='live' AND status='pending'`. For each: call `adapter.getOrderStatus(handle)`. Update CH row with fill_price + fees_usd + fill_time when broker confirms. Log drift if broker says rejected/canceled.
   - Idempotent — safe to re-run.

3. **`writeOpenLiveTrade` extension** — [src/server/live_trade_repository.ts](src/server/live_trade_repository.ts) gains a `'pending'` status path for live trades pre-fill.

### 3.4 Phase D — Morning brief paper + live split

1. [src/server/operator_brief.ts:145](src/server/operator_brief.ts#L145):
   - Fetch closed trades for BOTH `source='paper'` AND `source='live'`.
   - Render two side-by-side panels titled "Paper (Track A)" and "Live (Track B)" during shakedown. After ≥30d of clean live runs with no drift, operator can collapse to live-only.

2. Render the per-strategy panel from s81 with the same split.

### 3.5 Phase E — Real-money flip (OPERATOR-GATED)

NOT included in this SPEC. The flip is:
1. Operator decision (based on Track A verdict + ADR sign-off).
2. Set `ALPACA_BASE_URL=https://api.alpaca.markets`.
3. Run daemon with `--source=live`.
4. Watch the brief; ramp capital per `capital-deployment-ramp.md` (frozen gap).

Documented for completeness; out of scope for Phase A–D shipping.

---

## 4. Schema change — `quantlab.strategies.asset_class`

**DDL diff:**

```sql
-- Phase A migration (s84 candidate beat)
ALTER TABLE quantlab.strategies
  ADD COLUMN asset_class LowCardinality(String) DEFAULT 'equity' AFTER family;
```

**Pre-migration probe semantics:** identical to the s81 `bundle_id` bootstrap probe. New helper `strategiesHasAssetClassColumn(ch)` returns true/false; daemon constructs `BrokerAdapterRegistry` accordingly. Pre-migration → daemon assumes `'equity'` for all (current behavior).

**Why DEFAULT 'equity':** both running strategies are equity. The default makes the migration zero-touch for existing rows. When a future crypto strategy registers, `upsertStrategy(...)` will pass `assetClass: 'crypto'` explicitly.

---

## 5. Function signatures (Phase A contracts)

```ts
// src/server/fee_model.ts
export interface FeeQuoteInput {
  venue: 'alpaca' | 'paper';
  side: 'buy' | 'sell';
  notionalUsd: number;
  shares: number;
}
export interface FeeQuote {
  feeUsd: number;             // total
  perShareUsd: number;        // TAF component
  regulatoryFeeUsd: number;   // SEC component
  brokerCommissionUsd: number;// $0 for Alpaca equities
}
export function quoteFees(input: FeeQuoteInput): FeeQuote;

// src/server/brokers/types.ts
export interface PlaceOrderInput {
  symbol: string;             // 'SPY', 'AAPL'
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  qty: number;                // whole shares; fractional handling deferred
  limitPrice?: number;        // required iff orderType === 'limit'
  clientOrderId: string;      // idempotency key — repo-generated UUID
  timeInForce: 'day';
}
export interface OrderHandle {
  brokerOrderId: string;
  venue: BrokerAdapter['venue'];
  clientOrderId: string;
  placedAt: Date;
}
export interface OrderStatus {
  status: 'pending' | 'filled' | 'partially_filled' | 'canceled' | 'rejected';
  filledQty: number;
  avgFillPrice: number | null;
  feesUsd: number;            // sourced from broker, not estimated
  rejectionReason?: string;
}
```

---

## 6. Test plan (per phase)

### Phase A
- [ ] `fee_model.test.ts` — Alpaca equity fee math + side-asymmetric (sell-only fees) + paper symmetry with live. ~10 tests.
- [ ] `paperBrokerAdapter.test.ts` — synthetic fill at next-bar-open + idempotent client_order_id. ~6 tests.
- [ ] `migrateStrategiesAddAssetClass.test.ts` — dry-run + apply + drop-backup paths, 9-row parity, FakeClickHouse + EXPLAIN PLAN grammar checks (per s83 pattern). ~12 tests.
- [ ] `clickhouseStrategiesAssetClass.test.ts` — `fetchStrategies` / `upsertStrategy` round-trip for the new field. ~4 tests.
- [ ] Existing 1338 tests must continue to pass.
- [ ] `--source=live` with no live adapter wired → daemon fails-loud with clear error (smoke test).

### Phase B
- [ ] `alpacaAdapter.test.ts` — mock the Alpaca SDK; verify request construction + error mapping. ~12 tests.
- [ ] `scripts/_alpaca_smoke.ts` — manual end-to-end against Alpaca paper sandbox.

### Phase C
- [ ] `fillReconciliation.test.ts` — drift detection, status transitions, idempotency. ~8 tests.
- [ ] `daemonLiveSourceFlag.test.ts` — `--source=live` routes through the resolved adapter; default `'paper'` preserves current behavior. ~6 tests.

### Phase D
- [ ] `operatorBriefPaperLiveSplit.test.ts` — both panels render; live panel handles empty-set gracefully. ~4 tests.

---

## 7. Failure modes / watch-outs

1. **Alpaca paper sandbox ≠ Vector Core `source='paper'`.** Two orthogonal concepts; conflating them is the biggest readability landmine. Always say "Alpaca paper sandbox" vs "Vector Core source=paper" in code and docs. The Alpaca env var is `ALPACA_BASE_URL`; the Vector Core flag is `--source`.

2. **Fee model accuracy matters more for live than paper.** SEC + TAF fees are tiny per trade but compound over many trades. The fee model should be quoted from current docs at SPEC time (May 2026 values used here); review annually because SEC fee schedule changes.

3. **`clientOrderId` idempotency is load-bearing.** Network retry on a `placeOrder` call MUST NOT cause double-fills. The repo generates a UUID per intent; Alpaca dedupes by `client_order_id`. If we use a non-UUID-stable ID, retries open duplicate positions. Test for this explicitly in Phase B.

4. **Fill price ≠ signal-time price.** Slippage is real. The fee model handles fees; the sizer must accommodate slippage separately. Current sizer assumes signal-time price for sizing — this is fine for paper but causes capital-deployment drift in live. SPEC §3A buffer is the right place to encode slippage; not addressed in Phase A; flagged for Phase C+.

5. **Whole shares only initially.** Fractional shares work on Alpaca but require additional handling (decimal qty, settlement). Defer to Phase B.1.

6. **Margin / shorts.** Alpaca margin accounts allow shorts; cash accounts don't. Default assumption: cash account, long-only. Document the constraint in the runbook. If a strategy needs shorts, requires margin-account onboarding (not auto-handleable).

7. **PDT rule.** Pattern Day Trader rule applies to accounts < $25k. Daemon cadence is daily, not intraday, so this should not bite — but if a strategy ever closes same-day on a small account, FINRA freezes the account. Document the constraint; consider a daemon-level check.

8. **Time zones.** Alpaca uses ET for market hours; daemon currently runs on whatever the workstation TZ is. Add explicit ET handling in the Alpaca adapter (don't rely on local TZ).

9. **API rate limits.** Alpaca free tier: 200 req/min. Daemon should not hit this with a daily cadence, but the fill-reconciliation loop polling open orders could. Add exponential backoff on 429.

10. **Crypto stub throws explicitly.** When/if a `crypto` strategy is registered before Phase B.crypto ships, the router must throw a clear "venue not yet supported" error, not silently fall back to PaperBrokerAdapter.

---

## 8. Open questions (deferred from this SPEC)

1. **Account type**: cash or margin? Determines short availability + settlement. → Operator decision pre-Phase-B.
2. **Account size for PDT considerations**: → Operator decision pre-Phase-D.
3. **Bar-data source for live**: Continue with yfinance for backtests, but live signal-time prices should come from Alpaca's real-time feed (free tier). → Phase B detail.
4. **Order type expansion**: stop / stop_limit deferred to Phase B.1. Whether strategies need them depends on stop-loss implementation (currently `stopLossPct` is a position-level config but the daemon doesn't translate it to a broker-side stop order — it monitors and closes via market order).
5. **Webhook vs. polling for fill notifications**: Alpaca supports both. Polling is simpler. → Phase C detail.

---

## 9. Sequencing summary

| Phase | What | Touches real money? | Blockers |
|---|---|---|---|
| **A** | Foundations: CH column, fee model, BrokerAdapter interface, PaperBrokerAdapter, `--source` flag (no-op) | No | Operator green-light for schema migration |
| **B** | AlpacaAdapter + onboarding runbook + smoke test | Alpaca paper sandbox only | Operator: Alpaca account + API keys + cash/margin decision |
| **C** | Daemon source='live' wiring + fill reconciliation | Alpaca paper sandbox only (until env var flipped) | None — Phase B unblocks |
| **D** | Morning brief paper+live split | None | None — Phase C unblocks |
| **E** | Real-money flip | YES | Paper-trading verdict + ADR sign-off + capital ramp (frozen gap C-1) |

Phase A is autonomous-safe and can ship in 1-2 sessions. Phases B-D each require one operator decision at start (keys / account / etc.) and then ship autonomously. Phase E is operator-gated by definition.

---

## 10. What could break this

- Alpaca's API changing — version-pin the SDK; the smoke test would surface breakage.
- Asset-class branching getting clogged with vendor-specific exceptions before crypto re-enters scope — promote to interface abstraction only when a third venue exists.
- Fill reconciliation racing with daemon's own retry logic — `client_order_id` idempotency is the contract. Test it explicitly.
- The Alpaca paper sandbox having subtly different behavior from live (e.g. different fill semantics) — the runbook should call this out; the smoke test should run against BOTH sandboxes before any real-money flip.
- Conflating `source='paper'` with Alpaca-paper-sandbox in code comments / docs — discipline + clear naming.
