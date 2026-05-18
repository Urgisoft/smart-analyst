# SPEC — Track C / Component 3: Macro-regime dashboard

> **Status:** DRAFT — produced from the 2026-05-10 DESIGN turn (session 36); SPEC stage output, no critic pass yet · **Author:** producer (Claude) · **Authority:** [HANDOFF "Next stage" — C-Component-3](../../.claude/HANDOFF.md), [ADR-037](../decisions/README.md), [macro-regime-classifier-phase1 SPEC](macro-regime-classifier-phase1.md), [macro-regime-classifier-phase1-rev3-breadth-amendment](macro-regime-classifier-phase1-rev3-breadth-amendment.md)
>
> **Stage in Vector Core build:** SPEC. DESIGN closed in the same turn. CODE follows.

This SPEC defines the read-side dashboard route `/#/regime` over the already-shipped `quantlab.macro_regimes` table (Component 1). All schemas are unchanged — no DDL, no classifier logic edit, no breadth-source change.

---

## 1. Goal and exit gate

**Goal.** Surface the macro-regime classifier's state in a dense, single-screen UI so the operator can answer four decisions without leaving the panel:

- **D1.** "What is today's regime, and which indicators are driving it?" — the live label + the four indicator cells with raw values and threshold context.
- **D2.** "Is today's label fragile (one signal away from a transition) or robust (multiple categories firing in window)?" — the 5-day rolling-union grid that drives `red`.
- **D3.** "Is the recent regime distribution anomalous vs the long baseline?" — windowed counts compared to ADR-037's lifetime baseline (50/78/1172/3317).
- **D4.** "Am I looking at a biased label?" — the bias-quarantine banner is unmissable; `phase1_v2` provenance and the four-failing-fixture caveat are first-class header content per ADR-037 §5 + bias_quantification.md.

**Exit gate.** All of:

1. Visiting `/#/regime` renders all five panels with live data from `quantlab.macro_regimes` under `classifier_version='phase1_v2'` — no placeholder data, no mocks.
2. The bias-quarantine banner is the first thing the eye lands on (top of the route, larger than the regime label itself, with explicit `phase1_v2` text and a link to ADR-037).
3. Panel B's indicator strip shows raw numbers (`vix_term_ratio` to 3 decimals, `pct_above_50dma` to 1 decimal, returns to 2 decimals as %) — fired/non-fired pill state is derived from the row, not recomputed in the UI.
4. Panel C's regime timeline shows ≥252 trading days when CH has them, colored by regime, with a hoverable tooltip naming the day's `categories_firing` count.
5. Panel D's 5d window grid shows exactly 4 rows × 5 columns; missing days at the head (warmup boundary) render as a neutral hatch, not blank.
6. Panel E's distribution table shows lookback counts (default 252d, also 1Y, 5Y, all-time) alongside ADR-037 baseline and a "deviation" column.
7. New tests green: ~10 TS unit tests on `regime_dashboard.ts` (query parsing, days-in-current-regime, 5d window padding, distribution rollup, bias-banner content). 0 Python.
8. `npm test` shows new count `(634 passing, 4 failing)` — same 4 fixtures as today, no regressions; no count drop on TS test side.
9. `npx tsc --noEmit` clean.

**Non-exit-gate.** The 4 failing macro-regime fixture tests are NOT addressed by this SPEC. Component 3 is a read-side surface; if the dashboard is wrong because the classifier is wrong, that is fixed at Component 1's `phase1_v3` upgrade trigger (post-Sharadar), not here. Per HANDOFF watch-out: do **not** tune thresholds against fixture distributions while building this panel.

**Non-goal.** Component 3 does NOT join `bt_runs` against `macro_regimes` — that is C-Component-5 (`bt_runs.macro_regime` join column + helpers). Strategy-by-regime gating is out of scope.

---

## 2. Pre-conditions

### 2.1 Schemas already in place

