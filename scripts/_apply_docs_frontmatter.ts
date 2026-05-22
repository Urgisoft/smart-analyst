/**
 * One-shot frontmatter rollout for SignalForge's priority Markdown docs.
 *
 * Run with `npx tsx scripts/_apply_docs_frontmatter.ts`. Idempotent: if a target
 * file already starts with `---\n` (YAML frontmatter delimiter) the entry is left
 * alone; otherwise the frontmatter block is prepended verbatim. Re-running after
 * adding more entries is safe — existing ones won't be touched.
 *
 * Frontmatter schema (per s95 #4 architecture, S95-21):
 *   - status       (required) — active | accepted | superseded | partially-superseded
 *                                proposed | draft | done | paused | deferred | research
 *   - phase        (required) — free-form lifecycle tag (e.g. "phase1_v3", "phase 9+", "Phase B")
 *   - last_updated (required) — ISO date YYYY-MM-DD
 *   - owner        (required) — string (single-operator project = "pejman")
 *   - type         (required) — adr | spec | gap | teach | recap | review | experiment
 *                                glossary | architecture | analysis | index
 *   - slice_id     (optional) — anchor for the dashboard (e.g. "gap-7-form4-v2", "adr-041")
 *   - depends_on   (optional) — array of vault-relative paths
 *
 * The auto-generated docs dashboard (scripts/generate_docs_dashboard.ts, commit 3
 * of this slice) reads these fields. Files without frontmatter are listed under
 * "unclassified" and surfaced as a drift warning.
 *
 * `_`-prefixed so help.ts's auto-discovery skips it (this is operator-only tooling,
 * not part of the standard daemon/ingest/backtest surface). One-shot: after the
 * initial rollout, frontmatter is hand-maintained per-doc.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Frontmatter {
  status: 'active' | 'accepted' | 'superseded' | 'partially-superseded' | 'proposed' | 'draft' | 'done' | 'paused' | 'deferred' | 'research';
  phase: string;
  last_updated: string;
  owner: string;
  type: 'adr' | 'spec' | 'gap' | 'teach' | 'recap' | 'review' | 'experiment' | 'glossary' | 'architecture' | 'analysis' | 'index';
  slice_id?: string;
  depends_on?: string[];
}

interface Entry {
  file: string;
  fm: Frontmatter;
}

const TODAY = '2026-05-21';
const OWNER = 'pejman';

/** ~50 priority docs across architecture / gaps / specs / ADRs / recaps. The vault has
 *  ~114 markdown files; this set covers the load-bearing ones that the dashboard surfaces
 *  in its "Active phase / gaps" view. Files outside this list (teach docs, phase artifacts,
 *  symbol-analysis worksheets) get frontmatter later as needed. */
