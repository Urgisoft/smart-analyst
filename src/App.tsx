import { useState, useMemo, useEffect, useRef, useDeferredValue, ReactNode } from 'react';
import { 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip, 
  ResponsiveContainer, 
  AreaChart, 
  Area,
  ComposedChart,
  Bar,
  ReferenceLine,
  Cell,
  Scatter,
  Line,
  Brush,
  BarChart as ReBarChart
} from 'recharts';
import {
  TrendingUp,
  Zap,
  ShieldCheck,
  BarChart2,
  Database,
  Cpu,
  Layers,
  Search,
  Info,
  Clock,
  Settings2,
  Eye,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  calculateSqueeze, 
  generateMockCandles, 
  runParameterSweep,
  runMultiAssetBacktest,
  runStrategy,
  calculateChartIndicators,
  STRATEGIES,
  STRATEGY_DEFAULTS,
  STRATEGY_VARS,
  BACKTEST_SOURCE,
  DEFAULT_FEE_PCT_PER_SIDE,
  StrategyType,
  StrategyAdvancedCfg,
  Timeframe,
  Candle,
  BacktestResult
} from './lib/indicators';
import { useLivePrice } from './hooks/useLivePrice';
import { cn } from './lib/utils';
import { formatPct } from './lib/format';

interface AssetTier {
  id: string;
  name: string;
  category: 'vol' | 'beta' | 'mcap' | 'volume' | 'combo' | 'regime';
  description: string;
}

interface SolRegimeSnapshot { regime: 'bull' | 'bear' | 'sideways'; logReturn7d: number; }

interface AssetToken {
  symbol: string;
  name: string;
  address: string;
}

const PLACEHOLDER_TOKEN: AssetToken = { symbol: '...', name: 'Loading', address: '' };

type Period = '1W' | '1M' | '3M' | '6M' | '1Y' | 'ALL';
const PERIODS: Period[] = ['1W', '1M', '3M', '6M', '1Y', 'ALL'];

const TIER_CATEGORY_ORDER: Array<'vol' | 'beta' | 'mcap' | 'volume' | 'combo' | 'regime'> = ['regime', 'mcap', 'vol', 'beta', 'volume', 'combo'];
const TIER_CATEGORY_LABEL: Record<string, string> = {
  vol: 'Volatility',
  beta: 'Beta to SOL',
  mcap: 'Market Cap',
  volume: '24h Volume',
  combo: 'Combination',
  regime: 'SOL Regime (last 7d)',
};
function shortTierLabel(name: string, category: string): string {
  if (category === 'mcap') return name.replace(/\s*CAP\s*$/i, '');
  if (category === 'beta') return name.replace(/\s*BETA\s*$/i, '');
  if (category === 'vol' && / VOL$/i.test(name)) return name.replace(/\s*VOL\s*$/i, '');
  return name;
}

// Compute how many candles to request given a chart period and a timeframe.
// Server caps at 20000 — anything larger (e.g. 1Y of 5m) gets truncated to the
// most-recent 20K bars, which is the right behavior for "show me as much as you can".
const TIMEFRAME_MS: Record<string, number> = {
  '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000, '1d': 24 * 60 * 60_000,
};
const PERIOD_MS: Record<Period, number> = {
  '1W': 7 * 86_400_000,  '1M': 30 * 86_400_000,  '3M': 90 * 86_400_000,
  '6M': 180 * 86_400_000, '1Y': 365 * 86_400_000, 'ALL': Infinity,
};
const SERVER_CAP = 20000;
function computeCandleLimit(period: Period, timeframe: string): number {
  const tfMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS['1h'];
  if (period === 'ALL') return SERVER_CAP;
  return Math.min(SERVER_CAP, Math.max(50, Math.ceil(PERIOD_MS[period] / tfMs)));
}

