# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-18 (session 82 close — **Phase C migration APPLIED + post-apply DOC sweep + commit consolidation + doctrine close + LIVE VERIFICATION + bug fix**: operator ran `npm run migrate:drawdown-state-history-per-strategy:apply` (9→9 row parity; atomic RENAME; `drawdown_state_history_v0_backup` retained pending ≥24h verification). Post-apply DOC sweep added [SPEC §8.5 operator playbook](../docs/specs/strategy-tagged-drawdown-state.md) and closed the s78 `calibration-on-the-shelf` framing across 3 files. Commit consolidation landed 4 topical commits: `f9e22cc` s75-77 framework rescale, `33779cd` s78-79 put/call retune, `da6fd46` s80-82 strategy-tagged dd_state, `c00ed03` doctrine close. **Doctrine close (Pejman explicit):** L5/A5 + stage1/2/4 = status quo affirmed in [SPEC §4.3](../docs/specs/drawdown-response-framework.md). **LIVE VERIFICATION (this beat):** ingested fresh data (macro:ingest + fred:ingest + cboe:ingest — CBOE 403 expected; DataShop-gated), classified 2026-05-18 (`regime=yellow firing=1` hyg_spy_divergence=1), ran `npm run daemon:daily` — **per-strategy flip confirmed LIVE**: daemon log emitted 3 `[drawdown-state ...]` lines (portfolio + mean_reversion_v1 + trend_v1), Telegram sent, 31.9s total. **Bug fix:** `npm run brief:morning` initially failed with CH ILLEGAL_AGGREGATION (code 184) on `loadLatestAllScopes` — `argMax(source, evaluated_at) AS source` collided with the WHERE clause's `source` name resolution; fixed by wrapping the FROM in a subquery (`a52c964`). Post-fix the brief renders the per-strategy panel cleanly with both strategy rows. SPEC §8.5 signals 1+2 now both verified; ≥24h wall-clock still gates `--drop-backup`.)

## What this session delivered

Session 82 took the s81 handoff's recommended default-next slice — Phase C migration BUILD — and shipped it autonomously per full-delegation posture, then the operator executed `--apply` against production CH to close out the destructive step. The build side delivered the script + 19 unit tests + 3 npm aliases; the apply side flipped the production schema in ~63 ms of total DDL/DML work (29ms CREATE + 19ms INSERT-SELECT + 15ms RENAME) with row-count parity holding at 9 rows on both sides. No code changes accompanied the apply itself — the script was already shipped in build form.

### Verdict

Phase C is functionally complete from the system's perspective. Remaining operator action: ≥24h watch for healthy per-strategy daemon writes, then run `--drop-backup`. Highlights:

- **Migration script delivered and exercised against production** ([`scripts/migrate_drawdown_state_history_per_strategy.ts`](../scripts/migrate_drawdown_state_history_per_strategy.ts)): six pre-checks all passed; three planned steps executed in order; pre/post row counts both 9 (FINAL on source); backup table retained per design.
- **Production CH schema is now post-Phase-C**: canonical `quantlab.drawdown_state_history` engine = ReplacingMergeTree(evaluated_at), ORDER BY `(source, bundle_id, evaluated_at)`, `bundle_id` column present with DEFAULT ''. The pre-migration 9 rows are all portfolio-aggregate (sentinel `bundle_id = ''`) by definition.
- **Daemon behavior flips on next run automatically**: the s81 bootstrap probe will now see `bundle_id` column present → constructs the repository with `bundleIdColumnPresent: true` → after the portfolio evaluation, `runDaemonStrategyDrawdownEvaluations` runs and writes per-strategy rows. Morning brief's per-strategy panel begins rendering. **No additional operator action is needed for the flip itself.**
- **Backup table is the rollback handle**: `quantlab.drawdown_state_history_v0_backup` is intact; a swap-back via `RENAME TABLE` is the rollback path if the next daemon run surfaces a problem.
- **Tests + tsc + check:help unchanged** by the apply: apply does not touch TS code. Baseline 1333/0/6, tsc 13-error baseline, check:help green.

### Headline result table

