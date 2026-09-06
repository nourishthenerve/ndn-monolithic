// 2026-09-06: writing a blog post, on a page of its own.
//
// The owner: *"Split blog and workshops button. Also, when I click them it
// should open a pretty rich formatable kind of page to let the person create
// a nice blog post."*
//
// Half of `AuthoringPanel.tsx`, which held this form and the workshop form
// together because one link led to both. Now there is a link each, and a
// component each — the two never shared state, only a file.
//
// **The body is a `RichTextEditor`, not a `<textarea>`.** That is the change
// the request is actually about; everything else here is the same form it
// was. The field still holds a string and the API still takes one, so
// nothing downstream of `buildCreateBlogRequestBody` knows the difference —
// what changed is that the string is now markup within `rich-text/policy.ts`
// rather than plain text split on blank lines. Posts written before today
// still render exactly as they did; see `rich-text/render.ts`.
//
// **Create only, deliberately.** `PATCH /content/{id}` exists and is not
// wired here. Editing needs a list to choose from, a loaded draft and a diff
// — a screen in its own right — and building a bad version of it beside a
// good create form would be worse than not building it yet. Re-`POST`ing the
// same id is refused by the API (`RECORD_ALREADY_EXISTS`), so nothing here
// can silently overwrite a published post.
//
// Rendered only for the principal (`allowRoles`, and the matrix's own
// `Content item` column). A 403 is still an ordinary outcome — the server is
// the boundary, this component only avoids offering what it would refuse.
import type { Locale } from '@ndn/i18n';
import { Heading } from '@ndn/ui';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { isEmptyRichText } from '../rich-text/render.js';

import {
  buildCreateBlogRequestBody,
  EMPTY_BLOG,
  isValidSlug,
  parseKeywords,
  slugify,
} from './authoring-request.js';
import type { BlogFormFields } from './authoring-request.js';
import { post, statusFor } from './authoring-submit.js';
import type { SubmitStatus } from './authoring-submit.js';
import { AuthoringMessages } from './AuthoringMessages.js';
import type { AuthoringMessageStrings } from './AuthoringMessages.js';
import type { PutFile, RequestUploadUrl } from './media-upload.js';
import { MediaUploadField } from './MediaUploadField.js';
import type { MediaUploadFieldStrings } from './MediaUploadField.js';
import { RichTextEditor } from './RichTextEditor.js';
import type { RichTextEditorStrings } from './RichTextEditor.js';

export interface BlogComposerStrings extends AuthoringMessageStrings {
  readonly heading: string;
  readonly intro: string;
  readonly titleLabel: string;
  readonly excerptLabel: string;
  readonly excerptHint: string;
  readonly keywordsLabel: string;
  readonly keywordsHint: string;
  readonly bodyRequired: string;
  readonly slugError: string;
  readonly publishNowLabel: string;
  readonly publishNowHint: string;
  readonly submitButton: string;
  readonly submitting: string;
  readonly media: MediaUploadFieldStrings;
  readonly editor: RichTextEditorStrings;
}

export interface BlogComposerProps {
  readonly strings: BlogComposerStrings;
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly createBlog?: (accessToken: string, body: unknown) => Promise<Response>;
  /** Injectable for tests, exactly as the create call is — the upload path deserves the same treatment. */
  readonly requestImageUrl?: RequestUploadUrl;
  readonly putFile?: PutFile;
}

const defaultClient = createSessionClient();

/** `POST /content/media-upload-url` — the lead image and any image inside the body use the same route. */
export const BLOG_PRESIGN_PATH = '/content/media-upload-url';

