# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #7 — **gap #7 F4-A1 DONE** as commit `d368012`. Opens the Form 4 insider-trade arc: `scripts/sec_edgar_form4_ingest.py` (~530 LOC) + 39 Python tests covering SPEC §9.10 T-F4I-1..T-F4I-8 + supplementals. New XML parser for the Form 4 `<ownershipDocument>` schema (namespaced + non-namespaced); writes to `quantlab.insider_trades` (per-transaction) + `quantlab.insider_ciks` (NEW insider person-CIK name cache) + reused `quantlab.cik_ticker_map` (issuer-side). Per F4-4 ALL transaction codes stored at ingest; v1 composite (F4-A2) filters to {P, S}. All gates green (pytest 298/298 +39 vs s93 #5 baseline 259, TS 2562/2539 unchanged baseline — Python-only slice, tsc 13 errors unchanged baseline, check:help ✓). 3 commits ahead of `origin/main`; push still operator-gated. **F4-A2 NEXT (pure composite `form_4_insider_v1`)**.)

## What this turn delivered

Seventh slice of the gap #7 event-driven-filings-processor arc (s93 #7 — Phase F4-A1), opening the Form 4 insider-trade arc:

1. **`scripts/sec_edgar_form4_ingest.py`** (~530 LOC). Per SPEC §2.3 (F4-1..F4-12) + §4.2 + §6.2 + §9.10 + §10 Phase F4-A1. Architecture:
   - EDGAR full-text search for `forms=4` (no item-code filter; Form 4 has none) via the shared `_sec_edgar_helpers` module.
   - NEW XML parser `parse_form4_xml` for the Form 4 `<ownershipDocument>` schema. Namespace-insensitive (handles both `xmlns="http://www.sec.gov/edgar/ownershipDocument"` namespaced filings per the XSD AND the non-namespaced shape that most EDGAR-archived filings actually use). Strips namespace prefix via `_strip_ns` helper.
   - Per F4-4 + T-F4I-3: ALL transaction codes (P, S, A, M, F, G, etc.) are STORED at ingest. The v1 composite (F4-A2) filters to {P, S} downstream. Forensic access to grants / option exercises / gifts preserved at the raw `insider_trades` table.
   - Per F4-5: `dollar_amount = shares × price_per_share` computed at the ingest layer (not deferred to a CH DEFAULT) so downstream consumers don't need to recompute.
   - Per F4-7: ReplacingMergeTree on `(issuer_cik, accession, transaction_id)`. `transaction_id` is 0-based WITHIN the parent filing (a single Form 4 can carry multiple `<nonDerivativeTransaction>` elements; each → one row).
   - Per F4-8: Derivative-table transactions (options) are NEVER returned by `parse_form4_xml`. Out-of-scope for the v1 `insider_trades` table.
   - Per F4-9: NEW `resolve_person_cik_to_name` insider-side resolver. Uses the SAME submissions-API endpoint as the issuer-side resolver — natural-person CIKs return their full name in the `name` field. Writes to NEW `quantlab.insider_ciks` table.
   - Per F4-10: Acceptance-date anti-leak filter applies via the shared `filter_by_acceptance_date` helper. NEVER uses `transactionDate` for window membership (that field can be retroactively reported up to 2bd before `accepted_at`).
   - Per OQ-3: Multi-issuer Form 4 emits one row per (issuer, transaction) pair. Iterates all `<issuer>` blocks. Rare in SP500 mid-cap universe; best-effort handling.
   - Role-flag bitmask (UInt8): `bit0=director` (1), `bit1=officer` (2), `bit2=10pct_owner` (4), `bit3=other` (8). v1 composite weights each at 1.0 per F4-3; bitmask logged for v2 ADR future use.
   - Both `ensure_insider_trades_table` + `ensure_insider_ciks_table` lazy-create — F4-A3 will co-bootstrap these + the snapshot table per SPEC §6.2.
   - Row builder `build_insider_trade_rows` accepts an `xml_resolver(filing) → list[dict]` callable (production: body-fetch + parse; tests: fixed-list); a `ticker_resolver(issuer_cik) → dict` callable (XML-supplied issuer ticker takes priority over API fallback); a `name_resolver(person_cik) → dict` callable (insider-side cache).

