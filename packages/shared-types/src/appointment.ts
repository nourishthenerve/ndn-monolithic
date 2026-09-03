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

/**
 * 2026-09-01: what "the total number of appointments" means, in one place,
 * because two surfaces show it to the same person and a visitor seeing two
 * different totals for one patient would be worse than seeing neither —
 * the dashboard list (`caseload-repository.ts`) and the assessment form's
 * calendar section (`assessment.ts`).
 *
 * **An appointment counts once it stands.** `scheduled` (booked, ahead),
 * `completed` (happened) and `no-show` (booked, its time came) are all
 * appointments this patient has had or has. The two exclusions are the
 * whole of the definition:
 *
 *   * **`cancelled` never happened.** Counting it would let the total
 *     climb from bookings that were called off, which is the opposite of
 *     what anyone asking "how many appointments" wants to know.
 *   * **`pending-approval` is not confirmed yet**, and excluding it does
 *     a second job for the `Visitor` column: a total that moved as the
 *     principal worked through an approval queue would leak the practice's
 *     internal workflow to a partner organisation, one increment at a
 *     time. A visitor's figure only ever moves when something real does.
 */
export const COUNTED_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'scheduled',
  'completed',
  'no-show',
];

/** Whether this appointment counts toward "the total number of appointments" — see `COUNTED_APPOINTMENT_STATUSES`. Takes the status alone so a store counting raw rows can call it without building an `Appointment`. */
export function countsTowardTotal(status: unknown): boolean {
  return COUNTED_APPOINTMENT_STATUSES.includes(status as AppointmentStatus);
}

/**
 * **2026-09-03: an appointment ends when its booked slot ends, and not
 * one instant before.** The owner: *"when the item of appointment arrived
 * the 'join the call' button simply didnt appear for both the patient as
 * well as the clinician. The dashboard simply started showing the next
 * appointment item."*
 *
 * That was one mistake made independently in four places, on both sides of
 * the wire: `scheduledAt` in the past was read as "this appointment is
 * over". It is not — it is the *only* moment the appointment is actually
 * happening. The join window opens exactly then (`ws-join.ts`), so every
 * surface that used the start as its cut-off dropped each appointment at
 * the precise instant the button was due to appear, and rolled on to the
 * next one. The join link was unreachable by construction.
 *
 * One definition, here, so the surfaces cannot drift apart again. Named
 * `appointmentEndsAt` rather than a "window" — it is a fact about the
 * appointment, and the join window merely happens to be the same span.
 *
 * `apps/web` deliberately does not depend on this package (see
 * `CaseloadView.tsx`'s own note), and mirrors this in
 * `apps/web/src/account/join-window.ts` — the same restated-not-imported
 * arrangement the join window itself already has across the two
 * deployables.
 */
export function appointmentEndsAt(scheduledAt: string, durationMinutes: number): number {
  return new Date(scheduledAt).getTime() + durationMinutes * 60_000;
}

/**
 * Whether the booked slot has finished. `>=` on the end, matching
 * `ws-join.ts`: the last millisecond of a slot is past the end of it.
 *
 * An unparseable `scheduledAt` is treated as **over**, which is the
 * deny-by-default reading every other parse of this field takes — a row
 * nobody can place in time must not present a live join link.
 */
export function isAppointmentOver(
  scheduledAt: string,
  durationMinutes: number,
  now: Date,
): boolean {
  const endsAt = appointmentEndsAt(scheduledAt, durationMinutes);
  return Number.isNaN(endsAt) || now.getTime() >= endsAt;
}

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
