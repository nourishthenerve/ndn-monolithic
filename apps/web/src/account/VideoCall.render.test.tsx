// @vitest-environment jsdom
//
// 2026-09-04: the first rendered test of `VideoCall.tsx`.
//
// `video-calls.md` records why there was none — importing this component
// pulls its whole `RTCPeerConnection`-touching body into the repo's
// coverage gate — and that reasoning held while nothing here was reported
// broken. It is no longer the right trade: the owner has now reported this
// screen twice, and the second report (*"i'm not seeing my own video in the
// smaller box"*) was a **render-ordering** bug that no amount of testing
// the pure helpers could have caught.
//
// The harness is a socket and a peer connection the test drives by hand —
// nothing opens or negotiates on its own, so each test says exactly how far
// the call got before asserting. The fakes implement only what this
// component calls: WebRTC's own behaviour is the browser's to get right,
// and a fake elaborate enough to model it would be a second implementation
// to keep correct rather than a test.
//
// The first three groups never open the socket at all, which is why they
// need no peer connection: everything they assert happens between "the
// caller pressed Join" and "a socket opened".
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_CALL_MINUTES, VideoCall } from './VideoCall.js';
import type { VideoCallStrings } from './VideoCall.js';

const STRINGS: VideoCallStrings = {
  loadingLabel: 'Setting up your call…',
  forbiddenLabel: 'You do not have access to this page.',
  missingAppointmentLabel: 'This link is missing its appointment.',
  errorLabel: 'Something went wrong.',
  waitingForPeerLabel: 'Waiting for the other participant to join…',
  connectingLabel: 'Connecting…',
  connectedLabel: 'Connected.',
  reconnectingLabel: 'Connection lost. Reconnecting…',
  disconnectedLabel: 'The call has ended.',
  failedLabel: 'This call could not connect.',
  joinDeniedLabels: {
    'too-early': 'Not yet time.',
    'too-late': 'Window closed.',
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
    continueLabel: 'Continue',
  },
  joinCall: { label: 'Join call' },
  leaveLabel: 'Leave call',
  turnCameraOnLabel: 'Turn on camera',
  turnCameraOffLabel: 'Turn off camera',
  cameraOffLabel: 'Your camera is off',
  remoteCameraOffLabel: "The other participant's camera is off.",
  timeLimitReachedLabel: 'This call has reached its time limit and has ended.',
  expiredLabel: 'This appointment has expired.',
  rejoinLabel: 'Rejoin call',
  supersededLabel: 'This call was opened in another window.',
  connectionLostLabel: 'The connection was lost and could not be restored.',
  peerLeftLabel: 'The other participant has left the call.',
};

/** The appointment id `call.astro` would have put on the query string. */
const APPOINTMENT_ID = 'pat-1#2020-01-01T00:00:00.000Z';

/**
 * **2026-09-07: who offers is decided by the two session ids, not by role.**
 *
 * Each side coins a random id on joining and the greater one offers, so a
 * test that wants this browser to be the offerer sends a peer id that sorts
 * below every id `createSessionId` can produce, and vice versa.
 * `createSessionId` returns a UUID (or a fallback starting with a base-36
 * digit), so every real id starts with `[0-9a-z]` — `'!'` (0x21) is below
 * all of them and `'~'` (0x7e) is above all of them.
 */
const PEER_ID_LOWER = '!peer-loses-the-election';
const PEER_ID_HIGHER = '~peer-wins-the-election';

/**
 * One party announcing itself. `generation` is which incarnation of *their*
 * peer connection it is: a higher one than last time means they have
 * rebuilt and need a fresh offer, which is what tells a rebuild apart from
 * an ordinary nudge.
 */
function peerReady(sessionId: string, generation = 1, wantsOffer = true) {
  return {
    type: 'ready',
    appointmentId: APPOINTMENT_ID,
    payload: { sessionId, generation, wantsOffer },
  };
}

interface FakeTrack {
  kind: 'video' | 'audio';
  enabled: boolean;
  /** The receiving end of the sender disabling a track — what tells us their camera is off. */
  muted: boolean;
  stopped: boolean;
  stop(): void;
  getSettings(): Record<string, string>;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
  /** Test-only: flips `muted` and fires the event a browser would. */
  setMuted(muted: boolean): void;
}

function track(kind: 'video' | 'audio'): FakeTrack {
  const handlers = new Map<string, (() => void)[]>();
  return {
    kind,
    // Real `getUserMedia` hands back enabled tracks — the component is what
    // turns the camera off, and starting these `false` would let a broken
    // implementation pass.
    enabled: true,
    // A freshly negotiated remote video track whose sender has it disabled
    // arrives muted, which is the ordinary state of an audio-only call.
    muted: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
    getSettings: () => ({ deviceId: `${kind}-1` }),
    addEventListener(type, handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    removeEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== handler));
    },
    setMuted(muted) {
      this.muted = muted;
      for (const handler of handlers.get(muted ? 'mute' : 'unmute') ?? []) {
        handler();
      }
    },
  };
}

let videoTrack: FakeTrack;
let audioTrack: FakeTrack;

function fakeStream() {
  videoTrack = track('video');
  audioTrack = track('audio');
  const tracks = [videoTrack, audioTrack];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
  } as unknown as MediaStream;
}

/**
 * A socket the test drives by hand. It starts closed and only opens when a
 * test says so, which is what lets the first half of this suite assert on
 * the pre-connection UI without ever constructing a peer connection.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static last: FakeWebSocket | undefined;
  /** 2026-09-07: every socket ever made, so "did it reconnect / rebuild" is a question a test can ask. */
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  close = vi.fn(() => {
    this.readyState = 3;
  });

  /**
   * The network taking the socket away — a lid closing, a tunnel, or API
   * Gateway's own ten-minute idle quota. Distinct from `close()`, which is
   * this browser hanging up: only one of the two fires a `close` event that
   * the reconnect path is listening for.
   */
  drop(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  constructor() {
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  /** Everything this socket has sent of one type, oldest first. */
  sentOf(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message.type === type);
  }
}

/**
 * Enough `RTCPeerConnection` for the signalling sequence to run: this
 * suite is about which messages are sent and what the screen says, not
 * about WebRTC's own behaviour, which is the browser's to get right.
 */
class FakePeerConnection {
  static last: FakePeerConnection | undefined;
  static instances: FakePeerConnection[] = [];

  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  readonly added: MediaStreamTrack[] = [];
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  addIceCandidate = vi.fn(() => Promise.resolve());

  constructor() {
    FakePeerConnection.last = this;
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: MediaStreamTrack): void {
    this.added.push(track);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0 offer' });
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'answer', sdp: 'v=0 answer' });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
    return Promise.resolve();
  }

  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    // Mirrors the browser: applying an answer when no offer is outstanding
    // is an error, and it is exactly the case the 2026-09-05 fix is about.
    if (description.type === 'answer' && this.signalingState !== 'have-local-offer') {
      return Promise.reject(
        Object.assign(new Error('wrong state'), { name: 'InvalidStateError' }),
      );
    }
    this.remoteDescriptions.push(description);
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    return Promise.resolve();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.resolve(fakeStream())),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    },
  });
  // jsdom implements neither, and both are called on the elements below.
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  FakeWebSocket.last = undefined;
  FakeWebSocket.instances = [];
  FakePeerConnection.last = undefined;
  FakePeerConnection.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  // `resolveRole` asks `GET /clinicians/me/calendar` and reads only whether
  // it was allowed: refused means this caller is the patient, which is the
  // offerer. `asClinician()` below flips it.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: false, status: 403 } as Response)),
  );
});

