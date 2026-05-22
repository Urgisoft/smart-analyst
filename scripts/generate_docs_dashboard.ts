/**
 * Build-time generator that turns the vault's per-doc frontmatter into a single
 * status dashboard at `docs/dashboard.md`. Invoked from `npm run docs:build`
 * before Quartz runs, so the rendered site always shows fresh state.
 *
 * NEVER hand-edit `docs/dashboard.md` — it gets rewritten on every build. The
 * source of truth is each doc's own frontmatter (see scripts/_apply_docs_frontmatter.ts
 * for the rollout tool + schema). Files without frontmatter are listed under
 * "Unclassified" so the operator can see drift.
 *
 * Schema parsed (per S95-21):
 *   status / phase / last_updated / owner / type / [slice_id] / [depends_on]
 *
 * The generator does deliberately-shallow YAML parsing: it only handles the
 * scalar fields and the single `depends_on:` array form (one indented `- item`
 * line per entry). The vault's frontmatter is hand-written under that constraint
 * (see _apply_docs_frontmatter.ts:renderFrontmatter) so the parser stays small
 * and explainable. Anything richer (anchors, nested maps) is out of scope.
 *
 * Exports `parseFrontmatter`, `loadDocs`, `groupBy`, `renderDashboard` for
 * fixture testing (scripts/tests/generateDocsDashboard.test.ts). Side-effect-free
 * unless run as the main module.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'docs:dashboard',
    category: 'Server / build',
    what: 'Regenerate docs/dashboard.md from per-doc YAML frontmatter. Run automatically as a pre-step inside docs:build / docs:serve; expose as a standalone alias for incremental regeneration without invoking Quartz.',
  },
];

export interface DocFrontmatter {
  status?: string;
  phase?: string;
  last_updated?: string;
  owner?: string;
  type?: string;
  slice_id?: string;
  depends_on?: string[];
}

export interface DocEntry {
  /** Vault-relative path, forward-slashes, no leading `./`. */
  path: string;
  /** Title — pulled from the first `# Heading` after frontmatter, or basename fallback. */
  title: string;
  /** Parsed frontmatter, or `null` if the file has no YAML head block. */
  fm: DocFrontmatter | null;
}

/** Pull a YAML frontmatter block from the head of a Markdown file. Returns parsed
 *  scalars + the single supported array (`depends_on:`); returns `null` if the file
 *  does not start with `---\n` or `---\r\n`. Returns the partial map even if some
 *  scalars are absent so the renderer can flag "missing field" drift. */
export function parseFrontmatter(raw: string): DocFrontmatter | null {
  // Reject anything that doesn't open with the YAML delimiter. The frontmatter rollout
  // tool prepends `---\n`; Quartz's gray-matter accepts CRLF too so we mirror that.
  const opener = raw.startsWith('---\r\n') ? '---\r\n' : raw.startsWith('---\n') ? '---\n' : null;
  if (!opener) return null;

  const afterOpener = raw.slice(opener.length);
  const closerNewline = opener === '---\r\n' ? '\r\n' : '\n';
  const closerMarker = '---' + closerNewline;
  const closerLooseMarker = '---\n'; // tolerate mixed line endings in hand-edited blocks
  let closerIdx = afterOpener.indexOf(closerMarker);
  if (closerIdx < 0) closerIdx = afterOpener.indexOf(closerLooseMarker);
  if (closerIdx < 0) return null;

  const block = afterOpener.slice(0, closerIdx);
  const fm: DocFrontmatter = {};
  const lines = block.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) {
      i += 1;
      continue;
    }
    const scalarMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (scalarMatch) {
      const key = scalarMatch[1];
      const value = scalarMatch[2];
      if (value === '' && i + 1 < lines.length && /^\s+- /.test(lines[i + 1])) {
        // Block sequence (e.g. `depends_on:` followed by `  - item` lines).
        const arr: string[] = [];
        let j = i + 1;
        while (j < lines.length && /^\s+- /.test(lines[j])) {
          arr.push(lines[j].replace(/^\s+- /, '').trim());
          j += 1;
        }
        // Only the keys explicitly listed in DocFrontmatter are honored. Block-sequence is
        // currently scoped to depends_on; unknown array keys are silently dropped (the
        // schema is closed by design).
        if (key === 'depends_on') fm.depends_on = arr;
        i = j;
        continue;
      }
      const unquoted = value.replace(/^['"]|['"]$/g, '');
      switch (key) {
        case 'status':       fm.status = unquoted; break;
        case 'phase':        fm.phase = unquoted; break;
        case 'last_updated': fm.last_updated = unquoted; break;
        case 'owner':        fm.owner = unquoted; break;
        case 'type':         fm.type = unquoted; break;
        case 'slice_id':     fm.slice_id = unquoted; break;
      }
    }
    i += 1;
  }
  return fm;
}

