/**
 * Input parsing + validation for POST /api/validator/score.
 *
 * Spec: SPEC §1 of the Path 2 validator UI (conversation 2026-05-02). The test suite
 * `scripts/tests/validator_request.test.ts` is the binding contract — read those tests
 * before changing any reject condition here.
 *
 * The parser's job is to produce a structurally sound `ValidatorRequest` for the
 * orchestrator (`validator.ts`), or a precise failure telling the user what to fix.
 * It does NOT run any gate math. It does NOT enforce payload size — Express's
 * `express.json({ limit: '50mb' })` handles that and auto-returns 413.
 */

export interface TrialReturnRow {
  /** Trial identifier — typically a parameter signature like "lookback=42_thresh=2.0". */
  trialId: string;
  /** UNIX seconds. All trials in the request must share the same timestamp grid. */
  ts: number;
  /** Decimal return (0.012 = 1.2%), NOT percent. The parser rejects rows that look
   *  like percent units to keep downstream metrics interpretable. */
  ret: number;
}

export interface ValidatorRequest {
  trialReturns: TrialReturnRow[];
  chosenTrialId: string;
  isOosSplitTs: number;
  perAssetSharpes?: { assetId: string; sharpe: number }[];
  trialTradeCounts?: Record<string, number>;
  thresholds?: {
    dsrGate?: number;
    pboGate?: number;
    pardoGate?: number;
    hlzAlpha?: number;
    hlzMethod?: 'bhy' | 'bonferroni' | 'holm';
  };
}

export type ParseOutcome =
  | { ok: true; value: ValidatorRequest }
  | { ok: false; status: number; error: string; detail: string };

/** Type guard for the failure branch of ParseOutcome. Explicit guard required because
 *  the project's tsconfig has `strict: false`, which weakens discriminated-union narrowing
 *  on plain `!parsed.ok` checks. */
export function isParseFailure(
  o: ParseOutcome,
): o is { ok: false; status: number; error: string; detail: string } {
  return !o.ok;
}

/** A trial with fewer bars than this is rejected — too short for any of the gates
 *  to produce a meaningful number. Matches the smallest reasonable IS or OOS window. */
export const MIN_BARS_PER_TRIAL = 30;
export const MIN_BARS_PER_SPLIT_SIDE = 30;
/** Mean |return| > this on the chosen trial almost certainly means percent units. A
 *  daily strategy averaging > 50% per-bar return is not a real strategy; it's a unit bug. */
export const RETURNS_LIKELY_PERCENT_THRESHOLD = 0.5;

