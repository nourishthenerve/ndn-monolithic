// 2026-09-01: "Inside those 3 sections there will be option to upload audio
// file, video file, pictures, word files, pdfs etc. Based on who has access
// to which section that person will be able to upload these docs/media
// files."
//
// This module is the one place the S3 key layout is decided, and it exists
// as its own file because **two endpoints have to agree about it or the
// permission is not real**: `assessment-upload.ts` mints a key, and
// `assessment.ts` refuses to record an attachment whose key is not inside
// the prefix for the patient, form and section being written. If those two
// derived the prefix independently, a caller could get a presigned URL for
// their own general section and then file the resulting object under
// someone else's private one — the upload would be authorised, the
// *record* would not be, and only the second check catches it.
//
// The prefix carries the section for exactly that reason. An attachment's
// section is otherwise only its position in the record (assessment.ts in
// shared-types), which is the right answer for reading it back but gives
// the key check nothing to compare against.

/** infra/src/data-stack.ts grants `s3:PutObject` on exactly this prefix — every key this file generates must stay inside it. */
export const ASSESSMENT_MEDIA_PREFIX = 'assessments/';

/**
 * What the owner listed, resolved to media types. Word documents get both
 * the modern (`.docx`) and legacy (`.doc`) types because a clinic receives
 * both, and "etc" is deliberately not read as "anything": an allow-list is
 * what keeps this from becoming an arbitrary-file host, and adding a type
 * is one line here rather than a policy decision at a call site.
 */
export const ASSESSMENT_ATTACHMENT_CONTENT_TYPES = [
  // Pictures
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  // Audio
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/ogg',
  // Video
  'video/mp4',
  'video/webm',
  'video/quicktime',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * Strips anything but ASCII letters/digits/dot/dash/underscore — a
 * caller-supplied file name is never used as-is in a key or a bucket path.
 * The same rule (and the same reason) as media-upload.ts's own.
 *
 * **Then collapses runs of dots**, which media-upload.ts does not need to
 * and this does. The character filter *keeps* `.`, so a file genuinely
 * named `../notes.pdf` sanitises to `..-notes.pdf` — still containing the
 * `..` that `isAttachmentKeyInSection` below refuses. Without this second
 * pass the endpoint would happily mint a key for that name and the write
 * that records it would then reject it: an upload the caller was
 * authorised for, that could never appear on the record, for a reason
 * nothing would explain. Collapsing here means the two functions cannot
 * disagree about the same file name.
 */
export function sanitizeAttachmentFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\.{2,}/g, '.');
}

/**
 * Where this patient's, this form's, this section's objects live. Every
 * segment is a value the *server* holds — the patient id comes from the
 * authorised path, the section from the authorised `FieldSet` — so there is
 * no part of the prefix a request body can steer.
 *
 * `fieldSet` is typed as `string` rather than `FieldSet` so that the
 * guard in `isAttachmentKeyInSection` can be handed whatever a caller sent
 * and still be a total function; every real call site passes a `FieldSet`.
 */
export function assessmentAttachmentPrefix(
  patientId: string,
  assessmentId: string,
  fieldSet: string,
): string {
  return `${ASSESSMENT_MEDIA_PREFIX}${patientId}/${assessmentId}/${fieldSet}/`;
}

/**
 * Whether a key a caller is asking to *record* is one this patient, form
 * and section could have produced.
 *
 * The `..` check is not redundant with the prefix check. `startsWith` is
 * satisfied by `assessments/<pat>/<form>/general/../private/leak.pdf`,
 * which S3 stores verbatim (keys are opaque strings, not paths) but which
 * any consumer that treats the key as a path — a sync to a filesystem, a
 * CloudFront behaviour, a future export — would resolve out of the
 * section. Refusing the segment outright costs nothing and removes the
 * whole class.
 */
export function isAttachmentKeyInSection(
  key: string,
  patientId: string,
  assessmentId: string,
  fieldSet: string,
): boolean {
  if (key.includes('..')) {
    return false;
  }
  return key.startsWith(assessmentAttachmentPrefix(patientId, assessmentId, fieldSet));
}
