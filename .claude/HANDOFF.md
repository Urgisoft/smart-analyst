# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 85 — **market-cycle-position Phase A 5/6 units shipped (A1+A2+A3+A4+A5).** A5 = morning-brief cycle-position panel: new `BriefCyclePositionSection` interface in operator_brief_render.ts + render function (section #7, appended for byte-equal protection); `buildCyclePositionSection` builder + default fetcher (`fetchLatestCyclePositionFromCH`) + `fetchLatestCyclePosition` injection point in operator_brief.ts; 12 new tests (7 render + 5 compose-wiring). **End-to-end live brief render verified: `npm run brief:morning` now displays cycle position (EARLY, score 0.720, 13.3% recession prob, per-bucket contributions) against the live data from the A4 daemon-hook smoke.** **Tests: 1488/0/6 (+12 over A4 baseline of 1476; +96 over s84). tsc: 13-error baseline. check:help green.** Phase A remaining: A6 (dashboard React panel). Phase A's substrate chain (FRED ingest → composite → CH persistence → daemon hook → operator-visible brief panel) is fully operational. C-12 Phase A FULLY CLOSED from s84; C-12 Phase B (AlpacaAdapter) PAUSED INDEFINITELY at operator direction.)

## What this session delivered

Session 85 (this beat): operator pivoted away from C-12 Phase B onboarding ("no live trading hook up yet. please move to gaps integration"). Triaged the 13 gaps into buckets (5 buildable today / 7 blocked on data subscriptions / 1 already done). Operator selected market-cycle-position as the first gap. Wrote the SPEC at [docs/specs/market-cycle-position.md](../docs/specs/market-cycle-position.md) — 12 sections covering scope, decisions, component diagram, phased plan, schema, function signatures, composite weighting, test plan, watch-outs, open questions. **3 open questions block Phase A code start; operator must answer before code begins.**

Session 84 (carried, this same dated session): executed C-12 Phase A end-to-end per the SPEC at [docs/specs/live-trade-broker-integration.md](../docs/specs/live-trade-broker-integration.md) §3.1 (units 1-6). All six units shipped autonomously after operator green-light. One PUSHBACK applied mid-flow: the SPEC's blanket "s82-pattern: dry-run + apply + drop-backup, 19 tests" for the migration script was wrong — the underlying CH operation (ALTER TABLE ADD COLUMN with DEFAULT) is fundamentally simpler than s82's mid-tuple ORDER BY change, so the migration ships as dry-run + apply only (no drop-backup, no row-count parity) with 14 tests instead of 19. Documented in the script docstring.

### Verdict

Phase A is the foundation everything else routes through. With it shipped:

- Fee math is now a pure function (replacing the 0.5% hardcoded sizer reserve at the next code-touch).
- The BrokerAdapter interface is the contract Phase B's AlpacaAdapter implements against — that work is now purely "implement this".
- PaperBrokerAdapter is a working drop-in replacement for the current synthetic paper logic, with idempotency contract honored.
- `--source=live` is wired but FAIL-LOUD — operator cannot accidentally flip the daemon to live mode in this session's state.
- The schema migration is dry-run verified against the live CH; ready for `:apply` when you green-light it.

### Headline result table

| Element | Status |
| --- | --- |
| **Unit 1 — [src/server/fee_model.ts](../src/server/fee_model.ts)** | **✓ shipped — 15 tests; quoteFees pure function; Alpaca equity schedule pinned (2026-05)** |
| **Unit 2 — [src/server/brokers/types.ts](../src/server/brokers/types.ts)** | **✓ shipped — types only; BrokerAdapter contract + Place/Order/Status/Account/Position shapes** |
| **Unit 3 — [src/server/brokers/paper.ts](../src/server/brokers/paper.ts)** | **✓ shipped — 19 tests; idempotent on clientOrderId; conservative-fill-at-limit rule** |
| **Unit 4 — [scripts/migrate_strategies_add_asset_class.ts](../scripts/migrate_strategies_add_asset_class.ts)** | **✓ shipped — 14 tests; 2 npm aliases; dry-run verified green against live CH** |
| **Unit 5 — StrategyBundle.assetClass plumbing** | **✓ shipped — strategiesHasAssetClassColumn probe + 6 tests; s81-pattern graceful-degrade** |
| **Unit 6 — `--source=paper\|live` daemon flag** | **✓ shipped — fail-loud refusal on `live` verified live; 5 hardcoded 'paper' callsites replaced with SOURCE** |
| **Phase A schema migration APPLY** | **✓ APPLIED in 23ms; post-check verified; re-run dry-run reports already-migrated no-op** |
| All s73-s83 work | ✓ preserved unchanged |
| Tests | **1392 pass / 0 fail / 6 skipped** (+54 over s83 baseline; 0 regressions) |
| npx tsc --noEmit | 13 errors (unchanged baseline) |
| npm run check:help | ✓ green |

