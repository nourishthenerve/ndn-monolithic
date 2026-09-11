// 2026-09-06: announcing a workshop, on a page of its own.
//
// The other half of the split — see `BlogComposer.tsx` for the reasoning the
// two share. The description gets the same `RichTextEditor` as a post's body:
// a workshop announcement is the one place on this site where a schedule, a
// list of what to bring and a link to directions all belong in one field, and
// none of those survived a plain textarea.
import type { Locale } from '@ndn/i18n';
import { Button, Heading } from '@ndn/ui';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { isEmptyRichText } from '../rich-text/render.js';

import {
  buildCreateWorkshopRequestBody,
  EMPTY_WORKSHOP,
  isValidSlug,
  slugify,
  toUtcInstant,
} from './authoring-request.js';
import type { WorkshopFormFields } from './authoring-request.js';
import { post, statusFor } from './authoring-submit.js';
import type { SubmitStatus } from './authoring-submit.js';
import { AuthoringMessages } from './AuthoringMessages.js';
import type { AuthoringMessageStrings } from './AuthoringMessages.js';
import type { PutFile, RequestUploadUrl } from './media-upload.js';
import { MediaUploadField } from './MediaUploadField.js';
import type { MediaUploadFieldStrings } from './MediaUploadField.js';
import { RichTextEditor } from './RichTextEditor.js';
import type { RichTextEditorStrings } from './RichTextEditor.js';

export interface WorkshopComposerStrings extends AuthoringMessageStrings {
  readonly heading: string;
  readonly intro: string;
  readonly titleLabel: string;
  readonly dateTimeLabel: string;
  readonly capacityLabel: string;
  readonly capacityHint: string;
  readonly descriptionRequired: string;
  readonly slugError: string;
  readonly dateTimeError: string;
  readonly publishNowLabel: string;
  readonly publishNowHint: string;
  readonly submitButton: string;
  readonly submitting: string;
  readonly media: MediaUploadFieldStrings;
  readonly editor: RichTextEditorStrings;
}

export interface WorkshopComposerProps {
  readonly strings: WorkshopComposerStrings;
  readonly locale: Locale;
  readonly client?: SessionClient;
  readonly createWorkshop?: (accessToken: string, body: unknown) => Promise<Response>;
  readonly requestImageUrl?: RequestUploadUrl;
  readonly putFile?: PutFile;
}

const defaultClient = createSessionClient();

/** `POST /workshops/media-upload-url` — the poster and any image inside the description use the same route. */
export const WORKSHOP_PRESIGN_PATH = '/workshops/media-upload-url';

