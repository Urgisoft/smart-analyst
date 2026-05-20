# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #1 — **gap #7 SPEC + teach-doc landed** as commit `48e0da1`. First slice of the gap #7 event-driven-filings-processor arc — **two parallel Layer-0 composites under one gap**: `eight_k_classifier_v1` + `form_4_insider_v1`. Three canon-thin forks resolved autonomously (EDF-1 two-siblings, EDF-2 daily-cadence, EDF-3 no 13D/13G v1). 65 commits ahead of `origin/main`, push still held. **EK-A1 NEXT (8-K event ingest extending gap #8 infrastructure)**.)

## What this turn delivered

First slice of the gap #7 event-driven-filings-processor arc (s93 #1):

1. **Gap #7 SPEC + teach-doc** — commit `48e0da1`. Two files / 832 LOC:
   - `docs/specs/event-driven-filings-processor.md` (~600 LOC) — SPEC covers BOTH `eight_k_classifier_v1` + `form_4_insider_v1` composites under one document. §2 splits decisions into gap-level (EDF-1..EDF-10), 8-K-specific (EK-1..EK-8), Form-4-specific (F4-1..F4-12). §10 phasing = SPEC + 5 EK-A* + 5 F4-A* = 11 slices, ~14 working days estimated.
   - `docs/teach/2026-05-20-event-driven-filings-architecture.md` (~220 LOC) — walks the three canon-thin forks (composite shape / cadence / CMP classifier deferral) with intuition + mechanism + failure mode + explicit "if you push back, here is what changes" review framing.

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
| **Gap #7 event-driven-filings-processor SPEC + teach-doc** | **✓ s93 #1 (`48e0da1`)** |
| **Gap #7 EK-A1 (8-K event ingest)** | **☐ NEXT** |
| Gap #7 EK-A2..A5 (8-K composite → migration → repository+daemon → brief #14) | ☐ queued after EK-A1 |
| Gap #7 F4-A1..A5 (Form 4 ingest → composite → migration → repository+daemon → brief #15) | ☐ queued after EK arc |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 65 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 1 (this turn, this commit) — gap-level forks

**S93-1. Gap #7 ships as TWO parallel Layer-0 composites, not one combined signal (EDF-1).**
`Why:` Three-criterion canon-thin test favored two siblings: (1) Lerman-Livnat 2010 anchors 8-K canon; Seyhun 1986 / Lakonishok-Lee 2001 / Cohen-Malloy-Pomorski 2012 anchor Form 4 canon — no paper combines them. (2) Combining heterogeneous streams (binary event indicators vs dollar-weighted transactions) requires an invented cross-source weight that violates Bailey-LdP 2014 no-in-sample-tuning canon. (3) Two siblings = 0 cross-source weights; combined = ≥1 cross-source weight. Matches gap #8 E-11 precedent ("Path-α single-source over Path-β combined").
`How to apply:` Both composites ship independently end-to-end. 8-K arc (EK-A1..A5) ships FIRST, then Form 4 arc (F4-A1..A5). Brief sections #14 + #15 added separately; daemon steps 1k + 1l added separately; each composite has its own snapshot table. A future v2 ADR could fuse them once Phase B reveals empirical reasons; the v2 ADR would need to confront free-parameter cost openly.

**S93-2. Gap #7 runs on daily-daemon cadence in v1, NOT event-driven polling (EDF-2).**
`Why:` The gap doc's framing is "event-driven" architecture, but three-criterion test favored daily-daemon: (1) Warner-Watts-Wruck 1988 event-study methodology operates at daily horizon; no canon prescribes intra-day cadence. (2) Real-time polling adds process supervision, retry, dedupe-under-concurrent-polling complexity without canon backing. (3) Daily-daemon = 0 new parameters; event-driven = N (poll interval, batch size, retry policy, dedupe window). Latency cost bounded — worst 23h, typical 12h for US-market-close filing.
`How to apply:` Steps 1k (8-K) + 1l (Form 4) hook into the existing daily daemon between etf-flow (1j) and §2 cells/bundles. No new process-supervision infrastructure. v2 ADR can promote to event-driven if Phase B reveals 4-23h latency is decision-affecting (test: run daily + event-driven in parallel for 90d, compare signal predictive power).

