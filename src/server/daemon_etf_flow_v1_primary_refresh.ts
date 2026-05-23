/**
 * Daemon orchestration helper: refresh the v1 yfinance primary ETF
 * panel (`quantlab.etf_shares_outstanding`) via
 * `scripts/etf_flow_ingest.py` before the etf-flow composite evaluation.
 *
 * Why this exists (GAP-4, audit `docs/audits/system-reconciliation-2026-05.md`
 * §6 row GAP-4; orchestration §2.1/§2.6 + §8.2 Cycle 2 slice 3): the v1
 * yfinance primary ETF ingest was operator-cadence pre-Cycle 2 — while
 * the v3.1 SSGA-SPDR secondary panel refreshes daemon-cadence (step 1ja,
 * shipped s96 #9 / OQ-G9-2). The asymmetry produces a comparator
 * pathology over time: the cross-validation comparator reads a
 * `fresh secondary vs stale primary` divergence row whose error signal
 * is dominated by the primary's staleness, not by any real
 * issuer-vs-Yahoo data quality delta. GAP-4 closes the asymmetry —
 * step 1jb mirrors the SSGA pattern from step 1ja so the v1 yfinance
 * primary refreshes on the same daemon cycle that consumes it.
 *
 * Per CLAUDE.md data-source policy yfinance is pre-authorized as a
 * free source; per ADR-044 every source must have either an autonomous
 * trigger OR an explicit `OPERATOR_REFRESH_REQUIRED` label.
 * `etf_shares_outstanding` previously carried the latter (the
 * `autonomous: false` flag in `src/server/health_check.ts` HEALTH_SOURCES);
 * promotion to step 1jb eliminates it. The freshness flag on the v1
 * primary flips from "operator-remembers" to "daemon-owned" in lockstep
 * with the secondary.
 *
 * Step placement (between 1ja + 1j): the SSGA secondary refresh at
 * step 1ja already commits to the "refresh the comparator's inputs
 * BEFORE step 1j writes today's snapshot" discipline. Step 1jb keeps
 * the v1 primary on the same side of step 1j — today's etf-flow
 * snapshot reads today's primary AND today's secondary, not yesterday's
 * either. Cross-validation symmetry restored at the comparator's read
 * boundary, not just at the freshness panel.
 *
 * Why a SINGLE-SPAWN shape (vs SSGA's chain-spawn): the v1 yfinance
 * ingest is a single Python script — no adapter→ingest chain. The
 * `--apply` / `--dry-run` toggle is the only knob; the script's
 * default look-back window (today − 400d → today, per
 * `DEFAULT_LOOKBACK_DAYS = 400`) is exactly the v1 SPEC's
 * trailing-1y baseline window with headroom. Passing `--start-date`
 * / `--end-date` from the daemon side would re-introduce
 * operator-memory dependence (the ADR-044 anti-pattern this slice
 * closes); the script's default is the canonical daemon-cadence behavior.
 *
 * Gate set: NO_MACRO || NO_FETCH || DRY_RUN — same as step 1ja. The
 * etf-flow cluster is in the macro-adjacent block (the etf-flow snapshot
 * is consumed alongside the macro composites in the daily brief), so the
 * NO_MACRO gate applies. NO_FETCH gates any HTTP egress
 * (yfinance fetches per-ticker shares + close panels); DRY_RUN gates
 * write-mode.
 *
 * Idempotent — `quantlab.etf_shares_outstanding` is
 * `ReplacingMergeTree(ingested_at)` keyed on `(ticker, date)`. Re-running
 * the same day over an overlapping window collapses duplicates; the
 * most-recent `ingested_at` wins per key. The etf-flow composite (step
 * 1j) tolerates a missed cycle because the snapshot table reads through
 * the same ReplacingMergeTree semantics — a stale day surfaces as
 * "carry-forward shares" in the densified panel, not as a hard hole.
 *
 * Non-fatal at the daemon orchestration layer: failures surface as a
 * warning anomaly with the operator-catchup command
 * (`npm run etf:flow:ingest`). The composite evaluator continues;
 * freshness on `etf_shares_outstanding` flips fresh after the next
 * successful daemon cycle.
 *
 * Cross-references:
 *   - `src/server/daemon_etf_flow_ssga_spdr_refresh.ts` — the closest
 *     pattern (sibling step 1ja); the comparator-divergence motivation
 *     is the same, the chain shape is the diff (SSGA chains
 *     adapter→ingest; v1 primary is single-spawn).
 *   - `src/server/daemon_finra_short_interest_fetch.ts` — recent
 *     single-spawn precedent shipped Cycle 2 slice 1.
 *   - `src/server/daemon_fred_fetch.ts` — original single-spawn precedent.
 *   - `scripts/etf_flow_ingest.py` — the Data-Ingest-owned script this
 *     helper spawns; this slice does NOT modify it.
 *   - CLAUDE.md data-source policy — yfinance is pre-authorized.
 *   - `docs/specs/etf-flow-monitoring.md` §4 (inputs) + §6 (DDL) +
 *     §10 (Phase A1) — the v1 SPEC the ingest implements.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/** Build the spawn args + timeout for the v1 yfinance primary ETF ingest
 *  subprocess. Pure function — extracted so unit-test coverage does not
 *  need a live Python venv or yfinance reachability. Mirrors the
 *  `buildFinraShortInterestArgs` / `buildSsgaSpdrAdapterArgs` style.
 *
 *  Args produced:
 *    1. `scripts/etf_flow_ingest.py` (positional first-arg to Python)
 *    2. `--apply` (write mode) OR `--dry-run` (dry-run mode). The Python
 *       script defaults to dry-run absent `--apply` (per its parse_args);
 *       we pass exactly one of the two flags explicitly so a future
 *       refactor to either side cannot silently make the daemon a no-op
 *       writer. Mirrors the FINRA + SSGA-SPDR + EDGAR pattern.
 *
 *  Args INTENTIONALLY NOT passed:
 *    - `--start-date` / `--end-date`: the script defaults to
 *      `today − DEFAULT_LOOKBACK_DAYS (400 days)` → `today`, which is
 *      exactly the v1 SPEC's trailing-1y baseline window with ~35d
 *      headroom (handles missed daemon cycles + weekend gaps).
 *      Passing operator-derived dates here would re-introduce
 *      operator-memory dependence — the ADR-044 anti-pattern GAP-4
 *      closes.
 *    - `--tickers`: the script's `ETF_UNIVERSE` constant (21 ETFs per
 *      SPEC F-UNIVERSE) is the canonical daemon-cadence list. Adding
 *      a flag here would silently shadow operator-level edits to the
 *      universe constant.
 *
 *  Timeout: 10 minutes. The v1 ingest fetches 21 ETF panels sequentially
 *  via yfinance (shares-outstanding via `Ticker.get_shares_full` +
 *  daily close via `Ticker.history`). Steady-state finishes in
 *  ~30-90 seconds; 10 minutes covers a degraded yfinance endpoint
 *  + rate-limit back-offs without blocking the daemon's primary work.
 *  Matches the SSGA-SPDR adapter budget (10min) from the sibling
 *  step 1ja and the EDGAR per-ingest budget (10min).
 */
