// TASK 1.4.1 (ADR-0009): SES sending for the contact-form relay. `From` is
// the verified `nourishthenerve.com` domain identity (docs/runbooks/
// ses-production-access.md, LL-01); `To` is the existing Zoho inbox staff
// already read; `ReplyTo` is the submitter's own address, so a staff
// member's normal "Reply" lands with the visitor, not with this From
// address. TASK 1.5.2 (workshop confirmation email) reuses this same
// verified sending identity, not necessarily this exact function.
//
// TASK 2.3.1: `createSesGenericEmailSender` at the bottom of this file is
// the `EmailSend` port notifications.ts's `Notifier` is built against —
// the same verified identity again, this time addressed and worded by the
// caller (subject/body come from a rendered notification template, not
// from this file), because the Notifier sends whatever template content
// notification-templates.ts renders, not a fixed message.
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

export interface ContactEmailInput {
  readonly name: string;
  readonly email: string;
  readonly message: string;
}

export type EmailSender = (input: ContactEmailInput) => Promise<void>;

export interface SesContactEmailSenderOptions {
  readonly fromAddress: string;
  readonly toAddress: string;
  /**
   * SES configuration set to attribute the send to (infra/src/email-events.ts).
   * Without it SES publishes no bounce/complaint event for the message and
   * the reputation metrics stay empty — the send still works, which is why
   * this is easy to leave off and worth naming explicitly.
   */
  readonly configurationSetName?: string;
  /** Defaults to a real client — tests inject a mocked one (aws-sdk-client-mock) instead. */
  readonly client?: SESv2Client;
}

export function createSesContactEmailSender(options: SesContactEmailSenderOptions): EmailSender {
  const client = options.client ?? new SESv2Client({});

  return async (input) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: options.fromAddress,
        Destination: { ToAddresses: [options.toAddress] },
        ConfigurationSetName: options.configurationSetName,
        ReplyToAddresses: [input.email],
        Content: {
          Simple: {
            Subject: { Data: `Contact form message from ${input.name}` },
            Body: { Text: { Data: input.message } },
          },
        },
      }),
    );
  };
}

// TASK 2.3.1: the generic sender notifications.ts's `Notifier` calls —
// subject and body are the caller's (a rendered notification template),
// not fixed here, unlike the two senders above.
export interface GenericEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

export type GenericEmailSend = (input: GenericEmailInput) => Promise<void>;

export interface SesGenericEmailSenderOptions {
  readonly fromAddress: string;
  /** Same configuration set as the other two senders — see above. */
  readonly configurationSetName?: string;
  /** Defaults to a real client — tests inject a mocked one (aws-sdk-client-mock) instead. */
  readonly client?: SESv2Client;
}

export function createSesGenericEmailSender(options: SesGenericEmailSenderOptions): GenericEmailSend {
  const client = options.client ?? new SESv2Client({});

  return async (input) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: options.fromAddress,
        Destination: { ToAddresses: [input.to] },
        ConfigurationSetName: options.configurationSetName,
        Content: {
          Simple: {
            Subject: { Data: input.subject },
            Body: { Text: { Data: input.body } },
          },
        },
      }),
    );
  };
}
