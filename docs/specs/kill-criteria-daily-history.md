# SPEC — `kill_criteria_daily` history table

Status: PROPOSED (session 57 — 2026-05-16)
Author: Vector Core / Opus 4.7
Closes: stage-state-machine.md §15 H-1 "honest fix" backlog.
Supersedes: nothing (additive).

---

## 1. Why

The stage state machine's paper→stage1 promotion gate (ADR-039 §5) requires
"≥10 consecutive A1-A5 pass days in the trailing 30." The pure evaluator
(`evaluateStageState`) reads `killCriteriaTrailing30: KillCriterionVerdict[][]`
where index 0 = today and index 29 = oldest. The evaluator trusts the contract
and the daemon orchestrator (`runDaemonStageStateEvaluation` in
`src/server/daemon_live_trades.ts`) is responsible for assembly.

The current first-cut assembly (stage-state-machine.md §4 honest-scope note +
the inline comment at `daemon_live_trades.ts` ~L952) re-evaluates
`evaluateKillCriteria` with rolling `asOf` values BUT passes TODAY's
`paperState` for every day. The result is operationally STRICTER than the
literal §5 reading:

- **A4 and A5** re-window honestly because their internals use `asOf` to
  bound their trailing 30 days against the trade ledger.
- **B1, A2, A3, C1, C3** use TODAY's snapshot for every day. If today fails
  one of these, every rolling-asOf re-eval also fails → consecutive-pass
  count collapses to 0 even when those criteria genuinely passed on earlier
  days.

The conservative direction is the safe one (false-negative on promotion,
never false-positive) — that's why this was acceptable for the first cut.
But it's a known honesty debt: a single bad B1 day on day 30 erases a
genuine 29-day pass streak. The honest fix is to persist per-day verdicts
when they were FIRST computed (i.e. at the time the morning brief consumed
them) and to reconstruct the trailing-30 by reading from history.

This SPEC pins the schema, repository contract, and daemon wire-up for that
fix. It explicitly does NOT change the pure `evaluateStageState`'s contract:
the trailing-30 array's SHAPE stays identical. Only the assembly path
changes.

---

## 2. Scope

In-scope:

1. New ClickHouse table `quantlab.kill_criteria_daily` — one row per day per
   criterion code per source. Idempotent under same-day re-write
   (ReplacingMergeTree).
2. New repository `src/server/kill_criteria_daily_repository.ts` — write
   today's verdicts; read the trailing-30 reconstruction for one source.
3. New migration `scripts/migrate_kill_criteria_daily.ts` + the
   `migrate:kill-criteria-daily` / `:apply` npm scripts.
4. Daemon wire-up: `runDaemonStageStateEvaluation` writes today's verdicts
   BEFORE reading the trailing-30 reconstruction. Pre-migration fallback
   preserves the existing first-cut behavior + the existing graceful-degrade
   anomaly path.
5. New tests: `scripts/tests/killCriteriaDailyRepository.test.ts` (fake-CH
   round-trip) + extension of `scripts/tests/daemonStageState.test.ts` for
   the new write-then-read ordering + graceful-degrade contract.

Out-of-scope:

- Any change to the pure `evaluateStageState` contract or
  `paper_trading_kill_criteria.ts` evaluator logic.
- A point-in-time reconstruction of historical days BEFORE this slice
  ships. Backfill is intentionally NOT in this slice — the table starts
  populating from day 1 of operational use. The honest streak count
  becomes available after 10 consecutive daemon-runs post-deployment.
- Brief panel changes. The brief already consumes `consecutiveA1A5PassDays`
  from `StageStateRow`; nothing changes on its surface.
- Per-cell granularity. Verdicts are SOURCE-scoped, not cell-scoped — the
  criteria themselves operate at the source level (A4 is cross-bundle by
  construction).

---

## 3. Schema — `quantlab.kill_criteria_daily`

```sql
CREATE TABLE IF NOT EXISTS quantlab.kill_criteria_daily (
  trade_date           Date,
  source               LowCardinality(String),
  code                 LowCardinality(String),
  verdict              LowCardinality(String),
  label                String,
  rationale            String,
  measured_value       Float64,
  threshold            Float64,
  insufficient_reason  String,
  evaluated_at         DateTime64(3, 'UTC'),
  config_version       String
)
ENGINE = ReplacingMergeTree(evaluated_at)
ORDER BY (source, trade_date, code)
```

Column rationale:

