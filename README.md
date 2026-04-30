# Vector_Core: Algotrading Strategy Laboratory

Live-backtesting environment for Solana DEX tokens, backed by your local ClickHouse `quantlab` warehouse.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A running ClickHouse instance with the `quantlab` schema (you already have this in Docker)

## Quick start

```bash
npm install
cp .env.example .env          # then edit if your CH host/creds differ
npm run load:metadata         # one-time: populate quantlab.token_metadata from Jupiter
npm run dev                   # http://localhost:3000
```

The server logs `✓ ClickHouse (quantlab) connection OK` if the client can reach the DB.

## Architecture

```text
Browser ──HTTP──> Express (server.ts) ──@clickhouse/client──> quantlab (Docker)
                       │
                       └── /api/tiers          tier definitions
                       └── /api/tiers/:id/tokens   tokens in a tier (real symbols + features)
                       └── /api/candles        OHLCV from quantlab.candles
                       └── /api/backtest/sweep server-side strategy run on real data
```

Strategy code in [src/lib/indicators.ts](src/lib/indicators.ts) is shared between the browser (charts) and the server (sweeps) — same MOMENTUM / MEAN_REVERSION / TREND / CUSTOM logic in both places.

## Connection

Configure via `.env`:

```env
CLICKHOUSE_HOST=127.0.0.1
CLICKHOUSE_PORT=8123
CLICKHOUSE_USER=quantlab
CLICKHOUSE_PASSWORD=quantlab
CLICKHOUSE_DB=quantlab
```

The server uses [@clickhouse/client](https://www.npmjs.com/package/@clickhouse/client) over HTTP (port 8123). The native protocol (9000) is unused.

## Data dependencies

This app reads — but does **not** write to — the following objects in `quantlab`:

| Table / view             | Purpose                                                     |
|--------------------------|-------------------------------------------------------------|
| `candles`                | OHLCV by `(token_address, interval, timestamp)`             |
| `token_metadata`         | mint → symbol/decimals/mcap/liquidity                       |
| `daily_volume`           | aggregated 24h $ volume (AggregateFunction state)           |
| `v_returns_1h`           | hourly log returns                                          |
| `v_realized_vol_30d`     | 30-day annualized realized vol per token                    |
| `v_beta_to_sol_7d`       | 7-day beta to SOL                                           |
| `v_token_features`       | feature mart (joins all of the above)                       |

The only write the app performs is `npm run load:metadata`, which inserts into `token_metadata` (idempotent — `ReplacingMergeTree` collapses duplicate `token_address` rows).

## Tier slicers

The market segment picker offers 13 tier definitions across 5 categories:

| Category | Tier IDs |
| --- | --- |
| Volatility (`v_realized_vol_30d`) | `vol_low`, `vol_mid`, `vol_high` |
| Beta to SOL (`v_beta_to_sol_7d`) | `beta_neg`, `beta_market`, `beta_high` |
| Market cap (`token_metadata.mcap_usd`) | `mcap_nano`, `mcap_micro`, `mcap_small`, `mcap_mid`, `mcap_large` |
| 24h $ volume (`daily_volume`) | `vol_top` |
| Combination | `combo_hot` (high vol AND high SOL beta) |

Each tier filters tokens that have ≥100 candles at the requested interval, so backtests always have enough data to evaluate.

## Refreshing token metadata

If new tokens appear in `candles`, re-run:

```bash
npm run load:metadata
```

Pulls fresh data from Jupiter v2 search (`https://lite-api.jup.ag/tokens/v2/search`), batched 100 mints per request. Idempotent — safe to re-run anytime.

## Inspecting data

```bash
docker exec -it quantlab-clickhouse clickhouse-client \
  --user quantlab --password quantlab --database quantlab
```

```sql
-- Token coverage
SELECT count() AS n, uniq(token_address) AS u FROM token_metadata FINAL;

-- Top tokens by mcap
SELECT symbol, mcap_usd, liquidity_usd FROM token_metadata FINAL
ORDER BY mcap_usd DESC LIMIT 20;

-- Tier preview (high vol, ordered by realized vol desc)
SELECT symbol, realized_vol_30d, beta_to_sol_7d, mcap_usd
FROM v_token_features WHERE realized_vol_30d >= 3.0
ORDER BY realized_vol_30d DESC LIMIT 20;
```

## Notes

- The `useLivePrice` hook tries Binance WebSockets and will fail silently for SPL mint addresses — `livePrice` falls back to the last candle close. Replace with a Jupiter price stream if you need live ticks.
- Backtest sweep state is held in process memory only; no `bt_runs`/`bt_trades` tables are created in your DB. If you want durable runs, ask and I'll add the tables under `quantlab` (separate from `decision_log`).
- The `1m` interval is no longer offered in the UI — your `candles` table only stores `5m` / `15m` / `1h` / `4h` / `1d`.

---
*Built with React, Vite, Express, ClickHouse (`@clickhouse/client`), and Tailwind CSS.*