### Test baseline (post-s84 Phase A)

```text
npm test                       1392 pass / 0 fail / 6 skipped   (+54 over s83)
npx tsc --noEmit               13 errors (IDENTICAL to baseline)
npm run check:help             green
.venv/Scripts/python.exe -m pytest scripts/tests   164/164  (Python untouched this session)
```

### Concrete state changes (s84 Phase A full session)

**NEW files:**

1. **[src/server/fee_model.ts](../src/server/fee_model.ts)** — ~115 lines. `quoteFees` pure function; `ALPACA_EQUITY_FEE_SCHEDULE` constant (SEC fee rate, TAF rate + cap, $0 commission) pinned with byte-pin tests.
2. **[src/server/brokers/types.ts](../src/server/brokers/types.ts)** — ~125 lines. Types-only file. Exports `BrokerAdapter`, `PlaceOrderInput`, `OrderHandle`, `OrderStatus`, `AccountSummary`, `BrokerPosition`, `BrokerVenue`.
3. **[src/server/brokers/paper.ts](../src/server/brokers/paper.ts)** — ~150 lines. `PaperBrokerAdapter` class. In-memory state per adapter instance. Idempotency by clientOrderId. Conservative-fill-at-limit rule (paper never flatters live).
4. **[scripts/migrate_strategies_add_asset_class.ts](../scripts/migrate_strategies_add_asset_class.ts)** — ~165 lines. `ALTER TABLE quantlab.strategies ADD COLUMN asset_class LowCardinality(String) DEFAULT 'equity' AFTER family`. Pre-check + post-check + dry-run. Two modes (dry-run, --apply); no drop-backup needed.
5. **[scripts/tests/feeModel.test.ts](../scripts/tests/feeModel.test.ts)** — 15 tests.
6. **[scripts/tests/paperBrokerAdapter.test.ts](../scripts/tests/paperBrokerAdapter.test.ts)** — 19 tests.
7. **[scripts/tests/migrateStrategiesAddAssetClass.test.ts](../scripts/tests/migrateStrategiesAddAssetClass.test.ts)** — 14 tests including 2 EXPLAIN PLAN grammar checks against live CH (s83 pattern).
8. **[scripts/tests/clickhouseStrategiesAssetClass.test.ts](../scripts/tests/clickhouseStrategiesAssetClass.test.ts)** — 6 tests including 1 EXPLAIN PLAN check + 1 live integration test (skip-if-CH-down).

**EDITED files:**

1. **[src/server/clickhouse.ts](../src/server/clickhouse.ts)** — `StrategyBundle.assetClass?` field added. New `strategiesHasAssetClassColumn()` probe export. `fetchStrategies` reads asset_class conditionally (synthesizes 'equity' pre-migration). `upsertStrategy` includes asset_class conditionally + loud-fails on `assetClass='crypto'` if column missing.
2. **[scripts/daily_signal_daemon.ts](../scripts/daily_signal_daemon.ts)** — `--source=paper|live` flag with input validation. `SOURCE` constant replaces 5 hardcoded `source: 'paper'` callsites at lines ~1006, ~1029, ~1089, ~1309, ~1472. Preflight check refuses `--source=live` (no live adapter wired in Phase A).
3. **[package.json](../package.json)** — 2 new npm aliases: `migrate:strategies-add-asset-class` (dry-run) + `:apply`.
4. **[.claude/HANDOFF.md](./HANDOFF.md)** — This rewrite.

### What is NOT changed this session

