# Quartz vendor-fork upgrade procedure

**Status:** Active procedure.
**Last updated:** 2026-05-23 (session 96 #17 Cycle 5 — closes audit gaps
GAP-13 + GAP-19 per `docs/audits/system-reconciliation-2026-05.md`).
**Owner:** Infra worker (per `docs/architecture/multi-agent-orchestration.md` §1).
**Cadence:** Run when bumping the vendored Quartz tree to a new upstream
release, OR after any `git pull` of upstream Quartz into `quartz/`.

---

## Why this document exists

SignalForge vendors `jackyzha0/quartz` in-tree under `quartz/` to render
the docs site (`npm run docs:build` / `docs:serve`). Two local patches
have been applied on top of upstream that **do not exist upstream** and
must be re-applied on every upgrade. Without this procedure, a routine
`git pull` of upstream regresses both patches silently:

- Patch 1 silently regressing → `/dashboard` returns 404 in the docs
  site (the symptom that originally triggered the patch in s96 #10).
- Patch 2 silently regressing → ~60 per-experiment `.log` files leak
  into the published site as static assets (low-severity noise but
  visible-to-operator drift).

Both are silent — neither triggers a build error, a test failure, or a
runtime exception. The only failure surface is operator-visual (a 404
page, or extra files in the site index). That is the worst category of
drift (no automated signal), which is why this procedure is mandatory
before declaring any Quartz upgrade complete.

---

## Vendored version + upstream source

| Field | Value |
| --- | --- |
| Upstream repo | https://github.com/jackyzha0/quartz |
| Upstream license | MIT |
| Currently vendored version | **4.5.2** (per `quartz/package.json` `version` field) |
| Vendored at | session 95 #6, commit `437332b` |
| Patches applied at | session 96 #10, commit `ef53155` (both patches landed together) |
| Vendor root | `quartz/` (sibling of `docs/`, `scripts/`, `src/`) |
| Build script | `quartz/package.json` `signalforge:build` / `signalforge:serve` |
| npm wrappers in root | `npm run docs:build`, `npm run docs:serve`, `npm run docs:install` |

Both upstream-divergent patches are intentionally inline-commented in
the vendored files with the `SignalForge vendor patch (s96 #10):`
sentinel string. A grep for that sentinel lists every divergent point.

---

## Patch inventory

### Patch 1 — `gitignore: false` in the glob driver

**File:** `quartz/quartz/util/glob.ts`
**Line region:** the `glob` function's `globby(...)` call (lines 14–28
as of 4.5.2; line numbers may drift on upgrade — match by surrounding
context, not absolute line).
**Upstream default:** `gitignore: true` (i.e., the option is omitted or
explicitly `true`, which makes globby honor `.gitignore`).
**SignalForge value:** `gitignore: false` (the option is explicitly set
to `false`).

**Verbatim current patched code (the inline comment is the source of
truth — preserve it verbatim across upgrades):**

```ts
const fps = (
  await globby(pattern, {
    cwd,
    ignore: ignorePatterns,
    // SignalForge vendor patch (s96 #10): set to `false` (upstream default
    // is `true`). Upstream relies on `.gitignore` to filter scan inputs —
    // which silently drops auto-generated build artifacts that ARE meant
    // to be ingested by Quartz but should NOT be committed (e.g.
    // `docs/dashboard.md`, regenerated on every `npm run docs:build`).
    // Quartz's own `ignorePatterns` config in `quartz.config.ts` already
    // enumerates the deliberate exclusions; honoring gitignore on top of
    // it was a foot-gun masking real content as 404.
    gitignore: false,
  })
).map(toPosixPath)
```

**Why it's needed:** `scripts/generate_docs_dashboard.ts` (s95 #6
design) emits `docs/dashboard.md` on every `npm run docs:build` and is
deliberately gitignored to avoid build-output churn in commits.
Upstream Quartz with `gitignore: true` honors that .gitignore entry
and silently drops the file from the scan. ContentPage never sees the
file, no `.html` is emitted, and `/dashboard` returns 404. Flipping to
`gitignore: false` makes globby ignore `.gitignore` entirely; Quartz's
own `ignorePatterns` in `quartz.config.ts` then becomes the sole
filter (which is what the design intends).

