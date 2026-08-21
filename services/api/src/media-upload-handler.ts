// TASK 1.5.1: the deployed Lambda entry for POST /workshops/media-upload-url
// (infra/src/data-stack.ts) — the only place that calls the real S3
// presigner; media-upload.ts stays SDK-free and unit-testable with an
// injected `createPresignedPutUrl`. Reuses the same ADMIN_API_TOKEN SSM
// parameter every other admin-gated handler in this repo reads.
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { createMediaUploadHandler } from './media-upload.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const ADMIN_TOKEN_PARAMETER_NAME = process.env.ADMIN_TOKEN_PARAMETER_NAME ?? '/ndn/admin-api-token';
const MEDIA_BUCKET_NAME = process.env.MEDIA_BUCKET_NAME ?? '';

// TASK 1.5.1: short-lived on purpose — a presigned URL that leaked would
// only be usable to PutObject one specific key for a few minutes, not
// indefinitely.
const PRESIGNED_UPLOAD_URL_EXPIRY_SECONDS = 300;

const ssmClient = new SSMClient({});
const s3Client = new S3Client({});

let cachedTokenPromise: Promise<string> | undefined;

function getAdminToken(): Promise<string> {
  cachedTokenPromise ??= ssmClient
    .send(new GetParameterCommand({ Name: ADMIN_TOKEN_PARAMETER_NAME, WithDecryption: true }))
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${ADMIN_TOKEN_PARAMETER_NAME} has no value`);
      }
      return value;
    })
    .catch((error: unknown) => {
      cachedTokenPromise = undefined;
      throw error;
    });
  return cachedTokenPromise;
}

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

export const handler = createMediaUploadHandler({ flags, getAdminToken, createPresignedPutUrl });
