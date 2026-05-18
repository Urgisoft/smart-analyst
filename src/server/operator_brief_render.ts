/**
 * Track C / Component 4 — pure markdown renderer for the operator morning brief.
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §3, §4.
 *
 * Pure function — no I/O, no clock reads. The composer
 * (src/server/operator_brief.ts) constructs a MorningBrief object and passes
 * it here. Tests in scripts/tests/operatorBriefRender.test.ts exercise every
 * branch (regime colors, kill-criteria FAIL header bump, daemon staleness
 * states, watch-list edge cases).
 *
 * The bias note is rendered VERBATIM from the active banner constant
 * (currently `BIAS_NOTE_PHASE1_V3`; `BIAS_NOTE_PHASE1_V2` remains
 * exported for archival references). Never paraphrased. Test #15
 * enforces this. See SPEC §2.2 / §7.1.
 */
import type { BiasNote } from './regime_dashboard.js';
import type { Regime, MacroRegimeRow } from './macro_regime.js';
import type { KillCriterionVerdict } from './paper_trading_kill_criteria.js';
import type {
  DrawdownLevel,
  DrawdownReviewRequirement,
  SizingMultiplier,
} from './drawdown_state.js';
import type {
  StageDecision,
  StageReason,
  KillCriterionCode,
} from './stage_state.js';
import type { DeploymentStage } from './capital_deployment_config.js';

