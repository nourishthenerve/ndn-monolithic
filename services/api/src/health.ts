import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { systemClock, type Clock } from './clock.js';
import { createSampledLogger, type RequestLogger } from './logger.js';

// TASK 0.5.2 (R-11): /health is polled continuously by the uptime monitor
// (D-18) — logging every poll would be the single largest source of log
// volume in Phase 0. 10% keeps enough of a trail to spot a pattern without
// paying to store the other 90%.
const HEALTH_LOG_SAMPLE_RATE = 0.1;

// DEPLOY_VERSION is set by the CDK stack from the deploying commit's SHA
// (docs/plan/05-execution-plan.md TASK 0.4.1) so /health proves which
// commit is actually live — useful once TASK 0.6.2 adds canary rollback.
export function createHealthHandler(
  clock: Clock,
  logger: RequestLogger = createSampledLogger({ clock, sampleRate: HEALTH_LOG_SAMPLE_RATE }),
): APIGatewayProxyHandlerV2 {
  return async (event) => {
    const start = clock.now();
    const response = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'ok',
        version: process.env.DEPLOY_VERSION ?? 'local',
        timestamp: start.toISOString(),
      }),
    };
    logger.logRequest({
      requestId: event.requestContext.requestId,
      route: '/health',
      statusCode: response.statusCode,
      durationMs: clock.now().getTime() - start.getTime(),
    });
    return response;
  };
}

export const handler = createHealthHandler(systemClock);
