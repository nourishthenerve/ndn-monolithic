// 2026-09-07: what the call page knows about the appointment it is for.
//
// **Why this file exists.** `call.astro` is reached with nothing but
// `?appointmentId=<patientId>#<scheduledAt>` (that page's own header
// explains why it cannot be a path segment), so until now the call screen
// knew *when* its appointment started and nothing else. That was enough
// for a countdown and not enough for anything the owner asked for next:
//
//   * *"Outside call window it should not let to have a join call button
//     (rather say it has expired or will start soon)."* Whether a slot is
//     over needs `durationMinutes`, which the id does not carry — so a
//     caller who opened a finished appointment by URL was taken through
//     a camera prompt and offered a join button, and only found out the
//     window had shut once the server refused them.
//   * *"Once the timelimit has reached the call should auto drop."* The
//     honest limit is the booked slot's own end, which needs the same
//     field.
//
// **And it replaces `VideoCall.tsx`'s own `resolveRole`, which had a bug.**
// That function asked `GET /clinicians/me/calendar` and read
// `response.ok ? 'clinician' : 'patient'` — so a 500, a 502 or a dropped
// connection silently labelled a clinician a patient. Both parties then
// believed they were the offerer, both sent an offer, and each rejected
// the other's: two people on "Connecting…" behind a black frame with
// nothing to explain it. Here, only a *definitive* refusal (401/403 — the
// answer `authz-matrix.ts` gives a patient asking a clinician route) means
// "patient"; anything else is retried, and a caller whose role cannot be
// established is told so rather than guessed at.
//
// Two probes, in the order that makes the first one dual-purpose:
// the clinician calendar answers "are you a clinician" and carries the
// appointment; if it refuses, the patient's own list answers the same two
// questions from the other side.
import { contentApiUrl } from '../site-config.js';

/** Which end of the call this browser is. Re-exported by `VideoCall.tsx`, which is where callers have always imported it from. */
export type CallRole = 'patient' | 'clinician';

/**
 * The fields of the appointment this screen actually decides anything
 * with. Deliberately not the whole `Appointment` shape: this module has no
 * business handing a call screen a patient's record, and the narrower type
 * is what keeps it that way.
 */
export interface CallAppointment {
  readonly scheduledAt: Date;
  readonly durationMinutes: number;
  /** `'scheduled'`, `'pending-approval'`, `'cancelled'`, … — read as a string because this is the API's own field and a new status must never crash a call. */
  readonly status: string;
}

export type CallContext =
  /**
   * The role is known. `appointment` is optional on purpose — a role
   * resolves from one HTTP status and is needed for the call to happen at
   * all, while the appointment's own row may be missing from the list for
   * reasons that must not stop a call: a clinician covering for a
   * colleague, a list window that does not reach it, a deploy where the
   * shape changed. Everything that needs `appointment` degrades to the
   * behaviour this screen had before it existed.
   */
  | { readonly kind: 'resolved'; readonly role: CallRole; readonly appointment?: CallAppointment }
  /** No usable identity — a `401` from the probe, i.e. a token this API will not accept. Distinct from `error`, which is this codebase failing rather than the caller. */
  | { readonly kind: 'forbidden' }
  /** Neither probe could be completed — a network failure or a 5xx, retried and still failing. Never quietly downgraded to a guessed role. */
  | { readonly kind: 'error' };

interface AppointmentListItem {
  readonly patientId?: string;
  readonly scheduledAt?: string;
  readonly durationMinutes?: number;
  readonly appointment_status?: string;
}

/**
 * How many times a probe is tried again, and **only** for the failures that
 * might be transient: a thrown `fetch` (no network) or a `5xx`. A `4xx` is
 * an answer — retrying a 403 twice more delays a call to learn nothing, and
 * retrying a 404 says the route is not there three times instead of once.
 * Small even so: a caller is watching, and a role this codebase cannot
 * resolve in three attempts is not one more attempt away.
 */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_MS = 750;

type ProbeOutcome =
  /** 200. The role question is answered by this alone; `items` is the bonus. */
  | { readonly kind: 'ok'; readonly items: readonly AppointmentListItem[] }
  /** 403 — `authz-matrix.ts`'s own denial. A real answer about who the caller is: they are definitively not a principal this route serves. */
  | { readonly kind: 'refused' }
  /** 401 — no usable identity at all, which is a different fact from "not this role". */
  | { readonly kind: 'unauthenticated' }
  /** Anything else, after every attempt: a 5xx, a timeout, a dropped connection. Says nothing about the caller, and is never read as if it did. */
  | { readonly kind: 'failed' };

/**
 * One list endpoint, tried up to `PROBE_ATTEMPTS` times, never throwing.
 *
 * A body that cannot be read is **not** a failed probe: the status alone is
 * what decides the role, and an unparseable body only costs this call the
 * optional appointment details. That ordering matters — treating a bad body
 * as a failure would turn a cosmetic API change into an unjoinable call.
 */
