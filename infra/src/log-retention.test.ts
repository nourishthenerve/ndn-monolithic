// TASK 0.5.2's Tests line: "Integration: new log groups are created with
// 14-day retention (assert in CDK snapshot test)." Same synth-only
// philosophy as web-stack.test.ts — no live AWS calls.

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { describe, it } from 'vitest';

import { createLogGroup, enforceLogRetention } from './log-retention.js';

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
