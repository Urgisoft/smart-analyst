# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #6 — **gap #7 EK-A5 DONE** as commit `7ee5852`. Closes the 8-K classifier arc end-to-end: section #14 render + composer wiring (+19 tests: 13 render + 3 composer + 3 build helper). v1 GICS-deferred footer + multi-item per-ticker rendering (auditor change (4.01) + restatement (4.02)) + CIK-only universe-coverage count per S93-28. All gates green (TS 2562/2539 pass +19 vs s93 #5 baseline of 2543, Python 259/259 unchanged, tsc 13 errors unchanged baseline, check:help ✓). 2 commits ahead of `origin/main` (origin synced through s93 #5 HANDOFF `1390fd9`); push still held — prior HANDOFFs' "69/70 commits ahead" carry-forward was stale, corrected here. **F4-A1 NEXT (Form 4 ingest)**.)

## What this turn delivered

Sixth slice of the gap #7 event-driven-filings-processor arc (s93 #6 — Phase EK-A5), closing the 8-K classifier arc:

1. **Section #14 render** — `src/server/operator_brief_render.ts` (~245 LOC delta). Per SPEC §8.1 + §9.5 T-OBR-EK-1..T-OBR-EK-7. Structure:
   - Header `## 14. 8-K material events — <CLUSTER|NORMAL>` (cluster label from `eightKClusterFlag`).
   - Aggregate sector panel: v1 cold-start renders GICS-deferred footer (sectors empty → no table); when v2 GICS ships, flaggedSectors populates and the renderer switches to `| Sector | Rate | z | Baseline n | Constituents |` table without code change.
   - Staleness line: `**Last EDGAR query:** <ISO> (N business days ago) [⚠ stale (≥4bd)]` — threshold `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8 exec-departure (both source EDGAR).
   - Per-ticker flagged section: `### Flagged tickers (universe: equity-midcap)` + `material_event (N):` + list. Sort by `daysSinceLatestEvent` ascending (recency first; nulls last); truncate at `EIGHT_K_CLASSIFIER_FLAGGED_TOP_N = 5`. Multi-item join via `formatEightKItemList` in fixed item-code order (1.01 → 5.01): `- ABCD — auditor change (4.01) + restatement (4.02) (12d ago)`.
   - Universe coverage: `Universe coverage: 58/60 mid-cap tickers have current CIK mapping · 0 aggregate constituents have usable sector mapping (v1: always 0 — GICS deferred).` Uses composer-stamped `tickersWithCikCount`/`watchUniverseTickerCount` per S93-28.
   - Composite caveat + evaluatedAt/snapshotDate footer.

2. **Composer wiring** — `src/server/operator_brief.ts` (~95 LOC delta):
   - Imports `EightKClassifierSnapshot`, `EightKClassifierRepository`, `eightKClassifierSnapshotsTableExists`, `BriefEightKClassifierSection`.
   - Adds `fetchLatestEightKClassifier?` dep on `BriefDeps`; threaded through `Promise.all` (now 17-way).
   - `buildEightKClassifierSection` helper: maps `EightKClassifierSnapshot` → `BriefEightKClassifierSection`; computes `tickersWithCikCount = perTickerRows.filter(r => r.cik !== '').length` and `watchUniverseTickerCount = perTickerRows.length` at this boundary so the renderer stays pure. Date fields converted to ISO at the section boundary.
   - `fetchLatestEightKClassifierFromCH` default: two-gate absent-table-safe (probe `eightKClassifierSnapshotsTableExists` → load via `repo.loadLatestSnapshot()` → null on any throw). Matches gap #9 etf-flow + gap #8 exec-departure + prior five Layer-0 composites exactly.

3. **Tests** — `scripts/tests/operatorBriefRender.test.ts` (+13 tests, ~306 LOC delta) + `scripts/tests/operatorBrief.test.ts` (+6 tests, ~181 LOC delta):
   - Render: not-yet-evaluated panel + T-OBR-EK-1 section ordering after #13 + T-OBR-EK-3 CLUSTER + flagged-sector table + NORMAL header + T-OBR-EK-4 cold-start v1 GICS-deferred footer + T-OBR-EK-6 staleness ≥4bd + omit-stale <4 + no-EDGAR-data fallback + T-OBR-EK-5 "No tickers flagged" + T-OBR-EK-7 multi-item join + T-OBR-EK-2 top-N=5 truncation + composer-stamped CIK-only count + evaluatedAt footer.
   - Composer: T-OB-EK-3 null pass-through + T-OB-EK-1 Promise.all threading + T-OB-EK-2 graceful-degrade.
   - buildEightKClassifierSection unit: null pass-through + Date→ISO mapping + S93-28 CIK-only count separation (3-row fixture: 2 with CIK, 1 with empty → tickersWithCikCount=2, inputsAvailablePerTicker=0).

