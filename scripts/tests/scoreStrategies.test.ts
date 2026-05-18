/**
 * Score-strategies tests — pin the validator's correctness invariants.
 *
 * Three structural fixes are pinned here:
 *   1. Pardo §3.4 IS-only param selection (the ranker doesn't peek at OOS).
 *   2. Leaderboard's print-side OOS clamp (raw OOS surfaces even for losing-IS cells).
 *   3. AFML §11.7 PSR-based ranker (selection criterion is consistent with the gate
 *      criterion — no fat-tail / jackpot net-% bias in selection).
 *
 * All three are the kind of bug that silently corrupts the entire scoring run.
 * Synthetic RunRow inputs let us assert on the exact numeric semantics without
 * running a real backtest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCell, type RunRow, type SliceRow } from '../score_strategies.js';

/**
 * Build a minimal RunRow. Defaults are chosen so the row passes the scoreCell
 * gates (`r.trades > 0`) without setting fields that aren't relevant to the
 * test. Tests override only the fields they care about.
 */
function makeRow(overrides: Partial<RunRow>): RunRow {
  return {
    strategy_type: 'momentum_v1',
    tier: 'mcap_nano',
    interval: '1h',
    token_address: 'TOKEN_A',
    symbol: 'AAA',
    param: 10,
    run_id: '00000000-0000-0000-0000-000000000000',
    net_profit_pct: 0,
    profit_factor: 1,
    win_rate: 50,
    trades: 100,
    sharpe_ratio: 0,
    gross_profit: 100,
    gross_loss: 100,
    oos_net_profit_pct: 0,
    oos_profit_factor: 1,
    oos_trades: 30,
    oos_sharpe_ratio: 0,
    split_pct: 70,
    data_span_days: 90,
    skewness: 0,
    kurtosis: 3,
    n_slices: 0,
    ...overrides,
  };
}

/**
 * A two-param universe across N tokens where param A has stronger IS performance
 * (higher Sharpe AND higher net %) but collapses in OOS. Param B is weaker IS but
 * holds up in OOS. The pre-fix scorer would pick B (OOS-aware ranker). The fixed
 * scorer picks A — selection is IS-only, so OOS doesn't influence the choice.
 *
 * Sharpe values are set explicitly so the assertion passes for the right reason
 * under the PSR-based ranker (a `sharpe_ratio: 0` default would tie the two
 * params on PSR and the choice would fall through to iteration order — fragile).
 */
function buildTwoParamFixture(nTokens: number, paramA: number, paramB: number): RunRow[] {
  const rows: RunRow[] = [];
  for (let i = 0; i < nTokens; i++) {
    const tok = `TOKEN_${i}`;
    rows.push(makeRow({
      token_address: tok, symbol: `T${i}`, param: paramA,
      net_profit_pct: 30,        // A: high IS
      oos_net_profit_pct: -10,   // A: collapses in OOS
      sharpe_ratio: 1.0,         // A: higher tier Sharpe → higher PSR
      trades: 100, oos_trades: 30,
    }));
    rows.push(makeRow({
      token_address: tok, symbol: `T${i}`, param: paramB,
      net_profit_pct: 10,        // B: lower IS
      oos_net_profit_pct: 5,     // B: holds up in OOS
      sharpe_ratio: 0.3,         // B: lower tier Sharpe
      trades: 100, oos_trades: 30,
    }));
  }
  return rows;
}

describe('scoreCell — Pardo §3.4 IS-only param selection', () => {
  it('picks the IS-stronger param even when a different param has higher OOS', () => {
    const rows = buildTwoParamFixture(8, 10, 20);
    const slices = new Map<string, SliceRow[]>();
    const score = scoreCell(rows, slices);
    assert.ok(score, 'scoreCell returned null on a valid fixture');
    assert.equal(score!.best_param, 10, 'expected IS-best param 10, got ' + score!.best_param);
  });

  it('oos_is_ratio reflects the IS-selected param\'s OOS, not the OOS-best param\'s OOS', () => {
    // Same fixture: param 10 has IS=+30%, OOS=-10% → ratio = -10/30 = -0.333…
    // (pre-fix: would have picked param 20 → ratio = +5/+10 = +0.5, which is the
    // contaminated number — high-looking only because we let OOS pre-screen.)
    const rows = buildTwoParamFixture(8, 10, 20);
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.best_param, 10);
    // ratio ≈ -10 / 30 = -1/3
    assert.ok(score.oos_is_ratio < 0, `expected negative ratio for collapsed OOS, got ${score.oos_is_ratio}`);
    assert.ok(Math.abs(score.oos_is_ratio - (-10 / 30)) < 1e-6,
      `expected ratio ≈ ${-10 / 30}, got ${score.oos_is_ratio}`);
  });

  it('oos_wt_net_pct carries the IS-selected param\'s OOS net %', () => {
    const rows = buildTwoParamFixture(8, 10, 20);
    const score = scoreCell(rows, new Map())!;
    // Param 10 OOS: -10% per token, 30 trades each. Trade-weighted = -10.
    assert.ok(Math.abs(score.oos_wt_net_pct - (-10)) < 1e-6,
      `expected oos_wt_net_pct ≈ -10, got ${score.oos_wt_net_pct}`);
  });
});

