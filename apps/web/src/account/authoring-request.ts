// 2026-08-31: request-shaping for `AuthoringPanel.tsx`, in its own file
// with no React import — the same reasoning `patient-admin-request.ts`
// states for its own existence, so a test importing this does not drag
// the component's untested JSX into coverage instrumentation.
//
// The owner: *"for blogs and webinar there is no way to upload it with
// tags/keywords - it will only be possible via principal clinician
// account."* Both APIs have existed since TASK 1.3.2 and 1.5.1, keywords
// and all; what did not exist was any way to reach them. This is the
// shaping half of that.

import { blogThemeIds } from '@ndn/shared-types';

/** The slug a reader sees in the URL, and the record's own id. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BlogFormFields {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly body: string;
  /** Free text: comma- or newline-separated, however the author likes to type it. */
  readonly keywords: string;
  /**
   * The themes ticked in the composer's checklist — ids from
   * `@ndn/shared-types`'s `blogThemeIds`, a closed set, unlike the free-text
   * `keywords` above. Empty when nothing is ticked.
   */
  readonly themes: readonly string[];
  /** Media-bucket key of an uploaded lead image, once one has been uploaded. Absent until then, and absent for a post that has none. */
  readonly imageKey?: string;
  readonly publishNow: boolean;
}

export interface WorkshopFormFields {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** `<input type="datetime-local">`'s own value — local wall time, no zone. */
  readonly dateTimeLocal: string;
  /**
   * 2026-09-14: the meeting link an attendee joins by (Zoom, Meet, and the
   * like), shown as a "Join" link on the public announcement. Free text as the
   * author types it; validated as an absolute `https://` URL before the
   * request is built (`isValidJoinLink`), and omitted when blank. Replaced the
   * old "Places" (capacity) field, which was collected but never displayed.
   */
  readonly joinLink: string;
  /** Media-bucket key of an uploaded poster, once one has been uploaded. */
  readonly posterKey?: string;
  readonly publishNow: boolean;
}

/**
 * A blank blog form.
 *
 * **2026-09-02: defaults to publishing.** The owner, twice: *"I want them to
 * go live immediately"*, then *"the blog post and workshop when being saved
 * are not being published yet."*
 *
 * Both times the content had saved correctly — as a *draft*, because this box
 * started unticked and the public read endpoint returns published items only
 * (`content-repository.ts`). So "Save" did exactly what it said and nothing
 * anyone wanted: the post existed, and no reader could ever reach it.
 *
 * Drafting is still one click away, which is the right way round for a clinic
 * that publishes a handful of posts a year — the rare case asks for itself,
 * rather than the common one being a trap.
 *
 * 2026-09-06: moved here from `AuthoringPanel.tsx` when that component was
 * split in two. A form's blank state is data, and both halves of the split
 * needed it.
 */
export const EMPTY_BLOG: BlogFormFields = {
  id: '',
  title: '',
  excerpt: '',
  body: '',
  keywords: '',
  themes: [],
  publishNow: true,
};

/** Same default, same reason — see `EMPTY_BLOG`. */
export const EMPTY_WORKSHOP: WorkshopFormFields = {
  id: '',
  title: '',
  description: '',
  dateTimeLocal: '',
  joinLink: '',
  publishNow: true,
};

export interface CreateBlogRequestBody {
  readonly id: string;
  readonly contentType: 'blog';
  readonly status: 'draft' | 'published';
  readonly keywords: readonly string[];
  readonly themes: readonly string[];
  readonly imageKey?: string;
  readonly translations: Readonly<Record<string, { title: string; body: string; excerpt: string }>>;
}

export interface CreateWorkshopRequestBody {
  readonly id: string;
  readonly status: 'draft' | 'published';
  readonly dateTimeUtc: string;
  readonly joinLink?: string;
  readonly posterKey?: string;
  readonly details: Readonly<Record<string, { title: string; description: string }>>;
}

/**
 * Keywords as a person types them — "back pain, mobility" or one per line
 * — into the array the API takes.
 *
 * Trimmed, emptied entries dropped, and **de-duplicated case-insensitively
 * while keeping the author's own casing** of the first occurrence: the
 * keyword is both a search term and a GSI2 partition key
 * (`KEYWORD#<keyword>`), so "Mobility" and "mobility" typed into the same
 * box would otherwise become two partitions holding the same post, and a
 * reader searching one would miss the other.
 */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const keyword = part.trim();
    if (!keyword) {
      continue;
    }
    const key = keyword.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keywords.push(keyword);
  }
  return keywords;
}

/**
 * The ticked themes, deduplicated and returned in the catalogue's own order,
 * with any id the catalogue does not know dropped. Filtering `blogThemeIds`
 * by membership gives all three at once: order, uniqueness, and a closed set —
 * the same guarantees the API re-checks, made here so the request is already
 * clean.
 */
