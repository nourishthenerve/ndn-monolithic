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
//
// **2026-09-07: this connection now survives losing its socket, and keeps
// the socket from being taken away in the first place.**
//
// Two separate faults, both fatal to a call, both fixed here:
//
//   1. **API Gateway closes a WebSocket after 10 minutes with no traffic
//      on it**, and that limit is a service quota — not a setting
//      `infra/src/data-stack.ts` can raise. A call's signalling goes quiet
//      the moment ICE completes: the media flows peer-to-peer and the
//      socket has nothing left to carry. So every working call was
//      guaranteed to have its socket shut at the ten-minute mark, and
//      `VideoCall.tsx` read that as the call ending. A 30-minute
//      appointment could not be held. `HEARTBEAT_INTERVAL_MS` below is
//      what keeps the socket in use; the server answers `pong`, which is
//      also how this file notices a socket that has died without saying so.
//   2. **A closed socket was the end of the call.** A laptop lid, a train
//      tunnel, a wifi hop, a browser suspending a background tab — every
//      one of them produced "The call has ended" with no way back. A
//      dropped socket is now a reconnect with backoff, re-sending `join`
//      on the new one (the server issues a fresh `connectionId` and
//      `recordCallJoin` retires the old row, which is exactly the
//      behaviour a reconnect needs), and the caller is told it is
//      reconnecting rather than told it is over.
//
// Reconnecting stops for good on the three outcomes where trying again
// cannot help: the caller closed the connection, the server denied the
// join (a denial is a decision about this appointment, not a glitch), or
// this connection has been superseded by a newer one for the same
// principal (`not-on-call`) — which is also what stops two tabs of the
// same call from fighting each other for the `CALL#` row for ever.
import { z } from 'zod';

export type JoinDenialReason =
  | 'too-early'
  | 'too-late'
  | 'cancelled'
  /** 2026-09-01: a booking still waiting on the principal clinician's approval — see `ws-join.ts`'s own note on why this is not `'cancelled'`. */
  | 'not-confirmed'
  | 'not-your-appointment'
  | 'not-available';

/**
 * 2026-09-04: `'ready'` joins the four — this browser's half of the type
 * `services/api/src/ws-relay.ts` now relays. It carries one party saying
 * "I am on this call, offer to me", which is how the offerer learns about
 * a peer who joined after it did.
 *
 * 2026-09-07: `'ping'` joins them, and is the one type that is never
 * relayed — `ws-default-handler.ts` answers it directly. See this file's
 * own header for the ten-minute quota it exists to defeat.
 */
export type RelayMessageType = 'offer' | 'answer' | 'ice-candidate' | 'leave' | 'ready' | 'ping';

