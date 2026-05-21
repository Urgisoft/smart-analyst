# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 94 #5 — **OQ-G2-1 ADR-042 RESEARCH note SHIPPED** as commit `9ceb1cd`. Three-option proposal for per-sector daily rate baseline computation written; tradeoff matrix covers CH read amplification / cold-start window / schema cost / backfill simplicity plus PIT correctness, Phase B replayability, operator-facing observability, composability, migration reversibility, daemon-cycle latency, and slice size. Cross-cutting design notes pin shared-discriminator-column pattern (S94-12 regression protection), GICS-helper reuse path for Option (a), newly opened OQ-G2-2 follow-up on EDGAR-amendment policy. Per HANDOFF S94-7 + CLAUDE.md autonomous-execution canon-thin rule, the note explicitly does NOT auto-pick — operator picks (a)/(b)/(c) before the chosen-option SPEC + CODE slice can land. Vector Core canon-thin disclosure surfaced explicitly. All gates green (no code touched; npm test unchanged 2833/2802; tsc unchanged 13 errors; pytest unchanged 324/324). 12 commits ahead of `origin/main`; push still operator-gated. **NEXT: operator picks Option (a)/(b)/(c) from ADR-042 RESEARCH note. Once picked, next-session writes the ADR-042 text in `docs/decisions/README.md` + the chosen-option SPEC + the G2-A1/A2/A3 triple slice (coordinated atomic edits across sections #12 + #14 + #15 footers + composite-taglines + repository annotations + brief panel surface per S94-14).**)

## What this turn delivered

Fifth slice (ADR-042 RESEARCH note) of the gap #7+#8 v2 GICS-activation arc — the operator-decided systems-engineering ADR proposal that unblocks G2 (aggregate-panel activation across all three composites). Single doc, no code, surfaces option-comparison to operator.