const InfoTooltip = ({ content, children }: { content: string, children: ReactNode }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative inline-block" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      <AnimatePresence>
        {show && (
          <motion.div 
            initial={{ opacity: 0, y: 5, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.95 }}
            className="absolute left-full ml-2 top-0 z-50 w-48 p-3 bg-[#111] border border-[#222] rounded-xl shadow-2xl pointer-events-none"
          >
            <p className="text-[9px] leading-relaxed text-gray-400 font-medium">{content}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

import { TradingViewChart } from './components/TradingViewChart';

export default function App() {
  const [tiers, setTiers] = useState<AssetTier[]>([]);
  const [tierTokens, setTierTokens] = useState<AssetToken[]>([]);
  const [selectedTokenSpec, setSelectedTokenSpec] = useState<AssetToken>(PLACEHOLDER_TOKEN);
  const [solRegime, setSolRegime] = useState<SolRegimeSnapshot | null>(null);

  // Strategy Library — persisted bundles from quantlab.strategies. Loading a bundle copies
  // its config into the per-strategy state; saving captures the current state for the
  // active strategy as a new versioned bundle.
  interface PersistedBundle {
    bundleId: string; name: string; family: StrategyType;
    entryLogic: string; exitLogic: string;
    paramMin?: number; paramMax?: number; paramStep?: number;
    eMin?: number; eMax?: number; eStep?: number;
    xMin?: number; xMax?: number; xStep?: number;
    positionSizePct?: number | null; stopLossPct?: number | null; takeProfitPct?: number | null;
    feePctPerSide?: number; walkForward?: boolean; splitPct?: number;
    notes?: string; archived?: boolean;
    createdAt?: string; updatedAt?: string;
  }
  const [bundles, setBundles] = useState<PersistedBundle[]>([]);
  const [showSaveBundle, setShowSaveBundle] = useState(false);
  const [saveBundleId, setSaveBundleId] = useState('');
  const [saveBundleName, setSaveBundleName] = useState('');

  // ───── Phase 3 + 5: Pre-computed Backtest Results browser ─────
  // Filters the `bt_runs` table populated by the batch engine. Selecting a row loads the
  // token + restores the strategy/param so the chart panel re-runs that exact backtest.
  // Phase 5 adds OOS columns — when split_pct > 0 each row carries train (IS) AND test (OOS) metrics.
  interface BacktestRunRow {
    sweep_id: string; started_at: string; symbol: string; token_address: string; tier: string;
    strategy_type: string; entry_logic: string; exit_logic: string; param: number; interval: string;
    initial_capital: number; fee_pct_per_side: number;
    net_profit: number; net_profit_pct: number;
    gross_profit: number; gross_loss: number;
    profit_factor: number; win_rate: number; trades: number; sharpe_ratio: number;
    split_pct: number;
    oos_net_profit: number; oos_net_profit_pct: number; oos_profit_factor: number;
    oos_win_rate: number; oos_trades: number; oos_sharpe_ratio: number;
    data_span_days: number;
  }
  interface SearchFacets { strategies: string[]; tiers: string[]; intervals: string[]; }
  const [searchFacets, setSearchFacets] = useState<SearchFacets>({ strategies: [], tiers: [], intervals: [] });
  const [searchResults, setSearchResults] = useState<BacktestRunRow[]>([]);
  // The bt_runs row the user most recently clicked on. Drives the right-side "Selected Run"
  // detail panel so the user can see which row they're inspecting alongside the filter aggregate.
  // Cleared when filters change (the row may no longer match the new filter).
  const [selectedSearchRow, setSelectedSearchRow] = useState<BacktestRunRow | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Filter state — kept simple because the dataset is already small enough that we can re-query on every change.
  const [filterStrategy, setFilterStrategy] = useState<string>('');   // empty = any
  const [filterTier, setFilterTier] = useState<string>('');           // empty = any
  const [filterInterval, setFilterInterval] = useState<string>('');   // empty = any
  const [filterMinNetPct, setFilterMinNetPct] = useState<number>(0);
  const [filterMinPf, setFilterMinPf] = useState<number>(0);
  // Default 10. Bumped from 5 because thin memecoin tokens routinely show ridiculous PF=∞ /
  // 100% win-rate results from 2-3 trades — pure noise, not a real edge. Anything below ~10
  // trades has too much variance to trust. Set to 0 in the UI to see everything (incl. noise).
  const [filterMinTrades, setFilterMinTrades] = useState<number>(10);
  const [filterSymbolLike, setFilterSymbolLike] = useState<string>('');
  type SortField =
    | 'net_profit_pct' | 'profit_factor' | 'sharpe_ratio' | 'win_rate' | 'trades'
    | 'oos_net_profit_pct' | 'oos_profit_factor' | 'oos_sharpe_ratio' | 'oos_win_rate' | 'oos_trades';
  const [filterSortBy, setFilterSortBy] = useState<SortField>('net_profit_pct');
  const [filterBestPerToken, setFilterBestPerToken] = useState<boolean>(true);
  const [showBrowsePanel, setShowBrowsePanel] = useState<boolean>(true);
  // Phase 5 OOS filters — independent of IS thresholds. When `oosOnly` is on, rows with
  // split_pct=0 (no walk-forward run) get hidden via minOosTrades>0 default.
  const [filterMinOosNetPct, setFilterMinOosNetPct] = useState<number>(0);
  const [filterMinOosPf, setFilterMinOosPf] = useState<number>(0);
  const [filterMinOosTrades, setFilterMinOosTrades] = useState<number>(0);
  // Default 90 days = 3 months. Below this, regime + survivorship bias make backtest metrics
  // unreliable. Set to 0 to disable. data_span_days=0 (legacy rows) always pass through.
  const [filterMinDataSpanDays, setFilterMinDataSpanDays] = useState<number>(90);
  const [showOosColumns, setShowOosColumns] = useState<boolean>(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean>(false);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyType>('momentum');
  const [strategyParam, setStrategyParam] = useState(14);
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>('1h');
  const [selectedPeriod, setSelectedPeriod] = useState<Period>('3M');
  const [chartType, setChartType] = useState<'line' | 'candle'>('candle');
  const [selectedIndicators, setSelectedIndicators] = useState<string[]>(['EMA20', 'MBias']);
  const [isDataLoading, setIsDataLoading] = useState(false);

  const INDICATORS = [
    { id: 'EMA20', name: 'EMA 20', color: 'text-yellow-400' },
    { id: 'EMA50', name: 'EMA 50', color: 'text-blue-400' },
    { id: 'BB', name: 'Bollinger Bands', color: 'text-purple-400' },
    { id: 'MBias', name: 'Momentum Bias', color: 'text-emerald-400' },
    { id: 'VOL', name: 'Volume', color: 'text-gray-400' },
  ];
  const [sweepStart, setSweepStart] = useState(5);
  const [sweepEnd, setSweepEnd] = useState(50);
  const [sweepStep, setSweepStep] = useState(5);
  // Per-strategy editable code, initialized from defaults. Editing any field overrides the
  // built-in implementation for that strategy ID, since runStrategy now routes anything with
  // a non-empty entry/exit through runCustomBacktest.
  const [strategyCode, setStrategyCode] = useState<Record<StrategyType, { entry: string; exit: string }>>(STRATEGY_DEFAULTS);
  const setStrategyEntry = (id: StrategyType, entry: string) =>
    setStrategyCode(prev => ({ ...prev, [id]: { ...prev[id], entry } }));
  const setStrategyExit = (id: StrategyType, exit: string) =>
    setStrategyCode(prev => ({ ...prev, [id]: { ...prev[id], exit } }));
  const resetStrategyCode = (id: StrategyType) =>
    setStrategyCode(prev => ({ ...prev, [id]: STRATEGY_DEFAULTS[id] }));
  const isStrategyEdited = (id: StrategyType) =>
    strategyCode[id].entry !== STRATEGY_DEFAULTS[id].entry || strategyCode[id].exit !== STRATEGY_DEFAULTS[id].exit;

  // Per-strategy threshold sweep config. When enabled and the user's code uses $E / $X
  // placeholders, the parameter_distribution chart explores the (param × $E × $X) grid
  // and reports the BEST combo per param value, plus the global argmax.
  interface SweepCfg { enabled: boolean; eMin: number; eMax: number; eStep: number; xMin: number; xMax: number; xStep: number; }
  const SWEEP_DEFAULT: SweepCfg = { enabled: false, eMin: 30, eMax: 70, eStep: 5, xMin: 20, xMax: 60, xStep: 5 };
  const [strategySweep, setStrategySweep] = useState<Record<StrategyType, SweepCfg>>({
    momentum: SWEEP_DEFAULT, mean_reversion: SWEEP_DEFAULT, trend_following: SWEEP_DEFAULT, custom: SWEEP_DEFAULT,
  });

  // Per-strategy advanced controls — opt-in. When `enabled` is false we pass `undefined` to
  // the engine so behavior is identical to the simple all-in / signal-only model.
  interface AdvancedCfgUI extends StrategyAdvancedCfg { enabled: boolean; }
  const ADVANCED_DEFAULT: AdvancedCfgUI = { enabled: false, positionSizePct: 100, stopLossPct: 0, takeProfitPct: 0 };
  const [strategyAdvanced, setStrategyAdvanced] = useState<Record<StrategyType, AdvancedCfgUI>>({
    momentum: ADVANCED_DEFAULT, mean_reversion: ADVANCED_DEFAULT, trend_following: ADVANCED_DEFAULT, custom: ADVANCED_DEFAULT,
  });
  const updateAdvancedCfg = (id: StrategyType, patch: Partial<AdvancedCfgUI>) =>
    setStrategyAdvanced(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  // The cfg actually fed to the engine — strip the `enabled` wrapper, return undefined when off.
  const advancedCfg: StrategyAdvancedCfg | undefined = useMemo(() => {
    const a = strategyAdvanced[selectedStrategy];
    if (!a.enabled) return undefined;
    return { positionSizePct: a.positionSizePct, stopLossPct: a.stopLossPct, takeProfitPct: a.takeProfitPct };
  }, [strategyAdvanced, selectedStrategy]);
  const updateSweepCfg = (id: StrategyType, patch: Partial<SweepCfg>) =>
    setStrategySweep(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const sweepCfg = strategySweep[selectedStrategy];

  // Substitute $E / $X placeholders in strategy code with concrete numbers.
  const sub = (logic: string, e: number, x: number): string =>
    logic.replace(/\$E\b/g, String(e)).replace(/\$X\b/g, String(x));

  // Live-backtest entry/exit always have placeholders substituted with the mid-range default.
  // Without this, an unsubstituted `$E` makes the eval engine throw and silently produce
  // zero trades for everything (which is the "why do I see zero" bug).
  const midE = (sweepCfg.eMin + sweepCfg.eMax) / 2;
  const midX = (sweepCfg.xMin + sweepCfg.xMax) / 2;
  const rawEntry = strategyCode[selectedStrategy].entry;
  const rawExit  = strategyCode[selectedStrategy].exit;
  const customEntry = sub(rawEntry, midE, midX);
  const customExit  = sub(rawExit,  midE, midX);
  const codeHasPlaceholders = /\$E\b|\$X\b/.test(rawEntry + rawExit);

  // Build the value lists for a sweep range, clamped to a sane size (max 12 steps each).
  const rangeValues = (min: number, max: number, step: number): number[] => {
    if (step <= 0 || max < min) return [min];
    const vals: number[] = [];
    for (let v = min; v <= max && vals.length < 12; v += step) vals.push(Number(v.toFixed(4)));
    return vals;
  };
  const [initialCapital, setInitialCapital] = useState(10000);
  
  const [isIndicatorMenuOpen, setIsIndicatorMenuOpen] = useState(false);

  // Expand any of the four main dashboard panels into a fullscreen overlay so the user can
  // study charts / logs at full resolution. Esc or the minimize icon collapses back. Only
  // ONE panel can be expanded at a time.
  type ExpandablePanel = 'chart' | 'leaderboard' | 'paramdist';
  const [expandedPanel, setExpandedPanel] = useState<ExpandablePanel | null>(null);
  useEffect(() => {
    if (!expandedPanel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expandedPanel]);
  // Class helper: when the panel is expanded, swap normal grid sizing for a fixed full-screen
  // overlay; otherwise return the original layout class string. Wrapping in a function keeps
  // each panel's JSX site short and consistent.
  const panelExpandClass = (id: ExpandablePanel, base: string): string =>
    expandedPanel === id
      ? `fixed inset-3 z-40 ${base.replace(/flex-\[[^\]]+\]\s*/g, '').replace(/min-h-\[[^\]]+\]\s*/g, '')}`
      : base;
  const ExpandToggle = ({ id, className }: { id: ExpandablePanel; className?: string }) => (
    <button
      onClick={() => setExpandedPanel(curr => curr === id ? null : id)}
      title={expandedPanel === id ? 'Collapse (Esc)' : 'Expand to fullscreen'}
      className={cn(
        "p-1 rounded-md text-gray-600 hover:text-yellow-400 hover:bg-white/5 transition-colors",
        className
      )}
    >
      {expandedPanel === id ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
    </button>
  );
  const [selectedTiers, setSelectedTiers] = useState<string[]>(['vol_high', 'beta_high']);
  const [perTier, setPerTier] = useState(30);
  const [feePctPerSide, setFeePctPerSide] = useState(DEFAULT_FEE_PCT_PER_SIDE);
  const [minAgeDays, setMinAgeDays] = useState(14);
  const [maxStaleDays, setMaxStaleDays] = useState(14);
  const [showQualityFilters, setShowQualityFilters] = useState(false);
  const [showBacktestSource, setShowBacktestSource] = useState(false);
  // Walk-forward: train on first 70% of each token's candles, eval on last 30%.
  // The sweep finds best params on train; the OOS panel shows what they'd produce on test.
  const [walkForwardEnabled, setWalkForwardEnabled] = useState(false);
  const deferredSweepStart = useDeferredValue(sweepStart);
  const deferredSweepEnd = useDeferredValue(sweepEnd);
  const deferredSweepStep = useDeferredValue(sweepStep);

  const handleCapitalChange = (val: number) => {
    const safeVal = Math.max(100, Math.min(1000000, val));
    setInitialCapital(safeVal);
  };

  const handleParamChange = (val: number) => {
    const safeVal = Math.max(2, Math.min(500, val));
    setStrategyParam(safeVal);
  };
  
  const { price: wsPrice } = useLivePrice(selectedTokenSpec.symbol);
  const [history, setHistory] = useState<Candle[]>([]);
  
  const livePrice = useMemo(() => {
    if (wsPrice > 0) return wsPrice;
    if (history.length > 0) return history[history.length - 1].close;
    return 0;
  }, [wsPrice, history]);

  const [tierData, setTierData] = useState<{ symbol: string, candles: Candle[] }[]>([]);

  // Load tier list once (definitions are static)
  useEffect(() => {
    fetch('/api/tiers')
      .then(r => r.json())
      .then((data: AssetTier[]) => setTiers(data))
      .catch(err => console.error('Failed to load tiers:', err));
  }, []);

  const refreshBundles = () => {
    fetch('/api/strategies', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: PersistedBundle[]) => setBundles(Array.isArray(data) ? data : []))
      .catch(err => console.error('Failed to load strategy bundles:', err));
  };
  useEffect(() => { refreshBundles(); }, []);

  // Apply a saved bundle to the active strategy state — copies entry/exit, advanced cfg,
  // sweep ranges, lookback window, fee, and walk-forward toggle. Also switches the editor
  // to the bundle's family.
  const loadBundle = (b: PersistedBundle) => {
    setSelectedStrategy(b.family);
    setStrategyCode(prev => ({ ...prev, [b.family]: { entry: b.entryLogic, exit: b.exitLogic } }));
    setStrategyAdvanced(prev => ({
      ...prev,
      [b.family]: {
        enabled: b.positionSizePct != null || b.stopLossPct != null || b.takeProfitPct != null,
        positionSizePct: b.positionSizePct ?? 100,
        stopLossPct: b.stopLossPct ?? 0,
        takeProfitPct: b.takeProfitPct ?? 0,
      }
    }));
    setStrategySweep(prev => ({
      ...prev,
      [b.family]: {
        enabled: ((b.eMax ?? 0) > (b.eMin ?? 0)) || ((b.xMax ?? 0) > (b.xMin ?? 0)),
        eMin: b.eMin ?? 30, eMax: b.eMax ?? 70, eStep: b.eStep ?? 5,
        xMin: b.xMin ?? 20, xMax: b.xMax ?? 60, xStep: b.xStep ?? 5,
      }
    }));
    if (b.paramMin) setSweepStart(b.paramMin);
    if (b.paramMax) setSweepEnd(b.paramMax);
    if (b.paramStep) setSweepStep(b.paramStep);
    if (b.feePctPerSide != null) setFeePctPerSide(b.feePctPerSide);
    setWalkForwardEnabled(!!b.walkForward);
  };

  // Capture the current strategy's config as a new (or replacement) bundle in the registry.
  const saveCurrentAsBundle = async () => {
    if (!saveBundleId || !saveBundleName) return;
    const adv = strategyAdvanced[selectedStrategy];
    const sw  = strategySweep[selectedStrategy];
    const payload: PersistedBundle = {
      bundleId: saveBundleId,
      name: saveBundleName,
      family: selectedStrategy,
      entryLogic: strategyCode[selectedStrategy].entry,
      exitLogic:  strategyCode[selectedStrategy].exit,
      paramMin: sweepStart, paramMax: sweepEnd, paramStep: sweepStep,
      eMin: sw.enabled ? sw.eMin : 0, eMax: sw.enabled ? sw.eMax : 0, eStep: sw.enabled ? sw.eStep : 0,
      xMin: sw.enabled ? sw.xMin : 0, xMax: sw.enabled ? sw.xMax : 0, xStep: sw.enabled ? sw.xStep : 0,
      positionSizePct: adv.enabled ? adv.positionSizePct ?? null : null,
      stopLossPct:     adv.enabled ? adv.stopLossPct     ?? null : null,
      takeProfitPct:   adv.enabled ? adv.takeProfitPct   ?? null : null,
      feePctPerSide: feePctPerSide,
      walkForward: walkForwardEnabled,
      splitPct: 70,
    };
    try {
      const r = await fetch('/api/strategies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setShowSaveBundle(false);
      setSaveBundleId(''); setSaveBundleName('');
      refreshBundles();
    } catch (e) {
      alert(`Save failed: ${(e as Error).message}`);
    }
  };

  const archiveBundle = async (id: string) => {
    if (!confirm(`Archive bundle "${id}"? It stays in history but won't show in the active list.`)) return;
    try {
      const r = await fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      refreshBundles();
    } catch (e) {
      alert(`Archive failed: ${(e as Error).message}`);
    }
  };

  // Load filter facets once. `bt_runs` may be empty on a fresh install — facets just stay empty
  // and the dropdowns become inert until the user runs the batch engine.
  useEffect(() => {
    fetch('/api/backtest/facets', { cache: 'no-store' })
      .then(r => r.json())
      .then((f: SearchFacets) => setSearchFacets(f))
      .catch(err => console.warn('facets load failed:', err));
  }, []);

  // Re-query bt_runs whenever any filter changes. Debounced via cleanup so rapid slider drags
  // don't hammer the server. Each in-flight query is racing the next, so check `cancelled`
  // before applying results.
  useEffect(() => {
    const params = new URLSearchParams();
    if (filterStrategy)   params.set('strategyType', filterStrategy);
    if (filterTier)       params.set('tier', filterTier);
    if (filterInterval)   params.set('interval', filterInterval);
    if (filterSymbolLike) params.set('symbolLike', filterSymbolLike);
    if (filterMinNetPct)     params.set('minNetPct', String(filterMinNetPct));
    if (filterMinPf)         params.set('minProfitFactor', String(filterMinPf));
    if (filterMinTrades)     params.set('minTrades', String(filterMinTrades));
    if (filterMinOosNetPct)  params.set('minOosNetPct', String(filterMinOosNetPct));
    if (filterMinOosPf)      params.set('minOosProfitFactor', String(filterMinOosPf));
    if (filterMinOosTrades)  params.set('minOosTrades', String(filterMinOosTrades));
    if (filterMinDataSpanDays) params.set('minDataSpanDays', String(filterMinDataSpanDays));
    params.set('sortBy', filterSortBy);
    params.set('sortDir', 'desc');
    params.set('limit', '200');
    if (filterBestPerToken) params.set('bestPerToken', 'true');

    let cancelled = false;
    const t = setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      fetch(`/api/backtest/search?${params.toString()}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : r.json().then((j: any) => Promise.reject(new Error(j.error ?? `HTTP ${r.status}`))))
        .then((rows: BacktestRunRow[]) => {
          if (cancelled) return;
          const list = Array.isArray(rows) ? rows : [];
          setSearchResults(list);
          // If the previously-selected row isn't in the new filter set, drop it so the
          // "Selected Run" panel doesn't show a row the user can no longer see in the list.
          setSelectedSearchRow(prev => {
            if (!prev) return null;
            return list.find(r => r.token_address === prev.token_address && r.param === prev.param && r.strategy_type === prev.strategy_type && r.interval === prev.interval) ?? null;
          });
          setSearchLoading(false);
        })
        .catch(err => {
          if (cancelled) return;
          setSearchError(err.message ?? 'search failed');
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filterStrategy, filterTier, filterInterval, filterSymbolLike, filterMinNetPct, filterMinPf, filterMinTrades, filterMinOosNetPct, filterMinOosPf, filterMinOosTrades, filterMinDataSpanDays, filterSortBy, filterBestPerToken]);

  // Apply a backtest result row to the live editor: load the token, copy entry/exit, set lookback
  // param, and (if a matching bundle exists) the rest of the bundle's config too.
  const applyBacktestRow = (row: BacktestRunRow) => {
    setSelectedSearchRow(row);
    setSelectedTokenSpec({ symbol: row.symbol, name: row.symbol, address: row.token_address });
    setStrategyParam(row.param);
    if (row.interval) setSelectedTimeframe(row.interval as Timeframe);
    // strategy_type may be a built-in family OR a bundle_id. Resolve.
    const knownFamilies: StrategyType[] = ['momentum', 'mean_reversion', 'trend_following', 'custom'];
    if (knownFamilies.includes(row.strategy_type as StrategyType)) {
      const fam = row.strategy_type as StrategyType;
      setSelectedStrategy(fam);
      setStrategyCode(prev => ({ ...prev, [fam]: { entry: row.entry_logic, exit: row.exit_logic } }));
    } else {
      const bundle = bundles.find(b => b.bundleId === row.strategy_type);
      if (bundle) {
        loadBundle(bundle);
      } else {
        // Unknown bundle (maybe archived) — fall back to custom + entry/exit code from the row itself.
        setSelectedStrategy('custom');
        setStrategyCode(prev => ({ ...prev, custom: { entry: row.entry_logic, exit: row.exit_logic } }));
      }
    }
  };

  // Poll SOL regime every 60s — cheap query, surfaces market context to the user.
  useEffect(() => {
    let cancelled = false;
    const fetchRegime = () => {
      fetch('/api/sol-regime', { cache: 'no-store' })
        .then(r => r.json())
        .then((s: SolRegimeSnapshot) => { if (!cancelled) setSolRegime(s); })
        .catch(() => { /* keep last known value */ });
    };
    fetchRegime();
    const t = setInterval(fetchRegime, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Group tiers by category for the sidebar render
  const groupedTiers = useMemo(() => {
    const g: Record<string, AssetTier[]> = {};
    for (const t of tiers) (g[t.category] ||= []).push(t);
    return g;
  }, [tiers]);

  // Load tokens whenever the selected tier set OR timeframe changes.
  // No client-side caching — server sends `Cache-Control: no-store`, fetch with `cache: 'no-store'`.
  // This means clicking a tier always re-queries ClickHouse, so newly-ingested data shows up immediately.
  useEffect(() => {
    if (selectedTiers.length === 0) {
      setTierTokens([]);
      setSelectedTokenSpec(PLACEHOLDER_TOKEN);
      return;
    }
    let cancelled = false;
    const url = `/api/tokens?tiers=${encodeURIComponent(selectedTiers.join(','))}&perTier=${perTier}&interval=${selectedTimeframe}&minAgeDays=${minAgeDays}&maxStaleDays=${maxStaleDays}`;
    fetch(url, { cache: 'no-store' })
      .then(r => r.json())
      .then((rows: any[]) => {
        if (cancelled) return;
        const toks: AssetToken[] = rows.map(r => ({
          symbol: r.symbol,
          name: r.symbol,
          address: r.token_address,
        }));
        setTierTokens(toks);
        // Keep current selection if still present in the universe.
        // If the user actively chose a token (non-placeholder address) that's NOT in the new
        // interval's universe — e.g. they had PENGU @ 1H selected and switched to 4H where
        // PENGU has no candles — STAY on it anyway. The chart will render its "no data for
        // this interval" state, which is more honest than silently snapping to an unrelated
        // token. Only snap when the current selection is the placeholder (first paint).
        setSelectedTokenSpec(prev => {
          const stillThere = toks.find(t => t.address === prev.address);
          if (stillThere) return stillThere;
          if (prev.address) return prev;            // user chose this; keep it
          return toks[0] ?? PLACEHOLDER_TOKEN;      // first paint → snap to first available
        });
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load tier tokens:', err);
        setTierTokens([]);
      });
    return () => { cancelled = true; };
  }, [selectedTiers, selectedTimeframe, perTier, minAgeDays, maxStaleDays]);

  // Load OHLCV for every token in the current tier — feeds the tier-level portfolio chart.
  // History (the chart) is loaded by a SEPARATE effect below so a leaderboard click on a
  // different-tier token still updates the chart.
  useEffect(() => {
    if (tierTokens.length === 0) {
      setTierData([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsDataLoading(true);
      const data = await Promise.all(tierTokens.map(async t => {
        try {
          const r = await fetch(`/api/candles?token=${encodeURIComponent(t.address)}&interval=${selectedTimeframe}&limit=2000`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const candles = await r.json() as Candle[];
          if (!Array.isArray(candles) || candles.length < 50) {
            return { symbol: t.symbol, candles: generateMockCandles(150, 2.0, selectedTimeframe) };
          }
          return { symbol: t.symbol, candles };
        } catch {
          return { symbol: t.symbol, candles: generateMockCandles(150, 2.0, selectedTimeframe) };
        }
      }));
      if (cancelled) return;
      setTierData(data);
      setIsDataLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tierTokens, selectedTimeframe]);

  // Load history (the chart's candles) directly from the selected token's mint address.
  // Independent of tierData so a leaderboard click works even across tiers.
  useEffect(() => {
    if (!selectedTokenSpec.address) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const limit = computeCandleLimit(selectedPeriod, selectedTimeframe);
      try {
        const r = await fetch(`/api/candles?token=${encodeURIComponent(selectedTokenSpec.address)}&interval=${selectedTimeframe}&limit=${limit}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const candles = await r.json() as Candle[];
        if (cancelled) return;
        // Show real data when present; otherwise leave the chart EMPTY. The previous code
        // silently swapped real-but-short history (and outright-empty responses) for synthetic
        // mock candles, which made the chart show fake price action — confusingly, you'd see
        // "candles" for an interval the token has no data on. The empty state is the honest
        // signal that this token has no candles at this interval; the data-coverage banner
        // explains the gap.
        setHistory(Array.isArray(candles) ? candles : []);
      } catch {
        if (!cancelled) setHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTokenSpec.address, selectedTimeframe, selectedPeriod]);

  // Combined Portfolio Results — backtest of the CURRENTLY VIEWED tier
  const portfolio = useMemo(() => {
    if (tierData.length === 0) return null;
    return runMultiAssetBacktest(tierData, selectedStrategy, strategyParam, customEntry, customExit, initialCapital, feePctPerSide, advancedCfg);
  }, [tierData, selectedStrategy, strategyParam, customEntry, customExit, initialCapital, feePctPerSide, advancedCfg]);

  // Headline cards reflect the current-tier portfolio (the live in-app calc on tierData).
  // The previous in-app server sweep was retired — use `npm run backtest` for cross-tier scans.
  const headline = useMemo(() => {
    if (portfolio) {
      return {
        netProfit: portfolio.aggregated.netProfit,
        winRate: portfolio.aggregated.winRate,
        profitFactor: portfolio.aggregated.profitFactor,
        source: `${tierData.length} assets (tier)`,
      };
    }
    return { netProfit: 0, winRate: 0, profitFactor: 1, source: '—' };
  }, [portfolio, tierData.length]);

  const fmtPF = (pf: number) => Number.isFinite(pf) ? pf.toFixed(2) : '∞';

  // Aggregate the current Backtest Library filter result. Updates whenever filters change
  // (since `searchResults` does), so the right-side panel reflects filter edits in real time
  // without the user needing to click a row first.
  // Aggregation rules:
  //   - net %  → trade-weighted mean (Σ net_pct·trades / Σ trades). Equal-weight average is
  //              skewed by tokens with a couple of trades each.
  //   - PF     → Σ gross_profit / Σ gross_loss. Mathematically the only correct way to combine
  //              PF across runs; averaging per-row PFs is meaningless across different sample sizes.
  //   - win %  → trade-weighted (Σ wins / Σ trades).
  //   - param distribution → count of rows per `param` value, sorted ascending. Surfaces which
  //              lookbacks dominate the filtered set so the user can tell whether the filter is
  //              picking up a real edge or just one over-fit param value.
  const searchAggregate = useMemo(() => {
    if (!searchResults || searchResults.length === 0) return null;
    const n = searchResults.length;
    const tokens = new Set(searchResults.map(r => r.token_address)).size;
    const totalTrades = searchResults.reduce((s, r) => s + (Number(r.trades) || 0), 0);
    const totalWins   = searchResults.reduce((s, r) => s + ((Number(r.win_rate) || 0) / 100) * (Number(r.trades) || 0), 0);
    const totalGrossProfit = searchResults.reduce((s, r) => s + (Number(r.gross_profit) || 0), 0);
    const totalGrossLoss   = searchResults.reduce((s, r) => s + (Number(r.gross_loss) || 0), 0);
    const weightedNetPctNum = searchResults.reduce((s, r) => s + (Number(r.net_profit_pct) || 0) * (Number(r.trades) || 0), 0);
    const netPctWeighted = totalTrades > 0 ? weightedNetPctNum / totalTrades : 0;
    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const profitFactor = totalGrossLoss > 0
      ? totalGrossProfit / totalGrossLoss
      : (totalGrossProfit > 0 ? Infinity : 1.0);
    const paramHist = new Map<number, number>();
    for (const r of searchResults) {
      const p = Number(r.param);
      paramHist.set(p, (paramHist.get(p) ?? 0) + 1);
    }
    const paramDist = [...paramHist.entries()].sort((a, b) => a[0] - b[0]).map(([param, count]) => ({ param, count }));
    return { n, tokens, totalTrades, netPctWeighted, winRate, profitFactor, paramDist };
  }, [searchResults]);

  // Walk-forward split: when enabled, slice each token's candles 70/30. The sweep finds best
  // params on the train slice; we then evaluate the same params on the test slice to surface
  // out-of-sample stats. This is the structural fix for the threshold-sweep overfit risk.
  const SPLIT = 0.7;
  const tierDataTrain = useMemo(() => {
    if (!walkForwardEnabled) return tierData;
    return tierData.map(a => ({ symbol: a.symbol, candles: a.candles.slice(0, Math.floor(a.candles.length * SPLIT)) }));
  }, [tierData, walkForwardEnabled]);
  const tierDataTest = useMemo(() => {
    if (!walkForwardEnabled) return [] as typeof tierData;
    return tierData.map(a => ({ symbol: a.symbol, candles: a.candles.slice(Math.floor(a.candles.length * SPLIT)) }));
  }, [tierData, walkForwardEnabled]);

  // Parameter Sweep — runs in a Web Worker so heavy threshold grids don't freeze the UI.
  // Results land via `setSweep`. Stale jobs (when inputs change mid-flight) are dropped
  // via jobId comparison.
  const [sweep, setSweep] = useState<any[]>([]);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepMs, setSweepMs] = useState<number | null>(null);
  const sweepWorkerRef = useRef<Worker | null>(null);
  const sweepJobIdRef = useRef(0);

  // Spin the worker up once, tear down on unmount.
  useEffect(() => {
    const w = new Worker(new URL('./workers/sweepWorker.ts', import.meta.url), { type: 'module' });
    sweepWorkerRef.current = w;
    w.onmessage = (e: MessageEvent<{ jobId: number; results: any[]; ms: number }>) => {
      // Drop stale responses — if the user changed inputs while a job was running, we already
      // queued a newer one and only its result should land in state.
      if (e.data.jobId !== sweepJobIdRef.current) return;
      setSweep(e.data.results);
      setSweepMs(e.data.ms);
      setSweepBusy(false);
    };
    return () => { w.terminate(); sweepWorkerRef.current = null; };
  }, []);

  // Whenever any sweep input changes, post a fresh job to the worker. Each effect run
  // increments jobId so older in-flight results are ignored when they arrive.
  useEffect(() => {
    const data = walkForwardEnabled ? tierDataTrain : tierData;
    if (data.length === 0) { setSweep([]); setSweepBusy(false); return; }
    const periods: number[] = [];
    for (let i = Math.max(2, deferredSweepStart); i <= Math.min(500, deferredSweepEnd); i += Math.max(1, deferredSweepStep)) {
      periods.push(i);
    }
    if (periods.length === 0) { setSweep([]); setSweepBusy(false); return; }

    const usesPlaceholders = /\$E\b|\$X\b/.test(customEntry + customExit);
    const grid = sweepCfg.enabled && usesPlaceholders
      ? { eVals: rangeValues(sweepCfg.eMin, sweepCfg.eMax, sweepCfg.eStep), xVals: rangeValues(sweepCfg.xMin, sweepCfg.xMax, sweepCfg.xStep) }
      : undefined;

    const jobId = ++sweepJobIdRef.current;
    setSweepBusy(true);
    sweepWorkerRef.current?.postMessage({
      jobId, tierData: data, strategy: selectedStrategy, periods,
      customEntry, customExit, initialCapital, feePctPerSide,
      advanced: advancedCfg, grid,
    });
  }, [tierData, tierDataTrain, walkForwardEnabled, selectedStrategy, customEntry, customExit,
      deferredSweepStart, deferredSweepEnd, deferredSweepStep,
      initialCapital, sweepCfg, feePctPerSide, advancedCfg]);

  // Find the global best combo from the sweep (for the "Adopt best" button)
  const sweepBest = useMemo(() => {
    if (sweep.length === 0) return null;
    return sweep.reduce((b: any, r: any) => (r.avgNetProfit > b.avgNetProfit ? r : b), sweep[0]);
  }, [sweep]);

  // Out-of-sample evaluation — apply the train-best combo to the held-out test slice.
  // If OOS performance collapses, the in-sample win was overfit.
  const sweepBestOOS = useMemo(() => {
    if (!walkForwardEnabled || !sweepBest || tierDataTest.length === 0) return null;
    const e = sweepBest.bestE, x = sweepBest.bestX;
    const entry = e !== undefined && x !== undefined ? sub(customEntry, e, x) : customEntry;
    const exit  = e !== undefined && x !== undefined ? sub(customExit,  e, x) : customExit;
    const bt = runMultiAssetBacktest(
      tierDataTest, selectedStrategy, sweepBest.parameter, entry, exit, initialCapital, feePctPerSide, advancedCfg
    );
    return {
      netProfit: bt.aggregated.netProfit,
      winRate: bt.aggregated.winRate,
      profitFactor: bt.aggregated.profitFactor,
      trades: bt.aggregated.totalTrades,
    };
  }, [walkForwardEnabled, sweepBest, tierDataTest, selectedStrategy, customEntry, customExit, initialCapital, feePctPerSide, advancedCfg]);

  const cohorts = useMemo(() => {
    if (!portfolio?.perAsset) return { winners: [], middles: [], losers: [] };
    // Bucket only assets that ACTUALLY traded. A non-firing token has netProfit=0 and would
    // otherwise pollute "middles" (within ±2%), making a 5-winner-of-5-active tier read as
    // "5 winners, 25 middles, 0 losers" on a 30-token pool — the per-token edge concentration
    // gets buried.
    return portfolio.perAsset.reduce((acc: any, asset: any) => {
      if (!asset.trades) return acc;
      const perfPct = (asset.netProfit / initialCapital) * 100;
      if (perfPct > 2) acc.winners.push(asset);
      else if (perfPct < -2) acc.losers.push(asset);
      else acc.middles.push(asset);
      return acc;
    }, { winners: [], middles: [], losers: [] });
  }, [portfolio, initialCapital]);

  const chartData = useMemo(() => {
    if (history.length === 0) return [];
    // Below 50 bars indicators / backtest can't run meaningfully — but we STILL want the raw
    // candles to render so the user sees actual price action for thin tokens. The chart UI
    // surfaces the coverage gap via the dataCoverage banner below.
    const tooThin = history.length < 50;
    const sqzData = tooThin ? [] : calculateSqueeze(history);
    const bt = tooThin
      ? null
      : runStrategy(selectedStrategy, history, initialCapital, selectedTokenSpec.symbol, strategyParam, customEntry, customExit, feePctPerSide, advancedCfg);

    // Indicators need warmup bars. EMA20 → 20, EMA50 → 50, BB(20) → 20. If we don't have
    // enough history, just leave them undefined per row — the chart series filter drops them.
    const enoughForEma20 = history.length >= 20;
    const enoughForEma50 = history.length >= 50;
    const enoughForBb    = history.length >= 20;
    const { ema20, ema50, bb } = enoughForEma20 || enoughForEma50 || enoughForBb
      ? calculateChartIndicators(history)
      : { ema20: [], ema50: [], bb: [] };

    return history.map((h, i) => {
      const tradeAtTime = bt?.trades.find(t => t.time === h.time);

      const res: any = {
        ...h,
        bodyRange: [h.open, h.close],
        wickRange: [h.low, h.high],
        momentum: sqzData[i]?.momentum || 0,
        sqzColor: sqzData[i]?.isSqueezed ? "#ef4444" : "#22c55e",
        equity: bt?.equity[i] ?? initialCapital,
        tradePrice: tradeAtTime?.price,
        tradeType: tradeAtTime?.type,
        tradePnl: tradeAtTime?.pnlPercent
      };

      if (enoughForEma20 && i >= 19) res.ema20 = ema20[i - 19];
      if (enoughForEma50 && i >= 49) res.ema50 = ema50[i - 49];
      if (enoughForBb    && i >= 19) {
        const b = bb[i - 19];
        if (b) {
          res.bbUpper = b.upper;
          res.bbLower = b.lower;
          res.bbMiddle = b.middle;
        }
      }
      return res;
    });
  }, [history, initialCapital, selectedTokenSpec, selectedStrategy, strategyParam, customEntry, customExit, feePctPerSide, advancedCfg]);

  // Coverage report shown as a chip in the chart header — surfaces token data span so the
  // user knows when "ALL" really means "what little this memecoin has". Most Solana memecoins
  // are pump.fun launches that didn't exist 6 months ago — Jupiter has no older data because
  // there was no token to price. The chip is colored based on coverage adequacy.
  const dataCoverage = useMemo(() => {
    if (history.length === 0) return { hasData: false, daysCovered: 0, isShort: false, isVeryShort: false };
    const first = history[0]?.time ?? 0;
    const last = history[history.length - 1]?.time ?? 0;
    const daysCovered = Math.max(0, (last - first) / (24 * 60 * 60 * 1000));
    // <30 days = very short (bright amber), <180 days = short (dim amber), >=180 fine (gray).
    return {
      hasData: true,
      daysCovered,
      isShort: daysCovered < 180,
      isVeryShort: daysCovered < 30,
    };
  }, [history]);

  const backtest = useMemo(() => {
    if (history.length < 50) return null;
    return runStrategy(selectedStrategy, history, initialCapital, selectedTokenSpec.symbol, strategyParam, customEntry, customExit, feePctPerSide, advancedCfg);
  }, [history, initialCapital, selectedTokenSpec, selectedStrategy, strategyParam, customEntry, customExit, feePctPerSide, advancedCfg]);

  const toggleTier = (id: string) => {
    setSelectedTiers(prev =>
      prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]
    );
  };

  return (
    <div className="flex h-screen bg-black text-white font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-80 border-r border-[#1a1a1a] bg-[#050505] flex flex-col">
        <div className="p-6 border-b border-[#1a1a1a]">
          <div className="flex items-center gap-3">
            <div className="bg-yellow-400 p-1.5 rounded-lg text-black">
              <Cpu className="w-5 h-5 fill-current" />
            </div>
            <h1 className="text-xl font-black italic tracking-tighter">VECTOR_CORE</h1>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* SOL REGIME BADGE — global market context, polled every 60s */}
          <div className={cn(
            "flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-[9px] font-black uppercase tracking-widest",
            solRegime?.regime === 'bull'  ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400" :
            solRegime?.regime === 'bear'  ? "bg-red-500/5 border-red-500/20 text-red-400" :
            solRegime?.regime === 'sideways' ? "bg-yellow-400/5 border-yellow-400/20 text-yellow-400" :
            "bg-white/[0.02] border-[#1a1a1a] text-gray-600"
          )}>
            <span className="flex items-center gap-2">
              <span className={cn(
                "w-1.5 h-1.5 rounded-full",
                solRegime?.regime === 'bull' ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" :
                solRegime?.regime === 'bear' ? "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]" :
                solRegime?.regime === 'sideways' ? "bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.6)]" :
                "bg-gray-700"
              )} />
              SOL Regime · {solRegime?.regime?.toUpperCase() ?? '...'}
            </span>
            {solRegime && (
              <span className="font-mono normal-case tracking-normal text-[9px]">
                {(solRegime.logReturn7d * 100 >= 0 ? '+' : '')}{(solRegime.logReturn7d * 100).toFixed(2)}% / 7d
              </span>
            )}
          </div>

          {/* CAPITALIZATION + LOOKBACK — both shape every backtest below; pinned to top so they're always visible */}
          <div className="space-y-3 pb-4 border-b border-[#1a1a1a]">
            <div className="space-y-1.5">
              <label className="text-[9px] font-black text-[#444] uppercase tracking-widest flex justify-between items-center px-1">
                <span className="flex items-center gap-2">
                  Capitalization ($)
                  <InfoTooltip content="Initial starting balance per asset. Drives client-side and server-side backtests. Max $1M.">
                    <Info className="w-3 h-3 text-[#333] hover:text-yellow-400 transition-colors" />
                  </InfoTooltip>
                </span>
                <span className="text-yellow-400 font-mono text-[10px]">${initialCapital.toLocaleString()}</span>
              </label>
              <input
                type="number"
                value={initialCapital}
                onChange={(e) => handleCapitalChange(Number(e.target.value))}
                className="w-full bg-black border border-[#1a1a1a] rounded-xl px-4 py-2.5 text-sm font-mono focus:border-yellow-400 outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[9px] font-black text-[#444] uppercase tracking-widest flex justify-between items-center px-1">
                <span className="flex items-center gap-2">
                  Lookback Period
                  <InfoTooltip content="RSI period for momentum / mean-reversion / custom strategies. Fast EMA period (slow = 3×) for trend-following. Higher values smooth signals but lag more, and need 3× as much candle history (warm-up). Range: 2 - 500.">
                    <Info className="w-3 h-3 text-[#333] hover:text-yellow-400 transition-colors" />
                  </InfoTooltip>
                </span>
                <span className="text-yellow-400 font-mono text-[10px]">{strategyParam}</span>
              </label>
              <div className="flex items-center gap-2 px-1">
                <input
                  type="range"
                  min="2"
                  max="500"
                  value={strategyParam}
                  onChange={(e) => handleParamChange(Number(e.target.value))}
                  className="flex-1 accent-yellow-400"
                />
                <input
                  type="number"
                  min="2"
                  max="500"
                  value={strategyParam}
                  onChange={(e) => handleParamChange(Number(e.target.value))}
                  className="w-16 bg-black border border-[#1a1a1a] rounded-lg px-2 py-1 text-[11px] font-mono text-yellow-400 focus:border-yellow-400 outline-none text-right"
                />
              </div>
              <p className="text-[8px] text-gray-700 italic px-1">2 - 500 candles</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[9px] font-black text-[#444] uppercase tracking-widest flex justify-between items-center px-1">
                <span className="flex items-center gap-2">
                  Fee per Side (%)
                  <InfoTooltip content="Round-trip cost per side: Jupiter routing fee + typical memecoin slippage. Default 0.6% per side ⇒ ~1.2% per round-trip. Set to 0 to see fee-free results, but those are unrealistic on Solana DEXs.">
                    <Info className="w-3 h-3 text-[#333] hover:text-yellow-400 transition-colors" />
                  </InfoTooltip>
                </span>
                <span className="text-yellow-400 font-mono text-[10px]">{feePctPerSide.toFixed(2)}%</span>
              </label>
              <div className="flex items-center gap-2 px-1">
                <input
                  type="range" min="0" max="2" step="0.05"
                  value={feePctPerSide}
                  onChange={(e) => setFeePctPerSide(Math.max(0, Math.min(5, Number(e.target.value))))}
                  className="flex-1 accent-yellow-400"
                />
                <input
                  type="number" min="0" max="5" step="0.05"
                  value={feePctPerSide}
                  onChange={(e) => setFeePctPerSide(Math.max(0, Math.min(5, Number(e.target.value))))}
                  className="w-16 bg-black border border-[#1a1a1a] rounded-lg px-2 py-1 text-[11px] font-mono text-yellow-400 focus:border-yellow-400 outline-none text-right"
                />
              </div>
              <p className="text-[8px] text-gray-700 italic px-1">Per side · charged on entry & exit</p>
            </div>
          </div>

          {/* PRE-COMPUTED RESULTS BROWSER — primary entry point. Queries the bt_runs table
              populated by the batch engine. Click any row to load that token + strategy into
              the chart panel, where the live backtest re-runs with the same param. */}
          <div className="pt-2 border-b border-[#1a1a1a] pb-4 space-y-3">
            <button
              onClick={() => setShowBrowsePanel(v => !v)}
              className="w-full flex items-center justify-between px-1"
            >
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.5)]" />
                <p className="text-[9px] font-black text-fuchsia-400 uppercase tracking-[0.2em]">Backtest Library</p>
                {searchResults.length > 0 && (
                  <span className="text-[8px] font-mono text-fuchsia-400/70">[{searchResults.length}]</span>
                )}
              </div>
              <span className="text-[9px] text-fuchsia-400/70">{showBrowsePanel ? '−' : '+'}</span>
            </button>
            <p className="text-[8px] text-gray-700 px-1 leading-relaxed">
              Pre-computed results from <span className="font-mono text-fuchsia-400/70">bt_runs</span>. Click a row to load that token + strategy.
            </p>

            {showBrowsePanel && (
              <>
                {/* COMPACT FILTER FORM */}
                <div className="space-y-2 p-2 rounded-xl bg-fuchsia-500/[0.03] border border-fuchsia-500/15">
                  {/* Strategy + Tier on one row */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <select
                      value={filterStrategy}
                      onChange={e => setFilterStrategy(e.target.value)}
                      className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      title="Filter by strategy_type"
                    >
                      <option value="">All strategies</option>
                      {searchFacets.strategies.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select
                      value={filterTier}
                      onChange={e => setFilterTier(e.target.value)}
                      className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      title="Filter by tier label"
                    >
                      <option value="">All tiers</option>
                      {searchFacets.tiers.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  {/* Interval + Symbol search on one row */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <select
                      value={filterInterval}
                      onChange={e => setFilterInterval(e.target.value)}
                      className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      title="Filter by candle interval"
                    >
                      <option value="">Any interval</option>
                      {searchFacets.intervals.map(i => <option key={i} value={i}>{i}</option>)}
                    </select>
                    <input
                      value={filterSymbolLike}
                      onChange={e => setFilterSymbolLike(e.target.value)}
                      placeholder="Symbol contains…"
                      className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-fuchsia-300 placeholder:text-gray-700 outline-none focus:border-fuchsia-400"
                    />
                  </div>

                  {/* Performance thresholds */}
                  <div className="grid grid-cols-4 gap-1.5">
                    <div className="space-y-0.5">
                      <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">Min net %</p>
                      <input
                        type="number"
                        value={filterMinNetPct}
                        onChange={e => setFilterMinNetPct(Number(e.target.value) || 0)}
                        className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">Min PF</p>
                      <input
                        type="number" step="0.1"
                        value={filterMinPf}
                        onChange={e => setFilterMinPf(Number(e.target.value) || 0)}
                        className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">Min trades</p>
                      <input
                        type="number" min="0"
                        value={filterMinTrades}
                        onChange={e => setFilterMinTrades(Math.max(0, Number(e.target.value) || 0))}
                        className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      />
                    </div>
                    <div className="space-y-0.5">
                      <p
                        className="text-[7px] font-bold text-gray-700 uppercase tracking-widest"
                        title="Skip results from tokens with less than N days of candle history. Below ~90 days, regime + survivorship bias make backtest metrics unreliable. 0 = disabled."
                      >Min hist (d)</p>
                      <input
                        type="number" min="0"
                        value={filterMinDataSpanDays}
                        onChange={e => setFilterMinDataSpanDays(Math.max(0, Number(e.target.value) || 0))}
                        className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                      />
                    </div>
                  </div>

                  {/* Sort + best-per-token */}
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <select
                      value={filterSortBy}
                      onChange={e => setFilterSortBy(e.target.value as SortField)}
                      className="flex-1 bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                    >
                      <optgroup label="In-sample (train)">
                        <option value="net_profit_pct">Sort: IS Net %</option>
                        <option value="profit_factor">Sort: IS PF</option>
                        <option value="sharpe_ratio">Sort: IS Sharpe</option>
                        <option value="win_rate">Sort: IS Win %</option>
                        <option value="trades">Sort: IS Trades</option>
                      </optgroup>
                      <optgroup label="Out-of-sample (test)">
                        <option value="oos_net_profit_pct">Sort: OOS Net %</option>
                        <option value="oos_profit_factor">Sort: OOS PF</option>
                        <option value="oos_sharpe_ratio">Sort: OOS Sharpe</option>
                        <option value="oos_win_rate">Sort: OOS Win %</option>
                        <option value="oos_trades">Sort: OOS Trades</option>
                      </optgroup>
                    </select>
                    <label className="flex items-center gap-1.5 text-[8px] font-bold text-gray-500 uppercase tracking-widest cursor-pointer select-none whitespace-nowrap">
                      <div
                        onClick={() => setFilterBestPerToken(v => !v)}
                        className={cn(
                          "relative w-7 h-3.5 rounded-full transition-colors",
                          filterBestPerToken ? "bg-fuchsia-400" : "bg-[#222]"
                        )}
                      >
                        <div className={cn(
                          "absolute top-0.5 w-2.5 h-2.5 rounded-full bg-black transition-all",
                          filterBestPerToken ? "left-3.5" : "left-0.5"
                        )} />
                      </div>
                      Best/token
                    </label>
                  </div>

                  {/* OOS / advanced filters — collapsed by default. Phase 5 — only meaningful
                      for rows where split_pct > 0 (run via `npm run batch -- --split-pct 70`). */}
                  <div className="pt-1">
                    <button
                      onClick={() => setShowAdvancedFilters(v => !v)}
                      className="w-full flex items-center justify-between text-[8px] font-bold text-fuchsia-400/70 uppercase tracking-widest hover:text-fuchsia-400 transition-colors"
                    >
                      <span>Out-of-sample filters {(filterMinOosNetPct || filterMinOosPf || filterMinOosTrades) ? '· active' : ''}</span>
                      <span>{showAdvancedFilters ? '−' : '+'}</span>
                    </button>
                    {showAdvancedFilters && (
                      <div className="mt-1.5 space-y-1.5 p-1.5 rounded-lg bg-black/40 border border-fuchsia-500/15">
                        <p className="text-[7px] text-gray-700 italic leading-relaxed">
                          Filter by held-out test-slice metrics — surfaces params that survive walk-forward, not just in-sample winners. Requires <span className="font-mono">--split-pct &gt; 0</span> on the batch run.
                        </p>
                        <div className="grid grid-cols-3 gap-1.5">
                          <div className="space-y-0.5">
                            <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">Min OOS %</p>
                            <input
                              type="number"
                              value={filterMinOosNetPct}
                              onChange={e => setFilterMinOosNetPct(Number(e.target.value) || 0)}
                              className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                            />
                          </div>
                          <div className="space-y-0.5">
                            <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">Min OOS PF</p>
                            <input
                              type="number" step="0.1"
                              value={filterMinOosPf}
                              onChange={e => setFilterMinOosPf(Number(e.target.value) || 0)}
                              className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                            />
                          </div>
                          <div className="space-y-0.5">
                            <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">Min OOS trades</p>
                            <input
                              type="number" min="0"
                              value={filterMinOosTrades}
                              onChange={e => setFilterMinOosTrades(Math.max(0, Number(e.target.value) || 0))}
                              className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-fuchsia-300 outline-none focus:border-fuchsia-400"
                            />
                          </div>
                        </div>
                        <label className="flex items-center justify-between cursor-pointer pt-0.5">
                          <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Show OOS metrics on rows</span>
                          <div
                            onClick={() => setShowOosColumns(v => !v)}
                            className={cn(
                              "relative w-7 h-3.5 rounded-full transition-colors",
                              showOosColumns ? "bg-fuchsia-400" : "bg-[#222]"
                            )}
                          >
                            <div className={cn(
                              "absolute top-0.5 w-2.5 h-2.5 rounded-full bg-black transition-all",
                              showOosColumns ? "left-3.5" : "left-0.5"
                            )} />
                          </div>
                        </label>
                      </div>
                    )}
                  </div>
                </div>

                {/* RESULT LIST — scrollable, click to load */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <p className="text-[8px] font-bold text-gray-700 uppercase tracking-widest">
                      {searchLoading ? 'Searching…' : searchError ? 'Search error' : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`}
                    </p>
                    {searchError && <span className="text-[8px] text-red-400/80 truncate ml-2" title={searchError}>{searchError}</span>}
                  </div>
                  <div className="grid gap-1 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
                    {searchResults.length === 0 && !searchLoading && !searchError && (
                      <p className="text-[9px] text-gray-700 italic px-1 py-2">
                        No matches. Run the batch engine (<span className="font-mono">npm run batch</span>) to populate <span className="font-mono">bt_runs</span>, or relax the filters.
                      </p>
                    )}
                    {searchResults.map((r, idx) => {
                      const isActive = selectedTokenSpec.address === r.token_address && r.param === strategyParam;
                      const profitColor = r.net_profit_pct >= 0 ? 'text-emerald-400' : 'text-red-400';
                      const pfDisplay = !Number.isFinite(r.profit_factor) || r.profit_factor >= 999 ? '∞' : r.profit_factor.toFixed(2);
                      const hasWf = r.split_pct > 0;
                      const oosColor = r.oos_net_profit_pct >= 0 ? 'text-emerald-400' : 'text-red-400';
                      const oosPfDisplay = !Number.isFinite(r.oos_profit_factor) || r.oos_profit_factor >= 999
                        ? '∞' : r.oos_profit_factor.toFixed(2);
                      // Overfit signal: positive IS but materially worse OOS (< 30% retained or negative).
                      const overfitFlag = hasWf && r.net_profit_pct > 5 &&
                        (r.oos_net_profit_pct < 0 || r.oos_net_profit_pct < r.net_profit_pct * 0.3);
                      // Thin-sample signal: too few trades for the metrics to be meaningful.
                      // Below 10 trades, PF and win-rate are essentially coin-flips. PF=∞ on
                      // 2 trades is the canonical case — looks amazing, means nothing.
                      const thinSampleFlag = r.trades > 0 && r.trades < 10;
                      return (
                        <button
                          key={`${r.sweep_id}-${r.token_address}-${r.strategy_type}-${r.param}-${idx}`}
                          onClick={() => applyBacktestRow(r)}
                          className={cn(
                            "w-full px-2 py-1.5 rounded-lg border text-left transition-all",
                            isActive
                              ? "bg-fuchsia-500/10 border-fuchsia-400/40"
                              : "bg-[#0a0a0a] border-[#1a1a1a] hover:border-fuchsia-500/30 hover:bg-fuchsia-500/[0.04]"
                          )}
                          title={`${r.strategy_type} @ ${r.param} on ${r.symbol} (${r.tier}) — ${r.entry_logic} / ${r.exit_logic}${hasWf ? ` · split ${r.split_pct.toFixed(0)}/${(100 - r.split_pct).toFixed(0)}` : ''}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-black truncate flex-1 flex items-center gap-1">
                              {r.symbol}
                              {overfitFlag && <span className="text-[7px] text-amber-400/80 font-bold uppercase tracking-widest">overfit?</span>}
                              {thinSampleFlag && <span className="text-[7px] text-orange-400/80 font-bold uppercase tracking-widest" title={`Only ${r.trades} trades — metrics aren't statistically meaningful`}>n={r.trades}</span>}
                            </span>
                            <span
                              className={cn("text-[10px] font-mono font-bold", profitColor)}
                              title={`Raw: ${r.net_profit_pct.toExponential(3)}%`}
                            >
                              {formatPct(r.net_profit_pct)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <span className="text-[8px] text-fuchsia-400/70 font-mono uppercase tracking-widest truncate">
                              {r.strategy_type} · p{r.param}
                            </span>
                            <span className="text-[8px] font-mono text-gray-500">
                              PF {pfDisplay} · {r.trades}t · {r.win_rate.toFixed(0)}%w
                            </span>
                          </div>
                          {showOosColumns && hasWf && (
                            <div className="flex items-center justify-between gap-2 mt-0.5 pt-0.5 border-t border-[#1a1a1a]">
                              <span className="text-[8px] font-mono text-gray-600 uppercase tracking-widest">
                                OOS ({(100 - r.split_pct).toFixed(0)}%)
                              </span>
                              <span className="text-[8px] font-mono text-gray-500">
                                <span className={cn("font-bold", oosColor)}>
                                  {formatPct(r.oos_net_profit_pct)}
                                </span>
                                {' · '}PF {oosPfDisplay} · {r.oos_trades}t
                              </span>
                            </div>
                          )}
                          {showOosColumns && !hasWf && (
                            <div className="text-[7px] text-gray-800 italic mt-0.5">no walk-forward (run with --split-pct 70)</div>
                          )}
                          <div className="text-[7px] text-gray-700 font-mono uppercase tracking-widest truncate mt-0.5">
                            {r.tier} · {r.interval}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* TIER PICKER + RUN SWEEP — multi-select with intersection across categories */}
          <div className="pt-2 border-b border-[#1a1a1a] pb-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[9px] font-black text-[#444] uppercase tracking-[0.2em]">Active Scan Clusters</p>
                <Layers className="w-3 h-3 text-[#444]" />
              </div>
              <p className="text-[8px] text-gray-700 px-1 leading-relaxed">Tokens must match <span className="text-yellow-400/80">ALL</span> selected pills. Reloads from ClickHouse on every change.</p>
              <div className="space-y-2">
                {TIER_CATEGORY_ORDER.map(cat => {
                  const items = groupedTiers[cat];
                  if (!items || items.length === 0) return null;
                  return (
                    <div key={cat} className="space-y-1">
                      <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest px-1">{TIER_CATEGORY_LABEL[cat]}</p>
                      <div className="flex flex-wrap gap-1">
                        {items.map(t => {
                          const active = selectedTiers.includes(t.id);
                          return (
                            <button
                              key={t.id}
                              onClick={() => toggleTier(t.id)}
                              title={t.description}
                              className={cn(
                                "px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-tight border transition-all",
                                active
                                  ? "bg-cyan-400 border-cyan-400 !text-black shadow-[0_0_10px_rgba(34,211,238,0.35)]"
                                  : "bg-[#0a0a0a] border-[#1a1a1a] text-gray-500 hover:text-white hover:border-[#333]"
                              )}
                            >
                              {shortTierLabel(t.name, t.category)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* PerTier slider — controls how many tokens come back from /api/tokens */}
              <div className="pt-1 px-1 space-y-1">
                <label className="text-[7px] font-bold text-gray-700 uppercase tracking-widest flex justify-between">
                  <span>Tokens per tier</span>
                  <span className="text-cyan-400/80 font-mono">{perTier}</span>
                </label>
                <input
                  type="range" min="5" max="100" step="5"
                  value={perTier}
                  onChange={(e) => setPerTier(Number(e.target.value))}
                  className="w-full accent-cyan-400"
                />
              </div>

              {/* Survivorship/quality filters — collapsible */}
              <div className="px-1 pt-1">
                <button
                  onClick={() => setShowQualityFilters(v => !v)}
                  className="w-full flex items-center justify-between text-[7px] font-bold text-gray-700 uppercase tracking-widest hover:text-gray-500 transition-colors"
                >
                  <span className="flex items-center gap-1">
                    Quality filters · age ≥ {minAgeDays}d · stale ≤ {maxStaleDays}d
                  </span>
                  <span>{showQualityFilters ? '−' : '+'}</span>
                </button>
                {showQualityFilters && (
                  <div className="mt-2 space-y-2 p-2 rounded-lg bg-black/40 border border-[#1a1a1a]">
                    <p className="text-[8px] text-gray-700 italic leading-relaxed">
                      Backtests only see tokens still in your DB — dead tokens are missing (survivorship bias).
                      These filters exclude freshly-listed pumps and abandoned tokens so results are honest.
                    </p>
                    <div className="space-y-1">
                      <label className="text-[7px] font-bold text-gray-700 uppercase tracking-widest flex justify-between">
                        <span>Min token age (days)</span>
                        <span className="text-cyan-400/80 font-mono">{minAgeDays}</span>
                      </label>
                      <input
                        type="range" min="0" max="180" step="1"
                        value={minAgeDays}
                        onChange={(e) => setMinAgeDays(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[7px] font-bold text-gray-700 uppercase tracking-widest flex justify-between">
                        <span>Max staleness (days)</span>
                        <span className="text-cyan-400/80 font-mono">{maxStaleDays}</span>
                      </label>
                      <input
                        type="range" min="1" max="60" step="1"
                        value={maxStaleDays}
                        onChange={(e) => setMaxStaleDays(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* TIER ASSETS — sits right under the cluster picker so the picker → assets → sweep flow is linear */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[9px] font-black text-[#444] uppercase tracking-[0.2em]">
                  Tier Assets {tierTokens.length > 0 && <span className="text-gray-700 normal-case tracking-normal">({tierTokens.length}/{perTier})</span>}
                </p>
                <Layers className="w-3 h-3 text-[#444]" />
              </div>
              <div className="grid gap-1 max-h-64 overflow-y-auto pr-1 custom-scrollbar">
                {tierTokens.length === 0 && (
                  <p className="text-[9px] text-gray-700 italic px-1">
                    {selectedTiers.length === 0 ? 'Select a cluster above.' : 'No tokens match.'}
                  </p>
                )}
                {tierTokens.map(t => (
                  <button
                    key={t.address}
                    onClick={() => setSelectedTokenSpec(t)}
                    title={t.address}
                    className={cn(
                      "w-full px-4 py-2 rounded-xl border flex items-center justify-between transition-all",
                      selectedTokenSpec.address === t.address ? "bg-white/5 border-white/10" : "border-transparent opacity-40 hover:opacity-100"
                    )}
                  >
                    <span className="text-xs font-bold truncate">{t.symbol}</span>
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  </button>
                ))}
              </div>
            </div>

          </div>

          {/* STRATEGY LIBRARY — persisted bundles from quantlab.strategies. Load applies the
              bundle's full config to the editor below; Save captures the current editor state. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <p className="text-[9px] font-black text-[#666] uppercase tracking-[0.2em]">Strategy Library</p>
              <InfoTooltip content="Persisted strategy bundles. Loading copies entry/exit code, advanced cfg, sweep ranges, lookback, and fee into the editor. Saving captures the current strategy as a new bundle (bundle_id is the primary key — re-using one updates).">
                <Info className="w-3 h-3 text-[#444] hover:text-yellow-400 transition-colors cursor-help" />
              </InfoTooltip>
            </div>
            <div className="grid gap-1 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
              {bundles.length === 0 && (
                <p className="text-[9px] text-gray-700 italic px-1">No bundles yet — save one below.</p>
              )}
              {bundles.map(b => (
                <div key={b.bundleId} className="group flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] hover:border-[#222] transition-all">
                  <button
                    onClick={() => loadBundle(b)}
                    className="flex-1 text-left min-w-0"
                    title={`${b.entryLogic} / ${b.exitLogic}`}
                  >
                    <div className="text-[10px] font-black truncate">{b.name}</div>
                    <div className="text-[8px] text-gray-700 uppercase tracking-widest">{b.bundleId} · {b.family}</div>
                  </button>
                  <button
                    onClick={() => archiveBundle(b.bundleId)}
                    className="text-[8px] font-bold text-gray-700 hover:text-red-400 uppercase tracking-widest"
                    title="Archive (kept in history, hidden from active list)"
                  >
                    [ × ]
                  </button>
                </div>
              ))}
            </div>
            {!showSaveBundle ? (
              <button
                onClick={() => {
                  setShowSaveBundle(true);
                  // pre-fill from current state for convenience
                  setSaveBundleName(`${selectedStrategy} v${bundles.filter(b => b.family === selectedStrategy).length + 1}`);
                  setSaveBundleId(`${selectedStrategy}_v${bundles.filter(b => b.family === selectedStrategy).length + 1}`);
                }}
                className="w-full text-[8px] font-black text-emerald-400/70 hover:text-emerald-400 uppercase tracking-widest border border-emerald-500/15 hover:border-emerald-500/30 rounded-lg py-1.5 transition-colors"
              >
                + Save current as bundle
              </button>
            ) : (
              <div className="space-y-1.5 p-2 rounded-xl bg-emerald-500/[0.04] border border-emerald-500/20">
                <p className="text-[8px] font-black text-emerald-400 uppercase tracking-widest">Save bundle ({selectedStrategy})</p>
                <input
                  value={saveBundleName}
                  onChange={e => setSaveBundleName(e.target.value)}
                  placeholder="Display name"
                  className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] focus:border-emerald-400 outline-none"
                />
                <input
                  value={saveBundleId}
                  onChange={e => setSaveBundleId(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  placeholder="bundle_id (alphanum_underscore)"
                  className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono focus:border-emerald-400 outline-none"
                />
                <div className="flex gap-1.5">
                  <button onClick={saveCurrentAsBundle} disabled={!saveBundleId || !saveBundleName} className="flex-1 text-[8px] font-black text-black bg-emerald-400 hover:bg-emerald-300 disabled:bg-emerald-800 disabled:text-gray-700 rounded-lg py-1.5 uppercase tracking-widest">Save</button>
                  <button onClick={() => setShowSaveBundle(false)} className="flex-1 text-[8px] font-black text-gray-500 hover:text-white border border-[#222] rounded-lg py-1.5 uppercase tracking-widest">Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* STRATEGY SELECTION */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded-full bg-yellow-400 text-black flex items-center justify-center text-[9px] font-black italic">1</div>
                <p className="text-[9px] font-black text-[#666] uppercase tracking-[0.2em]">Select Strategy Logic</p>
              </div>
              <InfoTooltip content="Select the core logic used to generate buy/sell signals across all market tiers.">
                <Info className="w-3 h-3 text-[#444] hover:text-yellow-400 transition-colors cursor-help" />
              </InfoTooltip>
            </div>
            <div className="space-y-1">
              {STRATEGIES.map(s => (
                <div key={s.id} className="space-y-1">
                  <button 
                    onClick={() => setSelectedStrategy(s.id)}
                    className={cn(
                      "w-full text-left px-4 py-3 rounded-xl border transition-all group relative overflow-hidden",
                      selectedStrategy === s.id ? "bg-yellow-400 border-yellow-400 text-black shadow-[0_0_20px_rgba(250,204,21,0.15)]" : "bg-[#0a0a0a] border-[#1a1a1a] text-gray-500 hover:text-white"
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-black uppercase tracking-wider">{s.name}</span>
                        {selectedStrategy === s.id && <Zap className="w-3 h-3 fill-current" />}
                    </div>
                    <p className={cn(
                      "text-[8px] leading-relaxed mb-1",
                      selectedStrategy === s.id ? "text-black/60" : "text-gray-600"
                    )}>{s.description}</p>
                  </button>

                  <AnimatePresence>
                    {selectedStrategy === s.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="p-4 rounded-b-2xl bg-[#080808] border-x border-b border-[#1a1a1a] space-y-3 mb-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[8px] font-bold text-gray-700 uppercase tracking-widest">
                              Editable code · runs every backtest
                            </span>
                            {isStrategyEdited(s.id) && (
                              <button
                                onClick={() => resetStrategyCode(s.id)}
                                className="text-[8px] font-bold text-yellow-400/80 hover:text-yellow-300 uppercase tracking-widest"
                              >
                                Reset
                              </button>
                            )}
                          </div>
                          {s.id === selectedStrategy && codeHasPlaceholders && (
                            <div className="px-2 py-1.5 rounded-lg bg-cyan-400/[0.04] border border-cyan-400/15 text-[8px] text-cyan-400/80 leading-relaxed">
                              <span className="font-black uppercase tracking-widest">Live backtest substitutes</span>
                              <span className="font-mono normal-case tracking-normal text-cyan-300/90 ml-1.5">
                                $E={midE}, $X={midX}
                              </span>
                              <span className="text-gray-700"> (mid of sweep range — toggle Sweep on to optimize)</span>
                            </div>
                          )}
                           <div className="space-y-2">
                            <label className="text-[9px] font-black text-gray-600 uppercase flex items-center gap-2">
                              <div className="w-1 h-1 rounded-full bg-emerald-500" />
                              Entry Trigger
                            </label>
                            <textarea
                              spellCheck={false}
                              value={strategyCode[s.id].entry}
                              onChange={(e) => setStrategyEntry(s.id, e.target.value)}
                              className="w-full bg-black border border-[#222] rounded-lg px-3 py-2 text-[10px] font-mono focus:border-yellow-400 outline-none min-h-[60px] resize-y text-emerald-300/90"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-[9px] font-black text-gray-600 uppercase flex items-center gap-2">
                              <div className="w-1 h-1 rounded-full bg-red-500" />
                              Exit Protocol
                            </label>
                            <textarea
                              spellCheck={false}
                              value={strategyCode[s.id].exit}
                              onChange={(e) => setStrategyExit(s.id, e.target.value)}
                              className="w-full bg-black border border-[#222] rounded-lg px-3 py-2 text-[10px] font-mono focus:border-yellow-400 outline-none min-h-[60px] resize-y text-red-300/90"
                            />
                          </div>
                          <div>
                            <p className="text-[8px] font-bold text-gray-700 uppercase tracking-widest mb-1">Available variables</p>
                            <div className="flex flex-wrap gap-1">
                              {STRATEGY_VARS.map(v => (
                                <span key={v} className="text-[8px] font-mono text-yellow-400/60 bg-yellow-400/5 border border-yellow-400/10 px-1.5 py-0.5 rounded">{v}</span>
                              ))}
                              <span className="text-[8px] font-mono text-cyan-400/70 bg-cyan-400/5 border border-cyan-400/15 px-1.5 py-0.5 rounded">$E</span>
                              <span className="text-[8px] font-mono text-cyan-400/70 bg-cyan-400/5 border border-cyan-400/15 px-1.5 py-0.5 rounded">$X</span>
                            </div>
                            <p className="text-[8px] text-gray-700 italic mt-1.5 leading-relaxed">$E and $X are sweep placeholders — substitute for any number you want the optimizer to vary, e.g. <span className="font-mono text-cyan-400/70">rsi &gt; $E</span>.</p>
                          </div>

                          {/* THRESHOLD SWEEP TOGGLE + RANGES */}
                          <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
                            <label className="flex items-center justify-between cursor-pointer">
                              <span className="flex items-center gap-2">
                                <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest">Sweep $E / $X</span>
                                <InfoTooltip content="When ON, the Parameter Distribution chart explores every (lookback × $E × $X) combo and shows the best net profit per lookback. Heavy compute — toggle off when not optimizing.">
                                  <Info className="w-3 h-3 text-[#333] hover:text-cyan-400 transition-colors" />
                                </InfoTooltip>
                              </span>
                              <div
                                onClick={() => updateSweepCfg(s.id, { enabled: !strategySweep[s.id].enabled })}
                                className={cn(
                                  "relative w-8 h-4 rounded-full transition-colors",
                                  strategySweep[s.id].enabled ? "bg-cyan-400" : "bg-[#222]"
                                )}
                              >
                                <div className={cn(
                                  "absolute top-0.5 w-3 h-3 rounded-full bg-black transition-all",
                                  strategySweep[s.id].enabled ? "left-4" : "left-0.5"
                                )} />
                              </div>
                            </label>

                            {strategySweep[s.id].enabled && (
                              <div className="grid grid-cols-2 gap-2 pt-1">
                                <div className="space-y-1">
                                  <p className="text-[8px] font-bold text-cyan-400/70 uppercase tracking-widest">$E range</p>
                                  <div className="flex gap-1 items-center">
                                    <input type="number" value={strategySweep[s.id].eMin}
                                      onChange={e => updateSweepCfg(s.id, { eMin: Number(e.target.value) })}
                                      className="w-full bg-black border border-[#222] rounded px-1.5 py-1 text-[10px] font-mono text-cyan-400 outline-none focus:border-cyan-400" />
                                    <span className="text-gray-700 text-[8px]">→</span>
                                    <input type="number" value={strategySweep[s.id].eMax}
                                      onChange={e => updateSweepCfg(s.id, { eMax: Number(e.target.value) })}
                                      className="w-full bg-black border border-[#222] rounded px-1.5 py-1 text-[10px] font-mono text-cyan-400 outline-none focus:border-cyan-400" />
                                    <span className="text-gray-700 text-[8px]">/</span>
                                    <input type="number" value={strategySweep[s.id].eStep}
                                      onChange={e => updateSweepCfg(s.id, { eStep: Number(e.target.value) })}
                                      className="w-12 bg-black border border-[#222] rounded px-1.5 py-1 text-[10px] font-mono text-cyan-400 outline-none focus:border-cyan-400" />
                                  </div>
                                </div>
                                <div className="space-y-1">
                                  <p className="text-[8px] font-bold text-cyan-400/70 uppercase tracking-widest">$X range</p>
                                  <div className="flex gap-1 items-center">
                                    <input type="number" value={strategySweep[s.id].xMin}
                                      onChange={e => updateSweepCfg(s.id, { xMin: Number(e.target.value) })}
                                      className="w-full bg-black border border-[#222] rounded px-1.5 py-1 text-[10px] font-mono text-cyan-400 outline-none focus:border-cyan-400" />
                                    <span className="text-gray-700 text-[8px]">→</span>
                                    <input type="number" value={strategySweep[s.id].xMax}
                                      onChange={e => updateSweepCfg(s.id, { xMax: Number(e.target.value) })}
                                      className="w-full bg-black border border-[#222] rounded px-1.5 py-1 text-[10px] font-mono text-cyan-400 outline-none focus:border-cyan-400" />
                                    <span className="text-gray-700 text-[8px]">/</span>
                                    <input type="number" value={strategySweep[s.id].xStep}
                                      onChange={e => updateSweepCfg(s.id, { xStep: Number(e.target.value) })}
                                      className="w-12 bg-black border border-[#222] rounded px-1.5 py-1 text-[10px] font-mono text-cyan-400 outline-none focus:border-cyan-400" />
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* ADVANCED CONTROLS — sizing + stop-loss + take-profit, opt-in */}
                          <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
                            <label className="flex items-center justify-between cursor-pointer">
                              <span className="flex items-center gap-2">
                                <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest">Advanced · sizing + SL/TP</span>
                                <InfoTooltip content="When ON: deploy a fraction of cash per entry, hard stop-loss / take-profit checked intrabar (low/high). All three are independent — set any to 0 to disable.">
                                  <Info className="w-3 h-3 text-[#333] hover:text-emerald-400 transition-colors" />
                                </InfoTooltip>
                              </span>
                              <div
                                onClick={() => updateAdvancedCfg(s.id, { enabled: !strategyAdvanced[s.id].enabled })}
                                className={cn(
                                  "relative w-8 h-4 rounded-full transition-colors",
                                  strategyAdvanced[s.id].enabled ? "bg-emerald-400" : "bg-[#222]"
                                )}
                              >
                                <div className={cn(
                                  "absolute top-0.5 w-3 h-3 rounded-full bg-black transition-all",
                                  strategyAdvanced[s.id].enabled ? "left-4" : "left-0.5"
                                )} />
                              </div>
                            </label>

                            {strategyAdvanced[s.id].enabled && (
                              <div className="space-y-2 pt-1">
                                <div className="space-y-1">
                                  <label className="text-[8px] font-bold text-emerald-400/70 uppercase tracking-widest flex justify-between">
                                    <span>Position size · % of cash</span>
                                    <span className="font-mono">{strategyAdvanced[s.id].positionSizePct}%</span>
                                  </label>
                                  <input type="range" min="1" max="100" step="1"
                                    value={strategyAdvanced[s.id].positionSizePct}
                                    onChange={e => updateAdvancedCfg(s.id, { positionSizePct: Number(e.target.value) })}
                                    className="w-full accent-emerald-400" />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[8px] font-bold text-emerald-400/70 uppercase tracking-widest flex justify-between">
                                    <span>Stop-loss · % below entry</span>
                                    <span className="font-mono">{strategyAdvanced[s.id].stopLossPct === 0 ? 'OFF' : `${strategyAdvanced[s.id].stopLossPct}%`}</span>
                                  </label>
                                  <input type="range" min="0" max="50" step="0.5"
                                    value={strategyAdvanced[s.id].stopLossPct}
                                    onChange={e => updateAdvancedCfg(s.id, { stopLossPct: Number(e.target.value) })}
                                    className="w-full accent-emerald-400" />
                                </div>
                                <div className="space-y-1">
                                  <label className="text-[8px] font-bold text-emerald-400/70 uppercase tracking-widest flex justify-between">
                                    <span>Take-profit · % above entry</span>
                                    <span className="font-mono">{strategyAdvanced[s.id].takeProfitPct === 0 ? 'OFF' : `${strategyAdvanced[s.id].takeProfitPct}%`}</span>
                                  </label>
                                  <input type="range" min="0" max="200" step="1"
                                    value={strategyAdvanced[s.id].takeProfitPct}
                                    onChange={e => updateAdvancedCfg(s.id, { takeProfitPct: Number(e.target.value) })}
                                    className="w-full accent-emerald-400" />
                                </div>
                                <p className="text-[8px] text-gray-700 italic leading-relaxed pt-1">
                                  Stop-loss is checked before take-profit when both could trigger in the same bar (conservative).
                                  These also expose <span className="font-mono text-emerald-400/70">position_pnl_pct</span>, <span className="font-mono text-emerald-400/70">bars_in_position</span>, <span className="font-mono text-emerald-400/70">drawdown_pct</span> in your entry/exit code.
                                </p>
                              </div>
                            )}
                          </div>

                          {/* SOURCE VIEWER — show what loop your entry/exit code actually feeds into */}
                          <div className="border-t border-[#1a1a1a] pt-3">
                            <button
                              onClick={() => setShowBacktestSource(v => !v)}
                              className="w-full flex items-center justify-between text-[8px] font-bold text-gray-700 uppercase tracking-widest hover:text-gray-500 transition-colors"
                            >
                              <span>View backtest source</span>
                              <span>{showBacktestSource ? '−' : '+'}</span>
                            </button>
                            {showBacktestSource && (
                              <pre className="mt-2 p-3 bg-black border border-[#1a1a1a] rounded-lg text-[9px] font-mono text-gray-400 leading-relaxed overflow-x-auto custom-scrollbar whitespace-pre">
{BACKTEST_SOURCE}
                              </pre>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>

        </div>

        <div className="p-4 bg-black border-t border-[#1a1a1a]">
          <div className="flex items-center gap-3 text-[#333]">
            <Database className="w-3 h-3" />
            <span className="text-[9px] font-bold tracking-widest uppercase">Batch Mode Active</span>
          </div>
        </div>
      </aside>

      {/* Main Unified Dashboard */}
      <main className="flex-1 flex flex-col overflow-hidden bg-[#050505]">
        <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-[#000]">
          <div className="flex items-center gap-3">
             <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_10px_rgba(250,204,21,0.5)]" />
             <h2 className="text-xs font-black uppercase tracking-[0.3em] text-white italic">VECTOR_TERMINAL</h2>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <span className="text-[9px] font-black text-[#444] uppercase tracking-widest leading-none mb-1">System_Status</span>
              <span className="text-[10px] font-mono font-bold tracking-tighter text-emerald-400 leading-none uppercase">
                Ready
              </span>
            </div>
          </div>
        </header>

        <div className="flex-1 p-6 overflow-hidden grid grid-cols-12 gap-6">
          {/* LEFT: TECHNICAL ANALYSIS (8 columns) */}
          <div className="col-span-8 flex flex-col gap-6 overflow-hidden">
            {/* PRICE CHART */}
            <div className={panelExpandClass('chart', "flex-[3] bg-[#0a0a0a] rounded-3xl border border-[#1a1a1a] shadow-2xl relative overflow-hidden flex flex-col")}>
              {/* Chart Meta Header */}
              <div className="absolute top-4 left-6 z-20 flex items-center gap-6">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-black text-white tracking-widest uppercase italic">{selectedTokenSpec.symbol}</span>
                    <span className="px-1.5 py-0.5 rounded bg-white/5 text-[9px] font-bold text-gray-500 uppercase">{selectedTimeframe}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-xl font-mono font-black tracking-tighter leading-none transition-colors",
                      wsPrice > 0 ? "text-green-400" : "text-yellow-400"
                    )}>
                      ${livePrice > 0
                        ? livePrice.toLocaleString(undefined, {
                            minimumFractionDigits: Math.max(2, Math.min(12, -Math.floor(Math.log10(livePrice)) + 3)),
                            maximumFractionDigits: Math.max(2, Math.min(12, -Math.floor(Math.log10(livePrice)) + 3)),
                          })
                        : '0.00'}
                    </span>
                    {wsPrice <= 0 && <span className="text-[8px] font-bold text-gray-700 uppercase tracking-widest italic animate-pulse">Syncing...</span>}
                    {dataCoverage.hasData && (
                      <span
                        className={cn(
                          "text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border",
                          dataCoverage.isVeryShort
                            ? "text-amber-400 bg-amber-400/[0.08] border-amber-400/30"
                            : dataCoverage.isShort
                              ? "text-amber-400/70 bg-amber-400/[0.04] border-amber-400/15"
                              : "text-gray-500 bg-white/[0.02] border-white/5"
                        )}
                        title={
                          `Token has ${dataCoverage.daysCovered.toFixed(0)} days of ${selectedTimeframe} data total. ` +
                          (dataCoverage.isVeryShort
                            ? `That's very short — backtests on this token will be statistically unreliable. Most Solana memecoins (especially pump.fun launches) didn't exist months ago, so Jupiter has no older history to fetch.`
                            : dataCoverage.isShort
                              ? `Below 6 months — backtests are runnable but walk-forward results may be noisy.`
                              : `Plenty of history for backtesting.`)
                        }
                      >
                        {dataCoverage.daysCovered < 30
                          ? `${dataCoverage.daysCovered.toFixed(0)}d data`
                          : dataCoverage.daysCovered < 730
                            ? `${(dataCoverage.daysCovered / 30).toFixed(0)}mo data`
                            : `${(dataCoverage.daysCovered / 365).toFixed(1)}y data`}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md p-1 rounded-xl border border-white/5">
                     {['5m', '15m', '1h', '4h', '1d'].map(tf => (
                      <button
                        key={tf}
                        onClick={() => setSelectedTimeframe(tf as any)}
                        className={cn(
                          "px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-tighter transition-all",
                          selectedTimeframe === tf ? "bg-yellow-400 text-black shadow-[0_0_10px_rgba(250,204,21,0.3)]" : "text-gray-600 hover:text-gray-400 hover:bg-white/5"
                        )}
                      >{tf}</button>
                     ))}
                  </div>
                  <div className="flex items-center gap-1 bg-black/40 backdrop-blur-md p-1 rounded-xl border border-white/5">
                     {PERIODS.map(p => {
                       const bars = computeCandleLimit(p, selectedTimeframe);
                       const capped = p !== 'ALL' && PERIOD_MS[p] / TIMEFRAME_MS[selectedTimeframe] > SERVER_CAP;
                       return (
                       <button
                         key={p}
                         onClick={() => setSelectedPeriod(p)}
                         title={capped
                           ? `Capped at ${SERVER_CAP.toLocaleString()} bars (true ${p} of ${selectedTimeframe} would be larger)`
                           : `${bars.toLocaleString()} ${selectedTimeframe} bars`}
                         className={cn(
                           "px-2 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-tighter transition-all",
                           selectedPeriod === p ? "bg-emerald-400 text-black shadow-[0_0_10px_rgba(52,211,153,0.3)]" : "text-gray-600 hover:text-gray-400 hover:bg-white/5",
                           capped && selectedPeriod === p && "ring-1 ring-yellow-400/40"
                         )}
                       >{p}</button>
                       );
                     })}
                  </div>
                </div>
              </div>

              <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
                {/* Indicator Dropdown */}
                <div className="relative">
                  <button 
                    onClick={() => setIsIndicatorMenuOpen(!isIndicatorMenuOpen)}
                    className={cn(
                      "flex items-center gap-2 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-xl border transition-all text-xs font-black uppercase tracking-widest",
                      isIndicatorMenuOpen ? "border-yellow-400 text-yellow-400" : "border-white/10 text-gray-300 hover:border-yellow-400/50"
                    )}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    Indicators ({selectedIndicators.length})
                  </button>
                  
                  <AnimatePresence>
                    {isIndicatorMenuOpen && (
                      <>
                        <div 
                          className="fixed inset-0 z-20" 
                          onClick={() => setIsIndicatorMenuOpen(false)} 
                        />
                        <motion.div 
                          initial={{ opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 10, scale: 0.95 }}
                          className="absolute right-0 top-full mt-2 w-48 bg-[#0a0a0a] border border-[#1a1a1a] rounded-2xl p-2 shadow-2xl z-30"
                        >
                           <div className="px-3 py-2 border-b border-white/5 mb-1">
                             <p className="text-[8px] font-black text-gray-500 uppercase tracking-widest">Select Indicators</p>
                           </div>
                           {INDICATORS.map(ind => (
                             <button
                              key={ind.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedIndicators(prev => 
                                  prev.includes(ind.id) ? prev.filter(i => i !== ind.id) : [...prev, ind.id]
                                );
                              }}
                              className={cn(
                                "w-full text-left p-2 px-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-between group",
                                selectedIndicators.includes(ind.id) ? "bg-white/5 text-white" : "text-gray-600 hover:bg-white/5 hover:text-gray-400"
                              )}
                             >
                               {ind.name}
                               {selectedIndicators.includes(ind.id) && <div className={cn("w-1.5 h-1.5 rounded-full", ind.color.replace('text-', 'bg-'))} />}
                             </button>
                           ))}
                           <button 
                            onClick={() => setIsIndicatorMenuOpen(false)}
                            className="w-full mt-2 p-2 rounded-xl bg-yellow-400 text-black text-[9px] font-black uppercase tracking-[0.2em] hover:bg-yellow-300 transition-colors"
                           >
                             Save_Layout
                           </button>
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>

                <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md p-1 rounded-xl border border-white/5">
                  <button onClick={() => setChartType('line')} className={cn("p-1.5 rounded-lg transition-all", chartType === 'line' ? "bg-white/10 text-white" : "text-gray-600")}><BarChart2 className="w-3.5 h-3.5" /></button>
                  <button onClick={() => setChartType('candle')} className={cn("p-1.5 rounded-lg transition-all", chartType === 'candle' ? "bg-white/10 text-white" : "text-gray-600")}><Database className="w-3.5 h-3.5" /></button>
                </div>
                <ExpandToggle id="chart" />
              </div>

              {/* Chart area is pushed below the absolute-positioned header so the chart's top
                  rows (highest prices, EMA highs, price-label badges) don't sit behind the
                  symbol/period/indicator chips. pt-20 ≈ header height + breathing room. */}
              <div className="flex-1 min-h-0 relative pt-20">
                {isDataLoading && (
                  <div className="absolute inset-0 z-10 bg-black/20 backdrop-blur-[1px] flex items-center justify-center">
                    <motion.div 
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      className="w-10 h-10 border-2 border-yellow-400/20 border-t-yellow-400 rounded-full"
                    />
                  </div>
                )}
                <TradingViewChart 
                   data={chartData} 
                   showEMA20={selectedIndicators.includes('EMA20')} 
                   showEMA50={selectedIndicators.includes('EMA50')} 
                   showBB={selectedIndicators.includes('BB')}
                   showMomentum={selectedIndicators.includes('MBias')}
                   showVolume={selectedIndicators.includes('VOL')}
                   chartType={chartType}
                   trades={backtest?.trades || []}
                 />
              </div>
            </div>

            {/* PER-TOKEN LEADERBOARD — built from the live in-app `portfolio` calc on the
                currently-loaded tier. Joined with `tierTokens` so clicks can navigate to the
                token's chart. (The previous on-demand server sweep was retired — use
                `npm run backtest` for cross-tier scans persisted to bt_runs.) */}
            <div className={panelExpandClass('leaderboard', "flex-[1.2] bg-[#0a0a0a] rounded-3xl border border-[#1a1a1a] p-6 flex flex-col relative overflow-hidden")}>
              <div className="absolute inset-0 bg-gradient-to-r from-yellow-400/[0.01] to-transparent pointer-events-none" />
              <div className="flex items-center justify-between mb-4 relative z-10">
                <div className="flex items-center gap-2">
                   <Layers className="w-3 h-3 text-yellow-400" />
                   <p className="text-[9px] font-black text-gray-500 uppercase tracking-[0.2em] italic">Tier_Yield_Leaderboard</p>
                </div>
                <div className="flex items-center gap-3 text-[8px] font-bold uppercase tracking-widest text-gray-600">
                  <span>{(portfolio?.perAsset.length ?? 0) > 0 ? `${portfolio!.perAsset.length} Assets In Tier` : 'Select A Tier'}</span>
                  <ExpandToggle id="leaderboard" />
                </div>
              </div>

              <div className="flex-1 overflow-x-auto min-h-0 relative z-10 custom-scrollbar">
                <div className="flex gap-4 h-full pb-2">
                   {(!portfolio?.perAsset || portfolio.perAsset.length === 0) && (
                      <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-[#111] rounded-2xl opacity-40">
                         <Search className="w-6 h-6 mb-2 text-gray-700" />
                         <p className="text-[8px] font-black uppercase tracking-widest text-gray-800">No_Tier_Loaded</p>
                      </div>
                   )}
                   {(portfolio?.perAsset ?? [])
                     .slice()
                     .sort((a, b) => (b.netProfit ?? 0) - (a.netProfit ?? 0))
                     .slice(0, 100)
                     .map((res) => {
                       const pct = (res.netProfit / initialCapital) * 100;
                       const winRate = Number.isFinite(res.winRate) ? res.winRate : 0;
                       const tokenAddress = tierTokens.find(t => t.symbol === res.symbol)?.address;
                       const clickable = !!tokenAddress;
                       return (
                       <button
                        key={tokenAddress || res.symbol}
                        disabled={!clickable}
                        onClick={() => {
                          if (!tokenAddress) return;
                          setSelectedTokenSpec({ symbol: res.symbol, name: res.symbol, address: tokenAddress });
                        }}
                        className={cn(
                          "group flex flex-col justify-between p-4 min-w-[140px] bg-black/40 border border-[#1a1a1a] rounded-2xl transition-all text-left shrink-0",
                          clickable ? "hover:border-yellow-400/40 hover:bg-black/60 cursor-pointer" : "cursor-not-allowed opacity-70"
                        )}
                      >
                         <div>
                            <div className="flex items-center justify-between mb-1">
                               <span className="text-[10px] font-black text-white">{res.symbol}</span>
                               <div className={cn(
                                 "w-1.5 h-1.5 rounded-full",
                                 pct > 2 ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" :
                                 pct < -1 ? "bg-red-500" : "bg-gray-700"
                               )} />
                            </div>
                            <span className="text-[8px] font-black text-gray-600 uppercase tracking-tighter">{res.trades > 0 ? 'TRADED' : 'IDLE'}</span>
                         </div>
                         <div className="mt-4">
                            <span className={cn(
                              "text-sm font-black tracking-tighter block leading-none",
                              pct >= 0 ? "text-emerald-400" : "text-red-400"
                            )}>
                              {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                            </span>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                               <span className="text-[8px] font-bold text-gray-700 uppercase">{winRate.toFixed(0)}% WIN</span>
                               <div className="w-1 h-1 rounded-full bg-[#111]" />
                               <span className="text-[8px] font-bold text-gray-700 uppercase">{res.trades} TRADES</span>
                               <div className="w-1 h-1 rounded-full bg-[#111]" />
                               <span className={cn(
                                 "text-[8px] font-bold uppercase",
                                 (Number.isFinite(res.profitFactor) ? res.profitFactor : 999) >= 1 ? "text-emerald-500/80" : "text-red-500/80"
                               )}>
                                 PF {fmtPF(res.profitFactor)}
                               </span>
                            </div>
                         </div>
                      </button>
                       );
                     })}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT: PORTFOLIO & OPTIMIZER (4 columns) */}
          <div className="col-span-4 flex flex-col gap-6 overflow-hidden">
            {/* SOURCE BANNER + PORTFOLIO QUICK STATS */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl border bg-white/[0.02] border-[#1a1a1a] text-gray-500 text-[9px] font-black uppercase tracking-widest">
                <span className="flex items-center gap-2 truncate">
                  <Layers className="w-3 h-3" />
                  <span className="truncate">
                    Showing current tier · {tierData.length} assets · ${initialCapital.toLocaleString()} each
                  </span>
                </span>
              </div>

              <div className="grid grid-cols-3 gap-3">
                 <div className="bg-[#0a0a0a] border border-[#1a1a1a] p-4 rounded-3xl group hover:border-yellow-400/20 transition-all relative overflow-hidden">
                    <p className="text-[8px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Total_Returns</p>
                    <p className={cn(
                      "text-lg font-black tracking-tighter",
                      headline.netProfit >= 0 ? "text-emerald-400" : "text-red-500"
                    )}>
                      {headline.netProfit >= 0 ? '+' : '-'}${Math.abs(headline.netProfit).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </p>
                    {/* Sparkline of the current tier's combined equity curve. Hides when there
                        isn't enough history. Tracks the tier portfolio (matches headline in tier
                        mode; in sweep mode the headline jumps to sweep totals but this still
                        shows the underlying tier curve as context). */}
                    {portfolio?.aggregated?.equity && portfolio.aggregated.equity.length > 5 && (() => {
                      const eq = portfolio.aggregated.equity;
                      const min = Math.min(...eq);
                      const max = Math.max(...eq);
                      const range = max - min || 1;
                      const w = 120, h = 24, pad = 1;
                      // Sub-sample to ~80 points for a clean line
                      const stride = Math.max(1, Math.floor(eq.length / 80));
                      const pts: string[] = [];
                      for (let i = 0; i < eq.length; i += stride) {
                        const x = pad + ((i / (eq.length - 1)) * (w - pad * 2));
                        const y = h - pad - (((eq[i] - min) / range) * (h - pad * 2));
                        pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
                      }
                      const stroke = headline.netProfit >= 0 ? '#10b981' : '#ef4444';
                      return (
                        <svg viewBox={`0 0 ${w} ${h}`} className="absolute right-3 bottom-3 w-[120px] h-[24px] opacity-70 pointer-events-none">
                          <polyline fill="none" stroke={stroke} strokeWidth="1" points={pts.join(' ')} />
                        </svg>
                      );
                    })()}
                 </div>
                 <div className="bg-[#0a0a0a] border border-[#1a1a1a] p-4 rounded-3xl">
                    <p className="text-[8px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Win_Probability</p>
                    <p className="text-lg font-black tracking-tighter text-yellow-500">
                      {headline.winRate.toFixed(1)}%
                    </p>
                 </div>
                 <div className="bg-[#0a0a0a] border border-[#1a1a1a] p-4 rounded-3xl">
                    <p className="text-[8px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Profit_Factor</p>
                    <p className={cn(
                      "text-lg font-black tracking-tighter",
                      headline.profitFactor >= 1 ? "text-emerald-400" : "text-red-500"
                    )}>
                      {fmtPF(headline.profitFactor)}
                    </p>
                 </div>
              </div>
            </div>

            {/* SELECTED RUN — the bt_runs row the user just clicked in the Backtest Library.
                Shows per-token detail (which run is loaded into the chart above) so the user
                always knows what they're inspecting. Hidden until a row is clicked. */}
            {selectedSearchRow && (
              <div className="bg-[#0a0a0a] border border-emerald-500/25 rounded-3xl p-4 space-y-3 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.04] to-transparent pointer-events-none" />
                <div className="flex items-center justify-between relative z-10">
                  <div className="flex items-center gap-2 min-w-0">
                    <Eye className="w-3 h-3 text-emerald-400 shrink-0" />
                    <p className="text-[9px] font-black text-emerald-400/90 uppercase tracking-[0.2em] italic shrink-0">Selected_Run</p>
                    <span className="text-[10px] font-mono text-white truncate">{selectedSearchRow.symbol}</span>
                  </div>
                  <button
                    onClick={() => setSelectedSearchRow(null)}
                    className="text-[8px] font-bold text-gray-600 hover:text-emerald-300 normal-case"
                    title="Clear selection"
                  >
                    [ clear ]
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[8px] font-bold uppercase tracking-widest relative z-10">
                  <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400">{selectedSearchRow.strategy_type}</span>
                  <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400">P={selectedSearchRow.param}</span>
                  <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400">{selectedSearchRow.interval}</span>
                  <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400">{selectedSearchRow.tier}</span>
                  {selectedSearchRow.data_span_days > 0 && (
                    <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-500">{selectedSearchRow.data_span_days.toFixed(0)}d</span>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 relative z-10">
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Net %</p>
                    <p className={cn(
                      "text-sm font-black tracking-tighter leading-none",
                      selectedSearchRow.net_profit_pct >= 0 ? "text-emerald-400" : "text-red-500"
                    )}>
                      {selectedSearchRow.net_profit_pct >= 0 ? '+' : ''}{selectedSearchRow.net_profit_pct.toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Win %</p>
                    <p className="text-sm font-black tracking-tighter text-yellow-500 leading-none">
                      {selectedSearchRow.win_rate.toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">PF</p>
                    <p className={cn(
                      "text-sm font-black tracking-tighter leading-none",
                      selectedSearchRow.profit_factor >= 1 ? "text-emerald-400" : "text-red-500"
                    )}>
                      {fmtPF(selectedSearchRow.profit_factor)}
                    </p>
                  </div>
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Trades</p>
                    <p className="text-sm font-black tracking-tighter text-gray-300 leading-none">
                      {selectedSearchRow.trades}
                    </p>
                  </div>
                </div>
                {/* OOS comparison — only when walk-forward was on for this row. The IS/OOS
                    delta is the single most useful overfit signal: IS+200% / OOS+5% means the
                    param is curve-fit to the train slice. */}
                {selectedSearchRow.split_pct > 0 && (
                  <div className="grid grid-cols-3 gap-2 relative z-10">
                    <div className="bg-black/40 border border-emerald-500/15 p-2 rounded-xl">
                      <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-0.5 italic">OOS Net %</p>
                      <p className={cn(
                        "text-xs font-black tracking-tighter leading-none",
                        selectedSearchRow.oos_net_profit_pct >= 0 ? "text-emerald-400" : "text-red-500"
                      )}>
                        {selectedSearchRow.oos_net_profit_pct >= 0 ? '+' : ''}{selectedSearchRow.oos_net_profit_pct.toFixed(1)}%
                      </p>
                    </div>
                    <div className="bg-black/40 border border-emerald-500/15 p-2 rounded-xl">
                      <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-0.5 italic">OOS PF</p>
                      <p className={cn(
                        "text-xs font-black tracking-tighter leading-none",
                        selectedSearchRow.oos_profit_factor >= 1 ? "text-emerald-400" : "text-red-500"
                      )}>
                        {fmtPF(selectedSearchRow.oos_profit_factor)}
                      </p>
                    </div>
                    <div className="bg-black/40 border border-emerald-500/15 p-2 rounded-xl">
                      <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-0.5 italic">OOS Trades</p>
                      <p className="text-xs font-black tracking-tighter text-gray-300 leading-none">{selectedSearchRow.oos_trades}</p>
                    </div>
                  </div>
                )}
                {/* Selected vs. aggregate delta — lets the user see if the clicked token is
                    over- or under-performing the filtered cohort. Only meaningful when there's
                    an aggregate to compare against. */}
                {searchAggregate && searchAggregate.n > 1 && (
                  <div className="text-[8px] font-mono text-gray-600 relative z-10">
                    vs. aggregate:{' '}
                    <span className={cn(
                      "font-bold",
                      selectedSearchRow.net_profit_pct >= searchAggregate.netPctWeighted ? "text-emerald-400" : "text-red-400"
                    )}>
                      {selectedSearchRow.net_profit_pct >= searchAggregate.netPctWeighted ? '+' : ''}
                      {(selectedSearchRow.net_profit_pct - searchAggregate.netPctWeighted).toFixed(1)}% net
                    </span>
                    {' · '}
                    <span className={cn(
                      "font-bold",
                      selectedSearchRow.win_rate >= searchAggregate.winRate ? "text-emerald-400" : "text-red-400"
                    )}>
                      {selectedSearchRow.win_rate >= searchAggregate.winRate ? '+' : ''}
                      {(selectedSearchRow.win_rate - searchAggregate.winRate).toFixed(1)}% win
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* BACKTEST LIBRARY AGGREGATE — mirrors the headline cards but is computed from
                the CURRENT FILTER RESULT in the Backtest Library. Updates live as the user
                edits filters (because `searchResults` does), so filter changes have visible
                impact on the right side without needing to click a row first. */}
            {searchAggregate && (
              <div className="bg-[#0a0a0a] border border-fuchsia-500/20 rounded-3xl p-4 space-y-3 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-500/[0.03] to-transparent pointer-events-none" />
                <div className="flex items-center justify-between relative z-10">
                  <div className="flex items-center gap-2">
                    <Search className="w-3 h-3 text-fuchsia-400" />
                    <p className="text-[9px] font-black text-fuchsia-400/90 uppercase tracking-[0.2em] italic">Library_Filter_Aggregate</p>
                  </div>
                  <span className="text-[8px] font-mono text-gray-600">
                    {searchAggregate.n} runs · {searchAggregate.tokens} tokens · {searchAggregate.totalTrades.toLocaleString()} trades
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 relative z-10">
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Net % (trade-wt)</p>
                    <p className={cn(
                      "text-sm font-black tracking-tighter leading-none",
                      searchAggregate.netPctWeighted >= 0 ? "text-emerald-400" : "text-red-500"
                    )}>
                      {searchAggregate.netPctWeighted >= 0 ? '+' : ''}{searchAggregate.netPctWeighted.toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Win % (trade-wt)</p>
                    <p className="text-sm font-black tracking-tighter text-yellow-500 leading-none">
                      {searchAggregate.winRate.toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-black/40 border border-[#1a1a1a] p-2.5 rounded-2xl">
                    <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest mb-1 italic">Σ-PF</p>
                    <p className={cn(
                      "text-sm font-black tracking-tighter leading-none",
                      searchAggregate.profitFactor >= 1 ? "text-emerald-400" : "text-red-500"
                    )}>
                      {fmtPF(searchAggregate.profitFactor)}
                    </p>
                  </div>
                </div>
                {/* Param distribution histogram — counts of rows per param value. Tells you
                    whether the filtered result clusters around one lookback (likely a real
                    edge for that param) or smears across the whole grid (less convincing).
                    Bars and labels are split into two rows so the bar's `height: X%` resolves
                    against the bar-row's fixed `h-10` (would have been undefined inside a
                    flex-col wrapper with no defined height). */}
                {searchAggregate.paramDist.length > 0 && (() => {
                  const maxCount = Math.max(...searchAggregate.paramDist.map(p => p.count));
                  return (
                    <div className="relative z-10 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-[7px] font-black text-gray-600 uppercase tracking-widest italic">
                          Param distribution
                        </p>
                        <p className="text-[7px] font-mono text-gray-700">{searchAggregate.paramDist.length} param{searchAggregate.paramDist.length === 1 ? '' : 's'}</p>
                      </div>
                      <div className="flex items-end gap-1 h-12">
                        {searchAggregate.paramDist.map(({ param, count }) => {
                          const heightPct = (count / maxCount) * 100;
                          const isSelected = selectedSearchRow?.param === param;
                          return (
                            <div
                              key={param}
                              className={cn(
                                "flex-1 transition-colors rounded-sm cursor-default",
                                isSelected ? "bg-emerald-400/80" : "bg-fuchsia-500/30 hover:bg-fuchsia-400/60"
                              )}
                              style={{ height: `${Math.max(3, heightPct)}%` }}
                              title={`p=${param}: ${count} run${count === 1 ? '' : 's'}${isSelected ? ' (selected)' : ''}`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex gap-1">
                        {searchAggregate.paramDist.map(({ param, count }) => {
                          const isSelected = selectedSearchRow?.param === param;
                          return (
                            <span
                              key={param}
                              className={cn(
                                "flex-1 text-center text-[7px] font-mono transition-colors",
                                isSelected ? "text-emerald-300 font-bold" : "text-gray-700"
                              )}
                              title={`${count} run${count === 1 ? '' : 's'}`}
                            >
                              {param}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* OPTIMIZER BAR CHART */}
            <div className={panelExpandClass('paramdist', "flex-[2] bg-[#0a0a0a] border border-[#1a1a1a] rounded-3xl p-6 flex flex-col min-h-[220px]")}>
               <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Zap className="w-3 h-3 text-yellow-400" />
                  <InfoTooltip content="Sweeps Lookback Period across [sweepStart, sweepEnd]. Each bar = avg net profit across the current tier at that lookback. When threshold sweep is ON for the active strategy, also explores ($E × $X) per bar and shows the best combo.">
                    <h3 className="text-[9px] font-black text-gray-400 tracking-[0.2em] uppercase italic cursor-help">Parameter_Distribution</h3>
                  </InfoTooltip>
                  {sweepCfg.enabled && /\$E\b|\$X\b/.test(customEntry + customExit) && (
                    <span className="text-[7px] font-black text-cyan-400 bg-cyan-400/10 border border-cyan-400/20 px-1.5 py-0.5 rounded uppercase tracking-widest">Grid: P × $E × $X</span>
                  )}
                  {walkForwardEnabled && (
                    <span className="text-[7px] font-black text-purple-400 bg-purple-400/10 border border-purple-400/20 px-1.5 py-0.5 rounded uppercase tracking-widest">Walk-fwd 70/30</span>
                  )}
                  {sweepBusy ? (
                    <span className="text-[7px] font-black text-blue-400 bg-blue-400/10 border border-blue-400/20 px-1.5 py-0.5 rounded uppercase tracking-widest animate-pulse">Computing…</span>
                  ) : sweepMs !== null && sweepMs > 200 && (
                    <span className="text-[7px] font-bold text-gray-700 px-1.5 py-0.5 uppercase tracking-widest" title="Last sweep wall-clock time (worker thread)">
                      {sweepMs}ms
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer" title="Train on first 70% of each token's history, evaluate on the last 30%. Compare in-sample vs out-of-sample to detect overfit.">
                    <span className="text-[7px] font-black text-gray-600 uppercase tracking-widest">WF</span>
                    <div
                      onClick={() => setWalkForwardEnabled(v => !v)}
                      className={cn(
                        "relative w-7 h-3.5 rounded-full transition-colors",
                        walkForwardEnabled ? "bg-purple-400" : "bg-[#222]"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-2.5 h-2.5 rounded-full bg-black transition-all",
                        walkForwardEnabled ? "left-4" : "left-0.5"
                      )} />
                    </div>
                  </label>
                  <div className="px-2 py-0.5 rounded bg-white/5 text-[8px] font-black text-gray-600 uppercase">Backtest_Matrix</div>
                  <ExpandToggle id="paramdist" />
                </div>
              </div>
              {sweepBest && sweepCfg.enabled && /\$E\b|\$X\b/.test(customEntry + customExit) && (
                <div className="flex items-center justify-between mb-2 px-3 py-2 rounded-xl bg-cyan-400/[0.04] border border-cyan-400/15 text-[9px]">
                  <span className="font-bold text-cyan-400/80 uppercase tracking-widest">
                    {walkForwardEnabled ? 'In-sample · ' : 'Best · '}Param {sweepBest.parameter} · $E={sweepBest.bestE} · $X={sweepBest.bestX} · {(sweepBest.avgNetProfit >= 0 ? '+' : '')}${Math.abs(sweepBest.avgNetProfit).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <button
                    onClick={() => {
                      setStrategyParam(sweepBest.parameter);
                      setStrategyEntry(selectedStrategy, sub(customEntry, sweepBest.bestE, sweepBest.bestX));
                      setStrategyExit(selectedStrategy, sub(customExit, sweepBest.bestE, sweepBest.bestX));
                    }}
                    className="text-cyan-400 hover:text-cyan-300 font-black uppercase tracking-widest text-[9px]"
                    title="Set Lookback to this param and bake the winning $E/$X numbers into the strategy code (replaces placeholders)"
                  >
                    [ Adopt ]
                  </button>
                </div>
              )}
              {walkForwardEnabled && sweepBestOOS && (() => {
                const inSample = sweepBest?.avgNetProfit ?? 0;
                const oos = sweepBestOOS.netProfit;
                // Crude collapse heuristic: out-of-sample profit is < 30% of in-sample, or flips sign
                const collapsed = inSample > 0 && (oos < inSample * 0.3 || oos < 0);
                return (
                  <div className={cn(
                    "flex items-center justify-between mb-3 px-3 py-2 rounded-xl text-[9px] border",
                    collapsed ? "bg-red-500/[0.06] border-red-500/25" : "bg-purple-400/[0.05] border-purple-400/20"
                  )}>
                    <span className={cn("font-bold uppercase tracking-widest", collapsed ? "text-red-400" : "text-purple-400/85")}>
                      Out-of-sample · {(oos >= 0 ? '+' : '')}${Math.abs(oos).toLocaleString(undefined, { maximumFractionDigits: 0 })} · {sweepBestOOS.winRate.toFixed(0)}% win · PF {fmtPF(sweepBestOOS.profitFactor)} · {sweepBestOOS.trades} trades
                    </span>
                    {collapsed && (
                      <span className="text-red-400/80 font-black uppercase tracking-widest text-[8px]">⚠ overfit risk</span>
                    )}
                  </div>
                );
              })()}
              <div className="flex-1 min-h-[150px] relative">
                {sweep.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center text-[9px] text-gray-700 uppercase tracking-widest font-bold">
                    No sweep data
                  </div>
                ) : (
                 <ResponsiveContainer width="100%" height="100%" minWidth={50} minHeight={150}>
                    <ReBarChart data={sweep} margin={{ top: 0, right: 10, bottom: 0, left: 0 }}>
                       <CartesianGrid strokeDasharray="10 10" stroke="#111" vertical={false} />
                       <XAxis dataKey="parameter" hide />
                       <YAxis hide />
                       <RechartsTooltip
                        cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                        contentStyle={{ backgroundColor: '#000', border: '1px solid #222', borderRadius: '12px', fontSize: '9px' }}
                        labelFormatter={(p) => `Param ${p}`}
                        formatter={(v: any, _name: any, item: any) => {
                          const r = item?.payload;
                          const profit = `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
                          if (r?.bestE !== undefined) {
                            return [`${profit} · $E=${r.bestE} $X=${r.bestX}`, 'best of grid'];
                          }
                          return [profit, 'avg net profit'];
                        }}
                       />
                       <Bar dataKey="avgNetProfit" radius={[4, 4, 0, 0]}>
                        {sweep.map((entry: any, index: number) => (
                          <Cell key={`cell-${index}`} fill={entry.avgNetProfit > 0 ? "#eab308" : "#991b1b"} />
                        ))}
                       </Bar>
                    </ReBarChart>
                 </ResponsiveContainer>
                )}
              </div>
            </div>

          </div>

        </div>
      </main>
    </div>
  );
}