| Element | Status |
| --- | --- |
| **Migration script — dry-run / apply / drop-backup modes** | **✓ shipped s82** |
| **Migration tests — 19 unit tests** | **✓ shipped s82** |
| **npm aliases + help entries** | **✓ shipped s82** |
| **Phase C migration APPLY (destructive RENAME against production CH)** | **✓ APPLIED s82 — 9→9 parity, ~63ms total** |
| Phase C `--drop-backup` (destructive DROP of `_v0_backup`) | ☐ pending — operator-authorized; gated on ≥24h healthy-write verification |
| Phase A SPEC + pure-function surface (s80) | ✓ preserved |
| Phase B CODE (repository + daemon + brief) (s81) | ✓ preserved |
| Tests | **1333 pass / 0 fail / 6 skipped** (no change from build-time beat) |
| npx tsc --noEmit | 13 errors (unchanged baseline) |
| npm run check:help | ✓ green |

### Test baseline (unchanged by apply)

```text
npm test                       1333 pass / 0 fail / 6 skipped   (unchanged from s82 build beat)
npx tsc --noEmit               13 errors (IDENTICAL to baseline; no new errors)
npm run check:help             green
.venv/Scripts/python.exe -m pytest scripts/tests   164/164  (Python untouched this session)
```

### Concrete state changes (this session in total — build + apply)

1. **[scripts/migrate_drawdown_state_history_per_strategy.ts](../scripts/migrate_drawdown_state_history_per_strategy.ts)** — NEW (build beat). ~280 lines. Exports `DDL_NEW_TABLE`, `DML_INSERT_SELECT`, `DDL_RENAME`, `DDL_DROP_BACKUP`, `planMigrationSteps`, `verifyPreState`, `rowCount`, `DATABASE`, `CANONICAL_TABLE`, `NEW_TABLE`, `BACKUP_TABLE`, `EXPECTED_OLD_KEY`, `EXPECTED_NEW_KEY`, `help`. `main()` orchestrates dry-run / apply / drop-backup paths.
2. **[scripts/tests/migrateDrawdownStateHistoryPerStrategy.test.ts](../scripts/tests/migrateDrawdownStateHistoryPerStrategy.test.ts)** — NEW (build beat). 19 tests across 3 describe blocks.
3. **[package.json](../package.json)** — EDITED (build beat). Added 3 npm scripts.
4. **Production CH schema** — APPLIED (apply beat). `quantlab.drawdown_state_history` now has new ORDER BY + `bundle_id` column; `quantlab.drawdown_state_history_v0_backup` is the pre-migration snapshot (9 rows, old ORDER BY `(source, evaluated_at)`, no `bundle_id`).
5. **[.claude/HANDOFF.md](./HANDOFF.md)** — REWRITE. This document.

### What is NOT changed this session

