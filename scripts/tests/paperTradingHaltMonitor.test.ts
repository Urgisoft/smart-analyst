/**
 * Unit tests for paper_trading_halt_monitor.ts.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §3C ("Kill-switch
 *       monitor"), §7 (fail-closed semantics), §9 step 6 (post-run hook).
 *
 * Pure-function and stub-IO tests; no filesystem writes (writer is injected).
 * The default fs writer is exercised by the daemon integration slice, not here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HALT_SENTINEL_PATH,
  evaluateHaltDecision,
  formatSentinel,
  runHaltMonitor,
  type HaltSentinelWriter,
} from '../../src/server/paper_trading_halt_monitor.js';
import type { KillCriterionVerdict } from '../../src/server/paper_trading_kill_criteria.js';

function passVerdict(code: KillCriterionVerdict['code'], label = 'pass label'): KillCriterionVerdict {
  return { code, label, verdict: 'pass', rationale: 'all good' };
}

function failVerdict(
  code: KillCriterionVerdict['code'],
  label: string,
  rationale: string,
  measuredValue?: number,
  threshold?: number,
): KillCriterionVerdict {
  return { code, label, verdict: 'fail', rationale, measuredValue, threshold };
}

function insufficientVerdict(
  code: KillCriterionVerdict['code'],
  label = 'insufficient label',
): KillCriterionVerdict {
  return {
    code,
    label,
    verdict: 'insufficient_data',
    rationale: 'need more data',
    insufficientReason: 'fixture',
  };
}

/** Recording stub writer — captures writes for assertion. */
class RecordingWriter implements HaltSentinelWriter {
  public calls: { path: string; content: string }[] = [];
  async write(path: string, content: string): Promise<void> {
    this.calls.push({ path, content });
  }
}

/** Throwing stub writer — simulates fs errors. */
class ThrowingWriter implements HaltSentinelWriter {
  constructor(private readonly err: Error) {}
  async write(_path: string, _content: string): Promise<void> {
    throw this.err;
  }
}

const FIXED_NOW = new Date('2026-05-16T21:30:00.000Z');
const fixedNow = (): Date => FIXED_NOW;

describe('evaluateHaltDecision', () => {
  it('returns OK on empty verdict array', () => {
    const d = evaluateHaltDecision([]);
    assert.equal(d.status, 'OK');
    assert.deepEqual(d.triggeredCriteria, []);
    assert.equal(d.diagnostic, 'no kill criteria triggered');
  });

  it('returns OK when every verdict is pass', () => {
    const d = evaluateHaltDecision([
      passVerdict('B1'),
      passVerdict('A2'),
      passVerdict('C1'),
    ]);
    assert.equal(d.status, 'OK');
    assert.deepEqual(d.triggeredCriteria, []);
  });

  it("returns OK when every verdict is insufficient_data (NOT a halt)", () => {
    const d = evaluateHaltDecision([
      insufficientVerdict('A4'),
      insufficientVerdict('A5'),
    ]);
    assert.equal(d.status, 'OK', 'insufficient_data must not trigger halt — A4/A5 emit this for the first ~30d');
    assert.deepEqual(d.triggeredCriteria, []);
  });

  it('returns HALT with single fail code', () => {
    const d = evaluateHaltDecision([
      passVerdict('B1'),
      failVerdict('A2', 'worst trade < -64.37%', 'worst trade XYZ -68.21% breached -64.37% (n=12)'),
      passVerdict('C1'),
    ]);
    assert.equal(d.status, 'HALT');
    assert.deepEqual(d.triggeredCriteria, ['A2']);
    assert.match(d.diagnostic, /\[A2\] worst trade < -64\.37%/);
    assert.match(d.diagnostic, /worst trade XYZ -68\.21% breached -64\.37% \(n=12\)/);
  });

  it('returns HALT with multiple fail codes in input order', () => {
    const d = evaluateHaltDecision([
      passVerdict('B1'),
      failVerdict('A2', 'worst trade < -64.37%', 'r-A2'),
      failVerdict('A3', 'portfolio max DD > -27.29%', 'r-A3'),
      insufficientVerdict('A4'),
      passVerdict('A5'),
      passVerdict('C1'),
      failVerdict('C3', 'daemon errored on persist', 'r-C3'),
    ]);
    assert.equal(d.status, 'HALT');
    assert.deepEqual(d.triggeredCriteria, ['A2', 'A3', 'C3'],
      'triggered codes preserve input order (stable B1/A2/A3/A4/A5/C1/C3 from evaluateKillCriteria)');
    // Diagnostic includes every fail block separated by blank line.
    const blocks = d.diagnostic.split('\n\n');
    assert.equal(blocks.length, 3, 'one block per fail, separated by blank lines');
    assert.match(blocks[0], /\[A2\]/);
    assert.match(blocks[1], /\[A3\]/);
    assert.match(blocks[2], /\[C3\]/);
  });

  it('mix of pass + fail + insufficient_data → HALT with only fail codes', () => {
    const d = evaluateHaltDecision([
      passVerdict('B1'),
      passVerdict('A2'),
      failVerdict('A3', 'portfolio max DD > -27.29%', 'breach'),
      insufficientVerdict('A4'),
      insufficientVerdict('A5'),
      passVerdict('C1'),
      passVerdict('C3'),
    ]);
    assert.equal(d.status, 'HALT');
    assert.deepEqual(d.triggeredCriteria, ['A3']);
  });
});

