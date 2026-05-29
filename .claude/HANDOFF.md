# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #28 — **Cycle 33 slice 2b shipped: the `form_4`
insider panel — the ONE genuine descriptor extension of Cycle 33 (OQ-C33-2 RESOLVED).**
form_4 is dual-axis (buy-cluster + symmetric sell-cluster, Lakonishok-Lee 2001 §3/§4),
so it needed real extensions the three fixed-metric composites did not: an optional
`CompositeDescriptor.metricGroups` (buy/sell lanes, emerald/rose) + an optional
`CompositeDetailPayload.drill` (generic per-entity table — the 62 per-ticker rows). Both
are ADDITIVE: the three existing panels set neither, so they render byte-unchanged. The
server projection derives the verdict from the two cluster flags (form_4 persists no
discrete regime) + surfaces the Finnhub/SP500 coverage caveat (OQ-C32-2). **The
reusable `CompositeDetailApp` now covers BOTH composite families: fixed-single-metric
(vol/sector/cross) AND dual-axis-with-drill (form_4) — proving S96-148 generalizes.**
One commit this session (`c414f0f`). Critic: AUTO-APPROVE. UI panel coverage = 7 live.**
**NEXT on `continue`:** Cycle 33 slice 3 — bespoke `schedule_13d_g` event-timeline
(empty-state until `edgar:13d-g:ingest` runs), then retrofit the anomaly overlay onto
the existing `EtfFlowApp`, then short_interest / exec_departure / eight_k (each a
projection + descriptor + wrapper once their snapshot tables are populated — all
currently empty/never-run).

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker
Desktop. On reboot:

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll until up: `docker start quantlab-clickhouse` in a loop; then wait for
   `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse` =
   `healthy` (~30-60s after engine ready). This session: engine up ~5s, healthy ~15s.
3. Verify `SELECT 1` before any CH work. (Raw curl w/o creds returns an auth
   error even when CH is up — expected; the app uses the configured client.)

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT
hot-reloading; restart after server-side edits. **As of this handoff the dev
server is RUNNING in the background** so the operator can visually validate the
new panel at **http://localhost:3000/#/form-4-insider**.

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
| Q-4 | Push 111 unpushed commits to origin/main | Carry-over; +1 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not a queue item):** four panels now built + API-validated + build clean.
The FINAL visual browser check is the one gate I can't run headlessly — please
eyeball them when convenient (dev server already running on :3000):
`/#/vol-structure`, `/#/sector-rotation`, `/#/cross-asset`, **`/#/form-4-insider`
(NEW)**. The form_4 panel correctly **screams a red anomaly banner on render**:
`OUT_OF_BAND_CRIT` on the buy-cluster z=5.57 (Health Care) — see S96-152 below;
that is the intended bug-finding-first behavior, not a panel bug.

---

## What this session delivered (s96 #28 Cycle 33 slice 2b)

`form_4` onto the reusable panel — the genuine dual-axis descriptor extension.

| Commit | Slice |
| --- | --- |
| `c414f0f` | Cycle 33 slice 2b — form_4 insider panel (dual buy/sell + per-ticker drill). 10 files, +1070/−12 LOC, 18 new tests. Resolved OQ-C33-2. |

### What landed
- **`src/server/composite_detail.ts`** — +optional `drill?: CompositeDrillTable`
  on the payload (generic per-entity table: `columns[]` w/ `format`
  text|num|usd|bool|days + `rows[]` w/ `emphasis` buy|sell|none + `note`).
  Additive — the 3 existing panels omit it.
- **`src/components/composite/descriptors.ts`** — +`CompositeMetricGroup` type +
  optional `metricGroups?` on `CompositeDescriptor` + the `form4InsiderDescriptor`
  (dual buy/sell groups, emerald/rose; 2-layer inputBits AGG-SECTORS/PER-TICKER).
