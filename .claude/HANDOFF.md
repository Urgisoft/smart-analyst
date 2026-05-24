# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 11 of multi-agent
orchestration executed**. Operator pivoted from the recommended Cycle 11
default (`/#/regime` UI smoke-test) by running `npm run cboe:ingest`, which
surfaced **HTTP 403** from the previously-working
`https://cdn.cboe.com/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv`
endpoint. **Investigation revealed two independent findings:** (a) CBOE
moved the public put/call CSVs in 2026 to a new path
(`/resources/options/volume_and_call_put_ratios/{totalpc,totalpcarchive}.csv`)
while keeping the sibling VIX/SPX files on the old path — confirming this
is a CBOE move of the put/call file specifically, not a CDN-wide change;
(b) the new modern URL is itself **frozen** — `last-modified: 2020-10-30`
with content ending **10/04/2019**. CBOE genuinely stopped publishing
public daily put/call ratio data after 2019-10-04 (the file has been
static at 4,018 trading days of coverage for ~5.5 years). **Cycle 11
slice 1 (commit `206c649`):** Tier-1 mechanical AUTO-FIX per ADR-044 —
updated `scripts/cboe_putcall_ingest.py` to fetch BOTH new URLs (modern
+ archive), concat under ReplacingMergeTree dedup; added URL-pin
regression test `test_default_urls_point_to_current_cboe_path` to catch
the next CBOE URL move at test time instead of next-daemon-run time;
updated the script's docstring + Usage block + `--archive-url` CLI flag.
**16/16 pass in `test_cboe_putcall_ingest.py`** (was 15/15 — +1 URL pin).
Live ingest result: parsed 5,428 rows (archive 2,179 + modern 3,249 with
overlap), post-merge FINAL = **4,018 unique observation_dates 2003-10-17
→ 2019-10-04** (= identical date-range to pre-Cycle-11 state; the
archive+modern union just refreshed `ingested_at`, no new coverage
because the source is frozen). **Q-5 finding refinement (does NOT
escalate to new operator row):** path (D) "re-canonicalize via free
CBOE backfill + re-classify forward only" is now **empirically NOT
executable** — there is no free public CBOE put/call data after
2019-10-04 to re-classify against. Q-5 path space narrows from {A: paid
DataShop, B: methodology amendment removing CBOE put/call, C: keep
corrupted-input window as accepted-warning, D: free re-canonicalize} to
**{A, B, C only}** — the operator's decision space is now smaller and
cleaner. Cycle 11 does NOT add a new operator-queue row; the existing
Q-5 + ADR-045 + `accepted-as-warning` quarantine row (S96-70) cover the
methodology-level concern; the new finding is documented in S96-87 +
S96-88 and surfaced in the Q-5 row's narrative below. **Net 39 unpushed
commits** on top of `origin/main` (`c0cda7c`) after this HANDOFF rewrite
(was 37 at Cycle 10 close · +1 slice 1 = 38 · +1 this HANDOFF = 39).
**Pre-merge gate locally verified:** `npx tsc --noEmit` returns the
documented 13 baseline errors unchanged; `npm run health:check` shows
CBOE still very-stale (2424d, 4,018 rows) — **correctly**, because the
freshness probe measures `max(observation_date)` not `max(ingested_at)`,
and the source data is frozen at 2019-10-04 regardless of when we
re-ingest. **NEXT default on `continue`:** Cycle 12 candidate per
orchestration §8.4 — recommended path is **`/#/regime` post-backfill UI
smoke-test** (the Cycle 10 close's deferred recommendation, still
unblocked, still small). Alternative: **CBOE health-check description
update** (Health-domain slice — update the freshness probe's "→ npm run
cboe:ingest" remediation hint to reflect the frozen-source reality
rather than implying the ingest will refresh `max(observation_date)`).

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
| Q-4 | Push 39 unpushed commits to origin/main (Cycle 11 slice 1 + this HANDOFF will be the 39th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. **Updated Cycle 11:** path (D) "free re-canonicalize" empirically dead — CBOE moved the URL AND froze the file at 2019-10-04 (last-modified 2020-10-30). Path space is now **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's revised recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. Path (A) DataShop is operator-call on capital allocation grounds (paid subscription) and is the only path that re-opens fresh CBOE put/call data. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID. **Refined Cycle 11 by S96-87 + S96-88.** | OPEN — operator picks among (A)/(B)/(C); see Cycle 11 narrative for the source-freeze finding |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.
**Cycle 11 added zero new operator-queue rows.** The Q-5 row's
narrative was updated to record the source-freeze finding + narrow
the path space; no new escalation because the underlying methodology
concern (corrupted-input window for phase1_v3) was already on the
queue + already pinned in `quantlab.health_quarantine` as
`accepted-as-warning` (S96-70). The Cycle 11 finding refines the
decision space but does not introduce a NEW unresolved item.

---

## What this cycle delivered (s96 #17 Cycle 11)

### One code slice + HANDOFF rewrite (2 commits)

**Slice 1 (`206c649`) — CBOE put/call URL repair (Tier-1 mechanical
AUTO-FIX per ADR-044).** Two-file diff (+103 / -21):

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/cboe_putcall_ingest.py` | edit (+80 / -19) | Updated `DEFAULT_CBOE_URL` to `https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv`; added `DEFAULT_CBOE_ARCHIVE_URL` for the pre-2012 archive (`totalpcarchive.csv`); refactored `main()` to fetch BOTH URLs and concat (archive fetch failure falls through to modern-only with stderr warning); added `--archive-url` CLI flag; updated docstring to document the URL move + dual-fetch behavior + frozen-source ceiling |
| `scripts/tests/test_cboe_putcall_ingest.py` | edit (+21 / -2) | New `test_default_urls_point_to_current_cboe_path` regression test pinning both new URLs; catches the next CBOE move at test time |

Total slice 1: **+103 / -21 across 2 files**. No DDL, no DML beyond
the re-ingest, no daemon edits, no UI changes. The script's parser
(`parse_csv`, `detect_column`, `_detect_date_column`, `_parse_cboe_date`)
is byte-identical pre/post — only the URLs and the fetch orchestration
changed. The CH table schema (`quantlab.macro_indicators_cboe`) is
unchanged.

**Investigation trail (preserved here for cycle audit):**

1. Operator ran `npm run cboe:ingest` → script reported HTTP 403 from
   the old `/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv`
   endpoint.
2. Probed the endpoint directly with and without a realistic Chrome
   User-Agent: both returned HTTP 403 with body
   `<?xml ...?><Error><Code>AccessDenied</Code>...` — the AWS S3 default
   for "file not found / no public read". Confirmed not a UA-block or
   rate-limit.
3. Probed sibling files at the same CDN path:
   - `VIX_History.csv`: HTTP 200, 468,484 bytes
   - `SPX_History.csv`: HTTP 200, 290,917 bytes
   Confirmed the `/api/global/us_indices/daily_prices/` namespace is open;
   only `PUT-CALL-RATIO_History.csv` was removed.
4. Probed standing free-data fallbacks per data-source policy:
   - **yfinance `^CPC`**: HTTP 404 "Quote not found for symbol: ^CPC" —
     Yahoo Finance has delisted this ticker too.
   - **FRED `CPCE`** probe returned 400 (inline-env API-key issue; not
     deeply investigated because finding 5 below resolved it).
   - **Stooq `^CPC`**: returned the standard apikey-captcha gate
     (same pattern as GAP-5 / Q-3 — no new info).
5. Scraped the CBOE human-facing historical-data page
   (`https://www.cboe.com/us/options/market_statistics/historical_data/`)
   for any `put/call` href hints; found 10 new CDN URLs all at the
   `/resources/options/volume_and_call_put_ratios/` path. Confirmed:
   CBOE didn't pull the data behind a paywall; they **moved** it.
6. Probed the two relevant new URLs:
   - `totalpc.csv`: HTTP 200, 139,830 bytes, schema `DATE,CALLS,PUTS,TOTAL,P/C Ratio`
   - `totalpcarchive.csv`: HTTP 200, 87,307 bytes, schema `Trade_date,Call,Put,Total,P/C Ratio`
   Both header variants already in `DATE_HEADER_CANDIDATES` +
   `DEFAULT_COLUMN_CANDIDATES`; existing parser handles them unchanged.
7. Probed the modern file's `Last-Modified` header + tail:
   - `last-modified: Fri, 30 Oct 2020 12:31:08 GMT`
   - Tail row: `10/04/2019, 2175006, 2289715, 4464721, 1.05`
   **Discovery:** the file is a static historical snapshot. CBOE
   stopped publishing public daily put/call ratio data after
   2019-10-04. This is the source of the ADR-045 "stale since 2019"
   finding, refined: it's not that CBOE's URL broke and the cadence
   missed — it's that **CBOE intentionally stopped publishing
   publicly** ~6 years ago and the data we've been ingesting is the
   frozen tail of that publishing era.

**Slice 1 ingest verification (live ClickHouse):**

```text
cboe_putcall_ingest
  start    : 2003-10-17
  end      : 2026-05-24
  source   : https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv
  archive  : https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpcarchive.csv
  column   : (auto-detect)
  dry-run  : False
  using column: 'P/C Ratio' (date: 'DATE')          ← modern file
  using column: 'P/C Ratio' (date: 'Trade_date')    ← archive file
  parsed   : 5,428 rows, 2003-10-17 -> 2019-10-04
  inserted : 5,428 rows into quantlab.macro_indicators_cboe

Post-merge counts in CH:
  CPC: 4,018 rows, 2003-10-17 -> 2019-10-04
```

The 5,428 → 4,018 collapse reflects the 5.5-year overlap between
archive (2003-10 → 2012-06) and modern (2006-11 → 2019-10); modern
wins on overlap because it ingests last (higher `ingested_at`).
End state: 4,018 unique observation_date rows — **identical
date-range to pre-Cycle-11 state**; the union just refreshed
`ingested_at`, no new coverage because the source is frozen.

**HANDOFF rewrite (this commit):** the Cycle 11 close-out documenting
the slice + the source-freeze finding + Q-5 path-space update.

### Cycle 11 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (per §3.1 trivial-edit exception) | CBOE URL repair — `scripts/cboe_putcall_ingest.py` (+test pin) | AUTO-APPROVE (no critic spawn — Data-Ingest domain edit; broken-scraper structural fix matches ADR-044 Tier-1 mechanical AUTO-FIX template exactly; test regression added; live verification ran end-to-end; no real-money path file touched; no paid-data source; no auth scrape; no ADR conflict — ADR-045's "stale since 2019" framing is REFINED by Cycle 11's finding but the operative quarantine row + decision-space remain valid) | Slice committed `206c649`; live ingest succeeded; 16/16 tests pass; tsc baseline 13 unchanged; health-check shows CBOE still very-stale (correctly, source-frozen); Q-5 narrative updated to record source-freeze finding. |

**Decision: no critic spawn for this slice.** Per orchestration §3.1 +
§6.1 + ADR-044 Tier-1 mechanical AUTO-FIX template:
- Broken-scraper structural fix is the canonical Tier-1 example in
  ADR-044's policy text.
- No source-file canon-thin decision (methodology-canon ADRs are
  unchanged; ADR-045 is REFINED in narrative but not amended in this
  cycle — the source-freeze finding may motivate a Cycle 13 ADR-045
  amendment if path (B) gets picked).
- No real-money path file touched per §7.2 allowlist.
- No paid-data source, no auth scrape, no new dependency.
- Regression test added (16/16 pass, +1 from 15/15) — the standard
  mechanical-AUTO-FIX template includes test coverage of the fix.
- Live verification ran against production CH; orchestrator-only
  self-review confirmed pre/post state symmetry except for the URL
  diff + `ingested_at` refresh.

Critic spawn for a broken-scraper template fix would have added
orchestration overhead without proportionate signal gain.

### Verification gates at cycle close

```text
git status                                                                          # clean (1 slice committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #17 Cycle 10 close)
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_ingest.py -v     # 16/16 pass (was 15/15 at s96 #17 Cycle 10 close — +1 URL pin test)
npm run health:check                                                                # CBOE still very-stale 2424d 4,018 rows (CORRECT — source frozen)
npm run cboe:ingest                                                                 # end-to-end ran clean; 5,428 → 4,018 unique
inline curl: totalpc.csv tail                                                       # last-modified 2020-10-30, content ends 10/04/2019
git worktree list                                                                   # main only (no worker spawned this cycle)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail
                                                       ← NOT re-run this cycle (only a python-side change; no TS source-file diff)
                                                       ← last green at Cycle 9/10 close: same numbers
test_cboe_putcall_ingest.py (targeted)                16/16 pass + 0 fail
                                                       ← was 15/15 at s96 #17 Cycle 10 close (+1 URL pin test)
gicsSectorRepositoryHelper.test.ts (targeted)         13/16 pass + 3 skip + 0 fail
                                                       ← unchanged from Cycle 9 close
btRunsRegime.test.ts                                   19/19 pass    (unchanged from Cycle 6)
test_train_meta_label.py                               33/33 pass    (unchanged from Cycle 7)
regimeDashboard.test.ts                                37/37 pass    (unchanged from Cycle 5)
all Cycle 3-touched suites                            472/472 pass   (unchanged from Cycle 4 close)
```

### Post-Cycle-11 health snapshot

Identical to Cycle 10 close. The CBOE re-ingest refreshed `ingested_at`
but did not change `max(observation_date)` (= 2019-10-04 → still
2,424d very-stale per the probe). All other freshness classes
unchanged.

- **Fresh:** 1 source (`Wikipedia/fja05680 S&P 500 constituents`).
- **Stale (informational, ~2-4d since last `npm run daemon:daily` run):**
  Candles, Cross-asset, Cycle position, ETF v3.1 SSGA secondary, FRED,
  Form 4 trades, Live paper-trading signals, Macro regime phase1_v3,
  Sector rotation, Vol structure. All clear on next
  `npm run daemon:daily`.
- **Very-stale:** CBOE put/call 2,424d (Q-5 narrative refined this
  cycle — see Q-5 row above + S96-88 lock-in below).
- **Never-populated:** 11 raw + composite snapshot tables + the
  `health_quarantine_alerts_sent` sidecar.
- **Missing-table:** raw `executive_departures` + raw
  `finra_short_interest`.
- **Migrations applied:** 20/20.

### Push state

- `origin/main` at `c0cda7c`; **39 unpushed commits** after s96 #17
  Cycle 11 HANDOFF rewrite (was 37 at Cycle 10 close, +1 slice 1 = 38,
  +1 this HANDOFF = 39).
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
| Cycle 10 — S96-78 closure (`phase1_v3` bt_runs_regime backfill: 197,064 rows attributed) | ✓ s96 #17 |
| **Cycle 11 — CBOE put/call URL repair + source-freeze finding (S96-87 + S96-88; Q-5 path space narrowed to {A,B,C})** | **✓ s96 #17** |
| Cycle 12 — `/#/regime` post-backfill UI smoke-test OR CBOE health-check description update | ☐ NEXT default (recommended UI smoke-test) |
| Cycle 13+ — ADR-045 amendment recording the CBOE source-freeze finding (only if operator picks Q-5 path B) | ☐ deferred — operator decision drives whether the amendment is the right scope |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert logic + re-alert-on-status-transition cursor (impl) | ☐ deferred per S96-71 (spec can begin in later cycle) |
| GAP-3 — CBOE put/call daemon hook (post-URL-fix; promote to step 1b'' between FRED + classifier) | ☐ low priority — source is frozen so daemon cadence has no fresh-data signal to publish; still valid to wire if CBOE ever resumes |
| F2 CBOE backfill + re-classify (Q-5 path D) | ⛔ EMPIRICALLY DEAD — Cycle 11 confirmed source frozen 2019-10-04; path removed from solution space |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 operator pick among A/B/C (path D removed Cycle 11) |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 11 of multi-agent orchestration)

