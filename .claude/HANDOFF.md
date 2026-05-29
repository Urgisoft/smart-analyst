# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-29 (session 96 #30 — **Cycle 33 slice 3d shipped: the FINAL
two composite panels — `short_interest` (3d-1) + `executive_departure` (3d-2) —
CLOSING the Cycle 33 panel sweep.** Both critic-AUTO-APPROVE, both validated:
- **3d-1 `short_interest`** — 7th composite on the reusable CompositeDetailApp.
  The genuinely-DIVERGENT one (S96-153): NO GICS-sector layer — a SINGLE
  equal-weight aggregate-short z (persisted, dense history), constituent-count
  coverage ("N constituents", NOT "/11 sectors"), mean-shares-short (Path A4-β)
  in the context strip not as a z bar. `73dfa48`.
- **3d-2 `executive_departure`** — 8th composite; MIRRORS eight_k (GICS-sector
  cluster, persisted maxAggregateZ, "X/11 sectors"). Adds `indigo` accent (+
  `teal` headroom) to ACCENT_HEX. `a2085f4`.
**10 UI panels now live. Every Layer-0 composite has a CompositeDetailApp surface
— the catch-up UI cycle (Cycle 33) is COMPLETE.** NEXT on `continue`: no panel
work remains — the next substantive arc is **form_4 Phase B SPEC** (blocked on
S96-146 — must resolve the EDGAR/Finnhub source-granularity normalization first),
then the DSR/PBO/HLZ deflation campaign. See "Next stage".

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

ClickHouse runs in the `quantlab-clickhouse` Docker container under Docker
Desktop. On reboot:

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. Poll until up: `docker start quantlab-clickhouse` in a loop; then wait for
   `docker inspect --format '{{.State.Health.Status}}' quantlab-clickhouse` =
   `healthy` (~30-60s after engine ready). This session: already healthy at start.
3. Verify `SELECT 1` before any CH work.

