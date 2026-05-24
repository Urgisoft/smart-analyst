# ADR-050 — Q-5 resolution via Path D: CBOE daily-options JSON ingest

**Status:** Accepted (orchestration-authored 2026-05-24 in session 96 #19 Cycle 21; the source change is fully within data-source policy authorization and requires no operator sign-off per the orchestration §7.1 reclassification — operator-queue Q-5 closes as orchestration-resolved).
**Date:** 2026-05-24
**Owner:** Vector Core orchestration (assistant). Operator notified at next session via HANDOFF.
**Supersedes:** [ADR-045](adr-045-phase1-v3-cboe-putcall-input-window.md) (§4 path picks A/B/C/D are now resolved by Path D — the only one ADR-045 didn't enumerate at the time of writing).
**Extends:** [ADR-044](adr-044-standing-system-health-ownership.md) §"Data integrity" + §"Data freshness". Operates under the SignalForge data-source policy in [CLAUDE.md](../../CLAUDE.md).

## Context

[ADR-045](adr-045-phase1-v3-cboe-putcall-input-window.md) (Cycle 1 of multi-agent orchestration; s96 #15) pinned the corrupted-input window
2019-10-05 → 2026-05-23 for phase1_v3's `sentiment_extreme` PRIMARY arm
(CBOE TOTAL P/C 5d-MA reads from `quantlab.macro_indicators_cboe`). The
ADR documented four operator-facing paths (A paid DataShop / B
methodology amendment / C forward-only scrape / D hybrid of B + C) and
recommended Path D pending operator Q-5 sign-off.

The operator engaged on Q-5 in s96 #19 (2026-05-24) and constrained the
resolution: **"Q-5 needs to have free reliable data"** — Path A (paid
DataShop) dead. Cycle 20 slice 2 (research-only) probed nine candidates
for a free, reliable, like-for-like replacement and found one not
enumerated in ADR-045's original path set:

A free, anonymous CBOE daily JSON endpoint at

```
https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options
```

— live continuously since **2019-10-07** (the first trading day after
the legacy CSV froze 2019-10-04), serving the TOTAL / EQUITY / INDEX /
EXCHANGE TRADED PRODUCTS P/C ratios plus raw call/put volume + open
interest, one JSON file per trading day, ~6KB per file, no API key, no
authentication, no rate-limit observed across 20 rapid sequential
fetches in research. The full finding lives at
`docs/analysis/q5-path-d-cboe-json-2026-05-24.md`.

**Cycle 21 (s96 #19) ships the ingest** — a Data-Ingest worker + an
Infra worker pair delivered in parallel. This ADR documents the
resolution + supersedes ADR-045's pending-resolution status.

## Decision

This ADR locks in five things.

### 1. Path D is the active resolution for Q-5

Path D replaces ADR-045 §4's A/B/C/D path menu. The Path-D-naming is
preserved (the analysis doc and HANDOFF use "Path D"); it refers
specifically to the JSON-endpoint resolution, NOT to ADR-045's original
"D = hybrid of B + C." ADR-045 §4 (D) is superseded.

The new ingest is `scripts/cboe_putcall_json_ingest.py`. It walks
trading days from `--start` (default 2019-10-07) to `--end` (default
today UTC), fetches the JSON endpoint per date with stdlib `urllib.request`,
schema-validates the response, parses `payload["ratios"]` (NOT
`payload["data"]["ratios"]` — the analysis doc's prose was shorthand;
the Data-Ingest worker corrected and pinned this with a regression test),
extracts the `"TOTAL PUT/CALL RATIO"` entry's `value` as a float (NaN
explicitly rejected), and writes to `quantlab.macro_indicators_cboe`
with `series_id="CPC"` (unchanged) and `source="cboe_json"` (new label
to segregate provenance from the legacy `source="cboe"` rows). The
ReplacingMergeTree engine on `(series_id, observation_date)` keeps
re-fetches idempotent. The two source labels coexist in the same table
without collision because the date windows do not overlap (legacy ends
2019-10-04; JSON starts 2019-10-07).

The daemon-cadence forward hook is wired as **step 1b''** in
`scripts/daily_signal_daemon.ts`, between FRED fetch (step 1b') and
phase1_v3 macro-classify-v3 (step 1c). The step is gated by the same
`NO_MACRO || NO_FETCH` posture as the FRED step; failure surfaces as a
warning anomaly (non-fatal). The daemon's per-run window is 7 calendar
days back from today UTC — narrow enough to keep wall-clock predictable
(a handful of fetches per run), wide enough to cover a 5-trading-day
window plus a long weekend if the daemon misses days. GAP-3 (CBOE
daemon hook) resolves as a side-effect of step 1b'' landing.

### 2. The historical 2019-10-07 → 2026-05-24 backfill is orchestration-owned and one-shot

Per the data-source policy + the orchestration's working-model change
(2026-05-23, s96 #14), the orchestration owns ingest execution for free
authorized sources. Cycle 21 ran the backfill `npm run cboe:ingest:json
-- --start 2019-10-07 --sleep-ms 300` after the Data-Ingest worker's
script landed. The CH table now carries fresh CBOE TOTAL P/C rows for
every trading day in the 6.5-year window that was previously dark.

The legacy CSV ingest (`scripts/cboe_putcall_ingest.py`) is **not
removed**. It remains the canonical ingest for the 2003-10-17 →
2019-10-04 archive window (the `cboe` source label). The two ingests
operate on disjoint date windows; the table is the union of both.

### 3. Audit-trail integrity preserved — no retroactive rewrite of `macro_regimes` historical rows

[ADR-044](adr-044-standing-system-health-ownership.md) §"Standing
infrastructure" item 2 requires that historical classifier outputs
persist as-they-were-classified-at-the-time. The 2019-10-07 → 2026-05-23
classifier outputs in `quantlab.macro_regimes` are **not rewritten**.
They stand as evidence of the corrupted-input window. The Q-5
quarantine row in `quantlab.health_quarantine` stays pinned as
`accepted-as-warning` referencing both ADR-045 and this ADR.

**Forward** re-classification under non-corrupted CBOE inputs starts
on the next phase1_v3 classify-call after this ADR + the backfill land
together. The 5d-MA window in phase1_v3 needs 5 consecutive fresh CBOE
days; once 5 such days are in CH (continuously from any post-backfill
date), the primary arm of `sentiment_extreme` is fully restored.

### 4. The Q-5 quarantine row's drop condition is preserved

The Q-5 row in `quantlab.health_quarantine` drops once **the
classifier produces non-corrupted-input output for ≥5 consecutive
trading days** post-Path-D deployment. Operationally, this is ~5
trading days from the first daemon run that successfully executes
step 1b''. The orchestrator drops the row in a follow-up cycle (no
operator action required); the row's `accepted-as-warning` status
means it doesn't block anything in the meantime.

### 5. The optional future upgrade (EQUITY P/C refinement) stays as a future RESEARCH→DESIGN cycle

The JSON endpoint publishes EQUITY / INDEX / ETP P/C separately. The
canonical "smart-money vs dumb-money" framing in the TA literature
distinguishes equity-only P/C (retail-heavy) from index P/C
(institutional hedging). The current classifier uses TOTAL, which
conflates both. The new ingest supports `--ratio equity` /
`--ratio index` / `--ratio etp` flags out of the box; the test suite
pins the case-sensitive ratio key names. **A methodology refinement
of `sentiment_extreme` to use equity-only P/C is a future ADR's
problem, not this ADR's.** Nothing in Path D forecloses that future
work; the data is there when the methodology cycle fires.

## Canon foundations

- **`docs/specs/macro-regime-classifier-phase1_v3.md` §2.1, §3 Turn B**
  — the canonical SPEC defines the sentiment_extreme primary input as
  the 5d-MA of CBOE TOTAL P/C. Path D restores this primary input
  without any methodology amendment; the SPEC stands unchanged.
- **CLAUDE.md data-source policy** — "free public scraping via
  Playwright (or stdlib HTTP)" + "anonymous public APIs without API
  keys" are pre-authorized. The CBOE JSON endpoint is anonymous,
  CDN-served (cdn.cboe.com), no key, no auth, no captcha. Direct fit.
- **[ADR-044](adr-044-standing-system-health-ownership.md) §"Data
  integrity" + §"Data freshness"** — every number traces to source +
  every source has a refresh cadence + autonomous trigger. Path D
  satisfies both: the JSON endpoint is the source-of-truth; the
  daemon step 1b'' is the autonomous trigger.
- **[ADR-044](adr-044-standing-system-health-ownership.md) §"Standing
  infrastructure" item 2** — no retroactive edits to historical
  classifier outputs. Decision §3 above honors this verbatim.
- **Multi-agent orchestration design §7.1 + §7.3** (`docs/architecture/multi-agent-orchestration.md`)
  — operator queue is exclusively four real-money triggers. The
  Q-5 Path D source-swap is NOT one of them; it's a data-source change
  within pre-authorized policy. Orchestration owns; operator notified
  in HANDOFF, not gated.

## Consequences

**Positive:**

- The 6.5-year corrupted-input window closes. phase1_v3's
  `sentiment_extreme` primary arm becomes operative again ~5 trading
  days after the next daemon cycle.
- Q-5 closes without paid subscriptions, methodology amendments, or
  scrapers against HTML pages — the JSON endpoint is CBOE's own
  canonical published feed.
- GAP-3 (CBOE daemon hook) resolves as a side-effect — one fewer item
  in the standing-health backlog.
- Future EQUITY P/C refinement is unlocked (the data is ingested) but
  not forced — methodology change stays a separate decision.

**Negative:**

- The fix shipped 6.5 years after the source froze. The standing
  system-health monitor (ADR-044) is what surfaced the original gap
  and made Path D's research a first-class cycle artifact rather than
  a hand-built audit. **Until ADR-044 landed (s96 #12), no automated
  check would have caught this** — the historical operational damage
  is in-scope for the ADR-044 standing mandate's "this is why it
  exists" framing.
- The CBOE JSON endpoint is undocumented in CBOE's public API surface
  (the analysis doc found it via the
  `debegr92/cboe_pcr` Python reference + direct probing). It could
  theoretically be retired or restructured by CBOE without notice.
  Mitigation: schema-validation pin in the ingest catches structural
  changes loudly; the test suite pins the exact response shape; a
  future shape-change triggers a Tier-1 mechanical fix (parse-failure
  alert) per ADR-044.

**Risks + mitigations:**

- **The JSON endpoint disappears or changes shape.** Mitigation:
  schema-validation on every fetch raises loud. The daemon step is
  non-fatal so a broken endpoint surfaces as a warning anomaly, not
  a daemon crash. Fallback paths from ADR-045 stay reachable (Path B
  methodology amendment is a 2-line SPEC patch; Path A paid DataShop
  remains an operator option).
- **Re-classified forward outputs diverge significantly from the
  historical fail-soft-VIX-only path.** This is the EXPECTED outcome
  — the primary arm being live means more `sentiment_extreme`
  firings, not fewer. Mitigation: the Q-5 quarantine row stays
  `accepted-as-warning` until 5 consecutive fresh CBOE days land,
  giving the orchestration a checkpoint to verify the classifier's
  forward behavior is plausible before dropping the row.
- **A future EQUITY P/C methodology refinement requires an ADR.**
  Mitigation: Decision §5 above pins it as a future cycle; no
  silent drift here. The ingest's `--ratio` flag makes the
  refinement a script-side default change + a SPEC update + a
  regression test, not a re-ingest.

## Implementation status (Cycle 21, s96 #19)

### Phase 0 — codification (this commit)

- ADR-050 written (this file).
- ADR-045 status line updated to `Superseded by ADR-050` (this commit).
- HANDOFF.md rewrite at cycle end (orchestrator-owned per autonomous-
  execution protocol).

### Phase 1 — shipped this cycle

- `scripts/cboe_putcall_json_ingest.py` (Data-Ingest worker, +522 LOC)
- `scripts/tests/test_cboe_putcall_json_ingest.py` (23 pytests, all pass)
- `scripts/_probe_cboe_putcall_json.ts` (smoke probe, +155 LOC)
- `src/server/daemon_cboe_putcall_fetch.ts` (Infra worker, +97 LOC)
- `scripts/daily_signal_daemon.ts` step 1b'' wiring (+35 LOC)
- `package.json` npm scripts `cboe:ingest:json` + `cboe:ingest:json:dry` (+2 LOC)
- `src/server/health_check.ts` macro_indicators_cboe entry flipped to
  `autonomous: true`, operatorAction → `npm run daemon:daily`, `why`
  rewritten (+3 / -4 LOC)
- `scripts/tests/daemonCboePutCallFetch.test.ts` (10 tests, all pass)
- Backfill 2019-10-07 → today run via `cboe:ingest:json --sleep-ms 300`
  (one-shot, orchestrator-executed; ~1,640 trading days populated).
- ADR-050 + ADR-045 status amendment (this file + ADR-045 line edit).

### Phase 2 — deferred to a follow-up cycle (≥5 trading days post-deploy)

- Forward re-classify of phase1_v3 over the 6.5-year window
  (Composite worker). The historical `macro_regimes` rows are
  preserved per Decision §3; this future cycle writes NEW rows under
  a new `classifier_version` label if and only if the operator
  decides backtest panels should reflect a "what would phase1_v3 have
  said with the correct CBOE input?" counterfactual. **The orchestration's
  default is to NOT run this re-classify** — historical rows are
  audit-trail; counterfactual rewrites are a separate methodology
  decision.
- Q-5 quarantine row drop once 5 consecutive fresh CBOE days have
  landed and the classifier's forward output is verified plausible.

## What this ADR does NOT decide

- The EQUITY-vs-TOTAL P/C methodology refinement (Decision §5 above
  defers to a future cycle).
- Whether to write counterfactual `macro_regimes` rows under a new
  classifier_version label (Phase 2 above defers).
- Any change to the SPEC's primary/secondary arm structure (Decision
  §1 explicitly preserves the SPEC unchanged).
- Anything about the legacy `scripts/cboe_putcall_ingest.py` ingest
  (Decision §2 above: not removed).

## Cross-references

- `docs/specs/macro-regime-classifier-phase1_v3.md` §2.1, §3 Turn B —
  canonical SPEC preserved unchanged
- `docs/specs/adr-044-standing-system-health-ownership.md` — parent
  standing mandate
- `docs/specs/adr-045-phase1-v3-cboe-putcall-input-window.md` —
  superseded by this ADR
- `docs/architecture/multi-agent-orchestration.md` §7 — operator
  queue definition; Q-5 closes as orchestration-resolved
- `docs/analysis/q5-path-d-cboe-json-2026-05-24.md` — full research
  finding that underpins this ADR
- `src/server/macro_regime_v3.ts:945` — the load-bearing read site
- `scripts/cboe_putcall_json_ingest.py` — the new ingest
- `src/server/daemon_cboe_putcall_fetch.ts` — the daemon helper
- `scripts/daily_signal_daemon.ts` step 1b'' — the daemon hook

## Revision log

| Date | Change |
| --- | --- |
| 2026-05-24 | Initial creation (s96 #19 Cycle 21). Orchestration-authored after Data-Ingest worker + Infra worker pair delivered Path D end-to-end. Q-5 closes; ADR-045 marked Superseded. |
