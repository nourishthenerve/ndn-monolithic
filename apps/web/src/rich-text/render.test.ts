// 2026-09-06: the read half of the boundary — the one that runs at build
// time, in Node, with no DOM, over values it did not write.
//
// Two things are being pinned here. First that it says yes to what the
// sanitiser produces, because a validator that rejects our own output would
// quietly turn every formatted post back into plain text and nobody would see
// an error. Second that it says **no**, and only no, to everything else: it
// has no rewrite to fall back on, so a "maybe" is a page injection.
import { describe, expect, it } from 'vitest';

import {
  decodeAttributeValue,
  isEmptyRichText,
  isSafeRichText,
  looksLikeMarkup,
  renderableRichText,
  richTextToPlainText,
  toPlainParagraphs,
} from './render.js';

describe('isSafeRichText', () => {
  it('accepts a whole post of the kind the editor writes', () => {
    const post =
      '<h2>Winter mobility</h2>' +
      '<p style="text-align: center">Some <strong>bold</strong> text.</p>' +
      '<ul><li>One</li><li>Two</li></ul>' +
      '<blockquote>A quote.</blockquote>' +
      '<figure><img src="/media/a.jpg" alt="A chair"><figcaption>Caption</figcaption></figure>' +
      '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>' +
      '<a href="https://example.org" target="_blank" rel="noopener noreferrer">Out</a>' +
      '<hr><pre><code>code</code></pre>';
    expect(isSafeRichText(post)).toBe(true);
  });

  it('accepts text with no markup in it at all', () => {
    expect(isSafeRichText('Just a sentence.')).toBe(true);
  });

  it('refuses a tag that is not on the list', () => {
    expect(isSafeRichText('<script>alert(1)</script>')).toBe(false);
    expect(isSafeRichText('<p>ok</p><iframe src="/x"></iframe>')).toBe(false);
    expect(isSafeRichText('<div>ok</div>')).toBe(false);
  });

  it('refuses an attribute the list does not allow, event handlers first', () => {
    expect(isSafeRichText('<p onclick="alert(1)">x</p>')).toBe(false);
    expect(isSafeRichText('<img src="/media/a.jpg" onerror="alert(1)" alt="">')).toBe(false);
    expect(isSafeRichText('<p class="ndn-nav">x</p>')).toBe(false);
  });

  it('refuses a href that would not survive the policy', () => {
    expect(isSafeRichText('<a href="javascript:alert(1)">x</a>')).toBe(false);
    expect(isSafeRichText('<a href="/en/blog">x</a>')).toBe(true);
  });

  it('decodes a character reference before judging it, which is the trick a prefix check misses', () => {
    // No colon appears in this string until a parser resolves `&#58;`, at
    // which point it is a working `javascript:` URL.
    expect(isSafeRichText('<a href="javascript&#58;alert(1)">x</a>')).toBe(false);
    expect(isSafeRichText('<a href="javascript&#x3a;alert(1)">x</a>')).toBe(false);
  });

  it('refuses an entity it did not resolve, rather than guessing what it means', () => {
    // A serialiser writes the character itself, never `&colon;` — so one here
    // is evidence the string did not come from our editor.
    expect(isSafeRichText('<a href="javascript&colon;alert(1)">x</a>')).toBe(false);
  });

  it('keeps an ampersand that is honestly an ampersand', () => {
    expect(isSafeRichText('<a href="/search?a=1&amp;b=2">x</a>')).toBe(true);
  });

  it('refuses an unquoted attribute value, where one attribute and two look the same', () => {
    expect(isSafeRichText('<a href=/a onclick=alert(1)>x</a>')).toBe(false);
  });

  it('refuses a stray angle bracket, which sanitised output never contains', () => {
    // Escaped, this is fine; unescaped it is the start of a tag as far as a
    // browser is concerned, so it is evidence the string is not ours.
    expect(isSafeRichText('<p>5 < 6</p>')).toBe(false);
    expect(isSafeRichText('<p>5 &lt; 6</p>')).toBe(true);
  });

  it('refuses a comment, including the conditional kind', () => {
    expect(isSafeRichText('<p>a</p><!--[if IE]><script>x</script><![endif]-->')).toBe(false);
  });
});

describe('renderableRichText', () => {
  it('hands back markup a page may inject', () => {
    expect(renderableRichText('<p>Hello</p>')).toBe('<p>Hello</p>');
  });

  it('answers undefined for plain text, which is how every post written before today is stored', () => {
    expect(renderableRichText('One paragraph.\n\nAnother.')).toBeUndefined();
  });

  it('answers undefined rather than throwing for something it cannot vouch for', () => {
    // The caller renders the body as plain text — which is exactly what these
    // pages did before this feature existed, so the failure mode is "no
    // formatting" and never "a page nobody checked".
    expect(renderableRichText('<script>alert(1)</script>')).toBeUndefined();
  });
});

describe('richTextToPlainText', () => {
  it('flattens a formatted body into one line, for a meta description', () => {
    expect(richTextToPlainText('<h2>Title</h2><p>Body <strong>text</strong>.</p>')).toBe(
      'Title Body text.',
    );
  });

  it('does not run two blocks together', () => {
    // "end.Next" is what dropping the tags without a space produces.
    expect(richTextToPlainText('<p>end.</p><p>Next</p>')).toBe('end. Next');
  });

  it('decodes the entities a serialiser emits', () => {
    expect(richTextToPlainText('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
  });

  it('leaves plain text alone', () => {
    expect(richTextToPlainText('Just a sentence.')).toBe('Just a sentence.');
  });
});

describe('isEmptyRichText', () => {
  it('recognises the shapes an untouched contenteditable actually holds', () => {
    // None of these is the empty string, and a `<div>` cannot carry
    // `required`, so without this a post with no words in it would publish.
    expect(isEmptyRichText('')).toBe(true);
    expect(isEmptyRichText('<p><br></p>')).toBe(true);
    expect(isEmptyRichText('<br>')).toBe(true);
    expect(isEmptyRichText('<p>&nbsp;</p>')).toBe(true);
  });

  it('counts an image or a table as content, even with no text beside it', () => {
    expect(isEmptyRichText('<img src="/media/a.jpg" alt="">')).toBe(false);
    expect(isEmptyRichText('<table><tbody><tr><td></td></tr></tbody></table>')).toBe(false);
  });

  it('is false the moment there are words', () => {
    expect(isEmptyRichText('<p>Hello</p>')).toBe(false);
  });
});

describe('the plain-text reading, unchanged', () => {
  it('still splits on blank lines', () => {
    expect(toPlainParagraphs('One.\n\nTwo.')).toEqual(['One.', 'Two.']);
  });

  it('knows markup when it sees it', () => {
    expect(looksLikeMarkup('<p>x</p>')).toBe(true);
    expect(looksLikeMarkup('5 < 6 is true')).toBe(false);
  });
});

describe('decodeAttributeValue', () => {
  it('resolves amp last, so a double encoding cannot produce the character it hides', () => {
    // Decoding `&amp;` first would turn this into `<`, which is the whole
    // trick.
    expect(decodeAttributeValue('&amp;lt;')).toBe('&lt;');
  });
});
