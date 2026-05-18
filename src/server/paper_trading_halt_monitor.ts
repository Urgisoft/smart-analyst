/**
 * §9 step 6 — kill-switch monitor.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §3C ("Kill-switch
 *       monitor"), §7 (fail-closed semantics), §9 step 6 (post-run hook,
 *       initially disabled while the operator validates trigger behaviour
 *       against real data).
 *
 * Consumes the `KillCriterionVerdict[]` produced by
 * paper_trading_kill_criteria.evaluateKillCriteria and:
 *   1. Reduces it to a single OK / HALT decision.
 *   2. When HALT and {@link RunHaltMonitorInputs.enforce} is true, writes a
 *      filesystem sentinel (`.daemon_halt` by default) that the daemon's
 *      pre-flight check (§9 step 7) reads at startup to refuse to run.
 *
 * Design rules:
 *   - **Decision logic is pure.** {@link evaluateHaltDecision} takes verdicts
 *     and returns the decision without touching the filesystem. The IO
 *     orchestrator wraps it.
 *   - **`insufficient_data` is never a halt.** It is the pre-data state for
 *     A4/A5 before the ledger has 30d of history. Treating it as HALT would
 *     prevent the daemon from ever running on a fresh deployment.
 *   - **Triggered codes ordered as the input verdict array.** The evaluator
 *     emits codes in the stable order B1/A2/A3/A4/A5/C1/C3 (see
 *     paper_trading_kill_criteria.evaluateKillCriteria); preserving order
 *     means operator scripts grepping the sentinel see codes in the same
 *     order they see them in the morning brief.
 *   - **Fail-loud on writer errors.** A failed sentinel write means the next
 *     daemon run would NOT see the halt — silently swallowing the error
 *     would defeat the kill-switch. The orchestrator throws; the daemon's
 *     end-of-run hook (a separate slice) is responsible for catching, marking
 *     the daemon_run as failed, and alerting the operator.
 *   - **Observe-only mode.** Per SPEC §9 step 6 "Initially DISABLED in config
 *     (monitor runs but doesn't halt) for one week, to validate the trigger
 *     logic against real data without blocking the shakedown." Pass
 *     `enforce: false` to run the decision logic and return the sentinel
 *     content WITHOUT writing it. The caller logs the decision; when the
 *     operator is confident in the trigger behaviour, flip to
 *     `enforce: true` for the one-line activation.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { KillCriterionVerdict } from './paper_trading_kill_criteria.js';

/**
 * Default filesystem path for the halt sentinel. SPEC §5 specifies "a simple
 * `.daemon_halt` file in the project root." Daemon pre-flight (§9 step 7,
 * separate slice) reads from the same path.
 */
export const DEFAULT_HALT_SENTINEL_PATH = '.daemon_halt';

/** Reduced decision computed from the verdict array. Pure. */
export interface HaltDecision {
  status: 'OK' | 'HALT';
  /**
   * Codes of criteria whose verdict was 'fail', in the order they appeared
   * in the input array. Empty when status === 'OK'.
   */
  triggeredCriteria: KillCriterionVerdict['code'][];
  /**
   * Human-readable summary. For OK: "no kill criteria triggered". For HALT:
   * a list of `[CODE] label\n  rationale` blocks. Embedded verbatim in the
   * sentinel content (see {@link formatSentinel}).
   */
  diagnostic: string;
}

/** Writer abstraction so tests can stub the filesystem. */
export interface HaltSentinelWriter {
  /** Write `content` to `path`, overwriting any existing file. */
  write(path: string, content: string): Promise<void>;
}

/**
 * Default writer using node:fs/promises.writeFile. Overwrites on collision —
 * if the sentinel already exists (e.g. a manually-placed halt), the latest
 * monitor output wins. In normal operation this never collides because the
 * daemon's pre-flight check (§9 step 7) refuses to start when a sentinel
 * exists, so the monitor (which runs at end of daemon) cannot fire on a
 * run that already had the sentinel present.
 */
export const defaultHaltSentinelWriter: HaltSentinelWriter = {
  async write(path: string, content: string): Promise<void> {
    await writeFile(path, content, { encoding: 'utf8' });
  },
};

