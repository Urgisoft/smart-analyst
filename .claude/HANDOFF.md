# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 95 #3 — **HOTFIX: form 4 ingest XML body URL discovery via EDGAR index.json**. First-apply-run surfaced two stacked bugs in `npm run edgar:form4:ingest --apply` (100% 404 on body fetch): (a) EDGAR Form 4 search hit JSON omits `primary_doc`/`file_name`, so `parse_edgar_search_response` fell through to the non-existent `primary.htm`; (b) `ciks: [insider, issuer]` ordering means a single fallback CIK is risky for agent-filed cases. Fix: `discover_form4_primary_xml_url` fetches `/Archives/.../index.json`, tries each `ciks_all[]` candidate until 200, selects the XML by precedence (form4-named → primary_* → any non-stylesheet .xml). Session-local cache. 3 files touched, +318 / -2 LOC, 8 new tests `T-F4I-DISCOVER-{1..8}`. Python suite 332 pass (324 baseline + 8 new). Live-fire validation against two of the operator's actual 404'd accessions resolves correctly (`primary_01.xml` + `form4-05212026_060556.xml`). Single commit `831b1b0`. **38 commits ahead of `origin/main`.** **NEXT default on `continue`: operator re-runs `npm run edgar:form4:ingest --apply` to actually populate `insider_trades` — then daemon + brief surface the buy/sell panels with real data. After that: operator pick from the candidate list (recommended if just "continue": Gap #7 v2 per-row recency).**)

## What this turn delivered

A code hotfix that unblocks the **first-real-apply** of the Form 4 ingest. Earlier sessions (s93 #7-#11) shipped the F4 architecture end-to-end and the operator's `npm test` was green — but the unit tests inject `primary_doc: "wk-form4.xml"` into hit fixtures, masking the real EDGAR behavior where Form 4 hits omit that field entirely. The handoff has long carried a "First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess; verification deferred to first ingest run)" risk — this turn surfaced + closed exactly that risk for the XML body fetch path.

1. **`scripts/_sec_edgar_helpers.py`** (+8 LOC):
   - `parse_edgar_search_response` now emits a new `ciks_all: list[str]` field on each filing dict — the full deduped CIK list, zero-padded to 10 digits, in source order. Existing `cik` field unchanged (still `cik10(ciks[0])`). 8-K consumers are unaffected (the new field is additive, not consumed by them).

2. **`scripts/sec_edgar_form4_ingest.py`** (+134 / -2 LOC):
   - `_select_form4_xml_from_directory(items)` — pure helper that picks the data XML from an EDGAR index.json `directory.item[]` listing. Precedence: (1) name contains `form4` (case-insensitive); (2) name starts with `primary_`; (3) any `.xml` that isn't a stylesheet (heuristic: name has no `xsl` / `x05` / `x06`). Multiple matches at same tier → first in directory order.
   - `discover_form4_primary_xml_url(accession_nodash, candidate_ciks, user_agent, cache, fetch=fetch_edgar)` — tries each CIK against `/Archives/edgar/data/{cik}/{accession}/index.json`; first 200 with a selectable XML wins. Returns absolute URL or None. Cached by accession; cache is positive-only (failures retry).
   - `_xml_for(filing)` in `main()` — detects the parser's `primary.htm` fallback by suffix match. If hit, invokes discovery with `filing["ciks_all"]` as candidates and falls through to the legacy WARN path if discovery exhausts all CIKs. If the parser supplied an explicit `primary_doc` URL (test path), the discovery round-trip is skipped — test fidelity preserved.

3. **`scripts/tests/test_sec_edgar_form4_ingest.py`** (+178 LOC; 8 new tests):
   - **T-F4I-DISCOVER-1** — directory with only `primary_01.xml` resolves.
   - **T-F4I-DISCOVER-2** — `wf-form4_*.xml` outranks `primary_*.xml` by precedence.
   - **T-F4I-DISCOVER-3** — non-conventional `ownership_doc.xml` resolves via fall-through tier.
   - **T-F4I-DISCOVER-4** — first CIK 404s; second succeeds (models Computershare-style agent case).
   - **T-F4I-DISCOVER-5** — all candidates 404 → returns None for the WARN path.
   - **T-F4I-DISCOVER-6** — cache reuse: second call for same accession hits cache, zero extra fetches.
   - **T-F4I-DISCOVER-7** — stylesheet `xslF345X06.xml` excluded; `primary_01.xml` wins.
   - **T-F4I-DISCOVER-8** — `parse_edgar_search_response` emits `ciks_all` (10-padded, deduped, source order).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH | ✓ s94 #1-#5 |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| Gap #7 v2 sell-cluster F4 composite contract | ✓ s95 #1 (`b398b4e`) |
| Gap #7 v2 sell-cluster F4 G3 (DDL + persistence + log + render) | ✓ s95 #2 (`d05eb39`) — F4 ARC FULLY CLOSED |
| **Form 4 ingest XML body URL discovery (hotfix)** | **✓ s95 #3 (`831b1b0`) — UNBLOCKS first apply** |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable |
| Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap) | ☐ deferred (operator-pickable; recommended next default) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 38 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 part 3 (this turn, one commit `831b1b0`)

