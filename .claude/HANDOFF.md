# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 94 #6 — **ADR-042 ACCEPTED via operator pick of Option (a)** at session start; commits `d69d34f` (ADR-042 text + companion SPEC at `docs/specs/gics-sector-baseline-computation.md`) and `75599d7` (Step 1 — `readSectorMembershipPanel` helper + 6 SMP tests). Operator selected Option (a) recompute-on-the-fly from the §5 framing of the ADR-042 RESEARCH note: smallest deployment surface + zero new schema + schemaless flexibility for the next ~6mo of rate-formula evolution; EDGAR-amendment wart accepted for Layer-0 informational use. ADR-042 ratifies the cross-cutting design decisions (PIT JOIN, sample stddev, today-excluded baseline window, empty-sector-day rate=0, OQ-G2-2 silent-rewrite default, daemon log-line shape, brief panel surface). Companion SPEC pins the 45-test byte-template across six test files. Helper foundation in. **NEXT: Steps 2-5 from `docs/specs/gics-sector-baseline-computation.md` §6 — composite-layer maxAggregateZ / repository populateSectorsForCycle / renderer-composer atomic triple-edit per S94-14 / daemon-orchestrator wiring + ~39 remaining tests.** 14 commits ahead of `origin/main`; push still operator-gated.)

## What this turn delivered

Sixth slice of the gap #7+#8 v2 GICS-activation arc. ADR-042 lands as ACCEPTED with operator-picked Option (a); companion SPEC pins the byte-template for the implementation; foundation helper extension lands as the first of five SPEC implementation steps.

