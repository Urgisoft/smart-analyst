# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 95 #2 — **gap #7 v2 sell-cluster F4 G3 (S95-2 persistence + render wiring) — F4 ARC CLOSED end-to-end**: DDL migration `migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` adds 4 sell-side CH columns; `writeSnapshot` persists them; `loadLatestSnapshot` decodes them with malformed-JSON degrade; daemon `aggregateLogLine` extends with `sell_cluster_flag=` + `max_z_sell=` tokens; brief composer threads sell-side fields into `BriefForm4InsiderSection`; renderer section #15 §1.4 emits parallel "Sell-side cluster" panel (LIVE / no-flag-cleared / cold-start three-branch). 8 net new G2-SELL-G3-F4-{1..8} tests; full suite 2801 pass / 2 fail (pre-existing CH-unreachable) / 95 skipped; +8 net vs s95 #1. Single commit `d05eb39`. **37 commits ahead of `origin/main`; push still operator-gated.** **NEXT default on `continue`: operator pick — F4 arc fully closed; recommended slice if operator says only "continue": Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).**)

## What this turn delivered

Closure slice for the F4 v2 sell-cluster arc — the natural follow-up to
s95 #1's composite-contract slice. Five files touched (one new), 8 net
new tests, one operator-gated DDL migration ready to apply.