export function BlogComposer({
  strings,
  locale,
  client = defaultClient,
  createBlog = post('/content'),
  requestImageUrl,
  putFile,
}: BlogComposerProps): ReactNode {
  const [blog, setBlog] = useState<BlogFormFields>(EMPTY_BLOG);
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [slugError, setSlugError] = useState(false);
  const [bodyError, setBodyError] = useState(false);
  /**
   * Bumped on every successful save, and used as the editor's `key`.
   *
   * A `contenteditable` owns its own DOM, so clearing the form is not enough
   * to clear the surface: `RichTextEditor` re-seeds only when the incoming
   * value differs from what it last emitted, and after a save those are the
   * same string it just handed up. Remounting is the honest way to say "this
   * is a new post now", and it costs one component instance per publish.
   */
  const [composed, setComposed] = useState(0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Checked here rather than left to the API's 400: the slug becomes a
    // public URL, and "that is not a valid slug" is a more useful thing to
    // say than "invalid body".
    if (!isValidSlug(blog.id)) {
      setSlugError(true);
      return;
    }
    setSlugError(false);
    // A `contenteditable` cannot carry `required`, and an untouched one is
    // not the empty string — a browser leaves `<p><br></p>` in it. Without
    // this the form would happily publish an article with no words in it.
    if (isEmptyRichText(blog.body)) {
      setBodyError(true);
      return;
    }
    setBodyError(false);
    setStatus('submitting');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setStatus('forbidden');
      return;
    }
    try {
      const outcome = await statusFor(
        await createBlog(accessToken, buildCreateBlogRequestBody(blog)),
      );
      setStatus(outcome);
      if (outcome === 'success') {
        setBlog(EMPTY_BLOG);
        setComposed((current) => current + 1);
      }
    } catch {
      setStatus('error');
    }
  };

  const busy = status === 'submitting';
  const previewKeywords = parseKeywords(blog.keywords);

  return (
    <section aria-labelledby="blog-composer-heading">
      <Heading level={2} id="blog-composer-heading">
        {strings.heading}
      </Heading>
      <p>{strings.intro}</p>
      <form onSubmit={(event) => void submit(event)}>
        <p>
          <label htmlFor="blog-title">{strings.titleLabel}</label>
          <input
            id="blog-title"
            type="text"
            required
            disabled={busy}
            value={blog.title}
            onChange={(event) => {
              const title = event.target.value;
              // 2026-09-02: the web-address field is gone. The owner: *"I
              // dont want to set a web address for my blog, it should auto
              // pick one based on the title."* It is derived silently, and
              // the only time the address is mentioned at all is the one
              // case that genuinely needs a human — a title with no letters
              // or digits in it, which `slugError` asks them to reword.
              setBlog((fields) => ({ ...fields, title, id: slugify(title) }));
              setSlugError(false);
            }}
          />
        </p>
        {slugError && <p role="alert">{strings.slugError}</p>}

        <p>
          <label htmlFor="blog-excerpt">{strings.excerptLabel}</label>
          <input
            id="blog-excerpt"
            type="text"
            required
            disabled={busy}
            aria-describedby="blog-excerpt-hint"
            value={blog.excerpt}
            onChange={(event) => setBlog((fields) => ({ ...fields, excerpt: event.target.value }))}
          />
        </p>
        {/* Still one line of plain text, and deliberately so: this is the
            `<meta name="description">` and the card on the index page, both
            of which take a string. Formatting it would only produce tags for
            a search engine to print. */}
        <p id="blog-excerpt-hint">{strings.excerptHint}</p>

        {/* The article itself. */}
        <RichTextEditor
          key={composed}
          locale={locale}
          strings={strings.editor}
          presignPath={BLOG_PRESIGN_PATH}
          client={client}
          disabled={busy}
          value={blog.body}
          onChange={(body) => {
            setBlog((fields) => ({ ...fields, body }));
            setBodyError(false);
          }}
          requestUploadUrl={requestImageUrl}
          putFile={putFile}
        />
        {bodyError && <p role="alert">{strings.bodyRequired}</p>}

        <p>
          <label htmlFor="blog-keywords">{strings.keywordsLabel}</label>
          <input
            id="blog-keywords"
            type="text"
            disabled={busy}
            aria-describedby="blog-keywords-hint"
            value={blog.keywords}
            onChange={(event) => setBlog((fields) => ({ ...fields, keywords: event.target.value }))}
          />
        </p>
        <p id="blog-keywords-hint">{strings.keywordsHint}</p>
        {/* What will actually be stored, shown back before it is: a keyword
            is a search partition, so a stray comma or a duplicate is worth
            seeing before it becomes one. */}
        {previewKeywords.length > 0 && (
          <ul>
            {previewKeywords.map((keyword) => (
              <li key={keyword}>{keyword}</li>
            ))}
          </ul>
        )}

        {/* The lead image — the one at the top of the article, distinct from
            any image the author drops into the body. Placed after the words
            and before the publish decision, which is the order the choice is
            actually made in. */}
        <MediaUploadField
          strings={strings.media}
          presignPath={BLOG_PRESIGN_PATH}
          client={client}
          disabled={busy}
          value={blog.imageKey}
          onUploaded={(imageKey) => setBlog((fields) => ({ ...fields, imageKey }))}
          requestUploadUrl={requestImageUrl}
          putFile={putFile}
        />

        <p>
          <label htmlFor="blog-publish">
            <input
              id="blog-publish"
              type="checkbox"
              disabled={busy}
              aria-describedby="blog-publish-hint"
              checked={blog.publishNow}
              onChange={(event) =>
                setBlog((fields) => ({ ...fields, publishNow: event.target.checked }))
              }
            />{' '}
            {strings.publishNowLabel}
          </label>
        </p>
        <p id="blog-publish-hint">{strings.publishNowHint}</p>

        <AuthoringMessages status={status} strings={strings} />
        <button type="submit" disabled={busy}>
          {busy ? strings.submitting : strings.submitButton}
        </button>
      </form>
    </section>
  );
}
