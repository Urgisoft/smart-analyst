---
status: active
phase: phase 2
last_updated: 2026-05-05
owner: pejman
type: review
---

# Review doc — Cluster axis dashboard (`/#/cluster`)

**Component:** Phase 2 §5.5 cluster-axis dashboard
**Status:** Pre-existed before session 7; I audited and smoke-tested it this session
**SPEC:** [docs/specs/phase-2-cluster-dashboard.md](../specs/phase-2-cluster-dashboard.md)
**Review date:** 2026-05-05

---

## What this is

A two-panel dashboard at `/#/cluster` that surfaces:

- **Panel A (Diagnostics):** universe-stability tile strip showing 4-12 weeks of HDBSCAN cluster fits, plus a detail block for the latest week (cohort composition, q-score, silhouette, orphan chip if multiple fit_ids exist).
- **Panel B (Scores):** four-gate (DSR / PBO / HLZ / OOS-IS) cluster-axis scores for the latest published HDBSCAN fit, with optional tier-axis comparator chips.

The dashboard is the **read surface** for the cluster axis methodology work from Phase 2 (sessions 1-4). It does NOT surface meta-labeling work (sessions 5-7, ADRs 018-025) — that's a separate panel I'm building next.

---

## Why this exists

It supports two user decisions per SPEC §1:

1. **D1.** "Is this week's universe definition stable enough to trust the cluster-axis scores written against it?"
2. **D2.** "Given the admitted cohort, which strategy × interval clears all four gates — and is the cluster axis doing real work versus the tier axis?"

Today the answer to D2 is "**none**" — 0/20 cells pass on the latest scored fit. The dashboard renders that absence honestly per SPEC §3.6 line 448 ("system working as designed" red chip on universal-fail).

---

## What I verified (this session)

- ✅ `GET /api/cluster/diagnostics?weeks=4` returns 200 with 4 rows.
- ✅ Latest week (2026-05-04) status = `single_cohort`, `hasOrphans=true` (correctly surfaces the 6 weeks of pre-PRE-1 historical orphan rows).
- ✅ Cohort composition resolves: `dominantTier=mcap_nano` (46%), `isFragmented=true` (`<60%`).
- ✅ `GET /api/cluster/scores` (no params) returns 200; resolves the latest published fit (`b6f99cea`).
- ✅ `npm run score:by-cluster` runs successfully, writes 20 rows to `strategy_scores_by_cluster`, all `gates_pass=0`.
- ✅ All 510 TS tests green; including `clusterDiagnosticsRoute.test.ts` and `clusterScoresRoute.test.ts`.
- ✅ Both endpoint route handlers exist and validate query params correctly.
- ✅ Front-end components exist: `ClusterApp.tsx`, `ClusterDiagnosticsPanel.tsx`, `ClusterScoresPanel.tsx`.
- ✅ Hash route dispatch wired in `src/main.tsx`.
- ✅ ValidatorApp URL-param hydration via `validator_hash_params.ts`.
- ✅ PRE-1 (orphan-rows reorder) and PRE-2 (score:by-cluster log line) both already implemented with explicit "Phase 2 §5.5" comments.

---

## How to test it yourself

```bash
# Make sure the dev server is running (it was when I tested)
npm run dev

# In another terminal, hit the endpoints:
curl -s 'http://localhost:3000/api/cluster/diagnostics?weeks=4' | python -m json.tool | head -40
curl -s 'http://localhost:3000/api/cluster/scores' | python -m json.tool | head -40

# Then open in a browser:
#   http://localhost:3000/#/cluster
```

What you should see:

- **Panel A:** 4 horizontal tiles (one per week from 2026-04-13 → 2026-05-04), latest tile in emerald (single_cohort), all earlier tiles emerald too, an orange "orphan" dot in the top-right of each tile. Detail block on the right shows q-score, silhouette, fit metadata, and a horizontal cohort-composition bar showing `mcap_nano 46% / mcap_micro 34% / mcap_small 19%`.
- **Panel B:** ⚠️ likely shows a **yellow card** "Fit `b6f99cea` has no scored cells — run `npm run score:by-cluster`" — see "Known operational behavior" below.

To populate Panel B with real data:

```bash
# This re-tags bt_runs with cluster_id and writes scores
npm run score:by-cluster
```

After running, Panel B should show 20 rows, all with red gate pills. The headline summary chip should read "20 of 20 cells fail at least one gate · system working as designed" (SPEC §3.6 line 448). Tier-axis comparator chips will all be NULL (cohort isFragmented is true).

---

## Known operational behavior (NOT bugs)

### Panel A and Panel B may show DIFFERENT fit_ids — this is intentional

**Why:** `cluster_tokens_weekly.py` runs weekly and creates a NEW `fit_id` each run. `batch_backtest.ts` tags each `bt_run` with the `fit_id` that was active at run time. `score:by-cluster` aggregates `bt_runs` by their tagged `fit_id`, so it produces rows for the modal-tagged fit — usually NOT the most recent week's fit.

