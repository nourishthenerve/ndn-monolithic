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
 */
export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no-show';

export interface Appointment extends BaseRecord {
  patientId: string;
  clinicianId: string;
  /** ISO-8601, UTC (a trailing `Z`) — also this record's own key suffix (`APPT#<scheduledAt>`) on both the main table and GSI1's projection. GSI4 carried the identical suffix too, until D-32 (2026-08-30) removed it along with the reminder sweep it existed for. */
  scheduledAt: string;
  durationMinutes: number;
  appointment_status: AppointmentStatus;
}