- **`src/components/composite/CompositeDetailApp.tsx`** — `MetricBars` +
  `HistoryPanel` now render grouped (one accented sub-panel per metricGroup) when
  `metricGroups` is set, flat otherwise (extracted shared `MetricSet`); +new
  `DrillTable` section gated on `payload.drill`; +`fmtUsd`/`fmtCell` helpers.
- **`src/server/form_4_dashboard.ts`** (NEW) — `fetchForm4InsiderState` +
  `projectPayload` + `deriveVerdict` (buy/sell flags → dual_cluster/buy_cluster/
  sell_cluster/normal/unknown) + `buildDrill` (62 per-ticker rows, cluster-first
  then |net$| desc, capped 60 w/ explicit cap note) + 2-layer coverage mask.
- **`src/server/form_4_insider_repository.ts`** — +additive read-only `loadHistory`
  + `Form4InsiderHistoryRow` (subquery-around-FINAL S96-149; aggregate z + flags
  only, no per-row JSON parse).
- **`src/components/composite/Form4InsiderApp.tsx`** (NEW) — ~12-line wrapper.
- Wiring: `server.ts` `/api/form-4-insider`, `main.tsx` `#/form-4-insider` lazy
  route, `App.tsx` "Form 4 insiders →" nav link.

### Verification gates (all green)
```
npx tsc --noEmit                                                       # 13 baseline unchanged
node --import tsx --test scripts/tests/compositeForm4Dashboard.test.ts # 18 pass
node --import tsx --test scripts/tests/compositeAnomalyScan.test.ts \
     scripts/tests/compositeDetailDashboard.test.ts \
     scripts/tests/compositeDashboards2.test.ts                        # 39 pass (regression)
node --import tsx --test scripts/tests/form4Insider.test.ts \
     scripts/tests/form4InsiderRepository.test.ts                      # 152 pass (regression)
curl localhost:3000/api/form-4-insider                 # 200, hasData, 98 history pts, verdict buy_cluster, drill 60/62
curl localhost:3000/api/form-4-insider?lookbackDays=29 # 400 bad_query
npx vite build                                         # clean; Form4InsiderApp chunk bundles
```
Critic (general-purpose, §3.3 prompt): **AUTO-APPROVE**. Independently verified the
computed_at-vs-snapshot_date derivation, the additivity no-op for the 3 panels, and
the subquery-around-FINAL pattern. Two informational nits (duplicate INPUT_* bit
constants across the client/server boundary — the established sector_rotation
pattern; sectorContext null-branch only happy-path tested) — both below the
resolve-in-place bar.

---

## Decisions locked in

### Session 96 #28 (Cycle 33 slice 2b)

**S96-151. OQ-C33-2 RESOLVED via two ADDITIVE extensions; the reusable panel now
covers BOTH composite families.** form_4 is genuinely dual-axis (buy + sell cluster
tracks), unlike vol/sector/cross (fixed single-metric). The extension is
(1) `CompositeDescriptor.metricGroups?` — partitions the flat `metrics[]`/`flags[]`
into accented lanes; the bars + history render grouped when present, flat (the
existing 3 panels) when absent, and (2) `CompositeDetailPayload.drill?` — a generic
per-entity table for the per-ticker rows. `Why:` keeps ONE rendering component
(S96-148) while honestly representing a composite whose snapshot has two parallel
verdict-bearing tracks + per-entity rows. `How to apply:` a multi-lane composite =
add `metricGroups` to its descriptor + populate `drill` in its projection; a
fixed-metric composite still needs neither. The drill is reusable for the upcoming
13d_g filing list + short_interest per-name table.