/** The other role: a 200 from the clinician calendar is what proves it. */
function asClinician(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response)),
  );
}

/**
 * 2026-09-07: an appointment id whose slot starts `offsetMs` from now.
 *
 * The window gate and the drop deadline are both about *this* appointment's
 * own clock, and the fixed 2020 id above deliberately resolves to no
 * appointment at all — which is its own (equally real) case.
 */
function appointmentIdAt(offsetMs: number): string {
  return `pat-1#${new Date(Date.now() + offsetMs).toISOString()}`;
}

/**
 * The two list endpoints `call-appointment.ts` probes, answering with one
 * real row — which is what gives this screen a `durationMinutes` and
 * therefore a window it can reason about at all.
 */
function withAppointment(options: {
  readonly id: string;
  readonly durationMinutes: number;
  readonly status?: string;
  readonly clinician?: boolean;
}): void {
  const row = {
    patientId: 'pat-1',
    scheduledAt: options.id.slice(options.id.indexOf('#') + 1),
    durationMinutes: options.durationMinutes,
    appointment_status: options.status ?? 'scheduled',
  };
  const listed = {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items: [row] }),
  } as unknown as Response;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/clinicians/me/calendar')) {
        return Promise.resolve(
          options.clinician ? listed : ({ ok: false, status: 403 } as Response),
        );
      }
      if (url.includes('/patients/me/appointments')) {
        return Promise.resolve(listed);
      }
      return Promise.resolve({ ok: false, status: 403 } as Response);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const client = { authorization: () => Promise.resolve('a.b.c') } as never;
const getAppointmentId = () => APPOINTMENT_ID;

function renderCall(appointmentId: string = APPOINTMENT_ID) {
  return render(
    <VideoCall
      strings={STRINGS}
      client={client}
      getAppointmentId={appointmentId === APPOINTMENT_ID ? getAppointmentId : () => appointmentId}
      locale="en"
    />,
  );
}

/** Device check → Continue → Join call: the two presses that precede every test below. */
async function joinTheCall() {
  fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
  fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
  await screen.findByRole('button', { name: STRINGS.leaveLabel });
}

// **The reported bug.** *"i'm not seeing my own video in the smaller box."*
//
// The local preview's effect ran on `[deviceStream]` alone. That is set the
// moment `DeviceCheck` hands over — while the render is still showing the
// Join button, so no `<video>` was mounted, `localVideoRef.current` was
// `null`, and the effect did nothing. It never ran again, so the element
// mounted a moment later with no `srcObject` and stayed black for the whole
// call. The screenshot showed exactly that: the other person full-frame,
// the inset box solid black.
describe('the self-view', () => {
  it('has the camera stream attached once the call starts', async () => {
    const { container } = renderCall();
    await joinTheCall();

    const local = container.querySelector<HTMLVideoElement>(
      `video[aria-label="${STRINGS.localVideoLabel}"]`,
    );
    expect(local).not.toBeNull();
    // The element mounts *after* the stream exists, which is the ordering
    // that used to lose it.
    expect(local?.srcObject).toBeDefined();
    expect(local?.srcObject).not.toBeNull();
  });

  it('is muted, so a caller never hears themselves', async () => {
    const { container } = renderCall();
    await joinTheCall();
    // The *property*, not the attribute: React sets `muted` on the element
    // and never reflects it to markup, so `hasAttribute('muted')` is false
    // on a correctly-muted video.
    const local = container.querySelector<HTMLVideoElement>(
      `video[aria-label="${STRINGS.localVideoLabel}"]`,
    );
    expect(local?.muted).toBe(true);
  });

  it('does not mute the other participant', async () => {
    const { container } = renderCall();
    await joinTheCall();
    const remote = container.querySelector<HTMLVideoElement>(
      `video[aria-label="${STRINGS.remoteVideoLabel}"]`,
    );
    expect(remote?.muted).toBe(false);
  });
});

// *"start the video call by default with audio only and have a separate
// button to turn the video on."*
describe('starting audio only', () => {
  it('joins with the camera track disabled', async () => {
    renderCall();
    await joinTheCall();
    await waitFor(() => {
      expect(videoTrack.enabled).toBe(false);
    });
  });

  it('leaves the microphone alone — audio only means audio, not silence', async () => {
    renderCall();
    await joinTheCall();
    expect(audioTrack.enabled).toBe(true);
  });

  it('says the camera is off, rather than showing an unexplained black box', async () => {
    // The owner has already reported one black self-view as a bug. A
    // deliberate "camera off" must not look like that one.
    renderCall();
    await joinTheCall();
    expect(screen.getByText(STRINGS.cameraOffLabel)).toBeDefined();
  });

  it('turns the camera on from the button, and off again', async () => {
    renderCall();
    await joinTheCall();

    fireEvent.click(screen.getByRole('button', { name: STRINGS.turnCameraOnLabel }));
    await waitFor(() => {
      expect(videoTrack.enabled).toBe(true);
    });
    expect(screen.queryByText(STRINGS.cameraOffLabel)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: STRINGS.turnCameraOffLabel }));
    await waitFor(() => {
      expect(videoTrack.enabled).toBe(false);
    });
    expect(screen.getByText(STRINGS.cameraOffLabel)).toBeDefined();
  });

  it('reports its state to a screen reader rather than leaving it to the label', async () => {
    renderCall();
    await joinTheCall();
    const toggle = screen.getByRole('button', { name: STRINGS.turnCameraOnLabel });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: STRINGS.turnCameraOffLabel }).getAttribute('aria-pressed'),
      ).toBe('true');
    });
  });
});

// *"if the video call length is 30 mins the call should be dropped
// automatically."*
describe('the 30-minute limit', () => {
  it('is 30 minutes, from a named constant rather than a buried number', () => {
    expect(MAX_CALL_MINUTES).toBe(30);
  });

  it('does not end a call that has not reached it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCall();
    await joinTheCall();

    await act(async () => {
      vi.advanceTimersByTime((MAX_CALL_MINUTES - 1) * 60_000);
    });
    expect(screen.getByRole('button', { name: STRINGS.leaveLabel })).toBeDefined();
    expect(screen.queryByText(STRINGS.timeLimitReachedLabel)).toBeNull();
  });

  it('ends the call once it does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCall();
    await joinTheCall();

    await act(async () => {
      vi.advanceTimersByTime(MAX_CALL_MINUTES * 60_000);
    });
    expect(await screen.findByText(STRINGS.timeLimitReachedLabel)).toBeDefined();
    // Really ended, not merely relabelled: the call controls are gone.
    expect(screen.queryByRole('button', { name: STRINGS.leaveLabel })).toBeNull();
  });

  it('releases the camera when it does', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCall();
    await joinTheCall();

    await act(async () => {
      vi.advanceTimersByTime(MAX_CALL_MINUTES * 60_000);
    });
    // A call that dropped itself must not leave the camera held — the
    // teardown runs the same path "Leave call" does.
    await waitFor(() => {
      expect(videoTrack.stopped).toBe(true);
    });
  });

  it('says the time ran out, not the generic "call has ended"', async () => {
    // On a call nobody ended, "The call has ended." reads as a failure.
    // The difference between running out of time and something breaking is
    // what decides whether the person tries again.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCall();
    await joinTheCall();

    await act(async () => {
      vi.advanceTimersByTime(MAX_CALL_MINUTES * 60_000);
    });
    await screen.findByText(STRINGS.timeLimitReachedLabel);
    expect(screen.queryByText(STRINGS.disconnectedLabel)).toBeNull();
  });

  it('still reports an ordinary hang-up as an ordinary hang-up', async () => {
    renderCall();
    await joinTheCall();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.leaveLabel }));
    expect(await screen.findByText(STRINGS.disconnectedLabel)).toBeDefined();
  });
});

