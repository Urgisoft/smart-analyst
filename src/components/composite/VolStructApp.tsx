/**
 * VolStructApp — thin wrapper binding the vol_structure descriptor to the
 * reusable CompositeDetailApp (Cycle 33 / S96-147). This is the entire
 * per-composite cost once the reusable panel exists: a descriptor + this
 * ~10-line wrapper + a server projection. Every subsequent composite panel
 * follows this template.
 *
 * Mounted by main.tsx on `#/vol-structure`. Reads `/api/vol-structure`.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { volStructureDescriptor } from './descriptors.js';

export default function VolStructApp() {
  return <CompositeDetailApp descriptor={volStructureDescriptor} />;
}