**S95-11. EDGAR Form 4 body URL is discovered, not constructed.** The full-text-search Form 4 hit JSON omits `primary_doc`/`file_name`; storage paths vary (`primary_01.xml` modern / `wf-form4_<digits>.xml` older / `form4-<timestamp>_<seq>.xml` agent-filed). The robust resolver fetches `/Archives/edgar/data/{cik}/{accession_nodash}/index.json`, picks the data XML by name precedence, and tries each candidate CIK until one returns 200.
`Why:` The parser was constructing URLs against a missing field, falling through to `primary.htm` which doesn't exist for Form 4 — producing 100% 404 on first-apply. Tests masked this by injecting `primary_doc` into hit fixtures. Discovery via `index.json` is canonical EDGAR practice and adds ~1 round-trip per filing (free at 10 req/sec ceiling) on uncached entries.

`How to apply:` Discovery is INVOKED only when the parser's `primary.htm` fallback fires (suffix match on filing_url). Test fixtures with explicit `primary_doc` skip the round-trip — backwards-compatible. If a future Form 3/5 ingest emerges, it should use the same discovery shape (same EDGAR storage convention).

**S95-12. `parse_edgar_search_response` emits a NEW `ciks_all: list[str]` field.**
`Why:` Form 4 search hits return `ciks: [insider, issuer]`. The legacy `cik` field is `ciks[0]` (insider), but EDGAR sometimes stores the filing under a different CIK (agent-filed cases where Computershare et al. submit on behalf of an insider). The discovery resolver needs the full list to try each candidate.

`How to apply:` 8-K consumers ignore the new field (additive, non-breaking). Future EDGAR ingest scripts that need multi-CIK fallback use `filing["ciks_all"]` directly; single-CIK consumers continue using `filing["cik"]`.

**S95-13. XML selection precedence: form4-named → primary_* → any non-stylesheet .xml.**
`Why:` Modern EDGAR Form 4 filings name the data file `primary_01.xml`; older ones use `wf-form4_<digits>.xml` or `<ticker>-form4.xml`; agent-filed ones use `form4-<timestamp>_<seq>.xml`. The form4-substring tier covers older + agent-filed; the `primary_` tier covers modern; the catch-all handles non-conventional naming. Stylesheet XMLs (`xslF345X06.xml`) are excluded via name heuristics.

`How to apply:` If a future Form 4 filing legitimately ships multiple `*form4*.xml` files (multi-part rare case), the FIRST in directory order wins. Document the assumption; revisit only if a real case surfaces. Single XML files always resolve cleanly via the catch-all tier even if naming is unconventional.

**S95-14. Discovery cache is positive-only (negative results NOT cached).**
`Why:` A 404 on first attempt could be transient (EDGAR archive replication lag, transient CDN miss). Caching negative results would lock in transient failures across a multi-day ingest run. Positive results are stable (once an XML is found at a given URL, that URL doesn't move).

`How to apply:` On all-CIK exhaustion, the resolver returns None and emits the WARN; the next ingest run retries from scratch. Cache lifetime is per-process (no on-disk persistence — the ingest typically completes in one process invocation).

**Carry-over from s95 #2 (still in force):**

- S95-6..S95-10 — sell-side persistence + render conventions, log-line suffix-extension, EK/XD buy-side-only, footer placement.

**Carry-over from s95 #1 (still in force):**

- S95-1..S95-5 — sell-cluster composite parameters + interface posture.

**Carry-over from s94 #11 (still in force):**

- S94-29..S94-33 — sector cluster rate, daemon log line tokens, render branch order.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-33 + S95-1..S95-10 carry through.

## Open questions

### Newly opened (s95 #3) — none

The discovery fix is self-contained; no canon-thin forks remain within the slice scope.

### Carried unchanged from s95 #2

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default.

### CARRIED (unchanged)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only (no point-in-time correctness for the gics_sector_map v1 ingest).
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push commits to origin/main — operator-gated.
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess; verification deferred to first ingest run) — **note: the XML-body half of this risk closed s95 #3; the Item-filter half remains open.**
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