export function WorkshopComposer({
  strings,
  locale,
  client = defaultClient,
  createWorkshop = post('/workshops'),
  requestImageUrl,
  putFile,
}: WorkshopComposerProps): ReactNode {
  const [workshop, setWorkshop] = useState<WorkshopFormFields>(EMPTY_WORKSHOP);
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [slugError, setSlugError] = useState(false);
  const [dateError, setDateError] = useState(false);
  const [descriptionError, setDescriptionError] = useState(false);
  /** See `BlogComposer`'s own note: a contenteditable will not clear itself. */
  const [composed, setComposed] = useState(0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isValidSlug(workshop.id)) {
      setSlugError(true);
      return;
    }
    setSlugError(false);
    const dateTimeUtc = toUtcInstant(workshop.dateTimeLocal);
    if (!dateTimeUtc) {
      setDateError(true);
      return;
    }
    setDateError(false);
    if (isEmptyRichText(workshop.description)) {
      setDescriptionError(true);
      return;
    }
    setDescriptionError(false);
    setStatus('submitting');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setStatus('forbidden');
      return;
    }
    try {
      const outcome = await statusFor(
        await createWorkshop(accessToken, buildCreateWorkshopRequestBody(workshop, dateTimeUtc)),
      );
      setStatus(outcome);
      if (outcome === 'success') {
        setWorkshop(EMPTY_WORKSHOP);
        setComposed((current) => current + 1);
      }
    } catch {
      setStatus('error');
    }
  };

  const busy = status === 'submitting';

  return (
    <section className="ndn-authoring-sheet" aria-labelledby="workshop-composer-heading">
      <Heading level={2} id="workshop-composer-heading">
        {strings.heading}
      </Heading>
      <p className="ndn-authoring-intro">{strings.intro}</p>
      <form onSubmit={(event) => void submit(event)}>
        <p className="ndn-input-wrapper">
          <label className="ndn-input-label" htmlFor="workshop-title">
            {strings.titleLabel}
          </label>
          <input
            className="ndn-input"
            id="workshop-title"
            type="text"
            required
            disabled={busy}
            value={workshop.title}
            onChange={(event) => {
              const title = event.target.value;
              setWorkshop((fields) => ({ ...fields, title, id: slugify(title) }));
              setSlugError(false);
            }}
          />
        </p>
        {/* Derived from the title, never asked for — see `BlogComposer`. */}
        {slugError && (
          <p className="ndn-authoring-alert" role="alert">
            {strings.slugError}
          </p>
        )}

        <RichTextEditor
          key={composed}
          locale={locale}
          strings={strings.editor}
          presignPath={WORKSHOP_PRESIGN_PATH}
          client={client}
          disabled={busy}
          value={workshop.description}
          onChange={(description) => {
            setWorkshop((fields) => ({ ...fields, description }));
            setDescriptionError(false);
          }}
          requestUploadUrl={requestImageUrl}
          putFile={putFile}
        />
        {descriptionError && (
          <p className="ndn-authoring-alert" role="alert">
            {strings.descriptionRequired}
          </p>
        )}

        <p className="ndn-input-wrapper">
          <label className="ndn-input-label" htmlFor="workshop-datetime">
            {strings.dateTimeLabel}
          </label>
          {/* Local wall time in, UTC instant out — `toUtcInstant` does the
              conversion in the author's own timezone, which is the one they
              are typing in. */}
          <input
            className="ndn-input"
            id="workshop-datetime"
            type="datetime-local"
            required
            disabled={busy}
            value={workshop.dateTimeLocal}
            onChange={(event) =>
              setWorkshop((fields) => ({ ...fields, dateTimeLocal: event.target.value }))
            }
          />
        </p>
        {dateError && (
          <p className="ndn-authoring-alert" role="alert">
            {strings.dateTimeError}
          </p>
        )}

        <p className="ndn-input-wrapper">
          <label className="ndn-input-label" htmlFor="workshop-capacity">
            {strings.capacityLabel}
          </label>
          <input
            className="ndn-input"
            id="workshop-capacity"
            type="number"
            min={1}
            disabled={busy}
            aria-describedby="workshop-capacity-hint"
            value={workshop.capacity}
            onChange={(event) =>
              setWorkshop((fields) => ({ ...fields, capacity: event.target.value }))
            }
          />
        </p>
        {/* D-31 made capacity genuinely optional — workshops are
            announcement-only — so "no limit" and "a limit of nothing" stay
            different facts, and the field says which blank means which. */}
        <p className="ndn-authoring-hint" id="workshop-capacity-hint">
          {strings.capacityHint}
        </p>

        <MediaUploadField
          strings={strings.media}
          presignPath={WORKSHOP_PRESIGN_PATH}
          client={client}
          disabled={busy}
          value={workshop.posterKey}
          onUploaded={(posterKey) => setWorkshop((fields) => ({ ...fields, posterKey }))}
          requestUploadUrl={requestImageUrl}
          putFile={putFile}
        />

        <p className="ndn-authoring-publish">
          <label className="ndn-checkbox" htmlFor="workshop-publish">
            <input
              id="workshop-publish"
              type="checkbox"
              disabled={busy}
              aria-describedby="workshop-publish-hint"
              checked={workshop.publishNow}
              onChange={(event) =>
                setWorkshop((fields) => ({ ...fields, publishNow: event.target.checked }))
              }
            />{' '}
            {strings.publishNowLabel}
          </label>
        </p>
        <p className="ndn-authoring-hint" id="workshop-publish-hint">
          {strings.publishNowHint}
        </p>

        <AuthoringMessages status={status} strings={strings} />
        {/* The one action this page is for — the full-size primary pill, as
            `BlogComposer` gives its own. */}
        <p className="ndn-panel-actions">
          <Button type="submit" disabled={busy}>
            {busy ? strings.submitting : strings.submitButton}
          </Button>
        </p>
      </form>
    </section>
  );
}
