// 2026-09-02: every presigning `S3Client` must be built with
// `requestChecksumCalculation: 'WHEN_REQUIRED'`, and this is the file that
// makes forgetting it a red build.
//
// ## The bug this exists for
//
// Since v3.729 the AWS SDK defaults `requestChecksumCalculation` to
// `'WHEN_SUPPORTED'`: every `PutObject` carries a flexible checksum. For an
// ordinary in-process upload that is a free integrity check and entirely
// welcome. For a **presigned** URL it is silently fatal, because presigning
// signs a request whose body does not exist yet — so the checksum is
// computed over nothing, and then committed to the URL as a signed query
// parameter:
//
//     x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32
//
// `AAAAAA==` is base64 of four zero bytes: the CRC32 of the empty string.
// The URL has promised S3 that the object is empty before the browser has
// chosen a file. Whatever is uploaded then disagrees with it, and S3
// rejects the request — correctly. The capability is dead on arrival, for
// every file, always.
//
// ## Why a source check rather than a behavioural one
//
// Both halves are tested here, because they answer different questions.
// The behavioural test proves the claim about the SDK is *true* — and
// would notice if a future SDK version changed the defaults again, in
// either direction. The source check proves the two handlers that actually
// mint URLs in production are *wired that way*, which is the thing that
// can regress: a new presigning handler, or a `new S3Client({})` restored
// during a refactor, is invisible to any test that does not go looking for
// it. `audit-wiring.test.ts` sets the precedent for exactly this shape.
import { readdirSync, readFileSync } from 'node:fs';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { describe, expect, it } from 'vitest';

const SOURCE_DIR = new URL('.', import.meta.url);

/** Credentials that never existed — presigning is arithmetic, and reaches no network. */
const FAKE_CREDENTIALS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretexample' };

async function presignedQuery(config: Partial<S3ClientConfigSubset>): Promise<URLSearchParams> {
  const client = new S3Client({
    region: 'eu-west-2',
    credentials: FAKE_CREDENTIALS,
    ...config,
  });
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: 'b', Key: 'k', ContentType: 'application/pdf' }),
    { expiresIn: 300 },
  );
  return new URL(url).searchParams;
}

type S3ClientConfigSubset = { requestChecksumCalculation: 'WHEN_REQUIRED' | 'WHEN_SUPPORTED' };

/** Every production source that builds an S3 client. */
function presigningSources(): { name: string; source: string }[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(new URL(name, SOURCE_DIR), 'utf8') }))
    .filter(({ source }) => source.includes('new S3Client('));
}

describe('presigned upload URLs carry no body checksum', () => {
  it('the SDK default really does bake in the empty-body CRC32 — the 2026-09-02 bug', async () => {
    const query = await presignedQuery({});

    // Not an assertion about what we want; an assertion about what the SDK
    // does, so this file's premise is checked rather than asserted.
    expect(query.get('x-amz-checksum-crc32')).toBe('AAAAAA==');
    expect(query.get('x-amz-sdk-checksum-algorithm')).toBe('CRC32');
  });

  it('WHEN_REQUIRED omits it, leaving the URL agnostic about the body', async () => {
    const query = await presignedQuery({ requestChecksumCalculation: 'WHEN_REQUIRED' });

    expect(query.get('x-amz-checksum-crc32')).toBeNull();
    expect(query.get('x-amz-sdk-checksum-algorithm')).toBeNull();
    // Still a valid signature over the host — the URL is weakened in no
    // other way by this.
    expect(query.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('no production file builds an S3 client without it', () => {
    const offenders = presigningSources()
      .filter(({ source }) => !source.includes("requestChecksumCalculation: 'WHEN_REQUIRED'"))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('finds the handlers it is meant to be guarding', () => {
    // Guards the guard: a filter that silently matched nothing would make
    // the assertion above pass forever.
    expect(presigningSources().map(({ name }) => name).sort()).toEqual([
      'assessment-upload-handler.ts',
      'media-upload-handler.ts',
    ]);
  });
});
