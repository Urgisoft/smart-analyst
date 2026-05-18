/**
 * StageStateRepository — typed read/write over `quantlab.stage_state_history`.
 *
 * SPEC: docs/specs/stage-state-machine.md §§11, 12.
 * DDL:  scripts/migrate_stage_state_history.ts (`DDL_STAGE_STATE_HISTORY`).
 *
 * Single responsibility: persistence layer for the stage state machine's
 * evaluation history. No state-machine logic (that's `stage_state.ts`). One
 * row per daemon-run evaluation; reads back the trailing N rows the pure
 * evaluator needs for halt-detection, re-validation timer, and cumulative
 * stage-days computation.
 *
 * Mirrors `drawdown_state_repository.ts` patterns:
 *   - ReplacingMergeTree(evaluated_at): idempotent same-ms retries within a
 *     run dedupe on merge.
 *   - ORDER BY (source, evaluated_at): per-source loads use the primary key.
 *   - ASC-loading via inner-DESC subquery + outer-ASC reverse: consumer
 *     walks end-to-start for recency-first detection (halt, rollback streak).
 *   - Graceful-degrade `tableExists` probe so the daemon survives pre-migration.
 *
 * Why DEFAULT_PRIOR_HISTORY_LIMIT = 730:
 *   - Covers the deepest single-stage horizon (stage 3 minDuration = 180d).
 *   - Covers stage-4 entry's "1 year cumulative across stages 1-3" check
 *     (≥365 days of stage-1/2/3 rows must be reconstructible).
 *   - Survives a worst-case path with two rollback re-validation periods
 *     (paper 30 + stage1 60 + rollback re-val 60 + stage1 60 + stage2 90 +
 *     stage3 180 + …) ≈ 480 days; 730 leaves margin.
 *   - SPEC §17 #51 byte-pins ≥730.
 */
import { getClickHouse } from './clickhouse.js';
import type { ClickHouseClient } from '@clickhouse/client';
import type {
  StageStateRow,
  StageDecision,
  StageReason,
  KillCriterionCode,
} from './stage_state.js';
import type { DeploymentStage } from './capital_deployment_config.js';
import type { DrawdownLevel } from './drawdown_state.js';

export const STAGE_DEFAULT_PRIOR_HISTORY_LIMIT = 730;

export interface StageStateWriteInput {
  evaluatedAt: Date;
  source: 'paper' | 'live';
  decision: StageDecision;
  stageBefore: DeploymentStage;
  stageAfter: DeploymentStage;
  /** Free-form within the StageReason union OR 'operator-cleared-halt' (CLI-only). */
  reason: StageReason | 'operator-cleared-halt';
  daysAtStage: number;
  sharpeWindow: number;
  maxDdWindow: number;
  drawdown30dPct: number;
  drawdownLevel: DrawdownLevel;
  consecutiveA1A5PassDays: number;
  killCriteriaFailCodes: ReadonlyArray<KillCriterionCode>;
  revalidationRemainingDays: number;
  configVersion: string;
}

function chDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * CH stores NaN/Infinity in Float64 fine (as `nan` / `inf`) but JSON
 * serialisation of NaN is non-portable. Coerce to `null` for the wire and
 * rely on CH's `toFloat64OrNull` behaviour, OR — simpler — coerce NaN→0,
 * +Infinity→1e308 (CH's near-max), -Infinity→-1e308. The audit trail's
 * "Sharpe was undefined / infinite" semantic is preserved by `decision +
 * reason` columns; the float value is supplementary. We pick the latter
 * (coerce + still distinguishable on read).
 */
function safeFloat(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x === Number.POSITIVE_INFINITY) return 1e308;
  if (x === Number.NEGATIVE_INFINITY) return -1e308;
  return x;
}

function serialiseWrite(input: StageStateWriteInput) {
  return {
    evaluated_at: chDateTime64(input.evaluatedAt),
    source: input.source,
    decision: input.decision,
    stage_before: input.stageBefore,
    stage_after: input.stageAfter,
    reason: input.reason,
    days_at_stage: input.daysAtStage,
    sharpe_window: safeFloat(input.sharpeWindow),
    max_dd_window: safeFloat(input.maxDdWindow),
    drawdown_30d_pct: safeFloat(input.drawdown30dPct),
    drawdown_level: input.drawdownLevel,
    consecutive_a1a5_pass_days: input.consecutiveA1A5PassDays,
    // Sort before join to keep LowCardinality bucket count bounded — without
    // sorting, `['A3','A4']` and `['A4','A3']` would produce two distinct
    // bucket values (critic LOW L-6).
    kill_criteria_fail_codes: [...input.killCriteriaFailCodes].sort().join(','),
    revalidation_remaining_days: input.revalidationRemainingDays,
    config_version: input.configVersion,
  };
}

interface RawRow {
  evaluated_at_ms: number;
  source: string;
  decision: string;
  stage_before: string;
  stage_after: string;
  reason: string;
  days_at_stage: number;
  sharpe_window: number;
  max_dd_window: number;
  drawdown_30d_pct: number;
  drawdown_level: number;
  consecutive_a1a5_pass_days: number;
  kill_criteria_fail_codes: string;
  revalidation_remaining_days: number;
  config_version: string;
}

