import { describe, expect, it } from 'vitest';

import { socialLinkSchema, socialLinks } from './social-links.js';

describe('social-links', () => {
  it('exports at least one validated entry', () => {
    expect(socialLinks.length).toBeGreaterThan(0);
  });

  it('every entry has a non-empty label and a valid absolute URL', () => {
    for (const link of socialLinks) {
      expect(link.label.length).toBeGreaterThan(0);
      expect(() => new URL(link.href)).not.toThrow();
    }
  });

  it('the schema rejects a malformed entry — the guard, not just a TS type', () => {
    const emptyLabel = socialLinkSchema.safeParse({ label: '', href: 'https://example.com' });
    const badUrl = socialLinkSchema.safeParse({ label: 'Example', href: 'not-a-url' });
    const missingHref = socialLinkSchema.safeParse({ label: 'Example' });

    expect(emptyLabel.success).toBe(false);
    expect(badUrl.success).toBe(false);
    expect(missingHref.success).toBe(false);
  });
});