4. **Test fixture updated** — `brief()` helper in `operatorBriefRender.test.ts` gained `eightK: null` default. No other MorningBrief construction sites required changes (composer always returns full shape; CLI wrappers go through composer).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 event-driven-filings-processor SPEC + teach-doc | ✓ s93 #1 (`48e0da1`) |
| Gap #7 EK-A1 (8-K event ingest + helper extraction + migration) | ✓ s93 #2 (`79b3ffa`) |
| Gap #7 EK-A2 (pure composite `eight_k_classifier_v1`) | ✓ s93 #3 (`1879b32`) |
| Gap #7 EK-A3 (snapshot-table migration co-bootstrap) | ✓ s93 #4 (`58cc98f`) |
| Gap #7 EK-A4 (repository + daemon step 1k hook) | ✓ s93 #5 (`39b6024`) |
| **Gap #7 EK-A5 (brief section #14 + composer wiring)** | **✓ s93 #6 (`7ee5852`) — closes EK arc end-to-end** |
| **Gap #7 F4-A1 (Form 4 EDGAR ingest)** | **☐ NEXT** |
| Gap #7 F4-A2..A5 (composite → migration → repository+daemon → brief #15) | ☐ queued after F4-A1 |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| Gap #7 v2 — GICS sector mapping activation (8-K aggregate panel) | ☐ deferred (operator-pickable; mirrors gap #8 v2) |
| Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32) | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow/8-K | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 2 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 6 (this turn, this commit) — EK-A5 implementation forks

**S93-32. Multi-item per-ticker rendering uses single `daysSinceLatestEvent` for the line; per-item recency deferred to v2.**
`Why:` SPEC §8.1 shows the aspirational format `ABCD — restatement (4.02) 12d ago + auditor change (4.01) 18d ago` with per-item recency. The EK-A2/EK-A3/EK-A4 snapshot payload carries ONE `daysSinceLatestEvent` per ticker (the most recent high-signal event across ALL items), not per-item recency. Rendering per-item recency would require either an A4 schema extension (carry per-item daysSince in the snapshot row) OR a fresh per-cycle CH read at brief-render time. Neither is a v1 deliverable. Three-criterion analysis:
  1. Canon — equal across alternatives. SPEC was aspirational; the test plan (§9.5 T-OBR-EK-7) only mandates multi-item join, not per-item recency.
  2. Methodology rigor — v1 path matches the payload exactly (no inference); per-item path requires schema bump or extra I/O.
  3. Minimum free parameters — v1 = 0. Per-item path adds N×7 cells to the snapshot row.

Result: `- ABCD — auditor change (4.01) + restatement (4.02) (12d ago)` — items joined with ` + `, single `(Nd ago)` suffix derived from `daysSinceLatestEvent`. Test T-OBR-EK-7 asserts the join; the single recency suffix is faithful to v1 payload.
`How to apply:` v2 enhancement (deferred operator-pickable insertion) extends EK-A2 + EK-A4 to thread per-item recency. Render switches to `restatement (4.02) Nd ago + auditor change (4.01) Md ago`. Composite version bumps to `eight_k_classifier_v2`.

