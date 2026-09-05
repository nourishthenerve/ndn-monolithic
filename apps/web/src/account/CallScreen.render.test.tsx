// @vitest-environment jsdom
//
// 2026-09-05: the one thing that differs between the two people on a call.
//
// The owner: *"I want patient's full assessment form and details to be
// shown to the clinician so that he can edit the details as they discuss
// over the call. For patient make video box cover the entire window but for
// clinician keep video box to the left and assessment form to the right."*
//
// Two properties worth holding still, and they pull in opposite
// directions: the clinician gets the form, and **the patient never does**.
// A patient's own assessment carries a clinician-only half
// (`projection.ts`), and while the server is what withholds it, a screen
// that offers to show it at all is the wrong screen.
//
// Harness as `VideoCall.render.test.tsx`: a socket and peer connection the
// test drives by hand. Role is resolved by whether `GET
// /clinicians/me/calendar` answers, which is the one fetch these tests care
// about steering.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssessmentFormStrings } from './AssessmentForm.js';
import { CallScreen } from './CallScreen.js';
import type { VideoCallStrings } from './VideoCall.js';

const CALL_STRINGS: VideoCallStrings = {
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

const ASSESSMENT_STRINGS: AssessmentFormStrings = {
  heading: 'Assessment',
  loadingLabel: 'Loading the assessment…',
  forbiddenLabel: 'You do not have access to this assessment.',
  notFoundLabel: 'No assessment found.',
  errorLabel: 'The assessment could not be loaded.',
  missingIdLabel: 'Choose a patient first.',
  saveLabel: 'Save',
  savingLabel: 'Saving…',
  savedLabel: 'Saved.',
  conflictLabel: 'Someone else saved first.',
  saveForbiddenLabel: 'You may not edit this section.',
  readOnlyLabel: 'Read only',
  attachmentsHeading: 'Attachments',
  attachmentsEmpty: 'No attachments.',
  addFileLabel: 'Add a file',
  uploadingLabel: 'Uploading…',
  uploadFailedLabel: 'That upload failed.',
  downloadLabel: 'Download',
  noNextAppointmentLabel: 'No next appointment.',
  versionLabel: 'Version',
};

/**
 * `AssessmentForm` never renders `strings.heading` — the prop exists on
 * its interface and nothing reads it. `versionLabel` is what it actually
 * prints once a form has loaded, so that is what these tests look for.
 */
const PATIENT_ID = 'pat-1';
const APPOINTMENT_ID = `${PATIENT_ID}#2020-01-01T00:00:00.000Z`;

function track(kind: 'video' | 'audio') {
  return {
    kind,
    enabled: true,
    muted: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: `${kind}-1` }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function fakeStream() {
  const tracks = [track('video'), track('audio')];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [tracks[0]],
    getAudioTracks: () => [tracks[1]],
  } as unknown as MediaStream;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static last: FakeWebSocket | undefined;
  readyState = 0;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  close = vi.fn();
  send = vi.fn();
  constructor() {
    FakeWebSocket.last = this;
  }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  private emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }
  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) });
  }
}

class FakePeerConnection {
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  ontrack: unknown = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  close = vi.fn();
  addTrack = vi.fn();
  addIceCandidate = vi.fn(() => Promise.resolve());
  createOffer = vi.fn(() => Promise.resolve({ type: 'offer', sdp: 'v=0' }));
  createAnswer = vi.fn(() => Promise.resolve({ type: 'answer', sdp: 'v=0' }));
  setLocalDescription = vi.fn(() => Promise.resolve());
  setRemoteDescription = vi.fn(() => Promise.resolve());
}

/** Every `fetch` this screen makes, steered by URL. */
function stubFetch(isClinician: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      // `resolveRole`: allowed means clinician, refused means patient.
      if (url.includes('/clinicians/me/calendar')) {
        return Promise.resolve({ ok: isClinician, status: isClinician ? 200 : 403 } as Response);
      }
      // The assessment itself — the shape
      // `GET /patients/{id}/assessments/{id}` really returns: the template
      // to render, the caller's own per-section permissions, and the saved
      // versions. One writable section is enough to prove the clinician
      // gets something they can actually edit during the call.
      if (url.includes('/assessments/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              currentVersion: 1,
              template: [
                {
                  fieldSet: 'general',
                  titleKey: 'assessment.section.general',
                  fields: [
                    { id: 'presentingConcern', labelKey: 'assessment.field.presentingConcern', type: 'text' },
                  ],
                },
              ],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
              items: [],
            }),
        } as Response);
      }
      return Promise.resolve({ ok: false, status: 404 } as Response);
    }),
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.resolve(fakeStream())),
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    },
  });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  FakeWebSocket.last = undefined;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const client = { authorization: () => Promise.resolve('a.b.c') } as never;

function renderScreen(appointmentId: string | undefined = APPOINTMENT_ID) {
  return render(
    <CallScreen
      strings={CALL_STRINGS}
      assessmentStrings={ASSESSMENT_STRINGS}
      locale="en"
      client={client}
      getAppointmentId={() => appointmentId}
    />,
  );
}