/** Pull the first level-1 heading after the (possibly absent) frontmatter block.
 *  Falls back to the file basename (sans `.md`) when the body has no `# Heading`. */
export function extractTitle(raw: string, fallbackBasename: string): string {
  let body = raw;
  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const opener = raw.startsWith('---\r\n') ? '---\r\n' : '---\n';
    const closerNewline = opener === '---\r\n' ? '\r\n' : '\n';
    const closerMarker = '---' + closerNewline;
    const idx = raw.indexOf(closerMarker, opener.length);
    if (idx >= 0) body = raw.slice(idx + closerMarker.length);
  }
  const m = body.match(/^[ \t]*#\s+(.+)$/m);
  return m ? m[1].trim() : fallbackBasename;
}

/** Walk a directory tree, returning vault-relative POSIX-style paths of `.md` files.
 *  Skips the Quartz build output dir + any dotfile dirs to avoid stale `.quartz-site`
 *  output bleeding into the dashboard. Excludes the dashboard file itself (the
 *  generator's own output) so re-runs are idempotent. */
export function walkMarkdown(rootAbs: string, vaultRel: string = ''): string[] {
  const out: string[] = [];
  const here = vaultRel === '' ? rootAbs : path.join(rootAbs, vaultRel);
  for (const name of readdirSync(here)) {
    if (name.startsWith('.')) continue;        // .quartz-site, .obsidian, etc.
    if (name === 'dashboard.md' && vaultRel === '') continue;  // skip generator's own output
    const abs = path.join(here, name);
    const rel = vaultRel === '' ? name : `${vaultRel}/${name}`;
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(rootAbs, rel));
    } else if (st.isFile() && name.endsWith('.md')) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out;
}

export function loadDocs(rootAbs: string): DocEntry[] {
  const files = walkMarkdown(rootAbs);
  const entries: DocEntry[] = [];
  for (const rel of files) {
    const abs = path.join(rootAbs, rel);
    const raw = readFileSync(abs, 'utf8');
    const fm = parseFrontmatter(raw);
    const basename = path.basename(rel, '.md');
    const title = extractTitle(raw, basename);
    entries.push({ path: rel, title, fm });
  }
  return entries;
}

/** Generic grouping helper — buckets `entries` by `keyOf(entry)`. Entries where
 *  `keyOf` returns `null` go into the special `__unclassified__` bucket so the
 *  renderer can surface them as a drift warning. */
export function groupBy<T>(entries: T[], keyOf: (e: T) => string | null): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const e of entries) {
    const k = keyOf(e) ?? '__unclassified__';
    if (!out[k]) out[k] = [];
    out[k].push(e);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => {
      const ap = (a as unknown as DocEntry).path;
      const bp = (b as unknown as DocEntry).path;
      return ap.localeCompare(bp);
    });
  }
  return out;
}

