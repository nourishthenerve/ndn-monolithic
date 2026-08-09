import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // guardrails.test.ts's first Template.fromStack() call pays a one-time
    // CDK/JSII schema-loading cost (~5-6s seen in CI) that easily clears
    // vitest's 5000ms default on a slower/loaded runner even though every
    // later Template.fromStack() call in the same run is fast. Not a hung
    // test — a cold-start cost paid once per process.
    testTimeout: 20_000,
  },
});
