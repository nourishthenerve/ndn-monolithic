// TASK 2.3.1 (ADR-0009): `createSesGenericEmailSender` below is the
// `EmailSend` port notifications.ts's `Notifier` is built against — the
// verified `nourishthenerve.com` domain identity (docs/runbooks/
// ses-production-access.md, LL-01), addressed and worded by the caller
// (subject/body come from a rendered notification template, not from this
// file), because the Notifier sends whatever template content
// notification-templates.ts renders, not a fixed message.
//
// D-32 (2026-08-30): this file used to also hold `createSesContactEmailSender`,
// the contact form's own fixed-shape sender — deleted along with the form
// itself, not darkened; see docs/runbooks/contact-form.md.
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

// The generic sender notifications.ts's `Notifier` calls —
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
