// TASK 3.4.3: the 1-hour reminder sweep — R-01's own mitigation register
// ends on "never silently drop a reminder," built as a property of the
// notification abstraction at TASK 2.3.1 and exercised for real for the
// first time here. `appointmentReminder1Hour` has been `smsEligible` in
// `packages/i18n/src/notifications/index.ts` since that task, unused
// until now.
//
// No HTTP route — invoked on an EventBridge schedule
// (`reminder-sweep-handler.ts`), so there is no principal, no `can()`
// call, and no `audit.ts` row: `notifications.ts`'s own `Notifier.send`
// already appends exactly one delivery record per attempt, on every
// branch, which is this flow's durable record instead.
//
// Two-step, deliberately: `listReminderCandidates` (GSI4, `docs/adr/0002-
// database.md`'s own proof) returns appointments the *read* already
// confirmed are scheduled and not yet reminded; `claimForReminder` is the
// atomic step that actually decides "does this invocation get to send
// it" — a benign `undefined` return (already claimed by an earlier or
// overlapping tick) is skipped, never retried, never an error. This
// ordering — claim, *then* attempt to send — is what makes "running the
// sweep twice against the same window sends exactly one SMS" true: the
// second run's claim fails before `notifier.send` is ever called.
import type { AppointmentRepository } from './appointment-repository.js';
import type { Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import type { Notifier } from './notifications.js';
import { notificationRecipientFor } from './patient-repository.js';
import type { PatientRepository } from './patient-repository.js';

const REMINDERS_FLAG = 'appointments.reminders.enabled';

// D-11 / this task's own step 3: the EventBridge rule fires every 15
// minutes, "comfortably inside the 1-hour window with margin for a
// missed tick." A window of exactly 60 minutes, re-queried from
// scratch every tick, would let one delayed or skipped invocation (a
// cold start, a transient AWS issue) push an appointment's reminder
// past its own start time before any tick ever saw it in range. 75
// minutes — one hour plus one tick's own margin — means an appointment
// stays a visible candidate across at least four consecutive ticks
// before its window closes, so a single missed tick can never be the
// difference between "reminded" and "never reminded."
const REMINDER_WINDOW_MS = 75 * 60 * 1000;

export interface ReminderSweepDeps {
  readonly appointments: AppointmentRepository;
  readonly patients: PatientRepository;
  readonly notifier: Notifier;
  readonly flags: FlagReader;
  readonly clock: Clock;
}

export interface ReminderSweepResult {
  /** How many candidates `listReminderCandidates` returned this tick. */
  readonly candidates: number;
  /** How many of those this tick actually claimed (and therefore attempted to send). */
  readonly claimed: number;
}

/** `{time}` var `notifications.appointmentReminder1Hour`'s own template keys need — a plain UK wall-clock string, not an ICU date/time placeholder (the catalogue entry treats `{time}` as an ordinary string substitution). */
function ukTimeOf(scheduledAt: string): string {
  return new Date(scheduledAt).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function runReminderSweep(deps: ReminderSweepDeps): Promise<ReminderSweepResult> {
  // D-11: scheduling (`appointments.enabled`) and reminding are two
  // separate capabilities — turning one on must never silently turn on
  // real spend. The EventBridge rule itself keeps firing regardless;
  // this flag is what the rollback plan flips off with no deploy.
  if (!(await deps.flags.isEnabled(REMINDERS_FLAG))) {
    return { candidates: 0, claimed: 0 };
  }

  const now = deps.clock.now();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS).toISOString();

  const candidates = await deps.appointments.listReminderCandidates(windowStart, windowEnd);

  let claimed = 0;
  for (const appointment of candidates) {
    const claim = await deps.appointments.claimForReminder(
      appointment.patientId,
      appointment.scheduledAt,
    );
    if (!claim) {
      continue;
    }
    claimed += 1;

    const patient = await deps.patients.findById(appointment.patientId);
    if (!patient) {
      // Not expected — an appointment names a real patientId by
      // construction (appointment.ts's own `can()` gate already required
      // the patient to exist before scheduling could ever happen) — but
      // the reminder is already claimed either way (R-01: a reminder
      // that could not be sent is a recorded fact, not silently retried
      // forever), and there is no recipient left to notify.
      continue;
    }

    await deps.notifier.send(notificationRecipientFor(patient), 'appointmentReminder1Hour', {
      time: ukTimeOf(appointment.scheduledAt),
    });
  }

  return { candidates: candidates.length, claimed };
}
