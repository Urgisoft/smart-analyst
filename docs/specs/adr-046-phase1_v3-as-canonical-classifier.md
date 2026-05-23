# ADR-046 — phase1_v3 is the canonical macro-regime classifier across brief + UI + all downstream

**Status:** Accepted (orchestration-authored 2026-05-23 in session 96 #17 Cycle 4 per
`docs/architecture/multi-agent-orchestration.md` §8.4; per §6.4 routine-resolution
authority — no real-money / methodology-amendment trigger fires).
**Date:** 2026-05-23
**Owner:** Vector Core orchestration (assistant). No operator gate — this ADR
documents a state that has been live since session 39 (2026-04-30); it does not
change behavior.
**Supersedes / extends:** Extends [ADR-037](adr-037 not stored as a standalone
file; the v2 bias-quarantine record lives in `docs/decisions/README.md` § ADR-037
+ in `BIAS_NOTE_PHASE1_V2` constant docstring). Closes the housekeeping item
[ADR-038](#) flagged in its Consequences section: *"The v3 ship-and-supersede
write-up never happened as a standalone ADR and is implicitly captured across
ADR-037, this ADR, and the v3 spec itself. The spec note remains as historical
drift; updating it is a separate housekeeping item."* This ADR is that item.
Operates under [ADR-044](adr-044-standing-system-health-ownership.md) (system
health ownership) and complements [ADR-041](adr-041 — see decisions README;
single-day yield-curve fire) + [ADR-045](adr-045-phase1-v3-cboe-putcall-input-window.md)
(CBOE input-window quarantine) which both extend v3.

## Context

### What GAP-8 reported (reconciliation audit 2026-05-23, session 96 #12)

The reconciliation audit flagged
[`docs/audits/system-reconciliation-2026-05.md`](../audits/system-reconciliation-2026-05.md)
GAP-8:

> **GAP-8 — `regime_dashboard.ts` hardcodes `phase1_v3` (intentional but undocumented)**
>
> The regime dashboard reads `classifier_version = 'phase1_v3'` hardcoded at
> `src/server/regime_dashboard.ts:141`. The phase1_v2 classifier output still lives
> in `macro_regimes` and is the live brief's source per some carry-over paths.
> Operator visual inconsistency. Recommended action: verify which classifier is
> the live source-of-truth + align both UI + brief to read the same one. Likely
> a documentation gap (the choice is intentional but not documented as the live
> classifier per a recent ADR).

The orchestration's Cycle 4 verification (session 96 #17) inspected the live
codebase and found that **the brief and UI already share the same source of
truth** — the apparent inconsistency in the audit framing dissolves. What remains
is the documentation gap.

### What the codebase actually looks like (2026-05-23)

The single source-of-truth declaration:

```ts
// src/server/macro_regime.ts:59
export const CLASSIFIER_VERSION = 'phase1_v3';
```

Every downstream consumer imports this symbol — no consumer hardcodes the
string literal `'phase1_v3'` outside of forensic docstring + archival
back-references. Concretely, at the time of this ADR:

| Consumer | File | Import path |
| --- | --- | --- |
| Regime dashboard (UI route `/api/regime/state`) | `src/server/regime_dashboard.ts` | `import { CLASSIFIER_VERSION, fetchMacroRegimeRange } from './macro_regime.js'` |
| Operator brief composer (`npm run brief:morning`) | `src/server/operator_brief.ts` | `import { CLASSIFIER_VERSION } from './macro_regime.js'` |
| Health-check freshness probe (ADR-044 Phase 1) | `src/server/health_check.ts` | (reads `macro_regimes` filtered by `CLASSIFIER_VERSION` for cadence checks) |
| Cross-asset signals / sector rotation / vol structure / cycle position composites | `src/server/cross_asset_signals.ts`, `sector_rotation.ts`, `vol_structure.ts`, `cycle_position.ts` | (all join `macro_regimes` on the active `CLASSIFIER_VERSION`) |
| Daemon live-trades router | `src/server/daemon_live_trades.ts` | (reads regime label via composer that threads `CLASSIFIER_VERSION` through) |
| Drawdown framework state | `src/server/drawdown_state.ts` | (regime label for kill-criteria gating) |

The audit's framing — "regime_dashboard.ts:141 hardcodes phase1_v3" — was
imprecise. Line 141 sits inside the `ADR_037_BASELINE` constant docstring, which
references `phase1_v2` for forensic provenance. The actual classifier version
used by the dashboard's read query is the imported `CLASSIFIER_VERSION` symbol
(see `regime_dashboard.ts:499`, `:511`, `:638`). No literal `'phase1_v3'`
appears outside docstrings + archival baseline back-references.

The brief's chain is similarly clean:

1. `operator_brief.ts` composes from `buildRegimeSection({ regime })` which
   reads the regime via `fetchRegimeState` (the same dashboard composer the
   `/#/regime` UI route uses — single read path, two consumers).
2. The composer returns `classifierVersion: CLASSIFIER_VERSION` in its
   response payload.
3. The brief's output object surfaces it as
   `classifierVersion: regime.classifierVersion ?? CLASSIFIER_VERSION` —
   defensive fallback to the same constant.

The brief and UI are therefore reading the **same row set** (`macro_regimes
FINAL WHERE classifier_version = 'phase1_v3'`) through the **same composer**
(`fetchRegimeState`). No visual inconsistency is possible by construction. The
"may surface v2 depending on the read path" concern in GAP-8 was a worry, not
a finding.

### The v2 → v3 transition history (load-bearing facts)

For future readers, the canonical chronology of the v2 → v3 transition:

| Session | Date | Event | Locked-in by |
| --- | --- | --- | --- |
| s24 | 2026-04-26 | `phase1_v2` shipped as the first survivorship-bias-quarantined classifier; replaces the unversioned phase1 prototype | ADR-037 §1-§3 |
| s25 | 2026-04-27 | `phase1_v2` quarantine banner copy + `BIAS_NOTE_PHASE1_V2` constant pinned | ADR-037 §4 + `regime_dashboard.ts:217-231` |
| s38-39 | 2026-04-29 to 2026-04-30 | `phase1_v3` lands — `breadth_narrow` (the sole survivorship-biased category) replaced with four free leading indicators: `yield_curve_inverted` (Estrella-Mishkin 1998), `credit_stress` (Gilchrist-Zakrajšek 2012 analogue), `risk_off_rotation` (SPY 20d − TLT 20d < −10pp), `sentiment_extreme` (CBOE ^CPC 5d MA OR VIX/VIX3M ≤ 0.80; Whaley 2009). `BIAS_NOTE_PHASE1_V3` constant pinned. `CLASSIFIER_VERSION = 'phase1_v3'` flip in `macro_regime.ts:59` | `docs/specs/macro-regime-classifier-phase1_v3.md` + `src/server/macro_regime_v3.ts` + `BIAS_NOTE_PHASE1_V3` at `regime_dashboard.ts:251-269` |
| s40 | 2026-05-10 | First `ADR_038_BASELINE` pin `{32, 370, 1406, 2809}` post VIX_TERM_COMPLACENCY_FLOOR 0.85 → 0.80 ramp; pre-CBOE backfill (sentiment_extreme CBOE arm structurally null) | `regime_dashboard.ts:188-190` docstring |
| s44 | 2026-05-14 | CBOE put/call 2003-10-17 → 2019-10-04 ingest lands (4,018 rows into `quantlab.macro_indicators_cboe`) | session HANDOFF carryover |
| s45 | 2026-05-15 | First post-CBOE `macro:backfill:v3` rerun + `ADR_038_BASELINE` re-pin to `{127, 349, 1392, 2754}` | ADR-038 §1-§5 |
| s78-79 | 2026-05-16 to 2026-05-17 | PUT_CALL_COMPLACENCY_LOW 0.65 → 0.77 retune + second backfill rerun + `ADR_038_BASELINE` re-pin to `{131, 359, 1473, 2659}` (the current pin) | ADR-038 amendment + `regime_dashboard.ts:198-203` |
| s95 #5 | 2026-05-22 | ADR-041: `yield_curve_inverted` single-day fire rule swap (T10Y2Y/3-day → T10Y3M/single-day per Estrella-Mishkin) | ADR-041 |
| s96 #15 | 2026-05-23 | ADR-045: `sentiment_extreme` CBOE arm input window quarantined as `accepted-as-warning` after Cycle 1 confirmed free-source exhaustion past 2019-10-04 | ADR-045 + Q-5 quarantine row in `quantlab.health_quarantine` |

`phase1_v2` rows still exist in `quantlab.macro_regimes` (the table partitions by
`classifier_version`, not by truncation), and remain readable for any forensic
back-reference. **No code path reads them as a live signal.** `BIAS_NOTE_PHASE1_V2`
+ `ADR_037_BASELINE` are kept as exported constants only for the v2 distribution
test in `scripts/tests/regimeDashboard.test.ts` (test #9a) + for back-references
to archived `phase1_v2` rows in `bt_runs_regime`.

## Decision

**`phase1_v3` is the canonical macro-regime classifier across the entire live
system: the `/#/regime` dashboard UI, the daily operator brief composer, every
downstream composite that joins on regime label, the live-trade router, the
drawdown framework state, and the ADR-044 health-check freshness probe.**
There is no read path under any live consumer that returns `phase1_v2` rows
as a current signal.

### Specific implications

1. **Single declaration site.** `CLASSIFIER_VERSION` in `src/server/macro_regime.ts`
   is the canonical declaration. Every consumer imports it. No consumer
   hardcodes the literal string `'phase1_v3'` in a live read path (forensic
   docstring references are explicitly permitted; archival back-references to
   `phase1_v2` in `bt_runs_regime` are explicitly permitted; live read paths
   must import the constant).
2. **Brief = UI = composites = live-trade router = drawdown = health check.**
   All these consumers read the same row set (`macro_regimes FINAL WHERE
   classifier_version = CLASSIFIER_VERSION`). The brief/UI inconsistency
   worry in GAP-8 cannot occur by construction.
3. **The active baseline is `ADR_038_BASELINE`.** `ADR_037_BASELINE` is
   archival; any live "deviation from baseline" rendering pulls
   `ADR_038_BASELINE`. The dashboard's `RegimeDistribution.baseline.source`
   field reports `'ADR-038'` (see `regime_dashboard.ts:79`).
4. **The active bias-quarantine banner is `BIAS_NOTE_PHASE1_V3`.** The dashboard
   surfaces it; the brief surfaces it via the same composer. The polarity flip
   from "biased" (v2) to "immune" (v3) is intentional and test-pinned
   (`regimeDashboard.test.ts` test #10b).
5. **A `phase2_v1` (or any future) flip changes the constant once, in one
   place.** The same downstream chain switches over atomically. No consumer
   needs a per-version branch.

### What this ADR explicitly does NOT decide

- **It does NOT freeze `phase1_v3` indefinitely.** Future work (a `phase2_v1`
  flip, a `phase1_v4` if the canon ever requires one, a per-asset-class
  classifier split) can flip `CLASSIFIER_VERSION` to a new label; this ADR
  governs *the contract that the brief + UI + composites all read the active
  classifier as a single source*, not which label is active. A flip to
  `phase2_v1` would supersede this ADR's "live classifier label = v3" claim
  but preserve the "single source of truth" architectural pin.
- **It does NOT change any threshold, indicator, or category.** ADR-041
  governs `yield_curve_inverted`; ADR-045 governs `sentiment_extreme`'s
  CBOE arm. ADR-038 governs the baseline pin. This ADR documents the live
  state without modifying it.
- **It does NOT close the Q-5 CBOE-DataShop methodology amendment.** ADR-045's
  Q-5 row in `quantlab.health_quarantine` remains operator-gated; one of the
  four resolution paths there (A/B/C/D) may revise the `sentiment_extreme`
  category contract in a future ADR, but this ADR's "v3 is canonical" claim
  is unaffected.

## Alternatives considered

- **(a) Update ADR-038 in place with the canonical-classifier policy section.**
  Rejected. ADR-038 is scoped to the *baseline pin* of the v3 classifier;
  conflating it with the broader "v3 is the live source-of-truth across the
  whole system" policy would make ADR-038's narrow technical purpose harder
  to read. Per ADR-044 §canon-foundations, separation of concerns at the ADR
  granularity supports the standing-health audit (each ADR has one decision
  to verify against). The new ADR pays a small numbering cost (ADR-046)
  for a clean factoring.

- **(b) Defer the documentation to the v3 SPEC
  (`docs/specs/macro-regime-classifier-phase1_v3.md`).** Rejected. The v3 SPEC
  documents *what* the v3 classifier does. The "v3 is canonical across brief
  + UI + composites" claim is an *architectural policy* spanning multiple
  files outside the SPEC's scope; documenting it in the SPEC would force the
  SPEC to describe its own consumers, inverting the canonical
  spec-vs-consumer boundary. The ADR is the right venue per Vector Core
  canon (RESEARCH → DESIGN → SPEC → CODE; ADRs sit above SPECs in scope).

- **(c) Document only in the `regime_dashboard.ts` module docstring without an
  ADR.** Rejected. Architectural decisions with cross-file consequences belong
  in `docs/specs/adr-*.md` per the standing convention; a docstring is the
  enforcement of the decision, not the decision itself. A future reader of
  `operator_brief.ts` (not `regime_dashboard.ts`) would miss the docstring
  but find the ADR in the decisions index. Both surfaces are updated in the
  same diff for redundancy.

- **(d) Skip the ADR entirely on the grounds that GAP-8 is "already covered
  by the v2→v3 transition history in ADR-037 + ADR-038 + the v3 SPEC."**
  Rejected. ADR-038's own Consequences section flags this exact gap:
  *"The v3 ship-and-supersede write-up never happened as a standalone ADR
  and is implicitly captured across ADR-037, this ADR, and the v3 spec
  itself. The spec note remains as historical drift; updating it is a
  separate housekeeping item."* GAP-8 is the audit's surfacing of that
  open housekeeping item. Closing it requires an explicit write-up — not
  a meta-cite of three documents that together imply the policy.

## Canon foundations

This ADR is **not canon-cited from quant literature** — the
single-source-of-truth pin is a software-engineering decision, not a
methodology one. The nearest canon analogs:

- **López de Prado, AFML §11** (selection bias / multiple testing) — applies
  to the broader v2 → v3 ramp (the bias-quarantine canon that motivated v3
  in the first place). This ADR doesn't add canon; it documents the
  consequence: once the bias-immune classifier exists, the system reads
  *only* it.
- **Pardo §3** (parameter robustness and OOS) — applies in spirit: a system
  whose brief and UI silently read different classifier versions would
  fail the "operator inspects → operator decides" feedback loop that
  Pardo's OOS discipline depends on.

These analogs justify the surrounding methodology decisions (v2 → v3 was
canon-driven); the architectural policy this ADR pins is operator-defined
discipline and is ratified as a SignalForge-specific standing pin.

## Watch-outs

- **The `'phase1_v3'` literal MUST stay confined to docstrings + archival
  back-references.** A live read path that hardcodes the literal would
  silently fail to follow a future `CLASSIFIER_VERSION` flip. The
  `scripts/tests/healthCheck.test.ts` convention pin (added in S96-67
  cycle 2) catches some of this drift; a follow-up convention pin
  enforcing "no live `'phase1_v3'` string literal in `src/server/*.ts`"
  could close it definitively (deferred — three-criterion test: low
  payoff vs maintenance cost; current grep-discoverable state suffices).
- **`BIAS_NOTE_PHASE1_V2` + `ADR_037_BASELINE` remain exported.** This is
  intentional (back-references to archived `phase1_v2` rows in
  `bt_runs_regime` + the v2 distribution test depend on them). A future
  reader who deletes them as "dead code" would break test #9a + any
  forensic v2 inspection script. The constants' docstrings mark them
  explicitly as archival; do not remove without coordinated test +
  call-site updates.
- **A `phase2_v1` flip will need to read this ADR.** When phase2 ships, the
  flip flow is: (1) write a new ADR superseding this one's "live classifier
  = v3" claim; (2) flip `CLASSIFIER_VERSION` in `macro_regime.ts`; (3) the
  brief, UI, composites, live-trade router, drawdown, health-check probe
  all switch atomically. No code edit is required outside the constant. The
  pin in `BIAS_NOTE_PHASE1_V3` becomes the new archival `BIAS_NOTE_PHASE1_V3`
  (paralleling the v2 → v3 polarity flip).
- **The audit's "regime_dashboard.ts:141 hardcodes phase1_v3" claim was
  imprecise but harmless.** The line in question is inside the
  `ADR_037_BASELINE` constant docstring referencing v2 for provenance, not
  a live read. Future reconciliation audits that grep for `'phase1_v'` in
  `src/server/*.ts` should expect docstring matches; the live read path
  uses the imported `CLASSIFIER_VERSION` symbol.

## Consequences

**Positive:**

- The GAP-8 documentation gap is closed. The audit's §6 review form
  finally has a "what closed it" line for GAP-8.
- A future reader can find the canonical-classifier policy in a single
  document instead of inferring it from three (ADR-037 + ADR-038 + v3 SPEC).
- The pre-existing "single source of truth" architecture is now explicitly
  named as a load-bearing pin, so future PRs that try to hardcode a
  per-consumer classifier version label have a written rule to violate.
- The v2 → v3 transition chronology is consolidated in one place (the §
  Context table above), reducing the cost of orientation for a new
  contributor.

**Negative:**

- ADR-046 adds a doc the orchestration must keep in sync with future
  classifier-version flips. Mitigation: the watch-out section names the
  flip flow explicitly; a phase2_v1 ADR will inherit this ADR's
  "Superseded" mark in the same PR that flips the constant.
- The historical-drift item ADR-038 acknowledged is finally closed, but
  closing it requires an ADR for a no-behavior-change documentation pin —
  a meta-cost the orchestration accepts under the GAP-8 reconciliation
  authority granted by ADR-044 + the multi-agent orchestration §6.4
  routine-resolution scope.

**Risks + mitigations:**

- **The ADR drifts from the code if a future flip happens without updating
  this ADR.** Mitigation: the cross-reference section names ADR-046 in
  `regime_dashboard.ts` module docstring; a `phase2_v1` PR that touches
  the dashboard must touch ADR-046 in the same diff or a reviewer-visible
  drift surfaces. The future watch-out also names the flip flow.
- **The "no literal `'phase1_v3'` in live read paths" rule is enforced only
  by convention.** Mitigation: deferred convention-pin test; the
  `npm run health:check` doesn't probe for it directly. If a future
  contributor inserts a literal, the worst-case is that a `phase2_v1`
  flip doesn't pick it up at one site — caught by integration testing
  on the flip PR, not silent.

## Implementation

The decision documented above is already live (since session 39, 2026-04-30).
This ADR's implementation is two diff hunks:

1. **This ADR file itself** —
   `docs/specs/adr-046-phase1_v3-as-canonical-classifier.md`.
2. **Cross-reference from `src/server/regime_dashboard.ts` module docstring** —
   one line added pointing to ADR-046 so a future reader of the dashboard
   module finds this ADR in the same context window as the
   `CLASSIFIER_VERSION` import. Module docstring header is the right surface
   (per CLAUDE.md teach-doc-protocol's "source citation at the top" pattern).

No code behavior changes. No tests change. tsc baseline (13) unchanged.
`npm run health:check` output unchanged (this ADR doesn't touch any health
probe).

## What this ADR does NOT decide (recap, for skimmers)

- Future classifier-version flips (phase1_v4 / phase2_v1) — those need their
  own ADRs.
- The Q-5 CBOE-DataShop methodology amendment — that's ADR-045 + the operator
  queue; this ADR's scope is the live source-of-truth pin, not the
  category-input window for one indicator.
- Retroactively updating ADR-038's spec-note about "ADR-038 = phase1_v3
  shipped" — that drift remains as forensic context; this ADR explicitly
  acknowledges it without altering ADR-038's text.

## Cross-references

- [`.claude/vector_core_system_prompt.md`](../../.claude/vector_core_system_prompt.md) —
  RESEARCH/DESIGN/SPEC/CODE + TEACH/PUSHBACK/HEALTH role definitions
- [`CLAUDE.md`](../../CLAUDE.md) — autonomous-execution protocol
- [`docs/architecture/multi-agent-orchestration.md`](../architecture/multi-agent-orchestration.md) —
  §6.4 routine-resolution authority (the orchestration's authority to author
  this ADR without operator gate); §8.4 Cycle 4 GAP-8 placement
- [`docs/audits/system-reconciliation-2026-05.md`](../audits/system-reconciliation-2026-05.md) —
  §6 GAP-8 (closed by this ADR)
- [`docs/specs/adr-044-standing-system-health-ownership.md`](adr-044-standing-system-health-ownership.md) —
  Phase 1 health-check probes use `CLASSIFIER_VERSION` per the pin in
  this ADR
- [`docs/specs/adr-045-phase1-v3-cboe-putcall-input-window.md`](adr-045-phase1-v3-cboe-putcall-input-window.md) —
  Q-5 CBOE input-window quarantine (operates within v3's contract; does not
  change the canonical-classifier pin)
- [`docs/decisions/README.md`](../decisions/README.md) § ADR-037, § ADR-038,
  § ADR-041 — the v2 → v3 transition record this ADR consolidates
- [`docs/specs/macro-regime-classifier-phase1_v3.md`](macro-regime-classifier-phase1_v3.md) —
  the v3 SPEC; describes the v3 classifier's *logic*; this ADR pins the
  *consumer-side architectural policy* around it
- [`src/server/macro_regime.ts`](../../src/server/macro_regime.ts) line 59 —
  the `CLASSIFIER_VERSION` declaration this ADR makes canonical
- [`src/server/regime_dashboard.ts`](../../src/server/regime_dashboard.ts) —
  module docstring updated in the same diff to cite ADR-046
- [`src/server/operator_brief.ts`](../../src/server/operator_brief.ts) line 495 —
  brief composer threading `classifierVersion: regime.classifierVersion ??
  CLASSIFIER_VERSION` through the output payload
- [`.claude/HANDOFF.md`](../../.claude/HANDOFF.md) — S96-75 lock-in entry for
  this ADR
