// TASK 4.4.1 (D-12, R-03, FR-VID-04): the second half of D-12's own
// "P2P first, Cloudflare TURN fallback" order — TASK 4.3.3 built the
// generic retry/terminal state machine with no TURN in it; this is what
// TURN adds. `POST /calls/{appointmentId}/turn-credentials` — SDK-free
// and unit-testable, same split every other endpoint in this codebase
// uses; `turn-credentials-handler.ts` wires the real DynamoDB-backed
// repositories and the real SSM-sourced API token together.
//
// Gated by `can()`'s own `'join-call'` decision — the exact primitive
// TASK 4.2.1 built, called here rather than re-implemented — plus one
// check `can()` cannot express: the caller must hold a live, unexpired
// `CALL#<appointmentId>` row, proof they actually joined this call over
// the WebSocket at some point, not merely that the matrix would allow
// them to. Neither check re-derives the appointment's own status/window:
// a live `CALL#` row could only exist because `ws-join.ts`'s own
// scheduled/window checks already passed at join time, and re-checking
// them here would be the same "two independent authorisation paths for
// one decision, a way for them to drift" TASK 4.2.2's own relay already
// declined for a different pair of checks.
//
// The credential itself is never logged — `error`/`route`/`statusCode`
// only, the same "identifiers only" discipline `ws-relay.ts` already
// applies to a relayed SDP/ICE payload, extended here to a value that
// would let anyone holding it relay media through Cloudflare's network.
//
// TASK 4.4.2 (R-03): the concurrent-relay cap, which is this risk's own
// kill switch rather than a fourth new code path — a caller refused here
// falls straight into TASK 4.3.3's existing terminal/STUN-only path, the
// identical "a denial is just another 'no TURN this time' outcome"
// `VideoCall.tsx`'s own `fetchTurnIceServer` already treats every other
// denial reason as. The cap is per call, not global: relaying *both*
// directions of one call through TURN is the worst-case doubling this
// task's own counter exists to prevent, read from the exact `CALL#`
// partition rows this file already fetches for the live-join check
// above, filtered to a `turnActive` flag this file's own issuance step
// sets (never cleared — the conservative direction to err in, the same
// "no destructive primitives" discipline this row's own TTL reclaim
// already relies on).
import type { Appointment, Principal } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';
import { z } from 'zod';

import { APPOINTMENT_ENTITY_TYPE } from './appointment-repository.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagName, FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { Unprojected } from './projection.js';
import { requirePrincipal } from './request-principal.js';

const TURN_FLAG: FlagName = 'video.turn.enabled';

// A short-lived, per-retry-attempt grant — long enough for one ICE
// gathering/connection attempt, never a standing credential a caller
// could keep reusing after the retry it was minted for.
export const TURN_CREDENTIAL_TTL_SECONDS = 300;

function credentialsUrl(keyId: string): string {
  return `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`;
}

/** Same minimal shape `turnstile.ts`'s own outbound-call seam uses — not imported from it, since that file is not one this task's own Files list touches. */
export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const cloudflareResponseSchema = z.object({
  iceServers: z.object({
    urls: z.union([z.string(), z.array(z.string())]),
    username: z.string(),
    credential: z.string(),
  }),
});

export interface IceServerCredential {
  readonly urls: readonly string[];
  readonly username: string;
  readonly credential: string;
}

export interface TurnAppointmentReader {
  get(patientId: string, scheduledAt: string): Promise<Unprojected<Appointment> | undefined>;
}

export interface TurnCallParticipant {
  readonly connectionId: string;
  readonly principalId: string;
  readonly ttl: number;
  readonly turnActive?: boolean;
  /** 2026-09-04: set on a row whose connection is known to be gone — see `connection-repository.ts`. Absent on a live row. */
  readonly leftAt?: string;
}

export interface TurnCallParticipantsReader {
  findCallParticipants(appointmentId: string): Promise<readonly TurnCallParticipant[]>;
  /** TASK 4.4.2: marks the issuing participant's own row, so a later request — theirs or the other party's — sees this call has already used one relay. */
  markTurnActive(appointmentId: string, connectionId: string): Promise<void>;
}

// R-03's own worst case is *both* parties relaying through TURN at once —
// this is what keeps one call's contribution to that worst case from
// doubling. Not tuned to a guess: a call that needs TURN for one party at
// all is already the network-constrained case D-12's own "P2P first"
// ordering exists to minimise, and a second, independent relay for the
// same call is the specific doubling R-03's mitigation list names.
export const MAX_CONCURRENT_TURN_RELAYS_PER_CALL = 1;