export function parseValidatorRequest(body: unknown): ParseOutcome {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'malformed_body', 'Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.trialReturns)) {
    return fail(400, 'trial_returns_missing', 'trialReturns[] is required.');
  }
  if (typeof b.chosenTrialId !== 'string' || b.chosenTrialId.length === 0) {
    return fail(400, 'chosen_trial_id_missing', 'chosenTrialId (non-empty string) is required.');
  }
  if (typeof b.isOosSplitTs !== 'number' || !Number.isFinite(b.isOosSplitTs)) {
    return fail(400, 'split_ts_missing', 'isOosSplitTs (number, UNIX seconds) is required.');
  }

  // Row-level type validation. Linear pass; aborts on first malformed row.
  const trialReturns: TrialReturnRow[] = [];
  const trialIds = new Set<string>();
  for (let i = 0; i < b.trialReturns.length; i++) {
    const r = b.trialReturns[i];
    if (!r || typeof r !== 'object') {
      return fail(400, 'trial_row_malformed', `trialReturns[${i}] is not an object.`);
    }
    const row = r as Record<string, unknown>;
    if (
      typeof row.trialId !== 'string' || row.trialId.length === 0 ||
      typeof row.ts !== 'number' || !Number.isFinite(row.ts) ||
      typeof row.ret !== 'number' || !Number.isFinite(row.ret)
    ) {
      return fail(400, 'trial_row_malformed',
        `trialReturns[${i}] needs (trialId:string, ts:finite number, ret:finite number).`);
    }
    trialReturns.push({ trialId: row.trialId, ts: row.ts, ret: row.ret });
    trialIds.add(row.trialId);
  }

  if (!trialIds.has(b.chosenTrialId)) {
    return fail(400, 'chosen_trial_id_not_found',
      `chosenTrialId "${b.chosenTrialId}" not found in trialReturns.`);
  }
  if (trialIds.size < 2) {
    return fail(400, 'pbo_requires_multiple_trials',
      'At least 2 distinct trialId values are required (PBO/HLZ are unrunnable on a single trial).');
  }

  // Group + sort per trial. CSCV needs aligned columns, so we sort each trial by ts
  // and then verify alignment across trials.
  const perTrial = new Map<string, TrialReturnRow[]>();
  for (const row of trialReturns) {
    const list = perTrial.get(row.trialId);
    if (list) list.push(row); else perTrial.set(row.trialId, [row]);
  }
  for (const list of perTrial.values()) list.sort((a, b) => a.ts - b.ts);

  const tooShort: string[] = [];
  for (const [id, list] of perTrial) {
    if (list.length < MIN_BARS_PER_TRIAL) tooShort.push(id);
  }
  if (tooShort.length > 0) {
    const sample = tooShort.slice(0, 5).join(', ');
    const more = tooShort.length > 5 ? `, +${tooShort.length - 5} more` : '';
    return fail(400, 'trial_too_short',
      `Trials with < ${MIN_BARS_PER_TRIAL} bars: ${sample}${more}.`);
  }

  // Timestamp alignment: every trial must have an identical ts sequence to the chosen trial.
  // CSCV is fragile to misalignment — see cscv.ts "What could break this" note.
  const refTs = perTrial.get(b.chosenTrialId)!.map(r => r.ts);
  for (const [id, list] of perTrial) {
    if (id === b.chosenTrialId) continue;
    if (list.length !== refTs.length) {
      return fail(400, 'trial_timestamps_misaligned',
        `Trial "${id}" has ${list.length} bars; chosen trial has ${refTs.length}.`);
    }
    for (let i = 0; i < refTs.length; i++) {
      if (list[i].ts !== refTs[i]) {
        return fail(400, 'trial_timestamps_misaligned',
          `Trial "${id}" timestamp mismatch at row ${i}: ${list[i].ts} vs ${refTs[i]}.`);
      }
    }
  }

  const minTs = refTs[0], maxTs = refTs[refTs.length - 1];
  if (b.isOosSplitTs <= minTs || b.isOosSplitTs > maxTs) {
    return fail(400, 'split_outside_data_range',
      `isOosSplitTs=${b.isOosSplitTs} outside chosen trial range [${minTs}, ${maxTs}].`);
  }
  let isCount = 0, oosCount = 0;
  for (const ts of refTs) {
    if (ts < b.isOosSplitTs) isCount++; else oosCount++;
  }
  if (isCount < MIN_BARS_PER_SPLIT_SIDE || oosCount < MIN_BARS_PER_SPLIT_SIDE) {
    return fail(400, 'split_window_too_small',
      `Need >= ${MIN_BARS_PER_SPLIT_SIDE} bars per side; got IS=${isCount}, OOS=${oosCount}.`);
  }

  // Percent-vs-decimal sanity check — guards the silent 100x-error case where a user
  // pastes "1.2" meaning 1.2% but the math treats it as 120%.
  const chosenRows = perTrial.get(b.chosenTrialId)!;
  let absSum = 0;
  for (const r of chosenRows) absSum += Math.abs(r.ret);
  const meanAbs = absSum / chosenRows.length;
  if (meanAbs > RETURNS_LIKELY_PERCENT_THRESHOLD) {
    return fail(400, 'returns_likely_in_percent_not_decimal',
      `Chosen trial mean |return|=${meanAbs.toFixed(3)} suggests percent units; convert to decimal (1.2% → 0.012).`);
  }

  const perAssetParsed = parsePerAssetSharpes(b.perAssetSharpes);
  if (isParseError(perAssetParsed)) {
    return fail(400, perAssetParsed.error, perAssetParsed.detail);
  }
  const tradeCountsParsed = parseTradeCounts(b.trialTradeCounts);
  if (isParseError(tradeCountsParsed)) {
    return fail(400, tradeCountsParsed.error, tradeCountsParsed.detail);
  }
  const thresholdsParsed = parseThresholds(b.thresholds);
  if (isParseError(thresholdsParsed)) {
    return fail(400, thresholdsParsed.error, thresholdsParsed.detail);
  }

  return {
    ok: true,
    value: {
      trialReturns,
      chosenTrialId: b.chosenTrialId,
      isOosSplitTs: b.isOosSplitTs,
      perAssetSharpes: perAssetParsed as ValidatorRequest['perAssetSharpes'],
      trialTradeCounts: tradeCountsParsed as ValidatorRequest['trialTradeCounts'],
      thresholds: thresholdsParsed as ValidatorRequest['thresholds'],
    },
  };
}

