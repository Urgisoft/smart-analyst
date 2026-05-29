/**
 * SectorRotationApp — thin wrapper binding the sector_rotation descriptor to
 * the reusable CompositeDetailApp (Cycle 33 slice 2a / S96-147).
 * Mounted by main.tsx on `#/sector-rotation`. Reads `/api/sector-rotation`.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { sectorRotationDescriptor } from './descriptors.js';

export default function SectorRotationApp() {
  return <CompositeDetailApp descriptor={sectorRotationDescriptor} />;
}
