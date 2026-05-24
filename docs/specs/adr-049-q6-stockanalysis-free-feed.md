# ADR-049 — Q-6 resolution via stockanalysis.com free-aggregator scrape; ADR-048 superseded

**Status:** Accepted (operator-ratified 2026-05-24 in session 96 #17 Cycle 17:
operator picked "path A — data is needed" and explicitly asked the
orchestration to find a free + reliable source rather than authorize the paid
Sharadar/Polygon subscription. The orchestration's empirical search surfaced
stockanalysis.com as the only free aggregator with parseable static-HTML SHO
data for all 6 non-SSGA tickers; operator authorized implementation via
"please go ahead with implementation").
**Date:** 2026-05-24
**Owner (draft + implementation):** Vector Core orchestration (assistant).
**Owner (ratification):** Operator — picked the path; orchestration executed.
**Supersedes:** [ADR-048](adr-048-etf-flow-universe-amendment.md) (PROPOSED →
**Superseded**: the universe-shrink methodology amendment is no longer the
resolution path for Q-6; the full 21-ticker F-UNIVERSE remains intact).
**Cross-references:**
- `.claude/HANDOFF.md` — Q-6 row, path-space (A/B/B'/C/D) refined Cycle 14
  per S96-93; Cycle 17 added the de-facto "path-A-free" (free aggregator).
- [docs/specs/adr-048-etf-flow-universe-amendment.md](adr-048-etf-flow-universe-amendment.md)
  — the PROPOSED-then-superseded path-B realization.
- [docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md](q6-etf-sho-issuer-survey-2026-05-24.md)
  — the Cycle 14 issuer-direct survey that eliminated iShares/Vanguard/Invesco
  free paths.
- [scripts/etf_flow_stockanalysis_adapter.py](../../scripts/etf_flow_stockanalysis_adapter.py)
  — the implementation; mirrors the SSGA adapter pattern.
- [scripts/etf_flow_issuer_csv_ingest.py](../../scripts/etf_flow_issuer_csv_ingest.py)
  — the existing ingest layer; extended with `--source-file` filter (this
  ADR's mandatory companion edit) so multi-source CSV directories cannot
  silently cross-label rows.
- S96-89 + S96-90 (Cycle 12 — Yahoo ETF SHO regression diagnosed); S96-91 +
  S96-92 (Cycle 13 — SSGA expansion to 15 tickers); S96-93 + S96-94 (Cycle 14
  — issuer-direct survey ruled out path-B'); S96-95 + S96-96 (Cycle 15 —
  ADR-048 PROPOSED for path-B); S96-99..S96-101 (Cycle 17 — this ADR).

## Context

### Q-6 history (recap)

Q-6 entered the operator queue at session 96 #17 Cycle 12 when yfinance's
`Ticker.get_shares_full` ETF endpoint regressed for the full 21-ticker
F-UNIVERSE. Across Cycles 12-15 the orchestration:

1. **Diagnosed** the Yahoo-side regression (S96-89).
2. **Expanded SSGA navhist coverage** from 13 → 15 tickers, restoring fresh
   daily SHO for SPY + DIA + 11 SPDR sectors + JNK + GLD (S96-91 + S96-92).
3. **Surveyed** iShares/Vanguard/Invesco direct endpoints — all dead or
   Playwright-gated (S96-93 + S96-94).
4. **Drafted ADR-048 PROPOSED** for path-B (drop 6 non-SSGA tickers, promote
   v3.1 secondary to primary, shrink F-UNIVERSE 21 → 15) as the
   no-paid-data fallback (S96-95 + S96-96).

The remaining 6 tickers (IVV, VOO, QQQ, IWM, HYG, TLT) stayed
unobservable. The orchestration's standing recommendation was "path-C
holding pattern + path-B ratification if no paid data."

### Cycle 17 operator pivot

Operator picked path-A ("the data is needed") but explicitly rejected the
"paid Sharadar/Polygon" framing of ADR-048 path-A. The operator asked the
orchestration to find a free + reliable source.

The orchestration ran a focused empirical survey of free third-party
aggregators that the Cycle 14 issuer-direct survey did NOT cover (per
CLAUDE.md data-source policy's explicit pre-authorization of "ETF.com
(public fund pages)" and the broader "public-source scraping" allowance):

| Source | HTTP | Outcome |
| --- | --- | --- |
| `finance.yahoo.com/quote/{T}/key-statistics/` | 302 | Cookie / auth needed; fragile |
| `etf.com/{T}` | 200 | `aum: ''` empty fields; data behind runtime API; not static-HTML parseable |
| `nasdaq.com/market-activity/etf/{T}` | 200 | European-market wrappers, not US ETF profile data |
| `etfdb.com/etf/{T}/` | 200 | SHO is JS-rendered (Selenium/Playwright needed); not in static HTML |
| `api.stockanalysis.com/api/symbol/e/{t}/statistics` | 404 | SA has no public REST API |
| `stockanalysis.com/etf/{t}/` | 200 | **Inline JS data blob with `aum`, `sharesOut`, `chart.c` for all 6 tickers** ✓ |

stockanalysis.com was the only free aggregator with parseable static-HTML
data covering all 6 non-SSGA tickers.

### SPY accuracy cross-check (the pre-build gate)

Before authorizing the build, the orchestration ran an empirical accuracy
gate: fetch SPY from stockanalysis.com and cross-check against the SSGA
navhist adapter's authoritative reading (SSGA is issuer-direct, reliable
since Cycle 9 ingest):

| Field | stockanalysis.com | SSGA (known-good) | Delta |
| --- | --- | --- | --- |
| `sharesOut` | "1.03B" → 1,030,000,000 | 1,033,632,116 | 0.4% |
| `aum` | "$768.67B" | $767,753,782,727 | 0.12% |
| Latest close (`chart.c`) | $746.75 | $742.77 (5-21 EOD) | 0.5% (intraday vs EOD) |

**Internal-consistency check passed**: aum / chart.c = $768.67B / $746.75 =
1.030B ≈ sharesOut. **The `nav` field on SA is STALE** ($379.41 vs current
close $746.75 — likely an inception-NAV or otherwise stale snapshot field).
**The implementation does NOT parse `nav`**; uses `chart.c` for the close.

Gate result: **PASS.** Adapter implementation authorized.

### Live-run result (5/6 ingested, VOO rejected loud)

The implemented adapter, run live against all 6 target tickers on
2026-05-24:

| Ticker | shares | close | aum | Internal consistency | Result |
| --- | --- | --- | --- | --- | --- |
| IVV | 1,110,000,000 | $749.94 | $831.96B | 0.05% delta | ✓ ingested |
| QQQ | 663,800,000 | $719.03 | $476.31B | 0.2% delta | ✓ ingested |
| IWM | 269,600,000 | $284.12 | $76.22B | 0.5% delta | ✓ ingested |
| HYG | 204,600,000 | $80.01 | $16.17B | 1.2% delta | ✓ ingested |
| TLT | 509,900,000 | $84.62 | $43.02B | 0.3% delta | ✓ ingested |
| VOO | 2,360,000,000 | $686.53 | $973.41B | **39.9% delta** | ✗ rejected loud |

VOO's `sharesOut: 2.36B` does NOT reconcile with `aum / close = 1.418B`.
The discrepancy is well past the 5% tolerance. Confirmed: only one
`sharesOut` marker on the VOO page (no parser ambiguity). The source
genuinely has a stale or wrong sharesOut for VOO specifically.

**The internal-consistency check did its job**: VOO rejected loud
instead of silently propagating bad data. The remaining 5 tickers
ingested cleanly.

VOO is redundant with SPY + IVV (all three track S&P 500). The
F-UNIVERSE coverage of S&P 500 reads is unaffected.

## Decision

1. **Adopt `scripts/etf_flow_stockanalysis_adapter.py` as the data source
   for the 5 non-SSGA F-UNIVERSE tickers that pass the internal-consistency
   gate (IVV, QQQ, IWM, HYG, TLT).** VOO remains observationally dark until
   either (a) stockanalysis.com fixes its VOO `sharesOut` field, (b) Yahoo
   restores the `Ticker.get_shares_full` ETF endpoint (Q-6 path-D), or (c)
   operator later authorizes a paid feed for VOO specifically.

2. **Reuse the existing `quantlab.etf_shares_outstanding_secondary`
   table.** No new CH table needed; the schema's `source` column tags
   each row (`'ssga-spdr'` vs `'stockanalysis'`). ReplacingMergeTree on
   `(ticker, date)` handles dedup at the database layer.

3. **Add a `--source-file` filter to `scripts/etf_flow_issuer_csv_ingest.py`.**
   This is the **mandatory companion change** — without it, running
   `--source-label stockanalysis --apply` silently relabels ALL CSVs in
   the directory (Cycle 17 verified this regression empirically: 3756
   SSGA rows were briefly mis-labeled before repair). The filter is the
   pinned regression guard.

4. **Run the new adapter on operator-cadence (manual) for a 5-trading-day
   observation window before flipping the v1 primary read path.** The
   composite continues reading from the existing pipeline. After the
   observation window confirms freshness + accuracy across days, a
   follow-up cycle wires:
   - daemon step 1jc (post-close, before SSGA's 1ja),
   - the v1 primary read path's filter to consume `source IN
     ('ssga-spdr', 'stockanalysis')` from the secondary panel.

5. **Mark ADR-048 as Superseded.** The universe-shrink methodology
   amendment is no longer the resolution; the full 21-ticker
   F-UNIVERSE remains intact (with VOO observationally absent
   pending source repair).

6. **Q-6 row in HANDOFF transitions from OPEN to PARTIAL.** Five of six
   non-SSGA tickers are now ingestable; VOO is the residual gap. The
   row stays on the operator queue ONLY because it tracks a
   methodology change being committed (this ADR); after the
   5-day observation cycle wires it to primary, the row closes.

### Why this path over ADR-048 path-B (universe-shrink)

| Criterion | ADR-049 (this) | ADR-048 path-B |
| --- | --- | --- |
| F-UNIVERSE size | 20 (21 − VOO) | 15 |
| Broad-index aggregate F-6 constituents | 5 (SPY + DIA + IVV + QQQ + IWM) | 2 (SPY + DIA only) |
| Asset-class signals restored | QQQ tech-tilt + IWM small-cap + TLT long duration + HYG credit + IVV redundant | None of those |
| Composite-version bump | NOT required (data shape unchanged) | v1 → v1.1 (universe membership change) |
| Reversibility | If SA breaks: F-UNIVERSE drops to 15 (path-B fallback still works) | If SA breaks: no change (already at 15) |
| Cross-validation framework | Restored (5 non-SSGA peers vs SSGA's 15) | Degenerate |

ADR-049 strictly dominates ADR-048 path-B unless stockanalysis.com proves
unreliable in the 5-day observation window — in which case the
fallback is ADR-048 path-B reactivation.

### Why direct HTTP (not Playwright) — canon-thin methodology fork

Per CLAUDE.md autonomous-execution §"Canon-thin methodology forks":

1. **Canon foundations** — data-source policy authorizes both direct
   free APIs and Playwright. The SA blob is embedded in the initial
   static HTML payload; browser execution is unnecessary.
2. **Methodology rigor** — direct HTTP is deterministic + testable;
   Playwright introduces browser-version drift, headless-mode flags,
   page-render timing as variables.
3. **Free parameters** — HTTP has zero tunable knobs; Playwright has
   {browser, viewport, timeout, retry-on-render, headless} surface.

Same logic the SSGA adapter applied. The dependency-surface delta
between adopting Playwright (~hundreds of MB of browser binaries +
ongoing fragility against bot-detection) and the current zero-dep
adapter is decisive in favor of the latter.

### Internal-consistency check — design rationale

The consistency tolerance (5%) is the load-bearing reliability gate
of this path. Without it, a future stockanalysis.com snapshot drift
(`sharesOut` from an older day pinned alongside current `aum` +
current `close`) would silently produce wrong data. The check costs
2 floating-point ops per ticker; the value is catching exactly the
class of failure that the VOO live-run already surfaced.

The tolerance band (5%) is operator-readable, NOT in-sample-tuned —
chosen to be (a) loose enough that intraday-vs-EOD snapshot jitter
doesn't trip false rejects on otherwise-fresh tickers (delta < 1% in
the IVV/QQQ/IWM/HYG/TLT live-run), and (b) tight enough to catch the
VOO-class failure (39.9% delta). A future cycle may tighten to 2%
once we have N days of observations and can characterize the
distribution.

## Implementation (this slice)

Single Cycle-17 slice, orchestrator-direct edits per the codified §3.1
trivial-edit exception (Cycle 16 S96-98) — falls under exception
category 4 (closure cycle for a previously-deferred Tier-1 item) with
all six gates green: no real-money path file, no DDL change (reuses
existing `_secondary` table), no paid-data, tsc baseline preserved
(13), convention pins green (37/37 healthCheck), methodology choice
made by operator (not committed by orchestration).

### Files in this slice

| File | Change | LOC delta |
| --- | --- | --- |
| `scripts/etf_flow_stockanalysis_adapter.py` | new | +366 |
| `scripts/tests/test_etf_flow_stockanalysis_adapter.py` | new | +192 |
| `scripts/etf_flow_issuer_csv_ingest.py` | extended with `--source-file` filter | +20 / -6 |
| `scripts/tests/test_etf_flow_issuer_csv_ingest.py` | +2 regression-pin tests | +33 |
| `package.json` | +3 npm scripts; updated 1 existing script with `--source-file` | +3 / -1 |
| `data/etf_flow_issuer_csv/stockanalysis.csv` | first observation snapshot (gitignored) | n/a |
| `docs/specs/adr-049-q6-stockanalysis-free-feed.md` | this ADR | +~250 |
| `docs/specs/adr-048-etf-flow-universe-amendment.md` | status PROPOSED → Superseded | small edit |

### Test coverage

- **T-SA-1**: happy-path single ticker parses cleanly.
- **T-SA-2**: K/M/B/T magnitude expansion at the `_expand_magnitude` helper.
- **T-SA-3..5**: missing aum / sharesOut / chart.c anchor → loud reject.
- **T-SA-6**: internal-consistency check rejects stale snapshot (VOO-class
  failure pinned in fixture).
- **T-SA-7**: non-positive shares → reject.
- **T-SA-8**: empty body → reject.
- **T-SA-9**: CSV writer emits canonical 4-column schema.
- **T-SA-10**: all-tickers-fail → preserve last-good CSV (data-source
  policy §3).
- **T-SA-11**: partial success → overwrite with partial union (T-EFI-8
  semantic).
- **T-SA-12**: convention pin — DEFAULT_TICKERS = the 6 non-SSGA F-UNIVERSE set.
- **T-SA-13**: dry-run never writes.

Plus 2 new tests on `test_etf_flow_issuer_csv_ingest.py` for the
`--source-file` filter (one happy-path, one error-on-missing).

## Consequences

**Positive:**
- Q-6 resolved without paid-data subscription, without Playwright
  adoption, without authenticated scraping, without F-UNIVERSE
  shrinkage.
- 5 of 6 non-SSGA F-UNIVERSE tickers now ingest fresh daily SHO data
  (IVV, QQQ, IWM, HYG, TLT). The cross-validation comparator
  framework is now operationally useful again (5 non-SSGA peers vs
  SSGA's 15).
- F-6 broad-index aggregate goes from 2 (path-B) to 5 constituents
  (this path). Statistical power restored.
- ADR-044 §"Data integrity" violation closed for 20 of 21 tickers.

**Negative:**
- VOO remains observationally dark pending source repair. Mitigated
  by SPY + IVV both tracking the same S&P 500.
- Single point of failure: if stockanalysis.com changes HTML
  structure, all 5 tickers go dark loud (schema-anchor reject) until
  the regex constants are updated. Mitigated by: (a) loud-fail
  behavior preserves last-good CSV; (b) the SSGA pattern of byte-equal
  anchor checks; (c) ADR-048 path-B remains drafted as a fallback if
  the SA channel proves unreliable over time.
- Internal-consistency tolerance (5%) is conservative. Future cycles
  may tighten as observation history accumulates.

**Risks + mitigations:**
- **SA changes the inline blob format** (e.g. renames `sharesOut`,
  splits the JS module). Mitigation: byte-equal anchor regex → loud
  reject → operator-visible via the next health-check; recovery is a
  one-line regex update.
- **SA starts publishing `sharesOut` from a stale snapshot alongside
  current AUM** (the VOO-class failure pattern, applied to currently-
  OK tickers). Mitigation: the internal-consistency check rejects
  anything past 5% drift; the row stays unobserved on that day.
- **SA blocks scraping via Cloudflare or rate-limiting**. Mitigation:
  daemon-cadence is once per ticker per business day (5-6 requests
  total per day). Well within any reasonable rate budget. If blocked,
  reactivate ADR-048 path-B as the fallback.
- **SA's `chart.c` is intraday during US market hours**. Mitigation:
  daemon step scheduled for post-close (when wired in the future
  cycle); manual operator runs during market hours capture intraday
  values (acceptable for an informational-tier composite).

## What this ADR does NOT decide

- **Daemon step 1jc** wiring the stockanalysis adapter into
  `daily_signal_daemon.ts`. Deferred to a follow-up cycle pending the
  5-trading-day observation window.
- **v1 primary read path flip** to consume from
  `etf_shares_outstanding_secondary` with `source IN ('ssga-spdr',
  'stockanalysis')`. Deferred to the same follow-up cycle.
- **VOO source repair.** Operator may revisit (a) paid feed for VOO
  alone, (b) waiting for SA to fix, (c) accept observational gap. No
  default; surfaces in HANDOFF as a residual Q-6 item.
- **SEC EDGAR N-PORT quarterly cross-check** for accuracy drift
  detection. The Cycle 17 survey verified the EDGAR endpoint is
  reachable + the N-PORT-P form carries `sharesOutstanding`.
  Deferred to a future cycle (separate concern from the daily-cadence
  ingest).
- **Tightening the internal-consistency tolerance** below 5%.
  Requires N days of observation history to characterize the noise
  floor.

## Operator decision (closed)

Operator picked path-A ("the data is needed") + asked the orchestration
to find a free + reliable source rather than authorize the paid
Sharadar/Polygon subscription. This ADR is the realization of that
choice. The 5-day observation window is the operator-authorized
verification gate before flipping the primary read path.
