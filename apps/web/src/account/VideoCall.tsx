// TASK 4.3.1: `RTCPeerConnection` first appears in this codebase here, on
// both sides of the account shell — one component, parameterised by role,
// since the peer-connection logic is identical for a patient and a
// clinician and only the join-button copy differs.
//
// TASK 4.3.2: `getUserMedia` does not happen in here. `DeviceCheck.tsx`
// owns the only permission-requesting call in this codebase; this
// component only ever attaches the stream it is handed.
//
// TASK 4.3.3: `RTCPeerConnection.connectionState` never drives the
// rendered stage directly — every transition is fed to
// `call-state-machine.ts`, which decides whether it is nothing, the happy
// path, a single automatic renegotiation, or a terminal failure.
//
// TASK 4.4.1 / 4.4.2: a retry asks `POST /calls/{id}/turn-credentials` for
// a short-lived TURN credential first, and the seconds spent relaying are
// reported once, on `leave`.
//
// TASK 4.5.1: the join-button state machine — a window gate in front of
// the join sequence, and "Leave call" as a real, two-way action.
//
// ---------------------------------------------------------------------
// **2026-09-07: the stability pass.** The owner: *"what if one of the
// joinee gets his call dropped or refreshed or computer restarts or joins
// late or joins multiple times … This feature should be super stable and
// should auto connect if the participants are trying to join within call
// window. Outside call window it should not let to have a join call
// button. Also, there should be a timer showing how much time is left
// before the call auto gets dropped."*
//
// Seven things were wrong, and they are worth naming because each one
// looked like a different bug from the outside:
//
//  1. **Every call died at ten minutes.** API Gateway closes an idle
//     WebSocket after ten minutes; a connected call's signalling goes
//     silent the moment ICE completes, so the socket was always shut
//     mid-call — and `onClose` was read as the call ending. A 30-minute
//     appointment was not physically possible. `webrtc-signalling-client.ts`
//     now heartbeats.
//  2. **A dropped socket was the end of the call**, with no control on
//     screen: no rejoin, nothing. Same file now reconnects with backoff,
//     re-joins on the new connection, and only reports `onClose` once it
//     has given up. This component shows "reconnecting", not "ended".
//  3. **Nothing could be rejoined.** Every terminal state was final, and
//     the join effect's own teardown stopped the camera tracks while
//     leaving `deviceStream` set — so even flipping the flag back would
//     have built a peer connection on dead tracks. Device ownership now
//     sits outside the join effect (`releaseDevices`), and every terminal
//     state inside the window offers `Rejoin`.
//  4. **The auto-drop was 30 minutes from each side's own join**, ignoring
//     `durationMinutes` — so a 60-minute appointment was cut in half, a
//     15-minute one ran twice its length, joining at minute 25 of 30 bought
//     30 more, and the two parties held two different deadlines. The
//     deadline is now `callDeadline`: the booked slot's own end, capped by
//     `MAX_CALL_MINUTES`, derived from `scheduledAt` so both sides agree.
//  5. **There was no timer.** There is now, counting to that deadline.
//  6. **A finished appointment still offered a join button.** The page
//     could not know: the id carries `scheduledAt` and not
//     `durationMinutes`. `call-appointment.ts` resolves the row, so the
//     three phases this codebase already shows on every appointment list
//     (`JoinCallCell`) are now shown here too — countdown, join, expired.
//  7. **A transient 5xx on the role probe made a clinician "patient"**, so
//     both parties offered and neither could apply the other's offer: two
//     black frames and "Connecting…" for ever. Role resolution moved to
//     `call-appointment.ts`, which refuses to guess — and, more to the
//     point, **the role no longer decides who offers.** Each side coins a
//     random `sessionId`, exchanges it in `ready`, and the greater one
//     offers: an election that is symmetric, needs no server, and cannot
//     be wrong. Glare is survivable anyway (the polite side rolls back),
//     so a call can no longer deadlock on this.
//
// `ready` also replaces the old blind offer-retry loop as the way two
// people find each other. Whoever is waiting re-announces itself — fast at
// first, then every fifteen seconds for as long as the call window lasts —
// so "joins late" is an ordinary case rather than something that had to
// happen inside a 30-second budget that, once spent, could never recover.
import { defaultLocale, t, type Locale } from '@ndn/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl, signallingWebSocketUrl } from '../site-config.js';

import { resolveCallContext, type CallAppointment, type CallContext, type CallRole } from './call-appointment.js';
import type { CallConnectionState, CallLifecycleState } from './call-state-machine.js';
import { createCallStateMachine } from './call-state-machine.js';
import { countdownUnits } from './countdown-units.js';
import { DeviceCheck, type DeviceCheckStrings } from './DeviceCheck.js';
import {
  callDeadline,
  countdownUntil,
  formatCountdown,
  formatRemaining,
  joinPhase,
  nextPhaseChangeAt,
  parsePatientId,
  parseScheduledAt,
} from './join-window.js';
import { JoinCallButton, type JoinCallButtonStrings } from './JoinCallButton.js';
import type {
  JoinDenialReason,
  OutgoingRelayMessage,
  RelayMessage,
  SignallingConnection,
} from './webrtc-signalling-client.js';
import { connectSignalling } from './webrtc-signalling-client.js';

export type { CallRole } from './call-appointment.js';

// Cloudflare's own free, unlimited STUN service — always present. A TURN
// entry (TASK 4.4.1) is added only for a retry attempt, never the first
// connection, via `buildPeerConnection`'s own optional parameter.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/**
 * How often a caller who has nobody to talk to re-announces itself.
 *
 * Fast for the first `PEER_NUDGE_FAST_ATTEMPTS` (two people pressing a
 * button within a few seconds of each other is the ordinary case), then
 * slow — but **never stopping**, which is the change. The old loop gave up
 * after 30 seconds; a clinician who joined twenty minutes late then relied
 * entirely on their own `ready` reaching a peer whose socket may since have
 * been replaced. Slow nudging costs a handful of relay invocations a minute
 * and makes "joins late" ordinary rather than unrecoverable.
 */
const PEER_NUDGE_FAST_MS = 2000;
const PEER_NUDGE_FAST_ATTEMPTS = 15;
const PEER_NUDGE_SLOW_MS = 15_000;

/**
 * A peer connection that has exhausted `call-state-machine.ts`'s own
 * retry is rebuilt from scratch — new socket, new `RTCPeerConnection`,
 * fresh TURN attempt — rather than left on a terminal screen, as long as
 * the appointment window is still open. Bounded, and the budget is
 * restored on every successful connection, so a long call that has two
 * separate bad patches gets a full allowance for each.
 */
const MAX_AUTOMATIC_REJOINS = 3;
const REJOIN_DELAY_MS = 2000;

/**
 * How long an unanswered offer stays "outstanding" before a nudge is
 * allowed to replace it.
 *
 * An answer comes back in well under a second — it is one relay hop and one
 * `createAnswer`; ICE gathering, which is the slow part, happens
 * *afterwards* and does not hold the answer up. So an offer still
 * unanswered several seconds later was lost, and the one-offer-at-a-time
 * rule would otherwise keep this side waiting on it for the rest of the
 * appointment. Long enough that a merely slow handshake is never
 * interrupted — a fresh offer restarts ICE, and doing that every two
 * seconds is how a call that was only slow becomes one that never
 * finishes.
 */
const STALE_OFFER_MS = 6000;