describe('before the call', () => {
  it('says so when the link carries no appointment', async () => {
    render(
      <VideoCall
        strings={STRINGS}
        client={client}
        getAppointmentId={() => undefined}
        locale="en"
      />,
    );
    expect(await screen.findByText(STRINGS.missingAppointmentLabel)).toBeDefined();
  });

  it('is forbidden with no session at all', async () => {
    render(
      <VideoCall
        strings={STRINGS}
        client={{ authorization: () => Promise.resolve(undefined) } as never}
        getAppointmentId={getAppointmentId}
        locale="en"
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('checks devices before offering to join, and offers to join before opening anything', async () => {
    renderCall();
    // `DeviceCheck` first: the join button does not exist until a stream
    // has been handed over.
    expect(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel })).toBeDefined();
    expect(screen.queryByRole('button', { name: STRINGS.joinCall.label })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    expect(await screen.findByRole('button', { name: STRINGS.joinCall.label })).toBeDefined();
    // Nothing has been opened yet — pressing Join is what starts the call.
    expect(screen.queryByRole('button', { name: STRINGS.leaveLabel })).toBeNull();
  });
});

// The signalling sequence itself, driven message by message. This is the
// half of the component the two September reports were about — who offers,
// who answers, and what the screen says while nobody has arrived yet.
describe('the signalling sequence', () => {
  /** Join, then open the socket and let the server accept the join. */
  async function joinAndConnect() {
    await joinTheCall();
    const socket = FakeWebSocket.last;
    expect(socket).toBeDefined();
    await act(async () => {
      socket?.open();
    });
    await act(async () => {
      socket?.deliver({ type: 'joined' });
    });
    return socket as FakeWebSocket;
  }

  it('asks to join the appointment named on the link, as soon as the socket opens', async () => {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    expect(socket.sentOf('join')[0]).toEqual({ type: 'join', appointmentId: APPOINTMENT_ID });
  });

  it('announces itself once the join is accepted, so a peer already waiting learns of it', async () => {
    renderCall();
    const socket = await joinAndConnect();
    // 2026-09-04: the `ready` handshake. Without it the only way to find a
    // peer who joined first was a retry loop that gave up after 30s.
    expect(socket.sentOf('ready')).toHaveLength(1);
  });

  // **2026-09-07: nobody offers into an empty call.** An offer needs a peer
  // to have announced itself, because until then this side does not know
  // whether it is the one that should be offering — and a blind offer from
  // the wrong side is the collision that used to leave both parties looking
  // at a black frame. Announcing is immediate and the reply is immediate,
  // so this costs one relay round trip, not a retry interval.
  it('does not offer until a peer has announced itself', async () => {
    renderCall();
    const socket = await joinAndConnect();
    expect(socket.sentOf('ready')).toHaveLength(1);
    expect(socket.sentOf('offer')).toHaveLength(0);
  });

  it('offers once the peer announces itself, having won the election', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
  });

  // The half of the election that used to be a guess. A transient 5xx on
  // the role probe made a clinician believe it was the patient, both sides
  // offered, and neither could apply the other's offer.
  it('does not offer when the peer wins the election, whatever role it resolved', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_HIGHER));
    });
    // It answers the announcement so the peer learns this side's own id —
    // both halves of the election have to be known on both sides — and
    // waits to be offered to.
    await waitFor(() => {
      expect(socket.sentOf('ready').length).toBeGreaterThan(1);
    });
    expect(socket.sentOf('offer')).toHaveLength(0);
  });

  it('does not offer as the clinician either, when the peer id wins', async () => {
    asClinician();
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_HIGHER));
    });
    expect(socket.sentOf('offer')).toHaveLength(0);
  });

  it('offers again when the peer rebuilds its own connection', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
    // A higher generation is the peer saying "this is a new peer connection
    // of mine" — the offer they were sent describes media that no longer
    // exists, so it has to be replaced rather than waited on.
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 2));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(2);
    });
  });

  // The other side of the same coin: a nudge is not a rebuild, and
  // re-offering on every nudge restarts ICE on a handshake that was only
  // slow.
  it('does not re-offer on a repeated announcement at the same generation', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    expect(socket.sentOf('offer')).toHaveLength(1);
  });

  it('answers an offer', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver({
        type: 'offer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'offer', sdp: 'v=0 theirs' },
      });
    });
    await waitFor(() => {
      expect(socket.sentOf('answer')).toHaveLength(1);
    });
  });

  it('ignores a duplicate answer instead of failing the call', async () => {
    renderCall();
    const socket = await joinAndConnect();
    const answer = {
      type: 'answer',
      appointmentId: APPOINTMENT_ID,
      payload: { type: 'answer', sdp: 'v=0 theirs' },
    };
    await act(async () => {
      socket.deliver(answer);
    });
    // The second one arrives with the connection already back in `stable`.
    // Applying it throws `InvalidStateError`, which used to reach the
    // catch-all and replace a working call with the error screen.
    await act(async () => {
      socket.deliver(answer);
    });
    expect(screen.queryByText(STRINGS.errorLabel)).toBeNull();
    expect(screen.getByRole('button', { name: STRINGS.leaveLabel })).toBeDefined();
  });

  it('shows the other participant once their tracks arrive', async () => {
    const { container } = renderCall();
    await joinAndConnect();

    // The status text appears twice while the frame is empty: once in the
    // status line above the stage, once as the placeholder standing in for
    // the missing video.
    expect(screen.getAllByText(STRINGS.connectingLabel)).toHaveLength(2);

    const remoteStream = fakeStream();
    await act(async () => {
      FakePeerConnection.last?.ontrack?.({ streams: [remoteStream] });
    });

    const remote = container.querySelector<HTMLVideoElement>(
      `video[aria-label="${STRINGS.remoteVideoLabel}"]`,
    );
    expect(remote?.srcObject).toBe(remoteStream);
    // The placeholder gives way to the real video; the status line stays.
    expect(screen.getAllByText(STRINGS.connectingLabel)).toHaveLength(1);
  });

  it('says it is waiting when the other party has not joined yet', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver({ type: 'peer-unavailable' });
    });
    expect(await screen.findAllByText(STRINGS.waitingForPeerLabel)).not.toHaveLength(0);
  });

  it('renders the server’s own reason when a join is refused', async () => {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'join-denied', reason: 'too-late' });
    });
    expect(await screen.findByText(STRINGS.joinDeniedLabels['too-late'])).toBeDefined();
  });

  it('ends when the other party leaves, and says so rather than saying it failed', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver({ type: 'leave', appointmentId: APPOINTMENT_ID, payload: {} });
    });
    // 2026-09-07: its own sentence. "The call has ended" over a call the
    // other person walked out of leaves this side wondering whether
    // something broke.
    expect(await screen.findByText(STRINGS.peerLeftLabel)).toBeDefined();
    expect(screen.queryByText(STRINGS.failedLabel)).toBeNull();
  });

  it('tells the other party when this side leaves', async () => {
    renderCall();
    const socket = await joinAndConnect();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.leaveLabel }));
    await waitFor(() => {
      expect(socket.sentOf('leave')).toHaveLength(1);
    });
    // And releases the camera on the way out.
    expect(videoTrack.stopped).toBe(true);
  });

  it('relays an ICE candidate the browser gathers', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      FakePeerConnection.last?.onicecandidate?.({
        candidate: { toJSON: () => ({ candidate: 'a=candidate:1' }) } as unknown as RTCIceCandidate,
      });
    });
    expect(socket.sentOf('ice-candidate')).toHaveLength(1);
  });

  it('sends nothing for the end-of-candidates signal', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      FakePeerConnection.last?.onicecandidate?.({ candidate: null });
    });
    expect(socket.sentOf('ice-candidate')).toHaveLength(0);
  });

  it('gives the peer connection this caller’s own tracks', async () => {
    renderCall();
    await joinAndConnect();
    expect(FakePeerConnection.last?.added).toHaveLength(2);
  });

  it('reports connected once the peer connection says so', async () => {
    renderCall();
    await joinAndConnect();
    await act(async () => {
      const pc = FakePeerConnection.last as FakePeerConnection;
      pc.connectionState = 'connected';
      pc.onconnectionstatechange?.();
    });
    // `findAllBy`: with no remote stream yet, the status text is on both
    // the status line and the in-frame placeholder.
    expect(await screen.findAllByText(STRINGS.connectedLabel)).not.toHaveLength(0);
  });
});

