/**
 * Unit tests for the daemon's FINRA short-interest fetch orchestration helper —
 * `buildFinraShortInterestArgs` + `shouldRunFinraTodayUtc` in
 * src/server/daemon_finra_short_interest_fetch.ts.
 *
 * Session 96 #15 Cycle 2 context (GAP-2 daemon-cadence promotion): the
 * FINRA biweekly short-interest ingest was operator-cadence pre-Cycle 2.
 * This slice wires `scripts/finra_short_interest_ingest.py` into the
 * daemon as step 1h-pre under a Mondays-only gate (FINRA publishes per
 * Rule 4560 on the 15th + last business day of each month, ~8 business
 * days lag — the publication calendar surfaces new files on Mondays).
 *
 * The pure helpers pinned here are the load-bearing regressions a future
 * refactor could silently break:
 *   - `buildFinraShortInterestArgs` MUST pass `--apply` on daemon
 *     write-mode (FINRA ingest defaults to dry-run absent the flag).
 *     A silent flip would make the daemon a no-op writer.
 *   - `buildFinraShortInterestArgs` MUST NOT pass `--settlement-date` —
 *     the script auto-detects the most-recent published settlement
 *     window. Operator-derived dates re-introduce operator-memory
 *     dependence (the ADR-044 anti-pattern this slice closes).
 *   - `shouldRunFinraTodayUtc` MUST gate on UTC Monday — the daemon
 *     skips fetch attempts every other weekday (5× HTTP saved + 5×
 *     log-signal noise reduction) without missing the publication
 *     window. A drift here would either re-introduce daily noise (drop
 *     the gate) or miss publications (wrong day).
 *
 * runFinraShortInterestFetch itself is not unit-tested — it spawns a
 * Python subprocess and is exercised end-to-end by `npm run daemon:daily`
 * on a Monday. Same posture as daemonFredFetch.test.ts (the precedent for
 * Python-spawn helpers).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFinraShortInterestArgs,
  shouldRunFinraTodayUtc,
} from '../../src/server/daemon_finra_short_interest_fetch.js';

describe('buildFinraShortInterestArgs', () => {
  it('passes --apply when dryRun=false', () => {
    const { args, timeoutMs } = buildFinraShortInterestArgs(false);
    assert.deepEqual(args, ['scripts/finra_short_interest_ingest.py', '--apply']);
    assert.equal(timeoutMs, 5 * 60_000);
  });

  it('passes --dry-run when dryRun=true', () => {
    const { args, timeoutMs } = buildFinraShortInterestArgs(true);
    assert.deepEqual(args, ['scripts/finra_short_interest_ingest.py', '--dry-run']);
    assert.equal(timeoutMs, 5 * 60_000);
  });

  it('does not include --apply AND --dry-run simultaneously', () => {
    // Defensive: the FINRA ingest's parse_args treats both flags as
    // ambiguous and the dry-run default wins. Asserting we never emit both
    // protects against a future refactor introducing the silent no-op.
    const dry = buildFinraShortInterestArgs(true).args;
    const apply = buildFinraShortInterestArgs(false).args;
    assert.ok(!(dry.includes('--apply') && dry.includes('--dry-run')));
    assert.ok(!(apply.includes('--apply') && apply.includes('--dry-run')));
  });

  it('does not include --settlement-date (relies on script auto-detection)', () => {
    // The Python script's `most_recent_settlement_date()` helper resolves
    // the most-recently-elapsed FINRA settlement whose 8-business-day
    // publication window has elapsed. Passing --settlement-date here would
    // re-introduce operator-memory dependence — the ADR-044 anti-pattern
    // GAP-2 closes. If this assertion fails, the daemon promotion has
    // silently regressed.
    for (const dryRun of [true, false]) {
      const { args } = buildFinraShortInterestArgs(dryRun);
      assert.ok(
        !args.some(a => a.startsWith('--settlement-date')),
        `--settlement-date flag must not be set (dryRun=${dryRun})`,
      );
    }
  });

  it('does not include --url / --from-file overrides (relies on script defaults)', () => {
    // Daemon use should rely on the script's DEFAULT_FINRA_BASE +
    // DEFAULT_FINRA_FILENAME_PATTERN. Adding a flag here would silently
    // shadow operator-level changes to the script's URL constant when
    // FINRA next restructures their data catalog.
    for (const dryRun of [true, false]) {
      const { args } = buildFinraShortInterestArgs(dryRun);
      assert.ok(!args.some(a => a.startsWith('--url')), `--url flag must not be set (dryRun=${dryRun})`);
      assert.ok(!args.some(a => a.startsWith('--from-file')), `--from-file flag must not be set (dryRun=${dryRun})`);
    }
  });

  it('timeout budget is bounded to 5 minutes (daemon per-run wall-clock envelope)', () => {
    // FINRA's biweekly CSV is ~8000 equity rows; steady-state finishes in
    // <30s. 5 minutes covers a degraded FINRA endpoint + CUSIP-resolution
    // side-trip via SEC EDGAR submissions API. The daemon's existing
    // longest single-step timeout is macro-fetch full-backfill at 15min;
    // FINRA at 5min stays well within the per-step envelope.
    assert.equal(buildFinraShortInterestArgs(false).timeoutMs, 5 * 60_000);
    assert.equal(buildFinraShortInterestArgs(true).timeoutMs, 5 * 60_000);
  });
});

describe('shouldRunFinraTodayUtc', () => {
  // JavaScript `Date.getUTCDay()` returns 0 (Sun), 1 (Mon), 2 (Tue), ...
  // FINRA publishes Mondays per the rule-4560 calendar (the 8-business-day
  // window after the 15th + last business day of each month).

  it('returns true for a Monday in UTC', () => {
    // 2026-05-25 is a Monday.
    const monday = new Date('2026-05-25T12:00:00Z');
    assert.equal(monday.getUTCDay(), 1, 'sanity: this date must be a Monday in UTC');
    assert.equal(shouldRunFinraTodayUtc(monday), true);
  });

  it('returns false for every non-Monday day of the week', () => {
    // 2026-05-24 = Sunday; iterate Sunday → Saturday (six non-Mondays).
    const sunday = new Date('2026-05-24T12:00:00Z');
    assert.equal(sunday.getUTCDay(), 0, 'sanity: this date must be a Sunday in UTC');
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday.getTime() + i * 24 * 60 * 60 * 1000);
      const day = d.getUTCDay();
      if (day === 1) {
        // Monday: handled by the prior test; skip here to avoid double-pinning.
        assert.equal(shouldRunFinraTodayUtc(d), true, 'sanity: Monday must return true');
      } else {
        assert.equal(
          shouldRunFinraTodayUtc(d),
          false,
          `non-Monday day-of-week ${day} (${d.toISOString().slice(0, 10)}) must return false`,
        );
      }
    }
  });

  it('respects UTC boundaries (not local timezone)', () => {
    // 2026-05-24T23:30:00Z = Sunday 23:30 UTC. In ET (UTC-4 DST) this is
    // Sunday 19:30 — but the function operates on UTC; we must still
    // return false. If the implementation accidentally uses `getDay()`
    // instead of `getUTCDay()`, this test catches it on hosts where the
    // local timezone has rolled over to Monday already.
    const sunUtcButMonInUtcPlus2 = new Date('2026-05-24T23:30:00Z');
    assert.equal(sunUtcButMonInUtcPlus2.getUTCDay(), 0);
    assert.equal(shouldRunFinraTodayUtc(sunUtcButMonInUtcPlus2), false);

    // 2026-05-26T00:30:00Z = Tuesday 00:30 UTC. In Pacific Time (UTC-7
    // DST) this is Monday 17:30. UTC-Tuesday must return false even if a
    // careless implementation might read local-Monday from the same Date.
    const tueUtcButMonInUtcMinus7 = new Date('2026-05-26T00:30:00Z');
    assert.equal(tueUtcButMonInUtcMinus7.getUTCDay(), 2);
    assert.equal(shouldRunFinraTodayUtc(tueUtcButMonInUtcMinus7), false);
  });
});
