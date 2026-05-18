/**
 * Daily macro regime one-shot.
 *
 * Calls `classifyLatestMacroRegime`, which: finds the latest date for which
 * VIX, VIX3M, HYG, and SPY all have a close in CH; backfills classification
 * for that single date (writing to `quantlab.macro_regimes`); and returns
 * the resulting row. Skips silently if any source is missing today's bar
 * — protects the daemon from running before Yahoo's official close lands
 * (SPEC §6 stale-data guard).
 *
 * Phase 1 is data-only: this script logs the regime and exits. No
 * Telegram, no email, no UI integration. Operational alerting comes in
 * Component 4 (daily AI briefing) per SPEC §0.
 *
 * Usage:
 *   npm run macro:classify:today
 *   npx tsx scripts/macro_regime_classify_today.ts
 */
import { classifyLatestMacroRegime } from '../src/server/macro_regime.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'macro:classify:today',
    category: 'Data ingestion',
    what:
      'phase1_v2 one-shot — classify today\'s macro regime if VIX/VIX3M/HYG/SPY closes are all in CH, ' +
      'else skip silently. Writes one row to quantlab.macro_regimes. Phase 1 is data-only — no Telegram/UI.',
  },
];

async function main() {
  const row = await classifyLatestMacroRegime();
  if (!row) {
    console.log('macro_regime_classify_today: no candle data ready yet (or no overlap of VIX/VIX3M/HYG/SPY); skipping.');
    process.exit(0);
  }
  console.log(`macro_regime_classify_today: ${row.trade_date}  regime=${row.regime}  ` +
    `vix_term_inverted=${row.vix_term_inverted}  hyg_spy_divergence=${row.hyg_spy_divergence}  ` +
    `breadth_narrow=${row.breadth_narrow}  categories_firing_5d=${row.categories_firing_5d}  ` +
    `inputs_missing=${row.inputs_missing}`);
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