describe('scoreCell — leaderboard display fix (oos_wt_net_pct surfaces for losing-IS cells)', () => {
  it('records the actual OOS net % even when IS is negative', () => {
    // Single-param cell, every token has negative IS but partial OOS data.
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(makeRow({
        token_address: `TOKEN_${i}`, symbol: `T${i}`, param: 14,
        net_profit_pct: -25,         // negative IS — pre-fix this zeroed the displayed OOS
        oos_net_profit_pct: -8,      // OOS still exists in bt_runs
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.ok(score.wt_net_pct < 0, 'fixture should produce negative IS');
    // Pre-fix, the leaderboard would render +0.0%. Now we expose the real OOS.
    assert.ok(Math.abs(score.oos_wt_net_pct - (-8)) < 1e-6,
      `expected oos_wt_net_pct ≈ -8 even with negative IS, got ${score.oos_wt_net_pct}`);
    // oos_is_ratio remains 0 in the negative-IS case (Pardo: WFE undefined when there's
    // no IS edge to test for survival) — that's intended, the gate should auto-fail.
    assert.equal(score.oos_is_ratio, 0,
      'oos_is_ratio should stay 0 when IS is non-positive (gate semantics preserved)');
  });
});

describe('scoreCell — oos_is_status reason codes (Issue 1 fix, conversation 2026-05-03)', () => {
  // The numeric oos_is_ratio collapses three distinct fail-reasons to 0. The status
  // column distinguishes them so downstream diagnostics don't conflate "no IS edge"
  // (which the prior diagnostic mislabeled as "OOS/IS unscorable") with genuine cases
  // where data is missing.

  it('emits "fail_no_is_edge" when wt_net_pct <= 0 (no edge to test for retention)', () => {
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(makeRow({
        token_address: `TOKEN_${i}`, symbol: `T${i}`, param: 14,
        net_profit_pct: -10,           // negative IS
        oos_net_profit_pct: -3,
        sharpe_ratio: -0.5, kurtosis: 3, skewness: 0,
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.ok(score.wt_net_pct <= 0, 'fixture should produce non-positive IS');
    assert.equal(score.oos_is_status, 'fail_no_is_edge');
    assert.equal(score.oos_is_ratio, 0, 'numeric ratio still 0 (verdict logic preserved)');
  });

  it('emits "fail_oos_negative" when wt_net_pct > 0 but OOS lost money', () => {
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(makeRow({
        token_address: `TOKEN_${i}`, symbol: `T${i}`, param: 14,
        net_profit_pct: 12,            // positive IS
        oos_net_profit_pct: -7,        // OOS lost money
        sharpe_ratio: 0.6, kurtosis: 3, skewness: 0,
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.ok(score.wt_net_pct > 0);
    assert.ok(score.oos_wt_net_pct < 0);
    assert.equal(score.oos_is_status, 'fail_oos_negative');
    // ratio is negative; oosNorm clamps to 0.
    assert.ok(score.oos_is_ratio < 0, 'ratio is negative when OOS lost');
    assert.equal(score.oos_norm, 0, 'oosNorm clamps negative ratio to 0');
  });

  it('emits "fail" when 0 < ratio < OOS_IS_RATIO_MIN (IS edge collapsed but OOS still positive)', () => {
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(makeRow({
        token_address: `TOKEN_${i}`, symbol: `T${i}`, param: 14,
        net_profit_pct: 30,            // strong IS
        oos_net_profit_pct: 3,         // weak positive OOS — ratio = 3/30 = 0.1, below 0.3 gate
        sharpe_ratio: 1.0, kurtosis: 3, skewness: 0,
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.ok(score.oos_is_ratio > 0 && score.oos_is_ratio < 0.3,
      `expected 0 < ratio < 0.3, got ${score.oos_is_ratio}`);
    assert.equal(score.oos_is_status, 'fail');
  });

  it('emits "pass" when ratio >= OOS_IS_RATIO_MIN (Pardo retention bar cleared)', () => {
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(makeRow({
        token_address: `TOKEN_${i}`, symbol: `T${i}`, param: 14,
        net_profit_pct: 10,
        oos_net_profit_pct: 5,         // ratio = 0.5, above 0.3 gate
        sharpe_ratio: 0.8, kurtosis: 3, skewness: 0,
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.ok(score.oos_is_ratio >= 0.3);
    assert.equal(score.oos_is_status, 'pass');
  });

  it('status is exactly one of the four enum values (lint guard)', () => {
    const score = scoreCell(buildTwoParamFixture(8, 10, 20), new Map())!;
    assert.ok(['pass', 'fail', 'fail_oos_negative', 'fail_no_is_edge'].includes(score.oos_is_status),
      `unexpected status value: ${score.oos_is_status}`);
  });
});

describe('scoreCell — guard: tokens-below-min returns null', () => {
  it('returns null when there are fewer than MIN_TOKENS distinct tokens', () => {
    // Default MIN_TOKENS is 5. Two tokens should not produce a row.
    const rows: RunRow[] = [
      makeRow({ token_address: 'A', symbol: 'A', param: 10, net_profit_pct: 5 }),
      makeRow({ token_address: 'B', symbol: 'B', param: 10, net_profit_pct: 5 }),
    ];
    const score = scoreCell(rows, new Map());
    assert.equal(score, null);
  });
});

describe('scoreCell — AFML §11.7 PSR-based param ranker', () => {
  /**
   * Build an N-token cell with two params:
   *   A — fat-right-tail jackpot pattern: most tokens have negative Sharpe + small
   *       negative net %, but two tokens have huge positive net % (jackpots) so the
   *       trade-weighted IS net % is large. Median per-token Sharpe is negative.
   *   B — broad-edge pattern: every token has the same modest positive Sharpe and
   *       net %, no fat tail. Median per-token Sharpe is positive.
   * Pre-fix (IS-net-% ranker): would pick A (jackpot inflates wt_net_pct).
   * Post-fix (PSR ranker): picks B (median Sharpe positive, no γ₄ penalty).
   */
  function buildFatTailVsBroadEdgeFixture(nTokens: number, paramA: number, paramB: number): RunRow[] {
    const rows: RunRow[] = [];
    for (let i = 0; i < nTokens; i++) {
      const tok = `TOKEN_${i}`;
      const isJackpot = i < 2;  // first 2 tokens are A's jackpots
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: paramA,
        net_profit_pct: isJackpot ? 5000 : -10,
        sharpe_ratio: isJackpot ? +5.0 : -0.4,    // median ≈ -0.4 (jackpots are minority)
        kurtosis: 25,                              // heavy γ₄ → PSR penalty
        skewness: 3,
        trades: 100, oos_trades: 30,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: paramB,
        net_profit_pct: 8,
        sharpe_ratio: 0.5,                         // median = +0.5 (uniform)
        kurtosis: 3,                               // Gaussian — no PSR penalty
        skewness: 0,
        trades: 100, oos_trades: 30,
      }));
    }
    return rows;
  }

  it('prefers a broad-edge param over a higher-net-% fat-tail param', () => {
    const rows = buildFatTailVsBroadEdgeFixture(8, 10, 20);
    const score = scoreCell(rows, new Map())!;
    // Param 10 (A) has wt_net_pct ≈ +1240% (driven by 2 jackpots over 8 tokens).
    // Param 20 (B) has wt_net_pct = +8% — much lower. Pre-fix would pick A.
    // PSR ranker should pick B because median Sharpe = +0.5 vs A's -0.4, and
    // A's γ₄ = 25 inflates σ_SR further.
    assert.equal(score.best_param, 20,
      `PSR ranker should pick the broad-edge param 20, got ${score.best_param}`);
  });

  it('prefers higher-T over lower-T at equal Sharpe', () => {
    // Both params: 8 tokens, identical median Sharpe = +0.5, identical moments.
    // Param 10 has 200 trades/token (T=1600), param 20 has 50 trades/token (T=400).
    // PSR's √(T-1) factor gives the higher-T param more standard errors above 0.
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      const tok = `TOKEN_${i}`;
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 10,
        net_profit_pct: 12, sharpe_ratio: 0.5,
        trades: 200, oos_trades: 60,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 20,
        net_profit_pct: 12, sharpe_ratio: 0.5,
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.best_param, 10,
      `PSR ranker should prefer the higher-T param at equal Sharpe, got ${score.best_param}`);
  });

  it('all-negative Sharpe: picks the least-negative param, gates_pass remains 0', () => {
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      const tok = `TOKEN_${i}`;
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 10,
        net_profit_pct: -25, sharpe_ratio: -0.4,
        trades: 100, oos_trades: 30,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 20,
        net_profit_pct: -10, sharpe_ratio: -0.1,
        trades: 100, oos_trades: 30,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.best_param, 20,
      `expected least-negative param 20 to win, got ${score.best_param}`);
    // The gate must still fail — picking least-bad isn't declaring victory.
    assert.equal(score.gates_pass, 0,
      'all-negative Sharpe cell must not pass the gate');
    // Sanity: DSR < 0.95 (almost certainly 0 here, but pin the inequality).
    assert.ok(score.dsr < 0.95, `expected dsr < 0.95 for negative-Sharpe cell, got ${score.dsr}`);
  });

  it('fat-tail penalty: prefers γ₄=3 over γ₄=20 at equal Sharpe', () => {
    // Same Sharpe, same T, same skewness — only γ₄ differs. The Mertens variance
    // correction `(γ₄ − 1)/4 · SR̂²` inflates σ_SR for the heavy-tail param,
    // dragging its PSR down.
    const rows: RunRow[] = [];
    for (let i = 0; i < 8; i++) {
      const tok = `TOKEN_${i}`;
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 10,
        net_profit_pct: 15, sharpe_ratio: 0.4,
        skewness: 0, kurtosis: 3,         // Gaussian
        trades: 100, oos_trades: 30,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 20,
        net_profit_pct: 15, sharpe_ratio: 0.4,
        skewness: 0, kurtosis: 20,        // memecoin-style heavy tail
        trades: 100, oos_trades: 30,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.best_param, 10,
      `PSR ranker should prefer γ₄=3 over γ₄=20, got ${score.best_param}`);
  });
});

describe('scoreCell — ADR-015 K_dsr<2 honesty (PSR-equivalence per Bailey-LdP §3)', () => {
  it('K_dsr=1: only one param qualifies (trades >= 10) — dsr_status="untestable_few_trials", k_dsr_effective=1, n_param_trials=3, dsr=psr', () => {
    // 6 tokens × 3 params. Only param=5 fires trades >= 10 on any token; params 10
    // and 15 register in `params` (so n_param_trials=3) but produce no entries in
    // `tierSharpePerParam` (so K_dsr_effective=1). Reproduces the
    // `mean_reversion_v1 / cluster 0 / 1d` real-data pattern named in ADR-015.
    const rows: RunRow[] = [];
    for (let i = 0; i < 6; i++) {
      const tok = `TOKEN_${i}`;
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 5,
        net_profit_pct: 12, sharpe_ratio: 0.4,
        trades: 100, oos_trades: 30, oos_net_profit_pct: 8,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 10,
        net_profit_pct: 0, sharpe_ratio: 0,
        // trades < 10 → filtered out of `tierSharpePerParam` (the gate's per-param Sharpe map)
        trades: 5, oos_trades: 0, oos_net_profit_pct: 0,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 15,
        net_profit_pct: 0, sharpe_ratio: 0,
        trades: 3, oos_trades: 0, oos_net_profit_pct: 0,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.k_dsr_effective, 1,
      `K_dsr_effective should be 1 (only param=5 has tokens at trades>=10), got ${score.k_dsr_effective}`);
    assert.equal(score.n_param_trials, 3,
      `n_param_trials should be 3 (params iterated), got ${score.n_param_trials}`);
    assert.equal(score.dsr_status, 'untestable_few_trials',
      `dsr_status should be 'untestable_few_trials' at K_dsr=1, got '${score.dsr_status}'`);
    // Bailey-LdP §3 reduction: DSR(K=1) = PSR(0). Numerically identical (no rounding,
    // both come from the same probabilisticSharpeRatio call with benchmark=0).
    assert.equal(score.dsr, score.psr,
      `dsr should equal psr at K_dsr=1 (Bailey-LdP §3); got dsr=${score.dsr}, psr=${score.psr}`);
    assert.equal(score.best_param, 5);

    // ADR-015 gate-flip precondition: in the K_dsr=1 regime with a real edge
    // (this fixture's per-token Sharpe=0.4 / T=600 → PSR saturates), `s.dsr > 0.95`
    // (the leaderboard gate at score_strategies.ts:755 / score_strategies_by_cluster.ts:463)
    // is now TRUE where it was previously FALSE under the N<2 guard. This is the
    // user-facing behavior change the ADR §Consequences flags. Regression-pin the
    // precondition so any future tightening of the gate (e.g. requiring
    // dsr_status='ok') is a deliberate breakage rather than silent drift.
    assert.ok(score.dsr > 0.95,
      `K_dsr=1 + strong PSR cell must clear the dsr>0.95 gate threshold post-ADR-015; got dsr=${score.dsr}`);
  });

  it('σ_trials=0: multi-param but all trial Sharpes equal — dsr_status="untestable_zero_variance", dsr=psr', () => {
    // 6 tokens × 3 params. Every (token, param) row has identical Sharpe and trades
    // ≥ 10, so `tierSharpePerParam` has 3 entries all equal → variance=0 → noise floor
    // identically zero → DSR's deflation term vanishes per the math primitive's docstring
    // at psr.ts:172. ADR-015 redirects `dsr` to `psr` and labels the regime explicitly
    // rather than letting the consumer read the variance=0 guard's `0` as an edge verdict.
    const rows: RunRow[] = [];
    for (let i = 0; i < 6; i++) {
      const tok = `TOKEN_${i}`;
      for (const p of [5, 10, 15]) {
        rows.push(makeRow({
          token_address: tok, symbol: `T${i}`, param: p,
          net_profit_pct: 10, sharpe_ratio: 0.3,
          trades: 100, oos_trades: 30, oos_net_profit_pct: 5,
        }));
      }
    }
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.k_dsr_effective, 3,
      `K_dsr_effective should be 3 (all three params qualify), got ${score.k_dsr_effective}`);
    assert.equal(score.dsr_status, 'untestable_zero_variance',
      `dsr_status should be 'untestable_zero_variance' when all trial Sharpes equal, got '${score.dsr_status}'`);
    assert.equal(score.dsr, score.psr,
      `dsr should equal psr when σ_trials=0 (no noise floor to deflate); got dsr=${score.dsr}, psr=${score.psr}`);
  });

  it('K_dsr>=2 and σ_trials>0: dsr_status="ok", dsr < psr (real deflation applies)', () => {
    // 6 tokens × 3 params with a real spread in per-param Sharpe. K_dsr_effective=3,
    // var(trialSharpes)>0, so the math primitive runs and DSR is genuinely below PSR.
    // Sharpes kept low (0.05–0.15) and trades low (12/row → T=72 for bestParam) to keep
    // PSR off its saturation boundary — at SR=0.5/T=600 both PSR and DSR round to 1.0
    // and the inequality is invisible in double precision.
    const rows: RunRow[] = [];
    for (let i = 0; i < 6; i++) {
      const tok = `TOKEN_${i}`;
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 5,
        net_profit_pct: 4, sharpe_ratio: 0.15,
        trades: 12, oos_trades: 4, oos_net_profit_pct: 2,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 10,
        net_profit_pct: 2, sharpe_ratio: 0.10,
        trades: 12, oos_trades: 4, oos_net_profit_pct: 1,
      }));
      rows.push(makeRow({
        token_address: tok, symbol: `T${i}`, param: 15,
        net_profit_pct: 1, sharpe_ratio: 0.05,
        trades: 12, oos_trades: 4, oos_net_profit_pct: 0.5,
      }));
    }
    const score = scoreCell(rows, new Map())!;
    assert.equal(score.k_dsr_effective, 3, `K_dsr_effective=${score.k_dsr_effective}`);
    assert.equal(score.dsr_status, 'ok', `dsr_status='${score.dsr_status}'`);
    // Real deflation: DSR strictly below PSR (the selection-bias correction is non-zero).
    assert.ok(score.dsr < score.psr,
      `with K=3 spread, dsr should be < psr (real deflation); got dsr=${score.dsr}, psr=${score.psr}`);
  });
});