// 2026-09-05. **The regression that left both parties on "Connecting…"
// with a black frame**, and the three defects behind it. The owner:
// *"now I see myself in the smaller box but dont see the other persons
// video. before that was working."*
//
// The chain, in the order it ran: retry timers re-armed without cancelling
// (so `ready` doubling the bounces doubled the pending timers every two
// seconds) → several offers in flight at once → several answers back →
// the duplicate-answer guard dropping all but one, and dropping one left
// `remoteDescriptionSet` false, which stranded every queued ICE candidate
// for the life of the call. With no remote candidates, ICE has nothing to
// pair and the connection never completes.
describe('negotiation does not talk the call to death', () => {
  /** ~one nudge interval (`PEER_NUDGE_FAST_MS` is 2000ms), plus a margin. */
  const ONE_NUDGE_MS = 2100;

  async function joinAlone() {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    return socket;
  }

  /** Joined, and negotiating with a peer this browser has won the election against. */
  async function joinWithPeer() {
    const socket = await joinAlone();
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
    return socket;
  }

  it('arms one nudge however many messages bounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    // A caller waiting alone gets a bounce for every message it sent while
    // nobody was there. Re-arming without cancelling turned that into two
    // pending timers, then four, then eight — and every one of them sent
    // something.
    await act(async () => {
      socket.deliver({ type: 'peer-unavailable' });
      socket.deliver({ type: 'peer-unavailable' });
    });

    const before = socket.sentOf('ready').length;
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS);
    });
    expect(socket.sentOf('ready')).toHaveLength(before + 1);
  });

  it('does not let the nudges multiply over successive rounds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        socket.deliver({ type: 'peer-unavailable' });
        socket.deliver({ type: 'peer-unavailable' });
      });
      await act(async () => {
        vi.advanceTimersByTime(ONE_NUDGE_MS);
      });
    }

    // One on joining, then exactly one per round. Doubling would give 15.
    expect(socket.sentOf('ready')).toHaveLength(4);
  });

  it('sends one offer at a time — a nudge does not add a second outstanding one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinWithPeer();

    // Three nudge intervals with the first offer still unanswered and
    // nothing having bounced. Several offers in flight is what produced
    // several answers, and the duplicate-answer guard dropping all but one
    // is what stranded the ICE candidates.
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS * 3);
    });
    expect(socket.sentOf('offer')).toHaveLength(1);
  });

  it('re-offers once the previous offer is known to have bounced', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinWithPeer();

    // `peer-unavailable` is proof the offer reached nobody, so there is
    // nothing outstanding any more and the next nudge may replace it.
    await act(async () => {
      socket.deliver({ type: 'peer-unavailable' });
    });
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS);
    });
    expect(socket.sentOf('offer')).toHaveLength(2);
  });

  it('keeps nudging until the connection is actually up, not until the peer first speaks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinWithPeer();
    const before = socket.sentOf('ready').length;

    // The hole this closes: nudging used to stop the moment the peer said
    // anything. If this side's reply to their announcement was the message
    // that got dropped, they never learned this side's session id, so
    // neither could be elected to offer — and nothing was left running to
    // discover it.
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS);
    });
    expect(socket.sentOf('ready').length).toBeGreaterThan(before);

    await act(async () => {
      const pc = FakePeerConnection.last as FakePeerConnection;
      pc.connectionState = 'connected';
      pc.onconnectionstatechange?.();
    });
    const afterConnected = socket.sentOf('ready').length;
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS * 3);
    });
    expect(socket.sentOf('ready')).toHaveLength(afterConnected);
  });

  it('re-sends the answer, rather than renegotiating, when the answerer is nudged', async () => {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    // The peer wins the election, so this browser is the answerer.
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_HIGHER, 1));
      socket.deliver({
        type: 'offer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'offer', sdp: 'v=0 theirs' },
      });
    });
    await waitFor(() => {
      expect(socket.sentOf('answer')).toHaveLength(1);
    });

    // Their nudge at the same generation means the handshake did not
    // complete, and the answerer is the only side that can be holding the
    // message that went missing. It had no way to re-send it at all before.
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_HIGHER, 1));
    });
    await waitFor(() => {
      expect(socket.sentOf('answer')).toHaveLength(2);
    });
    // And it did not renegotiate: an answerer never offers.
    expect(socket.sentOf('offer')).toHaveLength(0);
  });

  // **The one that matters most.** Dropping a *first* answer stranded the
  // ICE candidates, and a call with no remote candidates can never connect.
  // A browser refuses an answer in the wrong state, so the fix cannot be to
  // force it through — it has to be to get back in step.
  it('restarts negotiation when an answer arrives that it cannot apply', async () => {
    const socket = await joinWithPeer();
    const pc = FakePeerConnection.last as FakePeerConnection;

    // The state the storm used to produce: back in `stable` with no remote
    // description ever applied. The old guard returned here and the call
    // was over — silently, with every queued candidate stranded.
    pc.signalingState = 'stable';
    await act(async () => {
      socket.deliver({
        type: 'answer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'answer', sdp: 'v=0 theirs' },
      });
    });

    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(2);
    });
  });

  it('flushes the ICE candidates it queued, once a remote description lands', async () => {
    const socket = await joinWithPeer();
    const pc = FakePeerConnection.last as FakePeerConnection;

    // Candidates arriving before any remote description are queued — the
    // ordinary trickle-ICE case.
    await act(async () => {
      socket.deliver({
        type: 'ice-candidate',
        appointmentId: APPOINTMENT_ID,
        payload: { candidate: 'a=candidate:1' },
      });
      socket.deliver({
        type: 'ice-candidate',
        appointmentId: APPOINTMENT_ID,
        payload: { candidate: 'a=candidate:2' },
      });
    });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await act(async () => {
      socket.deliver({
        type: 'answer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'answer', sdp: 'v=0 theirs' },
      });
    });

    // Stranded, these are what left ICE with nothing to pair.
    await waitFor(() => {
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    });
  });

  it('still ignores a genuinely duplicate answer', async () => {
    const socket = await joinWithPeer();
    const pc = FakePeerConnection.last as FakePeerConnection;

    const answer = {
      type: 'answer',
      appointmentId: APPOINTMENT_ID,
      payload: { type: 'answer', sdp: 'v=0 theirs' },
    };
    await act(async () => {
      socket.deliver(answer);
    });
    await act(async () => {
      socket.deliver(answer);
    });

    // Applied once; the second describes the peer the first already
    // connected to.
    expect(pc.remoteDescriptions).toHaveLength(1);
    expect(screen.queryByText(STRINGS.errorLabel)).toBeNull();
  });

  it('survives a negotiation step that fails, instead of ending the call', async () => {
    const socket = await joinAlone();
    const pc = FakePeerConnection.last as FakePeerConnection;
    pc.setRemoteDescription = vi.fn(() => Promise.reject(new Error('nope')));

    await act(async () => {
      socket.deliver({
        type: 'answer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'answer', sdp: 'v=0 theirs' },
      });
    });

    // A transient SDP race used to reach the catch-all and replace the
    // whole call with "Something went wrong." The call stays up; real,
    // terminal failure is the connection state machine's to report.
    expect(screen.queryByText(STRINGS.errorLabel)).toBeNull();
    expect(screen.getByRole('button', { name: STRINGS.leaveLabel })).toBeDefined();
  });

  // **Glare, which a mis-resolved role used to make fatal.** Two offers
  // cross; the elected offerer keeps its own and the other rolls back and
  // answers. Before this both sides rejected the other's offer and the call
  // never negotiated at all.
  it('the elected offerer ignores a crossing offer and keeps its own', async () => {
    const socket = await joinWithPeer();
    const pc = FakePeerConnection.last as FakePeerConnection;
    expect(pc.signalingState).toBe('have-local-offer');

    await act(async () => {
      socket.deliver({
        type: 'offer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'offer', sdp: 'v=0 theirs' },
      });
    });

    expect(socket.sentOf('answer')).toHaveLength(0);
    expect(pc.remoteDescriptions).toHaveLength(0);
  });

  it('the other side rolls its own offer back and answers', async () => {
    const socket = await joinAlone();
    const pc = FakePeerConnection.last as FakePeerConnection;
    // An offer of this side's own is outstanding (the role fallback made it
    // the offerer before any election settled)...
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    await waitFor(() => {
      expect(pc.signalingState).toBe('have-local-offer');
    });
    // ...and then the peer turns out to hold the winning id after all.
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_HIGHER, 1));
    });
    await act(async () => {
      socket.deliver({
        type: 'offer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'offer', sdp: 'v=0 theirs' },
      });
    });

    await waitFor(() => {
      expect(socket.sentOf('answer')).toHaveLength(1);
    });
  });
});

