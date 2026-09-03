// 2026-09-02: rewritten around a patient author.
//
// The old suite tested a submit/publish/reject lifecycle for anonymous
// submissions. There is no such lifecycle any more — a patient's
// testimonial is published on write and there is nobody to approve it —
// so this asserts the two properties that replaced it: **one record per
// patient, by construction**, and **withdrawal is a status, not a
// deletion**.
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import {
  InMemoryTestimonialStore,
  TestimonialRepository,
  testimonialIdForPatient,
  type SubmitTestimonialInput,
} from './testimonial-repository.js';

const PATIENT = actorContext(
  { subjectId: 'pat-1-sub', role: 'patient' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);
const OTHER_PATIENT = actorContext(
  { subjectId: 'pat-2-sub', role: 'patient' },
  { requestId: 'req-2', sourceIp: '198.51.100.8' },
);

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

function buildInput(overrides: Partial<SubmitTestimonialInput> = {}): SubmitTestimonialInput {
  return {
    authorPatientId: 'pat-1',
    quote: { en: 'This service changed my recovery.' },
    attribution: { display: 'firstNameOnly', name: 'Jordan' },
    consentTextVersion: '2026-09-02',
    ...overrides,
  };
}

function buildRepository() {
  const store = new InMemoryTestimonialStore();
  const audit = new InMemoryAuditLog();
  const repository = new TestimonialRepository(store, audit, fixedClock);
  return { repository, store, audit };
}

describe('testimonialIdForPatient', () => {
  it('is stable for a patient and different between patients', () => {
    expect(testimonialIdForPatient('pat-1')).toBe(testimonialIdForPatient('pat-1'));
    expect(testimonialIdForPatient('pat-1')).not.toBe(testimonialIdForPatient('pat-2'));
  });

  it('does not contain the patient id', () => {
    // The id lands in a `TESTIMONIAL#<id>` partition key, which appears in
    // logs, metrics and error messages. A raw patient id there is a patient
    // identifier in all of them.
    expect(testimonialIdForPatient('pat-1')).not.toContain('pat-1');
  });
});

describe('TestimonialRepository.upsertForPatient', () => {
  it('publishes immediately — there is no review step to wait for', async () => {
    const { repository, audit } = buildRepository();
    const item = await repository.upsertForPatient(PATIENT, buildInput());

    expect(item.status).toBe('published');
    expect(item.consent.consentedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(item.consent.textVersion).toBe('2026-09-02');
    expect(audit.list().at(-1)).toMatchObject({
      action: 'create',
      entityType: 'Testimonial',
      actor: 'pat-1-sub',
    });
  });

  // The heart of "maximum one testimonial". Not a check anywhere — the
  // second write simply addresses the record the first one made.
  it('writes over the patient’s existing testimonial rather than adding a second', async () => {
    const { repository, store } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());
    await repository.upsertForPatient(
      PATIENT,
      buildInput({ quote: { en: 'A year on, still the best decision I made.' } }),
    );

    expect(await store.listAllIds()).toHaveLength(1);
    const mine = await repository.findForPatient('pat-1');
    expect(mine?.quote.en).toBe('A year on, still the best decision I made.');
  });

  it('records the second write as an update, not another create', async () => {
    const { repository, audit } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());
    await repository.upsertForPatient(PATIENT, buildInput({ quote: { en: 'Edited.' } }));

    expect(audit.list().map((event) => event.action)).toEqual(['create', 'update']);
  });

  it('keeps the original consent across an edit', async () => {
    // `consentedAt` records when the patient agreed to be published. Editing
    // their words does not re-ask the question, so it must not restamp the
    // answer — and a later `textVersion` must not be backdated onto a
    // consent that was given against the earlier wording.
    const movingClock = { now: () => new Date(times.shift() ?? '2026-03-01T00:00:00.000Z') };
    const times = ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'];
    const store = new InMemoryTestimonialStore();
    const repository = new TestimonialRepository(store, new InMemoryAuditLog(), movingClock);

    const first = await repository.upsertForPatient(PATIENT, buildInput());
    const second = await repository.upsertForPatient(
      PATIENT,
      buildInput({ quote: { en: 'Edited.' }, consentTextVersion: '2027-01-01' }),
    );

    expect(first.consent.consentedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.consent).toEqual(first.consent);
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps two patients’ testimonials apart', async () => {
    const { repository, store } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());
    await repository.upsertForPatient(
      OTHER_PATIENT,
      buildInput({ authorPatientId: 'pat-2', quote: { en: 'Mine.' } }),
    );

    expect(await store.listAllIds()).toHaveLength(2);
    expect((await repository.findForPatient('pat-1'))?.quote.en).toBe(
      'This service changed my recovery.',
    );
    expect((await repository.findForPatient('pat-2'))?.quote.en).toBe('Mine.');
  });
});

