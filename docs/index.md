---
status: active
phase: phase 9+
last_updated: 2026-05-22
owner: operator
type: index
---

# SignalForge — Vector Core docs

The full, auto-generated table of contents lives at **[Status Dashboard](dashboard.md)** — that's the canonical entry point and is regenerated on every `npm run docs:build`.

## Quick links

- **[Status Dashboard](dashboard.md)** — every doc, grouped by status / phase / slice
- **[Vault conventions](conventions.md)** — how `docs/` is organized + frontmatter contract
- **[Critic-agent workflow](critic_workflow.md)** — how component-done critiques run

## Top-level sections

- **[Obsidian vault — Master Index](obsidian/_Index.md)** — system architecture, by stage of the pipeline
- **[Specs](specs/phase-1-targeted-resweep.md)** — SPECs for every Layer-0 composite + Phase 2 work
- **[Decisions log (ADRs)](decisions/README.md)** — every architecture decision, accepted or rejected
- **[Teach-docs](teach/2026-05-20-event-driven-filings-architecture.md)** — concept explainers persisted from [TEACH] events
- **[Gaps — Phase 9+ candidates](obsidian/gaps/README.md)** — outstanding component gaps + their status
- **[Components](components/README.md)** — per-component dashboards + handoff notes

## Operational

The vault is served by Quartz. See [conventions.md](conventions.md) for editing rules, the frontmatter contract, and how the dashboard is regenerated.
