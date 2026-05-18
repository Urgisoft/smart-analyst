/**
 * Shared `bt_runs` WHERE-clause builder used by both `score_strategies.ts` and the
 * cell-validator route. The two MUST stay in lockstep — drift between the production
 * scorer's filter and the validator's filter silently miscalibrates `N` (the trial
 * cardinality DSR/HLZ/PBO are calibrated against). See docs/teach/2026-05-02-trial-cardinality.md
 * for why this matters.
 *
 * The filter set itself encodes three project-level decisions baked in over multiple
 * sessions; do not move them without a deliberate review:
 *   1. Magnitude clamps on net % (IS and OOS both) — defense against un-cleaned outliers
 *      that would skew tier aggregates. The clamp does NOT remove rows from ClickHouse;
 *      it just hides them from the scorer + validator.
 *   2. mcap_large + mcap_unknown exclusions — N=1-token tiers are degenerate for any
 *      cross-section gate (PSR/PBO/HLZ) and inflate the multi-cell HLZ haircut count M.
 *   3. 4h interval is excluded EXCEPT for cex_major — Solana data quality issue, not
 *      applicable to BTC/ETH/SOL via Kraken (which is intentionally single-asset-per-cell).
 *      Per TSMOM v1.2 SPEC §3.
 *
 * Spec: SPEC §3 of the Path β cell-validator (conversation 2026-05-02).
 */

export interface BtRunsFilter {
  /** Optional `bt_runs.strategy_type` exact-match. */
  strategy?: string;
  /** Optional `bt_runs.tier` exact-match. */
  tier?: string;
  /** Optional `bt_runs.interval` exact-match. */
  interval?: string;
}

export interface BtRunsFilterSql {
  /** SQL WHERE-fragment, including the leading 'WHERE' keyword. Empty `WHERE 1` if no
   *  filters and no canonical guards apply (the canonical guards always apply, so in
   *  practice this always has content). */
  whereSql: string;
  /** Named-params object suitable for ClickHouse `query_params`. */
  params: Record<string, unknown>;
}

/**
 * Universal magnitude hygiene predicates on `net_profit_pct` (IS + OOS). Defense
 * against un-cleaned outliers that would skew per-cell aggregates. Applied
 * unconditionally on BOTH the tier axis (via `buildBtRunsFilter`) and the
 * cluster axis (via `score_strategies_by_cluster.ts::buildClusterRunsFilter`,
 * `clickhouse.ts::fetchValidatorClusterCells`, and
 * `clickhouse.ts::fetchValidatorClusterCellData`).
 *
 * Single source of truth — if a third clamp ever needs to land (e.g. trade-count
 * floor, sharpe magnitude cap), add it HERE so all five sites pick it up. The
 * historical failure mode this constant prevents: a clamp landing in the scorer
 * but not the validator silently miscalibrates the trial-cardinality population
 * the validator scores against vs. the population the scorer ranks against — a
 * lockstep break that propagates as quiet `best_param` divergence on edge cells.
 *
 * Predicates are stored as an immutable array (rather than a single string) so
 * callers using `where.push(...)` style can spread them in without re-parsing.
 */
export const RUNS_MAGNITUDE_HYGIENE_PREDICATES: ReadonlyArray<string> = Object.freeze([
  `abs(net_profit_pct) < 1000000`,
  `abs(oos_net_profit_pct) < 1000000`,
]);

/**
 * The same magnitude hygiene predicates joined with ` AND ` for splicing into a
 * pre-formatted WHERE block. No leading/trailing keywords — caller is responsible
 * for the surrounding `WHERE … AND ${RUNS_MAGNITUDE_HYGIENE_SQL}` boilerplate.
 */
export const RUNS_MAGNITUDE_HYGIENE_SQL: string =
  RUNS_MAGNITUDE_HYGIENE_PREDICATES.join(' AND ');

/**
 * Build the canonical bt_runs filter. Applies the three project-level guards above
 * unconditionally, then tacks on the caller-supplied (strategy, tier, interval)
 * predicates if present.
 */
export function buildBtRunsFilter(f: BtRunsFilter): BtRunsFilterSql {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  // Caller-supplied identity filters first (most selective).
  if (f.strategy) { where.push(`strategy_type = {strat:String}`); params.strat = f.strategy; }
  if (f.interval) { where.push(`interval = {iv:String}`);          params.iv = f.interval; }
  if (f.tier)     { where.push(`tier = {tier:String}`);            params.tier = f.tier; }

  // Canonical guards (always applied). Magnitude clamps come from the shared
  // RUNS_MAGNITUDE_HYGIENE_PREDICATES constant — keep them centralized so
  // tier-axis and cluster-axis stay lockstep when a clamp is added/changed.
  where.push(...RUNS_MAGNITUDE_HYGIENE_PREDICATES);
  where.push(`tier NOT IN ('mcap_large', 'mcap_unknown')`);
  where.push(`(tier = 'cex_major' OR interval != '4h')`);

  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

/*
 * What could break this:
 * - If a new tier is introduced that should also be excluded from cross-section gates
 *   (e.g. another single-asset tier), the exclusion needs to land HERE — both
 *   score_strategies and the cell validator pick it up automatically. Forgetting one
 *   spot is the historical failure mode this module is designed to prevent.
 * - The 4h-vs-cex_major exception is asymmetric. If anyone introduces a 4h cex_major
 *   interval, it'll come through; that's the intended behavior per TSMOM v1.2 §3.
 * - Param substitution syntax is ClickHouse-specific (`{name:Type}`). Don't port this
 *   to Postgres without rewriting.
 */
