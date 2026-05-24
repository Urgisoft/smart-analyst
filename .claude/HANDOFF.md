# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 13 of multi-agent
orchestration executed**. Operator pivoted from the recommended Cycle 13
default (`/#/regime` UI smoke-test) with the directive **"find free
reliable source for ETF flow"**. Cycle 13 slice 1 (commit `0a62105`)
delivered a partial path-B execution toward Q-6: expanded the SSGA
navhist adapter from 13/21 → 15/21 F-UNIVERSE coverage by adding JNK +
GLD (both have parseable XLSX on SSGA's CDN; HANDOFF + adapter comment
misidentified them as non-SSGA). Two parser bugs surfaced + fixed
in-passing — Tier-1 mechanical per ADR-044: (1) R2.B ticker anchor now
strips trailing ®/™/© before compare so GLD's `'GLD®'` cell value no
longer rejects the entire file; (2) UTF-8 stdout reconfigure on both
the adapter's `main()` AND the chained `etf_flow_issuer_csv_ingest.py`
`main()` so the `→` in per-ticker / per-file summary doesn't crash
under PowerShell's default cp1252 codec on interactive runs. **Live
ingest verified end-to-end:** `npm run etf:flow:ssga-spdr:refresh`
returned **15/15 tickers OK, 3,756 rows**; CH probe of
`quantlab.etf_shares_outstanding_secondary` shows **15 distinct
tickers** (was 13; +1,012 rows from JNK + GLD). **Universe drop-cost
shrinks from 9 → 6:** the remaining 6 F-UNIVERSE tickers needing
alternative sources are IVV + IWM + HYG + TLT (iShares), VOO
(Vanguard), QQQ (Invesco). **Q-6 stays accepted-as-warning** — the v1
primary panel (`etf_shares_outstanding`, yfinance-fed) is still empty;
only the v3.1 SECONDARY panel benefits from this slice. **Net 43
unpushed commits** on top of `origin/main` (`c0cda7c`) after this
HANDOFF rewrite (was 41 at Cycle 12 close · +1 slice 1 = 42 · +1
HANDOFF = 43). **Pre-merge gate locally verified:** `npx tsc --noEmit`
returns 13 baseline errors unchanged; `npm test` 3319/3338 pass + 19
skip + 0 fail; pytest ETF-flow suites 61/61 pass (+1 new regression
pin for the trademark anchor). **Q-6 row** in `health_quarantine`
status unchanged (`accepted-as-warning`); resolution math improved
(only 6 tickers blocking path-B amendment, not 9). **NEXT default on
`continue`:** Cycle 14 candidate per Q-6 path-B follow-on —
**recommended iShares adapter** covering IVV + IWM + HYG + TLT (4 of
the remaining 6 tickers; biggest marginal value). Alternative:
`/#/regime` post-backfill UI smoke-test (now four cycles deferred).

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
| Q-4 | Push 43 unpushed commits to origin/main (Cycle 13 slice 1 + this HANDOFF is the 43rd) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. Path (A) DataShop is the only path that re-opens fresh CBOE put/call data. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. Yahoo broke `Ticker.get_shares_full` for ETFs (~2026); yfinance 1.4.0 doesn't fix it. **Path-B cost shrunk Cycle 13** — universe drop is now **6 tickers**, not 9: IVV + IWM + HYG + TLT (iShares), VOO (Vanguard), QQQ (Invesco). Path space: **(A) paid Sharadar/Polygon ETF SHO subscription — only path that restores fresh ETF SHO data; (B) methodology amendment promoting v3.1 secondary to primary + dropping the 6 non-SSGA tickers from F-UNIVERSE, draft ADR-048; (B') per-issuer adapter chain — build iShares (covers 4) + Vanguard (covers 1) + Invesco (covers 1) free adapters mirroring the SSGA navhist pattern; (C) keep `accepted-as-warning` indefinitely**. Orchestration's recommendation: **path (B') now (Cycle 14 = iShares); fall back to (B) + ADR-048 if (B') adapters prove fragile**. Path (D) "Yahoo restores the endpoint" remains monitored by the daemon step 1jb anomaly. | s96 #17 Cycle 12 (S96-89 + S96-90); Cycle 13 slice 1 (S96-91 + S96-92) | OPEN — operator picks among (A)/(B)/(B')/(C) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. Cycle 13 added no new operator-queue rows. Q-4 count
incremented from 41 → 43. Q-6 unchanged in status; path-space refined
with new (B') sub-option + cost math updated.

---

## What this cycle delivered (s96 #17 Cycle 13)

### One code slice + HANDOFF rewrite (2 commits)

**Slice 1 (`0a62105`) — SSGA adapter expansion to JNK + GLD + parser
hygiene fixes (Tier-1 mechanical per ADR-044).** Three-file diff
(+62 / -9):

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/etf_flow_ssga_spdr_adapter.py` | edit (+30 / -6) | (1) DEFAULT_TICKERS: 13 → 15 (add JNK + GLD); comment block rewritten to enumerate SSGA-served vs out-of-scope tickers; (2) R2.B ticker anchor normalization strips trailing ®/™/© chars before compare (unblocks GLD whose XLSX writes `'GLD®'`); (3) `main()` reconfigures stdout + stderr to UTF-8 so `→` in summary doesn't crash under cp1252. |
| `scripts/etf_flow_issuer_csv_ingest.py` | edit (+9) | Same UTF-8 stdout reconfigure in `main()`. The chained CSV-to-CH ingester would have crashed on the same `→` in its per-file summary. |
| `scripts/tests/test_etf_flow_ssga_spdr_adapter.py` | edit (+23 / -3) | Renamed `test_default_tickers_has_13_spdr_universe` → `test_default_tickers_has_15_ssga_served_universe`; updated pin tuple. NEW `test_parse_navhist_xlsx_accepts_trademark_glyph_in_r2_ticker` regression pin so future anchor refactors don't silently re-reject GLD. |

Total slice 1: **+62 / -9 across 3 files** (no new files). No DDL
change. No real-money path file touched. No paid-data subscription.
No authenticated scrape. All free-data per policy. No new npm scripts.

**Investigation trail (preserved for cycle audit):**

1. Operator screenshot in chat showed `/#/etf-flow` rendering the
   Cycle 12 EmptyState — "PRIMARY PANEL EMPTY — YFINANCE ETF SHO
   ENDPOINT REGRESSION" with the three Q-6 resolution paths.
2. Operator pivoted from recommended Cycle 13 default (`/#/regime`
   smoke-test) with directive: "find free reliable source for ETF
   flow". Path-B / path-B' research authorized by directive.
3. Surveyed existing SSGA adapter coverage —
   `scripts/etf_flow_ssga_spdr_adapter.py:103-107`: 13-ticker tuple
   `(SPY, DIA, XLK..XLC)`. Adapter comment at `:99-102` explicitly
   listed HYG/JNK/TLT/GLD as "NOT SSGA-managed" + IVV/VOO/QQQ/IWM
   as other-issuer.
4. Probed SSGA CDN for the 8 listed-as-not-SSGA tickers via direct
   `curl` of the navhist URL template: JNK + GLD returned **HTTP
   200** with valid XLSX bodies (225KB + 260KB); HYG/TLT/IVV/VOO/QQQ/
   IWM all returned **HTTP 404**. Adapter comment was empirically
   wrong on JNK + GLD.
5. Dry-ran SSGA adapter against `--tickers JNK,GLD`:
   - JNK: parsed cleanly (63 rows in 90-day lookback window),
     footer-row WARNs informational.
   - GLD: rejected with `R2.B ticker anchor mismatch (expected 'GLD',
     got 'GLD®')`. Trademark symbol on title row.
6. Surveyed iShares fund-data endpoint (via research subagent —
   `report under 350 words`): the holdings ajax endpoint at
   `https://www.ishares.com/us/products/{productID}/...ajax?fileType=
   csv&fileName={TICKER}_holdings&asOfDate=YYYYMMDD` exposes a scalar
   `Shares Outstanding` per date in the CSV metadata header.
   Reconstructable as a timeseries by looping `asOfDate` (~80 fetches
   for a 90-day backfill of 4 tickers; ~1k for a multi-year). No
   captcha / no Playwright. Product IDs are public + stable
   (IVV=`239726`, IWM=`239710`, HYG=`239565`, TLT=`239454`).
7. SEC EDGAR N-PORT survey: monthly cadence + 60-day public release
   lag; NOT a daily semantic replacement for the v1 primary panel.
   Deferred as audit-grade cross-check, not primary source.
8. Decided slice 1 scope: SSGA expansion (JNK + GLD) + the two parser
   bugs surfaced during the GLD probe. iShares adapter is the natural
   Cycle 14; building it now would push slice 1 to ~400 LOC +
   substantially different architecture (asOfDate loop vs single-
   XLSX-download).
9. Applied 3 edits + 1 test (rename existing + add new). Re-ran SSGA
   refresh end-to-end. Verified CH state via existing
   `src/server/clickhouse.js`-based one-shot probe (cleaned up post-
   verification, not committed).

**Live verification log:**

```text
$ npm run etf:flow:ssga-spdr:refresh                # post-slice-1
  SPY: 250 rows | range 2025-05-23 → 2026-05-21
  DIA: 250 rows | range 2025-05-23 → 2026-05-21
  XLK-XLC: 250 rows each | 11 sector SPDRs
  JNK: 250 rows | range 2025-05-23 → 2026-05-21    # NEW
  GLD: 256 rows | range 2025-05-23 → 2026-05-22    # NEW
[etf-flow-ssga-spdr] Done: 15/15 tickers OK | 3,756 rows written
  ssga-spdr.csv: 3756 rows | range 2025-05-23 → 2026-05-22 | tickers 15
[etf-flow-issuer-csv] Done: 1/1 files OK | 3,756 rows inserted

# CH state probe (cleaned-up one-shot script):
total_rows=10762
distinct_tickers=15
  DIA: 750  GLD: 512  JNK: 500  SPY: 750  XL*: 750 × 11
```

### Cycle 13 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (per §3.1 trivial-edit exception — SIXTH stretch since Cycle 4) | SSGA adapter expansion + 2 Tier-1 parser fixes + test pin | AUTO-APPROVE (no critic spawn — Tier-1 mechanical AUTO-FIX template per ADR-044: broken-scraper structural change + unicode-codec hygiene; expanded existing ticker list within established adapter pattern; new test pins the change; tsc baseline 13 unchanged; npm test baseline preserved; live verification end-to-end; no real-money path file touched; no paid-data; no auth scrape) | Slice committed `0a62105`; SSGA coverage 13/21 → 15/21; Q-6 path-B amendment cost shrunk from 9 → 6 tickers. |

**Decision: no critic spawn for this slice.** Per orchestration §3.1 +
§6.1 + ADR-044 Tier-1 mechanical AUTO-FIX template:
- Expansion of DEFAULT_TICKERS within an established adapter pattern;
  empirically verified by HTTP probe + dry-run BEFORE landing.
- Trademark-anchor strip is a defensible normalization (ticker-with-™
  vs without == same ticker for anchor purposes); pinned by new test.
- UTF-8 stdout reconfigure is a Python-stdlib idiomatic fix for the
  Windows cp1252 default; identical pattern applied to both scripts.
- All tests pass; tsc baseline unchanged.
- No methodology-canon decision (the underlying amendment is Q-6,
  deferred to operator).
- No real-money path file touched per §7.2.
- No paid-data, no auth scrape, no new dependency.

**The §3.1 trivial-edit exception is now on its SIXTH stretch since
Cycle 4** (Cycle 9 was Composite worker spawn; Cycles 4/5/6/7/8/10/11/
12/13 were orchestrator self-edits). S96-92 documents this; rule
amendment now overdue.

### Verification gates at cycle close

```text
git status                                           # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                            # 43 commits ahead (was 41)
npx tsc --noEmit                                     # 13 baseline errors unchanged
npm test                                             # 3319/3338 pass + 19 skip + 0 fail
.venv/Scripts/python.exe -m pytest \
  scripts/tests/test_etf_flow_ssga_spdr_adapter.py \
  scripts/tests/test_etf_flow_issuer_csv_ingest.py \
  scripts/tests/test_etf_flow_ingest.py             # 61/61 pass (+1 new pin)
npm run etf:flow:ssga-spdr:refresh                   # 15/15 tickers, 3,756 rows
# CH probe (one-shot, not committed):
#   total_rows=10762, distinct_tickers=15, JNK=500, GLD=512 freshly populated
git worktree list                                    # main only (no worker spawned)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail
test_etf_flow_ssga_spdr_adapter.py (targeted)         18/18 pass (was 17; +1 new pin)
test_etf_flow_issuer_csv_ingest.py (targeted)         19/19 pass (unchanged)
test_etf_flow_ingest.py (targeted)                    24/24 pass (unchanged)
test_cboe_putcall_ingest.py (targeted)                16/16 pass (Cycle 11 baseline)
etfFlow / etfFlowCrossValidation / etfFlowRepository /
daemonEtfFlowV1PrimaryRefresh                         146/146 pass
migrateCreateHealthQuarantine / healthQuarantine       57/57 pass
gicsSectorRepositoryHelper.test.ts                    13/16 pass + 3 skip (Cycle 9)
btRunsRegime.test.ts                                  19/19 pass (Cycle 6)
test_train_meta_label.py                              33/33 pass (Cycle 7)
regimeDashboard.test.ts                               37/37 pass (Cycle 5)
all Cycle 3-touched suites                            472/472 pass (Cycle 4)
```

### Post-Cycle-13 health snapshot

Cycle 13 did NOT change the Q-6 row in `quantlab.health_quarantine`
(status remains `accepted-as-warning`; Q-5 + Q-6 = 2 rows total). The
v1 primary panel state is unchanged — `etf_shares_outstanding` still
0 rows; the secondary panel `etf_shares_outstanding_secondary` grew
from 13 to 15 distinct tickers.

- **Fresh:** 1 source (Wikipedia/fja05680 S&P 500 constituents).
- **Stale (informational, ~3-5d since last `npm run daemon:daily`):**
  Candles, Cross-asset, Cycle position, ETF v3.1 SSGA secondary (NOW
  15-ticker), FRED, Form 4 trades, Live paper-trading signals, Macro
  regime phase1_v3, Sector rotation, Vol structure.
- **Very-stale:** CBOE put/call 2,425d (Q-5; source frozen 2019-10-04).
- **Never-populated:** 11 raw + composite snapshot tables INCLUDING
  `etf_shares_outstanding` (Q-6 — Yahoo regression; no Cycle 13 change).
- **Missing-table:** raw `executive_departures` + raw `finra_short_interest`.
- **Quarantine queue:** `tier2AcceptedAsWarningCount: 2` (Q-5 + Q-6).

### Push state

- `origin/main` at `c0cda7c`; **43 unpushed commits** after this
  HANDOFF rewrite (was 41 at Cycle 12 close · +1 slice 1 = 42 · +1
  HANDOFF = 43).
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Reconciliation audit baseline | ✓ s96 #12 (review form answered by orchestration s96 #14) |
| `/#/health` Phase 1 read-only UI | ✓ s96 #12 |
| GAP-11 / GAP-12 etf-flow guard + NaN formatter | ✓ s96 #12 |
| Phase 1 column-name auto-fix | ✓ s96 #13 |
| Convention regression anchors | ✓ s96 #13 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1 — F1 + F2(escalated) + F3 + GAP-14/15/18 + ADR-045 | ✓ s96 #15 |
| Cycle 2 — GAP-2 + GAP-1 + GAP-4 + GAP-7(a) | ✓ s96 #16 |
| Cycle 3 — Phase 2 v1 ADR-044 infrastructure | ✓ s96 #17 |
| Cycle 4 — GAP-8 classifier-source documentation (ADR-046) | ✓ s96 #17 |
| Cycle 5 — GAP-13 + GAP-19 Quartz vendor-fork upgrade procedure | ✓ s96 #17 |
| Cycle 6 — GAP-16 sentinel investigation closure (ADR-047) | ✓ s96 #17 |
| Cycle 7 — GAP-17 orphan-script cleanup | ✓ s96 #17 |
| Cycle 8 — GAP-10 CI/CD baseline | ✓ s96 #17 |
| Cycle 9 — OQ-SMP-1 closure (gics SQL shadow-alias fix + GST-1 pin) | ✓ s96 #17 |
| Cycle 10 — S96-78 closure (phase1_v3 bt_runs_regime backfill 197,064 rows) | ✓ s96 #17 |
| Cycle 11 — CBOE put/call URL repair + source-freeze finding | ✓ s96 #17 |
| Cycle 12 — yfinance ETF SHO regression diagnosis (S96-89 + S96-90; Q-6 added) | ✓ s96 #17 |
| **Cycle 13 — SSGA navhist expansion +JNK +GLD (S96-91 + S96-92; Q-6 path-B cost shrunk 9→6)** | **✓ s96 #17** |
| Cycle 14 — iShares adapter (IVV+IWM+HYG+TLT; Q-6 path-B' sub-1) | ☐ NEXT default (recommended) |
| Cycle 15 — Vanguard adapter (VOO; Q-6 path-B' sub-2) | ☐ deferred — only meaningful after Cycle 14 lands cleanly |
| Cycle 16 — Invesco adapter (QQQ; Q-6 path-B' sub-3) | ☐ deferred — only meaningful after Cycles 14+15 |
| `/#/regime` post-backfill UI smoke-test | ☐ FOUR-CYCLE DEFERRED carry-over (Cycle 10/11/12/13) |
| CBOE + ETF freshness-probe description updates | ☐ deferred pair-up candidate (~20-LOC `src/server/health_check.ts`) |
| Cycle 14+ ADR-048 for Q-6 (only if path B' adapters prove fragile) | ☐ contingent on Cycle 14 outcome |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ⛔ low priority — source frozen per S96-88 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ⛔ EMPIRICALLY DEAD — Cycle 11 |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 pick |
| Composite worker (Cycle 12 follow-up etf-flow methodology amendment) | ⏸ blocked on Q-6 pick |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ➡ MERGED into Q-6 path-B' (Cycles 14+15+16) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 13 of multi-agent orchestration)

**S96-91. SSGA's navhist CDN serves XLSX for SPDR-branded JNK + Gold
Trust GLD; HANDOFF + adapter comment misidentified them as
non-SSGA-managed.** The error was inherited from the original v3.1
SSGA adapter SPEC at s96 #7 (which listed only SPY + DIA + 11 sector
XL* funds). JNK is the SPDR Bloomberg High Yield Bond ETF (SSGA-
managed); GLD is the SPDR Gold Trust (technically World Gold Trust;
SSGA is the marketing agent; SSGA's navhist CDN endpoint
`navhist-us-en-gld.xlsx` returns HTTP 200 with a parseable XLSX
body). The XLSX schemas differ slightly — GLD's R2.B writes `'GLD®'`
(trademark glyph) while equity SPDRs write the bare ticker — but the
data rows R5+ are structurally identical (4 cols: Date / NAV / Shares
Outstanding / Total Net Assets). Cycle 13 slice 1 (`0a62105`) adds
both to `DEFAULT_TICKERS` after empirical HTTP probe + dry-run
verification, lifting SSGA coverage from 13/21 → 15/21 of F-UNIVERSE.
`Why:` data-source policy §"do NOT halt on 'needs data' without first
researching free + scrape alternatives"; operator directive "find free
reliable source for ETF flow"; ADR-044 Tier-1 mechanical AUTO-FIX
template for broken-scraper / wrong-comment fixes. `How to apply:`
(1) When evaluating an adapter's coverage exclusions documented in
comments, **verify them empirically** (HTTP probe + dry-run); comments
written months/cycles ago can be wrong. The original SPEC was a
v3.1-arc snapshot; the CDN has since expanded what it serves.
(2) When a SSGA-family product is listed in F-UNIVERSE but not in the
adapter, the FIRST probe is a curl against the navhist URL template
with the lowercase ticker — the URL is stable; a 200 with XLSX body
+ R2.B passing the (now trademark-stripped) anchor is sufficient proof
of compatibility. (3) The 6 remaining non-SSGA F-UNIVERSE tickers are
genuinely served by other issuers — iShares (IVV/IWM/HYG/TLT),
Vanguard (VOO), Invesco (QQQ) — and require per-issuer adapters
(Q-6 path B' Cycles 14+15+16). (4) JNK and GLD's data rows are
backward-compatible with the existing two-stage ingest pipeline (CSV
emission + `etf_flow_issuer_csv_ingest.py` → `etf_shares_outstanding_
secondary`), no schema changes needed.

**S96-92. The R2.B ticker anchor in the SSGA parser must normalize
trailing ®/™/© glyphs before compare; UTF-8 stdout reconfigure is
required on every Python script under PowerShell on Windows when the
script's stdout contains any non-ASCII char.** GLD's XLSX writes
`'GLD®'` in R2.B; the byte-equal anchor `expected_upper ==
r2_ticker_raw.strip().upper()` rejected the entire file. The fix is
`r2_ticker_raw.strip().upper().rstrip("®™©").strip()`. Separately,
the per-ticker summary print `f"... → {max_date}"` crashed under
PowerShell's default cp1252 codec with `UnicodeEncodeError: 'charmap'
codec can't encode character '→'`; the same crash hit the
chained `etf_flow_issuer_csv_ingest.py` per-file summary. Fix is
`for stream in (sys.stdout, sys.stderr): try: stream.reconfigure(
encoding="utf-8") except (AttributeError, OSError): pass` at the top
of `main()`. The daemon runs under a UTF-8 shell, so this crash never
surfaced in scheduled runs — only interactive operator runs hit it.
`Why:` ADR-044 standing-health mandate: "operator never discovers
bugs by eye"; the trademark anchor + cp1252 codec issues would have
both bitten any operator who ran the SSGA refresh interactively on
Windows. Both are Tier-1 mechanical per the ADR-044 enumerated list
(broken-scraper structural change; mechanical encoding fix).
`How to apply:` (1) **Add the UTF-8 stdout reconfigure as standard
Python boilerplate** for any new script under `scripts/` that prints
non-ASCII chars; the try/except (AttributeError, OSError) makes it
safe for test capture (where streams are not reconfigurable). The
helper could be lifted to a shared module if a third script needs it.
(2) **Byte-equal anchors are correct for column-header drift but
WRONG for ticker-with-glyph-vs-without distinctions.** When a byte-
equal anchor rejects a file, the FIRST question is "does the actual
value differ by a known cosmetic transform (case, whitespace,
trademark)?". If yes, normalize that transform in the anchor compare,
NOT in the data row processing. (3) Pin the trademark normalization
behavior with a regression test so a future anchor refactor doesn't
silently re-reject GLD. Pattern: `_build_xlsx(ticker="GLD®")` +
`parse_navhist_xlsx(body, "GLD")` → `errors == []`. (4) Cycle 13's
trademark + UTF-8 fixes are PRE-EMPTIVE for any future per-issuer
adapter — iShares, Vanguard, Invesco adapters will likely face the
same Windows + glyph constraints when they're built.

**Carry-overs (still in force):** S96-1..S96-90; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### CARRIED from s96 #12-#17

- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers (NOW
  merged into Q-6 path-B' Cycle 14 candidate).
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers (NOW merged into Q-6
  path-B' Cycles 14-16 scope).

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused (operator-gated).
- CBOE DataShop subscription — Q-5 path (A).
- Capital-deployment-ramp ADR — Q-2.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent; remains Q-6 path-A
  candidate for ETF SHO if operator picks paid path.
- Phase 2 v2 — deferred per S96-71.
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence (Cycle 6).
- Orchestration §3.1 written rule no longer matches de-facto usage
  (S96-90 from Cycle 12); now SIXTH stretch (S96-92 reference); rule
  amendment now overdue.

---

## Next stage

### Default on `continue` — Cycle 14 candidate (recommended iShares adapter)

With Cycle 13's SSGA expansion landed + Q-6 path-B cost shrunk 9→6,
the standing follow-up queue is:

1. **iShares adapter (RECOMMENDED — Q-6 path-B' sub-1).** Build
   `scripts/etf_flow_ishares_adapter.py` mirroring the SSGA pattern:
   - Fetch the holdings ajax CSV at `https://www.ishares.com/us/
     products/{productID}/...ajax?fileType=csv&fileName={TICKER}_
     holdings&asOfDate=YYYYMMDD` for each business day in the
     lookback window (default 90).
   - Parse the scalar `Shares Outstanding` from the CSV metadata
     header (the file's first ~10 rows are key:value metadata; data
     rows are the holdings list).
   - Emit canonical CSV `{ticker, date, shares, close}` to
     `data/etf_flow_issuer_csv/ishares.csv` (close from yfinance or
     reuse from existing `daily_signal_daemon.ts` close-cache).
   - Hand off to existing `etf_flow_issuer_csv_ingest.py --source-
     label ishares --apply` for the CH insert (same two-stage pattern
     SSGA uses).
   - Tickers: IVV (productID `239726`), IWM (`239710`), HYG
     (`239565`), TLT (`239454`).
   - Cadence: ~80 HTTP fetches per 90-day backfill (~1 req/sec
     polite); ~4 fetches per daily refresh thereafter.
   - Schema validation per data-source policy: metadata-header
     ticker anchor + As-Of-Date parse + Shares-Outstanding-is-finite
     guard. Fail loudly on parse failure.
   - Tests: hermetic in-memory CSV fixtures (mirror SSGA test
     pattern); cover happy-path + missing-shares-field + bad-asOfDate
     + HTTP-404-per-day-then-skip.
   - Daemon step 1jc' (post-1jb, conditional on `NO_FETCH`): one
     daily call to refresh the latest business day for all 4 tickers.
   - Anti-prerequisite: do NOT add iShares tickers to F-UNIVERSE in
     `etf_flow_ingest.py`; the v1 primary panel stays yfinance-
     gated (Q-6 status unchanged).
2. **`/#/regime` post-backfill UI smoke-test (NOW FOUR-CYCLE
   DEFERRED).** Trivial 5-minute orchestrator-self-edit. Sits behind
   iShares only because operator's directive was "find free reliable
   source for ETF flow", which makes the iShares slice the direct
   continuation.
3. **CBOE + ETF freshness-probe description updates (PAIR-UP
   CANDIDATE).** ~20-LOC `src/server/health_check.ts` edit reflecting
   S96-88 (CBOE source frozen) + S96-89 (Yahoo ETF SHO endpoint dead).
4. **Phase 2 v2 spec drafting (DEFERRED).** Implementation stays
   deferred per S96-71.
5. **Drift remediation (REACTIVE).** Any new Tier-2 quarantine items.

**Why iShares leads:** operator directive "find free reliable source
for ETF flow" is only partially discharged by Cycle 13; iShares is 4
of the remaining 6 tickers (biggest marginal value).

### Alternative — Cycle 14 could pivot to ANY orchestration-domain follow-up

If operator wants to validate Cycle 13's SSGA expansion visually
first, or to address one of the deferred items above, `continue`
re-enters from this section and the iShares recommendation is not a
halt-gate.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 13)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/etf_flow_ssga_spdr_adapter.py` | edit (+30 / -6) | DEFAULT_TICKERS 13→15; R2.B trademark normalization; UTF-8 stdout (slice 1 `0a62105`) |
| `scripts/etf_flow_issuer_csv_ingest.py` | edit (+9) | UTF-8 stdout (slice 1 `0a62105`) |
| `scripts/tests/test_etf_flow_ssga_spdr_adapter.py` | edit (+23 / -3) | default-tickers pin renamed + updated; NEW trademark anchor test (slice 1 `0a62105`) |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+62 / -9 across 3 edits + 1 HANDOFF rewrite**. No new files,
no new npm scripts, no DDL changes.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| `quantlab.etf_shares_outstanding_secondary` | INSERT (JNK + GLD) | +1,012 rows (250+256 each × ReplacingMergeTree dedup-on-merge) | distinct_tickers: 13 → 15 |
| `quantlab.etf_shares_outstanding` | (no change — still 0 rows) | 0 rows | Yahoo regression per S96-89 unchanged |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-6 status remains `accepted-as-warning` |

### Test + tsc state

- `npm test`: **3319/3338 pass + 19 skip + 0 fail** (Cycle 12 baseline preserved).
- `test_etf_flow_ssga_spdr_adapter.py`: **18/18 pass** (was 17; +1
  new `test_parse_navhist_xlsx_accepts_trademark_glyph_in_r2_ticker`).
- `test_etf_flow_issuer_csv_ingest.py`: **19/19 pass** (unchanged).
- `test_etf_flow_ingest.py`: **24/24 pass** (unchanged).
- `test_cboe_putcall_ingest.py`: **16/16 pass** (Cycle 11 baseline).
- `npx tsc --noEmit`: **13 baseline errors unchanged**.
- Health check delta: `tier2AcceptedAsWarningCount` unchanged at 2;
  freshness probe for `etf_shares_outstanding_secondary` no longer
  flags JNK + GLD as missing.

### Untouched-but-relevant for next session

- Q-5 + Q-6 rows still loaded in `quantlab.health_quarantine` for
  first Telegram alerts on next live daemon run with valid creds.
- `quantlab.executive_departures` + `quantlab.finra_short_interest`
  raw source tables still missing (carry-overs).
- `bt_runs_regime` has full `phase1_v3` attribution coverage (Cycle 10).
- `quantlab.macro_indicators_cboe`: 4,018 rows, max=2019-10-04, source
  frozen per S96-88.
- `quantlab.etf_shares_outstanding`: 0 rows, source endpoint dead per
  S96-89 (unchanged from Cycle 12).
- `quantlab.etf_shares_outstanding_secondary`: now 15 distinct tickers
  (SSGA SPDR + JNK + GLD); covers 15 of 21 F-UNIVERSE.
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 13)

- **JNK + GLD's daemon-refresh cadence is now coupled to the existing
  SSGA refresh step.** They benefit from the same auto-refresh as the
  13 existing tickers (whatever cadence the daemon runs the SSGA
  refresh at). No new daemon step is needed; the existing one now
  pulls 15 tickers instead of 13.
- **GLD's XLSX is the only SSGA file with a trademark glyph in R2.B
  as of Cycle 13.** If SSGA starts trademarking SPY® or DIA® in the
  navhist XLSX in the future, the existing anchor strip handles them
  automatically. The regression test pins the behavior.
- **The trademark strip uses `rstrip("®™©")`** — multi-character
  strips work in Python (rstrip treats the arg as a char set), so
  `'GLD®®®'.rstrip("®™©") == 'GLD'`. Any combination of those three
  glyphs at the end gets stripped; non-trailing or other chars stay.
  Edge case: `'GLD®XYZ'.rstrip("®™©") == 'GLD®XYZ'` (no strip,
  intentional — only TRAILING glyphs are cosmetic).
- **The UTF-8 stdout reconfigure boilerplate is now in TWO scripts**
  (`etf_flow_ssga_spdr_adapter.py` + `etf_flow_issuer_csv_ingest.py`).
  If a third script needs it (likely: Cycle 14 iShares adapter), the
  pattern should be lifted to a shared helper module
  (`scripts/_stdio_utf8.py` or similar) to avoid copy-paste drift. For
  now, two copies is acceptable per the no-premature-abstraction rule
  in CLAUDE.md.
- **Cycle 13's verification used a one-shot probe script
  `scripts/_probe_etf_sho.ts` that was deleted before commit.** It
  was the underscore-prefixed convention used elsewhere in the repo
  for throw-away tooling. The probe queried CH for per-ticker counts
  via the existing `getClickHouse()` client. If the next cycle needs
  the same probe, recreate it (template: see commit message of `0a62105`
  for the exact query shape).
- **Path-B' (iShares + Vanguard + Invesco adapters) ≠ Path B
  (drop the 6 tickers from F-UNIVERSE).** They're alternatives, not
  steps. If Cycle 14 iShares adapter proves fragile (e.g., iShares
  changes the asOfDate query-param shape; rate-limits backfills),
  the fallback is path B + ADR-048 (drop iShares from F-UNIVERSE,
  publish ADR for the universe contraction). Don't blur the two in
  the Q-6 row update.
- **The HANDOFF's "9 non-SPDR" Q-6 quote is preserved in commit
  history but should be read as "6 non-SSGA" going forward.** S96-91
  documents the correction; future Q-6 references should use the
  6-ticker count.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 12 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green
npm run system-health:check            # Phase 2 v1 dispatcher
npm run system-health:check -- --json  # Phase 2 v1 JSON payload
# UI surface: http://localhost:3000/#/health
```

### Phase 2 v1 + Q-6 admin (orchestration-pre-applied locally)

```text
npm run migrate:create-health-quarantine                     # dry-run
npm run migrate:create-health-quarantine:apply               # apply + Q-5 pin (idempotent)
npm run migrate:create-health-quarantine-alerts-sent         # dry-run
npm run migrate:create-health-quarantine-alerts-sent:apply   # apply
npm run migrate:insert-q6-etf-sho-pin                        # Cycle 12 — dry-run
npm run migrate:insert-q6-etf-sho-pin:apply                  # apply Q-6 pin (idempotent)
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
npm run health:check
```

### ETF flow ingest (post-Cycle-13)

```text
# v1 primary panel (yfinance) — still dead per Q-6 / S96-89
npm run etf:flow:ingest                                    # APPLY — 0/21 OK + S96-89 diagnostic + exit 1
npm run etf:flow:ingest:dry                                # dry-run, same

# v3.1 SSGA secondary (15 tickers post-Cycle-13: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY — chains adapter + CSV ingest
# Drops: 6 non-SSGA F-UNIVERSE tickers (IVV/IWM/HYG/TLT iShares, VOO Vanguard, QQQ Invesco)
# Cycle 14 candidate: iShares adapter covers 4 of the remaining 6.
```

### CBOE put/call ingest (post-Cycle-11 URL repair)

```text
npm run cboe:ingest                                                                  # fetches both totalpc.csv + totalpcarchive.csv
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --dry-run                    # parse + count without writing
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --from-file <path>           # operator override
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --archive-url <url>          # override archive URL
# S96-88 note: public file ends 2019-10-04; re-running NOT changes max(observation_date).
```

### Quartz docs site + vendor upgrade

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080)
# Vendor upgrade: docs/processes/quartz-upgrade.md
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # S96-78 CLOSED Cycle 10
npm run backfill:bt-regime:dry
npx tsx scripts/_probe_gap16_sentinels.ts
npx tsx scripts/_probe_ch_btregime.ts
```

### CI (Cycle 8 baseline)

```text
npx tsc --noEmit                                                                    # baseline ≤13 errors
npm run check:help
grep -q "gitignore: false" quartz/quartz/util/glob.ts                               # Patch 1
grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts                                    # Patch 2
npm test
pytest scripts/tests
# Workflow: .github/workflows/ci.yml
# First CI run: whenever the operator pushes (Q-4)
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ssga_spdr_adapter.py -v                # 18/18 pass (+1 Cycle 13)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py -v                # 19/19 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ingest.py -v                           # 24/24 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_ingest.py -v                       # 16/16 pass
node --import tsx --test scripts/tests/etfFlow.test.ts scripts/tests/etfFlowCrossValidation.test.ts scripts/tests/etfFlowRepository.test.ts scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts
                                                                                                       # 146/146 pass
node --import tsx --test scripts/tests/migrateCreateHealthQuarantine.test.ts scripts/tests/healthQuarantine.test.ts
                                                                                                       # 57/57 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors
```

### npm scripts touched this cycle

- **No new npm scripts.** Cycle 13 expanded the existing
  `etf:flow:ssga-spdr:refresh` script's default-ticker scope from 13
  to 15; the script name + args are unchanged.

---

## For the next session — priority order

**Default on `continue`:** Cycle 14 candidate — **recommended iShares
adapter for IVV+IWM+HYG+TLT** (Q-6 path-B' sub-1; biggest marginal
value of the 3 remaining issuers). Substantial slice (~200-400 LOC,
new script + tests + daemon step). Pair-up candidate:
`/#/regime` UI smoke-test (now FOUR cycles deferred — Cycle
10/11/12/13). Alternative pair-up: CBOE + ETF freshness-probe
description updates per S96-88 + S96-89.

**Alternative Cycle 14 candidates:**

- **iShares adapter** — see above (recommended).
- **`/#/regime` UI smoke-test** — trivial; closes 4-cycle deferral.
- **Health-check description updates** — ~20-LOC edit.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

**Calendar-gated (unchanged):**

- All Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (Q-1 through Q-6):**

- Q-1 first real-capital deployment.
- Q-2 capital-deployment-ramp ADR.
- Q-3 Stooq apikey gate decision.
- Q-4 push 43 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — A/B/C.
- Q-6 ETF v1 yfinance methodology — A/B/B'/C.

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase B campaigns.
- Playwright dep adoption (iShares + Vanguard + Invesco are
  curl-able with browser UA; no Playwright needed for Q-6 path-B').
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-5-blocked work: phase1_v3 re-classify.
- Phase 2 v2 plausibility-band probes.
- ADR-048 draft for Q-6 — only meaningful if path-B' adapters prove
  fragile in Cycle 14+ and operator picks path B (universe drop).

---

## Important framing for the next chat

**Cycle 13 is closed.** One slice + one HANDOFF rewrite (2 commits).
Slice 1 (`0a62105`, +62 / -9, 3 files) expanded SSGA navhist coverage
from 13/21 → 15/21 F-UNIVERSE by adding JNK + GLD, and fixed two
parser hygiene bugs (trademark anchor; UTF-8 stdout) that the GLD
probe surfaced.

**Q-6 path-space refined.** New sub-option **path-B'** added: build
per-issuer adapters for iShares (4 tickers), Vanguard (1), Invesco
(1) — all curl-able with browser UA, no captcha, no Playwright. The
universe-drop alternative (path B) is now 6 tickers, not 9.
Orchestration recommendation: **path-B' Cycle 14 (iShares first);
fall back to path B + ADR-048 only if B' proves fragile**.

**Cycle 13 followed the §3.1 trivial-edit exception pattern (SIXTH
stretch since Cycle 4).** S96-92 documents the cumulative pattern;
the orchestration §3.1 written rule amendment is now overdue.

**The operator queue is now 6 rows (Q-1 through Q-6).** Q-4 count
incremented from 41 → 43. Q-5 unchanged. Q-6 status unchanged but
path-space refined.

**S96-91 + S96-92 are the new lock-ins.** Future cycles encountering
(a) a SSGA-family product not in the adapter should HTTP-probe the
navhist CDN before assuming it's not served (S96-91); (b) byte-equal
anchors rejecting files over cosmetic ticker-glyph differences
should normalize the glyph rather than reject (S96-92); (c) any new
Python script printing non-ASCII to stdout on Windows must
reconfigure to UTF-8 in `main()` (S96-92).

**Cycle 14 recommended path: iShares adapter** — substantial slice
that builds the asOfDate-loop pattern as the second issuer-adapter
template. Daemon step 1jc'.

**Backward compat preserved this cycle:**

1. **CH:** `etf_shares_outstanding_secondary` schema unchanged;
   pure additive INSERTs for JNK + GLD; existing 13 tickers
   unaffected. `health_quarantine` unchanged.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes; §0 system-health digest still
   surfaces the same Q-5 + Q-6 counts.
4. **Tests:** All previously-passing suites still pass; one renamed
   test (`test_default_tickers_has_15_...`) + one new test
   (`test_parse_navhist_xlsx_accepts_trademark_glyph_in_r2_ticker`).
5. **Code behavior:**
   - Adapter: existing 13 tickers still parse + emit identically;
     R2.B normalization preserves byte-equal compare for all
     non-trademarked tickers (rstrip is a no-op when no glyph
     present).
   - CSV ingest: same write path to `etf_shares_outstanding_secondary`;
     just more rows per refresh now.
   - UTF-8 stdout reconfigure is a no-op on streams that already are
     UTF-8 (daemon shell) and on streams that can't be reconfigured
     (test capture, redirect).
6. **Operator UX:**
   - `/#/etf-flow` empty-state still shows the Cycle 12 EmptyState
     (primary panel still 0 rows — Q-6 unchanged).
   - `/#/health` quarantine queue still shows 2 rows (Q-5 + Q-6).
   - `npm run etf:flow:ssga-spdr:refresh` now shows 15 tickers
     instead of 13; per-ticker summary lines now render correctly
     under PowerShell instead of crashing.
   - Daemon step that runs the SSGA refresh now ingests 1,012 more
     rows per refresh (JNK + GLD × ~250-256 rows each).

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3..12                                      ✓ as documented (S96-70..S96-90)
S96 #17 Cycle 13:
  • Orchestrator self-edit (§3.1)     AUTO-APPROVE  → SSGA adapter +JNK +GLD:
                                                       DEFAULT_TICKERS 13 → 15;
                                                       R2.B anchor strips ®/™/©;
                                                       UTF-8 stdout reconfigure on both
                                                       adapter + chained CSV-ingest scripts;
                                                       test pin updated + new trademark
                                                       regression test.
                                          INDEPENDENT
                                          FINDING    → SSGA's CDN actually serves JNK
                                                       (SPDR HYBond) + GLD (SPDR Gold
                                                       Trust) navhist XLSX; HANDOFF +
                                                       adapter comment misidentified them
                                                       as non-SSGA. Coverage 13/21 →
                                                       15/21; Q-6 path-B cost shrinks
                                                       from 9 → 6 tickers. New Q-6
                                                       path-B' sub-option: per-issuer
                                                       adapters for iShares (4) +
                                                       Vanguard (1) + Invesco (1).
  + S96-91 (JNK + GLD SSGA coverage + verify-empirically pattern) +
    S96-92 (trademark-anchor normalization + UTF-8 stdout on Windows) lock-ins
  + 2 commits: slice 1 (0a62105) + this HANDOFF rewrite
  + SIXTH cycle since Cycle 4 to use §3.1 trivial-edit exception
  + Zero downstream consumer behavior change; tsc + npm test baselines unchanged
  + NO new operator-queue rows added (Q-6 unchanged; Q-4 count: 41 → 43)
  → DEFAULT NEXT: Cycle 14 candidate per orchestration §8.4.
    RECOMMENDED — iShares adapter for IVV+IWM+HYG+TLT (Q-6 path-B' sub-1).
    ALTERNATIVE — `/#/regime` UI smoke-test (now FOUR-CYCLE deferred) or
    CBOE + ETF v1 health-check description updates.
```