export interface BriefAnomaly {
  severity: 'info' | 'warning' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface BriefDaemonSection {
  lastRunAt: string | null;
  status: 'ok' | 'partial' | 'failed' | 'no_run_today';
  anomalies: BriefAnomaly[];
  cellsEvaluated: number;
  cellsWithDiff: number;
  ageHours: number;
}

export interface BriefWatchlistItem {
  cellKey: string;
  symbol: string;
  barsHeld: number;
  unrealizedPct: number;
  /** 0 = at-kill threshold; 1 = far from kill. */
  distanceToKillPct: number;
  reason: string;
  /**
   * Whether (bundleId, param, symbol) is on `quantlab.cell_allowlist` FINAL.
   * Surfaces session-42 NEW-LOW: top-3 watch-list mixes allowlist-validated
   * and violation positions with no visual distinction. ✓ = backtest-validated;
   * ✗ = currently-open violation per Component 7B.
   */
  onAllowlist: boolean;
}

export interface BriefRegimeSection {
  today: MacroRegimeRow;
  daysInCurrentRegime: number;
  biasNote: BiasNote;
}

/**
 * Drawdown-response framework section. `null` when the framework has no
 * evaluation row yet (drawdown_state_history table absent OR empty). SPEC
 * docs/specs/drawdown-response-framework.md §7.4.
 */
export interface BriefDrawdownSection {
  /** Most recent evaluation timestamp (ISO 8601 with ms). */
  evaluatedAt: string;
  level: DrawdownLevel;
  /** Trailing-30d realized P&L / deployed capital, as a fraction (e.g. -0.08). */
  drawdown30dPct: number;
  sizingMultiplier: SizingMultiplier;
  newEntriesAllowed: boolean;
  reviewRequirement: DrawdownReviewRequirement;
  regimeExplained: boolean;
  regimeRedDays30: number;
  partialWindow: boolean;
  /** Whole days elapsed since the most recent transition INTO `level`. */
  daysAtLevel: number;
  /** When the framework most recently transitioned INTO `level`. */
  levelEnteredAt: string;
  source: 'paper' | 'live';
  stage: string;
}

/**
 * Capital deployment stage state machine section. `null` when no row exists
 * (table absent OR first-ever run). SPEC docs/specs/stage-state-machine.md §14.
 */
export interface BriefStageSection {
  evaluatedAt: string;
  decision: StageDecision;
  stageBefore: DeploymentStage;
  stageAfter: DeploymentStage;
  reason: StageReason | 'operator-cleared-halt';
  daysAtStage: number;
  /** ADR-039 §1 minDuration for `stageBefore`, or null at terminal stage4. */
  minDurationDays: number | null;
  /** ADR-039 §1 allocationPct for the EFFECTIVE stage (= stageAfter). */
  allocationPct: number;
  sharpeWindow: number;        // NaN-coerced: 0 means undefined per repo safeFloat
  maxDdWindow: number;         // ≤ 0 fraction; 0 means undefined or no drawdown
  /** 0..30 — paper→stage1 gate visibility. */
  consecutiveA1A5PassDays: number;
  killCriteriaFailCodes: ReadonlyArray<KillCriterionCode>;
  /** 0 when timer is inactive; > 0 = days until re-promotion eligible. */
  revalidationRemainingDays: number;
  /** Latest drawdown framework state for this source (mirrored from the row). */
  drawdownLevel: DrawdownLevel;
  source: 'paper' | 'live';
  /** True iff `.stage_halt` sentinel file is present at brief-render time. */
  haltSentinelPresent: boolean;
  /**
   * Operator-set "liquid SignalForge capital" bucket, USD. SPEC
   * docs/specs/per-cell-stage-sizing.md §9. Re-derived at brief time
   * (NOT persisted) so the rendered figure reflects the CURRENT
   * operator-set bucket, not the historical one. The config_version on
   * the row is the audit anchor for historical reconstruction.
   */
  liquidBucketUsd: number;
  /** Total dollars deployed at the effective stage = liquidBucketUsd × allocationPct (paper uses full bucket). */
  stageDeployedUsd: number;
  /** Per-cell dollar cap = stageDeployedUsd / numCells (paper uses full bucket; HALT collapses to 0). */
  cellCapitalUsd: number;
  /** Active cell count this run; equal-weight split denominator. */
  numCells: number;
  /**
   * ADR-040 SPEC §10.1 — correlation-weighted per-cell allocation panel
   * surface. Re-derived at brief time (NOT persisted on `stage_state_history`)
   * — operationally-visible numbers reflect CURRENT configuration, same
   * discipline as the per-cell-stage-sizing dollar splits. `null` only when
   * the brief composer has no stage row at all (in which case the whole
   * stage section is skipped); when present the renderer appends the
   * weighting line directly under the deployment line, EXCEPT when
   * `decision === 'halt'` (the HALT marker already communicates that
   * weights are operationally moot, SPEC §10.3).
   */
  cellWeightsTier?: 'T0' | 'T1' | 'T2';
  cellWeightsObservedDaysWithTrades?: number;
  cellWeightsObservedMinClosedTrades?: number;
  cellWeightsRatchetHeld?: boolean;
  cellWeightsByCell?: ReadonlyMap<string, number>;
  cellWeightsDegraded?: boolean;
  /**
   * Which trailing-30 kill-criteria assembly path the daemon uses to gate
   * the §5 streak (SPEC docs/specs/kill-criteria-daily-history.md):
   *   - 'history'              — honest fix; per-day verdicts read from
   *                              quantlab.kill_criteria_daily.
   *   - 'rolling-asof-shortcut' — legacy fallback; STRICTER-than-literal
   *                              §5 (today's B1/A2/A3 failure wipes the
   *                              streak). When this fires the operator
   *                              should consider running
   *                              `npm run migrate:kill-criteria-daily:apply`
   *                              (note: applying mid-streak resets any
   *                              apparent streak count for 9 more days
   *                              until honest history accumulates).
   * Defaulted to 'history' on legacy builders so existing tests keep
   * passing byte-equal; the brief composer sets it explicitly from a
   * bootstrap-time tableExists probe.
   */
  killCriteriaSource?: 'history' | 'rolling-asof-shortcut';
}

export interface MorningBrief {
  generatedAt: string;
  classifierVersion: string;
  regime: BriefRegimeSection;
  killCriteria: KillCriterionVerdict[];
  daemon: BriefDaemonSection;
  watchlist: BriefWatchlistItem[];
  /**
   * Drawdown-response framework state. `null` when the table is absent or
   * has no rows for the current source. SPEC §7.4 — APPENDED at end of brief
   * to preserve byte-equal-stdout protection on existing sections.
   */
  drawdown: BriefDrawdownSection | null;
  /**
   * Capital deployment stage state machine. `null` when the table is absent
   * or has no rows. APPENDED as section #6 — preserves byte-equal-stdout
   * protection on sections 1-5.
   */
  stage: BriefStageSection | null;
}

/** Render the brief as operator-facing markdown. Pure. */
export function renderBriefMarkdown(brief: MorningBrief): string {
  const parts: string[] = [];
  parts.push(renderHeader(brief));
  parts.push('');
  parts.push(renderRegimeSection(brief));
  parts.push('');
  parts.push(renderKillCriteriaSection(brief));
  parts.push('');
  parts.push(renderDaemonSection(brief));
  parts.push('');
  parts.push(renderWatchlistSection(brief));
  parts.push('');
  parts.push(renderDrawdownSection(brief));
  parts.push('');
  parts.push(renderStageSection(brief));
  parts.push('');
  return parts.join('\n');
}

function renderHeader(b: MorningBrief): string {
  return [
    `# Operator morning brief — ${b.generatedAt}`,
    ``,
    `Classifier: \`${b.classifierVersion}\``,
  ].join('\n');
}

function renderRegimeSection(b: MorningBrief): string {
  const r = b.regime;
  const regimeLabel = (r.today.regime as Regime).toUpperCase();
  const lines: string[] = [];
  lines.push(`## 1. Macro regime — today`);
  lines.push(``);
  lines.push(
    `**${regimeLabel}** · day ${r.daysInCurrentRegime} in this regime · classifier \`${b.classifierVersion}\``,
  );
  lines.push(``);
  lines.push(`> **${r.biasNote.headline}**`);
  lines.push(`>`);
  lines.push(`> ${r.biasNote.body}`);
  if (r.biasNote.docLinks.length > 0) {
    lines.push(`>`);
    lines.push(`> ${r.biasNote.docLinks.map(l => `[${l.label}](${l.href})`).join(' · ')}`);
  }
  lines.push(`>`);
  lines.push(`> Fixture failures under this classifier: ${r.biasNote.fixtureFailures}`);
  return lines.join('\n');
}

function renderKillCriteriaSection(b: MorningBrief): string {
  const failing = b.killCriteria.filter(v => v.verdict === 'fail');
  const header =
    failing.length > 0
      ? `## 2. Kill criteria — ⚠ FAIL OVERNIGHT`
      : `## 2. Kill criteria — overnight`;
  const lines: string[] = [];
  lines.push(header);
  lines.push(``);
  lines.push(`| Code | Verdict | Rationale |`);
  lines.push(`| --- | --- | --- |`);
  for (const v of b.killCriteria) {
    const verdictMark =
      v.verdict === 'pass' ? '✓ pass'
      : v.verdict === 'fail' ? '✗ FAIL'
      : '— insufficient_data';
    lines.push(`| ${v.code} | ${verdictMark} | ${truncate(v.rationale, 100)} |`);
  }
  return lines.join('\n');
}

function renderDaemonSection(b: MorningBrief): string {
  const d = b.daemon;
  const lines: string[] = [];
  if (d.status === 'no_run_today') {
    lines.push(`## 3. Last daemon run — ⚠ no run on file`);
    lines.push(``);
    lines.push(`No daemon_runs row found. Run \`npm run daemon:daily\` to populate.`);
    return lines.join('\n');
  }
  if (d.ageHours >= 24) {
    lines.push(`## 3. Last daemon run — ⚠ stale (${d.ageHours.toFixed(1)}h ago)`);
  } else if (d.status === 'failed') {
    lines.push(`## 3. Last daemon run — ⚠ failed`);
  } else if (d.status === 'partial') {
    lines.push(`## 3. Last daemon run — partial`);
  } else {
    lines.push(`## 3. Last daemon run — ok`);
  }
  lines.push(``);
  lines.push(
    `Last run: \`${d.lastRunAt}\` (${d.ageHours.toFixed(1)}h ago) · cells evaluated: ${d.cellsEvaluated} · cells with diff: ${d.cellsWithDiff}`,
  );
  if (d.anomalies.length === 0) {
    lines.push(``);
    lines.push(`No anomalies recorded.`);
  } else {
    lines.push(``);
    lines.push(`Anomalies (${d.anomalies.length}):`);
    lines.push(``);
    for (const a of d.anomalies) {
      const tag = a.severity === 'error' ? '✗' : a.severity === 'warning' ? '⚠' : '·';
      lines.push(`- ${tag} **${a.severity}** — ${truncate(a.message, 100)}`);
    }
  }
  return lines.join('\n');
}

function renderWatchlistSection(b: MorningBrief): string {
  const lines: string[] = [];
  lines.push(`## 4. Watch-list — top ${Math.min(3, b.watchlist.length || 3)}`);
  lines.push(``);
  if (b.watchlist.length === 0) {
    lines.push(`(no positions within 50% of any kill threshold)`);
    return lines.join('\n');
  }
  lines.push(`| Cell | Symbol | Allowlist | Bars held | Unrealized | Distance to kill | Reason |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const w of b.watchlist) {
    const allowlistMark = w.onAllowlist ? '✓' : '✗';
    lines.push(
      `| \`${w.cellKey}\` | ${w.symbol} | ${allowlistMark} | ${w.barsHeld} | ${fmtPct(w.unrealizedPct)} | ${fmtPct((1 - w.distanceToKillPct) * 100)} of kill | ${truncate(w.reason, 60)} |`,
    );
  }
  return lines.join('\n');
}

function renderDrawdownSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.drawdown === null) {
    lines.push(`## 5. Drawdown response — framework not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.drawdown_state_history\` is empty (or absent). ` +
      `Apply \`npm run migrate:drawdown-state-history:apply\` and the next ` +
      `\`npm run daemon:daily\` will compute today's state. ` +
      `SPEC: docs/specs/drawdown-response-framework.md §8.`,
    );
    return lines.join('\n');
  }
  const d = b.drawdown;
  const levelLabel = drawdownLevelLabel(d.level);
  const headerSuffix = d.level === 0 ? '' : d.newEntriesAllowed ? '' : ' — entries BLOCKED';
  lines.push(`## 5. Drawdown response — Level ${d.level} (${levelLabel})${headerSuffix}`);
  lines.push(``);
  const ddPct = (d.drawdown30dPct * 100).toFixed(2);
  const ddSign = d.drawdown30dPct >= 0 ? '+' : '';
  const partialNote = d.partialWindow ? ' (partial 30-day window)' : '';
  lines.push(`**Drawdown 30d (realized):** ${ddSign}${ddPct}%${partialNote}`);
  lines.push(`**Days at this level:** ${d.daysAtLevel} (entered ${d.levelEnteredAt})`);
  // effective per-trade risk: SPEC §6 default 2% × sizingMultiplier.
  const effectiveRiskPct = (0.02 * d.sizingMultiplier * 100).toFixed(2);
  lines.push(`**Sizing multiplier:** ${d.sizingMultiplier}× (effective per-trade risk: ${effectiveRiskPct}% of capital)`);
  lines.push(`**New entries:** ${d.newEntriesAllowed ? 'allowed' : '⚠ BLOCKED'}`);
  lines.push(`**Review:** ${d.reviewRequirement}`);
  const regimeFlag = d.regimeExplained
    ? `regime-explained (${d.regimeRedDays30} RED days in trailing 30)`
    : `unexplained (${d.regimeRedDays30} RED days in trailing 30)`;
  lines.push(`**Regime context:** ${regimeFlag}`);
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${d.evaluatedAt}\` · source: \`${d.source}\` · stage: \`${d.stage}\`._`,
  );
  return lines.join('\n');
}

function renderStageSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.stage === null) {
    lines.push(`## 6. Capital deployment stage — framework not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.stage_state_history\` is empty (or absent). ` +
      `Apply \`npm run migrate:stage-state-history:apply\` and the next ` +
      `\`npm run daemon:daily\` will compute today's state. ` +
      `SPEC: docs/specs/stage-state-machine.md §11.`,
    );
    return lines.join('\n');
  }
  const s = b.stage;
  const headerTag =
    s.decision === 'halt'         ? ' — ⚠ HALTED (operator review required)' :
    s.decision === 'rollback'     ? ` — ⚠ ROLLBACK ${s.stageBefore} → ${s.stageAfter}` :
    s.decision === 'promote'      ? ` — ↑ PROMOTE ${s.stageBefore} → ${s.stageAfter}` :
    s.decision === 'clear-halt'   ? ' — ✓ HALT CLEARED' :
                                    '';
  lines.push(`## 6. Capital deployment stage${headerTag}`);
  lines.push(``);
  const stageLabel = stageDisplayLabel(s.stageAfter);
  const allocPct = (s.allocationPct * 100).toFixed(0);
  lines.push(`**Stage:** \`${s.stageAfter}\` — ${stageLabel} (${allocPct}% of liquid bucket)`);
  // SPEC docs/specs/per-cell-stage-sizing.md §9.3 — dollar split surface.
  // HALT-rendered when cellCapitalUsd is exactly 0 (haltedZeroed equivalent).
  const cellCapStr = `$${s.cellCapitalUsd.toFixed(2)}`;
  const deployedStr = `$${s.stageDeployedUsd.toFixed(2)}`;
  if (s.cellCapitalUsd === 0 && s.decision === 'halt') {
    lines.push(`**Deployment:** ${deployedStr} across ${s.numCells} cells (cellCap=${cellCapStr} — HALT)`);
  } else {
    lines.push(`**Deployment:** ${deployedStr} across ${s.numCells} cells (cellCap=${cellCapStr} each)`);
  }
  // ADR-040 SPEC §10.3 — correlation-weighted allocation tier line, directly
  // under the deployment line. Omitted on HALT (the HALT marker already
  // communicates weights are operationally moot). HALT here means EITHER
  // `decision === 'halt'` OR sentinel-on-disk — the brief composer already
  // OR-composes the sentinel into cellCapitalUsd via `buildStageSection`
  // (which renders cellCap=$0.00 under sentinel-only halt); the weighting
  // line must follow the same discipline or the operator sees
  // `cellCap=$0.00` immediately above an active weighting line. (Critic
  // M-2 fix to the CODE session.)
  if (s.cellWeightsTier !== undefined && s.decision !== 'halt' && !s.haltSentinelPresent) {
    lines.push(renderCellWeightsLine(s));
  }
  if (s.minDurationDays !== null) {
    lines.push(`**Days at stage:** ${s.daysAtStage} / ${s.minDurationDays} (min duration)`);
  } else {
    lines.push(`**Days at stage:** ${s.daysAtStage} (terminal stage — no further promotion)`);
  }
  lines.push(`**Decision today:** ${decisionMark(s.decision)} — ${humanReason(s.reason)}`);
  if (!Number.isNaN(s.sharpeWindow) && s.sharpeWindow !== 0) {
    const sharpeStr =
      s.sharpeWindow === 1e308  ? '+∞ (zero variance, positive mean)' :
      s.sharpeWindow === -1e308 ? '-∞ (zero variance, negative mean)' :
                                  s.sharpeWindow.toFixed(3);
    lines.push(`**Sharpe (window):** ${sharpeStr}`);
  }
  if (s.maxDdWindow < 0) {
    lines.push(`**Max drawdown (window):** ${(s.maxDdWindow * 100).toFixed(2)}%`);
  }
  if (s.stageBefore === 'paper') {
    lines.push(`**A1-A5 pass streak:** ${s.consecutiveA1A5PassDays} days`);
    // SPEC docs/specs/kill-criteria-daily-history.md §10 (critic H-2 fix):
    // surface the streak's data source when the daemon is on the legacy
    // rolling-asOf shortcut — operationally STRICTER than ADR-039 §5. The
    // operator needs visibility because (a) the displayed streak is the
    // "today's snapshot applied 30×" shortcut, not honest per-day history,
    // and (b) running the kill_criteria_daily migration mid-streak resets
    // the apparent count for 9 more days while honest history accumulates.
    if (s.killCriteriaSource === 'rolling-asof-shortcut') {
      lines.push(
        `> _Streak source: rolling-asOf shortcut (stricter-than-literal ADR-039 §5; today's B1/A2/A3 failure wipes the count). ` +
        `Apply \`npm run migrate:kill-criteria-daily:apply\` to switch to honest per-day history — note: streak resets for 9 more days while history accumulates._`,
      );
    }
  }
  if (s.killCriteriaFailCodes.length > 0) {
    lines.push(`**Kill criteria FAILING today:** ${s.killCriteriaFailCodes.join(', ')}`);
  }
  if (s.revalidationRemainingDays > 0) {
    lines.push(`**Re-validation timer:** ${s.revalidationRemainingDays} days remaining (cannot re-promote yet)`);
  } else {
    lines.push(`**Re-validation timer:** not active`);
  }
  lines.push(`**Drawdown framework level:** ${s.drawdownLevel}`);
  lines.push(`**Halt sentinel:** ${s.haltSentinelPresent ? '⚠ PRESENT (`.stage_halt`)' : 'absent'}`);
  if (s.decision === 'halt') {
    lines.push(``);
    lines.push(`> **OPERATOR REVIEW REQUIRED.** Clear via \`npm run stage:clear-halt\` once the underlying issue is understood.`);
  }
  lines.push(``);
  lines.push(`_Last evaluated: \`${s.evaluatedAt}\` · source: \`${s.source}\`._`);
  return lines.join('\n');
}

