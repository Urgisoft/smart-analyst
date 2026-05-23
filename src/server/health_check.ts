/**
 * System health check orchestrator — ADR-044 Phase 1 (read-only surface).
 *
 * SPEC: docs/specs/adr-044-standing-system-health-ownership.md.
 * Audit context: docs/audits/system-reconciliation-2026-05.md (gap list).
 *
 * Powers `GET /api/health/state` and `npm run health:check` (CLI). Surveys
 * ClickHouse for table freshness against each source's expected cadence,
 * checks which operator-pending migrations are still pending, and assembles
 * a structured report.
 *
 * Phase-1 scope (this slice):
 *   - Freshness probe per known source (last-update timestamp + row count
 *     + cadence-relative status).
 *   - Migration applied/pending probe (target-table existence per migration
 *     script).
 *   - Read-only — no writes, no quarantine table, no Telegram alerts. The
 *     quarantine + auto-fix infrastructure is Phase 2 once the operator has
 *     validated the read-only foundation in browser.
 *
 * Design split:
 *   - Pure helpers (`classifyStatus`, `summarize`) — testable without CH.
 *   - One impure entry point (`runHealthCheck`) — wires CH I/O around the
 *     pure helpers. Each per-source probe is independent + parallelized via
 *     Promise.all so a single slow source doesn't gate the rest.
 *   - All source configuration is data in `HEALTH_SOURCES` / `HEALTH_MIGRATIONS`
 *     so the operator can review + extend without touching control flow.
 *
 * Why a per-source `timestampCol` rather than a uniform schema:
 *   The 30+ source tables in `quantlab.*` were built across 89+ sessions with
 *   different conventions — some have `asof_date` (the snapshot tables), some
 *   have `filing_date` (SEC EDGAR sources), some have `date` (candles + ETF
 *   shares), some have `settlement_date` (FINRA short-interest), some have
 *   nothing usable (lookup tables like `cik_ticker_map` where every row is a
 *   one-time backfill). Retrofitting a uniform `updated_at` column across all
 *   30+ tables would be a big migration with no operator-facing value —
 *   the config-driven approach captures the existing reality.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';

// ── Source configuration ────────────────────────────────────────────────────

export type HealthCadence =
  | 'daily'
  | 'bi-weekly'
  | 'event-driven'
  | 'monthly'
  | 'quarterly'
  | 'one-shot'
  | 'continuous';

export interface HealthSourceConfig {
  /** Table name (no `quantlab.` prefix). */
  name: string;
  /** Human-readable label for the UI panel. */
  label: string;
  /** Expected refresh cadence — drives stale-threshold computation. */
  cadence: HealthCadence;
  /**
   * True if a daemon step or another scheduled trigger refreshes this
   * source autonomously. False = operator must remember to run the ingest.
   * The single biggest standing-health gap (per reconciliation §3.1) is
   * the cluster of `autonomous: false` sources: their downstream daemon
   * evaluators run daily on whatever rows exist.
   */
  autonomous: boolean;
  /**
   * Timestamp column to read for freshness. Empty string = no usable
   * column (rare; treat as `unknown-cadence` regardless of row count).
   * Most SEC EDGAR sources use `filing_date`; snapshot tables use
   * `asof_date`; candles use `date`.
   */
  timestampCol: string;
  /**
   * Cast strategy for the timestamp column. CH date columns return as
   * strings (`YYYY-MM-DD`); DateTime columns return as ISO. The probe
   * normalizes both to a Date via `toUnixTimestamp` server-side.
   */
  timestampType: 'date' | 'datetime';
  /** Operator-actionable command if the source is stale or missing. */
  operatorAction: string;
  /** Short rationale for the cadence + autonomy choice. */
  why: string;
}

