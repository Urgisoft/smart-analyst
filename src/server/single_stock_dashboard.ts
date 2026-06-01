/**
 * Single-stock detail dashboard — first UI of the post-validation phase.
 *
 * Powers `GET /api/single-stock/:ticker` for the `/#/single-stock` route. A
 * per-ticker decision-support SCORECARD assembled read-only from the
 * server-callable sources already in the system:
 *
 *   1. Technicals   — quantlab.equity_daily_polygon (last close, ~50/200d avg,
 *                     52-wk hi/lo, 1-mo & 1-yr momentum).
 *   2. Options      — scripts/yfinance_options_summary.py <T> --json, spawned
 *                     via child_process (forward-looking IV term structure,
 *                     put/call vol+OI, skew). Honest empty state when the
 *                     ticker has no listed options or Yahoo is not serving.
 *   3. Positioning  — quantlab.insider_trades (trailing-365d net P vs S),
 *                     quantlab.short_interest (latest), quantlab.schedule_13d_g_filings
 *                     (activist-stake form counts).
 *   4. Macro fit    — quantlab.macro_regimes latest regime + the ticker's GICS
 *                     sector (quantlab.gics_sector_map).
 *   5. Fundamentals — Finnhub REST (P/E, margins, ROE, analyst targets) IF
 *                     process.env.FINNHUB_API_KEY is set; otherwise a clean
 *                     `{available:false, note:"...phase 2"}` placeholder.
 *
 * IMPORTANT — NO ALPHA CLAIM. ADR-056 concluded the comprehensive validation
 * null: nothing in this system is a validated tradeable signal. This panel is
 * a DATA-AGGREGATION TERMINAL, explicitly labeled decision-support. It does
 * not rank, score-to-buy, or recommend. Every number traces to a free,
 * server-callable source.
 *
 * Design split (mirrors cycle_position_dashboard.ts):
 *   - Pure `parseTicker` helper — testable without CH or network.
 *   - One impure entry point `fetchSingleStockScorecard` — wraps the repo +
 *     the options spawn + the optional Finnhub fetch. Each dimension is
 *     guarded independently: a missing CH table OR a spawn failure degrades
 *     that ONE dimension to an honest "unavailable" state; the rest of the
 *     scorecard still renders (no 500s — ADR-044 UI correctness).
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  SingleStockRepository,
  type TechnicalsBlock,
  type PositioningBlock,
  type MacroFitBlock,
} from './single_stock_repository.js';

// ── Public types ──────────────────────────────────────────────────────────

/** One ATM-IV term-structure point (per expiry). */
export interface OptionsTermPoint {
  date: string;
  dte: number;
  atmIv: number | null;
}

/** Forward-looking options snapshot, projected from the python tool's JSON. */
export interface OptionsBlock {
  available: boolean;
  /** Human note when unavailable (no listed options / Yahoo down / spawn fail). */
  note: string | null;
  asOf: string | null;
  spot: number | null;
  numExpirations: number | null;
  /** Contracts whose IV was solved from price (Yahoo IV sentinel; pre/post-market). */
  ivRepaired: number | null;
  termStructure: OptionsTermPoint[];
  termStructureFlag: string | null; // contango | backwardation | flat | insufficient
  nearAtmIv: number | null;
  farAtmIv: number | null;
  pcVolumeAll: number | null;
  pcOiAll: number | null;
  nearestExpiry: {
    date: string;
    dte: number;
    pcVolume: number | null;
    pcOi: number | null;
    callVolume: number;
    putVolume: number;
    callOi: number;
    putOi: number;
  } | null;
  skew: {
    pctOffset: number;
    putStrike: number | null;
    putIv: number | null;
    callStrike: number | null;
    callIv: number | null;
    skewPts: number | null;
  } | null;
}

/** Fundamentals/analyst block — Finnhub when keyed, else a clean placeholder. */
export interface FundamentalsBlock {
  available: boolean;
  note: string | null;
  peTtm: number | null;
  netMarginTtm: number | null; // decimal (0.25 = 25%)
  roeTtm: number | null; // decimal
  priceTargetMean: number | null;
  priceTargetHigh: number | null;
  priceTargetLow: number | null;
  recommendation: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    period: string;
  } | null;
}

export interface SingleStockScorecard {
  ticker: string;
  generatedAt: string;
  /** Standing label — there is NO validated signal here (ADR-056). */
  disclaimer: string;
  technicals: TechnicalsBlock;
  options: OptionsBlock;
  positioning: PositioningBlock;
  macroFit: MacroFitBlock;
  fundamentals: FundamentalsBlock;
}

// ── Ticker parsing ──────────────────────────────────────────────────────────

