# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #8 — **gap #7 F4-A2 DONE** as commit `3983867`. Closes the pure-composite layer of the Form 4 insider arc: `src/server/form_4_insider.ts` (~480 LOC) + 63 new TS tests covering SPEC §9.7 T-F4-1..T-F4-14 + supplementals. Per-stock layer emits {`insiderBuyCount90d`, `insiderSellCount90d`, `insiderBuyerCount90d`, `insiderSellerCount90d`, `insiderNetDollar90d`, `insiderClusterBuyFlag`, `insiderClusterSellFlag`}; aggregate layer emits BUY-only per-sector cluster-rate z-scored vs 2y baseline (`form4ClusterFlag = OR over sectors at |z| > 2.0`). HIGH_SIGNAL_TRANSACTION_CODES = {P, S} enforced at composite READ time per S93-37 load-bearing (F4-A1 ingest stores ALL codes). Cluster threshold ≥3 distinct `personCik` in 30d, same direction (F4-2). All gates green (npm test 2602/2625 pass +63 vs baseline 2562, tsc 13 errors unchanged baseline, check:help ✓). 4 commits ahead of `origin/main`; push still operator-gated. **F4-A3 NEXT (snapshot-table migration co-bootstrap)**.)

## What this turn delivered

Eighth slice of the gap #7 event-driven-filings-processor arc (s93 #8 — Phase F4-A2), closing the pure-composite layer of the Form 4 insider arc:

1. **`src/server/form_4_insider.ts`** (~480 LOC). Per SPEC §2.3 (F4-1..F4-12) + §5.3 + §5.4 + §10 Phase F4-A2. Architecture:
   - **Per-ticker layer (§5.3):** for each ticker T in equity-midcap universe as of D, emits the SPEC §5.5 `per_ticker_rows[i]` shape: `insiderBuyCount90d`, `insiderSellCount90d`, `insiderBuyerCount90d` (distinct `personCik`), `insiderSellerCount90d` (distinct `personCik`), `insiderNetDollar90d = Σ(P $) − Σ(S $)`, `insiderClusterBuyFlag` (≥3 distinct `personCik` with code P in 30d), `insiderClusterSellFlag` (mirror).
   - **Aggregate layer (§5.4):** per sector, computes cluster-rate = `count(tickers with insiderClusterBuyFlag) / sectorSize`, z-scored against trailing 2y baseline; emits flagged-sector row when `|z| > 2.0`. `form4ClusterFlag = OR over sectors`. BUY-only per F4-6 (sell-cluster aggregation deferred to v2).
   - **Load-bearing filter (S93-42):** `HIGH_SIGNAL_TRANSACTION_CODES = ['P', 'S']` enforced at composite READ time via `filterTradesToHighSignalCodes`. F4-A1 ingest stores ALL codes (S93-37); the composite MUST filter at read or grants/exercises/gifts dilute the signal.
   - **Cluster window semantic (S93-43):** distinct-on-`personCik`, NOT on accession. A single insider filing 3 separate buys counts as 1 insider (test T-F4-8 pins this). Same-direction lock: 2-buy-1-sell mix fires neither flag (test T-F4-9b pins this).
   - **Dedupe (S93-45):** defensive `dedupeTrades` on `(issuerCik, accession, transactionId)` mirrors ReplacingMergeTree ORDER BY. Re-ingest race or upstream replay can emit logical duplicates to the pure function; dedupe absorbs.
   - **`roleFlags` pass-through (F4-3):** field is on `InsiderTrade` for forensic completeness but NOT consumed by any composite formula. v2 ADR can resurface for CEO-weighted variants.
   - **Z-score helper byte-identical** to `eight_k_classifier.computeZ` + `executive_departure.computeZ` + `etf_flow.computeZ` (sample stddev n-1 per AFML §1.3, MIN_Z_BASELINE = 30, degenerate-stddev sentinel at 1e-12).
   - Constants exported: `FORM_4_INSIDER_COMPOSITE_VERSION='form_4_insider_v1'`, `ROLLING_WINDOW_DAYS=90`, `CLUSTER_WINDOW_DAYS=30`, `CLUSTER_INSIDER_THRESHOLD=3`, `FORM_4_CLUSTER_Z_THRESHOLD=2.0`, `MIN_Z_BASELINE=30`, `HIGH_SIGNAL_TRANSACTION_CODES`, `BUY_CODE='P'`, `SELL_CODE='S'`.
   - **Inputs shape** mirrors EK-A2: `{asOf, lastEdgarQueryAt, bdSinceLastQuery, perTicker[{ticker, cik, sector, trades}], sectors[{sector, sectorSize, trades, baseline2y}]}`. v1 GICS-deferred posture: `sectors` array empty by default until gap #7 v2 GICS activation ships.