const relayMessageSchema = z.object({
  type: z.enum(['offer', 'answer', 'ice-candidate', 'leave', 'ready']),
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
  /** The server's answer to a `ping`. Proof the socket is alive in both directions, which a client-side send alone is not. */
  z.object({ type: z.literal('pong') }),
  /**
   * 2026-09-07: this connection is no longer one of the call's
   * participants — its `CALL#` row was retired, which happens when the
   * same principal joins again from a newer connection (a reload, a second
   * tab). Terminal by design: without it, a superseded tab reconnects for
   * ever and each reconnect retires the other tab's row in turn, so
   * neither can hold a call.
   */
  z.object({ type: z.literal('not-on-call') }),
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

/**
 * Comfortably inside API Gateway's own 10-minute idle-connection quota,
 * and far enough from it that one lost heartbeat cannot cost the socket:
 * two whole intervals fit in the margin.
 */
export const HEARTBEAT_INTERVAL_MS = 240_000;

/**
 * How long a `ping` may go unanswered before this file stops believing the
 * socket. A `WebSocket` whose network has gone can sit in `OPEN` for
 * minutes — TCP has no reason to notice — so `readyState` is not evidence
 * of anything. An unanswered heartbeat is, and closing the socket ourselves
 * is what puts the reconnect path below in charge instead of leaving the
 * caller on a connection that will never carry another message.
 */
export const HEARTBEAT_TIMEOUT_MS = 20_000;

/** Backoff for reconnecting: quick at first, because most drops are a blip, then capped so a long outage costs a handful of attempts a minute rather than a storm. */
export const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000] as const;

/**
 * When reconnecting gives up and the caller is told the connection is gone.
 * Generous on purpose: the deadline that really ends a call is the
 * appointment's own window (`VideoCall.tsx`), and this only needs to be
 * long enough to cover the outages people actually have — a tunnel, a
 * hotel wifi re-auth, a laptop waking up.
 */
export const MAX_RECONNECT_ATTEMPTS = 40;

export interface SignallingConnectionHandlers {
  /** Fires on the first successful join **and on every re-join after a reconnect** — a caller must therefore treat it as "the socket is usable again", not as "the call is starting". */
  readonly onJoined: () => void;
  readonly onJoinDenied: (reason: JoinDenialReason) => void;
  readonly onPeerUnavailable: () => void;
  readonly onRelayMessage: (message: RelayMessage) => void;
  /** 2026-09-07: the socket dropped and another attempt is scheduled. Not the end of the call — `onClose` is. */
  readonly onReconnecting?: (attempt: number) => void;
  /** 2026-09-07: this connection is superseded and will not come back. See `not-on-call` above. */
  readonly onSuperseded?: () => void;
  /**
   * No further attempts will be made: the join was denied, the attempts ran
   * out, or the caller closed it.
   *
   * `everOpened` separates two failures a caller has to describe very
   * differently — a call that was under way and lost its connection, and a
   * call whose socket never opened at all (a misconfigured URL, a network
   * that was down from the start). Both are "no connection"; only one of
   * them is "you were on a call".
   */
  readonly onClose: (everOpened: boolean) => void;
}

export interface OutgoingRelayMessage {
  readonly type: RelayMessageType;
  readonly appointmentId: string;
  readonly payload: unknown;
}

export interface SignallingConnection {
  /** Silently dropped if no socket is currently open — a caller re-announces itself on `onJoined` anyway, so a message sent into a gap is never the only copy of anything that matters. */
  send(message: OutgoingRelayMessage): void;
  close(): void;
  /** Whether a socket is open right now. Lets a caller distinguish "sent" from "swallowed" where it matters. */
  isOpen(): boolean;
}

export interface ConnectSignallingOptions {
  readonly url: string;
  /** The token the *first* socket opens with — the caller already holds one, so this attempt stays synchronous and a caller can drive it in a test without awaiting anything. */
  readonly token: string;
  /**
   * 2026-09-07: where a *reconnect* gets its token. A reconnect can happen
   * half an hour into a call, by which time the token that opened the first
   * socket may well have expired — `$connect`'s authorizer would refuse it
   * and every further attempt would fail for the rest of the appointment.
   * `SessionClient.authorization` is exactly this shape and refreshes on
   * demand. Optional: with no refresher, a reconnect reuses `token`, which
   * is still right for the short outages that make up most of them.
   */
  readonly refreshToken?: () => Promise<string | undefined>;
  readonly appointmentId: string;
  readonly handlers: SignallingConnectionHandlers;
  /** Injectable for tests; defaults to the browser's own `WebSocket`. */
  readonly WebSocketImpl?: typeof WebSocket;
}

/**
 * Opens the connection and sends `{ type: 'join', appointmentId }` the
 * moment it is open — TASK 4.1.1's own constraint (a browser `WebSocket`
 * cannot set an `Authorization` header on the handshake) is why the token
 * rides as `?token=` on the URL instead, unchanged here.
 */
export function connectSignalling(options: ConnectSignallingOptions): SignallingConnection {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;

  let socket: WebSocket | undefined;
  /** Set by `close()`, by a join denial, and by `not-on-call` — the three outcomes no further attempt can improve on. */
  let retired = false;
  let everOpened = false;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (heartbeatDeadline !== undefined) {
      clearTimeout(heartbeatDeadline);
      heartbeatDeadline = undefined;
    }
  }

  /** Closes the socket from this side so the `close` listener runs the reconnect path — never calls the reconnect directly, so there is exactly one route back and it cannot run twice. */
  function abandonSocket(): void {
    clearHeartbeat();
    try {
      socket?.close();
    } catch {
      // A socket that throws on close is already unusable, which is the
      // state this function exists to get out of.
    }
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) {
        return;
      }
      socket.send(
        JSON.stringify({ type: 'ping', appointmentId: options.appointmentId, payload: {} }),
      );
      if (heartbeatDeadline === undefined) {
        heartbeatDeadline = setTimeout(abandonSocket, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleReconnect(): void {
    if (retired || reconnectTimer !== undefined) {
      return;
    }
    if (attempts >= MAX_RECONNECT_ATTEMPTS) {
      retired = true;
      options.handlers.onClose(everOpened);
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)] ?? 15_000;
    attempts += 1;
    options.handlers.onReconnecting?.(attempts);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void reopen();
    }, delay);
  }

  /** A reconnect, which unlike the first attempt has to find a token before it can open anything. */
  async function reopen(): Promise<void> {
    if (retired) {
      return;
    }
    let token: string | undefined = options.token;
    if (options.refreshToken) {
      try {
        token = await options.refreshToken();
      } catch {
        token = undefined;
      }
    }
    if (retired) {
      return;
    }
    if (!token) {
      // No credential to open with. Not terminal: a refresh that failed
      // once may well work in four seconds, and giving up here would end a
      // call over one unlucky token request.
      scheduleReconnect();
      return;
    }
    open(token);
  }

  function open(token: string): void {
    if (retired) {
      return;
    }
    let created: WebSocket;
    try {
      created = new WebSocketImpl(`${options.url}?token=${encodeURIComponent(token)}`);
    } catch {
      // **Terminal, unlike every other failure here.** A `WebSocket`
      // constructor throws for a malformed or disallowed URL — a
      // misconfigured `signallingWebSocketUrl`, a blocked port — and none
      // of those get better on the fortieth attempt. Retrying would spend
      // several minutes to arrive at the same place, having told the caller
      // "reconnecting" the whole time.
      retired = true;
      options.handlers.onClose(everOpened);
      return;
    }
    socket = created;

    created.addEventListener('open', () => {
      if (retired || socket !== created) {
        return;
      }
      // Reset here rather than on `joined`: the backoff is about reaching
      // the service, and a socket that opened has reached it. A join that
      // is then denied retires this connection outright, so a reset can
      // never mask one.
      attempts = 0;
      everOpened = true;
      created.send(JSON.stringify({ type: 'join', appointmentId: options.appointmentId }));
      startHeartbeat();
    });

    created.addEventListener('message', (event) => {
      if (socket !== created) {
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(String((event as MessageEvent).data));
      } catch {
        return;
      }
      const message = parseIncomingMessage(raw);
      if (!message) {
        return;
      }
      // Any message at all proves the socket is carrying traffic, so an
      // outstanding heartbeat deadline has been answered — a `pong` is
      // simply the cheapest thing the server can send when nothing else is
      // happening.
      if (heartbeatDeadline !== undefined) {
        clearTimeout(heartbeatDeadline);
        heartbeatDeadline = undefined;
      }
      if (message.type === 'pong') {
        return;
      }
      if (message.type === 'joined') {
        options.handlers.onJoined();
      } else if (message.type === 'join-denied') {
        // A denial is a decision about this appointment — the window, the
        // status, who the caller is. Reconnecting cannot change any of
        // them, and hammering the join with a fresh socket every few
        // seconds would only produce a stream of `join-denied` audit rows.
        retire();
        options.handlers.onJoinDenied(message.reason);
      } else if (message.type === 'peer-unavailable') {
        options.handlers.onPeerUnavailable();
      } else if (message.type === 'not-on-call') {
        retire();
        options.handlers.onSuperseded?.();
      } else {
        options.handlers.onRelayMessage(message);
      }
    });

    created.addEventListener('close', () => {
      if (socket !== created) {
        return;
      }
      clearHeartbeat();
      socket = undefined;
      if (retired) {
        options.handlers.onClose(everOpened);
        return;
      }
      scheduleReconnect();
    });

    created.addEventListener('error', () => {
      // Nothing to do here that `close` does not already do — a
      // `WebSocket` always follows `error` with `close`. Registered only so
      // an error event is never an unhandled one.
    });
  }

  /**
   * A laptop waking up, or a train leaving a tunnel, fires this long before
   * the next backoff delay would have elapsed. Retrying on it turns a
   * two-minute wait into an immediate one, which is the difference between
   * a call that comes back and a caller who has already given up.
   */
  const onOnline = (): void => {
    if (retired || socket !== undefined || reconnectTimer === undefined) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    void reopen();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
  }

  /** The three outcomes no further attempt can improve on: nothing is retried and nothing is listened for again. */
  function retire(): void {
    retired = true;
    clearHeartbeat();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
    }
  }

  open(options.token);

  return {
    send(message) {
      if (socket && socket.readyState === WebSocketImpl.OPEN) {
        socket.send(JSON.stringify(message));
      }
    },
    isOpen() {
      return socket !== undefined && socket.readyState === WebSocketImpl.OPEN;
    },
    close() {
      if (retired && socket === undefined) {
        // Already finished — a join denial, a supersede, or a second
        // `close()`. `onClose` is reported exactly once for the life of
        // this connection.
        return;
      }
      retired = true;
      clearHeartbeat();
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
      }
      const closing = socket;
      // Cleared first, so the socket's own `close` event finds itself
      // superseded and stays silent — this is the one report.
      socket = undefined;
      closing?.close();
      options.handlers.onClose(everOpened);
    },
  };
}
