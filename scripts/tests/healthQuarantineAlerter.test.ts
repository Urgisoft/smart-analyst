/**
 * Tests for src/server/health_quarantine_alerter.ts — Cycle 3 Worker C,
 * ADR-044 Phase 2 v1 Telegram alerter.
 *
 * Contract pinned here:
 *   - formatQuarantineAlertHtml: byte-equal pin against a synthetic full
 *     row + empty-ref row + truncation row + HTML-escape row.
 *   - truncateForAlert: truncation + ellipsis + boundary semantics.
 *   - sendQuarantineAlerts: anomaly contract per ADR-044 §infrastructure-4
 *     for every documented branch (unconfigured, 0 unalerted, 1 unalerted,
 *     cap-hit, per-row send failure, table-absent, loader-throw).
 *   - Never-throws: stub loader / recorder / telegram to throw; the runner
 *     returns structured results with errorCount and a warning anomaly.
 *
 * No CH dependency — stubs only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INCLUDE_STATUSES,
  DEFAULT_MAX_ALERTS_PER_RUN,
  EXPLANATION_MAX_CHARS,
  OFFENDING_VALUE_MAX_CHARS,
  OPERATOR_ACTION_MAX_CHARS,
  formatQuarantineAlertHtml,
  sendQuarantineAlerts,
  truncateForAlert,
  type AlertRecorder,
  type AlertRunResult,
  type QuarantineLoader,
  type TelegramLike,
} from '../../src/server/health_quarantine_alerter.js';
import type { QuarantineRow } from '../../src/server/health_quarantine.js';

// ── Test helpers ────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<QuarantineRow> = {}): QuarantineRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    detectedAt: '2026-05-23T00:00:00.000Z',
    version: '2026-05-23T00:00:00.000Z',
    kind: 'tier2-quarantine',
    sourceTable: 'macro_indicators_cboe',
    sourceLabel: 'CBOE put/call ratio',
    severity: 'warning',
    category: 'corrupted-input-window',
    offendingValue: 'CBOE input stale since 2019-10-04',
    expectedRange: 'daily refresh; <30h staleness',
    explanation: 'phase1_v3 corrupted-input window per ADR-045.',
    operatorAction: 'Pick ADR-045 path A/B/C/D.',
    status: 'accepted-as-warning',
    resolvedAt: null,
    resolvedBy: '',
    resolutionNote: '',
    cycleRef: 's96 #15 Cycle 1',
    adrRef: 'ADR-045',
    ...overrides,
  };
}

interface SendCall { text: string }
function stubTelegram(opts: {
  configured?: boolean;
  send?: (text: string) => Promise<boolean>;
} = {}): { tg: TelegramLike; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const tg: TelegramLike = {
    isConfigured: () => opts.configured ?? true,
    send: opts.send
      ? opts.send
      : (text: string) => { calls.push({ text }); return Promise.resolve(true); },
  };
  return { tg, calls };
}

interface LoaderCall { includeStatuses: readonly string[] }
function stubLoader(rows: QuarantineRow[]): {
  loader: QuarantineLoader;
  calls: LoaderCall[];
} {
  const calls: LoaderCall[] = [];
  const loader: QuarantineLoader = async (opts) => {
    calls.push({ includeStatuses: [...opts.includeStatuses] });
    return rows;
  };
  return { loader, calls };
}

interface RecordCall { id: string; chatId: string; message: string }
function stubRecorder(opts: { throwOn?: (args: RecordCall) => boolean } = {}): {
  recorder: AlertRecorder;
  calls: RecordCall[];
} {
  const calls: RecordCall[] = [];
  const recorder: AlertRecorder = async ({ id, chatId, message }) => {
    const call = { id, chatId, message };
    calls.push(call);
    if (opts.throwOn && opts.throwOn(call)) {
      throw new Error('synthetic-record-fail');
    }
  };
  return { recorder, calls };
}

// ── truncateForAlert ────────────────────────────────────────────────────────

describe('truncateForAlert', () => {
  it('returns the input unchanged when within the cap', () => {
    assert.equal(truncateForAlert('short', 10), 'short');
  });
  it('returns the input unchanged at the exact cap', () => {
    assert.equal(truncateForAlert('exact-len', 9), 'exact-len');
  });
  it('appends a single ellipsis when over the cap', () => {
    // 11 chars input, cap 5 → keeps 4 + '…' = 5 total
    const out = truncateForAlert('hello-world', 5);
    assert.equal(out, 'hell…');
    assert.equal(out.length, 5);
  });
  it('handles cap=1 gracefully (single ellipsis)', () => {
    assert.equal(truncateForAlert('many', 1), '…');
  });
});

// ── formatQuarantineAlertHtml — byte-equal pins ─────────────────────────────

describe('formatQuarantineAlertHtml', () => {
  it('renders the full message shape for a typical row (byte-equal pin)', () => {
    const row = makeRow();
    const out = formatQuarantineAlertHtml(row);
    const expected =
      '\u{1F6A8} <b>[SignalForge]</b> Tier-2 health quarantine\n' +
      '\n' +
      '<b>Source:</b> CBOE put/call ratio (macro_indicators_cboe)\n' +
      '<b>Category:</b> corrupted-input-window\n' +
      '<b>Severity:</b> warning\n' +
      '<b>Status:</b> accepted-as-warning\n' +
      '\n' +
      '<b>What:</b>\n' +
      '<i>CBOE input stale since 2019-10-04</i>\n' +
      '\n' +
      '<b>Why:</b>\n' +
      '<i>phase1_v3 corrupted-input window per ADR-045.</i>\n' +
      '\n' +
      '<b>Operator action:</b>\n' +
      'Pick ADR-045 path A/B/C/D.\n' +
      '\n' +
      '<b>Refs:</b> ADR-045 · s96 #15 Cycle 1\n' +
      '<b>Quarantine ID:</b> <code>11111111-1111-4111-8111-111111111111</code>\n' +
      '<b>UI:</b> http://localhost:3000/#/health';
    assert.equal(out, expected);
  });

  it('renders em-dash for missing ref fields', () => {
    const row = makeRow({ adrRef: '', cycleRef: '' });
    const out = formatQuarantineAlertHtml(row);
    assert.match(out, /<b>Refs:<\/b> — · —/);
  });

  it('truncates offendingValue with ellipsis at OFFENDING_VALUE_MAX_CHARS', () => {
    const big = 'X'.repeat(OFFENDING_VALUE_MAX_CHARS + 50);
    const row = makeRow({ offendingValue: big });
    const out = formatQuarantineAlertHtml(row);
    // The italic <i>...</i> block must contain a truncated version + ellipsis.
    const match = out.match(/<b>What:<\/b>\n<i>([\s\S]+?)<\/i>/);
    assert.ok(match, 'What field missing');
    const captured = match![1];
    assert.equal(captured.length, OFFENDING_VALUE_MAX_CHARS);
    assert.ok(captured.endsWith('…'), `expected ellipsis suffix, got: ${captured.slice(-5)}`);
  });

  it('truncates explanation at EXPLANATION_MAX_CHARS', () => {
    const big = 'Y'.repeat(EXPLANATION_MAX_CHARS + 200);
    const row = makeRow({ explanation: big });
    const out = formatQuarantineAlertHtml(row);
    const match = out.match(/<b>Why:<\/b>\n<i>([\s\S]+?)<\/i>/);
    assert.ok(match, 'Why field missing');
    const captured = match![1];
    assert.equal(captured.length, EXPLANATION_MAX_CHARS);
    assert.ok(captured.endsWith('…'));
  });

  it('truncates operatorAction at OPERATOR_ACTION_MAX_CHARS', () => {
    const big = 'Z'.repeat(OPERATOR_ACTION_MAX_CHARS + 100);
    const row = makeRow({ operatorAction: big });
    const out = formatQuarantineAlertHtml(row);
    // operatorAction is not wrapped in <i> (per orchestrator spec).
    const match = out.match(
      /<b>Operator action:<\/b>\n([\s\S]+?)\n\n<b>Refs:<\/b>/,
    );
    assert.ok(match, 'Operator-action field missing');
    const captured = match![1];
    assert.equal(captured.length, OPERATOR_ACTION_MAX_CHARS);
    assert.ok(captured.endsWith('…'));
  });

  it('HTML-escapes caller-supplied strings (security-critical)', () => {
    const row = makeRow({
      sourceLabel: '<script>alert(1)</script>',
      offendingValue: '<b>&amp;</b>',
      explanation: '<>&"\'',
    });
    const out = formatQuarantineAlertHtml(row);
    // The raw <script> tag MUST NOT appear in the output.
    assert.equal(out.includes('<script>'), false, 'unescaped <script> leaked into HTML output');
    // Escaped form must appear instead.
    assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // Existing entities re-escape (& → &amp;).
    assert.match(out, /&lt;b&gt;&amp;amp;&lt;\/b&gt;/);
  });

  it('renders source_table and source_label distinctly', () => {
    const row = makeRow({
      sourceTable: 'macro_indicators_cboe',
      sourceLabel: 'CBOE put/call ratio',
    });
    const out = formatQuarantineAlertHtml(row);
    assert.match(out, /<b>Source:<\/b> CBOE put\/call ratio \(macro_indicators_cboe\)/);
  });
});

// ── sendQuarantineAlerts — anomaly contract ─────────────────────────────────

describe('sendQuarantineAlerts', () => {
  it('Telegram unconfigured → info anomaly + zeros (no Telegram send, no CH writes)', async () => {
    const { tg, calls: tgCalls } = stubTelegram({ configured: false });
    // The unconfigured path STILL probes the loader to surface skippedCount —
    // so we supply one (returning 2 rows) to verify the skipped count.
    const { loader } = stubLoader([makeRow({ id: 'a' }), makeRow({ id: 'b' })]);
    const { recorder, calls: recCalls } = stubRecorder();
    const result = await sendQuarantineAlerts({
      telegram: tg,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 0);
    assert.equal(result.errorCount, 0);
    assert.equal(result.skippedCount, 2);
    assert.equal(tgCalls.length, 0, 'Telegram must not be invoked when unconfigured');
    assert.equal(recCalls.length, 0, 'No record-sent writes when unconfigured');
    const found = result.anomalies.find(a =>
      a.severity === 'info' && /Telegram alerter skipped/.test(a.message),
    );
    assert.ok(found, 'expected info anomaly: Telegram alerter skipped');
  });

  it('0 unalerted rows → info anomaly + zeros', async () => {
    const { tg } = stubTelegram();
    const { loader } = stubLoader([]);
    const { recorder } = stubRecorder();
    // Override existence probes via injected loader path; we still need the
    // existence probes to succeed. Use a fake CH that returns table-present.
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 0);
    assert.equal(result.errorCount, 0);
    assert.equal(result.skippedCount, 0);
    assert.ok(
      result.anomalies.find(a =>
        a.severity === 'info' &&
        /0 new Tier-2 rows; nothing to send/.test(a.message),
      ),
      'expected the 0-unalerted info anomaly',
    );
  });

  it('1 unalerted row → sends, records, success info anomaly', async () => {
    const { tg, calls: tgCalls } = stubTelegram();
    const row = makeRow({ id: 'aaaa-1' });
    const { loader } = stubLoader([row]);
    const { recorder, calls: recCalls } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
      chatId: 'test-chat-123',
    });
    assert.equal(result.sentCount, 1);
    assert.equal(result.skippedCount, 0);
    assert.equal(result.errorCount, 0);
    assert.equal(tgCalls.length, 1, 'one Telegram send');
    assert.equal(recCalls.length, 1, 'one record-sent');
    assert.equal(recCalls[0].id, 'aaaa-1');
    assert.equal(recCalls[0].chatId, 'test-chat-123');
    assert.ok(
      result.anomalies.find(a =>
        a.severity === 'info' && /sent 1 new Tier-2 alerts/.test(a.message),
      ),
      'expected success info anomaly',
    );
  });

  it('3 unalerted with maxAlertsPerRun=2 → cap-hit warning + sends 2', async () => {
    const { tg, calls: tgCalls } = stubTelegram();
    const rows = [
      makeRow({ id: 'r1' }),
      makeRow({ id: 'r2' }),
      makeRow({ id: 'r3' }),
    ];
    const { loader } = stubLoader(rows);
    const { recorder, calls: recCalls } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
      maxAlertsPerRun: 2,
    });
    assert.equal(result.sentCount, 2);
    assert.equal(result.skippedCount, 1);
    assert.equal(tgCalls.length, 2);
    assert.equal(recCalls.length, 2);
    assert.deepEqual(recCalls.map(c => c.id), ['r1', 'r2']);
    const capWarn = result.anomalies.find(a =>
      a.severity === 'warning' && /capped at 2/.test(a.message),
    );
    assert.ok(capWarn, 'expected cap-hit warning anomaly');
    assert.match(capWarn!.message, /1 rows remain unalerted/);
  });

  it('per-row Telegram send failure → warning anomaly + errorCount=1; recordSent NOT called for the failure', async () => {
    const row1 = makeRow({ id: 'good-1', sourceLabel: 'X' });
    const row2 = makeRow({ id: 'bad-2', sourceLabel: 'Y' });
    const row3 = makeRow({ id: 'good-3', sourceLabel: 'Z' });
    let callIdx = 0;
    const { tg } = stubTelegram({
      send: () => {
        callIdx++;
        if (callIdx === 2) return Promise.resolve(false);
        return Promise.resolve(true);
      },
    });
    const { loader } = stubLoader([row1, row2, row3]);
    const { recorder, calls: recCalls } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 2);
    assert.equal(result.errorCount, 1);
    // Only the two successful sends are recorded.
    assert.deepEqual(recCalls.map(c => c.id), ['good-1', 'good-3']);
    const fail = result.anomalies.find(a =>
      a.severity === 'warning' && /Quarantine alert failed for row bad-2/.test(a.message),
    );
    assert.ok(fail, 'expected per-row failure warning anomaly');
  });

  it('quarantine table absent → info anomaly + zeros (no Telegram send)', async () => {
    const { tg, calls: tgCalls } = stubTelegram();
    const { loader, calls: loaderCalls } = stubLoader([]);
    const { recorder } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: false, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 0);
    assert.equal(result.errorCount, 0);
    assert.equal(tgCalls.length, 0);
    assert.equal(loaderCalls.length, 0, 'loader must not run when quarantine table absent');
    assert.ok(
      result.anomalies.find(a =>
        a.severity === 'info' && /Quarantine table absent/.test(a.message),
      ),
    );
  });

  it('alerts-sent sidecar absent → info anomaly + zeros', async () => {
    const { tg, calls: tgCalls } = stubTelegram();
    const { loader, calls: loaderCalls } = stubLoader([]);
    const { recorder } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: false });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 0);
    assert.equal(tgCalls.length, 0);
    assert.equal(loaderCalls.length, 0);
    assert.ok(
      result.anomalies.find(a =>
        a.severity === 'info' && /Alerts-sent sidecar absent/.test(a.message),
      ),
    );
  });

  it('loader throws → warning "alerter probe failed" + errorCount=1; never throws', async () => {
    const { tg } = stubTelegram();
    const loader: QuarantineLoader = async () => {
      throw new Error('boom');
    };
    const { recorder } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    // The call must not throw — the test framework would surface that as a
    // failed assertion. Wrap in a try just to make the contract explicit.
    let result: AlertRunResult;
    try {
      result = await sendQuarantineAlerts({
        telegram: tg,
        ch: fakeCh as never,
        loader,
        recorder,
      });
    } catch (err) {
      assert.fail(`sendQuarantineAlerts threw: ${(err as Error).message}`);
    }
    assert.equal(result!.errorCount, 1);
    assert.equal(result!.sentCount, 0);
    const probeWarn = result!.anomalies.find(a =>
      a.severity === 'warning' && /alerter probe failed/.test(a.message),
    );
    assert.ok(probeWarn, 'expected "alerter probe failed" warning anomaly');
    assert.match(probeWarn!.message, /boom/);
  });

  it('telegram.send THROWING is caught → warning anomaly + errorCount=1 (never-throws path)', async () => {
    const { tg } = stubTelegram({
      send: () => { throw new Error('telegram-network-down'); },
    });
    const { loader } = stubLoader([makeRow({ id: 'x' })]);
    const { recorder, calls: recCalls } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 0);
    assert.equal(result.errorCount, 1);
    // The failing row must NOT be recorded — it will retry next cycle.
    assert.equal(recCalls.length, 0);
    const warn = result.anomalies.find(a =>
      a.severity === 'warning' && /Quarantine alert failed for row x/.test(a.message),
    );
    assert.ok(warn);
    assert.match(warn!.message, /telegram-network-down/);
  });

  it('recorder throws after successful send → warning anomaly but sentCount still increments', async () => {
    const { tg } = stubTelegram();
    const { loader } = stubLoader([makeRow({ id: 'rec-fail-1' })]);
    const { recorder } = stubRecorder({ throwOn: () => true });
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    const result = await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(result.sentCount, 1, 'send went through');
    assert.equal(result.errorCount, 0, 'recorder failure is informational, not a send error');
    const warn = result.anomalies.find(a =>
      a.severity === 'warning' &&
      /record-sent failed for row rec-fail-1/.test(a.message),
    );
    assert.ok(warn, 'expected record-sent warning anomaly');
    assert.match(warn!.message, /re-alert next cycle/);
  });

  it('default include statuses pass through to loader (pending + accepted-as-warning)', async () => {
    const { tg } = stubTelegram();
    const { loader, calls } = stubLoader([]);
    const { recorder } = stubRecorder();
    const fakeCh = makeCh({ quarantineExists: true, sidecarExists: true });
    await sendQuarantineAlerts({
      telegram: tg,
      ch: fakeCh as never,
      loader,
      recorder,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0].includeStatuses,
      [...DEFAULT_INCLUDE_STATUSES],
    );
  });

  it('default maxAlertsPerRun is 10 (preventing burst floods)', () => {
    assert.equal(DEFAULT_MAX_ALERTS_PER_RUN, 10);
  });
});

// ── Fake CH (existence probes only) ─────────────────────────────────────────

interface FakeCh {
  query(args: {
    query: string;
    query_params?: Record<string, unknown>;
  }): Promise<{ json: <T>() => Promise<T[]> }>;
}

function makeCh(opts: {
  quarantineExists: boolean;
  sidecarExists: boolean;
}): FakeCh {
  return {
    query(args) {
      const params = args.query_params ?? {};
      const tbl = String(params.tbl ?? '');
      if (args.query.includes('FROM system.tables')) {
        if (tbl === 'health_quarantine') {
          return Promise.resolve({
            json: <T>() => Promise.resolve([{ n: opts.quarantineExists ? 1 : 0 }] as T[]),
          });
        }
        if (tbl === 'health_quarantine_alerts_sent') {
          return Promise.resolve({
            json: <T>() => Promise.resolve([{ n: opts.sidecarExists ? 1 : 0 }] as T[]),
          });
        }
      }
      // Default empty.
      return Promise.resolve({
        json: <T>() => Promise.resolve([] as T[]),
      });
    },
  };
}
