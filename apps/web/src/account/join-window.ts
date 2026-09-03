// TASK 4.5.1: the join window's own pure logic, split out of
// `VideoCall.tsx` — the same reason `webrtc-signalling-client.ts` and
// `call-state-machine.ts` already live in their own files rather than
// inside it: a stateful, `RTCPeerConnection`-touching component has no
// jsdom/RTL pattern to render-test in this codebase, but the SDK-free
// arithmetic it depends on does. Kept in its own module, not merely
// exported from `VideoCall.tsx`, so testing it never pulls that
// component's own untested branches into a coverage count they were never
// meant to be part of.
//
// **2026-09-03: the window is the appointment itself.** The owner: *"keep
// this join the call button active from the start of the appointment to
// the whole duration upto which this appointment has been booked - before
// this appointment time show to the patient that the appointment is yet to
// start in x days, y hours and z minutes and after the appointment slot
// time say 'expired'."*
//
// It used to be a fixed window opening 10 minutes early and closing 30
// minutes after the *start*, ignoring `durationMinutes` entirely — so a
// 15-minute check-in stayed joinable long after it ended, and a 90-minute
// assessment locked both parties out at the halfway mark.

/**
 * The three states an appointment can be in, from the point of view of
 * someone looking at a join button.
 *
 * Deliberately a phase rather than a boolean: "you cannot join" is two
 * completely different facts — one is a wait and the other is over — and a
 * caller who only knows *that* they cannot join has to guess which
 * sentence to show.
 */
export type JoinPhase = 'before' | 'open' | 'expired';

/** Mirrors `ws-join.ts`'s own window. Not imported — `services/api` and `apps/web` are separate deployables — and not the boundary either: the server refuses a join outside its own window regardless of what this says. This decides what a person is *shown*. */
export function joinWindowClosesAt(scheduledAt: Date, durationMinutes: number): Date {
  return new Date(scheduledAt.getTime() + durationMinutes * 60_000);
}

export function joinPhase(scheduledAt: Date, durationMinutes: number, now: Date): JoinPhase {
  if (now.getTime() < scheduledAt.getTime()) {
    return 'before';
  }
  // `>=`, matching the server: the last millisecond of a booked slot is
  // past the end of it.
  if (now.getTime() >= joinWindowClosesAt(scheduledAt, durationMinutes).getTime()) {
    return 'expired';
  }
  return 'open';
}

/**
 * Whether a listed appointment is still worth showing a join control for:
 * it has not started yet, or it is happening right now.
 *
 * **This is the fix for the bug the owner reported.** *"When the item of
 * appointment arrived the 'join the call' button simply didnt appear for
 * both the patient as well as the clinician. The dashboard simply started
 * showing the next appointment item."*
 *
 * Both lists decided which appointment to show by asking whether
 * `scheduledAt` was still in the future. It stops being so at the exact
 * instant the join window opens, so each list dropped the appointment at
 * the precise moment the button was due to appear and moved on to the next
 * one. Neither the patient nor the clinician could ever reach the link,
 * and nothing about the screen explained why — the appointment simply was
 * not there any more.
 *
 * Takes the raw `scheduledAt` string rather than a `Date` because that is
 * what a list row carries, and an unparseable one has to be answerable:
 * it counts as **over**, the deny-by-default reading every other parse of
 * this field in this codebase takes. `joinPhase` alone could not give that
 * answer — `NaN` comparisons are all false, so a malformed row would fall
 * through to `'open'` and offer a link the server is certain to refuse.
 *
 * Mirrors `isAppointmentOver` in `@ndn/shared-types`, restated rather than
 * imported for the reason `CaseloadView.tsx`'s own note gives: `apps/web`
 * deliberately does not depend on that package.
 */
export function isLiveOrUpcoming(
  scheduledAt: string,
  durationMinutes: number,
  now: Date,
): boolean {
  const start = new Date(scheduledAt);
  if (Number.isNaN(start.getTime())) {
    return false;
  }
  return joinPhase(start, durationMinutes, now) !== 'expired';
}

/** `<patientId>#<scheduledAt>` — mirrors `ws-join.ts`'s own `parseAppointmentId`, needing only the second half here. `undefined` for anything that doesn't parse to a real date, the same deny-by-default reading a malformed id gets everywhere else this shape is parsed. */
export function parseScheduledAt(appointmentId: string): Date | undefined {
  const separator = appointmentId.indexOf('#');
  if (separator <= 0 || separator === appointmentId.length - 1) {
    return undefined;
  }
  const scheduledAt = new Date(appointmentId.slice(separator + 1));
  return Number.isNaN(scheduledAt.getTime()) ? undefined : scheduledAt;
}

export interface Countdown {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

/**
 * How long until an appointment starts, split into days/hours/minutes —
 * *"the appointment is yet to start in x days, y hours and z minutes"*.
 *
 * `undefined` once the start has passed, which is a caller's signal to
 * stop counting rather than a zero to render.
 *
 * Minutes round **up**, and the whole countdown is floored at one minute,
 * so nobody is ever told "in 0 minutes" while they are still waiting. The
 * rounding is applied to the total before splitting, not to the minutes
 * component afterwards — otherwise 1h 59m 30s rounds to "1 hour and 60
 * minutes".
 */
export function countdownUntil(scheduledAt: Date, now: Date): Countdown | undefined {
  const remainingMs = scheduledAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return undefined;
  }
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return {
    days: Math.floor(totalMinutes / (24 * 60)),
    hours: Math.floor((totalMinutes % (24 * 60)) / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * The countdown as a phrase, with the leading zero units dropped.
 *
 * "in 0 days, 0 hours and 5 minutes" is worse than "in 5 minutes" for the
 * case that matters most — the last few minutes before a call, when the
 * person reading it is about to act on it. Trailing zeros are kept
 * (`2 days and 0 hours` never appears, but `2 days` does), because a unit
 * is only dropped while nothing larger has been printed.
 *
 * Takes its unit words as arguments rather than reaching for `t()`:
 * this module is pure arithmetic and has no locale.
 */
export function formatCountdown(
  countdown: Countdown,
  units: {
    readonly day: string;
    readonly days: string;
    readonly hour: string;
    readonly hours: string;
    readonly minute: string;
    readonly minutes: string;
    /** Joins the final two parts — "and" in English. */
    readonly and: string;
  },
): string {
  const parts: string[] = [];
  if (countdown.days > 0) {
    parts.push(`${countdown.days} ${countdown.days === 1 ? units.day : units.days}`);
  }
  if (parts.length > 0 || countdown.hours > 0) {
    parts.push(`${countdown.hours} ${countdown.hours === 1 ? units.hour : units.hours}`);
  }
  parts.push(`${countdown.minutes} ${countdown.minutes === 1 ? units.minute : units.minutes}`);

  if (parts.length === 1) {
    return parts[0] as string;
  }
  const last = parts[parts.length - 1] as string;
  return `${parts.slice(0, -1).join(', ')} ${units.and} ${last}`;
}