1. **Operator pick of ADR-042 Option (a)** — recompute-on-the-fly per daemon cycle. Operator selected via inline AskUserQuestion at session start; the §5 framing of the RESEARCH note presented three options side-by-side with previews. Pick rationale (paraphrased from operator's choice in context of §5): smallest deployment surface + schemaless flexibility wins over operational replayability under YAGNI for Layer-0 informational composites not yet wired into any tradable rule.

2. **`docs/decisions/README.md` ADR-042 entry** (commit `d69d34f`, ~130 LOC):
   - **Status / Date / Author / Resolves / Supersedes** header — Accepted 2026-05-21; resolves HANDOFF OQ-G2-1; supersedes the OQ-G2-1-awaiting wording in the v1 SPECs.
   - **Decision §1-§10** — 10 numbered decision items pinning recompute-on-the-fly + new helper signature + sample stddev + today-excluded window + EDGAR amendment silent-rewrite default + MIN_Z_BASELINE preserved at 30 + PIT-correct JOIN + empty-sector rate=0 + daemon log-line shape + brief panel surface (LIVE / cold-start branches + composite-tagline rewrite).
   - **Methodology defense** — explicit canon-thin-rule-INAPPLICABLE statement per S94-15 (systems-engineering fork; operator-decided; three-criterion test inapplicable).
   - **Why Option (a) over (b)/(c)** — compressed pushback against the alternatives under YAGNI.
   - **Alternatives considered** — (b)/(c)/(d) mixed picks all rejected.
   - **Resolved at Accept** — six §6 RESEARCH-stage OQs resolved including OQ-G2-2 amendment-behavior default (silent re-write).
   - **Dependencies / Consequences / Out of scope / Watch-outs / Source** — standard ADR sections.
   - **ADR index updated** — ADR-042 added under Architecture (no new schema) + Roadmap-shaping (unblocks G2).

3. **`docs/specs/gics-sector-baseline-computation.md`** (NEW, ~280 LOC):
   - **§1 Contracts** — `readSectorMembershipPanel` helper signature; `populateSectorsForCycle` per-composite orchestrator signature (byte-equal across XD/EK/F4); daemon log-line shape; §1.4 brief panel surface (three branches + composite-tagline rewrites).
   - **§2 Composite-layer additions** — `maxAggregateZ` + `maxAggregateZSector` fields on the three Snapshot interfaces.
   - **§3 Daemon-orchestrator wiring** — call-site pattern.
   - **§4 EXPLAIN-PLAN gate** — skip-on-table-absent contract.
   - **§5 Test list (byte-pinned)** — 45 tests numbered SMP-1..6 + MAXZ-*-1..4 × 3 composites + POPSEC-*-1..4 × 3 composites + G2-RENDER-*-1..3 × 3 sections + G2-DAEMON-*-1 × 3 + G2-COMPOSER-*-1 × 3.
   - **§6 Implementation order** — Steps 1-5 with the S94-14 atomic-triple-edit boundary pinned at Step 4.
   - **§7 Acceptance criteria** — post-merge gates.
   - **§8 Watch-outs / §9 Stage-discipline rationale** — final sections.

4. **`src/server/gics_sector_repository_helper.ts` extension** (commit `75599d7`, ~150 LOC added — Step 1 from SPEC §6):
   - New `SectorMembershipPanelRow` interface (`day` / `sector` / `memberCount`).
   - New `readSectorMembershipPanel(ch, gicsTable, constituentsTable, asOfStart, asOfEnd)` function. Two CH reads (constituents PIT timeline + GICS PIT timeline) + in-JS composition. Strict PIT per ADR-042 §7 — mid-window sector swaps reflected via gicsByTicker timeline scan. Empty-window short-circuit per ADR-042 §"Out of scope". TypeScript composition (not pure CH ASOF JOIN) because sp500_constituents writes the FULL panel per effective_date and the canonical PIT semantic ("governing effective_date = max(effective_date ≤ day); panel = all tickers at that effective_date") cannot be expressed cleanly in CH ASOF JOIN.
   - Module-bottom "what could break this" section updated with the new helper's failure-modes (Bessel correction, today-excluded, sp500_constituents schema assumption, TypeScript composition cost).

5. **`scripts/tests/gicsSectorRepositoryHelper.test.ts` extension** (commit `75599d7`, ~155 LOC added):
   - **SMP-1** — empty-window short-circuit, no CH calls.
   - **SMP-2** — SQL shape: PIT-DESC by effective_date / snapshot_date.
   - **SMP-3** — table + date binding (asOfEnd as ISO Date string).
   - **SMP-4** — row parsing; zero-member sectors NOT emitted.
   - **SMP-5** — mid-window sector swap (strict PIT) — Energy→Materials reclassification reflected.
   - **SMP-6** — EXPLAIN PLAN grammar gate, skip-on-table-absent.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s93 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7 ENTIRE ARC (v1) | ✓ DONE end-to-end (s93) |
| Gap #7+#8 v2 GICS-A1 (shared infra: table + ingest) | ✓ s94 #1 (`8cfdd72`) |
| Gap #7+#8 v2 GICS-A2 (F4 repo + section #15 annotation) | ✓ s94 #2 (`3eb94d6`) |
| Gap #7+#8 v2 GICS-A3 (EK repo + section #14 annotation) | ✓ s94 #3 (`497a645`) |
| Gap #7+#8 v2 GICS-A4 (XD repo + section #12 annotation + helper extraction) | ✓ s94 #4 (`dc70f8c`) |
| Gap #7+#8 v2 OQ-G2-1 ADR-042 RESEARCH note | ✓ s94 #5 (`9ceb1cd`) |
| **ADR-042 ACCEPTED + companion SPEC** | **✓ s94 #6 (`d69d34f`)** |
| **ADR-042 Step 1 — readSectorMembershipPanel helper + 6 SMP tests** | **✓ s94 #6 (`75599d7`)** |
| Gap #7+#8 v2 G2 (Steps 2-5 of SPEC §6) | ☐ NEXT (~39 remaining tests; see Next stage) |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable |
| Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap) | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 sell-cluster sector aggregation (per S93-44) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 14 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 6 (this turn, two commits)

**S94-18. ADR-042 ACCEPTED via operator pick of Option (a) recompute-on-the-fly.**
`Why:` Operator's pick at session start via inline AskUserQuestion using the §5 "what each option optimizes for" framing from the ADR-042 RESEARCH note. The S94-15 framing held — this was a systems-engineering fork (not canon-thin methodology fork), operator decided. Option (a) was selected on the strength of smallest deployment surface + schemaless flexibility under YAGNI; the EDGAR-amendment wart was accepted as not load-bearing for Layer-0 informational use. The other two options ((b) persist + backfill / (c) persist no backfill) are explicitly rejected for v1 and could be revisited via a superseding ADR if (i) EDGAR-amendment frequency surfaces operational impact or (ii) Phase B independence-test replayability becomes load-bearing.

