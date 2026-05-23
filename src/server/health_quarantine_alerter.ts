/**
 * Health quarantine Telegram alerter — ADR-044 Phase 2 v1 (Cycle 3 Worker C).
 *
 * One-shot dispatcher that:
 *   1. Loads unalerted Tier-2 quarantine rows from `quantlab.health_quarantine`
 *      (status ∈ {pending, accepted-as-warning} by default; resolved rows
 *      never re-alert).
 *   2. Excludes rows whose id is already in the
 *      `quantlab.health_quarantine_alerts_sent` sidecar (per-id dedupe).
 *   3. Formats each remaining row as HTML per the Telegram parse_mode contract
 *      (`src/alerts/telegram.ts` HTML mode + 1s rate-limit + escapeHtml).
 *   4. Sends one message per row via `SignalForgeTelegram.send`.
 *   5. Records each successful send in the sidecar so the row never re-alerts.
 *
 * Why a sidecar table rather than a status flag on `health_quarantine`:
 *   The alerter is a Health-owned read-side concern. Mutating
 *   `health_quarantine` (Worker A's table) from this module would couple the
 *   "what's wrong" surface to the "did we tell the operator yet" surface; a
 *   future re-alert-on-status-transition feature (Phase 2 v2) needs to keep
 *   those orthogonal. The sidecar's ReplacingMergeTree(sent_at) ORDER BY (id)
 *   gives idempotent re-insert (re-running the alerter is a no-op once a row
 *   is recorded) AND a forward path for Phase 2 v2.
 *
 * Why this NEVER throws:
 *   ADR-044 §workflow: "a broken health check does not block feature work."
 *   The alerter sits in the same blast-radius envelope as step 0a. Every code
 *   path in `sendQuarantineAlerts` is wrapped so a CH outage, a Telegram
 *   network blip, a JSON parse failure, or a stub-loader exception returns a
 *   structured `AlertRunResult` with `errorCount >= 1` + a 'warning' anomaly
 *   — never a thrown exception. Daemon step 0b's caller catches anyway
 *   (defense-in-depth, mirroring step 0a's envelope) but the contract here is
 *   first-line.
 *
 * Why HTML parse_mode (not Markdown):
 *   `src/alerts/telegram.ts` defaults to HTML with a plain-text fallback on
 *   error. The existing daemon report uses HTML + escapeHtml; mirroring keeps
 *   one set of escaping conventions across all SignalForge alerts.
 *
 * Anomaly contract (multi-agent-orchestration §3.2 worker output):
 *   - Telegram unconfigured           → 1 'info'    + zeros + no CH writes
 *   - Quarantine table absent         → 1 'info'    + zeros (Worker A migration not applied)
 *   - Alerts-sent sidecar absent      → 1 'info'    + zeros (this slice's migration not applied)
 *   - 0 unalerted rows                → 1 'info'    + zeros (steady state)
 *   - Cap hit (rows > maxAlertsPerRun)→ 1 'warning' + send up-to-cap
 *   - Per-row send failure            → 1 'warning' per failure + errorCount++
 *   - Success                         → 1 'info'    'sent N new Tier-2 alerts'
 *   - Loader throws (defense)         → 1 'warning' 'alerter probe failed' + errorCount=1
 *
 * Provenance:
 *   - ADR-044 §infrastructure-4 (Telegram alerts for Tier-2 only).
 *   - ADR-044 §two-tier-auto-remediation (Tier-1 auto-fixes roll up in the
 *     daily digest; not here).
 *   - multi-agent-orchestration §8.3 Cycle 3 item 6.
 *   - `src/server/health_quarantine.ts` (Worker A) — the QuarantineRow shape
 *     + `loadAllQuarantineRows` are binding contracts; this module imports
 *     from them and must not modify Worker A's file.
 *
 * What could break this:
 *   - If Worker A's `QuarantineRow` shape changes non-additively, the
 *     formatter's field references would break. Mitigated by the field-by-
 *     field byte-pin in `healthQuarantineAlerter.test.ts`.
 *   - If `SignalForgeTelegram.send` ever starts throwing instead of returning
 *     false, the per-row catch wraps that — but the test's
 *     `stub.send = () => { throw ... }` case pins the never-throws contract.
 *   - Telegram's 4096-char message ceiling is approached by the per-field
 *     truncation caps (300+500+300 + ~250 of wrapping HTML = ~1350 worst
 *     case). Tighten the caps if the operator-facing message ever truncates.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  loadAllQuarantineRows,
  quarantineTableExists,
  type QuarantineRow,
  type QuarantineStatus,
} from './health_quarantine.js';
import { SignalForgeTelegram, escapeHtml } from '../alerts/telegram.js';

// ── Constants pinned by the test suite ──────────────────────────────────────

/** Per-row truncation lengths for the three free-form quarantine fields.
 *  Picked so a fully-saturated message stays well under Telegram's 4096-char
 *  ceiling with the wrapping HTML included. */
