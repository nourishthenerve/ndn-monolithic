import { describe, expect, it } from 'vitest';

import { siteName, workshopPosterUrl } from './site-config.js';

describe('site-config', () => {
  it('provides a non-empty name for the page <title>', () => {
    expect(siteName.length).toBeGreaterThan(0);
  });

  it('workshopPosterUrl builds a same-origin, relative /media/ path', () => {
    expect(workshopPosterUrl('workshops/poster-1.jpg')).toBe('/media/workshops/poster-1.jpg');
  });
});
