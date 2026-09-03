// 2026-09-03: the join link, or the reason there isn't one.
//
// The owner: *"keep this join the call button active from the start of the
// appointment to the whole duration upto which this appointment has been
// booked - before this appointment time show to the patient that the
// appointment is yet to start in x days, y hours and z minutes and after
// the appointment slot time say 'expired'."*
//
// Shared by the patient's `NextAppointmentPanel` and the clinician's
// `ClinicianCalendar` rather than written twice. Both sides of a call face
// the same window and should not be able to disagree about it — and the
// clinician benefits from the same protection the request describes for
// the patient: a link that looks live and is refused on arrival is worse
// than no link, because by then they have already believed in it.
//
// The three phases here are the three `ws-join.ts` enforces, so what a
// person can press and what the server will accept agree by construction.
import { t } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Link } from '@ndn/ui';
import type { ReactNode } from 'react';

import { countdownUnits } from './countdown-units.js';
import { countdownUntil, formatCountdown, joinPhase } from './join-window.js';

export interface JoinCallCellAppointment {
  readonly patientId: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
}

export interface JoinCallCellProps {
  readonly appointment: JoinCallCellAppointment;
  readonly locale: Locale;
  readonly now: Date;
  readonly joinCallLabel: string;
}

/** `call.astro`'s own composite id (`ws-join.ts`'s `parseAppointmentId`). */
export function callHref(locale: Locale, appointment: JoinCallCellAppointment): string {
  const appointmentId = `${appointment.patientId}#${appointment.scheduledAt}`;
  return `/${locale}/account/call?appointmentId=${encodeURIComponent(appointmentId)}`;
}

export function JoinCallCell({
  appointment,
  locale,
  now,
  joinCallLabel,
}: JoinCallCellProps): ReactNode {
  const scheduledAt = new Date(appointment.scheduledAt);
  const phase = joinPhase(scheduledAt, appointment.durationMinutes, now);

  if (phase === 'open') {
    return <Link href={callHref(locale, appointment)}>{joinCallLabel}</Link>;
  }

  if (phase === 'expired') {
    return <span>{t('appointment.expired', undefined, locale)}</span>;
  }

  // `countdownUntil` can only be undefined once the start has passed, which
  // `joinPhase` has already ruled out — but it is the honest type, and a
  // fallback beats a non-null assertion on a clock-derived value.
  const countdown = countdownUntil(scheduledAt, now);
  if (!countdown) {
    return <Link href={callHref(locale, appointment)}>{joinCallLabel}</Link>;
  }
  return (
    <span>
      {t(
        'appointment.notStarted',
        { countdown: formatCountdown(countdown, countdownUnits(locale)) },
        locale,
      )}
    </span>
  );
}
