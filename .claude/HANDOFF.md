# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 95 #4 — **gap #7 v2 per-row recency — F4 `daysSinceLatest{Buy,Sell}` LIVE end-to-end**: 2 new REQUIRED fields on `Form4InsiderPerTickerRow`; pure helper `daysSinceLatestTradeByCode` with direction isolation + floor semantic; composite populates; composer threads; renderer emits "last Xd" segment inside the net-dollar parens (SPEC §8.2 mockup phrasing). NO DDL change — `per_ticker_json` is free-form JSON. EK was already done in prior work (`daysSinceLatestEvent` + `formatDaysSince`); F4 was v1-deferred per the prior render docstring. 4 files (1 source + 1 composer + 1 render + 4 test files); +298 / -38 LOC; 8 new T-F4-DSLB-{1..5} + T-OBR-F4-DSLB-{1..3} tests; 22 existing F4 row fixture literals updated via `replace_all`; 10 existing F4-row regex assertions widened to tolerate the new segment. Full TS suite 2906 / 2877 pass / 1 fail (pre-existing `gicsSectorRepositoryHelper SMP-6` CH-unreachable — NOT a regression) / 28 skipped. Single commit `b3d63a2`. **42 commits ahead of `origin/main`.** **NEXT default on `continue`: operator pick — recommended slice if operator says only "continue": ADR-041 implementation (`yield_curve_inverted` regime category).**)

## What this turn delivered

Lifts F4 brief from v1 (no per-direction recency) to v2 (SPEC §8.2 compliance). 4 files touched, 8 new tests, zero DDL changes.

