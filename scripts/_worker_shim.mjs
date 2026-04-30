// Bootstrap shim for batch_backtest_worker.ts.
//
// Worker threads spawned by Node don't automatically inherit the tsx loader from the
// parent's --import tsx flag, so the worker can't resolve relative .js imports that point
// at .ts source files. This shim uses tsx's programmatic register() API to install the
// loader inside the worker, then dynamic-imports the actual .ts worker file.
//
// Why dynamic import: ESM static imports hoist above register() so we'd hit the same
// resolution failure. Dynamic import runs AFTER register() returns, so tsx's hooks are
// active by the time the worker's static imports get processed.
import { register } from 'tsx/esm/api';
register();
await import('./batch_backtest_worker.ts');
