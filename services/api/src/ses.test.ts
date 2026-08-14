import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { createSesContactEmailSender } from './ses.js';

const sesMock = mockClient(SESv2Client);

beforeEach(() => {
  sesMock.reset();
});

describe('createSesContactEmailSender', () => {
  it('sends exactly one SendEmailCommand with the expected To/ReplyTo', async () => {
    sesMock.on(SendEmailCommand).resolves({ MessageId: 'msg-1' });
    const sendEmail = createSesContactEmailSender({
      fromAddress: 'noreply@nourishthenerve.com',
      toAddress: 'contact@nourishthenerve.com',
      client: sesMock as unknown as SESv2Client,
    });

    await sendEmail({ name: 'Ada Lovelace', email: 'ada@example.com', message: 'Hello there' });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      FromEmailAddress: 'noreply@nourishthenerve.com',
      Destination: { ToAddresses: ['contact@nourishthenerve.com'] },
      ReplyToAddresses: ['ada@example.com'],
      Content: { Simple: { Body: { Text: { Data: 'Hello there' } } } },
    });
  });
});