function parseRow(r: RawRow): StageStateRow {
  const codes = r.kill_criteria_fail_codes === ''
    ? []
    : (r.kill_criteria_fail_codes.split(',').filter(Boolean) as KillCriterionCode[]);
  return {
    evaluatedAt: new Date(Number(r.evaluated_at_ms)),
    source: r.source === 'live' ? 'live' : 'paper',
    decision: r.decision as StageDecision,
    stageBefore: r.stage_before as DeploymentStage,
    stageAfter: r.stage_after as DeploymentStage,
    reason: r.reason as StageReason | 'operator-cleared-halt',
    daysAtStage: Number(r.days_at_stage),
    sharpeWindow: Number(r.sharpe_window),
    maxDdWindow: Number(r.max_dd_window),
    drawdown30dPct: Number(r.drawdown_30d_pct),
    drawdownLevel: Number(r.drawdown_level) as DrawdownLevel,
    consecutiveA1A5PassDays: Number(r.consecutive_a1a5_pass_days),
    killCriteriaFailCodes: codes,
    revalidationRemainingDays: Number(r.revalidation_remaining_days),
    configVersion: r.config_version,
  };
}

export interface StageStateRepositoryOptions {
  ch?: ClickHouseClient;
  table?: string;
}

export class StageStateRepository {
  private readonly ch: ClickHouseClient;
  private readonly table: string;

  constructor(opts: StageStateRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.table = opts.table ?? 'quantlab.stage_state_history';
  }

  async writeEvaluation(input: StageStateWriteInput): Promise<void> {
    const row = serialiseWrite(input);
    await this.ch.insert({
      table: this.table,
      values: [row],
      format: 'JSONEachRow',
    });
  }

  /**
   * Load the trailing N evaluation rows for a given source, ordered ASC
   * (oldest first; last element is the most recent). Mirror of
   * DrawdownStateRepository.loadPriorHistory pattern: inner DESC subquery
   * pulls the most recent N, outer SELECT reverses to ASC for the consumer.
   *
   * Returns [] when the table is absent (pre-migration) OR has no rows for
   * the source.
   */
  async loadPriorHistory(opts: {
    source: 'paper' | 'live';
    limit?: number;
  }): Promise<StageStateRow[]> {
    const limit = opts.limit ?? STAGE_DEFAULT_PRIOR_HISTORY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `StageStateRepository.loadPriorHistory: limit must be a positive integer (got ${limit})`,
      );
    }
    const q = await this.ch.query({
      query: `
        SELECT
          toUnixTimestamp64Milli(evaluated_at) AS evaluated_at_ms,
          source,
          decision,
          stage_before,
          stage_after,
          reason,
          days_at_stage,
          sharpe_window,
          max_dd_window,
          drawdown_30d_pct,
          drawdown_level,
          consecutive_a1a5_pass_days,
          kill_criteria_fail_codes,
          revalidation_remaining_days,
          config_version
        FROM (
          SELECT *
          FROM ${this.table} FINAL
          WHERE source = {source:String}
          ORDER BY evaluated_at DESC
          LIMIT {lim:UInt32}
        )
        ORDER BY evaluated_at ASC
      `,
      query_params: { source: opts.source, lim: limit },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    return rows.map(parseRow);
  }

  /**
   * Fetch only the most recent row for a source. Morning brief consumer.
   */
  async loadLatest(opts: { source: 'paper' | 'live' }): Promise<StageStateRow | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toUnixTimestamp64Milli(evaluated_at) AS evaluated_at_ms,
          source,
          decision,
          stage_before,
          stage_after,
          reason,
          days_at_stage,
          sharpe_window,
          max_dd_window,
          drawdown_30d_pct,
          drawdown_level,
          consecutive_a1a5_pass_days,
          kill_criteria_fail_codes,
          revalidation_remaining_days,
          config_version
        FROM ${this.table} FINAL
        WHERE source = {source:String}
        ORDER BY evaluated_at DESC
        LIMIT 1
      `,
      query_params: { source: opts.source },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    return rows.length === 0 ? null : parseRow(rows[0]);
  }
}

/**
 * Graceful-degrade probe — used by the daemon at bootstrap to skip stage
 * evaluation (info-anomaly + defaults) when the table hasn't been migrated.
 */
export async function stageStateHistoryTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'stage_state_history'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/**
 * What could break this:
 *  - `priorHistory` ordering: must be ASC (oldest first). The inner-DESC /
 *    outer-ASC subquery is the contract. A future "simplification" that
 *    drops the outer reverse would silently feed the state machine the
 *    wrong end.
 *  - `STAGE_DEFAULT_PRIOR_HISTORY_LIMIT = 730` covers stage-3 minDuration
 *    + stage-4's 1-year cumulative entry condition + rollback-re-val
 *    margin. A future amendment that lengthens any of these must bump the
 *    default or the truncation will silently underestimate cumulative days.
 *  - NaN/Infinity coercion in `safeFloat`: persisted values become 0 or
 *    ±1e308. The decision + reason columns preserve the semantic. Brief
 *    consumers should prefer the columnar decision/reason for display,
 *    not the raw sharpe_window/max_dd_window for "is undefined?" checks.
 *  - `kill_criteria_fail_codes` stored as comma-joined LowCardinality string.
 *    With typically 0-2 distinct codes per row, cardinality stays low. If a
 *    future evaluator emits arbitrarily-ordered code lists, sort here before
 *    join to keep the LowCardinality bucket count bounded.
 *  - The repository does NOT delete rows. Operator override goes through
 *    `stage:clear-halt` CLI which writes a NEW row (decision='clear-halt').
 *    The audit trail is load-bearing for the two-consecutive-failures gate.
 *  - Caller MUST pass `source` matching what was written. Paper and live
 *    each run independent state machines; mixing histories would corrupt
 *    rollback-streak detection.
 *  - Retention forever (≤1 row/day/source ≈ 3650 rows per decade) — trivial.
 *    Revisit only if the daemon cadence changes to multi-per-day.
 */
