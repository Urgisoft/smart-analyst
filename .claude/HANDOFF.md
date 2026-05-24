# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 10 of multi-agent
orchestration executed**. Single orchestrator-driven slice (S96-78 closure
— the recommended Cycle 10 starting point per Cycle 9 close): operator ran
`npm run backfill:bt-regime -- --classifier-version=phase1_v3` to
completion (197,064 / 197,064 attributed · 0 errors · 0 skips · 2234.2s
runtime ≈ 37 min · 88.2 rows/s steady-state). **Zero source-file changes**
this cycle — pure DB-state operation. Post-backfill verification ran an
inline tsx query against ClickHouse to confirm: (a) `phase1_v3` row count
in `bt_runs_regime` is exactly **197,064**, matching `phase1_v2`'s
**197,064** (full coverage parity); (b) attribution split is **118,665
`window` + 78,399 `sentinel_no_trades`** — the sentinel count matches the
**GAP-16 / ADR-047** Cycle 6 finding exactly (the documented zero-trade
pattern carries through identically into v3); (c) dominant regime
distribution is **118,504 `green` + 161 `yellow` + 78,399 `unknown`**
(unknown = sentinel rows, expected); (d) window `dominant_share` quantiles
are **p05=0.532 · p50=0.828 · p95=0.95 · range [0.469, 1.0]** — plausible
distribution showing dominant regime claims supermajority on the median
run. **1 new commit** on top of s96 #17 Cycle 9 close: this HANDOFF
rewrite (HANDOFF-only because there is no source-file diff to commit).
**Net 37 unpushed commits** on top of `origin/main` (`c0cda7c`) after this
HANDOFF rewrite (was 36 at Cycle 9 close · +1 this HANDOFF). Cycle 10
closes S96-78 (the phase1_v3 attribution coverage gap surfaced in Cycle 6
GAP-16 investigation) and produces no new operator-queue rows. **Spawn
pattern this cycle:** orchestrator self-edit only — no worker spawn was
needed because the slice was a single npm-script invocation (per
orchestration §3.1 trivial-edit exception); the operator ran the
invocation locally and reported the result. **Pre-merge gate locally
verified:** `npx tsc --noEmit` returns the documented 13 baseline errors
unchanged; `npm run health:check` returns the same set as Cycle 9 close
(no NEW Tier-2 from the DB-state operation); `git status` clean; full
`npm test` not re-run this cycle because no source-file diff (last green
at Cycle 9 close: **3319/3338 pass + 19 skip + 0 fail**). **Caveat
preserved (not new):** `phase1_v3` attribution downstream of 2019 still
rests on the CBOE corrupted-input window per ADR-045 / Q-5 — the backfill
applied the classifier *as currently defined*; the upstream input quality
is the operator-gated methodology decision, not a bug in this cycle's
work. **NEXT default on `continue`:** Cycle 11 candidate per orchestration
§8.4 follow-up — recommended path is **`/#/regime` browser smoke-test +
post-backfill UI validation** (open the dashboard, confirm the regime
panel now surfaces phase1_v3 attribution data, screenshot or pin any
rendering issue). Alternative: **Phase 2 v2 spec drafting** (the design
doc for plausibility-band probes + per-UI-route ping + auto-insert logic
+ re-alert-on-status-transition cursor — orchestration-domain spec work
that doesn't require Phase 2 v1 operator review to begin).

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
| Q-4 | Push 37 unpushed commits to origin/main (Cycle 10 HANDOFF brings the count to 37) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID (intended ADR-044 §infrastructure-4 first-alert semantics; one message — no re-alert via S96-72 dedupe sidecar) | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.
**Cycle 10 added zero rows.** S96-78 closure is composite-domain
DB-state operation (no real-money path; no DDL; no source-file diff;
the backfill writes to `bt_runs_regime` which is a derived attribution
table, not a real-money allowlist file per orchestration §7.2). The
phase1_v3 attribution rows that *include CBOE-corrupted-input
classifications* are governed by Q-5 above; this cycle did not change
that classification logic or that quarantine row.

---

## What this cycle delivered (s96 #17 Cycle 10)

### One DB-state slice + HANDOFF rewrite (2 logical units, 1 commit)

**DB-state slice (no commit):** `npm run backfill:bt-regime --
--classifier-version=phase1_v3` ran end-to-end against local CH.

Operator's reported terminal output:

```text
[196093/197064] 99.5% · 88.2/s · 2223s elapsed
[196277/197064] 99.6% · 88.2/s · 2225s elapsed
…
[197064/197064] 100.0% · 88.2/s · 2234s elapsed
✓ Done in 2234.2s
  total              : 197064
  attributed         : 197064
  skipped (no-op)    : 0
  errors             : 0
```

Backfill characteristics:

- **Runtime:** 2234.2s ≈ 37m 14s. Above the S96-78 lower-bound estimate
  (5-15 min) because `phase1_v3` has a richer feature set than
  `phase1_v2` (more CBOE+VIX+yield-curve+TIPS inputs per row).
- **Throughput:** ~88 rows/s steady-state.
- **Coverage:** 100% — every `bt_runs` row in CH got a corresponding
  `phase1_v3` attribution row. Zero skips, zero errors.

**Post-backfill verification (orchestrator-only, no commit):** inline
`npx tsx -e` against the existing `getClickHouse()` helper to query
`quantlab.bt_runs_regime FINAL` for four checks. Results:

```text
--- rows per classifier_version ---
  phase1_v2: 197,064
  phase1_v3: 197,064          ← parity confirmed

--- phase1_v3 attribution_source split ---
  window:              118,665
  sentinel_no_trades:   78,399  ← matches GAP-16 / ADR-047 exactly

--- phase1_v3 dominant_regime ---
  green:    118,504  (= 118,665 − 161; window-attribution majority)
  unknown:   78,399  (= sentinel count exactly; expected)
  yellow:       161  (the small green/yellow split within window-attribution)

--- phase1_v3 window dominant_share quantiles ---
  p05: 0.532    p50: 0.828    p95: 0.950    lo: 0.469    hi: 1.000
```

**Interpretation:**

1. **Row-count parity with `phase1_v2`** (197,064 = 197,064 exact)
   confirms the backfill walked the same `bt_runs` keyset that
   `phase1_v2` already covers; no rows skipped, no rows dropped, no
   rows double-counted. This was the structural correctness check.
2. **Sentinel count matches GAP-16 / ADR-047** (78,399 = 78,399 exact)
   confirms the v3 attribution code path takes the same sentinel branch
   as v2 for zero-trade `bt_runs` rows. The sentinel pattern was the
   Cycle 6 finding documented in ADR-047 and explicitly preserved
   across classifier versions.
3. **Window dominant_share quantiles in plausible range** (p50=0.828
   means the median run's dominant regime claims 83% of its window;
   p05=0.532 means even the least-dominant runs still show a clear
   majority regime). This is the plausibility check — a green-bull-
   market dominant period across most of the historical window should
   produce green-dominant attribution most of the time, which is
   exactly what we observe.

**HANDOFF rewrite (this commit):** the Cycle 10 close-out documenting
the slice + verification + S96-86 lock-in.

### Cycle 10 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (per §3.1 trivial-edit exception) | S96-78 closure — single npm-script invocation + post-run CH verification query | AUTO-APPROVE (no critic spawn; the trivial-edit exception explicitly allows orchestrator-driven slices that involve no source-file diff and no canon-thin decision; the backfill itself is a deterministic operator-runnable script with documented behavior per the existing CLI surface in `package.json`) | Operator ran the script locally; orchestrator verified post-state via CH query; row-count parity + sentinel match + plausible dominant_share quantiles all confirmed. Tsc baseline 13 unchanged; health check unchanged; no source-file diff. |

**Decision: no critic spawn for this slice** (orchestration §3.1 +
§6.1). Per the trivial-edit exception:
- No source-file diff (only the HANDOFF rewrite, which is orchestrator-
  only per §1).
- No canon-thin methodology decision (the backfill applies the
  already-locked-in `phase1_v3` classifier without re-tuning anything).
- No real-money path file touched (per §7.2 allowlist).
- No paid-data source, no auth scrape.
- No ADR conflict (the existing ADRs documenting `phase1_v3` are
  unchanged).
- No new test required (the backfill code path is exercised by the
  existing `npm run backfill:bt-regime` tests; the cycle's verification
  is a query, not new code).

Critic spawn for a zero-source-diff slice would have added orchestration
overhead without proportionate signal gain. The §3.1 trivial-edit
exception covers exactly this case.

### Verification gates at cycle close

```text
git status                                                                          # clean (1 HANDOFF rewrite pending, no other changes)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #17 Cycle 9 close; same files: _check_constituent_cleanup.ts, _cleanup_polluted_constituents.ts, _diagnose_constituent_pollution.ts, _verify_sp500_constituents_ddl.ts)
npm run health:check                                                                # post-Cycle-10 baseline: same set as Cycle 9 close; no NEW Tier-2 from the backfill
git worktree list                                                                   # main only (no worker spawned this cycle)
inline CH query: rows per classifier_version                                        # phase1_v2: 197,064 · phase1_v3: 197,064 (parity)
inline CH query: phase1_v3 attribution_source                                       # window: 118,665 · sentinel_no_trades: 78,399 (matches ADR-047)
inline CH query: phase1_v3 dominant_regime                                          # green: 118,504 · yellow: 161 · unknown: 78,399
inline CH query: phase1_v3 window dominant_share quantiles                          # p05: 0.532 · p50: 0.828 · p95: 0.950
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail
                                                       ← NOT re-run this cycle (no source-file diff)
                                                       ← last green at Cycle 9 close: same numbers
                                                       ← will re-run on next source-file slice
gicsSectorRepositoryHelper.test.ts (targeted)         13/16 pass + 3 skip + 0 fail
                                                       ← unchanged from Cycle 9 close
btRunsRegime.test.ts                                   19/19 pass    (unchanged from Cycle 6)
test_train_meta_label.py                               33/33 pass    (unchanged from Cycle 7)
regimeDashboard.test.ts                                37/37 pass    (unchanged from Cycle 5)
all Cycle 3-touched suites                            472/472 pass   (unchanged from Cycle 4 close)
```

### Post-Cycle-10 health snapshot

Identical to Cycle 9 close. No new probes, no new tables, no new freshness
classes. The DB-state change (phase1_v3 attribution rows in
`bt_runs_regime`) is a derived-attribution write — `bt_runs_regime` is
not on the health-check freshness probe list (it's a backfill-cadence
table, not a daily-cadence table), so the cycle's work does not surface
in the health snapshot. This is expected.

- **Fresh:** 1 source (`Wikipedia/fja05680 S&P 500 constituents`).
- **Stale (informational, ~2-4d since last `npm run daemon:daily` run):**
  Candles (2.1d), Cross-asset (2.1d), Cycle position (2.1d), ETF v3.1
  SSGA secondary (3.1d), FRED (3.1d), Form 4 trades (8.8d), Live
  paper-trading signals (35.6h), Macro regime phase1_v3 (2.1d), Sector
  rotation (2.1d), Vol structure (2.1d). All clear on next
  `npm run daemon:daily`.
- **Very-stale:** CBOE put/call 2,424d (Q-5 blocked; pinned as Tier-2
  `accepted-as-warning` row in `quantlab.health_quarantine`).
- **Never-populated:** 11 raw + composite snapshot tables + the
  `health_quarantine_alerts_sent` sidecar.
- **Missing-table:** raw `executive_departures` + raw
  `finra_short_interest`.
- **Migrations applied:** 20/20.

### Push state

- `origin/main` at `c0cda7c`; **37 unpushed commits** after s96 #17
  Cycle 10 HANDOFF rewrite (was 36 at s96 #17 Cycle 9 close, +0 Cycle
  10 source-file diff = 36, +1 this HANDOFF = 37).
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
| Cycle 7 — GAP-17 orphan-script cleanup (2 deletions + 1 rename + 1 reclassified-leave-as-is) | ✓ s96 #17 |
| Cycle 8 — GAP-10 CI/CD baseline (`.github/workflows/ci.yml`) + S96-76 grep-assertion follow-up | ✓ s96 #17 |
| Cycle 9 — OQ-SMP-1 closure (gics_sector_repository_helper SQL shadow-alias fix + GST-1 EXPLAIN-clean pin) | ✓ s96 #17 |
| **Cycle 10 — S96-78 closure (`phase1_v3` bt_runs_regime backfill: 197,064 rows attributed)** | **✓ s96 #17** |
| Cycle 11 — `/#/regime` post-backfill UI smoke-test OR Phase 2 v2 spec drafting | ☐ NEXT default (recommended UI smoke-test) |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert logic + re-alert-on-status-transition cursor (impl) | ☐ deferred per S96-71 (spec can begin in Cycle 11) |
| F2 CBOE backfill + re-classify | ⏸ blocked on Q-5 operator decision |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 10 of multi-agent orchestration)

