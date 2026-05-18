/**
 * KillCriteriaDailyRepository — typed read/write over
 * `quantlab.kill_criteria_daily`.
 *
 * SPEC: docs/specs/kill-criteria-daily-history.md §§3, 4.
 * DDL:  scripts/migrate_kill_criteria_daily.ts (`DDL_KILL_CRITERIA_DAILY`).
 *
 * Single responsibility: persistence layer for per-day kill-criteria verdicts.
 * The stage state machine's pure evaluator consumes
 * `killCriteriaTrailing30: KillCriterionVerdict[][]` (index 0 = today). This
 * repository assembles that array from history rather than from the legacy
 * rolling-asOf shortcut that re-evaluates with TODAY's paperState across all
 * 30 days (SPEC §1 + §4 honest-scope note).
 *
 * Mirrors stage_state_repository.ts patterns:
 *   - ReplacingMergeTree(evaluated_at): same-day re-runs supersede.
 *   - ORDER BY (source, trade_date, code): per-source / per-window reads use
 *     the primary key.
 *   - FINAL on every read.
 *   - Graceful-degrade tableExists probe for daemon bootstrap.
 *
 * Honest-fix semantic:
 *   The legacy rolling-asOf assembly was operationally STRICTER than ADR-039
 *   §5 — today's B1/A2/A3/C1/C3 failure wiped every prior day's verdicts (only
 *   A4/A5 re-windowed honestly because their internals consume asOf). The
 *   honest fix is to persist verdicts at the moment they were FIRST computed
 *   (i.e. the daemon-run when each historical day was "today") and read those
 *   verdicts back on the trailing-30 reconstruction.
 */
import { getClickHouse } from './clickhouse.js';
import type { ClickHouseClient } from '@clickhouse/client';
import type {
  KillCriterionVerdict,
  KillVerdict,
} from './paper_trading_kill_criteria.js';
import type { KillCriterionCode } from './stage_state.js';

/**
 * SPEC §4 default. Matches the ADR-039 §5 trailing-30d window the stage state
 * machine consumes. Exported so tests + the daemon caller pin against the
 * same constant.
 */
