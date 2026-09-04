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
//
// TASK 4.4.1: `retryConnection` — `call-state-machine.ts`'s own `onRetry`
// callback — now asks `POST /calls/{appointmentId}/turn-credentials` for
// a short-lived TURN credential before rebuilding the peer connection,
// and adds it to `iceServers` for that one attempt only. `fetchTurnIceServer`
// never throws and returns `undefined` on any denial, flag-off, or
// provider failure — the retry proceeds STUN-only exactly as TASK 4.3.3
// already built, since TURN gives a retry a better chance of succeeding,
// it does not remove the case where nothing does.
// `call-state-machine.ts` itself needed no change: it stays SDK-free by
// construction, and its own `onRetry: () => void` contract already
// covered a caller doing async work inside it before this task existed.
//
// TASK 4.4.2: the client's own half of R-03's egress telemetry — an
// honest, best-effort count of how many seconds this call spent
// `connected` while a TURN-assisted peer connection was active,
// accumulated across every retry that used one. Reported once, on
// `leave`, at the very end of this effect's own life — never a fabricated
// zero for a call that never touched TURN, which simply reports nothing.
//
// TASK 4.5.1: the join-button state machine. Every earlier Phase 4 task
// auto-advanced on its own; this task is where a human first has to
// press something. Two new gates sit in front of the join sequence this
// component already built:
//
//   1. **`too-early`.** The join window opens at `scheduledAt` itself and
//      closes at the end of the booked slot (2026-09-03 — `join-window.ts`
//      mirrors `ws-join.ts` rather than importing it, since `services/api`
//      and `apps/web` are two separate deployables). `scheduledAt` needs no
//      separate fetch: it is the second half of `appointmentId`
//      (`<patientId>#<scheduledAt>`), the identical key shape `ws-join.ts`'s
//      own `parseAppointmentId` already parses server-side. A caller who
//      lands here early sees a live countdown and never even opens
//      a WebSocket — the join sequence below does not start until the
//      window is open, `DeviceCheck` has handed off a stream, *and* the
//      caller has pressed `JoinCallButton`.
//   2. **`joinRequested`.** `DeviceCheck` handing off a stream used to
//      start the join sequence immediately; now it only unlocks
//      `JoinCallButton`, and the join sequence's own effect gates on this
//      flag being set by that button's `onClick`.
//
// **Leaving is now a real, two-way action, not only a tab close.**
// Clicking "Leave call" sends `{ type: 'leave' }` (4.2.2's own message,
// 4.4.2's own optional `turnDurationSeconds`) and drops `joinRequested`
// back to `false` — the exact same dependency change that already tears
// down the peer connection and signalling socket on unmount reruns here,
// so leaving needs no separate teardown path. The `leave` send itself
// moves from "only if TURN was used" to unconditional: it is now the
// *notification* the other party's own `onRelayMessage` reads to leave
// `'ended'` too, `turnDurationSeconds` still only ever a real, positive
// figure, never a fabricated zero.
//
// **The live countdown's own translated text.** Every prior string in
// this file is a plain value resolved once, at page-render time, by
// `call.astro`'s own `t()` calls — none of them vary while the page is
// open. A countdown does, every time the number of minutes remaining
// changes, so this is the first component in this codebase to call
// `t()` itself, at render time, rather than only ever receiving an
// already-resolved string as a prop.
import { defaultLocale, t, type Locale } from '@ndn/i18n';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl, signallingWebSocketUrl } from '../site-config.js';

import type { CallConnectionState, CallLifecycleState } from './call-state-machine.js';
import { createCallStateMachine } from './call-state-machine.js';
import { countdownUnits } from './countdown-units.js';
import { DeviceCheck, type DeviceCheckStrings } from './DeviceCheck.js';
import { countdownUntil, formatCountdown, parseScheduledAt } from './join-window.js';
import { JoinCallButton, type JoinCallButtonStrings } from './JoinCallButton.js';
import type { JoinDenialReason, RelayMessage, SignallingConnection } from './webrtc-signalling-client.js';
import { connectSignalling } from './webrtc-signalling-client.js';