**S96-86. `bt_runs_regime` now has full `phase1_v3` attribution
coverage (197,064 rows, parity with `phase1_v2`).** Cycle 10 ran
`npm run backfill:bt-regime -- --classifier-version=phase1_v3` to
completion (2234.2s · 0 errors · 0 skips · 88.2 rows/s steady-state).
Post-backfill CH verification confirms row-count parity, attribution-
source split (118,665 window + 78,399 sentinel — sentinel count matches
ADR-047 / GAP-16 exactly), dominant-regime distribution (118,504 green
+ 161 yellow + 78,399 unknown), and plausible window dominant_share
quantiles (p05=0.532 · p50=0.828 · p95=0.95). `Why:` operator visibility
into `phase1_v3` regime attribution was zero-coverage in the
`bt_runs_regime` panel until this cycle; backfill makes the panel
actually informative for the v3 classifier (which is the source-of-
truth classifier per ADR-046 / GAP-8 / S96-75). The backfill is a pure
DB-state operation against a derived attribution table — not a real-
money path file per orchestration §7.2, not a methodology amendment
(`phase1_v3` itself was already locked in pre-Cycle 10). `How to
apply:` (1) When future cycles add a new classifier_version (`phase1_v4`,
etc.), run the same backfill pattern: `npm run backfill:bt-regime --
--classifier-version=<version>` — single npm-script invocation, no
worker spawn needed (orchestration §3.1 trivial-edit exception). (2)
Always verify post-backfill via inline CH query for row-count parity
with the prior version + sentinel-count match against ADR-047 + plausible
dominant_share quantiles — this is the standing verification pattern
for any classifier backfill. (3) Backfill is NOT a real-money path
operation per §7.2; do not escalate to operator queue for the backfill
itself, only for any upstream classifier-methodology amendment that
would require Q-5-style operator gate. **Carry-over (not new):**
`phase1_v3` attribution downstream of 2019 still rests on the CBOE
corrupted-input window per ADR-045 / Q-5 — the backfill applied the
classifier *as currently defined*; the corrupted-input window is
documented in `quantlab.health_quarantine` as `accepted-as-warning`
(S96-70) and remains Q-5's responsibility, not Cycle 10's. The
backfilled rows for runs spanning 2019+ inherit that corruption; no
new quarantine row needed because the existing pin already covers the
methodology-level concern.