/**
 * ADR-040 SPEC §10.3 — render the weighting summary line. Variants:
 *   T0:           `weighting=equal (T0, obsDays=0, minTrades=0)`
 *   T1:           `weighting=IVW (T1, obsDays=92, minTrades=42) — k1:0.667 / k2:0.333`
 *   T2:           `weighting=HRP (T2, obsDays=180, minTrades=78) — k1:0.310 / k2:...`
 *   ratchet held: trailing `[ratchet:T1 held]`
 *   DEGRADED:     trailing `[DEGRADED: CH unavailable]`
 *
 * Caller is responsible for not invoking this on HALT (the §10.3 rule —
 * HALT marker already communicates weights are operationally moot). Pinned
 * by `operatorBriefRender.test.ts` tests 51-55.
 */
function renderCellWeightsLine(s: BriefStageSection): string {
  const tier = s.cellWeightsTier!;
  const methodLabel = tier === 'T0' ? 'equal' : tier === 'T1' ? 'IVW' : 'HRP';
  const obsDays = s.cellWeightsObservedDaysWithTrades ?? 0;
  const minTrades = s.cellWeightsObservedMinClosedTrades ?? 0;
  let line = `**Weighting:** ${methodLabel} (${tier}, obsDays=${obsDays}, minTrades=${minTrades})`;
  // T1/T2 enumerate the per-cell weights; T0 does not (always 1/N — visible
  // from the deployment line's cellCap).
  if (tier !== 'T0' && s.cellWeightsByCell !== undefined) {
    const parts: string[] = [];
    for (const [k, v] of s.cellWeightsByCell) parts.push(`${k}:${v.toFixed(3)}`);
    if (parts.length > 0) line += ` — ${parts.join(' / ')}`;
  }
  if (s.cellWeightsRatchetHeld) line += ` [ratchet:${tier} held]`;
  if (s.cellWeightsDegraded) line += ` [DEGRADED: CH unavailable]`;
  return line;
}