**Why upstream won't accept this as a PR (and why we keep vendoring):**
The Quartz project's design philosophy is "your notes folder IS your
.gitignore-governed working tree." SignalForge inverts that: our
`docs/` is a mix of committed canon + auto-generated artifacts that
must not be committed. Upstream's default is correct for the
note-publishing use case; the project-specific patch is correct for
our docs-as-build-output use case. The patch is not upstream-able.

### Patch 2 — `**/*.log` in `ignorePatterns`

**File:** `quartz/quartz.config.ts`
**Field:** `configuration.ignorePatterns` array.
**SignalForge value:** the array contains the string `"**/*.log"`
**immediately after** the `"phase1_breadth_restoration"` entry, with
the inline comment preserved.

**Verbatim current patched code:**

```ts
ignorePatterns: [
  "private",
  "templates",
  ".obsidian",
  ".quartz-site",
  "fixtures",
  "phase2_procedure_artifacts",
  "phase2_rv5d_diagnostic",
  "phase1_breadth_restoration",
  // SignalForge (s96 #10) — block per-experiment build logs from being
  // copied into the site as static assets. Required after we flipped
  // util/glob.ts to `gitignore: false` (so dashboard.md ingests), which
  // also un-hid the gitignored experiment .log files. ~60 small files;
  // harmless individually, noise in aggregate.
  "**/*.log",
],
```

**Why it's needed:** Patch 1 (above) flips `gitignore: false`, which
disables `.gitignore` filtering globally inside Quartz. That correctly
un-hides `docs/dashboard.md` — but also un-hides the ~60 gitignored
`.log` files that `docs/experiments/**/*` ships per experiment run.
Without this exclusion, those `.log` files get copied verbatim into
the published static site as assets. Adding `**/*.log` to
`ignorePatterns` restores the exclusion through Quartz's own filter
instead of through `.gitignore`.

**Why this isn't upstream-able either:** This patch is a direct
consequence of Patch 1 — only relevant in projects that flipped
`gitignore: false`. Upstream users on the default `gitignore: true`
never have this problem.

### Sentinel for grep verification

Both patches carry the literal comment marker `SignalForge vendor
patch (s96` (Patch 1) or `SignalForge (s96` (Patch 2). A single grep
locates every divergent point post-upgrade:

```powershell
Select-String -Path "quartz\quartz.config.ts","quartz\quartz\util\glob.ts" -Pattern "SignalForge"
```

```bash
grep -n "SignalForge" quartz/quartz.config.ts quartz/quartz/util/glob.ts
```

Both files **must** match. Zero matches in either file = a patch
regressed; halt the upgrade and re-apply.

---

## Upgrade procedure

Use this procedure when bumping the vendored Quartz to a new upstream
version. The procedure is **non-skippable**: every numbered step has a
verification clause that must pass before the next step.

### Step 0 — Pre-flight (commit boundary)

Before touching `quartz/`, commit any pending local work. The upgrade
is a destructive overlay; un-committed work in `quartz/` will be lost.

```powershell
git status                  # confirm clean working tree (or commit pending work first)
git log -1 --stat           # confirm last commit is your own, not a stale merge head
```

### Step 1 — Record the pre-upgrade baseline

Snapshot the current vendored version + patch state.

```powershell
# 1a. Record the current version (commit this snapshot value below in the
#     post-upgrade § Verification block's expected output).
Get-Content quartz\package.json | Select-String -Pattern '"version"'

# 1b. Record the current patch sentinel line counts (should be: at least
#     1 hit in each of the two files).
Select-String -Path "quartz\quartz.config.ts","quartz\quartz\util\glob.ts" -Pattern "SignalForge" | Measure-Object | Select-Object -ExpandProperty Count
```

If 1b returns < 2, the patches are already missing pre-upgrade and
this procedure is being run as a recovery (skip step 2; jump to
step 4 "Re-apply patches").

### Step 2 — Overlay the upstream release

Two acceptable methods. Pick one.

