import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { createHealthHandler } from './health.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

describe('health handler', () => {
  beforeEach(() => {
    vi.stubEnv('DEPLOY_VERSION', 'abc1234');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 200 with status, version, and timestamp from the injected clock', async () => {
    const handler = createHealthHandler(fixedClock);
    const result = await handler({} as never, {} as never, undefined as never);

    expect(result).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse((result as { body: string }).body)).toEqual({
      status: 'ok',
      version: 'abc1234',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('falls back to "local" when DEPLOY_VERSION is unset', async () => {
    vi.unstubAllEnvs();
    const handler = createHealthHandler(fixedClock);
    const result = await handler({} as never, {} as never, undefined as never);
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ version: 'local' });
  });
});
