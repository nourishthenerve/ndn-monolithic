// @vitest-environment jsdom
//
// 2026-09-06: the write half of the boundary. jsdom because this side is
// DOM-based by design — see `sanitize.ts` on why the author's own browser is
// the right parser for markup that browser just produced.
//
// The cases worth pinning are the two an author actually creates: a paste out
// of Word or a web page, which arrives as several hundred elements of
// someone else's markup, and the small variations between engines for the
// same keystroke.
import { describe, expect, it } from 'vitest';

import { sanitizeRichText } from './sanitize.js';

describe('what an editor produces', () => {
  it('keeps the structure a post is made of', () => {
    const html =
      '<h2>Winter mobility</h2><p>Some <strong>bold</strong> and <em>italic</em> text.</p>' +
      '<ul><li>One</li><li>Two</li></ul><blockquote>A quote.</blockquote>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it('is stable, which the editor depends on to keep the caret', () => {
    // `RichTextEditor` compares `sanitize(innerHTML)` against what it last
    // emitted to decide whether to re-seed the surface. If a second pass
    // changed anything, that comparison would never settle and every
    // keystroke would reset the caret to the start of the post.
    const once = sanitizeRichText('<b>bold</b><div>a line</div><i>italic</i>');
    expect(sanitizeRichText(once)).toBe(once);
  });

  it('normalises the presentational tags engines still emit', () => {
    expect(sanitizeRichText('<b>x</b>')).toBe('<strong>x</strong>');
    expect(sanitizeRichText('<i>x</i>')).toBe('<em>x</em>');
    expect(sanitizeRichText('<strike>x</strike>')).toBe('<s>x</s>');
  });

  it('turns a contenteditable line div into a paragraph rather than unwrapping it', () => {
    // Unwrapping would run every line of the post together into one.
    expect(sanitizeRichText('<div>One</div><div>Two</div>')).toBe('<p>One</p><p>Two</p>');
  });

  it('demotes h1 to h2, because the page title is already the document h1', () => {
    expect(sanitizeRichText('<h1>Title</h1>')).toBe('<h2>Title</h2>');
    expect(sanitizeRichText('<h5>Small</h5>')).toBe('<h4>Small</h4>');
  });
});

describe('a paste from somewhere else', () => {
  it('keeps the words and drops the wrappers', () => {
    const word =
      '<div class="WordSection1"><span style="font-family:Calibri">Hello</span> ' +
      '<span lang="EN-GB">world</span></div>';
    expect(sanitizeRichText(word)).toBe('<p>Hello world</p>');
  });

  it('drops a script outright rather than pasting its source as prose', () => {
    expect(sanitizeRichText('<p>Before</p><script>alert(1)</script><p>After</p>')).toBe(
      '<p>Before</p><p>After</p>',
    );
  });

  it('drops a pasted stylesheet, which would otherwise restyle the whole site', () => {
    expect(sanitizeRichText('<style>body{display:none}</style><p>Hi</p>')).toBe('<p>Hi</p>');
  });

  it('strips every event handler while keeping the element', () => {
    expect(sanitizeRichText('<p onclick="alert(1)">Text</p>')).toBe('<p>Text</p>');
  });

  it('drops an img whose src is not this site own media, rather than shipping a broken one', () => {
    // The CSP would block it anyway; a missing image beats a broken box.
    expect(sanitizeRichText('<img src="https://evil.example/p.gif" alt="x">')).toBe('');
    expect(sanitizeRichText('<img src="x" onerror="alert(1)">')).toBe('');
  });

  it('keeps an img from the media prefix, and always gives it an alt', () => {
    expect(sanitizeRichText('<img src="/media/a.jpg">')).toBe('<img src="/media/a.jpg" alt="">');
  });

  it('unwraps a javascript: link into its own text', () => {
    // The words were real; the link was not. Keeping the text is what an
    // author meant, and dropping the anchor is the whole point.
    expect(sanitizeRichText('<a href="javascript:alert(1)">Click me</a>')).toBe('Click me');
  });

  it('forces rel on an outbound link that opens a new tab', () => {
    const clean = sanitizeRichText('<a href="https://example.org">Out</a>');
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it('leaves a same-site link alone, with no target and no rel', () => {
    expect(sanitizeRichText('<a href="/en/workshops">Workshops</a>')).toBe(
      '<a href="/en/workshops">Workshops</a>',
    );
  });

  it('keeps an allowed alignment and drops every other style', () => {
    expect(sanitizeRichText('<p style="text-align: center">Mid</p>')).toBe(
      '<p style="text-align: center">Mid</p>',
    );
    expect(sanitizeRichText('<p style="position:fixed;inset:0">Cover</p>')).toBe('<p>Cover</p>');
  });

  it('strips comments, which are a classic way to smuggle markup past a filter', () => {
    expect(sanitizeRichText('<p>A</p><!--[if IE]><script>x</script><![endif]--><p>B</p>')).toBe(
      '<p>A</p><p>B</p>',
    );
  });

  it('escapes a stray angle bracket rather than leaving it to be read as a tag', () => {
    expect(sanitizeRichText('<p>5 < 6</p>')).toContain('&lt;');
  });

  it('answers the empty string for nothing at all', () => {
    expect(sanitizeRichText('')).toBe('');
    expect(sanitizeRichText('   ')).toBe('');
  });
});
