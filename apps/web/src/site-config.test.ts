import { describe, expect, it } from 'vitest';

import { mediaUrl, siteName, workshopPosterUrl } from './site-config.js';

describe('site-config', () => {
  it('provides a non-empty name for the page <title>', () => {
    expect(siteName.length).toBeGreaterThan(0);
  });

  // 2026-09-02: this test used to assert `workshopPosterUrl('workshops/…')`
  // === '/media/workshops/…', and it passed for a year while being the bug.
  // `/media/*` does no rewriting, so that URL asks S3 for the key
  // `media/workshops/…` — which is not the key the uploader wrote. The
  // stored key is now the real key, and the URL is just a leading slash.
  it('mediaUrl builds a same-origin path from a public media key', () => {
    expect(mediaUrl('media/workshops/poster-1.jpg')).toBe('/media/workshops/poster-1.jpg');
    expect(mediaUrl('media/content/hero-1.png')).toBe('/media/content/hero-1.png');
  });

  // The refusal is the point. A key outside `media/` names something the
  // public behaviour does not serve — and in this bucket the most likely
  // such key is an assessment attachment, so rendering a link to one is
  // the failure worth making impossible rather than merely unlikely.
  it.each([
    ['assessments/pat-1/scan.pdf', 'a private attachment'],
    ['media/../assessments/pat-1/scan.pdf', 'a traversal out of the prefix'],
    ['', 'an empty key'],
    ['workshops/poster-1.jpg', 'a pre-2026-09-02 key that no longer resolves'],
  ])('mediaUrl refuses %s (%s)', (key) => {
    expect(mediaUrl(key)).toBeUndefined();
  });

  it('workshopPosterUrl is the same function under its old name', () => {
    expect(workshopPosterUrl('media/workshops/poster-1.jpg')).toBe(
      '/media/workshops/poster-1.jpg',
    );
    expect(workshopPosterUrl('assessments/pat-1/scan.pdf')).toBeUndefined();
  });
});
