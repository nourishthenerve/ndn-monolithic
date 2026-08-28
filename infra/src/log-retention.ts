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
import { Annotations, Aspects, RemovalPolicy, Tokenization, type IAspect } from 'aws-cdk-lib';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { CfnFunction } from 'aws-cdk-lib/aws-lambda';
import { CfnLogGroup, LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct, IConstruct } from 'constructs';

export const LOG_RETENTION = RetentionDays.TWO_WEEKS;

/**
 * `grantee`: required whenever the function this log group belongs to is
 * given its own explicit `role:` prop (every hand-rolled role in
 * data-stack.ts/web-stack.ts, built narrow on purpose so a guardrail has a
 * concrete construct to attach to) — CDK only wires `logs:CreateLogStream`/
 * `PutLogEvents` into a function's role automatically when it *also*
 * auto-creates that role; an explicit role plus an explicit log group gets
 * neither for free. Confirmed live in production 2026-08-28: every
 * function built this way (patient, appointment, message, caseload,
 * clinical-record, content-read, even audit-read itself) had zero
 * CloudWatch log streams, ever — the handler ran and answered correctly,
 * because a Lambda's platform-level log delivery failing is silent, not a
 * thrown error. Omit `grantee` only for a function with no explicit
 * `role:` (CDK's own auto-created role already gets this grant) — pass it
 * in every other case, matching `contentReadRole`'s own comment's claim
 * ("read the table, write its own logs") for real rather than in a
 * comment alone.
 */
export function createLogGroup(
  scope: Construct,
  id: string,
  logGroupName: string,
  grantee?: IGrantable,
): LogGroup {
  const logGroup = new LogGroup(scope, id, {
    logGroupName,
    retention: LOG_RETENTION,
    // Logs are operational exhaust, not the "patient, clinical, content or
    // media data" 00-conventions.md's delete prohibition protects — same
    // reasoning web-stack.ts's SiteDeployment pruning uses.
    removalPolicy: RemovalPolicy.DESTROY,
  });
  if (grantee) {
    logGroup.grantWrite(grantee);
  }
  return logGroup;
}

class LogRetentionAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnLogGroup && node.retentionInDays === undefined) {
      node.retentionInDays = LOG_RETENTION;
    }
  }
}

// Gate G1 §4 (docs/plan/gate-g1-report.md), the repeat finding this aspect
// closes: LogRetentionAspect above can only reach log groups that are
// *resources in the template*. A Lambda with no `logGroup` prop has none —
// the CloudWatch Logs service creates `/aws/lambda/<function-name>` on the
// function's first write, outside CloudFormation, with infinite retention
// and nothing to destroy it when the stack goes. One such function (the
// custom resource behind `BucketDeployment`) leaked a fresh orphaned group
// per ephemeral PR stack: 2 at Gate G0, 13 by the time the leak was fixed.
//
// The check reads the L1 property rather than the synthesized template
// because an Aspect visits constructs, not JSON; a LoggingConfig injected
// via `addPropertyOverride` would therefore read as absent here. That is
// the right way round for a guard whose job is to insist on the supported
// prop — `logGroup: createLogGroup(...)` — and never a silent pass.
class ExplicitLambdaLogGroupAspect implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnFunction)) return;

    const loggingConfig = node.loggingConfig;
    const hasExplicitLogGroup =
      loggingConfig !== undefined &&
      !Tokenization.isResolvable(loggingConfig) &&
      loggingConfig.logGroup !== undefined;

    if (!hasExplicitLogGroup) {
      Annotations.of(node).addError(
        'Lambda function has no explicit log group, so CloudWatch would create ' +
          '/aws/lambda/<function-name> with infinite retention, outside CloudFormation. ' +
          'Pass logGroup: createLogGroup(this, "<Id>LogGroup", "/ndn/<name>") ' +
          '(infra/src/log-retention.ts). For a construct that owns its own function, ' +
          'BucketDeployment-style, forward the same log group through its logGroup prop.',
      );
    }
  }
}

/** DoD: "no log group has infinite retention" — enforced for the whole tree under `scope`, not just what's explicit today. */
export function enforceLogRetention(scope: Construct): void {
  Aspects.of(scope).add(new LogRetentionAspect());
  Aspects.of(scope).add(new ExplicitLambdaLogGroupAspect());
}
