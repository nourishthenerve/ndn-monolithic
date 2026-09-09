// 2026-09-06: the write half of the rich-text boundary — what the editor
// produced, rewritten down to `policy.ts`'s list before it is ever put in
// React state, let alone sent to the API.
//
// ## Why this is DOM-based and `render.ts` is not
//
// This one runs in the author's browser, where a real HTML parser is already
// present and is the *same* parser that produced the markup being cleaned.
// That matters more than it sounds: a `contenteditable` surface emits
// whatever the browser felt like emitting for a keystroke or a paste —
// `<b>` in one, `<span style="font-weight:700">` in another, a whole Word
// document's worth of `<o:p>` and `<style>` in a paste from Outlook — and
// the only thing that reliably normalises that soup is handing it back to
// the parser and walking the tree it builds.
//
// `render.ts` cannot do this. It runs at build time in Node, where there is
// no DOM, and its job is different anyway: not "rewrite this into something
// safe" but "is this already safe, yes or no". A rewriter that guesses is
// the wrong shape for a build step whose output goes straight into a page.
//
// ## Unwrap by default, drop by exception
//
// An element that is not on the list loses its tag and keeps its words. That
// is what an author means when they paste three paragraphs out of a Google
// Doc: they want the sentences, not the forty `<span>`s. The exceptions are
// in `DROPPED_WITH_CONTENT`, where the text *is* the payload — unwrapping a
// `<script>` would paste its source into the article as prose.
//
// ## Stability is a requirement, not a nicety
//
// `RichTextEditor` sanitises on every input event and compares the result
// against what it last handed upward, to decide whether the surface needs
// re-seeding. If `sanitize(sanitize(x)) !== sanitize(x)` for any `x`, that
// comparison never settles and the caret is reset on every keystroke. Hence
// the rewrites below are idempotent by construction: `b` becomes `strong`,
// and `strong` stays `strong`.
import {
  ALLOWED_TAGS,
  DROPPED_WITH_CONTENT,
  EXTERNAL_LINK_REL,
  isAllowedAttribute,
  isExternalHref,
  isSafeHref,
  isSafeImageSrc,
} from './policy.js';

/**
 * Presentational tags mapped onto the semantic ones the policy allows.
 *
 * `h1` is here for a reason of its own rather than for semantics: every page
 * that renders a post already emits the title as the document's `<h1>`, so a
 * second one inside the body breaks the heading outline that
 * `tests/pr-env`'s axe sweep checks. Demoting it keeps the author's intent
 * (this is the top-level heading of my article) and the page's structure at
 * the same time. `h5`/`h6` fold up to `h4` for the mirror-image reason: the
 * stylesheet gives three body heading levels and nothing renders a fourth.
 *
 * `div` becomes `p` rather than unwrapping, because a `contenteditable`
 * surface uses divs as *lines*. Unwrapping them would run every paragraph of
 * a post together into one.
 */
const TAG_REWRITES: Readonly<Record<string, string>> = {
  b: 'strong',
  i: 'em',
  strike: 's',
  del: 's',
  ins: 'u',
  h1: 'h2',
  h5: 'h4',
  h6: 'h4',
  div: 'p',
  section: 'p',
  article: 'p',
  caption: 'figcaption',
};

/** Elements with no children to recurse into; `appendChild` on one throws in some engines. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img']);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Injectable so tests can drive this with jsdom's parser explicitly, and so the module never touches a global at import time. */
export type ParseHtml = (html: string) => HTMLElement;

/**
 * The browser's own parser, in an inert document.
 *
 * `DOMParser`, not `innerHTML` on a detached `<div>`: a detached div still
 * belongs to the live document, so `<img src=x onerror=...>` inside it
 * **fires** while being parsed, before a single line of this file has looked
 * at it. `parseFromString` builds a document with no browsing context, where
 * nothing loads and nothing executes.
 */
function defaultParse(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, 'text/html').body;
}

