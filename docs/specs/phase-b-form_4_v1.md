---
status: spec-blocked-on-construct-and-coverage
phase: phase-b
last_updated: 2026-05-30
session: 96 #35 Cycle 38
owner: Orchestrator (Vector Core); Composite worker executes the v5 construct change + (later) the campaign
type: spec
slice_id: adr-051-instance-form_4_v1
parent_adr: docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md
construct_adr: docs/specs/adr-055-form4-aggregate-cross-sectional-pooling.md
predecessor_specs:
  - docs/specs/phase-b-cycle-v1.md
  - docs/specs/phase-b-vol_struct_v1.md
  - docs/specs/phase-b-sector_rot_v1.md
  - docs/specs/phase-b-cross_asset_v1.md
---

# SPEC — Phase B deflation-pipeline campaign for `form_4_insider` (aggregate)

> **This is NOT a ready-to-run campaign SPEC like its four predecessors.** The other
> Layer-0 composites had long-history continuous inputs (yfinance / FRED) and a valid
> continuous score axis on day one, so their Phase-B SPEC was just the per-composite
> overlay on the ADR-051 harness. The form_4 aggregate is different: its statistic was
> only made valid across three prior ADRs (052 provenance → 053 statistic → 054
> effective-sample guard), its construct UNIT was only settled in **ADR-055**
> (cross-sectional pooling; per-sector demoted to informational), and its input
> (`quantlab.insider_trades`) has an ~18-month EDGAR coverage gap that makes the signal
> `under_review` everywhere TODAY. This SPEC therefore has **two parts**:
>
> - **Part A — construct change (precondition).** Implement the ADR-055 pooled aggregate
>   (`form_4_insider_v5`). A Composite-worker CODE cycle. This is what makes form_4 *have*
>   a Phase-B-viable signal at all.
> - **Part B — deflation campaign (blocked on coverage).** The cross_asset_v1-pattern
>   DSR/PBO/HLZ overlay on the pooled continuous score. **Blocked** until ADR-052 D7 (+
>   likely a multi-year EDGAR backfill) gives the pooled series ≥ `EVENT_FLOOR = 20`
>   distinct events and enough continuous history for an IS/OOS/CSCV split.
>
> Read ADR-055 (construct), ADR-051 (harness), ADR-052/053/054 (the form_4 statistic
> chain), and the four predecessor SPECs first. This SPEC is the form_4 delta + the
> readiness gate.

---

## 1. Scope

### Part A — construct change `form_4_insider_v5` (Composite worker; precondition)

**Builds:**

1. `src/server/form_4_insider.ts` — add the index-level pooled reducer per ADR-055 D1:
   one `pooledRate(t) = Σ clusterTickers / Σ sectorSize` series per direction; feed it
   through the EXISTING `computeEmpiricalExceedance` (ADR-053) + `countNonZeroRuns` /
   `EVENT_FLOOR` guard (ADR-054), VERBATIM. `form4ClusterFlag` / `form4SellClusterFlag` +
   `maxAggregateZ[Sell]` now derive from the POOLED stat, not the max over sectors. The
   per-sector `computeSectorClusterRate` + flagged-sector lists are RETAINED as
   informational (ADR-055 D2). Bump `FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v5'`
   (ADR-055 D4). NO new tunable parameter.
2. `src/server/form_4_insider_repository.ts` — `populateSectorsForCycle` additionally
   emits the pooled baseline: the trailing-2y daily `pooledRate` over the SAME ADR-052-D2
   coverage-admitted days, chronological order (ADR-054 D1 load-bearing). Either as a new
   `pooledBaseline2y` / `pooledBaseline2ySell` on the inputs, or computed in the composite
   from the per-sector panels — the worker picks the lower-duplication path (three-criterion
   block required if canon-thin).