**S96-152 (HEALTH finding — surfaced, not quarantined).** Live form_4
`maxAggregateZ = 5.57` (Health Care, 2026-05-22) is past ±4σ; the client anomaly
scan fires `OUT_OF_BAND_CRIT` on render. The buy-cluster aggregate z has sat
persistently 3.6–5.5 for weeks (Communication Services → Health Care). This is
NOT auto-quarantined: form_4 is an informational Layer-0 composite (not real-money
path), and the anomaly scan SURFACING it at render IS the designed remediation.
The "real sustained cluster vs thin/pinned 2y baseline artifact" question is
**S96-146 (the form_4 Phase-B granularity blocker)** — the Phase-B SPEC must
resolve it. Also note `flaggedBuySectors=4` while `buyClusterTickers=0`: the
aggregate layer reads SP500-PIT-by-GICS, the per-ticker drill reads the
equity-midcap watch universe — different universes, expected divergence, not a bug.

**Carry-overs (still in force):** S96-148 (ONE reusable `CompositeDetailApp(descriptor)`),
S96-149 (subquery-around-FINAL mandatory for every composite `loadHistory`), S96-150
(read the persisted `*Snapshot` interface before assuming shape), S96-145 (Finnhub =
insider backfill source), S96-146 (form_4 EDGAR/Finnhub granularity mismatch =
Phase-B blocker), S96-147 (Cycle 33 = catch-up UI cycle), S96-1..S96-144; all prior
s73-s95 lock-ins.

---

## Open questions

### RESOLVED this session
- **OQ-C33-2 — CLOSED.** form_4's dual buy/sell axes ARE a genuine descriptor
  extension (unlike sector/cross_asset which fit the fixed-metric shape as-is).
  Resolved with the additive `metricGroups` (descriptor) + `drill` (payload)
  fields — see S96-151. The per-ticker drill + Finnhub coverage banner the
  S96-147 design owed are both shipped.

### STILL OPEN (gates later work / Phase B)
- **S96-146** — form_4 Phase B SPEC must normalize EDGAR/Finnhub source
  granularity. THE form_4 Phase-B blocker. The live z=5.57 (S96-152) is the
  concrete symptom: is it signal or a thin-baseline artifact? Phase B must answer.
- **OQ-C32-2** — Finnhub coverage caveats (~1 row/filing; 2024-09 + 2025-09 thin;
  SP500-only). Now SURFACED on the panel (drill `note`). Re-evaluate at Phase B SPEC.
- **OQ-C31-4** — `INSERT…SELECT FROM <self>` no-ops in this CH build; workaround
  in `_anchor_gics_sector_pit.ts`.
- **EDGAR throttle lesson** — prefer a managed source (Finnhub-style) or heavy
  pacing for any bulk EDGAR backfill.
- **CARRIED:** OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2,
  OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — Cycle 33 slice 3: bespoke schedule_13d_g + EtfFlowApp retrofit

form_4 was the LAST genuine descriptor extension; the remaining composites are
either bespoke (13d_g is an event list, no z-scores) or plain
projection+descriptor+wrapper (once their snapshot tables are populated). Build
order:
1. **`schedule_13d_g`** — a bespoke event-timeline panel (filing list, not a
   z-score composite). `schedule_13d_g` + its filings table are EMPTY (never
   ingested), so it ships an honest empty-state until `npm run edgar:13d-g:ingest`
   runs (EDGAR-family — watch the per-IP throttle; prefer paced ingest). Decide:
   reuse `CompositeDetailApp` empty-state vs a small bespoke timeline component
   (the drill table from this slice may suffice for the filing list).
2. **Retrofit** the anomaly overlay onto the existing `EtfFlowApp` (it predates
   the Cycle 33 anomaly scan; bring it under the same bug-finding-first overlay).
3. Remaining: **`short_interest`**, **`executive_departure`**, **`eight_k_classifier`**
   — each is a projection + descriptor + ~12-line wrapper once their snapshot
   tables are populated (all currently empty/never-run; ship empty-states until
   ingested). All EDGAR/FINRA-family — watch throttle.

Each panel ships browser-validated (dev server already running; restart after
server edits). Every composite `loadHistory` uses subquery-around-FINAL (S96-149).