**S93-33. Section #14 renders ALWAYS (even when cold-start) — null brief.eightK gets the "not yet evaluated" panel.**
`Why:` Matches every other Layer-0 panel (sections #7-#13). Operator scanning the brief should ALWAYS see section #14 — the absence-vs-present check tells them whether the daemon has run. Test "renders the 'not yet evaluated' panel when eightK is null" pins this; section ordering test T-OBR-EK-1 also depends on it (sections #1-#13 byte-equal + #14 always-present).
`How to apply:` Never conditionally skip `renderEightKClassifierSection` in `renderBriefMarkdown`. The renderer handles null internally. Same posture as `renderEtfFlowSection`, `renderExecutiveDepartureSection`, etc.

**S93-34. Sort flagged tickers by `daysSinceLatestEvent` ascending (recency first; nulls last) via `sortByRecency` helper.**
`Why:` Operator-facing brief should surface the most recent material events first. The existing `sortByRecency` helper from `renderExecutiveDepartureSection` (line 1640) handles null-trailing semantics. Reused as-is.
`How to apply:` `.slice().sort(...)` to avoid mutating the readonly snapshot payload. Test T-OBR-EK-2 uses `daysSinceLatestEvent: i+1` for fixtures (T0 = 1d, T1 = 2d, ...) so the truncation to top-5 deterministically keeps T0..T4 and drops T5..T6.

**S93-35. `formatEightKItemList` lives in the renderer module (presentation concern), NOT the composite.**
`Why:` The human-readable labels (`material agreement`, `acquisition`, `impairment`, `delisting`, `auditor change`, `restatement`, `change in control`) are presentation — they belong with the brief. The composite layer's `ITEM_CODE_FLAG_NAMES` constant maps codes to camelCase flag field names (`materialAgreementFlag`, etc.), which is a different concern (snapshot schema). Keeping the two separate prevents a render-layer change from triggering a composite version bump.
`How to apply:` Any change to the human-readable labels stays in `operator_brief_render.ts:formatEightKItemList`. Fixed item-code order (1.01 → 5.01) gives byte-stable output for byte-equal tests.

**S93-36. `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer (`buildEightKClassifierSection`), NOT by composite.**
`Why:` Per S93-28 (carried), the composite's `inputsAvailablePerTicker` is gated on sector presence (always 0 in v1). The brief needs a CIK-only count for the universe-coverage line. Computing it at the composer boundary keeps the renderer pure (no `.filter(...)` calls in the render path) AND keeps the composite version stable (no new field on the snapshot schema). Same architectural separation as `etf-flow`'s `flaggedEtfs.map(...)` shape transform at the composer boundary.
`How to apply:` v2 EK-A2 enhancement (if added) MAY add `inputsAvailablePerTickerCikOnly` to the composite snapshot if other consumers need it; the brief stays composer-stamped. Test "S93-28 — stamps CIK-only count separately from sector-gated inputsAvailablePerTicker" pins this contract.

### Sessions 84-93 #1-#5 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-31 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

## Open questions

### HIGH (carried)

1. **C-12 Phase B Alpaca onboarding** — paused indefinitely.
2. **CBOE DataShop subscription** — blocked under data-source policy.
3. **#5 capital-deployment-ramp ADR** — operator self-assigned ~1 week; not blocking.

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable).
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess for the 8-K ingest; operator-action verification deferred to first ingest run).
- Cold-start cascade timing for EK arc end-to-end (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

### Closed this turn

- ~~EK-A5 multi-item per-ticker rendering: per-item vs single recency~~ — RESOLVED per S93-32: items joined with ` + ` in code order; single `(Nd ago)` from `daysSinceLatestEvent`. v2 path documented.
- ~~EK-A5 section always-render vs conditional~~ — RESOLVED per S93-33: always render (null → "not yet evaluated" panel).
- ~~EK-A5 flagged-tickers sort order~~ — RESOLVED per S93-34: `sortByRecency` ascending; reused from gap #8.
- ~~EK-A5 item-label home (renderer vs composite)~~ — RESOLVED per S93-35: renderer owns presentation labels; composite owns schema field names.
- ~~EK-A5 CIK-only count source (composite vs composer)~~ — RESOLVED per S93-36: composer-stamped via `buildEightKClassifierSection`; renderer stays pure; matches S93-28 lock.

### Newly opened

- **F4-A1 Form 4 EDGAR ingest CLI** — first slice of the Form 4 arc. Per SPEC §2.3 + §9.10. Mirrors EK-A1 / gap #8 5.02 ingest architecturally: `scripts/sec_edgar_form4_ingest.py` + `scripts/_sec_edgar_helpers.py` (shared) → `quantlab.insider_trades` + `quantlab.insider_ciks`. Two-table write because person CIK ≠ issuer CIK per gap #7 EDF-class lock. Defaults: high-signal transaction codes = {P (open-market buy), S (open-market sale)} per F4-4.
- **F4-A1 ticker resolution: issuer CIK only, person CIK identity-only.** Per gap #7 SPEC: person CIK lookups are for cluster-detection identity (distinct insiders), NOT for ticker reverse-mapping. The composite operates on issuer-CIK tuples.
- **F4-A1 ReplacingMergeTree key** — `ORDER BY (issuer_cik, accession, transaction_code, line_no)` because one Form 4 filing can carry multiple transaction lines (e.g., 3 buys + 1 sell per accession). Schema spec at SPEC §6.2 (not yet read; defer until A1 read pass).
- **F4-A1 first-apply-run cold-start timing.** EDGAR full-text search for "owner-only" Form 4 filings has a higher volume than 5.02 (≈10× per day historical). First `--apply` run should default `--lookback-days 3` (not 30 like EK-A1) to avoid rate-limit churn; operator can run wider on demand.

## Next stage

### Default on "continue"

**Gap #7 F4-A1 — Form 4 EDGAR ingest CLI.** Concrete first move:

1. Read `docs/specs/event-driven-filings-processor.md` §2.3 + §6.2 + §9.10 — anchor SPEC for Form 4 ingest schema + tests. Also re-read §2.2 EK-A1 byte-for-byte so the new ingest stays architecturally aligned.
2. Read `scripts/sec_edgar_8k_event_ingest.py` end-to-end (s93 #2, EK-A1 precedent) + `scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 precedent) + `scripts/_sec_edgar_helpers.py` (shared module). F4-A1 follows this pattern.
3. Read `scripts/tests/test_sec_edgar_8k_event_ingest.py` (EK-A1 tests, 25 tests) as the test template.
4. Write `scripts/sec_edgar_form4_ingest.py` (~350-400 LOC est.) + `scripts/migrate_create_insider_trades.ts` (optional standalone migration; F4-A3 also co-bootstraps).
5. Write `scripts/tests/test_sec_edgar_form4_ingest.py` (~25-30 tests est.) per SPEC §9.10 T-F4I-1..T-F4I-N.
6. Add npm scripts `edgar:form4:ingest{:apply}` to `package.json` + `scripts/help.ts` EXTRA_HELP entries.
7. `npm test` + `pytest` green; commit as F4-A1 slice.

