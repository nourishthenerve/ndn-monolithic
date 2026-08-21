import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'services/*', 'infra', 'tests'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        // TASK 2.1.2 (R-09): the clinician-private boundary. The register's
        // mitigation for its only **Critical** risk names the number —
        // "100% coverage on the boundary" — so it is a CI condition here
        // rather than an aspiration in a runbook. A glob threshold takes
        // the file out of the 80% pool above and holds it to its own bar;
        // `pnpm test:coverage` (the `quality` job in .github/workflows/ci.yml)
        // fails if a new branch in projection.ts arrives untested.
        // See docs/runbooks/private-field-boundary.md.
        '**/services/api/src/projection.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
});
