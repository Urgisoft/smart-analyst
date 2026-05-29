# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #27 — **Cycle 33 OPEN, slice 1 shipped. The
catch-up UI cycle has its REFERENCE PANEL: one reusable `CompositeDetailApp`
parameterized by a per-composite `CompositeDescriptor`, with vol_structure wired
as the first of the 7 backend-only composites to get a real panel.** The panel
carries the full bug-finding overlay (anomaly banner / position-on-scale z-bars
with ±σ band / coverage strip / data lineage / verdict firing-lane) + a pure,
unit-tested anomaly scan that explicitly catches the OQ-C31-1 z=27 artifact at
render time. Live API smoke caught + fixed a ClickHouse alias-shadowing bug in
the new `loadHistory`. Critic verdict AUTO-APPROVE. One commit this session
(`1684ba1`).**
**NEXT on `continue`:** Cycle 33 slice 2 — wire the remaining composites onto
the reference panel. **Slice 2a MUST first extend the descriptor for
variable-length per-sector/asset z-arrays (OQ-C33-1)** before sector_rotation +
cross_asset can reuse it; then form_4 (needs dual buy/sell grouping, OQ-C33-2),
then a bespoke 13D/G event-timeline, then retrofit the anomaly overlay onto the
existing `EtfFlowApp`.

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
| Q-4 | Push 107 unpushed commits to origin/main | Carry-over; +1 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not a queue item):** the new `/#/vol-structure` panel is built + API-
validated + builds clean, but the FINAL visual browser check is the one gate I
can't run headlessly — please eyeball it at http://localhost:3000/#/vol-structure
when convenient (dev server is already running). Expect: verdict `normal`, 5/5
coverage, an info-level STALE flag (snapshot 5d old — known daemon staleness),
all z-scores in-band, a 501-day firing lane.

---

## What this session delivered (s96 #27 Cycle 33 slice 1)

The reusable composite-detail architecture + the vol_structure reference panel.
This restores the per-slice UI rule (`feedback_ui_validation_each_slice`) that
had drifted — 7 composites had shipped backend-only.

| Commit | Slice |
| --- | --- |
| `1684ba1` | Cycle 33 slice 1 — reusable `CompositeDetailApp(descriptor)` + vol_structure reference panel (S96-148). 12 files, +1819 LOC, 27 new tests. |

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

**Carry-overs (still in force):** S96-145 (Finnhub = insider backfill source),
S96-146 (form_4 EDGAR/Finnhub granularity mismatch — Phase-B-SPEC blocker),
S96-147 (Cycle 33 = catch-up UI cycle), S96-1..S96-144; all prior s73-s95
lock-ins.

---

## Open questions

### NEW this session (descriptor-shape gaps — surfaced by the critic; gate the next slices)
- **OQ-C33-1** — **per-sector / per-asset z-arrays.** `sector_rotation` and
  `cross_asset` snapshots carry N parallel z-series (one per GICS sector / per
  asset), not a fixed named metric set. The current `CompositeDescriptor.metrics`
  is a flat fixed list and `history[].metrics` is a `Record<string,number|null>`.
  Slice 2a must extend the descriptor (dynamic/templated metric generation OR a
  payload extension carrying the per-sector array) BEFORE wiring those two. The
  vol_structure impl itself is correct as-is; this is an additive extension.
- **OQ-C33-2** — **form_4 dual buy/sell axes.** form_4 has two verdict lanes /
  two metric groups (buy-cluster + sell-cluster). No descriptor slot for grouping
  yet. Needs a `metricGroups`-style extension + the per-ticker drill + coverage
  banner (per S96-147 design). Also still blocked from Phase B by S96-146.

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

### Default on `continue` — Cycle 33 slice 2: wire the rest onto the reference panel