2. **`scripts/tests/test_sec_edgar_form4_ingest.py`** (~470 LOC, 39 tests, all pass):
   - SPEC §9.10 T-F4I-1..T-F4I-8 (all 8 mandated IDs covered, 16 sub-tests).
   - Supplementals: empty/invalid XML graceful-degrade; namespaced XML compat; zero-shares zero-price graceful-degrade; role-flag combinations (director-only, officer-only, 10pct-only, all-four, none); `_parse_bool_xml` truthy/falsy variants ("1"/"true"/"T"/"Y"/"yes"/etc.); person-CIK cache hit + blank-name handling; XML-ticker vs API-fallback priority + call-count verification; URL builder + amendments-flag; 429 retry; ensure_*_table DDL markers; writer column lists + empty-input no-op; search response form-type filter (4 vs 4/A).

3. **Wiring**: `edgar:form4:ingest` + `edgar:form4:ingest:dry` npm scripts in `package.json` + `scripts/help.ts` EXTRA_HELP entries (2 new). Mirrors the `edgar:8k-event:ingest{,:dry}` pattern exactly.

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
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| **Gap #7 F4-A1 (Form 4 EDGAR ingest CLI)** | **✓ s93 #7 (`d368012`)** |
| **Gap #7 F4-A2 (pure composite `form_4_insider_v1`)** | **☐ NEXT** |
| Gap #7 F4-A3..A5 (migration → repository+daemon → brief #15) | ☐ queued after F4-A2 |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| Gap #7 v2 — GICS sector mapping activation (8-K + F4 aggregate panels) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow/8-K/F4 | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 3 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 7 (this turn, this commit) — F4-A1 implementation forks

**S93-37. Ingest stores ALL transaction codes (not just {P, S}); composite filters downstream.**
`Why:` SPEC F4-4 explicit: "All other transaction codes (A grants, M exercises, F payments, G gifts, etc.) are stored at ingest but excluded from the composite." T-F4I-3 names this directly. Three-criterion analysis:
  1. Canon foundations — F4-4 is the source-of-truth lock; reading-comprehension call.
  2. Methodology rigor — store-everything preserves forensic access for v2 ADR (e.g., CMP classifier needs grants for routine-vs-opportunistic classification). Filter-at-ingest would force a re-backfill if v2 needs the dropped codes.
  3. Minimum free parameters — store-everything has ZERO ingest-side filter parameters; composite owns the filter list at the F4-A2 boundary.

Result: `parse_form4_xml` returns ALL `<nonDerivativeTransaction>` rows regardless of code. The `DEFAULT_HIGH_SIGNAL_CODES = ("P", "S")` constant is documentation-only at the ingest layer (used in tests + brief consumer assertions); the composite imports + applies the filter.
`How to apply:` Future ingest-time changes that add filtering would break the v2 CMP classifier; reject any PR that does so. Storage cost: ~10× volume vs filter-at-ingest, but Form 4 row volume is small (~100-300/day across SP500 + universe — cheap at CH scale).

**S93-38. `parse_form4_xml` is namespace-insensitive via `_strip_ns` + local-name child lookup.**
`Why:` Real EDGAR-archived Form 4 XML is INCONSISTENT about namespace declaration. The XSD declares `http://www.sec.gov/edgar/ownershipDocument`, but most filings ship without it. Per SPEC OQ-2: "the wrapping `<edgarSubmissions>` envelope formats vary slightly (compressed vs uncompressed). F4-A1 should handle both and log clear errors on schema drift." Three-criterion analysis:
  1. Canon foundations — OQ-2 lock; SPEC explicit about handling both.
  2. Methodology rigor — namespace-strict parsing would fail on the majority of EDGAR-archived filings; namespace-insensitive matches reality.
  3. Minimum free parameters — `_strip_ns` is 3 lines; alternative (registering namespace map + ET.findall queries with `{ns}` prefix) is ~30 lines for the same outcome.

Result: `_find_child(elem, name)` iterates children and matches on `_strip_ns(child.tag) == name`. Same pattern for `_find_children`. Both namespaced + non-namespaced XML parse to identical row shapes (T-F4I-1 test "parses_handles_namespaced_xml" pins this).
`How to apply:` Any future Form 4 XML changes (Form 5, 3/A amendments) that introduce ELEMENT names should follow the same pattern. If SEC ever bumps the namespace URI, this parser keeps working without change.

