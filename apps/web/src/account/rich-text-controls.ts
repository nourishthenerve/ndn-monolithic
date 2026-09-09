// 2026-09-06: what is on the editor's toolbar, as data.
//
// The owner: *"it should have all kinds of formatting options to create the
// blog post. Make it as rich as possible - and not simply a text box and an
// option to upload media files."*
//
// Kept out of `RichTextEditor.tsx` for this directory's usual reason — the
// component is a `contenteditable`-driven island with no jsdom pattern to
// render-test end to end, while a table of controls is plain data that can be
// checked exhaustively: that every control has a label, that no two share an
// id, that every command the toolbar can issue is one `policy.ts` can
// actually keep.
//
// ## Why `document.execCommand`, which is deprecated
//
// Because the alternative is a document model. Every WYSIWYG library worth
// using (ProseMirror, Lexical, Quill) works by owning the document as its own
// data structure and rendering the DOM from it — which is the right design
// and is also thirty to a hundred packages in a repo whose `apps/web` has
// seven runtime dependencies and whose `pnpm-workspace.yaml` carries a
// paragraph of reasoning per transitive advisory.
//
// `execCommand` is deprecated in the sense that no new features will be added
// to it. It is implemented in every browser this site supports, it is what
// `contenteditable` itself is specified against, and the commands used here
// are the boring ones — bold, lists, headings — not the corners where
// engines disagree. The failure mode if one is ever removed is a button that
// does nothing, in a form used by one person, not a broken site.
//
// The bet is hedged in one specific way: nothing downstream trusts what these
// commands produce. `sanitize.ts` rewrites the result to `policy.ts` on every
// keystroke, so a browser that decides to emit `<span style="font-weight:700">`
// for bold gets normalised the same as one that emits `<strong>`.

import { HIGHLIGHT_COLORS, TEXT_COLORS } from '../rich-text/policy.js';

/** Which run of the toolbar a control belongs to. The groups are separated visually and by `role="group"`, so a screen-reader user can skip a run they do not need. */
export type RichTextGroup =
  'history' | 'block' | 'inline' | 'color' | 'list' | 'align' | 'insert' | 'view';

/**
 * Controls that do something this component has to implement itself, rather
 * than hand to `execCommand` — each opens a panel or toggles a mode.
 */
export type RichTextAction = 'link' | 'image' | 'table' | 'preview' | 'textColor' | 'highlight';

export interface RichTextControl {
  readonly id: string;
  readonly group: RichTextGroup;
  /** Catalogue key for the accessible name and the tooltip. */
  readonly labelKey: string;
  /**
   * The mark on the button. Decorative and `aria-hidden` — the accessible
   * name always comes from `labelKey` — which is why a letter here is not
   * copy the i18n rule should be catching. A locale where bold is not "B"
   * (French sets it in "G" for *gras*) would move these into the catalogue;
   * the site ships one locale and that day has not come.
   */
  readonly glyph?: string;
  /**
   * Path data for a 16x16 stroked icon, where a glyph would be a guess.
   * Alignment is the whole of this case: Unicode has no left/centre/right
   * ragged-line characters, and "L/C/R/J" is a puzzle rather than an icon.
   */
  readonly iconPath?: string;
  /** `document.execCommand`'s own name, for the controls that are a straight passthrough. */
  readonly command?: string;
  readonly value?: string;
  /**
   * The command `queryCommandState` is asked about to decide `aria-pressed`.
   * Absent for controls with no on/off state — pressing "undo" does not leave
   * the button pressed.
   */
  readonly stateCommand?: string;
  /** For `formatBlock` controls: the block this button *is*, so the pressed one is the one the caret sits in. */
  readonly blockTag?: string;
  readonly action?: RichTextAction;
}

/**
 * Every control, in toolbar order.
 *
 * The order is the order of use, not of importance: undo first because it is
 * what a person reaches for when something went wrong, then the block the
 * caret is in, then emphasis, then lists, then alignment, then the things
 * that insert something new, then the preview that says whether it worked.
 */