- `trade_date Date` — the UTC calendar day the verdict applies to. This is
  the SAME day-bucket the kill-criteria evaluator uses for A4/A5 windowing
  (`ymdUtc(asOf)`); using `Date` rather than `DateTime` keeps the bucket
  alignment unambiguous and makes "verdict for day D" reads use the primary
  key directly.
- `source LowCardinality` — `'paper' | 'live'`; paper and live each run an
  independent kill-criteria evaluation. Mirrors `stage_state_history`
  source-segregation.
- `code LowCardinality` — `'B1' | 'A2' | 'A3' | 'A4' | 'A5' | 'C1' | 'C3'`.
  Fixed 7-value vocabulary; LowCardinality keeps dictionary tight.
- `verdict LowCardinality` — `'pass' | 'fail' | 'insufficient_data'`.
- `label / rationale / insufficient_reason` — strings the evaluator already
  produces. Persisted for audit + future brief consumption.
- `measured_value Float64` — `safeFloat`-encoded per the
  `stage_state_repository.ts` precedent (NaN→0, ±Infinity→±1e308). When the
  evaluator returns `undefined`, we store `NaN`-coerced 0; the decision +
  verdict columns preserve the semantic.
- `threshold Float64` — same coercion. Stored even when the evaluator's
  threshold is fixed (audit anchor against future ADR amendments).
- `evaluated_at DateTime64(3, 'UTC')` — the daemon's RUN-START CLOCK
  (`asOf` passed by the orchestrator), NOT a fresh `new Date()` at SQL-
  INSERT time. This is intentional and matches `stage_state_history` /
  `drawdown_state_history` house style: the audit anchor is "what asOf the
  evaluation was bound to," shared with `trade_date`. Per critic H-1
  resolution: this means a same-DAEMON-PROCESS retry (no t0 advance) writes
  IDENTICAL evaluated_at values — ReplacingMergeTree dedupe order is
  arbitrary in that case, which is acceptable because the verdicts SHOULD
  be identical (same closedTrades + paperState snapshot). For cross-process
  retries (manual operator re-run), t0 advances → evaluated_at advances →
  later write wins on merge. **CRITICAL**: the ReplacingMergeTree version
  column is `evaluated_at`; the sort key is `(source, trade_date, code)`. A
  same-(source, trade_date, code) re-write at a LATER `evaluated_at`
  supersedes the earlier on merge. `FINAL` reads return the superseding
  row even pre-merge.
- `config_version String` — pinned to the same `CONFIG_VERSION` constant
  the stage + drawdown state writes use. Future ADR-040 amendments
  (e.g. a new criterion) bump it.

ORDER BY rationale:

- `(source, trade_date, code)` — reads always filter by `source` first
  (cross-source mixing is forbidden), then either by `trade_date` (trailing
  window load) or by `(trade_date, code)` (point lookup of one day's full
  vector). The primary key supports both.
- Composite sort means a same-day re-write of all 7 codes for one source
  creates 7 dedupe-relevant clusters (one per code), which is the desired
  granularity. The `evaluated_at` version applies WITHIN a `(source,
  trade_date, code)` triple — re-running the daemon for the same day
  supersedes each code's verdict independently, but does NOT collapse
  across codes.

Retention forever — 7 codes × 2 sources × 365 days × 10 years ≈ 51k rows.
Trivial. Revisit only if the daemon cadence becomes multi-per-day at the
intra-day granularity.

---

## 4. Repository interface — `src/server/kill_criteria_daily_repository.ts`

```typescript
export interface KillCriteriaDailyWriteInput {
  tradeDate: Date;                              // UTC; only date portion used
  source: 'paper' | 'live';
  verdicts: ReadonlyArray<KillCriterionVerdict>;
  evaluatedAt: Date;                            // ReplacingMergeTree version
  configVersion: string;
}

export class KillCriteriaDailyRepository {
  constructor(opts?: { ch?: ClickHouseClient; table?: string });

  /**
   * Persist all verdicts for ONE (source, tradeDate). One row per verdict
   * code. Idempotent under same-day re-write (later evaluatedAt wins).
   */
  writeDay(input: KillCriteriaDailyWriteInput): Promise<void>;

  /**
   * Load the trailing N days of verdicts for one source, returned as
   * ReadonlyArray<KillCriterionVerdict[]> indexed by day offset from
   * `asOf` (index 0 = asOf's UTC date, index N-1 = oldest). Days with no
   * persisted row return an empty array at that index — caller treats
   * "no row" as "did not pass" via the existing `dayPassesA1A5` contract
   * (a missing required code blocks the day from counting as pass).
   *
   * The trailing window is CALENDAR days, matching A4/A5 windowing.
   */
  loadTrailing30(opts: {
    source: 'paper' | 'live';
    asOf: Date;
    days?: number;        // defaults to KILL_CRITERIA_DAILY_TRAILING_DAYS = 30
  }): Promise<ReadonlyArray<KillCriterionVerdict[]>>;
}

export function killCriteriaDailyTableExists(
  ch?: ClickHouseClient,
): Promise<boolean>;

export const KILL_CRITERIA_DAILY_TRAILING_DAYS = 30;
```

