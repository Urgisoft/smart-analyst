/**
 * Daemon orchestration helpers: refresh the four SEC EDGAR source tables
 * via the corresponding Python ingesters before composite evaluations.
 *
 *   - `scripts/sec_edgar_8k_item_5_02_ingest.py` → `quantlab.executive_departures`
 *     (consumed by step 1i — executive_departure composite)
 *   - `scripts/sec_edgar_8k_event_ingest.py`     → `quantlab.eight_k_events`
 *     (consumed by step 1k — 8-K classifier composite)
 *   - `scripts/sec_edgar_form4_ingest.py`        → `quantlab.insider_trades`
 *     (consumed by step 1l — Form 4 insider composite)
 *   - `scripts/sec_edgar_13d_g_ingest.py`        → `quantlab.schedule_13d_g_filings`
 *     (consumed by step 1m — Schedule 13D/G composite)
 *
 * Why this exists (GAP-1, audit `docs/audits/system-reconciliation-2026-05.md`
 * §6 row GAP-1; orchestration §2.1/§2.6 + §8.2 Cycle 2 slice 2): all four
 * SEC EDGAR ingests were operator-cadence until s96 #15 Cycle 2. Without
 * autonomous triggers, the daemon's composite-evaluation steps 1i/1k/1l/1m
 * read stale rows silently — the single biggest standing-health hole per
 * the audit TL;DR. Per CLAUDE.md data-source policy SEC EDGAR is
 * pre-authorized as a free source; per ADR-044 every source must have
 * either an autonomous trigger OR an explicit `OPERATOR_REFRESH_REQUIRED`
 * label. These four `-pre` steps eliminate the latter for the EDGAR
 * cluster.
 *
 * Why a 2-day rolling window (Path A — recommended by the slice brief +
 * confirmed by the three-criterion test below):
 *
 *   EDGAR full-text search returns at most 100 hits per response. The
 *   shared `scripts/_sec_edgar_helpers.py` does NOT implement `from=`
 *   pagination (that would touch the Data-Ingest domain — out of envelope
 *   for this Infra slice). On a typical US trading day Form 4 volume is
 *   ~100-300 filings (the highest of the four sources); on a 2-day window
 *   the cap is exceeded most days for Form 4 but rarely for the other
 *   three (Item 5.02 / 8-K broader / 13D/G are ~10-50/day each).
 *
 *   The 2-day window is the smallest window that survives one missed
 *   daemon cycle (host downtime, network outage, watcher-restart) without
 *   leaving a permanent hole — a 1-day window would silently lose any day
 *   the daemon skipped. The 2-day window also catches Saturday/Monday
 *   batches when EDGAR `accepted_at` rolls weekend filings into Monday's
 *   feed.
 *
 *   The 100-hit cap is accepted as a documented limitation: when hit,
 *   `runEdgar<X>Refresh` returns `capHit: true` and the daemon emits a
 *   warning anomaly with the operator-catchup command. The composite
 *   tables read through `FINAL` on ReplacingMergeTree-keyed snapshots
 *   that tolerate partial daily coverage — the signal is statistical
 *   (90d rolling windows in every composite SPEC) so missing 10-50% of
 *   one day's filings does not flip the composite output. Operator-cadence
 *   `npm run edgar:<X>:ingest` remains the catchup path for backfills
 *   and for any day where the cap-hit warning surfaces.
 *
 *   Three-criterion test (CLAUDE.md autonomous-execution; orchestration §6.2):
 *     - Canon foundations: AFML §8 (event-driven cadence + opportunistic
 *       refresh); FINRA / SEC EDGAR publication-cadence discipline; ADR-044
 *       standing-health domain 2 (data freshness).
 *     - Methodology rigor: no in-sample tuning — 2-day window is a calendar
 *       fact (window-size lower bound for survivability), not a learned
 *       parameter.
 *     - Minimum free parameters: 1 free parameter
 *       (`EDGAR_DAEMON_WINDOW_DAYS = 2`). Path B (`from=` pagination) adds
 *       the page-size parameter + retry budget + cross-page-dedup logic
 *       and is out of envelope. Path C (sub-day windows for Form 4) adds
 *       a per-ingest window parameter — rejected unless Path A
 *       demonstrably broken.
 *
 * Why the ingests' `--snapshot-date` is left unset:
 *
 *   The shared helper auto-defaults `--snapshot-date` to today, which
 *   matches the SPEC anti-leak filters (E-7 / EDF-5 / F4-10 / XD-7).
 *   Passing an operator-derived snapshot date would re-introduce
 *   operator-memory dependence — the ADR-044 anti-pattern this slice
 *   closes.
 *
 * Idempotent — every target table is `ReplacingMergeTree(ingested_at)`
 * keyed on (accession, ...). Re-running the same day is safe.
 *
 * Non-fatal at the daemon orchestration layer — failures surface as
 * `warning` anomalies. The composite evaluators continue; freshness on
 * each EDGAR source flips fresh after the next successful daemon cycle.
 *
 * Cross-references:
 *   - `src/server/daemon_finra_short_interest_fetch.ts` — closest pattern
 *     (single-spawn, gate-then-run, anomaly classification, testable pure
 *     helpers); GAP-2 sibling promotion shipped Cycle 2 slice 1.
 *   - `src/server/daemon_fred_fetch.ts` — single-spawn precedent.
 *   - `src/server/daemon_etf_flow_ssga_spdr_refresh.ts` — multi-step
 *     spawn pattern (rejected here: each EDGAR ingest is single-step).
 *   - `scripts/_sec_edgar_helpers.py` — shared rate-limit + retry + parse
 *     contract for all four ingests (Data-Ingest owned; this slice does
 *     NOT modify it).
 *   - CLAUDE.md data-source policy — SEC EDGAR is pre-authorized.
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// ── Module constants (pinned in tests) ──────────────────────────────────────

/**
 * Window size (in days) for the rolling EDGAR fetch. Pinned at 2 so a
 * missed daemon cycle (host downtime / network outage / watcher restart
 * across a single day) doesn't leave a permanent hole. Tested for
 * regression in `scripts/tests/daemonEdgarIngests.test.ts`.
 */
