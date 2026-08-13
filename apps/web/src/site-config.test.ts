import { describe, expect, it } from 'vitest';

import { siteName } from './site-config.js';

describe('site-config', () => {
  it('provides a non-empty name for the page <title>', () => {
    expect(siteName.length).toBeGreaterThan(0);
  });
});
