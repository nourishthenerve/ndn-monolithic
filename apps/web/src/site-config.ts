// TASK 1.1.1: minimal, real page metadata — grows into BaseLayout's config
// in TASK 1.2.1. `siteName` is the clinic's proper name/trademark, not
// translatable prose, so it stays a plain constant; the description IS
// user-facing copy and is a catalogue entry (`site.description`,
// packages/i18n/src/locales/en.json) fetched via `t()` instead, per D-04.

export const siteName = 'Nourish the Nerve';

// TASK 1.3.2: mirrors infra/src/config.ts's DOMAIN_NAME — a staging
// hostname only until Gate G1 (TASK 1.6.1) points the apex/www here
// instead. Used to build absolute canonical/hreflang URLs for blog posts;
// no page needed an absolute URL before this task (relative hrefs were
// always enough). Update alongside DOMAIN_NAME at G1 cutover.
export const siteUrl = 'https://next.nourishthenerve.com';

// TASK 1.3.2: NdnDataStack's ContentHttpApiUrl output (infra/src/data-stack.ts,
// TASK 1.3.1) — a fixed `execute-api.amazonaws.com` URL, stable for the
// life of that HttpApi construct. Hardcoded here rather than looked up at
// build time, same convention infra/src/config.ts's CERTIFICATE_ARN
// documents for a manually-obtained, rarely-changing AWS-generated
// identifier. No CloudFront same-origin proxy exists for this API yet
// (see data-stack.ts's own comment) — `apps/web/src/blog/content-client.ts`
// calls it directly at `astro build` time, not from the browser.
export const contentApiUrl = 'https://m4ptz0to5m.execute-api.eu-west-2.amazonaws.com';

// TASK 1.3.2: every blog post is implicitly tagged with this keyword at
// creation (services/api/src/content-repository.ts's withContentTypeKeyword)
// — reusing GSI2's existing keyword -> content projection to list every
// post without a new index or a table Scan.
export const blogContentType = 'blog';
