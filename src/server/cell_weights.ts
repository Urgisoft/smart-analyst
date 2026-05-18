/**
 * ADR-040 — Correlation-weighted per-cell allocation (pure math layer).
 *
 * SPEC: docs/specs/correlation-weighted-per-cell-allocation.md §§3-7.
 * ADR:  docs/decisions/README.md ADR-040 (forthcoming) — resolves ADR-039
 *       OQ #3 ("intra-stage-allocation split rule").
 *
 * Canon (Tier 1):
 *  - López de Prado, *Advances in Financial Machine Learning* (2018) Ch 16 —
 *    HRP construction; Snippet 16.4 (recursive bisection), Snippet 16.3
 *    (quasi-diag), Snippet 16.2 (IVP variance); §16.4.5 small-sample fallback.
 *  - Bailey-LdP (2014), Deflated Sharpe — selection bias canon (motivates
 *    the LIVE-only source filter applied upstream in cell_pnl_history.ts).
 *
 * Pure module: no clock reads, no I/O, no globals. Throws on caller bugs
 * per SPEC §7 — silent zeroes would let wire-up bugs slip past tests.
 *
 * Architecture:
 *  - `selectCellWeightsTier` — gates T0/T1/T2 on (observedN,
 *    observedDaysWithTrades, observedMinClosedTrades, priorActiveTier) with
 *    ratchet-up-only behavior. Tests pin every threshold.
 *  - `computeCellWeights` — entry point. Dispatches to T0 (equal-weight) /
 *    T1 (inverse-variance) / T2 (HRP) per the selected tier.
 *  - `formatCellWeightsLogLine` — byte-pinned operator log format (§9.5).
 *
 * Pinned constants (SPEC §3 — single source of truth). Future amendments
 * change them via a superseded ADR + an edit here; NOT via env vars / config
 * files / CLI flags. ADR-040 §6 pre-commitment ethos.
 *
 * SPEC §6.3.1 — Determinism: the HRP path alphabetizes cellKeys BEFORE
 * constructing the distance matrix passed to single-linkage clustering,
 * then re-keys output weights back to the original input order. The
 * alphabetize-input canonicalization keeps weights cell-identity-stable
 * across daemon-call insertion orderings, which matters when scipy/our-TS
 * implementation hits ties in the single-linkage tie-break.
 */

// ---------------------------------------------------------------------------
// Pinned constants — must match scripts/_compute_cell_weights_reference.py.
// ---------------------------------------------------------------------------

export const TIER_TRIGGERS = {
  T1: { minN: 2, minDaysWithTrades: 90, minClosedTrades: 30 },
  T2: { minN: 4, minDaysWithTrades: 180, minClosedTrades: 60 },
} as const;

/** SPEC §3 — T1 variance estimation slices the most recent 90 days. */
export const ROLLING_WINDOW_DAYS_T1 = 90;

/** SPEC §3 — T2 covariance estimation consumes the full 180-day series. */
export const ROLLING_WINDOW_DAYS_T2 = 180;

/** SPEC §3 — only paper + live trades feed the variance estimates. */
export const SOURCE_FILTER: ReadonlyArray<'paper' | 'live'> = ['paper', 'live'] as const;

/** SPEC §6.2 — σ² below this is pathological (caller-bug throw). */
const VARIANCE_FLOOR = 1e-12;

/** SPEC §3 ratchet — tier rank used by `selectCellWeightsTier`. */
const TIER_ORDER = { T0: 0, T1: 1, T2: 2 } as const;

// ---------------------------------------------------------------------------
// Types — see SPEC §4 / §5.
// ---------------------------------------------------------------------------

export type CellWeightsTier = 'T0' | 'T1' | 'T2';
export type CellWeightsTierInput = 'auto' | CellWeightsTier;

