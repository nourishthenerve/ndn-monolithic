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
  readonly principalId: string;
  readonly ttl: number;
}

export interface TurnCallParticipantsReader {
  findCallParticipants(appointmentId: string): Promise<readonly TurnCallParticipant[]>;
}

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
    const hasLiveJoin = participants.some(
      (participant) => participant.principalId === principal.subjectId && participant.ttl > nowSeconds,
    );
    if (!hasLiveJoin) {
      return respond(403, { error: 'FORBIDDEN', reason: 'not-joined' });
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
      return respond(200, { iceServer });
    } catch {
      return respond(502, { error: 'PROVIDER_ERROR' });
    }
  };
}
