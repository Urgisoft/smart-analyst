/**
 * ExecutiveDepartureApp — thin wrapper binding the executive_departure descriptor
 * to the reusable CompositeDetailApp (Cycle 33 slice 3d / S96-147). Flat
 * single-axis descriptor (no metricGroups) + the payload's `drill` carries the
 * per-ticker departure/appointment table. Mounted by main.tsx on
 * `#/executive-departure`. Reads `/api/executive-departure`. Ships the
 * awaiting-first-cycle empty state until the SEC EDGAR 8-K Item 5.02 ingest +
 * daemon populate the snapshot table. CLOSES the Cycle 33 composite-panel sweep.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { executiveDepartureDescriptor } from './descriptors.js';

export default function ExecutiveDepartureApp() {
  return <CompositeDetailApp descriptor={executiveDepartureDescriptor} />;
}
