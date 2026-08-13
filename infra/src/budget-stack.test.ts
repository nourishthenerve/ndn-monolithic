// "Integration against emulated AWS" (same philosophy as web-stack.test.ts
// and guardrails.test.ts): CDK's assertions library synthesizes the exact
// CloudFormation template AWS would receive, with zero live AWS calls. What
// can't be proven this way — that AWS actually evaluates the budget and
// sends mail — is proven for real post-deploy and recorded in
// docs/runbooks/budgets-cost-alarms.md.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { BudgetStack } from './budget-stack.js';
import {
  ALERT_EMAIL,
  LOG_INGESTION_ALARM_THRESHOLD_BYTES,
  MONITORED_LOG_GROUP_NAMES,
  MONTHLY_BUDGET_LIMIT_USD,
} from './config.js';

function synth() {
  const app = new App();
  const stack = new BudgetStack(app, 'TestBudgetStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
  });
  return Template.fromStack(stack);
}

describe('BudgetStack — monthly cost budget', () => {
  it('caps at the C-01 limit, denominated in USD (the account\'s billing currency)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: MONTHLY_BUDGET_LIMIT_USD, Unit: 'USD' },
      }),
    });
  });

  it('emails an ACTUAL-spend alert at 50%, 75%, and 90% — a block never happens in code', () => {
    const template = synth();
    const [thresholds] = Object.values(template.findResources('AWS::Budgets::Budget'));
    const notifications = (
      thresholds as {
        Properties: { NotificationsWithSubscribers: Array<Record<string, unknown>> };
      }
    ).Properties.NotificationsWithSubscribers;

    expect(notifications).toHaveLength(3);
    expect(notifications.map((n) => (n.Notification as { Threshold: number }).Threshold).sort()).toEqual(
      [50, 75, 90],
    );
    for (const entry of notifications) {
      expect(entry.Notification).toMatchObject({
        ComparisonOperator: 'GREATER_THAN',
        NotificationType: 'ACTUAL',
        ThresholdType: 'PERCENTAGE',
      });
      expect(entry.Subscribers).toEqual([{ SubscriptionType: 'EMAIL', Address: ALERT_EMAIL }]);
    }
  });

  it('is tagged for cost allocation', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Budgets::Budget', {
      ResourceTags: [{ Key: 'Project', Value: 'nourishthenerve' }],
    });
  });
});

describe('BudgetStack — cost anomaly detection', () => {
  it('monitors spend by AWS service, account-wide, with no manual maintenance', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
      ResourceTags: [{ Key: 'Project', Value: 'nourishthenerve' }],
    });
  });

  it('emails a daily digest of anomalies with $5+ absolute impact, linked to the monitor', () => {
    const template = synth();
    const [monitorLogicalId] = Object.keys(template.findResources('AWS::CE::AnomalyMonitor'));
    template.hasResourceProperties('AWS::CE::AnomalySubscription', {
      Frequency: 'DAILY',
      MonitorArnList: [{ 'Fn::GetAtt': [monitorLogicalId, 'MonitorArn'] }],
      Subscribers: [{ Type: 'EMAIL', Address: ALERT_EMAIL }],
      ResourceTags: [{ Key: 'Project', Value: 'nourishthenerve' }],
    });
    const [subscription] = Object.values(template.findResources('AWS::CE::AnomalySubscription'));
    const thresholdExpression = JSON.parse(
      (subscription as { Properties: { ThresholdExpression: string } }).Properties
        .ThresholdExpression,
    );
    expect(thresholdExpression).toEqual({
      Dimensions: {
        Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
        MatchOptions: ['GREATER_THAN_OR_EQUAL'],
        Values: ['5'],
      },
    });
  });
});

describe('BudgetStack — log ingestion volume alarm (TASK 0.5.2, R-11)', () => {
  it('alarms when ingestion across every monitored log group exceeds the threshold, summed — not SEARCH()', () => {
    const template = synth();
    // AWS rejects any alarm math expression containing SEARCH() (confirmed
    // against the real API — see docs/runbooks/rollback.md), so this must
    // be a sum of named per-log-group metrics instead.
    const expectedExpression = MONITORED_LOG_GROUP_NAMES.map(
      (_, index) => `FILL(m${index}, 0)`,
    ).join(' + ');
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'ndn-log-ingestion-volume',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: LOG_INGESTION_ALARM_THRESHOLD_BYTES,
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: expectedExpression }),
        ...MONITORED_LOG_GROUP_NAMES.map((logGroupName) =>
          Match.objectLike({
            MetricStat: Match.objectLike({
              Metric: Match.objectLike({
                Namespace: 'AWS/Logs',
                MetricName: 'IncomingBytes',
                Dimensions: [{ Name: 'LogGroupName', Value: logGroupName }],
              }),
              Stat: 'Sum',
            }),
          }),
        ),
      ]),
    });
  });

  it('notifies the alert email via SNS when the alarm fires', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: ALERT_EMAIL,
    });
    const [topicLogicalId] = Object.keys(template.findResources('AWS::SNS::Topic'));
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmActions: Match.arrayWith([{ Ref: topicLogicalId }]),
    });
  });
});

describe('BudgetStack — outputs', () => {
  it('exposes the budget name, anomaly monitor ARN, and log alarm name', () => {
    const template = synth();
    template.hasOutput('BudgetName', {});
    template.hasOutput('AnomalyMonitorArn', {});
    template.hasOutput('LogIngestionAlarmName', {});
  });
});
