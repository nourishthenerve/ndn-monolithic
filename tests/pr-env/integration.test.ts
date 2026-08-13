import { describe, expect, it } from 'vitest';

import { getBaseUrl } from './env.js';

// TASK 0.6.3: exercises the actual deployed ephemeral stack — real DNS
// (CloudFront's own *.cloudfront.net domain), real TLS, real Lambda behind
// a real HTTP API, real S3-origin static page. Runs only from the
// pr-environment CI job (see .github/workflows/ci.yml), never as part of
// the ordinary `pnpm run test`/`test:integration` gate.
describe('ephemeral PR environment — integration', () => {
  it('serves /health over HTTPS with a 200', async () => {
    const response = await fetch(`${getBaseUrl()}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('serves the placeholder page at / with a 200', async () => {
    const response = await fetch(`${getBaseUrl()}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});
