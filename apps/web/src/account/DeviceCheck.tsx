// TASK 4.3.2: moves `getUserMedia` earlier, behind its own permission/
// preview step, so a denied-permission caller gets a legible, accessible
// state rather than a call that silently never connects — the same
// "a failure is a recorded fact, not a silent hang" discipline this phase
// has followed since TASK 4.2.2's `peer-unavailable`.
//
// **One `getUserMedia` call for the initial grant, not two.** This
// component is the only place in this codebase that requests camera/
// microphone permission; `VideoCall.tsx` never calls `getUserMedia`
// itself, it only ever attaches the stream this component hands it via
// `onReady`. Switching devices via the selector below necessarily calls
// `getUserMedia` again (there is no other way to change the active
// device in this API) — that is Step 3's own point, not a second,
// redundant permission-granting flow of the kind the task's own "Do NOT"
// forbids.
//
// **Why a "Continue" control exists here, and not a "Join" button.** This
// task's own DoD is that a caller can act on their own device state
// "before ever attempting to join" — a real gate a caller operates, not
// a flash of UI a default camera choice would otherwise skip past before
// anyone could touch the selector. TASK 4.5.1 owns the appointment-aware
// "Join call" button and its own copy; this is a smaller, generic
// confirmation scoped to devices alone, and `VideoCall.tsx` is what
// begins the actual join sequence once this fires.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type DeviceCheckErrorKind = 'denied' | 'unavailable' | 'error';

/**
 * The one piece of this task's own logic that does not need a DOM to
 * verify — a real `getUserMediaError` name from Chrome/Firefox mapped to
 * the accessible, plain-language state this component shows instead.
 * Anything unrecognised is the generic `error` state, never a console
 * error the caller never sees.
 */
export function classifyMediaError(error: unknown): DeviceCheckErrorKind {
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'denied';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'unavailable';
  }
  return 'error';
}

type Stage =
  | { readonly kind: 'requesting' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly stream: MediaStream };

export interface DeviceCheckStrings {
  readonly requestingLabel: string;
  readonly deniedLabel: string;
  readonly unavailableLabel: string;
  readonly errorLabel: string;
  readonly previewLabel: string;
  readonly cameraLabel: string;
  readonly microphoneLabel: string;
  readonly continueLabel: string;
}

export interface DeviceCheckProps {
  readonly strings: DeviceCheckStrings;
  /** Fires exactly once, when the caller confirms the device state they want to join with. */
  readonly onReady: (stream: MediaStream) => void;
}

async function requestStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function DeviceCheck({ strings, onReady }: DeviceCheckProps): ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'requesting' });
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  // Flipped the instant `onReady` fires — read from the cleanup below
  // instead of `stage`, which the closure this effect captured on mount
  // would otherwise never see updated (it only ever runs once).
  const handedOffRef = useRef(false);

  useEffect(() => {
    let live = true;

    async function start(): Promise<void> {
      let stream: MediaStream;
      try {
        stream = await requestStream({ video: true, audio: true });
      } catch (error) {
        if (live) setStage({ kind: classifyMediaError(error) });
        return;
      }
      if (!live) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setStage({ kind: 'ready', stream });

      // Device labels are only populated once permission has been
      // granted — this is the first point that call is meaningful.
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!live) return;
      setVideoInputs(devices.filter((device) => device.kind === 'videoinput'));
      setAudioInputs(devices.filter((device) => device.kind === 'audioinput'));
    }

    void start();

    return () => {
      live = false;
      // A stream handed off via `onReady` becomes `VideoCall.tsx`'s own
      // to manage from that point on, the same "the caller who attaches
      // a stream is the caller who releases it" boundary every other
      // resource in this codebase already keeps — only an un-handed-off
      // stream (the caller navigated away mid-check) is stopped here.
      if (!handedOffRef.current) {
        streamRef.current?.getTracks().forEach((track) => track.stop());
      }
    };
    // Deliberately `[]`: this must run exactly once. Re-running it would
    // re-prompt for permission mid-check.
  }, []);

  useEffect(() => {
    if (previewRef.current && stage.kind === 'ready') {
      previewRef.current.srcObject = stage.stream;
    }
  }, [stage]);

  async function switchDevice(videoDeviceId: string | undefined, audioDeviceId: string | undefined): Promise<void> {
    if (stage.kind !== 'ready') return;
    let stream: MediaStream;
    try {
      stream = await requestStream({
        video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
      });
    } catch (error) {
      setStage({ kind: classifyMediaError(error) });
      return;
    }
    stage.stream.getTracks().forEach((track) => track.stop());
    streamRef.current = stream;
    setStage({ kind: 'ready', stream });
  }

  function currentDeviceId(stream: MediaStream, kind: 'videoinput' | 'audioinput'): string | undefined {
    const track = kind === 'videoinput' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
    return track?.getSettings().deviceId;
  }

  if (stage.kind === 'requesting') {
    return (
      <p role="status" aria-live="polite">
        {strings.requestingLabel}
      </p>
    );
  }
  if (stage.kind === 'denied') {
    return <p role="alert">{strings.deniedLabel}</p>;
  }
  if (stage.kind === 'unavailable') {
    return <p role="alert">{strings.unavailableLabel}</p>;
  }
  if (stage.kind === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const selectedVideoId = currentDeviceId(stage.stream, 'videoinput');
  const selectedAudioId = currentDeviceId(stage.stream, 'audioinput');

  return (
    <section aria-label={strings.previewLabel}>
      <video ref={previewRef} aria-label={strings.previewLabel} autoPlay playsInline muted />
      {videoInputs.length > 1 && (
        <p>
          <label htmlFor="device-check-camera">{strings.cameraLabel}</label>
          <select
            id="device-check-camera"
            value={selectedVideoId ?? ''}
            onChange={(event) => void switchDevice(event.target.value, selectedAudioId)}
          >
            {videoInputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || device.deviceId}
              </option>
            ))}
          </select>
        </p>
      )}
      {audioInputs.length > 1 && (
        <p>
          <label htmlFor="device-check-microphone">{strings.microphoneLabel}</label>
          <select
            id="device-check-microphone"
            value={selectedAudioId ?? ''}
            onChange={(event) => void switchDevice(selectedVideoId, event.target.value)}
          >
            {audioInputs.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || device.deviceId}
              </option>
            ))}
          </select>
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          handedOffRef.current = true;
          onReady(stage.stream);
        }}
      >
        {strings.continueLabel}
      </button>
    </section>
  );
}
