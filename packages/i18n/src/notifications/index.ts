// TASK 2.3.1: the notification template registry — every notification the
// platform can send, declared once, so services/api/src/notifications.ts
// (the `Notifier`) can decide a message's channel and category from its id
// alone, rather than trusting a caller to say. Content lives in the locale
// catalogues (../locales/en.json) under the keys named below, so a
// notification is translatable the day a second locale exists (D-04) —
// this registry never carries a string itself, only which keys render it
// and whether SMS is allowed.
// TASK 2.4.1: 'clinical' is really "never silenced by marketingOptIn" —
// broader than clinical content specifically. `clinicianDeactivated` is an
// operational notice to a clinician, not a patient, and carries no clinical
// content either; it belongs here on that same "never silenced" property,
// not because it is clinical.
export type NotificationCategory = 'clinical' | 'marketing';

export type NotificationTemplateId =
  | 'appointmentReminder1Hour'
  | 'marketingNewsletter'
  | 'clinicianDeactivated'
  | 'patientApproved'
  | 'patientDeclined'
  | 'patientReassigned'
  | 'clinicianCaseloadPatientAdded'
  | 'clinicianCaseloadPatientRemoved';

export interface NotificationTemplateDef {
  readonly id: NotificationTemplateId;
  readonly category: NotificationCategory;
  /**
   * D-10 / R-01: SMS is the exception, not the default. `true` for exactly
   * one template today — the 1-hour appointment reminder. Marking a second
   * template eligible means re-doing R-01's arithmetic in the PR
   * (00-conventions.md's cost-delta requirement), not just flipping this.
   */
  readonly smsEligible: boolean;
  readonly subjectKey: string;
  readonly emailBodyKey: string;
  /** Present only when `smsEligible` — there is nothing for it to render otherwise. */
  readonly smsBodyKey?: string;
}

export const NOTIFICATION_TEMPLATES: Readonly<Record<NotificationTemplateId, NotificationTemplateDef>> = {
  appointmentReminder1Hour: {
    id: 'appointmentReminder1Hour',
    category: 'clinical',
    smsEligible: true,
    subjectKey: 'notifications.appointmentReminder1Hour.subject',
    emailBodyKey: 'notifications.appointmentReminder1Hour.emailBody',
    smsBodyKey: 'notifications.appointmentReminder1Hour.smsBody',
  },
  marketingNewsletter: {
    id: 'marketingNewsletter',
    category: 'marketing',
    smsEligible: false,
    subjectKey: 'notifications.marketingNewsletter.subject',
    emailBodyKey: 'notifications.marketingNewsletter.emailBody',
  },
  clinicianDeactivated: {
    id: 'clinicianDeactivated',
    category: 'clinical',
    smsEligible: false,
    subjectKey: 'notifications.clinicianDeactivated.subject',
    emailBodyKey: 'notifications.clinicianDeactivated.emailBody',
  },
  // TASK 2.5.1: content-free by the task's own step 6 — no diagnosis, no
  // referral, no clinician name. ses-registration.ts's own reasoning
  // applies again: this address may not be a mailbox the patient alone
  // reads.
  patientApproved: {
    id: 'patientApproved',
    category: 'clinical',
    smsEligible: false,
    subjectKey: 'notifications.patientApproved.subject',
    emailBodyKey: 'notifications.patientApproved.emailBody',
  },
  patientDeclined: {
    id: 'patientDeclined',
    category: 'clinical',
    smsEligible: false,
    subjectKey: 'notifications.patientDeclined.subject',
    emailBodyKey: 'notifications.patientDeclined.emailBody',
  },
  // TASK 2.5.2: content-free the same way — no outgoing/incoming
  // clinician's name in the patient's own copy either. Sent to the
  // patient; the two clinician-facing templates below are separate.
  patientReassigned: {
    id: 'patientReassigned',
    category: 'clinical',
    smsEligible: false,
    subjectKey: 'notifications.patientReassigned.subject',
    emailBodyKey: 'notifications.patientReassigned.emailBody',
  },
  clinicianCaseloadPatientAdded: {
    id: 'clinicianCaseloadPatientAdded',
    category: 'clinical',
    smsEligible: false,
    subjectKey: 'notifications.clinicianCaseloadPatientAdded.subject',
    emailBodyKey: 'notifications.clinicianCaseloadPatientAdded.emailBody',
  },
  clinicianCaseloadPatientRemoved: {
    id: 'clinicianCaseloadPatientRemoved',
    category: 'clinical',
    smsEligible: false,
    subjectKey: 'notifications.clinicianCaseloadPatientRemoved.subject',
    emailBodyKey: 'notifications.clinicianCaseloadPatientRemoved.emailBody',
  },
};

export const NOTIFICATION_TEMPLATE_IDS = Object.keys(
  NOTIFICATION_TEMPLATES,
) as readonly NotificationTemplateId[];