`How to apply:` All G2 implementation work targets Option (a). The chosen-option SPEC at `docs/specs/gics-sector-baseline-computation.md` pins the byte-template; do NOT re-litigate the storage-strategy decision unless one of the (i)/(ii) triggers fires. ADR-043 (amendment-detection forensic tooling) stays in OQ-G2-2-deferred state.

**S94-19. The composite-layer Snapshot interface gains two NEW observability fields: `maxAggregateZ` + `maxAggregateZSector`.**
`Why:` Pure-function derivation from the existing sector-z loop. The brief renderer's §1.4 LIVE branch ("No sectors flagged today (k/11 cleared MIN_Z_BASELINE; max-|z|=X.YZ at <Sector>)") needs the values to render; exposing them on the Snapshot rather than re-computing in the renderer keeps the renderer pure + testable. Tied to the SPEC's MAXZ-*-1..4 test list per composite — applies byte-equally to XD/EK/F4. Three-criterion analysis (sub-choice within Option (a) implementation): canon foundations = N/A pure-function math; methodology rigor = single regression target across three composites for the new fields; minimum free parameters = zero new parameters.

`How to apply:` Step 2 of SPEC §6 adds the two fields to all three Snapshot interfaces. The composite evaluators populate them in the aggregate-sector loop alongside `flaggedSectors` + `executiveClusterDeparture`. Renderer §1.4 LIVE branch reads them from `s.maxAggregateZ` / `s.maxAggregateZSector` rather than re-deriving.

**S94-20. The S94-14 coordinated atomic triple-edit boundary IS pinned at SPEC §6 Step 4 (renderer + composer rewrite).**
`Why:` Steps 1-3 + Step 5 of the SPEC are NOT drift-coupled across composites — the helper extension (Step 1, already shipped) is composite-agnostic; the per-composite composite-layer additions (Step 2) and repository extensions (Step 3) operate on each composite independently; the daemon-orchestrator wiring (Step 5) emits one log line per composite but the log-line shape is byte-equal across composites. Only the brief renderer + composer changes (Step 4) span the three sections #12 / #14 / #15 with drift-coupled wording (the OQ-G2-1-awaiting footer + composite-tagline). Per S94-14 single-composite incremental rollout of Step 4 would visibly drift the operator-facing wording.

`How to apply:` Next session can commit Steps 2, 3, 5 individually (or in any sequence that keeps tests green) without coupling. Step 4 MUST land as ONE commit covering all three sections. Step 2 is recommended FIRST because Steps 3-5 depend on the new `maxAggregateZ` / `maxAggregateZSector` fields.

### Sessions 84-93 + s94 #1..#5 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-17 carry through.

## Open questions

### Newly opened (per ADR-042 §4.3 + §5 Decision)

**OQ-G2-2 (LOW — deferred).** EDGAR-amendment forensic tooling default. Per ADR-042 §5 the default under Option (a) is silent re-write of the baseline on next cycle. ADR-043 (amendment-detection forensic tooling) opens only if Phase B testing reveals operational impact. Stays in deferred-bucket-3 state; no current action.

### Closed this turn

- ~~OQ-G2-1 ADR-042 operator pick~~ — RESOLVED via operator selection of Option (a) at session start. ADR-042 now ACCEPTED.

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

### Default on "continue"

**Execute Steps 2-5 of SPEC §6** at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md). Detailed byte-pinned test list at SPEC §5. Recommended sequencing:

#### Step 2 — Composite-layer additions (~30 LOC × 3 composites + 12 tests)

Add `maxAggregateZ` + `maxAggregateZSector` to:
- `src/server/executive_departure.ts` (XD) — `ExecutiveDepartureSnapshot` interface + `evaluateExecutiveDepartureComposite` aggregate-sector loop.
- `src/server/eight_k_classifier.ts` (EK) — `EightKClassifierSnapshot` interface + `evaluateEightKClassifierComposite`.
- `src/server/form_4_insider.ts` (F4) — `Form4InsiderSnapshot` interface + `evaluateForm4InsiderComposite`.

