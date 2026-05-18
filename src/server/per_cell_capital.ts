/**
 * Per-cell stage-aware capital splitter — pure helper that turns
 * (liquidBucket, activeStage, numCells, halted) into the `totalCapital` /
 * `cellCapital` numbers consumed by `sizePositionFixedRisk` per call to
 * `processCellLiveTrades`.
 *
 * SPEC: docs/specs/per-cell-stage-sizing.md (§§4-7).
 * ADR:  docs/decisions/README.md ADR-039 §1 (stage allocation table) + §2
 *       (liquid-bucket definition) + §4 (halt mechanic) + OQ #3 (correlation
 *       cap deferred — equal-weight is the pinned default this slice).
 *
 * Pure module: no clock reads, no I/O, no globals. Throws on caller bugs
 * (non-finite bucket, sub-1 / non-integer numCells, unknown stage) per
 * SPEC §7 — silent zeroes would let wire-up bugs slip past tests.
 *
 * Composition with the existing risk + drawdown stack:
 *   - `totalCapitalUsd` feeds `sizePositionFixedRisk.totalCapital`
 *     (risk-budget denominator: riskBudgetUsd = totalCapital × maxRiskPerTrade).
 *   - `cellCapitalUsd` feeds `sizePositionFixedRisk.cellCapital`
 *     (notional cap: sharesByCap = cellCapital / entryPrice).
 *   - The drawdown framework's `sizingMultiplier` (session 54) continues to
 *     multiply `maxRiskPerTrade` at the orchestrator layer; this module does
 *     NOT touch the multiplier.
 *   - HALT (this slice) zeroes `cellCapitalUsd` so the sizer returns
 *     shares-zero / bindingConstraint='zero' regardless of any newEntriesAllowed
 *     gate. `totalCapitalUsd` is preserved for honest audit (the budget that
 *     could have been deployed if not halted).
 *
 * Paper stage special case (§6.1): paper has `allocationPct=0`; multiplying
 * would zero everything. Match the existing shakedown convention used by
 * `runDaemonDrawdownEvaluation` + `runDaemonStageStateEvaluation` — paper
 * uses the WHOLE liquid bucket as the denominator (totalCapital = cellCapital
 * = liquidBucketUsd, numCells ignored).
 *
 * Equal-weight split (§11.1 ADR-extension flag): ADR-039 §1 fixes the
 * total stage allocation but does NOT specify per-strategy weights. This
 * slice ships equal-weight as the pinned default; ADR-039 OQ #3 explicitly
 * defers correlation-weighted allocation to a separate ADR. A successor
 * ADR-040 can change this without ambiguity because the rule is in one
 * place.
 */
import {
  DEPLOYMENT_STAGES,
  STAGE_ORDER,
  type DeploymentStage,
} from './capital_deployment_config.js';
import {
  computeCellWeights,
  formatCellWeightsLogLine,
  ROLLING_WINDOW_DAYS_T2,
  type CellWeightsTier,
} from './cell_weights.js';
import {
  getCellDailyReturns,
  type GetCellDailyReturnsResult,
} from './cell_pnl_history.js';

export interface ComputePerCellCapitalInputs {
  /** Operator-set "liquid SignalForge capital" bucket, USD. Must be > 0 finite. */
  liquidBucketUsd: number;
  /** Active stage from the just-evaluated stage state machine (session 55). */
  stage: DeploymentStage;
  /** Number of active cells in this daemon run. Must be ≥ 1 integer. */
  numCells: number;
  /** True iff the stage state machine emitted decision='halt' this run. */
  halted: boolean;
}

export interface ComputePerCellCapitalResult {
  /** Risk-budget denominator passed to `sizePositionFixedRisk.totalCapital`. */
  totalCapitalUsd: number;
  /** Notional cap passed to `sizePositionFixedRisk.cellCapital`. */
  cellCapitalUsd: number;
  /** Operator-visible dollar figure for the brief — same number as totalCapitalUsd. */
  stageDeployedUsd: number;
  /** Echo of the input stage. */
  stage: DeploymentStage;
  /** Echo of the input numCells. */
  numCells: number;
  /** True iff `halted` collapsed cellCapital to 0. */
  haltedZeroed: boolean;
}

