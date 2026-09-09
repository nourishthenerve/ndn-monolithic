// @vitest-environment jsdom
//
// 2026-09-06: the editor, as far as jsdom can drive it.
//
// jsdom implements neither `document.execCommand` nor `queryCommandState`,
// which is precisely why `RichTextEditor` takes both as props — so the thing
// under test here is what the component *asks the browser to do*, which is
// the half that can be got wrong in a way no amount of clicking around would
// reveal. Whether Chrome's `insertUnorderedList` produces a good `<ul>` is
// Chrome's business, and the sanitiser is what makes that answer not matter.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RichTextEditor } from './RichTextEditor.js';
import type { RichTextEditorStrings } from './RichTextEditor.js';

afterEach(cleanup);

const STRINGS: RichTextEditorStrings = {
  label: 'Post content',
  hint: 'Use the toolbar.',
  linkUrlLabel: 'Link address',
  linkApply: 'Insert link',
  linkInvalid: 'That address cannot be used.',
  imageChooseLabel: 'Image file',
  imageAltLabel: 'Describe the image',
  imageAltHint: 'One short sentence.',
  imageCaptionLabel: 'Caption (optional)',
  imageInsert: 'Insert image',
  imageUploading: 'Uploading the image...',
  imageFailed: 'That image could not be uploaded.',
  imageTooLarge: 'Too large.',
  imageWrongType: 'Wrong type.',
  cancel: 'Cancel',
  colorTextLabel: 'Choose a text colour',
  colorHighlightLabel: 'Choose a highlight colour',
  colorRemoveHighlight: 'Remove highlight',
  previewNotice: 'Preview: this is how the published page will look.',
};

function renderEditor(overrides: Partial<React.ComponentProps<typeof RichTextEditor>> = {}) {
  const exec = vi.fn();
  const onChange = vi.fn();
  render(
    <RichTextEditor
      locale="en"
      strings={STRINGS}
      presignPath="/content/media-upload-url"
      value=""
      onChange={onChange}
      exec={exec}
      queryState={() => false}
      {...overrides}
    />,
  );
  return { exec, onChange };
}

