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

/** The slug a reader sees in the URL, and the record's own id. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BlogFormFields {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly body: string;
  /** Free text: comma- or newline-separated, however the author likes to type it. */
  readonly keywords: string;
  readonly publishNow: boolean;
}

export interface WorkshopFormFields {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** `<input type="datetime-local">`'s own value — local wall time, no zone. */
  readonly dateTimeLocal: string;
  readonly capacity: string;
  readonly publishNow: boolean;
}

export interface CreateBlogRequestBody {
  readonly id: string;
  readonly contentType: 'blog';
  readonly status: 'draft' | 'published';
  readonly keywords: readonly string[];
  readonly translations: Readonly<Record<string, { title: string; body: string; excerpt: string }>>;
}

export interface CreateWorkshopRequestBody {
  readonly id: string;
  readonly status: 'draft' | 'published';
  readonly dateTimeUtc: string;
  readonly capacity?: number;
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

/** `true` when this is a usable slug — lowercase words joined by single hyphens, which is what every published URL on this site already looks like. */
export function isValidSlug(id: string): boolean {
  return SLUG_PATTERN.test(id.trim());
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
  const capacity = Number.parseInt(fields.capacity.trim(), 10);
  return {
    id: fields.id.trim(),
    status: fields.publishNow ? 'published' : 'draft',
    dateTimeUtc,
    // Omitted, never sent as `0` or `NaN` — D-31 made capacity genuinely
    // optional (workshops are announcement-only), so "no limit" and "a
    // limit of nothing" must stay different facts.
    ...(Number.isFinite(capacity) && capacity > 0 ? { capacity } : {}),
    details: {
      [DEFAULT_LOCALE]: {
        title: fields.title.trim(),
        description: fields.description,
      },
    },
  };
}
