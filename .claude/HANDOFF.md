# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-28 (session 96 #26 — **Cycle 32 IN PROGRESS: FILTERED
`insider_trades` EDGAR Form 4 backfill running in the background to close
OQ-C31-1 (zero-inflated 2y baseline). FOUR slices committed: (1) a CH-`Date`
range-clamp bugfix that was crashing pre-2025 months at the bulk INSERT; (2)
bulk `cik_ticker_map` ingest from SEC `company_tickers.json` — 7,992 issuers,
closes OQ-C31-3 / S96-141-W2; (3) two reproducibility scripts wrapping the
Cycle 30/31 one-shot data fixes — closes OQ-C30-2 + OQ-C31-2; (4) an
SP500 issuer-CIK FILTER for the form4 ingest — closes OQ-C32-1 and FIXES the
EDGAR sustained-access throttling that made the original full-market backfill
produce silently-incomplete months. The backfill PIVOTED from full-market
(~70h, throttled, broken months) to SP500-filtered (~12-18h, complete months)
after the operator approved the pivot. 2024-01 + 2024-04 already landed
full-market (complete); the other 21 months are running filtered.** Net 103
unpushed commits on `origin/main` (`c0cda7c`) after this HANDOFF ships.
**NEXT on `continue`:** check the FILTERED backfill (`logs/c32_filtered_backfill.sh`
is resumable — re-run it; it skips months already ≥3000 rows), then run the
snapshot re-backfill + z-distribution re-probe + Cycle 32 close.

---

## ⚠️ ACTIVE BACKGROUND JOB — FILTERED `insider_trades` backfill (resume protocol)

**A FILTERED (SP500 issuer-CIK) EDGAR Form 4 backfill is in flight (~12-18h).**
It is the gating Cycle 32 work. The environment restarted twice this session,
so the next session MUST be able to resume it. The resumable driver is at
**`logs/c32_filtered_backfill.sh`** (in the repo dir → survives restart, unlike
the obsolete `/tmp` full-market driver).

**Why FILTERED (the pivot):** the original full-market backfill (~16-24K
filings/month body-fetched) triggered EDGAR's sustained-access throttle after
~3h: 503 storms + read-timeouts exhausted the 5-retry pack, **silently
skipping filings** → incomplete months (2024-02 wrote 876 of ~25K filings'
rows; 2024-03 wrote 0). `rc=0` masked it. The fix (slice 4 / OQ-C32-1): filter
the search results to the **533 SP500 issuer CIKs** (the composite's
load-bearing aggregate only reads SP500 PIT constituents) BEFORE the expensive
body-fetch → ~5x fewer requests (23,893 → 4,771 filings/month) → stays under
the throttle AND produces complete months. Operator approved the pivot.

**Why at all:** OQ-C31-1 — the form_4 composite's 2y baseline window
([asOf-730d, asOf]) was zero-inflated because `insider_trades` only had
2026-01-02+ data. 2y baseline is load-bearing (Lakonishok-Lee 2001, baked into
the `form_4_insider_v1` composite version) — NOT a knob to shrink.

**State:** Dec-2025 (22,626) + 2024-01 (24,516) + 2024-04 (18,970) already
landed FULL-MARKET (complete — they contain the SP500 subset, so the filtered
loop SKIPS them). The other 21 months (2024-02,03,05..12 + 2025-01..11) run
filtered (~7-9K rows each expected). Mixing full-market + filtered months is
fine: the composite joins to SP500 PIT constituents at read-time, so the
SP500 subset is present in every month either way.

**RESUME PROTOCOL (idempotent + resumable — just re-run the driver):**

1. Ensure ClickHouse is up (see "Restart recovery" below).
2. Rebuild the allowlist if `logs/sp500_issuer_ciks.txt` is gone (it's
   gitignored → may not survive a wipe):
   ```
   npx tsx scripts/_build_sp500_issuer_cik_allowlist.ts > logs/sp500_issuer_ciks.txt
   ```
3. Re-run the resumable driver — it SKIPS any month already ≥3000 rows and
   runs only the missing ones:
   ```
   bash logs/c32_filtered_backfill.sh
   ```
   (run in background; ~36min/month for the missing months). Progress in
   `logs/form4_filtered_c32_master.log`.
4. **VALIDATE COMPLETENESS, not just rc=0** (the throttle lesson): a complete
   filtered month has **~5K-12K rows**; a throttled/incomplete month has
   <2K. Probe per-month `accepted_at` counts (see Backfill reminders below).
   ReplacingMergeTree on `(issuer_cik, accession, transaction_id)` makes
   re-runs safe; each month is a single end-of-run INSERT (mid-kill = 0 rows).