- **No code changes accompanied the apply.** The destructive step ran against the build that already shipped earlier in the session; the daemon, repository, and brief modules from s81 are unchanged.
- **No CONFIG_VERSION bump.** The daemon's bootstrap probe is what flips behavior; no config rev was required by the apply step.
- **No s80/s81 code changes.** The pure-function surface (s80 Phase A) + repository / daemon / brief wire-up (s81 Phase B) are unchanged.
- **No CBOE arm changes.** s78 put/call retune + s79 backfill unchanged.
- **No daemon-default flips.** Retargeting ON, useRiskConfig ON, halt enforce-mode ON — all unchanged.
- **Working tree from s74-s81 still unstaged**; s82 adds 3 files to the working set. Commit packaging Pejman-decision still pending (Open Questions #4).

## Where we are

Session 82 closed both the BUILD and the APPLY of the s80 SPEC §8.1 destructive migration. Next concrete events:

1. **Next daily daemon run (~within 24h)** — bootstrap probe sees `bundle_id` column present → daemon writes one portfolio row + one row per live strategy bundle. Brief begins rendering the per-strategy panel.
2. **~24h after the apply** — operator verifies daemon `[drawdown-state strategy=<bid>]` log lines fired + morning brief renders per-strategy panel + no anomalies, then runs `npm run migrate:drawdown-state-history-per-strategy:drop-backup` to drop `quantlab.drawdown_state_history_v0_backup`.

| Bucket | Status |
| --- | --- |
| All s73-s81 lock-ins | ✓ as documented in prior handoffs |
| Strategy-tagged dd_state architectural SPEC | ✓ s80 |
| Strategy-tagged dd_state Phase A CODE (pure-function surface) | ✓ s80 |
| Strategy-tagged dd_state Phase B CODE (repository + daemon + brief) | ✓ s81 |
| Strategy-tagged dd_state Phase C migration BUILD | ✓ s82 build beat |
| **Strategy-tagged dd_state Phase C APPLY (destructive RENAME against production CH)** | **✓ s82 apply beat — 9→9 parity** |
| Phase C `--drop-backup` | ☐ pending — operator-authorized; gated on ≥24h healthy-write window |
| CBOE DataShop subscription (2019-present coverage) | ☐ deferred — Pejman-decision (paid; "we'll decide later") |
| L5/A5 σ-band rescale decision | ✓ s82 doctrine close — status quo affirmed (parent SPEC §4.3); reopens at §12 retune or operator doctrine pivot |
| stage1/stage2/stage4.failDrawdown rescale | ✓ s82 doctrine close — status quo affirmed (parent SPEC §4.3); reopens at §12 retune or ADR-039 amendment ratifying doctrine pivot |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — sizer-mode data when it fires (~2026-08-29 earliest); §12 of s80 SPEC mandates per-strategy retune ALONGSIDE portfolio retune in the same ADR |
| s78 docstring/spec cleanup (calibration-on-the-shelf framing) | ✓ s82 post-apply DOC sweep |
| Phase C operator playbook (§8.5) | ✓ s82 post-apply DOC sweep |
| Commit consolidation (s74-s82) | ☐ Pejman-decision — working tree now carries 9 sessions unstaged + this DOC sweep |

## Decisions locked in

### Session 82 apply beat (this beat)

**A1. The `--apply` ran against production with the daemon in an idle window.** Pre-checks confirmed engine = ReplacingMergeTree, current ORDER BY = `(source, evaluated_at)`, `bundle_id` absent, no leftover `_new` or `_v0_backup`, no pending mutations, source `count(*) FROM ... FINAL = 9`. All six s82 build-time architectural decisions held in production exactly as designed: CREATE-NEW + INSERT-SELECT (FINAL on source) + atomic two-table RENAME; INSERT enumerated columns and omitted `bundle_id` so DEFAULT '' fired; row-count parity (9 = 9) verified BEFORE the RENAME; backup retained after RENAME for the verification window.
`Why:` no surprise — the script was unit-test-pinned to this exact behavior and the production CH state matched the pre-check expectations cleanly.
`How to apply:` future destructive migrations follow the same template — pre-check verdict → planned steps printout → row-count parity BEFORE swap → post-checks → backup retained until operator-driven cleanup.

**A2. `_v0_backup` is the rollback handle for the verification window.** A swap-back via `RENAME TABLE quantlab.drawdown_state_history TO quantlab.drawdown_state_history_new_failed, quantlab.drawdown_state_history_v0_backup TO quantlab.drawdown_state_history` returns the system to pre-migration state.
`Why:` if the first per-strategy daemon write surfaces a problem we didn't catch in s81 unit tests, this is the no-data-loss escape hatch.
`How to apply:` DO NOT run `--drop-backup` until the operator has observed ≥1 daemon cycle with healthy `[drawdown-state strategy=<bid>]` log lines + a clean morning brief render. The Phase C-apply rollback option only exists while `_v0_backup` is present.

### Session 82 build beat (carried from earlier in this session)

**1-6.** Six architectural decisions documented in the build-beat handoff that this rewrite supersedes. All six held in production during the apply beat — see git history of `.claude/HANDOFF.md` for the original wording.

### Carried locked decisions (sessions 41-81)

All sessions 41-81 lock-ins preserved unchanged. See git history and prior handoffs.

## Open questions

### HIGH (Pejman decisions pending — but not blocking)

1. **`--drop-backup` timing.** Recommended: ≥24h after the apply AND after the operator has eyeballed at least one daemon cycle's `[drawdown-state strategy=<bid>]` log lines + the morning brief's per-strategy panel render. The drop-backup mode is idempotent and a single npm alias — no further preparation needed when greenlit.

2. ~~**L5/A5 rescale decision**~~ — ✓ closed s82 doctrine close (status quo affirmed per parent SPEC §4.3).

3. ~~**stage1/stage2/stage4.failDrawdown rescale**~~ — ✓ closed s82 doctrine close (status quo affirmed per parent SPEC §4.3).

4. ~~**Commit strategy for s74-s82 working tree**~~ — ✓ closed s82 (3 commits landed: `f9e22cc` s75-77, `33779cd` s78-79, `da6fd46` s80-82). Working tree now carries only the s82 doctrine-close SPEC §4.3 amendment + this HANDOFF update.

5. **CBOE DataShop subscription decision** — carried from s73-s81; Pejman directed "we'll decide later."

### CARRIED HIGH (unchanged from s73-s81)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription.
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- 12 Phase 9+ gap inventory items — FROZEN per s63 directive until 2026-06-29.

### Closed this session

- ~~Phase C migration BUILD~~ — shipped s82 build beat.
- ~~Phase C migration apply window~~ — operator ran `--apply` against production this session.
- ~~SPEC §11 test #25 (`--dry-run` prints planned steps without execution)~~ — shipped s82 build beat (planMigrationSteps byte-pin tests + dry-run is the default mode).
- ~~SPEC §11 test #26 (`--apply` against fresh table produces correct end state)~~ — exercised against production in this session's apply beat; row-count parity confirmed end state correct.
- ~~Phase C operator playbook~~ — added as SPEC §8.5 in [`docs/specs/strategy-tagged-drawdown-state.md`](../docs/specs/strategy-tagged-drawdown-state.md) covering pre-conditions, verification commands, drop-backup procedure, rollback procedure, and post-drop terminal state.
- ~~s78 docstring/spec cleanup (calibration-on-the-shelf framing)~~ — closed in [`src/server/macro_regime_v3.ts`](../src/server/macro_regime_v3.ts) docstring + [`docs/specs/macro-regime-classifier-phase1_v3.md`](../docs/specs/macro-regime-classifier-phase1_v3.md) §2.3 footnote (a) + [`docs/obsidian/04 - Regime Classifier (phase1_v3).md`](../docs/obsidian/04%20-%20Regime%20Classifier%20%28phase1_v3%29.md) threshold table. All three now correctly state gate (a) closed by s79 backfill, gate (b) DataShop 2019-present still open. ADR-038 amendment in [`docs/decisions/README.md`](../docs/decisions/README.md) preserved as historical record.
- ~~Commit consolidation for s75-s82 working tree~~ — landed as 3 topical commits: `f9e22cc` s75-77 framework rescale, `33779cd` s78-79 put/call retune, `da6fd46` s80-82 strategy-tagged dd_state. Working tree post-commit is clean except editor state.
- ~~L5/A5 σ-band rescale decision~~ — closed as **status quo affirmed** in [parent SPEC §4.3](../docs/specs/drawdown-response-framework.md). σ-band math documented (-3% would be the proportional rescale); doctrine question identified as canon-thin and resolved per Pejman: "hard kill is system-failure marker, not graduated tier." L5/A5 stay at -0.20 / -20.
- ~~stage1/stage2/stage4.failDrawdown rescale~~ — closed as **status quo affirmed** in [parent SPEC §4.3](../docs/specs/drawdown-response-framework.md). Same doctrine logic; ADR-039 §1 originals preserved. No ADR-039 amendment filed.
- ~~SPEC §8.5 verification signals 1+2~~ — both confirmed live this session. Signal 1: daemon emitted `[drawdown-state strategy=mean_reversion_v1]` + `[drawdown-state strategy=trend_v1]` log lines on first run post-apply. Signal 2: morning brief renders the per-strategy panel with rows for both strategies. ≥24h wall-clock pre-condition still gates `--drop-backup` (apply happened ~hours ago in this session).
- ~~CH brief query bug (`loadLatestAllScopes` ILLEGAL_AGGREGATION)~~ — surfaced on first live brief render post-apply; fixed by wrapping the FROM in a subquery so the WHERE filter doesn't collide with the `argMax(...) AS source` SELECT alias. Commit `a52c964`. Tests pass identically; brief renders cleanly. **The 28 s81 Phase B unit tests didn't catch this** — `FakeClickHouse` records query strings for regex assertions but does NOT parse SQL against CH's grammar; the production CH run was the first time the query was actually executed.

## Next stage

### Operator-side default (recommended)

**Wait for next daemon cycle, then verify, then `--drop-backup`.** No assistant action required for the daemon flip itself — it's automatic via the s81 bootstrap probe. After the next `npm run daemon:daily` completes:

- Inspect daemon log for `[drawdown-state strategy=<bid>]` lines (one per live strategy bundle, plus one portfolio line).
- Run `npm run brief:morning` and verify the per-strategy panel renders with rows for each live bundle.
- If both signals are healthy → run `npm run migrate:drawdown-state-history-per-strategy:drop-backup` (≥24h after apply) to remove `quantlab.drawdown_state_history_v0_backup`.

### Alternative dev slices (assistant can run autonomously)

| Option | Stage | Effort | Note |
| --- | --- | --- | --- |
| Commit s74-s82 work | DECISION-ACT | ~15 min | 9 sessions + DOC sweep unstaged; assistant can stage + commit per Pejman direction (NOT autonomous) |
| ~~s78 docstring cleanup~~ | ~~DOC~~ | — | ✓ closed in s82 post-apply DOC sweep |
| ~~Operator playbook doc for `--drop-backup`~~ | ~~DOC~~ | — | ✓ closed in s82 post-apply DOC sweep as SPEC §8.5 |
| ~~L5/A5 σ-band rescale~~ | ~~SPEC + CODE~~ | — | ✓ closed s82 doctrine close (status quo affirmed; SPEC §4.3) |
| ~~stage1/2/4 ADR-039 amendment~~ | ~~RESEARCH + SPEC + CODE~~ | — | ✓ closed s82 doctrine close (status quo affirmed; SPEC §4.3) |

### Bucket 3 candidates (post-s82)

1. **Phase C `--drop-backup`** — operator-authorized; ~1 min when greenlit; idempotent. Operator playbook in [`docs/specs/strategy-tagged-drawdown-state.md`](../docs/specs/strategy-tagged-drawdown-state.md) §8.5.
2. **Drawdown framework §12 90d empirical retune** — sizer-mode data when it fires (~2026-08-29 earliest); §12 of s80 SPEC mandates per-strategy retune in the same ADR.
3. **CBOE DataShop subscription decision** — Pejman call.

### Bucket 2 — FROZEN until 2026-06-29 per s63 directive

12 Phase 9+ gaps. Re-evaluate after paper-trading verdict + ADR sign-offs.

### Track A — background

Daily `npm run daemon:daily` continues. Defaults: retargeting ON, useRiskConfig ON, halt enforce-mode ON, drawdown framework with s77-rescaled L1-L4 + s77-rescaled stage3.failDrawdown. CBOE arm live for 2008-2019 corpus (s79 backfill). **Next daemon run flips to N+1 per-strategy evaluation automatically** via the s81 bootstrap probe (which now sees `bundle_id` column present). No further code change required for the flip.

## Files / code state

### NEW this session (session 82 — build beat)

- [scripts/migrate_drawdown_state_history_per_strategy.ts](../scripts/migrate_drawdown_state_history_per_strategy.ts) — NEW.
- [scripts/tests/migrateDrawdownStateHistoryPerStrategy.test.ts](../scripts/tests/migrateDrawdownStateHistoryPerStrategy.test.ts) — NEW.

### EDITED this session

- [package.json](../package.json) — EDITED (build beat): 3 new npm aliases.
- [docs/specs/strategy-tagged-drawdown-state.md](../docs/specs/strategy-tagged-drawdown-state.md) — EDITED (DOC sweep beat): added §8.5 "Operator playbook — post-apply verification and drop-backup".
- [src/server/macro_regime_v3.ts](../src/server/macro_regime_v3.ts) — EDITED (DOC sweep beat): docstring cleanup on `PUT_CALL_COMPLACENCY_LOW` (gate (a) closed framing). Comment-only; no tsc/test impact.
- [docs/specs/macro-regime-classifier-phase1_v3.md](../docs/specs/macro-regime-classifier-phase1_v3.md) — EDITED (DOC sweep beat): §2.3 footnote (a) calibration-on-the-shelf framing closed.
- [docs/obsidian/04 - Regime Classifier (phase1_v3).md](../docs/obsidian/04%20-%20Regime%20Classifier%20%28phase1_v3%29.md) — EDITED (DOC sweep beat): threshold table caption for `PUT_CALL_COMPLACENCY_LOW`.
- [docs/specs/drawdown-response-framework.md](../docs/specs/drawdown-response-framework.md) — EDITED (doctrine close beat): added §4.3 "L5/A5 + stage1/2/4 doctrine close — status quo affirmed". σ-band math documented; doctrine question identified as canon-thin and resolved status-quo per Pejman.
- [src/server/drawdown_state_repository.ts](../src/server/drawdown_state_repository.ts) — EDITED (verification beat): fixed `loadLatestAllScopes` ILLEGAL_AGGREGATION (CH code 184) by wrapping the FROM in a subquery so WHERE doesn't see the `argMax(...) AS source` SELECT alias. Commit `a52c964`. Tests 1333/0/6 unchanged.
- [.claude/HANDOFF.md](./HANDOFF.md) — REWRITE (apply beat + DOC sweep + commit consolidation + doctrine close + verification + bug fix).

### UNCHANGED but reference (carried from s73-s81)

- [src/server/drawdown_state.ts](../src/server/drawdown_state.ts) — s80 Phase A pure-function surface.
- [src/server/drawdown_state_repository.ts](../src/server/drawdown_state_repository.ts) — s81 Phase B repository; the script's `--apply` makes this module's `bundleIdColumnPresent: true` path live on the next daemon run.
- [src/server/daemon_live_trades.ts](../src/server/daemon_live_trades.ts) — s81 Phase B daemon helpers.
- [scripts/daily_signal_daemon.ts](../scripts/daily_signal_daemon.ts) — s81 Phase B bootstrap probe + per-cell dispatch.
- [src/server/operator_brief.ts](../src/server/operator_brief.ts) + [operator_brief_render.ts](../src/server/operator_brief_render.ts) — s81 Phase B per-strategy panel.
- [src/server/macro_regime_v3.ts](../src/server/macro_regime_v3.ts) — s78 retune.
- [src/server/capital_deployment_config.ts](../src/server/capital_deployment_config.ts) — s77 stage3.
- [src/server/regime_dashboard.ts](../src/server/regime_dashboard.ts) — s79 ADR_038_BASELINE.
- [scripts/_threshold_stability_sweep*.ts](../scripts/) — s74-s76 sweeps.
- [docs/specs/strategy-tagged-drawdown-state.md](../docs/specs/strategy-tagged-drawdown-state.md) — s80 SPEC.
- [scripts/migrate_drawdown_state_history.ts](../scripts/migrate_drawdown_state_history.ts) — s67 original DDL.

### Working-tree status

Working tree carries (unstaged, pending Pejman commit direction):

- s74: framework §4.1 mr_v1 rescale + tests.
- s75: trend_v1 sister sweep + handoff.
- s76: blended-portfolio sweep + handoff.
- s77: framework round-2 rescale + SPEC §4.2 + test updates + handoff.
- s78: CBOE put/call retune + diagnostic + SPEC §2.3 footnote + tests/obsidian/handoff updates.
- s79: macro_regimes rerun + `ADR_038_BASELINE` re-pin + test #9b update + ADR-038 amendment + probe script + handoff.
- s80: strategy-tagged dd_state SPEC + parent SPEC cross-links + gap-doc dependency + Phase A pure-function code + Phase A tests (27) + handoff.
- s81: Phase B code (repository + daemon + brief) + Phase B tests (+28) + handoff.
- **s82: Phase C migration script + tests (+19) + 3 npm aliases + handoff (build + apply beats) + post-apply DOC sweep (SPEC §8.5 operator playbook + s78 calibration-on-the-shelf cleanup across 3 files).**

9 sessions of unstaged work. s82 is now a coherent "Phase C build + apply + DOC sweep" commit and can land on its own. **The apply itself is NOT in the working tree** — it's a production CH state change, not a code change.

### CH state (POST-APPLY — changed this session)

| Table | Status |
| --- | --- |
| `quantlab.macro_regimes` (phase1_v3) | 4,622 rows; distribution `{131,359,1473,2659}`; s79 backfill live |
| `quantlab.drawdown_state_history` | **POST-PHASE-C**: ReplacingMergeTree(evaluated_at), ORDER BY `(source, bundle_id, evaluated_at)`, `bundle_id LowCardinality(String) DEFAULT ''` present. 9 pre-migration rows preserved with sentinel `bundle_id = ''`. Daemon flips to N+1 per-strategy writes on next run. |
| `quantlab.drawdown_state_history_v0_backup` | **NEW (pre-migration snapshot)**: 9 rows, old ORDER BY `(source, evaluated_at)`, no `bundle_id`. Drop via `--drop-backup` after ≥24h healthy-write verification. |
| All other tables | unchanged from s79 |

### Tests (post-s82 apply — unchanged)

```text
npm test                       1333 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests   164/164
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             green
```

## Watch-outs

### NEW from verification beat (session 82)

- **FakeClickHouse doesn't catch CH-grammar bugs.** The `loadLatestAllScopes` ILLEGAL_AGGREGATION bug (CH code 184; `argMax(source, evaluated_at) AS source` collided with WHERE `source = {source:String}`) was NOT caught by the 28 s81 Phase B unit tests, because FakeClickHouse records query strings for regex assertions but doesn't parse SQL against ClickHouse's actual grammar. **Test design implication:** future CH-query code with non-trivial semantics (aggregates, subqueries, FINAL) needs SOME path to grammar validation — either an integration test against a real CH instance or a dedicated CH-syntax linter — or the bugs surface only on production CH execution. For now, the run-against-production-after-shipping cadence is the de-facto integration test. Watch for this on future repository extensions.

- **The per-strategy flip on the first live daemon run worked end-to-end** post-fix: bootstrap probe → repository construction with `bundleIdColumnPresent: true` → portfolio write → per-strategy writes (one per live bundle) → brief panel render. All four hops exercised against real CH this session. The s81 architecture is verified live.

### NEW from apply beat (session 82)

- **`_v0_backup` is the rollback handle and MUST NOT be dropped until ≥24h + healthy-write verification.** A swap-back is `RENAME TABLE quantlab.drawdown_state_history TO quantlab.drawdown_state_history_failed_new, quantlab.drawdown_state_history_v0_backup TO quantlab.drawdown_state_history` (atomic two-table RENAME). After `--drop-backup` runs, the rollback option is gone and any forward fix must come from re-deriving state from `live_trades` + regime history.

- **The pre-migration 9 rows all carry sentinel `bundle_id = ''`** by design (DEFAULT '' on the new column fires for the INSERT-SELECT). This is the correct portfolio-aggregate sentinel and tools that read the table must treat empty-string `bundle_id` as "portfolio scope" — not as a missing value or a strategy ID. The s80 spec §3.2 codifies this; the s81 repository code reads via this convention.

### NEW from build beat (session 82)

- **`--apply` is destructive and was run during a daemon-idle window.** Atomic RENAME completed in 15ms; no daemon was mid-write. If a future re-apply (e.g. another schema migration) needs to run, the same idle-window posture applies.

- **The script is testable but the end-to-end apply was first exercised against production this session.** The 19 unit tests covered plan-shape + pre-check verdicts + row-count probing against a FakeClickHouse. The first real apply (9→9 rows) succeeded cleanly; future migrations following this template can rely on the precedent but should still pre-check + parity-check before the swap.

- **The script's row-count parity check uses `FINAL` on the source.** If a future change makes a non-FINAL count the right comparison, the parity check needs to update in lockstep. The unit test byte-pins `FROM quantlab.drawdown_state_history FINAL` literally.

### CARRIED load-bearing (unchanged from sessions 41-81)

All session 41-81 watch-outs preserved unchanged.

## Pre-loaded operational reminders

### Phase C migration aliases

```text
npm run migrate:drawdown-state-history-per-strategy                 # dry-run; now reports "already migrated" — safe to re-run for sanity check
npm run migrate:drawdown-state-history-per-strategy:apply           # ALREADY APPLIED — re-run would no-op via pre-check verdict
npm run migrate:drawdown-state-history-per-strategy:drop-backup     # OPERATOR-AUTHORIZED — destructive (after ≥24h healthy-write verify)
```

### Day-glance trio

```text
npm run daemon:daily          # external — Telegram. Next run will flip to N+1 per-strategy evaluation automatically.
npm run audit:positions       # stdout-only — re-run weekly
npx tsx scripts/_paper_trading_review.ts   # stdout-only
npm run brief:morning         # stdout-only markdown — next run begins rendering per-strategy panel
```

### Tests + dev

```text
npm test                                                                       # TS — 1333 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run lint                                                                   # ⚠ Fails at tsc step (13 errors)
npm run check:help                                                             # FULLY GREEN
npm run help                                                                   # Full cheat-sheet, CLEAN
```

### Macro regime backfill + probe

```text
npm run macro:backfill:v3                                # rerun all phase1_v3 rows; idempotent
npx tsx scripts/_probe_putcall_coverage.ts               # s79 — verify CH state matches ADR_038_BASELINE
```

### Drawdown framework recalibration diagnostics (3 generations)

```text
npx tsx scripts/_threshold_stability_sweep.ts                 # mr_v1 (s74) — s80 SPEC §4 consumes the 0.297 ratio
npx tsx scripts/_threshold_stability_sweep_trend_v1.ts        # trend_v1 (s75) — s80 SPEC §4 consumes the 0.110 ratio
npx tsx scripts/_threshold_stability_sweep_blended.ts         # blended (s76) — portfolio scope reference
```

## For the next session — priority order

**Pejman directions needed (NOT bottlenecks):**

- **`--drop-backup` green-light** — ≥24h after apply + healthy-write verification; ~1 min idempotent destructive DROP.
- **CBOE DataShop subscription** — Pejman call; unblocks 2019-present CBOE arm.
- **L5/A5 rescale, stage1/2/4 ADR-039 amendment** — operator-preference σ-band-vs-circuit-breaker calls.
- **Commit strategy** — working tree carries 9 sessions unstaged.

**Recommended dev work if no Pejman activity:**

- Both autonomous-safe doc slices (operator playbook §8.5 + s78 docstring cleanup) closed in s82 post-apply sweep. No further autonomous DOC work queued; remaining candidates are canon-thin and require Pejman direction.

**Background (runs without dev attention):**

- Next `npm run daemon:daily` flips to N+1 per-strategy evaluation automatically. Inspect log for `[drawdown-state strategy=<bid>]` lines + brief for per-strategy panel render.

**DO NOT auto-open without explicit operator green-light:**

- `npm run migrate:drawdown-state-history-per-strategy:drop-backup` (destructive DROP — gated on ≥24h healthy-write verification).
- CBOE DataShop subscription (paid).
- ~~L5/A5 σ-band rescale~~ — closed s82 (status quo). Reopen only on Pejman doctrine pivot or §12 retune surfacing a different verdict.
- ~~stage1/2/4 ADR-039 amendment~~ — closed s82 (status quo). Reopen only on Pejman doctrine pivot or §12 retune.
- All carried items from s73-s81 handoff.

## Important framing for the next chat

Session 82 closed both the BUILD and the APPLY of the s80 SPEC §8.1 destructive migration. The production CH schema is now post-Phase-C; the daemon's behavior flips to N+1 per-strategy evaluation automatically on the next run via the s81 bootstrap probe. No further assistant action is needed for the flip itself.

The chain through s82:

```text
ALL S41-S79 WORK              ✓ as documented
S80 STRATEGY-TAGGED SPEC      ✓ docs/specs/strategy-tagged-drawdown-state.md
S80 PHASE A CODE              ✓ pure-function surface
S80 PHASE A TESTS             ✓ 27 tests
S81 PHASE B CODE              ✓ repository extension + daemon orchestration + morning brief panel
S81 PHASE B TESTS             ✓ 28 tests
S82 PHASE C MIGRATION SCRIPT  ✓ scripts/migrate_drawdown_state_history_per_strategy.ts
S82 PHASE C MIGRATION TESTS   ✓ 19 tests
S82 NPM ALIASES               ✓ 3 new aliases + check:help green
S82 npm test                  ✓ 1333/0/6
S82 npx tsc --noEmit          ✓ 13 errors (unchanged baseline)
S82 PHASE C APPLY (operator)  ✓ 9→9 parity; atomic RENAME; backup retained
S82 HANDOFF                   ✓ this document
  → next: wait for daemon flip on next cycle; verify; ≥24h later run --drop-backup
  → background: daemon flips to N+1 per-strategy evaluation automatically on next run
```

**Parallel-tracks posture continues.** No hard deadlines. All 12 remaining Phase 9+ gaps frozen until 2026-06-29. §12 90d empirical retune (~2026-08-29 earliest) will supersede s77 portfolio thresholds AND s80 per-strategy thresholds in the same ADR. Test baseline 1333/0/6.
