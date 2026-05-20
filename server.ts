import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { Tunnel as CloudflareTunnel, bin as cloudflaredBin } from "cloudflared";
import {
  fetchCandles,
  fetchTierTokens,
  fetchSymbols,
  fetchSolRegime,
  pingClickHouse,
  ensureBacktestTables,
  ensureMacroRegimeTables,
  fetchStrategies,
  upsertStrategy,
  archiveStrategy,
  searchBacktestRuns,
  listSweeps,
  fetchBacktestFacets,
  fetchStrategyScores,
  fetchValidatorCells,
  fetchValidatorCellData,
  fetchValidatorClusterCells,
  fetchValidatorClusterCellData,
  type StrategyBundle,
  type BacktestSearchFilters,
} from "./src/server/clickhouse.js";
import { parseValidatorRequest, isParseFailure } from "./src/lib/validator_request.js";
import { validatorScore } from "./src/lib/validator.js";
import { parseScoreCellRequest, isCellParseFailure } from "./src/lib/validator_cell_request.js";
import {
  buildCellValidatorResult,
  CellEmptyError,
  CellTooFewParamsError,
  ChosenParamNotInCellError,
} from "./src/lib/validator_cell.js";
import {
  parseScoreClusterRequest,
  isClusterParseFailure,
} from "./src/lib/validator_cluster_request.js";
import {
  buildClusterValidatorResult,
  ClusterMixedError,
} from "./src/lib/validator_cluster.js";
import {
  parseDiagnosticsQuery,
  isDiagnosticsQueryFailure,
  fetchClusterDiagnostics,
  parseScoresQuery,
  isScoresQueryFailure,
  fetchClusterScores,
  NoPublishedFitError,
} from "./src/server/cluster_dashboard.js";
import {
  parseCellsQuery as parseMetaLabelingCellsQuery,
  isCellsQueryFailure as isMetaLabelingCellsQueryFailure,
  fetchMetaLabelingCells,
} from "./src/server/meta_labeling_dashboard.js";
import {
  parseQuery as parsePaperTradingQuery,
  isQueryFailure as isPaperTradingQueryFailure,
  fetchPaperTradingState,
} from "./src/server/paper_trading_dashboard.js";
import {
  parseQuery as parseRegimeQuery,
  isQueryFailure as isRegimeQueryFailure,
  fetchRegimeState,
  RegimeDashboardError,
} from "./src/server/regime_dashboard.js";
import {
  parseQuery as parseCyclePositionQuery,
  isQueryFailure as isCyclePositionQueryFailure,
  fetchCyclePositionState,
  CyclePositionDashboardError,
} from "./src/server/cycle_position_dashboard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TierDef {
  id: string;
  name: string;
  category: 'vol' | 'beta' | 'mcap' | 'volume' | 'combo' | 'regime';
  description: string;
}

const TIERS: TierDef[] = [
  { id: 'vol_low',     name: 'LOW VOL',     category: 'vol',    description: 'Realized vol (30d) < 1.5 — stable / wrapped' },
  { id: 'vol_mid',     name: 'MID VOL',     category: 'vol',    description: 'Realized vol 1.5–3.0' },
  { id: 'vol_high',    name: 'HIGH VOL',    category: 'vol',    description: 'Realized vol ≥ 3.0 — memecoin tier' },
  { id: 'beta_neg',    name: 'NEG BETA',    category: 'beta',   description: 'Beta to SOL < 0 — counter-correlated' },
  { id: 'beta_market', name: 'MARKET BETA', category: 'beta',   description: 'Beta 0.5–1.5 — moves with SOL' },
  { id: 'beta_high',   name: 'HIGH BETA',   category: 'beta',   description: 'Beta > 1.5 — leveraged to SOL' },
  { id: 'mcap_nano',   name: 'NANO CAP',    category: 'mcap',   description: 'Mcap < $10M' },
  { id: 'mcap_micro',  name: 'MICRO CAP',   category: 'mcap',   description: 'Mcap $10M – $100M' },
  { id: 'mcap_small',  name: 'SMALL CAP',   category: 'mcap',   description: 'Mcap $100M – $1B' },
  { id: 'mcap_mid',    name: 'MID CAP',     category: 'mcap',   description: 'Mcap $1B – $10B' },
  { id: 'mcap_large',  name: 'LARGE CAP',   category: 'mcap',   description: 'Mcap ≥ $10B' },
  { id: 'vol_top',     name: 'TOP VOLUME',  category: 'volume', description: 'Highest 24h $ volume (yesterday)' },
  { id: 'combo_hot',   name: 'HOT (vol+beta)', category: 'combo', description: 'High vol AND high SOL beta' },
  { id: 'regime_bull',     name: 'BULL LEADERS',  category: 'regime', description: 'Tokens up most over the last 7 days' },
  { id: 'regime_bear',     name: 'BEAR DUMPED',   category: 'regime', description: 'Tokens down most over the last 7 days' },
  { id: 'regime_sideways', name: 'RANGE-BOUND',   category: 'regime', description: 'Smallest 7d move (|return| < 10%)' },
];