**Watch-out:** if the FILTERED months ALSO show throttling (incomplete <2K),
the next lever is lowering `SEC_RATE_LIMIT_RPS` (currently 10, no margin) +
raising 503 backoff in `scripts/_sec_edgar_helpers.py`. Monitor the first few
filtered months before assuming it's clean.

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop

The machine restarted twice this session. ClickHouse runs in the
`quantlab-clickhouse` Docker container under Docker Desktop. On reboot:

1. Launch Docker Desktop: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
2. The `quantlab-clickhouse` container **auto-starts** with the engine
   (observed: `Up 1 second` ~5s after engine ready).
3. Verify CH responds on `127.0.0.1:8123` before any CH work:
   `SELECT 1` via clickhouse_connect.
4. THEN resume the backfill per the protocol above.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model change
ratified 2026-05-23 (s96 #14), every routine decision is the orchestration's.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + amount | orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-2 | Capital-deployment-ramp ADR sign-off | s96 #13 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription |
| Q-4 | Push 103 unpushed commits to origin/main (Cycle 21..32 + handoffs) | Carry-over; +5 this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI restart | s96 #17/18/20 + C24 | PARTIAL — closes on operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 C19; ADR-041 gap | **OPEN — operator picks Path** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — no PASS-ALL + PBO<0.2 yet |

**Q-4 count 98 → 103** (this session: slices 1-4 + interim HANDOFF; this
HANDOFF edit is uncommitted-then-committed). All other items unchanged.

---

## What this session delivered (s96 #26 Cycle 32, in progress)

### Slice 1 (commit `9c7d1e6`) — CH-`Date` range-clamp bugfix

**Root cause of an ~8h-wasted failure:** the first backfill attempt looped
2024-01 then 2024-02, each running ~3-5h of body-fetching and then **crashing
the entire bulk INSERT** with:
```
DataError: Unable to create Python array for source column `transaction_date`.
  ... trying to insert None values into a ClickHouse column that is not Nullable
```
The real cause was NOT None — a 2024-era Form 4 XML carried a `transactionDate`
out of CH-`Date`'s representable range ([1970-01-01, 2149-06-06]) (e.g. a
typo'd `0024-…` year). It parsed to a VALID Python date (passing the existing
`... or date(1970,1,1)` falsy-guard) but was unrepresentable as CH `Date`, so
clickhouse_connect's binary array writer failed the whole all-or-nothing batch
→ **zero rows written** for the month.

**Fix:** clamp out-of-range dates to the 1970-01-01 sentinel at BOTH (a) the
parser source (`parse_form4_xml`) and (b) the `write_insider_trades` INSERT
choke point (defense-in-depth so one bad row can never nuke a 25K-row batch).
Added `_CH_DATE_MIN`/`_CH_DATE_MAX` constants + a 3-case parametrized
regression test (year-typo, pre-1970, post-2149). **50 form4 tests pass.**

### Slice 2 (commit `5ce50d3`) — bulk `cik_ticker_map` ingest (closes OQ-C31-3 / S96-141-W2)

`quantlab.cik_ticker_map` was EMPTY (0 rows) → form_4 per-ticker rows resolved
`cik=""` + `inputs_available_per_ticker` was structurally 0. New script
`scripts/sec_edgar_company_tickers_ingest.py` bulk-loads the issuer-side
CIK→ticker map from the free, pre-authorized
`https://www.sec.gov/files/company_tickers.json` (**7,992 issuers**,
`source='sec_company_tickers_json'`). Idempotent ReplacingMergeTree; loud
schema-validation pins; 8 tests. Verified lookups: AAPL→0000320193,
MSFT→0000789019, NVDA→0001045810, JPM→0000019617. npm scripts
`edgar:company-tickers:ingest[:dry]`.

### Slice 3 (commit `706b295`) — wrap one-shot data fixes (closes OQ-C30-2 + OQ-C31-2)

The Cycle 30 sp500_constituents PIT backfill (S96-140) + the Cycle 31
gics_sector_map PIT-anchor (S96-141) were one-shot MANUAL ops → silent loss on
DB wipe. Two named idempotent wrappers:
- `scripts/_propagate_sp500_history_to_constituents.ts` — replays the
  cross-table `INSERT…SELECT` (sp500_history FINAL → sp500_constituents,
  source `fja05680`, weight 0.0).