/**
 * Pure entry point — see SPEC §§4-7.
 *
 * @throws on caller bugs:
 *   - liquidBucketUsd ≤ 0 or non-finite
 *   - numCells < 1 or non-integer
 *   - stage not in STAGE_ORDER
 */
export function computePerCellCapital(
  inputs: ComputePerCellCapitalInputs,
): ComputePerCellCapitalResult {
  const { liquidBucketUsd, stage, numCells, halted } = inputs;

  // SPEC §7 — caller-bug throws.
  if (!Number.isFinite(liquidBucketUsd) || liquidBucketUsd <= 0) {
    throw new Error(
      `computePerCellCapital: liquidBucketUsd must be a positive finite number, got ${liquidBucketUsd}`,
    );
  }
  if (!Number.isInteger(numCells) || numCells < 1) {
    throw new Error(
      `computePerCellCapital: numCells must be a positive integer ≥1, got ${numCells}`,
    );
  }
  if (!STAGE_ORDER.includes(stage)) {
    throw new Error(
      `computePerCellCapital: unknown stage "${String(stage)}" — must be one of ${STAGE_ORDER.join('/')}`,
    );
  }

  // SPEC §6.1 — paper stage uses the whole bucket; numCells does NOT split.
  // Matches the existing shakedown convention in runDaemonStageStateEvaluation
  // (daemon_live_trades.ts:974-977) and runDaemonDrawdownEvaluation.
  let totalCapitalUsd: number;
  let cellCapitalUsd: number;
  if (stage === 'paper') {
    totalCapitalUsd = liquidBucketUsd;
    cellCapitalUsd = liquidBucketUsd;
  } else {
    // SPEC §6.2 + §6.4 — stage allocation × bucket, equal-weight split.
    // allocationPct=0 (currently impossible on non-paper, defensive) → both 0.
    const allocationPct = DEPLOYMENT_STAGES[stage].allocationPct;
    totalCapitalUsd = liquidBucketUsd * allocationPct;
    cellCapitalUsd = totalCapitalUsd / numCells;
  }

  // SPEC §6.3 — HALT collapses cellCapitalUsd only; totalCapitalUsd preserved
  // for honest audit (what the budget WOULD have been if not halted).
  let haltedZeroed = false;
  if (halted) {
    cellCapitalUsd = 0;
    haltedZeroed = true;
  }

  return {
    totalCapitalUsd,
    cellCapitalUsd,
    stageDeployedUsd: totalCapitalUsd,
    stage,
    numCells,
    haltedZeroed,
  };
}

/**
 * Per-run orchestration helper that captures the wiring decisions identified
 * by the session 56 critic (H-1 / H-2): fail-CLOSED HALT semantics when the
 * stage eval is unavailable, OR-compose of stageHalted into the new-entries
 * gate, and the canonical mapping from stage state result → per-cell sizing
 * inputs.
 *
 * SPEC: docs/specs/per-cell-stage-sizing.md §8.1-8.4.1 + §8.5.
 *
 * The daemon (`scripts/daily_signal_daemon.ts`) calls this ONCE per run after
 * the stage eval block. Pure function — no I/O, no clock reads. Tests inject
 * `haltSentinelPresent` directly; the daemon uses
 * `defaultStageHaltSentinelReader()`.
 *
 * Critic H-2 fix: `stageEvalResult === null` means the eval threw or was
 * skipped (CH outage, table absent, drawdown framework unavailable). In that
 * case `effectiveStage` falls back to 'paper' AND `stageHalted` mirrors the
 * sentinel flag. An operator-placed sentinel MUST persist HALT through a CH
 * outage; the previous implementation silently lifted halt on transient
 * failures. Now: sentinel-on-disk → halted regardless of eval availability.
 */