export const EDGAR_DAEMON_WINDOW_DAYS = 2;

/**
 * EDGAR full-text search hit-per-response cap (a server-side limit, not
 * a configurable parameter). When `parseEdgarHitCount` returns this
 * value the daemon emits a `warning` anomaly with the catchup command.
 * Pinned in tests so a future EDGAR API change (cap moves to 200, etc.)
 * surfaces as a deliberate update here rather than silently shifting
 * cap-hit semantics.
 */
export const EDGAR_PAGE_CAP = 100;

/**
 * Per-script ingester metadata. Each entry pins:
 *   - `scriptPath`: the Python script relative to repo root.
 *   - `logPrefix`: the bracket-prefix this script prints (for daemon log lines).
 *   - `catchupCommand`: the operator-cadence npm script the daemon nudges
 *     the operator toward when the page cap is hit.
 *   - `tableLabel`: human-readable target table for the anomaly message.
 */
interface EdgarIngestMeta {
  scriptPath: string;
  logPrefix: string;
  catchupCommand: string;
  tableLabel: string;
}

const META_ITEM_502: EdgarIngestMeta = {
  scriptPath: 'scripts/sec_edgar_8k_item_5_02_ingest.py',
  logPrefix: '[edgar-exec-departure]',
  catchupCommand: 'npm run edgar:exec-departure:ingest',
  tableLabel: 'executive_departures',
};

const META_8K_EVENT: EdgarIngestMeta = {
  scriptPath: 'scripts/sec_edgar_8k_event_ingest.py',
  logPrefix: '[edgar-8k-event]',
  catchupCommand: 'npm run edgar:8k-event:ingest',
  tableLabel: 'eight_k_events',
};

const META_FORM4: EdgarIngestMeta = {
  scriptPath: 'scripts/sec_edgar_form4_ingest.py',
  logPrefix: '[edgar-form4]',
  catchupCommand: 'npm run edgar:form4:ingest',
  tableLabel: 'insider_trades',
};