export interface ComputeCellWeightsInputs {
  cellKeys: readonly string[];
  /**
   * Daily realized log-return series per cell, zero-filled to a common date
   * grid (length always = `ROLLING_WINDOW_DAYS_T2` from `getCellDailyReturns`
   * upstream). Each cell's series MUST have the same length; the upstream
   * accessor is responsible for the alignment.
   */
  dailyReturns: ReadonlyMap<string, ReadonlyArray<number>>;
  closedTradeCounts: ReadonlyMap<string, number>;
  /**
   * SPEC §3 — count of days in the window where the cell had ≥1 closed
   * trade (i.e., the count of NON-zero-fill days). This is the trigger-
   * authoritative data-sufficiency signal — NOT `dailyReturns[k].length`,
   * which is always = `ROLLING_WINDOW_DAYS_T2` after upstream zero-fill.
   */
  observedDays: ReadonlyMap<string, number>;
  /**
   * SPEC §4 / L-4 — `'auto'` (default) applies the §3 trigger ladder with
   * the ratchet-up rule. Explicit T0/T1/T2 bypasses the ladder; FOR UNIT-
   * TEST MATH ISOLATION ONLY. No production call site may pass
   * `tier !== 'auto'`; `resolveCellWeightsForRun` (in per_cell_capital.ts)
   * is the canonical production caller and hardcodes `'auto'`.
   */
  tier: CellWeightsTierInput;
  /**
   * Tier active on the most recent prior daemon run. `null` = no prior
   * history → start at T0. Sourced from `cell_weights_history` FINAL
   * WHERE degraded=0 (SPEC §11.2).
   */
  priorActiveTier: CellWeightsTier | null;
}

export interface ComputeCellWeightsResult {
  tierActive: CellWeightsTier;
  /** Per-cell weights, summing to 1.0 (±1e-9). Map iteration order matches `cellKeys`. */
  weights: ReadonlyMap<string, number>;
  /** Trigger-authoritative signal: min across cells of `observedDays[cell]`. */
  observedDaysWithTrades: number;
  observedN: number;
  observedMinClosedTrades: number;
  /** Length of the zero-filled series consumed (always = ROLLING_WINDOW_DAYS_T2). */
  computeWindowDays: number;
  sufficientForT1: boolean;
  sufficientForT2: boolean;
  /** True iff `tier='auto'` AND the ratchet held the prior tier above what the sample alone would have produced. */
  ratchetHeld: boolean;
}

// ---------------------------------------------------------------------------
// `selectCellWeightsTier` — SPEC §6.4.
// ---------------------------------------------------------------------------

export function selectCellWeightsTier(
  observedN: number,
  observedDaysWithTrades: number,
  observedMinClosedTrades: number,
  priorActiveTier: CellWeightsTier | null,
): CellWeightsTier {
  // SPEC §7 caller-bug throw — mirrors Python `select_tier` (which KeyErrors
  // on `TIER_ORDER[prior]`). At the JS runtime boundary (CH read, JSON parse)
  // an unrecognized string could slip past the TS type system; without this
  // guard, the lookup returns `undefined`, the `>` comparison silently
  // evaluates `false`, and the function returns `triggerSays` instead of
  // ratcheting. Two implementations diverging on the invalid-input boundary
  // is exactly the M-1 critic-fix from L-2 (session 72 cross-check).
  if (priorActiveTier !== null && !(priorActiveTier in TIER_ORDER)) {
    throw new Error(
      `selectCellWeightsTier: unknown priorActiveTier ${JSON.stringify(priorActiveTier)} ` +
        `(expected one of: ${Object.keys(TIER_ORDER).join(', ')}, or null)`,
    );
  }

  const sufficientT1 =
    observedN >= TIER_TRIGGERS.T1.minN &&
    observedDaysWithTrades >= TIER_TRIGGERS.T1.minDaysWithTrades &&
    observedMinClosedTrades >= TIER_TRIGGERS.T1.minClosedTrades;
  const sufficientT2 =
    observedN >= TIER_TRIGGERS.T2.minN &&
    observedDaysWithTrades >= TIER_TRIGGERS.T2.minDaysWithTrades &&
    observedMinClosedTrades >= TIER_TRIGGERS.T2.minClosedTrades;

  const triggerSays: CellWeightsTier = sufficientT2 ? 'T2' : sufficientT1 ? 'T1' : 'T0';

  // SPEC §3 — ratchet-up only. Prior > current trigger → hold prior.
  if (priorActiveTier !== null && TIER_ORDER[priorActiveTier] > TIER_ORDER[triggerSays]) {
    return priorActiveTier;
  }
  return triggerSays;
}

