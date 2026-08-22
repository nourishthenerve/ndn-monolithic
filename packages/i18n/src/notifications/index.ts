// TASK 2.3.1: the notification template registry — every notification the
// platform can send, declared once, so services/api/src/notifications.ts
// (the `Notifier`) can decide a message's channel and category from its id
// alone, rather than trusting a caller to say. Content lives in the locale
// catalogues (../locales/en.json) under the keys named below, so a
// notification is translatable the day a second locale exists (D-04) —
// this registry never carries a string itself, only which keys render it
// and whether SMS is allowed.
export type NotificationCategory = 'clinical' | 'marketing';

export type NotificationTemplateId = 'appointmentReminder1Hour' | 'marketingNewsletter';

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
};

export const NOTIFICATION_TEMPLATE_IDS = Object.keys(
  NOTIFICATION_TEMPLATES,
) as readonly NotificationTemplateId[];
