# SPEC — Track C / Component 4: operator morning brief

> **Status:** DRAFT — produced from the 2026-05-10 RESEARCH+SPEC turn (session 38); SPEC stage output, no critic pass yet · **Author:** producer (Claude) · **Authority:** [HANDOFF "Next stage" — C-Component-4](../../.claude/HANDOFF.md), [ADR-037](../decisions/README.md), [Component 3 SPEC §1](regime-dashboard-component3.md), [paper-trading review](../../scripts/_paper_trading_review.ts)
>
> **Stage in Vector Core build:** SPEC. RESEARCH closed in the same turn. CODE follows.

This SPEC defines a CLI-emitted markdown brief — `npm run brief:morning` — that pulls today's macro regime, paper-trading kill-criteria status, last daemon-run anomalies, and a top-3 watch-list into one terse, decision-supporting document for pre-market operator review. No new dashboard panel. No new API route.

---

## 1. Goal and exit gate

**Goal.** Replace the operator's three-tab pre-market routine (`/#/regime` + `npx tsx scripts/_paper_trading_review.ts` + scrolling daemon stdout) with a single command whose output answers four decisions:

- **D1.** "Is the macro environment safe to keep paper-trading positions open today?" — today's regime + the bias caveat the operator must permanently attach to that read.
- **D2.** "Did any kill criterion fire overnight?" — pass/fail-with-rationale per criterion (B1/A2/A3/A4/A5/C1/C3).
- **D3.** "Did anything weird happen in the last daemon run?" — fetch failures, telegram failures, unusual cell counts.
- **D4.** "Which positions am I watching most closely today?" — top-3 by distance-to-kill-criterion.

**Exit gate.** All of:

