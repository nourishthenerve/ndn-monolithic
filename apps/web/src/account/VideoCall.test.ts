// TASK 4.5.1. The same honestly-scoped frontend gap as every prior task
// in this phase: `VideoCall.tsx` itself is a stateful, `RTCPeerConnection`-
// touching component with no jsdom/RTL pattern to render against, so the
// unit-testable surface is the pure logic it exports — `parseScheduledAt`,
// the too-early countdown's own source of truth — the same split
// `webrtc-signalling-client.ts`'s `parseIncomingMessage` and
// `DeviceCheck.tsx`'s `classifyMediaError` already establish.
import { describe, expect, it } from 'vitest';

import { JOIN_WINDOW_OPENS_BEFORE_MINUTES, parseScheduledAt } from './VideoCall.js';

describe('parseScheduledAt', () => {
  it('parses the ISO timestamp half of a real appointmentId', () => {
    const result = parseScheduledAt('pat-1#2026-09-01T10:00:00.000Z');
    expect(result).toEqual(new Date('2026-09-01T10:00:00.000Z'));
  });

  it('is undefined for an id with no separator at all', () => {
    expect(parseScheduledAt('not-a-real-id')).toBeUndefined();
  });

  it('is undefined when the patient half is empty', () => {
    expect(parseScheduledAt('#2026-09-01T10:00:00.000Z')).toBeUndefined();
  });

  it('is undefined when nothing follows the separator', () => {
    expect(parseScheduledAt('pat-1#')).toBeUndefined();
  });

  it('is undefined when the second half is not a real date, never throwing', () => {
    expect(parseScheduledAt('pat-1#not-a-date')).toBeUndefined();
  });
});

describe('JOIN_WINDOW_OPENS_BEFORE_MINUTES', () => {
  it("mirrors ws-join.ts's own named constant, not a magic number", () => {
    expect(JOIN_WINDOW_OPENS_BEFORE_MINUTES).toBe(10);
  });
});