**Carry-overs (still in force):** S96-1..S96-85; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### CARRIED from s96 #12-#17

- **OQ-SMP-1 — `readSectorMembershipPanel` query rejected by CH EXPLAIN
  PLAN with `There is no supertype for types String, Date`.** CLOSED
  in Cycle 9 by `b65afd4` (3 SELECT-clause edits dropping redundant
  `toString()` + GST-1 EXPLAIN-clean regression test added). Anti-pattern
  pinned in S96-84.
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
- Sharadar SF1 subscription — Q-3 adjacent (re-author
  `scripts/sharadar_backfill.py` from scratch per S96-80).
- Compounding-live-equity backtest semantic.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.
- Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert-on-status-transition cursor (impl deferred per S96-71; spec drafting unblocked).
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence (Cycle 6 surfaced; not investigated — three plausible causes listed in ADR-047 §"The semantic surprise"; deferred until a downstream consumer needs to know).

---

## Next stage

### Default on `continue` — Cycle 11 candidate (recommended `/#/regime` UI smoke-test)

With S96-78 closed and `bt_runs_regime` now containing full `phase1_v3`
attribution coverage, the standing follow-up queue is:

1. **`/#/regime` post-backfill UI smoke-test (RECOMMENDED).** Open
   `http://localhost:3000/#/regime` in the browser; confirm the regime
   panel now surfaces `phase1_v3` attribution data correctly (per
   ADR-046 / GAP-8 / S96-75, `regime_dashboard.ts` hardcodes
   `phase1_v3` as the source-of-truth classifier; the panel should now
   show meaningful per-regime stats instead of empty rows). This is the
   end-to-end validation that Cycle 10's DB-state change closes the
   loop from operator-visible UI back to the freshly-backfilled
   attribution data. If a rendering bug surfaces, that becomes Cycle 11
   slice 1 (UI worker spawn or orchestrator self-edit depending on
   scope). If the panel renders correctly, document the validation +
   move on to Cycle 12 candidate. **Per orchestration §4.3 + ADR-044
   §UI correctness, this is the standing UI-validation pattern — every
   slice with a UI surface gets a browser smoke-test before the cycle
   declares done; Cycle 10 deferred the UI side because the cycle had
   no UI work, but the panel re-renders Cycle 10's DB state on every
   load, so validating it post-backfill is the natural Cycle 11
   open.**
