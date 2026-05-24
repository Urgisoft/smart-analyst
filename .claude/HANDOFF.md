# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #17 — **Cycle 6 of multi-agent
orchestration executed**. Single Composite/Infra slice (GAP-16 closure)
authored directly by the orchestrator under §3.1 trivial-edit exception
(documentation-only resolution backed by a read-only diagnostic probe; no
worker-spawn overhead justified). **1 new commit** on top of s96 #17 Cycle 5
close: `0c9d92a` (slice 1 — `docs/specs/adr-047-bt_runs_regime-sentinel-
semantics.md` + `src/server/bt_runs_regime.ts` docstring updates +
`scripts/_probe_gap16_sentinels.ts` diagnostic probe). **Net 29 unpushed
commits** on top of `origin/main` (`c0cda7c`) after this slice; will be 30
after this HANDOFF rewrite. Cycle 6 closes audit GAP-16 (78,399 zero-trade
sentinels in `bt_runs_regime`) as documentation-only: a read-only six-probe
forensic found the rows are by-design BUT the label `sentinel_no_trades` is
**semantically misleading** — only 21,489 / 78,399 (27.4%) correspond to
`bt_runs.trades = 0`; the remaining ~57k are runs that DID execute trades
but couldn't be window-attributed because `data_span_days=0` AND `bt_trades`
fallback returned no rows. Read-side default `includeSentinels=false` already
excludes all sentinels from downstream metrics; no calc is corrupted; the
cost of re-labelling 78k rows + the public TS type change outweighs the
precision gain. ADR-047 records the decision + the rejected purge/re-label
alternatives. **Side-finding (NOT on operator queue):** `bt_runs_regime` has
zero `phase1_v3` rows; the v2-vs-v3 attribution comparison promised in
ADR-037 / SPEC §1 D4 requires `npm run backfill:bt-regime --
--classifier-version=phase1_v3` — defer to a future cycle, no methodology
trigger. **NEXT default on `continue`:** Cycle 7 per orchestration §8.4 —
**GAP-17 orphan-script per-file cleanup** (Infra worker: `sharadar_backfill.py`
→ remove (paid blocked); `import_botdb_candles.py` → confirm + remove;
`walk_forward_cluster.py` + `train_meta_label.py` → leave with `_` prefix).)

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
| Q-4 | Push 29 unpushed commits to origin/main | Carry-over; count updated this session (Cycle 6 slice + this HANDOFF will be the 30th) | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID (intended ADR-044 §infrastructure-4 first-alert semantics; one message — no re-alert via S96-72 dedupe sidecar) | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.
**Cycle 6 added zero rows** (GAP-16 closure is documentation-only — no
real-money / methodology-amendment trigger fires; the side-finding about
missing v3 attribution is a Phase 9+ deliverable, not a queue item).

---

## What this cycle delivered (s96 #17 Cycle 6)

### One commit + HANDOFF rewrite (2 logical units)

**Commit (`0c9d92a`) — GAP-16 closure:** Closes the audit's GAP-16
("78,399 zero-trade sentinels in `bt_runs_regime`") as documentation-only.
Per orchestration §6.4 routine-resolution authority the choice between
the audit's three fix-options (keep / label / purge) is the
orchestration's; Cycle 6 ships **keep + clarify-docs** because:

1. **Not garbage.** The sentinel rows record a real fact: the regime
   attribution pipeline considered these `bt_runs` rows and determined
   that neither the primary path (`data_span_days`) nor the fallback
   path (`bt_trades` window derivation) could produce a window. That is
   audit information — purging would lose the record that 78k legacy
   runs exist and were considered.
2. **Purge would escalate.** `ALTER ... DELETE` on `bt_runs_regime` is
   on the CLAUDE.md hard-stop list; operator-gated. The cost-benefit
   (operator queue add to lose an audit trail and reclaim trivial
   storage) does not justify the escalation.
3. **Re-label would touch a public type + 78k row backfill.** The label
   change cascades through the public TypeScript `AttributionSource`
   type, the read-side `includeSentinels` discriminator, every test
   fixture, the SPEC, and the backfill path. The cost outweighs the
   precision gain when `includeSentinels=false` already excludes them
   from downstream metrics.

