// @vitest-environment jsdom
//
// jsdom for `window`: the reconnect path listens for `online`, which is
// what turns a laptop waking up into an immediate retry instead of a
// two-minute wait. Everything else here is environment-free.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectSignalling,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  parseIncomingMessage,
  RECONNECT_DELAYS_MS,
} from './webrtc-signalling-client.js';

describe('parseIncomingMessage', () => {
  it('accepts a joined message', () => {
    expect(parseIncomingMessage({ type: 'joined' })).toEqual({ type: 'joined' });
  });

  it('accepts a join-denied message with a known reason', () => {
    expect(parseIncomingMessage({ type: 'join-denied', reason: 'too-early' })).toEqual({
      type: 'join-denied',
      reason: 'too-early',
    });
  });

  it('accepts a peer-unavailable message', () => {
    expect(parseIncomingMessage({ type: 'peer-unavailable' })).toEqual({ type: 'peer-unavailable' });
  });

  it('accepts an offer/answer/ice-candidate relay envelope', () => {
    const envelope = { type: 'offer', appointmentId: 'pat-1#2026-09-01T10:00:00.000Z', payload: { sdp: 'v=0' } };
    expect(parseIncomingMessage(envelope)).toEqual(envelope);
  });

  // 2026-09-04: the announcement that lets the offerer learn about a peer
  // who joined after it did, instead of discovering them by chance inside a
  // retry loop that gave up after 30 seconds. It must survive the parse on
  // both sides of the relay or the handshake silently never happens.
  it.each([['ready'], ['answer'], ['ice-candidate'], ['leave']])(
    'accepts a %s envelope',
    (type) => {
      const envelope = { type, appointmentId: 'pat-1#2026-09-01T10:00:00.000Z', payload: {} };
      expect(parseIncomingMessage(envelope)).toEqual(envelope);
    },
  );

  it('rejects a join-denied message with an unrecognised reason', () => {
    expect(parseIncomingMessage({ type: 'join-denied', reason: 'because' })).toBeUndefined();
  });

  it('rejects a relay envelope missing appointmentId', () => {
    expect(parseIncomingMessage({ type: 'offer', payload: {} })).toBeUndefined();
  });

  it('rejects a message with an unknown type rather than throwing', () => {
    expect(parseIncomingMessage({ type: 'hangup' })).toBeUndefined();
  });

  it('rejects a non-object payload rather than throwing', () => {
    expect(parseIncomingMessage('not an envelope')).toBeUndefined();
    expect(parseIncomingMessage(null)).toBeUndefined();
    expect(parseIncomingMessage(undefined)).toBeUndefined();
  });
});