2. **Phase 2 v2 spec drafting (ALTERNATIVE).** The plausibility-band
   probes + per-UI-route ping + auto-insert logic + re-alert-on-status-
   transition cursor design doc — orchestration-domain spec work that
   doesn't require Phase 2 v1 operator review to begin. Implementation
   stays deferred per S96-71; the spec itself can be written.
3. **Drift remediation (REACTIVE).** Any new Tier-2 quarantine items
   surfaced by `npm run health:check` between sessions.
4. **`settings.json` worker-base configuration (DEFERRED).** Per S96-85,
   the `worktree.baseRef: head` config change would eliminate the
   worktree-base-mismatch class of problems for future worker spawns.
   Default per S96-85 is to defer until the third hit of the pattern;
   Cycle 9 was the first, Cycle 10 didn't spawn a worker, so this is
   still deferred.

Plausible spawn pattern for Cycle 11 option 1: trivial orchestrator
self-edit (open browser, observe, screenshot/document; pin any
finding via Edit if remediation is small) per §3.1 trivial-edit
exception. Worker spawn only if the panel surfaces a non-trivial UI
bug requiring multi-file changes.

**Why `/#/regime` smoke-test over Phase 2 v2 spec:** the smoke-test
closes the validation loop on Cycle 10's work (end-to-end UI → data
visibility). Phase 2 v2 spec drafting is bigger scope, doesn't have a
forcing function, and can wait. The smoke-test is also small enough
that if the panel renders correctly, Cycle 11 closes quickly and Cycle
12 can pick up Phase 2 v2 spec drafting as the substantive cycle.

