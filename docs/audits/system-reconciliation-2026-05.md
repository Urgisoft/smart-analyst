---
status: review-gate
phase: phase 9+
last_updated: 2026-05-23
owner: vector-core + pejman (review gate)
type: audit
slice_id: audit-system-reconciliation-2026-05
---

# System Reconciliation Audit — 2026-05-23

**Trigger:** Operator directive in session 96 #12 mandating a one-time baseline
reconciliation before the ADR-044 standing-health monitor can be trusted.

**Status:** REVIEW GATE. This document is a survey, not a fix list. The operator
reviews + classifies each gap as `wire-it / remove-it / fix-it / leave-it`. The
assistant executes after operator sign-off — **not before**.

**Methodology:** four parallel read-only subagents inventoried scripts, CH
tables, UI panels + routes, scheduled jobs. The assistant resolved inter-agent
disagreements via direct file reads and produced this synthesis.

**Scope coverage:** 341 script files / 54 CH tables / 8 React panels + 24
express routes / 1 daemon orchestrator + 1 watcher + 0 GitHub Actions.

---

## TL;DR — executive summary

| Severity | Count | Examples |
| --- | --- | --- |
| **Tier-2 correctness (operator review required)** | 9 | 5 SEC EDGAR ingests have NO daemon hook → snapshots evaluate stale data silently; FINRA + CBOE + ETF v1 primary same pattern; Stooq apikey gate broken since 2026-05-09 |
| **Tier-1 mechanical (assistant can auto-fix after review)** | 6 | `/#/etf-flow` primary-table guard missing (helper exists, never called); NaN/Inf formatter hygiene in etf-flow + paper-trading panels; Quartz vendor fork drift; 6 operator-pending CH migrations |
| **Documentation / cleanup** | 4 | `cross_asset_signals_repository.ts` misnamed (writes to `cross_asset_snapshots`); 78,399 zero-trade sentinels in `bt_runs_regime`; orphan candidates need confirmation; vendor fork upgrade procedure missing |
| **Confirmed clean** | — | Zero unintentional duplicate tables; zero abandoned migrations; zero undiscoverable panels; all routes have catch blocks; mock-candle silent fallback already removed |

**The biggest unflagged finding:** five SEC EDGAR + FINRA + CBOE ingests are
purely operator-cadence. Their downstream daemon evaluators (steps 1h/1i/1k/1l/1m)
run daily on whatever rows happen to exist. If the operator forgets the
operator-cadence ingest for two weeks, the morning brief silently surfaces a
"composite verdict" computed against two-week-old data with no staleness
indicator on the panel. **This is the standing-health mandate's single most
load-bearing automation gap.**

---

## §1 — Inventory

### §1.1 Scripts (341 files)

| Bucket | Count | Notes |
| --- | --- | --- |
| Main npm-callable scripts | ~80 | The active surface — ingests, daemons, dashboards, scorers |
| One-shot migrations (`migrate_*.ts`) | 29 | All have npm entries; zero abandoned |
| Diagnostic `_`-prefixed scripts | ~50 | Operator-only forensic / tuning tools; not called by daemons |
| Adapters + helpers (`scripts/adapters/`) | 5 | Shared HTTP/source modules |
| `src/server/` runtime modules | ~55 | Repositories, dashboards, daemon hooks, evaluators |
| Test files (`*.test.ts`, `test_*.py`) | ~110 | Covers core logic comprehensively |

**Potential orphans (no npm caller, operator-manually-callable):**
1. `scripts/sharadar_backfill.py` — paid Sharadar API; data-source policy
   blocks paid subscriptions. **Recommended action: REMOVE** unless operator
   intends to subscribe.
2. `scripts/import_botdb_candles.py` — historical archive import; one-shot
   migration likely completed. **Recommended action: confirm completed →
   REMOVE if so.**
3. `scripts/train_meta_label.py` — ADR-017 meta-labeling training; deferred
   per HANDOFF (≥4 weeks). **Recommended action: LEAVE** until ADR-017
   resumes.
4. `scripts/walk_forward_cluster.py` — operator-cadence diagnostics tool.
   **Recommended action: LEAVE.**

**Already-existing health-relevant scripts:**
- `scripts/_morning_check.ts` — baseline for the formal `health_check.ts` to
  extend, not replace.
- `scripts/_data_quality.ts` — scans candles for NaN/Infinity/negative
  values. The standing health monitor will orchestrate this + similar probes.

### §1.2 ClickHouse tables (54 total in `quantlab.*`)

**Migration-managed (29 migrations covering ~30 tables — some create
multiple in one shot, e.g. `migrate_create_etf_flow_snapshots.ts` creates
both `etf_shares_outstanding` + `etf_flow_snapshots`):**

