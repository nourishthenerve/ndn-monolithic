// 2026-09-02: choosing an image for a blog post or a workshop, from the
// form that creates it. The owner: *"principal clinician should be able to
// upload media files while creating blog posts and workshops."*
//
// The workshop presign endpoint has existed since TASK 1.5.1 with no
// caller, and no way for a browser to reach it until today. Blog posts had
// neither endpoint nor field. This is the one control both forms use.
//
// ## Two requests, and why the first one's answer is the thing to keep
//
// Uploading is `POST …/media-upload-url` for a presigned URL, then `PUT`
// straight to S3. The bit that matters afterwards is neither response
// body: it is the **key** the first call returned. That key is what the
// record stores and what the public page turns back into `/media/…`. The
// upload URL is a five-minute capability and is worth nothing once used.
//
// So the component's whole output is `onUploaded(key)`, and it is
// deliberately *not* the form's submit that uploads. The image lands in
// the bucket when it is chosen; the post that references it is written
// when the form is submitted. Those can fail independently, and the
// failure that matters — a record pointing at an object that is not there
// — is the one this ordering makes impossible.
import { useId, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { mediaUrl } from '../site-config.js';

/**
 * What the API's own `uploadBodySchema` accepts, and no more. Repeated
 * here rather than imported because `services/api` is not a dependency of
 * `apps/web` — but a mismatch is only ever a worse error message, since
 * the server rejects the same set with a 400 either way.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * 5 MB. Nothing on the server enforces this — a presigned `PutObject`
 * carries no size condition — so it is honestly a courtesy rather than a
 * limit: it turns "the upload silently took two minutes on clinic wifi"
 * into a sentence, at the moment of choosing, when picking a smaller file
 * is still easy.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type UploadState = 'idle' | 'uploading' | 'uploaded' | 'too-large' | 'wrong-type' | 'failed';

export interface MediaUploadFieldStrings {
  readonly label: string;
  readonly hint: string;
  readonly uploading: string;
  readonly uploaded: string;
  readonly remove: string;
  readonly tooLarge: string;
  readonly wrongType: string;
  readonly failed: string;
  readonly previewAlt: string;
}

export interface MediaUploadFieldProps {
  readonly strings: MediaUploadFieldStrings;
  /** Same-origin presign route — `/workshops/media-upload-url` or `/content/media-upload-url`. */
  readonly presignPath: string;
  /** The stored key, owned by the parent form so a successful submit can clear it. */
  readonly value?: string;
  readonly onUploaded: (key: string | undefined) => void;
  readonly disabled?: boolean;
  readonly client?: SessionClient;
  readonly requestUploadUrl?: (
    accessToken: string,
    body: { fileName: string; contentType: string },
  ) => Promise<Response>;
  readonly putFile?: (uploadUrl: string, file: File) => Promise<Response>;
}

const defaultClient = createSessionClient();

/**
 * Same-origin, like every other presign in this app: `/workshops/…` and
 * `/content/…` are CloudFront behaviours onto the web stack's own API
 * (web-stack.ts). Not `contentApiUrl` — these routes are not on that API,
 * which is precisely the mistake that made assessment uploads 404 for a
 * day (docs/runbooks/assessment-forms.md, 2026-09-02).
 */
function defaultRequestUploadUrl(presignPath: string) {
  return (accessToken: string, body: { fileName: string; contentType: string }): Promise<Response> =>
    fetch(presignPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

/**
 * No `authorization` header: the URL *is* the authorisation, and S3 rejects
 * a signed request that carries headers the signature did not cover.
 * `content-type` is sent because it was signed into the URL.
 */
function defaultPutFile(uploadUrl: string, file: File): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
}

export function MediaUploadField({
  strings,
  presignPath,
  value,
  onUploaded,
  disabled = false,
  client = defaultClient,
  requestUploadUrl,
  putFile = defaultPutFile,
}: MediaUploadFieldProps): ReactNode {
  const [state, setState] = useState<UploadState>(value ? 'uploaded' : 'idle');
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const request = requestUploadUrl ?? defaultRequestUploadUrl(presignPath);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    // Checked before anything is sent: both are answerable from the file
    // itself, and a presigned URL minted for a file that will be refused
    // is a capability issued for nothing.
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
      setState('wrong-type');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setState('too-large');
      return;
    }

    setState('uploading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('failed');
      return;
    }
    try {
      const presign = await request(accessToken, { fileName: file.name, contentType: file.type });
      if (!presign.ok) {
        setState('failed');
        return;
      }
      const { uploadUrl, key } = (await presign.json()) as { uploadUrl: string; key: string };
      const put = await putFile(uploadUrl, file);
      if (!put.ok) {
        setState('failed');
        return;
      }
      // Only now — the key is reported once the object it names exists.
      onUploaded(key);
      setState('uploaded');
    } catch {
      setState('failed');
    }
  };

  const handleRemove = () => {
    onUploaded(undefined);
    setState('idle');
    // The file input keeps its own selection, and a stale filename beside
    // "no image" reads as a bug. Clearing it also makes re-choosing the
    // same file fire `change` again, which it otherwise would not.
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const preview = value ? mediaUrl(value) : undefined;

  return (
    <>
      <p>
        <label htmlFor={inputId}>{strings.label}</label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          aria-describedby={hintId}
          disabled={disabled || state === 'uploading'}
          onChange={(event) => void handleChange(event)}
        />
      </p>
      <p id={hintId}>{strings.hint}</p>
      {state === 'uploading' && (
        <p role="status" aria-live="polite">
          {strings.uploading}
        </p>
      )}
      {state === 'wrong-type' && <p role="alert">{strings.wrongType}</p>}
      {state === 'too-large' && <p role="alert">{strings.tooLarge}</p>}
      {state === 'failed' && <p role="alert">{strings.failed}</p>}
      {value && state === 'uploaded' && (
        <>
          <p role="status">{strings.uploaded}</p>
          {/* Shown back because an image is the one field an author cannot
              proofread by reading the form. `mediaUrl` returns undefined
              for a key outside the public prefix, and nothing is rendered
              rather than a broken `src`. */}
          {preview && <img src={preview} alt={strings.previewAlt} width={240} />}
          <p>
            <button type="button" onClick={handleRemove} disabled={disabled}>
              {strings.remove}
            </button>
          </p>
        </>
      )}
    </>
  );
}
