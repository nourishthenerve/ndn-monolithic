// 2026-09-06: what a formatted blog post or workshop description is allowed
// to contain.
//
// The owner: *"when I click them it should open a pretty rich formatable kind
// of page to let the person create a nice blog post - something the way
// wordpress offers where you can really format how the blog post will look
// like when published."*
//
// ## Why an allowlist is the first file rather than the last
//
// A rich editor means the `body` field stops being text and becomes **markup
// that a build step will inject into a page verbatim**. Every other string in
// this app is escaped by React or by Astro on the way out; this one, by
// definition, cannot be. So the boundary has to be a stated policy that both
// ends of the pipe read from, not a judgement made twice:
//
//   * `sanitize.ts` runs in the author's browser and rewrites what the editor
//     produced down to this list, on every keystroke;
//   * `render.ts` runs at build time in Node — and in the browser for the
//     live-fallback views — and **re-checks** a stored value against the same
//     list before any page injects it, falling back to plain text if it does
//     not pass.
//
// Two passes over one policy, because the two run at different times on
// different machines: the sanitiser cannot vouch for a record written before
// it existed, by a different client, or by anyone calling `POST /content`
// directly, which the API allows and always has.
//
// ## The shape of the list
//
// Structure and emphasis, no layout and no scripting. What is *absent* is as
// deliberate as what is here: no `<div>`, `<span>`, `<script>`, `<style>`,
// `<iframe>`, `<form>`, no `class`, no `id`, no event handler, no arbitrary
// `style`. A post is prose, and prose that can position itself is prose that
// can cover the site's own navigation.

/**
 * Elements a stored body may contain.
 *
 * `<table>` and friends are here because a workshop schedule is a real thing
 * an author wants to write, and the editor can insert one. `<figure>`/
 * `<figcaption>` are here so an image can carry a caption that stays attached
 * to it.
 */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'h2',
  'h3',
  'h4',
  'strong',
  'em',
  'u',
  's',
  'sub',
  'sup',
  'mark',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'a',
  'img',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);

/**
 * Elements whose *content* goes with them.
 *
 * Everything not in `ALLOWED_TAGS` is unwrapped by default — a `<span>`
 * disappears and the words inside it stay, which is what an author means by
 * "paste this paragraph in". These are the exceptions, where the text inside
 * the tag is not prose at all but the payload: unwrapping `<script>` would
 * paste its source into the article, and unwrapping `<style>` would paste a
 * stylesheet.
 */
export const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'link',
  'meta',
  'title',
  'head',
  'base',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'dialog',
  'slot',
]);

/** Attributes each element may keep. Everything else is dropped, including every `on*`. */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt'],
  // Alignment is the one piece of presentation the toolbar offers, and
  // browsers express it as an inline style. Confined to `text-align` by
  // `isAllowedStyle` — see there.
  p: ['style'],
  h2: ['style'],
  h3: ['style'],
  h4: ['style'],
  li: ['style'],
  blockquote: ['style'],
  figcaption: ['style'],
  td: ['style'],
  th: ['style'],
};

/**
 * The alignments the toolbar can produce, and the only declarations any
 * `style` attribute may carry.
 *
 * A general `style` allowance would be a general layout allowance —
 * `position: fixed` over the site header is a one-line defacement — so the
 * check is against a closed set of complete declarations rather than a parse
 * of arbitrary CSS.
 */
const ALLOWED_STYLE_DECLARATIONS: ReadonlySet<string> = new Set([
  'text-align:left',
  'text-align:center',
  'text-align:right',
  'text-align:justify',
]);

/**
 * `true` for a `style` value made only of allowed declarations.
 *
 * Whitespace and a trailing semicolon are tolerated because that is what
 * browsers serialise; anything else — a second property, a `!important`, a
 * `url()`, a comment — fails the whole attribute, which is then dropped.
 */
export function isAllowedStyle(value: string): boolean {
  const declarations = value
    .split(';')
    .map((part) => part.replace(/\s+/g, '').toLowerCase())
    .filter((part) => part.length > 0);
  if (declarations.length === 0) {
    return false;
  }
  return declarations.every((declaration) => ALLOWED_STYLE_DECLARATIONS.has(declaration));
}

