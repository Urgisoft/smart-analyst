/**
 * Integration test for the bundle-driven classification loop.
 *
 * SPEC §5.3: "spin up an in-memory equivalent (or temp CH schema), insert
 * known synthetic candles + breadth rows, run the backfill, assert the
 * resulting macro_regimes rows match expected counts and the no-cry-wolf
 * property (no red regime cells in this calm period)."
 *
 * The pure helper `classifyDateRangeFromBundle` accepts an in-memory
 * `RegimeDataBundle`, so this test exercises the full multi-day priors
 * threading + history slicing without touching ClickHouse. The CH-backed
 * `backfillMacroRegimes` is a thin shell around `classifyDateRangeFromBundle`
 * — it only differs in where it reads + writes the data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDateRangeFromBundle,
  type RegimeDataBundle,
} from '../../src/server/macro_regime.js';

/** Build the trading-day calendar between two ISO dates (Mon-Fri). */
function tradingDays(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const d = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Quiet 2014-style fixture: VIX/VIX3M in normal contango, HYG/SPY both up,
 *  breadth comfortably above 50%, SPY drifting up to a fresh 1Y high. */
function buildCalmBundle(): RegimeDataBundle {
  const classifyStart = '2014-01-02';
  const classifyEnd = '2014-06-30';
  // Provide a 252-trading-day prefix so SPY's 1Y-high gate is computed
  // on real history, not on warmup.
  const prefixStart = '2013-01-02';

  const allDates = tradingDays(prefixStart, classifyEnd);
  const classifyDates = tradingDays(classifyStart, classifyEnd);

  const spyByDate = new Map<string, number>();
  const hygByDate = new Map<string, number>();
  const vixByDate = new Map<string, number>();
  const vix3mByDate = new Map<string, number>();
  const breadthByDate = new Map<string, { pct: number; source: string }>();

  for (let i = 0; i < allDates.length; i++) {
    const d = allDates[i];
    // SPY: smooth uptrend ~10%/yr, today is always near the 1Y high.
    spyByDate.set(d, 150 + i * 0.05);
    // HYG: gentle uptrend (positive 20-day return).
    hygByDate.set(d, 90 + i * 0.005);
    // VIX 12, VIX3M 16 → ratio 0.75, no inversion.
    vixByDate.set(d, 12);
    vix3mByDate.set(d, 16);
    // Breadth comfortably above 50%.
    breadthByDate.set(d, { pct: 65, source: 'stooq_a50r' });
  }

  return {
    classifyDates,
    spyDates: allDates,
    spyByDate,
    hygDates: allDates,
    hygByDate,
    vixByDate,
    vix3mByDate,
    breadthByDate,
  };
}

describe('classifyDateRangeFromBundle — calm-period no-cry-wolf', () => {
  const bundle = buildCalmBundle();
  const rows = classifyDateRangeFromBundle(bundle);

  it('produces one row per classifyDate', () => {
    assert.equal(rows.length, bundle.classifyDates.length);
    assert.equal(rows[0].trade_date, bundle.classifyDates[0]);
    assert.equal(
      rows[rows.length - 1].trade_date,
      bundle.classifyDates[bundle.classifyDates.length - 1]
    );
  });

  it('writes no red days in a quiet period (no-cry-wolf)', () => {
    const reds = rows.filter(r => r.regime === 'red');
    assert.equal(reds.length, 0, `expected zero red days, got ${reds.length}`);
  });

  it('writes no orange days either (calm fixture)', () => {
    const oranges = rows.filter(r => r.regime === 'orange');
    assert.equal(oranges.length, 0, `expected zero orange days, got ${oranges.length}`);
  });

  it('every row carries the canonical classifier_version tag', () => {
    for (const r of rows) {
      assert.equal(r.classifier_version, 'phase1_v3');
    }
  });

  it('every row records the breadth source string when set', () => {
    for (const r of rows) {
      assert.equal(r.pct_above_50dma_source, 'stooq_a50r');
    }
  });

  it('252d prefix is sufficient — no SPY warmup flag in the inputs_missing bitmask', () => {
    const SPY_WARMUP = 1 << 5;
    const warmupCount = rows.filter(r => (r.inputs_missing & SPY_WARMUP) !== 0).length;
    assert.equal(warmupCount, 0);
  });
});

describe('classifyDateRangeFromBundle — multi-day priors threading', () => {
  it('isolated single-category fire is yellow on the firing day, green elsewhere', () => {
    // Vol fires only on day index 2. Per SPEC §2.4, yellow needs
    // categories_firing_today == 1; a stale prior-window fire does NOT
    // keep a day yellow. Days where nothing fires today are green even
    // if vol is still inside the 5-day window.
    const dates = tradingDays('2014-01-02', '2014-01-13'); // 8 trading days
    const spy = new Map<string, number>();
    const hyg = new Map<string, number>();
    const vix = new Map<string, number>();
    const vix3m = new Map<string, number>();
    const breadth = new Map<string, { pct: number; source: string }>();

    for (let i = 0; i < dates.length; i++) {
      spy.set(dates[i], 200);
      hyg.set(dates[i], 90);
      breadth.set(dates[i], { pct: 70, source: 'stooq_a50r' });
      vix.set(dates[i], i === 2 ? 22 : 12);
      vix3m.set(dates[i], i === 2 ? 18 : 16);
    }

    const bundle: RegimeDataBundle = {
      classifyDates: dates,
      spyDates: dates,
      spyByDate: spy,
      hygDates: dates,
      hygByDate: hyg,
      vixByDate: vix,
      vix3mByDate: vix3m,
      breadthByDate: breadth,
    };
    const rows = classifyDateRangeFromBundle(bundle);

    assert.equal(rows[2].regime, 'yellow');
    assert.equal(rows[2].vix_term_inverted, 1);
    // The fire is still in the 5-day window on days 3..6 — categories_firing_5d
    // must reflect that, but the regime is green because today fires zero.
    assert.equal(rows[3].categories_firing_5d, 1);
    assert.equal(rows[3].regime, 'green');
    assert.equal(rows[6].categories_firing_5d, 1);
    assert.equal(rows[6].regime, 'green');
    // Day 7 — vol fell out of the 5-day window.
    assert.equal(rows[7].categories_firing_5d, 0);
    assert.equal(rows[7].regime, 'green');
  });

  it('three different categories firing across 5 days produces red on the third day', () => {
    // Day 0: vol fires.  Day 2: credit fires.  Day 4: breadth fires.
    // Window [day0..day4] union = 3 categories → red on day 4.
    const dates = tradingDays('2014-01-02', '2014-01-10'); // 7 trading days
    const spy = new Map<string, number>();
    const hyg = new Map<string, number>();
    const vix = new Map<string, number>();
    const vix3m = new Map<string, number>();
    const breadth = new Map<string, { pct: number; source: string }>();

    // SPY: smooth uptrend in the prefix, then on day 4 print at 1Y high
    // so breadth_narrow's at-near-high gate passes.
    const prefixDates = tradingDays('2013-01-02', '2014-01-01');
    const allSpyDates = [...prefixDates, ...dates];
    for (let i = 0; i < allSpyDates.length; i++) {
      spy.set(allSpyDates[i], 100 + i * 0.05);
    }

    // HYG history with prefix so 20d return is computable.
    const allHygDates = [...prefixDates, ...dates];
    // To make credit fire on day 2 (HYG 20d < 0, SPY 20d > 0):
    // HYG flat then drops sharply on dates[2]; SPY keeps drifting up.
    for (const d of allHygDates) hyg.set(d, 90);
    hyg.set(dates[2], 86);

    // Default vol/breadth normal across all dates...
    for (const d of dates) {
      vix.set(d, 12);
      vix3m.set(d, 16);
      breadth.set(d, { pct: 70, source: 'stooq_a50r' });
    }
    // Day 0: vol inversion.
    vix.set(dates[0], 22);
    vix3m.set(dates[0], 18);
    // Day 4: breadth narrow.
    breadth.set(dates[4], { pct: 30, source: 'stooq_a50r' });

    const bundle: RegimeDataBundle = {
      classifyDates: dates,
      spyDates: allSpyDates,
      spyByDate: spy,
      hygDates: allHygDates,
      hygByDate: hyg,
      vixByDate: vix,
      vix3mByDate: vix3m,
      breadthByDate: breadth,
    };
    const rows = classifyDateRangeFromBundle(bundle);

    assert.equal(rows[0].regime, 'yellow', 'day 0 vol-only');
    assert.equal(rows[2].regime, 'yellow', 'day 2 credit-only');
    assert.equal(rows[4].regime, 'red', 'day 4 has all 3 categories within the 5-day window');
    assert.equal(rows[4].categories_firing_5d, 3);
  });
});
