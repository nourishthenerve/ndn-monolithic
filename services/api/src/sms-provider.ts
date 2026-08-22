// TASK 2.3.2 (ADR-0008): the SMS provider port — `sms.ts`'s `createSmsSender`
// calls `SmsProvider.send` exactly once, at the end of the guard chain
// 0.5.3 built, after every guard (flags, the +44 allow-list, the
// per-principal rate limit, the £5 monthly cap) has already passed. One
// method, so ADR-0008's "reversal cost: low — behind the notification
// abstraction" stays true: a provider swap touches this file alone.
//
// AWS End User Messaging SMS is the provider ADR-0008 chose, on re-verified
// UK pricing ($0.035/message vs Twilio's $0.056 — see the ADR for both
// figures, dates and method). `DestinationPhoneNumber` is E.164
// (docs.aws.amazon.com/pinpoint/latest/apireference_smsvoicev2/
// API_SendTextMessage.html, re-verified 2026-08-22) — the exact format
// `normalizeUkE164` (sms-allow-list.ts) already produces, so there is no
// second translation between our normaliser's output and the wire format.
import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';

export interface SmsProviderSendParams {
  /** E.164 — `normalizeUkE164`'s own output format, unchanged at the wire. */
  readonly to: string;
  readonly body: string;
}

export interface SmsProvider {
  send(params: SmsProviderSendParams): Promise<void>;
}

/**
 * $0.10 covers both re-verified per-message rates ($0.035 AWS, $0.056
 * Twilio) with headroom, so a provider-side price surprise on a single
 * message is refused rather than sent — a backstop independent of, and in
 * addition to, the account-level monthly spend limit (docs/runbooks/
 * sms-hard-cap.md's "provider-level cap" — D-11's "a bug in ours should
 * still hit theirs").
 */
export const DEFAULT_MAX_PRICE_USD = '0.10';

export interface AwsEndUserMessagingSmsProviderOptions {
  /**
   * The leased origination identity (a long code's PhoneNumberId/ARN, or a
   * pool) — see docs/runbooks/sms-hard-cap.md for how it's provisioned.
   * Not a secret; recorded as a `config.ts` constant once it exists, the
   * same convention every other non-secret identifier in this codebase
   * follows.
   */
  readonly originationIdentity: string;
  /** Attributes delivery events, same discipline as SES's configuration set (ses.ts). */
  readonly configurationSetName?: string;
  readonly maxPricePerMessageUsd?: string;
  /** Defaults to a real client — tests inject a mocked one (aws-sdk-client-mock) instead. */
  readonly client?: PinpointSMSVoiceV2Client;
}

export function createAwsEndUserMessagingSmsProvider(
  options: AwsEndUserMessagingSmsProviderOptions,
): SmsProvider {
  const client = options.client ?? new PinpointSMSVoiceV2Client({});

  return {
    async send(params) {
      await client.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: params.to,
          OriginationIdentity: options.originationIdentity,
          MessageBody: params.body,
          // Every template this platform sends over SMS is the 1-hour
          // appointment reminder (D-10) — never a marketing message, so
          // this is not a per-call choice.
          MessageType: 'TRANSACTIONAL',
          ConfigurationSetName: options.configurationSetName,
          MaxPrice: options.maxPricePerMessageUsd ?? DEFAULT_MAX_PRICE_USD,
        }),
      );
    },
  };
}
