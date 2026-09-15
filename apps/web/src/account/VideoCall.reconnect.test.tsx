// @vitest-environment jsdom
//
// 2026-09-15: a **two-party** harness, because every prior test drives one
// side against a socket and a peer connection the test plays by hand — and
// the reload/rejoin hang is an *interaction* between the two sides that no
// single-party test can reach. Here two real `VideoCall` islands are wired
// to each other through one in-memory relay that keeps the server's own two
// rules (route to the most-recently-joined live participant; a principal
// rejoining retires their earlier row) and peer connections that actually
// reach `connected` once descriptions have crossed. The point is to answer
// one question the owner keeps asking: after a reload, do the two sides
// connect again on their own?
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoCall } from './VideoCall.js';
import type { VideoCallStrings } from './VideoCall.js';

const STRINGS: VideoCallStrings = {
  loadingLabel: 'Setting up your call…',
  forbiddenLabel: 'No access.',
  missingAppointmentLabel: 'Missing appointment.',
  errorLabel: 'Something went wrong.',
  waitingForPeerLabel: 'Waiting for the other participant…',
  connectingLabel: 'Connecting…',
  connectedLabel: 'Connected.',
  reconnectingLabel: 'Reconnecting…',
  disconnectedLabel: 'The call has ended.',
  failedLabel: 'This call could not connect.',
  joinDeniedLabels: {
    'too-early': 'Too early.',
    'too-late': 'Too late.',
    cancelled: 'Cancelled.',
    'not-confirmed': 'Not confirmed.',
    'not-your-appointment': 'Not yours.',
    'not-available': 'Not available.',
  },
  localVideoLabel: 'Your camera',
  remoteVideoLabel: "The other participant's camera",
  deviceCheck: {
    requestingLabel: 'Requesting…',
    deniedLabel: 'Denied.',
    unavailableLabel: 'Unavailable.',
    errorLabel: 'Device error.',
    previewLabel: 'Preview',
    cameraLabel: 'Camera',
    microphoneLabel: 'Microphone',
    confirmLabel: 'Confirm',
  },
  leaveLabel: 'Leave call',
  turnCameraOnLabel: 'Turn on camera',
  turnCameraOffLabel: 'Turn off camera',
  cameraOffLabel: 'Your camera is off',
  remoteCameraOffLabel: "The other participant's camera is off.",
  timeLimitReachedLabel: 'Time limit reached.',
  expiredLabel: 'Expired.',
  rejoinLabel: 'Rejoin call',
  supersededLabel: 'Opened in another window.',
  connectionLostLabel: 'Connection lost for good.',
  peerLeftLabel: 'The other participant left.',
};

/** One appointment, its slot open right now. `pat-1` is the patient half. */
const SCHEDULED_AT = new Date(Date.now() - 60_000).toISOString();
const APPOINTMENT_ID = `pat-1#${SCHEDULED_AT}`;