async function probe(
  url: string,
  accessToken: string,
  sleep: (ms: number) => Promise<void>,
): Promise<ProbeOutcome> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(PROBE_RETRY_MS);
    }
    let response: Response;
    try {
      response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    } catch {
      continue;
    }
    if (response.status === 401) {
      return { kind: 'unauthenticated' };
    }
    if (response.status === 403) {
      return { kind: 'refused' };
    }
    if (response.status >= 500) {
      continue;
    }
    if (!response.ok) {
      // A `4xx` that is neither 401 nor 403 — a 404 from a route that is
      // not deployed, a 400 from a query this build got wrong. Not a
      // statement about the caller, so it is `failed` and never read as
      // one, but it is a settled answer and there is nothing to retry.
      return { kind: 'failed' };
    }
    try {
      const payload = (await response.json()) as { items?: readonly AppointmentListItem[] };
      return { kind: 'ok', items: payload.items ?? [] };
    } catch {
      return { kind: 'ok', items: [] };
    }
  }
  return { kind: 'failed' };
}

/**
 * The appointment this call is for, out of a list of the caller's own.
 *
 * Matched on the parsed instant rather than on the raw string: the id on
 * the query string has been through `encodeURIComponent` and back, and
 * `2026-09-07T10:00:00.000Z` and `2026-09-07T10:00:00Z` are the same
 * appointment however unequal the strings are.
 */
export function findAppointment(
  items: readonly AppointmentListItem[],
  patientId: string,
  scheduledAt: Date,
): CallAppointment | undefined {
  for (const item of items) {
    if (item.patientId !== undefined && item.patientId !== patientId) {
      continue;
    }
    if (typeof item.scheduledAt !== 'string' || typeof item.durationMinutes !== 'number') {
      continue;
    }
    const itemAt = new Date(item.scheduledAt);
    if (Number.isNaN(itemAt.getTime()) || itemAt.getTime() !== scheduledAt.getTime()) {
      continue;
    }
    return {
      scheduledAt: itemAt,
      durationMinutes: item.durationMinutes,
      status: item.appointment_status ?? 'scheduled',
    };
  }
  return undefined;
}

/**
 * A window wide enough to contain the appointment and nothing wider.
 *
 * `resolveRole` used to ask for `[epoch, now + 24h)`, which answers the
 * role question but cannot see an appointment further out than tomorrow —
 * and this probe now needs the row itself.
 */
export function calendarWindow(scheduledAt: Date): { from: string; to: string } {
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(scheduledAt.getTime() - day).toISOString(),
    to: new Date(scheduledAt.getTime() + day).toISOString(),
  };
}

export interface ResolveCallContextOptions {
  readonly accessToken: string;
  readonly patientId: string;
  readonly scheduledAt: Date;
  /** Injectable for tests, so a retry costs no real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Never throws. Every failure is one of `CallContext`'s own outcomes — a call screen has no useful response to an exception and every branch here has a sentence a person can read. */
export async function resolveCallContext(options: ResolveCallContextOptions): Promise<CallContext> {
  const sleep = options.sleep ?? realSleep;
  const { from, to } = calendarWindow(options.scheduledAt);
  const clinician = await probe(
    `${contentApiUrl}/clinicians/me/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    options.accessToken,
    sleep,
  );
  if (clinician.kind === 'ok') {
    return {
      kind: 'resolved',
      role: 'clinician',
      appointment: findAppointment(clinician.items, options.patientId, options.scheduledAt),
    };
  }
  if (clinician.kind === 'unauthenticated') {
    return { kind: 'forbidden' };
  }
  if (clinician.kind === 'failed') {
    // **Deliberately not falling through to "patient".** A clinician whose
    // own calendar 500s is not a patient, and calling them one is the bug
    // this file's header describes: both parties then believe they are the
    // offerer and the call never negotiates. An honest error a caller can
    // retry beats a guess that silently breaks the call.
    return { kind: 'error' };
  }

  // 403 from the clinician route is a real answer, not a missing one: this
  // caller is not a clinician, so on this page they are the patient. The
  // role is settled **here**, before the second probe, and does not depend
  // on it — the patient's own list is asked only for `durationMinutes` and
  // the status, and a call must still be joinable when that request fails.
  // This is the asymmetry the old `resolveRole` got right by accident and
  // the one thing about it worth keeping.
  const patient = await probe(
    `${contentApiUrl}/patients/me/appointments`,
    options.accessToken,
    sleep,
  );
  return {
    kind: 'resolved',
    role: 'patient',
    appointment:
      patient.kind === 'ok'
        ? findAppointment(patient.items, options.patientId, options.scheduledAt)
        : undefined,
  };
}