export const RICH_TEXT_CONTROLS: readonly RichTextControl[] = [
  { id: 'undo', group: 'history', labelKey: 'richText.undo', glyph: '↶', command: 'undo' },
  { id: 'redo', group: 'history', labelKey: 'richText.redo', glyph: '↷', command: 'redo' },

  // `formatBlock` takes the tag in angle brackets in every engine that
  // supports it; without them Firefox silently does nothing.
  {
    id: 'paragraph',
    group: 'block',
    labelKey: 'richText.paragraph',
    glyph: '¶',
    command: 'formatBlock',
    value: '<p>',
    blockTag: 'p',
  },
  {
    id: 'heading2',
    group: 'block',
    labelKey: 'richText.heading2',
    glyph: 'H2',
    command: 'formatBlock',
    value: '<h2>',
    blockTag: 'h2',
  },
  {
    id: 'heading3',
    group: 'block',
    labelKey: 'richText.heading3',
    glyph: 'H3',
    command: 'formatBlock',
    value: '<h3>',
    blockTag: 'h3',
  },
  {
    id: 'heading4',
    group: 'block',
    labelKey: 'richText.heading4',
    glyph: 'H4',
    command: 'formatBlock',
    value: '<h4>',
    blockTag: 'h4',
  },
  {
    id: 'quote',
    group: 'block',
    labelKey: 'richText.quote',
    glyph: '“',
    command: 'formatBlock',
    value: '<blockquote>',
    blockTag: 'blockquote',
  },
  {
    id: 'codeBlock',
    group: 'block',
    labelKey: 'richText.codeBlock',
    glyph: '‹›',
    command: 'formatBlock',
    value: '<pre>',
    blockTag: 'pre',
  },

  {
    id: 'bold',
    group: 'inline',
    labelKey: 'richText.bold',
    glyph: 'B',
    command: 'bold',
    stateCommand: 'bold',
  },
  {
    id: 'italic',
    group: 'inline',
    labelKey: 'richText.italic',
    glyph: 'I',
    command: 'italic',
    stateCommand: 'italic',
  },
  {
    id: 'underline',
    group: 'inline',
    labelKey: 'richText.underline',
    glyph: 'U',
    command: 'underline',
    stateCommand: 'underline',
  },
  {
    id: 'strikethrough',
    group: 'inline',
    labelKey: 'richText.strikethrough',
    glyph: 'S',
    command: 'strikeThrough',
    stateCommand: 'strikeThrough',
  },
  {
    id: 'superscript',
    group: 'inline',
    labelKey: 'richText.superscript',
    glyph: 'x²',
    command: 'superscript',
    stateCommand: 'superscript',
  },
  {
    id: 'subscript',
    group: 'inline',
    labelKey: 'richText.subscript',
    glyph: 'x₂',
    command: 'subscript',
    stateCommand: 'subscript',
  },
  {
    id: 'clearFormatting',
    group: 'inline',
    labelKey: 'richText.clearFormatting',
    glyph: 'T×',
    command: 'removeFormat',
  },

  // 2026-09-09: colour, which this toolbar used to refuse.
  //
  // The refusal was a fixed `<mark>` and a note saying a free colour well is
  // the one control here that can produce a page failing the site's contrast
  // gate — grey-on-white body text, chosen in good faith by someone who
  // could read it on their own screen. The owner asked again, plainly:
  // *"there is no way to change the color of the text."*
  //
  // The objection was to a *well*, and it survives: neither of these opens
  // one. Each opens a panel of swatches drawn from `policy.ts`'s palette,
  // every entry of which `policy.contrast.test.ts` proves clears 4.5:1 on
  // both grounds a post is rendered on. Twelve choices, none of them
  // unreadable, and a thirteenth that was unreadable would fail the build.
  {
    id: 'textColor',
    group: 'color',
    labelKey: 'richText.textColor',
    glyph: 'A',
    action: 'textColor',
  },
  {
    id: 'highlight',
    group: 'color',
    labelKey: 'richText.highlight',
    glyph: '▨',
    action: 'highlight',
  },

  {
    id: 'bulletList',
    group: 'list',
    labelKey: 'richText.bulletList',
    glyph: '•',
    command: 'insertUnorderedList',
    stateCommand: 'insertUnorderedList',
  },
  {
    id: 'numberList',
    group: 'list',
    labelKey: 'richText.numberList',
    glyph: '1.',
    command: 'insertOrderedList',
    stateCommand: 'insertOrderedList',
  },
  {
    id: 'outdent',
    group: 'list',
    labelKey: 'richText.outdent',
    glyph: '⇤',
    command: 'outdent',
  },
  { id: 'indent', group: 'list', labelKey: 'richText.indent', glyph: '⇥', command: 'indent' },

  {
    id: 'alignLeft',
    group: 'align',
    labelKey: 'richText.alignLeft',
    iconPath: 'M2 3h12M2 6.5h7M2 10h12M2 13.5h7',
    command: 'justifyLeft',
    stateCommand: 'justifyLeft',
  },
  {
    id: 'alignCenter',
    group: 'align',
    labelKey: 'richText.alignCenter',
    iconPath: 'M2 3h12M4.5 6.5h7M2 10h12M4.5 13.5h7',
    command: 'justifyCenter',
    stateCommand: 'justifyCenter',
  },
  {
    id: 'alignRight',
    group: 'align',
    labelKey: 'richText.alignRight',
    iconPath: 'M2 3h12M7 6.5h7M2 10h12M7 13.5h7',
    command: 'justifyRight',
    stateCommand: 'justifyRight',
  },
  {
    id: 'alignJustify',
    group: 'align',
    labelKey: 'richText.alignJustify',
    iconPath: 'M2 3h12M2 6.5h12M2 10h12M2 13.5h12',
    command: 'justifyFull',
    stateCommand: 'justifyFull',
  },

  { id: 'link', group: 'insert', labelKey: 'richText.link', glyph: '\u{1F517}', action: 'link' },
  {
    id: 'unlink',
    group: 'insert',
    labelKey: 'richText.unlink',
    glyph: '⛓',
    command: 'unlink',
  },
  { id: 'image', group: 'insert', labelKey: 'richText.image', glyph: '\u{1F5BC}', action: 'image' },
  { id: 'table', group: 'insert', labelKey: 'richText.table', glyph: '⊞', action: 'table' },
  {
    id: 'horizontalRule',
    group: 'insert',
    labelKey: 'richText.horizontalRule',
    glyph: '—',
    command: 'insertHorizontalRule',
  },

  { id: 'preview', group: 'view', labelKey: 'richText.preview', glyph: '▶', action: 'preview' },
];

