# FRED → T10Y3M same-day alignment probe (OQ-C16-1 resolution)

**Date:** 2026-05-24 (session 96 #18 Cycle 19)
**Trigger:** OQ-C16-1 surfaced in s96 #17 Cycle 16 Slice A. The
`/#/regime` smoke-test found `yield_curve_value: null` on the
2026-05-22 macro_regimes row under `inputs_missing` bit 64 (T10Y3M).
The Cycle 16 hypothesis was graceful-degradation under FRED-stale
(loader correctly emits null when no value available, no fix needed).
**This probe falsifies that hypothesis.**

## TL;DR

The Cycle 16 hypothesis was wrong. There is a real Tier-2 correctness
issue per ADR-044: `quantlab.macro_regimes.yield_curve_value` for
trade_dates `2026-05-15` through `2026-05-21` carries **T10Y2Y values**,
not T10Y3M. ADR-041 (Accepted 2026-05-19) mandates T10Y3M. The
classifier-today daemon (`macro_regime_v3.ts::classifyLatestMacroRegimeV3`)
is one-shot per latest date — once a row exists for
`(trade_date, classifier_version)` it is never re-written, even after a
code change or after late-arriving FRED data lands. Two compounding
mechanisms produce the wrong-source persistence:

1. **Code-change race.** The T10Y2Y → T10Y3M loader-call change shipped
   in commit `4406674` (s95 #5) on 2026-05-21 21:42 MDT (≈ 2026-05-22
   03:42 UTC). Rows ingested before that commit were classified under
   T10Y2Y. Rows ingested after are classified under T10Y3M. Existing
   pre-change rows are never refreshed.
2. **Late-FRED race for 2026-05-20.** Daemon ran on 2026-05-20 at 14:02
   UTC (08:02 MDT) — BEFORE FRED's 2026-05-20 EOD publish (~18:00 ET).
   T10Y2Y for 2026-05-20 (`value=0.53`) was not yet in CH at classify
   time. Row was written with `yield_curve_value=null` + bit 64. The
   one-shot daemon then never re-classified after FRED's data landed.

The 2026-05-22 row (the original Cycle 16 surface) IS graceful-
degradation: T10Y3M for 2026-05-22 is absent from FRED (max in CH =
2026-05-21), so the null + bit 64 is correct under the post-change code
+ data state.

## Evidence

### FRED state in CH (as of 2026-05-24 06:46 MDT)

- `quantlab.macro_indicators_fred FINAL` where `series_id = 'T10Y3M'`:
  `n=7603`, `min(observation_date)=1996-01-02`,
  `max(observation_date)=2026-05-21`.
- T10Y3M observations for 2026-05-15..21 inclusive: present every NYSE
  trading day. Values: 0.9 / 0.93 / 1.0 / 0.92 / 0.89.
- T10Y2Y observations for 2026-05-15..21 inclusive: present every NYSE
  trading day. Values: 0.5 / 0.54 / 0.54 / 0.53 / 0.49.
- Neither series has an observation for 2026-05-22 yet (FRED 3.2d stale
  per `npm run health:check`).

### macro_regimes rows (classifier_version='phase1_v3')

| trade_date | ingested_at (UTC) | code at classify | yield_curve_value | inputs_missing | matches T10Y2Y? | matches T10Y3M? |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-05-15 | 2026-05-18 04:18 | OLD (T10Y2Y) | 0.5 | 16 | YES (0.5) | NO (T10Y3M=0.9) |
| 2026-05-18 | 2026-05-18 22:25 | OLD (T10Y2Y) | 0.54 | 16 | YES (0.54) | NO (T10Y3M=0.93) |
| 2026-05-19 | 2026-05-19 23:40 | OLD (T10Y2Y) | 0.54 | 16 | YES (0.54) | NO (T10Y3M=1.0) |
| **2026-05-20** | 2026-05-20 14:02 | OLD (T10Y2Y) | **null** | **80** | NO (race) | NO (race) |
| 2026-05-21 | 2026-05-22 01:25 | OLD (T10Y2Y) | 0.49 | 16 | YES (0.49) | NO (T10Y3M=0.89) |
| 2026-05-22 | 2026-05-22 14:45 | NEW (T10Y3M) | null | 80 | n/a | YES (FRED stale) |

`inputs_missing = 16` is bit 4 = BREADTH (Stooq apikey gate carry-over
per Q-3). `inputs_missing = 80` is bits 4 + 6 (BREADTH + T10Y3M).
`code at classify` is derived from comparing `ingested_at` against the
commit time of `4406674` (2026-05-22 03:42 UTC).

### Probe artifacts (kept on disk)

- `scripts/_probe_fred_t10y3m_alignment.ts` — re-runnable probe for
  FRED state + SPY trading-date alignment + macro_regimes row state.
- `scripts/_probe_t10y2y_compare.ts` — T10Y2Y comparison with
  ingested_at metadata.

Both probes are pure-read (no writes). Re-run cost: a few seconds of CH
queries.

## Root cause

The classifier-today daemon at
[scripts/daily_signal_daemon.ts:637-655](scripts/daily_signal_daemon.ts#L637-L655)
calls `classifyLatestMacroRegimeV3()`. That function at
[src/server/macro_regime_v3.ts:1133-1162](src/server/macro_regime_v3.ts#L1133-L1162)
finds the latest date with all candle sources available and runs
`backfillMacroRegimesV3({ startDate: t, endDate: t })` — a one-date
window. There is NO loop over prior dates, NO check that previously-
written rows still reflect current upstream data, and NO refresh path
for rows that were classified with incomplete inputs (e.g. before
FRED's same-day publish).

This means:

- Any code change to the loader (T10Y2Y → T10Y3M; future series swaps)
  silently leaves historical rows under the old source until a manual
  re-backfill runs.
- Any late-arriving upstream data (FRED EOD publish ≈ 4h after NYSE
  close) leaves the affected day's row stuck at its initial-classify
  state.

The docstring at [src/server/macro_regime_v3.ts:1183-1191](src/server/macro_regime_v3.ts#L1183-L1191)
acknowledges the T10Y2Y/T10Y3M historical mix and points to a re-
backfill as the operator fix, but it does NOT name the one-shot-no-
re-classify root cause or the late-FRED race that creates per-row
nulls invisibly.

## Downstream consumer impact

Consumers reading `yield_curve_value` from macro_regimes on rows
classified before commit `4406674` see T10Y2Y values labeled as
T10Y3M's column. Known consumers per repo grep:

- `src/server/regime_dashboard.ts` — the `/#/regime` UI's TodayPanel
  renders `yield_curve_value`.
- `src/server/operator_brief_render.ts` — morning brief surfaces it.
- `src/server/cycle_position.ts` reads upstream `macro_indicators_fred`
  directly (T10Y3M), not via macro_regimes — so cycle_position is NOT
  affected by this row-level staleness.
- `src/server/cross_asset_signals.ts` reads upstream FRED directly too.

**Firing-signal impact:** `yield_curve_inverted` flag was computed from
T10Y2Y on the pre-change rows. Both T10Y2Y and T10Y3M are positive in
the affected window, so the firing decision (`0` = not inverted) is
the same regardless of source — no immediate misclassification. **But**
the diagnostic counter `yield_curve_inversion_days_20d` reads the
trailing 20 T10Y3M values from the bundle, which under the old code
was T10Y2Y — so historical 20d-counter values on those rows reflect
T10Y2Y, not T10Y3M. Forward inversions (when one series inverts before
the other) would produce different firing decisions on the source-mix
rows.

## Resolution paths (orchestration's preliminary classification)

Per ADR-044, this finding is **Tier-2** (calculation logic +
ADR-ratified design). The orchestration MUST NOT auto-fix.

Three paths for operator review:

**Path 1 — Narrow re-classify (mechanical fix, post-ADR-041 dates only).**
Run `backfillMacroRegimesV3({ startDate: '2026-05-20', endDate:
'2026-05-22' })` (or the appropriate npm script) to re-classify the
affected window under the current T10Y3M code. Does not touch
pre-ADR-041 rows (which the docstring explicitly says continue to
carry T10Y2Y by design). Does not shift the ADR-038 baseline because
only post-ADR-041 rows change. Lowest blast radius. Resolves the
visible bug without addressing the architectural root cause. Operator-
gated per ADR-044 + session 44 PUSHBACK convention on any `macro:*`
backfill.

**Path 2 — Daemon refresh-stale loop (architectural fix).**
Extend `classifyLatestMacroRegimeV3` (or add a new daemon step before
it) to re-classify the trailing N business days if their FRED or
breadth inputs have advanced since first classification. Closes the
root cause for future code changes + late-arriving data. Requires
a `RegimeRefreshableDays` constant (suggested: 5 trading days, matches
T10Y3M's typical publish-delay tolerance) and an `ingested_at vs
upstream max(observation_date)` staleness check. Operator-gated as a
classifier code change.

**Path 3 — Daemon timing shift.**
Move the macro classify-today daemon step to AFTER 18:00 ET so FRED's
EOD publish is reliably in CH before the classifier reads it. Fixes
the late-FRED race but not the code-change race. Schedule change only,
no code logic touched. Could pair with Path 1 for cleanup.

**Orchestration's recommendation:** Path 1 for the immediate
correctness gap + Path 2 as a follow-up architectural cycle. Path 3
is a partial fix to a real ops issue but only addresses one of the
two mechanisms.

## What this changes for OQ-C16-1 closure

- OQ-C16-1 is RESOLVED — but the resolution is "Cycle 16's hypothesis
  was wrong, this IS a real Tier-2 correctness issue."
- The smoke-test interpretation rule for future cycles updates to: a
  null + bit 64 on the latest macro_regimes row is suspicious until
  cross-checked against `quantlab.macro_indicators_fred` for T10Y3M's
  max(observation_date) AND against the row's `ingested_at` vs the
  current loader-code commit time.
- The cycle 16 framing "likely no-op; expected behavior under FRED-
  stale > 1 business day" is now retired — it conflates two distinct
  mechanisms (genuine FRED-stale vs late-FRED race + code-change race)
  that produce the same surface symptom but have different root causes
  and different fix paths.

## Side observation (not OQ-C16-1, surface only)

`quantlab.macro_regimes.inputs_missing` is typed `UInt8` at
[src/server/clickhouse.ts:712](src/server/clickhouse.ts#L712) (capacity
0-255), but the bitmask constants in
[src/server/macro_regime_v3.ts](src/server/macro_regime_v3.ts) go up to
`INPUTS_MISSING_PUT_CALL = 1 << 9 = 512`. Bits 8+ (TLT, PUT_CALL) would
silently truncate when written. Probe: this hasn't fired in practice
yet because T10Y3M (bit 6 = 64) and BREADTH (bit 4 = 16) dominate the
observed values, but a row with bits 8+ set would lose those bits at
the storage boundary. Tracked separately from OQ-C16-1.
