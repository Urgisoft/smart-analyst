# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 95 #9 — **Gap #9 v3 issuer-CSV live secondary panel ingest LIVE**: framework activated end-to-end. NEW Python ingest + NEW CH migration + repository `secondaryTableExists()` + `readSecondaryPanelForTickers()` + `readInputsForCycle` enrichment that auto-feeds both panels into `EtfFlowInputs` when the secondary table is populated. 1 commit `2fd0e94` / 7 files / +1262 LOC. NEW CH table `quantlab.etf_shares_outstanding_secondary` (separate table per s95 #8 schema-question resolution — non-destructive). Three-condition gate (`secondaryTableExists()` false || zero rows || empty intersection) preserves v1/v2 byte-equal §13 output until operator drops a CSV. **+31 net new tests** (19 Python + 12 TS). **59 commits ahead of `origin/main`.** **NEXT default on `continue`: operator pick — recommended slice if operator says only "continue": Gap #7 v2 13D/13G arc SPEC. Alternative: Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter (automates the operator's manual CSV drop).**)

## What this slice delivered

Closes the v3 follow-up to s95 #8 — wires a REAL producer into
`EtfFlowInputs.secondaryPanel`. The s95 #8 framework was dormant-by-default
since 2026-05-20; this slice activates it via a CSV-directory ingest + new CH
table + repository wiring. The §13 cross-validation sub-section is no longer
"framework-only"; the moment the operator drops a canonical-schema CSV in
`data/etf_flow_issuer_csv/`, the next daemon cycle emits real divergence rows.

### Single commit (s95 #9)

**`2fd0e94` — Gap #9 v3 issuer-CSV live secondary panel ingest.** 7 files, +1262 LOC / -3 LOC:

- **NEW** `scripts/etf_flow_issuer_csv_ingest.py` — ~280 LOC. Walks `--input-dir` (default `data/etf_flow_issuer_csv/`), parses each `*.csv` via `csv.DictReader`, validates header against `REQUIRED_COLUMNS = ('ticker', 'date', 'shares', 'close')`, parses rows with type guards (`float` + `date.fromisoformat`) + positivity guards (shares > 0, close > 0), materializes `aum = shares * close`, writes to `quantlab.etf_shares_outstanding_secondary`. Schema validation + WARN-on-parse-failure + table bootstrap per data-source policy. UTF-8 BOM tolerance via `utf-8-sig` codec (Excel-exported CSV friendly).

- **NEW** `scripts/migrate_create_etf_shares_outstanding_secondary.ts` — ~180 LOC. Standard migration shape: `runPreChecks` / `runPostChecks` / `runDryRun` / `runApply`. Idempotent `CREATE TABLE IF NOT EXISTS`. DDL byte-pinned identical to the Python ingest's `ensure_*` DDL — single source of truth across the two entry points.

- **NEW** CH table `quantlab.etf_shares_outstanding_secondary`. Schema:
  ```
  ticker       LowCardinality(String),
  date         Date,
  shares       Float64,
  close        Float64,
  aum          Float64,
  source       LowCardinality(String) DEFAULT 'issuer-csv',
  source_file  LowCardinality(String) DEFAULT '',
  ingested_at  DateTime DEFAULT now()
  ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (ticker, date)
  ```
  Same shape as primary, with `source` defaulting to `'issuer-csv'` (not `'yfinance'`) + new `source_file` provenance column (carries CSV basename).

- `src/server/etf_flow_repository.ts` — extended. New `secondaryTable` constructor option (default `'quantlab.etf_shares_outstanding_secondary'`). New `secondaryTableExists()` method (system.tables probe; returns false on any error so the reader can fail-quiet). New `readSecondaryPanelForTickers(asOf, tickers, days?)` method (subquery-around-FINAL pattern matching primary reader; returns `[]` when tickers empty / table absent / no rows in window). `readInputsForCycle` enrichment: parallel-fetches the secondary panel, reconstructs `primaryPanel` from the existing `panelByTicker` map (no extra CH query), threads both into `EtfFlowInputs` IFF the secondary read returned non-zero rows.