**S93-39. `resolve_person_cik_to_name` reuses the same submissions API as issuer-side resolver.**
`Why:` SEC's submissions API at `data.sec.gov/submissions/CIK{cik10}.json` returns identical-shape JSON for natural-person CIKs (insider) AND legal-entity CIKs (issuer) — the `name` field carries the entity name in both cases; for natural persons, `tickers` is empty. Three-criterion analysis:
  1. Canon foundations — SPEC §4.2 names "SEC EDGAR submissions API (insider) | `person_cik → name` | `insider_ciks.name`" — same endpoint as issuer side.
  2. Methodology rigor — reusing the parser means consistent error-handling + cache semantics across issuer + insider sides.
  3. Minimum free parameters — zero new HTTP infrastructure.

Result: `resolve_person_cik_to_name` is a thin wrapper around the shared `parse_submissions_response` helper. Returns `{person_cik, name}` shape. Cached in a separate `insider_cache` dict (issuer + insider caches don't share namespace because the same CIK can theoretically belong to either — though in practice they don't overlap).
`How to apply:` v2 brief enhancements that want CEO name rendering (e.g., "Tim Cook bought 1,000 AAPL @ $175.50") can read `quantlab.insider_ciks` directly. Person-CIK ≠ Issuer-CIK is enforced by separate tables.

**S93-40. ReplacingMergeTree ORDER BY `(issuer_cik, accession, transaction_id)`; transaction_id 0-based within filing.**
`Why:` SPEC §6.2 explicit. Multi-transaction Form 4s (HANDOFF watch-out: "one Form 4 filing can carry multiple transaction lines — e.g., 3 buys + 1 sell per accession") need a per-row key that doesn't collapse them silently. SEC does NOT assign a global transaction key; transaction_id is therefore the 0-based index within the `<nonDerivativeTable>/<nonDerivativeTransaction>` ordering. T-F4I-6 pins the uniqueness invariant; T-F4I-8 pins the 3-row expansion semantics.
`How to apply:` Any code that re-orders the XML transactions BEFORE assignment of `transaction_id` would silently break idempotent re-ingest. The parser must NOT sort or filter `nonDerivativeTransaction` elements before assigning the index.

**S93-41. XML-supplied `issuerTradingSymbol` takes priority over submissions-API fallback at the row-builder boundary.**
`Why:` The Form 4 XML carries the ticker reliably for current filings; falling back to the submissions API every time would waste rate-limit budget (Form 4 volume is ~10× Item 5.02 per HANDOFF watch-out). Three-criterion analysis:
  1. Canon foundations — F4-9 names person CIK identity; ticker source is implementation choice.
  2. Methodology rigor — XML-first matches what EDGAR provides authoritatively; API-fallback handles aging tickers (mergers, ticker swaps).
  3. Minimum free parameters — zero new flags; the fallback is automatic when `issuer_ticker` is blank.

Result: `build_insider_trade_rows` checks `txn["issuer_ticker"]` first; only calls `ticker_resolver` when blank. Test `test_row_builder_uses_xml_ticker_when_present` asserts the resolver is NOT called when XML provides the ticker; `test_row_builder_falls_back_to_api_when_xml_lacks_ticker` asserts it IS called when blank.
`How to apply:` Operators concerned about stale XML tickers (e.g., post-merger filings still using old ticker) can purge `quantlab.cik_ticker_map` to force re-resolution; the XML's `issuerTradingSymbol` would still take priority though. For now, XML-first is the right default.

