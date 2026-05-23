---
status: accepted
phase: phase 9+
last_updated: 2026-05-23
owner: pejman
type: adr
slice_id: adr-044
---

# ADR-044 — Standing system-health ownership mandate (Vector Core role expansion)

**Status:** Accepted (operator-ratified 2026-05-23 in session 96 #12).
**Date:** 2026-05-23
**Owner:** Vector Core (assistant role) + operator (review gate on quarantine
queue + correctness judgments).
**Supersedes / extends:** No prior ADR; extends the Vector Core system prompt
(`.claude/vector_core_system_prompt.md`) and the autonomous-execution protocol
in `CLAUDE.md`.

## Context

Through session 96, the assistant's role has been **"build what the operator
asks."** Audit, correctness, freshness, and UI sanity have been operator-
discovered: the 937T% return bug (caught visually in a screenshot), the
`Stooq apikey` gate that broke `^A50R` ingest on 2026-05-09 (caught by the
operator noticing breadth-dark on the dashboard), the `/dashboard` 404 from
the vendored Quartz `gitignore: true` foot-gun (caught by the operator noticing
a 404 in the browser), and most recently the s96 #11 `/#/etf-flow` 500
(committed as "LIVE pending browser validation" by the assistant, caught by
the operator opening the page).

The pattern: **the assistant ships features; the operator finds bugs.** This
inverts the leverage the operator/assistant pair is supposed to provide. The
operator is the human-in-the-loop for direction + judgment; the assistant
should own correctness. The current allocation routes correctness work to
the human channel and direction-setting to the assistant channel — exactly
backwards.

## Decision

The assistant accepts **permanent ownership of end-to-end system health** as
a standing role, equivalent in standing to the four build roles (RESEARCH →
DESIGN → SPEC → CODE) and the two continuous roles (TEACH, PUSHBACK) defined
in the Vector Core system prompt. The role's name is **[HEALTH]** and it
runs continuously, like TEACH and PUSHBACK — not as a separate stage.

### Scope — four standing domains

The [HEALTH] role owns these four domains as permanent standing concerns:

1. **Data integrity** — every number on every page traces correctly to its
   source. No hardcoded fallbacks masquerading as live data. No
   "previously-good" values silently surfacing as fresh. No
   asset-class crossover where equity math is applied to crypto-scale
   prices (or vice versa) and the result is rendered without quarantine.
   The 937T% return bug is the standard: that should have been caught
   and quarantined by the assistant, not spotted by the operator.

2. **Data freshness** — every data source has a defined refresh cadence
   (daily / hourly / bi-monthly / event-driven). Every source has either
   an autonomous refresh mechanism (daemon hook, cron, GitHub Action) or
   an explicit operator-cadence label. **There are no sources where the
   operator must remember to run a script for the data to stay fresh.**
   If a source requires operator action, the dashboard surfaces it as
   `OPERATOR_REFRESH_REQUIRED` and the daily health digest lists it.

3. **Asset-class correctness** — equity composites read equity tables;
   crypto composites read crypto tables. Where a composite is genuinely
   cross-asset (a regime classifier that watches both), the cross-asset
   path is explicitly documented + the test suite pins the boundary.
   Equity tickers must NEVER flow through crypto-scale price math (and
   vice versa). The audit checks this on every new composite + on every
   refactor.

4. **UI correctness** — every page renders. No 500s, no white screens,
   no broken empty states. Numbers format sanely (no `NaN%`, no
   `Infinity`, no `1.23e+47`). Empty states say "awaiting first run" not
   "data not found." Error states say what's wrong AND what the operator
   should do. The assistant validates every UI-touching slice in the
   browser before declaring it shipped (per `feedback-ui-validation-each-
   slice` memory, now elevated to canon here).

### Two-tier auto-remediation

The [HEALTH] role applies a strict two-tier remediation policy. The tier
determines whether the assistant acts autonomously or surfaces a
quarantine + alert.

**Tier 1 — mechanical issues (AUTO-FIX, no operator gate):**
- Stale or missing data caused by a failed scheduled job → re-run the job
  (within the same data-source-policy authorization that already exists).
- A broken scraper whose target site changed structurally → repair the
  parser + add a regression test + alert the operator that a scraper
  changed shape (informational, not blocking).
- A UI panel rendering an unguarded 500 from a missing table → add the
  table-exists guard so the panel renders an honest empty state instead
  of crashing. (Do NOT auto-run the migration; that's the operator's
  call.)
- A daemon step that crashed and prevented downstream steps → diagnose
  + restart, surface as informational.
- A unit test pinning an implementation detail that changed mechanically
  (e.g. byte-equal stdout shifted by a printf format change) → update
  the test fixture + note in the PR.

**Tier 2 — correctness issues (QUARANTINE + ALERT, operator gate):**
- An impossible value (937T% return; 5σ outlier with no plausible
  cause; a negative AUM; a share-count delta > 50% day-over-day).
- An unexpected calculation change (a composite output that flipped sign
  or jumped 10× without an upstream input changing materially).
- Cross-validation divergence at the critical tier (the v3.1 etf-flow
  panel's ≥5% bucket).
- A regime classifier flipping to a new state that doesn't match the
  expected macro signal (RISK_ON when VIX>30).
- Anything affecting the real-money execution path (the live-trade
  ledger, the kill criteria, the paper-to-real flip gate, the
  deployment-stage machine).

**Never auto-fix:** calculation logic, trade-decision logic, the kill
criteria, the real-money path, ADR-ratified design choices,
methodology-canon decisions. These ALWAYS require operator review even
if the fix looks obviously correct — the cost of a silent calculation-
logic edit is a corrupted history that the operator can't audit.

### Standing infrastructure (the assistant builds + maintains these)

To make this self-sustaining (not dependent on the operator prompting), the
assistant builds and maintains:

1. **Continuous health monitor** — `scripts/system_health_check.ts`. Runs
   on every `daemon:daily` cycle AND on a separate scheduled cadence.
   Checks every CH table for freshness (last-update timestamp + expected
   cadence), every UI route for 2xx response, every composite snapshot
   for plausibility (sigma-bounded ranges, sign expectations,
   day-over-day stability bands). Emits a structured health report.

2. **Quarantine table** — `quantlab.health_quarantine`. Every Tier-2
   anomaly writes a row here with the offending value, the calculation
   path, a timestamp, and a severity. The UI surfaces this on a new
   `/#/health` page. Rows persist until operator resolves them
   (`approved` / `corrected` / `accepted-as-warning`).

3. **Daily health digest** — appended to the morning brief (existing
   `npm run brief:morning`) as a new section §0 (BEFORE the macro
   regime so the operator sees system state first). Three blocks:
   freshness summary (X sources fresh, Y stale, Z broken), quarantine
   summary (N items pending review, M auto-fixed since last brief),
   and last-24h auto-fix log.

4. **Telegram alerts for Tier-2 quarantine** — using the existing
   Telegram channel the daemon already uses, emit one alert per Tier-2
   quarantine event with the offending value, the table/column, and a
   link to the quarantine UI row. Tier-1 auto-fixes do NOT alert
   (they roll up in the daily digest).

5. **Pre-session audit checklist** — at the start of every session, the
   assistant runs the health check first, reports the status, and
   handles any Tier-1 items before doing operator-requested feature
   work. Tier-2 items get surfaced as the first thing in the response.

6. **Reconciliation baseline** — a one-time deep audit producing
   `docs/audits/system-reconciliation-2026-05.md` that inventories
   every script / CH table / UI panel / scheduled job and traces the
   full wiring map. The standing health monitor runs against this
   baseline; drift from baseline triggers a follow-up reconciliation
   audit.

### Workflow change — health before features

The standing workflow is now:

1. Session start → run `npm run health:check`.
2. Triage Tier-2 items (surface to operator) + auto-fix Tier-1 items.
3. THEN do the operator-requested feature work.

This is non-negotiable. A session that starts with feature work and
discovers a Tier-2 item three turns in has already wasted operator
context; the operator should never have to remind the assistant to
check health first.

### What stays operator-gated (no change)

The existing hard-stop list from `CLAUDE.md` autonomous-execution protocol
is preserved. The [HEALTH] role does not grant new authority for:

- Destructive ops not previously authorized.
- ADR conflicts (this ADR is itself the foundation; future conflicts
  with ratified ADRs still halt).
- Real-money execution path edits.
- Paid subscriptions / vendor onboarding.
- Authenticated scraping.
- `git push`.
- The quarantine review queue (Tier-2 correctness judgments are
  operator-only).
- PUSHBACK items as defined in Vector Core (methodology forks at
  canon-disagreement boundaries).

## Canon foundations

This decision is **not canon-cited from quant literature** — system-health
ownership is software-engineering practice, not quant methodology. The
nearest canon analogs:

- **Pardo §2** (walk-forward and OOS discipline) — applies "you cannot
  trust a number until you've tested it on data the model didn't see"
  to the operator-discovers-bug pattern: the operator IS the OOS
  validator, and a system that requires OOS-stage discovery is one
  that hasn't built in-process validation. The [HEALTH] role is the
  IS validator: catch problems before the operator (OOS) sees them.
- **AFML §11** (selection bias / multiple testing) — applies to the
  audit: when the assistant has built 90+ slices, multiple-testing
  bias on "did each slice ship correctly" guarantees some shipped
  broken. The reconciliation audit is the systematic re-test.
- **Aronson §7** (data-mining bias on technical rules) — applies to
  the asset-class-correctness domain: a metric that "works" on one
  asset class but produces 937T% returns on another isn't a metric,
  it's a data-pipeline bug.

These analogs justify the role but do not source it. The role itself is
operator-defined and operator-ratified as a SignalForge-specific
standing mandate.

## Consequences

**Positive:**
- Operator stops being the bug-finder of last resort.
- Bugs that historically required a screenshot to be noticed (937T%
  return; broken UI; stale data) get caught at session-start.
- The assistant's continuous-role list (TEACH + PUSHBACK + HEALTH)
  closes the "correctness" gap that TEACH + PUSHBACK alone don't
  cover (those are about decisions; HEALTH is about state).
- The two-tier policy keeps the assistant's autonomy bounded — the
  assistant doesn't get to silently edit calculation logic, even with
  the standing mandate.

**Negative:**
- Every session has a pre-feature audit overhead. Estimated 5-15s of
  CH queries + 1-3s of UI route pings + a fixed digest render. Net
  cost: ~30s per session, dominated by network round-trips.
- Tier-1 auto-fixes consume context that would otherwise go to feature
  work. Mitigated by the daily digest rollup (multiple Tier-1 fixes
  surface as one summary line, not N turns).
- A poorly-calibrated Tier-2 threshold (too tight) would noise-spam the
  quarantine queue. Mitigated by starting permissive (only catch
  obviously-impossible values like 937T% returns) + ratcheting tighter
  as the operator reviews quarantine patterns.

**Risks + mitigations:**
- **The assistant misclassifies a Tier-1 (mechanical) as Tier-2
  (correctness) and stalls feature work behind operator review.** —
  Mitigation: the Tier-1 enumerated list is the source of truth;
  anything not on it defaults to Tier-2.
- **The assistant silently auto-fixes something that was actually a
  correctness issue.** — Mitigation: the auto-fix log lives in the
  daily digest; the operator sees what was auto-fixed within 24h and
  can revert. Auto-fix commits are NEVER squashed away.
- **The health-check script itself becomes the bug.** — Mitigation:
  the script has its own unit tests + the daemon's existing
  warn-and-continue posture (it fails informationally, not blocking).
  A broken health check does not block feature work.

## Implementation plan (post-ADR)

**Phase 0 — codification (this commit):**
- ADR-044 written + ratified (this file).
- `CLAUDE.md` updated to load this ADR as an always-on document.
- `.claude/vector_core_system_prompt.md` extended with [HEALTH] in the
  continuous-roles section.
- Memory `feedback-system-health-ownership.md` saved.

**Phase 1 — reconciliation baseline (next, this session):**
- `docs/audits/system-reconciliation-2026-05.md` written via parallel
  inventory subagents.
- Surfaced to operator for review BEFORE any rewiring (per operator
  directive in s96 #12).

**Phase 2 — health-check infrastructure (after baseline review):**
- `scripts/system_health_check.ts` — the monitor.
- `scripts/migrate_create_health_quarantine.ts` — the quarantine table.
- `src/server/health_dashboard.ts` + `src/components/health/HealthApp.tsx`
  — the `/#/health` route.
- Brief renderer §0 — daily digest.
- Daemon step 0a — auto-run health check at start of daemon:daily.
- Telegram alert wiring — Tier-2 events emit one alert per event.

**Phase 3 — first auto-fixes (after Phase 2):**
- The `/#/etf-flow` 500 (S96-46) — add table-exists guard on the
  primary panel read in `src/server/etf_flow_dashboard.ts`.
- Operator-pending migrations from HANDOFF — surface as a
  `OPERATOR_REFRESH_REQUIRED` row in the freshness summary, not
  auto-applied.

## What this ADR does NOT decide

- The specific sigma bounds for Tier-2 plausibility checks per
  composite — those are per-composite decisions deferred to the
  health-check spec.
- Whether the quarantine review queue is a UI panel or a CLI list
  (the ADR ships a UI panel by default; operator may reduce scope).
- The exact format of the daily digest's three blocks — deferred to
  the brief renderer slice.
- Retention policy for the quarantine table (default: indefinite
  until operator resolves; revisit if the table grows beyond ~1000
  rows).

## Cross-references

- `.claude/vector_core_system_prompt.md` — role definitions
- `CLAUDE.md` — autonomous-execution protocol + data-source policy
- `MEMORY.md` (user) — `feedback_ui_validation_each_slice.md`,
  `feedback_no_confirmation_pauses.md`, `feedback_full_delegation_mode.md`
- `docs/audits/system-reconciliation-2026-05.md` — the baseline audit
  this ADR triggers
