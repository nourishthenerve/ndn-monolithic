// TASK 4.3.1: the SDK-free half of this task's own split — parsing and
// wire-shape decisions here, `VideoCall.tsx` is the only place a real
// `WebSocket` gets constructed. Mirrors `services/api/src/ws-join.ts` and
// `ws-relay.ts`'s own "business logic in one file, wiring in another"
// shape, and the message shapes themselves are this browser's side of the
// exact envelopes `services/api/src/ws-default-handler.ts` validates on
// the way in and `ws-relay-handler.ts` forwards on the way out — kept as
// a second, independent parse rather than a shared import, since
// `services/api` and `apps/web` are two separate deployables with no
// shared runtime package between them for this shape.
import { z } from 'zod';

export type JoinDenialReason =
  | 'too-early'
  | 'too-late'
  | 'cancelled'
  /** 2026-09-01: a booking still waiting on the principal clinician's approval — see `ws-join.ts`'s own note on why this is not `'cancelled'`. */
  | 'not-confirmed'
  | 'not-your-appointment'
  | 'not-available';

export type RelayMessageType = 'offer' | 'answer' | 'ice-candidate' | 'leave';

const relayMessageSchema = z.object({
  type: z.enum(['offer', 'answer', 'ice-candidate', 'leave']),
  appointmentId: z.string().min(1),
  payload: z.unknown(),
});

const incomingMessageSchema = z.union([
  z.object({ type: z.literal('joined') }),
  z.object({
    type: z.literal('join-denied'),
    reason: z.enum([
      'too-early',
      'too-late',
      'cancelled',
      'not-confirmed',
      'not-your-appointment',
      'not-available',
    ]),
  }),
  z.object({ type: z.literal('peer-unavailable') }),
  relayMessageSchema,
]);

export type RelayMessage = z.infer<typeof relayMessageSchema>;
export type IncomingSignallingMessage = z.infer<typeof incomingMessageSchema>;

/**
 * Rejects any envelope not matching one of this codebase's own known
 * shapes — returns `undefined` rather than throwing past the caller, the
 * same "not a recognised shape, dropped, never a crash" posture
 * `ws-default-handler.ts`'s own server-side twin already takes for a
 * message arriving in the opposite direction.
 */
export function parseIncomingMessage(raw: unknown): IncomingSignallingMessage | undefined {
  const parsed = incomingMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export interface SignallingConnectionHandlers {
  readonly onJoined: () => void;
  readonly onJoinDenied: (reason: JoinDenialReason) => void;
  readonly onPeerUnavailable: () => void;
  readonly onRelayMessage: (message: RelayMessage) => void;
  readonly onClose: () => void;
}

export interface OutgoingRelayMessage {
  readonly type: RelayMessageType;
  readonly appointmentId: string;
  readonly payload: unknown;
}

export interface SignallingConnection {
  send(message: OutgoingRelayMessage): void;
  close(): void;
}

export interface ConnectSignallingOptions {
  readonly url: string;
  readonly token: string;
  readonly appointmentId: string;
  readonly handlers: SignallingConnectionHandlers;
  /** Injectable for tests; defaults to the browser's own `WebSocket`. */
  readonly WebSocketImpl?: typeof WebSocket;
}

/**
 * Opens the connection and sends `{ type: 'join', appointmentId }` the
 * moment it is open — TASK 4.1.1's own constraint (a browser `WebSocket`
 * cannot set an `Authorization` header on the handshake) is why `token`
 * rides as `?token=` on the URL instead, unchanged here.
 */
export function connectSignalling(options: ConnectSignallingOptions): SignallingConnection {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const socket = new WebSocketImpl(`${options.url}?token=${encodeURIComponent(options.token)}`);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', appointmentId: options.appointmentId }));
  });

  socket.addEventListener('message', (event) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const message = parseIncomingMessage(raw);
    if (!message) {
      return;
    }
    if (message.type === 'joined') {
      options.handlers.onJoined();
    } else if (message.type === 'join-denied') {
      options.handlers.onJoinDenied(message.reason);
    } else if (message.type === 'peer-unavailable') {
      options.handlers.onPeerUnavailable();
    } else {
      options.handlers.onRelayMessage(message);
    }
  });

  socket.addEventListener('close', () => options.handlers.onClose());

  return {
    send(message) {
      if (socket.readyState === WebSocketImpl.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    close() {
      socket.close();
    },
  };
}