const STATUS_ORDER = ['active', 'accepted', 'research', 'proposed', 'draft', 'done', 'partially-superseded', 'superseded', 'paused', 'deferred', '__unclassified__'];
const TYPE_ORDER   = ['index', 'architecture', 'spec', 'adr', 'gap', 'review', 'recap', 'analysis', 'experiment', 'glossary', 'teach', '__unclassified__'];

function renderEntry(e: DocEntry, generatedAt: string): string {
  const fm = e.fm ?? {};
  const slice = fm.slice_id ? ` _(slice: ${fm.slice_id})_` : '';
  const phase = fm.phase ? ` · phase: ${fm.phase}` : '';
  const updated = fm.last_updated ? ` · updated: ${fm.last_updated}` : '';
  return `- [${e.title}](${e.path})${slice}${phase}${updated}`;
}

/** Render the dashboard markdown. Sections: by status (active first), by type, by
 *  phase, then an "Unclassified" block. `generatedAt` is exposed so tests can pin
 *  a deterministic timestamp. */
export function renderDashboard(entries: DocEntry[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('status: active');
  lines.push('phase: phase 9+');
  lines.push(`last_updated: ${generatedAt}`);
  lines.push('owner: generator');
  lines.push('type: index');
  lines.push('---');
  lines.push('');
  lines.push('# SignalForge — Status Dashboard');
  lines.push('');
  lines.push(`> AUTO-GENERATED by \`scripts/generate_docs_dashboard.ts\` on \`npm run docs:build\` — do NOT hand-edit. The source of truth is each doc's own YAML frontmatter. Last regenerated: ${generatedAt}.`);
  lines.push('');
  lines.push(`Total docs scanned: ${entries.length}. Frontmatter coverage: ${entries.filter(e => e.fm).length} / ${entries.length} (${Math.round((entries.filter(e => e.fm).length / entries.length) * 100)}%).`);
  lines.push('');

  // ───────── By status ─────────
  lines.push('## By status');
  lines.push('');
  const byStatus = groupBy(entries, e => e.fm?.status ?? null);
  for (const status of STATUS_ORDER) {
    const items = byStatus[status];
    if (!items || items.length === 0) continue;
    const label = status === '__unclassified__' ? 'Unclassified (no frontmatter)' : status;
    lines.push(`### ${label} (${items.length})`);
    lines.push('');
    for (const e of items) lines.push(renderEntry(e, generatedAt));
    lines.push('');
  }

  // ───────── By type ─────────
  lines.push('## By type');
  lines.push('');
  const byType = groupBy(entries.filter(e => e.fm), e => e.fm?.type ?? null);
  for (const t of TYPE_ORDER) {
    const items = byType[t];
    if (!items || items.length === 0) continue;
    if (t === '__unclassified__') continue;  // already covered above
    lines.push(`### ${t} (${items.length})`);
    lines.push('');
    for (const e of items) lines.push(renderEntry(e, generatedAt));
    lines.push('');
  }

  // ───────── By phase ─────────
  lines.push('## By phase');
  lines.push('');
  const byPhase = groupBy(entries.filter(e => e.fm), e => e.fm?.phase ?? null);
  const phases = Object.keys(byPhase).filter(p => p !== '__unclassified__').sort();
  for (const p of phases) {
    const items = byPhase[p];
    lines.push(`### ${p} (${items.length})`);
    lines.push('');
    for (const e of items) lines.push(renderEntry(e, generatedAt));
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const docsRoot = path.join(repoRoot, 'docs');
  const generatedAt = new Date().toISOString().slice(0, 10);

  const entries = loadDocs(docsRoot);
  const md = renderDashboard(entries, generatedAt);
  const out = path.join(docsRoot, 'dashboard.md');
  writeFileSync(out, md, 'utf8');

  const withFm = entries.filter(e => e.fm).length;
  console.log(`generate_docs_dashboard: wrote ${out}`);
  console.log(`  scanned: ${entries.length} docs · frontmatter: ${withFm}/${entries.length}`);
}

if (isMain(import.meta.url)) main();