/** A minimal fake standing in for the browser's own `WebSocket` — enough of its surface for `connectSignalling` to drive, none of the real networking. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }
}

describe('connectSignalling', () => {
  it('carries the token as a query-string parameter, per TASK 4.1.1', () => {
    let created: FakeWebSocket | undefined;
    const WebSocketImpl = function (url: string) {
      created = new FakeWebSocket(url);
      return created;
    } as unknown as typeof WebSocket;
    Object.assign(WebSocketImpl, { OPEN: FakeWebSocket.OPEN });

    connectSignalling({
      url: 'wss://example.test/$default',
      token: 'a token with spaces',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers: {
        onJoined: () => {},
        onJoinDenied: () => {},
        onPeerUnavailable: () => {},
        onRelayMessage: () => {},
        onClose: () => {},
      },
      WebSocketImpl,
    });

    expect(created?.url).toBe('wss://example.test/$default?token=a%20token%20with%20spaces');
  });

  it('sends the join message the moment the socket opens, not before', () => {
    let created: FakeWebSocket | undefined;
    const WebSocketImpl = function (url: string) {
      created = new FakeWebSocket(url);
      return created;
    } as unknown as typeof WebSocket;
    Object.assign(WebSocketImpl, { OPEN: FakeWebSocket.OPEN });

    connectSignalling({
      url: 'wss://example.test/$default',
      token: 'tok',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers: {
        onJoined: () => {},
        onJoinDenied: () => {},
        onPeerUnavailable: () => {},
        onRelayMessage: () => {},
        onClose: () => {},
      },
      WebSocketImpl,
    });

    expect(created?.sent).toEqual([]);
    created?.open();
    expect(created?.sent).toEqual([
      JSON.stringify({ type: 'join', appointmentId: 'pat-1#2026-09-01T10:00:00.000Z' }),
    ]);
  });

  it('routes each known message shape to its own handler', () => {
    let created: FakeWebSocket | undefined;
    const WebSocketImpl = function (url: string) {
      created = new FakeWebSocket(url);
      return created;
    } as unknown as typeof WebSocket;
    Object.assign(WebSocketImpl, { OPEN: FakeWebSocket.OPEN });

    const events: string[] = [];
    connectSignalling({
      url: 'wss://example.test/$default',
      token: 'tok',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers: {
        onJoined: () => events.push('joined'),
        onJoinDenied: (reason) => events.push(`denied:${reason}`),
        onPeerUnavailable: () => events.push('peer-unavailable'),
        onRelayMessage: (message) => events.push(`relay:${message.type}`),
        onClose: () => events.push('close'),
      },
      WebSocketImpl,
    });

    created?.emit('message', { data: JSON.stringify({ type: 'joined' }) });
    created?.emit('message', { data: JSON.stringify({ type: 'join-denied', reason: 'too-late' }) });
    created?.emit('message', { data: JSON.stringify({ type: 'peer-unavailable' }) });
    created?.emit('message', {
      data: JSON.stringify({ type: 'answer', appointmentId: 'pat-1#2026-09-01T10:00:00.000Z', payload: {} }),
    });
    created?.emit('message', { data: 'not json' });
    created?.emit('message', { data: JSON.stringify({ type: 'unrecognised-shape' }) });
    created?.close();

    expect(events).toEqual(['joined', 'denied:too-late', 'peer-unavailable', 'relay:answer', 'close']);
  });

  it('never sends before the socket is open', () => {
    let created: FakeWebSocket | undefined;
    const WebSocketImpl = function (url: string) {
      created = new FakeWebSocket(url);
      return created;
    } as unknown as typeof WebSocket;
    Object.assign(WebSocketImpl, { OPEN: FakeWebSocket.OPEN });

    const connection = connectSignalling({
      url: 'wss://example.test/$default',
      token: 'tok',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers: {
        onJoined: () => {},
        onJoinDenied: () => {},
        onPeerUnavailable: () => {},
        onRelayMessage: () => {},
        onClose: () => {},
      },
      WebSocketImpl,
    });

    connection.send({ type: 'offer', appointmentId: 'pat-1#2026-09-01T10:00:00.000Z', payload: {} });
    expect(created?.sent).toEqual([]);
  });
});


// ---------------------------------------------------------------------
// 2026-09-07: the two faults that between them made a 30-minute video
// call impossible, and the recoveries that replace them.
//
// **The ten-minute one.** API Gateway closes a WebSocket that has carried
// no traffic for ten minutes, and that quota is not configurable. A
// connected call's signalling goes completely silent the instant ICE
// finishes — the media is peer-to-peer and the socket has nothing left to
// carry — so *every* call was guaranteed to lose its socket at the
// ten-minute mark, and the browser read that as the call ending.
//
// **The other one.** A closed socket was the end of the call, full stop.
// A laptop lid, a train tunnel, a wifi hop, a browser suspending a
// background tab: all of them produced "The call has ended" with no
// control on screen and no way back.
describe('keeping the socket alive', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Every socket the impl constructs, in order, so a test can drive a reconnect. */
  function harness(overrides: Record<string, unknown> = {}) {
    const sockets: FakeWebSocket[] = [];
    const WebSocketImpl = function (url: string) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
    Object.assign(WebSocketImpl, { OPEN: FakeWebSocket.OPEN });

    const handlers = {
      onJoined: vi.fn(),
      onJoinDenied: vi.fn(),
      onPeerUnavailable: vi.fn(),
      onRelayMessage: vi.fn(),
      onReconnecting: vi.fn(),
      onSuperseded: vi.fn(),
      onClose: vi.fn(),
    };
    const connection = connectSignalling({
      url: 'wss://example.test/$default',
      token: 'tok',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers,
      WebSocketImpl,
      ...overrides,
    });
    return { sockets, handlers, connection };
  }

  const sentTypes = (socket: FakeWebSocket): string[] =>
    socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type);

  it('is comfortably inside API Gateway’s own ten-minute idle quota', () => {
    // Two whole intervals fit in the margin, so one lost heartbeat cannot
    // cost the socket.
    expect(HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(10 * 60_000);
  });

  it('heartbeats an open socket, so a silent call keeps its connection', () => {
    vi.useFakeTimers();
    const { sockets } = harness();
    sockets[0]?.open();
    expect(sentTypes(sockets[0] as FakeWebSocket)).toEqual(['join']);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(sentTypes(sockets[0] as FakeWebSocket)).toEqual(['join', 'ping']);
    // Answered, as the server does — an unanswered one is deliberately
    // fatal to the socket, which the next test is about.
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(sentTypes(sockets[0] as FakeWebSocket)).toEqual(['join', 'ping', 'ping']);
  });

  it('does not heartbeat a socket that never opened', () => {
    vi.useFakeTimers();
    const { sockets } = harness();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(sockets[0]?.sent).toHaveLength(0);
  });

  it('abandons a socket whose heartbeat goes unanswered, rather than trusting readyState', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();

    // A `WebSocket` whose network has gone can sit in `OPEN` for minutes —
    // TCP has no reason to notice — so `readyState` is evidence of nothing.
    // An unanswered heartbeat is.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS);
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(handlers.onReconnecting).toHaveBeenCalled();
  });

  it('keeps a socket whose heartbeat is answered', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS * 2);
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.OPEN);
    expect(handlers.onReconnecting).not.toHaveBeenCalled();
  });

  it('counts any message as proof of life, not only a pong', () => {
    vi.useFakeTimers();
    const { sockets } = harness();
    sockets[0]?.open();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'peer-unavailable' }) });
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS * 2);
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('never surfaces a pong to the caller — it is between this file and the gateway', () => {
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'pong' }) });
    expect(handlers.onRelayMessage).not.toHaveBeenCalled();
    expect(handlers.onJoined).not.toHaveBeenCalled();
  });
});

