/**
 * Daemon orchestration helper: auto-run the ADR-044 Phase 1 health check
 * (+ Phase 2 v1 quarantine summary) at the start of every `daemon:daily`
 * cycle and emit one informational anomaly + a stdout heartbeat line.
 *
 * Why this exists (ADR-044 §implementation-plan Phase 2 item 5;
 * orchestration §8.3 Cycle 3 slice 2 — Infra worker): ADR-044 §workflow-
 * change mandates that "the operator should never have to remind the
 * assistant to check health first." Step 0a is the autonomous-trigger
 * realization of that mandate at daemon-cadence: every daemon cycle starts
 * with a fresh freshness probe + quarantine summary so the §0 daily digest
 * (rendered by the morning brief) reads recent data without operator
 * involvement.
 *
 * Why this is the FIRST step (before yfinance fetch):
 *
 *   The §0 digest's freshness summary is most useful when it reflects the
 *   state BEFORE the daemon ran (so the operator can see which sources
 *   were behind going in — the daemon's own work then updates those
 *   sources). Running step 0a after the fetch + classify cycle would
 *   collapse the "what was stale" signal into "what's stale right now"
 *   which is operationally less interesting (the operator can always
 *   re-run `npm run health:check` for that view).
 *
 *   Three-criterion test for the placement (CLAUDE.md autonomous-execution;
 *   orchestration §6.4 routine-design):
 *     - Canon foundations: ADR-044 §workflow-change is explicit on
 *       "session-start workflow" — run health-check first, THEN feature work.
 *       The daemon cycle is the autonomous analog of a session.
 *     - Methodology rigor: no in-sample tuning — placement is a design
 *       choice, not a tunable parameter.
 *     - Minimum free parameters: 0 thresholds, 0 sweep knobs. Path A
 *       (step 0a at top) and Path B (step 0a at end) both have 0
 *       parameters; choosing Path A on canon grounds.
 *
 * Why this NEVER halts the daemon (ADR-044 §6.2):
 *
 *   "The broken health check does not block feature work." A failure in
 *   the health probe (CH unreachable, quarantine table absent, transient
 *   network blip) must NOT propagate to the daemon's primary work. The
 *   runner wraps both probes in a single try/catch and returns a
 *   structured `HealthCheckStep0aResult` with `probeOk: false` + one
 *   `'error'` anomaly when the probe itself fails. Downstream steps
 *   proceed unchanged.
 *
 * Anomaly contract (Phase 2 v1):
 *
 *   - Tier-2 pending >= 1   → 1 'warning' anomaly with the count + top
 *                              row's source label. Matches the existing
 *                              FINRA/EDGAR `severity: 'warning'` precedent
 *                              for operator-relevant-but-non-fatal signals.
 *   - any stale / very-stale / missing-table from the Phase 1 freshness
 *                              probe (with no Tier-2 pending)
 *                          → 1 'info' anomaly (rolled up; per-source detail
 *                            lives on /#/health). One anomaly rather than
 *                            N to avoid spamming the daemon log + Telegram
 *                            channel.
 *   - all clean             → 1 'info' anomaly "Health digest clean:
 *                            fresh=<N>" so the daemon log carries a
 *                            positive heartbeat for the operator.
 *   - probe failure         → 1 'error' anomaly with the underlying error
 *                            message (non-fatal at the daemon layer).
 *
 *   The single-anomaly-per-state contract keeps the daemon's existing
 *   `anomalies_json` field bounded — the brief renderer + Telegram alerter
 *   already consume that field for the per-cycle anomaly stream. Worker C
 *   (Telegram alerter, future) consumes the quarantine table directly via
 *   `loadAllQuarantineRows` for Tier-2 detail, not the daemon anomaly
 *   stream.
 *
 * Idempotent — step 0a reads only; no writes. Side effects:
 *   - One CH SELECT per Phase 1 source + per migration (existing surface).
 *   - One CH SELECT against `system.tables` to probe for the quarantine
 *     table + one SELECT FROM quantlab.health_quarantine FINAL when the
 *     table exists. Both are cheap (small row counts; the table is
 *     designed to stay small per ADR-044).
 *
 * Cross-references:
 *   - `src/server/health_check.ts` — Phase 1 freshness probe (consumed).
 *   - `src/server/health_quarantine.ts` — Phase 2 v1 quarantine summary (consumed).
 *   - `src/server/daemon_finra_short_interest_fetch.ts` — pure-helper +
 *     impure-runner shape this module mirrors.
 *   - `docs/specs/adr-044-standing-system-health-ownership.md`
 *     §implementation-plan Phase 2.
 *   - `docs/architecture/multi-agent-orchestration.md` §8.3 Cycle 3.
 *
 * What could break this:
 *   - The `HealthCheckResponse` shape from `health_check.ts` is consumed
 *     here. A non-additive change (rename of `summary.fresh` /
 *     `summary.stale` / etc) would silently mis-classify the anomaly
 *     stream. Phase 2 v1 trusts the existing convention pins in
 *     `healthCheck.test.ts` to catch shape drift.
 *   - The `QuarantineSummary` shape from `health_quarantine.ts` is the
 *     other consumed contract. Worker A's binding-contract docstring
 *     enumerates the fields used here.
 *   - The runner's never-throw contract is load-bearing: if a future
 *     refactor lets an exception propagate, the daemon's downstream
 *     steps will fail to run. The unit tests pin the throw-swallow
 *     posture explicitly.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { runHealthCheck, type HealthCheckResponse } from './health_check.js';
import {
  loadQuarantineSummary,
  quarantineTableExists,
  type QuarantineSummary,
} from './health_quarantine.js';

/** Anomaly shape — narrower projection of the daemon's anomalies-array shape
 *  (matches the literal-typed array declared at scripts/daily_signal_daemon.ts).
 *  Kept inline so this module does not pull the daemon's symbol surface. */
