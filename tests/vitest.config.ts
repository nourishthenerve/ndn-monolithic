import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Scoped to src/ so this default config — what `pnpm run test` (the
    // `quality` CI job, every push/PR) runs — never picks up
    // integration/**/*.test.ts (its own dedicated
    // vitest.integration.config.ts) or pr-env/**/*.test.ts (TASK 0.6.3's
    // vitest.pr-env.config.ts), both of which require a live deployed
    // target and would otherwise fail every ordinary CI run.
    include: ['src/**/*.test.ts'],
  },
});
