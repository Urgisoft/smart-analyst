/**
 * Panel 1 — INPUT_BAR.
 *
 * Two modes via a segmented toggle at the top:
 *   - "csv":   external strategy claim. Three CSV textareas + chosen-trial dropdown +
 *              IS/OOS split. POSTs to /api/validator/score.
 *   - "sweep": SignalForge own bt_runs cell. Four typed inputs (strategy / tier /
 *              interval / param) backed by datalists from /api/validator/cells.
 *              POSTs to /api/validator/score-cell.
 *
 * The two modes never share state; switching back retains each side's prior contents.
 * The Score button dispatches via the discriminated onScore callback so ValidatorApp
 * doesn't need to know which mode produced the request.
 *
 * Pure presentation + state. Does not call the gates itself.
 */

import { useEffect, useMemo, useState, useRef, type ChangeEvent, type RefObject } from 'react';
import {
  parseTrialReturnsCsv,
  parsePerAssetSharpesCsv,
  parseTradeCountsCsv,
  defaultChosenTrialId,
  defaultSplitTs,
  isCsvFailure,
  MAX_CSV_BYTES,
} from './csvParse';
import type { TrialReturnRow, ValidatorRequest } from '../../lib/validator_request';
import type { ScoreCellRequest } from '../../lib/validator_cell_request';
import type { ScoreClusterRequest } from '../../lib/validator_cluster_request';
import type { InitialSweepState } from '../../lib/validator_hash_params';

export type ScoreDispatch =
  | { kind: 'csv'; request: ValidatorRequest }
  | { kind: 'sweep'; axis: 'tier'; request: ScoreCellRequest }
  | { kind: 'sweep'; axis: 'cluster'; request: ScoreClusterRequest };

interface Props {
  onScore: (dispatch: ScoreDispatch) => void;
  onClear: () => void;
  busy: boolean;
  /** When present, the panel mounts in sweep mode with axis + fields pre-filled.
   *  Phase 2 §5.5 SPEC §3.7. No auto-submit — the user still clicks Score. */
  initialSweepState?: InitialSweepState | null;
}

/** Tier-axis cell info — matches `/api/validator/cells` response (default). */
interface CellInfo {
  strategy: string;
  tier: string;
  interval: string;
  nParams: number;
  nTokens: number;
  hasSlices: boolean;
}

/** Cluster-axis cell info — matches `/api/validator/cells?axis=cluster` response. */
interface ClusterCellInfo {
  strategy: string;
  clusterId: number;
  interval: string;
  nParams: number;
  nTokens: number;
  hasSlices: boolean;
}

