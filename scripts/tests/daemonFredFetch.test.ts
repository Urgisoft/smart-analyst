/**
 * Unit tests for the daemon's FRED-fetch orchestration helper —
 * `buildFredFetchArgs` in src/server/daemon_fred_fetch.ts.
 *
 * Session 88 continuation context: the daemon's existing [macro-fetch]
 * step calls macro_regime_ingest.py (YF-only). FRED-dependent composites
 * (phase1_v3, cycle-position, cross-asset) need a dedicated FRED refresh.
 * This test pins the load-bearing wiring choices for that step:
 *   - Default invocation passes NO --start / --series flags (so new series
 *     added to fred_ingest.py's DEFAULT_SERIES are picked up automatically
 *     — adding --series here would silently shadow them).
 *   - --dry-run flag is forwarded when DRY_RUN is set on the daemon CLI.
 *   - Timeout budget is 10 minutes — covers a clean 1996-present ingest
 *     while keeping the daemon's per-run wall-clock predictable
 *     (incremental pulls finish in <30s).
 *
 * runFredFetch itself is not tested directly — it spawns a Python
 * subprocess and is exercised end-to-end by `npm run daemon:daily`. The
 * pure arg-builder is the only thing a regression can silently break
 * without the operator immediately noticing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFredFetchArgs } from '../../src/server/daemon_fred_fetch.js';

describe('buildFredFetchArgs', () => {
  it('returns the fred_ingest.py script alone when dryRun=false', () => {
    const { args, timeoutMs } = buildFredFetchArgs(false);
    assert.deepEqual(args, ['scripts/fred_ingest.py']);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('appends --dry-run when dryRun=true', () => {
    const { args, timeoutMs } = buildFredFetchArgs(true);
    assert.deepEqual(args, ['scripts/fred_ingest.py', '--dry-run']);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('does not include --start or --series flags (relies on fred_ingest.py defaults)', () => {
    // DEFAULT_SERIES in fred_ingest.py covers all 12 series the four
    // Layer-0 composites depend on (yield curve / credit / employment /
    // real rates / broad dollar). Passing --series here would silently
    // bypass series added to the script later; passing --start would
    // override the script's documented DEFAULT_START = 1996-01-01.
    const { args } = buildFredFetchArgs(false);
    assert.ok(!args.some(a => a.startsWith('--start')), '--start flag should not be set');
    assert.ok(!args.some(a => a.startsWith('--series')), '--series flag should not be set');
  });
});