describe('TestimonialRepository.findPublished', () => {
  it('returns published testimonials', async () => {
    const { repository } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());

    expect(await repository.findPublished()).toHaveLength(1);
  });

  it('excludes a withdrawn one', async () => {
    const { repository } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());
    await repository.withdrawForPatient(PATIENT, 'pat-1');

    expect(await repository.findPublished()).toEqual([]);
  });

  it('excludes legacy pending_review and rejected rows, which nothing can transition any more', async () => {
    // These exist: anonymous submissions from the pre-2026-09-02 public
    // form. There is no route that publishes them, and this is the
    // assertion that they stay invisible rather than becoming public by
    // accident when the moderation code went away.
    const { repository, store } = buildRepository();
    await store.create({
      id: 'legacy-pending',
      status: 'pending_review',
      quote: { en: 'From the old form.' },
      attribution: { display: 'anonymous' },
      consent: { textVersion: '2026-08-14', consentedAt: '2026-08-14T00:00:00.000Z' },
      created_at: '2026-08-14T00:00:00.000Z',
      updated_at: '2026-08-14T00:00:00.000Z',
    });

    expect(await repository.findPublished()).toEqual([]);
  });
});

describe('TestimonialRepository.withdrawForPatient', () => {
  it('transitions to withdrawn, keeps the row, and keeps the text', async () => {
    const { repository, store, audit } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());

    const withdrawn = await repository.withdrawForPatient(PATIENT, 'pat-1');

    expect(withdrawn.status).toBe('withdrawn');
    // Never a deletion (00-conventions.md), and the words survive so the
    // patient can put it back rather than retyping it from memory.
    expect(await store.listAllIds()).toHaveLength(1);
    expect(withdrawn.quote.en).toBe('This service changed my recovery.');
    expect(audit.list().at(-1)).toMatchObject({ action: 'withdraw', entityType: 'Testimonial' });
  });

  it('can be republished by writing again', async () => {
    const { repository } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());
    await repository.withdrawForPatient(PATIENT, 'pat-1');

    const again = await repository.upsertForPatient(PATIENT, buildInput());

    expect(again.status).toBe('published');
    expect(await repository.findPublished()).toHaveLength(1);
  });

  it('throws RECORD_NOT_FOUND when the patient has never written one', async () => {
    const { repository } = buildRepository();

    await expect(repository.withdrawForPatient(PATIENT, 'pat-1')).rejects.toBeInstanceOf(AppError);
  });

  it('takes a patient id, so one patient cannot name another’s testimonial', async () => {
    const { repository } = buildRepository();
    await repository.upsertForPatient(PATIENT, buildInput());

    // There is no record-id parameter to pass. The only thing the caller
    // can supply is *whose* testimonial, and the handler supplies the
    // caller's own id.
    await expect(repository.withdrawForPatient(OTHER_PATIENT, 'pat-2')).rejects.toBeInstanceOf(
      AppError,
    );
    expect((await repository.findForPatient('pat-1'))?.status).toBe('published');
  });
});