**The forensic finding** (driven by the read-only probe at
`scripts/_probe_gap16_sentinels.ts`): only 21,489 / 78,399 (27.4%) of
the sentinel rows correspond to `bt_runs.trades = 0`. The remaining ~57k
are runs that DID execute trades but couldn't be window-attributed
because `data_span_days = 0` AND `fetchTradeWindow` returned no rows
for the `(sweep_id, token_address, strategy_type, param)` lookup. The
label `sentinel_no_trades` therefore conflates "no trades" with "no
window derivable" — the latter is the actual trigger. Three plausible
root causes (not investigated further — not load-bearing for the
decision): engine-version asymmetry where an older engine wrote the
summary count without per-trade detail; historical pruning of
`bt_trades`; or key-format drift on the `(sweep_id, …)` quadruple.

**Side-finding (NOT in scope for GAP-16; tracked in ADR-047
§"Side-finding"):** `bt_runs_regime` has **zero `phase1_v3` rows**.
The v2-vs-v3 attribution comparison promised in ADR-037 / SPEC §1 D4
requires a v3 backfill via `npm run backfill:bt-regime --
--classifier-version=phase1_v3`. This is independent of GAP-16 and
**not** on the operator queue (no real-money / methodology-amendment
trigger). It will surface in a future cycle as part of Phase 9+
analytical work; or — if an operator query against bt_runs_regime
under v3 returns empty when v3 is the active classifier — the missing
backfill will be the obvious diagnosis.