| Table | Source | Producer | Consumer |
| --- | --- | --- | --- |
| `bt_runs_slices` | `migrate_pbo_schema.ts` | `batch_backtest.ts` | brief diagnostics |
| `cell_weights_history` | `migrate_cell_weights_history.ts` | daemon per-cell loop | `per_cell_capital.ts` ratchet lookup |
| `cross_asset_snapshots` | `migrate_create_cross_asset_snapshots.ts` | daemon step 1g | brief + `cross_asset_signals_repository.ts` (NB: misleading repo name) |
| `cycle_position_snapshots` | `migrate_create_cycle_position_snapshots.ts` | daemon step 1d | `cycle_position_dashboard.ts` |
| `drawdown_state_history` | `migrate_drawdown_state_history.ts` | daemon drawdown-eval | brief drawdown audit |
| `eight_k_classifier_snapshots` | `migrate_create_eight_k_classifier_snapshots.ts` (+ALTERs) | daemon step 1k | brief §EK |
| `eight_k_events` | `migrate_create_eight_k_events.ts` | `sec_edgar_8k_event_ingest.py` | EK composite evaluator |
| `etf_flow_snapshots` | `migrate_create_etf_flow_snapshots.ts` | daemon step 1j | brief §13 |
| `etf_shares_outstanding` | `migrate_create_etf_flow_snapshots.ts` (same migration) | `etf_flow_ingest.py` | `etf_flow_repository.ts` |
| `etf_shares_outstanding_secondary` | `migrate_create_etf_shares_outstanding_secondary.ts` | `etf_flow_issuer_csv_ingest.py` | cross-validation panel |
| `executive_departure_snapshots` | `migrate_create_executive_departure_snapshots.ts` (+ALTER) | daemon step 1i | brief §exec-departure |
| `form_4_insider_snapshots` | `migrate_create_form_4_insider_snapshots.ts` (+2 ALTERs) | daemon step 1l | brief §F4 |
| `gics_sector_map` | `migrate_create_gics_sector_map.ts` | `sp500_gics_sector_ingest.py` | `gics_sector_repository_helper.ts` |
| `insider_ciks` | `migrate_create_form_4_insider_snapshots.ts` (same migration) | `sec_edgar_form4_ingest.py` | F4 dedup |
| `insider_trades` | `migrate_create_form_4_insider_snapshots.ts` (same migration) | `sec_edgar_form4_ingest.py` | F4 composite evaluator |
| `kill_criteria_daily` | `migrate_kill_criteria_daily.ts` | `daemon_live_trades.ts` | `kill_criteria_daily_repository.ts` |
| `live_signals` | `migrate_live_signals.ts` | daemon step 1k (state) | daemon yesterday-state load |
| `live_trades` | `migrate_live_trades.ts` | `daemon_live_trades.ts` | brief §C ledger |
| `schedule_13d_g_filings` | `migrate_create_schedule_13d_g_filings.ts` | `sec_edgar_13d_g_ingest.py` | XD13 composite |
| `schedule_13d_g_snapshots` | `migrate_create_schedule_13d_g_snapshots.ts` | daemon step 1m | brief §16 |
| `sector_rotation_snapshots` | `migrate_create_sector_rotation_snapshots.ts` | daemon step 1f | brief |
| `short_interest_snapshots` | `migrate_create_short_interest_snapshots.ts` | daemon step 1h | brief |
| `stage_state_history` | `migrate_stage_state_history.ts` | `daemon_live_trades.ts` | brief stage audit |
| `vol_structure_snapshots` | `migrate_create_vol_structure_snapshots.ts` | daemon step 1e | brief |

**Bootstrap-only (created by `src/server/clickhouse.ts` on startup — no
dedicated migration):**

| Table | Producer | Consumer |
| --- | --- | --- |
| `bt_runs` | `batch_backtest.ts`, `score_strategies.ts` | dashboards, scorers, brief |
| `bt_runs_regime` | `backfill_bt_runs_regime.ts` | brief §C component 5 |
| `bt_trades` | `batch_backtest.ts`, `batch_backtest_worker.ts` | views, diagnostics |
| `cell_allowlist` | `populate_allowlist.ts` | daemon entry filter |
| `daemon_runs` | daemon main() | brief §C component 4 |
| `macro_breadth` | `macro_compute_breadth.py` | macro classifier input |
| `macro_regimes` | `macro_regime_ingest.py`, `macro_regime_backfill.ts` | daemon step 1c, brief, regime dashboard |
| `meta_models` | `train_meta_label.py` | daemon M2 inference (when ADR-017 lives) |
| `meta_train_trades` | `train_meta_label.py` | `build_meta_train_set.ts` |
| `sp500_constituents` | `macro_refresh_constituents.py` | breadth computation |
| `sp500_history` | `ingest_sp500_history.ts` | macro breadth PIT lookup |
| `strategies` | seeded via `SEED_BUNDLES` | `batch_backtest.ts`, dashboards |

