// TASK 4.3.3: the first half of D-12's own "P2P first, Cloudflare TURN
// fallback" order — what a call does when STUN-only ICE fails, before
// TURN exists to try.
//
// TASK 4.4.1 is the second half, and needed no change to this file's own
// logic: `onRetry` was always `() => void`, a fire-and-forget hook this
// state machine never awaits, so `VideoCall.tsx`'s own `retryConnection`
// (now: ask for a TURN credential, then rebuild the peer connection) fits
// the exact same contract this file already had. TURN changes what
// happens *inside* one retry attempt, never whether or when a retry
// happens — that decision stays entirely this file's own.
//
// SDK-free by construction — no `RTCPeerConnection`, no DOM — the same
// "business logic in one file, wiring in another" split every prior task
// in this phase already uses (`webrtc-signalling-client.ts`, `ws-join.ts`).
// `VideoCall.tsx` is the only caller: it feeds every
// `RTCPeerConnection.connectionState` transition in, one at a time, via
// `handleConnectionState`, and this file decides when that means a fresh
// offer/answer cycle is warranted, never more than once per failure.
//
// `CallConnectionState` moves here from `VideoCall.tsx` (TASK 4.3.1's own
// home for it) rather than staying there — this is now the type's real
// owner, and `VideoCall.tsx` importing it back would otherwise be a
// circular import between the two files this task's own Files list names.
export type CallConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

/** The state a caller renders — TASK 4.5.1's own job. `reconnecting` covers both the immediate-`failed` path and the held-`disconnected` path below; a renderer has no reason to tell them apart. */
export type CallLifecycleState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected' }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'call-failed' };

// Long enough that a momentary ICE hiccup — a brief network blip most
// real calls recover from on their own — never triggers a renegotiation
// nobody needed; short enough that a caller is never left looking at a
// stale "connected" long after the call has actually died. Named rather
// than a magic number, the same discipline every other timing constant
// in this codebase already follows (e.g. `ws-join.ts`'s own join-window
// minutes).
export const DISCONNECTED_GRACE_PERIOD_MS = 3000;

export interface CallStateMachineDeps {
  /** Rebuilds the peer connection via a fresh offer/answer cycle — the relay and the `CALL#` row are untouched, only this. Called exactly once per failure, never in a loop. */
  readonly onRetry: () => void;
  readonly onStateChange: (state: CallLifecycleState) => void;
  /** Injectable for tests; defaults to the real timers. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export interface CallStateMachine {
  /** Feed one `RTCPeerConnection.connectionState` transition in. */
  handleConnectionState(state: CallConnectionState): void;
  /** Releases the grace-period timer, if one is pending — call on unmount. */
  dispose(): void;
}

export function createCallStateMachine(deps: CallStateMachineDeps): CallStateMachine {
  const scheduleTimeout = deps.setTimeout ?? setTimeout;
  const cancelTimeout = deps.clearTimeout ?? clearTimeout;

  let lifecycle: CallLifecycleState = { kind: 'connecting' };
  // Reset on every `connected` — this task's own DoD is one retry *per
  // failure*, not one retry for the whole call: a call that connects,
  // drops, reconnects, and later drops again gets a fresh attempt each
  // time, never treated as already having used its one chance.
  let hasRetried = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  function emit(next: CallLifecycleState): void {
    lifecycle = next;
    deps.onStateChange(next);
  }

  function clearGraceTimer(): void {
    if (graceTimer !== undefined) {
      cancelTimeout(graceTimer);
      graceTimer = undefined;
    }
  }

  function retryOrFail(): void {
    clearGraceTimer();
    if (hasRetried) {
      emit({ kind: 'call-failed' });
      return;
    }
    hasRetried = true;
    emit({ kind: 'reconnecting' });
    deps.onRetry();
  }

  return {
    handleConnectionState(state) {
      if (lifecycle.kind === 'call-failed') {
        // Terminal. TASK 4.4.1's own job is to extend this with a second
        // (TURN) retry tier ahead of this state — nothing here retries
        // past it, ever, per this task's own "never an infinite retry
        // loop" line.
        return;
      }

      if (state === 'connected') {
        clearGraceTimer();
        hasRetried = false;
        emit({ kind: 'connected' });
        return;
      }

      if (state === 'connecting') {
        // Not acted on: the very first "connecting" is already covered
        // by this machine's own initial state (before anything is fed
        // in), and a "connecting" arriving mid-`reconnecting` (a rebuilt
        // peer connection starting to gather ICE again) must not un-set
        // that status — only `connected`, `failed`, or a held
        // `disconnected` moves this state machine forward.
        return;
      }

      if (state === 'failed') {
        retryOrFail();
        return;
      }

      // `disconnected`: held for a grace period rather than acted on
      // immediately (this task's own step 1) — a momentary blip most
      // real calls recover from alone must never trigger a renegotiation
      // nobody needed.
      clearGraceTimer();
      graceTimer = scheduleTimeout(() => {
        graceTimer = undefined;
        retryOrFail();
      }, DISCONNECTED_GRACE_PERIOD_MS);
    },
    dispose() {
      clearGraceTimer();
    },
  };
}