## Next stage

### Default on `continue` — operator re-runs the Form 4 ingest

The hotfix unblocks the first real `--apply` run. Recommended sequence the operator picked up mid-runbook last turn:

```text
npm run edgar:form4:ingest               # NOW WORKS — was 100% 404 before s95 #3
npm run daemon:daily                     # F4 aggregate panel populates from real data
npm run brief:morning                    # section #15 surfaces real buy/sell panels (was cold-start)
```

After that, the operator picks the next code slice. If they just say "continue" with no context, the recommended next is **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs) — the next code-only slice that builds incrementally on the v2 arc without opening new methodology questions.

### Candidate slices (in rough order of "next obvious code-only work")

1. **Gap #7 v2 per-row recency** — S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs. Add `daysSinceLatestEvent` / `daysSinceLatestBuy` / `daysSinceLatestSell` fields to the per-ticker row payload so the SPEC §8.2 mockup's "last 23d" recency hint lands. Single-slice, ~3 files, ~80 LOC, ~6-8 tests. One operator-gated DDL migration (new columns on `eight_k_classifier_snapshots` + `form_4_insider_snapshots`).

2. **ADR-041 implementation** (`yield_curve_inverted` regime category) — operator-pickable, the canon work is done (ADR Accepted s89). Activation slice extends the regime classifier with the new category + adds the dashboard surfacing. ~5-6 files, ~150 LOC, ~10 tests.

3. **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — adds a secondary data path that cross-validates the primary etf-flow ingest against an issuer-supplied CSV when available; logs divergences as anomalies. Operator-pickable.

4. **Gap #7 v2 13D/13G arc** — needs its own SPEC first; deferred until operator says go.

5. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

6. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

7. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

8. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

### Operator-gated action items (carried + new)

- **NEW:** Re-run `npm run edgar:form4:ingest --apply` (was blocked pre-s95 #3; now works).
- Apply DDL migration `migrate:add-sell-cluster-form-4-insider-snapshots:apply` to surface s95 #2 persistence end-to-end on the real CH instance (still pending from s95 #2).
- Push 38 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s95 #3 — commit `831b1b0`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | +8 | `parse_edgar_search_response` adds `ciks_all: list[str]` (zero-padded, deduped, source order). Existing `cik` unchanged. |
| `scripts/sec_edgar_form4_ingest.py` | +134 / -2 | `_select_form4_xml_from_directory` + `discover_form4_primary_xml_url` + `_xml_for` rewrite to invoke discovery on parser-fallback path. Session-local `xml_url_cache`. |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | +178 | 8 new `T-F4I-DISCOVER-{1..8}` tests covering precedence + CIK iteration + cache + stylesheet exclusion + ciks_all parser field. |

### Carried unchanged from s95 #2 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` | s95 #2 SHIPPED | Operator-gated ALTER ready to apply (4 sell-side columns). |
| `src/server/form_4_insider_repository.ts` | s95 #2 LIVE | Persists + decodes sell-side fields; daemon log line carries sell-side tokens. |
| `src/server/operator_brief.ts` | s95 #2 LIVE | Composer pass-through for buy + sell maxAggregateZ + 4 sell-side fields. |
| `src/server/operator_brief_render.ts` | s95 #2 LIVE | §1.4 parallel buy/sell three-branch panels on F4. |

### Carried from s94 #6-#11 + s95 #1 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Steps 1-5 SHIPPED. |
| Three composite `xxx.ts` source files (XD/EK/F4) | s95 #1 close | maxAggregateZ + sector live; F4 has sell-side composite contract. |
| Three `xxx_repository.ts` source files | s95 #1+#2 close | populateSectorsForCycle wired across all; F4 computes baseline2ySell + persists + logs sell-side. |
| Three migrate_add_max_aggregate_z*.ts scripts | s94 #8 SHIPPED | Operator-gated ALTERs ready to apply. |

### CH state

- Nine Layer-0 composite snapshot tables + three event tables remain in the state from s93 / s94 / s95 #1+#2 close.
- **Operator-pending ALTERs:**
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3, carry from s94 #8) — adds `maxAggregateZ` + `maxAggregateZSector` columns on each Layer-0 snapshot table.
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2) — adds 4 sell-side columns on F4 snapshot table.
- **No new CH state from s95 #3.** This was a pure Python ingest hotfix.

### Tests (validated this turn)