1. **`scripts/migrate_add_sell_cluster_to_form_4_insider_snapshots.ts`** (NEW, ~290 LOC):
   - Byte-equivalent control flow to `migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts` (s94 #8) — only the column list differs.
   - 4 new CH columns:
     - `form_4_sell_cluster_flag UInt8 DEFAULT 0`
     - `flagged_sell_sectors_json String DEFAULT ''`
     - `max_aggregate_z_sell Nullable(Float64)`
     - `max_aggregate_z_sell_sector LowCardinality(Nullable(String))`
   - Pre-migration rows resolve to cold-start defaults via DDL DEFAULTs + the `Nullable` semantic.
   - npm scripts: `migrate:add-sell-cluster-form-4-insider-snapshots` (dry-run) + `…:apply` (operator-gated).

2. **`src/server/form_4_insider_repository.ts`** (~+60 / -20 LOC):
   - `RawSnapshotRow` interface gains 4 sell-side fields.
   - `writeSnapshot` persists all 4 (mirrors the buy-side JSON insert byte-for-byte except for the field names).
   - `loadLatestSnapshot` SELECT extended; sell-side fields decoded with the same posture as the buy-side (malformed `flagged_sell_sectors_json` degrades to `[]` via try/catch; Nullable columns map to `null`).
   - `runDaemonForm4InsiderEvaluation`'s `aggregateLogLine` extends with `sell_cluster_flag=<bool>` + `max_z_sell=<sector>:<z>` tokens at the tail (suffix-extension; existing buy-side tokens unchanged so the generic prefix regex still matches).
   - Bottom "What could break this" watch-out updated to reflect full persistence + render coverage; EK/XD remain buy-side-only by design (no canon for symmetric sell tracking on those composites).

3. **`src/server/operator_brief.ts`** (~+10 LOC):
   - `buildForm4InsiderSection` threads the 4 sell-side fields from the composite snapshot into `BriefForm4InsiderSection`. `flaggedSellSectors` maps element-by-element like `flaggedSectors`.

4. **`src/server/operator_brief_render.ts`** (~+70 LOC):
   - `BriefForm4InsiderSection` interface gains 4 REQUIRED sell-side fields (mirroring S95-2 buy-side posture from s95 #1).
   - `renderForm4InsiderSection` emits a parallel "Sell-side cluster" panel under the existing buy-side panel with the same three-branch §1.4 structure (LIVE table / no-flag-cleared / cold-start).
   - The sell-side no-flag-cleared branch carries a Lakonishok-Lee 2001 §4 interpretive footer (~30-50% diluted vs buys) so the operator can weight the asymmetric signal appropriately.

5. **Tests (~+390 / -5 LOC across three test files; +8 net new tests)**:
   - **G2-SELL-G3-F4-1** (`form4InsiderRepository.test.ts`) — `writeSnapshot` stamps all 4 sell-side columns from the snapshot (including JSON encoding for `flagged_sell_sectors_json` + cold-start pass-through).
   - **G2-SELL-G3-F4-2** — `loadLatestSnapshot` recovers all 4 sell-side columns; pre-migration / cold-start row (empty-string DEFAULT on JSON column + Nullable NULL) resolves to cold-start defaults.
   - **G2-SELL-G3-F4-3** — malformed `flagged_sell_sectors_json` degrades to `[]`.
   - **G2-SELL-G3-F4-4** — daemon `aggregateLogLine` appends `sell_cluster_flag=` + `max_z_sell=` tokens; cold-start values are `false` + `n/a:n/a`.
   - **G2-SELL-G3-F4-5** (`operatorBrief.test.ts`) — composer threads all 4 sell-side fields into the brief section; buy + sell are independent (cold-start buy-side coexists with live sell-side flag).
   - **G2-SELL-G3-F4-6** (`operatorBriefRender.test.ts`) — LIVE sell-side branch renders the panel header + table; buy-side coexists with its own no-flag-cleared line.
   - **G2-SELL-G3-F4-7** — no-flag-cleared sell-side renders the panel + k/11 + max-|z| + the L&L 2001 §4 dilution footer.
   - **G2-SELL-G3-F4-8** — cold-start renders the "awaits SP500 constituents" text on BOTH panels.
   - Existing G2-DAEMON-F4-1 regex pin updated for the new tail shape.
   - Existing G2-RENDER-F4-1 `doesNotMatch` narrowed to the buy-side panel header (the sell-side now legitimately emits "No sectors flagged today" in that fixture).
   - 17 existing `BriefForm4InsiderSection` test literals updated with the 4 new REQUIRED sell-side fields (replace_all on the stable `compositeVersion:` anchor).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH | ✓ s94 #1-#5 |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| Gap #7 v2 sell-cluster F4 composite contract | ✓ s95 #1 (`b398b4e`) |
| **Gap #7 v2 sell-cluster F4 G3 — DDL + persistence + daemon log + brief render** | **✓ s95 #2 (`d05eb39`) — F4 ARC FULLY CLOSED** |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable |
| Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap) | ☐ deferred (operator-pickable; recommended next default) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 37 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 part 2 (this turn, one commit)

**S95-6. Sell-side persistence ALTER uses a SEPARATE migration script (not bolted onto the s94 #8 max-z migration).**
`Why:` The s94 #8 `migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts` was operator-applied (or is about to be); rolling new columns into it now would require re-running the OQ-G3-1 strategy (β) decision tree. A separate script keeps the audit trail clean — each migration is one coherent slice. Same posture as the s94 #8 / OQ-G3-1 design that split per-composite migrations.

`How to apply:` Future composite-extension column adds (sell-side, sub-sector, etc.) get their own ALTER script keyed to the slice that introduced the composite-layer field. Idempotent ALTER pattern via system.columns pre-check skip.

**S95-7. The daemon log line extends as a SUFFIX (sell-side tokens after buy-side `cluster_flag=`), NOT as an interleaved restructure.**
`Why:` The shared generic regex pin `(xd|ek|f4)-aggregate\] sectors_with_z=…/11 floor_cleared=…/11 max_z=…:… cluster_flag=(true|false)` has no end-anchor and matches as a prefix. Appending sell-side tokens at the tail keeps that pin valid across all three composites without requiring per-composite regex variants. The F4-specific anchored test (G2-DAEMON-F4-1) was updated to anchor on the new tail shape.

`How to apply:` Future composite log-line extensions follow the same suffix-extension posture. If EK or XD ever grow symmetric sell-side tracking (needs a canon argument), they extend the SAME way — appended after the existing tail tokens.

**S95-8. EK + XD aggregate log lines stay buy-side-only; symmetric sell tracking is F4-specific in v1.**
`Why:` F4's symmetric track has a canon citation (Lakonishok-Lee 2001 §4 — insider sells are diluted but informationally non-zero). EK material events and XD executive departures have NO equivalent canon argument for treating "absence of event" as a symmetric signal — they are inherently one-directional (an event either happens or doesn't). Extending the symmetric posture to EK/XD without a canon defense would manufacture signal that the data doesn't carry.

`How to apply:` A future v2 ADR can resurface symmetric tracking for EK/XD IF a canon citation supports it. Until then, the asymmetry is intentional + documented in the F4 "What could break this" tail.

**S95-9. Sell-side L&L 2001 §4 dilution footer rendered ONLY on the sell-side no-flag-cleared branch (NOT the LIVE branch).**
`Why:` The LIVE branch's table is self-explanatory (the sector + z values speak for themselves; the operator reads off the magnitude); the no-flag-cleared branch is where the "interpret weak signal correctly" reminder is most needed (operator is more likely to under-weight a "no signal today" line if they don't internalize that the sell signal is diluted to begin with). The cold-start branch's "awaits coverage" wording is also clear without the L&L footer.

