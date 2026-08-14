// TASK 1.4.1 (ADR-0009): SES sending for the contact-form relay. `From` is
// the verified `nourishthenerve.com` domain identity (docs/runbooks/
// ses-production-access.md, LL-01); `To` is the existing Zoho inbox staff
// already read; `ReplyTo` is the submitter's own address, so a staff
// member's normal "Reply" lands with the visitor, not with this From
// address. TASK 1.5.2 (workshop confirmation email) reuses this same
// verified sending identity, not necessarily this exact function.
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
