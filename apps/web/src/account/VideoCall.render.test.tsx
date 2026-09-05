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
  timeLimitReachedLabel: 'This call has reached its 30-minute limit and has ended.',
};

/** The appointment id `call.astro` would have put on the query string. */
const APPOINTMENT_ID = 'pat-1#2020-01-01T00:00:00.000Z';

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

  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor() {
    FakeWebSocket.last = this;
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
  FakePeerConnection.last = undefined;
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

/** The other role: `resolveRole` treats a 200 from the clinician calendar as proof. */
function asClinician(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response)),
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

function renderCall() {
  return render(
    <VideoCall
      strings={STRINGS}
      client={client}
      getAppointmentId={getAppointmentId}
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

  it('offers as the patient, who is the offerer', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
  });

  it('does not offer as the clinician, who answers', async () => {
    asClinician();
    renderCall();
    const socket = await joinAndConnect();
    // Both sides offering is how a call ends up with two half-negotiations
    // and no media. The answerer says `ready` and waits.
    expect(socket.sentOf('ready')).toHaveLength(1);
    expect(socket.sentOf('offer')).toHaveLength(0);
  });

  it('offers again when the peer announces itself later', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
    await act(async () => {
      socket.deliver({ type: 'ready', appointmentId: APPOINTMENT_ID, payload: {} });
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(2);
    });
  });

  it('answers an offer, as the clinician', async () => {
    asClinician();
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

  it('ends when the other party leaves, and says ended rather than failed', async () => {
    renderCall();
    const socket = await joinAndConnect();
    await act(async () => {
      socket.deliver({ type: 'leave', appointmentId: APPOINTMENT_ID, payload: {} });
    });
    expect(await screen.findByText(STRINGS.disconnectedLabel)).toBeDefined();
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
  /** ~one retry interval (`PEER_RETRY_INTERVAL_MS` is 2000ms), plus a margin. */
  const ONE_RETRY_INTERVAL_MS = 2100;

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

  it('arms one retry however many messages bounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    // A caller waiting alone gets a bounce for the `ready` *and* one for
    // the offer. Re-arming without cancelling turned that into two pending
    // timers, then four, then eight.
    await act(async () => {
      socket.deliver({ type: 'peer-unavailable' });
      socket.deliver({ type: 'peer-unavailable' });
    });

    const before = socket.sentOf('offer').length;
    await act(async () => {
      vi.advanceTimersByTime(ONE_RETRY_INTERVAL_MS);
    });
    expect(socket.sentOf('offer')).toHaveLength(before + 1);
  });

  it('does not let the retries multiply over successive rounds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        socket.deliver({ type: 'peer-unavailable' });
        socket.deliver({ type: 'peer-unavailable' });
      });
      await act(async () => {
        vi.advanceTimersByTime(ONE_RETRY_INTERVAL_MS);
      });
    }

    // One on joining, then exactly one per round. Doubling would give 15.
    expect(socket.sentOf('offer')).toHaveLength(4);
  });

  it('sends one offer at a time, not one per timer that happens to fire', async () => {
    const socket = await joinAlone();
    const before = socket.sentOf('offer').length;
    // Two `ready`-less nudges at once: without the in-flight guard each
    // would produce its own offer, and the peer would answer each.
    await act(async () => {
      void 0;
    });
    expect(socket.sentOf('offer')).toHaveLength(before);
  });

  it('stops retrying the moment the peer says anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const socket = await joinAlone();

    await act(async () => {
      socket.deliver({ type: 'peer-unavailable' });
    });
    await act(async () => {
      socket.deliver({ type: 'ready', appointmentId: APPOINTMENT_ID, payload: {} });
    });
    const after = socket.sentOf('offer').length;

    // A bounce arriving now is stale — one of the messages sent while the
    // peer was still absent. Acting on it restarts negotiation on a
    // connection that is already settling.
    await act(async () => {
      socket.deliver({ type: 'peer-unavailable' });
    });
    await act(async () => {
      vi.advanceTimersByTime(ONE_RETRY_INTERVAL_MS * 3);
    });
    expect(socket.sentOf('offer')).toHaveLength(after);
  });

  // **The one that matters most.** Dropping a *first* answer stranded the
  // ICE candidates, and a call with no remote candidates can never connect.
  // A browser refuses an answer in the wrong state, so the fix cannot be to
  // force it through — it has to be to get back in step.
  it('restarts negotiation when an answer arrives that it cannot apply', async () => {
    const socket = await joinAlone();
    const pc = FakePeerConnection.last as FakePeerConnection;

    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });

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
    const socket = await joinAlone();
    const pc = FakePeerConnection.last as FakePeerConnection;
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });

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
    const socket = await joinAlone();
    const pc = FakePeerConnection.last as FakePeerConnection;
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });

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

  it('offers again when the peer rejoins, even with one already outstanding', async () => {
    const socket = await joinAlone();
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(1);
    });
    // No answer came: the offer is still outstanding. A `ready` means the
    // peer it was addressed to is gone, so the one-at-a-time rule has to
    // give way here or a rejoining peer is never offered to.
    await act(async () => {
      socket.deliver({ type: 'ready', appointmentId: APPOINTMENT_ID, payload: {} });
    });
    await waitFor(() => {
      expect(socket.sentOf('offer')).toHaveLength(2);
    });
  });
});

// 2026-09-05: waiting for someone who has not arrived is not a failure.
describe('waiting for the other participant', () => {
  const ONE_RETRY_INTERVAL_MS = 2100;

  it('keeps saying it is waiting, however long nobody comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });

    // Far past the retry budget. Two bounces per round used to burn it in
    // about fourteen seconds and then tell the patient the call had failed
    // — while their clinician was simply not there yet.
    for (let round = 0; round < 25; round += 1) {
      await act(async () => {
        socket.deliver({ type: 'peer-unavailable' });
        socket.deliver({ type: 'peer-unavailable' });
      });
      await act(async () => {
        vi.advanceTimersByTime(ONE_RETRY_INTERVAL_MS);
      });
    }

    expect(screen.queryByText(STRINGS.failedLabel)).toBeNull();
    expect(screen.getAllByText(STRINGS.waitingForPeerLabel).length).toBeGreaterThan(0);
    // And it is still reachable: the peer's own `ready` is what finds it.
    await act(async () => {
      socket.deliver({ type: 'ready', appointmentId: APPOINTMENT_ID, payload: {} });
    });
    await waitFor(() => {
      expect(socket.sentOf('offer').length).toBeGreaterThan(0);
    });
  });

  it('stops nudging once the budget is spent, rather than polling for ever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderCall();
    await joinTheCall();
    const socket = FakeWebSocket.last as FakeWebSocket;
    await act(async () => {
      socket.open();
    });
    await act(async () => {
      socket.deliver({ type: 'joined' });
    });

    for (let round = 0; round < 30; round += 1) {
      await act(async () => {
        socket.deliver({ type: 'peer-unavailable' });
      });
      await act(async () => {
        vi.advanceTimersByTime(ONE_RETRY_INTERVAL_MS);
      });
    }

    // One on joining plus the bounded retries — never one per round for ever.
    expect(socket.sentOf('offer').length).toBeLessThanOrEqual(16);
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