`How to apply:` Future composites with directional asymmetry citations follow the same posture — interpretive footers attach to the branch where the operator is most likely to mis-weight the signal, not as a generic header.

**S95-10. `inputsAvailableAggregate` IS overloaded across buy + sell directions (Option C extension from S94-32).**
`Why:` Sector membership in the SP500 PIT panel is direction-agnostic — a sector either has constituents today or it doesn't. The same cleared-floor count therefore applies to both directions. The separate baselines (`baseline2y` vs `baseline2ySell`) only affect whether each sector PRODUCES a z; the floor-cleared count derives from sector presence, not baseline length. Using a separate `inputsAvailableAggregateSell` would force the renderer to track two counts that are always equal by construction.

`How to apply:` Future asymmetric-direction composites with separate baselines but shared universe use a SINGLE `inputsAvailableAggregate` (and the same daemon-log `sectors_with_z` + `floor_cleared` tokens). If a future composite has direction-SPECIFIC universe (e.g., only "growth" stocks for one direction), THAT composite needs separate counts.

**Carry-over from s95 #1 (still in force):**

- S95-1 — v2 sell-cluster aggregation at z=2.0 (symmetric, inherited from buy-side; zero new tuned parameters).
- S95-2 — Sell-side snapshot fields are REQUIRED (not optional) on `Form4InsiderSnapshot` (now also on `BriefForm4InsiderSection`).
- S95-3 — Separate baseline panels (`baseline2y` for buys, `baseline2ySell` for sells); NOT a shared baseline.
- S95-4 — `computeSectorClusterRate` parameterized with `direction = BUY_CODE` default, NOT split into two functions.

**Carry-over from s94 #11 (still in force):**

- S94-32 — `sectors_with_z` AND `floor_cleared` both report `inputsAvailableAggregate` (Option C) in daemon log line. EXTENDED at S95-10.
- S94-33 — Sector names underscore-tokenized in daemon log line via `.replace(/\s+/g, '_')` — applies to both `max_z=` and `max_z_sell=` tokens.

**Carry-over from s94 #10 (still in force):**

- S94-29 — `maxAggregateZ`/`maxAggregateZSector` REQUIRED across Brief*Section interfaces. Sell-side counterparts (`maxAggregateZSell`/`maxAggregateZSellSector`) follow the same posture.
- S94-30 — T-OBR-*-4 (cold-start tests) REWRITTEN in-place per G2-RENDER-*-3.
- S94-31 — F4 panel header preserves "cluster-buy rate by GICS sector" framing (now joined by parallel "cluster-sell rate by GICS sector" panel).

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-33 + S95-1..S95-5 carry through.

## Open questions

### Newly opened (s95 #2) — none

The F4 sell-cluster arc is now fully closed end-to-end. No canon-thin
forks remaining within the slice scope.

