# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-30 (session 96 #38 — **Cycles 40-41: completion-phase data work DONE + the
MAJOR finding — validation COMPLETE, comprehensive NULL: 5 aggregate composites = beta, form_4/exec =
insufficient, AND single-stock cross-sectional (survivorship-free Polygon, all cap tiers) = null too.
ADR-056 is now ACCEPTED (operator ratified 2026-05-30 → CONCLUDE the null). NOTHING is tradeable after
deflation. The project's deliverable = the validated deflation pipeline + the honest negative result.
Validation phase is CLOSED — do NOT restart it or build more composites.**) The one
un-disproven direction is cross-sectional single-stock (equity_xs), blocked only by survivorship-free
price data — reachable via Polygon.io free tier (needs a free key). **NEXT on `continue`:** operator
decision — pursue single-stock via Polygon, OR conclude the null. Plus two data bugs to fix if continuing
(13d_g amendments-only; eight_k needs pooled construct). See "Next stage."

---

## 🔌 Restart recovery — ClickHouse is in Docker Desktop
ClickHouse runs in container `quantlab-clickhouse`. On reboot: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"` → `docker start quantlab-clickhouse` (wait `docker inspect --format '{{.State.Health.Status}}'` = healthy) → verify `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
**Dev server:** `npm run dev` → http://localhost:3000 (no hot-reload; restart after server edits). NOT running.
**No background jobs running.** Polygon survivorship-free backfill COMPLETE (`equity_daily_polygon`, 2024-06-03→2026-05-22, ~4.4M rows, gap-free). All 4 EDGAR/FINRA backfills COMPLETE. Watchdog retired. Nothing to resume. To extend Polygon forward (daily), re-run `scripts/polygon_grouped_daily_ingest.py` with a new end-date (free tier only reaches ~2yr back).

---

## Operator queue (real-money triggers only)
| # | Item | Status |
| --- | --- | --- |
| Q-1 | First real-capital deployment | **INDEFINITELY DEFERRED** — reinforced: NOTHING has passed validation, so nothing is deployable |
| Q-2 | Capital-deployment-ramp ADR | **INDEFINITELY DEFERRED** |
| Q-3 | Stooq apikey | **CLOSED-as-dead-end** — tested live: Stooq download works keyless for LISTED names (AAPL 1984→2026) but DROPS delisted (`SIVB.US nie istnieje`). Not a survivorship source. |
| Q-4 | Push **~150** unpushed commits to origin/main | OPEN — `git push` operator-gated |
| Q-6 | ETF v1 yfinance primary broken | OPEN — issuer-direct rebuild still queued (lower priority given the null finding) |
| Q-7 | phase1_v3 yield-curve source | OPEN |
| Q-8 | Phase C promotion | **DORMANT — nothing is Phase-C-eligible (0 of 6 validated pass)** |
| **Q-9** | Single-stock survivorship-free test: **DONE → 7th NULL.** Polygon ingest built (`a2a972f`) + backfill complete; `equity_xs` re-run survivorship-free + cap-tier-stratified (`1e0f7ff`) → NO tier clears the bar (ADR-056). **Only revisit path = PAID deep-history (Polygon Starter/Sharadar/CRSP) for a 2008-2026 window** — operator paid-data decision; **orchestrator recommends AGAINST** (mid-cap OOS sign-flip reads as overfit, not latent alpha). | **RESOLVED-null; paid-revisit optional** |

---

## THE finding (s96 #38) — read this first
**6 Layer-0 composites validated via Phase B; 0 pass; the market-timing thesis is null.**
`phase_b_verdicts` holds: cross_asset_v1, cycle_v1, sector_rot_v1, vol_struct_v1, short_interest_v1 (all
PARTIAL — **beta not alpha**: at IS-best θ they degenerate to ~long-the-index = buy-and-hold; DSR/PBO/HLZ
correctly reject), + equity_xs_v1 (insufficient — data wall). form_4 = insufficient (8/20 pooled events).
**Interpretation:** alternative-data composites built as aggregate market-timing overlays do NOT carry
tradeable alpha — a consistent, money-saving null result, NOT a bug. The validation pipeline works.
**Do NOT** keep building more aggregate composites expecting a different result; **do NOT** relax gates
(anti-shopping); **do NOT** go live (nothing passed).

**The one un-disproven path:** cross-sectional single-stock (`equity_xs_v1`) was "insufficient," NOT
"failed" — blocked only by (a) survivorship (candles = 0.1% delisted coverage) + (b) shallow insider
history (P-code buys 2024+ only). Fix the data (Polygon free tier for survivorship-free delisted prices;
deeper EDGAR insider backfill) and it can be tested for real. This is where alpha might still exist.

---