describe('formatSentinel', () => {
  it('renders the canonical operator-facing layout with runId', () => {
    const decision = evaluateHaltDecision([
      failVerdict('A2', 'worst trade < -64.37%', 'worst trade XYZ -68.21% breached -64.37% (n=12)'),
    ]);
    const content = formatSentinel({
      decision,
      runId: 'abc-123',
      generatedAt: FIXED_NOW,
      sentinelPath: '.daemon_halt',
    });
    // Field labels are a contract surface — pin exact strings.
    assert.match(content, /^SignalForge daemon halt sentinel$/m);
    assert.match(content, /^={32}$/m);
    assert.match(content, /^Generated     : 2026-05-16T21:30:00\.000Z$/m);
    assert.match(content, /^Run ID        : abc-123$/m);
    assert.match(content, /^Triggered     : A2$/m);
    assert.match(content, /\[A2\] worst trade < -64\.37%/);
    assert.match(content, /Delete this file \(\.daemon_halt\) once the decision is recorded/);
  });

  it("renders Run ID as 'n/a' when runId is undefined", () => {
    const decision = evaluateHaltDecision([
      failVerdict('A3', 'portfolio max DD > -27.29%', 'r'),
    ]);
    const content = formatSentinel({
      decision,
      runId: undefined,
      generatedAt: FIXED_NOW,
      sentinelPath: '.daemon_halt',
    });
    assert.match(content, /^Run ID        : n\/a$/m);
  });

  it('renders Triggered as comma-separated codes preserving order', () => {
    const decision = evaluateHaltDecision([
      failVerdict('A2', 'l-A2', 'r'),
      failVerdict('A3', 'l-A3', 'r'),
      failVerdict('C3', 'l-C3', 'r'),
    ]);
    const content = formatSentinel({
      decision,
      runId: 'r1',
      generatedAt: FIXED_NOW,
      sentinelPath: '.daemon_halt',
    });
    assert.match(content, /^Triggered     : A2, A3, C3$/m);
  });

  it('embeds custom sentinel path in the resume instructions', () => {
    const decision = evaluateHaltDecision([
      failVerdict('A2', 'l', 'r'),
    ]);
    const content = formatSentinel({
      decision,
      runId: 'r1',
      generatedAt: FIXED_NOW,
      sentinelPath: '/tmp/custom_halt',
    });
    assert.match(content, /Delete this file \(\/tmp\/custom_halt\) once/);
  });
});

