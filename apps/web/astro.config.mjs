import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// ADR-0017 / TASK 1.1.1: static output only — zero JS ships by default;
// packages/ui's React components hydrate only where a page opts in via a
// `client:*` directive. `astro build` writes to `dist/`, which
// infra/src/web-stack.ts's BucketDeployment now serves as-is.
export default defineConfig({
  output: 'static',
  integrations: [react()],
  // TASK 1.1.2: `/` has no content of its own — every real page lives
  // under a locale prefix (`apps/web/src/pages/[locale]/`). In static
  // output with no adapter, Astro serves this as an HTML
  // <meta http-equiv="refresh"> redirect (no server-side 301 available).
  redirects: {
    '/': '/en',
  },
});