export interface ResolvePerCellSizingInputs {
  /**
   * The stage state machine's result for this run, or `null` if the eval
   * threw or was skipped. When non-null, `decision` and `stageAfter` are
   * the authoritative signals (the state machine has already OR-composed
   * the sentinel internally).
   */
  stageEvalResult: {
    decision: 'hold' | 'promote' | 'rollback' | 'halt' | 'clear-halt';
    stageAfter: DeploymentStage;
  } | null;
  /**
   * True iff `.stage_halt` is present on disk. Authoritative when
   * `stageEvalResult === null`; redundant (but harmless) when it's non-null
   * because the state machine already consumed it.
   */
  haltSentinelPresent: boolean;
  /** Drawdown framework's `newEntriesAllowed` flag for this run. */
  drawdownNewEntriesAllowed: boolean;
  /** Active cell count for THIS run (after `--cells` CLI overrides). */
  numCells: number;
  /** Liquid-bucket constant, USD. From `daemon_constants.LIQUID_BUCKET_USD`. */
  liquidBucketUsd: number;
  /**
   * ADR-040 SPEC §9.2 — when provided (typically from
   * `resolveCellWeightsForRun`), the per-cell-loop's `cellCapitalUsd` is
   * routed through `perCellCapitalByCell[cellKey]` instead of the flat
   * equal-weight split. When omitted, the legacy equal-weight semantic
   * (single `perCellCapital.cellCapitalUsd` for all cells) is preserved
   * — `perCellCapitalByCell` on the result is null. SPEC §14 backward-
   * compatibility regression budget.
   */
  cellWeights?: ResolveCellWeightsResult;
}

export interface ResolvePerCellSizingResult {
  /** Effective stage the daemon should stamp on `live_trades.stage` this run. */
  effectiveStage: DeploymentStage;
  /** True iff HALT is active by any path (state machine OR sentinel-on-disk fallback). */
  stageHalted: boolean;
  /** Per-cell capital split from `computePerCellCapital`. */
  perCellCapital: ComputePerCellCapitalResult;
  /** Drawdown gate AND-composed with NOT-stage-halted (SPEC §8.4.1). */
  effectiveNewEntriesAllowed: boolean;
  /**
   * ADR-040 SPEC §9.2 — per-cell capital values keyed by cellKey, replacing
   * the single shared `perCellCapital.cellCapitalUsd` value for per-cell-
   * loop consumption. Each entry is `perCellCapital.totalCapitalUsd ×
   * cellWeights.weights.get(cellKey)`, with HALT zeroing applied AFTER the
   * weighting (SPEC §7.3 / §9.3 composition order).
   *
   * NULL when `cellWeights` is not provided — backward-compatible legacy
   * path: `processCellLiveTrades` consumers fall back to
   * `perCellCapital.cellCapitalUsd` via `resolvePerCellCellCapital`.
   */
  perCellCapitalByCell: ReadonlyMap<string, number> | null;
}

/**
 * Daemon-evaluator log-line formatter (SPEC: docs/specs/daemon-evaluator-
 * capital-retargeting.md §8.3). Pins the exact byte-format of the
 * `[evaluator-capital]` operator-visible log line so that:
 *   - The daemon's emission and the test fixture share one source of truth.
 *   - A future log refactor that drifts the format surfaces as a test failure
 *     in daemonEvaluatorCapitalRetargeting.test.ts rather than silent
 *     operator confusion.
 *
 * Format (always five fields, always this order, always these separators):
 *   `[evaluator-capital] mode=<retarget|legacy> stage=<stageX> cap=$X.XX cells=N halted=<yes|no>`
 *
 * `cap` is the value actually routed into `runStrategy(initialBalance, ...)`
 * for this run — `LIQUID_BUCKET_USD` under mode='legacy', `cellCapitalUsd`
 * under mode='retarget'. Under HALT, mode='retarget' collapses cap to $0.00
 * AND halted='yes'; mode='legacy' under HALT shows the legacy bucket and
 * halted='yes' (HALT does NOT zero the legacy capital — this is the same
 * §6.3 asymmetry as `[per-cell-capital]`: totalCapital preserved for honest
 * audit, cellCapital zeroed). Tests assert against a byte-pinned string, NOT
 * a regex (SPEC §10.5).
 */
export interface FormatEvaluatorCapitalLogLineInputs {
  mode: 'retarget' | 'legacy';
  /** Active stage echo (paper / stage1 / stage2 / stage3 / stage4). */
  stage: DeploymentStage;
  /** USD value routed into `runStrategy(initialBalance, ...)`. */
  capUsd: number;
  /** Active cell count for this daemon run. */
  numCells: number;
  /** True iff the stage state machine halted this run. */
  halted: boolean;
}

export function formatEvaluatorCapitalLogLine(
  inputs: FormatEvaluatorCapitalLogLineInputs,
): string {
  const { mode, stage, capUsd, numCells, halted } = inputs;
  return (
    `[evaluator-capital] mode=${mode} stage=${stage} ` +
    `cap=$${capUsd.toFixed(2)} cells=${numCells} ` +
    `halted=${halted ? 'yes' : 'no'}`
  );
}