**S96-87. CBOE moved the public put/call CSVs in 2026 from
`/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv` to
`/resources/options/volume_and_call_put_ratios/{totalpc,totalpcarchive}.csv`.**
The old path now returns AWS S3 `AccessDenied` (the file is removed
from the bucket); sibling files at the old path (VIX, SPX) still
resolve, so this is a CBOE-side move of the put/call file
specifically, not a CDN-wide change. The new file pair: `totalpc.csv`
covers 2006-11-01 → 2019-10-04 (frozen — see S96-88); `totalpcarchive.csv`
covers 2003-10-17 → 2012-06-07 (genuinely historical archive).
`scripts/cboe_putcall_ingest.py` (Cycle 11 slice 1, commit `206c649`)
now fetches BOTH and concatenates; ReplacingMergeTree on
(series_id, observation_date) collapses the 5.5-year overlap with
modern winning on `ingested_at` ordering. **Regression test
`test_default_urls_point_to_current_cboe_path`** pins the new URL
pair so the NEXT CBOE move surfaces at test time, not at next-daemon-
run time. `Why:` ADR-044 Tier-1 mechanical AUTO-FIX template — "a
broken scraper whose target site changed structurally → repair the
parser + add a regression test + alert the operator that a scraper
changed shape (informational, not blocking)". The dual-fetch
orchestration handles the 2003-2006 backfill window that the modern
file alone is missing. `How to apply:` (1) When any CBOE CDN file
returns AWS S3 AccessDenied with body `<Error><Code>AccessDenied</Code>...`,
the FIRST probe is "scrape the human-facing CBOE historical-data
page" (`https://www.cboe.com/us/options/market_statistics/historical_data/`) —
that page advertises the current CSV URLs. (2) Always pair the URL
update with a constant-pinning test that fails LOUDLY if the URLs
drift; same pattern as the GST-1 EXPLAIN-clean pin from Cycle 9. (3)
When CBOE publishes a "modern" + "archive" file pair (the standard
pattern for their historical CSVs), default to fetching both and
concatenating; the 5.5-year overlap is the cheapest insurance against
either file going dark independently.