### Carried unchanged from s94 #11

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
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push commits to origin/main — operator-gated.
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess; verification deferred to first ingest run).
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

## Next stage

### Default on `continue` — operator pick (F4 arc is closed)

The F4 v2 sell-cluster arc is now fully shipped end-to-end (composite +
persistence + daemon-log + render). No code-only follow-up is naturally
next on the F4 track. Operator chooses the next slice from the candidate
list below. If the operator simply says "continue" without context, the
recommended default is **Gap #7 v2 per-row recency (S93-32 + S93-52
co-bootstrap of EK + F4 snapshot DDLs)** — that's the next code-only
slice that builds incrementally on the gap #7 + #8 v2 arc without
opening new methodology questions.

### Candidate slices (in rough order of "next obvious code-only work")

1. **Gap #7 v2 per-row recency** — S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs. Add `daysSinceLatestEvent` / `daysSinceLatestBuy` / `daysSinceLatestSell` fields to the per-ticker row payload so the SPEC §8.2 mockup's "last 23d" recency hint lands. Single-slice, ~3 files, ~80 LOC, ~6-8 tests. One operator-gated DDL migration (new columns on `eight_k_classifier_snapshots` + `form_4_insider_snapshots`).

2. **ADR-041 implementation** (`yield_curve_inverted` regime category) — operator-pickable, the canon work is done (ADR Accepted s89). Activation slice extends the regime classifier with the new category + adds the dashboard surfacing. ~5-6 files, ~150 LOC, ~10 tests.

3. **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — adds a secondary data path that cross-validates the primary etf-flow ingest against an issuer-supplied CSV when available; logs divergences as anomalies. Operator-pickable.

4. **Gap #7 v2 13D/13G arc** — needs its own SPEC first; deferred until operator says go.

5. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

6. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

7. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

8. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

### Operator-gated action items (carried)

- Apply DDL migration `migrate:add-sell-cluster-form-4-insider-snapshots:apply` to surface s95 #2 persistence end-to-end on the real CH instance.
- Push 37 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s95 #2 — commit `d05eb39`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `scripts/migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` | NEW (+290) | DDL migration; 4 new CH columns; operator-gated `:apply`. |
| `package.json` | +2 | Two new npm scripts (`migrate:add-sell-cluster-form-4-insider-snapshots[:apply]`). |
| `src/server/form_4_insider_repository.ts` | +60 / -20 | RawSnapshotRow extended; writeSnapshot persists 4 fields; loadLatestSnapshot decodes 4 fields; aggregateLogLine extended with sell-side tokens. |
| `src/server/operator_brief.ts` | +10 | Composer threads 4 sell-side fields through buildForm4InsiderSection. |
| `src/server/operator_brief_render.ts` | +70 / -2 | BriefForm4InsiderSection extended; parallel "Sell-side cluster" 3-branch panel in renderForm4InsiderSection. |
| `scripts/tests/form4InsiderRepository.test.ts` | +163 / -5 | G2-SELL-G3-F4-{1..4}; G2-DAEMON-F4-1 regex pin updated. |
| `scripts/tests/operatorBrief.test.ts` | +42 | G2-SELL-G3-F4-5 (composer pass-through). |
| `scripts/tests/operatorBriefRender.test.ts` | +178 / -1 | G2-SELL-G3-F4-{6..8}; 17 BriefForm4InsiderSection literals updated with 4 new fields; G2-RENDER-F4-1 doesNotMatch narrowed. |