export interface Step0aAnomaly {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface HealthCheckStep0aResult {
  /** ISO 8601 — when the probe ran. */
  ranAt: string;
  /** Phase 1 freshness + migrations response, or null when the probe threw. */
  phase1: HealthCheckResponse | null;
  /** Phase 2 quarantine summary, or null when the quarantine probe threw
   *  OR the table doesn't exist yet (pre-migration state). */
  quarantine: QuarantineSummary | null;
  /** One-and-only anomaly per the contract documented at module header. */
  anomalies: ReadonlyArray<Step0aAnomaly>;
  /** True when both probes ran end-to-end without throwing. False on either
   *  CH unreachable OR a probe-internal exception. The daemon proceeds
   *  regardless. */
  probeOk: boolean;
}

/**
 * Build the anomalies array from a Phase 1 response + quarantine summary.
 * Pure — extracted so the rules are testable without CH or a Date stub.
 *
 * The output is ALWAYS a one-element array. The single-anomaly contract
 * keeps `anomalies_json` small + keeps the brief renderer's anomaly-list
 * code path simple. Tier-2 detail lives on /#/health; the daemon anomaly
 * stream is a roll-up.
 *
 * Severity rules (also enumerated at the module header):
 *   - Phase 1 null (probe itself threw) → 'error'.
 *   - Tier-2 pending >= 1 → 'warning'.
 *   - any non-fresh Phase 1 source → 'info' (roll-up).
 *   - everything clean → 'info' heartbeat.
 *
 * The Tier-2-pending check WINS OVER the stale-roll-up — if the operator
 * has both a Tier-2 pending row AND a stale source, the more-urgent signal
 * surfaces. Matches the orchestration §6 critic-priority intuition.
 */
export function buildStep0aAnomalies(
  phase1: HealthCheckResponse | null,
  quarantine: QuarantineSummary | null,
): ReadonlyArray<Step0aAnomaly> {
  if (phase1 === null) {
    return [{
      severity: 'error',
      message:
        'Health digest probe failed (Phase 1 unreachable). ' +
        'Run `npm run health:check` for details; daemon proceeded with downstream steps.',
    }];
  }

  // Tier-2 pending dominates the severity — see canon-thin choice in module header.
  if (quarantine !== null && quarantine.tier2PendingCount > 0) {
    const top = quarantine.recentTier2Rows[0];
    const topLabel =
      top !== undefined ? `${top.sourceLabel} (${top.adrRef || 'ADR-tbd'})` : '(no detail)';
    return [{
      severity: 'warning',
      message:
        `Health digest: ${quarantine.tier2PendingCount} Tier-2 pending — top: ${topLabel}. ` +
        'Operator review queued via /#/health.',
    }];
  }

  const s = phase1.summary;
  const nonFreshCount = s.stale + s.veryStale + s.missing + s.neverPopulated;
  if (nonFreshCount > 0) {
    return [{
      severity: 'info',
      message:
        `Health digest: ${nonFreshCount} non-fresh source(s) — ` +
        `stale=${s.stale}, very-stale=${s.veryStale}, missing=${s.missing}, empty=${s.neverPopulated}. ` +
        'Detail on /#/health.',
    }];
  }

  // Clean heartbeat — every fresh source path. unknown-cadence is INFO-level
  // (operator-readable as "couldn't measure age") and doesn't block clean.
  return [{
    severity: 'info',
    message: `Health digest clean: fresh=${s.fresh} of ${phase1.sources.length} sources.`,
  }];
}

/**
 * Run the Phase 1 health check + the Phase 2 quarantine summary, package
 * the result, and emit the anomaly. NEVER throws; NEVER halts the daemon.
 *
 * Dependency injection (`opts`) lets unit tests stub the probes without
 * patching the global ClickHouse client or runHealthCheck import. Production
 * callers pass `{ch}` (typically the daemon's shared client) and the
 * defaults handle the rest.
 *
 * Error contract:
 *   - Phase 1 throw → phase1=null, quarantine=null, single 'error' anomaly.
 *     We do NOT attempt the quarantine read after a Phase 1 failure (likely
 *     same CH-unreachable cause + same result).
 *   - Phase 1 ok, quarantine table missing → quarantine=null, anomaly per
 *     buildStep0aAnomalies (info/warning depending on Phase 1 state).
 *   - Phase 1 ok, quarantine throws → quarantine=null + Phase 1 result is
 *     still surfaced. probeOk=false (one probe failed) but we keep the
 *     freshness signal.
 *   - Both ok → probeOk=true.
 */
export async function runHealthCheckStep0a(
  opts: {
    ch?: ClickHouseClient;
    runHealthCheckFn?: () => Promise<HealthCheckResponse>;
    quarantineTableExistsFn?: () => Promise<boolean>;
    loadQuarantineSummaryFn?: () => Promise<QuarantineSummary>;
    now?: () => Date;
  } = {},
): Promise<HealthCheckStep0aResult> {
  const now = opts.now?.() ?? new Date();
  const ranAt = now.toISOString();
  const ch = opts.ch;
  const runP1 =
    opts.runHealthCheckFn ?? (() => runHealthCheck(ch !== undefined ? { ch } : {}));
  const probeQT =
    opts.quarantineTableExistsFn ?? (() => quarantineTableExists(ch));
  const loadQS =
    opts.loadQuarantineSummaryFn ?? (() => loadQuarantineSummary(ch !== undefined ? { ch } : {}));

  // Phase 1 probe.
  let phase1: HealthCheckResponse | null = null;
  try {
    phase1 = await runP1();
  } catch {
    return {
      ranAt,
      phase1: null,
      quarantine: null,
      anomalies: buildStep0aAnomalies(null, null),
      probeOk: false,
    };
  }

  // Phase 2 quarantine probe. Independent try/catch — a quarantine-table
  // failure does NOT wipe the Phase 1 signal.
  let quarantine: QuarantineSummary | null = null;
  let quarantineProbeOk = true;
  try {
    if (await probeQT()) {
      quarantine = await loadQS();
    }
    // Table absent is NOT an error — it's pre-migration state (graceful-
    // degrade per Worker A's binding contract).
  } catch {
    quarantineProbeOk = false;
  }

  return {
    ranAt,
    phase1,
    quarantine,
    anomalies: buildStep0aAnomalies(phase1, quarantine),
    probeOk: quarantineProbeOk,
  };
}
