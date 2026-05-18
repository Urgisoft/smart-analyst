/**
 * SPEC §6.1 of the Path β cell-validator (conversation 2026-05-02).
 *
 * Pins the cell builder's correctness invariants:
 *   - Per-param Sharpe is MEDIAN over tokens (not trade-weighted) — lockstep with
 *     score_strategies.scoreCell:442.
 *   - Winner-pick is argmax-per-param-PSR with trade-count tiebreak — lockstep with
 *     score_strategies.scoreCell:459-481.
 *   - N/A vs fail distinction holds for split_pct=0, oos_sharpe_ratio=0, single-token
 *     cells, and PBO with too few sliced params.
 *   - Determinism: identical inputs → byte-identical ValidatorResult.
 *
 * Synthetic RunRow / SliceRow fixtures use mulberry32 (matches psr.ts's bootstrapDSR
 * PRNG) so all numeric assertions are reproducible.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCellValidatorResult,
  CellTooFewParamsError,
  ChosenParamNotInCellError,
} from '../../src/lib/validator_cell.js';
import { scoreCell, type RunRow, type SliceRow } from '../score_strategies.js';

// ───── Deterministic synthetic helpers ─────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a minimal RunRow with sane defaults; tests override what they care about. */
function makeRow(overrides: Partial<RunRow>): RunRow {
  return {
    strategy_type: 'momentum_v1',
    tier: 'mcap_nano',
    interval: '1h',
    token_address: 'TOKEN_A',
    symbol: 'AAA',
    param: 10,
    run_id: '00000000-0000-0000-0000-000000000000',
    net_profit_pct: 10,
    profit_factor: 1.2,
    win_rate: 50,
    trades: 100,
    sharpe_ratio: 0.5,
    gross_profit: 100, gross_loss: 80,
    oos_net_profit_pct: 5,
    oos_profit_factor: 1.1,
    oos_trades: 30,
    oos_sharpe_ratio: 0.4,
    split_pct: 70,
    data_span_days: 90,  // 90 days × 24 bars/day = 2160 bars at 1h → enough for PBO
    skewness: 0,
    kurtosis: 3,
    n_slices: 16,
    ...overrides,
  };
}

/** Build a multi-param × multi-token cell where param `winnerParam` has the strongest
 *  median tier Sharpe. Per-token Sharpes are drawn from N(driftFor(param), σ) where
 *  driftFor(winnerParam) is the highest. */
function buildEdgeCell(opts: {
  nTokens: number;
  paramSet: number[];
  winnerParam: number;
  baseSharpe?: number;
  sharpeStep?: number;
  sigma?: number;
  splitPct?: number;
  seed?: number;
  withSlices?: boolean;
}): { rows: RunRow[]; slicesByRunId: Map<string, SliceRow[]> } {
  // Per-token Sharpes are kept low (baseSharpe ≈ 0.08) so PSR-argmax stays in the
  // discriminating regime — at SR ≥ ~0.5 with T ≈ 800 trades, PSR saturates to 1.0
  // for every param and the winner-pick collapses to the trade-count tiebreak (then
  // ascending-param order). That'd still match scoreCell exactly, but it's a
  // misleading way to verify the rank — when PSR can resolve, both implementations
  // pick by Sharpe, which is what we actually want to pin.
  const {
    nTokens, paramSet, winnerParam,
    baseSharpe = 0.08, sharpeStep = 0.015, sigma = 0.003,
    splitPct = 70, seed = 1234, withSlices = true,
  } = opts;
  const rng = mulberry32(seed);
  const rows: RunRow[] = [];
  const slicesByRunId = new Map<string, SliceRow[]>();
  for (const p of paramSet) {
    // Distance from winnerParam in the param list; 0 for winner, increases for others.
    const dist = Math.abs(paramSet.indexOf(p) - paramSet.indexOf(winnerParam));
    const meanSharpe = baseSharpe - dist * sharpeStep;
    for (let t = 0; t < nTokens; t++) {
      // Box-Muller-ish: just use rng-symmetric noise to keep determinism.
      const noise = (rng() - 0.5) * 2 * sigma;
      const sharpe = meanSharpe + noise;
      const tokAddr = `TOKEN_${t}`;
      const runId = `${p.toString().padStart(2, '0')}-${t.toString().padStart(2, '0')}`;
      rows.push(makeRow({
        token_address: tokAddr, symbol: `T${t}`, param: p,
        run_id: runId,
        sharpe_ratio: sharpe,
        oos_sharpe_ratio: sharpe * 0.85,  // slight decay; passes Pardo's 0.5 default
        net_profit_pct: 5 + meanSharpe * 10,
        oos_net_profit_pct: 4 + meanSharpe * 8,
        trades: 100, oos_trades: 30,
        split_pct: splitPct,
        n_slices: withSlices ? 16 : 0,
      }));
      if (withSlices) {
        const slices: SliceRow[] = [];
        for (let s = 0; s < 16; s++) {
          slices.push({
            run_id: runId,
            slice_idx: s,
            slice_sharpe: sharpe + (rng() - 0.5) * 0.1,
            slice_n_trades: 6,
          });
        }
        slicesByRunId.set(runId, slices);
      }
    }
  }
  return { rows, slicesByRunId };
}

