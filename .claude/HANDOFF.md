# Handoff brief — Vector Core / SignalForge

Last updated: 2026-07-02 (s96 #42 — **swing-screener + delivery session**: built the daily
whole-market **swing-candidate screener** (operator criteria; CANDIDATES not signals — ADR-056),
wired **email delivery** (SMTP scaffolding; operator must add 5 SMTP_* keys to .env — see
scripts/send_email.py header), **un-muted the daemon's Telegram** so the paper swing cells'
NEW/EXIT signals are delivered daily, and pushed everything to origin. **⚠ Docker/CH is STUCK
(engine hangs even after clean WSL+Docker restart) — needs operator eyes / machine reboot; see
the OPERATIONAL block. CH data is ~3 weeks stale (last refresh 06-11/12) — after Docker is fixed,
run a catch-up: `npm run daemon:daily` + polygon ingest with `--start-date 2026-06-11`.**
Prior session s96 #41-cont: 2026-06-11 (`/#/today` command-center (NEW DEFAULT
route), data-integrity reconciliation (25 checks), the forward catalyst calendar (+brief embed +day-before
ping +Sunday digest), the sector-scan, and the options expected-move tool — all decision-support, ADR-056.
**⚠️ Docker/CH was DOWN at session end — verify CH first (see Next stage).** The original #41 session added the
**Sell-Off & Stabilization Monitor + Escalation-Risk Read** (operator PDFs → specs + working v1),
embedded its compact read into the daily FTEC Telegram brief, and built the **autonomous
event-driven Market Watch** (Tier-1 deterministic change detector + Tier-2 alerter + 30-min
market-hours scheduled task) so the operator is pinged on Telegram ONLY when something material
changes — hands-off. Opus-narration of the alert is built but OFF pending a local `claude` CLI
install + login. ADR-056 null UNCHANGED — all decision-support, no strategy composites, no live
trading.**) On `continue`: finish the Opus-CLI upgrade (operator-gated install) OR build the
"Today" command-center UI page (see "Next stage"). Nothing is mid-build/broken.

---

## 🔌 Restart recovery — ClickHouse in Docker + the automations
ClickHouse runs in container `quantlab-clickhouse` (Docker Desktop, restart policy `unless-stopped`
+ Docker launches at login → auto-recovers on reboot). Verify: `docker start quantlab-clickhouse`
→ healthy → `curl -s "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" --data-binary "SELECT 1"`.
**Dev server:** `npm run dev` → http://localhost:3000 (NO hot-reload — restart after ANY .ts edit).
**Python:** `.venv\Scripts\python.exe`. **Confirmed live this session:** CH healthy (23h uptime),
dev server serving HTTP 200.

