// 2026-09-01: the deployed Lambda entry for
// `POST /patients/{id}/assessments/{assessmentId}/attachment-upload-url`
// (infra/src/data-stack.ts) — the only place that calls the real S3
// presigner for assessment attachments; assessment-upload.ts stays
// SDK-free and unit-testable with an injected `createPresignedPutUrl`.
//
// **Its own function and role, separate from `AssessmentFunction`.** The
// two do different things to different services: this one signs S3 URLs
// and reads one DynamoDB row to resolve a care relationship; that one
// reads and writes the record itself. Keeping them apart means the
// function that can mint an upload capability cannot write the record that
// blesses it, and the function that writes records has no S3 reach at all.
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { createAssessmentUploadHandler } from './assessment-upload.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { createPatientProfileStore } from './dynamo-store.js';
import { PatientRepository } from './patient-repository.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const MEDIA_BUCKET_NAME = process.env.MEDIA_BUCKET_NAME ?? '';

// Short-lived on purpose — the same five minutes media-upload-handler.ts
// uses, and for the same reason: a leaked URL is usable to `PutObject` one
// specific key for a few minutes, never indefinitely. It is also never
// permission for the object to *appear* on the record, which is a second
// authorisation on a second route (assessment.ts).
const PRESIGNED_UPLOAD_URL_EXPIRY_SECONDS = 300;

// `requestChecksumCalculation: 'WHEN_REQUIRED'` is load-bearing, and its
// absence was a live bug (2026-09-02, the third defect found on this one
// upload path).
//
// Since v3.729 the SDK defaults this to `'WHEN_SUPPORTED'`, which adds a
// flexible checksum to every `PutObject`. For a normal in-process upload
// that is a free integrity check. For a **presigned** one it is a trap: the
// checksum is computed over the command's body, which here is empty, and
// then signed *into the URL as a query parameter*:
//
//     x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32
//
// `AAAAAA==` is base64 of four zero bytes — the CRC32 of nothing at all.
// The browser then `PUT`s the real file against a URL that has already
// promised S3 the file is empty, and S3 does exactly what it should: it
// compares, disagrees, and rejects. The URL is unusable for its only
// purpose, and it is unusable the moment it is minted.
//
// `'WHEN_REQUIRED'` omits the checksum for operations that do not demand
// one, so the URL commits to nothing about a body it was never shown.
// Verified by presigning both ways and reading the query string back.
const s3Client = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
// Read-only in practice — this function resolves `assigned_clinician_id`
// and nothing else — but the repository takes an audit writer, so it is
// given the same one every other function uses rather than a stub.
const patients = new PatientRepository(
  createPatientProfileStore(tableName),
  new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' }),
  systemClock,
);

function createPresignedPutUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_UPLOAD_URL_EXPIRY_SECONDS });
}

/**
 * The read half. **This is the only way an assessment attachment is ever
 * served**, and that is deliberate: the `/media/*` CloudFront behaviour
 * serves the bucket to anyone with the path, which is right for a workshop
 * poster and would be catastrophic for a clinical recording. Attachments
 * are reachable exclusively through this route, behind the same
 * section-level `can()` check that governs the record they belong to.
 */
function createPresignedGetUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: MEDIA_BUCKET_NAME, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_UPLOAD_URL_EXPIRY_SECONDS });
}

export const handler = createAssessmentUploadHandler({
  patients,
  flags,
  createPresignedPutUrl,
  createPresignedGetUrl,
});