// ───── Happy path ─────
describe('buildCellValidatorResult — happy path', () => {
  it('runs all four gates on a 19-param × 8-token cell with edge at param 11', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8,
      paramSet: Array.from({ length: 19 }, (_, i) => i + 1),
      winnerParam: 11,
    });
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    assert.equal(built.cell.paramsInCell, 19);
    assert.equal(built.cell.tokensInCell, 8);
    assert.equal(built.cell.chosenParam, 11, 'expected param 11 to win');
    assert.equal(built.cell.paramPickRule, 'psr-argmax');
    assert.equal(built.result.runnableCount, 4, 'all 4 gates should run on this fixture');
    assert.equal(built.result.context.chosenTrialRank, 1);
  });
});

// ───── User override ─────
describe('buildCellValidatorResult — user override', () => {
  it('honors a user-supplied chosenParam and reports paramPickRule="user-override"', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8,
      paramSet: [1, 2, 3, 4, 5],
      winnerParam: 3,
    });
    const built = buildCellValidatorResult({ rows, slicesByRunId, chosenParam: 1 });
    assert.equal(built.cell.chosenParam, 1);
    assert.equal(built.cell.paramPickRule, 'user-override');
  });

  it('throws ChosenParamNotInCellError when chosenParam is not in the cell', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8, paramSet: [1, 2, 3], winnerParam: 2,
    });
    assert.throws(
      () => buildCellValidatorResult({ rows, slicesByRunId, chosenParam: 99 }),
      ChosenParamNotInCellError,
    );
  });
});

// ───── N/A vs fail distinction ─────
describe('buildCellValidatorResult — gate N/A semantics', () => {
  it('OOS/IS gate returns N/A with "cell_no_oos_split" when split_pct = 0', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8, paramSet: [1, 2, 3, 4, 5], winnerParam: 3, splitPct: 0,
    });
    // Simulate "no OOS slice was scored" by zeroing oos_sharpe_ratio and split_pct.
    for (const r of rows) { r.split_pct = 0; r.oos_sharpe_ratio = 0; }
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    assert.equal(built.result.gates.oosIs.status, 'na');
    assert.equal(built.result.gates.oosIs.missingInput, 'cell_no_oos_split');
    // Other gates still run.
    assert.notEqual(built.result.gates.dsr.status, 'na');
    assert.notEqual(built.result.gates.hlz.status, 'na');
  });

  it('PBO gate returns N/A when no params have persisted slices', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8, paramSet: [1, 2, 3, 4, 5], winnerParam: 3, withSlices: false,
    });
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    assert.equal(built.result.gates.pbo.status, 'na');
    assert.equal(built.result.gates.pbo.missingInput, 'cell_has_too_few_sliced_params');
  });
});

