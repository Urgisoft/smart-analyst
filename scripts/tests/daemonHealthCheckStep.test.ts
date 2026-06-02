/**
 * Tests for src/server/daemon_health_check_step.ts — the ADR-044 Phase 2 v1
 * auto-health-check daemon step (step 0a, s96 #17 Cycle 3 slice 2).
 *
 * Pins:
 *   - `buildStep0aAnomalies` returns exactly one anomaly per state.
 *   - Severity rules: probe failure → 'error'; Tier-2 pending → 'warning';
 *     non-fresh-but-no-Tier-2 → 'info' (roll-up); all-clean → 'info'
 *     heartbeat.
 *   - Tier-2 pending DOMINATES the stale roll-up (most-urgent signal wins).
 *   - `runHealthCheckStep0a` returns probeOk=true on the happy path,
 *     probeOk=false when either probe throws, and NEVER itself throws.
 *   - `runHealthCheckStep0a` survives the quarantine table being absent
 *     (graceful-degrade per Worker A's binding contract).
 *
 * No live CH — all probes are injected via the DI options surface.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStep0aAnomalies,
  runHealthCheckStep0a,
  type HealthCheckStep0aResult,
} from '../../src/server/daemon_health_check_step.js';
import type { HealthCheckResponse } from '../../src/server/health_check.js';
import type {
  QuarantineRow,
  QuarantineSummary,
} from '../../src/server/health_quarantine.js';

// ── Test fixtures ──────────────────────────────────────────────────────────

function phase1(overrides?: Partial<HealthCheckResponse>): HealthCheckResponse {
  return {
    generatedAt: '2026-05-23T12:00:00.000Z',
    sources: [],
    migrations: [],
    summary: {
      fresh: 10,
      stale: 0,
      veryStale: 0,
      missing: 0,
      neverPopulated: 0,
      expectedEmpty: 0,
      unknownCadence: 0,
      pendingMigrations: 0,
      appliedMigrations: 18,
      allGreen: true,
    },
    ...overrides,
  };
}

function quarantine(overrides?: Partial<QuarantineSummary>): QuarantineSummary {
  return {
    tier2PendingCount: 0,
    tier2AcceptedAsWarningCount: 0,
    tier2ResolvedCount: 0,
    tier1AutofixLast24hCount: 0,
    recentTier2Rows: [],
    recentTier1AutofixRows: [],
    ...overrides,
  };
}

function tier2Row(overrides?: Partial<QuarantineRow>): QuarantineRow {
  return {
    id: 'fake-uuid',
    version: '2026-05-23T12:00:00.000Z',
    detectedAt: '2026-05-23T12:00:00.000Z',
    kind: 'tier2-quarantine',
    sourceTable: 'macro_indicators_cboe',
    sourceLabel: 'CBOE put/call ratio',
    severity: 'warning',
    category: 'corrupted-input',
    offendingValue: 'stale-since-2019-10-05',
    expectedRange: 'fresh-daily',
    explanation: 'phase1_v3 corrupted-input window 2019-10-05 → 2026-05-23',
    operatorAction: 'See Q-5 in HANDOFF.md',
    status: 'pending',
    resolvedAt: null,
    resolvedBy: '',
    resolutionNote: '',
    cycleRef: 's96 #15 Cycle 1',
    adrRef: 'ADR-045',
    ...overrides,
  };
}

// ── buildStep0aAnomalies ───────────────────────────────────────────────────

describe('buildStep0aAnomalies', () => {
  it('returns exactly one anomaly in every branch', () => {
    const cases: Array<readonly [HealthCheckResponse | null, QuarantineSummary | null]> = [
      [null, null],
      [phase1(), null],
      [phase1(), quarantine()],
      [phase1({ summary: { ...phase1().summary, fresh: 5, stale: 3 } }), quarantine()],
      [phase1(), quarantine({ tier2PendingCount: 2, recentTier2Rows: [tier2Row()] })],
    ];
    for (const [p, q] of cases) {
      const out = buildStep0aAnomalies(p, q);
      assert.equal(out.length, 1, `single-anomaly contract broken for inputs phase1=${p ? 'set' : 'null'} q=${q ? 'set' : 'null'}`);
    }
  });

  it('phase1=null → severity error with a clear operator-action hint', () => {
    const [a] = buildStep0aAnomalies(null, null);
    assert.equal(a.severity, 'error');
    assert.match(a.message, /probe failed/i);
    assert.match(a.message, /npm run health:check/);
  });

  it('all-clean → severity info heartbeat with the fresh count', () => {
    const p = phase1({
      sources: [{
        name: 'x', label: 'x', cadence: 'daily', autonomous: true,
        lastUpdateAt: '2026-05-23T11:00:00Z', lastUpdateAgeHours: 1,
        rowCount: 100, status: 'fresh', message: '', operatorAction: '', why: '',
      }],
    });
    const [a] = buildStep0aAnomalies(p, quarantine());
    assert.equal(a.severity, 'info');
    assert.match(a.message, /Health digest clean/);
    assert.match(a.message, /fresh=10/, 'must surface the fresh count from the Phase 1 summary');
    assert.match(a.message, /of 1 sources/, 'must surface the sources array length');
  });

  it('Tier-2 pending >= 1 → severity warning with count + top row label', () => {
    const q = quarantine({
      tier2PendingCount: 3,
      recentTier2Rows: [tier2Row()],
    });
    const [a] = buildStep0aAnomalies(phase1(), q);
    assert.equal(a.severity, 'warning');
    assert.match(a.message, /3 Tier-2 pending/);
    assert.match(a.message, /CBOE put\/call ratio/);
    assert.match(a.message, /ADR-045/);
    assert.match(a.message, /\/#\/health/);
  });

  it('Tier-2 pending WINS OVER stale-only roll-up (most-urgent signal dominates)', () => {
    // Phase 1 shows non-fresh sources AND quarantine has pending rows.
    // The warning anomaly must surface (NOT the info roll-up).
    const p = phase1({
      summary: { ...phase1().summary, fresh: 7, stale: 3, veryStale: 0 },
    });
    const q = quarantine({
      tier2PendingCount: 1,
      recentTier2Rows: [tier2Row()],
    });
    const [a] = buildStep0aAnomalies(p, q);
    assert.equal(a.severity, 'warning', 'Tier-2 pending must dominate');
    assert.match(a.message, /Tier-2 pending/);
    assert.doesNotMatch(a.message, /non-fresh source/);
  });

  it('non-fresh-but-no-Tier-2 → severity info with the stale roll-up counts', () => {
    const p = phase1({
      summary: {
        ...phase1().summary,
        fresh: 5,
        stale: 2,
        veryStale: 1,
        missing: 1,
        neverPopulated: 2,
      },
    });
    const [a] = buildStep0aAnomalies(p, quarantine());
    assert.equal(a.severity, 'info');
    assert.match(a.message, /non-fresh source/);
    assert.match(a.message, /stale=2/);
    assert.match(a.message, /very-stale=1/);
    assert.match(a.message, /missing=1/);
    assert.match(a.message, /empty=2/);
    assert.match(a.message, /\/#\/health/);
  });

  it('quarantine=null AND Phase 1 clean → still emits heartbeat (graceful-degrade)', () => {
    // Pre-migration state: the quarantine table doesn't exist yet, but
    // Phase 1 still ran. The step 0a anomaly must surface as the clean
    // heartbeat (not as a probe failure).
    const [a] = buildStep0aAnomalies(phase1(), null);
    assert.equal(a.severity, 'info');
    assert.match(a.message, /Health digest clean/);
  });

  it('quarantine=null AND Phase 1 stale → emits the stale roll-up', () => {
    const p = phase1({ summary: { ...phase1().summary, fresh: 5, stale: 2 } });
    const [a] = buildStep0aAnomalies(p, null);
    assert.equal(a.severity, 'info');
    assert.match(a.message, /non-fresh source/);
    assert.match(a.message, /stale=2/);
  });

  it('Tier-2 top row with empty adrRef falls back to placeholder', () => {
    // Defensive: a Tier-2 row created without an adrRef (e.g. ad-hoc daemon
    // insertion before an ADR is drafted) must still render a clean message.
    const q = quarantine({
      tier2PendingCount: 1,
      recentTier2Rows: [tier2Row({ adrRef: '' })],
    });
    const [a] = buildStep0aAnomalies(phase1(), q);
    assert.match(a.message, /ADR-tbd/);
  });
});

// ── runHealthCheckStep0a (impure runner with DI) ───────────────────────────

describe('runHealthCheckStep0a', () => {
  it('happy path: both probes succeed → probeOk=true + populated result', async () => {
    const result = await runHealthCheckStep0a({
      runHealthCheckFn: async () => phase1(),
      quarantineTableExistsFn: async () => true,
      loadQuarantineSummaryFn: async () => quarantine(),
      now: () => new Date('2026-05-23T12:00:00Z'),
    });
    assert.equal(result.probeOk, true);
    assert.notEqual(result.phase1, null);
    assert.notEqual(result.quarantine, null);
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.ranAt, '2026-05-23T12:00:00.000Z');
  });

  it('quarantine table absent → probeOk=true, quarantine=null, Phase 1 result preserved', async () => {
    const result = await runHealthCheckStep0a({
      runHealthCheckFn: async () => phase1(),
      quarantineTableExistsFn: async () => false,
      // loadQuarantineSummaryFn intentionally omitted — should NOT be called
      // when the table is absent.
      now: () => new Date('2026-05-23T12:00:00Z'),
    });
    assert.equal(result.probeOk, true, 'absent table is NOT an error — graceful-degrade');
    assert.notEqual(result.phase1, null);
    assert.equal(result.quarantine, null);
  });

  it('Phase 1 throws → probeOk=false, phase1=null, quarantine=null, one error anomaly', async () => {
    const result = await runHealthCheckStep0a({
      runHealthCheckFn: async () => { throw new Error('CH unreachable'); },
      // The quarantine fns should NOT be called once Phase 1 fails — but
      // provide stubs that would throw if invoked to catch a regression.
      quarantineTableExistsFn: async () => { throw new Error('should not be called'); },
      loadQuarantineSummaryFn: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.probeOk, false);
    assert.equal(result.phase1, null);
    assert.equal(result.quarantine, null);
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].severity, 'error');
  });

  it('quarantine probe throws → probeOk=false, Phase 1 result still surfaced', async () => {
    const result = await runHealthCheckStep0a({
      runHealthCheckFn: async () => phase1(),
      quarantineTableExistsFn: async () => true,
      loadQuarantineSummaryFn: async () => { throw new Error('quarantine read failed'); },
    });
    assert.equal(result.probeOk, false, 'quarantine probe failure → probeOk false');
    assert.notEqual(result.phase1, null, 'Phase 1 result MUST survive a quarantine failure');
    assert.equal(result.quarantine, null);
    // Anomaly should reflect Phase 1's clean state (no Tier-2 detail).
    assert.equal(result.anomalies[0].severity, 'info');
  });

  it('table-exists probe throws → probeOk=false, Phase 1 result still surfaced', async () => {
    const result = await runHealthCheckStep0a({
      runHealthCheckFn: async () => phase1(),
      quarantineTableExistsFn: async () => { throw new Error('table-exists probe failed'); },
    });
    assert.equal(result.probeOk, false);
    assert.notEqual(result.phase1, null);
    assert.equal(result.quarantine, null);
  });

  it('NEVER throws — defensive contract for the daemon caller', async () => {
    // Stub every probe to throw. The runner must still return cleanly with
    // probeOk=false. Defense in depth: the daemon's try/catch is the second
    // line; this is the first.
    const result: HealthCheckStep0aResult = await runHealthCheckStep0a({
      runHealthCheckFn: () => { throw new Error('sync throw'); },
      quarantineTableExistsFn: () => { throw new Error('sync throw'); },
      loadQuarantineSummaryFn: () => { throw new Error('sync throw'); },
    });
    assert.equal(result.probeOk, false);
    assert.equal(result.anomalies.length, 1, 'still emits the canonical one-anomaly result');
  });
});