- `scripts/_anchor_gics_sector_pit.ts` — replays the PIT-anchor insert at
  snapshot_date=1996-01-02 (`pit_anchor_synth_c31`) via the read-then-insert
  idiom (OQ-C31-4: self-INSERT no-ops in this CH build).
Both verified idempotent against current state; anchor `--apply` re-confirmed
FINAL distribution 503/503. tsc baseline 13 unchanged.

### Slice 4 (commit `a8df3b7`) — SP500 issuer-CIK filter (closes OQ-C32-1; fixes throttling)

Added `--issuer-cik-file` to `sec_edgar_form4_ingest.py` (`load_issuer_cik_allowlist`
+ `filter_filings_by_issuer_cik`, matched against `ciks_all` so the issuer CIK
is never missed); applied BEFORE body-fetch. New
`scripts/_build_sp500_issuer_cik_allowlist.ts` emits the union of SP500
constituent issuer CIKs (since 2023-06-01) via cik_ticker_map — **566 tickers
→ 533 CIKs**. Empirically cuts 23,893 → 4,771 filings/month (~5x). +5
filter/loader tests (**55 form4 tests total**). tsc baseline 13.

### Backfill (RUNNING — FILTERED, see top section)

Full-market loop STOPPED (was producing throttled/incomplete months). Pivoted
to the filtered resumable driver `logs/c32_filtered_backfill.sh`. Dec-2025 +
2024-01 + 2024-04 complete (full-market); 21 months running filtered (~12-18h).
NOT yet complete.

### Cycle 32 outcomes per orchestration §3.1

| Slice | Verdict | Outcome |
| --- | --- | --- |
| Slice 1 bugfix (1 file + test) | orchestrator-self-edit §3.1 (single-file Tier-1 mechanical) | shipped + 50 tests green |
| Slice 2 cik_ticker_map (new ingest + test) | orchestrator-self-edit §3.1 (Data-Ingest, free source, no DDL) | shipped + 8 tests + 7,992 rows |
| Slice 3 wrap scripts (2 new TS) | orchestrator-self-edit §3.1 (pure-data reproducibility, no DDL) | shipped + idempotency verified |
| Slice 1c backfill | data-ingest, in progress | ~70h running |

All passed §3.1 trivial-edit guards (no real-money path, no DDL, no paid-data,
tsc baseline preserved, no canon-cited methodology ratification).

### Verification gates

```text
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py            # 50 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_company_tickers_ingest.py  # 8 pass
npx tsc --noEmit                                                                            # 13 baseline unchanged
git log origin/main..HEAD                                                                   # 102 after this HANDOFF
```

---

## Decisions locked in

### Session 96 #26 (Cycle 32, in progress)

**S96-142. `quantlab.cik_ticker_map` is bulk-loaded from SEC
`company_tickers.json` (issuer-side CIK→ticker, 7,992 rows,
`source='sec_company_tickers_json'`), not lazily from the submissions-API.**
`Why:` the lazy submissions-API cache path almost never fired (Form 4 XML
carries the ticker inline), leaving the table empty and breaking
`inputs_available_per_ticker`. The bulk JSON endpoint is one request, free,
pre-authorized, and covers every SEC issuer. `How to apply:` re-run
`npm run edgar:company-tickers:ingest` after a DB wipe or to refresh; the
submissions-API path still opportunistically enriches `former_tickers`
(ReplacingMergeTree keeps the most-recent `resolved_at` per cik).

**S96-143. `insider_trades.transaction_date` is clamped to the CH-`Date`
representable range [1970-01-01, 2149-06-06] at ingest.** `Why:` EDGAR Form 4
XML can carry out-of-range dates (typos) that are valid Python dates but crash
the all-or-nothing bulk INSERT. `How to apply:` the clamp is at both the parser
and the writer choke point; any new EDGAR ingest writing a CH `Date`/`DateTime`
column should apply the same bounds guard.

**S96-144. Multi-month/multi-year EDGAR Form 4 backfills MUST filter to the
SP500 issuer-CIK allowlist before body-fetch (`--issuer-cik-file`).** `Why:`
full-market body-fetching (~16-24K filings/month) triggers EDGAR's
sustained-access throttle (503 storms) after ~3h, which silently skips filings
and produces incomplete months with a deceptive `rc=0`. The composite's
load-bearing aggregate only reads SP500 PIT constituents, so the filter loses
nothing the aggregate needs while cutting volume ~5x. `How to apply:` use
`logs/c32_filtered_backfill.sh` (resumable); regenerate the allowlist via
`_build_sp500_issuer_cik_allowlist.ts`. ALWAYS validate backfilled months by
ROW COUNT (complete filtered month ≈ 5K-12K rows), never by exit code.