export function InputPanel({ onScore, onClear, busy, initialSweepState }: Props) {
  // Mode toggle. Persists per-mode form state so switching back doesn't blow away
  // what the user typed in the other side.
  // initialSweepState (when present) lands the user in sweep mode with the right
  // axis pre-selected — that's the Panel-B-row-click flow (Phase 2 §5.5 §3.7).
  const [mode, setMode] = useState<'csv' | 'sweep'>(initialSweepState ? 'sweep' : 'csv');

  const [trialReturnsRaw, setTrialReturnsRaw] = useState('');
  const [perAssetRaw, setPerAssetRaw] = useState('');
  const [tradeCountsRaw, setTradeCountsRaw] = useState('');
  const [chosenTrialId, setChosenTrialId] = useState('');
  const [splitTs, setSplitTs] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);

  // Sweep-mode state.
  // sweepAxis switches which datalist + which payload type powers the form. It's
  // a sweep-mode local concern, not a route-level one — both axes share the same
  // gate stack on the server (validator_cluster.ts → validator_cell.ts), so the
  // verdict shape is identical and there's no reason for the user to leave sweep
  // mode to switch axes.
  const [sweepAxis, setSweepAxis] = useState<'tier' | 'cluster'>(
    initialSweepState?.axis ?? 'tier',
  );
  const [sweepStrategy, setSweepStrategy] = useState(initialSweepState?.strategy ?? '');
  const [sweepTier, setSweepTier] = useState(
    initialSweepState && initialSweepState.axis === 'tier' ? initialSweepState.tier : '',
  );
  const [sweepClusterId, setSweepClusterId] = useState(
    initialSweepState && initialSweepState.axis === 'cluster'
      ? String(initialSweepState.clusterId)
      : '',
  );
  const [sweepInterval, setSweepInterval] = useState(initialSweepState?.interval ?? '');
  const [sweepParam, setSweepParam] = useState('');  // empty = auto-pick (winner)
  const [cells, setCells] = useState<CellInfo[] | null>(null);
  const [clusterCells, setClusterCells] = useState<ClusterCellInfo[] | null>(null);
  const [cellsLoading, setCellsLoading] = useState(false);
  const [cellsError, setCellsError] = useState<string | null>(null);

  // Thresholds — collapsible, defaults match validator.ts gate constants.
  const [showThresholds, setShowThresholds] = useState(false);
  const [dsrGate, setDsrGate] = useState('0.95');
  const [pboGate, setPboGate] = useState('0.50');
  const [pardoGate, setPardoGate] = useState('0.50');
  const [hlzAlpha, setHlzAlpha] = useState('0.05');

  const trialFileRef = useRef<HTMLInputElement>(null);
  const perAssetFileRef = useRef<HTMLInputElement>(null);
  const tradeCountsFileRef = useRef<HTMLInputElement>(null);

  // Parse trial returns on every change — cheap and lets us populate the chosen-trial
  // dropdown + split suggestion before the user clicks Score.
  const parsedTrials = useMemo<{ rows: TrialReturnRow[]; trialIds: string[] } | null>(() => {
    if (!trialReturnsRaw.trim()) return null;
    const r = parseTrialReturnsCsv(trialReturnsRaw);
    if (!r.ok) return null;
    const ids = [...new Set(r.rows.map(row => row.trialId))];
    return { rows: r.rows, trialIds: ids };
  }, [trialReturnsRaw]);

  // Auto-fill chosen + split when trials parse successfully and user hasn't typed yet.
  useMemo(() => {
    if (!parsedTrials) return;
    if (!chosenTrialId && parsedTrials.trialIds.length > 0) {
      const def = defaultChosenTrialId(parsedTrials.rows);
      if (def) setChosenTrialId(def);
    }
    if (!splitTs && chosenTrialId) {
      const t = defaultSplitTs(parsedTrials.rows, chosenTrialId);
      if (t !== null) setSplitTs(String(t));
    }
  }, [parsedTrials, chosenTrialId, splitTs]);

  function handleFile(setter: (s: string) => void) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_CSV_BYTES) {
        setParseError(`${file.name}: ${(file.size / 1024 / 1024).toFixed(1)}MB exceeds 5MB cap.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = ev => setter((ev.target?.result as string) ?? '');
      reader.readAsText(file);
    };
  }

  // Cells fetch — runs on first switch into sweep mode (or on axis switch / retry).
  // Each axis has its own cache; the other cache is preserved across switches so
  // toggling tier↔cluster doesn't require a refetch on every flip.
  useEffect(() => {
    if (mode !== 'sweep' || cellsLoading) return;
    if (sweepAxis === 'tier' && cells !== null) return;
    if (sweepAxis === 'cluster' && clusterCells !== null) return;
    setCellsLoading(true);
    setCellsError(null);
    const url = sweepAxis === 'cluster' ? '/api/validator/cells?axis=cluster' : '/api/validator/cells';
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { cells: CellInfo[] | ClusterCellInfo[] }) => {
        if (sweepAxis === 'cluster') {
          setClusterCells(j.cells as ClusterCellInfo[]);
        } else {
          setCells(j.cells as CellInfo[]);
        }
      })
      .catch(e => setCellsError(e.message ?? String(e)))
      .finally(() => setCellsLoading(false));
  }, [mode, sweepAxis, cells, clusterCells, cellsLoading]);

  function thresholdsObj(): ValidatorRequest['thresholds'] | undefined {
    const dsrG = Number(dsrGate), pboG = Number(pboGate), pardoG = Number(pardoGate), hlzA = Number(hlzAlpha);
    if (![dsrG, pboG, pardoG, hlzA].every(Number.isFinite)) return undefined;
    return { dsrGate: dsrG, pboGate: pboG, pardoGate: pardoG, hlzAlpha: hlzA };
  }

  function handleScore() {
    setParseError(null);
    if (mode === 'csv') {
      if (!trialReturnsRaw.trim()) { setParseError('Trial returns CSV is required.'); return; }
      const trials = parseTrialReturnsCsv(trialReturnsRaw);
      if (isCsvFailure(trials)) { setParseError(`Trial returns: ${trials.error}`); return; }
      if (!chosenTrialId.trim()) { setParseError('Choose a trial to score.'); return; }
      const splitNum = Number(splitTs);
      if (!Number.isFinite(splitNum)) { setParseError('IS/OOS split timestamp must be a finite number (UNIX seconds).'); return; }

      const req: ValidatorRequest = {
        trialReturns: trials.rows,
        chosenTrialId: chosenTrialId.trim(),
        isOosSplitTs: splitNum,
      };
      if (perAssetRaw.trim()) {
        const p = parsePerAssetSharpesCsv(perAssetRaw);
        if (isCsvFailure(p)) { setParseError(`Per-asset Sharpes: ${p.error}`); return; }
        req.perAssetSharpes = p.rows;
      }
      if (tradeCountsRaw.trim()) {
        const c = parseTradeCountsCsv(tradeCountsRaw);
        if (isCsvFailure(c)) { setParseError(`Trade counts: ${c.error}`); return; }
        req.trialTradeCounts = Object.fromEntries(c.rows.map(r => [r.trialId, r.trades]));
      }
      const t = thresholdsObj();
      if (t) req.thresholds = t;
      onScore({ kind: 'csv', request: req });
    } else {
      // Sweep mode — branches by axis. The cluster axis carries clusterId (Int32,
      // server rejects negative values per validator_cluster_request.ts:55).
      if (sweepAxis === 'cluster') {
        if (!sweepStrategy.trim() || !sweepClusterId.trim() || !sweepInterval.trim()) {
          setParseError('Strategy, cluster_id, and interval are required.');
          return;
        }
        const cid = Number(sweepClusterId);
        if (!Number.isFinite(cid) || !Number.isInteger(cid) || cid < 0) {
          setParseError('cluster_id must be a non-negative integer (HDBSCAN noise label −1 is not a cluster).');
          return;
        }
        const req: ScoreClusterRequest = {
          strategy: sweepStrategy.trim(),
          clusterId: cid,
          interval: sweepInterval.trim(),
        };
        if (sweepParam.trim()) {
          const n = Number(sweepParam);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
            setParseError('Param must be a non-negative integer, or empty for auto-pick.');
            return;
          }
          req.chosenParam = n;
        }
        const t = thresholdsObj();
        if (t) req.thresholds = t;
        onScore({ kind: 'sweep', axis: 'cluster', request: req });
        return;
      }
      // Tier axis (default).
      if (!sweepStrategy.trim() || !sweepTier.trim() || !sweepInterval.trim()) {
        setParseError('Strategy, tier, and interval are required.');
        return;
      }
      const req: ScoreCellRequest = {
        strategy: sweepStrategy.trim(),
        tier: sweepTier.trim(),
        interval: sweepInterval.trim(),
      };
      if (sweepParam.trim()) {
        const n = Number(sweepParam);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          setParseError('Param must be a non-negative integer, or empty for auto-pick.');
          return;
        }
        req.chosenParam = n;
      }
      const t = thresholdsObj();
      if (t) req.thresholds = t;
      onScore({ kind: 'sweep', axis: 'tier', request: req });
    }
  }

  function handleClear() {
    setTrialReturnsRaw(''); setPerAssetRaw(''); setTradeCountsRaw('');
    setChosenTrialId(''); setSplitTs(''); setParseError(null);
    if (trialFileRef.current) trialFileRef.current.value = '';
    if (perAssetFileRef.current) perAssetFileRef.current.value = '';
    if (tradeCountsFileRef.current) tradeCountsFileRef.current.value = '';
    onClear();
  }

  /** Drop a server-hosted demo fixture into the textareas. Lets non-technical users see
   *  what the verdict shape looks like without bringing their own data. The two demos
   *  are emitted by `scripts/_emit_validator_demo_csvs.ts`. */
  async function loadDemo(kind: 'pass' | 'fail') {
    setParseError(null);
    try {
      const trials = await fetch(`/api/validator/demo/${kind}`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${kind} demo`);
        return r.text();
      });
      setTrialReturnsRaw(trials);
      // Pass demo also enables the bootstrap DSR path via per-asset Sharpes.
      if (kind === 'pass') {
        const pa = await fetch('/api/validator/demo/per-asset').then(r => r.ok ? r.text() : '');
        setPerAssetRaw(pa);
      } else {
        setPerAssetRaw('');
      }
      setTradeCountsRaw('');
      // Reset chosen + split so the auto-fill picks the demo's natural defaults.
      setChosenTrialId('');
      setSplitTs('');
    } catch (e) {
      setParseError(`Demo load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const trialIdCount = parsedTrials?.trialIds.length ?? 0;
  const trialRowCount = parsedTrials?.rows.length ?? 0;

  // Distinct facet values for the sweep-mode datalists. Two parallel paths — tier
  // and cluster — share the same UI shape. Explicit string[] casts because
  // `new Set<string>(...)` spread inference widens to unknown[] under this project's
  // tsconfig (target ES2020 + strict: false).
  const allStrategies: string[] = sweepAxis === 'cluster'
    ? (clusterCells
        ? Array.from(new Set<string>(clusterCells.map(c => c.strategy))).sort()
        : [])
    : (cells
        ? Array.from(new Set<string>(cells.map(c => c.strategy))).sort()
        : []);
  const validTiers: string[] = cells
    ? Array.from(new Set<string>(
        cells.filter(c => !sweepStrategy || c.strategy === sweepStrategy).map(c => c.tier),
      )).sort()
    : [];
  // cluster_ids are non-negative ints from the published cluster set; numeric sort.
  const validClusterIds: string[] = clusterCells
    ? Array.from(new Set<number>(
        clusterCells.filter(c => !sweepStrategy || c.strategy === sweepStrategy).map(c => c.clusterId),
      )).sort((a, b) => a - b).map(n => String(n))
    : [];
  const validIntervals: string[] = sweepAxis === 'cluster'
    ? (clusterCells
        ? Array.from(new Set<string>(
            clusterCells.filter(c => (!sweepStrategy || c.strategy === sweepStrategy) &&
                              (!sweepClusterId.trim() || String(c.clusterId) === sweepClusterId.trim()))
                 .map(c => c.interval),
          )).sort()
        : [])
    : (cells
        ? Array.from(new Set<string>(
            cells.filter(c => (!sweepStrategy || c.strategy === sweepStrategy) &&
                              (!sweepTier || c.tier === sweepTier))
                 .map(c => c.interval),
          )).sort()
        : []);
  const matchedTierCell = cells?.find(c =>
    c.strategy === sweepStrategy && c.tier === sweepTier && c.interval === sweepInterval);
  const matchedClusterCell = clusterCells?.find(c =>
    c.strategy === sweepStrategy && String(c.clusterId) === sweepClusterId.trim() && c.interval === sweepInterval);
  const matchedCell = sweepAxis === 'cluster' ? matchedClusterCell : matchedTierCell;

  const canScore = mode === 'csv'
    ? !busy && !!trialReturnsRaw.trim()
    : sweepAxis === 'cluster'
      ? !busy && !!sweepStrategy.trim() && !!sweepClusterId.trim() && !!sweepInterval.trim()
      : !busy && !!sweepStrategy.trim() && !!sweepTier.trim() && !!sweepInterval.trim();

  return (
    <div className="bg-[#0a0a0a] rounded-2xl border border-[#1a1a1a] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.5)]" />
          <p className="text-[9px] font-black text-yellow-400 uppercase tracking-[0.2em]">Input_Bar</p>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-gray-500">
          {mode === 'csv' && parsedTrials && (
            <span>
              <span className="text-yellow-400/80">{trialIdCount}</span> trials ·{' '}
              <span className="text-yellow-400/80">{trialRowCount}</span> rows
            </span>
          )}
          {mode === 'sweep' && matchedCell && (
            <span>
              <span className="text-yellow-400/80">{matchedCell.nParams}</span> params ·{' '}
              <span className="text-yellow-400/80">{matchedCell.nTokens}</span> tokens
              {!matchedCell.hasSlices && <span className="text-red-400/70"> · PBO N/A</span>}
            </span>
          )}
          {mode === 'csv' && (
            <>
              <button
                type="button"
                onClick={() => loadDemo('pass')}
                disabled={busy}
                className="text-[8px] font-bold text-emerald-400/70 hover:text-emerald-400 uppercase tracking-widest disabled:opacity-50"
                title="Load 16-trial × 300-bar synthetic edge fixture (verdict: pass-all)"
              >
                Load demo: pass
              </button>
              <button
                type="button"
                onClick={() => loadDemo('fail')}
                disabled={busy}
                className="text-[8px] font-bold text-red-400/70 hover:text-red-400 uppercase tracking-widest disabled:opacity-50"
                title="Load 16-trial × 300-bar pure-noise fixture (verdict: partial / fail-heavy)"
              >
                Load demo: fail
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mode toggle */}
      <div className="flex border border-[#222] rounded-lg overflow-hidden text-[9px] font-black uppercase tracking-[0.2em]">
        <button
          type="button"
          onClick={() => setMode('csv')}
          className={`flex-1 py-2 transition-colors ${mode === 'csv'
            ? 'bg-yellow-400/10 text-yellow-400'
            : 'bg-transparent text-gray-600 hover:text-gray-400'}`}
        >
          From CSV
        </button>
        <button
          type="button"
          onClick={() => setMode('sweep')}
          className={`flex-1 py-2 transition-colors border-l border-[#222] ${mode === 'sweep'
            ? 'bg-yellow-400/10 text-yellow-400'
            : 'bg-transparent text-gray-600 hover:text-gray-400'}`}
        >
          From Sweep
        </button>
      </div>
      <p className="text-[8px] font-mono text-gray-700 -mt-2">
        {mode === 'csv'
          ? 'External strategy claim. Paste per-bar trial returns; verdict comes from the gates.'
          : 'SignalForge bt_runs cell. Pick a (strategy, tier, interval); the same gates run against your sweep.'}
      </p>

      {mode === 'csv' && <>
      {/* Trial returns CSV */}
      <CsvField
        label="Trial returns CSV (required)"
        hint="columns: trialId,ts,ret · ret is decimal (0.012 = 1.2%) · ≥30 bars per trial · ≥2 trials"
        value={trialReturnsRaw}
        onChange={setTrialReturnsRaw}
        fileRef={trialFileRef}
        onFile={handleFile(setTrialReturnsRaw)}
        rows={6}
      />

      {/* Chosen trial + split */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[9px] font-black text-gray-500 uppercase tracking-widest">Chosen trial</label>
          {parsedTrials ? (
            <select
              value={chosenTrialId}
              onChange={e => setChosenTrialId(e.target.value)}
              className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-yellow-300 outline-none focus:border-yellow-400"
            >
              {parsedTrials.trialIds.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          ) : (
            <input
              value={chosenTrialId}
              onChange={e => setChosenTrialId(e.target.value)}
              placeholder="Paste trials CSV first"
              disabled
              className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-gray-700 opacity-60"
            />
          )}
        </div>
        <div className="space-y-1">
          <label className="text-[9px] font-black text-gray-500 uppercase tracking-widest">IS/OOS split (UNIX sec)</label>
          <input
            type="number"
            value={splitTs}
            onChange={e => setSplitTs(e.target.value)}
            placeholder="auto: 70% of bars"
            className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-yellow-300 outline-none focus:border-yellow-400"
          />
        </div>
      </div>

      {/* Optional inputs — collapsible */}
      <details className="border-t border-[#1a1a1a] pt-3">
        <summary className="text-[9px] font-black text-gray-500 uppercase tracking-widest cursor-pointer hover:text-yellow-400/80">
          Optional inputs (per-asset Sharpes, trade counts)
        </summary>
        <div className="mt-3 space-y-3">
          <CsvField
            label="Per-asset Sharpes CSV (≥4 enables bootstrap DSR)"
            hint="columns: assetId,sharpe · cross-asset Sharpes from your sweep"
            value={perAssetRaw}
            onChange={setPerAssetRaw}
            fileRef={perAssetFileRef}
            onFile={handleFile(setPerAssetRaw)}
            rows={3}
          />
          <CsvField
            label="Trade counts CSV (filters sparse trials in CSCV)"
            hint="columns: trialId,trades · trials with <10 trades excluded from PBO"
            value={tradeCountsRaw}
            onChange={setTradeCountsRaw}
            fileRef={tradeCountsFileRef}
            onFile={handleFile(setTradeCountsRaw)}
            rows={3}
          />
        </div>
      </details>
      </>}

      {mode === 'sweep' && (
        <div className="space-y-3">
          {cellsLoading && (
            <p className="text-[9px] font-mono text-gray-500">loading cells…</p>
          )}
          {cellsError && (
            <div className="text-[10px] font-mono text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 flex items-center justify-between">
              <span>Cells fetch failed: {cellsError}</span>
              <button
                type="button"
                onClick={() => setCells(null)}
                className="text-yellow-400/80 hover:text-yellow-400 text-[9px] uppercase tracking-widest"
              >
                Retry
              </button>
            </div>
          )}
          {/* Axis toggle — phase 2 §5.5 §3.7. Both axes share the same gate stack;
              swapping only changes the "what cohort defines this cell" lookup. */}
          <div className="flex border border-[#222] rounded-lg overflow-hidden text-[8px] font-black uppercase tracking-[0.2em]">
            <button
              type="button"
              onClick={() => { setSweepAxis('tier'); setSweepClusterId(''); }}
              className={`flex-1 py-1.5 transition-colors ${sweepAxis === 'tier'
                ? 'bg-yellow-400/10 text-yellow-400'
                : 'bg-transparent text-gray-600 hover:text-gray-400'}`}
            >
              Tier axis
            </button>
            <button
              type="button"
              onClick={() => { setSweepAxis('cluster'); setSweepTier(''); }}
              className={`flex-1 py-1.5 transition-colors border-l border-[#222] ${sweepAxis === 'cluster'
                ? 'bg-cyan-400/10 text-cyan-400'
                : 'bg-transparent text-gray-600 hover:text-gray-400'}`}
            >
              Cluster axis
            </button>
          </div>
          <SweepField
            label="Strategy"
            value={sweepStrategy}
            onChange={v => { setSweepStrategy(v); setSweepTier(''); setSweepClusterId(''); setSweepInterval(''); }}
            options={allStrategies}
            placeholder="e.g. mean_reversion_v1"
            listId="vc-strat"
          />
          <div className="grid grid-cols-2 gap-3">
            {sweepAxis === 'cluster' ? (
              <SweepField
                label="Cluster ID"
                value={sweepClusterId}
                onChange={v => { setSweepClusterId(v); setSweepInterval(''); }}
                options={validClusterIds}
                placeholder="e.g. 0"
                listId="vc-cid"
              />
            ) : (
              <SweepField
                label="Tier"
                value={sweepTier}
                onChange={v => { setSweepTier(v); setSweepInterval(''); }}
                options={validTiers}
                placeholder="e.g. mcap_nano"
                listId="vc-tier"
              />
            )}
            <SweepField
              label="Interval"
              value={sweepInterval}
              onChange={setSweepInterval}
              options={validIntervals}
              placeholder="e.g. 1h"
              listId="vc-int"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-black text-gray-500 uppercase tracking-widest">
              Param <span className="text-gray-700 normal-case">— blank = winner (auto-pick via PSR-argmax)</span>
            </label>
            <input
              type="number"
              step="1"
              min="0"
              value={sweepParam}
              onChange={e => setSweepParam(e.target.value)}
              placeholder="auto"
              className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-yellow-300 outline-none focus:border-yellow-400"
            />
          </div>
        </div>
      )}

      {/* Thresholds */}
      <div className="border-t border-[#1a1a1a] pt-3">
        <button
          onClick={() => setShowThresholds(v => !v)}
          className="text-[9px] font-black text-gray-500 uppercase tracking-widest hover:text-yellow-400/80"
        >
          {showThresholds ? '−' : '+'} Thresholds (defaults match production)
        </button>
        {showThresholds && (
          <div className="grid grid-cols-4 gap-2 mt-2">
            <ThresholdField label="DSR ≥" value={dsrGate} onChange={setDsrGate} />
            <ThresholdField label="PBO <" value={pboGate} onChange={setPboGate} />
            <ThresholdField label="OOS/IS ≥" value={pardoGate} onChange={setPardoGate} />
            <ThresholdField label="HLZ α" value={hlzAlpha} onChange={setHlzAlpha} />
          </div>
        )}
      </div>

      {parseError && (
        <div className="text-[10px] font-mono text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {parseError}
        </div>
      )}

      {/* "Why is the button disabled?" hint — surfaces the missing input so users don't
          stare at a greyed-out button trying to figure out what's needed. */}
      {!canScore && !busy && !parseError && (
        <p className="text-[9px] font-mono text-gray-600">
          {mode === 'csv'
            ? 'Paste a trial-returns CSV to enable scoring.'
            : (() => {
                const missing: string[] = [];
                if (!sweepStrategy.trim()) missing.push('strategy');
                if (sweepAxis === 'cluster') {
                  if (!sweepClusterId.trim()) missing.push('cluster_id');
                } else {
                  if (!sweepTier.trim()) missing.push('tier');
                }
                if (!sweepInterval.trim()) missing.push('interval');
                return `Fill ${missing.join(', ')} to score. Click each field for autocomplete from your bt_runs.`;
              })()}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleScore}
          disabled={!canScore}
          className="flex-1 bg-yellow-400/10 hover:bg-yellow-400/20 disabled:bg-[#0a0a0a] disabled:text-gray-700 border border-yellow-400/40 hover:border-yellow-400 disabled:border-[#222] text-yellow-400 disabled:cursor-not-allowed text-[10px] font-black uppercase tracking-[0.2em] py-2.5 rounded-lg transition-colors"
        >
          {busy ? 'Scoring…' : 'Score Strategy'}
        </button>
        <button
          onClick={handleClear}
          disabled={busy}
          className="bg-[#0a0a0a] hover:bg-[#111] border border-[#222] hover:border-[#333] text-gray-500 hover:text-gray-300 text-[10px] font-black uppercase tracking-[0.2em] px-4 py-2.5 rounded-lg transition-colors"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

interface CsvFieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (s: string) => void;
  fileRef: RefObject<HTMLInputElement | null>;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
  rows: number;
}
function CsvField({ label, hint, value, onChange, fileRef, onFile, rows }: CsvFieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-[9px] font-black text-gray-500 uppercase tracking-widest">{label}</label>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="text-[8px] font-bold text-yellow-400/70 hover:text-yellow-400 uppercase tracking-widest"
        >
          Load file…
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="hidden" />
      </div>
      <p className="text-[8px] font-mono text-gray-700">{hint}</p>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={label.startsWith('Trial returns')
          ? 'trialId,ts,ret\nlookback=14,1700000000,0.0023\n…'
          : ''}
        className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-yellow-300 outline-none focus:border-yellow-400 resize-y custom-scrollbar"
      />
    </div>
  );
}

interface SweepFieldProps {
  label: string;
  value: string;
  onChange: (s: string) => void;
  options: string[];
  placeholder: string;
  listId: string;
}
function SweepField({ label, value, onChange, options, placeholder, listId }: SweepFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-[9px] font-black text-gray-500 uppercase tracking-widest">{label}</label>
      <input
        list={listId}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full bg-black border border-[#222] rounded-lg px-2 py-1.5 text-[10px] font-mono text-yellow-300 outline-none focus:border-yellow-400"
      />
      <datalist id={listId}>
        {options.map(o => <option key={o} value={o} />)}
      </datalist>
    </div>
  );
}

interface ThresholdFieldProps { label: string; value: string; onChange: (s: string) => void; }
function ThresholdField({ label, value, onChange }: ThresholdFieldProps) {
  return (
    <div className="space-y-0.5">
      <p className="text-[7px] font-bold text-gray-700 uppercase tracking-widest">{label}</p>
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-black border border-[#222] rounded-lg px-1.5 py-1 text-[10px] font-mono text-yellow-300 outline-none focus:border-yellow-400"
      />
    </div>
  );
}
