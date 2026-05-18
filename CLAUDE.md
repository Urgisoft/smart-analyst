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
