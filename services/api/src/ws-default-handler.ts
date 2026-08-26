// TASK 4.1.1 step 1, made real at TASK 4.2.1, extended at TASK 4.2.2:
// `$default` is where every application-level WebSocket message this
// codebase sends actually arrives — `routeSelectionExpression` is
// `$request.body.action` (infra/src/data-stack.ts's default, unchanged),
// and no message this codebase ever sends carries an `action` field
// (every one uses `type` instead), so nothing ever matches a named route.
// This file is the dispatcher: it validates the message shape and hands a
// `'join'` message to `ws-join-handler.ts`, or an
// `offer`/`answer`/`ice-candidate`/`leave` message to
// `ws-relay-handler.ts`.
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { z } from 'zod';

import { handleJoinRequest, type JoinRequestEvent } from './ws-join-handler.js';
import { handleRelayMessage, type RelayRequestEvent } from './ws-relay-handler.js';

const JoinMessageSchema = z.object({
  type: z.literal('join'),
  appointmentId: z.string().min(1),
});

const RelayMessageSchema = z.object({
  type: z.enum(['offer', 'answer', 'ice-candidate', 'leave']),
  appointmentId: z.string().min(1),
  payload: z.unknown(),
});

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2 & JoinRequestEvent & RelayRequestEvent,
): Promise<APIGatewayProxyResultV2> => {
  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '');
  } catch {
    // Not JSON at all — nothing this codebase sends is ever malformed, so
    // this is either a stray client or a protocol error; there is no
    // message shape to answer meaningfully, so this drops silently
    // rather than guessing at a response format.
    return { statusCode: 200 };
  }

  const join = JoinMessageSchema.safeParse(body);
  if (join.success) {
    await handleJoinRequest(event, join.data.appointmentId);
    return { statusCode: 200 };
  }

  const relay = RelayMessageSchema.safeParse(body);
  if (relay.success) {
    await handleRelayMessage(event, relay.data);
    return { statusCode: 200 };
  }

  // Not a recognised message shape. Accepted and ignored, never a close:
  // a client sending a shape this deploy doesn't understand is not a
  // protocol violation worth tearing the connection down for.
  return { statusCode: 200 };
};