// 2026-09-05: waiting for someone who has not arrived is not a failure.
describe('waiting for the other participant', () => {
  const ONE_NUDGE_MS = 2100;

  async function joinAlone() {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    return socket;
  }

  it('keeps saying it is waiting, however long nobody comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    // Far past what used to be a 30-second retry budget. Two bounces per
    // round burned it in about fourteen seconds and then told the patient
    // the call had failed — while their clinician was simply not there yet.
    for (let round = 0; round < 25; round += 1) {
      await act(async () => {
        socket.deliver({ type: 'peer-unavailable' });
        socket.deliver({ type: 'peer-unavailable' });
      });
      await act(async () => {
        vi.advanceTimersByTime(ONE_NUDGE_MS);
      });
    }

    expect(screen.queryByText(STRINGS.failedLabel)).toBeNull();
    expect(screen.getAllByText(STRINGS.waitingForPeerLabel).length).toBeGreaterThan(0);
  });

  /**
   * **2026-09-07: it never stops looking, and that is the change.**
   *
   * The nudge used to be a bounded 15-attempt budget, so after ~30 seconds
   * a caller waiting alone went quiet and relied entirely on the other
   * party's own announcement reaching them. A clinician joining twenty
   * minutes late — the whole *"joins late"* case — was then one dropped
   * message away from a call that could never come up. It slows down
   * instead of stopping: fast while two people are plausibly both pressing
   * a button, then every fifteen seconds for as long as the window lasts.
   */
  it('slows its nudging down rather than giving up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    // Well past the old budget, at the fast interval.
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS * 20);
    });
    const afterFast = socket.sentOf('ready').length;
    // 15 fast nudges plus the one sent on joining, and then the slow
    // interval takes over — so this is bounded, not one per two seconds
    // for ever.
    expect(afterFast).toBeLessThanOrEqual(17);

    // And it is still going: a peer arriving now is still found.
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    expect(socket.sentOf('ready').length).toBeGreaterThan(afterFast);
  });

  it('finds a peer who arrives long after everyone stopped expecting them', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();
    await act(async () => {
      vi.advanceTimersByTime(ONE_NUDGE_MS * 30);
    });
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer').length).toBeGreaterThan(0);
    });
  });
});

// 2026-09-05. A call now starts audio-only on both sides, so the ordinary
// state of a freshly connected call is two people looking at a black
// rectangle. That is the app working exactly as asked, and it looks
// identical to the fault reported twice — so the frame has to say which.
describe('the other participant’s camera', () => {
  async function connectWithRemoteStream() {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    const remote = fakeStream();
    // `fakeStream` reassigns the module-level track handles, so grab the
    // remote one before anything else does.
    const remoteVideoTrack = videoTrack;
    await act(async () => {
      FakePeerConnection.last?.ontrack?.({ streams: [remote] });
    });
    return { remoteVideoTrack };
  }

  it('says their camera is off, rather than showing an unexplained black frame', async () => {
    await connectWithRemoteStream();
    expect(await screen.findByText(STRINGS.remoteCameraOffLabel)).toBeDefined();
    // And no longer claims to be connecting — their stream has arrived.
    expect(screen.queryAllByText(STRINGS.connectingLabel)).toHaveLength(1);
  });

  it('clears the notice the moment they turn it on', async () => {
    const { remoteVideoTrack } = await connectWithRemoteStream();
    await act(async () => {
      remoteVideoTrack.setMuted(false);
    });
    expect(screen.queryByText(STRINGS.remoteCameraOffLabel)).toBeNull();
  });

  it('brings it back if they turn it off again', async () => {
    const { remoteVideoTrack } = await connectWithRemoteStream();
    await act(async () => {
      remoteVideoTrack.setMuted(false);
    });
    await act(async () => {
      remoteVideoTrack.setMuted(true);
    });
    expect(await screen.findByText(STRINGS.remoteCameraOffLabel)).toBeDefined();
  });

  it('shows the connecting placeholder, not the camera notice, before they arrive', async () => {
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    // Nobody has connected: "their camera is off" would be a claim about
    // someone who is not there.
    expect(screen.queryByText(STRINGS.remoteCameraOffLabel)).toBeNull();
    expect(screen.getAllByText(STRINGS.connectingLabel)).toHaveLength(2);
  });
});

// 2026-09-05: a call must not be able to vanish into "Connecting…".
//
// `run()` is fire-and-forget, so anything thrown while it sets a call up
// had no handler, changed no state, and left the stage on `checking` —
// which renders as "Connecting…" for ever, with the local camera working
// and nothing to say what went wrong. Reported that way twice.
describe('a join sequence that fails says so', () => {
  it('does not let a layout callback stand between the role and the socket', async () => {
    const onRoleResolved = vi.fn(() => {
      throw new Error('the layout blew up');
    });
    render(
      <VideoCall
        strings={STRINGS}
        client={client}
        getAppointmentId={getAppointmentId}
        locale="en"
        onRoleResolved={onRoleResolved}
      />,
    );
    await joinTheCall();

    // The socket exists despite the callback throwing: it is opened before
    // anyone else is told the call has started.
    await waitFor(() => {
      expect(FakeWebSocket.last).toBeDefined();
    });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    expect(socket.sentOf('join')).toHaveLength(1);
    expect(onRoleResolved).toHaveBeenCalled();
  });

  it('reports an error rather than sitting on "Connecting…" when the socket cannot be made', async () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        static readonly OPEN = 1;
        constructor() {
          throw new Error('no socket for you');
        }
      },
    );
    renderCall();
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));

    // Silence here is what made this class of failure unreportable. And it
    // is the *setup* error rather than "the connection was lost": a socket
    // a browser refuses to construct is a misconfigured URL, not a call
    // that was under way — and, unlike a network drop, retrying it forty
    // times over five minutes could only ever arrive at the same place.
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
    expect(screen.queryByText(STRINGS.connectionLostLabel)).toBeNull();
    // Retryable all the same, since the window is still open.
    expect(screen.getByRole('button', { name: STRINGS.rejoinLabel })).toBeDefined();
  });
});


