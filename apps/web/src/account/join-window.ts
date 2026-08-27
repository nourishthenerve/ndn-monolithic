// TASK 4.5.1: the too-early countdown's own pure logic, split out of
// `VideoCall.tsx` — the same reason `webrtc-signalling-client.ts` and
// `call-state-machine.ts` already live in their own files rather than
// inside it: a stateful, `RTCPeerConnection`-touching component has no
// jsdom/RTL pattern to render-test in this codebase (every prior Phase 4
// frontend task's own Tests section names this gap honestly), but the
// SDK-free arithmetic it depends on does. Kept in its own module, not
// merely exported from `VideoCall.tsx`, so testing it never pulls that
// component's own untested branches into a coverage count they were never
// meant to be part of — importing a file, even only for one function,
// loads and instruments its whole module graph.

/** Mirrors `ws-join.ts`'s own `JOIN_WINDOW_OPENS_BEFORE_MINUTES` — not imported, since `services/api` and `apps/web` are two separate deployables. The server-side window check remains the real boundary; this is only what decides when `VideoCall.tsx` even attempts a join. */
export const JOIN_WINDOW_OPENS_BEFORE_MINUTES = 10;

/** `<patientId>#<scheduledAt>` — mirrors `ws-join.ts`'s own `parseAppointmentId`, needing only the second half here. `undefined` for anything that doesn't parse to a real date, the same deny-by-default reading a malformed id gets everywhere else this shape is parsed. */
export function parseScheduledAt(appointmentId: string): Date | undefined {
  const separator = appointmentId.indexOf('#');
  if (separator <= 0 || separator === appointmentId.length - 1) {
    return undefined;
  }
  const scheduledAt = new Date(appointmentId.slice(separator + 1));
  return Number.isNaN(scheduledAt.getTime()) ? undefined : scheduledAt;
}

export function joinWindowOpensAt(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() - JOIN_WINDOW_OPENS_BEFORE_MINUTES * 60_000);
}

/**
 * `undefined` once the window is already open — `VideoCall.tsx`'s own
 * signal to stop showing a countdown at all. Otherwise a whole number of
 * minutes, rounded up and floored at 1, so a caller is never shown "in 0
 * minutes" in the moments just before the window opens.
 */
export function minutesUntilJoinWindowOpens(opensAt: Date, now: Date): number | undefined {
  const remainingMs = opensAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return undefined;
  }
  return Math.max(1, Math.ceil(remainingMs / 60_000));
}