export interface TurnCredentialsDeps {
  readonly appointments: TurnAppointmentReader;
  readonly connections: TurnCallParticipantsReader;
  readonly flags: FlagReader;
  readonly keyId: string;
  /** Resolved lazily, per call, so a cold start never fails before the secret is needed — mirrors `contact-form-handler.ts`'s own `getTurnstileSecret`. */
  readonly getApiToken: () => Promise<string>;
  readonly clock?: Clock;
  readonly fetcher?: Fetcher;
  readonly logger?: RequestLogger;
}

/**
 * `<patientId>#<scheduledAt>` — mirrors `ws-join.ts`'s own
 * `parseAppointmentId`, not imported from it since that file is not one
 * this task's own Files list touches. Undefined for anything that does
 * not split into exactly two non-empty parts, which denies rather than
 * guesses at a malformed id.
 */
function parseAppointmentId(
  appointmentId: string,
): { patientId: string; scheduledAt: string } | undefined {
  const separator = appointmentId.indexOf('#');
  if (separator <= 0 || separator === appointmentId.length - 1) {
    return undefined;
  }
  return {
    patientId: appointmentId.slice(0, separator),
    scheduledAt: appointmentId.slice(separator + 1),
  };
}

const TURN_CREDENTIALS_LOG_SAMPLE_RATE = 1;

export function createTurnCredentialsHandler(
  deps: TurnCredentialsDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const fetcher = deps.fetcher ?? fetch;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: TURN_CREDENTIALS_LOG_SAMPLE_RATE });

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: Record<string, unknown>) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    if (!(await deps.flags.isEnabled(TURN_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }
    if (routeKey !== 'POST /calls/{appointmentId}/turn-credentials') {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const rawAppointmentId = event.pathParameters?.appointmentId;
    if (!rawAppointmentId) {
      return respond(400, { error: 'APPOINTMENT_ID_REQUIRED' });
    }

    const parsed = parseAppointmentId(rawAppointmentId);
    const appointment = parsed && (await deps.appointments.get(parsed.patientId, parsed.scheduledAt));
    // A malformed id and a real-but-unowned one both deny the same way —
    // cannot leak whether an appointment id exists, the identical
    // deny-by-default reading `ws-join.ts`'s own equivalent check keeps.
    const decision =
      appointment &&
      can(principal, 'join-call', {
        entityType: APPOINTMENT_ENTITY_TYPE,
        ownerPatientId: appointment.patientId,
        assignedClinicianId: appointment.clinicianId,
      });
    if (!decision || !decision.allowed) {
      return respond(403, { error: 'FORBIDDEN', reason: 'not-your-appointment' });
    }

    const participants = await deps.connections.findCallParticipants(rawAppointmentId);
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    // 2026-09-04: `leftAt` joins the `ttl` check, and it matters most for
    // the cap below rather than for the caller's own row. A retired row
    // that had once been issued a credential kept counting as an active
    // relay for the rest of its twelve-hour `ttl`, so one earlier attempt
    // at this appointment could refuse TURN to the other party for the
    // rest of the day — a call left to fail on a network that needed it.
    const live = participants.filter(
      (participant) => participant.leftAt === undefined && participant.ttl > nowSeconds,
    );
    const mine = live.find((participant) => participant.principalId === principal.subjectId);
    if (!mine) {
      return respond(403, { error: 'FORBIDDEN', reason: 'not-joined' });
    }

    // Only the *other* party's own active relay counts against this
    // caller's own request — re-issuing to the same caller (their prior
    // credential simply expired) is never capped by their own earlier row.
    const activeRelays = live.filter(
      (participant) => participant.turnActive && participant.principalId !== principal.subjectId,
    ).length;
    if (activeRelays >= MAX_CONCURRENT_TURN_RELAYS_PER_CALL) {
      return respond(403, { error: 'FORBIDDEN', reason: 'relay-capped' });
    }

    try {
      const apiToken = await deps.getApiToken();
      const response = await fetcher(credentialsUrl(deps.keyId), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      });
      if (!response.ok) {
        return respond(502, { error: 'PROVIDER_ERROR' });
      }
      const parsedResponse = cloudflareResponseSchema.safeParse(await response.json());
      if (!parsedResponse.success) {
        return respond(502, { error: 'PROVIDER_ERROR' });
      }
      const { urls, username, credential } = parsedResponse.data.iceServers;
      const iceServer: IceServerCredential = {
        urls: Array.isArray(urls) ? urls : [urls],
        username,
        credential,
      };
      await deps.connections.markTurnActive(rawAppointmentId, mine.connectionId);
      return respond(200, { iceServer });
    } catch {
      return respond(502, { error: 'PROVIDER_ERROR' });
    }
  };
}
