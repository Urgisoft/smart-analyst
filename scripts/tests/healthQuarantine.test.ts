/**
 * Tests for src/server/health_quarantine.ts — the ADR-044 Phase 2 v1
 * quarantine repository + pure summary categorizer (Cycle 3 Worker A).
 *
 * Coverage:
 *   - Pure `computeQuarantineSummary`:
 *       - Cold-start (zero rows).
 *       - Tier-2 pending only.
 *       - Mixed Tier-2 statuses (pending / accepted-as-warning / approved /
 *         corrected).
 *       - Tier-1 autofix rows inside + outside the 24h window.
 *       - Recency-sort + cap at top 5 per bucket.
 *       - Status-priority sort within Tier-2 (pending → warning → resolved).
 *
 * No CH dependency — the impure load/insert paths are exercised via the
 * `npm run system-health:check` smoke + migration apply.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeQuarantineSummary,
  type QuarantineRow,
} from '../../src/server/health_quarantine.js';

function row(overrides: Partial<QuarantineRow> & Pick<QuarantineRow, 'id' | 'kind' | 'detectedAt'>):
  QuarantineRow {
  return {
    id: overrides.id,
    version: overrides.version ?? overrides.detectedAt,
    detectedAt: overrides.detectedAt,
    kind: overrides.kind,
    sourceTable: overrides.sourceTable ?? 'macro_indicators_cboe',
    sourceLabel: overrides.sourceLabel ?? 'CBOE put/call ratio',
    severity: overrides.severity ?? 'warning',
    category: overrides.category ?? 'corrupted-input-window',
    offendingValue: overrides.offendingValue ?? 'test',
    expectedRange: overrides.expectedRange ?? '',
    explanation: overrides.explanation ?? 'test explanation',
    operatorAction: overrides.operatorAction ?? '',
    status: overrides.status ?? 'pending',
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? '',
    resolutionNote: overrides.resolutionNote ?? '',
    cycleRef: overrides.cycleRef ?? '',
    adrRef: overrides.adrRef ?? '',
  };
}

const NOW = new Date('2026-05-24T12:00:00.000Z');

// Helper: a timestamp `hoursAgo` hours before NOW, as ISO 8601.
function isoHoursAgo(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
}

describe('computeQuarantineSummary — cold start', () => {
  it('zero rows: all counts zero, both recent arrays empty', () => {
    const s = computeQuarantineSummary([], NOW);
    assert.equal(s.tier2PendingCount, 0);
    assert.equal(s.tier2AcceptedAsWarningCount, 0);
    assert.equal(s.tier2ResolvedCount, 0);
    assert.equal(s.tier1AutofixLast24hCount, 0);
    assert.deepEqual([...s.recentTier2Rows], []);
    assert.deepEqual([...s.recentTier1AutofixRows], []);
  });
});

describe('computeQuarantineSummary — Tier-2 pending only', () => {
  it('counts pending and surfaces in recent rows', () => {
    const rows = [
      row({ id: 'a', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(1), status: 'pending' }),
      row({ id: 'b', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(48), status: 'pending' }),
    ];
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier2PendingCount, 2);
    assert.equal(s.tier2AcceptedAsWarningCount, 0);
    assert.equal(s.tier2ResolvedCount, 0);
    assert.equal(s.recentTier2Rows.length, 2);
    // Pending first → newer pending wins among the two pending rows.
    assert.equal(s.recentTier2Rows[0].id, 'a');
    assert.equal(s.recentTier2Rows[1].id, 'b');
  });
});

describe('computeQuarantineSummary — Tier-2 status mix sorted by priority', () => {
  it('pending → accepted-as-warning → resolved, newest first within tier', () => {
    const rows = [
      // Older pending and newer pending — newer wins.
      row({ id: 'pend-old', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(72), status: 'pending' }),
      row({ id: 'pend-new', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(2), status: 'pending' }),
      // Warning row (the Q-5 shape).
      row({ id: 'warn', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(24), status: 'accepted-as-warning' }),
      // Resolved rows.
      row({ id: 'res-approved', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(48), status: 'approved' }),
      row({ id: 'res-corrected', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(96), status: 'corrected' }),
    ];
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier2PendingCount, 2);
    assert.equal(s.tier2AcceptedAsWarningCount, 1);
    assert.equal(s.tier2ResolvedCount, 2);
    // Order: pend-new, pend-old, warn, res-approved (newer), res-corrected.
    assert.deepEqual(
      s.recentTier2Rows.map(r => r.id),
      ['pend-new', 'pend-old', 'warn', 'res-approved', 'res-corrected'],
    );
  });

  it('top 5 cap holds — extra rows are dropped', () => {
    const rows: QuarantineRow[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(row({
        id: `pend-${i}`,
        kind: 'tier2-quarantine',
        detectedAt: isoHoursAgo(i),
        status: 'pending',
      }));
    }
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier2PendingCount, 10);
    assert.equal(s.recentTier2Rows.length, 5);
    // Newest first → pend-0..pend-4.
    assert.deepEqual(
      s.recentTier2Rows.map(r => r.id),
      ['pend-0', 'pend-1', 'pend-2', 'pend-3', 'pend-4'],
    );
  });
});

describe('computeQuarantineSummary — Tier-1 autofix 24h windowing', () => {
  it('rows inside the 24h window count; rows outside do not', () => {
    const rows = [
      // 1h ago — inside.
      row({ id: 'in-1', kind: 'tier1-autofix', detectedAt: isoHoursAgo(1), status: 'auto-fixed' }),
      // 23h ago — inside.
      row({ id: 'in-23', kind: 'tier1-autofix', detectedAt: isoHoursAgo(23), status: 'auto-fixed' }),
      // 24h ago — inside (boundary inclusive).
      row({ id: 'in-24', kind: 'tier1-autofix', detectedAt: isoHoursAgo(24), status: 'auto-fixed' }),
      // 25h ago — outside.
      row({ id: 'out-25', kind: 'tier1-autofix', detectedAt: isoHoursAgo(25), status: 'auto-fixed' }),
      // 100h ago — outside.
      row({ id: 'out-100', kind: 'tier1-autofix', detectedAt: isoHoursAgo(100), status: 'auto-fixed' }),
    ];
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier1AutofixLast24hCount, 3);
    assert.deepEqual(
      s.recentTier1AutofixRows.map(r => r.id),
      ['in-1', 'in-23', 'in-24'],
    );
  });

  it('Tier-1 rows do not pollute Tier-2 counts', () => {
    const rows = [
      row({ id: 'a', kind: 'tier1-autofix', detectedAt: isoHoursAgo(1), status: 'auto-fixed' }),
      row({ id: 'b', kind: 'tier1-autofix', detectedAt: isoHoursAgo(2), status: 'auto-fixed' }),
    ];
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier2PendingCount, 0);
    assert.equal(s.tier2AcceptedAsWarningCount, 0);
    assert.equal(s.tier2ResolvedCount, 0);
    assert.deepEqual([...s.recentTier2Rows], []);
    assert.equal(s.tier1AutofixLast24hCount, 2);
  });

  it('Tier-2 rows do not pollute Tier-1 counts', () => {
    const rows = [
      row({ id: 'a', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(1), status: 'pending' }),
      row({ id: 'b', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(2), status: 'pending' }),
    ];
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier1AutofixLast24hCount, 0);
    assert.deepEqual([...s.recentTier1AutofixRows], []);
  });

  it('Tier-1 top 5 cap holds', () => {
    const rows: QuarantineRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(row({
        id: `fix-${i}`,
        kind: 'tier1-autofix',
        detectedAt: isoHoursAgo(i),
        status: 'auto-fixed',
      }));
    }
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier1AutofixLast24hCount, 8);
    assert.equal(s.recentTier1AutofixRows.length, 5);
    // Newest first.
    assert.deepEqual(
      s.recentTier1AutofixRows.map(r => r.id),
      ['fix-0', 'fix-1', 'fix-2', 'fix-3', 'fix-4'],
    );
  });
});

describe('computeQuarantineSummary — mixed Tier-1 + Tier-2', () => {
  it('summary holds both buckets independently', () => {
    const rows = [
      row({ id: 't2a', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(1), status: 'pending' }),
      row({ id: 't2b', kind: 'tier2-quarantine', detectedAt: isoHoursAgo(24), status: 'accepted-as-warning' }),
      row({ id: 't1a', kind: 'tier1-autofix', detectedAt: isoHoursAgo(2), status: 'auto-fixed' }),
      row({ id: 't1b', kind: 'tier1-autofix', detectedAt: isoHoursAgo(30), status: 'auto-fixed' }), // outside
    ];
    const s = computeQuarantineSummary(rows, NOW);
    assert.equal(s.tier2PendingCount, 1);
    assert.equal(s.tier2AcceptedAsWarningCount, 1);
    assert.equal(s.tier1AutofixLast24hCount, 1);
    assert.equal(s.recentTier2Rows.length, 2);
    assert.equal(s.recentTier1AutofixRows.length, 1);
  });
});