1. **`src/server/form_4_insider.ts`** (+58 LOC):
   - `daysSinceLatestTradeByCode(trades, code, asOf, windowDays=ROLLING_WINDOW_DAYS) → number | null` — pure helper. Direction-isolated (P-trades don't pollute S-recency, vice versa). Floor semantic: a trade 23h59m ago → 0d; 24h00m+1ms → 1d. Returns null when window contains zero trades of `code`.
   - `Form4InsiderPerTickerRow` gains 2 REQUIRED fields: `daysSinceLatestBuy: number | null` + `daysSinceLatestSell: number | null` (same REQUIRED posture as s95 #1/#2 sell-side fields).
   - `evaluateForm4InsiderComposite` populates both per row, from the same `psFiltered` trade panel that backs the existing count/dollar/cluster computations.

2. **`src/server/operator_brief.ts`** (+2 LOC):
   - `buildForm4InsiderSection`'s `perTickerRows.map(...)` block threads the 2 new fields verbatim into `BriefForm4InsiderSection`. Same posture as the s95 #2 sell-side pass-through.

3. **`src/server/operator_brief_render.ts`** (+29 LOC):
   - `BriefForm4InsiderSection.perTickerRows[]` row interface adds 2 REQUIRED fields (mirrors composite shape).
   - `renderForm4InsiderSection`'s cluster_buy + cluster_sell row emit lines now include a "last Xd" segment INSIDE the net-dollar parens, before the `, code P/S` tail:

     ```text
     - QRST — 4 insiders bought (net +$2.3M, last 23d), code P
     - YZAB — 5 insiders sold (net -$11.2M, last 11d), code S
     ```

   - New `formatDaysSinceLast(v: number | null): string` helper — "last Xd" or "last —" for null. Distinct from the existing `formatDaysSince` (which emits "Xd ago" for EK).
   - Renderer docstring updated: v1-deferred note REMOVED; the new format matches the SPEC §8.2 mockup contract.

4. **Tests (+298 / -38 LOC; +8 net new tests across 4 files)**:
   - **T-F4-DSLB-1** (`form4Insider.test.ts`) — helper returns days since most-recent trade of given code in window.
   - **T-F4-DSLB-2** — returns null when window has zero trades of that code OR trades list is empty.
   - **T-F4-DSLB-3** — direction isolation: P-side recency ignores S-side trades, vice versa.
   - **T-F4-DSLB-4** — floors partial days (23.5d → "23d").
   - **T-F4-DSLB-5** — `evaluateForm4InsiderComposite` populates both fields; cold-start zero-trade ticker yields null on both directions. (Bug-caught in first run: my fixture initially shared accessions across trades and `dedupeTrades` collapsed them; fix was to give each trade a unique accession.)
   - **T-OBR-F4-DSLB-1** (`operatorBriefRender.test.ts`) — cluster_buy emits "last 23d".
   - **T-OBR-F4-DSLB-2** — cluster_sell emits "last 11d".
   - **T-OBR-F4-DSLB-3** — defensive null path: cluster_buy with `daysSinceLatestBuy: null` renders "last —". Should not happen in practice (cluster_buy implies count ≥ 3 → daysSinceLatestBuy non-null), but the renderer degrades gracefully.
   - 22 existing F4 row fixture literals updated via 4 `replace_all` operations per file (inline `},` form + standalone `,\n` form, each with `true`/`false`).
   - 10 existing T-OBR-F4-{7,8,9} + magnitude-band regex assertions widened from `\(net X\), code P` → `\(net X, last [^)]+\), code P` to tolerate the new segment.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93 #2-#6; `daysSinceLatestEvent` was already on EK row from earlier work) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH | ✓ s94 #1-#5 |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| Gap #7 v2 sell-cluster F4 composite contract | ✓ s95 #1 (`b398b4e`) |
| Gap #7 v2 sell-cluster F4 G3 (DDL + persistence + log + render) | ✓ s95 #2 (`d05eb39`) — F4 ARC FULLY CLOSED |
| Form 4 ingest XML body URL discovery (hotfix) | ✓ s95 #3 (`831b1b0`) — UNBLOCKS first-apply |
| **Gap #7 v2 per-row recency (F4 daysSinceLatestBuy/Sell)** | **✓ s95 #4 (`b3d63a2`) — SPEC §8.2 "last 23d" hint LIVE** |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable (recommended next default) |
| Gap #7 v2 per-EVENT EK recency (§8.1 "12d ago + 18d ago" per-item format) | ☐ deferred — out of s95 #4 scope; needs new row shape |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 42 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 part 4 (this turn, one commit `b3d63a2`)

**S95-15. F4 per-direction recency uses `acceptedAt` (EDGAR-stamped), NOT `transactionDate` (insider-declared).**
`Why:` The `InsiderTrade` row already carries `acceptedAt` (load-bearing for the F4-10 anti-leak filter); `transactionDate` is parsed from the XML but is used only at filing-time and not stored on the F4 row. Using `acceptedAt` minimizes new wiring + parity with the count/dollar computations that all use `acceptedAt`. The trade-off: EDGAR acceptance can lag the transaction by up to 2 business days (Sarbanes-Oxley §403(a) deadline), so recency slightly understates how stale the underlying trade is.

`How to apply:` v1 is acceptable for a brief hint; a v2 ADR could switch to `transactionDate` if precision matters (e.g., for kill-criteria gating where 2bd matters). For now, the F4 row "last 23d" means "the most-recent EDGAR acceptance was 23d ago" — operator reads this as ≈ "the trade happened ~23d ago, possibly 1-2bd earlier."

**S95-16. NO DDL migration needed — `per_ticker_json` is a free-form JSON String column.**
`Why:` The original HANDOFF v0 scoped this slice with "One operator-gated DDL migration (new columns on `eight_k_classifier_snapshots` + `form_4_insider_snapshots`)" — that was incorrect. The per-ticker rows are serialized to JSON via the existing `per_ticker_json` column on both snapshot tables. Adding 2 new keys to each row's JSON requires zero schema change.

`How to apply:` Future per-row v2 additions (e.g., per-item EK recency, gap #7 v2 13D arc per-row payload) should default to JSON-key additions, NOT new columns, unless the field needs CH-side indexing or projection. Save column-add migrations for top-level aggregate-snapshot fields where queryability matters.

**S95-17. `formatDaysSinceLast` is a separate helper from `formatDaysSince`, not a parameter overload.**
`Why:` The SPEC §8.1 (EK) mockup phrasing is "Xd ago" while §8.2 (F4) is "last Xd". The two formats render in different positions: EK appends `(Xd ago)` AFTER the item list, F4 embeds `, last Xd` INSIDE the net-dollar parens. Keeping them as separate helpers makes the per-composite formatting intent explicit + avoids a boolean parameter that obscures the call sites.

`How to apply:` Future composite recency surfaces should pick whichever helper matches the SPEC's wording at the per-row position. If a new composite emerges with a third phrasing convention, add a third helper rather than parameterizing the existing two.

**S95-18. `daysSinceLatestBuy` / `daysSinceLatestSell` are REQUIRED (not optional) on `Form4InsiderPerTickerRow` + `BriefForm4InsiderSection.perTickerRows[]`.**
`Why:` Parity with the s95 #1/#2 sell-cluster fields (`form4SellClusterFlag`, `maxAggregateZSell`, etc.). Required fields force every fixture / callsite to opt in explicitly — preventing silent under-population. Cold-start ticker yields `null`, NOT undefined / missing — the test surface enforces the null-vs-undefined distinction.

`How to apply:` Any future test fixture or callsite constructing `Form4InsiderPerTickerRow` or `BriefForm4InsiderSection.perTickerRows[]` MUST include the 2 new fields. Default to `null` on both unless the test specifically exercises a recency branch. The 22 existing fixtures were updated via 4 `replace_all` operations per file (one per `true`/`false` × inline/standalone form).

**S95-19. `daysSinceLatestTradeByCode` floors fractional days (NOT round / NOT ceil).**
`Why:` Matches the "Xd ago" / "last Xd" SPEC mockup semantic — a trade 23h59m ago is "0d" (today), a trade 24h00m+1ms ago is "1d" (yesterday). Round-half-up would have a trade 11h59m ago be "0d" but a trade 12h00m+1ms be "1d", which is counterintuitive at the integer boundary. Ceil would push a trade 1ms ago to "1d" — overstates staleness.

`How to apply:` Any future recency helpers on similar semantics (days-since-something) follow the floor convention. The constant `MS_PER_DAY = 86_400_000` is inlined in the helper; no global constant pulled.

### Architecture queued s95 #4 (Quartz docs site — not yet executed)

**S95-20. Quartz vault scope is `docs/` root, NOT `docs/obsidian/`.**
`Why:` Of 114 .md files in `docs/`, only 9 + gaps + symbol-analysis live under `docs/obsidian/`. The docs the operator named to frontmatter (ADRs, specs, gap docs, component docs) live across 5 parent folders. Restructuring would churn ~50 paths + break external links + break grep-based references in source/scripts. Expanding Quartz scope is the lowest-churn option.

`How to apply:` When the slice executes, `quartz.config.ts` sets `vault: '../docs'`. No file moves; existing folder layout preserved. Future ADRs/specs continue to land in their current folders; the convention doc (commit 5 of the slice) explains the no-move posture.

**S95-21. Dashboard generation is a build-time TS script, NOT a Quartz plugin / Dataview equivalent.**
`Why:` Quartz v4 does NOT support Dataview queries (that's an Obsidian-runtime plugin). A build-time generator is deterministic, testable in isolation, no runtime dependency, and gives full control over chart shape. Generator runs as part of `npm run docs:build` BEFORE Quartz so the regenerated `dashboard.md` is part of the corpus Quartz indexes.

`How to apply:` Generator at `scripts/generate_docs_dashboard.ts`; tests at `scripts/tests/generate_docs_dashboard.test.ts` against a frontmatter fixture set. Output `docs/dashboard.md` is committed (so the dashboard is browsable without rebuilding); it's regenerated, NEVER hand-edited. Hand-edits get overwritten on the next build.

**S95-22. Frontmatter schema includes a `type` field (NOT just status/phase/last_updated/owner).**
`Why:` Without `type`, the dashboard can't group correctly (ADRs vs specs vs gaps vs components vs analyses). The operator's spec implied the grouping ("ADRs, specs, gap docs, component docs") — the `type` field materializes that intent. One extra line per file, big simplicity win for the generator.

`How to apply:` Frontmatter schema is:

```yaml
status: shipped | in-progress | inventory | blocked
phase: <freeform string, ideally matching an enum>
last_updated: YYYY-MM-DD
owner: claude | operator | both
type: adr | spec | gap | component | analysis | experiment
# optional:
slice_id: s95-4
depends_on: [adr-042]
```

Bulk-stamp rollout: commit 2 of the slice assigns current-best-guess values from HANDOFF + manual edge-case review.

**S95-23. Single source of truth confirmed: vault Markdown is the only state.**
`Why:` Operator explicitly asked for confirmation. Architecture: frontmatter lives IN the .md files; Quartz reads them → HTML; Claude reads them → context; generator reads them → dashboard.md. The dashboard is regenerated, never hand-edited. If frontmatter goes stale, the generator and Quartz fail the same way (= correct failure mode for a single-source-of-truth design). NO duplicate state in any external db / spreadsheet / config.

`How to apply:` Future ADRs/specs are born WITH frontmatter (convention doc enforces). Existing docs get stamped during commit 2 of the slice. Any future drift between dashboard claims and reality is a frontmatter bug — fix the frontmatter, regenerate.

**Carry-over from s95 #3 (still in force):**

- S95-11..S95-14 — EDGAR Form 4 body URL discovery contract, `ciks_all` parser field, XML selection precedence, positive-only cache.

**Carry-over from s95 #2 (still in force):**

- S95-6..S95-10 — sell-side persistence + render conventions, log-line suffix-extension, EK/XD buy-side-only, footer placement.

**Carry-over from s95 #1 (still in force):**

- S95-1..S95-5 — sell-cluster composite parameters + interface posture.

**Carry-over from s94 #11 (still in force):**

- S94-29..S94-33 — sector cluster rate, daemon log line tokens, render branch order.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-33 + S95-1..S95-14 carry through.

## Open questions

### Newly opened (s95 #4) — none

The per-row recency slice was canon-thin only at one decision (`acceptedAt` vs `transactionDate` — resolved at S95-15 with v2 ADR escape hatch noted). No remaining forks within scope.

### Carried unchanged from s95 #3

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default.

### CARRIED (unchanged)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only (no point-in-time correctness for the gics_sector_map v1 ingest).
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable (recommended default next).
- Push commits to origin/main — operator-gated.
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess; verification deferred to first ingest run) — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

## Next stage

### Default on `continue` — operator pick (Gap #7 v2 per-row recency closed)

The v2 per-row recency slice ships F4-side. EK's per-row `daysSinceLatestEvent` was already done in earlier work (no this-slice changes to EK). Operator picks the next slice. If they just say "continue" with no context, the recommended default is **ADR-041 implementation (`yield_curve_inverted` regime category)** — the canon work is done (ADR Accepted s89c#2); the activation slice extends the regime classifier with the new category + adds the dashboard surfacing.

### Candidate slices (in rough order of "next obvious code-only work")

1. **Quartz docs site + status frontmatter + auto-generated dashboard** (operator-queued s95 #4, architecture confirmed) — pre-scoped, ready to execute. **5 commits, ~600 LOC, ~6 tests.** Operator says "do the Quartz slice" / "start docs visualization" to kick off. Pre-locked architecture (S95-20..S95-23 below):
   - **Vault scope = `docs/` root** (not `docs/obsidian/`). Quartz indexes the whole tree as-is. NO file moves; no path breakage. Frontmatter rolls out to ~50 priority docs first (ADRs/specs/gaps/components); rest stamped as touched.
   - **Dashboard = build-time TS script** (`scripts/generate_docs_dashboard.ts`). Scans frontmatter, writes `docs/dashboard.md` with grouped lists (Shipped / In-Progress / Inventory / Blocked) + Mermaid charts (status pie, phase gantt, dependency DAG from `depends_on`, recent-activity timeline, owner split). Regenerated on every `npm run docs:build`; never hand-edited.
   - **Frontmatter schema:** `status` (shipped/in-progress/inventory/blocked), `phase`, `last_updated`, `owner` (claude/operator/both), `type` (adr/spec/gap/component/analysis/experiment), optional `slice_id`, `depends_on: []`.
   - **Quartz config:** v4, source = `docs/`, output = `docs/.quartz-site/` (gitignored), dark theme + dense Bloomberg-style layout, plugins = ObsidianFlavoredMarkdown (includes Mermaid + callouts + wikilinks) + Latex + SyntaxHighlighting. npm scripts: `docs:build` (build) + `docs:serve` (build --serve for local preview).
   - **Single source of truth confirmed:** vault Markdown files ARE the state; frontmatter is part of those files; Quartz reads them → HTML; Claude reads them → context; dashboard is regenerated from same frontmatter. Zero duplicate state to maintain — the dashboard generator and Quartz fail the same way if frontmatter goes stale (correct failure mode).
   - **Commit plan:** (1) install Quartz + config + npm scripts + gitignore; (2) frontmatter rollout to ~50 priority docs (bulk-stamped from HANDOFF + manual edge-case review); (3) `generate_docs_dashboard.ts` + ~6 fixture tests; (4) Mermaid chart templates baked into generator; (5) convention doc + HANDOFF note for future ADRs/specs born with frontmatter.
   - **NOT default on bare `continue`** — ADR-041 remains the default; operator picks Quartz explicitly when ready.

2. **ADR-041 implementation** (`yield_curve_inverted` regime category) — **recommended default on bare `continue`**. The canon work is done. Activation slice extends the regime classifier with the new category + adds the dashboard surfacing. ~5-6 files, ~150 LOC, ~10 tests.

3. **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format) — separate row shape: `eventsByItemCode: Array<{itemCode: string, daysSinceLatest: number}>` on the EK per-ticker row. Renderer extends `formatEightKItemList` to interleave the per-item recency. ~3 files, ~80 LOC, ~5-6 tests. NOT in s95 #4 scope; needs its own slice.

4. **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — adds a secondary data path that cross-validates the primary etf-flow ingest against an issuer-supplied CSV when available; logs divergences as anomalies. Operator-pickable.

5. **Gap #7 v2 13D/13G arc** — needs its own SPEC first; deferred until operator says go.

6. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

7. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

8. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

9. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

### Operator-gated action items (carried + still pending)

- Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3 — first apply now works; produces real F4 cluster_buy / cluster_sell rows with "last Xd" recency hints visible in the morning brief).
- Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply` to surface s95 #2 sell-side persistence end-to-end on the real CH (still pending).
- Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs (still pending from s94 #8).
- Apply `migrate:create-form-4-insider-snapshots:apply` (operator hit this gap mid-runbook in s95 #3 turn — base table doesn't exist on their CH yet).
- Push 42 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s95 #4 — commit `b3d63a2`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | +58 | `daysSinceLatestTradeByCode` pure helper; `Form4InsiderPerTickerRow` gains 2 REQUIRED fields; composite populates per row. |
| `src/server/operator_brief.ts` | +2 | Composer pass-through for the 2 recency fields. |
| `src/server/operator_brief_render.ts` | +29 / -3 | `BriefForm4InsiderSection.perTickerRows[]` gains 2 fields; row emit adds "last Xd" segment; new `formatDaysSinceLast` helper. |
| `scripts/tests/form4Insider.test.ts` | +72 | T-F4-DSLB-{1..5}. |
| `scripts/tests/form4InsiderRepository.test.ts` | +6 / -3 | 3 fixture sites updated. |
| `scripts/tests/operatorBrief.test.ts` | +12 / -6 | 6 fixture sites updated. |
| `scripts/tests/operatorBriefRender.test.ts` | +157 / -26 | 13 fixture sites updated; 10 row regex assertions widened; T-OBR-F4-DSLB-{1..3}. |

### Carried unchanged from s95 #3 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | s95 #3 LIVE | `parse_edgar_search_response` emits `ciks_all` field. |
| `scripts/sec_edgar_form4_ingest.py` | s95 #3 LIVE | `discover_form4_primary_xml_url` + `_select_form4_xml_from_directory`; `_xml_for` invokes discovery on parser fallback. |

### Carried unchanged from s95 #2 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` | s95 #2 SHIPPED | Operator-gated ALTER ready to apply (4 sell-side columns). |
| `src/server/form_4_insider_repository.ts` | s95 #2 LIVE | Persists + decodes sell-side fields; daemon log line carries sell-side tokens. |

### CH state

- Nine Layer-0 composite snapshot tables + three event tables remain in the state from s93 / s94 / s95 #1+#2+#3 close.
- **NO new CH state from s95 #4.** Per-row recency persists into the EXISTING `per_ticker_json` free-form String column. After the operator applies the pending DDL migrations (carry from s94 #8 + s95 #2), the new `daysSinceLatestBuy` / `daysSinceLatestSell` keys WILL persist end-to-end alongside everything else.
- **Operator-pending ALTERs (carried):**
  - `migrate:create-form-4-insider-snapshots:apply` (operator-gated; base table) — REQUIRED first.
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3, carry from s94 #8).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/form4Insider.test.ts \
              scripts/tests/form4InsiderRepository.test.ts \
              scripts/tests/operatorBrief.test.ts \
              scripts/tests/operatorBriefRender.test.ts
                                                              # 360 pass / 0 fail / 2 skipped (pre-existing CH-unreachable)
                                                              # +8 net from T-F4-DSLB-* + T-OBR-F4-DSLB-*

npm test                                                       # 2906 / 2877 pass / 1 fail / 28 skipped
                                                              # 1 fail = pre-existing gicsSectorRepositoryHelper SMP-6 CH-unreachable
                                                              # +8 net vs s95 #3 = exactly the 8 T-F4-DSLB-* tests

npx tsc --noEmit                                              # 13 baseline errors unchanged

npm run check:help                                            # green
```

`pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s95 #4)

- **Recency uses `acceptedAt` (EDGAR-stamped), NOT `transactionDate` (S95-15).** Recency slightly understates how stale the underlying trade is (up to 2bd lag). Acceptable for brief hint; v2 ADR can switch if precision matters.

- **`Form4InsiderPerTickerRow` + `BriefForm4InsiderSection.perTickerRows[]` row have 2 NEW REQUIRED fields.** Any future test fixture or callsite constructing either type MUST include `daysSinceLatestBuy` + `daysSinceLatestSell`. Default to `null` unless exercising a recency branch. The 22 existing fixtures updated this turn via `replace_all`; future authors should match the precedent.

- **Brief row regex assertions widened to tolerate `, last Xd`.** The 10 pre-existing T-OBR-F4-{7,8,9} + magnitude-band patterns went from `\(net X\), code P` → `\(net X, last [^)]+\), code P`. Future row-shape changes (e.g., adding a third in-parens segment) need either further regex widening OR a switch to exact-match snapshot tests.

- **Cold-start sells-only ticker (or buys-only) emits "last —" on the absent direction.** A ticker with `insiderClusterBuyFlag: true` + `insiderClusterSellFlag: false` legitimately has `daysSinceLatestSell: null` — but only the buy-side row renders (the sell-side filter strips this ticker before emission). So the operator only sees "last —" when the cluster-flag-true direction genuinely has no signal, which CAN'T happen by definition (cluster_buy ⇒ ≥3 distinct buyers ⇒ daysSinceLatestBuy non-null). The "last —" path exists in code for defensive degrade only (T-OBR-F4-DSLB-3 pins it for backfill / stale-read safety).

- **EK per-EVENT recency (§8.1 mockup's "12d ago + 18d ago" per-item format) is STILL deferred.** EK has only a single `daysSinceLatestEvent` (the freshest event across all item codes) — NOT per-item-code recency. The §8.1 mockup shows per-item ages, which would need a new row shape (`eventsByItemCode: Array<{itemCode, daysSinceLatest}>`). This is a separate slice (~80 LOC, ~5-6 tests) — listed in candidate slices #2.

- **The pre-existing `gicsSectorRepositoryHelper SMP-6 EXPLAIN PLAN` test failure is NOT a regression.** Verified by isolating to the pre-slice baseline — the test was already failing pre-s95-#4 due to CH-reachability (one of the 2 tables it queries is absent). It's an "skipped-when-unreachable" test that's behaving inconsistently in the current local CH state. NOT in s95 #4 scope.

### Carried from s95 #3 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- **`discover_form4_primary_xml_url` adds ~1 HTTP round-trip per filing on first apply.**
- **`filing["ciks_all"]` is the multi-CIK fallback field; `filing["cik"]` is the single legacy field.**
- **XML selection precedence: form4-named → primary_* → any non-stylesheet .xml.**
- **Discovery cache is positive-only.**
- **`Form4InsiderSnapshot` writeSnapshot drops sell-side columns on PRE-MIGRATION tables** until the operator applies `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
- **`BriefForm4InsiderSection` has 4 REQUIRED sell-side fields** (s95 #2) — now ALSO has 2 REQUIRED recency fields on `perTickerRows[]` (s95 #4). 6 REQUIRED v2 additions total.
- **The daemon `[f4-aggregate]` log line has 2 TAIL TOKENS** (`sell_cluster_flag=…` + `max_z_sell=…:…`).
- **Buy + sell aggregate panels are INDEPENDENT branches.**
- **The L&L 2001 §4 dilution footer attaches to the sell-side no-flag-cleared branch ONLY.**
- **`inputsAvailableAggregate` is overloaded across BOTH directions (S95-10).**
- **`computeSectorClusterRate` is called TWICE per sector per cycle** (BUY_CODE + SELL_CODE).
- **Symmetric z-test fires on negative-z sell-side anomalies too.**
- **The composite source files have `\0` literals in template strings** (`src/server/executive_departure.ts` line 105, `eight_k_classifier.ts` line 133, `form_4_insider.ts` line 163).
- **The §1.4 three-branch order is load-bearing: LIVE → no-flag-cleared → cold-start** (both directions).
- **`dayAsOf` uses end-of-day semantic** (`day + 'T23:59:59.999Z'`).
- **Tie-break asymmetry on equal-|z| with opposite signs.**
- `gics_sector_repository_helper.ts` is the byte-template owner for per-ticker + per-day-panel + per-ticker-timeline sector lookups.
- `MIN_Z_BASELINE = 30` floor stays at 30 across all three composites per ADR-042 §6.
- `stddevSamp` not `stddevPop` — Bessel correction.
- Today's rate must be EXCLUDED from the baseline window per ADR-042 §4.

(All earlier s89-s95 #3 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); F4 emits both directions + recency on per-row payload.
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # F4 §15: cluster_buy/sell rows now show "(net X, last Yd), code Z" inline.
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3 — discovery via index.json
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply   # REQUIRED — operator hit this gap in s95 #3 runbook
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily                                    # writes per_ticker_json with the 2 new recency keys
npm run brief:morning                                   # F4 §15 cluster_buy/sell rows render the "last Xd" segment
```

### Gap #7 8-K classifier (G2 LIVE; per-row daysSinceLatestEvent ALREADY LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning                                   # EK §14 material_event rows show "(Xd ago)" — already wired pre-s95 #4
```

### Gap #9 etf-flow activation (FULLY READY)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #10 short-interest activation

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation (G2 LIVE)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run migrate:add-max-z-executive-departure-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2906 / 2877 pass / 1 fail / 28 skipped (1 fail = pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 332 pass at s95 #3 close (unchanged)
npx tsx --test scripts/tests/form4Insider.test.ts                              # 50 pass — includes T-F4-DSLB-{1..5}
npx tsx --test scripts/tests/operatorBriefRender.test.ts                       # all F4 + EK render tests including T-OBR-F4-DSLB-{1..3}
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #4 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** operator picks the next slice (gap #7 v2 per-row recency arc closed end-to-end on F4 side). If operator just says "continue" with no context, the recommended default is **ADR-041 implementation** (`yield_curve_inverted` regime category) — canon work done at s89c#2 Accept; activation slice extends the regime classifier with the new category + adds dashboard surfacing. ~5-6 files, ~150 LOC, ~10 tests.

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6` failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the default-next:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**

- Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3; produces real per-row payloads with recency hints once daemon ran).
- Apply `migrate:create-form-4-insider-snapshots:apply` (REQUIRED — base table absent in operator's local CH).
- Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs (carry from s94 #8).
- Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).
- Push 42 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation.
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**Gap #7 v2 per-row recency F4 side is FULLY CLOSED.** Two new REQUIRED fields on `Form4InsiderPerTickerRow` (`daysSinceLatestBuy` + `daysSinceLatestSell`); composite populates from `psFiltered` trade panel; composer threads; renderer emits "last Xd" inside the net-dollar parens per SPEC §8.2. EK's per-row `daysSinceLatestEvent` was ALREADY done in earlier work (not touched this turn).

**EK per-EVENT recency (§8.1 mockup's per-item-code recency) is STILL DEFERRED.** EK currently surfaces only a single `daysSinceLatestEvent` (the freshest event across items); the SPEC §8.1 mockup shows per-item ages ("restatement (4.02) 12d ago + auditor change (4.01) 18d ago"). That's a separate v2 slice with a new row shape (`eventsByItemCode: Array<{itemCode, daysSinceLatest}>`). NOT in s95 #4 scope — operator-pickable if they want it next.

**NO DDL CHANGE this turn.** The original handoff scoped a "co-bootstrap of EK + F4 snapshot DDLs" — that was incorrect because `per_ticker_json` is free-form JSON. Future per-row v2 additions should default to JSON-key additions, NOT ALTERs.

**Recency uses `acceptedAt`, NOT `transactionDate` (S95-15).** Trade-off: up to 2bd understatement of staleness vs the underlying market action. Acceptable for brief hint; v2 ADR can switch to `transactionDate` if precision matters.

**The composite source files have `\0` literals (carried watch-out).** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163).

**Parallel-tracks posture continues.** s95 #4 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2877 pass (1 pre-existing CH-unreachable fail is NOT a regression; +8 net vs s95 #3 = exactly the 8 T-F4-DSLB-* tests).

**The chain through s95 #4:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
        — DDL + persistence + daemon log + brief render
S95 #3: form 4 ingest XML body URL discovery (HOTFIX)   ✓ committed (831b1b0)
        — unblocks first-apply
S95 #4: gap #7 v2 per-row recency (F4 side)             ✓ committed (b3d63a2)
        — daysSinceLatest{Buy,Sell} + "last Xd" render
S95 #4 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator picks. Recommended default if
                  operator says "continue" without context:
                  ADR-041 implementation (yield_curve_inverted
                  regime category).
  → background: F4 emits six signals end-to-end now (buy/sell
                per-ticker cluster flags + aggregate cluster
                flags + per-direction recency). EK has 5 of the
                analogous signals plus per-row recency. The XD
                arc remains buy-side-only (no v2 sell or
                recency add).
```