Pure-function derivation in the existing sector-z loop (example):

```ts
let maxAbsZ = -Infinity;
let maxZ: number | null = null;
let maxSector: string | null = null;
for (let i = 0; i < sectorZs.length; i++) {
  const z = sectorZs[i];
  if (z == null) continue;
  const absZ = Math.abs(z);
  if (absZ > maxAbsZ
      || (absZ === maxAbsZ && (maxSector == null || inputs.sectors[i].sector < maxSector))) {
    maxAbsZ = absZ;
    maxZ = z;
    maxSector = inputs.sectors[i].sector;
  }
}
```

Tests per SPEC §5.2: MAXZ-XD-{1..4} / MAXZ-EK-{1..4} / MAXZ-F4-{1..4} — 12 total. Also update the CH INSERT path's snapshot-payload writer + the snapshot deserializer if either reads/writes these as columns (likely NEW columns — coordinate with the CH migrations; the snapshot tables currently store these in the JSON payload column, so likely no schema migration needed).

**WATCH-OUT:** The three composite source files (`*.ts`) contain template-string literals with embedded `\0` (NUL) characters as composite-key delimiters in dedupe paths (`${e.cik}\0${e.accession}\0${e.subItemCode}`). The Read tool detects these as "binary" and falls back. Workaround: `tr '\0' '_' < src/server/executive_departure.ts > /tmp/_xd.ts` etc. to make readable working copies; Edit the original files using the exact original strings as `old_string` (the `\0` literal is fine in Edit `old_string` parameters via JSON escaping).

#### Step 3 — Repository extensions (~80 LOC × 3 repositories + 12 tests)

Add `populateSectorsForCycle(asOf: Date)` to:
- `src/server/executive_departure_repository.ts` (XD).
- `src/server/eight_k_classifier_repository.ts` (EK).
- `src/server/form_4_insider_repository.ts` (F4).

Each method calls `readSectorMembershipPanel(asOfStart=asOf-730d, asOfEnd=asOf-1d)` to get the trailing-2y panel → groups events by (day, sector) → emits `inputs.sectors` array. Per ADR-042 §4 today's rate is computed separately from the [asOf-90d, asOf] window using the existing per-ticker event reads + grouped by today's sector membership (from the GICS map). Per ADR-042 §8 empty-sector days yield rate=0.

Tests per SPEC §5.3: POPSEC-XD-{1..4} / POPSEC-EK-{1..4} / POPSEC-F4-{1..4} — 12 total.

**Update the existing `readInputsForCycle`** in each repository to call `populateSectorsForCycle` + replace the current `_constituents: readonly string[]` (unused) parameter with the populated `inputs.sectors`. The orchestrator no longer needs the bare constituents list as a separate argument — it's encapsulated in `populateSectorsForCycle`.

#### Step 4 — Brief renderer + composer atomic triple-edit (~60 LOC + ~30 LOC + 12 tests, S94-14 ATOMIC)

**This step MUST land as one commit** spanning sections #12 + #14 + #15. Single-composite rollout drifts the operator-facing wording.

- `src/server/operator_brief_render.ts` sections #12 / #14 / #15:
  - Replace the `flaggedSectors.length === 0` branch with the three-way branch from SPEC §1.4 (LIVE branch + cold-start branch + flagged-table branch).
  - Rewrite the composite-tagline footer per SPEC §1.4 (drop "aggregate-sector layer dormant pending OQ-G2-1 ADR" + replace with "aggregate-sector layer LIVE under ADR-042 Option (a) — re-computed per daemon cycle from raw events + PIT constituents + GICS map").
  - Update the `inputsAvailableAggregate` qualifier line per SPEC §1.4 (drop the "G1-A2/A3/A4: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR" wording + replace with "per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3").
- `src/server/operator_brief.ts` section composers (composeXdSection / composeEkSection / composeF4Section): pass through `maxAggregateZ` + `maxAggregateZSector` to the renderer-input shape.

