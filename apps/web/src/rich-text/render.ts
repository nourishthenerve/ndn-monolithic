// 2026-09-06: the read half of the rich-text boundary — deciding whether a
// stored body may be injected into a page as markup, and answering "no" in a
// way the page can still render something useful from.
//
// ## Why this is not `sanitize.ts` run backwards
//
// Four places render a post's body, and they do not share a runtime:
// `blog/[slug].astro` and `workshops/[slug].astro` run at **build time in
// Node**, where there is no DOM; `LiveBlogPost.tsx` and `LiveWorkshop.tsx`
// run in a browser. A DOM-based rewriter cannot serve the first pair, and
// pulling in a parser to give it one would put an HTML parser in the build
// for the sake of markup that was already sanitised once, by our own editor,
// in the author's own browser.
//
// So this side asks a different question — **is this string already within
// `policy.ts`, yes or no** — and does it with string scanning, which needs no
// DOM and behaves identically in both runtimes. A validator can be strict in
// a way a rewriter cannot: anything it fails to understand is a "no", and a
// "no" is not an error. It falls back to rendering the body as plain text,
// which is exactly what every one of these pages did before this feature
// existed and is never worse than nothing.
//
// ## Why there is a second check at all
//
// The sanitiser runs in the author's browser. That covers everything the
// editor writes from today onward and nothing else: not the posts already in
// the table, written as plain text; not a record written by a future client;
// and not `POST /content` called directly, which the API has always allowed
// for anyone holding the principal's token. A build step that injects a
// database field into every reader's page cannot take the writer's word for
// it — and the cost of not taking it is one pass of string scanning per post.
import {
  ALLOWED_TAGS,
  isAllowedAttribute,
} from './policy.js';

/**
 * One tag, anchored at the start of what it is given.
 *
 * Attribute values **must be quoted**. Unquoted ones are legal HTML and are
 * refused anyway: `href=/a onclick=x` is one attribute or two depending on
 * how carefully you read it, and everything this validator judges comes from
 * a serialiser (`innerHTML`) that always quotes. Refusing the ambiguous form
 * costs nothing real and removes the whole class of parsing disagreement
 * between this and a browser.
 */
const TAG_AT_START =
  /^<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))?)*)\s*\/?>/;

/** Attribute pairs inside a tag, for the group `TAG_AT_START` captured whole. */
const ATTRIBUTE = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

/**
 * A character reference this decoder did not resolve — see
 * `decodeAttributeValue`.
 *
 * The trailing `;` is **required**, and that is the difference between a
 * validator that works and one that rejects half the real links on the site:
 * `?a=1&amp;b=2` decodes to `?a=1&b=2`, and without the semicolon this
 * pattern reads the surviving `&b` as an entity and fails a perfectly
 * ordinary query string.
 *
 * Requiring it is also correct rather than merely convenient. HTML5 decodes a
 * *semicolon-less* named reference in an attribute only for a short legacy
 * list (`&amp`, `&lt`, `&copy`…), and only when the next character is neither
 * `=` nor alphanumeric. Nothing on that list produces a character that can
 * form a scheme — `&colon;`, `&sol;` and `&bsol;` are all modern entities
 * that need their semicolon — so the shapes this check exists to catch cannot
 * appear without one.
 */
const UNRESOLVED_ENTITY = /&[a-zA-Z][a-zA-Z0-9]*;/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  // Last, always: decoding it first would turn `&amp;lt;` into `<` — the
  // double-encoding trick that gets a filter to produce the very character it
  // was checking for.
  '&amp;': '&',
};

/**
 * An attribute value as a browser would see it, before checking what it says.
 *
 * This is the step a naive validator skips and a browser does not:
 * `href="javascript&#58;alert(1)"` carries no colon at all until the parser
 * resolves the reference, at which point it is a working `javascript:` URL.
 * Numeric references are resolved here for that reason, and the handful of
 * named ones a serialiser actually emits.
 *
 * The rest of HTML5's two thousand named entities are deliberately **not**
 * resolved. Anything left looking like one after this is reported by
 * `hasUnresolvedEntity` and fails the attribute — `innerHTML` never emits
 * them (it writes the character itself), so the honest reading of one in
 * stored markup is "this did not come from our editor", which is the case
 * this validator exists for.
 */
export function decodeAttributeValue(value: string): string {
  let decoded = value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    );
  for (const [entity, character] of Object.entries(NAMED_ENTITIES)) {
    decoded = decoded.split(entity).join(character);
  }
  return decoded;
}

function hasUnresolvedEntity(decoded: string): boolean {
  return UNRESOLVED_ENTITY.test(decoded);
}

