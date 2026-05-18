import { createClient } from '@clickhouse/client';
import 'dotenv/config';

(async () => {
  const ch = createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'quantlab',
  });

  const q = await ch.query({
    query: `
      SELECT strategy_type, tier, interval, best_param,
             round(dsr, 3) AS dsr, round(psr, 3) AS psr,
             pbo, hlz_t_passes, gates_pass,
             round(wt_net_pct, 1) AS is_pct, round(oos_wt_net_pct, 1) AS oos_pct,
             round(oos_is_ratio, 3) AS wfe, total_trades AS trades, n_tokens_traded AS tokens,
             round(composite, 4) AS comp
      FROM quantlab.strategy_scores FINAL
      WHERE strategy_type IN ('volume_breakout_v1', 'volume_breakout_xmom_v1')
      ORDER BY strategy_type, tier, interval
    `,
    format: 'JSONEachRow',
  });
  const rows = (await q.json()) as Array<Record<string, number | string | null>>;

  console.log('VB cells in strategy_scores:', rows.length);
  console.log();
  console.log('strategy                  tier         iv    p   comp    DSR   PSR   PBO   HLZ gate  IS%       OOS%      WFE    trades tokens');
  console.log('─'.repeat(132));

  for (const r of rows) {
    const pboCell = r.pbo === null ? '  —  ' : (r.pbo as number).toFixed(2).padStart(5);
    const hlz = r.hlz_t_passes ? ' ✓ ' : ' ✗ ';
    const gate = r.gates_pass ? ' ✓ ' : ' ✗ ';
    const isPct = r.is_pct as number;
    const oosPct = r.oos_pct as number;
    console.log(
      String(r.strategy_type).padEnd(25) +
      String(r.tier).padEnd(13) +
      String(r.interval).padEnd(5) +
      String(r.best_param).padStart(4) +
      '  ' + (r.comp as number).toFixed(4).padStart(6) +
      '  ' + (r.dsr as number).toFixed(2).padStart(5) +
      '  ' + (r.psr as number).toFixed(2).padStart(5) +
      '  ' + pboCell +
      '   ' + hlz +
      '  ' + gate +
      '  ' + (isPct >= 0 ? '+' : '') + isPct.toFixed(1).padStart(8) + '%' +
      '  ' + (oosPct >= 0 ? '+' : '') + oosPct.toFixed(1).padStart(8) + '%' +
      '  ' + (r.wfe as number).toFixed(2).padStart(5) +
      '  ' + String(r.trades).padStart(6) +
      '  ' + String(r.tokens).padStart(5)
    );
  }
  process.exit(0);
})();