describe('the toolbar', () => {
  it('offers the formatting a person expects to find, by name', () => {
    renderEditor();
    // Named, not counted: a count passes while every button says "button".
    for (const name of [
      'Bold',
      'Italic',
      'Underline',
      'Strikethrough',
      'Heading',
      'Subheading',
      'Quote',
      'Code block',
      'Bulleted list',
      'Numbered list',
      'Align centre',
      'Add link',
      'Insert image',
      'Insert table',
      'Horizontal line',
      'Undo',
      'Redo',
      'Clear formatting',
      'Preview',
    ]) {
      expect(screen.getByRole('button', { name }), `no "${name}" control`).toBeDefined();
    }
  });

  it('is one tab stop, not twenty-nine', () => {
    // A roving tabindex: exactly one button is reachable by Tab, and the
    // arrows move within the toolbar. Twenty-nine tab stops between the title
    // field and the writing surface would be worse than the textarea this
    // replaces.
    renderEditor();
    const buttons = screen.getAllByRole('button');
    const tabbable = buttons.filter((button) => button.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);
    expect(buttons.length).toBeGreaterThan(20);
  });

  it('moves focus with the arrow keys', () => {
    renderEditor();
    const toolbar = screen.getByRole('toolbar');
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Redo' }).getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(toolbar, { key: 'Home' });
    expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('tabindex')).toBe('0');
  });

  it('issues the command the button stands for', () => {
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(exec).toHaveBeenCalledWith('bold', undefined);
  });

  it('turns styleWithCSS off for structural commands, so the output is semantic', () => {
    // On, an engine emits `<span style="font-weight:bold">` for bold — which
    // the sanitiser then unwraps, losing the emphasis entirely.
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(exec).toHaveBeenNthCalledWith(1, 'styleWithCSS', 'false');
    expect(exec).toHaveBeenNthCalledWith(2, 'italic', undefined);
  });

  it('passes a heading tag in angle brackets', () => {
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    expect(exec).toHaveBeenCalledWith('formatBlock', '<h2>');
  });

  it('inserts a table rather than asking the author to build one', () => {
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Insert table' }));
    const inserted = exec.mock.calls.find(([command]) => command === 'insertHTML');
    expect(inserted?.[1]).toContain('<table>');
  });

  it('does not take focus from the surface when a control is pressed', () => {
    // A `<button>` takes focus on mousedown, which collapses the selection
    // before the click handler runs — so the command would apply to nothing.
    renderEditor();
    const bold = screen.getByRole('button', { name: 'Bold' });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bold.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('adding a link', () => {
  it('refuses an address the policy would not keep, and says so', () => {
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link address'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(screen.getByRole('button', { name: STRINGS.linkApply }));

    expect(screen.getByRole('alert').textContent).toBe(STRINGS.linkInvalid);
    expect(exec.mock.calls.some(([command]) => command === 'createLink')).toBe(false);
  });

  it('accepts an ordinary address and closes the panel', () => {
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    fireEvent.change(screen.getByLabelText('Link address'), {
      target: { value: 'https://example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: STRINGS.linkApply }));

    // No selection exists in jsdom, so this takes the collapsed-caret path:
    // the URL becomes its own link text, which is what pressing "add link"
    // with nothing selected means.
    const inserted = exec.mock.calls.find(([command]) => command === 'insertHTML');
    expect(inserted?.[1]).toContain('href="https://example.org"');
    expect(screen.queryByLabelText('Link address')).toBeNull();
  });
});

describe('the writing surface', () => {
  it('is a labelled multi-line textbox, not an anonymous div', () => {
    renderEditor();
    const surface = screen.getByRole('textbox', { name: 'Post content' });
    expect(surface.getAttribute('aria-multiline')).toBe('true');
    expect(surface.getAttribute('contenteditable')).toBe('true');
  });

  it('is seeded from the value it is given, since it cannot be rendered from it', () => {
    renderEditor({ value: '<p>Existing post</p>' });
    expect(screen.getByRole('textbox').innerHTML).toBe('<p>Existing post</p>');
  });

  it('sanitises on the way out, so the form never holds what the browser invented', () => {
    const { onChange } = renderEditor();
    const surface = screen.getByRole('textbox');
    surface.innerHTML = '<p onclick="alert(1)">Hello <b>there</b></p>';
    fireEvent.input(surface);
    expect(onChange).toHaveBeenCalledWith('<p>Hello <strong>there</strong></p>');
  });

  it('cleans a paste before it reaches the document, not afterwards', () => {
    // A paste from Word carries a stylesheet and several hundred spans.
    const { exec } = renderEditor();
    const surface = screen.getByRole('textbox');
    fireEvent.paste(surface, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html' ? '<div class="WordSection1"><span>Hello</span></div>' : 'Hello',
      },
    });
    expect(exec).toHaveBeenCalledWith('insertHTML', '<p>Hello</p>');
  });

  it('reconciles the surface on blur, when there is no caret to lose', () => {
    const { onChange } = renderEditor();
    const surface = screen.getByRole('textbox');
    surface.innerHTML = '<p>Hi</p><script>alert(1)</script>';
    fireEvent.blur(surface);
    expect(surface.innerHTML).toBe('<p>Hi</p>');
    expect(onChange).toHaveBeenLastCalledWith('<p>Hi</p>');
  });
});

describe('the preview', () => {
  it('swaps the surface for the published rendering of the same markup', () => {
    renderEditor({ value: '<h2>Title</h2><p>Body</p>' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(STRINGS.previewNotice)).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Title', level: 2 })).toBeDefined();
  });

  it('shows nothing for a body the validator would refuse, rather than a friendlier version of it', () => {
    // The preview runs the same two passes a published page does, so an
    // author cannot be shown something a reader would not get.
    //
    // 2026-09-09: the article is now a child of the preview box rather than
    // the box itself — the box is the width of the toolbar, the article
    // inside it keeps the published 68ch measure. The guarantee is
    // unchanged; the element holding it moved, so the query follows it.
    renderEditor({ value: '<script>alert(1)</script>' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(document.querySelector('.ndn-rte-preview-body')?.innerHTML).toBe('');
  });
});

// 2026-09-09: colour. jsdom implements neither `execCommand` nor selection
// well enough to prove what lands in the document — that is checked in
// `sanitize.test.ts` against real Chromium output — so what is asserted here
// is the half this component owns: that the swatches are offered, named, and
// hand the engine a palette value with `styleWithCSS` on.
describe('colour', () => {
  it('offers a swatch per palette entry, named rather than hexed', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Text colour' }));
    const group = screen.getByRole('group', { name: STRINGS.colorTextLabel });
    expect(group).toBeDefined();
    // Named from the catalogue: "Lavender", not "#65558f".
    expect(screen.getByRole('button', { name: 'Lavender' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /#/ })).toBeNull();
  });

  it('paints with styleWithCSS on, because colour has no element of its own', () => {
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Text colour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lavender' }));
    expect(exec).toHaveBeenCalledWith('styleWithCSS', 'true');
    expect(exec).toHaveBeenCalledWith('foreColor', '#65558f');
  });

  it('removes a highlight with the value the policy refuses', () => {
    // The span unwraps on the next sanitise — see `REMOVE_HIGHLIGHT_VALUE`.
    const { exec } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }));
    fireEvent.click(screen.getByRole('button', { name: STRINGS.colorRemoveHighlight }));
    expect(exec).toHaveBeenCalledWith('hiliteColor', 'transparent');
  });

  it('keeps the caret when a swatch is pressed', () => {
    // Same reason as every toolbar button: a `<button>` takes focus on
    // mousedown, which collapses the selection the colour is meant for.
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Text colour' }));
    const swatch = screen.getByRole('button', { name: 'Olive' });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    swatch.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