// =====================================================================
// 2026-09-07. The owner: *"Outside call window it should not let to have a
// join call button (rather say it has expired or will start soon)."*
//
// The call page could not previously answer that. The id on the query
// string carries `scheduledAt` and not `durationMinutes`, so "is this slot
// over" was unanswerable here — a caller who opened a finished appointment
// was taken through a camera permission prompt, shown a join button, and
// only told the window had shut once the server refused them.
describe('the window gate', () => {
  const HOUR = 60 * 60_000;

  it('offers no join button before the slot starts, and counts down to it instead', async () => {
    const id = appointmentIdAt(2 * HOUR);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);

    expect(await screen.findByText(/has not started yet/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: STRINGS.joinCall.label })).toBeNull();
    // And no camera prompt: nothing asks for a device until there is a call
    // to have.
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('offers no join button once the slot is over, and says it has expired', async () => {
    const id = appointmentIdAt(-2 * HOUR);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);

    expect(await screen.findByText(STRINGS.expiredLabel)).toBeDefined();
    expect(screen.queryByRole('button', { name: STRINGS.deviceCheck.continueLabel })).toBeNull();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('offers the join button inside the slot', async () => {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);

    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    expect(await screen.findByRole('button', { name: STRINGS.joinCall.label })).toBeDefined();
  });

  // A 15-minute check-in that finished ten minutes ago. The old fixed
  // 30-minute reading of the window called this joinable.
  it('respects a short slot’s own length rather than a fixed half hour', async () => {
    const id = appointmentIdAt(-25 * 60_000);
    withAppointment({ id, durationMinutes: 15 });
    renderCall(id);
    expect(await screen.findByText(STRINGS.expiredLabel)).toBeDefined();
  });

  // And the other direction: an hour into a 90-minute assessment, which the
  // old window shut out at the halfway mark.
  it('respects a long slot’s own length too', async () => {
    const id = appointmentIdAt(-60 * 60_000);
    withAppointment({ id, durationMinutes: 90 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    expect(await screen.findByRole('button', { name: STRINGS.joinCall.label })).toBeDefined();
  });

  it('says a booking is still waiting to be confirmed, rather than offering a join button', async () => {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30, status: 'pending-approval' });
    renderCall(id);
    // `ws-join.ts` would refuse this with `not-confirmed`; saying so before
    // the camera prompt is strictly kinder than saying it after.
    expect(await screen.findByText(STRINGS.joinDeniedLabels['not-confirmed'])).toBeDefined();
    expect(screen.queryByRole('button', { name: STRINGS.joinCall.label })).toBeNull();
  });

  it('says a cancelled booking is cancelled', async () => {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30, status: 'cancelled' });
    renderCall(id);
    expect(await screen.findByText(STRINGS.joinDeniedLabels.cancelled)).toBeDefined();
  });

  // **The duration is not always knowable**, and this screen must not claim
  // a window it cannot see. A row that is missing from the list falls back
  // to exactly the behaviour that existed before this gate: the countdown
  // from the id alone, and the server's own `too-late` for the far end.
  it('still lets a caller try when the appointment row cannot be found', async () => {
    renderCall();
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    expect(await screen.findByRole('button', { name: STRINGS.joinCall.label })).toBeDefined();
  });

  it('opens the join button at the instant the slot starts, not at the next tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = appointmentIdAt(3_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);

    expect(await screen.findByText(/has not started yet/i)).toBeDefined();
    // The countdown itself ticks every fifteen seconds. Waiting for it
    // would leave a caller looking at "not started yet" for a quarter of a
    // minute after it had — and, at the other end, at a live join button a
    // quarter of a minute after the window shut.
    await act(async () => {
      vi.advanceTimersByTime(3_200);
    });
    expect(
      await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }),
    ).toBeDefined();
  });
});

// *"there should be a timer showing how much time is left before the call
// auto gets dropped. Once the timelimit has reached the call should auto
// drop."*
describe('the countdown to the drop', () => {
  async function joinAt(startOffsetMs: number, durationMinutes: number) {
    const id = appointmentIdAt(startOffsetMs);
    withAppointment({ id, durationMinutes });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    return FakeWebSocket.last as FakeWebSocket;
  }

  it('shows how long is left, counting to the end of the booked slot', async () => {
    await joinAt(-60_000, 30);
    const timer = await screen.findByRole('timer');
    // Twenty-nine minutes of a thirty-minute slot that started a minute
    // ago — not thirty from the moment this side pressed the button.
    expect(timer.textContent).toMatch(/^(29:00|28:5\d) left$/);
  });

  it('names the countdown for a screen reader *and* gives it the number', async () => {
    await joinAt(-60_000, 30);
    // An `aria-label` replaces an element's text content, so a label
    // without the value in it left a screen-reader user hearing what the
    // number meant and never hearing the number.
    const label = (await screen.findByRole('timer')).getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^Time remaining before this call ends: (29:00|28:5\d)$/);
  });

  it('drops the call at the end of the slot, not thirty minutes after joining', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Five minutes left of a thirty-minute slot. The old limit would have
    // run this call for another half hour — well past the appointment, and
    // past the point at which the server stops letting anyone in.
    await joinAt(-25 * 60_000, 30);
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000 + 2_000);
    });
    expect(await screen.findByText(STRINGS.timeLimitReachedLabel)).toBeDefined();
    // And releases the camera on the way out.
    expect(videoTrack.stopped).toBe(true);
  });

  it('warns once the end is close, and only then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await joinAt(-25 * 60_000, 30);
    expect(screen.queryByText(/less than two minutes/i)).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(3 * 60_000 + 2_000);
    });
    // Rendered only in the last stretch, so a screen reader announces it
    // when it appears rather than once a second for half an hour.
    expect(await screen.findByText(/less than two minutes/i)).toBeDefined();
  });

  it('offers no rejoin once the slot itself is over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await joinAt(-25 * 60_000, 30);
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000 + 2_000);
    });
    await screen.findByText(STRINGS.timeLimitReachedLabel);
    expect(screen.queryByRole('button', { name: STRINGS.rejoinLabel })).toBeNull();
  });

  it('still caps one sitting on a long appointment, and lets it be rejoined', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // A 90-minute assessment: the cap ends this sitting, and the window is
    // still open, so there is another one to be had.
    await joinAt(-60_000, 90);
    await act(async () => {
      vi.advanceTimersByTime(MAX_CALL_MINUTES * 60_000 + 2_000);
    });
    expect(await screen.findByText(STRINGS.timeLimitReachedLabel)).toBeDefined();
    expect(screen.getByRole('button', { name: STRINGS.rejoinLabel })).toBeDefined();
  });

  it('has no timer before the call starts — there is nothing to count', async () => {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    await screen.findByRole('button', { name: STRINGS.joinCall.label });
    expect(screen.queryByRole('timer')).toBeNull();
  });
});

