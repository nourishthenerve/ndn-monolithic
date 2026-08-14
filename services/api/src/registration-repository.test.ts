import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import {
  InMemoryRegistrationStore,
  InMemoryWorkshopCapacityStore,
  RegistrationRepository,
  type CreateRegistrationInput,
} from './registration-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

function buildInput(overrides: Partial<CreateRegistrationInput> = {}): CreateRegistrationInput {
  return {
    id: 'registration-1',
    workshopId: 'workshop-1',
    attendeeEmail: 'attendee@example.com',
    stripeCheckoutSessionId: 'cs_test_1',
    ...overrides,
  };
}

function buildRepository() {
  const store = new InMemoryRegistrationStore();
  const capacity = new InMemoryWorkshopCapacityStore();
  const audit = new InMemoryAuditLog();
  const repository = new RegistrationRepository(store, capacity, audit, fixedClock);
  return { repository, store, capacity, audit };
}

describe('RegistrationRepository.create', () => {
  it('creates as pending, stamps created_at/updated_at, and writes an audit entry', async () => {
    const { repository, audit } = buildRepository();
    const item = await repository.create('principal-hash', buildInput());

    expect(item.status).toBe('pending');
    expect(item.created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(item.updated_at).toBe('2026-06-01T00:00:00.000Z');
    expect(audit.list()).toEqual([
      expect.objectContaining({
        actor: 'principal-hash',
        action: 'create',
        entityType: 'Registration',
        entityId: 'registration-1',
      }),
    ]);
  });

  it('throws when a registration with the same id already exists under the same workshop', async () => {
    const { repository } = buildRepository();
    await repository.create('principal-hash', buildInput());
    await expect(repository.create('principal-hash', buildInput())).rejects.toThrow(AppError);
  });

  it('has no method that removes a registration', () => {
    const methodNames = Object.getOwnPropertyNames(RegistrationRepository.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
  });
});

describe('RegistrationRepository.confirm', () => {
  it('transitions a pending registration to confirmed and audits it', async () => {
    const { repository, audit } = buildRepository();
    await repository.create('principal-hash', buildInput());

    const confirmed = await repository.confirm('stripe-webhook', 'workshop-1', 'registration-1');

    expect(confirmed.status).toBe('confirmed');
    expect(audit.list()).toContainEqual(
      expect.objectContaining({
        actor: 'stripe-webhook',
        action: 'confirm',
        entityId: 'registration-1',
      }),
    );
  });

  it('is a no-op (no second audit entry) when called again on an already-confirmed registration', async () => {
    const { repository, audit } = buildRepository();
    await repository.create('principal-hash', buildInput());
    await repository.confirm('stripe-webhook', 'workshop-1', 'registration-1');
    const auditLengthAfterFirst = audit.list().length;

    const result = await repository.confirm('stripe-webhook', 'workshop-1', 'registration-1');

    expect(result.status).toBe('confirmed');
    expect(audit.list()).toHaveLength(auditLengthAfterFirst);
  });

  it('does not resurrect a cancelled registration', async () => {
    const { repository } = buildRepository();
    await repository.create('principal-hash', buildInput());
    await repository.cancel('stripe-webhook', 'workshop-1', 'registration-1');

    const result = await repository.confirm('stripe-webhook', 'workshop-1', 'registration-1');
    expect(result.status).toBe('cancelled');
  });

  it('throws AppError for an id that does not exist', async () => {
    const { repository } = buildRepository();
    await expect(
      repository.confirm('stripe-webhook', 'workshop-1', 'missing'),
    ).rejects.toThrow(AppError);
  });
});

describe('RegistrationRepository.cancel', () => {
  it('transitions a pending registration to cancelled, releases capacity, and audits it', async () => {
    const { repository, capacity, audit } = buildRepository();
    await capacity.tryReserve('workshop-1', 10);
    await repository.create('principal-hash', buildInput());

    const cancelled = await repository.cancel('stripe-webhook', 'workshop-1', 'registration-1');

    expect(cancelled.status).toBe('cancelled');
    expect(await repository.findById('workshop-1', 'registration-1')).toMatchObject({
      status: 'cancelled',
    });
    expect(audit.list()).toContainEqual(
      expect.objectContaining({
        actor: 'stripe-webhook',
        action: 'cancel',
        entityId: 'registration-1',
      }),
    );
    // Capacity actually released — a fresh reservation up to the same cap succeeds again.
    await expect(capacity.tryReserve('workshop-1', 1)).resolves.toBe(true);
  });

  it('does not release capacity for an already-confirmed registration', async () => {
    const { repository, capacity } = buildRepository();
    await capacity.tryReserve('workshop-1', 1);
    await repository.create('principal-hash', buildInput());
    await repository.confirm('stripe-webhook', 'workshop-1', 'registration-1');

    await repository.cancel('stripe-webhook', 'workshop-1', 'registration-1');

    const result = await repository.findById('workshop-1', 'registration-1');
    expect(result?.status).toBe('confirmed');
    // Capacity was never released for the confirmed registration — a
    // second reservation against the same cap (1) is still rejected.
    await expect(capacity.tryReserve('workshop-1', 1)).resolves.toBe(false);
  });

  it('throws AppError for an id that does not exist', async () => {
    const { repository } = buildRepository();
    await expect(
      repository.cancel('stripe-webhook', 'workshop-1', 'missing'),
    ).rejects.toThrow(AppError);
  });
});

describe('RegistrationRepository.reserveCapacity / releaseCapacity', () => {
  it('reserveCapacity is atomic under concurrent contention: 50 concurrent reservations against a capacity of 10 commit exactly 10', async () => {
    const { repository } = buildRepository();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => repository.reserveCapacity('workshop-1', 10)),
    );
    const committed = results.filter(Boolean).length;
    expect(committed).toBe(10);
    await expect(repository.reserveCapacity('workshop-1', 10)).resolves.toBe(false);
  });

  it('releaseCapacity frees exactly one slot', async () => {
    const { repository } = buildRepository();
    await repository.reserveCapacity('workshop-1', 1);
    await expect(repository.reserveCapacity('workshop-1', 1)).resolves.toBe(false);

    await repository.releaseCapacity('workshop-1');

    await expect(repository.reserveCapacity('workshop-1', 1)).resolves.toBe(true);
  });

  it('keeps independent reservation counts per workshop', async () => {
    const { repository } = buildRepository();
    await repository.reserveCapacity('workshop-1', 1);
    await expect(repository.reserveCapacity('workshop-2', 1)).resolves.toBe(true);
  });
});

describe('InMemoryRegistrationStore', () => {
  it('returns undefined for an id that was never created', async () => {
    const { repository } = buildRepository();
    expect(await repository.findById('workshop-1', 'missing')).toBeUndefined();
  });
});
