/**
 * In-browser CSV → ValidatorRequest helpers for the Path 2 UI.
 *
 * Per SPEC §1.6: parse client-side up to a 5MB practical cap. Above that we'd switch
 * to a multipart upload — not implemented in v1.
 *
 * The two CSVs we accept are:
 *   1. Trial returns — required.   Columns: trialId,ts,ret    (any order, header row required)
 *   2. Per-asset Sharpes — optional. Columns: assetId,sharpe   (header row required)
 *   3. Trade counts — optional.    Columns: trialId,trades    (header row required)
 *
 * Errors include row numbers (1-indexed including the header). The orchestrator does its
 * own validation downstream — these parsers only convert text → typed objects, they don't
 * enforce alignment / minimums / units. That's `parseValidatorRequest` server-side.
 */

import type { TrialReturnRow } from '../../lib/validator_request.js';

/** 5MB practical cap before we'd need multipart upload. SPEC §1.6. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

export type CsvParseResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: string };

/** Type guard for the failure branch of CsvParseResult. Same need as
 *  `isParseFailure` in `validator_request.ts` — `if (!r.ok)` alone won't narrow
 *  under `strict: false`. */
export function isCsvFailure<T>(r: CsvParseResult<T>): r is { ok: false; error: string } {
  return !r.ok;
}

/** Splits a CSV line respecting double-quoted fields. Minimal — no escaped quotes inside
 *  fields, since the inputs are numeric / short identifiers. If users start putting commas
 *  in trialIds, we'd need a real RFC-4180 parser. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

type HeaderResult =
  | { ok: true; lines: string[]; idx: number[] }
  | { ok: false; error: string };

/** Type guard required because tsconfig has `strict: false` — discriminated-union
 *  narrowing on `if (!h.ok)` alone doesn't carry through. Mirrors `isParseFailure`
 *  in `validator_request.ts`. */
function isHeaderFailure(h: HeaderResult): h is { ok: false; error: string } {
  return !h.ok;
}

function parseHeader(text: string, requiredCols: string[]): HeaderResult {
  const trimmed = text.replace(/^﻿/, '');  // strip BOM
  const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { ok: false, error: 'CSV needs a header row and at least one data row.' };
  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const idx = requiredCols.map(c => header.indexOf(c.toLowerCase()));
  for (let i = 0; i < requiredCols.length; i++) {
    if (idx[i] === -1) return { ok: false, error: `Missing column "${requiredCols[i]}" in header. Got: ${header.join(', ')}` };
  }
  return { ok: true, lines, idx };
}

export function parseTrialReturnsCsv(text: string): CsvParseResult<TrialReturnRow> {
  if (text.length > MAX_CSV_BYTES) {
    return { ok: false, error: `CSV exceeds 5MB cap (${(text.length / 1024 / 1024).toFixed(1)}MB). Pre-aggregate or split.` };
  }
  const h = parseHeader(text, ['trialId', 'ts', 'ret']);
  if (isHeaderFailure(h)) return { ok: false, error: h.error };
  const [iId, iTs, iRet] = h.idx;
  const rows: TrialReturnRow[] = [];
  for (let i = 1; i < h.lines.length; i++) {
    const cells = splitCsvLine(h.lines[i]);
    const trialId = cells[iId];
    const ts = Number(cells[iTs]);
    const ret = Number(cells[iRet]);
    if (!trialId) return { ok: false, error: `Row ${i + 1}: trialId is empty.` };
    if (!Number.isFinite(ts)) return { ok: false, error: `Row ${i + 1}: ts="${cells[iTs]}" is not a finite number.` };
    if (!Number.isFinite(ret)) return { ok: false, error: `Row ${i + 1}: ret="${cells[iRet]}" is not a finite number.` };
    rows.push({ trialId, ts, ret });
  }
  if (rows.length === 0) return { ok: false, error: 'CSV had a header but no data rows.' };
  return { ok: true, rows };
}

export function parsePerAssetSharpesCsv(text: string): CsvParseResult<{ assetId: string; sharpe: number }> {
  const h = parseHeader(text, ['assetId', 'sharpe']);
  if (isHeaderFailure(h)) return { ok: false, error: h.error };
  const [iA, iS] = h.idx;
  const rows: { assetId: string; sharpe: number }[] = [];
  for (let i = 1; i < h.lines.length; i++) {
    const cells = splitCsvLine(h.lines[i]);
    const assetId = cells[iA];
    const sharpe = Number(cells[iS]);
    if (!assetId) return { ok: false, error: `Row ${i + 1}: assetId is empty.` };
    if (!Number.isFinite(sharpe)) return { ok: false, error: `Row ${i + 1}: sharpe="${cells[iS]}" is not a finite number.` };
    rows.push({ assetId, sharpe });
  }
  return { ok: true, rows };
}

export function parseTradeCountsCsv(text: string): CsvParseResult<{ trialId: string; trades: number }> {
  const h = parseHeader(text, ['trialId', 'trades']);
  if (isHeaderFailure(h)) return { ok: false, error: h.error };
  const [iId, iTr] = h.idx;
  const rows: { trialId: string; trades: number }[] = [];
  for (let i = 1; i < h.lines.length; i++) {
    const cells = splitCsvLine(h.lines[i]);
    const trialId = cells[iId];
    const trades = Number(cells[iTr]);
    if (!trialId) return { ok: false, error: `Row ${i + 1}: trialId is empty.` };
    if (!Number.isFinite(trades) || trades < 0) return { ok: false, error: `Row ${i + 1}: trades="${cells[iTr]}" must be a non-negative finite number.` };
    rows.push({ trialId, trades });
  }
  return { ok: true, rows };
}

/** Derive a sensible default chosenTrialId — the trialId with the highest non-annual
 *  Sharpe of its bar-return series. Mirrors the validator orchestrator's "best of N"
 *  framing. The user can override in the UI. */
export function defaultChosenTrialId(rows: TrialReturnRow[]): string | null {
  if (rows.length === 0) return null;
  const byId = new Map<string, number[]>();
  for (const r of rows) {
    const list = byId.get(r.trialId);
    if (list) list.push(r.ret); else byId.set(r.trialId, [r.ret]);
  }
  let best = '';
  let bestSharpe = -Infinity;
  for (const [id, rets] of byId) {
    const n = rets.length;
    if (n < 2) continue;
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    let varSum = 0;
    for (const r of rets) { const d = r - mean; varSum += d * d; }
    const sd = Math.sqrt(varSum / n);
    if (sd === 0) continue;
    const s = mean / sd;
    if (s > bestSharpe) { bestSharpe = s; best = id; }
  }
  return best || [...byId.keys()][0];
}

/** Default IS/OOS split: 70/30 by row position on the chosen trial's timeline. Pardo's
 *  default split convention (§4) — user can override with an explicit ts. */
export function defaultSplitTs(rows: TrialReturnRow[], chosenId: string): number | null {
  const chosen = rows.filter(r => r.trialId === chosenId).map(r => r.ts).sort((a, b) => a - b);
  if (chosen.length < 4) return null;
  const idx = Math.floor(chosen.length * 0.7);
  return chosen[idx];
}