export const KILL_CRITERIA_DAILY_TRAILING_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface KillCriteriaDailyWriteInput {
  /** UTC; only the DATE portion is persisted (the column is CH `Date`). */
  tradeDate: Date;
  source: 'paper' | 'live';
  verdicts: ReadonlyArray<KillCriterionVerdict>;
  /** ReplacingMergeTree version column — same-(source, tradeDate, code)
   *  re-writes at a LATER evaluatedAt supersede earlier on merge. */
  evaluatedAt: Date;
  configVersion: string;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * CH stores NaN/Infinity in Float64 fine (as `nan` / `inf`) but JSON
 * serialisation of NaN is non-portable. Coerce per stage_state_repository.ts
 * precedent: NaN→0, +Infinity→+1e308, -Infinity→-1e308. The audit trail's
 * "criterion fired vs not" semantic is preserved by `verdict` +
 * `insufficient_reason`; `measured_value` is supplementary.
 */
function safeFloat(x: number | undefined | null): number {
  if (x === undefined || x === null) return 0;
  if (Number.isNaN(x)) return 0;
  if (x === Number.POSITIVE_INFINITY) return 1e308;
  if (x === Number.NEGATIVE_INFINITY) return -1e308;
  return x;
}

function serialiseRow(
  input: KillCriteriaDailyWriteInput,
  v: KillCriterionVerdict,
) {
  return {
    trade_date: ymdUtc(input.tradeDate),
    source: input.source,
    code: v.code,
    verdict: v.verdict,
    label: v.label,
    rationale: v.rationale,
    measured_value: safeFloat(v.measuredValue),
    threshold: safeFloat(v.threshold),
    insufficient_reason: v.insufficientReason ?? '',
    evaluated_at: chDateTime64(input.evaluatedAt),
    config_version: input.configVersion,
  };
}

interface RawRow {
  trade_date_ms: number;
  source: string;
  code: string;
  verdict: string;
  label: string;
  rationale: string;
  measured_value: number;
  threshold: number;
  insufficient_reason: string;
  evaluated_at_ms: number;
  config_version: string;
}

const VERDICT_VALUES = new Set<KillVerdict>(['pass', 'fail', 'insufficient_data']);

function parseVerdict(s: string): KillVerdict {
  return VERDICT_VALUES.has(s as KillVerdict) ? (s as KillVerdict) : 'insufficient_data';
}

function rowToVerdict(r: RawRow): KillCriterionVerdict {
  // Reconstruct the KillCriterionVerdict shape. Per critic M-4: ALWAYS surface
  // measuredValue + threshold on read; the prior "omit when === 0" gating
  // collided "legitimate 0" (e.g. A3 max-DD = 0 because no drawdown) with
  // "undefined on write" (safeFloat(undefined) = 0). Faithful round-trip is
  // preferable. Lossy NaN→0 + ±Infinity→±1e308 on the write side is
  // documented in safeFloat and in this module's "What could break this."
  return {
    code: r.code as KillCriterionCode,
    label: r.label,
    verdict: parseVerdict(r.verdict),
    rationale: r.rationale,
    measuredValue: r.measured_value,
    threshold: r.threshold,
    insufficientReason: r.insufficient_reason === '' ? undefined : r.insufficient_reason,
  };
}

export interface KillCriteriaDailyRepositoryOptions {
  ch?: ClickHouseClient;
  table?: string;
}

export class KillCriteriaDailyRepository {
  private readonly ch: ClickHouseClient;
  private readonly table: string;

  constructor(opts: KillCriteriaDailyRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.table = opts.table ?? 'quantlab.kill_criteria_daily';
  }

  /**
   * Persist all verdicts for ONE (source, tradeDate). One row per verdict
   * code. Idempotent under same-day re-write — same-(source, tradeDate, code)
   * triple with a later evaluatedAt supersedes on merge.
   *
   * Empty verdicts array is a no-op (no INSERT issued). A future "daemon ran
   * but kill-criteria evaluator returned nothing" edge case would NOT write
   * empty rows that could confuse the trailing-30 read.
   */
  async writeDay(input: KillCriteriaDailyWriteInput): Promise<void> {
    if (input.verdicts.length === 0) return;
    const values = input.verdicts.map(v => serialiseRow(input, v));
    await this.ch.insert({
      table: this.table,
      values,
      format: 'JSONEachRow',
    });
  }

  /**
   * Load the trailing N days of verdicts for one source, returned as an
   * array of length `days` (default 30) indexed by day offset from `asOf`:
   *   result[0] = verdicts for `asOf`'s UTC date
   *   result[i] = verdicts for `asOf - i days`
   *
   * Days with no persisted rows return `[]` at that index. The consumer
   * (`dayPassesA1A5` in stage_state.ts) requires all of B1/A2/A3/A4/A5 to be
   * present + pass for the day to count toward the streak; an empty array
   * therefore breaks the streak — which is the honest reading of "≥10
   * consecutive A1-A5 pass days" when a day has no observed verdicts.
   *
   * Empty SELECT (table absent or pre-population) returns an array of `days`
   * empty `[]`s, not `[]`. The pure evaluator gets a stable shape regardless
   * of how many days have been persisted.
   */
  async loadTrailing30(opts: {
    source: 'paper' | 'live';
    asOf: Date;
    days?: number;
  }): Promise<ReadonlyArray<KillCriterionVerdict[]>> {
    const days = opts.days ?? KILL_CRITERIA_DAILY_TRAILING_DAYS;
    if (!Number.isInteger(days) || days < 1) {
      throw new Error(
        `KillCriteriaDailyRepository.loadTrailing30: days must be a positive integer (got ${days})`,
      );
    }
    const asOfDay = ymdUtc(opts.asOf);
    const oldestDay = ymdUtc(new Date(opts.asOf.getTime() - (days - 1) * MS_PER_DAY));

    const q = await this.ch.query({
      query: `
        SELECT
          toUnixTimestamp64Milli(toDateTime64(trade_date, 3, 'UTC')) AS trade_date_ms,
          source,
          code,
          verdict,
          label,
          rationale,
          measured_value,
          threshold,
          insufficient_reason,
          toUnixTimestamp64Milli(evaluated_at) AS evaluated_at_ms,
          config_version
        FROM ${this.table} FINAL
        WHERE source = {source:String}
          AND trade_date >= {from:Date}
          AND trade_date <= {to:Date}
        ORDER BY trade_date ASC, code ASC
      `,
      query_params: {
        source: opts.source,
        from: oldestDay,
        to: asOfDay,
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();

    // Group rows by `(source, trade_date)` UTC day-string then map to the
    // day-offset array indexed from asOf (offset 0) backward (offset days-1).
    // Source is included in the key per critic M-2 — defensive against any
    // future caller that passes mismatched source on write vs read, or a
    // refactor that drops the source filter from the SQL. The single-source
    // SQL filter SHOULD prevent any other source's rows from reaching here,
    // but encoding the assumption in the bucket key is cheap insurance.
    const byDay = new Map<string, KillCriterionVerdict[]>();
    for (const r of rows) {
      const dayKey = `${r.source}|${ymdUtc(new Date(Number(r.trade_date_ms)))}`;
      let bucket = byDay.get(dayKey);
      if (!bucket) {
        bucket = [];
        byDay.set(dayKey, bucket);
      }
      bucket.push(rowToVerdict(r));
    }

    const result: KillCriterionVerdict[][] = new Array(days);
    for (let i = 0; i < days; i++) {
      const dayKey = `${opts.source}|${ymdUtc(new Date(opts.asOf.getTime() - i * MS_PER_DAY))}`;
      result[i] = byDay.get(dayKey) ?? [];
    }
    return result;
  }
}

/**
 * Graceful-degrade probe — used by the daemon at bootstrap to fall back to
 * the legacy rolling-asOf shortcut (info-anomaly + warning log) when the
 * table hasn't been migrated.
 */
export async function killCriteriaDailyTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'kill_criteria_daily'`,
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
 *  - Cross-source mixing: caller MUST pass matching `source` on write and read.
 *    Repository does NOT re-filter. Paper and live each run an independent
 *    kill-criteria evaluation per SPEC §3.
 *  - `tradeDate` MUST be the asOf the verdicts were computed against, not the
 *    wall-clock "now." The daemon orchestrator passes `asOf` for the daemon-
 *    run-start clock; the kill-criteria evaluator already uses that asOf for
 *    A4/A5 windowing. Mismatched tradeDate creates off-by-one streak counts at
 *    UTC midnight boundaries.
 *  - Write-then-read ordering inside the orchestrator: the honest fix REQUIRES
 *    writeDay BEFORE loadTrailing30 within the same daemon-run. The repository
 *    relies on FINAL + the ReplacingMergeTree merge-on-read semantic; the
 *    just-written row is returned at index 0 of the load result on the same
 *    daemon-run.
 *  - SINGLE-REPLICA ASSUMPTION (critic M-1). The above read-after-write
 *    guarantee holds on a SINGLE CH instance / single replica. On a
 *    replicated cluster, an INSERT to one replica may take seconds (or
 *    longer under load) to propagate to the SELECT replica — the just-
 *    written row may NOT appear at index 0 of the same-daemon-run load.
 *    Effect: today's streak count goes silently off by one (today's verdict
 *    missing → streak breaks at index 0). If/when this table is replicated,
 *    pass `select_sequential_consistency = 1` on the read query, OR write
 *    with `wait_end_of_query = 1`, OR refactor to use today's verdicts
 *    in-memory (skipping the just-written read). SPEC §10 documents the
 *    same assumption.
 *  - Empty `verdicts` write is a NO-OP. A future evaluator that emits the
 *    empty array for some reason would NOT pollute history with empty days.
 *    The trailing-30 read still returns `[]` for that day (no persisted row),
 *    breaking the streak — which is the correct semantic.
 *  - Missing-day = breaks-streak. This is documented behavior, not a bug.
 *    The first 9 days post-migration cannot promote (ADR-039 §5 requires ≥10
 *    consecutive pass days; honest history only starts populating on apply).
 *  - safeFloat(NaN) === 0 is ambiguous on read: was the measured_value `0` or
 *    "undefined"? The verdict + insufficient_reason columns carry the semantic;
 *    measured_value is supplementary. rowToVerdict only surfaces `measuredValue`
 *    when the persisted value is non-zero — this is the legacy contract from
 *    `paper_trading_kill_criteria.ts` (optional field).
 *  - LowCardinality `code` dictionary grows safely if ADR-040 adds A6 etc.;
 *    parseVerdict's tolerant fallback ('insufficient_data' for unknown
 *    strings) means a forward-compat read from an older binary still returns
 *    a stable shape.
 *  - ReplacingMergeTree dedupe occurs on merge; FINAL on every read is
 *    LOAD-BEARING. A future "drop FINAL for perf" would expose superseded
 *    rows.
 *  - Retention forever (≤7 codes × 2 sources × 365 days × 10 years ≈ 51k
 *    rows). Revisit only if daemon cadence becomes intra-day.
 */
