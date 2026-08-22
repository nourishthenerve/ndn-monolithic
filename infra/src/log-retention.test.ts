// TASK 0.5.2's Tests line: "Integration: new log groups are created with
// 14-day retention (assert in CDK snapshot test)." Same synth-only
// philosophy as web-stack.test.ts — no live AWS calls.

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { CfnLogGroup, type LogGroup } from 'aws-cdk-lib/aws-logs';
import { describe, expect, it } from 'vitest';

import { MONITORED_LOG_GROUP_NAMES, UNMONITORED_LOG_GROUP_NAMES } from './config.js';
import { DataStack } from './data-stack.js';
import { createLogGroup, enforceLogRetention } from './log-retention.js';
import { WebStack } from './web-stack.js';

describe('createLogGroup', () => {
  it('sets 14-day retention and DESTROY removal policy', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    createLogGroup(stack, 'ExplicitLogGroup', '/ndn/test-function');

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/test-function',
      RetentionInDays: 14,
    });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  });
});

describe('enforceLogRetention', () => {
  it('caps a log group that never called createLogGroup and set no retention itself', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    enforceLogRetention(app);
    new CfnLogGroup(stack, 'BareLogGroup', { logGroupName: '/ndn/forgot-retention' });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/forgot-retention',
      RetentionInDays: 14,
    });
  });

  it('does not override a log group that already set its own finite retention', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    enforceLogRetention(app);
    new CfnLogGroup(stack, 'CustomLogGroup', {
      logGroupName: '/ndn/custom-retention',
      retentionInDays: 30,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/custom-retention',
      RetentionInDays: 30,
    });
  });

  it('leaves an explicit RemovalPolicy.RETAIN log group alone otherwise (retention still enforced)', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    enforceLogRetention(app);
    const logGroup = createLogGroup(stack, 'RetainedLogGroup', '/ndn/retained');
    logGroup.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/retained',
      RetentionInDays: 14,
    });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
  });
});

// Both production stacks, synthesized once for the whole file — the same
// cost web-stack.test.ts memoizes away, for the same reason: every synth
// re-bundles thirteen Lambdas through esbuild, and a Template is only read.
let templates: Array<{ stackName: string; template: Template }> | undefined;

function productionTemplates(): Array<{ stackName: string; template: Template }> {
  return (templates ??= (() => {
    const app = new App();
    enforceLogRetention(app);
    const env = { account: '357601815388', region: 'eu-west-2' };
    const dataStack = new DataStack(app, 'NdnDataStack', { env });
    const webStack = new WebStack(app, 'NdnWebStack', {
      env,
      deployVersion: 'test-sha',
      table: dataStack.table,
      // TASK 2.5.4: matches bin/app.ts's real wiring — without this,
      // MediaUploadFunction's new `if (props.authorizerFunction)` gate
      // (web-stack.ts) means this helper would silently stop
      // synthesizing it at all, same gap web-stack.test.ts's own
      // synthWithTable() had until this task.
      authorizerFunction: dataStack.authorizerFunction,
    });
    return [dataStack, webStack].map((stack) => ({
      stackName: stack.stackName,
      template: Template.fromStack(stack),
    }));
  })());
}

// Gate G1 §4's repeat finding. The aspect above can only reach log groups
// that exist as template resources; a Lambda with no `logGroup` prop has
// none, and CloudWatch creates its `/aws/lambda/<function-name>` group
// outside CloudFormation with infinite retention and no removal policy.
// That is how 13 orphaned groups accumulated, one per ephemeral PR stack.
describe('enforceLogRetention — implicit Lambda log groups', () => {
  function stackWithFunction(logGroup?: (scope: Stack) => LogGroup) {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    enforceLogRetention(app);
    new LambdaFunction(stack, 'Handler', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => {};'),
      ...(logGroup ? { logGroup: logGroup(stack) } : {}),
    });
    return stack;
  }

  // An error annotation, not a thrown exception: `cdk synth` collects them
  // and exits 1 ("Synthesis finished with errors" — verified against the
  // CLI, which is what CI's deploy job runs), while the programmatic synth
  // the assertions library performs keeps going. Asserting on the
  // annotation is therefore the assertion that matches the mechanism.
  it('fails synthesis for a Lambda that would get CloudWatch’s infinite-retention default', () => {
    Annotations.fromStack(stackWithFunction()).hasError(
      '/TestStack/Handler/Resource',
      Match.stringLikeRegexp('.*no explicit log group.*'),
    );
  });

  it('says nothing about a Lambda that names its own log group', () => {
    Annotations.fromStack(
      stackWithFunction((stack) => createLogGroup(stack, 'HandlerLogGroup', '/ndn/handler')),
    ).hasNoError('*', Match.stringLikeRegexp('.*no explicit log group.*'));
  });

  it('passes a Lambda whose log group came from createLogGroup', () => {
    const template = Template.fromStack(
      stackWithFunction((stack) => createLogGroup(stack, 'HandlerLogGroup', '/ndn/handler')),
    );

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/handler',
      RetentionInDays: 14,
    });
    const [logGroupLogicalId] = Object.keys(template.findResources('AWS::Logs::LogGroup'));
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({ LogGroup: { Ref: logGroupLogicalId } }),
    });
  });

  it('holds across the real app — every Lambda in both production stacks names its own group', () => {
    for (const { stackName, template } of productionTemplates()) {
      const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
      expect(functions.length).toBeGreaterThan(0);
      for (const [logicalId, resource] of functions) {
        const properties = (resource as { Properties?: { LoggingConfig?: { LogGroup?: unknown } } })
          .Properties;
        expect(properties?.LoggingConfig?.LogGroup, `${stackName}/${logicalId}`).toBeDefined();
      }
    }
  });
});

// The log-volume alarm (budget-stack.ts) can name at most 10 log groups —
// PutMetricAlarm rejects an eleventh metric outright, which would break
// every deploy the way SEARCH() once did. These two assertions are what
// stop a new createLogGroup() call from silently going unmonitored, or
// silently going over the ceiling.
describe('log-volume alarm coverage', () => {
  it('stays inside PutMetricAlarm’s 10-metric ceiling', () => {
    expect(MONITORED_LOG_GROUP_NAMES.length).toBeLessThanOrEqual(10);
  });

  it('accounts for every /ndn/* log group the production app synthesizes', () => {
    const synthesized = productionTemplates()
      .flatMap(({ template }) => Object.values(template.findResources('AWS::Logs::LogGroup')))
      .map(
        (resource) =>
          (resource as { Properties?: { LogGroupName?: string } }).Properties?.LogGroupName,
      )
      .filter((name): name is string => typeof name === 'string');

    const accountedFor = [...MONITORED_LOG_GROUP_NAMES, ...UNMONITORED_LOG_GROUP_NAMES];
    expect([...synthesized].sort()).toEqual([...accountedFor].sort());
  });
});
