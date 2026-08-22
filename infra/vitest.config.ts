import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Each test *file* pays its own one-time CDK/JSII schema-loading cost
    // on its first Template.fromStack() call (~5-6s seen in CI) — memoized
    // synth helpers only dedupe calls within one file, not across the
    // several files that each construct their own App/Stack. Under
    // `pnpm -r test`'s full-monorepo parallel run, several of those
    // cold-starts and web-stack.test.ts's own full WebStack+DataStack
    // synth (13+ Lambdas bundled through esbuild in one call) compete for
    // the same handful of CI runner cores at once — observed pushing a
    // single synth past the original 20s budget on `ubuntu-latest`
    // (4 vCPUs) even though every such synth completes in a few seconds
    // running standalone. Not a hung test; real resource contention this
    // repo already documents as flakiness rather than a regression
    // wherever it's been hit before. Raised with margin rather than
    // re-measured to the second, since the contention is load-dependent by
    // nature.
    testTimeout: 60_000,
  },
});
