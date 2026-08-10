import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { createHealthHandler } from './health.js';
import type { RequestLogFields, RequestLogger } from './logger.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const fakeEvent = { requestContext: { requestId: 'req-1' } } as never;

function recordingLogger(): { logger: RequestLogger; calls: RequestLogFields[] } {
  const calls: RequestLogFields[] = [];
  return { logger: { logRequest: (fields) => calls.push(fields) }, calls };
}

describe('health handler', () => {
  beforeEach(() => {
    vi.stubEnv('DEPLOY_VERSION', 'abc1234');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 200 with status, version, and timestamp from the injected clock', async () => {
    const { logger } = recordingLogger();
    const handler = createHealthHandler(fixedClock, logger);
    const result = await handler(fakeEvent, {} as never, undefined as never);

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
    const { logger } = recordingLogger();
    const handler = createHealthHandler(fixedClock, logger);
    const result = await handler(fakeEvent, {} as never, undefined as never);
    expect(JSON.parse((result as { body: string }).body)).toMatchObject({ version: 'local' });
  });

  it('logs one line per request, carrying the request id, route, and status', async () => {
    const { logger, calls } = recordingLogger();
    const handler = createHealthHandler(fixedClock, logger);
    await handler(fakeEvent, {} as never, undefined as never);

    expect(calls).toEqual([
      { requestId: 'req-1', route: '/health', statusCode: 200, durationMs: 0 },
    ]);
  });

  it('uses a sampled logger by default, wired to the same injected clock', async () => {
    const handler = createHealthHandler(fixedClock);
    // Default logger's sample rate is < 1, so this must not throw even
    // though nothing asserts on log output here — see logger.test.ts for
    // sampling behaviour itself.
    await expect(handler(fakeEvent, {} as never, undefined as never)).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});
