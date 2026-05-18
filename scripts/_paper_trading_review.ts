/**
 * Paper-trading review — text-mode equivalent of /#/paper-trading dashboard.
 * Pulls current state from quantlab.live_signals and renders a CLI report.
 */
import { fetchPaperTradingState } from '../src/server/paper_trading_dashboard.js';
import { evaluateKillCriteria } from '../src/server/paper_trading_kill_criteria.js';

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPrice(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

function ageHours(iso: string): number {
  const cleaned = iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z');
  return (Date.now() - Date.parse(cleaned)) / 3_600_000;
}

(async () => {
  const data = await fetchPaperTradingState({ runHistoryLimit: 14 });

  console.log('='.repeat(110));
  console.log(`Paper-trading review — ${new Date().toISOString().slice(0, 19)}Z`);
  console.log('='.repeat(110));
  console.log();

  // ── Header summary
  const totalLong = data.cells.reduce((a, c) => a + c.nLong, 0);
  const totalTokens = data.cells.reduce((a, c) => a + c.nTotal, 0);
  console.log(`Last daemon run : ${data.lastRunAt ?? '(never)'}  (${data.lastRunAt ? ageHours(data.lastRunAt).toFixed(1) + 'h ago' : '—'})`);
  console.log(`Cells tracked   : ${data.cells.length}  (${data.cells.map(c => c.label).join(', ')})`);
  console.log(`Open positions  : ${totalLong} long / ${totalTokens} tracked`);
  console.log();

  // ── Per-cell breakdown
  for (const cell of data.cells) {
    const pos = [...cell.longPositions].sort((a, b) => b.unrealizedPct - a.unrealizedPct);
    const totalUnreal = pos.reduce((a, p) => a + p.unrealizedPct, 0);
    const avgUnreal = pos.length > 0 ? totalUnreal / pos.length : 0;
    const winners = pos.filter(p => p.unrealizedPct > 0);
    const losers = pos.filter(p => p.unrealizedPct < 0);

    console.log('-'.repeat(110));
    console.log(`Cell: ${cell.label.padEnd(15)} ${cell.tier}/${cell.interval}`);
    console.log(`  long: ${cell.nLong}  flat: ${cell.nFlat}  total: ${cell.nTotal}`);
    console.log(`  avg unrealized: ${fmtPct(avgUnreal)}  winners: ${winners.length}  losers: ${losers.length}`);
    if (pos.length > 0) {
      console.log(`  best: ${pos[0].symbol} ${fmtPct(pos[0].unrealizedPct)}  worst: ${pos[pos.length-1].symbol} ${fmtPct(pos[pos.length-1].unrealizedPct)}`);
    }
    console.log();

    if (pos.length === 0) {
      console.log('  (no open positions)');
      continue;
    }

    console.log(`  ${'symbol'.padEnd(8)} ${'entry'.padEnd(12)} ${'entry$'.padStart(10)} ${'latest$'.padStart(10)} ${'unreal%'.padStart(10)} ${'bars'.padStart(6)}`);
    for (const p of pos) {
      const entryDate = p.positionEntryTs.slice(0, 10);
      console.log(
        `  ${p.symbol.padEnd(8)} ${entryDate.padEnd(12)} ${fmtPrice(p.positionEntryPrice).padStart(10)} ${fmtPrice(p.latestClose).padStart(10)} ${fmtPct(p.unrealizedPct).padStart(10)} ${String(p.barsHeld).padStart(6)}`
      );
    }
    console.log();
  }

  // ── Run history
  console.log('-'.repeat(110));
  console.log('Recent daemon runs (grouped by run_id):');
  const byRun = new Map<string, { runAt: string; perCell: Map<string, { nLong: number; nFlat: number }> }>();
  for (const r of data.runHistory) {
    if (!byRun.has(r.runId)) byRun.set(r.runId, { runAt: r.runAt, perCell: new Map() });
    const e = byRun.get(r.runId)!;
    e.perCell.set(r.cellKey, { nLong: r.nLong, nFlat: r.nFlat });
    if (r.runAt > e.runAt) e.runAt = r.runAt;
  }
  const runIds = [...byRun.keys()].sort((a, b) => byRun.get(b)!.runAt.localeCompare(byRun.get(a)!.runAt));
  const cellKeys = [...new Set(data.runHistory.map(r => r.cellKey))].sort();
  console.log(`  ${'run_at'.padEnd(20)}  ${cellKeys.map(k => {
    const parts = k.split('|');
    return parts.length === 4
      ? ((parts[0] === 'mean_reversion_v1' ? 'mr_v1' : parts[0]) + '/p=' + parts[3]).padStart(15)
      : k.padStart(15);
  }).join('  ')}`);
  for (const id of runIds) {
    const e = byRun.get(id)!;
    const cells = cellKeys.map(k => {
      const c = e.perCell.get(k);
      return c ? `${c.nLong}/${c.nLong + c.nFlat}`.padStart(15) : '—'.padStart(15);
    });
    console.log(`  ${e.runAt.padEnd(20)}  ${cells.join('  ')}`);
  }
  console.log();

  // ── Kill criteria check
  console.log('-'.repeat(110));
  console.log('Kill criteria status (checked against locked-in baselines):');
  // Most A criteria can't fire until ≥30 trading days of daily P&L exist;
  // surface them with their current state.
  const trendCell = data.cells.find(c => c.label.includes('trend'));
  const mrCell = data.cells.find(c => c.label.includes('mr'));

  const verdicts = evaluateKillCriteria(data);
  const checks = verdicts.map(v => ({
    name: `${v.code} ${v.label}`,
    status: v.verdict === 'pass' ? 'OK' : v.verdict === 'insufficient_data' ? 'INSUFFICIENT_DATA' : 'FAIL',
    note: v.rationale,
  }));
  for (const c of checks) {
    const tag = c.status === 'OK' ? '✓' : c.status === 'INSUFFICIENT_DATA' ? '·' : '✗';
    console.log(`  ${tag} ${c.name.padEnd(45)} ${c.status.padEnd(20)} ${c.note}`);
  }
  // Direct check of mr vs trend correlation across the unrealized %
  if (mrCell && trendCell) {
    console.log();
    console.log(`  Cross-cell snapshot:`);
    console.log(`    mr_v1 avg unrealized:    ${fmtPct(mrCell.longPositions.reduce((a,p)=>a+p.unrealizedPct,0) / Math.max(1, mrCell.longPositions.length))}`);
    console.log(`    trend_v1 avg unrealized: ${fmtPct(trendCell.longPositions.reduce((a,p)=>a+p.unrealizedPct,0) / Math.max(1, trendCell.longPositions.length))}`);
    console.log(`    (these are unrealized from entry, not daily P&L; correlation requires live trade ledger)`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
