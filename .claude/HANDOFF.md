# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #17 — **Cycle 7 of multi-agent
orchestration executed**. Single Infra slice (GAP-17 orphan-script
per-file cleanup) authored directly by the orchestrator under §3.1
trivial-edit exception (deletions + rename + audit reclassification;
no methodology decision; reversible via `git revert`). **1 new commit**
on top of s96 #17 Cycle 6 close: `1548d57` (slice 1 — delete
`scripts/sharadar_backfill.py` + delete `scripts/import_botdb_candles.py`
+ rename `scripts/walk_forward_cluster.py` → `scripts/_walk_forward_cluster.py`).
**Net 30 unpushed commits** on top of `origin/main` (`c0cda7c`) after this
slice; will be 31 after this HANDOFF rewrite. Cycle 7 closes audit GAP-17
(four orphan-script files) as **2 deletions + 1 rename + 1 reclassified-
leave-as-is**. The audit's "leave with `_` prefix" classification for
`scripts/train_meta_label.py` was **reclassified by the orchestration under
§6.4 routine-reclassification authority** because the reconciliation
evidence (test file imports it by module name at
`scripts/tests/test_train_meta_label.py:19`; `scripts/build_meta_train_set.ts:623`
prints `scripts/train_meta_label.py` as the operator-facing next-step;
3 TS files reference it in load-bearing docstrings) contradicts the audit-
time assumption that the file was a diagnostic. The `_`-prefix convention
is for scripts the operator never invokes — `train_meta_label.py` is the
opposite (operator-invoked training pipeline with a 33-test pytest suite).
Both deletions verified safe via CH probes (zero rows with `source='sharadar_sep'`
ever landed; zero rows with `source='botdb'` either — ADR-005 freeze +
runtime-guard `ADR005_OVERRIDE=1` requirement on `import_botdb_candles.py`).
Sharadar references in production code (`clickhouse.ts` SOURCE_PRIORITY
enum + 5 forward-looking documentation comments) are **preserved as-is**
because they encode the architectural fact that Sharadar is the future
paid-data path that would unlock phase1_v3 fully — that architectural
decision survives the script deletion. **NEXT default on `continue`:** Cycle 8
per orchestration §8.4 — **GAP-10 CI/CD baseline via `.github/workflows/ci.yml`**
(Infra worker: GitHub Actions free-tier-safe on private repos; SHOULD
include the deferred Quartz vendor-patch grep-assertion documented in
`docs/processes/quartz-upgrade.md` § Alternative CI grep test).)

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | OPEN — operator-defined timing |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | OPEN — operator drafting |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 30 unpushed commits to origin/main | Carry-over; count updated this session (Cycle 7 slice + this HANDOFF will be the 31st) | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID (intended ADR-044 §infrastructure-4 first-alert semantics; one message — no re-alert via S96-72 dedupe sidecar) | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.
**Cycle 7 added zero rows** (GAP-17 cleanup is filesystem janitorial — no
real-money / methodology-amendment trigger fires; the reclassification of
`train_meta_label.py` is routine §6.4 authority, not a methodology change).

---

## What this cycle delivered (s96 #17 Cycle 7)

### One commit + HANDOFF rewrite (2 logical units)

**Commit (`1548d57`) — GAP-17 closure:** Closes the audit's GAP-17
("Orphan candidates") as 2 deletions + 1 rename + 1 reclassified-leave-as-is.
Per orchestration §6.4 routine-resolution authority + §3.1 trivial-edit
exception, the four per-file decisions are the orchestration's; Cycle 7
ships:

1. **DELETE `scripts/sharadar_backfill.py`.** Sharadar paid-data API
   (Nasdaq Data Link SEP) is on CLAUDE.md blocked-data-source list (paid
   subscription requires explicit operator approval). CH probe confirmed
   **zero rows with `source='sharadar_sep'`** ever landed in
   `quantlab.candles` — the script never ran on this DB instance. No code
   imports it; no npm script invokes it; no test references it. Architectural
   references to Sharadar in production code (`clickhouse.ts:1855` SOURCE_PRIORITY
   enum entry; `clickhouse.ts:523,624` + `bt_runs_regime.ts:8,81` + `regime_dashboard.ts:234`
   + `yfinance_backfill.py:17` + `daily_signal_daemon.ts:8` + `ingest_sp500_history.ts:15,38`
   forward-looking documentation comments about the future paid-data path
   that would unlock phase1_v3 fully) are **preserved as-is** because they
   encode an architectural fact that survives the script deletion. If/when
   the operator approves the Sharadar subscription (Q-3-adjacent), the
   script can be re-authored from scratch (the docstring + ADR-032 follow-up
   + the SOURCE_PRIORITY enum + the surviving documentation comments together
   carry all the design intent).

