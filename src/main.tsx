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
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