async function startServer() {
  const app = express();
  const PORT = 3000;
  // Global JSON parser at the default 100kb cap — but skip the validator route, which
  // installs its own 50mb parser at the route-level (see /api/validator/score below).
  // Without this skip, the global cap fires first and rejects multi-MB payloads with 413.
  const globalJson = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/validator/')) return next();
    return globalJson(req, res, next);
  });

  // Force fresh data on every request — when ClickHouse is updated (new candles, new tokens),
  // the dashboard should reflect it without a hard refresh.
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    next();
  });

  app.get("/api/health", async (_req, res) => {
    res.json({ clickhouse: await pingClickHouse() });
  });

  // Current SOL regime — used by the sidebar badge so the user knows whether
  // BULL LEADERS / BEAR DUMPED tokens are aligned with what SOL is actually doing.
  app.get("/api/sol-regime", async (_req, res) => {
    try {
      res.json(await fetchSolRegime());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ───── Strategy registry ─────
  // List all bundles (or include archived). Persisted in quantlab.strategies.
  app.get("/api/strategies", async (req, res) => {
    try {
      const includeArchived = String(req.query.includeArchived ?? '') === 'true';
      res.json(await fetchStrategies(includeArchived));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Upsert (create or replace) — bundleId acts as the primary key. The frontend uses this
  // both for "save new" and "update existing" — versioning is by convention (e.g. _v2 suffix).
  app.post("/api/strategies", async (req, res) => {
    const b = req.body as StrategyBundle;
    if (!b?.bundleId || !b.name || !b.family) {
      return res.status(400).json({ error: 'bundleId, name, family required' });
    }
    try {
      await upsertStrategy(b);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Archive (soft-delete) — sets archived=1 so existing bt_runs rows still reference it.
  app.delete("/api/strategies/:id", async (req, res) => {
    try {
      await archiveStrategy(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // ───── Pre-computed backtest search ─────
  // Filter the bt_runs table by strategy / tier / performance metrics. The dashboard's
  // Browse Results panel calls this — replaces on-demand sweeps as the primary entry point
  // now that the batch engine has populated bt_runs.
  app.get("/api/backtest/search", async (req, res) => {
    const q = req.query;
    const num = (k: string) => (q[k] != null && q[k] !== '' ? Number(q[k]) : undefined);
    const str = (k: string) => (q[k] != null && q[k] !== '' ? String(q[k]) : undefined);
    const sortBy = str('sortBy') as BacktestSearchFilters['sortBy'];
    const sortDir = str('sortDir') === 'asc' ? 'asc' : 'desc';
    const filters: BacktestSearchFilters = {
      strategyType: str('strategyType'),
      tier: str('tier'),
      symbolLike: str('symbolLike'),
      tokenAddress: str('tokenAddress'),
      sweepId: str('sweepId'),
      interval: str('interval'),
      minNetPct: num('minNetPct'),
      minProfitFactor: num('minProfitFactor'),
      minTrades: num('minTrades'),
      minWinRate: num('minWinRate'),
      minOosNetPct: num('minOosNetPct'),
      minOosProfitFactor: num('minOosProfitFactor'),
      minOosTrades: num('minOosTrades'),
      minDataSpanDays: num('minDataSpanDays'),
      sortBy: sortBy ?? 'net_profit_pct',
      sortDir,
      limit: num('limit') ?? 100,
      bestPerToken: String(q.bestPerToken ?? '') === 'true',
    };
    try {
      res.json(await searchBacktestRuns(filters));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Recent sweeps (for the sweep filter dropdown).
  app.get("/api/backtest/sweeps", async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    try {
      res.json(await listSweeps(limit));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Top strategies — composite "is this worth deploying?" rankings derived offline by
  // `npm run score:strategies`. Powers the dashboard's Top Strategies panel.
  app.get("/api/strategies/scores", async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)));
    try {
      res.json(await fetchStrategyScores(limit));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Distinct facet values (strategies / tiers / intervals) for the filter UI.
  app.get("/api/backtest/facets", async (_req, res) => {
    try {
      res.json(await fetchBacktestFacets());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // List of tier definitions for the frontend dropdown.
  app.get("/api/tiers", (_req, res) => {
    res.json(TIERS);
  });

  // Tokens that match ALL selected tiers (intersection by mint address).
  // GET /api/tokens?tiers=vol_high,mcap_small&perTier=30&interval=1h&minAgeDays=14&maxStaleDays=14
  // Each tier is queried with a high internal limit so the intersection has breathing room;
  // the final result is then truncated to perTier.
  app.get("/api/tokens", async (req, res) => {
    const tierIds = String(req.query.tiers || '').split(',').map(s => s.trim()).filter(Boolean);
    const perTier = Math.min(200, Math.max(1, Number(req.query.perTier || 30)));
    const interval = String(req.query.interval || '1h');
    const minAgeDays = Math.max(0, Math.min(365, Number(req.query.minAgeDays ?? 14)));
    const maxStaleDays = Math.max(1, Math.min(365, Number(req.query.maxStaleDays ?? 14)));
    if (tierIds.length === 0) return res.json([]);

    // Fetch each tier with a generous internal limit so intersection rarely starves.
    const FETCH_PER_TIER = 400;
    const tierResults: Awaited<ReturnType<typeof fetchTierTokens>>[] = [];
    const tierLabels: string[] = [];
    for (const tid of tierIds) {
      const tierDef = TIERS.find(t => t.id === tid);
      if (!tierDef) continue;
      try {
        tierResults.push(await fetchTierTokens(tid, FETCH_PER_TIER, interval, minAgeDays, maxStaleDays));
        tierLabels.push(tierDef.name);
      } catch {
        tierResults.push([]);
        tierLabels.push(tierDef.name);
      }
    }

    if (tierResults.length === 0) return res.json([]);

    // Intersect mint addresses across all tier result sets.
    const inAll = tierResults.reduce<Set<string>>((acc, set, i) => {
      const ids = new Set(set.map(t => t.token_address));
      if (i === 0) return ids;
      const next = new Set<string>();
      for (const id of acc) if (ids.has(id)) next.add(id);
      return next;
    }, new Set());

    // Build the output rows. Use the FIRST tier's data for fields (mcap/vol/beta/etc),
    // since they're token-scoped and identical regardless of which tier we read them from.
    const firstByAddr = new Map(tierResults[0].map(t => [t.token_address, t]));
    const out = [...inAll]
      .map(addr => firstByAddr.get(addr)!)
      .filter(Boolean)
      .slice(0, perTier)
      .map(t => ({ ...t, tier: tierLabels.join(' ∩ ') }));

    res.json(out);
  });

  // Tokens for a single tier (kept for backwards compatibility — not used by the UI now).
  app.get("/api/tiers/:id/tokens", async (req, res) => {
    const tierId = req.params.id;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 8)));
    const interval = String(req.query.interval || '1h');
    try {
      const tokens = await fetchTierTokens(tierId, limit, interval);
      res.json(tokens);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // OHLCV candles by token address.
  app.get("/api/candles", async (req, res) => {
    const token = String(req.query.token || '');
    const interval = String(req.query.interval || '1h');
    const limit = Math.min(20000, Math.max(10, Number(req.query.limit || 300)));
    if (!token) return res.status(400).json({ error: 'token (mint address) required' });
    try {
      const candles = await fetchCandles(token, interval, limit);
      res.json(candles);
    } catch (e) {
      console.error('candles error', e);
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Resolve mint addresses → symbols (batch).
  app.post("/api/symbols", async (req, res) => {
    const addrs = (req.body?.addresses ?? []) as string[];
    if (!Array.isArray(addrs)) return res.status(400).json({ error: 'addresses[] required' });
    try {
      res.json(await fetchSymbols(addrs));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Path 2 validator — runs the four-gate stack (DSR/PBO/HLZ-BHY/OOS-IS) on user-supplied
  // sweep returns. Per-route 50MB body limit overrides the global 100kb default for this
  // endpoint only — other endpoints still enforce the small default.
  const validatorBody = express.json({ limit: '50mb' });
  app.post("/api/validator/score", validatorBody, async (req, res) => {
    try {
      const parsed = parseValidatorRequest(req.body);
      if (isParseFailure(parsed)) {
        return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
      }
      res.json(validatorScore(parsed.value));
    } catch (e) {
      console.error('validator error', e);
      res.status(500).json({ error: 'internal', detail: (e as Error).message });
    }
  });

  // Path β cell-level validator — runs the same four-gate stack as /score, but on
  // a (strategy, tier, interval) cell pulled from bt_runs + bt_runs_slices. Same
  // 50mb body cap (the request itself is tiny, but verdict response payload can
  // approach that for cells with many params).
  app.post("/api/validator/score-cell", validatorBody, async (req, res) => {
    // Per Phase 2 SPEC §5.4: `?axis=cluster` dispatches to the cluster-axis validator
    // (reads v_bt_runs_by_cluster, expects {strategy, clusterId, interval} in the body).
    // Default / `?axis=tier` is the existing tier-axis path. Both axes share the same
    // gate stack via `validator_cluster.ts → validator_cell.ts` delegation, so a verdict
    // shape is identical across axes — only the `cell` metadata block differs.
    const axis = req.query.axis === 'cluster' ? 'cluster' : 'tier';
    try {
      if (axis === 'cluster') {
        const parsed = parseScoreClusterRequest(req.body);
        if (isClusterParseFailure(parsed)) {
          return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
        }
        const { strategy, clusterId, interval, chosenParam, thresholds } = parsed.value;
        let cellData;
        try {
          cellData = await fetchValidatorClusterCellData({ strategy, clusterId, interval });
        } catch (e) {
          return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
        }
        if (cellData.rows.length === 0) {
          return res.status(404).json({
            error: 'cluster_cell_not_found',
            detail: `No v_bt_runs_by_cluster rows for (strategy=${strategy}, ` +
              `cluster_id=${clusterId}, interval=${interval}). The cluster may have no admitted ` +
              `tokens at the time of these runs, or no runs exist for this cell.`,
          });
        }

        try {
          const built = buildClusterValidatorResult({
            rows: cellData.rows,
            slicesByRunId: cellData.slicesByRunId,
            chosenParam,
            thresholds,
          });
          const response = {
            ...built.result,
            context: {
              ...built.result.context,
              cell: { strategy, clusterId, interval, ...built.cell },
            },
          };
          return res.json(response);
        } catch (e) {
          if (e instanceof CellEmptyError) {
            return res.status(404).json({ error: 'cluster_cell_not_found',
              detail: 'Cluster cell is empty after qualification.' });
          }
          if (e instanceof CellTooFewParamsError) {
            return res.status(422).json({ error: 'cell_too_few_params',
              detail: `Cluster cell has only ${e.paramsInCell} qualifying param(s); DSR/HLZ/PBO need ≥ 2.` });
          }
          if (e instanceof ChosenParamNotInCellError) {
            return res.status(422).json({ error: 'chosen_param_not_in_cell',
              detail: `chosenParam=${e.chosenParam} not in qualifying set [${e.availableParams.join(', ')}].` });
          }
          if (e instanceof ClusterMixedError) {
            // The route's WHERE clause pins `cluster_id = {clusterId:Int32}`, so this
            // branch is by-construction unreachable. If it ever fires, the view DDL
            // is broken — not a user error. Surface as a generic internal failure
            // with diagnostic detail in the server log.
            console.error('cluster_mixed_rows from view despite pinned WHERE — view DDL bug?',
              { seenClusterIds: e.seenClusterIds, strategy, clusterId, interval });
            return res.status(500).json({ error: 'internal',
              detail: 'Cluster invariant violated; this is a server-side bug.' });
          }
          throw e;
        }
      }

      // ── Tier-axis path (default; matches pre-§5.4 behavior byte-for-byte) ──
      const parsed = parseScoreCellRequest(req.body);
      if (isCellParseFailure(parsed)) {
        return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
      }
      const { strategy, tier, interval, chosenParam, thresholds } = parsed.value;
      let cellData;
      try {
        cellData = await fetchValidatorCellData({ strategy, tier, interval });
      } catch (e) {
        return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
      }
      if (cellData.rows.length === 0) {
        return res.status(404).json({
          error: 'cell_not_found',
          detail: `No bt_runs rows for (strategy=${strategy}, tier=${tier}, interval=${interval}) ` +
            `after the canonical filter.`,
        });
      }

      try {
        const built = buildCellValidatorResult({
          rows: cellData.rows,
          slicesByRunId: cellData.slicesByRunId,
          chosenParam,
          thresholds,
        });
        // Extend context with the cell metadata block (SPEC §1.1 response shape).
        const response = {
          ...built.result,
          context: { ...built.result.context, cell: { strategy, tier, interval, ...built.cell } },
        };
        return res.json(response);
      } catch (e) {
        if (e instanceof CellEmptyError) {
          return res.status(404).json({ error: 'cell_not_found', detail: 'Cell is empty after qualification.' });
        }
        if (e instanceof CellTooFewParamsError) {
          return res.status(422).json({ error: 'cell_too_few_params',
            detail: `Cell has only ${e.paramsInCell} qualifying param(s); DSR/HLZ/PBO need ≥ 2.` });
        }
        if (e instanceof ChosenParamNotInCellError) {
          return res.status(422).json({ error: 'chosen_param_not_in_cell',
            detail: `chosenParam=${e.chosenParam} not in qualifying set [${e.availableParams.join(', ')}].` });
        }
        throw e;
      }
    } catch (e) {
      console.error(`validator score-cell error (axis=${axis})`, e);
      res.status(500).json({ error: 'internal', detail: (e as Error).message });
    }
  });

  // List the (strategy, tier, interval) cells available for cell-level validation,
  // with cardinalities for the UI dropdowns. Cheap GROUP BY on bt_runs.
  // `?axis=cluster` returns the cluster-axis sibling list from `v_bt_runs_by_cluster`.
  app.get("/api/validator/cells", async (req, res) => {
    const axis = req.query.axis === 'cluster' ? 'cluster' : 'tier';
    try {
      if (axis === 'cluster') {
        const cells = await fetchValidatorClusterCells();
        return res.json({ cells, axis });
      }
      const cells = await fetchValidatorCells();
      res.json({ cells, axis });
    } catch (e) {
      console.error(`validator cells error (axis=${axis})`, e);
      res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // ───── Cluster-axis dashboard (Phase 2 §5.5) ─────
  // Powers Panel A on /#/cluster — universe-stability tile strip + cohort detail.
  // Read-only (no schema changes). All thresholds are echoed back in the response so
  // the front-end has a single source of truth; see DASHBOARD_THRESHOLDS in
  // src/server/cluster_dashboard.ts.
  app.get("/api/cluster/diagnostics", async (req, res) => {
    const parsed = parseDiagnosticsQuery({ weeks: req.query.weeks, method: req.query.method });
    if (isDiagnosticsQueryFailure(parsed)) {
      return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
    }
    try {
      const response = await fetchClusterDiagnostics({ weeks: parsed.weeks, method: parsed.method });
      return res.json(response);
    } catch (e) {
      console.error('cluster diagnostics error', e);
      // ClickHouse driver throws on connection / parse errors; can't reliably
      // distinguish "CH down" from "internal bug" without sniffing error
      // messages. Default to 503 since the most likely cause is CH unreachable
      // (the orchestrator's pure-function seam catches programmer errors at
      // test time, not runtime).
      return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // Powers Panel B on /#/cluster — cluster-axis four-gate scores with tier-axis
  // comparator. fitId is optional (server resolves the latest published/single_cohort
  // fit when omitted); 404 surfaces when no fit has yet been published.
  app.get("/api/cluster/scores", async (req, res) => {
    const parsed = parseScoresQuery({ fitId: req.query.fitId, limit: req.query.limit });
    if (isScoresQueryFailure(parsed)) {
      return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
    }
    try {
      const response = await fetchClusterScores({ fitId: parsed.fitId, limit: parsed.limit });
      return res.json(response);
    } catch (e) {
      if (e instanceof NoPublishedFitError) {
        return res.status(404).json({
          error: 'no_published_fit',
          detail: 'No published HDBSCAN fit yet. Run `npm run cluster:weekly` for a recent week.',
        });
      }
      console.error('cluster scores error', e);
      return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // Powers /#/meta-labeling — research-log view of every meta-labeling cell-training
  // persisted in `quantlab.meta_models`. Read-only; derives partial-verdict pills (C1,
  // C2, C4) from the columns we persist. Full 7-criterion verdict requires the trainer
  // log (see ADR-024); the panel surfaces this honestly.
  app.get("/api/meta-labeling/cells", async (req, res) => {
    const parsed = parseMetaLabelingCellsQuery({ limit: req.query.limit });
    if (isMetaLabelingCellsQueryFailure(parsed)) {
      return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
    }
    try {
      const response = await fetchMetaLabelingCells({ limit: parsed.limit });
      return res.json(response);
    } catch (e) {
      console.error('meta-labeling cells error', e);
      return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // Powers /#/paper-trading — read-only view of `quantlab.live_signals` for the daily
  // signal daemon's state (current open positions per deployed cell + recent run
  // history). UI alternative to tailing the daemon's Telegram messages.
  app.get("/api/paper-trading/state", async (req, res) => {
    const parsed = parsePaperTradingQuery({ runHistoryLimit: req.query.runHistoryLimit });
    if (isPaperTradingQueryFailure(parsed)) {
      return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
    }
    try {
      const response = await fetchPaperTradingState({ runHistoryLimit: parsed.runHistoryLimit });
      return res.json(response);
    } catch (e) {
      console.error('paper-trading state error', e);
      return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // Powers /#/regime — Track C / Component 3. Read-only view of
  // `quantlab.macro_regimes` under classifier_version='phase1_v2', with the
  // ADR-037 bias-quarantine banner first-class in the response so the
  // operator never sees a regime label without the survivorship caveat.
  // SPEC: docs/specs/regime-dashboard-component3.md.
  app.get("/api/regime/state", async (req, res) => {
    const parsed = parseRegimeQuery({ asOf: req.query.asOf, lookbackDays: req.query.lookbackDays });
    if (isRegimeQueryFailure(parsed)) {
      return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
    }
    try {
      const response = await fetchRegimeState({ asOf: parsed.asOf, lookbackDays: parsed.lookbackDays });
      return res.json(response);
    } catch (e) {
      if (e instanceof RegimeDashboardError) {
        return res.status(e.status).json({ error: e.error, detail: e.detail });
      }
      console.error('regime state error', e);
      return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // Powers /#/cycle-position — market-cycle-position Phase A6. Read-only view
  // of `quantlab.cycle_position_snapshots`. Returns the latest snapshot plus
  // a `lookbackDays`-window of history for the trend + per-bucket contribution
  // panels. Returns hasData=false (not 503) when no snapshot exists yet so the
  // dashboard can render a friendly "awaiting first daemon cycle" state.
  // SPEC: docs/specs/market-cycle-position.md §3 (component diagram).
  app.get("/api/cycle-position", async (req, res) => {
    const parsed = parseCyclePositionQuery({ lookbackDays: req.query.lookbackDays });
    if (isCyclePositionQueryFailure(parsed)) {
      return res.status(parsed.status).json({ error: parsed.error, detail: parsed.detail });
    }
    try {
      const response = await fetchCyclePositionState({ lookbackDays: parsed.lookbackDays });
      return res.json(response);
    } catch (e) {
      if (e instanceof CyclePositionDashboardError) {
        return res.status(e.status).json({ error: e.error, detail: e.detail });
      }
      console.error('cycle-position state error', e);
      return res.status(503).json({ error: 'clickhouse_unavailable', detail: (e as Error).message });
    }
  });

  // Demo CSV fixtures — served from docs/fixtures so the canonical files stay version-
  // controlled in docs/ rather than duplicated into public/. Allow-listed filenames only;
  // no path traversal possible. Used by the InputPanel "Load demo" button.
  const VALIDATOR_DEMO_FILES: Record<string, string> = {
    pass: 'docs/fixtures/validator_demo_pass.csv',
    fail: 'docs/fixtures/validator_demo_fail.csv',
    'per-asset': 'docs/fixtures/validator_demo_per_asset.csv',
  };
  app.get("/api/validator/demo/:name", async (req, res) => {
    const rel = VALIDATOR_DEMO_FILES[req.params.name];
    if (!rel) return res.status(404).json({ error: 'unknown demo fixture', detail: `valid names: ${Object.keys(VALIDATOR_DEMO_FILES).join(', ')}` });
    try {
      const text = await fs.readFile(path.resolve(__dirname, rel), 'utf8');
      res.type('text/csv').send(text);
    } catch (e) {
      res.status(500).json({ error: 'fixture read failed', detail: (e as Error).message });
    }
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => { res.sendFile(path.join(distPath, 'index.html')); });
  }

  const ok = await pingClickHouse();
  if (ok) {
    try {
      await ensureBacktestTables();
      console.log('✓ Backtest persistence tables ready (quantlab.bt_runs, quantlab.bt_trades)');
    } catch (e) {
      console.warn('⚠ Failed to ensure bt_runs/bt_trades tables:', (e as Error).message);
    }
    try {
      await ensureMacroRegimeTables();
      console.log('✓ Macro regime tables ready (quantlab.macro_breadth, quantlab.macro_regimes, quantlab.sp500_constituents)');
    } catch (e) {
      console.warn('⚠ Failed to ensure macro_breadth/macro_regimes/sp500_constituents tables:', (e as Error).message);
    }
  }
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(ok ? '✓ ClickHouse (quantlab) connection OK' : '⚠ ClickHouse unreachable — check .env and that quantlab-clickhouse is running');
    const stopTunnel = startCloudflareTunnel(PORT);
    installShutdown(httpServer, stopTunnel);
  });
}

/**
 * Centralized graceful shutdown — wires SIGINT (Ctrl-C) and SIGTERM to:
 *   1. Stop accepting new HTTP connections (httpServer.close)
 *   2. Force-close existing keep-alive sockets so the close callback actually fires
 *      (default httpServer.close hangs until every keep-alive client disconnects)
 *   3. Stop the Cloudflare tunnel child process
 *   4. process.exit(0) when both done
 *   5. Hard-kill timer (3s) as a backstop if anything's still holding the loop open —
 *      typical culprits on Windows are winpty + tsx not propagating signals cleanly to
 *      cloudflared, leaving the parent waiting on a child that's already dead.
 *
 * Without this, custom SIGINT handlers REPLACE Node's default exit-on-SIGINT, so the
 * process hangs, the bound port stays held, and the next `npm run dev` hits EADDRINUSE.
 */
function installShutdown(httpServer: import('node:http').Server, stopTunnel: () => void) {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n• ${signal} received — shutting down...`);
    // Hard-kill backstop: if anything's still hanging after 3s, force exit. Better to
    // kill a stuck cloudflared than leave the user with a held port.
    const hardKill = setTimeout(() => {
      console.warn('• Graceful shutdown timed out, forcing exit.');
      process.exit(0);
    }, 3000);
    hardKill.unref(); // don't let the timer itself keep the loop alive

    try { stopTunnel(); } catch { /* already gone */ }

    // Force-close idle keep-alive sockets so server.close()'s callback actually fires.
    // Node 18.2+ added closeAllConnections; older Nodes will skip this branch silently.
    const anyServer = httpServer as unknown as { closeAllConnections?: () => void };
    if (typeof anyServer.closeAllConnections === 'function') {
      anyServer.closeAllConnections();
    }
    httpServer.close(err => {
      if (err) console.warn(`• httpServer.close error: ${err.message}`);
      else console.log('✓ Port released cleanly.');
      clearTimeout(hardKill);
      process.exit(0);
    });
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Spin up a Cloudflare Quick Tunnel so the dashboard is reachable from anywhere on the
 * internet without DNS / port-forwarding / accounts. Free, ephemeral URL on
 * `*.trycloudflare.com` — printed once the tunnel is connected.
 *
 * Skipped when NO_TUNNEL=1. Auto-restarts on unexpected exit (network blips, etc.).
 *
 * Returns a stop() function that the central shutdown handler calls — the tunnel no
 * longer registers its own SIGINT/SIGTERM handlers, because two separate handlers fighting
 * for the same signal was part of why Ctrl-C didn't release the port (one would call stop()
 * but neither called process.exit(), so the loop just stayed alive).
 */
function startCloudflareTunnel(port: number): () => void {
  // Opt-in by default. The auto-spawning quick tunnel was crashing the dev server in
  // multiple sessions (post-mortem unhandledRejection from the cloudflared package),
  // and the user runs cloudflared separately for other purposes — having `npm run dev`
  // also try to claim it caused conflicts. Standalone `npm run tunnel` is still the
  // way to run a tunnel when you actually want one.
  if (process.env.WITH_TUNNEL !== '1') {
    if (process.env.NO_TUNNEL !== '1') {
      // Quiet hint on the default (skipped) path so it's discoverable. NO_TUNNEL=1 callers
      // get the explicit acknowledgement they expect.
      console.log('• Cloudflare tunnel disabled by default. Set WITH_TUNNEL=1 or run `npm run tunnel` separately to enable.');
    } else {
      console.log('• Cloudflare tunnel skipped (NO_TUNNEL=1).');
    }
    return () => {};
  }
  if (!cloudflaredBin || !existsSync(cloudflaredBin)) {
    console.warn(`⚠ Cloudflare tunnel binary not found at ${cloudflaredBin}. Skipping. Run \`npx cloudflared --version\` to trigger install.`);
    return () => {};
  }

  let restartCount = 0;
  const RESTART_CAP = 5;
  let activeTunnel: ReturnType<typeof CloudflareTunnel.quick> | null = null;
  let stopping = false;

  const spawnOnce = () => {
    if (stopping) return;
    console.log('• Starting Cloudflare tunnel (URL appears in a few seconds)...');
    const t = CloudflareTunnel.quick(`http://localhost:${port}`);
    activeTunnel = t;
    t.on('url', (url: string) => {
      console.log();
      console.log(`✓ Cloudflare tunnel: ${url}`);
      console.log(`  (set NO_TUNNEL=1 to skip; press Ctrl-C to stop)`);
      console.log();
    });
    t.on('error', (err: Error) => {
      console.warn(`⚠ Cloudflare tunnel error: ${err.message}`);
    });
    t.on('exit', (code: number | null) => {
      if (stopping || code === 0 || code === null) return;
      if (restartCount >= RESTART_CAP) {
        console.warn(`⚠ Cloudflare tunnel exited (${code}) — giving up after ${RESTART_CAP} restarts. Local dev server keeps running; set NO_TUNNEL=1 next time to skip the tunnel entirely.`);
        // Latch stopping=true so any post-mortem events from the dead tunnel object are
        // ignored (otherwise a late 'error' emit can escape as unhandledRejection and
        // Node 18+ treats that as fatal — the dev server has died from this 3 sessions
        // running until 2026-05-02).
        stopping = true;
        return;
      }
      restartCount++;
      console.warn(`⚠ Cloudflare tunnel exited (${code}). Restarting (${restartCount}/${RESTART_CAP})...`);
      setTimeout(spawnOnce, 2000);
    });
  };
  spawnOnce();

  return () => {
    // Setting `stopping` first prevents the auto-restart from re-spawning during shutdown.
    stopping = true;
    try { activeTunnel?.stop(); } catch { /* already gone */ }
  };
}

startServer();