/**
 * C0 controls and DEL, which have no business in a URL and are how a scheme
 * gets smuggled past a prefix check: a tab inside `java<TAB>script:` still
 * runs in more than one browser, and no author types one into a link box by
 * accident. Checked before the scheme, so every branch below is looking at a
 * string of printable characters.
 *
 * A loop rather than the character class this obviously wants to be:
 * `no-control-regex` bans one, this repo bans disable comments
 * (`scripts/check-no-disable-comments.mjs`), and the rule is right in
 * general even though this is the one place a control character is the
 * subject rather than a mistake.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Where a link in a post may point.
 *
 * `https:`, `mailto:` and `tel:` by name, plus same-site paths and in-page
 * fragments. Everything else is refused, which most importantly covers
 * `javascript:` — the reason this function exists — but also `data:`
 * (an entire HTML document can be a link target that way) and
 * protocol-relative `//host`, which reads as a path and is not one.
 *
 * `http:` is refused too: the site is HTTPS-only, and a plain-http link from
 * an article is a mixed-content warning at best.
 */
export function isSafeHref(value: string): boolean {
  const href = value.trim();
  if (href.length === 0 || hasControlCharacter(href)) {
    return false;
  }
  if (href.startsWith('//')) {
    return false;
  }
  if (href.startsWith('/') || href.startsWith('#')) {
    // No control characters, and no `\` — a backslash is a path separator to
    // some browsers and would let `/\evil.example` read as an origin.
    return !href.includes('\\');
  }
  return /^(https:\/\/|mailto:|tel:)/i.test(href);
}

/** The prefix `site-config.ts`'s own `mediaUrl` serves from, restated — `apps/web` builds these paths in two places and they must agree. */
const PUBLIC_MEDIA_PATH = '/media/';

/**
 * Where an image in a post may come from: this site's own public media
 * prefix, and nowhere else.
 *
 * Not a hardening afterthought but the only thing that *works*. The site's
 * CSP is `img-src 'self' data:` (`infra/src/web-stack.ts`), so an image from
 * any other origin is blocked by the browser and renders as a broken box —
 * and `data:` is refused here regardless, because a base64 photograph inlined
 * into a database record is a several-megabyte row that no reader can cache.
 *
 * Every image the editor inserts arrives through the same presign-then-PUT
 * flow `MediaUploadField` uses, so it always has a key under this prefix.
 */
export function isSafeImageSrc(value: string): boolean {
  const src = value.trim();
  return (
    src.startsWith(PUBLIC_MEDIA_PATH) &&
    !src.includes('..') &&
    !src.includes('\\') &&
    !hasControlCharacter(src)
  );
}

/** `rel` on an outbound link, forced rather than trusted — see `sanitize.ts`. */
export const EXTERNAL_LINK_REL = 'noopener noreferrer';

/** `true` for an href that leaves this site, and so needs `EXTERNAL_LINK_REL`. */
export function isExternalHref(value: string): boolean {
  return /^https:\/\//i.test(value.trim());
}

/**
 * Whether one attribute is allowed on one element, value included.
 *
 * The single question both the sanitiser and the validator ask, so the two
 * cannot drift into disagreeing about, say, whether `target` is allowed on a
 * link.
 */
export function isAllowedAttribute(tag: string, name: string, value: string): boolean {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed || !allowed.includes(name)) {
    return false;
  }
  if (name === 'href') {
    return isSafeHref(value);
  }
  if (name === 'src') {
    return isSafeImageSrc(value);
  }
  if (name === 'style') {
    return isAllowedStyle(value);
  }
  if (name === 'target') {
    return value === '_blank';
  }
  if (name === 'rel') {
    return value === EXTERNAL_LINK_REL;
  }
  // `alt` — any text, including the empty string, which is the correct value
  // for a decorative image and must not be confused with a missing one.
  return true;
}
