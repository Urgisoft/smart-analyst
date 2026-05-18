# Review doc — Meta-Labeling Research Log (`/#/meta-labeling`)

**Component:** Meta-labeling research-log dashboard panel
**Status:** Built session 8; **schema-migrated session 9** (full 7-criterion verdict now persisted)
**Review date:** 2026-05-05

---

## What this is

Single-panel view at `/#/meta-labeling` listing every meta-labeling cell-training in `quantlab.meta_models` (FINAL by `(cell_key, m1_run_sig)`).

Per row:

- **Cell identifier** — strategy / tier / interval / param
- **Date trained**
- **OOS sample size** (`n_oos`)
- **All 7 criterion pills (C1–C7)** — color-coded green (pass) / red (fail). Authoritative; persisted from trainer's runtime evaluation.
- **M2 sum %** — meta-labeled deployment-metric sum (color-coded)
- **M1 sum %** — primary unfiltered baseline (color-coded)
- **Lift pp** — `M2 - M1`
- **Verdict badge** — text label like `REJECT (still net negative)`, `REJECT (outlier-dominated; ADR-019)`, `PROMOTE`, etc. Pulled from persisted `verdict_text`.

Header summary: per-criterion pass-counts (`C1 6/9`, `C2 1/9`, ...) plus overall `PROMOTE` count.

---

## Why this matters (not just nice-to-have)

The Phase 2 §5.5 cluster dashboard surfaces only the older 4-gate framework (DSR / PBO / HLZ / OOS-IS). The meta-labeling 7-criterion verdict (sessions 5-7, ADRs 018-025) is the **canonical scoring** post-N=27 findings. Before this panel, the methodology research was invisible from the UI — you had to grep `docs/experiments/` to see what passed.

This panel now surfaces it honestly. Critical: `0 of 9 PROMOTE` is rendered prominently. Per the canon (Harvey/Liu/Zhu 2016 estimates 80%+ of published anomalies are false discoveries), universal-fail on noisy memecoin-tier data is the **expected** outcome of an honest deflation pipeline. Hiding it would be dishonest dashboard design.

---

## Schema migration (session 9, this session)

Before session 9, `meta_models` persisted only headline metrics (AUC, kept_trades, M2/M1 sums, lift). The 7-criterion verdict was logged to stdout but **not stored**. The dashboard could only derive C1/C2/C4 from headlines; C3/C5/C6/C7 required reading the trainer's stdout.

Session 9 closed this gap:

1. **Schema:** `ALTER TABLE meta_models ADD COLUMN c1_pass UInt8, ..., c7_pass UInt8, trimmed_mean_native Float64, top1_share_pct Float64, t_stat_native Float64, hlz_bar Float64, verdict_text String` — 12 new columns.
2. **Trainer:** moved verdict-flag computation BEFORE the row insert in `scripts/train_meta_label.py`; added a `_safe_float()` NaN-guard helper and a `_build_verdict_text()` reasoning-tree helper.
3. **Backfill:** re-ran the trainer on all 9 distinct cells. RANDOM_STATE=42 fixed-seed → numerics reproduce within machine precision (verified spot-check on cex_major: AUC=0.5560 unchanged).
4. **Orchestrator:** `deriveRow()` now reads persisted columns when `verdict_text != ''`, falling back to headline-only derivation otherwise. The fallback path is preserved as a safety net but currently unused (all 9 cells backfilled).
5. **Panel:** all 7 pills rendered authoritatively; the previous "partial verdict only" caveat has been removed for fully-persisted rows. Mixed-persistence framing remains as a defensive branch.

**Numerical drift:** zero observed. The trainer is deterministic at seed=42; same inputs → same output.

---

## What I verified (session 9)

