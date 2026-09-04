// TASK 4.2.2. Exercises the relay decision against an in-memory double for
// the one dependency it has — no AWS, no WebSocket event shapes, those are
// ws-relay-handler.ts's and infra's own concern (the same split
// ws-join.test.ts already draws for the join decision).
import { describe, expect, it } from 'vitest';

import {
  ASSUMED_TURN_RELAY_BITRATE_MBPS,
  createRelayMessageHandler,
  liveParticipants,
  type CallParticipantLookup,
  type RelayCallParticipant,
  type RelayMessageInput,
} from './ws-relay.js';

const APPOINTMENT_ID = 'pat-1#2026-09-01T10:00:00.000Z';

/** Comfortably inside every `ttl` these tests use, so a test not about expiry never trips over it. */
const NOW = new Date('2026-09-01T10:05:00.000Z');
const clock = { now: () => NOW };

function lookupReturning(participants: RelayCallParticipant[]): CallParticipantLookup {
  return { findCallParticipants: async () => participants };
}

/** TASK 4.2.2's own two fields, defaulted to a neutral offer/empty-payload shape for every test that isn't about TASK 4.4.2's own estimate. */
function input(overrides: Partial<RelayMessageInput> & { senderConnectionId: string }): RelayMessageInput {
  return { appointmentId: APPOINTMENT_ID, type: 'offer', payload: {}, ...overrides };
}

describe('a sender who joined this call reaches the other party', () => {
  it('forwards to the other participant’s connectionId', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]),
    });

    const result = await relay(input({ senderConnectionId: 'conn-patient' }));
    expect(result).toEqual({ kind: 'forward', targetConnectionId: 'conn-clinician' });
  });

  it('is symmetric — the other party sending back reaches the first', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]),
    });

    const result = await relay(input({ senderConnectionId: 'conn-clinician' }));
    expect(result).toEqual({ kind: 'forward', targetConnectionId: 'conn-patient' });
  });
});

describe('peer-unavailable — the sender joined, the other party has not (yet)', () => {
  it('is returned when only the sender’s own row exists', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }]),
    });

    const result = await relay(input({ senderConnectionId: 'conn-patient' }));
    expect(result).toEqual({ kind: 'peer-unavailable' });
  });
});

describe('not-authorised — a message naming an appointmentId the sender never joined', () => {
  it('is refused when the CALL# partition has no row for this connectionId', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]),
    });

    const result = await relay(input({ senderConnectionId: 'conn-eavesdropper' }));
    expect(result).toEqual({ kind: 'not-authorised' });
  });

  it('is refused when nobody has joined this appointmentId at all', async () => {
    const relay = createRelayMessageHandler({ connections: lookupReturning([]) });

    const result = await relay(input({ senderConnectionId: 'conn-patient' }));
    expect(result).toEqual({ kind: 'not-authorised' });
  });
});

describe('estimatedTurnRelayGb (TASK 4.4.2)', () => {
  const twoParties = lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]);

  it('is computed from a leave message carrying a real turnDurationSeconds', async () => {
    const relay = createRelayMessageHandler({ connections: twoParties });

    const result = await relay(
      input({ senderConnectionId: 'conn-patient', type: 'leave', payload: { turnDurationSeconds: 600 } }),
    );

    expect(result).toMatchObject({ kind: 'forward', targetConnectionId: 'conn-clinician' });
    const expectedGb = (600 * ASSUMED_TURN_RELAY_BITRATE_MBPS) / 8 / 1000;
    expect((result as { estimatedTurnRelayGb?: number }).estimatedTurnRelayGb).toBeCloseTo(expectedGb);
  });

  it('is attached to peer-unavailable too — the estimate is about the sender, not the recipient', async () => {
    const relay = createRelayMessageHandler({ connections: lookupReturning([{ connectionId: 'conn-patient' }]) });

    const result = await relay(
      input({ senderConnectionId: 'conn-patient', type: 'leave', payload: { turnDurationSeconds: 60 } }),
    );

    expect(result.kind).toBe('peer-unavailable');
    expect((result as { estimatedTurnRelayGb?: number }).estimatedTurnRelayGb).toBeGreaterThan(0);
  });

  it('is undefined for a non-leave message, even with a turnDurationSeconds-shaped payload', async () => {
    const relay = createRelayMessageHandler({ connections: twoParties });

    const result = await relay(
      input({ senderConnectionId: 'conn-patient', type: 'offer', payload: { turnDurationSeconds: 600 } }),
    );

    expect((result as { estimatedTurnRelayGb?: number }).estimatedTurnRelayGb).toBeUndefined();
  });

  it('is undefined for a leave message with no turnDurationSeconds — a call that never used TURN reports nothing', async () => {
    const relay = createRelayMessageHandler({ connections: twoParties });

    const result = await relay(input({ senderConnectionId: 'conn-patient', type: 'leave', payload: {} }));

    expect((result as { estimatedTurnRelayGb?: number }).estimatedTurnRelayGb).toBeUndefined();
  });

  it('is undefined for a non-positive or non-numeric turnDurationSeconds, never a fabricated value', async () => {
    const relay = createRelayMessageHandler({ connections: twoParties });

    for (const payload of [{ turnDurationSeconds: 0 }, { turnDurationSeconds: -5 }, { turnDurationSeconds: 'ten' }]) {
      const result = await relay(input({ senderConnectionId: 'conn-patient', type: 'leave', payload }));
      expect((result as { estimatedTurnRelayGb?: number }).estimatedTurnRelayGb).toBeUndefined();
    }
  });
});

