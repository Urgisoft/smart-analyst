/**
 * DrawdownStateRepository — typed read/write over `quantlab.drawdown_state_history`.
 *
 * SPEC: docs/specs/drawdown-response-framework.md §8 — schema + lifecycle.
 * DDL:  scripts/migrate_drawdown_state_history.ts (`DDL_DRAWDOWN_STATE_HISTORY`).
 *
 * Single responsibility: persistence layer for the framework's evaluation
 * history. No state-machine logic (that's `drawdown_state.ts`). The repository
 * stores one row per daemon-run evaluation and reads back the trailing N rows
 * the pure evaluator needs for hysteresis.
 *
 * ReplacingMergeTree(evaluated_at):
 *   - One row per (source, evaluated_at) wins on merge — idempotent retries
 *     within the same daemon run write the same row twice cheaply.
 *   - `FINAL` reads dedupe at read time, mirroring `live_trades` semantics.
 *
 * Why `priorHistory` is loaded ASC (oldest first):
 *   - `evaluateDrawdownState` walks the array from the END backwards to count
 *     consecutive recovery days. ASC ordering means the END of the array is
 *     the most recent evaluation; reverse-loading would silently feed the
 *     state machine the OLDEST drawdown values as "most recent."
 *
 * Hysteresis-window sizing:
 *   - The deepest exit requirement is L4 → L3 at 10 consecutive days
 *     (`DRAWDOWN_LEVEL_EXIT_THRESHOLDS[4].days`). We default `priorHistoryLimit`
 *     to 30 (more than the deepest hysteresis window + a comfortable buffer
 *     for the morning brief's "days at current level" display). The repository
 *     does NOT cap below this default — a future amendment that lengthens the
 *     L4 exit requirement must bump the default too.
 */
import { getClickHouse } from './clickhouse.js';
import type { ClickHouseClient } from '@clickhouse/client';
import type {
  DrawdownLevel,
  DrawdownStateRow,
} from './drawdown_state.js';
import type { DeploymentStage } from './capital_deployment_config.js';

/**
 * Default trailing-history depth pulled before evaluation. Enough to cover
 * the L4 → L3 10-day exit requirement plus margin for brief rendering.
 * SPEC §8.3 + §14 #4.
 */
export const DEFAULT_PRIOR_HISTORY_LIMIT = 30;

/**
 * Input for a write — what `evaluateDrawdownState` produced plus the routing
 * metadata the framework's pure functions don't carry (source/stage already
 * live on the inputs, but for explicit serialisation we restate here).
 */
export interface DrawdownStateWriteInput {
  evaluatedAt: Date;
  source: 'paper' | 'live';
  stage: DeploymentStage;
  drawdown30dPct: number;
  deployedCapital: number;
  level: DrawdownLevel;
  levelEnteredAt: Date;
  regimeRedDays30: number;
  configVersion: string;
}

/**
 * Format Date as `YYYY-MM-DD HH:MM:SS.mmm` UTC — CH `DateTime64(3)` literal.
 * Mirrors `chDateTime64` in live_trade_repository.ts.
 */
function chDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function serialiseWrite(input: DrawdownStateWriteInput) {
  return {
    evaluated_at: chDateTime64(input.evaluatedAt),
    source: input.source,
    stage: input.stage,
    drawdown_30d_pct: input.drawdown30dPct,
    deployed_capital: input.deployedCapital,
    level: input.level,
    level_entered_at: chDateTime64(input.levelEnteredAt),
    regime_red_days_30: input.regimeRedDays30,
    config_version: input.configVersion,
  };
}

interface RawRow {
  evaluated_at_ms: number;
  source: string;
  stage: string;
  drawdown_30d_pct: number;
  deployed_capital: number;
  level: number;
  level_entered_at_ms: number;
  regime_red_days_30: number;
  config_version: string;
}

function parseRow(r: RawRow): DrawdownStateRow {
  return {
    evaluatedAt: new Date(Number(r.evaluated_at_ms)),
    source: r.source === 'live' ? 'live' : 'paper',
    stage: r.stage as DeploymentStage,
    drawdown30dPct: Number(r.drawdown_30d_pct),
    deployedCapital: Number(r.deployed_capital),
    level: Number(r.level) as DrawdownLevel,
    levelEnteredAt: new Date(Number(r.level_entered_at_ms)),
    regimeRedDays30: Number(r.regime_red_days_30),
    configVersion: r.config_version,
  };
}

export interface DrawdownStateRepositoryOptions {
  /** Override the CH client. Used by tests with an in-memory fake. */
  ch?: ClickHouseClient;
  /** Override the table name. Used by tests with a per-test table. */
  table?: string;
}

