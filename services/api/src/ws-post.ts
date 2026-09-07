// 2026-09-07: the one way this service says anything back down a
// WebSocket, extracted because a third caller arrived.
//
// `$default`'s Lambda proxy return value is not delivered to the client —
// unlike $connect/$disconnect, where the return value *is* the handshake
// response — so `PostToConnectionCommand`, addressed by `connectionId`, is
// the only route back. `ws-join-handler.ts` and `ws-relay-handler.ts` each
// had a private copy of this function with the identical body and the
// identical comment; `ws-default-handler.ts`'s heartbeat reply would have
// been a third.
//
// **Failure is never propagated, and that is the whole contract.** The
// caller's own socket may already be gone by the time this runs — a
// denial and a disconnect racing each other, a heartbeat answering a
// browser that has just been closed — and there is nothing actionable to
// do about it and no second caller to report it to. Identifiers only,
// never the payload: an SDP body can carry network-topology information
// about a caller's device, which `00-conventions.md`'s "identifiers only"
// discipline keeps out of logs.
import {
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from '@aws-sdk/client-apigatewaymanagementapi';

/** Every shape this service ever pushes to a client. Narrow on purpose: a new one should be a deliberate edit here, not a `Record<string, unknown>` anything can be poured into. */
export type OutboundMessage =
  | { readonly type: 'joined' }
  | { readonly type: 'join-denied'; readonly reason: string }
  | { readonly type: 'peer-unavailable' }
  | { readonly type: 'pong' }
  | { readonly type: 'not-on-call' };

/** Resolves whether the message was delivered, and never rejects. */
export async function postToConnection(
  management: ApiGatewayManagementApiClient,
  connectionId: string,
  payload: OutboundMessage,
): Promise<boolean> {
  try {
    await management.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
    return true;
  } catch {
    process.stdout.write(
      JSON.stringify({ route: '$default', type: payload.type, connectionId, posted: false }) + '\n',
    );
    return false;
  }
}
