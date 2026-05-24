/**
 * Cycle 21 (s96 #19+) smoke probe — exercises the CBOE daily-options
 * JSON endpoint that backs Q-5 Path D (see
 * `docs/analysis/q5-path-d-cboe-json-2026-05-24.md`).
 *
 * For each of the four dates the Cycle 20 research verified
 * (today's-Friday, 2026-05-22, 2020-01-02, 2019-10-07), prints:
 *   - URL
 *   - HTTP status
 *   - parsed TOTAL PUT/CALL RATIO value (or parse-error reason)
 *
 * NO writes to ClickHouse. Pure observation. Used by the orchestrator
 * in the integration gate to verify the endpoint is still up + the
 * naming hasn't drifted.
 *
 * Run: `npx tsx scripts/_probe_cboe_putcall_json.ts`
 *
 * stdlib-only (node:https + node:url) — no new TS dependencies.
 */
import { request, type RequestOptions } from 'node:https';
import { URL } from 'node:url';

interface RatiosEntry {
  name?: string;
  value?: unknown;
}

interface CboePayload {
  ratios?: RatiosEntry[];
}

interface ProbeResult {
  date: string;
  url: string;
  status: number;
  totalValue: number | null;
  error: string | null;
}

function fetchJson(rawUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const opts: RequestOptions = {
      method: 'GET',
      hostname: u.hostname,
      path: `${u.pathname}${u.search}`,
      headers: { 'User-Agent': 'SignalForge-MacroRegime/1.0' },
    };
    const req = request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('timeout after 30s'));
    });
    req.end();
  });
}

async function probe(date: string): Promise<ProbeResult> {
  const url =
    `https://cdn.cboe.com/data/us/options/market_statistics/daily/${date}_daily_options`;
  try {
    const { status, body } = await fetchJson(url);
    if (status !== 200) {
      return { date, url, status, totalValue: null, error: `HTTP ${status}` };
    }
    let payload: CboePayload;
    try {
      payload = JSON.parse(body) as CboePayload;
    } catch (e) {
      return {
        date, url, status, totalValue: null,
        error: `JSON parse failed: ${(e as Error).message}`,
      };
    }
    const ratios = payload.ratios;
    if (!Array.isArray(ratios)) {
      return {
        date, url, status, totalValue: null,
        error: `payload missing 'ratios' array (top-level keys=${Object.keys(payload).slice(0, 6).join(',')})`,
      };
    }
    const entry = ratios.find((r) => r.name === 'TOTAL PUT/CALL RATIO');
    if (entry === undefined) {
      return {
        date, url, status, totalValue: null,
        error: `no TOTAL PUT/CALL RATIO entry; names=${ratios.map((r) => r.name).join(' | ')}`,
      };
    }
    const raw = String(entry.value ?? '').trim();
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return {
        date, url, status, totalValue: null,
        error: `TOTAL value ${JSON.stringify(raw)} did not parse as finite number`,
      };
    }
    return { date, url, status, totalValue: value, error: null };
  } catch (e) {
    return {
      date, url, status: 0, totalValue: null,
      error: `network error: ${(e as Error).message}`,
    };
  }
}

async function main(): Promise<void> {
  // Today's-Friday calculation: the last weekday on or before today.
  // (Probe today directly first; if not yet a trading day, fall through.)
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dates = [
    todayStr,
    '2026-05-22',  // research-pin: TOTAL=0.85
    '2020-01-02',  // research-pin: TOTAL=0.83
    '2019-10-07',  // research-pin: first trading day after legacy freeze
  ];

  console.log('=== CBOE daily-options JSON probe (Cycle 21) ===');
  console.log('Endpoint:',
    'https://cdn.cboe.com/data/us/options/market_statistics/daily/{date}_daily_options');
  console.log('');

  for (const date of dates) {
    const r = await probe(date);
    console.log(`date=${r.date}`);
    console.log(`  url:    ${r.url}`);
    console.log(`  status: ${r.status}`);
    if (r.totalValue !== null) {
      console.log(`  TOTAL:  ${r.totalValue}`);
    } else {
      console.log(`  error:  ${r.error}`);
    }
    console.log('');
  }

  console.log('Expected reference values (locked Cycle 20):');
  console.log('  2026-05-22 TOTAL = 0.85');
  console.log('  2020-01-02 TOTAL = 0.83');
  console.log('  2019-10-07 TOTAL = 1.05');
  console.log('(Weekends + US market holidays return HTTP 403 — expected.)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