**Carry-overs (still in force):** S96-1..S96-141 (incl. S96-141 gics PIT-anchor,
S96-140 sp500_constituents PIT depth, S96-135..S96-138 EDGAR resilience pack);
S95-1..S95-50; all prior s73-s94 lock-ins.

---

## Open questions

### CLOSED this session

- **OQ-C31-3** — CLOSED (slice 2): cik_ticker_map ingested (7,992 rows).
- **OQ-C30-2** — CLOSED (slice 3): sp500_history→constituents propagation
  wrapped in `_propagate_sp500_history_to_constituents.ts`.
- **OQ-C31-2** — CLOSED (slice 3): gics PIT-anchor wrapped in
  `_anchor_gics_sector_pit.ts`.

### STILL OPEN / IN PROGRESS

- **OQ-C31-1** (THE Cycle 32 blocker) — being resolved by the running 24-month
  backfill. Once `insider_trades` has 2024-01+ coverage, re-run the snapshot
  backfill and re-probe the z-distribution (expect quantile(0.95) < 3 if the
  baseline is no longer zero-inflated). Phase B SPEC for `form_4_insider_v1`
  unblocks only after this verifies.
- **OQ-C31-4** — `INSERT … SELECT FROM <self>` silently no-ops for
  gics_sector_map in this CH build (24.8.14.39). Workaround documented +
  encoded in `_anchor_gics_sector_pit.ts` (read-then-insert). Defer root-cause
  investigation.
- **OQ-C32-1** — CLOSED (slice 4): the SP500 issuer-CIK pre-filter is
  implemented (`--issuer-cik-file` + `_build_sp500_issuer_cik_allowlist.ts`)
  and is the active backfill path. NOT a future optimization anymore — it's
  REQUIRED (S96-144) because the full-market path triggers EDGAR throttling.
- **OQ-C32-2** (NEW) — the filter is SP500-only (533 CIKs). The composite's
  NON-load-bearing per-ticker path uses an equity-midcap watch universe that
  is NOT in the allowlist, so midcap-only insiders won't be backfilled. Fine
  for Phase B aggregate validation; revisit if the per-ticker path becomes
  load-bearing. Also: 33 of 566 SP500 tickers didn't resolve to a CIK
  (delisted / not in company_tickers.json) — a minor v1 coverage gap.
- **OQ-C29-1 / OQ-C29-2** — form4 batched-writes (S96-138) + migrate other 3
  EDGAR ingests to dated-split (S96-135 (4)). The 23-month backfill empirically
  tests whether single bulk INSERT/month holds at ~10-40K rows; if any month
  OOMs, S96-138 batching becomes in-scope.
- **OQ-C29-5** — watch-universe PIT leak; now relevant again since
  cik_ticker_map is populated (per-ticker path will produce non-empty cik).
  Re-evaluate at Phase B SPEC.
- **CARRIED:** OQ-C30-3 (fja05680 CSV refresh), OQ-C28-3, OQ-C27-1..3,
  OQ-C26-1..3, OQ-C25-1..2, OQ-C24-1..3, OQ-C23-2, OQ-C21-1..2, OQ-C20-1,
  OQ-C19-1, OQ-C18-1, OQ-C17-1 — unchanged.

---

## Next stage

### Default on `continue` — finish Cycle 32

1. **Check FILTERED backfill state** (master log
   `logs/form4_filtered_c32_master.log` + per-month `accepted_at` probe). If
   interrupted, re-run `bash logs/c32_filtered_backfill.sh` (resumable — skips
   months ≥3000 rows). VALIDATE by row count (complete ≈ 5K-12K/month), not
   rc=0 (S96-144).
2. **Snapshot re-backfill:** once `insider_trades` has 2024-01+ coverage,
   `npx tsx scripts/_backfill_form_4_insider_snapshots.ts --start 2026-01-01 --end 2026-05-25 --apply`
   (same window; the baseline DEPTH changed, not the snapshot dates).
3. **z-distribution re-probe:** verify `max_aggregate_z` quantile(0.95) < 3
   (Lakonishok-Lee baseline sanity). If still inflated → deeper analysis.
4. **Cycle 32 close:** HANDOFF rewrite; decide whether `form_4_insider_v1`
   Phase B SPEC ships next cycle or more data-coverage work is needed.