export type ParsedTicker =
  | { ok: true; ticker: string }
  | { ok: false; status: number; error: string; detail: string };

export function isTickerFailure(
  p: ParsedTicker,
): p is Extract<ParsedTicker, { ok: false }> {
  return !p.ok;
}

/**
 * Validate + normalize a US-equity ticker. Accepts 1-6 chars of
 * [A-Za-z0-9.-] (covers BRK.B, BF-B style); uppercases. Anything else is a
 * 400 — keeps malformed input from reaching the CH `IN` clause + the spawn.
 */
export function parseTicker(input: { ticker?: unknown }): ParsedTicker {
  const raw = input.ticker;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, status: 400, error: 'bad_ticker', detail: 'ticker is required' };
  }
  const t = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,5}$/.test(t)) {
    return {
      ok: false, status: 400, error: 'bad_ticker',
      detail: 'ticker must be 1-6 chars of A-Z, 0-9, dot or hyphen',
    };
  }
  return { ok: true, ticker: t };
}

// ── Options spawn ─────────────────────────────────────────────────────────

/** Resolve the python interpreter — repo convention is the venv (HANDOFF). */
function pythonExecutable(): string {
  // Windows venv layout used throughout the repo's daemon/scripts.
  return process.env.SIGNALFORGE_PYTHON
    ?? path.join('.venv', 'Scripts', 'python.exe');
}

/** What the python tool's --json block emits (snake_case). Internal. */
interface RawOptionsJson {
  ticker: string;
  spot: number;
  asof: string;
  num_expirations: number;
  iv_repaired?: number;
  term_structure: Array<{ date: string; dte: number; atm_iv: number | null }>;
  term_structure_flag: string;
  near_atm_iv: number | null;
  far_atm_iv: number | null;
  pc_volume_all: number | null;
  pc_oi_all: number | null;
  nearest_expiry: {
    date: string; dte: number;
    pc_volume: number | null; pc_oi: number | null;
    call_volume: number; put_volume: number; call_oi: number; put_oi: number;
  };
  skew: {
    pct_offset: number;
    put_strike: number | null; put_iv: number | null;
    call_strike: number | null; call_iv: number | null;
    skew_pts: number | null;
  };
}

/** An options-unavailable block with an operator-readable note. */
function optionsUnavailable(note: string): OptionsBlock {
  return {
    available: false, note,
    asOf: null, spot: null, numExpirations: null, ivRepaired: null,
    termStructure: [], termStructureFlag: null,
    nearAtmIv: null, farAtmIv: null, pcVolumeAll: null, pcOiAll: null,
    nearestExpiry: null, skew: null,
  };
}

/**
 * Extract the JSON object the python tool prints after its `--- JSON ---`
 * marker. The tool prints a human readout first, then the marker, then the
 * JSON. Pure + testable. Returns null when no JSON block is present.
 */
export function extractOptionsJson(stdout: string): RawOptionsJson | null {
  const marker = '--- JSON ---';
  const idx = stdout.indexOf(marker);
  const jsonText = idx >= 0 ? stdout.slice(idx + marker.length) : stdout;
  const start = jsonText.indexOf('{');
  if (start < 0) return null;
  // The JSON object runs to the last closing brace in the slice.
  const end = jsonText.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(jsonText.slice(start, end + 1)) as RawOptionsJson;
  } catch {
    return null;
  }
}

/** Project the python tool's snake_case JSON onto the camelCase OptionsBlock. */
export function projectOptions(raw: RawOptionsJson): OptionsBlock {
  return {
    available: true,
    note: null,
    asOf: raw.asof ?? null,
    spot: numOrNull(raw.spot),
    numExpirations: numOrNull(raw.num_expirations),
    ivRepaired: numOrNull(raw.iv_repaired),
    termStructure: (raw.term_structure ?? []).map(p => ({
      date: p.date, dte: p.dte, atmIv: numOrNull(p.atm_iv),
    })),
    termStructureFlag: raw.term_structure_flag ?? null,
    nearAtmIv: numOrNull(raw.near_atm_iv),
    farAtmIv: numOrNull(raw.far_atm_iv),
    pcVolumeAll: numOrNull(raw.pc_volume_all),
    pcOiAll: numOrNull(raw.pc_oi_all),
    nearestExpiry: raw.nearest_expiry
      ? {
          date: raw.nearest_expiry.date,
          dte: raw.nearest_expiry.dte,
          pcVolume: numOrNull(raw.nearest_expiry.pc_volume),
          pcOi: numOrNull(raw.nearest_expiry.pc_oi),
          callVolume: numOrZero(raw.nearest_expiry.call_volume),
          putVolume: numOrZero(raw.nearest_expiry.put_volume),
          callOi: numOrZero(raw.nearest_expiry.call_oi),
          putOi: numOrZero(raw.nearest_expiry.put_oi),
        }
      : null,
    skew: raw.skew
      ? {
          pctOffset: numOrZero(raw.skew.pct_offset),
          putStrike: numOrNull(raw.skew.put_strike),
          putIv: numOrNull(raw.skew.put_iv),
          callStrike: numOrNull(raw.skew.call_strike),
          callIv: numOrNull(raw.skew.call_iv),
          skewPts: numOrNull(raw.skew.skew_pts),
        }
      : null,
  };
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}
function numOrZero(v: unknown): number {
  const n = numOrNull(v);
  return n == null ? 0 : n;
}