- **No CH schema changes have been APPLIED.** The migration script is shipped and dry-run-verified, but the destructive `--apply` step has not run. Pre-Phase-A CH state remains unchanged.
- **No real-money flow has been wired.** `--source=live` is a fail-loud refusal in Phase A.
- **No CONFIG_VERSION bump.**
- **No daemon-default flips.** Default source is still `'paper'`; default behavior unchanged.
- **No AlpacaAdapter exists yet.** Phase B work.

## Where we are

The Phase A code is complete and tests are green; the only step left in Phase A is the operator-gated schema migration apply. After that, Phase B can begin (AlpacaAdapter implementation) once you've onboarded the Alpaca account.

| Bucket | Status |
| --- | --- |
| All s73-s83 lock-ins | ✓ as documented in prior handoffs |
| **C-12 Phase A — code (6 units + 54 tests)** | **✓ s84 — see headline table above** |
| **C-12 Phase A — schema migration APPLY** | **✓ s84 — applied to production CH in 23ms; post-check verified; idempotent re-run** |
| **C-12 Phase B — AlpacaAdapter** | **⏸ s85 INDEFINITELY PAUSED at operator direction ("no live trading hook up yet"). Blocks on operator decision to resume + Alpaca onboarding.** |
| C-12 Phase C — daemon wiring + fill reconciliation | ⏸ paused via Phase B pause |
| C-12 Phase D — morning brief paper+live split | ⏸ paused via Phase B pause |
| C-12 Phase E — real-money flip | ⏸ paused via Phase B pause (was already blocked on paper-trading verdict regardless) |
| **market-cycle-position gap — SPEC** | **✓ s85 — [docs/specs/market-cycle-position.md](../docs/specs/market-cycle-position.md); revised post-PUSHBACK for backtest-not-calendar validation** |
| **market-cycle-position Phase A1 — FRED ingest extension** | **✓ s85 — 9 default series (T10Y3M primary)** |
| **market-cycle-position Phase A2 — composite pure function** | **✓ s85 — 42 tests; Estrella-Mishkin 1998 logit; SPEC §7 mappings** |
| **market-cycle-position Phase A3 — CH migration script** | **✓ s85 — 17 tests; dry-run GREEN against live CH; npm aliases registered** |
| **market-cycle-position Phase A3 — migration APPLY** | **✓ s85 — applied in 20ms; post-check 18/18 columns; quantlab.cycle_position_snapshots live (0 rows, awaiting A4 daemon writes)** |
| **market-cycle-position Phase A3 — FRED backfill** | **✓ s85 — 9 series, 41,521 total rows ingested. Coverage 1996-present except HY OAS (~3y FRED limit confirmed; composite handles gracefully via missing-input degradation)** |
| **market-cycle-position Phase A4 — repository + daemon hook** | **✓ s85 — src/server/cycle_position_repository.ts + 25 tests; daemon hook wired at scripts/daily_signal_daemon.ts step 1d (after macro-classify-v3, non-fatal); end-to-end smoke against live CH GREEN (first snapshot: score=0.720, phase=early, recession_prob=13.3%)** |
| **market-cycle-position Phase A5 — morning-brief panel** | **✓ s85 — BriefCyclePositionSection + render + buildCyclePositionSection + 12 new tests; `npm run brief:morning` shows section #7 live against the A4 snapshot** |
| **market-cycle-position Phase A6 — dashboard React panel** | **☐ next beat — last Phase A unit; depends on A4 (complete)** |
| **market-cycle-position Phase B validation** | **☐ ~1 week, after Phase A fully closes** |
| Strategy-tagged dd_state (s80-s82) | ✓ shipped |
| FakeClickHouse grammar-validation gap (drawdown repo) | ✓ s83 |
| FakeClickHouse grammar-validation sweep (other 5 test files) | ☐ deferred |
| CBOE DataShop subscription (2019-present coverage) | ☐ deferred — Pejman-decision (paid) |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — ~2026-08-29 earliest |
| 12 Phase 9+ gap inventory items | ☐ PARTIALLY UNFROZEN at s85 operator direction — market-cycle-position opened; other 12 still gated on subscriptions / priority |

## Decisions locked in

### Session 84 (this session)