/**
 * `[evaluator-risk-config]` log line — operator-facing surface for the
 * daemon-level useRiskConfig flip (`--evaluator-use-risk-config`).
 *
 * Format (always three fields, always this order, always these separators):
 *   `[evaluator-risk-config] mode=<sizer|legacy> stage=<stageX> cells=N`
 *
 * Companion to `[evaluator-capital]` — operators read both lines together to
 * see the two orthogonal flip states at a glance. Halted state is NOT
 * repeated here; it lives in the `[evaluator-capital]` line. SPEC:
 * `docs/specs/daemon-evaluator-use-risk-config.md` §8. Tests pin against a
 * byte-equal string (not a regex), so any format drift surfaces as a test
 * failure.
 */
export interface FormatEvaluatorRiskConfigLogLineInputs {
  mode: 'sizer' | 'legacy';
  stage: DeploymentStage;
  numCells: number;
}

export function formatEvaluatorRiskConfigLogLine(
  inputs: FormatEvaluatorRiskConfigLogLineInputs,
): string {
  const { mode, stage, numCells } = inputs;
  return `[evaluator-risk-config] mode=${mode} stage=${stage} cells=${numCells}`;
}

export function resolvePerCellSizingForRun(
  inputs: ResolvePerCellSizingInputs,
): ResolvePerCellSizingResult {
  // SPEC §8.1-8.2 + critic H-2 — when eval is unavailable, fail-CLOSED on
  // HALT by reading the sentinel. effectiveStage falls back to 'paper'
  // (same flat-capital behavior as pre-slice when the framework is offline).
  let effectiveStage: DeploymentStage;
  let stageHalted: boolean;
  if (inputs.stageEvalResult === null) {
    effectiveStage = 'paper';
    stageHalted = inputs.haltSentinelPresent;
  } else {
    effectiveStage = inputs.stageEvalResult.stageAfter;
    stageHalted = inputs.stageEvalResult.decision === 'halt';
  }

  const perCellCapital = computePerCellCapital({
    liquidBucketUsd: inputs.liquidBucketUsd,
    stage: effectiveStage,
    numCells: inputs.numCells,
    halted: stageHalted,
  });

  // SPEC §8.4.1 — OR-compose stage HALT into the drawdown framework's
  // new-entries gate. Stage halt operationally identical to L4/L5 from the
  // per-cell-summary perspective (skippedOpenBlocked++).
  const effectiveNewEntriesAllowed = inputs.drawdownNewEntriesAllowed && !stageHalted;

  // ADR-040 SPEC §9.2 — when cellWeights provided, split totalCapitalUsd per
  // cell-key by weight. Composition order: weights → cellCap × weight → HALT
  // zeros (matches SPEC §7.3 / §9.3). When omitted, the legacy equal-weight
  // path applies and `perCellCapitalByCell` stays null.
  let perCellCapitalByCell: Map<string, number> | null = null;
  if (inputs.cellWeights !== undefined) {
    perCellCapitalByCell = new Map();
    for (const [cellKey, w] of inputs.cellWeights.weights) {
      const v = perCellCapital.haltedZeroed ? 0 : perCellCapital.totalCapitalUsd * w;
      perCellCapitalByCell.set(cellKey, v);
    }
  }

  return {
    effectiveStage,
    stageHalted,
    perCellCapital,
    effectiveNewEntriesAllowed,
    perCellCapitalByCell,
  };
}

/**
 * ADR-040 SPEC §9.3 — composition seam between `resolvePerCellSizingForRun`'s
 * `perCellCapitalByCell` and the per-cell-loop's `processCellLiveTrades.cellCapital`
 * argument.
 *
 * Legacy path (`perCellCapitalByCell === null`): returns the shared
 * `perCellCapital.cellCapitalUsd` unchanged — backward-compatible with all
 * call sites pre-ADR-040.
 *
 * Per-cell-weights path: looks up `cellKey` in the map. A missing key is a
 * WIRE-UP BUG (mismatch between `cellRuntimes` and the `cellKeys` passed to
 * `resolveCellWeightsForRun`) — the function THROWS rather than silently
 * falling back to the equal-weight `cellCapitalUsd`. Per the SPEC §17 H-3
 * critic fix: a silent `?? cellCapitalUsd` fallback would over-allocate
 * the missing cell (potentially up to ~5×) AND break HALT zeroing for that
 * cell. Test ORCH-MISMATCH (#50a) byte-pins the throw; test ORCH-LEGACY
 * (#50b) pins the null-map passthrough.
 */