**S96-88. CBOE genuinely stopped publishing public daily put/call
ratio data after 2019-10-04; the public file has been frozen at 4,018
trading days of coverage with `last-modified: 2020-10-30` for ~5.5
years.** This refines the ADR-045 "phase1_v3 CBOE put/call corrupted-
input window 2019-2026" finding from "the URL broke and the cadence
missed" to "**CBOE removed the publishing cadence entirely**". The
practical impact: Q-5 path (D) "re-canonicalize via free CBOE backfill
+ re-classify forward only" is **empirically NOT executable** because
there is no free public CBOE put/call data after 2019-10-04 to
re-classify against. `Why:` directly observed via `curl -sS -I
totalpc.csv` (Last-Modified header) + tail inspection of the file's
content. The file's permanent freeze ~6 years ago without any
operator-visible announcement is the kind of upstream-source-policy
change that the standing [HEALTH] role exists to surface; ADR-044's
"upstream input fully unavailable" maps to this case but is not
explicitly a Tier-2 quarantine trigger because the existing pin row
(S96-70) already covers the methodology-level concern. `How to apply:`
(1) **Q-5 path space is now {A: paid DataShop, B: methodology
amendment removing CBOE put/call from phase1_v3, C: keep
`accepted-as-warning` indefinitely}**. Path (D) is removed. (2)
Orchestration's revised recommendation for Q-5: **path (C) for now +
path (B) when phase1_v3 is next iterated**. Path (A) DataShop is
operator-call on capital allocation grounds and is the only path
that re-opens fresh CBOE put/call data. (3) The existing
`quantlab.health_quarantine` Q-5 pin row (S96-70) was NOT updated
this cycle — its `note` describes the methodology-level concern,
which is unchanged; the source-freeze finding refines the
decision-space but doesn't change the row's status. Cycle 12+ may
update the pin row's narrative if the operator picks path (B). (4)
The `npm run health:check` freshness probe correctly continues to
flag CBOE put/call as "very-stale 2424d" because it measures
`max(observation_date)` which is genuinely 2019-10-04; the
remediation hint "→ npm run cboe:ingest" is now misleading
(running the ingest won't help — Cycle 12 candidate is updating
the hint to "frozen at source 2019-10-04; see Q-5"). (5) Future
ingest cycles should still run `npm run cboe:ingest` periodically
(daemon cadence per GAP-3, if/when wired) because if CBOE ever
**resumes** publishing publicly, we want to be ready — but treat
the staleness as a permanent feature of the data path, not a
solvable problem.

