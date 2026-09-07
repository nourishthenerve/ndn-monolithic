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

/**
 * The other half of the same id — `<patientId>#<scheduledAt>`.
 *
 * 2026-09-05: the call page is reached with nothing but that id on the
 * query string, and the clinician's half of the call now needs to know
 * *whose* assessment to put beside the video. It has been in the id all
 * along; nothing had asked for it before.
 *
 * `undefined` for anything that does not split into two non-empty parts —
 * the same deny-by-default reading `parseScheduledAt` and `ws-join.ts`'s
 * own `parseAppointmentId` give a malformed id.
 */
export function parsePatientId(appointmentId: string): string | undefined {
  const separator = appointmentId.indexOf('#');
  if (separator <= 0 || separator === appointmentId.length - 1) {
    return undefined;
  }
  return appointmentId.slice(0, separator);
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

/**
 * **2026-09-07: when a call under way must stop, as one absolute instant
 * both parties can compute for themselves.**
 *
 * The owner: *"there should be a timer showing how much time is left
 * before the call auto gets dropped. Once the timelimit has reached the
 * call should auto drop."*
 *
 * Two limits, and the earlier of them wins:
 *
 *   1. **The booked slot's own end.** This is the honest one — the same
 *      instant `joinPhase` calls `'expired'` and the same instant
 *      `ws-join.ts` starts refusing joins. A call must not outlive the
 *      appointment it exists for, and a 15-minute check-in must not keep
 *      running for half an hour.
 *   2. **`maxCallMs` from the moment this side joined.** A backstop for a
 *      long booking, and the only limit available at all when the
 *      appointment's own duration could not be resolved.
 *
 * Derived from `scheduledAt` rather than from either party's own clock
 * reading of "when the call started", so both browsers arrive at the same
 * answer however far apart they joined — the previous behaviour (30
 * minutes from each side's own join) gave two people on one call two
 * different deadlines.
 */
export function callDeadline(
  joinedAt: Date,
  maxCallMs: number,
  appointment?: { readonly scheduledAt: Date; readonly durationMinutes: number },
): Date {
  const cap = joinedAt.getTime() + maxCallMs;
  if (!appointment) {
    return new Date(cap);
  }
  const windowEnd = joinWindowClosesAt(appointment.scheduledAt, appointment.durationMinutes).getTime();
  return new Date(Math.min(cap, windowEnd));
}

/**
 * `mm:ss`, or `h:mm:ss` once there is an hour to show — the shape a
 * countdown clock has everywhere else a person has met one, rather than
 * `formatCountdown`'s prose. Prose is right for "in 2 days and 3 hours"
 * on an appointment list; a call that ends in ninety seconds wants digits.
 *
 * Clamped at zero: a deadline that has passed reads `0:00`, never a
 * negative. Seconds round **up**, so the display only reaches `0:00` at
 * the actual deadline rather than a second early.
 */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
}

/**
 * The next instant at which `joinPhase` would answer differently — the
 * start of the slot while waiting for it, its end while inside it, and
 * `undefined` once it is over and nothing further will change.
 *
 * Exists because a ticking clock is the wrong tool for a boundary: the
 * countdown ticks every 15 seconds, so without this a caller could sit on
 * "the appointment has not started yet" for a quarter of a minute after it
 * had, and — worse — stay on a live call screen for up to 15 seconds after
 * the window shut. A caller schedules one timer for exactly this instant
 * and the transition happens on it.
 */
export function nextPhaseChangeAt(
  scheduledAt: Date,
  durationMinutes: number,
  now: Date,
): Date | undefined {
  if (now.getTime() < scheduledAt.getTime()) {
    return scheduledAt;
  }
  const closesAt = joinWindowClosesAt(scheduledAt, durationMinutes);
  return now.getTime() < closesAt.getTime() ? closesAt : undefined;
}
