/**
 * Tests for Cycle 33 slice 3b — the EtfFlow cross-validation anomaly scan
 * (the bug-finding-first overlay retrofit onto the bespoke EtfFlowApp).
 *
 * Covers scanEtfFlowAnomalies across all three response modes:
 *   - empty → no anomalies (the EmptyState explains it)
 *   - secondary-only → PRIMARY_DARK warn (cross-validation blind)
 *   - cross-validation → clean / DIVERGENCE warn / CRITICAL_DIVERGENCE crit /
 *     IMPLAUSIBLE_DIVERGENCE crit, sorted worst-first, with the worst-suffix.
 *
 * No DOM, no CH — pure function over hand-built response fixtures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanEtfFlowAnomalies,
  IMPLAUSIBLE_SHARES_PCT,
} from '../../src/components/etfFlow/etfFlowAnomalyScan.js';
import type {
  EtfFlowCrossValidationStateResponse,
} from '../../src/server/etf_flow_dashboard.js';
import type {
  EtfFlowCrossValidationSummary,
  EtfFlowDivergence,
} from '../../src/server/etf_flow_cross_validation.js';

function divergence(over: Partial<EtfFlowDivergence> = {}): EtfFlowDivergence {
  return {
    ticker: 'SPY', date: '2026-05-20',
    primaryShares: 1_000_000, secondaryShares: 900_000, sharesPctDiff: 0.1,
    primaryAum: 5e11, secondaryAum: 4.5e11, aumPctDiff: 0.1,
    severity: 'critical',
    ...over,
  };
}

function summary(over: Partial<EtfFlowCrossValidationSummary> = {}): EtfFlowCrossValidationSummary {
  return {
    totalCompared: 100,
    divergenceCount: 0,
    maxAbsSharesPctDiff: 0,
    maxAbsAumPctDiff: 0,
    byTicker: {},
    bySeverity: { info: 0, warn: 0, critical: 0 },
    topDivergences: [],
    secondarySourceLabel: 'SSGA SPDR',
    ...over,
  };
}

function resp(over: Partial<EtfFlowCrossValidationStateResponse> = {}): EtfFlowCrossValidationStateResponse {
  return {
    hasData: true,
    mode: 'cross-validation',
    asOf: '2026-05-28',
    lookbackDays: 90,
    tickers: ['SPY'],
    summary: summary(),
    secondaryLatest: null,
    counts: { primaryRows: 100, secondaryRows: 100, primaryTableExists: true, secondaryTableExists: true },
    ...over,
  };
}

describe('scanEtfFlowAnomalies — modes', () => {
  it('empty mode → no anomalies (EmptyState explains it)', () => {
    const a = scanEtfFlowAnomalies(resp({ mode: 'empty', hasData: false, summary: null }));
    assert.equal(a.length, 0);
  });

  it('secondary-only → one PRIMARY_DARK warn, no divergence scan', () => {
    const a = scanEtfFlowAnomalies(resp({ mode: 'secondary-only', summary: null, secondaryLatest: [] }));
    assert.equal(a.length, 1);
    assert.equal(a[0].code, 'PRIMARY_DARK');
    assert.equal(a[0].severity, 'warn');
    assert.match(a[0].message, /cross-validation is blind/);
    assert.match(a[0].message, /Q-6/);
  });

  it('cross-validation clean → no anomalies (green banner)', () => {
    const a = scanEtfFlowAnomalies(resp());
    assert.equal(a.length, 0);
  });

  it('cross-validation with summary=null → defensively empty', () => {
    const a = scanEtfFlowAnomalies(resp({ summary: null }));
    assert.equal(a.length, 0);
  });
});

describe('scanEtfFlowAnomalies — divergence tiers', () => {
  it('warn-only divergences → DIVERGENCE warn', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({ divergenceCount: 3, bySeverity: { info: 1, warn: 3, critical: 0 }, maxAbsSharesPctDiff: 0.03 }),
    }));
    assert.equal(a.length, 1);
    assert.equal(a[0].code, 'DIVERGENCE');
    assert.equal(a[0].severity, 'warn');
    assert.match(a[0].message, /3 ticker-days/);
  });

  it('critical divergences → CRITICAL_DIVERGENCE crit with worst suffix', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({
        divergenceCount: 2,
        bySeverity: { info: 0, warn: 0, critical: 2 },
        maxAbsSharesPctDiff: 0.08,
        topDivergences: [divergence({ ticker: 'XLF', date: '2026-05-19', sharesPctDiff: 0.082 })],
      }),
    }));
    const crit = a.find(x => x.code === 'CRITICAL_DIVERGENCE');
    assert.ok(crit);
    assert.equal(crit?.severity, 'critical');
    assert.match(crit!.message, /materially disagree/);
    assert.match(crit!.message, /worst: XLF \+8\.2% on 2026-05-19/);
  });

  it('singular "ticker-day" when count is 1', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({ divergenceCount: 1, bySeverity: { info: 0, warn: 0, critical: 1 }, maxAbsSharesPctDiff: 0.06 }),
    }));
    const crit = a.find(x => x.code === 'CRITICAL_DIVERGENCE');
    assert.match(crit!.message, /1 ticker-day diverge/);
  });

  it('implausible |Δshares| → IMPLAUSIBLE_DIVERGENCE crit (units/source bug)', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({ divergenceCount: 1, bySeverity: { info: 0, warn: 0, critical: 1 }, maxAbsSharesPctDiff: 0.73 }),
    }));
    const imp = a.find(x => x.code === 'IMPLAUSIBLE_DIVERGENCE');
    assert.ok(imp);
    assert.equal(imp?.severity, 'critical');
    assert.match(imp!.message, /73\.0%/);
    assert.match(imp!.message, /units \/ split-adjustment \/ stale-feed bug/);
  });

  it('IMPLAUSIBLE_SHARES_PCT is the 50% heuristic floor', () => {
    assert.equal(IMPLAUSIBLE_SHARES_PCT, 0.5);
    // exactly at the floor fires (>=)
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({ bySeverity: { info: 0, warn: 0, critical: 1 }, maxAbsSharesPctDiff: 0.5 }),
    }));
    assert.ok(a.some(x => x.code === 'IMPLAUSIBLE_DIVERGENCE'));
    // just below does not
    const b = scanEtfFlowAnomalies(resp({
      summary: summary({ bySeverity: { info: 0, warn: 0, critical: 1 }, maxAbsSharesPctDiff: 0.49 }),
    }));
    assert.ok(!b.some(x => x.code === 'IMPLAUSIBLE_DIVERGENCE'));
  });

  it('sorts worst-first: implausible+critical (crit) before warn', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({
        divergenceCount: 5,
        bySeverity: { info: 0, warn: 2, critical: 3 },
        maxAbsSharesPctDiff: 0.6,
        topDivergences: [divergence({ sharesPctDiff: 0.6 })],
      }),
    }));
    // 3 anomalies: IMPLAUSIBLE_DIVERGENCE(crit), CRITICAL_DIVERGENCE(crit), DIVERGENCE(warn)
    assert.equal(a.length, 3);
    assert.equal(a[0].severity, 'critical');
    assert.equal(a[1].severity, 'critical');
    assert.equal(a[2].severity, 'warn');
    assert.equal(a[2].code, 'DIVERGENCE');
  });

  it('critical with empty topDivergences → no worst suffix (no crash)', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({ bySeverity: { info: 0, warn: 0, critical: 1 }, maxAbsSharesPctDiff: 0.07, topDivergences: [] }),
    }));
    const crit = a.find(x => x.code === 'CRITICAL_DIVERGENCE');
    assert.ok(crit);
    assert.doesNotMatch(crit!.message, /worst:/);
  });

  it('info-tier divergences alone are NOT surfaced (expected noise)', () => {
    const a = scanEtfFlowAnomalies(resp({
      summary: summary({ divergenceCount: 4, bySeverity: { info: 4, warn: 0, critical: 0 }, maxAbsSharesPctDiff: 0.015 }),
    }));
    assert.equal(a.length, 0);
  });
});