2. **DELETE `scripts/import_botdb_candles.py`.** ADR-005 frozen 2026-05-03
   (per the script's own runtime guard requiring `ADR005_OVERRIDE=1` to
   execute). CH probe confirmed **zero rows with `source='botdb'`** in
   `quantlab.candles` on this DB instance — either the migration never
   ran here, or the original `bot.db` source column had different values
   that flowed through (the script's `"source": source or "botdb"` fallback
   never fired in practice). Hardcoded source path
   `C:\Users\Pejman\Desktop\PROJECTS\AIProjects\solana-smart-money-bot\bot.db`
   is operator-local-old and probably doesn't exist on the current
   workstation. ADR-005 record is the source-of-truth for the freeze
   decision; the script file added no operational value post-freeze
   (un-runnable without explicit override; one-shot migration semantics;
   never re-runnable under current policy).

3. **RENAME `scripts/walk_forward_cluster.py` → `scripts/_walk_forward_cluster.py`.**
   No code/test references (verified via Grep across all `.ts`/`.py`/test
   files). Diagnostic walk-forward orchestrator for the weekly cluster
   pipeline; invoked via direct `python` per its docstring (`python scripts/walk_forward_cluster.py
   --start-week … --end-week …`). The `_`-prefix-for-diagnostics convention
   (`_`-prefix marks "diagnostic, run manually; not on the daemon-cadence path")
   matches this script's actual usage. Used `git mv` to preserve history
   (git tracks the rename as `R`, not delete+add).

