// TASK 3.4.1: bespoke, not `Repository<T>`-based — the same reason
// `assignment-repository.ts`/`caseload-repository.ts` are: an appointment
// has no natural single opaque id (it is identified by `patientId` +
// `scheduledAt`), and its access patterns are two genuinely different
// queries (a patient's own list, a clinician's calendar over GSI1), not a
// single-item `get`/`put` `KeyValueStore<T>` can express.
import type { Appointment } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { unprojected, type Unprojected } from './projection.js';

export const APPOINTMENT_ENTITY_TYPE = 'appointment';

export interface AppointmentStore {
  /**
   * Conditioned on not already existing (`attribute_not_exists(pk)` on
   * the real implementation) — the same patient double-booked at the
   * exact same instant is a collision this store refuses, not an
   * overwrite. `gsi1pk`/`gsi1sk` are derived inside the real
   * implementation from `clinicianId`/`scheduledAt` alone, the identical
   * "derived inside the store, never a separate input" discipline
   * `DynamoAssignmentStore.writeDecision` established for the `PAT#`
   * pattern — the field and the index cannot disagree by construction.
   */
  create(appointment: Appointment): Promise<void>;
  /** Main-table `Query` on `PAT#<id>`, `begins_with(sk, 'APPT#')` — chronological (sort-key order), never a `Scan`. */
  listForPatient(patientId: string): Promise<Appointment[]>;
  /**
   * TASK 4.2.1: one `GetItem` on the appointment's own key — the WebSocket
   * join flow (`ws-join.ts`) is handed only an `appointmentId`
   * (`<patientId>#<scheduledAt>`, this entity's own opaque-looking id, per
   * this file's header note that it has no natural single one) and needs
   * exactly the one row it names, not a list to search.
   */
  get(patientId: string, scheduledAt: string): Promise<Appointment | undefined>;
  /**
   * GSI1 `Query`, `gsi1sk BETWEEN 'APPT#<from>' AND 'APPT#<to>'` —
   * chronological, never a `Scan`. TASK 3.4.2: a cancelled appointment is
   * excluded here (a clinician's live calendar has no use for one) but
   * remains in `listForPatient`'s own full history — "index gives
   * candidates, the read confirms them," the same discipline
   * `CaseloadRepository` already uses for its own stale-row case.
   */
  listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Appointment[]>;
  /**
   * TASK 3.4.2: an atomic `UpdateItem` — `appointment_status` alone, never
   * `scheduledAt` (rescheduling is cancel-the-old, `POST` a new one, so
   * the append-only property every entity in this table keeps holds here
   * without a special case). `gsi1pk`/`gsi1sk` are untouched, so the row
   * never needs re-deriving them — only the calendar *read*'s own filter
   * (above) decides a cancelled row no longer matters there. Conditioned
   * on the row existing (`attribute_exists(pk)` on the real
   * implementation); throws `RECORD_NOT_FOUND` otherwise, never a silent
   * no-op.
   */
  cancel(patientId: string, scheduledAt: string, now: string): Promise<Appointment>;
  /**
   * TASK 3.4.3: GSI4 `Query` (`gsi4pk = 'APPT#REMINDER'`, `gsi4sk BETWEEN
   * windowStart AND windowEnd`), never a `Scan`. GSI4 is `KEYS_ONLY`
   * (`docs/adr/0002-database.md`'s own proof), so this is a two-step read
   * like `listForClinicianCalendar`'s own: a follow-up `GetItem` per
   * candidate, with rows excluded — `appointment_status !== 'scheduled'`
   * or `reminder_sent_at` already set — after the fetch confirms them,
   * never via a `FilterExpression` naming an attribute the index does
   * not project. Candidates only: the caller still must
   * `claimForReminder` each one before treating it as truly eligible.
   */
  listReminderCandidates(windowStart: string, windowEnd: string): Promise<Appointment[]>;
  /**
   * The one atomic step that makes replay-safety a property of the store,
   * not the caller's own care: `SET reminder_sent_at`, conditioned on it
   * being currently absent *and* the row existing. Returns the claimed
   * appointment on success; `undefined` on a failed condition — always a
   * benign, expected outcome during normal sweep operation (already
   * claimed by an earlier tick, or the row no longer exists), never an
   * error to throw for.
   */
  claimForReminder(
    patientId: string,
    scheduledAt: string,
    now: string,
  ): Promise<Appointment | undefined>;
}