**S84-1. Phase A migration uses dry-run + apply only — NOT the s82 CREATE-NEW + RENAME + drop-backup pattern.** The s82 ceremony existed because ORDER BY was changing mid-tuple; CH only allows APPEND to MODIFY ORDER BY. This Phase A migration only ADDS a non-key column with DEFAULT — CH supports this atomically via plain `ALTER TABLE ADD COLUMN`. No backup table needed.
`Why:` Vector Core "fewer features, robustly" applied to migration tooling. Copying the s82 ceremony when the underlying CH operation is fundamentally simpler is exactly the kind of overhead the rule warns against. Documented in the script's docstring.
`How to apply:` future column-add migrations on existing tables should follow the s84 pattern (dry-run + apply); future migrations that need ORDER BY changes (or other operations CH cannot ALTER in-place) should follow the s82 pattern (CREATE-NEW + RENAME + drop-backup).

**S84-2. `strategiesHasAssetClassColumn` probe is module-level + no caching.** Each `fetchStrategies` / `upsertStrategy` call probes `system.columns`. This is wasteful by some measures (1 extra query per call) but defensible: (a) the calls are infrequent (server route handlers + occasional daemon writes), (b) caching introduces stale-cache risk if the migration applies mid-process, (c) the probe is a tiny indexed query. If a performance issue surfaces, add a one-time cache then; not before.
`Why:` no-caching matches the s81 `drawdownStateHasBundleIdColumn` pattern + avoids stale-cache landmine.
`How to apply:` Phase C may add caching if profiling shows it's the bottleneck. Until then, the simple form is the right form.

**S84-3. `upsertStrategy` loud-fails on `assetClass='crypto'` if the migration hasn't run.** Silent column-drop would persist a crypto strategy with the CH-side DEFAULT 'equity', producing wrong-routing in the C-12 router. Loud-fail surfaces the operator error immediately.
`Why:` per SPEC §3 router behavior — wrong-routing on real money is the worst failure mode in the C-12 arc. Phase A defensive walls are cheap; rely on them.
`How to apply:` any future `upsertStrategy` caller passing `assetClass='crypto'` must run the migration first. The error message names the npm alias to fix it.

**S84-4. `--source` flag refuses `live` outright in Phase A — does NOT silently degrade to paper.** Per SPEC §3.1 unit 6. Silent fall-back means the operator thinks they're trading live while the daemon synthesises fills — the worst-of-both-worlds outcome. Refusing forces explicit operator action when Phase B+ wire the adapter.
`Why:` operator surprise is the highest-cost failure mode in this arc.
`How to apply:` Phase C removes the refusal block; Phase C unit on the daemon code adds the BrokerAdapter resolver instead.

### Session 83 (carried)

S83-1 through S83-7 preserved; see prior handoff in git history (commit prior to this one).

### Carried locked decisions (sessions 41-82)

All sessions 41-82 lock-ins preserved unchanged.

## Open questions

### HIGH (Pejman decisions pending — block subsequent phases)

1. ~~**market-cycle-position SPEC §11**~~ — **ALL LOCKED s85.** Q1 skip ISM in v1; Q2 both score + label; Q3 bundle dashboard into Phase A. Plus an operator PUSHBACK on Q4 (90-day window): collapsed to ~1 week of backtest validation against NBER instead of calendar observation. SPEC updated. **Phase A is UNBLOCKED.**

2. **C-12 Phase B resume** (when ready): Alpaca account onboarding. INDEFINITELY PAUSED at s85 operator direction; no rush.
   - Create Alpaca paper-trading account at app.alpaca.markets.
   - Generate API key + secret.
   - Decide cash vs. margin account (recommendation in [docs/teach/2026-05-19-alpaca-onboarding.md](../docs/teach/2026-05-19-alpaca-onboarding.md): cash).
   - Set `ALPACA_API_KEY` + `ALPACA_API_SECRET` + `ALPACA_BASE_URL` env vars.

3. **CBOE DataShop subscription decision** — carried; Pejman directed "we'll decide later." Independent of C-12 and cycle-position.

### CARRIED HIGH (unchanged from s73-s83)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription.
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- 12 Phase 9+ gap inventory items — FROZEN per s63 directive until 2026-06-29 OR until C-12 ships.

### Closed this session