Read contract — index-0-aligned-to-asOf:

The returned array has length `days` (default 30). `result[0]` is the
verdicts for `asOf`'s UTC date; `result[i]` is for `asOf - i days`. Days
without persisted rows return `[]`. This matches the existing
`killCriteriaTrailing30` shape exactly — the consumer
(`countConsecutiveA1A5PassDays`) walks index 0 forward and breaks on the
first day that fails `dayPassesA1A5` (which already requires ALL of
B1/A2/A3/A4/A5 present + pass).

Why empty-day = stops-the-streak (not skipped):

`dayPassesA1A5` requires all of B1/A2/A3/A4/A5 to be present AND pass. A
missing code returns false (defensive — "we don't know" is the same
severity as `insufficient_data`). An empty `[]` for a day therefore stops
the streak. This is intentional: a day with no persisted verdict row
means the daemon didn't run that day. Treating it as a pass would let a
single daemon-run-on-day-30 promote with 1 pass day. Treating it as a
break is the conservative (and honest) reading of ADR-039 §5.

Why NOT throw on missing days:

The first 29 days of operational use have NO history. A throw would brick
the daemon. The empty-array contract gracefully degrades — the streak just
won't reach 10 until 10 consecutive days have written rows.

Date semantics:

Input `tradeDate Date` — we extract `ymdUtc(d)` and store the UTC calendar
date. The HOUR/MINUTE/SECOND components are deliberately discarded; the
schema is `Date` not `DateTime`. Two daemon runs at different times on the
same UTC calendar day write the SAME `trade_date` and dedupe.

Load `asOf Date` — same `ymdUtc(asOf)` extraction. The window is
`[ymdUtc(asOf - 29d), ymdUtc(asOf)]` inclusive (30 days total). The day
math uses `MS_PER_DAY` arithmetic (matches kill-criteria evaluator's
`trailingWindowCutoffDay`).

---

## 5. Daemon wire-up

`runDaemonStageStateEvaluation` in `src/server/daemon_live_trades.ts`:

```text
ORDER (new):
  1. Existing: load priorHistory, closedTrades, drawdownPriorHistory in parallel.
  2. Compute today's verdicts ONCE (single asOf):
        const todaysVerdicts = evaluateKillCriteria({
          state: paperState,
          closedTrades,
          asOf,
        });
  3. IF killCriteriaDailyRepo is present (post-migration):
        a. Write today's verdicts to history:
           await killCriteriaRepo.writeDay({
             tradeDate: asOf, source, verdicts: todaysVerdicts,
             evaluatedAt: asOf, configVersion,
           });
        b. Read trailing-30 from history (write-then-read in same orchestrator
           is fine because ReplacingMergeTree + FINAL is read-after-write
           consistent within ms; the just-written row IS returned at index 0
           on the load):
           killCriteriaTrailing30 = await killCriteriaRepo.loadTrailing30({
             source, asOf, days: 30,
           });
     ELSE (pre-migration graceful degrade):
        Fall back to the existing first-cut rolling-asOf assembly. The
        existing inline comment is updated to point at this SPEC's §6
        graceful-degrade contract.
  4. (Unchanged) call evaluateStageState with the assembled trailing-30.
```

Write-then-read ordering rationale:

Persisting BEFORE reading guarantees `result[0]` is non-empty in the
post-migration path: today's verdicts have just been written. This is the
honest fix's whole point. The cost is one extra INSERT + one extra SELECT
per daemon run — both trivial against the existing CH operations.

Single-asOf computation rationale:

