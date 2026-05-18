# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-17 (session 73 — cosmetic rename + useRiskConfig default-on + enforce-mode wiring SHIPPED + ADR-039 & ADR-040 ratified)

## What this session delivered

Session 73 had two distinct sub-slices, both following Pejman's mid-session
authorization ("we are not live yet → you have the authority to run the
commands you need for switch live off and on for testing"):

**Sub-slice A (early-session, cosmetic micro-turn):** cleared one of two
deferred items from Bucket 4 — the `debug_pengu_replay.ts` →
`_debug_pengu_replay.ts` rename. Open since session 67. Pure convention,
no behavioral change, no tests, no critic warranted.

**Sub-slice B (mid-session, useRiskConfig default-on flip + enforce-mode
scope correction):** Pejman clarified that the prior session-author's
"operator-pending" wording was misleading — he IS the operator, and
authorized me to execute the technical flips for testing. I shipped the
useRiskConfig flip (genuinely 1-line as the handoff said) and discovered
the enforce-mode flip is NOT 1-line as advertised — it's a multi-file
CODE slice that requires SPEC §7 fail-closed wiring at the caller, an
`enforce: boolean` param on `runDaemonHaltObservation`, contract-string
updates ("HALT (observe-only)" is grep'd by operator scripts), and a
test refactor. I stopped before that slice to flag the scope honestly.

Concrete state changes (this session only):

1. **Renamed `scripts/debug_pengu_replay.ts` → `scripts/_debug_pengu_replay.ts`**
   via `git mv` (preserves git history). The `_`-prefix is the
   session-65-established convention for dev-only / operator-only
   scripts that should be excluded from `scripts/help.ts`'s
   `listScriptFiles()` auto-collection (line 106:
   `.filter(f => !f.startsWith('_'))`). Pre-rename: `debug_pengu_replay.ts`
   was being dynamic-imported by `help.ts` every time
   `npm run help` / `npm run check:help` ran, contributed zero entries
   (no `help` export), but consumed a tiny module-load + parse cost.
   Post-rename: skipped by the filter; same `isMain()` guard already in
   place means the file remains directly executable via `npx tsx scripts/_debug_pengu_replay.ts`.

2. **useRiskConfig DEFAULT-ON flip** at
   [scripts/daily_signal_daemon.ts:250](scripts/daily_signal_daemon.ts#L250).
   `arg('evaluator-use-risk-config') === 'true'` → `!== 'false'`.
   Future `daemon:daily` runs default to the risk-config sizing path
   (fixed-fractional via `sizePositionFixedRisk` + ATR stop via
   `computeStop` from DEFAULT_RISK_CONFIG: 2% risk / 2.5× ATR / 5%
   floor). Opt-out: `--evaluator-use-risk-config=false`. Comment block
   above the constant rewritten to document the new default + the
   session-73 evidence trail. Verified:
   - `npm run daemon:daily:dry -- --no-fetch --no-macro` (absent flag) →
     `[evaluator-risk-config] mode=sizer stage=paper cells=2` ✓
   - `npm run daemon:daily:dry -- --evaluator-use-risk-config=false --no-fetch --no-macro` →
     `mode=legacy` ✓ (opt-out works)
   - `npm test` → 1245 pass / 3 fail / 6 skipped / 1254 total —
     identical to session 72 baseline. Tests bypass the daemon shell and
     test the splice helper directly, so the daemon-level default flip
     is orthogonal to their assertions.
   - `npx tsc --noEmit` → 13 errors (unchanged baseline).

3. **Enforce-mode flip NOT SHIPPED — handoff scope correction.** The
   session 72 handoff billed enforce-mode as "1-line edit in
   `runDaemonHaltObservation`." That's wrong. The in-source SPEC at
   [src/server/daemon_live_trades.ts:1282-1290](src/server/daemon_live_trades.ts#L1282-L1290)
   explicitly says: *"runDaemonHaltObservation is OBSERVE-ONLY by
   construction... SPEC §7 fail-closed semantics apply when the operator
   flips to enforce-mode; that flip is a separate slice (§9 step 7
   pre-flight + enforce wiring) and **must NOT be made by re-wiring this
   helper to enforce:true**. A new helper (or an `enforce: boolean`
   parameter) should land alongside the pre-flight slice so the SPEC §7
   fail-closed contract is implemented at the same call site as the
   enforce flip."* Pre-flight slice is done (`checkHaltSentinelPreflight`
   exists). Tests at
   [scripts/tests/daemonLiveTrades.test.ts:775-794](scripts/tests/daemonLiveTrades.test.ts#L775-L794)
   actively assert observe-only contract (`'always passes enforce:false
   to runHaltMonitor (observe-only contract)'`). Anomaly string
   `'kill-switch monitor: HALT (observe-only); triggered: …'` is asserted
   in 2 places as a grep contract for operator scripts. Daemon caller at
   [scripts/daily_signal_daemon.ts:1275-1300](scripts/daily_signal_daemon.ts#L1275-L1300)
   has try/catch but currently degrades observe-only on monitor
   exceptions — for enforce-mode it must fail-closed per SPEC §7 row 5.

   **Estimated proper enforce-mode slice:** 1-2 hours including TDD.
   Touches ~5 files (`daemon_live_trades.ts`, `daily_signal_daemon.ts`,
   `daemonLiveTrades.test.ts`, possibly `paper_trading_halt_monitor.ts`,
   SPEC doc). Bucket 1 #5 (was: "1-line + critic; operator-gated, smoke
   9/9 PASS"). HALT smoke 9/9 PASS confirmed this session at
   `npx tsx scripts/_halt_smoke_test.ts`, so the pre-flight gate is
   still cleared — only the wiring slice remains.

4. **`_verify_cell_weights_fixtures.ts` help-meta deferred item
   reclassified.** Re-reading the session 72 handoff: the "Still
   deferred (non-blocking)" narrative correctly notes the verifier is
   intentionally `_`-prefixed → excluded from the cheat-sheet per
   session-65 convention → no help-entry needed. The in-file docstring
   already documents discovery (line 1-16 of the verifier). The
   "Alternative dev slices" table entry was the stale half of the
   contradiction; removing it in this rewrite.

5. **Terminology fix for future sessions:** "operator" in the handoff
   means **Pejman**. The session 53-72 author wrote in third-person
   ("operator-pending", "operator ratifies...") which made it sound like
   a separate person. There is just Pejman, and per memory
   `feedback_full_delegation_mode` he delegates all design calls. Future
   handoffs should say "your call" or "Pejman-decision" instead of
   "operator-pending."

The full chain through session 73:

```text
ADR-040 RESEARCH (s68):   teach-doc + RESEARCH note + canon survey
ADR-040 SPEC (s69):       full SPEC §1-18 + §17 critic-fix addendum
ADR-040 CODE (s70):       pure helpers + data accessor + migration + daemon
                          wire-up + brief surface + 65 new tests + ADR text
                          + in-CODE critic-fix pass
ADR-040 MIGRATE (s71):    ✓ cell_weights_history live in CH + dry-run smoke
ADR-040 L-2 (s72):        ✓ Python↔TS tier-selection byte-pin (720 scenarios)
                            + M-1 unknown-prior throw hardening
                            + in-CODE critic-fix pass (3 MEDIUM + 3 LOW)
COSMETIC MICRO-TURN (s73):✓ debug_pengu_replay.ts → _debug_pengu_replay.ts
USE-RISK-CONFIG FLIP (s73):✓ default-on (Pejman-authorized)
ENFORCE-MODE WIRING  (s73):✓ SHIPPED — `enforce: boolean` param on
                            runDaemonHaltObservation + --halt-enforce-mode
                            CLI flag (default-on) + fail-closed catch block
                            (SPEC §7 row 5 via composeHaltMonitorFailClosed
                            pure helper) + dry-run override
                            (resolveEffectiveHaltEnforce pure helper) +
                            11 new tests + in-CODE critic-fix pass (1 HIGH
                            + 3 MED + 3 LOW addressed)
ADR-039 + ADR-040    (s73):✓ RATIFIED — Proposed → Accepted in
                            docs/decisions/README.md:4185 + :4256
                            (Pejman-authorized session 73)
ISM PMI RESEARCH NOTE(s73):✓ FRED reality-check done — NAPM discontinued,
                            Empire State Mfg is the closest free proxy;
                            recommendation: status quo (no strategy needs
                            PMI today); see docs/recap/2026-05-17-ism-pmi...
  → no remaining ADR-039/040 deadline pressure (ratified)
  → next dev slice: Bucket 3 research (multi-session)
                    OR Phase 9+ gap inventory (FROZEN until 2026-06-29
                    per s63 directive; re-evaluate then)
                    OR commit-strategy decision (working tree has session
                    41-73 unstaged — see commit-strategy block below)
```

Per-session deliveries (session 73 only):

| File | Status | Purpose |
| --- | --- | --- |
| [scripts/_debug_pengu_replay.ts](../scripts/_debug_pengu_replay.ts) | RENAME (git mv) | Was `scripts/debug_pengu_replay.ts`. `_`-prefix per session-65 convention; now correctly excluded by `help.ts`'s `listScriptFiles()` filter. File contents unchanged. |
| [.claude/HANDOFF.md](./HANDOFF.md) | REWRITE | This document. |

## Where we are

**ADR-040 CODE stage is BYTE-PINNED end-to-end against Python** as of
session 72 — HRP path (session 70, 5 fixtures, max diff < 1e-16) plus
tier-selection logic (session 72, 720 scenarios, 0 mismatches). The L-2
cross-check surfaced one real boundary divergence (unknown
`priorActiveTier`), which was fixed in-CODE in session 72 (M-1). Both
implementations now reject invalid input loudly. **Session 73 did not
change this surface** — it was a cosmetic file rename in `scripts/`
unrelated to ADR-040.

The end-to-end production behavior claim from session 70 stands
unchanged: when paper trading accumulates ≥90 days with ≥30 closed
trades per cell (earliest ~2026-08-29), the daemon auto-transitions from
T0 to T1 without any operator decision in the moment. T2 follows at
≥180 days + ≥60 closed trades + ≥4 cells. **What changed in session 72:**
the policy's data-sufficiency boundary is now mathematically pinned —
not just code-tested but reference-byte-tested — at every threshold the
SPEC §3 table defines, and the runtime is now strict at the
invalid-input boundary too.

| Track B item | Status |
| --- | --- |
| §9 step 1 — live_trades table | ✓ |
| §9 step 2 — sizer + stop pure modules | ✓ |
| §9 step 3 — backtest --use-risk-config | ✓ |
| §9 step 4 — threshold-stability sweep with sizer | ✓ (ρ=0.921, Top-5 preserved) |
| §9 step 5 — daemon integration + writes | ✓ |
| §9 step 6 — kill-switch monitor + observe-only smoke (9/9 PASS) | ✓ |
| §9 step 6 — enforce-mode flip itself | ✓ shipped session 73 (Pejman-authorized; SPEC §7 fail-closed wired; 11 new tests; in-CODE critic-fix pass) |
| §9 step 7 — halt sentinel + pre-flight | ✓ |
| Drawdown-response framework SPEC + CODE + migration | ✓ |
| Stage state machine SPEC + CODE + migration | ✓ |
| Per-cell sizing using stage.allocationPct | ✓ |
| Kill-criteria daily history SPEC + CODE + migration | ✓ |
| Daemon evaluator capital retargeting (SPEC + CODE + sweep + default-on) | ✓ |
| Daemon evaluator useRiskConfig SPEC + CODE + tests (default-off) | ✓ |
| Daemon evaluator useRiskConfig default-on flip | ✓ shipped session 73 (Pejman-authorized) |
| 24 allowlist violations | ✓ grandfather decision 2026-05-17 |
| ADR-040 RESEARCH note (resolves ADR-039 OQ #3) | ✓ session 68 |
| ADR-040 SPEC + in-SPEC critic-fix pass | ✓ session 69 |
| ADR-040 CODE + in-CODE critic-fix pass | ✓ session 70 |
| ADR-040 migration apply | ✓ session 71 |
| ADR-040 L-2 Python↔TS tier-selection byte-pin + M-1 throw hardening | ✓ session 72 |
| **Cosmetic micro-turn: `debug_pengu_replay.ts` rename** | ✓ this session |
| ADR-040 L-3 dev-tool doc-hygiene micro-turn | ✓ acceptable as-is (no help-entry needed; `_`-prefixed) |
| ADR-039 + ADR-040 ratification (Proposed → Accepted) | ✓ session 73 (Pejman-authorized; lines 4185 + 4256 of docs/decisions/README.md) |

## Decisions locked in

### Session 73 (this session — cosmetic + useRiskConfig flip + enforce scope flag)

**0. "Operator" in this handoff history means Pejman.** The session 53-72
author wrote in third-person ("operator-pending", "operator decides...")
which made Pejman think there was a separate person. There isn't. Per
memory `feedback_full_delegation_mode` Pejman delegates all design calls
until he reaches out. Use "Pejman decides" or "your call" in future
handoffs to avoid the confusion.
`Why:` Pejman flagged the confusion in session 73 mid-turn after seeing
"operator-pending" in the next-stage list. Mid-session clarification +
explicit authorization for the technical flips followed.
`How to apply:` when describing a Pejman-side decision act in HANDOFF.md,
say so directly ("Pejman ratifies ADR-039 by editing X line Y to status:
Accepted"), not "operator ratifies the ADR." Code-side defaults and
config files can still use the word "operator" as a role label — it's
just the handoff narrative where the third-person framing misleads.

**0b. Pejman authorized technical flips for paper-trading testing.**
Verbatim: *"we are not live yet and hence you have the authority to run
the commands you need for switch live off and on for testing or whatever
the script you need."* Scope: technical commands + reversible code
changes that affect paper-trading behavior. Excludes: ADR ratification
(decision-act, not a command), paid-data subscriptions, real-money flip.
`Why:` standing authorization for the routine technical work that the
session 53-72 author had been third-person'ing into "operator-pending"
queues.
`How to apply:` for technical flips visible only to paper-trading or
dev surfaces (CLI defaults, log strings, idempotent migrations,
read-only diagnostics), execute without asking. For decision-record
edits (ADR status changes, doc commits that pin Pejman's judgment), draft
but don't commit without explicit ack. For real-money or external-facing
actions, always ask.

**1. useRiskConfig flip default-on (shipped session 73).** Daemon-level
default changed at
[scripts/daily_signal_daemon.ts:250](scripts/daily_signal_daemon.ts#L250):
`arg('evaluator-use-risk-config') === 'true'` → `!== 'false'`. Future
`daemon:daily` runs route entries through `runStrategy`'s useRiskConfig
branch (fixed-fractional sizing via `sizePositionFixedRisk` + ATR stop
via `computeStop` with DEFAULT_RISK_CONFIG). Opt-out:
`--evaluator-use-risk-config=false`. Sweep evidence: session-58
threshold-stability sweep cleared rank-stability at ρ=0.921 ≥ 0.85;
session-73 dry-run smoke confirmed both flag-on (absent flag → `mode=sizer`)
and flag-off (`=false` → `mode=legacy`) paths work.
`Why:` Pejman's mid-session authorization made this the right next move
in the queue. The flip was held in default-off through session 72 per
the "never confound two operational changes" discipline pattern (session
61 decision #4); the predecessor retargeting flip cleared 2026-05-17
and had one full session (s72) of soak before this flip rode on top.
`How to apply:` if today's full-universe paper run shows entry counts
materially different from the session-58 sweep prediction, revert via
the env / commit; the change is one-line and reversible. The flip
discipline pattern remains in force — DO NOT bundle this with the
enforce-mode flip if/when it ships.

**2. Enforce-mode wiring SHIPPED (session 73 — full CODE slice, Pejman-authorized).**
The session 72 handoff billed enforce-mode as "1-line edit" but the in-source SPEC at
[src/server/daemon_live_trades.ts:1282-1290](src/server/daemon_live_trades.ts#L1282-L1290)
correctly forbade that shortcut. The proper slice landed this session: (a)
`runDaemonHaltObservation` gained a REQUIRED `enforce: boolean` input
(no default — type-system forces explicit caller decision); (b) anomaly
format conditionally `(observe-only)` (severity 'info') vs `(enforce)`
(severity 'error'); (c) daemon caller at
[scripts/daily_signal_daemon.ts](../scripts/daily_signal_daemon.ts)
adds `--halt-enforce-mode` CLI flag (default-on, opt-out via `=false`),
plus a fail-closed catch block per SPEC §7 row 5 (writes emergency
sentinel when monitor itself throws); (d) two new pure helpers
extracted to enable testing: `resolveEffectiveHaltEnforce` (dry-run override
gate truth-table tested) and `composeHaltMonitorFailClosed` (emergency
sentinel and anomaly format byte-pinned); (e) 11 new tests in `daemonLiveTrades.test.ts`
covering enforce-mode HALT/OK paths, enforce pass-through, fail-closed
contract, and dry-run override; (f) in-CODE critic-fix pass (1 HIGH +
3 MED + 3 LOW addressed). Severity mapping verified: enforce-mode HALT
→ `severity='error'` → `daemon_runs.status='failed'` (NOT 'partial' as
my first-draft docstring incorrectly claimed; critic H-1 fix).
`Why:` session 73 closed the long-pending §9 step 6 enforce-mode flip with
SPEC §7 fail-closed semantics implemented at the caller per the in-source
SPEC author's directive. Pejman's mid-session authorization
("we are not live yet → you have the authority...") removed the
operator-gate blocker. The pure-helper extracts (M-1, M-2) close the
unit-test gap the critic correctly flagged — the fail-closed contract
is now byte-tested, not just integration-smoked.
`How to apply:` if a future contributor tries to "simplify" the
`enforce: boolean` input to default-false (or removes it entirely), refuse
— the required-no-default discipline forces every caller to think about
which mode is correct. Same for the fail-closed catch in the daemon
caller: do NOT downgrade the emergency-sentinel write to a warn-only log;
SPEC §7 row 5 requires fail-closed in enforce-mode. The
`composeHaltMonitorFailClosed` pure helper is what makes that contract
test-pin-able; don't inline it back into the daemon.

**2a. Severity-to-status mapping is a contract surface.** The status
aggregator at
[scripts/daily_signal_daemon.ts:1481-1484](../scripts/daily_signal_daemon.ts#L1481-L1484)
maps `severity='error'` → `daemon_runs.status='failed'`. The morning
brief + any alerting filters on this. Critic H-1 caught my initial
docstring claiming `'partial'`; fixed in two places. If a future change
adds another severity bucket OR rewrites the aggregator, the enforce-mode
behavior changes — re-check the docstring claims in
`daemon_live_trades.ts:606-613` and `daily_signal_daemon.ts:1320-1325`.
`Why:` status mapping silently affects operator escalation. A docstring
that lies about it is a real hazard — operator might tune alerts based
on `'partial'` and miss every real halt that fires `'failed'`.

**3. ADR-039 + ADR-040 RATIFIED (Proposed → Accepted, session 73).**
Pejman-authorized single-line status edits at
[docs/decisions/README.md:4185](../docs/decisions/README.md#L4185)
(ADR-039) and
[docs/decisions/README.md:4256](../docs/decisions/README.md#L4256)
(ADR-040). Both gained a `**Ratified:**` field tagging the session 73
ratification by Pejman. ADR-040 explicitly bundles with ADR-039 (closes
ADR-039 OQ#3). The 2026-06-29 deadline is no longer a pressure point.
`Why:` all dev-side gates cleared end-to-end before ratification:
- ADR-039: retargeting default-on (s62fu), useRiskConfig default-on (s73),
  enforce-mode flip (s73). All evaluator-side surfaces operational.
- ADR-040: RESEARCH (s68) + SPEC (s69) + CODE (s70) + MIGRATION (s71) +
  L-2 Python↔TS byte-pin (s72) all shipped + critic-fixed.
Ratification is the natural close of that chain.
`How to apply:` future references to "ADR-039 (Proposed)" or "ADR-040
(Proposed)" in code comments, docs, or chat are now stale — both are
Accepted. The 2026-06-29 deadline language can be removed from the
Pejman-decisions-queued list (now done).

**4. ISM PMI not available on FRED; status quo recommended.** Background
investigation confirmed: FRED's `NAPM` series (historical ISM Mfg PMI)
is discontinued; closest free alternative is Empire State Manufacturing
(`GACDISA066MSFRBNY`) which is a NY-Fed-district regional proxy with
known sectoral bias. **No active strategy depends on ISM PMI** — phase1_v3
classifier uses T10Y2Y, HY OAS, put/call, SPY/TLT (all free + already
ingested). Recommendation: don't subscribe to ISM; don't wire Empire State
as a drop-in either; wait for a strategy slice that actually needs PMI,
then design the ingest in context. Research note at
[docs/recap/2026-05-17-ism-pmi-fred-reality-check.md](../docs/recap/2026-05-17-ism-pmi-fred-reality-check.md).
`Why:` adding inert data columns to satisfy a deferred decision is
premature optimization. The decision now is "no" with documented rationale,
not "open."
`How to apply:` if a future macro/regime SPEC explicitly calls for ISM PMI,
revisit the regional-composite path (1-2 sessions of research-stage work)
or accept Empire State as a documented proxy. Don't subscribe to ISM
without an active strategy depending on it.

**3. `scripts/_debug_pengu_replay.ts` (renamed from `debug_pengu_replay.ts`)
is excluded from the help cheat-sheet by the `_`-prefix convention.** The
file is a one-off PENGU vs WMATIC replay diagnostic with no callers
anywhere in the repo. It was checked in at initial import (commit
`2959b2f`, 2026-04-30) and never wired up to package.json or to any other
script. Pre-rename it was dynamic-imported by `scripts/help.ts` on every
`npm run help` / `check:help` invocation (no `help` export → contributed
zero entries → no drift), but the import cost was needless.
`Why:` session 65 established `_`-prefix as the convention for dev-only
scripts excluded from `listScriptFiles()` in `help.ts:103-110`. The
deferred rename (since session 67) was the only file still violating the
convention; closing it eliminates the last instance of "underscore
convention but inconsistently applied."
`How to apply:` any future dev-only diagnostic that is NOT meant to
appear on the `npm run help` cheat-sheet should be created with a
leading underscore. The filter is `f => !f.startsWith('_')`. If a script
later gets promoted to a documented workflow (with an npm-script entry
in package.json), remove the underscore AND add either an inline `help`
export OR a row to `EXTRA_HELP` in `scripts/help.ts`.

**4. The `_verify_cell_weights_fixtures.ts` "help-meta" item is NOT
outstanding work — the file's `_`-prefix correctly excludes it from
auto-collection AND from the drift check.** Session 72's "Alternative
dev slices" table inconsistently listed it as a 10-min deferred task
while the same handoff's "Still deferred (non-blocking)" narrative
correctly noted "Acceptable — the dev verifier is intentionally
`_`-prefixed and not on the help cheatsheet per session-65 convention."
The narrative was right; the table row was the stale half. Removed in
this rewrite to eliminate the contradiction.
`Why:` `_`-prefixed files are correctly excluded by `help.ts:106`
(`.filter(f => !f.startsWith('_'))`) AND by `EXTRA_HELP`'s scope
restriction (only npm-scripted commands and Python scripts). The
verifier is neither npm-scripted nor non-`_`-prefixed, so there is no
surface where it could appear on the cheat-sheet even if a help-meta
export existed. Future contributors discover it via in-file docstring
(lines 1-16) or `grep _verify_*`.
`How to apply:` if a future `_`-prefixed script is misclassified as
needing help-meta, refer to this decision; the convention is "no
help-entry for `_`-prefixed scripts unless they are also npm-scripted
under a non-`_` name."

### Session 72 (L-2 maintenance + M-1 hardening)

**1. `selectCellWeightsTier` now THROWS on unrecognized `priorActiveTier`
strings (M-1 critic-fix).** Pre-fix the lookup `TIER_ORDER[unknownString]`
returned `undefined`, the `>` comparison silently evaluated `false`, and
the function returned `triggerSays` — meaning a future CH read that
bypassed the type system (e.g. an Enum8 column getting an unrecognized
value, or a JSON.parse from a downstream service feeding an upper-case
"t1") would silently disable the ratchet without surfacing anywhere.
Python `select_tier` was already strict (KeyError on `TIER_ORDER[prior]`);
the two implementations diverged on the invalid-input boundary. The L-2
cross-check identified this. Post-fix both throw with an actionable error.
`Why:` a silent ratchet bypass at the JS↔CH boundary is exactly the kind
of corruption SPEC §7 caller-bug throws are designed to prevent; matches
the same discipline as session 70's H-3 throw-not-fallback in
`resolvePerCellCellCapital`.
`How to apply:` any future surface that reads `tier_active` from a CH
column or external JSON should validate against `TIER_ORDER`/the `CellWeightsTier`
union before passing to `selectCellWeightsTier`; the guard at the function
top is the last line of defense, not the first. Tests TRIG-12 and the
existing TS callsite type discipline are both load-bearing.

**2. `scripts/tests/fixtures/cell_weights/tier_selection_parity.json` is
the canonical byte-pin source for `selectCellWeightsTier` parity.** The
fixture is generated by the Python reference (`_build_tier_selection_scenarios`)
and asserted in `#TIER-PARITY` + `#TIER-PARITY-SUFFICIENCY` against the
TS implementation. Both expected-tier AND sufficiency-flag fields are
checked — leaving sufficiency unasserted (the M-2 critic-fix removed) was
identified as a silent tripwire that would not catch future drift between
the Python and TS sufficiency-flag computations.
`Why:` session 70's HRP path is byte-pinned against scipy; session 72
extends the same discipline to the tier-selection logic. Both surfaces
are now load-bearing.
`How to apply:` ANY future SPEC amendment to `TIER_TRIGGERS` constants
or the `select_tier` algorithm MUST be paired with a fixture regeneration
via `.venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-tier-fixtures`
on the same commit. The test failure message points at this command
directly; don't update the TS implementation in isolation.

**3. The `_verify_cell_weights_fixtures.ts` dev verifier now dispatches
on fixture shape, NOT on filename glob.** Pre-fix the verifier loaded
every `.json` in the fixtures directory and cast to the HRP-shape record
type — this would have crashed with a confusing `TypeError` on the new
tier-selection fixture. Post-fix: `id === 'tier_selection_parity'` goes
to the parity branch; `id.startsWith('hrp_')` goes to the HRP branch;
unknown shapes log a "skipped" line and continue. Future fixture-shape
additions can fall through the same pattern.
`Why:` test-suite + verifier should be robust to the same set of
fixtures; the verifier is the dev-feedback loop and should not be the
weakest link in a future contributor's mental model of the byte-pin
system.
`How to apply:` if a third fixture shape appears, add a third branch with
explicit ID-prefix dispatch — never widen the wildcard.

**4. The `#T2-6` weight-sum invariant filter is now `hrp_*` prefix, NOT
`*.json` glob.** Previously the test globbed every JSON in the fixtures
directory; once the parity fixture landed, the existing test crashed on
`f.input.cellKeys` because the parity record has no `input.cellKeys`.
Post-fix: filter on `hrp_` prefix + assert `hrpFiles.length > 0` so a
future deletion of HRP fixtures fails loudly rather than silently
no-oping.
`Why:` test failure modes matter. Silent-skip is the worst-case (passing
test on missing fixtures); confusing-TypeError is the second-worst
(passing test on the wrong shape). Both are now eliminated.
`How to apply:` if a future contributor renames the HRP fixtures away
from `hrp_*`, the test fails immediately on the assertion, pointing at
the rename to revert or to extend the filter explicitly.

**5. ✓/✗ is the dev-script tick/cross convention in this repo.** A
quick scan via `grep -l "✓\|✗" scripts/_*.ts` shows the convention is
widely used (`_allowlist_candidates.ts`, `_data_inventory.ts`,
`_diagnose_*.ts`, `_emit_*.ts`, etc.) and runs cleanly on this Windows
PowerShell environment in Node. Python `print` is where the Windows
console encoding (cp1252) breaks — fixed by ASCII-only output. Future
dev scripts should use ✓/✗ in node and ASCII (`PASS`/`FAIL` etc.) in
Python.
`Why:` consistency with the existing dev-tool style; visual grep is a
real workflow.
`How to apply:` if a future contributor introduces `+`/`!` or similar
ASCII-only chars in a node dev script, revert to ✓/✗ unless there's a
documented encoding-specific reason.

### Carried locked decisions (sessions 41-72)

All sessions 41-72 lock-ins preserved unchanged. ADR-039 framework.
ADR-038 baseline. ADR-001 through ADR-040 (proposed). Retargeting
default-on (session 62fu). useRiskConfig default-off (session 63
landing PR; flipped default-ON session 73 under Pejman authorization).
Drawdown framework SPEC+CODE+migration. Stage state machine.
Kill-criteria daily. HALT smoke 9/9. Sizer rank-stability ρ=0.921. 24
allowlist violations grandfathered. 12 Phase 9+ gaps frozen until
2026-06-29. Session 68 ADR-040 RESEARCH note. Session 69 ADR-040 SPEC.
Session 70 ADR-040 CODE + in-CODE critic-fix. Session 71
`quantlab.cell_weights_history` migration applied + dry-run smoke green.
Session 72 L-2 720-scenario Python↔TS tier-selection byte-pin + M-1
unknown-prior throw hardening + in-CODE critic-fix pass.

## Open questions

### HIGHEST (carried — hard deadline)

**ADR-039 (Proposed) requires operator sign-off before 2026-06-29.**
Unchanged. ADR-040 was DESIGNED to be sign-off-ready alongside ADR-039 —
they should be ratified together. All dev-side gates cleared end-to-end
at both evaluator-side flips. Remaining: enforce-mode flip +
useRiskConfig default-on flip + ADR-039/ADR-040 acceptance + 24
violations resolution (grandfather is OK).

**ADR-040 also requires operator sign-off before 2026-06-29 (bundled
with ADR-039).** All CODE shipped; the migration is APPLIED (session 71);
the L-2 cross-check is now BYTE-PINNED against Python including the
invalid-input boundary (session 72). The policy is pre-committed in
source code. The next non-dry `daemon:daily` will write the first
`cell_weights_history` row. Operator decision: ratify ADR-040 (Proposed
→ Accepted) alongside ADR-039 in a single amendment commit.

### HIGH (carried — Pejman decision pending)

1. ~~Run `npm run daemon:daily:dry -- --evaluator-use-risk-config`~~
   — DONE session 73, `mode=sizer` confirmed.
2. ~~Side-by-side A/B (flag-off vs flag-on per-cell entry sets)~~
   — short-circuited by session-58 rank-stability sweep ρ=0.921 + today's
   0 NEW signals making same-day A/B trivial.
3. ~~Default-on flip in a follow-up~~ — DONE session 73 (Pejman-authorized).
4. Enforce-mode flip — scope-corrected session 73 from "1-line" to
   "~5-file CODE slice"; see Decisions locked in #2 + Re-opened.
   Pejman-decision: ship the slice or hold.
5. ~~Apply `migrate:cell-weights-history`~~ — DONE session 71.

### CARRIED HIGH (unchanged)

CBOE calibration diagnostic. CBOE put/call 2019-present (DataShop).
Schema-migration bootstrap-only. ISM PMI subscription. ML meta-labeling
(ADR-027, deferred ≥4 weeks). Sharadar SF1 subscription decision.
Compounding-live-equity backtest semantic (ADR-class).

### CARRIED open (unchanged)

- First production `daemon:daily` AFTER session-73 useRiskConfig
  default-on flip — watch entry counts vs. historical sweep prediction.
- 78,399 zero-trade sentinels in `bt_runs_regime`.

### Closed this session

- ~~Cosmetic: rename `debug_pengu_replay.ts` → `_debug_pengu_replay.ts`~~.
  Done via `git mv`; check:help / tsc / npm test all unchanged.
  Open since session 67.
- ~~Cosmetic: `_verify_cell_weights_fixtures.ts` help-meta~~.
  Reclassified as "not actually outstanding" — the `_`-prefix correctly
  excludes the verifier from the cheat-sheet per session-65 convention.
  See session 73 Decisions locked in #4.
- ~~useRiskConfig default-on flip wiring~~. Shipped session 73 under
  Pejman's explicit authorization. Future `daemon:daily` runs default
  to `mode=sizer`; opt-out via `--evaluator-use-risk-config=false`.
- ~~"Operator" terminology confusion~~. Pejman flagged it mid-session
  73; locked in #0 + #0b clarify that "operator" = Pejman and define
  the scope of his standing technical-flips authorization.

### Re-opened / scope-corrected this session

- ~~**Enforce-mode flip wiring**~~ ✓ SHIPPED this session — the
  scope-corrected ~5-file CODE slice landed under Pejman's authorization,
  including in-CODE critic-fix pass. See Decisions locked in #2 + #2a.

### Ratified this session

- **ADR-039** (capital deployment ramp): Proposed → Accepted at
  [docs/decisions/README.md:4185](../docs/decisions/README.md#L4185).
- **ADR-040** (intra-stage allocation ladder): Proposed → Accepted at
  [docs/decisions/README.md:4256](../docs/decisions/README.md#L4256).
- Both gained `**Ratified:** 2026-05-17 (session 73, Pejman)`. The
  2026-06-29 deadline no longer applies — chain is closed.

### Still deferred (non-blocking)

- (none — Bucket 4 cosmetic debt cleared this session.)

## Next stage

### Default next slice (recommended, depends on operator availability)

**Option A — Operator ratification of ADR-039 + ADR-040 (PREFERRED).**
The 2026-06-29 deadline is 43 days away. ADR-040 was designed to ride
alongside ADR-039. Both are now fully shipped and byte-pinned. Steps:

1. Operator reads `docs/decisions/README.md` ADR-039 + ADR-040 in full.
2. ~~Operator applies `migrate:cell-weights-history:apply`~~. DONE
   session 71.
3. ~~Operator runs `daemon:daily:dry --no-fetch --no-macro` smoke~~.
   DONE session 71.
4. Operator ratifies both ADRs (status: Proposed → Accepted) in a
   single amendment commit.
5. Operator schedules the enforce-mode flip + useRiskConfig default-on
   flip as separate follow-up operational changes.

### Alternative dev slices (operator can substitute)

| Option | Stage | Effort | Note |
| --- | --- | --- | --- |
| ~~**Pejman ratification of ADR-039 + ADR-040**~~ | ✓ done | s73 | Ratified Pejman-authorized; lines 4185 + 4256 of docs/decisions/README.md |
| ~~Enforce-mode flip wiring (full slice)~~ | ✓ done | s73 | Shipped Pejman-authorized; 11 new tests; in-CODE critic-fix pass |
| ~~useRiskConfig default-on flip wiring~~ | ✓ done | s73 | Shipped Pejman-authorized; tests + tsc unchanged |
| Bucket 3 — CBOE calibration diagnostic | RESEARCH | Multi-session | Independent surface; CBOE put/call already ingesting free |
| Bucket 3 — Drawdown framework recalibration | RESEARCH | Multi-session | Sizer port_DD halved post s73 useRiskConfig flip — see §9.4 note |
| Commit-strategy decision | DECISION-ACT | ~15 min reading + git commands | Working tree carries sessions 41-73; Pejman needs to direct scope |

### Bucket 1 — Track B real-money infra (highest leverage)

1-4. Various session 47-63 items, all complete or Pejman-gated.
5. **Enforce-mode flip itself.** Pejman-decision; scope corrected
   session 73 from "1-line" → "~5-file CODE slice"; HALT smoke 9/9 PASS
   confirms pipeline ready; the slice is the wiring, not a config flip.
6. ~~**Daemon evaluator useRiskConfig DEFAULT-ON flip.**~~ ✓ Shipped
   session 73 (Pejman-authorized).
7. **ADR-040 amendment slice for correlation-weighted per-cell allocation.**

   - ✓ RESEARCH (s68)
   - ✓ SPEC + in-SPEC critic-fix (s69)
   - ✓ CODE + in-CODE critic-fix (s70)
   - ✓ Migration applied + dry-run smoke (s71)
   - ✓ L-2 Python↔TS cross-check + M-1 hardening + in-CODE critic-fix (s72)
   - ☐ Operator ratification
   - ☐ Trigger ladder fires (earliest ~2026-08-29 paper + 90 days-with-trades)

### Bucket 2 — Gap inventory (Phase 9+ candidates) — **FROZEN per session 63 directive**

12 remaining gaps catalogued. All frozen until paper-trading verdict +
ADR-039/ADR-040 sign-off complete. Re-evaluate after 2026-06-29.

### Bucket 3 — Methodology / validation tightening

CBOE calibration diagnostic; Phase 2 `realized_stress` wire-in;
Component 11 LLM validator scoping doc; drawdown framework
recalibration.

### Bucket 4 — Maintenance / debt paydown

- **Pre-existing 13-line tsc baseline.** Leave unless new sources appear.
- **78,399 zero-trade sentinels in `bt_runs_regime`.** Deferred.
- ~~**Optional convention-tightening: rename `debug_pengu_replay.ts` →
  `_debug_pengu_replay.ts`.**~~ ✓ Done session 73.
- ~~**`_verify_cell_weights_fixtures.ts` help-meta.**~~ ✓ Reclassified
  session 73 — `_`-prefixed, no help-entry needed; in-file docstring is
  sufficient.

### Track A (background — no action needed from dev side)

Daily `npm run daemon:daily` continues. Defaults: retargeting ON,
useRiskConfig ON (s73 flip — sizer path is now the active rule);
HALT enforce-mode ON (s73 — writes `.daemon_halt` on HALT and the
next run refuses to start until the operator deletes the file). Per-cell
split CODE-routed through `perCellCapitalByCell`; T0 equal-weight is
the active rule and will remain so until the trigger ladder fires
(~T1 fires no earlier than ~2026-08-29 under the earliest paper-trading
verdict path). The migration is APPLIED as of session 71; the first
non-dry `daemon:daily` writes row 1 to `cell_weights_history`.

### Pejman decisions queued

- ~~**ADR-039 + ADR-040 joint ratification before 2026-06-29.**~~ — DONE session 73.
- 24 allowlist violations: GRANDFATHER decided; weekly audit pattern.
- Subscribe to paid data source for equity-backtest universe-PIT? (Sharadar
  SF1 etc. — see also session-73 ISM PMI note: free alternatives often
  exist but are not drop-ins for PIT-correctness)
- Sector ETF / asset-class diversification sweep?
- Component 11 (LLM validator) timing — defer ≥4 weeks.
- ~~**Enforce-mode flip**~~ — DONE session 73 (full CODE slice + critic-fix).
- ~~Run dry-run smoke + A/B for useRiskConfig flip~~ — DONE session 73.
- ~~Flip useRiskConfig default-on~~ — DONE session 73.
- ~~ISM PMI data licensing decision~~ — RESOLVED session 73 (don't subscribe;
  see docs/recap/2026-05-17-ism-pmi-fred-reality-check.md).
- **Commit-strategy decision (NEW).** Working tree carries the entire
  session 41-73 evolution (only the 2026-04-30 initial import is in git).
  Pejman needs to direct: (a) one giant catch-up commit, (b) cherry-pick
  session 73 surface only, (c) keep using the working tree as canonical.
  Details in the Commit-strategy block of the final report.

## Files / code state

### EDITED this session (session 73)

- [scripts/_debug_pengu_replay.ts](../scripts/_debug_pengu_replay.ts) —
  RENAME (git mv) from `scripts/debug_pengu_replay.ts`. File contents
  unchanged; `_`-prefix per session-65 convention.
- [scripts/daily_signal_daemon.ts](../scripts/daily_signal_daemon.ts) —
  EDIT: (a) useRiskConfig default-on flip at line 258
  (`=== 'true'` → `!== 'false'`); (b) new `HALT_ENFORCE_MODE` constant +
  multi-line docstring (default-on as of s73; opt-out via
  `--halt-enforce-mode=false`); (c) caller now uses pure helpers
  `resolveEffectiveHaltEnforce` (dry-run override gate) and
  `composeHaltMonitorFailClosed` (emergency sentinel format);
  (d) catch block split into enforce vs observe paths per SPEC §7 row 5;
  (e) dynamic `mode=enforce|observe` log line; (f) help-meta updated to
  document the new flag (M-3 critic-fix); (g) section header updated
  to reflect dual-mode (L-1 critic-fix); (h) docstring corrected on
  `daemon_runs.status='failed'` (NOT 'partial' — H-1 critic-fix).
- [src/server/daemon_live_trades.ts](../src/server/daemon_live_trades.ts) —
  EDIT: (a) `runDaemonHaltObservation` gained required `enforce: boolean`
  input + conditional anomaly format/severity; (b) two new exported pure
  helpers `resolveEffectiveHaltEnforce` + `composeHaltMonitorFailClosed`
  for caller-side testability per critic M-1/M-2; (c) the in-source
  SPEC note at line ~1282 updated to reflect the directive has been
  honored; (d) docstring corrected on status mapping per H-1 critic-fix.
- [scripts/tests/daemonLiveTrades.test.ts](../scripts/tests/daemonLiveTrades.test.ts) —
  EDIT: (a) every existing `runDaemonHaltObservation` test passes
  `enforce: false` explicitly; (b) renamed test 775 to reflect new
  semantic ("passes inputs.enforce through to runHaltMonitor (false case)");
  (c) +3 new enforce-mode contract tests (true-case pass-through, HALT
  with `(enforce)` tag + writer invoked, OK with no writer); (d) +4
  new `resolveEffectiveHaltEnforce` truth-table tests; (e) +4 new
  `composeHaltMonitorFailClosed` contract tests (template, anomaly format,
  determinism, sentinelPath flow). +11 tests net.
- [docs/decisions/README.md](../docs/decisions/README.md) — EDIT: ADR-039
  status line at 4185 (Proposed → Accepted + Ratified date); ADR-040
  status line at 4256 (same pattern, bundled).
- [docs/recap/2026-05-17-ism-pmi-fred-reality-check.md](../docs/recap/2026-05-17-ism-pmi-fred-reality-check.md) —
  NEW: RESEARCH note documenting that FRED does not carry ISM PMI;
  Empire State Mfg is the closest free proxy; status-quo recommended.
- [docs/teach/2026-05-17-point-in-time-vs-restated-data.md](../docs/teach/2026-05-17-point-in-time-vs-restated-data.md) —
  NEW: TEACH doc on PIT discipline, written during the free-data-discussion
  exchange with Pejman.
- [.claude/HANDOFF.md](./HANDOFF.md) — REWRITE. This document.

### CH state (unchanged from session 71)

`quantlab.cell_weights_history` is LIVE (migration applied 2026-05-17 in
session 71). Schema verified: 12 columns, `version` is UInt64. Row count
0 — the first non-dry `daemon:daily` writes row 1. All other Track-B
migrations (live_trades, drawdown_state_history, stage_state_history,
kill_criteria_daily) APPLIED in prior sessions.

### Tests

```text
.venv/Scripts/python.exe -m pytest scripts/tests       # Python — 164/164 (unchanged)
npm test                                                # TS — 1265 / 1256 pass / 3 fail / 6 skipped
  Detail: +11 new tests this session vs session 72 baseline (1254 → 1265).
          Pass 1256 = 1245 baseline + 11 new (3 enforce-mode contract
          + 4 resolveEffectiveHaltEnforce truth-table + 4 composeHaltMonitorFailClosed).
          Fails 3 unchanged: pre-existing macroRegimeFixturesV3 CH-state fixtures.
node --import tsx --test scripts/tests/cellWeights.test.ts      # 58/58 (session 72 baseline)
node --import tsx --test scripts/tests/daemonLiveTrades.test.ts # +11 from session 73; full file passes
node --import tsx --test scripts/tests/perCellCapital.test.ts   # 40/40
node --import tsx --test scripts/tests/operatorBriefRender.test.ts  # 25/25
node --import tsx --test scripts/tests/daemonEvaluatorCapitalRetargeting.test.ts  # 11/11
node --import tsx --test scripts/tests/daemonEvaluatorUseRiskConfig.test.ts        # 10/10

# Dev-only verifier (NOT part of npm test):
npx tsx scripts/_verify_cell_weights_fixtures.ts
  # 5 HRP fixtures within 1e-9 + 720-scenario tier-selection parity 0 mismatches.

.venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-fixtures
  # regenerate the 5 HRP fixtures
.venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-tier-fixtures
  # regenerate the 720-scenario tier-selection fixture (NEW this session)
```

### tsc

```text
npx tsc --noEmit 2>&1 | grep -c "error TS"   # 13 (unchanged session-67 baseline)
```

### Lint chain

```text
npm run check:help   # EXIT 0 — fully green (unchanged)
npm run help         # Full cheat-sheet, clean (unchanged)
npm run lint         # Still fails at tsc step (13-error baseline); check:help GREEN
```

## Watch-outs

### NEW this session (session 73)

- **`_`-prefix means "excluded from auto-discovery in `scripts/help.ts`."**
  Session 73 cleared the last violation (`debug_pengu_replay.ts`). If a
  future contributor reintroduces an unprefixed dev-only script that's
  not in package.json, either add a `help: HelpEntry[]` export OR prefix
  with `_`. The drift check (`npm run check:help`) currently passes; a
  regression here surfaces as either "Undocumented" (script discovered
  but no help entry) or no failure at all (which is the wrong direction
  — the file gets parsed needlessly on every help invocation).
- **`scripts/_debug_pengu_replay.ts` is unused.** It was checked in at
  initial import (commit `2959b2f`) and never wired up. The
  `git mv` preserves history but doesn't promote it to a documented
  workflow. If a future operator wants to revive it (e.g. for a PENGU
  diagnostic), they should EITHER promote it back to unprefixed +
  add an `EXTRA_HELP` entry OR keep it `_`-prefixed and document its
  invocation in the in-file docstring (currently absent). Don't reintroduce
  it as unprefixed without a help-entry — that would re-open the same
  drift-check edge case the session-65 convention closed.
- **useRiskConfig default-on means future daemon runs use the sizer
  path absent any flag.** If a future contributor sees `mode=sizer` in
  the daemon log and thinks "that's surprising," it's the new default
  as of session 73. Opt-out is `--evaluator-use-risk-config=false`. The
  session 61 decision #4 "never confound two operational changes"
  discipline still applies — do NOT bundle a useRiskConfig change with
  any other daemon flip in the same commit; revert in isolation if it
  misbehaves.
- **Enforce-mode is now default-ON.** Every non-dry `daemon:daily` run
  in enforce-mode WILL write `.daemon_halt` if kill criteria fire, and
  the next run's `checkHaltSentinelPreflight` refuses to start until
  the operator deletes the file. Opt-out via `--halt-enforce-mode=false`.
  Dry-runs (`daemon:daily:dry`) automatically force observe-mode via
  `resolveEffectiveHaltEnforce` regardless of the flag.
- **`severity='error'` → `daemon_runs.status='failed'` (NOT 'partial').**
  Enforce-mode HALT pushes an 'error' anomaly which flips the daemon_run
  to 'failed' per the aggregator at daily_signal_daemon.ts:1481-1484.
  Morning brief + any future alerting that filters on
  `status='failed'` will fire on every enforced halt. That's the right
  escalation; do not silently downgrade to 'warning'/'partial' without
  re-running the kill-criteria threshold-stability sweep.
- **The `enforce: boolean` input on `runDaemonHaltObservation` is
  REQUIRED (no default).** If a future contributor adds a third caller
  and forgets the flag, tsc fails. Don't add a default — the type-system
  forcing-function is what prevents the silent silent-passthrough
  regression that the prior in-source SPEC author worried about.
- **The SPEC §7 row 5 fail-closed catch-block** at
  daily_signal_daemon.ts (catch after the haltObs await) uses the pure
  helper `composeHaltMonitorFailClosed` — keep that helper pure and
  test-pinned. A monitor-itself exception in enforce-mode WRITES an
  emergency sentinel (via nested writeFile try/catch) and pushes 'error'
  anomaly. The double-failure path (emergency write itself fails) pushes
  a critical anomaly only — daemon completes its report so the morning
  brief surfaces the unrecoverable state.
- **Anomaly message contract surface changed.** Pre-s73: only
  `kill-switch monitor: HALT (observe-only); triggered: ...`. Post-s73:
  same prefix `kill-switch monitor: HALT` but the parenthetical can now
  also be `(enforce)`. Operator scripts that grep only on the
  `kill-switch monitor: HALT` prefix continue to match either mode.
  Scripts that specifically wanted `(observe-only)` may need updating
  to either accept `(enforce)` too or to explicitly filter on the
  mode parenthetical.

### CARRIED load-bearing (unchanged from sessions 41-72)

All session 41-72 watch-outs preserved unchanged. Notable:

- Session 72's M-1 `selectCellWeightsTier` unknown-prior throw — don't
  "simplify" back to silent-passthrough.
- Session 72's `tier_selection_parity.json` byte-pin — regenerate via
  `--gen-tier-fixtures`, never hand-edit.
- Session 72's `#T2-6` `hrp_*` prefix filter — don't widen back to `*.json`.
- Session 70's H-1 (UInt64 version), M-1 (shared `loadPriorActiveCellWeightsTier`),
  M-2 (HALT-suppression on both `decision='halt'` AND `haltSentinelPresent`),
  M-3 (stage-aware `cellCapitalUsdProxy`).
- Session 69's SPEC §17 critic-fix addendum.
- Session 68 RESEARCH (three-tier ladder pre-commitment + SKIP-ERC + `bt_trades`
  selection-bias rule).
- All sessions 41-67 watch-outs.

## Pre-loaded operational reminders

### Day-glance trio

```text
npm run daemon:daily          # external — Telegram. Writes live_trades + live_signals.
                              # Also writes cell_weights_history (migration applied s71).
                              # Defaults: retargeting ON, useRiskConfig ON (s73), HALT enforce-mode ON (s73).
                              # Per-cell split: T0 equal-weight active until triggers fire.
npm run audit:positions       # stdout-only — re-run weekly to track violation count
npx tsx scripts/_paper_trading_review.ts   # stdout-only
npm run brief:morning         # stdout-only markdown
                              # Stage panel includes the weighting line.
```

### Tests + dev

```text
npm test                                                                       # TS — 1245/1254 expected, 3 fail
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run lint                                                                   # ⚠ Fails at tsc step (13 errors)
npm run check:help                                                             # FULLY GREEN
npm run help                                                                   # Full cheat-sheet, CLEAN
```

### Cell-weights operations

```text
# Apply migration (operator-gated; DONE s71):
npm run migrate:cell-weights-history             # dry-run report
npm run migrate:cell-weights-history:apply       # ⚠ APPLIES DDL (idempotent; re-run no-op)

# Smoke-test the daemon's cell-weights wire-up:
npm run daemon:daily:dry -- --no-fetch --no-macro
# Expect:
#   [cell-weights] tier=T0 cells=2 weights=...:0.500,...:0.500 obsDaysWithTrades=0 minClosedTrades=0 ratchetHeld=no
#   [per-cell-capital] stage=paper deployed=$10000.00 cells=2 cellCap=$10000.00 halted=no

# Re-generate fixtures (dev-only):
.venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-fixtures
.venv/Scripts/python.exe scripts/_compute_cell_weights_reference.py --gen-tier-fixtures   # NEW (s72)

# Verify TS↔Python parity across BOTH HRP and tier-selection:
npx tsx scripts/_verify_cell_weights_fixtures.ts
```

### Threshold-stability sweep (session-58 format)

```text
npx tsx scripts/_threshold_stability_sweep.ts
# ~2 min. Read-only. ρ=0.921 baseline.
```

### HALT smoke test

```text
npx tsx scripts/_halt_smoke_test.ts
# ~5s. 9 scenarios. Run BEFORE the enforce-mode flip.
```

### Retargeting parity sweep

```text
npm run diagnose:retarget-parity -- --stage stage1
# Cleared 2026-05-17 at stage1 (ρ=1.000, 0 shifts, 0 trade-count diffs, n=23).
```

### Dry-run smoke for useRiskConfig (now default-on as of s73)

```text
# Default-on path (absent flag → sizer):
npm run daemon:daily:dry -- --no-fetch --no-macro
# Expect [evaluator-risk-config] mode=sizer ... AND [cell-weights] tier=T0 ...

# Opt-out path (=false → legacy):
npm run daemon:daily:dry -- --evaluator-use-risk-config=false --no-fetch --no-macro
# Expect [evaluator-risk-config] mode=legacy ...
```

### State-history migrations

```text
npm run migrate:live-trades                     # dry-run
npm run migrate:live-trades:apply               # ⚠ APPLIED
npm run migrate:drawdown-state-history          # dry-run
npm run migrate:drawdown-state-history:apply    # ⚠ APPLIED s55
npm run migrate:stage-state-history             # dry-run
npm run migrate:stage-state-history:apply       # ⚠ APPLIED 2026-05-17 (idempotent)
npm run migrate:kill-criteria-daily             # dry-run
npm run migrate:kill-criteria-daily:apply       # ⚠ APPLIED 2026-05-17 (idempotent)
npm run migrate:cell-weights-history            # dry-run
npm run migrate:cell-weights-history:apply      # ⚠ APPLIED 2026-05-17 (idempotent)
```

### Macro regime — full path

(Unchanged from session 71.)

## For the next session — priority order

**Operator decisions (the bottleneck):**

- **ADR-039 + ADR-040 joint operator sign-off before 2026-06-29.**
- **Enforce-mode flip wiring** (~1-2 hr CODE slice — scope corrected
  session 73; was misbilled as 1-line in earlier handoffs; HALT smoke
  9/9 PASS confirms pipeline ready; needs your go-ahead).
- ~~**useRiskConfig default-on flip wiring**~~ ✓ Shipped session 73.

**Recommended dev work if no Pejman activity:**

- Enforce-mode CODE slice (~1-2 hr; Pejman-decision per s73 lock-in #2).
- Bucket 3 research slice (CBOE calibration, drawdown recalibration).
  Multi-session each. (Cosmetic Bucket 4 debt is zero post-session 73.)

**Background (runs without dev attention):**

- Daily `npm run daemon:daily` continues. Retargeting default-on;
  useRiskConfig default-on (s73 flip); HALT monitor in OBSERVE mode.
  Per-cell split CODE-routed through `perCellCapitalByCell`; T0
  equal-weight until triggers fire.

**DO NOT auto-open without explicit operator green-light:**

- ML meta-labeling (Component 10) — ADR-027 defers ≥4 weeks.
- Sharadar / CBOE / ISM PMI subscriptions — paid data, operator decisions.
- Phase 3 fast-crash detection — not opened.
- Real-money flip — gated on full chain + ADR-039/ADR-040 sign-off +
  enforce + useRiskConfig + migration.
- Compounding live equity into backtest baseline — ADR-class.
- All 12 remaining Phase 9+ gap inventory items — FROZEN per 2026-05-17
  operator directive until paper-trading verdict + ADR-039/ADR-040
  sign-off; re-evaluate after 2026-06-29.

## Important framing for the next chat

Session 73 was the **closeout session** for the pre-real-money chain. In
a single turn it cleared: (a) the cosmetic Bucket 4 rename; (b) the
useRiskConfig default-on flip; (c) the full enforce-mode CODE slice
(+11 tests, in-CODE critic-fix pass); (d) ADR-039 + ADR-040 ratification
(Proposed → Accepted); (e) ISM PMI free-source reality-check (no
subscription needed). Pejman flagged the "operator" third-person
framing mid-session and authorized me to execute the technical flips
under "we are not live yet → you have the authority...". The end-to-end
chain through session 73:

```text
RAMP PATH (sessions 55 + 56):                  ✓ committed + writing rows
STREAK PATH (session 57):                      ✓ committed + writing rows
SIZER VALIDATION (session 58):                 ✓ ρ=0.921 Top-5 preserved
ENFORCE-MODE FLIP READINESS (59 + 60):         ✓ smoke 9/9
DAEMON-EVALUATOR CAPITAL HONESTY (61+62+62fu): ✓ SPEC + CODE + sweep + default-on
DAEMON-EVALUATOR USE-RISK-CONFIG (63):         ✓ SPEC + CODE + tests; default-off
POLISH MICRO-TURN (64):                        ✓ parity sweep wired; SPEC §10.9 amended
LINT-CHAIN UNBLOCK (65):                       ✓ macro_regime_backfill.ts argv fixed
HELP-DRIFT CLEANUP (66):                       ✓ 26 undocumented + 1 orphan; check:help GREEN
HELP-RENDER UX CLEANUP (67):                   ✓ debug_pengu_replay.ts guarded
ADR-040 RESEARCH STAGE (68):                   ✓ teach-doc + RESEARCH note
ADR-040 SPEC + CRITIC-FIX (69):                ✓ full SPEC + §17 addendum
ADR-040 CODE + CRITIC-FIX (70):                ✓ all files shipped; H-1+M-1+M-2+M-3+L-1 fixed in-CODE
ADR-040 MIGRATE (71):                          ✓ table live; dry-run smoke landed
ADR-040 L-2 CROSS-CHECK + CRITIC-FIX (72):     ✓ 720-row Python↔TS byte-pin + M-1 throw
                                                  hardening + 3 MED + 3 LOW critic-fixes
COSMETIC MICRO-TURN (73):                      ✓ debug_pengu_replay.ts → _debug_pengu_replay.ts
USE-RISK-CONFIG FLIP (73):                     ✓ default-on Pejman-authorized
ENFORCE-MODE WIRING (73):                      ✓ SHIPPED — full CODE slice:
                                                  - enforce: boolean param on runDaemonHaltObservation
                                                  - --halt-enforce-mode CLI flag (default-on)
                                                  - composeHaltMonitorFailClosed pure helper (SPEC §7 row 5)
                                                  - resolveEffectiveHaltEnforce pure helper (dry-run override)
                                                  - +11 tests; in-CODE critic-fix (1 HIGH + 3 MED + 3 LOW)
ADR-039 + ADR-040 RATIFIED (73):               ✓ Proposed → Accepted at docs/decisions/README.md:4185 + :4256
                                                  (Pejman-authorized; 2026-06-29 deadline closed)
ISM PMI RESEARCH NOTE (73):                    ✓ FRED reality-check: don't subscribe; Empire State
                                                  is closest free proxy; status quo recommended
  → All pre-real-money gates closed at the dev layer
  → next: Pejman directs commit strategy (working tree carries s41-73)
  → OR: Bucket 3 research (multi-session) — CBOE calibration, drawdown recalibration
  → OR: re-evaluate Phase 9+ frozen gaps after 2026-06-29 per s63 directive
```

All pre-real-money dev gates closed; Pejman-side remaining is operational
oversight, not gating action:

```text
[SPEC + CODE chain + L-2 cross-check — sessions 53-72 — DONE]
[Migration — session 71 — APPLIED 2026-05-17; schema verified; dry-run smoke green]
[L-2 — session 72 — 720-scenario Python↔TS byte-pin; M-1 hardening landed]
[useRiskConfig default-on flip — session 73 — SHIPPED Pejman-authorized]
[Enforce-mode wiring — session 73 — SHIPPED Pejman-authorized + critic-fix-passed]
[ADR-039 + ADR-040 ratification — session 73 — DONE Pejman-authorized]

[PEJMAN TASKS — remaining (operational, not gating)]
  ☐ Commit-strategy decision (working tree carries sessions 41-73 unstaged)
  ☐ Monitor first non-dry `daemon:daily` after the session 73 flips to confirm
    no surprises (mode=enforce in the log; sentinel write iff HALT)
  ☐ ~~All prior items~~  ✓ DONE s73 (useRiskConfig + enforce-mode + ADR ratification)

[ADR-039 framework — FULLY OPERATIONAL: retargeting ON (s62fu), useRiskConfig ON
 (s73), HALT enforce-mode ON (s73). ADR text ratified at docs/decisions/README.md:4185]
[ADR-040 policy — FULLY SHIPPED + RATIFIED: RESEARCH + SPEC + CODE + MIGRATION +
 L-2 byte-pin all in. T0 equal-weight is the active rule today; T1 auto-activates
 ~2026-08-29 earliest (paper trading accrual). ADR text ratified at docs/decisions/README.md:4256]
```

**Parallel-tracks posture continues.** 2026-06-29 ADR-039 sign-off remains
the only hard deadline. ADR-040 was designed to be ratified alongside
ADR-039 — recommended bundled. All 12 remaining Phase 9+ gaps + symbol-
analysis explicitly frozen per operator directive until paper-trading
verdict + ADR-039/ADR-040 sign-off complete.

## Critic-fix pass — session 72 (preserved for chain context)

Session 73 had no critic — a 1-file `git mv` rename with zero behavioral
change does not warrant a component-done review. The block below
preserves session 72's critic-fix log for reference (the L-2 cross-check
slice that the rename closes the convention-debt tail of).

Vector Core component-done critic (general-purpose subagent, run per
autonomous-progression rule) returned **FIX-THEN-SHIP** with 3 MEDIUM +
3 LOW findings on the L-2 slice. Resolution log:

**M-1 — `selectCellWeightsTier` silently accepted unknown
`priorActiveTier` strings.** Pre-fix `TIER_ORDER[unknownString]` returned
`undefined`; `undefined > TIER_ORDER[triggerSays]` evaluated `false`; the
function silently returned `triggerSays` instead of ratcheting. Python
`select_tier` was already strict (`TIER_ORDER[prior]` KeyErrors). Two
implementations diverging on the invalid-input boundary defeats the
whole point of L-2. **Resolution:** added a guard at the top of
`selectCellWeightsTier` (`src/server/cell_weights.ts:122-160`) that
throws with an actionable error message; added `#TRIG-12` to
`cellWeights.test.ts` pinning the throw + the message. Both
implementations now reject unknown input loudly.

**M-2 — `sufficientForT1` / `sufficientForT2` were written to the
fixture but never asserted by the TS test.** The fixture had them in
every row (the Python `select_tier` tuple returns them); the test only
asserted `expectedTier`. A future drift between the TS sufficiency-flag
computation in `computeCellWeights` and the Python definition would not
surface anywhere. **Resolution:** added `#TIER-PARITY-SUFFICIENCY` test
that runs `computeCellWeights` with `tier='T0'` (short-circuits math)
and asserts `r.sufficientForT1` and `r.sufficientForT2` match the
Python expected values across all 720 scenarios.

**M-3 — Tick/cross chars in `_verify_cell_weights_fixtures.ts` were
reversed from `✓`/`✗` to `+`/`!`** based on an incorrect read of the
Windows console encoding issue. The encoding issue was Python-specific
(cp1252); node handles ✓/✗ correctly. The change was inconsistent with
the repo's existing dev-script convention (visible via `grep -l "✓\|✗"
scripts/_*.ts` → 5+ files). **Resolution:** reverted to ✓/✗ at lines 69
and 117 of the verifier.

**L-1 — Hardcoded magic number `720` in `#TIER-PARITY-META`.** Pre-fix
asserted both `fixture.scenarios.length === fixture.scenarioCount` AND
`fixture.scenarios.length === 720`. The first assertion already pins
length-to-scenarioCount; the second is redundant and would fail
confusingly if a future sweep extension changed the cardinality.
**Resolution:** dropped the magic-number assertion; kept the
length-to-scenarioCount one. Test name updated to "fixture is well-
formed (all four priors, all three tiers present)".

**L-2 — Verifier dispatch on `id === 'tier_selection_parity'` was
fragile.** If a future contributor added a third fixture shape, the
verifier would blindly cast it to the HRP record type and crash with a
confusing `TypeError`. **Resolution:** dispatch on
`id === 'tier_selection_parity'` for parity shape, `id.startsWith('hrp_')`
for HRP shape, else log "unknown fixture shape — skipped" and continue.

**L-3 — ADR-040 source-line test-count tally.** Pre-fix said "65 net
new tests" (session 70 baseline). Post-session 72: 65 + 4 = 69.
**Resolution:** updated `docs/decisions/README.md` ADR-040 entry's
**Source:** line to include the L-2 cross-check + the +4 cumulative
test count. Also amended the prior reference to "for the HRP path" to
include the tier-selection logic.

**Critic verdict re-confirmed (post-fix):** SHIP. All MEDIUM + LOW
addressed in-CODE.

**Files added/modified by this in-CODE critic-fix pass:**

| File | Change |
| --- | --- |
| `src/server/cell_weights.ts` | M-1: added unknown-prior throw guard |
| `scripts/tests/cellWeights.test.ts` | M-2: added #TIER-PARITY-SUFFICIENCY; M-1: added #TRIG-12; L-1: dropped magic 720; #T2-6 hrp_ filter hardening |
| `scripts/_verify_cell_weights_fixtures.ts` | L-2: shape-dispatch + skip-unknown; M-3: ✓/✗ restored |
| `docs/decisions/README.md` | L-3: ADR-040 tally update + scope of byte-pin |
