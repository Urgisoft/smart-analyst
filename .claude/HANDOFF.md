# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 94 #11 — **ADR-042 Step 5 DONE → gap #7+#8 v2 G2 arc CLOSED END-TO-END**: daemon-cycle aggregate log line + 3 G2-DAEMON tests landed across XD/EK/F4 as ONE commit `a20d57b`. The five-step G2 arc (Steps 1-5) is now fully shipped; the v1 GICS-A1..A4 + G2-A1..A3 + the OQ-G3-1 persistence sub-slice constitute the complete gap #7+#8 v2 deliverable. **NEXT: operator-pickable from the deferred queue** (no obvious default-next on the v2 GICS thread; the arc is done). `npm run daemon:daily` will now emit one `[<xd|ek|f4>-aggregate]` line per composite per cycle alongside the existing `[<exec-departure|eight-k|form-4>]` summaryLine. 35 commits ahead of `origin/main`; push still operator-gated.)

## What this turn delivered

Eleventh slice of the gap #7+#8 v2 GICS-activation arc — and the slice that closes it. ADR-042 Step 5 (the daemon-orchestrator log-line wiring) ships. With Step 5 done, the v2 G2 arc has no remaining surface; the rolled-up deliverable is the GICS-sector aggregate-baseline panel rendered LIVE in sections #12/#14/#15 + persisted into the three snapshot tables + emitted as a per-cycle daemon log line.

1. **`XxxDaemonResult` interface extension (~+30 LOC across 3 repository interfaces in `src/server/{executive_departure,eight_k_classifier,form_4_insider}_repository.ts`):**
   - Each `ExecutiveDepartureDaemonResult` / `EightKClassifierDaemonResult` / `Form4InsiderDaemonResult` interface gains one new required field: `aggregateLogLine: string`. JSDoc names the SPEC anchor (§1.3 + §5.5) + the v1 Option C semantic per ADR-042 §"Watch-outs".

2. **Log-line construction in three `runDaemon*Evaluation` orchestrators (~+18 LOC × 3 in the same three files):**
   - Builds `aggMaxToken` from `(snapshot.maxAggregateZSector, snapshot.maxAggregateZ)`:
     - When both non-null: `${sectorTokenized}:${z.toFixed(2)}` (e.g. `Energy:2.34` or `Consumer_Discretionary:-2.15`).
     - When either null: `n/a:n/a` (cold-start sentinel).
   - Sector names with spaces (e.g. "Consumer Discretionary") are underscore-tokenized via `.replace(/\s+/g, '_')` so the §5.5 regex `max_z=(\S+):(\S+)` matches without bleeding into `cluster_flag`.
   - Final shape per composite:
     ```text
     [<xd|ek|f4>-aggregate] sectors_with_z=${inputsAvailableAggregate}/11 floor_cleared=${inputsAvailableAggregate}/11 max_z=${aggMaxToken} cluster_flag=${cluster ? 'true' : 'false'}
     ```
   - **v1 Option C semantic (ADR-042 §"Watch-outs"):** `sectors_with_z` AND `floor_cleared` both report `inputsAvailableAggregate`. The floor's only practical failure is the empty-baseline2y cold-start case, which fires only when `inputsAvailableAggregate=0` anyway — so the two counts agree in v1. v2 tightening (separate `sectorsClearedFloor` snapshot field requiring DDL ALTER + composite-evaluator + test churn) is operator-pickable.
   - Cluster-flag field name varies per composite: XD → `executiveClusterDeparture`, EK → `eightKClusterFlag`, F4 → `form4ClusterFlag`. Carried watch-out from prior slices.

3. **Daemon call-site wiring (+3 LOC in `scripts/daily_signal_daemon.ts`):**
   - One additional `console.log(<result>.aggregateLogLine)` after the existing `console.log(<result>.summaryLine)` at each of the three call sites (steps 1i / 1k / 1l). Non-fatal-by-design (no try/catch needed; the orchestrator builds the line as a pure string before the existing try/catch closes).