The pre-SPEC code computed 30 evaluations with rolling `asOf` values; only
A4/A5 produced different results because only they consume `asOf` for
windowing. The post-SPEC path computes ONLY today's verdicts (one
evaluation) and trusts history for earlier days. Net: 29 fewer
`evaluateKillCriteria` calls per daemon run. Reads of the trailing window
return ONLY data that was ACTUALLY observed on those days.

Idempotency:

A daemon re-run on the same day writes a new row at a higher
`evaluated_at` for each (source, today, code) triple. ReplacingMergeTree
deduplicates to the latest write. The read returns the LATEST verdict for
each day, which is the correct behavior (re-runs reflect operator intent
to re-evaluate with the most recent paper-state + closed-trade snapshot).

Graceful degrade:

If `kill_criteria_daily` does not exist (operator hasn't run the
migration), the daemon falls back to the existing first-cut rolling-asOf
assembly. An anomaly fires once on bootstrap (the bootstrap-time
`killCriteriaDailyTableExists` probe drives an `info` anomaly +
`[kill-criteria-daily]` warning to stdout, mirroring the existing
`stage_state_history` pattern at `daily_signal_daemon.ts` ~L605). The
state machine continues to run; just with the known-conservative
shortcut. This preserves the exact pre-slice behavior under
pre-migration conditions.

Write failure handling:

If the WRITE fails post-migration (network blip, CH temporarily down), we
catch and log a `warning` anomaly but DO NOT block stage evaluation. We
fall through to the legacy rolling-asOf assembly for THIS run — the
stricter-than-literal behavior is the safe-direction degradation. The
next run will retry the write. We do NOT try to dual-write: a partial
write whose read returns "today only" instead of "today + 29 prior" would
let a 1-day streak masquerade as a 1-day streak, but the read would
correctly return empty arrays for missing days (which break the streak),
so a partial write degrades to "streak stuck at 0" — same as cold-start.

---

## 6. Caller contract

`runDaemonStageStateEvaluation` adds ONE new optional input:

```typescript
killCriteriaDailyRepo?: KillCriteriaDailyRepository | null;
```

When `null` or undefined → graceful-degrade path (rolling-asOf). When a
repo is passed → write-then-read path.

The daemon main (`scripts/daily_signal_daemon.ts`) constructs the repo at
bootstrap analogously to `stageRepo`:

```typescript
const killCriteriaDailyTablePresent = await killCriteriaDailyTableExists();
if (!killCriteriaDailyTablePresent) {
  console.warn('[kill-criteria-daily] quantlab.kill_criteria_daily not found — using rolling-asOf shortcut. Run: npm run migrate:kill-criteria-daily:apply');
  anomalies.push({ severity: 'info', message: 'kill_criteria_daily table missing; using rolling-asOf shortcut for §5 streak' });
}
const killCriteriaDailyRepo = killCriteriaDailyTablePresent
  ? new KillCriteriaDailyRepository()
  : null;
```

The new repo is then passed alongside the existing `stageRepo` /
`drawdownRepo` to `runDaemonStageStateEvaluation`.

---

## 7. Pre-existing tests we MUST NOT regress

- `scripts/tests/stageState.test.ts` — pure evaluator. NOT touched. Its
  contract is verdicts-array → decision; how the array is assembled is the
  daemon's concern, not the evaluator's.
- `scripts/tests/daemonStageState.test.ts` — existing integration tests
  pass `paperState` + closedTrades=[]; the legacy rolling-asOf assembly
  runs because no `killCriteriaDailyRepo` is injected. ALL existing tests
  continue to pass byte-equal.
- `scripts/tests/operatorBriefRender.test.ts` — brief consumes
  `consecutiveA1A5PassDays` from the row; nothing changes there.
- CLI script `scripts/_paper_trading_review.ts` — uses `evaluateKillCriteria`
  directly with the legacy single-arg overload. NOT touched. The
  byte-equal stdout regression remains pinned.

---

## 8. Test plan

`scripts/tests/killCriteriaDailyRepository.test.ts` (NEW — fake-CH):

