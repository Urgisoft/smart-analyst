/**
 * Daemon orchestration helper: refresh CBOE put/call ratio indicators via
 * the `scripts/cboe_putcall_json_ingest.py` Python ingester before the
 * phase1_v3 macro classifier runs.
 *
 * Why this exists (Q-5 Path D resolution, Cycle 21 of multi-agent
 * orchestration): the legacy public CSV at
 *   https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv
 * froze on 2019-10-04 (re-verified s96 #11 S96-88). The phase1_v3
 * sentiment_extreme category consumes a 5d-MA of the TOTAL P/C ratio from
 * `quantlab.macro_indicators_cboe` and has been operating on stale-from-2019
 * inputs ever since (ADR-045 quarantine). Cycle 20 slice 2 research
 * (`docs/analysis/q5-path-d-cboe-json-2026-05-24.md`) confirmed a free,
 * anonymous CBOE daily JSON endpoint at
 *   https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options
 * that has been live continuously since 2019-10-07 — the first trading day
 * after the legacy CSV froze. The new ingest writes rows with
 * `source="cboe_json"` alongside the legacy `source="cboe"` rows; no
 * methodology amendment required (same CBOE-computed TOTAL P/C scalar).
 *
 * The daemon does NOT do a full historical backfill on each run; that's a
 * one-shot operator step (`npm run cboe:ingest:json`). The steady-state
 * daemon path passes a narrow `--start` covering ~5 trading days back —
 * this keeps each daemon run to a few HTTP fetches (today + the trailing
 * weekend / Monday catch-up if the daemon missed a day) while still
 * tolerating extended off-cycles or weekend gaps. The ReplacingMergeTree
 * engine on (series_id, observation_date) makes the re-fetches idempotent.
 *
 * GAP-3 (CBOE daemon hook) resolves as a side-effect of this step landing.
 *
 * Non-fatal at the daemon orchestration layer: failures surface as a
 * warning anomaly (mirrors the FRED step's posture). The classifier
 * tolerates day-stale CBOE inputs via the macro_regimes.inputs_missing
 * bitmask.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/** Number of calendar days back the daemon's per-run window covers.
 *  Sized at 7 to cover a 5-trading-day window plus a long weekend
 *  (Fri before a Monday holiday + the holiday Monday + Tue close).
 *  The ingest's HTTP 403 handler swallows non-trading days silently;
 *  the cost of the wider window is a handful of extra fetches per run. */
const DAEMON_WINDOW_DAYS = 7;

/** Format a Date as YYYY-MM-DD in UTC. The CBOE JSON endpoint uses ISO
 *  calendar dates in its URL path; UTC normalization avoids timezone
 *  ambiguity at midnight. */
function formatIsoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Compute the daemon's `--start` argument: today UTC minus
 *  DAEMON_WINDOW_DAYS. Exported for unit-test coverage of the window math
 *  separate from the spawn wiring. */
export function computeDaemonWindowStart(now: Date = new Date()): string {
  const start = new Date(now.getTime());
  start.setUTCDate(start.getUTCDate() - DAEMON_WINDOW_DAYS);
  return formatIsoDateUtc(start);
}

/** Build the spawn args + timeout for the CBOE put/call fetch subprocess.
 *  Extracted as a pure function so unit-test coverage does not need a
 *  live Python venv or CBOE reachability. Mirrors `buildFredFetchArgs`
 *  in `daemon_fred_fetch.ts`.
 *
 *  Note: the script defaults `--ratio` to 'total' and `--source-label`
 *  to 'cboe_json'; we let those defaults stand so an upgrade to either
 *  (e.g. equity P/C refinement per the analysis doc's optional future
 *  upgrade) is a script-side edit, not a daemon-side edit. */
export function buildCboePutCallFetchArgs(
  dryRun: boolean,
  now: Date = new Date(),
): { args: string[]; timeoutMs: number } {
  const args = [
    'scripts/cboe_putcall_json_ingest.py',
    '--start',
    computeDaemonWindowStart(now),
  ];
  if (dryRun) args.push('--dry-run');
  // 10-minute budget. The narrow ~5-trading-day window completes in
  // seconds at the script's 1s-per-fetch default pacing; the budget is
  // for resilience against transient network slowness. Same shape as
  // the FRED step's budget so per-run wall-clock stays predictable.
  return { args, timeoutMs: 10 * 60_000 };
}

/** Spawn the CBOE put/call JSON ingest subprocess. Mirrors `runFredFetch`
 *  in `daemon_fred_fetch.ts` — same posture, different ingester. */
export function runCboePutCallFetch(dryRun: boolean): { ok: boolean; seconds: number; error?: string } {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const { args, timeoutMs } = buildCboePutCallFetchArgs(dryRun);
  const result = spawnSync(py, args, { encoding: 'utf8', timeout: timeoutMs });
  const seconds = (Date.now() - t0) / 1000;
  if (result.error) {
    return { ok: false, seconds, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, seconds, error: `exit ${result.status}: ${result.stderr.slice(0, 300)}` };
  }
  return { ok: true, seconds };
}
