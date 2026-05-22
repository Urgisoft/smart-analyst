---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: architecture
---

# Mermaid diagram templates — SignalForge vault

Copy-ready Mermaid blocks for the diagram types used most often in the vault.
Quartz v4's [ObsidianFlavoredMarkdown](https://github.com/jackyzha0/quartz/tree/v4/quartz/plugins/transformers/ofm.ts)
renders these to inline SVG; no extra plugin needed. The same blocks render in
Obsidian's preview pane unchanged.

> **Convention.** Use these as scaffolding — keep node labels short, fence with
> three backticks + `mermaid`, and prefer `flowchart LR` for pipelines and
> `flowchart TD` for hierarchies / decision trees. Match the in-use style in
> [`01 - Data Ingestion.md`](../obsidian/01%20-%20Data%20Ingestion.md) (LR, bracketed labels).

---

## 1. Data-flow pipeline (`flowchart LR`)

Use for ingest → snapshot → consumer chains. Bracketed labels are plain text;
`[A<br/>B]` line-breaks inside a node; `-.label.->` is a dotted edge (for
"gated" or "optional" data paths).

````mermaid
flowchart LR
    SRC[External source] -->|raw bytes| INGEST[scripts/foo_ingest.py]
    INGEST -->|validated rows| CH[(quantlab.foo_snapshots)]
    CH -->|read latest row| DAEMON[daemon:daily]
    DAEMON -->|render section| BRIEF[operator brief]
    SRC -.fallback.-> CACHE[cached last-good]
    CACHE --> DAEMON
````

## 2. Daemon stage flow (`flowchart TD`)

Top-down for decision trees where gates / branches matter more than left-right
ordering. Diamond shapes (`{label}`) mark decision points.

````mermaid
flowchart TD
    start([npm run daemon:daily]) --> fetch[macro fetch + classify]
    fetch --> eval[evaluate cells × allowlist]
    eval --> g1{on allowlist?}
    g1 -->|no| skip1[skip]
    g1 -->|yes| g2{regime ok?}
    g2 -->|no| skip2[skip]
    g2 -->|yes| open[open paper position]
    open --> tg[Telegram alert]
    skip1 --> log[(daemon_runs)]
    skip2 --> log
    tg --> log
````

## 3. Stage-state machine (`stateDiagram-v2`)

Use for explicit FSM docs. Each transition is `A --> B: trigger`.

````mermaid
stateDiagram-v2
    [*] --> s1_research
    s1_research --> s2_spec: SPEC drafted
    s2_spec --> s3_code: CODE
    s3_code --> s4_paper: paper-trade Phase A
    s4_paper --> s5_real: 30-day verdict pass
    s4_paper --> s_kill: drawdown breach
    s5_real --> [*]
    s_kill --> [*]
````

## 4. Ingest sequence (`sequenceDiagram`)

Use when the order of API calls / inter-service messages matters more than the
shape of the data flow. Each `participant` becomes a vertical lane.

````mermaid
sequenceDiagram
    participant CLI as scripts/foo_ingest.py
    participant API as External API
    participant CH as ClickHouse
    CLI->>API: GET /filings?since=2026-05-20
    API-->>CLI: JSON page 1..N
    CLI->>CLI: parse_response() + schema_validate()
    CLI->>CH: INSERT INTO quantlab.foo_snapshots
    CH-->>CLI: ack
    CLI->>CLI: log "wrote N rows"
````

## 5. Phase-9+ gap rollout (`gantt`)

Use for slice / arc planning. Dates are ISO `YYYY-MM-DD`. Sections group by
phase or owner. Tasks marked `done` get a checkmark; `active` is current;
default is upcoming.

````mermaid
gantt
    title Phase 9+ gap rollout
    dateFormat  YYYY-MM-DD
    section Done
    gap #10 short-interest      :done, gap10, 2026-04-15, 2026-05-01
    gap #8  executive-departure :done, gap8,  2026-05-01, 2026-05-08
    gap #9  etf-flow            :done, gap9,  2026-05-10, 2026-05-15
    gap #7  EK + F4 arcs        :done, gap7,  2026-05-15, 2026-05-22
    ADR-041 yield-curve         :done, a41,   2026-05-21, 2026-05-22
    section Next
    Quartz docs site            :active, qz,  2026-05-22, 5d
    Per-EVENT EK recency        :        evk,  after qz, 3d
    ETF.com cross-validation    :        etf2, after evk, 5d
````

---

## How to add a diagram to a doc

1. Pick the template above that fits the shape of what you're showing.
2. Paste the `mermaid`-fenced block where it goes in the doc.
3. Rename nodes; trim to ≤ 8 nodes per diagram (anything denser is hard to
   read in the rendered SVG — split into two diagrams).
4. Preview via `npm run docs:serve` — open `http://localhost:8080/<doc-slug>`
   and check that the diagram renders. Obsidian's preview pane shows the same
   render, so you can iterate there too.
5. Commit. The diagram is part of the doc; no separate asset file.

## Mermaid features Quartz v4 supports out of the box

- `flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `gantt`, `classDiagram`,
  `pie`, `journey`, `erDiagram`, `mindmap`, `timeline`, `quadrantChart`.
- `<br/>` line-breaks inside node labels.
- Click handlers via `click NodeId href "https://…"` — used sparingly; the
  vault prefers regular Markdown links in the surrounding prose.

## Watch-outs

- **Long labels** wrap awkwardly in flowcharts at narrow widths. Keep node
  labels ≤ ~40 chars; put the explanation in the prose around the diagram.
- **Mermaid syntax errors** fail silently in some renderers — Quartz emits
  a visible error block which is what we want, but Obsidian's preview shows
  a generic "Error rendering diagram." Iterate via `docs:serve` if a diagram
  doesn't appear.
- **Color/theme** is intentionally NOT pinned per-diagram. Quartz's light/dark
  toggle re-themes Mermaid automatically. Hand-setting `classDef` overrides
  this and breaks dark mode.
