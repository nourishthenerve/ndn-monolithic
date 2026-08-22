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
  /** GSI1 `Query`, `gsi1sk BETWEEN 'APPT#<from>' AND 'APPT#<to>'` — chronological, never a `Scan`. */
  listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Appointment[]>;
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

  async listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Unprojected<Appointment>[]> {
    const items = await this.store.listForClinicianCalendar(clinicianId, from, to);
    return items.map(unprojected);
  }
}
