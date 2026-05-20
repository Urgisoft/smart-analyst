# SignalForge — Project Instructions

This file is auto-loaded by Claude Code at the start of every session in this repo.
It pulls in two always-on documents:

1. **The Vector Core system prompt** — your role, build stages (RESEARCH → DESIGN →
   SPEC → CODE), continuous roles (TEACH, PUSHBACK), and the methodology canon.
2. **The latest handoff brief** — what was decided, what's open, what's next.

When the user starts a new chat, you should already know everything below before you
respond. Do not ask the user to "paste the handoff" — it is already in your context.

---

## Vector Core system prompt (always-on)

@.claude/vector_core_system_prompt.md

---

## Latest handoff (auto-loaded — see handoff protocol in vector core prompt)

@.claude/HANDOFF.md

---

## Autonomous-execution protocol (always-on, locked in 2026-05-19)

The user explicitly delegates execution authority within pre-authorized scope. The
default is to push slices through to completion without permission pauses; the
exceptions are enumerated below and nowhere else.

### Pre-authorized — do without asking

- **HANDOFF.md rewrites.** End of slice, context-pressure trigger, drift signal,
  or before destructive ops — write the handoff. No confirmation. This supersedes
  the trigger-gated default in the Vector Core handoff protocol for this project.
- **Git commits within a designed slice.** Each coherent unit of work commits as
  its own commit on top of `main`. No "should I commit?" prompts.
- **End-of-session close-out.** When context pressure hits or the current slice
  completes, the standing close-out is: commit any pending work → rewrite
  HANDOFF.md → end the turn cleanly. The next chat picks up from HANDOFF.
- **"Continue" means continue.** When the user returns and says "continue," resume
  from HANDOFF's "Next stage" section. Do not re-ask what to do, do not offer a
  menu of options, do not summarize the handoff back. Just start the work.
- **Free-data API ingest + free public scraping** — see the data-source policy
  section below for the authorized list.

### Hard stops — surface to operator before proceeding

These reverse the autonomous-default; pause + ask before any action.

- **Destructive ops** not previously authorized: schema drops, `ALTER ... DELETE`,
  `git reset --hard`, force-push, dependency removals, killing user processes.
- **Broken builds or failing tests** you cannot tractably fix from current context.
- **Canon-thin methodology ambiguity** — two legitimate approaches, the canon
  doesn't pick. Surface the choice, don't pick autonomously.
- **ADR conflicts** — your action would contradict a ratified ADR.
- **Anything affecting real-money execution path** — the live-trade ledger, the
  paper-to-real flip gate, the kill criteria, the deployment-stage machine.
- **Paid subscriptions or vendor onboarding** — Sharadar, CBOE DataShop, ISM PMI,
  Polygon, Alpaca account flows, anything that incurs cost or requires the
  operator to log into an external service.
- **Authenticated / logged-in scraping** — Fidelity, broker portals, anything
  behind a session cookie. Never run headless; never store credentials.
- **`git push`** — local commits are free, push is operator-gated.

## Data-source policy (always-on, locked in 2026-05-19)

### Pre-authorized — use freely

**Direct free APIs:**

- `yfinance` (`scripts/macro_regime_ingest.py`, `scripts/fetch_daily_yfinance.py`)
- SEC EDGAR (full-text search, RSS/Atom feeds, submissions API)
- FRED (`scripts/fred_ingest.py` — extend `DEFAULT_SERIES` for new series)
- FINRA (Reg-SHO, short-interest bi-monthly feeds, public ATS data)
- CBOE archives (free historical files; the paid DataShop subscription stays blocked)
- ETF.com (public fund pages)
- Yahoo Finance (web endpoints + the `yfinance` package)
- Stooq (`scripts/macro_regime_ingest.py`'s breadth path — use `STOOQ_APIKEY` env
  var when available; falls through to bare URL otherwise)
- Wikipedia + `fja05680/sp500` (point-in-time S&P 500 constituents)

**Public-source scraping via Playwright:** any public, unauthenticated page is
fair game. Required implementation discipline on every scrape:

1. **Schema validation on every fetch** — schemas live alongside the scraper;
   parse failures raise loud, not silent.
2. **Alert on parse failures** — anomaly pushed to the operator brief / Telegram
   (whichever channel the scraper's downstream consumer already uses).
3. **Fallback to cached last-good values** — never let a parse failure propagate
   downstream as fresh data. Cache TTL must be explicit + logged.
4. **No silent stale-data propagation** — the consumer must see "stale" as a
   distinct state from "fresh."

### Blocked — needs explicit operator approval

- Paid subscriptions (Sharadar, CBOE DataShop, ISM PMI, Polygon, S&P CapIQ,
  Bloomberg, Refinitiv, FactSet, PitchBook, Crunchbase, CB Insights, etc.)
- Authenticated scraping (Fidelity, broker portals, anything behind login)
- Anything that signs the user up for a service or trial

### Gap-evaluation rule

When evaluating any Phase 9+ gap, **do NOT halt on "needs data" without first
researching free + scrape alternatives.** SEC EDGAR covers filings; FRED covers
macro indicators; FINRA covers short-interest; ETF.com covers fund flows; the
SEC and exchange archives cover most institutional plumbing for free. The
"data-source decision" stop condition only fires if the gap genuinely requires
paid data or authenticated access, not because the cheapest path takes scraping.

---

## Teach-doc protocol (always-on)

Whenever the **[TEACH]** role fires (per Vector Core — explaining a strategy, metric,
technique, library, or formula the user hasn't shown they understand), persist the
explanation as a markdown file under `docs/teach/` so the user can review later.

- Create `docs/teach/` if it does not exist (lazy-create on the first teach event;
  do not pre-create empty).
- Filename format: `YYYY-MM-DD-<short-slug>.md` — e.g. `2026-05-02-pbo-cscv.md`.
  Date is the calendar date of the conversation, not arbitrary. Slug should name
  the concept being taught, not the surrounding task.
- File content: a self-contained version of the teaching, structured per Vector
  Core's [TEACH] order — **Intuition** (plain-language paragraph), **Mechanism**
  (formulas + how it works), **Failure mode** (when it breaks / what it assumes).
  Include the source citation (book + chapter, paper + section) at the top.
- Multiple teach events on the same day = multiple files (different slugs), not
  appended to one file. Each concept stands alone for later review.
- Inline this in the same turn as the teaching — write the doc as part of the
  response, not as a follow-up. Do not ask permission; this is the standing rule.
- Do **not** create a teach-doc for routine explanations the user already knows
  (e.g. re-stating Sharpe to a quant). The trigger is the [TEACH] role activating,
  same as in Vector Core — when in doubt, the rule is the same: would skipping
  this leave the user with a silent gap that corrupts downstream work?
