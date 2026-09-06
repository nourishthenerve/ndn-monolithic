// 2026-09-06: the allowlist both halves of the rich-text boundary read from.
//
// Tested on its own because it is the one file where being wrong is not a
// rendering bug: a `href` check that lets `javascript:` through is a stored
// XSS on a page every reader of the site loads, and a `src` check that lets
// an external origin through is a silent CSP block that looks like a broken
// image. The cases below are the ones that have historically defeated
// hand-written filters, not the ones that are obviously fine.
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TAGS,
  DROPPED_WITH_CONTENT,
  EXTERNAL_LINK_REL,
  isAllowedAttribute,
  isAllowedStyle,
  isExternalHref,
  isSafeHref,
  isSafeImageSrc,
} from './policy.js';

describe('isSafeHref', () => {
  it('allows the four shapes a post actually needs', () => {
    expect(isSafeHref('https://example.org/page')).toBe(true);
    expect(isSafeHref('mailto:hello@example.org')).toBe(true);
    expect(isSafeHref('tel:+441234567890')).toBe(true);
    expect(isSafeHref('/en/workshops')).toBe(true);
    expect(isSafeHref('#further-reading')).toBe(true);
  });

  it('refuses javascript:, in the spellings that get past a naive check', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    // Case, leading whitespace and a newline inside the scheme are all things
    // browsers forgive and a prefix comparison does not.
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
  });

  it('refuses data: and vbscript:, which are the same problem wearing a different scheme', () => {
    expect(isSafeHref('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
  });

  it('refuses plain http, which the site cannot serve without a mixed-content warning', () => {
    expect(isSafeHref('http://example.org')).toBe(false);
  });

  it('refuses a protocol-relative URL, which reads as a path and is not one', () => {
    // `//evil.example` looks like it starts at the site root. It does not.
    expect(isSafeHref('//evil.example/page')).toBe(false);
  });

  it('refuses a backslash in a site-relative path', () => {
    // Some browsers treat a backslash as a path separator, so this reads as
    // an origin rather than a path on this site.
    expect(isSafeHref('/\\evil.example')).toBe(false);
  });

  it('refuses an empty or whitespace-only href', () => {
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('   ')).toBe(false);
  });
});

describe('isSafeImageSrc', () => {
  it('allows this site own public media prefix, and only that', () => {
    expect(isSafeImageSrc('/media/2026/photo.jpg')).toBe(true);
    expect(isSafeImageSrc('https://cdn.example.org/photo.jpg')).toBe(false);
    expect(isSafeImageSrc('/uploads/photo.jpg')).toBe(false);
  });

  it('refuses a data URI, however small', () => {
    // Allowed by the CSP and refused here anyway: a base64 photograph inlined
    // into a database record is a several-megabyte row no reader can cache.
    expect(isSafeImageSrc('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(false);
  });

  it('refuses traversal out of the prefix', () => {
    expect(isSafeImageSrc('/media/../private/scan.jpg')).toBe(false);
  });
});

describe('isAllowedStyle', () => {
  it('allows the four alignments the toolbar can produce, as browsers serialise them', () => {
    expect(isAllowedStyle('text-align: center')).toBe(true);
    expect(isAllowedStyle('text-align:center;')).toBe(true);
    expect(isAllowedStyle('TEXT-ALIGN: RIGHT;')).toBe(true);
  });

  it('refuses anything that is not one of them', () => {
    expect(isAllowedStyle('position: fixed; inset: 0')).toBe(false);
    expect(isAllowedStyle('background: url(https://evil.example/p.gif)')).toBe(false);
    // One good declaration does not carry a bad one in beside it.
    expect(isAllowedStyle('text-align: center; position: fixed')).toBe(false);
    expect(isAllowedStyle('')).toBe(false);
  });
});

describe('isAllowedAttribute', () => {
  it('refuses every event handler, on every element', () => {
    for (const tag of ['p', 'a', 'img', 'td']) {
      expect(isAllowedAttribute(tag, 'onclick', 'alert(1)')).toBe(false);
      expect(isAllowedAttribute(tag, 'onerror', 'alert(1)')).toBe(false);
      expect(isAllowedAttribute(tag, 'onload', 'alert(1)')).toBe(false);
    }
  });

  it('refuses class and id, which would let a post reach the site own stylesheet', () => {
    expect(isAllowedAttribute('p', 'class', 'ndn-nav')).toBe(false);
    expect(isAllowedAttribute('p', 'id', 'main')).toBe(false);
  });

  it('allows an empty alt, which is a statement rather than an omission', () => {
    // A missing alt is what axe flags; `alt=""` says "decorative" on purpose.
    expect(isAllowedAttribute('img', 'alt', '')).toBe(true);
  });

  it('pins target and rel to the one pair the sanitiser sets', () => {
    expect(isAllowedAttribute('a', 'target', '_blank')).toBe(true);
    expect(isAllowedAttribute('a', 'target', '_top')).toBe(false);
    expect(isAllowedAttribute('a', 'rel', EXTERNAL_LINK_REL)).toBe(true);
    // Anything else would let an author drop the opener protection back off.
    expect(isAllowedAttribute('a', 'rel', 'opener')).toBe(false);
  });

  it('does not allow style on an element the list does not name', () => {
    expect(isAllowedAttribute('p', 'style', 'text-align:center')).toBe(true);
    expect(isAllowedAttribute('strong', 'style', 'text-align:center')).toBe(false);
  });
});

describe('the two lists', () => {
  it('never names the same tag twice', () => {
    // A tag in both would be ambiguous: dropped with its content, or kept?
    for (const tag of DROPPED_WITH_CONTENT) {
      expect(ALLOWED_TAGS.has(tag), `"${tag}" is both allowed and dropped`).toBe(false);
    }
  });

  it('drops the elements whose text is the payload rather than prose', () => {
    for (const tag of ['script', 'style', 'iframe', 'form']) {
      expect(DROPPED_WITH_CONTENT.has(tag)).toBe(true);
    }
  });

  it('allows no element that can position itself or run anything', () => {
    for (const tag of ['div', 'span', 'script', 'style', 'iframe', 'object', 'button']) {
      expect(ALLOWED_TAGS.has(tag), `"${tag}" must not be renderable from a post`).toBe(false);
    }
  });
});

describe('isExternalHref', () => {
  it('is true only for something that leaves this site', () => {
    expect(isExternalHref('https://example.org')).toBe(true);
    expect(isExternalHref('/en/blog')).toBe(false);
    expect(isExternalHref('#top')).toBe(false);
    expect(isExternalHref('mailto:hello@example.org')).toBe(false);
  });
});
