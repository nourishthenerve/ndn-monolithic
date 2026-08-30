import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSesGenericEmailSender } from './ses.js';

const sesMock = mockClient(SESv2Client);

beforeEach(() => {
  sesMock.reset();
});

describe('createSesGenericEmailSender', () => {
  it('sends the caller-supplied subject and body, no ReplyTo', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
    const sendEmail = createSesGenericEmailSender({
      fromAddress: 'noreply@nourishthenerve.com',
      client: sesMock as unknown as SESv2Client,
    });

    await sendEmail({
      to: 'patient@example.com',
      subject: 'Your appointment reminder',
      body: 'Your appointment is at 14:00.',
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      FromEmailAddress: 'noreply@nourishthenerve.com',
      Destination: { ToAddresses: ['patient@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: 'Your appointment reminder' },
          Body: { Text: { Data: 'Your appointment is at 14:00.' } },
        },
      },
    });
    expect(calls[0]?.args[0].input.ReplyToAddresses).toBeUndefined();
  });
});

// Bounce/complaint observability: SES only publishes events for a message
// that names a configuration set. Omitting it is invisible — the send still
// succeeds, and the silence looks exactly like "no bounces yet" — so the
// sender is asserted to pass it through, and to leave it unset when it was
// not given one rather than inventing a name that may not exist.
describe('configuration set attribution', () => {
  it('attaches the configuration set to the generic sender', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-2' });
    const sendEmail = createSesGenericEmailSender({
      fromAddress: 'noreply@nourishthenerve.com',
      configurationSetName: 'ndn-email',
      client: sesMock as unknown as SESv2Client,
    });

    await sendEmail({
      to: 'attendee@example.com',
      subject: "You're registered: Neuro-rehab basics",
      body: 'Your registration for "Neuro-rehab basics" is confirmed.',
    });

    expect(sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input).toMatchObject({
      ConfigurationSetName: 'ndn-email',
    });
  });

  it('sends without one when none is given, rather than guessing a name', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-3' });
    const sendEmail = createSesGenericEmailSender({
      fromAddress: 'noreply@nourishthenerve.com',
      client: sesMock as unknown as SESv2Client,
    });

    await sendEmail({
      to: 'attendee@example.com',
      subject: "You're registered: Neuro-rehab basics",
      body: 'Your registration for "Neuro-rehab basics" is confirmed.',
    });

    expect(
      sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input.ConfigurationSetName,
    ).toBeUndefined();
  });
});
