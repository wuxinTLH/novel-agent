import { fileURLToPath } from 'node:url';
import { assertSupportedNodeVersion } from '../../../shared/node-runtime.js';
import { supervise } from './core/supervisor.js';

assertSupportedNodeVersion();
// Deliberately no command/env entry override: production always supervises its sibling.
process.exitCode = await supervise({
  entry: fileURLToPath(new URL('./index.js', import.meta.url)),
  onEvent(event) {
    // Fixed metadata only; no environment, child stderr, arguments, paths or data.
    if (event.type === 'restart') console.error('[supervisor] runtime crash; restart %d in %dms', event.attempt, event.delayMs);
  },
});