2. **`scripts/tests/form4Insider.test.ts`** (~63 tests, all pass):
   - SPEC §9.7 T-F4-1..T-F4-14 all covered.
   - Supplementals: 90d window boundary inclusion (4 tests), dedupe (4 tests), orchestrator integration (6 tests including a comprehensive 7-field per-ticker round-trip), cross-cutting S93-37 enforcement (3 tests including A-grant filter + M-exercise filter), constants sanity (1 test).
   - Test infrastructure helpers: `makeTrade(overrides)`, `makeInputs(overrides)`, `assertClose(actual, expected, eps)` — mirror EK-A2 test pattern.

3. **Wiring**: No `package.json` / help.ts changes for F4-A2 (pure-function module; no operator-runnable script). F4-A3 (snapshot-table migration co-bootstrap) is where the next npm-script entries land.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 event-driven-filings-processor SPEC + teach-doc | ✓ s93 #1 (`48e0da1`) |
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4-A1 (Form 4 EDGAR ingest CLI) | ✓ s93 #7 (`d368012`) |
| **Gap #7 F4-A2 (pure composite `form_4_insider_v1`)** | **✓ s93 #8 (`3983867`)** |
| **Gap #7 F4-A3 (snapshot-table migration co-bootstrap)** | **☐ NEXT** |
| Gap #7 F4-A4..A5 (repository + daemon step 1l → brief #15) | ☐ queued after F4-A3 |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| Gap #7 v2 — GICS sector mapping activation (8-K + F4 aggregate panels) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo) |
| Gap #7 v2 — sell-cluster sector aggregation (per S93-44) | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow/8-K/F4 | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 4 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 8 (this turn, this commit) — F4-A2 implementation forks

**S93-42. `HIGH_SIGNAL_TRANSACTION_CODES = ['P', 'S']` is enforced at the composite READ layer via `filterTradesToHighSignalCodes`.**
`Why:` Per S93-37 (carried-forward warning), F4-A1 ingest stores ALL transaction codes (P, S, A, M, F, G, D, X, ...). The composite is the load-bearing gate for the {P, S} subset. Three-criterion analysis:
  1. Canon foundations — F4-4 explicit: "All other transaction codes (A grants, M exercises, F payments, G gifts, etc.) are stored at ingest but excluded from the composite." Lakonishok-Lee 2001 §3 + CMP 2012 standard filter.
  2. Methodology rigor — composite-layer filtering preserves forensic access at the raw `insider_trades` table for the v2 CMP classifier; a regression that read raw without filtering would dilute the cluster signal with non-discretionary trading (stock-based-comp, option exercises, gifts).
  3. Minimum free parameters — the filter list is exported as a single `HIGH_SIGNAL_TRANSACTION_CODES` constant; a v2 widening (e.g., add "M") requires changing BOTH the Python ingest constant AND this TS constant, AND updating the constants-sanity test.

Result: `evaluateForm4InsiderComposite` calls `dedupeTrades → filterTradesToHighSignalCodes → window-filter` on both per-ticker and per-sector trade panels. Direct callers of `countTradesByCode` etc. must filter themselves OR pass an already-filtered slice.
`How to apply:` A future PR that bypasses the composite filter (e.g., calls `countDistinctInsidersByCode` on raw trades for v2 backtests) MUST first apply `filterTradesToHighSignalCodes`. The cross-cutting test "composite does NOT count A-grants in insider_buy_count_90d" pins the inviolant contract; a regression that admitted A-grants would break it loudly.

**S93-43. Cluster threshold is distinct-on-`personCik`, NOT on `accession`. Same-direction lock applies — mixed-direction clusters fire neither flag.**
`Why:` Per F4-2 explicit: "≥3 distinct insiders within 30 calendar days, same direction. Distinct on insider identity (`person_cik`), not on filing." HANDOFF watch-out carried from s93 #7: "Same direction = same `transaction_code`. A mixed 2-buy-1-sell cluster does NOT fire either flag." Three-criterion analysis:
  1. Canon foundations — F4-2 explicit; Lakonishok-Lee 2001 cluster effects.
  2. Methodology rigor — distinct-on-`personCik` correctly absorbs the case where one prolific insider files multiple separate trades within 30d (test T-F4-8: 1 insider × 3 trades = 1 distinct insider, NOT 3). Distinct-on-accession would over-count.
  3. Minimum free parameters — single threshold (3) + single window (30d); no per-role weighting (F4-3 lock).

