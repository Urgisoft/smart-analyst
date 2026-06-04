# Handoff brief — Vector Core / SignalForge

Last updated: 2026-06-03 (session 96 #40 — **decision-support + full autonomy session**:
shipped the cycle-label honesty fix; built the **autonomous daily pipeline** (Windows Task
Scheduler → daemon + polygon + FTEC brief → file + Telegram) so data + a quantitative brief
refresh hands-off every morning; created a **cloud scheduled Claude agent** that writes the daily
AI market narrative to the Claude app; enriched the local FTEC brief with top-10 holdings,
positioning (short-interest + insider), options IV/skew, and cross-asset (oil/DXY/yield); did a
large interactive FTEC/AI/macro analysis (probabilities, scenarios, capex, recession, Fed).
Validation conclusion (ADR-056 null) UNCHANGED — no new strategy composites, no live trading.**)
On `continue`: optional polish only (see "Next stage"). Nothing is mid-build.

---

## 🔌 Restart recovery — ClickHouse in Docker + the daily automation
ClickHouse runs in container `quantlab-clickhouse` (Docker Desktop). **Container restart policy is
now `unless-stopped`** + Docker Desktop launches at login → CH auto-recovers on reboot. Verify:
`docker start quantlab-clickhouse` → health=healthy → `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
**Dev server:** `npm run dev` → http://localhost:3000 (NO hot-reload — restart after ANY .ts edit; it
died once this session, just restart it). **Python:** `.venv\Scripts\python.exe`.
**⏰ Autonomous daily refresh (NEW):** Windows Task Scheduler task **"SignalForge Daily Refresh"**
(weekday-agnostic daily 7:00 AM America/Denver, wake-to-run, start-when-available, run-as-user) runs
`scripts/daily_refresh.ps1` → CH-wait → `daemon:daily --no-telegram` → polygon ingest (trailing 5d)
→ `ftec_daily_brief.py`. Logs to `logs/daily_refresh_<date>.log`. Manage: `Get-ScheduledTask`.

---

## 🤖 Daily analysis automation (NEW this session — the headline deliverable)
Two complementary daily outputs, fully hands-off:
1. **Local deterministic brief** — `scripts/ftec_daily_brief.py` (runs in the 7am task). Writes
   `reports/ftec_daily_brief_<date>.md` AND pushes plain-text to **Telegram** (TELEGRAM_BOT_TOKEN +
   TELEGRAM_ALERT_CHAT_ID in `.env`, both set; 3× retry for the slow link). Sections: SignalForge
   macro lens (regime/cycle/sector/VIX/cross-asset), FTEC snapshot, **top-10 holdings table +
   today's movers**, **positioning (short-interest days-to-cover + 365d insider net $)**, **options
   IV/skew (FTEC+NVDA)**, P(higher) table, bull/base/bear price scenarios. No LLM/auth needed.
2. **Cloud scheduled Claude agent** — routine `trig_01V7PkD8Zgsv9bHJvFhZK5ag` ("Daily Market Briefing
   — FTEC & AI Sector"), **weekdays 7:30 AM America/Denver (cron `30 13 * * 1-5` UTC)**, model
   sonnet-4-6, tools WebSearch/WebFetch + the auto-attached **Bigdata** connector. Writes the AI
   NARRATIVE (what moved & why, movers + AI/semi movers, top-10 holdings analysis, earnings
   scorecard, overnight/pre-market, oil/DXY, outlook, macro, economic calendar, risks) → delivered to
   the **Claude app**. Manage/edit prompt: https://claude.ai/code/routines/trig_01V7PkD8Zgsv9bHJvFhZK5ag
   (or RemoteTrigger via the `schedule` skill). Cloud agent CANNOT reach local CH — it's web/Bigdata.

**Delivery channels:** Claude app ✅ (cloud), file ✅ + Telegram ✅ (local brief). **Email = NOT wired**
(needs a Gmail/Outlook connector at claude.ai/customize/connectors → attach to the routine, OR SMTP creds).

---

## Operator queue (real-money triggers only)
| # | Item | Status |
| --- | --- | --- |
| Q-1 | First real-capital deployment | **INDEFINITELY DEFERRED** — nothing passed validation |
| Q-2 | Capital-deployment-ramp ADR | **INDEFINITELY DEFERRED** |
| Q-4 | Push unpushed commits to origin/main | OPEN — last push left at `d4aa10a`; **5 new unpushed**: `cc98ea0` `26489ce` `cc84559` `198b6c3` `82fe8ef`. `git push` operator-gated. |
| Q-6 | ETF v1 primary broken | **RESOLVED** (NAV-implied yfinance source; daemon refreshes it) |
| Q-7 | phase1_v3 yield-curve source | OPEN — macro_regimes.yield_curve_value is NULL; brief now sources t10y3m from cross_asset_snapshots as a workaround |
| Q-8 | Phase C promotion | DORMANT (0/6 pass) |
| Q-9 | Single-stock survivorship-free test | RESOLVED-null (ADR-056) |

---

## THE finding (unchanged — read first)
**6 Layer-0 composites validated via Phase B; 0 pass; the alternative-data market-timing thesis is
null (ADR-056, operator-ratified).** Deflation pipeline correctly rejects them as beta. **Deliverable =
the validated pipeline + the honest null + the decision-support layer.** Do NOT build more aggregate
strategy composites, do NOT relax gates, do NOT go live. We are in the **UI / decision-support phase**
(memory `project-phase-ordering`): per-symbol + FTEC/AI analysis is decision-support (no alpha claim),
which is why building briefs over it is fine (not the "false confidence over unvalidated signals" the
phase-order warned against).

---

## Decisions locked in (session #40)
- **Cycle composite is a recession-distance / expansion-health gauge, NOT an NBER phase classifier.**
  Relabeled (presentation-only; score/bands/recession-model untouched): early→"EXPANSION — low
  recession risk", mid→"MID-EXPANSION", late→"SLOWING", contraction→"CONTRACTION" + caveat. The old
  "EARLY" conflated low-recession-risk with early-cycle (it's actually late-cycle at ATH/low-unemp).
- **Autonomous daily refresh = Windows Task Scheduler** (local), NOT cloud — the daemon needs local CH.
  Cloud is used only for the LLM narrative (which is web/Bigdata-based).
- **Daily analysis is split:** deterministic numbers (local brief, no LLM) + AI narrative (cloud agent).
- **ETF cross-validation = latest-per-ticker fallback** when same-date intersection is empty (snapshot
  primary vs lagging secondary) — `compareEtfFlowPanelsLatest` in etf_flow_cross_validation.ts.

---

## Open questions / loose ends (none blocking; optional)
- **Email delivery** for the daily reports — needs a connector or SMTP creds (operator action).
- **Brief enhancements offered but not built:** pre-market/overnight + earnings-scorecard ARE now in
  the CLOUD agent; could also add to the local brief; analyst-revisions + key technical levels not done.
- **F1 weekend-stale false-positives** (FRED/CBOE/SSGA flagged stale Mon mornings — publication lag, not
  a fault). Business-day-aware threshold offered, not taken. Self-heals on the next weekday run.
- **OQ-C41-2 (13D base-filing ingest)** + **OQ-C41-3 (eight_k pooled rebuild)** — known, low value vs null.
- **Q-7 yield curve** — macro_regimes.yield_curve_value is NULL; brief works around via cross_asset.t10y3m.

---

## Next stage
### On `continue` — NOTHING is mid-build. The autonomous daily analysis is live (first cloud run + 7am task fire tomorrow).
1. **Most likely operator-initiated:** live per-symbol "analyze <TICKER>" decision-support, or tweak the
   daily briefs (time/days/contents), or wire Email delivery.
2. **Optional polish:** add positioning/options to MORE holdings; analyst-revisions in the cloud prompt;
   F1 business-day staleness; fix Q-7 yield-curve at the source.
3. **Do NOT:** build more strategy composites; relax DSR/PBO/HLZ; go live; `git push` without operator OK.

---

## Files / code state
- **Commits this session (on `main`, unpushed — Q-4):** `cc98ea0` (cycle relabel), `26489ce`
  (daily_refresh wrapper + Task Scheduler), `cc84559` + `198b6c3` + `82fe8ef` (FTEC daily brief:
  base → +holdings → +positioning/options/cross-asset). Earlier-session pushed: through `d4aa10a`.
- **NEW files:** `scripts/daily_refresh.ps1` (Task-Scheduler wrapper), `scripts/ftec_daily_brief.py`
  (deterministic brief). `reports/` + `logs/` gitignored.
- **Touched:** `src/components/cyclePosition/panels/LatestPanel.tsx` + `src/server/operator_brief_render.ts`
  (cycle relabel), `scripts/tests/operatorBriefRender.test.ts`. (Earlier #39/#40: options IV, yfinance ts,
  etf_flow_ingest, health_check expected-empty, etf_flow_cross_validation latest-per-ticker.)
- **Gates:** tsc=13 baseline. Brief tested live (file + Telegram send OK). All prior test suites green.
- **Key CH facts:** candles current; equity_daily_polygon to 6/1 (FTEC technicals); etf_shares_outstanding
  21 rows; cusip_ticker_map expected-empty; regime currently **yellow** (6/2 pullback); recession_prob 17%.
- **npm/scripts:** `npm run dev` / `daemon:daily [-- --no-telegram]` / `etf:flow:ingest` / `health:check`;
  `.venv\Scripts\python.exe scripts\ftec_daily_brief.py` (manual brief); `scripts\daily_refresh.ps1` (full).

---

## Watch-outs
- **Cloud routine ≠ local data:** the cloud agent can't see SignalForge CH — it's web/Bigdata only. The
  local brief is the SignalForge-overlay half. Don't expect the cloud narrative to cite local composites.
- **NO hot-reload** — restart `npm run dev` after ANY `.ts` edit.
- **Telegram brief is PLAIN TEXT** (Telegram 400s on markdown tables); the file copy is full markdown.
- **EDGAR per-IP throttle:** running daemon many times/day stalls the form-4/8-K steps (saw this validating
  the scheduler). First-of-day runs are clean. Not a scheduler bug.
- **yfinance API drift** is a recurring theme (fixed the unnamed-index + options-IV-sentinel bugs this
  cycle). If a fetch silently returns 0 rows, suspect a column/shape change first.
- **Windows console = cp1252:** python scripts that print unicode need `sys.stdout.reconfigure('utf-8')`
  (ftec_daily_brief does this); commit msgs via `git commit -F -` heredoc in the Bash tool.
- **single-stock deep-link is `?ticker=NVDA`** (query), not `/NVDA`. Browser audits: hit `/audit-reset`
  path-buster before a `#/route` (hash-only nav leaves stale DOM in Claude-in-Chrome).
- Anti-shopping paramount (ADR-056 null stands); worktree merges leave changes uncommitted.

---

## For the next session
Session #40 turned the decision-support layer into a **hands-off daily system**: a 7am local Task
Scheduler job refreshes data + emits a quantitative FTEC brief (file + Telegram), and a 7:30am cloud
Claude routine writes the AI market narrative (Claude app). It also corrected the misleading cycle
"EARLY" label and enriched the brief (holdings, positioning, options, cross-asset). The ADR-056 null is
unchanged — this is all decision-support, not strategy. On `continue`, nothing is pending — offer the
optional polish (Email delivery, more-holdings positioning, F1 staleness, Q-7 yield source) or await
operator direction. Do not go live, do not relax gates, do not push without an explicit OK (Q-4: 5 unpushed).
