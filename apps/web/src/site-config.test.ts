import { describe, expect, it } from 'vitest';

import { siteDescription, siteName } from './site-config.js';

describe('site-config', () => {
  it('provides a non-empty name and description for the page <title>/<meta>', () => {
    expect(siteName.length).toBeGreaterThan(0);
    expect(siteDescription.length).toBeGreaterThan(0);
  });
});