function stageDisplayLabel(stage: DeploymentStage): string {
  switch (stage) {
    case 'paper':  return 'Paper trading (shakedown)';
    case 'stage1': return 'Stage 1 — Initial (5%)';
    case 'stage2': return 'Stage 2 — First increase (15%)';
    case 'stage3': return 'Stage 3 — Meaningful (30%)';
    case 'stage4': return 'Stage 4 — Full (50% ceiling)';
  }
}

function decisionMark(d: StageDecision): string {
  switch (d) {
    case 'hold':       return 'HOLD';
    case 'promote':    return '↑ PROMOTE';
    case 'rollback':   return '⚠ ROLLBACK';
    case 'halt':       return '⚠ HALT';
    case 'clear-halt': return '✓ HALT CLEARED';
  }
}

function humanReason(reason: StageReason | 'operator-cleared-halt'): string {
  switch (reason) {
    case 'pass-criteria-met':                   return 'pass criteria met';
    case 'fail-drawdown':                       return 'drawdown breached stage threshold';
    case 'fail-level3-entry':                   return 'drawdown framework Level-3 entry event';
    case 'min-duration-not-met':                return 'minimum duration at stage not yet met';
    case 'sharpe-below-floor':                  return 'Sharpe below promotion floor';
    case 'maxdd-floor-breached':                return 'max drawdown deeper than promotion floor';
    case 'kill-criteria-fail':                  return 'one or more A1-A5 kill criteria failing';
    case 'stage3-level-above-2':                return 'drawdown framework level > 2 (stage 3 cannot promote)';
    case 'revalidation-timer-active':           return '60-day re-validation timer still running';
    case 'priorstage-days-insufficient':        return 'cumulative days at prior stages insufficient';
    case 'paper-a1a5-pass-streak-insufficient': return '≥10 consecutive A1-A5 pass days not yet accumulated';
    case 'two-consecutive-failures':            return 'two consecutive failures (ADR-039 §4)';
    case 'halt-active':                         return 'halt sentinel or prior halt row';
    case 'terminal-stage':                      return 'terminal stage (no further promotion)';
    case 'operator-cleared-halt':               return 'operator cleared halt via stage:clear-halt';
  }
}

function drawdownLevelLabel(level: DrawdownLevel): string {
  switch (level) {
    case 0: return 'Normal';
    case 1: return 'Caution';
    case 2: return 'Concern';
    case 3: return 'Defensive';
    case 4: return 'Critical';
    case 5: return 'Kill';
  }
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * What could break this:
 *  - A future refactor that paraphrases the bias note inline. Test #15 catches
 *    this — the rendered output must contain the active bias-note body
 *    (currently `BIAS_NOTE_PHASE1_V3`) verbatim.
 *  - Adding a kill criterion to evaluateKillCriteria without updating the
 *    table column count. The renderer iterates whatever the composer hands
 *    over, so this is robust by design — but section #2 of the SPEC fixes
 *    column count at 3 (Code/Verdict/Rationale). New columns require a
 *    coordinated SPEC + render edit.
 *  - Watch-list with > 3 items. The composer is responsible for capping at 3
 *    per SPEC §2.5; the renderer prints whatever it receives.
 */
