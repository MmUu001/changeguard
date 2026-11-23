// ESLint flat config. Scope mirrors prettier: source, tests, scripts.
// Two deliberate exemptions:
//   - no-explicit-any: off — the 2 remaining `any`s sit at JSON boundaries
//     where a precise type would be fiction.
//   - no-unused-vars: `_`-prefixed identifiers are intentional throwaways
//     (e.g. `const _ = await f()` style from fixtures), keep them legal.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      'fixtures/**',
      'manuals/**',
      '.changeguard/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Node ESM scripts (ops tooling): standard Node globals apply.
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
