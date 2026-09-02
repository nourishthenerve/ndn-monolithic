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

// TASK 4.3.1: NdnDataStack's SignallingWebSocketUrl output (infra/src/data-stack.ts,
// TASK 4.1.1) — the same "fixed execute-api.amazonaws.com URL, hardcoded
// rather than looked up at build time" convention `contentApiUrl` above
// documents, applied to the one `wss://` origin this site calls. Called
// from the browser, not at build time — a signalling connection has no
// meaning until a signed-in caller opens one.
export const signallingWebSocketUrl = 'wss://93im3xehxh.execute-api.eu-west-2.amazonaws.com/$default';

// TASK 1.3.2: every blog post is implicitly tagged with this keyword at
// creation (services/api/src/content-repository.ts's withContentTypeKeyword)
// — reusing GSI2's existing keyword -> content projection to list every
// post without a new index or a table Scan.
export const blogContentType = 'blog';

// TASK 1.4.1: the real site key, provisioned 2026-08-30 — "NDN Site
// Widget" in the Cloudflare dashboard, hostnames nourishthenerve.com and
// next.nourishthenerve.com. Not secret — a site key is meant to be public,
// safe to build into static HTML. D-32 (2026-08-30): the contact form this
// key was originally built for is deleted; testimonial submission is now
// its only caller. The matching secret key lives server-side only (SSM
// SecureString, infra/src/config.ts's TURNSTILE_SECRET_PARAMETER_NAME,
// provisioned the same day), never here.
export const turnstileSiteKey = '0x4AAAAAAEiDaB79oLUw9LNz'; // gitleaks:allow — not secret, see comment above

// D-32 (2026-08-30): the contact page's replacement for the deleted form —
// a direct link to the clinic's WhatsApp Business number, the same
// human-staffed channel D-29 already established for patient account
// creation (docs/runbooks/patient-account-provisioning.md). The real
// number, provided by the owner 2026-08-30.
export const whatsappBusinessNumber = '+91 88611 11636';

/** `https://wa.me/<digits>` — wa.me accepts digits only, no `+`/spaces/hyphens. */
export function whatsappChatUrl(number: string): string {
  return `https://wa.me/${number.replace(/\D/g, '')}`;
}

// TASK 1.5.1: workshop posters are served same-origin, via
// web-stack.ts's `/media/*` CloudFront behavior (Origin Access Control,
// no signed URLs — ADR-0005 note in that file) — a relative path is
// correct on every domain this site is ever deployed to (next./apex,
// staging, an ephemeral PR env), unlike `siteUrl`/`contentApiUrl` above
// which are absolute and must be updated by hand at G1 cutover.
//
// **2026-09-02: the path is the key, not `/media/` plus the key.** That
// behaviour does no rewriting — `/media/x/y.jpg` asks S3 for the key
// `media/x/y.jpg` verbatim — so a key that did not already start with
// `media/` produced a URL for an object that does not exist. Every poster
// this site could have shown would have 404'd; nothing had, because until
// today no poster could be uploaded at all (its endpoint was unreachable
// from a browser).
//
// The `media/` prefix therefore *is* the public set. That is what keeps
// assessment attachments — same bucket, `assessments/` prefix — off the
// public site: not a rule anyone has to remember, but a URL that no
// behaviour serves.
const PUBLIC_MEDIA_PREFIX = 'media/';

/**
 * A same-origin URL for a public media object, or `undefined` for a key
 * outside the public prefix.
 *
 * Refusing rather than rendering is deliberate. This function's output
 * goes into an `<img src>` on a public page, so the failure it has to be
 * safe about is a key naming something that is not public — and a broken
 * image is a far better outcome than a working link to a clinical
 * attachment. The API validates the same thing on the way in
 * (`content-authoring.ts`, `workshop-authoring.ts`); this is the second
 * half of it, at the point of rendering, because a record written before
 * that validation existed would otherwise walk straight past it.
 */
export function mediaUrl(key: string): string | undefined {
  if (!key.startsWith(PUBLIC_MEDIA_PREFIX) || key.includes('..')) {
    return undefined;
  }
  return `/${key}`;
}

/** @deprecated 2026-09-02 — use `mediaUrl`, which is the same thing without the workshop-specific name. */
export function workshopPosterUrl(posterKey: string): string | undefined {
  return mediaUrl(posterKey);
}

// 2026-08-31: the two Cognito user pool ids, so the browser can tell a
// patient's token from a clinician's (`auth/token-claims.ts` reads them
// out of the access token's `iss`). Not secret by any measure — a pool id
// is in every JWKS URL, in the hosted-UI domain, and in any client that
// verifies one of these tokens — and hardcoded here rather than looked up
// at build time, the same convention `contentApiUrl` above documents for
// a stable, manually-obtained AWS identifier. Mirrors
// infra/src/config.ts's `PATIENT_USER_POOL_ID`/`CLINICIAN_USER_POOL_ID`.
//
// Used **only to decide what to render**. Nothing here is an
// authorisation check; every route re-derives the caller's role from a
// verified token inside the Lambda authorizer.
export const patientUserPoolIssuer =
  'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_lMonWXA0b';
export const clinicianUserPoolIssuer =
  'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_1SFN2y0Jt';
