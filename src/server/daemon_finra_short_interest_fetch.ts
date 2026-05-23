/**
 * Daemon orchestration helper: refresh the FINRA biweekly short-interest
 * source table (`quantlab.short_interest`) via the
 * `scripts/finra_short_interest_ingest.py` Python ingester before composite
 * evaluations.
 *
 * Why this exists (GAP-2, audit `docs/audits/system-reconciliation-2026-05.md`
 * §6 row GAP-2; orchestration §2.1/§2.6 + §8.2 Cycle 2): the FINRA biweekly
 * short-interest ingest was operator-cadence until s96 #15 Cycle 2.
 * Without an autonomous trigger the daemon's step 1h (short-interest
 * composite) evaluated stale rows silently. Per CLAUDE.md data-source policy
 * FINRA is pre-authorized as a free source; per ADR-044 the standing-health
 * mandate requires every source to have either an autonomous trigger OR an
 * explicit `OPERATOR_REFRESH_REQUIRED` label. Promotion eliminates the
 * latter.
 *
 * Why Mondays-only (`shouldRunFinraTodayUtc`):
 *   FINRA publishes biweekly short-interest CSVs per Rule 4560 — member
 *   firms report short positions held by customers + themselves, settled on
 *   the 15th and the last business day of each month, published ~8 business
 *   days after settlement. The publication calendar (operator-verified)
 *   surfaces new files on Mondays following the publication window. Daily
 *   fetch attempts other days waste an HTTP round-trip on a URL that
 *   resolves to the same prior settlement's CSV (already idempotent under
 *   ReplacingMergeTree, but noisy). Gating on Mondays keeps the daemon's
 *   per-run wall-clock + log signal lean.
 *
 *   Three-criterion test (CLAUDE.md autonomous-execution; orchestration §6.2):
 *     - Canon foundations: FINRA Rule 4560 publication-calendar discipline;
 *       AFML §8 on event-driven cadence + opportunistic refresh.
 *     - Methodology rigor: no in-sample tuning — Monday is a calendar fact,
 *       not a learned parameter.
 *     - Minimum free parameters: 1 free parameter (day-of-week === Monday),
 *       no thresholds or sweep dials. The alternative (run daily) would have
 *       0 parameters but a 5× noisier log signal + 5× the HTTP traffic with
 *       0 fresh-data return on Tue-Fri.
 *
 * Why the ingest's `--settlement-date` is left unset:
 *   The Python script's `most_recent_settlement_date()` helper computes the
 *   most-recently-elapsed FINRA settlement date whose 8-business-day
 *   publication window has elapsed. Passing no flag is the correct
 *   daemon-cadence behavior — a Monday daemon run after FINRA's publication
 *   window closes auto-detects + ingests; a Monday run BEFORE the window
 *   closes resolves to the prior settlement (already in CH, idempotent
 *   re-ingest). Passing an operator-derived date would re-introduce
 *   operator-memory dependence, violating ADR-044's intent.
 *
 * Idempotent — `quantlab.short_interest` is `ReplacingMergeTree(ingested_at)`
 * on `(settlement_date, symbol, cusip)`, so re-running the same Monday is
 * safe. The short-interest composite (step 1h) tolerates a missed Monday
 * because the snapshot table reads through `FINAL` on the most-recent
 * settlement row.
 *
 * Non-fatal at the daemon orchestration layer: failures surface as a warning
 * anomaly. The composite evaluator continues; freshness on
 * `short_interest` flips fresh after the next successful Monday run.
 *
 * Cross-references:
 *   - `src/server/daemon_fred_fetch.ts` — pattern reference (single-spawn).
 *   - `src/server/daemon_etf_flow_ssga_spdr_refresh.ts` — chain-spawn pattern
 *     with anomaly classification.
 *   - `docs/specs/short-interest-tracking.md` §10 (Phase A1) — the ingest
 *     SPEC consumed by step 1h's composite.
 *   - CLAUDE.md data-source policy — FINRA is pre-authorized.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

/**
 * Return true iff `now` is a Monday in UTC.
 *
 * Extracted as a pure helper so the gate logic is testable without
 * patching `Date` or constructing a daemon context. JavaScript's
 * `Date.prototype.getUTCDay()` returns 0 for Sunday and 1 for Monday;
 * we pin Monday explicitly rather than relying on a magic literal at
 * the call site.
 *
 * UTC is the load-bearing choice: the daemon runs on a Windows host
 * whose local timezone may differ from FINRA publication's Eastern
 * Time, but a UTC Monday brackets the post-weekend window FINRA
 * targets globally. The 1-2 hour boundary error vs ET is irrelevant —
 * FINRA's publication is byte-stable on the URL once posted; we just
 * need to be on the same calendar Monday.
 */
export function shouldRunFinraTodayUtc(now: Date): boolean {
  return now.getUTCDay() === 1;
}

/** Build the spawn args + timeout for the FINRA ingest subprocess.
 *  Pure function — extracted so unit-test coverage does not need a live
 *  Python venv or FINRA reachability. Mirrors `buildFredFetchArgs` style. */
export function buildFinraShortInterestArgs(dryRun: boolean): { args: string[]; timeoutMs: number } {
  const args = ['scripts/finra_short_interest_ingest.py'];
  // FINRA ingest defaults to dry-run absent an explicit flag (see the
  // script's parse_args: --apply must be passed for writes). Mirror the
  // SSGA-SPDR pattern: pass --apply on daemon write-mode, --dry-run on
  // daemon dry-run. Defensive against the script's default flipping.
  args.push(dryRun ? '--dry-run' : '--apply');
  // `--settlement-date` is intentionally NOT passed — the script's
  // `most_recent_settlement_date()` helper auto-resolves the correct
  // settlement window. Passing it would re-introduce operator-memory
  // dependence (the ADR-044 anti-pattern this slice closes).
  //
  // 5-minute budget. FINRA's biweekly CSV is ~8000 equity rows; HTTP fetch
  // + parse + CH insert finishes in <30s in steady state. 5 minutes covers
  // a degraded FINRA endpoint + a CUSIP-resolution side-trip via SEC EDGAR
  // submissions API without blocking the daemon's primary work. Matches
  // the issuer-CSV ingest budget from daemon_etf_flow_ssga_spdr_refresh.ts.
  return { args, timeoutMs: 5 * 60_000 };
}

/** Spawn the FINRA ingest subprocess. Mirrors `runFredFetch` posture — same
 *  caller contract, different ingester. */
export function runFinraShortInterestFetch(dryRun: boolean): { ok: boolean; seconds: number; error?: string } {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const { args, timeoutMs } = buildFinraShortInterestArgs(dryRun);
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
