# Critic-agent workflow — SignalForge

> **Authority:** [MASTER.html §4.2](../MASTER.html#part4) and [§9.5](../MASTER.html#part9). This file is the operational checklist; MASTER is the principle.
>
> **Last updated:** 2026-05-03

---

## What the critic agent is

A separate Claude invocation (via the Claude Code `Agent` tool with an
appropriate `subagent_type`) that reviews an artifact **without seeing the
producer's chat context**. Its only inputs are:

- The artifact (file path or rendered output).
- The relevant supporting files (e.g., `HANDOFF.md`, `MASTER.html`, `check.md`,
  affected component source).
- A short brief explaining what the artifact is supposed to do and what to
  check against.

Its only output is a punch list: BLOCKING / CONCERNS / MINOR. Not approval.
The producer reads the punch list and decides what to fix.

The critic catches drift the producer can't see, by definition — it has no
prior context to drift from.

---

## When the critic is required (mandatory)

| Artifact | Rationale |
|----------|-----------|
| New ADR or ADR amendment | Decisions are durable; an undetected error compounds across every later session. |
| New SPEC document | The spec is the contract; if it's wrong, the code that follows it is wrong by construction. |
| Diff to deflation library (`src/lib/psr.ts`, `src/lib/cscv.ts`, `src/lib/hlzHaircut.ts`, `src/lib/sliceMetrics.ts`, `scripts/score_strategies.ts`, `src/lib/validator*.ts`) | These files compute the gates that decide promotion. A silent error here flips correct decisions. |
| Schema migration (CREATE / ALTER / migrate_*.ts) | Hard to undo. The frozen state needs to be inspected by fresh eyes. |
| MASTER.html edits | The architectural source of truth; edits propagate. |
| Diff > 200 lines touching multiple files | Large diffs hide drift. |

---

## When the critic is recommended (producer's call)

- Diffs 100–200 lines.
- New components in `src/lib/` (even outside the deflation set).
- Changes to backtest engine semantics (`indicators.ts`, `batch_backtest_worker.ts`).
- A diagnostic where the answer drives a fix that will land in code.

---

## When the critic is not needed

- Documentation polish (typos, formatting).
- Test additions to existing modules with stable interfaces.
- Renames / file moves that don't change behavior.
- Comments / dead-code removal.

---

## How to invoke

1. **Identify the artifact and its purpose.** One sentence each.
2. **Spawn the Agent.** Use `subagent_type: code-reviewer` for diffs;
   `subagent_type: general-purpose` for analysis docs / SPEC review / MASTER.
3. **Brief the agent self-contained.** It hasn't seen the conversation.
   Include: what the artifact is, what it's supposed to do, supporting files
   to read, and the relevant `check.md` entries to apply.
4. **Cap the report.** Ask for ≤ 600 words, three-bucket output (BLOCKING /
   CONCERNS / MINOR), no flattery.
5. **Read findings, decide what to fix.** BLOCKING is fixed before user-handoff.
   CONCERNS are case-by-case. MINOR can be deferred or ignored.

The standard prompt template lives in [§sample-prompt](#sample-prompt) below.

---

## Researcher agent (sibling)

Invoked when:

- The producer cited a paper or method but is uncertain about a specific claim.
- A canon citation is needed but the relevant chapter/section isn't in the
  producer's chat context.
- A Tier-3 source needs sanity-checking against a Tier-1 alternative.

**Use `subagent_type: general-purpose`.** Brief: name the claim, name the
source(s) to check, ask for a short summary with quote-able excerpts and
flagged uncertainty.

---

## Test-generator agent (sibling)

Invoked when a SPEC names edge cases. The producer:

1. Lists the edge cases in the SPEC.
2. Spawns the test-generator with the SPEC + the relevant module's interface.
3. Asks for unit tests covering each edge case before the CODE stage begins.
4. Reads the tests for sanity, commits them.
5. Implements the code; tests serve as the contract.

This is meta-labeling for the test suite: the SPEC is the primary "edge"; the
test-generator filters / amplifies which tests are worth writing.

**Use `subagent_type: general-purpose`** with the spec and module interface as input.

---

## What the critic does NOT do

- It does not approve or sign off. The producer ships; the user reviews at
  Tier 1 boundaries (per MASTER §4.3).
- It does not have authority over `check.md` content — it applies `check.md`,
  it does not author it.
- It does not iterate. One pass per artifact-version. If the artifact changes
  substantially after the punch list, re-invoke a fresh critic on the new version.

---

## Sample prompt for invoking the critic on a SPEC

```
You are the critic agent for the SignalForge project. Review the SPEC at
<path>. Do NOT read the producer's reasoning — only the artifact.

Supporting context to read:
- MASTER.html §<part> (the principle this SPEC implements)
- check.md (the project's self-correction checklist; apply relevant entries)
- HANDOFF.md (current project state)
- <affected component file(s)>

What the SPEC is supposed to do: <one sentence>

Apply: FR-01..03, ST-01..05, BT-01..06, ME-01..04 (and any others you judge
relevant). Cross-check internal consistency. Verify codebase-factual claims
(file paths, dependency versions, schema columns).

Output: ≤ 600 words, three buckets (BLOCKING / CONCERNS / MINOR). No
summary of what the SPEC does — assume I read it. Be direct. If a category
is empty, say "none". Do not flatter.
```

Adapt for code diffs, ADRs, and MASTER edits by changing the artifact and the
applicable check.md entries.

---

## What could break this

- The critic agent inherits Claude's training-time priors, which can be wrong
  about specific library versions or recent canon papers. Cross-check
  citation claims against the actual source files when stakes are high.
- The critic does not see the conversation — which means it cannot catch a
  user-aligned error (something the user explicitly approved but is wrong).
  That class of error needs the test-suite, not the critic.
- "Run a critic" can become a ritual that produces noise without insight if
  the brief is bad. Always brief self-contained; always ask for the
  three-bucket output; always cap word count.
