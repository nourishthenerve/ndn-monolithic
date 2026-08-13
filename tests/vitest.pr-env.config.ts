import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['pr-env/**/*.test.ts'],
    // TASK 0.6.3: this suite hits a real, just-deployed ephemeral stack
    // (see tests/pr-env/env.ts) — a CloudFront/Lambda cold start plus a
    // couple of round trips comfortably exceeds vitest's 5s default.
    testTimeout: 30_000,
  },
});
