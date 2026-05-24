/**
 * Insert the Q-6 ETF v1 yfinance primary panel `accepted-as-warning` pin row
 * (S96-89 / Cycle 12) into `quantlab.health_quarantine`.
 *
 * Why a separate migration (not extending `migrate_create_health_quarantine`):
 *   The Q-5 CBOE pin row is bundled with the table CREATE because both
 *   originate from ADR-045 ratification (s96 #15 Cycle 1). The Q-6 ETF SHO
 *   regression is a Cycle 12 finding; bundling it into the create-table
 *   migration would couple two unrelated discoveries into a single
 *   apply-and-pre-check shape. Pattern matches `migrate_create_health_
 *   quarantine_alerts_sent.ts` (separate migration for a separate concern).
 *
 * Why pure pin-row INSERT (no DDL):
 *   The table is created by `migrate:create-health-quarantine:apply` which
 *   the operator has already run (Cycle 3). This script's pre-check
 *   verifies the table exists and aborts if it doesn't; it does not attempt
 *   to recreate it. Forward-only additive; idempotent via the
 *   ReplacingMergeTree(version) engine on `id`.
 *
 * Provenance:
 *   - HANDOFF S96-89: Yahoo broke `Ticker.get_shares_full` for ETFs
 *     (~2026); yfinance 1.4.0 doesn't fix it; the v1 primary panel
 *     `quantlab.etf_shares_outstanding` cannot be backfilled from
 *     yfinance until Yahoo restores OR operator resolves Q-6.
 *   - Operator queue Q-6: methodology amendment (B), paid-data
 *     subscription (A), or accept-as-warning indefinitely (C). Same shape
 *     as Q-5 path-space after Cycle 11's CBOE source-freeze finding.
 *   - ADR placeholder: Q-6-pending — the ADR (ADR-048 or similar) is
 *     drafted once the operator picks among A/B/C. Until then the
 *     pin row carries `adr_ref = 'Q-6-pending'` so the /#/health
 *     panel's adr-link column degrades gracefully.
 *
 * Usage:
 *   npm run migrate:insert-q6-etf-sho-pin              # dry-run
 *   npm run migrate:insert-q6-etf-sho-pin:apply        # INSERT
 *
 * What could break this:
 *   - If the `health_quarantine` table is dropped + recreated, the post-
 *     check will fail on the next apply because Q-5 will be the only
 *     pin row present. Mitigation: the create-table migration is
 *     forward-only additive (no DROP); this concern is hypothetical.
 *   - The deterministic UUID seed pins (kind, sourceTable, category,
 *     adrRef). If any of those four fields change in the source code,
 *     the next apply will insert a DUPLICATE row under a different id
 *     (the old row stays accepted-as-warning, the new one shows up too).
 *     Mitigation: byte-pin test in `migrateInsertQ6EtfShoPin.test.ts`
 *     fails CI if any seed field changes.
 *   - If Yahoo RESTORES the ETF SHO endpoint, the row should be moved
 *     to `status = 'corrected'`. This is operator-cadence; the ingest
 *     will start returning rows again and the daemon step 1jb will
 *     populate the primary table. The row remains for audit history.
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';
import {
  DATABASE,
  TABLE,
  computePinRowId,
  type PinRowPayload,
} from './migrate_create_health_quarantine.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:insert-q6-etf-sho-pin',
    category: 'Data quality',
    what:
      'Dry-run: show the planned Q-6 yfinance ETF SHO regression pin row insert ' +
      '(Cycle 12 / S96-89) into quantlab.health_quarantine. No INSERT executed.',
  },
  {
    npm: 'migrate:insert-q6-etf-sho-pin:apply',
    category: 'Data quality',
    what:
      'APPLY the Q-6 yfinance ETF SHO regression pin row. Idempotent ' +
      'deterministic-id INSERT; ReplacingMergeTree dedups re-applies.',
  },
];

// ── Q-6 pin row ────────────────────────────────────────────────────────────

/**
 * Q-6 ETF v1 yfinance primary panel `accepted-as-warning` pin row.
 *
 * `category = 'upstream-source-regression'` — distinct from Q-5's
 * `corrupted-input-window`. Q-5 was "the data exists but is stale"; Q-6 is
 * "the data source returned an empty endpoint" — a different category of
 * health concern that warrants a distinct label so the operator's filtering
 * on /#/health can separate them.
 *
 * `adr_ref = 'Q-6-pending'` — no ADR ratified yet. Future cycle will draft
 * ADR-048 (or similar) once the operator picks among A/B/C paths.
 *
 * `detectedAt` = 2026-05-24T00:00:00.000Z — Cycle 12 discovery date.
 */