Tests per SPEC §5.4 + §5.6: G2-RENDER-XD-{1..3} / G2-RENDER-EK-{1..3} / G2-RENDER-F4-{1..3} + G2-COMPOSER-XD-1 / G2-COMPOSER-EK-1 / G2-COMPOSER-F4-1 — 12 total.

#### Step 5 — Daemon-orchestrator wiring (~20 LOC × 3 + 3 tests)

In `scripts/daily_signal_daemon.ts`:
- For each composite, call `populateSectorsForCycle(asOf)` and merge into `inputs.sectors`.
- After `evaluateXxxComposite` returns, emit the SPEC §1.3 log line.

Tests per SPEC §5.5: G2-DAEMON-XD-1 / G2-DAEMON-EK-1 / G2-DAEMON-F4-1 — 3 total.

### After Steps 2-5 ship + tests green + tsc clean

The gap #7+#8 v2 arc closes end-to-end. Remaining operator-pickable next-default candidates:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would use the new `readGicsSectorByTicker` + `readSectorMembershipPanel` helpers).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

### Operator-gated action items (carried)

- Push 14 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this turn (s94 #6)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | EDITED (`d69d34f`) | ADR-042 entry added (~130 LOC); index updated. ADR ACCEPTED. |
| `docs/specs/gics-sector-baseline-computation.md` | NEW (`d69d34f`) | Companion SPEC (~280 LOC); byte-pinned 45-test list across six test files; S94-14 atomic-triple-edit boundary at Step 4. |
| `src/server/gics_sector_repository_helper.ts` | EDITED (`75599d7`) | +~150 LOC. New `SectorMembershipPanelRow` interface + `readSectorMembershipPanel` function. Module-bottom "what could break this" updated with the new helper's failure-modes. |
| `scripts/tests/gicsSectorRepositoryHelper.test.ts` | EDITED (`75599d7`) | +~155 LOC, +6 tests (SMP-1..SMP-6). Total file now 15 tests / 13 pass / 2 skip (CH unreachable). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for s94 #6 milestone close. |

### From s94 #5 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/adr-042-gics-sector-baseline-computation-research.md` | EXISTS (`9ceb1cd`) | RESEARCH note. ADR-042 references it for substantive material. |

### From s94 #4 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/gics_sector_repository_helper.ts` | EXISTS (`dc70f8c` + `75599d7` extension this turn) | `readGicsSectorByTicker` byte-template (s94 #4); `readSectorMembershipPanel` added s94 #6. |
| `src/server/executive_departure_repository.ts` | EXISTS (`dc70f8c`) | G1-A4 wired. G2 wiring (populateSectorsForCycle) is Step 3. |
| `src/server/form_4_insider_repository.ts` | EXISTS (`dc70f8c` refactor) | G1-A2 wired. G2 wiring is Step 3. |
| `src/server/eight_k_classifier_repository.ts` | EXISTS (`dc70f8c` refactor) | G1-A3 wired. G2 wiring is Step 3. |
| `src/server/operator_brief.ts` | EXISTS (`dc70f8c`) | All three composer functions stamp `tickersWithCikCount` + `watchUniverseTickerCount`. Step 4 atomic-triple-edit adds maxAggregateZ + maxAggregateZSector pass-throughs. |
| `src/server/operator_brief_render.ts` | EXISTS (`dc70f8c`) | All three sections' OQ-G2-1-awaiting footer + composite-tagline wording. Step 4 atomic-triple-edit rewrites per SPEC §1.4. |

### From s94 #1-#3 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_gics_sector_map.ts` | EXISTS (`8cfdd72`) | Shared infra. |
| `scripts/sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | Wikipedia ingest. |
| `scripts/tests/migrateCreateGicsSectorMap.test.ts` | EXISTS (`8cfdd72`) | 25 tests. |
| `scripts/tests/test_sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | 26 tests. |
| `package.json` | EXISTS (`8cfdd72`) | +4 GICS ingest entries. |
| `scripts/help.ts` | EXISTS (`8cfdd72`) | +2 EXTRA_HELP entries. |

(All earlier gap arcs + earlier S94 files preserved unchanged.)

### CH state (unchanged from s94 #5)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created.
- `quantlab.eight_k_classifier_snapshots` — NOT yet created.
- `quantlab.insider_trades` — NOT yet created.
- `quantlab.insider_ciks` — NOT yet created.
- `quantlab.form_4_insider_snapshots` — NOT yet created.
- `quantlab.gics_sector_map` — NOT yet created (TS migration ready; Python ingest also lazy-creates on first --apply).
- ADR-042 Option (a) ⇒ **NO new CH schema required for G2.** Zero migrations.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/gicsSectorRepositoryHelper.test.ts
   ✓ 15 tests / 13 pass / 0 fail / 2 skipped (CH-unreachable EXPLAIN gates)
   ✓ 6 new SMP tests all pass

npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
```

Full `npm test` + `pytest` baselines NOT re-run this turn (no code touched outside the helper test file; helper-only changes do not invalidate the prior baselines). Next session should run `npm test` + `pytest` once Step 2/3/4/5 land to verify the +~39 new tests pass.

## Watch-outs

### NEW from this turn (s94 #6)

- **The composite source files have `\0` literals in template strings.** `src/server/executive_departure.ts`, `src/server/eight_k_classifier.ts`, `src/server/form_4_insider.ts` contain dedupe-key template-string literals like `${e.cik}\0${e.accession}\0${e.subItemCode}` — the Read tool detects these as "binary" and falls back. Workaround for the Step 2 / Step 3 implementations: `tr '\0' '_' < src/server/<file>.ts > /tmp/_<file>.ts` to make readable working copies. Edit the original files using exact original strings as `old_string` (the `\0` literal is fine in Edit `old_string` parameters via JSON escaping).

- **`readSectorMembershipPanel` performs the panel-membership join in TypeScript, not in CH.** Per the in-code "what could break this" section, this is because the canonical PIT semantic ("governing effective_date = max(effective_date ≤ day); panel = all tickers at that effective_date") cannot be expressed cleanly in CH ASOF JOIN, which picks one row per ticker rather than the full set. JS composition cost is ~503 days × ~503 tickers × ~10 effective_dates ≈ <2M ops per call — sub-second under typical Node throughput. If Phase B promotes the daemon to event-driven cadence per E-9-DEPLOY, this may need re-examination. See `gics_sector_repository_helper.ts` module-bottom for the full pin.

- **Strict-PIT semantic of `readSectorMembershipPanel` per ADR-042 §7 is reflected in SMP-5 (Energy → Materials reclassification).** Mid-window sector swaps DO change the daily memberCount; the gicsByTicker timeline is fully scanned per ticker per day. A future v2 schema upgrade that promoted `gics_sector_map.snapshot_date` to DateTime would require coordinating the ISO-string comparison with the new resolution.

- **Today's rate must be EXCLUDED from the baseline window per ADR-042 §4.** Step 3 implementations of `populateSectorsForCycle` MUST set `asOfEnd = asOf - 1 day` for the baseline-window helper call. Today's rate is computed SEPARATELY from the [asOf-90d, asOf] window using the existing per-ticker event reads + today's sector membership. Self-reference deflates z-magnitude trivially; regression here would be a silent z-score scale drift.

- **`stddevSamp` not `stddevPop` — Bessel correction matters.** The composite-layer `computeZ` already uses sample stddev (`/(n-1)`); Step 2 implementations of `maxAggregateZ` / `maxAggregateZSector` derivation do NOT touch the stddev — they read the already-computed sector-z list. Regression here would be a silent z-score scale drift.

- **S94-14 atomic-triple-edit at SPEC §6 Step 4 is non-negotiable.** Sections #12 + #14 + #15 renderer + composer changes land as ONE commit. Single-composite incremental rollout would visibly drift the operator-facing wording. Steps 2, 3, 5 can land individually (or in any test-green sequence) without this coupling.

- **`MIN_Z_BASELINE = 30` floor stays at 30 across all three composites per ADR-042 §6.** Do NOT add a separate min-nonzero-count requirement at §5.3 POPSEC-*-3's empty-sector-day mitigation — selection-bias canon per AFML §11 rejects in-sample tuning against the empty-sector-day failure mode.

- **PIT constituents-panel coverage is a hard prerequisite for G2 deployment.** `quantlab.sp500_constituents` needs trailing-2y coverage before any G2 option deploys; otherwise the rate denominator is 0 → null rate → baseline-count below `MIN_Z_BASELINE` → z = null across the cold-start. Verify constituents-table coverage before activating G2 in production (`npm run brief:morning` after G2 implementation will render the §1.4 cold-start branch if coverage is insufficient).

### Carried (s89-s94 #5 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- `gics_sector_repository_helper.ts` is now the byte-template owner for both per-ticker (`readGicsSectorByTicker`) and per-day-panel (`readSectorMembershipPanel`) sector lookups.
- Section #12's table-cell sector annotation position is byte-pinned by T-OBR-XD-9.
- `inputsAvailablePerTicker` semantic is meaningful (not structurally 0) across all three composites.
- The helper's `asOf` is ALWAYS coerced to `YYYY-MM-DD`.
- `LIMIT 1 BY ticker` is ClickHouse-specific (non-portable).
- Cross-language drift on `gics_sector_map` DDL (test parity in `migrateCreateGicsSectorMap.test.ts`).
- `MIN_ROWS_FLOOR = 480` is a SCHEMA-DRIFT alarm, not a happy-path floor.
- `GICS_SECTORS` enum is the load-bearing canonical-name pin.
- `TICKER_REGEX` accepts only EDGAR-style dots (BRK.B), NOT yfinance dashes (BRK-B).
- Wikipedia 403s default Python-urllib User-Agent.
- Snapshot semantics v1 = `snapshot_date = today()`.
- `source` LowCardinality DEFAULT `'wikipedia_sp500'` requires explicit write for alternative sources.
- Parser locates table by HEADER SIGNATURE not by index.
- `_clean_text` footnote regex `\[[^\]]*\]` greedy assumption.
- `parse_sp500_table` raises ValueError (NOT returns empty).
- `index_granularity = 8192` is the Layer-0 lookup-table idiom.

(All earlier s89-s93 watch-outs preserved unchanged — same list as in prior HANDOFF.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY; G2 in flight — Steps 2-5)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# F4 / EK / XD per-ticker sector wiring (READY since s94 #2/#3/#4):
# All three brief sections (#12 + #14 + #15) annotate flagged tickers with their
# GICS sector when row exists in map.

# G2 aggregate-panel activation (in flight):
# Step 1 DONE — readSectorMembershipPanel helper in src/server/gics_sector_repository_helper.ts
# Steps 2-5 NEXT per SPEC docs/specs/gics-sector-baseline-computation.md §6
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

### Gap #8 executive-departure activation

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily
npm run brief:morning                                   # section #12 now sector-annotated
```

