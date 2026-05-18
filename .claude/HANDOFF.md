# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-17 (session 74 — drawdown framework §4.1 sizer-regime rescale SHIPPED; Pejman delegated decision authority mid-session)

## What this session delivered

Session 74 closed the first dev-side gap that the s73 `useRiskConfig`
default-on flip opened: the drawdown framework's Level-1/2/3/4
entry/exit thresholds were calibrated against legacy %-of-capital
sizing variance, but the s73 flip routes every daemon run through
fixed-fractional ATR-stop sizing which **compresses portfolio variance
by ratio ~0.297** (measured this session). Without a rescale, Level-1
fires at ~3.4σ instead of ~1σ, Level-3 (-12%) sits beyond observed
sizer max DD, and the framework's warning-system role silently
degrades toward missed alarms.

Pejman delegated decision authority mid-session ("My brain hurts from
thinking too much. I let you make that decision with authroity"). Under
that delegation I:

1. Augmented [scripts/_threshold_stability_sweep.ts](../scripts/_threshold_stability_sweep.ts)
   with `printDrawdownCalibrationSection` — computes trailing-30-entry
   cumulative portfolio P&L SD per cell × variant, per-cell rescale
   ratio distribution, pooled SD, deployed-cell SD, and suggested
   rescaled thresholds (rounded to nearest 0.5%). Read-only, additive.
2. Ran the sweep. Per-cell ratio: **median = 0.297, min 0.233, max
   0.412** (n=15 cells). Tight distribution, no outliers, robust
   across the parameter surface. Deployed-cell ratio 0.335; pooled
   0.286. Took median 0.297 as the canonical rescale factor.
3. Amended [docs/specs/drawdown-response-framework.md](../docs/specs/drawdown-response-framework.md)
   with §4.1 — full RESEARCH→SPEC documentation of the rescale
   methodology, the measurement, the L5/A5 deferral rationale, the
   stage1/stage2 ADR-039-amendment scope-flag, and the relationship to
   the §12 90-day empirical retune (which still applies).
4. Rescaled [src/server/drawdown_state.ts](../src/server/drawdown_state.ts)
   `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS` and `_EXIT_THRESHOLDS` constants.
   L5 entry (-0.20) **UNCHANGED** — operator-decision-deferred (see
   "L5/A5 deferred" below).
5. Updated [src/server/capital_deployment_config.ts](../src/server/capital_deployment_config.ts)
   `stage3.failDrawdown` from -0.12 → -0.035 (follows L3 entry per
   §7.2 wire-up). Bumped `CONFIG_VERSION` from `'ADR-039:Proposed:2026-05-17'`
   → `'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'`. The new
   string also catches the s73 ratification (Proposed → Accepted) that
   was missed at the time.
6. Refactored 4 test files: `drawdownState.test.ts` (byte-pins + 18
   rescaled scenario tests), `capitalDeploymentConfig.test.ts`
   (CONFIG_VERSION + stage3.failDrawdown), `stageState.test.ts`
   (cosmetic L3 dd update), `liveTradeRepository.test.ts`
   (requiredConfigVersion pin to new version string).

Concrete state changes (this session only):

1. **Sweep augmentation** at
   [scripts/_threshold_stability_sweep.ts](../scripts/_threshold_stability_sweep.ts).
   New `computeTrailing30dCumPctSeries` helper + augmented `CellMetrics`
   with `trail30dCumPctSeries` field + new `printDrawdownCalibrationSection`
   function. Output adds a 5-section diagnostic block AFTER the
   plateau analysis and BEFORE the §9 step 4 verdict. Existing output
   unchanged. Reproducer: `npx tsx scripts/_threshold_stability_sweep.ts`
   (~2 min, read-only).

2. **Framework constants rescaled** at
   [src/server/drawdown_state.ts:65-82](../src/server/drawdown_state.ts#L65-L82).

   ENTRY thresholds:
   - L1: -0.03 → **-0.01**
   - L2: -0.07 → **-0.02**
   - L3: -0.12 → **-0.035**
   - L4: -0.18 → **-0.055**
   - L5: -0.20 → **UNCHANGED** (byte-pinned to A5_KILL_THRESHOLD_PCT)

   EXIT thresholds:
   - L1: -0.02 → **-0.005** (days unchanged at 5)
   - L2: -0.05 → **-0.015** (days unchanged at 5)
   - L3: -0.10 → **-0.03** (days unchanged at 5)
   - L4: -0.15 → **-0.045** (days unchanged at 10)

   Day counts unchanged (recovery-day requirement is a structural
   choice, not variance-derived).

3. **`stage3.failDrawdown` rescaled** at
   [src/server/capital_deployment_config.ts:174](../src/server/capital_deployment_config.ts#L174):
   `-0.12 → -0.035`. Operational semantics unchanged (still fires on
   `isLevel3EntryEvent(prior, current)`, NOT on `drawdown <= -0.035`).
   The numeric value mirrors `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]` for
   audit-trail clarity AND so drift-detection test #50 in
   `stageState.test.ts` catches desynchronisation.

4. **CONFIG_VERSION bump** at
   [src/server/capital_deployment_config.ts:64](../src/server/capital_deployment_config.ts#L64):
   `'ADR-039:Proposed:2026-05-17' → 'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'`.
   Bundles two unbundled changes: (a) s73 ratification that didn't
   bump the version at the time, (b) s74 framework §4.1 rescale.

5. **SPEC amendment** at
   [docs/specs/drawdown-response-framework.md](../docs/specs/drawdown-response-framework.md)
   §4.1 — new section inserted BEFORE existing §4. Documents the
   methodology, evidence (the 5-section sweep output), L5/A5 deferral
   rationale, stage1/stage2 ADR-039-amendment scope-flag, and the
   distinction between §4.1 (proportional rescale, stopgap) and §12
   (empirical-quantile retune at 90d, canonical fix). Also updated
   §9.2 (code block byte-pin reference), §9.3 (failDrawdown wire-up
   footnote), and §11 (test plan dd values).

6. **Test rescaling** — all four affected test files updated:
   - `scripts/tests/drawdownState.test.ts` — byte-pin tests (#20) +
     18 scenario tests with rescaled dd inputs that preserve the
     ORIGINAL logical scenarios (boundary semantics, sticky-down,
     one-step recovery, hysteresis, L3 7-day pause) under the new
     threshold values. The PATTERN under test is unchanged; only the
     numeric inputs scaled by ~0.297.
   - `scripts/tests/capitalDeploymentConfig.test.ts` — CONFIG_VERSION
     byte-pin + stage3.failDrawdown byte-pin.
   - `scripts/tests/stageState.test.ts` — cosmetic update to test #36's
     dd input (-0.13 was realistic under old, now semantically odd at
     level 3; updated to -0.04). The dd value is incidental — the gate
     fires on `isLevel3EntryEvent`, not on dd magnitude.
   - `scripts/tests/liveTradeRepository.test.ts` — `requiredConfigVersion`
     pin to new CONFIG_VERSION string.

Test verdict (post-rescale, full npm test):

```text
1265 total / 1256 pass / 3 fail / 6 skipped
```

Identical to the s73 baseline. The 3 fails are pre-existing macro
regime fixture failures (2008_gfc, 2011_eu_debt, 2020_covid in
`macroRegimeFixturesV3.test.ts`); no s74 change touched them.
+1 pass vs s73 (1255 → 1256) because s74's liveTradeRepository pin fix
brought a previously-existing test back to green at the same time.

Dry-run smoke verdict:

```text
npm run daemon:daily:dry -- --no-fetch --no-macro
  [drawdown-state] level=L0 dd=0.00% sizing=1× entries=allowed regimeRed=0d
  [stage-state] stage=paper decision=hold reason=min-duration-not-met
  [cell-weights] tier=T0 cells=2 weights=...:0.500,...:0.500 ...
  [per-cell-capital] stage=paper deployed=$10000.00 cells=2 cellCap=$10000.00 halted=no
  [evaluator-capital] mode=retarget stage=paper cap=$10000.00 cells=2 halted=no
  [evaluator-risk-config] mode=sizer stage=paper cells=2
  [halt-monitor] decision=OK mode=observe triggered=none
```

(Halt-monitor mode=observe is correct in dry-runs — `resolveEffectiveHaltEnforce`
forces observe-mode regardless of the `--halt-enforce-mode=true` default.)

## Where we are

The pre-real-money chain through s73 closed all dev-side gates. S74
closed the FIRST KNOWN POST-S73 GAP that the sizer flip exposed: the
drawdown framework calibration. The framework's warning-system function
is now restored under the sizer regime; the stage 3 fail gate fires at
a realistic threshold (-0.035 vs the previously-effectively-unreachable
-0.12).

Two related sizer-regime calibration questions REMAIN OPEN:

1. **L5/A5 deferred** — A5/L5 carries a dual interpretation:
   - σ-band warning (Pardo §11 logic) → rescale to ~-5% to preserve
     the original ~5σ position
   - Operator-preference circuit breaker ("never lose >20% in a
     month") → leave at -20%
   - Worst observed sizer-cell DD is -14.63%, so under interpretation
     (b) the kill is effectively dormant under sizer (would require a
     >5σ tail event to fire). This is a real value judgment about
     what A5/L5 means operationally, NOT a pure data call.
   - Per full-delegation memory, this is the "ADR conflicts /
     canon-thin ambiguity" stop trigger. Pejman-decision needed.

2. **stage1.failDrawdown (-0.05) and stage2.failDrawdown (-0.10)** are
   ADR-039 §1 originals (verbatim from the canonical ADR table) and
   were NOT rescaled in s74. They're similarly affected by the sizer
   flip — under sizer with σ≈0.89% on the deployed cell, stage1's
   -5% is a ~5.6σ event and stage2's -10% is ~11σ. Both effectively
   never fire. Rescaling them requires an **ADR-039 amendment slice**
   with its own operator decision, NOT a framework SPEC amendment.
   Flagged in SPEC §4.1 Watch-outs.

| Bucket | Status |
| --- | --- |
| §9 step 6 — enforce-mode flip | ✓ shipped s73 |
| §9 step 7 — halt sentinel + pre-flight | ✓ shipped (prior) |
| ADR-040 RESEARCH/SPEC/CODE/MIGRATE/L-2 byte-pin | ✓ s68-s72 |
| ADR-039 + ADR-040 ratification | ✓ s73 Pejman-authorized |
| useRiskConfig default-on flip | ✓ s73 Pejman-authorized |
| Drawdown framework §4.1 sizer-regime rescale (L1-L4) | ✓ shipped s74 (Pejman-delegated) |
| Drawdown framework L5/A5 rescale decision | ☐ Pejman-decision (sigma-band vs operator-preference) |
| ADR-039 stage1/stage2 failDrawdown rescale | ☐ Pejman-decision (ADR-039 amendment slice) |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — will be sizer-data when it fires |

## Decisions locked in

### Session 74 (this session — drawdown framework §4.1 rescale)

**1. Drawdown framework Levels 1-4 entry/exit thresholds rescaled by
ratio 0.297 (per-cell median SIZER/LEGACY trailing-30d cum P&L SD).**
Pre-s74 values were calibrated to legacy %-of-capital sizing variance
(SPEC §4 cites trend_v1/mr_v1 30-day rolling SD ~3-5%). Post-s73,
sizer compresses portfolio variance by ratio ~0.297 (measured this
session: per-cell median 0.297, deployed-cell 0.335, pool 0.286,
per-cell range 0.233-0.412). Proportional rescale preserves the
σ-band design Pardo (2008) §11 originally specified.
`Why:` per Vector Core PUSHBACK role + SPEC §4's explicit
"calibrated against backtest variance of the deployed cells" framing,
a known systematic variance shift documented in SPEC §9.4 (port_DD
-25% legacy → -10.7% sizer midpoint) requires the σ-band thresholds
to follow or the warning-system function silently degrades. This is
NOT the §12 retune (which uses live-data empirical quantiles at 90
days); §12 still applies and supersedes §4.1 at that point.
`How to apply:` if a future contributor sees the new thresholds and
wonders why they're so close to -0% compared to "industry norms" or
legacy literature defaults, the answer is sizer-regime variance.
DO NOT reset to "rounder" or "more conservative" values without
re-running the sweep diagnostic + updating SPEC §4.1.

**2. L5/A5 entry threshold UNCHANGED at -0.20.** A5/L5 carries a dual
interpretation (σ-band warning vs operator-preference circuit
breaker) that cannot be resolved from data alone. Worst observed
sizer-cell DD is -14.63%, so under the operator-preference reading
the hard-kill is effectively dormant under sizer. Decision deferred
to a separate slice + Pejman-decision.
`Why:` per `feedback_full_delegation_mode` memory, "ADR conflicts /
canon-thin ambiguity" is one of the explicit stop triggers for
autonomous progression. The σ-vs-operator-preference distinction
isn't an ambiguity the canon resolves — it's a value judgment about
what A5/L5 means operationally.
`How to apply:` when Pejman returns to this question, the slice
should answer first: "what is A5/L5 for — statistical warning of
unusual distress, or hard cap on monthly loss?" Then the data
determines the threshold. Test #26 byte-equality between A5 and L5
must update in lockstep if either changes.

**3. stage1.failDrawdown (-0.05) and stage2.failDrawdown (-0.10)
NOT rescaled in s74.** These values are ADR-039 §1 originals
(verbatim from `docs/decisions/README.md` lines ~4198-4203). Under
sizer they're effectively never going to fire (~5.6σ and ~11σ
events respectively). Rescaling them requires an ADR-039 amendment
slice, NOT a framework SPEC amendment.
`Why:` discipline pattern — framework SPEC amendments shouldn't
silently amend ADR-canonical values. The right path is an explicit
ADR-039 amendment that documents the same proportional-rescale logic
applied to stages 1+2.
`How to apply:` future ADR-039 amendment slice should rescale by the
SAME ratio 0.297 (or update from a fresh sweep run) and bump
CONFIG_VERSION accordingly. Tests in `capitalDeploymentConfig.test.ts`
will fail loudly on the byte-pin if any stage's failDrawdown changes
without test update.

**4. CONFIG_VERSION format extended to support amendment suffixes.**
New format: `'ADR-NNN:<status>:<YYYY-MM-DD>[+<amendment-tag>]'`.
Used here as `'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'`.
Catches both the s73 ratification (Proposed → Accepted) that wasn't
bumped at the time AND the s74 framework rescale.
`Why:` previously CONFIG_VERSION was 1:1 with ADR-status changes, but
framework SPEC amendments that change values pinned in this config
(e.g. stage3.failDrawdown follows L3 entry) need to bump too, or
audit-trail breaks.
`How to apply:` future amendments to values pinned in
capital_deployment_config.ts that aren't ADR-039 status changes
should use the `+<tag>` suffix with a short kebab-case identifier.

**5. The §9.4 author's "(false alarms, not missed alarms)" direction
call was wrong.** Documented in SPEC §4.1 Watch-outs and in the s74
critic-side reasoning. Direction is missed alarms under variance
compression with fixed thresholds — the realized distribution lives
well ABOVE the threshold post-sizer, so the threshold fires LESS
often, not more.
`Why:` worth pinning so a future re-reading of §9.4 doesn't mislead.
The original direction-error was the trigger for treating the rescale
as time-critical rather than cosmetic.

### Carried locked decisions (sessions 41-73)

All sessions 41-73 lock-ins preserved unchanged. See git history for
the full chain.

## Open questions

### HIGH (Pejman decisions pending)

1. **L5/A5 rescale decision** — σ-band interpretation (rescale to ~-5%)
   vs operator-preference interpretation (leave at -20%, accept
   defunct hard-kill under sizer). See s74 lock-in #2.
2. **stage1.failDrawdown + stage2.failDrawdown rescale** — ADR-039
   amendment slice. Same proportional-rescale logic applies. See s74
   lock-in #3.

### CARRIED HIGH (unchanged from s73)

- CBOE calibration diagnostic.
- CBOE put/call 2019-present (DataShop) subscription.
- Schema-migration bootstrap-only.
- ~~ISM PMI subscription~~ — resolved s73 (don't subscribe).
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription.
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- 12 Phase 9+ gap inventory items — FROZEN per s63 directive until
  2026-06-29.

### Closed this session

- ~~Drawdown framework calibration vs sizer regime~~ — partially
  closed. L1-L4 shipped this session; L5/A5 + stage1/stage2 deferred
  as separate Pejman-decisions (see HIGH above).

## Next stage

### Default next slice (recommended)

**Option A — L5/A5 decision + (if rescale) bundled ADR-039 amendment
for stage1/stage2.** Both deferred Pejman-decisions can be resolved
in one operator turn. Estimated effort if rescale path chosen: ~1
hour CODE + tests (mirrors s74's structure). If "leave A5 at -20%
and stage1/stage2 at original ADR-039 values" path chosen: ~15 min
documentation in SPEC §4.1 + ADR-039 reference.

### Alternative dev slices (if Pejman not available)

| Option | Stage | Effort | Note |
| --- | --- | --- | --- |
| L5/A5 + stage1/stage2 rescale (full slice) | DESIGN+SPEC+CODE | ~1 hr | Mirror s74 structure |
| Bucket 3 — CBOE calibration diagnostic | RESEARCH | Multi-session | Independent surface |
| Bucket 3 — trend_v1 rescale sweep | RESEARCH+CODE | ~1 hr | Extend `_threshold_stability_sweep.ts` to cover trend_v1; check if 0.297 ratio holds across strategies |
| Commit s74 work | DECISION-ACT | ~5 min | Working tree carries s74 unstaged; Pejman directs |

### Bucket 3 candidates (post-s74)

1. **trend_v1 rescale sweep.** The s74 ratio 0.297 was derived from
   mr_v1 only. If trend_v1's sizer/legacy ratio diverges materially
   (>20% deviation), the framework thresholds may need per-strategy
   adjustments or median-across-strategies. ~1 hour of sweep
   extension + analysis.
2. **CBOE calibration diagnostic.** Independent of framework
   recalibration; CBOE put/call already ingesting free.
3. **Drawdown framework §12 90d empirical retune** — will be
   sizer-mode data when it fires (~2026-08-29 earliest under the
   90-day paper-trading horizon). Don't ship until then.

### Bucket 2 — FROZEN until 2026-06-29 per s63 directive

12 Phase 9+ gaps. Re-evaluate after paper-trading verdict + ADR
sign-offs.

### Track A — background

Daily `npm run daemon:daily` continues. Defaults: retargeting ON,
useRiskConfig ON, halt enforce-mode ON, drawdown framework with
**rescaled Levels 1-4 thresholds active as of s74**. Per-cell split
T0 equal-weight until triggers fire (~2026-08-29 earliest). The
first non-dry daemon run with non-zero cumulative pnl will exercise
the new thresholds in operational logging.

## Files / code state

### EDITED this session (session 74)

- [scripts/_threshold_stability_sweep.ts](../scripts/_threshold_stability_sweep.ts) —
  AUGMENT: added `computeTrailing30dCumPctSeries` helper,
  `trail30dCumPctSeries` field on `CellMetrics`, and a new
  `printDrawdownCalibrationSection` function. Wired into main()
  before the §9 step 4 verdict.
- [src/server/drawdown_state.ts](../src/server/drawdown_state.ts) —
  RESCALE: `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS` L1-L4 and
  `DRAWDOWN_LEVEL_EXIT_THRESHOLDS` L1-L4. L5 unchanged. Docstrings
  updated to reflect §4.1 + the s74 rescale.
- [src/server/capital_deployment_config.ts](../src/server/capital_deployment_config.ts) —
  EDIT: `stage3.failDrawdown` -0.12 → -0.035 (follows L3 entry).
  `CONFIG_VERSION` bumped to
  `'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'`. Docstring
  extended with the new format conventions + bump history.
- [docs/specs/drawdown-response-framework.md](../docs/specs/drawdown-response-framework.md) —
  AMEND: new §4.1 inserted; §9.2 byte-pin code block updated to new
  values; §9.3 wire-up footnote updated; §11 test table inputs
  rescaled.
- [scripts/tests/drawdownState.test.ts](../scripts/tests/drawdownState.test.ts) —
  REFACTOR: byte-pin tests #20 + 18 scenario tests with rescaled dd
  inputs. Recovery hysteresis + L3 7-day pause tests rescaled too.
- [scripts/tests/capitalDeploymentConfig.test.ts](../scripts/tests/capitalDeploymentConfig.test.ts) —
  EDIT: CONFIG_VERSION byte-pin + stage3.failDrawdown byte-pin
  updated. Header docstring extended with s73 + s74 bump notes.
- [scripts/tests/stageState.test.ts](../scripts/tests/stageState.test.ts) —
  COSMETIC: test #36 `mkDrawdown(3, -0.13)` → `mkDrawdown(3, -0.04)`
  to use a realistic L3 dd under the new thresholds. The dd value
  is incidental — gate fires on `isLevel3EntryEvent`, not dd.
- [scripts/tests/liveTradeRepository.test.ts](../scripts/tests/liveTradeRepository.test.ts) —
  EDIT: `requiredConfigVersion` pin updated to new CONFIG_VERSION
  string.
- [.claude/HANDOFF.md](./HANDOFF.md) — REWRITE. This document.

### CH state (unchanged from s71)

`quantlab.cell_weights_history` is LIVE (migration applied s71). All
other migrations APPLIED in prior sessions. Row counts unchanged by
s74 (constants-only changes; no schema or migration changes).

### Tests

```text
.venv/Scripts/python.exe -m pytest scripts/tests       # Python — 164/164 (unchanged)
npm test                                                # TS — 1265 total / 1256 pass / 3 fail / 6 skipped
  Detail: identical to s73 baseline (1256 pass = 1255 s73 + 1 s74 fix);
          3 fails unchanged (pre-existing macroRegimeFixturesV3 fixtures).
node --import tsx --test scripts/tests/drawdownState.test.ts                       # 44/44
node --import tsx --test scripts/tests/capitalDeploymentConfig.test.ts             # 27/27
node --import tsx --test scripts/tests/stageState.test.ts                          # 62/62
node --import tsx --test scripts/tests/liveTradeRepository.test.ts                 # 21/21 (was failing pre-s74)

# Sweep diagnostic (run this to see the rescale evidence in detail):
npx tsx scripts/_threshold_stability_sweep.ts
  # ~2 min. Output includes the new "Drawdown framework recalibration
  # diagnostic" section after the plateau analysis.
```

### tsc

```text
npx tsc --noEmit 2>&1 | grep -c "error TS"   # 13 (unchanged baseline)
```

### Lint chain

```text
npm run check:help   # EXIT 0 — fully green (unchanged)
npm run help         # Full cheat-sheet, clean (unchanged)
npm run lint         # Still fails at tsc step (13-error baseline); check:help GREEN
```

## Watch-outs

### NEW this session (session 74)

- **L1-L4 thresholds are now ~3× tighter than they appear in the
  SPEC §3 narrative.** The §3 prose still describes the OLD values
  ("Caution at -3%", "Concern at -7%", etc.) because §4.1 is an
  amendment, not a §3 rewrite. Future readers of §3 must read §4.1
  to get the live thresholds. The byte-pin tests + the constants
  in `drawdown_state.ts` are the source of truth; §3 is structural
  description, §4.1 is the live calibration.
- **stage3.failDrawdown=-0.035 may surface a real rollback** under
  sizer that the old gate (-0.12) would have suppressed. The first
  30 days post-rescale at stage 3 might see a rollback to stage 2
  that was previously dormant. This is the right behavior — the old
  gate was effectively unreachable under sizer.
- **The §9.4 author's direction-call** ("false alarms, not missed
  alarms") was wrong. Under variance compression with fixed
  thresholds, the threshold fires LESS often, not more. Documented
  in SPEC §4.1 Watch-outs.
- **The s74 rescale ratio (0.297) is derived from mr_v1 only.**
  trend_v1 calibration is a follow-up sweep. If trend_v1's ratio
  diverges materially (>20% deviation from 0.297), the framework
  thresholds may need per-strategy adjustments.
- **The framework's σ-band design rationale (Pardo §11) implicitly
  assumes a stable realized distribution.** Any future change that
  materially shifts variance (universe change, new strategy,
  changes to DEFAULT_RISK_CONFIG params, etc.) needs to re-run the
  s74 diagnostic and potentially re-rescale. The diagnostic in
  `_threshold_stability_sweep.ts printDrawdownCalibrationSection`
  is the reproducible audit tool.
- **CONFIG_VERSION format** now supports `+<amendment-tag>` suffix
  for framework SPEC amendments that change config-pinned values.
  Don't drop the suffix when reading the version; treat the full
  string as the canonical identifier.

### CARRIED load-bearing (unchanged from sessions 41-73)

All session 41-73 watch-outs preserved unchanged. Notable:

- s73 enforce-mode wiring (composeHaltMonitorFailClosed +
  resolveEffectiveHaltEnforce pure helpers; `enforce: boolean`
  required-no-default input on `runDaemonHaltObservation`).
- s73 useRiskConfig default-on (the trigger for the s74 rescale).
- s72 M-1 `selectCellWeightsTier` unknown-prior throw.
- s72 tier_selection_parity.json byte-pin (regenerate via
  `--gen-tier-fixtures`).
- s70 H-1 (UInt64 version), M-1 (shared loader), M-2 (HALT-suppression),
  M-3 (stage-aware cellCapitalUsdProxy).
- All other carried watch-outs.

## Pre-loaded operational reminders

### Day-glance trio

```text
npm run daemon:daily          # external — Telegram. Defaults: retargeting ON, useRiskConfig ON,
                              # HALT enforce-mode ON. Drawdown framework with s74-rescaled L1-L4
                              # thresholds active. T0 equal-weight per-cell split.
npm run audit:positions       # stdout-only — re-run weekly
npx tsx scripts/_paper_trading_review.ts   # stdout-only
npm run brief:morning         # stdout-only markdown
```

### Tests + dev

```text
npm test                                                                       # TS — 1265 total / 1256 pass / 3 fail / 6 skipped (s73 baseline preserved by s74)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run lint                                                                   # ⚠ Fails at tsc step (13 errors)
npm run check:help                                                             # FULLY GREEN
npm run help                                                                   # Full cheat-sheet, CLEAN
```

### Drawdown framework recalibration diagnostic (s74)

```text
npx tsx scripts/_threshold_stability_sweep.ts
# ~2 min. Read-only. Output includes the "Drawdown framework
# recalibration diagnostic" section (after plateau analysis, before
# §9 step 4 verdict). Reports per-cell median rescale ratio + suggested
# rescaled thresholds. Re-run if:
#   - DEFAULT_RISK_CONFIG params change
#   - Universe changes
#   - New strategy added
#   - 90-day empirical retune approaches and we want a comparison
```

### Cell-weights / threshold-stability / HALT smoke / retargeting parity / use-risk-config dry-run

(Unchanged from s73 — see prior handoff in git history if needed.)

### State-history migrations

(Unchanged from s73 — all applied.)

## For the next session — priority order

**Pejman decisions (the bottleneck):**

- **L5/A5 rescale decision** — σ-band (~-5%) vs operator-preference
  (stay at -20%, accept defunct hard-kill under sizer). See s74
  lock-in #2.
- **stage1.failDrawdown + stage2.failDrawdown rescale** — ADR-039
  amendment slice. See s74 lock-in #3.

**Recommended dev work if no Pejman activity:**

- Bucket 3 — trend_v1 rescale sweep (~1 hr; extends
  `_threshold_stability_sweep.ts` to cover trend_v1, validates the
  0.297 ratio across strategies).
- Bucket 3 — CBOE calibration diagnostic (multi-session, independent).
- Commit-strategy: working tree carries s74 unstaged; Pejman directs.

**Background (runs without dev attention):**

- Daily `npm run daemon:daily` continues with s74-rescaled framework
  thresholds active. First non-dry run with non-zero cumulative pnl
  will exercise the new thresholds.

**DO NOT auto-open without explicit operator green-light:**

- All carried items from s73 handoff (real-money flip; compounding
  live equity; Phase 9+ gaps until 2026-06-29; etc.).

## Important framing for the next chat

Session 74 was the **first post-s73 dev gap closure** — the sizer
flip opened a real safety gap in the drawdown framework (warning
system mathematically degraded toward missed alarms), and s74
closed it for Levels 1-4. Pejman explicitly delegated decision
authority mid-session, and per `feedback_full_delegation_mode` I
pushed RESEARCH→SPEC→CODE→TESTS through autonomously, stopping
only at the L5/A5 σ-vs-operator-preference question (genuine
ambiguity per the stop trigger).

The chain through s74:

```text
ALL S41-S73 WORK     ✓ committed acf80be + 3b09b9f, 2 commits ahead of origin
S74 SWEEP AUGMENT    ✓ printDrawdownCalibrationSection added; ~2-min reproducer
S74 SD MEASUREMENT   ✓ per-cell median ratio 0.297 (range 0.233-0.412; tight, robust)
S74 SPEC §4.1        ✓ amendment with methodology + canon + L5/A5 + stage1/2 deferrals
S74 CODE RESCALE     ✓ L1-L4 entry+exit thresholds; stage3.failDrawdown; CONFIG_VERSION
S74 TESTS REFACTOR   ✓ 4 test files; npm test back to s73 baseline + 1 (1256 pass)
S74 SMOKE            ✓ dry-run shows [drawdown-state] level=L0 clean output
S74 HANDOFF          ✓ this document
  → next: Pejman decisions on L5/A5 + stage1/stage2; OR Bucket 3 dev work
  → background: daemon continues with rescaled framework active
```

Per `feedback_no_confirmation_pauses` and `feedback_full_delegation_mode`,
s74 didn't pause for sign-off at each stage — full RESEARCH→SPEC→CODE→TESTS
push under explicit Pejman delegation. The L5/A5 stop is the canon-thin
ambiguity exception, not a confirmation pause.

**Parallel-tracks posture continues.** No hard deadlines remaining post
s73 ratification. All 12 remaining Phase 9+ gaps frozen until 2026-06-29.
