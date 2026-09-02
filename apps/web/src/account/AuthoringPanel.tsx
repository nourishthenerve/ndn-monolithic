// 2026-08-31: writing a blog post or a workshop, with keywords — the
// owner's *"for blogs and webinar there is no way to upload it with
// tags/keywords - it will only be possible via principal clinician
// account."*
//
// Both APIs have existed since TASK 1.3.2 and TASK 1.5.1, keywords and
// all, complete with publish/unpublish. What did not exist was any way to
// reach them: every blog post and workshop on the live site was written
// by calling the API by hand. This is the missing surface.
//
// **Create only, deliberately.** `PATCH /content/{id}` and
// `PATCH /workshops/{id}` exist and are not wired here. Editing needs a
// list to choose from, a loaded draft, and a diff — a screen in its own
// right — and building a bad version of it beside a good create form
// would be worse than not building it yet. Re-`POST`ing the same id is
// refused by the API (`RECORD_ALREADY_EXISTS`), so nothing here can
// silently overwrite a published post.
//
// Rendered only for the principal (`allowRoles`, and the matrix's own
// `Content item`/`Workshop` columns, narrowed to `Principal` the same
// day). A 403 is still treated as an ordinary outcome — the server is the
// boundary, this component only avoids offering what it would refuse.
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import {
  buildCreateBlogRequestBody,
  buildCreateWorkshopRequestBody,
  isValidSlug,
  parseKeywords,
  slugify,
  toUtcInstant,
} from './authoring-request.js';
import type { BlogFormFields, WorkshopFormFields } from './authoring-request.js';

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'conflict' | 'invalid' | 'forbidden' | 'error';

export const EMPTY_BLOG: BlogFormFields = {
  id: '',
  title: '',
  excerpt: '',
  body: '',
  keywords: '',
  // **2026-09-02: defaults to publishing.** The owner, twice: "I want them
  // to go live immediately", then "the blog post and workshop when being
  // saved are not being published yet."
  //
  // Both times the content had saved correctly — as a *draft*, because
  // this box started unticked and the public read endpoint returns
  // published items only (`content-repository.ts`). So "Save" did exactly
  // what it said and nothing anyone wanted: the post existed, and no
  // reader could ever reach it.
  //
  // Drafting is still one click away, which is the right way round for a
  // clinic that publishes a handful of posts a year — the rare case asks
  // for itself, rather than the common one being a trap.
  publishNow: true,
};

export const EMPTY_WORKSHOP: WorkshopFormFields = {
  id: '',
  title: '',
  description: '',
  dateTimeLocal: '',
  capacity: '',
  // Same default, same reason — see the blog form above.
  publishNow: true,
};

export interface AuthoringPanelStrings {
  readonly blogHeading: string;
  readonly blogIntro: string;
  readonly workshopHeading: string;
  readonly workshopIntro: string;
  readonly slugLabel: string;
  readonly slugHint: string;
  readonly titleLabel: string;
  readonly excerptLabel: string;
  readonly bodyLabel: string;
  readonly descriptionLabel: string;
  readonly keywordsLabel: string;
  readonly keywordsHint: string;
  readonly dateTimeLabel: string;
  readonly capacityLabel: string;
  readonly publishNowLabel: string;
  readonly publishNowHint: string;
  readonly submitButton: string;
  readonly submitting: string;
  readonly successMessage: string;
  /** 2026-09-01: when a saved item actually reaches the public site — see the success branch. */
  readonly publishDelayNotice: string;
  readonly conflictError: string;
  readonly invalidError: string;
  readonly slugError: string;
  readonly dateTimeError: string;
  readonly forbidden: string;
  readonly error: string;
}

export interface AuthoringPanelProps {
  readonly strings: AuthoringPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly createBlog?: (accessToken: string, body: unknown) => Promise<Response>;
  readonly createWorkshop?: (accessToken: string, body: unknown) => Promise<Response>;
}

const defaultClient = createSessionClient();

