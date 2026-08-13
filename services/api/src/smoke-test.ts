import {
  CodeDeployClient,
  PutLifecycleEventHookExecutionStatusCommand,
} from '@aws-sdk/client-codedeploy';

import { systemClock, type Clock } from './clock.js';
import { createSampledLogger, type RequestLogger } from './logger.js';

// TASK 0.6.2: the AfterAllowTraffic hook for the health Lambda's CodeDeploy
// canary deployment (infra/src/web-stack.ts). CodeDeploy invokes this once
// the deployment's traffic-shifting has completed — see
// docs/runbooks/rollback.md for why that's *after* 100%, not during the
// canary window (the CloudWatch alarms cover that). Reporting 'Failed' back
// to CodeDeploy is what triggers the automatic alias rollback; reporting
// nothing (an uncaught throw) would just make CodeDeploy wait out its own
// timeout, so every path here always reports.
const SMOKE_TEST_LOG_SAMPLE_RATE = 1;

export interface CodeDeployLifecycleEvent {
  readonly DeploymentId: string;
  readonly LifecycleEventHookExecutionId: string;
}

export type Fetcher = (url: string) => Promise<{ status: number }>;

export interface LifecycleReporter {
  reportStatus(input: {
    deploymentId: string;
    lifecycleEventHookExecutionId: string;
    status: 'Succeeded' | 'Failed';
  }): Promise<void>;
}

export function createCodeDeployReporter(
  client: CodeDeployClient = new CodeDeployClient({}),
): LifecycleReporter {
  return {
    async reportStatus({ deploymentId, lifecycleEventHookExecutionId, status }) {
      await client.send(
        new PutLifecycleEventHookExecutionStatusCommand({
          deploymentId,
          lifecycleEventHookExecutionId,
          status,
        }),
      );
    },
  };
}

async function checkPath(fetcher: Fetcher, domain: string, path: string): Promise<boolean> {
  try {
    const response = await fetcher(`https://${domain}${path}`);
    return response.status === 200;
  } catch {
    return false;
  }
}

export function createSmokeTestHandler(
  reporter: LifecycleReporter,
  fetcher: Fetcher = fetch,
  clock: Clock = systemClock,
  logger: RequestLogger = createSampledLogger({
    clock,
    sampleRate: SMOKE_TEST_LOG_SAMPLE_RATE,
  }),
) {
  return async (event: CodeDeployLifecycleEvent): Promise<void> => {
    const start = clock.now();
    const domain = process.env.SITE_DOMAIN;
    // No domain configured is a misconfiguration, not a transient failure —
    // fail the deployment rather than silently passing to reach it.
    const checks = domain
      ? await Promise.all([checkPath(fetcher, domain, '/health'), checkPath(fetcher, domain, '/')])
      : [false, false];
    const passed = checks.every(Boolean);

    await reporter.reportStatus({
      deploymentId: event.DeploymentId,
      lifecycleEventHookExecutionId: event.LifecycleEventHookExecutionId,
      status: passed ? 'Succeeded' : 'Failed',
    });

    logger.logRequest({
      requestId: event.DeploymentId,
      route: 'smoke-test',
      statusCode: passed ? 200 : 500,
      durationMs: clock.now().getTime() - start.getTime(),
    });
  };
}

export const handler = createSmokeTestHandler(createCodeDeployReporter());