/** The groups in toolbar order, derived rather than restated so a control added to a new group cannot be rendered into nothing. */
export const RICH_TEXT_GROUPS: readonly RichTextGroup[] = [
  ...new Set(RICH_TEXT_CONTROLS.map((control) => control.group)),
];

/**
 * One swatch on a colour panel: the value `execCommand` is handed, and the
 * catalogue key for the name a screen reader and a tooltip get.
 *
 * A swatch is never named by its hex. "#65558f" tells a person nothing and
 * tells a screen-reader user less; the catalogue calls it "Lavender".
 */
export interface ColorSwatch {
  readonly id: string;
  readonly hex: string;
  readonly labelKey: string;
}

function swatches(palette: Readonly<Record<string, string>>): readonly ColorSwatch[] {
  return Object.entries(palette).map(([id, hex]) => ({
    id,
    hex,
    labelKey: `richText.color.${id}`,
  }));
}

/**
 * The inks and the highlights the two colour panels offer, **derived from
 * `policy.ts` rather than restated**.
 *
 * That direction matters. The palette is a security-and-accessibility
 * boundary — it is what `isAllowedStyle` admits and what
 * `policy.contrast.test.ts` proves readable — so the toolbar reads from the
 * boundary rather than the boundary trusting the toolbar. A swatch that was
 * not in the policy would produce a colour the sanitiser strips on the next
 * keystroke, which is the "it does not work" bug this arrangement makes
 * impossible to write.
 */
export const TEXT_COLOR_SWATCHES: readonly ColorSwatch[] = swatches(TEXT_COLORS);
export const HIGHLIGHT_SWATCHES: readonly ColorSwatch[] = swatches(HIGHLIGHT_COLORS);

/**
 * What "no highlight" is handed to `hiliteColor`.
 *
 * `transparent` is deliberately **not** in the palette, and that is the
 * mechanism rather than an oversight: the browser emits
 * `background-color: transparent`, `isAllowedStyle` refuses it, the attribute
 * is dropped, and `sanitize.ts` then unwraps the now-attribute-less `<span>`.
 * The highlight and the element it lived in both disappear, which is exactly
 * what removing a highlight should leave behind. `sanitize.test.ts` pins the
 * whole chain so a future change to any link in it fails loudly.
 */
export const REMOVE_HIGHLIGHT_VALUE = 'transparent';

/**
 * The mark on a swatch.
 *
 * Decorative and `aria-hidden`, exactly like a toolbar control's `glyph` and
 * exempt from the copy rule for the same reason: the accessible name comes
 * from `labelKey`, and this letter is a specimen of the colour rather than
 * something anyone reads.
 */
export const COLOR_SWATCH_GLYPH = 'A';

/**
 * The default highlight — the colour the single fixed `<mark>` control used
 * before the palette existed, so a post highlighted yesterday is the shade it
 * always was.
 *
 * A literal hex, and one of the few in apps/web:
 * `document.execCommand('hiliteColor', false, ...)` is handed a colour value
 * by the browser's own editing engine and has no way to resolve a custom
 * property. It must equal `--ndn-color-accent-soft`, which is what
 * `rich-text/styles.ts` paints `<mark>` with — otherwise a highlight changes
 * colour the moment the post is published. This file's test asserts the two
 * agree rather than trusting whoever edits the palette next.
 */
export const HIGHLIGHT_COLOR = HIGHLIGHT_COLORS.accentSoft as string;

/**
 * The markup the table control inserts.
 *
 * Two columns and a header row, because that is the smallest table that is
 * recognisably one and every cell is then typed into directly.
 * `contenteditable` handles rows and cells from there — Tab moves between
 * them — which is as far as this editor goes: adding and removing rows is a
 * grid editor's job, and this is a prose editor that can hold a small table.
 */
export const TABLE_HTML =
  '<table><thead><tr><th>&nbsp;</th><th>&nbsp;</th></tr></thead>' +
  '<tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr>' +
  '<tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>';
