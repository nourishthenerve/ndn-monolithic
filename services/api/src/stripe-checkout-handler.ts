// TASK 1.5.2: the HTTP boundary for POST /workshops/{id}/checkout
// (infra/src/data-stack.ts) — same split as testimonial-submission.ts/
// -handler.ts: stripe-checkout.ts carries the gate-in-order logic
// (availability -> capacity -> Stripe -> registration) and is fully
// unit-testable with injected deps; everything below this file's own HTTP
// handler export is the once-per-cold-start AWS/Stripe wiring (SSM secret,
// real `stripe` client) that only this file touches.
import { createHash, randomUUID } from 'node:crypto';

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { z } from 'zod';

import { InMemoryAuditLog } from './audit.js';
import { systemClock, type Clock } from './clock.js';
import {
  DynamoRegistrationStore,
  DynamoWorkshopCapacityStore,
  DynamoWorkshopStore,
} from './dynamo-store.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { RegistrationRepository } from './registration-repository.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import {
  createWorkshopCheckoutHandler,
  type CreateCheckoutSession,
  type WorkshopCheckoutResult,
} from './stripe-checkout.js';
import { WorkshopRepository } from './workshop-repository.js';

// Mirrors infra/src/config.ts's STRIPE_SECRET_KEY_PARAMETER_NAME — see
// content-authoring-handler.ts's own comment for why this is only a
// local-dev/test fallback.
const STRIPE_SECRET_KEY_PARAMETER_NAME =
  process.env.STRIPE_SECRET_KEY_PARAMETER_NAME ?? '/ndn/stripe-secret-key';

// TASK 1.6.1 will point this at the apex domain at G1 cutover — same
// documented gap apps/web/src/site-config.ts's siteUrl carries today.
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? 'https://next.nourishthenerve.com';

const checkoutBodySchema = z.object({
  attendeeEmail: z.email().max(320),
});

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// The audit trail's `actor` — SHA-256 of the caller's source IP, same
// convention contact-form-handler.ts/testimonial-submission-handler.ts use.
// Never the raw address itself, never logged.
function hashSourceIp(sourceIp: string): string {
  return createHash('sha256').update(sourceIp).digest('hex');
}

const STRIPE_CHECKOUT_LOG_SAMPLE_RATE = 1;

export interface StripeCheckoutHttpDeps {
  readonly flags: FlagReader;
  readonly workshops: WorkshopRepository;
  readonly registrations: RegistrationRepository;
  readonly createCheckoutSession: CreateCheckoutSession;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Defaults to node:crypto's randomUUID — injectable so tests can assert on a known id. */
  readonly generateId?: () => string;
}

export function createStripeCheckoutHttpHandler(
  deps: StripeCheckoutHttpDeps,
): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: STRIPE_CHECKOUT_LOG_SAMPLE_RATE });
  const generateId = deps.generateId ?? randomUUID;
  const checkout = createWorkshopCheckoutHandler({
    workshops: deps.workshops,
    registrations: deps.registrations,
    createCheckoutSession: deps.createCheckoutSession,
    clock,
  });

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Flag: payments.stripeCheckout.enabled — default off, same "invisible
    // until ready" convention as every other write endpoint in this repo.
    if (!(await deps.flags.isEnabled('payments.stripeCheckout.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const workshopId = event.pathParameters?.id;
    if (!workshopId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }

    const parsed = checkoutBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
    }

    const principal = hashSourceIp(event.requestContext.http.sourceIp);
    const result: WorkshopCheckoutResult = await checkout({
      workshopId,
      registrationId: generateId(),
      attendeeEmail: parsed.data.attendeeEmail,
      principal,
    });

    switch (result.kind) {
      case 'created':
        return respond(201, { checkoutUrl: result.checkoutUrl });
      case 'unavailable':
        return respond(404, { error: 'NOT_FOUND' });
      case 'full':
        return respond(409, { error: 'WORKSHOP_FULL' });
    }
  };
}

// --- AWS/Stripe wiring below: the only part of this file real Lambda
// traffic exercises that isn't covered by stripe-checkout-handler.test.ts's
// injected deps. ---

const ssmClient = new SSMClient({});

// Same cold-start caching convention as contact-form-handler.ts's
// cachedSecretPromise — a failed read is never cached, so a transient SSM
// blip doesn't wedge a warm container.
let cachedStripeClientPromise: Promise<Stripe> | undefined;

function getStripeClient(): Promise<Stripe> {
  cachedStripeClientPromise ??= ssmClient
    .send(new GetParameterCommand({ Name: STRIPE_SECRET_KEY_PARAMETER_NAME, WithDecryption: true }))
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${STRIPE_SECRET_KEY_PARAMETER_NAME} has no value`);
      }
      return new Stripe(value);
    })
    .catch((error: unknown) => {
      cachedStripeClientPromise = undefined;
      throw error;
    });
  return cachedStripeClientPromise;
}

const createCheckoutSession: CreateCheckoutSession = async (input) => {
  const stripe = await getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'gbp',
          unit_amount: input.priceMinorUnits,
          product_data: { name: input.workshopTitle },
        },
        quantity: 1,
      },
    ],
    client_reference_id: input.clientReferenceId,
    metadata: { workshopId: input.workshopId },
    success_url: `${SITE_ORIGIN}/en/workshops/${input.workshopId}?checkout=success`,
    cancel_url: `${SITE_ORIGIN}/en/workshops/${input.workshopId}?checkout=cancelled`,
  });
  return { id: session.id, url: session.url ?? '' };
};

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

const workshopStore = new DynamoWorkshopStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});
const registrationStore = new DynamoRegistrationStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});
const capacityStore = new DynamoWorkshopCapacityStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});

// This handler's audit writes have nowhere durable to land yet — same
// documented gap every other *-authoring-handler.ts in this repo carries.
const workshops = new WorkshopRepository(workshopStore, new InMemoryAuditLog(), systemClock);
const registrations = new RegistrationRepository(
  registrationStore,
  capacityStore,
  new InMemoryAuditLog(),
  systemClock,
);

export const handler = createStripeCheckoutHttpHandler({
  flags,
  workshops,
  registrations,
  createCheckoutSession,
});