/**
 * The canonical list of sources surveyed by the health check.
 *
 * Coverage rationale: every CH table referenced by a UI panel, by the
 * daemon's per-cell loop, OR by the morning brief. Plus every alternative-
 * data ingest from the reconciliation §2.2 producer/consumer map.
 *
 * Tables NOT in this list (intentional exclusions):
 *   - `bt_runs`, `bt_trades`, `bt_runs_slices`, `bt_runs_regime` — backtest
 *     research surface; the freshness here is "did the operator run a
 *     sweep recently" which is a research-workflow question, not a system-
 *     health question.
 *   - `strategies`, `strategy_scores`, `strategy_scores_by_cluster` — seeded
 *     + operator-cadence; freshness is operator-driven.
 *   - `meta_train_trades`, `meta_models` — ADR-017 deferred; dormant.
 *   - `cik_ticker_map`, `cusip_ticker_map`, `gics_sector_map`,
 *     `sp500_history`, `sp500_constituents`, `token_metadata` — lookup
 *     tables; freshness measured by their producer ingests instead.
 *   - `token_features_weekly`, `token_cluster_membership`,
 *     `cluster_diagnostics_weekly` — weekly cadence; operator-cadence;
 *     dormant in current rotation.
 */
export const HEALTH_SOURCES: ReadonlyArray<HealthSourceConfig> = [
  // ── Daemon-automated (autonomous=true) ────────────────────────────────────
  {
    name: 'candles',
    label: 'Candles (yfinance)',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1 (fetch_daily_yfinance.py). Equity_midcap + SPY.',
  },
  {
    name: 'macro_regimes',
    label: 'Macro regime (phase1_v3)',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1c — phase1_v3 classifier writes one row per cycle.',
  },
  {
    name: 'macro_indicators_fred',
    label: 'FRED macro indicators',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1b\' — yield curve + credit + employment series.',
  },
  {
    name: 'cycle_position_snapshots',
    label: 'Cycle position composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1d — market-cycle-position composite snapshot.',
  },
  {
    name: 'vol_structure_snapshots',
    label: 'Vol structure composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1e — VIX term structure + skew snapshot.',
  },
  {
    name: 'sector_rotation_snapshots',
    label: 'Sector rotation composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1f — SPDR sector ETF momentum/rotation snapshot.',
  },
  {
    name: 'cross_asset_snapshots',
    label: 'Cross-asset composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1g — cross-asset correlation snapshot.',
  },
  {
    name: 'short_interest_snapshots',
    label: 'Short interest composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1h — FINRA short-interest composite snapshot.',
  },
  {
    name: 'executive_departure_snapshots',
    label: 'Executive departure composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1i — 8-K Item 5.02 composite snapshot.',
  },
  {
    name: 'etf_shares_outstanding_secondary',
    label: 'ETF v3.1 SSGA secondary',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1ja (s96 #9) — SSGA navhist auto-refresh.',
  },
  {
    name: 'etf_flow_snapshots',
    label: 'ETF flow composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1j — etf-flow composite snapshot.',
  },
  {
    name: 'eight_k_classifier_snapshots',
    label: '8-K classifier composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1k — 8-K event classifier composite snapshot.',
  },
  {
    name: 'form_4_insider_snapshots',
    label: 'Form 4 insider composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1l — Form 4 insider composite snapshot.',
  },
  {
    name: 'schedule_13d_g_snapshots',
    label: 'Schedule 13D/G composite',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'asof_date',
    timestampType: 'date',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon step 1m — Schedule 13D/G activist composite snapshot.',
  },
  {
    name: 'live_signals',
    label: 'Live paper-trading signals',
    cadence: 'daily',
    autonomous: true,
    timestampCol: 'run_at',
    timestampType: 'datetime',
    operatorAction: 'npm run daemon:daily',
    why: 'Daemon per-cell loop — daily snapshot of intended positions.',
  },
  // ── Operator-cadence (autonomous=false) — the standing-health gap ─────────
  {
    name: 'eight_k_events',
    label: '8-K events (SEC EDGAR)',
    cadence: 'event-driven',
    autonomous: false,
    timestampCol: 'filing_date',
    timestampType: 'date',
    operatorAction: 'npm run edgar:8k-event:ingest',
    why: 'GAP-1 — operator-cadence; daemon step 1k evaluates stale data silently.',
  },
  {
    name: 'executive_departures',
    label: '8-K Item 5.02 (exec departures)',
    cadence: 'event-driven',
    autonomous: false,
    timestampCol: 'filing_date',
    timestampType: 'date',
    operatorAction: 'npm run edgar:exec-departure:ingest',
    why: 'GAP-1 — operator-cadence; daemon step 1i evaluates stale data silently.',
  },
  {
    name: 'insider_trades',
    label: 'Form 4 insider trades',
    cadence: 'event-driven',
    autonomous: false,
    timestampCol: 'filing_date',
    timestampType: 'date',
    operatorAction: 'npm run edgar:form4:ingest',
    why: 'GAP-1 — operator-cadence; daemon step 1l evaluates stale data silently.',
  },
  {
    name: 'schedule_13d_g_filings',
    label: 'Schedule 13D/G filings',
    cadence: 'event-driven',
    autonomous: false,
    timestampCol: 'filing_date',
    timestampType: 'date',
    operatorAction: 'npm run edgar:13d-g:ingest',
    why: 'GAP-1 — operator-cadence; daemon step 1m evaluates stale data silently.',
  },
  {
    name: 'macro_indicators_cboe',
    label: 'CBOE put/call ratio',
    cadence: 'daily',
    autonomous: false,
    timestampCol: 'date',
    timestampType: 'date',
    operatorAction: 'npm run cboe:ingest',
    why: 'GAP-3 — operator-cadence; phase1_v3 classifier reads stale data.',
  },
  {
    name: 'etf_shares_outstanding',
    label: 'ETF v1 yfinance primary',
    cadence: 'daily',
    autonomous: false,
    timestampCol: 'date',
    timestampType: 'date',
    operatorAction: 'npm run etf:flow:ingest',
    why: 'GAP-4 — operator-cadence (s92 design); secondary now daemon-auto, primary lags.',
  },
];

/** Migration metadata used to detect "applied" vs "pending" state. */
export interface HealthMigrationConfig {
  /** The npm script that applies the migration. */
  applyCommand: string;
  /** Table that should exist post-apply (the existence probe). */
  targetTable: string;
  /** Short label for the UI. */
  label: string;
}

/**
 * Operator-pending migrations from the HANDOFF carry-over. The reconciliation
 * report's GAP-15 enumerates these as the set most likely to cause silent
 * "panel returns error card" UX when an operator clones the system.
 *
 * Each entry's `targetTable` is the table the migration creates (or ALTERs).
 * For pure-ALTER migrations, the table must EXIST before the ALTER runs —
 * so the health-check's "applied" flag here means "the post-ALTER column
 * exists" which we approximate by table existence + a column probe in v2.
 * Phase 1 uses table-existence as the heuristic.
 */
export const HEALTH_MIGRATIONS: ReadonlyArray<HealthMigrationConfig> = [
  {
    applyCommand: 'npm run migrate:create-etf-flow-snapshots:apply',
    targetTable: 'etf_flow_snapshots',
    label: 'ETF v1 primary + snapshots (s92)',
  },
  {
    applyCommand: 'npm run migrate:create-etf-shares-outstanding-secondary:apply',
    targetTable: 'etf_shares_outstanding_secondary',
    label: 'ETF v3.1 SSGA secondary panel (s95 #9)',
  },
  {
    applyCommand: 'npm run migrate:create-form-4-insider-snapshots:apply',
    targetTable: 'form_4_insider_snapshots',
    label: 'Form 4 insider snapshots (s93)',
  },
  {
    applyCommand: 'npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply',
    targetTable: 'form_4_insider_snapshots',
    label: 'Form 4 sell_cluster ALTER (s95 #1)',
  },
  {
    applyCommand: 'npm run migrate:add-max-z-form-4-insider-snapshots:apply',
    targetTable: 'form_4_insider_snapshots',
    label: 'Form 4 max_aggregate_z ALTER (s93)',
  },
  {
    applyCommand: 'npm run migrate:add-max-z-eight-k-classifier-snapshots:apply',
    targetTable: 'eight_k_classifier_snapshots',
    label: '8-K classifier max_aggregate_z ALTER (s93)',
  },
  {
    applyCommand: 'npm run migrate:add-max-z-executive-departure-snapshots:apply',
    targetTable: 'executive_departure_snapshots',
    label: 'Exec departure max_aggregate_z ALTER (s91)',
  },
  {
    applyCommand: 'npm run migrate:create-eight-k-classifier-snapshots:apply',
    targetTable: 'eight_k_classifier_snapshots',
    label: '8-K classifier snapshots (s93)',
  },
  {
    applyCommand: 'npm run migrate:create-eight-k-events:apply',
    targetTable: 'eight_k_events',
    label: '8-K events source table (s93)',
  },
  {
    applyCommand: 'npm run migrate:create-schedule-13d-g-filings:apply',
    targetTable: 'schedule_13d_g_filings',
    label: 'Schedule 13D/G filings source table (s96 #1)',
  },
  {
    applyCommand: 'npm run migrate:create-schedule-13d-g-snapshots:apply',
    targetTable: 'schedule_13d_g_snapshots',
    label: 'Schedule 13D/G composite snapshots (s96 #1)',
  },
  {
    applyCommand: 'npm run migrate:create-executive-departure-snapshots:apply',
    targetTable: 'executive_departure_snapshots',
    label: 'Exec departure snapshots (s91)',
  },
  {
    applyCommand: 'npm run migrate:create-cycle-position-snapshots:apply',
    targetTable: 'cycle_position_snapshots',
    label: 'Cycle position snapshots (Phase A6)',
  },
  {
    applyCommand: 'npm run migrate:create-vol-structure-snapshots:apply',
    targetTable: 'vol_structure_snapshots',
    label: 'Vol structure snapshots',
  },
  {
    applyCommand: 'npm run migrate:create-sector-rotation-snapshots:apply',
    targetTable: 'sector_rotation_snapshots',
    label: 'Sector rotation snapshots',
  },
  {
    applyCommand: 'npm run migrate:create-cross-asset-snapshots:apply',
    targetTable: 'cross_asset_snapshots',
    label: 'Cross-asset snapshots',
  },
  {
    applyCommand: 'npm run migrate:create-short-interest-snapshots:apply',
    targetTable: 'short_interest_snapshots',
    label: 'Short interest snapshots',
  },
];

// ── Public response types ───────────────────────────────────────────────────

export type HealthStatus =
  | 'fresh'
  | 'stale'
  | 'very-stale'
  | 'missing-table'
  | 'never-populated'
  | 'unknown-cadence';

export interface HealthSourceProbe {
  name: string;
  label: string;
  cadence: HealthCadence;
  autonomous: boolean;
  /** ISO date of last row, or null when missing/empty/unknown. */
  lastUpdateAt: string | null;
  /** Hours since last update. -1 when not measurable. */
  lastUpdateAgeHours: number;
  /** Row count in the table (0 if missing-table or never-populated). */
  rowCount: number;
  status: HealthStatus;
  /** Operator-readable summary line. */
  message: string;
  /** Operator-actionable command, if any. */
  operatorAction: string;
  why: string;
}

export interface HealthMigrationProbe {
  applyCommand: string;
  targetTable: string;
  label: string;
  applied: boolean;
}

export interface HealthSummary {
  fresh: number;
  stale: number;
  veryStale: number;
  missing: number;
  neverPopulated: number;
  unknownCadence: number;
  pendingMigrations: number;
  appliedMigrations: number;
  /** True if EVERY source is fresh AND every migration is applied. */
  allGreen: boolean;
}

export interface HealthCheckResponse {
  /** ISO timestamp of the check. */
  generatedAt: string;
  sources: HealthSourceProbe[];
  migrations: HealthMigrationProbe[];
  summary: HealthSummary;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Cadence-relative staleness thresholds (in hours). Round numbers operator-
 * readable; not in-sample-tuned. The fresh/stale boundary is roughly
 * "expected refresh window + grace"; very-stale is "the schedule has
 * definitely been missed once."
 */
export const CADENCE_THRESHOLDS_HOURS: Record<HealthCadence, { fresh: number; stale: number }> = {
  // 30h covers a missed midnight cycle (next-morning re-run still fresh);
  // 72h means 3+ days without a write — definitely missed.
  daily: { fresh: 30, stale: 72 },
  // FINRA releases bi-weekly; 18 days = ~1 release missed; 30 days = 2+.
  'bi-weekly': { fresh: 18 * 24, stale: 30 * 24 },
  // Event-driven: filings arrive when they arrive. 7d without ANY filing
  // is suspicious for active universes; 14d is almost certainly an
  // ingest-stop, not a filing drought.
  'event-driven': { fresh: 7 * 24, stale: 14 * 24 },
  // CBOE quarterly = ~90d; monthly = ~30d; quarterly stale at 45d.
  monthly: { fresh: 35 * 24, stale: 60 * 24 },
  quarterly: { fresh: 95 * 24, stale: 120 * 24 },
  // Continuous (watcher): >6h = silent for too long.
  continuous: { fresh: 6, stale: 24 },
  // One-shot: never stale once populated.
  'one-shot': { fresh: Infinity, stale: Infinity },
};

export function classifyStatus(
  cadence: HealthCadence,
  rowCount: number,
  lastUpdateAgeHours: number,
  tableExists: boolean,
): HealthStatus {
  if (!tableExists) return 'missing-table';
  if (rowCount === 0) return 'never-populated';
  if (!Number.isFinite(lastUpdateAgeHours) || lastUpdateAgeHours < 0) {
    return 'unknown-cadence';
  }
  const { fresh, stale } = CADENCE_THRESHOLDS_HOURS[cadence];
  if (lastUpdateAgeHours <= fresh) return 'fresh';
  if (lastUpdateAgeHours <= stale) return 'stale';
  return 'very-stale';
}

export function summarize(
  sources: ReadonlyArray<HealthSourceProbe>,
  migrations: ReadonlyArray<HealthMigrationProbe>,
): HealthSummary {
  let fresh = 0, stale = 0, veryStale = 0, missing = 0, neverPopulated = 0, unknownCadence = 0;
  for (const s of sources) {
    if (s.status === 'fresh') fresh++;
    else if (s.status === 'stale') stale++;
    else if (s.status === 'very-stale') veryStale++;
    else if (s.status === 'missing-table') missing++;
    else if (s.status === 'never-populated') neverPopulated++;
    else if (s.status === 'unknown-cadence') unknownCadence++;
  }
  const appliedMigrations = migrations.filter(m => m.applied).length;
  const pendingMigrations = migrations.length - appliedMigrations;
  return {
    fresh,
    stale,
    veryStale,
    missing,
    neverPopulated,
    unknownCadence,
    pendingMigrations,
    appliedMigrations,
    allGreen:
      stale === 0 &&
      veryStale === 0 &&
      missing === 0 &&
      neverPopulated === 0 &&
      pendingMigrations === 0,
  };
}

function statusMessage(status: HealthStatus, ageHours: number, rowCount: number): string {
  switch (status) {
    case 'fresh':
      return `Fresh — ${formatAge(ageHours)} ago · ${rowCount.toLocaleString()} rows.`;
    case 'stale':
      return `Stale — ${formatAge(ageHours)} since last update · ${rowCount.toLocaleString()} rows.`;
    case 'very-stale':
      return `Very stale — ${formatAge(ageHours)} since last update · ${rowCount.toLocaleString()} rows. Cadence definitely missed.`;
    case 'missing-table':
      return 'Table does not exist in ClickHouse. Apply the migration.';
    case 'never-populated':
      return 'Table exists but has zero rows. Run the ingest.';
    case 'unknown-cadence':
      return `Cannot determine age — ${rowCount.toLocaleString()} rows; timestamp column unreadable.`;
  }
}

function formatAge(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'unknown time';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 14) return `${days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

// ── Impure probes ──────────────────────────────────────────────────────────

interface RawProbeRow {
  /** count() */ n: string | number;
  /** max(timestampCol) as Unix sec, or 0 when no rows */ ts: string | number;
}

async function probeTableExists(
  ch: ClickHouseClient,
  tableName: string,
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = {table:String}`,
      query_params: { table: tableName },
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ n: string | number }>();
    return rows.length > 0 && Number(rows[0].n) > 0;
  } catch {
    // CH unreachable — treat as missing so the operator sees a clear signal
    // rather than an opaque "unknown."
    return false;
  }
}

