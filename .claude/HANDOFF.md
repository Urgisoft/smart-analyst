# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #29 — **Cycle 33 slices 3a + 3b + 3c shipped
this session, plus a Tier-1 HEALTH fix.** Three composite-panel deliverables +
one code-integrity fix, all validated + critic-approved:
- **3a `schedule_13d_g`** — 5th composite on the reusable CompositeDetailApp
  (flat-z + per-ticker drill; OQ-C33-3 resolved → reuse, not bespoke). `7a4c315`.
- **3b `EtfFlow` anomaly retrofit** — the bespoke EtfFlow panel now SCREAMS
  anomalies on render (PRIMARY_DARK / divergence tiers / implausible) via a thin
  EtfFlow-specific scan emitting the shared Anomaly type. `2f683ec`.
- **Tier-1 HEALTH** — stripped 2 literal NUL bytes from `executive_departure.ts`
  (dedupe key used a literal NUL separator → ripgrep treated the file as binary;
  replaced with the unicode-escape form, runtime-identical). `54df9f3`.
- **3c `eight_k_classifier`** — 6th composite (flat-z + material-event drill).
  `8317323`.
**9 UI panels now live.** NEXT on `continue`: the LAST two backend-only
composites — `short_interest` + `executive_departure` panels (each a projection +
descriptor + ~12-line wrapper, empty-states until ingested). **CRITICAL per
S96-153: read EACH composite's own `*Snapshot` shape first — short_interest and
executive_departure both DIVERGE from the form_4/eight_k shape (see below).**

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
this handoff the dev server is RUNNING in the background** (restarted this session
to pick up the new `/api/schedule-13d-g` + `/api/eight-k` routes) so the operator
can visually validate the new panels.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model change
ratified 2026-05-23 (s96 #14), every routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push **117** unpushed commits to origin/main | Carry-over; +4 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**FYI (not a queue item):** the FINAL visual browser check is the one gate I
can't run headlessly — please eyeball when convenient (dev server on :3000):
`/#/vol-structure`, `/#/sector-rotation`, `/#/cross-asset`, `/#/form-4-insider`,
**`/#/schedule-13d-g` + `/#/eight-k` (NEW — empty-states; ingests never run)**,
and **`/#/etf-flow` (NEW anomaly overlay — fires a PRIMARY_DARK warn banner at
top, since the v1 yfinance primary is dark / secondary-only mode; that is the
intended bug-finding-first scream, not a bug)**.

---

## What this session delivered (s96 #29 — Cycle 33 slices 3a/3b/3c + HEALTH)

| Commit | Slice |
| --- | --- |
| `7a4c315` | 3a — schedule_13d_g activist-stake panel (flat-z + per-ticker 13D/13G drill). 25 tests. |
| `2f683ec` | 3b — EtfFlow bug-finding-first anomaly overlay (thin scan + local banner). 12 tests. |
| `54df9f3` | [HEALTH] Tier-1 — strip 2 literal NUL bytes from executive_departure.ts dedupe key. |
| `8317323` | 3c — eight_k material-event classifier panel (flat-z + material-event drill). 20 tests. |

All four: critic AUTO-APPROVE (3a/3b/3c) or test-verified (HEALTH); tsc 13 baseline
held throughout; vite build clean each slice; live API smoke 200 empty-state +
400 bad-query for the two new routes; the EtfFlow route live-confirmed
secondary-only (primary 0 rows) → fires PRIMARY_DARK.

---

## Decisions locked in

### Session 96 #29

**S96-153 (LESSON — load-bearing for the remaining 2 panels).** Layer-0 composite
snapshots SHARE FIELD NAMES that hide DIFFERENT SEMANTICS — read each composite's
`*Snapshot` before projecting; do NOT copy a sibling projection. Verified this
session across three composites:

| Composite | `maxAggregateZ` | `inputsAvailableAggregate` | `snapshotDate` |
| --- | --- | --- | --- |
| form_4 | persisted (dual buy/sell) | 0–11 SECTOR COUNT → "/11 sectors" | computed_at instant |
| schedule_13d_g | **DERIVED** from flagged_sectors (null-or-≥2) | **BASELINE-PRINTS SUM** → "N prints" (guard 330) | snapshot_date Date col |
| eight_k | persisted continuous (dense history) | 0–11 SECTOR COUNT → "/11 sectors" | computed_at instant |

A copy-paste would have mislabeled coverage by ~2 orders of magnitude or shown a
null sparkline where a dense one was right. Operational teeth of [[S96-150]].

**S96-154 (schedule_13d_g quirk).** Its `maxAggregateZ` is null-or-≥2 (derived
from |z|>2 flagged sectors only). OUT_OF_BAND warn fires whenever a cluster is
present — honest-by-design; don't widen the band. v2 add-* migration of a
continuous max-z column is the real fix if a calm-day trend is wanted.

**S96-155 (OQ-C33-3 RESOLVED).** schedule_13d_g (and the rest) reuse
CompositeDetailApp — the generic `drill` table serves the per-entity "filing
list"; a raw per-filing feed would read the separate (empty)
`schedule_13d_g_filings` table — deferred. Keeps the ONE-reusable-panel invariant
([[S96-148]]).

**S96-156 (EtfFlow anomaly retrofit — thin scan over bespoke payload).** EtfFlow's
payload is a cross-validation comparator (modes empty/cross-validation/secondary-
only + a divergence severity ladder), NOT a z-metric composite — so
`scanCompositeAnomalies` is structurally wrong. A thin `etfFlowAnomalyScan.ts`
emits the shared `Anomaly` type, rendered via a LOCAL AnomalyBanner (kept local,
not extracted from CompositeDetailApp — EtfFlow is fully bespoke; extracting would
risk the 8 panels for no gain). `How to apply:` for any future bespoke panel,
mirror this — a panel-specific pure scan emitting `Anomaly[]` + a local banner.

**Carry-overs:** S96-148 (ONE reusable CompositeDetailApp), S96-149 (subquery-
around-FINAL for every loadHistory), S96-150 (read the shape — S96-153 is its
teeth), S96-151 (generic drill table), S96-145..147, S96-1..S96-144; all prior
s73-s95 lock-ins.

---

## Open questions

### RESOLVED this session
- **OQ-C33-3 — CLOSED** (S96-155): reuse, not bespoke timeline.

### STILL OPEN (gates later work / Phase B)
- **S96-146** — form_4 Phase B SPEC must normalize EDGAR/Finnhub source
  granularity (the z=5.57 artifact). THE form_4 Phase-B blocker.
- **OQ-C32-2** — Finnhub coverage caveats (form_4 drill note). Re-eval at Phase B.
- **OQ-C31-4** — `INSERT…SELECT FROM <self>` no-ops in this CH build; workaround
  in `_anchor_gics_sector_pit.ts`.
- **EDGAR/FINRA throttle** — prefer a managed source or heavy pacing for any bulk
  EDGAR/FINRA backfill. Applies to `edgar:13d-g:ingest`, `edgar:8k-event:ingest`,
  `edgar:exec-departure:ingest`, `finra:short-interest:ingest` (all needed to
  populate the new panels' tables with real data).
- **CARRIED:** OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2,
  OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — Cycle 33 slice 3d: the LAST two backend-only panels

Build `short_interest` then `executive_departure` panels on CompositeDetailApp
(projection + descriptor + ~12-line wrapper + route + lazy route + nav link +
tests each). Both snapshot tables are EMPTY/never-run → ship empty-states. **READ
each composite's `*Snapshot` shape first (S96-153).** What I already gathered:

- **`short_interest`** (`src/server/short_interest.ts` + `_repository.ts`) — shape
  DIFFERS from the EDGAR siblings: it has `aggregateZ` (number|null) + `aggregateSir`
  (raw) + `sentimentShortExtreme` (bool flag) + `aggregateBaselineSize`; per-ticker
  `ShortInterestPerTickerRow` = {ticker, cusip, sirT, sirT6, sirRoc, d2cT,
  shortRamp, shortCapitulation}. NO flaggedSectors / no GICS-sector aggregate (it's
  a single equal-weight aggregate SIR z, not a per-sector cluster). `snapshotDate`
  = computed_at instant (repo line ~572). Verify whether `aggregateZ` is persisted.
  Staleness anchor is `lastFinraPublication` / `bdSincePublication` (FINRA biweekly,
  not EDGAR). Descriptor: z-metric `aggregateZ` + raw `aggregateSir` + flag
  `sentimentShortExtreme`; drill = per-ticker SIR table (sirT, sirRoc, d2cT,
  shortRamp/shortCapitulation flags). Verdict derive from sentimentShortExtreme +
  maybe a per-ticker-ramp count. NO 2-layer-sector coverage — coverage is
  per-ticker + aggregate-baseline.
- **`executive_departure`** (`src/server/executive_departure.ts` + `_repository.ts`)
  — NOT yet read in detail (the NUL fix just made it grep-able). It is an
  EDGAR-family GICS-sector composite (Item 5.02 departures), so it LIKELY mirrors
  eight_k/schedule_13d_g (maxAggregateZ + cluster flag + flaggedSectors + per-ticker
  + 2-layer sector coverage) — but VERIFY: check whether maxAggregateZ is persisted
  (a `migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts` exists →
  likely persisted like eight_k) and whether inputsAvailableAggregate is a sector
  count. Per-ticker row shape unread — read `ExecutiveDepartureSnapshot` +
  `ExecutiveDeparturePerTickerRow` first.

Each `loadHistory` uses subquery-around-FINAL (S96-149). Each browser-validated.
Accents available in `ACCENT_HEX` (CompositeDetailApp.tsx): `fuchsia` (used by
EtfFlow), `lime` (free). cyan/amber/violet/rose/emerald/sky already taken; pick
`lime` + one more (add a new stem to ACCENT_HEX if needed — e.g. `teal`/`indigo`).

### After Cycle 33
- **form_4 Phase B SPEC** — resolve S96-146 first, then the DSR/PBO/HLZ campaign.
- Cross-composite meta-HLZ pass once a 5th composite is PARTIAL.

---

## Files / code state

### This session's commits (all on `main`, unpushed)
| Commit | Files |
| --- | --- |
| `7a4c315` 3a | schedule_13d_g_dashboard.ts (new), schedule_13d_g_repository.ts (+loadHistory + deriveMaxAggregateZ/parseFlaggedSectors), descriptors.ts (+schedule13DGDescriptor), Schedule13DGApp.tsx (new), server/main/App wiring, test (new) |
| `2f683ec` 3b | EtfFlowApp.tsx (+anomaly banner), etfFlowAnomalyScan.ts (new), test (new) |
| `54df9f3` HEALTH | executive_departure.ts (2 NUL→escape, runtime-identical) |
| `8317323` 3c | eight_k_dashboard.ts (new), eight_k_classifier_repository.ts (+loadHistory + EightKClassifierHistoryRow + nullableNum), descriptors.ts (+eightKClassifierDescriptor), EightKClassifierApp.tsx (new), server/main/App wiring, test (new) |

No DDL. No real-money path. No authenticated scrape. tsc baseline 13 (all in
pre-existing `scripts/_*.ts`).

### DB-state (session-start `npm run health:check`: fresh=3 stale=0 very-stale=12 missing=1 empty=9; migrations 20/20)
- **EMPTY / never-run (panels ship empty-states): `schedule_13d_g_snapshots`
  (NEW panel), `eight_k_classifier_snapshots` (NEW panel), `short_interest`
  (panel TODO), `executive_departure` (panel TODO), `schedule_13d_g_filings`,
  `eight_k_events`, `etf_shares_outstanding` (ETF v1 primary), `cusip_ticker_map`;
  FINRA short-interest raw table MISSING.**
- `etf_shares_outstanding_secondary`: 881 rows in 90d window (powers EtfFlow
  secondary-only mode → the live PRIMARY_DARK anomaly).
- `form_4_insider_snapshots`: 98 rows (~7d stale, known).
- `vol/sector/cross _snapshots` ~3,368 each (~5d stale — known daemon lag).
- `insider_trades` 296,219; `cik_ticker_map` ~7,992; `gics_sector_map` ~1,006.
- **12 very-stale = known dev-box daemon-lag** (no cron — the GAP-9 gap). Tier-1
  remediation = `npm run daemon:daily` on operator cadence; NOT auto-run (heavy/
  network, doesn't block UI work, staleness honestly labeled). No Tier-2 items.

---

## Watch-outs

### NEW this session
- **S96-153: shared field names, different semantics.** Before the final 2
  panels, read each composite's `*Snapshot`. short_interest has NO GICS-sector
  aggregate (single equal-weight SIR z); executive_departure likely mirrors
  eight_k but VERIFY maxAggregateZ-persisted + sector-count.
- **eight_k `maxAggregateZ` is PERSISTED + dense** (unlike schedule_13d_g's
  derived null-or-≥2). The history sparkline shows calm-day z; do not "fix" a
  non-null calm reading.
- **EtfFlow anomaly banner is ADDITIVE + LOCAL** — it renders only when
  `mode !== 'empty'`; the local AnomalyBanner + SEVERITY_HEX intentionally
  duplicate CompositeDetailApp's (do NOT extract — EtfFlow is bespoke). The
  PRIMARY_DARK warn on render is INTENDED (primary is dark).
- **executive_departure.ts dedupe key now uses the ` ` ESCAPE** (was a
  literal NUL). Runtime-identical; the file is now grep-able. Don't reintroduce a
  literal NUL.
- **8-K item codes**: HIGH_SIGNAL_ITEM_CODES = 1.01 (material agreement) · 2.01
  (M&A) · 2.06 (impairment) · 3.01 (delisting) · 4.01 (auditor) · 4.02
  (restatement) · 5.01 (control). 1.03 (bankruptcy) is NOT in the set — an earlier
  draft mislabeled it; fixed this session.

### Carried
- **S96-149 alias-shadowing** — subquery-around-FINAL mandatory for every composite
  `loadHistory` (the two new ones follow it).
- **Dynamic Tailwind classes get purged** — reusable panel + EtfFlow banner use
  inline-hex. New descriptor accents must be a stem in `ACCENT_HEX` in
  `CompositeDetailApp.tsx`.
- **Dev server running** on :3000 (background, restarted this session); does NOT
  hot-reload server edits — restart after editing any `*_dashboard.ts` / server.ts.
- **Browser-visual validation is the one gate I can't run headlessly.**
- All prior watch-outs (Finnhub ~1 row/filing; EDGAR/FINRA per-IP throttle on bulk
  backfills; gics PIT-anchor on wipe; CH-Date range; sp500_constituents PIT
  gap-window) preserved.

---

## Pre-loaded operational reminders

```
# Bring CH up after reboot:
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
docker start quantlab-clickhouse   # loop until healthy
# Dev server (visual validation):
npm run dev                        # http://localhost:3000/#/eight-k etc.
# Cycle 33 slice 3a/3b/3c tests:
node --import tsx --test scripts/tests/compositeSchedule13dgDashboard.test.ts \
     scripts/tests/etfFlowAnomalyScan.test.ts \
     scripts/tests/compositeEightKDashboard.test.ts
# Gates:
npx tsc --noEmit                   # 13 baseline (all in scripts/_*.ts)
npm run health:check
npm run daemon:daily               # composites ~5-7d stale (known dev-box lag)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 33 slice 3d (S96-147 continued, the FINAL panels):**
`short_interest` then `executive_departure` panels on CompositeDetailApp
(projection + descriptor + wrapper each; empty-states until ingested). **READ each
composite's `*Snapshot` shape first per S96-153** — short_interest DIVERGES (no
GICS aggregate; aggregateZ + aggregateSir + sentimentShortExtreme); executive_
departure likely mirrors eight_k but VERIFY. Every `loadHistory` subquery-around-
FINAL (S96-149). Each browser-validated. That CLOSES the Cycle 33 panel sweep.

**Do NOT auto-open without operator green-light:** form_4 Phase B (blocked on
S96-146); Phase C promotion; ALTER DROP/DELETE; `git push` (Q-4 — 117 commits);
bulk EDGAR/FINRA backfills (throttled — pace them); broker integration; real-money
path.

---

## Important framing for the next chat

**Cycle 33 is the catch-up UI cycle; slices 1, 2a, 2b, 3a, 3b, 3c are DONE.** ONE
reusable `CompositeDetailApp(descriptor)` with the full bug-finding overlay now
covers all three composite shapes:
- **flat-single-metric:** vol_structure, sector_rotation, cross_asset;
- **dual-axis-with-drill:** form_4 (`/#/form-4-insider`);
- **flat-z-with-drill:** schedule_13d_g (`/#/schedule-13d-g`), eight_k (`/#/eight-k`).

Plus the bespoke `EtfFlow` panel now carries the SAME bug-finding-first anomaly
overlay (slice 3b).

**UI coverage = 9 live panels:** regime + cycle_position + etf_flow (+overlay) +
vol_structure + sector_rotation + cross_asset + form_4 + **schedule_13d_g + eight_k
(NEW)**. Remaining backend-only WITHOUT a panel: **short_interest +
executive_departure** (2 left → slice 3d closes the sweep). All new-composite
snapshot tables are empty/never-run → panels ship empty-states until their
throttled EDGAR/FINRA ingests run.
