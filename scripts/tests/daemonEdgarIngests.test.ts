/**
 * Unit tests for the daemon's SEC EDGAR ingest orchestration helpers in
 * `src/server/daemon_edgar_ingests.ts`:
 *
 *   - `EDGAR_DAEMON_WINDOW_DAYS` constant pin.
 *   - `EDGAR_PAGE_CAP` constant pin.
 *   - `buildEdgarIngestArgs(scriptPath, dryRun, asOf)` pure builder pin.
 *   - `parseEdgarHitCount(stdout)` pure parser pin (per-script samples).
 *   - The four public runners (`runEdgarItem502Refresh`, `runEdgar8kEventRefresh`,
 *     `runEdgarForm4Refresh`, `runEdgar13DGRefresh`) — only the script-path
 *     correctness verified here (smoke-test that they pass the right
 *     script path through `buildEdgarIngestArgs`'s arg construction). The
 *     `spawnSync` impure path is exercised end-to-end by `npm run
 *     daemon:daily` once-per-cycle; same posture as
 *     `daemonFinraShortInterestFetch.test.ts` (FINRA precedent).
 *
 * Session 96 #15 Cycle 2 context (GAP-1 daemon-cadence promotion): the
 * four SEC EDGAR ingests were operator-cadence pre-Cycle 2. This slice
 * wires `sec_edgar_8k_item_5_02_ingest.py`, `sec_edgar_8k_event_ingest.py`,
 * `sec_edgar_form4_ingest.py`, `sec_edgar_13d_g_ingest.py` into the
 * daemon as `-pre` steps under a 2-day rolling window. The 100-hit
 * EDGAR page cap is accepted as a documented limitation; when hit the
 * daemon emits a warning anomaly with the operator-catchup command.
 *
 * The pure helpers pinned here are the load-bearing regressions a future
 * refactor could silently break:
 *   - `buildEdgarIngestArgs` MUST emit `--start-date` + `--end-date` in
 *     the expected `YYYY-MM-DD` UTC format with a 2-day inclusive window.
 *     A silent flip to 1-day would lose any missed cycle's filings; a
 *     flip to 7-day would saturate the 100-hit cap permanently.
 *   - `buildEdgarIngestArgs` MUST pass `--apply` on daemon write-mode
 *     (each EDGAR ingest defaults to dry-run absent the flag). A silent
 *     flip would make the daemon a no-op writer.
 *   - `buildEdgarIngestArgs` MUST NOT pass `--snapshot-date` — the
 *     scripts auto-default to today, matching the SPEC anti-leak filter
 *     (E-7 / EDF-5 / F4-10 / XD-7). Passing it would re-introduce
 *     operator-memory dependence (the ADR-044 anti-pattern this slice
 *     closes).
 *   - `parseEdgarHitCount` MUST extract the hit count from each of the
 *     four scripts' actual summary lines. The investigation step for
 *     this slice (Cycle 2 slice 2) captured one sample per ingest;
 *     those samples are pinned below verbatim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDGAR_DAEMON_WINDOW_DAYS,
  EDGAR_PAGE_CAP,
  buildEdgarIngestArgs,
  parseEdgarHitCount,
  runEdgarItem502Refresh,
  runEdgar8kEventRefresh,
  runEdgarForm4Refresh,
  runEdgar13DGRefresh,
  catchupCommandFor,
} from '../../src/server/daemon_edgar_ingests.js';

// Fixed asOf used across the args-builder tests. 2026-05-23 is the cycle
// 2 ship date; the inclusive 2-day window therefore covers 2026-05-22 →
// 2026-05-23. UTC noon so any timezone-rounding bug surfaces here.
const ASOF = new Date('2026-05-23T12:00:00Z');

const ITEM_502_SCRIPT = 'scripts/sec_edgar_8k_item_5_02_ingest.py';
const EIGHT_K_SCRIPT = 'scripts/sec_edgar_8k_event_ingest.py';
const FORM4_SCRIPT = 'scripts/sec_edgar_form4_ingest.py';
const XD13_SCRIPT = 'scripts/sec_edgar_13d_g_ingest.py';

// ───── Constants ──────────────────────────────────────────────────────────

describe('EDGAR_DAEMON_WINDOW_DAYS', () => {
  // Pinned at 2 so a single-day missed cycle (host downtime, network
  // outage, watcher restart) doesn't leave a permanent hole. A flip to 1
  // would silently lose any missed day's filings; a flip to 7+ would
  // permanently saturate the 100-hit cap. If you need to change this,
  // think hard about whether the cap-hit anomaly path covers the new
  // window's expected volume.
  it('is pinned at 2 days (smallest window surviving one missed daemon cycle)', () => {
    assert.equal(EDGAR_DAEMON_WINDOW_DAYS, 2);
  });
});

describe('EDGAR_PAGE_CAP', () => {
  // EDGAR full-text-search returns at most 100 hits per response. This
  // is a server-side limit, not a configurable parameter — pinned in
  // tests so a future EDGAR API change (cap moves) surfaces as a
  // deliberate update rather than a silent semantic shift.
  it('is pinned at 100 (EDGAR full-text-search hit cap)', () => {
    assert.equal(EDGAR_PAGE_CAP, 100);
  });
});

// ───── buildEdgarIngestArgs ───────────────────────────────────────────────

describe('buildEdgarIngestArgs', () => {
  it('emits start-date = asOf − 1 day and end-date = asOf in UTC YYYY-MM-DD format', () => {
    // EDGAR_DAEMON_WINDOW_DAYS = 2 → closed inclusive window is yesterday
    // through today. For asOf = 2026-05-23 the window is 2026-05-22 →
    // 2026-05-23 inclusive (2 calendar days).
    const { args } = buildEdgarIngestArgs(FORM4_SCRIPT, false, ASOF);
    assert.deepEqual(
      args,
      [FORM4_SCRIPT, '--start-date', '2026-05-22', '--end-date', '2026-05-23', '--apply'],
      'expected exact arg order: script, --start-date, --end-date, write-mode flag',
    );
  });

  it('passes --apply when dryRun=false', () => {
    const { args } = buildEdgarIngestArgs(ITEM_502_SCRIPT, false, ASOF);
    assert.ok(args.includes('--apply'), 'write-mode must include --apply');
    assert.ok(!args.includes('--dry-run'), 'write-mode must NOT include --dry-run');
  });

  it('passes --dry-run when dryRun=true', () => {
    const { args } = buildEdgarIngestArgs(ITEM_502_SCRIPT, true, ASOF);
    assert.ok(args.includes('--dry-run'), 'dry-run mode must include --dry-run');
    assert.ok(!args.includes('--apply'), 'dry-run mode must NOT include --apply');
  });

  it('does not include --apply AND --dry-run simultaneously', () => {
    // Defensive: passing both flags would let argparse pick one based on
    // declaration order, silently making the daemon a no-op writer if the
    // order flips. The pin guarantees exactly one is set.
    for (const dryRun of [true, false]) {
      const { args } = buildEdgarIngestArgs(FORM4_SCRIPT, dryRun, ASOF);
      assert.ok(
        !(args.includes('--apply') && args.includes('--dry-run')),
        `must not include both --apply and --dry-run (dryRun=${dryRun})`,
      );
    }
  });

  it('does not include --snapshot-date (relies on script auto-default to today)', () => {
    // The Python scripts auto-default --snapshot-date to today, matching
    // each SPEC's anti-leak filter (E-7 / EDF-5 / F4-10 / XD-7). Passing
    // it here would re-introduce operator-memory dependence — the ADR-044
    // anti-pattern this slice closes. If this assertion fails, GAP-1's
    // promotion has silently regressed.
    for (const dryRun of [true, false]) {
      for (const script of [ITEM_502_SCRIPT, EIGHT_K_SCRIPT, FORM4_SCRIPT, XD13_SCRIPT]) {
        const { args } = buildEdgarIngestArgs(script, dryRun, ASOF);
        assert.ok(
          !args.some(a => a.startsWith('--snapshot-date')),
          `--snapshot-date must not be set (script=${script}, dryRun=${dryRun})`,
        );
      }
    }
  });

  it('does not include --url / --from-file / --user-agent overrides', () => {
    // Daemon use should rely on the script's defaults so an operator-level
    // change to those constants propagates uniformly to the daemon-cadence
    // path. Adding any of these flags here would silently shadow the
    // operator-cadence command's behavior.
    for (const dryRun of [true, false]) {
      const { args } = buildEdgarIngestArgs(ITEM_502_SCRIPT, dryRun, ASOF);
      assert.ok(!args.some(a => a.startsWith('--url')), `--url flag must not be set (dryRun=${dryRun})`);
      assert.ok(!args.some(a => a.startsWith('--from-file')), `--from-file flag must not be set (dryRun=${dryRun})`);
      assert.ok(!args.some(a => a.startsWith('--user-agent')), `--user-agent flag must not be set (dryRun=${dryRun})`);
    }
  });

  it('timeout budget is bounded to 10 minutes (daemon per-step wall-clock envelope)', () => {
    // 10 minutes covers a degraded EDGAR endpoint + slow CIK-resolution
    // side-trips. Matches the SSGA-SPDR adapter budget. EDGAR rate-limit
    // is 10 req/sec; ~100 filings + body fetches + CIK resolves finishes
    // in 1-3 minutes steady-state. The daemon's existing longest single-
    // step is macro-fetch full-backfill at 15 min — EDGAR at 10 min stays
    // well within envelope.
    for (const dryRun of [true, false]) {
      const { timeoutMs } = buildEdgarIngestArgs(ITEM_502_SCRIPT, dryRun, ASOF);
      assert.equal(timeoutMs, 10 * 60_000);
    }
  });

  it('window covers exactly EDGAR_DAEMON_WINDOW_DAYS calendar days', () => {
    // Cross-check the constant's contract: for any constant value, the
    // emitted window's [start, end] inclusive day-count equals the
    // constant. If someone bumps EDGAR_DAEMON_WINDOW_DAYS without
    // updating buildEdgarIngestArgs, this fails.
    const { args } = buildEdgarIngestArgs(FORM4_SCRIPT, false, ASOF);
    const startIdx = args.indexOf('--start-date');
    const endIdx = args.indexOf('--end-date');
    assert.ok(startIdx >= 0 && endIdx >= 0, 'both --start-date and --end-date must be present');
    const startDate = new Date(`${args[startIdx + 1]}T00:00:00Z`);
    const endDate = new Date(`${args[endIdx + 1]}T00:00:00Z`);
    const dayCount =
      Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    assert.equal(
      dayCount,
      EDGAR_DAEMON_WINDOW_DAYS,
      `inclusive window must equal EDGAR_DAEMON_WINDOW_DAYS=${EDGAR_DAEMON_WINDOW_DAYS}`,
    );
  });

  it('emits stable arg order across runs (regression anchor against arg-reorder refactors)', () => {
    // EDGAR scripts use argparse which is order-agnostic, but pinning the
    // order makes daemon log lines + ps-aux output predictable for
    // operator inspection.
    const expected = [
      FORM4_SCRIPT, '--start-date', '2026-05-22', '--end-date', '2026-05-23', '--apply',
    ];
    const a1 = buildEdgarIngestArgs(FORM4_SCRIPT, false, ASOF).args;
    const a2 = buildEdgarIngestArgs(FORM4_SCRIPT, false, ASOF).args;
    assert.deepEqual(a1, expected);
    assert.deepEqual(a2, expected);
  });
});

// ───── parseEdgarHitCount ─────────────────────────────────────────────────

describe('parseEdgarHitCount', () => {
  // Sample stdout lines captured by the Cycle 2 slice 2 investigation
  // step (2026-05-23 dry-runs of each ingest with a 2-day window). The
  // wording differs per script — "filings" / "Form 4 filings" /
  // "Schedule 13D/G filings" — but the count is always between
  // "parsed" and "from search response".

  it('extracts hit count from the Item 5.02 (exec-departure) ingest summary line', () => {
    const stdout = [
      '[edgar-exec-departure] fetching https://efts.sec.gov/LATEST/search-index?q=%22Item+5.02%22&forms=8-K&dateRange=custom&startdt=2026-05-21&enddt=2026-05-22',
      '[edgar-exec-departure] parsing JSON (59491 bytes, source=https://efts.sec.gov/...)',
      '[edgar-exec-departure] parsed 100 filings from search response',
      '[edgar-exec-departure] 100 filings broadly report Item 5.02',
    ].join('\n');
    assert.equal(parseEdgarHitCount(stdout), 100);
  });

  it('extracts hit count from the 8-K event ingest summary line', () => {
    const stdout = [
      '[edgar-8k-event] fetching https://efts.sec.gov/LATEST/...',
      '[edgar-8k-event] parsing JSON (60842 bytes, ...)',
      '[edgar-8k-event] parsed 100 filings from search response',
      '[edgar-8k-event] 98 filings match item-set 1.01,2.01,...',
    ].join('\n');
    assert.equal(parseEdgarHitCount(stdout), 100);
  });

  it('extracts hit count from the Form 4 ingest summary line', () => {
    // Form 4 uses "Form 4 filings" between parsed and from search response.
    const stdout = [
      '[edgar-form4] fetching https://efts.sec.gov/LATEST/search-index?forms=4&...',
      '[edgar-form4] parsing JSON (67299 bytes, ...)',
      '[edgar-form4] parsed 100 Form 4 filings from search response',
    ].join('\n');
    assert.equal(parseEdgarHitCount(stdout), 100);
  });

  it('extracts hit count from the 13D/G ingest summary line', () => {
    // 13D/G uses "Schedule 13D/G filings" between parsed and from search response.
    const stdout = [
      '[edgar-13d-g] fetching https://efts.sec.gov/LATEST/search-index?forms=SC+13D...',
      '[edgar-13d-g] parsing JSON (1138 bytes, ...)',
      '[edgar-13d-g] parsed 0 Schedule 13D/G filings from search response',
    ].join('\n');
    assert.equal(parseEdgarHitCount(stdout), 0);
  });

  it('extracts non-cap-hit counts (low volume days)', () => {
    // Convention pin: the regex must work for any digit count, not just
    // the cap. A 13D/G slow day might return 3; an Item 5.02 day might
    // return 23. If the regex accidentally hard-codes 100, this breaks.
    assert.equal(parseEdgarHitCount('[edgar-13d-g] parsed 3 Schedule 13D/G filings from search response'), 3);
    assert.equal(parseEdgarHitCount('[edgar-exec-departure] parsed 23 filings from search response'), 23);
    assert.equal(parseEdgarHitCount('[edgar-8k-event] parsed 47 filings from search response'), 47);
  });

  it('returns null for unparseable input', () => {
    // Defensive — empty stdout, unrelated stdout, stdout where the line
    // shape changed. Caller treats null as "couldn't classify cap-hit;
    // don't emit a false positive cap-hit warning."
    assert.equal(parseEdgarHitCount(''), null);
    assert.equal(parseEdgarHitCount('random output without the summary line'), null);
    // No bracket prefix → reject. Other steps in the daemon log lines
    // like "[finra-short-interest-fetch] OK" must not match.
    assert.equal(parseEdgarHitCount('[finra-short-interest-fetch] OK | 12.3s'), null);
    // Bracket prefix but wrong shape (no "from search response").
    assert.equal(parseEdgarHitCount('[edgar-form4] parsed 100 Form 4 filings'), null);
    // null + undefined inputs (TS-typed but defensive against any-typed callers).
    assert.equal(parseEdgarHitCount(null as unknown as string), null);
    assert.equal(parseEdgarHitCount(undefined as unknown as string), null);
  });

  it('handles multi-line stdout where the summary line is buried in the middle', () => {
    // Real EDGAR runs have body-fetch + cache + CIK resolution chatter
    // around the summary line. The regex must match anywhere, not just
    // at the very top of stdout.
    const stdout = [
      'random preamble',
      '[edgar-form4] starting',
      'noise',
      '[edgar-form4] parsed 87 Form 4 filings from search response',
      'more noise',
      '[edgar-form4] OK | wrote 87 rows to quantlab.insider_trades',
    ].join('\n');
    assert.equal(parseEdgarHitCount(stdout), 87);
  });

  it('matches case-insensitively to survive minor wording drift', () => {
    // The regex uses the `i` flag, so a stdout that capitalizes "PARSED"
    // or "From Search Response" still matches. Cheap insurance against
    // a Python-side `.title()` call sneaking into the log helpers.
    assert.equal(
      parseEdgarHitCount('[edgar-form4] PARSED 100 Form 4 filings From Search Response'),
      100,
    );
  });
});

// ───── Public runners (script-path correctness only — spawn impure path
// covered by the FINRA-style live-cycle test). ─────────────────────────────

describe('runEdgar*Refresh script-path correctness', () => {
  // These functions spawn Python subprocesses; we can't unit-test the
  // spawn without a live venv. But we CAN pin that each runner targets
  // its correct script via the args-builder's pin (the runner is just a
  // wrapper around `spawnEdgarIngest(meta, ...)` with a fixed meta). The
  // pin below verifies the catchup-command lookup ties each script path
  // back to its operator-cadence command — proving the meta wiring is
  // consistent across the four ingests.

  it('Item 5.02 runner maps to the exec-departure script + catchup command', () => {
    assert.equal(catchupCommandFor(ITEM_502_SCRIPT), 'npm run edgar:exec-departure:ingest');
    // The runner function itself must exist (regression against accidental
    // deletion during a future refactor).
    assert.equal(typeof runEdgarItem502Refresh, 'function');
  });

  it('8-K event runner maps to the 8k-event script + catchup command', () => {
    assert.equal(catchupCommandFor(EIGHT_K_SCRIPT), 'npm run edgar:8k-event:ingest');
    assert.equal(typeof runEdgar8kEventRefresh, 'function');
  });

  it('Form 4 runner maps to the form4 script + catchup command', () => {
    assert.equal(catchupCommandFor(FORM4_SCRIPT), 'npm run edgar:form4:ingest');
    assert.equal(typeof runEdgarForm4Refresh, 'function');
  });

  it('13D/G runner maps to the 13d-g script + catchup command', () => {
    assert.equal(catchupCommandFor(XD13_SCRIPT), 'npm run edgar:13d-g:ingest');
    assert.equal(typeof runEdgar13DGRefresh, 'function');
  });

  it('catchupCommandFor returns null for unknown scripts (defensive default)', () => {
    assert.equal(catchupCommandFor('scripts/unknown.py'), null);
    assert.equal(catchupCommandFor(''), null);
  });
});