// ---------------------------------------------------------------------------
// `computeCellWeights` — SPEC §4-7.
// ---------------------------------------------------------------------------

export function computeCellWeights(inputs: ComputeCellWeightsInputs): ComputeCellWeightsResult {
  const { cellKeys, dailyReturns, closedTradeCounts, observedDays, tier, priorActiveTier } = inputs;

  // SPEC §7 — caller-bug throws.
  if (cellKeys.length === 0) {
    throw new Error('computeCellWeights: cellKeys must be non-empty');
  }
  const uniqueKeys = new Set(cellKeys);
  if (uniqueKeys.size !== cellKeys.length) {
    throw new Error(`computeCellWeights: cellKeys contains duplicates: [${cellKeys.join(', ')}]`);
  }
  if (dailyReturns.size !== cellKeys.length) {
    throw new Error(
      `computeCellWeights: dailyReturns size (${dailyReturns.size}) does not match ` +
        `cellKeys length (${cellKeys.length})`,
    );
  }
  for (const k of cellKeys) {
    if (!dailyReturns.has(k)) {
      throw new Error(`computeCellWeights: cellKey "${k}" missing from dailyReturns`);
    }
    if (!closedTradeCounts.has(k)) {
      throw new Error(`computeCellWeights: cellKey "${k}" missing from closedTradeCounts`);
    }
    if (!observedDays.has(k)) {
      throw new Error(`computeCellWeights: cellKey "${k}" missing from observedDays`);
    }
  }

  // Series length alignment — every cell's series MUST share length.
  const lens = new Set<number>();
  for (const k of cellKeys) lens.add(dailyReturns.get(k)!.length);
  if (lens.size > 1) {
    throw new Error(
      `computeCellWeights: dailyReturns series lengths disagree across cells: ` +
        `[${Array.from(lens).join(', ')}]`,
    );
  }
  const seriesLen = lens.values().next().value as number;

  // Non-finite guard.
  for (const k of cellKeys) {
    const s = dailyReturns.get(k)!;
    for (let i = 0; i < s.length; i++) {
      if (!Number.isFinite(s[i])) {
        throw new Error(
          `computeCellWeights: non-finite value in dailyReturns["${k}"][${i}] = ${s[i]}`,
        );
      }
    }
  }

  const n = cellKeys.length;
  const observedDaysWithTrades = minAcrossCells(cellKeys, observedDays);
  const observedMinClosedTrades = minAcrossCells(cellKeys, closedTradeCounts);

  // Sufficiency flags — independent of ratchet (echoed for diagnostics/log).
  const sufficientT1 =
    n >= TIER_TRIGGERS.T1.minN &&
    observedDaysWithTrades >= TIER_TRIGGERS.T1.minDaysWithTrades &&
    observedMinClosedTrades >= TIER_TRIGGERS.T1.minClosedTrades;
  const sufficientT2 =
    n >= TIER_TRIGGERS.T2.minN &&
    observedDaysWithTrades >= TIER_TRIGGERS.T2.minDaysWithTrades &&
    observedMinClosedTrades >= TIER_TRIGGERS.T2.minClosedTrades;

  let tierActive: CellWeightsTier;
  let ratchetHeld = false;
  if (tier === 'auto') {
    tierActive = selectCellWeightsTier(n, observedDaysWithTrades, observedMinClosedTrades, priorActiveTier);
    const triggerSays: CellWeightsTier = sufficientT2 ? 'T2' : sufficientT1 ? 'T1' : 'T0';
    ratchetHeld =
      priorActiveTier !== null && TIER_ORDER[priorActiveTier] > TIER_ORDER[triggerSays];
  } else {
    tierActive = tier;
  }

  // SPEC §7 — forced-tier sanity throws.
  if ((tierActive === 'T1' || tierActive === 'T2') && n < 2) {
    throw new Error(
      `computeCellWeights: ${tierActive} requires N >= 2 cells (got ${n})`,
    );
  }
  if (tierActive !== 'T0' && seriesLen === 0) {
    throw new Error(
      `computeCellWeights: ${tierActive} requires non-empty dailyReturns series`,
    );
  }

  let weightsInAlpha: Map<string, number>;
  if (tierActive === 'T0') {
    // SPEC §6.1 — equal weight; no alphabetize needed.
    const w = 1 / n;
    weightsInAlpha = new Map();
    for (const k of cellKeys) weightsInAlpha.set(k, w);
  } else {
    // SPEC §6.3.1 — alphabetize INPUT for canonical math; permute back to
    // input order at the end.
    const alphaKeys = [...cellKeys].sort();
    if (tierActive === 'T1') {
      // SPEC §6.2 — .slice(-90), Bessel-corrected variance.
      const variances = new Map<string, number>();
      for (const k of alphaKeys) {
        const window = dailyReturns.get(k)!.slice(-ROLLING_WINDOW_DAYS_T1);
        const v = sampleVariance(window);
        if (v < VARIANCE_FLOOR) {
          throw new Error(
            `computeCellWeights: variance floor breach for cell "${k}" (σ²=${v} < ${VARIANCE_FLOOR})`,
          );
        }
        variances.set(k, v);
      }
      let invSum = 0;
      const invMap = new Map<string, number>();
      for (const k of alphaKeys) {
        const inv = 1 / variances.get(k)!;
        invMap.set(k, inv);
        invSum += inv;
      }
      weightsInAlpha = new Map();
      for (const k of alphaKeys) weightsInAlpha.set(k, invMap.get(k)! / invSum);
    } else {
      // T2 — HRP. Build T×N matrix in alphabetical column order.
      const fullSeries: number[][] = alphaKeys.map(k => [...dailyReturns.get(k)!]);
      const hrpWeights = computeHrpWeights(fullSeries);
      weightsInAlpha = new Map();
      for (let i = 0; i < alphaKeys.length; i++) {
        weightsInAlpha.set(alphaKeys[i], hrpWeights[i]);
      }
    }
  }

  // SPEC §5 invariant — Map iteration order matches `cellKeys` input order.
  const weights = new Map<string, number>();
  for (const k of cellKeys) weights.set(k, weightsInAlpha.get(k)!);

  return {
    tierActive,
    weights,
    observedDaysWithTrades,
    observedN: n,
    observedMinClosedTrades,
    computeWindowDays: seriesLen,
    sufficientForT1: sufficientT1,
    sufficientForT2: sufficientT2,
    ratchetHeld,
  };
}