```text
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py -q
                                                              # 47 pass (39 original + 8 new T-F4I-DISCOVER-{1..8})

.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_8k_item_5_02_ingest.py \
                                  scripts/tests/test_sec_edgar_8k_event_ingest.py -q
                                                              # 53 pass — confirms ciks_all parser field is non-breaking

.venv/Scripts/python.exe -m pytest scripts/tests -q           # 332 pass / 24 warnings (sklearn FutureWarning, pre-existing)
                                                              # +8 net vs baseline 324 = exactly the T-F4I-DISCOVER-{1..8} tests
```

Live-fire smoke against two of the operator's actual 404'd accessions:

```text
0001324948-26-000015 → https://www.sec.gov/.../1310979/000132494826000015/primary_01.xml
0001811085-26-000006 → https://www.sec.gov/.../1811085/000181108526000006/form4-05212026_060556.xml
```

Both resolve successfully. The first illustrates the modern `primary_01.xml` naming; the second illustrates the agent/timestamp-style `form4-<date>_<seq>.xml` naming.

`npm test` NOT re-run this turn (no TS touched). Last full-run baseline at s95 #2 close was 2898 / 2801 pass / 2 fail (pre-existing CH-unreachable) / 95 skipped.

## Watch-outs

### NEW from this turn (s95 #3)

- **`discover_form4_primary_xml_url` adds ~1 HTTP round-trip per filing on the first apply run.** At EDGAR's 10 req/sec ceiling, a 100-filing ingest takes ~10 extra seconds on top of the existing 100 body fetches (~20 seconds total). For a 90-day window (~10k-20k Form 4s), that's ~30-60 extra minutes. The cache amortizes within a single process, but each ingest invocation starts cold. If this becomes a perf issue, an on-disk cache keyed by accession would amortize across runs — but it's not needed for daily ingest cadences.

- **The discovery resolver consumes `filing["ciks_all"]`, which only exists after the s95 #3 parser change.** If a future ingest script reads cached JSON from an older session and expects the post-s95-#3 dict shape, it MAY get a KeyError on `ciks_all`. `_xml_for` defends with `.get("ciks_all") or [filing.get("cik", "")]` — single-CIK fallback. If you write a new EDGAR ingest, prefer `filing["ciks_all"]` over `filing["cik"]` when multi-CIK fallback matters.

- **The XML selection heuristics MAY misclassify if EDGAR ever ships a non-stylesheet XML whose name contains `xsl` / `x05` / `x06`.** That's a low-probability case (Form 4 XML data files don't currently carry those substrings) but worth knowing. If a future EDGAR rename triggers misclassification, the test list pin (`T-F4I-DISCOVER-7`) needs an additional case + the heuristics refined.

- **Discovery cache is positive-only (S95-14).** Transient 404s on first attempt retry on every re-run of the script. Multi-day persistent failures would surface as repeated WARN lines per accession in the daemon log — operator should watch for this pattern as a sign of EDGAR archive trouble (vs a missing single filing).

- **The legacy `_xml_for` fallback path (filing_url NOT ending in `/primary.htm`) is now reserved for tests + future EDGAR-API-change-recovery.** If EDGAR fixes the search-hit JSON to include `primary_doc` for Form 4, the discovery round-trip disappears automatically (the parser fallback never fires) — no code change needed.

### Carried from s95 #2 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- **`Form4InsiderSnapshot` writeSnapshot drops sell-side columns on PRE-MIGRATION tables** until the operator applies `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
- **`BriefForm4InsiderSection` has 4 REQUIRED sell-side fields** — any future fixture must include them.
- **The daemon `[f4-aggregate]` log line has 2 TAIL TOKENS** (`sell_cluster_flag=…` + `max_z_sell=…:…`).
- **Buy + sell aggregate panels are INDEPENDENT branches.**
- **The L&L 2001 §4 dilution footer attaches to the sell-side no-flag-cleared branch ONLY.**
- **`inputsAvailableAggregate` is overloaded across BOTH directions (S95-10).**
- **`computeSectorClusterRate` is called TWICE per sector per cycle** (BUY_CODE + SELL_CODE).
- **Symmetric z-test fires on negative-z sell-side anomalies too.**
- **The composite source files have `\0` literals in template strings** (`src/server/executive_departure.ts` line 105, `eight_k_classifier.ts` line 133, `form_4_insider.ts` line 163).
- **The §1.4 three-branch order is load-bearing: LIVE → no-flag-cleared → cold-start** (both directions).
- **`dayAsOf` uses end-of-day semantic** (`day + 'T23:59:59.999Z'`).
- **Tie-break asymmetry on equal-|z| with opposite signs.**
- `gics_sector_repository_helper.ts` is the byte-template owner for per-ticker + per-day-panel + per-ticker-timeline sector lookups.
- `MIN_Z_BASELINE = 30` floor stays at 30 across all three composites per ADR-042 §6.
- `stddevSamp` not `stddevPop` — Bessel correction.
- Today's rate must be EXCLUDED from the baseline window per ADR-042 §4.

