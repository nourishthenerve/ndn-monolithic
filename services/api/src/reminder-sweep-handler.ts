// TASK 3.4.3: the deployed Lambda entry for the reminder sweep
// (infra/src/data-stack.ts), invoked by an EventBridge scheduled rule
// (`rate(15 minutes)`) rather than `HttpApi` — this Lambda's `handler` is
// a `ScheduledHandler`, not an API Gateway one, matching every other
// non-HTTP entry point's own split: `reminder-sweep.ts` is SDK-free and
// unit-testable, this file wires the real DynamoDB-backed repositories
// and the real `Notifier` together.
//
// **The one wiring choice this file makes differently from every other
// handler that constructs a `Notifier`** (assignment-handler.ts,
// clinician-admin-handler.ts): those wire `InMemorySpendCounterStore`
// because neither of their own templates is ever `smsEligible` — the SMS
// guard chain is present only to satisfy `NotifierDeps`'s type, never
// actually reached. This file's own template (`appointmentReminder1Hour`)
// *is* `smsEligible`, and this is the first real, scheduled caller of it
// — an in-memory monthly spend counter would reset on most of this
// Lambda's own cold starts (a `rate(15 minutes)` cadence gives AWS little
// reason to keep a container warm between ticks), which would not
// enforce C-02's £5 cap at all. `DynamoSpendCounterStore`
// (dynamo-sms-spend-cap.ts) is what makes the cap durable instead — see
// that file's own header for the full reasoning.
//
// The rate limiter stays in-memory, deliberately: `contact-form-handler.ts`
// already accepts the identical "resets on cold start" limitation for its
// own real, low-volume traffic ("low-volume … traffic doesn't justify
// [a persistent store] sooner"), and this sweep's own volume is bounded
// by real scheduled appointments, not attacker-controlled input — the
// rate limiter here is a secondary, defence-in-depth control beneath the
// two guarantees that actually matter: `reminder_sent_at`'s own atomic
// claim (idempotency — never two sends for one appointment) and the real
// spend cap above (never exceeding £5/month).
import type { Patient } from '@ndn/shared-types';
import type { ScheduledHandler } from 'aws-lambda';

import { AppointmentRepository } from './appointment-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoDeliveryLog } from './dynamo-notification-log.js';
import { DynamoSpendCounterStore } from './dynamo-sms-spend-cap.js';
import { DynamoAppointmentStore, DynamoStore } from './dynamo-store.js';
import { createNotifier } from './notifications.js';
import { PatientRepository } from './patient-repository.js';
import { runReminderSweep } from './reminder-sweep.js';
import { createSesGenericEmailSender } from './ses.js';
import { GenericSmsFlagReader } from './sms-flags.js';
import { createAwsEndUserMessagingSmsProvider } from './sms-provider.js';
import { InMemoryRateLimiter, SMS_RATE_LIMIT_PER_PRINCIPAL, SMS_RATE_LIMIT_WINDOW_MS } from './sms-rate-limiter.js';
import { createSmsSender } from './sms.js';
import { createSsmFlagReader } from './ssm-flag-source.js';


const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
// Wired only to satisfy `PatientRepository`/`AppointmentRepository`'s own
// constructors, which both take an `AuditWriter` for methods (profile
// updates, scheduling, cancelling) this Lambda never calls — it only
// ever reaches `findById`, `listReminderCandidates` and
// `claimForReminder`, none of which write an audit row (this file's own
// header explains why: no principal acted, so there is nothing for
// audit.ts's log to attribute this to).
const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const patients = new PatientRepository(
  new DynamoStore<Patient>({
    tableName,
    keys: { pk: (id: string) => `PAT#${id}`, sk: () => 'PROFILE' },
  }),
  audit,
  systemClock,
);

const appointments = new AppointmentRepository(
  new DynamoAppointmentStore({ tableName }),
  audit,
  systemClock,
);

const notifier = createNotifier({
  sendEmail: createSesGenericEmailSender({
    fromAddress: process.env.REMINDER_FROM_EMAIL ?? 'noreply@nourishthenerve.com',
    configurationSetName: process.env.SES_CONFIGURATION_SET_NAME,
  }),
  sendSms: createSmsSender({
    flags: new GenericSmsFlagReader(flags),
    rateLimiter: new InMemoryRateLimiter({
      clock: systemClock,
      limit: SMS_RATE_LIMIT_PER_PRINCIPAL,
      windowMs: SMS_RATE_LIMIT_WINDOW_MS,
    }),
    spendCounter: new DynamoSpendCounterStore({ tableName: process.env.NOTIFICATION_TABLE_NAME ?? '' }),
    provider: createAwsEndUserMessagingSmsProvider({
      // Empty until provisioned (config.ts's own SMS_ORIGINATION_IDENTITY
      // — a manual, out-of-band AWS step) — the provider call then fails
      // and every send degrades to email, exactly R-01's own "never
      // silently drop a reminder" property.
      originationIdentity: process.env.SMS_ORIGINATION_IDENTITY ?? '',
      configurationSetName: process.env.SES_CONFIGURATION_SET_NAME,
    }),
    clock: systemClock,
  }),
  log: new DynamoDeliveryLog({ tableName: process.env.NOTIFICATION_TABLE_NAME ?? '' }),
  clock: systemClock,
});

export const handler: ScheduledHandler = async () => {
  await runReminderSweep({ appointments, patients, notifier, flags, clock: systemClock });
};
