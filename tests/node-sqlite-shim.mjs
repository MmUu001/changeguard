/**
 * Vitest shim for node:sqlite (Node >=22.5 is missing from vitest's builtin
 * list, so `import ... from 'node:sqlite'` fails module resolution).
 *
 * The real module is loaded through createRequire at runtime, which vite's
 * import analysis never touches. Aliased from vitest.config.ts.
 */
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const sqlite = require_('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export default sqlite;