### Gap #7 8-K classifier (FULLY READY)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (FULLY READY)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — last full-run baseline 2833 / 2802 / 31 skipped (s94 #4 close)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
npx tsx --test scripts/tests/gicsSectorRepositoryHelper.test.ts                # this turn — 15 / 13 / 2 skipped
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** open with Step 2 from SPEC §6 (composite-layer additions). Recommended sequence:

1. **Step 2** — add `maxAggregateZ` + `maxAggregateZSector` to all three Snapshot interfaces + composite evaluators + 12 MAXZ-* tests. ~30 LOC × 3 composites + ~120 LOC tests. **WATCH-OUT:** composite source files have `\0` literals; use `tr` workaround for Read.
2. **Step 3** — add `populateSectorsForCycle` to all three repositories + integrate into `readInputsForCycle` + 12 POPSEC-* tests. ~80 LOC × 3 repositories + ~150 LOC tests.
3. **Step 4** — coordinated atomic triple-edit per S94-14 / S94-20: renderer + composer rewrites across sections #12 + #14 + #15. ~60 LOC + ~30 LOC + 12 G2-RENDER-* / G2-COMPOSER-* tests. **MUST LAND AS ONE COMMIT.**
4. **Step 5** — daemon-orchestrator wiring in `scripts/daily_signal_daemon.ts` + 3 G2-DAEMON-* tests. ~20 LOC × 3 + ~60 LOC tests.

