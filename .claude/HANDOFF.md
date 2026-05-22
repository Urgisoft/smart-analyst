# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 95 #5 — **ADR-041 implementation LIVE — `yield_curve_inverted` redefined under Estrella-Mishkin 1998 canon**: T10Y3M < 0 single-day fire replaces T10Y2Y/3-day persistence rule, same category name + same `yield_curve_value` column repurposed in-place. New diagnostic `yield_curve_inversion_days_20d` field (Nullable UInt8) ships alongside as a counter (not part of firing logic). Single commit `4406674`. 5 files: `src/server/macro_regime_v3.ts` (+177 / -33), `src/server/clickhouse.ts` (+25 / -4 — idempotent ADD COLUMN IF NOT EXISTS), `src/server/regime_dashboard.ts` (+8 / -3 — `BIAS_NOTE_PHASE1_V3` reworded + ADR-041 docLink), `docs/specs/macro-regime-classifier-phase1_v3.md` (+5 / -1 — PARTIALLY SUPERSEDED header), `scripts/tests/macroRegimeV3.test.ts` (+159 / -26 — 21 new tests replacing 8 obsolete persistence tests, net +13). Pure helpers: `checkYieldCurveInverted(history): 0|1` single-arg + `computeInversionDays20d(history, window=20): number | null`. `INPUTS_MISSING_T10Y2Y` → `INPUTS_MISSING_T10Y3M` (same bit value 64 preserved). Loader switched from `loadFredSeries(ch, 'T10Y2Y', …)` to `'T10Y3M'` — FRED ingest already pulled both series (no Python touched this turn). Full TS suite 2919 / 2890 pass / 1 fail (pre-existing CH-unreachable `gicsSectorRepositoryHelper SMP-6` — NOT a regression) / 28 skipped; net +13 tests / +13 pass vs s95 #4. **47 commits ahead of `origin/main`.** **NEXT default on `continue`: operator pick — recommended slice if operator says only "continue": Quartz docs site + frontmatter (s95 #4 architecture confirmed, pre-scoped).**)

## What this turn delivered

Resolves the gap #7 v2 per-row recency arc's only remaining sibling work and lands the ADR-041 redefinition without any new CH schema column needing operator approval (the migration is additive `IF NOT EXISTS`, identical posture to the other `clickhouse.ts` migrations).