export function resolvePerCellCellCapital(
  perCellCapital: ComputePerCellCapitalResult,
  perCellCapitalByCell: ReadonlyMap<string, number> | null,
  cellKey: string,
): number {
  if (perCellCapitalByCell === null) {
    return perCellCapital.cellCapitalUsd;
  }
  const value = perCellCapitalByCell.get(cellKey);
  if (value === undefined) {
    throw new Error(
      `resolvePerCellCellCapital: cellKey "${cellKey}" missing from perCellCapitalByCell ` +
        `(map has keys: ${Array.from(perCellCapitalByCell.keys()).join(', ')}). ` +
        `Wire-up bug — cellRuntimes contains a cell that was not weighted.`,
    );
  }
  return value;
}

/**
 * ADR-040 SPEC §9.1 — daemon orchestrator that fetches per-cell daily
 * returns from `live_trades`, computes the tier-gated cell weights, and
 * formats the `[cell-weights]` operator log line in one call. Called once
 * per daemon run, AFTER the stage eval, BEFORE per-cell sizing.
 *
 * SPEC §9.6 — graceful degrade: if `getCellDailyReturns` throws (CH outage,
 * table absent), returns `tierActive='T0'` with uniform weights, `degraded=true`,
 * and a DEGRADED-suffixed log line. The DEGRADED row IS still persisted to
 * `cell_weights_history` (audit) but the §11.2 prior-tier lookup filters
 * DEGRADED rows out at read time, so a single CH outage does NOT poison the
 * ratchet (H-2 critic fix).
 */
export interface ResolveCellWeightsInputs {
  cellKeys: readonly string[];
  refDate: Date;
  /**
   * SPEC §8.2 — per-cell capital denominator for the daily-return computation.
   * For variance estimation this is invariant under uniform scaling; the
   * proxy is `LIQUID_BUCKET_USD × stage.allocationPct / numCells` (or
   * `LIQUID_BUCKET_USD` for paper). Caller passes the same number the daemon
   * uses for per-cell sizing this run — the §8.2 sensitivity-check note holds.
   */
  cellCapitalUsdProxy: number;
  /** From `cell_weights_history` FINAL WHERE degraded=0 LIMIT 1; null if no prior run. */
  priorActiveTier: CellWeightsTier | null;
  /** Test injection — defaults to `getCellDailyReturns` with the live CH client. */
  fetchDailyReturns?: (
    input: {
      cellKeys: readonly string[];
      windowDays: number;
      refDate: Date;
      cellCapitalUsdProxy: number;
    },
  ) => Promise<GetCellDailyReturnsResult>;
}

export interface ResolveCellWeightsResult {
  tierActive: CellWeightsTier;
  weights: ReadonlyMap<string, number>;
  observedDaysWithTrades: number;
  observedN: number;
  observedMinClosedTrades: number;
  ratchetHeld: boolean;
  /** True iff CH unavailable / data fetch threw (SPEC §9.6). */
  degraded: boolean;
  /** Single-line operator log per SPEC §9.5. */
  logLine: string;
}