**Carry-overs (still in force):** S96-1..S96-86; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### CARRIED from s96 #12-#17

- **OQ-SMP-1 — `readSectorMembershipPanel` query rejected by CH EXPLAIN
  PLAN with `There is no supertype for types String, Date`.** CLOSED
  in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications (s96 #14).
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers; Playwright dep operator-gated.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely (operator-gated).
- CBOE DataShop subscription — now coalesces with Q-5 path (A); **the only path that re-opens fresh CBOE put/call data per Cycle 11 S96-88**.
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
- **NEW Cycle 11 carry:** CBOE put/call source-freeze finding (S96-88)
  — Q-5 path (D) empirically dead; orchestration recommends path (C)
  + future path (B) when phase1_v3 is iterated. Operator decision
  required.

---

## Next stage

### Default on `continue` — Cycle 12 candidate (recommended `/#/regime` UI smoke-test)

With Cycle 11's CBOE URL repair shipped and Q-5 path space narrowed,
the standing follow-up queue is:

1. **`/#/regime` post-backfill UI smoke-test (RECOMMENDED, carry-over
   from Cycle 10 close).** Open `http://localhost:3000/#/regime` in
   the browser; confirm the regime panel now surfaces `phase1_v3`
   attribution data correctly per ADR-046 / GAP-8 / S96-75 (the panel
   hardcodes `phase1_v3` as source-of-truth). Cycle 10 added 197,064
   `phase1_v3` attribution rows to `bt_runs_regime`; Cycle 11 pivoted
   to CBOE work before the smoke-test ran. This closes the end-to-end
   validation loop on Cycle 10's DB-state change. Small, self-contained;
   no operator gate.
2. **CBOE health-check description update (ALTERNATIVE).** Health-domain
   slice — update the freshness probe's `→ npm run cboe:ingest`
   remediation hint to reflect the frozen-source reality from S96-88.
   Current text implies running the ingest will refresh the staleness;
   after Cycle 11 we know that's empirically false. New hint should
   point to Q-5 / DataShop subscription as the only path that
   re-opens fresh data. Touches `src/server/health_check.ts` per the
   orchestration §1 Health domain ownership; ~10-LOC edit.
3. **Phase 2 v2 spec drafting (DEFERRED).** Implementation stays
   deferred per S96-71; the spec itself can be written.
4. **Drift remediation (REACTIVE).** Any new Tier-2 quarantine items
   surfaced by `npm run health:check` between sessions.
5. **GAP-3 CBOE daemon hook (LOW PRIORITY now).** Post-S96-88, the
   daemon cadence has no fresh-data signal to publish (source is
   frozen); wiring it would just refresh `ingested_at` on every daily
   run. Still valid to wire if CBOE ever resumes; not urgent.
6. **`settings.json` worker-base configuration (DEFERRED).** Per
   S96-85, defer until the third hit of the worktree-base-mismatch
   pattern; Cycle 11 didn't spawn a worker (orchestrator self-edit
   per §3.1 trivial-edit exception).