**Ingest-bootstrapped (CREATE TABLE IF NOT EXISTS in the ingest script — no
dedicated migration):**

| Table | Ingest script | Consumer |
| --- | --- | --- |
| `candles` | multiple (yfinance, exchange backfills) | nearly every backtest/daemon script |
| `cik_ticker_map` | `_sec_edgar_helpers.py` | EDGAR ingests |
| `cluster_diagnostics_weekly` | `cluster_tokens_weekly.py` | cluster dashboard |
| `cusip_ticker_map` | `finra_short_interest_ingest.py:192` ⚠️ | FINRA ingest dedup |
| `executive_departures` | `sec_edgar_8k_item_5_02_ingest.py` | exec-departure composite |
| `macro_indicators_cboe` | `cboe_putcall_ingest.py` | regime classifiers |
| `macro_indicators_fred` | `fred_ingest.py` | regime classifier (yield curve) |
| `strategy_scores` | `score_strategies.ts` | brief quality-gate surface |
| `strategy_scores_by_cluster` | `score_strategies_by_cluster.ts` | cluster scoring |
| `token_cluster_membership` | `cluster_tokens_weekly.py` | cluster admission gate |
| `token_features_weekly` | `compute_token_features_weekly.py` | clustering input |
| `token_metadata` | `load_token_metadata.ts` | daemon, backtest, watcher |

**Verified absent (expected — design only):**
- `quantlab.health_quarantine` — ADR-044 design; not yet created.

**Inter-agent disagreements resolved:**
- `quantlab.etf_flow_ssga_spdr` — **NOT a real table.** Scripts agent
  inferred it from the adapter name; CH agent correctly did not list it.
  The SSGA adapter writes a CSV file at `data/etf_flow_issuer_csv/
  ssga-spdr.csv`; the issuer-CSV ingest promotes that CSV into
  `etf_shares_outstanding_secondary`.
- `quantlab.cusip_ticker_map` — **IS a real table.** CH agent missed it;
  created by `finra_short_interest_ingest.py:192` ad-hoc.
- `quantlab.cross_asset_signals` — **NOT a real table.** Repository
  `cross_asset_signals_repository.ts` is misleadingly named — it writes
  to `quantlab.cross_asset_snapshots`. Documentation/naming issue, not
  a missing table.
- `regime_dashboard.ts` classifier version — UI agent claimed
  `phase1_v2` was hardcoded; the actual code at line 141 filters on
  `phase1_v3`. UI agent was wrong.

### §1.3 UI panels + express routes

**Panels (8 React apps — all linked from main App header):**

| Hash route | Component | API endpoint(s) | Status |
| --- | --- | --- | --- |
| `/` (home) | `App.tsx` | `/api/tiers`, `/api/tokens`, `/api/candles`, `/api/strategies*`, `/api/backtest/*`, `/api/sol-regime` | ✓ |
| `#/validator` | `ValidatorApp` | `/api/validator/score`, `/api/validator/score-cell`, `/api/validator/cells`, `/api/validator/demo/:name` | ✓ |
| `#/cluster` | `ClusterApp` | `/api/cluster/diagnostics`, `/api/cluster/scores` | ✓ |
| `#/meta-labeling` | `MetaLabelingApp` | `/api/meta-labeling/cells` | ✓ |
| `#/paper-trading` | `PaperTradingApp` | `/api/paper-trading/state` | ✓ |
| `#/regime` | `RegimeApp` | `/api/regime/state` | ✓ |
| `#/cycle-position` | `CyclePositionApp` | `/api/cycle-position?lookbackDays=…` | ✓ |
| `#/etf-flow` | `EtfFlowApp` | `/api/etf-flow/cross-validation?lookbackDays=…` | ⚠️ ASYMMETRIC GUARD |

**Express routes (24 total in `server.ts`):**
All have catch blocks that wrap CH errors and return 503 instead of an
uncaught 500. The `/#/etf-flow` "500" in the operator screenshot is
actually a 503 with the CH error in the response body — the UI renders it
as an error card. Distinction matters for diagnosis: nothing crashes
uncaught; the panel just surfaces an unhelpful raw CH error instead of an
honest "table not migrated yet, run X" state.

**Defensive patterns already-in-place (positive findings):**
- `CyclePositionApp` returns `hasData: false` on missing snapshots →
  graceful "awaiting first daemon cycle" state.
- `RegimeApp` surfaces a `RegimeDashboardError` with operator-actionable
  message ("run `npm run macro:backfill`").