// ---------------------------------------------------------------------------
// HRP — AFML Snippets 16.2 / 16.3 / 16.4. SPEC §6.3.
// ---------------------------------------------------------------------------

/**
 * HRP on a T×N matrix of daily returns (columns are cells in canonical
 * alphabetical order). Returns N weights in the same column order.
 *
 * Closed-form path: at N=2 HRP collapses to IVW (a sanity invariant pinned
 * by fixture `hrp_n2_collapses_to_ivw.json` and §6.3.1).
 *
 * Byte-pin reference: scripts/_compute_cell_weights_reference.py. Any
 * change to this function must be reconciled against the Python output
 * across all 5 fixtures (`scripts/tests/fixtures/cell_weights/*.json`).
 */
function computeHrpWeights(seriesByColumn: readonly (readonly number[])[]): number[] {
  const n = seriesByColumn.length;
  if (n < 2) {
    throw new Error(`computeHrpWeights: N >= 2 required, got ${n}`);
  }
  // Build the sample covariance matrix (Bessel-corrected, ddof=1).
  const cov = sampleCovariance(seriesByColumn);
  // Correlation matrix → distance via AFML d(i,j) = sqrt((1 - ρ)/2).
  const std: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    std[i] = Math.sqrt(cov[i][i]);
    if (std[i] < Math.sqrt(VARIANCE_FLOOR)) {
      throw new Error(
        `computeHrpWeights: variance floor breach at column ${i} (σ=${std[i]})`,
      );
    }
  }
  const corr: number[][] = matrix(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Clamp tiny numerical drift outside [-1, 1].
      let c = cov[i][j] / (std[i] * std[j]);
      if (c < -1) c = -1;
      if (c > 1) c = 1;
      corr[i][j] = c;
    }
  }
  const dist: number[][] = matrix(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const diff = Math.max(0, 1 - corr[i][j]);
      dist[i][j] = Math.sqrt(diff / 2);
    }
    dist[i][i] = 0;
  }

  // Single-linkage agglomerative clustering — produces (N-1) merge rows.
  const link = singleLinkage(dist);
  // Quasi-diagonalization — leaf order via tree-walk (AFML Snippet 16.3).
  const sortIx = getQuasiDiag(link, n);
  // Recursive bisection (AFML Snippet 16.4) — produces weights keyed by
  // ORIGINAL column index (NOT by leaf-order).
  return getRecBipart(cov, sortIx);
}