3. UI: the form_4 composite-detail panel (`descriptors.ts` / the composite dashboard)
   labels the per-sector breakdown "informational — not statistically calibrated (ADR-055)"
   and shows the pooled stat as the gated signal. **UI-validation-each-slice applies** —
   the v5 slice ships a browser-validatable surface (per the UI-validation feedback rule).
4. Re-backfill `form_4_insider_snapshots` → v5 (`scripts/_backfill_form_4_insider_snapshots.ts
   --apply`, ~98 days, ~79s) + re-version the `health_quarantine` row (`adr_ref +=
   ADR-055`, stays `accepted-as-warning`).
5. Tests: pooled-reducer golden vectors; pooled `effectiveEvents` via `countNonZeroRuns`;
   pooled exceedance = ADR-053 identity on the pooled series; the per-sector layer is
   non-gated (flag derives from pooled only); version pin `form_4_insider_v5`; the existing
   439-test form4 suite stays green (statistic/guard unchanged — only the unit changed).

**Does NOT build (Part A):** any change to the ADR-053 statistic or ADR-054 guard (reused
verbatim); any real-money path file; any DDL (ADR-055 D5 — reuse existing columns); any
Phase-C promotion (Q-8 operator-gated, DORMANT).

### Part B — deflation campaign (BLOCKED; pinned for when coverage lands)

**Builds (only after the readiness gate §3 passes):**

1. `scripts/_probe_phase_b_form_4_v1_inputs.ts` — Step 0 pre-flight (mirrors the
   cross_asset_v1 probe): row count + earliest date in `form_4_insider_snapshots`, pooled
   `effectiveEvents`, continuous-coverage span; classify full / empty / ambiguous.
2. `scripts/_backfill_form_4_insider_snapshots.ts` — extend to the multi-year EDGAR window
   (see §5 window) once the EDGAR Form 4 XML backfill (free, throttled) has populated
   `insider_trades` historically. **This is the gating data op** (OQ-C38-2).
3. `scripts/phase_b_campaign_form_4_v1.ts` — the ADR-051 harness; `loadScoreSeries()` reads
   the pooled buy-rate, polarity-aligned Φ- (or ECDF-) rescaled (§2). Wires the four-gate
   validator (DSR/PBO/HLZ/Pardo) per benchmark; persists trial + verdict rows with
   `composite_version = 'form_4_insider_v5'`.
4. `docs/analysis/phase-b-form_4_v1-deflation-2026-XX.md` — verdict report.
5. ≥40 harness tests (mirror cross_asset_v1 §5).

**Does NOT build (Part B):** a `form_4_insider_v6` redesign in response to the verdict
(ADR-051 D5/D8 anti-shopping; the version pin makes any future bump auditable); Phase C
promotion (operator-gated).

---

## 2. form_4-specific decisions

### S-PBF1-1 — Score axis: the pooled cluster-BUY-rate (ADR-055 D1), polarity-aligned

The composite's gated continuous axis is `pooledRate_buy(t)` = fraction of S&P-500 issuers
with an insider buy-cluster at `t`. Polarity is ALIGNED (high = bullish): broad insider
accumulation is the bullish-conviction signal (Lakonishok-Lee 2001 §3; Seyhun 1986). So the
campaign uses straight Φ/ECDF rescaling, **no S96-124 negation** (same as cross_asset_v1).

A symmetric sell-side campaign (`pooledRate_sell`, polarity-INVERTED: high sell-rate =
bearish → S96-124 negate-before-rescale) is a documented sister run, weighted asymmetrically
per Lakonishok-Lee 2001 §4 (sell signal ~30–50% diluted by tax/diversification/charity).

**Why the pooled rate and not `maxAggregateZ` / the exceedance p:** `zEmp`/`p` are bounded,
data-limited, and only defined when the ADR-054 guard passes — not a clean continuous θ-sweep
axis. The raw pooled rate is the continuous measurement (cf. cross_asset_v1 using the raw
`copperGoldRatio20dChangePct`, not its z). The empirical-exceedance/guard machinery remains
the COMPOSITE's daily anomaly signal (dashboard); the deflation campaign θ-sweeps the raw
pooled rate.