### After F4-A1 lands

Standard arc continues: F4-A2 (pure composite) → F4-A3 (snapshot-table migration co-bootstrap) → F4-A4 (repository + daemon step 1l) → F4-A5 (brief section #15). Each commits as its own slice.

### After F4 arc ships

Operator-pickable deferred insertions:

- ADR-041 implementation slot (`yield_curve_inverted` category).
- Gap #7 v2 — GICS sector mapping activation (8-K aggregate panel).
- Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32 v2 deliverable).
- Gap #7 v2 — CMP opportunistic-vs-routine classifier (≥6mo warm-up gated).
- Gap #7 v2 — 13D/13G arc (separate SPEC).
- Gap #7 v2 — event-driven cadence promotion (Phase B-gated).
- Gap #8 v2 — GICS sector activation.
- Gap #9 v2 — ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the seven (eight after F4 ships) Layer-0 composites.

## Files / code state

### NEW this turn (s93 part 6)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/operator_brief_render.ts` | EDITED (`7ee5852`) | +~245 LOC. `BriefEightKClassifierSection` interface + `EIGHT_K_CLASSIFIER_FLAGGED_TOP_N=5` + `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD=4` constants + `eightK: BriefEightKClassifierSection \| null` field on `MorningBrief` + `renderEightKClassifierSection` + `formatEightKItemList` helper. Section #14 always rendered. |
| `src/server/operator_brief.ts` | EDITED (`7ee5852`) | +~95 LOC. Imports `EightKClassifierSnapshot`/`EightKClassifierRepository`/`eightKClassifierSnapshotsTableExists`/`BriefEightKClassifierSection`. Adds `fetchLatestEightKClassifier?` dep + default `fetchLatestEightKClassifierFromCH` graceful-degrade fetcher. Adds `buildEightKClassifierSection` helper (Date→ISO + computes `tickersWithCikCount`/`watchUniverseTickerCount` per S93-28/S93-36). Threads through 17-way `Promise.all` + brief return shape. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`7ee5852`) | +~306 LOC. `brief()` fixture gained `eightK: null` default. +13 tests for section #14 (T-OBR-EK-1..T-OBR-EK-7 + 6 supplemental: not-yet-eval, NORMAL header, omit-stale-<4, no-EDGAR-fallback, universe-coverage CIK-count, evaluatedAt footer). |
| `scripts/tests/operatorBrief.test.ts` | EDITED (`7ee5852`) | +~181 LOC. +3 composer-wiring tests (T-OB-EK-1..T-OB-EK-3) + 3 buildEightKClassifierSection unit tests (null pass-through, Date→ISO mapping, S93-28 CIK-only-count separation). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-EK-arc state. |

