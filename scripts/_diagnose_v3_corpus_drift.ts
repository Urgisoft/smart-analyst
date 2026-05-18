/**
 * Spot-probe — does the current `classifyMacroRegimeV3` produce reds when
 * given stress-period inputs?
 *
 * Re-runs the v3 backfill against Q4 2008 (1 month around Lehman) and prints
 * the per-day output for 4 known-stress days. If reds appear, the classifier
 * is sound and the CH rows just need a full backfill rerun. If 0 reds, the
 * classifier itself has regressed and a deeper investigation is needed.
 *
 * Session 45 diagnostic — see HANDOFF "NEW HIGH (session 45)".
 */
import { backfillMacroRegimesV3, fetchMacroRegimeV3 } from '../src/server/macro_regime_v3.js';

(async () => {
  console.log('--- BEFORE (current CH state) ---');
  const before = await fetchMacroRegimeV3('2008-12-15');
  console.log(
    `  Row for 2008-12-15: regime=${before?.regime} ` +
    `categories_firing=${before?.categories_firing} ` +
    `inputs_missing=${before?.inputs_missing}`,
  );

  const r = await backfillMacroRegimesV3({ startDate: '2008-10-01', endDate: '2008-12-31' });
  console.log(`--- AFTER backfill Q4 2008 (${r.rowsWritten} rows written) ---`);

  for (const d of ['2008-10-10', '2008-11-20', '2008-12-01', '2008-12-15', '2008-12-31']) {
    const row = await fetchMacroRegimeV3(d);
    if (row && row.trade_date === d) {
      console.log(
        `  ${d}: regime=${row.regime} firing=${row.categories_firing} firing_5d=${row.categories_firing_5d} ` +
        `vix_inv=${row.vix_term_inverted} hyg_spy=${row.hyg_spy_divergence} yc=${row.yield_curve_inverted} ` +
        `credit=${row.credit_stress} riskoff=${row.risk_off_rotation} sent=${row.sentiment_extreme} ` +
        `miss=${row.inputs_missing}`,
      );
    } else {
      console.log(`  ${d}: NO ROW`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