// **2026-09-07: nothing about this call used to be recoverable.** The
// runbook named it: *"No rejoin after leaving. Pressing 'Leave call' stops
// the device stream's own tracks along with everything else; getting back
// into the same call needs a fresh page load."* Every terminal state was
// final, and the join effect's teardown stopped the camera tracks while
// leaving the stream in place — so even flipping the flag back would have
// built a peer connection on tracks that had ended.
describe('coming back', () => {
  async function joinLive(durationMinutes = 30) {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    return socket;
  }

  it('offers a rejoin after leaving, while the slot is still open', async () => {
    await joinLive();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.leaveLabel }));
    expect(await screen.findByRole('button', { name: STRINGS.rejoinLabel })).toBeDefined();
  });

  it('comes back on a live stream, not the dead one it left with', async () => {
    await joinLive();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.leaveLabel }));
    const stoppedOnLeaving = videoTrack;
    expect(stoppedOnLeaving.stopped).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: STRINGS.rejoinLabel }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });

    // A fresh grant, and the peer connection got *its* tracks — the whole
    // point. Reusing the old stream would have produced a call with no
    // media and nothing on screen to say so.
    expect(videoTrack).not.toBe(stoppedOnLeaving);
    expect(videoTrack.stopped).toBe(false);
    expect(FakePeerConnection.last?.added).toHaveLength(2);
  });

  it('does not make the caller choose their devices a second time', async () => {
    await joinLive();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.leaveLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.rejoinLabel }));
    // Permission is granted by now, so the re-acquire is silent — a second
    // "Continue" between a caller and the call they are trying to get back
    // into is a gate with nothing behind it.
    expect(await screen.findByRole('button', { name: STRINGS.leaveLabel })).toBeDefined();
  });

  it('opens a new socket rather than reusing the one it said goodbye on', async () => {
    const socket = await joinLive();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.leaveLabel }));
    await waitFor(() => {
      expect(socket.sentOf('leave')).toHaveLength(1);
    });
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.rejoinLabel }));
    await waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    });
  });
});

// *"what if one of the joinee gets his call dropped or refreshed or
// computer restarts…"* — a socket that goes away, which before this was
// simply the end of the call.
describe('a socket that drops', () => {
  async function joinLive() {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    return socket;
  }

  it('says it is reconnecting, not that the call has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinLive();
    await act(async () => {
      socket.drop();
    });
    expect(screen.getAllByText(STRINGS.reconnectingLabel).length).toBeGreaterThan(0);
    expect(screen.queryByText(STRINGS.connectionLostLabel)).toBeNull();
    expect(screen.queryByText(STRINGS.disconnectedLabel)).toBeNull();
    // And it keeps the call on screen, controls and all.
    expect(screen.getByRole('button', { name: STRINGS.leaveLabel })).toBeDefined();
  });

  it('re-joins on the new socket, so the CALL# row follows the connection', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinLive();
    await act(async () => {
      socket.drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const replacement = FakeWebSocket.last as FakeWebSocket;
    expect(replacement).not.toBe(socket);
    await act(async () => {
      replacement.open();
    });
    expect(replacement.sentOf('join')).toHaveLength(1);
  });

  /**
   * **The ten-minute bug, from the component's side.** API Gateway shuts an
   * idle socket after ten minutes and a connected call's signalling is
   * silent, so this is not an edge case — it was every call. The media is
   * peer-to-peer and completely unaffected, so the one thing this must not
   * do is tear down a working peer connection or tell the people on it that
   * anything happened.
   */
  it('does not disturb a connected call when only the socket went', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinLive();
    await act(async () => {
      const pc = FakePeerConnection.last as FakePeerConnection;
      pc.connectionState = 'connected';
      pc.onconnectionstatechange?.();
    });
    await screen.findAllByText(STRINGS.connectedLabel);
    const peerConnections = FakePeerConnection.instances.length;

    await act(async () => {
      socket.drop();
    });
    // Nothing on screen changes: the two people are still talking.
    expect(screen.getAllByText(STRINGS.connectedLabel).length).toBeGreaterThan(0);
    expect(screen.queryByText(STRINGS.reconnectingLabel)).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const replacement = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      replacement.open();
    });
    await act(async () => {
      replacement.deliver({ type: 'joined' });
    });

    // The same peer connection, and no fresh offer: a re-join over a
    // healthy call announces itself and asks for nothing.
    expect(FakePeerConnection.instances).toHaveLength(peerConnections);
    expect(replacement.sentOf('offer')).toHaveLength(0);
    expect(screen.getAllByText(STRINGS.connectedLabel).length).toBeGreaterThan(0);
  });

  it('tells the peer it wants nothing, so a reconnect never renegotiates a working call', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinLive();
    await act(async () => {
      const pc = FakePeerConnection.last as FakePeerConnection;
      pc.connectionState = 'connected';
      pc.onconnectionstatechange?.();
    });
    await act(async () => {
      socket.drop();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const replacement = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      replacement.open();
    });
    await act(async () => {
      replacement.deliver({ type: 'joined' });
    });
    expect(replacement.sentOf('ready')[0]).toMatchObject({
      payload: { wantsOffer: false },
    });
  });
});

// *"…or joins multiple times"* — the same person with the call open twice.
describe('being superseded by a newer connection', () => {
  it('stands down, rather than sitting on "Connecting…" for ever', async () => {
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });

    await act(async () => {
      socket.deliver({ type: 'not-on-call' });
    });

    // Its own sentence, not an error: nothing is broken and the call is
    // very likely fine in the other window, which is the one thing this
    // screen has to say.
    expect(await screen.findByText(STRINGS.supersededLabel)).toBeDefined();
    // And it lets go of the camera, which the other tab is now holding.
    expect(videoTrack.stopped).toBe(true);
    // Reachable again on purpose, since the caller may have meant this one.
    expect(screen.getByRole('button', { name: STRINGS.rejoinLabel })).toBeDefined();
  });
});

// A peer connection that cannot be made at all. `call-state-machine.ts`
// gets one retry; what happens after it used to be a terminal screen.
describe('a call that cannot connect', () => {
  async function joinAndFailIce() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    /** Drives the current peer connection into `failed`. */
    const fail = async () => {
      await act(async () => {
        const pc = FakePeerConnection.last as FakePeerConnection;
        pc.connectionState = 'failed';
        pc.onconnectionstatechange?.();
      });
    };
    return { socket, fail };
  }

  it('rebuilds the whole call rather than leaving a terminal screen', async () => {
    const { fail } = await joinAndFailIce();
    const socketsBefore = FakeWebSocket.instances.length;

    // The state machine's own one retry...
    await fail();
    // ...and then the failure it cannot recover from.
    await fail();

    expect(screen.getAllByText(STRINGS.reconnectingLabel).length).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    // A whole new attempt: fresh socket, fresh peer connection, fresh TURN
    // request. The appointment is still open, so there is still a call to
    // be had.
    await waitFor(() => {
      expect(FakeWebSocket.instances.length).toBeGreaterThan(socketsBefore);
    });
  });

  it('gives up after a bounded number of rebuilds, and says so plainly', async () => {
    const { fail } = await joinAndFailIce();

    // Four rounds of "one retry then a rebuild" is past the budget of
    // three. This is the loop guard: an appointment window is up to ninety
    // minutes long and rebuilding for all of it would be a storm, not a
    // recovery.
    for (let round = 0; round < 5; round += 1) {
      await fail();
      await fail();
      await act(async () => {
        vi.advanceTimersByTime(2_500);
      });
      const socket = FakeWebSocket.last as FakeWebSocket;
      await act(async () => {
        socket.open();
      });
      await act(async () => {
        socket.deliver({ type: 'joined' });
      });
    }

    expect(await screen.findByText(STRINGS.failedLabel)).toBeDefined();
    // Never a dead end while the window is open.
    expect(screen.getByRole('button', { name: STRINGS.rejoinLabel })).toBeDefined();
  });
});