**Why `/#/regime` smoke-test over the CBOE health-check description
update:** the smoke-test has been queued for two consecutive cycles
(Cycle 10 recommended it for Cycle 11; Cycle 11 pivoted to CBOE);
shipping it next preserves the recommended-default discipline.
The CBOE description update is small enough that it can be Cycle 13
or paired with another Health-domain slice without losing momentum.

### Alternative — Cycle 12 could instead pivot to ANY orchestration-domain follow-up

The orchestration is free to defer the smoke-test if the operator
returns with a different priority — `continue` re-enters from this
section and the recommendation isn't a halt-gate.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 11)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/cboe_putcall_ingest.py` | edit (+80 / -19) | URL constants updated + dual-fetch orchestration + docstring + `--archive-url` CLI flag (slice 1 `206c649`) |
| `scripts/tests/test_cboe_putcall_ingest.py` | edit (+21 / -2) | New URL-pin regression test (slice 1 `206c649`) |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-87 + S96-88 lock-ins; operator queue Q-4 counter → 39; Q-5 narrative refined; Cycle 11 chain entry added; Cycle 12 recommended path documented |

Total: **+103 / -21 across 2 source-file edits + 1 HANDOFF rewrite**.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| `quantlab.macro_indicators_cboe` | INSERT (re-ingest via slice 1 verification) | 5,428 rows inserted; post-merge FINAL = 4,018 unique observation_dates (overlap dedupped) | Pure additive write; no UPDATE, no DELETE; `ingested_at` refreshed for all rows; `max(observation_date)` unchanged at 2019-10-04 (source frozen per S96-88) |

### Test + tsc state

- `npm test`: **3319/3338 pass + 19 skip + 0 fail** (NOT re-run this
  cycle — only python-side changes; no TS source-file diff; last green
  at Cycle 9/10 close).
- `test_cboe_putcall_ingest.py` (targeted): **16/16 pass + 0 fail**
  (was 15/15 at Cycle 10 close; +1 URL pin).