export const OFFENDING_VALUE_MAX_CHARS = 300;
export const EXPLANATION_MAX_CHARS = 500;
export const OPERATOR_ACTION_MAX_CHARS = 300;

/** Hard cap on alerts dispatched in a single `sendQuarantineAlerts` call.
 *  Prevents a sudden burst of new Tier-2 rows (unlikely but possible — e.g.
 *  a future plausibility-band probe flagging multiple sources at once) from
 *  spamming the operator's Telegram channel. Remaining rows roll over to the
 *  next daemon cycle. */
export const DEFAULT_MAX_ALERTS_PER_RUN = 10;

/** Default statuses considered "unalerted-eligible" — anything an operator
 *  has NOT resolved. `accepted-as-warning` rows DO alert once (the Q-5 row
 *  will fire on first daemon run after this slice ships; that's intended
 *  per ADR-044 §infrastructure-4 first-alert semantics). */
export const DEFAULT_INCLUDE_STATUSES: ReadonlyArray<QuarantineStatus> = [
  'pending',
  'accepted-as-warning',
] as const;

export const ALERTS_SENT_DATABASE = 'quantlab';
export const ALERTS_SENT_TABLE = 'health_quarantine_alerts_sent';

// ── Public types ────────────────────────────────────────────────────────────

/** Loose anomaly shape — matches the daemon's existing anomaly stream so
 *  pushed entries integrate without translation. */