### Alternative parallel work (if backfill still running)

- Path 4 — migrate 8K-event / 8K-Item-5.02 / 13d-g ingests to the S96-135
  dated-split helper (OQ-C29-2). Code-only, no EDGAR fetch — safe alongside
  the backfill.
- GAP-7(a) tableExists guards across routes (UI).
- OQ-C19-1 inputs_missing UInt8 truncation.

---

## Files / code state

### New / modified this session (s96 #26 Cycle 32)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_form4_ingest.py` | edit | CH-Date clamp (parser + writer); +`_CH_DATE_MIN/MAX` |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | edit | +3-case date-clamp regression test (50 total) |
| `scripts/sec_edgar_company_tickers_ingest.py` | NEW | company_tickers.json → cik_ticker_map |
| `scripts/tests/test_sec_edgar_company_tickers_ingest.py` | NEW | 8 parser/pin tests |
| `scripts/_propagate_sp500_history_to_constituents.ts` | NEW | OQ-C30-2 reproducibility wrap |
| `scripts/_anchor_gics_sector_pit.ts` | NEW | OQ-C31-2 reproducibility wrap |
| `scripts/_build_sp500_issuer_cik_allowlist.ts` | NEW | slice 4 — emits 533 SP500 issuer CIKs |
| `scripts/sec_edgar_form4_ingest.py` | edit | slice 4 — `--issuer-cik-file` filter |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | edit | slice 4 — +5 filter tests (55 total) |
| `package.json` | edit | +`edgar:company-tickers:ingest[:dry]` |
| `logs/c32_filtered_backfill.sh` | NEW (gitignored) | resumable filtered backfill driver |
| `.claude/HANDOFF.md` | rewrite | this file |

No DDL. No real-money path. No paid-data. No authenticated scrape.

### DB-state changes this session

- `quantlab.cik_ticker_map`: **0 → 7,992 rows** (slice 2).
- `quantlab.insider_trades`: 146,168 → **168,794** (Dec-2025 month +22,626);
  GROWING as the 23-month backfill lands (target: ~2024-01..2025-11 filled,
  est. +500K-800K rows when complete).
- `quantlab.gics_sector_map`: 1,006 rows (anchor re-applied idempotently;
  distribution unchanged 503/503).

### Test + tsc state

- form4 ingest pytest: **50 pass** (was 47; +3 clamp test).
- company_tickers pytest: **8 pass** (new).
- `npx tsc --noEmit`: **13 baseline** unchanged.
- `healthCheck.test.ts`: 37/37 (unchanged; no health code touched).
- Full `npm test` NOT re-run this session (no composite/UI TS changes).

### Untouched-but-relevant

- Daemon hasn't run ~6d → most composites very-stale (health:check expected;
  NOT a regression — operator hasn't run `npm run daemon:daily`).
- Empty/missing tables: `short_interest` MISSING, `executive_departure`
  MISSING, `schedule_13d_g`/`eight_k_events` 0 rows, `etf_shares_outstanding`
  0 rows. `cik_ticker_map` NO LONGER empty (was S96-141-W2).
- Operator dev server still needs `npm run dev` restart for Cycle 20-26 UI.

---

## Watch-outs

### NEW this session (s96 #26 Cycle 32)

- **The 24-month backfill is mid-flight (~70h).** See the ACTIVE BACKGROUND
  JOB section at top — resume protocol is idempotent; re-probe + relaunch
  missing months. The `/tmp` driver is ephemeral; do not rely on it.
- **CH-`Date` range is [1970-01-01, 2149-06-06]** (16-bit). Any EDGAR ingest
  writing a `Date` column must clamp out-of-range values or a single bad
  filing crashes the whole bulk INSERT (S96-143). DateTime range is
  1970-2106 — accepted_at is always recent, not at risk.
- **Backfill per-month single bulk INSERT** (~10-40K rows): empirically OK so
  far (Dec-2025 = 22,626 in one INSERT). If a high-volume month OOMs, the
  S96-138 batched-write fix becomes in-scope (OQ-C29-1).
- **Restart recovery:** CH is in Docker Desktop (`quantlab-clickhouse`,
  auto-starts with engine). See the Restart-recovery section.

### Carried

All prior watch-outs (s96 #1-#25 incl. S96-141 gics PIT-anchor requirement,
S96-140-W sp500_constituents PIT gap-window, S96-135..S96-140 EDGAR resilience
pack) preserved. Note: the gics-anchor + sp500-propagation manual-reproduction
hazards are now MITIGATED by the slice-3 wrapper scripts.