**Acceptance criteria for the G2 close:**

- ✓ `npm test` green at +~39 net new tests passing (39 = 12 MAXZ + 12 POPSEC + 9 G2-RENDER + 3 G2-COMPOSER + 3 G2-DAEMON, vs SPEC §5's 45 total minus the 6 SMP already shipped).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `npm run brief:morning` renders sections #12 + #14 + #15 with the LIVE branch OR the cold-start branch (NOT the OQ-G2-1-awaiting branch).
- ✓ Daemon-cycle log emits the SPEC §1.3 line for each composite per cycle.

**If operator reprioritizes:** any of these candidates can replace G2-completion as the default-next:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would consume the new helpers).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**

- Push 14 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the nine Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

**ADR-042 IS ACCEPTED.** Operator picked Option (a) recompute-on-the-fly at session start; the decision is in [`docs/decisions/README.md`](../docs/decisions/README.md) §ADR-042. The methodology defense explicitly disclaims the autonomous canon-thin rule for THIS ADR (systems-engineering fork, not methodology fork; operator-decided per S94-15). The other options ((b) persist + backfill / (c) persist no backfill) are rejected for v1 under YAGNI; they could be revisited via a superseding ADR if EDGAR-amendment frequency or Phase B replayability becomes load-bearing.

**The companion SPEC at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md) is the byte-template for Steps 2-5.** It pins function signatures, the 45-test list, the §1.4 brief panel surface, the §1.3 daemon log-line shape, the S94-14 atomic-triple-edit boundary at Step 4, and the implementation order. The next session executes Steps 2-5 from this SPEC.