export interface AlerterAnomaly {
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface AlertRunResult {
  sentCount: number;
  /** Rows present but NOT sent this cycle (cap-hit overflow OR Telegram unconfigured). */
  skippedCount: number;
  errorCount: number;
  anomalies: AlerterAnomaly[];
}

/** Loader contract — the test suite swaps real CH calls for fakes via this. */
export interface QuarantineLoader {
  (opts: {
    ch?: ClickHouseClient;
    includeStatuses: ReadonlyArray<QuarantineStatus>;
  }): Promise<QuarantineRow[]>;
}

/** Recorder contract — the test suite swaps real inserts for spy fns. */
export interface AlertRecorder {
  (args: {
    id: string;
    chatId: string;
    message: string;
    ch?: ClickHouseClient;
  }): Promise<void>;
}

/** Minimal Telegram surface the alerter requires. Real impl is
 *  `SignalForgeTelegram`; the test suite stubs this. */
export interface TelegramLike {
  isConfigured(): boolean;
  send(text: string): Promise<boolean>;
}

// ── Pure helpers (test-pinned byte-equal) ───────────────────────────────────

/**
 * Truncate a string to `maxChars` characters, appending '…' if truncated.
 * The replacement char itself counts toward the length, so the returned
 * string is at most `maxChars` characters long.
 *
 * Empty / null-ish inputs return '—' (em dash) — the formatter uses em-dash
 * as the canonical empty marker for the optional ref fields too.
 */
export function truncateForAlert(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Reserve one char for the ellipsis. maxChars=0 is a programmer error; guard
  // with Math.max so it still degrades to a sensible value.
  const sliceTo = Math.max(0, maxChars - 1);
  return `${value.slice(0, sliceTo)}…`;
}

/**
 * Compose the operator-facing Telegram HTML message for a single quarantine
 * row. Caller-supplied strings are escaped via `escapeHtml`. Truncation caps
 * defined as module-level constants so the test suite + the Phase 2 v2
 * tightening pass share one source of truth.
 *
 * PINNED byte-equal in `healthQuarantineAlerter.test.ts`. A non-trivial
 * change here REQUIRES updating the pinned fixture string.
 */
export function formatQuarantineAlertHtml(row: QuarantineRow): string {
  const adrRef = row.adrRef && row.adrRef.length > 0 ? escapeHtml(row.adrRef) : '—';
  const cycleRef = row.cycleRef && row.cycleRef.length > 0 ? escapeHtml(row.cycleRef) : '—';
  const offending = escapeHtml(
    truncateForAlert(row.offendingValue, OFFENDING_VALUE_MAX_CHARS),
  );
  const explanation = escapeHtml(
    truncateForAlert(row.explanation, EXPLANATION_MAX_CHARS),
  );
  const operatorAction = escapeHtml(
    truncateForAlert(row.operatorAction, OPERATOR_ACTION_MAX_CHARS),
  );
  const sourceLabel = escapeHtml(row.sourceLabel);
  const sourceTable = escapeHtml(row.sourceTable);
  const category = escapeHtml(row.category);
  const severity = escapeHtml(row.severity);
  const status = escapeHtml(row.status);
  const id = escapeHtml(row.id);
  return (
    `🚨 <b>[SignalForge]</b> Tier-2 health quarantine\n` +
    `\n` +
    `<b>Source:</b> ${sourceLabel} (${sourceTable})\n` +
    `<b>Category:</b> ${category}\n` +
    `<b>Severity:</b> ${severity}\n` +
    `<b>Status:</b> ${status}\n` +
    `\n` +
    `<b>What:</b>\n` +
    `<i>${offending}</i>\n` +
    `\n` +
    `<b>Why:</b>\n` +
    `<i>${explanation}</i>\n` +
    `\n` +
    `<b>Operator action:</b>\n` +
    `${operatorAction}\n` +
    `\n` +
    `<b>Refs:</b> ${adrRef} · ${cycleRef}\n` +
    `<b>Quarantine ID:</b> <code>${id}</code>\n` +
    `<b>UI:</b> http://localhost:3000/#/health`
  );
}

// ── CH-bound helpers ────────────────────────────────────────────────────────

/**
 * True iff the alerts-sent sidecar table exists. Mirrors
 * `quarantineTableExists` in shape so the alerter degrades gracefully when
 * the migration has not been applied yet.
 */
export async function alertsSentTableExists(ch?: ClickHouseClient): Promise<boolean> {
  const client = ch ?? getClickHouse();
  try {
    const r = await client.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = {db:String} AND name = {tbl:String}`,
      query_params: { db: ALERTS_SENT_DATABASE, tbl: ALERTS_SENT_TABLE },
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ n: string | number }>();
    return rows.length > 0 && Number(rows[0].n) > 0;
  } catch {
    return false;
  }
}

/**
 * Return the set of quarantine ids that have already been dispatched. Empty
 * Set on any CH error (degrades to "everything unalerted" which the cap-hit
 * logic + per-row send failures still bound, so this is safe).
 */
async function loadAlertedIdSet(ch: ClickHouseClient): Promise<Set<string>> {
  try {
    const r = await ch.query({
      query: `SELECT toString(id) AS id FROM ${ALERTS_SENT_DATABASE}.${ALERTS_SENT_TABLE} FINAL`,
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ id: string }>();
    return new Set(rows.map(row => row.id));
  } catch {
    return new Set();
  }
}

/**
 * Load Tier-2 rows that have not been alerted yet, sorted recency-desc.
 * Filters to `tier2-quarantine` kind + the requested status set + ids absent
 * from the sidecar. Returns [] on any CH error.
 */
export async function loadUnalertedTier2Rows(opts: {
  ch?: ClickHouseClient;
  includeStatuses?: ReadonlyArray<QuarantineStatus>;
} = {}): Promise<QuarantineRow[]> {
  const ch = opts.ch ?? getClickHouse();
  const includeStatuses = opts.includeStatuses ?? DEFAULT_INCLUDE_STATUSES;
  const allRows = await loadAllQuarantineRows({ ch });
  const alertedIds = await loadAlertedIdSet(ch);
  const allowedStatuses = new Set<QuarantineStatus>(includeStatuses);
  return allRows
    .filter(row => row.kind === 'tier2-quarantine')
    .filter(row => allowedStatuses.has(row.status))
    .filter(row => !alertedIds.has(row.id))
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
}

/**
 * Insert one row into the alerts-sent sidecar. Idempotent under
 * ReplacingMergeTree(sent_at) ORDER BY (id) — re-recording the same id
 * collapses on FINAL reads.
 */
export async function recordAlertSent(args: {
  id: string;
  chatId: string;
  message: string;
  ch?: ClickHouseClient;
}): Promise<void> {
  const ch = args.ch ?? getClickHouse();
  await ch.insert({
    table: `${ALERTS_SENT_DATABASE}.${ALERTS_SENT_TABLE}`,
    values: [{
      id: args.id,
      // sent_at uses the column DEFAULT now() so we don't have to round-trip
      // a CH-format timestamp here; the ReplacingMergeTree version is set
      // server-side at insert time.
      chat_id: args.chatId,
      message: args.message,
    }],
    format: 'JSONEachRow',
  });
}

// ── High-level runner ──────────────────────────────────────────────────────

/**
 * Dispatch one Telegram message per new Tier-2 quarantine row, record each
 * send in the sidecar, and return a structured run result. NEVER throws.
 *
 * The loader + recorder are injectable so the test suite can stub them
 * without a CH dependency. Production callers pass nothing → real CH +
 * real Telegram are used.
 *
 * Telegram channel-id is read from the same env vars `SignalForgeTelegram`
 * consumes (TELEGRAM_ALERT_CHAT_ID). The alerter records `chatId='unknown'`
 * if it can't read the env (defensive; never blocks dispatch).
 */
export async function sendQuarantineAlerts(opts: {
  telegram: TelegramLike;
  ch?: ClickHouseClient;
  loader?: QuarantineLoader;
  recorder?: AlertRecorder;
  maxAlertsPerRun?: number;
  includeStatuses?: ReadonlyArray<QuarantineStatus>;
  /** Injected for tests; defaults to `process.env.TELEGRAM_ALERT_CHAT_ID`. */
  chatId?: string;
} = { telegram: new SignalForgeTelegram() }): Promise<AlertRunResult> {
  const maxAlertsPerRun = opts.maxAlertsPerRun ?? DEFAULT_MAX_ALERTS_PER_RUN;
  const loader = opts.loader ?? loadUnalertedTier2Rows;
  const recorder = opts.recorder ?? recordAlertSent;
  const includeStatuses = opts.includeStatuses ?? DEFAULT_INCLUDE_STATUSES;
  const chatId = opts.chatId ?? process.env.TELEGRAM_ALERT_CHAT_ID ?? 'unknown';
  const anomalies: AlerterAnomaly[] = [];
  const result: AlertRunResult = {
    sentCount: 0, skippedCount: 0, errorCount: 0, anomalies,
  };

  // ── Pre-flight: short-circuit when the dispatch surface is unreachable ──

  if (!opts.telegram.isConfigured()) {
    // Count unalerted rows so the operator-facing "skipped" reflects what
    // WOULD have fired had the channel been configured. Best-effort; failure
    // here still returns zeros, not an error.
    let unalertedCount = 0;
    try {
      const rows = await loader({ ch: opts.ch, includeStatuses });
      unalertedCount = rows.length;
    } catch {
      // The loader-throw envelope below handles the explicit
      // "alerter probe failed" message; we still want to return zeros
      // cleanly here without a second anomaly.
    }
    anomalies.push({
      severity: 'info',
      message:
        'Telegram alerter skipped: TELEGRAM_BOT_TOKEN or ' +
        'TELEGRAM_ALERT_CHAT_ID unset.',
    });
    result.skippedCount = unalertedCount;
    return result;
  }

  // ── Existence probes for the two tables we depend on ──────────────────

  let quarantinePresent = true;
  let sidecarPresent = true;
  try {
    [quarantinePresent, sidecarPresent] = await Promise.all([
      quarantineTableExists(opts.ch),
      alertsSentTableExists(opts.ch),
    ]);
  } catch {
    // Treat as both-absent; the more specific message below will fire.
    quarantinePresent = false;
    sidecarPresent = false;
  }
  if (!quarantinePresent) {
    anomalies.push({
      severity: 'info',
      message:
        'Quarantine table absent — run ' +
        'npm run migrate:create-health-quarantine:apply.',
    });
    return result;
  }
  if (!sidecarPresent) {
    anomalies.push({
      severity: 'info',
      message:
        'Alerts-sent sidecar absent — run ' +
        'npm run migrate:create-health-quarantine-alerts-sent:apply.',
    });
    return result;
  }

  // ── Load + filter ─────────────────────────────────────────────────────

  let unalerted: QuarantineRow[];
  try {
    unalerted = await loader({ ch: opts.ch, includeStatuses });
  } catch (err) {
    anomalies.push({
      severity: 'warning',
      message:
        `Quarantine alerter probe failed: ${(err as Error).message ?? String(err)}`,
    });
    result.errorCount = 1;
    return result;
  }

  if (unalerted.length === 0) {
    anomalies.push({
      severity: 'info',
      message: 'Quarantine alerter: 0 new Tier-2 rows; nothing to send.',
    });
    return result;
  }

  // ── Cap-hit accounting ────────────────────────────────────────────────

  let toSend = unalerted;
  if (unalerted.length > maxAlertsPerRun) {
    toSend = unalerted.slice(0, maxAlertsPerRun);
    const remaining = unalerted.length - maxAlertsPerRun;
    anomalies.push({
      severity: 'warning',
      message:
        `Quarantine alerter: capped at ${maxAlertsPerRun} alerts; ${remaining} ` +
        `rows remain unalerted (will fire next cycle).`,
    });
    result.skippedCount = remaining;
  }

  // ── Per-row dispatch ──────────────────────────────────────────────────

  for (const row of toSend) {
    const html = formatQuarantineAlertHtml(row);
    let sentOk = false;
    try {
      sentOk = await opts.telegram.send(html);
    } catch (err) {
      // SignalForgeTelegram is documented never-throw, but a future refactor
      // OR a stubbed telegram in tests could throw. Wrap defensively.
      anomalies.push({
        severity: 'warning',
        message:
          `Quarantine alert failed for row ${row.id} (${row.sourceLabel}): ` +
          `${(err as Error).message ?? String(err)}`,
      });
      result.errorCount++;
      continue;
    }
    if (!sentOk) {
      anomalies.push({
        severity: 'warning',
        message:
          `Quarantine alert failed for row ${row.id} (${row.sourceLabel}): ` +
          `Telegram send returned false (parse_mode error or transient).`,
      });
      result.errorCount++;
      continue;
    }
    // Record-sent. Best-effort: if the recorder throws (CH transient), we
    // STILL count the alert as sent (the message went out) but surface a
    // warning anomaly. The row will re-alert next cycle, which is the
    // operator-safer direction than silently swallowing the duplicate-send.
    try {
      await recorder({ id: row.id, chatId, message: html, ch: opts.ch });
    } catch (err) {
      anomalies.push({
        severity: 'warning',
        message:
          `Quarantine alert sent but record-sent failed for row ${row.id}: ` +
          `${(err as Error).message ?? String(err)} ` +
          `(row will re-alert next cycle).`,
      });
    }
    result.sentCount++;
  }

  // Success-state info anomaly — surfaces in the daemon log even when zero
  // failures occurred, so the operator can see the heartbeat.
  anomalies.push({
    severity: 'info',
    message: `Quarantine alerter: sent ${result.sentCount} new Tier-2 alerts.`,
  });
  return result;
}