### S-PBF1-2 — Rescaling: ECDF preferred over Φ (PUSHBACK on the Φ default)

The pooled rate is a bounded [0,1] sparse, zero-inflated, right-skewed quantity — it is NOT
approximately normal (the exact reason ADR-053 rejected the Gaussian z for the per-sector
rate). Applying Φ (the S96-120 default for unbounded continuous axes) would re-import a
Gaussian assumption the form_4 chain has repeatedly rejected. **Use an empirical-CDF
rescaling** `score(t) = ECDF_IS(pooledRate(t))` (rank within the in-sample distribution),
which is distribution-free and consistent with ADR-053's empirical-tail philosophy. The
θ-grid then probes empirical percentiles directly. (Pin Φ as the documented fallback only if
ECDF interacts badly with the CSCV slice machinery — to be decided at Part-B build with a
three-criterion block, not assumed now.)

### S-PBF1-3 — Benchmarks: SPY + QQQ + IWM; M = 19 × 3 = 57

Identical to all four predecessors (ADR-051 D2). The form_4 claim "broad insider
accumulation predicts US equity strength" is directly testable on US equity benchmarks.

### S-PBF1-4 — θ grid {0.05,…,0.95}, 19 trials; verdict aggregation; version pin

Identical to predecessors (ADR-051 D1/D5/D8). PASS-ALL iff ≥1 benchmark passes all four
gates AND `pbo_value < 0.2`. Every persisted row `composite_version = 'form_4_insider_v5'`.
Phase C eligibility is mechanical (`pass-all ∧ pbo<0.2`) and never auto-promotes — Q-8 is
the only eligibility→promotion path.

### S-PBF1-5 — Time window: needs a multi-year EDGAR backfill for parity (OQ-C38-2)

The other 8 Layer-0 composites use 2013-01-03 → today (IS 2013–2022, OOS 2023–today) for
cross-composite meta-HLZ parity. form_4 cannot match this from current data (continuous
coverage ≈ Dec-2025 → May-2026). EDGAR Form 4 XML is free + available historically, so the
window IS achievable via a multi-year EDGAR backfill (throttled, pre-authorized; NOT paid,
NOT auth-scraping). **Until that backfill lands the campaign cannot run.** Minimum viable
sub-window (if the full 13y proves impractical): whatever continuous span yields pooled
`effectiveEvents ≥ 20` AND a CSCV `effectiveS ≥ 4` IS/OOS split — documented as a degraded
campaign in the verdict `notes`, NOT a relaxed gate.

---

## 3. Readiness gate (the blocker — ADR-055 D3)

Part B MUST NOT run until BOTH hold (measured by the Step-0 probe, never assumed):

1. **Event-floor:** pooled `effectiveEvents ≥ EVENT_FLOOR = 20` for the direction under
   test, on the campaign window's IS baseline.
2. **CSCV resolvability:** the continuous pooled-score history yields `effectiveS ≥ 4`
   (the CSCV minimum) on the IS/OOS split.

**Current state (measured 2026-05-30, `_diag_form4_pooled_events.ts`):** pooled
`effectiveEvents` ∈ [2,15] buy / [3,19] sell — **below 20 → gate FAILS.** Binding constraint
= the short continuous baseline (n=203 admitted days), not the unit. Gate clears only after
ADR-052 D7 (+ likely the multi-year backfill). **Do NOT lower `EVENT_FLOOR` to pass the gate
(anti-shopping; ADR-055 alternatives + ADR-054 D3).**

---

## 4. Verification gates

**Part A (v5 construct change) — Composite-worker integration gate:**

