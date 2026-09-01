// TASK 3.4.1: bespoke, not `Repository<T>`-based — the same reason
// `assignment-repository.ts`/`caseload-repository.ts` are: an appointment
// has no natural single opaque id (it is identified by `patientId` +
// `scheduledAt`), and its access patterns are two genuinely different
// queries (a patient's own list, a clinician's calendar over GSI1), not a
// single-item `get`/`put` `KeyValueStore<T>` can express.
import type { Appointment, AppointmentStatus } from '@ndn/shared-types';

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
   * TASK 3.4.2: an atomic `UpdateItem` — `appointment_status` alone (plus,
   * since 2026-09-01, the two approval stamps), never `scheduledAt`
   * (rescheduling is cancel-the-old, `POST` a new one, so the append-only
   * property every entity in this table keeps holds here without a special
   * case). `gsi1pk`/`gsi1sk` are untouched, so the row never needs
   * re-deriving them — only the calendar *read*'s own filter (above)
   * decides a cancelled row no longer matters there. Conditioned on the
   * row existing; throws `RECORD_NOT_FOUND` otherwise, never a silent
   * no-op.
   *
   * **2026-09-01 replaces `cancel`.** Approval added two more transitions
   * of the identical shape, and three near-identical `UpdateItem` methods
   * would be three places for the condition expression to drift. `expect`
   * is what makes a transition safe against a concurrent one: approving
   * an appointment that a second principal has already declined must fail,
   * not silently reopen it, so the condition is checked *in the write*
   * rather than in a read before it.
   */
  transition(
    patientId: string,
    scheduledAt: string,
    change: AppointmentTransition,
  ): Promise<Appointment>;
}

export interface AppointmentTransition {
  readonly to: AppointmentStatus;
  readonly now: string;
  /** When set, the write applies only if the row is currently in this status — otherwise `APPOINTMENT_STATE_CONFLICT`. */
  readonly expect?: AppointmentStatus;
  /** The deciding principal's `sub`, stamped onto `approvedBy`/`approvedAt`. Set for approve and decline; absent for a plain cancel, which is not an approval decision. */
  readonly decidedBy?: string;
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
   * Only ever reaches this far when `can()` has already granted a column
   * of `authz-matrix.ts`'s `Appointments` row — this method trusts the
   * caller to have checked, the same contract every other repository in
   * this codebase keeps.
   *
   * **2026-09-01: the initial status is a parameter, and the caller
   * decides it from who is booking.** "Any new appointment booked by the
   * clinician needs to be approved by the principal clinician" — so a
   * sub-clinician's booking starts `pending-approval` and a principal's
   * starts `scheduled`, because the approver approving themselves is a
   * step with no decision in it. The rule lives in `appointment.ts`, next
   * to the `can()` call that already resolved which role is asking; a
   * repository deriving it from `actor.role` would be a second place
   * roles are interpreted, and the whole point of `can()` is that there
   * is only one.
   */
  async schedule(
    input: AppointmentInput,
    actor: ActorContext,
    options: { readonly requiresApproval: boolean },
  ): Promise<Unprojected<Appointment>> {
    const now = this.clock.now().toISOString();
    const appointment: Appointment = {
      ...input,
      appointment_status: options.requiresApproval ? 'pending-approval' : 'scheduled',
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
   * Only ever reaches this far when `can()` has already granted `update`
   * on the `Appointments` row — the identical contract `schedule` keeps.
   *
   * Cancels from any status, `pending-approval` included: a clinician
   * withdrawing a request they have not had approved yet is the same
   * action to this row as calling off a confirmed session, and refusing
   * the first would leave a request nobody could retract.
   */
  cancel(
    patientId: string,
    scheduledAt: string,
    actor: ActorContext,
  ): Promise<Unprojected<Appointment>> {
    return this.transition(patientId, scheduledAt, actor, { to: 'cancelled' });
  }

  /**
   * 2026-09-01. Only ever reaches this far when `can()` has granted
   * `update` on the **`Appointment approval`** row — a different row from
   * the one `cancel` above needs, and `Principal`-only, which is the whole
   * of "any new appointment booked by the clinician needs to be approved
   * by the principal clinician."
   *
   * `expect: 'pending-approval'` is enforced inside the write, so a second
   * principal approving what a first has already declined gets
   * `APPOINTMENT_STATE_CONFLICT` rather than quietly resurrecting it.
   */
  approve(
    patientId: string,
    scheduledAt: string,
    actor: ActorContext,
  ): Promise<Unprojected<Appointment>> {
    return this.transition(patientId, scheduledAt, actor, {
      to: 'scheduled',
      expect: 'pending-approval',
      decidedBy: actor.subjectId,
    });
  }

  /**
   * A declined request becomes `cancelled` — see `AppointmentStatus`'s own
   * doc on why that is not a fifth state. `expect` is what distinguishes
   * this from `cancel`: only a booking still awaiting a decision can be
   * declined, so "decline" can never be used to call off a session that
   * was already confirmed (that is `cancel`, on the other row).
   */
  decline(
    patientId: string,
    scheduledAt: string,
    actor: ActorContext,
  ): Promise<Unprojected<Appointment>> {
    return this.transition(patientId, scheduledAt, actor, {
      to: 'cancelled',
      expect: 'pending-approval',
      decidedBy: actor.subjectId,
    });
  }

  /**
   * 2026-09-01. TASK 3.4.2 named `completed`/`no-show` as the reason this
   * field has four states and then built no route for either, and nothing
   * has since — so `appointment_status` has never once been `'completed'`
   * anywhere in this system.
   *
   * That was a harmless gap until two features started counting it:
   * `CaseloadRepository`'s visitor view ("number of appointments happened")
   * and the assessment form's calendar section ("how many
   * appointments/sessions has taken place so far"). Both would have read
   * zero forever, which is worse than an obviously missing figure — it is
   * a wrong one that looks right.
   *
   * `expect: 'scheduled'` on both: an appointment that was cancelled, or
   * that is still awaiting approval, did not take place and cannot be
   * marked as though it did.
   */
  markAttended(
    patientId: string,
    scheduledAt: string,
    actor: ActorContext,
    outcome: 'completed' | 'no-show',
  ): Promise<Unprojected<Appointment>> {
    return this.transition(patientId, scheduledAt, actor, {
      to: outcome,
      expect: 'scheduled',
    });
  }

  private async transition(
    patientId: string,
    scheduledAt: string,
    actor: ActorContext,
    change: Omit<AppointmentTransition, 'now'>,
  ): Promise<Unprojected<Appointment>> {
    const now = this.clock.now().toISOString();
    const updated = await this.store.transition(patientId, scheduledAt, { ...change, now });
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
}