### Alternative — Cycle 11 could instead pivot to ANY orchestration-domain follow-up

The orchestration is free to defer the smoke-test if the operator
returns with a different priority — `continue` re-enters from this
section and the recommendation isn't a halt-gate.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 10)

| Path | Change | Notes |
| --- | --- | --- |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-86 lock-in; operator queue Q-4 counter updated to 37; Cycle 10 chain entry added; Cycle 11 recommended path documented |

**Source-file diff: zero.** Cycle 10 is a pure DB-state operation
(backfill writes to `bt_runs_regime`); the npm script that performs
the backfill (`scripts/backfill_bt_runs_regime*.ts` per
`package.json`'s `backfill:bt-regime` entry) was not modified — it
was simply invoked. The HANDOFF rewrite is the only file change.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| `quantlab.bt_runs_regime` | INSERT (backfill) | +197,064 rows with `classifier_version='phase1_v3'` | Pure additive write; no UPDATE, no DELETE; pre-existing `phase1_v2` rows untouched |

### Test + tsc state

- `npm test`: **3319/3338 pass + 19 skip + 0 fail** (NOT re-run this
  cycle — no source-file diff; last green at Cycle 9 close).
- `gicsSectorRepositoryHelper.test.ts` (targeted): **13/16 pass + 3
  skip + 0 fail** (unchanged from Cycle 9 close).
- `btRunsRegime.test.ts`: **19/19 pass** (unchanged from Cycle 6).
- `test_train_meta_label.py`: **33/33 pass** (unchanged from Cycle 7).
- All Cycle 3/4/5/6/7/8/9-touched suites: **unchanged** (no test files
  in their domains touched this cycle).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated
  `_check_*.ts` / `_verify_*.ts` / `_cleanup_*.ts` / `_diagnose_*.ts`).
- `npm run check:help`: not re-run this cycle (no help-doc-touching
  source change).
- Quartz patch grep: **both Patch 1 + Patch 2 present** (unchanged).
- Health check delta: **zero**. No new tables, no new probes, no new
  freshness classes, no new Tier-2 quarantine rows.

### Untouched-but-relevant for next session

- The Q-5 row in `quantlab.health_quarantine` still loaded for first
  Telegram alert on next live daemon run with valid Telegram creds.
- `quantlab.executive_departures` raw source table still missing
  (carry-over from S96-65); created by 8-K Item 5.02 ingest on first
  daemon step 1i-pre run.
- `quantlab.finra_short_interest` raw source table still missing
  (Cycle 2 carry-over); created on first daemon step 1h-pre Monday run.
- The brief §0 system-health digest block ABOVE §1 macro regime still
  surfaces on the operator's first look at the brief.
- **NEW:** `bt_runs_regime` now has **197,064 `phase1_v3` attribution
  rows** alongside the pre-existing **197,064 `phase1_v2` rows**. The
  `/#/regime` panel hardcodes `phase1_v3` as source-of-truth per
  ADR-046; Cycle 11's recommended smoke-test validates that the panel
  now surfaces this data.
- The `phase1_v3` backfill applied the classifier *as currently
  defined* — including the CBOE-corrupted-input window 2019-2026 per
  ADR-045 / Q-5. The corrupted-input concern is documented in the
  existing `accepted-as-warning` quarantine row (S96-70); no new
  quarantine row was added by Cycle 10 because the methodology-level
  concern is already pinned.
- Sharadar architectural documentation in production code (`clickhouse.ts`
  SOURCE_PRIORITY enum + forward-looking comments) preserved per S96-80.
- ADR-005 freeze record persists in `MASTER.html §6`.
- `.github/workflows/ci.yml` is staged for first-CI-run on whenever the
  operator pushes (Q-4). Until pushed, CI doesn't execute; no badge URL
  yet (no README at repo root to host one — add when/if one is created).
- `src/server/gics_sector_repository_helper.ts` contains the Cycle 9
  fix (3 SELECT-clause edits dropping `toString(<Date col>) AS
  <same_name>`); future cycles that grep for `toString(` in CH SQL
  helpers should NOT re-introduce the anti-pattern per S96-84.
- GST-1 + SMP-6 EXPLAIN-clean tests in
  `scripts/tests/gicsSectorRepositoryHelper.test.ts` will pin the
  Cycle 9 fix once `quantlab.gics_sector_map` is populated; until then
  they skip via the missing-table path.

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 10)

