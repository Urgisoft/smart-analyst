/**
 * Daily macro regime one-shot — phase1_v3.
 *
 * Calls `classifyLatestMacroRegimeV3`, which: finds the latest date for which
 * VIX, VIX3M, HYG, SPY, LQD, and TLT all have a close in CH (yfinance_regime
 * source); backfills classification for that single date into
 * `quantlab.macro_regimes` under `classifier_version='phase1_v3'`; and
 * returns the resulting row. Skips silently if any candle source is missing
 * today's bar — protects against the daemon firing before Yahoo's official
 * close lands.
 *
 * This is the v3 sibling of `macro_regime_classify_today.ts` (which writes
 * `phase1_v2` rows and is no longer the active classifier).
 *
 * Safe with respect to `ADR_038_BASELINE`: the constant is pinned as a
 * literal (regime_dashboard.test.ts test #9b) and doesn't reflect live row
 * counts. The session-44 PUSHBACK lock on `npm run macro:backfill:v3` is
 * about re-running the historical 2008-present corpus, which would shift
 * the baseline mid-corpus. Writing a single row for today only appends.
 *
 * Usage:
 *   npm run macro:classify:today:v3
 *   npx tsx scripts/macro_regime_classify_today_v3.ts
 */
import { classifyLatestMacroRegimeV3 } from '../src/server/macro_regime_v3.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'macro:classify:today:v3',
    category: 'Data ingestion',
    what:
      'phase1_v3 one-shot (leading-indicator classifier) — classify today\'s macro regime if ' +
      'VIX/VIX3M/HYG/SPY/LQD/TLT closes are all in CH, else skip silently. Writes one row to ' +
      'quantlab.macro_regimes under classifier_version=\'phase1_v3\'. Safe re ADR-038 baseline.',
  },
];

async function main() {
  const row = await classifyLatestMacroRegimeV3();
  if (!row) {
    console.log(
      'macro_regime_classify_today_v3: no candle data ready yet ' +
      '(or no overlap of VIX/VIX3M/HYG/SPY/LQD/TLT); skipping.',
    );
    process.exit(0);
  }
  console.log(
    `macro_regime_classify_today_v3: ${row.trade_date}  regime=${row.regime}  ` +
    `categories_firing=${row.categories_firing}  categories_firing_5d=${row.categories_firing_5d}  ` +
    `vix_term_inverted=${row.vix_term_inverted}  hyg_spy_divergence=${row.hyg_spy_divergence}  ` +
    `yield_curve_inverted=${row.yield_curve_inverted}  credit_stress=${row.credit_stress}  ` +
    `risk_off_rotation=${row.risk_off_rotation}  sentiment_extreme=${row.sentiment_extreme}  ` +
    `inputs_missing=${row.inputs_missing}`,
  );
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