### From s93 #5 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier_repository.ts` | EXISTS (`39b6024`) | ~480 LOC. EK-A4 repository. Now imported by `operator_brief.ts`. |
| `scripts/tests/eightKClassifierRepository.test.ts` | EXISTS (`39b6024`) | ~640 LOC, 53 tests. |
| `scripts/daily_signal_daemon.ts` | EXISTS (`39b6024`) | Step 1k hook between step 1j etf-flow and §2 cells/bundles. |

### From s93 #4 / #3 / #2 / #1 (carried; unchanged)

All prior gap #7 EK arc files preserved unchanged.

### CH state (unchanged from s93 #5)

- All seven Layer-0 composite snapshot tables in same state as s93 #5 close.
- `quantlab.eight_k_events` — NOT yet created (EK-A1 ingest creates lazily; EK-A1 standalone migration also creates; EK-A3 co-bootstrap also creates).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (EK-A3 migration script exists; not yet applied).
- `quantlab.insider_trades` + `quantlab.insider_ciks` — NOT yet created (F4-A1 will create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (F4-A3 will create).

### Tests

```text
npm test                       2562 / 2539 pass / 0 fail / 23 skipped   ✓ (+19 vs s93 #5 end — 13 render + 3 composer + 3 build helper)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   259 / 259 (unchanged from s93 #5 end — EK-A5 added 0 Python tests)
```

## Watch-outs

### NEW from this turn (s93 #6)

- **Single `daysSinceLatestEvent` per ticker in section #14 (S93-32).** The aspirational SPEC §8.1 shows per-item recency (`restatement (4.02) 12d ago + auditor change (4.01) 18d ago`); v1 carries ONE `daysSinceLatestEvent` per ticker. Renderer emits `auditor change (4.01) + restatement (4.02) (12d ago)` — items joined with ` + `, single recency suffix. v2 enhancement: extend EK-A2 to carry per-item recency on the snapshot row.
- **`formatEightKItemList` order is fixed at code 1.01 → 5.01.** Stable byte-equal output. Reordering would break test T-OBR-EK-7 (`auditor change (4.01) + restatement (4.02)` exact match).
- **`tickersWithCikCount` + `watchUniverseTickerCount` computed by composer (S93-36).** Renderer is pure (no `.filter` calls). Adding a NEW universe-coverage stat (e.g. "tickers with at least 1 event") would also go in the composer; the composite stays stable.
- **Section #14 always renders (S93-33).** Skipping it would break section ordering tests (T-OBR-EK-1 + future F4-T-OBR-F4-1). `null → "not yet evaluated"` panel is the canonical pre-data state.
- **`EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8 exec-departure (`EXECUTIVE_DEPARTURE_STALENESS_BD_THRESHOLD = 4`).** Both EDGAR-sourced; Sarbanes-Oxley §409 4bd 8-K statutory filing deadline justifies the threshold. NOT etf-flow's `3` (yfinance daily).
- **`fetchLatestEightKClassifierFromCH` is two-gate absent-table-safe.** Probes table first → loads → returns null on any throw. Matches every prior Layer-0 composite's graceful-degrade posture. A regression that removed the probe would surface a CH error at brief-render time instead of degrading silently.
- **`brief()` fixture in `operatorBriefRender.test.ts` now requires `eightK: null` default.** Future MorningBrief field additions need similar fixture updates. The composer always returns the full shape (no caller-side breakage from adding optional fields).

### Carried (s89-s93 #1-#5 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 2 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated. Prior HANDOFFs' "69/70 commits ahead" carry-forward was stale; corrected at s93 #6.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate (gap #8 E-7 + gap #7 EDF-5 + F4-10).
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1); gap #7 EK-A1 does NOT (item-level only per EK-2; cheaper).
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL per EK-5.
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (NEW for gap #7 Form 4; separate `insider_ciks` table).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4.
- A5 byte-equal protection on sections #1-#13 (PLUS rendered #14 (8-K — NOW IN PLACE) + planned #15 (Form 4) appended at tail).
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3` for etf-flow; `>= 4` for EDGAR composites) — render layer (operator_brief_render) owns the threshold constants per-composite.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried).
- `composite_version` vs `version` mapping at the EK-A4 write boundary (load-bearing translation, tested).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters) — EK arc has no Float scalars; safe.
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module (s93 #2; F4-A1 will follow).
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat; s93 #2; F4-A1 will follow).
- `build_event_search_url` raises ValueError on empty items (programming error).
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker; no `help` export needed.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess; operator-action verified on first `--apply` run.
- **EK-A2 (carried):** `materialEventFlag` derives from `recentEventCount90d >= 1` (not OR-of-per-item-flags); per-item flag count uses exact string equality; distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string-Set; `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`; `HIGH_SIGNAL_ITEM_CODES` also pinned in Python ingest `DEFAULT_HIGH_SIGNAL_ITEMS` (cross-language drift uncaught).
- **EK-A4 (carried):** `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Repository reuses ticker stored on `eight_k_events` row at read time (no per-event CIK JOIN). Two-gate daemon posture (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`). EXPLAIN PLAN tests skip cleanly when source tables absent.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites + 8-K classifier (step 1k) when both EK gates clear; will gain Form 4 hook at F4-A4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#14 with real data once migrations applied; #15 added by F4-A5
```

### Gap #9 etf-flow activation (FULLY READY end-to-end)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily       # step 1j fires
npm run brief:morning      # section #13 renders
```

