# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #27 — **Cycle 33 OPEN, slices 1 + 2a shipped.
The catch-up UI cycle now has THREE composites on the reusable `CompositeDetailApp`:
vol_structure (slice 1, the reference) + sector_rotation + cross_asset (slice 2a).
Each is a server projection + a descriptor + a ~10-line wrapper — no new rendering
code, proving the S96-148 architecture.** The shared panel carries the full
bug-finding overlay (anomaly banner / position-on-scale z-bars with ±σ band /
coverage strip / data lineage / verdict firing-lane) + a pure unit-tested anomaly
scan that catches the OQ-C31-1 z=27 artifact at render time. **OQ-C33-1 RESOLVED
(no descriptor extension needed): sector_rotation + cross_asset persist FIXED
named-metric snapshots, NOT per-sector/asset z-arrays — the per-sector returns are
inputs, never persisted.** Three commits this session (`1684ba1`, `f7495fa`, +
HANDOFFs). Both critic passes AUTO-APPROVE.**
**NEXT on `continue`:** Cycle 33 slice 2b — **form_4** (the genuine descriptor
extension: dual buy/sell grouping, OQ-C33-2, + per-ticker drill + Finnhub coverage
banner). Then a bespoke 13D/G event-timeline, then retrofit the anomaly overlay
onto the existing `EtfFlowApp`, then short_interest / exec_departure / eight_k
(each a projection + descriptor + wrapper once their snapshot tables are populated).

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker
Desktop. On reboot (this session restarted twice mid-cycle):

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll until the container is up: `docker start quantlab-clickhouse` in a loop;
   then wait for `docker inspect --format '{{.State.Health.Status}}'
   quantlab-clickhouse` = `healthy` (~30-60s after engine ready).
