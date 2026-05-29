/**
 * Schedule13DGApp — thin wrapper binding the schedule_13d_g descriptor to the
 * reusable CompositeDetailApp (Cycle 33 slice 3a / S96-147). Flat single-axis
 * descriptor (no metricGroups) + the payload's `drill` carries the per-ticker
 * 13D/13G filing table. Mounted by main.tsx on `#/schedule-13d-g`. Reads
 * `/api/schedule-13d-g`. Ships the awaiting-first-cycle empty state until the
 * SEC EDGAR 13D/G ingest + daemon populate the snapshot table.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { schedule13DGDescriptor } from './descriptors.js';

export default function Schedule13DGApp() {
  return <CompositeDetailApp descriptor={schedule13DGDescriptor} />;
}