```text
node --import tsx --test scripts/tests/form4Insider.test.ts \
     scripts/tests/form4InsiderRepository.test.ts \
     scripts/tests/compositeForm4Dashboard.test.ts \
     scripts/tests/operatorBrief.test.ts scripts/tests/operatorBriefRender.test.ts   # all green (+ new pooled tests)
npx tsc --noEmit                                                                      # ≤ 13 baseline
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply                        # ~98 days → v5
npm run health:check                                                                  # no NEW Tier-2
npm run dev  # browser: /#/form-4-insider renders pooled stat + per-sector labelled informational; no NaN/Infinity
# Verify on CH: every snapshot composite_version='form_4_insider_v5'; maxAggregateZ pooled
#   (null today — still under_review, expected per §3).
```

**Part B (campaign) — only after §3 gate passes:** mirror cross_asset_v1 §6 verbatim
(probe → backfill → tsc/tests → `--dry-run` → `--apply` → read verdicts via
`PhaseBRepository`).

---

## 5. Test plan

**Part A (≥ the 439 existing form4 tests stay green + new):**
- [ ] Pooled reducer golden vector: known per-sector (clusterTickers, size) → expected
      `pooledRate = Σnum/Σden`; matches a hand-computed reference.
- [ ] Pooled `effectiveEvents` = `countNonZeroRuns(pooledBaseline)` (reuses the ADR-054
      helper; a plateau → 1 event).
- [ ] Pooled exceedance = `computeEmpiricalExceedance` identity on the pooled series (the
      statistic is unchanged — pin that the SAME function is called, just on the pooled
      input).
- [ ] Gating: `form4ClusterFlag` derives from the POOLED exceedance ONLY; a per-sector
      sector clearing α does NOT fire the flag (per-sector demoted, ADR-055 D2).
- [ ] Suppression today: with the live baseline, pooled `insufficientData = true`
      (effectiveEvents < 20) → flag false, `maxAggregateZ` null (the honest under_review).
- [ ] Version pin `form_4_insider_v5`; chronological baseline order still load-bearing
      (POPSEC-F4-ORDER extended to the pooled series).
- [ ] UI: per-sector rows carry the "informational — not calibrated" label.

**Part B:** mirror cross_asset_v1 §5 (probe schema; backfill idempotency + row-count;
harness golden-vector backtest; ECDF rescaling identity/monotonicity; loadScoreSeries shape;
walk-forward split; CSCV config; ValidatorRequest packaging; verdict aggregation; version
pin) — ≥40 tests.

---

## 6. Files / code state

**At Part-A close (target):**

| Path | Change | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | modified | pooled reducer; flag/maxZ from pooled; per-sector retained informational; v5 pin. NO new param. |
| `src/server/form_4_insider_repository.ts` | modified | pooled baseline over admitted days; chronological order load-bearing. |
| `src/components/composite/descriptors.ts` (+ dashboard) | modified | per-sector labelled informational; pooled = gated signal. |
| `scripts/tests/form4Insider*.test.ts` (+ dashboard/brief tests) | modified | + pooled tests; suite stays green. |
| `quantlab.form_4_insider_snapshots` | re-backfill → v5 | ReplacingMergeTree; ~98 rows. NO DDL. |
| `quantlab.health_quarantine` | re-version | `adr_ref += ADR-055`; stays `accepted-as-warning`. |

**At Part-B close (target, post-coverage):** mirrors cross_asset_v1 §7 (probe + extended
backfill + `phase_b_campaign_form_4_v1.ts` + tests + verdict report + `phase_b_trials`/
`phase_b_verdicts` rows + `phase_b_dashboard.ts` roster registration). No real-money path;
no paid data; EDGAR + CH writes pre-authorized.

---

## 7. Watch-outs

- **The headline finding: form_4's aggregate is the SPARSEST Layer-0 composite, and pooling
  does not rescue it at current coverage.** Pooled `effectiveEvents` upper bound (Σ) is
  15/19 < 20. The signal is honestly `under_review`; Part B is genuinely blocked, not
  deferred for convenience. Surfacing this clearly is the [HEALTH] outcome — do not let a
  future cycle mistake "pooled construct shipped" for "form_4 is Phase-B-ready."
