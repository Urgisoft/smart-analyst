# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #26 — **Cycle 32 CLOSED. form_4_insider
data plumbing is HEALED via a source switch to Finnhub after SEC EDGAR's
per-IP throttle made the direct Form 4 backfill unviable (429/503 storms →
silently-incomplete months, even when SP500-filtered). insider_trades grew
146K → 289K rows (22/24 backfill months populated, was ~2/24); the snapshot
re-backfill z-distribution went from the degenerate max=27/mean=10.1
(zero-inflated baseline, OQ-C31-1) to max=11/mean=2.9/median=2.2 — the
artifact is RESOLVED. Six commits this session (slices 1-5 + handoffs).
Operator also reviewed UI coverage (only 3/11 composites have real panels) and
decided Cycle 33 = a dedicated CATCH-UP UI CYCLE.** Net 106 unpushed commits
on `origin/main` (`c0cda7c`) after this HANDOFF ships.
**NEXT on `continue`:** Cycle 33 — build ONE reusable `CompositeDetailApp`
(per-composite descriptor) covering the 7 backend-only composites + a 13D/G
panel, per the design in [[ui-design-principles]] memory. form_4 Phase B SPEC
comes AFTER Cycle 33 and must address S96-146 (source-granularity mismatch).

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

The machine restarted multiple times this session. ClickHouse runs in the
`quantlab-clickhouse` Docker container under Docker Desktop. On reboot:

1. `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. The `quantlab-clickhouse` container auto-starts (~5s after engine ready).
3. Verify `SELECT 1` on `127.0.0.1:8123` before any CH work.

**Re-run the Finnhub insider backfill (idempotent; if data is ever lost):**
```
FINNHUB_API_KEY=<operator key from Cline financial-hub MCP config> \
  .venv/Scripts/python.exe scripts/finnhub_insider_ingest.py \
  --from-date 2024-01-01 --to-date <today> --apply
