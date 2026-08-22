// TASK 2.3.1: renders a notification template through `@ndn/i18n`'s own
// `t()` — the same catalogue lookup packages/ui's components use — so a
// notification is translatable the day a second locale exists (D-04) and
// no notification string is ever a literal in this file or in
// notifications.ts.
import {
  defaultLocale,
  NOTIFICATION_TEMPLATES,
  t,
  type Locale,
  type NotificationTemplateDef,
  type NotificationTemplateId,
} from '@ndn/i18n';

export interface RenderedNotification {
  readonly subject: string;
  readonly emailBody: string;
  /** Present only when the template is `smsEligible`. */
  readonly smsBody?: string;
}

export function templateDef(id: NotificationTemplateId): NotificationTemplateDef {
  return NOTIFICATION_TEMPLATES[id];
}

export function renderNotification(
  id: NotificationTemplateId,
  vars: Readonly<Record<string, string>>,
  locale: Locale = defaultLocale,
): RenderedNotification {
  const def = templateDef(id);
  return {
    subject: t(def.subjectKey, vars, locale),
    emailBody: t(def.emailBodyKey, vars, locale),
    smsBody: def.smsBodyKey ? t(def.smsBodyKey, vars, locale) : undefined,
  };
}