### After Cycle 33
- **form_4 Phase B SPEC** — must FIRST resolve S96-146 (source-granularity
  normalization; the z=5.57 artifact question), then run the DSR/PBO/HLZ
  deflation campaign.
- Cross-composite meta-HLZ pass once a 5th composite is PARTIAL.

---

## Files / code state

### Slice 2b — commit `c414f0f` (form_4 panel + the dual-axis extension)
| Path | Change |
| --- | --- |
| `src/server/composite_detail.ts` | +optional `drill` (CompositeDrillTable/Column/Row) — additive |
| `src/components/composite/descriptors.ts` | +`CompositeMetricGroup` type + `metricGroups?` + `form4InsiderDescriptor` |
| `src/components/composite/CompositeDetailApp.tsx` | grouped MetricBars/History (gated on metricGroups) + DrillTable (gated on drill) + fmtUsd/fmtCell |
| `src/server/form_4_dashboard.ts` | NEW — projection + deriveVerdict + buildDrill + 2-layer coverage |
| `src/server/form_4_insider_repository.ts` | +additive read-only `loadHistory` + `Form4InsiderHistoryRow` (subquery-around-FINAL) |
| `src/components/composite/Form4InsiderApp.tsx` | NEW — thin wrapper |
| `scripts/tests/compositeForm4Dashboard.test.ts` | NEW — 18 tests (parseQuery/deriveVerdict/buildDrill/projectPayload/fetch/descriptor-grouping) |
| `server.ts` / `src/main.tsx` / `src/App.tsx` | +`/api/form-4-insider` route + `#/form-4-insider` lazy route + nav link |

No DDL. No real-money path. No authenticated scrape. tsc baseline 13.

### DB-state
- `form_4_insider_snapshots`: 98 rows (2026-01-02 → 2026-05-22; daemon ~7d stale —
  known, not a regression). All 98 have non-null buy+sell z. Buy flag 66/98 days,
  sell 41/98. Powers the new panel with real data.
- `insider_trades`: 296,219 rows — 232k `sec_edgar_form4_xml` (2024-01→2026-05-22)
  + 64k `finnhub` (2014-02→2026-05-27). `cik_ticker_map`: ~7,992; `gics_sector_map`:
  ~1,006.
- `vol_structure_snapshots` ~3,368; `sector_rotation_snapshots` ~3,368;
  `cross_asset_snapshots` ~3,368 (all ~5d stale — known daemon lag).
- Empty/never-run (ship empty-states): `short_interest`, `executive_departure`,
  `schedule_13d_g`, `eight_k_events`, `etf_shares_outstanding` (ETF v1 primary).

---

## Watch-outs

### NEW this session
- **`metricGroups` + `drill` are ADDITIVE — keep them so.** The three existing
  panels (vol/sector/cross) set NEITHER; both render branches are gated. A change
  that makes the grouped/drill path unconditional would alter those panels. The
  grouped layout pins: tests assert the groups partition EVERY z-metric, so a new
  z-metric not assigned to a group would silently vanish from the grouped bars —
  the `compositeForm4Dashboard.test.ts` "groups partition EVERY z-metric" test
  catches it.
- **form_4 `loadLatestSnapshot().snapshotDate` is the computed_at INSTANT, not the
  snapshot_date Date column** (a pre-existing repo quirk). The dashboard derives
  the authoritative snapshotDate from the last `loadHistory` row's date (the true
  Date column) and only falls back to computed_at when history is empty. Do NOT
  "simplify" the projection to use `latest.snapshotDate.toISOString().slice(0,10)`
  for the displayed/staleness date — it would drift at UTC/midnight boundaries.
- **form_4 has NO categorical input bitmask** — the coverage strip uses a 2-layer
  proxy (AGG-SECTORS / PER-TICKER). Granular counts (11 sectors, 60 names) live in
  the state-hero context strip. A 1/2 coverage reading = a whole analytic layer
  dark (cold-start before GICS aggregate activated).
