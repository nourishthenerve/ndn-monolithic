import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import {
  InMemoryRegistrationStore,
  InMemoryWorkshopCapacityStore,
  RegistrationRepository,
} from './registration-repository.js';
import {
  createWorkshopCheckoutHandler,
  type WorkshopCheckoutDeps,
  type WorkshopCheckoutRequest,
} from './stripe-checkout.js';
import { InMemoryWorkshopStore, WorkshopRepository } from './workshop-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

function buildWorkshops() {
  return new WorkshopRepository(new InMemoryWorkshopStore(), new InMemoryAuditLog(), fixedClock);
}

function buildRegistrations() {
  return new RegistrationRepository(
    new InMemoryRegistrationStore(),
    new InMemoryWorkshopCapacityStore(),
    new InMemoryAuditLog(),
    fixedClock,
  );
}

async function seedWorkshop(
  workshops: WorkshopRepository,
  overrides: {
    id?: string;
    status?: 'draft' | 'published' | 'cancelled';
    capacity?: number;
    dateTimeUtc?: string;
  } = {},
) {
  await workshops.create('admin-token', {
    id: overrides.id ?? 'workshop-1',
    status: overrides.status ?? 'published',
    dateTimeUtc: overrides.dateTimeUtc ?? '2026-07-01T10:00:00.000Z',
    capacity: overrides.capacity ?? 10,
    priceMinorUnits: 2500,
    details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
  });
}

const baseRequest: WorkshopCheckoutRequest = {
  workshopId: 'workshop-1',
  registrationId: 'registration-1',
  attendeeEmail: 'attendee@example.com',
  principal: 'hashed-principal-1',
};

function buildDeps(overrides: Partial<WorkshopCheckoutDeps> = {}): WorkshopCheckoutDeps & {
  workshops: WorkshopRepository;
  registrations: RegistrationRepository;
  createCheckoutSession: ReturnType<typeof vi.fn>;
} {
  return {
    workshops: buildWorkshops(),
    registrations: buildRegistrations(),
    createCheckoutSession: vi
      .fn()
      .mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/cs_test_1' }),
    clock: fixedClock,
    ...overrides,
  } as WorkshopCheckoutDeps & {
    workshops: WorkshopRepository;
    registrations: RegistrationRepository;
    createCheckoutSession: ReturnType<typeof vi.fn>;
  };
}

describe('createWorkshopCheckoutHandler — happy path', () => {
  it('reserves capacity, creates a Checkout Session, and a pending registration row', async () => {
    const deps = buildDeps();
    await seedWorkshop(deps.workshops);
    const checkout = createWorkshopCheckoutHandler(deps);

    const result = await checkout(baseRequest);

    expect(result).toEqual({
      kind: 'created',
      checkoutUrl: 'https://checkout.stripe.com/cs_test_1',
    });
    expect(deps.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: 'workshop-1',
        workshopTitle: 'Balance & Falls Prevention',
        priceMinorUnits: 2500,
        clientReferenceId: 'REGISTRATION#registration-1',
      }),
    );
    const registration = await deps.registrations.findById('workshop-1', 'registration-1');
    expect(registration).toMatchObject({
      status: 'pending',
      attendeeEmail: 'attendee@example.com',
      stripeCheckoutSessionId: 'cs_test_1',
    });
  });
});

describe('createWorkshopCheckoutHandler — availability', () => {
  it('is unavailable for a workshop that does not exist, and never calls Stripe', async () => {
    const deps = buildDeps();
    const checkout = createWorkshopCheckoutHandler(deps);

    await expect(checkout(baseRequest)).resolves.toEqual({ kind: 'unavailable' });
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('is unavailable for a draft workshop', async () => {
    const deps = buildDeps();
    await seedWorkshop(deps.workshops, { status: 'draft' });
    const checkout = createWorkshopCheckoutHandler(deps);

    await expect(checkout(baseRequest)).resolves.toEqual({ kind: 'unavailable' });
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('is unavailable for a cancelled workshop', async () => {
    const deps = buildDeps();
    await seedWorkshop(deps.workshops, { status: 'published' });
    await deps.workshops.cancel('admin-token', 'workshop-1');
    const checkout = createWorkshopCheckoutHandler(deps);

    await expect(checkout(baseRequest)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable for a workshop whose dateTimeUtc has already passed', async () => {
    const deps = buildDeps();
    await seedWorkshop(deps.workshops, { dateTimeUtc: '2026-01-01T00:00:00.000Z' });
    const checkout = createWorkshopCheckoutHandler(deps);

    await expect(checkout(baseRequest)).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('createWorkshopCheckoutHandler — capacity', () => {
  it('is full once capacity is exhausted, and never calls Stripe for the rejected attempt', async () => {
    const deps = buildDeps();
    await seedWorkshop(deps.workshops, { capacity: 1 });
    const checkout = createWorkshopCheckoutHandler(deps);

    await expect(checkout(baseRequest)).resolves.toMatchObject({ kind: 'created' });
    deps.createCheckoutSession.mockClear();

    await expect(
      checkout({ ...baseRequest, registrationId: 'registration-2' }),
    ).resolves.toEqual({ kind: 'full' });
    expect(deps.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('is atomic under concurrent contention: 50 concurrent checkouts against a capacity of 10 create exactly 10 registrations', async () => {
    const deps = buildDeps();
    await seedWorkshop(deps.workshops, { capacity: 10 });
    const checkout = createWorkshopCheckoutHandler(deps);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        checkout({ ...baseRequest, registrationId: `registration-${i}` }),
      ),
    );

    const created = results.filter((result) => result.kind === 'created');
    const full = results.filter((result) => result.kind === 'full');
    expect(created).toHaveLength(10);
    expect(full).toHaveLength(40);
    expect(deps.createCheckoutSession).toHaveBeenCalledTimes(10);
  });

  it('releases the capacity reservation if the Stripe API call fails, so a following attempt can still succeed', async () => {
    const deps = buildDeps({
      createCheckoutSession: vi.fn().mockRejectedValue(new Error('stripe unavailable')),
    });
    await seedWorkshop(deps.workshops, { capacity: 1 });
    const checkout = createWorkshopCheckoutHandler(deps);

    await expect(checkout(baseRequest)).rejects.toThrow('stripe unavailable');
    expect(await deps.registrations.findById('workshop-1', 'registration-1')).toBeUndefined();

    const deps2 = buildDeps({ workshops: deps.workshops, registrations: deps.registrations });
    const checkout2 = createWorkshopCheckoutHandler(deps2);
    await expect(checkout2(baseRequest)).resolves.toMatchObject({ kind: 'created' });
  });
});