interface LinkageRow {
  /** Cluster id of the first child (< n_items = original leaf; >= n_items = composite). */
  a: number;
  /** Cluster id of the second child. */
  b: number;
  /** Distance between a and b at the merge moment. */
  dist: number;
  /** Number of leaves in this cluster. */
  size: number;
}

/**
 * Scipy-equivalent `linkage(method='single')` for a (N, N) distance matrix.
 *
 * The output is a list of (N-1) merge events; the i-th merge creates a new
 * cluster with id `n + i`. Tie-breaking matches scipy's
 * SLINK / generic agglomerative behavior: at each step, find the smallest
 * pairwise distance; ties resolve by the smaller (i, j) tuple (lexicographic
 * on cluster ids — preserving the row order of the input distance matrix).
 * This is deterministic on the alphabetized input.
 */
function singleLinkage(dist: number[][]): LinkageRow[] {
  const n = dist.length;
  // Active cluster ids. Initially each leaf is its own cluster {0, ..., n-1}.
  let active: number[] = [];
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    active.push(i);
    sizes.set(i, 1);
  }
  // Pairwise distances keyed by cluster-id pair (smaller id first).
  // Initially every pairwise dist is just the input cell.
  const pairDist = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairDist.set(pairKey(i, j), dist[i][j]);
    }
  }

  const out: LinkageRow[] = [];
  for (let step = 0; step < n - 1; step++) {
    // Find smallest active pair; tie-break by lexicographic (a, b).
    let bestA = -1;
    let bestB = -1;
    let bestD = Infinity;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const d = pairDist.get(pairKey(a, b))!;
        if (
          d < bestD ||
          (d === bestD && (a < bestA || (a === bestA && b < bestB)))
        ) {
          bestA = a;
          bestB = b;
          bestD = d;
        }
      }
    }
    // Always store (smaller, larger) at the row level for stability.
    const lo = Math.min(bestA, bestB);
    const hi = Math.max(bestA, bestB);
    const newId = n + step;
    const newSize = sizes.get(lo)! + sizes.get(hi)!;
    out.push({ a: lo, b: hi, dist: bestD, size: newSize });

    // SINGLE linkage update: d(newCluster, other) = min(d(lo, other), d(hi, other)).
    const survivors = active.filter(x => x !== lo && x !== hi);
    for (const x of survivors) {
      const dA = pairDist.get(pairKey(lo, x))!;
      const dB = pairDist.get(pairKey(hi, x))!;
      pairDist.set(pairKey(newId, x), Math.min(dA, dB));
    }
    // Drop stale entries (memory hygiene; correctness unaffected).
    for (const x of survivors) {
      pairDist.delete(pairKey(lo, x));
      pairDist.delete(pairKey(hi, x));
    }
    pairDist.delete(pairKey(lo, hi));
    sizes.set(newId, newSize);
    sizes.delete(lo);
    sizes.delete(hi);
    active = [...survivors, newId];
  }
  return out;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * AFML Snippet 16.3 — derive the leaf-order permutation from the linkage
 * matrix. Returns the order of ORIGINAL leaf indices (0..n-1).
 */
function getQuasiDiag(link: LinkageRow[], nLeaves: number): number[] {
  const last = link[link.length - 1];
  let sortIx: number[] = [last.a, last.b];
  // Iteratively expand composite cluster ids back to leaves.
  for (;;) {
    if (sortIx.every(x => x < nLeaves)) break;
    const next: number[] = [];
    for (const id of sortIx) {
      if (id < nLeaves) {
        next.push(id);
      } else {
        const row = link[id - nLeaves];
        next.push(row.a);
        next.push(row.b);
      }
    }
    sortIx = next;
  }
  return sortIx;
}

