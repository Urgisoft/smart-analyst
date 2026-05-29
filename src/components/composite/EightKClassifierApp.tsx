/**
 * EightKClassifierApp — thin wrapper binding the eight_k_classifier descriptor
 * to the reusable CompositeDetailApp (Cycle 33 slice 3c / S96-147). Flat
 * single-axis descriptor (no metricGroups) + the payload's `drill` carries the
 * per-ticker material-event table. Mounted by main.tsx on `#/eight-k`. Reads
 * `/api/eight-k`. Ships the awaiting-first-cycle empty state until the SEC EDGAR
 * 8-K ingest + daemon populate the snapshot table.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { eightKClassifierDescriptor } from './descriptors.js';

export default function EightKClassifierApp() {
  return <CompositeDetailApp descriptor={eightKClassifierDescriptor} />;
}
