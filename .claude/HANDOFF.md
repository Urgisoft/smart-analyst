# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 96 #2 — **Gap #7 v2 XD13-A1 — Schedule 13D/G ingest + raw-event table SHIPPED**: first code slice of the third Layer-0 composite under gap #7 (sibling to EK + F4). 1 commit `3796fde` / 5 files / +1449 LOC / 26 new pytest tests covering T-XD13I-1..12 from SPEC §9.3. **61 commits ahead of `origin/main`** (was 60). **NEXT default on `continue`:** XD13-A2 — pure-function composite `src/server/schedule_13d_g.ts` + 22 unit tests per SPEC §9.1. Alternative: Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter (operator-pickable).

## What this slice delivered

Implements the A1 sub-arc from the s96 #1 SPEC. EDGAR ingest +
raw-event table + migration shipped; daemon-side wiring + composite +
brief renderer all queued for XD13-A2..A5.

### Single commit (s96 #2)

**`3796fde` — Gap #7 v2 XD13-A1 — Schedule 13D/G ingest + raw-event table.** 5 files, +1449 LOC:

- **NEW** `scripts/sec_edgar_13d_g_ingest.py` — ~410 LOC. EDGAR
  full-text search ingest filtered to
  `forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A`. Reuses
  `_sec_edgar_helpers.py` (rate-limit + 429 retry + acceptance-date
  filter + CIK resolver). Per XD-3 no XML body fetch in v1. Per XD-7 +
  XD-14 idempotent on `(issuer_cik, accession)`. Per XD-12 the
  `--resolve-filer-names` flag is OFF by default (filer_name = '');
  v2 ADR per XD-2 will lift the reputation classifier into a
  dedicated table.

  Key behavior — the load-bearing issuer/filer split (§11 watch-out #4):
  - `filer_cik` derived from accession leading 10 digits (EDGAR's
    storage-CIK convention).
  - `issuer_cik` = first `ciks[]` entry that doesn't match the filer.
  - Degenerate single-CIK / empty-CIK fallback preserves the row.
  - Both CIKs stored as distinct columns.
  - `is_amendment` derived solely from `form_type` '/A' suffix (XD-4 +
    watch-out #5).

- **NEW** `scripts/migrate_create_schedule_13d_g_filings.ts` — ~190 LOC.
  Source-table migration with byte-pinned DDL parity against the
  ingest's `ensure_schedule_13d_g_filings_table` lazy-create. Pre-checks
  (table absence + pending mutations) + post-checks (all 12 expected
  columns present). Idempotent `CREATE TABLE IF NOT EXISTS`.

- **NEW** `scripts/tests/test_sec_edgar_13d_g_ingest.py` — ~485 LOC,
  **26 tests** covering T-XD13I-1..12 per SPEC §9.3:
  - T-XD13I-1: URL builder includes the four-form-type filter (+ custom-forms variant).
  - T-XD13I-2: Response parser extracts the seven SPEC §4.1 canonical fields.
  - T-XD13I-3: `is_amendment` derived from `form_type` suffix (helper layer + row-builder layer).
  - T-XD13I-4: 429 retry posture (rate-limit helper integration).
  - T-XD13I-5: Acceptance-date filter rejects future filings (+ inclusive boundary).
  - T-XD13I-6: Row-builder key uniqueness on `(issuer_cik, accession)` + idempotency.
  - T-XD13I-7: `cik_ticker_map` integration (resolve_cik_to_ticker + row-builder caching).
  - T-XD13I-8: Apply mode `client.insert` column order + dry-mode no-op.
  - T-XD13I-9: `ensure_schedule_13d_g_filings_table` DDL byte-pinning + shared `cik_ticker_map` DDL.
  - T-XD13I-10: `--resolve-filer-names` flag gating + caching (4 tests).
  - T-XD13I-11: Filer-CIK extraction from accession prefix + issuer ordering robustness + degenerate fallbacks (5 tests).
  - T-XD13I-12: Parse-time form-type filter drops non-13D/G items + `DEFAULT_FORMS_13D_G` SPEC parity.

- **modified** `package.json` — 4 new scripts:
  - `edgar:13d-g:ingest` + `edgar:13d-g:ingest:dry`
  - `migrate:create-schedule-13d-g-filings` + `migrate:create-schedule-13d-g-filings:apply`

- **modified** `scripts/help.ts` — 2 new help entries (ingest pair).
  Migration pair has inline `help: HelpEntry[]` exports.

### What this slice does NOT ship (carried per SPEC §10)

- No `src/server/schedule_13d_g.ts` composite — **XD13-A2** slice.
- No `quantlab.schedule_13d_g_snapshots` table or migration — XD13-A3 slice.
- No `src/server/schedule_13d_g_repository.ts` — XD13-A4 slice.
- No daemon hook position 1m wired — XD13-A4 slice.
- No brief section #16 renderer — XD13-A5 slice.

### Verification gates at commit time (all green)

```text
.venv/Scripts/python.exe -m pytest scripts/tests   # 377 pass (was 351; +26)
npm test                                            # 2939 pass / 1 fail (pre-existing) / 28 skip
npx tsc --noEmit                                    # 13 baseline errors unchanged
npm run check:help                                  # green
```

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted + implementation LIVE | ✓ s89c#2 + s95 #5 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow arc (v1 + v2 + v3) | ✓ DONE end-to-end (s92, s95 #8, s95 #9) |
| Gap #7 EK arc (A1..A5) + per-row + per-EVENT recency | ✓ DONE end-to-end (s93..s95 #7) |
| Gap #7 F4 arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93..s95 #4) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH/ACCEPTED | ✓ s94 #1-#6 |
| ADR-042 Steps 1-5 + OQ-G2-1 sub-slice | ✓ s94 #6-#11 |
| Gap #7 v2 sell-cluster F4 composite + G3 | ✓ s95 #1-#2 (F4 ARC FULLY CLOSED) |
| ADR-041 implementation | ✓ s95 #5 |
| Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions | ✓ s95 #6 |
| Gap #7 v2 per-EVENT EK recency | ✓ s95 #7 (EK v2 ARC FULLY CLOSED) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation FRAMEWORK | ✓ s95 #8 |
| Gap #9 v3 issuer-CSV live secondary panel ingest | ✓ s95 #9 (GAP #9 ARC FULLY CLOSED v1+v2+v3) |
| Gap #7 v2 Schedule 13D/13G arc — SPEC + ADR-043 | ✓ s96 #1 (`d68c2ab`) |
| **Gap #7 v2 Schedule 13D/13G arc — XD13-A1 (ingest)** | **✓ s96 #2 (`3796fde`) — 5 files / +1449 LOC / 26 tests** |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A2 (pure composite + tests) | ☐ NEXT (recommended default on `continue`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A3..A5 | ☐ queued after A2 |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ deferred (operator-pickable; automates manual CSV drop) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 61 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 96 #2 (this slice)

**S96-8. Issuer-vs-filer CIK split derived structurally, no per-filing dispatch.** `filer_cik` = accession leading 10 digits (EDGAR's storage-path-CIK convention). `issuer_cik` = first entry in `ciks_all` that doesn't match `filer_cik`. Degenerate fallback (single-CIK or empty `ciks_all`) collapses to `issuer_cik = filer_cik` and preserves the row for forensic access. Both CIKs stored as distinct columns at the raw-event layer.
`Why:` SPEC §11 watch-out #4 names this as load-bearing — confusing the two corrupts `distinct_13d_filers_90d` and breaks any future filer-reputation work. EDGAR's `ciks` array contains BOTH parties for 13D/G filings (unlike Form 4 where it's the issuer alone); a robust split must work without per-filing JSON-schema dispatch since EDGAR's full-text search response shape varies across years + filing-agent paths.
`How to apply:` `extract_issuer_and_filer_ciks(accession, ciks_all)` is the single source of truth — used by both the row builder and the dry-run sample logger. Future v2 ADR (XD-2 filer reputation) reads from these stored fields; consumers that bypass the helper risk join failures against `cik_ticker_map` (which is issuer-keyed).

**S96-9. Filer-name resolution is OPTIONAL in v1 via `--resolve-filer-names` CLI flag.** Default OFF leaves `filer_name = ''`. Setting the flag triggers N+1 submissions-API calls per ingest cycle to populate the field.
`Why:` XD-12 + the data-source policy's "no silent expansion" posture. Filer-name resolution is non-blocking for the v1 composite (XD-2 defers reputation to v2 ADR), so making it opt-in keeps the default ingest cycle fast (~1 req per filing, not ~N per filing). When v2 ADR lands the reputation table, the flag becomes default-on and the submissions-API calls amortize across multiple ingest cycles via the existing per-CIK cache.
`How to apply:` Operator who wants names today can pass `--resolve-filer-names` once after the ingest is established. The flag's behavior is locked-in test coverage (T-XD13I-10 — 4 tests verifying the gate + caching).

**S96-10. DDL byte-pinned across the Python ingest's lazy-create + the TS migration.** `ensure_schedule_13d_g_filings_table` (Python) and `PLANNED_DDL` (TS) emit byte-identical CREATE TABLE statements.
`Why:` Operator pre-flight (run the migration before the first ingest) MUST produce the same schema as the ingest-side lazy-create. Drift here would surface as silent schema divergence + a column-default mismatch in the brief renderer at XD13-A5.
`How to apply:` Any DDL change requires updating BOTH files in lockstep + re-running T-XD13I-9 (which pins the Python side); a future migration drift-test at XD13-A3 will add a CH-roundtrip check that compares the two byte-for-byte.

**S96-11. Idempotency contract: ReplacingMergeTree(ingested_at) on `(issuer_cik, accession)`.** Re-running the ingest over an overlapping window does not duplicate rows after CH merges; the most-recent `ingested_at` wins per key.
`Why:` Standard ingest contract across all gap-#7 / gap-#8 / gap-#10 tables. The accession is the global unique key per filing (SEC's own guarantee); issuer_cik leads the ORDER BY for per-stock-query locality.
`How to apply:` Test T-XD13I-6 pins the key-uniqueness invariant at the row-builder layer; re-runs with identical input produce identical key sets, so CH's merge engine dedupes correctly.

**Carry-overs (still in force):** S96-1..S96-7 (all s96 #1 decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### Newly opened (s96 #2)

None. The s96 #2 slice resolved no new canon-thin forks beyond
what ADR-043 + the SPEC already cover; all behavior is mechanical
implementation of locked-in decisions.

### CARRIED (unchanged from s96 #1)

- **OQ-XD13-1.** Phase B independence-test threshold for form-type-only signal. Estimated gate: ~6-8 weeks of `schedule_13d_g_filings` ingest history after XD13-A1 lands + a backfill arc to populate historical baseline. UNCHANGED — XD13-A1 has now landed, so the calendar clock starts here.
- **OQ-XD13-2.** v2 filer-reputation table sourcing: hand-maintained vs auto-learned. UNCHANGED.
- **OQ-XD13-3.** Sector-only vs cap-tier-overlay aggregate slicing. UNCHANGED.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- Push commits to origin/main — operator-gated.
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD13 arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- OQ-G2-2 — EDGAR-amendment forensic tooling default (LOW priority, deferred).
- OQ-G9-1 — issuer-specific schema mappers. RECOMMEND State Street SPDR.

## Next stage

### Default on `continue` — recommended: XD13-A2 (pure composite + tests)

The ingest + raw-event table are live; the natural next code slice is
XD13-A2 (pure-function composite + 22 unit tests per SPEC §9.1).

1. **NEW** `src/server/schedule_13d_g.ts` — pure functions implementing
   SPEC §5.1 (per-stock) + §5.2 (aggregate). No CH client; no daemon
   wiring. Reads pre-filtered filing rows + an `asOf: Date` + the
   universe/sector mapping; returns the `Schedule13DGSnapshot` payload
   per SPEC §5.3 typescript interface.

   Helpers needed:
   - `computePerStockMetrics(filings, ticker, asOf)` → per-ticker row.
   - `computeAggregateSectorRate(filings, universe, sector, asOf, baseline)` → `(rate_t, z, baseline_size)`.
   - `computeScheduleSchedule13DGSnapshot(filings, universe, sectorMap, asOf, baselineWindow)` → full payload.

   Per XD-1 + XD-5: form-type-only proxy + asymmetric filter (aggregate
   uses NEW 13D only; per-stock includes amendments).

2. **NEW** `scripts/tests/schedule13dg.test.ts` — 22 tests covering
   T-XD13-1..22 per SPEC §9.1:
   - T-XD13-1..3: per-stock flags fire on 30d windows + form-type
     partition.
   - T-XD13-4..5: count semantics + filer dedup.
   - T-XD13-6..7: null days-since-latest on no qualifying filings.
   - T-XD13-8: universe-filter at composite layer.
   - T-XD13-9..15: aggregate sector rate + z-score + cluster flag +
     XD-5 asymmetric filter (NEW-13D only).
   - T-XD13-16..17: 30d / 90d boundary inclusion.
   - T-XD13-18: composite-side acceptance-date anti-leak (defense in
     depth alongside the ingest-side filter).
   - T-XD13-19..20: 13D-only / 13G-only / mixed filings.
   - T-XD13-21: version stamp = 'schedule_13d_g_v1'.
   - T-XD13-22: `inputs_available.aggregate` semantics.

   Pure-function tests; no CH; no daemon. Uses an inline
   filing-row-factory pattern matching how the sibling EK + F4
   composites are tested.

Estimated: 2-3 files / ~700-900 LOC / 22 tests / 1 commit.

### Alternative slices (operator-pickable)

If operator prefers a different next slice:

- **Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter** —
  ~250-300 LOC. Automates the manual CSV drop for the SPDR ETF family
  (11 of 21 ETFs).

- **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot
  land until Phase B independence test has signal (~6-8 weeks of EDGAR
  ingest history).

- **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated
  ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

- **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

- **Phase B campaigns for the nine Layer-0 composites** — calendar OR
  backfill arc.

- **Quartz docs site extensions** — operator-pickable refinements (home
  page index, live dashboard watcher, teach-doc frontmatter rollout,
  promote ADR-040 status).

- **Renderer docstring refresh** — `operator_brief_render.ts` stale
  comment for the EK section (carry).

### Operator-gated action items (carried + new)

**NEW from s96 #2:**

- **A1 close** (s96 #2): Run
  `npm run migrate:create-schedule-13d-g-filings:apply` once per
  environment. Idempotent (CREATE IF NOT EXISTS).
- **A1 close** (s96 #2): Run `npm run edgar:13d-g:ingest --apply` to
  populate the raw-event table. Recommend `--start-date <D-180>` on
  first apply-run to populate ~6mo backfill at faster pace than
  60d-daemon-only cold-start. Optional `--resolve-filer-names` if
  filer names wanted today (otherwise v2 ADR will populate them).

**CARRIED (unchanged from s96 #1):**

- (carried) Run `npm run docs:install` once (per clone).
- (carried) Re-run `npm run macro:backfill:v3` (non-blocking).
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply the pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3).
  - `migrate:create-etf-shares-outstanding-secondary:apply`.
- (carried) Create `data/etf_flow_issuer_csv/` + drop canonical-schema CSVs.
- (carried) Push 61 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this slice (s96 #2 — 1 commit `3796fde`)

| Path | LOC | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_13d_g_ingest.py` | +410 (NEW) | Per-filing ingest. Reuses `_sec_edgar_helpers.py`. Per XD-3 no XML body fetch. CLI flags: `--url / --from-file / --start-date / --end-date / --snapshot-date / --user-agent / --resolve-filer-names / --dry-run / --apply`. |
| `scripts/migrate_create_schedule_13d_g_filings.ts` | +190 (NEW) | Source-table migration. Byte-pinned DDL. Pre+post-checks. |
| `scripts/tests/test_sec_edgar_13d_g_ingest.py` | +485 (NEW) | 26 tests covering T-XD13I-1..12 per SPEC §9.3 + edge cases (5 issuer/filer-extraction variants, 4 filer-resolver gating, idempotency proof). |
| `package.json` | +4 | 4 new npm scripts (ingest pair + migration pair). |
| `scripts/help.ts` | +2 | 2 new help entries for the ingest pair (migration pair has inline `help` exports). |

### CH state (no apply this slice — operator-gated)

Migrations created but not applied:
- `quantlab.schedule_13d_g_filings` — DDL ready in
  `scripts/migrate_create_schedule_13d_g_filings.ts`. Idempotent
  CREATE IF NOT EXISTS. Apply via
  `npm run migrate:create-schedule-13d-g-filings:apply` OR via the
  ingest's lazy-create on first `--apply` run.

### Tests (new this slice)

- `scripts/tests/test_sec_edgar_13d_g_ingest.py`: 26 pass.
- Full pytest at commit time: 377 passed (was 351; +26 new).
- `npm test` at commit time: 2939 pass / 1 fail (pre-existing
  `gicsSectorRepositoryHelper SMP-6` CH-unreachable, NOT a regression)
  / 28 skipped.
- `npx tsc --noEmit` baseline: 13 errors unchanged.
- `npm run check:help`: green.

## Watch-outs

### NEW from this turn (s96 #2)

- **Issuer-vs-filer split is structural, not heuristic.** The
  `extract_issuer_and_filer_ciks` helper is the SINGLE source of truth
  for the split across the ingest + dry-run logger + (future) v2
  reputation table. Any downstream consumer that re-derives the split
  via its own logic risks silent divergence — always call the helper.

- **Filer CIK from accession-prefix is an EDGAR storage convention, not
  a SEC standard.** Some agent-filed 13D/Gs (rare) may store under the
  agent's CIK instead of the filer's; the degenerate single-CIK
  fallback collapses these into `issuer_cik = filer_cik`. v2 may need
  to handle these via a small mapping table; v1 preserves the row.

- **`--resolve-filer-names` triggers N+1 submissions-API calls.** Each
  unique filer adds one extra round-trip to `data.sec.gov`. On a
  90d ingest window with ~500 unique filers that's ~500 extra
  requests — still well under the 10 req/sec rate limit but adds
  noticeable latency. Default OFF is the right call until v2 ADR
  lifts this into a continually-maintained reputation table.

- **Test fixture CIK conventions follow EDGAR storage convention.** The
  fixture in `test_sec_edgar_13d_g_ingest.py` lists
  `ciks: [filer_cik, issuer_cik]` (filer first) — matching the
  observed shape from real EDGAR JSON. The extraction helper is order-
  insensitive (T-XD13I-11 pins this), but the fixture order documents
  the dominant pattern for future test authors.

### Carried from s96 #1

All s96 #1 watch-outs preserved unchanged. Key carry-overs:

- The SPEC is the contract for XD13-A2..A5 — any divergence is a SPEC
  violation, not a SPEC update.
- `is_amendment` MUST be derived from `form_type` suffix (now also
  enforced + tested in the row builder).
- Filer CIK ≠ issuer CIK at every layer (now enforced + tested).
- Pre-filing return capture is structurally impossible.
- 13G is canon-documented to carry signal (Edmans-Fang-Zur 2013).
- All earlier s89-s95 #9 watch-outs preserved.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Gap #7 v2 Schedule 13D/G (XD13-A1 LIVE)

```text
# Operator-pending (first run):
npm run migrate:create-schedule-13d-g-filings           # dry-run
npm run migrate:create-schedule-13d-g-filings:apply     # apply DDL
npm run edgar:13d-g:ingest:dry                          # dry-run
npm run edgar:13d-g:ingest                              # apply ingest
# Optional: resolve filer names today (v2 ADR will lift this default):
.venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py --resolve-filer-names --apply
# Once XD13-A3 lands:
npm run migrate:create-schedule-13d-g-snapshots:apply
# Once XD13-A4 lands:
npm run daemon:daily                                    # populates schedule_13d_g_snapshots
# Once XD13-A5 lands:
npm run brief:morning                                   # §16 renders
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE; per-row + per-EVENT recency BOTH LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow (v1 + v2 + v3 ALL LIVE)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest                                          # v1 yfinance primary
npm run migrate:create-etf-flow-snapshots:apply
npm run migrate:create-etf-shares-outstanding-secondary:apply    # v3 — one-time
# Drop canonical-schema CSVs (header: ticker,date,shares,close) in data/etf_flow_issuer_csv/, then:
npm run etf:flow:issuer-csv:ingest:dry
npm run etf:flow:issuer-csv:ingest
npm run daemon:daily
npm run brief:morning                                            # §13 sub-section
```

### macro_regime_v3 — re-backfill (operator-pending)

```text
npm run macro:backfill:v3
```

### Tests + dev

```text
npm test                                                                       # TS — last green at s96 #2 close: 2939 pass / 1 fail / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #2 close: 377 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #2 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 295 emitted from 113 inputs
```

## For the next session — priority order

**Default on `continue`:** **XD13-A2** — pure-function composite +
22 unit tests per SPEC §9.1. Pattern established from the sibling
EK / F4 composites (`src/server/eight_k_classifier.ts` /
`src/server/form_4_insider.ts`). Estimated 2-3 files / ~700-900 LOC /
22 tests / 1 commit.

**Acceptance criteria** for XD13-A2:

- ✓ `npm test` green at +22 new tests.
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ Composite version stamp = `'schedule_13d_g_v1'`.
- ✓ Per-stock + aggregate paths match SPEC §5.1 / §5.2 formulas exactly.
- ✓ Acceptance-date filter defense-in-depth at composite layer (NOT just at ingest).
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6`
  failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the
default-next:

- **Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter** (~250-300 LOC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions**.
- **Renderer docstring refresh** for the EK section (stale).

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- **Schedule 13D/G Phase B independence test** — earliest ~2026-07-20
  (assuming first apply-run lands in s96 + ~6-8 weeks of ingest
  history; backfill arc could compress this).

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**Gap #7 now has THREE parallel Layer-0 composites in flight:**

- **EK (8-K classifier)** — DONE end-to-end (s93..s95 #7), with per-EVENT recency LIVE.
- **F4 (Form 4 insider)** — DONE end-to-end (s93..s95 #4), with sell-cluster + per-row recency LIVE.
- **XD13 (Schedule 13D/13G activist-stake)** — **A1 LIVE (s96 #2);
  A2 NEXT.** SPEC + ADR shipped s96 #1; ingest + raw-event table
  shipped s96 #2. A2..A5 queued.

**The arc-shape parity is load-bearing.** XD13-A2 is the sibling of
F4-A2 + EK-A2. The shared infrastructure (`_sec_edgar_helpers.py`,
`cik_ticker_map`, acceptance-date anti-leak gate, ReplacingMergeTree
idempotency, version stamps) is now also bridged by the shared
`schedule_13d_g_filings` ingest + raw-event table. The differences
from F4-A1 + EK-A1 (now locked in):

- **Form type set.** XD13 = `{SC 13D, SC 13D/A, SC 13G, SC 13G/A}`.
  EK = `8-K, 8-K/A` (with item-code filtering). F4 = `4, 4/A`.
- **Schema shape.** XD13's raw-event table has no item_code (13D/G
  have no per-item structure); has `filer_cik` + `filer_name`
  columns (XD-7, XD-12). EK's raw-event table has `item_code`. F4's
  raw table is per-transaction with `person_cik` + `transaction_code`
  + `shares` + `price_per_share`.
- **Ingest body fetch.** F4 fetches XML body per filing. XD13 does
  NOT (XD-3). EK does NOT (item-code only).
- **Composite logic** (XD13-A2 ships this). XD13 = form-type-only
  proxy (XD-1). EK = item-code filtering. F4 = transaction-code
  filtering + cluster detection.
- **Brief section** (XD13-A5 ships this). XD13 = #16. EK = #14. F4 = #15.

**The v2 layers (filer reputation, NLP, supersession, cover-page %
parse) are all gated on Phase B + their own ADRs.** Do NOT auto-open
them.

**Backward compat preserved on three fronts:**

1. **CH:** No DDL apply this slice (operator-gated). The new
   `schedule_13d_g_filings` migration is idempotent + safe to apply
   before XD13-A2 lands.
2. **Type:** No TS type changes this slice. Future A2 slice adds
   `Schedule13DGSnapshot` interface; A4 slice adds the repository.
3. **Daemon:** Code untouched this slice. Future A4 slice wires step 1m.

**Parallel-tracks posture continues.** s96 #2 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Code-only slice — daemon
output unchanged + brief output unchanged.

**The chain through s96 #2:**

```text
ALL S41-S95 WORK                                        ✓ as documented
S96 #1: SPEC + ADR-043                                  ✓ committed (d68c2ab)
S96 #2: XD13-A1 — ingest + raw-event table              ✓ committed (3796fde)
        — scripts/sec_edgar_13d_g_ingest.py + 26 tests
        — scripts/migrate_create_schedule_13d_g_filings.ts
        — 4 npm scripts + 2 help entries
S96 #2 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: XD13-A2 (pure composite + 22 tests).
                  Sibling of F4-A2 + EK-A2. Pattern
                  established; ~2-3 files, ~700-900 LOC,
                  22 tests, 1 commit.
  → background: brief §16 placeholder; activates as
                soon as XD13-A5 lands. Until then,
                daily daemon runs unchanged.
```