### Carried from s94 #6-#11 + s95 #1 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Steps 1-5 SHIPPED. |
| Three composite `xxx.ts` source files (XD/EK/F4) | s95 #1 close | maxAggregateZ + sector live; F4 has sell-side composite contract. |
| Three `xxx_repository.ts` source files | s95 #1+#2 close | populateSectorsForCycle wired across all; F4 computes baseline2ySell + persists + logs sell-side. |
| Three migrate_add_max_aggregate_z*.ts scripts | s94 #8 SHIPPED | Operator-gated ALTERs ready to apply. |
| **F4 migrate_add_sell_cluster_*.ts** | **s95 #2 SHIPPED** | Operator-gated ALTER ready to apply (4 new sell-side columns). |
| `src/server/operator_brief_render.ts` | s95 #2 SHIPPED | §1.4 three-branch on XD/EK (buy-side); F4 buy-side AND sell-side parallel panels. |
| `src/server/operator_brief.ts` | s95 #2 SHIPPED | Composer pass-through for maxAggregateZ + 4 sell-side fields on F4. |

### CH state

- Nine Layer-0 composite snapshot tables + three event tables remain in
  the state from s93 / s94 / s95 #1 close. **NEW from s95 #2 (pending
  operator-apply):** F4 snapshot table needs the FOURTH operator-gated
  ALTER (`migrate:add-sell-cluster-form-4-insider-snapshots:apply`) to
  surface sell-side persistence end-to-end. Pre-application: in-process
  consumers see real sell-side values via in-memory snapshot;
  cross-cycle stale-read consumers see cold-start sell-side defaults.
- Carry from s94 #8: three Layer-0 snapshot tables each have a pending
  ALTER migration for `maxAggregateZ` persistence
  (`migrate:add-max-z-<composite>-snapshots:apply`).

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/form4InsiderRepository.test.ts \
              scripts/tests/form4Insider.test.ts             # 141 pass / 0 fail / 6 CH-unreachable skips
npx tsx --test scripts/tests/operatorBrief.test.ts \
              scripts/tests/operatorBriefRender.test.ts      # 205 pass / 2 fail (pre-existing CH-unreachable) / 0 skipped

npm test                                                      # 2898 / 2801 pass / 2 fail / 95 skipped
                                                              # +8 net new tests vs s95 #1 (G2-SELL-G3-F4-1..8)
                                                              # 2 fails pre-existing CH-unreachable (operatorBrief.test.ts BIAS_NOTE_PHASE1_V3)

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED

npm run check:help                                            # green
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s95 #2)

- **`Form4InsiderSnapshot` writeSnapshot drops sell-side columns on PRE-MIGRATION tables.** CH ignores unknown column names under JSONEachRow inserts. Until the operator applies `migrate:add-sell-cluster-form-4-insider-snapshots:apply`, the 4 new fields silently fail to persist (in-memory snapshot is correct; cross-cycle stale-read reconstructs at cold-start defaults). After apply, persistence is end-to-end. There is no daemon outage at any point — the DDL ALTER is non-blocking.

- **`BriefForm4InsiderSection` has 4 NEW REQUIRED fields** (`flaggedSellSectors`, `form4SellClusterFlag`, `maxAggregateZSell`, `maxAggregateZSellSector`). Any future test fixture or callsite constructing a `BriefForm4InsiderSection` literal MUST include them. The 17 existing fixtures in `operatorBriefRender.test.ts` were updated via the stable `compositeVersion:` anchor; future authors of new fixtures should default to cold-start (`[]` / `false` / `null` / `null`) UNLESS exercising the sell-side branch explicitly.

- **The daemon `[f4-aggregate]` log line has 2 NEW TAIL TOKENS** (`sell_cluster_flag=…` + `max_z_sell=…:…`). The shared generic regex pin `(xd|ek|f4)-aggregate\] … cluster_flag=(true|false)` is prefix-matched (no end-anchor) so it still matches across all three composites. The F4-specific anchored test (G2-DAEMON-F4-1) was updated to anchor on `max_z_sell=…$`. EK + XD log lines are UNCHANGED (still 4-token shape; the symmetric sell track is F4-specific per S95-8).

