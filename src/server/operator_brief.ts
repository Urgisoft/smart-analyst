/**
 * Track C / Component 4 — operator morning brief composer.
 *
 * Pulls today's regime, kill-criteria verdicts, last daemon-run state, and
 * watch-list candidates from ClickHouse and assembles a typed MorningBrief
 * object. The actual markdown rendering lives in
 * src/server/operator_brief_render.ts (pure).
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §3.
 *
 * `composeMorningBrief(deps?)` accepts dependency injection so tests can
 * stub the four data sources. The production default uses live ClickHouse.
 *
 * The bias note must NEVER be paraphrased. We pull it from
 * regime_dashboard.ts where Component 3 owns the canonical constant
 * (`BIAS_NOTE_PHASE1_V3` is the live banner under classifier_version=
 * phase1_v3; `BIAS_NOTE_PHASE1_V2` remains exported for archival
 * references). A single source of truth for both Components 3 and 4.
 */
import {
  fetchRegimeState,
  type RegimeStateResponse,
  LOOKBACK_DAYS_DEFAULT,
} from './regime_dashboard.js';
import {
  fetchPaperTradingState,
  type PaperTradingResponse,
} from './paper_trading_dashboard.js';
import { evaluateKillCriteria } from './paper_trading_kill_criteria.js';
import { LiveTradeRepository, type LiveTradeRow } from './live_trade_repository.js';
import { CLASSIFIER_VERSION } from './macro_regime.js';
import { getClickHouse } from './clickhouse.js';
import {
  DrawdownStateRepository,
  drawdownStateHasBundleIdColumn,
  drawdownStateHistoryTableExists,
} from './drawdown_state_repository.js';
import {
  computeNewEntriesAllowed,
  reviewRequirementForLevel,
  sizingMultiplierForLevel,
  type DrawdownStateRow,
} from './drawdown_state.js';
import {
  StageStateRepository,
  stageStateHistoryTableExists,
} from './stage_state_repository.js';
import type { StageStateRow } from './stage_state.js';
import { killCriteriaDailyTableExists } from './kill_criteria_daily_repository.js';
import {
  CyclePositionRepository,
  cyclePositionSnapshotsTableExists,
} from './cycle_position_repository.js';
import type { CyclePositionSnapshot } from './cycle_position.js';
import {
  VolStructureRepository,
  volStructureSnapshotsTableExists,
} from './vol_structure_repository.js';
import type { VolStructureSnapshot } from './vol_structure.js';
import {
  SectorRotationRepository,
  sectorRotationSnapshotsTableExists,
} from './sector_rotation_repository.js';
import type { SectorRotationSnapshot } from './sector_rotation.js';
import {
  CrossAssetSignalsRepository,
  crossAssetSnapshotsTableExists,
} from './cross_asset_signals_repository.js';
import type { CrossAssetSignalsSnapshot } from './cross_asset_signals.js';
import {
  ShortInterestRepository,
  shortInterestSnapshotsTableExists,
} from './short_interest_repository.js';
import type { ShortInterestSnapshot } from './short_interest.js';
import {
  ExecutiveDepartureRepository,
  executiveDepartureSnapshotsTableExists,
} from './executive_departure_repository.js';
import type { ExecutiveDepartureSnapshot } from './executive_departure.js';
import {
  EtfFlowRepository,
  etfFlowSnapshotsTableExists,
} from './etf_flow_repository.js';
import type { EtfFlowSnapshot } from './etf_flow.js';
import {
  EightKClassifierRepository,
  eightKClassifierSnapshotsTableExists,
} from './eight_k_classifier_repository.js';
import type { EightKClassifierSnapshot } from './eight_k_classifier.js';
import {
  Form4InsiderRepository,
  form4InsiderSnapshotsTableExists,
} from './form_4_insider_repository.js';
import type { Form4InsiderSnapshot } from './form_4_insider.js';
import { DEPLOYMENT_STAGES } from './capital_deployment_config.js';
import {
  computePerCellCapital,
  resolveCellWeightsForRun,
  type ResolveCellWeightsResult,
} from './per_cell_capital.js';
import { loadPriorActiveCellWeightsTier } from './cell_weights_history_repo.js';
import { LIQUID_BUCKET_USD } from './daemon_constants.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  MorningBrief,
  BriefAnomaly,
  BriefCrossAssetSection,
  BriefCyclePositionSection,
  BriefDaemonSection,
  BriefDrawdownSection,
  BriefDrawdownStrategyRow,
  BriefEightKClassifierSection,
  BriefForm4InsiderSection,
  BriefEtfFlowSection,
  BriefExecutiveDepartureSection,
  BriefSectorRotationSection,
  BriefShortInterestSection,
  BriefStageSection,
  BriefVolStructureSection,
  BriefWatchlistItem,
} from './operator_brief_render.js';

/** A2 kill threshold (per SPEC §2.5 + session-32 lock-in). Used for distance ranking. */
const A2_KILL_THRESHOLD_PCT = -64.37;

/** Watch-list distance threshold (closer than this → qualifies). */
const WATCHLIST_DISTANCE_PCT = 0.5;

/** Watch-list bars-held threshold (above this → qualifies regardless of distance). */
const WATCHLIST_BARS_HELD = 100;

/** Watch-list section cap. */
const WATCHLIST_TOP_N = 3;

/**
 * Operator-set "liquid SignalForge capital" bucket, USD. Re-exported from
 * the leaf module `daemon_constants.ts` so both the daemon and the brief
 * read from one source of truth — critic M-2 fix (session 56) eliminates
 * the drift risk the original SPEC §14 had deferred to operator discipline.
 */
export const BRIEF_LIQUID_BUCKET_USD = LIQUID_BUCKET_USD;

/**
 * Active cell count, used by the brief to render per-cell dollar splits
 * for the stage panel. Pinned to the DAEMON DEFAULT cell count
 * (`DEFAULT_CELLS.length === 2` in `scripts/daily_signal_daemon.ts`). The
 * daemon supports `--cells` CLI overrides at runtime; the brief always
 * renders against the default since the brief composer has no access to
 * a specific daemon-run's argv. Drift between the default cell count
 * and the brief constant remains an operator-discipline concern (the
 * SPEC §14 watch-out applies to numCells but no longer to bucket USD).
 */
export const BRIEF_NUM_CELLS = 2;

/**
 * ADR-040 SPEC §10.2 — default cellKeys for the brief's weighting line,
 * pinned to the same daemon default as `BRIEF_NUM_CELLS`. The cell-key
 * format mirrors `cellKeyFor` in `scripts/daily_signal_daemon.ts`:
 * `${bundleId}|${tier}|${interval}|${param}`. Drift between this constant
 * and the daemon's `DEFAULT_CELLS` is an operator-discipline concern
 * tracked in the §15 watch-outs.
 */
export const BRIEF_DEFAULT_CELL_KEYS: readonly string[] = [
  'mean_reversion_v1|equity_midcap|1d|14',
  'trend_v1|equity_midcap|1d|30',
] as const;

export interface DaemonRunRow {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  fetch_summary: string;
  cells_evaluated: number;
  cells_with_diff: number;
  telegram_status: string;
  anomalies_json: string;
}

/**
 * Map of (bundleId, param) → set of allowlisted symbols. Keyed by
 * `allowlistKey(bundleId, param)` so the lookup is one Map.get per cell.
 * Empty Map ≡ allowlist table missing or empty; every position renders ✗.
 */
export type CellAllowlists = Map<string, Set<string>>;

export function allowlistKey(bundleId: string, param: number): string {
  return `${bundleId}|${param}`;
}

