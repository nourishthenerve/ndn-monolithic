// TASK 2.3.1: `Notifier.send` — the one function anything wanting to
// notify a patient calls. D-10 makes email the guaranteed channel and SMS
// the exception; R-01 is the arithmetic behind it ("§5 asks for ~150
// SMS/month; C-02's £5 buys ~108"), and its mitigation register ends on
// "never silently drop a reminder" — a property enforced here, not left as
// an intention: **every branch below appends exactly one delivery record
// (notification-log.ts) before returning. There is no path that returns
// silently.**
//
// Channel choice is the Notifier's, never the caller's (step 1): a
// template not marked `smsEligible` (notification-templates.ts /
// `@ndn/i18n`'s registry) never reaches the SMS path, however its flags
// are set. The one template that is eligible is attempted over SMS first;
// when SMS is unavailable for any reason — capped, killed, rate-limited,
// not a UK number, or the guard chain otherwise says no — the send
// degrades to email and the record says why (step 4). A `marketing`
// template additionally checks the recipient's own preference first
// (`PatientPersonal.marketingOptIn`, already on the record since 2.2.3):
// declining silences marketing, and only marketing — a clinical or safety
// template carries no opt-out, by construction (there is no branch that
// reads `marketingOptIn` for one).
import type { NotificationTemplateId } from '@ndn/i18n';

import type { Clock } from './clock.js';
import type { DeliveryLog, DeliveryOutcome, DeliveryRecord } from './notification-log.js';
import { renderNotification, templateDef } from './notification-templates.js';
import type { SendSms } from './sms.js';

// ADR-0008's Twilio figure, re-verified $0.056/message, converted at the
// plan's own FX rate — the same 5p sms.test.ts already fixtures for
// `costPence`. Provisional: TASK 2.3.2 re-verifies both providers' live
// prices before any provider is actually wired — `sms.ts` still calls
// none, so this number bounds a spend-cap check today, not a real charge.
const APPOINTMENT_REMINDER_SMS_COST_PENCE = 5;

export interface NotificationRecipient {
  /** e.g. a patient's Cognito `sub` — the id a delivery record carries, never an address. */
  readonly id: string;
  readonly email: string;
  readonly phone?: string;
  /**
   * `PatientPersonal.marketingOptIn` — silences `marketing`-category
   * templates only. Optional (TASK 2.4.1): a clinician recipient has no
   * such preference to have, and undefined reads as "not opted in" — safe,
   * because no clinician-facing template is ever `category: 'marketing'`.
   */
  readonly marketingOptIn?: boolean;
}

export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export type EmailSend = (input: EmailSendInput) => Promise<void>;

export interface NotifierDeps {
  readonly sendEmail: EmailSend;
  readonly sendSms: SendSms;
  readonly log: DeliveryLog;
  readonly clock: Clock;
}

export interface Notifier {
  send(
    recipient: NotificationRecipient,
    template: NotificationTemplateId,
    vars: Readonly<Record<string, string>>,
  ): Promise<DeliveryRecord>;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  async function append(
    at: string,
    recipient: NotificationRecipient,
    template: string,
    channel: DeliveryRecord['channel'],
    outcome: DeliveryOutcome,
    reason?: string,
  ): Promise<DeliveryRecord> {
    const record: DeliveryRecord = { at, recipientId: recipient.id, template, channel, outcome, reason };
    await deps.log.append(record);
    return record;
  }

  async function trySendEmail(
    recipient: NotificationRecipient,
    subject: string,
    body: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await deps.sendEmail({ to: recipient.email, subject, body });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'EmailSendFailed' };
    }
  }

  return {
    async send(recipient, template, vars) {
      const at = deps.clock.now().toISOString();
      const def = templateDef(template);

      // Marketing preference: checked before anything is rendered or sent
      // — a decline is a request never actioned, not a send that then
      // fails. Never reached for a non-marketing template (step 3, R-01:
      // "a preference can silence marketing, never a clinical or safety
      // notification").
      if (def.category === 'marketing' && !recipient.marketingOptIn) {
        return append(at, recipient, template, 'email', 'failed', 'MarketingOptOut');
      }

      const rendered = renderNotification(template, vars);

      if (def.smsEligible) {
        const smsResult = await deps.sendSms({
          to: recipient.phone ?? '',
          template,
          vars,
          principal: recipient.id,
          costPence: APPOINTMENT_REMINDER_SMS_COST_PENCE,
        });
        if (smsResult.ok) {
          return append(at, recipient, template, 'sms', 'sent');
        }
        // Degradation (step 4): SMS was unavailable for a named reason —
        // the record says which, and email is tried so the notification
        // is not silently dropped.
        const emailResult = await trySendEmail(recipient, rendered.subject, rendered.emailBody);
        return append(
          at,
          recipient,
          template,
          'email',
          emailResult.ok ? 'degraded' : 'failed',
          emailResult.ok ? smsResult.status : emailResult.reason,
        );
      }

      const emailResult = await trySendEmail(recipient, rendered.subject, rendered.emailBody);
      return append(
        at,
        recipient,
        template,
        'email',
        emailResult.ok ? 'sent' : 'failed',
        emailResult.ok ? undefined : emailResult.reason,
      );
    },
  };
}