function sanitizeInto(source: Element, target: Element, doc: Document): void {
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      target.appendChild(doc.createTextNode(node.nodeValue ?? ''));
      continue;
    }
    // Comments, processing instructions, CDATA: not text, not structure,
    // nothing a reader sees. A conditional comment is also one of the older
    // ways to smuggle markup past a filter that only looks at elements.
    if (node.nodeType !== ELEMENT_NODE) {
      continue;
    }

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(tag)) {
      continue;
    }

    const rewritten = TAG_REWRITES[tag] ?? tag;
    if (!ALLOWED_TAGS.has(rewritten)) {
      // Unwrap: the tag goes, the words stay.
      sanitizeInto(element, target, doc);
      continue;
    }

    if (rewritten === 'img') {
      const src = element.getAttribute('src') ?? '';
      if (!isSafeImageSrc(src)) {
        // Dropped whole rather than unwrapped: an image has no text to keep,
        // and a broken `<img>` on a published page is worse than no image.
        continue;
      }
      const image = doc.createElement('img');
      image.setAttribute('src', src.trim());
      // Always present, even when empty. An `alt=""` is a positive statement
      // that the image is decorative; a *missing* alt is the thing axe flags,
      // and an author who skipped the field should not produce one.
      image.setAttribute('alt', element.getAttribute('alt') ?? '');
      target.appendChild(image);
      continue;
    }

    if (rewritten === 'a') {
      const href = element.getAttribute('href') ?? '';
      if (!isSafeHref(href)) {
        // A link that cannot be followed is just its own text — keep the
        // words, lose the anchor. This is where `javascript:` ends up.
        sanitizeInto(element, target, doc);
        continue;
      }
      const anchor = doc.createElement('a');
      anchor.setAttribute('href', href.trim());
      if (isExternalHref(href)) {
        // Set here rather than trusted from the input: `target="_blank"`
        // without `rel` hands the opened page a live `window.opener`, and an
        // author pasting a link has no reason to know that.
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', EXTERNAL_LINK_REL);
      }
      sanitizeInto(element, anchor, doc);
      target.appendChild(anchor);
      continue;
    }

    const clean = doc.createElement(rewritten);
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (isAllowedAttribute(rewritten, name, attribute.value)) {
        clean.setAttribute(name, attribute.value);
      }
    }

    // 2026-09-09: a `<span>` exists in this policy only to carry a colour
    // (see `policy.ts`), so one that kept no attribute is not a span at all
    // — it is a wrapper, and the default for a wrapper here has always been
    // to keep the words and drop the tag.
    //
    // This is load-bearing rather than tidy. A paste from Word carries
    // several hundred `<span>`s with a stylesheet's worth of `style` on
    // each; every one of those declarations fails `isAllowedStyle`, so
    // without this line the attribute would be stripped and the *element*
    // kept, and a pasted page would arrive as hundreds of nested empty
    // spans that grow on every re-sanitise. `sanitize.test.ts` has asserted
    // exactly this unwrapping since before spans were allowed, which is why
    // adding them to the allowlist made that test fail rather than pass.
    //
    // It is also how "Remove highlight" works: the button hands the engine
    // `transparent`, the declaration fails the policy, the attribute goes,
    // and this line then removes the element it lived in.
    if (rewritten === 'span' && clean.attributes.length === 0) {
      sanitizeInto(element, target, doc);
      continue;
    }

    if (!VOID_TAGS.has(rewritten)) {
      sanitizeInto(element, clean, doc);
    }
    target.appendChild(clean);
  }
}

/**
 * One pass of `policy.ts` over whatever the editor currently holds.
 *
 * Returns serialised HTML rather than a node, because that is what the form
 * field stores and what the API is sent — and because a string is the only
 * form of this value the rest of the app is allowed to hold onto.
 */
export function sanitizeRichText(html: string, parse: ParseHtml = defaultParse): string {
  if (html.trim().length === 0) {
    return '';
  }
  const source = parse(html);
  const doc = source.ownerDocument;
  const target = doc.createElement('div');
  sanitizeInto(source, target, doc);
  return target.innerHTML;
}
