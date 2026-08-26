// TASK 4.3.1: `RTCPeerConnection` first appears in this codebase here, on
// both sides of the account shell — one component, parameterised by role,
// since the peer-connection logic is identical for a patient and a
// clinician and only the join-button copy differs (4.5.1's own job, not
// this task's).
//
// **Where `role` comes from.** The offer/answer roles are fixed, not
// raced (step 2 below), so this component has to know, before it does
// anything else, whether the signed-in caller is the appointment's
// patient or its clinician. Nothing hands it that directly: the WebSocket
// `joined` response carries no role (`ws-join.ts`), and `session.ts`'s own
// header states `SessionClient` deliberately never decodes the access
// token's claims. So this is the one place this codebase infers role from
// which existing, already-role-scoped endpoint answers — `GET
// /clinicians/me/calendar` (`appointment.ts`) is reachable by either
// clinician column on the `Appointments` matrix row and refuses a patient
// by construction, the identical "a 403 here is an ordinary, expected
// outcome" posture `PatientProfile.tsx`/`CaseloadView.tsx` already take,
// used here as a positive signal instead of a dead end. A wrong guess is
// harmless: the real boundary stays server-side — an incorrectly-assumed
// "patient" is still just the appointment's own patient or refused with
// `not-your-appointment` by 4.2.1's own join decision, same as always.
//
// **Where `appointmentId` comes from.** This page has no build-time
// notion of which appointment it is for (see the `.astro` page's own
// header for why the id travels as a query-string parameter, not a path
// segment). Read once, client-side, from `window.location.search` —
// consistent with every prior account page in this phase resolving
// everything at runtime rather than from anything baked into the HTML.
//
// TASK 4.3.2: `getUserMedia` no longer happens in here. `DeviceCheck.tsx`
// owns the only permission-requesting call in this codebase and renders
// until its own caller confirms a device state; this component's join
// sequence (resolving role, opening the signalling connection, sending
// `join`) does not start until `DeviceCheck`'s `onReady` fires — the
// literal "before either party joins" this task is named for.
//
// TASK 4.3.3: `RTCPeerConnection.connectionState` no longer drives the
// rendered stage directly — every transition is fed to
// `call-state-machine.ts` instead, which decides whether it is nothing
// (a raw "connecting"), the happy path ("connected", resetting the retry
// budget), a single automatic renegotiation ("reconnecting", held behind
// a grace period for a bare "disconnected" so a momentary blip is never
// mistaken for a real failure), or the terminal "call-failed" once that
// one retry has also failed. A signalling-socket close (`onClose`) is
// deliberately kept separate from this — the peer connection can still
// be happily `connected` over an already-negotiated P2P path with no
// further use for the socket, so it gets its own `'ended'` stage rather
// than being folded into the same ICE-failure state machine.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl, signallingWebSocketUrl } from '../site-config.js';

import type { CallConnectionState, CallLifecycleState } from './call-state-machine.js';
import { createCallStateMachine } from './call-state-machine.js';
import { DeviceCheck, type DeviceCheckStrings } from './DeviceCheck.js';
import type { JoinDenialReason, RelayMessage, SignallingConnection } from './webrtc-signalling-client.js';
import { connectSignalling } from './webrtc-signalling-client.js';

// Cloudflare's own free, unlimited STUN service — no TURN entry until
// TASK 4.4.1 wires one into TASK 4.3.3's own fallback state machine.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// A patient who joins moments before their clinician is the ordinary
// case, not a failure — `ws-relay.ts`'s own `peer-unavailable` fires
// whenever the other party simply has not joined yet. Bounded, named
// retry of the offer alone (never the join) covers it: ~30 seconds is
// generous next to the 10-minute-early join window this call could only
// have been reached inside.
const PEER_RETRY_INTERVAL_MS = 2000;
const PEER_RETRY_ATTEMPTS = 15;

type CallRole = 'patient' | 'clinician';

function toCallConnectionState(state: RTCPeerConnectionState): CallConnectionState {
  if (state === 'connected') return 'connected';
  if (state === 'failed') return 'failed';
  if (state === 'closed' || state === 'disconnected') return 'disconnected';
  return 'connecting';
}

