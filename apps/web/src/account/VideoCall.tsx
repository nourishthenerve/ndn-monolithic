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
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl, signallingWebSocketUrl } from '../site-config.js';

import type { JoinDenialReason, RelayMessage, SignallingConnection } from './webrtc-signalling-client.js';
import { connectSignalling } from './webrtc-signalling-client.js';

// Cloudflare's own free, unlimited STUN service — no TURN entry until
// TASK 4.4.1 wires one into TASK 4.3.3's fallback path.
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

/** `connecting`/`connected`/`disconnected`/`failed` — this task's own typed status. TASK 4.3.3's `call-state-machine.ts` is its first real reader; this task only defines and exposes it. */
export type CallConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed';

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
  | { readonly kind: 'resolving' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'missing-appointment' }
  | { readonly kind: 'join-denied'; readonly reason: JoinDenialReason }
  | { readonly kind: 'waiting-for-peer' }
  | { readonly kind: 'call'; readonly connectionState: CallConnectionState }
  | { readonly kind: 'error' };

export interface VideoCallStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly missingAppointmentLabel: string;
  readonly errorLabel: string;
  readonly waitingForPeerLabel: string;
  readonly connectingLabel: string;
  readonly connectedLabel: string;
  readonly disconnectedLabel: string;
  readonly failedLabel: string;
  readonly joinDeniedLabels: Readonly<Record<JoinDenialReason, string>>;
  readonly localVideoLabel: string;
  readonly remoteVideoLabel: string;
}

export interface VideoCallProps {
  readonly strings: VideoCallStrings;
  readonly client?: SessionClient;
  /** TASK 4.3.3's own seam — this task's first caller is this component itself, rendering `strings` by state. */
  readonly onConnectionStateChange?: (state: CallConnectionState) => void;
  /** Injectable for tests; defaults to `window.location.search`. */
  readonly getAppointmentId?: () => string | undefined;
}

const defaultClient = createSessionClient();

export function VideoCall({
  strings,
  client = defaultClient,
  onConnectionStateChange,
  getAppointmentId = defaultGetAppointmentId,
}: VideoCallProps): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'resolving' });
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let live = true;
    let pc: RTCPeerConnection | undefined;
    let localStream: MediaStream | undefined;
    let connection: SignallingConnection | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retriesLeft = PEER_RETRY_ATTEMPTS;
    let remoteDescriptionSet = false;
    let pendingCandidates: RTCIceCandidateInit[] = [];

    const setStageIfLive = (next: Stage): void => {
      if (live) setStage(next);
      if (live && next.kind === 'call') onConnectionStateChange?.(next.connectionState);
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

    const sendOffer = async (appointmentId: string): Promise<void> => {
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

    async function start(): Promise<void> {
      const appointmentId = getAppointmentId();
      if (!appointmentId) {
        setStageIfLive({ kind: 'missing-appointment' });
        return;
      }
      const accessToken = await client.authorization();
      if (!accessToken) {
        setStageIfLive({ kind: 'forbidden' });
        return;
      }
      let role: CallRole;
      try {
        role = await resolveRole(accessToken);
      } catch {
        setStageIfLive({ kind: 'error' });
        return;
      }
      if (!live) return;

      connection = connectSignalling({
        url: signallingWebSocketUrl,
        token: accessToken,
        appointmentId,
        handlers: {
          onJoined: () => {
            void (async () => {
              try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              } catch {
                setStageIfLive({ kind: 'error' });
                return;
              }
              if (!live) return;
              if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStream;
              }

              pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
              for (const track of localStream.getTracks()) {
                pc.addTrack(track, localStream);
              }
              pc.ontrack = (event) => {
                if (remoteVideoRef.current) {
                  remoteVideoRef.current.srcObject = event.streams[0] ?? null;
                }
              };
              pc.onicecandidate = (event) => {
                if (event.candidate) {
                  connection?.send({
                    type: 'ice-candidate',
                    appointmentId,
                    payload: event.candidate.toJSON(),
                  });
                }
              };
              pc.onconnectionstatechange = () => {
                if (!pc) return;
                setStageIfLive({ kind: 'call', connectionState: toCallConnectionState(pc.connectionState) });
              };

              setStageIfLive({ kind: 'call', connectionState: 'connecting' });
              if (role === 'patient') {
                await sendOffer(appointmentId);
              }
            })();
          },
          onJoinDenied: (reason) => setStageIfLive({ kind: 'join-denied', reason }),
          onPeerUnavailable: () => {
            // Only the offerer's own message ever bounces this way — the
            // answerer sends nothing until it has received an offer.
            if (role !== 'patient') return;
            if (retriesLeft <= 0) {
              setStageIfLive({ kind: 'call', connectionState: 'failed' });
              return;
            }
            retriesLeft -= 1;
            setStageIfLive({ kind: 'waiting-for-peer' });
            retryTimer = setTimeout(() => void sendOffer(appointmentId), PEER_RETRY_INTERVAL_MS);
          },
          onRelayMessage: (message) => void handleRelayMessage(message),
          onClose: () => setStageIfLive({ kind: 'call', connectionState: 'disconnected' }),
        },
      });
    }

    void start();

    return () => {
      live = false;
      clearTimeout(retryTimer);
      connection?.close();
      pc?.close();
      localStream?.getTracks().forEach((track) => track.stop());
    };
    // `strings`/`onConnectionStateChange` are read via closures the effect
    // captures fresh on every call, not values this effect should ever
    // re-run for — re-running would reopen the signalling connection and
    // re-request camera/microphone permission mid-call.
  }, [client, getAppointmentId]);

  if (stage.kind === 'resolving') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (stage.kind === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (stage.kind === 'missing-appointment') {
    return <p role="alert">{strings.missingAppointmentLabel}</p>;
  }
  if (stage.kind === 'join-denied') {
    return <p role="alert">{strings.joinDeniedLabels[stage.reason]}</p>;
  }
  if (stage.kind === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const statusLabel =
    stage.kind === 'waiting-for-peer'
      ? strings.waitingForPeerLabel
      : stage.connectionState === 'connected'
        ? strings.connectedLabel
        : stage.connectionState === 'failed'
          ? strings.failedLabel
          : stage.connectionState === 'disconnected'
            ? strings.disconnectedLabel
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