- **`phase1_v3` attribution downstream of 2019 inherits the
  CBOE-corrupted-input window** (carry-over from ADR-045 / Q-5,
  re-surfaced as a fresh-data caveat now that the rows exist). Any
  Cycle 11+ consumer of the `bt_runs_regime` panel under
  `classifier_version='phase1_v3'` for `bt_runs` spanning 2019+ is
  reading attribution computed against CBOE put/call inputs that are
  themselves stale-from-2019. The existing `accepted-as-warning`
  quarantine row (S96-70) pins this at the methodology level; the
  Cycle 10 backfill did not change the classifier and did not add a
  new quarantine row, but the operator should be aware that the
  attribution rows are now visible in the UI and the caveat applies
  to anyone interpreting them. **Mitigation:** if Cycle 11's UI
  smoke-test reveals a clearer way to flag the corrupted-input window
  in the regime panel (e.g., a visual marker on the 2019-2026 span),
  that becomes a Cycle 11 slice 1 follow-up; otherwise the existing
  quarantine row remains the canonical surface.
- **Backfill runtime ~37 min** (88.2 rows/s steady-state) is slower
  than the S96-78 estimate's lower bound (5-15 min) because
  `phase1_v3` features are richer than `phase1_v2` (more CBOE+VIX+
  yield-curve+TIPS inputs per row). Future backfills against the
  same table should expect similar runtime per classifier version.
  **Mitigation:** for `phase1_v4+` versions, consider adding a
  `--parallelism=<N>` flag to the backfill script if runtime becomes
  a constraint; not needed yet for v3.
- **The backfill is non-idempotent in the sense that re-running the
  same `--classifier-version=phase1_v3` invocation would attempt to
  re-write the same rows** (ReplacingMergeTree semantics handle the
  deduplication via FINAL, but the write volume is repeated). For
  routine cadences (post-`bt_runs` ingest), the backfill should be
  driven by a "missing rows only" filter, not re-running over the full
  keyset. **Mitigation:** the existing `npm run backfill:bt-regime:dry`
  flag should be used to confirm candidate count before any re-run; a
  future enhancement could add `--only-missing` semantics if re-runs
  become routine.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 9 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload (for tooling)
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green; NOT yet in CI (per S96-82 deferral)
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
# CI grep check (fast-fail upstream of the smoke-test):
#   grep -q "gitignore: false" quartz/quartz/util/glob.ts
#   grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime                                                    # default classifier version (CLASSIFIER_VERSION)
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # S96-78 CLOSED Cycle 10 — 197,064 attributed in 2234s; re-run only if rows missing
npm run backfill:bt-regime:dry                                                # count candidates without writing — USE before any re-run
npx tsx scripts/_probe_gap16_sentinels.ts                                     # Cycle 6 GAP-16 diagnostic
npx tsx scripts/_probe_ch_btregime.ts                                         # pre-existing distribution probe (sampling + quantiles; v2-hardcoded)
# Cycle 10 verification pattern (use for any future classifier backfill):
#   npx tsx -e "import('dotenv/config').then(()=>import('./src/server/clickhouse.js')).then(async (m)=>{const ch=m.getClickHouse();async function q(sql,label){const r=await ch.query({query:sql,format:'JSONEachRow'});console.log('--- '+label+' ---');console.log(JSON.stringify(await r.json(),null,2));} await q(\"SELECT classifier_version, count() AS n FROM quantlab.bt_runs_regime FINAL GROUP BY classifier_version ORDER BY n DESC\",'rows per classifier_version'); process.exit(0);});"
```

### Weekly cluster pipeline diagnostic (post-Cycle-7 rename)

```text
.venv/Scripts/python.exe scripts/_walk_forward_cluster.py \
    --start-week 2024-07-15 --end-week 2026-04-27               # renamed diagnostic