- **Buy + sell aggregate panels are INDEPENDENT branches in the renderer.** Both can render simultaneously: e.g., LIVE buy-side table + no-flag-cleared sell-side line in the same brief. The buy-side panel header preserves "cluster-buy rate by GICS sector" (S94-31); the sell-side parallel uses "cluster-sell rate by GICS sector". A `.match(md, /No sectors flagged today/)` against a fixture with `inputsAvailableAggregate > 0` will match on the sell-side branch even if the buy-side is LIVE — narrow the regex to the panel header when this matters (see G2-RENDER-F4-1).

- **The L&L 2001 §4 dilution footer attaches to the sell-side no-flag-cleared branch ONLY** (not LIVE, not cold-start). Future composites adapting this pattern should put interpretive footers where the operator is most likely to mis-weight a weak signal, not as a generic panel header.

- **`inputsAvailableAggregate` is overloaded across BOTH directions (S95-10).** Sector membership in the SP500 PIT panel is direction-agnostic; the same cleared-floor count applies to both directions. The separate baseline panels only affect whether each sector PRODUCES a z; they don't gate floor-clearance.

- **`computeSectorClusterRate` is called TWICE per sector per cycle** (once with BUY_CODE, once with SELL_CODE). Same trade panel; the only added work is the second per-ticker distinct-insider count + the second z-computation. Performance regression risk: ~2x the sector-loop cost. The baseline-panel computation also runs both directions (per-day in the trailing 2y); this is the dominant cost in the populateSectorsForCycle workflow.

- **Symmetric z-test fires on negative-z sell-side anomalies too** (S95-1 carry). A sector with ZERO sell-clusters today against a non-zero baseline produces a |z| that LEGITIMATELY fires `form4SellClusterFlag = true` as "abnormally LOW insider selling". The brief renderer treats this as a flag-equivalent event at the composite layer; the LIVE branch table shows the sign via the `+/-` prefix on `σ`. Downstream weighting must read the sign to distinguish "high selling" from "low selling."

### Carried (s89-s95 #1 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **The composite source files have `\0` literals in template strings.**
  `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts`
  (line 133), `form_4_insider.ts` (line 163).

- **The §1.4 three-branch order is load-bearing: LIVE → no-flag-cleared
  → cold-start.** This applies symmetrically to BOTH directions now.

- **`dayAsOf` uses end-of-day semantic (`day + 'T23:59:59.999Z'`).**

- **Tie-break asymmetry on equal-|z| with opposite signs (carried).**

- `gics_sector_repository_helper.ts` is the byte-template owner for
  per-ticker + per-day-panel + per-ticker-timeline sector lookups.

- `MIN_Z_BASELINE = 30` floor stays at 30 across all three composites
  per ADR-042 §6.

- `stddevSamp` not `stddevPop` — Bessel correction.

- Today's rate must be EXCLUDED from the baseline window per ADR-042 §4.