- ~~C-12 Phase A Unit 1 — fee_model~~ — s84.
- ~~C-12 Phase A Unit 2 — BrokerAdapter interface~~ — s84.
- ~~C-12 Phase A Unit 3 — PaperBrokerAdapter~~ — s84.
- ~~C-12 Phase A Unit 4 — strategies asset_class migration script~~ — s84 (code shipped; apply deferred).
- ~~C-12 Phase A Unit 5 — StrategyBundle.assetClass plumbing~~ — s84.
- ~~C-12 Phase A Unit 6 — --source CLI flag + fail-loud~~ — s84.
- ~~Migration-pattern choice (s82-pattern vs simpler)~~ — s84 (S84-1 locked).
- ~~C-12 Phase A schema migration apply~~ — s84 close (23ms; post-check verified).

## Next stage

### Immediate next step

**Phase A6 — dashboard React panel** (last Phase A unit). New `src/components/CyclePositionPanel.tsx` aligned with the existing dashboard structure: 365-day score trend + per-bucket contribution stack + (optional) NBER recession bands overlay. Biggest single Phase A unit; needs a survey of the existing dashboard route + component patterns before code starts. Autonomous-safe.

### Next session work after A6

- **Phase B**: backtest validation against NBER + independence test against `phase1_v3` (~1 week). Operates against historical FRED data — composite already supports this via the existing repository.

### Daemon writes snapshots automatically; brief renders them

Every `npm run daemon:daily` cycle (without `--no-macro` / `--dry-run`) computes + writes one snapshot row to `quantlab.cycle_position_snapshots` after the macro-regime classify step. Every `npm run brief:morning` displays the latest snapshot as section #7. Verified live this session against today's FRED data.

**C-12 Phase B is paused, not deleted.** When the operator chooses to resume, the SPEC is intact and Phase A's substrate is ready.

### Alternative dev slice (lower priority — deferred from earlier in s83)

Adopt `assertCHGrammar` in the other 5 FakeClickHouse-using test files. Mechanical, ~30-60min. Helper is ready.

### Bucket 2 — FROZEN until 2026-06-29 per s63 directive

12 Phase 9+ gaps + symbol-analysis follow-on. Operator s83 direction: pursue AFTER C-12 ships AND data-subscription decisions made.

### Track A — background

Daily `npm run daemon:daily` continues unchanged. The new `--source=paper` is the default (omit the flag or pass it explicitly — same behavior). Per-strategy drawdown rows continue writing every cycle.

## Files / code state

### NEW this session

- [src/server/fee_model.ts](../src/server/fee_model.ts) — Unit 1.
- [src/server/brokers/types.ts](../src/server/brokers/types.ts) — Unit 2.
- [src/server/brokers/paper.ts](../src/server/brokers/paper.ts) — Unit 3.
- [scripts/migrate_strategies_add_asset_class.ts](../scripts/migrate_strategies_add_asset_class.ts) — Unit 4.
- [scripts/tests/feeModel.test.ts](../scripts/tests/feeModel.test.ts) — Unit 1 tests.
- [scripts/tests/paperBrokerAdapter.test.ts](../scripts/tests/paperBrokerAdapter.test.ts) — Unit 3 tests.
- [scripts/tests/migrateStrategiesAddAssetClass.test.ts](../scripts/tests/migrateStrategiesAddAssetClass.test.ts) — Unit 4 tests.
- [scripts/tests/clickhouseStrategiesAssetClass.test.ts](../scripts/tests/clickhouseStrategiesAssetClass.test.ts) — Unit 5 tests.

### EDITED this session

- [src/server/clickhouse.ts](../src/server/clickhouse.ts) — Unit 5: StrategyBundle.assetClass field + probe export + read/write plumbing.
- [scripts/daily_signal_daemon.ts](../scripts/daily_signal_daemon.ts) — Unit 6: --source flag + 5 callsite replacements.
- [package.json](../package.json) — Unit 4: 2 new npm aliases.
- [.claude/HANDOFF.md](./HANDOFF.md) — This rewrite.

### Working-tree status (post-s84 Phase A close)