export function buildEtfFlowV1PrimaryArgs(dryRun: boolean): { args: string[]; timeoutMs: number } {
  const args = ['scripts/etf_flow_ingest.py'];
  args.push(dryRun ? '--dry-run' : '--apply');
  return { args, timeoutMs: 10 * 60_000 };
}

/** Spawn the v1 yfinance primary ETF ingest subprocess. Mirrors
 *  `runFinraShortInterestFetch` / `runFredFetch` posture — same caller
 *  contract, different ingester. Single-spawn (no chain — the v1
 *  primary is one script, unlike SSGA which chains adapter→ingest).
 *
 *  Posture: warn-and-continue. We never throw — the daemon
 *  orchestrator's non-fatal handling expects a result object back. A
 *  subprocess crash surfaces as `ok=false` with the captured stderr
 *  (first 300 chars to stay readable in the daemon log; same truncation
 *  budget as FINRA / SSGA / EDGAR).
 */
export function runEtfFlowV1PrimaryRefresh(dryRun: boolean): { ok: boolean; seconds: number; error?: string } {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const { args, timeoutMs } = buildEtfFlowV1PrimaryArgs(dryRun);
  const result = spawnSync(py, args, { encoding: 'utf8', timeout: timeoutMs });
  const seconds = (Date.now() - t0) / 1000;
  if (result.error) {
    return { ok: false, seconds, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, seconds, error: `exit ${result.status}: ${(result.stderr ?? '').slice(0, 300)}` };
  }
  return { ok: true, seconds };
}

/**
 * What could break this:
 *   - yfinance changes the `Ticker.get_shares_full` API shape (e.g. the
 *     Yahoo SEC filings endpoint backing it). The Python script handles
 *     per-ticker failure non-fatally (logs + skips), but a wholesale
 *     API shape change would fail the entire ingest. The 10-minute
 *     timeout + warn-and-continue posture mean the daemon stays up;
 *     the operator-catchup nudge in the daemon's anomaly message
 *     points at `npm run etf:flow:ingest` for diagnosis.
 *   - The `--apply` / `--dry-run` flag set is symmetric to FINRA's
 *     pattern. If the Python script flips its default to apply-mode,
 *     the daemon would silently write under operator-dry-run mode.
 *     The pin "exactly one of {--apply, --dry-run} is set" in
 *     `scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts` guards
 *     against this.
 *   - The script's `DEFAULT_LOOKBACK_DAYS = 400` shifts (e.g. someone
 *     trims it to 60 days for a faster cold-start). The daemon would
 *     silently start covering a shorter trailing window; the etf-flow
 *     composite's 252-day baseline would gradually degrade. Pin: the
 *     `etf_shares_outstanding` health entry's cadence of `daily`
 *     surfaces missed days; a shrinking window would surface as
 *     panel age regressing on the freshness dashboard.
 *   - 21 sequential yfinance fetches in steady state are ~1-3s each
 *     (HTTP + parse). Cumulative ~30-90s normal; 10min ceiling covers
 *     rate-limit back-offs. If yfinance imposes aggressive throttling,
 *     a future optimization could parallelize via `concurrent.futures`
 *     in the Python script (Data-Ingest domain — out of envelope for
 *     this Infra slice).
 */