1. **`docs/specs/adr-042-gics-sector-baseline-computation-research.md`** (NEW, ~450 LOC):
   - **Status / Date / Owner / Resolves header** pointing at HANDOFF OQ-G2-1.
   - **Upstream-SPEC pointers** to the three blocked composite SPECs (executive-departure §5.2 + §11; event-driven-filings §5.2 EK + §5.3 F4).
   - **Tier-1 canon** (AFML Ch 1 §1.2 + Ch 11; Bailey-LdP 2014) with explicit canon-thin disclosure for the systems-engineering portion ("AFML §11 is silent on the storage layer; Pardo §6 assumes the rate series exists but does not specify how to materialize it"). Vector Core canon-thin rule honored.
   - **§1 Scope** — pins the trailing-2y per-sector daily rate series (~503 days × 11 sectors = ~5,533 rate points per composite); enumerates out-of-scope items (MIN_Z_BASELINE = 30 floor + rate-window length + per-ticker sector annotation already shipped + cross-composite z-combination + EDGAR-amendment retroactive correction policy).
   - **§2 Option enumeration** — three options with example CH DDL / query shapes:
     - **(a) Re-compute on-the-fly** — single GROUP BY + ASOF JOIN to GICS map + PIT constituents per cycle per composite; zero new schema; zero backfill.
     - **(b) Persist sibling table + one-time backfill** — `quantlab.<composite>_sector_rate_baseline` ReplacingMergeTree shape; write-once historical rates; needs `scripts/backfill_sector_rate_baseline.ts`.
     - **(c) Hybrid: persist, no backfill** — same schema as (b) but daemon writes from cycle 1 forward; accepts ~30 trading days cold-start.
   - **§3 Tradeoff matrix** — 12-row table covering the four explicitly-requested dimensions (CH read amplification / cold-start window / schema cost / backfill simplicity) plus eight additional dimensions (CH write amplification, PIT correctness under EDGAR amendments, Phase B replayability, operator-facing observability, composability with future composites, migration reversibility, daemon-cycle latency budget, implementation slice size).
   - **§4 Cross-cutting design notes** (apply regardless of which option is picked):
     - §4.1 — **Unified table with `composite` discriminator** strong recommendation for Option (b)/(c) over three sibling tables (S94-12 rule-of-three regression protection; pattern mirrors `quantlab.gics_sector_map` from s94 #1 G1-A1).
     - §4.2 — **GICS helper reuse for Option (a)** — new `readSectorMembershipPanel(asOf_start, asOf_end)` helper function would join the `gics_sector_repository_helper.ts` family.
     - §4.3 — **Newly opened OQ-G2-2 follow-up** on EDGAR-amendment behavior; the chosen-option SPEC needs to pin the default (silent re-write under (a); frozen baseline under (b)/(c)).
     - §4.4 — `MIN_Z_BASELINE = 30` cold-start interaction per option.
     - §4.5 — **Daemon-cycle ordering** — today's rate MUST be excluded from baseline (self-reference deflates z-magnitude trivially).
   - **§5 Operator-pick framing** — three "what each option actually optimizes for" buckets (smallest deployment / operationally replayable / clean-room start). Notes the three composites do NOT need to share an option, though mixed picks add complexity.
   - **§6 SPEC-stage open questions** — six items the chosen-option SPEC must resolve (PIT-correctness of constituents JOIN; mid-window sector swaps; empty-sector days `stddevSamp` denominator; daemon-cycle log line shape; brief panel surface wording per S94-14; OQ-G2-2 amendment-behavior default).
   - **§7 What ships NOW vs LATER** — pins this RESEARCH note as the operator-facing surface; the ADR-042 text + companion SPEC + G2 triple slice ships next.
   - **§8 Watch-outs** — seven items: auto-pick prohibition per S94-7; EDGAR-amendment wart for Option (a); S94-14 coordinated-triple-edit requirement; `stddevSamp` vs `stddevPop` Bessel correction; today's-rate-excluded daemon-cycle ordering; shared `composite` discriminator regression protection; PIT constituents-panel-coverage prerequisite.
   - **§9 "Why this is RESEARCH, not SPEC, not CODE"** — Vector Core stage-discipline boilerplate explicit closing.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s93 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7 ENTIRE ARC (v1) | ✓ DONE end-to-end (s93) |
| Gap #7+#8 v2 GICS-A1 (shared infra: table + ingest) | ✓ s94 #1 (`8cfdd72`) |
| Gap #7+#8 v2 GICS-A2 (F4 repo + section #15 annotation) | ✓ s94 #2 (`3eb94d6`) |
| Gap #7+#8 v2 GICS-A3 (EK repo + section #14 annotation) | ✓ s94 #3 (`497a645`) |
| Gap #7+#8 v2 GICS-A4 (XD repo + section #12 annotation + helper extraction) | ✓ s94 #4 (`dc70f8c`) |
| **Gap #7+#8 v2 OQ-G2-1 ADR-042 RESEARCH note** | **✓ s94 #5 (`9ceb1cd`) — operator-pick pending** |
| Gap #7+#8 v2 GICS-G2 (aggregate-panel activation) | ☐ BLOCKED on operator picking ADR-042 (a)/(b)/(c) |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable |
| Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap) | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 sell-cluster sector aggregation (per S93-44) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 12 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 5 (this turn, this commit) — ADR-042 RESEARCH note shipped

**S94-15. ADR-042 is operator-decided; the RESEARCH note explicitly does NOT auto-pick.**
`Why:` Per HANDOFF S94-7 explicit framing the baseline-computation strategy is operator-decided, NOT a canon-thin methodology fork eligible for autonomous resolution. CLAUDE.md autonomous-execution canon-thin rule applies to METHODOLOGY forks where the three-criterion test (canon foundations / methodology rigor / minimum free parameters) lands a defensible choice. ADR-042 is a SYSTEMS-ENGINEERING fork where the operator's preference between schema-cost vs read-amplification vs cold-start-acceptance matters more than the canon, which is silent on the storage layer (AFML §11 is methodology-only; Pardo §6 assumes the rate series exists but doesn't specify materialization). Vector Core canon-thin disclosure surfaced explicitly in the RESEARCH note's canon header. Three-criterion analysis is INAPPLICABLE here because:
  1. **Canon foundations** — Tier-1 canon is silent on the storage decision. All three options are equally well-grounded (i.e., not grounded at all) in canon.
  2. **Methodology rigor** — all three options compute identical z-scores given identical input data. The differences are operational, not methodological.
  3. **Minimum free parameters** — all three options have zero free statistical parameters (the formula is fixed); the "parameters" being tuned are engineering preferences.

