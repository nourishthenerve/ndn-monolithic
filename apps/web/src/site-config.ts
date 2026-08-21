// TASK 1.1.1: minimal, real page metadata — grows into BaseLayout's config
// in TASK 1.2.1. `siteName` is the clinic's proper name/trademark, not
// translatable prose, so it stays a plain constant; the description IS
// user-facing copy and is a catalogue entry (`site.description`,
// packages/i18n/src/locales/en.json) fetched via `t()` instead, per D-04.

export const siteName = 'Nourish the Nerve';

// TASK 1.3.2, repointed at the G1 cutover (TASK 1.6.1, 2026-08-21): the
// canonical public origin. Used to build absolute canonical/hreflang URLs
// for blog posts and workshops; no page needed an absolute URL before
// TASK 1.3.2 (relative hrefs were always enough). This is deliberately the
// apex, not infra/src/config.ts's DOMAIN_NAME — `next.` remains an alias on
// the same distribution and stays useful as a staging URL, but a page served
// from either hostname must name one canonical origin, and after the cutover
// that is the apex. See docs/runbooks/g1-cutover.md step 5.
export const siteUrl = 'https://nourishthenerve.com';

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

// TASK 1.4.1: Cloudflare Turnstile's own well-known, publicly documented
// "always passes" test site key — not secret, safe to build into static
// HTML. [Owner action] Replace with the real site key from a Turnstile
// widget created in the Cloudflare dashboard before flipping
// `contact.form.enabled` on for real; see docs/runbooks/contact-form.md.
// The matching secret key lives server-side only (SSM SecureString,
// infra/src/config.ts's TURNSTILE_SECRET_PARAMETER_NAME), never here.
export const turnstileSiteKey = '1x00000000000000000000AA';

// TASK 1.5.1: workshop posters are served same-origin, via
// web-stack.ts's `/media/*` CloudFront behavior (Origin Access Control,
// no signed URLs — ADR-0005 note in that file) — a relative path is
// correct on every domain this site is ever deployed to (next./apex,
// staging, an ephemeral PR env), unlike `siteUrl`/`contentApiUrl` above
// which are absolute and must be updated by hand at G1 cutover.
export function workshopPosterUrl(posterKey: string): string {
  return `/media/${posterKey}`;
}