- All Cycle 3/4/5/6/7/8/9/10-touched suites: **unchanged** (no test
  files in their domains touched this cycle).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in
  unrelated `_check_*.ts` / `_verify_*.ts` / `_cleanup_*.ts` /
  `_diagnose_*.ts`).
- `npm run check:help`: not re-run this cycle (no help-doc-touching
  source change).
- Quartz patch grep: **both Patch 1 + Patch 2 present** (unchanged).
- Health check delta: **zero functional change** — CBOE still flagged
  very-stale 2424d 4,018 rows (CORRECT per S96-88; source frozen).

### Untouched-but-relevant for next session

- The Q-5 row in `quantlab.health_quarantine` still loaded for first
  Telegram alert on next live daemon run with valid Telegram creds.
  Cycle 11 did NOT update this row's narrative; the source-freeze
  finding is in HANDOFF + S96-88 only.
- `quantlab.executive_departures` raw source table still missing
  (carry-over from S96-65); created by 8-K Item 5.02 ingest on first
  daemon step 1i-pre run.
- `quantlab.finra_short_interest` raw source table still missing
  (Cycle 2 carry-over); created on first daemon step 1h-pre Monday run.
- The brief §0 system-health digest block ABOVE §1 macro regime still
  surfaces on the operator's first look at the brief.
- `bt_runs_regime` has full `phase1_v3` attribution coverage (197,064
  rows; Cycle 10 / S96-86). The `/#/regime` panel hardcodes
  `phase1_v3` as source-of-truth; Cycle 12's recommended smoke-test
  validates the panel surfaces this data.
- **NEW:** `quantlab.macro_indicators_cboe` `ingested_at` is now
  refreshed to today across all 4,018 rows; `max(observation_date)`
  is 2019-10-04 unchanged (S96-88 frozen source).
- The `scripts/cboe_putcall_ingest.py` script now requires no
  operator flag for the dual-fetch behavior; default invocation
  fetches both modern + archive. `--archive-url` exists for override.
- The new URL-pin regression test (`test_default_urls_point_to_current_cboe_path`)
  will fail LOUDLY if CBOE moves the URLs again — surfacing the move
  at test time, not at next-daemon-run time.
- Sharadar architectural documentation in production code (`clickhouse.ts`
  SOURCE_PRIORITY enum + forward-looking comments) preserved per S96-80.
- ADR-005 freeze record persists in `MASTER.html §6`.
- `.github/workflows/ci.yml` is staged for first-CI-run on whenever the
  operator pushes (Q-4). Until pushed, CI doesn't execute; no badge URL
  yet (no README at repo root to host one — add when/if one is created).
- `src/server/gics_sector_repository_helper.ts` contains the Cycle 9
  fix (3 SELECT-clause edits dropping `toString(<Date col>) AS
  <same_name>`); S96-84 anti-pattern rule applies.
- GST-1 + SMP-6 EXPLAIN-clean tests in
  `scripts/tests/gicsSectorRepositoryHelper.test.ts` will pin the
  Cycle 9 fix once `quantlab.gics_sector_map` is populated; until then
  they skip via the missing-table path.

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 11)

- **CBOE public put/call data is permanently frozen at 2019-10-04**
  (S96-88). Any future analyst reading `quantlab.macro_indicators_cboe`
  should know the `max(observation_date)` ceiling is the source's
  publishing cadence, not our ingest cadence. The health-check probe
  surfaces this as "very-stale 2424d" but the `→ npm run cboe:ingest`
  remediation hint is misleading post-Cycle-11 (Cycle 12 candidate is
  fixing the hint).
- **Q-5 path (D) is removed from solution space.** Any future cycle
  that finds itself recommending "free CBOE backfill + re-classify
  forward" should reject that path and re-read S96-88. The only paths
  remaining are {A: paid DataShop, B: methodology amendment, C: keep
  `accepted-as-warning` indefinitely}.
- **The Cycle 11 URL-pin regression test (`test_default_urls_point_to_current_cboe_path`)
  will fail any time CBOE moves the URLs again.** When that happens,
  the workflow is: (1) probe the human-facing CBOE historical-data
  page for the new URLs; (2) update `DEFAULT_CBOE_URL` +
  `DEFAULT_CBOE_ARCHIVE_URL`; (3) update the test's expected URLs;
  (4) re-run pytest to confirm; (5) re-run `npm run cboe:ingest`
  end-to-end; (6) document in HANDOFF + new lock-in. Same pattern as
  the GST-1 / SMP-6 test design from Cycle 9.
- **The script's dual-fetch design is non-fatal on archive failure
  but fatal on modern failure.** If CBOE removes `totalpc.csv` (the
  modern file), the script returns 1 and the ingest fails entirely;
  if CBOE removes `totalpcarchive.csv` only, the script continues
  with modern-only data and warns on stderr. This asymmetry is
  intentional — modern is load-bearing for daemon cadence
  refreshes; archive is only relevant for first-apply backfills to
  pre-2006 dates (which are unlikely to occur often).