**S93-3. Gap #7 v1 OMITS 13D / 13G filings (EDF-3).**
`Why:` Brav-Jiang-Partnoy-Thomas 2008 anchors activist-13D canon; passive 13G has thinner literature. The activist-vs-passive split + filer-reputation classification (well-known activist vs first-time filer) is a non-trivial separate problem deserving its own SPEC. v1 with 13D/13G would add ≥2 free parameters (activist-vs-passive weight + filer-reputation tier table) without offsetting canon backing.
`How to apply:` 13D/13G deferred to v2 ADR OR a separate gap arc. The gap doc text references all four filing types (Form 4 + 13D + 13G + 8-K); the SPEC's §1 non-goal #7 explicitly excludes 13D/13G in v1. Operator pickable for queue insertion.

**S93-4. EDGAR ingest infrastructure refactor at EK-A1 time: extract gap #8 helpers into `scripts/_sec_edgar_helpers.py` (EDF-10).**
`Why:` Both new ingest scripts (`sec_edgar_8k_event_ingest.py` for 8-K broader; `sec_edgar_form4_ingest.py` for Form 4) reuse gap #8's rate-limit + User-Agent + 429-backoff + acceptance-date-filter + CIK→ticker submissions-API resolver. Duplicating these across 3 scripts would diverge; refactoring at EK-A1 time keeps the 8-K-narrow + 8-K-broad + Form-4 scripts consistent.
`How to apply:` EK-A1 first commits the helper extraction (refactor; no behavior change in gap #8 script — its tests stay green byte-for-byte), then commits the new 8-K-broader ingest using the helpers. Test the refactor by re-running gap #8 ingest pytest suite (`scripts/tests/secEdgar8kItem502Ingest.test.ts` — verify byte-identical results).

**S93-5. 8-K storage: NEW table `quantlab.eight_k_events` (parallel to gap #8's `executive_departures`); 5.02 data intentionally duplicated (EK-5).**
`Why:` Gap #8's `executive_departures` table does 5.02 sub-item-code parsing (rows keyed on `sub_item_code` = '5.02(b)' / '5.02(c)' etc.); gap #7's broader-item ingest does ITEM-level parsing only (rows keyed on `item_code` = '1.01' / '2.06' etc.). Refactoring gap #8 to share storage would force a destructive schema migration on a working table. Duplication cost: ~560 issuers × ~3-5 8-K filings per issuer per year ≈ ~2000 rows/year of 5.02 redundancy in `eight_k_events` — negligible.
`How to apply:` `executive_departures` (gap #8) stays unchanged + continues to be the source of truth for the gap #8 executive-departure composite. `eight_k_events` (gap #7) is the source of truth for the broader 8-K classifier composite. Operator running both `sec_edgar_8k_item_5_02_ingest.py` + `sec_edgar_8k_event_ingest.py` will see 5.02 events in BOTH tables — this is expected.

**S93-6. Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier (F4-1).**
`Why:` CMP 2012 IS the Tier-1 anchor for Form 4 — strongest single piece of insider-trading canon. But the classifier has a structural cold-start problem: requires ≥5 historical trades per insider over ≥3 years. At v1 first-run, `insider_trades` table is empty. Even after 6 months, most insiders in equity-midcap universe will have 0-3 trades. v1 with classifier would be silent on >95% of insiders. v1 ships raw-activity-only (Seyhun 1986 + Lakonishok-Lee 2001 canon — weaker but legitimate signal).
`How to apply:` v1 composite tracks raw P (purchase) + S (sale) counts + net $ + cluster-of-3-distinct-insiders-in-30d flag. v2 ADR enabled by ≥6 months of warm-up ingest history adds the CMP classifier (per-insider seasonal-pattern detection + opportunistic-deviation threshold). Phase B validation gate must be aware: v1 captures the weaker (~near-zero-to-weak) raw-cluster signal, not the stronger (~6% annualized) CMP signal — if Phase B shows v1 signal is too weak, the path is to add CMP, not abandon the gap.

**S93-7. Form 4 cluster threshold: 3 distinct insiders in 30 calendar days (F4-2).**
`Why:` Gap doc explicit OQ ("3 in 30 OR 5 in 60?"). Three-criterion: (1) Canon-thin for the exact threshold — Seyhun + Lakonishok-Lee document cluster patterns matter but don't prescribe specific count/window. (2) 3-in-30 is the simpler test (lower threshold, faster signal); 5-in-60 introduces TWO free parameters where 3-in-30 introduces ONE (the window is fixed at gap-level 30d). (3) Distinct on `person_cik`, NOT on filing — a single insider filing 3 separate buys in 30d counts as 1 insider.
`How to apply:` Pinned in tests T-F4-6 + T-F4-8. v2 sensitivity-test could explore 5-in-60 / 4-in-45 alternatives if Phase B reveals miscalibration.

**S93-8. Form 4 transaction-code filter: open-market codes "P" + "S" only (F4-4).**
`Why:` Lakonishok-Lee 2001 §3 standard filter; CMP 2012 same filter. Other codes (A grants, M exercises, F payments, G gifts) are externally constrained and NOT informative about discretionary conviction. Stored at ingest layer (forensic) but excluded from composite.
`How to apply:` `transaction_code IN ('P', 'S')` filter applied at composite-read time, not at ingest. Composite tests T-F4-1..T-F4-3 pin the filter.

**S93-9. Brief section numbering + daemon step numbering (EDF-9).**
`Why:` Established byte-equal-stdout-protection invariant: existing brief sections #1-#13 MUST remain byte-equal under new section addition. EK section ships first (#14, after etf-flow #13); F4 section ships second (#15, after EK #14).
`How to apply:` Daemon chain: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → 1l form-4 → §2 cells/bundles`. Brief sections #14 + #15 strictly append.

### Sessions 84-92 prior decisions (carried)

All prior decisions preserved unchanged. S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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
- Push 65 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable).
- Gap #9 v2 cross-validation enhancement — operator-pickable.

### Closed this turn

- ~~Gap #7 SPEC scope (8-K alone? 8-K + Form 4? 8-K + Form 4 + 13D + 13G?)~~ — RESOLVED per EDF-1/EDF-3: TWO parallel composites (`eight_k_classifier_v1` + `form_4_insider_v1`); 13D/13G OUT-OF-SCOPE v1.
- ~~Gap #7 cadence (daily-daemon vs event-driven polling)~~ — RESOLVED per EDF-2: daily-daemon v1; event-driven deferred to v2 ADR.
- ~~Gap #7 composite shape (combined signal vs two siblings)~~ — RESOLVED per EDF-1: two siblings.
- ~~Form 4 CMP classifier scope v1~~ — RESOLVED per F4-1: deferred to v2 ADR pending ≥6mo per-insider warm-up.
- ~~Form 4 cluster threshold~~ — RESOLVED per F4-2: 3 distinct insiders in 30d.
- ~~8-K storage: refactor gap #8 table or new sibling?~~ — RESOLVED per EK-5: new sibling `eight_k_events`; gap #8 `executive_departures` unchanged.

### Newly opened

- **8-K full-text-search Item-code filter query syntax (EK-A1 OQ)** — EDGAR `items=` filter behavior verified on first-apply-run; operator paths `--url` / `--from-file` / `--items` parametric override for fallback.
- **Form 4 XML parser bootstrap on first-run (F4-A1 OQ)** — Form 4 XSD stable but wrapping envelope formats vary; F4-A1 handles both compressed + uncompressed + logs clear errors on schema drift.
- **`insider_ciks` name cache cold-start (F4-A1 OQ)** — first-run resolves ~100-500 insider CIKs across equity-midcap universe; bursty fetch ~10-50s.
- **Cohen-Malloy-Pomorski v2 ADR slot** — operator-pickable insertion AFTER ≥6 months of Form 4 warm-up history (earliest ~2026-11-20).
- **Brav-Jiang-Partnoy-Thomas 13D arc** — separate SPEC OR gap; operator-pickable insertion.
- **Event-driven architecture v2 ADR slot** — operator-pickable insertion AFTER Phase B reveals daily-daemon latency is decision-affecting (earliest ~2026-08-20 = 90d Phase B parallel-comparison window).

## Next stage

### Default on "continue"

**Gap #7 EK-A1 — 8-K broader event ingest.** Concrete first move:

1. Read `scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 A1) end-to-end — anchor the helper-extraction refactor.
2. Create `scripts/_sec_edgar_helpers.py` (NEW shared module). Extract:
   - `fetch_edgar(url, user_agent, timeout_sec)` — HTTP fetch with rate-limit + 429 retry (lines 278-316 in gap #8 script).
   - `parse_edgar_search_response(json_bytes)` — full-text search JSON parser (lines 321-401).
   - `_parse_edgar_datetime(s)` — ISO-8601 + date fallback (lines 404-420).
   - `filter_by_acceptance_date(filings, snapshot_date)` — E-7 anti-leak gate (lines 451-465).
   - `cik10(cik)` + `submissions_url(cik)` + `parse_submissions_response(json_bytes)` + `resolve_cik_to_ticker(cik, user_agent, cache)` — CIK→ticker resolver (lines 264-273 + 470-532).
   - Constants: `EDGAR_SEARCH_BASE`, `EDGAR_SUBMISSIONS_URL`, `EDGAR_ARCHIVES_BASE`, `SEC_RATE_LIMIT_*`, `DEFAULT_USER_AGENT`.
3. Refactor `scripts/sec_edgar_8k_item_5_02_ingest.py` to import from the helpers module. Goal: gap #8 ingest tests pass byte-equal (`scripts/tests/secEdgar8kItem502Ingest.test.ts` if it exists, or the Python pytest suite — need to locate).
4. Create `scripts/sec_edgar_8k_event_ingest.py` — sibling ingest using the helpers. Key differences from gap #8 script:
   - `--items` flag (comma-separated; default = "1.01,2.01,2.06,3.01,4.01,4.02,5.01" per EK-1).
   - NO sub-item-letter body parse (item-level only).
   - Writes to `quantlab.eight_k_events` (parallel to `executive_departures`).
   - Source-table schema: `(accession, cik, ticker, form_type, item_code, accepted_at, period_of_report, filing_url, is_amendment, source, ingested_at)` per SPEC §6.1.
5. Create migration script `scripts/migrate_create_eight_k_events.ts` (just the source table; the snapshot table is EK-A3). Co-bootstrap pattern: idempotent CREATE.
6. Write tests under `scripts/tests/secEdgar8kEventIngest.test.ts` per SPEC §9.4 (T-EKI-1..T-EKI-8).
7. Add npm scripts to `package.json`:
   - `"eight-k:event:ingest:dry": "..."`
   - `"eight-k:event:ingest": "..."`
   - `"migrate:create-eight-k-events": "..."`
   - `"migrate:create-eight-k-events:apply": "..."`
8. Add EXTRA_HELP entries to `scripts/help.ts`.
9. Commit as a single slice (EK-A1).

### After EK-A1 lands

Standard arc: EK-A2 (pure composite) → EK-A3 (snapshot-table migration) → EK-A4 (repository + daemon step 1k) → EK-A5 (brief section #14). Then F4-A1 → F4-A5. Each commits as its own slice.

### After both EK + F4 arcs ship

Operator-pickable deferred insertions:

- ADR-041 implementation slot (`yield_curve_inverted` category).
- Gap #7 v2 — CMP opportunistic-vs-routine classifier (≥6mo warm-up gated).
- Gap #7 v2 — 13D/13G arc (separate SPEC).
- Gap #7 v2 — event-driven cadence promotion (Phase B-gated).
- Gap #8 v2 — GICS sector activation.
- Gap #9 v2 — ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW this turn (s93 part 1)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/event-driven-filings-processor.md` | NEW (`48e0da1`) | ~600 LOC. SPEC for both `eight_k_classifier_v1` + `form_4_insider_v1`. Sections: §1 goals/non-goals, §2.1 gap-level decisions (EDF-1..EDF-10), §2.2 8-K decisions (EK-1..EK-8), §2.3 Form 4 decisions (F4-1..F4-12), §3 component diagram, §4 inputs, §5 composite formulas, §6 CH DDL, §7 daemon hooks (1k+1l), §8 brief panels (#14+#15), §9 test plan, §10 implementation phases (11 slices), §11 OQs, §12 references. |
| `docs/teach/2026-05-20-event-driven-filings-architecture.md` | NEW (`48e0da1`) | ~220 LOC. Three canon-thin forks walked: composite shape (two-vs-one) / cadence (daily-vs-event-driven) / CMP classifier deferral. Each: intuition + mechanism + failure mode + "if you push back, here is what changes". |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-SPEC-slice state. |

### From s92 (carried; unchanged)

All gap #9 etf-flow files preserved (6 commits: SPEC `20da333` → A1 `ab724db` → A2 `e4592fe` → A3 `41ab834` → A4 `5ebee05` → A5 `61b61dd` → HANDOFF `706a8b8`).

### From s91 (carried; status unchanged)

All s91 files (`executive_departure*`, EDGAR ingest, brief section #12) preserved.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists; not yet applied.
- `quantlab.etf_shares_outstanding` — NOT yet created. A1 ingest creates it lazily; A3 migration ALSO creates it idempotently via co-bootstrap.
- `quantlab.etf_flow_snapshots` — NOT yet created. A3 migration script exists; not yet applied.
- **`quantlab.eight_k_events` — NOT yet created (gap #7 EK-A1 will create).**
- **`quantlab.eight_k_classifier_snapshots` — NOT yet created (gap #7 EK-A3 will create).**
- **`quantlab.insider_trades` — NOT yet created (gap #7 F4-A1 will create).**
- **`quantlab.insider_ciks` — NOT yet created (gap #7 F4-A1 will create).**
- **`quantlab.form_4_insider_snapshots` — NOT yet created (gap #7 F4-A3 will create).**

### Tests

```text
npm test                       2383 / 2364 pass / 0 fail / 19 skipped   ✓ (unchanged from s92 end — no code change this slice)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   234 / 234 (unchanged from s92)
```

## Watch-outs

### NEW from this turn (s93 #1)

- **SPEC + teach-doc commit DOES NOT change any code or tests.** Future EK-A1 commit will be the first behavior-affecting slice of gap #7. The full TS test suite (2364 pass) and Python test suite (234 pass) are unchanged baselines for EK-A1's tests-pass gate.
- **EK-A1 helper-extraction is a NON-trivial refactor of gap #8 script.** The 350+ lines of helpers extracted from `sec_edgar_8k_item_5_02_ingest.py` are load-bearing for the existing gap #8 ingest. EK-A1 must run gap #8's ingest tests after extraction to verify byte-identical behavior. If Python pytest suite for gap #8 ingest doesn't exist (only A2 composite tests do), the verification gate is reading the script + verifying no logic moved.
- **8-K table duplication is INTENTIONAL.** Per EK-5 + S93-5: `executive_departures` (gap #8) + `eight_k_events` (gap #7) both hold 5.02 records when both ingest scripts run. The gap #8 composite reads only `executive_departures`; the gap #7 composite reads only `eight_k_events`. Do not "consolidate" — the schemas differ (sub_item_code vs item_code as primary partition key).
- **Form 4 XML structure is DIFFERENT from 8-K HTML.** F4-A1 ingest must parse XML with namespace `http://www.sec.gov/edgar/ownershipDocument`. The Form 4 XSD is stable but envelope format varies (compressed `.xml` vs uncompressed). F4-A1 must handle both + log clear errors on schema drift. NOT a copy-paste of 8-K body parser.
- **Form 4 transaction codes: ONLY "P" + "S" in composite.** All other codes (A, M, F, G, H, I, J, K, L, O, U, V, W, X, Z) stored at ingest BUT excluded from composite. Lakonishok-Lee + CMP standard filter. Documented in F4-4.
- **`person_cik` ≠ `issuer_cik` ≠ `cusip_ticker_map` key.** Form 4's `person_cik` is the INSIDER's CIK (a different SEC keyspace from issuer CIK). The `insider_ciks` table (NEW) is the insider keyspace cache; the existing `cik_ticker_map` is the issuer keyspace cache. Two distinct tables; do not merge.
- **CMP classifier deferred. v1 signal is WEAKER than the gap-doc-cited 6% annualized.** Per F4-1: v1 ships raw-activity-only (Seyhun + Lakonishok-Lee canon — weaker signal). Phase B validation gate must be aware this is not the CMP-grade signal. If Phase B shows v1 signal is too weak, the path is to add CMP via v2 ADR, NOT to abandon gap.
- **Daily-daemon cadence cap on signal latency: 23h worst-case.** Per EDF-2 daemon catches all filings within 1bd of acceptance. If Phase B reveals signal decays sharply within first few hours post-filing, v2 ADR can promote to event-driven (test path: parallel-run daily + event-driven for 90d, compare predictive power).
- **3-in-30d cluster threshold is DISTINCT on `person_cik`, NOT on filing.** Per F4-2 + test T-F4-8: a single insider filing 3 separate trades in 30d counts as 1 insider, not 3. Cluster fires on 3 DISTINCT insiders.
- **13D/13G OUT-OF-SCOPE v1.** Brav-Jiang-Partnoy-Thomas + filer-reputation classification deserves its own SPEC. Defer to v2 ADR OR separate gap arc.

### Carried (s89-s92 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 65 commits ahead of `origin/main`; push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`. A1 sidesteps by fetching close directly from yfinance.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate (gap #8 E-7 + carried into gap #7 EDF-5 + F4-10).
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1).
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (NEW for gap #7 Form 4; separate `insider_ciks` table).
- A5 byte-equal protection on sections #1-#13 PLUS now planned #14 (8-K) + #15 (Form 4) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite + threaded by A4 repository + rendered by A5 with ETF_FLOW_STALENESS_BD_THRESHOLD = 3.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between A1 and A3 source-table creation (must stay byte-identical; PR review must catch drift).
- `composite_version` vs `version` mapping at the A4 write boundary (load-bearing translation).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters).
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites; will gain 8-K + Form 4 hooks at EK-A4 + F4-A4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#13 with real data once migrations applied; #14 + #15 added by EK-A5 + F4-A5
```

### Gap #9 etf-flow activation (FULLY READY end-to-end)

```text
# A1 ingest:
npm run etf:flow:ingest:dry
npm run etf:flow:ingest

# A3 migration:
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# A4 daemon hook (READY — populates etf_flow_snapshots per daemon cycle):
npm run daemon:daily       # step 1j fires

# A5 brief panel (READY):
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

### Gap #7 8-K classifier activation (NOT YET READY — EK-A1..A5 pending)

```text
# EK-A1 (PENDING):
.venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py --apply

# EK-A3 (PENDING):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 (PENDING):
npm run daemon:daily       # step 1k will fire

# EK-A5 (PENDING):
npm run brief:morning      # section #14 will render
```

### Gap #7 Form 4 activation (NOT YET READY — F4-A1..A5 pending; ships after EK arc)

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
npm test                                                                       # TS — 2364 pass / 0 fail / 19 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 234 / 234
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 EK-A1 — 8-K broader event ingest. Two atomic commits possible:

1. **(Sub-slice 1)** Refactor: extract gap #8 helpers into `scripts/_sec_edgar_helpers.py`. Update `scripts/sec_edgar_8k_item_5_02_ingest.py` to import. Verify gap #8 ingest tests pass byte-equal.
2. **(Sub-slice 2)** Add NEW: `scripts/sec_edgar_8k_event_ingest.py` using helpers. Migration script for `quantlab.eight_k_events` source table. Tests per SPEC §9.4 (T-EKI-1..T-EKI-8). npm scripts + EXTRA_HELP.

Operator may prefer to commit these as a single EK-A1 slice (matches gap #9 A1 / gap #8 A1 atomicity); the SPEC §10 phasing also estimates EK-A1 as one slice. Recommend single slice unless the refactor proves substantively larger than expected.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 65 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- Gap #7 v2 CMP classifier (calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s93 #1 opens the gap #7 event-driven-filings-processor arc with the SPEC + teach-doc landing as a single slice. The arc structure differs from the prior six gap arcs (all single-composite) — gap #7 ships TWO parallel Layer-0 composites (`eight_k_classifier_v1` + `form_4_insider_v1`) under one gap doc, with a shared infrastructure refactor at EK-A1 (extracting gap #8 helpers into `scripts/_sec_edgar_helpers.py`).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open EK-A1. First atomic move: extract gap #8 EDGAR helpers into `scripts/_sec_edgar_helpers.py` and refactor `scripts/sec_edgar_8k_item_5_02_ingest.py` to use them. Then add `scripts/sec_edgar_8k_event_ingest.py` (NEW, sibling) + migration for `quantlab.eight_k_events` + tests per SPEC §9.4. Commit as one EK-A1 slice (matches gap #9 A1 / gap #8 A1 atomicity).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #1:**

```text
ALL S41-S91 WORK                                       ✓ as documented
S90: gap #10 short-interest-tracking arc               ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc             ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                                   ✓ committed (6e9ffe0)
S92 #1..#6: gap #9 etf-flow-monitoring arc             ✓ COMPLETE end-to-end (6 commits)
S92 HANDOFF rewrite                                    ✓ committed (706a8b8)
S93 #1: gap #7 SPEC + teach-doc                        ✓ committed (48e0da1)
S93 HANDOFF rewrite (this commit)                      ✓ this commit
  → next: gap #7 EK-A1 — 8-K broader event ingest (refactor gap #8 helpers + new sibling script)
  → gap #7 EK arc: A1 → A2 → A3 → A4 (daemon 1k) → A5 (brief #14)
  → gap #7 F4 arc: A1 → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence
  → background: daemon writes per-cycle snapshots for all 7 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow);
                adding 2 more once gap #7 EK + F4 arcs ship (8-K classifier, Form 4 insider)
```
