/**
 * CrossAssetApp — thin wrapper binding the cross_asset descriptor to the
 * reusable CompositeDetailApp (Cycle 33 slice 2a / S96-147).
 * Mounted by main.tsx on `#/cross-asset`. Reads `/api/cross-asset`.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { crossAssetDescriptor } from './descriptors.js';

export default function CrossAssetApp() {
  return <CompositeDetailApp descriptor={crossAssetDescriptor} />;
}