function fakeStream(): MediaStream {
  const track = (kind: 'video' | 'audio') =>
    ({
      kind,
      enabled: true,
      muted: kind === 'video',
      stop() {},
      getSettings: () => ({ deviceId: `${kind}-1` }),
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaStreamTrack;
  const tracks = [track('video'), track('audio')];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

// ---------------------------------------------------------------------------
// The relay: two rules, the server's own. Route to the most-recently-joined
// live participant; a principal rejoining retires their earlier row.
// ---------------------------------------------------------------------------
interface Row {
  connectionId: string;
  principalId: string;
  appointmentId: string;
  joinedAt: number;
  left: boolean;
}

class Relay {
  rows: Row[] = [];
  sockets = new Map<string, RelaySocket>();
  seq = 0;

  register(socket: RelaySocket): void {
    this.sockets.set(socket.connectionId, socket);
  }

  join(connectionId: string, principalId: string, appointmentId: string): string[] {
    const superseded = this.rows
      .filter((r) => r.principalId === principalId && r.connectionId !== connectionId && !r.left)
      .map((r) => r.connectionId);
    superseded.forEach((id) => {
      const row = this.rows.find((r) => r.connectionId === id);
      if (row) row.left = true;
    });
    this.rows.push({ connectionId, principalId, appointmentId, joinedAt: (this.seq += 1), left: false });
    return superseded;
  }

  disconnect(connectionId: string): void {
    // A dropped socket only detaches; the CALL# row lingers until the
    // principal rejoins (retire) — the server's own behaviour.
    this.sockets.delete(connectionId);
  }

  private otherParty(fromConnectionId: string): Row | undefined {
    const from = this.rows.find((r) => r.connectionId === fromConnectionId);
    if (!from) return undefined;
    let chosen: Row | undefined;
    for (const r of this.rows) {
      if (r.left || r.appointmentId !== from.appointmentId || r.connectionId === fromConnectionId) continue;
      if (!this.sockets.has(r.connectionId)) continue; // a detached socket is gone
      if (!chosen || r.joinedAt > chosen.joinedAt) chosen = r;
    }
    return chosen;
  }

  route(fromConnectionId: string, message: Record<string, unknown>): void {
    const other = this.otherParty(fromConnectionId);
    if (!other) {
      this.sockets.get(fromConnectionId)?.receive({ type: 'peer-unavailable' });
      return;
    }
    this.sockets.get(other.connectionId)?.receive(message);
  }
}

let relay: Relay;
/** When true, `POST …/turn-credentials` never resolves — the cold-Lambda case. */
let turnCredentialsHang = false;
const principalForToken: Record<string, string> = {
  'patient-token': 'patient-principal',
  'clinician-token': 'clinician-principal',
};

class RelaySocket {
  static OPEN = 1;
  static seq = 0;
  readyState = 0;
  readonly connectionId = `conn-${(RelaySocket.seq += 1)}`;
  readonly token: string;
  private appointmentId = '';
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.token = new URL(url).searchParams.get('token') ?? '';
    relay.register(this);
    // Opens on a microtask, the way a real socket resolves after construction.
    queueMicrotask(() => {
      this.readyState = RelaySocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (typeof message.appointmentId === 'string') this.appointmentId = message.appointmentId;
    if (message.type === 'join') {
      relay.join(this.connectionId, principalForToken[this.token] ?? 'unknown', this.appointmentId);
      this.receive({ type: 'joined' });
      return;
    }
    if (message.type === 'ping') {
      this.receive({ type: 'pong' });
      return;
    }
    relay.route(this.connectionId, message);
  }

  receive(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  close(): void {
    this.readyState = 3;
    relay.disconnect(this.connectionId);
    this.emit('close', {});
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

// ---------------------------------------------------------------------------
// Peer connections that actually complete: once a side has both a local and a
// remote description, it reaches `connected` a tick later (ICE, modelled).
// ---------------------------------------------------------------------------
function remoteStream(): MediaStream {
  return fakeStream();
}

class NetworkedPeerConnection {
  static instances: NetworkedPeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private hasLocal = false;
  private hasRemote = false;
  private closed = false;

  constructor() {
    NetworkedPeerConnection.instances.push(this);
  }

  addTrack(): void {}

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: `offer-${Math.random()}` });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'answer', sdp: `answer-${Math.random()}` });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    this.hasLocal = true;
    // A candidate, so the ice-candidate path is exercised end to end.
    queueMicrotask(() =>
      this.onicecandidate?.({
        candidate: { toJSON: () => ({ candidate: 'a=candidate:1' }) } as unknown as RTCIceCandidate,
      }),
    );
    this.maybeConnect();
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer') {
      return Promise.reject(Object.assign(new Error('bad state'), { name: 'InvalidStateError' }));
    }
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.hasRemote = true;
    this.maybeConnect();
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  private maybeConnect(): void {
    if (!this.hasLocal || !this.hasRemote || this.closed || this.connectionState === 'connected') return;
    setTimeout(() => {
      if (this.closed || this.connectionState === 'connected') return;
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
      this.ontrack?.({ streams: [remoteStream()] });
    }, 5);
  }

  close(): void {
    this.closed = true;
  }
}

function clientFor(token: string) {
  return { authorization: () => Promise.resolve(token) } as never;
}

beforeEach(() => {
  relay = new Relay();
  turnCredentialsHang = false;
  RelaySocket.seq = 0;
  NetworkedPeerConnection.instances = [];
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.resolve(fakeStream())),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    },
  });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  vi.stubGlobal('WebSocket', RelaySocket);
  vi.stubGlobal('RTCPeerConnection', NetworkedPeerConnection);
  // Role + appointment resolution, keyed by which token is asking. The
  // clinician's calendar answers only for the clinician; both resolve the
  // one appointment row (its window is open).
  const row = {
    patientId: 'pat-1',
    scheduledAt: SCHEDULED_AT,
    durationMinutes: 30,
    appointment_status: 'scheduled',
  };
  const ok = { ok: true, status: 200, json: () => Promise.resolve({ items: [row] }) } as unknown as Response;
  const forbidden = { ok: false, status: 403 } as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      const isClinician = auth.includes('clinician-token');
      if (url.includes('/clinicians/me/calendar')) {
        return Promise.resolve(isClinician ? ok : forbidden);
      }
      if (url.includes('/patients/me/appointments')) {
        return Promise.resolve(ok);
      }
      if (url.includes('/turn-credentials')) {
        // A cold credentials Lambda: the request never comes back within the
        // life of the call. The reload path must not depend on it.
        if (turnCredentialsHang) return new Promise<Response>(() => {});
        return Promise.resolve(forbidden);
      }
      return Promise.resolve(forbidden);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderParty(token: string) {
  return render(
    <VideoCall
      strings={STRINGS}
      client={clientFor(token)}
      getAppointmentId={() => APPOINTMENT_ID}
      locale="en"
    />,
  );
}

