/**
 * Pin the pure helpers in scripts/kraken_backfill.ts.
 *
 * Coverage: filename parsing, pair → address mapping, interval-minutes lookup,
 * CSV row parsing (happy path + every malformed/sanity-violation case), and
 * the timestamp-format conversion that has to match exactly what ClickHouse's
 * JSON parser accepts for DateTime64(3,'UTC').
 *
 * No ClickHouse, no fs — only pure functions are exercised here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKrakenCsvLine,
  parseKrakenFilename,
  krakenPairToAddress,
  formatChTimestamp,
  barToCandleRow,
  KRAKEN_INTERVAL_MAP,
  INTERVAL_TO_KRAKEN_MIN,
} from '../kraken_backfill.js';

describe('parseKrakenFilename', () => {
  it('parses XBTUSD_60.csv', () => {
    assert.deepEqual(parseKrakenFilename('XBTUSD_60.csv'), { pair: 'XBTUSD', intervalMinutes: 60 });
  });

  it('parses ETHUSD_240.csv', () => {
    assert.deepEqual(parseKrakenFilename('ETHUSD_240.csv'), { pair: 'ETHUSD', intervalMinutes: 240 });
  });

  it('parses SOLUSD_1440.csv', () => {
    assert.deepEqual(parseKrakenFilename('SOLUSD_1440.csv'), { pair: 'SOLUSD', intervalMinutes: 1440 });
  });

  it('strips the directory portion', () => {
    assert.deepEqual(
      parseKrakenFilename('/some/path/XBTUSD_60.csv'),
      { pair: 'XBTUSD', intervalMinutes: 60 },
    );
  });

  it('returns null for non-CSV files', () => {
    assert.equal(parseKrakenFilename('XBTUSD_60.txt'), null);
    assert.equal(parseKrakenFilename('XBTUSD.csv'), null);
    assert.equal(parseKrakenFilename('README.md'), null);
  });

  it('returns null when the minutes part is non-numeric', () => {
    assert.equal(parseKrakenFilename('XBTUSD_hourly.csv'), null);
  });
});

describe('krakenPairToAddress', () => {
  it('maps XBTUSD → BTCUSD (canonical XBT ⇄ BTC swap)', () => {
    assert.equal(krakenPairToAddress('XBTUSD'), 'BTCUSD');
  });

  it('keeps ETHUSD and SOLUSD unchanged', () => {
    assert.equal(krakenPairToAddress('ETHUSD'), 'ETHUSD');
    assert.equal(krakenPairToAddress('SOLUSD'), 'SOLUSD');
  });

  it('honors an explicit override over the default map', () => {
    assert.equal(krakenPairToAddress('XBTUSD', { XBTUSD: 'BTC_OVERRIDE' }), 'BTC_OVERRIDE');
  });

  it('falls back to XBT-prefix swap for unknown XBT pairs', () => {
    assert.equal(krakenPairToAddress('XBTEUR'), 'BTCEUR');
  });

  it('passes unknown non-XBT pairs through verbatim (forces caller to map)', () => {
    assert.equal(krakenPairToAddress('LINKUSD'), 'LINKUSD');
  });
});

describe('KRAKEN_INTERVAL_MAP / INTERVAL_TO_KRAKEN_MIN', () => {
  it('maps Kraken minute counts to our interval strings for the v1 sweep', () => {
    assert.equal(KRAKEN_INTERVAL_MAP[60], '1h');
    assert.equal(KRAKEN_INTERVAL_MAP[240], '4h');
    assert.equal(KRAKEN_INTERVAL_MAP[1440], '1d');
  });

  it('round-trips through the inverse map', () => {
    for (const minutes of Object.keys(KRAKEN_INTERVAL_MAP).map(Number)) {
      const interval = KRAKEN_INTERVAL_MAP[minutes];
      assert.equal(INTERVAL_TO_KRAKEN_MIN[interval], minutes, `round-trip failed for ${minutes}`);
    }
  });
});

describe('parseKrakenCsvLine', () => {
  it('parses a clean OHLCVT row (drops the trade-count column we ignore)', () => {
    // 2021-05-11 00:00:00 UTC, BTC at $56k, vol 0.5 BTC, 12 trades
    const bar = parseKrakenCsvLine('1620691200,56000.0,56500.0,55800.0,56100.0,0.5,12');
    assert.deepEqual(bar, {
      ts: 1620691200,
      open: 56000.0,
      high: 56500.0,
      low: 55800.0,
      close: 56100.0,
      volume: 0.5,
    });
  });

  it('parses a row with only the 6 required columns (no trade count)', () => {
    const bar = parseKrakenCsvLine('1620691200,56000.0,56500.0,55800.0,56100.0,0.5');
    assert.ok(bar);
    assert.equal(bar.close, 56100.0);
  });

  it('trims whitespace and handles trailing newlines', () => {
    assert.ok(parseKrakenCsvLine('  1620691200,1,2,0.5,1.5,3,7  \n'));
  });

  it('returns null for blank / whitespace-only lines', () => {
    assert.equal(parseKrakenCsvLine(''), null);
    assert.equal(parseKrakenCsvLine('   '), null);
    assert.equal(parseKrakenCsvLine('\n'), null);
  });

  it('returns null when there are too few columns', () => {
    assert.equal(parseKrakenCsvLine('1620691200,56000,56500'), null);
  });

  it('returns null on non-numeric fields', () => {
    assert.equal(parseKrakenCsvLine('1620691200,foo,56500,55800,56100,0.5,12'), null);
    assert.equal(parseKrakenCsvLine('not_a_ts,1,2,0.5,1.5,3,7'), null);
  });

  it('drops rows with non-positive prices (broken series)', () => {
    assert.equal(parseKrakenCsvLine('1620691200,0,1,0.5,1,3,7'), null);
    assert.equal(parseKrakenCsvLine('1620691200,1,1,0,1,3,7'), null);
    assert.equal(parseKrakenCsvLine('1620691200,1,1,0.5,0,3,7'), null);
    assert.equal(parseKrakenCsvLine('1620691200,-1,1,0.5,1,3,7'), null);
  });

  it('drops rows where high < low (impossible candle)', () => {
    assert.equal(parseKrakenCsvLine('1620691200,1,0.5,1.5,1,3,7'), null);
  });

  it('drops rows with negative volume', () => {
    assert.equal(parseKrakenCsvLine('1620691200,1,2,0.5,1.5,-1,7'), null);
  });

  it('drops rows with non-positive timestamp', () => {
    assert.equal(parseKrakenCsvLine('0,1,2,0.5,1.5,3,7'), null);
    assert.equal(parseKrakenCsvLine('-1,1,2,0.5,1.5,3,7'), null);
  });

  it('accepts zero volume (no trades, valid bar)', () => {
    const bar = parseKrakenCsvLine('1620691200,1,2,0.5,1.5,0,0');
    assert.ok(bar);
    assert.equal(bar.volume, 0);
  });
});

describe('formatChTimestamp', () => {
  it('formats unix seconds into ClickHouse DateTime64 literal (no T, no Z)', () => {
    // 2021-05-11 00:00:00 UTC = 1620691200
    assert.equal(formatChTimestamp(1620691200), '2021-05-11 00:00:00.000');
  });

  it('preserves UTC regardless of the JS host timezone', () => {
    // 2024-01-01 12:34:56 UTC = 1704112496
    const out = formatChTimestamp(1704112496);
    assert.equal(out, '2024-01-01 12:34:56.000');
  });

  it('contains no T separator and no trailing Z', () => {
    const out = formatChTimestamp(1620691200);
    assert.ok(!out.includes('T'), `unexpected T in "${out}"`);
    assert.ok(!out.endsWith('Z'), `unexpected Z suffix in "${out}"`);
  });
});

describe('barToCandleRow', () => {
  it('builds a CandleRow with source=kraken and the ClickHouse timestamp format', () => {
    const row = barToCandleRow(
      { ts: 1620691200, open: 56000, high: 56500, low: 55800, close: 56100, volume: 0.5 },
      'BTCUSD',
      '1h',
    );
    assert.deepEqual(row, {
      token_address: 'BTCUSD',
      interval: '1h',
      timestamp: '2021-05-11 00:00:00.000',
      open: 56000,
      high: 56500,
      low: 55800,
      close: 56100,
      volume: 0.5,
      source: 'kraken',
    });
  });
});