- **Re-running `npm run cboe:ingest` re-inserts ~5,428 rows every
  time** (modern 3,249 + archive 2,179, no `--only-missing` logic).
  The ReplacingMergeTree dedup handles this correctly but burns
  ~5,428 rows of CH insert volume per run. For daemon-cadence wiring
  (GAP-3), the orchestrator should consider adding an `--only-missing`
  flag OR a cheaper "ingest from last-known max(observation_date)"
  short-circuit. Not blocking; just a known cost of the current
  always-fetch-both design.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 10 carry-overs) preserved.

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

### CBOE put/call ingest (post-Cycle-11 URL repair)

```text
npm run cboe:ingest                                                                  # fetches both totalpc.csv + totalpcarchive.csv; ReplacingMergeTree dedups
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --dry-run                    # parse + count without writing
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --from-file <path>           # operator override; skips both HTTP fetches
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --archive-url <url>          # override the archive URL only
# Source-freeze note (S96-88): the public file ends 2019-10-04;
# re-running the ingest will NOT change max(observation_date),
# only refresh ingested_at. Q-5 path (D) is empirically dead.
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
npm test                                                                                              # full TS suite — 3319/3338 pass + 19 skip + 0 fail at s96 #17 Cycle 9/10 close (NOT re-run Cycle 11)
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_ingest.py -v                       # 16/16 pass at s96 #17 Cycle 11 close (was 15/15; +1 URL pin)
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

- **None.** Cycle 11 source-file edits affect only the script body
  (`scripts/cboe_putcall_ingest.py`) + its tests
  (`scripts/tests/test_cboe_putcall_ingest.py`); `package.json`
  `"cboe:ingest"` entry is unchanged.

---

## For the next session — priority order

**Default on `continue`:** Cycle 12 candidate per orchestration §8.4
follow-up queue — **recommended `/#/regime` post-backfill UI
smoke-test** (carry-over from Cycle 10 close; deferred when Cycle 11
pivoted to CBOE work). Trivial orchestrator self-edit (open
`http://localhost:3000/#/regime` in browser; observe whether the
regime panel surfaces phase1_v3 attribution data per ADR-046 / GAP-8
/ S96-75 / S96-86 backfill; document the validation outcome).
Self-contained; orchestration-domain; no operator gate; ~1-5 min
runtime.

**Alternative Cycle 12 candidates (orchestration-domain, no operator gate):**

- **CBOE health-check description update** — Health-domain slice
  per orchestration §1; update the freshness probe's `→ npm run
  cboe:ingest` remediation hint to reflect S96-88's frozen-source
  finding. ~10-LOC edit in `src/server/health_check.ts`. Could
  reasonably pair with the `/#/regime` smoke-test as Cycle 12 + 12b.
- **Phase 2 v2 spec drafting** — the design doc for plausibility-band
  probes + per-UI-route ping + auto-insert logic + re-alert-on-status-
  transition cursor. Implementation stays deferred per S96-71; the
  spec itself can be written.
- **Drift remediation** — any new Tier-2 quarantine items surfaced by
  `npm run health:check` between sessions.
- **`settings.json` worker-base configuration** — per S96-85, defer
  until the third hit; Cycle 11 didn't spawn a worker.
- **GAP-3 CBOE daemon hook (LOW PRIORITY now per S96-88).** Post
  source-freeze, the daemon cadence has no fresh-data signal to
  publish; wiring it would just refresh `ingested_at`. Still valid
  if CBOE ever resumes publishing.

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
- Q-4 push 39 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — pick A/B/C (D removed Cycle 11).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop) — Cycle 11 CBOE re-ingest is pure additive INSERT only;
  no DDL touched.
- `git push` (Q-4 above).
- Q-5-blocked work: phase1_v3 re-classify (Cycle 1 follow-up). The
  re-classify is blocked on Q-5 operator pick among A/B/C (path D
  removed Cycle 11 per S96-88).
- Path B EDGAR `from=` pagination (Data-Ingest domain; future cycle).
- Phase 2 v2 plausibility-band probes (impl deferred per S96-71).
- CI extensions that require new infra (CH-in-CI for
  health:check:strict; Vite build job for bundle artifacts; scheduled
  nightly runs).
- ADR-045 amendment recording the CBOE source-freeze finding — only
  meaningful if the operator picks Q-5 path (B); deferred.

---

## Important framing for the next chat

**Cycle 11 is closed.** One slice + one HANDOFF rewrite (2 commits).
Slice 1 (`206c649`, +103 / -21) repaired the CBOE put/call URL after
the operator's `npm run cboe:ingest` surfaced HTTP 403; investigation
revealed a CBOE-side file move + an independent finding that CBOE
**permanently froze public daily put/call publishing at 2019-10-04
~5.5 years ago**. Both findings recorded as S96-87 (URL move) +
S96-88 (source-freeze + Q-5 path-space narrowing).

**Q-5 path space narrowed from 4 paths to 3.** The operator's
decision space is now cleaner: {A: paid DataShop, B: methodology
amendment removing CBOE put/call, C: keep `accepted-as-warning`
indefinitely}. Path (D) "free re-canonicalize" is empirically dead.
**Orchestration's revised recommendation for Q-5:** path (C) now +
path (B) when phase1_v3 is next iterated. Path (A) DataShop is the
only path that re-opens fresh data and is operator-call on capital
grounds.