/** Click Confirm and wait for the call stage (the Leave button). */
async function confirmAndJoin(view: ReturnType<typeof renderParty>) {
  const confirm = await within(view.container).findByRole('button', {
    name: STRINGS.deviceCheck.confirmLabel,
  });
  fireEvent.click(confirm);
  await within(view.container).findByRole('button', { name: STRINGS.leaveLabel });
}

async function bothConnected(patient: ReturnType<typeof renderParty>, clinician: ReturnType<typeof renderParty>) {
  await waitFor(
    () => {
      expect(within(patient.container).queryAllByText(STRINGS.connectedLabel).length).toBeGreaterThan(0);
      expect(within(clinician.container).queryAllByText(STRINGS.connectedLabel).length).toBeGreaterThan(0);
    },
    { timeout: 4000 },
  );
}

describe('two real parties on one call', () => {
  it('connects the first time', async () => {
    const clinician = renderParty('clinician-token');
    const patient = renderParty('patient-token');
    await confirmAndJoin(clinician);
    await confirmAndJoin(patient);
    await bothConnected(patient, clinician);
  });

  it('reconnects after the patient reloads (unmount + fresh mount)', async () => {
    const clinician = renderParty('clinician-token');
    let patient = renderParty('patient-token');
    await confirmAndJoin(clinician);
    await confirmAndJoin(patient);
    await bothConnected(patient, clinician);

    // The patient reloads: the island goes away and a brand-new one mounts,
    // exactly as a page reload or a navigate-away-and-back does.
    patient.unmount();
    patient = renderParty('patient-token');
    await confirmAndJoin(patient);

    // The whole point: both sides come back to `connected` on their own.
    await bothConnected(patient, clinician);
  });

  // **The regression this whole harness exists for.** The rebuild used to
  // `await` the TURN-credential request before discarding the old peer
  // connection; a reload triggers that rebuild and the credentials Lambda is
  // cold, so the request hung for seconds while a nudge, arriving in the
  // window, made the still-current (dying) connection negotiate — leaving the
  // two ends describing different media, never to connect. With the reload
  // path rebuilding STUN-first and synchronously, a hung credentials endpoint
  // cannot hold the reconnect up at all.
  it('reconnects on reload even when the TURN endpoint is hung (a cold Lambda)', async () => {
    const clinician = renderParty('clinician-token');
    let patient = renderParty('patient-token');
    await confirmAndJoin(clinician);
    await confirmAndJoin(patient);
    await bothConnected(patient, clinician);

    turnCredentialsHang = true;
    patient.unmount();
    patient = renderParty('patient-token');
    await confirmAndJoin(patient);

    await bothConnected(patient, clinician);
  });

  it('reconnects when the patient navigates back and rejoins several times', async () => {
    const clinician = renderParty('clinician-token');
    let patient = renderParty('patient-token');
    await confirmAndJoin(clinician);
    await confirmAndJoin(patient);
    await bothConnected(patient, clinician);

    for (let round = 0; round < 3; round += 1) {
      patient.unmount();
      patient = renderParty('patient-token');
      await confirmAndJoin(patient);
      await bothConnected(patient, clinician);
    }
  });
});