Result: `countDistinctInsidersByCode` uses `Set<personCik>` semantics. `evaluateForm4InsiderComposite` computes the cluster threshold separately for direction='P' (buy-cluster) and direction='S' (sell-cluster). A 2-P-1-S panel has `distinctBuyers30d=2` and `distinctSellers30d=1` — neither hits 3.
`How to apply:` Any future v2 that wants the "any 3 insiders in 30d regardless of direction" semantic needs a NEW flag (e.g., `insiderActivityClusterFlag`); reusing the existing P/S flags for that semantic would change wire-format behavior and require a composite version bump. The aggregate layer reads only `insiderClusterBuyFlag` per F4-6 — v2 sell-cluster sector aggregation requires its own SPEC slice.

**S93-44. Aggregate sector layer counts ONLY cluster-buy events (per F4-6); sell-cluster sector aggregation deferred to v2.**
`Why:` Per F4-6 explicit: "Aggregate clustering: per-sector count of `insider_cluster_buy_flag` events, z-scored against trailing 2y baseline." The §5.4 pseudocode uses `per_stock_cluster_buy_flag(T)`. SPEC §9.7 T-F4-11 names "2 tickers with cluster-buy in sector of 20 constituents → rate = 0.1" — BUY-only language. Three-criterion analysis:
  1. Canon foundations — F4-6 lock + Seyhun 1986 insider-buy predictability foundation. The sell side has weaker canon support (sells are diluted by liquidity/diversification motives — CMP 2012 §1 documents the asymmetry).
  2. Methodology rigor — v1 ships fewer signals; v2 ADR can add sell-cluster sector aggregation once Phase B reveals whether the buy-side aggregate has independent signal vs the per-ticker `insiderClusterSellFlag`.
  3. Minimum free parameters — one sector aggregate metric in v1; doubling to buy+sell would add a second threshold + second baseline panel.

Result: `computeSectorClusterRate` groups trades by `issuerTicker`, derives per-ticker `insiderClusterBuyFlag`, counts tickers where it fired, divides by `sectorSize`. The aggregate ONLY uses `BUY_CODE`. The per-ticker `insiderClusterSellFlag` is preserved in `perTickerRows` for forensic + downstream consumers but NOT surfaced at the sector level.
`How to apply:` v2 sell-cluster sector aggregation needs its own SPEC fork — adding a parallel `form_4_sell_cluster_flag` + parallel `flaggedSectorsSell` would require a snapshot-shape change (new payload column) + composite version bump (`form_4_insider_v2`).

**S93-45. `dedupeTrades` runs ahead of all per-ticker + per-sector math; key = `(issuerCik, accession, transactionId)`.**
`Why:` Mirrors EK-A2's `dedupeEvents`. ReplacingMergeTree ORDER BY `(issuer_cik, accession, transaction_id)` handles physical dedupe at storage, but a re-ingest race or upstream replay can still emit duplicate logical rows to the pure function. Three-criterion analysis:
  1. Canon foundations — defense-in-depth; canon-thin call.
  2. Methodology rigor — `insiderBuyCount90d` and `insiderNetDollar90d` are NOT distinct-counts; they would double-count duplicates. Dedupe by the SAME tuple as the storage ORDER BY guarantees consistency.
  3. Minimum free parameters — zero new constants.

Result: `dedupeTrades(trades)` uses `Set<string>` keyed on `${issuerCik} ${accession} ${transactionId}`. Per-ticker orchestrator calls `dedupeTrades → filterTradesToHighSignalCodes → math`. Per-sector orchestrator does the same on the sector-wide trade panel before grouping by `issuerTicker`.
`How to apply:` A future caller that invokes `countTradesByCode` etc. directly on raw upstream data MUST `dedupeTrades` first OR the counts double-count duplicates. Test "per-ticker layer dedupes trades before counting" pins this.

### Sessions 84-93 #1-#7 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-41 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

## Open questions

### HIGH (carried)

