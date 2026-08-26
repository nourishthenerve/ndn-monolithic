// TASK 1.5.2: the HTTP boundary for POST /stripe/webhook
// (infra/src/web-stack.ts) — same split as stripe-checkout.ts/-handler.ts:
// stripe-webhook.ts carries the gate-in-order logic (signature verify ->
// idempotency -> confirm/cancel -> email) and is fully unit-testable with
// injected deps; this file is the once-per-cold-start AWS/Stripe wiring
// (SSM secrets, real `stripe` client, real DynamoDB-backed stores) plus the
// one piece that can only live at the HTTP boundary: extracting the
// *literal* raw request body (signature verification fails against a
// re-serialised JSON string, even one that round-trips byte-for-byte
// equal) and the `stripe-signature` header from the Lambda event.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { requestOriginOf } from './audit.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoDeliveryLog } from './dynamo-notification-log.js';
import { DynamoSpendCounterStore } from './dynamo-sms-spend-cap.js';
import {
  DynamoRegistrationStore,
  DynamoWebhookEventStore,
  DynamoWorkshopCapacityStore,
  DynamoWorkshopStore,
} from './dynamo-store.js';
import { createNotifier, type Notifier } from './notifications.js';
import { RegistrationRepository } from './registration-repository.js';
import { createSesGenericEmailSender } from './ses.js';
import { GenericSmsFlagReader } from './sms-flags.js';
import { createAwsEndUserMessagingSmsProvider } from './sms-provider.js';
import {
  InMemoryRateLimiter,
  SMS_RATE_LIMIT_PER_PRINCIPAL,
  SMS_RATE_LIMIT_WINDOW_MS,
} from './sms-rate-limiter.js';
import { createSmsSender } from './sms.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import {
  createStripeWebhookHandler,
  type StripeEvent,
  type WebhookEventStore,
} from './stripe-webhook.js';
import { WorkshopRepository } from './workshop-repository.js';

function extractRawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) {
    return '';
  }
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
}

function extractSignatureHeader(event: APIGatewayProxyEventV2): string {
  return event.headers?.['stripe-signature'] ?? event.headers?.['Stripe-Signature'] ?? '';
}

export interface StripeWebhookHttpDeps {
  /** Verifies + parses the raw body against the real `stripe-signature` header — the one Stripe SDK call this handler ever needs, injected so no test calls the real Stripe API. Async: the real implementation resolves an SSM secret and a real `stripe` client first. */
  readonly verifySignature: (rawBody: string, signatureHeader: string) => Promise<StripeEvent>;
  readonly eventStore: WebhookEventStore;
  readonly workshops: WorkshopRepository;
  readonly registrations: RegistrationRepository;
  readonly notifier: Notifier;
}

export function createStripeWebhookHttpHandler(
  deps: StripeWebhookHttpDeps,
): APIGatewayProxyHandlerV2 {
  const webhook = createStripeWebhookHandler({
    verifySignature: deps.verifySignature,
    eventStore: deps.eventStore,
    workshops: deps.workshops,
    registrations: deps.registrations,
    notifier: deps.notifier,
  });

  return async (event) => {
    const rawBody = extractRawBody(event);
    const signatureHeader = extractSignatureHeader(event);

    // TASK 2.1.3: the request id and source address behind this delivery,
    // for the audit rows confirm/cancel write. Stripe's own delivery IP is
    // the "where" here, hashed like every other (audit.ts's hashSourceIp).
    const result = await webhook(rawBody, signatureHeader, requestOriginOf(event));
    return {
      statusCode: result.statusCode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ received: result.statusCode === 200 }),
    };
  };
}

// --- AWS/Stripe wiring below: the only part of this file real Lambda
// traffic exercises that isn't covered by stripe-webhook-handler.test.ts's
// injected deps. ---

// Mirrors infra/src/config.ts's STRIPE_WEBHOOK_SECRET_PARAMETER_NAME — see
// content-authoring-handler.ts's own comment for why this is only a
// local-dev/test fallback.
const STRIPE_WEBHOOK_SECRET_PARAMETER_NAME =
  process.env.STRIPE_WEBHOOK_SECRET_PARAMETER_NAME ?? '/ndn/stripe-webhook-secret';
const STRIPE_SECRET_KEY_PARAMETER_NAME =
  process.env.STRIPE_SECRET_KEY_PARAMETER_NAME ?? '/ndn/stripe-secret-key';

const ssmClient = new SSMClient({});

