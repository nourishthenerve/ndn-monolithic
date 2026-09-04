// TASK 4.2.2: the relay decision itself, SDK-free and unit-testable — the
// same split ws-join.ts/ws-join-handler.ts already established.
// ws-relay-handler.ts is the only place the real store and the
// management-API `PostToConnection` call are wired.
//
// A joined call still has two parties who cannot reach each other
// directly — this is the small SDP/ICE handshake WebRTC needs before two
// browsers can talk P2P (D-12's "P2P first" clause made real). This file
// answers exactly one question: given a sender's own connectionId and the
// appointment they claim to be signalling for, who — if anyone — is the
// other party to forward to. It never re-runs `can()` or 4.2.1's own
// authorisation decision a second time: the `CALL#<appointmentId>`
// partition, written only by an authorised, in-window join, is the sole
// source of truth for "who is allowed on this call," and two independent
// authorisation paths for the same decision is a way for them to drift,
// not a safety margin.
//
// TASK 4.4.2 (R-03): `type: 'leave'` gains an honest, client-estimated
// `turnDurationSeconds` — the egress-telemetry half of R-03's mitigation
// list, an early-warning companion to TASK 4.4.1's own hard cap, not a
// second enforcement mechanism. Computed here (SDK-free arithmetic) so
// `ws-relay-handler.ts` only ever does the one AWS-specific thing this
// file can't: emit the CloudWatch metric.
// 2026-09-04: `'ready'` joins the four. It carries no payload and needs no
// peer connection — it is one party telling the other "I am on this call
// now, offer to me". Without it, the offerer's only way to discover a peer
// who joined *after* them was to keep re-offering into a bounded retry
// loop and give up 30 seconds later, which is a short fuse for two humans
// clicking a button. See `VideoCall.tsx`.
export type RelayMessageType = 'offer' | 'answer' | 'ice-candidate' | 'leave' | 'ready';

/** What `connection-repository.ts`'s `findCallParticipants` returns — the `CALL#<appointmentId>` partition's own rows. */
export interface RelayCallParticipant {
  readonly connectionId: string;
  /**
   * 2026-09-04: set on a row whose connection is known to be gone — see
   * `connection-repository.ts`'s own note for the bug that made this
   * necessary. A row carrying it is never a forwarding target and never
   * counts as the sender.
   */
  readonly leftAt?: string;
  /**
   * Epoch seconds, the same `ttl` the connection row carries. Checked here
   * as well as by DynamoDB because TTL deletion is best-effort — AWS
   * documents up to 48 hours of lag — and a row that has outlived its
   * connection must not be picked in the meantime.
   */
  readonly ttl?: number;
}

/**
 * The rows still worth talking to. **Filtering here rather than in the
 * repository is deliberate**: `findCallParticipants`'s own contract is that
 * it reads and decides nothing, and "who is live" is a decision — one that
 * belongs in this file with the rest of them, where it can be tested
 * without a DynamoDB double.
 */
export function liveParticipants(
  participants: readonly RelayCallParticipant[],
  now: Date,
): readonly RelayCallParticipant[] {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return participants.filter(
    (participant) =>
      participant.leftAt === undefined &&
      (participant.ttl === undefined || participant.ttl > nowSeconds),
  );
}

export interface CallParticipantLookup {
  findCallParticipants(appointmentId: string): Promise<readonly RelayCallParticipant[]>;
}

export interface RelayMessageInput {
  readonly appointmentId: string;
  /** The connection the message arrived on — never supplied by the client, always `event.requestContext.connectionId`. */
  readonly senderConnectionId: string;
  readonly type: RelayMessageType;
  readonly payload: unknown;
}

export type RelayDecision =
  | { readonly kind: 'forward'; readonly targetConnectionId: string; readonly estimatedTurnRelayGb?: number }
  | { readonly kind: 'peer-unavailable'; readonly estimatedTurnRelayGb?: number }
  // The sender's own connectionId is not one of this appointmentId's
  // `CALL#` participants — either they never joined, or they are naming
  // an appointment that is not theirs. Refused silently: there is no
  // authorised recipient to answer, and this is not a decision worth
  // recording the way a join attempt is (4.2.1's own audited exception
  // stays narrow, scoped to the join decision itself).
  | { readonly kind: 'not-authorised' };

export interface RelayMessageDeps {
  readonly connections: CallParticipantLookup;
  /** 2026-09-04: for the `ttl` half of `liveParticipants`. Optional so existing callers keep working; defaults to the real clock. */
  readonly clock?: { now(): Date };
}

// Cloudflare's own real per-call usage figure is not visible from inside
// AWS — this is this task's own honestly-stated estimate (a typical
// two-way video call's combined send+receive bitrate), not a measurement,
// named here rather than left as a bare number buried in an expression.
export const ASSUMED_TURN_RELAY_BITRATE_MBPS = 1.5;

/** `undefined` for anything that isn't a `leave` message carrying a real, positive `turnDurationSeconds` — a client that never used TURN, or omits the field, reports nothing rather than a fabricated zero. */
function estimatedTurnRelayGbFor(type: RelayMessageType, payload: unknown): number | undefined {
  if (type !== 'leave' || typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const turnDurationSeconds = (payload as Record<string, unknown>).turnDurationSeconds;
  if (typeof turnDurationSeconds !== 'number' || !(turnDurationSeconds > 0)) {
    return undefined;
  }
  // Mbps -> MB/s (÷8) -> GB (÷1000). An estimate, not a metered value —
  // named and documented, never tuned to make a number look better.
  return (turnDurationSeconds * ASSUMED_TURN_RELAY_BITRATE_MBPS) / 8 / 1000;
}

export function createRelayMessageHandler(
  deps: RelayMessageDeps,
): (input: RelayMessageInput) => Promise<RelayDecision> {
  const clock = deps.clock ?? { now: () => new Date() };
  return async (input) => {
    const stored = await deps.connections.findCallParticipants(input.appointmentId);
    // 2026-09-04: the dead rows come out here, before anything is chosen.
    // Previously `find` ran over every row this partition had ever held,
    // so "the other party" was the first non-sender row in sort-key order
    // — an arbitrary dead connection from an earlier attempt at the same
    // appointment. See `connection-repository.ts`'s `recordCallJoin`.
    const participants = liveParticipants(stored, clock.now());

    const sender = participants.find((p) => p.connectionId === input.senderConnectionId);
    if (!sender) {
      return { kind: 'not-authorised' };
    }

    const estimatedTurnRelayGb = estimatedTurnRelayGbFor(input.type, input.payload);

    const other = participants.find((p) => p.connectionId !== input.senderConnectionId);
    if (!other) {
      return { kind: 'peer-unavailable', estimatedTurnRelayGb };
    }

    return { kind: 'forward', targetConnectionId: other.connectionId, estimatedTurnRelayGb };
  };
}