**Method A — fresh tarball overlay (preferred; works without git
remote tracking of upstream):**

1. Download the tarball or `git clone --depth 1 --branch v<X.Y.Z>
   https://github.com/jackyzha0/quartz.git /tmp/quartz-<X.Y.Z>`.
2. Delete every tracked file under `quartz/` EXCEPT `quartz/node_modules/`
   (preserving node_modules avoids a forced reinstall; if dependencies
   changed in upstream's `package.json`, npm install in step 3 will
   reconcile).
3. Copy `/tmp/quartz-<X.Y.Z>/*` (excluding `.git`, `.github`, and
   `node_modules`) into `quartz/`.

**Method B — git subtree pull (only if `quartz/` was vendored as a
subtree, which it currently is NOT in SignalForge; documented here
only for completeness).** Not supported by the current vendor
structure; would require re-vendoring with `git subtree add` first.

### Step 3 — Reinstall dependencies

```powershell
npm run docs:install
```

This wraps `cd quartz; npm install` and idempotently reconciles any
upstream-introduced dep changes. Should complete without error. If it
errors with peer-dep conflicts, halt — those are real upstream
changes that need investigation, not a routine upgrade.

### Step 4 — Re-apply the two patches

Both patches must be re-applied verbatim, including their inline
comments. The comments themselves are part of the contract — they
are the sentinel grep targets that step 5 verifies.

**Patch 1:** Open `quartz/quartz/util/glob.ts`. Locate the `glob`
function's `globby(pattern, { ... })` call. Add the `gitignore: false`
key + the inline `SignalForge vendor patch (s96 #10):` comment block
exactly as documented in § Patch inventory above. The full options
object after patching must contain:

- `cwd`
- `ignore: ignorePatterns`
- (the comment block)
- `gitignore: false`

**Patch 2:** Open `quartz/quartz.config.ts`. Locate the
`configuration.ignorePatterns` array. Append the inline `SignalForge
(s96 #10)` comment block + the `"**/*.log"` entry exactly as
documented in § Patch inventory above. Order matters only insofar as
the comment must immediately precede the `"**/*.log"` entry; other
entries' order is preserved.

### Step 5 — Verify

Run the full verification block. Every check must pass before
declaring the upgrade complete.

```powershell
# 5a. Sentinel grep — both files must have at least one "SignalForge" hit.
Select-String -Path "quartz\quartz.config.ts","quartz\quartz\util\glob.ts" -Pattern "SignalForge"

# 5b. Patch 1 literal value present.
Select-String -Path "quartz\quartz\util\glob.ts" -Pattern "gitignore: false"

# 5c. Patch 2 literal value present.
Select-String -Path "quartz\quartz.config.ts" -Pattern '"\*\*/\*\.log"'

# 5d. Build succeeds.
npm run docs:build

# 5e. Serve + smoke-test the previously-broken route.
npm run docs:serve   # background; opens on http://localhost:8080
# Then in a browser: navigate to http://localhost:8080/dashboard
# Expected: dashboard renders. 404 = Patch 1 regressed.

# 5f. Confirm no .log files leaked into the published site.
Get-ChildItem -Path docs\.quartz-site -Recurse -Filter "*.log" | Measure-Object | Select-Object -ExpandProperty Count
# Expected: 0. Non-zero = Patch 2 regressed.

# 5g. Tsc baseline holds for the parent project (the vendor tree has its
#     own tsconfig that is NOT covered by the root tsc baseline; confirm
#     by checking the root project tsc count is unchanged).
npx tsc --noEmit
# Expected: same error count as pre-upgrade (currently the 13-error
# baseline noted in HANDOFF.md s96 #17 Cycle 4 close).
```

Bash equivalents:

```bash
# 5a
grep -n "SignalForge" quartz/quartz.config.ts quartz/quartz/util/glob.ts
# 5b
grep -n "gitignore: false" quartz/quartz/util/glob.ts
# 5c
grep -n '"\*\*/\*\.log"' quartz/quartz.config.ts
# 5d
npm run docs:build
# 5e (smoke test)
npm run docs:serve   # then browse http://localhost:8080/dashboard
# 5f
find docs/.quartz-site -name "*.log" | wc -l   # expect 0
# 5g
npx tsc --noEmit                              # expect baseline unchanged
```

