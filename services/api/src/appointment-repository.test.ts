import type { Appointment } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import type { AppointmentStore } from './appointment-repository.js';
import { AppointmentRepository } from './appointment-repository.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const ACTOR = actorContext(
  { subjectId: 'sub-1', role: 'sub-clinician' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);

/** A minimal in-memory `AppointmentStore` — this file tests `AppointmentRepository`'s own logic, not a real Dynamo Query/BETWEEN shape (that's `dynamo-store.test.ts`'s job). */
class InMemoryAppointmentStore implements AppointmentStore {
  private readonly items: Appointment[] = [];

  async create(appointment: Appointment): Promise<void> {
    this.items.push(appointment);
  }

  async listForPatient(patientId: string): Promise<Appointment[]> {
    return this.items
      .filter((item) => item.patientId === patientId)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  async listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Appointment[]> {
    return this.items
      .filter(
        (item) =>
          item.clinicianId === clinicianId &&
          item.scheduledAt >= from &&
          item.scheduledAt <= to &&
          item.appointment_status !== 'cancelled',
      )
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  async get(patientId: string, scheduledAt: string): Promise<Appointment | undefined> {
    return this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
  }

  async cancel(patientId: string, scheduledAt: string, now: string): Promise<Appointment> {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    if (!item) {
      throw new AppError('RECORD_NOT_FOUND', `no appointment for patient ${patientId} at ${scheduledAt}`);
    }
    const updated: Appointment = { ...item, appointment_status: 'cancelled', updated_at: now };
    const index = this.items.indexOf(item);
    this.items[index] = updated;
    return updated;
  }
}

function build() {
  const store = new InMemoryAppointmentStore();
  const audit = new InMemoryAuditLog();
  const repository = new AppointmentRepository(store, audit, clock);
  return { repository, store, audit };
}

describe('AppointmentRepository.schedule', () => {
  it('sets appointment_status to scheduled and stamps created_at/updated_at', async () => {
    const { repository } = build();
    const created = await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    expect(created.appointment_status).toBe('scheduled');
    expect(created.created_at).toBe('2026-08-22T09:00:00.000Z');
    expect(created.status).toBe('active');
  });

  it('writes an audit entry keyed by patient and scheduled time', async () => {
    const { repository, audit } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    expect(audit.list()).toEqual([
      expect.objectContaining({
        action: 'create',
        entityType: 'appointment',
        entityId: 'pat-1#2026-09-01T10:00:00.000Z',
      }),
    ]);
  });
});

describe('AppointmentRepository.get', () => {
  it('returns the one appointment named by patientId + scheduledAt', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );

    const found = await repository.get('pat-1', '2026-09-01T10:00:00.000Z');
    expect(found?.patientId).toBe('pat-1');
    expect(found?.clinicianId).toBe('cli-1');
  });

  it('returns undefined for an appointment that was never scheduled', async () => {
    const { repository } = build();
    expect(await repository.get('pat-1', '2026-09-01T10:00:00.000Z')).toBeUndefined();
  });

  it('writes no audit entry — the caller\'s own join attempt is what gets audited, not this read', async () => {
    const { repository, audit } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    const before = audit.list().length; // schedule() itself already wrote one entry

    await repository.get('pat-1', '2026-09-01T10:00:00.000Z');

    expect(audit.list().length).toBe(before);
  });
});

describe('AppointmentRepository.listForPatient', () => {
  it('returns a patient\'s own appointments, chronologically', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-02T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    const items = await repository.listForPatient('pat-1');
    expect(items.map((item) => item.scheduledAt)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
    ]);
  });

  it('never returns another patient\'s appointments', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    await repository.schedule(
      { patientId: 'pat-2', clinicianId: 'cli-1', scheduledAt: '2026-09-01T11:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    const items = await repository.listForPatient('pat-1');
    expect(items).toHaveLength(1);
    expect(items[0]?.patientId).toBe('pat-1');
  });
});

describe('AppointmentRepository.listForClinicianCalendar', () => {
  it('returns exactly the assigned clinician\'s own appointments within range, chronologically', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-02T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    await repository.schedule(
      { patientId: 'pat-2', clinicianId: 'cli-1', scheduledAt: '2026-09-01T09:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    // A different clinician's appointment, same day — must never appear.
    await repository.schedule(
      { patientId: 'pat-3', clinicianId: 'cli-2', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    const items = await repository.listForClinicianCalendar(
      'cli-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-03T00:00:00.000Z',
    );
    expect(items.map((item) => item.patientId)).toEqual(['pat-2', 'pat-1']);
  });

  it('excludes appointments outside the given range', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-08-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    const items = await repository.listForClinicianCalendar(
      'cli-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-30T00:00:00.000Z',
    );
    expect(items).toHaveLength(0);
  });

  it('excludes a cancelled appointment — a clinician\'s live calendar has no use for one', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    await repository.cancel('pat-1', '2026-09-01T10:00:00.000Z', ACTOR);
    const items = await repository.listForClinicianCalendar(
      'cli-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(items).toHaveLength(0);
  });
});

describe('AppointmentRepository.cancel', () => {
  it('transitions appointment_status to cancelled without touching gsi1pk/gsi1sk-deriving fields', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    const cancelled = await repository.cancel('pat-1', '2026-09-01T10:00:00.000Z', ACTOR);
    expect(cancelled.appointment_status).toBe('cancelled');
    expect(cancelled.clinicianId).toBe('cli-1');
    expect(cancelled.scheduledAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('leaves a cancelled appointment in the patient\'s own full history', async () => {
    const { repository } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    await repository.cancel('pat-1', '2026-09-01T10:00:00.000Z', ACTOR);
    const items = await repository.listForPatient('pat-1');
    expect(items).toHaveLength(1);
    expect(items[0]?.appointment_status).toBe('cancelled');
  });

  it('writes an audit entry for the cancellation', async () => {
    const { repository, audit } = build();
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    );
    await repository.cancel('pat-1', '2026-09-01T10:00:00.000Z', ACTOR);
    expect(audit.list()).toEqual([
      expect.objectContaining({ action: 'create', entityId: 'pat-1#2026-09-01T10:00:00.000Z' }),
      expect.objectContaining({ action: 'update', entityId: 'pat-1#2026-09-01T10:00:00.000Z' }),
    ]);
  });

  it('throws AppError(RECORD_NOT_FOUND) rather than a silent no-op for an appointment that was never scheduled', async () => {
    const { repository } = build();
    await expect(repository.cancel('pat-1', '2026-09-01T10:00:00.000Z', ACTOR)).rejects.toThrow(
      AppError,
    );
  });
});

