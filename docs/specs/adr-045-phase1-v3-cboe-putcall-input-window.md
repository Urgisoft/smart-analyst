# ADR-045 — phase1_v3 CBOE put/call corrupted-input window + free-source exhaustion

**Status:** Superseded by [ADR-050](adr-050-q5-path-d-cboe-putcall-json-ingest.md) (2026-05-24, s96 #19 Cycle 21). Originally Accepted (provisional) — orchestration-authored 2026-05-23 in session 96 #15 Cycle 1; the §4 path-pick Q-5 closed via Path D (a free CBOE JSON endpoint not enumerated in this ADR's original path set). This file is preserved as the historical record of the corrupted-input window; the resolution lives in ADR-050.
**Date:** 2026-05-23
**Owner:** Vector Core orchestration (assistant) + operator (Q-5 sign-off gate).
**Supersedes / extends:** Extends `docs/specs/macro-regime-classifier-phase1_v3.md` §2.1 (sentiment_extreme) + §3 Turn B. Operates under [ADR-044](adr-044-standing-system-health-ownership.md).

## Context

The phase1_v3 macro regime classifier (`src/server/macro_regime_v3.ts:945`)
reads `quantlab.macro_indicators_cboe` for the `sentiment_extreme`
category's primary input: the 5-day moving average of the CBOE TOTAL
put/call ratio (`CPC`). Per the SPEC §3 Turn B, this is the *primary*
sentiment_extreme signal; the secondary signal is the
VIX/VIX3M ≤ 0.80 complacency gate, computed at classify-time from
existing VIX / VIX3M candles. The category fires on a logical OR of the
two arms (primary 5d-MA crosses threshold OR secondary VIX/VIX3M ≤ 0.80).

### What we discovered in s96 #15 Cycle 1

The health check (ADR-044's standing monitor) surfaced
`macro_indicators_cboe` as **very-stale (2424 days)**. Last observation
was **2019-10-04**. Every classify-call since the ingest paused has been
reading a stale 2019-era 5d-MA value as if it were live data.

The Cycle 1 Data-Ingest worker A attempted the ADR-044 Tier-1
auto-remediation (re-run the failed ingest). The investigation found:

1. **The default CBOE CDN URL** (`https://cdn.cboe.com/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv`)
   returns **HTTP 403** regardless of User-Agent.
2. **CBOE has retired the free bulk historical CSVs for post-2019 data.**
   The current archive endpoints (under
   `https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/`,
   including `totalpc.csv`, `equitypc.csv`, `indexpc.csv`, `etppc.csv`,
   `vixpc.csv`, `spxpc.csv`, plus `*archive.csv` variants) all return
   200 OK and parse cleanly — **but every single one stops on
   2019-10-04**, the exact date our CH table ends. The diagnose script's
   own header comment (`scripts/_diagnose_put_call_thresholds.ts:35-37`)
   already pinned this constraint: *"CBOE 2019-present is gated behind
   DataShop. Corpus stops at 2019-10-04."*
3. **All alternative free sources were exhausted in the same worker
   run:**
   - **Yahoo Finance** — `^CPC` / `CPC` / `^CPCE` / `^CPC-INDEX` all
     return "delisted / not found."
   - **Stooq** — `^cpc` and `cpc.us` are captcha-apikey-gated (same
     `STOOQ_APIKEY` blocker as `^A50R`).
   - **FRED** — no `CBOEPC` / `PUTCALL` / `PUTCALLRATIO` / `CBOEPUTCALL`
     / `CBOEVPC` series under any tested ID (FRED_API_KEY not set; a
     definitive catalog search would need the key).
   - **Nasdaq Data Link** — returns HTTP 403 even with configured API
     key.
4. **The CBOE daily statistics page** does embed the previous trading
   day's TOTAL put/call ratio as a single spot reading inside its
   Next.js HTML payload — but only one number per day, no history. A
   forward-fill scraper could rebuild going forward but **cannot
   recover the 2019-2026 gap**.

The 2019-2026 gap is therefore **permanent under the current
data-source policy** ([CLAUDE.md](../../CLAUDE.md) data-source policy:
free APIs + free public scraping authorized; paid subscriptions
including CBOE DataShop blocked without operator sign-off).

## Decision

This ADR locks in three things and surfaces one to the operator queue.

### 1. The corrupted-input window is officially 2019-10-05 → 2026-05-23 (~6.5 years)

All `quantlab.macro_regimes` rows classified by phase1_v3 during this
window had a `sentiment_extreme` primary input that was reading the
2019-10-04 frozen value (or any pre-2019-10-04 stale value depending on
the 5d-MA window). Downstream consumers of `sentiment_extreme` for
classification dates **2019-10-05 → 2026-05-23** must treat the
category's PRIMARY arm as **dark** (NULL / unreliable) and rely on the
secondary VIX/VIX3M arm alone, OR re-classify under the methodology
amendment in §4 once ratified.

### 2. No retroactive rewrite of `macro_regimes`

The historical record stays. Audit-trail integrity per
[ADR-044](adr-044-standing-system-health-ownership.md) requires that
historical classifier outputs persist as-they-were-classified-at-the-time.
A Tier-2 quarantine row is the correct surface for this kind of
data-corruption window — once Phase 2 of ADR-044 ships
(`quantlab.health_quarantine`), the historical window writes one row
there with the corruption pattern, the corrupted-input dates, and the
no-retroactive-rewrite policy. **The corruption is documented, not
erased.**

### 3. Forward-fix from 2026-05-24 onward is via the secondary arm + optional daily scrape

Until Q-5 is resolved (§4), the classifier continues to run with the
primary arm dark for new dates. The fail-soft SPEC §3 Turn B design
holds: `sentiment_extreme` still fires off the VIX/VIX3M ≤ 0.80 arm.
Operationally, the dashboard's `/#/health` page will continue to flag
`macro_indicators_cboe` as **very-stale**; the operator brief should
not treat this as a freshness gap requiring action — it's a documented
permanent gap, not a missed cycle.

If the operator picks path C in §4 (forward-only scrape), a new
Cycle's worker promotes the CBOE daily-page scrape to a daemon step
and begins rebuilding history from today forward; the gap permanently
stays empty for 2019-10-05 → 2026-05-23.

### 4. Q-5 surfaced to operator queue — methodology amendment options

The operator chooses among:

- **(A) Subscribe to CBOE DataShop** (paid) — backfills the gap; gold
  standard; cost is the subscription. **Reaches operator queue.**
- **(B) Amend the SPEC** to canonicalize VIX/VIX3M as the primary
  sentiment_extreme input, demoting CBOE to historical reference. The
  SPEC's existing OR-design supports this minimally; the canon
  citations (SPEC §2.1, §3 Turn B) need a documented revision.
- **(C) Forward-only scrape** of CBOE's daily statistics page — a new
  Data-Ingest worker writes a Playwright-free pure-HTML scraper that
  pulls one number per day forward. The historical gap stays empty;
  primary arm goes live again ~5 trading days after deployment (5d-MA
  window). Cost: maintain a scraper against CBOE's Next.js page
  structure (per data-source policy: schema validation + parse-failure
  alert + cache fallback).
- **(D) Hybrid: B for the historical window + C for forward** — keep
  the VIX/VIX3M canonicalization in the historical record + restore
  CBOE as the primary input for new classifications once the
  forward-scrape has 5 days of data.

The orchestration recommends **(D)** as the lowest-cost path that
preserves SPEC intent and avoids paid subscriptions. The decision is
the operator's; this ADR is provisional pending Q-5.

## Canon foundations

- **SPEC §2.1, §3 Turn B** of
  `docs/specs/macro-regime-classifier-phase1_v3.md` — sentiment_extreme
  category's primary/secondary arm structure. The fail-soft OR design
  is the canon basis for §3 here ("classifier keeps running with the
  primary arm dark").
- **[ADR-044](adr-044-standing-system-health-ownership.md)
  §"Data integrity" + §"Data freshness"** — every number on every page
  traces to source; every source has a refresh cadence + autonomous
  trigger OR an explicit `OPERATOR_REFRESH_REQUIRED` label. This ADR
  formalizes the CBOE source's status as **permanently
  `OPERATOR_REFRESH_REQUIRED` pending Q-5 outcome** rather than a
  fixable freshness gap.
- **CLAUDE.md data-source policy** — paid subscriptions (CBOE DataShop
  specifically named) are operator-gated. The orchestration cannot
  resolve (A) autonomously; it can resolve (B) / (C) / (D) only
  through the operator's Q-5 choice because (B) / (D) amend SPEC
  canon and (C) introduces an authenticated-public-scraping pattern
  that hasn't been operator-reviewed for CBOE specifically.
- **Audit-trail integrity** ([ADR-044](adr-044-standing-system-health-ownership.md)
  §"Standing infrastructure" item 2) — no retroactive edits to
  historical classifier outputs; quarantine surfaces the corruption
  pattern instead.

## Consequences

**Positive:**
- The corrupted-input window is officially named, dated, and
  documented. Downstream consumers can correctly discount the primary
  arm for any classification dated 2019-10-05 → 2026-05-23.
- The fail-soft OR design in the SPEC means `sentiment_extreme` has
  not been silently dark for the full window — it was firing off the
  secondary VIX/VIX3M arm whenever applicable. The actual operational
  damage is bounded to "primary arm contribution lost," not "category
  unreachable."
- The historical record is preserved (audit-trail integrity).
- The operator sees a single Q-5 row that captures all four paths +
  the orchestration's recommendation; no decision-paralysis menu.

**Negative:**
- The classifier ran with a corrupted primary input for ~6.5 years
  without anyone noticing. The standing system-health monitor
  (ADR-044) is what surfaced it — pre-ADR-044, no automated check
  would have caught this. This is in-scope for ADR-044's standing
  mandate; the ADR itself is the answer to "why didn't we catch this
  earlier."
- Q-5 stays open until the operator chooses. Until then, the primary
  arm is permanently dark for new classifications.
- Path (C) introduces a CBOE-specific scraper that needs ongoing
  maintenance (CBOE has changed its page structure twice historically;
  the per-source policy requires schema validation + alert).

**Risks + mitigations:**
- **The operator picks (A) → ongoing subscription cost.** Mitigation:
  cost is the subscription; the methodology gain is direct (CBOE TOTAL
  put/call is the canonical sentiment indicator; FRED / VIX-derived
  alternatives are less load-bearing for the SPEC's intent).
- **The operator picks (B) → SPEC amendment delays composite
  semantics.** Mitigation: the SPEC change is small (rephrase §2.1's
  primary/secondary; secondary becomes primary); orchestration writes
  the SPEC patch + a regression test pinning the new canonical input.
- **The operator picks (C) → scraper fragility.** Mitigation: per the
  data-source policy, the scraper ships with schema validation on
  every fetch, parse-failure alerts, and a cache-fallback to last
  known good. A scraper-shape-change triggers an alert, not silent
  bad data.
- **No-decision drift.** If Q-5 stays open for many sessions, the
  primary arm stays dark and the orchestration must keep documenting
  the gap in HANDOFF + the morning brief. Mitigation: this ADR is
  provisional; revisit Q-5 status at every session start (it's the
  third item on the operator queue, and the morning-brief §0 digest
  surfaces it).

## Implementation plan

### Phase 0 — codification (this commit, Cycle 1)

- ADR-045 written (this file).
- HANDOFF.md updated: Q-5 row added to Operator queue; cycle summary
  documents the F2 escalation; the §watchouts call out the
  corrupted-input window.

### Phase 1 — once Phase 2 of ADR-044 ships (the `quantlab.health_quarantine` table)

- The orchestration writes one quarantine row pinning the
  2019-10-05 → 2026-05-23 corrupted-input window for
  `macro_indicators_cboe.CPC` 5d-MA reads in phase1_v3.
- The `/#/health` UI surfaces this row in the quarantine panel with
  status `accepted-as-warning` + a link back to this ADR.
- The morning brief §0 digest lists the quarantine as a permanent
  documented warning (not a Tier-2 review queue item, because there's
  nothing for the operator to *resolve* in the routine sense — the
  resolution lives in Q-5).

### Phase 2 — once Q-5 resolves

- **If (A):** new Data-Ingest worker writes a DataShop ingest with the
  operator-provided credentials; backfill 2019-10-05 → present;
  re-classify forward from a freshly-backfilled CBOE input (this is
  the deferred "Composite worker re-classify phase1_v3 forward" from
  Cycle 1).
- **If (B):** orchestration writes a SPEC amendment commit
  (`docs/specs/macro-regime-classifier-phase1_v3.md` §2.1 + §3 Turn B)
  + a regression test pinning the new canonical input. No re-classify
  needed — the secondary arm has been the operative arm during the
  corrupted-input window anyway.
- **If (C):** new Data-Ingest worker writes a Playwright-free pure-HTML
  scraper of CBOE's daily statistics page; daemon step promotion;
  schema validation + parse alerts. Primary arm goes live ~5 trading
  days after deployment.
- **If (D):** both (B) for the historical window + (C) for forward.
  Orchestration documents the cross-over date in the SPEC amendment.

## Cross-references

- `docs/specs/macro-regime-classifier-phase1_v3.md` §2.1, §3 Turn B
  — the canon that this ADR amends or preserves depending on Q-5
- `docs/specs/adr-044-standing-system-health-ownership.md` —
  parent standing mandate that surfaced this issue
- `docs/architecture/multi-agent-orchestration.md` §7 — operator queue
  definition; Q-5 lives there
- `src/server/macro_regime_v3.ts:945` — the load-bearing read site
- `scripts/cboe_putcall_ingest.py` — the dead ingest (DEFAULT_CBOE_URL
  returns 403; the URL constant should be refreshed in a follow-up
  Infra worker per Worker A's signal)
- `scripts/_diagnose_put_call_thresholds.ts:35-37` — the pre-existing
  comment that already pinned the 2019-10-04 freeze (it was inline
  documentation; this ADR elevates it to ratified scope)

## Revision log

| Date | Change |
| --- | --- |
| 2026-05-23 | Initial creation (s96 #15 Cycle 1). Orchestration-authored after Data-Ingest worker A's investigation. Q-5 added to operator queue. ADR is provisional pending Q-5 outcome. |