- ✅ Schema migration applied: 12 new columns visible via `DESCRIBE TABLE meta_models`.
- ✅ Smoke-test trainer run on `mean_reversion_v1|cex_major|4h|5` produces correct verdict columns: C1=1, C2=0, C3=1, C4=0, C5=0, C6=1, C7=0, verdict_text="REJECT (still net negative)".
- ✅ All 9 cells backfilled. `meta_models` `verdict_text` is non-empty for every row.
- ✅ Orchestrator's `deriveRow()` produces full 7-pill rows; tests cover both persisted-path (priority over headline-derive) and unpersisted-path (legacy fallback).
- ✅ Panel renders 7 pills with proper green/red coloring.
- ✅ Tests: 538 → 540 (+2 for FINAL/UUID regression pins this session). Going back further: 510 (session 8 start) → 540 (session 9 end) = +30.
- ✅ Type-check clean.
- ❌ **NOT yet verified:** live UI render — same restart-required gotcha (tsx isn't running with `--watch`).

---

## How to test it yourself (post-restart)

```bash
# 1. Restart the dev server
npm run dev

# 2. Endpoint smoke:
curl -s 'http://localhost:3000/api/meta-labeling/cells?limit=3' | python -m json.tool

# Expected: rows with c1Pass..c7Pass booleans, nPass integer, allPass boolean,
# verdictText non-empty, verdictPersisted: true.

# 3. Browser:
#   http://localhost:3000/#/meta-labeling
```

**What you should see:**

- Header chip: "Meta-labeling →" violet, top-right.
- Header summary: 9 cell-trainings, full verdict-persistence (9/9). Per-criterion chips show actual pass-counts. The "PROMOTE 0/9" chip is **red**.
- Body framing: "Full 7-criterion verdict persisted for all rows. Pills are authoritative — pass flags + distribution stats from the trainer's runtime evaluation are stored in `meta_models` per the 2026-05-05 schema migration. ... 0 of 9 cells PROMOTE — system rejecting everything that should be rejected (per-canon expected on noisy / regime-mismatched universes; see ADR-025)."
- Table: 9 rows. Each shows 7 colored pills (most red). Verdict badge column shows phrases like "REJECT (no learned signal)", "REJECT (still net negative)", "REJECT (outlier-dominated; ADR-019)".

---

## Known limits + future work

### Currently shipped

- ✅ Full 7-criterion verdict persisted + surfaced
- ✅ Per-criterion summary chips
- ✅ Verdict-badge column with reasoning text
- ✅ Honest framing in header

### Not yet implemented (lower priority)

- **Per-row "experiment log →" links.** Today the user grep `docs/experiments/` by date or m1_run_sig. Auto-matching is fragile because experiment dir names use slugs not cell-keys. Skipped this session.
- **Filter chips by tier / strategy / verdict-class.** Small enough table (9 rows) that ctrl-F-in-browser suffices. Add only if N grows past ~30.
- **Sparkline of AUC over retrains.** Useful if a cell is repeatedly trained with different features / regime overlays. ADR-021 had 12 trainings on two cells; that's where this would shine. Defer until needed.
- **Drilldown panel** — click a row → modal with `m1_run_sig`, full hyperparams_json, distribution histogram, etc. Substantial work; defer until requested.

---

## Files involved

- **Backend:**
  - [src/server/meta_labeling_dashboard.ts](../../src/server/meta_labeling_dashboard.ts) — orchestrator (~340 lines, pure-function seam, full persisted-verdict path)
  - [server.ts](../../server.ts) — route handler `/api/meta-labeling/cells`
  - [scripts/train_meta_label.py](../../scripts/train_meta_label.py) — verdict computation moved pre-insert; `_safe_float` + `_build_verdict_text` helpers
- **Frontend:**
  - [src/components/metaLabeling/MetaLabelingApp.tsx](../../src/components/metaLabeling/MetaLabelingApp.tsx)
  - [src/components/metaLabeling/ResearchLogPanel.tsx](../../src/components/metaLabeling/ResearchLogPanel.tsx) — full 7-pill rendering, verdict badge, adaptive framing
  - [src/main.tsx](../../src/main.tsx)
  - [src/App.tsx](../../src/App.tsx)
- **Tests:**
  - [scripts/tests/metaLabelingRoute.test.ts](../../scripts/tests/metaLabelingRoute.test.ts) — covers persisted-verdict + legacy-fallback paths + summarize behavior
- **Schema:**
  - `quantlab.meta_models` migrated (12 new columns, all DEFAULT-safe for legacy rows)

---

## Why "verdict_text != ''" is the persistence probe

Cleanest signal because:

1. Distinct from any computed value (an empty string is structurally different from `0`, `false`, or any genuine verdict text).
2. Trainer ALWAYS writes a non-empty value (PROMOTE / REJECT / PARTIAL). So newly-persisted rows always have it.
3. Legacy rows pre-migration get DEFAULT `''` from CH automatically.
4. No extra `verdict_persisted` boolean column needed.

The orchestrator's `deriveRow()` reads `verdict_text` first; if empty, falls back to headline-only derivation (and sets `verdictPersisted: false` on the response). The panel uses `verdictPersisted` to decide whether to render the full 7 pills or just the partial set.