export async function resolveCellWeightsForRun(
  inputs: ResolveCellWeightsInputs,
): Promise<ResolveCellWeightsResult> {
  const { cellKeys, refDate, cellCapitalUsdProxy, priorActiveTier } = inputs;
  const fetchDailyReturns = inputs.fetchDailyReturns ?? getCellDailyReturns;

  try {
    // SPEC §9.1 step 1 — always query the larger window so the same result
    // supports both T1 (slice last 90) and T2 (full 180) evaluation.
    const data = await fetchDailyReturns({
      cellKeys,
      windowDays: ROLLING_WINDOW_DAYS_T2,
      refDate,
      cellCapitalUsdProxy,
    });
    // SPEC §9.1 step 2 — compute weights via the pure helper. `tier: 'auto'`
    // is the only canonical production value (SPEC §4 / L-4).
    const result = computeCellWeights({
      cellKeys,
      dailyReturns: data.dailyReturns,
      closedTradeCounts: data.closedTradeCounts,
      observedDays: data.observedDays,
      tier: 'auto',
      priorActiveTier,
    });
    const logLine = formatCellWeightsLogLine({
      tierActive: result.tierActive,
      weights: result.weights,
      observedDaysWithTrades: result.observedDaysWithTrades,
      observedMinClosedTrades: result.observedMinClosedTrades,
      ratchetHeld: result.ratchetHeld,
      degraded: false,
    });
    return {
      tierActive: result.tierActive,
      weights: result.weights,
      observedDaysWithTrades: result.observedDaysWithTrades,
      observedN: result.observedN,
      observedMinClosedTrades: result.observedMinClosedTrades,
      ratchetHeld: result.ratchetHeld,
      degraded: false,
      logLine,
    };
  } catch {
    // SPEC §9.6 — DEGRADED fallback. Uniform weights over cellKeys; the
    // DEGRADED row IS persisted to cell_weights_history (audit), but the
    // §11.2 prior-tier lookup filters degraded=1 rows so the ratchet
    // survives a single CH outage (H-2 critic fix).
    const uniformWeight = 1 / Math.max(1, cellKeys.length);
    const weights = new Map<string, number>();
    for (const k of cellKeys) weights.set(k, uniformWeight);
    const tierActive: CellWeightsTier = 'T0';
    const logLine = formatCellWeightsLogLine({
      tierActive,
      weights,
      observedDaysWithTrades: 0,
      observedMinClosedTrades: 0,
      ratchetHeld: false,
      degraded: true,
    });
    return {
      tierActive,
      weights,
      observedDaysWithTrades: 0,
      observedN: cellKeys.length,
      observedMinClosedTrades: 0,
      ratchetHeld: false,
      degraded: true,
      logLine,
    };
  }
}

/**
 * What could break this:
 *  - Caller passes `liquidBucketUsd` from a different source than the brief
 *    composer uses (BRIEF_LIQUID_BUCKET_USD). The two surfaces would render
 *    inconsistent dollar figures. SPEC §9.2 + §14 flag this — operator
 *    discipline keeps both constants in sync. A future config-file refactor
 *    is the right place to unify the source of truth.
 *  - Caller passes `numCells` from a stale snapshot of `DEFAULT_CELLS` while
 *    the daemon parses `--cells` overrides. Inconsistency would split capital
 *    against the wrong denominator. Mitigation: the daemon log line
 *    `[per-cell-capital] cells=N` surfaces the count every run; an
 *    unexpected change is the early warning.
 *  - A future ADR-040 adds an interim stage with `allocationPct=0` (e.g. a
 *    pause stage). The pure helper produces totalCapital=0 and cellCapital=0;
 *    the sizer returns shares-zero. That's the correct "no new opens"
 *    behavior, but it would also produce $0 in the brief's deployed-line.
 *    Brief consumer should distinguish "halted" from "stage allocation=0"
 *    if both are operationally distinct in the new policy.
 *  - Caller passes `halted=true` for an operator-cleared HALT in the same
 *    daemon run. Per session 55's halt-clearing semantics, a `clear-halt`
 *    row IN PRIOR HISTORY changes the eval's decision back to non-halt;
 *    the daemon orchestrator MUST read `state.decision` from the CURRENT
 *    run's result, not infer from sentinel presence alone. The pure helper
 *    trusts the boolean.
 *  - Floating-point precision on the division `totalCapitalUsd / numCells`:
 *    for numCells=3, $500 split is $166.6666... not $166.67. The sizer
 *    floors share count, not capital, so the float pass-through is fine;
 *    tests assert exact equality on Math.div results, not on rounded
 *    dollars. Don't add rounding here; it would obscure the source of
 *    drift if a future change introduces dollar-level inconsistency.
 *  - The function does NOT compose with the drawdown framework's
 *    sizingMultiplier directly. Multiplying cellCapital by the framework
 *    multiplier would DOUBLE-count it (the multiplier already reduces
 *    maxRiskPerTrade; halving cellCapital on top would compound). Keep the
 *    composition responsibility at the orchestrator: this slice owns
 *    cellCapital, drawdown framework owns maxRiskPerTrade multiplier.
 */
