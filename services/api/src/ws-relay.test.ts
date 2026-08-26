// TASK 4.2.2. Exercises the relay decision against an in-memory double for
// the one dependency it has — no AWS, no WebSocket event shapes, those are
// ws-relay-handler.ts's and infra's own concern (the same split
// ws-join.test.ts already draws for the join decision).
import { describe, expect, it } from 'vitest';

import {
  createRelayMessageHandler,
  type CallParticipantLookup,
  type RelayCallParticipant,
} from './ws-relay.js';

const APPOINTMENT_ID = 'pat-1#2026-09-01T10:00:00.000Z';

function lookupReturning(participants: RelayCallParticipant[]): CallParticipantLookup {
  return { findCallParticipants: async () => participants };
}

describe('a sender who joined this call reaches the other party', () => {
  it('forwards to the other participant’s connectionId', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]),
    });

    const result = await relay({ appointmentId: APPOINTMENT_ID, senderConnectionId: 'conn-patient' });
    expect(result).toEqual({ kind: 'forward', targetConnectionId: 'conn-clinician' });
  });

  it('is symmetric — the other party sending back reaches the first', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]),
    });

    const result = await relay({ appointmentId: APPOINTMENT_ID, senderConnectionId: 'conn-clinician' });
    expect(result).toEqual({ kind: 'forward', targetConnectionId: 'conn-patient' });
  });
});

describe('peer-unavailable — the sender joined, the other party has not (yet)', () => {
  it('is returned when only the sender’s own row exists', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }]),
    });

    const result = await relay({ appointmentId: APPOINTMENT_ID, senderConnectionId: 'conn-patient' });
    expect(result).toEqual({ kind: 'peer-unavailable' });
  });
});

describe('not-authorised — a message naming an appointmentId the sender never joined', () => {
  it('is refused when the CALL# partition has no row for this connectionId', async () => {
    const relay = createRelayMessageHandler({
      connections: lookupReturning([{ connectionId: 'conn-patient' }, { connectionId: 'conn-clinician' }]),
    });

    const result = await relay({ appointmentId: APPOINTMENT_ID, senderConnectionId: 'conn-eavesdropper' });
    expect(result).toEqual({ kind: 'not-authorised' });
  });

  it('is refused when nobody has joined this appointmentId at all', async () => {
    const relay = createRelayMessageHandler({ connections: lookupReturning([]) });

    const result = await relay({ appointmentId: APPOINTMENT_ID, senderConnectionId: 'conn-patient' });
    expect(result).toEqual({ kind: 'not-authorised' });
  });
});