- `quantlab.macro_regimes` — DDL in [src/server/clickhouse.ts](../../src/server/clickhouse.ts) (`ensureBacktestTables`). 4,617 rows under `phase1_v2`; 4,568 with breadth populated.
- `quantlab.macro_breadth` — needed only transitively (Component 1 already consumes it). Component 3 reads `macro_regimes` directly.
- `quantlab.candles` — not read by Component 3. (Today's regime row already encodes `vix_close`, `hyg_close`, `spy_close`, `pct_above_50dma`.)

### 2.2 Server-side helpers already in place

- `fetchMacroRegime(asOfDate)` — [src/server/macro_regime.ts:806-823](../../src/server/macro_regime.ts#L806-L823). Pinned to `CLASSIFIER_VERSION='phase1_v2'`; returns the latest row at-or-before `asOfDate`.
- `fetchMacroRegimeRange(start, end, classifierVersion?)` — [src/server/macro_regime.ts:825-845](../../src/server/macro_regime.ts#L825-L845). Returns ASC-ordered rows in window.

Both are sufficient for Component 3. No new DB function needed.

### 2.3 ADRs in effect

- **ADR-037** — Phase 1 ships under `phase1_v2` with documented survivorship bias. The bias-quarantine banner in §3.3 is the operator-facing surface of this ADR's §5 honesty requirement.
- **ADR-035 §1** — historically superseded by ADR-037 but referenced in the bias provenance link list (the breadth-dark interim state was the prior-session ship).
- **ADR-036** — Phase 2 closure. Does not affect Component 3 directly; the dashboard treats `realized_stress` as "permanently 0 under `phase1_v2`" and labels it accordingly (see §3.5).

### 2.4 No upstream blockers

This SPEC is shippable today. Sharadar activation (Track B) does not block it; the route is built against `phase1_v2` and will read `phase1_v3` rows automatically once they exist (the version pin lives in `macro_regime.ts` `CLASSIFIER_VERSION`, not in the dashboard).

---

## 3. Component contracts

### 3.1 `GET /api/regime/state`

Powers the entire route. Single endpoint; the panels are computed client-side from one response object so the bias-quarantine banner can never desync from the today-row.

**Query params**

| Name | Type | Default | Range | Notes |
|---|---|---|---|---|
| `asOf` | string (ISO date) | latest available row's `trade_date` | any valid YYYY-MM-DD | Pin the dashboard to a historical date for replay; omit to follow live state. |
| `lookbackDays` | UInt32 | `252` | `[5, 5040]` | Drives the timeline panel and one of the distribution rollups; clamped at 5040 (~20Y) to bound the response. |

**Response shape (200)**

```ts
interface RegimeStateResponse {
  // ── Header / quarantine ────────────────────────────────────────────
  classifierVersion: string;          // 'phase1_v2' under current ship
  biasNote: {
    headline: string;                 // 'Survivorship-biased — `phase1_v2`'
    body: string;                     // ~2 sentences citing ADR-037
    docLinks: { label: string; href: string }[];  // ADR-037, bias_quantification.md, SPEC rev 3
    fixtureFailures: number;          // 4 today; reads from response, not hardcoded in UI
  };

  // ── D1 — today's regime ────────────────────────────────────────────
  asOfDate: string;                   // ISO; the actual row's date (may differ from query asOf if asOf > latest)
  isLatest: boolean;                  // true if asOfDate === latest available
  today: MacroRegimeRow;              // full row from quantlab.macro_regimes
  daysInCurrentRegime: number;        // count of consecutive trading days back from asOfDate with same regime label
  previousRegime: { regime: Regime; lastDate: string } | null;  // null if asOfDate is the very first row

  // ── D2 — 5d rolling-union window ───────────────────────────────────
  // Exactly the window the classifier uses for `red`. Length up to 5;
  // shorter only at the warmup boundary (first 4 trading days ever).
  fiveDayWindow: {
    date: string;
    vix_term_inverted: 0 | 1;
    hyg_spy_divergence: 0 | 1;
    breadth_narrow: 0 | 1;
    realized_stress: 0 | 1;           // dark under phase1_v2; reflected in panel D's footnote
    categories_firing: number;
  }[];

  // ── D3 — timeline + distribution ───────────────────────────────────
  timeline: {
    date: string;
    regime: Regime;
    signals_firing: number;
    categories_firing: number;
    categories_firing_5d: number;
  }[];                                // length = min(lookbackDays trading days, total available rows)

  distribution: {
    windowed: { lookbackDays: number; counts: RegimeCounts; pct: RegimeCounts };
    oneYear:  { tradingDays: number;  counts: RegimeCounts; pct: RegimeCounts };
    fiveYear: { tradingDays: number;  counts: RegimeCounts; pct: RegimeCounts };
    allTime:  { tradingDays: number;  counts: RegimeCounts; pct: RegimeCounts };
    baseline: { source: 'ADR-037'; counts: RegimeCounts; pct: RegimeCounts };
    // `deviation` per regime: pct(current windowed) - pct(baseline). Sign matters.
    deviation: RegimeCounts;          // float, percentage points
  };
}

interface RegimeCounts {
  red: number;
  orange: number;
  yellow: number;
  green: number;
}

type Regime = 'green' | 'yellow' | 'orange' | 'red';
```

**Errors**

| Code | When | Body |
|---|---|---|
| 400 | `asOf` not a valid ISO date | `{ error: 'bad_query', detail: '...' }` |
| 400 | `lookbackDays` out of range or NaN | `{ error: 'bad_query', detail: '...' }` |
| 503 | Zero rows under `phase1_v2` (CH live but empty) | `{ error: 'no_regime_rows', detail: 'run npm run macro:backfill first' }` |
| 500 | CH connection error | `{ error: 'clickhouse_unavailable', detail: e.message }` |

200 with `today === null` is **not** a valid state — if there are no rows, return 503; the UI must not show a colored regime block under a "no data" condition (silent miscommunication risk).

### 3.2 Pure helpers (testable without ClickHouse)

All in `src/server/regime_dashboard.ts`. The CH-touching entry point is `fetchRegimeState`; everything else is pure.

```ts
export function parseQuery(input: { asOf?: unknown; lookbackDays?: unknown }):
  | { ok: true; asOf: string | null; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function computeDaysInCurrentRegime(rows: MacroRegimeRow[], asOfDate: string): number;
//   rows: ASC-ordered window ending at asOfDate; rows[length-1].trade_date === asOfDate.
//   Returns the count of consecutive rows ending at asOfDate with the same `regime` label.

export function findPreviousRegime(rows: MacroRegimeRow[], asOfDate: string):
  { regime: Regime; lastDate: string } | null;
//   Walks back from asOfDate until the regime label changes; returns the
//   different prior label and its last-occurrence date. Null if no change in
//   the supplied rows (caller should widen the window or accept null).

export function buildFiveDayWindow(rows: MacroRegimeRow[]): RegimeStateResponse['fiveDayWindow'];
//   Takes the last up-to-5 rows; pads NOTHING (length is just min(5, rows.length)).
//   The UI is responsible for rendering missing days as a hatch — pure-function
//   stays honest about how many trading days exist.

export function rollUpDistribution(rows: MacroRegimeRow[]): RegimeCounts;
//   Pure histogram by `regime` field.

export const ADR_037_BASELINE: RegimeCounts;
//   Sourced from ADR-037 §5 + verified empirically 2026-05-10:
//     red=50, orange=78, yellow=1172, green=3317. Total 4617.
//   Hardcoded in this module (not queried) so the comparator survives the
//   eventual phase1_v3 cutover — at that point we add ADR_038_BASELINE and
//   pick by classifier_version.

export const BIAS_NOTE_PHASE1_V2: RegimeStateResponse['biasNote'];
//   Hardcoded literal mirroring ADR-037 §5. Component 1's CLASSIFIER_VERSION
//   change is the trigger to update this constant (paired in PR review).

export async function fetchRegimeState(args: {
  asOf?: string;
  lookbackDays: number;
}): Promise<RegimeStateResponse>;
//   The only impure entry point. Reads via fetchMacroRegimeRange + a small
//   directly-queried "latest row date" for asOf defaulting.
```

### 3.3 UI panels — `/#/regime`

Layout is single-column, dense, bottom-aligned to `0a0a0a` pattern (matches PaperTradingApp). Width is the full viewport at desktop; narrows to a stack at mobile (panels render in the order below).

**Panel A — Bias-quarantine banner.** Top of route, full-width, `bg-amber-500/10 border-amber-400/40`. Copy from `biasNote.headline` + `biasNote.body`. Three doc links (ADR-037, bias_quantification.md, SPEC rev 3) rendered as `<a target="_blank">`. The `fixtureFailures` count is shown as `4 of 628 fixtures intentionally failing under phase1_v2 — see ADR-037 §5`. **Decision supported (D4):** the operator never reads a regime label without seeing the survivorship caveat.

**Panel B — Today's regime + indicator strip.**
Left half: large color block (`bg-${regime}-500/20 border-${regime}-400/60`), regime label in 48pt mono, `daysInCurrentRegime` subtitle ("3 trading days yellow"), `asOfDate` + `isLatest` flag.
Right half: 4-cell horizontal strip, one per indicator category:
- **VIX TERM** — `vix_term_ratio.toFixed(3)` / `1.000`, fire pill from `vix_term_inverted`.
- **CREDIT** — `(hyg_20d_return * 100).toFixed(2)%` / `(spy_20d_return * 100).toFixed(2)%`, fire pill from `hyg_spy_divergence`. Also shows the 10d audit pair under a smaller font for transparency.
- **BREADTH** — `pct_above_50dma.toFixed(1)%` (or "—" if null), fire pill from `breadth_narrow`. Source label (`pct_above_50dma_source`) is shown directly so an operator can spot a breadth-dark fallback.
- **REALIZED STRESS (dark)** — `spy_drawdown_from_1y_high` shown as a percentage but pill is permanently grey under `phase1_v2` with the footnote `θ=null per Phase 2 SPEC §1.1; activates at phase2_v1`.
**Decision supported (D1):** the operator can verify the regime against raw data without trusting just the firing flags.

**Panel C — Regime timeline (252 trading days default).**
Horizontal heatmap, one column per trading day, full-width. Each column is `bg-${regime}-500/40` of about 4-6px wide. Hover surfaces a tooltip with `date / regime / categories_firing / categories_firing_5d`. Above the heatmap a thin lane shows `categories_firing` as a sparkline (0..3 today, 0..4 under future phase2_v1). **Decision supported (D3):** the operator sees regime persistence vs noise — a single yellow day is different from a yellow run.

**Panel D — 5-day rolling-union grid.** 4 rows (vix_term_inverted / hyg_spy_divergence / breadth_narrow / realized_stress) × 5 columns (oldest to today). Each cell is filled if the indicator fired that day. The realized_stress row is rendered with grey hatching to show "structurally dark, not absent." A "5d categories union: N/4" caption summarizes the count that drives `red`. **Decision supported (D2):** if the operator sees three rows with at least one fire in the window, they know orange could become red on one more fire — actionable information that a single label can't carry.

**Panel E — Distribution table.** 5-column wide table:
| Window | Red | Orange | Yellow | Green | n trading days |
|---|---|---|---|---|---|
| Last 252d (windowed) | x (y%) | ... | ... | ... | ... |
| Last 1Y | ... | ... | ... | ... | ... |
| Last 5Y | ... | ... | ... | ... | ... |
| All-time `phase1_v2` | 50 (1.1%) | 78 (1.7%) | 1172 (25.4%) | 3317 (71.8%) | 4617 |
| **Δ vs baseline** (windowed - baseline, pp) | ... | ... | ... | ... | — |
**Decision supported (D3):** the operator can answer "is this period regime-stressful by historical standards?" in one glance.

### 3.4 Routing + plumbing

- `src/main.tsx` — add `#/regime` lazy route mirroring `#/paper-trading`.
- `server.ts` — register `GET /api/regime/state`, query parse via `parseQuery`, body via `fetchRegimeState`. Pattern matches `/api/paper-trading/state` — including the `try/catch` wrapper that logs to console and returns 500.
- `src/components/regime/RegimeApp.tsx` — top-level route component. Self-fetches on mount + via a refresh button (mirrors PaperTradingApp).
- `src/components/regime/panels/` — one file per panel (BiasBanner, TodayPanel, IndicatorStrip, TimelineHeatmap, FiveDayGrid, DistributionTable). Stateless `({ data }) => JSX`.

---

## 4. Edge cases and failure modes

| Case | Behavior |
|---|---|
| `quantlab.macro_regimes` empty | Server returns 503 with `error: 'no_regime_rows'`. UI shows a single "No regime data — run `npm run macro:backfill`" card; no colored regime block. |
| `asOf` later than the latest row | Server clamps to the latest row's date and sets `isLatest: false` if the request specified a date after that; UI shows a small "showing latest available (asOf was ...)" badge. |
| `asOf` earlier than first available row | 400 with `detail: 'asOf precedes earliest classified date YYYY-MM-DD'`. |
| `lookbackDays > available rows` | Timeline + windowed distribution silently shrink to the available count; response's `windowed.lookbackDays` reports `min(requested, available)` so the UI can show the actual count. |
| `daysInCurrentRegime` extends beyond loaded window | The window-load size is `max(lookbackDays, 252)` precisely so the regime-streak count rarely needs a second query; if it still does (a yellow regime running >252d, possible per ADR-037 distribution), the orchestrator widens by another 1Y once. Documented in `computeDaysInCurrentRegime` header. |
| First 4 rows ever (phase1_v2 warmup boundary) | `fiveDayWindow.length < 5`. Panel D pads visually with a neutral hatch — **not zero-fills**, since a zero-fill would lie about whether the indicator fired. |
| Request hits during ingest write | `quantlab.macro_regimes FINAL` is used by `fetchMacroRegimeRange`, so concurrent writes are safe (last-writer wins per `ReplacingMergeTree(ingested_at)`). |
| Future `phase1_v3` cutover | Once Component 1 flips `CLASSIFIER_VERSION`, the dashboard reads v3 rows automatically. The bias-banner copy MUST be updated in the same PR — `BIAS_NOTE_PHASE1_V2` becomes `BIAS_NOTE_PHASE1_V3` (or no banner if v3 is unbiased). Watch-out captured in §6. |

---

## 5. Test list

`scripts/tests/regimeDashboard.test.ts` — TS unit tests, no CH connection.

1. `parseQuery` — happy path with both params present; defaults applied when absent.
2. `parseQuery` — 400 on bad ISO `asOf`, 400 on `lookbackDays=0`, 400 on `lookbackDays=10000`, 400 on `lookbackDays='abc'`.
3. `computeDaysInCurrentRegime` — 5-day yellow streak ending at `asOfDate` returns 5.
4. `computeDaysInCurrentRegime` — single-day regime with prior different label returns 1.
5. `computeDaysInCurrentRegime` — empty rows returns 0; `asOfDate` not present in rows returns 0.
6. `findPreviousRegime` — correctly identifies the last-occurrence-before-flip; returns null if no flip in window.
7. `buildFiveDayWindow` — exactly 5 rows → length 5 with rows in ASC order; 3 rows → length 3 (no padding); 0 rows → length 0.
8. `rollUpDistribution` — counts match a hand-traced fixture (3 reds, 2 oranges, 5 yellows, 10 greens).
9. `ADR_037_BASELINE` — total equals 4617 and matches HANDOFF "verified empirically 2026-05-10" numbers exactly. (This is a regression-against-snapshot test; if Component 1's distribution shifts, this test fails and the bias-banner must be updated in the same PR.)
10. `BIAS_NOTE_PHASE1_V2` — `headline` mentions `phase1_v2`, `body` mentions `survivorship`, `docLinks.length >= 3` and includes ADR-037 path.

A separate smoke test (`scripts/tests/regimeDashboardRoute.test.ts`) calls `GET /api/regime/state` against a tiny in-memory CH stub and asserts the response satisfies the TypeScript shape (used `@clickhouse/client`'s mock). **DEFERRED** if the tiny-stub setup is non-trivial; the unit tests above cover the contract.

`npm test` baseline before this work: `624 passing, 4 failing`. After: `~634 passing, 4 failing`. The 4 failing fixtures are unchanged (they belong to Component 1, not Component 3). If a test count moves outside this band, investigate before merging.

---

## 6. Watch-outs / "what could break this"

- **Bias-banner copy is load-bearing.** If a future session edits `CLASSIFIER_VERSION` without updating `BIAS_NOTE_PHASE1_V2`, the dashboard will silently mislabel the bias state. Test 10 catches one half of this (the constant must mention the right version); the human discipline is to grep for `phase1_v2` in this file at every classifier-version bump.
- **`ADR_037_BASELINE` will drift if `npm run macro:backfill` re-runs over a wider date range.** Today's all-time = 4617 trading days under `phase1_v2`. If the backfill window extends, the baseline counts shift. Test 9 catches this; the resolution is to update the constant *and* the SPEC §3.3 Panel E example numbers in the same PR.
- **The "regime persistence" claim in Panel C is visual, not statistical.** A long run of one color does not by itself mean the regime is statistically more persistent than a draw from the marginal distribution would suggest. If the user starts using Panel C to make persistence claims, point at this watch-out and consider a Phase 3 component for a proper Markov-transition-matrix view.
- **`realized_stress` rendered grey is intentional.** A future session might "fix" the dark indicator by populating it once Phase 2 reopens — under the current SPEC, that's wrong: Phase 2 closure (ADR-036) means the indicator stays dark structurally, not transiently. The grey hatching + footnote is the correct user-facing state.
- **Single-endpoint coupling.** All five panels read from one response. This is intentional (banner + label can never desync), but it means a payload-shape change is a 5-panel touch. Keep the shape changes in `src/server/regime_dashboard.ts`'s exported types and let TypeScript surface the affected panels.
- **No PII / auth concerns.** This is read-only over public-market regime data.

---

## 7. Implementation order (CODE entry)

1. `src/server/regime_dashboard.ts` — types + pure helpers + `fetchRegimeState`. Cite this SPEC at the top.
2. `scripts/tests/regimeDashboard.test.ts` — 10 tests above. Green before any UI code lands.
3. `server.ts` — register `/api/regime/state` route, modeled on `/api/paper-trading/state`.
4. `src/components/regime/RegimeApp.tsx` + panels under `src/components/regime/panels/`. Stateless presentational components.
5. `src/main.tsx` — add `#/regime` lazy route.
6. Smoke-run `npm run dev`, visit `/#/regime`, verify all 5 panels render against live CH.
7. `npm test` shows new count, no regressions. `npx tsc --noEmit` clean.
8. Update HANDOFF.md "Files / code state" + "Pre-loaded operational reminders" with the new route and test command.

This order keeps the contract (server types) ahead of the UI and the tests ahead of the route registration — failure modes surface in the test layer, not in a manual browser session.