| # | Test | Pins |
|---|---|---|
| 1 | writeDay inserts one row per verdict code | shape contract |
| 2 | trade_date is ymdUtc (date portion only) | §3 |
| 3 | source, code, verdict are persisted exactly | §3 |
| 4 | safeFloat coercion for measured_value (NaN→0, +Inf→1e308, -Inf→-1e308) | §3 |
| 5 | safeFloat coercion for threshold | §3 |
| 6 | rationale and insufficient_reason persisted (`''` for absent) | §3 |
| 7 | config_version persisted exactly | §3 |
| 8 | evaluated_at is DateTime64(3) wire format `YYYY-MM-DD HH:MM:SS.mmm` | §3 |
| 9 | loadTrailing30 issues a parameterised query with source + window bounds | §4 read |
| 10 | loadTrailing30 default days=30; explicit days respected | §4 |
| 11 | loadTrailing30 rejects non-positive / non-integer days | defensive |
| 12 | loadTrailing30 returns array of length `days` | §4 read |
| 13 | loadTrailing30 index 0 = asOf's UTC date | §4 read |
| 14 | loadTrailing30 missing days return `[]` at that index | §4 graceful |
| 15 | loadTrailing30 groups multiple codes per (trade_date, source) into one array | §4 read |
| 16 | loadTrailing30 parses verdict strings into the union exactly | §4 read |
| 17 | loadTrailing30 round-trips measured_value Float64 → number | §4 read |
| 18 | killCriteriaDailyTableExists returns true on count > 0 | §6 |
| 19 | killCriteriaDailyTableExists returns false on count = 0 | §6 |
| 20 | killCriteriaDailyTableExists returns false on CH throw | §6 graceful |

`scripts/tests/daemonStageState.test.ts` (EXTEND):

| # | Test | Pins |
|---|---|---|
| 21 | NO killCriteriaDailyRepo → legacy rolling-asOf path (existing behavior preserved) | §5 graceful |
| 22 | killCriteriaDailyRepo present → writeDay called ONCE before loadTrailing30 | §5 ordering |
| 23 | killCriteriaDailyRepo present → loadTrailing30 result IS the killCriteriaTrailing30 the evaluator sees | §5 |
| 24 | killCriteriaDailyRepo present → only ONE evaluateKillCriteria call (not 30) | §5 perf |
| 25 | killCriteriaDailyRepo present + writeDay throws → falls back to legacy rolling-asOf + warning anomaly | §5 write-fail |
| 26 | killCriteriaDailyRepo present + loadTrailing30 throws → falls back to legacy rolling-asOf + warning anomaly | §5 read-fail |
| 27 | configVersion is propagated from inputs.configVersion to writeDay | §5 |
| 28 | source is propagated from inputs.source to writeDay (live vs paper) | §5 |
| 29 | tradeDate passed to writeDay is the asOf | §5 |

Migration test — out of scope (DDL idempotency tested by re-running the
existing migrations).

---

## 9. CONFIG_VERSION coupling

The same `CONFIG_VERSION` constant that the stage state + drawdown state
writes use is passed to `KillCriteriaDailyRepository.writeDay`. A future
ADR-040 that changes a kill threshold OR adds a new criterion code MUST:

1. Bump `CONFIG_VERSION` in the SHARED location (currently
   `src/server/capital_deployment_config.ts`).
2. Update `paper_trading_kill_criteria.ts` evaluator(s).
3. Update SPEC §3's `code` LowCardinality vocabulary docs if codes change
   (no schema change needed — LowCardinality dictionary grows).
4. Leave historical rows intact; new rows are tagged with the new version.
   The streak walker treats verdict values uniformly regardless of
   version; an operator inspecting history can re-construct which version
   gave which verdict from the `config_version` column.

---

## 10. Watch-outs (encoded in `What could break this` of new files)

- **Cross-source mixing.** Same as drawdown + stage. Caller MUST pass
  matching `source` on write and read. Repository does not re-filter.
- **`tradeDate` MUST be the asOf, not "today's wall clock."** The stage
  machine's window-of-30-days is anchored to the daemon-run-start clock
  (`asOf`); the daemon CALLER passes this. Internal `new Date()` reads
  would race the daemon's run-start clock and produce off-by-one errors at
  UTC-midnight boundaries.
- **Write-then-read ordering inside the orchestrator.** The honest fix
  REQUIRES write before read. A future refactor that reads first then
  writes today's row would give a streak count off by one (today missing).
- **ReplacingMergeTree merge timing.** `FINAL` reads return the most recent
  `evaluated_at` row pre-merge. Without `FINAL` we'd see all rows including
  superseded ones. SQL MUST use `FROM table FINAL`. Mirrors all other
  `*_history` reads in this codebase.
- **Missing-day = breaks-streak.** Documented. The streak gate is the
  consumer; the repository's empty-array-for-missing contract is the
  honest reading. Backfilling history pre-deployment is intentionally not
  in this slice.
