// TASK 4.2.1. Exercises the join decision against in-memory doubles for
// every dependency — no AWS, no WebSocket event shapes, those are
// ws-join-handler.test.ts's and infra's own concern.
import type { Appointment } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { InMemoryFlagSource, CachedFlagReader } from './flags.js';
import { unprojected } from './projection.js';
import {
  createJoinMessageHandler,
  type JoinAppointmentReader,
  type JoinCallRecorder,
  type JoinMessageDeps,
  type JoinPrincipalDirectory,
  type RecordCallJoin,
} from './ws-join.js';

const SCHEDULED_AT = '2026-09-01T10:00:00.000Z';
const APPOINTMENT_ID = `pat-1#${SCHEDULED_AT}`;
const ORIGIN = { requestId: 'req-1', sourceIpHash: 'hash-1' };

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    patientId: 'pat-1',
    clinicianId: 'cli-1',
    scheduledAt: SCHEDULED_AT,
    durationMinutes: 30,
    appointment_status: 'scheduled',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

class InMemoryAppointmentReader implements JoinAppointmentReader {
  constructor(private readonly items: Appointment[]) {}
  async get(patientId: string, scheduledAt: string) {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    return item ? unprojected(item) : undefined;
  }
}

class RecordingConnections implements JoinCallRecorder {
  readonly calls: RecordCallJoin[] = [];
  async recordCallJoin(input: RecordCallJoin): Promise<void> {
    this.calls.push(input);
  }
}

function directoryReturning(
  entry: { recordId: string; accountStatus: 'approved' | 'active' | 'suspended' } | undefined,
): JoinPrincipalDirectory {
  return { lookup: async () => entry };
}

function enabledFlags() {
  const source = new InMemoryFlagSource();
  source.set('video.callAuthz.enabled', true);
  return new CachedFlagReader({ source, clock: clockAt(SCHEDULED_AT), ttlMs: 0 });
}

/** `null` means "explicitly no record"; `undefined` (the default) means "use the patient's own". Distinct from each other so a test can ask for either without the two collapsing under `??`. */
function build(options: {
  appointments?: Appointment[];
  directoryEntry?: { recordId: string; accountStatus: 'approved' | 'active' | 'suspended' } | null;
  now?: string;
  flagsEnabled?: boolean;
  /** 2026-09-03: the join window is the booked slot, so its length is now a thing a test varies. */
  durationMinutes?: number;
} = {}) {
  const audit = new InMemoryAuditLog();
  const connections = new RecordingConnections();
  const directory = directoryReturning(
    options.directoryEntry === null
      ? undefined
      : (options.directoryEntry ?? { recordId: 'pat-1', accountStatus: 'approved' }),
  );
  const appointments = new InMemoryAppointmentReader(
    options.appointments ??
      [
        options.durationMinutes === undefined
          ? appointment()
          : appointment({ durationMinutes: options.durationMinutes }),
      ],
  );
  const flags =
    options.flagsEnabled === false ? { isEnabled: async () => false } : enabledFlags();

  const deps: JoinMessageDeps = {
    directory,
    appointments,
    connections,
    audit,
    clock: clockAt(options.now ?? SCHEDULED_AT),
    flags,
  };
  const join = createJoinMessageHandler(deps);
  return { join, audit, connections };
}

const PATIENT_CONNECTION = { principalId: 'pat-1', role: 'patient' as const, ttl: 1_798_000_000 };
const CLINICIAN_CONNECTION = { principalId: 'cli-1', role: 'sub-clinician' as const, ttl: 1_798_000_000 };

describe('the appointment’s own two parties can join inside the window', () => {
  it('the owning patient joins a scheduled appointment', async () => {
    const { join } = build();
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'joined' });
  });

  it('the assigned sub-clinician joins a scheduled appointment', async () => {
    const { join } = build({ directoryEntry: { recordId: 'cli-1', accountStatus: 'active' } });
    const result = await join({
      connectionId: 'conn-2',
      connection: CLINICIAN_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'joined' });
  });

  it('writes exactly one CALL# row carrying the joining connectionId', async () => {
    const { join, connections } = build();
    await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });

    expect(connections.calls).toEqual([
      {
        appointmentId: APPOINTMENT_ID,
        connectionId: 'conn-1',
        principalId: 'pat-1',
        role: 'patient',
        ttl: PATIENT_CONNECTION.ttl,
      },
    ]);
  });

  it('writes a "join" audit event naming the appointment and the principal', async () => {
    const { join, audit } = build();
    await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });

    expect(audit.list()).toEqual([
      expect.objectContaining({
        action: 'join',
        actor: 'pat-1',
        actorRole: 'patient',
        entityType: 'appointment',
        entityId: APPOINTMENT_ID,
      }),
    ]);
  });
});

