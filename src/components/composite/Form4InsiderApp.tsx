/**
 * Form4InsiderApp — thin wrapper binding the form_4_insider descriptor to the
 * reusable CompositeDetailApp (Cycle 33 slice 2b / S96-147). The descriptor's
 * `metricGroups` drives the dual buy/sell lane layout; the payload's `drill`
 * carries the per-ticker table. Mounted by main.tsx on `#/form-4-insider`.
 * Reads `/api/form-4-insider`.
 */
import CompositeDetailApp from './CompositeDetailApp.js';
import { form4InsiderDescriptor } from './descriptors.js';

export default function Form4InsiderApp() {
  return <CompositeDetailApp descriptor={form4InsiderDescriptor} />;
}
