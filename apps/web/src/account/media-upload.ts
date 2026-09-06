// 2026-09-06: the presign-then-PUT flow, lifted out of `MediaUploadField.tsx`
// so the rich-text editor's own image insertion is the *same* upload rather
// than a second one that looks like it.
//
// Nothing here is new — every rule and every reason below was already written
// down in that component, and its header still carries the full reasoning for
// the ordering (the image lands in the bucket when it is chosen; the record
// that references it is written when the form is submitted, so a record can
// never point at an object that is not there). What changed is that a second
// caller appeared: `RichTextEditor.tsx` inserts images into the body of a
// post, and an upload path duplicated between a field and an editor is two
// places to fix the day the presign route moves.
//
// Deliberately free of React, for this directory's usual reason — a test of
// this logic should not drag a component's JSX into a coverage count.

/**
 * What the API's own `uploadBodySchema` accepts, and no more. Repeated here
 * rather than imported because `services/api` is not a dependency of
 * `apps/web` — but a mismatch is only ever a worse error message, since the
 * server rejects the same set with a 400 either way.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * 5 MB. Nothing on the server enforces this — a presigned `PutObject` carries
 * no size condition — so it is honestly a courtesy rather than a limit: it
 * turns "the upload silently took two minutes on clinic wifi" into a
 * sentence, at the moment of choosing, when picking a smaller file is still
 * easy.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type MediaUploadFailure = 'too-large' | 'wrong-type' | 'failed';

export type MediaUploadResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: MediaUploadFailure };

export type RequestUploadUrl = (
  accessToken: string,
  body: { fileName: string; contentType: string },
) => Promise<Response>;

export type PutFile = (uploadUrl: string, file: File) => Promise<Response>;

/**
 * Same-origin, like every other presign in this app: `/workshops/…` and
 * `/content/…` are CloudFront behaviours onto the web stack's own API
 * (web-stack.ts). Not `contentApiUrl` — these routes are not on that API,
 * which is precisely the mistake that made assessment uploads 404 for a day
 * (docs/runbooks/assessment-forms.md, 2026-09-02).
 */
export function defaultRequestUploadUrl(presignPath: string): RequestUploadUrl {
  return (accessToken, body) =>
    fetch(presignPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}

/**
 * No `authorization` header: the URL *is* the authorisation, and S3 rejects a
 * signed request that carries headers the signature did not cover.
 * `content-type` is sent because it was signed into the URL.
 */
export function defaultPutFile(uploadUrl: string, file: File): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
}

/** `true` when the file is one the API will accept, checked before a presigned URL is minted for it — a capability issued for a file that will be refused is a capability issued for nothing. */
export function checkFile(file: File): MediaUploadFailure | undefined {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type as (typeof ACCEPTED_IMAGE_TYPES)[number])) {
    return 'wrong-type';
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return 'too-large';
  }
  return undefined;
}

/**
 * Choose, presign, PUT, and report the **key** — never the upload URL.
 *
 * That is the whole point of the return value: the key is what a record
 * stores and what a public page turns back into `/media/…`, while the upload
 * URL is a five-minute capability worth nothing once used.
 */
export async function uploadImage(input: {
  readonly file: File;
  readonly accessToken: string;
  readonly requestUploadUrl: RequestUploadUrl;
  readonly putFile: PutFile;
}): Promise<MediaUploadResult> {
  const rejected = checkFile(input.file);
  if (rejected) {
    return { ok: false, reason: rejected };
  }
  try {
    const presign = await input.requestUploadUrl(input.accessToken, {
      fileName: input.file.name,
      contentType: input.file.type,
    });
    if (!presign.ok) {
      return { ok: false, reason: 'failed' };
    }
    const { uploadUrl, key } = (await presign.json()) as { uploadUrl: string; key: string };
    const put = await input.putFile(uploadUrl, input.file);
    if (!put.ok) {
      return { ok: false, reason: 'failed' };
    }
    // Only now — the key is reported once the object it names exists.
    return { ok: true, key };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
