/**
 * Multiple-testing corrections for cross-strategy / cross-cell t-stats.
 *
 * Source: Harvey, Liu & Zhu (2016), "...and the Cross-Section of Expected Returns",
 * §3-§4. Three procedures, increasing in stringency-when-applicable:
 *
 *   - Bonferroni (1936): assumes independent tests; most conservative.
 *   - Holm (1979) step-down: ordered Bonferroni; uniformly less conservative than BF.
 *   - Benjamini-Yekutieli (2001) (BHY): controls FDR under arbitrary dependence between
 *     tests. Recommended by HLZ §4.2 for finance because asset returns / strategy returns
 *     are correlated, which violates BF/Holm independence. AFML §12 also defaults to BHY.
 *
 * Use case: when ranking M cells (strategy × tier × interval) by their PSR-derived
 * t-statistic, pass each cell's (observedT, rank) and you get back whether it clears the
 * cumulative-FDR threshold for being "promotable" rather than just "in-sample lucky."
 */

import { invNormCDF } from './psr.js';

export type HaircutMethod = 'bonferroni' | 'holm' | 'bhy';

export interface HaircutInput {
  /** Cell's observed t-statistic. */
  observedT: number;
  /** 1-indexed rank of this cell among all M cells, sorted by t descending (1 = most significant). */
  rank: number;
  /** Total number of cells / hypotheses in the family. */
  nTests: number;
  /** Default 'bhy' — BHY allows arbitrary cross-test dependence. */
  method?: HaircutMethod;
  /** Default 0.05. */
  alpha?: number;
  /** Default true (matches HLZ Table 6). Use false when the test is one-sided. */
  twoSided?: boolean;
}

export interface HaircutResult {
  /** Whether observedT clears the threshold for this rank. */
  passes: boolean;
  /** The critical t-stat this cell needed to clear. */
  threshold: number;
}

/** Harmonic number H_M = Σ_{i=1..M} 1/i — used by BHY. */
function harmonicNumber(M: number): number {
  let h = 0;
  for (let i = 1; i <= M; i++) h += 1 / i;
  return h;
}

/**
 * Compute the critical t-stat threshold and check whether observedT clears it.
 *
 * BHY at rank k:    p_threshold(k) = k·α / (M · H_M)
 * Holm at rank k:   p_threshold(k) =     α / (M − k + 1)
 * Bonferroni:       p_threshold    =     α / M                    (rank-independent)
 *
 * Two-sided thresholds use Φ⁻¹(1 − p/2); one-sided use Φ⁻¹(1 − p). Default is two-sided
 * to match the published HLZ Table 6 values; flip to one-sided for "is this strategy
 * better than benchmark" tests where negative-Sharpe outcomes are not of interest.
 */
export function hlzHaircut(input: HaircutInput): HaircutResult {
  const {
    observedT,
    rank,
    nTests: M,
    method = 'bhy',
    alpha = 0.05,
    twoSided = true,
  } = input;

  if (M < 1 || rank < 1 || rank > M) {
    return { passes: false, threshold: Infinity };
  }

  let pThreshold: number;
  switch (method) {
    case 'bonferroni':
      pThreshold = alpha / M;
      break;
    case 'holm':
      pThreshold = alpha / (M - rank + 1);
      break;
    case 'bhy':
      pThreshold = (rank * alpha) / (M * harmonicNumber(M));
      break;
  }

  // Convert one-sided p-threshold to two-sided when caller asked for two-sided.
  const tailP = twoSided ? pThreshold / 2 : pThreshold;
  const threshold = invNormCDF(1 - tailP);
  return { passes: observedT >= threshold, threshold };
}

/**
 * Apply the haircut across an entire ranked leaderboard in one pass.
 * Sorts internally by descending t; returns each cell with its assigned rank, threshold,
 * and pass flag. Stable for ties in observedT.
 */
export interface HaircutLeaderboardInput {
  cells: { id: string; observedT: number }[];
  method?: HaircutMethod;
  alpha?: number;
  twoSided?: boolean;
}

export interface HaircutLeaderboardEntry {
  id: string;
  rank: number;
  observedT: number;
  threshold: number;
  passes: boolean;
}

export function applyLeaderboardHaircut(
  input: HaircutLeaderboardInput,
): HaircutLeaderboardEntry[] {
  const { cells, method = 'bhy', alpha = 0.05, twoSided = true } = input;
  const sorted = [...cells]
    .map((c, originalIdx) => ({ ...c, originalIdx }))
    .sort((a, b) => {
      if (b.observedT !== a.observedT) return b.observedT - a.observedT;
      return a.originalIdx - b.originalIdx;
    });
  const M = sorted.length;
  return sorted.map((cell, i) => {
    const rank = i + 1;
    const { passes, threshold } = hlzHaircut({
      observedT: cell.observedT,
      rank,
      nTests: M,
      method,
      alpha,
      twoSided,
    });
    return { id: cell.id, rank, observedT: cell.observedT, threshold, passes };
  });
}

/*
 * What could break this:
 * - BHY assumes "arbitrary dependence" but our cells overlap heavily (same tokens, same
 *   time windows, related strategy families). The procedure is conservative under positive
 *   dependence, so we lose some power but don't get false discoveries — acceptable.
 * - The harmonic number factor H_M grows like log(M), so for very large M (>10k) BHY
 *   becomes nearly as strict as Bonferroni. We're at M~50, well inside the regime where
 *   BHY's flexibility matters.
 * - twoSided=true matches HLZ Table 6 reporting; for our trading use ("is this strategy
 *   better than zero benchmark?") the natural choice is one-sided, which lowers thresholds
 *   by ~0.2-0.3 t-points. Keep one default and document — see score_strategies integration.
 * - At extremely small p-thresholds (large M, small rank), invNormCDF approaches its
 *   accuracy limit (~1e-9). For p < 1e-12 the threshold is reported as ~7.0 plus or minus
 *   a few percent — fine for a binary gate but don't read decimals off it as significant.
 */
