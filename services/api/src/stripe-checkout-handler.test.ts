import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  InMemoryRegistrationStore,
  InMemoryWorkshopCapacityStore,
  RegistrationRepository,
} from './registration-repository.js';
import {
  createStripeCheckoutHttpHandler,
  type StripeCheckoutHttpDeps,
} from './stripe-checkout-handler.js';
import { InMemoryWorkshopStore, WorkshopRepository } from './workshop-repository.js';

// TASK 2.1.3: the admin seeding the fixture workshop, as an `ActorContext`.
const ADMIN_ACTOR = actorContext(
  { subjectId: 'principal-sub', role: 'principal-clinician' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

function fakeEvent(overrides: { workshopId?: string; body?: unknown; sourceIp?: string }) {
  return {
    routeKey: 'POST /workshops/{id}/checkout',
    pathParameters: overrides.workshopId ? { id: overrides.workshopId } : undefined,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: overrides.sourceIp ?? '203.0.113.1' },
    },
  } as never;
}

function buildDeps(overrides: Partial<StripeCheckoutHttpDeps> = {}) {
  const source = new InMemoryFlagSource();
  source.set('payments.stripeCheckout.enabled', true);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
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
  const createCheckoutSession = vi
    .fn()
    .mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' });
  const deps: StripeCheckoutHttpDeps = {
    flags,
    workshops,
    registrations,
    createCheckoutSession,
    clock: fixedClock,
    generateId: () => 'registration-1',
    ...overrides,
  };
  return { deps, workshops, registrations, createCheckoutSession };
}

async function seedPublishedWorkshop(workshops: WorkshopRepository) {
  await workshops.create(ADMIN_ACTOR, {
    id: 'workshop-1',
    status: 'published',
    dateTimeUtc: '2026-07-01T10:00:00.000Z',
    capacity: 10,
    priceMinorUnits: 2500,
    details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
  });
}

describe('createStripeCheckoutHttpHandler — flag gating', () => {
  it('returns 404 when payments.stripeCheckout.enabled is off', async () => {
    const source = new InMemoryFlagSource();
    source.set('payments.stripeCheckout.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { deps, createCheckoutSession } = buildDeps({ flags });
    const handler = createStripeCheckoutHttpHandler(deps);

    const result = await handler(
      fakeEvent({ workshopId: 'workshop-1', body: { attendeeEmail: 'a@example.com' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('createStripeCheckoutHttpHandler — validation', () => {
  it('returns 400 when the id path parameter is missing', async () => {
    const { deps } = buildDeps();
    const handler = createStripeCheckoutHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { attendeeEmail: 'a@example.com' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 400 for an invalid email', async () => {
    const { deps } = buildDeps();
    const handler = createStripeCheckoutHttpHandler(deps);

    const result = await handler(
      fakeEvent({ workshopId: 'workshop-1', body: { attendeeEmail: 'not-an-email' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createStripeCheckoutHttpHandler — happy path', () => {
  it('returns 201 with a checkoutUrl for a valid request', async () => {
    const { deps, workshops } = buildDeps();
    await seedPublishedWorkshop(workshops);
    const handler = createStripeCheckoutHttpHandler(deps);

    const result = (await handler(
      fakeEvent({ workshopId: 'workshop-1', body: { attendeeEmail: 'a@example.com' } }),
      {} as never,
      undefined as never,
    )) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body)).toEqual({
      checkoutUrl: 'https://checkout.stripe.com/cs_test_1',
    });
  });
});

describe('createStripeCheckoutHttpHandler — availability/capacity', () => {
  it('returns 404 for a workshop that does not exist', async () => {
    const { deps } = buildDeps();
    const handler = createStripeCheckoutHttpHandler(deps);

    const result = await handler(
      fakeEvent({ workshopId: 'missing', body: { attendeeEmail: 'a@example.com' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 409 once the workshop is at capacity', async () => {
    const { deps, workshops, registrations } = buildDeps();
    await seedPublishedWorkshop(workshops);
    // Workshop was seeded with capacity 10 — fill every slot first.
    for (let i = 0; i < 10; i += 1) {
      await registrations.reserveCapacity('workshop-1', 10);
    }
    const handler = createStripeCheckoutHttpHandler(deps);

    const result = await handler(
      fakeEvent({ workshopId: 'workshop-1', body: { attendeeEmail: 'a@example.com' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 409 });
  });
});