/**
 * `true` when every tag in `html` is on `policy.ts`'s list, carries only
 * attributes that list allows, and every `<` in the string opens one.
 *
 * That last clause is the one doing quiet work. A stray `<` is not a
 * harmless typo in something about to be injected into a page — it is the
 * start of a tag as far as a browser is concerned — and sanitised output
 * never contains one, because serialisation escapes it. So an unescaped `<`
 * is treated as proof the string was not produced by our sanitiser, and the
 * whole body falls back to plain text.
 */
export function isSafeRichText(html: string): boolean {
  let index = 0;
  for (;;) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      return true;
    }
    const match = TAG_AT_START.exec(html.slice(open));
    if (!match) {
      return false;
    }
    const tag = (match[1] ?? '').toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return false;
    }
    const attributes = match[2] ?? '';
    const isClosing = html.startsWith('</', open);
    if (isClosing && attributes.trim().length > 0) {
      return false;
    }
    ATTRIBUTE.lastIndex = 0;
    let attribute: RegExpExecArray | null;
    while ((attribute = ATTRIBUTE.exec(attributes)) !== null) {
      const name = (attribute[1] ?? '').toLowerCase();
      const raw = attribute[2] ?? attribute[3] ?? '';
      const value = decodeAttributeValue(raw);
      if (hasUnresolvedEntity(value) || !isAllowedAttribute(tag, name, value)) {
        return false;
      }
    }
    index = open + match[0].length;
  }
}

/** `true` for a body that is trying to be markup at all — anything else is legacy plain text and takes the paragraph path. */
export function looksLikeMarkup(body: string): boolean {
  return /<[a-zA-Z/]/.test(body);
}

/** Tags that end a run of text, and so leave a word gap behind when they are removed. */
const BLOCK_TAG =
  /<\/?(?:p|div|h[1-6]|li|ul|ol|blockquote|pre|br|hr|table|thead|tbody|tr|th|td|figure|figcaption)\b[^>]*>/gi;

const ANY_TAG = /<[^>]*>/g;

/**
 * The body as HTML a page may inject, or `undefined` to say "render this as
 * plain text instead".
 *
 * The single function every rendering site calls, so the four of them cannot
 * end up with four readings of the same stored value. `undefined` covers
 * three genuinely different cases on purpose — a body written before the
 * editor existed, one this validator cannot vouch for, and an empty one —
 * because the caller's response to all three is the same and a caller that
 * had to tell them apart would be a caller with three chances to get it
 * wrong.
 */
export function renderableRichText(body: string): string | undefined {
  if (!looksLikeMarkup(body) || !isSafeRichText(body)) {
    return undefined;
  }
  return body;
}

/** Paragraphs are blank-line separated — the legacy plain-text reading, shared so the build-time and browser renderings break identically. */
export function toPlainParagraphs(body: string): readonly string[] {
  return body.split(/\n{2,}/);
}

/**
 * A formatted body as one line of prose.
 *
 * For `<meta name="description">` and anything else that takes a string
 * rather than markup — a page that puts `<p>Hello</p>` in its own description
 * tag ships those five characters to every search result.
 *
 * **Block tags become a space and inline tags become nothing**, which is not
 * a nicety: replacing every tag with a space turns
 * "Body <strong>text</strong>." into "Body text ." — a stray space before the
 * full stop, in the one string that gets quoted in a search result. Replacing
 * every tag with nothing gets that right and runs "end.</p><p>Next" together
 * as "end.Next" instead. Only telling the two apart gives both.
 */
export function richTextToPlainText(body: string): string {
  if (!looksLikeMarkup(body)) {
    return body.trim();
  }
  const spaced = body.replace(BLOCK_TAG, ' ').replace(ANY_TAG, '');
  return decodeAttributeValue(spaced).replace(/\s+/g, ' ').trim();
}

/**
 * U+00A0. A `contenteditable` inserts one for every space an author types
 * at the end of a line, and `String.prototype.trim` does not remove it -- so
 * a body of nothing but typed spaces reads as non-empty without this.
 */
const NON_BREAKING_SPACE = /\u00a0/g;

/**
 * `true` for a body with nothing in it — including the shapes an empty
 * `contenteditable` actually holds, which are not the empty string.
 *
 * A surface the author has clicked into and left holds `<p><br></p>` in most
 * browsers and `<br>` in some; both are "empty" to a reader and neither is
 * caught by a `required` attribute, which a `div` cannot carry anyway. An
 * image or a rule on its own **is** content, so those keep a body alive with
 * no text in it at all.
 */
export function isEmptyRichText(body: string): boolean {
  if (/<(img|hr|table)\b/i.test(body)) {
    return false;
  }
  return richTextToPlainText(body).replace(NON_BREAKING_SPACE, ' ').trim().length === 0;
}