1. New table `quantlab.daemon_runs` exists (DDL added to `ensureBacktestTables`) and `daily_signal_daemon.ts` writes one row per invocation with anomaly markers. Idempotent re-runs are no-ops on the same `run_id`.
2. New module `src/server/paper_trading_kill_criteria.ts` exports a pure function `evaluateKillCriteria(state: PaperTradingResponse): KillCriterionVerdict[]` returning structured pass/fail/insufficient-data verdicts. Existing CLI script `_paper_trading_review.ts` refactored to consume this module — same stdout output, no behavioral change.
3. New module `src/server/operator_brief.ts` exports `composeMorningBrief(deps?: BriefDeps): Promise<MorningBrief>` returning a typed document object. `deps` is dependency-injection for testability; production default uses live ClickHouse.
4. New module `src/server/operator_brief_render.ts` exports `renderBriefMarkdown(brief: MorningBrief): string` — pure function, fully unit-testable, returns the operator-facing markdown.
5. New CLI script `scripts/operator_brief.ts` emits the rendered markdown to stdout. Two npm scripts: `brief:morning` and `brief:morning:json` (the latter dumps `MorningBrief` as JSON for piping into other tooling).
6. New tests green: ~18 TS unit tests across the four new modules. Cover: kill-criteria pure-helper logic (each criterion's pass/fail boundary), watch-list ranking under empty/sparse data, render output stability, anomaly extraction from `daemon_runs`.
7. `npm test` baseline `674 passing, 4 failing` → `~692 passing, 4 failing`. No drop in passing count outside the new files.
8. `npx tsc --noEmit` clean on all new files.
9. Visual acceptance: running `npm run brief:morning` against today's CH state produces a brief whose four sections each render correctly with NO placeholder text and NO crashes when any section's data is sparse (e.g. zero positions, zero anomalies, regime data missing).

**Non-exit-gate.** No HTML/dashboard rendering. No telegram delivery (could be Component 6, not specced here). No PDF export. No persistence of the brief itself — the brief is regenerated on demand from CH state.

**Non-goal.** Component 4 does NOT introduce a new validation methodology. It does NOT change the kill-criteria definitions (those are locked from session 32). It does NOT alter `live_signals` or `macro_regimes` schemas.

---

## 2. Architectural decisions

### 2.1 CLI markdown output, not JSON-only or HTML

Markdown is the primary output. Reasons:

- The operator reads it in a terminal at pre-market. Terminals render markdown headings, tables, and emphasis natively in modern shells; the user can also pipe to a file or a markdown previewer.
- Markdown is git-diffable if archived.
- A JSON variant (`brief:morning:json`) is provided for downstream tooling but is non-primary.

**Rejected alternative.** API route (`/api/brief/morning`) returning JSON consumed by a new dashboard tab. Adds UI surface (non-goal §1) and forces the operator into a browser at the moment they want a terminal.

### 2.2 Bias caveat is mandatory and non-removable

Every brief, regardless of regime color, MUST display the `BIAS_NOTE_PHASE1_V2` constant verbatim, immediately after the regime line. This is the same load-bearing constant test #10 in [regime_dashboard.ts:139](../../src/server/regime_dashboard.ts#L139) protects.

**Rule.** `renderBriefMarkdown` includes the bias caveat in the regime section unconditionally. A unit test asserts the caveat is present in the rendered output across all four regime colors. Future `phase1_v3` cutover will update the constant once and propagate to both Component 3 and Component 4 — same test #10 pattern.

**Why this is load-bearing.** The brief's purpose is to support the operator's morning decision. A regime read without its known bias is more dangerous than no regime read at all because it creates false confidence under a known-failed crash detector (the four ADR-037 fixture failures).

### 2.3 Daemon anomalies via sidecar table, not stdout parsing

The daemon currently logs anomalies to stdout only ([daily_signal_daemon.ts](../../scripts/daily_signal_daemon.ts) — fetch failures at lines 216/220/230, telegram failures at line 441). Stdout parsing is fragile (log format changes silently break the parser).

**Decision.** Add a new ClickHouse table `quantlab.daemon_runs` that the daemon writes one row to at end of every invocation. Schema:

```sql
CREATE TABLE IF NOT EXISTS quantlab.daemon_runs (
  run_id              UUID,
  started_at          DateTime64(3, 'UTC'),
  finished_at         DateTime64(3, 'UTC'),
  status              LowCardinality(String),  -- 'ok' | 'partial' | 'failed'
  fetch_summary       String,                  -- JSON: {bars_fetched, expected, failed_tickers[]}
  cells_evaluated     UInt32,
  cells_with_diff     UInt32,
  telegram_status     LowCardinality(String),  -- 'ok' | 'unconfigured' | 'failed'
  anomalies_json      String,                  -- JSON array of {severity, message, context}
  ingested_at         DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (run_id)
```

`anomalies_json` is a String because anomaly shape will evolve and we don't want a brittle Map schema. Reader uses JSON.parse with type guard.

**Rejected alternative.** Parse daemon stdout at brief-render time. Brittle; couples brief-render correctness to log format; fails silently when daemon log lines are reordered.

**Scope cost.** This expands C-4 scope to include a one-line write at end of `daily_signal_daemon.main()`. The DDL is additive and idempotent; the write is non-fatal-on-failure (try/catch, console.warn). Same pattern as C-5 sweep integration this session.

### 2.4 Kill-criteria check refactored into a pure module

The check array at [_paper_trading_review.ts:108-116](../../scripts/_paper_trading_review.ts#L108-L116) is hardcoded inside the CLI script. C-4 needs the verdicts as structured data, not formatted-table stdout.

**Decision.** Extract the criteria into `src/server/paper_trading_kill_criteria.ts`. Public surface:

```ts
export type KillVerdict = 'pass' | 'fail' | 'insufficient_data';

export interface KillCriterionVerdict {
  code: string;              // 'B1', 'A2', 'A3', 'A4', 'A5', 'C1', 'C3'
  label: string;             // 'NEW ENTRY > 20 in single run'
  verdict: KillVerdict;
  rationale: string;         // human-readable, e.g. 'most recent run had 7 NEW entries'
  measured_value?: number;   // when applicable, the actual measurement
  threshold?: number;        // when applicable, the kill threshold
  insufficient_reason?: string;  // when verdict='insufficient_data', why
}

export function evaluateKillCriteria(
  state: PaperTradingResponse,
): KillCriterionVerdict[];
```

`_paper_trading_review.ts` is refactored to consume `evaluateKillCriteria` and format its output the same way as today. **Behavioral change: zero.** Same stdout, same exit code, same kill detection. The refactor is structure-only; a regression test fixture compares pre/post stdout on a frozen `live_signals` snapshot.

**Why pure function.** Testability. The current script can only be tested by running it; that's slow and requires CH state. Pure-function shape mirrors C-5's `dominantRegime` / `computeDistribution` design (SPEC C-5 §2.3, lock-in from session 37).

### 2.5 Watch-list = top-3 by distance-to-kill-criterion

The HANDOFF mentions two implicit watch-list items (mr_v1/p=14 NKE; trend_v1/p=30 INTC) but no formal definition. SPEC must invent one.

**Definition.** Watch-list item = one currently-long position whose unrealized PnL is **closer than 50% of the way** to the A2 (-64.37%) kill threshold OR whose holding period exceeds 100 bars. Ranking key: `distance_to_kill_pct` ascending (most-at-risk first); secondary key: `bars_held` descending. Top 3 returned.

**Why this definition.** It centers the operator's attention on positions where action might be needed today, not on PnL outliers in either direction. A massively profitable position (+408% INTC) is operationally uninteresting unless its risk profile changed. A position 40% of the way to A2 is the one that might force a manual close before the daemon's next run.

**Edge cases:**
- Zero positions long → empty watch-list section, prints `(no open positions)`.
- Fewer than 3 qualifying positions → prints whatever qualifies; no padding with non-qualifying positions.
- All positions safely positive → prints "(no positions within 50% of any kill threshold)".

**Where the data comes from.** `quantlab.live_signals` (state='long' rows) joined to current price (`latest_close`). Uses `position_entry_price` for unrealized PnL %.

### 2.6 Brief is regenerated on demand, not persisted

The brief itself is not stored. Each invocation queries CH and renders fresh markdown. **Why:** persisting would create a staleness problem (the operator could read yesterday's cached brief). The four data sources are all already persisted in CH; the brief is a view, not a record.

---

## 3. Data contract

### 3.1 `MorningBrief` (the typed document)

```ts
export interface MorningBrief {
  generated_at: string;                  // ISO-8601 UTC
  classifier_version: string;            // 'phase1_v2'
  regime: {
    today: { date: string; regime: RegimeLabel; ... };
    bias_note: string;                   // BIAS_NOTE_PHASE1_V2 constant verbatim
    days_in_current_regime: number;
  };
  kill_criteria: KillCriterionVerdict[];
  daemon: {
    last_run_at: string | null;          // null if no daemon run on file
    status: 'ok' | 'partial' | 'failed' | 'no_run_today';
    anomalies: Anomaly[];
    cells_evaluated: number;
    cells_with_diff: number;
    age_hours: number;                   // hours since last_run_at
  };
  watchlist: WatchlistItem[];            // top 3 max
}

export interface Anomaly {
  severity: 'info' | 'warning' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface WatchlistItem {
  cell_key: string;
  symbol: string;
  bars_held: number;
  unrealized_pct: number;
  distance_to_kill_pct: number;          // 0 = at kill, 1 = far from kill
  reason: string;                        // 'approaching A2 (-64.37%)' or 'long-held (>100 bars)'
}
```

### 3.2 Public function signatures

```ts
// src/server/operator_brief.ts
export interface BriefDeps {
  fetchRegimeState: typeof regimeDashboard.fetchRegimeState;
  fetchPaperTradingState: typeof paperTradingDashboard.fetchPaperTradingState;
  fetchLastDaemonRun: () => Promise<DaemonRunRow | null>;
  fetchWatchlistCandidates: () => Promise<WatchlistCandidate[]>;
}
export async function composeMorningBrief(deps?: BriefDeps): Promise<MorningBrief>;

// src/server/operator_brief_render.ts (PURE)
export function renderBriefMarkdown(brief: MorningBrief): string;

// src/server/paper_trading_kill_criteria.ts (PURE module-level helpers)
export function evaluateKillCriteria(state: PaperTradingResponse): KillCriterionVerdict[];
export function evaluateB1(state: PaperTradingResponse): KillCriterionVerdict;
// ... one per code
```

### 3.3 Section content rules

Each of the four sections has rules for what to render and how to handle missing data:

**Regime section** — always rendered. Format:
```
## 1. Macro regime — today

**{REGIME UPPER}** · day {N} in this regime · classifier {classifier_version}

> {BIAS_NOTE_PHASE1_V2 verbatim}

| Indicator | Today | 5-day window |
| --- | --- | --- |
| Realized stress | ... | ... |
| Breadth | ... | ... |
| ... |
```

**Kill-criteria section** — always rendered. Each criterion gets one row in a table:
```
## 2. Kill criteria — overnight

| Code | Verdict | Rationale |
| --- | --- | --- |
| B1 | ✓ pass | most recent run: 7 NEW entries (threshold 20) |
| A2 | — insufficient_data | live_trades table not yet built |
| ...
```

A failing criterion gets `✗ FAIL` and bumps the section header to `## 2. Kill criteria — ⚠ FAIL OVERNIGHT`.

**Daemon section** — always rendered. Three states:
- `last_run_at` exists, age_hours < 24, status='ok' → green check, anomalies listed if any
- `last_run_at` exists, age_hours ≥ 24 → "stale" warning + age in hours
- `last_run_at` is null → "no daemon run on file" + suggestion to run `npm run daemon:daily`

**Watch-list section** — always rendered. Three states per §2.5 edge cases.

### 3.4 Rendering edge cases

- Markdown tables with column-overflow long content (rationales, anomaly messages) wrap or truncate at 100 chars per cell with `…`.
- Numbers formatted to 2 decimal places except integers.
- Times shown in UTC with local-tz hint when reasonable: `2026-05-10 13:35 UTC`.
- A failing kill criterion or a stale daemon run pushes a `⚠` to the section header — this is the operator's attention signal.

---

## 4. Failure modes and behavior

### 4.1 ClickHouse offline

Brief generation aborts with a clear message: `cannot generate brief: ClickHouse unreachable`. Exit code 2.

### 4.2 `quantlab.daemon_runs` table empty

The daemon hasn't been instrumented yet (pre-rollout state). Brief renders Daemon section as "no daemon run on file" — same as the never-ran case. Mid-rollout, this is the expected state until the daemon-write change ships.

### 4.3 `live_signals` table empty

Brief renders Watch-list section as "(no open positions)". Kill-criteria section renders A4/A5/A2/A3 as `insufficient_data` per existing rules.

### 4.4 Bias-note constant missing

If `BIAS_NOTE_PHASE1_V2` is undefined (caused by a future refactor), `composeMorningBrief` throws. The brief MUST NOT render without the bias note. Test asserts this.

### 4.5 Future classifier versions

When `phase1_v3` lands, the brief must use the new constant. SPEC §2.2 establishes the test pattern: a single test asserts the rendered output contains the active version's bias note. The brief is the second consumer of this constant (after Component 3).

---

## 5. Tests

Eighteen unit tests across four files. All TS, all `node:test` per project convention.

### `scripts/tests/paperTradingKillCriteria.test.ts` — 9 tests

- **#1** `evaluateB1`: 0/19/20/21 NEW entries pass/pass/pass/fail boundary.
- **#2** `evaluateB1`: returns `insufficient_data` when `runHistory` empty.
- **#3** `evaluateA2`: insufficient_data when `live_trades` table not yet present (current state of repo).
- **#4** `evaluateA4`: insufficient_data when fewer than 30 days of data exist.
- **#5** `evaluateC1`: telegram pass/fail across 1/2/3 consecutive failures.
- **#6** `evaluateC3`: pass when `live_signals` populated; fail when daemon errored on persist (signaled by missing rows for the most recent run_id).
- **#7** `evaluateKillCriteria`: returns one verdict per code (B1, A2, A3, A4, A5, C1, C3) — exactly 7 entries, in stable order.
- **#8** Refactor regression: stdout output of `_paper_trading_review.ts` byte-equal pre- and post-extraction on a fixed test fixture (compare against `tests/fixtures/paper_trading_review_baseline.txt`).
- **#9** Insufficient-data verdict carries human-readable `insufficient_reason`.

### `scripts/tests/operatorBrief.test.ts` — 5 tests

- **#10** `composeMorningBrief` with all-deps-stubbed returns a `MorningBrief` with all four section objects populated.
- **#11** `composeMorningBrief` with `fetchLastDaemonRun` returning null produces `daemon.status === 'no_run_today'`.
- **#12** Watch-list ranking: 5 long positions with varying distance-to-kill yields top-3 sorted by distance ascending. Test against a fixed input array.
- **#13** Watch-list edge case: zero qualifying positions returns empty array.
- **#14** `composeMorningBrief` throws with a clear error when `BIAS_NOTE_PHASE1_V2` is undefined (mocked).

### `scripts/tests/operatorBriefRender.test.ts` — 4 tests

- **#15** `renderBriefMarkdown` output contains the bias note string verbatim across all four regime colors.
- **#16** Failing kill criterion bumps section 2 header to `⚠ FAIL OVERNIGHT`.
- **#17** Stale daemon (age_hours ≥ 24) renders the stale warning verbatim.
- **#18** Watch-list with zero items renders `(no open positions)` exactly once, not twice.

---

## 6. File / code map

### NEW

- `src/server/paper_trading_kill_criteria.ts` — pure helpers; section-2 logic.
- `src/server/operator_brief.ts` — orchestrator; impure (CH reads).
- `src/server/operator_brief_render.ts` — pure renderer; section→markdown.
- `scripts/operator_brief.ts` — CLI; emits markdown or JSON.
- `scripts/tests/paperTradingKillCriteria.test.ts`
- `scripts/tests/operatorBrief.test.ts`
- `scripts/tests/operatorBriefRender.test.ts`

### MODIFIED

- `src/server/clickhouse.ts` — add `quantlab.daemon_runs` DDL block to `ensureBacktestTables` (same pattern as C-5 sidecar). Idempotent.
- `scripts/daily_signal_daemon.ts` — add try/catch'd one-line write to `quantlab.daemon_runs` at end of `main()` per SPEC §2.3. Non-fatal; log via `console.warn` on insert failure. Same shape as C-5 sweep integration.
- `scripts/_paper_trading_review.ts` — refactor only: import and call `evaluateKillCriteria`; same stdout output (regression test #8).
- `package.json` — add `brief:morning` and `brief:morning:json` npm scripts.

### NOT MODIFIED

- `src/server/macro_regime.ts`, `src/server/regime_dashboard.ts` — already export everything Component 4 needs.
- `src/server/paper_trading_dashboard.ts` — `fetchPaperTradingState` already returns the right shape.
- The classifier core, dashboard components, bt_runs schema — all untouched.

---

## 7. Watch-outs

### 7.1 The bias note is a contract surface — do not paraphrase it in §2 rendering

If a future refactor tries to "improve" the bias note string by inlining it into render code, test #15 catches the lost reference. The constant lives in [regime_dashboard.ts:139](../../src/server/regime_dashboard.ts#L139) and is the single source of truth across Components 3 and 4.

### 7.2 The kill-criteria refactor must be byte-equal in stdout

Test #8 enforces this. The refactor is structure-only. Any operator scripts or downstream tools that grep the existing stdout output will continue to work. Behavioral changes (new criterion, threshold update) belong in a separate edit, not the refactor.

### 7.3 Daemon write failure must NOT abort the daemon

The try/catch around the `quantlab.daemon_runs` write follows the C-5 sweep-integration pattern. If CH is down at end of daemon, the daemon's primary outputs (`live_signals` writes) have already succeeded; the anomaly-table write is denormalization. Don't tighten this into a hard failure — same reasoning as session-37 C-5 lock-in.

### 7.4 Watch-list definition is opinionated and may need iteration

The 50%-of-A2-distance heuristic in §2.5 is an initial guess. After two weeks of production use, the operator will probably have feedback ("this never surfaces NKE before it kills" or "this surfaces too many positions"). Iterate the threshold; the SPEC documents the current rule but doesn't lock the threshold.

### 7.5 The brief is a tool, not the truth

The dashboard at `/#/regime` and the raw CLI at `_paper_trading_review.ts` remain authoritative. The brief is a curated overview, not a replacement. If the brief and the dashboard disagree, the dashboard is right (more recent data, more detailed renderings) and a bug exists in C-4. Do not "fix" the dashboard to match the brief.

### 7.6 Anomaly schema will drift; the JSON String is deliberate

`anomalies_json` is a String, not a Map(String, String). When daemon logging adds new anomaly types, the brief's reader can ignore unknown fields gracefully. A typed schema would force a coordinated daemon+reader update for every new anomaly category.

### 7.7 Phase1_v3 cutover affects this brief twice

When Sharadar activates and `phase1_v3` ships:
1. `BIAS_NOTE_PHASE1_V2` constant is renamed/replaced — brief's bias note updates automatically since both Component 3 and Component 4 import the same constant.
2. The brief's regime section will show meaningful red days again — currently the operator sees only green/yellow/orange/red weighted toward green by ADR-037 bias.

Both updates are single-place edits. Test #15 protects against half-updates.

---

## 8. RESEARCH log (closed)

Closing notes from the RESEARCH stage in this same session, preserved for future reference:

- **Source survey:** four data sources audited. Two ready (regime, paper-trading state), two have gaps (daemon anomalies = stdout only; watch-list = undefined). Both gaps are addressed in §2.3 and §2.5.
- **Canon check:** no specific López de Prado / Pardo / Bailey citation governs operator-brief design. This is operational tooling, not strategy methodology. Vector Core [DESIGN] rule applies (Bloomberg-style density, decision-supporting); no canon-thin disclosure needed because no methodology recommendation is being made.
- **Kill-criteria refactor cost:** estimated ~80 lines of TS extraction + a fixture-baseline regression test. Behavioral risk is zero by design (regression test #8 enforces).
- **Daemon-anomaly table cost:** ~30 lines of CH DDL + ~10 lines of daemon-side write + ~20 lines of reader. Adds one table to `quantlab` namespace; no migration risk.
- **Watch-list definition:** distance-to-A2 chosen over distance-to-A3 because A2 is per-trade (immediate) while A3 is portfolio-level (slower-moving). Per-position attention should track per-position thresholds.