async function resolveRole(accessToken: string): Promise<CallRole> {
  const from = new Date(0).toISOString();
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(
    `${contentApiUrl}/clinicians/me/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  return response.ok ? 'clinician' : 'patient';
}

function defaultGetAppointmentId(): string | undefined {
  return new URLSearchParams(window.location.search).get('appointmentId') ?? undefined;
}

type Stage =
  | { readonly kind: 'checking' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'missing-appointment' }
  | { readonly kind: 'join-denied'; readonly reason: JoinDenialReason }
  | { readonly kind: 'waiting-for-peer' }
  | { readonly kind: 'call'; readonly lifecycle: CallLifecycleState }
  /** The signalling socket itself closed — see this file's own header for why this is not folded into `call-state-machine.ts`. */
  | { readonly kind: 'ended' }
  | { readonly kind: 'error' };

interface Session {
  readonly appointmentId: string;
  readonly accessToken: string;
}

export interface VideoCallStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly missingAppointmentLabel: string;
  readonly errorLabel: string;
  readonly waitingForPeerLabel: string;
  readonly connectingLabel: string;
  readonly connectedLabel: string;
  readonly reconnectingLabel: string;
  readonly disconnectedLabel: string;
  readonly failedLabel: string;
  readonly joinDeniedLabels: Readonly<Record<JoinDenialReason, string>>;
  readonly localVideoLabel: string;
  readonly remoteVideoLabel: string;
  readonly deviceCheck: DeviceCheckStrings;
}

export interface VideoCallProps {
  readonly strings: VideoCallStrings;
  readonly client?: SessionClient;
  /** TASK 4.5.1's own seam — the join-button state machine's first real reader of what TASK 4.3.3 now produces. */
  readonly onLifecycleChange?: (state: CallLifecycleState) => void;
  /** Injectable for tests; defaults to `window.location.search`. */
  readonly getAppointmentId?: () => string | undefined;
}

const defaultClient = createSessionClient();

export function VideoCall({
  strings,
  client = defaultClient,
  onLifecycleChange,
  getAppointmentId = defaultGetAppointmentId,
}: VideoCallProps): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [session, setSession] = useState<Session | undefined>();
  const [deviceStream, setDeviceStream] = useState<MediaStream | undefined>();
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // Whether this page has enough to even attempt a call — a real
  // appointment id, a real session — resolved independently of, and
  // ahead of, any camera/microphone permission prompt.
  useEffect(() => {
    let live = true;
    (async () => {
      const appointmentId = getAppointmentId();
      if (!appointmentId) {
        if (live) setStage({ kind: 'missing-appointment' });
        return;
      }
      const accessToken = await client.authorization();
      if (!live) return;
      if (!accessToken) {
        setStage({ kind: 'forbidden' });
        return;
      }
      setSession({ appointmentId, accessToken });
    })();
    return () => {
      live = false;
    };
  }, [client, getAppointmentId]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = deviceStream ?? null;
    }
  }, [deviceStream]);

  // The actual join sequence — gated on both a resolved session and a
  // device state `DeviceCheck` has handed off. Neither existing before
  // this effect runs is this task's own "before either party joins".
  useEffect(() => {
    if (!session || !deviceStream) return;
    const { appointmentId, accessToken } = session;
    const stream = deviceStream;

    let live = true;
    let pc: RTCPeerConnection | undefined;
    let connection: SignallingConnection | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retriesLeft = PEER_RETRY_ATTEMPTS;
    let remoteDescriptionSet = false;
    let pendingCandidates: RTCIceCandidateInit[] = [];
    // Set once, inside `run()`, before `connectSignalling` is ever
    // constructed — every closure below that reads it (`onJoined`,
    // `onPeerUnavailable`, `retryConnection`) only ever runs after that.
    let role: CallRole | undefined;

    const setStageIfLive = (next: Stage): void => {
      if (live) setStage(next);
      if (live && next.kind === 'call') onLifecycleChange?.(next.lifecycle);
    };

    // WebRTC's own well-known trickle-ICE pitfall: a candidate can arrive
    // over the relay before this side's own `setRemoteDescription` call
    // resolves. Buffered rather than dropped or thrown past the caller.
    const addIceCandidate = async (candidate: RTCIceCandidateInit): Promise<void> => {
      if (!pc) return;
      if (!remoteDescriptionSet) {
        pendingCandidates.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    };

    const flushPendingCandidates = async (): Promise<void> => {
      const queued = pendingCandidates;
      pendingCandidates = [];
      for (const candidate of queued) {
        await pc?.addIceCandidate(candidate);
      }
    };

    const sendOffer = async (): Promise<void> => {
      if (!pc) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      connection?.send({ type: 'offer', appointmentId, payload: offer });
    };

    async function handleRelayMessage(message: RelayMessage): Promise<void> {
      if (!pc) return;
      try {
        if (message.type === 'offer') {
          await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          remoteDescriptionSet = true;
          await flushPendingCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          connection?.send({ type: 'answer', appointmentId: message.appointmentId, payload: answer });
        } else if (message.type === 'answer') {
          await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          remoteDescriptionSet = true;
          await flushPendingCandidates();
        } else if (message.type === 'ice-candidate') {
          await addIceCandidate(message.payload as RTCIceCandidateInit);
        }
      } catch {
        setStageIfLive({ kind: 'error' });
      }
    }

    function buildPeerConnection(): RTCPeerConnection {
      const created = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      for (const track of stream.getTracks()) {
        created.addTrack(track, stream);
      }
      created.ontrack = (event) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = event.streams[0] ?? null;
        }
      };
      created.onicecandidate = (event) => {
        if (event.candidate) {
          connection?.send({ type: 'ice-candidate', appointmentId, payload: event.candidate.toJSON() });
        }
      };
      created.onconnectionstatechange = () => {
        stateMachine.handleConnectionState(toCallConnectionState(created.connectionState));
      };
      return created;
    }

    // TASK 4.3.3's own retry: a fresh `RTCPeerConnection` (never the
    // failed one, renegotiated) over the same already-joined call — the
    // relay and the `CALL#` row this effect never touches again.
    function retryConnection(): void {
      pc?.close();
      remoteDescriptionSet = false;
      pendingCandidates = [];
      pc = buildPeerConnection();
      if (role === 'patient') {
        void sendOffer();
      }
    }

    const stateMachine = createCallStateMachine({
      onRetry: retryConnection,
      onStateChange: (lifecycle) => setStageIfLive({ kind: 'call', lifecycle }),
    });

    async function run(): Promise<void> {
      let resolvedRole: CallRole;
      try {
        resolvedRole = await resolveRole(accessToken);
      } catch {
        setStageIfLive({ kind: 'error' });
        return;
      }
      if (!live) return;
      role = resolvedRole;

      connection = connectSignalling({
        url: signallingWebSocketUrl,
        token: accessToken,
        appointmentId,
        handlers: {
          onJoined: () => {
            pc = buildPeerConnection();
            setStageIfLive({ kind: 'call', lifecycle: { kind: 'connecting' } });
            if (role === 'patient') {
              void sendOffer();
            }
          },
          onJoinDenied: (reason) => setStageIfLive({ kind: 'join-denied', reason }),
          onPeerUnavailable: () => {
            // Only the offerer's own message ever bounces this way — the
            // answerer sends nothing until it has received an offer.
            if (role !== 'patient') return;
            if (retriesLeft <= 0) {
              setStageIfLive({ kind: 'call', lifecycle: { kind: 'call-failed' } });
              return;
            }
            retriesLeft -= 1;
            setStageIfLive({ kind: 'waiting-for-peer' });
            retryTimer = setTimeout(() => void sendOffer(), PEER_RETRY_INTERVAL_MS);
          },
          onRelayMessage: (message) => void handleRelayMessage(message),
          // The signalling socket closing is not an ICE failure — see
          // this file's own header for why it gets its own stage rather
          // than a `call-state-machine.ts` transition.
          onClose: () => setStageIfLive({ kind: 'ended' }),
        },
      });
    }

    void run();

    return () => {
      live = false;
      clearTimeout(retryTimer);
      stateMachine.dispose();
      connection?.close();
      pc?.close();
      // This effect's own `stream` (`DeviceCheck`'s handed-off grant) is
      // this effect's to release — the same "the caller who attaches a
      // stream is the caller who releases it" boundary `DeviceCheck.tsx`
      // itself already keeps for the stream it never hands off.
      stream.getTracks().forEach((track) => track.stop());
    };
  }, [session, deviceStream, onLifecycleChange]);

  if (stage.kind === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (stage.kind === 'missing-appointment') {
    return <p role="alert">{strings.missingAppointmentLabel}</p>;
  }
  if (!session) {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (!deviceStream) {
    return <DeviceCheck strings={strings.deviceCheck} onReady={setDeviceStream} />;
  }
  if (stage.kind === 'join-denied') {
    return <p role="alert">{strings.joinDeniedLabels[stage.reason]}</p>;
  }
  if (stage.kind === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }
  if (stage.kind === 'ended') {
    return (
      <p role="status" aria-live="polite">
        {strings.disconnectedLabel}
      </p>
    );
  }
  // The terminal state this task's own DoD names explicitly: styled as a
  // real alert, never a blank screen or an unstyled error.
  if (stage.kind === 'call' && stage.lifecycle.kind === 'call-failed') {
    return <p role="alert">{strings.failedLabel}</p>;
  }

  const statusLabel =
    stage.kind === 'waiting-for-peer'
      ? strings.waitingForPeerLabel
      : stage.kind === 'call' && stage.lifecycle.kind === 'connected'
        ? strings.connectedLabel
        : stage.kind === 'call' && stage.lifecycle.kind === 'reconnecting'
          ? strings.reconnectingLabel
          : strings.connectingLabel;

  return (
    <section aria-labelledby="video-call-status-heading">
      <p id="video-call-status-heading" role="status" aria-live="polite">
        {statusLabel}
      </p>
      <video ref={localVideoRef} aria-label={strings.localVideoLabel} autoPlay playsInline muted />
      <video ref={remoteVideoRef} aria-label={strings.remoteVideoLabel} autoPlay playsInline />
    </section>
  );
}
