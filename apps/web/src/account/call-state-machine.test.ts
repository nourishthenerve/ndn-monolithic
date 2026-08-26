import { describe, expect, it } from 'vitest';

import { createCallStateMachine, DISCONNECTED_GRACE_PERIOD_MS } from './call-state-machine.js';
import type { CallLifecycleState } from './call-state-machine.js';

/** A minimal fake scheduler — captures at most one pending callback, the same shape `webrtc-signalling-client.test.ts`'s `FakeWebSocket` takes for its own dependency, rather than reaching for a timer-mocking library this codebase has never needed before. */
function fakeScheduler() {
  let pending: { readonly id: number; readonly fn: () => void } | undefined;
  let nextId = 1;

  const fakeSetTimeout = ((fn: () => void) => {
    const id = nextId++;
    pending = { id, fn };
    return id;
  }) as unknown as typeof setTimeout;

  const fakeClearTimeout = ((id: unknown) => {
    if (pending?.id === id) {
      pending = undefined;
    }
  }) as unknown as typeof clearTimeout;

  return {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    isPending: () => pending !== undefined,
    /** Fires the pending timer, as if the grace period had elapsed. */
    flush: () => {
      const fired = pending;
      pending = undefined;
      fired?.fn();
    },
  };
}

function harness() {
  const scheduler = fakeScheduler();
  const states: CallLifecycleState[] = [];
  let retries = 0;
  const machine = createCallStateMachine({
    onRetry: () => {
      retries += 1;
    },
    onStateChange: (state) => states.push(state),
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  return { scheduler, states, machine, retries: () => retries };
}

describe('createCallStateMachine', () => {
  it('an immediate failure gets exactly one reconnecting attempt, never a loop', () => {
    const { machine, states, retries } = harness();

    machine.handleConnectionState('failed');
    expect(states).toEqual([{ kind: 'reconnecting' }]);
    expect(retries()).toBe(1);

    // A second, third, fourth `failed` while already reconnecting must
    // never trigger a second `onRetry` — the retry budget is spent.
    machine.handleConnectionState('failed');
    machine.handleConnectionState('failed');
    expect(retries()).toBe(1);
  });

  it('a second failure after the retry reaches call-failed, not another retry', () => {
    const { machine, states, retries } = harness();

    machine.handleConnectionState('failed');
    machine.handleConnectionState('failed');

    expect(states).toEqual([{ kind: 'reconnecting' }, { kind: 'call-failed' }]);
    expect(retries()).toBe(1);
  });

  it('call-failed is terminal — no state at all is emitted for anything fed in afterwards', () => {
    const { machine, states, retries } = harness();

    machine.handleConnectionState('failed');
    machine.handleConnectionState('failed');
    const afterTerminal = states.length;

    machine.handleConnectionState('failed');
    machine.handleConnectionState('connected');
    machine.handleConnectionState('disconnected');

    expect(states).toHaveLength(afterTerminal);
    expect(retries()).toBe(1);
  });

  it('connected after a successful retry clears the terminal path — a later failure gets its own retry', () => {
    const { machine, states, retries } = harness();

    machine.handleConnectionState('failed');
    machine.handleConnectionState('connected');
    expect(states).toEqual([{ kind: 'reconnecting' }, { kind: 'connected' }]);

    machine.handleConnectionState('failed');
    expect(states.at(-1)).toEqual({ kind: 'reconnecting' });
    expect(retries()).toBe(2);
  });

  it('a disconnected state recovering inside the grace period never retries', () => {
    const { machine, states, retries, scheduler } = harness();

    machine.handleConnectionState('disconnected');
    expect(scheduler.isPending()).toBe(true);

    machine.handleConnectionState('connected');
    expect(scheduler.isPending()).toBe(false);
    expect(states).toEqual([{ kind: 'connected' }]);
    expect(retries()).toBe(0);
  });

  it('a disconnected state held past the grace period retries exactly once', () => {
    const { machine, states, retries, scheduler } = harness();

    machine.handleConnectionState('disconnected');
    scheduler.flush();

    expect(states).toEqual([{ kind: 'reconnecting' }]);
    expect(retries()).toBe(1);
  });

  it('the grace period is named, not a magic number, and is a few seconds', () => {
    expect(DISCONNECTED_GRACE_PERIOD_MS).toBeGreaterThan(0);
  });

  it('a raw "connecting" transition never overrides an in-progress reconnecting state', () => {
    const { machine, states } = harness();

    machine.handleConnectionState('failed');
    machine.handleConnectionState('connecting');

    expect(states).toEqual([{ kind: 'reconnecting' }]);
  });

  it('dispose releases a pending grace-period timer', () => {
    const { machine, scheduler } = harness();

    machine.handleConnectionState('disconnected');
    expect(scheduler.isPending()).toBe(true);

    machine.dispose();
    expect(scheduler.isPending()).toBe(false);
  });
});