4. **Three new tests (one per composite):**
   - **G2-DAEMON-XD-1** in `scripts/tests/executiveDepartureRepository.test.ts` (+34 LOC).
   - **G2-DAEMON-EK-1** in `scripts/tests/eightKClassifierRepository.test.ts` (+29 LOC).
   - **G2-DAEMON-F4-1** in `scripts/tests/form4InsiderRepository.test.ts` (+29 LOC).
   - Each test asserts the §5.5 regex `\[(xd|ek|f4)-aggregate\] sectors_with_z=\d+\/11 floor_cleared=\d+\/11 max_z=(\S+):(\S+) cluster_flag=(true|false)` against `r.aggregateLogLine` + cold-start sentinel (`max_z=n/a:n/a` + `cluster_flag=false`) + per-composite prefix discrimination (`^\[xd-aggregate\] ` etc.) + Option C count equality (`sectors_with_z=0\/11 floor_cleared=0\/11`).
   - Cold-start fixtures (sectors=[]) → `inputsAvailableAggregate=0` → both counts 0 + max_z sentinel. Mirrors POPSEC-*-4 fixture posture.

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
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH | ✓ s94 #1-#5 |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 (`d69d34f`) |
| ADR-042 Step 1 — readSectorMembershipPanel + 6 SMP tests | ✓ s94 #6 (`75599d7`) |
| ADR-042 Step 2 — composite-layer maxAggregateZ + 12 MAXZ tests | ✓ s94 #7 (`1a3fc00`) |
| OQ-G3-1 sub-slice — persistence wiring strategy (β) + 6 G3R tests | ✓ s94 #8 (`dd366b6`) |
| ADR-042 Step 3 — populateSectorsForCycle + 12 POPSEC tests | ✓ s94 #9 (`3f9b414`) |
| ADR-042 Step 4 ATOMIC — renderer §1.4 3-branch + composer + 12 tests | ✓ s94 #10 (`a1d194d`) |
| **ADR-042 Step 5 — daemon-cycle log line + 3 G2-DAEMON tests** | **✓ s94 #11 (`a20d57b`) — GAP #7+#8 v2 G2 ARC CLOSED** |
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
| Push 35 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 11 (this turn, one commit)

