import { describe, expect, it } from 'vitest';

import { legalPageConfigSchema, legalPageSlugSchema, legalPages } from './legal-pages.js';

// TASK 1.2.2: FR-WEB-07 requires exactly these five documents — this list
// fails loudly if a future edit silently drops one (or renames a slug a
// footer link / route segment still points at) rather than the gap only
// surfacing as a 404 someone notices later.
const requiredSlugs = [
  'privacy',
  'cookies',
  'terms',
  'accessibility-statement',
  'clinical-disclaimer',
].sort();

describe('legal-pages', () => {
  it('has exactly the five required legal documents', () => {
    expect([...legalPages.map((page) => page.slug)].sort()).toEqual(requiredSlugs);
  });

  it('every entry has non-empty heading/description/body/footer-label keys', () => {
    for (const page of legalPages) {
      expect(page.headingKey.length).toBeGreaterThan(0);
      expect(page.descriptionKey.length).toBeGreaterThan(0);
      expect(page.bodyKey.length).toBeGreaterThan(0);
      expect(page.footerLabelKey.length).toBeGreaterThan(0);
    }
  });

  it('the schema rejects a malformed entry — the guard, not just a TS type', () => {
    const missingHeading = legalPageConfigSchema.safeParse({
      slug: 'privacy',
      descriptionKey: 'legal.privacy.description',
      bodyKey: 'legal.privacy.body',
      footerLabelKey: 'legal.privacy.footerLabel',
    });
    const unknownSlug = legalPageSlugSchema.safeParse('refund-policy');

    expect(missingHeading.success).toBe(false);
    expect(unknownSlug.success).toBe(false);
  });
});