/** Device check → Continue → Join call → the socket accepts the join. */
async function joinAndConnect() {
  fireEvent.click(await screen.findByRole('button', { name: CALL_STRINGS.deviceCheck.continueLabel }));
  fireEvent.click(await screen.findByRole('button', { name: CALL_STRINGS.joinCall.label }));
  await screen.findByRole('button', { name: CALL_STRINGS.leaveLabel });
  const socket = FakeWebSocket.last as FakeWebSocket;
  await act(async () => {
    socket.open();
  });
  await act(async () => {
    socket.deliver({ type: 'joined' });
  });
  return socket;
}

describe('the clinician’s call screen', () => {
  beforeEach(() => stubFetch(true));

  it('puts the patient’s assessment beside the video', async () => {
    renderScreen();
    await joinAndConnect();
    expect(await screen.findByText(new RegExp(ASSESSMENT_STRINGS.versionLabel))).toBeDefined();
  });

  it('asks for the assessment of the patient named in the appointment id', async () => {
    renderScreen();
    await joinAndConnect();

    await waitFor(() => {
      const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
        String(call[0]),
      );
      // `<patientId>#<scheduledAt>` — the patient half is the one the
      // assessment is about, and it has been in the link all along.
      expect(urls.some((url) => url.includes(`/patients/${PATIENT_ID}/assessments/`))).toBe(true);
    });
  });

  it('keeps the video on screen alongside it', async () => {
    const { container } = renderScreen();
    await joinAndConnect();
    await screen.findByText(new RegExp(ASSESSMENT_STRINGS.versionLabel));
    expect(
      container.querySelector(`video[aria-label="${CALL_STRINGS.remoteVideoLabel}"]`),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: CALL_STRINGS.leaveLabel })).toBeDefined();
  });

  it('shows nothing but the call until the call actually starts', async () => {
    renderScreen();
    // The device check is not a call, and the patient is not on one yet.
    await screen.findByRole('button', { name: CALL_STRINGS.deviceCheck.continueLabel });
    expect(screen.queryByText(new RegExp(ASSESSMENT_STRINGS.versionLabel))).toBeNull();
  });

  it('keeps the form up after the call ends, so notes can be finished', async () => {
    renderScreen();
    await joinAndConnect();
    await screen.findByText(new RegExp(ASSESSMENT_STRINGS.versionLabel));

    fireEvent.click(screen.getByRole('button', { name: CALL_STRINGS.leaveLabel }));
    await screen.findByText(CALL_STRINGS.disconnectedLabel);
    // Unmounting it here would throw away whatever was half-typed about the
    // conversation that just happened.
    expect(screen.getByText(new RegExp(ASSESSMENT_STRINGS.versionLabel))).toBeDefined();
  });

  it('shows only the call when the link carries no patient to look up', async () => {
    renderScreen('not-a-composite-id');
    await joinAndConnect();
    expect(screen.queryByText(new RegExp(ASSESSMENT_STRINGS.versionLabel))).toBeNull();
  });
});

describe('the patient’s call screen', () => {
  beforeEach(() => stubFetch(false));

  it('is the video and nothing else', async () => {
    renderScreen();
    await joinAndConnect();
    // Their own assessment has a page of its own; a call is not the place,
    // and this one carries a clinician-only half the server withholds.
    expect(screen.queryByText(new RegExp(ASSESSMENT_STRINGS.versionLabel))).toBeNull();
  });

  it('never fetches an assessment at all', async () => {
    renderScreen();
    await joinAndConnect();
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(urls.some((url) => url.includes('/assessments/'))).toBe(false);
  });

  it('still gets the whole call — video, controls and all', async () => {
    const { container } = renderScreen();
    await joinAndConnect();
    expect(
      container.querySelector(`video[aria-label="${CALL_STRINGS.remoteVideoLabel}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`video[aria-label="${CALL_STRINGS.localVideoLabel}"]`),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: CALL_STRINGS.turnCameraOnLabel })).toBeDefined();
  });
});

describe('the join sequence is not disturbed by the layout', () => {
  beforeEach(() => stubFetch(true));

  it('opens exactly one socket, however the layout re-renders around it', async () => {
    renderScreen();
    await joinAndConnect();
    await screen.findByText(new RegExp(ASSESSMENT_STRINGS.versionLabel));
    // Resolving the role re-renders this component, and the role callback
    // has to be stable or that re-render tears down and restarts the whole
    // join sequence — the failure this directory has met twice already.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((FakeWebSocket.last as FakeWebSocket).close).not.toHaveBeenCalled();
  });

  it('does not send the clinician back to the device check when the role lands', async () => {
    renderScreen();
    await joinAndConnect();
    await screen.findByText(new RegExp(ASSESSMENT_STRINGS.versionLabel));

    // Returning the call bare before the role resolved and wrapped after it
    // changed the element at that position from `VideoCall` to `div`, which
    // React reconciles by unmounting the subtree — the whole call restarted
    // from "Continue" the instant the role came back.
    expect(
      screen.queryByRole('button', { name: CALL_STRINGS.deviceCheck.continueLabel }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: CALL_STRINGS.joinCall.label })).toBeNull();
    expect(screen.getByRole('button', { name: CALL_STRINGS.leaveLabel })).toBeDefined();
  });

  it('asks for camera permission once, not once per layout change', async () => {
    renderScreen();
    await joinAndConnect();
    await screen.findByText(new RegExp(ASSESSMENT_STRINGS.versionLabel));
    // A remount would re-run `DeviceCheck`'s own effect and prompt again.
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});