/**
 * AFML Snippet 16.4 — recursive bisection. Walks the quasi-diagonal leaf
 * order top-down; at each split into subclusters L and R, computes within-
 * subcluster IVP variances, allocates `α_L = 1 - σ²(L)/(σ²(L)+σ²(R))`, and
 * propagates α multiplicatively to all leaves in L (resp. 1-α for R).
 *
 * Output is keyed by ORIGINAL column index (i.e. weights[i] is the weight
 * for the i-th column of the input covariance matrix), NOT by leaf-order.
 */
function getRecBipart(cov: number[][], sortIx: number[]): number[] {
  const n = cov.length;
  const w: number[] = new Array(n).fill(1);
  let clusters: number[][] = [sortIx.slice()];
  while (clusters.length > 0) {
    const next: number[][] = [];
    for (const cluster of clusters) {
      if (cluster.length <= 1) continue;
      const mid = Math.floor(cluster.length / 2);
      const left = cluster.slice(0, mid);
      const right = cluster.slice(mid);
      const varL = clusterIvpVariance(cov, left);
      const varR = clusterIvpVariance(cov, right);
      const alpha = 1 - varL / (varL + varR);
      for (const idx of left) w[idx] *= alpha;
      for (const idx of right) w[idx] *= 1 - alpha;
      next.push(left);
      next.push(right);
    }
    clusters = next;
  }
  return w;
}

/** AFML Snippet 16.2 — within-cluster variance under inverse-variance weights. */
function clusterIvpVariance(cov: number[][], items: number[]): number {
  const k = items.length;
  const sub: number[][] = matrix(k, k);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      sub[i][j] = cov[items[i]][items[j]];
    }
  }
  // IVP weights on the sub-covariance: w_i ∝ 1/diag_i.
  let invSum = 0;
  const ivp = new Array<number>(k);
  for (let i = 0; i < k; i++) {
    const inv = 1 / sub[i][i];
    ivp[i] = inv;
    invSum += inv;
  }
  for (let i = 0; i < k; i++) ivp[i] /= invSum;
  // Return w' Σ w.
  let v = 0;
  for (let i = 0; i < k; i++) {
    let row = 0;
    for (let j = 0; j < k; j++) row += sub[i][j] * ivp[j];
    v += ivp[i] * row;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Math utilities.
// ---------------------------------------------------------------------------

function sampleVariance(series: readonly number[]): number {
  // Bessel-corrected (ddof=1). Matches numpy `var(ddof=1)` and scipy default.
  const n = series.length;
  if (n < 2) {
    throw new Error(`sampleVariance: ddof=1 requires N >= 2 (got ${n})`);
  }
  let sum = 0;
  for (const x of series) sum += x;
  const mean = sum / n;
  let sse = 0;
  for (const x of series) {
    const d = x - mean;
    sse += d * d;
  }
  return sse / (n - 1);
}

function sampleCovariance(seriesByColumn: readonly (readonly number[])[]): number[][] {
  const n = seriesByColumn.length;
  const t = seriesByColumn[0].length;
  if (t < 2) {
    throw new Error(`sampleCovariance: ddof=1 requires T >= 2 (got T=${t})`);
  }
  for (const s of seriesByColumn) {
    if (s.length !== t) {
      throw new Error(`sampleCovariance: column lengths disagree (expected ${t})`);
    }
  }
  // Column means.
  const means: number[] = new Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    let acc = 0;
    for (let i = 0; i < t; i++) acc += seriesByColumn[j][i];
    means[j] = acc / t;
  }
  // Covariance Σ_jk = (1/(t-1)) Σ_i (X_ij - mean_j)(X_ik - mean_k).
  const cov: number[][] = matrix(n, n);
  for (let j = 0; j < n; j++) {
    for (let k = j; k < n; k++) {
      let acc = 0;
      for (let i = 0; i < t; i++) {
        acc += (seriesByColumn[j][i] - means[j]) * (seriesByColumn[k][i] - means[k]);
      }
      const c = acc / (t - 1);
      cov[j][k] = c;
      cov[k][j] = c;
    }
  }
  return cov;
}

function matrix(rows: number, cols: number): number[][] {
  const m: number[][] = new Array(rows);
  for (let i = 0; i < rows; i++) m[i] = new Array(cols).fill(0);
  return m;
}

