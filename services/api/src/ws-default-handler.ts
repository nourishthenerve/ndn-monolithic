// TASK 4.1.1 step 1, made real at TASK 4.2.1, extended at TASK 4.2.2:
// `$default` is where every application-level WebSocket message this
// codebase sends actually arrives — `routeSelectionExpression` is
// `$request.body.action` (infra/src/data-stack.ts's default, unchanged),
// and no message this codebase ever sends carries an `action` field
// (every one uses `type` instead), so nothing ever matches a named route.
// This file is the dispatcher: it validates the message shape and hands a
// `'join'` message to `ws-join-handler.ts`, an
// `offer`/`answer`/`ice-candidate`/`leave`/`ready` message to
// `ws-relay-handler.ts`, or a `'ping'` straight back to its sender.
//
// **2026-09-07: `'ping'` exists because of a service quota, not a
// preference.** API Gateway closes a WebSocket that has carried no traffic
// for ten minutes, and that limit is not configurable — there is no
// `data-stack.ts` property to raise it. A connected video call's
// signalling goes completely silent the moment ICE finishes, because the
// media is peer-to-peer and the socket has nothing left to carry: so every
// call in this system was guaranteed to lose its socket at the ten-minute
// mark, and the browser read that as the call ending. A 30-minute
// appointment could not physically be held.
//
// The client heartbeats (`webrtc-signalling-client.ts`), which keeps the
// connection in use; this route answers, which is the only way that client
// can tell a live socket from one whose network has gone while
// `readyState` still says `OPEN`. Deliberately **not** relayed: a
// heartbeat is between one browser and the gateway, and forwarding it to
// the peer would double the traffic to say nothing.
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { z } from 'zod';

import { handleJoinRequest, type JoinRequestEvent } from './ws-join-handler.js';
import { managementApiClientFor } from './ws-management-client.js';
import { postToConnection } from './ws-post.js';
import { handleRelayMessage, type RelayRequestEvent } from './ws-relay-handler.js';

const JoinMessageSchema = z.object({
  type: z.literal('join'),
  appointmentId: z.string().min(1),
});

/** No `appointmentId` required and none read: a heartbeat is about the socket, not about a call. */
const PingMessageSchema = z.object({ type: z.literal('ping') });

// 2026-09-04: `'ready'` added — one party announcing they are on the call
// so the offerer knows to offer. See `ws-relay.ts`'s own note.
const RelayMessageSchema = z.object({
  type: z.enum(['offer', 'answer', 'ice-candidate', 'leave', 'ready']),
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

  // Checked first, and it is the cheapest branch on purpose: a heartbeat
  // arrives every few minutes for every open socket, and it must not cost
  // a DynamoDB read.
  const ping = PingMessageSchema.safeParse(body);
  if (ping.success) {
    const { connectionId, domainName, stage } = event.requestContext;
    await postToConnection(managementApiClientFor(domainName, stage), connectionId, {
      type: 'pong',
    });
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