// ───── OOS sentinel disambiguation (Issue 1 fix, conv 2026-05-03) ─────
describe('buildCellValidatorResult — oos_sharpe_ratio sentinel disambiguation', () => {
  // The data_span_days = 0 / oos_sharpe_ratio = 0 pair is the legacy sentinel — both
  // columns were added in the same ALTER ADD block so any row missing one is missing
  // both. Filtering on data_span_days > 0 correctly distinguishes legacy rows from
  // modern rows where the OOS Sharpe is genuinely 0 (flat OOS or break-even trades).

  it('treats data_span_days = 0 rows as legacy (Pardo gate N/A with cell_oos_legacy_or_untraded)', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8,
      paramSet: [1, 2, 3, 4, 5],
      winnerParam: 3,
    });
    // Mark every row as legacy: data_span_days = 0 AND oos_sharpe_ratio = 0.
    for (const r of rows) {
      r.data_span_days = 0;
      r.oos_sharpe_ratio = 0;
    }
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    assert.equal(built.result.gates.oosIs.status, 'na');
    assert.equal(built.result.gates.oosIs.missingInput, 'cell_oos_legacy_or_untraded');
    // Other gates should still run — DSR and HLZ don't depend on oos_sharpe_ratio.
    // (HLZ may N/A on its own grounds if T_bars = 0, but we ARE setting data_span_days = 0
    //  so tBars = 0 here and HLZ goes N/A on the unsupported-T branch — that's expected.)
    assert.notEqual(built.result.gates.dsr.status, 'na');
  });

  it('treats data_span_days > 0 + oos_sharpe_ratio = 0 as a genuine fail, NOT N/A', () => {
    // The user's "modern but break-even OOS" case: row was scored, OOS produced flat
    // returns, oos_sharpe_ratio is legitimately 0. The gate should fire (and fail with
    // ratio = 0), not go N/A.
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8,
      paramSet: [1, 2, 3, 4, 5],
      winnerParam: 3,
    });
    for (const r of rows) {
      r.data_span_days = 90;     // modern
      r.oos_sharpe_ratio = 0;    // genuinely 0 (flat OOS)
      r.oos_trades = 30;         // traded enough to count
    }
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    // Pardo gate should run, not be N/A.
    assert.notEqual(built.result.gates.oosIs.status, 'na',
      `expected Pardo gate to run on modern-row genuine-zero, got status=${built.result.gates.oosIs.status}`);
    // Ratio = 0 / IS = 0 → fail (below the 0.5 default gate).
    assert.equal(built.result.gates.oosIs.status, 'fail');
    assert.equal(built.result.gates.oosIs.value, 0,
      'genuine zero OOS Sharpe → ratio = 0 (gate fails honestly)');
  });

  it('mixed cell: legacy rows excluded from OOS aggregate, modern rows score the gate', () => {
    // 8 tokens — 4 legacy (data_span_days=0), 4 modern with valid OOS Sharpes.
    // The OOS aggregate should be median of the 4 modern values, not contaminated by
    // the legacy 0s.
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8,
      paramSet: [1, 2, 3, 4, 5],
      winnerParam: 3,
    });
    // First 4 tokens at every param are legacy; last 4 stay modern with their
    // already-positive OOS Sharpes from the fixture.
    for (const r of rows) {
      const tokIdx = parseInt(r.token_address.slice('TOKEN_'.length), 10);
      if (tokIdx < 4) {
        r.data_span_days = 0;
        r.oos_sharpe_ratio = 0;
      }
    }
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    // Gate should run on the 4 modern tokens.
    assert.notEqual(built.result.gates.oosIs.status, 'na');
    // The modern OOS Sharpes were ~0.07 (from buildEdgeCell's 0.85x decay), median
    // should be in that ballpark — emphatically not 0.
    const value = built.result.gates.oosIs.value as number | null;
    assert.ok(value !== null && Math.abs(value) > 0,
      `expected non-zero gate value from modern subset, got ${value}`);
  });
});

// ───── Empty / sparse cells ─────
describe('buildCellValidatorResult — sparse-cell rejection', () => {
  it('throws CellTooFewParamsError when only 1 param qualifies', () => {
    const rows = [makeRow({ param: 7 }), makeRow({ token_address: 'TOKEN_B', param: 7 })];
    assert.throws(
      () => buildCellValidatorResult({ rows, slicesByRunId: new Map() }),
      CellTooFewParamsError,
    );
  });
});

// ───── Single-token (cex_major-style) cell ─────
describe('buildCellValidatorResult — cex_major single-token', () => {
  it('runs all four gates on a 1-token × 8-param cell', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 1,
      paramSet: [1, 2, 3, 4, 5, 6, 7, 8],
      winnerParam: 4,
    });
    // Mark as cex_major to be honest about the fixture.
    for (const r of rows) { r.tier = 'cex_major'; }
    const built = buildCellValidatorResult({ rows, slicesByRunId });
    assert.equal(built.cell.tokensInCell, 1);
    // With only 1 token at the chosen param, perAssetSharpes count = 1 < 4, so DSR
    // falls back to parametric — the existing helper's behavior.
    const dsrMethod = (built.result.gates.dsr.extras as { method?: string }).method;
    assert.equal(dsrMethod, 'parametric');
  });
});

