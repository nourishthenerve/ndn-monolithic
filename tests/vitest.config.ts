import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Scoped to src/ (and, TASK 5.1.1, load/) so this default config — what
    // `pnpm run test` (the `quality` CI job, every push/PR) runs — never
    // picks up integration/**/*.test.ts (its own dedicated
    // vitest.integration.config.ts) or pr-env/**/*.test.ts (TASK 0.6.3's
    // vitest.pr-env.config.ts), both of which require a live deployed
    // target and would otherwise fail every ordinary CI run. load/
    // derive-targets.test.ts has no such dependency — pure arithmetic, no
    // live target — so it belongs here rather than in a third dedicated
    // config; the Artillery YAML files alongside it are not vitest specs
    // and this include pattern never matches them.
    include: ['src/**/*.test.ts', 'load/**/*.test.ts'],
  },
});