export interface BriefDeps {
  fetchRegimeState: typeof fetchRegimeState;
  fetchPaperTradingState: typeof fetchPaperTradingState;
  fetchLastDaemonRun: () => Promise<DaemonRunRow | null>;
  fetchCellAllowlists: () => Promise<CellAllowlists>;
  /**
   * Closed-trade ledger reader. Defaults to
   * `LiveTradeRepository.listClosedTrades({source:'paper'})`, returning [] if
   * `quantlab.live_trades` does not yet exist (pre-rollout state). Tests stub
   * this to drive A2/A3/A4/A5 deterministically.
   */
  fetchClosedTrades?: () => Promise<LiveTradeRow[]>;
  /**
   * Drawdown-response framework state reader. Defaults to
   * `DrawdownStateRepository.loadLatest({source:'paper'})`, returning null
   * when `quantlab.drawdown_state_history` does not exist or is empty.
   * Tests stub to drive the panel deterministically.
   */
  fetchLatestDrawdownState?: () => Promise<DrawdownStateRow | null>;
  /**
   * Per-strategy drawdown-state reader — strategy-tagged-drawdown-state.md
   * §7.4 (Phase B). Defaults to `DrawdownStateRepository.loadLatestAllScopes`
   * with the bundle_id column-presence flag probed once. Returns an empty
   * map when (a) the table is absent, (b) the bundle_id column has not yet
   * been added (pre-Phase-C), or (c) no per-strategy rows exist yet. Tests
   * stub to drive the panel deterministically.
   */
  fetchLatestDrawdownStatePerStrategy?: () => Promise<Record<string, DrawdownStateRow>>;
  /**
   * Stage state machine reader. Defaults to
   * `StageStateRepository.loadLatest({source:'paper'})`, returning null
   * when `quantlab.stage_state_history` does not exist or is empty.
   * Tests stub to drive the panel deterministically.
   */
  fetchLatestStageState?: () => Promise<StageStateRow | null>;
  /**
   * Halt sentinel presence reader. Defaults to checking `.stage_halt` in
   * the current working directory. Tests override deterministically.
   */
  haltSentinelPresent?: () => boolean;
  /**
   * Market-cycle-position composite reader. Defaults to
   * `CyclePositionRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.cycle_position_snapshots` is absent or empty. SPEC:
   * docs/specs/market-cycle-position.md §3. Tests stub to drive the panel
   * deterministically.
   */
  fetchLatestCyclePosition?: () => Promise<CyclePositionSnapshot | null>;
  /**
   * Vol-structure composite reader. Defaults to
   * `VolStructureRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.vol_structure_snapshots` is absent or empty. SPEC:
   * docs/specs/expanded-vol-structure.md §3. Tests stub to drive the panel
   * deterministically.
   */
  fetchLatestVolStructure?: () => Promise<VolStructureSnapshot | null>;
  /**
   * Sector-rotation composite reader. Defaults to
   * `SectorRotationRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.sector_rotation_snapshots` is absent or empty. SPEC:
   * docs/specs/sector-rotation.md §3. Tests stub to drive the panel
   * deterministically.
   */
  fetchLatestSectorRotation?: () => Promise<SectorRotationSnapshot | null>;
  /**
   * Cross-asset signals composite reader. Defaults to
   * `CrossAssetSignalsRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.cross_asset_snapshots` is absent or empty. SPEC:
   * docs/specs/cross-asset-signals.md §3. Tests stub to drive the panel
   * deterministically.
   */
  fetchLatestCrossAsset?: () => Promise<CrossAssetSignalsSnapshot | null>;
  /**
   * Short-interest composite reader. Defaults to
   * `ShortInterestRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.short_interest_snapshots` is absent or empty. SPEC:
   * docs/specs/short-interest-tracking.md §3. Tests stub to drive the
   * panel deterministically.
   */
  fetchLatestShortInterest?: () => Promise<ShortInterestSnapshot | null>;
  /**
   * Executive-departure composite reader. Defaults to
   * `ExecutiveDepartureRepository.loadLatestSnapshot()`, returning null
   * when `quantlab.executive_departure_snapshots` is absent or empty.
   * SPEC: docs/specs/executive-departure-signal.md §3. Tests stub to drive
   * the panel deterministically.
   */
  fetchLatestExecutiveDeparture?: () => Promise<ExecutiveDepartureSnapshot | null>;
  /**
   * ETF-flow composite reader. Defaults to
   * `EtfFlowRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.etf_flow_snapshots` is absent or empty. SPEC:
   * docs/specs/etf-flow-monitoring.md §3. Tests stub to drive the panel
   * deterministically.
   */
  fetchLatestEtfFlow?: () => Promise<EtfFlowSnapshot | null>;
  /**
   * 8-K classifier composite reader. Defaults to
   * `EightKClassifierRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.eight_k_classifier_snapshots` is absent or empty. SPEC:
   * docs/specs/event-driven-filings-processor.md §3 + §8.1. Tests stub to
   * drive the panel deterministically.
   */
  fetchLatestEightKClassifier?: () => Promise<EightKClassifierSnapshot | null>;
  /**
   * Form 4 insider composite reader. Defaults to
   * `Form4InsiderRepository.loadLatestSnapshot()`, returning null when
   * `quantlab.form_4_insider_snapshots` is absent or empty. SPEC:
   * docs/specs/event-driven-filings-processor.md §3 + §8.2. Tests stub to
   * drive the panel deterministically.
   */
  fetchLatestForm4Insider?: () => Promise<Form4InsiderSnapshot | null>;
  /**
   * Kill-criteria daily history probe — true iff
   * `quantlab.kill_criteria_daily` exists. Drives the brief stage panel's
   * "streak source" warning (SPEC docs/specs/kill-criteria-daily-history.md
   * §10 — critic H-2 fix). Defaults to a CH probe; tests override
   * deterministically. When undefined the brief defaults to 'history' to
   * preserve byte-equal output on pre-existing test fixtures that don't
   * supply the probe.
   */
  killCriteriaDailyTablePresent?: () => Promise<boolean>;
  /**
   * ADR-040 SPEC §10.2 — re-compute the cell-weights surface at brief time
   * (NOT persisted on `stage_state_history`). Defaults to
   * `resolveCellWeightsForRun` with the brief's pinned cellKeys + the
   * effective stage's per-cell capital proxy. Tests override
   * deterministically. Returns `null` when the brief composer chooses to
   * skip the panel (e.g. when no stage row exists).
   */
  fetchCellWeightsForBrief?: (opts: {
    refDate: Date;
    cellKeys: readonly string[];
    cellCapitalUsdProxy: number;
  }) => Promise<ResolveCellWeightsResult>;
  /** Override the clock for tests. */
  now?: () => Date;
}

/**
 * Compose the brief by calling all four data sources and assembling the
 * MorningBrief object. Pure-ish: ClickHouse calls happen via injected deps.
 */
