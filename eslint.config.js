import js from '@eslint/js';
import * as astroParser from 'astro-eslint-parser';
import prettierConfig from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

import ndnI18n from '@ndn/eslint-plugin-i18n';
import ndnNoDestructive from '@ndn/eslint-plugin-no-destructive';

export default tseslint.config(
  {
    // infra/src/__fixtures__/no-destructive/**: TASK 0.3.1's own guard-proof
    // fixtures — deliberately excluded from the normal recursive `pnpm -r
    // lint` (one of them must fail lint by design) and only linted via the
    // `lint:no-destructive` script's `--no-ignore` flag.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/cdk.out/**',
      // Astro's auto-generated type declarations (content.d.ts, types.d.ts)
      // — a build artifact, not source; same treatment as dist/cdk.out.
      '**/.astro/**',
      'infra/src/__fixtures__/no-destructive/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // typescript-eslint's base config (above) sets languageOptions.parser
    // for every file with no `files` restriction of its own — this block's
    // more specific `files` match, placed later in the array, overrides
    // that parser for .astro only; .ts/.tsx files are unaffected. No
    // `project` option: our custom rule only walks syntax (JSXText/
    // JSXExpressionContainer/JSXAttribute), so type-aware parsing isn't
    // needed and would add cost/fragility (a .astro file not covered by
    // any tsconfig `include` would otherwise error).
    files: ['**/*.astro'],
    languageOptions: {
      parser: astroParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.astro'],
        sourceType: 'module',
      },
    },
  },
  importX.flatConfigs.recommended,
  {
    settings: {
      'import-x/resolver': {
        typescript: true,
      },
    },
    plugins: {
      ndn: ndnNoDestructive,
    },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'ndn/no-destructive-primitives': 'error',
    },
  },
  {
    // The rule's own RuleTester fixtures are string literals *containing*
    // banned patterns as text (that's what proves the rule catches them) —
    // linting this file for real would otherwise flag its own test data.
    files: ['packages/eslint-plugin-no-destructive/src/**/*.test.js'],
    rules: {
      'ndn/no-destructive-primitives': 'off',
    },
  },
  {
    // TASK 1.1.2: hard-coded user-facing copy, scoped to apps/web/** only
    // (per the task's own DoD) — .astro pages/components (via the
    // astro-eslint-parser block above) and any future .tsx React island.
    // packages/ui's own components are deliberately out of scope here; see
    // packages/eslint-plugin-i18n/src/constants.js for why this is
    // registered under `ndnI18n`, not `ndn`.
    files: ['apps/web/**'],
    plugins: {
      ndnI18n,
    },
    rules: {
      'ndnI18n/no-hardcoded-strings': 'error',
    },
  },
  prettierConfig,
);
