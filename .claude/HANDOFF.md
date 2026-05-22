# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 95 #6 — **Quartz docs site slice LIVE**: 5 commits / 348 files / ~38.9k insertions (293 vendored Quartz files + ~55 SignalForge ones); ~646 LOC of new TS across `scripts/_apply_docs_frontmatter.ts` + `scripts/generate_docs_dashboard.ts` + `scripts/tests/generateDocsDashboard.test.ts`. Slice commits `437332b → 25d0ff0 → 92f2719 → e5b50b9 → eac2561` on top of `4406674` (ADR-041). The vault under `docs/` is now Quartz-rendered at `npm run docs:serve` → `http://localhost:8080`, with 50 priority docs carrying YAML frontmatter, an auto-generated status dashboard at `docs/dashboard.md` (gitignored — regenerated on every build), 5 canonical Mermaid templates under `docs/_templates/`, and a vault-conventions doc at `docs/conventions.md`. Quartz v4.5.2 vendored at `quartz/` — operator-pending `npm run docs:install` once to populate `quartz/node_modules/` before first build. **52 commits ahead of `origin/main`.** **NEXT default on `continue`: operator pick — recommended slice if operator says only "continue": per-EVENT EK recency (§8.1 "12d ago + 18d ago") OR Gap #9 v2 ETF.com cross-validation; both pre-scoped.**)

## What this slice delivered

Materializes the Quartz docs site that's been operator-queued since s95 #4. Vault is the single source of truth; the rendered site + auto-generated dashboard are derived. Architecture lock-ins from s95 #4 (S95-20..S95-23) all hold as designed; no plan drift.

### Commit chain (s95 #6a..#6e)

1. **`437332b` — install + config + scripts.** Scaffolds Quartz v4.5.2 under `quartz/` via degit; customizes `quartz.config.ts` (SignalForge branding, analytics:null, baseUrl localhost:8080, ignorePatterns extended); adds 4 root npm scripts (`docs:build`, `docs:serve`, `docs:install`, `dev:all`); installs `concurrently@^9` as root devDep for the parallel `:3000 + :8080` pattern; adds `docs/.quartz-site/` + `quartz/.quartz-cache/` to `.gitignore`; explicit `exclude` block added to root `tsconfig.json` (quartz/, dist, build, node_modules, docs/.quartz-site/) so root `tsc` no longer scans Quartz's vendored source (would surface 4 false errors). EXTRA_HELP entries land in `scripts/help.ts` for the 4 new scripts.

2. **`25d0ff0` — frontmatter rollout to 50 priority docs.** `scripts/_apply_docs_frontmatter.ts` (one-shot, idempotent — `_`-prefixed so help.ts auto-discovery skips) prepends YAML frontmatter to the load-bearing doc set: 11 core architecture (obsidian/01..08 + 99 + README + _Index), 14 gaps (with status mapped to slice state: done × 4, active × 6, deferred × 3, partially-superseded × 1), 3 ADRs + decisions index, 16 specs, 6 misc (recaps × 2, reviews × 2, analysis × 1, components README, critic workflow). Schema per S95-21: `status / phase / last_updated / owner / type / [slice_id] / [depends_on]`. Re-running the script after the first pass writes 0 / skips 50.

3. **`92f2719` — dashboard generator + 12 fixture tests.** `scripts/generate_docs_dashboard.ts` walks `docs/`, parses each file's YAML frontmatter (hand-rolled shallow parser: scalars + `depends_on:` block sequence; mid-doc `---` lines never misread as frontmatter — only opens on `---\n` at byte 0), groups entries by status → type → phase, and emits `docs/dashboard.md`. Chained into `docs:build` / `docs:serve` as a pre-step (`tsx scripts/generate_docs_dashboard.ts && npm --prefix quartz run signalforge:build`); standalone alias `docs:dashboard` for incremental regen. Dashboard is GENERATED state — gitignored alongside `docs/.quartz-site/`. Source of truth is each doc's own `---` block. `scripts/tests/generateDocsDashboard.test.ts` pins the contract: 12 tests / 4 suites (parseFrontmatter × 4 — including the mid-doc-`---` false-positive guard; extractTitle × 2; groupBy × 2; renderDashboard × 4). Pure functions, no FS, no CH; <200ms.

