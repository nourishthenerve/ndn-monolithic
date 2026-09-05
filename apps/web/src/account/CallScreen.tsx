// 2026-09-05: the call page's own layout, and the one thing that differs
// between the two people on the call.
//
// The owner: *"when both patients and clinician connects I want patient's
// full assessment form and details to be shown to the clinician so that he
// can edit the details as they discuss over the call. For patient make
// video box cover the entire window but for clinician keep video box to the
// left and assessment form to the right."*
//
// **Why this is a component and not two `.astro` branches.** `call.astro`
// is statically generated and knows nothing at runtime — least of all
// which end of the call is loading it. Which end this is gets resolved
// inside `VideoCall` (by asking whether `GET /clinicians/me/calendar`
// answers), and two sibling Astro islands cannot share that answer.
// So the layout has to live in the one island that can hear it.
//
// **What it does not do: decide anything about access.** The clinician
// sees the sections `GET /patients/{id}/assessments/{id}` chooses to send
// them and can save the ones the server accepts — `assessment.ts` and the
// `can()` matrix are unchanged and remain the only boundary. Putting the
// form on this page adds a *place* to edit from, not a permission.
import type { Locale } from '@ndn/i18n';
import { useCallback, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';

import { AssessmentForm, type AssessmentFormStrings } from './AssessmentForm.js';
import { parsePatientId } from './join-window.js';
import { VideoCall, type CallRole, type VideoCallStrings } from './VideoCall.js';

export interface CallScreenProps {
  readonly strings: VideoCallStrings;
  /** The patient's own assessment, shown beside the video for the clinician alone. */
  readonly assessmentStrings: AssessmentFormStrings;
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to `?appointmentId=` on the current URL — the same source `VideoCall` reads. */
  readonly getAppointmentId?: () => string | undefined;
}

function appointmentIdFromLocation(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return new URLSearchParams(window.location.search).get('appointmentId') ?? undefined;
}

/**
 * Side by side on anything wide enough, stacked below it. `1fr 1fr` rather
 * than a fixed split: a consulting-room monitor and a laptop want very
 * different absolute widths, and neither half is more important than the
 * other while a call is happening.
 */
const CLINICIAN_LAYOUT_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))',
  gap: '1.5rem',
  alignItems: 'start',
};

/**
 * The form scrolls inside its own column rather than lengthening the page.
 * The assessment is long, and a clinician who scrolls to the bottom of it
 * must not lose sight of the person they are talking to.
 */
/**
 * One column, the full width of the page — *"for patient make video box
 * cover the entire window"*. The same wrapper the clinician gets, so the
 * call inside it is never remounted by the layout changing around it.
 */
const PATIENT_LAYOUT_STYLE: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr' };

const ASSESSMENT_COLUMN_STYLE: CSSProperties = {
  maxHeight: 'calc(100vh - 10rem)',
  overflowY: 'auto',
  // Room for a focus ring on the controls nearest the edge, which
  // `overflow` would otherwise clip.
  padding: '0.25rem',
};

export function CallScreen({
  strings,
  assessmentStrings,
  locale,
  client,
  getAppointmentId = appointmentIdFromLocation,
}: CallScreenProps): ReactNode {
  /**
   * `undefined` until the join sequence has worked out which end of the
   * call this is — which is also, usefully, "the call has not started
   * yet". Until then this renders exactly what the page rendered before
   * this component existed: the device check, then the join button.
   */
  const [role, setRole] = useState<CallRole | undefined>();

  // Stable across renders: `VideoCall` holds it in a dependency array, and
  // a fresh identity each render would re-run the whole join sequence —
  // the mistake this directory has been bitten by twice (`useNow.ts`).
  const onRoleResolved = useCallback((resolved: CallRole) => {
    setRole(resolved);
  }, []);

  const call = (
    <VideoCall
      strings={strings}
      locale={locale}
      client={client}
      getAppointmentId={getAppointmentId}
      onRoleResolved={onRoleResolved}
      fillWidth
    />
  );

  const appointmentId = getAppointmentId();
  const patientId = appointmentId ? parsePatientId(appointmentId) : undefined;
  // The patient's own screen is the video and nothing else — they are on a
  // call, not filling in a form, and their own assessment already has a
  // page of its own that shows them the half of it they are allowed.
  const withAssessment = role === 'clinician' && patientId !== undefined;

  // **The wrapper is not optional, and that is a bug fix rather than a
  // style.** Returning `call` bare before the role resolved and a nested
  // `<div>` after it changed the element at this position from `VideoCall`
  // to `div`, which React reconciles by *unmounting the old subtree* — so
  // the moment the role came back, the entire call was torn down and
  // restarted from the device check. The structure below is identical in
  // both cases: same wrapper, same first child, and only the sibling and
  // the layout change. `CallScreen.render.test.tsx` holds it there.
  return (
    <div style={withAssessment ? CLINICIAN_LAYOUT_STYLE : PATIENT_LAYOUT_STYLE}>
      <div>{call}</div>
      {/* **Mounted for the rest of the page's life, not while `connected`.**
          The literal reading of "when both connect" would mount this on the
          connected state — and unmount it on every reconnect, taking any
          half-typed note with it. A blip in someone's wifi must not throw
          away what a clinician was writing about them. It appears when the
          call starts and stays, including after the call ends, so notes
          taken during the conversation can be finished after it. */}
      {withAssessment ? (
        <div style={ASSESSMENT_COLUMN_STYLE}>
          <AssessmentForm strings={assessmentStrings} patientId={patientId} client={client} />
        </div>
      ) : null}
    </div>
  );
}