The ADR-041 vs existing-phase1_v3-code conflict (existing `yield_curve_inverted` used T10Y2Y + 3-day persistence; the ADR mandates T10Y3M + 1-day, same name) was a HARD STOP per autonomous-execution protocol. Operator picked **Replace (canon-dominant)** — change semantic in place under the same name. The three-criterion canon test argued for this (Estrella-Mishkin 1998 Tier 1 > Estrella-Hardouvelis 1997 Tier 1; Estrella-Trubin 2006 finds T10Y3M slightly outperforms; zero in-sample params > 3-day persistence's 1 unjustified param).

1. **`src/server/macro_regime_v3.ts`** (+177 / -33 LOC):

   - `checkYieldCurveInverted(t10y3m_history): 0 | 1` — single-arg helper, reads only `length-1` (today). Strict `< 0`; null today / empty history → 0.
   - `computeInversionDays20d(t10y3m_history, window=20): number | null` — new pure helper. Counts trailing `window` observations < 0. Returns `null` when fewer than `window` non-null values exist in the window (truncated).
   - `INPUTS_MISSING_T10Y2Y` → `INPUTS_MISSING_T10Y3M` (same bit value `1 << 6 = 64` preserved so historical-row decodes still surface as "yield-curve input absent" under the renamed constant).
   - `YIELD_CURVE_PERSISTENCE_DAYS = 3` — REMOVED.
   - `YIELD_CURVE_INVERSION_DAYS_WINDOW = 20` — new diagnostic-only constant (NOT a tuning knob).
   - `ClassifierInputV3.t10y2y_history` → `t10y3m_history` (20-day window needed for the diagnostic counter; firing reads only `length-1`).
   - `MacroRegimeRowV3.yield_curve_inversion_days_20d: number | null` — new REQUIRED row field.
   - `RegimeDataBundleV3.t10y2yDates / t10y2yByDate` → `t10y3mDates / t10y3mByDate`.
   - `T10Y2Y_PREFIX_DAYS = 20` → `T10Y3M_PREFIX_DAYS = 35` (wall-clock pad so the 20-trading-day window warms up from the first classify date even across weekends + holidays).
   - Loader: `loadFredSeries(ch, 'T10Y2Y', …)` → `loadFredSeries(ch, 'T10Y3M', …)`. FRED ingest already pulls both series (T10Y3M is the PRIMARY per Estrella-Trubin 2006 per `scripts/fred_ingest.py:59`).
   - `backfillMacroRegimesV3` writer block threads the new field on every row.
   - Module-level "What could break this" note updated: the column semantic shifts across the ADR-041 cut; pre-ADR-041 historical rows in `yield_curve_value` carry T10Y2Y, post-cut rows carry T10Y3M. The operator re-backfill is the resolution (flagged as a pending action below).

2. **`src/server/clickhouse.ts`** (+25 / -4 LOC):

   - Inline comments updated for the new `yield_curve_inverted` + `yield_curve_value` semantics + the pre-ADR-041 cross-cut data note.
   - New idempotent `ALTER TABLE quantlab.macro_regimes ADD COLUMN IF NOT EXISTS yield_curve_inversion_days_20d Nullable(UInt8) AFTER yield_curve_value`. Historical rows get NULL under the default until re-backfilled.

3. **`src/server/regime_dashboard.ts`** (+8 / -3 LOC):

   - `BIAS_NOTE_PHASE1_V3.body` rewords the yield-curve clause to T10Y3M single-day per ADR-041; canon citation swap Estrella-Hardouvelis 1997 → Estrella-Mishkin 1998.
   - `docLinks` adds ADR-041 entry.
   - Existing test pins (`assert.match(body, /yield[_ ]curve/i)`, etc.) are loose enough to still pass.

4. **`docs/specs/macro-regime-classifier-phase1_v3.md`** (+5 / -1 LOC):

   - Header status flag added: "PARTIALLY SUPERSEDED" with one-paragraph supersession note pointing at ADR-041 for the yield_curve semantic change.
   - `Authority` list gains ADR-041 alongside ADR-037.

5. **`scripts/tests/macroRegimeV3.test.ts`** (+159 / -26 LOC; +13 net tests):

   - 8 firing tests rewritten under the new rule (today < 0 fires; day-1 inversion fires no-persistence-dep; 0.00 / +0.01 don't fire; -0.01 fires; null-today suppresses + flags `INPUTS_MISSING_T10Y3M`; empty history → 0; historical inversion can't force today's fire).
   - 4 `checkYieldCurveInverted` helper tests for the single-arg API.
   - 6 `computeInversionDays20d` tests (full window / all-negative → 20 / all-zero strict-`<`-0 → 0 / truncated → null / null-gaps → null / tail-only-window semantic).
   - 3 row-field `yield_curve_inversion_days_20d` tests (populates on the row, returns null on truncated history, fire=0 + counter=19 is a valid state on the day inversion ends — counter is independent of firing rule).
   - `YIELD_CURVE_PERSISTENCE_DAYS` threshold pin REMOVED; `YIELD_CURVE_INVERSION_DAYS_WINDOW = 20` pin ADDED.
   - 22 existing `t10y2y_history` literals migrated to `t10y3m_history` (mostly via the new 20-entry `t10y3mFlat(value)` helper; firing-relevant tests use the canonical 20-entry shape so the counter is meaningful).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
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
| Form 4 ingest XML body URL discovery (hotfix) | ✓ s95 #3 (`831b1b0`) — UNBLOCKS first-apply |
| Gap #7 v2 per-row recency (F4 daysSinceLatestBuy/Sell) | ✓ s95 #4 (`b3d63a2`) |
| **ADR-041 implementation (`yield_curve_inverted` redefinition)** | **✓ s95 #5 (`4406674`) — Estrella-Mishkin canon LIVE** |
| Gap #7 v2 per-EVENT EK recency (§8.1 "12d ago + 18d ago" per-item format) | ☐ deferred — operator-pickable |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| Quartz docs site + status frontmatter + dashboard | ☐ pre-scoped (s95 #4 architecture confirmed; recommended default on bare `continue`) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 47 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 part 5 (this turn, one commit `4406674`)

**S95-24. ADR-041 redefinition is "Replace in place" — same column name `yield_curve_value` carries T10Y3M post-cut; same category name `yield_curve_inverted` carries the new semantic.**
`Why:` Operator-chosen path on the ADR-041-vs-existing-phase1_v3-code conflict. The existing phase1_v3 `yield_curve_inverted` used T10Y2Y + 3-day persistence (Estrella-Hardouvelis 1997) — same name as the ADR's mandated category. ADR-041 §3's "additive" + "increment by 1" language was internally inconsistent with the same-name mandate; the ADR author appears not to have known about the pre-existing implementation. The autonomous canon test (Estrella-Mishkin Tier 1 > Estrella-Hardouvelis Tier 1 per Estrella-Trubin 2006; zero in-sample params > 1 unjustified persistence param; T10Y3M slightly outperforms T10Y2Y per Bauer-Mertens 2018) argued for canon-dominant replace. Operator concurred and picked "Replace".

`How to apply:` Future ADR conflicts where the ADR's literal text is internally inconsistent with existing code should surface to operator via AskUserQuestion with concrete options + a recommendation grounded in the three-criterion test. Do NOT attempt to auto-resolve under "canon-thin methodology fork" — those are forks the ADR author already authored on a clean slate. ADR-vs-implementation conflicts are HARD STOPS.

**S95-25. `INPUTS_MISSING_T10Y3M` preserves the bit value `1 << 6 = 64` formerly held by `INPUTS_MISSING_T10Y2Y`.**
`Why:` Historical-row decodes of `inputs_missing` should still surface as "yield-curve input absent" without a separate decode path. The semantic of bit 6 is unchanged ("today's yield-curve input is null"); only the underlying FRED series identifier changed.

`How to apply:` Future input-source swaps within the same conceptual category should preserve the bit value where possible. Renaming the constant is fine and signals the source change; reusing the bit value preserves backward-decode of historical bitmask integers.

**S95-26. The new column `yield_curve_inversion_days_20d` is `Nullable(UInt8)`, NOT `Nullable(Float64)` like its sibling `yield_curve_value`.**
`Why:` Count semantics — values are integers in [0, 20]. UInt8 covers the range with a 4x storage savings vs Float64; null is meaningful (truncated / cold-start window where the counter would understate sustained inversion). Float64 would over-allocate.

`How to apply:` Future diagnostic-counter columns with bounded integer ranges should default to `Nullable(UInt8)` (or `UInt16` if > 255 is possible). Reserve `Nullable(Float64)` for measurement columns (returns, ratios, observations).

**S95-27. `T10Y3M_PREFIX_DAYS = 35` (NOT 20).**
`Why:` The `T10Y2Y_PREFIX_DAYS = 20` constant was sized for the 3-day persistence check (`length >= 3` requirement); under the new rule the firing only needs `length >= 1`, but the diagnostic counter `computeInversionDays20d` needs 20 trading days of non-null values. 20 trading days spans ~28 wall-clock days (two weekends + a holiday), so 35 wall-clock days is the safe pad that warms the counter on day 1.

`How to apply:` Future loader prefix-day constants should be sized against the LONGEST consumer window, not the firing-logic window. If a v3 helper grows that needs 60 trading days, this constant rises again. Keep the constant local to `macro_regime_v3.ts` (NOT a global) so the dependency is visible.

**S95-28. The diagnostic counter's null policy: requires ≥ window non-null values OR returns null.**
`Why:` The counter's purpose is the "flash vs sustained" distinction; a truncated window would understate sustained inversion and mislead the operator. The s95 #4 per-row recency reports "days since the most recent" which has a well-defined answer on any non-empty list of that code's trades. Different semantic, different null policy.

`How to apply:` New diagnostic helpers should declare their null policy in the docstring + pin it in a dedicated test (T-F4-DSLB-2 / T-CC-IDP-{full / partial / null-gaps}). Don't assume null-policy parity across helpers — surface the policy explicitly.

**Carry-over from s95 #4 (still in force):**

- S95-15..S95-23 — F4 per-row recency uses `acceptedAt`; no DDL change because `per_ticker_json` is free-form; `formatDaysSinceLast` is a separate helper from `formatDaysSince`; `daysSinceLatest{Buy,Sell}` are REQUIRED on `Form4InsiderPerTickerRow` + `BriefForm4InsiderSection.perTickerRows[]`; floor semantic on day-count; Quartz vault scope = `docs/` root + build-time TS generator + `type` field; single-source-of-truth confirmed.

**Carry-over from s95 #3 (still in force):**

- S95-11..S95-14 — EDGAR Form 4 body URL discovery contract, `ciks_all` parser field, XML selection precedence, positive-only cache.

**Carry-over from s95 #2 (still in force):**

- S95-6..S95-10 — sell-side persistence + render conventions, log-line suffix-extension, EK/XD buy-side-only, footer placement.

**Carry-over from s95 #1 (still in force):**

- S95-1..S95-5 — sell-cluster composite parameters + interface posture.

**Carry-over from s94 #11 (still in force):**

- S94-29..S94-33 — sector cluster rate, daemon log line tokens, render branch order.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-33 + S95-1..S95-23 carry through.

## Open questions

### Newly opened (s95 #5) — none

The "Replace vs Coexist" fork was resolved by operator at AskUserQuestion at the start of this turn. No remaining forks within scope. The `yield_curve_value` column carries a mix of T10Y2Y (pre-cut) + T10Y3M (post-cut) values until the operator runs the re-backfill — that's an OPERATOR-PENDING action item, not an open methodology question.

### Carried from s95 #3

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
- Push commits to origin/main — operator-gated.
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

## Next stage

### Default on `continue` — operator pick

The ADR-041 implementation arc is closed. Operator picks the next slice. If they just say "continue" with no context, the recommended default is **Quartz docs site + status frontmatter + auto-generated dashboard** — pre-scoped at s95 #4, architecture confirmed (S95-20..S95-23), 5 commits / ~600 LOC / ~6 tests. The Quartz slice is the natural next step now that the EK + F4 v2 arcs + ADR-041 are all closed; the docs site materializes the project state for browsing.

### Candidate slices (in rough order of "next obvious code-only work")

1. **Quartz docs site + status frontmatter + auto-generated dashboard** (operator-queued s95 #4, architecture confirmed) — pre-scoped, ready to execute. **5 commits, ~600 LOC, ~6 tests.** Operator says "do the Quartz slice" / "start docs visualization" to kick off. Architecture pre-locked at S95-20..S95-23:

   - Vault scope = `docs/` root; NO file moves.
   - Dashboard = build-time TS generator (`scripts/generate_docs_dashboard.ts`), regenerated on every `npm run docs:build`, never hand-edited.
   - Frontmatter schema: `status / phase / last_updated / owner / type / [slice_id] / [depends_on]`.
   - Quartz v4; output `docs/.quartz-site/` (gitignored); npm scripts `docs:build`, `docs:serve` (port 8080), and `dev:all` (concurrently :3000 app + :8080 docs).
   - Single source of truth confirmed: vault Markdown files ARE the state.
   - Commit plan: (1) install + config + scripts; (2) frontmatter rollout to ~50 priority docs; (3) generator + ~6 fixture tests; (4) Mermaid chart templates; (5) convention doc.

2. **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format) — separate row shape: `eventsByItemCode: Array<{itemCode: string, daysSinceLatest: number}>` on the EK per-ticker row. Renderer extends `formatEightKItemList` to interleave the per-item recency. ~3 files, ~80 LOC, ~5-6 tests.

3. **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — adds a secondary data path that cross-validates the primary etf-flow ingest against an issuer-supplied CSV when available; logs divergences as anomalies. Operator-pickable.

4. **Gap #7 v2 13D/13G arc** — needs its own SPEC first; deferred until operator says go.

5. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

6. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

7. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

8. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

### Operator-gated action items (carried + NEW from this turn)

- **NEW (s95 #5): Re-run `npm run macro:backfill:v3`** — rewrites historical `quantlab.macro_regimes` rows under the new T10Y3M source for `yield_curve_value` + `yield_curve_inverted` + (populated) `yield_curve_inversion_days_20d`. Until run, the column carries a step-change in semantic at the trade_date of the next live daemon cycle: pre-cut rows = T10Y2Y values; post-cut rows = T10Y3M values. The `What-could-break-this` module note in `macro_regime_v3.ts` flags this for downstream consumers. **Non-blocking** for the brief / daemon — they read the latest row only.
- **NEW (s95 #5): `quantlab.macro_regimes` ALTER auto-applies** on next daemon startup via the existing `clickhouse.ts` idempotent migration runner (no operator runbook needed; the `ADD COLUMN IF NOT EXISTS` posture is identical to all prior phase1_v3 ALTERs in this file). Historical rows get NULL for the new column until the re-backfill runs.
- Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3 — first apply now works; produces real F4 cluster_buy / cluster_sell rows with "last Xd" recency hints visible in the morning brief).
- Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply` to surface s95 #2 sell-side persistence end-to-end on the real CH (still pending).
- Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs (still pending from s94 #8).
- Apply `migrate:create-form-4-insider-snapshots:apply` (operator hit this gap mid-runbook in s95 #3 turn — base table doesn't exist on their CH yet).
- Push 47 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s95 #5 — commit `4406674`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/macro_regime_v3.ts` | +177 / -33 | T10Y2Y → T10Y3M throughout; new `checkYieldCurveInverted` (1-arg, single-day) + `computeInversionDays20d` helpers; `INPUTS_MISSING_T10Y3M` (bit 6 preserved); new REQUIRED `yield_curve_inversion_days_20d` row field; loader switched to FRED `T10Y3M`. |
| `src/server/clickhouse.ts` | +25 / -4 | Inline comments updated; new idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS yield_curve_inversion_days_20d Nullable(UInt8) AFTER yield_curve_value`. |
| `src/server/regime_dashboard.ts` | +8 / -3 | `BIAS_NOTE_PHASE1_V3` body reworded T10Y2Y → T10Y3M + Estrella-Hardouvelis → Estrella-Mishkin; ADR-041 docLink added. |
| `docs/specs/macro-regime-classifier-phase1_v3.md` | +5 / -1 | Header gains "PARTIALLY SUPERSEDED" status flag + ADR-041 supersession note. |
| `scripts/tests/macroRegimeV3.test.ts` | +159 / -26 | Yield-curve test block rewritten under new rule; +21 new tests, -8 obsolete persistence tests = +13 net; `t10y3mFlat` helper introduced. |

### Carried unchanged from s95 #4 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | s95 #4 LIVE | `daysSinceLatestTradeByCode` helper + 2 REQUIRED row fields. |
| `src/server/operator_brief.ts` | s95 #4 LIVE | Composer threads recency fields verbatim. |
| `src/server/operator_brief_render.ts` | s95 #4 LIVE | `formatDaysSinceLast` + "last Xd" segment inside net-dollar parens. |

### Carried unchanged from s95 #3 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | s95 #3 LIVE | `parse_edgar_search_response` emits `ciks_all` field. |
| `scripts/sec_edgar_form4_ingest.py` | s95 #3 LIVE | `discover_form4_primary_xml_url` + `_select_form4_xml_from_directory`. |

### Carried unchanged from s95 #2 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` | s95 #2 SHIPPED | Operator-gated ALTER ready to apply. |
| `src/server/form_4_insider_repository.ts` | s95 #2 LIVE | Persists + decodes sell-side fields. |

### CH state

- **New: `quantlab.macro_regimes` gains `yield_curve_inversion_days_20d Nullable(UInt8)` column on next daemon startup** via the existing idempotent migration in `clickhouse.ts`. NO operator-gated migrate script — the additive column posture matches all other phase1_v3 ALTERs in this file and auto-runs.
- **Existing: `quantlab.macro_regimes.yield_curve_value` semantic shifts** at the trade_date of the next live daemon cycle: pre-cut rows = T10Y2Y; post-cut rows = T10Y3M. Until the operator runs `npm run macro:backfill:v3` to rewrite historical rows, the column carries a step-change. Downstream consumers (regime dashboard, brief, anything querying the column historically) should expect this.
- Nine Layer-0 composite snapshot tables + three event tables remain in the state from s93 / s94 / s95 #1+#2+#3 close.
- **Operator-pending ALTERs (carried):**
  - `migrate:create-form-4-insider-snapshots:apply` (operator-gated; base table) — REQUIRED first.
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3, carry from s94 #8).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/macroRegimeV3.test.ts               # 58 pass / 0 fail / 0 skipped
npx tsx --test scripts/tests/macroRegimeFixturesV3.test.ts \
              scripts/tests/macroRegimeBackfill.test.ts \
              scripts/tests/regimeDashboard.test.ts              # 49 pass / 0 fail (BIAS_NOTE_PHASE1_V3 wording change passes the loose regex pins)

npm test                                                          # TS — this turn 2919 / 2890 pass / 1 fail / 28 skipped
                                                                  # 1 fail = pre-existing CH-unreachable gicsSectorRepositoryHelper SMP-6
                                                                  # +13 net vs s95 #4 = 21 new ADR-041 tests minus 8 obsolete persistence tests

npx tsc --noEmit                                                  # 13 baseline errors unchanged

npm run check:help                                                # green
```

`pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s95 #5)

- **`yield_curve_value` column carries mixed semantics across the ADR-041 cut.** Pre-cut historical rows have T10Y2Y values; post-cut rows have T10Y3M values. Until the operator runs `npm run macro:backfill:v3`, queries that read this column historically WILL see a step-change at the trade_date of the first daemon cycle post-merge. The module-level "What could break this" note in `macro_regime_v3.ts` flags this. Downstream consumers should treat the column as "yield-curve observation" (semantic stable: smaller = closer to inversion / inverted when negative) rather than "T10Y2Y" or "T10Y3M" specifically — both are 10-year spreads, magnitude ranges overlap.

- **`MacroRegimeRowV3` gained 1 new REQUIRED field** — `yield_curve_inversion_days_20d: number | null`. Any future test fixture / callsite constructing `MacroRegimeRowV3` MUST include this field. Default to `null` unless exercising the counter; for firing tests use the new 20-entry `t10y3mFlat(value)` helper which produces a meaningful counter value.

- **`INPUTS_MISSING_T10Y3M` reuses bit value `1 << 6 = 64`** formerly held by `INPUTS_MISSING_T10Y2Y`. Historical-bitmask decodes still surface bit 6 as "yield-curve input absent" under either name. Future input-source swaps within the same conceptual category should preserve the bit value (S95-25 rule).

- **`computeInversionDays20d` returns null on truncated windows, NOT 0.** A history with 19 non-null entries (one short of the window) returns null — NOT 19. The semantic is "the counter would be unreliable on this short window, so don't surface a number that suggests certainty." Test pin in `macroRegimeV3.test.ts` covers this. Future helpers with similar windowed-count semantics should explicitly declare + test the null-vs-zero boundary (S95-28 rule).

- **`T10Y3M_PREFIX_DAYS = 35` is sized against the DIAGNOSTIC counter window, NOT the firing window.** Firing reads only today; counter reads 20 trading days. Wall-clock 35 days warms 20 trading days even with two weekends + a holiday gap. If a future helper grows that needs 60 trading days, this constant rises (NOT a global).

- **The diagnostic counter is NOT a tuning knob.** `YIELD_CURVE_INVERSION_DAYS_WINDOW = 20` matches the 20d-return window conventions in `macro_regime_v3.ts` (`HYG_SPY_DIVERGENCE_LOOKBACK = 20`, `CREDIT_AND_ROTATION_LOOKBACK = 20`); the window length is a convention pick, not an optimization target. Future ADR amendments that change the firing logic should NOT touch this constant unless the FIRING rule itself shifts to "K consecutive days < 0" (which would re-open the canon-thin sub-fork ADR-041 §Resolved at Accept item 1 explicitly closed).

- **The pre-existing `gicsSectorRepositoryHelper SMP-6 EXPLAIN PLAN` test failure is NOT a regression.** Same CH-unreachable failure as s95 #4. NOT in s95 #5 scope.

### Carried from s95 #4 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- F4 recency uses `acceptedAt` not `transactionDate` (S95-15); v2 ADR can switch if precision matters.
- `Form4InsiderPerTickerRow` + `BriefForm4InsiderSection.perTickerRows[]` have 2 REQUIRED recency fields.
- F4 brief row regex assertions widened to tolerate `, last Xd`.
- EK per-EVENT recency (§8.1 mockup "12d ago + 18d ago" per-item) STILL deferred — separate slice.
- The composite source files have `\0` literals (carried watch-out).
- The §1.4 three-branch order is load-bearing (LIVE → no-flag-cleared → cold-start) both directions.

(All earlier s89-s95 #4 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l). yield_curve_inverted now fires under T10Y3M < 0 per ADR-041.
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### macro_regime_v3 — re-backfill to rewrite historical T10Y2Y rows under T10Y3M (operator-pending)

```text
# Optional: rewrites quantlab.macro_regimes historical rows so yield_curve_value carries T10Y3M
# across the full corpus + populates the new yield_curve_inversion_days_20d column.
# Non-blocking: the daemon + brief read the LATEST row, which is already correct post-merge.
npm run macro:backfill:v3
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3 — discovery via index.json
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply   # REQUIRED
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily                                    # writes per_ticker_json with recency keys
npm run brief:morning                                   # F4 §15 renders "last Xd"
```

### Gap #7 8-K classifier (G2 LIVE; per-row daysSinceLatestEvent ALREADY LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning                                   # EK §14 material_event rows show "(Xd ago)"
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
npm test                                                                       # TS — this turn 2919 / 2890 pass / 1 fail / 28 skipped (1 fail = pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 332 pass at s95 #3 close (unchanged, no Python touched s95 #4 or #5)
npx tsx --test scripts/tests/macroRegimeV3.test.ts                             # 58 pass — includes the new ADR-041 test block
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #5 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** operator picks the next slice. If they just say "continue" with no context, the recommended default is **Quartz docs site + status frontmatter + auto-generated dashboard** — pre-scoped at s95 #4, architecture confirmed (S95-20..S95-23), ready to execute. The Quartz slice is the natural next step now that EK + F4 v2 arcs + ADR-041 are all closed end-to-end.

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6` failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the default-next:

- **Quartz docs site** (recommended default).
- **Gap #7 v2 per-EVENT EK recency** (§8.1 "12d ago + 18d ago" per-item format).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried + NEW):**

- **NEW (s95 #5): Re-run `npm run macro:backfill:v3`** — rewrites historical `quantlab.macro_regimes` rows so `yield_curve_value` + `yield_curve_inverted` use T10Y3M corpus-wide; populates `yield_curve_inversion_days_20d`. Non-blocking.
- Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3; produces real per-row payloads with recency hints).
- Apply `migrate:create-form-4-insider-snapshots:apply` (REQUIRED — base table absent in operator's local CH).
- Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs (carry from s94 #8).
- Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).
- Push 47 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**ADR-041 is FULLY CLOSED.** The phase1_v3 `yield_curve_inverted` category now fires under Estrella-Mishkin 1998 canon: T10Y3M < 0 on today's value, single-day, no persistence. Diagnostic counter `yield_curve_inversion_days_20d` ships alongside as `Nullable(UInt8)` for the "flash vs sustained" operator distinction (NOT a tuning knob).

**The ADR-vs-existing-code conflict** (existing phase1_v3 used T10Y2Y + 3-day persistence under the same category name) was a HARD STOP surfaced to operator via AskUserQuestion. Operator picked "Replace in place" — the canon-dominant path (Tier 1 Estrella-Mishkin > Tier 1 Estrella-Hardouvelis per Estrella-Trubin 2006; zero in-sample params > 1 unjustified persistence param). S95-24 captures the rule: future ADR-vs-code conflicts where the ADR text is internally inconsistent should surface to operator, NOT auto-resolve under "canon-thin methodology fork".

**`yield_curve_value` column carries mixed semantics across the cut.** Pre-cut historical rows = T10Y2Y; post-cut rows = T10Y3M. The operator re-backfill (`npm run macro:backfill:v3`) is the resolution but is NON-BLOCKING — the daemon + brief read the latest row only, which is already correct.

**NO operator-gated migrate script for the new column.** The `ADD COLUMN IF NOT EXISTS yield_curve_inversion_days_20d Nullable(UInt8)` posture matches all other phase1_v3 ALTERs in `clickhouse.ts` and auto-applies on next daemon startup. Idempotent.

**Parallel-tracks posture continues.** s95 #5 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2890 pass (1 pre-existing CH-unreachable fail is NOT a regression; +13 net vs s95 #4 = 21 new ADR-041 tests minus 8 obsolete persistence tests).

**The chain through s95 #5:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
        — DDL + persistence + daemon log + brief render
S95 #3: form 4 ingest XML body URL discovery (HOTFIX)   ✓ committed (831b1b0)
        — unblocks first-apply
S95 #4: gap #7 v2 per-row recency (F4 side)             ✓ committed (b3d63a2)
        — daysSinceLatest{Buy,Sell} + "last Xd" render
S95 #5: ADR-041 implementation                          ✓ committed (4406674)
        — yield_curve_inverted T10Y3M single-day fire
        — yield_curve_inversion_days_20d diagnostic counter
        — Estrella-Mishkin 1998 canon citation
S95 #5 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator picks. Recommended default if
                  operator says "continue" without context:
                  Quartz docs site + frontmatter + dashboard
                  (s95 #4 architecture pre-locked, 5 commits
                  / ~600 LOC / ~6 tests).
  → background: phase1_v3 yield_curve_inverted now operates
                under ADR-041 canon. The next live daemon
                cycle writes T10Y3M into yield_curve_value
                + populates the new diagnostic counter. The
                full historical re-backfill is operator-
                pending but non-blocking.
```