## What Cycles 40-41 delivered (s96 #37-#38)
- **EDGAR + FINRA ingests REPAIRED + backfilled (all 4):** FINRA endpoint moved→free DAPI (`72a5978`);
  EDGAR body-fetch 404 fixed via index.json resolver (`4872430`); 13D/G FTS-token fix (`767901f`).
  Backfill drivers (`defbccf`, +13d-g). Final rows: `short_interest`=2,938,092 (2020-26),
  `eight_k_events`=18,683 (2019-26), `schedule_13d_g_filings`=33,684 (2020-26, **but 100% amendments —
  bug**), `executive_departures`=639 (sparse).
- **Combination probe (`3f8931e`):** the 4 macro composites are beta (NO-GO on ensemble; ρ̄=0.72-0.88).
- **Single-stock scoping spec (`da1edd7`):** `docs/specs/single-stock-equity-analysis-scoping.md` — re-cast
  the manual playbook (`docs/obsidian/symbol-analysis/`) as a cross-sectional alpha pipeline.
- **equity_xs_v1 built + run:** `src/server/equity_xs.ts` + `scripts/phase_b_campaign_equity_xs_v1.ts`.
  Verdict insufficient + survivorship-suspect (data wall).
- **short_interest_v1 (`de1b71a`, Cycle 41):** snapshots built (1,597) + campaign + the repo
  ILLEGAL_AGGREGATION fix (was why snapshots were empty). Verdict PARTIAL/beta (5th).