// *"…or refreshed"*. The reloading side is easy — it is a fresh page. The
// side that *stays* is the one this is about, and it used to be left
// staring at a frozen last frame for the rest of the appointment.
describe('the other participant reloads their page', () => {
  async function connectedWithPeer() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
    await act(async () => {
      socket.deliver({
        type: 'answer',
        appointmentId: APPOINTMENT_ID,
        payload: { type: 'answer', sdp: 'v=0 theirs' },
      });
    });
    await act(async () => {
      const pc = FakePeerConnection.last as FakePeerConnection;
      pc.connectionState = 'connected';
      pc.onconnectionstatechange?.();
      FakePeerConnection.last?.ontrack?.({ streams: [fakeStream()] });
    });
    await screen.findAllByText(STRINGS.connectedLabel);
    return socket;
  }

  it('rebuilds against the page that is actually there now', async () => {
    const socket = await connectedWithPeer();
    const peerConnections = FakePeerConnection.instances.length;

    // A reload comes back with a **new** session id, and its own generation
    // counter restarts at 1 — which is not greater than the generation
    // already seen, so the rebuild went undetected. Nothing else asked for
    // an offer either: this side's remote description was still set, from a
    // negotiation with a page that no longer exists.
    await act(async () => {
      socket.deliver(peerReady('!peer-after-a-reload', 1));
    });

    await waitFor(() => {
      expect(FakePeerConnection.instances.length).toBeGreaterThan(peerConnections);
    });
    await waitFor(() => {
      expect(socket.sentOf('offer').length).toBeGreaterThan(1);
    });
  });

  it('clears the frozen last frame rather than passing it off as a live call', async () => {
    const socket = await connectedWithPeer();
    await act(async () => {
      socket.deliver(peerReady('!peer-after-a-reload', 1));
    });
    // The old peer connection's tracks died with it, so what is on screen
    // is a still image of somebody who is no longer connected.
    await waitFor(() => {
      expect(screen.queryAllByText(STRINGS.remoteCameraOffLabel)).toHaveLength(0);
    });
  });

  it('does not rebuild for the same peer announcing itself again', async () => {
    const socket = await connectedWithPeer();
    const peerConnections = FakePeerConnection.instances.length;
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    expect(FakePeerConnection.instances).toHaveLength(peerConnections);
  });
});

// A message that goes missing without the relay reporting a bounce. The
// one-offer-at-a-time rule is what keeps a handshake from drowning in
// offers, and it must not also be what keeps a lost one from being
// replaced.
describe('a handshake that stalls', () => {
  it('replaces an offer nobody ever answered, once it is too old to still be in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });

    // Two nudge intervals: still inside the window in which an answer
    // could plausibly be on its way, so the offer stands.
    await act(async () => {
      vi.advanceTimersByTime(4_200);
    });
    expect(socket.sentOf('offer')).toHaveLength(1);

    // Past it. An answer is one relay hop and a `createAnswer` — ICE
    // gathering happens afterwards and does not hold it up — so an offer
    // unanswered this long is gone, not slow.
    await act(async () => {
      vi.advanceTimersByTime(4_200);
    });
    await waitFor(() => {
      expect(socket.sentOf('offer').length).toBeGreaterThan(1);
    });
  });
});


// Two defects the review of the fixes turned up. Both pass a casual
// reading of the code, and both would have shown up in production as
// "sometimes the call just gives up".
describe('replacing a peer connection', () => {
  async function joinedAndNegotiating() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const id = appointmentIdAt(-60_000);
    withAppointment({ id, durationMinutes: 30 });
    renderCall(id);
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.deviceCheck.continueLabel }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.joinCall.label }));
    await screen.findByRole('button', { name: STRINGS.leaveLabel });
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });
    await act(async () => {
      socket.deliver(peerReady(PEER_ID_LOWER, 1));
    });
    return socket;
  }

  /**
   * **Every ICE retry was on a three-second fuse.** `close()` fires
   * `connectionstatechange` with `'closed'`, which maps to
   * `'disconnected'` — so the connection being *replaced* fed a disconnect
   * into the state machine on its way out. It had already spent its one
   * retry (that is why it was being replaced), so its grace period expired
   * into "this call could not connect" three seconds later, whatever the
   * freshly-built connection was doing. The retries most likely to need
   * longer — mobile, TURN — were exactly the ones this cut off.
   */
  it('does not let the outgoing connection’s own close count as a failure', async () => {
    const socket = await joinedAndNegotiating();
    const original = FakePeerConnection.last as FakePeerConnection;

    await act(async () => {
      original.connectionState = 'failed';
      original.onconnectionstatechange?.();
    });
    // The state machine's own retry has built a replacement.
    await waitFor(() => {
      expect(FakePeerConnection.last).not.toBe(original);
    });

    // Well past the grace period, with the replacement still connecting.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText(STRINGS.failedLabel)).toBeNull();
    expect(screen.getByRole('button', { name: STRINGS.leaveLabel })).toBeDefined();

    // And the discarded connection cannot push anything into the call that
    // replaced it.
    expect(original.ontrack).toBeNull();
    expect(original.onicecandidate).toBeNull();
    expect(original.onconnectionstatechange).toBeNull();
    expect(socket.sentOf('leave')).toHaveLength(0);
  });

  it('keeps the ICE candidates it gathered while the socket was away', async () => {
    const socket = await joinedAndNegotiating();
    const pc = FakePeerConnection.last as FakePeerConnection;

    await act(async () => {
      socket.drop();
    });
    // ICE keeps gathering right through a reconnect, and every candidate
    // produced in that second or two used to be dropped on the floor — so
    // a negotiation that had already exchanged descriptions would fail for
    // want of paths and have to be rebuilt from scratch.
    await act(async () => {
      pc.onicecandidate?.({
        candidate: { toJSON: () => ({ candidate: 'a=candidate:while-away' }) } as unknown as RTCIceCandidate,
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const replacement = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      replacement.open();
    });
    await act(async () => {
      replacement.deliver({ type: 'joined' });
    });

    expect(replacement.sentOf('ice-candidate')).toHaveLength(1);
    expect(replacement.sentOf('ice-candidate')[0]).toMatchObject({
      payload: { candidate: 'a=candidate:while-away' },
    });
  });

  it('does not carry a discarded connection’s candidates into its replacement', async () => {
    const socket = await joinedAndNegotiating();
    const original = FakePeerConnection.last as FakePeerConnection;

    await act(async () => {
      socket.drop();
    });
    await act(async () => {
      original.onicecandidate?.({
        candidate: { toJSON: () => ({ candidate: 'a=candidate:doomed' }) } as unknown as RTCIceCandidate,
      });
    });
    // The peer connection is rebuilt while the socket is still away, so
    // that candidate describes an ICE agent that no longer exists.
    await act(async () => {
      original.connectionState = 'failed';
      original.onconnectionstatechange?.();
    });
    await waitFor(() => {
      expect(FakePeerConnection.last).not.toBe(original);
    });

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const replacement = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      replacement.open();
    });
    await act(async () => {
      replacement.deliver({ type: 'joined' });
    });
    expect(replacement.sentOf('ice-candidate')).toHaveLength(0);
  });
});
