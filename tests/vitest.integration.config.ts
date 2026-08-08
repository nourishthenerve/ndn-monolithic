import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    // No integration tests exist yet — this suite gets real content as
    // later tasks add emulated/ephemeral-AWS integration coverage. The CI
    // step exists now so it starts gating the moment tests land.
    passWithNoTests: true,
  },
});
