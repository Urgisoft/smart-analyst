/**
 * Daemon orchestration helper: refresh FRED macro indicators via the
 * `scripts/fred_ingest.py` Python ingester before composite evaluations.
 *
 * Why this exists (session 88 continuation discovery): the daemon's
 * `[macro-fetch]` step calls `scripts/macro_regime_ingest.py`, which is
 * YF-only — it does NOT refresh FRED series. phase1_v3, cycle-position,
 * and cross-asset (s88) all read FRED inputs (T10Y3M, T10Y2Y, BAA10Y,
 * BAMLH0A0HYM2, UNRATE, ICSA, DFII10, DFII5, DTWEXBGS); without a
 * dedicated FRED fetch step, those inputs stagnate over time. The
 * cross-asset composite's first run exposed the gap (inputs=0b111100 —
 * DXY + real-rate inputs missing). phase1_v3 + cycle-position previously
 * survived because older runbook habit ran `fred:ingest` manually.
 *
 * The default series list (DEFAULT_SERIES in fred_ingest.py) covers all
 * 12 FRED series the four Layer-0 composites depend on; no --series
 * filter is passed here so new series added to the script later are
 * picked up automatically.
 *
 * Idempotent under ReplacingMergeTree on (series_id, observation_date).
 * Non-fatal at the daemon orchestration layer: failures surface as a
 * warning anomaly. Composite evaluations downstream tolerate stale-by-
 * a-day FRED inputs (the cross-asset repository's
 * readLatestSeriesValuesAsOf falls through to most-recent-on-or-before).
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/** Build the spawn args + timeout for the FRED fetch subprocess. Extracted
 *  as a pure function so unit-test coverage does not need a live Python
 *  venv or FRED reachability. */
export function buildFredFetchArgs(dryRun: boolean): { args: string[]; timeoutMs: number } {
  const args = ['scripts/fred_ingest.py'];
  if (dryRun) args.push('--dry-run');
  // 10-minute budget. Default incremental pulls finish in <30s for 12
  // series; a clean ingest from 1996 takes ~3-5 min depending on FRED
  // endpoint speed. Keeps the daemon's per-run wall-clock predictable.
  return { args, timeoutMs: 10 * 60_000 };
}

/** Spawn the FRED ingest subprocess. Mirrors `runMacroFetch` in
 *  `scripts/daily_signal_daemon.ts` — same posture, different ingester. */
export function runFredFetch(dryRun: boolean): { ok: boolean; seconds: number; error?: string } {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const { args, timeoutMs } = buildFredFetchArgs(dryRun);
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
