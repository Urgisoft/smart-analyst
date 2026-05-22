# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 96 #1 — **Gap #7 v2 Schedule 13D/13G arc — SPEC + ADR-043 SHIPPED**: pure RESEARCH + SPEC slice resolving the EDF-3 deferral from gap #7 v1. NEW `docs/specs/adr-043-13d-13g-activist-stake-research.md` (~470 LOC) enumerates six canon-thin forks resolved at SPEC time (XD-1 form-type proxy, XD-2 filer reputation, XD-3 cover-page NLP, XD-4 amendment supersedure, XD-5 asymmetric aggregate/per-stock filter, XD-6 window inheritance) with three-criterion-test reasoning for each. NEW `docs/specs/schedule-13d-13g-activist-stake.md` (~520 LOC) ships the full SPEC for the third Layer-0 composite under gap #7 (sibling of EK + F4). 1 commit `d68c2ab` / 4 files / +1091 LOC. **60 commits ahead of `origin/main`** (was 59; this slice adds one). **NEXT default on `continue`:** XD13-A1 — `scripts/sec_edgar_13d_g_ingest.py` + raw-event table + migration. Alternative: Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter (operator-pickable).

## What this slice delivered

Closes the EDF-3 deferral from gap #7 v1 — moves 13D/13G from
"out-of-scope, queued for v2 ADR" to a full SPEC + ADR ready for code
slices. The arc has the same A1..A5 shape as EK + F4; this is the SPEC
itself (no production code, no migrations, no daemon wiring).

### Single commit (s96 #1)

**`d68c2ab` — Gap #7 v2 Schedule 13D/13G arc — SPEC + ADR-043.** 4 files, +1091 LOC / -2 LOC:

- **NEW** `docs/specs/adr-043-13d-13g-activist-stake-research.md` — ~470 LOC.
  RESEARCH note that resolves six canon-thin forks the SPEC needs answered:
  - **XD-1** Form-type-only activist-vs-passive proxy (SC 13D vs SC 13G).
    No free-text parsing of Item 4; no filer reputation. Three-criterion:
    canon-prescribed by 17 CFR 240.13d-101 vs 240.13d-102 and
    Brav-Jiang-Partnoy-Thomas 2008 + Edmans-Fang-Zur 2013; 0 free
    parameters vs N for NLP/reputation paths.
  - **XD-2** Filer reputation deferred to v2 ADR. Hand-list bakes operator
    priors; learned scores need ≥2y per-filer history that doesn't exist
    at first-run.
  - **XD-3** Cover-page Item 4/5/6 free-text NLP deferred to v2 ADR. v1
    reads SEC-structural envelope only.
  - **XD-4** Amendments (SC 13D/A, SC 13G/A) treated additively, not as
    supersessions. Matches EK 8-K amendment handling.
  - **XD-5** Asymmetric filter: aggregate per-sector rate uses NEW 13D
    only; per-stock metrics use ALL filings (including amendments).
    Brav-Jiang-Partnoy-Thomas 2008 §2.2 anchors the initial-filing
    announcement effect.
  - **XD-6** Windows inherited from EDF-6: 30d cluster trigger / 90d
    carrying / 2y daily baseline / `MIN_Z_BASELINE = 30` floor / `|z| > 2.0`
    cluster threshold. Zero new free parameters.

  Canon cited (Tier 1):
  - **Brav-Jiang-Partnoy-Thomas 2008** *J. Finance* 63(4):1729-1775 —
    activist 13D return literature; ~7% announcement abnormal return with
    no reversal.
  - **Edmans-Fang-Zur 2013** *RFS* 26(6):1443-1482 — explicit
    13D-voice-vs-13G-exit comparison; BOTH generate positive announcement
    returns + operating-performance improvements (rejects naïve "only 13D
    matters" framing).
  - **Collin-Dufresne-Fos 2015** *J. Finance* 70(4):1555-1582 —
    pre-filing informed-trading window is structurally unobtainable
    downstream of EDGAR.
  - **17 CFR 240.13d-1 to 240.13d-102** + **15 U.S.C. §78m(d)+(g)** —
    statutory backbone.

- **NEW** `docs/specs/schedule-13d-13g-activist-stake.md` — ~520 LOC. Full
  SPEC mirroring `event-driven-filings-processor.md` shape:
  - §1 goals + 11 non-goals.
  - §2 decisions — 8 gap-level (inherits EDF-1/2/4/5/6/7/8/10) + 15
    XD-specific (XD-1 to XD-15).
  - §3 component diagram (EDGAR → ingest → raw-event table → composite →
    snapshot → daemon 1m → brief #16).
  - §4 inputs (per-row raw ingest + daemon-time inputs).
  - §5 composite formulas (per-stock + aggregate + snapshot payload type).
  - §6 CH tables (`schedule_13d_g_filings` + `schedule_13d_g_snapshots`,
    both `ReplacingMergeTree(ingested_at)`).
  - §7 daemon hook step 1m (between Form 4 1l and §2 cells/bundles).
  - §8 brief section #16 (NEW, appended after #15 Form 4; byte-equal-stdout
    protection on #1-#15).
  - §9 test plan — 22 composite pure-fn + 5 repository + 12 ingest + 7
    brief renderer + 5 migration = 51 tests across the five A1..A5 slices.
  - §10 Phase A vs B vs C (informational substrate → DSR/PBO/HLZ
    validation → `phase1_v3` promotion).
  - §11 ten watch-outs (pre-filing return unobtainable, 13G is NOT just
    noise, statutory deadlines vary, filer ≠ issuer CIK, `is_amendment`
    derived from form_type suffix, `MIN_Z_BASELINE = 30` load-bearing,
    cold-start cluster_flag = false, anti-leak gate non-negotiable, no
    v2 before Phase B, CIK normalization shared).
  - §12 operator-gated action items (deferred until A1..A5 ship).
  - §13 references.

- **modified** `docs/specs/event-driven-filings-processor.md` — +6 LOC.
  Adds 2026-05-22 update note pointing at the v2 SPEC + ADR. EDF-3
  deferral resolved; EK + F4 decisions unchanged.

- **modified** `docs/obsidian/gaps/event-driven-filings-processor.md` —
  +9 LOC. Adds update note acknowledging the v2 sibling SPEC. Gap status
  remains "partially-superseded".

### What the SPEC does NOT ship (intentionally)

- No `scripts/sec_edgar_13d_g_ingest.py` — XD13-A1 slice.
- No `quantlab.schedule_13d_g_filings` table or migration — XD13-A1 slice.
- No `src/server/schedule_13d_g.ts` composite — XD13-A2 slice.
- No `quantlab.schedule_13d_g_snapshots` table or migration — XD13-A3 slice.
- No `src/server/schedule_13d_g_repository.ts` — XD13-A4 slice.
- No daemon hook position 1m wired — XD13-A4 slice.
- No brief section #16 renderer — XD13-A5 slice.

This is the SPEC SLICE. The five A1..A5 sub-arcs are queued; each becomes
its own commit in follow-up sessions.

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
| Form 4 ingest XML body URL discovery (hotfix) | ✓ s95 #3 |
| ADR-041 implementation | ✓ s95 #5 |
| Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions | ✓ s95 #6 |
| Gap #7 v2 per-EVENT EK recency | ✓ s95 #7 (EK v2 ARC FULLY CLOSED) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation FRAMEWORK | ✓ s95 #8 |
| Gap #9 v3 issuer-CSV live secondary panel ingest | ✓ s95 #9 (GAP #9 ARC FULLY CLOSED v1+v2+v3) |
| **Gap #7 v2 Schedule 13D/13G arc — SPEC + ADR-043** | **✓ s96 #1 (`d68c2ab`) SPEC SHIPPED — 4 files / +1091 LOC** |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A1 (ingest) | ☐ NEXT (recommended default on `continue`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A2..A5 | ☐ queued after A1 |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ deferred (operator-pickable; automates manual CSV drop) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 60 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 96 #1 (this slice)

**S96-1. Gap #7 v2 13D/13G arc ships as a THIRD parallel Layer-0 composite under gap #7, sibling to EK + F4.** Same architectural template: A1 (EDGAR ingest) → A2 (pure composite + tests) → A3 (snapshot table + migration) → A4 (repository + daemon hook) → A5 (brief section). Composite name = `schedule_13d_g_v1`; snapshot table = `quantlab.schedule_13d_g_snapshots`; raw-event table = `quantlab.schedule_13d_g_filings`; ingest script = `scripts/sec_edgar_13d_g_ingest.py`; composite source = `src/server/schedule_13d_g.ts`; repository = `src/server/schedule_13d_g_repository.ts`; daemon hook = step 1m; brief section = #16.
`Why:` EDF-3 in the gap #7 v1 SPEC explicitly deferred 13D/13G; the deferral cited Brav-Jiang-Partnoy-Thomas 2008 as anchor canon + the filer-reputation classification problem as the methodologically non-trivial bit. ADR-043 resolves the deferral by separating the canon-thin v1 substrate (form-type-only proxy, zero free parameters) from the canon-rich v2 layer (filer reputation, NLP, supersession — each its own future ADR).
`How to apply:` Each A1..A5 sub-arc is its own commit. XD13-A1 ships first; XD13-A5 closes the arc. v2 layers (filer reputation per XD-2, Item 4 NLP per XD-3, amendment supersession per XD-4, cover-page % parsing per XD-15) all gated on Phase B independence-test signal + their own ADRs.

**S96-2. Form-type-only activist-vs-passive proxy (XD-1).** SC 13D = active intent declared by filer; SC 13G = passive intent declared by filer. No Item 4 free-text parsing in v1; no filer reputation in v1.
`Why:` Three-criterion test (CLAUDE.md autonomous-resolution): (1) Canon-prescribed — 17 CFR 240.13d-101 vs 240.13d-102 is the tight statutory split; Brav-Jiang-Partnoy-Thomas 2008 + Edmans-Fang-Zur 2013 both use form-type as the SEC-encoded categorical. (2) Methodology rigor — form-type is structurally encoded with zero ambiguity; free-text NLP is HIGH variance at first-run without a labeled corpus. (3) 0 free parameters in v1; v2 ADR can layer reputation / NLP / supersession on top once Phase B validates the v1 signal.
`How to apply:` `filer_cik` + `filer_name` ARE stored at the raw-event layer (forensic + future use); they are NOT consumed by the v1 composite. Any v2 reputation layer reads from these stored fields.

**S96-3. Aggregate uses NEW 13D only; per-stock uses ALL filings (XD-5).** Asymmetric filter — `schedule_13d_cluster_flag` fires on per-sector NEW-13D event-rate z-scores; per-stock metrics include amendments.
`Why:` Brav-Jiang-Partnoy-Thomas 2008 §2.2 documents the announcement effect concentrates on INITIAL SC 13D filings; subsequent amendments do not reliably produce announcement returns of the same magnitude. So the aggregate signal is canon-anchored on NEW 13D. Per-stock forensic value is filing-volume-anchored (analyst reading "5 filings in 90d" wants to see the full count, not new-only).
`How to apply:` Aggregate panel: `WHERE form_type = 'SC 13D' AND is_amendment = 0`. Per-stock panel: `WHERE form_type IN ('SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A')`. The asymmetry is documented in §5 of the SPEC + ADR-043 XD-5.

**S96-4. 13G is NOT just "passive noise" — both 13D and 13G feed per-stock metrics.** Per-stock surfaces `new_13d_filing_flag_30d` + `new_13g_filing_flag_30d` as DISTINCT signals. The aggregate (NEW-13D only) is a separate signal layer.
`Why:` Edmans-Fang-Zur 2013 documents SC 13G generates positive announcement returns + operating-performance improvements (especially in liquid firms) — rejects the naïve "only 13D matters" framing. Excluding 13G from per-stock would silently drop canon-documented signal.
`How to apply:` Brief section #16 renders both `new_13d` and `new_13g` subsections separately. Per-stock JSON payload carries both flags + both day-since-latest fields.

**S96-5. Pre-filing return capture is structurally unobtainable; NOT deferred — eliminated from scope.** Collin-Dufresne-Fos 2015 documents that activists use limit orders in liquid market windows BEFORE the SC 13D 10-day-deadline disclosure. By the time EDGAR receives the filing, the informed-trading window is closed.
`Why:` The composite captures the ANNOUNCEMENT inflection, not the underlying informed-trading window. Phase B results must NOT be misinterpreted as "we can ride the pre-announcement drift" — that drift is captured by the activists, not by EDGAR consumers.
`How to apply:` Watch-out documented in §11 of the SPEC. Phase B test design must use the EDGAR-acceptance datetime as t=0; any look-back attempt would inject look-ahead bias against the structurally-impossible signal.

**S96-6. Amendment supersession deferred to v2 ADR (XD-4).** SC 13D/A and SC 13G/A treated additively. Each amendment counts as one row in `schedule_13d_g_filings` with `is_amendment = 1`. No retrospective linking of amendment → original filing.
`Why:` Three-criterion: (1) Brav-Jiang-Partnoy-Thomas 2008 treats amendments as separate filings (statutorily required on material change per 17 CFR 240.13d-2). (2) Supersession requires accession-link recovery + collapse rule. (3) Additive = 0 free parameters; supersession = N. Matches EK 8-K amendment handling.
`How to apply:` `is_amendment` derived from `form_type` suffix at ingest layer: `endswith('/A') ⇒ is_amendment = 1`. v2 ADR can introduce a supersession-link table if Phase B reveals amendment-volume distorts per-stock metrics.

**S96-7. Windows + thresholds inherited from EDF-6 + EDF-7 (XD-6).** 30d cluster trigger, 90d carrying window, 2y daily baseline, `MIN_Z_BASELINE = 30` floor, `|z| > 2.0` cluster threshold.
`Why:` Single Layer-0 convention across all three gap-#7 composites avoids per-composite window-tuning that would constitute multiple-testing free parameters. Single convention also simplifies operator interpretation: "30d / 90d means the same thing across sections 14, 15, 16."
`How to apply:` Re-tuning any of these constants bumps `schedule_13d_g_v1` version stamp + requires its own ADR + would need re-tuning across EK + F4 in lockstep.

**Carry-overs (still in force):** S95-1..S95-50 (all s95 #1-#9 decisions); S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### Newly opened (s96 #1)

- **OQ-XD13-1.** Phase B independence-test threshold for form-type-only signal. Estimated gate: ~6-8 weeks of `schedule_13d_g_filings` ingest history after XD13-A1 lands + a backfill arc to populate historical baseline (matches the gap #7 v1 EK + F4 Phase B posture). The exact form of the independence test (raw 90d abnormal-return regression vs against existing Layer-0 categories) is operator-decided at Phase B time.
- **OQ-XD13-2.** v2 filer-reputation table sourcing: hand-maintained vs auto-learned. Hand-list bakes operator priors but is interpretable; auto-learned scales better but has a 2y cold-start. Operator picks at v2 ADR time once XD13-A1..A5 has shipped + Phase B reveals form-type-only is too coarse.
- **OQ-XD13-3.** Sector-only vs cap-tier-overlay aggregate slicing. Brav-Jiang-Partnoy-Thomas 2008 documents smaller-cap targets generate stronger announcement returns. v1 ships sector-sliced only; v2 ADR could add a cap-tier overlay if Phase B reveals sector-only is too coarse.

### CARRIED (unchanged)

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
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- OQ-G2-2 — EDGAR-amendment forensic tooling default (LOW priority, deferred).
- OQ-G9-1 — issuer-specific schema mappers. RECOMMEND State Street SPDR (1 family covers 11 of the 21 ETFs).

## Next stage

### Default on `continue` — recommended: XD13-A1 (Schedule 13D/G ingest slice)

The SPEC is ready; the natural next code slice is XD13-A1:

1. **NEW** `scripts/sec_edgar_13d_g_ingest.py` — Sibling of
   `sec_edgar_form4_ingest.py`. Reuses `_sec_edgar_helpers.py` for
   rate-limit + 429 retry + User-Agent + acceptance-date filter + CIK
   resolver. Uses EDGAR full-text search filtered to
   `forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A`. Parses response envelope
   (no body fetch in v1 per XD-3). Optional `--resolve-filer-names` flag
   (default false; gated by XD-12).

2. **NEW** `scripts/migrate_create_schedule_13d_g_filings.ts` — Idempotent
   `CREATE TABLE IF NOT EXISTS quantlab.schedule_13d_g_filings`. Standard
   migration shape (pre-checks / dry-run / apply / post-checks). DDL
   byte-pinned identical to the Python ingest's `ensure_*` DDL.

3. **NEW** CH table `quantlab.schedule_13d_g_filings` per SPEC §6.

4. **NEW** `scripts/tests/test_sec_edgar_13d_g_ingest.py` — 12 tests
   (T-XD13I-1..12 per SPEC §9.3).

5. `package.json` — 4 new scripts: `edgar:13d-g:ingest{,:dry}` +
   `migrate:create-schedule-13d-g-filings{,:apply}`.

6. `scripts/help.ts` — 2 new help entries.

Estimated: ~5-7 files / ~600-800 LOC / 12 tests / 1 commit. Pattern is
established from F4-A1 (s93 #8) and EK-A1 (s93 #9); the new script is a
sibling, not a fork.

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

- **Renderer docstring refresh** — `operator_brief_render.ts` line ~2150
  still says "v1 does NOT carry per-item recency" — stale post-s95 #7.
  Light cleanup pass.

### Operator-gated action items (carried)

- (carried) Run `npm run docs:install` once (per clone) — populates
  `quartz/node_modules/`.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical
  `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` — UNBLOCKED s95 #3.
- (carried) Apply the operator-pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED — base table
    absent in operator's local CH).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from
    s95 #2).
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply`
    (×3, carry from s94 #8).
  - `migrate:create-etf-shares-outstanding-secondary:apply` (carry from
    s95 #9).
- (carried) Create `data/etf_flow_issuer_csv/` + drop canonical-schema CSVs
  before first `npm run etf:flow:issuer-csv:ingest --apply` (carry from
  s95 #9).
- (carried) Push 60 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest
  2026-08-29.

## Files / code state

### NEW this slice (s96 #1 — 1 commit `d68c2ab`)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/specs/adr-043-13d-13g-activist-stake-research.md` | +470 (NEW) | RESEARCH note. Six canon-thin forks (XD-1..XD-6) resolved with three-criterion-test reasoning. Tier 1 canon cited: Brav-Jiang-Partnoy-Thomas 2008, Edmans-Fang-Zur 2013, Collin-Dufresne-Fos 2015, 17 CFR 240.13d-1 to 240.13d-102, 15 U.S.C. §78m(d)+(g). |
| `docs/specs/schedule-13d-13g-activist-stake.md` | +520 (NEW) | Full SPEC. §1 goals + 11 non-goals; §2 decisions (8 inherited + 15 XD-specific); §3 component diagram; §4 inputs; §5 formulas; §6 CH tables; §7 daemon hook 1m; §8 brief section #16; §9 51-test plan; §10 Phase A/B/C; §11 10 watch-outs; §12 operator-gated items; §13 references. |
| `docs/specs/event-driven-filings-processor.md` | +6 | Update note resolving EDF-3 deferral. EK + F4 decisions unchanged. |
| `docs/obsidian/gaps/event-driven-filings-processor.md` | +9 | Update note acknowledging v2 sibling SPEC. |

### CH state (no change this slice)

Tables touched: zero. This is a SPEC slice — no migrations applied, no
DDL changes, no daemon behavior change. The future XD13-A1 + XD13-A3
slices add the two new tables (`schedule_13d_g_filings` +
`schedule_13d_g_snapshots`).

### Tests (no change this slice)

Tests touched: zero. This is a SPEC slice — no test code shipped. The
51 tests outlined in SPEC §9 land across the future A1..A5 slices.

Baseline check (this turn):

```text
npm run check:help    # green (no behavior change)
```

`npm test` + `npx tsc --noEmit` + pytest not re-run — docs-only slice
cannot regress any code path.

## Watch-outs

### NEW from this turn (s96 #1)

- **The SPEC is the contract for five future code slices.** XD13-A1
  through XD13-A5 must hold to the SPEC's decisions verbatim. Any
  divergence in implementation (e.g. ingest writes to a different table
  name, composite drops 13G from per-stock, brief section number shifts)
  is a SPEC violation, NOT a SPEC update. The SPEC can be amended via
  a follow-up ADR slice; ad-hoc implementation deviations are not OK.

- **`is_amendment` MUST be derived from `form_type` suffix, not from a
  separate field.** EDGAR's full-text search exposes form type as the
  full string including the '/A' suffix (e.g. `'SC 13D/A'`). Computing
  `is_amendment` from the suffix is the only canonical source; some
  EDGAR JSON responses have an `is_amendment` field but it is NOT
  universally populated. Documented in SPEC §11 watch-out #5.

- **Filer CIK ≠ issuer CIK at every layer.** EDGAR full-text search
  carries both in distinct JSON fields. Confusing them at the ingest
  layer would corrupt `distinct_13d_filers_90d` and any future
  filer-reputation work. Documented in SPEC §11 watch-out #4.

- **Pre-filing return capture is structurally impossible.** Phase B
  test design must use the EDGAR-acceptance datetime as t=0; any
  look-back attempt would chase a signal Collin-Dufresne-Fos 2015 has
  documented is already in the activists' hands by the time EDGAR
  surfaces it. Documented in SPEC §11 watch-out #1.

- **13G is canon-documented to carry signal — do not discard.**
  Edmans-Fang-Zur 2013 is the load-bearing citation. v1 surfaces both
  13D and 13G per-stock; downstream consumers (Phase B test design,
  brief reading) must not silently drop 13G. Documented in SPEC §11
  watch-out #2.

### Carried from s95 #9 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- Three-condition v3 secondary panel gate (S95-50).
- `readInputsForCycle` 4 CH round-trips + 1 probe (carry).
- Primary panel in-process reconstruction (S95-49).
- CSV parser rejects shares==0 OR close==0 at parse time (carry).
- ReplacingMergeTree(ingested_at) on (ticker, date) NOT on (ticker, date, source) (S95-47).
- UTF-8 BOM tolerance via `utf-8-sig` codec (carry).
- §13 cross-validation sub-section activates on first non-empty CSV drop (carry).
- EK/F4 composite source files have `\0` literals (carried from earlier).
- Pre-existing `gicsSectorRepositoryHelper SMP-6 EXPLAIN PLAN` failure NOT a regression.

(All earlier s89-s95 #9 watch-outs preserved unchanged.)

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

### macro_regime_v3 — re-backfill to rewrite historical T10Y2Y rows under T10Y3M (operator-pending)

```text
npm run macro:backfill:v3
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

### Gap #7 v2 Schedule 13D/13G (XD13-A1 not yet shipped — placeholder)

```text
# Once XD13-A1 lands:
npm run edgar:13d-g:ingest:dry
npm run edgar:13d-g:ingest                                       # writes to schedule_13d_g_filings
npm run migrate:create-schedule-13d-g-filings:apply
# Once XD13-A3 lands:
npm run migrate:create-schedule-13d-g-snapshots:apply
# Once XD13-A4 lands:
npm run daemon:daily                                             # populates schedule_13d_g_snapshots
# Once XD13-A5 lands:
npm run brief:morning                                            # §16 renders
```

### Tests + dev

```text
npm test                                                                       # TS — last green at s95 #9 close: 2939 pass / 1 fail / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s95 #9 close: 351 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #1 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 295 emitted from 113 inputs
```

## For the next session — priority order

**Default on `continue`:** **XD13-A1** — Schedule 13D/G ingest slice. The
SPEC is ready; XD13-A1 implements the first sub-arc (ingest + raw-event
table + migration + tests). Estimated 5-7 files / 600-800 LOC / 12 tests
/ 1 commit. Pattern established from F4-A1 + EK-A1.

**Acceptance criteria** for XD13-A1:

- ✓ `npm test` green at +N new tests (per SPEC T-XD13I-1..12).
- ✓ Python pytest green at +12 new tests (per SPEC T-XD13I-1..12).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `quantlab.schedule_13d_g_filings` migration is idempotent.
- ✓ DDL byte-pinned between ingest's `ensure_*` and migration's
  `PLANNED_DDL`.
- ✓ Acceptance-date anti-leak gate verified in ingest tests.
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6`
  failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the
default-next:

- **Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter**
  (~250-300 LOC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated
  ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused
  indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions** (home-page index.md, live dashboard
  watcher, teach-doc frontmatter rollout, promote ADR-040 status).
- **Renderer docstring refresh** for the EK section (stale).

**Operator-gated action items (carried):**

- (carried) `npm run docs:install` — ONE-TIME per clone.
- (carried) Re-run `npm run macro:backfill:v3` (non-blocking).
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply `migrate:create-form-4-insider-snapshots:apply`
  (REQUIRED).
- (carried) Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs.
- (carried) Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
- (carried s95 #9) Apply `migrate:create-etf-shares-outstanding-secondary:apply`.
- (carried s95 #9) Create `data/etf_flow_issuer_csv/` + drop canonical-schema
  CSVs.
- (carried) Push 60 commits to origin/main (HOLD).
- (carried) Drawdown framework §12 90d empirical retune — earliest
  2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- **Schedule 13D/G Phase B independence test** — earliest ~2026-07-20
  (assuming XD13-A1 lands in s96 #2 + ~6-8 weeks of ingest history;
  backfill arc could compress this).

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**Gap #7 now has THREE parallel Layer-0 composites at SPEC stage:**

- **EK (8-K classifier)** — DONE end-to-end (s93..s95 #7), with per-EVENT
  recency LIVE.
- **F4 (Form 4 insider)** — DONE end-to-end (s93..s95 #4), with sell-cluster
  + per-row recency LIVE.
- **XD13 (Schedule 13D/13G activist-stake)** — **SPEC + ADR shipped this
  slice (s96 #1); A1..A5 code slices queued.**

**The arc-shape parity is load-bearing.** XD13-A1 is the sibling of F4-A1
+ EK-A1. The shared infrastructure (`_sec_edgar_helpers.py`, `cik_ticker_map`,
acceptance-date anti-leak gate, ReplacingMergeTree idempotency, version
stamps) is reused unchanged. The differences are:

- **Form type set.** XD13 = `{SC 13D, SC 13D/A, SC 13G, SC 13G/A}`.
  EK = `8-K, 8-K/A` (with item-code filtering). F4 = `4, 4/A`.
- **Schema shape.** XD13's raw-event table has no item-code (13D/G have no
  per-item code structure equivalent); has `filer_cik` + `filer_name`
  columns (XD-7, XD-12). EK's raw-event table has `item_code`. F4's raw
  table is per-transaction with `person_cik` + `transaction_code` +
  `shares` + `price_per_share`.
- **Composite logic.** XD13 = form-type-only proxy (XD-1). EK = item-code
  filtering. F4 = transaction-code filtering + cluster detection.
- **Brief section.** XD13 = #16. EK = #14. F4 = #15.

**The v2 layers (filer reputation, NLP, supersession, cover-page % parse)
are all gated on Phase B + their own ADRs.** Do NOT auto-open them.

**Backward compat preserved on three fronts:**

1. **CH:** Zero DDL change to v1/v2 tables (existing EK + F4 + ETF-flow +
   exec-departure tables untouched). The two new XD13 tables land in
   future A1 + A3 slices.
2. **Type:** No TS changes this slice. Future A2 slice adds
   `Schedule13DGSnapshot` interface.
3. **Daemon:** Code untouched this slice. Future A4 slice wires step 1m.

**Parallel-tracks posture continues.** s96 #1 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Docs-only slice — no test
re-run required.

**The chain through s96 #1:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1..#9                                              ✓ as documented in prior HANDOFF
S96 #1: gap #7 v2 Schedule 13D/13G arc — SPEC + ADR    ✓ committed (d68c2ab)
        — RESOLVES the EDF-3 deferral from gap #7 v1
        — ADR-043 + companion SPEC + parent-SPEC delta
          + gap-doc delta
        — 4 files / +1091 LOC / 0 production code
S96 #1 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: XD13-A1 (Schedule 13D/G ingest slice).
                  Sibling of F4-A1 + EK-A1.
                  Pattern established; ~5-7 files,
                  ~600-800 LOC, 12 tests, 1 commit.
  → background: brief §16 placeholder; will activate
                as soon as XD13-A5 lands. Until then,
                daily daemon runs unchanged.
```