(All earlier s89-s95 #2 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); aggregate-sector layer LIVE on XD/EK/F4 (buy-side); F4 sell-side LIVE end-to-end.
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 LIVE; F4 §15 emits BOTH buy-side AND sell-side parallel panels.
```

### Gap #7 Form 4 (G2 buy-side + v2 sell-side both LIVE end-to-end; ingest UNBLOCKED s95 #3)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3 — now resolves real XML URLs via index.json discovery
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply  # NEW s95 #2 — sell-side persistence
npm run daemon:daily                                              # emits [f4-aggregate] log line with both buy-side AND sell-side tokens
npm run brief:morning                                             # section #15 emits BOTH buy-side AND sell-side parallel panels
```

### Gap #7+#8 v2 GICS activation — buy-side ARC CLOSED; F4 sell-side ARC CLOSED end-to-end

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# G2 max-aggregate-z persistence wiring (READY since s94 #8):
npm run migrate:add-max-z-executive-departure-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply

# G3 sell-cluster persistence wiring (READY since s95 #2):
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
```

### Gap #9 etf-flow activation (FULLY READY)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #10 short-interest activation

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation (G2 LIVE)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run migrate:add-max-z-executive-departure-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — last full-run at s95 #2 was 2898 / 2801 pass / 2 fail / 95 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 332 pass at s95 #3 (+8 net from T-F4I-DISCOVER-{1..8})
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py # 47 pass (this turn baseline)
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_8k_item_5_02_ingest.py scripts/tests/test_sec_edgar_8k_event_ingest.py  # 53 pass — confirms shared parser change is non-breaking
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # green at s95 #2 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** the operator should re-run the runbook that hit the 404 storm last turn:

```text
npm run edgar:form4:ingest              # NOW WORKS — UNBLOCKED by s95 #3
npm run daemon:daily
npm run brief:morning
```

After validation that the F4 panels surface real data, the operator picks the next code slice from the candidate list. Recommended default if they just say "continue": **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `.venv/Scripts/python.exe -m pytest scripts/tests` baseline-clean (332 + N).

**If operator reprioritizes:** any of these candidates can be the default-next:

- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried + new):**

- **NEW:** Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply` to surface s95 #2 sell-side persistence end-to-end on the real CH.
- Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs (carry from s94 #8).
- Push 38 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation.
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**s95 #3 was a HOTFIX, not a feature slice.** The fix is small (3 files, +318 / -2 LOC, 8 new tests) but it closed a real first-apply blocker that would have left every Form 4 ingest 100% empty. Run the ingest now (`npm run edgar:form4:ingest --apply`) before doing anything else with F4 — the brief renderer is already wired to consume populated `insider_trades`, so the moment the ingest succeeds the morning brief will show real buy/sell sector panels (where signal exists).

**The 8-K ingest was NEVER blocked by this bug.** 8-K hits in the EDGAR search response DO include `file_name`, so the parser's URL construction works for 8-K. Don't reinterpret the s95 #3 fix as touching the 8-K path — it doesn't.

**The discovery cache is positive-only and per-process.** A long-running daemon that re-invokes the ingest won't benefit from cross-run caching, but that's fine — daily ingest cadences are not perf-sensitive at the EDGAR rate ceiling.

**The chain through s95 #3:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
        — DDL + persistence + daemon log + brief render
S95 #3: form 4 ingest XML body URL discovery (HOTFIX)   ✓ committed (831b1b0)
        — unblocks first-apply; 8 new T-F4I-DISCOVER-* tests
S95 #3 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator re-runs the runbook from last
                  turn; F4 ingest is now unblocked.
                  After F4 surfaces real data, operator
                  picks the next code slice.
  → background: F4 emits four signals end-to-end now (buy-side
                + sell-side per-ticker cluster flags; buy-side +
                sell-side aggregate cluster flags). Buy-side has
                been LIVE since s94 #11; sell-side composite landed
                s95 #1; sell-side persistence + render landed s95 #2.
                XML body URL discovery (the "first-apply" missing
                piece) landed s95 #3. XD + EK arcs remain
                buy-side-only.
```