export const Q6_PIN_ROW: Omit<PinRowPayload, 'sourceTable' | 'category' | 'adrRef'> & {
  sourceTable: 'etf_shares_outstanding';
  category: 'upstream-source-regression';
  adrRef: 'Q-6-pending';
} = {
  kind: 'tier2-quarantine',
  sourceTable: 'etf_shares_outstanding',
  sourceLabel: 'ETF v1 yfinance primary panel',
  severity: 'warning',
  category: 'upstream-source-regression',
  offendingValue:
    '0 rows; Yahoo Ticker.get_shares_full returns empty for all 21 F-UNIVERSE ETFs; equities (AAPL, MSFT) still work; yfinance 1.4.0 does not fix; Yahoo-side regression',
  expectedRange: 'daily refresh; v1 primary panel covers F-UNIVERSE (21 ETFs) over trailing 400d window per scripts/etf_flow_ingest.py DEFAULT_LOOKBACK_DAYS',
  explanation:
    'ETF v1 yfinance primary panel cannot be populated. Yahoo broke `Ticker.get_shares_full` for ETFs in ~2026 (the endpoint returns empty Series for SPY/QQQ/TLT/XLK/etc. while still working for equities AAPL/MSFT). yfinance 1.4.0 also returns empty, so this is a Yahoo-side data-source regression, not a library bug. The /#/etf-flow cross-validation comparator is currently single-source (v3.1 SSGA secondary only); the comparator pathology described in GAP-4 (s96 #16 Cycle 2) is REVERSED — the primary is now permanently empty instead of operator-cadence stale.',
  operatorAction:
    'Pick operator queue Q-6 path: (A) paid Sharadar/Polygon ETF SHO subscription — only path that restores fresh ETF SHO data; (B) methodology amendment — promote v3.1 SSGA secondary to primary, drop the 9 non-SPDR tickers (IVV/VOO/QQQ/IWM/DIA/HYG/JNK/TLT/GLD) from F-UNIVERSE, draft ADR-048; or (C) keep `accepted-as-warning` indefinitely (cross-validation degraded). Orchestration recommendation: (C) now + (B) when etf-flow v3.x is next iterated. Path (D) "Yahoo restores the endpoint" is monitored by the daemon step 1jb anomaly — when ingest starts succeeding again, mark this row `corrected`.',
  status: 'accepted-as-warning',
  cycleRef: 's96 #17 Cycle 12',
  adrRef: 'Q-6-pending',
  detectedAt: '2026-05-24T00:00:00.000Z',
};

/** Deterministic UUID for the Q-6 pin row. Same algorithm as Q-5. */
export const Q6_PIN_ROW_ID = computePinRowId({
  kind: Q6_PIN_ROW.kind,
  sourceTable: Q6_PIN_ROW.sourceTable,
  category: Q6_PIN_ROW.category,
  adrRef: Q6_PIN_ROW.adrRef,
});

// ── argv helper ────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

// ── Pre / post checks ──────────────────────────────────────────────────────

export interface PreCheckResult {
  ok: boolean;
  tablePresent: boolean;
  reason?: string;
}

export async function runPreChecks(ch: ClickHouseClient): Promise<PreCheckResult> {
  const tableQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.tables ` +
      `WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: DATABASE, tbl: TABLE },
    format: 'JSONEachRow',
  });
  const tableRows = await tableQ.json<{ n: string | number }>();
  const tablePresent = Number(tableRows[0]?.n ?? 0) > 0;
  if (!tablePresent) {
    return {
      ok: false, tablePresent: false,
      reason:
        `${DATABASE}.${TABLE} does not exist. Run ` +
        `\`npm run migrate:create-health-quarantine:apply\` first.`,
    };
  }
  return { ok: true, tablePresent: true };
}