async function probeSource(
  ch: ClickHouseClient,
  source: HealthSourceConfig,
  now: Date,
): Promise<HealthSourceProbe> {
  const exists = await probeTableExists(ch, source.name);
  if (!exists) {
    const status: HealthStatus = 'missing-table';
    return {
      name: source.name,
      label: source.label,
      cadence: source.cadence,
      autonomous: source.autonomous,
      lastUpdateAt: null,
      lastUpdateAgeHours: -1,
      rowCount: 0,
      status,
      message: statusMessage(status, -1, 0),
      operatorAction: source.operatorAction,
      why: source.why,
    };
  }
  // Build the timestamp expression. Date columns cast via toUnixTimestamp
  // (treats them as 00:00:00 UTC); DateTime columns cast directly.
  const tsExpr =
    source.timestampType === 'date'
      ? `toUnixTimestamp(toDateTime(max(${source.timestampCol})))`
      : `toUnixTimestamp(max(${source.timestampCol}))`;
  let rowCount = 0;
  let lastTsSec = 0;
  try {
    const r = await ch.query({
      query: `SELECT count() AS n, ${tsExpr} AS ts FROM quantlab.${source.name} FINAL`,
      format: 'JSONEachRow',
    });
    const rows = await r.json<RawProbeRow>();
    if (rows.length > 0) {
      rowCount = Number(rows[0].n) || 0;
      lastTsSec = Number(rows[0].ts) || 0;
    }
  } catch {
    // Column probably doesn't exist (schema drift) — degrade to unknown.
    try {
      const r = await ch.query({
        query: `SELECT count() AS n FROM quantlab.${source.name} FINAL`,
        format: 'JSONEachRow',
      });
      const rows = await r.json<{ n: string | number }>();
      rowCount = rows.length > 0 ? Number(rows[0].n) : 0;
    } catch {
      // Both queries failed; treat as missing.
      const status: HealthStatus = 'missing-table';
      return {
        name: source.name,
        label: source.label,
        cadence: source.cadence,
        autonomous: source.autonomous,
        lastUpdateAt: null,
        lastUpdateAgeHours: -1,
        rowCount: 0,
        status,
        message: statusMessage(status, -1, 0),
        operatorAction: source.operatorAction,
        why: source.why,
      };
    }
    const status: HealthStatus = 'unknown-cadence';
    return {
      name: source.name,
      label: source.label,
      cadence: source.cadence,
      autonomous: source.autonomous,
      lastUpdateAt: null,
      lastUpdateAgeHours: -1,
      rowCount,
      status,
      message: statusMessage(status, -1, rowCount),
      operatorAction: source.operatorAction,
      why: source.why,
    };
  }
  if (rowCount === 0 || lastTsSec === 0) {
    const status: HealthStatus = 'never-populated';
    return {
      name: source.name,
      label: source.label,
      cadence: source.cadence,
      autonomous: source.autonomous,
      lastUpdateAt: null,
      lastUpdateAgeHours: -1,
      rowCount,
      status,
      message: statusMessage(status, -1, rowCount),
      operatorAction: source.operatorAction,
      why: source.why,
    };
  }
  const lastDate = new Date(lastTsSec * 1000);
  const ageHours = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60);
  const status = classifyStatus(source.cadence, rowCount, ageHours, true);
  return {
    name: source.name,
    label: source.label,
    cadence: source.cadence,
    autonomous: source.autonomous,
    lastUpdateAt: lastDate.toISOString(),
    lastUpdateAgeHours: ageHours,
    rowCount,
    status,
    message: statusMessage(status, ageHours, rowCount),
    operatorAction: source.operatorAction,
    why: source.why,
  };
}

