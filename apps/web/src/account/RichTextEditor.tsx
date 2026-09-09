// 2026-09-06: the editor itself.
//
// The owner: *"when I click them it should open a pretty rich formatable kind
// of page to let the person create a nice blog post - something the way
// wordpress offers where you can really format how the blog post will look
// like when published. Like it should have all kinds of formatting options to
// create the blog post. Make it as rich as possible - and not simply a text
// box and an option to upload media files."*
//
// What was there before was exactly the thing named: a `<textarea rows={12}>`
// whose contents were split on blank lines and rendered as `<p>`s. An author
// could not make a subheading, a list, a link or a quote, and the picture they
// uploaded could only ever sit at the very top of the article.
//
// ## The shape of the problem
//
// A `contenteditable` cannot be a controlled React input. Writing to
// `innerHTML` on every keystroke destroys the caret, so the DOM has to own the
// document while React owns everything around it. Three rules keep that from
// becoming a mess:
//
//   1. **The surface is seeded, not rendered.** `value` is written into the
//      DOM only when it differs from what this component last sent upward —
//      which is true on mount and after the parent resets the form, and false
//      on every keystroke.
//   2. **What leaves is sanitised, what stays is not.** `onInput` sends
//      `sanitizeRichText(innerHTML)` up. It deliberately does *not* write that
//      back down mid-typing; the DOM is reconciled on blur, when there is no
//      caret to lose. So the value the form holds is always within
//      `policy.ts`, even while the surface briefly holds something the browser
//      invented.
//   3. **Paste is intercepted.** The one moment arbitrary markup arrives in
//      bulk is a paste from Word or a web page, and that is handled before it
//      reaches the DOM at all rather than cleaned up afterwards.
//
// ## The toolbar is one tab stop
//
// `role="toolbar"` with a roving tabindex, arrow keys to move within it. The
// alternative — twenty-seven ordinary buttons — puts twenty-seven tab presses
// between the title field and the place you write the post, which is a worse
// keyboard experience than the plain textarea this replaces.
//
// Toolbar vocabulary is resolved here with `t()` rather than passed down
// through `strings`, which is a deliberate exception to this directory's
// convention. Twenty-seven labels would be twenty-seven lines of pure
// boilerplate on two Astro pages, and this is a `client:only` island, so the
// catalogue is in the browser bundle either way — the same reasoning
// `AppointmentCalendar`'s own `dayAppointmentsLabel` states. Everything with
// a real editorial choice in it (the field label, the hint, the panel copy)
// still arrives as props.
import { t } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Button } from '@ndn/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { isSafeHref } from '../rich-text/policy.js';
import { renderableRichText, richTextToPlainText } from '../rich-text/render.js';
import { sanitizeRichText } from '../rich-text/sanitize.js';
import type { ParseHtml } from '../rich-text/sanitize.js';
import { mediaUrl } from '../site-config.js';

import type { PutFile, RequestUploadUrl } from './media-upload.js';
import {
  ACCEPTED_IMAGE_TYPES,
  defaultPutFile,
  defaultRequestUploadUrl,
  uploadImage,
} from './media-upload.js';
import {
  COLOR_SWATCH_GLYPH,
  HIGHLIGHT_SWATCHES,
  REMOVE_HIGHLIGHT_VALUE,
  RICH_TEXT_CONTROLS,
  RICH_TEXT_GROUPS,
  TABLE_HTML,
  TEXT_COLOR_SWATCHES,
} from './rich-text-controls.js';
import type { ColorSwatch, RichTextControl, RichTextGroup } from './rich-text-controls.js';

export interface RichTextEditorStrings {
  readonly label: string;
  readonly hint: string;
  readonly linkUrlLabel: string;
  readonly linkApply: string;
  readonly linkInvalid: string;
  readonly imageChooseLabel: string;
  readonly imageAltLabel: string;
  readonly imageAltHint: string;
  readonly imageCaptionLabel: string;
  readonly imageInsert: string;
  readonly imageUploading: string;
  readonly imageFailed: string;
  readonly imageTooLarge: string;
  readonly imageWrongType: string;
  readonly cancel: string;
  /** The colour panels: the question each asks, and the one action on them that is not a swatch. */
  readonly colorTextLabel: string;
  readonly colorHighlightLabel: string;
  readonly colorRemoveHighlight: string;
  readonly previewNotice: string;
}

