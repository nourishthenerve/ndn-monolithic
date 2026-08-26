// TASK 4.1.1 step 1, made real at TASK 4.2.1: `$default` is where every
// application-level WebSocket message this codebase sends actually
// arrives — `routeSelectionExpression` is `$request.body.action`
// (infra/src/data-stack.ts's default, unchanged), and no message this
// codebase ever sends carries an `action` field (every one uses `type`
// instead, this task's own interface line and TASK 4.2.2's both), so
// nothing ever matches a named route. This file is the dispatcher, not a
// stub any more: it validates the message shape and hands a `'join'`
// message to `ws-join-handler.ts`. TASK 4.2.2 adds the
// `offer`/`answer`/`ice-candidate`/`leave` branch alongside this one.
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { z } from 'zod';

import { handleJoinRequest, type JoinRequestEvent } from './ws-join-handler.js';

const JoinMessageSchema = z.object({
  type: z.literal('join'),
  appointmentId: z.string().min(1),
});

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2 & JoinRequestEvent,
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

  // Not a recognised message shape yet — TASK 4.2.2 adds the relay
  // branch here. Accepted and ignored, never a close: a client sending a
  // shape this deploy doesn't understand yet is not a protocol violation
  // worth tearing the connection down for.
  return { statusCode: 200 };
};
