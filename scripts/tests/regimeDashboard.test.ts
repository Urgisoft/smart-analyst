/**
 * Unit tests for regime_dashboard pure helpers.
 *
 * SPEC: docs/specs/regime-dashboard-component3.md §5.
 *
 * No ClickHouse connection — every test exercises a pure function. The
 * impure `fetchRegimeState` is covered by manual smoke against a live CH +
 * the SPEC's exit gate (browser-render check).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  computeDaysInCurrentRegime,
  findPreviousRegime,
  buildFiveDayWindow,
  rollUpDistribution,
  pctOf,
  ADR_037_BASELINE,
  ADR_037_BASELINE_TRADING_DAYS,
  ADR_038_BASELINE,
  ADR_038_BASELINE_TRADING_DAYS,
  BIAS_NOTE_PHASE1_V2,
  BIAS_NOTE_PHASE1_V3,
  LOOKBACK_DAYS_MIN,
  LOOKBACK_DAYS_MAX,
  LOOKBACK_DAYS_DEFAULT,
  isQueryFailure,
  type RegimeCounts,
} from '../../src/server/regime_dashboard.js';
import type { MacroRegimeRow, Regime } from '../../src/server/macro_regime.js';

// ── Builders ────────────────────────────────────────────────────────────────

/** Minimal MacroRegimeRow with safe defaults; only `trade_date` and `regime`
 *  matter for most dashboard helpers. */
function makeRow(date: string, regime: Regime, overrides: Partial<MacroRegimeRow> = {}): MacroRegimeRow {
  return {
    trade_date: date,
    classifier_version: 'phase1_v2',
    vix_close: null,
    vix3m_close: null,
    hyg_close: null,
    spy_close: null,
    pct_above_50dma: null,
    pct_above_50dma_source: '',
    vix_term_ratio: null,
    hyg_20d_return: null,
    spy_20d_return: null,
    hyg_10d_return: null,
    spy_10d_return: null,
    spy_252d_high: null,
    spy_drawdown_from_1y_high: null,
    vix_term_inverted: 0,
    hyg_spy_divergence: 0,
    hyg_spy_divergence_10d: 0,
    breadth_narrow: 0,
    realized_stress: 0,
    inputs_missing: 0,
    signals_firing: 0,
    categories_firing: 0,
    categories_firing_5d: 0,
    regime,
    ...overrides,
  };
}

// ── 1. parseQuery — happy path ──────────────────────────────────────────────

describe('parseQuery', () => {
  it('applies defaults when both params are absent', () => {
    const r = parseQuery({});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.asOf, null);
    assert.equal(r.lookbackDays, LOOKBACK_DAYS_DEFAULT);
  });

  it('accepts both params present', () => {
    const r = parseQuery({ asOf: '2026-05-08', lookbackDays: '500' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.asOf, '2026-05-08');
    assert.equal(r.lookbackDays, 500);
  });

  it('treats empty string as absent', () => {
    const r = parseQuery({ asOf: '', lookbackDays: '' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.asOf, null);
    assert.equal(r.lookbackDays, LOOKBACK_DAYS_DEFAULT);
  });

  // ── 2. parseQuery — 400 cases ──────────────────────────────────────────────

  it('rejects malformed asOf (not YYYY-MM-DD)', () => {
    const r = parseQuery({ asOf: '05/08/2026' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
    assert.equal(r.error, 'bad_query');
  });

  it('rejects asOf with invalid calendar date (Feb 30)', () => {
    const r = parseQuery({ asOf: '2026-02-30' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
  });

  it('rejects lookbackDays=0 (below min)', () => {
    const r = parseQuery({ lookbackDays: '0' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
  });

  it('rejects lookbackDays above max', () => {
    const r = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MAX + 1) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
  });

  it('rejects non-numeric lookbackDays', () => {
    const r = parseQuery({ lookbackDays: 'abc' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
  });

  it('rejects non-integer lookbackDays', () => {
    const r = parseQuery({ lookbackDays: '252.5' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
  });

  it('isQueryFailure narrows correctly', () => {
    const fail = parseQuery({ lookbackDays: '0' });
    assert.equal(isQueryFailure(fail), true);
    const pass = parseQuery({});
    assert.equal(isQueryFailure(pass), false);
  });

  it('accepts boundary values', () => {
    const min = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MIN) });
    assert.equal(min.ok, true);
    const max = parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MAX) });
    assert.equal(max.ok, true);
  });
});

// ── 3-5. computeDaysInCurrentRegime ─────────────────────────────────────────

describe('computeDaysInCurrentRegime', () => {
  it('returns the streak length for a 5-day yellow run', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-01', 'green'),
      makeRow('2026-05-04', 'yellow'),
      makeRow('2026-05-05', 'yellow'),
      makeRow('2026-05-06', 'yellow'),
      makeRow('2026-05-07', 'yellow'),
      makeRow('2026-05-08', 'yellow'),
    ];
    assert.equal(computeDaysInCurrentRegime(rows, '2026-05-08'), 5);
  });

  it('returns 1 for a single-day regime preceded by a different label', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-06', 'green'),
      makeRow('2026-05-07', 'green'),
      makeRow('2026-05-08', 'yellow'),
    ];
    assert.equal(computeDaysInCurrentRegime(rows, '2026-05-08'), 1);
  });

  it('returns 0 for empty rows', () => {
    assert.equal(computeDaysInCurrentRegime([], '2026-05-08'), 0);
  });

  it('returns 0 when asOfDate is not the last row', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-07', 'yellow'),
      makeRow('2026-05-08', 'yellow'),
    ];
    assert.equal(computeDaysInCurrentRegime(rows, '2026-05-07'), 0);
  });

  it('returns rows.length when the streak fills the entire window (caller widens)', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-04', 'green'),
      makeRow('2026-05-05', 'green'),
      makeRow('2026-05-06', 'green'),
      makeRow('2026-05-07', 'green'),
      makeRow('2026-05-08', 'green'),
    ];
    assert.equal(computeDaysInCurrentRegime(rows, '2026-05-08'), 5);
  });
});