**Files in this commit:**

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/specs/adr-047-bt_runs_regime-sentinel-semantics.md` | new (+388) | The decision + six-probe forensic record + rejected purge/re-label alternatives + side-finding; explicit Tier-2-quarantine-non-applicability justification per ADR-044 |
| `src/server/bt_runs_regime.ts` | +20 -2 | Docstring updates on `AttributionSource` type (l.32) and `buildSentinelResult` (l.243) pointing to ADR-047; **no runtime behavior change** |
| `scripts/_probe_gap16_sentinels.ts` | new (+96) | Six read-only probes (P1 totals; P2 attribution_source split; P3 sentinel-vs-bt_runs.trades alignment; P4 anomaly check; P5 sample content; P6 count cross-check); preserved with `_` prefix per GAP-17 leave-with-prefix policy; future re-runs after v3 backfill lands can use the same queries |

### Cycle 6 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| (none) | GAP-16 closure — read-only probe + ADR + docstring updates | AUTO-APPROVE (orchestrator self-review per §6.1) | 3 files (1 new ADR + 1 docstring edit + 1 new diagnostic probe); tsc baseline 13 unchanged; tests unchanged (btRunsRegime.test.ts 19/19) |

No subagent worker spawned — per orchestration §3.1 trivial-edit
exception. The investigation phase (running the read-only probe) is
diagnostic, not code-change; the resolution phase (docstring + ADR) is
pure documentation. Three consecutive cycles (4, 5, 6) have now used
the §3.1 trivial-edit exception for documentation-only GAP closures;
this is the established pattern for the audit's §2.3 documentation /
cleanup gaps. The next two cycles (7 GAP-17 orphan cleanup; 8 GAP-10
CI/CD baseline) will return to worker-spawn patterns since they involve
code/infrastructure change.

Orchestrator self-review under §6.1 AUTO-APPROVE criteria (domain-clean
Composite + Infra; no code path touched; tsc baseline unchanged; no
Tier-2 quarantine delta; no real-money path; no paid-data; no
methodology-canon claim; no ADR conflict — ADR-047 documents an
existing-state finding without proposing methodology change).

### Verification gates at cycle close

```text
git status                                                                          # clean (1 slice committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #17 Cycle 5 close; same files: _check_constituent_cleanup.ts, _cleanup_polluted_constituents.ts, _diagnose_constituent_pollution.ts, _verify_sp500_constituents_ddl.ts)
node --import tsx --test scripts/tests/btRunsRegime.test.ts                          # 19/19 pass (no fixture change)
node --import tsx --test scripts/tests/*                                             # all Cycle 5-touched suites unchanged
npm run health:check                                                                # post-Cycle-6 baseline: see below (same set as Cycle 5 close; no new Tier-2; no DB state touched)
```

### Per-suite breakdown at cycle close

```text
btRunsRegime.test.ts                                   19/19 pass    (no fixture change)
all Cycle 5-touched suites                            (unchanged — no test files in their domain touched)
regimeDashboard.test.ts                                37/37 pass    (unchanged)
all Cycle 3-touched suites                            472/472 pass   (unchanged from s96 #17 Cycle 4 close)
```

### Post-Cycle-6 health snapshot

Identical to Cycle 5 close. No new probes, no new tables, no new freshness
classes, no DB state changed at all (Cycle 6 is documentation-only). The
health-check output is the standard daemon-cadence pattern:

- **Fresh:** 1 source (`Wikipedia/fja05680 S&P 500 constituents`).
- **Stale (informational, 2-3d since last `npm run daemon:daily` run):**
  Candles ~2.0d, Cross-asset ~2.0d, Cycle position ~2.0d, ETF v3.1 SSGA
  secondary ~3.0d, FRED ~3.0d, Form 4 trades ~8.8d, Live paper-trading
  signals ~33.7h, Macro regime (phase1_v3) ~2.0d, Sector rotation ~2.0d,
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

- `origin/main` at `c0cda7c`; **29 unpushed commits** after s96 #17 Cycle 6
  slice (was 27 at s96 #17 Cycle 5 close; this cycle added 1 slice commit +
  this HANDOFF rewrite will be the 30th, bringing the close-state count to
  30).
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
| **Cycle 6 — GAP-16 sentinel investigation closure (ADR-047 + bt_runs_regime.ts docstrings + diagnostic probe)** | **✓ s96 #17** |
| Cycle 7 — GAP-17 orphan-script per-file cleanup (Infra) | ☐ NEXT default |
| Cycle 8 — GAP-10 CI/CD baseline via .github/workflows/ci.yml (Infra) | ☐ after Cycle 7 |
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

### Session 96 #17 (Cycle 6 of multi-agent orchestration)

**S96-77. `bt_runs_regime`'s 78,399 sentinel rows stay as-is with the
historically-mislabelled `attribution_source = 'sentinel_no_trades'`
label preserved for backward compat.** The forensic probe at
`scripts/_probe_gap16_sentinels.ts` confirmed only 21,489 / 78,399
(27.4%) correspond to `bt_runs.trades = 0`; the remaining ~57k are
runs that DID execute trades but the per-trade detail in `bt_trades`
was unavailable at attribution time, so the fallback window-derivation
returned empty. The accurate label would be
`sentinel_no_window_derivable`; the cost of re-labelling (public TS
type change, 78k row backfill, every test fixture, the SPEC, the
read-side discriminator) does not justify the precision gain because
the read-side default `includeSentinels=false` already excludes all
sentinels from downstream metrics. The mislabel is now documented in
the type's docstring (`bt_runs_regime.ts:32`) + in the function's
docstring (`bt_runs_regime.ts:243`) + in ADR-047. `Why:` Per
orchestration §6.4 routine-resolution authority + §3.1 trivial-edit
exception. Three options were on the table (keep / label / purge per
the audit framing); keep + clarify-docs is the choice because
(a) the rows are audit information not garbage, (b) purge requires
`ALTER ... DELETE` which is operator-gated per CLAUDE.md hard-stop,
(c) re-label cascades through too many surfaces for too little benefit
when downstream impact is already zero. `How to apply:` A future Phase
9+ schema cleanup MAY revisit the re-label decision IF the
`phase1_v3` backfill (the Cycle 6 side-finding) exposes additional
sentinel patterns that warrant a richer source enum. Until then,
operators querying the raw `bt_runs_regime` table directly should
consult the type docstring + ADR-047 to understand that
`sentinel_no_trades` includes BOTH true zero-trade runs AND legacy
runs with missing per-trade detail; the `attribution_source != 'sentinel_no_trades'`
filter on every read-path remains the canonical
exclusion-of-attribution-failures filter.

**S96-78. The `phase1_v3` attribution backfill into `bt_runs_regime` is
a pending Phase 9+ deliverable, NOT on the operator queue.** Cycle 6's
probe found `bt_runs_regime` has zero `phase1_v3` rows (all 197,064
existing rows are under `phase1_v2`). The v2-vs-v3 comparison
promised in ADR-037 / SPEC §1 D4 requires `npm run backfill:bt-regime
-- --classifier-version=phase1_v3`. This is documented in ADR-047
§"Side-finding" but no operator-queue row is added: per orchestration
§7.2 + §6.3 no real-money trigger / methodology amendment trigger
fires. The backfill is a routine `backfill_bt_runs_regime.ts` invocation
under an established classifier version; the existing tests + the
ReplacingMergeTree idempotence guarantee correctness. `Why:` Adding
the v3 backfill to the operator queue would be queue-noise — the
operator queue is exclusively real-money triggers per the working-model
change (s96 #14); a "run an existing npm script with a known flag" is
orchestration-domain work. `How to apply:` Surface this as a candidate
for any future cycle where the orchestration is between gaps; or, if
an operator query against `bt_runs_regime` returns empty when v3 is
the active classifier, the missing backfill is the obvious diagnosis
(visible in the diagnostic probe's P1 output).

**Carry-overs (still in force):** S96-1..S96-76; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #17 Cycle 6)

None inside orchestration authority. No new operator-queue rows opened
this cycle. The five Q-rows above are all carry-overs from prior cycles.

The Cycle 6 side-finding about missing `phase1_v3` attribution
(S96-78) is documented as a Phase 9+ deliverable, not a queue item.

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
- Sharadar SF1 subscription — Q-3 adjacent.
- Compounding-live-equity backtest semantic.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.
- Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert-on-status-transition cursor (deferred per S96-71).
- **Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence** (Cycle 6 surfaced; not investigated — three plausible causes listed in ADR-047 §"The semantic surprise"; deferred until a downstream consumer needs to know).

---

## Next stage

### Default on `continue` — Cycle 7 (orchestration §8.4)

Per orchestration §8.4 — first item is **GAP-17 orphan-script per-file
cleanup**. Infra domain. Per the audit's classification:

- `sharadar_backfill.py` → **remove** (paid Sharadar subscription is on
  CLAUDE.md blocked-data-source list; no path to ever exercise this
  file under current policy).
- `import_botdb_candles.py` → **confirm one-shot migration completed +
  remove** (need to verify the migration ran historically; if confirmed
  done, delete).
- `walk_forward_cluster.py` → **leave with `_` prefix** (dev-only
  diagnostic per the established `_`-prefix-for-diagnostics convention;
  rename in-place).
- `train_meta_label.py` → **leave with `_` prefix** (same convention;
  rename in-place).

Plausible spawn pattern: single Infra worker, `isolation: "worktree"`,
four per-file decisions in one cycle. Or, given the per-file decisions
are independent and the diffs are tiny (delete-or-rename), the
orchestrator could self-resolve under §3.1 trivial-edit exception —
this would be the fourth consecutive documentation/cleanup cycle
following that pattern (Cycles 4 + 5 + 6 + 7). Either approach is
defensible; the worker-spawn pattern is more conservative if any of
the per-file decisions reveal hidden dependencies (e.g.
`import_botdb_candles.py` is referenced by some live tooling — needs
verification before deletion).

**After GAP-17:** orchestration §8.4 enumerates:

- **Cycle 8 — GAP-10 CI/CD baseline** via `.github/workflows/ci.yml`
  (Infra) — GitHub Actions free-tier-safe on private repos; SHOULD
  include the deferred Quartz vendor-patch grep-assertion documented
  in `docs/processes/quartz-upgrade.md` § Alternative CI grep test.

**After Cycle 8+:** Phase 9 continued work as defined in HANDOFF
(Phase B campaigns remain paused per existing autonomous-execution
rules until operator green-light — those stay on the operator queue).

The Cycle 6 side-finding (S96-78 `phase1_v3` backfill into
`bt_runs_regime`) is also a candidate for a future cycle — small,
self-contained, orchestration-domain, no operator gate. Defer until
the GAP-17 + GAP-10 cleanup cycles close OR a downstream consumer
needs the v3 attribution.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 6)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/specs/adr-047-bt_runs_regime-sentinel-semantics.md` | new (+388) | The decision + six-probe forensic record + rejected purge/re-label alternatives + side-finding; explicit Tier-2-quarantine-non-applicability justification per ADR-044 |
| `src/server/bt_runs_regime.ts` | +20 -2 | Docstring updates on `AttributionSource` type (l.32-44) and `buildSentinelResult` (l.252-260) pointing to ADR-047; **no runtime behavior change** |
| `scripts/_probe_gap16_sentinels.ts` | new (+96) | Read-only diagnostic probe (P1 totals; P2 attribution_source split; P3 sentinel-vs-bt_runs.trades alignment; P4 anomaly check; P5 sample content; P6 count cross-check); preserved with `_` prefix per GAP-17 leave-with-prefix policy |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-77 + S96-78 lock-ins; operator queue unchanged (Q-4 count incremented to 29) |

### Test + tsc state

- `btRunsRegime.test.ts`: **19/19 pass** (no fixture change; the docstring
  edits don't touch any tested code path).
- All Cycle 3/4/5-touched suites: **unchanged** (no test files in any of
  their domains touched this cycle).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated
  `_check_*.ts` / `_verify_*.ts` / `_cleanup_*.ts` / `_diagnose_*.ts`).
- Health check delta: **zero**. No new tables, no new probes, no new
  freshness classes, no DB state changed. The output is the same
  fresh/stale/very-stale/missing/empty pattern as Cycle 5 close.

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
  invocation is a Cycle-7+ candidate per S96-78.
- Cycle 7 (GAP-17 orphan-script cleanup) is per-file: 2 deletions
  (after verification for `import_botdb_candles.py`) + 2 renames (with
  `_` prefix). Worker-spawn vs. orchestrator-direct is a judgment call;
  worker-spawn is safer for the deletion-with-verification leg.

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 6)

- **The label `attribution_source = 'sentinel_no_trades'` is misleading
  for ~73% of the rows it tags.** A future contributor reading the
  literal label and assuming "all 78,399 rows = true zero-trade runs"
  will be wrong. Mitigation: the docstring on `AttributionSource`
  (`bt_runs_regime.ts:32`) and on `buildSentinelResult`
  (`bt_runs_regime.ts:243`) now call out the actual trigger condition
  + the GAP-16 forensic finding + the ADR-047 reference. If a future
  contributor proposes "let me clean up these zero-trade sentinels,"
  the docstring + ADR-047 are the stop signs.
- **The read-side default `includeSentinels=false` filter is the
  load-bearing exclusion.** If any future reader site forgets to set
  this (or if a new reader is added without consulting the existing
  `fetchBtRunsByRegime` pattern), the 78,399 sentinels would leak into
  the result set with `total_days=0` and `dominant_regime='unknown'`.
  The convention-pin test in `scripts/tests/btRunsRegime.test.ts` does
  exercise the discriminator; a new reader pattern should be paired
  with a matching convention pin. Mitigation: the docstring on
  `RegimeFilter.includeSentinels` (l.110) already documents the
  default-false convention.
- **A future Phase 9+ schema cleanup that adds a new `AttributionSource`
  value must update the discriminator literal at
  `bt_runs_regime.ts:503-505`.** The filter `attribution_source !=
  'sentinel_no_trades'` is the exclusion expression; adding a new
  sentinel-class value without updating the filter would leak the new
  class into downstream metrics. Mitigation: the filter literal is
  grep-able; the test pin would catch a mismatch.
- **Three root causes for the `bt_runs.trades > 0` AND `bt_trades`
  empty divergence are not investigated.** ADR-047 §"The semantic
  surprise" lists three plausible causes (engine-version asymmetry,
  historical pruning, key drift) but does not rank or investigate
  them. If a downstream consumer ever needs to know the actual
  cause, the investigation will need to scan `bt_runs.started_at`
  histogram for the sentinel run_ids vs. the bt_runs schema-evolution
  timeline + the bt_trades retention policy history (no formal
  retention policy exists; this would need spot-checks against the
  CH `system.parts` history).
- **The `_probe_gap16_sentinels.ts` diagnostic is preserved but not
  in `package.json`.** Future re-runs are via `npx tsx
  scripts/_probe_gap16_sentinels.ts` directly. If the orchestration
  decides to promote it to an npm script in a future cycle, the
  `help` metadata pattern from `backfill_bt_runs_regime.ts:27-42` is
  the convention to follow.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 5 carry-overs) preserved.

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
npx tsx scripts/_probe_gap16_sentinels.ts                                     # Cycle 6 GAP-16 diagnostic; preserved per GAP-17 leave-with-prefix
npx tsx scripts/_probe_ch_btregime.ts                                         # pre-existing distribution probe (sampling + quantiles)
```

### Tests + dev

```text
npm test                                                                                              # last full green at s96 #12 close
node --import tsx --test scripts/tests/btRunsRegime.test.ts                                           # 19/19 pass at s96 #17 Cycle 6 close
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
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py                       # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                                      # last green at s96 #9 close: 394 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors unchanged
```

### npm scripts touched this cycle

- **None.** Cycle 6 is documentation-only (1 new ADR + 1 docstring edit
  + 1 new diagnostic probe; no `package.json` change; no script behavior
  change). The new probe at `scripts/_probe_gap16_sentinels.ts` runs via
  direct `npx tsx` invocation; not promoted to an npm script per the
  diagnostic-script convention (`_`-prefix marks "diagnostic, run
  manually").

---

## For the next session — priority order

**Default on `continue`:** Cycle 7 per orchestration §8.4 — **GAP-17
orphan-script per-file cleanup**. Infra domain. Per the audit's
classification: `sharadar_backfill.py` → remove (paid blocked);
`import_botdb_candles.py` → confirm completion then remove;
`walk_forward_cluster.py` + `train_meta_label.py` → leave with `_`
prefix (rename in-place).

Plausible spawn pattern: single Infra worker with `isolation:
"worktree"`; four per-file decisions; deliverable is 2 deletions +
2 renames + tests still green + no broken imports. OR orchestrator
self-resolve under §3.1 trivial-edit exception IF the
`import_botdb_candles.py` deletion-with-verification leg can be
folded into a single pass.

**Then per orchestration §8.4:**

- Cycle 8 — GAP-10 CI/CD baseline via `.github/workflows/ci.yml`
  (Infra; GitHub Actions free-tier-safe on private repos; SHOULD
  include the deferred Quartz vendor-patch grep-assertion from
  `docs/processes/quartz-upgrade.md` § Alternative CI grep test).

**Cycle 6 side-finding candidate (S96-78):**

- `npm run backfill:bt-regime -- --classifier-version=phase1_v3` —
  small, self-contained, orchestration-domain. Defer until GAP-17
  + GAP-10 close OR a downstream consumer needs v3 attribution.

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
- Q-4 push 29 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D (pinned
  as `accepted-as-warning` Tier-2 quarantine row; Telegram alert
  fires once on next live daemon run with valid Telegram creds,
  then sidecar-deduped).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop) — note: GAP-16 closure explicitly avoided this path
  (purge would have required `ALTER ... DELETE` on `bt_runs_regime`).
  Cycle 7 GAP-17 cleanup is `rm` on script files only — filesystem
  not CH; not on the hard-stop list.
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

**Cycle 6 is closed.** Three new files (1 ADR + 1 diagnostic probe +
1 docstring edit) + this HANDOFF rewrite. Documentation-only; no DDL,
no DML, no behavior change; tsc baseline 13 unchanged; tests unchanged
(btRunsRegime.test.ts 19/19); health-check deltas zero. The
orchestration's §3.1 trivial-edit exception (documentation + read-only
diagnostic) makes this a clean self-review under §6.1 AUTO-APPROVE
without subagent spawn. No new operator-queue rows; no escalations
fired this cycle.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).** Q-4
count incremented from 27 → 29 (Cycle 6 slice + HANDOFF rewrite will
make it 30 at the actual commit moment).

**ADR-047 is the canonical resolution for GAP-16.** Future contributors
querying `bt_runs_regime` directly or proposing changes to
`AttributionSource` should consult ADR-047 first. The Cycle 6 probe
script `scripts/_probe_gap16_sentinels.ts` is preserved per GAP-17
leave-with-`_`-prefix policy and is the canonical re-investigation
tool — re-run it after any future structural change to bt_runs_regime
(notably the deferred S96-78 v3 backfill) to refresh the picture.

**Default next is Cycle 7 — GAP-17 orphan-script per-file cleanup.**
Infra worker; per-file decisions (2 deletions + 2 renames); the
`import_botdb_candles.py` deletion needs a verification step (confirm
the historical migration completed). Worker-spawn vs. orchestrator-
direct is a judgment call at start-of-cycle.

**Backward compat preserved this cycle:**

1. **CH:** No table changes.
2. **Type:** Docstring-only edits to `AttributionSource` and
   `buildSentinelResult`; runtime type unchanged.
3. **Brief:** No render-side changes; byte-equal-stdout preserved.
4. **Tests:** btRunsRegime.test.ts 19/19 still pass; no fixture change.
5. **Code behavior:** Zero behavior change; docstring-only modification
   on an already-shipped file documents an existing finding without
   changing any code path.

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
  + 1 commit + this HANDOFF rewrite = 2 logical units
  + No subagent worker spawned (§3.1 trivial-edit exception, third cycle
    in a row for documentation/cleanup work)
  + Zero behavior change; tsc baseline + tests + health-check all unchanged
  + No new operator-queue rows
  → DEFAULT NEXT: Cycle 7 per orchestration §8.4
    GAP-17 orphan-script per-file cleanup (2 deletions + 2 renames).
    Infra worker (or orchestrator-direct under §3.1 if all four files
    can be resolved in one pass without hidden-dependency surprises).
```
