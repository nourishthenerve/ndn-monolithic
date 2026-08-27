// TASK 4.2.2. Exercises the relay decision against an in-memory double for
// the one dependency it has — no AWS, no WebSocket event shapes, those are
// ws-relay-handler.ts's and infra's own concern (the same split
// ws-join.test.ts already draws for the join decision).
import { describe, expect, it } from 'vitest';

import {
  ASSUMED_TURN_RELAY_BITRATE_MBPS,
  createRelayMessageHandler,
  type CallParticipantLookup,
  type RelayCallParticipant,
  type RelayMessageInput,
} from './ws-relay.js';

const APPOINTMENT_ID = 'pat-1#2026-09-01T10:00:00.000Z';

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
