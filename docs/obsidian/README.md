---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: index
---

# SignalForge — Obsidian Vault

A visual + explanatory map of the SignalForge / Vector Core project.

## How to open

1. Open Obsidian → **Open folder as vault** → pick this `docs/obsidian/` folder (or open the **repo root** to get the rest of `docs/` linked too).
2. Enable the **Canvas** core plugin if it isn't already (Settings → Core plugins → Canvas).
3. Open [[_Index]] first — it has the master flow diagram (Mermaid) and links to every segment.
4. Open `Architecture.canvas` for the spatial / block-diagram view.

## Vault layout

| File | What it is |
|---|---|
| [[_Index]] | Entry point. Full pipeline as a Mermaid flow + segment links. |
| `Architecture.canvas` | Visual canvas — every segment as a coloured node with arrows. |
| [[01 - Data Ingestion]] | FRED, CBOE put/call, Yahoo/Stooq, Sharadar, S&P 500 constituents. |
| [[02 - Storage (ClickHouse)]] | All `quantlab.*` tables and what writes/reads each. |
| [[03 - Backtest Engine]] | `batch_backtest`, strategy registry, scoring, walk-forward OOS. |
| [[04 - Regime Classifier (phase1_v3)]] | 6 categories, thresholds, ADR-038 baseline. |
| [[05 - Trade Execution Pipeline]] | The four gates (Allowlist → Regime → ML → LLM). |
| [[06 - Daemon (daily cadence)]] | `daemon:daily` — fetch → classify → evaluate → emit. |
| [[07 - Paper Trading & Monitoring]] | Track A, kill criteria, audit, morning brief. |
| [[08 - Dashboard UI]] | React app, `/#/regime`, panels, MASTER.html. |
| [[99 - Glossary]] | PBO, CSCV, DSR, allowlist, regime — quick definitions. |
| [gaps/](gaps/) | Phase 9+ candidate refinements (Layer 1/2/4 + Ops). Documentation-only; do not implement until Phases 5-8 ship. Companion to [docs/specs/regime-classifier-phase9-candidates.md](../specs/regime-classifier-phase9-candidates.md) (Layer 0). |
| [symbol-analysis/](symbol-analysis/) | 7-dimension manual playbook for evaluating a single ticker. Open [[symbol-analysis/quick-screen]] for a 15-min screen or [[symbol-analysis/worksheet-template]] for a full analysis. |

## Conventions

- Wikilinks `[[Name]]` cross-link between segments.
- Mermaid blocks render natively in Obsidian preview.
- Filenames have numeric prefixes so they sort in pipeline order in the file explorer.
- `.canvas` files are JSON — author by editing in Obsidian; this repo's checked-in one is the seed.

## Source-of-truth pointers

These docs **explain** the project; they are not authority. Authority lives in:

- [.claude/HANDOFF.md](../../.claude/HANDOFF.md) — current state of work
- [docs/specs/](../specs/) — component SPECs
- [docs/decisions/](../decisions/) — ADRs
- The code itself (`src/`, `scripts/`)

If an Obsidian doc contradicts those, the spec / code wins.
