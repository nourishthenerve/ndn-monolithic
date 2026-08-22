import type { Appointment, Patient } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import type { AppointmentInput, AppointmentStore } from './appointment-repository.js';
import { AppointmentRepository } from './appointment-repository.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import type { DeliveryRecord } from './notification-log.js';
import type { Notifier } from './notifications.js';
import { PatientRepository } from './patient-repository.js';
import { runReminderSweep } from './reminder-sweep.js';
import { InMemoryStore } from './store.js';

const OWNER_ACTOR = actorContext(
  { subjectId: 'pat-1', role: 'patient' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

/** In-memory `AppointmentStore` — this file exercises `reminder-sweep.ts`'s own orchestration, not the real GSI4 Query/BETWEEN shape (`dynamo-store.test.ts`'s job). */
class InMemoryAppointmentStore implements AppointmentStore {
  private readonly items: Appointment[] = [];

  async create(appointment: Appointment): Promise<void> {
    this.items.push(appointment);
  }

  async listForPatient(patientId: string): Promise<Appointment[]> {
    return this.items.filter((item) => item.patientId === patientId);
  }

  async listForClinicianCalendar(): Promise<Appointment[]> {
    return [];
  }

  async cancel(patientId: string, scheduledAt: string, now: string): Promise<Appointment> {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    if (!item) {
      throw new Error(`no appointment for patient ${patientId} at ${scheduledAt}`);
    }
    const updated: Appointment = { ...item, appointment_status: 'cancelled', updated_at: now };
    this.items[this.items.indexOf(item)] = updated;
    return updated;
  }

  async listReminderCandidates(windowStart: string, windowEnd: string): Promise<Appointment[]> {
    return this.items.filter(
      (item) =>
        item.appointment_status === 'scheduled' &&
        item.reminder_sent_at === undefined &&
        item.scheduledAt >= windowStart &&
        item.scheduledAt <= windowEnd,
    );
  }

  async claimForReminder(
    patientId: string,
    scheduledAt: string,
    now: string,
  ): Promise<Appointment | undefined> {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    if (!item || item.reminder_sent_at !== undefined) {
      return undefined;
    }
    const updated: Appointment = { ...item, reminder_sent_at: now };
    this.items[this.items.indexOf(item)] = updated;
    return updated;
  }
}

/** Records every call, returns a canned `DeliveryRecord` — this file only needs to prove *when* `send` is (or isn't) called, not `notifications.ts`'s own guard chain (that's `notifications.test.ts`'s job). */
class FakeNotifier implements Notifier {
  readonly calls: { recipientId: string; template: string; vars: Readonly<Record<string, string>> }[] = [];

  async send(
    recipient: { id: string },
    template: string,
    vars: Readonly<Record<string, string>>,
  ): Promise<DeliveryRecord> {
    this.calls.push({ recipientId: recipient.id, template, vars });
    return { at: '2026-08-22T09:00:00.000Z', recipientId: recipient.id, template, channel: 'sms', outcome: 'sent' };
  }
}

async function build(overrides: { flagEnabled?: boolean; now?: string } = {}) {
  const now = overrides.now ?? '2026-08-22T09:00:00.000Z';
  const clock: Clock = { now: () => new Date(now) };

  const patientStore = new InMemoryStore<Patient>();
  const patients = new PatientRepository(patientStore, new InMemoryAuditLog(), clock);
  await patients.register(
    {
      subjectId: 'pat-1',
      personal: { fullName: 'A Patient', email: 'patient@example.com', phone: '07700900000', marketingOptIn: false },
    },
    OWNER_ACTOR,
  );

  const appointmentStore = new InMemoryAppointmentStore();
  const appointments = new AppointmentRepository(appointmentStore, new InMemoryAuditLog(), clock);

  const flagSource = new InMemoryFlagSource();
  flagSource.set('appointments.reminders.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const notifier = new FakeNotifier();

  return { appointments, appointmentStore, patients, notifier, flags, clock };
}

async function seed(appointments: AppointmentRepository, scheduledAt: string) {
  const input: AppointmentInput = {
    patientId: 'pat-1',
    clinicianId: 'cli-1',
    scheduledAt,
    durationMinutes: 30,
  };
  await appointments.schedule(
    input,
    actorContext({ subjectId: 'sub-1', role: 'sub-clinician' }, { requestId: 'req-1', sourceIp: '198.51.100.7' }),
  );
}

describe('runReminderSweep', () => {
  it('includes an appointment scheduled 55 minutes from now', async () => {
    const { appointments, patients, notifier, flags, clock } = await build();
    await seed(appointments, '2026-08-22T09:55:00.000Z');

    const result = await runReminderSweep({ appointments, patients, notifier, flags, clock });
    expect(result.candidates).toBe(1);
    expect(result.claimed).toBe(1);
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.template).toBe('appointmentReminder1Hour');
  });

  it('excludes an appointment scheduled 3 hours from now', async () => {
    const { appointments, patients, notifier, flags, clock } = await build();
    await seed(appointments, '2026-08-22T12:00:00.000Z');

    const result = await runReminderSweep({ appointments, patients, notifier, flags, clock });
    expect(result.candidates).toBe(0);
    expect(notifier.calls).toHaveLength(0);
  });

  it('running the sweep twice against the same window sends exactly one reminder, not two', async () => {
    const { appointments, patients, notifier, flags, clock } = await build();
    await seed(appointments, '2026-08-22T09:55:00.000Z');

    await runReminderSweep({ appointments, patients, notifier, flags, clock });
    const second = await runReminderSweep({ appointments, patients, notifier, flags, clock });

    expect(second.claimed).toBe(0);
    expect(notifier.calls).toHaveLength(1);
  });

  it('excludes an appointment cancelled inside the window — never reminded', async () => {
    const { appointments, patients, notifier, flags, clock } = await build();
    await seed(appointments, '2026-08-22T09:55:00.000Z');
    await appointments.cancel(
      'pat-1',
      '2026-08-22T09:55:00.000Z',
      actorContext(
        { subjectId: 'sub-1', role: 'sub-clinician' },
        { requestId: 'req-2', sourceIp: '198.51.100.7' },
      ),
    );

    const result = await runReminderSweep({ appointments, patients, notifier, flags, clock });
    expect(result.candidates).toBe(0);
    expect(notifier.calls).toHaveLength(0);
  });

  it('does nothing when the flag is off', async () => {
    const { appointments, patients, notifier, flags, clock } = await build({ flagEnabled: false });
    await seed(appointments, '2026-08-22T09:55:00.000Z');

    const result = await runReminderSweep({ appointments, patients, notifier, flags, clock });
    expect(result.candidates).toBe(0);
    expect(result.claimed).toBe(0);
    expect(notifier.calls).toHaveLength(0);
  });

  it('passes a UK wall-clock time string as the {time} var', async () => {
    const { appointments, patients, notifier, flags, clock } = await build();
    await seed(appointments, '2026-08-22T09:55:00.000Z');

    await runReminderSweep({ appointments, patients, notifier, flags, clock });
    expect(notifier.calls[0]?.vars.time).toMatch(/^\d{2}:\d{2}$/);
  });
});