- **First 9 days post-deployment cannot promote.** The streak cannot
  reach 10 until 10 daemon runs have written rows. This is correct under
  ADR-039 §5 ("≥10 consecutive A1-A5 pass days"). The operator should
  understand this BEFORE running `migrate:kill-criteria-daily:apply` —
  applying the migration mid-stage-evaluation would reset any apparent
  streak the legacy rolling-asOf path was reporting. Document in HANDOFF.
- **`evaluated_at` clock skew.** Two daemon retries within the same ms
  produce identical `evaluated_at` values; ReplacingMergeTree dedupes
  arbitrarily. This is acceptable because the verdicts SHOULD be identical
  in a same-ms retry (same closedTrades + same paperState snapshot).
- **`safeFloat(NaN) === 0` is ambiguous on read** — was the measured
  value `0` or "undefined"? Reads should prefer the `verdict` +
  `insufficient_reason` columns for "did the criterion fire" semantics;
  `measured_value` is supplementary, matches stage_state_repository.ts
  precedent.

---

## 11. Done criteria

1. `quantlab.kill_criteria_daily` DDL written + dry-run + applied passes
   roundtrip (operator runs `npm run migrate:kill-criteria-daily:apply`).
2. `KillCriteriaDailyRepository.writeDay` + `loadTrailing30` round-trip
   green under the fake-CH tests (§8 #1-17).
3. `killCriteriaDailyTableExists` graceful-degrade green (§8 #18-20).
4. `runDaemonStageStateEvaluation` integration tests green for both
   paths (§8 #21-29) + zero regression in pre-existing tests.
5. `npm test` net delta ≥ +29 tests, zero net regressions.
6. tsc baseline unchanged from session 56's 14 errors.
7. Critic agent runs at component-done; HIGH + MEDIUM addressed in
   session; LOWs documented + tracked or deferred with rationale.
8. HANDOFF rewritten.

---

## 12. Files touched

NEW:
- `docs/specs/kill-criteria-daily-history.md` (this file)
- `src/server/kill_criteria_daily_repository.ts`
- `scripts/migrate_kill_criteria_daily.ts`
- `scripts/tests/killCriteriaDailyRepository.test.ts`

MODIFIED:
- `package.json` — `migrate:kill-criteria-daily` + `:apply` scripts.
- `src/server/daemon_live_trades.ts` — `runDaemonStageStateEvaluation`
  accepts optional `killCriteriaDailyRepo`; write-then-read path; legacy
  fallback retained.
- `scripts/daily_signal_daemon.ts` — bootstrap probe + repo construction
  + pass through to `runDaemonStageStateEvaluation`.
- `scripts/tests/daemonStageState.test.ts` — +9 tests for both paths.
- `.claude/HANDOFF.md` — session-57 rewrite.

OUT-OF-SCOPE (NOT touched):
- `src/server/stage_state.ts` — pure evaluator contract unchanged.
- `src/server/paper_trading_kill_criteria.ts` — evaluator logic unchanged.
- `src/server/operator_brief*.ts` — brief consumes `consecutiveA1A5PassDays`
  from the stage row; no surface change.
- `scripts/_paper_trading_review.ts` — CLI byte-equal regression preserved.

---

## 13. Critic round-table addendum (post-spec)

To be filled in after the component-done critic runs. Expected concerns
(self-anticipated):

- **Backfill omission** — should we offer an operator-gated one-shot
  backfill from `live_trades` + a stored `paperState` snapshot? Counter:
  the legacy rolling-asOf path is the well-defined first-cut behavior;
  applying the migration with "no backfill" is the CORRECT behavior under
  the §5 honest reading. Operators promoting paper→stage1 should accept
  the 10-day post-migration ramp.
- **`paperState` snapshot dependency** — verdicts persisted today depend
  on TODAY's `paperState` (B1 in particular). The persisted rows are
  STILL today's snapshot of B1. The honest fix's improvement is over the
  rolling-asOf path: yesterday's B1 verdict reflects yesterday's actual
  daemon run, not today's snapshot. So `paperState`-time-dependence is
  bounded to the actual daemon-run day, which IS the honest semantic.
- **Operator confusion at migration apply** — see §10 "First 9 days
  post-deployment cannot promote." Mitigated by HANDOFF doc + warning
  log.
- **No new operator CLI** — there is no need for a `kill-criteria-daily`
  CLI; the daemon writes during its normal run, and operator audits go
  through CH SQL directly. SPEC pins NO CLI surface in this slice.