1. **C-12 Phase B Alpaca onboarding** — paused indefinitely.
2. **CBOE DataShop subscription** — blocked under data-source policy.
3. **#5 capital-deployment-ramp ADR** — operator self-assigned ~1 week; not blocking.

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable).
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess for 8-K ingest; operator-action verification deferred to first ingest run).
- Cold-start cascade timing for EK arc end-to-end (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- Cold-start cascade timing for F4 arc end-to-end (~6-8 weeks of EDGAR ingest history; cluster threshold of 3-in-30 may need calibration adjustment if SP500 universe rarely hits it in real data).

### Closed this turn

- ~~F4-A2 composite-layer transaction-code filter location~~ — RESOLVED per S93-42: composite enforces {P, S} via `filterTradesToHighSignalCodes`.
- ~~F4-A2 cluster-distinct semantic (personCik vs accession)~~ — RESOLVED per S93-43: distinct on `personCik`; same-direction lock.
- ~~F4-A2 aggregate buy-vs-sell direction~~ — RESOLVED per S93-44: BUY-only in v1; sell-cluster sector aggregation v2 ADR.
- ~~F4-A2 dedupe semantic~~ — RESOLVED per S93-45: dedupe by `(issuerCik, accession, transactionId)`; runs ahead of all math.

### Newly opened

- **F4-A3 snapshot-table migration co-bootstrap** — third slice of the F4 arc. Per SPEC §6.2 + §9.9 (T-F4M-1..T-F4M-4). Mirrors EK-A3 architecturally:
  - `scripts/migrate_create_form_4_insider_snapshots.ts` (~250 LOC est.). Three-table CREATE IF NOT EXISTS co-bootstrap: `quantlab.insider_trades` (source table, byte-pinned to F4-A1's ingest DDL via import-reference per S93-22 pattern) + `quantlab.insider_ciks` (insider name cache, byte-pinned similarly) + `quantlab.form_4_insider_snapshots` (snapshot table). The first two reproduce DDL that F4-A1 ingest lazy-creates; migration runs MAY happen BEFORE first ingest, so co-bootstrap must idempotently CREATE all three.
  - `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts` (~6-10 tests est.) per SPEC §9.9: T-F4M-1 dry-run reports DDL; T-F4M-2 apply creates tables, re-apply no-op; T-F4M-3 DDL matches §6.2; T-F4M-4 all three tables created idempotently. Plus DDL-parity test mirroring EK-A1's `test_ingest_lazy_create_ddl_matches_migration_planned_ddl` (Python⇄TS byte-pin check via import-reference).
  - npm scripts: `migrate:create-form-4-insider-snapshots` + `migrate:create-form-4-insider-snapshots:apply` + help.ts EXTRA_HELP entries.

- **F4-A3 byte-pinning to F4-A1 DDL.** EK-A3's S93-22 lock established the import-reference pattern: the migration imports the Python DDL string from the ingest module's pyi-equivalent. For F4-A3, the parity tests must cover BOTH `insider_trades` AND `insider_ciks` DDLs (whereas EK-A3 only covered `eight_k_events`). The `insider_ciks` table is NEW for F4 and has no analog in the EK arc.

- **F4-A4 repository + daemon step 1l** — fourth slice. Architecturally mirrors EK-A4 (s93 #5 `39b6024`): `src/server/form_4_insider_repository.ts` reads `insider_trades` + `cik_ticker_map` + `sp500_constituents` PIT, assembles `Form4InsiderInputs`, calls `evaluateForm4InsiderComposite`, writes `form_4_insider_snapshots`. Daemon step 1l in `scripts/daily_signal_daemon.ts` calls it absent-table-safe per EK-A4's two-gate pattern.

- **F4-A5 brief section #15** — fifth slice. Architecturally mirrors EK-A5 (s93 #6 `7ee5852`): `BriefForm4InsiderSection` + `renderForm4InsiderSection` + `FORM_4_STALENESS_BD_THRESHOLD = 4` analog. Top-N flagged truncation + cold-start fallback + "No tickers flagged" fallback + staleness arrow + net-dollar formatting with sign ("net +$2.3M" / "net -$11.2M") per T-OBR-F4-1..T-OBR-F4-7.

## Next stage

### Default on "continue"

**Gap #7 F4-A3 — snapshot-table migration co-bootstrap.** Concrete first move:

1. Read `docs/specs/event-driven-filings-processor.md` §6.2 + §9.9 (Form 4 CH tables + migration test plan).
2. Read `scripts/migrate_create_eight_k_classifier_snapshots.ts` (s93 #4 EK-A3 precedent) end-to-end as the architectural template.
3. Read `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` (EK-A3 tests) as the test template.
4. Re-read `scripts/sec_edgar_form4_ingest.py` `ensure_insider_trades_table` + `ensure_insider_ciks_table` to extract DDL strings for byte-pinning per S93-22 import-reference pattern.
5. Write `scripts/migrate_create_form_4_insider_snapshots.ts` (~250 LOC est.). Three-table CREATE IF NOT EXISTS co-bootstrap.
6. Write `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts` (~6-10 tests est.) per SPEC §9.9.
7. Add `migrate:create-form-4-insider-snapshots{,:apply}` to `package.json` + help.ts EXTRA_HELP entries.
8. `npm test` green; `npm run check:help` green; commit as F4-A3 slice.

### After F4-A3 lands

Standard arc continues: F4-A4 (repository + daemon step 1l) → F4-A5 (brief section #15). Each commits as its own slice.

### After F4 arc ships

Operator-pickable deferred insertions:

- ADR-041 implementation slot (`yield_curve_inverted` category).
- Gap #7 v2 — GICS sector mapping activation (8-K + Form 4 aggregate panels).
- Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32 v2 deliverable).
- Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1; ≥6mo warm-up gated).
- Gap #7 v2 — 13D/13G arc (separate SPEC).
- Gap #7 v2 — event-driven cadence promotion (Phase B-gated).
- Gap #7 v2 — sell-cluster sector aggregation (per S93-44).
- Gap #8 v2 — GICS sector activation.
- Gap #9 v2 — ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the eight (nine after F4) Layer-0 composites.

## Files / code state

### NEW this turn (s93 part 8)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | CREATED (`3983867`) | ~480 LOC. Pure functions + types per SPEC §5.3-§5.5. `HIGH_SIGNAL_TRANSACTION_CODES = ['P', 'S']` enforced at READ time per S93-42. Z-score helper byte-identical to EK/exec/etf. v1 GICS-deferred posture in `sectors` array empty default. |
| `scripts/tests/form4Insider.test.ts` | CREATED (`3983867`) | ~63 tests. SPEC §9.7 T-F4-1..T-F4-14 all covered + supplementals. All pass. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for F4-A2 close + F4-A3 next. |

### From s93 #7 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | F4-A1 ingest. `parse_form4_xml` returns ALL transaction codes; the composite (this turn) enforces {P, S} filter. |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | 39 Python tests. |
| `package.json` | EXISTS (`d368012`) | `edgar:form4:ingest{,:dry}` scripts. |
| `scripts/help.ts` | EXISTS (`d368012`) | F4-A1 EXTRA_HELP entries. |

### From s93 #2-#6 (carried; unchanged)

All prior gap #7 EK arc files preserved unchanged.

### CH state (unchanged from s93 #7)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created (EK-A1 ingest creates lazily; EK-A1 standalone migration also creates; EK-A3 co-bootstrap also creates).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (EK-A3 migration script exists; not yet applied).
- `quantlab.insider_trades` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create).
- `quantlab.insider_ciks` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (F4-A3 WILL create).

### Tests

```text
npm test                       2625 tests / 2602 pass / 0 fail / 23 skipped   ✓ (+63 vs s93 #7 baseline of 2562 pass)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   298 / 298 (unchanged from s93 #7 — TS-only slice)
```

## Watch-outs

### NEW from this turn (s93 #8)

- **Composite-layer {P, S} filter is load-bearing per S93-42.** A regression that read `insider_trades` raw WITHOUT calling `filterTradesToHighSignalCodes` first would admit grants (code A), option exercises (code M), tax payments (code F), gifts (code G), etc. The cross-cutting test "composite does NOT count A-grants in insider_buy_count_90d" pins the contract; if it breaks, the cluster signal is silently diluted.
- **`HIGH_SIGNAL_TRANSACTION_CODES` is conceptually byte-pinned to Python `DEFAULT_HIGH_SIGNAL_CODES` (cross-language drift uncaught).** No compile-time link between `src/server/form_4_insider.ts:HIGH_SIGNAL_TRANSACTION_CODES` and `scripts/sec_edgar_form4_ingest.py:DEFAULT_HIGH_SIGNAL_CODES`. Both pinned to `('P', 'S')` at v1; a v2 widening (e.g., add "M") MUST update BOTH ends + the constants-sanity test + the cross-cutting "composite does NOT count M-exercises as a buy" test.
- **Same-direction cluster semantic per S93-43 / F4-2.** `evaluateForm4InsiderComposite` computes `distinctBuyers30d` and `distinctSellers30d` SEPARATELY. A 2-buy-1-sell mix has `distinctBuyers30d = 2`, `distinctSellers30d = 1` — neither hits the threshold of 3. A reader expecting "any 3 insiders in 30d regardless of direction" semantic would be surprised. Test T-F4-9b ("mixed 2-buy-1-sell does NOT fire either cluster flag") pins this.
- **Distinct on `personCik`, NOT on accession.** A single prolific insider filing 3 separate trades within 30d contributes 1 to the distinct-insider count, NOT 3. Test T-F4-8 pins this. F4-A1's `resolve_person_cik_to_name` is load-bearing for this semantic — if a regression conflated `personCik` and accession (e.g., used `f"{accession}-{txn_id}"` as the distinct key), the cluster threshold would over-fire on prolific single-insider days.
- **Aggregate is BUY-only per S93-44 / F4-6.** `form4ClusterFlag` fires on concentrated insider BUYING activity (bullish surprise), NOT on selling. The per-ticker `insiderClusterSellFlag` IS surfaced in `perTickerRows` for downstream forensic + brief rendering, but the sector-aggregate layer does NOT z-score sell-cluster events. v2 sell-cluster sector aggregation requires its own SPEC slice + composite version bump.
- **`dedupeTrades` runs ahead of all math per S93-45.** Re-ingest race or upstream replay can emit logical duplicates. A direct caller of `countTradesByCode` etc. on raw upstream data MUST `dedupeTrades` first OR the count double-counts duplicates. The orchestrator handles this; ad-hoc analytical queries that bypass the orchestrator need to be aware.
- **`roleFlags` is pass-through only in v1 (F4-3).** The `InsiderTrade` interface carries `roleFlags` as a UInt8 bitmask (`bit0=director, bit1=officer, bit2=10pct_owner, bit3=other`) for forensic completeness but NO composite formula consumes the field. v2 ADR for CEO-weighted variants would change this; until then, removing `roleFlags` from the interface would break the F4-A4 repository's row-shape contract.
- **`dollarAmount` trusted as-is from ingest.** F4-A1 pre-computes `shares × pricePerShare` at the ingest layer per F4-5 + S93. A regression at the ingest layer that set `dollarAmount = 0` while preserving `shares` + `pricePerShare` would silently zero `insiderNetDollar90d`. Round-trip tests at the ingest layer (T-F4I-2) pin this; the composite trusts the field.
- **`acceptedAt` is the load-bearing window-membership anchor per F4-10.** A regression that swapped to `transactionDate` (forensic-only) would inject look-ahead leakage — insiders have 2 business days to file post-trade per 17 CFR 240.16a-3. The composite is anchor-agnostic at the function boundary; the contract is enforced at the repository layer (F4-A4 will read `accepted_at`, NOT `transaction_date`).
- **Z-score helper byte-identical to EK/exec/etf.** Sample stddev (n-1) per AFML §1.3; MIN_Z_BASELINE = 30; degenerate-stddev sentinel at 1e-12. A reader who has internalized one of the four prior implementations does NOT need to re-learn the Form 4 version — same semantic, same constants, same returns shape `{z, baselineSize}`.
- **Cold-start cascade in aggregate.** A single missing-baseline sector forces its z to null but `form4ClusterFlag` still fires if any OTHER sector exceeds threshold. Mirrors EK + gap #8 + gap #9 posture. Operator sees the cold-start via `inputsAvailableAggregate < sector count` in the snapshot. The test "cold-start baseline does NOT flag cluster" pins the single-sector cold-start case.
- **Window inclusivity on both ends.** A trade at `acceptedAt = asOf - 90d 00:00:00.000Z` IS in window; at `asOf - 90d - 1ms` is NOT. Same for the 30d cluster window. Tests pin both boundaries for both windows.
- **30d cluster window can fire WITHIN the 90d main window.** A 3-distinct-insider buy cluster all dated within trailing 30d → `insiderClusterBuyFlag=true` AND those buys ALSO contribute to `insiderBuyCount90d` + `insiderBuyerCount90d` + `insiderNetDollar90d`. Test T-F4-10c pins "cluster fires when 3rd insider trades exactly at -30d boundary" — but T-F4-10d shows the 3rd insider 1ms beyond the cluster window still contributes to the 90d buy count (count=3) while the cluster flag stays false.

### Carried (s89-s93 #1-#7 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 4 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` (8-K) and `accepted_at` vs `transaction_date` (Form 4) are the load-bearing anti-leak gates (gap #8 E-7 + gap #7 EDF-5 + F4-10).
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1); gap #7 EK-A1 does NOT (item-level only per EK-2; cheaper). Form 4 F4-A1 does fetch the per-filing XML body.
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL per EK-5.
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (separate `insider_ciks` vs `cik_ticker_map` tables; F4-A1 + F4-A2 reinforce this).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4 — at COMPOSITE layer (S93-37 + S93-42). Ingest stores all codes.
- A5 byte-equal protection on sections #1-#13 + rendered #14 (8-K, s93 #6) + planned #15 (Form 4, F4-A5) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3` for etf-flow; `>= 4` for EDGAR composites) — render layer (operator_brief_render) owns the threshold constants per-composite. F4-A5 will reuse `FORM_4_STALENESS_BD_THRESHOLD = 4` analog.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried). F4-A3 will need the SAME pattern for both `insider_trades` AND `insider_ciks` DDLs.
- `composite_version` vs `version` mapping at the EK-A4 write boundary (load-bearing translation, tested). F4-A4 will need the same.
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters) — EK has no Float scalars; F4 has `insiderNetDollar90d` which is Float64 at storage per SPEC §6.2 (no downcast risk).
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module (s93 #2, #7).
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat; s93 #2, #7).
- `build_event_search_url` raises ValueError on empty items (programming error).
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker; no `help` export needed.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess; operator-action verified on first `--apply` run.
- **EK-A2 (carried):** `materialEventFlag` derives from `recentEventCount90d >= 1` (not OR-of-per-item-flags); per-item flag count uses exact string equality; distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string-Set; `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`; `HIGH_SIGNAL_ITEM_CODES` also pinned in Python ingest `DEFAULT_HIGH_SIGNAL_ITEMS` (cross-language drift uncaught).
- **EK-A4 (carried):** `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Repository reuses ticker stored on `eight_k_events` row at read time (no per-event CIK JOIN). Two-gate daemon posture (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`). EXPLAIN PLAN tests skip cleanly when source tables absent. F4-A4 mirrors this.
- **EK-A5 (carried):** Single `daysSinceLatestEvent` per ticker (S93-32 v2 path); `formatEightKItemList` order fixed 1.01 → 5.01; `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer; section #14 always renders; `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8. F4-A5 will reuse the analog `FORM_4_STALENESS_BD_THRESHOLD = 4`.
- **F4-A1 (carried):** Namespace-insensitive XML parser; person-CIK ≠ issuer-CIK; transaction_id 0-based within filing; derivative-table transactions silently dropped; XML-supplied ticker first then API fallback; role_flags bitmask (`bit0=director, bit1=officer, bit2=10pct_owner, bit3=other`); ALL transaction codes stored at raw table.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites + 8-K classifier (step 1k) when both EK gates clear; will gain Form 4 hook at F4-A4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#14 with real data once migrations applied; #15 added by F4-A5
```

### Gap #9 etf-flow activation (FULLY READY end-to-end)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily       # step 1j fires
npm run brief:morning      # section #13 renders
```

