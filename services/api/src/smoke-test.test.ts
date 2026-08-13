import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import type { RequestLogFields, RequestLogger } from './logger.js';
import { createSmokeTestHandler, type Fetcher, type LifecycleReporter } from './smoke-test.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const fakeEvent = { DeploymentId: 'd-1', LifecycleEventHookExecutionId: 'h-1' };

function recordingReporter(): {
  reporter: LifecycleReporter;
  calls: Array<{ deploymentId: string; lifecycleEventHookExecutionId: string; status: string }>;
} {
  const calls: Array<{
    deploymentId: string;
    lifecycleEventHookExecutionId: string;
    status: string;
  }> = [];
  return {
    reporter: {
      async reportStatus(input) {
        calls.push(input);
      },
    },
    calls,
  };
}

function recordingLogger(): { logger: RequestLogger; calls: RequestLogFields[] } {
  const calls: RequestLogFields[] = [];
  return { logger: { logRequest: (fields) => calls.push(fields) }, calls };
}

function okFetcher(): Fetcher {
  return async () => ({ status: 200 });
}

describe('smoke test handler', () => {
  beforeEach(() => {
    vi.stubEnv('SITE_DOMAIN', 'next.nourishthenerve.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports Succeeded when /health and / both return 200', async () => {
    const { reporter, calls } = recordingReporter();
    const requested: string[] = [];
    const fetcher: Fetcher = async (url) => {
      requested.push(url);
      return { status: 200 };
    };
    const handler = createSmokeTestHandler(reporter, fetcher, fixedClock, recordingLogger().logger);

    await handler(fakeEvent);

    expect(calls).toEqual([
      { deploymentId: 'd-1', lifecycleEventHookExecutionId: 'h-1', status: 'Succeeded' },
    ]);
    expect(requested.sort()).toEqual(
      ['https://next.nourishthenerve.com/', 'https://next.nourishthenerve.com/health'].sort(),
    );
  });

  it('reports Failed when /health returns a non-200 status', async () => {
    const { reporter, calls } = recordingReporter();
    const fetcher: Fetcher = async (url) =>
      url.endsWith('/health') ? { status: 500 } : { status: 200 };
    const handler = createSmokeTestHandler(reporter, fetcher, fixedClock, recordingLogger().logger);

    await handler(fakeEvent);

    expect(calls).toEqual([
      { deploymentId: 'd-1', lifecycleEventHookExecutionId: 'h-1', status: 'Failed' },
    ]);
  });

  it('reports Failed when the real page (/) returns a non-200 status', async () => {
    const { reporter, calls } = recordingReporter();
    const fetcher: Fetcher = async (url) =>
      url.endsWith('/health') ? { status: 200 } : { status: 404 };
    const handler = createSmokeTestHandler(reporter, fetcher, fixedClock, recordingLogger().logger);

    await handler(fakeEvent);

    expect(calls).toEqual([
      { deploymentId: 'd-1', lifecycleEventHookExecutionId: 'h-1', status: 'Failed' },
    ]);
  });

  it('reports Failed rather than throwing when fetch itself rejects', async () => {
    const { reporter, calls } = recordingReporter();
    const fetcher: Fetcher = async () => {
      throw new Error('network unreachable');
    };
    const handler = createSmokeTestHandler(reporter, fetcher, fixedClock, recordingLogger().logger);

    await expect(handler(fakeEvent)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { deploymentId: 'd-1', lifecycleEventHookExecutionId: 'h-1', status: 'Failed' },
    ]);
  });

  it('reports Failed when SITE_DOMAIN is unset rather than defaulting to a pass', async () => {
    vi.unstubAllEnvs();
    const { reporter, calls } = recordingReporter();
    const handler = createSmokeTestHandler(
      reporter,
      okFetcher(),
      fixedClock,
      recordingLogger().logger,
    );

    await handler(fakeEvent);

    expect(calls).toEqual([
      { deploymentId: 'd-1', lifecycleEventHookExecutionId: 'h-1', status: 'Failed' },
    ]);
  });

  it('logs one line carrying the deployment id and pass/fail status', async () => {
    const { reporter } = recordingReporter();
    const { logger, calls } = recordingLogger();
    const handler = createSmokeTestHandler(reporter, okFetcher(), fixedClock, logger);

    await handler(fakeEvent);

    expect(calls).toEqual([
      { requestId: 'd-1', route: 'smoke-test', statusCode: 200, durationMs: 0 },
    ]);
  });

  it('uses a sampled logger and the real fetch/clock by default, wired without throwing', () => {
    const { reporter } = recordingReporter();
    expect(() => createSmokeTestHandler(reporter)).not.toThrow();
  });
});