export async function composeMorningBrief(deps?: Partial<BriefDeps>): Promise<MorningBrief> {
  const fetchRegime = deps?.fetchRegimeState ?? fetchRegimeState;
  const fetchPaper = deps?.fetchPaperTradingState ?? fetchPaperTradingState;
  const fetchDaemon = deps?.fetchLastDaemonRun ?? fetchLastDaemonRunFromCH;
  const fetchAllowlists = deps?.fetchCellAllowlists ?? fetchCellAllowlistsFromCH;
  const fetchClosed = deps?.fetchClosedTrades ?? fetchClosedTradesFromCH;
  const fetchLatestDrawdown =
    deps?.fetchLatestDrawdownState ?? fetchLatestDrawdownStateFromCH;
  const fetchLatestDrawdownPerStrategy =
    deps?.fetchLatestDrawdownStatePerStrategy ?? fetchLatestDrawdownStatePerStrategyFromCH;
  const fetchLatestStage =
    deps?.fetchLatestStageState ?? fetchLatestStageStateFromCH;
  const haltSentinelPresent =
    deps?.haltSentinelPresent ?? (() => existsSync(resolve(process.cwd(), '.stage_halt')));
  const fetchLatestCyclePosition =
    deps?.fetchLatestCyclePosition ?? fetchLatestCyclePositionFromCH;
  const fetchLatestVolStructure =
    deps?.fetchLatestVolStructure ?? fetchLatestVolStructureFromCH;
  const fetchLatestSectorRotation =
    deps?.fetchLatestSectorRotation ?? fetchLatestSectorRotationFromCH;
  const fetchLatestCrossAsset =
    deps?.fetchLatestCrossAsset ?? fetchLatestCrossAssetFromCH;
  const fetchLatestShortInterest =
    deps?.fetchLatestShortInterest ?? fetchLatestShortInterestFromCH;
  const fetchLatestExecutiveDeparture =
    deps?.fetchLatestExecutiveDeparture ?? fetchLatestExecutiveDepartureFromCH;
  const fetchLatestEtfFlow =
    deps?.fetchLatestEtfFlow ?? fetchLatestEtfFlowFromCH;
  const fetchLatestEightKClassifier =
    deps?.fetchLatestEightKClassifier ?? fetchLatestEightKClassifierFromCH;
  const fetchLatestForm4Insider =
    deps?.fetchLatestForm4Insider ?? fetchLatestForm4InsiderFromCH;
  // Critic H-2 (SPEC docs/specs/kill-criteria-daily-history.md §10) — probe
  // the table at compose time so the stage panel can surface "streak source"
  // when the daemon falls back to the rolling-asOf shortcut. Defaulted via
  // the same CH probe the daemon uses at bootstrap; tests override.
  const killCriteriaDailyTablePresent =
    deps?.killCriteriaDailyTablePresent ?? (() => killCriteriaDailyTableExists());
  const fetchCellWeightsForBrief =
    deps?.fetchCellWeightsForBrief ?? defaultFetchCellWeightsForBrief;
  const now = deps?.now ?? (() => new Date());

  const [regime, paper, lastRun, allowlists, closedTrades, latestDrawdown, latestDrawdownPerStrategy, latestStage, killCritDailyPresent, latestCyclePosition, latestVolStructure, latestSectorRotation, latestCrossAsset, latestShortInterest, latestExecutiveDeparture, latestEtfFlow, latestEightKClassifier, latestForm4Insider] = await Promise.all([
    fetchRegime({ asOf: null, lookbackDays: LOOKBACK_DAYS_DEFAULT }),
    fetchPaper({ runHistoryLimit: 14 }),
    fetchDaemon(),
    fetchAllowlists(),
    fetchClosed(),
    fetchLatestDrawdown(),
    fetchLatestDrawdownPerStrategy(),
    fetchLatestStage(),
    killCriteriaDailyTablePresent(),
    fetchLatestCyclePosition(),
    fetchLatestVolStructure(),
    fetchLatestSectorRotation(),
    fetchLatestCrossAsset(),
    fetchLatestShortInterest(),
    fetchLatestExecutiveDeparture(),
    fetchLatestEtfFlow(),
    fetchLatestEightKClassifier(),
    fetchLatestForm4Insider(),
  ]);

  if (!regime.biasNote || !regime.biasNote.body) {
    throw new Error(
      'composeMorningBrief: BIAS_NOTE_PHASE1_V3 is missing or empty — refusing to render the brief without the bias caveat (SPEC §2.2)',
    );
  }

  const killCriteria = evaluateKillCriteria({
    state: paper,
    closedTrades,
    asOf: now(),
  });
  const daemon = buildDaemonSection(lastRun, now());
  const watchlist = buildWatchlist(paper, allowlists);
  const drawdown = buildDrawdownSection(latestDrawdown, now(), latestDrawdownPerStrategy);
  // ADR-040 SPEC §10.2 — re-compute cell weights at brief time (NOT
  // persisted). Skipped entirely when no stage row exists (the whole stage
  // section returns null in that case). Failures fall back to undefined →
  // renderer skips the weighting line.
  let cellWeights: ResolveCellWeightsResult | undefined;
  if (latestStage !== null) {
    try {
      // Cell capital proxy: bucket × allocationPct / N (paper uses whole bucket).
      const eff = DEPLOYMENT_STAGES[latestStage.stageAfter];
      const capProxy = latestStage.stageAfter === 'paper'
        ? BRIEF_LIQUID_BUCKET_USD
        : (BRIEF_LIQUID_BUCKET_USD * eff.allocationPct) / Math.max(1, BRIEF_NUM_CELLS);
      cellWeights = await fetchCellWeightsForBrief({
        refDate: now(),
        cellKeys: BRIEF_DEFAULT_CELL_KEYS,
        cellCapitalUsdProxy: capProxy,
      });
    } catch {
      // Non-fatal: the brief renders the stage panel without the weighting line.
      cellWeights = undefined;
    }
  }
  const stage = buildStageSection(latestStage, haltSentinelPresent(), {
    killCriteriaSource: killCritDailyPresent ? 'history' : 'rolling-asof-shortcut',
    cellWeights,
  });
  const cyclePosition = buildCyclePositionSection(latestCyclePosition);
  const volStructure = buildVolStructureSection(latestVolStructure);
  const sectorRotation = buildSectorRotationSection(latestSectorRotation);
  const crossAsset = buildCrossAssetSection(latestCrossAsset);
  const shortInterest = buildShortInterestSection(latestShortInterest);
  const executiveDeparture = buildExecutiveDepartureSection(latestExecutiveDeparture);
  const etfFlow = buildEtfFlowSection(latestEtfFlow);
  const eightK = buildEightKClassifierSection(latestEightKClassifier);
  const formFour = buildForm4InsiderSection(latestForm4Insider);

  return {
    generatedAt: now().toISOString().slice(0, 19) + 'Z',
    classifierVersion: regime.classifierVersion ?? CLASSIFIER_VERSION,
    regime: {
      today: regime.today,
      daysInCurrentRegime: regime.daysInCurrentRegime,
      biasNote: regime.biasNote,
    },
    killCriteria,
    daemon,
    watchlist,
    drawdown,
    stage,
    cyclePosition,
    volStructure,
    sectorRotation,
    crossAsset,
    shortInterest,
    executiveDeparture,
    etfFlow,
    eightK,
    formFour,
  };
}

/**
 * Build the morning-brief cycle-position section from the repository
 * snapshot. Returns null when no snapshot exists yet (pre-first-daemon-
 * cycle state); the renderer handles null with a friendly "not yet
 * evaluated" message.
 */
export function buildCyclePositionSection(
  snapshot: CyclePositionSnapshot | null,
): BriefCyclePositionSection | null {
  if (snapshot === null) return null;
  return {
    evaluatedAt: snapshot.asOf.toISOString(),
    snapshotDate: snapshot.asOf.toISOString().slice(0, 10),
    score: snapshot.score,
    phaseLabel: snapshot.phaseLabel,
    recessionProbPct: snapshot.recessionProbPct,
    contributions: {
      yieldCurve: snapshot.contributions.yieldCurve,
      credit: snapshot.contributions.credit,
      employment: snapshot.contributions.employment,
    },
    inputsPresent: snapshot.inputsPresent,
    compositeVersion: snapshot.compositeVersion,
  };
}

/**
 * Default fetcher for the morning-brief cycle-position section. Returns
 * null when the snapshots table is absent (pre-A3-migration) OR empty
 * (post-migration, pre-first-daemon-cycle). Failures degrade to null
 * gracefully — the brief renders "not yet evaluated" rather than
 * crashing on a transient CH read error.
 */