export interface AppointmentInput {
  readonly patientId: string;
  readonly clinicianId: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
}

export class AppointmentRepository {
  constructor(
    private readonly store: AppointmentStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Only ever reaches this far when `can()` has already granted the
   * `'Sub-clinician (assigned)'` column (`authz-matrix.ts`'s `Appointments`
   * row) — this method trusts the caller to have checked, the same
   * contract every other repository in this codebase keeps.
   */
  async schedule(
    input: AppointmentInput,
    actor: ActorContext,
  ): Promise<Unprojected<Appointment>> {
    const now = this.clock.now().toISOString();
    const appointment: Appointment = {
      ...input,
      appointment_status: 'scheduled',
      created_at: now,
      updated_at: now,
      status: 'active',
    };
    await this.store.create(appointment);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: APPOINTMENT_ENTITY_TYPE,
        entityId: `${input.patientId}#${input.scheduledAt}`,
      }),
    );
    return unprojected(appointment);
  }

  async listForPatient(patientId: string): Promise<Unprojected<Appointment>[]> {
    const items = await this.store.listForPatient(patientId);
    return items.map(unprojected);
  }

  /**
   * No `can()`/`ActorContext` gate, and no audit write — unlike every
   * write method here. `ws-join.ts` is this method's only caller: it
   * needs the record *before* it can decide whether `can()` grants
   * `'join-call'`, so gating inside this method would be backwards, and
   * the join attempt's own audit event (`ws-join.ts`, TASK 4.2.1) already
   * covers "who tried to reach this appointment," which is what would
   * otherwise be recorded here.
   */
  async get(patientId: string, scheduledAt: string): Promise<Unprojected<Appointment> | undefined> {
    const item = await this.store.get(patientId, scheduledAt);
    return item ? unprojected(item) : undefined;
  }

  async listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Unprojected<Appointment>[]> {
    const items = await this.store.listForClinicianCalendar(clinicianId, from, to);
    return items.map(unprojected);
  }

  /**
   * Only ever reaches this far when `can()` has already granted the
   * `'Sub-clinician (assigned)'` column — the identical contract
   * `schedule` keeps, and the identical column: `Appointments`'s own
   * `Principal` cell is bare `R`, so the principal cancels nothing
   * through this method either.
   */
  async cancel(
    patientId: string,
    scheduledAt: string,
    actor: ActorContext,
  ): Promise<Unprojected<Appointment>> {
    const now = this.clock.now().toISOString();
    const updated = await this.store.cancel(patientId, scheduledAt, now);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'update',
        entityType: APPOINTMENT_ENTITY_TYPE,
        entityId: `${patientId}#${scheduledAt}`,
      }),
    );
    return unprojected(updated);
  }

  /**
   * No `can()`/`ActorContext` gate — unlike every other method here,
   * this one is never reached through an authenticated HTTP request.
   * `reminder-sweep.ts` is the only caller, invoked on an EventBridge
   * schedule with no principal to authorise against; `audit.ts`'s own
   * log exists to say *who* did something, and nobody did — the
   * `Notifier`'s own delivery record (`notification-log.ts`), written
   * for every claimed appointment regardless of outcome, is this flow's
   * durable record instead.
   */
  async listReminderCandidates(
    windowStart: string,
    windowEnd: string,
  ): Promise<Unprojected<Appointment>[]> {
    const items = await this.store.listReminderCandidates(windowStart, windowEnd);
    return items.map(unprojected);
  }

  /** See `AppointmentStore.claimForReminder`'s own doc — the same no-principal reasoning as `listReminderCandidates` applies here too. */
  async claimForReminder(
    patientId: string,
    scheduledAt: string,
  ): Promise<Unprojected<Appointment> | undefined> {
    const now = this.clock.now().toISOString();
    const claimed = await this.store.claimForReminder(patientId, scheduledAt, now);
    return claimed ? unprojected(claimed) : undefined;
  }
}
