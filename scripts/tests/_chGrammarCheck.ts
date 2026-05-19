/**
 * CH grammar/semantics validation for FakeClickHouse-recorded queries.
 *
 * Motivation:
 *   FakeClickHouse (used in `drawdownStateRepository.test.ts`, etc.) is a
 *   record-and-replay fake — it stores the query string and returns staged
 *   rows. It does NOT parse SQL. That's enough to pin the *contract* of the
 *   query (column names, GROUP BY shape, WHERE structure via regex) but
 *   insufficient to catch ClickHouse-specific semantic divergences from
 *   ANSI SQL. The `loadLatestAllScopes` ILLEGAL_AGGREGATION (CH code 184)
 *   bug fixed in commit a52c964 was exactly this class — CH's name
 *   resolution binds a `WHERE source = ...` reference to the
 *   `argMax(source, evaluated_at) AS source` SELECT alias (an aggregate)
 *   before binding to the underlying column, which CH then rejects. The
 *   28 s81 Phase B unit tests passed; production CH rejected on first run.
 *
 * Strategy:
 *   `EXPLAIN PLAN <query>` runs the parser + analyser + planner without
 *   executing. Aggregate-in-WHERE is rejected during the analyser pass,
 *   so EXPLAIN PLAN would have caught a52c964 the moment the test ran
 *   against a real CH. This helper wraps that: send EXPLAIN PLAN for
 *   every recorded query, with the same query_params, and fail the test
 *   if CH refuses any.
 *
 *   Why PLAN and not SYNTAX or QUERY TREE:
 *   - On CH 24.8 (the version this repo targets) all three variants
 *     reject the a52c964 query via code 184. Verified empirically with a
 *     side-by-side probe before locking the choice in.
 *   - SYNTAX is documented as parser-only on older CH versions; on
 *     newer versions it implicitly runs the analyser as a side-effect of
 *     name resolution during AST reformatting. The CH docs do not
 *     guarantee analyser invocation under SYNTAX across versions — so a
 *     CH upgrade or a different dev box could silently weaken coverage.
 *   - QUERY TREE requires `allow_experimental_analyzer = 1` in some CH
 *     versions and adds a settings dependency we'd rather avoid.
 *   - PLAN is documented to run the analyser pass on every supported CH
 *     version, has no settings dependency, and does NOT execute the
 *     query. It is the version-stable choice.
 *
 * Skip-if-unavailable:
 *   The test must pass on a fresh clone without a local CH running. If
 *   ClickHouse is unreachable (ECONNREFUSED on the ping), the assertion
 *   is skipped with a one-time console.warn. This matches the pattern in
 *   `macroRegimeFixturesV3.test.ts`. Hard-fail would break the 1333/0/6
 *   baseline the s82 close beat pinned.
 *
 * Scope (initial):
 *   Used only by `drawdownStateRepository.test.ts` SELECT-path tests.
 *   Extension to the other FakeClickHouse-using test files is a follow-up.
 */
import { getClickHouse, pingClickHouse } from '../../src/server/clickhouse.js';

let _chAvailable: boolean | null = null;
let _warnedUnavailable = false;

/**
 * Cached CH ping. The first caller pays the round-trip; subsequent calls
 * in the same `node --test` run reuse the verdict (the dev CH doesn't
 * appear/disappear mid-suite).
 */
async function chAvailable(): Promise<boolean> {
  if (_chAvailable !== null) return _chAvailable;
  _chAvailable = await pingClickHouse();
  return _chAvailable;
}

export interface RecordedQuery {
  query: string;
  query_params?: Record<string, unknown>;
}

export interface CHGrammarVerdict {
  ok: boolean;
  /** True iff the assertion was skipped because CH is unreachable. */
  skipped: boolean;
  /** Populated when `ok === false`: the first query + error encountered. */
  failure?: { query: string; error: string };
}

/**
 * Run `EXPLAIN SYNTAX` against a real CH for each recorded query. Returns
 * a verdict object — callers translate `ok === false` to an assertion
 * failure in their own test (so the failure line points at the test, not
 * this helper).
 *
 * `tableSubstitutions`: tests use placeholder table names (e.g.
 * `quantlab.drawdown_state_history_test`) that don't exist on real CH.
 * Replace them with the production-canonical names before EXPLAIN. The
 * substitution is a straight `String.replaceAll` — no SQL-aware parsing,
 * keep the names distinctive enough to avoid collision with column or
 * function names (the prod table names are namespaced `quantlab.*` so
 * this is safe by construction).
 *
 * See the module docstring for the rationale on EXPLAIN PLAN over the
 * SYNTAX / QUERY TREE / AST variants.
 */
export async function assertCHGrammar(opts: {
  queries: RecordedQuery[];
  tableSubstitutions?: Array<{ from: string; to: string }>;
}): Promise<CHGrammarVerdict> {
  if (!(await chAvailable())) {
    if (!_warnedUnavailable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[chGrammarCheck] ClickHouse unreachable at ' +
          `${process.env.CLICKHOUSE_HOST ?? '127.0.0.1'}:` +
          `${process.env.CLICKHOUSE_PORT ?? '8123'} — ` +
          'EXPLAIN PLAN assertions skipped. Start the local CH to ' +
          'activate grammar-validation coverage for this test file.',
      );
      _warnedUnavailable = true;
    }
    return { ok: true, skipped: true };
  }
  const ch = getClickHouse();
  for (const q of opts.queries) {
    let sql = q.query;
    for (const sub of opts.tableSubstitutions ?? []) {
      sql = sql.split(sub.from).join(sub.to);
    }
    try {
      const r = await ch.query({
        query: `EXPLAIN PLAN ${sql}`,
        query_params: q.query_params,
        format: 'JSONEachRow',
      });
      // Drain the response so the CH client releases the connection.
      await r.json();
    } catch (err) {
      return {
        ok: false,
        skipped: false,
        failure: {
          query: sql,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
  return { ok: true, skipped: false };
}