/** When the countdown starts warning rather than merely counting. Announced once, politely — not every second. */
const ENDING_SOON_MS = 2 * 60_000;

/**
 * 2026-09-04, the owner: *"if the video call length is 30 mins the call
 * should be dropped automatically."*
 *
 * A **cap** on one sitting, not the whole rule: the deadline is the earlier
 * of this and the booked slot's own end (`callDeadline`). A 15-minute
 * check-in ends when it ends; a 90-minute assessment is not cut at 30
 * minutes without the caller being able to rejoin for another block.
 */
export const MAX_CALL_MINUTES = 30;

function toCallConnectionState(state: RTCPeerConnectionState): CallConnectionState {
  if (state === 'connected') return 'connected';
  if (state === 'failed') return 'failed';
  if (state === 'closed' || state === 'disconnected') return 'disconnected';
  return 'connecting';
}

/**
 * The identity this browser uses to elect an offerer. Random, per join —
 * never a principal id, which would make the election predictable and, on
 * a call where the same person has two tabs open, equal.
 *
 * `crypto.randomUUID` where it exists, and a plain random string where it
 * does not: this value only has to be unequal between two browsers, and an
 * election is not a security boundary.
 */
function createSessionId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
 * fresh one per render.
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
  // 2026-09-05: with `aspect-ratio` set, a max height makes the browser
  // shrink the *width* to keep the shape — which is what stops a
  // full-width stage on a wide monitor from being taller than the screen
  // and pushing the controls below the fold.
  maxHeight: 'calc(100vh - 14rem)',
  background: '#000',
  borderRadius: '0.5rem',
  overflow: 'hidden',
};

/** The same stage, given the whole of whatever contains it. See `fillWidth`. */
const CALL_STAGE_FILL_STYLE: CSSProperties = { ...CALL_STAGE_STYLE, maxWidth: 'none' };

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

/**
 * 2026-09-04: what sits in the self-view while the camera is off.
 *
 * The inset box is `background: #000` and a camera that is off paints
 * nothing into it, so without this the caller sees a black rectangle —
 * which is exactly the thing the owner reported as a bug when the cause
 * was a stream that had failed to attach. A deliberate "camera off" and a
 * broken preview must not look the same.
 */
const LOCAL_PLACEHOLDER_STYLE: CSSProperties = {
  position: 'absolute',
  right: '1rem',
  bottom: '1rem',
  width: '28%',
  maxWidth: '12rem',
  minWidth: '6rem',
  aspectRatio: '16 / 9',
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  fontSize: '0.8125rem',
  padding: '0.25rem',
  color: '#fff',
  background: '#000',
  borderRadius: '0.375rem',
  border: '2px solid rgba(255, 255, 255, 0.85)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.45)',
};

const CALL_CONTROLS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  marginBlockStart: '0.75rem',
};

/**
 * The status line and the countdown share a row: the caller reads them
 * together ("Connected · 18:42"), and stacking them pushes the stage down.
 */
const CALL_HEADER_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '0.5rem',
  margin: 0,
  marginBlockEnd: '0.5rem',
};

/** Tabular figures so the seconds ticking down does not shift the text beside them. */
const TIMER_STYLE: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

const WARNING_STYLE: CSSProperties = { ...TIMER_STYLE, fontWeight: 600 };

/** Why a call stopped, so the sentence a caller reads is the true one rather than a generic "ended". */
type EndReason = 'left' | 'peer-left' | 'time-limit' | 'connection-lost';

type Stage =
  | { readonly kind: 'checking' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'missing-appointment' }
  | { readonly kind: 'join-denied'; readonly reason: JoinDenialReason }
  | { readonly kind: 'waiting-for-peer' }
  | { readonly kind: 'call'; readonly lifecycle: CallLifecycleState }
  /**
   * 2026-09-07: this browser's connection was superseded by a newer one
   * for the same person — another tab, or a reload whose old socket
   * outlived it. Its own stage rather than an error: nothing is broken and
   * the call is very likely fine somewhere else, which is the one thing
   * this screen has to say.
   */
  | { readonly kind: 'superseded' }
  /** The call ended, expectedly. `reason` is why. Never `call-failed`'s own stage — one is expected, the other is not. */
  | { readonly kind: 'ended'; readonly reason: EndReason }
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
  /** 2026-09-04: the camera toggle's two labels, and what the self-view says while the camera is off. */
  readonly turnCameraOnLabel: string;
  readonly turnCameraOffLabel: string;
  readonly cameraOffLabel: string;
  /** Shown over the main frame once the other party is connected but has not turned their camera on. */
  readonly remoteCameraOffLabel: string;
  /** Shown in place of the ordinary "call has ended" when the time limit is what ended it. */
  readonly timeLimitReachedLabel: string;
  /** 2026-09-07 — the states this screen could not previously describe. */
  readonly expiredLabel: string;
  readonly rejoinLabel: string;
  readonly supersededLabel: string;
  readonly connectionLostLabel: string;
  readonly peerLeftLabel: string;
}

export interface VideoCallProps {
  readonly strings: VideoCallStrings;
  readonly client?: SessionClient;
  readonly onLifecycleChange?: (state: CallLifecycleState) => void;
  /**
   * 2026-09-05: fires once, when the join sequence starts and this side
   * knows which end of the call it is. Also the honest signal that a call
   * is *under way* — it cannot fire before the caller has joined.
   */
  readonly onRoleResolved?: (role: CallRole) => void;
  /**
   * Widens the call stage past its own comfortable maximum. The clinician's
   * layout gives it a column rather than the page, so the column's width is
   * already the constraint and a second one inside it only wastes space.
   */
  readonly fillWidth?: boolean;
  /** Injectable for tests; defaults to `window.location.search`. */
  readonly getAppointmentId?: () => string | undefined;
  /** For the live countdowns' own `t()` calls — every other string here is resolved once, at page-render time, by the caller. */
  readonly locale?: Locale;
}

const defaultClient = createSessionClient();