export class DrawdownStateRepository {
  private readonly ch: ClickHouseClient;
  private readonly table: string;

  constructor(opts: DrawdownStateRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.table = opts.table ?? 'quantlab.drawdown_state_history';
  }

  /**
   * Insert one evaluation row. ReplacingMergeTree(evaluated_at) makes
   * same-ms retries idempotent — two writes with identical `evaluatedAt`
   * for the same source dedupe on merge.
   */
  async writeEvaluation(input: DrawdownStateWriteInput): Promise<void> {
    const row = serialiseWrite(input);
    await this.ch.insert({
      table: this.table,
      values: [row],
      format: 'JSONEachRow',
    });
  }

  /**
   * Load the trailing N evaluation rows for a given source, ordered ASC
   * (oldest first; last element is the most recent). N defaults to
   * `DEFAULT_PRIOR_HISTORY_LIMIT` — sized to cover the deepest hysteresis
   * window + brief-display margin.
   *
   * Returns [] when the table is absent (pre-migration) OR has no rows for
   * the source. The pure evaluator treats either case as "first evaluation;
   * prevLevel defaults to 0."
   */
  async loadPriorHistory(opts: {
    source: 'paper' | 'live';
    limit?: number;
  }): Promise<DrawdownStateRow[]> {
    const limit = opts.limit ?? DEFAULT_PRIOR_HISTORY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `DrawdownStateRepository.loadPriorHistory: limit must be a positive integer (got ${limit})`,
      );
    }
    // The inner subquery pulls the most recent `limit` rows DESC; the outer
    // SELECT reverses to ASC so the consumer can walk end→start for
    // recency-first hysteresis counting.
    const q = await this.ch.query({
      query: `
        SELECT
          toUnixTimestamp64Milli(evaluated_at)     AS evaluated_at_ms,
          source,
          stage,
          drawdown_30d_pct,
          deployed_capital,
          level,
          toUnixTimestamp64Milli(level_entered_at) AS level_entered_at_ms,
          regime_red_days_30,
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
   * Fetch only the most recent row for a source — used by the morning brief
   * (no need to load the whole hysteresis window).
   */
  async loadLatest(opts: { source: 'paper' | 'live' }): Promise<DrawdownStateRow | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toUnixTimestamp64Milli(evaluated_at)     AS evaluated_at_ms,
          source,
          stage,
          drawdown_30d_pct,
          deployed_capital,
          level,
          toUnixTimestamp64Milli(level_entered_at) AS level_entered_at_ms,
          regime_red_days_30,
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
 * Check whether `quantlab.drawdown_state_history` is present. Used by the
 * daemon at bootstrap to gracefully degrade (warn + skip drawdown evaluation)
 * rather than crashing the paper-trading pipeline when the migration hasn't
 * run yet.
 */
export async function drawdownStateHistoryTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'drawdown_state_history'`,
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
 *  - `priorHistory` ordering must match what `evaluateDrawdownState` expects
 *    (ASC, oldest first). The inner-DESC / outer-ASC query is the contract;
 *    a future refactor that simplifies to a single ORDER BY DESC without
 *    reversing on read would silently feed the state machine the wrong end.
 *  - `DEFAULT_PRIOR_HISTORY_LIMIT = 30` covers L4 → L3's 10-day requirement
 *    + ~3× margin. If an amendment lengthens the deepest exit requirement
 *    past ~25 days, bump this default in lockstep or the recovery hysteresis
 *    will silently never fire.
 *  - The repository does NOT enforce monotonic `evaluatedAt`. A daemon that
 *    writes at a clock skew earlier than the prior row will see that row
 *    win on ReplacingMergeTree merge but compute its own state against the
 *    older history — operator should ensure system clock + CH server clock
 *    are NTP-aligned.
 *  - `FINAL` reads on a growing table are fine at daemon scale (~1 row/day
 *    per source). SPEC §14 #3 recommends retention forever (10 years = 3650
 *    rows). Revisit if the table grows past ~100k rows.
 *  - Caller MUST pass `source` matching what was written. Mixing 'paper' and
 *    'live' history rows at evaluation time would feed cross-source drawdowns
 *    into the hysteresis count. The framework's `DrawdownStateInputs.source`
 *    pins the SINGLE source per evaluation — this repository mirrors that
 *    contract by requiring `source` on every read.
 *  - The repository does NOT delete rows. A future operator-override slice
 *    (SPEC §14 #2 manual level clear) would write a CLEARED row, not delete
 *    history — the audit trail is load-bearing.
 */
