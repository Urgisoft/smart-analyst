/**
 * End-to-end smoke test for the Path 2 validator route.
 *
 * Posts the demo CSVs (parsed in-process the same way the browser would) to
 * POST /api/validator/score on localhost:3000 and asserts the verdict shape.
 * This is what the handoff calls "browser smoke-test" minus the actual click —
 * it catches request/response/JSON wiring bugs the unit tests miss without
 * needing a human in front of the screen.
 *
 * Run with: tsx scripts/_smoke_validator_route.ts
 * Requires `npm run dev` to be running on port 3000.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseTrialReturnsCsv,
  parsePerAssetSharpesCsv,
  defaultChosenTrialId,
  defaultSplitTs,
  isCsvFailure,
} from '../src/components/validator/csvParse.js';
import type { ValidatorRequest } from '../src/lib/validator_request.js';
import type { ValidatorResult } from '../src/lib/validator.js';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';

function readCsv(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}

function buildRequest(
  csvPath: string,
  withPerAsset: boolean,
): ValidatorRequest {
  const text = readCsv(csvPath);
  const parsed = parseTrialReturnsCsv(text);
  if (isCsvFailure(parsed)) throw new Error(`parse ${csvPath}: ${parsed.error}`);
  const chosen = defaultChosenTrialId(parsed.rows);
  if (!chosen) throw new Error(`no chosen trial in ${csvPath}`);
  const split = defaultSplitTs(parsed.rows, chosen);
  if (split === null) throw new Error(`no split ts for ${csvPath}`);

  const req: ValidatorRequest = {
    trialReturns: parsed.rows,
    chosenTrialId: chosen,
    isOosSplitTs: split,
  };
  if (withPerAsset) {
    const pa = parsePerAssetSharpesCsv(readCsv('docs/fixtures/validator_demo_per_asset.csv'));
    if (isCsvFailure(pa)) throw new Error(`per-asset parse: ${pa.error}`);
    req.perAssetSharpes = pa.rows;
  }
  return req;
}

async function postScore(req: ValidatorRequest): Promise<ValidatorResult> {
  const resp = await fetch(`${BASE}/api/validator/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${detail.slice(0, 400)}`);
  }
  return resp.json() as Promise<ValidatorResult>;
}

function summarize(label: string, r: ValidatorResult): void {
  // eslint-disable-next-line no-console
  console.log(
    `\n— ${label} —\n` +
    `  verdict=${r.verdict}  pass=${r.passCount}/${r.runnableCount}\n` +
    `  headline: ${r.headlineSentence}\n` +
    `  context: trials=${r.context.nTrials} chosenRank=${r.context.chosenTrialRank} ` +
    `chosenSharpe=${r.context.chosenSharpe.toFixed(3)} bars=${r.context.nBars} ` +
    `(IS=${r.context.isBars} OOS=${r.context.oosBars})\n` +
    `  gates:\n` +
    `    DSR    ${r.gates.dsr.status.padEnd(4)} value=${r.gates.dsr.value?.toFixed(3) ?? 'null'} thr=${r.gates.dsr.threshold}\n` +
    `    OOS/IS ${r.gates.oosIs.status.padEnd(4)} value=${r.gates.oosIs.value?.toFixed(3) ?? 'null'} thr=${r.gates.oosIs.threshold}\n` +
    `    HLZ    ${r.gates.hlz.status.padEnd(4)} value=${r.gates.hlz.value?.toFixed(3) ?? 'null'} thr=${r.gates.hlz.threshold.toFixed(3)}\n` +
    `    PBO    ${r.gates.pbo.status.padEnd(4)} value=${r.gates.pbo.value?.toFixed(3) ?? 'null'} thr=${r.gates.pbo.threshold}\n` +
    (r.warnings.length > 0 ? `  warnings: ${r.warnings.length}\n${r.warnings.map(w => `    · ${w}`).join('\n')}\n` : '')
  );
}

(async () => {
  const failures: string[] = [];

  // 1. Pass fixture, parametric DSR (no per-asset)
  const passReq = buildRequest('docs/fixtures/validator_demo_pass.csv', false);
  const passRes = await postScore(passReq);
  summarize('pass fixture (parametric DSR)', passRes);
  if (passRes.verdict !== 'pass-all') failures.push(`pass fixture verdict=${passRes.verdict}, expected pass-all`);
  if (passRes.runnableCount !== 4) failures.push(`pass runnableCount=${passRes.runnableCount}, expected 4`);
  if (passRes.context.chosenTrialRank !== 1) failures.push(`pass chosenTrialRank=${passRes.context.chosenTrialRank}, expected 1`);

  // 2. Pass fixture with per-asset Sharpes — exercises bootstrap DSR path
  const passBootReq = buildRequest('docs/fixtures/validator_demo_pass.csv', true);
  const passBootRes = await postScore(passBootReq);
  summarize('pass fixture (bootstrap DSR)', passBootRes);
  if (passBootRes.verdict !== 'pass-all') failures.push(`pass-bootstrap verdict=${passBootRes.verdict}, expected pass-all`);
  const dsrMethod = (passBootRes.gates.dsr.extras as { method?: string } | undefined)?.method;
  if (dsrMethod !== 'bootstrap') failures.push(`pass-bootstrap dsr.method=${dsrMethod}, expected bootstrap`);

  // 3. Fail fixture — pure noise should not pass-all (DSR or PBO must fail)
  const failReq = buildRequest('docs/fixtures/validator_demo_fail.csv', false);
  const failRes = await postScore(failReq);
  summarize('fail fixture (pure noise)', failRes);
  if (failRes.verdict === 'pass-all') failures.push(`fail fixture verdict=pass-all, expected something else`);
  const hardFail = failRes.gates.dsr.status === 'fail' || failRes.gates.pbo.status === 'fail';
  if (!hardFail) failures.push(`fail fixture: expected DSR or PBO to fail, got DSR=${failRes.gates.dsr.status} PBO=${failRes.gates.pbo.status}`);

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`\nFAIL — ${failures.length} assertion(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('\nOK — all 3 wire-format checks passed.');
})().catch(err => {
  // eslint-disable-next-line no-console
  console.error('smoke test threw:', err);
  process.exit(1);
});
