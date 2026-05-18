# SPEC — Phase 2 §5.5: Cluster axis dashboard

> **Status:** DRAFT — produced from the 2026-05-04 DESIGN turn; SPEC stage output, no critic pass yet · **Author:** producer (Claude) · **Authority:** [Phase 2 §5.5](phase-2-behavioral-clustering.md#55-dashboard-panels-design-deferred), [ADR-014](../decisions/README.md#adr-014--zero-volatility-assets-out-of-universe-cluster-1-hard-exclusion--single-cohort-publication-path), [HANDOFF "Next stage" §1](../../.claude/HANDOFF.md)
>
> **Stage in Vector Core build:** SPEC. DESIGN closed in the same turn. CODE follows.

This SPEC expands the deferred §5.5 of [phase-2-behavioral-clustering.md](phase-2-behavioral-clustering.md). All schemas (`cluster_diagnostics_weekly`, `strategy_scores_by_cluster`, `token_cluster_membership`) are unchanged — this is a read-side feature.

---

## 1. Goal and exit gate

**Goal.** Surface the cluster-axis universe state and the cluster-axis four-gate scores in the dashboard so the user can answer two decisions without leaving the UI:

- **D1.** "Is this week's universe definition stable enough to trust the cluster-axis scores written against it?"
- **D2.** "Given the admitted cohort, which strategy × interval clears all four gates — and is the cluster axis doing real work versus the tier axis?"

**Exit gate.** All of:

1. Visiting `/#/cluster` renders both panels with live data from ClickHouse — no placeholder data, no mocks.
2. Panel A's tile-strip shows ≥ 3 weeks of HDBSCAN diagnostics with status, q-score, n-admitted, and the right-side detail block populated for the latest week.
3. Panel B's row table shows all rows from `strategy_scores_by_cluster FINAL` for the latest published `fit_id`, sorted by `composite DESC, dsr DESC`, with four-gate pills + tier-axis comparator chip + IS/OOS strip.
4. A click on a Panel B row opens `/#/validator?axis=cluster&strategy=…&clusterId=…&interval=…` and the validator's sweep-mode form is pre-populated from the URL params.
5. New tests green: ~9 TS unit tests (endpoint shape parity, panel render edge cases, URL hydration), 0 Python (no Python touched).
6. `npm test` shows the new count, no regressions. `npx tsc --noEmit` clean.

**Non-exit-gate.** Survivor cell on the cluster axis. Today's data has 0/4 cells passing all gates; the panel must render that absence honestly (per §3.5 empty state) — it is not a build blocker.

---

## 2. Pre-conditions

### 2.1 Schemas already in place

- `quantlab.cluster_diagnostics_weekly` — DDL in [scripts/cluster_tokens_weekly.py:107-127](../../scripts/cluster_tokens_weekly.py#L107-L127). Currently 10 rows.
- `quantlab.strategy_scores_by_cluster` — DDL in [scripts/score_strategies_by_cluster.ts:107-142](../../scripts/score_strategies_by_cluster.ts#L107-L142). Currently 4 rows.
- `quantlab.token_cluster_membership` — DDL in [src/server/clickhouse.ts:361-374](../../src/server/clickhouse.ts#L361-L374). Currently 3962 rows; 91 admitted for week 2026-05-04.
- `quantlab.strategy_scores` — existing tier-axis score table; needed for the comparator chip.
- `quantlab.bt_runs` — needed for the cohort-composition tier mix.

### 2.2 Prerequisite cleanup (must ship before §3.4 Panel A)

These are HANDOFF MEDIUM open items today; they do not corrupt computation but they would silently mislead the user inside Panel A:

- **PRE-1.** Orphan rows in `cluster_diagnostics_weekly` — fix by reordering `main()` in [scripts/cluster_tokens_weekly.py](../../scripts/cluster_tokens_weekly.py) so diagnostics are inserted **after** membership writes. Without this, Panel A's amber "orphan" chip will fire on any future failed-mid-run week. Re-run for the 2 existing orphan rows is optional (Panel A's chip is the right surface).
- **PRE-2.** Misleading "0 clusters in current admitted membership" log line in [scripts/score_strategies_by_cluster.ts](../../scripts/score_strategies_by_cluster.ts). The script DID score 4 cells correctly; the log query aggregation filters too tight. ~10-line investigation. Without this, Panel B's "91 admitted" header will disagree with the script log when the user runs `npm run score:by-cluster` and watches both at once.

Both PREs land as one small ADR-line bundled into CODE entry (§7); they don't need their own SPEC.

### 2.3 ADRs in effect

- **ADR-010, ADR-014** — universe definition methodology (already Accepted).
- **ADR-006** — lockstep validator path; the `?axis=cluster` route already implements this. URL-param hydration in §3.6 is plumbing, not a new validator codepath.

### 2.4 ADR-line follow-up not blocking this SPEC

The HLZ M-scope question raised in HANDOFF (M=cells vs M=cluster_id under `single_cohort`) is orthogonal to the dashboard. Panel B reads whatever values `strategy_scores_by_cluster.gates_pass / hlz_t_passes` already store. If the ADR-line later changes scoring semantics, Panel B reflects the new values automatically.

---

## 3. Component contracts

### 3.1 `GET /api/cluster/diagnostics`

Powers Panel A.

**Query params**

| Name | Type | Default | Range | Notes |
|---|---|---|---|---|
| `weeks` | UInt32 | `12` | `[1, 52]` | Lookback window in weeks. |
| `method` | string | `'hdbscan'` | `'hdbscan' \| 'gmm_bic'` | Production axis is HDBSCAN; GMM is diagnostic-only. |

**Response shape** (200)

```ts
interface ClusterDiagnosticsResponse {
  method: 'hdbscan' | 'gmm_bic';
  weeks: number;          // echoed back, clamped to range
  rows: ClusterDiagnosticsRow[];   // one per week, ordered by week_start ASC
  thresholds: {
    qScore: 0.5;           // Q_SCORE_THRESHOLD from cluster_tokens_weekly.py
    disagreement: 1;       // DISAGREEMENT_TOLERANCE
    tradeabilityVol: 0.10; // TRADEABILITY_VOL_THRESHOLD (annualized vol)
    staleFitDays: 8;       // amber-chip threshold for fit age (OQ-D3 default)
  };
}

interface ClusterDiagnosticsRow {
  weekStart: string;            // ISO date 'YYYY-MM-DD'
  fitId: string;                // selected via lexicographic-largest tie-break (modalFitId)
  status: 'published' | 'single_cohort' | 'q_below_threshold'
        | 'unstable' | 'degenerate' | 'untradeable';
  nClustersHdb: number;
  nClustersGmm: number | null;  // null if no GMM row exists for this week
  nDisagreement: number;        // -1 sentinel = GMM convergence failure
  qScore: number | null;        // null if NaN in source
  silhouette: number | null;
  calinskiHarabasz: number | null;
  nTokensInput: number;
  nTokensClustered: number;
  nNoise: number;
  nAdmitted: number;            // count(token_cluster_membership WHERE method, admitted, valid_from = weekStart)
  fitSeconds: number;
  computedAt: string;           // ISO timestamp
  hasOrphans: boolean;          // true iff > 1 fit_id row exists for this (weekStart, method)
                                // and the non-modal fit_ids have no membership rows
  cohortComposition: {          // only populated for the LATEST week's row (others: null)
    dominantTier: string;       // e.g. 'mcap_micro'
    dominantPct: number;        // 0..1
    isFragmented: boolean;      // dominantPct < 0.60 (OQ-D2 threshold)
    breakdown: { tier: string; pct: number }[];  // top 5, sorted by pct desc
  } | null;
}
```

**Errors**

| Status | `error` | When |
|---|---|---|
| 400 | `bad_query` | `weeks` non-numeric or out of range; `method` not in enum. |
| 503 | `clickhouse_unavailable` | CH driver throws. |
| 500 | `internal` | Unexpected. |

**SQL behavior**

Single round trip, three-CTE query:

```sql
WITH latest_fits AS (
  SELECT week_start, method,
         max(fit_id) AS fit_id   -- lexicographic max = modalFitId tie-break
  FROM quantlab.cluster_diagnostics_weekly FINAL
  WHERE week_start >= today() - INTERVAL {weeks:UInt32} WEEK
    AND method = {method:String}
  GROUP BY week_start, method
),
admitted_counts AS (
  SELECT valid_from AS week_start, fit_id, count() AS n_admitted
  FROM quantlab.token_cluster_membership FINAL
  WHERE method = {method:String} AND admitted = true
  GROUP BY valid_from, fit_id
),
orphan_flags AS (
  SELECT week_start, method,
         countDistinct(fit_id) > 1 AS has_orphans
  FROM quantlab.cluster_diagnostics_weekly FINAL
  WHERE week_start >= today() - INTERVAL {weeks:UInt32} WEEK
    AND method = {method:String}
  GROUP BY week_start, method
)
SELECT d.*, ac.n_admitted, of.has_orphans
FROM quantlab.cluster_diagnostics_weekly d FINAL
INNER JOIN latest_fits lf USING (week_start, method, fit_id)
LEFT  JOIN admitted_counts ac ON ac.week_start = d.week_start AND ac.fit_id = d.fit_id
LEFT  JOIN orphan_flags of    ON of.week_start = d.week_start AND of.method = d.method
ORDER BY d.week_start ASC
```

The cohort-composition rollup is a separate query against `bt_runs` (latest `tier` per `token_address`, joined to admitted membership for the latest week). Two queries total to keep each one auditable.

**Cohort composition query** (only run if `rows.length > 0`; result attached to the latest row):

```sql
WITH admitted_latest AS (
  SELECT token_address
  FROM quantlab.token_cluster_membership FINAL
  WHERE method = 'hdbscan' AND admitted = true
    AND valid_from = {latestWeek:Date} AND fit_id = {latestFitId:UUID}
),
latest_tier AS (
  SELECT token_address, argMax(tier, started_at) AS tier
  FROM quantlab.bt_runs FINAL
  WHERE token_address IN (SELECT token_address FROM admitted_latest)
  GROUP BY token_address
)
SELECT tier, count() AS n
FROM latest_tier
GROUP BY tier
ORDER BY n DESC
LIMIT 10
```

Tier choice (OQ-D1 resolution): most recent `bt_runs.tier` per token. Static metadata source rejected because `quantlab.token_metadata` does not carry `tier` directly — it carries the inputs (mcap, vol, beta) — and reproducing the tier-classification logic in two places would violate ADR-002.

### 3.2 `GET /api/cluster/scores`

Powers Panel B.

**Query params**

| Name | Type | Default | Notes |
|---|---|---|---|
| `fitId` | string (UUID) | latest published `fit_id` from `cluster_diagnostics_weekly` for `method='hdbscan'` and `status IN ('published', 'single_cohort')` | Picks the rows scoped to that fit. Empty result if none match. |
| `limit` | UInt32 | `50` | Range `[1, 200]`. |

**Response shape** (200)

```ts
interface ClusterScoresResponse {
  fitId: string;                // resolved fit_id used for this query
  weekStart: string;            // ISO date — week the fit was published
  status: ClusterDiagnosticsRow['status'];
  fitAgeDays: number;           // (today - weekStart) in whole days
  isStale: boolean;             // fitAgeDays > thresholds.staleFitDays
  rows: ClusterScoreRow[];      // sorted by composite DESC, dsr DESC, then strategy ASC
  cohort: {                     // mirrors ClusterDiagnosticsRow.cohortComposition
    dominantTier: string;
    dominantPct: number;
    isFragmented: boolean;
    nAdmitted: number;
  };
}

interface ClusterScoreRow {
  strategyType: string;
  clusterId: number;
  interval: string;
  bestParam: number;
  composite: number;            // 0 = failed at least one gate
  // Gate values + verdicts
  dsr: number;
  psr: number;
  pbo: number | null;
  hlzTPasses: boolean;
  oosIsRatio: number;
  oosIsStatus: string;
  gatesPass: boolean;            // gates_pass === 1
  // Aggregate metrics
  nTokensTotal: number;
  nTokensTraded: number;
  nTokensWinning: number;
  nTokensInCluster: number;
  totalTrades: number;
  wtNetPct: number;
  oosWtNetPct: number;
  aggPf: number;
  // Sub-dimension scores (mirrors Top_Strategies palette)
  oosNorm: number;
  plateau: number;
  tierCoverage: number;
  tradesNorm: number;
  // Tier-axis comparator (the load-bearing payoff column)
  tierAxisCompare: {
    tier: string;
    composite: number;
    dsr: number;
    oosIsRatio: number;
    deltaDsr: number;            // this row's dsr - tier-axis dsr
    deltaComposite: number;
  } | null;                      // null if no matching strategy_scores row exists
  // Canonical-interpretation hint (rendered as inline note when truthy)
  deflationCollapseHint: string | null;
  // ^ non-null when psr >= 0.95 AND dsr <= 0.05 — set to:
  //   "PSR=N.NN / DSR=N.NN — selection-bias deflation; see check.md FB-01"
}
```

**Errors**

| Status | `error` | When |
|---|---|---|
| 400 | `bad_query` | `limit` out of range; `fitId` not a valid UUID. |
| 404 | `no_published_fit` | No `fitId` provided AND no row in `cluster_diagnostics_weekly` matches `method='hdbscan' AND status IN ('published','single_cohort')`. |
| 503 | `clickhouse_unavailable` | CH throws. |
| 500 | `internal` | Unexpected. |

**SQL behavior**

Three queries:

1. Resolve `fitId` (if not given) and pull `(weekStart, status, fitAgeDays)`:
   ```sql
   SELECT week_start, status, fit_id
   FROM quantlab.cluster_diagnostics_weekly FINAL
   WHERE method = 'hdbscan'
     AND status IN ('published', 'single_cohort')
   ORDER BY week_start DESC, fit_id DESC
   LIMIT 1
   ```
2. Pull the score rows scoped to the fit:
   ```sql
   SELECT *
   FROM quantlab.strategy_scores_by_cluster FINAL
   WHERE fit_id = {fitId:String}
   ORDER BY composite DESC, dsr DESC, strategy_type ASC
   LIMIT {limit:UInt32}
   ```
3. Pull tier-axis comparator rows in one batch:
   ```sql
   SELECT strategy_type, tier, interval,
          composite, dsr, oos_is_ratio
   FROM quantlab.strategy_scores FINAL
   WHERE (strategy_type, interval) IN ({pairs:Array(Tuple(String, String))})
     AND tier = {dominantTier:String}
   ```
   Joined in TS by `(strategy_type, interval)`. If a row has no matching tier-axis sibling, `tierAxisCompare = null`. If the cohort is `isFragmented`, all rows get `tierAxisCompare = null` (per OQ-D2: one tier-Δ is dishonest).

The cohort composition is the same query as §3.1 but always run (§3.2 doesn't get to skip it; the comparator depends on `dominantTier`).

### 3.3 Hash-route registration

Update [src/main.tsx](../../src/main.tsx) to dispatch `/#/cluster`. The current dispatch tests `hash === '#/validator' || hash.startsWith('#/validator/')`, which does NOT match `#/validator?axis=cluster` — fixed at the same time as a side-effect of needing URL-param parsing in §3.6.

```ts
// Add lazy import alongside ValidatorApp
const ClusterApp = lazy(() => import('./components/cluster/ClusterApp.tsx'));

// In Router(): split hash on '?' so query strings don't break route matching
const path = hash.split('?')[0];
if (path === '#/validator' || path.startsWith('#/validator/')) { ... }
if (path === '#/cluster' || path.startsWith('#/cluster/')) {
  return (
    <Suspense fallback={…cluster fallback…}>
      <ClusterApp />
    </Suspense>
  );
}
```

A header chip in [src/App.tsx](../../src/App.tsx) (placement: alongside the existing validator entry chip if one exists; otherwise top-right of the main header) — single `<a href="#/cluster">` link, label "Cluster axis →", same micro-typography as the existing validator chip.

### 3.4 `src/components/cluster/ClusterApp.tsx` — route shell

Top-level container. Mounted by `main.tsx` when hash matches `#/cluster`. Mirrors [ValidatorApp.tsx](../../src/components/validator/ValidatorApp.tsx) layout idiom: full-bleed dark shell, top header bar with route label + back-to-terminal link, single `main` with two stacked panels.

```ts
export default function ClusterApp() {
  // No router state; the panels are independent and self-fetch on mount.
  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <header className="h-16 border-b border-[#1a1a1a] flex items-center justify-between px-8 bg-black">
        {/* Title chip "VECTOR_CLUSTER · Behavioral Universe" + Terminal link */}
      </header>
      <main className="p-6 space-y-6">
        <ClusterDiagnosticsPanel />
        <ClusterScoresPanel />
      </main>
    </div>
  );
}
```

The panels do not share state. Panel B fetches its own `cohort` block; Panel A fetches its own. (Race: if Panel A re-fetches after a manual refresh and pulls a different `fitId` than Panel B, they'd disagree. Acceptable for v1 — neither panel has refresh affordances, both fetch once on mount.)

### 3.5 `src/components/cluster/ClusterDiagnosticsPanel.tsx`

```ts
interface Props {}                   // self-fetching, no props

interface State {
  data: ClusterDiagnosticsResponse | null;
  loading: boolean;
  error: string | null;
}
```

**Render branches**

| State | Render |
|---|---|
| `loading` | Skeleton: 8 muted-gray tile placeholders + a muted detail block. |
| `error` | Red-bordered card: "Cluster diagnostics unavailable — `{error}`". No retry button (browser refresh is the affordance). |
| `data && rows.length === 0` | Yellow-bordered card: "No HDBSCAN diagnostics in the last `{weeks}` weeks. Run `npm run cluster:weekly`." |
| `data && rows.length > 0` | Tile strip + detail block per DESIGN. |

**Tile component** — `<DiagnosticsTile row={row} thresholds={thresholds} isLatest={i === rows.length - 1} />`.

Tile background tier (matches DESIGN):

```ts
const TILE_BG: Record<ClusterDiagnosticsRow['status'], string> = {
  published:        'bg-emerald-500/[0.06] border-emerald-400/30',
  single_cohort:    'bg-emerald-500/[0.06] border-emerald-400/30',
  q_below_threshold:'bg-yellow-500/[0.06] border-yellow-400/30',
  unstable:         'bg-red-500/[0.06] border-red-400/30',
  degenerate:       'bg-red-500/[0.06] border-red-400/30',
  untradeable:      'bg-red-500/[0.06] border-red-400/30',
};
```

Tile content (top to bottom):
1. Date "MM-DD" (8px caps, gray-500).
2. `k=H/G` where H=`nClustersHdb`, G=`nClustersGmm ?? '—'`. Red ring on the GMM digit if `nDisagreement > thresholds.disagreement`.
3. q-score bar: 0..1 with vertical marker at 0.5; numeric below, red if `< 0.5`.
4. "N admitted" — yellow if N=0, white otherwise.
5. Status label, 8px caps, color matching tile tier.
6. Orphan dot (top-right corner) if `hasOrphans`.

**Detail block** (right of strip, only when `data.rows.length > 0`):

| Sub-block | Source | Notes |
|---|---|---|
| Status callout | `latest.status` | Emerald/yellow/red text, h2 size. |
| Reason sentence | Derived from `latest.status` + values | e.g. `single_cohort` → "1 tradeable cohort + N hard-excluded; gate bypassed per ADR-014". Sentence map in §3.5.1 below. |
| Numeric column | `qScore`, `silhouette`, `calinskiHarabasz`, `nDisagreement` | Each labeled, mono digits. Red value if below threshold. |
| Cohort composition mini-strip | `latest.cohortComposition` | Horizontal segmented bar (one segment per tier in `breakdown`), labeled with `dominantTier dominantPct%`. |
| Fit metadata | `latest.fitId.slice(0,8)`, `latest.computedAt`, `latest.fitSeconds` | Mono micro-text. |
| Orphan chip | `latest.hasOrphans` | Amber chip "orphan diagnostic rows present — run cleanup (HANDOFF MEDIUM-3)". |
| Stale chip | `(today - weekStart) > staleFitDays` | Amber chip "fit is N days old". |

#### 3.5.1 Status → reason-sentence map (canon-grounded)

```ts
const REASON: Record<Status, (r: Row) => string> = {
  published:         r => `${r.nClustersHdb} clusters published; q=${r.qScore?.toFixed(2)}; both methods agree within ${r.nDisagreement} cluster.`,
  single_cohort:     r => `1 tradeable cohort + ${r.nClustersHdb - 1} hard-excluded; disagreement-gate bypassed per ADR-014.`,
  q_below_threshold: r => `q-score ${r.qScore?.toFixed(2)} < 0.50 — partition not stable across bootstraps; membership not updated.`,
  unstable:          r => `Δk = ${r.nDisagreement} > 1 — HDBSCAN and GMM disagree; membership not updated.`,
  degenerate:        r => `HDBSCAN found 0 non-noise clusters — feature space degenerate.`,
  untradeable:       r => `All clusters below tradeability vol (≥ 0.10 ann); nothing to publish for trading.`,
};
```

### 3.6 `src/components/cluster/ClusterScoresPanel.tsx`

```ts
interface Props {}                   // self-fetching

interface State {
  data: ClusterScoresResponse | null;
  loading: boolean;
  error: string | null;
}
```

**Render branches**

| State | Render |
|---|---|
| `loading` | Skeleton header + 4 muted row placeholders. |
| `error` (status 404 `no_published_fit`) | Yellow-bordered card: "No published HDBSCAN fit — run `npm run cluster:weekly` for a recent week." |
| `error` (other) | Red-bordered card. |
| `data && rows.length === 0` | Yellow-bordered card: "Fit `{fitId.slice(0,8)}` has no scored cells — run `npm run score:by-cluster`." |
| `data && rows.length > 0` | Header + row table per DESIGN. |

**Header content**

```
{cluster_name} (HDB cluster {clusterId of first row, since single_cohort}) ·
{cohort.nAdmitted} admitted · fit_id {fitId.slice(0,8)} · week {weekStart}
[isStale ? amber chip "fit is {fitAgeDays} days old"]
```

The "{cluster_name}" is a derived label from cohort composition (e.g. if `dominantTier === 'mcap_micro'` and `dominantPct >= 0.6`, label "cluster_solana_mid" — which under today's data is the truth, but is **inferred from data, not stored anywhere**). For v1, just show "HDB cluster {N}" without a friendly name. Friendly-naming is a separate ADR-line later if real data warrants.

Headline summary chip (above row table):
- If `rows.every(r => !r.gatesPass)`: red chip `{rows.length} of {rows.length} cells fail at least one gate · system working as designed`.
- Else: emerald chip `{rows.filter(r => r.gatesPass).length} of {rows.length} cells clear all four gates`.

**Row component** — `<ClusterScoreRow row={row} thresholds={…} onClick={…} />`.

Row body matches the DESIGN sketch. Click handler:

```ts
function rowClick(row: ClusterScoreRow) {
  const params = new URLSearchParams({
    axis: 'cluster',
    strategy: row.strategyType,
    clusterId: String(row.clusterId),
    interval: row.interval,
  });
  window.location.hash = `/validator?${params.toString()}`;
}
```

Four-gate pill encoding (status mapped to existing `STATUS_TOKENS` from [VerdictPanel.tsx:16-38](../../src/components/validator/VerdictPanel.tsx#L16-L38)):

```ts
const gateStatus = (passed: boolean | null, value: number | null): 'pass' | 'fail' | 'na' => {
  if (value === null) return 'na';
  return passed ? 'pass' : 'fail';
};

const pills = [
  { label: 'DSR',    value: row.dsr,           status: gateStatus(row.dsr >= dsrGate, row.dsr) },
  { label: 'PBO',    value: row.pbo,           status: gateStatus(row.pbo !== null && row.pbo < pboGate, row.pbo) },
  { label: 'HLZ',    value: null,              status: gateStatus(row.hlzTPasses, row.hlzTPasses ? 1 : 0) },
  { label: 'OOS/IS', value: row.oosIsRatio,    status: gateStatus(row.oosIsRatio >= pardoGate, row.oosIsRatio) },
];
```

Tier-axis comparator chip — one of three states:
- `null` (cohort is fragmented, or no matching tier-axis row): no chip rendered.
- `deltaDsr > 0`: emerald chip `vs tier ({tier}): DSR Δ +{deltaDsr.toFixed(2)}`.
- `deltaDsr <= 0`: red chip `vs tier ({tier}): DSR Δ {deltaDsr.toFixed(2)}`.

`deflationCollapseHint` — when truthy, appended as an italic gray-400 line beneath the IS/OOS strip. Server-side derivation rule:

```ts
if (psr >= 0.95 && dsr <= 0.05) {
  return `PSR=${psr.toFixed(2)} / DSR=${dsr.toFixed(2)} — selection-bias deflation; see check.md FB-01`;
}
return null;
```

### 3.7 `ValidatorApp` URL-param hydration

Update [src/components/validator/ValidatorApp.tsx](../../src/components/validator/ValidatorApp.tsx) to read query params from `location.hash` on mount and forward them to `InputPanel` as initial state.

```ts
function readHashParams(): InitialSweepState | null {
  const q = window.location.hash.split('?')[1];
  if (!q) return null;
  const p = new URLSearchParams(q);
  const axis = p.get('axis');                   // 'cluster' | 'tier' | null
  if (axis !== 'cluster' && axis !== 'tier') return null;
  const strategy = p.get('strategy') ?? '';
  const interval = p.get('interval') ?? '';
  if (axis === 'cluster') {
    const clusterIdStr = p.get('clusterId');
    if (clusterIdStr === null) return null;
    const clusterId = Number(clusterIdStr);
    if (!Number.isFinite(clusterId) || !Number.isInteger(clusterId)) return null;
    return { axis: 'cluster', strategy, interval, clusterId };
  }
  return { axis: 'tier', strategy, interval, tier: p.get('tier') ?? '' };
}
```

`InputPanel` gains an optional prop `initialSweepState?: InitialSweepState`; when present, it sets sweep mode active and pre-fills the relevant fields. Auto-submission is **NOT** done — the user must click Score, so they always see the inputs they're about to validate. (PUSHBACK: never silently dispatch a side-effect from a URL.)

Edge cases:
- Param malformed (e.g. `clusterId=abc`): hydration is `null`, panel falls back to default empty state. No error toast — the URL is informational.
- Param valid but cell doesn't exist in `/api/validator/cells?axis=cluster` response: form pre-fills, user clicks Score, server returns `404 cluster_cell_not_found`, existing error path handles it.

---

## 4. Failure modes / what could break this

- **F-1.** `cohort.dominantTier` resolved from `bt_runs.tier` returns nothing if no admitted token has a `bt_runs` row yet. Mitigation: response sets `cohort = null` and Panel B falls back to `tierAxisCompare = null` for all rows. Panel A's composition strip simply omits.
- **F-2.** A score row's `fit_id` references a `cluster_diagnostics_weekly` row that has been replaced (ReplacingMergeTree FINAL'd away) — `tierAxisCompare`'s tier resolution still works because it depends on cohort composition, not on the diagnostic row itself.
- **F-3.** Panel A queries 12 weeks of diagnostics; on a fresh DB with 0 rows, Panel A renders the empty state and Panel B's "no published fit" 404. **NO** crash, **NO** placeholder data.
- **F-4.** ReplacingMergeTree without `FINAL` would let an orphan diagnostic row supersede a real one in the latest_fits CTE. All three SQL queries above use `FINAL` explicitly.
- **F-5.** URL-param hydration into ValidatorApp could be exploited to pre-fill malicious-looking values (e.g. emoji in `strategy`). Mitigation: existing `parseScoreClusterRequest` ([src/lib/validator_cluster_request.ts:39-58](../../src/lib/validator_cluster_request.ts#L39-L58)) validates server-side; the front-end form just rejects on submit. No XSS surface — fields render in inputs / datalist value attributes only.
- **F-6.** The `axis === 'cluster'` URL hydration triggers a `GET /api/validator/cells?axis=cluster` fetch that the ValidatorApp's `InputPanel` already does on mode switch. Race: if hydration runs before the cells fetch resolves, the datalist is empty for one render. Acceptable; existing behavior under user-driven mode switch.
- **F-7.** The diagnostics endpoint's cohort composition query joins `bt_runs FINAL` over potentially many rows. Bound by `token_address IN (admitted_latest)` — admitted set is ≤ 200 tokens — keeps this cheap.

---

## 5. Acceptance criteria

### 5.1 Quantitative

- [ ] `GET /api/cluster/diagnostics?weeks=4&method=hdbscan` returns 3 rows on the current DB (3 weeks of diagnostics).
- [ ] `GET /api/cluster/scores` (no params) returns 4 rows on the current DB, ordered with `mean_reversion_v1 / cluster_0 / 1d / p=5` first.
- [ ] First Panel B row's `deflationCollapseHint` is non-null (PSR=1.00 / DSR=0.00).
- [ ] First Panel B row's `tierAxisCompare` is non-null (assuming `dominantTier` resolves to a tier present in `strategy_scores`).
- [ ] Click on first Panel B row navigates to `#/validator?axis=cluster&strategy=mean_reversion_v1&clusterId=0&interval=1d`; the validator's sweep-mode form is pre-filled.

### 5.2 Test gate

- [ ] All new TS unit tests green (§6).
- [ ] `npm test` total = `408 + new count`, no regressions.
- [ ] `npx tsc --noEmit` clean.
- [ ] Python tests unchanged at 28/28.

### 5.3 What to do if exit gate fails

- **Cohort composition empty.** PRE-1 likely means the latest week's admitted-token set has no `bt_runs` rows. Verify with `SELECT count() FROM bt_runs WHERE token_address IN (admitted_set)`. If zero, the panel renders "tier mix unavailable" — don't fabricate.
- **Tier-axis comparator always null.** Either the cohort is fragmented (correct behavior) or `strategy_scores` has no row for `(strategyType, interval, dominantTier)`. Both are legitimate — verify with a direct CH query before tweaking the panel.
- **`fitAgeDays` shows wrong value.** Time zone bug. Always compute `fitAgeDays` server-side from `today() - week_start` in CH, not from JS `new Date()`.

---

## 6. Tests to add (CODE stage)

### 6.1 TS — `scripts/tests/clusterDiagnosticsRoute.test.ts`

- **T-D1.** Endpoint returns rows ordered `weekStart ASC`.
- **T-D2.** `weeks` clamping: requests with `weeks=0` and `weeks=999` both return 400 `bad_query`.
- **T-D3.** Stale-fit threshold echoed back at `8` (regression-pin OQ-D3).
- **T-D4.** Cohort composition is non-null only on the latest row; older rows have it `null`.

### 6.2 TS — `scripts/tests/clusterScoresRoute.test.ts`

- **T-S1.** Empty `strategy_scores_by_cluster` for the resolved fit_id returns 200 with `rows: []` (not 404).
- **T-S2.** No `published`/`single_cohort` fit returns 404 `no_published_fit`.
- **T-S3.** `deflationCollapseHint` non-null iff `psr >= 0.95 && dsr <= 0.05` (parameterized fixture).
- **T-S4.** When `cohort.isFragmented === true`, every row's `tierAxisCompare` is null.
- **T-S5.** Sort order: `composite DESC, dsr DESC, strategy_type ASC` — pin with a 3-row fixture.

### 6.3 TS — `src/components/cluster/__tests__/clusterRouter.test.tsx`

- **T-R1.** `readHashParams` returns valid object for `#/cluster` → `null`, `#/validator?axis=cluster&strategy=x&clusterId=0&interval=1d` → populated, `?clusterId=abc` → `null`.

### 6.4 Lockstep — `scripts/tests/clusterScoresPanelDeflationHint.test.ts`

- **T-S6.** Renderer puts the hint exactly once, in the row body (smoke-render with React Testing Library if available, else by checking the JSON serialization of the panel's data to result that contains the hint string).

### 6.5 Smoke (no test file, manual verification gate)

- **SMK-1.** Open `/#/cluster` in a browser; both panels render with live data; click a row; validator opens with form pre-filled.

---

## 7. Build order (CODE stage)

Sequential because Panel B depends on `cohort` resolution from Panel A's data path:

1. **PRE-1, PRE-2** (orphan-row reorder + log-line investigation). One commit. ~30 min.
2. **§3.1 endpoint** + tests T-D1..T-D4. ~1.5h.
3. **§3.2 endpoint** + tests T-S1..T-S5. ~1.5h.
4. **§3.3 router + §3.4 ClusterApp shell.** ~30 min.
5. **§3.5 ClusterDiagnosticsPanel.** ~1.5h.
6. **§3.6 ClusterScoresPanel** + T-S6. ~2h.
7. **§3.7 ValidatorApp URL-param hydration** + T-R1. ~30 min.
8. **SMK-1** manual verification + HANDOFF rewrite if state changed materially.

Total estimate: **~7.5h producer time** (1-2 sessions).

---

## 8. Out of scope for this SPEC

- Multi-cluster `published` UI (cluster-id selector). Defer until data exists.
- Token-churn diff between fits.
- Cross-axis merged ranking inside Top_Strategies.
- Refresh affordances on the cluster panels.
- Friendly cluster naming (e.g. "cluster_solana_mid"). Inferred-from-data labeling stays out of v1; if real data warrants, follow-on ADR-line.
- Storing `tier` per token in dedicated metadata. The dashboard reads from `bt_runs.tier` per OQ-D1 resolution; revisit only if drift > 10%.
- Auto-submission from URL params in the validator route (PUSHBACK rule on silent side-effects).

---

## 9. Sign-off

DRAFT → ACCEPTED on:
1. Critic-agent pass on this file (BLOCKING items resolved).
2. User acknowledgment of OQ-D1..D4 default resolutions in §3.

Per the project's no-confirmation-pauses rule, CODE entry begins immediately on next session unless the user vetoes a §3 default. CODE entry is the build order in §7, starting with PRE-1.