// ── 6. findPreviousRegime ───────────────────────────────────────────────────

describe('findPreviousRegime', () => {
  it('returns the most recent different label and its last date', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-01', 'green'),
      makeRow('2026-05-04', 'green'),
      makeRow('2026-05-05', 'orange'),
      makeRow('2026-05-06', 'orange'),
      makeRow('2026-05-07', 'yellow'),
      makeRow('2026-05-08', 'yellow'),
    ];
    const prev = findPreviousRegime(rows, '2026-05-08');
    assert.deepEqual(prev, { regime: 'orange', lastDate: '2026-05-06' });
  });

  it('returns null when no flip exists in the supplied window', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-06', 'yellow'),
      makeRow('2026-05-07', 'yellow'),
      makeRow('2026-05-08', 'yellow'),
    ];
    assert.equal(findPreviousRegime(rows, '2026-05-08'), null);
  });

  it('returns null when asOfDate is not the last row', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-07', 'green'),
      makeRow('2026-05-08', 'yellow'),
    ];
    assert.equal(findPreviousRegime(rows, '2026-05-07'), null);
  });
});

// ── 7. buildFiveDayWindow ───────────────────────────────────────────────────

describe('buildFiveDayWindow', () => {
  it('returns exactly the last 5 rows in ASC order when 5+ rows present', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-04-30', 'green'),
      makeRow('2026-05-01', 'green'),
      makeRow('2026-05-04', 'yellow'),
      makeRow('2026-05-05', 'yellow', { vix_term_inverted: 1, categories_firing: 1 }),
      makeRow('2026-05-06', 'orange', { hyg_spy_divergence: 1, vix_term_inverted: 1, categories_firing: 2 }),
      makeRow('2026-05-07', 'orange', { breadth_narrow: 1, vix_term_inverted: 1, categories_firing: 2 }),
      makeRow('2026-05-08', 'orange', { breadth_narrow: 1, hyg_spy_divergence: 1, categories_firing: 2 }),
    ];
    const w = buildFiveDayWindow(rows);
    assert.equal(w.length, 5);
    assert.equal(w[0].date, '2026-05-04');
    assert.equal(w[4].date, '2026-05-08');
    assert.equal(w[2].vix_term_inverted, 1);
    assert.equal(w[2].categories_firing, 2);
  });

  it('returns shorter window without padding when fewer than 5 rows present', () => {
    const rows: MacroRegimeRow[] = [
      makeRow('2026-05-06', 'green'),
      makeRow('2026-05-07', 'yellow'),
      makeRow('2026-05-08', 'yellow'),
    ];
    const w = buildFiveDayWindow(rows);
    assert.equal(w.length, 3);
    assert.equal(w[0].date, '2026-05-06');
  });

  it('returns empty for empty rows', () => {
    assert.deepEqual(buildFiveDayWindow([]), []);
  });
});

