/**
 * Tests for src/server/health_check.ts — the ADR-044 Phase 1 standing
 * system-health orchestrator powering /api/health/state + the /#/health
 * dashboard + the `npm run health:check` CLI.
 *
 * SPEC: docs/specs/adr-044-standing-system-health-ownership.md.
 * Audit: docs/audits/system-reconciliation-2026-05.md.
 *
 * Contract pinned here:
 *   - classifyStatus respects the cadence-relative thresholds and the
 *     special-case ordering (missing-table > rowCount=0 > age-based).
 *   - summarize aggregates correctly across status tiers + migration
 *     applied/pending.
 *   - The summary's `allGreen` flag fires only when EVERY source is
 *     fresh AND every migration is applied.
 *   - HEALTH_SOURCES + HEALTH_MIGRATIONS are non-empty and don't
 *     accidentally drift (regression anchor for new slices that should
 *     also surface here).
 *   - HEALTH_SOURCES correctly tags the operator-cadence vs autonomous
 *     split (the reconciliation §3.1 finding) — every SEC EDGAR ingest
 *     surface is operator-cadence; every snapshot table is autonomous.
 *
 * No CH dependency in this test — pure helpers only. Live CH probes are
 * exercised by manual smoke after panel ship.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEALTH_MIGRATIONS,
  HEALTH_SOURCES,
  CADENCE_THRESHOLDS_HOURS,
  classifyStatus,
  summarize,
  type HealthMigrationProbe,
  type HealthSourceProbe,
} from '../../src/server/health_check.js';

// ───── classifyStatus ──────────────────────────────────────────────────────

describe('classifyStatus', () => {
  it('returns missing-table when tableExists=false regardless of other inputs', () => {
    assert.equal(classifyStatus('daily', 0, -1, false), 'missing-table');
    assert.equal(classifyStatus('daily', 10000, 0.1, false), 'missing-table');
  });

  it('returns never-populated when rowCount=0 and table exists', () => {
    assert.equal(classifyStatus('daily', 0, -1, true), 'never-populated');
    assert.equal(classifyStatus('event-driven', 0, 100, true), 'never-populated');
  });

  it('returns unknown-cadence when age is unmeasurable but table has rows', () => {
    assert.equal(classifyStatus('daily', 50, -1, true), 'unknown-cadence');
    assert.equal(classifyStatus('daily', 1, Number.NaN, true), 'unknown-cadence');
    assert.equal(classifyStatus('daily', 1, Number.POSITIVE_INFINITY, true), 'unknown-cadence');
  });

  it('classifies daily cadence at the SPEC thresholds', () => {
    // daily fresh < 30h, stale 30-72h, very-stale >72h
    assert.equal(classifyStatus('daily', 100, 0, true), 'fresh');
    assert.equal(classifyStatus('daily', 100, 29, true), 'fresh');
    assert.equal(classifyStatus('daily', 100, 30, true), 'fresh', 'boundary inclusive on fresh');
    assert.equal(classifyStatus('daily', 100, 30.1, true), 'stale');
    assert.equal(classifyStatus('daily', 100, 71, true), 'stale');
    assert.equal(classifyStatus('daily', 100, 72, true), 'stale', 'boundary inclusive on stale');
    assert.equal(classifyStatus('daily', 100, 73, true), 'very-stale');
  });

  it('classifies event-driven cadence with a longer grace window', () => {
    // event-driven fresh < 7d (168h), stale 7-14d (168-336h), very-stale > 14d
    assert.equal(classifyStatus('event-driven', 100, 24, true), 'fresh');
    assert.equal(classifyStatus('event-driven', 100, 167, true), 'fresh');
    assert.equal(classifyStatus('event-driven', 100, 200, true), 'stale');
    assert.equal(classifyStatus('event-driven', 100, 400, true), 'very-stale');
  });

  it('classifies bi-weekly cadence with FINRA-shaped thresholds', () => {
    // bi-weekly fresh < 18d, stale 18-30d, very-stale > 30d
    assert.equal(classifyStatus('bi-weekly', 100, 17 * 24, true), 'fresh');
    assert.equal(classifyStatus('bi-weekly', 100, 25 * 24, true), 'stale');
    assert.equal(classifyStatus('bi-weekly', 100, 40 * 24, true), 'very-stale');
  });

  it('one-shot cadence is always fresh once populated', () => {
    assert.equal(classifyStatus('one-shot', 1, 99999, true), 'fresh');
    assert.equal(classifyStatus('one-shot', 0, 0, true), 'never-populated');
  });
});

// ───── summarize ───────────────────────────────────────────────────────────

function probeAt(status: HealthSourceProbe['status']): HealthSourceProbe {
  return {
    name: 'x',
    label: 'x',
    cadence: 'daily',
    autonomous: true,
    lastUpdateAt: null,
    lastUpdateAgeHours: -1,
    rowCount: 0,
    status,
    message: '',
    operatorAction: '',
    why: '',
  };
}
function migration(applied: boolean): HealthMigrationProbe {
  return { applyCommand: 'x', targetTable: 'x', label: 'x', applied };
}

describe('summarize', () => {
  it('counts each status tier independently', () => {
    const s = summarize(
      [
        probeAt('fresh'),
        probeAt('fresh'),
        probeAt('stale'),
        probeAt('very-stale'),
        probeAt('missing-table'),
        probeAt('never-populated'),
        probeAt('unknown-cadence'),
      ],
      [],
    );
    assert.equal(s.fresh, 2);
    assert.equal(s.stale, 1);
    assert.equal(s.veryStale, 1);
    assert.equal(s.missing, 1);
    assert.equal(s.neverPopulated, 1);
    assert.equal(s.unknownCadence, 1);
  });

  it('counts migrations applied vs pending', () => {
    const s = summarize([], [migration(true), migration(true), migration(false)]);
    assert.equal(s.appliedMigrations, 2);
    assert.equal(s.pendingMigrations, 1);
  });

  it('allGreen requires zero stale / very-stale / missing / never-populated AND zero pending migrations', () => {
    assert.equal(summarize([probeAt('fresh')], [migration(true)]).allGreen, true);
    assert.equal(summarize([probeAt('stale')], [migration(true)]).allGreen, false);
    assert.equal(summarize([probeAt('fresh')], [migration(false)]).allGreen, false);
    assert.equal(summarize([], []).allGreen, true, 'vacuously green with no sources');
    // unknown-cadence does NOT block allGreen — it's an info signal
    // (operator-readable as "I couldn't measure age") not a state failure.
    assert.equal(
      summarize([probeAt('fresh'), probeAt('unknown-cadence')], [migration(true)]).allGreen,
      true,
    );
  });
});

// ───── HEALTH_SOURCES / HEALTH_MIGRATIONS sanity ───────────────────────────

describe('HEALTH_SOURCES', () => {
  it('is non-empty (regression anchor — slices that ship a table should add an entry)', () => {
    assert.ok(HEALTH_SOURCES.length > 0);
  });

  it('every source has a non-empty name + label + operatorAction', () => {
    for (const s of HEALTH_SOURCES) {
      assert.ok(s.name.length > 0, `name empty for ${JSON.stringify(s)}`);
      assert.ok(s.label.length > 0, `label empty for ${s.name}`);
      assert.ok(s.operatorAction.length > 0, `operatorAction empty for ${s.name}`);
    }
  });

  it('every source has a cadence covered by CADENCE_THRESHOLDS_HOURS', () => {
    for (const s of HEALTH_SOURCES) {
      assert.ok(
        s.cadence in CADENCE_THRESHOLDS_HOURS,
        `cadence ${s.cadence} not in thresholds for ${s.name}`,
      );
    }
  });

  it('table names are unique (no double-counting)', () => {
    const names = HEALTH_SOURCES.map(s => s.name);
    const uniq = new Set(names);
    assert.equal(uniq.size, names.length, 'duplicate table names in HEALTH_SOURCES');
  });

  it('SEC EDGAR sources are all tagged autonomous=false (the reconciliation §3.1 GAP-1 fingerprint)', () => {
    const edgar = HEALTH_SOURCES.filter(s =>
      ['eight_k_events', 'executive_departures', 'insider_trades', 'schedule_13d_g_filings'].includes(s.name),
    );
    assert.equal(edgar.length, 4, 'all 4 EDGAR sources should be present');
    for (const s of edgar) {
      assert.equal(
        s.autonomous,
        false,
        `${s.name} should be autonomous=false (operator-cadence) per GAP-1`,
      );
    }
  });

  it('daemon-cadence snapshot tables are tagged autonomous=true', () => {
    const snapshots = HEALTH_SOURCES.filter(s => s.name.endsWith('_snapshots'));
    assert.ok(snapshots.length >= 8, 'expect at least 8 *_snapshots tables');
    for (const s of snapshots) {
      assert.equal(s.autonomous, true, `${s.name} should be autonomous=true (daemon step)`);
    }
  });

  // Pins the live CH schema conventions validated 2026-05-23 after the s96 #12
  // initial config used wrong column names (asof_date / filing_date / date)
  // that don't exist in any real table. Without this test, a future slice could
  // add a new snapshot with a different convention and silently degrade to
  // `unknown-cadence` on the panel without anyone noticing.
  it('every *_snapshots table uses snapshot_date Date column (s89-s96 convention)', () => {
    const snapshots = HEALTH_SOURCES.filter(s => s.name.endsWith('_snapshots'));
    for (const s of snapshots) {
      assert.equal(
        s.timestampCol,
        'snapshot_date',
        `${s.name}: composite snapshots must use snapshot_date (live CH schema)`,
      );
      assert.equal(s.timestampType, 'date', `${s.name}: snapshot_date is Date-typed`);
    }
  });

  it('SEC EDGAR source tables use accepted_at DateTime column (filing-receipt timestamp)', () => {
    const edgar = HEALTH_SOURCES.filter(s =>
      ['eight_k_events', 'executive_departures', 'insider_trades', 'schedule_13d_g_filings'].includes(
        s.name,
      ),
    );
    for (const s of edgar) {
      assert.equal(s.timestampCol, 'accepted_at', `${s.name}: EDGAR sources use accepted_at`);
      assert.equal(s.timestampType, 'datetime', `${s.name}: accepted_at is DateTime-typed`);
    }
  });

  it('macro_indicators_* tables use observation_date Date column', () => {
    const macro = HEALTH_SOURCES.filter(s => s.name.startsWith('macro_indicators_'));
    assert.ok(macro.length >= 2, 'expect macro_indicators_fred + macro_indicators_cboe');
    for (const s of macro) {
      assert.equal(s.timestampCol, 'observation_date', `${s.name}: use observation_date`);
      assert.equal(s.timestampType, 'date', `${s.name}: observation_date is Date-typed`);
    }
  });
});

describe('HEALTH_MIGRATIONS', () => {
  it('is non-empty (regression anchor for new migration slices)', () => {
    assert.ok(HEALTH_MIGRATIONS.length > 0);
  });

  it('every migration has a non-empty applyCommand + targetTable + label', () => {
    for (const m of HEALTH_MIGRATIONS) {
      assert.ok(m.applyCommand.startsWith('npm run migrate:'), `applyCommand shape: ${m.applyCommand}`);
      assert.ok(m.targetTable.length > 0, `targetTable empty for ${m.applyCommand}`);
      assert.ok(m.label.length > 0, `label empty for ${m.applyCommand}`);
    }
  });

  it('targetTable values are also present in HEALTH_SOURCES (so the operator can correlate freshness with migration status)', () => {
    const sourceNames = new Set(HEALTH_SOURCES.map(s => s.name));
    for (const m of HEALTH_MIGRATIONS) {
      assert.ok(
        sourceNames.has(m.targetTable),
        `migration target ${m.targetTable} not in HEALTH_SOURCES — operator can't correlate apply with freshness`,
      );
    }
  });
});