```text
M docs/obsidian/.obsidian/workspace.json   (editor state — ignore)
A scripts/tests/_chGrammarCheck.ts                              (s83)
M scripts/tests/drawdownStateRepository.test.ts                 (s83)
A docs/specs/live-trade-broker-integration.md                   (s83 SPEC)
A src/server/fee_model.ts                                       (s84 Unit 1)
A src/server/brokers/types.ts                                   (s84 Unit 2)
A src/server/brokers/paper.ts                                   (s84 Unit 3)
A scripts/migrate_strategies_add_asset_class.ts                 (s84 Unit 4)
A scripts/tests/feeModel.test.ts                                (s84 Unit 1 tests)
A scripts/tests/paperBrokerAdapter.test.ts                      (s84 Unit 3 tests)
A scripts/tests/migrateStrategiesAddAssetClass.test.ts          (s84 Unit 4 tests)
A scripts/tests/clickhouseStrategiesAssetClass.test.ts          (s84 Unit 5 tests)
M src/server/clickhouse.ts                                      (s84 Unit 5)
M scripts/daily_signal_daemon.ts                                (s84 Unit 6)
M package.json                                                  (s84 Unit 4 aliases)
M .claude/HANDOFF.md                                            (this rewrite)
```

Two sessions of uncommitted work (s83 + s84). When you're ready, commit candidates:

- one commit for s83 (grammar check + SPEC)
- one commit per Phase A unit (or a single Phase A commit)

### CH state

| Table | Status |
| --- | --- |
| `quantlab.macro_regimes` (phase1_v3) | 4,622 rows; distribution `{131,359,1473,2659}` |
| `quantlab.drawdown_state_history` | Post-Phase-C TERMINAL (s82); per-strategy rows accumulating |
| **`quantlab.strategies`** | **POST-Phase-A: `asset_class LowCardinality(String) DEFAULT 'equity'` column PRESENT. Applied 2026-05-19 in 23ms. Existing rows resolve to 'equity' via DEFAULT.** |
| All other tables | unchanged |

### Tests (post-s84 Phase A close)

```text
npm test                       1392 pass / 0 fail / 6 skipped   (+54 over s83, +59 over s82)
.venv/Scripts/python.exe -m pytest scripts/tests   164/164
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             green
```

## Watch-outs

### NEW from C-12 Phase A (s84)

- **The Phase A migration is APPLIED.** `quantlab.strategies` now has the `asset_class` column with DEFAULT 'equity'. The `strategiesHasAssetClassColumn` probe now returns true; `fetchStrategies` reads the real column (not the synthesized fallback); `upsertStrategy` includes asset_class in inserts. The `loud-fail on crypto without column` defensive wall is now passive (column is present); it remains in code as a defense against accidental future column removal.

- **`--source=live` is REFUSED in Phase A.** The daemon's preflight will exit(1) with a clear message if anyone passes `--source=live`. This is INTENDED behavior for Phase A; Phase C removes the refusal once the AlpacaAdapter wires in. Do not assume `--source=live` is broken — it's deliberately walled off.

- **Fee schedule values are 2026-05.** SEC + TAF rates change annually. The byte-pin tests in `feeModel.test.ts` will catch accidental edits, but the values themselves should be re-verified against Alpaca's docs before any Phase E real-money flip. SPEC §7 item 2.

- **PaperBrokerAdapter state is in-memory + per-process.** Pending limit orders evaporate on daemon restart. Acceptable for paper (the actual journal lives in `quantlab.live_trades`); Phase B's AlpacaAdapter inherits durability from the real broker.

- **The conservative-fill-at-limit rule in PaperBrokerAdapter biases paper PnL DOWN compared to a market-following limit fill.** This is the INTENDED bias — paper should never flatter live. Don't "fix" this thinking it's a bug; it's a deliberate Vector Core posture (paper is a lower bound on live performance, not an estimator).

### NEW from C-12 SPEC (carried)

- **Alpaca paper sandbox ≠ Vector Core `source='paper'`.** Two orthogonal concepts; conflating them in code/docs is the biggest landmine. The Alpaca env var is `ALPACA_BASE_URL`; the Vector Core flag is `--source`.

- **`clientOrderId` idempotency is load-bearing.** PaperBrokerAdapter honors it (tested in s84); Phase B's AlpacaAdapter must too. Test for this explicitly in Phase B.

- **Fill price ≠ signal-time price.** Slippage is real; sizer doesn't account for it yet. Phase C+ concern.

