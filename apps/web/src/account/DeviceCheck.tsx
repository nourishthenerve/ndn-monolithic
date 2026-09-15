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
// **2026-09-15: one screen, not two — confirming devices *is* joining.**
// The owner: *"As soon as I click join call it should open a screen where I
// see myself and if I want to correct myself. Then there should be a button
// called confirm … and when I click that I should actually get connected."*
// There used to be a second, separate "Join call" button after this one
// (TASK 4.5.1's `JoinCallButton`): a caller pressed Continue here, then
// Join on a bare next screen. Both presses asked the same thing — "start
// the call now" — so they are one now, and this component's Confirm button
// is what `VideoCall.tsx` turns into the actual join. The appointment-window
// gate that button screen never owned still sits ahead of this component in
// `VideoCall.tsx`, so what a caller can confirm and what the server accepts
// still agree.
import { Button } from '@ndn/ui';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

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
  /** The single confirm-and-join control — was "Continue" behind a second "Join" button, now the only press before the call. */
  readonly confirmLabel: string;
}

/**
 * 2026-09-15: the pre-call screen's own styling, so it reads as part of the
 * theme rather than as three unstyled controls stacked on a full-resolution
 * `<video>` that overflowed a phone. Inline for the same reason
 * `VideoCall.tsx`'s stage is: `apps/web` ships no CSS pipeline for islands,
 * and the CSP already allows `style-src 'unsafe-inline'`. The selectors and
 * the button borrow the global primitive classes (`.ndn-input`,
 * `.ndn-button`, via `@ndn/ui`'s `Button`) that `BaseLayout` injects on
 * every page.
 */
const DEVICE_CHECK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  maxWidth: '40rem',
};

/**
 * `width: 100%` with the aspect ratio *on the element* is the actual
 * overflow fix the owner reported: a `<video>` with no width takes its
 * stream's own pixel size (640×480, say), which the page has no rule to
 * shrink — the global reset's `img { max-width: 100% }` does not reach
 * `<video>`. Mirrored, so this preview matches the in-call self-view rather
 * than flipping the moment the call starts.
 */
const PREVIEW_STYLE: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  objectFit: 'cover',
  background: '#000',
  borderRadius: '0.5rem',
  border: '1px solid var(--ndn-color-border-strong)',
  transform: 'scaleX(-1)',
  display: 'block',
};

const DEVICE_FIELDS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '1rem',
};

/** Each selector shares the row on a wide screen and drops to its own line under ~14rem. */
const DEVICE_FIELD_STYLE: CSSProperties = { flex: '1 1 14rem', margin: 0 };

export interface DeviceCheckProps {
  readonly strings: DeviceCheckStrings;
  /** Fires exactly once, when the caller confirms the device state they want to join with. */
  readonly onReady: (stream: MediaStream) => void;
  /**
   * 2026-09-07: hands off the moment the stream is live, without waiting
   * for the Continue press.
   *
   * For **rejoining**, and only for rejoining. A call that drops has to be
   * able to come back without walking the caller through a device choice
   * they already made — permission is granted by then, so re-acquiring is
   * silent and instant, and a second "Continue" between a dropped call and
   * its recovery is a gate with nothing behind it. The first join keeps the
   * gate, which is TASK 4.3.2's own point: a caller must be able to act on
   * their device state before ever attempting to join.
   */
  readonly autoContinue?: boolean;
}

async function requestStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function DeviceCheck({ strings, onReady, autoContinue = false }: DeviceCheckProps): ReactNode {
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

  // The hand-off `autoContinue` describes. Guarded by the same ref the
  // button sets, so a re-render can never hand the same stream over twice
  // — and so the cleanup above still knows this stream is no longer its
  // to stop.
  useEffect(() => {
    if (!autoContinue || stage.kind !== 'ready' || handedOffRef.current) {
      return;
    }
    handedOffRef.current = true;
    onReady(stage.stream);
  }, [autoContinue, stage, onReady]);

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
    <section aria-label={strings.previewLabel} style={DEVICE_CHECK_STYLE}>
      <video
        ref={previewRef}
        aria-label={strings.previewLabel}
        autoPlay
        playsInline
        muted
        style={PREVIEW_STYLE}
      />
      {(videoInputs.length > 1 || audioInputs.length > 1) && (
        <div style={DEVICE_FIELDS_STYLE}>
          {videoInputs.length > 1 && (
            <p className="ndn-input-wrapper" style={DEVICE_FIELD_STYLE}>
              <label className="ndn-input-label" htmlFor="device-check-camera">
                {strings.cameraLabel}
              </label>
              <select
                className="ndn-input"
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
            <p className="ndn-input-wrapper" style={DEVICE_FIELD_STYLE}>
              <label className="ndn-input-label" htmlFor="device-check-microphone">
                {strings.microphoneLabel}
              </label>
              <select
                className="ndn-input"
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
        </div>
      )}
      {/* A wrapper so the pill sizes to its own content: a flex column
          stretches its children, and a full-width pill reads as a banner
          rather than a button. */}
      <div>
        <Button
          type="button"
          onClick={() => {
            handedOffRef.current = true;
            onReady(stage.stream);
          }}
        >
          {strings.confirmLabel}
        </Button>
      </div>
    </section>
  );
}