**⏰ THREE Windows Task Scheduler jobs (run-as-user, America/Denver) + 1 local one-time:**
1. **"SignalForge Daily Refresh"** — daily 7:00 AM → `scripts/daily_refresh.ps1`: CH-wait →
   `daemon:daily --no-telegram` → polygon (5d) → `ftec_daily_brief.py` (now also embeds the sell-off
   read + the **catalyst calendar**) → `selloff_monitor.py` → **`reconcile.py --push`** (data-integrity
   audit) → **`catalyst_calendar.py --alert`** (day-before earnings/CPI/Fed ping) → **`swing_screener.py
   --push`** (swing candidates → Telegram+email). **Daemon Telegram is now ON** (s96 #42 — delivers the
   paper cells' NEW/EXIT; re-mute = add `-- --no-telegram` back). Logs `logs/daily_refresh_<date>.log`.
2. **"SignalForge Market Watch"** — weekdays, every 30 min for 7.5h from 7:00 AM → `market_watch_cycle.ps1`
   → `market_watch.py` → `market_watch_alert.py` (Opus-narrated). Event-driven: a quiet cycle sends NOTHING.
3. **"SignalForge Week Ahead" (NEW)** — Sundays 5:00 PM → `scripts/week_ahead.ps1`: catalyst week-ahead
   (`catalyst_calendar.py --push --days 10`) + sector scan (`sector_scan.py`) + expected moves
   (`expected_move.py`), all → Telegram.
- **Local one-time (scheduled-tasks MCP, runs only while the app is open):** `ftec-fomc-reanalysis`
  fires once **Jun 17 ~1:00 PM MT** (post-FOMC) → re-runs the FTEC analysis to the Claude app. Manage
  in the app's "Scheduled" sidebar.
Disable a Windows task: `Unregister-ScheduledTask -TaskName '<name>'`.

---

## 🤖 Autonomous outputs (what the operator gets hands-off)
1. **Daily local brief** (7am task) — `ftec_daily_brief.py` → `reports/` + **Telegram** (plain text).
   Sections: macro lens, **sell-off & stabilization compact read** (NEW, embedded near top), FTEC
   snapshot, top-10 holdings + movers, positioning (short-interest + insider), options IV/skew,
   cross-asset, P(higher), scenarios. Total ~3.7k chars (fits Telegram's 4k cap). Telegram send
   re-confirmed working this session.
2. **Daily sell-off report** (7am task) — `selloff_monitor.py` → `reports/selloff_monitor_<date>.md`
   (full read; no separate push — rides the brief's compact section).
3. **Event-driven Market Watch alerts (NEW)** — every 30 min in market hours; Telegram alert ONLY on
   a material change. Currently deterministic text; Opus enrichment pending CLI (see Next stage).
4. **Cloud Claude routine** `trig_01V7PkD8Zgsv9bHJvFhZK5ag` — weekdays 7:30 AM, AI market narrative →
   Claude app. CANNOT see local CH (web/Bigdata only). Manage: https://claude.ai/code/routines/trig_01V7PkD8Zgsv9bHJvFhZK5ag
5. **Daily data-integrity reconciliation (NEW)** — `scripts/reconcile.py --push` (daily-refresh step 5):
   compares every stored number (FTEC+top-holding prices, VIX, dollar, oil, t10y3m, recession_prob,
   regime) vs INDEPENDENT online (yfinance + FRED via pandas_datareader), trading-day-aware freshness +
   plausibility bounds. DEFINITION-AWARE (dxy_close↔FRED DTWEXBGS, NOT ICE DXY). Detect+report only;
   chunked Telegram. Now 25 checks (7 prices + VIX/regime/USO/recession + 14-table freshness sweep, auto-detected date cols, trading-day + expected-empty aware), all OK. Caveat: FRED was timing out → dxy/t10y3m degrade to NODATA
   until FRED recovers. `reconcile.py` (no --push) for a silent local run.

6. **Daily swing-candidate screen (NEW s96 #42)** — `scripts/swing_screener.py --push` (daily-refresh
   step 7): whole-market scan for operator-criteria matches (pullback-in-uptrend + volume breakout;
   editable CRITERIA block). Preferred universe = 12k-ticker CH panel; auto-falls back to S&P 500 via
   yfinance when CH is down (same _classify code). CANDIDATES for operator validation, NOT signals.
7. **Paper-cell swing signals (un-muted s96 #42)** — the 7am daemon Telegram report now delivers
   mr_v1/p=14 + trend_v1/p=30 NEW/EXIT/OPEN (paper-tracked, unvalidated — decision-support).

**Delivery:** Claude app ✅ (cloud), file ✅, Telegram ✅ (brief + sell-off + market-watch + reconciliation
+ screener + daemon report). **Email: wired, awaiting operator's 5 SMTP_* keys in .env** (Gmail app
password; 2-min setup in scripts/send_email.py header) — brief + screener then email automatically.

---

## The autonomous Market Watch — how it works (NEW this session)
**Two tiers, the design that won't cry wolf or burn Max limits:**
- **Tier 1 `scripts/market_watch.py`** — deterministic detector. Snapshots discrete BUCKETS of:
  regime, recession-prob band, sell-off state, stabilization/escalation verdicts, VIX band, 10Y
  band, top-6 holding move-bands, quarantine count. DIFFS vs prior run (`reports/market_watch_state.json`).
  Materiality gate = **"alert on transition, not persistence"**: fires only when a bucket changes/
  worsens, so a standing condition (VIX at 22 for hours) does NOT re-alert. First run + first cycle
  of a new day (for daily-move signals) = silent baseline. Writes `reports/market_watch_latest.json`
  `{material, changes[], state, headline}`. Reuses `selloff_monitor` scoring (can't drift). Never raises.
- **Tier 2 `scripts/market_watch_alert.py`** — reads latest.json; if material, pushes Telegram.
  ALWAYS-available deterministic alert (severity-sorted changes + rule-based "what this means" +
  not-advice disclaimer). IF `claude` CLI present (PATH or `CLAUDE_CLI=` in .env) → Opus web-searches
  the CAUSE + writes the alert (hard no-buy/sell prompt wall); any failure silently falls back.
- **Validated:** baseline silent → re-run quiet (dedup) → simulated calmer-prior fired all deltas with
  correct severities; alert composes cleanly; `claude` CLI confirmed ABSENT (deterministic tier active).

---

## Operator queue (real-money triggers only)
| # | Item | Status |
| --- | --- | --- |
| Q-1 | First real-capital deployment | **INDEFINITELY DEFERRED** — nothing passed validation |
| Q-2 | Capital-deployment-ramp ADR | **INDEFINITELY DEFERRED** |
| Q-4 | Push unpushed commits to origin/main | **RESOLVED s96 #42** — operator authorized; origin current at `d0e4543` (0 unpushed). Future pushes: session-pattern authorized, keep origin current on commit. |
| Q-7 | phase1_v3 yield-curve source | OPEN — macro_regimes.yield_curve_value NULL; brief/monitor source t10y3m from cross_asset_snapshots |
| Q-8 | Phase C promotion | DORMANT (0/6 pass) |
| Q-10 | Opus-narration for Market Watch | **RESOLVED** — CLI 2.1.168 installed + already authed on Max (no separate login needed); `CLAUDE_CLI=C:\Users\Pejman\AppData\Roaming\npm\claude.cmd` in .env. `opus_text` runs `cmd /c claude.cmd -p --model opus` (prompt via STDIN, encoding=utf-8). Verified live; material alerts now Opus-narrated (web-researched cause, no buy/sell), deterministic fallback on any failure. |

---

## THE finding (unchanged — read first)
**6 Layer-0 composites validated via Phase B; 0 pass; the alternative-data market-timing thesis is
null (ADR-056, operator-ratified).** Deliverable = the validated pipeline + the honest null + the
decision-support layer. Do NOT build strategy composites, relax DSR/PBO/HLZ gates, or go live. We
are in the **UI / decision-support phase** — per-symbol/FTEC/market analysis + monitors are
decision-support (no alpha claim), which is why building briefs/monitors over it is fine.

---

## Decisions locked in (session #41)
- **Sell-off monitor = informational v1**, faithful to the two operator PDFs: state detection +
  stabilization signals (CONFIRM a turn, never forecast; dead-cat guard) + escalation lean
  (credit double-weighted = the key tell; "mixed is valid"). NO urgent push (rides the brief).
- **Market Watch cadence = event-driven only** (operator-chosen): check every ~30 min market hours,
  alert ONLY on material change. Quietest, lowest Max usage.
- **Alert architecture = deterministic floor + graceful Opus enrichment.** Cheap detector gates the
  expensive narrator; Opus runs only on real events; degrades to deterministic if no CLI.
- **"Recommendations" = situational decision-support, NOT buy/sell.** Hard wall (ADR-056 + not a
  licensed advisor) baked into both the deterministic text and the Opus prompt.
- **Cloud agent can't see local CH** → the SignalForge-aware monitor MUST run locally; Opus-on-Max
  runs locally via headless `claude -p` (pending CLI).

---

## Open questions / loose ends (none blocking)
- **Q-10 Opus CLI** (above) — the only thing between "deterministic alerts" and "Opus-narrated alerts."
- **UI overload** (operator raised it): 16 flat nav links, no synthesis layer. Recommended a **"Today"
  command-center page** (visual version of the brief: verdict → drivers → what-changed → attention →
  drill-down), plain-language number translation, nav collapsed to ~5 groups. **DONE** — built `/#/today`
  (NEW DEFAULT route) + `src/server/today_dashboard.ts` (GET /api/today); old dense terminal moved to
  `/#/terminal`. Validated via API + tsc=13 (no visual click — Chrome ext off; eyeball /#/today). Caught
  a UTC-vs-local date bug (false-stale every evening) + fixed. v2 ideas: collapse the terminal's own
  16-link nav; richer what-changed; put the sell-off state into the verdict line.
- **Email delivery** — needs connector/SMTP (operator action).
- **DXY label** — DONE. reconcile.py confirmed `dxy_close` is correct (FRED DTWEXBGS broad $, ~119),
  NOT a bug. Relabeled DXY→`BROAD-$` in the brief + dashboard chips (`cross_asset_dashboard.ts` +
  `descriptors.ts` ×2); tsc=13, dev restarted, served-module verified (Chrome ext NOT connected, so no
  visual click — eyeball `/#/cross-asset` when convenient). Source unchanged (ICE-DXY swap = Tier-2/operator).
- **Sell-off UI panel** `/#/selloff` — the v2 follow-on (Bloomberg-density), not built.
- **F1 weekend-stale false-positives** (publication lag; self-heals weekday).
- **Q-7 yield curve** NULL at source; worked around via cross_asset.t10y3m.

---

## Next stage
### On `continue` — nothing mid-build. But FIRST check CH/Docker (see ⚠️ below). Then pick from the
### "what's genuinely missing" priorities (impact order; given to operator s96 #41-cont):
1. **Downside-preparedness framing** — reframe the P(higher) table into expected-shortfall / "bad week"
   sizing (what a −2σ week costs on FTEC; worst 1mo in N yrs). Honest risk for a concentrated holder.
2. **Reliability heartbeat** — a watchdog that PINGS when the daily brief didn't run / CH is down. The
   operator just lived this gap (Docker died silently while away). Guards the machinery, not the numbers.
3. **Position/concentration awareness** — if operator inputs FTEC size (local), show true single-name
   exposure + $ impact. Highest personal value; gated on their input.
4. **Optional UI:** sell-off `/#/selloff` panel; a `/#/sectors` page (sector_scan); nav→5-groups; Email.
5. **Do NOT:** build strategy composites; relax gates; go live; `git push` without explicit OK.

**⚠️ OPERATIONAL (s96 #42, 2026-07-02): Docker/CH is STUCK — needs operator.** Docker Desktop's engine
hangs indefinitely (`docker ps` never returns) even after the full clean-restart recipe (`wsl --shutdown`
→ kill Docker processes → relaunch). Likely fixes: eyeball the Docker Desktop GUI for a stuck
update/WSL-update dialog, or reboot the machine. UNTIL FIXED: composites/dashboards/regime/daemon are
blocked (tomorrow's 7am daemon step will fail); the yfinance tools still work (screener falls back to
S&P 500, brief prices, calendar, sector scan, expected move). AFTER FIXED: CH data is ~3 weeks stale —
run `npm run daemon:daily` AND `.venv\Scripts\python.exe scripts\polygon_grouped_daily_ingest.py
--start-date 2026-06-11 --end-date <today> --apply`, then `reconcile.py` to verify. **This third silent
outage is the standing case for the reliability heartbeat (priority #2).**
(Historical note, s96 #41-cont: Docker Desktop was found closed → CH down for ~1-2
days. Operator restarted Docker; data was then refreshed to current on 06-11: `daemon:daily --no-telegram`
(candles+macro+9 composites+regime+paper cells) + polygon ingest (equity_daily_polygon→06-10; 06-11 not
yet published) + `npm run finra:short-interest:ingest` (short_interest→05-29 settlement). Reconcile = 24/24
OK, 0 discrepancies; **regime recomputed GREEN** (sell-off easing post-CPI, VIX ~19.4). The ~2-day outage
silently broke the 7am refresh while the operator was away — **this is exactly why priority #2 (reliability
heartbeat) matters.** If CH is down again: `docker start quantlab-clickhouse` → `curl ... "SELECT 1"`; the
yfinance tools (calendar/sector/expected-move) work without CH, composites/dashboards/regime need it.)

---

## Files / code state
- **NEW this session:** `scripts/selloff_monitor.py` (sell-off v1; `compact_summary()` + `build_report()`
  share pure scoring helpers), `scripts/market_watch.py` (Tier-1 detector), `scripts/market_watch_alert.py`
  (Tier-2 alerter), `scripts/market_watch_cycle.ps1` (cycle wrapper), `docs/specs/selloff-stabilization-monitor.md`
  + `docs/specs/selloff-escalation-risk-read.md`. `reports/` + `logs/` gitignored (incl. market_watch_state.json).
- **Touched:** `scripts/daily_refresh.ps1` (+selloff step 4), `scripts/ftec_daily_brief.py` (embed sell-off compact read).
- **NEW (decision-support tools, s96 #41-continuation — big multi-tool batch):**
  `scripts/reconcile.py` (data-integrity audit, 25 checks vs yfinance+FRED, daily --push),
  `scripts/catalyst_calendar.py` (forward earnings+macro calendar; brief embed + `--alert` day-before ping + weekly),
  `scripts/sector_scan.py` (11-sector relative-strength landscape), `scripts/expected_move.py` (options-implied
  ±moves; reuses yfinance_options_summary), `scripts/week_ahead.ps1` (Sun digest = calendar+sectors+expected-move),
  `src/server/today_dashboard.ts` + `src/components/today/TodayApp.tsx` (the `/#/today` command-center = NEW DEFAULT
  route; old terminal → `/#/terminal`; new `/api/today`), `docs/teach/2026-06-11-options-expected-move.md`.
  Also: DXY→`BROAD-$` relabel (brief + cross_asset dashboard chips). All ADR-056 framing; mostly CH-optional (yfinance).
  Many commits unpushed (`git log origin/main..HEAD`); `git push` operator-gated.
- **10 unpushed commits (origin at `d4aa10a`):** `814f4f3` `964ce55` `0df0bfd` `4b38195` `adfa910`
  `82fe8ef` `198b6c3` `cc84559` `26489ce` `cc98ea0`. (`git log origin/main..HEAD` for the list.)
- **Gates:** tsc=13 baseline (no .ts changed this session — pure Python/PS + docs). Telegram send re-verified.
- **Scheduled tasks:** "SignalForge Daily Refresh" (7am) + "SignalForge Market Watch" (30-min market hours) — both Ready.
- **npm/scripts:** `npm run dev` / `daemon:daily [-- --no-telegram]` / `health:check`;
  `.venv\Scripts\python.exe scripts\ftec_daily_brief.py` (brief) · `\selloff_monitor.py` (sell-off) ·
  `\market_watch.py` (detector) · `\market_watch_alert.py` (alerter); `scripts\market_watch_cycle.ps1` (one watch cycle).

---

## Watch-outs
- **Market Watch is event-driven** — silence = nothing material changed (NOT a failure). The 7am brief is
  the daily heartbeat. If you want a "still calm" daily confirm, switch cadence to events+heartbeats.
- **No Opus narration yet** — alerts are deterministic until Q-10 done. `claude` CLI NOT on PATH (GUI install).
- **Cloud routine ≠ local data** (web/Bigdata only).
- **NO hot-reload** — restart `npm run dev` after any `.ts` edit.
- **Telegram = PLAIN TEXT** (400s on markdown tables); file copies are full markdown.
- **EDGAR per-IP throttle:** many daemon runs/day stall form-4/8-K steps; first-of-day is clean.
- **yfinance API drift** recurring (^TNX returns yield directly e.g. 4.54 — do NOT /10; fixed this session).
- **Windows console = cp1252:** python scripts printing unicode need `sys.stdout.reconfigure('utf-8')`; commit via `git commit -F -` heredoc.
- **single-stock deep-link is `?ticker=NVDA`** (query). Browser audits: hit `/audit-reset` before a `#/route`.
- Anti-shopping paramount (ADR-056 null stands); worktree merges leave changes uncommitted.

---

## For the next session
Session #41 made the decision-support layer **actively watch the market for the operator**: a daily
brief now leads with a sell-off/stabilization read, and a new event-driven Market Watch pings Telegram
only when something material changes (regime flip, sell-off escalation, big holding move, VIX/10Y break,
new data-quarantine) — hands-off, every 30 min in market hours. The Opus "why" narration is built and
one operator step away (install + login the `claude` CLI → Q-10). The other big open item is the operator's
UI-overload pain → the recommended fix is a "Today" command-center page. ADR-056 null unchanged — all
decision-support, not strategy. Do not go live, do not relax gates, do not push without an explicit OK (Q-4: 10 unpushed).
