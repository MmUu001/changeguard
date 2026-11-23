import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // node:sqlite (Node >=22.5) is absent from vitest's builtin list;
      // route it through a runtime require shim.
      'node:sqlite': fileURLToPath(new URL('./tests/node-sqlite-shim.mjs', import.meta.url)),
    },
  },
  test: {
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