// Cloudflare's own free, unlimited STUN service — always present. A TURN
// entry (TASK 4.4.1) is added only for a retry attempt, never the first
// connection (TASK 4.3.1's own DoD), via `buildPeerConnection`'s own
// optional `turnIceServer` parameter.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// A patient who joins moments before their clinician is the ordinary
// case, not a failure — `ws-relay.ts`'s own `peer-unavailable` fires
// whenever the other party simply has not joined yet. Bounded, named
// retry of the offer alone (never the join) covers it: ~30 seconds is a
// small fraction of the booked slot this call could only have been
// reached inside.
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

/** Never throws — a denial, a flag off, or a provider failure are all the same "no TURN entry for this attempt" outcome to the caller, `turn-credentials.ts`'s own `502`/`403`/`404` responses collapsed into one. */
async function fetchTurnIceServer(accessToken: string, appointmentId: string): Promise<RTCIceServer | undefined> {
  try {
    const response = await fetch(
      `${contentApiUrl}/calls/${encodeURIComponent(appointmentId)}/turn-credentials`,
      { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as {
      iceServer?: { urls: string[]; username: string; credential: string };
    };
    return payload.iceServer;
  } catch {
    return undefined;
  }
}

/**
 * 2026-09-04: the call's own layout, hoisted to module scope so the style
 * objects have one identity for the lifetime of the module rather than a
 * fresh one per render — the same reason `systemNow` is hoisted in the
 * panels that link here, applied to a cheaper problem.
 *
 * `16 / 9` on the container, not on either video: the frame must not
 * resize when a stream arrives or drops, or the page reflows under the
 * caller mid-call.
 */
const CALL_STAGE_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: '60rem',
  aspectRatio: '16 / 9',
  background: '#000',
  borderRadius: '0.5rem',
  overflow: 'hidden',
};

/** `cover`, so a portrait phone camera fills the frame instead of letterboxing into a black margin. */
const REMOTE_VIDEO_STYLE: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const LOCAL_VIDEO_STYLE: CSSProperties = {
  position: 'absolute',
  right: '1rem',
  bottom: '1rem',
  width: '28%',
  maxWidth: '12rem',
  minWidth: '6rem',
  aspectRatio: '16 / 9',
  objectFit: 'cover',
  borderRadius: '0.375rem',
  border: '2px solid rgba(255, 255, 255, 0.85)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.45)',
  background: '#000',
  transform: 'scaleX(-1)',
};

const REMOTE_PLACEHOLDER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#fff',
  textAlign: 'center',
  padding: '1rem',
};

type Stage =
  | { readonly kind: 'checking' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'missing-appointment' }
  | { readonly kind: 'join-denied'; readonly reason: JoinDenialReason }
  | { readonly kind: 'waiting-for-peer' }
  | { readonly kind: 'call'; readonly lifecycle: CallLifecycleState }
  /**
   * The call ended, expectedly — reached three ways: this side pressed
   * "Leave call", the other party's own `leave` arrived over the relay,
   * or the signalling socket itself closed. Never `call-failed`'s own
   * stage — one is expected, the other is not, and TASK 4.5.1's own
   * DoD line is that a caller must never have to guess which happened.
   */
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
  readonly joinCall: JoinCallButtonStrings;
  readonly leaveLabel: string;
}

export interface VideoCallProps {
  readonly strings: VideoCallStrings;
  readonly client?: SessionClient;
  /** TASK 4.5.1's own join-button state machine is this callback's first real reader. */
  readonly onLifecycleChange?: (state: CallLifecycleState) => void;
  /** Injectable for tests; defaults to `window.location.search`. */
  readonly getAppointmentId?: () => string | undefined;
  /** For the live too-early countdown's own `t()` call — every other string here is resolved once, at page-render time, by the caller. Defaults to `defaultLocale`. */
  readonly locale?: Locale;
}

const defaultClient = createSessionClient();

