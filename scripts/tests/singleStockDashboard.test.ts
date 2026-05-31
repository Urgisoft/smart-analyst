/**
 * Tests for src/server/single_stock_dashboard.ts + single_stock_repository.ts —
 * the single-stock decision-support scorecard powering /api/single-stock/:ticker.
 *
 * Contract pinned here:
 *   - parseTicker normalizes + validates US-equity symbols, rejects garbage.
 *   - extractOptionsJson recovers the JSON object after the `--- JSON ---`
 *     marker (and tolerates raw JSON with no marker).
 *   - projectOptions maps the python tool's snake_case onto camelCase + guards
 *     non-finite numbers.
 *   - fetchSingleStockScorecard assembles all five blocks; a thrown CH read
 *     does NOT propagate as a 500 for one block — the OTHER blocks still render
 *     (each repo method is independently guarded). The scorecard carries the
 *     ADR-056 no-alpha disclaimer + has NO score/rank/verdict field.
 *   - fetchFundamentals returns the clean phase-2 placeholder when no key.
 *   - tailMean / returnPct math.
 *
 * No live CH / network — pure helpers + injected fakes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTicker,
  isTickerFailure,
  extractOptionsJson,
  projectOptions,
  fetchSingleStockScorecard,
  type SingleStockScorecard,
} from '../../src/server/single_stock_dashboard.js';
import {
  tailMean,
  returnPct,
  type SingleStockRepository,
  type TechnicalsBlock,
  type PositioningBlock,
  type MacroFitBlock,
} from '../../src/server/single_stock_repository.js';

// ───── parseTicker ──────────────────────────────────────────────────────

describe('parseTicker', () => {
  it('uppercases + accepts a plain ticker', () => {
    const r = parseTicker({ ticker: 'nvda' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticker, 'NVDA');
  });

  it('accepts dotted/hyphenated share classes', () => {
    for (const t of ['BRK.B', 'BF-B']) {
      const r = parseTicker({ ticker: t });
      assert.equal(r.ok, true, `${t} should parse`);
    }
  });

  it('rejects empty + missing', () => {
    for (const input of [{}, { ticker: '' }, { ticker: '   ' }, { ticker: 123 }]) {
      const r = parseTicker(input as { ticker?: unknown });
      assert.equal(r.ok, false);
      if (isTickerFailure(r)) assert.equal(r.status, 400);
    }
  });

  it('rejects garbage (spaces, semicolons, over-length)', () => {
    for (const t of ['A B', 'DROP;', 'TOOLONGSYM', '<script>']) {
      const r = parseTicker({ ticker: t });
      assert.equal(r.ok, false, `${t} should reject`);
    }
  });
});

// ───── extractOptionsJson ───────────────────────────────────────────────

describe('extractOptionsJson', () => {
  it('recovers the JSON object after the marker', () => {
    const stdout = `human readout line 1\nline 2\n--- JSON ---\n{"ticker":"NVDA","spot":100.5}\n`;
    const j = extractOptionsJson(stdout);
    assert.ok(j);
    assert.equal((j as { ticker: string }).ticker, 'NVDA');
  });

  it('recovers raw JSON with no marker', () => {
    const j = extractOptionsJson('{"ticker":"AAPL","spot":1}');
    assert.ok(j);
    assert.equal((j as { ticker: string }).ticker, 'AAPL');
  });

  it('returns null on no JSON', () => {
    assert.equal(extractOptionsJson('ERROR: no options'), null);
    assert.equal(extractOptionsJson(''), null);
  });

  it('returns null on malformed JSON', () => {
    assert.equal(extractOptionsJson('--- JSON ---\n{not valid'), null);
  });
});

// ───── projectOptions ───────────────────────────────────────────────────

describe('projectOptions', () => {
  it('maps snake_case onto camelCase + guards non-finite', () => {
    const raw = {
      ticker: 'NVDA', spot: 120.5, asof: '2026-05-30T12:00:00+00:00',
      num_expirations: 3,
      term_structure: [
        { date: '2026-06-19', dte: 20, atm_iv: 0.55 },
        { date: '2026-09-18', dte: 111, atm_iv: null },
      ],
      term_structure_flag: 'contango',
      near_atm_iv: 0.55, far_atm_iv: 0.62,
      pc_volume_all: 0.8, pc_oi_all: 1.2,
      nearest_expiry: {
        date: '2026-06-19', dte: 20,
        pc_volume: 0.7, pc_oi: 1.1,
        call_volume: 1000, put_volume: 700, call_oi: 5000, put_oi: 5500,
      },
      skew: {
        pct_offset: 0.07,
        put_strike: 112, put_iv: 0.6, call_strike: 129, call_iv: 0.5, skew_pts: 10,
      },
    };
    const o = projectOptions(raw as Parameters<typeof projectOptions>[0]);
    assert.equal(o.available, true);
    assert.equal(o.spot, 120.5);
    assert.equal(o.termStructure.length, 2);
    assert.equal(o.termStructure[1].atmIv, null);
    assert.equal(o.termStructureFlag, 'contango');
    assert.equal(o.nearestExpiry?.callVolume, 1000);
    assert.equal(o.skew?.skewPts, 10);
  });
});

// ───── math helpers ─────────────────────────────────────────────────────

describe('tailMean / returnPct', () => {
  it('tailMean averages the last n', () => {
    assert.equal(tailMean([1, 2, 3, 4], 2), 3.5);
    assert.equal(tailMean([10], 50), 10); // fewer than n → all
    assert.equal(tailMean([], 5), null);
  });

  it('returnPct uses the close n bars back', () => {
    // last=150 (idx 3), prior n=2 bars back = idx (4-1-2)=1 = 100 → +50%
    const r = returnPct([95, 100, 120, 150], 2);
    assert.ok(r != null && Math.abs(r - 50) < 1e-9, `expected ~50, got ${r}`);
    assert.equal(returnPct([100, 110], 5), null); // too short
    assert.equal(returnPct([0, 110], 1), null); // non-positive prior
  });
});

// ───── fetchSingleStockScorecard (assembly + degradation) ────────────────

const TECH_OK: TechnicalsBlock = {
  available: true, note: null, lastClose: 120, lastDate: '2026-05-29',
  sma50: 110, sma200: 100, high52w: 140, low52w: 80, pctOf52wRange: 0.66,
  mom1mPct: 5, mom1yPct: 30, rowsUsed: 250,
};
const POS_EMPTY: PositioningBlock = {
  available: false, note: 'no positioning', insider: null, shortInterest: null, activist: null,
};
const MACRO_OK: MacroFitBlock = {
  available: true, note: null, regime: 'green', regimeDate: '2026-05-29',
  classifierVersion: 'phase1_v3', sector: 'Information Technology', subIndustry: 'Semiconductors',
};

function fakeRepo(over: Partial<{
  tech: () => Promise<TechnicalsBlock>;
  pos: () => Promise<PositioningBlock>;
  macro: () => Promise<MacroFitBlock>;
}> = {}): SingleStockRepository {
  return {
    readTechnicals: over.tech ?? (async () => TECH_OK),
    readPositioning: over.pos ?? (async () => POS_EMPTY),
    readMacroFit: over.macro ?? (async () => MACRO_OK),
  } as unknown as SingleStockRepository;
}

describe('fetchSingleStockScorecard', () => {
  it('assembles all five blocks + carries the ADR-056 disclaimer', async () => {
    const sc = await fetchSingleStockScorecard('NVDA', {
      repo: fakeRepo(),
      skipOptions: true,
      finnhubApiKey: undefined,
      now: () => new Date('2026-05-30T00:00:00Z'),
    });
    assert.equal(sc.ticker, 'NVDA');
    assert.match(sc.disclaimer, /ADR-056/);
    assert.match(sc.disclaimer, /not a validated signal|does NOT recommend/i);
    assert.equal(sc.technicals.available, true);
    assert.equal(sc.positioning.available, false);
    assert.equal(sc.macroFit.regime, 'green');
    // Fundamentals: no key → clean phase-2 placeholder, NOT a throw.
    assert.equal(sc.fundamentals.available, false);
    assert.match(sc.fundamentals.note ?? '', /phase 2/i);
  });

  it('has NO score/rank/verdict field (no alpha claim is structural)', async () => {
    const sc = await fetchSingleStockScorecard('NVDA', {
      repo: fakeRepo(), skipOptions: true,
    });
    const keys = Object.keys(sc as unknown as Record<string, unknown>);
    for (const banned of ['score', 'rank', 'verdict', 'recommendation', 'signal', 'buy']) {
      assert.equal(keys.includes(banned), false, `scorecard must not have a top-level "${banned}"`);
    }
  });

  it('lights up Finnhub when a key + fake fetch are injected', async () => {
    const fakeFetch = (async (url: string) => {
      if (url.includes('/stock/metric')) {
        return { ok: true, json: async () => ({ metric: { peTTM: 45.2, netProfitMarginTTM: 25, roeTTM: 30 } }) } as unknown as Response;
      }
      if (url.includes('/price-target')) {
        return { ok: true, json: async () => ({ targetMean: 150, targetHigh: 180, targetLow: 120 }) } as unknown as Response;
      }
      return { ok: true, json: async () => ([{ strongBuy: 10, buy: 5, hold: 3, sell: 1, strongSell: 0, period: '2026-05-01' }]) } as unknown as Response;
    }) as unknown as typeof fetch;
    const sc = await fetchSingleStockScorecard('NVDA', {
      repo: fakeRepo(), skipOptions: true,
      finnhubApiKey: 'fake-key', fetchFn: fakeFetch,
    });
    assert.equal(sc.fundamentals.available, true);
    assert.equal(sc.fundamentals.peTtm, 45.2);
    assert.equal(sc.fundamentals.netMarginTtm, 0.25); // percent → decimal
    assert.equal(sc.fundamentals.recommendation?.buy, 5);
  });

  it('degrades one block to unavailable without breaking the others', async () => {
    const sc = await fetchSingleStockScorecard('NVDA', {
      repo: fakeRepo({
        tech: async () => ({ ...TECH_OK, available: false, note: 'polygon absent', lastClose: null }),
      }),
      skipOptions: true,
    });
    assert.equal(sc.technicals.available, false);
    assert.equal(sc.macroFit.available, true); // others still render
  });

  it('Finnhub network failure degrades to the clean placeholder (never throws/logs key)', async () => {
    const throwingFetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const sc: SingleStockScorecard = await fetchSingleStockScorecard('NVDA', {
      repo: fakeRepo(), skipOptions: true,
      finnhubApiKey: 'secret-key', fetchFn: throwingFetch,
    });
    assert.equal(sc.fundamentals.available, false);
    assert.match(sc.fundamentals.note ?? '', /Finnhub fetch failed/);
    // The note must NOT contain the key.
    assert.equal((sc.fundamentals.note ?? '').includes('secret-key'), false);
  });
});
