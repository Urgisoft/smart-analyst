/**
 * Cycle 20 (s96 #19) smoke probe — exercises the new
 * `buildEtfFlowCrossValidationState` against live CH data and prints
 * the JSON the /api/etf-flow/cross-validation route would return.
 *
 * Browser smoke-test surrogate per ADR-044 §UI: with the operator's
 * dev server running the OLD binary on :3000, we can't hit the new
 * code path through HTTP without restarting their server (which would
 * disrupt the user). Instead this probe imports the new builder
 * directly + dumps the response so the operator can visually confirm
 * mode='secondary-only' + secondaryLatest is non-empty.
 *
 * Re-runnable: `npx tsx scripts/_probe_etf_flow_dashboard_response.ts`
 */
import { fetchEtfFlowCrossValidationState } from '../src/server/etf_flow_dashboard.js';

async function main() {
  const r = await fetchEtfFlowCrossValidationState({ lookbackDays: 90 });
  console.log('=== /api/etf-flow/cross-validation response (Cycle 20) ===');
  console.log('mode:', r.mode);
  console.log('hasData:', r.hasData);
  console.log('asOf:', r.asOf);
  console.log('lookbackDays:', r.lookbackDays);
  console.log('counts:', JSON.stringify(r.counts, null, 2));
  console.log('summary:', r.summary ? '(populated)' : 'null');
  console.log('secondaryLatest count:', r.secondaryLatest?.length ?? 'null');
  if (r.secondaryLatest && r.secondaryLatest.length > 0) {
    console.log('');
    console.log('=== secondaryLatest rows ===');
    console.log(
      ['ticker', 'date', 'shares', 'close', 'aum', 'prevDate', 'dodPct', 'rows'].join('\t'),
    );
    for (const row of r.secondaryLatest) {
      const dodPct = row.sharesPctDelta == null ? '—'
        : `${(row.sharesPctDelta * 100).toFixed(3)}%`;
      console.log([
        row.ticker,
        row.date,
        row.shares.toFixed(0),
        row.close.toFixed(2),
        row.aum.toExponential(3),
        row.previousDate ?? '—',
        dodPct,
        row.rowCount,
      ].join('\t'));
    }
  }
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