4. **`e5b50b9` — Mermaid chart templates.** `docs/_templates/mermaid-templates.md` — copy-ready scaffolds for the 5 diagram types the vault uses most (data-flow `flowchart LR`, daemon stage `flowchart TD`, stage-state `stateDiagram-v2`, ingest `sequenceDiagram`, rollout `gantt`). Plus a "how to add a diagram" walkthrough + Mermaid-features-Quartz-supports list + 3 watch-outs. Proof-of-concept inline diagram added to `docs/obsidian/gaps/README.md` (subgraph status overview showing done / active / deferred buckets). Vault style match (flowchart LR, bracketed labels, `<br/>` in-node line breaks) — vault already had 9 Mermaid blocks across obsidian/01..08 + _Index.

5. **`eac2561` — conventions doc.** `docs/conventions.md` — the "how to use the vault" reference. Covers directory layout, frontmatter schema with full status / type vocabularies, dashboard contract (never hand-edit warning), all 5 npm scripts, diagram authoring + pointer at `_templates/`, 6 watch-outs (gitignored dashboards, shallow YAML parser, mid-doc `---`, serve-mode dashboard-staleness, vendored Quartz install step, `_`-prefixed rollout script), and a "why Quartz over Docusaurus / MkDocs / VitePress" tradeoff record.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted + implementation LIVE | ✓ s89c#2 + s95 #5 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH | ✓ s94 #1-#5 |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| Gap #7 v2 sell-cluster F4 composite contract | ✓ s95 #1 (`b398b4e`) |
| Gap #7 v2 sell-cluster F4 G3 (DDL + persistence + log + render) | ✓ s95 #2 (`d05eb39`) — F4 ARC FULLY CLOSED |
| Form 4 ingest XML body URL discovery (hotfix) | ✓ s95 #3 (`831b1b0`) |
| Gap #7 v2 per-row recency (F4 daysSinceLatestBuy/Sell) | ✓ s95 #4 (`b3d63a2`) |
| ADR-041 implementation | ✓ s95 #5 (`4406674`) |
| **Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions** | **✓ s95 #6 (5 commits `437332b..eac2561`) LIVE** |
| Gap #7 v2 per-EVENT EK recency (§8.1 "12d ago + 18d ago" per-item format) | ☐ deferred — operator-pickable, RECOMMENDED next default |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 52 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 #6 (this slice, 5 commits)

**S95-29. Quartz v4.5.2 is vendored under `quartz/` (NOT installed as an npm dep).**
`Why:` Quartz v4 ships as a self-contained Node.js project — a scaffold, not a library. The official install path per upstream docs is `git clone github.com/jackyzha0/quartz && npm install`. Vendoring keeps the full toolchain reproducible (no version drift between operator machines / future clones) at the cost of ~280 committed source files. Alternative (sibling-clone outside the project root) was rejected because it puts the toolchain outside `git ls-files` — anyone cloning the SignalForge repo would have to know to also clone Quartz separately.

`How to apply:` Future docs-site upgrades = re-degit Quartz over the existing `quartz/` folder, diff `quartz.config.ts` / `quartz/package.json` for any customizations, re-apply, run `npm run docs:install`. Don't try to npm-install Quartz at root; it's not a library and you'll thrash the dep tree.

**S95-30. `docs/dashboard.md` is GENERATED state — gitignored alongside `docs/.quartz-site/`.**
`Why:` The dashboard is purely derived from per-doc frontmatter. Committing it would create per-build diff churn AND would drift unless every doc-edit is paired with a regeneration commit. The trade-off — the dashboard isn't visible on raw-GitHub browse — is acceptable because the live-served vault (`npm run docs:serve` → `http://localhost:8080`) is the canonical view. The repo's job is to carry SOURCE; rendered views live on demand.