// ── 8. rollUpDistribution + pctOf ───────────────────────────────────────────

describe('rollUpDistribution', () => {
  it('matches a hand-traced fixture: 3R / 2O / 5Y / 10G', () => {
    const rows: MacroRegimeRow[] = [
      ...['2026-01-01', '2026-01-02', '2026-01-03'].map(d => makeRow(d, 'red')),
      ...['2026-01-04', '2026-01-05'].map(d => makeRow(d, 'orange')),
      ...['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'].map(d => makeRow(d, 'yellow')),
      ...Array.from({ length: 10 }, (_, i) => makeRow(`2026-02-${String(i + 1).padStart(2, '0')}`, 'green')),
    ];
    const counts = rollUpDistribution(rows);
    assert.deepEqual(counts, { red: 3, orange: 2, yellow: 5, green: 10 });
  });

  it('handles empty rows', () => {
    assert.deepEqual(rollUpDistribution([]), { red: 0, orange: 0, yellow: 0, green: 0 });
  });

  it('pctOf computes percentages summing to ~100', () => {
    const counts: RegimeCounts = { red: 50, orange: 78, yellow: 1172, green: 3317 };
    const pct = pctOf(counts);
    const total = pct.red + pct.orange + pct.yellow + pct.green;
    // Rounding can cause small drift from 100 (3317/4617 = 71.84% etc).
    assert.ok(Math.abs(total - 100) < 0.05, `total=${total}`);
  });

  it('pctOf returns all-zero for all-zero counts', () => {
    assert.deepEqual(
      pctOf({ red: 0, orange: 0, yellow: 0, green: 0 }),
      { red: 0, orange: 0, yellow: 0, green: 0 },
    );
  });
});

// ── 9. ADR_037_BASELINE (archival) — phase1_v2 distribution pin ─────────────

describe('ADR_037_BASELINE (archival phase1_v2)', () => {
  it('matches the empirically verified 2026-05-10 phase1_v2 numbers exactly', () => {
    // phase1_v2 is no longer the live classifier (ramp landed; CLASSIFIER_VERSION
    // = 'phase1_v3'). This pin remains so back-references to archived
    // phase1_v2 rows in `bt_runs_regime` stay queryable against a known
    // baseline. Do NOT update unless re-backfilling the archived phase1_v2
    // window in CH.
    assert.equal(ADR_037_BASELINE.red, 50);
    assert.equal(ADR_037_BASELINE.orange, 78);
    assert.equal(ADR_037_BASELINE.yellow, 1172);
    assert.equal(ADR_037_BASELINE.green, 3317);
    assert.equal(ADR_037_BASELINE_TRADING_DAYS, 4617);
  });
});

// ── 9b. ADR_038_BASELINE — phase1_v3 distribution pin (LIVE) ────────────────