### Sessions 84-93 #1-#6 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-36 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess for 8-K ingest; operator-action verification deferred to first ingest run).
- Cold-start cascade timing for EK arc end-to-end (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- Cold-start cascade timing for F4 arc end-to-end (~6-8 weeks of EDGAR ingest history; cluster threshold of 3-in-30 may need calibration adjustment if SP500 universe rarely hits it in real data).

### Closed this turn

- ~~F4-A1 ingest-time transaction-code filter decision~~ — RESOLVED per S93-37: store ALL codes; composite filters.
- ~~F4-A1 XML namespace handling~~ — RESOLVED per S93-38: namespace-insensitive via `_strip_ns`.
- ~~F4-A1 insider-name resolution endpoint choice~~ — RESOLVED per S93-39: same submissions API as issuer side.
- ~~F4-A1 ReplacingMergeTree key + transaction_id assignment~~ — RESOLVED per S93-40: ORDER BY (issuer_cik, accession, transaction_id), 0-based within filing.
- ~~F4-A1 issuer-ticker source priority (XML vs API)~~ — RESOLVED per S93-41: XML first, API fallback when XML blank.

### Newly opened

- **F4-A2 pure composite `form_4_insider_v1`** — second slice of the F4 arc. Per SPEC §5.3 (per-stock) + §5.4 (aggregate) + §9.7 (T-F4-1..T-F4-N). Mirrors EK-A2 architecturally:
  - `src/server/form_4_insider.ts` (~400-500 LOC est.). Pure functions; no I/O. Importable from F4-A4 daemon hook.
  - Per F4-2 cluster flag: ≥3 distinct insiders within 30 calendar days, same direction. Distinct on `person_cik` (NOT name string). Triggers `insider_cluster_buy_flag` (code P) or `insider_cluster_sell_flag` (code S).
  - Per F4-5: `insider_net_dollar_90d = Σ(buy_$ for P) − Σ(sell_$ for S)` over 90d window.
  - Per F4-6: Aggregate per-sector count of `insider_cluster_buy_flag` events; z-scored against trailing 2y baseline; flag fires on |z_s| > 2.0. v1 GICS-deferred (mirrors EK-A2 + gap #8 A2).
  - Per F4-4: filters to {P, S} only at composite read time; ingest stores all codes.
  - Composite version stamp: `form_4_insider_v1`.
- **F4-A2 transaction filter at composite layer — load-bearing.** The ingest layer per S93-37 stores ALL codes; the composite MUST filter to {P, S}. A regression that read all codes at composite layer would dilute the cluster-buy / cluster-sell signal with grants + option exercises.
- **F4-A2 cluster-direction semantic.** Per F4-2: "Cluster-buy / cluster-sell flags: ≥3 distinct insiders within 30 calendar days, same direction." Same direction = same transaction_code. A mixed 2-buy-1-sell cluster does NOT fire either flag. Per-direction count: bk(T,D) = distinct insiders with code P in last 30d for ticker T; sk(T,D) = same with code S.
- **F4-A2 insider role weighting** — per F4-3 v1 weights each role at 1.0. v2 ADR can sensitivity-test if Phase B reveals miscalibration. Composite consumes `role_flags` as a per-row passthrough (for forensic queries); doesn't weight.

## Next stage

### Default on "continue"

**Gap #7 F4-A2 — pure composite `form_4_insider_v1`.** Concrete first move:

1. Read `docs/specs/event-driven-filings-processor.md` §5.3 + §5.4 + §9.7 — anchor SPEC for Form 4 composite math + tests.
2. Read `src/server/eight_k_classifier.ts` (s93 #3 EK-A2 precedent, ~500 LOC) end-to-end as the architectural template. Form 4 composite mirrors this pattern.
3. Read `scripts/tests/eightKClassifier.test.ts` (s93 #3 EK-A2 tests) as the test template.
4. Re-read `scripts/sec_edgar_form4_ingest.py` to refresh the row-shape contract that the composite reads.
5. Write `src/server/form_4_insider.ts` (~400-500 LOC est.) per SPEC §5.3 + §5.4. Per-stock layer: cluster-buy / cluster-sell flags + `insider_net_dollar_90d`. Aggregate layer: per-sector z-scored cluster-event rate (v1 GICS-deferred mirrors EK-A2).
6. Write `scripts/tests/form4Insider.test.ts` (~30-50 tests est.) per SPEC §9.7 T-F4-1..T-F4-N.
7. `npm test` green; commit as F4-A2 slice.

### After F4-A2 lands

Standard arc continues: F4-A3 (snapshot-table migration co-bootstrap) → F4-A4 (repository + daemon step 1l) → F4-A5 (brief section #15). Each commits as its own slice.

### After F4 arc ships

Operator-pickable deferred insertions:

- ADR-041 implementation slot (`yield_curve_inverted` category).
- Gap #7 v2 — GICS sector mapping activation (8-K + Form 4 aggregate panels).
- Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32 v2 deliverable).
- Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1; ≥6mo warm-up gated).
- Gap #7 v2 — 13D/13G arc (separate SPEC).
- Gap #7 v2 — event-driven cadence promotion (Phase B-gated).
- Gap #8 v2 — GICS sector activation.
- Gap #9 v2 — ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the eight (nine after F4) Layer-0 composites.

## Files / code state

### NEW this turn (s93 part 7)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_form4_ingest.py` | CREATED (`d368012`) | ~530 LOC. EDGAR full-text search → Form 4 XML parser → `quantlab.insider_trades` + `quantlab.insider_ciks` + reused `quantlab.cik_ticker_map`. Per F4-4 stores ALL transaction codes; composite filters {P,S} downstream. Namespace-insensitive XML parser per OQ-2. Issuer + insider CIK caches separate per S93-39 + F4-9. |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | CREATED (`d368012`) | ~470 LOC, 39 tests. SPEC §9.10 T-F4I-1..T-F4I-8 all covered + supplementals. All pass. |
| `package.json` | EDITED (`d368012`) | +2 lines. `edgar:form4:ingest` + `edgar:form4:ingest:dry` npm scripts. |
| `scripts/help.ts` | EDITED (`d368012`) | +2 EXTRA_HELP entries. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for F4-A1 close + F4-A2 next. |

### From s93 #6 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/operator_brief_render.ts` | EXISTS (`7ee5852`) | EK-A5: section #14 + `renderEightKClassifierSection` + `formatEightKItemList` + `BriefEightKClassifierSection`. |
| `src/server/operator_brief.ts` | EXISTS (`7ee5852`) | EK-A5: `fetchLatestEightKClassifier` dep + `buildEightKClassifierSection` helper + 17-way Promise.all. |
| `scripts/tests/operatorBriefRender.test.ts` | EXISTS (`7ee5852`) | +13 EK-A5 tests. |
| `scripts/tests/operatorBrief.test.ts` | EXISTS (`7ee5852`) | +6 EK-A5 tests (3 composer-wiring + 3 build helper). |

### From s93 #5 / #4 / #3 / #2 / #1 (carried; unchanged)

All prior gap #7 EK arc files preserved unchanged.

### CH state (unchanged from s93 #6)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created (EK-A1 ingest creates lazily; EK-A1 standalone migration also creates; EK-A3 co-bootstrap also creates).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (EK-A3 migration script exists; not yet applied).
- `quantlab.insider_trades` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap will also create).
- `quantlab.insider_ciks` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap will also create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (F4-A3 will create).

### Tests

```text
npm test                       2562 / 2539 pass / 0 fail / 23 skipped   ✓ (unchanged baseline — F4-A1 is Python-only slice)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   298 / 298 (+39 vs s93 #6 end of 259)
```

## Watch-outs

### NEW from this turn (s93 #7)

- **`parse_form4_xml` returns ALL transaction codes (S93-37).** The v1 composite at F4-A2 MUST filter to {P, S}; relying on ingest-side filtering would dilute the cluster signal with grants + option exercises. The constant `DEFAULT_HIGH_SIGNAL_CODES = ("P", "S")` lives in the ingest module for documentation-only; the composite at F4-A2 must enforce the filter at read time.
- **Namespace-insensitive XML parser (S93-38).** `_strip_ns` + `_find_child` work for both namespaced + non-namespaced Form 4 XML. A future SEC schema bump that changes the namespace URI keeps working without code change. NEW Form 4 element names (e.g., a v2 schema extension) would need explicit handling though — the parser only handles the v1 element set.
- **Insider person-CIK ≠ Issuer CIK (S93-39 reinforces F4-9).** Two separate tables (`insider_ciks` vs `cik_ticker_map`); two separate caches (`insider_cache` vs `issuer_cache`); same submissions-API endpoint. A regression that mixed them would corrupt cluster-buy detection (cluster threshold = 3 distinct PERSONS, not 3 distinct issuers).
- **`transaction_id` is 0-based within FILING, NOT global (S93-40).** Two different Form 4 filings can both have `transaction_id = 0`. The ReplacingMergeTree key `(issuer_cik, accession, transaction_id)` is unique because `accession` differentiates filings. A regression that re-numbered globally would collapse rows across filings.
- **Derivative-table transactions silently dropped (F4-8 + S93 preserved).** Options + warrants in `<derivativeTable>` are NEVER stored. A future v2 that wants option-exercise data needs a separate `insider_options` table; piggy-backing on `insider_trades` would break the per-row dollar-amount semantic.
- **Issuer ticker XML-first, API-fallback (S93-41).** Operators inspecting why a row has unexpected `issuer_ticker` should check the XML first; the cache is the secondary source. For mergers + ticker swaps, the XML's value is what EDGAR considered authoritative AT FILING TIME.
- **Form 4 ingest volume is ~10× Item 5.02 per HANDOFF F4-A1 watch-out (carried).** First `--apply` run should narrow `--start-date` (e.g. last 3 days) to stay well under the EDGAR 10 req/sec rate limit. CLI default is 90 days; operator override recommended.
- **`role_flags` UInt8 bitmask is `bit0=director, bit1=officer, bit2=10pct_owner, bit3=other`.** Combined values (e.g., 3 = director+officer) are common (CEOs are typically board members). A future query that filters on "is officer" should use bitwise AND: `role_flags & 2 != 0`, NOT `role_flags = 2` (which would miss CEO+director rows).
- **`_parse_bool_xml` accepts "1", "true", "T", "Y", "yes" case-insensitively.** Form 4 boolean fields are inconsistent across filers; the helper handles the common variants. A future Form 4 with unanticipated truthy strings would silently parse to False — log + alert at the brief layer if `role_flags = 0` rates spike.
- **`build_form4_search_url` uses `forms=4` by default.** Amendments (`4/A`) need explicit `forms="4,4/A"` argument. The main() code path filters `f["form_type"] in ("4", "4/A")` post-fetch so the URL-level filter doesn't have to include amendments unless operators want them inline.
- **`ensure_insider_trades_table` + `ensure_insider_ciks_table` lazy-create.** F4-A3 co-bootstrap migration will add the snapshot table + match this DDL byte-for-byte. Until F4-A3 ships, the DDL parity test (mirroring EK-A1's `test_ingest_lazy_create_ddl_matches_migration_planned_ddl`) is deferred.

### Carried (s89-s93 #1-#6 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 3 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated.
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
- Person CIK ≠ Issuer CIK (separate `insider_ciks` table; F4-A1 reinforces this).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4 — at COMPOSITE layer (S93-37). Ingest stores all codes.
- A5 byte-equal protection on sections #1-#13 (PLUS rendered #14 (8-K, s93 #6) + planned #15 (Form 4, F4-A5) appended at tail).
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3` for etf-flow; `>= 4` for EDGAR composites) — render layer (operator_brief_render) owns the threshold constants per-composite. F4-A5 will reuse the `EXECUTIVE_DEPARTURE_STALENESS_BD_THRESHOLD = 4` analog.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried).
- `composite_version` vs `version` mapping at the EK-A4 write boundary (load-bearing translation, tested).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters) — EK + F4 arcs have no Float scalars; safe.
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module (s93 #2, #7).
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat; s93 #2, #7).
- `build_event_search_url` raises ValueError on empty items (programming error).
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker; no `help` export needed.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess; operator-action verified on first `--apply` run.
- **EK-A2 (carried):** `materialEventFlag` derives from `recentEventCount90d >= 1` (not OR-of-per-item-flags); per-item flag count uses exact string equality; distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string-Set; `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`; `HIGH_SIGNAL_ITEM_CODES` also pinned in Python ingest `DEFAULT_HIGH_SIGNAL_ITEMS` (cross-language drift uncaught).
- **EK-A4 (carried):** `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Repository reuses ticker stored on `eight_k_events` row at read time (no per-event CIK JOIN). Two-gate daemon posture (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`). EXPLAIN PLAN tests skip cleanly when source tables absent.
- **EK-A5 (carried):** Single `daysSinceLatestEvent` per ticker (S93-32 v2 path); `formatEightKItemList` order fixed 1.01 → 5.01; `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer; section #14 always renders; `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8.

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

# EK-A1 source-table standalone migration (READY — optional; ingest lazy-creates):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A3 snapshot-table migration co-bootstrap (READY — creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 daemon step 1k (READY — both gates absent-table-safe):
npm run daemon:daily

# EK-A5 brief section #14 (READY — composer threads + renderer renders):
npm run brief:morning
```

### Gap #7 Form 4 activation (F4-A1 SHIPPED — A2..A5 PENDING; NEXT slice arc)

```text
# F4-A1 (READY — Python ingest + insider_trades + insider_ciks lazy-create):
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest

# F4-A2 (PENDING):
# Pure composite src/server/form_4_insider.ts; no operator-runnable npm script.

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
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 298 / 298
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 F4-A2 — pure composite `form_4_insider_v1`. Single atomic slice:

1. **(Read)** `docs/specs/event-driven-filings-processor.md` §5.3 + §5.4 + §9.7 (Form 4 composite SPEC sections + test plan).
2. **(Read)** `src/server/eight_k_classifier.ts` (s93 #3 EK-A2 precedent) end-to-end as the architectural template.
3. **(Read)** `scripts/tests/eightKClassifier.test.ts` (EK-A2 tests) as the test template.
4. **(Re-read)** `scripts/sec_edgar_form4_ingest.py` for the row-shape contract the composite reads.
5. **(Write)** `src/server/form_4_insider.ts` (~400-500 LOC est.). Per-stock: cluster-buy / cluster-sell flags + `insider_net_dollar_90d`. Aggregate: per-sector z-scored cluster-event rate (v1 GICS-deferred). Pure functions; no I/O.
6. **(Write)** `scripts/tests/form4Insider.test.ts` (~30-50 tests est.) per SPEC §9.7 T-F4-1..T-F4-N.
7. **(Gates)** `npm test` green; commit as F4-A2 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #7 v2 GICS sector activation for 8-K + Form 4 aggregate panels (operator-pickable insertion).
- Gap #7 v2 per-item recency for 8-K brief section #14 (S93-32 v2; operator-pickable insertion).
- Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1; calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 3 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #7 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #7 v2 per-item recency for 8-K brief (operator-pickable; deferred-but-defined per S93-32).
- Gap #7 v2 CMP classifier (calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the eight (nine after F4) Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s93 #7 opens the Form 4 insider-trade arc. F4-A1 → F4-A2 → F4-A3 → F4-A4 (daemon step 1l) → F4-A5 (brief section #15). Estimated ~4 more slices to close the F4 arc; each commits as its own slice. Same architectural template as the EK arc (s93 #2-#6) and the prior three Layer-0 composites.

F4-A1 storage layer is operator-runnable (`npm run edgar:form4:ingest:dry`) and tested (39 Python tests, all pass). The composite layer (F4-A2) is the next deliverable — pure functions that read `insider_trades` rows and compute per-ticker + per-sector aggregates per SPEC §5.3-§5.4.

**Per S93-37 (carried-forward warning):** F4-A1 stores ALL transaction codes at the raw table; the F4-A2 composite MUST enforce the {P, S} filter at read time. A regression that read all codes at composite layer would dilute the cluster-buy / cluster-sell signal with grants + option exercises.

v1 GICS-sector deferral mirrors gap #8 + gap #7 EK: per-ticker layer fully active, aggregate-sector layer dormant in v1. v2 GICS activation is a single operator-pickable insertion that ships `quantlab.gics_sector_map` and activates BOTH gap #7 8-K + gap #7 Form 4 + gap #8 exec-departure aggregate panels with one slice.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open F4-A2. Build `src/server/form_4_insider.ts` mirroring EK-A2 (s93 #3 `1879b32`) closely. ~30-50 new TS tests. Single atomic slice.

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #7:**

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
S93 #6 HANDOFF rewrite                                 ✓ committed (d5068da)
S93 #7: gap #7 F4-A1 — Form 4 EDGAR ingest CLI (OPENS F4 arc) ✓ committed (d368012)
S93 #7 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 F4-A2 — pure composite form_4_insider_v1
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5 ✓ (COMPLETE)
  → gap #7 F4 arc: A1 ✓ → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
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