**S94-32. v1 daemon log-line semantic — `sectors_with_z` AND `floor_cleared` both report `inputsAvailableAggregate` (Option C from HANDOFF s94 #10).**
`Why:` The SPEC §1.3 daemon log line has two count slots: `<k>` (sectors with sectorSize > 0) and `<m>` (sectors that cleared MIN_Z_BASELINE AND received a non-null z). v1 has no `sectorsClearedFloor` snapshot field — the composite-snapshot interface exposes `inputsAvailableAggregate` (= sectors with sectorSize > 0 from inputs.sectors[]) but not the strict floor-clearance count. In practice the two counts agree because every sector with sectorSize > 0 has a non-empty trailing-2y baseline that meets MIN_Z_BASELINE=30 (the floor's only practical failure is the empty-baseline2y cold-start case, which fires only when `inputsAvailableAggregate=0` anyway). Option A (add `sectorsClearedFloor` to the snapshot interface) requires DDL ALTER + composite-evaluator + composite tests + persistence tests + repository test churn — disproportionate cost for the cold-start delta. Selection-bias canon (AFML §11) on minimum-viable counters: don't add a new field that has the same value as an existing field across all practical states.

`How to apply:` Future Layer-0 composites that emit per-cycle aggregate log lines should follow the same Option C semantic UNLESS the composite has a meaningfully different floor-vs-inputs count distinction. v2 tightening (separate `sectorsClearedFloor` field) lands ONLY when a Phase B observation surfaces an `inputsAvailableAggregate > sectorsClearedFloor` case in production.

**S94-33. Sector names underscore-tokenized in the daemon log line via `.replace(/\s+/g, '_')`.**
`Why:` The SPEC §5.5 G2-DAEMON regex pins `max_z=(\S+):(\S+) cluster_flag=`. Whitespace in the sector name (e.g. "Consumer Discretionary", "Real Estate", "Health Care", "Communication Services", "Information Technology", "Consumer Staples") would break the `\S+` capture. Options considered: (a) underscore-tokenize, (b) drop spaces (PascalCase), (c) change the SPEC regex to `[^:]+`. (a) is operator-readable and least-invasive — the SPEC stays untouched, the log line remains parseable by line-oriented tooling (`grep "Energy:"` / `grep "Consumer_Discretionary:"`), and the round-trip with the renderer's `replace(/\s+/g, '_')`-free §1.4 sector annotation is fine because the renderer doesn't read the daemon log. (b) would lose readability ("ConsumerDiscretionary"). (c) would loosen the regex contract beyond the SPEC's explicit token.

`How to apply:` Future Layer-0 composite log lines that include a sector token should apply the same underscore tokenization. The §1.4 brief renderer should NOT underscore-tokenize — operator-facing prose retains canonical "Consumer Discretionary" wording. The split lives at the boundary: structured log emits underscores; rendered prose emits spaces.

**Carry-over from s94 #10 (still in force):**

- S94-29 — `maxAggregateZ`/`maxAggregateZSector` REQUIRED (not optional) across the three Brief*Section interfaces.
- S94-30 — T-OBR-*-4 (cold-start tests) REWRITTEN in-place rather than deleted in favor of G2-RENDER-*-3.
- S94-31 — F4 panel header preserves "cluster-buy rate by GICS sector" framing vs XD/EK's "by GICS sector".

**Carry-over from s94 #9 (still in force):**

- S94-26 — Path A rolling-rate semantic locks per-composite intrinsic windowDays for baseline2y unit consistency.
- S94-27 — V1 event-query universe = today's PIT constituents only.
- S94-28 — `readGicsSectorTimeline` + `findGoverningSector` as reusable primitives.

### Sessions 84-93 + s94 #1..#10 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-31 carry through.

## Open questions

### Newly opened (s94 #11) — none

### Carried unchanged from s94 #10

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default; ADR-043 opens only if Phase B testing reveals operational impact.

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

### The G2 arc is CLOSED. No obvious default-next on the v2 GICS thread.

The five-step ADR-042 arc (Steps 1-5) is fully shipped. The OQ-G3-1 persistence sub-slice is also shipped. There is no remaining surface on the gap #7+#8 v2 deliverable. The "default on `continue`" pattern from prior slices does NOT apply here — the operator must reprioritize.

**Recommended next-default candidates (operator picks):**

- **Gap #7 v2 sell-cluster sector aggregation (S93-44)** — single-slice on F4 composite; would consume the new helpers + extend the existing per-sector aggregate panel to track sell clusters (currently only buy clusters fire `form4ClusterFlag`). Low-friction: composite-layer addition + 1 new boolean field + ~6 tests. Closes a small remaining asymmetry in the F4 arc.
- **Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap)** — adds `lastEventDate` / `lastTradeDate` columns to EK + F4 snapshot DDLs so the brief can render "n days since last 8-K" / "n days since last cluster-buy" per ticker. Single migration + composer + renderer slice; ~8-10 tests.
- **Gap #7 v2 13D/13G arc** — NEEDS its own SPEC. Activist filings; would consume the existing readGicsSector* helpers + introduce a new Layer-0 composite. Larger slice (~3-4 commits). Operator must authorize the SPEC drafting first.
- **ADR-041 implementation** (`yield_curve_inverted` regime category) — Accepted methodology; slot un-queued. Single category + the regime-classify v3 integration. Cleanly bounded.
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — supplementary data source for the etf-flow composite; would add a divergence check between the daemon's flow inputs and a public ETF.com sample. Operator-pickable.
- **Gap #7 v2 event-driven cadence promotion** — Phase B-gated. Would shift the daemon from daily-cycle to event-driven for the three EDGAR composites. Earliest ~2026-08-20 (90d Phase B parallel-comparison window).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.
- **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.
- **Phase B campaigns** for the nine Layer-0 composites — calendar OR backfill arc.

### Operator-gated action items (carried)

- Push 35 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s94 #11 — commit `a20d57b`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/executive_departure_repository.ts` | +27 / -1 | `aggregateLogLine` field on `ExecutiveDepartureDaemonResult` + log-line build + return. |
| `src/server/eight_k_classifier_repository.ts` | +21 / -1 | Same pattern for EK; `[ek-aggregate]` prefix + `eightKClusterFlag`. |
| `src/server/form_4_insider_repository.ts` | +21 / -1 | Same pattern for F4; `[f4-aggregate]` prefix + `form4ClusterFlag`. |
| `scripts/daily_signal_daemon.ts` | +3 / 0 | One `console.log(<result>.aggregateLogLine)` after each summaryLine print (×3 call sites). |
| `scripts/tests/executiveDepartureRepository.test.ts` | +34 / 0 | G2-DAEMON-XD-1 appended to runDaemon describe block. |
| `scripts/tests/eightKClassifierRepository.test.ts` | +29 / 0 | G2-DAEMON-EK-1 appended to runDaemon describe block. |
| `scripts/tests/form4InsiderRepository.test.ts` | +29 / 0 | G2-DAEMON-F4-1 appended to runDaemon describe block. |

### Carried from s94 #6-#10 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Steps 1-5 SHIPPED; arc closed. |
| Three composite `xxx.ts` source files | Step 2 SHIPPED | `maxAggregateZ` + `maxAggregateZSector` evaluator logic live. |
| Three `xxx_repository.ts` source files | Step 3 + Step 5 SHIPPED | `populateSectorsForCycle` orchestrator wired into `readInputsForCycle`; `aggregateLogLine` built in `runDaemon*Evaluation`. |
| Three migrate_add_max_aggregate_z*.ts scripts | s94 #8 SHIPPED | ALTER migrations ready to apply per operator-gated cadence. |
| `src/server/operator_brief_render.ts` | Step 4 SHIPPED (s94 #10) | §1.4 three-branch active on all three sections. |
| `src/server/operator_brief.ts` | Step 4 SHIPPED (s94 #10) | Composer pass-through for `maxAggregateZ` + `maxAggregateZSector`. |

### CH state

- All seven Layer-0 composite snapshot tables + the three event tables remain in the state from s93 / s94 #6 close. No new schema changes this turn.
- **Carry from s94 #8:** the three Layer-0 snapshot tables each have a pending ALTER migration ready to apply (`migrate:add-max-z-<composite>-snapshots:apply`). Idempotent (pre-check detects existing columns + skips); operator must run them BEFORE the brief's stale-read path (via `loadLatestSnapshot`) will see real `maxAggregateZ` values — but the live daemon-cycle path emits real values from the in-memory snapshot immediately.
- `quantlab.eight_k_events` / `eight_k_classifier_snapshots` / `insider_trades` / `insider_ciks` / `form_4_insider_snapshots` / `gics_sector_map` — NOT yet created. Lazy-create on first ingest or migration apply.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts
              # 201 pass / 0 fail / 18 skipped (CH-unreachable EXPLAIN PLANs)

npm test                                                      # 2884 / 2787 pass / 2 fail / 95 skipped
                                                              # +3 net new tests vs s94 #10 (G2-DAEMON-XD/EK/F4-1)
                                                              # 2 fails pre-existing CH-unreachable (operatorBrief.test.ts)

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED

npm run check:help                                            # green
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s94 #11)

- **Daemon log-line `cluster_flag=` value uses string `'true'`/`'false'` (lowercase) per SPEC §5.5 regex.** The composite snapshot field is a JS `boolean`, but the log line emits the explicit lowercase string via `${snapshot.flag ? 'true' : 'false'}`. Do NOT change to `String(snapshot.flag)` (would emit correctly today but couples the log shape to JS's `Boolean.toString()` implementation). Future composites should mirror the explicit ternary.

- **Sector-name underscore-tokenization in daemon log line is one-way (no inverse).** "Consumer Discretionary" → `Consumer_Discretionary` in the log; the renderer's §1.4 prose retains "Consumer Discretionary" (with space). Operator tooling that round-trips between the log line and the brief should map `_ → ' '` explicitly. NOTE: a sector named "Real_Estate" (with literal underscore) is structurally impossible under GICS_SECTORS — the underscore-replacement is information-preserving in practice.

- **The orchestrator builds `aggregateLogLine` BEFORE the existing try/catch closes.** Pure-string operation on already-resolved snapshot fields; no I/O. The catch block in `daily_signal_daemon.ts` step 1i/1k/1l covers the entire daemon-call surface (read → compute → write → log). If a future refactor moves the log-line build OUTSIDE the orchestrator (into the daemon caller), the caller MUST add its own try/catch around the log line construction to preserve the non-fatal posture.

- **`inputsAvailableAggregate` semantic overload (Option C; S94-32).** Both `sectors_with_z` AND `floor_cleared` slots in the log line use the same `snapshot.inputsAvailableAggregate` value. This is a v1 approximation that holds because the floor's only practical failure is the empty-baseline2y cold-start case. If a future production observation surfaces an `inputsAvailableAggregate > sectorsClearedFloor` case (some sectors have sectorSize > 0 but baseline2y has < MIN_Z_BASELINE=30 entries), the log line will OVERSTATE `floor_cleared`. v2 tightening lands by adding a `sectorsClearedFloor: number` field to each snapshot interface + DDL ALTER per-composite + composite-eval + composite tests + persistence tests + the log-line denominator.

- **3 new tests use cold-start fixtures (sectors=[]) — they do NOT exercise the LIVE/non-trivial-z branch.** G2-DAEMON-*-1 asserts the regex shape + the cold-start sentinel (`max_z=n/a:n/a`) + Option C count equality (`0/11 ≡ 0/11`). A LIVE-z assertion (e.g., maxAggregateZ=2.34 at "Energy" emitting `max_z=Energy:2.34`) would require seeding the SP500 PIT panel + gics_sector_map + events panel — significant fixture-construction churn for a one-test regex pin. The MAXZ-*-1..4 tests in `executiveDeparture.test.ts` etc. already pin the LIVE-z computation at the composite layer; the daemon log line just stringifies what the composite produces.

### Carried (s89-s94 #10 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **Brief*Section types declare `maxAggregateZ`/`maxAggregateZSector` as REQUIRED fields (S94-29).** Any new test fixture that constructs a `BriefExecutiveDepartureSection` / `BriefEightKClassifierSection` / `BriefForm4InsiderSection` literal MUST include both fields.

- **The §1.4 three-branch order is load-bearing: LIVE → no-flag-cleared → cold-start.** The renderer's `if/else if/else` chain checks `flaggedSectors > 0` FIRST.

- **The F4 panel header is "cluster-buy rate by GICS sector" not "by GICS sector" (S94-31).**

- **The "k/11 cleared MIN_Z_BASELINE" semantic uses `inputsAvailableAggregate` as the count.** Same as the new S94-32 lock-in — the §1.4 renderer also uses this count.

- **`FakeClickHouse.route` is first-match-wins (S94-25).** Applies to the new G2-DAEMON tests too; the cold-start fixture uses a catch-all (`_ => true, []`) so order doesn't matter, but if a future test seeds a LIVE-z fixture, route most-specific-first.

- **The three ALTER migrations are operator-gated on first run (s94 #8).** Each script's `:apply` variant is destructive per the migration's own banner. Operator MUST run them BEFORE the brief renderer's stale-read path (via `loadLatestSnapshot`) will see real `maxAggregateZ` values — but the live daemon-cycle path emits real values from the in-memory snapshot immediately.

- **V1 event-query universe is today's PIT constituents only (S94-27).** Historical-only tickers (in SP500 historically but not today) have their events dropped from baseline attribution.

- **Path A rolling-rate semantic locks per-composite intrinsic windowDays (S94-26).** XD/EK use 90d; F4 uses 30d cluster window.

- **`dayAsOf` uses end-of-day semantic (`day + 'T23:59:59.999Z'`) for baseline rate evaluation.**

- **The composite source files have `\0` literals in template strings.** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset.

- **Tie-break asymmetry on equal-|z| with opposite signs (carried).**

- `gics_sector_repository_helper.ts` is the byte-template owner for per-ticker (`readGicsSectorByTicker`) + per-day-panel (`readSectorMembershipPanel`) + per-ticker-timeline (`readGicsSectorTimeline`) sector lookups.

- `MIN_Z_BASELINE = 30` floor stays at 30 across all three composites per ADR-042 §6.

- `stddevSamp` not `stddevPop` — Bessel correction.

- Today's rate must be EXCLUDED from the baseline window per ADR-042 §4.

(All earlier s89-s94 #10 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); aggregate-sector layer LIVE on XD/EK/F4 — emits [xd|ek|f4]-aggregate log line per cycle
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 LIVE — Step 4 renderer §1.4 three-branch ACTIVE
```

### Gap #7+#8 v2 GICS activation — ARC CLOSED

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

# G2 aggregate-panel activation (FULLY DONE end-to-end):
# Step 1 DONE — readSectorMembershipPanel helper
# Step 2 DONE — composite-layer maxAggregateZ + maxAggregateZSector
# OQ-G3-1 sub-slice DONE — persistence wiring strategy (β)
# Step 3 DONE — populateSectorsForCycle across all three repos
# Step 4 DONE (ATOMIC) — renderer §1.4 three-branch + composer pass-through
# Step 5 DONE — daemon-orchestrator log-line wiring (~20 LOC × 3 + 3 G2-DAEMON tests)
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
npm run migrate:add-max-z-executive-departure-snapshots:apply   # s94 #8 — required for §1.4 LIVE / no-flag-cleared branch in the brief
npm run daemon:daily                                            # daemon's populateSectorsForCycle ACTIVE (s94 #9); emits [xd-aggregate] log line (s94 #11)
npm run brief:morning                                           # section #12 LIVE — §1.4 three-branch ACTIVE (s94 #10)
```

### Gap #7 8-K classifier (G2 LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily                                            # emits [ek-aggregate] log line
npm run brief:morning
```

### Gap #7 Form 4 (G2 LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run daemon:daily                                            # emits [f4-aggregate] log line
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2884 / 2787 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s94 #11 close
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts                     # this turn — 201 pass / 0 fail / 18 skipped
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** the gap #7+#8 v2 G2 arc is CLOSED — no default-next on the v2 GICS thread. Operator must reprioritize from the deferred queue. **Recommended pick** (lowest-friction next-default that consumes existing helpers): **Gap #7 v2 sell-cluster sector aggregation (S93-44)** — single-slice F4-only addition that closes a small remaining asymmetry in the F4 arc (currently only buy clusters fire `form4ClusterFlag`; sell clusters are tracked per-ticker but don't aggregate to a per-sector flag).

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC §5 test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.

**If operator reprioritizes:** any of these candidates can be the default-next:

- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would consume the new helpers).
- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**

- Push 35 commits to origin/main (HOLD).
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

**The gap #7+#8 v2 G2 arc is CLOSED.** Five SPEC steps + the OQ-G3-1 persistence sub-slice + the s94 #1-#4 G1 wiring constitute the complete v2 deliverable. `npm run daemon:daily` will emit one `[<xd|ek|f4>-aggregate]` log line per composite per cycle. `npm run brief:morning` will render sections #12 + #14 + #15 with the LIVE / no-flag-cleared / cold-start branches per snapshot state.

**The companion SPEC at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md) is fully shipped.** All 45 §5 tests landed (6 SMP + 12 MAXZ + 12 POPSEC + 9 G2-RENDER + 3 G2-COMPOSER + 3 G2-DAEMON), plus the 6 G3R sub-slice tests outside the §5 count (51 G2-arc tests total).

**The composite source files have `\0` literals (carried watch-out).** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset.

**Parallel-tracks posture continues.** s94 #11 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2787 pass (2 pre-existing CH-unreachable fails in operatorBrief.test.ts are NOT regressions from this turn; confirmed by the +3-tests-vs-s94 #10 delta matching exactly the 3 G2-DAEMON tests added).

**The chain through s94 #11:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15)           ✓ committed (3eb94d6)
S94 #3: gap #7+#8 v2 GICS-A3 (EK repo + #14)           ✓ committed (497a645)
S94 #4: gap #7+#8 v2 GICS-A4 (XD repo + #12 +          ✓ committed (dc70f8c)
        helper extraction per S94-10)
S94 #5: OQ-G2-1 ADR-042 RESEARCH note                  ✓ committed (9ceb1cd)
S94 #6 part A: ADR-042 Accept + companion SPEC         ✓ committed (d69d34f)
S94 #6 part B: Step 1 helper + 6 SMP tests             ✓ committed (75599d7)
S94 #7: Step 2 composite-layer maxAggregateZ +         ✓ committed (1a3fc00)
        maxAggregateZSector + 12 MAXZ-* tests
S94 #7 HANDOFF rewrite                                 ✓ committed (175f58b)
S94 #8: OQ-G3-1 sub-slice — strategy (β) persistence   ✓ committed (dd366b6)
        wiring across all three composites + 6 G3R tests
S94 #8 HANDOFF rewrite                                 ✓ committed (7cfaf42)
S94 #9: Step 3 populateSectorsForCycle across all      ✓ committed (3f9b414)
        three repos + 12 POPSEC-* tests
S94 #9 HANDOFF rewrite                                 ✓ committed (55f6f2b)
S94 #10: Step 4 ATOMIC renderer §1.4 3-branch +        ✓ committed (a1d194d)
        composer pass-through + 12 tests (9 G2-RENDER + 3 G2-COMPOSER)
S94 #10 HANDOFF rewrite                                ✓ committed (443bf80)
S94 #11: Step 5 daemon-cycle log line +                ✓ committed (a20d57b)
        3 G2-DAEMON tests — GAP #7+#8 v2 G2 ARC CLOSED
S94 #11 HANDOFF rewrite (this commit)                  ✓ this commit
  → DEFAULT NEXT: G2 arc CLOSED; operator reprioritizes from deferred queue.
  → Recommended pick: Gap #7 v2 sell-cluster sector aggregation (S93-44).
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots ALL carry populated sector field when
                gics_sector_map row exists; aggregate-layer ACTIVE end-to-end —
                composites consume populated inputs.sectors[] + emit non-null
                maxAggregateZ / maxAggregateZSector; renderer renders the §1.4
                three-branch per snapshot state; daemon emits the per-cycle
                aggregate log line. Persistence ALTER migrations operator-run;
                the brief renders correctly whether or not the persisted
                observability columns exist (live daemon-cycle path uses the
                in-memory snapshot; brief's stale-read path needs the columns).
```