- `ClusterScoresPanel` throws `NoPublishedFitError` → 404 + UI handles
  cleanly.
- `App.tsx` removed the previous mock-candle silent fallback (line 571-576
  comment confirms).

### §1.4 Scheduled jobs

**Daemon orchestration (`daily_signal_daemon.ts` — 15+ steps, fully
imported, no shell-out to npm):**

Step 1 (yfinance) → 1b (macro candles) → 1b' (FRED) → 1c (macro classify v3)
→ 1d (cycle-position) → 1e (vol-structure) → 1f (sector-rotation) →
1g (cross-asset) → 1h (short-interest) → 1i (exec-departure) →
1ja (SSGA-SPDR refresh, **NEW s96 #9**) → 1j (etf-flow) → 1k (8-K
classifier) → 1l (Form 4) → 1m (Schedule 13D/G) → cells → drawdown →
stage → cell-weights → per-cell-loop → halt-monitor → Telegram brief.

All Layer-0 composite evaluators are table-gated: if their snapshot table
is absent, the daemon logs + skips (no crash). Good defensive posture.

**Watcher daemon (`watch_candles.ts`):** continuous polling, operator-
started via `npm run watch`. No auto-restart on system reboot or failure.

**GitHub Actions:** **NONE.** The `.github/workflows/` directory does
not exist. No automated CI on push, no scheduled cron-triggered runs, no
release automation. Quartz subdirectory has vendored upstream workflows
but those don't apply to SignalForge.

---

## §2 — Wiring map (producer → consumer flows)

### §2.1 Macro pipeline (daemon-automated end-to-end, with caveats)

```
external APIs        ingest scripts (daemon-spawned)        tables                    consumers
─────────────────────────────────────────────────────────────────────────────────────────────────────
yfinance      ──►   fetch_daily_yfinance.py (step 1)  ──►  candles               ──►  many
yfinance/Stooq──►   macro_regime_ingest.py (step 1b)  ──►  candles + macro_breadth ──►  classifier
FRED          ──►   runFredFetch() (step 1b')         ──►  macro_indicators_fred ──►  classifier_v3
[classifier] ──►   classifyLatestMacroRegimeV3 (1c)  ──►  macro_regimes         ──►  daemon + brief + UI
```

**Gap:** `macro_refresh_constituents.py` + `macro_backfill_constituent_histories.py`
+ `macro_compute_breadth.py` are operator-cadence. Breadth depends on
constituent histories; constituent histories require periodic refresh
when the SPY-500 universe changes (quarterly rebalances). The daemon's
auto-backfill catches "zero rows" but not "stale by 14 days."

### §2.2 Alternative-data pipeline (DAEMON EVALUATES, OPERATOR INGESTS — KEY GAP)

```
external APIs        ingest (OPERATOR-CADENCE ONLY)         tables                     daemon eval (DAILY)
─────────────────────────────────────────────────────────────────────────────────────────────────────────
FINRA         ──►   finra_short_interest_ingest.py    ──►  short_interest      ──►  step 1h
SEC EDGAR     ──►   sec_edgar_8k_item_5_02_ingest.py  ──►  executive_departures──►  step 1i
SEC EDGAR     ──►   sec_edgar_8k_event_ingest.py      ──►  eight_k_events      ──►  step 1k
SEC EDGAR     ──►   sec_edgar_form4_ingest.py         ──►  insider_trades      ──►  step 1l
SEC EDGAR     ──►   sec_edgar_13d_g_ingest.py         ──►  schedule_13d_g_filings─►  step 1m
CBOE          ──►   cboe_putcall_ingest.py            ──►  macro_indicators_cboe─►  classifier (v3)
yfinance      ──►   etf_flow_ingest.py                ──►  etf_shares_outstanding─►  step 1j (primary)
SSGA          ──►   etf_flow_ssga_spdr_adapter.py     ──►  etf_shares_outstanding_secondary ──►  step 1j (secondary)
   AUTO (s96 #9, step 1ja)        ↑                                                            (cross-validation panel)
```

**This is the single biggest standing-health gap.** The daemon dutifully
evaluates whatever rows happen to exist in each source table every day,
emits a composite snapshot, surfaces it in the brief — with NO indication
on the brief or UI that the underlying source is stale. An operator who
forgets `npm run edgar:form4:ingest` for two weeks sees a §F4 panel that
reads "Form 4 verdict: NEUTRAL today" with no flag that it's reading
two-week-old filings.

### §2.3 Backtest + paper-trading pipeline (clean)