export interface PostCheckResult {
  ok: boolean;
  pinRowPresent: boolean;
  reason?: string;
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const pinQ = await ch.query({
    query:
      `SELECT count() AS n FROM ${DATABASE}.${TABLE} FINAL ` +
      `WHERE id = {id:UUID}`,
    query_params: { id: Q6_PIN_ROW_ID },
    format: 'JSONEachRow',
  });
  const pinRows = await pinQ.json<{ n: string | number }>();
  const pinRowPresent = Number(pinRows[0]?.n ?? 0) > 0;
  if (!pinRowPresent) {
    return {
      ok: false, pinRowPresent: false,
      reason: `Q-6 pin row (id=${Q6_PIN_ROW_ID}) missing after insert.`,
    };
  }
  return { ok: true, pinRowPresent: true };
}

// ── Insert ─────────────────────────────────────────────────────────────────

async function insertPinRow(ch: ClickHouseClient): Promise<void> {
  await ch.insert({
    table: `${DATABASE}.${TABLE}`,
    values: [{
      id: Q6_PIN_ROW_ID,
      detected_at: chDateTimeString(Q6_PIN_ROW.detectedAt),
      kind: Q6_PIN_ROW.kind,
      source_table: Q6_PIN_ROW.sourceTable,
      source_label: Q6_PIN_ROW.sourceLabel,
      severity: Q6_PIN_ROW.severity,
      category: Q6_PIN_ROW.category,
      offending_value: Q6_PIN_ROW.offendingValue,
      expected_range: Q6_PIN_ROW.expectedRange,
      explanation: Q6_PIN_ROW.explanation,
      operator_action: Q6_PIN_ROW.operatorAction,
      status: Q6_PIN_ROW.status,
      cycle_ref: Q6_PIN_ROW.cycleRef,
      adr_ref: Q6_PIN_ROW.adrRef,
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Convert ISO 8601 ('2026-05-24T00:00:00.000Z') to the CH DateTime literal
 * the JSONEachRow inserter accepts ('2026-05-24 00:00:00'). Inlined from
 * `migrate_create_health_quarantine.ts` (the original is not exported).
 */
function chDateTimeString(iso: string): string {
  const dropMillis = iso.replace(/\.\d{3}/, '');
  return dropMillis.replace('T', ' ').replace('Z', '');
}

// ── Dry-run + apply ────────────────────────────────────────────────────────

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table present:       ${pre.tablePresent ? '✓' : '✗'}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 1;
  }
  console.log('\n--- Planned Q-6 pin row (NOT inserted in dry-run) ---');
  console.log(`  id:              ${Q6_PIN_ROW_ID}`);
  console.log(`  kind:            ${Q6_PIN_ROW.kind}`);
  console.log(`  source_table:    ${Q6_PIN_ROW.sourceTable}`);
  console.log(`  source_label:    ${Q6_PIN_ROW.sourceLabel}`);
  console.log(`  severity:        ${Q6_PIN_ROW.severity}`);
  console.log(`  category:        ${Q6_PIN_ROW.category}`);
  console.log(`  status:          ${Q6_PIN_ROW.status}`);
  console.log(`  adr_ref:         ${Q6_PIN_ROW.adrRef}`);
  console.log(`  cycle_ref:       ${Q6_PIN_ROW.cycleRef}`);
  console.log(`  detected_at:     ${Q6_PIN_ROW.detectedAt}`);
  console.log('\n(Re-run with `:apply` to execute INSERT.)');
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.error(`✗ Pre-checks failed: ${pre.reason}`);
    return 1;
  }
  console.log('--- Inserting Q-6 yfinance ETF SHO regression pin row ---');
  console.log(`  id:           ${Q6_PIN_ROW_ID}`);
  console.log(`  source_table: ${Q6_PIN_ROW.sourceTable}`);
  console.log(`  category:     ${Q6_PIN_ROW.category}`);
  console.log(`  status:       ${Q6_PIN_ROW.status}`);
  const tInsert = Date.now();
  await insertPinRow(ch);
  console.log(`  INSERT completed in ${Date.now() - tInsert}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(`✓ Q-6 pin row present (idempotent via ReplacingMergeTree).`);
  return 0;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  const ch = getClickHouse();
  await pingClickHouse();
  return apply ? runApply(ch) : runDryRun(ch);
}

if (isMain(import.meta.url)) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