### Step 6 — Commit + update this document

If verification passes:

1. Commit the upgrade: `git add quartz/ && git commit -m "s<NN> #N:
   Quartz vendor upgrade — v<X.Y.Z>; patches re-applied"`.
2. Update this document's `Currently vendored version` row in §
   Vendored version + upstream source.
3. Update HANDOFF.md with the upgrade as a lock-in row.

If verification fails on any 5a–5g check: do NOT commit. Revert the
working tree (`git checkout -- quartz/` if the pre-upgrade state was
the last commit; otherwise restore from the snapshot in step 1) and
investigate. The most likely failure is an upstream refactor that
moved the `globby(...)` call to a different file — re-locate the
call site, re-apply Patch 1, re-verify.

---

## What to do on patch-region conflicts

If upstream restructured either patched region (e.g., the `glob.ts`
function was split into multiple files; the `quartz.config.ts`
example moved `ignorePatterns` to a sub-config), the patches do not
apply mechanically. Procedure:

1. **For Patch 1 (`gitignore: false`):** Search the upgraded vendor
   tree for `globby(` calls in `quartz/quartz/util/**` first, then
   broader `quartz/quartz/**`. The patch belongs at the single
   call site that drives the content-scan pass (the one called from
   the main build pipeline; not test fixtures or auxiliary scripts).
   If upstream introduced a wrapper config that already accepts a
   `gitignore` flag, prefer setting it via that wrapper rather than
   editing the call site — easier to maintain across future upgrades.

2. **For Patch 2 (`**/*.log` in `ignorePatterns`):** The
   `ignorePatterns` field is a stable Quartz config-API surface
   (called out in `https://quartz.jzhao.xyz/configuration`); it is
   unlikely to disappear. If it has been renamed (e.g. to
   `excludePatterns`), apply the rename with the same `**/*.log`
   value.

3. **Either patch fundamentally obsolete:** If upstream natively
   solves the underlying problem (e.g., a new upstream option
   `gitignore: 'inherit-but-allow-explicit-includes'` that obviates
   Patch 1), document the obsoletion in this file's § Patch
   inventory + delete the local patch + cite the upstream change
   that obsoletes it. Future upgrades then skip that patch's
   re-application.

---

## Alternative — CI-enforced grep test (not yet implemented)

The audit (GAP-13) flagged a second option to this procedure: instead
of a manual document, add a CI test that grep-asserts both patches
exist after any change touching `quartz/`. Per orchestration §6.4 the
choice between the two is the orchestration's; this Cycle 5 ships the
document because:

- No CI exists yet (GAP-10 deferred to Cycle 8 per orchestration §8.4).
- A grep test alone wouldn't catch the silent `/dashboard` 404 — it
  would catch a regressed patch BEFORE the regression hits prod, but
  not a *correct-syntax-but-wrong-effect* drift (e.g., upstream
  refactors `globby` to a new caller and Patch 1 still grep-matches
  the dead old code path).
- The browser smoke-test in Step 5e is the actual canonical signal
  for Patch 1; the grep is a fast-fail upstream of the smoke-test.

When `.github/workflows/ci.yml` lands in Cycle 8, the grep can be
added as a fast pre-step to the docs-build job:

```yaml
- name: SignalForge vendor patch presence
  run: |
    grep -q "gitignore: false" quartz/quartz/util/glob.ts
    grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts
```

Until then, this procedure document is the canonical guard.

---

## Cross-references

- `docs/audits/system-reconciliation-2026-05.md` GAP-13 + GAP-19 —
  origin of this procedure.
- `docs/architecture/multi-agent-orchestration.md` §1 (Infra domain
  owns this file), §6.4 (procedure-vs-CI-test was an orchestration
  decision, not an operator-queue trigger), §8.4 (Cycle 5 first
  item).
- Commit `ef53155` (session 96 #10) — both patches' original landing.
- Commit `437332b` (session 95 #6) — initial vendor install.
- `quartz/package.json` — current vendored version (4.5.2).