export function VideoCall({
  strings,
  client = defaultClient,
  onLifecycleChange,
  onRoleResolved,
  fillWidth = false,
  getAppointmentId = defaultGetAppointmentId,
  locale = defaultLocale,
}: VideoCallProps): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [session, setSession] = useState<Session | undefined>();
  const [context, setContext] = useState<CallContext | undefined>();
  const [deviceStream, setDeviceStream] = useState<MediaStream | undefined>();
  const [joinRequested, setJoinRequested] = useState(false);
  /**
   * Bumped to force the whole join sequence — socket, peer connection,
   * TURN attempt — to be built again from nothing. The dependency that
   * makes an automatic rejoin a re-run of the one code path that already
   * works rather than a second one written to do the same thing.
   */
  const [joinAttempt, setJoinAttempt] = useState(0);
  /** When this sitting began. Reset on a deliberate (re)join, untouched by an automatic rebuild, so a rebuild never buys another 30 minutes. */
  const [joinedAt, setJoinedAt] = useState<Date | undefined>();
  /** Ticks every 15s for the pre-call countdown; a call under way has its own second-by-second clock below. */
  const [now, setNow] = useState(() => new Date());
  const [remainingMs, setRemainingMs] = useState<number | undefined>();
  /** True once the caller has been through the device check, so a rejoin does not make them confirm devices they already chose. */
  const [devicesConfirmed, setDevicesConfirmed] = useState(false);
  /**
   * 2026-09-04, the owner: *"start the video call by default with audio
   * only and have a separate button to turn the video on."*
   *
   * Implemented as `track.enabled`, not by withholding the track from the
   * peer connection: the sender stays in place, so switching the camera on
   * mid-call transmits immediately — no renegotiation and no second
   * permission prompt.
   */
  const [cameraOn, setCameraOn] = useState(false);
  /** Whether the *other* person's camera is on — read from their track's own `muted` flag, the receiving end of them disabling it. */
  const [remoteCameraOn, setRemoteCameraOn] = useState(false);
  /**
   * **2026-09-04: the remote stream is state, not a ref assignment.**
   * `ontrack` used to write straight into a ref, which is a one-shot: if
   * the element was not committed at the instant the track arrived, the
   * stream was dropped and nothing ever re-attached it.
   */
  const [remoteStream, setRemoteStream] = useState<MediaStream | undefined>();
  /**
   * **2026-09-04: the video elements are state, not refs, and that is the
   * fix for a self-view that was simply black.** Attaching a stream needs
   * the stream to exist *and* the element to be mounted, and a `useRef`
   * tells an effect about only the first.
   */
  const [localVideoEl, setLocalVideoEl] = useState<HTMLVideoElement | null>(null);
  const [remoteVideoEl, setRemoteVideoEl] = useState<HTMLVideoElement | null>(null);

  /**
   * **Callbacks live in refs, and that is a bug fix.** They used to sit in
   * the join effect's dependency array, so a caller passing an inline
   * function — the ordinary way to pass one — tore the whole call down and
   * rebuilt it on every render of the component above. Held here, a
   * re-render cannot touch a call in progress.
   */
  const onLifecycleChangeRef = useRef(onLifecycleChange);
  const onRoleResolvedRef = useRef(onRoleResolved);
  useEffect(() => {
    onLifecycleChangeRef.current = onLifecycleChange;
    onRoleResolvedRef.current = onRoleResolved;
  }, [onLifecycleChange, onRoleResolved]);

  /**
   * **Device ownership moved out of the join effect, and that is the other
   * half of why nothing could be rejoined.** That effect's teardown
   * stopped the tracks — so any re-run (a leave, a rebuild, a caller's
   * inline callback) left `deviceStream` holding a stream whose tracks had
   * ended, while the render still treated it as usable, so the next call
   * would have had a peer connection with no media on it and no way to
   * notice. Released here instead, deliberately, at the points a call is
   * really over.
   */
  const deviceStreamRef = useRef<MediaStream | undefined>(undefined);
  useEffect(() => {
    deviceStreamRef.current = deviceStream;
  }, [deviceStream]);

  const releaseDevices = useCallback(() => {
    deviceStreamRef.current?.getTracks().forEach((track) => track.stop());
    deviceStreamRef.current = undefined;
    setDeviceStream(undefined);
  }, []);

  // The last thing this component does. Never in the join effect: a call
  // being rebuilt must not put the camera light out and back on.
  useEffect(() => () => {
    deviceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  /**
   * **The one way a call stops, whatever the reason and whatever it leaves
   * on screen.** Dropping `joinRequested` is what actually tears the join
   * effect down — which is what sends `leave`, closes the signalling socket
   * and closes the peer connection — so every ending goes through the one
   * path that already worked rather than a second one per reason.
   *
   * Every terminal state goes through here, and that is load-bearing
   * rather than tidy. A stage set on its own left the socket and the peer
   * connection running underneath it, so the *next* thing either of them
   * said overwrote the terminal message: a `joined` arriving after a
   * failure put "Connecting…" back over "This call could not connect", and
   * a socket idling out ten minutes after a refusal replaced the server's
   * own reason with "the connection was lost". It also left the camera on
   * behind a screen that says the call is over.
   */
  const stopCall = useCallback(
    (next: Stage) => {
      setStage(next);
      setRemoteStream(undefined);
      setRemainingMs(undefined);
      setJoinRequested(false);
      releaseDevices();
    },
    [releaseDevices],
  );

  const endCall = useCallback(
    (reason: EndReason) => stopCall({ kind: 'ended', reason }),
    [stopCall],
  );

  const beginJoin = useCallback(() => {
    automaticRejoinsRef.current = 0;
    setStage({ kind: 'call', lifecycle: { kind: 'connecting' } });
    setRemoteStream(undefined);
    setJoinedAt(new Date());
    setJoinRequested(true);
    setJoinAttempt((attempt) => attempt + 1);
  }, []);

  // Whether this page has enough to even attempt a call — a real
  // appointment id, a real session — resolved independently of, and ahead
  // of, any camera/microphone permission prompt.
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

  const scheduledAt = useMemo(
    () => (session ? parseScheduledAt(session.appointmentId) : undefined),
    [session],
  );

  /**
   * Which end of the call this is, and — where it can be found — the
   * appointment row itself.
   *
   * A malformed id still gets asked: the probe answers the role from an
   * HTTP status alone, the appointment simply will not match, and the join
   * that follows is refused server-side with its own reason. Refusing here
   * would replace a precise server sentence with a vague client one.
   */
  useEffect(() => {
    if (!session) return;
    let live = true;
    setContext(undefined);
    (async () => {
      const resolved = await resolveCallContext({
        accessToken: session.accessToken,
        patientId: parsePatientId(session.appointmentId) ?? '',
        scheduledAt: scheduledAt ?? new Date(),
      });
      if (live) setContext(resolved);
    })();
    return () => {
      live = false;
    };
  }, [session, scheduledAt]);

  const appointment: CallAppointment | undefined =
    context?.kind === 'resolved' ? context.appointment : undefined;
  const role = context?.kind === 'resolved' ? context.role : undefined;

  // Both halves of the attachment depend on the element as well as the
  // stream, so whichever arrives second is what runs them. `play()` is
  // called explicitly and its rejection swallowed: `autoPlay` alone can be
  // refused by a browser's autoplay policy, and a refused promise must not
  // become an unhandled rejection over a video that is, at worst, waiting
  // for a click.
  useEffect(() => {
    if (!localVideoEl) {
      return;
    }
    localVideoEl.srcObject = deviceStream ?? null;
    if (deviceStream) {
      void localVideoEl.play().catch(() => {});
    }
  }, [localVideoEl, deviceStream]);

  useEffect(() => {
    if (!remoteVideoEl) {
      return;
    }
    remoteVideoEl.srcObject = remoteStream ?? null;
    if (remoteStream) {
      void remoteVideoEl.play().catch(() => {});
    }
  }, [remoteVideoEl, remoteStream]);

  // 2026-09-04: the camera switch itself. Applied to the stream rather
  // than tracked separately, and re-applied whenever the stream changes,
  // so a device swap in `DeviceCheck` cannot land a live camera on a call
  // the caller had set to audio only.
  useEffect(() => {
    if (!deviceStream) {
      return;
    }
    for (const track of deviceStream.getVideoTracks()) {
      track.enabled = cameraOn;
    }
  }, [deviceStream, cameraOn]);

  // The other side of the same question. A remote track reports `muted`
  // while its sender has it disabled, and fires `mute`/`unmute` as that
  // changes — so this stays right for the whole call without either party
  // having to announce anything over the relay.
  useEffect(() => {
    const [videoTrack] = remoteStream?.getVideoTracks() ?? [];
    if (!videoTrack) {
      setRemoteCameraOn(false);
      return;
    }
    const sync = (): void => setRemoteCameraOn(!videoTrack.muted);
    sync();
    videoTrack.addEventListener('mute', sync);
    videoTrack.addEventListener('unmute', sync);
    return () => {
      videoTrack.removeEventListener('mute', sync);
      videoTrack.removeEventListener('unmute', sync);
    };
  }, [remoteStream]);

  // Ticks the pre-call countdown. Coarse (15s) on purpose: the displayed
  // text only ever changes once a minute, and this is a live region a
  // screen reader will re-announce on every change.
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(interval);
  }, []);

  /**
   * The exact instant the window's phase changes, watched with a timer of
   * its own.
   *
   * A 15-second tick is the wrong instrument for a boundary: without this
   * a caller could sit looking at "the appointment has not started yet"
   * fifteen seconds after it had — or, worse, at a live join button
   * fifteen seconds after the window shut.
   */
  useEffect(() => {
    if (!scheduledAt || !appointment) return;
    const changeAt = nextPhaseChangeAt(scheduledAt, appointment.durationMinutes, now);
    if (!changeAt) return;
    const delay = changeAt.getTime() - Date.now();
    if (delay <= 0) {
      setNow(new Date());
      return;
    }
    const timer = setTimeout(() => setNow(new Date()), delay + 50);
    return () => clearTimeout(timer);
  }, [scheduledAt, appointment, now]);

  const countdown = scheduledAt ? countdownUntil(scheduledAt, now) : undefined;
  /**
   * The three phases `JoinCallCell` already shows on every appointment
   * list, now shown on the call page too — `undefined` while the duration
   * is unknown, which is the one case this screen must not claim anything
   * about: it falls back to the countdown from the id alone and lets the
   * server's own `too-late` speak for the far end.
   */
  const phase =
    scheduledAt && appointment
      ? joinPhase(scheduledAt, appointment.durationMinutes, now)
      : undefined;

  /**
   * When this call gets dropped, as one absolute instant. Both parties
   * compute it from `scheduledAt`, so two people who joined ten minutes
   * apart do not hold two different deadlines — which they did.
   */
  const deadline = useMemo(
    () =>
      joinedAt
        ? callDeadline(
            joinedAt,
            MAX_CALL_MINUTES * 60_000,
            appointment ? { scheduledAt: appointment.scheduledAt, durationMinutes: appointment.durationMinutes } : undefined,
          )
        : undefined,
    [joinedAt, appointment],
  );

  /**
   * The countdown, and the drop.
   *
   * Two mechanisms on purpose. The timeout fires at the exact instant; the
   * per-second tick is what catches a deadline that passed while this tab
   * was in the background, where browsers throttle timers hard and a
   * 30-minute `setTimeout` can come back late. Either one ending the call
   * is the same call to `endCall`.
   */
  useEffect(() => {
    if (!joinRequested || !deadline) {
      setRemainingMs(undefined);
      return;
    }
    const tick = (): void => {
      const left = deadline.getTime() - Date.now();
      if (left <= 0) {
        setRemainingMs(0);
        endCall('time-limit');
        return;
      }
      setRemainingMs(left);
    };
    tick();
    const interval = setInterval(tick, 1000);
    const timer = setTimeout(tick, Math.max(0, deadline.getTime() - Date.now()));
    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [joinRequested, deadline, endCall]);

  /**
   * Read inside the join effect's own closures, which outlive any single
   * render: whether an automatic rejoin is still worth attempting. `true`
   * when the duration is unknown — the same "do not claim the window has
   * shut without knowing" reading `phase` takes.
   */
  const windowOpenRef = useRef(true);
  windowOpenRef.current = phase === undefined || phase === 'open';

  /**
   * **How many whole-call rebuilds this sitting has already spent — held
   * here, outside the join effect, because a rebuild *is* a re-run of that
   * effect.** A counter living inside it was reset by the very thing it was
   * meant to bound, so a call that could not connect would have rebuilt
   * itself every few seconds for the whole appointment window. Reset on a
   * successful connection (a long call with two separate bad patches gets a
   * full allowance for each) and on a deliberate (re)join.
   */
  const automaticRejoinsRef = useRef(0);

  // The actual join sequence — gated on a resolved session, a resolved
  // role, a device stream `DeviceCheck` has handed off, and the caller
  // having pressed `JoinCallButton`.
  useEffect(() => {
    if (!session || !deviceStream || !joinRequested || !role) return;
    const { appointmentId, accessToken } = session;
    const stream = deviceStream;

    let live = true;
    let pc: RTCPeerConnection | undefined;
    /**
     * A holder rather than a plain binding. Every handler below is
     * constructed *before* `connectSignalling` returns, so none of them can
     * close over its result directly — and one of them (`onClose`, for a
     * `WebSocket` constructor that throws) really can run during that call,
     * where it must find `undefined` here rather than a temporal-dead-zone
     * crash.
     */
    const signalling: { current: SignallingConnection | undefined } = { current: undefined };
    const send = (message: OutgoingRelayMessage): void => signalling.current?.send(message);
    let remoteDescriptionSet = false;
    let pendingCandidates: RTCIceCandidateInit[] = [];
    /**
     * ICE candidates this side gathered while the socket was away.
     *
     * A reconnect takes a second or two, and ICE gathers throughout — so
     * without this, every candidate produced during a blip was simply
     * dropped, and a negotiation that had already exchanged descriptions
     * would then fail for want of paths and have to be rebuilt from
     * scratch. Only candidates are buffered: an offer or an answer is
     * regenerated by the handshake on the far side of the reconnect, and
     * re-sending a stale one would describe a connection that has moved on.
     */
    let unsentCandidates: RTCIceCandidateInit[] = [];
    /**
     * One offer at a time. Without it, several offers went out at once and
     * came back several answers; the duplicate-answer guard dropped all but
     * one, which left `remoteDescriptionSet` false, which stranded every
     * queued ICE candidate for the life of the call — a black frame and
     * "Connecting…" with nothing to explain it.
     */
    let offerInFlight = false;
    let offerSentAtMs = 0;
    let peerPresent = false;
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    let nudgeCount = 0;
    let rejoinTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * **The offerer election.** Random per join, exchanged in `ready`, and
     * the greater id offers. Symmetric, decided by both sides from the same
     * two values, and — unlike asking an HTTP route which role you are —
     * incapable of electing two offerers or none. `role` is only the
     * fallback for the instant before the exchange completes.
     */
    const mySessionId = createSessionId();
    let peerSessionId: string | undefined;
    /**
     * **Which incarnation of a peer connection each side is on.** Bumped
     * every time this side builds a fresh `RTCPeerConnection`, carried on
     * `ready`, and it is the whole of how a peer tells "I have rebuilt,
     * offer to me again" apart from "I am still here, nudging".
     *
     * Without it the two are indistinguishable — both are a `ready` from a
     * peer that is not connected — and a caller has to choose between
     * re-offering on every nudge (renegotiating a connection that is
     * mid-ICE, which is how a working call gets talked to death) and never
     * re-offering after a rebuild (which leaves the rebuilt side waiting on
     * an offer nobody will send). Neither is acceptable; this makes the
     * question answerable instead.
     */
    let pcGeneration = 0;
    let peerGeneration = -1;
    /**
     * The last answer this side created, kept so it can be **re-sent**.
     *
     * The offerer can always recover a lost offer (it re-offers). The
     * answerer had no equivalent: if its answer was the message that got
     * dropped, the offerer sat with an outstanding offer and the answerer
     * sat with a remote description, each believing the other owed them
     * something, until the window closed. One retained SDP string closes
     * that.
     */
    let lastAnswer: RTCSessionDescriptionInit | undefined;
    // TASK 4.4.2's own client-side half: an honest, best-effort estimate of
    // how long this call spent relaying through TURN, reported once on
    // `leave`.
    let usingTurn = false;
    let turnActiveSinceMs: number | undefined;
    let turnSecondsAccumulated = 0;

    const isOfferer = (): boolean =>
      peerSessionId !== undefined ? mySessionId > peerSessionId : role === 'patient';

    const isConnected = (): boolean => pc?.connectionState === 'connected';

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
      if (!live) return;
      setStage(next);
      if (next.kind === 'call') onLifecycleChangeRef.current?.(next.lifecycle);
    };

    const cancelNudge = (): void => {
      if (nudgeTimer !== undefined) {
        clearTimeout(nudgeTimer);
        nudgeTimer = undefined;
      }
    };

    /** `wantsOffer` is the whole reason a reconnect on a healthy call does not renegotiate it: a peer who is already connected asks for nothing. */
    const sendReady = (): void => {
      send({
        type: 'ready',
        appointmentId,
        payload: { sessionId: mySessionId, wantsOffer: !isConnected(), generation: pcGeneration },
      });
    };

    /**
     * The one timer that looks for a peer, scheduled in exactly one place
     * so a second can never be armed on top of a first — the absence of
     * that rule is what once let pending timers double every two seconds
     * until the call drowned in its own offers.
     */
    const scheduleNudge = (): void => {
      cancelNudge();
      // **Kept running until the media is actually up, not until the peer
      // first says hello.** Cancelling on "we have heard from them" left a
      // real hole: if this side's reply to their announcement was the
      // message that got dropped, they would never learn our session id (we
      // only re-announce on a *changed* id) and neither side would ever be
      // elected to offer. A nudge that survives until `connected` is what
      // closes it, at the cost of one small message every couple of seconds
      // during the second or two a handshake takes.
      if (!live || isConnected()) return;
      const delay = nudgeCount < PEER_NUDGE_FAST_ATTEMPTS ? PEER_NUDGE_FAST_MS : PEER_NUDGE_SLOW_MS;
      nudgeTimer = setTimeout(() => {
        nudgeTimer = undefined;
        nudgeCount += 1;
        sendReady();
        // An offer nobody ever answered, long enough ago that it cannot
        // still be in flight, is gone — and holding the one-at-a-time rule
        // over it would keep this side waiting for the rest of the
        // appointment. (`peer-unavailable` clears this too, but only for a
        // bounce the relay actually reported.)
        if (offerInFlight && !remoteDescriptionSet && Date.now() - offerSentAtMs > STALE_OFFER_MS) {
          offerInFlight = false;
        }
        // A peer we have heard from but never negotiated with is a stalled
        // handshake, and a fresh offer is the way out of one. A peer we
        // *have* negotiated with is ICE's problem, and the connection state
        // machine owns it — re-offering there is how a working call gets
        // talked to death.
        if (isOfferer() && peerSessionId !== undefined && !remoteDescriptionSet) {
          void sendOffer();
        }
        scheduleNudge();
      }, delay);
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
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // A rejected candidate is one unusable network path, not a failed
        // call: the paths that do work are what this connection will use.
      }
    };

    const flushPendingCandidates = async (): Promise<void> => {
      const queued = pendingCandidates;
      pendingCandidates = [];
      for (const candidate of queued) {
        try {
          await pc?.addIceCandidate(candidate);
        } catch {
          // As above — letting one discarded path throw out of here used to
          // put the whole call on the error screen.
        }
      }
    };

    /**
     * Offers, one at a time. `force` is for the cases where a *new* offer
     * is genuinely warranted even though one is outstanding — the peer has
     * just announced itself, or this side has rebuilt its peer connection —
     * because the outstanding one was addressed to a peer or a connection
     * that is no longer the one we are negotiating with.
     */
    async function sendOffer(force = false): Promise<void> {
      if (!pc) return;
      if (offerInFlight && !force) return;
      offerInFlight = true;
      offerSentAtMs = Date.now();
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        offerSentAtMs = Date.now();
        send({ type: 'offer', appointmentId, payload: offer });
      } catch {
        // Releasing the flag is the point: a failed attempt must not lock
        // this side out of ever offering again.
        offerInFlight = false;
      }
    }

    async function handleRelayMessage(message: RelayMessage): Promise<void> {
      if (message.type === 'leave') {
        // The other party ended the call. `ended`, not `call-failed` — this
        // is expected, and the two must never be indistinguishable.
        if (live) endCall('peer-left');
        return;
      }

      if (message.type === 'ready') {
        const announced =
          (message.payload as { sessionId?: unknown; wantsOffer?: unknown; generation?: unknown } | null) ?? {};
        const incoming = typeof announced.sessionId === 'string' ? announced.sessionId : undefined;
        const known = peerSessionId;
        /**
         * **A different session id from a peer we already had is a
         * different page: they reloaded, or came back on another device.**
         *
         * The owner's own case — *"what if one of the joinee gets his call
         * … refreshed"* — and it used to leave the other side stuck. Their
         * generation counter restarts at 1, which is *not* greater than the
         * generation this side had already seen, so the rebuild went
         * undetected; and this side's `remoteDescriptionSet` was still true
         * from the negotiation with the page that no longer exists, so
         * nothing else asked for an offer either. Both parties then sat
         * looking at a frozen last frame.
         *
         * Everything known about their peer connection is void, and this
         * side's own is negotiated against media that has gone, so the
         * honest response is the one a failed connection already gets: put
         * a fresh peer connection under it.
         */
        const peerIsNewSession = incoming !== undefined && known !== undefined && incoming !== known;
        peerSessionId = incoming ?? known;
        peerPresent = true;
        if (peerIsNewSession) {
          peerGeneration = -1;
          // Sends its own `ready` (so they learn this side's id) and offers
          // if elected.
          retryConnection();
          scheduleNudge();
          return;
        }
        // **Answer a peer whose id we did not already have.** The election
        // needs both values on both sides: without this reply, a peer who
        // joined after our last nudge would know our id while we did not
        // know theirs, and each would fall back to the role guess — the
        // exact ambiguity the election exists to remove. Bounded by
        // construction: the reply only goes out when the id *changed*, so
        // two sides converge in three messages and stop.
        if (incoming !== undefined && incoming !== known) {
          sendReady();
        }
        // A peer on a *newer* peer connection than the one we have been
        // negotiating with needs a fresh offer whatever state this side is
        // in — that is a rebuild. A peer on the same one does not, unless
        // nothing was ever negotiated: re-offering into a connection that
        // is mid-ICE is how a working call gets talked to death.
        const generation = typeof announced.generation === 'number' ? announced.generation : 0;
        const peerRebuilt = generation > peerGeneration;
        peerGeneration = Math.max(peerGeneration, generation);
        if (isOfferer()) {
          if (pc && (peerRebuilt || !remoteDescriptionSet)) {
            // `force` **only** for a rebuild: the outstanding offer, if
            // any, was addressed to a peer connection that no longer
            // exists, so it will never be answered. Otherwise the
            // one-at-a-time rule stands — an offer is only re-sent once the
            // previous one is known to have bounced (`onPeerUnavailable`
            // clears the flag), because a fresh offer restarts ICE and
            // doing that every two seconds is how a handshake that was
            // merely slow becomes one that never finishes.
            void sendOffer(peerRebuilt);
          }
        } else if (pc && lastAnswer && remoteDescriptionSet && !isConnected()) {
          // The answerer's own recovery: it has answered, the call has not
          // come up, and the peer is asking again — so the answer is the
          // thing that went missing. Re-sent rather than renegotiated.
          send({ type: 'answer', appointmentId, payload: lastAnswer });
        }
        // Rescheduled rather than cancelled — see `scheduleNudge`.
        scheduleNudge();
        return;
      }

      // Anything else from the peer also proves they are there.
      peerPresent = true;
      scheduleNudge();
      if (!pc) return;
      try {
        if (message.type === 'offer') {
          // **Glare, handled rather than suffered.** Two offers can cross
          // in the instant before the election settles. The elected offerer
          // ignores the incoming one — theirs stands; the other side rolls
          // its own back and answers. Without this both sides reject each
          // other's offer and the call never negotiates at all, which is
          // precisely what a mis-resolved role used to cause.
          if (pc.signalingState === 'have-local-offer') {
            if (isOfferer()) return;
            try {
              await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
            } catch {
              // A browser that will not roll back leaves the
              // `setRemoteDescription` below to fail, which the catch at
              // the end of this function already treats as recoverable.
            }
          }
          await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          remoteDescriptionSet = true;
          offerInFlight = false;
          await flushPendingCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          lastAnswer = answer;
          send({ type: 'answer', appointmentId: message.appointmentId, payload: answer });
        } else if (message.type === 'answer') {
          // **2026-09-05: an answer that cannot be applied is recovered
          // from, not silently dropped.** Skipping on `signalingState`
          // alone left `remoteDescriptionSet` false, so a first answer
          // arriving at an awkward moment stranded every queued ICE
          // candidate for the life of the call. The two cases are not the
          // same and must not share an exit:
          if (pc.signalingState !== 'have-local-offer') {
            if (remoteDescriptionSet) {
              // Already answered — genuinely redundant, and a browser would
              // refuse it anyway.
              return;
            }
            // Nothing negotiated and no offer outstanding: the two sides
            // are out of step. A browser refuses this answer, so the way
            // back is a fresh offer, which is also what unsticks the queued
            // candidates.
            if (isOfferer()) {
              void sendOffer(true);
            }
            return;
          }
          await pc.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          remoteDescriptionSet = true;
          offerInFlight = false;
          await flushPendingCandidates();
        } else if (message.type === 'ice-candidate') {
          await addIceCandidate(message.payload as RTCIceCandidateInit);
        }
      } catch {
        // **Not the error screen.** A failed negotiation step is something
        // this call can still recover from — the peer is present, ICE may
        // already be gathering, and a fresh offer is one `ready` or one
        // nudge away. Tearing the whole call down over it turned every
        // transient SDP race into a dead call.
        offerInFlight = false;
        scheduleNudge();
      }
    }

    function buildPeerConnection(turnIceServer?: RTCIceServer): RTCPeerConnection {
      const iceServers = turnIceServer ? [...ICE_SERVERS, turnIceServer] : ICE_SERVERS;
      const created = new RTCPeerConnection({ iceServers });
      pcGeneration += 1;
      for (const track of stream.getTracks()) {
        created.addTrack(track, stream);
      }
      created.ontrack = (event) => {
        if (!live) return;
        // Both the audio and the video track arrive as separate `ontrack`
        // events carrying the *same* stream, so this is idempotent by
        // nature. A track with no stream at all is not a shape this
        // codebase ever sends, and is ignored rather than clearing a stream
        // that is already playing.
        const [remote] = event.streams;
        if (remote) {
          setRemoteStream(remote);
        }
      };
      created.onicecandidate = (event) => {
        if (!event.candidate) {
          // The end-of-candidates signal, which this codebase does not
          // relay.
          return;
        }
        const candidate = event.candidate.toJSON();
        if (signalling.current?.isOpen()) {
          send({ type: 'ice-candidate', appointmentId, payload: candidate });
          return;
        }
        unsentCandidates.push(candidate);
      };
      created.onconnectionstatechange = () => {
        const state = toCallConnectionState(created.connectionState);
        noteTurnConnectionState(state);
        stateMachine.handleConnectionState(state);
      };
      return created;
    }

    /**
     * **Closing a peer connection must not be heard as one failing, and
     * that is a bug fix.**
     *
     * `close()` fires `connectionstatechange` with `'closed'`, which
     * `toCallConnectionState` maps to `'disconnected'` — so the peer
     * connection being *replaced* fed a disconnect into the state machine
     * on its way out. The machine had already spent its one retry (that is
     * why it is being replaced), so three seconds later it declared the
     * call failed, whatever the freshly-built connection was doing.
     * Every retry was quietly on a three-second fuse, and the ones most
     * likely to need longer — mobile, TURN — were exactly the ones it cut
     * off.
     *
     * The other two handlers go with it: a dying connection has no business
     * pushing a track or an ICE candidate into a call that has moved on.
     */
    function discardPeerConnection(target: RTCPeerConnection | undefined): void {
      if (!target) return;
      target.onconnectionstatechange = null;
      target.ontrack = null;
      target.onicecandidate = null;
      target.close();
    }

    // TASK 4.3.3's own retry: a fresh `RTCPeerConnection` (never the failed
    // one, renegotiated) over the same already-joined call, with one TURN
    // attempt in front of it (TASK 4.4.1).
    function retryConnection(): void {
      void (async () => {
        const turnIceServer = await fetchTurnIceServer(accessToken, appointmentId);
        if (!live) return;
        discardPeerConnection(pc);
        remoteDescriptionSet = false;
        pendingCandidates = [];
        offerInFlight = false;
        // Both belonged to the peer connection just closed; re-sending
        // either would describe media that no longer exists.
        lastAnswer = undefined;
        unsentCandidates = [];
        usingTurn = Boolean(turnIceServer);
        // The old peer connection's tracks die with it, so the stream held
        // in state is now a frozen last frame. Cleared, so the caller sees
        // the honest "reconnecting" rather than a still image of the other
        // person that looks like a live call.
        setRemoteStream(undefined);
        pc = buildPeerConnection(turnIceServer);
        // The answerer cannot re-offer, so it says it is ready again and
        // the offerer does.
        sendReady();
        if (isOfferer()) {
          void sendOffer(true);
        }
        scheduleNudge();
      })();
    }

    const stateMachine = createCallStateMachine({
      onRetry: retryConnection,
      onStateChange: (lifecycle) => {
        if (lifecycle.kind === 'connected') {
          // A call that recovers gets its full allowance back: three bad
          // patches over ninety minutes is three separate problems, not one
          // budget spent.
          automaticRejoinsRef.current = 0;
          nudgeCount = 0;
          cancelNudge();
        }
        if (lifecycle.kind !== 'call-failed') {
          setStageIfLive({ kind: 'call', lifecycle });
          return;
        }
        // **A terminal ICE failure is no longer terminal for the call.**
        // The peer connection is beyond saving; the appointment is not. As
        // long as the window is open there is a whole call to rebuild —
        // socket, peer connection, TURN attempt — and doing it by bumping
        // `joinAttempt` re-runs this same effect rather than adding a
        // second path that does the same thing.
        if (automaticRejoinsRef.current < MAX_AUTOMATIC_REJOINS && windowOpenRef.current) {
          automaticRejoinsRef.current += 1;
          setStageIfLive({ kind: 'call', lifecycle: { kind: 'reconnecting' } });
          if (rejoinTimer !== undefined) clearTimeout(rejoinTimer);
          rejoinTimer = setTimeout(() => {
            rejoinTimer = undefined;
            if (live) setJoinAttempt((attempt) => attempt + 1);
          }, REJOIN_DELAY_MS);
          return;
        }
        // Terminal, and torn down with it — see `stopCall`.
        onLifecycleChangeRef.current?.(lifecycle);
        if (live) stopCall({ kind: 'call', lifecycle });
      },
    });

    // Told which end of the call this is only now, and never before the
    // socket exists: this callback drives the layout above, and a throw in
    // it used to take the whole join sequence with it and leave the screen
    // on a permanent "Connecting…".
    try {
      onRoleResolvedRef.current?.(role);
    } catch {
      // A layout that cannot render is not a reason to drop a call.
    }

    signalling.current = connectSignalling({
      url: signallingWebSocketUrl,
      token: accessToken,
      // A reconnect half an hour into a call needs a token that has not
      // expired since the first one opened the socket.
      refreshToken: () => client.authorization(),
      appointmentId,
      handlers: {
        /**
         * Fires on the first join **and on every re-join after a
         * reconnect**, which is why nothing here is unconditional. A socket
         * that came back while the media never stopped must not rebuild the
         * peer connection or reset the screen: the call is fine, and saying
         * "connecting" over a live conversation is a lie.
         */
        onJoined: () => {
          if (!pc) {
            pc = buildPeerConnection();
          }
          // Anything gathered while the socket was away. Sent before the
          // announcement, so the peer has the paths in hand by the time it
          // decides whether anything needs renegotiating.
          const queued = unsentCandidates;
          unsentCandidates = [];
          for (const candidate of queued) {
            send({ type: 'ice-candidate', appointmentId, payload: candidate });
          }
          if (!isConnected()) {
            setStageIfLive({ kind: 'call', lifecycle: { kind: 'connecting' } });
          }
          // Announce first, offer second, and both sides announce. Between
          // them these cover the two orderings completely: join second and
          // your `ready` reaches a peer who is already there; join first
          // and their `ready` reaches you.
          sendReady();
          if (isOfferer() && peerSessionId !== undefined && !remoteDescriptionSet) {
            void sendOffer(true);
          }
          scheduleNudge();
        },
        onJoinDenied: (reason) => {
          // No call is going to happen on this page — so the camera is let
          // go of, and nothing is left running that could overwrite the
          // server's own reason with a sentence of its own.
          if (live) stopCall({ kind: 'join-denied', reason });
        },
        onPeerUnavailable: () => {
          // Whatever bounced never reached anyone, so nothing is
          // outstanding — and clearing this is what lets the next nudge
          // re-send an offer that was lost.
          offerInFlight = false;
          // A bounce that arrives on a *connected* call is stale — one of
          // the messages sent while the peer was still absent, or a relay
          // race. Acting on it would restart negotiation on a connection
          // that is working.
          if (isConnected()) return;
          const wasPresent = peerPresent;
          peerPresent = false;
          // **The screen only changes if the peer had not already spoken.**
          // A bounce can legitimately be the reply to something sent before
          // they arrived, and "waiting for the other participant" over a
          // handshake that is mid-flight is a lie the caller will act on.
          // If they really have gone, the next bounce — after the nudge two
          // seconds from now — says so with `wasPresent` false.
          if (!wasPresent) setStageIfLive({ kind: 'waiting-for-peer' });
          // **Running out of nudges is not a failed call**, and there is no
          // longer a budget to run out of. The socket is open, the join was
          // accepted, and the honest "waiting for the other participant"
          // stays up until they arrive or the window closes.
          scheduleNudge();
        },
        onRelayMessage: (message) => void handleRelayMessage(message),
        onReconnecting: () => {
          // Only worth saying if the media has stopped too. A signalling
          // socket reconnecting under a healthy P2P call is invisible to
          // the people on it, and should stay that way.
          if (!isConnected()) {
            setStageIfLive({ kind: 'call', lifecycle: { kind: 'reconnecting' } });
          }
        },
        onSuperseded: () => {
          if (live) stopCall({ kind: 'superseded' });
        },
        // Reached only once reconnecting has given up — see
        // `webrtc-signalling-client.ts`. Until then a lost socket is a
        // reconnect, not an ending.
        onClose: (everOpened) => {
          if (!live) return;
          if (everOpened) {
            endCall('connection-lost');
            return;
          }
          // A socket that never opened at all is a setup failure, not a
          // call that ended — a misconfigured signalling URL, or a network
          // that was down before anything began. Saying "the connection was
          // lost" over a call that never started sends the caller looking
          // for a call they were never on.
          stopCall({ kind: 'error' });
        },
      },
    });

    return () => {
      live = false;
      cancelNudge();
      if (rejoinTimer !== undefined) clearTimeout(rejoinTimer);
      stateMachine.dispose();
      // Flushes any still-accumulating TURN time into the total this call
      // is about to report.
      noteTurnConnectionState('disconnected');
      // Sent unconditionally, whichever of the ways this effect came down —
      // this is the notification the other party's own `onRelayMessage`
      // reads to leave too, not only a best-effort telemetry report.
      // `turnDurationSeconds` stays honest: included only when this call
      // really did accumulate TURN time, never a fabricated zero.
      send({
        type: 'leave',
        appointmentId,
        payload: turnSecondsAccumulated > 0 ? { turnDurationSeconds: Math.round(turnSecondsAccumulated) } : {},
      });
      signalling.current?.close();
      discardPeerConnection(pc);
      // **The device stream is deliberately not stopped here.** It belongs
      // to the component, not to one attempt at a call — see
      // `releaseDevices`. Stopping it here is what made every rejoin a
      // call with dead tracks.
    };
    // `endCall`/`releaseDevices` are `useCallback`-stable, and the two
    // caller callbacks live in refs precisely so they cannot appear here.
  }, [session, deviceStream, joinRequested, joinAttempt, role, client, endCall, stopCall]);

  /** Whether a caller who is looking at a finished call still has an appointment to rejoin. */
  const canRejoin = phase === undefined || phase === 'open';

  const rejoinButton = canRejoin ? (
    <p>
      <button type="button" onClick={beginJoin}>
        {strings.rejoinLabel}
      </button>
    </p>
  ) : null;

  if (stage.kind === 'missing-appointment') {
    return <p role="alert">{strings.missingAppointmentLabel}</p>;
  }
  if (stage.kind === 'forbidden' || context?.kind === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (!session || !context) {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (context.kind === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  // Every terminal state, checked **before** the device check and the join
  // button so a caller who has left, been denied, or been superseded is
  // never shown the start of a call again as if none of it had happened —
  // and checked before the window phase so the specific reason a call
  // stopped beats the generic fact that its window has since closed.
  if (stage.kind === 'ended') {
    const endedLabel =
      stage.reason === 'time-limit'
        ? strings.timeLimitReachedLabel
        : stage.reason === 'connection-lost'
          ? strings.connectionLostLabel
          : stage.reason === 'peer-left'
            ? strings.peerLeftLabel
            : strings.disconnectedLabel;
    return (
      <section>
        <p role="status" aria-live="polite">
          {endedLabel}
        </p>
        {rejoinButton}
      </section>
    );
  }
  if (stage.kind === 'superseded') {
    return (
      <section>
        <p role="alert">{strings.supersededLabel}</p>
        {rejoinButton}
      </section>
    );
  }
  if (stage.kind === 'join-denied') {
    return <p role="alert">{strings.joinDeniedLabels[stage.reason]}</p>;
  }
  if (stage.kind === 'error') {
    return (
      <section>
        <p role="alert">{strings.errorLabel}</p>
        {rejoinButton}
      </section>
    );
  }
  if (stage.kind === 'call' && stage.lifecycle.kind === 'call-failed') {
    return (
      <section>
        <p role="alert">{strings.failedLabel}</p>
        {rejoinButton}
      </section>
    );
  }

  /**
   * **The window gate — *"Outside call window it should not let to have a
   * join call button (rather say it has expired or will start soon)."***
   *
   * Three phases, the same three `ws-join.ts` enforces and `JoinCallCell`
   * already shows on every appointment list, so what a person can press
   * and what the server will accept agree by construction.
   */
  //
  // Gated on `!joinRequested` throughout: a call already under way is ended
  // by its own deadline (which is never later than the window's end), and
  // letting this gate unmount the call stage a render *before* that
  // happened would replace a live conversation with a notice, then replace
  // the notice with the real reason a moment later.
  if (phase === 'expired' && !joinRequested) {
    return <p role="status">{strings.expiredLabel}</p>;
  }
  if (appointment && appointment.status !== 'scheduled' && !joinRequested) {
    // The booking is not one to turn up to. `ws-join.ts` would refuse it
    // with these exact two reasons; saying so before the camera prompt is
    // strictly kinder than saying it after.
    return (
      <p role="alert">
        {appointment.status === 'pending-approval'
          ? strings.joinDeniedLabels['not-confirmed']
          : strings.joinDeniedLabels.cancelled}
      </p>
    );
  }
  if (countdown !== undefined && !joinRequested) {
    return (
      <p role="status" aria-live="polite">
        {t('videoCall.tooEarly', { countdown: formatCountdown(countdown, countdownUnits(locale)) }, locale)}
      </p>
    );
  }

  if (!deviceStream) {
    return (
      <DeviceCheck
        strings={strings.deviceCheck}
        // A rejoin does not ask the caller to choose devices they have
        // already chosen — permission is granted by now, so this is a
        // silent re-acquire rather than a second prompt.
        autoContinue={devicesConfirmed}
        onReady={(stream) => {
          setDevicesConfirmed(true);
          setDeviceStream(stream);
        }}
      />
    );
  }
  if (!joinRequested) {
    return <JoinCallButton strings={strings.joinCall} onJoin={beginJoin} />;
  }

  const statusLabel =
    stage.kind === 'waiting-for-peer'
      ? strings.waitingForPeerLabel
      : stage.kind === 'call' && stage.lifecycle.kind === 'connected'
        ? strings.connectedLabel
        : stage.kind === 'call' && stage.lifecycle.kind === 'reconnecting'
          ? strings.reconnectingLabel
          : strings.connectingLabel;

  const endingSoon = remainingMs !== undefined && remainingMs <= ENDING_SOON_MS;

  return (
    <section aria-labelledby="video-call-status-heading">
      <div style={CALL_HEADER_STYLE}>
        <p id="video-call-status-heading" role="status" aria-live="polite" style={{ margin: 0 }}>
          {statusLabel}
        </p>
        {/* **The timer the owner asked for.** `role="timer"` with no live
            region: a screen reader must not read a number out once a
            second. The one thing worth announcing — that the call is about
            to end — is announced once, politely, below. */}
        {remainingMs !== undefined && (
          <p
            role="timer"
            // **The label carries the value, and that is the fix for a
            // defect in the first version of this timer.** An `aria-label`
            // *replaces* an element's text content for a screen reader, so
            // naming the countdown without including the number left a
            // screen-reader user hearing "Time remaining before this call
            // ends" and never once hearing how long that was. Resolved
            // here rather than passed in as a prop for the reason the
            // countdown above it already is: it changes while the page is
            // open, and every prop on `strings` is resolved once at
            // page-render time.
            aria-label={t(
              'videoCall.timeRemainingLabel',
              { time: formatRemaining(remainingMs) },
              locale,
            )}
            style={endingSoon ? WARNING_STYLE : TIMER_STYLE}
          >
            {t('videoCall.timeRemaining', { time: formatRemaining(remainingMs) }, locale)}
          </p>
        )}
      </div>
      {/* Rendered only in the last stretch, so it is announced when it
          appears and not repeatedly. */}
      {endingSoon && (
        <p role="status" aria-live="polite">
          {t('videoCall.endingSoon', undefined, locale)}
        </p>
      )}
      {/* 2026-09-04: the layout the owner asked for — *"so that we see each
          other's videos (along with ours in a small box in bottom right)"*.
          The stage owns the aspect ratio so the frame does not resize as
          streams come and go, and the self-view is positioned inside it
          rather than after it. Inline styles rather than a stylesheet:
          `apps/web` ships no CSS pipeline for islands, and the CSP already
          allows `style-src 'unsafe-inline'` (`infra/src/web-stack.ts`). */}
      <div style={fillWidth ? CALL_STAGE_FILL_STYLE : CALL_STAGE_STYLE}>
        <video
          ref={setRemoteVideoEl}
          aria-label={strings.remoteVideoLabel}
          autoPlay
          playsInline
          style={REMOTE_VIDEO_STYLE}
        />
        {/* Until the other party's video arrives there is nothing to show
            but black, which is indistinguishable from a broken call. And
            once it has arrived, a call that started audio-only still shows
            black until they turn their camera on — the app working as
            asked, and identical to the fault the owner reported twice. */}
        {!remoteStream && <p style={REMOTE_PLACEHOLDER_STYLE}>{statusLabel}</p>}
        {remoteStream && !remoteCameraOn && (
          <p style={REMOTE_PLACEHOLDER_STYLE}>{strings.remoteCameraOffLabel}</p>
        )}
        {/* Mirrored, the way every video call mirrors a self-view. The
            remote video is never mirrored — that one is another person, and
            flipping them would reverse any text they hold up. Kept mounted
            while the camera is off, so the element and its stream survive
            the toggle and switching back on is instant. */}
        <video
          ref={setLocalVideoEl}
          aria-label={strings.localVideoLabel}
          autoPlay
          playsInline
          muted
          style={LOCAL_VIDEO_STYLE}
        />
        {!cameraOn && <p style={LOCAL_PLACEHOLDER_STYLE}>{strings.cameraOffLabel}</p>}
      </div>
      <div style={CALL_CONTROLS_STYLE}>
        {/* `aria-pressed` rather than two unrelated buttons: this is one
            control with a state, and a screen reader should say which state
            it is in rather than leaving that to be inferred. */}
        <button type="button" aria-pressed={cameraOn} onClick={() => setCameraOn((on) => !on)}>
          {cameraOn ? strings.turnCameraOffLabel : strings.turnCameraOnLabel}
        </button>
        <button type="button" onClick={() => endCall('left')}>
          {strings.leaveLabel}
        </button>
      </div>
    </section>
  );
}