- **The z=5.57 OUT_OF_BAND_CRIT is real, persistent, and EXPECTED to fire** (S96-152).
  It is NOT a panel bug. Don't "fix" it by widening the band — surfacing it is the
  job. The fix (if it's an artifact) is the Phase-B baseline-granularity work (S96-146).

### Carried
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory`.
- **Dynamic Tailwind classes get purged** — the reusable panel uses inline-hex for
  accent/tone (incl. the new per-group accents via `accentHex`). New group accents
  must be a stem in `ACCENT_HEX` in `CompositeDetailApp.tsx` (emerald + rose already
  present).
- **Dev server is running** on :3000 (background) for operator visual validation;
  does NOT hot-reload server edits.
- **Browser-visual validation is the one gate I can't run headlessly** — API smoke
  + vite build + tsc + tests are green; the operator's eyeball on
  `/#/form-4-insider` is the final confirmation.
- All prior watch-outs (Finnhub ~1 row/filing + synthetic person_cik; EDGAR per-IP
  throttle; gics PIT-anchor required on wipe; CH-Date range; sp500_constituents PIT
  gap-window) preserved.

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot:
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse   # loop until healthy
# Dev server (visual validation):
npm run dev                        # http://localhost:3000/#/form-4-insider
# Cycle 33 slice 2b tests:
node --import tsx --test scripts/tests/compositeForm4Dashboard.test.ts
# Gates:
npx tsc --noEmit                   # 13 baseline
npm run health:check
npm run daemon:daily               # composites ~5-7d stale (known)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 33 slice 3 (S96-147 continued):** bespoke
`schedule_13d_g` event-timeline (empty-state until `edgar:13d-g:ingest`; the
slice-2b drill table may serve as the filing list); then retrofit the anomaly
overlay onto `EtfFlowApp`; then `short_interest` / `executive_departure` /
`eight_k_classifier` (empty snapshot tables → empty-states until ingested; each a
projection + descriptor + wrapper). Every composite `loadHistory` uses
subquery-around-FINAL (S96-149). Each panel browser-validated.

**Do NOT auto-open without operator green-light:** form_4 Phase B (blocked on
S96-146 — the z=5.57 granularity question); Phase C promotion; ALTER DROP/DELETE;
`git push` (Q-4 — 111 commits); bulk EDGAR backfills (throttled — use Finnhub);
broker integration; real-money path.

---

## Important framing for the next chat

**Cycle 33 is the catch-up UI cycle; slices 1, 2a, 2b are DONE.** There is ONE
reusable `CompositeDetailApp(descriptor)` with the full bug-finding overlay, now
covering BOTH composite families:
- **fixed-single-metric:** `vol_structure` (`/#/vol-structure`),
  `sector_rotation` (`/#/sector-rotation`), `cross_asset` (`/#/cross-asset`);
- **dual-axis-with-drill:** `form_4` (`/#/form-4-insider`, NEW this session).

**OQ-C33-2 is RESOLVED** — form_4's dual buy/sell axes were the one genuine
descriptor extension Cycle 33 owed, shipped as the additive `metricGroups`
(descriptor) + `drill` (payload) fields (S96-151). No genuine descriptor
extensions remain; the rest of the backend-only composites are bespoke (13d_g
event list) or plain projection+descriptor+wrapper once their tables populate.

**The 9-arc:** ✓ cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1 (PARTIAL,
Phase B); 🚧 form_4_insider_v1 (panel LIVE; Phase B blocked on S96-146 — z=5.57
artifact question); ☐ short_interest, exec_departure, etf_flow, eight_k.
**UI coverage:** regime + cycle_position + etf_flow + vol_structure +
sector_rotation + cross_asset + **form_4 (NEW)** = **7 live panels**. Remaining
backend-only: `schedule_13d_g` (next), `short_interest`, `executive_departure`,
`eight_k_classifier` — the last four have empty/never-run snapshot tables → ship
empty-states until ingested.