- **MCP consolidation:** all 9 of the user's MCP servers inventoried → `C:/Users/Pejman/Desktop/PROJECTS/mcp_servers/ALL_MCP_SERVERS.json` + `README.md`. Created (gitignored) `.mcp.json` in this project
  wiring financial-hub(Finnhub)/yahoo-finance/coingecko/fetch/sequential-thinking/shared-knowledge —
  **Claude Code must RELOAD to use them.** (Those were Cline's servers; replicated for Claude Code.)
- **Data-source reality (tested, not assumed):** survivorship-free delisted prices are NOT free via
  Yahoo/Finnhub/Stooq/MCP-registry; Polygon.io free tier IS the path (Q-9). Bigdata.com (connected to
  Claude Code) covers fundamentals/valuation/institutional/options/news for LIVE per-symbol analysis.

---

## Decisions locked in (s96 #38)
- **Null result accepted for the aggregate market-timing thesis** (5 beta + form_4 insufficient).
- **`short_interest_repository.readLatestFinraRowsAsOf`**: aliased `settlement_date`→`sd` in inner
  subquery to dodge CH 24.8 `ILLEGAL_AGGREGATION` (max()+argMax() co-nesting). Byte-identical; EXPLAIN-
  grammar test now active. This was a silent crash zeroing the snapshot path.
- **Phase order unchanged** (memory `project-phase-ordering-completion-ui-live`): complete→UI→live. We are
  still in "complete," now blocked on a research-direction decision (Q-9), not more building.
- Stooq closed as a survivorship source (Q-3). MCP servers are conversational tools, NOT autonomous
  pipeline ingests (the daemon can't call them).

---

## Open questions
- **OQ-C41-1 (THE fork):** pursue single-stock cross-sectional via Polygon free tier (Q-9), or conclude
  the null? Operator decision.
- **OQ-C41-2:** schedule_13d_g ingest captures ONLY amendments (27,077 `SC 13G/A` + 6,607 `SC 13D/A`,
  ZERO base `SC 13D`/`SC 13G`). The base-filing FTS query is wrong/missing → gated signal identically
  zero. Data-Ingest fix needed before any 13d_g Phase B. (My Cycle-40 13d_g fix got amendments but not
  base filings — incomplete.)
- **OQ-C41-3:** eight_k has data (18,683, continuous) but its composite is the statistically-invalid
  per-sector max-over-sectors construct (ADR-053/054/055 rejected). Needs the ADR-055 pooled treatment
  (mirror form_4_insider_v5) before a valid campaign (~1 cycle). Honest prior: likely also beta.
- **Carried:** OQ-C38-2 (form_4 multi-year backfill for pooled events ≥20); OQ-C40-3 (window parity).

---

## Next stage
### On `continue` — this is an operator-judgment fork, surface it; don't auto-build
1. **DECIDED — ADR-056 ACCEPTED (operator chose conclude, 2026-05-30).** Validation phase is CLOSED.
   The project's deliverable is the validated deflation pipeline + the honest comprehensive null. On
   `continue`: do NOT restart validation, do NOT build more composites, do NOT pursue paid deep-history
   (operator declined), do NOT relax gates. There is no pending build. If the operator opens new work, it
   would be a NEW direction (their initiative), not a continuation of the composite-validation line.
2. **Still available (no alpha claim, unaffected by the null):** the live per-symbol Bigdata.com analysis
   tool ("analyze \<TICKER\>") as decision-support; the daily-data pipeline (EDGAR/FINRA/Polygon ingests)
   if the operator wants ongoing data collection. Both are optional, operator-initiated.
2. **If concluding the null:** write an ADR documenting "alternative-data market-timing composites — null
   result" + the validated-pipeline deliverable. Stop adding composites.
3. **Lower-priority data fixes (only if continuing the aggregate line, which the evidence discourages):**
   fix 13d_g base-filing ingest (OQ-C41-2); pooled-construct eight_k (OQ-C41-3).
4. **Live per-symbol analysis** (free, works now via Bigdata.com + Finnhub + Stooq-for-listed + existing
   data): the operator can ask "analyze <TICKER>" anytime — decision-support, NOT a validated signal.

**Do NOT:** go live (nothing passed); relax DSR/PBO/HLZ (anti-shopping); `git push` (Q-4); build more
aggregate composites expecting alpha; build pretty UI on unvalidated signals.

---

## Files / code state
- **Commits this session (on `main`, unpushed — Q-4):** `4872430` `72a5978` `defbccf` `59bc1ee` `767901f`
  `c01c8e0` `3246294` `3f8931e` (+ teach-doc) `da1edd7` (single-stock spec) + equity_xs harness/report
  commits + `de1b71a` (short_interest_v1) + this HANDOFF. ~150 total unpushed.
- **Phase B:** `phase_b_campaign_{cross_asset,cycle,sector_rot,vol_struct,equity_xs,short_interest}_v1.ts`
  all built; reuse `src/lib/validator.ts`/`psr.ts`/`cscv.ts`/`hlzHaircut.ts`. Verdicts in
  `phase_b_verdicts` (6 versions). Re-run any: `npx tsx scripts/phase_b_campaign_<x>.ts --apply`.
- **equity_xs:** `src/server/equity_xs.ts` (cross-sectional harness), `scripts/phase_b_campaign_equity_xs_v1.ts`.
  Re-run once survivorship-free prices exist.
- **MCP:** `.mcp.json` (project root, GITIGNORED — Finnhub key); inventory in Desktop/PROJECTS/mcp_servers/.
- **Analysis reports:** `docs/analysis/phase-b-{equity_xs_v1,short_interest_v1}-deflation-2026-05.md`.
- **Key CH facts:** candles = 503 current S&P names + 89 ETFs (2008-2026), **0.1% delisted coverage**
  (survivorship wall). `short_interest_snapshots`=1597. `phase_b_verdicts`=6 versions, 0 phase_c_eligible.

---

## Watch-outs
- **`.mcp.json` is gitignored** (carries Finnhub key) — verified not tracked; do NOT un-ignore + commit.
- **Claude Code needs RELOAD** to pick up the new `.mcp.json` MCP servers (financial-hub/yahoo-finance/etc.).
- **MCP servers ≠ pipeline ingests** — usable by the assistant in-conversation only; the daemon/scripts
  need real HTTP/CSV sources (EDGAR/FINRA/Polygon).
- **`phase_b_verdicts.best_*_sharpe` are PER-DAY** (×√252 to annualize). Healthy-looking annualized numbers
  here are BETA, not alpha — see `docs/teach/2026-05-30-phase-b-verdict-interpretation.md`.
- **13d_g = amendments only** (OQ-C41-2); **eight_k = invalid per-sector construct** (OQ-C41-3);
  **exec_departure + form_4 = too sparse**. None ready for a valid campaign without work.
- **Anti-shopping is paramount now** — with 6 fails on the board, the temptation to relax a gate to
  manufacture one pass is exactly the selection bias the whole system exists to prevent. A FAIL is final.
- Carried: worktree merges leave changes UNCOMMITTED (orchestrator copies→gates→commits; `git worktree
  remove --force` + `git branch -D`); EDGAR/FINRA per-IP throttle; `git commit -F -` not here-strings;
  dev server no hot-reload; transient API rate-limits can kill a worker early (just relaunch).

---

## For the next session
Cycles 40-41 finished the completion-phase data work and produced the project's central honest finding:
**6 Layer-0 composites validated, none pass — the alternative-data market-timing thesis is a null result,
caught correctly by the validation pipeline before any capital was risked.** The single un-disproven
direction is cross-sectional single-stock, blocked only by survivorship-free price data (Polygon free
tier, Q-9). On `continue`, the move is NOT to build more — it's to surface the operator fork (pursue
single-stock via Polygon, or conclude the null) and act on their answer. Live per-symbol analysis via
Bigdata.com is available free anytime as decision-support. Do not go live, do not relax gates, do not push.