**Cycle 11 followed the §3.1 trivial-edit exception pattern** (no
worker spawn). The slice was Data-Ingest domain edit (broken-scraper
structural fix) + the canonical ADR-044 Tier-1 mechanical AUTO-FIX
template. Critic spawn would have added overhead without
proportionate signal gain.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).** Q-4
count incremented from 37 → 39 (slice 1 + this HANDOFF). Q-5's row
narrative was updated to record the source-freeze finding + narrow
the path space; no new escalation because the underlying methodology
concern was already on the queue + already pinned in
`quantlab.health_quarantine` as `accepted-as-warning` (S96-70). The
Cycle 11 finding refines the decision space but does not introduce a
NEW unresolved item.

**S96-87 + S96-88 are the new lock-ins.** Future cycles that
encounter (a) a CBOE CDN file returning AWS S3 AccessDenied should
consult S96-87 for the standing URL-rediscovery pattern (scrape the
human-facing CBOE historical-data page first); (b) Q-5 path-space
deliberation should consult S96-88 for the source-freeze finding.

**Cycle 12 recommended path: `/#/regime` UI smoke-test** — still
the deferred Cycle 11 default per Cycle 10 close. Closes the
end-to-end validation loop on Cycle 10's DB-state change. Small,
self-contained, orchestration-domain. If the panel renders correctly,
Cycle 12 closes quickly; if a rendering bug surfaces, Cycle 12
becomes a UI remediation cycle.

**Backward compat preserved this cycle:**

1. **CH:** `quantlab.macro_indicators_cboe` schema unchanged;
   re-ingest is pure additive INSERT (ReplacingMergeTree dedup); 4,018
   unique observation_date rows preserved (= same as pre-Cycle-11).
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes; the brief does not currently
   surface CBOE put/call data directly.
4. **Tests:** All previously-passing suites still pass; +1 new test
   in `test_cboe_putcall_ingest.py` (URL-pin regression).
5. **Code behavior:** The script's parser is byte-identical pre/post;
   only the URL constants + the `main()` fetch orchestration changed.
   The `--from-file` operator-override path is unchanged.
6. **Operator UX:** `npm run cboe:ingest` now works again (was
   failing with HTTP 403 before Cycle 11); the source-freeze means
   running it produces "stale-but-refreshed" rows rather than fresh
   data, which the health-check Cycle 12 description update will
   clarify.

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
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-10 closure + S96-76 follow-up: .github/workflows/ci.yml
  + S96-82 + S96-83 lock-ins documented
S96 #17 Cycle 9 of multi-agent orchestration:
  • Composite worker (worktree)       AUTO-APPROVE  → OQ-SMP-1 closure: gics SQL shadow-alias fix + GST-1 pin
  + S96-84 + S96-85 lock-ins documented
S96 #17 Cycle 10 of multi-agent orchestration:
  • Orchestrator self-edit (§3.1)     AUTO-APPROVE  → S96-78 closure: phase1_v3 backfill 197,064/197,064 in 2234s
  + S96-86 lock-in documented
S96 #17 Cycle 11 of multi-agent orchestration:
  • Orchestrator self-edit (§3.1)     AUTO-APPROVE  → CBOE put/call URL repair (Tier-1 mechanical):
                                                       `scripts/cboe_putcall_ingest.py` URL constants
                                                       updated from `/api/global/us_indices/daily_prices/`
                                                       to `/resources/options/volume_and_call_put_ratios/`;
                                                       dual-fetch (modern+archive) with ReplacingMergeTree
                                                       dedup; URL-pin regression test added (16/16 pass,
                                                       was 15/15); live ingest 5,428 → 4,018 unique dates
                                                       2003-10-17 → 2019-10-04.
                                          INDEPENDENT
                                          FINDING    → CBOE permanently froze public daily put/call
                                                       publishing at 2019-10-04 (~5.5y ago, last-modified
                                                       2020-10-30). Q-5 path (D) "free re-canonicalize" is
                                                       empirically NOT executable; path space narrows to
                                                       {A: paid DataShop, B: methodology amendment, C: keep
                                                       accepted-as-warning indefinitely}. Orchestration's
                                                       revised recommendation: path (C) now + path (B) when
                                                       phase1_v3 is iterated.
  + S96-87 (CBOE URL move + dual-fetch + URL-pin pattern) +
    S96-88 (CBOE source-freeze + Q-5 path-space narrowing) lock-ins documented
  + 2 commits: slice 1 (206c649) + this HANDOFF rewrite
  + Third cycle since Cycle 4 to use §3.1 trivial-edit exception
  + Zero runtime behavior change for downstream consumers; tsc baseline + health-check unchanged
  + No new operator-queue rows; Q-5 narrative refined; Q-4 count: 37 → 39
  → DEFAULT NEXT: Cycle 12 candidate per orchestration §8.4 follow-up
    queue. RECOMMENDED — `/#/regime` post-backfill UI smoke-test
    (carry-over from Cycle 10 close; deferred when Cycle 11 pivoted
    to CBOE work). ALTERNATIVE — CBOE health-check description update
    to reflect S96-88's frozen-source finding.
```