describe('ADR_038_BASELINE (live phase1_v3)', () => {
  it('matches the empirically verified 2026-05-17 phase1_v3 numbers exactly (post s78 retune + CBOE 2003-2019 activation)', () => {
    // If this test fails, the all-time distribution under phase1_v3 has
    // shifted (e.g., npm run macro:backfill:v3 ran over a wider window, a
    // threshold-tuning PR like `VIX_TERM_COMPLACENCY_FLOOR` shifted the
    // counts, or a CBOE gap-close rerun added 2019-present data to the
    // sentiment_extreme arm). The fix is to update this constant in the
    // same PR as the threshold change, alongside re-running
    // `macroRegimeFixturesV3.test.ts`. Do NOT relax the assertion.
    //
    // History:
    //   - VIX_TERM_COMPLACENCY_FLOOR = 0.85 (session 39 ramp):
    //     red=38, orange=576, yellow=1886, green=2117 (sentiment_extreme
    //     firing on 25.77% — over-firing).
    //   - 0.80 floor, CBOE-dark for entire corpus (session 40):
    //     red=32, orange=370, yellow=1406, green=2809 (sentiment_extreme
    //     at 5.98%). Whaley 2009 §3 framing; 5% number is empirical
    //     quantile of vix_term_ratio.
    //   - Session 45 (2026-05-15) docstring claim: red=127, orange=349,
    //     yellow=1392, green=2754. The s79 probe (2026-05-17) showed
    //     CH actually held {50, 78, 1176, 3318} with 0 put_call_value_5d_ma
    //     non-null and 0 sentiment_extreme firings — the s45 claim either
    //     was overwritten by a later rerun that lost the CBOE join, or
    //     was a docstring intent that never landed.
    //   - Session 79 (2026-05-17, CURRENT): CBOE 2003-2019 arm activated
    //     via macro:backfill:v3 rerun with the s78 retune
    //     `PUT_CALL_COMPLACENCY_LOW=0.77` in effect. 2,961 / 4,622 rows
    //     carry non-null put_call MA; 556 sentiment_extreme firings.
    //     New distribution: red=131, orange=359, yellow=1473, green=2659
    //     over 4622 days. First empirically-verifiable post-CBOE pin.
    assert.equal(ADR_038_BASELINE.red, 131);
    assert.equal(ADR_038_BASELINE.orange, 359);
    assert.equal(ADR_038_BASELINE.yellow, 1473);
    assert.equal(ADR_038_BASELINE.green, 2659);
    assert.equal(ADR_038_BASELINE_TRADING_DAYS, 4622);
  });
});

// ── 10. BIAS_NOTE_PHASE1_V2 (archival) — content pin ────────────────────────

describe('BIAS_NOTE_PHASE1_V2 (archival)', () => {
  it('headline names the v2 classifier version (kept for archived references)', () => {
    assert.match(BIAS_NOTE_PHASE1_V2.headline, /phase1_v2/);
  });

  it('body explains survivorship bias', () => {
    assert.match(BIAS_NOTE_PHASE1_V2.body, /survivorship/i);
  });

  it('docLinks include ADR-037 + ≥2 supporting refs', () => {
    assert.ok(BIAS_NOTE_PHASE1_V2.docLinks.length >= 3);
    const labels = BIAS_NOTE_PHASE1_V2.docLinks.map(d => d.label).join('|');
    assert.match(labels, /ADR-037/);
  });

  it('fixtureFailures pins the historical v2 count (4) for archival accuracy', () => {
    assert.equal(BIAS_NOTE_PHASE1_V2.fixtureFailures, 4);
  });
});

// ── 10b. BIAS_NOTE_PHASE1_V3 — content + version coupling (LIVE) ────────────

describe('BIAS_NOTE_PHASE1_V3 (live)', () => {
  it('headline names the active classifier version', () => {
    assert.match(BIAS_NOTE_PHASE1_V3.headline, /phase1_v3/);
  });

  it('headline announces survivorship immunity (polarity flip from v2)', () => {
    // v2 said "Survivorship-biased"; v3 says "Survivorship-immune" — the
    // banner polarity flip is load-bearing. A future paraphrase that
    // drops the "immune" framing must update this test deliberately.
    assert.match(BIAS_NOTE_PHASE1_V3.headline, /survivorship-immune/i);
  });

  it('body names all four v3 leading indicators', () => {
    const body = BIAS_NOTE_PHASE1_V3.body;
    assert.match(body, /yield[_ ]curve/i);
    assert.match(body, /credit[_ ]stress/i);
    assert.match(body, /risk[_ ]off/i);
    assert.match(body, /sentiment/i);
  });

  it('docLinks include ADR-037 (ramp authority) + SPEC phase1_v3', () => {
    assert.ok(BIAS_NOTE_PHASE1_V3.docLinks.length >= 3);
    const labels = BIAS_NOTE_PHASE1_V3.docLinks.map(d => d.label).join('|');
    assert.match(labels, /ADR-037/);
    assert.match(labels, /SPEC phase1_v3/i);
  });

  it('fixtureFailures is 0 — v3 passes all four ADR-037 fixture windows', () => {
    // Per session 39 turn 3: scripts/tests/macroRegimeFixturesV3.test.ts
    // is green at 4/4. If this drops to >0 without the v3 fixture test
    // turning red, something is internally inconsistent — investigate.
    assert.equal(BIAS_NOTE_PHASE1_V3.fixtureFailures, 0);
  });
});
