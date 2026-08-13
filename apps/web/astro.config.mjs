import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// ADR-0017 / TASK 1.1.1: static output only — zero JS ships by default;
// packages/ui's React components hydrate only where a page opts in via a
// `client:*` directive. `astro build` writes to `dist/`, which
// infra/src/web-stack.ts's BucketDeployment now serves as-is.
export default defineConfig({
  output: 'static',
  integrations: [react()],
});