Build order (per S96-147 + the critic's reuse-gap notes):
1. **Slice 2a — descriptor extension for per-sector/asset z-arrays (OQ-C33-1)**,
   then wire **`sector_rotation`** (reference for the array variant) — a
   `/api/sector-rotation` projection + `SectorRotationApp` wrapper + descriptor +
   route/nav. Then **`cross_asset`** (same variant; regimeFlag verdict). Use the
   `cross_asset_snapshots_repository.ts` + `sector_rotation_repository.ts`
   read-side; add an additive `loadHistory` using the **subquery-around-FINAL
   pattern (S96-149)** to each.
2. **`form_4`** — needs the dual buy/sell grouping (OQ-C33-2) + per-ticker drill +
   a coverage banner (Finnhub ~1 row/filing). Highest bug-surface; the anomaly
   scan's DEGENERATE_BASELINE check is the OQ-C31-1 guard here.
3. **Bespoke `schedule_13d_g`** event-timeline panel (no z-scores; event list).
4. **Retrofit** the anomaly overlay onto the existing `EtfFlowApp`.
5. Remaining: `short_interest`, `executive_departure`, `eight_k_classifier`
   (EDGAR-family — watch throttle) — each is a descriptor + wrapper once 2a lands.

Each panel ships browser-validated (the dev server is already running; restart
after server edits).

### After Cycle 33
- **form_4 Phase B SPEC** — must FIRST resolve S96-146 (source-granularity
  normalization), then run the DSR/PBO/HLZ deflation campaign.
- Cross-composite meta-HLZ pass once a 5th composite is PARTIAL.

---

## Files / code state

### New / modified this session (all in commit `1684ba1`)
| Path | Change |
| --- | --- |
| `src/server/composite_detail.ts` | NEW — shared wire contract + pure helpers |
| `src/server/vol_structure_dashboard.ts` | NEW — vol_structure projection + parseQuery |
| `src/server/vol_structure_repository.ts` | +additive read-only `loadHistory` (subquery-around-FINAL) |
| `src/components/composite/anomalyScan.ts` | NEW — pure anomaly scan |
| `src/components/composite/descriptors.ts` | NEW — descriptor type + volStructureDescriptor |
| `src/components/composite/CompositeDetailApp.tsx` | NEW — reusable 5-section panel |
| `src/components/composite/VolStructApp.tsx` | NEW — thin wrapper |
| `scripts/tests/compositeDetailDashboard.test.ts` | NEW — helpers + dashboard projection tests |
| `scripts/tests/compositeAnomalyScan.test.ts` | NEW — anomaly scan tests (z=27 catcher) |
| `server.ts` | +`/api/vol-structure` route |
| `src/main.tsx` | +`#/vol-structure` lazy route |
| `src/App.tsx` | +"Vol structure →" nav link |

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
- **OQ-C33-1 / OQ-C33-2** descriptor-shape gaps gate slice 2 — do NOT try to
  wire sector_rotation/cross_asset/form_4 onto the descriptor as-is; extend it
  first.
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

**Default on `continue` — Cycle 33 slice 2 (S96-147 continued):** FIRST extend
`CompositeDescriptor` for per-sector/asset z-arrays (OQ-C33-1), then wire
`sector_rotation` + `cross_asset`; then `form_4` (dual buy/sell, OQ-C33-2);
bespoke `schedule_13d_g`; retrofit the anomaly overlay onto `EtfFlowApp`. Every
composite `loadHistory` uses the subquery-around-FINAL pattern (S96-149). Each
panel browser-validated.

**Do NOT auto-open without operator green-light:** form_4 Phase B (blocked on
S96-146); Phase C promotion; ALTER DROP/DELETE; `git push` (Q-4); bulk EDGAR
Form 4 backfills (throttled — use Finnhub); broker integration; real-money path.

---

## Important framing for the next chat

**Cycle 33 is the catch-up UI cycle; slice 1 (the reference panel) is DONE.**
There is now ONE reusable `CompositeDetailApp(descriptor)` with the full
bug-finding overlay, and `vol_structure` is wired as the live reference at
`/#/vol-structure`. The hard architectural work — the normalized wire contract,
the pure unit-tested anomaly scan (which catches the OQ-C31-1 z=27 failure mode
at render time), the descriptor abstraction — is locked in (S96-148). Adding the
remaining 6 composites is now mostly mechanical: a projection + a descriptor + a
10-line wrapper each.

**The one architectural extension still owed (slice 2a):** the descriptor + payload
need to handle variable-length per-sector/asset z-arrays (sector_rotation,
cross_asset — OQ-C33-1) and form_4's dual buy/sell grouping (OQ-C33-2). vol_structure
(a fixed named z-set) is the clean reference; those two variants come next.

**The 9-arc:** ✓ cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1 (PARTIAL,
Phase B); 🚧 form_4_insider_v1 (data healed; Phase B blocked on S96-146);
☐ short_interest, exec_departure, etf_flow, eight_k. **UI coverage:** regime +
cycle_position + etf_flow + **vol_structure (NEW)** now have real panels; the
other 6 backend-only composites get panels through the rest of Cycle 33.