(All earlier s89-s95 #1 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); aggregate-sector layer LIVE on XD/EK/F4 (buy-side); F4 sell-side LIVE end-to-end (composite + persistence + log + render).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 LIVE; F4 §15 emits BOTH buy-side AND sell-side parallel panels.
```

### Gap #7+#8 v2 GICS activation — buy-side ARC CLOSED; F4 sell-side ARC CLOSED end-to-end

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# G2 max-aggregate-z persistence wiring (READY since s94 #8):
npm run migrate:add-max-z-executive-departure-snapshots         # dry-run
npm run migrate:add-max-z-executive-departure-snapshots:apply   # applies ALTER (+2 columns)
npm run migrate:add-max-z-eight-k-classifier-snapshots          # dry-run
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply    # applies ALTER (+2 columns)
npm run migrate:add-max-z-form-4-insider-snapshots              # dry-run
npm run migrate:add-max-z-form-4-insider-snapshots:apply        # applies ALTER (+2 columns)

# NEW from s95 #2 — F4 sell-cluster persistence (READY to apply):
npm run migrate:add-sell-cluster-form-4-insider-snapshots       # dry-run
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply # applies ALTER (+4 sell-side columns)

# G2 aggregate-panel activation:
# Steps 1-5 DONE end-to-end on XD/EK/F4 buy-side per s94 #6-#11.
# F4 v2 sell-cluster: COMPOSITE + PERSISTENCE + DAEMON LOG + RENDER all LIVE per s95 #1-#2.
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

### Gap #7 8-K classifier (G2 LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (G2 buy-side + v2 sell-side both LIVE end-to-end)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply  # NEW s95 #2 — sell-side persistence
npm run daemon:daily                                              # emits [f4-aggregate] log line with both buy-side AND sell-side tokens
npm run brief:morning                                             # section #15 emits BOTH buy-side AND sell-side parallel panels
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2898 / 2801 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #2 close
npx tsx --test scripts/tests/form4InsiderRepository.test.ts                    # this turn — 141 pass / 0 fail / 6 CH-unreachable skips (G2-SELL-G3-F4-{1..4})
npx tsx --test scripts/tests/operatorBrief.test.ts                             # G2-SELL-G3-F4-5 + composer tests green
npx tsx --test scripts/tests/operatorBriefRender.test.ts                       # G2-SELL-G3-F4-{6..8} + all 17 fixtures updated
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** operator picks the next slice (F4 arc is fully
closed). If operator just says "continue" with no other context, the
recommended default is **Gap #7 v2 per-row recency** (S93-32 + S93-52
co-bootstrap of EK + F4 snapshot DDLs) — that's the next code-only slice
that builds incrementally without opening new methodology questions.

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.

**If operator reprioritizes:** any of these candidates can be the
default-next:

- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**

- Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply` to surface s95 #2 sell-side persistence end-to-end on the real CH.
- Push 37 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation.
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**The F4 v2 sell-cluster arc is FULLY CLOSED.** `Form4InsiderSnapshot`'s
4 sell-side fields are persisted to CH (via the new ALTER), decoded on
load, surfaced in the daemon log line via 2 new tail tokens, threaded
through the brief composer, and rendered as a parallel "Sell-side
cluster" §1.4 three-branch panel adjacent to the buy-side panel in
section #15 of the morning brief.

**EK + XD remain buy-side-only by design.** The symmetric sell-side
track is F4-specific in v1 because Lakonishok-Lee 2001 §4 only argues
for the symmetric posture on raw insider trades. No equivalent canon
argument exists for EK material events or XD executive departures — a
v2 ADR could open that question with a canon citation, but until then
the asymmetry is intentional + documented in the F4 "What could break
this" tail.

**The DDL migration is operator-gated on first apply.** Pre-apply, the
in-memory composite snapshot emits the sell-side fields correctly
end-to-end within a cycle (anomaly-push + same-cycle composer); the
persisted snapshot's sell-side fields drop silently (CH ignores unknown
column names) until the operator runs
`npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
After apply, cross-cycle stale-read consumers (the morning brief reading
yesterday's snapshot) see real sell-side values too.

**The composite source files have `\0` literals (carried watch-out).**
`src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts`
(line 133), `form_4_insider.ts` (line 163).

**Parallel-tracks posture continues.** s95 #2 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Full `npm test` green at 2801
pass (2 pre-existing CH-unreachable fails are NOT regressions; +8 net
vs s95 #1 = exactly the 8 G2-SELL-G3-F4-{1..8} tests).

**The chain through s95 #2:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
        + 6 G2-SELL-F4-* tests
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
        — DDL + persistence + daemon log + brief render
        + 8 G2-SELL-G3-F4-* tests
S95 #2 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator pick — F4 arc fully closed.
                  Recommended if operator says "continue" without
                  context: Gap #7 v2 per-row recency (S93-32 +
                  S93-52 co-bootstrap of EK + F4 snapshot DDLs).
  → background: F4 emits four signals end-to-end now (buy-side
                + sell-side per-ticker cluster flags; buy-side +
                sell-side aggregate cluster flags). Buy-side has
                been LIVE since s94 #11; sell-side composite landed
                s95 #1; sell-side persistence + render landed s95 #2.
                XD + EK arcs remain buy-side-only.
```