const META_13DG: EdgarIngestMeta = {
  scriptPath: 'scripts/sec_edgar_13d_g_ingest.py',
  logPrefix: '[edgar-13d-g]',
  catchupCommand: 'npm run edgar:13d-g:ingest',
  tableLabel: 'schedule_13d_g_filings',
};

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Format a Date as a `YYYY-MM-DD` UTC date string suitable for the EDGAR
 * ingests' `--start-date` / `--end-date` flags. Always UTC: the daemon host
 * runs Windows and `accepted_at` on EDGAR is UTC-tagged at the source.
 * Using UTC here avoids a 1-2 hour boundary error vs ET that would
 * occasionally push a same-day filing into yesterday's window.
 */
function formatYmdUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Build the spawn args + timeout for one EDGAR ingest subprocess. Pure
 * function — extracted so unit-test coverage does not need a live Python
 * venv or EDGAR reachability. Mirrors `buildFinraShortInterestArgs` style.
 *
 * Args produced (in this order):
 *   1. scriptPath (positional first-arg to the Python interpreter)
 *   2. `--start-date <today − EDGAR_DAEMON_WINDOW_DAYS + 1 days>`
 *      Window inclusivity: `EDGAR_DAEMON_WINDOW_DAYS = 2` means the start
 *      is YESTERDAY (today − 1 day) so the closed [start, end] range
 *      covers exactly 2 calendar days. Tested for regression with a
 *      fixed `asOf = 2026-05-23` (window: 2026-05-22 → 2026-05-23).
 *   3. `--end-date <today>`
 *   4. `--apply` (write mode) OR `--dry-run` (dry-run mode). The
 *      Python scripts default to dry-run; passing `--apply` is required
 *      for writes. We pass exactly one of the two flags explicitly so
 *      a future refactor to either side cannot silently make the daemon
 *      a no-op writer.
 *
 * Args INTENTIONALLY NOT passed:
 *   - `--snapshot-date`: the script auto-defaults to today, which matches
 *     the SPEC anti-leak filter. Passing an operator-derived date here
 *     would re-introduce operator-memory dependence (ADR-044 anti-pattern).
 *   - `--url` / `--from-file`: shadow operator-level changes to the
 *     script's default URL builder when EDGAR next restructures their
 *     search endpoint.
 *   - `--user-agent`: the script's `DEFAULT_USER_AGENT` is the canonical
 *     value; overriding from the daemon side would diverge from the
 *     operator-cadence command's behavior.
 *
 * Timeout: 10 minutes per ingest. EDGAR rate-limit is 10 req/sec; a single
 * fetch + parse + body-fetch loop for ~100 filings finishes in 1-3 minutes
 * in steady state. 10 minutes covers a degraded EDGAR endpoint + slow
 * CIK-resolution side-trips through the submissions API. Matches the
 * SSGA-SPDR adapter budget (10min) from
 * `src/server/daemon_etf_flow_ssga_spdr_refresh.ts`.
 */