/**
 * Reader abstraction symmetric with {@link HaltSentinelWriter}. Used by the
 * daemon's §9 step 7 pre-flight check to detect a pre-existing halt sentinel
 * before any other startup work.
 *
 * Contract:
 *   - Returns the file content as a UTF-8 string when the sentinel exists.
 *   - Returns `null` when the sentinel does NOT exist (ENOENT). The ENOENT
 *     case is the common path — most daemon runs have no sentinel.
 *   - Throws on any OTHER I/O error (permissions, EIO, etc). The pre-flight
 *     caller is fail-closed by design: if it cannot determine the sentinel
 *     state, the daemon should refuse to run rather than risk running through
 *     a halt it could not read.
 */
export interface HaltSentinelReader {
  read(path: string): Promise<string | null>;
}

/**
 * Default reader using node:fs/promises.readFile. ENOENT collapses to `null`;
 * everything else propagates. Daemon pre-flight wraps the call in try/catch
 * and treats any thrown error as fail-closed (SPEC §7).
 */
export const defaultHaltSentinelReader: HaltSentinelReader = {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, { encoding: 'utf8' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
};

export interface RunHaltMonitorInputs {
  /** Output of {@link evaluateKillCriteria}. */
  verdicts: KillCriterionVerdict[];
  /**
   * Audit context — UUID of the daemon run whose verdicts these are. Recorded
   * in the sentinel content so the operator can correlate to daemon_runs and
   * stdout logs. Optional; rendered as 'n/a' when absent.
   */
  runId?: string;
  /**
   * Override the sentinel path. Tests inject per-test temp paths; daemon
   * defaults to {@link DEFAULT_HALT_SENTINEL_PATH}.
   */
  sentinelPath?: string;
  /**
   * Override the writer. Tests inject a stub recording writes; daemon uses
   * {@link defaultHaltSentinelWriter}.
   */
  writer?: HaltSentinelWriter;
  /**
   * Override the clock. Sentinel content includes a generated-at timestamp
   * which would otherwise be non-deterministic in tests.
   */
  now?: () => Date;
  /**
   * SPEC §9 step 6 "initially DISABLED" knob. When false, the monitor
   * computes the decision and returns it but does NOT write the sentinel,
   * even on HALT. The returned `sentinelContent` is still populated so the
   * caller can log what would have been written. Default: true.
   */
  enforce?: boolean;
}

export interface RunHaltMonitorResult {
  decision: HaltDecision;
  /** True iff the writer was invoked. False when status === 'OK' or enforce === false. */
  sentinelWritten: boolean;
  /** Path the sentinel was (or would have been) written to. */
  sentinelPath: string;
  /**
   * Sentinel content. Populated whenever decision.status === 'HALT' (regardless
   * of enforce), null when status === 'OK'. The observe-mode caller logs this
   * to surface the would-be halt without writing the file.
   */
  sentinelContent: string | null;
}

/**
 * Reduce the verdict array to an OK/HALT decision.
 *
 * Rules:
 *   - Any `verdict === 'fail'` → HALT, codes preserved in input order.
 *   - All `verdict === 'pass'` or `'insufficient_data'` → OK.
 *   - Empty input → OK (nothing to halt on).
 *
 * `insufficient_data` is never a halt — A4/A5 return it for the first ~30
 * days of a fresh ledger; halting on it would prevent the system from ever
 * running on a new deployment.
 */
export function evaluateHaltDecision(verdicts: KillCriterionVerdict[]): HaltDecision {
  const fails = verdicts.filter(v => v.verdict === 'fail');
  if (fails.length === 0) {
    return {
      status: 'OK',
      triggeredCriteria: [],
      diagnostic: 'no kill criteria triggered',
    };
  }
  const triggeredCriteria = fails.map(v => v.code);
  const diagnostic = fails
    .map(v => `[${v.code}] ${v.label}\n  ${v.rationale}`)
    .join('\n\n');
  return {
    status: 'HALT',
    triggeredCriteria,
    diagnostic,
  };
}

/**
 * Format the sentinel file content. Pure; exported for tests.
 *
 * Format is operator-facing and stable — downstream tooling may grep
 * "Triggered     :" or "[A2]" markers. Keep field labels exact.
 */
export function formatSentinel(args: {
  decision: HaltDecision;
  runId: string | undefined;
  generatedAt: Date;
  sentinelPath: string;
}): string {
  const { decision, runId, generatedAt, sentinelPath } = args;
  const triggeredList = decision.triggeredCriteria.join(', ');
  return [
    'SignalForge daemon halt sentinel',
    '================================',
    '',
    `Generated     : ${generatedAt.toISOString()}`,
    `Run ID        : ${runId ?? 'n/a'}`,
    `Triggered     : ${triggeredList}`,
    '',
    decision.diagnostic,
    '',
    'To resume the daemon:',
    '  1. Triage the trigger (see HANDOFF "Halt protocol")',
    '  2. Decide fix-and-resume / accept / reject',
    `  3. Delete this file (${sentinelPath}) once the decision is recorded`,
    '',
  ].join('\n');
}

/**
 * Compute the halt decision and (when `enforce` is true and status is HALT)
 * write the sentinel file.
 *
 * Fail-loud — if the writer throws, the exception propagates. The daemon's
 * end-of-run hook (separate slice) is responsible for treating that as a
 * fail-closed condition (mark the daemon_run as failed, exit 1, alert the
 * operator). Silently swallowing the write error would defeat the kill-
 * switch on the very next daemon run.
 */
export async function runHaltMonitor(
  inputs: RunHaltMonitorInputs,
): Promise<RunHaltMonitorResult> {
  const decision = evaluateHaltDecision(inputs.verdicts);
  const sentinelPath = inputs.sentinelPath ?? DEFAULT_HALT_SENTINEL_PATH;
  const writer = inputs.writer ?? defaultHaltSentinelWriter;
  const now = inputs.now ?? (() => new Date());
  const enforce = inputs.enforce ?? true;

  if (decision.status === 'OK') {
    return {
      decision,
      sentinelWritten: false,
      sentinelPath,
      sentinelContent: null,
    };
  }

  const sentinelContent = formatSentinel({
    decision,
    runId: inputs.runId,
    generatedAt: now(),
    sentinelPath,
  });

  if (!enforce) {
    return {
      decision,
      sentinelWritten: false,
      sentinelPath,
      sentinelContent,
    };
  }

  await writer.write(sentinelPath, sentinelContent);

  return {
    decision,
    sentinelWritten: true,
    sentinelPath,
    sentinelContent,
  };
}

/**
 * What could break this:
 *  - `evaluateHaltDecision` treats `insufficient_data` as non-halt. A future
 *    criterion whose `insufficient_data` should halt (e.g. "ledger missing
 *    after deployment day X") would need its own path here — do NOT widen
 *    the predicate to include `insufficient_data`, which would break A4/A5
 *    on every fresh deployment.
 *  - Ordering of `triggeredCriteria`. Preserved as input order, which is
 *    the stable B1/A2/A3/A4/A5/C1/C3 order from
 *    paper_trading_kill_criteria.evaluateKillCriteria. If a future PR
 *    reorders that array, sentinel grep patterns over "Triggered     : A2"
 *    style ordering may shift.
 *  - Sentinel content field labels ("Generated     :", "Run ID        :",
 *    "Triggered     :"). These ARE a contract surface — operator scripts
 *    may grep them. Change deliberately, not as part of an unrelated cleanup.
 *  - Default writer uses `node:fs/promises.writeFile` which is non-atomic.
 *    A crash mid-write would leave a truncated sentinel. Acceptable: a
 *    truncated sentinel still EXISTS, the daemon's pre-flight check
 *    (§9 step 7) checks existence, not content validity. Operator reading
 *    the truncated file may need to re-run the monitor to get the full
 *    diagnostic.
 *  - `enforce: false` is the post-deployment shadow mode (SPEC §9 step 6).
 *    Forgetting to flip `enforce: true` after the validation window means
 *    the kill-switch is permanently disabled. The daemon's call site is
 *    responsible for logging the enforcement mode every run so the operator
 *    notices a stuck-shadow condition.
 *  - The writer is invoked AFTER the formatSentinel call (which is pure).
 *    No transactional rollback if the write half-succeeds; the file system
 *    is the source of truth.
 */