- **Do NOT lower `EVENT_FLOOR` or relax HLZ/PBO/DSR to force a verdict.** The proximity of
  15/19 to 20 is the anti-shopping trap (ADR-055; AFML §11.4; ADR-051 D5).
- **ECDF vs Φ rescaling (S-PBF1-2) is a real decision, not the default.** The pooled rate is
  non-normal; the form_4 chain has rejected Gaussian assumptions three times. Default to
  ECDF; justify any Φ fallback with a three-criterion block at Part-B build.
- **Window parity needs a multi-year EDGAR backfill (OQ-C38-2)** — free + throttled, so it's
  a pacing op, not a paid-data blocker. Without it, form_4 either runs a degraded
  sub-window (documented, not relaxed) or stays out of the 9-arc meta-HLZ until coverage
  lands.
- **Sell-side is informationally weaker (Lakonishok-Lee 2001 §4)** — weight it
  asymmetrically; a sell-side PASS is not equivalent to a buy-side PASS.
- **Per-sector is informational ONLY (ADR-055 D2).** Any future reader/consumer that gates
  on a per-sector form_4 flag is using a non-calibrated signal — the UI label + this SPEC
  are the guardrails.
- **Implementation ordering (ADR-055 §sequencing):** prefer D7 backfill → then v5, so the v5
  re-backfill verification can show the stat resolving. Shipping v5 before D7 is permitted
  but forces two re-backfills and shows no observable change (still under_review).

---

## 8. Open questions

- **OQ-C38-1** — does the pooled series actually reach ≥20 events post-D7, and when?
  Measure on the v5 re-backfill; if it falls short, choose multi-year EDGAR backfill
  (preferred) vs permanently-informational. Do NOT pre-judge.
- **OQ-C38-2** — multi-year EDGAR Form 4 XML backfill for window parity (free, throttled).
- **OQ-C37-2** — firing-run de-dup / fire-on-onset now lives on the pooled series (a
  consumer/harness concern); moot until coverage permits firing.
- **OQ-052-3** — the ADR-052/053/054 + ADR-055 four-layer template (provenance → valid
  statistic → event-level effective sample → cross-sectional pooling) now applies to every
  z/exceedance-on-rolling-cluster-rate composite (schedule_13d_g, eight_k,
  executive_departure, short_interest) once each ingest runs.

---

## 9. Cross-references

- Construct ADR: `docs/specs/adr-055-form4-aggregate-cross-sectional-pooling.md`
- Parent harness ADR: `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
- form_4 statistic chain: `docs/specs/adr-052-…` / `adr-053-…` / `adr-054-…`
- Predecessor campaign SPECs: `phase-b-cycle-v1.md`, `phase-b-vol_struct_v1.md`,
  `phase-b-sector_rot_v1.md`, `phase-b-cross_asset_v1.md`
- Composite + I/O: `src/server/form_4_insider.ts`, `src/server/form_4_insider_repository.ts`
- Validator + DSR/PBO/HLZ libs: `src/lib/validator.ts`, `src/lib/psr.ts`, `src/lib/cscv.ts`,
  `src/lib/hlzHaircut.ts`; Phase B repo: `src/server/phase_b_repository.ts`; UI:
  `src/server/phase_b_dashboard.ts`
- Canon: Lakonishok & Lee 2001 §3–§4; Seyhun 1986; Harvey-Liu-Zhu 2016 §II; López de Prado
  AFML 2018 Ch. 4 §4.3–4.4 + Ch. 11; Aronson 2006 Ch. 6–7; Bailey & López de Prado 2014
  (DSR); Bailey-Borwein-LdP-Zhu 2014 (CSCV/PBO); Pardo 2008 §2–3.
```

