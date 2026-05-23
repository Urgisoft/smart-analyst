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
  thresholdsFor,
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

  it('classifies daily cadence at the SPEC thresholds (DateTime default)', () => {
    // daily + datetime: fresh < 30h, stale 30-72h, very-stale >72h.
    // The 5th `timestampType` arg defaults to 'datetime' for back-compat
    // with the s96 #12 call sites; daily+date uses a wider window
    // (see "daily + date uses 48h/96h" test below + thresholdsFor docs).
    assert.equal(classifyStatus('daily', 100, 0, true), 'fresh');
    assert.equal(classifyStatus('daily', 100, 29, true), 'fresh');
    assert.equal(classifyStatus('daily', 100, 30, true), 'fresh', 'boundary inclusive on fresh');
    assert.equal(classifyStatus('daily', 100, 30.1, true), 'stale');
    assert.equal(classifyStatus('daily', 100, 71, true), 'stale');
    assert.equal(classifyStatus('daily', 100, 72, true), 'stale', 'boundary inclusive on stale');
    assert.equal(classifyStatus('daily', 100, 73, true), 'very-stale');
  });

  // Convention pin (s96 #14 Cycle 1 F1 — health worker).
  // The daily-Date split fixes the 2026-05-23 noise event where 8 daily
  // composites flagged stale at 43.4h because Date columns collapse to
  // midnight (yesterday's EOD snapshot reads as ~42h old at next-day open
  // even though it was written on time). The 48h fresh / 96h stale window
  // gives Date-typed daily sources one full extra day before flipping.
  // If this test fails, do not silently widen the window — the operator
  // queue / brief §0 calibration depends on this split.
  it('daily + date uses 48h fresh threshold; daily + datetime uses 30h', () => {
    // 36h old is BEYOND the datetime 30h fresh window → stale.
    assert.equal(
      classifyStatus('daily', 1, 36, true, 'datetime'),
      'stale',
      'datetime: 36h > 30h fresh threshold = stale',
    );
    // Same 36h is WITHIN the date 48h fresh window → fresh.
    assert.equal(
      classifyStatus('daily', 1, 36, true, 'date'),
      'fresh',
      'date: 36h <= 48h fresh threshold = fresh (EOD snapshot one day old)',
    );
    // Boundary checks on the daily+date window.
    assert.equal(classifyStatus('daily', 1, 48, true, 'date'), 'fresh', 'daily+date fresh boundary inclusive');
    assert.equal(classifyStatus('daily', 1, 48.1, true, 'date'), 'stale');
    assert.equal(classifyStatus('daily', 1, 96, true, 'date'), 'stale', 'daily+date stale boundary inclusive');
    assert.equal(classifyStatus('daily', 1, 96.1, true, 'date'), 'very-stale');
    // 43.4h — the exact 2026-05-23 noise value — must now be fresh.
    assert.equal(
      classifyStatus('daily', 1, 43.4, true, 'date'),
      'fresh',
      '43.4h (the 2026-05-23 noise value) must be fresh under daily+date',
    );
  });

  // Pin the helper directly so refactors that move logic into thresholdsFor
  // can't drift from the documented split.
  it('thresholdsFor returns the correct pair per cadence + timestampType', () => {
    assert.deepEqual(thresholdsFor('daily', 'datetime'), { fresh: 30, stale: 72 });
    assert.deepEqual(thresholdsFor('daily', 'date'), { fresh: 48, stale: 96 });
    // Non-daily cadences ignore timestampType (the daily-Date split is
    // specific to the EOD-snapshot collision with sub-day expectations).
    assert.deepEqual(
      thresholdsFor('event-driven', 'date'),
      CADENCE_THRESHOLDS_HOURS['event-driven'],
    );
    assert.deepEqual(
      thresholdsFor('event-driven', 'datetime'),
      CADENCE_THRESHOLDS_HOURS['event-driven'],
    );
    assert.deepEqual(thresholdsFor('bi-weekly', 'date'), CADENCE_THRESHOLDS_HOURS['bi-weekly']);
    assert.deepEqual(thresholdsFor('continuous', 'datetime'), CADENCE_THRESHOLDS_HOURS['continuous']);
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

  // Convention pin (s96 #15 Cycle 2 GAP-1 — Infra worker).
  // The four SEC EDGAR raw sources (executive_departures, eight_k_events,
  // insider_trades, schedule_13d_g_filings) were operator-cadence pre-Cycle 2;
  // GAP-1 promoted them to daemon-cadence via -pre steps 1i-pre/1k-pre/
  // 1l-pre/1m-pre in `scripts/daily_signal_daemon.ts`. The HEALTH_SOURCES
  // entries must therefore (a) exist, (b) flag autonomous=true (the entire
  // point of the promotion), and (c) preserve the event-driven cadence
  // (filings arrive asynchronously; the cadence-relative staleness window
  // remains 7d fresh / 14d stale per CADENCE_THRESHOLDS_HOURS). A future
  // refactor flipping autonomous back to false would silently re-introduce
  // the operator-memory dependence ADR-044 closes.
  it('SEC EDGAR sources are all tagged autonomous=true (GAP-1 daemon-cadence promotion s96 #15 Cycle 2)', () => {
    const edgar = HEALTH_SOURCES.filter(s =>
      ['eight_k_events', 'executive_departures', 'insider_trades', 'schedule_13d_g_filings'].includes(s.name),
    );
    assert.equal(edgar.length, 4, 'all 4 EDGAR sources should be present');
    for (const s of edgar) {
      assert.equal(
        s.autonomous,
        true,
        `${s.name} should be autonomous=true (daemon -pre step) per GAP-1`,
      );
      assert.equal(
        s.cadence,
        'event-driven',
        `${s.name} should preserve event-driven cadence (filings arrive asynchronously)`,
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

  // Convention pin (s96 #15 Cycle 2 GAP-2 — Infra worker).
  // FINRA raw source `short_interest` was promoted from operator-cadence
  // to daemon-cadence via Mondays-only step 1h-pre in
  // `scripts/daily_signal_daemon.ts`. The HEALTH_SOURCES entry must
  // therefore (a) exist, (b) flag autonomous=true (the entire point of
  // the promotion), and (c) use the bi-weekly cadence (FINRA Rule 4560
  // publishes biweekly; existing CADENCE_THRESHOLDS_HOURS bi-weekly
  // entry has FINRA-shaped 18d fresh / 30d stale). A future refactor
  // flipping autonomous back to false would silently re-introduce the
  // operator-memory dependence ADR-044 closes.
  it('FINRA short_interest raw source is daemon-cadence with bi-weekly thresholds (GAP-2)', () => {
    const finra = HEALTH_SOURCES.find(s => s.name === 'short_interest');
    assert.ok(finra, 'short_interest entry must exist in HEALTH_SOURCES after GAP-2');
    assert.equal(finra!.autonomous, true, 'short_interest must be autonomous=true (daemon step 1h-pre)');
    assert.equal(finra!.cadence, 'bi-weekly', 'short_interest must use bi-weekly cadence (FINRA Rule 4560)');
    assert.equal(finra!.timestampCol, 'settlement_date', 'short_interest uses settlement_date Date column');
    assert.equal(finra!.timestampType, 'date', 'settlement_date is Date-typed');
  });

  // Convention pin (s96 #15 Cycle 2 GAP-4 — Infra worker).
  // The v1 yfinance primary ETF panel (`etf_shares_outstanding`) was
  // operator-cadence pre-Cycle 2 while the v3.1 SSGA-SPDR secondary
  // (`etf_shares_outstanding_secondary`) refreshed daemon-cadence via
  // step 1ja (s96 #9). The asymmetry produced a comparator pathology
  // over time — divergence dominated by primary staleness, not real
  // issuer-vs-Yahoo data-quality delta. GAP-4 promotes the v1 primary
  // to daemon-cadence via step 1jb (between 1ja secondary refresh +
  // 1j etf-flow snapshot write). The HEALTH_SOURCES entry must
  // therefore (a) exist, (b) flag autonomous=true (the entire point
  // of the promotion), and (c) use the daily cadence with Date-typed
  // timestamp (the v1 ingest's panel column is `date`, a Date column,
  // which inherits the per-timestampType wider window from F1). A
  // future refactor flipping autonomous back to false would silently
  // re-introduce the operator-memory dependence ADR-044 closes AND
  // re-open the comparator-divergence pathology.
  it('ETF v1 yfinance primary etf_shares_outstanding is daemon-cadence (GAP-4)', () => {
    const v1Primary = HEALTH_SOURCES.find(s => s.name === 'etf_shares_outstanding');
    assert.ok(v1Primary, 'etf_shares_outstanding entry must exist in HEALTH_SOURCES after GAP-4');
    assert.equal(v1Primary!.autonomous, true, 'etf_shares_outstanding must be autonomous=true (daemon step 1jb)');
    assert.equal(v1Primary!.cadence, 'daily', 'etf_shares_outstanding must use daily cadence (yfinance EOD refresh)');
    assert.equal(v1Primary!.timestampCol, 'date', 'etf_shares_outstanding uses date Date column');
    assert.equal(v1Primary!.timestampType, 'date', 'date is Date-typed (inherits wider F1 daily+Date thresholds)');
  });

  // Convention pin (s96 #15 Cycle 2 GAP-4 — Infra worker; cross-symmetry).
  // After GAP-4 promotion the v1 primary + v3.1 secondary BOTH refresh
  // daemon-cadence. Cross-validation symmetry requires their HEALTH_SOURCES
  // shape to match — both daily + Date-typed + autonomous + same
  // operator-fallback shape. A future drift on either side would reopen
  // the asymmetry the slice closes.
  it('ETF v1 primary + v3.1 secondary share the daemon-cadence shape (GAP-4 symmetry)', () => {
    const primary = HEALTH_SOURCES.find(s => s.name === 'etf_shares_outstanding');
    const secondary = HEALTH_SOURCES.find(s => s.name === 'etf_shares_outstanding_secondary');
    assert.ok(primary && secondary, 'both etf_shares_outstanding{,_secondary} must exist after GAP-4');
    assert.equal(primary!.autonomous, secondary!.autonomous, 'autonomous flags must match (both true after GAP-4)');
    assert.equal(primary!.cadence, secondary!.cadence, 'cadences must match (both daily)');
    assert.equal(primary!.timestampType, secondary!.timestampType, 'timestamp types must match (both Date)');
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