function minAcrossCells(cellKeys: readonly string[], m: ReadonlyMap<string, number>): number {
  let v = Infinity;
  for (const k of cellKeys) {
    const x = m.get(k)!;
    if (x < v) v = x;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Log-line formatter — SPEC §9.5 (byte-pinned).
// ---------------------------------------------------------------------------

export interface FormatCellWeightsLogLineInputs {
  tierActive: CellWeightsTier;
  /** Per-cell weights in cellKeys-input order; rendered as `key:w.toFixed(3)` comma-separated. */
  weights: ReadonlyMap<string, number>;
  observedDaysWithTrades: number;
  observedMinClosedTrades: number;
  ratchetHeld: boolean;
  /** When true, append `  (DEGRADED: CH unavailable)`. SPEC §9.6. */
  degraded?: boolean;
}

/**
 * SPEC §9.5 — byte-pinned operator log line. Six fields, fixed order:
 *   [cell-weights] tier=T1 cells=2 weights=k1:0.667,k2:0.333 obsDaysWithTrades=92 minClosedTrades=42 ratchetHeld=no
 *
 * DEGRADED suffix per §9.6: `  (DEGRADED: CH unavailable)` (two spaces).
 * Tests assert against a verbatim string (NOT a regex) — drift surfaces
 * as a test failure rather than silent operator confusion.
 */
export function formatCellWeightsLogLine(inputs: FormatCellWeightsLogLineInputs): string {
  const cells = inputs.weights.size;
  const weightFields: string[] = [];
  for (const [k, v] of inputs.weights) {
    weightFields.push(`${k}:${v.toFixed(3)}`);
  }
  const base =
    `[cell-weights] tier=${inputs.tierActive} cells=${cells} ` +
    `weights=${weightFields.join(',')} ` +
    `obsDaysWithTrades=${inputs.observedDaysWithTrades} ` +
    `minClosedTrades=${inputs.observedMinClosedTrades} ` +
    `ratchetHeld=${inputs.ratchetHeld ? 'yes' : 'no'}`;
  return inputs.degraded ? `${base}  (DEGRADED: CH unavailable)` : base;
}

/**
 * What could break this:
 *  - scipy single-linkage tie-break diverges from our `singleLinkage`'s
 *    lexicographic-on-cluster-id ordering for SOME pathological input
 *    (e.g. exact ties at the first merge). The §6.3.1 alphabetize-input
 *    canonicalization narrows the divergence window but does not
 *    eliminate it. Fixtures `hrp_n4_uncorrelated.json` and
 *    `hrp_n4_non_alphabetical_input.json` use random Gaussian data
 *    (no exact ties) — both must stay byte-agreed with the Python
 *    reference; any drift surfaces as a test failure.
 *  - Future contributor "cleans up" by removing the alphabetize step in
 *    the T2 path. Test T2-3 (non-alphabetical fixture) + the §5 Map-
 *    iteration-order invariant catch this — both assertions are load-
 *    bearing per SPEC §6.3.1.
 *  - Variance floor `1e-12` is calibrated for zero-fill on hours-to-days-
 *    hold strategies. Slower-trading regimes (multi-week holds with mostly
 *    zero-fill days) could approach this floor; the helper throws to signal
 *    the data is too sparse for variance estimation. If this fires
 *    in production, the operator's correct response is to (i) confirm the
 *    cell's trading frequency, (ii) consider widening the rolling window,
 *    (iii) NOT lower the floor — a near-zero variance estimate is
 *    statistically meaningless.
 *  - The §9.5 log-line format is byte-pinned. A change here (field rename,
 *    separator drift, weight format `toFixed(3)` precision change) requires
 *    updating `cellWeights.test.ts` LOG-1..LOG-4 fixtures in lockstep.
 *  - HRP weights are sensitive to the per-cell zero-fill convention from
 *    `getCellDailyReturns`. SPEC §15 documents the data-dependent bias
 *    direction (zero-fill DEFLATES sparse-cell variance; lumpy-realization
 *    INFLATES it). A future "smarter" upstream fill (e.g. forward-fill)
 *    would change weights without changing this module's math — the SPEC
 *    §8.4 zero-fill rationale + §15 watch-out are the canonical reference
 *    for why zero-fill is the convention.
 */
