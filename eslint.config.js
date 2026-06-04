// ESLint v9 flat config (Item: re-enable lint in CI).
//
// Scope: source under packages/*/src and apps/*/src. Tuned to the conventions
// already enforced by the codebase + CLAUDE.md (no `any`, no floating promises,
// no unused vars) without forcing a large stylistic cleanup. Type-aware rules
// would need per-package tsconfig wiring; we keep the lint fast and
// non-type-checked (tsc --build is the type gate) and lint the semantic rules
// ESLint can apply without type info.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'graphify-out/**',
      'data/**',
      'scripts/**',
      '**/*.mjs',
      'eslint.config.js',
      '**/*.test.ts',
      '**/test/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
  })),
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // CLAUDE.md: never `any` — use `unknown` + guards.
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow intentional unused args/vars prefixed with `_`.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // These need type info; off in the fast lint (tsc covers correctness).
      '@typescript-eslint/no-floating-promises': 'off',
      'no-undef': 'off', // TS handles this; avoids false positives on globals.
      // Intentional, load-bearing patterns in this codebase:
      //  - tree-sitter native interop needs @ts-ignore shims;
      //  - the TS parser pool loads a native addon via require();
      //  - parser/extractor regexes carry harmless escapes that are risky to
      //    rewrite (extraction hot path / core IP per CLAUDE.md).
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-useless-escape': 'warn',
      'no-constant-binary-expression': 'warn',
    },
  },
);