export function VideoCall({
  strings,
  client = defaultClient,
  onLifecycleChange,
  getAppointmentId = defaultGetAppointmentId,
  locale = defaultLocale,
}: VideoCallProps): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [session, setSession] = useState<Session | undefined>();
  const [deviceStream, setDeviceStream] = useState<MediaStream | undefined>();
  // TASK 4.5.1: flipped by `JoinCallButton`'s own `onClick`, dropped back
  // to `false` by "Leave call" or by receiving the other party's own
  // `leave` — the join-sequence effect below is gated on this exactly
  // the way it is already gated on `deviceStream`.
  const [joinRequested, setJoinRequested] = useState(false);
  const [now, setNow] = useState(() => new Date());
  /**
   * **2026-09-04: the remote stream is state, not a ref assignment.**
   *
   * `ontrack` used to write straight into `remoteVideoRef.current`, which
   * is a one-shot with no second chance: if that ref was null at the
   * instant the track arrived — the element not yet committed, or briefly
   * unmounted by a stage change — the stream was dropped and nothing ever
   * re-attached it. The caller then sat looking at their own camera with
   * no way back, which is exactly the symptom reported.
   *
   * Held here, the stream survives any number of re-renders and is
   * attached by an effect, the same shape `deviceStream` has always used
   * for the local preview. It also makes "has the other party's video
   * arrived" a fact the render can read, rather than something only the
   * DOM knows.
   */
  const [remoteStream, setRemoteStream] = useState<MediaStream | undefined>();
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

  // The remote half of the same attachment, re-running whenever either the
  // stream or the element changes — which is the whole point of holding
  // the stream in state. `play()` is called explicitly and its rejection
  // swallowed: `autoPlay` alone can be refused by a browser's autoplay
  // policy for a stream that carries audio, and a refused promise must not
  // become an unhandled rejection over a video that is, at worst, waiting
  // for a click.
  useEffect(() => {
    const element = remoteVideoRef.current;
    if (!element) {
      return;
    }
    element.srcObject = remoteStream ?? null;
    if (remoteStream) {
      void element.play().catch(() => {});
    }
  }, [remoteStream]);

  // Ticks the too-early countdown. Coarse (15s) on purpose: the displayed
  // text only ever changes once a minute, and this is a live region a
  // screen reader will re-announce on every change — ticking any faster
  // would announce nothing new, only more often.
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(interval);
  }, []);

  // A derived value, not stored state — recomputed each render from
  // `session` (set once) and `now` (ticking above). `undefined` for a
  // malformed appointment id, which is not this component's own decision
  // to police (the join attempt itself will be refused server-side).
  const scheduledAt = session ? parseScheduledAt(session.appointmentId) : undefined;
  // 2026-09-03: counts down to the appointment's own start, not to a
  // window opening ten minutes before it — see `join-window.ts`.
  //
  // Only the *before* half is computed here. Whether a slot has expired
  // needs `durationMinutes`, which the appointment id
  // (`<patientId>#<scheduledAt>`) does not carry, and this page is reached
  // by URL with nothing else. The panels that link here do know it and
  // stop offering the link; anyone who arrives at a finished call by URL
  // is refused server-side with `too-late`, which this component already
  // renders.
  const countdown = scheduledAt ? countdownUntil(scheduledAt, now) : undefined;

  // The actual join sequence — gated on a resolved session, a device
  // state `DeviceCheck` has handed off, and now (TASK 4.5.1) the caller
  // having pressed `JoinCallButton`. Nothing existing before this effect
  // runs is this task's own "before either party joins".
  useEffect(() => {
    if (!session || !deviceStream || !joinRequested) return;
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
    // TASK 4.4.2's own client-side half: an honest, best-effort estimate
    // of how long this call spent relaying through TURN, accumulated
    // across every retry that used one (never reset by a later STUN-only
    // attempt), reported once on `leave` at the very end of this effect's
    // own life.
    let usingTurn = false;
    let turnActiveSinceMs: number | undefined;
    let turnSecondsAccumulated = 0;

    const noteTurnConnectionState = (state: CallConnectionState): void => {
      if (!usingTurn) return;
      if (state === 'connected') {
        turnActiveSinceMs ??= Date.now();
      } else if (turnActiveSinceMs !== undefined) {
        turnSecondsAccumulated += (Date.now() - turnActiveSinceMs) / 1000;
        turnActiveSinceMs = undefined;
      }
    };

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
        // 2026-09-04: a rejected candidate is not a failed call. ICE
        // gathers many candidates and some are legitimately unusable by
        // the peer; letting one throw out of here reached the `catch`
        // below and put the whole call on the error screen over a single
        // discarded network path.
        try {
          await pc?.addIceCandidate(candidate);
        } catch {
          // Nothing to do and nothing to say: the remaining candidates,
          // and any still arriving, are what this connection will use.
        }
      }
    };

    const sendOffer = async (): Promise<void> => {
      if (!pc) return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      connection?.send({ type: 'offer', appointmentId, payload: offer });
    };

    async function handleRelayMessage(message: RelayMessage): Promise<void> {
      if (message.type === 'leave') {
        // The other party ended the call — TASK 4.5.1's own DoD line:
        // never leave this side staring at a frozen video. `ended`, not
        // `call-failed` — this is expected, not a failure, and the two
        // must never be indistinguishable to the caller.
        setStageIfLive({ kind: 'ended' });
        setRemoteStream(undefined);
        setJoinRequested(false);
        return;
      }
      // 2026-09-04. The other party has joined and is waiting to be
      // offered to. Only the offerer acts on it; for the answerer it is
      // information about someone who is already going to offer.
      //
      // **This is what makes the handshake deterministic rather than
      // racy.** Whoever joins second announces themselves, so the offerer
      // learns of them immediately instead of discovering them by chance
      // inside a bounded retry loop that gave up after 30 seconds — a
      // short fuse for two people clicking a button in their own time,
      // and unrecoverable once it blew.
      if (message.type === 'ready') {
        // Anything from the peer proves they are here, so the blind
        // re-offer loop has nothing left to discover. Left armed, its next
        // firing sends a *second* offer, which is how duplicate answers
        // were produced — see the `answer` branch below.
        clearTimeout(retryTimer);
        if (role === 'patient' && pc) {
          void sendOffer();
        }
        return;
      }
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
          clearTimeout(retryTimer);
          // **2026-09-04: only when one is actually outstanding.**
          //
          // Two offers could be in flight at once — the one sent on
          // joining and one from the retry timer, or from a `ready` —
          // which the other side dutifully answers twice.
          // `setRemoteDescription(answer)` on a connection already back in
          // `stable` throws `InvalidStateError`, which landed in the
          // `catch` below and replaced a working call with the error
          // screen. The second answer is redundant by definition: it
          // describes the same peer that the first one already connected.
          if (pc.signalingState !== 'have-local-offer') {
            return;
          }
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

    function buildPeerConnection(turnIceServer?: RTCIceServer): RTCPeerConnection {
      const iceServers = turnIceServer ? [...ICE_SERVERS, turnIceServer] : ICE_SERVERS;
      const created = new RTCPeerConnection({ iceServers });
      for (const track of stream.getTracks()) {
        created.addTrack(track, stream);
      }
      created.ontrack = (event) => {
        if (!live) return;
        // Both the audio and the video track arrive as separate `ontrack`
        // events carrying the *same* stream, so this is idempotent by
        // nature. `event.streams[0]` is what `addTrack(track, stream)` on
        // the other side put there; a track with no stream at all is not a
        // shape this codebase ever sends, and is ignored rather than
        // clearing a stream that is already playing.
        // Named `remote` rather than destructured into `stream`, which is
        // this effect's own local camera grant — one letter of shadowing
        // between "me" and "them" is not worth the risk.
        const [remote] = event.streams;
        if (remote) {
          setRemoteStream(remote);
        }
      };
      created.onicecandidate = (event) => {
        if (event.candidate) {
          connection?.send({ type: 'ice-candidate', appointmentId, payload: event.candidate.toJSON() });
        }
      };
      created.onconnectionstatechange = () => {
        const state = toCallConnectionState(created.connectionState);
        noteTurnConnectionState(state);
        stateMachine.handleConnectionState(state);
      };
      return created;
    }

    // TASK 4.3.3's own retry: a fresh `RTCPeerConnection` (never the
    // failed one, renegotiated) over the same already-joined call — the
    // relay and the `CALL#` row this effect never touches again. TASK
    // 4.4.1 adds the one thing before that rebuild: an attempt at a TURN
    // credential for this retry alone.
    function retryConnection(): void {
      void (async () => {
        const turnIceServer = await fetchTurnIceServer(accessToken, appointmentId);
        if (!live) return;
        pc?.close();
        remoteDescriptionSet = false;
        pendingCandidates = [];
        usingTurn = Boolean(turnIceServer);
        // The old peer connection's tracks die with it, so the stream held
        // in state is now a frozen last frame. Cleared, so the caller sees
        // the honest "reconnecting" state rather than a still image of the
        // other person that looks like a live call.
        setRemoteStream(undefined);
        pc = buildPeerConnection(turnIceServer);
        // The answerer cannot re-offer, so it says it is ready again and
        // the offerer does. Without this a retry rebuilt one side's peer
        // connection and then waited on an offer nobody was going to send.
        connection?.send({ type: 'ready', appointmentId, payload: {} });
        if (role === 'patient') {
          void sendOffer();
        }
      })();
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
            // 2026-09-04: announce first, offer second, and both sides do
            // the first one. Between them these cover the two orderings
            // completely: join second and your `ready` reaches a peer who
            // is already there; join first and their `ready` reaches you.
            // Neither side has to guess or poll.
            connection?.send({ type: 'ready', appointmentId, payload: {} });
            if (role === 'patient') {
              void sendOffer();
            }
          },
          onJoinDenied: (reason) => setStageIfLive({ kind: 'join-denied', reason }),
          onPeerUnavailable: () => {
            // 2026-09-04: **both sides reach this now**, because both send
            // `ready` on joining. It used to be the offerer's alone, and
            // the answerer's `return` here meant a clinician who arrived
            // first sat on "Connecting…" with nothing to explain it. They
            // are waiting for a peer, and the screen should say so.
            setStageIfLive({ kind: 'waiting-for-peer' });
            // Only the offerer has anything to retry — the answerer has
            // nothing to send until an offer arrives, and its `ready` has
            // already been delivered or will be re-sent by the other
            // party's own arrival. The retry is now a safety net under the
            // `ready` handshake rather than the sole mechanism, so
            // exhausting it is no longer the ordinary way two people meet.
            if (role !== 'patient') return;
            if (retriesLeft <= 0) {
              setStageIfLive({ kind: 'call', lifecycle: { kind: 'call-failed' } });
              return;
            }
            retriesLeft -= 1;
            retryTimer = setTimeout(() => void sendOffer(), PEER_RETRY_INTERVAL_MS);
          },
          onRelayMessage: (message) => void handleRelayMessage(message),
          // The signalling socket closing is not an ICE failure — see
          // this file's own header for why it gets its own stage rather
          // than a `call-state-machine.ts` transition.
          onClose: () => {
            setStageIfLive({ kind: 'ended' });
            if (live) setRemoteStream(undefined);
          },
        },
      });
    }

    void run();

    return () => {
      live = false;
      clearTimeout(retryTimer);
      stateMachine.dispose();
      // Flushes any still-accumulating TURN time (the connection was
      // `connected` at the moment this effect tore down) into the total
      // this call is about to report.
      noteTurnConnectionState('disconnected');
      // TASK 4.5.1: sent unconditionally now, whichever of the three
      // things tore this effect down (a "Leave call" click, receiving the
      // other party's own `leave`, or a true unmount) — this is the one
      // notification the other party's own `onRelayMessage` reads to
      // leave `'ended'` too, not only a best-effort telemetry report.
      // `turnDurationSeconds` stays an honest, optional figure: included
      // only when this call really did accumulate TURN time, never a
      // fabricated zero.
      connection?.send({
        type: 'leave',
        appointmentId,
        payload: turnSecondsAccumulated > 0 ? { turnDurationSeconds: Math.round(turnSecondsAccumulated) } : {},
      });
      connection?.close();
      pc?.close();
      // This effect's own `stream` (`DeviceCheck`'s handed-off grant) is
      // this effect's to release — the same "the caller who attaches a
      // stream is the caller who releases it" boundary `DeviceCheck.tsx`
      // itself already keeps for the stream it never hands off.
      stream.getTracks().forEach((track) => track.stop());
    };
  }, [session, deviceStream, joinRequested, onLifecycleChange]);

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
  if (countdown !== undefined) {
    return (
      <p role="status" aria-live="polite">
        {t('videoCall.tooEarly', { countdown: formatCountdown(countdown, countdownUnits(locale)) }, locale)}
      </p>
    );
  }
  if (!deviceStream) {
    return <DeviceCheck strings={strings.deviceCheck} onReady={setDeviceStream} />;
  }
  // Every one of these is a stage this call can never come back from —
  // checked before `joinRequested` below so a caller who has left, been
  // denied, or hit a terminal failure is never shown the join button
  // again as if none of that had happened.
  if (stage.kind === 'ended') {
    return (
      <p role="status" aria-live="polite">
        {strings.disconnectedLabel}
      </p>
    );
  }
  if (stage.kind === 'join-denied') {
    return <p role="alert">{strings.joinDeniedLabels[stage.reason]}</p>;
  }
  if (stage.kind === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }
  // The terminal state this task's own DoD names explicitly: styled as a
  // real alert, never a blank screen or an unstyled error.
  if (stage.kind === 'call' && stage.lifecycle.kind === 'call-failed') {
    return <p role="alert">{strings.failedLabel}</p>;
  }
  if (!joinRequested) {
    return <JoinCallButton strings={strings.joinCall} onJoin={() => setJoinRequested(true)} />;
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
      {/* 2026-09-04: the layout the owner asked for — *"so that we see
          each other's videos (along with ours in a small box in bottom
          right)"*. Before this the two `<video>` elements carried no
          styling at all and stacked as inline boxes at their intrinsic
          size, which is not a video call, it is two thumbnails.

          The stage owns the aspect ratio so the frame does not resize as
          streams come and go, and the self-view is positioned inside it
          rather than after it. Inline styles rather than a stylesheet:
          `apps/web` ships no CSS pipeline for islands, and the CSP already
          allows `style-src 'unsafe-inline'` (`infra/src/web-stack.ts`).
          Everything is relative units or percentages, so it holds up on a
          phone as well as a consulting-room monitor. */}
      <div style={CALL_STAGE_STYLE}>
        <video
          ref={remoteVideoRef}
          aria-label={strings.remoteVideoLabel}
          autoPlay
          playsInline
          style={REMOTE_VIDEO_STYLE}
        />
        {/* Until the other party's video arrives there is nothing to show
            but black, which is indistinguishable from a broken call. The
            status line above already says what is happening; this repeats
            it inside the frame, where the caller is looking. */}
        {!remoteStream && <p style={REMOTE_PLACEHOLDER_STYLE}>{statusLabel}</p>}
        {/* Mirrored, the way every video call mirrors a self-view: an
            un-mirrored preview of yourself reads as wrong to almost
            everyone, because it is not what a mirror does. The remote
            video is never mirrored — that one is another person, and
            flipping them would reverse any text they hold up. */}
        <video
          ref={localVideoRef}
          aria-label={strings.localVideoLabel}
          autoPlay
          playsInline
          muted
          style={LOCAL_VIDEO_STYLE}
        />
      </div>
      <button
        type="button"
        onClick={() => {
          // TASK 4.5.1 step 3: a real button, not only a tab close — the
          // effect's own cleanup (this is the exact dependency change
          // that triggers it) is what actually sends `leave` and tears
          // down the peer connection and signalling socket.
          setStage({ kind: 'ended' });
          setRemoteStream(undefined);
          setJoinRequested(false);
        }}
      >
        {strings.leaveLabel}
      </button>
    </section>
  );
}
