---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: architecture
---

# Vault conventions — how to use `docs/`

This file explains how the SignalForge vault is structured, how frontmatter
drives the status dashboard, and how to add new docs without breaking the
build. Read this once after cloning; refer back when adding a doc or
reorganizing.

## What lives where

```
docs/
├── conventions.md            ← this file
├── dashboard.md              ← AUTO-GENERATED — do not hand-edit
├── _templates/
│   └── mermaid-templates.md  ← copy-ready Mermaid scaffolds
├── obsidian/                 ← architecture + gaps + symbol-analysis index
│   ├── 01 - Data Ingestion.md
│   ├── 02 - Storage (ClickHouse).md
│   ├── … (03..08, 99 - Glossary)
│   ├── _Index.md             ← top-level navigation
│   └── gaps/                 ← Phase 9+ gap tracker (one doc per gap)
├── specs/                    ← SPECs + ADRs (adr-NNN-*.md)
├── decisions/README.md       ← ADR index pointing into specs/adr-*.md
├── analysis/                 ← one-off analytical write-ups
├── recap/                    ← session-spanning strategic recaps
├── reviews/                  ← critic / review notes
├── experiments/              ← experiment SUMMARY.md per run
├── teach/                    ← teach-doc protocol output (YYYY-MM-DD-slug.md)
├── components/               ← UI / dashboard component docs
├── phase1_breadth_restoration/
├── phase2_procedure_artifacts/
└── phase2_rv5d_diagnostic/
```

**Single source of truth.** The Markdown files under `docs/` ARE the project
state. The rendered Quartz site (`docs/.quartz-site/`) and the auto-generated
dashboard (`docs/dashboard.md`) are derived; both are gitignored and rebuild
on demand.

## Frontmatter schema

Every load-bearing doc (architecture + ADR + spec + gap + recap + review +
analysis + index) carries a YAML head block. Pattern:

```yaml
---
status: active            # required — see status vocabulary below
phase: phase 9+           # required — lifecycle tag (free-form)
last_updated: 2026-05-21  # required — ISO date YYYY-MM-DD
owner: pejman             # required — single string
type: spec                # required — see type vocabulary below
slice_id: gap-7-event-driven-filings  # optional — links to a slice / arc
depends_on:               # optional — array of vault-relative paths
  - docs/obsidian/gaps/event-driven-filings-processor.md
---
```

### Status vocabulary

The dashboard sorts buckets in this order:

| status | meaning |
|---|---|
| `active` | currently being worked on |
| `accepted` | ADR ratified; SPEC in flight |
| `research` | exploratory RESEARCH note, not yet a SPEC |
| `proposed` | ADR drafted, awaiting accept/reject |
| `draft` | SPEC in progress, not yet final |
| `done` | shipped end-to-end (ingest → snapshot → daemon → brief) |
| `partially-superseded` | partly replaced by a later ADR; SEE the supersession note |
| `superseded` | fully replaced; kept for git-history context only |
| `paused` | work stopped; resume requires re-evaluating context |
| `deferred` | scope-deferred to a later phase |

### Type vocabulary

| type | what it is |
|---|---|
| `index` | navigation page (README, `_Index.md`) |
| `architecture` | obsidian/01..08, glossary, conventions, critic workflow |
| `spec` | SPEC under `specs/` |
| `adr` | Architecture Decision Record (`specs/adr-NNN-*.md`) |
| `gap` | Phase 9+ gap entry (`obsidian/gaps/*.md`) |
| `review` | critic / review notes |
| `recap` | session-spanning strategic recap |
| `analysis` | one-off analytical write-up |
| `experiment` | experiment SUMMARY.md |
| `glossary` | term definitions |
| `teach` | teach-doc protocol output |

### Adding frontmatter to new docs

Two paths:

1. **Hand-add** the block at the top of the file. Use the template in this doc.
2. **Bulk-add** by extending `scripts/_apply_docs_frontmatter.ts` with new
   entries and running `npx tsx scripts/_apply_docs_frontmatter.ts`. Idempotent:
   files that already start with `---` are left alone.

## The dashboard

`docs/dashboard.md` is the at-a-glance status view. It is **generated** by
[scripts/generate_docs_dashboard.ts](../scripts/generate_docs_dashboard.ts) on
every `npm run docs:build` and `npm run docs:serve`. Three sections:

1. **By status** — bucketed by `status:` field; active first, then accepted /
   research / draft / done / superseded / deferred.
