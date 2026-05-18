# check.md — SignalForge self-correction checklist

> **Version:** 1.1 (41 entries) · **Last updated:** 2026-05-04 · **Authority:** [MASTER.html §4.1](MASTER.html#part4)
>
> The producer applies this checklist before every artifact handoff. The critic
> agent applies it again, independently, against the producer's output. Entries
> are tagged by domain so a producer can scan only the relevant ones for the
> current task.
>
> **How to add an entry:** when a new failure mode is discovered, add a numbered
> entry under the closest domain. Bump the version counter at the top. Reference
> the entry from the ADR that motivated it (or write a new ADR if the failure
> mode isn't yet captured).

---

## FRAMING — symptom-vs-cause distinctions

Catches the 2026-05-03 incident class: a sentinel value silently collapses
multiple distinct conditions, and the diagnostic answers a right-shaped wrong
question.

- **FR-01** Before producing a diagnostic, list the symptom-vs-cause distinction
  explicitly. What is the binding mechanism, and have I verified it with a
  query before writing the fix?
- **FR-02** Does any sentinel value (zero, empty string, null) collapse multiple
  distinct conditions into one bucket? If so, name them before proceeding.
- **FR-03** If the user said "X is wrong", have I checked whether *my framing*
  of X is wrong, not just my answer? Wrong question → right-shaped answer →
  silent error.
- **FR-04** Does an OR-clause in a classification heuristic combine
  independent failure modes into one bucket? **Trigger:** classifying with
  `pred_a OR pred_b` where pred_a and pred_b indicate distinct mechanisms
  (e.g., the case_b heuristic combined `pct_data_span_zero >= 0.20` (schema
  contamination) with `pct_oos_sharpe_zero >= 0.20` (flat-OOS), conflating
  contamination with legitimate flat-OOS in cells like `volume_breakout_v1
  / mcap_nano / 1d` that had zero contamination but high flat-OOS rate).
  **Discovered:** ADR-013, 2026-05-04 P1 execution. **Fix:** report the
  AND/OR breakdown explicitly in the diagnostic; treat each clause as its
  own classification.

## STATISTICS — deflation correctness

- **ST-01** For DSR: is N (trial count) the actual number of param trials, not
  the number of cells or the number of strategies?
- **ST-02a** For PSR at strategy-level (cross-cell ranking,
  `applyLeaderboardHaircut` input): `nObservations` is **trade count**
  (Bailey-LdP 2014, §2 — Sharpe SE under iid trades). Codebase passes
  `totalTrades` here.
- **ST-02b** For HLZ T (validator-cell path, time-series Sharpe):
  `T = data_span_days × bars_per_day` — **bars**, not trades. The two paths use
  different denominators by design; do not unify them. Existing inconsistency
  is intentional but easy to misread; flag in code review.
- **ST-03** For HLZ: is the t-stat I'm correcting derived from a Sharpe whose
  underlying assumptions (iid, normal, mean-known) are checked?
- **ST-04** For PBO via CSCV: are the splits actually independent, or do
  overlapping windows leak?
- **ST-05** Have I tested on a positive control (synthetic data where the
  answer is known)?
- **ST-06** When wiring a math primitive (DSR, PBO, PSR, …) into a scoring
  path, have I enumerated its degenerate input cases (N=1, σ=0, no slices,
  no qualifying tokens) and decided per case whether degeneracy is an
  **automatic gate failure** or a **canonical reduction to a simpler
  metric**? **Trigger:** primitive's docstring says "returns 0 when X" or
  "returns null when Y" — that's the primitive admitting it has an
  undefined regime, and the call-site policy decision belongs at the
  scorer layer (with a status column to surface which path was taken),
  not silently inside the primitive. **Discovered:** ADR-015, 2026-05-04
  K-curve diagnostic. The K_dsr<2 case was reading `dsr=0` (guard) as if
  it were `dsr=0` (deflation) — same value, different verdict, ambiguous
  column. **Fix:** add a separate status column per gate's reason code
  (never overload one status column across gates — that's FR-04 again).

## BACKTEST DESIGN

- **BT-01** Is the cost model (fees + slippage + funding) honest for the venue,
  or am I assuming zero?
- **BT-02** Is the IS/OOS split done *before* the param sweep, or am I peeking?
- **BT-03** Are tokens with < 90 days of history excluded? Survivorship bias
  is the silent killer.
- **BT-04** Does the engine close positions at bar-close or bar-open? Mismatch
  produces phantom edge.
- **BT-05** Are walk-forward windows non-overlapping, or do I have look-ahead
  leakage?
- **BT-06** For cross-sectional strategies, is the rebalance schedule realistic
  (cost-aware), not assumed-instant?

## DATA INTEGRITY

- **DI-01** Are `bt_runs` rows from before/after a schema migration mixed in
  this query? `data_span_days > 0` is the modern-row filter.
- **DI-02** Does this query use `FINAL` on `ReplacingMergeTree` tables? Without
  it I see pre-merge ghosts.
- **DI-03** For bot.db-sourced rows (`source = 'botdb'`): is the cost-model
  caveat applied per ADR-005?
- **DI-04** Have I verified my count by joining the source table, not just
  trusting the aggregate?

## METHODOLOGY — canon citations

- **ME-01** Have I cited the source for any non-trivial statistical choice
  (book + chapter, or paper + section)?
- **ME-02** Am I about to invent a citation? If unsure, say "I recall a result
  like this but can't verify."
- **ME-03** Is this a Tier-3 source? If so, did I disclose it?
- **ME-04** Does any Tier-1 source actively *not* apply here (e.g., assumes
  equity, doesn't translate to 24/7 crypto)? If so, did I flag it?

## USER-COLLABORATION

- **UC-01** Am I about to skip a stage (RESEARCH → DESIGN → SPEC → CODE)?
  Refuse and name what's unresolved.
- **UC-02** Am I assuming user buy-in on a methodology choice without naming
  the alternatives?
- **UC-03** Did the user use a term incorrectly? Correct it briefly, with the
  source.
- **UC-04** Is this a load-bearing concept? Use the [TEACH] role: intuition →
  mechanism → failure mode.
- **UC-05** Drift signal: is the user proposing ML / market-switch / multi-agent
  as a substitute for finishing the current concrete task? Name the pattern.

## CODE

- **CO-01** Did I use an existing battle-tested library (`technicalindicators`,
  scipy, statsmodels), or am I reimplementing?
- **CO-02** Are silent dependencies (env var, CH table, upstream function)
  called out at the top of the diff?
- **CO-03** Did I add tests for the edge cases the spec named, not just the
  happy path?
- **CO-04** Type-check pass: `npx tsc --noEmit` clean?
- **CO-05** Test-suite pass: `npm test` green?
- **CO-06** Have I added a "what could break this" note at the bottom of any
  non-trivial new file?

## OPERATIONS

- **OP-01** Before a destructive operation (`ALTER TABLE … DELETE`, schema
  rollback, `OPTIMIZE FINAL` on a hot table), is the handoff fresh enough that
  the prior state is recoverable?
- **OP-02** Are sweep IDs idempotent so re-runs don't double-count?
- **OP-03** Is the targeted re-sweep actually targeted, or am I about to
  re-run everything?

## FORBIDDEN-CHECK — paired with the forbidden list (MASTER §4.4)

- **FB-01** Am I about to add a new strategy when the existing pipeline has
  zero survivors? Refuse.
- **FB-02** Am I about to switch markets to escape a validation problem?
  Refuse.
- **FB-03** Am I about to run a sweep without applying deflation? Refuse.
- **FB-04** Am I about to deploy live capital without paper-trade evidence?
  Refuse.

---

## Adding new entries

When a failure mode lands that no existing entry would have caught, write a
new entry. The entry:

- Goes in the closest existing domain, or in a new domain if none fits.
- Gets a domain-prefixed ID (`FR-04`, `BT-07`, etc.).
- Is phrased as a question or invariant the producer can answer **yes / no**
  in 5 seconds.
- References the ADR that motivated it (write the ADR first if needed).
- Bumps the version counter at the top of this file.

Entries are not deleted when superseded — they are marked `(superseded by
FR-NN, ADR-NNN)` so the historical reasoning stays visible.

---

## What this file is NOT

- It is **not** a test suite. Tests check that *known* code does what we
  expect. This checklist catches the *unknowns* that tests can't see — wrong
  framing, wrong question, missing citation, sentinel ambiguity.
- It is **not** a review template. Reviews benefit from it but the producer
  uses it inline, before the artifact leaves the producer.
- It is **not** exhaustive. It is the seed; new failure modes earn new entries.