- `package.json` — `etf:flow:issuer-csv:ingest{,:dry}` + `migrate:create-etf-shares-outstanding-secondary{,:apply}` script entries (4 new npm scripts).

- `scripts/help.ts` — 2 new help entries (the migration's help is auto-collected from its own `export const help`).

- `scripts/tests/test_etf_flow_issuer_csv_ingest.py` (NEW) — 19 tests:
  - **T-EFIS-1abc** — canonical parse, ticker uppercase normalization, UTF-8 BOM tolerance.
  - **T-EFIS-2ab** — header schema reject (missing column) + accepts-extras (forward-compat).
  - **T-EFIS-3** — row-level type errors (bad shares + bad close skipped, valid rows pass).
  - **T-EFIS-4** — bogus date format skipped.
  - **T-EFIS-5** — non-positive shares + non-positive close rejection (3 distinct failure modes).
  - **T-EFIS-6abc** — writer column-order pinning + source-label + source_file passthrough + noop-on-empty + idempotency across re-calls.
  - **T-EFIS-7ab** — directory walk over multiple CSVs + empty-dir handles cleanly + missing-dir surfaces error.
  - **T-EFIS-8** — partial failure (one good + one bad header) logs WARN + continues; stderr captures the alert.
  - **T-EFIS-9** — apply mode writes via client.insert; dry mode short-circuits.
  - **T-EFIS-10** — `ensure_etf_shares_outstanding_secondary_table` calls client.command with the byte-pinned DDL.
  - **T-EFIS-11** — `REQUIRED_COLUMNS` constant locked at `('ticker', 'date', 'shares', 'close')`.

- `scripts/tests/etfFlowRepository.test.ts` — 12 new tests:
  - **T-EFR-S1..S6** (readSecondaryPanelForTickers) — empty tickers short-circuit + table-absent probe gate + reads/parses rows + subquery-around-FINAL pinning + drops unparseable shares/close + string-form numerics from CH JSONEachRow.
  - **T-EFR-T1..T2** (secondaryTableExists) — count > 0 ⇒ true; count == 0 ⇒ false.
  - **T-EFR-V1..V4** (readInputsForCycle v3 integration) — omits both panels when table absent + omits both when table exists but zero rows + wires both when populated + primaryPanel reconstructs from primary CH read with no filtering (comparator handles intersection internally).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted + implementation LIVE | ✓ s89c#2 + s95 #5 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc (v1) | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) + per-row + per-EVENT recency | ✓ DONE end-to-end (s93..s95 #7) |
| Gap #7 F4 arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93..s95 #4) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH/ACCEPTED | ✓ s94 #1-#6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| Gap #7 v2 sell-cluster F4 composite + G3 | ✓ s95 #1-#2 (F4 ARC FULLY CLOSED) |
| Form 4 ingest XML body URL discovery (hotfix) | ✓ s95 #3 |
| ADR-041 implementation | ✓ s95 #5 |
| Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions | ✓ s95 #6 (5 commits) |
| Gap #7 v2 per-EVENT EK recency | ✓ s95 #7 (EK v2 ARC FULLY CLOSED) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation FRAMEWORK | ✓ s95 #8 |
| **Gap #9 v3 issuer-CSV live secondary panel ingest** | **✓ s95 #9 (`2fd0e94`) LIVE — Python ingest + new CH table + repository probe/reader/wiring + 31 new tests** |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ deferred (operator-pickable; automates the manual CSV drop) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable; RECOMMENDED default-next) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 59 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 #9 (this slice)

**S95-46. Gap #9 v3 ships canonical-CSV-directory ingest first; issuer-specific XLSX scraping is v3.1.** The Python ingest reads from `data/etf_flow_issuer_csv/` (configurable via `--input-dir`); each CSV has canonical schema `ticker,date,shares,close`. The operator's manual workflow is: drop a CSV in the directory, run `npm run etf:flow:issuer-csv:ingest`. A v3.1 follow-up adds an SSGA-SPDR XLSX → canonical-CSV Playwright adapter that automates the drop.
`Why:` Framework-first posture (same as s95 #8). XLSX parsing requires `openpyxl` + an issuer-specific schema mapper + Playwright session-handling; that's ~500 LOC of orthogonal complexity. Shipping the canonical-CSV substrate first means the cross-validation framework already runs on real data the moment v3.1 lands — v3.1 just feeds the same directory the manual workflow feeds.
`How to apply:` v3.1 writes `scripts/etf_flow_ssga_spdr_scraper.py` (or `.ts` via the existing Playwright fixture infrastructure). Output target = the SAME `data/etf_flow_issuer_csv/` directory. The Python ingest's contract is the canonical schema, NOT any specific issuer — so v3.1 is purely an upstream-producer slice and doesn't need to touch the CH layer.

**S95-47. Separate `etf_shares_outstanding_secondary` table (not extending the primary's ORDER BY).** Per the s95 #8 HANDOFF schema-question note. The primary's `ORDER BY (ticker, date)` would need to become `(ticker, date, source)` to disambiguate, which requires a destructive table rebuild.
`Why:` Non-destructive migration path; primary's read path is byte-identical to pre-v3; the cross-validation comparator already operates on disjoint panels (S95-41 intersection-only contract). The cost is one extra reader path on the repository — paid once, then transparent to callers.
`How to apply:` A future v3.x that wants to compare MULTIPLE secondary sources against the primary (e.g. SSGA-SPDR vs iShares for SPY on the same date) would either need to (a) extend THIS table's ORDER BY to `(ticker, date, source)` — still a rebuild but smaller scope — or (b) introduce a third per-issuer table. (a) is preferred. Document the trade-off at the call site if the question reopens.

**S95-48. The secondary-table-presence probe is a system.tables count() query, NOT a try/catch over the data SELECT.** `secondaryTableExists()` queries `system.tables WHERE database = 'quantlab' AND name = {tbl:String}` and returns `Number(count) > 0`.
`Why:` Three reasons. (1) Semantic clarity — the probe answers a different question than the read; lumping them via try/catch would hide "real data error" inside "table absent." (2) Cheaper failure path — the probe is a low-cardinality system-table scan; a try/catch on the data SELECT would log a CH error every cycle on fresh-clone deployments. (3) Consistent shape with the existing `etfFlowSnapshotsTableExists` / `etfSharesOutstandingTableExists` module-level helpers, which operator tooling already learns to read.
`How to apply:` The probe issues one extra CH round-trip per `readInputsForCycle` call. Negligible at daily daemon cadence (~1ms); a perf-tight loop could memoize via a private boolean cache, but the once-per-day cadence makes this premature optimization.

**S95-49. `readInputsForCycle` reconstructs `primaryPanel` IN-PROCESS from the existing `panelByTicker` map — NO extra CH query.** The composite's comparator needs (ticker, date, shares, close) tuples; that's exactly what `readSharesPanelForTickers` already returned. The reconstruction is a flat-map + type-coerce loop.
`Why:` Three CH reads in `Promise.all` (latest-query + panel + max-date) were already the cost of a cycle; adding a fourth (primary panel re-read for cross-validation) would double the I/O for redundant data. The reconstruction loop is O(rows) ≈ 21 × ~252 ≈ 5300 elements per cycle — sub-millisecond CPU. The trade-off (mutation-coupling between primary panel reader's output and primary-panel reconstruction) is documented in the v3 watch-outs.
`How to apply:` If a future refactor changes `readSharesPanelForTickers` to return non-(ticker, date, shares, close) rows, the primary panel reconstruction must update in lockstep. The repository test `Gap #9 v3: primaryPanel is reconstructed from the same readSharesPanelForTickers data` pins this contract; a divergent refactor would fail that test.

**S95-50. The three-condition v3 gate: `inputs.secondaryPanel != null && inputs.secondaryPanel.length > 0 && inputs.primaryPanel != null` (composite-side) plus repository-side gate `secondaryPanel.length > 0` (drops both panels when empty).** Three independent failure modes, three explicit checks, byte-equal v1/v2 output preserved in all three.
`Why:` Cold-start scenarios that the gate must handle correctly: (a) secondary table absent (probe returns false) ⇒ both panels OMITTED from inputs; (b) secondary table exists but window has zero rows ⇒ both panels OMITTED; (c) secondary panel has rows but zero (ticker, date) intersection with primary ⇒ `compareEtfFlowPanels` returns `totalCompared = 0` ⇒ `snapshot.crossValidation = null` (S95-42 contract from s95 #8). All three branches preserve the v1/v2 byte-equal §13 brief output (per T-OBR-EF-XV-2 negative-guards from s95 #8).
`How to apply:` A future v3.x that wants to render "secondary panel empty / coverage cold-start" as a separate brief sub-section needs to extend `EtfFlowSnapshot` with a new `secondaryCoverage` field — DON'T re-interpret null-crossValidation as "coverage cold-start." The two signals are semantically distinct (S95-41 from s95 #8).

**Carry-overs (still in force):** S95-1..S95-45 (sell-cluster F4 + F4 body URL discovery + F4 per-row recency + ADR-041 + Quartz docs site + EK per-EVENT recency + Gap #9 v2 framework); S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged.

## Open questions

### Newly opened (s95 #9) — none

The slice was fully autonomous within the framework-first scope. All design forks (separate-vs-extended table, probe-then-read vs try/catch, in-process primary reconstruction vs extra CH read, three-branch gate symmetry) had clear three-criterion-test answers and were resolved without operator pause.

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
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- OQ-G2-2 — EDGAR-amendment forensic tooling default (LOW priority, deferred).
- OQ-G9-1 — issuer-specific schema mappers. v3 ships a canonical-CSV substrate; v3.1 needs to decide which issuer adapter to write first. RECOMMEND State Street SPDR (1 family covers 11 of the 21 ETFs).

## Next stage

### Default on `continue` — operator pick

Gap #9 v3 framework is closed end-to-end; the cross-validation chain is now end-to-end live (v1 + v2 + v3). Operator picks the next slice. If they just say "continue" with no context, the recommended default is **Gap #7 v2 13D/13G arc SPEC**. The Gap #9 v3.1 SSGA-SPDR Playwright adapter is the natural "complete the automation" follow-up but it's smaller scope than 13D/13G; either is a reasonable pick.

### Candidate slices (in rough order of "next obvious code-only work")

1. **Gap #7 v2 13D/13G arc SPEC** — RECOMMENDED default. Needs its own RESEARCH → SPEC pass (~3-5 sessions of SPEC work; canon = SEC §13(d) filing thresholds + activist-investor literature). Once SPEC lands, the code arc is comparable in size to EK A1..A5 (~10-15 commits across multiple sessions). The first-cut SPEC slice ships pure-RESEARCH + ADR + test plan, no production code.

2. **Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter** — ~4-5 files / ~250-300 LOC / ~8-10 tests. New `scripts/etf_flow_ssga_spdr_scraper.py` (Playwright + openpyxl). Output target = `data/etf_flow_issuer_csv/`. Drops a daily CSV per SPDR ETF (11 sector ETFs + SPY). Operator's manual workflow disappears for the SSGA-covered subset; iShares + Invesco-QQQ remain manual until follow-up adapters land.

3. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

4. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

5. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

6. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

7. **Extend the Quartz docs site** — operator-pickable refinements (carry-over from s95 #8):
   - Add a home-page `docs/index.md`.
   - Add live dashboard regen to `docs:serve` via chokidar (S95-33 deferral).
   - Promote ADR-040 from `research` → `accepted` once the operator decides on correlation-weighted allocation.
   - Frontmatter extend to teach docs.

8. **Renderer docstring refresh** — `operator_brief_render.ts` line ~2150 still says "v1 does NOT carry per-item recency" — stale post-s95 #7. Light cleanup pass.

### Operator-gated action items (carried + new)

- (NEW s95 #9) Run `npm run migrate:create-etf-shares-outstanding-secondary:apply` once to create the new CH table. Idempotent — re-runs are no-ops. NOT required if operator first runs `npm run etf:flow:issuer-csv:ingest` with `--apply` (Python ingest also bootstraps via `ensure_*` per S95-46).
- (NEW s95 #9) Create `data/etf_flow_issuer_csv/` directory + drop canonical-schema CSVs (header `ticker,date,shares,close`) before running `npm run etf:flow:issuer-csv:ingest`. Empty dir is exit-0 (operator-friendly); the daemon's cross-validation sub-section stays dormant until the first non-empty run.
- (carried) Run `npm run docs:install` once (per clone) — populates `quartz/node_modules/`.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` — UNBLOCKED s95 #3; produces real F4 cluster_buy / cluster_sell rows.
- (carried) Apply the operator-pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED — base table absent in operator's local CH).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3, carry from s94 #8).
- (carried) Push 59 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this slice (s95 #9 — 1 commit `2fd0e94`)

| Path | LOC | Notes |
| --- | --- | --- |
| `scripts/etf_flow_issuer_csv_ingest.py` | +280 (NEW) | Canonical-schema CSV directory ingest with schema validation + WARN-on-parse-failure + table bootstrap + UTF-8 BOM tolerance. Mirrors the v1 yfinance ingest's idempotency contract (ReplacingMergeTree on (ticker, date)). |
| `scripts/migrate_create_etf_shares_outstanding_secondary.ts` | +180 (NEW) | Idempotent CREATE TABLE migration. Dry-run / apply / pre+post checks. DDL byte-pinned identical to Python ingest's `ensure_*` DDL. |
| `scripts/tests/test_etf_flow_issuer_csv_ingest.py` | +260 (NEW) | 19 tests covering T-EFIS-1..T-EFIS-11 (parse / header / type / non-positive / writer / directory walk / partial failure / apply vs dry / bootstrap DDL / REQUIRED_COLUMNS contract). |
| `src/server/etf_flow_repository.ts` | +131 | New `secondaryTable` constructor option, `secondaryTableExists()` probe, `readSecondaryPanelForTickers()` reader, `readInputsForCycle` enrichment threading `primaryPanel + secondaryPanel` IFF non-empty secondary. |
| `scripts/tests/etfFlowRepository.test.ts` | +162 | 12 new tests: readSecondaryPanelForTickers / secondaryTableExists / readInputsForCycle v3 three-branch gate + primary reconstruction contract. |
| `package.json` | +4 | New scripts: `etf:flow:issuer-csv:ingest{,:dry}` + `migrate:create-etf-shares-outstanding-secondary{,:apply}`. |
| `scripts/help.ts` | +2 | Help entries for the two new ingest scripts (migration script's help is auto-collected from its own export). |

### Carried unchanged from s95 #8

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/etf_flow_cross_validation.ts` | s95 #8 LIVE | Pure-fn comparator + severity ladder + summarizer. Unchanged. |
| `src/server/etf_flow.ts` | s95 #8 LIVE | Optional `primaryPanel + secondaryPanel + crossValidation`. Unchanged. |
| `src/server/operator_brief_render.ts` | s95 #8 LIVE | `### Cross-validation anomalies (vs <secondarySourceLabel>)` sub-section, gated on `crossValidation != null && totalCompared > 0`. Unchanged. |

### CH state (new this turn)

- **NEW** `quantlab.etf_shares_outstanding_secondary` — sibling of the primary table. Same engine + ORDER BY; new `source DEFAULT 'issuer-csv'` + `source_file LowCardinality(String) DEFAULT ''` columns. Operator-pending bootstrap via either the migration script OR the Python ingest's first `--apply`.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/etfFlowRepository.test.ts   # 67 pass / 4 CH-unreachable skips (+12 new)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py  # 19 pass (NEW file)
.venv/Scripts/python.exe -m pytest scripts/tests          # 351 pass / 0 fail (+19 net vs s95 #8)
npm test                                                  # TS — 2939 pass / 1 fail / 28 skipped (+12 net vs s95 #8)
                                                          # 1 fail = pre-existing CH-unreachable gicsSectorRepositoryHelper SMP-6
npx tsc --noEmit                                          # 13 baseline errors unchanged
npm run check:help                                        # green
```

## Watch-outs

### NEW from this turn (s95 #9)

- **The secondary panel reader is gated by THREE distinct conditions, not one.** (1) `tickers.length === 0` ⇒ empty short-circuit; (2) `secondaryTableExists()` returns false ⇒ empty result without panel-query CH read; (3) panel query returns zero rows ⇒ empty result. Any of the three preserves v1/v2 byte-equal §13 brief output. A future refactor that conflates the three conditions (e.g. catches a CH error to gate via try/catch on the data SELECT) would log CH errors on fresh-clone deployments. T-EFR-S1..T-EFR-S6 pin the contract.

- **`readInputsForCycle` issues FOUR CH round-trips per call.** Old: 3 (latest-query / panel / max-date) in `Promise.all`. New: 4 (adds the secondary panel reader). Probe-then-read adds a 5th if the table is absent — but the panel query is THEN skipped, so net I/O is 4 reads + 1 probe ≤ 5 round-trips. At once-per-day daemon cadence this is sub-second; a perf-tight loop could memoize the probe but the bug surface isn't worth the savings yet.

- **Primary panel is reconstructed IN-PROCESS** (not via a second CH query). The repository test "primaryPanel is reconstructed from the same readSharesPanelForTickers data" pins this contract. A future refactor that drops fields from `readSharesPanelForTickers`'s output (e.g. removes `close` because some other downstream consumer no longer needs it) would silently break the primary-panel reconstruction. The test catches it.

- **CSV parser rejects shares == 0 OR close == 0 at parse time.** A "ETF closed" day (legitimate liquidation) would silently drop. The v3 universe is the 21 large-cap ETFs; none are at liquidation risk in v3 scope. v3.x extending to thinly-traded ETFs (e.g. specialty crypto-themed) must relax this guard.

- **ReplacingMergeTree(ingested_at) on (ticker, date) — NOT on (ticker, date, source).** Re-ingesting the same (ticker, date) from a DIFFERENT issuer adapter (ssga-spdr after ishares) OVERWRITES the prior row. By design — the comparator's job is primary-vs-secondary not secondary-vs-secondary. A future v3.x that wants cross-validation across multiple secondary sources must redesign the table's ORDER BY (S95-47).

- **The new CH table can be bootstrapped via EITHER the migration OR the Python ingest's first `--apply`.** Both paths use byte-identical DDL. Operator who runs the Python ingest first sees the table appear; operator who runs the migration first sees the migration produce the table cleanly. The two paths cannot drift because both reference the same constant — the Python ingest's `ensure_*` DDL is the source of truth; the migration's `PLANNED_DDL_SECONDARY` constant matches byte-for-byte.

- **UTF-8 BOM tolerance via `utf-8-sig` codec.** Excel-exported CSVs carry a BOM. Without the `-sig` codec, the first column header would read as `﻿ticker` and the schema validator would reject every Excel-exported file with a "missing column" error. T-EFIS-1c pins this.

- **The cross-validation sub-section in the brief now activates AS SOON as the operator drops a CSV.** Until 2026-05-21 the §13 output was byte-equal to v1 across all snapshots; after the first non-empty `etf:flow:issuer-csv:ingest --apply` run, the sub-section starts rendering on every cycle. Existing byte-pinned brief tests (T-OBR-EF-XV-1/2 from s95 #8) survive because they exercise both branches via fixture.

### Carried from s95 #8 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- `EtfFlowSnapshot.crossValidation` is OPTIONAL (`?` syntax). Composer + renderer dispatch on `crossValidation != null && totalCompared > 0`.
- `aggregate_json` blob is a back-compat-safe extensibility point — guard reads with `parsed?.fieldName != null` + try/catch swallows JSON.parse throws.
- `symmetricPctDiff` uses `max(|a|, |b|, ε)` denominator.
- Severity ladder is hard-coded; re-tuning bumps `ETF_FLOW_COMPOSITE_VERSION`.
- `EightKClassifierPerTickerRow.eventsByItemCode` optional (S95-37).
- §8.1 renderer dispatch on `eventsByItemCode != null && length > 0`.
- `docs/dashboard.md` gitignored — never check in (S95-30).
- `docs:serve` does NOT auto-regen dashboard on edits (S95-33).
- Quartz vendored source excluded from root `tsc`.
- `npm run docs:install` once per clone.
- `yield_curve_value` mixed-semantic across ADR-041 cut until backfill.
- `MacroRegimeRowV3.yield_curve_inversion_days_20d` REQUIRED on every row constructor.
- `INPUTS_MISSING_T10Y3M` reuses bit value 64.
- F4 recency uses `acceptedAt` not `transactionDate` (S95-15).
- `Form4InsiderPerTickerRow` carries 2 REQUIRED recency fields.
- Composite source files have `\0` literals (carried).
- §1.4 three-branch order load-bearing.
- Pre-existing `gicsSectorRepositoryHelper SMP-6 EXPLAIN PLAN` failure NOT a regression.

(All earlier s89-s95 #8 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Quartz docs site (carried from s95 #6)

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

### Gap #7 8-K classifier (G2 LIVE; per-row + per-EVENT recency BOTH LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow (v1 LIVE + v2 cross-validation framework LIVE + v3 live secondary panel ingest LIVE)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest                                          # v1 yfinance primary ingest
npm run migrate:create-etf-flow-snapshots:apply
# Gap #9 v3 (NEW s95 #9):
npm run migrate:create-etf-shares-outstanding-secondary:apply    # one-time CH table create (or skip — Python ingest bootstraps)
# Drop canonical-schema CSVs (header: ticker,date,shares,close) in data/etf_flow_issuer_csv/, then:
npm run etf:flow:issuer-csv:ingest:dry                           # validate + count
npm run etf:flow:issuer-csv:ingest                               # write to quantlab.etf_shares_outstanding_secondary
npm run daemon:daily                                             # auto-detects secondary table + populates crossValidation
npm run brief:morning                                            # §13 sub-section renders divergence rows
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2939 pass / 1 fail / 28 skipped (+12 net)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 351 pass (+19 net vs s95 #8)
npx tsx --test scripts/tests/etfFlowRepository.test.ts                         # 67 pass / 4 CH-skips (+12 new)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py  # 19 pass (NEW)
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #9 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 295 emitted from 113 inputs
```

## For the next session — priority order

**Default on `continue`:** operator picks the next slice. If they just say "continue" with no context, the recommended default is **Gap #7 v2 13D/13G arc SPEC** — opens a new arc with its own RESEARCH → SPEC pass. Alternative natural follow-up: **Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter** (~250-300 LOC) which automates the operator's manual CSV drop for the SPDR family.

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6` failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the default-next:

- **Gap #7 v2 13D/13G arc SPEC** (RECOMMENDED default; needs RESEARCH + SPEC pass).
- **Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter** (automates the manual CSV drop).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions** (home-page index.md, live dashboard watcher, teach-doc frontmatter rollout, promote ADR-040 status).
- **Renderer docstring refresh** for the EK section.

**Operator-gated action items (NEW + carried):**

- (NEW s95 #9) `npm run migrate:create-etf-shares-outstanding-secondary:apply` once. Idempotent.
- (NEW s95 #9) Create `data/etf_flow_issuer_csv/` + drop canonical-schema CSVs before first `npm run etf:flow:issuer-csv:ingest --apply`.
- (carried) `npm run docs:install` — ONE-TIME per clone; populates `quartz/node_modules/`.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply `migrate:create-form-4-insider-snapshots:apply` (REQUIRED).
- (carried) Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs.
- (carried) Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
- (carried) Push 59 commits to origin/main (HOLD).
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

**The Gap #9 ARC is now end-to-end LIVE across v1 + v2 + v3.**

- **v1 (s92):** yfinance shares-outstanding + close ingest → primary panel → A2 composite → §13 brief sub-section.
- **v2 (s95 #8):** pure-fn cross-validation comparator + composite wiring + brief render integration. Framework dormant-by-default.
- **v3 (s95 #9 — THIS slice):** canonical-CSV directory ingest + new CH table + repository probe/reader/wiring. Framework activates the moment the operator drops a CSV.

**The §13 cross-validation sub-section is now operator-controllable.** Before s95 #9: dormant (no producer wired). After s95 #9: activates as soon as `data/etf_flow_issuer_csv/` contains at least one row that overlaps with the primary panel. Empty directory ⇒ byte-equal §13 output to v1 (back-compat preserved).

**v3.1 is the natural follow-up.** Adds an SSGA-SPDR XLSX → canonical-CSV Playwright adapter so step 1 of the operator workflow ("drop a CSV") happens automatically. The substrate is already in place — v3.1 is purely an upstream-producer slice.

**Backward compat is preserved on four fronts:**

1. **CH:** Zero DDL change to v1/v2 tables. New `etf_shares_outstanding_secondary` table is OPTIONAL — `secondaryTableExists()` returns false on fresh-clone deployments + `readInputsForCycle` cleanly omits both panels.
2. **Type:** `EtfFlowInputs.primaryPanel + secondaryPanel + secondarySourceLabel` all optional. `EtfFlowSnapshot.crossValidation` optional (from s95 #8).
3. **Render:** Two-condition gate (`!= null && totalCompared > 0`) on the brief sub-section.
4. **Daemon:** Code untouched — `runDaemonEtfFlowEvaluation` delegates to `readInputsForCycle`; the repository's enrichment is transparent.

**Parallel-tracks posture continues.** s95 #9 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2939 pass + 12 new TS tests; pytest 351 pass + 19 new Python tests. 1 pre-existing CH-unreachable fail is NOT a regression.

**The chain through s95 #9:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
S95 #3: form 4 ingest XML body URL discovery (HOTFIX)   ✓ committed (831b1b0)
S95 #4: gap #7 v2 per-row recency (F4 side)             ✓ committed (b3d63a2)
S95 #5: ADR-041 implementation                          ✓ committed (4406674)
S95 #6: Quartz docs site (5 commits)                    ✓ committed (437332b → eac2561)
S95 #7: gap #7 v2 per-EVENT EK recency                  ✓ committed (5a9ed8e)
        — Gap #7 v2 EK arc FULLY CLOSED end-to-end
S95 #8: gap #9 v2 ETF.com/issuer-CSV xv framework       ✓ committed (90fb0c3)
        — pure-fn comparator + composite wiring +
          back-compat render + 17 new tests
S95 #9: gap #9 v3 issuer-CSV live secondary panel       ✓ committed (2fd0e94)
        — Python ingest + new CH migration +
          repository probe/reader/wiring + 31 new tests
        — GAP #9 ARC FULLY CLOSED end-to-end (v1+v2+v3)
S95 #9 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator picks. Recommended default if
                  operator says "continue" without context:
                  Gap #7 v2 13D/13G arc SPEC.
                  Alternative: Gap #9 v3.1 SSGA-SPDR
                  Playwright XLSX → canonical-CSV adapter
                  (~250-300 LOC).
  → background: brief §13 cross-validation sub-section
                activates as soon as operator drops a CSV
                in data/etf_flow_issuer_csv/. Until then,
                daily daemon runs emit v1-byte-equal §13
                output. Framework is ready-to-receive.
```