export function dedupeThemes(themes: readonly string[]): string[] {
  const selected = new Set(themes);
  return blogThemeIds.filter((id) => selected.has(id));
}

/** `true` when this is a usable slug — lowercase words joined by single hyphens, which is what every published URL on this site already looks like. */
export function isValidSlug(id: string): boolean {
  return SLUG_PATTERN.test(id.trim());
}

/**
 * `true` when this is a join link the site can publish: an absolute `https://`
 * URL. The empty string is *not* valid here — the caller treats "blank" as
 * "no link" before ever asking this — so a non-empty value that fails is a
 * value the author needs to fix, not a field they left alone. `https:` only,
 * for the reason the API's own `joinLinkSchema` and `rich-text/policy.ts`'s
 * `isSafeHref` give: `javascript:`, `data:` and plain `http:` have no business
 * in a link the site renders.
 */
export function isValidJoinLink(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A slug is a URL segment; anything longer than this is unreadable and no more unique. */
const MAX_SLUG_LENGTH = 80;

/**
 * A title as a person types it, into the URL segment the post will live
 * at. **Added after the first attempt to use this form failed** — the
 * slug was a required, hand-typed field validated against a pattern
 * nobody was told in advance, so a perfectly ordinary title ("My first
 * post") was rejected before a request was ever sent. Nothing reached the
 * API at all, which is exactly what "blog posting is not working" looks
 * like from the outside.
 *
 * Asking a clinician to know what a slug is was the mistake. The title is
 * the thing they actually have; this derives the rest, and the field stays
 * editable for the times a shorter or clearer URL is wanted.
 *
 * Accents are folded rather than dropped (`Zoë` → `zoe`) via NFD
 * normalisation, so a name keeps its letters instead of losing them.
 * Returns `''` for a title with no Latin letters or digits at all — a
 * real possibility the day a second locale ships — which the caller
 * treats as "ask the author to type one", never as a valid slug.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFD')
    // Combining marks, left behind by NFD — this is what turns `é` into `e`
    // rather than into an empty string.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // A trailing hyphen can reappear after the slice.
    .replace(/-+$/g, '');
}

/**
 * `<input type="datetime-local">` yields local wall time with no zone
 * (`2026-09-01T10:00`), and the API stores a UTC instant. The conversion
 * is the browser's own — `new Date(localValue)` interprets it in the
 * viewer's timezone, which is the one the author is sitting in and the one
 * they mean.
 *
 * Returns `undefined` for anything that does not parse, so the caller can
 * refuse rather than send `Invalid Date` and get a 400 back.
 */
export function toUtcInstant(dateTimeLocal: string): string | undefined {
  const parsed = new Date(dateTimeLocal);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** English only today (`supportedLocales` is `['en']`), so one locale key — the API's own shape is already `Record<locale, …>` for the day that changes. */
const DEFAULT_LOCALE = 'en';

export function buildCreateBlogRequestBody(fields: BlogFormFields): CreateBlogRequestBody {
  return {
    id: fields.id.trim(),
    contentType: 'blog',
    status: fields.publishNow ? 'published' : 'draft',
    keywords: parseKeywords(fields.keywords),
    // A checklist already yields clean ids, but it deduplicates for the same
    // reason `parseKeywords` does — an array is what the API stores, and one
    // theme listed twice is a tag shown twice. Kept in the catalogue's own
    // order rather than the click order, so two posts with the same themes
    // read the same.
    themes: dedupeThemes(fields.themes),
    // Omitted rather than sent empty, the same discipline `capacity`
    // keeps below: the API's schema makes it optional, and "no image" is
    // a different fact from "an image whose key is the empty string".
    ...(fields.imageKey ? { imageKey: fields.imageKey } : {}),
    translations: {
      [DEFAULT_LOCALE]: {
        title: fields.title.trim(),
        body: fields.body,
        excerpt: fields.excerpt.trim(),
      },
    },
  };
}

export function buildCreateWorkshopRequestBody(
  fields: WorkshopFormFields,
  dateTimeUtc: string,
): CreateWorkshopRequestBody {
  const joinLink = fields.joinLink.trim();
  return {
    id: fields.id.trim(),
    status: fields.publishNow ? 'published' : 'draft',
    dateTimeUtc,
    // Omitted rather than sent empty, the same discipline `posterKey` keeps:
    // "no join link" and "a link that is the empty string" are different
    // facts. Sent verbatim once present — the composer has already checked it
    // is a valid `https://` URL (`isValidJoinLink`), and the API re-checks.
    ...(joinLink ? { joinLink } : {}),
    ...(fields.posterKey ? { posterKey: fields.posterKey } : {}),
    details: {
      [DEFAULT_LOCALE]: {
        title: fields.title.trim(),
        description: fields.description,
      },
    },
  };
}