function fail(status: number, error: string, detail: string): ParseOutcome {
  return { ok: false, status, error, detail };
}

type ParseError = { error: string; detail: string };

/** Type guard distinguishing a ParseError from a structurally similar Record<string, unknown>.
 *  `'error' in v` alone doesn't narrow safely because Record<string, anything> can nominally
 *  have an 'error' key — we need to check the value's type to discriminate. */
function isParseError(v: unknown): v is ParseError {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as { error?: unknown }).error === 'string' &&
    typeof (v as { detail?: unknown }).detail === 'string'
  );
}

function parsePerAssetSharpes(
  v: unknown,
): { assetId: string; sharpe: number }[] | undefined | ParseError {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return { error: 'per_asset_sharpes_malformed', detail: 'perAssetSharpes must be an array.' };
  const out: { assetId: string; sharpe: number }[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = v[i];
    if (!r || typeof r !== 'object') {
      return { error: 'per_asset_sharpes_malformed', detail: `perAssetSharpes[${i}] must be {assetId, sharpe}.` };
    }
    const row = r as Record<string, unknown>;
    if (typeof row.assetId !== 'string' || row.assetId.length === 0 ||
        typeof row.sharpe !== 'number' || !Number.isFinite(row.sharpe)) {
      return { error: 'per_asset_sharpes_malformed',
        detail: `perAssetSharpes[${i}] needs (assetId:non-empty string, sharpe:finite number).` };
    }
    out.push({ assetId: row.assetId, sharpe: row.sharpe });
  }
  return out;
}

function parseTradeCounts(v: unknown): Record<string, number> | undefined | ParseError {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'trade_counts_malformed', detail: 'trialTradeCounts must be a {trialId: number} object.' };
  }
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      return { error: 'trade_counts_malformed',
        detail: `trialTradeCounts["${k}"] must be a non-negative finite number.` };
    }
    out[k] = val;
  }
  return out;
}

function parseThresholds(v: unknown): ValidatorRequest['thresholds'] | ParseError {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'thresholds_malformed', detail: 'thresholds must be an object.' };
  }
  const t = v as Record<string, unknown>;
  const out: NonNullable<ValidatorRequest['thresholds']> = {};
  for (const key of ['dsrGate', 'pboGate', 'pardoGate', 'hlzAlpha'] as const) {
    if (t[key] !== undefined) {
      if (typeof t[key] !== 'number' || !Number.isFinite(t[key] as number)) {
        return { error: 'thresholds_malformed', detail: `thresholds.${key} must be a finite number.` };
      }
      out[key] = t[key] as number;
    }
  }
  if (t.hlzMethod !== undefined) {
    if (t.hlzMethod !== 'bhy' && t.hlzMethod !== 'bonferroni' && t.hlzMethod !== 'holm') {
      return { error: 'thresholds_malformed',
        detail: 'thresholds.hlzMethod must be one of: bhy, bonferroni, holm.' };
    }
    out.hlzMethod = t.hlzMethod;
  }
  return out;
}

/*
 * What could break this:
 * - The percent-vs-decimal heuristic is a one-sided guard. Someone with truly extreme
 *   per-bar returns (e.g. a leveraged perp strategy with 60% peak bars) would trip the
 *   rejection. Acceptable false-positive rate for v1; if it bites a real user, lift the
 *   threshold and add a separate `unitsAcknowledged: true` opt-in.
 * - Timestamp alignment is exact-match. Two trials produced from the same dataset but
 *   with one bar of warmup difference will misalign, even though "shifted by one bar"
 *   is benign. The right fix is to trim trials to a common-overlap range before
 *   alignment — deferred to v1.1 (SPEC §1.5 mentions it as graceful degrade, not yet
 *   implemented here).
 * - Memory: trialReturns is held in a JS array of objects (one heap obj per row).
 *   For 5M rows that's ~600MB of object overhead vs ~120MB if we used parallel typed
 *   arrays. v1 prioritizes shape clarity over throughput; revisit if real users hit
 *   M*T > 1M.
 */