export interface RichTextEditorProps {
  readonly value: string;
  readonly onChange: (html: string) => void;
  readonly strings: RichTextEditorStrings;
  readonly locale: Locale;
  /** Same-origin presign route — `/content/media-upload-url` or `/workshops/media-upload-url`. */
  readonly presignPath: string;
  readonly disabled?: boolean;
  readonly client?: SessionClient;
  /**
   * `document.execCommand`, injected. Not for purity's sake: jsdom implements
   * neither this nor `queryCommandState`, so without a seam every rendered
   * test of this component would be a test of a toolbar that does nothing.
   */
  readonly exec?: (command: string, value?: string) => void;
  readonly queryState?: (command: string) => boolean;
  readonly parseHtml?: ParseHtml;
  readonly requestUploadUrl?: RequestUploadUrl;
  readonly putFile?: PutFile;
}

const defaultClient = createSessionClient();

function defaultExec(command: string, value?: string): void {
  // The middle argument is `showUI`, which every engine ignores and which the
  // spec says must be false.
  document.execCommand(command, false, value);
}

function defaultQueryState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    // Firefox throws for a command it does not recognise rather than
    // answering false, and an unrecognised command is exactly the case where
    // "is this button pressed" has no answer.
    return false;
  }
}

/** Which block the caret sits in, for the pressed state of the heading buttons. */
function currentBlockTag(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
  const block = element?.closest('p,h2,h3,h4,blockquote,pre,li');
  return block?.tagName.toLowerCase() ?? '';
}

type Panel = 'none' | 'link' | 'image' | 'textColor' | 'highlight';
type ImageState = 'idle' | 'uploading' | 'ready' | 'failed' | 'too-large' | 'wrong-type';