`How to apply:` Future auto-generated vault files (e.g. a generated ADR-index, a generated test-coverage map, a generated cross-link audit) follow the same posture: gitignore them, regenerate on `docs:build`. The convention doc (`docs/conventions.md`) explicitly calls this out as the vault rule.

**S95-31. The dashboard generator's YAML parser is hand-rolled and deliberately shallow (scalars + `depends_on:` block sequence only).**
`Why:` Pulling in `gray-matter` at the root would double the test surface (need to test gray-matter's behavior under our schema invariants) and inflate the dep tree. The hand-rolled parser is ~70 LOC, covers the closed schema, and is testable on its own. The only-opens-on-`---\n`-at-byte-0 invariant is the single most-load-bearing guard — every spec doc in the vault uses mid-document `---` as section separators; misreading those as frontmatter would corrupt the dashboard. Test `T-PARSE-4` pins this explicitly.

`How to apply:` Schema extensions (e.g. nested maps for `related:` or anchors for shared fields) need the parser + its test to be extended TOGETHER. The closed-schema posture is by design; widen only when the schema actually grows.

**S95-32. Frontmatter rollout target = 50 load-bearing docs (out of 114 total in the vault), NOT all docs.**
`Why:` Teach docs (~30 files), phase artifacts (`phase1_breadth_restoration/`, `phase2_*/RESULT.md`), symbol-analysis worksheets, and `experiments/*/SUMMARY.md` are point-in-time artifacts — they don't change status or phase over their lifetime. Adding frontmatter to them would be noise on the dashboard. The rollout script's `ENTRIES` array is the canonical "what's load-bearing" list; extend it when a NEW doc needs to land on the dashboard, NOT to back-fill stale point-in-time files.

`How to apply:` Files that should appear on the dashboard get frontmatter; files that are "snapshot of a moment" don't. The dashboard's "Unclassified (no frontmatter)" bucket surfaces drift, so misses are visible.

**S95-33. `docs:serve` does NOT auto-regen the dashboard on frontmatter edits.**
`Why:` The pre-step `tsx scripts/generate_docs_dashboard.ts && …` runs exactly once at startup. Quartz's own file watcher handles all subsequent re-renders of doc bodies + Mermaid + prose, but it doesn't know about our generator. Building a custom watcher (chokidar over `docs/**/*.md` re-running the generator on YAML-block changes) would be ~30 LOC + a debounce + another test surface. Not worth it for v1; the operator restart cost is small.

`How to apply:` After editing a `---` block during `docs:serve`, kill and restart serve (or run `npm run docs:dashboard` separately to regen, then refresh the browser tab). The conventions doc and the dashboard generator's own header note both call this out.

**S95-34. `concurrently` is the dev-mode-only multiplexer (`dev:all`); NOT a production dep.**
`Why:` `concurrently@^9` lives in root `devDependencies` because the only consumer is the `dev:all` script (parallel `:3000 app + :8080 docs`). Nothing in the deployed app touches it. Keeping it dev-only avoids inflating the production bundle.

`How to apply:` Future parallel-dev patterns use the same idiom — `concurrently -n a,b -c blue,green "npm:scriptA" "npm:scriptB"`. Don't reach for `npm-run-all`, `pm2`, or shell-script wrappers; `concurrently` is the standing pick.

**Carry-over from s95 #5 (still in force):** S95-24..S95-28 — ADR-041 "Replace in place" canon; `INPUTS_MISSING_T10Y3M` bit value 64; new column is `Nullable(UInt8)`; `T10Y3M_PREFIX_DAYS = 35`; counter null policy.

**Carry-over from s95 #4 (still in force):** S95-15..S95-23 — F4 per-row recency; Quartz vault scope + build-time TS generator + `type` field; single-source-of-truth.

**Carry-over from s95 #3 (still in force):** S95-11..S95-14 — EDGAR Form 4 body URL discovery contract.

**Carry-over from s95 #2 (still in force):** S95-6..S95-10 — sell-side persistence + render conventions.

**Carry-over from s95 #1 (still in force):** S95-1..S95-5 — sell-cluster composite parameters.

**Carry-over from s94 #11 (still in force):** S94-29..S94-33 — sector cluster rate, daemon log line tokens.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-33 + S95-1..S95-28 carry through.

## Open questions

### Newly opened (s95 #6) — none

The slice was fully autonomous within the pre-locked s95 #4 architecture. The only decisions that needed forking (commit dashboard to git vs gitignore — S95-30; hand-rolled vs gray-matter parser — S95-31; frontmatter rollout scope — S95-32) all had clear three-criterion-test answers and were resolved without operator pause.

### Carried from s95 #3

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default.

### CARRIED (unchanged)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- Push commits to origin/main — operator-gated.
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

## Next stage

### Default on `continue` — operator pick

The Quartz docs site arc is closed end-to-end. Operator picks the next slice. If they just say "continue" with no context, the recommended default is **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format) — this is the only remaining piece of the gap #7 v2 arc that didn't ship in s95 #4. Modest scope (~3 files, ~80 LOC, ~5-6 tests), high signal value (closes the v2 EK side end-to-end), no operator-pending dependencies. If the operator prefers a non-EK slice, the next-best default is **Gap #9 v2 ETF.com/issuer-CSV cross-validation** (also pre-scoped).