describe('not-your-appointment — the authorisation-layer denial, always audited', () => {
  it('an unassigned sub-clinician is denied', async () => {
    const { join, audit } = build({ directoryEntry: { recordId: 'cli-9', accountStatus: 'active' } });
    const result = await join({
      connectionId: 'conn-3',
      connection: { principalId: 'cli-9', role: 'sub-clinician', ttl: 1 },
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });

    expect(result).toEqual({ type: 'join-denied', reason: 'not-your-appointment' });
    expect(audit.list()).toEqual([
      expect.objectContaining({ action: 'join-denied', entityId: APPOINTMENT_ID }),
    ]);
  });

  it('a patient naming another patient’s appointment is denied', async () => {
    const { join } = build({ directoryEntry: { recordId: 'pat-2', accountStatus: 'approved' } });
    const result = await join({
      connectionId: 'conn-4',
      connection: { principalId: 'pat-2', role: 'patient', ttl: 1 },
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });

    expect(result).toEqual({ type: 'join-denied', reason: 'not-your-appointment' });
  });

  it('an unknown appointment id is denied the same way — existence is never leaked', async () => {
    const { join } = build({ appointments: [] });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'join-denied', reason: 'not-your-appointment' });
  });

  it('a malformed appointment id (no #) is denied without touching the store', async () => {
    const { join } = build();
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: 'not-a-real-id',
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'join-denied', reason: 'not-your-appointment' });
  });

  it('no directory record for the caller is denied', async () => {
    const { join } = build({ directoryEntry: null });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'join-denied', reason: 'not-your-appointment' });
  });
});

describe('appointment state — checked only once authorisation has passed', () => {
  it('a cancelled appointment is denied regardless of window', async () => {
    const { join } = build({ appointments: [appointment({ appointment_status: 'cancelled' })] });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'join-denied', reason: 'cancelled' });
  });

  // 2026-09-01: the approval step. A booking waiting on the principal is
  // denied for its own reason, not as a cancellation — the boundary is the
  // same either way, the sentence the person reads is not, and telling a
  // clinician their own pending booking was cancelled would send them
  // hunting for a cancellation nobody made.
  it('a pending-approval appointment is denied as not-confirmed, not as cancelled', async () => {
    const { join } = build({
      appointments: [appointment({ appointment_status: 'pending-approval' })],
    });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'join-denied', reason: 'not-confirmed' });
  });

  it('a pending-approval appointment is denied even inside its own join window', async () => {
    // The window check runs *after* the status check, so an appointment
    // whose time has come but whose approval has not is still refused.
    const { join } = build({
      appointments: [appointment({ appointment_status: 'pending-approval' })],
      now: SCHEDULED_AT,
    });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'join-denied', reason: 'not-confirmed' });
  });

  // 2026-09-03: the window is the booked slot — `[scheduledAt,
  // scheduledAt + durationMinutes)`. The fixture appointment is 30
  // minutes, so these bounds are 10:00 and 10:30.
  //
  // The owner: *"keep this join the call button active from the start of
  // the appointment to the whole duration upto which this appointment has
  // been booked."* Previously a fixed ±window that ignored duration
  // entirely, so a 15-minute check-in stayed joinable for 30 minutes after
  // it ended and a 90-minute assessment shut both parties out halfway.
  async function joinAt(now: string) {
    const { join } = build({ now });
    return join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
  }

  it('a minute before the start is too-early — there is no early grace any more', async () => {
    expect(await joinAt('2026-09-01T09:59:00.000Z')).toEqual({
      type: 'join-denied',
      reason: 'too-early',
    });
  });

  it('exactly at the start, the join succeeds', async () => {
    expect(await joinAt(SCHEDULED_AT)).toEqual({ type: 'joined' });
  });

  it('midway through the booked slot, the join succeeds', async () => {
    expect(await joinAt('2026-09-01T10:20:00.000Z')).toEqual({ type: 'joined' });
  });

  it('the last millisecond of the slot still joins', async () => {
    expect(await joinAt('2026-09-01T10:29:59.999Z')).toEqual({ type: 'joined' });
  });

  it('the instant the slot ends is too-late', async () => {
    // The end is exclusive: `scheduledAt + durationMinutes` is past the
    // appointment, not the last moment of it. The UI says "expired" at the
    // same instant, from `joinPhase`'s matching `>=`.
    expect(await joinAt('2026-09-01T10:30:00.000Z')).toEqual({
      type: 'join-denied',
      reason: 'too-late',
    });
  });

  it('is too-late well after the slot, where the old fixed window still allowed a join', async () => {
    // 45 minutes past the start was inside the old 30-minute grace and is
    // outside a 30-minute appointment only because the window now ends
    // when the appointment does. This is the case the change exists for.
    expect(await joinAt('2026-09-01T10:45:00.000Z')).toEqual({
      type: 'join-denied',
      reason: 'too-late',
    });
  });

  it('a longer appointment stays joinable longer', async () => {
    const { join } = build({ now: '2026-09-01T11:15:00.000Z', durationMinutes: 90 });
    expect(
      await join({
        connectionId: 'conn-1',
        connection: PATIENT_CONNECTION,
        appointmentId: APPOINTMENT_ID,
        origin: ORIGIN,
      }),
    ).toEqual({ type: 'joined' });
  });
});

describe('the flag', () => {
  it('denies every join attempt when video.callAuthz.enabled is off', async () => {
    const { join, audit } = build({ flagsEnabled: false });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });

    expect(result).toEqual({ type: 'join-denied', reason: 'not-available' });
    expect(audit.list()).toEqual([]);
  });

  it('is independent of video.signalling.enabled — this handler never reads that flag', async () => {
    const { join } = build({ flagsEnabled: true });
    const result = await join({
      connectionId: 'conn-1',
      connection: PATIENT_CONNECTION,
      appointmentId: APPOINTMENT_ID,
      origin: ORIGIN,
    });
    expect(result).toEqual({ type: 'joined' });
  });
});
