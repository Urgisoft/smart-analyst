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
 * Per-strategy SPEC sentinel (strategy-tagged-drawdown-state.md §3 + §14 #5).
 * Empty-string in `bundle_id` denotes the PORTFOLIO-AGGREGATE row — preserves
 * byte-equality with pre-migration rows whose `bundle_id` DEFAULT '' fires.
 * Exported so callers do not literal-string the sentinel.
 */
export const BUNDLE_ID_PORTFOLIO_SENTINEL = '';

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
 * Per-strategy write input — same as portfolio plus the `bundleId` tag.
 * SPEC strategy-tagged-drawdown-state.md §9.1. Empty `bundleId` is rejected
 * (use the portfolio `writeEvaluation` method for the aggregate scope).
 */
export interface DrawdownStateWriteInputPerStrategy extends DrawdownStateWriteInput {
  /** Strategy identifier (e.g. 'mean_reversion_v1'). Non-empty. */
  bundleId: string;
}

/**
 * Format Date as `YYYY-MM-DD HH:MM:SS.mmm` UTC — CH `DateTime64(3)` literal.
 * Mirrors `chDateTime64` in live_trade_repository.ts.
 */
function chDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function serialiseWrite(
  input: DrawdownStateWriteInput,
  opts: { includeBundleId: boolean; bundleId?: string },
): Record<string, unknown> {
  const row: Record<string, unknown> = {
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
  if (opts.includeBundleId) row.bundle_id = opts.bundleId ?? BUNDLE_ID_PORTFOLIO_SENTINEL;
  return row;
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
  bundle_id?: string;
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
  /**
   * Set to `true` post-Phase-C migration once the `bundle_id` column exists.
   * When `false` (default), portfolio reads/writes use the pre-migration shape
   * (no `bundle_id` field) and per-strategy methods graceful-degrade
   * (writeEvaluationPerStrategy throws; loadPriorHistoryPerStrategy +
   * loadLatestPerStrategy return []/null; loadLatestAllScopes returns just
   * the portfolio scope). SPEC strategy-tagged-drawdown-state.md §10 + §11 #27.
   *
   * Daemon bootstrap calls `drawdownStateHasBundleIdColumn(ch)` to probe
   * `system.columns` and threads the resolved flag through.
   */
  bundleIdColumnPresent?: boolean;
}

export class DrawdownStateRepository {
  private readonly ch: ClickHouseClient;
  private readonly table: string;
  private readonly bundleIdColumnPresent: boolean;

  constructor(opts: DrawdownStateRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.table = opts.table ?? 'quantlab.drawdown_state_history';
    this.bundleIdColumnPresent = opts.bundleIdColumnPresent ?? false;
  }

  /** True iff the repository was constructed against a post-Phase-C schema. */
  isPerStrategySupported(): boolean {
    return this.bundleIdColumnPresent;
  }

  /**
   * Insert one PORTFOLIO evaluation row. ReplacingMergeTree(evaluated_at, …)
   * makes same-ms retries idempotent. Post-Phase-C the row carries
   * `bundle_id = ''` (portfolio sentinel); pre-migration the field is
   * omitted to match the legacy column set.
   */
  async writeEvaluation(input: DrawdownStateWriteInput): Promise<void> {
    const row = serialiseWrite(input, {
      includeBundleId: this.bundleIdColumnPresent,
      bundleId: BUNDLE_ID_PORTFOLIO_SENTINEL,
    });
    await this.ch.insert({
      table: this.table,
      values: [row],
      format: 'JSONEachRow',
    });
  }

  /**
   * Insert one PER-STRATEGY evaluation row — SPEC strategy-tagged-drawdown-
   * state.md §7.3 + §9.1. Throws if the schema does not yet carry the
   * `bundle_id` column (Phase C migration not applied) so callers see a loud
   * failure rather than silently writing rows that would land in the
   * portfolio bucket.
   */
  async writeEvaluationPerStrategy(input: DrawdownStateWriteInputPerStrategy): Promise<void> {
    if (!this.bundleIdColumnPresent) {
      throw new Error(
        `writeEvaluationPerStrategy: bundle_id column absent on '${this.table}'. ` +
        `Run scripts/migrate_drawdown_state_history_per_strategy.ts --apply (operator-authorized) ` +
        `before invoking per-strategy writes. SPEC §8.1.`,
      );
    }
    if (!input.bundleId) {
      throw new Error(
        `writeEvaluationPerStrategy: empty bundleId. Use writeEvaluation() for the ` +
        `portfolio aggregate scope (which writes bundle_id=''). SPEC §3.`,
      );
    }
    const row = serialiseWrite(input, {
      includeBundleId: true,
      bundleId: input.bundleId,
    });
    await this.ch.insert({
      table: this.table,
      values: [row],
      format: 'JSONEachRow',
    });
  }

  /**
   * Load the trailing N PORTFOLIO rows for a given source, ordered ASC
   * (oldest first; last element is the most recent). N defaults to
   * `DEFAULT_PRIOR_HISTORY_LIMIT`.
   *
   * Post-Phase-C, filters `bundle_id = ''` so per-strategy rows do NOT
   * leak into portfolio hysteresis (SPEC §11 #24). Pre-migration, the
   * column is absent and all rows are portfolio by definition.
   *
   * Returns [] when the table is absent OR has no matching rows.
   */
  async loadPriorHistory(opts: {
    source: 'paper' | 'live';
    limit?: number;
  }): Promise<DrawdownStateRow[]> {
    return this.loadPriorHistoryForBundle({
      source: opts.source,
      bundleId: BUNDLE_ID_PORTFOLIO_SENTINEL,
      limit: opts.limit,
      isPortfolio: true,
    });
  }

  /**
   * Per-strategy prior history. Filters `bundle_id = {bid:String}` so only
   * rows for this strategy feed the per-strategy hysteresis (SPEC §11 #23).
   * Returns [] when the bundle_id column is absent (graceful-degrade per
   * SPEC §10 / §11 #27) OR no matching rows.
   */
  async loadPriorHistoryPerStrategy(opts: {
    source: 'paper' | 'live';
    bundleId: string;
    limit?: number;
  }): Promise<DrawdownStateRow[]> {
    if (!this.bundleIdColumnPresent) return [];
    if (!opts.bundleId) {
      throw new Error(
        `loadPriorHistoryPerStrategy: empty bundleId. Use loadPriorHistory() for ` +
        `the portfolio aggregate scope. SPEC §3.`,
      );
    }
    return this.loadPriorHistoryForBundle({
      source: opts.source,
      bundleId: opts.bundleId,
      limit: opts.limit,
      isPortfolio: false,
    });
  }

  private async loadPriorHistoryForBundle(opts: {
    source: 'paper' | 'live';
    bundleId: string;
    limit?: number;
    isPortfolio: boolean;
  }): Promise<DrawdownStateRow[]> {
    const limit = opts.limit ?? DEFAULT_PRIOR_HISTORY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        `DrawdownStateRepository.loadPriorHistory: limit must be a positive integer (got ${limit})`,
      );
    }
    // Pre-migration portfolio call: the column doesn't exist, so we cannot
    // (and need not) filter on it — every existing row is portfolio by
    // definition.
    const bundleFilter = this.bundleIdColumnPresent
      ? `AND bundle_id = {bid:String}`
      : ``;
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
          WHERE source = {source:String} ${bundleFilter}
          ORDER BY evaluated_at DESC
          LIMIT {lim:UInt32}
        )
        ORDER BY evaluated_at ASC
      `,
      query_params: {
        source: opts.source,
        lim: limit,
        ...(this.bundleIdColumnPresent ? { bid: opts.bundleId } : {}),
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    // Avoid "unused" lint on isPortfolio — the flag is reserved for future
    // diagnostic surface (e.g. a metric tagged portfolio-vs-strategy without
    // re-checking the bundleId).
    void opts.isPortfolio;
    return rows.map(parseRow);
  }

  /**
   * Fetch only the most recent PORTFOLIO row for a source.
   * Post-Phase-C filters `bundle_id = ''`; pre-migration omits the filter.
   */
  async loadLatest(opts: { source: 'paper' | 'live' }): Promise<DrawdownStateRow | null> {
    return this.loadLatestForBundle({
      source: opts.source,
      bundleId: BUNDLE_ID_PORTFOLIO_SENTINEL,
    });
  }

  /**
   * Most recent per-strategy row. Returns null when the bundle_id column is
   * absent (graceful-degrade) OR no row for the (source, bundleId) pair.
   */
  async loadLatestPerStrategy(opts: {
    source: 'paper' | 'live';
    bundleId: string;
  }): Promise<DrawdownStateRow | null> {
    if (!this.bundleIdColumnPresent) return null;
    if (!opts.bundleId) {
      throw new Error(
        `loadLatestPerStrategy: empty bundleId. Use loadLatest() for the portfolio ` +
        `aggregate scope. SPEC §3.`,
      );
    }
    return this.loadLatestForBundle({ source: opts.source, bundleId: opts.bundleId });
  }

  private async loadLatestForBundle(opts: {
    source: 'paper' | 'live';
    bundleId: string;
  }): Promise<DrawdownStateRow | null> {
    const bundleFilter = this.bundleIdColumnPresent
      ? `AND bundle_id = {bid:String}`
      : ``;
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
        WHERE source = {source:String} ${bundleFilter}
        ORDER BY evaluated_at DESC
        LIMIT 1
      `,
      query_params: {
        source: opts.source,
        ...(this.bundleIdColumnPresent ? { bid: opts.bundleId } : {}),
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    return rows.length === 0 ? null : parseRow(rows[0]);
  }

  /**
   * Composite read for the morning brief — most recent row per (source,
   * bundle_id). Pre-migration falls back to a portfolio-only result with an
   * empty `perStrategy` map (the brief composer renders the panel without a
   * per-strategy section, mirroring the table-absent path).
   *
   * Implementation: single GROUP BY query rather than N+1 round-trips
   * (SPEC §14 #4 recommendation).
   */
  async loadLatestAllScopes(opts: { source: 'paper' | 'live' }): Promise<{
    portfolio: DrawdownStateRow | null;
    perStrategy: Record<string, DrawdownStateRow>;
  }> {
    if (!this.bundleIdColumnPresent) {
      const portfolio = await this.loadLatest({ source: opts.source });
      return { portfolio, perStrategy: {} };
    }
    // For each (source, bundle_id) pair, take the row with the largest
    // evaluated_at. argMax keeps every column tied to the same winning row.
    const q = await this.ch.query({
      query: `
        SELECT
          bundle_id,
          toUnixTimestamp64Milli(argMax(evaluated_at, evaluated_at))         AS evaluated_at_ms,
          argMax(source, evaluated_at)                                       AS source,
          argMax(stage, evaluated_at)                                        AS stage,
          argMax(drawdown_30d_pct, evaluated_at)                             AS drawdown_30d_pct,
          argMax(deployed_capital, evaluated_at)                             AS deployed_capital,
          argMax(level, evaluated_at)                                        AS level,
          toUnixTimestamp64Milli(argMax(level_entered_at, evaluated_at))     AS level_entered_at_ms,
          argMax(regime_red_days_30, evaluated_at)                           AS regime_red_days_30,
          argMax(config_version, evaluated_at)                               AS config_version
        FROM ${this.table} FINAL
        WHERE source = {source:String}
        GROUP BY bundle_id
      `,
      query_params: { source: opts.source },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    let portfolio: DrawdownStateRow | null = null;
    const perStrategy: Record<string, DrawdownStateRow> = {};
    for (const r of rows) {
      const bid = r.bundle_id ?? BUNDLE_ID_PORTFOLIO_SENTINEL;
      const parsed = parseRow(r);
      if (bid === BUNDLE_ID_PORTFOLIO_SENTINEL) {
        portfolio = parsed;
      } else {
        perStrategy[bid] = parsed;
      }
    }
    return { portfolio, perStrategy };
  }
}

/**
 * Probe `system.columns` to detect whether the Phase-C migration has been
 * applied (i.e. `bundle_id` column exists on `drawdown_state_history`).
 * Used by the daemon at bootstrap to construct the repository with
 * `bundleIdColumnPresent` set; pre-migration the daemon graceful-degrades to
 * portfolio-only evaluation. SPEC strategy-tagged-drawdown-state.md §10 / §11 #27.
 */
export async function drawdownStateHasBundleIdColumn(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.columns ` +
        `WHERE database = 'quantlab' AND table = 'drawdown_state_history' AND name = 'bundle_id'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
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
 *  - `bundleIdColumnPresent` is the SINGLE flip that switches portfolio reads/
 *    writes from "no bundle_id field" (pre-migration) to "filter on bundle_id
 *    = ''" (post Phase-C). A future caller that constructs the repo without
 *    probing `drawdownStateHasBundleIdColumn` post-migration would silently
 *    fold per-strategy rows into portfolio hysteresis. The daemon's bootstrap
 *    is the SOURCE OF TRUTH for the flag — passing it through the repository
 *    constructor and not re-probing per call. Strategy-tagged-drawdown-state.md
 *    §10 / §11 #27.
 */