**Dev server:** `npm run dev` (= `tsx server.ts`) → http://localhost:3000. NOT
hot-reloading; restart after server-side edits (client .tsx HMR-reloads). **As of
this handoff the dev server is RUNNING in the background** (restarted twice this
session to pick up the new `/api/short-interest` + `/api/executive-departure`
routes) so the operator can visually validate the two new panels. Restarting the
validation dev server to pick up `*_dashboard.ts` / `server.ts` edits is part of
the standing UI-validation workflow — do it freely.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model change
ratified 2026-05-23 (s96 #14), every routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **119** unpushed commits to origin/main | Carry-over; +2 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not a queue item):** the FINAL visual browser check is the one gate I
can't run headlessly — please eyeball when convenient (dev server on :3000). All
10 panels: `/#/regime`, `/#/cycle-position`, `/#/etf-flow` (anomaly overlay),
`/#/vol-structure`, `/#/sector-rotation`, `/#/cross-asset`, `/#/form-4-insider`,
`/#/schedule-13d-g`, `/#/eight-k`, **`/#/short-interest` + `/#/executive-departure`
(NEW — both empty-states; their FINRA / EDGAR-5.02 ingests have never run, so they
render the awaiting-first-cycle empty card, which is the intended state — not a bug)**.

---

## What this session delivered (s96 #30 — Cycle 33 slice 3d, the FINAL panels)

| Commit | Slice |
| --- | --- |
| `73dfa48` | 3d-1 — short_interest sentiment panel (7th composite; NO-sectors divergence). 24 tests. |
| `a2085f4` | 3d-2 — executive_departure cluster panel (8th composite; eight_k mirror) + `indigo`/`teal` accents. 21 tests. |

Both: critic AUTO-APPROVE; tsc 13 baseline held; vite build clean each slice;
live API smoke 200 empty-state + 400 bad-query for both new routes; short-interest
re-confirmed 200 after the 3d-2 restart (no cross-impact). No DDL. No real-money
path. No authenticated scrape.

---

## Decisions locked in

### Session 96 #30

**S96-157 (short_interest is the ONLY no-GICS-sector Layer-0 composite — the
sharpest S96-153 example).** Unlike its four EDGAR-family siblings
(form_4 / schedule_13d_g / eight_k / executive_departure — all GICS-sector
cluster-z composites), `short_interest` has a SINGLE equal-weight aggregate-short
z and NO sector slicing. Three concrete divergences the projection honors (each a
copy-paste trap had I cloned eight_k):

| field | short_interest | the GICS siblings |
| --- | --- | --- |
| aggregate z | `aggregateZ` — one equal-weight short z (persisted) | `maxAggregateZ` — max across 11 sectors |
| `inputsAvailableAggregate` | **# SPY-500 constituents** w/ a valid shares-short → "N constituents" | 0–11 sector count (eight_k/exec) → "X/11 sectors"; baseline-prints sum (13d_g) → "N prints" |
| `aggregateSir` | **MEAN SHARES-SHORT** (Path A4-β; FINRA has no shares-outstanding) → context strip, exponential, NOT a z bar | n/a |
| `maxAggregateZSector` / `flaggedSectors` | DO NOT EXIST — must not be fabricated | persisted |

**S96-158 (executive_departure CONFIRMED = eight_k shape, not assumed).** Read
`executive_departure.ts` directly: `maxAggregateZ` IS persisted (the
`migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts` column;
`loadLatestSnapshot` reads it) → dense history; `inputsAvailableAggregate` IS a
0–11 sector count (`++ if sectorSize > 0`, composite line ~377) → "X/11 sectors".
Per-ticker drill = 5.02(b) departures / 5.02(c) appointments, NO directional
emphasis (forced CEO departures carry a small POSITIVE abnormal return —
Warner-Watts-Wruck 1988; not cleanly bearish).

**S96-159 (ACCENT_HEX extended).** Added `indigo (#818cf8)` + `teal (#2dd4bf)` to
`CompositeDetailApp.tsx` ACCENT_HEX. Accents now in use: cyan(vol) · amber(sector)
· rose(cross) · emerald(form_4) · violet(13d_g) · sky(eight_k) · lime(short_int) ·
indigo(exec_dep). fuchsia is EtfFlow's (bespoke, not via descriptor). `teal` is
unused headroom for the next composite. The main.tsx Suspense fallbacks use STATIC
Tailwind classes (`text-lime-400/70`, `text-indigo-400/70`) so they survive purge.

**Carry-overs:** S96-153 (READ the shape — shared field names, different
semantics; S96-157/158 are its operational teeth), S96-148 (ONE reusable
CompositeDetailApp), S96-149 (subquery-around-FINAL for every loadHistory — both
new repos follow it), S96-150/151, S96-145..147, S96-154..156, S96-1..S96-144; all
prior s73-s95 lock-ins.

---

## Open questions

### RESOLVED / N-A this session
- The Cycle 33 panel sweep is closed — no panel OQs remain open.

### STILL OPEN (gate the next arc)
- **S96-146** — form_4 Phase B SPEC must normalize EDGAR/Finnhub source
  granularity (the z=5.57 artifact). **THE form_4 Phase-B blocker — resolve FIRST.**
- **OQ-C32-2** — Finnhub coverage caveats (form_4 drill note). Re-eval at Phase B.
- **OQ-C31-4** — `INSERT…SELECT FROM <self>` no-ops in this CH build; workaround
  in `_anchor_gics_sector_pit.ts`.
- **EDGAR/FINRA throttle** — prefer a managed source or heavy pacing for any bulk
  EDGAR/FINRA backfill. Applies to `edgar:13d-g:ingest`, `edgar:8k-event:ingest`,
  `edgar:exec-departure:ingest`, `finra:short-interest:ingest` (all needed to
  populate the new panels' tables with real data — they are EMPTY today).
- **CARRIED:** OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2,
  OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — there is NO remaining panel work

Cycle 33 is DONE. The next substantive arc, in priority order:

1. **form_4 Phase B SPEC** (RESEARCH→SPEC). FIRST resolve **S96-146** — the
   EDGAR/Finnhub source-granularity normalization that produced the z=5.57
   artifact — then the DSR / PBO / HLZ deflation-pipeline campaign per AFML §11 /
   Bailey-LdP 2014 / Harvey-Liu-Zhu 2016. This is offline backtest work,
   orchestration-owned (Phase C classifier promotion stays operator-gated — Q-8).
2. **Cross-composite meta-HLZ pass** once a 5th composite reaches PARTIAL — the
   multiple-testing haircut across the Layer-0 family.
3. **Optionally**, populate the empty panel tables with real data via the
   throttled EDGAR/FINRA ingests (paced, not bulk) so the 5 EDGAR/FINRA-family
   panels show live readings instead of empty-states — but this is a data-refresh
   chore, not a build task, and the per-IP throttle makes it slow.

### Alternative stages the operator could pick instead
- Resume any deferred reconciliation gap (GAP-16 sentinels investigation; GAP-13
  Quartz upgrade doc; GAP-10 CI/CD baseline) — all orchestration-owned, all
  independent of the Phase B arc.
- Daemon-cadence promotion review for the new EDGAR/FINRA ingests (GAP-1/2 family)
  if the operator wants the empty panels to auto-populate.

---

## Files / code state

### This session's commits (all on `main`, unpushed — Q-4)
| Commit | Files |
| --- | --- |
| `73dfa48` 3d-1 | short_interest_dashboard.ts (new), short_interest_repository.ts (+loadHistory + ShortInterestHistoryRow), descriptors.ts (+shortInterestDescriptor + SI_INPUT_*), ShortInterestApp.tsx (new), server/main/App wiring, test (new, 24) |
| `a2085f4` 3d-2 | executive_departure_dashboard.ts (new), executive_departure_repository.ts (+loadHistory + ExecutiveDepartureHistoryRow + nullableNum), descriptors.ts (+executiveDepartureDescriptor + XD_INPUT_*), CompositeDetailApp.tsx (+indigo/+teal ACCENT_HEX), ExecutiveDepartureApp.tsx (new), server/main/App wiring, test (new, 21) |

No DDL. No real-money path. No authenticated scrape. tsc baseline 13 (all in
pre-existing `scripts/_*.ts`).

### The reusable-panel invariant (now covers ALL composite shapes)
ONE `CompositeDetailApp(descriptor)` with the full bug-finding overlay covers:
- **flat-single-metric:** vol_structure, sector_rotation, cross_asset;
- **dual-axis-with-drill:** form_4 (`/#/form-4-insider`, metricGroups buy/sell);
- **flat-z-with-drill (GICS-sector cluster):** schedule_13d_g, eight_k,
  **executive_departure (NEW)**;
- **flat-z-with-drill (single equal-weight z, NO sectors):** **short_interest
  (NEW)** — the divergent shape.
Plus the bespoke `EtfFlow` panel carrying the same anomaly overlay (slice 3b).

### DB-state (session-start `npm run health:check`: fresh=3 stale=0 very-stale=12 missing=1 empty=9; migrations 20/20)
- **EMPTY / never-run (panels ship empty-states): `short_interest`,
  `executive_departure` (NEW panels), `eight_k_classifier_snapshots`,
  `schedule_13d_g_snapshots`, `schedule_13d_g_filings`, `eight_k_events`,
  `etf_shares_outstanding` (ETF v1 primary), `cusip_ticker_map`; FINRA
  short-interest raw table MISSING.**
- `etf_shares_outstanding_secondary`: 881 rows (powers EtfFlow secondary-only mode
  → the live PRIMARY_DARK anomaly — intended).
- `form_4_insider_snapshots`: 98 rows (~7d stale, known).
- `vol/sector/cross _snapshots` ~3,368 each (~5d stale — known daemon lag).
- `insider_trades` 296,219; `cik_ticker_map` ~7,992; `gics_sector_map` ~1,006.
- **12 very-stale = known dev-box daemon-lag** (no cron — GAP-9). Tier-1
  remediation = `npm run daemon:daily` on operator cadence; NOT auto-run (heavy/
  network, doesn't block UI work, staleness honestly labeled). No Tier-2 items.

---

## Watch-outs

### NEW this session
- **S96-157: short_interest is the no-sectors outlier.** If a future change touches
  it, do NOT add a "top sector" context row or a maxAggregateZSector — they don't
  exist in its snapshot. The aggregate is one equal-weight z; coverage is
  "N constituents"; the raw value is MEAN SHARES-SHORT (Path A4-β), surfaced
  exponential in context, never standardized as a z.
- **Both new snapshot tables are EMPTY** → panels render empty-states. Populating
  needs throttled `finra:short-interest:ingest` / `edgar:exec-departure:ingest`
  (per-IP rate-limited — pace them, don't bulk-backfill).
- **`teal` is an UNUSED ACCENT_HEX entry** (headroom for the next composite). Not
  dead-code lint (it's a Record value); the next panel can claim it without
  touching CompositeDetailApp.
- **maxAggregateZ is PERSISTED + dense for executive_departure** (like eight_k) —
  the history sparkline shows calm-day z; do not "fix" a non-null calm reading.

### Carried
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory` (both new ones follow it; critic verified).
- **Dynamic Tailwind classes get purged** — reusable panel uses inline-hex; new
  descriptor accents must be a stem in `ACCENT_HEX` in `CompositeDetailApp.tsx`,
  and main.tsx Suspense fallbacks use STATIC `text-<color>-400/70` classes.
- **Dev server running** on :3000 (background); does NOT hot-reload server edits —
  restart after editing any `*_dashboard.ts` / server.ts.
- **Browser-visual validation is the one gate I can't run headlessly.**
- All prior watch-outs (executive_departure.ts dedupe key uses the ` `
  ESCAPE not a literal NUL — don't reintroduce; Finnhub ~1 row/filing; EDGAR/FINRA
  per-IP throttle on bulk backfills; gics PIT-anchor on wipe; CH-Date range;
  sp500_constituents PIT gap-window) preserved.

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot:
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse   # loop until healthy
# Dev server (visual validation):
npm run dev                        # http://localhost:3000/#/short-interest etc.
# Cycle 33 slice 3d tests:
node --import tsx --test scripts/tests/compositeShortInterestDashboard.test.ts \
     scripts/tests/compositeExecutiveDepartureDashboard.test.ts
# Gates:
npx tsc --noEmit                   # 13 baseline (all in scripts/_*.ts)
npm run health:check
npm run daemon:daily               # composites ~5-7d stale (known dev-box lag)
```

---

## For the next session — priority order

**Cycle 33 is COMPLETE — there is NO remaining panel work.** On `continue`, open
the **form_4 Phase B SPEC** arc: FIRST resolve **S96-146** (EDGAR/Finnhub
source-granularity normalization — the z=5.57 artifact), THEN the DSR/PBO/HLZ
deflation campaign (AFML §11 / Bailey-LdP 2014 / Harvey-Liu-Zhu 2016, offline,
orchestration-owned). Phase C classifier promotion stays operator-gated (Q-8).

**Do NOT auto-open without operator green-light:** Phase C promotion; ALTER
DROP/DELETE; `git push` (Q-4 — 119 commits); bulk EDGAR/FINRA backfills (throttled —
pace them); broker integration; real-money path.

---

## Important framing for the next chat

**Cycle 33 — the catch-up UI cycle — is DONE.** Slices 1, 2a, 2b, 3a, 3b, 3c, 3d
all shipped. ONE reusable `CompositeDetailApp(descriptor)` with the full
bug-finding overlay now covers ALL Layer-0 composite shapes (flat-single-metric ·
dual-axis-with-drill · flat-z GICS-sector cluster · flat-z single-equal-weight-z),
plus the bespoke `EtfFlow` panel carrying the same anomaly overlay.

**UI coverage = 10 live panels:** regime + cycle_position + etf_flow (+overlay) +
vol_structure + sector_rotation + cross_asset + form_4 + schedule_13d_g + eight_k +
**short_interest + executive_departure (NEW)**. There are NO backend-only Layer-0
composites left without a panel. All five EDGAR/FINRA-family snapshot tables are
empty/never-run → those panels ship empty-states until their throttled ingests run.
