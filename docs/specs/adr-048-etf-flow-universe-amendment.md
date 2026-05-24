# ADR-048 — ETF flow universe amendment: drop 6 non-SSGA tickers + promote v3.1 secondary to v1 primary; sunset yfinance ETF SHO ingest

**Status:** PROPOSED (orchestration-drafted 2026-05-24 in session 96 #17 Cycle 15
per `docs/architecture/multi-agent-orchestration.md` §8.4; awaiting operator
ratification per Q-6 path selection — see §"Operator decision" below).
**Date:** 2026-05-24
**Owner (draft):** Vector Core orchestration (assistant).
**Owner (ratification):** Operator — this ADR is the path-B realization of
operator queue row **Q-6** (`/#/etf-flow` v1 yfinance primary panel — yfinance
ETF SHO endpoint regression). Operator picks among Q-6 paths A/B/B'/C/D; this
ADR governs path-B only. Ratification (status: PROPOSED → Accepted) gates
implementation.
**Operates under:** [ADR-044](adr-044-standing-system-health-ownership.md)
(standing system-health ownership) — methodology-amendment escalation per
`docs/architecture/multi-agent-orchestration.md` §6.3 trigger 5 (load-bearing
methodology shift); routine resolution authority does NOT apply.
**Cross-references:**
- `.claude/HANDOFF.md` — Q-6 row, Q-6 path-space (A/B/B'/C/D) refined Cycle 14
  per S96-93.
- [docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md](q6-etf-sho-issuer-survey-2026-05-24.md)
  — empirical foundation: iShares ajax CSV endpoint dead; Vanguard REST API
  302-redirects to error.vanguard.com; Invesco endpoints 404; SEC EDGAR N-PORT
  is quarterly with ~60-day lag (audit-cross-check, not daily-panel).
- [docs/specs/etf-flow-monitoring.md](etf-flow-monitoring.md) — the SPEC this
  ADR amends (§2 F-UNIVERSE row; §5 F-5/F-6 aggregates; §6 source-table DDL;
  §10 Phase A1 deliverable; §11 OQ3 cross-validation).
- [scripts/etf_flow_ingest.py](../../scripts/etf_flow_ingest.py) — the v1
  yfinance-fed primary ingest this ADR sunsets.
- [scripts/etf_flow_ssga_spdr_adapter.py](../../scripts/etf_flow_ssga_spdr_adapter.py)
  — the v3.1 SSGA navhist adapter this ADR promotes to v1 primary role.
- [src/server/etf_flow.ts](../../src/server/etf_flow.ts) — composite + the
  `ETF_UNIVERSE` / `BROAD_INDEX_ETFS` / `STYLE_RISK_ETFS` constants this ADR
  amends; the `ETF_FLOW_COMPOSITE_VERSION` bump.
- [src/server/etf_flow_cross_validation.ts](../../src/server/etf_flow_cross_validation.ts)
  — the v3.1 cross-validation comparator that becomes degenerate post-amendment.
- [src/components/etfFlow/EtfFlowApp.tsx](../../src/components/etfFlow/EtfFlowApp.tsx)
  — `/#/etf-flow` UI surface; empty-state copy changes.
- S96-89 + S96-90 (Cycle 12 lock-ins — Yahoo ETF SHO regression diagnosed);
  S96-91 + S96-92 (Cycle 13 — SSGA expansion to 15 tickers); S96-93 + S96-94
  (Cycle 14 — path-B' empirically reclassified as not pursuable without
  Playwright + bot-detection-bypass authorization).

## Context

### What Q-6 is

Operator queue row Q-6 was added at session 96 #17 Cycle 12 (S96-89 + S96-90)
when yfinance's `Ticker.get_shares_full` ETF endpoint regressed: the call
returns an empty DataFrame for every ticker in the v1 21-ETF universe
(`F-UNIVERSE`) while still working for equities (AAPL/MSFT/etc.). yfinance
1.4.0 does not fix it — the regression is Yahoo-side, library-independent.

Effect: `scripts/etf_flow_ingest.py` exits non-zero with "FAILED (shares=0,
close=N)" for all 21 tickers; `quantlab.etf_shares_outstanding` stays empty;
the v1-primary read path on `/#/etf-flow` renders the empty state.