async function probeMigration(
  ch: ClickHouseClient,
  migration: HealthMigrationConfig,
): Promise<HealthMigrationProbe> {
  const applied = await probeTableExists(ch, migration.targetTable);
  return {
    applyCommand: migration.applyCommand,
    targetTable: migration.targetTable,
    label: migration.label,
    applied,
  };
}

// ── Public entry point ─────────────────────────────────────────────────────

export interface RunHealthCheckOptions {
  /** Override the CH client — used by tests to inject a fake. */
  ch?: ClickHouseClient;
  /** Override the wall-clock — used by tests for deterministic ages. */
  now?: () => Date;
  /** Override the source list — used by tests to scope to a subset. */
  sources?: ReadonlyArray<HealthSourceConfig>;
  /** Override the migration list — used by tests to scope to a subset. */
  migrations?: ReadonlyArray<HealthMigrationConfig>;
}

/**
 * Run the full health check. All probes execute in parallel via Promise.all;
 * a slow source does not gate the rest. CH errors per-source degrade to
 * `missing-table` rather than throwing — the operator sees a clear signal
 * instead of an opaque HTTP failure.
 */
export async function runHealthCheck(
  opts: RunHealthCheckOptions = {},
): Promise<HealthCheckResponse> {
  const ch = opts.ch ?? getClickHouse();
  const now = opts.now?.() ?? new Date();
  const sources = opts.sources ?? HEALTH_SOURCES;
  const migrations = opts.migrations ?? HEALTH_MIGRATIONS;

  const [sourceProbes, migrationProbes] = await Promise.all([
    Promise.all(sources.map(s => probeSource(ch, s, now))),
    Promise.all(migrations.map(m => probeMigration(ch, m))),
  ]);

  return {
    generatedAt: now.toISOString(),
    sources: sourceProbes,
    migrations: migrationProbes,
    summary: summarize(sourceProbes, migrationProbes),
  };
}

