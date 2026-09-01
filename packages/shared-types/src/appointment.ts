// TASK 3.4.1: `docs/adr/0002-database.md` proved this entity's own access
// pattern before either GSI1 or this entity existed — "TASK 3.4.x, not
// built here — key shape checked now, while the index is still cheap to
// shape." This is that task.
//
// No video/call field yet — Phase 4 adds one additively when it lands,
// and this shape is deliberately minimal so that addition needs no
// migration (05-execution-plan.md's own "Do NOT: add a video/call field
// before Phase 4 needs one").
import type { BaseRecord } from './types.js';

/**
 * Deliberately not named `status` — that name is `BaseRecord['status']`'s
 * own (the row-is-live/soft-delete flag), and reusing it here would make
 * "cancelled" and "deleted" collide the same way `patient.ts`'s own
 * `PatientAccountStatus` comment warns against for `account_status`.
 * `appointment_status` follows that exact precedent.
 *
 * 2026-09-01 adds `'pending-approval'`, and it is the state a
 * sub-clinician's booking *starts* in: the owner's *"any new appointment
 * booked by the clinician needs to be approved by the principal
 * clinician."*
 *
 * Deliberately a status on the appointment rather than a separate
 * request entity. A booking that is awaiting approval is already a claim
 * on a slot — `AppointmentStore.create`'s own `attribute_not_exists`
 * conflict has to see it, or two clinicians could each get a "pending"
 * booking for the same instant and only discover it at approval time —
 * and it already has a patient, a clinician, a time and a length. A
 * parallel `APPTREQ#` row would carry all four and then have to be kept
 * in step with the row it becomes.
 *
 * **A declined request becomes `'cancelled'`, not a fifth state.** The
 * two mean the same thing to everything that reads this field (the
 * appointment is not happening, it stays in the patient's history, the
 * clinician calendar skips it), and who declined it and when is the audit
 * log's job, which already records it. A separate `'declined'` would be a
 * state every consumer has to learn in order to treat it identically.
 */
export type AppointmentStatus =
  | 'pending-approval'
  | 'scheduled'
  | 'completed'
  | 'cancelled'
  | 'no-show';

/** The statuses a patient's *booked* appointment is counted by — what the calendar section's "next appointment" reads, and what the join-call window is measured against. A `pending-approval` slot is not yet an appointment anyone should turn up to. */
export const CONFIRMED_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ['scheduled'];

export interface Appointment extends BaseRecord {
  patientId: string;
  clinicianId: string;
  /** ISO-8601, UTC (a trailing `Z`) — also this record's own key suffix (`APPT#<scheduledAt>`) on both the main table and GSI1's projection. GSI4 carried the identical suffix too, until D-32 (2026-08-30) removed it along with the reminder sweep it existed for. */
  scheduledAt: string;
  durationMinutes: number;
  appointment_status: AppointmentStatus;
  /**
   * 2026-09-01. Who approved (or declined) the booking, and when — the
   * principal clinician's `sub`. Absent while `pending-approval`, and
   * absent forever on an appointment the principal booked themselves,
   * which never needed approving. An identifier, never a name.
   */
  approvedBy?: string;
  approvedAt?: string;
}