function post(path: string) {
  return (accessToken: string, body: unknown): Promise<Response> =>
    fetch(`${contentApiUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

/** Maps one response to a status. Shared because both forms hit the same status vocabulary. */
async function statusFor(response: Response): Promise<SubmitStatus> {
  if (response.status === 401 || response.status === 403) return 'forbidden';
  if (response.status === 409) return 'conflict';
  if (response.status === 400) return 'invalid';
  return response.ok ? 'success' : 'error';
}

export function AuthoringPanel({
  strings,
  client = defaultClient,
  createBlog = post('/content'),
  createWorkshop = post('/workshops'),
}: AuthoringPanelProps): ReactNode {
  const [blog, setBlog] = useState<BlogFormFields>(EMPTY_BLOG);
  const [blogStatus, setBlogStatus] = useState<SubmitStatus>('idle');
  const [blogSlugError, setBlogSlugError] = useState(false);
  /**
   * Whether the author has typed in the web-address field themselves.
   * Until they do, it follows the title; once they do, it stops — editing
   * a URL by hand and watching it be overwritten on the next keystroke of
   * the title would be worse than not deriving it at all.
   */
  const [blogSlugEdited, setBlogSlugEdited] = useState(false);

  const [workshop, setWorkshop] = useState<WorkshopFormFields>(EMPTY_WORKSHOP);
  const [workshopStatus, setWorkshopStatus] = useState<SubmitStatus>('idle');
  const [workshopSlugError, setWorkshopSlugError] = useState(false);
  const [workshopSlugEdited, setWorkshopSlugEdited] = useState(false);
  const [workshopDateError, setWorkshopDateError] = useState(false);

  const handleBlog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Checked here rather than left to the API's 400: the slug becomes a
    // public URL, and "that is not a valid slug" is a more useful thing to
    // say than "invalid body".
    if (!isValidSlug(blog.id)) {
      setBlogSlugError(true);
      return;
    }
    setBlogSlugError(false);
    setBlogStatus('submitting');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setBlogStatus('forbidden');
      return;
    }
    try {
      const status = await statusFor(await createBlog(accessToken, buildCreateBlogRequestBody(blog)));
      setBlogStatus(status);
      if (status === 'success') {
        setBlog(EMPTY_BLOG);
        setBlogSlugEdited(false);
      }
    } catch {
      setBlogStatus('error');
    }
  };

  const handleWorkshop = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValidSlug(workshop.id)) {
      setWorkshopSlugError(true);
      return;
    }
    setWorkshopSlugError(false);
    const dateTimeUtc = toUtcInstant(workshop.dateTimeLocal);
    if (!dateTimeUtc) {
      setWorkshopDateError(true);
      return;
    }
    setWorkshopDateError(false);
    setWorkshopStatus('submitting');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setWorkshopStatus('forbidden');
      return;
    }
    try {
      const status = await statusFor(
        await createWorkshop(accessToken, buildCreateWorkshopRequestBody(workshop, dateTimeUtc)),
      );
      setWorkshopStatus(status);
      if (status === 'success') {
        setWorkshop(EMPTY_WORKSHOP);
        setWorkshopSlugEdited(false);
      }
    } catch {
      setWorkshopStatus('error');
    }
  };

  const messagesFor = (status: SubmitStatus): ReactNode => (
    <>
      {status === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
      {status === 'conflict' && <p role="alert">{strings.conflictError}</p>}
      {status === 'invalid' && <p role="alert">{strings.invalidError}</p>}
      {status === 'error' && <p role="alert">{strings.error}</p>}
      {status === 'success' && (
        <p role="status">
          {strings.successMessage}{' '}
          {/* 2026-09-01: the site is statically generated (ADR-0017), so a
              saved post is in the database but not yet on the public page
              — it appears at the next deploy. Saying so here is the
              difference between "it saved" and "it worked", which is what
              the owner was reading it as when nothing showed up under the
              blog tab. */}
          {strings.publishDelayNotice}
        </p>
      )}
    </>
  );

  const blogBusy = blogStatus === 'submitting';
  const workshopBusy = workshopStatus === 'submitting';
  const previewKeywords = parseKeywords(blog.keywords);

  return (
    <>
      <section>
        <h2>{strings.blogHeading}</h2>
        <p>{strings.blogIntro}</p>
        <form onSubmit={(event) => void handleBlog(event)}>
          <p>
            <label htmlFor="blog-title">{strings.titleLabel}</label>
            <input
              id="blog-title"
              type="text"
              required
              disabled={blogBusy}
              value={blog.title}
              onChange={(event) => {
                const title = event.target.value;
                setBlog((f) => ({ ...f, title, ...(blogSlugEdited ? {} : { id: slugify(title) }) }));
                setBlogSlugError(false);
              }}
            />
          </p>
          <p>
            <label htmlFor="blog-slug">{strings.slugLabel}</label>
            <input
              id="blog-slug"
              type="text"
              disabled={blogBusy}
              aria-describedby="blog-slug-hint"
              value={blog.id}
              onChange={(event) => {
                setBlogSlugEdited(true);
                setBlog((f) => ({ ...f, id: event.target.value }));
                setBlogSlugError(false);
              }}
            />
          </p>
          <p id="blog-slug-hint">{strings.slugHint}</p>
          {blogSlugError && <p role="alert">{strings.slugError}</p>}
          <p>
            <label htmlFor="blog-excerpt">{strings.excerptLabel}</label>
            <input
              id="blog-excerpt"
              type="text"
              required
              disabled={blogBusy}
              value={blog.excerpt}
              onChange={(event) => setBlog((f) => ({ ...f, excerpt: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="blog-body">{strings.bodyLabel}</label>
            <textarea
              id="blog-body"
              required
              rows={12}
              disabled={blogBusy}
              value={blog.body}
              onChange={(event) => setBlog((f) => ({ ...f, body: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="blog-keywords">{strings.keywordsLabel}</label>
            <input
              id="blog-keywords"
              type="text"
              disabled={blogBusy}
              aria-describedby="blog-keywords-hint"
              value={blog.keywords}
              onChange={(event) => setBlog((f) => ({ ...f, keywords: event.target.value }))}
            />
          </p>
          <p id="blog-keywords-hint">{strings.keywordsHint}</p>
          {/* What will actually be stored, shown back before it is: a
              keyword is a search partition, so a stray comma or a
              duplicate is worth seeing before it becomes one. */}
          {previewKeywords.length > 0 && (
            <ul>
              {previewKeywords.map((keyword) => (
                <li key={keyword}>{keyword}</li>
              ))}
            </ul>
          )}
          <p>
            <label htmlFor="blog-publish">
              <input
                id="blog-publish"
                type="checkbox"
                disabled={blogBusy}
                aria-describedby="blog-publish-hint"
                checked={blog.publishNow}
                onChange={(event) => setBlog((f) => ({ ...f, publishNow: event.target.checked }))}
              />{' '}
              {strings.publishNowLabel}
            </label>
          </p>
          <p id="blog-publish-hint">{strings.publishNowHint}</p>
          {messagesFor(blogStatus)}
          <button type="submit" disabled={blogBusy}>
            {blogBusy ? strings.submitting : strings.submitButton}
          </button>
        </form>
      </section>

      <section>
        <h2>{strings.workshopHeading}</h2>
        <p>{strings.workshopIntro}</p>
        <form onSubmit={(event) => void handleWorkshop(event)}>
          <p>
            <label htmlFor="workshop-title">{strings.titleLabel}</label>
            <input
              id="workshop-title"
              type="text"
              required
              disabled={workshopBusy}
              value={workshop.title}
              onChange={(event) => {
                const title = event.target.value;
                setWorkshop((f) => ({
                  ...f,
                  title,
                  ...(workshopSlugEdited ? {} : { id: slugify(title) }),
                }));
                setWorkshopSlugError(false);
              }}
            />
          </p>
          <p>
            <label htmlFor="workshop-slug">{strings.slugLabel}</label>
            <input
              id="workshop-slug"
              type="text"
              disabled={workshopBusy}
              aria-describedby="workshop-slug-hint"
              value={workshop.id}
              onChange={(event) => {
                setWorkshopSlugEdited(true);
                setWorkshop((f) => ({ ...f, id: event.target.value }));
                setWorkshopSlugError(false);
              }}
            />
          </p>
          <p id="workshop-slug-hint">{strings.slugHint}</p>
          {workshopSlugError && <p role="alert">{strings.slugError}</p>}
          <p>
            <label htmlFor="workshop-description">{strings.descriptionLabel}</label>
            <textarea
              id="workshop-description"
              required
              rows={8}
              disabled={workshopBusy}
              value={workshop.description}
              onChange={(event) => setWorkshop((f) => ({ ...f, description: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="workshop-datetime">{strings.dateTimeLabel}</label>
            {/* Local wall time in, UTC instant out — `toUtcInstant` does
                the conversion in the author's own timezone, which is the
                one they are typing in. */}
            <input
              id="workshop-datetime"
              type="datetime-local"
              required
              disabled={workshopBusy}
              value={workshop.dateTimeLocal}
              onChange={(event) => setWorkshop((f) => ({ ...f, dateTimeLocal: event.target.value }))}
            />
          </p>
          {workshopDateError && <p role="alert">{strings.dateTimeError}</p>}
          <p>
            <label htmlFor="workshop-capacity">{strings.capacityLabel}</label>
            <input
              id="workshop-capacity"
              type="number"
              min={1}
              disabled={workshopBusy}
              value={workshop.capacity}
              onChange={(event) => setWorkshop((f) => ({ ...f, capacity: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="workshop-publish">
              <input
                id="workshop-publish"
                type="checkbox"
                disabled={workshopBusy}
                checked={workshop.publishNow}
                onChange={(event) =>
                  setWorkshop((f) => ({ ...f, publishNow: event.target.checked }))
                }
              />{' '}
              {strings.publishNowLabel}
            </label>
          </p>
          {messagesFor(workshopStatus)}
          <button type="submit" disabled={workshopBusy}>
            {workshopBusy ? strings.submitting : strings.submitButton}
          </button>
        </form>
      </section>
    </>
  );
}
