import {StrictMode, useEffect, useState, lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Lazy-load the validator route — keeps the main dashboard bundle from pulling in
// validator-only components (input panel, CSV parsers) when not on that route.
const ValidatorApp = lazy(() => import('./components/validator/ValidatorApp.tsx'));
// Lazy-load the cluster-axis dashboard for the same reason — its panels query their
// own endpoints and pull none of the candle / strategy code paths.
const ClusterApp = lazy(() => import('./components/cluster/ClusterApp.tsx'));
// Lazy-load the meta-labeling research log — read-only view of meta_models. Separate
// route from /#/cluster because the methodology axis is different (7-criterion verdict
// vs the older 4-gate framework).
const MetaLabelingApp = lazy(() => import('./components/metaLabeling/MetaLabelingApp.tsx'));
// Lazy-load the paper-trading dashboard — read-only view of the daily-signal daemon's
// state in `quantlab.live_signals`. UI alternative to tailing Telegram messages.
const PaperTradingApp = lazy(() => import('./components/paperTrading/PaperTradingApp.tsx'));
// Lazy-load the macro-regime dashboard — Track C / Component 3. Read-only view of
// `quantlab.macro_regimes` under classifier_version='phase1_v2' with ADR-037
// bias-quarantine banner.
const RegimeApp = lazy(() => import('./components/regime/RegimeApp.tsx'));
// Lazy-load the market-cycle-position dashboard — Phase A6 of the gaps-integration arc.
// Read-only view of `quantlab.cycle_position_snapshots`. INFORMATIONAL only in v1
// (Option A); does NOT fire a regime category. SPEC: docs/specs/market-cycle-position.md.
const CyclePositionApp = lazy(() => import('./components/cyclePosition/CyclePositionApp.tsx'));
// Lazy-load the ETF-flow cross-validation dashboard — Gap #9 v3.1 (s96 #11). Read-only
// view of `quantlab.etf_shares_outstanding_secondary` vs the v1 yfinance primary panel.
// Closes the operator-validation gap from the s96 #7-#9 backend-only v3.1 slices.
const EtfFlowApp = lazy(() => import('./components/etfFlow/EtfFlowApp.tsx'));
// Lazy-load the standing system-health dashboard — ADR-044 Phase 1 (s96 #12). Read-only
// view of every load-bearing CH source's freshness vs expected cadence + operator-pending
// migrations. The standing-health mandate's single UI surface; Phase 2 will add the
// quarantine queue + Telegram alerts + auto-fix log on top of this foundation.
const HealthApp = lazy(() => import('./components/health/HealthApp.tsx'));
// Lazy-load the Phase B verdict dashboard — ADR-051 §Decision 7 (Cycle 24).
// Read-only view of the Layer-0 Phase B deflation-pipeline verdicts persisted in
// `quantlab.phase_b_verdicts` by Cycle 23+ Composite worker campaigns.
const PhaseBApp = lazy(() => import('./components/phase_b/PhaseBApp.tsx'));
// Lazy-load the vol-structure composite-detail panel — Cycle 33 (S96-147), the
// reference impl of the reusable CompositeDetailApp. Read-only view of
// `quantlab.vol_structure_snapshots`. First of the 7 backend-only composites to
// get a real panel; subsequent composites reuse the same component + a descriptor.
const VolStructApp = lazy(() => import('./components/composite/VolStructApp.tsx'));
// Lazy-load the sector-rotation + cross-asset composite-detail panels — Cycle 33
// slice 2a (S96-147). Both reuse CompositeDetailApp via their descriptors.
const SectorRotationApp = lazy(() => import('./components/composite/SectorRotationApp.tsx'));
const CrossAssetApp = lazy(() => import('./components/composite/CrossAssetApp.tsx'));
// Lazy-load the form_4 insider composite-detail panel — Cycle 33 slice 2b
// (S96-147). The dual-axis panel: descriptor.metricGroups drives the buy/sell
// lanes + the payload.drill carries the per-ticker table.
const Form4InsiderApp = lazy(() => import('./components/composite/Form4InsiderApp.tsx'));
// Lazy-load the schedule_13d_g activist-stake composite-detail panel — Cycle 33
// slice 3a (S96-147). Flat single-axis descriptor + per-ticker 13D/13G drill;
// reuses CompositeDetailApp. Ships an empty-state until the EDGAR 13D/G ingest runs.
const Schedule13DGApp = lazy(() => import('./components/composite/Schedule13DGApp.tsx'));
// Lazy-load the eight_k material-event classifier composite-detail panel —
// Cycle 33 slice 3c (S96-147). Flat single-axis descriptor + per-ticker
// material-event drill; reuses CompositeDetailApp. Empty-state until EK ingest runs.
const EightKClassifierApp = lazy(() => import('./components/composite/EightKClassifierApp.tsx'));

function Router() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Strip the query string before route matching. Without this, a deep link like
  // `#/validator?axis=cluster&strategy=...` would NOT match the validator branch
  // (the trailing `?...` defeats both the equality and startsWith tests). §3.7's
  // URL-param hydration depends on `?` being passed through — the validator app
  // itself reads `location.hash` and parses query params on mount.
  const path = hash.split('?')[0];
  if (path === '#/validator' || path.startsWith('#/validator/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-yellow-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading validator…
        </div>
      }>
        <ValidatorApp />
      </Suspense>
    );
  }
  if (path === '#/cluster' || path.startsWith('#/cluster/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-yellow-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading cluster axis…
        </div>
      }>
        <ClusterApp />
      </Suspense>
    );
  }
  if (path === '#/meta-labeling' || path.startsWith('#/meta-labeling/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-violet-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading meta-labeling research log…
        </div>
      }>
        <MetaLabelingApp />
      </Suspense>
    );
  }
  if (path === '#/paper-trading' || path.startsWith('#/paper-trading/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-emerald-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading paper-trading dashboard…
        </div>
      }>
        <PaperTradingApp />
      </Suspense>
    );
  }
  if (path === '#/regime' || path.startsWith('#/regime/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-amber-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading regime dashboard…
        </div>
      }>
        <RegimeApp />
      </Suspense>
    );
  }
  if (path === '#/cycle-position' || path.startsWith('#/cycle-position/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-cyan-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading cycle-position dashboard…
        </div>
      }>
        <CyclePositionApp />
      </Suspense>
    );
  }
  if (path === '#/etf-flow' || path.startsWith('#/etf-flow/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-fuchsia-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading etf-flow cross-validation…
        </div>
      }>
        <EtfFlowApp />
      </Suspense>
    );
  }
  if (path === '#/vol-structure' || path.startsWith('#/vol-structure/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-cyan-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading vol-structure…
        </div>
      }>
        <VolStructApp />
      </Suspense>
    );
  }
  if (path === '#/sector-rotation' || path.startsWith('#/sector-rotation/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-amber-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading sector-rotation…
        </div>
      }>
        <SectorRotationApp />
      </Suspense>
    );
  }
  if (path === '#/cross-asset' || path.startsWith('#/cross-asset/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-rose-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading cross-asset…
        </div>
      }>
        <CrossAssetApp />
      </Suspense>
    );
  }
  if (path === '#/form-4-insider' || path.startsWith('#/form-4-insider/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-emerald-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading form-4-insider…
        </div>
      }>
        <Form4InsiderApp />
      </Suspense>
    );
  }
  if (path === '#/schedule-13d-g' || path.startsWith('#/schedule-13d-g/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-violet-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading schedule-13d-g…
        </div>
      }>
        <Schedule13DGApp />
      </Suspense>
    );
  }
  if (path === '#/eight-k' || path.startsWith('#/eight-k/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-sky-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          loading eight-k…
        </div>
      }>
        <EightKClassifierApp />
      </Suspense>
    );
  }
  if (path === '#/health' || path.startsWith('#/health/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-emerald-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          checking system health…
        </div>
      }>
        <HealthApp />
      </Suspense>
    );
  }
  if (path === '#/phase-b' || path.startsWith('#/phase-b/')) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-[#050505] text-emerald-400/70 flex items-center justify-center text-[10px] font-mono uppercase tracking-widest">
          reading Phase B verdicts…
        </div>
      }>
        <PhaseBApp />
      </Suspense>
    );
  }
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