**Session 9 enhancement (resolver fallback):** the scores endpoint's default-resolution now prefers the latest published fit *that has scored cells*, falling back to the unconstrained "latest published" only if no scoring exists anywhere. So Panel B almost always renders real scored data instead of the empty-state yellow card.

**Visual signal:** Panel A shows the **latest published** fit (e.g., `b6f99cea` from week 05-04). Panel B shows the **latest scored** fit (e.g., `74778981` from week 04-27). The fit_id and week are visibly different. Session 9 also added an **explicit amber banner** in Panel B when this fallback fires:

> **Showing latest scored fit (1wk behind published)**
> Latest published fit `b6f99cea` (week 2026-05-04) has no scored cells yet. This view shows fit `74778981` from week 2026-04-27. To refresh: re-run `npm run score:by-cluster` after the next `batch_backtest.ts` run tags new bt_runs with the current fit_id.

**To bring Panel A and Panel B in sync:** re-run `batch_backtest.ts --tier <tier>` to generate new bt_runs tagged with the latest fit, then `npm run score:by-cluster` to score them.

### Cohort isFragmented = true → all tier-axis comparator chips are null

**Why:** SPEC §3.2 line 297 — "If the cohort is `isFragmented`, all rows get `tierAxisCompare = null` (per OQ-D2: one tier-Δ is dishonest)." The current admitted set spans `mcap_nano / mcap_micro / mcap_small / mcap_mid`; no single tier exceeds 60%, so `isFragmented=true`. The panel correctly suppresses the comparator chips.

---

## Real bug found (FIXED session 9)

**Endpoint:** `GET /api/cluster/scores?fitId=<UUID>` was returning 503 with error `"There is no supertype for types String, UUID"`.

**Root cause (isolated session 9):** ClickHouse 24.8 quirk — comparing a UUID column with `{p:UUID}` parameter in a WHERE clause **on a FINAL'd table** raises `Code: 386 — no supertype for String, UUID`. The same comparison without FINAL works fine. ORDER BY UUID with FINAL also works fine. The bug is specific to WHERE + UUID column + FINAL.

**Fix:** Cast the column to String and compare with `{p:String}`. Applied in 3 places in `src/server/cluster_dashboard.ts`:

1. `fetchClusterScores` explicit-fitId branch (was the direct trigger of the 503)
2. `buildCohortSql` (`token_cluster_membership.fit_id`)
3. `buildAdmittedCountSql` (same column)

**Regression pin:** added 2 tests in `scripts/tests/clusterScoresRoute.test.ts` ("FINAL/UUID workaround regression pin (CH 24.8)") that fail if a future "clean-up" tries to remove the toString() wrapping.

**Impact:** UI behavior unchanged (UI never passed `?fitId=`). The fix is for explicit-API consumers + future-proofing if the front-end ever adds a fit-id picker.

---

## What this dashboard does NOT show

- **Meta-labeling 7-criterion verdicts** — sessions 5-7 ran ~28 cell-trainings with the meta-labeling pipeline (ADRs 018-025). None of those results surface here. Building a separate panel next.
- **Cell-level details** — clicking a row navigates to `/#/validator?axis=cluster&...` which has full cell drill-down. The dashboard is the entry point, not the detail view.
- **Strategy-level params** — the panel shows `bestParam` per cell, not the full param sweep curve. The validator route shows that.

---

## Files involved (for code review if you want to look)

- **Backend:**
  - [server.ts:485-525](../../server.ts#L485-L525) — Express route handlers
  - [src/server/cluster_dashboard.ts](../../src/server/cluster_dashboard.ts) — orchestrator (~1100 lines, intentionally pure-function for testability)
  - [scripts/score_strategies_by_cluster.ts](../../scripts/score_strategies_by_cluster.ts) — populates `strategy_scores_by_cluster`
  - [scripts/cluster_tokens_weekly.py](../../scripts/cluster_tokens_weekly.py) — weekly cluster fit
- **Frontend:**
  - [src/main.tsx](../../src/main.tsx) — hash-route dispatch
  - [src/components/cluster/ClusterApp.tsx](../../src/components/cluster/ClusterApp.tsx) — shell
  - [src/components/cluster/ClusterDiagnosticsPanel.tsx](../../src/components/cluster/ClusterDiagnosticsPanel.tsx) — Panel A
  - [src/components/cluster/ClusterScoresPanel.tsx](../../src/components/cluster/ClusterScoresPanel.tsx) — Panel B
  - [src/lib/validator_hash_params.ts](../../src/lib/validator_hash_params.ts) — URL-param hydration
- **Tests:**
  - `scripts/tests/clusterDiagnosticsRoute.test.ts`
  - `scripts/tests/clusterScoresRoute.test.ts`
  - Plus parsing/orchestrator tests inline in the orchestrator file
