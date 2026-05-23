/**
 * Daemon orchestration helper: refresh the Gap #9 v3.1 SSGA-SPDR secondary
 * panel by chaining
 *   1. `scripts/etf_flow_ssga_spdr_adapter.py --apply` (s96 #7) — fetches
 *      navhist XLSX per SPDR ETF + writes `data/etf_flow_issuer_csv/ssga-
 *      spdr.csv`, then
 *   2. `scripts/etf_flow_issuer_csv_ingest.py --source-label ssga-spdr
 *      --apply` (s95 #9) — parses the CSV + writes to
 *      `quantlab.etf_shares_outstanding_secondary`.
 *
 * Closes OQ-G9-2 from the s96 #7/8 HANDOFF — wires the SSGA refresh into
 * the daily daemon so the cross-validation comparator's secondary panel
 * stays warm without operator intervention. The same logical chain that
 * `npm run etf:flow:ssga-spdr:refresh` (s96 #8) packages for operator
 * use, executed via Node spawn for daemon-cadence automation.
 *
 * Why a SEPARATE helper vs a single `&&`-chained npm-script spawn: the
 * daemon's posture is "report partial failure cleanly" not "halt or pass."
 * The wrapper script's `&&` shortcuts on fetch failure (correct for
 * operator-runs) — but the daemon needs per-step status for the anomaly
 * list. This helper spawns each step explicitly so the orchestrator can
 * distinguish "adapter failed" (warn; skip ingest) from "adapter ok,
 * ingest failed" (warn; rows-in-CSV present-but-not-promoted-to-CH).
 *
 * Why this fires BEFORE step 1j (etf-flow composite) in the daemon:
 * the etf-flow snapshot reads the cross-validation panel via the
 * EtfFlowRepository — refreshing the secondary BEFORE the snapshot
 * write means today's comparator divergence row reflects today's SSGA
 * data, not yesterday's. The v1 yfinance primary (`etf:flow:ingest`)
 * remains operator-cadence per s92 design; only the v3.1 secondary
 * auto-refreshes here.
 *
 * Idempotent at both layers — adapter overwrites the CSV deterministically
 * (sorted by ticker, date); ingest writes via `ReplacingMergeTree(ingested_at)`
 * on `(ticker, date)`. Re-running mid-cycle is safe.
 *
 * Non-fatal at the daemon orchestration layer: any failure surfaces as
 * a warning anomaly. The etf-flow composite (step 1j) handles a stale
 * secondary panel cleanly — `ReplacingMergeTree(ingested_at)` preserves
 * the last-good row set even when today's ingest is skipped.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/** Build the spawn args + timeout for the SSGA-SPDR adapter subprocess.
 *  Pure function — extracted so unit-test coverage does not need a live
 *  Python venv or SSGA reachability. */
export function buildSsgaSpdrAdapterArgs(dryRun: boolean): { args: string[]; timeoutMs: number } {
  const args = ['scripts/etf_flow_ssga_spdr_adapter.py'];
  args.push(dryRun ? '--dry-run' : '--apply');
  // 10-minute budget. The adapter fetches 13 SPDR navhist XLSX files
  // sequentially with a 30s per-file HTTP timeout (worst-case ~6.5min if
  // every fetch hits its ceiling). 10 minutes gives headroom + matches
  // the FRED-fetch budget from src/server/daemon_fred_fetch.ts.
  return { args, timeoutMs: 10 * 60_000 };
}

/** Build the spawn args + timeout for the issuer-CSV ingest subprocess
 *  with the source-label plumbed through. Pure function — unit-tested
 *  for the same reason as `buildSsgaSpdrAdapterArgs`. */
export function buildIssuerCsvIngestArgs(dryRun: boolean): { args: string[]; timeoutMs: number } {
  const args = [
    'scripts/etf_flow_issuer_csv_ingest.py',
    '--source-label', 'ssga-spdr',
  ];
  args.push(dryRun ? '--dry-run' : '--apply');
  // 5-minute budget. CSV parse + CH insert for ~13×365 = ~4,745 rows is
  // sub-second in steady state; 5 minutes covers a CH-unreachable retry
  // path without blocking the daemon's primary work.
  return { args, timeoutMs: 5 * 60_000 };
}

export interface SsgaSpdrRefreshResult {
  /** True iff BOTH adapter + ingest succeeded (or both skipped under dryRun).
   *  Partial success (adapter ok, ingest failed) is `ok=false` with
   *  `adapterOk=true, ingestOk=false`. */
  ok: boolean;
  seconds: number;
  /** Per-step status — lets the orchestrator distinguish "fetch died" from
   *  "fetch ok, write to CH died." */
  adapterOk: boolean;
  ingestOk: boolean;
  /** First non-empty error encountered; lets the orchestrator log
   *  a single anomaly without surfacing both errors twice. */
  error?: string;
}

/** Spawn the SSGA adapter + (on success) the issuer-CSV ingest. Mirrors
 *  `runFredFetch` / `runMacroFetch` posture — same caller contract,
 *  different ingester. The ingest step is skipped on adapter failure
 *  (same `&&`-chain semantics as the `etf:flow:ssga-spdr:refresh` npm
 *  script wrapper from s96 #8; the adapter's exit-1-on-all-fail contract
 *  from S96-32 guarantees nothing-to-ingest in that branch). */
export function runSsgaSpdrRefresh(dryRun: boolean): SsgaSpdrRefreshResult {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';

  const adapter = buildSsgaSpdrAdapterArgs(dryRun);
  const adapterResult = spawnSync(py, adapter.args, { encoding: 'utf8', timeout: adapter.timeoutMs });
  if (adapterResult.error) {
    return {
      ok: false,
      seconds: (Date.now() - t0) / 1000,
      adapterOk: false,
      ingestOk: false,
      error: `adapter: ${adapterResult.error.message}`,
    };
  }
  if (adapterResult.status !== 0) {
    return {
      ok: false,
      seconds: (Date.now() - t0) / 1000,
      adapterOk: false,
      ingestOk: false,
      error: `adapter exit ${adapterResult.status}: ${adapterResult.stderr.slice(0, 300)}`,
    };
  }

  const ingest = buildIssuerCsvIngestArgs(dryRun);
  const ingestResult = spawnSync(py, ingest.args, { encoding: 'utf8', timeout: ingest.timeoutMs });
  if (ingestResult.error) {
    return {
      ok: false,
      seconds: (Date.now() - t0) / 1000,
      adapterOk: true,
      ingestOk: false,
      error: `ingest: ${ingestResult.error.message}`,
    };
  }
  if (ingestResult.status !== 0) {
    return {
      ok: false,
      seconds: (Date.now() - t0) / 1000,
      adapterOk: true,
      ingestOk: false,
      error: `ingest exit ${ingestResult.status}: ${ingestResult.stderr.slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    seconds: (Date.now() - t0) / 1000,
    adapterOk: true,
    ingestOk: true,
  };
}
