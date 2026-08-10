// TASK 0.5.1: budgets and cost alarms — the account-wide guard that must
// exist before Phase 1 adds anything that could grow spend unnoticed
// (docs/plan/09-self-audit.md, item 5). Two independent mechanisms, both
// email: an AWS Budgets threshold budget (known cap, known thresholds) and
// AWS Cost Anomaly Detection (catches an unexpected spend *pattern* even
// while comfortably under the cap). See docs/runbooks/budgets-cost-alarms.md.

import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { CfnAnomalyMonitor, CfnAnomalySubscription } from 'aws-cdk-lib/aws-ce';
import type { Construct } from 'constructs';

import {
  ALERT_EMAIL,
  COST_ALLOCATION_TAG_KEY,
  COST_ALLOCATION_TAG_VALUE,
  MONTHLY_BUDGET_LIMIT_USD,
} from './config.js';

// AWS::Budgets::Budget and AWS::CE::Anomaly* don't take a resource-level
// `tags` prop wired through the standard `Tags.of(...)` aspect the way most
// L2 constructs do (Budget has no TagManager at all; the CE resources do,
// but only via `resourceTags`) — so these three are tagged explicitly here,
// on top of the app-wide `Tags.of(app)` in bin/app.ts covering everything
// else.
const resourceTags = [{ key: COST_ALLOCATION_TAG_KEY, value: COST_ALLOCATION_TAG_VALUE }];

function actualPercentNotification(thresholdPercent: number) {
  return {
    notification: {
      comparisonOperator: 'GREATER_THAN',
      notificationType: 'ACTUAL',
      threshold: thresholdPercent,
      thresholdType: 'PERCENTAGE',
    },
    subscribers: [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }],
  };
}

export class BudgetStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    new CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'ndn-monthly-cost-cap',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: MONTHLY_BUDGET_LIMIT_USD, unit: 'USD' },
      },
      // A block, not an alert, at 100% — C-01 has no code-level enforcement
      // point (unlike 0.5.3's SMS cap), so 50/75/90% is the earliest
      // practical warning: three chances to act before the cap is reached.
      notificationsWithSubscribers: [
        actualPercentNotification(50),
        actualPercentNotification(75),
        actualPercentNotification(90),
      ],
      resourceTags,
    });

    // AWS-managed, SERVICE-dimensioned monitor: tracks per-service spend
    // patterns account-wide with no maintenance as new services get used —
    // a hand-maintained CUSTOM monitor would need updating every time a new
    // AWS service enters the bill.
    const monitor = new CfnAnomalyMonitor(this, 'CostAnomalyMonitor', {
      monitorName: 'ndn-cost-anomaly-monitor',
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
      resourceTags,
    });

    new CfnAnomalySubscription(this, 'CostAnomalySubscription', {
      subscriptionName: 'ndn-cost-anomaly-subscription',
      // EMAIL delivery requires DAILY or WEEKLY frequency — IMMEDIATE is
      // SNS-only. DAILY matches the budget notifications' own cadence.
      frequency: 'DAILY',
      monitorArnList: [monitor.attrMonitorArn],
      subscribers: [{ type: 'EMAIL', address: ALERT_EMAIL }],
      // $5 absolute impact: at this account's ~$3-10/mo total spend
      // (docs/plan/03-cost-model.md), a single anomaly of that size is
      // already a meaningful fraction of the whole envelope.
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: ['5'],
        },
      }),
      resourceTags,
    });

    new CfnOutput(this, 'BudgetName', { value: 'ndn-monthly-cost-cap' });
    new CfnOutput(this, 'AnomalyMonitorArn', { value: monitor.attrMonitorArn });
  }
}