### Gap #10 short-interest activation (post-merge / per-operator-decision)

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation (post-merge / per-operator-decision; FULLY READY)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily       # step 1i fires
npm run brief:morning      # section #12 renders
```

### Gap #7 8-K classifier activation (FULLY READY end-to-end — EK arc COMPLETE)

```text
# EK-A1 ingest (READY):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest

# EK-A1 source-table standalone migration (READY — idempotent; optional, ingest lazy-creates):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A2 composite (READY — pure-function; called by EK-A4 daemon hook):
# Importable from src/server/eight_k_classifier.ts; no operator-runnable npm script.

# EK-A3 snapshot-table migration co-bootstrap (READY — idempotent; creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 daemon step 1k (READY — both gates absent-table-safe):
npm run daemon:daily       # step 1k fires once EK-A1 source + EK-A3 snapshot tables present

# EK-A5 brief section #14 (READY — composer threads + renderer renders):
npm run brief:morning      # section #14 renders end-to-end
```

### Gap #7 Form 4 activation (NOT YET READY — F4-A1..A5 pending; NEXT slice arc)

```text
# F4-A1 (PENDING):
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --apply

# F4-A3 (PENDING):
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply

# F4-A4 (PENDING):
npm run daemon:daily       # step 1l will fire

# F4-A5 (PENDING):
npm run brief:morning      # section #15 will render
```

### Tests + dev

```text
npm test                                                                       # TS — 2562 / 2539 pass / 0 fail / 23 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 259 / 259
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 F4-A1 — Form 4 EDGAR ingest CLI. Single atomic slice:

