import js from '@eslint/js';
import ndnNoDestructive from '@ndn/eslint-plugin-no-destructive';
import prettierConfig from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

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
      'infra/src/__fixtures__/no-destructive/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
  prettierConfig,
);
