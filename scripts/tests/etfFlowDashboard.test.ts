/**
 * Tests for src/server/etf_flow_dashboard.ts builder mode dispatch
 * (Cycle 20 / s96 #19 — secondary-only fallback when v1 primary is dark).
 *
 * The original builder used AND-logic on primary AND secondary; with v1
 * yfinance dead since 2026-05-19 (S96-89), this caused the /#/etf-flow
 * UI to render the empty-state in production. ADR-049 + Q-6 demand a
 * secondary-only fallback render path.
 *
 * Pure-function tests — no CH dependency.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEtfFlowCrossValidationState,
  buildSecondaryLatest,
} from '../../src/server/etf_flow_dashboard.js';
import type {
  EtfFlowPrimaryPoint,
  EtfFlowSecondaryPoint,
} from '../../src/server/etf_flow_cross_validation.js';

const ASOF = new Date('2026-05-24T12:00:00Z');
const UNIVERSE = ['SPY', 'IVV', 'QQQ'] as const;

function makeSecondary(rows: Array<[string, string, number, number]>): EtfFlowSecondaryPoint[] {
  return rows.map(([ticker, date, shares, close]) => ({ ticker, date, shares, close }));
}

function makePrimary(rows: Array<[string, string, number, number]>): EtfFlowPrimaryPoint[] {
  return rows.map(([ticker, date, shares, close]) => ({ ticker, date, shares, close }));
}

describe('buildEtfFlowCrossValidationState — mode dispatch (T-EFD-1..T-EFD-4)', () => {
  it('T-EFD-1 empty mode when both panels are empty', () => {
    const r = buildEtfFlowCrossValidationState({
      asOf: ASOF,
      lookbackDays: 90,
      tickers: UNIVERSE,
      primary: [],
      secondary: [],
      primaryTableExists: true,
      secondaryTableExists: true,
    });
    assert.equal(r.mode, 'empty');
    assert.equal(r.hasData, false);
    assert.equal(r.summary, null);
    assert.equal(r.secondaryLatest, null);
    assert.equal(r.counts.primaryRows, 0);
    assert.equal(r.counts.secondaryRows, 0);
  });

  it('T-EFD-2 empty mode when secondary table missing AND primary empty (operator-bootstrap case)', () => {
    const r = buildEtfFlowCrossValidationState({
      asOf: ASOF,
      lookbackDays: 90,
      tickers: UNIVERSE,
      primary: [],
      secondary: [],
      primaryTableExists: false,
      secondaryTableExists: false,
    });
    assert.equal(r.mode, 'empty');
    assert.equal(r.hasData, false);
  });

  it('T-EFD-3 secondary-only mode when v1 primary dark but secondary has data (S96-89 / ADR-049)', () => {
    const secondary = makeSecondary([
      ['SPY', '2026-05-22', 900_000_000, 580.0],
      ['SPY', '2026-05-23', 902_500_000, 581.5],
      ['IVV', '2026-05-23', 800_000_000, 620.0],
    ]);
    const r = buildEtfFlowCrossValidationState({
      asOf: ASOF,
      lookbackDays: 90,
      tickers: UNIVERSE,
      primary: [],
      secondary,
      primaryTableExists: true,   // table exists, just no rows in window
      secondaryTableExists: true,
    });
    assert.equal(r.mode, 'secondary-only');
    assert.equal(r.hasData, true,
      'secondary-only mode MUST set hasData=true so the UI does not render empty-state');
    assert.equal(r.summary, null,
      'cross-validation summary is meaningless when one side is empty');
    assert.ok(r.secondaryLatest, 'secondaryLatest must be populated in secondary-only mode');
    assert.equal(r.secondaryLatest!.length, 2);
    // Sorted by ticker ASC
    assert.equal(r.secondaryLatest![0].ticker, 'IVV');
    assert.equal(r.secondaryLatest![1].ticker, 'SPY');
    // SPY has 2 rows, day-over-day delta computed
    const spy = r.secondaryLatest![1];
    assert.equal(spy.date, '2026-05-23');
    assert.equal(spy.shares, 902_500_000);
    assert.equal(spy.previousDate, '2026-05-22');
    assert.equal(spy.previousShares, 900_000_000);
    assert.ok(spy.sharesPctDelta != null);
    assert.ok(Math.abs(spy.sharesPctDelta! - (902_500_000 - 900_000_000) / 900_000_000) < 1e-12);
    // AUM = shares × close
    assert.ok(Math.abs(spy.aum - 902_500_000 * 581.5) < 1e-6);
    // IVV has 1 row, no prior, no delta
    const ivv = r.secondaryLatest![0];
    assert.equal(ivv.previousDate, null);
    assert.equal(ivv.previousShares, null);
    assert.equal(ivv.sharesPctDelta, null);
    assert.equal(ivv.rowCount, 1);
  });

  it('T-EFD-4 cross-validation mode when both panels have data', () => {
    const primary = makePrimary([
      ['SPY', '2026-05-22', 900_000_000, 580.0],
    ]);
    const secondary = makeSecondary([
      ['SPY', '2026-05-22', 902_000_000, 580.0],
    ]);
    const r = buildEtfFlowCrossValidationState({
      asOf: ASOF,
      lookbackDays: 90,
      tickers: UNIVERSE,
      primary,
      secondary,
      primaryTableExists: true,
      secondaryTableExists: true,
    });
    assert.equal(r.mode, 'cross-validation');
    assert.equal(r.hasData, true);
    assert.ok(r.summary, 'summary populated in cross-validation mode');
    assert.equal(r.secondaryLatest, null,
      'secondaryLatest stays null in cross-validation mode');
    assert.ok(r.summary!.totalCompared >= 1);
  });
});

describe('buildSecondaryLatest — per-ticker collapse (T-EFD-5)', () => {
  it('T-EFD-5a sorts tickers ASC and picks latest date per ticker', () => {
    const secondary = makeSecondary([
      ['TLT', '2026-05-22', 300_000_000, 92.5],
      ['SPY', '2026-05-23', 902_500_000, 581.5],
      ['SPY', '2026-05-22', 900_000_000, 580.0],
      ['HYG', '2026-05-23', 250_000_000, 78.0],
    ]);
    const out = buildSecondaryLatest(secondary);
    assert.deepEqual(out.map(r => r.ticker), ['HYG', 'SPY', 'TLT']);
    assert.equal(out.find(r => r.ticker === 'SPY')!.date, '2026-05-23');
    assert.equal(out.find(r => r.ticker === 'SPY')!.shares, 902_500_000);
    assert.equal(out.find(r => r.ticker === 'TLT')!.rowCount, 1);
  });

  it('T-EFD-5b NaN-safe AUM + null-safe pct delta with zero previous shares', () => {
    const secondary = makeSecondary([
      ['ZZZ', '2026-05-22', 0, 100],
      ['ZZZ', '2026-05-23', 1_000_000, 100],
    ]);
    const out = buildSecondaryLatest(secondary);
    assert.equal(out.length, 1);
    // previous shares = 0 → pct delta is null (avoid div-by-zero)
    assert.equal(out[0].sharesPctDelta, null);
    assert.equal(out[0].previousShares, 0);
  });
});