const ENTRIES: Entry[] = [
  // ───────── Core architecture (obsidian vault root) ─────────
  { file: 'docs/obsidian/README.md',                     fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'index' } },
  { file: 'docs/obsidian/_Index.md',                     fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'index' } },
  { file: 'docs/obsidian/01 - Data Ingestion.md',        fm: { status: 'active', phase: 'phase 1', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/02 - Storage (ClickHouse).md',  fm: { status: 'active', phase: 'phase 1', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/03 - Backtest Engine.md',       fm: { status: 'active', phase: 'phase 2', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/04 - Regime Classifier (phase1_v3).md', fm: { status: 'active', phase: 'phase1_v3', last_updated: TODAY, owner: OWNER, type: 'architecture', slice_id: 'adr-041' } },
  { file: 'docs/obsidian/05 - Trade Execution Pipeline.md', fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/06 - Daemon (daily cadence).md', fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/07 - Paper Trading & Monitoring.md', fm: { status: 'active', phase: 'Phase B', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/08 - Dashboard UI.md',          fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/obsidian/99 - Glossary.md',              fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'glossary' } },

  // ───────── Gaps tracking ─────────
  { file: 'docs/obsidian/gaps/README.md',                              fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'index' } },
  { file: 'docs/obsidian/gaps/capital-deployment-ramp.md',             fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-5-capital-deployment-ramp' } },
  { file: 'docs/obsidian/gaps/cross-asset-signals.md',                 fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-cross-asset' } },
  { file: 'docs/obsidian/gaps/cross-strategy-correlation.md',          fm: { status: 'deferred', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap' } },
  { file: 'docs/obsidian/gaps/drawdown-response-framework.md',         fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap' } },
  { file: 'docs/obsidian/gaps/earnings-calendar-integration.md',       fm: { status: 'deferred', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap' } },
  { file: 'docs/obsidian/gaps/etf-flow-monitoring.md',                 fm: { status: 'done',     phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-9-etf-flow' } },
  { file: 'docs/obsidian/gaps/event-driven-filings-processor.md',      fm: { status: 'partially-superseded', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-7-event-driven-filings' } },
  { file: 'docs/obsidian/gaps/executive-departure-signal.md',          fm: { status: 'done',     phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-8-executive-departure' } },
  { file: 'docs/obsidian/gaps/expanded-vol-structure.md',              fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-expanded-vol-structure' } },
  { file: 'docs/obsidian/gaps/market-cycle-position.md',               fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'adr-041' } },
  { file: 'docs/obsidian/gaps/sector-rotation-monitoring.md',          fm: { status: 'active',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-sector-rotation' } },
  { file: 'docs/obsidian/gaps/short-interest-tracking.md',             fm: { status: 'done',     phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap', slice_id: 'gap-10-short-interest' } },
  { file: 'docs/obsidian/gaps/strategy-demotion.md',                   fm: { status: 'deferred', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'gap' } },

  // ───────── ADRs + decisions index ─────────
  { file: 'docs/decisions/README.md',                                  fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'index' } },
  { file: 'docs/specs/adr-017-meta-labeling.md',                       fm: { status: 'deferred', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'adr', slice_id: 'adr-017' } },
  { file: 'docs/specs/adr-040-correlation-weighted-allocation-research.md', fm: { status: 'research', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'adr', slice_id: 'adr-040' } },
  { file: 'docs/specs/adr-042-gics-sector-baseline-computation-research.md', fm: { status: 'accepted', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'adr', slice_id: 'adr-042' } },

  // ───────── Core specs ─────────
  { file: 'docs/specs/macro-regime-classifier-phase1_v3.md',           fm: { status: 'partially-superseded', phase: 'phase1_v3', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'adr-041' } },
  { file: 'docs/specs/macro-regime-classifier-phase2.md',              fm: { status: 'active', phase: 'phase 2', last_updated: TODAY, owner: OWNER, type: 'spec' } },
  { file: 'docs/specs/event-driven-filings-processor.md',              fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-7-event-driven-filings' } },
  { file: 'docs/specs/etf-flow-monitoring.md',                         fm: { status: 'done',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-9-etf-flow' } },
  { file: 'docs/specs/executive-departure-signal.md',                  fm: { status: 'done',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-8-executive-departure' } },
  { file: 'docs/specs/short-interest-tracking.md',                     fm: { status: 'done',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-10-short-interest' } },
  { file: 'docs/specs/expanded-vol-structure.md',                      fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-expanded-vol-structure' } },
  { file: 'docs/specs/cross-asset-signals.md',                         fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-cross-asset' } },
  { file: 'docs/specs/sector-rotation.md',                             fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'gap-sector-rotation' } },
  { file: 'docs/specs/market-cycle-position.md',                       fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'adr-041' } },
  { file: 'docs/specs/drawdown-response-framework.md',                 fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec' } },
  { file: 'docs/specs/kill-criteria-daily-history.md',                 fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec' } },
  { file: 'docs/specs/stage-state-machine.md',                         fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec' } },
  { file: 'docs/specs/gics-sector-baseline-computation.md',            fm: { status: 'done',   phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'spec', slice_id: 'adr-042' } },

  // ───────── Recaps + reviews + analysis ─────────
  { file: 'docs/recap/2026-05-05-v1-archetype-arc-strategic-recap.md', fm: { status: 'active', phase: 'phase 9+', last_updated: '2026-05-05', owner: OWNER, type: 'recap' } },
  { file: 'docs/recap/2026-05-17-ism-pmi-fred-reality-check.md',       fm: { status: 'active', phase: 'phase 9+', last_updated: '2026-05-17', owner: OWNER, type: 'recap' } },
  { file: 'docs/reviews/2026-05-05-cluster-dashboard.md',              fm: { status: 'active', phase: 'phase 2', last_updated: '2026-05-05', owner: OWNER, type: 'review' } },
  { file: 'docs/reviews/2026-05-05-meta-labeling-research-log.md',     fm: { status: 'active', phase: 'phase 9+', last_updated: '2026-05-05', owner: OWNER, type: 'review', slice_id: 'adr-017' } },
  { file: 'docs/analysis/cycle-position-validation-2026-05.md',        fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'analysis', slice_id: 'adr-041' } },

  // ───────── Other roots ─────────
  { file: 'docs/critic_workflow.md',                                   fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'architecture' } },
  { file: 'docs/components/README.md',                                 fm: { status: 'active', phase: 'phase 9+', last_updated: TODAY, owner: OWNER, type: 'index' } },
];

function renderFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`status: ${fm.status}`);
  lines.push(`phase: ${fm.phase}`);
  lines.push(`last_updated: ${fm.last_updated}`);
  lines.push(`owner: ${fm.owner}`);
  lines.push(`type: ${fm.type}`);
  if (fm.slice_id) lines.push(`slice_id: ${fm.slice_id}`);
  if (fm.depends_on && fm.depends_on.length > 0) {
    lines.push('depends_on:');
    for (const dep of fm.depends_on) lines.push(`  - ${dep}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function applyEntry(entry: Entry, repoRoot: string): { written: boolean; reason: string } {
  const abs = path.resolve(repoRoot, entry.file);
  const original = readFileSync(abs, 'utf8');

  // Idempotency guard: if the file already starts with `---\n` treat it as having frontmatter
  // and skip (don't risk rewriting hand-edited values). The CLI surface notes the skip so the
  // operator can spot any drift.
  if (original.startsWith('---\n') || original.startsWith('---\r\n')) {
    return { written: false, reason: 'already has frontmatter (left alone)' };
  }

  const fmBlock = renderFrontmatter(entry.fm);
  writeFileSync(abs, fmBlock + '\n' + original, 'utf8');
  return { written: true, reason: 'prepended frontmatter' };
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');

  let writtenCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  for (const entry of ENTRIES) {
    try {
      const res = applyEntry(entry, repoRoot);
      if (res.written) {
        writtenCount += 1;
        console.log(`  + ${entry.file}`);
      } else {
        skippedCount += 1;
        console.log(`  · ${entry.file}  (${res.reason})`);
      }
    } catch (e) {
      errors.push(`${entry.file}: ${(e as Error).message}`);
    }
  }

  console.log();
  console.log(`Done. wrote=${writtenCount} skipped=${skippedCount} errors=${errors.length}`);
  if (errors.length > 0) {
    for (const err of errors) console.error(`  ! ${err}`);
    process.exit(1);
  }
}

main();
