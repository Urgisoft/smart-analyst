// Display formatters shared between the dashboard UI and CLI scripts. The implementation
// lives in scripts/_data_quality.ts so it's covered by the unit tests in scripts/tests/.
// This file is just a re-export shim that gives the React side an import path that doesn't
// reach into scripts/.
export { formatPct } from '../../scripts/_data_quality.js';
