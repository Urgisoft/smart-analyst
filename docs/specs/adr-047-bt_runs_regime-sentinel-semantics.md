# ADR-047 — `bt_runs_regime` sentinel rows: keep as-is, clarify mislabel; close GAP-16

**Status:** Accepted (orchestration-authored 2026-05-23 in session 96 #17 Cycle 6
per `docs/architecture/multi-agent-orchestration.md` §8.4; resolved under §6.4
routine-resolution authority — no real-money / methodology-amendment trigger
fires).
**Date:** 2026-05-23
**Owner:** Vector Core orchestration (assistant). No operator gate — this ADR
documents a finding on an existing dataset; it does not change data, schema,
or behavior.
**Operates under:** [ADR-044](adr-044-standing-system-health-ownership.md)
(standing system-health ownership) — Cycle 6 of the multi-agent orchestration's
GAP-closure schedule.
**Cross-references:** the SPEC this ADR amends-by-documentation is
[regime-backtest-attribution-component5.md](regime-backtest-attribution-component5.md);
the implementation is [src/server/bt_runs_regime.ts](../../src/server/bt_runs_regime.ts);
the reconciliation audit is
[docs/audits/system-reconciliation-2026-05.md](../audits/system-reconciliation-2026-05.md)
§3.3 GAP-16.

## Context

### What GAP-16 reported (reconciliation audit 2026-05-23, session 96 #12)

> **GAP-16 — 78,399 zero-trade sentinels in `bt_runs_regime`**
>
> What: HANDOFF carries this as "deferred." Either garbage data to clean
> OR intentional sentinel marker pattern.
> Action: Operator decides whether to keep, label, or purge.

The audit deferred the keep/label/purge decision without inspecting the rows.
Cycle 6's task per orchestration §8.4 is the inspection + decision (which now
lives in the orchestration's authority per the working-model change, not the
operator's).

### What the read-only probe found (2026-05-23, `scripts/_probe_gap16_sentinels.ts`)

Six probes against `quantlab.bt_runs_regime FINAL`:

| Probe | Finding |
| --- | --- |
| P1 — totals by classifier_version | 197,064 rows, **all under `phase1_v2`** (zero `phase1_v3` attribution exists; see §"Side-finding" below) |
| P2 — attribution_source split | 118,665 `window` (60.2%); **78,399 `sentinel_no_trades` (39.8%)** — matches GAP-16's count; 0 `trades_fallback` (the fallback code path has never fired on this dataset) |
| P3 — sentinel-vs-`bt_runs.trades` alignment | **Only 21,489 of 78,399 sentinel run_ids (27.4%) correspond to `bt_runs` rows with `trades=0`**. The remaining ~57k sentinel rows correspond to `bt_runs` rows where the engine DID record trades (the top buckets: trades=10/11/12/13/14/15/16/17/18/19, then 40-44, then many lower counts). |
| P4 — non-sentinel `total_days` distribution | All non-sentinel rows have `total_days > 0`. The "window-source with empty macro coverage" branch ([bt_runs_regime.ts:367-385](../../src/server/bt_runs_regime.ts#L367-L385)) has never fired in practice. |
| P5 — sentinel content shape | Every sampled sentinel matches the by-design `buildSentinelResult` shape: `total_days=0`, `dominant_regime='unknown'`, `dominant_regime_share=0`, empty Map. `start=end=startedAt` per the asOfDate convention. |
| P6 — count cross-check | `n_sentinels = 78,399` = `n_sentinel_label` = `n_zero_unknown_pattern` — the three definitions agree, no anomalous rows masquerading as sentinels-by-content but mislabelled-by-source (or vice versa). |

The full probe output is in the Cycle 6 transcript; the probe script is
preserved at `scripts/_probe_gap16_sentinels.ts` (diagnostic-script
convention per audit GAP-17 — `_`-prefix marks single-shot investigation
scripts).

### The semantic surprise

The SPEC at §2.2 documents the sentinel branch trigger as:

> "If `bt_trades` also has no rows for the run (zero-trade legacy run),
>  skip attribution entirely (write a sentinel row — see §3.4)."

The implementation in [bt_runs_regime.ts:318-339](../../src/server/bt_runs_regime.ts#L318-L339)
fires the sentinel branch when BOTH of these conditions hold:

1. `bt_runs.data_span_days <= 0` (the engine pre-dating Phase 5
   walk-forward did not write this column — legacy rows).
2. AND `fetchTradeWindow` returns an empty/null window (no rows match the
   `(sweep_id, token_address, strategy_type, param)` lookup in `bt_trades`).

The SPEC's gloss "zero-trade legacy run" conflates "no `bt_trades` per-trade
detail" with "no trades." In practice — per P3 — they are not the same.
`bt_runs.trades` (the summary count column on `bt_runs`) and the per-trade
detail in `bt_trades` can diverge. About 73% of the sentinel rows correspond
to runs where `bt_runs.trades > 0` but `bt_trades` had no matching per-trade
detail at attribution time.

Three plausible root causes (not investigated further here; not load-bearing
for the decision):

- (a) **Engine-version asymmetry.** A historical engine version wrote
  `bt_runs.trades` (the summary) without persisting per-trade rows to
  `bt_trades`. The current engine writes both.
- (b) **Bulk cleanup.** `bt_trades` was selectively pruned for older runs at
  some past point (per-trade detail is high-volume; summary survives).
- (c) **Key drift.** The `(sweep_id, token_address, strategy_type, param)`
  quadruple format changed at some point and the lookup misses pre-change rows.

The label `sentinel_no_trades` is therefore **semantically misleading** for
~73% of the rows that carry it. The accurate label would be
`sentinel_no_window_derivable` (data_span_days missing AND bt_trades detail
unavailable for window derivation).

## Decision

**Keep all 78,399 sentinel rows.** No purge. No re-label. Document the
mislabel + the actual semantics + the no-downstream-impact in the type
docstring and in this ADR.

### Why keep (not purge)

The sentinel rows are not garbage. They record a real fact: the regime
attribution pipeline considered these `bt_runs` rows and determined that
neither the primary path (data_span_days) nor the fallback path (bt_trades
window derivation) could produce a window. That is **audit information** —
purging it would lose the record that 78k legacy runs exist and were considered.

Purging would also require an `ALTER ... DELETE` on `bt_runs_regime`, which
is a destructive op per ADR-044 / CLAUDE.md hard-stop list — operator-gated.
The cost-benefit (operator queue add for a data-removal that loses an audit
trail and reclaims trivial storage) does not justify the escalation.

### Why not re-label (e.g. add `sentinel_no_window_derivable`)

Re-labelling would require all of:

- Add a new value to the public TypeScript type
  `AttributionSource = 'window' | 'trades_fallback' | 'sentinel_no_trades'`
  ([bt_runs_regime.ts:32](../../src/server/bt_runs_regime.ts#L32)). Touches a
  public type signature.
- Backfill the existing 78,399 rows from the legacy label to the new label.
  Requires either re-running the attribution (which re-fires the
  sentinel branch and overwrites by `ReplacingMergeTree`) OR an
  `ALTER ... UPDATE` (destructive op per CLAUDE.md hard-stop list).
- Update the SPEC at §2.2 §3.4 + every test fixture that pins the literal.
- Update the read-side `includeSentinels` discriminator at
  [bt_runs_regime.ts:503-505](../../src/server/bt_runs_regime.ts#L503-L505)
  to recognize the new label OR keep the old label as an alias.

The cost (cross-cutting type + DDL + test + SPEC change) does not justify the
benefit (more accurate label) given:

- Read-side default `includeSentinels=false` already excludes all sentinels
  from downstream metrics — no calculation is corrupted by the mislabel.
- The mislabel is forensic-only — it surfaces when an operator queries the
  raw `bt_runs_regime` table directly, which is a debugging path, not a
  production-read path. A docstring clarification is sufficient guard for
  that path.

A future re-label could ship as part of a Phase 9+ schema cleanup IF the
`phase1_v3` backfill (see §"Side-finding") exposes additional sentinel
patterns that warrant a richer source enum. Punting now follows the
"no premature abstraction" rule from the Vector Core operating rules
("fewer features, robustly").

### Why not Tier-2 quarantine (per ADR-044 §"Two-tier auto-remediation")

The sentinel rows do not match any Tier-2 trigger in
[adr-044-standing-system-health-ownership.md](adr-044-standing-system-health-ownership.md):

- Not an impossible value: `total_days=0` + `dominant_regime='unknown'` are
  valid by design — both fields explicitly accept the `unknown` sentinel
  state per the SPEC §3.1 schema notes.
- Not an unexpected calculation change: the rows have been at this count
  since long before Cycle 6; they are static-state, not a signal flip.
- Not cross-validation divergence: bt_runs_regime is a single-source
  attribution table, not cross-validated.
- Not a regime classifier flip mismatch: the sentinel branch is
  pre-classification (window derivation fails first).
- Not real-money path: bt_runs_regime feeds the operator brief §C
  component 5 (regime attribution) — diagnostic / analytical, not live
  trade execution.

The finding is a **documentation gap**, not a correctness anomaly.

### Side-finding (out of scope for GAP-16; tracked for visibility)

P1 shows that `bt_runs_regime` has **zero `phase1_v3` rows.** The v2-vs-v3
attribution comparison promised in ADR-037 / SPEC §1 D4 requires a v3
backfill via:

```bash
npm run backfill:bt-regime -- --classifier-version=phase1_v3
```

This is independent of GAP-16. It is **not** added to the operator queue
(no real-money / methodology-amendment trigger). It will surface in the
default-on-`continue` flow of a future cycle as part of the Phase 9+
analytical work; or — if an operator query against bt_runs_regime under v3
returns empty when v3 is the active classifier — the missing backfill will
be the obvious diagnosis.

## Consequences

**Positive:**

- GAP-16 closes as documentation-only; no DDL, no DML, no type change, no
  test change. tsc baseline 13 preserved.
- The mislabel is now documented in `bt_runs_regime.ts`'s type docstring +
  in this ADR; a future operator who queries the raw table directly will
  find the explanation in two places (the type and the ADR cross-link).
- The `_probe_gap16_sentinels.ts` script is preserved with a date-stamp
  header per GAP-17's leave-with-`_`-prefix policy for diagnostic scripts.
  A future investigation (e.g. after `phase1_v3` backfill lands) can re-run
  the same probes for an updated picture without re-deriving the queries.

**Negative:**

- The misleading label `sentinel_no_trades` persists in the data + the
  public TypeScript type. Mitigated by the docstring; not eliminated.
- The accurate label would be more useful in a future debug session, but
  the cost-of-change (per "Why not re-label" above) outweighs that benefit.

**Risks + mitigations:**

- **A future contributor reads the label literally and assumes all 78,399
  rows correspond to true zero-trade runs.** Mitigation: the docstring on
  `AttributionSource` ([bt_runs_regime.ts:32](../../src/server/bt_runs_regime.ts#L32))
  and on `buildSentinelResult`
  ([bt_runs_regime.ts:243](../../src/server/bt_runs_regime.ts#L243)) now
  call out the actual trigger condition + the GAP-16 forensic finding +
  the ADR-047 reference.
- **A future schema migration that adds a new `AttributionSource` value
  inadvertently breaks the read-side default `includeSentinels=false`
  filter** ([bt_runs_regime.ts:503-505](../../src/server/bt_runs_regime.ts#L503-L505)).
  Mitigation: the filter literal `attribution_source != 'sentinel_no_trades'`
  is grep-able; the convention pin in
  `scripts/tests/btRunsRegime.test.ts` exercises the discriminator.
- **A v3 backfill exposes a new sentinel pattern not anticipated here.**
  Mitigation: the v3 backfill is a future-cycle deliverable; if a new
  pattern emerges, this ADR is one of the inputs for whatever follow-up
  ADR re-considers the keep/label/purge decision.

## What this ADR does NOT decide

- The root cause of the `bt_runs.trades > 0` AND `bt_trades` empty
  divergence (the three plausible causes listed in §"The semantic surprise"
  are not ranked or investigated; the diagnostic effort is deferred until
  a downstream consumer needs to know).
- Whether to re-attribute the legacy rows under a more permissive
  fallback (e.g. derive window from `started_at` minus some heuristic
  span). The SPEC's deliberate choice (§2.2) to refuse attribution when
  no real window is derivable is preserved.
- Whether and when to backfill `phase1_v3` attribution (the side-finding).
  Deferred to a future cycle.
- Whether to re-label the sentinel source in a Phase 9+ schema cleanup
  (deferred per "Why not re-label" above).

## Re-verification (2026-05-30, session 96 #36 Cycle 39)

GAP-16 was re-examined when the Cycle-39 "Next stage" menu still listed it as an open
reconciliation gap (stale — this ADR closed it in Cycle 6). A fresh probe of
`quantlab.bt_runs_regime FINAL` confirms ADR-047's guarantees hold on the grown dataset
and resolves the §"Side-finding" item:

- **The `phase1_v3` backfill (the side-finding) has since completed.** The table now
  holds BOTH classifiers, each identical: `phase1_v2` = 118,665 `window` + 78,399
  `sentinel_no_trades`; `phase1_v3` = 118,665 `window` + 78,399 `sentinel_no_trades`
  (total FINAL = 394,128). The per-classifier sentinel count is UNCHANGED from Cycle 6
  (78,399) — the table doubled only because v3 was added, NOT because new sentinels
  accrued. The pattern is deterministic + byte-identical across classifiers, which is
  itself strong evidence it is by-design, not drift.
- **Content-shape integrity holds: 0 violations.** Every `sentinel_no_trades` row still
  has `total_days=0` ∧ `dominant_regime='unknown'` ∧ empty `regime_distribution`; 0
  non-sentinel rows have `total_days=0`. No row masquerades as a sentinel-by-content
  while mislabelled-by-source, or vice versa (P5/P6 still true).
- **The read-side guard is intact.** `fetchBtRunsByRegime`
  ([bt_runs_regime.ts:522-524](../../src/server/bt_runs_regime.ts#L522)) still applies
  `AND a.attribution_source != 'sentinel_no_trades'` whenever `includeSentinels` is
  falsy (the default) — sentinels remain excluded from every downstream metric.

**Verdict unchanged: keep, documentation-only. GAP-16 remains closed.** The stale
"open gap" reference is corrected in HANDOFF. No data/schema/type/test change; tsc
baseline preserved.

## Cross-references

- `docs/specs/regime-backtest-attribution-component5.md` — the SPEC this
  ADR amends-by-documentation (§2.2 + §3.4 + §3.1 schema-notes).
- `src/server/bt_runs_regime.ts` — the implementation; docstrings on
  `AttributionSource` and `buildSentinelResult` now cross-link this ADR.
- `scripts/_probe_gap16_sentinels.ts` — the diagnostic probe whose output
  was the basis for this ADR.
- `docs/audits/system-reconciliation-2026-05.md` §3.3 — the audit entry
  GAP-16 that this ADR closes.
- `docs/architecture/multi-agent-orchestration.md` §6.4 + §8.4 — the
  authority under which the orchestration resolves this without operator
  involvement.
- `docs/specs/adr-044-standing-system-health-ownership.md` — Tier-1/Tier-2
  policy under which this finding was classified neither.
- `docs/specs/adr-037` (in `docs/decisions/README.md`) — the
  bias-quarantine principle that originally motivated the
  `(run_id, classifier_version)` sidecar key; the side-finding's missing
  v3 backfill is the unfinished work from that ADR's design.