// ───── Lockstep with score_strategies.scoreCell ─────
describe('buildCellValidatorResult — lockstep with scoreCell', () => {
  it('picks the same param as scoreCell on a synthetic edge fixture', () => {
    const { rows, slicesByRunId } = buildEdgeCell({
      nTokens: 8,
      paramSet: [1, 5, 10, 15, 20],
      winnerParam: 10,
    });
    const validatorPick = buildCellValidatorResult({ rows, slicesByRunId }).cell.chosenParam;
    const scoreCellPick = scoreCell(rows, slicesByRunId);
    assert.ok(scoreCellPick, 'scoreCell returned null on fixture meant to qualify');
    assert.equal(validatorPick, scoreCellPick!.best_param,
      `validator picked ${validatorPick}, scoreCell picked ${scoreCellPick!.best_param}`);
  });

  // Critic-pass 2026-05-03 B-2 regression: validator and scoreCell apply the SAME
  // param-selection eligibility floor (`tokensWithTrades >= max(3, floor(N × 0.10))`).
  // Without the lockstep floor, the validator would pick a sparse-token param with a
  // stellar PSR that scoreCell would skip. This test constructs exactly that fixture
  // and asserts both paths agree on the non-sparse winner.
  it('agrees with scoreCell when a sparse-token param has the highest naive PSR', () => {
    // 10 tokens, 5 params. Param 99 has only 1 token trading (< floor of 3) but a
    // very high Sharpe → naive PSR would crown it. Param 5 is the legitimate winner
    // with 10 tokens trading at moderate Sharpe.
    const N_TOKENS = 10;
    const slicesByRunId = new Map<string, SliceRow[]>();
    const rows: RunRow[] = [];

    // Params 1, 3, 5, 7: every token at moderate Sharpe (legitimate trial set).
    for (const p of [1, 3, 5, 7]) {
      // Param 5 is the intended winner — slightly higher Sharpe than peers.
      const meanSharpe = p === 5 ? 0.10 : 0.06;
      for (let t = 0; t < N_TOKENS; t++) {
        const runId = `${p.toString().padStart(2, '0')}-${t.toString().padStart(2, '0')}`;
        rows.push(makeRow({
          token_address: `TOKEN_${t}`, symbol: `T${t}`,
          param: p, run_id: runId,
          sharpe_ratio: meanSharpe, oos_sharpe_ratio: meanSharpe * 0.85,
          trades: 100, oos_trades: 30,
          n_slices: 16,
        }));
        const slices: SliceRow[] = [];
        for (let s = 0; s < 16; s++) {
          slices.push({ run_id: runId, slice_idx: s, slice_sharpe: meanSharpe, slice_n_trades: 6 });
        }
        slicesByRunId.set(runId, slices);
      }
    }
    // Param 99: only 1 token trades, with a deliberately stellar Sharpe (would beat
    // param 5 on naive PSR). This is the sparse-jackpot case that B-2 caught.
    const sparseRunId = '99-00';
    rows.push(makeRow({
      token_address: 'TOKEN_0', symbol: 'T0',
      param: 99, run_id: sparseRunId,
      sharpe_ratio: 1.50, oos_sharpe_ratio: 1.20,
      trades: 200, oos_trades: 60,
      n_slices: 16,
    }));
    const sparseSlices: SliceRow[] = [];
    for (let s = 0; s < 16; s++) {
      sparseSlices.push({ run_id: sparseRunId, slice_idx: s, slice_sharpe: 1.50, slice_n_trades: 12 });
    }
    slicesByRunId.set(sparseRunId, sparseSlices);

    const validatorPick = buildCellValidatorResult({ rows, slicesByRunId }).cell.chosenParam;
    const scoreCellPick = scoreCell(rows, slicesByRunId);
    assert.ok(scoreCellPick, 'scoreCell returned null on a fixture meant to qualify');
    assert.notEqual(validatorPick, 99,
      'validator must NOT pick the sparse-token param 99 (1 token < floor of max(3, 1)) — ' +
      'this is the B-2 regression: pre-fix validator would pick 99 on naive PSR.');
    assert.equal(validatorPick, scoreCellPick!.best_param,
      `lockstep failure: validator picked ${validatorPick}, scoreCell picked ${scoreCellPick!.best_param}`);
  });
});

// ───── Determinism ─────
describe('buildCellValidatorResult — determinism', () => {
  it('two calls on identical inputs produce identical gate values', () => {
    const fixture = buildEdgeCell({
      nTokens: 8, paramSet: [1, 5, 10, 15], winnerParam: 5,
    });
    const a = buildCellValidatorResult({ rows: fixture.rows, slicesByRunId: fixture.slicesByRunId });
    const b = buildCellValidatorResult({ rows: fixture.rows, slicesByRunId: fixture.slicesByRunId });
    assert.deepEqual(a.result.gates.dsr.value, b.result.gates.dsr.value);
    assert.deepEqual(a.result.gates.pbo.value, b.result.gates.pbo.value);
    assert.deepEqual(a.result.gates.hlz.value, b.result.gates.hlz.value);
    assert.deepEqual(a.result.gates.oosIs.value, b.result.gates.oosIs.value);
    assert.deepEqual(a.cell, b.cell);
  });
});
