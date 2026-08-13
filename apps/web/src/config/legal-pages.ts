// TASK 1.2.2: the single source of truth for the five required legal
// documents (FR-WEB-07) — routes.ts's route segments, Footer.astro's legal
// links, and each `pages/[locale]/legal/*.astro` wrapper all read from this
// array rather than repeating the slug/key list, so removing an entry here
// removes it everywhere at once instead of leaving a dangling page, route,
// or footer link. Zod-parsed eagerly at import time, same reasoning as
// social-links.ts: a malformed entry fails `astro build` and every test
// that imports this module, not a runtime 500.
import { z } from 'zod';

export const legalPageSlugSchema = z.enum([
  'privacy',
  'cookies',
  'terms',
  'accessibility-statement',
  'clinical-disclaimer',
]);

export type LegalPageSlug = z.infer<typeof legalPageSlugSchema>;

export interface LegalPageConfig {
  readonly slug: LegalPageSlug;
  /** i18n key for the page's <h1> / <title>. */
  readonly headingKey: string;
  /** i18n key for the page's <meta name="description">. */
  readonly descriptionKey: string;
  /** i18n key for the page's body copy. */
  readonly bodyKey: string;
  /** i18n key for this page's link text in Footer.astro. */
  readonly footerLabelKey: string;
}

export const legalPageConfigSchema = z.object({
  slug: legalPageSlugSchema,
  headingKey: z.string().min(1),
  descriptionKey: z.string().min(1),
  bodyKey: z.string().min(1),
  footerLabelKey: z.string().min(1),
});

const rawLegalPages: readonly LegalPageConfig[] = [
  {
    slug: 'privacy',
    headingKey: 'legal.privacy.heading',
    descriptionKey: 'legal.privacy.description',
    bodyKey: 'legal.privacy.body',
    footerLabelKey: 'legal.privacy.footerLabel',
  },
  {
    slug: 'cookies',
    headingKey: 'legal.cookies.heading',
    descriptionKey: 'legal.cookies.description',
    bodyKey: 'legal.cookies.body',
    footerLabelKey: 'legal.cookies.footerLabel',
  },
  {
    slug: 'terms',
    headingKey: 'legal.terms.heading',
    descriptionKey: 'legal.terms.description',
    bodyKey: 'legal.terms.body',
    footerLabelKey: 'legal.terms.footerLabel',
  },
  {
    slug: 'accessibility-statement',
    headingKey: 'legal.accessibilityStatement.heading',
    descriptionKey: 'legal.accessibilityStatement.description',
    bodyKey: 'legal.accessibilityStatement.body',
    footerLabelKey: 'legal.accessibilityStatement.footerLabel',
  },
  {
    slug: 'clinical-disclaimer',
    headingKey: 'legal.clinicalDisclaimer.heading',
    descriptionKey: 'legal.clinicalDisclaimer.description',
    bodyKey: 'legal.clinicalDisclaimer.body',
    footerLabelKey: 'legal.clinicalDisclaimer.footerLabel',
  },
];

export const legalPages: readonly LegalPageConfig[] = z
  .array(legalPageConfigSchema)
  .parse(rawLegalPages);