```
batch_backtest.ts  ──►  bt_runs + bt_trades  ──►  score_strategies.ts  ──►  strategy_scores
                                              ──►  populate_allowlist.ts ──►  cell_allowlist
                                                                            ──►  daemon entry filter
daemon per-cell-loop  ──►  live_signals + live_trades  ──►  paper_trading_dashboard
                       ──►  drawdown_state + stage_state                 ──►  /#/paper-trading panel
```

### §2.4 Cluster + meta-labeling pipeline (operator-cadence, deferred)

```
compute_token_features_weekly.py  ──►  token_features_weekly
cluster_tokens_weekly.py          ──►  token_cluster_membership + cluster_diagnostics_weekly
                                                                       ──►  /#/cluster panel
build_meta_train_set.ts           ──►  meta_train_trades
train_meta_label.py               ──►  meta_models
                                                                       ──►  /#/meta-labeling panel
```

ADR-017 deferred per HANDOFF; this pipeline is dormant but the panels
render fine on existing data.

---

## §3 — Gap list (sorted by severity)

### §3.1 Tier-2 correctness (OPERATOR REVIEW REQUIRED before any action)

#### GAP-1 — SEC EDGAR ingests have no daemon hook (5 sources)

- **What:** `sec_edgar_8k_item_5_02_ingest.py`, `sec_edgar_8k_event_ingest.py`,
  `sec_edgar_form4_ingest.py`, `sec_edgar_13d_g_ingest.py` are purely
  operator-cadence. Daemon steps 1i / 1k / 1l / 1m evaluate stale data
  silently when operator forgets.
- **Impact:** Brief panels surface composite verdicts against arbitrarily-
  old filings. No staleness flag in UI or brief.
