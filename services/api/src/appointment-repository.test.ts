import type { Appointment } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import type { AppointmentStore, AppointmentTransition } from './appointment-repository.js';
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

  /** Mirrors `DynamoAppointmentStore.transition`'s own contract: `expect` refuses the write rather than overwriting a decision someone else already made. */
  async transition(
    patientId: string,
    scheduledAt: string,
    change: AppointmentTransition,
  ): Promise<Appointment> {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    if (!item) {
      throw new AppError('RECORD_NOT_FOUND', `no appointment for patient ${patientId} at ${scheduledAt}`);
    }
    if (change.expect && item.appointment_status !== change.expect) {
      throw new AppError(
        'APPOINTMENT_STATE_CONFLICT',
        `appointment for patient ${patientId} at ${scheduledAt} is ${item.appointment_status}, not ${change.expect}`,
      );
    }
    const updated: Appointment = {
      ...item,
      appointment_status: change.to,
      updated_at: change.now,
      ...(change.decidedBy ? { approvedBy: change.decidedBy, approvedAt: change.now } : {}),
    };
    this.items[this.items.indexOf(item)] = updated;
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
    );
    await repository.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    { requiresApproval: false },
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
    { requiresApproval: false },
    );
    await repository.schedule(
      { patientId: 'pat-2', clinicianId: 'cli-1', scheduledAt: '2026-09-01T11:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    { requiresApproval: false },
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
    { requiresApproval: false },
    );
    await repository.schedule(
      { patientId: 'pat-2', clinicianId: 'cli-1', scheduledAt: '2026-09-01T09:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    { requiresApproval: false },
    );
    // A different clinician's appointment, same day — must never appear.
    await repository.schedule(
      { patientId: 'pat-3', clinicianId: 'cli-2', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      ACTOR,
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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
    { requiresApproval: false },
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

// 2026-09-01: "any new appointment booked by the clinician needs to be
// approved by the principal clinician." The repository's half of that is
// three things — the initial status is the caller's to choose, only a
// pending booking can be decided, and a decision is stamped with who made
// it.
describe('AppointmentRepository — the approval step', () => {
  const PRINCIPAL_ACTOR = actorContext(
    { subjectId: 'sub-principal', role: 'principal-clinician' },
    { requestId: 'req-2', sourceIp: '198.51.100.9' },
  );
  const BOOKING = {
    patientId: 'pat-1',
    clinicianId: 'cli-1',
    scheduledAt: '2026-09-01T10:00:00.000Z',
    durationMinutes: 30,
  } as const;

  it('starts a booking pending-approval when the caller says it needs approving', async () => {
    const { repository } = build();
    const created = await repository.schedule(BOOKING, ACTOR, { requiresApproval: true });
    expect(created.appointment_status).toBe('pending-approval');
    expect(created.approvedBy).toBeUndefined();
  });

  it('starts a booking scheduled when it does not — the principal is the approver', async () => {
    const { repository } = build();
    const created = await repository.schedule(BOOKING, PRINCIPAL_ACTOR, { requiresApproval: false });
    expect(created.appointment_status).toBe('scheduled');
  });

  it('approve() confirms a pending booking and stamps who decided it', async () => {
    const { repository } = build();
    await repository.schedule(BOOKING, ACTOR, { requiresApproval: true });
    const approved = await repository.approve('pat-1', BOOKING.scheduledAt, PRINCIPAL_ACTOR);
    expect(approved.appointment_status).toBe('scheduled');
    expect(approved.approvedBy).toBe('sub-principal');
    expect(approved.approvedAt).toBe('2026-08-22T09:00:00.000Z');
    // Never `scheduledAt` — the GSI1 projection is derived from it, so a
    // decision that moved the time would strand the index.
    expect(approved.scheduledAt).toBe(BOOKING.scheduledAt);
  });

  it('decline() cancels a pending booking rather than inventing a fifth status', async () => {
    const { repository } = build();
    await repository.schedule(BOOKING, ACTOR, { requiresApproval: true });
    const declined = await repository.decline('pat-1', BOOKING.scheduledAt, PRINCIPAL_ACTOR);
    expect(declined.appointment_status).toBe('cancelled');
    expect(declined.approvedBy).toBe('sub-principal');
  });

  it('refuses to approve a booking that is no longer pending — a second decision never overwrites the first', async () => {
    const { repository } = build();
    await repository.schedule(BOOKING, ACTOR, { requiresApproval: true });
    await repository.decline('pat-1', BOOKING.scheduledAt, PRINCIPAL_ACTOR);
    await expect(
      repository.approve('pat-1', BOOKING.scheduledAt, PRINCIPAL_ACTOR),
    ).rejects.toMatchObject({ code: 'APPOINTMENT_STATE_CONFLICT' });
  });

  it('refuses to decline an already-confirmed appointment — that is cancel, on a different row', async () => {
    const { repository } = build();
    await repository.schedule(BOOKING, PRINCIPAL_ACTOR, { requiresApproval: false });
    await expect(
      repository.decline('pat-1', BOOKING.scheduledAt, PRINCIPAL_ACTOR),
    ).rejects.toMatchObject({ code: 'APPOINTMENT_STATE_CONFLICT' });
  });

  it('cancel() withdraws a pending booking — a request nobody could retract would be a trap', async () => {
    const { repository } = build();
    await repository.schedule(BOOKING, ACTOR, { requiresApproval: true });
    const cancelled = await repository.cancel('pat-1', BOOKING.scheduledAt, ACTOR);
    expect(cancelled.appointment_status).toBe('cancelled');
    // No decision stamp: withdrawing a request is not an approval decision.
    expect(cancelled.approvedBy).toBeUndefined();
  });

  it('audits every decision against the deciding principal', async () => {
    const { repository, audit } = build();
    await repository.schedule(BOOKING, ACTOR, { requiresApproval: true });
    await repository.approve('pat-1', BOOKING.scheduledAt, PRINCIPAL_ACTOR);
    expect(audit.list()).toEqual([
      expect.objectContaining({ action: 'create', actor: 'sub-1' }),
      expect.objectContaining({
        action: 'update',
        actor: 'sub-principal',
        entityId: 'pat-1#2026-09-01T10:00:00.000Z',
      }),
    ]);
  });
});