```

### CI (s96 #17 Cycle 8 baseline)

```text
# Local pre-push gate (mirrors what CI runs):
npx tsc --noEmit                                                                    # baseline ≤13 errors
npm run check:help                                                                  # help-doc sync
grep -q "gitignore: false" quartz/quartz/util/glob.ts                               # Patch 1
grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts                                    # Patch 2
npm test                                                                            # TS suite (CH-skip path means EXPLAIN-clean tests skip on CI)
pytest scripts/tests                                                                # Python suite
# CI workflow file: .github/workflows/ci.yml
# First CI run: whenever the operator pushes (Q-4)
```

### Tests + dev

```text
npm test                                                                                              # full TS suite — 3319/3338 pass + 19 skip + 0 fail at s96 #17 Cycle 9 close (NOT re-run Cycle 10)
node --import tsx --test scripts/tests/gicsSectorRepositoryHelper.test.ts                             # 13/16 pass + 3 skip + 0 fail at s96 #17 Cycle 9 close
node --import tsx --test scripts/tests/btRunsRegime.test.ts                                           # 19/19 pass at s96 #17 Cycle 6 close (unchanged)
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
.venv/Scripts/python.exe -m pytest scripts/tests/test_train_meta_label.py                             # 33 pass at s96 #17 Cycle 7 close (unchanged)
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py                       # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                                      # last green at s96 #9 close: 394 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors unchanged
```

### npm scripts touched this cycle

- **None.** Cycle 10 is DB-state-only (single npm-script invocation;
  no `package.json` change; no new script wrappers; no DDL; no DML
  beyond the backfill writes themselves).

---

## For the next session — priority order

**Default on `continue`:** Cycle 11 candidate per orchestration §8.4
follow-up queue — **recommended `/#/regime` post-backfill UI
smoke-test**. Trivial orchestrator self-edit (open
`http://localhost:3000/#/regime` in browser; observe whether the regime
panel now surfaces phase1_v3 attribution data per ADR-046 / GAP-8 /
S96-75; document the validation outcome). Self-contained; orchestration-
domain; no operator gate; ~1-5 min runtime. Closing rationale: Cycle
10's DB-state change is end-to-end-validated only when the UI surface
that consumes it renders the data correctly; the smoke-test closes that
loop. If a rendering bug surfaces, Cycle 11 slice 1 becomes UI worker
spawn (or orchestrator self-edit depending on scope) to remediate; if
the panel renders correctly, Cycle 11 closes quickly and Cycle 12 picks
up Phase 2 v2 spec drafting as the substantive cycle.

**Alternative Cycle 11 candidates (orchestration-domain, no operator gate):**

- **Phase 2 v2 spec drafting** — the design doc for plausibility-band
  probes + per-UI-route ping + auto-insert logic + re-alert-on-status-
  transition cursor. Implementation stays deferred per S96-71; the
  spec itself can be written. Larger scope than the smoke-test;
  recommended for Cycle 12 if Cycle 11 closes quickly.
- **Drift remediation** — any new Tier-2 quarantine items surfaced by
  `npm run health:check` between sessions.
- **`settings.json` worker-base configuration** — per S96-85, the
  `worktree.baseRef: head` config change would eliminate the worktree-
  base-mismatch class of problems for future worker spawns. Default
  per S96-85 is to defer until the third hit; still deferred (Cycle 9
  was first hit; Cycle 10 didn't spawn a worker).

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
- Q-4 push 37 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D.

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop) — Cycle 10 backfill is pure additive INSERT only;
  no DDL touched.
- `git push` (Q-4 above).
- Q-5-blocked work: F2 CBOE backfill, Composite worker phase1_v3
  re-classify (Cycle 10's backfill is DIFFERENT from the Q-5-blocked
  re-classify — Cycle 10 wrote `bt_runs_regime` attribution rows using
  the *currently-defined* `phase1_v3` classifier; the Q-5-blocked work
  is the amendment to the classifier itself OR the upstream CBOE
  re-ingest).
- Path B EDGAR `from=` pagination (Data-Ingest domain; future cycle).
- Phase 2 v2 plausibility-band probes (impl deferred per S96-71;
  spec drafting unblocked for Cycle 12+).
- CI extensions that require new infra (CH-in-CI for health:check:strict;
  Vite build job for bundle artifacts; scheduled nightly runs) — surface
  as their own slice when the downstream signal-consumer emerges.

---

## Important framing for the next chat

**Cycle 10 is closed.** One commit (this HANDOFF rewrite) + one
DB-state slice (`npm run backfill:bt-regime -- --classifier-version=
phase1_v3` ran by the operator to completion: 197,064 / 197,064
attributed · 0 errors · 0 skips · 2234s). Pure DB-state operation;
zero source-file diff; tsc baseline 13 unchanged; health check
unchanged. S96-78 closed; full `phase1_v3` attribution coverage in
`bt_runs_regime` now achieved with row-count parity against
`phase1_v2` (197,064 = 197,064), attribution-source split matching
GAP-16 / ADR-047 exactly (78,399 sentinel = 78,399 sentinel), and
plausible window dominant_share quantiles.

**Cycle 10 is the second cycle since Cycle 4 to use the §3.1
trivial-edit exception** (no worker spawn). The slice was a single
npm-script invocation + post-run CH verification query — no canon-thin
decision, no source-file diff, no real-money path file touched. Worker
spawn would have added overhead without proportionate signal gain.
Established pattern for backfill-style DB-state operations: orchestrator
runs the script (or operator runs and reports), orchestrator verifies
post-state, HANDOFF documents the cycle.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).** Q-4
count incremented from 36 → 37 (this HANDOFF rewrite is the only new
commit). No new operator-queue rows from Cycle 10.

