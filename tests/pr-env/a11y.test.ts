import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { getBaseUrl } from './env.js';

// TASK 0.6.3: a lightweight a11y gate for the one real page that exists
// today (infra/assets/site/index.html). `axe-core` is imported dynamically,
// *inside* the test, after the JSDOM-derived `window`/`document` globals
// are assigned — axe-core reads those globals once, at its own module
// evaluation time, not per call, so a normal top-of-file static import
// (which Node/Vitest evaluates before this test body ever runs) captures
// them as undefined and axe-core throws "Required window or document
// globals not defined" on every run, confirmed empirically. TASK 1.1.3
// (Phase 1) replaces this with a real-browser a11y suite across every
// page; this establishes the pipeline wiring now rather than leaving the
// ephemeral-env job without an a11y step until then.
describe('ephemeral PR environment — accessibility', () => {
  it('the served page has no automatically-detectable axe violations', async () => {
    const response = await fetch(getBaseUrl());
    const html = await response.text();

    // Unforwarded VirtualConsole: jsdom logs an expected "canvas not
    // implemented" notice while axe's color-contrast check probes
    // rendering it can't actually do outside a real browser — that
    // limitation is why color-contrast lands in `incomplete` below, not a
    // real failure, and isn't worth CI log noise.
    const dom = new JSDOM(html, {
      url: getBaseUrl(),
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
    });
    // `@types/node` has no "DOM" lib global for `window`/`document` (this
    // repo's tsconfig deliberately doesn't add one — see tsconfig.base.json
    // — so it targets a plain Node runtime everywhere else); jsdom's own
    // `DOMWindow` type stands in for it here instead of pulling in "DOM".
    const globals = globalThis as unknown as { window: DOMWindow; document: DOMWindow['document'] };
    globals.window = dom.window;
    globals.document = dom.window.document;
    // Node 22 defines a built-in, non-configurable `navigator` getter —
    // unlike `window`/`document`, it can't be reassigned with `=`, and
    // axe-core works fine without overriding it (only `window`/`document`
    // are what its setupGlobals check actually requires).

    const axe = (await import('axe-core')).default;
    const results = await axe.run(dom.window.document);

    // `incomplete` (e.g. color-contrast) means axe couldn't determine an
    // answer under jsdom's non-rendering environment, not that it found a
    // problem — only `violations` is a real, confirmed finding.
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toHaveLength(0);
  });
});