The v3.1 issuer-CSV secondary adapter — added across s96 #7-#9 for SSGA SPDR
funds — DOES populate `quantlab.etf_shares_outstanding_secondary` for 15 of
the 21 tickers (Cycle 13 expansion to 15 per S96-91). The remaining 6 tickers
(IVV, VOO, QQQ, IWM, HYG, TLT) have no v3.1 alternative.

### Q-6 path-space (post-Cycle-14)

Per HANDOFF Cycle 14 close + the survey doc:

| Path | Description | Status |
| --- | --- | --- |
| A | Paid Sharadar / Polygon ETF SHO subscription | Only path that restores fresh daily SHO for ALL 21 tickers; gated on operator authorization for paid data |
| **B** | **Drop the 6 non-SSGA tickers from F-UNIVERSE + promote v3.1 secondary to v1 primary role + sunset yfinance-fed primary** | **This ADR** |
| B' | Per-issuer free adapters (iShares + Vanguard + Invesco) | Empirically reclassified Cycle 14 (S96-93) as substantially harder than estimated; requires Playwright + bot-detection-bypass infrastructure (~1500-3000 LOC + heavy deps); not pursuable without operator authorization |
| C | Keep `accepted-as-warning` indefinitely | Status quo; viable while operator deliberates |
| D | Yahoo restores `Ticker.get_shares_full` for ETFs | Monitored passively by daemon step 1jb anomaly path |

### Why path-B is the orchestration's leading fallback

Three reasons, in order:

1. **Empirical**: path-B' has been empirically ruled out (Cycle 14 survey);
   path-A requires paid-data authorization; path-D is passive and Yahoo has
   shown no signal of restoring the endpoint. Among the paths the
   orchestration CAN execute without operator authorization for paid data
   or new heavy deps, path-B is the only one that produces fresh daily SHO
   data on a defensible universe.
2. **Canon-coherent** (ADR-044 §"Asset-class correctness" / §"Data integrity"):
   the current state — primary panel returns zero rows for the whole
   universe, ETL daemon step 1jb runs and reports "FAILED" daily, the
   `/#/etf-flow` UI surfaces an indefinite empty state — is itself an
   ADR-044 violation of "every number on every page traces correctly to its
   source." Path-B restores end-to-end traceability for 15 of 21 tickers
   and explicitly drops the other 6 rather than silently propagating
   "primary empty + secondary partial" as the steady state.
3. **Reversible**: if Yahoo restores the endpoint (path-D) OR operator later
   authorizes paid data (path-A) OR a future Q-6 path-B' becomes feasible,
   re-adding tickers to `F-UNIVERSE` is a constant-bump diff — the
   shape of the composite (per-ETF + aggregate) is preserved by path-B.

## Decision

**If operator picks Q-6 path-B**, ratify this ADR (status: Accepted) and
execute the implementation below as a single Cycle-N slice. **If operator
picks any other path**, leave this ADR at PROPOSED indefinitely; the next
cycle removes it from the active path discussion in HANDOFF without deleting
the file (the analysis remains useful if operator later returns to path-B).

### Decision details

1. **Shrink F-UNIVERSE from 21 to 15 tickers.** Drop IVV, VOO, QQQ, IWM
   from `BROAD_INDEX_ETFS`; drop HYG, TLT from `STYLE_RISK_ETFS`.
   Surviving universe (15) = SPY + DIA (the two SSGA broad-index funds) +
   the 11 SPDR sector funds (XLK/XLF/XLE/XLV/XLY/XLP/XLU/XLI/XLB/XLRE/XLC) +
   JNK + GLD.

2. **Promote `quantlab.etf_shares_outstanding_secondary` to the v1 primary
   read path.** The repository layer reads from secondary by default; the
   v1 yfinance-fed table (`quantlab.etf_shares_outstanding`) becomes a
   read-deprecated artifact.

