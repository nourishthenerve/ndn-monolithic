// TASK 0.5.2: R-11 (docs/plan/02-risk-register.md) — CloudWatch Logs
// ingestion is billed per GB and storage compounds if retention is left at
// the service default of "never expire". `createLogGroup` is how every
// Lambda in this repo should get its log group from now on (explicit
// `logGroup` prop — the modern replacement for the deprecated `logRetention`
// prop, see aws-cdk-lib's function.d.ts). `enforceLogRetention` is a
// synth-time safety net: an Aspect, applied once app-wide in bin/app.ts, so
// a future log group that forgets to go through `createLogGroup` still gets
// capped at 14 days rather than silently reverting to infinite retention —
// "CDK default rather than a habit" (docs/plan/09-self-audit.md, item 5).
import { Aspects, RemovalPolicy, type IAspect } from 'aws-cdk-lib';
import { CfnLogGroup, LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct, IConstruct } from 'constructs';

export const LOG_RETENTION = RetentionDays.TWO_WEEKS;

export function createLogGroup(scope: Construct, id: string, logGroupName: string): LogGroup {
  return new LogGroup(scope, id, {
    logGroupName,
    retention: LOG_RETENTION,
    // Logs are operational exhaust, not the "patient, clinical, content or
    // media data" 00-conventions.md's delete prohibition protects — same
    // reasoning web-stack.ts's SiteDeployment pruning uses.
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

class LogRetentionAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnLogGroup && node.retentionInDays === undefined) {
      node.retentionInDays = LOG_RETENTION;
    }
  }
}

/** DoD: "no log group has infinite retention" — enforced for the whole tree under `scope`, not just what's explicit today. */
export function enforceLogRetention(scope: Construct): void {
  Aspects.of(scope).add(new LogRetentionAspect());
}