### Candidate slices (in rough order of "next obvious code-only work")

1. **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format) — RECOMMENDED default. Separate row shape: `eventsByItemCode: Array<{itemCode: string, daysSinceLatest: number}>` on the EK per-ticker row. Renderer extends `formatEightKItemList` to interleave the per-item recency. ~3 files, ~80 LOC, ~5-6 tests.

2. **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — adds a secondary data path that cross-validates the primary etf-flow ingest against an issuer-supplied CSV when available; logs divergences as anomalies. ~4 files, ~150 LOC, ~8-10 tests.

3. **Gap #7 v2 13D/13G arc** — needs its own SPEC first; deferred until operator says go.

4. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

5. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

6. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

7. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

8. **Extend the Quartz docs site** — operator-pickable refinements:
   - Add a home-page `docs/index.md` (Quartz currently warns about its absence).
   - Add live dashboard regen to `docs:serve` via chokidar (S95-33 deferral).
   - Promote ADR-040 from `research` → `accepted` once the operator decides on correlation-weighted allocation.
   - Frontmatter extend to teach docs (currently 0 / ~30 carry frontmatter) so they show on the dashboard's "By type" view.

### Operator-gated action items (carried + NEW from this turn)

- **NEW (s95 #6): Run `npm run docs:install` once** — populates `quartz/node_modules/` (~480 packages, ~10s). Without this, `docs:build` / `docs:serve` / `dev:all` fail at the Quartz invocation step. One-time per clone.
- **NEW (s95 #6): Operator can now `npm run docs:serve`** at `http://localhost:8080` to browse the vault with backlinks + graph view + Mermaid rendering. `npm run dev:all` runs the dashboard app (:3000) AND Quartz docs (:8080) in parallel.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` — UNBLOCKED s95 #3; produces real F4 cluster_buy / cluster_sell rows with "last Xd" recency hints visible in the morning brief.
- (carried) Apply the operator-pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED — base table absent in operator's local CH).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3, carry from s94 #8).
- (carried) Push 52 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this slice (s95 #6 — 5 commits)

| Path | LOC | Notes |
| --- | --- | --- |
| `quartz/` (293 vendored files) | ~38,000+ | Quartz v4.5.2 toolchain vendored via degit. Branding customized in `quartz/quartz.config.ts` (SignalForge title, localhost:8080 baseUrl, analytics:null, extended ignorePatterns); `quartz/package.json` carries 2 new scripts (`signalforge:build`, `signalforge:serve`) invoking `./quartz/bootstrap-cli.mjs` directly. |
| `scripts/_apply_docs_frontmatter.ts` | +182 | One-shot, idempotent frontmatter rollout. `_`-prefixed (out of help.ts auto-discovery). 50 entries in `ENTRIES`; extend to back-fill more docs. Re-running writes 0 / skips 50 once the rollout has run. |
| `scripts/generate_docs_dashboard.ts` | +281 | Walks `docs/`, parses frontmatter, emits `docs/dashboard.md`. Exports `parseFrontmatter / extractTitle / walkMarkdown / loadDocs / groupBy / renderDashboard` for fixture tests. `help` export wires the `docs:dashboard` alias into check:help. |
| `scripts/tests/generateDocsDashboard.test.ts` | +183 | 12 tests / 4 suites pinning the generator contract. Pure functions, no FS, <200ms. |
| `docs/_templates/mermaid-templates.md` | +120 | 5 copy-ready Mermaid scaffolds + walkthrough + watch-outs. |
| `docs/conventions.md` | +194 | Vault-conventions reference. |
| `docs/` (50 priority files) | +~600 | YAML frontmatter prepended via the rollout script. Schema per S95-21. |
| `docs/obsidian/gaps/README.md` | +~30 | Inline status-overview Mermaid subgraph (done / active / deferred). |
| `package.json` | +5 | 5 root scripts + `concurrently@^9` devDep. |
| `tsconfig.json` | +7 | Explicit `exclude` block. |
| `.gitignore` | +10 | `docs/.quartz-site/`, `quartz/.quartz-cache/`, `docs/dashboard.md`. |
| `scripts/help.ts` | +4 | EXTRA_HELP entries for `dev:all`, `docs:install`, `docs:build`, `docs:serve`. |

### Carried unchanged from s95 #5 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/macro_regime_v3.ts` | s95 #5 LIVE | T10Y3M throughout; new helpers. |
| `src/server/clickhouse.ts` | s95 #5 LIVE | `yield_curve_inversion_days_20d` ALTER auto-applies. |
| `src/server/regime_dashboard.ts` | s95 #5 LIVE | BIAS_NOTE_PHASE1_V3 reworded. |
| `docs/specs/macro-regime-classifier-phase1_v3.md` | s95 #5 LIVE + s95 #6 frontmatter | PARTIALLY SUPERSEDED header; now carries frontmatter. |
| `scripts/tests/macroRegimeV3.test.ts` | s95 #5 LIVE | 58 pass under ADR-041 canon. |

### CH state (unchanged from s95 #5)

- `quantlab.macro_regimes` gains `yield_curve_inversion_days_20d Nullable(UInt8)` on next daemon startup (idempotent migration).
- `quantlab.macro_regimes.yield_curve_value` carries mixed T10Y2Y / T10Y3M semantic across the ADR-041 cut until operator runs `npm run macro:backfill:v3`.
- Nine Layer-0 composite snapshot tables + three event tables.
- Operator-pending ALTERs unchanged from s95 #5.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/generateDocsDashboard.test.ts    # 12 pass / 0 fail (NEW this slice)
npm test                                                       # TS — 2902 / 2901 pass / 1 fail / 28 skipped (+12 net vs s95 #5)
                                                               # 1 fail = pre-existing CH-unreachable gicsSectorRepositoryHelper SMP-6
npx tsc --noEmit                                               # 13 baseline errors unchanged
npm run check:help                                             # green
npm run docs:build                                             # 295 emitted from 113 inputs in ~14s
```

`pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s95 #6)

- **`docs/dashboard.md` is gitignored — never check it in.** It's auto-generated on every `docs:build` from per-doc frontmatter. Source of truth = each doc's own `---` block. Operators who try to hand-edit it will see their changes overwritten on the next build (the conventions doc + the dashboard's own generated header both warn loudly).

- **The dashboard generator's parser ONLY opens on `---\n` at byte 0.** This is the single most-load-bearing invariant — every spec doc in the vault uses mid-document `---` as a section separator. Test `T-PARSE-4` (`returns null when the only --- lines are mid-document thematic breaks`) pins this; do not relax the byte-0 check without rewriting the test.

- **The frontmatter rollout script's `ENTRIES` array is the canonical "what's load-bearing" list.** Files that appear on the dashboard get an entry; files that are "snapshot of a moment" (teach docs, phase artifacts, experiment SUMMARYs, symbol-analysis worksheets) don't. New ADRs / specs / gaps that need to land on the dashboard MUST get either (a) a hand-added frontmatter block, or (b) an entry in the rollout script. Misses surface in the "Unclassified" bucket but are otherwise silent — periodically scan that bucket.

- **`docs:serve` does NOT auto-regen the dashboard on frontmatter edits.** The pre-step generator runs once at startup. After editing a `---` block during a serve session, restart serve OR run `npm run docs:dashboard` separately to refresh. The convention doc + dashboard generator's own header note both call this out.

- **Quartz's vendored source MUST stay excluded from root `tsc`.** `tsconfig.json` has an explicit `exclude` block adding `quartz/` because Quartz's own source carries 4 baseline TS errors against the root config (incompatible `lib` config, missing `remark-parse/lib` types, etc.). Removing the exclude would inflate the baseline error count from 13 to 17. Quartz has its own `tsconfig.json` at `quartz/tsconfig.json` that handles its source correctly.

- **`npm run docs:install` must run once per clone.** Without it, `quartz/node_modules/` is empty and `docs:build` fails immediately at the `./quartz/bootstrap-cli.mjs` invocation. The conventions doc warns about this; the `docs:install` script alias is the standing recipe.

- **The Quartz build warns "missing index.md home page file at the root of docs/".** Harmless for `docs:serve` (lands on a directory listing or the first nav entry) but would matter for a deployed static site. Not in scope for v1; flagged as a Quartz-extend slice option if operator wants to deploy publicly.

- **The pre-existing `gicsSectorRepositoryHelper SMP-6 EXPLAIN PLAN` test failure is NOT a regression.** Same CH-unreachable failure as s95 #4 + #5. NOT in s95 #6 scope.

### Carried from s95 #5 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- `yield_curve_value` mixed-semantic across the ADR-041 cut until backfill.
- `MacroRegimeRowV3.yield_curve_inversion_days_20d` is REQUIRED on every row constructor.
- `INPUTS_MISSING_T10Y3M` reuses bit value 64.
- F4 recency uses `acceptedAt` not `transactionDate` (S95-15).
- `Form4InsiderPerTickerRow` carries 2 REQUIRED recency fields.
- EK per-EVENT recency STILL deferred (recommended next default slice).
- Composite source files have `\0` literals (carried).
- §1.4 three-branch order is load-bearing.

(All earlier s89-s95 #5 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### NEW (s95 #6) — Quartz docs site

```text
npm run docs:install                                    # ONE-TIME per clone — populates quartz/node_modules/
npm run docs:build                                      # one-shot — regen dashboard.md → Quartz → docs/.quartz-site/
npm run docs:serve                                      # serve at http://localhost:8080 with file-watcher reload
npm run docs:dashboard                                  # regen dashboard.md only (no Quartz)
npm run dev:all                                         # dashboard app (:3000) + Quartz docs (:8080) in parallel
```

### macro_regime_v3 — re-backfill to rewrite historical T10Y2Y rows under T10Y3M (operator-pending)

```text
npm run macro:backfill:v3
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3
npm run migrate:create-form-4-insider-snapshots:apply   # REQUIRED
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE; per-row daysSinceLatestEvent ALREADY LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow activation (FULLY READY)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2902 / 2901 pass / 1 fail / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 332 pass at s95 #3 close (unchanged)
npx tsx --test scripts/tests/generateDocsDashboard.test.ts                     # 12 pass — NEW this slice
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #6 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 295 emitted from 113 inputs
```

## For the next session — priority order

**Default on `continue`:** operator picks the next slice. If they just say "continue" with no context, the recommended default is **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format) — the only remaining piece of the gap #7 v2 arc that didn't ship in s95 #4. ~3 files, ~80 LOC, ~5-6 tests.

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6` failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the default-next:

- **Gap #7 v2 per-EVENT EK recency** (recommended default).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions** (home-page index.md, live dashboard watcher, teach-doc frontmatter rollout, promote ADR-040 status).

**Operator-gated action items (carried + NEW):**

- **NEW (s95 #6): `npm run docs:install`** — ONE-TIME per clone; populates `quartz/node_modules/` so `docs:build` / `docs:serve` / `dev:all` run. Without it, those scripts fail at the Quartz invocation step.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply `migrate:create-form-4-insider-snapshots:apply` (REQUIRED).
- (carried) Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs.
- (carried) Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
- (carried) Push 52 commits to origin/main (HOLD).
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**The Quartz docs site is FULLY LIVE.** 5 commits land it end-to-end:
  - install + config + scripts (`437332b`)
  - frontmatter rollout to 50 priority docs (`25d0ff0`)
  - dashboard generator + 12 fixture tests (`92f2719`)
  - Mermaid chart templates (`e5b50b9`)
  - conventions doc (`eac2561`)

**Operator can now `npm run docs:install` once + `npm run docs:serve`** at `http://localhost:8080` to browse the vault with backlinks + graph view + Mermaid rendering. `npm run dev:all` runs the dashboard app (:3000) AND docs (:8080) in parallel.

**The vault stays single-source-of-truth.** Markdown under `docs/` is canonical; the rendered site (`docs/.quartz-site/`) and the auto-generated dashboard (`docs/dashboard.md`) are both gitignored, regenerated on every build. The hand-rolled YAML parser correctly distinguishes head-block frontmatter from mid-doc thematic-break `---` lines (the parser's load-bearing invariant; T-PARSE-4 pins it).

**Quartz is vendored, NOT installed as an npm dep.** `quartz/` under git carries the ~280-file Quartz scaffold; `quartz/node_modules/` is gitignored and populated by `npm run docs:install`. Future upgrades = re-degit + diff config customizations + re-apply.

**Parallel-tracks posture continues.** s95 #6 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2901 pass + 12 new dashboard generator tests (+12 net vs s95 #5). 1 pre-existing CH-unreachable fail is NOT a regression.

**The chain through s95 #6:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
S95 #3: form 4 ingest XML body URL discovery (HOTFIX)   ✓ committed (831b1b0)
S95 #4: gap #7 v2 per-row recency (F4 side)             ✓ committed (b3d63a2)
S95 #5: ADR-041 implementation                          ✓ committed (4406674)
S95 #6: Quartz docs site (5 commits)                    ✓ committed (437332b → eac2561)
        — install + config + npm scripts
        — frontmatter rollout to 50 priority docs
        — dashboard generator + 12 fixture tests
        — Mermaid chart templates
        — vault conventions doc
S95 #6 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator picks. Recommended default if
                  operator says "continue" without context:
                  Gap #7 v2 per-EVENT EK recency
                  (§8.1 "12d ago + 18d ago" per-item format;
                  ~3 files, ~80 LOC, ~5-6 tests).
  → background: operator can now npm run docs:install once
                + npm run docs:serve to browse the vault at
                http://localhost:8080 with backlinks, graph
                view, and Mermaid rendering. Auto-generated
                status dashboard at /dashboard regenerates on
                every docs:build from per-doc frontmatter.
```
