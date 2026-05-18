# `<component-name>` — `<one-line description>`

> **Path:** `<src/lib/...>` · **Doc updated:** YYYY-MM-DD · **Last touching ADR:** [ADR-NNN](../decisions/README.md#adr-nnn) · **Status:** ✅ current / ⚠️ stale / 🆕 planned

---

## What it does

One paragraph in plain language. What is this for? What does it produce that
nothing else produces? If a sister component does almost the same thing,
explain the distinction.

## Where it sits in the system

Visual — dependencies + data flow. Use a small SVG diagram (matching the
MASTER.html style: `#1c2128` panel, `#56d4dd` accent for this layer's color).
Show:

- What it reads from (CH tables, other modules).
- What it writes to (CH tables, return values).
- What invokes it (server route, sweep orchestrator, validator).

If the component is a pure function library, the diagram is its call graph.

## Interface

```ts
// Public exports — copy from the source file.
export function exampleFn(input: InputType): OutputType;
```

For each public export:

- **Inputs:** what they mean, valid ranges, what happens at the edges.
- **Outputs:** structure, units (if numerical), sentinel values (if any) and
  what they mean.
- **Side effects:** none, ideally. If non-pure (writes to CH, mutates global
  state), call it out.

## Configuration knobs

| Knob | Type | Default | Purpose |
|------|------|---------|---------|
| ... | ... | ... | ... |

## Failure modes / "what could break this"

The most important section. Bullet list of things that have failed, could
fail, or are subtle:

- **Subtlety 1.** What it is, why it's subtle, how to detect it. Reference
  the relevant `check.md` entry (e.g., `ST-02b`).
- **Subtlety 2.** Same.
- **Known regression area.** If this component has a history of regressions,
  name them (with commit hashes when meaningful).

## Tests

| Test file | Covers |
|-----------|--------|
| `scripts/tests/<name>.test.ts` | ... |

If there's a positive control (synthetic data with known answer), name it
explicitly — those are the highest-trust tests for deflation modules.

## Dependencies

- **Library deps:** `<package>` from `package.json`. Why this one (per
  ADR-002 library-first principle).
- **Internal deps:** other modules this calls.
- **Data deps:** CH tables / views read or written.

## Recent history

Links to the last 3 ADRs that affected this component, in reverse chronological
order. (Only the last 3 — older history lives in git log + the ADR index.)

## When to update this doc

- Interface changed.
- Configuration knob added / removed / default changed.
- New failure mode discovered (corresponding `check.md` entry added).
- ADR amended the component's contract.
- Test coverage materially changed (new positive control, new edge case).

When NOT to update this doc:

- Routine bug fix without interface change.
- Refactor that preserves behavior.
- Comment / formatting changes.
- Test additions that pin existing behavior.

## What this doc is NOT

- Not the source of truth for behavior — the source file is.
- Not a tutorial — it assumes the reader knows the project.
- Not a changelog — git is.