---

## Pre-loaded operational reminders

### Backfill / resume (Cycle 32)

```text
# Probe per-month coverage (which months are done):
.venv/Scripts/python.exe -c "import clickhouse_connect; c=clickhouse_connect.get_client(host='127.0.0.1',port=8123,username='quantlab',password='quantlab',database='quantlab'); [print(m,n) for m,n in c.query(\"SELECT toStartOfMonth(accepted_at) m,count() FROM quantlab.insider_trades WHERE accepted_at>='2024-01-01' AND accepted_at<'2025-12-01' GROUP BY m ORDER BY m\").result_rows]"

# Re-run one month (example):
.venv/Scripts/python.exe -u scripts/sec_edgar_form4_ingest.py --start-date 2024-03-01 --end-date 2024-04-01 --apply > logs/form4_apply_c32_2024-03.log 2>&1

# Snapshot re-backfill (after coverage lands):
npx tsx scripts/_backfill_form_4_insider_snapshots.ts --start 2026-01-01 --end 2026-05-25 --apply
```

### Cycle 32 reproducibility scripts (new)

```text
npx tsx scripts/_propagate_sp500_history_to_constituents.ts [--apply]   # OQ-C30-2 wrap
npx tsx scripts/_anchor_gics_sector_pit.ts [--apply]                    # OQ-C31-2 wrap
npm run edgar:company-tickers:ingest[:dry]                              # cik_ticker_map
```

### Standing health + daily

```text
npm run health:check          # every session start per ADR-044
npm run daemon:daily          # refresh stale composites (6d stale now)
npm run brief:morning
npx tsc --noEmit              # 13 baseline
```

### Tests

```text
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py            # 50 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_company_tickers_ingest.py  # 8 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                  # 37/37
```

---

## For the next session — priority order

**Default on `continue` — finish Cycle 32:**

1. Check FILTERED backfill; re-run `bash logs/c32_filtered_backfill.sh` if
   interrupted (resumable). Validate by row count (≈5K-12K/month), not rc=0.
2. Snapshot re-backfill (same 2026-01-01..2026-05-25 window).
3. z-distribution re-probe (quantile(0.95) < 3?).
4. HANDOFF rewrite + decide if form_4_insider_v1 Phase B SPEC ships next cycle.

**If backfill still running — parallel-safe work:** Path 4 EDGAR dated-split
migration (OQ-C29-2), GAP-7(a) tableExists guards, OQ-C19-1.

**Do NOT auto-open without operator green-light:** C-12 Alpaca; Phase C
promotion; ALTER DROP / DROP TABLE; `git push` (Q-4); Q-7 path execution;
relaxed Phase B thresholds; broker integration.

---

## Important framing for the next chat

**Cycle 32 is IN PROGRESS, not closed.** The gating work — a FILTERED
`insider_trades` EDGAR Form 4 backfill to close OQ-C31-1 (zero-inflated 2y
baseline) — is running in the background (~12-18h). FOUR supporting slices are
committed: a CH-`Date` range-clamp bugfix (S96-143; root cause of an ~8h-wasted
double failure), the `cik_ticker_map` bulk ingest (S96-142, closes OQ-C31-3),
two reproducibility wrappers (closes OQ-C30-2 + OQ-C31-2), and the SP500
issuer-CIK filter (S96-144, closes OQ-C32-1) that FIXED the EDGAR throttling.

**The key lesson (S96-144):** the original full-market backfill triggered
EDGAR's sustained-access throttle (503 storms) and produced silently-incomplete
months with rc=0. The fix is the SP500-CIK filter (~5x less volume). ALWAYS
validate backfilled months by ROW COUNT (≈5K-12K/filtered-month), never by
exit code.

**The single most important thing:** the filtered backfill is resumable — if
the machine restarted, bring up Docker/CH, then `bash
logs/c32_filtered_backfill.sh` (it skips months already ≥3000 rows). Do NOT
assume it finished; verify via the `accepted_at` distribution.

**After the backfill:** snapshot re-backfill → z-reprobe → if the baseline is
healthy (quantile(0.95) < 3), `form_4_insider_v1` Phase B SPEC unblocks (Cycle
33+). form_4 is the 5th of 9 Layer-0 arcs; the other 4 (cycle_v1,
vol_struct_v1, sector_rot_v1, cross_asset_v1) are PARTIAL.