export function RichTextEditor({
  value,
  onChange,
  strings,
  locale,
  presignPath,
  disabled = false,
  client = defaultClient,
  exec = defaultExec,
  queryState = defaultQueryState,
  parseHtml,
  requestUploadUrl,
  putFile = defaultPutFile,
}: RichTextEditorProps): ReactNode {
  const surfaceRef = useRef<HTMLDivElement>(null);
  /**
   * The last value this component sent upward. The seeding effect compares
   * against it, so a keystroke's own round trip through the parent's state
   * never rewrites the surface the caret is sitting in.
   *
   * **`undefined` to start, not `value`.** Seeded with `value`, the very
   * first comparison would find them equal and the effect would decline to
   * write anything — so an editor opened on existing text would show an empty
   * surface while the form quietly still held the words. Today's two callers
   * both start blank and would never have shown it; the day one opens a draft
   * for editing, it would have looked like the draft had been lost.
   */
  const emitted = useRef<string | undefined>(undefined);
  /**
   * The selection as it was when the toolbar was last used, because opening
   * the link or image panel moves focus into a text input and the selection
   * in the surface is gone by the time "Insert" is pressed.
   */
  const savedRange = useRef<Range | null>(null);
  /** The editor's outermost element, so `onBlur` can tell "focus left the editor" from "focus moved into its own panel". */
  const rootRef = useRef<HTMLDivElement | null>(null);

  const surfaceId = useId();
  const labelId = useId();
  const hintId = useId();

  const [panel, setPanel] = useState<Panel>('none');
  const [preview, setPreview] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [imageState, setImageState] = useState<ImageState>('idle');
  const [imageKey, setImageKey] = useState<string | undefined>(undefined);
  const [imageAlt, setImageAlt] = useState('');
  const [imageCaption, setImageCaption] = useState('');
  const [active, setActive] = useState<Readonly<Record<string, boolean>>>({});
  const [blockTag, setBlockTag] = useState('');
  const [focusedControl, setFocusedControl] = useState(0);

  const sanitize = useCallback(
    (html: string): string =>
      parseHtml ? sanitizeRichText(html, parseHtml) : sanitizeRichText(html),
    [parseHtml],
  );

  // Rule 1: seed, never render. `value !== emitted.current` is true on mount
  // and when the parent resets the form after a successful save, and false
  // for the value this component itself just produced.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface && value !== emitted.current) {
      surface.innerHTML = value;
      emitted.current = value;
    }
  }, [value]);

  const emit = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }
    const clean = sanitize(surface.innerHTML);
    emitted.current = clean;
    onChange(clean);
  }, [onChange, sanitize]);

  /** Remembered on every selection change inside the surface — see `savedRange`. */
  const rememberSelection = useCallback(() => {
    const surface = surfaceRef.current;
    if (typeof window === 'undefined' || !surface) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) {
      return;
    }
    savedRange.current = range.cloneRange();
    const next: Record<string, boolean> = {};
    for (const control of RICH_TEXT_CONTROLS) {
      if (control.stateCommand) {
        next[control.id] = queryState(control.stateCommand);
      }
    }
    setActive(next);
    setBlockTag(currentBlockTag());
  }, [queryState]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    document.addEventListener('selectionchange', rememberSelection);
    return () => {
      document.removeEventListener('selectionchange', rememberSelection);
    };
  }, [rememberSelection]);

  /**
   * Put the caret back where it was before the panel stole focus, then act on
   * it.
   *
   * 2026-09-09: a remembered range can go stale — its boundary nodes are
   * replaced whenever the surface is rewritten. Restoring a detached range
   * does not throw; it silently applies the command at the *start* of the
   * surface, which is how a second inserted image ended up above the first
   * paragraph. So the range is checked against the live tree and, when it no
   * longer belongs to it, the caret goes to the end of the content instead.
   * Appending is the honest fallback: an author who has lost their place
   * expects the new thing at the bottom, not silently at the top.
   */
  const withSelection = useCallback((act: () => void) => {
    const surface = surfaceRef.current;
    surface?.focus();
    const range = savedRange.current;
    if (surface && typeof window !== 'undefined') {
      const selection = window.getSelection();
      const usable = range !== null && surface.contains(range.commonAncestorContainer);
      selection?.removeAllRanges();
      if (usable && range) {
        selection?.addRange(range);
      } else {
        const end = surface.ownerDocument.createRange();
        end.selectNodeContents(surface);
        end.collapse(false);
        selection?.addRange(end);
      }
    }
    act();
  }, []);

  const run = (control: RichTextControl) => {
    const { command } = control;
    if (!command) {
      return;
    }
    withSelection(() => {
      // `styleWithCSS` decides whether an engine emits `<b>` or
      // `<span style="font-weight:bold">`. Off for every control that reaches
      // here, because all of them are structural and their output should be
      // semantic enough to survive `sanitize.ts` untouched. Colour is the one
      // case that needs it on, and colour no longer comes through here — it
      // has its own `applyColor`, which sets the flag itself.
      exec('styleWithCSS', 'false');
      exec(command, control.value);
    });
    emit();
    rememberSelection();
  };

  const insertHtml = (html: string) => {
    withSelection(() => {
      exec('insertHTML', html);
    });
    emit();
  };

  const applyLink = () => {
    if (!isSafeHref(linkUrl)) {
      setLinkInvalid(true);
      return;
    }
    setLinkInvalid(false);
    const href = linkUrl.trim();
    const range = savedRange.current;
    if (!range || range.collapsed) {
      // `createLink` with nothing selected does nothing at all in every
      // engine — there is no range to wrap — which reads as a broken button.
      // The URL becomes its own link text instead, which is what a person
      // pressing "add link" with no selection meant.
      //
      // `!range` counts as the same case, and that is the commoner one: an
      // author who presses the link button without having put the caret in
      // the body at all has no remembered selection, not a collapsed one.
      insertHtml(`<a href="${escapeAttribute(href)}">${escapeText(href)}</a>`);
    } else {
      withSelection(() => {
        exec('createLink', href);
      });
      emit();
    }
    setLinkUrl('');
    setPanel('none');
  };

  const chooseImage = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setImageState('uploading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setImageState('failed');
      return;
    }
    const result = await uploadImage({
      file,
      accessToken,
      requestUploadUrl: requestUploadUrl ?? defaultRequestUploadUrl(presignPath),
      putFile,
    });
    if (!result.ok) {
      setImageState(result.reason);
      return;
    }
    setImageKey(result.key);
    setImageState('ready');
  };

  const insertImage = () => {
    const src = imageKey ? mediaUrl(imageKey) : undefined;
    if (!src) {
      return;
    }
    // A caption turns the image into a `<figure>`, which is what keeps the
    // words attached to the picture rather than floating as a paragraph
    // underneath it. Without one it is a bare `<img>`, and the empty `alt`
    // that a blank field produces is a real statement — this picture is
    // decorative — rather than an omission.
    const image = `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(imageAlt)}">`;
    const html = imageCaption.trim()
      ? `<figure>${image}<figcaption>${escapeText(imageCaption.trim())}</figcaption></figure><p><br></p>`
      : `${image}<p><br></p>`;
    insertHtml(html);
    setImageKey(undefined);
    setImageAlt('');
    setImageCaption('');
    setImageState('idle');
    setPanel('none');
  };

  /**
   * Paint the selection, from a swatch rather than from a value anyone typed.
   *
   * `styleWithCSS` is on because colour has no element of its own to produce
   * — the engine emits a `<span style="color: ...">`, which `policy.ts` now
   * admits for exactly these values. Engines that emit a `<font color>`
   * instead are normalised by `sanitize.ts` on the next keystroke, the same
   * way the highlight already was.
   */
  const applyColor = (command: 'foreColor' | 'hiliteColor', value: string) => {
    withSelection(() => {
      exec('styleWithCSS', 'true');
      exec(command, value);
    });
    emit();
    rememberSelection();
    setPanel('none');
  };

  const act = (control: RichTextControl) => {
    if (control.action === 'textColor') {
      setPanel((current) => (current === 'textColor' ? 'none' : 'textColor'));
      return;
    }
    if (control.action === 'highlight') {
      setPanel((current) => (current === 'highlight' ? 'none' : 'highlight'));
      return;
    }
    if (control.action === 'preview') {
      setPreview((current) => !current);
      return;
    }
    if (control.action === 'link') {
      setPanel((current) => (current === 'link' ? 'none' : 'link'));
      return;
    }
    if (control.action === 'image') {
      setPanel((current) => (current === 'image' ? 'none' : 'image'));
      return;
    }
    if (control.action === 'table') {
      insertHtml(TABLE_HTML);
      return;
    }
    run(control);
  };

  /** Roving tabindex: the toolbar is one tab stop and the arrows move inside it. */
  const onToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = RICH_TEXT_CONTROLS.length - 1;
    const moves: Readonly<Record<string, number>> = {
      ArrowRight: Math.min(focusedControl + 1, last),
      ArrowLeft: Math.max(focusedControl - 1, 0),
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    setFocusedControl(next);
    const button = event.currentTarget.querySelectorAll('button')[next];
    (button as HTMLButtonElement | undefined)?.focus();
  };

  /**
   * Rule 3. A paste from Word carries a whole stylesheet and several hundred
   * `<span>`s; a paste from a web page carries whatever that page was made
   * of. Cleaning it here means the surface never holds it, rather than
   * holding it until the next reconciliation.
   */
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');
    const clean = html ? sanitize(html) : escapeText(text);
    exec('insertHTML', clean);
    emit();
  };

  const isPressed = (control: RichTextControl): boolean | undefined => {
    if (control.blockTag) {
      return blockTag === control.blockTag;
    }
    if (control.stateCommand) {
      return active[control.id] ?? false;
    }
    if (control.action === 'preview') {
      return preview;
    }
    if (control.action === 'link') {
      return panel === 'link';
    }
    if (control.action === 'image') {
      return panel === 'image';
    }
    if (control.action === 'textColor') {
      return panel === 'textColor';
    }
    if (control.action === 'highlight') {
      return panel === 'highlight';
    }
    return undefined;
  };

  const colorPanelLabel =
    panel === 'highlight' ? strings.colorHighlightLabel : strings.colorTextLabel;
  const previewHtml = renderableRichText(value);
  const words = richTextToPlainText(value).split(/\s+/).filter(Boolean).length;

  const controlsInGroup = (group: RichTextGroup) =>
    RICH_TEXT_CONTROLS.filter((control) => control.group === group);

  return (
    <div className="ndn-rte" ref={rootRef}>
      <p className="ndn-rte-label" id={labelId}>
        {strings.label}
      </p>

      <div
        className="ndn-rte-toolbar"
        role="toolbar"
        // Its own name, not the field's. Two regions on one page both called
        // "Post content" is a rotor listing that says nothing.
        aria-label={t('richText.toolbarLabel', undefined, locale)}
        // Dropped in preview mode, where the surface is not rendered:
        // `aria-controls` pointing at an id that is not in the document is an
        // `aria-valid-attr-value` failure, and this page is axe-scanned.
        aria-controls={preview ? undefined : surfaceId}
        onKeyDown={onToolbarKeyDown}
      >
        {RICH_TEXT_GROUPS.map((group) => (
          <div className="ndn-rte-group" role="group" key={group}>
            {controlsInGroup(group).map((control) => {
              const index = RICH_TEXT_CONTROLS.indexOf(control);
              const label = t(control.labelKey, undefined, locale);
              return (
                <button
                  key={control.id}
                  type="button"
                  className="ndn-rte-button"
                  // The accessible name and the tooltip are the same string:
                  // a toolbar of glyphs is unusable without hover help, and a
                  // `title` that disagreed with the label would be two names
                  // for one control.
                  title={label}
                  aria-label={label}
                  aria-pressed={isPressed(control)}
                  disabled={disabled}
                  tabIndex={index === focusedControl ? 0 : -1}
                  onFocus={() => setFocusedControl(index)}
                  // Keeps the caret. A `<button>` takes focus on mousedown,
                  // which collapses the selection in the surface before the
                  // click handler ever runs — so the command would apply to
                  // nothing.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => act(control)}
                >
                  {control.iconPath ? (
                    <svg
                      className="ndn-rte-icon"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d={control.iconPath} />
                    </svg>
                  ) : (
                    <span aria-hidden="true">{control.glyph}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {panel === 'link' && (
        <div className="ndn-rte-panel">
          <label htmlFor={`${surfaceId}-link`}>{strings.linkUrlLabel}</label>
          <input
            id={`${surfaceId}-link`}
            type="text"
            inputMode="url"
            value={linkUrl}
            onChange={(event) => {
              setLinkUrl(event.target.value);
              setLinkInvalid(false);
            }}
          />
          <Button size="sm" onMouseDown={(event) => event.preventDefault()} onClick={applyLink}>
            {strings.linkApply}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setPanel('none');
              setLinkInvalid(false);
            }}
          >
            {strings.cancel}
          </Button>
          {linkInvalid && <p role="alert">{strings.linkInvalid}</p>}
        </div>
      )}

      {(panel === 'textColor' || panel === 'highlight') && (
        // One panel, two palettes. A grid of swatches rather than an
        // `<input type="color">`: the native control is the free colour well
        // `policy.ts` refuses to accept values from, and it cannot be
        // constrained to a palette.
        <div
          className="ndn-rte-panel ndn-rte-panel--stacked"
          role="group"
          aria-label={colorPanelLabel}
        >
          <p className="ndn-rte-panel-hint">{colorPanelLabel}</p>
          <div className="ndn-rte-swatches">
            {(panel === 'textColor' ? TEXT_COLOR_SWATCHES : HIGHLIGHT_SWATCHES).map(
              (swatch: ColorSwatch) => {
                const label = t(swatch.labelKey, undefined, locale);
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    className="ndn-rte-swatch"
                    // The name is the colour's name, never its hex — see
                    // `ColorSwatch`. `title` and `aria-label` agree, the same
                    // rule the toolbar buttons follow.
                    title={label}
                    aria-label={label}
                    // The swatch *is* the preview, so the one inline style in
                    // this component is the thing being chosen. It never
                    // reaches the document: `applyColor` hands the hex to the
                    // editing engine, and what lands in the post is whatever
                    // that engine emits, re-checked by `sanitize.ts`.
                    style={
                      panel === 'textColor'
                        ? { color: swatch.hex }
                        : { backgroundColor: swatch.hex }
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() =>
                      applyColor(panel === 'textColor' ? 'foreColor' : 'hiliteColor', swatch.hex)
                    }
                  >
                    <span aria-hidden="true">{COLOR_SWATCH_GLYPH}</span>
                  </button>
                );
              },
            )}
          </div>
          <p className="ndn-rte-panel-row">
            {panel === 'highlight' && (
              <Button
                size="sm"
                variant="secondary"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyColor('hiliteColor', REMOVE_HIGHLIGHT_VALUE)}
              >
                {strings.colorRemoveHighlight}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPanel('none')}
            >
              {strings.cancel}
            </Button>
          </p>
        </div>
      )}

      {panel === 'image' && (
        <div className="ndn-rte-panel ndn-rte-panel--stacked">
          <p className="ndn-rte-panel-row">
            <label htmlFor={`${surfaceId}-file`}>{strings.imageChooseLabel}</label>
            <input
              id={`${surfaceId}-file`}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              disabled={imageState === 'uploading'}
              onChange={(event) => void chooseImage(event.target.files?.[0])}
            />
          </p>
          <p className="ndn-rte-panel-row">
            <label htmlFor={`${surfaceId}-alt`}>{strings.imageAltLabel}</label>
            <input
              id={`${surfaceId}-alt`}
              type="text"
              aria-describedby={`${surfaceId}-alt-hint`}
              value={imageAlt}
              onChange={(event) => setImageAlt(event.target.value)}
            />
          </p>
          <p id={`${surfaceId}-alt-hint`} className="ndn-rte-panel-hint">
            {strings.imageAltHint}
          </p>
          <p className="ndn-rte-panel-row">
            <label htmlFor={`${surfaceId}-caption`}>{strings.imageCaptionLabel}</label>
            <input
              id={`${surfaceId}-caption`}
              type="text"
              value={imageCaption}
              onChange={(event) => setImageCaption(event.target.value)}
            />
          </p>
          {imageState === 'uploading' && <p aria-live="polite">{strings.imageUploading}</p>}
          {imageState === 'failed' && <p role="alert">{strings.imageFailed}</p>}
          {imageState === 'too-large' && <p role="alert">{strings.imageTooLarge}</p>}
          {imageState === 'wrong-type' && <p role="alert">{strings.imageWrongType}</p>}
          <p className="ndn-rte-panel-row">
            <Button
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              disabled={imageState !== 'ready'}
              onClick={insertImage}
            >
              {strings.imageInsert}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPanel('none')}
            >
              {strings.cancel}
            </Button>
          </p>
        </div>
      )}

      {preview ? (
        <>
          <p className="ndn-rte-preview-notice">{strings.previewNotice}</p>
          {/* Already through `sanitizeRichText` on the way into `value`, and
              through `renderableRichText` again on the way out — the same two
              passes a published page makes, so what an author sees here is
              what a reader gets rather than a more permissive rendering of
              it. */}
          {/* Two elements, not one: the box is the width of the toolbar so
              the editor does not change shape when preview is toggled, and
              the article inside it keeps the 68ch measure a published page
              actually has. One element would have to be both, which is the
              bug this pass is fixing. */}
          <div className="ndn-rte-preview">
            <div
              className="ndn-prose ndn-rte-preview-body"
              dangerouslySetInnerHTML={{ __html: previewHtml ?? '' }}
            />
          </div>
        </>
      ) : (
        <div
          id={surfaceId}
          ref={surfaceRef}
          className="ndn-rte-surface ndn-prose"
          contentEditable={!disabled}
          role="textbox"
          aria-multiline="true"
          aria-labelledby={labelId}
          aria-describedby={hintId}
          onInput={emit}
          // Rule 2's reconciliation point: with focus gone there is no caret
          // to lose, so the surface is rewritten to exactly what the form
          // holds. Anything the browser invented while typing disappears
          // here, visibly, rather than at save time.
          // 2026-09-09: **not when focus moved into the editor's own
          // panels.** This rewrite replaces every node in the surface, which
          // detaches `savedRange` — and `savedRange` is precisely what the
          // link and image panels exist to restore. Clicking the image
          // button, choosing a file and pressing Insert therefore inserted
          // at the top of the document rather than at the caret, every time
          // after the first.
          //
          // Reproduced in Chromium before the fix: with the caret at the end
          // of the third paragraph, a second image landed before the first
          // paragraph. That is the whole of the owner's *"there is no way to
          // insert multiple media files at different sections in the text"*
          // — the control existed and the position was thrown away.
          //
          // `relatedTarget` is where focus went. Inside `.ndn-rte` means the
          // author is still in this editor and their selection must survive;
          // anywhere else is a real blur and reconciles as it always did.
          // Nothing unsafe is deferred by waiting: `emit` sanitises on every
          // input, so `value` is already clean either way.
          onBlur={(event) => {
            const surface = surfaceRef.current;
            if (!surface) {
              return;
            }
            const movedWithinEditor =
              event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget);
            const clean = sanitize(surface.innerHTML);
            if (!movedWithinEditor && clean !== surface.innerHTML) {
              surface.innerHTML = clean;
            }
            emitted.current = clean;
            onChange(clean);
          }}
          onPaste={onPaste}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
        />
      )}

      {/* No live region announcing the preview state. The toggle carries
          `aria-pressed`, so switching it already announces "Preview, pressed"
          — and a live region saying the same sentence a second time is the
          duplicate announcement that makes people turn verbosity down. */}
      <p id={hintId} className="ndn-rte-hint">
        {strings.hint}{' '}
        <span className="ndn-rte-count">{t('richText.wordCount', { count: words }, locale)}</span>
      </p>
    </div>
  );
}

/** `"` and `&` only — these values go into an attribute this file builds by hand, and `sanitize.ts` re-parses the result anyway. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Text destined for `insertHTML`, where an unescaped `<` would become a tag. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