`How to apply:` Future ADRs that are systems-engineering forks (storage strategy, schema vs schemaless, ingest cadence, query-shape choice) MUST be operator-decided, NOT auto-resolved via the canon-thin rule. The autonomous resolution rule applies to methodology forks (validation scheme, ranking metric, sample weighting, etc.) — not to deployment/infra/schema choices. When in doubt, surface the choice to the operator with a RESEARCH note + option enumeration + tradeoff matrix; do NOT pick.

**S94-16. Unified-table-with-discriminator pattern is the strong recommendation for Option (b)/(c) over three sibling tables.**
`Why:` S94-12 just resolved the rule-of-three drift problem at the `readSectorByTicker` helper level. Three sibling baseline tables would re-introduce the same drift surface — three migrations / three backfill paths / three repository wirings / three operator-inspection queries. The unified-table pattern (one table with `composite LowCardinality(String)` discriminator) follows the `quantlab.gics_sector_map` precedent from s94 #1 G1-A1 (shared infra serving three downstream composites). Three-criterion-equivalent for THIS engineering sub-choice (not the ADR-042 pick itself, but the schema shape if Option (b)/(c) lands):
  1. **Canon foundations** — DRY canon + Fowler *Refactoring* (rule-of-three already applied to the helper layer).
  2. **Methodology rigor** — single regression target for schema drift; one place to add a fourth composite (13D/13G arc, sell-cluster sector aggregation).
  3. **Minimum free parameters** — one table = one ORDER BY = one ReplacingMergeTree config; eliminates three-way drift.

`How to apply:` If the operator picks Option (b) or (c), the chosen-option SPEC MUST specify the unified-table pattern with a `composite` discriminator column. Three sibling tables is a deferrable-but-do-not-recommend alternative; the chosen-option SPEC pins the unified shape unless the operator explicitly overrides. The DDL recommendation in ADR-042 §2 Option (b) already encodes this.

**S94-17. OQ-G2-2 (newly opened) — EDGAR-amendment behavior — needs to be pinned in the chosen-option SPEC, NOT a separate ADR.**
`Why:` The §3 tradeoff-matrix row "Point-in-time correctness under late-arriving EDGAR amendments" surfaces a default-behavior question the v1 SPECs don't address: under Option (a), amendments silently re-write the baseline; under Option (b)/(c), the baseline is frozen at first-write. The default behavior follows mechanically from the chosen option's storage strategy. A separate ADR for amendment-detection tooling would be premature — the right move is to PIN the default in the chosen-option SPEC + flag the forensic-tooling question as a deferred Bucket-3 enhancement. ADR-043 only opens if Phase B independence tests reveal amendment frequency is high enough to materially distort z-score historicals (currently estimated rare for 8-K Item 5.02, more common for Form 4 trade-detail amendments).

`How to apply:` The chosen-option SPEC's test list MUST include a test that pins the amendment-behavior default. For Option (a): "amendment of a past day's event count silently re-writes the baseline mean/std on the next cycle." For Option (b)/(c): "amendment of a past day's event count does NOT re-write the frozen baseline row." Don't open ADR-043 for amendment tooling unless Phase B testing reveals the wart actually bites operationally.

### Sessions 84-93 + s94 #1..#4 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-14 carry through.

## Open questions

### CARRIED — OPERATOR-DECIDED (HIGH priority — blocks G2)

**OQ-G2-1 (HIGH — RESEARCH NOTE SHIPPED THIS TURN, AWAITING OPERATOR PICK).** Per-sector daily rate baseline computation strategy. ADR-042 RESEARCH note at [`docs/specs/adr-042-gics-sector-baseline-computation-research.md`](../docs/specs/adr-042-gics-sector-baseline-computation-research.md) shipped this turn. Three options:
  - **(a) Re-compute on-the-fly** — zero new schema, single GROUP BY + ASOF JOIN per cycle per composite, ~0.3-1.5 s per cycle total across three composites. Smallest slice (~150 LOC + ~12 tests). Best if you want G2 live fastest with the smallest deployment surface; accept the EDGAR-amendment wart.
  - **(b) Persist sibling table + backfill** — unified table with `composite` discriminator (per S94-16), one-time backfill script, frozen historical rates. ~450 LOC + ~85 tests. Best if you want operational replayability + frozen-rate guarantees for Phase B independence tests.
  - **(c) Persist sibling table, no backfill** — same schema as (b), accepts ~30 trading days cold-start before MIN_Z_BASELINE clears. ~300 LOC + ~70 tests. Best if you want the clean-room property where the daemon never infers history it didn't see.

