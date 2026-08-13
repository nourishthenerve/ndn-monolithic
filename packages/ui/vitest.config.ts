import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tokens (pure functions) run under plain 'node'; component tests opt
    // into DOM per-file via a `// @vitest-environment jsdom` docblock —
    // keeps the common case (tokens) fast and avoids a jsdom cost that
    // most files in this package don't need.
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // e2e/ holds Playwright specs, run by a separate runner (playwright.config.ts) — vitest's default `**/*.spec.ts` pattern would otherwise pick them up too.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
