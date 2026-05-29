/**
 * ShortInterestApp — thin wrapper binding the short_interest descriptor to the
 * reusable CompositeDetailApp (Cycle 33 slice 3d / S96-147). Flat single-axis
 * descriptor (no metricGroups) + the payload's `drill` carries the per-ticker
 * short-interest table. Mounted by main.tsx on `#/short-interest`. Reads
 * `/api/short-interest`. Ships the awaiting-first-cycle empty state until the
 * FINRA short-interest ingest + daemon populate the snapshot table.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { shortInterestDescriptor } from './descriptors.js';

export default function ShortInterestApp() {
  return <CompositeDetailApp descriptor={shortInterestDescriptor} />;
}