The three composites do NOT need to share an option (mixed pick possible but adds complexity). NEXT SESSION'S DEFAULT: surface this to operator + wait for pick. Do NOT auto-pick per S94-15 + S94-7.

### Newly opened (per ADR-042 §4.3)

**OQ-G2-2 (MEDIUM — opens once OQ-G2-1 resolves).** EDGAR-amendment behavior default. Per S94-17 the default follows mechanically from the ADR-042 pick (silent re-write under (a); frozen baseline under (b)/(c)). The chosen-option SPEC pins this in its test list. ADR-043 (amendment-detection tooling) only opens if Phase B testing reveals the operational wart bites; until then this is a deferred Bucket-3 enhancement, NOT a blocker.

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
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess; verification deferred to first ingest run).
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

### Closed this turn

- ~~OQ-G2-1 ADR option-comparison brief is not yet written~~ — RESOLVED per S94-15: ADR-042 RESEARCH note shipped at `docs/specs/adr-042-gics-sector-baseline-computation-research.md`; operator pick now blocks.

## Next stage

### Default on "continue"

**Wait for operator pick of ADR-042 Option (a)/(b)/(c).** Per S94-15 + S94-7 the choice is operator-decided. The next session opens with the operator's pick, then immediately:

1. **Writes the ADR-042 text** in `docs/decisions/README.md` — short ADR entry (decision + alternatives + open questions + watch-outs) pointing at the RESEARCH note for substantive material. Pattern follows the ADR-040 → docs/decisions/README.md fan-in.
2. **Writes the companion SPEC** at `docs/specs/gics-sector-baseline-computation.md` — contracts, function signatures, byte-pinned test list per the chosen option. Resolves the six §6 open questions from the RESEARCH note.
3. **Lands the G2-A1/A2/A3 triple slice** as a coordinated atomic edit per S94-14:
   - **G2-A1** — F4 aggregate-panel activation (section #15 footer + composite-tagline + repository annotations).
   - **G2-A2** — EK aggregate-panel activation (section #14 + composite-tagline + repository annotations).
   - **G2-A3** — XD aggregate-panel activation (section #12 + composite-tagline + repository annotations).
4. **If Option (a) picked**: adds `readSectorMembershipPanel` helper function to `src/server/gics_sector_repository_helper.ts` per RESEARCH §4.2; ~80 LOC + ~6 tests.
5. **If Option (b) picked**: ships unified-table migration script + backfill script per S94-16 + their tests; ~270 LOC + ~40 tests.
6. **If Option (c) picked**: ships unified-table migration script per S94-16 (no backfill); ~120 LOC + ~25 tests.

**If the operator wants the option pre-discussed before deciding** (e.g., asks for cost comparison under Phase B cadence promotion, or asks for the OQ-G2-2 amendment-behavior default to be analyzed in more depth), the next session can extend the RESEARCH note inline rather than picking. **Do NOT auto-pick under any circumstance.**

### After ADR-042 picks + G2 ships

The gap #7+#8 v2 arc closes end-to-end. Remaining operator-pickable next-default candidates:

- **ADR-041 implementation** (`yield_curve_inverted` regime category) — Accepted methodology, slot un-queued.
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would use the new shared `readGicsSectorByTicker` helper for per-ticker sector annotation + the ADR-042 baseline infrastructure once it lands for aggregate).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

### Operator-gated action items (carried)

- Push 12 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Operator-decided ADR-042 pick.

## Files / code state

### NEW this turn (s94 #5)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/adr-042-gics-sector-baseline-computation-research.md` | NEW (`9ceb1cd`) | RESEARCH note (~450 LOC). Three-option proposal with 12-row tradeoff matrix + cross-cutting design notes (unified-table-discriminator pattern S94-16; GICS-helper reuse path; OQ-G2-2 amendment-behavior follow-up S94-17; daemon-cycle ordering) + 6 SPEC-stage open questions + 7 watch-outs. Explicitly does NOT auto-pick per S94-15. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for ADR-042 RESEARCH-note close. |

### From s94 #4 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/gics_sector_repository_helper.ts` | EXISTS (`dc70f8c`) | Shared `readGicsSectorByTicker` byte-template. Future Option (a) wiring would add `readSectorMembershipPanel` to this module per ADR-042 §4.2. |
| `src/server/executive_departure_repository.ts` | EXISTS (`dc70f8c`) | G1-A4 wired. Future G2-A3 will add aggregate panel population per chosen option. |
| `src/server/form_4_insider_repository.ts` | EXISTS (`dc70f8c` refactor) | G1-A2 wired. Future G2-A1 will add aggregate panel population per chosen option. |
| `src/server/eight_k_classifier_repository.ts` | EXISTS (`dc70f8c` refactor) | G1-A3 wired. Future G2-A2 will add aggregate panel population per chosen option. |
| `src/server/operator_brief.ts` | EXISTS (`dc70f8c`) | All three composer functions stamp `tickersWithCikCount` + `watchUniverseTickerCount`. Future S94-14 triple-edit will update aggregate-panel composition. |
| `src/server/operator_brief_render.ts` | EXISTS (`dc70f8c`) | All three sections' OQ-G2-1-awaiting footer + composite-tagline wording. Future S94-14 triple-edit will rewrite per chosen option. |

### From s94 #1-#3 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_gics_sector_map.ts` | EXISTS (`8cfdd72`) | Shared infra. |
| `scripts/sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | Wikipedia ingest. |
| `scripts/tests/migrateCreateGicsSectorMap.test.ts` | EXISTS (`8cfdd72`) | 25 tests. |
| `scripts/tests/test_sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | 26 tests. |
| `package.json` | EXISTS (`8cfdd72`) | +4 GICS ingest entries. |
| `scripts/help.ts` | EXISTS (`8cfdd72`) | +2 EXTRA_HELP entries. |

(All earlier gap arcs + earlier S94 files preserved unchanged.)

### CH state (unchanged from s94 #4)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created.
- `quantlab.eight_k_classifier_snapshots` — NOT yet created.
- `quantlab.insider_trades` — NOT yet created.
- `quantlab.insider_ciks` — NOT yet created.
- `quantlab.form_4_insider_snapshots` — NOT yet created.
- `quantlab.gics_sector_map` — NOT yet created (TS migration ready; Python ingest also lazy-creates on first --apply).
- `quantlab.<composite>_sector_rate_baseline` — NOT created (gated on ADR-042 pick; only applies if Option (b)/(c) picked).

### Tests (unchanged from s94 #4 baseline — no code touched this turn)

```text
npm test                       2833 tests / 2802 pass / 0 fail / 31 skipped   ✓ unchanged
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   324 / 324 (unchanged)
```

## Watch-outs

### NEW from this turn (s94 #5)

- **Do NOT auto-pick ADR-042.** Per S94-15 + S94-7, this is operator-decided. The autonomous-resolution rule (CLAUDE.md canon-thin methodology forks) does NOT apply to systems-engineering forks. The next session writes the chosen-option SPEC ONLY after the operator picks.
- **The RESEARCH note's §5 "operator-pick framing" is decision-neutral.** Three options are framed as "what each optimizes for," not as a ranked preference. The mild pushback against Option (c)'s 30-day cold-start in the watch-outs is engineering opinion, NOT a recommendation against picking it. Operator preference is what matters.
- **If Option (b) or (c) is picked, the unified-table-with-discriminator pattern per S94-16 is the strong default.** Three sibling tables would regress the rule-of-three drift problem S94-12 just solved at the helper level. The chosen-option SPEC pins the unified shape unless the operator explicitly overrides.
- **The G2 triple slice per S94-14 is coordinated atomic.** When the chosen-option SPEC lands, the G2-A1/A2/A3 wirings MUST land as one atomic commit (or one tight commit sequence) — section #12 + #14 + #15 footer wordings + composite-taglines + repository annotations all drift-coupled. Single-composite incremental rollout would visibly drift the operator-facing wording.
- **OQ-G2-2 (EDGAR-amendment behavior) follows mechanically from the ADR-042 pick per S94-17.** The chosen-option SPEC's test list pins the default behavior. Do NOT open ADR-043 unless Phase B testing reveals operational impact.
- **`stddevSamp` not `stddevPop` in the CH baseline-std computation.** The trailing-2y series is a sample, not the population. Bessel correction matters. Pin in the chosen-option SPEC's test list; regression here would be a silent z-score scale drift.
- **Today's rate MUST be excluded from baseline (self-reference deflates z-magnitude trivially).** The §2 Option (a) query and §4.5 daemon-cycle ordering note both flag this; SPEC test list pins. Applies to ALL THREE options equally.
- **PIT constituents-panel coverage is a hard prerequisite for any G2 option.** `quantlab.sp500_constituents` needs trailing-2y coverage before deployment; otherwise the rate denominator is 0 → null rate → baseline below MIN_Z_BASELINE → z = null across the cold-start. Verify before deploying any G2 option.

### Carried (s89-s94 #4 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs from s94 #4:

- `gics_sector_repository_helper.ts` is now the byte-template owner; future fourth GICS-consuming repository adds a single line of code (per S94-12).
- Section #12's table-cell sector annotation position is byte-pinned by T-OBR-XD-9.
- OQ-G2-1-awaiting footer wording IS the drift-coupling-anchor across three composites per S94-14 → drives the S94-14 coordinated triple-edit at G2 close.
- `inputsAvailablePerTicker` semantic is now meaningful (not structurally 0) across all three composites.
- The helper's `asOf` is ALWAYS coerced to `YYYY-MM-DD`.
- `LIMIT 1 BY ticker` is ClickHouse-specific (non-portable).

Key carry-overs from s94 #1:

- Cross-language drift on `gics_sector_map` DDL (test parity in `migrateCreateGicsSectorMap.test.ts`).
- `MIN_ROWS_FLOOR = 480` is a SCHEMA-DRIFT alarm, not a happy-path floor.
- `GICS_SECTORS` enum is the load-bearing canonical-name pin.
- `TICKER_REGEX` accepts only EDGAR-style dots (BRK.B), NOT yfinance dashes (BRK-B).
- Wikipedia 403s default Python-urllib User-Agent.
- Snapshot semantics v1 = `snapshot_date = today()`.
- `source` LowCardinality DEFAULT `'wikipedia_sp500'` requires explicit write for alternative sources.
- Parser locates table by HEADER SIGNATURE not by index.
- `_clean_text` footnote regex `\[[^\]]*\]` greedy assumption.
- `parse_sp500_table` raises ValueError (NOT returns empty).
- `index_granularity = 8192` is the Layer-0 lookup-table idiom.
- 12 commits ahead of `origin/main`; push operator-gated.

(All earlier s89-s93 watch-outs preserved unchanged — same list as in prior HANDOFF.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY; G2 awaiting ADR-042 pick)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# F4 / EK / XD per-ticker sector wiring (READY since s94 #2/#3/#4):
# All three brief sections (#12 + #14 + #15) annotate flagged tickers with their
# GICS sector when row exists in map.

# G2 aggregate-panel activation:
# AWAITING OPERATOR PICK of ADR-042 Option (a)/(b)/(c).
# RESEARCH note: docs/specs/adr-042-gics-sector-baseline-computation-research.md
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

### Gap #8 executive-departure activation

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily
npm run brief:morning                                   # section #12 now sector-annotated
```

### Gap #7 8-K classifier (FULLY READY)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (FULLY READY)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — 2833 / 2802 / 31 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Default on `continue`:** open with the operator's ADR-042 pick. The RESEARCH note at [`docs/specs/adr-042-gics-sector-baseline-computation-research.md`](../docs/specs/adr-042-gics-sector-baseline-computation-research.md) lays out three options + tradeoff matrix + cross-cutting design notes. Per S94-15, **do NOT auto-pick** — wait for the operator to choose (a)/(b)/(c). If the operator hasn't picked when the next chat opens, propose surfacing the RESEARCH note to them inline (e.g., paste the §5 "what each option optimizes for" framing) rather than picking.

**Once operator picks ADR-042 Option (a)/(b)/(c):**
1. Write ADR-042 text in `docs/decisions/README.md` (short ADR entry; substantive material in the existing RESEARCH note).
2. Write companion SPEC at `docs/specs/gics-sector-baseline-computation.md` per the picked option (resolves §6 open questions from RESEARCH note).
3. Land G2-A1/A2/A3 triple slice (coordinated atomic per S94-14): F4 + EK + XD aggregate-panel activation + repository annotations + brief panel surface rewrites.
4. If Option (a): add `readSectorMembershipPanel` helper to `gics_sector_repository_helper.ts`.
5. If Option (b): ship unified-table migration + backfill script per S94-16.
6. If Option (c): ship unified-table migration per S94-16 (no backfill).

**If operator reprioritizes**: any of these candidates can replace ADR-042 follow-up as the default-next once G2 closes:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would consume the new shared `readGicsSectorByTicker` helper for per-ticker sector annotation + the ADR-042 baseline infrastructure once it lands for aggregate).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**
- Push 12 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- **ADR-042 pick** — operator MUST choose Option (a)/(b)/(c) before any G2 slice can start. **The next session can SURFACE the RESEARCH note + framing but MUST NOT auto-pick.**
- ADR-041 implementation (Accepted methodology but slot un-queued).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the nine Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

**Gap #7+#8 v2 G1 ARC IS LANDED end-to-end** (per s94 #4 close). All three per-composite repositories (F4, EK, XD) read GICS sector from the shared `quantlab.gics_sector_map` table; all three brief sections (#12, #14, #15) annotate flagged-ticker rows with their GICS sector inline. The shared `readGicsSectorByTicker` helper owns the byte-template SQL + parsing per S94-12 rule-of-three extraction.

**The G1 → G2 transition is now GATED ON OPERATOR PICK of ADR-042 Option (a)/(b)/(c).** The RESEARCH note shipped this turn (`9ceb1cd`) enumerates the three options with a 12-row tradeoff matrix covering the four explicitly-requested dimensions (CH read amplification / cold-start window / schema cost / backfill simplicity) plus eight additional dimensions (PIT correctness under EDGAR amendments, Phase B replayability, observability, composability with future composites, migration reversibility, daemon-cycle latency, slice size, CH write amplification). Cross-cutting design notes pin the unified-table-with-discriminator pattern (S94-16), GICS-helper reuse path for Option (a), newly opened OQ-G2-2 EDGAR-amendment-behavior follow-up (S94-17), `MIN_Z_BASELINE` interaction, and daemon-cycle ordering. Six SPEC-stage open questions deferred to the chosen-option SPEC. Seven watch-outs flag the auto-pick prohibition + the engineering details the chosen-option SPEC must pin.

**Per S94-15 the ADR-042 pick is OPERATOR-DECIDED, NOT a canon-thin methodology fork eligible for autonomous resolution.** The Vector Core canon-thin rule applies to METHODOLOGY forks (validation scheme, ranking metric, sample weighting) where the three-criterion test can land a defensible choice. ADR-042 is a SYSTEMS-ENGINEERING fork where the operator's preference between schema-cost vs read-amplification vs cold-start-acceptance matters more than the canon, which is silent on the storage layer.

**Per S94-14 + S94-16 the G2 deployment slice MUST land coordinated atomic edits** across all three composites' brief sections + repository annotations + composite-taglines. Single-composite incremental rollout would visibly drift the operator-facing wording.

**Parallel-tracks posture continues.** s94 #5 did NOT affect C-12 / paper-trading / real-money-flip arcs. No code touched this turn (single RESEARCH-note doc); all gates green at s94 #4 baseline.

**The chain through s94 #5:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15)           ✓ committed (3eb94d6)
S94 #3: gap #7+#8 v2 GICS-A3 (EK repo + #14)           ✓ committed (497a645)
S94 #4: gap #7+#8 v2 GICS-A4 (XD repo + #12 +          ✓ committed (dc70f8c)
        helper extraction per S94-10)
S94 #5: OQ-G2-1 ADR-042 RESEARCH note                  ✓ committed (9ceb1cd)
S94 #5 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: wait for operator pick of ADR-042 (a)/(b)/(c)
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots now ALL carry populated sector field when
                gics_sector_map row exists; cold-start (no ingest yet) preserves
                null + the brief renders without annotation across all three.
                Aggregate-panel computation remains dormant pending ADR-042 pick.
```
