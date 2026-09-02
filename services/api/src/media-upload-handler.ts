// TASK 1.5.1: the deployed Lambda entry for POST /workshops/media-upload-url
// (infra/src/web-stack.ts) — the only place that calls the real S3
// presigner; media-upload.ts stays SDK-free and unit-testable with an
// injected `createPresignedPutUrl`.
//
// TASK 2.5.4: no admin secret to resolve here any more — the route sits
// behind infra's real Lambda authorizer by default, and media-upload.ts
// reads the principal straight off the event.
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { createMediaUploadHandler } from './media-upload.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const MEDIA_BUCKET_NAME = process.env.MEDIA_BUCKET_NAME ?? '';

// TASK 1.5.1: short-lived on purpose — a presigned URL that leaked would
// only be usable to PutObject one specific key for a few minutes, not
// indefinitely.
const PRESIGNED_UPLOAD_URL_EXPIRY_SECONDS = 300;

// See `assessment-upload-handler.ts` for why `'WHEN_REQUIRED'` is not
// optional here: the SDK's default bakes the CRC32 of an *empty* body into
// the presigned URL as a signed query parameter, and S3 then rejects the
// real upload for disagreeing with it. Same SDK, same presigning, same bug
// — this one simply had no caller to find it.
const s3Client = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

function createPresignedPutUrl(key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_UPLOAD_URL_EXPIRY_SECONDS });
}

export const handler = createMediaUploadHandler({ flags, createPresignedPutUrl });
