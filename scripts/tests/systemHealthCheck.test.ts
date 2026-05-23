/**
 * Tests for scripts/system_health_check.ts — ADR-044 Phase 2 v1 dispatcher
 * (Cycle 3 Worker A).
 *
 * Coverage:
 *   - Phase 1 + Phase 2 v1 composition: when the quarantine table exists,
 *     buildReport spreads both blocks.
 *   - Graceful degradation: when the quarantine table is absent,
 *     buildReport returns null in `quarantine` instead of throwing.
 *
 * No CH dependency — all CH-bound callers are injected via the options.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../system_health_check.js';
import type { HealthCheckResponse } from '../../src/server/health_check.js';
import type { QuarantineSummary } from '../../src/server/health_quarantine.js';

function fakePhase1(): HealthCheckResponse {
  return {
    generatedAt: '2026-05-24T12:00:00.000Z',
    sources: [],
    migrations: [],
    summary: {
      fresh: 0, stale: 0, veryStale: 0, missing: 0, neverPopulated: 0, unknownCadence: 0,
      pendingMigrations: 0, appliedMigrations: 0, allGreen: true,
    },
  };
}

function fakeSummary(): QuarantineSummary {
  return {
    tier2PendingCount: 1,
    tier2AcceptedAsWarningCount: 1,
    tier2ResolvedCount: 0,
    tier1AutofixLast24hCount: 0,
    recentTier2Rows: [],
    recentTier1AutofixRows: [],
  };
}

describe('buildReport — composition', () => {
  it('loads Phase 1 + quarantine summary when the table exists', async () => {
    let loadCalls = 0;
    const report = await buildReport({
      runHealthCheck: async () => fakePhase1(),
      quarantineTableExists: async () => true,
      loadQuarantineSummary: async () => { loadCalls++; return fakeSummary(); },
    });
    assert.equal(loadCalls, 1, 'loadQuarantineSummary called exactly once when table exists');
    assert.equal(report.generatedAt, '2026-05-24T12:00:00.000Z');
    assert.ok(report.quarantine);
    assert.equal(report.quarantine?.tier2PendingCount, 1);
    assert.equal(report.quarantine?.tier2AcceptedAsWarningCount, 1);
  });

  it('skips quarantine load when the table is absent — returns null', async () => {
    let loadCalls = 0;
    const report = await buildReport({
      runHealthCheck: async () => fakePhase1(),
      quarantineTableExists: async () => false,
      loadQuarantineSummary: async () => { loadCalls++; return fakeSummary(); },
    });
    assert.equal(loadCalls, 0, 'loadQuarantineSummary must NOT be called when table absent');
    assert.equal(report.quarantine, null);
    // Phase 1 still loads normally.
    assert.equal(report.phase1.summary.allGreen, true);
  });

  it('propagates the Phase 1 generatedAt as the report generatedAt', async () => {
    const report = await buildReport({
      runHealthCheck: async () => ({
        ...fakePhase1(),
        generatedAt: '2026-12-31T23:59:59.000Z',
      }),
      quarantineTableExists: async () => true,
      loadQuarantineSummary: async () => fakeSummary(),
    });
    assert.equal(report.generatedAt, '2026-12-31T23:59:59.000Z');
  });
});
