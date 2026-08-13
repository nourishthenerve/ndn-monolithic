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
  // under a locale prefix (`apps/web/src/pages/[locale]/`). NOT using the
  // built-in `redirects` config here: its auto-generated stub has no way
  // to set `<html lang>` or a landmark region (`RedirectConfig` is just
  // `string | { status, destination }`, no markup hook) — confirmed
  // failing axe's `html-has-lang`/`region` checks against the live
  // ephemeral env. `apps/web/src/pages/index.astro` hand-authors the same
  // client-side meta-refresh instead, with full control over both.
});