/**
 * Spawn the yfinance options tool and return a projected OptionsBlock.
 * NEVER throws — a spawn error / non-zero exit / unparseable stdout all
 * resolve to an honest `available:false` block so the scorecard still
 * renders the other four dimensions (ADR-044 UI correctness).
 */
async function fetchOptions(
  ticker: string,
  opts: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<OptionsBlock> {
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const py = pythonExecutable();
  return new Promise<OptionsBlock>((resolve) => {
    let child;
    try {
      child = spawnFn(py, ['scripts/yfinance_options_summary.py', ticker, '--json'], {
        windowsHide: true,
      });
    } catch (e) {
      resolve(optionsUnavailable(`options tool failed to start: ${(e as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (block: OptionsBlock) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(block);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      done(optionsUnavailable('options tool timed out (yfinance/Yahoo slow or unreachable)'));
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => {
      done(optionsUnavailable(`options tool error: ${e.message}`));
    });
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        // Exit code 2 = OptionsDataError (no listed options / Yahoo down).
        const reason = stderr.trim().split('\n').pop() || `exit ${code}`;
        done(optionsUnavailable(reason.replace(/^ERROR:\s*/, '')));
        return;
      }
      const raw = extractOptionsJson(stdout);
      if (raw == null) {
        done(optionsUnavailable('options tool returned no parseable JSON'));
        return;
      }
      done(projectOptions(raw));
    });
  });
}

// ── Fundamentals (Finnhub, optional) ────────────────────────────────────────

const FINNHUB_PHASE2_NOTE =
  'Finnhub fundamentals — phase 2 (set FINNHUB_API_KEY in .env to enable)';

function fundamentalsPlaceholder(note: string): FundamentalsBlock {
  return {
    available: false, note,
    peTtm: null, netMarginTtm: null, roeTtm: null,
    priceTargetMean: null, priceTargetHigh: null, priceTargetLow: null,
    recommendation: null,
  };
}

/**
 * Fetch Finnhub /stock/metric + /stock/price-target + /stock/recommendation.
 * Server-side HTTPS; the key is read from env and NEVER logged. Returns a
 * clean placeholder when the key is absent OR any fetch fails — fundamentals
 * is a nice-to-have and must never block the panel.
 */
async function fetchFundamentals(
  ticker: string,
  opts: { fetchFn?: typeof fetch; apiKey?: string | undefined } = {},
): Promise<FundamentalsBlock> {
  const apiKey = opts.apiKey ?? process.env.FINNHUB_API_KEY;
  if (!apiKey) return fundamentalsPlaceholder(FINNHUB_PHASE2_NOTE);
  const f = opts.fetchFn ?? fetch;
  const base = 'https://finnhub.io/api/v1';
  const q = `token=${encodeURIComponent(apiKey)}`;
  try {
    const [metricR, targetR, recR] = await Promise.all([
      f(`${base}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&${q}`),
      f(`${base}/stock/price-target?symbol=${encodeURIComponent(ticker)}&${q}`),
      f(`${base}/stock/recommendation?symbol=${encodeURIComponent(ticker)}&${q}`),
    ]);
    // Any non-2xx (rate-limit / bad key / unknown symbol) → clean placeholder.
    if (!metricR.ok && !targetR.ok && !recR.ok) {
      return fundamentalsPlaceholder('Finnhub returned no data (rate-limited or unknown symbol)');
    }
    const metric = metricR.ok ? await safeJson(metricR) : null;
    const target = targetR.ok ? await safeJson(targetR) : null;
    const recArr = recR.ok ? await safeJson(recR) : null;
    const m = (metric && typeof metric === 'object' && 'metric' in metric
      ? (metric as { metric: Record<string, unknown> }).metric
      : {}) as Record<string, unknown>;
    const rec0 = Array.isArray(recArr) && recArr.length > 0 ? recArr[0] as Record<string, unknown> : null;
    return {
      available: true,
      note: null,
      peTtm: numOrNull(m.peTTM ?? m.peBasicExclExtraTTM),
      netMarginTtm: pctToDecimal(numOrNull(m.netProfitMarginTTM)),
      roeTtm: pctToDecimal(numOrNull(m.roeTTM)),
      priceTargetMean: numOrNull((target as Record<string, unknown> | null)?.targetMean),
      priceTargetHigh: numOrNull((target as Record<string, unknown> | null)?.targetHigh),
      priceTargetLow: numOrNull((target as Record<string, unknown> | null)?.targetLow),
      recommendation: rec0
        ? {
            strongBuy: numOrZero(rec0.strongBuy),
            buy: numOrZero(rec0.buy),
            hold: numOrZero(rec0.hold),
            sell: numOrZero(rec0.sell),
            strongSell: numOrZero(rec0.strongSell),
            period: String(rec0.period ?? ''),
          }
        : null,
    };
  } catch (e) {
    // Network error — never log the key; the message can't contain it.
    return fundamentalsPlaceholder(`Finnhub fetch failed: ${(e as Error).message}`);
  }
}

async function safeJson(r: Response): Promise<unknown> {
  try { return await r.json(); } catch { return null; }
}
/** Finnhub margin/ROE come in as PERCENT (e.g. 25.3); store as decimal. */
function pctToDecimal(v: number | null): number | null {
  return v == null ? null : v / 100;
}

// ── Impure entry point ──────────────────────────────────────────────────────

export interface FetchSingleStockOptions {
  repo?: SingleStockRepository;
  /** Skip the options spawn (tests / option-less smoke). */
  skipOptions?: boolean;
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  finnhubApiKey?: string | undefined;
  now?: () => Date;
}

/**
 * Assemble the full scorecard for `ticker`. Each dimension is fetched
 * independently + guarded: a missing CH table or a failed spawn degrades
 * that one block to an honest unavailable/empty state. The function does not
 * throw on data-absence; it only throws if CH itself is unreachable (the
 * route maps that to a 503).
 */
export async function fetchSingleStockScorecard(
  ticker: string,
  opts: FetchSingleStockOptions = {},
): Promise<SingleStockScorecard> {
  const repo = opts.repo ?? new SingleStockRepository();
  const now = opts.now ?? (() => new Date());
  const asOf = now();

  // CH dimensions + options + fundamentals all run concurrently. The CH reads
  // are individually table-exists-guarded inside the repository, so a missing
  // source returns an empty block rather than throwing.
  const [technicals, positioning, macroFit, options, fundamentals] = await Promise.all([
    repo.readTechnicals(ticker, asOf),
    repo.readPositioning(ticker, asOf),
    repo.readMacroFit(ticker, asOf),
    opts.skipOptions
      ? Promise.resolve(optionsUnavailable('options fetch skipped'))
      : fetchOptions(ticker, { spawnFn: opts.spawnFn }),
    fetchFundamentals(ticker, { fetchFn: opts.fetchFn, apiKey: opts.finnhubApiKey }),
  ]);

  return {
    ticker,
    generatedAt: asOf.toISOString(),
    disclaimer:
      'Decision-support — not a validated signal (ADR-056). This is a data-aggregation ' +
      'terminal: every number traces to a free source. It does NOT recommend a trade.',
    technicals,
    options,
    positioning,
    macroFit,
    fundamentals,
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class SingleStockDashboardError extends Error {
  status: number;
  error: string;
  detail: string;
  constructor(status: number, error: string, detail: string) {
    super(`${error}: ${detail}`);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

/**
 * What could break this:
 *   - The options spawn depends on `.venv/Scripts/python.exe` + yfinance.
 *     A missing venv resolves to an honest `available:false` note, NOT a
 *     crash — but the operator sees "options tool failed to start". Set
 *     SIGNALFORGE_PYTHON to override the interpreter path.
 *   - yfinance/Yahoo is intermittently empty; the python tool exits 2 with a
 *     loud OptionsDataError that we surface verbatim as the unavailable note.
 *   - Finnhub is OFF unless FINNHUB_API_KEY is in the server env. The key is
 *     read once + passed in the query string over HTTPS; it is NEVER logged
 *     (error messages are constructed from the JS Error, which can't contain
 *     it). The free tier rate-limits at ~60/min — a 429 degrades to the
 *     clean placeholder.
 *   - extractOptionsJson assumes the tool prints `--- JSON ---` then exactly
 *     one JSON object. If the tool's output format changes, the regex-free
 *     first-`{`/last-`}` slice still recovers a single trailing object; a
 *     multi-object change would break it (pinned by a unit test).
 *   - NO ALPHA CLAIM is structural: the scorecard has no score/rank/verdict
 *     field. A future edit that adds one would contradict ADR-056 and must
 *     be escalated, not shipped.
 */
