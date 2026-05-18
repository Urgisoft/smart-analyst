/**
 * Read-side repository for `quantlab.cell_weights_history` — ADR-040 SPEC §11.2.
 *
 * Single source of truth for the prior-tier lookup so daemon and brief
 * compose the same `priorActiveTier` value when both call
 * `resolveCellWeightsForRun`. Without sharing this, the brief would always
 * pass `priorActiveTier: null` and silently disagree with the daemon's
 * tier after the first ratchet event (critic M-1 fix to the CODE session).
 *
 * Resilient to a missing table — returns `null` on cold-start so
 * `computeCellWeights` starts at T0.
 */
import { getClickHouse } from './clickhouse.js';
import type { CellWeightsTier } from './cell_weights.js';

/**
 * SPEC §11.2 — most recent non-DEGRADED tier from cell_weights_history.
 *
 * `WHERE degraded = 0` is load-bearing (H-2 critic-fix to the SPEC): a single
 * CH outage writes a `degraded=1` row at `tier_active='T0'`, and absent the
 * filter the next prior-tier lookup would silently downgrade the ratchet.
 *
 * Returns `null` when the table does not exist OR every prior row is
 * degraded — in both cases the helper treats this as cold-start.
 */
export async function loadPriorActiveCellWeightsTier(): Promise<CellWeightsTier | null> {
  try {
    const ch = getClickHouse();
    const exists = await ch.query({
      query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'cell_weights_history'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await exists.json<{ n: string | number }>();
    if (Number(n) === 0) return null;
    const r = await ch.query({
      query: `
        SELECT tier_active
        FROM quantlab.cell_weights_history FINAL
        WHERE degraded = 0
        ORDER BY run_ts DESC
        LIMIT 1
      `,
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ tier_active: string }>();
    if (rows.length === 0) return null;
    const t = rows[0].tier_active;
    if (t === 'T0' || t === 'T1' || t === 'T2') return t;
    return null;
  } catch {
    // Non-fatal; caller cold-starts at T0.
    return null;
  }
}