### NEW from s83 beat 1 (drawdown grammar checks) — carried

- Grammar-validation layer depends on local CH being reachable; watch for skip-count drift in `npm test`.
- 5 other FakeClickHouse-using test files NOT yet covered by `assertCHGrammar`.

### CARRIED load-bearing (unchanged from sessions 41-83)

All session 41-83 watch-outs preserved unchanged.

## Pre-loaded operational reminders

### Phase A migration aliases (NEW this session)

```text
npm run migrate:strategies-add-asset-class             # dry-run; ALREADY-MIGRATED no-op verdict (column present)
npm run migrate:strategies-add-asset-class:apply       # ALREADY APPLIED — re-run no-ops via pre-check verdict
```

### Day-glance trio (UNCHANGED but note --source default)

```text
npm run daemon:daily                                   # default source=paper (--source=live REFUSED in Phase A)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — 1392 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run lint                                                                   # ⚠ Fails at tsc step (13 errors)
npm run check:help                                                             # FULLY GREEN
```

### Phase C drawdown migration aliases (all terminal-state from s82)

```text
npm run migrate:drawdown-state-history-per-strategy                 # dry-run (terminal state)
npm run migrate:drawdown-state-history-per-strategy:apply           # already applied + drop-backup done
npm run migrate:drawdown-state-history-per-strategy:drop-backup     # already executed — re-run no-ops
```

## For the next session — priority order

**Pejman decisions needed BEFORE Phase B starts:**

- Alpaca account creation + API keys + cash-vs-margin choice. Runbook lands with Phase B implementation. This is now the SOLE blocker for Phase B.

**Independent of C-12:**

- CBOE DataShop subscription — Pejman call.

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Background:**

- `npm run daemon:daily` continues unchanged.

**DO NOT auto-open without operator green-light:**

- Phase B AlpacaAdapter (blocks on Alpaca onboarding).
- All carried items from s73-s83 handoff.

## Important framing for the next chat

Session 84 closed C-12 Phase A FULLY (6/6 code units + migration applied to production CH in 23ms). The post-apply state: `quantlab.strategies.asset_class` column present with DEFAULT 'equity', test baseline 1392/0/6 unchanged, tsc 13 baseline unchanged. Phase B (AlpacaAdapter) is now the sole next arc, blocked only on operator Alpaca-account onboarding.

**Operator framing (s83 close, still current):** stop accumulating gaps + symbol-analysis features until live-trade plumbing is finished. Phase A is now done in code; Phase B-E remain. The 12 frozen gaps stay frozen until C-12 ships AND data-subscription questions are resolved.

The chain through s84:

```text
ALL S41-S82 WORK              ✓ as documented
S83 BEAT 1                    ✓ FakeClickHouse grammar helper + 5 regression covers
S83 BEAT 2 — AUDIT            ✓ live-trade pipeline punch list
S83 BEAT 2 — DECISIONS        ✓ equity-first / Alpaca / cheap-branch
S83 BEAT 2 — SPEC             ✓ docs/specs/live-trade-broker-integration.md
S84 Unit 1: fee_model         ✓ 15 tests
S84 Unit 2: brokers/types     ✓ types only
S84 Unit 3: brokers/paper     ✓ 19 tests; idempotency contract verified
S84 Unit 4: migration script  ✓ 14 tests; dry-run verified GREEN against live CH
S84 Unit 5: assetClass plumb  ✓ 6 tests; probe + read/write conditional
S84 Unit 6: --source flag     ✓ refusal verified live; 5 callsites replaced
S84 npm test                  ✓ 1392/0/6 (+54, 0 regressions)
S84 npx tsc --noEmit          ✓ 13 errors (unchanged baseline)
S84 MIGRATION APPLY           ✓ 23ms; post-check verified; quantlab.strategies.asset_class column LIVE
S84 HANDOFF                   ✓ this document
  → next: Phase B AlpacaAdapter (blocks ONLY on Alpaca account onboarding)
  → background: daemon continues writing per-strategy rows
```

**Parallel-tracks posture continues.** No hard deadlines on C-12. The real-money flip itself (Phase E) remains gated on paper-trading verdict + ADR sign-off; C-12 shipping does NOT change that gate, it only builds the substrate. Test baseline 1392/0/6.
