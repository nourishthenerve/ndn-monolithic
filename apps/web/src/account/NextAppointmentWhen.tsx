// 2026-09-10: the patient's next appointment, in the three zones the
// practice serves and with a live countdown beneath them.
//
// The owner: *"make datetime to be shown in India, UK and Middle East
// (Dubai) time and make it dynamic so that it's decreasing with each
// passing minute. Don't show seconds."*
//
// It sits in the lead panel above the calendar, rendered by
// `AssessmentForm`'s `renderReadOnly` for the derived `nextAppointmentAt`
// field — whose value is the UTC ISO instant the server computed. A
// component of its own rather than a branch of that render helper, and the
// reason is the countdown: a ticking clock is state, and only this small
// subtree should re-render on each tick. Folding it into the form would
// re-render the whole 40-field Patient Details placement every 30 seconds
// to move one number.
//
// Nothing here is new arithmetic — both halves already exist and are
// tested, and this is the third screen to reuse each:
//
//   * **The three zones and their formatting** are `workshopTimesFor`
//     (`workshops/workshop-date.ts`) — the same three regions, the same
//     `formatDateTimeInZone`, so an appointment and a workshop cannot come
//     to disagree about what "Middle East" means or which offset it carries
//     (`Asia/Dubai`, GMT+4, printed on the row). The labels are its own
//     catalogue strings too, for the same reason.
//   * **The countdown** is `countdownUntil` + `formatCountdown`
//     (`join-window.ts`), the same prose the join button shows — minute
//     granular, seconds never printed, and leading zero units dropped
//     ("Starts in 5 minutes", not "in 0 days, 0 hours and 5 minutes").
//     `useNow` ticks it every 30 seconds, comfortably inside the minute it
//     counts in; `countdownUntil` returns `undefined` once the start has
//     passed, which is the signal to stop showing a line rather than a zero
//     to render.
import { t } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import type { ReactNode } from 'react';

import { workshopTimesFor } from '../workshops/workshop-date.js';

import { countdownUnits } from './countdown-units.js';
import { countdownUntil, formatCountdown } from './join-window.js';
import { useNow } from './useNow.js';

/**
 * Hoisted to module scope so its identity is stable across renders — the
 * exact requirement `useNow.ts` documents at length: an inline
 * `() => new Date()` default would seed the ticking effect anew every render.
 */
const systemNow = (): Date => new Date();

export interface NextAppointmentWhenProps {
  /** The appointment instant, as the UTC ISO string the server stores. */
  readonly iso: string;
  readonly locale: Locale;
  /** Injectable for tests; must be a stable reference, for the reason above. */
  readonly now?: () => Date;
}

export function NextAppointmentWhen({
  iso,
  locale,
  now = systemNow,
}: NextAppointmentWhenProps): ReactNode {
  // Ticks; `now` itself does not — see `useNow.ts`.
  const current = useNow(now);
  const zones = workshopTimesFor(iso, locale);
  const countdown = countdownUntil(new Date(iso), current);

  return (
    <span className="ndn-appt-when">
      {zones.map((zone) => (
        <span className="ndn-appt-zone" key={zone.key}>
          <span className="ndn-appt-region">
            {t(`workshops.time.${zone.key}`, undefined, locale)}
          </span>{' '}
          {zone.text}
        </span>
      ))}
      {countdown && (
        <span className="ndn-appt-countdown">
          {t(
            'appointment.notStarted',
            { countdown: formatCountdown(countdown, countdownUnits(locale)) },
            locale,
          )}
        </span>
      )}
    </span>
  );
}