// 2026-09-04. **The bug that made video calling unusable, at the layer that
// chose wrong.** The owner: *"when we click we only see our own video."*
//
// `CALL#<appointmentId>` is keyed by connectionId, so every join — every
// reload, every earlier attempt at the same appointment — left another
// permanent row for the twelve hours its `ttl` carried, and nothing ever
// retired one. This function picked the other party with a `find` over all
// of them, which returns the first row in sort-key order: an arbitrary dead
// connection from a previous session. Every offer, answer and ICE candidate
// went to a socket nobody was listening on.
describe('a dead row is never mistaken for the other party', () => {
  const live = { connectionId: 'conn-live' };

  it('skips a retired row and forwards to the live peer behind it', async () => {
    const relay = createRelayMessageHandler({
      clock,
      connections: lookupReturning([
        // Sorts first by connectionId, which is exactly how it used to win.
        { connectionId: 'conn-dead', leftAt: '2026-09-01T09:00:00.000Z' },
        { connectionId: 'conn-sender' },
        live,
      ]),
    });

    expect(await relay(input({ senderConnectionId: 'conn-sender' }))).toEqual({
      kind: 'forward',
      targetConnectionId: 'conn-live',
    });
  });

  it('skips a row whose ttl has passed — DynamoDB’s own sweep is best-effort and lags', async () => {
    const relay = createRelayMessageHandler({
      clock,
      connections: lookupReturning([
        { connectionId: 'conn-expired', ttl: Math.floor(NOW.getTime() / 1000) - 1 },
        { connectionId: 'conn-sender' },
        live,
      ]),
    });

    expect(await relay(input({ senderConnectionId: 'conn-sender' }))).toEqual({
      kind: 'forward',
      targetConnectionId: 'conn-live',
    });
  });

  it('says peer-unavailable when every other row is dead, rather than forwarding into the void', async () => {
    const relay = createRelayMessageHandler({
      clock,
      connections: lookupReturning([
        { connectionId: 'conn-sender' },
        { connectionId: 'conn-dead-1', leftAt: '2026-09-01T09:00:00.000Z' },
        { connectionId: 'conn-dead-2', leftAt: '2026-09-01T09:30:00.000Z' },
      ]),
    });

    // The client knows how to act on this one — it waits and retries.
    // Forwarding to a dead connection instead is what left both people
    // looking at their own camera with nothing to explain it.
    expect(await relay(input({ senderConnectionId: 'conn-sender' }))).toEqual({
      kind: 'peer-unavailable',
    });
  });

  it('refuses a sender whose own row has been retired — they are no longer on this call', async () => {
    const relay = createRelayMessageHandler({
      clock,
      connections: lookupReturning([
        { connectionId: 'conn-sender', leftAt: '2026-09-01T09:00:00.000Z' },
        live,
      ]),
    });

    expect(await relay(input({ senderConnectionId: 'conn-sender' }))).toEqual({
      kind: 'not-authorised',
    });
  });

  it('still works with no clock supplied — the default is the real one', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-sender' }, live]),
    });

    expect(await relay(input({ senderConnectionId: 'conn-sender' }))).toEqual({
      kind: 'forward',
      targetConnectionId: 'conn-live',
    });
  });
});

describe('liveParticipants', () => {
  it('keeps a row with neither marker — the ordinary live row', () => {
    expect(liveParticipants([{ connectionId: 'a' }], NOW)).toEqual([{ connectionId: 'a' }]);
  });

  it('drops a row carrying leftAt, whatever its ttl says', () => {
    const rows = [{ connectionId: 'a', leftAt: '2026-09-01T09:00:00.000Z', ttl: 9_999_999_999 }];
    expect(liveParticipants(rows, NOW)).toEqual([]);
  });

  it('keeps a row whose ttl is still ahead, and drops one exactly at it', () => {
    const atNow = Math.floor(NOW.getTime() / 1000);
    expect(liveParticipants([{ connectionId: 'a', ttl: atNow + 1 }], NOW)).toHaveLength(1);
    // `>`, not `>=`: a row whose ttl is this second is spent.
    expect(liveParticipants([{ connectionId: 'a', ttl: atNow }], NOW)).toHaveLength(0);
  });

  it('keeps a row with no ttl at all rather than guessing it is dead', () => {
    expect(liveParticipants([{ connectionId: 'a' }], NOW)).toHaveLength(1);
  });
});

// 2026-09-04: `'ready'` is a relayed type like any other — it carries no
// payload and contributes nothing to the TURN estimate.
describe('the ready announcement', () => {
  it('forwards to the other party exactly as an offer does', async () => {
    const relay = createRelayMessageHandler({
      clock,
      connections: lookupReturning([{ connectionId: 'conn-a' }, { connectionId: 'conn-b' }]),
    });

    expect(await relay(input({ senderConnectionId: 'conn-a', type: 'ready', payload: {} }))).toEqual({
      kind: 'forward',
      targetConnectionId: 'conn-b',
    });
  });

  it('bounces back as peer-unavailable when nobody else is on the call yet', async () => {
    const relay = createRelayMessageHandler({
      clock,
      connections: lookupReturning([{ connectionId: 'conn-a' }]),
    });

    // This is how the first arrival learns to wait, and how the second
    // arrival's own `ready` reaches someone who is already there.
    expect(await relay(input({ senderConnectionId: 'conn-a', type: 'ready', payload: {} }))).toEqual({
      kind: 'peer-unavailable',
    });
  });
});