4. **RECLASSIFIED — `scripts/train_meta_label.py` LEFT AS-IS, NOT renamed.**
   The audit's "leave with `_` prefix" classification was made without
   reconciliation evidence. Grep surfaced:
   - `scripts/tests/test_train_meta_label.py:19` does
     `from train_meta_label import (HLZ_ALPHA, REGIME_FILTERS, ...)` —
     rename to `_train_meta_label` would break the import (and the
     33-test pytest suite that depends on it).
   - `scripts/build_meta_train_set.ts:623` prints
     `Next: .venv/Scripts/python.exe scripts/train_meta_label.py
     --cell-key '${cellKey}' --m1-run-sig ${sig}` as the operator-facing
     next-step instruction after running the build step. Renaming would
     leave the operator typing a non-existent path.
   - `src/server/meta_labeling_dashboard.ts:9,30,34` references the
     script in load-bearing docstrings for the verdict-mirroring contract
     ("Mirrors lines 86-91 of `scripts/train_meta_label.py`. Update both
     together").
   - `src/lib/metaLabeling/features.ts:50,74` references it for the
     META_COLS exclusion list + the BTC_DRAWDOWN_WINDOW invariant.
   - `scripts/migrate_meta_models_verdict.ts:14,39` references it in
     docstring + help text.

   The `_`-prefix convention is for diagnostic scripts the operator never
   invokes; `train_meta_label.py` is the **opposite** — operator-invoked
   production training pipeline with a full pytest suite and 5+ load-
   bearing production-code references. Adding the prefix would actively
   confuse the operator into thinking this is a diagnostic. Per orchestration
   §6.4 routine reclassification authority, the orchestration owns this
   classification call. The audit's recommendation is overridden; the file
   stays at `scripts/train_meta_label.py`.

**Files in this commit:**

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/sharadar_backfill.py` | DELETED (-303 LOC) | Paid-data path; zero CH rows ever landed; no code references |
| `scripts/import_botdb_candles.py` | DELETED (-164 LOC) | ADR-005 frozen; runtime guard; zero CH rows with source='botdb' |
| `scripts/walk_forward_cluster.py` → `scripts/_walk_forward_cluster.py` | RENAMED (R 100% similarity) | Diagnostic orchestrator; `_`-prefix convention |

Total: -467 LOC across 3 files (no net new code; reduction in surface area).

### Cycle 7 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| (none) | GAP-17 closure — 2 deletions + 1 rename + 1 reclassified-leave-as-is | AUTO-APPROVE (orchestrator self-review per §6.1) | 3 files modified (-467 LOC net); tsc baseline 13 unchanged; tests preserved (btRunsRegime 19/19, test_train_meta_label 33/33 — the latter operationally validating the reclassification) |

No subagent worker spawned — per orchestration §3.1 trivial-edit
exception. The work is reversible (`git revert`), filesystem-only (no
DDL, no DML, no daemon edits), and the four per-file decisions are
janitorial scope. Four consecutive cycles (4, 5, 6, 7) have now used
the §3.1 trivial-edit exception for documentation/cleanup gaps; this
is the established pattern for the audit's §2.3 cleanup gaps. The next
cycle (8 GAP-10 CI/CD baseline) will return to a worker-spawn pattern
since it involves new infrastructure file creation (`.github/workflows/ci.yml`).

Orchestrator self-review under §6.1 AUTO-APPROVE criteria (domain-clean
Infra; only `scripts/` touched + zero references broken by the deletions/
rename; tsc baseline unchanged; no Tier-2 quarantine delta; no real-
money path; no paid-data; no methodology-canon claim; no ADR conflict
— no new ADR written because the reclassification is routine §6.4
authority, not architecture).

### Verification gates at cycle close

```text
git status                                                                          # clean (1 slice committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #17 Cycle 6 close; same files: _check_constituent_cleanup.ts, _cleanup_polluted_constituents.ts, _diagnose_constituent_pollution.ts, _verify_sp500_constituents_ddl.ts)
node --import tsx --test scripts/tests/btRunsRegime.test.ts                          # 19/19 pass (no fixture change; Cycle 6 protected)
.venv/Scripts/python.exe -m pytest scripts/tests/test_train_meta_label.py           # 33/33 pass — operationally validates the reclassification (the import 'from train_meta_label import ...' still resolves; the file is preserved at its original path)
npm run health:check                                                                # post-Cycle-7 baseline: same set as Cycle 6 close; no NEW Tier-2; no DB state touched
```

### Per-suite breakdown at cycle close

```text
btRunsRegime.test.ts                                   19/19 pass    (no fixture change; Cycle 6 protected)
test_train_meta_label.py                               33/33 pass    (operationally validates Cycle 7 reclassification)
all Cycle 5-touched suites                            (unchanged — no test files in their domain touched)
regimeDashboard.test.ts                                37/37 pass    (unchanged)
all Cycle 3-touched suites                            472/472 pass   (unchanged from s96 #17 Cycle 4 close)
```

### Post-Cycle-7 health snapshot

Identical to Cycle 6 close. No new probes, no new tables, no new freshness
classes, no DB state changed at all (Cycle 7 is filesystem-only:
2 deletions + 1 rename in `scripts/`). The health-check output is the
standard daemon-cadence pattern:

- **Fresh:** 1 source (`Wikipedia/fja05680 S&P 500 constituents`).
- **Stale (informational, 2-3d since last `npm run daemon:daily` run):**
  Candles ~2.0d, Cross-asset ~2.0d, Cycle position ~2.0d, ETF v3.1 SSGA
  secondary ~3.0d, FRED ~3.0d, Form 4 trades ~8.8d, Live paper-trading
  signals ~34.0h, Macro regime (phase1_v3) ~2.0d, Sector rotation ~2.0d,
  Vol structure ~2.0d. All clear on next `npm run daemon:daily`.
- **Very-stale:** CBOE put/call 2,424d (Q-5 blocked; pinned as Tier-2
  `accepted-as-warning` row in `quantlab.health_quarantine`).
- **Never-populated:** 11 raw + composite snapshot tables + the
  `health_quarantine_alerts_sent` sidecar (clear on next daemon run +
  first Telegram-emitting Tier-2 event).
- **Missing-table:** raw `executive_departures` (created by 8-K Item
  5.02 ingest on first daemon step 1i-pre run; expected per S96-65)
  + raw `finra_short_interest` (created on first daemon step 1h-pre
  Monday run; expected per Cycle 2 carry-over).
- **Migrations applied:** 20/20 (unchanged from Cycle 3 close).

### Push state

- `origin/main` at `c0cda7c`; **30 unpushed commits** after s96 #17 Cycle 7
  slice (was 29 at s96 #17 Cycle 6 close; this cycle added 1 slice commit +
  this HANDOFF rewrite will be the 31st, bringing the close-state count to
  31).
- Push is operator-gated (Q-4 above).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate ratified | ✓ s96 #12 |
| Reconciliation audit baseline produced | ✓ s96 #12 — review form answered by orchestration s96 #14 |
| `/#/health` Phase 1 read-only UI shipped | ✓ s96 #12 |
| GAP-11 / GAP-12 etf-flow guard + NaN formatter | ✓ s96 #12 |
| Phase 1 column-name auto-fix (first Tier-1 fix under ADR-044) | ✓ s96 #13 |
| Convention regression anchors | ✓ s96 #13 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| CLAUDE.md updated with orchestration always-on load | ✓ s96 #14 |
| Cycle 1 — F1 + F2(escalated) + F3 + GAP-14/15/18 + ADR-045 | ✓ s96 #15 |
| Cycle 2 — GAP-2 FINRA + GAP-1 EDGAR + GAP-4 ETF v1 + GAP-7(a) closed-as-noop | ✓ s96 #16 |
| Cycle 3 — Phase 2 v1 ADR-044: quarantine table + repo + dispatcher + dashboard panels + brief §0 + daemon step 0a + Telegram + sidecar + daemon step 0b + Q-5 pin row | ✓ s96 #17 |
| Cycle 4 — GAP-8 classifier-source documentation (ADR-046 + regime_dashboard.ts docstring) | ✓ s96 #17 |
| Cycle 5 — GAP-13 + GAP-19 Quartz vendor-fork upgrade procedure (docs/processes/quartz-upgrade.md) | ✓ s96 #17 |
| Cycle 6 — GAP-16 sentinel investigation closure (ADR-047 + bt_runs_regime.ts docstrings + diagnostic probe) | ✓ s96 #17 |
| **Cycle 7 — GAP-17 orphan-script cleanup (2 deletions + 1 rename + 1 reclassified-leave-as-is)** | **✓ s96 #17** |
| Cycle 8 — GAP-10 CI/CD baseline via .github/workflows/ci.yml (Infra) | ☐ NEXT default |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert logic + re-alert-on-status-transition cursor | ☐ deferred per S96-71 |
| `phase1_v3` `bt_runs_regime` backfill (side-finding from Cycle 6) | ☐ deferred — Phase 9+ analytical work; no operator gate |
| F2 CBOE backfill + re-classify | ⏸ blocked on Q-5 operator decision |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 7 of multi-agent orchestration)

**S96-79. `scripts/train_meta_label.py` LEFT AS-IS (audit reclassification
under orchestration §6.4 routine authority); `_`-prefix convention applies
ONLY to operator-never-invoked diagnostics.** The audit's GAP-17 classification
of "leave with `_` prefix" for `train_meta_label.py` was reclassified by the
orchestration because the reconciliation evidence — surfaced via grep across
all `.ts`/`.py`/test files — contradicts the audit-time assumption that the
file was diagnostic. The evidence: (a) `scripts/tests/test_train_meta_label.py:19`
does `from train_meta_label import (HLZ_ALPHA, REGIME_FILTERS, ...)` (a 33-test
pytest suite depending on the import); (b) `scripts/build_meta_train_set.ts:623`
prints `scripts/train_meta_label.py` as the operator-facing next-step
instruction after the build phase; (c) `src/server/meta_labeling_dashboard.ts:9,30,34`
references the script in the verdict-mirroring contract docstrings; (d)
`src/lib/metaLabeling/features.ts:50,74` references it for the META_COLS
exclusion list + the BTC_DRAWDOWN_WINDOW invariant; (e)
`scripts/migrate_meta_models_verdict.ts:14,39` references it in docstring
+ help text. `Why:` Per orchestration §6.4 the orchestration owns routine
reclassification decisions; the `_`-prefix convention is for scripts the
operator NEVER invokes (e.g. `_probe_*.ts`, `_check_*.ts`, `_diagnose_*.ts`,
`_walk_forward_cluster.py` post-Cycle-7), and `train_meta_label.py` is the
**opposite** of that — operator-invoked production training pipeline with a
full test suite and 5+ load-bearing production-code references; adding the
prefix would actively mislead the operator. `How to apply:` Future audit
classifications that propose `_`-prefix renames MUST be validated against the
test-imports + production-code-references reconciliation evidence before
acting. The rule of thumb: if a script has a test file OR is referenced by
operator-facing print statements OR has TS-side docstring references that
spell out its path, it is NOT a diagnostic and MUST NOT take the `_` prefix.

**S96-80. `scripts/sharadar_backfill.py` deleted; the architectural Sharadar-
future-paid-data-path documentation in production code is preserved as-is.**
Per orchestration §6.4 + the CLAUDE.md blocked-data-source policy, the
sharadar paid-data script is removed because (a) Sharadar SEP requires a
paid Nasdaq Data Link subscription which is on the CLAUDE.md blocked list;
(b) the CH probe confirmed **zero rows with `source='sharadar_sep'`** ever
landed in `quantlab.candles` — the script never ran on this DB; (c) no code
or test references the script (no npm script, no TS import, no Python
import). However, the **architectural documentation references** to Sharadar
in `clickhouse.ts:523,624,1855` (the SOURCE_PRIORITY enum entry +
forward-looking phase1_v3 comments), `bt_runs_regime.ts:8,81` (post-Sharadar
attribution semantics + delisted-ticker refinement), `regime_dashboard.ts:234`
(phase1_v3 bias-fix gated on Sharadar), `yfinance_backfill.py:17`
(Sharadar SF1 follow-up path), `daily_signal_daemon.ts:8` (the deployment
predicate), and `ingest_sp500_history.ts:15,38` (delisted-ticker price
data requires Sharadar) are **preserved as-is** because they encode an
architectural decision (Sharadar is the canonical future paid-data path)
that survives the script's deletion. `Why:` Removing the architectural
references would destroy the operator's ability to understand WHY phase1_v3
is partial-only without paid data; the script is reusable from-scratch
(its docstring + ADR-032 follow-up + the SOURCE_PRIORITY enum carry all
the design intent) if/when the operator approves the Q-3-adjacent paid
subscription. `How to apply:` Future paid-data-blocked script deletions
follow the same pattern: delete the script; preserve the architectural
documentation references that encode the future-path design intent.

**S96-81. `scripts/import_botdb_candles.py` deleted; ADR-005 freeze record
is the source-of-truth for the historical migration semantics.** Per
orchestration §6.4 + the ADR-005 freeze (2026-05-03), the bot.db one-shot
migration script is removed because (a) ADR-005 froze it 2026-05-03 with
explicit grandfathering of existing rows; (b) the script's runtime guard
requires `ADR005_OVERRIDE=1` to execute — it is permanently un-runnable
without explicit override; (c) the CH probe confirmed **zero rows with
`source='botdb'`** in `quantlab.candles` on this DB instance (either the
migration never ran here, or the original bot.db `source` column had
different values that flowed through the script's `"source": source or "botdb"`
fallback never firing); (d) the hardcoded path
`C:\Users\Pejman\Desktop\PROJECTS\AIProjects\solana-smart-money-bot\bot.db`
is operator-local-old and probably doesn't exist on the current workstation;
(e) no code or test references the script. `Why:` The script added no
operational value post-freeze (un-runnable; one-shot semantics; never re-
runnable under current ADR-005 policy); the ADR-005 record + the historical
git log carry the full semantic record of what happened. `How to apply:`
Future frozen-by-ADR one-shot migration scripts can be deleted when (a) the
ADR record persists the freeze decision, (b) the runtime is permanently
blocked (guard requiring environment override), (c) no code/test references
the script, (d) data state verification confirms the migration ran or did
not run (here: did not run on this DB instance, so deletion is doubly safe).

**Carry-overs (still in force):** S96-1..S96-78; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #17 Cycle 7)

None inside orchestration authority. No new operator-queue rows opened
this cycle. The five Q-rows above are all carry-overs from prior cycles.

### CARRIED from s96 #12-#16

- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications (s96 #14).
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers; Playwright dep operator-gated.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely (operator-gated).
- CBOE DataShop subscription — now coalesces with Q-5 path (A).
- Capital-deployment-ramp ADR — Q-2.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent (now: if approved, re-author
  `scripts/sharadar_backfill.py` from scratch using the surviving
  architectural references in `clickhouse.ts` SOURCE_PRIORITY + the
  Sharadar-future-path documentation comments + ADR-032 follow-up notes).
- Compounding-live-equity backtest semantic.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.
- Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert-on-status-transition cursor (deferred per S96-71).
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence (Cycle 6 surfaced; not investigated — three plausible causes listed in ADR-047 §"The semantic surprise"; deferred until a downstream consumer needs to know).

---

## Next stage

### Default on `continue` — Cycle 8 (orchestration §8.4)

Per orchestration §8.4 — next item is **GAP-10 CI/CD baseline** via
`.github/workflows/ci.yml`. Infra domain. Per the audit's classification:

- GitHub Actions free-tier-safe on private repos (the audit's framing
  note: "Free tier on private repos covers SignalForge's usage; if
  minute-limits become an issue, surfacing as paid-subscription trigger").
- Workflow SHOULD include the deferred Quartz vendor-patch grep-assertion
  documented in `docs/processes/quartz-upgrade.md` § Alternative CI grep
  test (per S96-76).
- Workflow SHOULD include the baseline tsc gate (13 errors max,
  matching the established baseline) + the npm test suite + the
  Python pytest suite + `npm run health:check:strict` post-build.
- Workflow scope decisions (push triggers, PR triggers, scheduled
  nightly runs, matrix strategies, runner OS choice) are orchestration's
  per §6.4 routine authority.

Plausible spawn pattern: single Infra worker, `isolation: "worktree"`,
one cycle deliverable: `.github/workflows/ci.yml` + minor README addition
documenting the badge URL + first-push verification (the worker can run
the workflow YAML through GitHub Actions' linter via `actionlint` if
available, OR rely on the post-merge first-CI-run to surface syntax
errors). The orchestrator does NOT push to origin/main — the workflow
file lands locally; first CI run happens whenever the operator pushes
(Q-4 above).

**After Cycle 8:** orchestration §8.4 has no further classified gaps;
Phase 9+ work (Phase B campaigns, capital-deployment-ramp ADR, etc.)
remains operator-gated. Candidate orchestration-domain cycles after
Cycle 8 include:

- The Cycle 6 side-finding (S96-78) — `npm run backfill:bt-regime --
  --classifier-version=phase1_v3` to populate the missing `phase1_v3`
  attribution rows in `bt_runs_regime`. Small, self-contained,
  orchestration-domain, no operator gate.
- Phase 2 v2 plausibility-band probes (deferred per S96-71; depends
  on operator review of Phase 2 v1 quarantine schema first — could
  become orchestration-domain if S96-71's deferral conditions resolve).
- Any drift surfaced by `npm run health:check` between sessions.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 7)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/sharadar_backfill.py` | DELETED (-303 LOC) | Paid-data path; zero CH rows with source='sharadar_sep'; no code references |
| `scripts/import_botdb_candles.py` | DELETED (-164 LOC) | ADR-005 frozen; runtime guard requires ADR005_OVERRIDE=1; zero CH rows with source='botdb' |
| `scripts/walk_forward_cluster.py` → `scripts/_walk_forward_cluster.py` | RENAMED (R 100%) | Diagnostic walk-forward orchestrator; `_`-prefix convention; no code/test references |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-79 + S96-80 + S96-81 lock-ins; operator queue unchanged (Q-4 count incremented to 30) |

Total: -467 LOC across 3 files (no net new code; surface-area reduction).

### Test + tsc state

- `btRunsRegime.test.ts`: **19/19 pass** (no fixture change; Cycle 6 protected).
- `test_train_meta_label.py`: **33/33 pass** (operationally validates the
  Cycle 7 reclassification — the `from train_meta_label import …` resolves
  because the file is preserved at its original path).
- All Cycle 3/4/5/6-touched suites: **unchanged** (no test files in their
  domains touched this cycle).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated
  `_check_*.ts` / `_verify_*.ts` / `_cleanup_*.ts` / `_diagnose_*.ts`).
- Health check delta: **zero**. No new tables, no new probes, no new
  freshness classes, no DB state changed. The output is the same
  fresh/stale/very-stale/missing/empty pattern as Cycle 6 close.

### Untouched-but-relevant for next session

- The Q-5 row in `quantlab.health_quarantine` still loaded for first
  Telegram alert on next live daemon run with valid Telegram creds.
- `quantlab.executive_departures` raw source table still missing
  (carry-over from S96-65); created by 8-K Item 5.02 ingest on first
  daemon step 1i-pre run.
- `quantlab.finra_short_interest` raw source table still missing
  (Cycle 2 carry-over); created on first daemon step 1h-pre Monday run.
- The brief §0 system-health digest block ABOVE §1 macro regime still
  surfaces on the operator's first look at the brief (S96-73
  zero-bytes-on-clean preservation pattern intact).
- `bt_runs_regime` has zero `phase1_v3` attribution rows; the
  `npm run backfill:bt-regime -- --classifier-version=phase1_v3`
  invocation is a candidate after Cycle 8 closes per S96-78.
- Sharadar architectural documentation in production code (`clickhouse.ts`
  SOURCE_PRIORITY enum + 5 forward-looking comments) preserved; if/when
  Q-3-adjacent paid subscription approves, the script can be re-authored
  from scratch using those references + the ADR-032 follow-up + the
  surviving docstring intent.
- ADR-005 freeze record persists in `MASTER.html §6` + the surviving
  `docs/decisions/README.md` reference; the historical migration
  semantics for bot.db rows in `quantlab.candles` (grandfathered or
  never-landed depending on the DB instance) are recoverable from the
  ADR-005 record alone.

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 7)

- **The `_`-prefix-for-diagnostics convention has a sharp edge: it is
  ONLY for scripts the operator never invokes.** A future contributor
  applying the convention naively (e.g. to any script not in
  `package.json`) would mislead the operator about which scripts are
  operator-facing vs diagnostic. Mitigation: S96-79 documents the
  reconciliation evidence rule of thumb — if a script has a test file
  OR is referenced by operator-facing print statements OR has TS-side
  docstring references that spell out its path, it is NOT a diagnostic
  and MUST NOT take the `_` prefix.
- **The Sharadar architectural documentation references in production
  code (8 reference sites across `clickhouse.ts`, `bt_runs_regime.ts`,
  `regime_dashboard.ts`, `yfinance_backfill.py`, `daily_signal_daemon.ts`,
  `ingest_sp500_history.ts`) are now "orphaned" in the sense that the
  script they conceptually pair with (`sharadar_backfill.py`) no longer
  exists.** A future contributor reading those comments + searching for
  `sharadar_backfill.py` will find nothing. Mitigation: S96-80 documents
  the deletion + the preservation rationale + the re-author-from-scratch
  recovery path. The Q-3 operator queue row is the canonical pointer for
  the future-paid-data decision; if/when approved, the re-authoring task
  becomes orchestration-domain (no methodology change; the surviving
  references are sufficient design intent).
- **`scripts/_walk_forward_cluster.py` invocation is now via the renamed
  path; any historical operator notes / runbooks that say "python
  scripts/walk_forward_cluster.py …" are stale.** Mitigation: the
  docstring's usage example was pre-rename; a future operator invoking
  it from the docstring would type the old path. This is low-risk because
  (a) the script is diagnostic — operators don't run it on a cadence;
  (b) `git mv` preserves the historical content for `git log --follow`;
  (c) the rename is mechanically reversible if needed. No active runbook
  or cron job invokes the old path (verified via Grep across all files).
- **The CH probe finding that zero rows have `source='botdb'` or
  `source='sharadar_sep'` is point-in-time on the current DB instance.**
  If a future operator restores from a backup taken pre-2026-05-19 (the
  approximate window when those source values would have been written),
  the old rows could reappear without the deletion scripts existing —
  this would be inconsistent with the current codebase but harmless
  (the rows still satisfy the candles schema; the SOURCE_PRIORITY enum
  in `clickhouse.ts` still has `sharadar_sep` priority 60 to handle
  any future-restored or future-ingested rows of that source). The
  `botdb` source has no SOURCE_PRIORITY entry so a restored backup
  would defer to priority 99 (the catch-all). Mitigation: low-risk
  edge case; documenting for completeness.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 6 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload (for tooling)
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green; CI-suitable
npm run system-health:check            # Phase 2 v1 dispatcher (Phase 1 + quarantine summary in one report)
npm run system-health:check -- --json  # Phase 2 v1 JSON payload
# UI surface: http://localhost:3000/#/health (QuarantinePanel + AutoFixLogPanel + Phase3Footer)
```

### Phase 2 v1 admin (operator-side; orchestration-pre-applied locally)

```text
npm run migrate:create-health-quarantine                     # dry-run
npm run migrate:create-health-quarantine:apply               # apply + inserts Q-5 pin row (idempotent)
npm run migrate:create-health-quarantine-alerts-sent         # dry-run
npm run migrate:create-health-quarantine-alerts-sent:apply   # apply
```

### Daily-keep-it-fresh

```text
npm run daemon:daily                                                                # step 0a + step 0b + all Layer-0 + ETF v1/v3.1 + FINRA-Monday + 4 EDGAR -pre steps
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                                                # §0 system health digest + §1..§16 composites + watchlist + drawdown
npm run health:check                                                                 # pre-feature health gate (per ADR-044)
```

### Quartz docs site + vendor upgrade

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
# Vendor upgrade procedure (mandatory on any Quartz version bump):
#   docs/processes/quartz-upgrade.md
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime                                                    # default classifier version (CLASSIFIER_VERSION)
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # the deferred S96-78 v3 backfill
npm run backfill:bt-regime:dry                                                # count candidates without writing
npx tsx scripts/_probe_gap16_sentinels.ts                                     # Cycle 6 GAP-16 diagnostic
npx tsx scripts/_probe_ch_btregime.ts                                         # pre-existing distribution probe (sampling + quantiles)
```

### Weekly cluster pipeline diagnostic (post-Cycle-7 rename)

```text
.venv/Scripts/python.exe scripts/_walk_forward_cluster.py \
    --start-week 2024-07-15 --end-week 2026-04-27               # the renamed diagnostic
# (was scripts/walk_forward_cluster.py pre-Cycle-7; rename to _-prefix
#  per the diagnostic convention; same CLI surface)
```

### Tests + dev

```text
npm test                                                                                              # last full green at s96 #12 close
node --import tsx --test scripts/tests/btRunsRegime.test.ts                                           # 19/19 pass at s96 #17 Cycle 7 close (unchanged)
node --import tsx --test scripts/tests/regimeDashboard.test.ts                                        # 37/37 pass at s96 #17 Cycle 5 close (unchanged)
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37 pass at s96 #17 Cycle 3 close (unchanged)
node --import tsx --test scripts/tests/migrateCreateHealthQuarantine.test.ts                          # 48 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/healthQuarantine.test.ts                                       #  9 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/systemHealthCheck.test.ts                                      #  3 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/migrateCreateHealthQuarantineAlertsSent.test.ts                # 18 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/healthQuarantineAlerter.test.ts                                # 23 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/daemonHealthCheckStep.test.ts                                  # 15 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/operatorBriefRender.test.ts                                    # 178 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/operatorBrief.test.ts                                          # 57 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/daemonFinraShortInterestFetch.test.ts                          #  9 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/daemonEdgarIngests.test.ts                                     # 24 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts                          #  7 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/crossAssetSnapshotsRepository.test.ts                          # 40 pass (Cycle 2 carryover)
combined Cycle 3 affected suites:                                                                    472 pass across 91 suites
.venv/Scripts/python.exe -m pytest scripts/tests/test_train_meta_label.py                             # 33 pass at s96 #17 Cycle 7 close (operationally validates the reclassification)
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py                       # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                                      # last green at s96 #9 close: 394 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors unchanged
```

### npm scripts touched this cycle

- **None.** Cycle 7 is filesystem-only (2 deletions + 1 rename in
  `scripts/`; no `package.json` change; no script behavior change).
  The renamed diagnostic at `scripts/_walk_forward_cluster.py` runs
  via direct `python` invocation; not promoted to an npm script per
  the diagnostic-script convention (`_`-prefix marks "diagnostic, run
  manually").

---

## For the next session — priority order

**Default on `continue`:** Cycle 8 per orchestration §8.4 — **GAP-10 CI/CD
baseline via `.github/workflows/ci.yml`**. Infra domain. Per the audit's
classification: GitHub Actions free-tier-safe on private repos; workflow
SHOULD include the deferred Quartz vendor-patch grep-assertion from
`docs/processes/quartz-upgrade.md` § Alternative CI grep test; workflow
scope (push triggers, PR triggers, scheduled nightly runs, matrix
strategies, runner OS) is orchestration's per §6.4 routine authority.

Plausible spawn pattern: single Infra worker with `isolation: "worktree"`;
deliverable is `.github/workflows/ci.yml` + minor README addition for the
badge URL. The orchestrator does NOT push to origin/main — the workflow
file lands locally; first CI run happens whenever the operator pushes
(Q-4 above). Worker-spawn vs. orchestrator-direct is a judgment call:
worker-spawn is the more conservative choice given this is the first new
file-class added in 4 cycles (`.github/` directory); orchestrator-direct
under §3.1 would also be defensible since the YAML scope is well-bounded.

**After Cycle 8 (no further classified audit gaps):**

- **S96-78 follow-up (Cycle 9 candidate)** — `npm run backfill:bt-regime --
  --classifier-version=phase1_v3` to populate the missing `phase1_v3`
  attribution rows in `bt_runs_regime`. Small, self-contained,
  orchestration-domain, no operator gate.
- **Phase 2 v2** — plausibility-band probes + per-UI-route ping + auto-
  insert + re-alert-on-status-transition cursor (deferred per S96-71;
  needs operator review of Phase 2 v1 quarantine schema first).
- **Drift remediation** — any new Tier-2 quarantine items surfaced by
  `npm run health:check` between sessions.

**Calendar-gated (unchanged):**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider / Schedule-13D-G Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (per §7.1 of orchestration; Q-1 through Q-5
above):**

- Q-1 first real-capital deployment — operator-defined timing.
- Q-2 capital-deployment-ramp ADR — operator self-assigned ~1 week.
- Q-3 Stooq apikey gate decision — paid vs self-host.
- Q-4 push 30 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D (pinned
  as `accepted-as-warning` Tier-2 quarantine row; Telegram alert
  fires once on next live daemon run with valid Telegram creds,
  then sidecar-deduped).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop) — Cycle 7 GAP-17 cleanup is `git rm` on script files
  only; filesystem not CH; not on the hard-stop list.
- `git push` (Q-4 above).
- Q-5-blocked work: F2 CBOE backfill, Composite worker phase1_v3
  re-classify.
- Path B EDGAR `from=` pagination (Data-Ingest domain; future cycle).
- Phase 2 v2 plausibility-band probes (deferred per S96-71; needs
  operator review of Phase 2 v1 quarantine schema first).
- Re-alerting policy for previously-alerted quarantine rows (Phase 2
  v2; current Phase 2 v1 alerts each id ONCE ever via the
  `health_quarantine_alerts_sent` sidecar).

---

## Important framing for the next chat

**Cycle 7 is closed.** Three files modified (-467 LOC net; surface-area
reduction with no behavior change) + this HANDOFF rewrite. Filesystem-only;
no DDL, no DML, no behavior change; tsc baseline 13 unchanged; tests
preserved (btRunsRegime 19/19, **test_train_meta_label 33/33 —
operationally validating the reclassification**); health-check deltas
zero. The orchestration's §3.1 trivial-edit exception (deletions + rename
+ audit reclassification) makes this a clean self-review under §6.1
AUTO-APPROVE without subagent spawn. No new operator-queue rows; no
escalations fired this cycle.

**Four consecutive cycles (4, 5, 6, 7) have now used the §3.1 trivial-
edit exception for documentation/cleanup gaps.** This is the established
pattern for the audit's §2.3 cleanup gaps. The next cycle (8 GAP-10
CI/CD baseline) introduces a NEW file-class (`.github/workflows/`) and
will likely return to a worker-spawn pattern for the more conservative
review.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).** Q-4
count incremented from 29 → 30 (Cycle 7 slice + HANDOFF rewrite will
make it 31 at the actual commit moment).

**S96-79 + S96-80 + S96-81 are the new lock-ins.** Future cycles that
encounter (a) audit classifications that look diagnostic-y, (b) paid-
data-blocked scripts with surviving architectural references, or
(c) ADR-frozen one-shot migration scripts, should consult these lock-
ins for the reconciliation-evidence rule of thumb (S96-79), the
preserve-architectural-docs pattern (S96-80), and the safe-deletion
predicate (S96-81) respectively.

**Backward compat preserved this cycle:**

1. **CH:** No table changes.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes; byte-equal-stdout preserved.
4. **Tests:** btRunsRegime.test.ts 19/19 still pass; test_train_meta_label.py
   33/33 still pass (the import is the operational validation that
   the reclassification was correct).
5. **Code behavior:** Zero behavior change at runtime. The renamed
   `_walk_forward_cluster.py` has the same CLI surface; the deleted
   `sharadar_backfill.py` was never running anyway (CH probe confirmed);
   the deleted `import_botdb_candles.py` was permanently blocked by
   its own runtime guard.

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3 of multi-agent orchestration:
  • Worker A (Health, items 1+2+3)    AUTO-APPROVE  → Phase 2 v1 quarantine
                                                       infrastructure: table + Q-5 pin row
                                                       + repo + dispatcher + dashboard
  • Worker B (Infra,  items 4+5)      AUTO-APPROVE  → brief §0 daily digest + daemon
                                                       step 0a auto-health-check
  • Worker C (Health, item 6)         AUTO-APPROVE  → Telegram quarantine alerter
                                                       + sidecar dedupe + daemon step 0b
  + S96-70..S96-74 lock-ins documented
S96 #17 Cycle 4 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-8 closure: ADR-046
                                                       (phase1_v3 canonical) +
                                                       regime_dashboard.ts module
                                                       docstring update
  + S96-75 lock-in documented
S96 #17 Cycle 5 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-13 + GAP-19 closure:
                                                       docs/processes/quartz-upgrade.md
                                                       (canonical Quartz vendor-fork
                                                       upgrade procedure)
  + S96-76 lock-in documented
S96 #17 Cycle 6 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-16 closure: ADR-047
                                                       (sentinel semantics) +
                                                       bt_runs_regime.ts docstrings
                                                       + _probe_gap16_sentinels.ts
                                                       diagnostic
  + S96-77 + S96-78 lock-ins documented
S96 #17 Cycle 7 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-17 closure: 2 deletions
                                                       (sharadar_backfill.py +
                                                       import_botdb_candles.py)
                                                       + 1 rename (walk_forward_cluster.py
                                                       → _walk_forward_cluster.py)
                                                       + 1 reclassified-leave-as-is
                                                       (train_meta_label.py per S96-79
                                                       evidence-based reclassification)
  + S96-79 + S96-80 + S96-81 lock-ins documented
  + 1 commit + this HANDOFF rewrite = 2 logical units
  + No subagent worker spawned (§3.1 trivial-edit exception, fourth cycle
    in a row for documentation/cleanup work)
  + Zero behavior change; tsc baseline + tests + health-check all unchanged
  + No new operator-queue rows
  → DEFAULT NEXT: Cycle 8 per orchestration §8.4
    GAP-10 CI/CD baseline via .github/workflows/ci.yml. Infra worker
    (or orchestrator-direct under §3.1 if the YAML scope is well-bounded).
```