3. **Sunset `scripts/etf_flow_ingest.py` from the daemon.** Remove daemon
   step 1jb (the v1 primary refresh that calls into yfinance). Mark the
   script itself as deprecated (one-line header comment + ADR-048 link).
   Do NOT delete the file — it stays available for path-A re-activation
   if a fresh-data source emerges. Do not run `ALTER ... DELETE` on the
   v1 table; it's a forward-only deprecation. The pre-amendment data
   remains for forensic purposes.

4. **Bump `ETF_FLOW_COMPOSITE_VERSION` from `etf_flow_v1` to
   `etf_flow_v1.1`.** Per the existing rule in [etf_flow.ts:80-84](../../src/server/etf_flow.ts#L80-L84):
   universe membership change is a version bump.

5. **Re-tune F-6 (`aggregate_risk_on_flow`) constants.** The "6 broad-index
   ETFs" reduces to 2 (SPY + DIA); cold-start logic and the threshold
   semantics must reflect this. Threshold (|z| > 2.0) is preserved — it
   is operator-readable round-number, NOT in-sample-tuned, per the F-6
   docstring. The cold-start rule "any constituent's flow_z = null forces
   aggregate to null" preserves trivially (just fewer constituents).

6. **F-5 (`sector_flow_dispersion`) is unchanged.** All 11 SPDR sector ETFs
   survive; the cross-sectional stddev keeps its full 11-element population.

7. **Reframe the cross-validation comparator (v3.1) as a quarterly N-PORT
   audit-cross-check candidate.** Post-amendment the comparator is
   degenerate (only the secondary panel exists); keep the framework in
   `etf_flow_cross_validation.ts` but route `/#/etf-flow` to a
   "single-source post-ADR-048" empty-state until either:
   - A future slice wires SEC EDGAR N-PORT-P shares-outstanding as a
     quarterly cross-check stream (the survey doc §"SEC EDGAR N-PORT as a
     quarterly fallback" path); OR
   - Operator picks Q-6 path-A and the paid stream feeds the secondary
     position; OR
   - Yahoo restores the endpoint (path-D) and the v1 panel returns.

8. **No DDL changes.** Both `quantlab.etf_shares_outstanding` and
   `quantlab.etf_shares_outstanding_secondary` remain on disk. Forward-only.

### Why NOT each rejected alternative path

- **Path A (paid Sharadar / Polygon)** — rejected here only in the sense that
  this ADR governs path-B; path-A is the **operator's** call, and if ratified
  it supersedes this ADR by restoring the full 21-ticker universe. The
  orchestration is not authorized to subscribe to paid data per CLAUDE.md
  hard-stop list.

- **Path B'** (per-issuer free adapters) — rejected per Cycle 14 empirical
  survey: the iShares ajax CSV endpoint returns the Walrus marketing HTML
  wrapper (with a `Content-Type: text/csv` header parroted from the
  query-string param, not derived from body); the Vanguard REST API
  302-redirects to `error.vanguard.com`; the Invesco endpoints 404. The
  only forward path requires Playwright + bot-detection bypass + session-
  cookie + UA-fingerprint realism — estimated ~1500-3000 LOC + heavy deps
  + ongoing fragility against issuer-site redesigns. Not authorized.

- **Path C (keep `accepted-as-warning` indefinitely)** — rejected as a
  permanent steady-state because the underlying ADR-044 violation
  ("primary returns empty for the whole universe daily") is unresolved
  while in C. Path-C remains viable AS the path during operator
  deliberation; path-B is the resolution of that deliberation.

- **Path D (passive watch for Yahoo restoration)** — not a decision so much
  as a hope. Compatible with path-B: if Yahoo restores, the
  re-adding-tickers diff is a constant bump. Compatible with path-C as
  well. Does not by itself resolve Q-6.

### Why this is a methodology-amendment (§6.3 trigger 5) escalation

The ADR-046 amendment that locked phase1_v3 as the canonical classifier
was the precedent: a load-bearing methodology choice that changed how the
universe of a composite is constructed required operator ratification.
Path-B does the same for the ETF-flow composite: it shrinks the universe
from 21 to 15 (a ~29% reduction), bumps the composite version, and
sunsets one of the two source-of-truth panels. This is exactly the kind
of change `docs/architecture/multi-agent-orchestration.md` §6.3 trigger 5
("Diff would require ratifying or amending a methodology ADR that
meaningfully changes a load-bearing decision") names.

The orchestration's role is to draft + recommend; ratification is the
operator's. This is identical to the ADR-046 + ADR-047 split (orchestration
drafts; operator-equivalent ratification per the working-model change
applies).

## Implementation plan (IF ratified)

A single Cycle-N slice, Composite + UI workers in worktree isolation. All
edits below are forward-only; no DDL change; no `ALTER ... DELETE`. Critic
spawn is OPTIONAL per §6 (the diff touches no real-money path file +
no paid-data path + no auth scrape; the only escalate trigger that fires
is the ratification itself, which is satisfied by operator picking path-B).

### Code edits (Composite worker)

| File | Change | LOC delta (estimated) |
| --- | --- | --- |
| `src/server/etf_flow.ts` | `BROAD_INDEX_ETFS` drops IVV/VOO/QQQ/IWM (keep SPY + DIA); `STYLE_RISK_ETFS` drops HYG/TLT (keep JNK + GLD); `ETF_FLOW_COMPOSITE_VERSION` bump to `'etf_flow_v1.1'`; docstrings at §F-1 + §F-6 + the file-top header updated to reflect 15-ticker universe; cross-link this ADR | ~30 / -10 |
| `scripts/etf_flow_ingest.py` | Add deprecation header (one paragraph + ADR-048 link); change the `ETF_UNIVERSE` assertion from `== 21` to `== 15` IF the script is retained for re-activation OR delete the F-UNIVERSE tuple and replace the per-ticker loop body with a deprecation-stub that exits non-zero with a guidance message. **Recommendation**: keep the script + the 15-ticker scope (path-D re-activation friendly) | ~20 / -5 |
| `src/server/etf_flow_repository.ts` | Re-orient the primary-vs-secondary discriminator: the canonical read path now hits `etf_shares_outstanding_secondary`. The "primary" labeled query continues to read from `etf_shares_outstanding` but as a deprecated artifact; downstream consumers (composite + cross-validation) wire `secondary` as primary | ~40 / -20 |
| `src/server/etf_flow_cross_validation.ts` | Update file-top docstring §"What this module does NOT do" to note the post-ADR-048 degenerate-comparator state; no logic change | ~10 / -2 |
| `src/server/etf_flow_dashboard.ts` | Update the empty-state branch to render the post-ADR-048 "single-source" copy when the secondary panel is populated but no primary cross-validation peer exists | ~20 / -5 |

### Code edits (UI worker)

| File | Change | LOC delta (estimated) |
| --- | --- | --- |
| `src/components/etfFlow/EtfFlowApp.tsx` | New empty-state branch for "single-source post-ADR-048"; the existing two branches (no-table-yet / table-empty) stay; copy explicitly cites Q-6 + this ADR + names the SEC N-PORT future-slice possibility | ~30 / -5 |

### Daemon + npm edits (Infra worker — micro-slice)

| File | Change | LOC delta (estimated) |
| --- | --- | --- |
| `scripts/daily_signal_daemon.ts` | Comment-out (do NOT delete) the step 1jb v1 primary refresh call; leave the SSGA step (1ja) as the canonical SHO ingest. One-line cross-link to this ADR | ~5 / -3 |
| `package.json` | Add `etf:flow:ingest:deprecated` alias if the script is retained (vs the existing `etf:flow:ingest` which would now exit non-zero by universe-shrink); optional | ~2 / 0 |

### Test edits

| File | Change | LOC delta (estimated) |
| --- | --- | --- |
| `scripts/tests/etfFlow.test.ts` | Update fixture universe from 21 → 15 tickers; ensure F-5 / F-6 still pass with the surviving counts; add convention-pin asserting `ETF_UNIVERSE.length === 15` | ~30 / -10 |
| `scripts/tests/etfFlowRepository.test.ts` | Update primary-vs-secondary discrimination tests to reflect the new canonical-read posture | ~20 / -10 |
| `scripts/tests/etfFlowCrossValidation.test.ts` | Add a single test pinning the degenerate-comparator branch returns a coherent empty summary | ~15 / 0 |
| `scripts/tests/test_etf_flow_ingest.py` | Update F-UNIVERSE length assertion + the deprecation-stub return code if path chosen | ~10 / -5 |
| `scripts/tests/healthCheck.test.ts` | No change required — `why:` strings on the two SHO tables are unpinned by convention tests (they pin structural shape only per S96-94) | 0 |
| `src/server/health_check.ts` | Refresh the `why:` strings on `etf_shares_outstanding` (now "deprecated per ADR-048; v1 yfinance source dead per S96-89; left on disk for forensic recovery if path-D fires") and `etf_shares_outstanding_secondary` (now "v1 primary post-ADR-048; 15-ticker SSGA-served universe; cross-validation peer is future N-PORT slice"). Per S96-94 standard: lock-in slice includes the `why:` refresh | ~15 / -8 |

**Estimated total slice size**: ~250 / -83 across 11 files + 1 new test. No
new files. No DDL. No new dependencies. No real-money path file touched.

### Gate criteria for the implementation slice

- `npx tsc --noEmit` returns 13 baseline errors unchanged.
- `npm test` passes (currently 3319/3338 + 19 skip + 0 fail; expect a
  small delta from updated fixtures but no NEW failures).
- `pytest scripts/tests/test_etf_flow_ingest.py` passes.
- `scripts/tests/etfFlow.test.ts` + `etfFlowRepository.test.ts` +
  `etfFlowCrossValidation.test.ts` all pass.
- `npm run dev` smoke-test of `/#/etf-flow` renders the new single-source
  empty-state without a 500 (per the standing `feedback-ui-validation-each-
  slice` rule).
- `npm run health:check` reflects the post-amendment freshness state:
  `etf_shares_outstanding` row 0 stays as "deprecated"; the secondary
  table now describes the surviving 15-ticker scope.

### Watch-outs for the implementation slice

- **F-6 cold-start sensitivity.** "6 broad-index ETFs → 2 broad-index
  ETFs" means a single cold-start nullable on SPY or DIA forces the
  aggregate to null. Pre-amendment it took 6 nullable broadcasts to force
  null; post-amendment it takes 1. Operator UX impact: more frequent
  "cold-start" rendering during early-history backfills. Mitigation: the
  current cold-start branch is preserved; no new logic needed; the
  operator brief §13 already labels this state.
- **Cross-validation comparator becomes structurally degenerate.** The
  per-ticker divergence-row machinery, the severity ladder, the
  topDivergences summary — all become identity-on-empty post-amendment.
  Mitigation: keep the framework intact (zero-cost on disk); the
  comparator is reactivated by a future N-PORT-cross-check slice OR by
  Q-6 path-A / path-D firing.
- **Composite version bump triggers backtest re-run.** Per ADR-038 + the
  Phase-9-gap-inventory README, any composite-version bump is meant to
  re-run backtests with the new version stamped on each snapshot. For
  v1 etf-flow this is informational-only (per the SPEC's "Layer-0
  informational input" framing); the bump is a metadata change, not a
  retune. Backtests are NOT automatically re-run by this ADR; the
  composite-version stamp is enough for downstream provenance.
- **Forensic data in `etf_shares_outstanding`.** The 0 rows persist as 0
  rows. If a future operator queries the table directly expecting
  populated data, the `why:` refresh + the deprecation header on
  `etf_flow_ingest.py` are the breadcrumbs. The table is NOT dropped;
  this is forward-only.

## Consequences

**Positive:**
- Resolves Q-6 without paid-data subscription or Playwright dep authorization.
- Restores end-to-end ADR-044 §"Data integrity" + §"Data freshness" for
  15 of 21 tickers (the SSGA-covered subset).
- Path-D-friendly: re-adding tickers if Yahoo restores is a constant bump.
- Path-A-friendly: operator can later switch to paid SHO data by routing
  the paid feed into either the primary or the secondary slot — the
  comparator framework is already in place.
- Honest empty-state on `/#/etf-flow` replaces the indefinite "primary empty"
  state with explicit single-source + ADR-048 attribution.

**Negative:**
- F-UNIVERSE shrinks 29% (21 → 15). Loss of coverage on QQQ (tech-heavy
  broad-index proxy distinct from SPY/DIA/IVV/VOO), IWM (small-cap
  Russell 2000 proxy — no SSGA substitute in F-UNIVERSE), HYG (high-yield
  credit — JNK is the SSGA peer but the two ETFs track slightly
  different indices), TLT (long-duration treasuries — no SSGA peer).
  The composite's per-ETF flow signal on those 6 tickers becomes
  unobservable until Q-6 path-A or path-D fires.
- F-6 (`aggregate_risk_on_flow`) narrows from 6 → 2 broad-index
  constituents. Statistical power on the broad-index aggregate is
  reduced; cold-start nullable rate rises.
- Cross-validation framework loses its current peer-comparison value
  until a future N-PORT slice or path-A/D restores a second source.

**Risks + mitigations:**
- **Operator picks path-B then later wants to re-add a dropped ticker
  via a one-off source.** Mitigation: the constants in `etf_flow.ts` are
  trivially re-editable; per-ticker re-add is a small follow-up slice,
  not a re-ratification.
- **A future composite-version bump muddies the v1.1 stamp.** Mitigation:
  the version stamp lives in `ETF_FLOW_COMPOSITE_VERSION` + flows into
  every snapshot's `composite_version` column per existing wiring.
  Successive bumps (`v1.2`, `v1.3`) can be added without revisiting v1.1.
- **`/#/etf-flow` single-source empty-state confuses an operator who
  remembers the cross-validation comparator working.** Mitigation: the
  empty-state copy explicitly cites Q-6 + ADR-048 + the SEC N-PORT
  future-slice path; no silent UX change.

## What this ADR does NOT decide

- Q-6 path-A or path-B' or path-D — those remain operator options;
  this ADR is path-B only.
- Whether to drop the 0 rows in `etf_shares_outstanding` via `ALTER ...
  DELETE`. Forward-only; the rows stay (count is 0 anyway).
- The N-PORT cross-check slice that would re-populate the comparator.
  Deferred to a future cycle if/when ratified.
- Whether to re-rank the surviving 15 tickers' contribution weighting
  in F-6. Threshold-pin discipline preserves current operator-readable
  semantics; re-weighting is its own composite-version bump.
- Re-running backtests with `composite_version = 'etf_flow_v1.1'`
  stamped. Optional; not part of the ADR-048 ratification slice.

## Operator decision

Operator picks among Q-6 paths A/B/B'/C/D. **This ADR ratifies only on
path-B.** If operator picks any other path:

- **Path A (paid)** → ADR-048 supersedes irrelevant; HANDOFF removes
  the "recommended fallback" framing for ADR-048; operator
  initiates paid-subscription onboarding.
- **Path B' (per-issuer adapters with Playwright)** → ADR-048 stays at
  PROPOSED; operator additionally authorizes Playwright dep adoption;
  orchestration drafts a follow-up ADR-049 for the per-issuer-adapter
  Plan-of-Record.
- **Path C (indefinite `accepted-as-warning`)** → ADR-048 stays at
  PROPOSED; HANDOFF Q-6 row remains OPEN.
- **Path D (passive watch)** → identical to path-C; ADR-048 stays at
  PROPOSED.

The orchestration's recommendation continues to be **path-B for resolution
+ path-C as the holding pattern until operator engages**. Drafting this
ADR puts the path-B specifics in front of the operator so the decision
can be made with implementation-readiness in view.