2. **By type** — adr / spec / gap / etc.
3. **By phase** — sorted alphabetically; useful for "show me everything in
   phase 9+" or "what's still in phase1_v3 work?"

Files without frontmatter land in an "Unclassified" bucket so drift is visible.

> **Never hand-edit `docs/dashboard.md`.** It is overwritten on every build. To
> change what it shows, edit the source doc's frontmatter and re-run
> `npm run docs:dashboard`.

## Build + serve commands

| Command | What it does |
|---|---|
| `npm run docs:install` | one-time install of the vendored Quartz toolchain (run after `git clone`) |
| `npm run docs:dashboard` | regenerate `docs/dashboard.md` only |
| `npm run docs:build` | regen dashboard → Quartz build → `docs/.quartz-site/` |
| `npm run docs:serve` | regen dashboard → Quartz serve at `http://localhost:8080` with file watcher |
| `npm run dev:all` | run the dashboard app (`:3000`) AND Quartz docs (`:8080`) in parallel |

The `docs:serve` watcher picks up Markdown edits live, but the dashboard is
only regenerated at startup (the watcher is Quartz's, not ours). Restart
`docs:serve` after a frontmatter edit to refresh the dashboard view.

## Diagrams (Mermaid)

The vault renders Mermaid via Quartz's `ObsidianFlavoredMarkdown` plugin —
no setup required, just fence a block with ` ```mermaid`. See
[docs/_templates/mermaid-templates.md](_templates/mermaid-templates.md) for
the canonical SignalForge scaffolds (flowchart, sequence, state, gantt).

Existing inline diagrams to look at as examples:

- [01 - Data Ingestion.md](obsidian/01%20-%20Data%20Ingestion.md) — data flow `flowchart LR`
- [06 - Daemon (daily cadence).md](obsidian/06%20-%20Daemon%20(daily%20cadence).md) — stage flow `flowchart TD` with decision gates
- [gaps/README.md](obsidian/gaps/README.md) — status overview with subgraphs

## Watch-outs

- **Don't commit `docs/dashboard.md` or `docs/.quartz-site/`.** Both are
  gitignored on purpose; the source of truth is each doc's own frontmatter
  + the generator + Quartz.
- **The dashboard generator's YAML parser is intentionally shallow.** It
  handles scalars + the single `depends_on:` array form. Don't introduce
  YAML anchors, nested maps, or non-string scalar values without extending
  the parser AND its test (`scripts/tests/generateDocsDashboard.test.ts`).
- **Mid-doc `---` lines are NOT frontmatter.** The parser only opens on
  `---\n` at byte 0 — every spec doc uses `---` mid-document as a section
  separator, and the parser correctly ignores those. If you add frontmatter
  to an existing doc, prepend the block; don't insert it after the title.
- **`docs:serve` does NOT auto-regen the dashboard on frontmatter edits.**
  Restart `docs:serve` after editing a frontmatter block to see the new
  dashboard. Edits to doc bodies / Mermaid / prose pick up live.
- **The vendored Quartz lives under `quartz/`** with its own `node_modules/`.
  Run `npm run docs:install` once after cloning before the first `docs:build`.
- **The autonomous frontmatter-rollout script (`scripts/_apply_docs_frontmatter.ts`)
  is `_`-prefixed** so it stays out of `npm run help` listings. It's a one-shot
  tool — extend its `ENTRIES` array if you need to add frontmatter to a batch
  of new docs and re-run.

## Why Quartz over alternatives

Picked over Docusaurus / MkDocs / VitePress at s95 #4 architecture lock-in
because:

1. **Obsidian-compatible.** The vault renders identically in Obsidian's
   preview pane and in the Quartz site — same Markdown, same wikilinks
   (`[[wiki-style]]`), same Mermaid blocks. Zero translation cost.
2. **No file moves.** Quartz reads `docs/` in place; the vault structure
   doesn't change to accommodate it.
3. **Single source of truth.** Vault Markdown ARE the canonical files;
   the rendered site is purely derived. No DB, no CMS, no JSX intermediate.
4. **Backlinks + graph view.** Free out of the box — surfaces cross-document
   dependencies that the text-only `depends_on:` field can't show alone.

The trade-off is that Quartz has a large dependency footprint (~480 packages
under `quartz/node_modules/`). Mitigated by vendoring the whole toolchain
under `quartz/` so the root project stays slim and the docs setup is
isolated.