```
Cross-source accession dedup makes re-runs safe. ~533 SP500 calls, ~12min.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model change
ratified 2026-05-23 (s96 #14), every routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First real-capital deployment — timing + amount | §7.1.1 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** (s96 #19) |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push 106 unpushed commits to origin/main | Carry-over; +8 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path pick | s96 #18 C19 | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite | Cycle 22 ADR-051 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**NEW this session — Finnhub key note (NOT a queue item, FYI):** the insider
ingest now depends on the operator's Finnhub free-tier API key (lives in the
Cline `financial-hub` MCP config env `FINNHUB_API_KEY`). Free-tier, already
owned — no new subscription. If insider data needs refreshing the key must be
in env. Not on the real-money queue.

---

## What this session delivered (s96 #26 Cycle 32)

The arc: tried full-market EDGAR backfill → throttled + crashed → fixed a CH-Date
bug → tried SP500-filtered EDGAR → STILL throttled → **pivoted to Finnhub** (the
reliable source) → backfilled 2 years in ~12min → snapshots + z-reprobe → artifact
resolved. Plus two reproducibility wrappers, a cik_ticker_map ingest, and a UI
coverage audit that set the Cycle 33 plan.

| Commit | Slice |
| --- | --- |
| `9c7d1e6` | CH-`Date` range clamp (parser + writer); fixed batch-INSERT crash on out-of-range transactionDate (S96-143). +3 tests. |
| `5ce50d3` | bulk `cik_ticker_map` from SEC company_tickers.json — 7,992 issuers (closes OQ-C31-3 / S96-141-W2). +8 tests. |
| `706b295` | reproducibility wrappers `_propagate_sp500_history_to_constituents.ts` + `_anchor_gics_sector_pit.ts` (closes OQ-C30-2 + OQ-C31-2). |
| `a8df3b7` | SP500 issuer-CIK filter for the EDGAR ingest (`--issuer-cik-file`) + `_build_sp500_issuer_cik_allowlist.ts` (533 CIKs). **Now superseded for the backfill by Finnhub, but the allowlist builder still feeds the Finnhub SP500 universe.** +5 tests. |
| `68c1296`, `e980f43` | interim HANDOFFs. |
| `6bea3d3` | **Finnhub insider ingest** `scripts/finnhub_insider_ingest.py` (S96-145). +8 tests. |

### Outcome metrics
- `insider_trades`: 146,168 → **289,225 rows**; **22/24** backfill months ≥2K
  (2024-09 + 2025-09 thin <2K — likely seasonal, non-blocking).
- form_4 snapshots re-backfilled (98 days): buy-cluster days 89→**66**,
  sell-cluster 82→**41** (fewer = less artifact-firing = baseline healed).
- z-distribution: BUY max=11.08 mean=2.92 median=2.19 q95=5.32; SELL max=6.53
  mean=2.36. **Was max=27 mean=10.1.** OQ-C31-1 artifact RESOLVED.

### Verification gates
```
.venv/Scripts/python.exe -m pytest scripts/tests/test_finnhub_insider_ingest.py        # 8 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py         # 55 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_company_tickers_ingest.py  # 8 pass
npx tsc --noEmit                                                                        # 13 baseline unchanged
```

---

## Decisions locked in

### Session 96 #26 (Cycle 32)

**S96-145. Finnhub is the backfill source for `insider_trades` (Section-16
data), via `scripts/finnhub_insider_ingest.py`.** `Why:` direct SEC EDGAR Form 4
scraping (even SP500-filtered) is throttled by EDGAR's per-IP fair-access
limiter on sustained bulk access (429/503 → silently-incomplete months).
Finnhub re-distributes the SAME SEC data (`source:"sec"`, SEC accession as
`id`) via a managed API: one call/symbol, full 2y history, ~533 calls ~12min,
no throttle. Operator-directed (the Cline `financial-hub` MCP is Finnhub-backed).
`How to apply:` (1) key from env `FINNHUB_API_KEY`; (2) cross-source dedup by
SEC accession — skip Finnhub rows whose accession exists (EDGAR skips WHOLE
filings on failure, so existing EDGAR rows are complete per-filing) → no
double-count, no destructive deletes; (3) Finnhub gives insider NAME not
person_cik → synthetic `FH`+sha1(name)[:10] person_cik (F4-2 cluster
distinctness becomes distinct-name); `accepted_at`←`filingDate`; `role_flags=0`
(v1 weights roles 1.0); `source='finnhub'`; CH-Date clamp reused (S96-143).

**S96-146 (watch-out — NOT a decision; Phase-B-SPEC blocker for form_4).
EDGAR-recent vs Finnhub-baseline GRANULARITY MISMATCH.** EDGAR returns ~2.4-2.8
P/S rows per filing (every Section-16 line); Finnhub returns ~1.0 row per
filing (one/primary transaction). The recent scoring window (2026, EDGAR) is
therefore ~2.5x denser than the 2024-25 baseline (Finnhub), biasing
`max_aggregate_z` upward (residual mean=2.9, q95=5.3 vs an ideal ~0/~1.65 under
no-signal). The OQ-C31-1 zero-inflation is fixed, but **form_4 Phase B SPEC
must normalize source granularity** (options: re-ingest the recent window from
Finnhub for consistency; or use filings-count not transaction-count as the
cluster metric; or per-source rate normalization) before the form_4 ranking
axis can be trusted. Do NOT run form_4 Phase B until this is addressed.

**S96-147. Cycle 33 = a dedicated CATCH-UP UI CYCLE (operator decision).** UI
audit: only 3/11 composites have real panels (regime, cycle_position, etf_flow);
7 show only a binary Phase-B verdict (vol_struct, sector_rot, cross_asset,
short_interest, exec_departure, eight_k, form_4); schedule_13d_g has none.
`How to apply:` build ONE reusable `CompositeDetailApp` parameterized by a
per-composite `CompositeDescriptor`, covering the 7 (they share a snapshot
shape) + a bespoke 13D/G event-timeline panel + nav, then UI ships per-slice
for every future arc. Full design + bug-finding overlay + meaning-layer spec in
the [[ui-design-principles]] memory. Build order: vol_structure (reference) →
sector_rotation/cross_asset → form_4 (highest bug-surface) → 13d_g. Stay on
hand-rolled SVG (not recharts); §B uses position-on-scale BARS (not color
heatmap) so out-of-band z punches past the band; client-side pure anomaly scan
+ coverage strip + data-lineage on every number.

**Carry-overs (still in force):** S96-1..S96-144 (incl. S96-142 cik_ticker_map,
S96-143 CH-Date clamp, S96-141 gics PIT-anchor, S96-140 sp500_constituents PIT
depth); all prior s73-s95 lock-ins.

---

## Open questions

### CLOSED this session
- **OQ-C31-1** — **RESOLVED** (zero-inflated baseline artifact gone; z 27→11,
  mean 10→2.9). Residual granularity bias tracked separately as S96-146.
- **OQ-C31-3** — CLOSED (slice 2: cik_ticker_map = 7,992 issuers).
- **OQ-C30-2 / OQ-C31-2** — CLOSED (slice 3: reproducibility wrappers).
- **OQ-C32-1** — CLOSED (slice 4: SP500 filter built) — though Finnhub
  superseded the EDGAR backfill it was built for.

### OPEN
- **S96-146** (above) — form_4 Phase B SPEC must normalize EDGAR/Finnhub source
  granularity. THE form_4 Phase-B blocker now.
- **OQ-C32-2** — Finnhub coverage caveats: ~1 row/filing (vs EDGAR's ~2.5);
  2024-09 + 2025-09 thin; SP500-only (no midcap per-ticker). Re-evaluate at
  Phase B SPEC.
- **OQ-C31-4** — `INSERT…SELECT FROM <self>` no-ops in this CH build; workaround
  documented in `_anchor_gics_sector_pit.ts`.
- **EDGAR throttle lesson** — the OTHER EDGAR ingests (8K-event, 8K-Item-5.02,
  13D/G) are lower-volume than Form 4 and may run fine, but if any future bulk
  EDGAR backfill is attempted, expect the same per-IP throttle; prefer a managed
  source (Finnhub-style) or heavy pacing.
- **CARRIED:** OQ-C29-1/2/5, OQ-C30-3, OQ-C27-1..3, OQ-C26-1..3, OQ-C25-1..2,
  OQ-C24-1..3, OQ-C19-1, OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — Cycle 33: catch-up UI cycle (S96-147)

1. **Build the reusable `CompositeDetailApp`** + `CompositeDescriptor` type +
   the bug-finding anomaly-scan hook (pure, unit-testable) + the §B
   bars-with-band heatmap component + coverage strip + lineage tooltips. Spec in
   [[ui-design-principles]] memory + the §B/§A mockups discussed s96 #26.
2. Wire `vol_structure` first (reference impl, cleanest pure-z shape) — a
   `/api/vol-structure` dashboard route mirroring `cycle_position_dashboard.ts`
   with a `tableExists()` guard + a `VolStructApp` wrapper (~20 LOC) + nav link.
   Validate in browser per ADR-044.
3. Then `sector_rotation`/`cross_asset` (regimeFlag variant), `form_4` (dual
   buy/sell + per-ticker drill + coverage banner), bespoke `schedule_13d_g`
   event-timeline. Retrofit the anomaly overlay onto the existing `EtfFlowApp`.
4. Each panel ships validated in-browser (reinstates feedback_ui_validation_each_slice).

### After Cycle 33
- **form_4 Phase B SPEC** — must FIRST resolve S96-146 (source-granularity
  normalization), then run the DSR/PBO/HLZ deflation campaign.
- Remaining Layer-0 arcs: short_interest_v1 (FINRA URL discovery), exec_departure_v1,
  eight_k_classifier_v1 (EDGAR-family — watch throttle), etf_flow_v1 (Q-6 blocked).
- Cross-composite meta-HLZ pass once a 5th composite is PARTIAL.

---

## Files / code state

### New / modified this session
| Path | Change |
| --- | --- |
| `scripts/finnhub_insider_ingest.py` | NEW — Finnhub insider ingest (S96-145) |
| `scripts/tests/test_finnhub_insider_ingest.py` | NEW — 8 mapping tests |
| `scripts/sec_edgar_form4_ingest.py` | CH-Date clamp + `--issuer-cik-file` filter |
| `scripts/sec_edgar_company_tickers_ingest.py` | NEW — cik_ticker_map ingest |
| `scripts/_build_sp500_issuer_cik_allowlist.ts` | NEW — 533 SP500 CIKs (feeds Finnhub universe too) |
| `scripts/_propagate_sp500_history_to_constituents.ts` | NEW — OQ-C30-2 wrap |
| `scripts/_anchor_gics_sector_pit.ts` | NEW — OQ-C31-2 wrap |
| `scripts/sec_edgar_company_tickers_ingest.py` tests + form4 tests | +16 tests total |
| `package.json` | +`edgar:company-tickers:ingest[:dry]` |
| `logs/c32_filtered_backfill.sh`, `logs/sp500_issuer_ciks.txt`, `logs/finnhub_insider_backfill.log` | gitignored runtime artifacts |
| `.claude/HANDOFF.md` | this rewrite |

No DDL. No real-money path. No authenticated scrape. tsc baseline 13.

### DB-state
- `insider_trades`: **289,225 rows** (EDGAR 2024-01/04/2025-12/2026 + Finnhub
  2024-25 gaps; mixed source, deduped by accession).
- `cik_ticker_map`: 7,992 issuers.
- `gics_sector_map`: 1,006 (anchor intact).
- `form_4_insider_snapshots`: 98 rows re-backfilled (buy 66 / sell 41 days).
- Empty/missing: `short_interest`, `executive_departure`, `schedule_13d_g`,
  `eight_k_events`, `etf_shares_outstanding`.
- Daemon stale ~6d (composites very-stale; not a regression).

---

## Watch-outs

### NEW this session
- **S96-146 source-granularity mismatch** (above) — form_4 Phase-B blocker.
- **Finnhub insider data is ~1 row/filing** (vs EDGAR ~2.5) + SP500-only +
  synthetic person_cik (name-derived). Fine for the aggregate; the per-ticker
  forensic path is approximate.
- **EDGAR per-IP throttle is real** — do not attempt bulk Form 4 EDGAR
  backfills; use Finnhub. The IP may be cooled-down for hours after this
  session's runs.
- **Mixed-source insider_trades** — EDGAR rows (real person_cik) + Finnhub rows
  (synthetic FH person_cik) for different filings. Same-insider-across-sources
  counts as 2 distinct in cluster windows spanning a source boundary; rare,
  affects baseline days only (2026 snapshot cluster-windows are all-EDGAR).

### Carried
All prior watch-outs (gics PIT-anchor required on wipe; CH-Date range;
sp500_constituents PIT gap-window; etc.) preserved.

---

## Pre-loaded operational reminders

```
# Re-run Finnhub insider backfill (idempotent):
FINNHUB_API_KEY=<key> .venv/Scripts/python.exe scripts/finnhub_insider_ingest.py --from-date 2024-01-01 --to-date <today> --apply
# Re-run form_4 snapshot backfill:
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --start 2026-01-01 --end 2026-05-25 --apply
# z-distribution probe:
#   SELECT max(max_aggregate_z), avg(max_aggregate_z), quantile(0.95)(max_aggregate_z) FROM quantlab.form_4_insider_snapshots
# Reproducibility wraps (on DB wipe):
npx tsx scripts/_propagate_sp500_history_to_constituents.ts --apply
npx tsx scripts/_anchor_gics_sector_pit.ts --apply
npm run edgar:company-tickers:ingest
# Health + daily:
npm run health:check
npm run daemon:daily
npx tsc --noEmit        # 13 baseline
```

---

## For the next session — priority order

**Default on `continue` — Cycle 33 catch-up UI cycle (S96-147):** build the
reusable `CompositeDetailApp` + anomaly overlay (spec in [[ui-design-principles]]),
wire vol_structure first, then the rest. Each panel browser-validated.

**Do NOT auto-open without operator green-light:** form_4 Phase B (blocked on
S96-146); Phase C promotion; ALTER DROP/DELETE; `git push` (Q-4); bulk EDGAR
Form 4 backfills (throttled — use Finnhub); broker integration; real-money path.

---

## Important framing for the next chat

**Cycle 32 is CLOSED.** form_4's data plumbing is healed: after EDGAR throttling
made the direct backfill unviable, we switched to **Finnhub** (operator-directed,
the financial-hub MCP's backend) and backfilled 2 years of SP500 insider data in
~12min. insider_trades 146K→289K, the zero-inflated-baseline artifact (OQ-C31-1,
z=27→11) is resolved. A residual **EDGAR/Finnhub granularity mismatch (S96-146)**
remains — it's the form_4 Phase-B SPEC's problem, not a data blocker.

**Next is Cycle 33 — the catch-up UI cycle** (operator decision S96-147): one
reusable composite-detail panel covering the 7 backend-only composites + a 13D/G
panel, with a bug-finding overlay (bars-not-color, coverage strip, lineage,
unit-testable anomaly scan) and a plain-language meaning layer. This restores
the per-slice UI rule that had drifted (7 composites shipped backend-only). Full
design in the [[ui-design-principles]] memory.

**The 9-arc:** ✓ cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1 (PARTIAL);
🚧 form_4_insider_v1 (data healed; Phase B blocked on S96-146); ☐ short_interest,
exec_departure, etf_flow, eight_k. After Cycle 33, form_4 Phase B (post-S96-146)
resumes the arc.
