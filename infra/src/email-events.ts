// Bounce/complaint/reject observability for the two SES senders in
// web-stack.ts (contact-form relay, workshop registration confirmation).
//
// What existed before this: SES's account-level suppression list (on, for
// BOUNCE and COMPLAINT) and default feedback forwarding. Those are real,
// but between them they only mean "a bad address stops receiving mail and
// someone might notice an email about it" — there is no signal anything
// can alarm on, and no record beyond an inbox. This adds the missing half.
//
// Kept out of web-stack.ts for the same reason flag-parameters.ts is:
// it is one self-contained concern used from more than one place, and
// web-stack.ts is long enough.
import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import {
  ConfigurationSet,
  ConfigurationSetEventDestination,
  EmailSendingEvent,
  EventDestination,
  SuppressionReasons,
} from 'aws-cdk-lib/aws-ses';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

import { ALERT_EMAIL, SES_CONFIGURATION_SET_NAME } from './config.js';

// Only the events that mean something went wrong. DELIVERY, SEND and OPEN
// are deliberately absent: this topic has a human's inbox on the other end
// (same pattern as budget-stack.ts's log-ingestion alarm), and a
// notification per successful send would train that human to ignore it —
// which is exactly the failure mode this is meant to prevent.
const NOTIFIED_EVENTS = [
  EmailSendingEvent.BOUNCE,
  EmailSendingEvent.COMPLAINT,
  EmailSendingEvent.REJECT,
  EmailSendingEvent.RENDERING_FAILURE,
];

// SES publishes Reputation.BounceRate/ComplaintRate as a fraction, not a
// percentage. AWS's own review thresholds are 5% bounce and 0.1% complaint;
// these alarm well below both, because at this volume a handful of bad
// addresses is the difference between fine and account-review, and the
// point is to find out before AWS does.
const BOUNCE_RATE_ALARM_THRESHOLD = 0.03;
const COMPLAINT_RATE_ALARM_THRESHOLD = 0.001;

export interface EmailEventPipeline {
  readonly configurationSetName: string;
}

export function createEmailEventPipeline(scope: Construct): EmailEventPipeline {
  const topic = new Topic(scope, 'EmailEventsTopic', { topicName: 'ndn-email-events' });
  topic.addSubscription(new EmailSubscription(ALERT_EMAIL));

  const configurationSet = new ConfigurationSet(scope, 'EmailConfigurationSet', {
    configurationSetName: SES_CONFIGURATION_SET_NAME,
    // Restates the account-level setting at the configuration-set level, so
    // suppression survives someone changing the account default. Belt and
    // braces on the one behaviour that protects our sending reputation.
    suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    // Publishes Reputation.* metrics to CloudWatch for this set — what the
    // two alarms below read, and unavailable without it.
    reputationMetrics: true,
  });

  new ConfigurationSetEventDestination(scope, 'EmailEventsDestination', {
    configurationSet,
    destination: EventDestination.snsTopic(topic),
    events: NOTIFIED_EVENTS,
  });

  reputationAlarm(scope, {
    id: 'EmailBounceRateAlarm',
    alarmName: 'ndn-email-bounce-rate',
    metricName: 'Reputation.BounceRate',
    threshold: BOUNCE_RATE_ALARM_THRESHOLD,
    topic,
  });
  reputationAlarm(scope, {
    id: 'EmailComplaintRateAlarm',
    alarmName: 'ndn-email-complaint-rate',
    metricName: 'Reputation.ComplaintRate',
    threshold: COMPLAINT_RATE_ALARM_THRESHOLD,
    topic,
  });

  return { configurationSetName: SES_CONFIGURATION_SET_NAME };
}

interface ReputationAlarmProps {
  readonly id: string;
  readonly alarmName: string;
  readonly metricName: string;
  readonly threshold: number;
  readonly topic: Topic;
}

function reputationAlarm(scope: Construct, props: ReputationAlarmProps): void {
  const alarm = new Alarm(scope, props.id, {
    alarmName: props.alarmName,
    metric: new Metric({
      namespace: 'AWS/SES',
      metricName: props.metricName,
      statistic: 'Maximum',
      period: Duration.hours(1),
    }),
    threshold: props.threshold,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
    // An hour in which nothing was sent has no datapoint and is not a
    // breach — the normal state for this account today.
    treatMissingData: TreatMissingData.NOT_BREACHING,
  });
  alarm.addAlarmAction(new SnsAction(props.topic));
}
