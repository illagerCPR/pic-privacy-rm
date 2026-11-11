import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Plain React, no compiler: only the two hook rules that catch real mistakes
 * are enabled. The v7 plugin also ships the React Compiler rules, which assume
 * a build step that rewrites refs and memoisation — turning them on would mean
 * rewriting code that is correct as written.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'tests/real/**',
      'tests/output/**',
      'e2e/downloads/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // `catch {}` with an explanatory comment is the house style for
      // "best effort" code (storage, service worker, palette extraction).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Metadata values are padded with NUL bytes; matching control characters
      // is the point of these expressions, not an accident.
      'no-control-regex': 'off',
      // TypeScript already reports undefined identifiers.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', 'e2e/**/*.ts', '*.config.ts', 'tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Tests poke at parsed JSON; a precise type per fixture is noise.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
