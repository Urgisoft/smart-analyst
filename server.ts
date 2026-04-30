import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import { Tunnel as CloudflareTunnel, bin as cloudflaredBin } from "cloudflared";
import {
  fetchCandles,
  fetchTierTokens,
  fetchSymbols,
  fetchSolRegime,
  pingClickHouse,
  ensureBacktestTables,
  fetchStrategies,
  upsertStrategy,
  archiveStrategy,
  searchBacktestRuns,
  listSweeps,
  fetchBacktestFacets,
  type StrategyBundle,
  type BacktestSearchFilters,
} from "./src/server/clickhouse.js";

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
  app.use(express.json());

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
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(ok ? '✓ ClickHouse (quantlab) connection OK' : '⚠ ClickHouse unreachable — check .env and that quantlab-clickhouse is running');
    startCloudflareTunnel(PORT);
  });
}

/**
 * Spin up a Cloudflare Quick Tunnel so the dashboard is reachable from anywhere on the
 * internet without DNS / port-forwarding / accounts. Free, ephemeral URL on
 * `*.trycloudflare.com` — printed once the tunnel is connected.
 *
 * Skipped when NO_TUNNEL=1. Auto-restarts on unexpected exit (network blips, etc.).
 * Cleanly stopped on SIGINT/SIGTERM.
 */
function startCloudflareTunnel(port: number): void {
  if (process.env.NO_TUNNEL === '1') {
    console.log('• Cloudflare tunnel skipped (NO_TUNNEL=1). Run `npm run tunnel` manually if you need it.');
    return;
  }
  if (!cloudflaredBin || !existsSync(cloudflaredBin)) {
    console.warn(`⚠ Cloudflare tunnel binary not found at ${cloudflaredBin}. Skipping. Run \`npx cloudflared --version\` to trigger install.`);
    return;
  }

  let restartCount = 0;
  const RESTART_CAP = 5;
  let activeTunnel: ReturnType<typeof CloudflareTunnel.quick> | null = null;

  const spawnOnce = () => {
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
      if (code === 0 || code === null) return;
      if (restartCount >= RESTART_CAP) {
        console.warn(`⚠ Cloudflare tunnel exited (${code}) — giving up after ${RESTART_CAP} restarts.`);
        return;
      }
      restartCount++;
      console.warn(`⚠ Cloudflare tunnel exited (${code}). Restarting (${restartCount}/${RESTART_CAP})...`);
      setTimeout(spawnOnce, 2000);
    });
  };
  spawnOnce();

  const shutdown = () => {
    try { activeTunnel?.stop(); } catch { /* already gone */ }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);
}

startServer();
