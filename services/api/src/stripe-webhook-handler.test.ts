import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import type { Notifier } from './notifications.js';
import {
  InMemoryRegistrationStore,
  InMemoryWorkshopCapacityStore,
  RegistrationRepository,
} from './registration-repository.js';
import {
  createStripeWebhookHttpHandler,
  type StripeWebhookHttpDeps,
} from './stripe-webhook-handler.js';
import { InMemoryWebhookEventStore, type StripeEvent } from './stripe-webhook.js';
import { InMemoryWorkshopStore, WorkshopRepository } from './workshop-repository.js';

// TASK 2.1.3: the admin seeding the fixture workshop, as an `ActorContext`.
const ADMIN_ACTOR = actorContext(
  { subjectId: 'principal-sub', role: 'principal-clinician' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

// TASK 2.1.3: the visitor buying the place. `'public'` — no identity
// beyond the hash of where the request came from.
const BUYER_ACTOR = actorContext(
  { subjectId: 'hashed-principal', role: 'public' },
  { requestId: 'req-checkout-1', sourceIp: '198.51.100.7' },
);

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

function fakeEvent(overrides: {
  body?: string;
  isBase64Encoded?: boolean;
  signatureHeader?: string;
}) {
  return {
    routeKey: 'POST /stripe/webhook',
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    headers:
      overrides.signatureHeader === undefined
        ? {}
        : { 'stripe-signature': overrides.signatureHeader },
    // TASK 2.1.3: `http.sourceIp` is part of every real API Gateway v2
    // event and is what the audit row's `where` is derived from
    // (audit.ts's requestOriginOf) — the fixture carries it because
    // the real event always does.
    requestContext: { requestId: 'req-1', http: { sourceIp: '198.51.100.7' } },
  } as never;
}

function buildDeps(overrides: Partial<StripeWebhookHttpDeps> = {}) {
  const workshops = new WorkshopRepository(
    new InMemoryWorkshopStore(),
    new InMemoryAuditLog(),
    fixedClock,
  );
  const registrations = new RegistrationRepository(
    new InMemoryRegistrationStore(),
    new InMemoryWorkshopCapacityStore(),
    new InMemoryAuditLog(),
    fixedClock,
  );
  const verifySignature = vi.fn();
  const notifier: Notifier = { send: vi.fn().mockResolvedValue(undefined) };
  const deps: StripeWebhookHttpDeps = {
    verifySignature,
    eventStore: new InMemoryWebhookEventStore(),
    workshops,
    registrations,
    notifier,
    ...overrides,
  };
  return { deps, verifySignature, notifier, workshops, registrations };
}

describe('createStripeWebhookHttpHandler — signature verification wiring', () => {
  it('passes the raw UTF-8 body and the stripe-signature header to verifySignature', async () => {
    const { deps, verifySignature } = buildDeps();
    verifySignature.mockRejectedValue(new Error('invalid'));
    const handler = createStripeWebhookHttpHandler(deps);

    await handler(
      fakeEvent({ body: '{"id":"evt_1"}', signatureHeader: 't=1,v1=abc' }),
      {} as never,
      undefined as never,
    );

    expect(verifySignature).toHaveBeenCalledWith('{"id":"evt_1"}', 't=1,v1=abc');
  });

  it('decodes a base64-encoded body before passing it to verifySignature', async () => {
    const { deps, verifySignature } = buildDeps();
    verifySignature.mockRejectedValue(new Error('invalid'));
    const handler = createStripeWebhookHttpHandler(deps);
    const raw = '{"id":"evt_1"}';

    await handler(
      fakeEvent({
        body: Buffer.from(raw, 'utf-8').toString('base64'),
        isBase64Encoded: true,
        signatureHeader: 't=1,v1=abc',
      }),
      {} as never,
      undefined as never,
    );

    expect(verifySignature).toHaveBeenCalledWith(raw, 't=1,v1=abc');
  });

  it('returns 400 when verifySignature rejects (invalid signature)', async () => {
    const { deps } = buildDeps({
      verifySignature: vi.fn().mockRejectedValue(new Error('invalid signature')),
    });
    const handler = createStripeWebhookHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: '{}', signatureHeader: 'bad' }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createStripeWebhookHttpHandler — happy path', () => {
  it('returns 200 and confirms the registration for a valid checkout.session.completed event', async () => {
    const { deps, workshops, registrations, notifier } = buildDeps();
    await workshops.create(ADMIN_ACTOR, {
      id: 'workshop-1',
      status: 'published',
      dateTimeUtc: '2026-07-01T10:00:00.000Z',
      capacity: 10,
      priceMinorUnits: 2500,
      details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
    });
    await registrations.reserveCapacity('workshop-1', 10);
    await registrations.create(BUYER_ACTOR, {
      id: 'registration-1',
      workshopId: 'workshop-1',
      attendeeEmail: 'attendee@example.com',
      stripeCheckoutSessionId: 'cs_test_1',
    });
    const event: StripeEvent = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'REGISTRATION#registration-1',
          metadata: { workshopId: 'workshop-1' },
        },
      },
    };
    const handler = createStripeWebhookHttpHandler({
      ...deps,
      verifySignature: vi.fn().mockResolvedValue(event),
    });

    const result = await handler(
      fakeEvent({ body: '{}', signatureHeader: 'sig' }),
      {} as never,
      undefined as never,
    );

    expect(result).toMatchObject({ statusCode: 200 });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(await registrations.findById('workshop-1', 'registration-1')).toMatchObject({
      status: 'confirmed',
    });
  });
});