1. **(Read)** `docs/specs/event-driven-filings-processor.md` §2.3 + §6.2 + §9.10 (Form 4 SPEC sections).
2. **(Read)** `scripts/sec_edgar_8k_event_ingest.py` (s93 #2 EK-A1 precedent, ~370 LOC) + `scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 precedent) + `scripts/_sec_edgar_helpers.py` (shared module).
3. **(Read)** `scripts/tests/test_sec_edgar_8k_event_ingest.py` (EK-A1 tests, 25 tests; F4-A1 mirror).
4. **(Write)** `scripts/sec_edgar_form4_ingest.py` (~350-400 LOC est.). Two-table write to `quantlab.insider_trades` + `quantlab.insider_ciks`. ReplacingMergeTree key `(issuer_cik, accession, transaction_code, line_no)` (multi-row-per-accession). Default high-signal codes = {P, S} per F4-4.
5. **(Write)** Optional `scripts/migrate_create_insider_trades.ts` standalone migration (F4-A3 also co-bootstraps).
6. **(Tests)** `scripts/tests/test_sec_edgar_form4_ingest.py` (~25-30 tests est.) per SPEC §9.10.
7. **(Wire)** npm scripts `edgar:form4:ingest{:apply}` in `package.json` + `scripts/help.ts` EXTRA_HELP entries.
8. **(Gates)** `npm test` + `pytest` green; commit as F4-A1 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #7 v2 GICS sector activation for 8-K aggregate panel (operator-pickable insertion).
- Gap #7 v2 per-item recency for 8-K brief section #14 (S93-32 v2; operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 2 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #7 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #7 v2 per-item recency for 8-K brief (operator-pickable; deferred-but-defined per S93-32).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- Gap #7 v2 CMP classifier (calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven (eight after F4) Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s93 #6 closes the 8-K classifier arc end-to-end. EK-A1 ingest → EK-A2 composite → EK-A3 migration → EK-A4 repository+daemon → EK-A5 brief section #14. The arc shipped in 5 commits over s93 #2..#6 plus the SPEC + teach-doc slice at s93 #1 (`48e0da1`). 8-K material events are now fully observable in `npm run brief:morning` once both EK-A1 source + EK-A3 snapshot tables are applied (operator-gated activation).

The next slice arc is gap #7 F4 (Form 4 insider activity): F4-A1 → F4-A2 → F4-A3 → F4-A4 (daemon step 1l) → F4-A5 (brief section #15). Same architectural template as the EK arc + the prior three Layer-0 composites (gap #10 short-interest, gap #8 exec-departure, gap #9 etf-flow). Estimated ~5 slices over multiple sessions; each commits as its own slice.

v1 GICS-sector deferral mirrors gap #8 exec-departure: per-ticker layer fully active, aggregate-sector layer dormant in v1. v2 GICS activation is a separate operator-pickable insertion that ships `quantlab.gics_sector_map` and activates BOTH gap #7 8-K + gap #7 Form 4 + gap #8 exec-departure aggregate panels with one slice.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open F4-A1. Build `scripts/sec_edgar_form4_ingest.py` mirroring EK-A1 (s93 #2 `79b3ffa`) closely. ~25-30 new Python tests. Single atomic slice (matches the prior four ingest precedents' atomicity: gap #10 FINRA, gap #8 5.02, EK-A1 8-K-event, hypothetical F4-A1).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #6:**

```text
ALL S41-S91 WORK                                       ✓ as documented
S90: gap #10 short-interest-tracking arc               ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc             ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                                   ✓ committed (6e9ffe0)
S92 #1..#6: gap #9 etf-flow-monitoring arc             ✓ COMPLETE end-to-end (6 commits)
S92 HANDOFF rewrite                                    ✓ committed (706a8b8)
S93 #1: gap #7 SPEC + teach-doc                        ✓ committed (48e0da1)
S93 #1 HANDOFF rewrite                                 ✓ committed (87985b1)
S93 #2: gap #7 EK-A1 — 8-K event ingest                ✓ committed (79b3ffa)
S93 #2 HANDOFF rewrite                                 ✓ committed (ca0f20b)
S93 #3: gap #7 EK-A2 — pure composite                  ✓ committed (1879b32)
S93 #3 HANDOFF rewrite                                 ✓ committed (ffb4881)
S93 #4: gap #7 EK-A3 — snapshot-table migration        ✓ committed (58cc98f)
S93 #4 HANDOFF rewrite                                 ✓ committed (449406a)
S93 #5: gap #7 EK-A4 — repository + daemon step 1k     ✓ committed (39b6024)
S93 #5 HANDOFF rewrite                                 ✓ committed (1390fd9)
S93 #6: gap #7 EK-A5 — brief section #14 (CLOSES EK arc) ✓ committed (7ee5852)
S93 #6 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 F4-A1 — Form 4 EDGAR ingest CLI
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5 ✓ (COMPLETE)
  → gap #7 F4 arc: A1 → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #7 v2 GICS, gap #7 v2 per-item recency,
                                   gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence
  → background: daemon writes per-cycle snapshots for all 8 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow, 8-K-classifier
                — once EK-A1 source + EK-A3 migration applied); adding Form 4
                insider once F4 arc ships.
```
