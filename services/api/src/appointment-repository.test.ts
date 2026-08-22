import type { Appointment } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import type { AppointmentStore } from './appointment-repository.js';
import { AppointmentRepository } from './appointment-repository.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';

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
          item.clinicianId === clinicianId && item.scheduledAt >= from && item.scheduledAt <= to,
      )
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
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
});