async function fetchLatestCyclePositionFromCH(): Promise<CyclePositionSnapshot | null> {
  try {
    if (!(await cyclePositionSnapshotsTableExists())) return null;
    const repo = new CyclePositionRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief vol-structure section from the repository
 * snapshot. Returns null when no snapshot exists yet; the renderer
 * handles null with a friendly "not yet evaluated" message.
 */
export function buildVolStructureSection(
  snapshot: VolStructureSnapshot | null,
): BriefVolStructureSection | null {
  if (snapshot === null) return null;
  return {
    evaluatedAt: snapshot.asOf.toISOString(),
    snapshotDate: snapshot.asOf.toISOString().slice(0, 10),
    regimeFlag: snapshot.regimeFlag,
    monotonicBackwardation: snapshot.monotonicBackwardation,
    curveSteepnessZ: snapshot.curveSteepnessZ,
    inversionDepth: snapshot.inversionDepth,
    vixZ: snapshot.vixZ,
    vvixZ: snapshot.vvixZ,
    vvixVixDivergence: snapshot.vvixVixDivergence,
    inputsPresent: snapshot.inputsPresent,
    compositeVersion: snapshot.compositeVersion,
  };
}

/**
 * Default fetcher for the morning-brief vol-structure section. Mirrors the
 * cycle-position graceful-degrade posture: null when the table is absent or
 * empty OR when CH is transiently unreachable. The brief renders "not yet
 * evaluated" rather than crashing.
 */
async function fetchLatestVolStructureFromCH(): Promise<VolStructureSnapshot | null> {
  try {
    if (!(await volStructureSnapshotsTableExists())) return null;
    const repo = new VolStructureRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief sector-rotation section from the repository
 * snapshot. Returns null when no snapshot exists yet; the renderer handles
 * null with a friendly "not yet evaluated" message.
 */
export function buildSectorRotationSection(
  snapshot: SectorRotationSnapshot | null,
): BriefSectorRotationSection | null {
  if (snapshot === null) return null;
  return {
    evaluatedAt: snapshot.asOf.toISOString(),
    snapshotDate: snapshot.asOf.toISOString().slice(0, 10),
    regimeFlag: snapshot.regimeFlag,
    defensiveCyclicalSpread: snapshot.defensiveCyclicalSpread,
    defensiveCyclicalSpreadZ: snapshot.defensiveCyclicalSpreadZ,
    topSectorSymbol: snapshot.topSectorSymbol,
    topSectorVolumeShare: snapshot.topSectorVolumeShare,
    topSectorVolumeShareZ: snapshot.topSectorVolumeShareZ,
    spyPctOff52wHigh: snapshot.spyPctOff52wHigh,
    spyWithin5PctOf52wHigh: snapshot.spyWithin5PctOf52wHigh,
    growthValueSpread: snapshot.growthValueSpread,
    defensiveLeadActive: snapshot.defensiveLeadActive,
    concentrationExtremeActive: snapshot.concentrationExtremeActive,
    inputsPresent: snapshot.inputsPresent,
    compositeVersion: snapshot.compositeVersion,
  };
}

/**
 * Default fetcher for the morning-brief sector-rotation section. Mirrors the
 * cycle-position / vol-structure graceful-degrade posture.
 */
async function fetchLatestSectorRotationFromCH(): Promise<SectorRotationSnapshot | null> {
  try {
    if (!(await sectorRotationSnapshotsTableExists())) return null;
    const repo = new SectorRotationRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief cross-asset signals section from the repository
 * snapshot. Returns null when no snapshot exists yet; the renderer handles
 * null with a friendly "not yet evaluated" message.
 */
export function buildCrossAssetSection(
  snapshot: CrossAssetSignalsSnapshot | null,
): BriefCrossAssetSection | null {
  if (snapshot === null) return null;
  return {
    evaluatedAt: snapshot.asOf.toISOString(),
    snapshotDate: snapshot.asOf.toISOString().slice(0, 10),
    regimeFlag: snapshot.regimeFlag,
    activeFlagCount: snapshot.activeFlagCount,
    dxy20dChangePct: snapshot.dxy20dChangePct,
    realRate10y20dChangeBps: snapshot.realRate10y20dChangeBps,
    copperGoldRatio20dChangePct: snapshot.copperGoldRatio20dChangePct,
    creditInternalsDiffZ: snapshot.creditInternalsDiffZ,
    invertedSegmentCount: snapshot.invertedSegmentCount,
    dxyStrengthActive: snapshot.dxyStrengthActive,
    realRateSpikeActive: snapshot.realRateSpikeActive,
    commodityGrowthCollapseActive: snapshot.commodityGrowthCollapseActive,
    creditInternalsDivergenceActive: snapshot.creditInternalsDivergenceActive,
    curveDistortionActive: snapshot.curveDistortionActive,
    inputsPresent: snapshot.inputsPresent,
    compositeVersion: snapshot.compositeVersion,
  };
}

/**
 * Default fetcher for the morning-brief cross-asset section. Mirrors the
 * cycle-position / vol-structure / sector-rotation graceful-degrade posture.
 */
async function fetchLatestCrossAssetFromCH(): Promise<CrossAssetSignalsSnapshot | null> {
  try {
    if (!(await crossAssetSnapshotsTableExists())) return null;
    const repo = new CrossAssetSignalsRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief short-interest section from the repository
 * snapshot. Returns null when no snapshot exists yet; the renderer handles
 * null with a friendly "not yet evaluated" message.
 *
 * Path A4-β: snapshot's `perTickerRows` field already carries the per-stock
 * shares_short payload + ROC + flags from the composite (sirT-named fields,
 * shares_short magnitudes per the §5.1 v1 implementation note).
 */
export function buildShortInterestSection(
  snapshot: ShortInterestSnapshot | null,
): BriefShortInterestSection | null {
  if (snapshot === null) return null;
  return {
    evaluatedAt: snapshot.snapshotDate.toISOString(),
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    lastFinraPublication: snapshot.lastFinraPublication != null
      ? snapshot.lastFinraPublication.toISOString().slice(0, 10)
      : null,
    bdSincePublication: snapshot.bdSincePublication,
    aggregateSir: snapshot.aggregateSir,
    aggregateZ: snapshot.aggregateZ,
    aggregateBaselineSize: snapshot.aggregateBaselineSize,
    sentimentShortExtreme: snapshot.sentimentShortExtreme,
    perTickerRows: snapshot.perTickerRows,
    inputsAvailableAggregate: snapshot.inputsAvailableAggregate,
    inputsAvailablePerTicker: snapshot.inputsAvailablePerTicker,
    compositeVersion: snapshot.version,
  };
}

/**
 * Default fetcher for the morning-brief short-interest section. Mirrors the
 * cycle-position / vol-structure / sector-rotation / cross-asset graceful-
 * degrade posture — returns null on absent table OR any read error.
 */
async function fetchLatestShortInterestFromCH(): Promise<ShortInterestSnapshot | null> {
  try {
    if (!(await shortInterestSnapshotsTableExists())) return null;
    const repo = new ShortInterestRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief executive-departure section from the repository
 * snapshot. Returns null when no snapshot exists yet; the renderer handles
 * null with a friendly "not yet evaluated" message. Mirrors
 * buildEightKClassifierSection / buildForm4InsiderSection structurally.
 *
 * Stamps the composer-side `tickersWithCikCount` + `watchUniverseTickerCount`
 * onto the section so the renderer's universe-coverage line uses a CIK-only
 * count (the composite's `inputsAvailablePerTicker` is gated on BOTH cik +
 * sector and would render a misleading "0/60 with CIK mapping" line on cold-
 * start before the GICS ingest first runs; same fix as EK-A5 / F4-A5 S93-28
 * mirrored to section #12 per G1-A4).
 */
export function buildExecutiveDepartureSection(
  snapshot: ExecutiveDepartureSnapshot | null,
): BriefExecutiveDepartureSection | null {
  if (snapshot === null) return null;
  const watchUniverseTickerCount = snapshot.perTickerRows.length;
  let tickersWithCikCount = 0;
  for (const r of snapshot.perTickerRows) {
    if (r.cik !== '') tickersWithCikCount++;
  }
  return {
    evaluatedAt: snapshot.snapshotDate.toISOString(),
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    lastEdgarQueryAt: snapshot.lastEdgarQueryAt != null
      ? snapshot.lastEdgarQueryAt.toISOString()
      : null,
    bdSinceLastQuery: snapshot.bdSinceLastQuery,
    flaggedSectors: snapshot.flaggedSectors,
    executiveClusterDeparture: snapshot.executiveClusterDeparture,
    maxAggregateZ: snapshot.maxAggregateZ,
    maxAggregateZSector: snapshot.maxAggregateZSector,
    perTickerRows: snapshot.perTickerRows,
    inputsAvailableAggregate: snapshot.inputsAvailableAggregate,
    inputsAvailablePerTicker: snapshot.inputsAvailablePerTicker,
    tickersWithCikCount,
    watchUniverseTickerCount,
    compositeVersion: snapshot.version,
  };
}

/**
 * Default fetcher for the morning-brief executive-departure section.
 * Mirrors the cycle-position / vol-structure / sector-rotation / cross-asset
 * / short-interest graceful-degrade posture — returns null on absent table
 * OR any read error.
 */
async function fetchLatestExecutiveDepartureFromCH(): Promise<ExecutiveDepartureSnapshot | null> {
  try {
    if (!(await executiveDepartureSnapshotsTableExists())) return null;
    const repo = new ExecutiveDepartureRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief etf-flow section from the repository snapshot.
 * Returns null when no snapshot exists yet; the renderer handles null with
 * a friendly "not yet evaluated" message. Mirrors
 * buildExecutiveDepartureSection / buildShortInterestSection structurally.
 *
 * Date fields on the snapshot (`snapshotDate`, `lastYfinanceQueryAt`) are
 * converted to ISO strings at this boundary; the renderer is pure and only
 * works with strings. `perEtfRows` is NOT threaded through — the v1 panel
 * renders aggregate scalars + flagged list + universe coverage, and the
 * full per-ETF table stays queryable from the snapshot's `per_etf_json`
 * column.
 */
export function buildEtfFlowSection(
  snapshot: EtfFlowSnapshot | null,
): BriefEtfFlowSection | null {
  if (snapshot === null) return null;
  return {
    evaluatedAt: snapshot.snapshotDate.toISOString(),
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    lastYfinanceQueryAt: snapshot.lastYfinanceQueryAt != null
      ? snapshot.lastYfinanceQueryAt.toISOString()
      : null,
    bdSinceLastShareUpdate: snapshot.bdSinceLastShareUpdate,
    sectorFlowDispersion: snapshot.sectorFlowDispersion,
    aggregateRiskOnFlow: snapshot.aggregateRiskOnFlow,
    aggregateFlowStressFlag: snapshot.aggregateFlowStressFlag,
    flaggedEtfs: snapshot.flaggedEtfs.map(f => ({
      ticker: f.ticker,
      flowZ: f.flowZ,
      returnZ20bd: f.returnZ20bd,
      flowPctAumT: f.flowPctAumT,
      divergenceFlag: f.divergenceFlag,
    })),
    inputsAvailableAggregateSector: snapshot.inputsAvailableAggregateSector,
    inputsAvailableAggregateBroad: snapshot.inputsAvailableAggregateBroad,
    inputsAvailablePerEtf: snapshot.inputsAvailablePerEtf,
    compositeVersion: snapshot.version,
  };
}

/**
 * Default fetcher for the morning-brief etf-flow section. Mirrors the prior
 * six Layer-0 composites' graceful-degrade posture — returns null on absent
 * table OR any read error.
 */
async function fetchLatestEtfFlowFromCH(): Promise<EtfFlowSnapshot | null> {
  try {
    if (!(await etfFlowSnapshotsTableExists())) return null;
    const repo = new EtfFlowRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief 8-K classifier section from the repository
 * snapshot. Returns null when no snapshot exists yet; the renderer handles
 * null with a friendly "not yet evaluated" message. Mirrors
 * buildEtfFlowSection / buildExecutiveDepartureSection structurally.
 *
 * Stamps the composer-side `tickersWithCikCount` + `watchUniverseTickerCount`
 * onto the section so the renderer's universe-coverage line uses a CIK-only
 * count (per S93-28: the composite's `inputsAvailablePerTicker` is gated on
 * sector presence and is therefore always 0 in v1 — using it directly in the
 * brief would render a misleading "0/60 with CIK mapping" line).
 */
export function buildEightKClassifierSection(
  snapshot: EightKClassifierSnapshot | null,
): BriefEightKClassifierSection | null {
  if (snapshot === null) return null;
  const watchUniverseTickerCount = snapshot.perTickerRows.length;
  let tickersWithCikCount = 0;
  for (const r of snapshot.perTickerRows) {
    if (r.cik !== '') tickersWithCikCount++;
  }
  return {
    evaluatedAt: snapshot.snapshotDate.toISOString(),
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    lastEdgarQueryAt: snapshot.lastEdgarQueryAt != null
      ? snapshot.lastEdgarQueryAt.toISOString()
      : null,
    bdSinceLastQuery: snapshot.bdSinceLastQuery,
    flaggedSectors: snapshot.flaggedSectors.map(f => ({
      sector: f.sector,
      sectorSize: f.sectorSize,
      eventRateT: f.eventRateT,
      z: f.z,
      baselineSize: f.baselineSize,
    })),
    eightKClusterFlag: snapshot.eightKClusterFlag,
    maxAggregateZ: snapshot.maxAggregateZ,
    maxAggregateZSector: snapshot.maxAggregateZSector,
    perTickerRows: snapshot.perTickerRows.map(r => ({
      ticker: r.ticker,
      cik: r.cik,
      sector: r.sector,
      recentEventCount90d: r.recentEventCount90d,
      daysSinceLatestEvent: r.daysSinceLatestEvent,
      materialEventFlag: r.materialEventFlag,
      impairmentFlag: r.impairmentFlag,
      restatementFlag: r.restatementFlag,
      auditorChangeFlag: r.auditorChangeFlag,
      delistingFlag: r.delistingFlag,
      controlChangeFlag: r.controlChangeFlag,
      materialAgreementFlag: r.materialAgreementFlag,
      acquisitionFlag: r.acquisitionFlag,
    })),
    inputsAvailableAggregate: snapshot.inputsAvailableAggregate,
    inputsAvailablePerTicker: snapshot.inputsAvailablePerTicker,
    tickersWithCikCount,
    watchUniverseTickerCount,
    compositeVersion: snapshot.version,
  };
}

/**
 * Default fetcher for the morning-brief 8-K classifier section. Mirrors the
 * prior seven Layer-0 composites' graceful-degrade posture — returns null
 * on absent table OR any read error.
 */
async function fetchLatestEightKClassifierFromCH(): Promise<EightKClassifierSnapshot | null> {
  try {
    if (!(await eightKClassifierSnapshotsTableExists())) return null;
    const repo = new EightKClassifierRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Build the morning-brief Form 4 insider section from the repository
 * snapshot. Returns null when no snapshot exists yet (pre-first-daemon-
 * cycle state); the renderer handles null with the "not yet evaluated"
 * footer. Mirrors `buildEightKClassifierSection` structurally.
 *
 * Stamps the composer-side `tickersWithCikCount` + `watchUniverseTickerCount`
 * onto the section so the renderer's universe-coverage line uses a CIK-only
 * count (the composite's `inputsAvailablePerTicker` is gated on sector
 * presence and is therefore always 0 in v1 — using it directly in the
 * brief would render a misleading "0/60 with CIK mapping" line; same fix
 * as EK-A5 S93-28).
 */
export function buildForm4InsiderSection(
  snapshot: Form4InsiderSnapshot | null,
): BriefForm4InsiderSection | null {
  if (snapshot === null) return null;
  const watchUniverseTickerCount = snapshot.perTickerRows.length;
  let tickersWithCikCount = 0;
  for (const r of snapshot.perTickerRows) {
    if (r.cik !== '') tickersWithCikCount++;
  }
  return {
    evaluatedAt: snapshot.snapshotDate.toISOString(),
    snapshotDate: snapshot.snapshotDate.toISOString().slice(0, 10),
    lastEdgarQueryAt: snapshot.lastEdgarQueryAt != null
      ? snapshot.lastEdgarQueryAt.toISOString()
      : null,
    bdSinceLastQuery: snapshot.bdSinceLastQuery,
    flaggedSectors: snapshot.flaggedSectors.map(f => ({
      sector: f.sector,
      sectorSize: f.sectorSize,
      clusterRateT: f.clusterRateT,
      z: f.z,
      baselineSize: f.baselineSize,
    })),
    form4ClusterFlag: snapshot.form4ClusterFlag,
    maxAggregateZ: snapshot.maxAggregateZ,
    maxAggregateZSector: snapshot.maxAggregateZSector,
    flaggedSellSectors: snapshot.flaggedSellSectors.map(f => ({
      sector: f.sector,
      sectorSize: f.sectorSize,
      clusterRateT: f.clusterRateT,
      z: f.z,
      baselineSize: f.baselineSize,
    })),
    form4SellClusterFlag: snapshot.form4SellClusterFlag,
    maxAggregateZSell: snapshot.maxAggregateZSell,
    maxAggregateZSellSector: snapshot.maxAggregateZSellSector,
    perTickerRows: snapshot.perTickerRows.map(r => ({
      ticker: r.ticker,
      cik: r.cik,
      sector: r.sector,
      insiderBuyCount90d: r.insiderBuyCount90d,
      insiderSellCount90d: r.insiderSellCount90d,
      insiderBuyerCount90d: r.insiderBuyerCount90d,
      insiderSellerCount90d: r.insiderSellerCount90d,
      insiderNetDollar90d: r.insiderNetDollar90d,
      insiderClusterBuyFlag: r.insiderClusterBuyFlag,
      insiderClusterSellFlag: r.insiderClusterSellFlag,
    })),
    inputsAvailableAggregate: snapshot.inputsAvailableAggregate,
    inputsAvailablePerTicker: snapshot.inputsAvailablePerTicker,
    tickersWithCikCount,
    watchUniverseTickerCount,
    compositeVersion: snapshot.version,
  };
}

/**
 * Default fetcher for the morning-brief Form 4 insider section. Mirrors
 * the prior eight Layer-0 composites' graceful-degrade posture — returns
 * null on absent table OR any read error.
 */
async function fetchLatestForm4InsiderFromCH(): Promise<Form4InsiderSnapshot | null> {
  try {
    if (!(await form4InsiderSnapshotsTableExists())) return null;
    const repo = new Form4InsiderRepository();
    return await repo.loadLatestSnapshot();
  } catch {
    return null;
  }
}

/**
 * Default impure read — fetches the most recent daemon_runs row, FINAL.
 *
 * Resilient to a missing table: if `quantlab.daemon_runs` does not yet exist
 * (pre-rollout state, before the daemon has been instrumented to call
 * `ensureBacktestTables()`), returns null. The brief renders this as
 * "no run on file" per SPEC §4.2.
 */
async function fetchLastDaemonRunFromCH(): Promise<DaemonRunRow | null> {
  const ch = getClickHouse();
  const exists = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'daemon_runs'`,
    format: 'JSONEachRow',
  });
  const [{ n }] = await exists.json<{ n: string | number }>();
  if (Number(n) === 0) return null;

  const r = await ch.query({
    query: `
      SELECT
        toString(run_id)        AS run_id,
        toString(started_at)    AS started_at,
        toString(finished_at)   AS finished_at,
        status,
        fetch_summary,
        cells_evaluated,
        cells_with_diff,
        telegram_status,
        anomalies_json
      FROM quantlab.daemon_runs FINAL
      ORDER BY finished_at DESC
      LIMIT 1
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<DaemonRunRow>();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Default impure read — fetches the entire `cell_allowlist` and groups it by
 * (strategy_type, param). Resilient to the table being absent (returns empty
 * Map; brief renders ✗ for every position, which is semantically correct —
 * "we have no record of this combo being on an allowlist").
 *
 * Schema source: scripts/audit_positions.ts loadAllowlist — same FINAL semantics.
 */
async function fetchCellAllowlistsFromCH(): Promise<CellAllowlists> {
  const ch = getClickHouse();
  const exists = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'cell_allowlist'`,
    format: 'JSONEachRow',
  });
  const [{ n }] = await exists.json<{ n: string | number }>();
  if (Number(n) === 0) return new Map();

  const r = await ch.query({
    query: `SELECT strategy_type, toInt32(param) AS param, symbol FROM quantlab.cell_allowlist FINAL`,
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ strategy_type: string; param: number; symbol: string }>();
  const out: CellAllowlists = new Map();
  for (const row of rows) {
    const key = allowlistKey(row.strategy_type, Number(row.param));
    let set = out.get(key);
    if (!set) {
      set = new Set<string>();
      out.set(key, set);
    }
    set.add(row.symbol);
  }
  return out;
}

/**
 * Default impure read — closed-trade ledger from `quantlab.live_trades`.
 *
 * Resilient to a missing table: if `live_trades` doesn't exist yet (pre-
 * session-47-migration state), returns []. The kill-criteria evaluators
 * then return their pre-data fallback verdicts (insufficient_data / pass
 * with note), which is the correct behaviour for a never-deployed system.
 */
async function fetchClosedTradesFromCH(): Promise<LiveTradeRow[]> {
  const ch = getClickHouse();
  const exists = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'live_trades'`,
    format: 'JSONEachRow',
  });
  const [{ n }] = await exists.json<{ n: string | number }>();
  if (Number(n) === 0) return [];
  const repo = new LiveTradeRepository();
  return repo.listClosedTrades({ source: 'paper' });
}

/**
 * Default impure read — most recent drawdown-state-history row for the
 * paper source. Returns null when the table is absent or empty; the
 * renderer surfaces this as "framework not yet evaluated."
 */
async function fetchLatestDrawdownStateFromCH(): Promise<DrawdownStateRow | null> {
  const ch = getClickHouse();
  const present = await drawdownStateHistoryTableExists(ch);
  if (!present) return null;
  // Pre-Phase-C the bundle_id column is absent — the repo's portfolio reads
  // still work without the filter, so the flag stays false here. Per-strategy
  // reads come through the separate composite fetch.
  const repo = new DrawdownStateRepository({ ch });
  return repo.loadLatest({ source: 'paper' });
}

/**
 * Default impure read — per-strategy drawdown latest rows. Probes the
 * `bundle_id` column once (graceful-degrade pre-migration), then uses the
 * single GROUP-BY composite read (`loadLatestAllScopes`) and discards the
 * portfolio half (the portfolio fetch above is its own canonical call).
 * Returns {} when (a) table absent, (b) column absent, or (c) no rows.
 */
async function fetchLatestDrawdownStatePerStrategyFromCH(): Promise<Record<string, DrawdownStateRow>> {
  const ch = getClickHouse();
  const present = await drawdownStateHistoryTableExists(ch);
  if (!present) return {};
  const hasBundleId = await drawdownStateHasBundleIdColumn(ch);
  if (!hasBundleId) return {};
  const repo = new DrawdownStateRepository({ ch, bundleIdColumnPresent: true });
  const all = await repo.loadLatestAllScopes({ source: 'paper' });
  return all.perStrategy;
}

/**
 * Default impure read — most recent stage-state-history row for the paper
 * source. Returns null when the table is absent or empty.
 */
async function fetchLatestStageStateFromCH(): Promise<StageStateRow | null> {
  const ch = getClickHouse();
  const present = await stageStateHistoryTableExists(ch);
  if (!present) return null;
  const repo = new StageStateRepository({ ch });
  return repo.loadLatest({ source: 'paper' });
}

/** Pure helper — assemble the daemon section from the raw CH row. Exported for tests. */
export function buildDaemonSection(
  row: DaemonRunRow | null,
  now: Date,
): BriefDaemonSection {
  if (row === null) {
    return {
      lastRunAt: null,
      status: 'no_run_today',
      anomalies: [],
      cellsEvaluated: 0,
      cellsWithDiff: 0,
      ageHours: 0,
    };
  }
  const ageHours = ageHoursOf(row.finished_at, now);
  return {
    lastRunAt: row.finished_at,
    status: parseDaemonStatus(row.status),
    anomalies: parseAnomalies(row.anomalies_json),
    cellsEvaluated: Number(row.cells_evaluated) || 0,
    cellsWithDiff: Number(row.cells_with_diff) || 0,
    ageHours,
  };
}

function parseDaemonStatus(s: string): 'ok' | 'partial' | 'failed' | 'no_run_today' {
  if (s === 'ok' || s === 'partial' || s === 'failed') return s;
  return 'partial';
}

function parseAnomalies(json: string): BriefAnomaly[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is BriefAnomaly =>
        a !== null &&
        typeof a === 'object' &&
        typeof a.severity === 'string' &&
        typeof a.message === 'string',
    );
  } catch {
    return [];
  }
}

function ageHoursOf(iso: string, now: Date): number {
  const cleaned = iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z');
  const t = Date.parse(cleaned);
  if (!Number.isFinite(t)) return 0;
  return (now.getTime() - t) / 3_600_000;
}

/**
 * Pure helper — rank long positions by distance-to-A2 and return top 3
 * qualifying entries. Exported for tests.
 *
 * Distance metric: (current - threshold) / (0 - threshold). 1 = at break-even,
 * 0 = at A2 kill threshold, negative = past kill.
 *
 * Qualifies if distance < WATCHLIST_DISTANCE_PCT (0.5 = halfway to kill) OR
 * barsHeld > WATCHLIST_BARS_HELD (100). Cap at WATCHLIST_TOP_N (3).
 *
 * The `allowlists` Map stamps each qualifying item with `onAllowlist` —
 * `true` iff (bundleId, param, symbol) is on `quantlab.cell_allowlist` FINAL.
 * Pass an empty Map in tests/unconfigured-CH to render every position as ✗.
 */
export function buildWatchlist(
  paper: PaperTradingResponse,
  allowlists: CellAllowlists,
): BriefWatchlistItem[] {
  const items: BriefWatchlistItem[] = [];
  for (const cell of paper.cells) {
    const allowed =
      allowlists.get(allowlistKey(cell.bundleId, cell.param)) ?? new Set<string>();
    for (const p of cell.longPositions) {
      const distance = distanceToKill(p.unrealizedPct);
      const qualifiesByDistance = distance < WATCHLIST_DISTANCE_PCT;
      const qualifiesByDuration = p.barsHeld > WATCHLIST_BARS_HELD;
      if (!qualifiesByDistance && !qualifiesByDuration) continue;
      items.push({
        cellKey: cell.label,           // operator-friendly form, e.g. "mr_v1/p=14"
        symbol: p.symbol,
        barsHeld: p.barsHeld,
        unrealizedPct: p.unrealizedPct,
        distanceToKillPct: distance,
        reason: qualifiesByDistance
          ? `approaching A2 (${A2_KILL_THRESHOLD_PCT}%)`
          : `long-held (>${WATCHLIST_BARS_HELD} bars)`,
        onAllowlist: allowed.has(p.symbol),
      });
    }
  }
  // Sort by distance ascending (closer to kill first), tiebreak by barsHeld desc.
  items.sort((a, b) => {
    if (a.distanceToKillPct !== b.distanceToKillPct) {
      return a.distanceToKillPct - b.distanceToKillPct;
    }
    return b.barsHeld - a.barsHeld;
  });
  return items.slice(0, WATCHLIST_TOP_N);
}

function distanceToKill(unrealizedPct: number): number {
  return (unrealizedPct - A2_KILL_THRESHOLD_PCT) / (0 - A2_KILL_THRESHOLD_PCT);
}

const MS_PER_DAY_FOR_BRIEF = 86_400_000;

/**
 * Pure helper — derive the brief's drawdown section from the latest stored
 * row. Returns null when no row exists; the renderer handles that as
 * "framework not yet evaluated." Exported for tests.
 *
 * Note: `regimeExplained` and `partialWindow` are not stored on the history
 * row (the repository persists only the inputs + level + entry timestamp).
 * The brief re-derives `regimeExplained` from the stored `regimeRedDays30 +
 * level` using the same rule as the framework (SPEC §6). `partialWindow`
 * is conservatively `false` here — the brief's panel does not have access
 * to the live_trades ledger at render time (the daemon's panel-input would
 * need to recompute). Acceptable: the daemon log line shows partial-window
 * at the actual evaluation moment.
 */
export function buildDrawdownSection(
  row: DrawdownStateRow | null,
  now: Date,
  perStrategyRows: Record<string, DrawdownStateRow> = {},
): BriefDrawdownSection | null {
  if (row === null) return null;
  const level = row.level;
  // SPEC §6: regimeExplained iff level ∈ {1,2,3} AND regimeRedDays30 ≥ 14.
  const regimeExplained = level >= 1 && level <= 3 && row.regimeRedDays30 >= 14;
  const daysAtLevel = Math.max(
    0,
    Math.floor((now.getTime() - row.levelEnteredAt.getTime()) / MS_PER_DAY_FOR_BRIEF),
  );
  // strategy-tagged-drawdown-state.md §7.4 — per-strategy sub-rows, sorted
  // alphabetically by bundleId so byte-equal-stdout tests remain feasible.
  // Re-derives sizingMultiplier / reviewRequirement / newEntriesAllowed via
  // the same accessors the portfolio section uses (single source of truth
  // for the SPEC §3 column values).
  const perStrategy: BriefDrawdownStrategyRow[] = Object.entries(perStrategyRows)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bundleId, r]) => {
      const sDays = Math.max(
        0,
        Math.floor((now.getTime() - r.levelEnteredAt.getTime()) / MS_PER_DAY_FOR_BRIEF),
      );
      const sLevel = r.level;
      const sRegimeExplained =
        sLevel >= 1 && sLevel <= 3 && r.regimeRedDays30 >= 14;
      return {
        bundleId,
        level: sLevel,
        drawdown30dPct: r.drawdown30dPct,
        sizingMultiplier: sizingMultiplierForLevel(sLevel),
        newEntriesAllowed: computeNewEntriesAllowed(sLevel, now, r.levelEnteredAt),
        reviewRequirement: reviewRequirementForLevel(sLevel),
        regimeExplained: sRegimeExplained,
        regimeRedDays30: r.regimeRedDays30,
        daysAtLevel: sDays,
        levelEnteredAt: r.levelEnteredAt.toISOString(),
      };
    });
  return {
    evaluatedAt: row.evaluatedAt.toISOString(),
    level,
    drawdown30dPct: row.drawdown30dPct,
    sizingMultiplier: sizingMultiplierForLevel(level),
    newEntriesAllowed: computeNewEntriesAllowed(level, now, row.levelEnteredAt),
    reviewRequirement: reviewRequirementForLevel(level),
    regimeExplained,
    regimeRedDays30: row.regimeRedDays30,
    partialWindow: false,
    daysAtLevel,
    levelEnteredAt: row.levelEnteredAt.toISOString(),
    source: row.source,
    stage: row.stage,
    // Omit `perStrategy` entirely when empty so the portfolio block stays
    // byte-equal to pre-Phase-B fixtures (the renderer also short-circuits
    // on `!d.perStrategy || d.perStrategy.length === 0`).
    ...(perStrategy.length > 0 ? { perStrategy } : {}),
  };
}

/**
 * Pure helper — assemble the stage-state brief section from the latest
 * stored row + the halt-sentinel presence flag. Returns null when no row
 * exists; the renderer handles that as "framework not yet evaluated."
 * Exported for tests.
 *
 * Pulls minDurationDays + allocationPct from `DEPLOYMENT_STAGES` rather than
 * persisting them on each row — they're config-pinned (per ADR-039) and
 * re-reading from config keeps the brief honest about the CURRENT effective
 * values, not what was in force when the row was written. The config_version
 * on the row is the audit anchor that lets the operator detect mismatch.
 *
 * Dollar-deployment fields (`liquidBucketUsd`, `stageDeployedUsd`,
 * `cellCapitalUsd`, `numCells`) are re-derived from `computePerCellCapital`
 * per docs/specs/per-cell-stage-sizing.md §9.2 using the brief-module
 * constants `BRIEF_LIQUID_BUCKET_USD` + `BRIEF_NUM_CELLS`. NOT persisted on
 * the audit row — re-derive at render time reflects current effective config,
 * config_version on the row is the historical audit anchor.
 *
 * HALT semantics: `cellCapitalUsd` is 0 iff the most recent row's
 * `decision === 'halt'`. The pure helper passes `halted = (row.decision ===
 * 'halt')`; that's the canonical signal (sentinel presence alone is not
 * authoritative per session 55 halt mechanic — operator MUST run
 * `npm run stage:clear-halt:apply` to clear, regardless of the file).
 */
export function buildStageSection(
  row: StageStateRow | null,
  haltSentinelPresent: boolean,
  opts?: {
    /** Override the liquid-bucket constant for tests. Defaults to BRIEF_LIQUID_BUCKET_USD. */
    liquidBucketUsd?: number;
    /** Override the cell-count constant for tests. Defaults to BRIEF_NUM_CELLS. */
    numCells?: number;
    /**
     * SPEC docs/specs/kill-criteria-daily-history.md §10 (critic H-2 fix):
     * surface the daemon's kill-criteria assembly path. The composer derives
     * this from a bootstrap-time `killCriteriaDailyTableExists` probe:
     * presence → 'history'; absence → 'rolling-asof-shortcut'. Optional/
     * defaulted to undefined so existing test callers keep working byte-equal.
     */
    killCriteriaSource?: 'history' | 'rolling-asof-shortcut';
    /**
     * ADR-040 SPEC §10.1 — when provided, populates the cellWeights* fields
     * on the returned BriefStageSection. When omitted, those fields stay
     * undefined and the renderer skips the weighting line (back-compat
     * with pre-ADR-040 fixtures).
     */
    cellWeights?: ResolveCellWeightsResult;
  },
): BriefStageSection | null {
  if (row === null) return null;
  // The effective stage after this evaluation = stageAfter (transition target
  // for promote/rollback/clear-halt; same as stageBefore for hold/halt).
  const effective = DEPLOYMENT_STAGES[row.stageAfter];
  // minDuration shown reflects the stage we're CURRENTLY AT — i.e. stageBefore
  // for hold (still accruing days at that stage) or stageAfter for transitions
  // (the new stage; clock resets). For visual consistency, surface the
  // BEFORE stage's minDuration since `daysAtStage` is measured at stageBefore.
  const beforeCfg = DEPLOYMENT_STAGES[row.stageBefore];

  // SPEC docs/specs/per-cell-stage-sizing.md §9 — re-derive dollar splits at
  // render time from the same pure helper the daemon uses, so the brief and
  // daemon agree by construction (given matching constants).
  const liquidBucketUsd = opts?.liquidBucketUsd ?? BRIEF_LIQUID_BUCKET_USD;
  const numCells = opts?.numCells ?? BRIEF_NUM_CELLS;
  // Critic H-1 fix (session 56): OR-compose sentinel presence so the brief and
  // daemon agree on HALT state even between a clear-halt CLI run and the next
  // daemon eval. The state machine treats sentinel-present as authoritative
  // halt (stage_state.ts:227); the brief mirrors that here so cellCap doesn't
  // render non-zero while the sentinel is on disk.
  const perCell = computePerCellCapital({
    liquidBucketUsd,
    stage: row.stageAfter,
    numCells,
    halted: row.decision === 'halt' || haltSentinelPresent,
  });

  return {
    evaluatedAt: row.evaluatedAt.toISOString(),
    decision: row.decision,
    stageBefore: row.stageBefore,
    stageAfter: row.stageAfter,
    reason: row.reason,
    daysAtStage: row.daysAtStage,
    minDurationDays: beforeCfg.minDurationDays,
    allocationPct: effective.allocationPct,
    sharpeWindow: row.sharpeWindow,
    maxDdWindow: row.maxDdWindow,
    consecutiveA1A5PassDays: row.consecutiveA1A5PassDays,
    killCriteriaFailCodes: row.killCriteriaFailCodes,
    revalidationRemainingDays: row.revalidationRemainingDays,
    drawdownLevel: row.drawdownLevel,
    source: row.source,
    haltSentinelPresent,
    liquidBucketUsd,
    stageDeployedUsd: perCell.stageDeployedUsd,
    cellCapitalUsd: perCell.cellCapitalUsd,
    numCells,
    killCriteriaSource: opts?.killCriteriaSource,
    cellWeightsTier: opts?.cellWeights?.tierActive,
    cellWeightsObservedDaysWithTrades: opts?.cellWeights?.observedDaysWithTrades,
    cellWeightsObservedMinClosedTrades: opts?.cellWeights?.observedMinClosedTrades,
    cellWeightsRatchetHeld: opts?.cellWeights?.ratchetHeld,
    cellWeightsByCell: opts?.cellWeights?.weights,
    cellWeightsDegraded: opts?.cellWeights?.degraded,
  };
}

/**
 * ADR-040 SPEC §10.2 — default impure read for the brief's cell-weights
 * surface. Resolves through `resolveCellWeightsForRun` which already handles
 * CH-outage graceful-degrade (DEGRADED suffix). Tests inject a stub.
 */
async function defaultFetchCellWeightsForBrief(opts: {
  refDate: Date;
  cellKeys: readonly string[];
  cellCapitalUsdProxy: number;
}): Promise<ResolveCellWeightsResult> {
  // SPEC §10.2 — "re-derive at brief time" means use the SAME
  // resolveCellWeightsForRun the daemon uses, including the SAME
  // priorActiveTier from cell_weights_history. Brief and daemon MUST agree
  // on tier; without the shared lookup the brief would silently flap to T0
  // after the first ratchet event while the daemon stayed at T1+. (Critic
  // M-1 fix to the CODE session.)
  const priorActiveTier = await loadPriorActiveCellWeightsTier();
  return resolveCellWeightsForRun({
    cellKeys: opts.cellKeys,
    refDate: opts.refDate,
    cellCapitalUsdProxy: opts.cellCapitalUsdProxy,
    priorActiveTier,
  });
}

// Re-export types for the CLI script and tests.
export type {
  RegimeStateResponse,
  PaperTradingResponse,
  MorningBrief,
  BriefDrawdownSection,
  BriefStageSection,
};

/**
 * What could break this:
 *  - A future bias-note refactor that returns null for the body. The throw
 *    on lines 89-92 is a load-bearing safety check (SPEC §2.2 / §4.4).
 *  - Schema drift in `quantlab.daemon_runs` (e.g. column rename). The CH
 *    query in fetchLastDaemonRunFromCH would surface the error at brief-
 *    generation time. Keep the schema and this query in sync.
 *  - Watch-list threshold tuning. The constants at the top of this file are
 *    SPEC §2.5 lock-ins; they should move only with explicit user feedback
 *    after operational use.
 */
