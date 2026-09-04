import { describe, expect, it } from 'vitest';

import { connectSignalling, parseIncomingMessage } from './webrtc-signalling-client.js';

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