describe('runHaltMonitor', () => {
  it('OK decision + enforce=true → does not write sentinel', async () => {
    const writer = new RecordingWriter();
    const result = await runHaltMonitor({
      verdicts: [passVerdict('B1'), passVerdict('A2')],
      writer,
      now: fixedNow,
      enforce: true,
    });
    assert.equal(result.decision.status, 'OK');
    assert.equal(result.sentinelWritten, false);
    assert.equal(result.sentinelContent, null);
    assert.equal(writer.calls.length, 0, 'OK decision must never write the sentinel');
  });

  it('HALT decision + enforce=true → writes sentinel with expected content', async () => {
    const writer = new RecordingWriter();
    const result = await runHaltMonitor({
      verdicts: [
        passVerdict('B1'),
        failVerdict('A2', 'worst trade < -64.37%', 'worst trade XYZ -68.21% breached -64.37% (n=12)'),
      ],
      runId: 'run-007',
      writer,
      now: fixedNow,
      enforce: true,
    });
    assert.equal(result.decision.status, 'HALT');
    assert.deepEqual(result.decision.triggeredCriteria, ['A2']);
    assert.equal(result.sentinelWritten, true);
    assert.equal(result.sentinelPath, DEFAULT_HALT_SENTINEL_PATH);
    assert.equal(writer.calls.length, 1);
    assert.equal(writer.calls[0].path, DEFAULT_HALT_SENTINEL_PATH);
    assert.equal(writer.calls[0].content, result.sentinelContent);
    // Verify content matches what formatSentinel would produce.
    const expected = formatSentinel({
      decision: result.decision,
      runId: 'run-007',
      generatedAt: FIXED_NOW,
      sentinelPath: DEFAULT_HALT_SENTINEL_PATH,
    });
    assert.equal(writer.calls[0].content, expected);
  });

  it('HALT decision + enforce=false → does NOT write but returns populated content (observe mode)', async () => {
    const writer = new RecordingWriter();
    const result = await runHaltMonitor({
      verdicts: [
        failVerdict('A3', 'portfolio max DD > -27.29%', 'max DD -31.45% breached -27.29% (n=42)'),
      ],
      runId: 'run-007',
      writer,
      now: fixedNow,
      enforce: false,
    });
    assert.equal(result.decision.status, 'HALT');
    assert.equal(result.sentinelWritten, false, 'observe mode must not write');
    assert.notEqual(result.sentinelContent, null,
      'observe mode must still surface would-be content so the caller can log it');
    assert.match(result.sentinelContent!, /\[A3\] portfolio max DD > -27\.29%/);
    assert.equal(writer.calls.length, 0);
  });

  it('writer throw propagates (fail-loud)', async () => {
    const writer = new ThrowingWriter(new Error('EACCES: permission denied'));
    await assert.rejects(
      runHaltMonitor({
        verdicts: [failVerdict('A2', 'worst trade < -64.37%', 'r')],
        runId: 'run-007',
        writer,
        now: fixedNow,
        enforce: true,
      }),
      /EACCES: permission denied/,
    );
  });

  it('defaults: enforce=true when omitted (production posture is enforce-on)', async () => {
    // Pin the default. A future change that flips enforce default to false
    // would silently disable the kill-switch for every caller that omits
    // the flag — this test catches that regression.
    const writer = new RecordingWriter();
    const result = await runHaltMonitor({
      verdicts: [failVerdict('A2', 'l', 'r')],
      writer,
      now: fixedNow,
      // enforce omitted on purpose
    });
    assert.equal(result.sentinelWritten, true, 'default enforce MUST be true');
    assert.equal(writer.calls.length, 1);
  });

  it('honours a custom sentinelPath', async () => {
    const writer = new RecordingWriter();
    const result = await runHaltMonitor({
      verdicts: [failVerdict('A2', 'l', 'r')],
      writer,
      now: fixedNow,
      enforce: true,
      sentinelPath: '/tmp/custom_halt_path',
    });
    assert.equal(result.sentinelPath, '/tmp/custom_halt_path');
    assert.equal(writer.calls[0].path, '/tmp/custom_halt_path');
    assert.match(writer.calls[0].content, /Delete this file \(\/tmp\/custom_halt_path\) once/);
  });

  it('absent runId renders as n/a in the persisted content', async () => {
    const writer = new RecordingWriter();
    const result = await runHaltMonitor({
      verdicts: [failVerdict('A2', 'l', 'r')],
      writer,
      now: fixedNow,
      enforce: true,
      // runId omitted
    });
    assert.match(result.sentinelContent!, /^Run ID        : n\/a$/m);
    assert.equal(writer.calls[0].content, result.sentinelContent);
  });

  it('default sentinel path constant equals .daemon_halt (SPEC §5)', () => {
    assert.equal(DEFAULT_HALT_SENTINEL_PATH, '.daemon_halt');
  });
});
