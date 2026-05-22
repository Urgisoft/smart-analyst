---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: index
---

# Components — index

> **Authority:** [MASTER.html §3](../../MASTER.html#part3) (component catalog) is the architectural reference. The per-component docs in this directory expand each row of §3 into its own file with diagrams, interface, dependencies, and "what could break this" notes.
>
> **Last updated:** 2026-05-03

---

## Why per-component docs

`MASTER.html §3` is a one-line-per-component catalog. That's the right grain for
a system-level reference. But individual components (especially deflation
modules and the upcoming broker layer) need more depth: interface contract,
data flow, dependencies, edge cases, "what could break this" notes, last
ADR that touched them.

Per-component docs are the working layer. They live in this directory, follow
[`_template.md`](_template.md), and are updated when a component changes
(not on every diff — when the interface or contract changes).

---

## Conventions

- **Filename:** `<component-name>.md`. Component name matches the path or
  module identifier in `MASTER.html §3` (e.g., `psr.md`, `cscv.md`,
  `validator-cell.md`, `paper-broker.md`).
- **Visual format:** dark-themed style consistent with `MASTER.html`. SVG
  diagrams over prose for data flow / dependencies. Inline tables for
  interface and config knobs.
- **Update trigger:** the component's interface changes, an ADR amends its
  contract, a new failure mode is documented in `check.md` that affects it,
  or a new dependency is introduced. Routine bug fixes do not trigger a doc
  rewrite.
- **Old versions:** preserved in git, not in the file. Don't accumulate
  "v1 / v2 / v3" sections — the latest is canonical, history is in `git log`
  and ADRs.

---

## Index (populated as components are documented)

| Status legend | Meaning |
|---|---|
| ✅ | Doc is current with code |
| ⚠️ | Doc exists but stale; component changed since last update |
| 📝 | Component exists in code, doc not yet written |
| 🆕 | Component planned but not built |

### Deflation pipeline (priority — these get docs first)

| Component | Path | Doc | Status |
|-----------|------|-----|--------|
| PSR / DSR | `src/lib/psr.ts` | `psr.md` | 📝 |
| CSCV / PBO | `src/lib/cscv.ts` | `cscv.md` | 📝 |
| HLZ haircut | `src/lib/hlzHaircut.ts` | `hlz-haircut.md` | 📝 |
| Slice metrics | `src/lib/sliceMetrics.ts` | `slice-metrics.md` | 📝 |
| Liquidity gate | `src/lib/liquidity.ts` | `liquidity.md` | 📝 |
| Strategy scorer | `scripts/score_strategies.ts` | `score-strategies.md` | 📝 |
| Validator core | `src/lib/validator.ts` | `validator.md` | 📝 |
| Validator cell | `src/lib/validator_cell.ts` | `validator-cell.md` | 📝 |

### Backtest engine

| Component | Path | Doc | Status |
|-----------|------|-----|--------|
| Indicators / runners | `src/lib/indicators.ts` | `indicators.md` | 📝 |
| Batch backtest | `scripts/batch_backtest.ts` | `batch-backtest.md` | 📝 |
| Worker | `scripts/batch_backtest_worker.ts` | `batch-backtest-worker.md` | 📝 |
| XSMOM engine | `scripts/batch_backtest_xsmom.ts` | `xsmom-engine.md` | 📝 |
| Cost stress | `scripts/cost_stress.ts` | `cost-stress.md` | 📝 |

### Data layer

| Component | Path | Doc | Status |
|-----------|------|-----|--------|
| ClickHouse client | `src/server/clickhouse.ts` | `clickhouse.md` | 📝 |
| Jupiter backfill | `scripts/jupiter_backfill.ts` | `jupiter-backfill.md` | 📝 |
| Coinbase backfill | `scripts/coinbase_backfill.ts` | `coinbase-backfill.md` | 📝 |
| Kraken backfill | `scripts/kraken_backfill.ts` | `kraken-backfill.md` | 📝 |
| Watch daemon | `scripts/watch_candles.ts` | `watch-candles.md` | 📝 |

### Net-new (Phase 2+)

| Component | Path | Doc | Status |
|-----------|------|-----|--------|
| Cluster characteristics | `src/lib/clusterCharacteristics.ts` | `cluster-characteristics.md` | 🆕 |
| PaperBroker | `src/lib/brokers/paper.ts` | `paper-broker.md` | 🆕 |
| LiveBroker | `src/lib/brokers/live.ts` | `live-broker.md` | 🆕 |
| Divergence monitor | `src/lib/divergenceMonitor.ts` | `divergence-monitor.md` | 🆕 |
| Cross-market recalibration | `scripts/cross_market_recalibrate.ts` | `cross-market-recalibrate.md` | 🆕 |

---

## Doc-writing order

Not every component needs a doc immediately. The producer writes per-component
docs in this order:

1. **First:** components touched by the active phase. Phase 1 = re-sweep, so
   `score-strategies.md`, `validator-cell.md`, `batch-backtest-worker.md`
   come first.
2. **Second:** deflation pipeline (the most failure-mode-rich set).
3. **Third:** new components introduced in Phase 2/3 — written as part of
   the SPEC + CODE for that phase.
4. **Last:** stable, low-failure-mode components (UI, simple ingest scripts).

This is "lazy documentation, eager when it matters." Writing all 25+ docs at
once produces stale prose; writing them as they're touched produces accurate
prose.
