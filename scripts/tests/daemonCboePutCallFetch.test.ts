/**
 * Unit tests for the daemon's CBOE put/call fetch orchestration helper —
 * `buildCboePutCallFetchArgs` + `computeDaemonWindowStart` in
 * src/server/daemon_cboe_putcall_fetch.ts.
 *
 * Cycle 21 (Q-5 Path D) context: the legacy CSV at cdn.cboe.com/.../totalpc.csv
 * froze 2019-10-04 (S96-88). The new ingest at scripts/cboe_putcall_json_ingest.py
 * reads the free anonymous CBOE daily JSON endpoint. Daemon step 1b'' is the
 * forward-cadence wiring. These tests pin the load-bearing argument choices:
 *   - The script is always invoked with `--start <ISO date>`, where the date
 *     is today UTC minus 7 calendar days. We intentionally do NOT default to
 *     the script's DEFAULT_START (2019-10-07) — that would force ~1,640
 *     fetches every daemon run; the narrow window keeps each run to a
 *     handful of fetches.
 *   - --dry-run flag is forwarded when the daemon DRY_RUN flag is set.
 *   - Timeout budget is 10 minutes — mirrors the FRED step for predictable
 *     per-run wall-clock; resilient against transient network slowness.
 *   - `--ratio` and `--source-label` flags are NOT passed (the script's
 *     defaults of 'total' and 'cboe_json' are the canonical phase1_v3
 *     sentiment_extreme inputs; passing them here would silently shadow
 *     any future script-side default change).
 *
 * runCboePutCallFetch itself is not tested directly — it spawns a Python
 * subprocess and is exercised end-to-end by `npm run daemon:daily`. The
 * pure arg-builder + window-start helper are the only things a regression
 * can silently break without the operator immediately noticing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCboePutCallFetchArgs,
  computeDaemonWindowStart,
} from '../../src/server/daemon_cboe_putcall_fetch.js';

describe('computeDaemonWindowStart', () => {
  it('returns today-UTC minus 7 calendar days as YYYY-MM-DD', () => {
    // Pin a known UTC instant. 2026-05-24T12:00:00Z minus 7 days = 2026-05-17.
    const now = new Date(Date.UTC(2026, 4, 24, 12, 0, 0)); // month is 0-indexed
    const start = computeDaemonWindowStart(now);
    assert.equal(start, '2026-05-17');
  });

  it('handles month rollover correctly (UTC)', () => {
    // 2026-06-03 - 7 days = 2026-05-27
    const now = new Date(Date.UTC(2026, 5, 3, 12, 0, 0));
    const start = computeDaemonWindowStart(now);
    assert.equal(start, '2026-05-27');
  });

  it('handles year rollover correctly (UTC)', () => {
    // 2027-01-04 - 7 days = 2026-12-28
    const now = new Date(Date.UTC(2027, 0, 4, 12, 0, 0));
    const start = computeDaemonWindowStart(now);
    assert.equal(start, '2026-12-28');
  });

  it('pads single-digit month + day with leading zeros', () => {
    // 2026-01-08 - 7 days = 2026-01-01
    const now = new Date(Date.UTC(2026, 0, 8, 12, 0, 0));
    const start = computeDaemonWindowStart(now);
    assert.equal(start, '2026-01-01');
    assert.match(start, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses Date.now() default when no argument passed', () => {
    // Don't pin to a specific date; just verify the shape + that the
    // result is 7 days before today UTC ± 1 day tolerance for the
    // millisecond gap between Date.now() inside the helper and here.
    const before = new Date();
    const start = computeDaemonWindowStart();
    const after = new Date();
    assert.match(start, /^\d{4}-\d{2}-\d{2}$/);
    const startMs = new Date(start + 'T00:00:00Z').getTime();
    const expectedMin = before.getTime() - 7 * 86400_000 - 86400_000;
    const expectedMax = after.getTime() - 7 * 86400_000 + 86400_000;
    assert.ok(startMs >= expectedMin, `start ${start} should be ≥ ${new Date(expectedMin).toISOString()}`);
    assert.ok(startMs <= expectedMax, `start ${start} should be ≤ ${new Date(expectedMax).toISOString()}`);
  });
});

describe('buildCboePutCallFetchArgs', () => {
  it('returns the json-ingest script + --start window when dryRun=false', () => {
    const now = new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
    const { args, timeoutMs } = buildCboePutCallFetchArgs(false, now);
    assert.deepEqual(args, [
      'scripts/cboe_putcall_json_ingest.py',
      '--start',
      '2026-05-17',
    ]);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('appends --dry-run when dryRun=true', () => {
    const now = new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
    const { args, timeoutMs } = buildCboePutCallFetchArgs(true, now);
    assert.deepEqual(args, [
      'scripts/cboe_putcall_json_ingest.py',
      '--start',
      '2026-05-17',
      '--dry-run',
    ]);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('does not include --ratio or --source-label flags (relies on script defaults)', () => {
    // The script defaults --ratio=total + --source-label=cboe_json,
    // both of which are the canonical phase1_v3 sentiment_extreme
    // inputs. Passing them from here would silently shadow any future
    // script-side default change (e.g. the optional EQUITY P/C
    // refinement called out in docs/analysis/q5-path-d-cboe-json-
    // 2026-05-24.md as a future RESEARCH→DESIGN cycle).
    const { args } = buildCboePutCallFetchArgs(false, new Date(Date.UTC(2026, 4, 24, 12, 0, 0)));
    assert.ok(!args.some(a => a.startsWith('--ratio')), '--ratio flag should not be set');
    assert.ok(!args.some(a => a.startsWith('--source-label')), '--source-label flag should not be set');
    assert.ok(!args.some(a => a.startsWith('--end')), '--end flag should not be set (defaults to today UTC)');
    assert.ok(!args.some(a => a.startsWith('--limit')), '--limit flag should not be set');
  });

  it('start date is exactly 7 calendar days before the provided "now" (UTC)', () => {
    const now = new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
    const { args } = buildCboePutCallFetchArgs(false, now);
    const startIdx = args.indexOf('--start');
    assert.ok(startIdx >= 0, '--start flag must be present');
    const startStr = args[startIdx + 1];
    assert.match(startStr, /^\d{4}-\d{2}-\d{2}$/, '--start value must be ISO date');
    const startMs = new Date(startStr + 'T00:00:00Z').getTime();
    const expectedMs = now.getTime() - 7 * 86400_000;
    // Both are UTC-midnight-aligned (start has 00:00, now has 12:00),
    // so the diff is exactly 7d - 12h. Tolerance: 1 day.
    assert.ok(
      Math.abs(startMs - (expectedMs - 12 * 3600_000)) < 86400_000,
      `start ${startStr} should be 7 calendar days before ${now.toISOString()}`,
    );
  });

  it('timeoutMs is 10 minutes regardless of dryRun', () => {
    const now = new Date(Date.UTC(2026, 4, 24, 12, 0, 0));
    assert.equal(buildCboePutCallFetchArgs(false, now).timeoutMs, 600_000);
    assert.equal(buildCboePutCallFetchArgs(true, now).timeoutMs, 600_000);
  });
});
