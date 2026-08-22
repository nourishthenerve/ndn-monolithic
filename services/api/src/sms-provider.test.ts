import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAwsEndUserMessagingSmsProvider,
  DEFAULT_MAX_PRICE_USD,
} from './sms-provider.js';

const pinpointMock = mockClient(PinpointSMSVoiceV2Client);

beforeEach(() => {
  pinpointMock.reset();
});

describe('createAwsEndUserMessagingSmsProvider', () => {
  it('sends exactly one SendTextMessageCommand as TRANSACTIONAL, with the default MaxPrice', async () => {
    pinpointMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-1' });
    const provider = createAwsEndUserMessagingSmsProvider({
      originationIdentity: 'phone-id-123',
      client: pinpointMock as unknown as PinpointSMSVoiceV2Client,
    });

    await provider.send({ to: '+447911123456', body: 'Reminder: your appointment is at 14:00 today.' });

    const calls = pinpointMock.commandCalls(SendTextMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      DestinationPhoneNumber: '+447911123456',
      OriginationIdentity: 'phone-id-123',
      MessageBody: 'Reminder: your appointment is at 14:00 today.',
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: undefined,
      MaxPrice: DEFAULT_MAX_PRICE_USD,
    });
  });

  it('passes the configuration set when given one, and a caller-supplied MaxPrice when given one', async () => {
    pinpointMock.on(SendTextMessageCommand).resolves({ MessageId: 'msg-2' });
    const provider = createAwsEndUserMessagingSmsProvider({
      originationIdentity: 'phone-id-123',
      configurationSetName: 'ndn-sms',
      maxPricePerMessageUsd: '0.05',
      client: pinpointMock as unknown as PinpointSMSVoiceV2Client,
    });

    await provider.send({ to: '+447911123456', body: 'Reminder' });

    expect(pinpointMock.commandCalls(SendTextMessageCommand)[0]?.args[0].input).toMatchObject({
      ConfigurationSetName: 'ndn-sms',
      MaxPrice: '0.05',
    });
  });

  it('propagates a provider error rather than swallowing it — the caller (sms.ts) decides how to degrade', async () => {
    pinpointMock.on(SendTextMessageCommand).rejects(new Error('ThrottlingException'));
    const provider = createAwsEndUserMessagingSmsProvider({
      originationIdentity: 'phone-id-123',
      client: pinpointMock as unknown as PinpointSMSVoiceV2Client,
    });

    await expect(provider.send({ to: '+447911123456', body: 'Reminder' })).rejects.toThrow(
      'ThrottlingException',
    );
  });
});