describe('surviving a lost socket', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function harness(overrides: Record<string, unknown> = {}) {
    const sockets: FakeWebSocket[] = [];
    const WebSocketImpl = function (url: string) {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
    Object.assign(WebSocketImpl, { OPEN: FakeWebSocket.OPEN });
    const handlers = {
      onJoined: vi.fn(),
      onJoinDenied: vi.fn(),
      onPeerUnavailable: vi.fn(),
      onRelayMessage: vi.fn(),
      onReconnecting: vi.fn(),
      onSuperseded: vi.fn(),
      onClose: vi.fn(),
    };
    const connection = connectSignalling({
      url: 'wss://example.test/$default',
      token: 'tok',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers,
      WebSocketImpl,
      ...overrides,
    });
    return { sockets, handlers, connection };
  }

  it('reconnects and re-joins, rather than reporting the call over', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    sockets[0]?.close();

    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(handlers.onReconnecting).toHaveBeenCalledWith(1);

    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    // A fresh connection needs to say who it is again — the server issues a
    // new `connectionId` and retires the old `CALL#` row, which is exactly
    // what a reconnect wants.
    expect(JSON.parse(sockets[1]?.sent[0] as string)).toMatchObject({ type: 'join' });
  });

  it('re-announces the join on every reconnect, so a caller can treat onJoined as "usable again"', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'joined' }) });
    sockets[0]?.close();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    sockets[1]?.open();
    sockets[1]?.emit('message', { data: JSON.stringify({ type: 'joined' }) });
    expect(handlers.onJoined).toHaveBeenCalledTimes(2);
  });

  it('backs off, so a long outage costs attempts a minute rather than a storm', () => {
    vi.useFakeTimers();
    const { sockets } = harness();
    sockets[0]?.open();
    // Each of these fails before opening — an outage rather than a blip —
    // so the delay grows attempt by attempt.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      sockets[attempt]?.close();
      // One millisecond short of this attempt's own delay: nothing yet.
      vi.advanceTimersByTime((RECONNECT_DELAYS_MS[attempt] as number) - 1);
      expect(sockets).toHaveLength(attempt + 1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(attempt + 2);
    }
  });

  it('resets the backoff once a socket opens, so a second blip is quick again', () => {
    vi.useFakeTimers();
    const { sockets } = harness();
    sockets[0]?.open();
    sockets[0]?.close();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    // The second socket opened, which is what "we reached the service"
    // means — so the next drop starts the backoff again from the top.
    sockets[1]?.open();
    sockets[1]?.close();
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]);
    expect(sockets).toHaveLength(3);
  });

  it('gives up eventually, and says the connection is gone rather than retrying for ever', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS + 1; attempt += 1) {
      sockets[sockets.length - 1]?.close();
      vi.advanceTimersByTime(20_000);
    }
    expect(handlers.onClose).toHaveBeenCalled();
    // `everOpened` — this call really was under way, which is a different
    // sentence from a socket that never opened at all.
    expect(handlers.onClose).toHaveBeenLastCalledWith(true);
  });

  it('retries immediately when the network comes back, rather than waiting out the backoff', () => {
    vi.useFakeTimers();
    const { sockets } = harness();
    sockets[0]?.open();
    sockets[0]?.close();
    // Deep into the backoff: a laptop waking up or a train leaving a tunnel
    // fires `online` long before the timer would have.
    vi.advanceTimersByTime((RECONNECT_DELAYS_MS[0] as number) - 1);
    window.dispatchEvent(new Event('online'));
    expect(sockets).toHaveLength(2);
  });

  it('asks for a fresh token on a reconnect — the first one may have expired mid-call', async () => {
    vi.useFakeTimers();
    const refreshToken = vi.fn(() => Promise.resolve('fresher.token'));
    const { sockets } = harness({ refreshToken });
    sockets[0]?.open();
    sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(refreshToken).toHaveBeenCalled();
    expect(sockets[1]?.url).toContain('token=fresher.token');
  });

  it('keeps trying when a token refresh fails — one unlucky request must not end a call', async () => {
    vi.useFakeTimers();
    const refreshToken = vi.fn(() => Promise.resolve(undefined));
    const { sockets, handlers } = harness({ refreshToken });
    sockets[0]?.open();
    sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0]);
    expect(sockets).toHaveLength(1);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(handlers.onReconnecting).toHaveBeenCalledTimes(2);
  });

  it('stops for good on a join denial — no socket can talk the server out of that', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'join-denied', reason: 'too-late' }) });
    sockets[0]?.close();
    vi.advanceTimersByTime(60_000);
    // Reconnecting would only produce a stream of `join-denied` audit rows.
    expect(sockets).toHaveLength(1);
    expect(handlers.onJoinDenied).toHaveBeenCalledWith('too-late');
  });

  it('stops for good once superseded, so two tabs cannot fight over the call', () => {
    vi.useFakeTimers();
    const { sockets, handlers } = harness();
    sockets[0]?.open();
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'not-on-call' }) });
    sockets[0]?.close();
    vi.advanceTimersByTime(60_000);
    // Without this, an older tab reconnects, its join retires the newer
    // tab's row, the newer tab reconnects and retires the older one's, and
    // neither ever holds a call.
    expect(handlers.onSuperseded).toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it('stops when the caller closes it, and reports the close exactly once', () => {
    vi.useFakeTimers();
    const { sockets, handlers, connection } = harness();
    sockets[0]?.open();
    connection.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('treats a constructor that throws as terminal, and says the call never started', () => {
    const ThrowingSocket = function () {
      throw new Error('bad url');
    } as unknown as typeof WebSocket;
    Object.assign(ThrowingSocket, { OPEN: 1 });
    const onClose = vi.fn();
    connectSignalling({
      url: 'not a url',
      token: 'tok',
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      handlers: {
        onJoined: () => {},
        onJoinDenied: () => {},
        onPeerUnavailable: () => {},
        onRelayMessage: () => {},
        onClose,
      },
      WebSocketImpl: ThrowingSocket,
    });
    // A `WebSocket` constructor throws for a malformed or disallowed URL,
    // and the fortieth attempt at one of those is the same as the first.
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('drops a send with no socket rather than throwing at its caller', () => {
    vi.useFakeTimers();
    const { sockets, connection } = harness();
    sockets[0]?.open();
    sockets[0]?.close();
    expect(connection.isOpen()).toBe(false);
    expect(() =>
      connection.send({ type: 'ready', appointmentId: 'pat-1#x', payload: {} }),
    ).not.toThrow();
  });
});
