// 2026-09-01: "When a clinician/principal clinician edits a calender for a
// given patient it will appear as a notification on patients logged in
// dashboard."
//
// **Not `Notifier` (services/api/src/notifications.ts).** That is the
// outbound channel — email, with SMS for the one eligible template — and
// it does not, and should not, put anything on a screen. This is an
// in-app feed: a row per event on the patient's own `PAT#<id>` partition,
// read by the patient's dashboard and by nobody else. The two are
// deliberately separate mechanisms rather than one: an email that failed
// to send must not remove the notice from the dashboard, and a dashboard
// the patient has not opened must not suppress an email.
//
// **Content is a kind and a time, never prose.** The record carries no
// message text at all — the dashboard renders the wording from `@ndn/i18n`
// off `kind`. That keeps the feed translatable without a migration, keeps
// clinical content out of a row that is not governed by the assessment
// matrix, and means the audit log's own copy of "what happened" stays the
// single narrative account.
import type { BaseRecord } from './types.js';

/**
 * Every kind is a calendar event, because the calendar is what the owner
 * asked to be notified about. Adding a kind is additive: a dashboard that
 * meets one it has no wording for falls back to a generic line rather
 * than rendering nothing (see `PatientNotifications.tsx`).
 */
export type PatientNotificationKind =
  /** A clinician has requested a slot; it is not confirmed until the principal approves it. */
  | 'appointment-requested'
  /** The principal approved a request — this is the one that means "you have an appointment". */
  | 'appointment-approved'
  /** A booking was declined before it was ever confirmed, or a confirmed one was cancelled. */
  | 'appointment-cancelled'
  /** The calendar section's own notes changed, with no appointment moving. */
  | 'calendar-updated';

export interface PatientNotification extends BaseRecord {
  readonly patientId: string;
  /** `<created_at>#<uuid>` — the sort-key suffix, unique because two events can share a millisecond. */
  readonly notificationId: string;
  readonly kind: PatientNotificationKind;
  /** The instant the notification is *about* (an appointment's `scheduledAt`), when it is about one. Never the time the row was written — that is `created_at`. */
  readonly subjectAt?: string;
  /** Who caused it, as a Cognito `sub`. An identifier, never a name. */
  readonly actorId: string;
  readonly read: boolean;
}