export function buildEdgarIngestArgs(
  scriptPath: string,
  dryRun: boolean,
  asOf: Date,
): { args: string[]; timeoutMs: number } {
  const endDate = formatYmdUtc(asOf);
  // EDGAR_DAEMON_WINDOW_DAYS = 2 → start is `asOf - 1 day` (inclusive on
  // both ends so the closed range covers exactly 2 calendar days).
  const startMs = asOf.getTime() - (EDGAR_DAEMON_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000;
  const startDate = formatYmdUtc(new Date(startMs));
  const args = [
    scriptPath,
    '--start-date', startDate,
    '--end-date', endDate,
    dryRun ? '--dry-run' : '--apply',
  ];
  return { args, timeoutMs: 10 * 60_000 };
}

/**
 * Parse the EDGAR ingest's stdout for the search-response hit count.
 * Returns `null` if no matching line is found (unparseable output;
 * caller treats null as "unknown — don't classify as cap-hit").
 *
 * Each of the four scripts emits exactly one summary line of the form:
 *
 *   [edgar-exec-departure] parsed 100 filings from search response
 *   [edgar-8k-event]       parsed 100 filings from search response
 *   [edgar-form4]          parsed 100 Form 4 filings from search response
 *   [edgar-13d-g]          parsed 0 Schedule 13D/G filings from search response
 *
 * The regex below captures the `\d+` between `parsed` and `from search
 * response`, allowing arbitrary noun phrases ("filings", "Form 4 filings",
 * "Schedule 13D/G filings") in between. Anchored to the `[edgar-...]`
 * bracket-prefix to avoid false positives on similar-looking lines from
 * other steps. Multiline + caseless to survive minor stdout shape drift.
 *
 * Pure; testable; no I/O. The investigation step for this slice (s96 #15
 * Cycle 2 slice 2) pinned the exact prefixes + summary-line wording per
 * script. See the slice's HANDOFF entry for the captured outputs.
 */
export function parseEdgarHitCount(stdout: string): number | null {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  // Match: "[edgar-<prefix>] parsed <N> ... from search response"
  // The `m` flag makes `^` match at line starts; the `[\s\S]*?` is a
  // lazy any-char (incl. newline) so the wording in between (e.g. "Form 4")
  // can vary across the four scripts.
  const re = /^\[edgar-[a-z0-9-]+\]\s+parsed\s+(\d+)\s+[\s\S]*?from\s+search\s+response/im;
  const match = re.exec(stdout);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// ── Public result type ─────────────────────────────────────────────────────

export interface EdgarRefreshResult {
  /** True iff the subprocess exited 0 AND no cap-hit. Cap-hit is a partial-
   *  success warning (we got the first 100 filings); fetch failure is a
   *  full failure. Callers distinguish via `capHit` for the catchup nudge. */
  ok: boolean;
  /** Wall-clock seconds for the spawn + parse. */
  seconds: number;
  /** Number of filings returned by EDGAR full-text search. `null` if the
   *  output didn't match the expected summary-line shape (parser couldn't
   *  determine — caller treats as "don't flag cap-hit; warn on parse drift"). */
  hitCount: number | null;
  /** True iff `hitCount === EDGAR_PAGE_CAP`. When true, some filings in
   *  the 2-day window were NOT fetched; operator should run the catchup
   *  command for that ingest to backfill the missed tail. */
  capHit: boolean;
  /** First non-empty error, if the subprocess failed. */
  error?: string;
}

// ── Impure spawner (shared private helper) ─────────────────────────────────

/**
 * Spawn one EDGAR ingest subprocess + classify the result. Private — the
 * four public runners below all delegate here with their per-ingest meta.
 * Mirrors `runFinraShortInterestFetch` posture; the only added wrinkle is
 * the page-cap classification via `parseEdgarHitCount`.
 *
 * Posture: warn-and-continue. We never throw — the daemon orchestrator's
 * non-fatal handling expects a result object back. A subprocess crash
 * surfaces as `ok=false` with the captured stderr (first 300 chars to
 * stay readable in the daemon log).
 */
function spawnEdgarIngest(
  meta: EdgarIngestMeta,
  dryRun: boolean,
  asOf: Date,
): EdgarRefreshResult {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const { args, timeoutMs } = buildEdgarIngestArgs(meta.scriptPath, dryRun, asOf);
  const result = spawnSync(py, args, { encoding: 'utf8', timeout: timeoutMs });
  const seconds = (Date.now() - t0) / 1000;
  if (result.error) {
    return {
      ok: false,
      seconds,
      hitCount: null,
      capHit: false,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      seconds,
      hitCount: null,
      capHit: false,
      error: `exit ${result.status}: ${(result.stderr ?? '').slice(0, 300)}`,
    };
  }
  // Subprocess succeeded — parse hit count for cap-hit classification.
  const hitCount = parseEdgarHitCount(result.stdout ?? '');
  const capHit = hitCount !== null && hitCount >= EDGAR_PAGE_CAP;
  return {
    // Cap-hit is a *partial* success: subprocess wrote whatever filings it
    // saw before the cap. Callers get `ok: true` (rows DID land in CH if
    // `--apply` was on) but `capHit: true` so the daemon emits the
    // catchup-nudge anomaly. The composite step downstream tolerates
    // partial daily coverage; the warning is purely informational.
    ok: true,
    seconds,
    hitCount,
    capHit,
  };
}

// ── Public runners (one per EDGAR ingest) ──────────────────────────────────

/** Refresh `quantlab.executive_departures` via the 8-K Item 5.02 ingest. */
export function runEdgarItem502Refresh(dryRun: boolean, asOf: Date): EdgarRefreshResult {
  return spawnEdgarIngest(META_ITEM_502, dryRun, asOf);
}

/** Refresh `quantlab.eight_k_events` via the 8-K broader-event ingest. */
export function runEdgar8kEventRefresh(dryRun: boolean, asOf: Date): EdgarRefreshResult {
  return spawnEdgarIngest(META_8K_EVENT, dryRun, asOf);
}

/** Refresh `quantlab.insider_trades` via the Form 4 insider ingest. */
export function runEdgarForm4Refresh(dryRun: boolean, asOf: Date): EdgarRefreshResult {
  return spawnEdgarIngest(META_FORM4, dryRun, asOf);
}

/** Refresh `quantlab.schedule_13d_g_filings` via the 13D/G ingest. */
export function runEdgar13DGRefresh(dryRun: boolean, asOf: Date): EdgarRefreshResult {
  return spawnEdgarIngest(META_13DG, dryRun, asOf);
}

// ── Public catchup-command lookup (used by the daemon's anomaly messages) ──

/**
 * Map a script path to its operator-catchup npm command. Exported so the
 * daemon's anomaly-message builder can include the actionable nudge
 * without re-encoding the mapping. Returns `null` for unknown scripts —
 * the caller falls back to a generic message in that case.
 */
export function catchupCommandFor(scriptPath: string): string | null {
  if (scriptPath === META_ITEM_502.scriptPath) return META_ITEM_502.catchupCommand;
  if (scriptPath === META_8K_EVENT.scriptPath) return META_8K_EVENT.catchupCommand;
  if (scriptPath === META_FORM4.scriptPath) return META_FORM4.catchupCommand;
  if (scriptPath === META_13DG.scriptPath) return META_13DG.catchupCommand;
  return null;
}

/**
 * What could break this:
 *   - EDGAR changes the page cap (currently 100). If the cap moves up
 *     silently, `capHit` never fires + we miss the catchup nudge. The
 *     `EDGAR_PAGE_CAP` constant + the convention-pin test surface this
 *     as a deliberate update rather than a silent semantic shift.
 *   - EDGAR changes the summary-line wording (e.g. "matched" instead of
 *     "parsed"). `parseEdgarHitCount` returns null + `capHit` falls back
 *     to false — daemon emits a successful log but the cap nudge is
 *     missed. The shape pin in the convention-pin test catches this on
 *     the next test run.
 *   - The shared `_sec_edgar_helpers.py` adds `from=` pagination. The
 *     2-day window becomes redundant; whoever lands that change should
 *     update `EDGAR_DAEMON_WINDOW_DAYS` + the pin in tests + delete the
 *     cap-hit anomaly path.
 *   - The `--dry-run` AND `--apply` flag set is symmetric to FINRA's
 *     pattern. If either Python script flips its default, the daemon
 *     could silently no-op-write or write under operator-dry-run mode.
 *     The pin "exactly one of {--apply, --dry-run} is set" in tests
 *     guards against this.
 *   - Each subprocess is 1-3 minutes in steady state; four serial spawns
 *     add ~4-12 minutes to the daemon's wall-clock budget. The daemon's
 *     primary work (per-cell loops, composite evaluations) is the bulk
 *     of the run, so this overhead is acceptable. If it becomes a
 *     bottleneck, the four spawns are independent and could be wrapped
 *     in `Promise.all` against four `spawn()` calls — left as a future
 *     optimization (current `spawnSync` posture matches FINRA + FRED).
 */
