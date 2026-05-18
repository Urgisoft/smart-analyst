/**
 * Pin the pure helpers in scripts/coinbase_backfill.ts.
 *
 * Coverage: candle row parsing (Coinbase's [ts, low, high, open, close, vol]
 * column order — different from Kraken's [ts, o, h, l, c, vol]), OHLC sanity
 * gates, symbol→product mapping, granularity round-trip, and chunk-window
 * planning for the historical paginator.
 *
 * No HTTP, no ClickHouse — pure functions only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCoinbaseCandle,
  symbolToProduct,
  buildChunks,
  formatChTimestamp,
  barToCandleRow,
  INTERVAL_TO_GRANULARITY,
  GRANULARITY_TO_INTERVAL,
} from '../coinbase_backfill.js';

describe('parseCoinbaseCandle', () => {
  it('parses a clean row in Coinbase column order [ts, low, high, open, close, volume]', () => {
    // BTC at $30k on 2021-01-01: low=29800, high=30500, open=30000, close=30400, vol=120
    const bar = parseCoinbaseCandle([1609459200, 29800, 30500, 30000, 30400, 120]);
    assert.deepEqual(bar, {
      ts: 1609459200,
      open: 30000,
      high: 30500,
      low: 29800,
      close: 30400,
      volume: 120,
    });
  });

  it('returns null for non-array input', () => {
    assert.equal(parseCoinbaseCandle(null), null);
    assert.equal(parseCoinbaseCandle({}), null);
    assert.equal(parseCoinbaseCandle('1,2,3,4,5,6'), null);
  });

  it('returns null on too-few columns', () => {
    assert.equal(parseCoinbaseCandle([1609459200, 1, 2, 3, 4]), null);
  });

  it('returns null on non-numeric fields', () => {
    assert.equal(parseCoinbaseCandle([1609459200, 'foo', 30500, 30000, 30400, 120]), null);
    assert.equal(parseCoinbaseCandle(['not_ts', 1, 2, 3, 4, 5]), null);
  });

  it('drops non-positive prices', () => {
    assert.equal(parseCoinbaseCandle([1609459200, 0, 1, 1, 1, 1]), null);
    assert.equal(parseCoinbaseCandle([1609459200, 1, 1, 0, 1, 1]), null);
    assert.equal(parseCoinbaseCandle([1609459200, 1, 1, 1, 0, 1]), null);
    assert.equal(parseCoinbaseCandle([1609459200, -1, 1, 1, 1, 1]), null);
  });

  it('drops impossible candles where high < low', () => {
    assert.equal(parseCoinbaseCandle([1609459200, 30500, 29800, 30000, 30400, 120]), null);
  });

  it('drops negative volume', () => {
    assert.equal(parseCoinbaseCandle([1609459200, 1, 2, 1.5, 1.5, -1]), null);
  });

  it('drops non-positive timestamp', () => {
    assert.equal(parseCoinbaseCandle([0, 1, 2, 1.5, 1.5, 1]), null);
    assert.equal(parseCoinbaseCandle([-1, 1, 2, 1.5, 1.5, 1]), null);
  });

  it('accepts zero volume (idle bar, valid)', () => {
    const bar = parseCoinbaseCandle([1609459200, 1, 2, 1.5, 1.5, 0]);
    assert.ok(bar);
    assert.equal(bar.volume, 0);
  });
});

describe('symbolToProduct', () => {
  it('maps BTC/ETH/SOL to USD products', () => {
    assert.equal(symbolToProduct('BTC'), 'BTC-USD');
    assert.equal(symbolToProduct('ETH'), 'ETH-USD');
    assert.equal(symbolToProduct('SOL'), 'SOL-USD');
  });

  it('uppercases input', () => {
    assert.equal(symbolToProduct('btc'), 'BTC-USD');
  });

  it('returns null for unknown symbols (forces explicit mapping)', () => {
    assert.equal(symbolToProduct('LINK'), null);
    assert.equal(symbolToProduct(''), null);
  });
});

describe('INTERVAL_TO_GRANULARITY round-trip', () => {
  it('covers the v1.2 sweep intervals (1h, 1d) and the workable substitutes', () => {
    assert.equal(INTERVAL_TO_GRANULARITY['1h'], 3600);
    assert.equal(INTERVAL_TO_GRANULARITY['1d'], 86400);
    assert.equal(INTERVAL_TO_GRANULARITY['6h'], 21600);
    // 4h is intentionally NOT supported by Coinbase. Confirm absence so the
    // backfill script's pre-flight error path stays accurate.
    assert.equal(INTERVAL_TO_GRANULARITY['4h'], undefined);
  });

  it('round-trips through the inverse map', () => {
    for (const [iv, sec] of Object.entries(INTERVAL_TO_GRANULARITY)) {
      assert.equal(GRANULARITY_TO_INTERVAL[sec], iv, `round-trip failed for ${iv}`);
    }
  });
});

describe('buildChunks', () => {
  it('returns an empty list when end ≤ start', () => {
    assert.deepEqual(buildChunks(100, 100, 60), []);
    assert.deepEqual(buildChunks(200, 100, 60), []);
  });

  it('walks newest → oldest in chunkSec-wide windows', () => {
    // 5 days of 1d candles → maxBars=300 => single chunk covers it.
    const chunks = buildChunks(0, 5 * 86400, 86400);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].end, 5 * 86400);
    assert.equal(chunks[0].start, 0);
  });

  it('paginates when the range exceeds chunkSec', () => {
    // 1h granularity, max 300 bars per chunk = chunkSec = 1,080,000 sec.
    // 5 years ≈ 5 * 365 * 86400 = 157,680,000 sec → ~146 chunks.
    const fromSec = 0;
    const toSec = 5 * 365 * 86400;
    const chunks = buildChunks(fromSec, toSec, 3600);
    // Exactly ceil(157680000 / 1080000) = 146 chunks
    assert.equal(chunks.length, Math.ceil((toSec - fromSec) / (3600 * 300)));
  });

  it('chunks tile the full range with no gaps and no overlaps (newest end first)', () => {
    const chunks = buildChunks(0, 1_000_000, 60); // 1m granularity
    // Walking from chunks[0] (newest) backward, each chunk's start should equal
    // the next chunk's end, and the last chunk should reach fromSec exactly.
    assert.equal(chunks[0].end, 1_000_000);
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].end, chunks[i - 1].start, `chunk ${i} not contiguous with chunk ${i - 1}`);
    }
    assert.equal(chunks[chunks.length - 1].start, 0);
  });

  it('clamps the last (oldest) chunk to fromSec rather than over-fetching', () => {
    // 305 bars at 1m → first chunk should be 300 bars wide, second only 5.
    const chunks = buildChunks(0, 305 * 60, 60);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].end, 305 * 60);
    assert.equal(chunks[0].start, 5 * 60);     // 305*60 - 300*60 = 5*60
    assert.equal(chunks[1].end, 5 * 60);
    assert.equal(chunks[1].start, 0);          // clamped to fromSec
  });
});

describe('formatChTimestamp', () => {
  it('formats unix seconds → ClickHouse DateTime64 literal (no T, no Z)', () => {
    assert.equal(formatChTimestamp(1620691200), '2021-05-11 00:00:00.000');
  });
});

describe('barToCandleRow', () => {
  it('emits a CandleRow with source=coinbase', () => {
    const row = barToCandleRow(
      { ts: 1620691200, open: 56000, high: 56500, low: 55800, close: 56100, volume: 0.5 },
      'BTCUSD',
      '1h',
    );
    assert.deepEqual(row, {
      token_address: 'BTCUSD',
      interval: '1h',
      timestamp: '2021-05-11 00:00:00.000',
      open: 56000, high: 56500, low: 55800, close: 56100,
      volume: 0.5,
      source: 'coinbase',
    });
  });
});