3. Verify `SELECT 1` before any CH work. (Raw curl w/o creds returns an auth
   error even when CH is up — that's expected; the app uses the configured client.)

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. It is
NOT hot-reloading; restart it after server-side edits. **As of this handoff the
dev server is RUNNING in the background** so the operator can visually validate
the new panel at **http://localhost:3000/#/vol-structure**.

**Re-run the Finnhub insider backfill (idempotent; if data is ever lost):**
```
FINNHUB_API_KEY=<operator key from Cline financial-hub MCP config> \
  .venv/Scripts/python.exe scripts/finnhub_insider_ingest.py \
  --from-date 2024-01-01 --to-date <today> --apply
```

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model change
ratified 2026-05-23 (s96 #14), every routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push 110 unpushed commits to origin/main | Carry-over; +4 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not a queue item):** three new panels are built + API-validated + build
clean, but the FINAL visual browser check is the one gate I can't run headlessly
— please eyeball them when convenient (dev server is already running on :3000):
`/#/vol-structure`, `/#/sector-rotation`, `/#/cross-asset`. All three: verdict
`normal`, 6/6 (sector/cross) or 5/5 (vol) coverage, an info-level STALE flag
(snapshots ~5d old — known daemon staleness), z-scores in-band, 501-day firing
lanes. sector_rotation shows "Most-concentrated sector: XLE"; cross_asset shows
"0 of 5 stress flags · 0 of 2 inverted segments".

---

## What this session delivered (s96 #27 Cycle 33 slices 1 + 2a)

The reusable composite-detail architecture + THREE live panels (vol_structure,
sector_rotation, cross_asset). This restores the per-slice UI rule
(`feedback_ui_validation_each_slice`) that had drifted — 7 composites had
shipped backend-only.

| Commit | Slice |
| --- | --- |
| `1684ba1` | Cycle 33 slice 1 — reusable `CompositeDetailApp(descriptor)` + vol_structure reference panel (S96-148). 12 files, +1819 LOC, 27 new tests. |
| `f7495fa` | Cycle 33 slice 2a — sector_rotation + cross_asset onto the panel. 13 files, +1051 LOC, 12 new tests. Resolved OQ-C33-1 (no descriptor extension needed) + added the optional `context` field. |

### What landed
- **`src/server/composite_detail.ts`** — the NORMALIZED wire contract every
  `/api/<composite>` route projects onto: `{ verdict, metrics[] (named z + raw),
  flags[], inputsPresent bitmask, history[], staleDays, sourceTable, ... }` +
  pure helpers `popcount` / `computeStaleDays` / `emptyCompositeDetail`. CH-free.
- **`src/components/composite/anomalyScan.ts`** — pure client-side scan:
  NON_FINITE / OUT_OF_BAND(_CRIT) / NO_COVERAGE / COVERAGE_DEGRADED / STALE /
  UNKNOWN_VERDICT / DEGENERATE_BASELINE / DISCONTINUITY, sorted worst-first. The
  z=27 + zero-inflated-baseline (OQ-C31-1) case is an explicit test.
- **`src/components/composite/descriptors.ts`** — `CompositeDescriptor` type +
  `volStructureDescriptor` + `toAnomalyScanConfig`.
- **`src/components/composite/CompositeDetailApp.tsx`** — the reusable 5-section
  panel + anomaly banner + lineage + glossary. Hand-rolled SVG; `null`→`—`;
  inline-hex accent/tone colors (dynamic Tailwind classes would be purged).
- **`src/components/composite/VolStructApp.tsx`** — ~10-line wrapper.
- **`src/server/vol_structure_dashboard.ts`** — `fetchVolStructureState`
  projection + `parseQuery` (mirrors `cycle_position_dashboard.ts`).
- **`src/server/vol_structure_repository.ts`** — additive read-only `loadHistory`
  + `VolStructureHistoryRow`.
- Wiring: `server.ts` `/api/vol-structure`, `main.tsx` `#/vol-structure` lazy
  route, `App.tsx` "Vol structure →" nav link.

### Verification gates (all green)
```
npx tsc --noEmit                                                          # 13 baseline unchanged
node --import tsx --test scripts/tests/compositeAnomalyScan.test.ts \
     scripts/tests/compositeDetailDashboard.test.ts                       # 27 pass (incl. z=27 catcher)
node --import tsx --test scripts/tests/volStructureRepository.test.ts \
     scripts/tests/volStructure.test.ts                                   # 63 pass (regression)
curl localhost:3000/api/vol-structure            # 200, hasData=true, 501 history pts
curl localhost:3000/api/vol-structure?lookbackDays=5   # 400 bad_query
npx vite build                                   # clean; VolStructApp chunk bundles
```
Critic (general-purpose, §3.3 prompt): **AUTO-APPROVE** (no real-money path, no
DDL, no paid data; one optional nit applied — `Number.isFinite` guard on the ZBar
value label).

---

## Decisions locked in

### Session 96 #27 (Cycle 33 slice 1)

**S96-148. The 7 backend-only composites are surfaced by ONE reusable
`CompositeDetailApp`, parameterized by a `CompositeDescriptor`, fed by a
NORMALIZED `CompositeDetailPayload` that each `/api/<composite>` route projects
its own snapshot onto.** `Why:` the composites share a snapshot shape (named
z-scores + boolean flags + `inputs_present` bitmask + discrete verdict + daily
series); one component + per-composite data (descriptor) = 7 panels for ~1 panel
of test surface (per `[[ui-design-principles]]`). `How to apply:` adding a
composite = (1) a server projection `fetch<X>State` → `CompositeDetailPayload`
(template: `vol_structure_dashboard.ts`); (2) a descriptor entry; (3) a
~10-line `<X>App` wrapper; (4) route + lazy hash route + nav link. No new
rendering code. The bug-finding overlay (anomaly scan + bars-with-band +
coverage strip + lineage) is built into the shared component, so every panel
gets it for free.

**S96-149 (watch-out — ClickHouse alias-shadowing).** A history query of the form
`SELECT toString(snapshot_date) AS snapshot_date ... WHERE snapshot_date <=
{x:Date}` makes CH bind the WHERE to the String *alias*, not the Date column →
`no supertype for String, Date`. Fix = the subquery-around-FINAL pattern (filter
on the raw column inside, `toString` only in the outer SELECT). This is the
documented a52c964 bug class; the live API smoke test caught it. **Every future
composite `loadHistory` must use the subquery pattern.**

**S96-150 (Cycle 33 slice 2a — OQ-C33-1 resolution + the `context` field).**
sector_rotation + cross_asset wired onto `CompositeDetailApp` with NO descriptor
extension — both persist a FIXED named-metric snapshot, not a per-sector/asset
z-array (the per-sector returns are inputs, aggregated and never persisted). The
slice-1 critic's array hypothesis was inferred from the composite NAMES; the
actual schema (`SectorRotationSnapshot` / `CrossAssetSignalsSnapshot`) is a flat
named-scalar set. `Why:` confirms the S96-148 descriptor handles the
fixed-named-metric family as-is. `How to apply:` before assuming a snapshot's
shape, READ the persisted `*Snapshot` interface — not the composite's input
shape. The only generalization added was an optional
`CompositeDetailPayload.context: {label,value}[]` for categorical info
(most-concentrated sector; flag/segment counts), rendered as a hero strip.

**Carry-overs (still in force):** S96-145 (Finnhub = insider backfill source),
S96-146 (form_4 EDGAR/Finnhub granularity mismatch — Phase-B-SPEC blocker),
S96-147 (Cycle 33 = catch-up UI cycle), S96-1..S96-144; all prior s73-s95
lock-ins.

---

## Open questions

### RESOLVED this session
- **OQ-C33-1 — CLOSED (no descriptor extension needed).** The slice-1 critic
  *hypothesized* sector_rotation/cross_asset carry variable-length per-sector/asset
  z-arrays. Slice 2a inspected the ACTUAL persisted snapshots: both
  `SectorRotationSnapshot` and `CrossAssetSignalsSnapshot` store a FIXED set of
  named scalar fields (aggregated defensive/cyclical means + spread z + top-share z
  for sector; one credit-internals z + raw flag-drivers for cross_asset). The 11
  per-sector returns/volumes are INPUTS, aggregated and never persisted. So they
  fit the existing fixed-metric descriptor as-is — wired directly. The only
  addition was an optional `context` field for categorical info (most-concentrated
  sector symbol; active-flag/inverted-segment counts). Critic independently
  verified. **Lesson: verify the persisted schema before assuming snapshot shape
  from the composite's name.**

### STILL OPEN (gates the next slice)
- **OQ-C33-2** — **form_4 dual buy/sell axes.** form_4 IS the genuine descriptor
  extension (unlike sector/cross_asset). It has two verdict lanes / two metric
  groups (buy-cluster + sell-cluster). No descriptor slot for grouping yet. Needs
  a `metricGroups`-style extension + the per-ticker drill + coverage banner (per
  S96-147 design). Also still blocked from Phase B by S96-146 (Phase B only; the
  UI panel is not Phase-B-gated).

### OPEN (carried)
- **S96-146** — form_4 Phase B SPEC must normalize EDGAR/Finnhub source
  granularity. THE form_4 Phase-B blocker.
- **OQ-C32-2** — Finnhub coverage caveats (~1 row/filing; 2024-09 + 2025-09 thin;
  SP500-only). Re-evaluate at Phase B SPEC.
- **OQ-C31-4** — `INSERT…SELECT FROM <self>` no-ops in this CH build; workaround
  in `_anchor_gics_sector_pit.ts`.
- **EDGAR throttle lesson** — prefer a managed source (Finnhub-style) or heavy
  pacing for any bulk EDGAR backfill.
- **CARRIED:** OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2,
  OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — Cycle 33 slice 2b: form_4 (the genuine descriptor extension)

Slices 1 + 2a are DONE (vol_structure + sector_rotation + cross_asset live).
Build order for the rest:
1. **Slice 2b — `form_4`.** This IS the descriptor extension OQ-C33-2 describes
   (sector/cross_asset did NOT need one). form_4 has TWO metric groups
   (buy-cluster + sell-cluster) / two verdict lanes. Extend `CompositeDescriptor`
   with a `metricGroups`-style grouping, add a per-ticker drill, and a coverage
   banner (Finnhub ~1 row/filing, SP500-only — OQ-C32-2). Data is in
   `insider_trades` (289k rows) + `form_4_insider_snapshots` (98 rows). Add an
   additive `loadHistory` to its repository using the **subquery-around-FINAL
   pattern (S96-149)**. The anomaly scan's DEGENERATE_BASELINE check is the
   OQ-C31-1 guard here. UI panel is NOT Phase-B-gated (Phase B is blocked on
   S96-146, but that's a separate, later concern).
2. **Bespoke `schedule_13d_g`** event-timeline panel (no z-scores; event list) —
   table is empty, so it ships an empty-state until `edgar:13d-g:ingest` runs.
3. **Retrofit** the anomaly overlay onto the existing `EtfFlowApp`.
4. Remaining: `short_interest`, `executive_departure`, `eight_k_classifier`
   (EDGAR-family — watch throttle) — each is a projection + descriptor + wrapper
   once their snapshot tables are populated (all currently empty/never-run).

Each panel ships browser-validated (the dev server is already running; restart
after server edits). Sector/cross_asset proved the pattern: a fixed-named-metric
composite = projection + descriptor + ~10-line wrapper, no new rendering code.

### After Cycle 33
- **form_4 Phase B SPEC** — must FIRST resolve S96-146 (source-granularity
  normalization), then run the DSR/PBO/HLZ deflation campaign.
- Cross-composite meta-HLZ pass once a 5th composite is PARTIAL.

---

## Files / code state

### Slice 1 — commit `1684ba1` (the reusable architecture)
| Path | Change |
| --- | --- |
| `src/server/composite_detail.ts` | NEW — shared wire contract + pure helpers (+`context` field in 2a) |
| `src/server/vol_structure_dashboard.ts` | NEW — vol_structure projection + parseQuery |
| `src/server/vol_structure_repository.ts` | +additive read-only `loadHistory` (subquery-around-FINAL) |
| `src/components/composite/anomalyScan.ts` | NEW — pure anomaly scan |
| `src/components/composite/descriptors.ts` | NEW — descriptor type + volStructureDescriptor (+2 descriptors in 2a) |
| `src/components/composite/CompositeDetailApp.tsx` | NEW — reusable 5-section panel (+context strip in 2a) |
| `src/components/composite/VolStructApp.tsx` | NEW — thin wrapper |
| `scripts/tests/compositeDetailDashboard.test.ts` | NEW — helpers + dashboard projection tests |
| `scripts/tests/compositeAnomalyScan.test.ts` | NEW — anomaly scan tests (z=27 catcher) |
| `server.ts` / `src/main.tsx` / `src/App.tsx` | +`/api/vol-structure` route + `#/vol-structure` lazy route + nav link |

### Slice 2a — commit `f7495fa` (sector_rotation + cross_asset)
| Path | Change |
| --- | --- |
| `src/server/composite_detail.ts` | +optional `context: CompositeContextItem[]` (additive) |
| `src/server/sector_rotation_dashboard.ts` | NEW — projection + parseQuery |
| `src/server/cross_asset_dashboard.ts` | NEW — projection + parseQuery |
| `src/server/sector_rotation_repository.ts` | +additive `loadHistory` + `SectorRotationHistoryRow` (subquery-around-FINAL) |
| `src/server/cross_asset_snapshots_repository.ts` | +additive `loadHistory` + `CrossAssetHistoryRow` (subquery-around-FINAL) |
| `src/components/composite/descriptors.ts` | +sectorRotationDescriptor (amber) + crossAssetDescriptor (rose) |
| `src/components/composite/CompositeDetailApp.tsx` | +renders `context` strip in the state hero |
| `src/components/composite/{SectorRotationApp,CrossAssetApp}.tsx` | NEW — ~10-line wrappers |
| `scripts/tests/compositeDashboards2.test.ts` | NEW — projection + context tests (12) |
| `server.ts` / `src/main.tsx` / `src/App.tsx` | +`/api/sector-rotation` + `/api/cross-asset` routes + lazy routes + nav links |

No DDL. No real-money path. No authenticated scrape. tsc baseline 13.

### DB-state (unchanged from Cycle 32)
- `vol_structure_snapshots`: ~3,368 rows (latest 2026-05-24; daemon ~5d stale —
  known, not a regression). Powers the new panel with real data.
- `insider_trades`: 289,225 rows; `cik_ticker_map`: 7,992; `gics_sector_map`:
  1,006; `form_4_insider_snapshots`: 98.
- Empty/missing: `short_interest`, `executive_departure`, `schedule_13d_g`,
  `eight_k_events`, `etf_shares_outstanding`.

---

## Watch-outs

### NEW this session
- **S96-149 alias-shadowing** (above) — subquery-around-FINAL is mandatory for
  every composite `loadHistory`.
- **OQ-C33-1 RESOLVED** — sector_rotation/cross_asset fit the descriptor as-is
  (fixed named metrics, verified against the persisted schema). **OQ-C33-2
  (form_4 dual buy/sell) is the ONE remaining genuine descriptor extension** —
  gates slice 2b. Lesson: read the persisted `*Snapshot` interface before
  assuming shape; the per-sector arrays are inputs, never persisted.
- **Dynamic Tailwind classes get purged** — the reusable panel uses inline-hex
  for accent/tone colors on purpose. New composites pass a tailwind color *stem*
  (`accent: 'cyan'`); add the hex to `ACCENT_HEX` in `CompositeDetailApp.tsx` if
  the stem isn't already there.
- **Dev server is running** on :3000 (background) for operator visual validation;
  it does NOT hot-reload server edits.
- **Browser-visual validation is the one gate I can't run headlessly** — API
  smoke + vite build + tsc + tests are green; the operator's eyeball on
  `/#/vol-structure` is the final confirmation.

### Carried
All prior watch-outs (Finnhub ~1 row/filing + synthetic person_cik; EDGAR per-IP
throttle; gics PIT-anchor required on wipe; CH-Date range; sp500_constituents PIT
gap-window) preserved.

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot:
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse   # loop until healthy
# Dev server (visual validation):
npm run dev                        # http://localhost:3000/#/vol-structure
# Cycle 33 tests:
node --import tsx --test scripts/tests/compositeAnomalyScan.test.ts scripts/tests/compositeDetailDashboard.test.ts
# Gates:
npx tsc --noEmit                   # 13 baseline
npm run health:check
npm run daemon:daily               # composites ~5d stale (known)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 33 slice 2b (S96-147 continued):** wire `form_4`
— extend `CompositeDescriptor` with a `metricGroups` (dual buy/sell, OQ-C33-2) +
per-ticker drill + Finnhub coverage banner; data in `insider_trades` (289k) +
`form_4_insider_snapshots` (98). Then bespoke `schedule_13d_g` event-timeline;
retrofit the anomaly overlay onto `EtfFlowApp`; then short_interest /
exec_departure / eight_k (empty tables → empty-states). Every composite
`loadHistory` uses the subquery-around-FINAL pattern (S96-149). Each panel
browser-validated.

**Do NOT auto-open without operator green-light:** form_4 Phase B (blocked on
S96-146); Phase C promotion; ALTER DROP/DELETE; `git push` (Q-4); bulk EDGAR
Form 4 backfills (throttled — use Finnhub); broker integration; real-money path.

---

## Important framing for the next chat

**Cycle 33 is the catch-up UI cycle; slices 1 + 2a are DONE.** There is ONE
reusable `CompositeDetailApp(descriptor)` with the full bug-finding overlay, and
THREE composites are live on it: `vol_structure` (`/#/vol-structure`),
`sector_rotation` (`/#/sector-rotation`), `cross_asset` (`/#/cross-asset`). The
architecture (S96-148) is proven: a fixed-named-metric composite = a projection +
a descriptor + a ~10-line wrapper, no new rendering code.

**OQ-C33-1 turned out NOT to need an extension** — sector/cross_asset persist
fixed named-metric snapshots (verified against the actual schema; the per-sector
arrays are inputs only). **The one genuine descriptor extension still owed is
form_4's dual buy/sell grouping (OQ-C33-2) — slice 2b, next.**

**The 9-arc:** ✓ cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1 (PARTIAL,
Phase B); 🚧 form_4_insider_v1 (data healed; Phase B blocked on S96-146);
☐ short_interest, exec_departure, etf_flow, eight_k. **UI coverage:** regime +
cycle_position + etf_flow + **vol_structure + sector_rotation + cross_asset (NEW)**
= 6 live panels. Remaining backend-only: form_4 (next), schedule_13d_g,
short_interest, executive_departure, eight_k_classifier (the last four have
empty/never-run snapshot tables → ship empty-states until ingested).
