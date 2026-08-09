import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { systemClock, type Clock } from './clock.js';

// DEPLOY_VERSION is set by the CDK stack from the deploying commit's SHA
// (docs/plan/05-execution-plan.md TASK 0.4.1) so /health proves which
// commit is actually live — useful once TASK 0.6.2 adds canary rollback.
export function createHealthHandler(clock: Clock): APIGatewayProxyHandlerV2 {
  return async () => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      version: process.env.DEPLOY_VERSION ?? 'local',
      timestamp: clock.now().toISOString(),
    }),
  });
}

export const handler = createHealthHandler(systemClock);
