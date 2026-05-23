/**
 * Unit tests for the daemon's SSGA-SPDR refresh orchestration helpers —
 * `buildSsgaSpdrAdapterArgs` + `buildIssuerCsvIngestArgs` in
 * src/server/daemon_etf_flow_ssga_spdr_refresh.ts.
 *
 * Session 96 #9 context: s96 #7 shipped the SSGA navhist → canonical-CSV
 * adapter; s96 #8 shipped the operator-cadence `:refresh` npm wrapper.
 * This slice (OQ-G9-2) wires the same chain into daily_signal_daemon.ts
 * for daemon-cadence automation. The pure arg-builders are the only
 * regression a future refactor could silently break:
 *   - The `--source-label ssga-spdr` flag is LOAD-BEARING — without it,
 *     ingested rows are tagged with the default 'issuer-csv' label and
 *     the comparator's source-label-aware logic mis-classifies them
 *     (s95 #9 panel design + S96-36 wrapper-script lock-in).
 *   - The DRY_RUN forwarding contract must match: both adapter + ingest
 *     pass through `--dry-run` so the daemon's `--dry-run` mode is
 *     side-effect-free end-to-end.
 *   - The timeout budgets must remain inside the daemon's per-run
 *     wall-clock envelope (10min adapter + 5min ingest = 15min worst
 *     case; well within the daemon's existing tolerance).
 *
 * runSsgaSpdrRefresh itself is not unit-tested — it spawns two Python
 * subprocesses and is exercised end-to-end by `npm run daemon:daily`.
 * Same posture as daemonFredFetch.test.ts (the precedent for
 * Python-spawn helpers).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSsgaSpdrAdapterArgs,
  buildIssuerCsvIngestArgs,
} from '../../src/server/daemon_etf_flow_ssga_spdr_refresh.js';

describe('buildSsgaSpdrAdapterArgs', () => {
  it('passes --apply when dryRun=false', () => {
    const { args, timeoutMs } = buildSsgaSpdrAdapterArgs(false);
    assert.deepEqual(args, ['scripts/etf_flow_ssga_spdr_adapter.py', '--apply']);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('passes --dry-run when dryRun=true', () => {
    const { args, timeoutMs } = buildSsgaSpdrAdapterArgs(true);
    assert.deepEqual(args, ['scripts/etf_flow_ssga_spdr_adapter.py', '--dry-run']);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('does not include --apply AND --dry-run simultaneously', () => {
    // The SSGA adapter treats `--apply` + `--dry-run` as dry-run (per its
    // parse_args). Defensively assert we never emit both — would surface
    // as a silent no-op write if the adapter contract ever flips.
    const dry = buildSsgaSpdrAdapterArgs(true).args;
    const apply = buildSsgaSpdrAdapterArgs(false).args;
    assert.ok(!(dry.includes('--apply') && dry.includes('--dry-run')));
    assert.ok(!(apply.includes('--apply') && apply.includes('--dry-run')));
  });

  it('does not include --tickers / --lookback-days / --output-dir overrides', () => {
    // Daemon use should rely on the adapter's DEFAULT_TICKERS (13 SPDRs)
    // + DEFAULT_LOOKBACK_DAYS (365) + DEFAULT_OUTPUT_DIR. Adding a flag
    // here would silently shadow operator-level changes to the adapter.
    const { args } = buildSsgaSpdrAdapterArgs(false);
    assert.ok(!args.some(a => a.startsWith('--tickers')));
    assert.ok(!args.some(a => a.startsWith('--lookback-days')));
    assert.ok(!args.some(a => a.startsWith('--output-dir')));
    assert.ok(!args.some(a => a.startsWith('--output-file')));
  });
});

describe('buildIssuerCsvIngestArgs', () => {
  it('passes --source-label ssga-spdr --apply when dryRun=false', () => {
    const { args, timeoutMs } = buildIssuerCsvIngestArgs(false);
    assert.deepEqual(args, [
      'scripts/etf_flow_issuer_csv_ingest.py',
      '--source-label', 'ssga-spdr',
      '--apply',
    ]);
    assert.equal(timeoutMs, 5 * 60_000);
  });

  it('passes --source-label ssga-spdr --dry-run when dryRun=true', () => {
    const { args, timeoutMs } = buildIssuerCsvIngestArgs(true);
    assert.deepEqual(args, [
      'scripts/etf_flow_issuer_csv_ingest.py',
      '--source-label', 'ssga-spdr',
      '--dry-run',
    ]);
    assert.equal(timeoutMs, 5 * 60_000);
  });

  it('always includes --source-label ssga-spdr (load-bearing for comparator tagging)', () => {
    // Per S96-36 — if a future refactor drops this flag, ingested rows
    // would be tagged `issuer-csv` (the default) and the cross-validation
    // comparator's source-label-aware panel would mis-classify them.
    for (const dryRun of [true, false]) {
      const { args } = buildIssuerCsvIngestArgs(dryRun);
      const idx = args.indexOf('--source-label');
      assert.ok(idx >= 0, `--source-label flag missing when dryRun=${dryRun}`);
      assert.equal(args[idx + 1], 'ssga-spdr');
    }
  });

  it('does not include --input-dir override', () => {
    // The daemon uses the ingester's DEFAULT_INPUT_DIR
    // (`data/etf_flow_issuer_csv/`) which is the same dir the SSGA
    // adapter writes to. Adding an override here would create a
    // cross-script path-coupling that a future config change could
    // silently break.
    const { args } = buildIssuerCsvIngestArgs(false);
    assert.ok(!args.some(a => a.startsWith('--input-dir')));
  });
});

describe('arg-builder contracts (cross-step invariants)', () => {
  it('both helpers forward dryRun consistently', () => {
    // The daemon orchestrator's chain semantic depends on this. If
    // adapter ran --apply (real write) but ingest ran --dry-run (no CH
    // write), the operator brief would surface "SSGA CSV refreshed"
    // without the comparator seeing the new rows — silent panel drift.
    const adapterApply = buildSsgaSpdrAdapterArgs(false).args;
    const ingestApply = buildIssuerCsvIngestArgs(false).args;
    assert.ok(adapterApply.includes('--apply'));
    assert.ok(ingestApply.includes('--apply'));
    assert.ok(!adapterApply.includes('--dry-run'));
    assert.ok(!ingestApply.includes('--dry-run'));

    const adapterDry = buildSsgaSpdrAdapterArgs(true).args;
    const ingestDry = buildIssuerCsvIngestArgs(true).args;
    assert.ok(adapterDry.includes('--dry-run'));
    assert.ok(ingestDry.includes('--dry-run'));
    assert.ok(!adapterDry.includes('--apply'));
    assert.ok(!ingestDry.includes('--apply'));
  });

  it('combined timeout budget stays under the daemon per-step ceiling', () => {
    // The daemon's longest single-step timeout currently is the
    // macro-fetch full-backfill at 15 minutes (900_000 ms). The
    // SSGA refresh combined budget is 10 + 5 = 15 minutes — at parity
    // but does NOT exceed. A future bump on either should re-evaluate
    // whether the daemon's overall wall-clock envelope still holds.
    const adapterMs = buildSsgaSpdrAdapterArgs(false).timeoutMs;
    const ingestMs = buildIssuerCsvIngestArgs(false).timeoutMs;
    assert.ok(adapterMs + ingestMs <= 15 * 60_000);
  });
});