**S96-86 is the new lock-in.** Future cycles that add a new
`classifier_version` for `bt_runs_regime` should consult S96-86 for
the standing backfill + verification pattern (run the script + verify
row-count parity + sentinel match + plausible dominant_share quantiles
via inline CH query).

**S96-78 is now CLOSED** — the standing follow-up queue item carried
from Cycle 6 (GAP-16 investigation surfaced the zero-coverage
`phase1_v3` rows in `bt_runs_regime`) → Cycle 7-9 (deferred) → Cycle
10 (closed). Future cycles should not list S96-78 as a follow-up; it
is fully resolved.

**Cycle 11 recommended path: `/#/regime` UI smoke-test** — closes the
end-to-end validation loop on Cycle 10's DB-state change. Small,
self-contained, orchestration-domain. If the panel renders correctly,
Cycle 11 closes quickly; if a rendering bug surfaces, Cycle 11 becomes
a UI remediation cycle.

**Backward compat preserved this cycle:**

1. **CH:** `bt_runs_regime` gained 197,064 new rows with
   `classifier_version='phase1_v3'`; the pre-existing 197,064
   `phase1_v2` rows are untouched (additive INSERT only). The table's
   ReplacingMergeTree semantics ensure FINAL queries return one row per
   `(run_id, classifier_version)` key.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes; the brief does not currently
   surface `bt_runs_regime` attribution directly.
4. **Tests:** All previously-passing suites still pass (NOT re-run
   this cycle; no source-file diff).
5. **Code behavior:** Zero behavior change at runtime; the backfill
   script itself was already in `package.json` as `backfill:bt-regime`;
   the Cycle 10 invocation is a routine operator-runnable script
   execution, not a code path change.

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3 of multi-agent orchestration:
  • Worker A + B + C (Health/Infra)   AUTO-APPROVE  → Phase 2 v1 ADR-044 infrastructure
  + S96-70..S96-74 lock-ins documented
S96 #17 Cycle 4 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-8 closure: ADR-046 + regime_dashboard.ts docstring
  + S96-75 lock-in documented
S96 #17 Cycle 5 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-13 + GAP-19 closure: docs/processes/quartz-upgrade.md
  + S96-76 lock-in documented
S96 #17 Cycle 6 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-16 closure: ADR-047 + bt_runs_regime.ts docstrings
  + S96-77 + S96-78 lock-ins documented
S96 #17 Cycle 7 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-17 closure: 2 deletions + 1 rename + 1 reclassified-leave-as-is
  + S96-79 + S96-80 + S96-81 lock-ins documented
S96 #17 Cycle 8 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-10 closure + S96-76 follow-up:
                                                       .github/workflows/ci.yml (lint + test-typescript
                                                       + test-python jobs on ubuntu-latest)
  + S96-82 + S96-83 lock-ins documented
S96 #17 Cycle 9 of multi-agent orchestration:
  • Composite worker (worktree)       AUTO-APPROVE  → OQ-SMP-1 closure:
                                                       gics_sector_repository_helper.ts 3 SELECT-clause
                                                       edits dropping `toString(<Date col>) AS <same_name>`
                                                       + new GST-1 EXPLAIN-clean test pinning the third
                                                       instance.
  + S96-84 (CH shadow-alias anti-pattern banned) +
    S96-85 (worktree baseRef:fresh mismatch lesson) lock-ins documented
S96 #17 Cycle 10 of multi-agent orchestration:
  • Orchestrator self-edit (§3.1)     AUTO-APPROVE  → S96-78 closure:
                                                       `npm run backfill:bt-regime --
                                                       --classifier-version=phase1_v3` ran by operator;
                                                       197,064 / 197,064 attributed · 0 errors · 2234s.
                                                       Post-backfill CH verification confirms row-count
                                                       parity with phase1_v2, sentinel count match with
                                                       ADR-047 (78,399 = 78,399), plausible dominant_share
                                                       quantiles (p05=0.532 · p50=0.828 · p95=0.95).
  + S96-86 (phase1_v3 attribution coverage + standing
    backfill verification pattern) lock-in documented
  + 1 commit (this HANDOFF rewrite — HANDOFF-only because no source-file diff)
  + Second cycle since Cycle 4 to use §3.1 trivial-edit exception (no worker spawn)
  + Zero runtime behavior change; tsc baseline + health-check + all test suites unchanged
  + No new operator-queue rows; S96-78 CLOSED; Q-4 count: 36 → 37
  → DEFAULT NEXT: Cycle 11 candidate per orchestration §8.4 follow-up
    queue. RECOMMENDED — `/#/regime` post-backfill UI smoke-test
    (open browser, validate regime panel now surfaces phase1_v3
    attribution data per ADR-046; document outcome; remediate if
    rendering bug surfaces).
```
