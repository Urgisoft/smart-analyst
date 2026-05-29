/**
 * Tests for src/components/composite/anomalyScan.ts — the pure, client-side,
 * unit-testable bug-finding scan (Cycle 33 / S96-147).
 *
 * The load-bearing test is `catches the OQ-C31-1 z=27 artifact`: the scan is
 * the check that would have flagged the form_4 zero-inflated-baseline bug at
 * render time instead of it being found by eye three cycles later. Every branch
 * (NON_FINITE / OUT_OF_BAND / coverage / stale / unknown-verdict / degenerate
 * baseline / discontinuity / clean) is pinned here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanCompositeAnomalies, type AnomalyScanConfig } from '../../src/components/composite/anomalyScan.js';
import type { CompositeDetailPayload, CompositeHistoryPoint } from '../../src/server/composite_detail.js';

const CONFIG: AnomalyScanConfig = {
  metrics: [
    { key: 'vixZ', label: 'VIX z-score', unit: 'z', warnAbs: 2, critAbs: 4 },
    { key: 'vvixZ', label: 'VVIX z-score', unit: 'z', warnAbs: 2, critAbs: 4 },
    { key: 'inversionDepth', label: 'Inversion depth', unit: 'raw' },
  ],
};

function base(over: Partial<CompositeDetailPayload> = {}): CompositeDetailPayload {
  return {
    composite: 'vol_structure',
    compositeVersion: 'vol_struct_v1',
    sourceTable: 'quantlab.vol_structure_snapshots',
    hasData: true,
    snapshotDate: '2026-05-28',
    evaluatedAt: '2026-05-28T00:00:00Z',
    staleDays: 0,
    verdict: 'normal',
    metrics: [
      { key: 'vixZ', value: 0.5 },
      { key: 'vvixZ', value: -0.3 },
      { key: 'inversionDepth', value: 0 },
    ],
    flags: [],
    inputsPresent: 0b11111,
    inputsPresentCount: 5,
    inputsTotal: 5,
    lookbackDays: 365,
    history: [],
    ...over,
  };
}

function codes(p: CompositeDetailPayload): string[] {
  return scanCompositeAnomalies(p, CONFIG).map(a => a.code);
}

describe('scanCompositeAnomalies', () => {
  it('returns [] for the empty (awaiting-first-cycle) state', () => {
    assert.deepEqual(scanCompositeAnomalies(base({ hasData: false }), CONFIG), []);
  });

  it('is clean for a healthy in-band fresh snapshot', () => {
    assert.deepEqual(codes(base()), []);
  });

  it('flags an out-of-band z as critical (warn band is lower severity)', () => {
    const critical = scanCompositeAnomalies(base({ metrics: [
      { key: 'vixZ', value: 5.2 }, { key: 'vvixZ', value: 0 }, { key: 'inversionDepth', value: 0 },
    ] }), CONFIG);
    assert.equal(critical[0].code, 'OUT_OF_BAND_CRIT');
    assert.equal(critical[0].severity, 'critical');
    assert.equal(critical[0].metricKey, 'vixZ');

    const warn = scanCompositeAnomalies(base({ metrics: [
      { key: 'vixZ', value: 2.5 }, { key: 'vvixZ', value: 0 }, { key: 'inversionDepth', value: 0 },
    ] }), CONFIG);
    assert.equal(warn[0].code, 'OUT_OF_BAND');
    assert.equal(warn[0].severity, 'warn');
  });

  it('does NOT band-check raw metrics (inversionDepth=27 is fine)', () => {
    // A raw VIX-point value of 27 is large but not a z-score artifact — the
    // scan must not false-positive on raw units.
    assert.deepEqual(codes(base({ metrics: [
      { key: 'vixZ', value: 0.1 }, { key: 'vvixZ', value: 0.1 }, { key: 'inversionDepth', value: 27 },
    ] })), []);
  });

  it('catches the OQ-C31-1 z=27 artifact (out-of-band crit + degenerate baseline)', () => {
    // Reproduce the form_4 failure mode: a z-score pinned at an extreme value
    // off a zero-inflated baseline. max=27 with a baseline that takes almost no
    // distinct values. Both the out-of-band AND the degenerate-baseline checks
    // should fire — either alone would have surfaced the bug at render time.
    const history: CompositeHistoryPoint[] = Array.from({ length: 40 }, (_, i) => ({
      date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
      verdict: 'normal',
      // baseline pinned at 0 most days, occasional 10 — zero-inflated/degenerate.
      metrics: { vixZ: i % 7 === 0 ? 10 : 0, vvixZ: 0, inversionDepth: 0 },
    }));
    const p = base({
      metrics: [{ key: 'vixZ', value: 27 }, { key: 'vvixZ', value: 0 }, { key: 'inversionDepth', value: 0 }],
      history,
    });
    const result = scanCompositeAnomalies(p, CONFIG);
    const found = result.map(a => a.code);
    assert.ok(found.includes('OUT_OF_BAND_CRIT'), 'should flag the extreme z as out-of-band critical');
    assert.ok(found.includes('DEGENERATE_BASELINE'), 'should flag the zero-inflated baseline');
    // critical sorts first.
    assert.equal(result[0].severity, 'critical');
  });

  it('flags zero coverage as critical and partial coverage as warn', () => {
    assert.ok(codes(base({ inputsPresent: 0, inputsPresentCount: 0 })).includes('NO_COVERAGE'));
    assert.ok(codes(base({ inputsPresent: 0b01111, inputsPresentCount: 4 })).includes('COVERAGE_DEGRADED'));
  });

  it('grades staleness: info at 3d, warn at 7d', () => {
    const info = scanCompositeAnomalies(base({ staleDays: 4 }), CONFIG).find(a => a.code === 'STALE');
    assert.equal(info?.severity, 'info');
    const warn = scanCompositeAnomalies(base({ staleDays: 9 }), CONFIG).find(a => a.code === 'STALE');
    assert.equal(warn?.severity, 'warn');
    // fresh → no stale flag.
    assert.equal(scanCompositeAnomalies(base({ staleDays: 1 }), CONFIG).find(a => a.code === 'STALE'), undefined);
  });

  it('flags an unknown verdict as info', () => {
    assert.ok(codes(base({ verdict: 'unknown' })).includes('UNKNOWN_VERDICT'));
  });

  it('flags a non-finite value that slipped through as null-bypass', () => {
    // JSON can't carry NaN, but a hand-built/in-memory payload can; the scan
    // must catch it defensively.
    const p = base({ metrics: [{ key: 'vixZ', value: Infinity }, { key: 'vvixZ', value: 0 }, { key: 'inversionDepth', value: 0 }] });
    const codesFound = scanCompositeAnomalies(p, CONFIG).map(a => a.code);
    assert.ok(codesFound.includes('NON_FINITE'));
  });

  it('flags a day-over-day discontinuity past the crit band', () => {
    const history: CompositeHistoryPoint[] = [
      // enough distinct values to avoid the degenerate-baseline path
      ...Array.from({ length: 20 }, (_, i) => ({ date: `2026-04-${String(i + 1).padStart(2, '0')}`, verdict: 'normal', metrics: { vixZ: (i % 9) * 0.3 - 1, vvixZ: 0, inversionDepth: 0 } })),
      { date: '2026-05-27', verdict: 'normal', metrics: { vixZ: 0.2, vvixZ: 0, inversionDepth: 0 } },
      { date: '2026-05-28', verdict: 'normal', metrics: { vixZ: 5.5, vvixZ: 0, inversionDepth: 0 } },
    ];
    // latest metric in-band (3.5 < 4) so OUT_OF_BAND doesn't fire, isolating DISCONTINUITY.
    const p = base({ metrics: [{ key: 'vixZ', value: 3.5 }, { key: 'vvixZ', value: 0 }, { key: 'inversionDepth', value: 0 }], history });
    const found = scanCompositeAnomalies(p, CONFIG).map(a => a.code);
    assert.ok(found.includes('DISCONTINUITY'), `expected DISCONTINUITY, got ${found.join(',')}`);
  });

  it('sorts critical before warn before info', () => {
    const p = base({
      staleDays: 9, // warn
      verdict: 'unknown', // info
      metrics: [{ key: 'vixZ', value: 9 }, { key: 'vvixZ', value: 0 }, { key: 'inversionDepth', value: 0 }], // crit
    });
    const sev = scanCompositeAnomalies(p, CONFIG).map(a => a.severity);
    // first must be critical, last must be info
    assert.equal(sev[0], 'critical');
    assert.equal(sev[sev.length - 1], 'info');
  });
});
