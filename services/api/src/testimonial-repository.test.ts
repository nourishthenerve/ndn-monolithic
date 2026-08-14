import type { Testimonial } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import {
  InMemoryTestimonialStore,
  TestimonialRepository,
  type SubmitTestimonialInput,
} from './testimonial-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

function buildInput(overrides: Partial<SubmitTestimonialInput> = {}): SubmitTestimonialInput {
  return {
    id: 'testimonial-1',
    quote: { en: 'This service changed my recovery.' },
    attribution: { display: 'firstNameOnly', name: 'Jordan' },
    consent: { textVersion: '2026-08-14', submitterContactHash: 'hash-1' },
    ...overrides,
  };
}

function buildRepository() {
  const store = new InMemoryTestimonialStore();
  const audit = new InMemoryAuditLog();
  const repository = new TestimonialRepository(store, audit, fixedClock);
  return { repository, store, audit };
}

describe('TestimonialRepository.submit', () => {
  it('creates as pending_review, stamps consentedAt, and writes an audit entry', async () => {
    const { repository, audit } = buildRepository();
    const item = await repository.submit('visitor-1', buildInput());

    expect(item.status).toBe('pending_review');
    expect(item.consent.consentedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(item.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(audit.list()).toEqual([
      expect.objectContaining({
        actor: 'visitor-1',
        action: 'create',
        entityType: 'Testimonial',
        entityId: 'testimonial-1',
      }),
    ]);
  });

  it('throws when a testimonial with the same id already exists', async () => {
    const { repository } = buildRepository();
    await repository.submit('visitor-1', buildInput());
    await expect(repository.submit('visitor-1', buildInput())).rejects.toThrow(AppError);
  });

  it('has no method that removes a testimonial', () => {
    const methodNames = Object.getOwnPropertyNames(TestimonialRepository.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
  });
});

describe('TestimonialRepository.publish/reject', () => {
  it('publish transitions status to published and audits the transition, never touching consent', async () => {
    const { repository, audit } = buildRepository();
    const submitted = await repository.submit('visitor-1', buildInput());

    const published = await repository.publish('admin-token', 'testimonial-1');

    expect(published.status).toBe('published');
    expect(published.consent).toEqual(submitted.consent);
    expect(audit.list()).toContainEqual(
      expect.objectContaining({
        actor: 'admin-token',
        action: 'publish',
        entityId: 'testimonial-1',
      }),
    );
  });

  it('reject transitions status to rejected, never removing the row', async () => {
    const { repository, audit } = buildRepository();
    await repository.submit('visitor-1', buildInput());

    const rejected = await repository.reject('admin-token', 'testimonial-1');

    expect(rejected.status).toBe('rejected');
    expect(await repository.findById('testimonial-1')).toMatchObject({ status: 'rejected' });
    expect(await repository.findPublished()).toEqual([]);
    expect(audit.list()).toContainEqual(
      expect.objectContaining({
        actor: 'admin-token',
        action: 'reject',
        entityId: 'testimonial-1',
      }),
    );
  });

  it('throws AppError publishing an id that does not exist', async () => {
    const { repository } = buildRepository();
    await expect(repository.publish('admin-token', 'missing')).rejects.toThrow(AppError);
  });
});

describe('TestimonialRepository.findPublished/findPendingReview', () => {
  it('findPublished excludes pending_review and rejected testimonials', async () => {
    const { repository } = buildRepository();
    await repository.submit('visitor-1', buildInput({ id: 'published-1' }));
    await repository.submit('visitor-1', buildInput({ id: 'pending-1' }));
    await repository.submit('visitor-1', buildInput({ id: 'rejected-1' }));
    await repository.publish('admin-token', 'published-1');
    await repository.reject('admin-token', 'rejected-1');

    const found = await repository.findPublished();
    expect(found.map((item) => item.id)).toEqual(['published-1']);
  });

  it('findPendingReview only returns testimonials awaiting a decision', async () => {
    const { repository } = buildRepository();
    await repository.submit('visitor-1', buildInput({ id: 'published-1' }));
    await repository.submit('visitor-1', buildInput({ id: 'pending-1' }));
    await repository.publish('admin-token', 'published-1');

    const found = await repository.findPendingReview();
    expect(found.map((item) => item.id)).toEqual(['pending-1']);
  });

  it('a published testimonial never resurfaces in findPendingReview once transitioned', async () => {
    const { repository } = buildRepository();
    await repository.submit('visitor-1', buildInput({ id: 'testimonial-1' }));
    await repository.publish('admin-token', 'testimonial-1');

    expect(await repository.findPendingReview()).toEqual([]);
  });
});

describe('InMemoryTestimonialStore.update — consent immutability', () => {
  it('throws when a write attempts to change an existing consent object', async () => {
    const store = new InMemoryTestimonialStore();
    const original: Testimonial = {
      id: 'testimonial-1',
      status: 'pending_review',
      quote: { en: 'Quote' },
      attribution: { display: 'anonymous' },
      consent: {
        textVersion: '2026-08-14',
        consentedAt: '2026-01-01T00:00:00.000Z',
        submitterContactHash: 'hash-1',
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    await store.create(original);

    const tampered: Testimonial = {
      ...original,
      consent: { ...original.consent, submitterContactHash: 'sneaky-overwrite' },
    };
    await expect(store.update(tampered)).rejects.toThrow(AppError);

    const stillOriginal = await store.get('testimonial-1');
    expect(stillOriginal?.consent.submitterContactHash).toBe('hash-1');
  });

  it('allows a status-only write that echoes consent back unchanged', async () => {
    const store = new InMemoryTestimonialStore();
    const original: Testimonial = {
      id: 'testimonial-1',
      status: 'pending_review',
      quote: { en: 'Quote' },
      attribution: { display: 'anonymous' },
      consent: {
        textVersion: '2026-08-14',
        consentedAt: '2026-01-01T00:00:00.000Z',
        submitterContactHash: 'hash-1',
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    await store.create(original);
    await store.update({ ...original, status: 'published' });

    expect((await store.get('testimonial-1'))?.status).toBe('published');
  });
});
