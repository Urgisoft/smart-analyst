/**
 * Unit tests for the daemon's v1 yfinance primary ETF refresh
 * orchestration helper — `buildEtfFlowV1PrimaryArgs` in
 * src/server/daemon_etf_flow_v1_primary_refresh.ts.
 *
 * Session 96 #15 Cycle 2 context (GAP-4 daemon-cadence promotion): the
 * v1 yfinance primary ETF ingest was operator-cadence pre-Cycle 2
 * while the v3.1 SSGA-SPDR secondary panel refreshed daemon-cadence
 * (step 1ja, s96 #9). The asymmetry produced a comparator pathology
 * over time — cross-validation divergence dominated by primary
 * staleness, not real data-quality delta. This slice wires
 * `scripts/etf_flow_ingest.py` into the daemon as step 1jb (between
 * 1ja secondary refresh + 1j etf-flow snapshot write).
 *
 * The pure helper pinned here is the load-bearing regression a future
 * refactor could silently break:
 *   - `buildEtfFlowV1PrimaryArgs` MUST pass `--apply` on daemon
 *     write-mode (the Python script defaults to dry-run absent the
 *     flag). A silent flip would make the daemon a no-op writer and
 *     the comparator pathology would persist undetected.
 *   - `buildEtfFlowV1PrimaryArgs` MUST NOT pass `--start-date` /
 *     `--end-date` — the script's `DEFAULT_LOOKBACK_DAYS = 400` is
 *     the canonical trailing-1y baseline window. Operator-derived
 *     dates re-introduce operator-memory dependence (ADR-044
 *     anti-pattern this slice closes).
 *   - The timeout budget must remain inside the daemon's per-run
 *     wall-clock envelope (10min matches SSGA-SPDR adapter + EDGAR
 *     per-ingest; well within the daemon's overall envelope).
 *
 * runEtfFlowV1PrimaryRefresh itself is not unit-tested — it spawns a
 * Python subprocess and is exercised end-to-end by `npm run daemon:daily`.
 * Same posture as daemonFredFetch.test.ts / daemonFinraShortInterestFetch.test.ts
 * (the precedent for Python-spawn helpers).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEtfFlowV1PrimaryArgs } from '../../src/server/daemon_etf_flow_v1_primary_refresh.js';

describe('buildEtfFlowV1PrimaryArgs', () => {
  it('passes --apply when dryRun=false', () => {
    const { args, timeoutMs } = buildEtfFlowV1PrimaryArgs(false);
    assert.deepEqual(args, ['scripts/etf_flow_ingest.py', '--apply']);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('passes --dry-run when dryRun=true', () => {
    const { args, timeoutMs } = buildEtfFlowV1PrimaryArgs(true);
    assert.deepEqual(args, ['scripts/etf_flow_ingest.py', '--dry-run']);
    assert.equal(timeoutMs, 10 * 60_000);
  });

  it('does not include --apply AND --dry-run simultaneously', () => {
    // The v1 ingest's parse_args treats `--apply` as the explicit write
    // toggle; `--dry-run` is the default (no flag) but is also accepted
    // as an explicit flag. Defensively assert we never emit both — would
    // surface as a silent no-op write if the script contract ever flips.
    const dry = buildEtfFlowV1PrimaryArgs(true).args;
    const apply = buildEtfFlowV1PrimaryArgs(false).args;
    assert.ok(!(dry.includes('--apply') && dry.includes('--dry-run')));
    assert.ok(!(apply.includes('--apply') && apply.includes('--dry-run')));
  });

  it('does not include --start-date / --end-date (relies on script default lookback)', () => {
    // The Python script's `DEFAULT_LOOKBACK_DAYS = 400` resolves to a
    // today-400d → today window — the canonical trailing-1y baseline
    // window with ~35d headroom for missed daemon cycles. Passing
    // operator-derived dates here would re-introduce operator-memory
    // dependence (the ADR-044 anti-pattern GAP-4 closes). If this
    // assertion fails, the daemon promotion has silently regressed.
    for (const dryRun of [true, false]) {
      const { args } = buildEtfFlowV1PrimaryArgs(dryRun);
      assert.ok(
        !args.some(a => a.startsWith('--start-date')),
        `--start-date flag must not be set (dryRun=${dryRun})`,
      );
      assert.ok(
        !args.some(a => a.startsWith('--end-date')),
        `--end-date flag must not be set (dryRun=${dryRun})`,
      );
    }
  });

  it('does not include --tickers override (relies on script ETF_UNIVERSE constant)', () => {
    // The script's `ETF_UNIVERSE` constant (21 ETFs per SPEC F-UNIVERSE)
    // is the canonical daemon-cadence list. Adding a flag here would
    // silently shadow operator-level edits to the universe constant.
    for (const dryRun of [true, false]) {
      const { args } = buildEtfFlowV1PrimaryArgs(dryRun);
      assert.ok(
        !args.some(a => a.startsWith('--tickers')),
        `--tickers flag must not be set (dryRun=${dryRun})`,
      );
    }
  });

  it('script path resolves to scripts/etf_flow_ingest.py', () => {
    // Pin the script path explicitly — the helper is named after the
    // v1 primary panel; the Python script it spawns must remain the v1
    // ingest. A typo or accidental rename in the helper would surface
    // here, not as a runtime FileNotFoundError mid-daemon-cycle.
    for (const dryRun of [true, false]) {
      const { args } = buildEtfFlowV1PrimaryArgs(dryRun);
      assert.equal(args[0], 'scripts/etf_flow_ingest.py');
    }
  });

  it('timeout budget is bounded to 10 minutes (daemon per-step ceiling)', () => {
    // 21 sequential yfinance fetches at 1-3s each is ~30-90s steady
    // state. 10 minutes covers a degraded yfinance endpoint + rate-limit
    // back-offs. Matches the SSGA-SPDR adapter (10min) + EDGAR per-ingest
    // (10min) ceilings. The daemon's longest single-step timeout is
    // macro-fetch full-backfill at 15min; this stays well within the
    // per-step envelope.
    assert.equal(buildEtfFlowV1PrimaryArgs(false).timeoutMs, 10 * 60_000);
    assert.equal(buildEtfFlowV1PrimaryArgs(true).timeoutMs, 10 * 60_000);
  });
});