### Gap #10 short-interest activation (post-merge / per-operator-decision)

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation (post-merge / per-operator-decision; FULLY READY)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily       # step 1i fires
npm run brief:morning      # section #12 renders
```

### Gap #7 8-K classifier activation (FULLY READY end-to-end — EK arc COMPLETE)

```text
# EK-A1 ingest (READY):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest

# EK-A1 source-table standalone migration (READY — optional; ingest lazy-creates):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A3 snapshot-table migration co-bootstrap (READY — creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 daemon step 1k (READY — both gates absent-table-safe):
npm run daemon:daily

# EK-A5 brief section #14 (READY — composer threads + renderer renders):
npm run brief:morning
```

### Gap #7 Form 4 activation (F4-A1+A2 SHIPPED — A3..A5 PENDING; NEXT slice arc)

```text
# F4-A1 (READY — Python ingest + insider_trades + insider_ciks lazy-create):
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest

# F4-A2 (READY — pure composite; no operator-runnable script — imported by F4-A4 daemon hook):
# import { evaluateForm4InsiderComposite } from 'src/server/form_4_insider.js';

# F4-A3 (PENDING — next slice):
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply

# F4-A4 (PENDING):
npm run daemon:daily       # step 1l will fire

# F4-A5 (PENDING):
npm run brief:morning      # section #15 will render
```

### Tests + dev

```text
npm test                                                                       # TS — 2625 / 2602 pass / 0 fail / 23 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 298 / 298
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 F4-A3 — snapshot-table migration co-bootstrap. Single atomic slice:

