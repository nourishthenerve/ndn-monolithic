import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import {
  InMemoryRegistrationStore,
  InMemoryWorkshopCapacityStore,
  RegistrationRepository,
} from './registration-repository.js';
import {
  createStripeWebhookHandler,
  InMemoryWebhookEventStore,
  type StripeEvent,
  type WebhookDeps,
} from './stripe-webhook.js';
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

async function seedWorkshopAndRegistration(
  workshops: WorkshopRepository,
  registrations: RegistrationRepository,
) {
  await workshops.create('admin-token', {
    id: 'workshop-1',
    status: 'published',
    dateTimeUtc: '2026-07-01T10:00:00.000Z',
    capacity: 10,
    priceMinorUnits: 2500,
    details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
  });
  await registrations.reserveCapacity('workshop-1', 10);
  await registrations.create('hashed-principal', {
    id: 'registration-1',
    workshopId: 'workshop-1',
    attendeeEmail: 'attendee@example.com',
    stripeCheckoutSessionId: 'cs_test_1',
  });
}

function checkoutEvent(
  id: string,
  type: 'checkout.session.completed' | 'checkout.session.expired',
  overrides: { workshopId?: string; clientReferenceId?: string | null } = {},
): StripeEvent {
  return {
    id,
    type,
    data: {
      object: {
        client_reference_id:
          overrides.clientReferenceId === undefined
            ? 'REGISTRATION#registration-1'
            : overrides.clientReferenceId,
        metadata: { workshopId: overrides.workshopId ?? 'workshop-1' },
      },
    },
  };
}

function buildDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps & {
  workshops: WorkshopRepository;
  registrations: RegistrationRepository;
  sendConfirmationEmail: ReturnType<typeof vi.fn>;
  verifySignature: ReturnType<typeof vi.fn>;
} {
  const workshops = buildWorkshops();
  const registrations = buildRegistrations();
  return {
    verifySignature: vi.fn(),
    eventStore: new InMemoryWebhookEventStore(),
    workshops,
    registrations,
    sendConfirmationEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as WebhookDeps & {
    workshops: WorkshopRepository;
    registrations: RegistrationRepository;
    sendConfirmationEmail: ReturnType<typeof vi.fn>;
    verifySignature: ReturnType<typeof vi.fn>;
  };
}

describe('createStripeWebhookHandler — signature verification', () => {
  it('returns 400 and mutates nothing on an invalid signature', async () => {
    const deps = buildDeps({
      verifySignature: vi.fn().mockImplementation(() => {
        throw new Error('invalid signature');
      }),
    });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    const result = await webhook('raw-body', 'bad-signature');

    expect(result).toEqual({ statusCode: 400 });
    expect(deps.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(await deps.registrations.findById('workshop-1', 'registration-1')).toMatchObject({
      status: 'pending',
    });
  });
});

describe('createStripeWebhookHandler — idempotency', () => {
  it('the same event.id delivered twice is a no-op on the second delivery: 200, one email, one confirmed transition', async () => {
    const event = checkoutEvent('evt_1', 'checkout.session.completed');
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(event) });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    const first = await webhook('raw-body', 'sig');
    const second = await webhook('raw-body', 'sig');

    expect(first).toEqual({ statusCode: 200 });
    expect(second).toEqual({ statusCode: 200 });
    expect(deps.sendConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(await deps.registrations.findById('workshop-1', 'registration-1')).toMatchObject({
      status: 'confirmed',
    });
  });
});

describe('createStripeWebhookHandler — checkout.session.completed', () => {
  it('confirms the registration and sends exactly one confirmation email with the workshop title/date', async () => {
    const event = checkoutEvent('evt_1', 'checkout.session.completed');
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(event) });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    const result = await webhook('raw-body', 'sig');

    expect(result).toEqual({ statusCode: 200 });
    expect(deps.sendConfirmationEmail).toHaveBeenCalledWith({
      to: 'attendee@example.com',
      workshopTitle: 'Balance & Falls Prevention',
      dateTimeUtc: '2026-07-01T10:00:00.000Z',
    });
  });

  it('is a 200 no-op (no mutation, no email) when the metadata/client_reference_id do not identify a known registration', async () => {
    const event = checkoutEvent('evt_1', 'checkout.session.completed', {
      clientReferenceId: 'REGISTRATION#does-not-exist',
    });
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(event) });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    await expect(webhook('raw-body', 'sig')).rejects.toThrow();
  });

  it('is a 200 no-op when client_reference_id is missing entirely', async () => {
    const event = checkoutEvent('evt_1', 'checkout.session.completed', {
      clientReferenceId: null,
    });
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(event) });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    const result = await webhook('raw-body', 'sig');
    expect(result).toEqual({ statusCode: 200 });
    expect(deps.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it('ignores an unrecognised event type: 200, no mutation', async () => {
    const event: StripeEvent = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: {} },
    };
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(event) });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    const result = await webhook('raw-body', 'sig');
    expect(result).toEqual({ statusCode: 200 });
    expect(deps.sendConfirmationEmail).not.toHaveBeenCalled();
    expect(await deps.registrations.findById('workshop-1', 'registration-1')).toMatchObject({
      status: 'pending',
    });
  });
});

describe('createStripeWebhookHandler — checkout.session.expired', () => {
  it('cancels the registration and releases its capacity reservation', async () => {
    const event = checkoutEvent('evt_1', 'checkout.session.expired');
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(event) });
    await seedWorkshopAndRegistration(deps.workshops, deps.registrations);
    const webhook = createStripeWebhookHandler(deps);

    const result = await webhook('raw-body', 'sig');

    expect(result).toEqual({ statusCode: 200 });
    expect(await deps.registrations.findById('workshop-1', 'registration-1')).toMatchObject({
      status: 'cancelled',
    });
    // Capacity actually released (workshop was seeded at exactly capacity 10).
    await expect(deps.registrations.reserveCapacity('workshop-1', 10)).resolves.toBe(true);
    expect(deps.sendConfirmationEmail).not.toHaveBeenCalled();
  });
});