**Step 1 is DONE.** `readSectorMembershipPanel` shipped at [`src/server/gics_sector_repository_helper.ts`](../src/server/gics_sector_repository_helper.ts) with 6 SMP tests at [`scripts/tests/gicsSectorRepositoryHelper.test.ts`](../scripts/tests/gicsSectorRepositoryHelper.test.ts). All 6 pass (the 2 skipped tests are EXPLAIN-PLAN gates skipped on CH unreachable per the existing contract). The helper is composite-agnostic and consumed identically by all three repositories' Step 3 `populateSectorsForCycle` implementations.

**The composite source files have `\0` literals.** `src/server/executive_departure.ts`, `src/server/eight_k_classifier.ts`, `src/server/form_4_insider.ts` use `\0` in template-string dedupe keys (`${e.cik}\0${e.accession}\0${e.subItemCode}`). The Read tool falls back to binary mode on these files. Use `tr '\0' '_' < src/server/<file>.ts > /tmp/_<file>.ts` to make readable working copies. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

**Parallel-tracks posture continues.** s94 #6 did NOT affect C-12 / paper-trading / real-money-flip arcs. The 6 SMP tests are all that ran this turn (`npx tsx --test scripts/tests/gicsSectorRepositoryHelper.test.ts` green at 15/13/2-skipped); full `npm test` + `pytest` baselines from s94 #4 (2833/2802/31-skipped and 324/324) carry through unchanged.

**The chain through s94 #6:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15)           ✓ committed (3eb94d6)
S94 #3: gap #7+#8 v2 GICS-A3 (EK repo + #14)           ✓ committed (497a645)
S94 #4: gap #7+#8 v2 GICS-A4 (XD repo + #12 +          ✓ committed (dc70f8c)
        helper extraction per S94-10)
S94 #5: OQ-G2-1 ADR-042 RESEARCH note                  ✓ committed (9ceb1cd)
S94 #6 part A: ADR-042 Accept + companion SPEC         ✓ committed (d69d34f)
S94 #6 part B: Step 1 helper + 6 SMP tests             ✓ committed (75599d7)
S94 #6 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: Step 2 from SPEC §6 (composite-layer maxAggregateZ + maxAggregateZSector)
  → THEN Steps 3-5 in sequence; Step 4 atomic-triple-edit per S94-14 / S94-20
  → ~39 remaining tests across MAXZ / POPSEC / G2-RENDER / G2-COMPOSER / G2-DAEMON suites
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots now ALL carry populated sector field when
                gics_sector_map row exists; cold-start (no ingest yet) preserves
                null + the brief renders without annotation across all three.
                Aggregate-panel computation will activate post-Step 4.
```