/**
 * What could break this:
 *   - `HEALTH_SOURCES` is hardcoded. New tables added by future slices won't
 *     surface until the operator adds them here. Mitigated by listing every
 *     load-bearing table in the reconciliation audit; the standing-health
 *     mandate says new slices ship UI surface + freshness entry together.
 *   - `timestampCol` per-source assumes the column exists with the right
 *     type. Schema drift (a future ALTER renaming the column) silently
 *     degrades to `unknown-cadence` — visible as such on the panel, not
 *     a fatal error.
 *   - Cadence thresholds are operator-readable round numbers; not tuned
 *     against historical refresh-gap distributions. A future v2 could
 *     learn per-source thresholds from rolling-window observed gaps.
 *   - `runHealthCheck` issues ~50 CH queries (2 per source + 1 per
 *     migration). At ~20ms each that's ~1s wall-clock with parallelism
 *     across CH's connection pool. Acceptable for personal-tool scale +
 *     daemon-step cadence. A future v2 could batch tables into a single
 *     `system.parts` query for the per-table row count.
 *   - The `FINAL` keyword on the count + max query forces dedup for
 *     ReplacingMergeTree tables — necessary for `live_signals` and
 *     `live_trades` to report accurate counts but slow on large tables.
 *     The trade-off is correctness over speed at this layer.
 *   - `allGreen` is a strict boolean: ANY stale/missing/pending blocks
 *     it. Phase-2 quarantine integration will refine this to "no Tier-2
 *     items pending AND no Tier-1 items unresolved > N hours."
 */
