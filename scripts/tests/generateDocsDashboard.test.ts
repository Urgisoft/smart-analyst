/**
 * Tests for scripts/generate_docs_dashboard.ts — Quartz docs dashboard generator.
 *
 * Contract pinned here:
 *   - parseFrontmatter accepts the `---\n…---\n` head block produced by
 *     _apply_docs_frontmatter.ts:renderFrontmatter and returns each scalar field
 *     unquoted.
 *   - parseFrontmatter parses `depends_on:` as a block-sequence array (one `  -
 *     item` line per entry).
 *   - parseFrontmatter returns null when the file does NOT open with `---\n`
 *     (e.g. the vault's many docs with mid-document thematic-break `---` lines
 *     must NOT be misread as frontmatter).
 *   - extractTitle pulls the first H1 *after* the frontmatter block, not from
 *     inside it; falls back to the basename when no H1 exists.
 *   - groupBy sorts entries within each bucket by path for deterministic output.
 *   - renderDashboard emits "By status", "By type", "By phase" sections and an
 *     "Unclassified (no frontmatter)" bucket for files missing frontmatter.
 *   - End-to-end fixture corpus → expected markdown structure (status/type/phase
 *     groupings + frontmatter coverage line).
 *
 * No filesystem, no external deps — pure functions exercised against in-memory
 * fixtures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrontmatter,
  extractTitle,
  groupBy,
  renderDashboard,
  type DocEntry,
} from '../generate_docs_dashboard.js';

const FM_SAMPLE = `---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
slice_id: gap-7-event-driven-filings
---

# SPEC — Event-Driven Filings Processor

Body of the doc starts here.
`;

const FM_WITH_ARRAY = `---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
depends_on:
  - docs/obsidian/gaps/event-driven-filings-processor.md
  - docs/specs/macro-regime-classifier-phase1_v3.md
---

# Whatever
`;

const NO_FM = `# Plain Doc

Some content with a thematic break below.

---

More content.
`;

const NO_FM_NO_HEADING = `Just a paragraph, no heading at all.
Another line.
`;

describe('parseFrontmatter', () => {
  it('parses each scalar field of a complete frontmatter block', () => {
    const fm = parseFrontmatter(FM_SAMPLE);
    assert.ok(fm, 'expected non-null frontmatter');
    assert.equal(fm.status, 'active');
    assert.equal(fm.phase, 'phase 9+');
    assert.equal(fm.last_updated, '2026-05-21');
    assert.equal(fm.owner, 'pejman');
    assert.equal(fm.type, 'spec');
    assert.equal(fm.slice_id, 'gap-7-event-driven-filings');
    assert.equal(fm.depends_on, undefined);
  });

  it('parses depends_on as a block-sequence array', () => {
    const fm = parseFrontmatter(FM_WITH_ARRAY);
    assert.ok(fm, 'expected non-null frontmatter');
    assert.deepEqual(fm.depends_on, [
      'docs/obsidian/gaps/event-driven-filings-processor.md',
      'docs/specs/macro-regime-classifier-phase1_v3.md',
    ]);
  });

  it('returns null when the file has no opening --- delimiter', () => {
    assert.equal(parseFrontmatter(NO_FM), null);
  });

  it('returns null when the only --- lines are mid-document thematic breaks', () => {
    // NO_FM has a `---` on a line by itself but NOT at position 0; this is the
    // single most-common source of false positives in the vault (every spec doc
    // uses `---` as a section separator). Must not be misread as YAML frontmatter.
    const fm = parseFrontmatter(NO_FM);
    assert.equal(fm, null);
  });
});

describe('extractTitle', () => {
  it('pulls the first H1 after the frontmatter block', () => {
    assert.equal(extractTitle(FM_SAMPLE, 'fallback'), 'SPEC — Event-Driven Filings Processor');
  });

  it('falls back to the basename when no H1 exists', () => {
    assert.equal(extractTitle(NO_FM_NO_HEADING, 'fallback-slug'), 'fallback-slug');
  });
});

describe('groupBy', () => {
  it('buckets entries by key and sorts each bucket by path', () => {
    const entries: DocEntry[] = [
      { path: 'b.md', title: 'B', fm: { status: 'active' } },
      { path: 'a.md', title: 'A', fm: { status: 'active' } },
      { path: 'c.md', title: 'C', fm: { status: 'done' } },
    ];
    const grouped = groupBy(entries, e => e.fm?.status ?? null);
    assert.deepEqual(grouped.active.map(e => e.path), ['a.md', 'b.md']);
    assert.deepEqual(grouped.done.map(e => e.path), ['c.md']);
  });

  it('puts entries with no key into the __unclassified__ bucket', () => {
    const entries: DocEntry[] = [
      { path: 'a.md', title: 'A', fm: null },
      { path: 'b.md', title: 'B', fm: { status: 'active' } },
    ];
    const grouped = groupBy(entries, e => e.fm?.status ?? null);
    assert.deepEqual(grouped.__unclassified__.map(e => e.path), ['a.md']);
    assert.deepEqual(grouped.active.map(e => e.path), ['b.md']);
  });
});

describe('renderDashboard', () => {
  it('emits By status / By type / By phase sections', () => {
    const entries: DocEntry[] = [
      { path: 'specs/foo.md', title: 'Foo Spec', fm: { status: 'active', phase: 'phase 9+', type: 'spec', last_updated: '2026-05-21' } },
      { path: 'gaps/bar.md', title: 'Bar Gap',   fm: { status: 'done',   phase: 'phase 9+', type: 'gap',  last_updated: '2026-05-15' } },
    ];
    const md = renderDashboard(entries, '2026-05-21');
    assert.match(md, /## By status/);
    assert.match(md, /## By type/);
    assert.match(md, /## By phase/);
    assert.match(md, /### active \(1\)/);
    assert.match(md, /### done \(1\)/);
    assert.match(md, /### spec \(1\)/);
    assert.match(md, /### gap \(1\)/);
    assert.match(md, /### phase 9\+ \(2\)/);
  });

  it('surfaces unclassified docs under "Unclassified (no frontmatter)"', () => {
    const entries: DocEntry[] = [
      { path: 'a.md', title: 'A', fm: null },
      { path: 'b.md', title: 'B', fm: { status: 'active', phase: 'p1', type: 'spec' } },
    ];
    const md = renderDashboard(entries, '2026-05-21');
    assert.match(md, /### Unclassified \(no frontmatter\) \(1\)/);
    assert.match(md, /Frontmatter coverage: 1 \/ 2 \(50%\)/);
  });

  it('pins the generated-at date in the header and dashboard frontmatter', () => {
    const md = renderDashboard([], '2026-05-21');
    assert.match(md, /^---\nstatus: active\nphase: phase 9\+\nlast_updated: 2026-05-21\nowner: generator\ntype: index\n---\n/);
    assert.match(md, /Last regenerated: 2026-05-21/);
  });

  it('renders entries with slice_id as " _(slice: …)_" annotations', () => {
    const entries: DocEntry[] = [
      { path: 'specs/foo.md', title: 'Foo', fm: { status: 'active', type: 'spec', phase: 'p1', slice_id: 'adr-041' } },
    ];
    const md = renderDashboard(entries, '2026-05-21');
    assert.match(md, /_\(slice: adr-041\)_/);
  });
});