1. **(Read)** `docs/specs/event-driven-filings-processor.md` §6.2 + §9.9 (Form 4 CH tables + migration test plan).
2. **(Read)** `scripts/migrate_create_eight_k_classifier_snapshots.ts` (s93 #4 EK-A3 precedent) end-to-end as the architectural template.
3. **(Read)** `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` (EK-A3 tests) as the test template.
4. **(Re-read)** `scripts/sec_edgar_form4_ingest.py` `ensure_insider_trades_table` + `ensure_insider_ciks_table` to extract DDL strings for byte-pinning per S93-22 import-reference pattern.
5. **(Write)** `scripts/migrate_create_form_4_insider_snapshots.ts` (~250 LOC est.). Three-table CREATE IF NOT EXISTS co-bootstrap: `insider_trades` + `insider_ciks` + `form_4_insider_snapshots`. The first two reproduce DDL that F4-A1 ingest lazy-creates; migration runs MAY happen BEFORE first ingest, so co-bootstrap must idempotently CREATE all three.
6. **(Write)** `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts` (~6-10 tests est.) per SPEC §9.9 T-F4M-1..T-F4M-4 + DDL-parity test for BOTH source tables (mirrors EK-A1's parity-test pattern).
7. **(Wire)** `package.json` `migrate:create-form-4-insider-snapshots{,:apply}` + help.ts EXTRA_HELP entries (2 new).
8. **(Gates)** `npm test` green; `npm run check:help` green; commit as F4-A3 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #7 v2 GICS sector activation for 8-K + Form 4 aggregate panels (operator-pickable insertion).
- Gap #7 v2 per-item recency for 8-K brief section #14 (S93-32 v2; operator-pickable insertion).
- Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1; calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #7 v2 sell-cluster sector aggregation (per S93-44; operator-pickable).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 4 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #7 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #7 v2 per-item recency for 8-K brief (operator-pickable; deferred-but-defined per S93-32).
- Gap #7 v2 CMP classifier (calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #7 v2 sell-cluster sector aggregation (operator-pickable; per S93-44).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the eight (nine after F4) Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s93 #8 closes the pure-composite layer of the Form 4 insider arc. F4-A1 ✓ → F4-A2 ✓ → F4-A3 → F4-A4 (daemon step 1l) → F4-A5 (brief section #15). Estimated ~3 more slices to close the F4 arc; each commits as its own slice. Same architectural template as the EK arc (s93 #2-#6) and the prior three Layer-0 composites.

F4-A2 composite layer is importable now but NOT yet runnable end-to-end (no daemon hook, no repository). The next slice (F4-A3) ships the migration that creates the snapshot table; the slice after that (F4-A4) wires the daemon to call `evaluateForm4InsiderComposite` and persist a snapshot per day.

**Per S93-42 (carried-forward warning, reinforces S93-37):** `HIGH_SIGNAL_TRANSACTION_CODES = {P, S}` is enforced at the composite READ layer. F4-A1 stores ALL codes. A regression that bypassed `filterTradesToHighSignalCodes` in F4-A4's repository would silently dilute the cluster signal. The cross-cutting test in `form4Insider.test.ts` ("composite does NOT count A-grants in insider_buy_count_90d") pins the inviolant contract.

**Per S93-44:** The aggregate sector layer counts BUY-cluster events only. `form4ClusterFlag` fires on concentrated insider buying. Per-ticker `insiderClusterSellFlag` IS in the snapshot per-ticker rows but the sector aggregate does NOT z-score it. v2 sell-cluster sector aggregation is a separate slice with its own SPEC + composite version bump.

v1 GICS-sector deferral mirrors gap #8 + gap #7 EK: per-ticker layer fully active, aggregate-sector layer dormant in v1 (sectors input empty by default). v2 GICS activation is a single operator-pickable insertion that ships `quantlab.gics_sector_map` and activates BOTH gap #7 8-K + gap #7 Form 4 + gap #8 exec-departure aggregate panels with one slice.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open F4-A3. Build `scripts/migrate_create_form_4_insider_snapshots.ts` mirroring EK-A3 (s93 #4 `58cc98f`) closely. ~6-10 new TS tests. Single atomic slice.

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #8:**

```text
ALL S41-S91 WORK                                       ✓ as documented
S90: gap #10 short-interest-tracking arc               ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc             ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                                   ✓ committed (6e9ffe0)
S92 #1..#6: gap #9 etf-flow-monitoring arc             ✓ COMPLETE end-to-end (6 commits)
S92 HANDOFF rewrite                                    ✓ committed (706a8b8)
S93 #1: gap #7 SPEC + teach-doc                        ✓ committed (48e0da1)
S93 #1 HANDOFF rewrite                                 ✓ committed (87985b1)
S93 #2: gap #7 EK-A1 — 8-K event ingest                ✓ committed (79b3ffa)
S93 #2 HANDOFF rewrite                                 ✓ committed (ca0f20b)
S93 #3: gap #7 EK-A2 — pure composite                  ✓ committed (1879b32)
S93 #3 HANDOFF rewrite                                 ✓ committed (ffb4881)
S93 #4: gap #7 EK-A3 — snapshot-table migration        ✓ committed (58cc98f)
S93 #4 HANDOFF rewrite                                 ✓ committed (449406a)
S93 #5: gap #7 EK-A4 — repository + daemon step 1k     ✓ committed (39b6024)
S93 #5 HANDOFF rewrite                                 ✓ committed (1390fd9)
S93 #6: gap #7 EK-A5 — brief section #14 (CLOSES EK arc) ✓ committed (7ee5852)
S93 #6 HANDOFF rewrite                                 ✓ committed (d5068da)
S93 #7: gap #7 F4-A1 — Form 4 EDGAR ingest CLI         ✓ committed (d368012)
S93 #7 HANDOFF rewrite                                 ✓ committed (f344502)
S93 #8: gap #7 F4-A2 — pure composite form_4_insider_v1 ✓ committed (3983867)
S93 #8 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 F4-A3 — snapshot-table migration co-bootstrap
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5 ✓ (COMPLETE)
  → gap #7 F4 arc: A1 ✓ → A2 ✓ → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #7 v2 GICS, gap #7 v2 per-item recency,
                                   gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence,
                                   gap #7 v2 sell-cluster sector aggregation
  → background: daemon writes per-cycle snapshots for all 8 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow, 8-K-classifier
                — once EK-A1 source + EK-A3 migration applied); adding Form 4
                insider once F4 arc ships through F4-A4.
```