function getSsmParameter(name: string): Promise<string> {
  return ssmClient
    .send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${name} has no value`);
      }
      return value;
    });
}

// Same cold-start caching convention as contact-form-handler.ts's
// cachedSecretPromise — a failed read is never cached, so a transient SSM
// blip doesn't wedge a warm container.
let cachedWebhookSecretPromise: Promise<string> | undefined;

function getWebhookSecret(): Promise<string> {
  cachedWebhookSecretPromise ??= getSsmParameter(STRIPE_WEBHOOK_SECRET_PARAMETER_NAME).catch(
    (error: unknown) => {
      cachedWebhookSecretPromise = undefined;
      throw error;
    },
  );
  return cachedWebhookSecretPromise;
}

let cachedStripeClientPromise: Promise<Stripe> | undefined;

function getStripeClient(): Promise<Stripe> {
  cachedStripeClientPromise ??= getSsmParameter(STRIPE_SECRET_KEY_PARAMETER_NAME)
    .then((key) => new Stripe(key))
    .catch((error: unknown) => {
      cachedStripeClientPromise = undefined;
      throw error;
    });
  return cachedStripeClientPromise;
}

// Both secrets/client resolutions are independently cached across warm
// invocations (same convention every other *-handler.ts in this repo
// follows); a rejection here (e.g. a transient SSM blip) propagates as the
// pure handler's own generic "couldn't verify" -> 400 path — this repo's
// existing handlers don't hand-distinguish an infra failure from a genuine
// rejection either (e.g. registration-handler.ts's Turnstile-secret
// resolution failure crashes the same way an actually-failed siteverify
// call doesn't).
async function verifySignature(rawBody: string, signatureHeader: string): Promise<StripeEvent> {
  const [webhookSecret, stripe] = await Promise.all([getWebhookSecret(), getStripeClient()]);
  return stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    webhookSecret,
  ) as unknown as StripeEvent;
}

// Mirrors infra/src/config.ts's SES_CONFIGURATION_SET_NAME — web-stack.ts
// sets this env var at deploy time; the literal is a local-dev/test
// fallback, same convention this repo uses for every other mirrored name.
const SES_CONFIGURATION_SET_NAME = process.env.SES_CONFIGURATION_SET_NAME ?? 'ndn-email';

const tableName = process.env.WORKSHOP_TABLE_NAME ?? '';
const workshopStore = new DynamoWorkshopStore({ tableName });
const registrationStore = new DynamoRegistrationStore({ tableName });
const capacityStore = new DynamoWorkshopCapacityStore({ tableName });
const eventStore = new DynamoWebhookEventStore({ tableName });

// TASK 2.1.3: the durable audit sink. `AUDIT_TABLE_NAME` is the same table
// every store above writes to (infra/src/data-stack.ts sets all of them to
// NdnDataStack's table name) — named separately because the audit
// partition is the one this function's IAM grant is reasoned about
// independently of.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const workshops = new WorkshopRepository(workshopStore, auditLog, systemClock);
const registrations = new RegistrationRepository(
  registrationStore,
  capacityStore,
  auditLog,
  systemClock,
);

// TASK workshop-confirmation-sms: same composition reminder-sweep-handler.ts
// already established for a real, deployed Notifier — SMS tried first via
// sms.ts's full guard chain, degrading to email (createSesGenericEmailSender,
// the same verified identity the old direct-SES send used) on any failure.
// The spend cap and rate limiter here are shared with appointment
// reminders' own instances (same table, same SMS_MONTHLY_CAP_PENCE) —
// docs/plan/02-risk-register.md's R-01 row accounts for the combined volume.
const flags = createSsmFlagReader();

const notifier = createNotifier({
  sendEmail: createSesGenericEmailSender({
    fromAddress: process.env.CONTACT_FORM_FROM_EMAIL ?? 'noreply@nourishthenerve.com',
    configurationSetName: SES_CONFIGURATION_SET_NAME,
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
      // Empty until LL-02 provisions a real UK long code — the provider
      // call then fails and every send degrades to email, same property
      // reminder-sweep-handler.ts's own identical wiring documents.
      originationIdentity: process.env.SMS_ORIGINATION_IDENTITY ?? '',
      configurationSetName: SES_CONFIGURATION_SET_NAME,
    }),
    clock: systemClock,
  }),
  log: new DynamoDeliveryLog({ tableName: process.env.NOTIFICATION_TABLE_NAME ?? '' }),
  clock: systemClock,
});

export const handler = createStripeWebhookHttpHandler({
  verifySignature,
  eventStore,
  workshops,
  registrations,
  notifier,
});