- **Recommended action:** Two options for operator to choose:
  - **(A) Promote to daemon-cadence step 1*_ingest (mirror s96 #9 pattern for SSGA).**
    Gate on `NO_FETCH || NO_MACRO || DRY_RUN`. Add ~30-60s per daemon
    cycle. Pre-authorized under data-source policy (SEC EDGAR is on the
    free-API allow list).
  - **(B) Keep operator-cadence + surface "data is N days stale" badge on
    each panel + emit a Tier-2 quarantine row when N > 14.** Lower
    daemon cost; preserves operator-discretion on when to re-fetch.
- **Sub-gap:** EDGAR data is event-driven (filings arrive continuously,
  not daily). Daemon daily cadence is the wrong granularity for some
  filings (Form 4 has T+2 deadlines; daily catches everything; 13D/G
  has 10-day deadlines, daily still adequate). Option A is fine
  cadence-wise.

#### GAP-2 — FINRA short-interest ingest has no daemon hook

- **What:** `finra_short_interest_ingest.py` is operator-cadence. Daemon
  step 1h evaluates whatever rows exist.
- **Impact:** Same staleness pattern as GAP-1, but bi-weekly cadence
  (FINRA releases every two weeks) means staleness is less severe than
  daily EDGAR feeds.
- **Recommended action:** Daemon step 1h-pre that fetches on Mondays
  (or before step 1h on any day), gated on `NO_FETCH`. OR option-B
  staleness badge.

#### GAP-3 — CBOE put/call ingest has no daemon hook

- **What:** `cboe_putcall_ingest.py` is operator-cadence. The phase1_v3
  macro classifier consumes `macro_indicators_cboe`.
- **Impact:** Classifier reads stale CBOE data → classification verdict
  is artificially anchored to an old market mood.
- **Recommended action:** Add as daemon step 1b'' (between FRED fetch
  and classifier), gate on `NO_FETCH`. Pre-authorized (CBOE archives
  free per data-source policy).

#### GAP-4 — ETF flow v1 primary ingest has no daemon hook (asymmetry)

- **What:** `etf:flow:ingest` (yfinance primary) remains operator-cadence
  while v3.1 SSGA secondary auto-refreshes (s96 #9). The brief's §13
  panel reads primary; primary can lag secondary by days.
- **Impact:** Cross-validation panel reports "divergence" that's an
  artifact of operator-forgot-to-run primary refresh, not a real upstream
  data-quality issue.
- **Recommended action:** Daemon step 1jb (after 1ja, before 1j) that
  runs `etf:flow:ingest --apply`. Same gate as 1ja. Restores
  primary/secondary refresh symmetry.

#### GAP-5 — Stooq `^A50R` apikey gate broken since 2026-05-09 (KNOWN)

- **What:** Bulk-CSV breadth path broke when Stooq introduced the captcha
  apikey gate. Phase 1 ships breadth-dark (red unreachable) on the
  regime dashboard.
- **Impact:** Macro classifier falls through to constituent-based breadth
  (slower; same correctness but heavier compute).
- **Recommended action:** Acquire `STOOQ_APIKEY` and re-enable; OR
  formalize the constituent-based fallback as canonical and remove the
  Stooq path. **Operator decision needed** (paid vs. self-hosted).
- **Source:** `memory/project_stooq_apikey_gate.md` + SPEC §1.3.

#### GAP-6 — `etf_flow_dashboard.ts` surfaces raw CH errors to operator

- **What:** When `quantlab.etf_shares_outstanding` doesn't exist (operator
  never ran the migration), the route catches the error + returns 503 +
  the raw CH error message. UI renders this as the error card seen in
  the s96 #12 screenshot.
- **Why Tier-2:** The fix is mechanical (Tier-1) but the **underlying
  signal — operator-pending migrations cause silent UI failures across
  every panel** — is a Tier-2 systemic pattern requiring a uniform
  policy decision. See GAP-7.
- **Tier-1 mechanical fix (covered separately as GAP-11).**

#### GAP-7 — Operator-pending migrations cause silent UI failures (6 known + N unknown)

- **What:** HANDOFF lists 6 pending migrations (form-4-insider /
  add-sell-cluster / add-max-z × 3 / etf-shares-outstanding-secondary).
  None are auto-applied. Routes that read these tables 503/render error
  cards instead of "awaiting migration" empty states.
- **Impact:** Every new composite slice has a window between ship and
  operator-apply where the panel looks broken. Operator-experience
  problem; not a correctness problem if the operator KNOWS to apply.
- **Recommended action:** Two-part:
  - **(a) Tier-1 fix per-route:** add `tableExists()` guard to every
    route reading a CH table (~24 routes). Pattern: graceful empty
    state + operator-actionable message ("run `npm run migrate:X:apply`").
  - **(b) Policy decision:** should migrations auto-apply on daemon
    start? Operator-gated per data-source policy currently. Pre-
    authorizing migration apply would reverse a hard-stop entry —
    needs operator sign-off, not auto-flip.

#### GAP-8 — `regime_dashboard.ts` hardcodes `phase1_v3` (intentional but undocumented)

- **What:** The regime dashboard reads `classifier_version = 'phase1_v3'`
  hardcoded at `src/server/regime_dashboard.ts:141`. The phase1_v2
  classifier output still lives in `macro_regimes` and is the live
  brief's source per some carry-over paths.
- **Impact:** UI dashboard shows v3 classification; brief may surface v2
  depending on the read path. Operator visual inconsistency.
- **Recommended action:** Verify which classifier is the live source-of-
  truth + align both UI + brief to read the same one. Likely a
  documentation gap (the choice is intentional but not documented as
  the live classifier per a recent ADR).

#### GAP-9 — Watch-candle watcher has no auto-restart

- **What:** `npm run watch` runs indefinitely once operator starts; no
  auto-restart on failure or system reboot.
- **Impact:** If the OS restarts overnight, intraday strategies stop
  monitoring until operator notices + restarts.
- **Recommended action:** Wrap in a tmux/screen session OR systemd-
  equivalent on Windows (Task Scheduler with "restart on failure"). OS-
  level config, not in repo. Operator decision.

### §3.2 Tier-1 mechanical (assistant can auto-fix after operator review)

#### GAP-10 — No automated CI/CD

- **What:** `.github/workflows/` doesn't exist. No automated test runs
  on push, no lint checks, no migration apply preview.
- **Impact:** Test regressions surface only when operator runs `npm
  test` locally; tsc errors persist (HANDOFF says 13 baseline errors
  unchanged). The cost of "broken on main" is borne by the next session.
- **Recommended action:** Add `.github/workflows/ci.yml` with `npm test`
  + `npx tsc --noEmit` + `npm run check:help` on PR + push. Trivial
  (~30 LOC). Operator decides whether GH Actions billing is acceptable
  (free for public repos; private repos have minute limits).

#### GAP-11 — `/#/etf-flow` primary table guard missing

- **What:** `etfSharesOutstandingTableExists()` helper at
  `src/server/etf_flow_repository.ts:778-793` exists but is never
  called. The dashboard at `src/server/etf_flow_dashboard.ts:134-139`
  guards the secondary table but not the primary.
- **Fix:** Mirror the secondary guard ~10 LOC. Confirmed Tier-1
  mechanical.
- **Effect:** Replaces the operator-facing CH-error card with an
  honest "awaiting primary ingest — run `npm run migrate:create-etf-
  flow-snapshots:apply` then `npm run etf:flow:ingest`" state.

#### GAP-12 — NaN/Infinity formatter hygiene

- **What:** `EtfFlowApp.tsx` lines 366-380 + `PaperTradingApp.tsx`
  lines 29-39 use `n.toFixed(N)` without `Number.isFinite(n)` guards.
  Other panels (`App.tsx` line 605) do guard.
- **Impact:** Low — CH usually returns well-typed numbers — but a null
  / undefined column would render `NaN%` or `Infinity` in the UI.
- **Fix:** Mirror the `App.tsx` pattern. ~20 LOC across two files.

#### GAP-13 — Vendored Quartz fork drift risk (S96-41/42 carry-over)

- **What:** Two patches in `quartz/` (`gitignore: false` in
  `quartz/quartz/util/glob.ts`; `**/*.log` in `quartz.config.ts`
  ignorePatterns) do not exist upstream. Any `git pull` from
  `jackyzha0/quartz` regresses silently.
- **Fix:** Add a Quartz upgrade-procedure document at
  `docs/processes/quartz-upgrade.md` that enumerates the patches +
  verification steps. OR add a CI test that grep-asserts both patches
  exist after any quartz file change.

#### GAP-14 — `cross_asset_signals_repository.ts` misleading name

- **What:** Repository name implies it manages a `cross_asset_signals`
  table; actually writes to `cross_asset_snapshots`. Confused both the
  scripts + CH inventory agents during this audit.
- **Fix:** Rename file + class to `cross_asset_snapshots_repository`
  (TypeScript-friendly rename via `Edit replace_all`).

#### GAP-15 — 6 operator-pending migrations

- **What:** Listed in HANDOFF: `create-form-4-insider-snapshots`,
  `add-sell-cluster-form-4-insider-snapshots`, `add-max-z-{exec-
  departure,eight-k-classifier,form-4-insider}-snapshots`, `create-
  etf-shares-outstanding-secondary`.
- **Impact:** Until applied, the corresponding composites + cross-
  validation panel return error cards.
- **Fix:** Operator runs `npm run migrate:X:apply` for each. Per data-
  source policy, the assistant CANNOT auto-apply CH DDL.

### §3.3 Documentation / cleanup

#### GAP-16 — 78,399 zero-trade sentinels in `bt_runs_regime`

- **What:** HANDOFF carries this as "deferred." Either garbage data to
  clean OR intentional sentinel marker pattern.
- **Action:** Operator decides whether to keep, label, or purge.

#### GAP-17 — Orphan candidate confirmation

- `sharadar_backfill.py` — confirm if paid-subscription path is
  abandoned → remove.
- `import_botdb_candles.py` — confirm one-shot migration completed →
  remove.
- `walk_forward_cluster.py` / `train_meta_label.py` — confirm dev-only
  → leave with `_` prefix to follow diagnostic-script convention.

#### GAP-18 — `cusip_ticker_map` should have a dedicated migration

- **What:** Created ad-hoc by `finra_short_interest_ingest.py:192`
  CREATE TABLE IF NOT EXISTS. Same anti-pattern as the s92 etf v1
  primary table created ad-hoc by `etf_flow_ingest.py`.
- **Fix:** Promote to `migrate_create_cusip_ticker_map.ts` for
  documentation consistency. Or accept the pattern as canon (s91 EDGAR
  ingest set the precedent).

#### GAP-19 — Vendor fork upgrade procedure missing

- See GAP-13.

---

## §4 — Known-good baseline (confirmed clean — NO action)

These are positive findings; the assistant verified there's nothing
broken here. Mentioned so the operator doesn't waste review attention.

1. **Zero unintentional duplicate tables.** `etf_shares_outstanding` (v1)
   + `etf_shares_outstanding_secondary` (v3) are intentional per ADR-
   043; everything else is unique.
2. **Zero abandoned migrations.** All 29 migration scripts have
   corresponding npm entries.
3. **Zero undiscoverable panels.** All 7 secondary dashboards linked
   from main App header.
4. **Zero truly uncaught 500s.** Every express route has a catch block
   returning 503 + error body (operator-visible).
5. **Mock-candle silent fallback already removed** from `App.tsx`
   (intentional fix in a recent commit).
6. **Tests cover ~110 core logic files** comprehensively.
7. **Defensive empty-state patterns are in place** on
   `CyclePositionApp`, `RegimeApp`, `ClusterScoresPanel`. Operator-
   actionable error messages where applicable.
8. **Daemon's table-gated composite evaluators** all degrade gracefully
   when their snapshot tables don't exist (no daemon crash on missing
   table; they log + skip).

---

## §5 — Recommended next steps (POST-OPERATOR-REVIEW only)

The assistant proposes this execution order ONCE the operator approves
the gap classifications:

### Phase A — Tier-1 mechanical fixes (safe, low-risk, ~1 session)

1. GAP-11: wire `etfSharesOutstandingTableExists()` into the dashboard
   handler.
2. GAP-12: add `Number.isFinite` guards in etf-flow + paper-trading
   formatters.
3. GAP-14: rename `cross_asset_signals_repository` →
   `cross_asset_snapshots_repository`.
4. GAP-18: add `migrate_create_cusip_ticker_map.ts` for documentation
   consistency (idempotent; safe to add even though table exists).

### Phase B — Add table-exists guards uniformly (~1 session)

5. GAP-7(a): per-route `tableExists()` guards across all 24 routes.
   Pattern: graceful empty state with operator-actionable message
   pointing at the migration command.

### Phase C — Daemon ingest promotions (CONDITIONAL on operator pick of GAP-1/2/3 option)

6. If operator picks GAP-1 option A: add daemon steps 1h-pre / 1i-pre /
   1k-pre / 1l-pre / 1m-pre for EDGAR ingests (mirror s96 #9 SSGA
   pattern).
7. If operator picks GAP-3: add daemon step 1b'' for CBOE ingest.
8. If operator picks GAP-4: add daemon step 1jb for ETF v1 primary
   ingest.
9. Each step shipped with a UI surface (per
   `feedback-ui-validation-each-slice` rule + ADR-044 UI-correctness
   domain) — likely an extension to the brief's freshness summary.

### Phase D — CI/CD baseline (operator decision required)

10. GAP-10: `.github/workflows/ci.yml` with test + lint + tsc gates.

### Phase E — Health-check infrastructure (ADR-044 implementation Phase 2)

11. `scripts/system_health_check.ts` — orchestrate `_data_quality.ts`
    + `_morning_check.ts` + per-route ping + per-table freshness probe
    + per-composite plausibility band.
12. `migrate_create_health_quarantine.ts` + the quarantine table.
13. `src/server/health_dashboard.ts` + `src/components/health/
    HealthApp.tsx` + `/#/health` route.
14. Brief §0 daily digest (freshness + quarantine + auto-fix log).
15. Daemon step 0a — auto-run health check at start.
16. Telegram alert wiring for Tier-2 quarantine events.

### Phase F — Documentation + cleanup (low priority, opportunistic)

17. GAP-13/19: Quartz upgrade procedure document.
18. GAP-17: orphan-candidate cleanup (operator-decided).
19. GAP-16: `bt_runs_regime` zero-trade-sentinel decision.

---

## §6 — Operator review form

For each gap, please mark one of:

- **wire-it** — assistant should connect it to its consumer.
- **remove-it** — assistant should delete the file/table/route.
- **fix-it** — assistant should fix per the Recommended action.
- **leave-it** — intentional state; no action.
- **defer-it** — agreed action but deferred to a later session.

| Gap | Action | Notes / overrides |
| --- | --- | --- |
| GAP-1 SEC EDGAR ingest cadence | | (choose option A or B) |
| GAP-2 FINRA cadence | | |
| GAP-3 CBOE cadence | | |
| GAP-4 ETF v1 primary cadence | | |
| GAP-5 Stooq apikey gate | | (paid subscription or self-host?) |
| GAP-6 raw CH errors in UI | | (covered by GAP-7 + GAP-11) |
| GAP-7 operator-pending migration UI | | (a + b separately) |
| GAP-8 regime classifier version | | |
| GAP-9 watcher auto-restart | | (OS-level; not in repo) |
| GAP-10 CI/CD | | |
| GAP-11 etf-flow primary guard | | |
| GAP-12 NaN/Inf formatter hygiene | | |
| GAP-13 Quartz vendor fork procedure | | |
| GAP-14 repository naming cleanup | | |
| GAP-15 6 operator-pending migrations | | (apply now? defer?) |
| GAP-16 bt_runs_regime sentinels | | |
| GAP-17 orphan-candidate confirmation | | (per-file decision) |
| GAP-18 cusip migration | | |
| GAP-19 vendor fork docs | | (covered by GAP-13) |

---

## §7 — Audit metadata

- **Audit started:** 2026-05-23 (session 96 #12)
- **Subagents used:** 4 (scripts / CH tables / UI panels + routes /
  scheduled jobs), parallel execution.
- **Inter-agent discrepancies resolved:** 4 (etf_flow_ssga_spdr
  hallucinated table; cusip_ticker_map missed; cross_asset_signals
  hallucinated table; regime_dashboard classifier version misread).
- **Files read (direct):** ~15 (verification reads beyond subagent
  results).
- **Total scripts surveyed:** 341.
- **Total tables surveyed:** 54.
- **Total UI panels surveyed:** 8.
- **Total express routes surveyed:** 24.
- **Total daemon steps surveyed:** 15+.

**Next document update:** when operator review fills in §6, the
assistant will produce `docs/audits/system-reconciliation-2026-05-fix-
plan.md` with the agreed action list + scheduled execution order.
