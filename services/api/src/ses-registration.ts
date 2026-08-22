// TASK 2.2.3 step 6: the registration confirmation email, and the reason
// it says almost nothing.
//
// This message goes to an address that has just been verified but not yet
// approved, and it lands in a mailbox this clinic does not control — a
// shared family inbox, a work account, a phone on a lock screen. A subject
// line naming the clinic and the recipient is enough for a bystander to
// learn that someone is seeking neuro-rehabilitation. So: no name in the
// subject, no clinical language anywhere, and nothing about a condition, a
// referral or an appointment.
//
// What remains is a receipt. The patient knows what they signed up for;
// they do not need to be told, and nobody reading over their shoulder
// needs to be told either.
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

/**
 * Deliberately generic, and asserted as such by a test that scans it for
 * clinical vocabulary. "Nourish the Nerve" is the trading name and appears
 * only in the body, not the subject.
 */
export const REGISTRATION_EMAIL_SUBJECT = 'Your registration has been received';

export const REGISTRATION_EMAIL_BODY = [
  'Thank you — your registration has been received.',
  '',
  'A member of the team will review it and be in touch. You do not need to do',
  'anything else for now.',
  '',
  'If you did not register with us, you can ignore this message.',
  '',
  'Nourish the Nerve',
].join('\n');

export interface RegistrationEmailSenderOptions {
  readonly fromAddress: string;
  /** SES configuration set, so bounces and complaints are observable (infra/src/email-events.ts). */
  readonly configurationSetName?: string;
  readonly client?: SESv2Client;
}

export function createRegistrationEmailSender(options: RegistrationEmailSenderOptions) {
  const client = options.client ?? new SESv2Client({});

  return async (to: string): Promise<void> => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: options.fromAddress,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: options.configurationSetName,
        Content: {
          Simple: {
            Subject: { Data: REGISTRATION_EMAIL_SUBJECT },
            Body: { Text: { Data: REGISTRATION_EMAIL_BODY } },
          },
        },
      }),
    );
  };
}
