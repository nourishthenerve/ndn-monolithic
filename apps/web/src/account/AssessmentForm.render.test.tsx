// @vitest-environment jsdom
//
// 2026-09-01: **the first rendered-component test in `apps/web`**, and the
// reason it is worth introducing the pattern here rather than following
// this directory's own "pure functions only" precedent one more time.
//
// Every prior island in this directory shows one role one thing, so
// asserting its pure helpers really did cover the interesting behaviour.
// This one shows five roles five different subsets of one clinical record,
// and the interesting behaviour *is* the rendering: "a patient sees no
// clinician-section field" is not a property of any helper, it is a
// property of the tree. `AssessmentForm.test.ts` still pins the helpers;
// this file pins what a person actually sees.
//
// The toolchain is not new to the repo — `packages/ui` has rendered its
// primitives with @testing-library/react since TASK 1.1.1. What is new is
// `apps/web` depending on it.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssessmentForm, ASSESSMENT_SAVED_EVENT } from './AssessmentForm.js';
import type { AssessmentFormStrings } from './AssessmentForm.js';

afterEach(cleanup);

const STRINGS: AssessmentFormStrings = {
  heading: 'Assessment form',
  loadingLabel: 'Loading…',
  forbiddenLabel: 'You do not have access to this form.',
  notFoundLabel: 'That patient could not be found.',
  errorLabel: 'Something went wrong.',
  missingIdLabel: 'Choose a patient from the dashboard.',
  saveLabel: 'Save this section',
  savingLabel: 'Saving…',
  savedLabel: 'Saved.',
  autosavedLabel: 'Saved automatically.',
  conflictLabel: 'Someone else changed this form.',
  saveForbiddenLabel: 'You do not have permission to change this section.',
  readOnlyLabel: 'You can read this section but not change it.',
  attachmentsHeading: 'Files',
  attachmentsEmpty: 'No files have been added to this section.',
  addFileLabel: 'Add a file',
  uploadingLabel: 'Uploading…',
  uploadFailedLabel: 'That file could not be uploaded.',
  downloadLabel: 'Open',
  uploadedAtTemplate: 'Uploaded {when}',
  addRowLabel: 'Add a row',
  removeRowLabel: 'Remove this row',
  addRowAriaTemplate: 'Add a row to {field}',
  removeRowAriaTemplate: 'Remove row {row} from {field}',
  cellLabelTemplate: '{field} — {column}, row {row}',
  noNextAppointmentLabel: 'No appointment is booked yet.',
  versionLabel: 'Version:',
};

const GENERAL_SECTION = {
  fieldSet: 'general',
  title: 'Patient Details',
  fields: [
    { id: 'tag', label: 'Programme tag', type: 'select', options: ['IIC', 'NDN'], staffOnly: true },
    { id: 'preferredName', label: 'Preferred name', type: 'text' },
  ],
};
const PRESCRIPTION_SECTION = {
  fieldSet: 'prescription',
  title: 'Patient Prescription',
  fields: [{ id: 'goals', label: 'What you would like to achieve', type: 'textarea' }],
};
const PRIVATE_SECTION = {
  fieldSet: 'private',
  title: 'Patient Assessment Form',
  fields: [{ id: 'clinicianImpression', label: 'Clinical impression', type: 'textarea' }],
};
const CALENDAR_SECTION = {
  fieldSet: 'calendar',
  title: 'Patient Appointments',
  fields: [
    // 2026-09-09: `nextAppointmentAt` is in the fixture because the real
    // template has always had it and one rendering decision now depends on
    // it — "no appointment is booked yet" is rendered by the placement
    // showing this field, not by every placement of the section. See
    // `showReadOnlyNote`'s own note in AssessmentForm.tsx.
    { id: 'nextAppointmentAt', label: 'Next appointment', type: 'datetime', derived: true },
    { id: 'sessionsCompleted', label: 'Sessions so far', type: 'number', derived: true },
    { id: 'schedulingNotes', label: 'Scheduling notes', type: 'textarea' },
  ],
};

/** A stand-in for the session: the token's only job here is to say which pool the viewer came from. */
function client(token: string) {
  return { authorization: () => Promise.resolve(token) } as never;
}

/**
 * A token this bundle reads as a *patient*. `token-claims.ts` decides by
 * `iss` against `site-config.ts`'s issuer constants; a token from neither
 * pool is "cannot tell", which is the fallback case one test below relies
 * on.
 */
function tokenFor(issuer: string | undefined): string {
  const payload = issuer === undefined ? {} : { iss: issuer };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${body}.signature`;
}

const UNKNOWN_POOL_TOKEN = tokenFor('https://example.invalid/nobody');

function payloadFor(options: {
  readonly template: unknown[];
  readonly permissions: unknown[];
  readonly items?: unknown[];
  readonly calendarSummary?: unknown;
  readonly currentVersion?: number;
}) {
  return {
    currentVersion: options.currentVersion ?? 1,
    template: options.template,
    permissions: options.permissions,
    calendarSummary: options.calendarSummary,
    items: options.items ?? [],
  };
}

const PDF_ATTACHMENT = {
  key: 'assessments/pat-1/intake-v1/general/uuid-scan.pdf',
  fileName: 'scan.pdf',
  contentType: 'application/pdf',
  uploadedAt: '2026-09-01T09:00:00.000Z',
};

const IMAGE_ATTACHMENT = {
  key: 'assessments/pat-1/intake-v1/general/uuid-photo.png',
  fileName: 'photo.png',
  contentType: 'image/png',
  uploadedAt: '2026-09-01T09:00:00.000Z',
};

/** One writable general section carrying one file — the shape every attachment test below wants. */
function withAttachment(attachment: unknown) {
  return {
    template: [GENERAL_SECTION],
    permissions: [{ fieldSet: 'general', read: true, write: true }],
    items: [
      {
        version: 1,
        updated_at: '2026-09-01T09:00:00.000Z',
        general: { responses: {}, attachments: [attachment] },
      },
    ],
  };
}

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('what each role is shown', () => {
  // The patient's own view: the server sends three sections and marks only
  // general writable. Nothing about the clinician's section reaches here at
  // all — not a hidden input, not a disabled one, not a label.
  it('shows a patient an editable general section, read-only patient and calendar, and no clinician section', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="me"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION, PRESCRIPTION_SECTION, CALENDAR_SECTION],
              permissions: [
                { fieldSet: 'general', read: true, write: true },
                { fieldSet: 'prescription', read: true, write: false },
                { fieldSet: 'private', read: false, write: false },
                { fieldSet: 'calendar', read: true, write: false },
              ],
              items: [
                {
                  version: 1,
                  updated_at: '2026-09-01T09:00:00.000Z',
                  general: { responses: { preferredName: 'Sam' }, attachments: [] },
                  prescription: { responses: { goals: 'walk unaided' }, attachments: [] },
                  calendar: { responses: {}, attachments: [] },
                },
              ],
              calendarSummary: { sessionsCompleted: 2, appointmentsAwaitingApproval: 0 },
            }),
          )
        }
      />,
    );

    await screen.findByText('Patient Details');
    // Editable: a real input, findable by its label.
    expect(screen.getByLabelText('Preferred name')).toBeDefined();
    // Read-only: the answer is on the page, but not as a form control.
    expect(screen.getByText(/walk unaided/)).toBeDefined();
    expect(screen.queryByLabelText('What you would like to achieve')).toBeNull();
    // R-09, at the level a person actually experiences it.
    expect(screen.queryByText('Patient Assessment Form')).toBeNull();
    expect(screen.queryByLabelText('Clinical impression')).toBeNull();
    // One save button — general is the only writable section.
    // Two per writable section — under the heading and after the fields.
    // General is the only one this patient may write.
    expect(screen.getAllByRole('button', { name: 'Save this section' })).toHaveLength(2);
  });

  it('offers a clinician every section, each with its own save button', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION, PRESCRIPTION_SECTION, PRIVATE_SECTION, CALENDAR_SECTION],
              permissions: [
                { fieldSet: 'general', read: true, write: true },
                { fieldSet: 'prescription', read: true, write: true },
                { fieldSet: 'private', read: true, write: true },
                { fieldSet: 'calendar', read: true, write: true },
              ],
              calendarSummary: { sessionsCompleted: 4, appointmentsAwaitingApproval: 1 },
            }),
          )
        }
      />,
    );

    await screen.findByText('Patient Assessment Form');
    expect(screen.getByLabelText('Clinical impression')).toBeDefined();
    // Four writable sections, two controls each.
    expect(screen.getAllByRole('button', { name: 'Save this section' })).toHaveLength(8);
  });

  it('marks a read-only section as such rather than silently offering nothing', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [CALENDAR_SECTION],
              permissions: [
                { fieldSet: 'general', read: false, write: false },
                { fieldSet: 'prescription', read: false, write: false },
                { fieldSet: 'private', read: false, write: false },
                { fieldSet: 'calendar', read: true, write: false },
              ],
              calendarSummary: { sessionsCompleted: 0, appointmentsAwaitingApproval: 0 },
            }),
          )
        }
      />,
    );

    await screen.findByText('Patient Appointments');
    expect(screen.getByText(STRINGS.readOnlyLabel)).toBeDefined();
    expect(screen.queryByLabelText('Scheduling notes')).toBeNull();
  });

  it('renders a derived calendar figure as text, never as an input', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [CALENDAR_SECTION],
              permissions: [
                { fieldSet: 'general', read: false, write: false },
                { fieldSet: 'prescription', read: false, write: false },
                { fieldSet: 'private', read: false, write: false },
                { fieldSet: 'calendar', read: true, write: true },
              ],
              calendarSummary: { sessionsCompleted: 7, appointmentsAwaitingApproval: 0 },
            }),
          )
        }
      />,
    );

    await screen.findByText('Patient Appointments');
    // The figure is shown…
    expect(screen.getByText('7')).toBeDefined();
    // …and there is no control through which it could be sent back.
    expect(screen.queryByLabelText('Sessions so far')).toBeNull();
    // The writable field in the same section still is one.
    expect(screen.getByLabelText('Scheduling notes')).toBeDefined();
  });

  it('says so when there is no appointment booked', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [CALENDAR_SECTION],
              permissions: [{ fieldSet: 'calendar', read: true, write: true }],
              calendarSummary: { sessionsCompleted: 0, appointmentsAwaitingApproval: 0 },
            }),
          )
        }
      />,
    );
    expect(await screen.findByText(STRINGS.noNextAppointmentLabel)).toBeDefined();
  });
});

// 2026-09-09: the patient dashboard mounts the calendar section twice —
// two figures above `AppointmentCalendar`, the rest below it, with three
// fields the owner cut showing in neither. What each mount renders is the
// whole of that arrangement, so it is asserted here rather than inferred
// from `placementSections`.
describe('a placement narrowed to fields', () => {
  const calendarPayload = (write = false) =>
    payloadFor({
      template: [CALENDAR_SECTION],
      permissions: [{ fieldSet: 'calendar', read: true, write }],
      calendarSummary: {
        nextAppointmentAt: '2026-09-20T10:00:00.000Z',
        sessionsCompleted: 3,
        appointmentsAwaitingApproval: 2,
      },
    });

  it('renders only the fields it named', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        onlyFields={['nextAppointmentAt']}
        showAttachments={false}
        fetchForm={() => ok(calendarPayload())}
      />,
    );

    await screen.findByText('Next appointment');
    expect(screen.queryByText('Sessions so far')).toBeNull();
    expect(screen.queryByText('Scheduling notes')).toBeNull();
  });

  it('renders everything but the fields it hid', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        hideFields={['nextAppointmentAt', 'schedulingNotes']}
        showAttachments={false}
        fetchForm={() => ok(calendarPayload())}
      />,
    );

    await screen.findByText('Sessions so far');
    expect(screen.queryByText('Next appointment')).toBeNull();
    expect(screen.queryByText('Scheduling notes')).toBeNull();
  });

  it('cannot reach a field the server did not send', async () => {
    // The rule the header claims for both placement filters. `private` is
    // absent from this template because the server refused it, and naming
    // one of its fields renders nothing rather than reaching for it.
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        onlyFields={['clinicianImpression']}
        fetchForm={() => ok(calendarPayload())}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(STRINGS.loadingLabel)).toBeNull();
    });
    expect(screen.queryByText('Patient Appointments')).toBeNull();
    expect(screen.queryByText('Clinical impression')).toBeNull();
  });

  it('does not save a hidden field, even one a draft could name', async () => {
    // A hidden field renders no control, so nothing can put it in the
    // drafts — but the save reads the *narrowed* section, which is what
    // makes that structural rather than incidental.
    const saveSection = vi.fn(() => ok({ item: {} }));
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        hideFields={['schedulingNotes']}
        saveSection={saveSection}
        fetchForm={() => ok(calendarPayload(true))}
      />,
    );

    await screen.findByText('Patient Appointments');
    expect(screen.queryByLabelText('Scheduling notes')).toBeNull();
    // The section's own save button is still offered — the caller may write
    // this section — and pressing it sends nothing, because the narrowed
    // section has no writable field left to send.
    fireEvent.click(screen.getAllByRole('button', { name: 'Save this section' })[0] as Element);
    await waitFor(() => {
      expect(saveSection).not.toHaveBeenCalled();
    });
  });

  it('leaves the read-only note to the placement that was told to carry it', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        showReadOnlyNote={false}
        showAttachments={false}
        fetchForm={() => ok(calendarPayload())}
      />,
    );

    await screen.findByText('Patient Appointments');
    expect(screen.queryByText(STRINGS.readOnlyLabel)).toBeNull();
  });

  it('says "no appointment booked" only where the figure it explains is', async () => {
    const empty = payloadFor({
      template: [CALENDAR_SECTION],
      permissions: [{ fieldSet: 'calendar', read: true, write: false }],
      calendarSummary: { sessionsCompleted: 0, appointmentsAwaitingApproval: 0 },
    });
    const { unmount } = render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        onlyFields={['nextAppointmentAt']}
        showAttachments={false}
        fetchForm={() => ok(empty)}
      />,
    );
    expect(await screen.findByText(STRINGS.noNextAppointmentLabel)).toBeDefined();
    unmount();

    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        hideFields={['nextAppointmentAt']}
        showAttachments={false}
        fetchForm={() => ok(empty)}
      />,
    );
    await screen.findByText('Sessions so far');
    expect(screen.queryByText(STRINGS.noNextAppointmentLabel)).toBeNull();
  });
});

describe('attachments', () => {
  it("lists a section's files with a way to open each", async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
              items: [
                {
                  version: 1,
                  updated_at: '2026-09-01T09:00:00.000Z',
                  general: {
                    responses: {},
                    attachments: [
                      {
                        key: 'assessments/pat-1/intake-v1/general/uuid-scan.pdf',
                        fileName: 'scan.pdf',
                        contentType: 'application/pdf',
                        uploadedAt: '2026-09-01T09:00:00.000Z',
                      },
                    ],
                  },
                },
              ],
            }),
          )
        }
      />,
    );

    await screen.findByText('scan.pdf');
    expect(screen.getByRole('button', { name: 'Open' })).toBeDefined();
    // Writable, so the upload control is offered.
    expect(screen.getByLabelText('Add a file')).toBeDefined();
  });

  it('offers no upload control on a section the caller may only read', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: false }],
            }),
          )
        }
      />,
    );
    await screen.findByText('Patient Details');
    expect(screen.getByText(STRINGS.attachmentsEmpty)).toBeDefined();
    expect(screen.queryByLabelText('Add a file')).toBeNull();
  });

  // 2026-09-09: *"whatever file the patient uploads, I need a timestamp as
  // well so that I know when it was uploaded."*
  it('says when each file was uploaded, in the site locale rather than the browser one', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        locale="en"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => ok(payloadFor(withAttachment(PDF_ATTACHMENT)))}
      />,
    );

    await screen.findByText('scan.pdf');
    // The template's own `{when}` is spent, and what replaces it is a
    // formatted instant rather than the stored ISO string.
    const stamp = screen.getByText(/^Uploaded /);
    expect(stamp.textContent).not.toContain('{when}');
    expect(stamp.textContent).not.toContain('2026-09-01T09:00:00.000Z');
    expect(stamp.textContent).toContain('2026');
  });

  // *"if possible a small thumbnail so that I dont have to option it to get
  // a feel what's in there."*
  it('draws a picture attachment as a thumbnail, through the same signed-URL route', async () => {
    const requestDownloadUrl = vi.fn(() =>
      ok({ downloadUrl: 'https://media.example/x.png?sig=1' }),
    );
    const { container } = render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        requestDownloadUrl={requestDownloadUrl}
        fetchForm={() => ok(payloadFor(withAttachment(IMAGE_ATTACHMENT)))}
      />,
    );

    await screen.findByText('photo.png');
    await waitFor(() => {
      expect(container.querySelector('img.ndn-record-attachment-image')).not.toBeNull();
    });
    const image = container.querySelector('img.ndn-record-attachment-image');
    expect(image?.getAttribute('src')).toBe('https://media.example/x.png?sig=1');
    // An attachment has no URL of its own: the preview is minted by the
    // same authorised route the Open button uses.
    expect(requestDownloadUrl).toHaveBeenCalledWith(UNKNOWN_POOL_TOKEN, 'pat-1', {
      section: 'general',
      key: 'assessments/pat-1/intake-v1/general/uuid-photo.png',
    });
  });

  it('asks once per picture, however often the form re-reads', async () => {
    const requestDownloadUrl = vi.fn(() =>
      ok({ downloadUrl: 'https://media.example/x.png?sig=1' }),
    );
    const { container } = render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        requestDownloadUrl={requestDownloadUrl}
        fetchForm={() => ok(payloadFor(withAttachment(IMAGE_ATTACHMENT)))}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('img.ndn-record-attachment-image')).not.toBeNull();
    });

    // What a sibling placement's save fires, thirty seconds of autosave
    // fires, and what a second presign per tick would turn into a leak.
    window.dispatchEvent(new Event(ASSESSMENT_SAVED_EVENT));
    await waitFor(() => {
      expect(requestDownloadUrl).toHaveBeenCalledTimes(1);
    });
  });

  it('mints no preview for a file no browser would draw', async () => {
    const requestDownloadUrl = vi.fn(() => ok({ downloadUrl: 'https://media.example/x?sig=1' }));
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        requestDownloadUrl={requestDownloadUrl}
        fetchForm={() =>
          ok(
            payloadFor(
              withAttachment({
                key: 'assessments/pat-1/intake-v1/general/uuid-snap.heic',
                fileName: 'snap.heic',
                contentType: 'image/heic',
                uploadedAt: '2026-09-01T09:00:00.000Z',
              }),
            ),
          )
        }
      />,
    );

    await screen.findByText('snap.heic');
    // The lettered tile stands in, and nothing was signed for it.
    expect(screen.getByText('HEIC')).toBeDefined();
    expect(requestDownloadUrl).not.toHaveBeenCalled();
  });

  it('leaves the Files block out of a placement that asked for no attachments', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        showAttachments={false}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => ok(payloadFor(withAttachment(PDF_ATTACHMENT)))}
      />,
    );

    await screen.findByText('Patient Details');
    expect(screen.queryByText(STRINGS.attachmentsHeading)).toBeNull();
    expect(screen.queryByText('scan.pdf')).toBeNull();
    expect(screen.queryByLabelText('Add a file')).toBeNull();
  });

  it('asks for a signed URL and opens it, rather than linking the object key', async () => {
    const openUrl = vi.fn();
    const requestDownloadUrl = vi.fn(() =>
      ok({ downloadUrl: 'https://media.example/signed?sig=x' }),
    );
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        openUrl={openUrl}
        requestDownloadUrl={requestDownloadUrl}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: false }],
              items: [
                {
                  version: 1,
                  updated_at: '2026-09-01T09:00:00.000Z',
                  general: {
                    responses: {},
                    attachments: [
                      {
                        key: 'assessments/pat-1/intake-v1/general/uuid-scan.pdf',
                        fileName: 'scan.pdf',
                        contentType: 'application/pdf',
                        uploadedAt: '2026-09-01T09:00:00.000Z',
                      },
                    ],
                  },
                },
              ],
            }),
          )
        }
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledWith('https://media.example/signed?sig=x');
    });
    // The section travels with the request: the server checks the key
    // against that section's own prefix.
    expect(requestDownloadUrl).toHaveBeenCalledWith(UNKNOWN_POOL_TOKEN, 'pat-1', {
      section: 'general',
      key: 'assessments/pat-1/intake-v1/general/uuid-scan.pdf',
    });
  });
});

describe('states that are not a form', () => {
  it('asks staff to choose a patient when no id is on the URL', async () => {
    render(<AssessmentForm strings={STRINGS} patientId="" client={client(UNKNOWN_POOL_TOKEN)} />);
    expect(await screen.findByText(STRINGS.missingIdLabel)).toBeDefined();
  });

  it('shows the forbidden state for a 403, not an error', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('shows the not-found state for a 404 — which is also what a visitor gets outside their programme', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => Promise.resolve({ ok: false, status: 404 } as Response)}
      />,
    );
    expect(await screen.findByText(STRINGS.notFoundLabel)).toBeDefined();
  });

  it('shows the error state when the request itself fails', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => Promise.reject(new Error('network'))}
      />,
    );
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });

  it('is forbidden when there is no session at all', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={{ authorization: () => Promise.resolve(undefined) } as never}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('renders the template for a patient whose form has never been written', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              currentVersion: 0,
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
              items: [],
            }),
          )
        }
      />,
    );
    // A fresh form and an empty form look the same, which is the point.
    await screen.findByText('Patient Details');
    expect((screen.getByLabelText('Preferred name') as HTMLInputElement).value).toBe('');
  });
});

describe('saving', () => {
  it('sends only the touched field, as a section patch against the version it read', async () => {
    const saveSection = vi.fn(() => ok({ item: { version: 2 } }));
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        saveSection={saveSection}
        fetchForm={() =>
          ok(
            payloadFor({
              currentVersion: 3,
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
            }),
          )
        }
      />,
    );

    // `fireEvent.change`, not a bare `.value =` plus a dispatched event:
    // React keeps its own value tracker, and a direct assignment leaves the
    // two in step so no `onChange` fires at all.
    fireEvent.change(await screen.findByLabelText('Preferred name'), {
      target: { value: 'Sammy' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save this section' })[0]!);

    await waitFor(() => {
      expect(saveSection).toHaveBeenCalledWith(UNKNOWN_POOL_TOKEN, 'pat-1', {
        baseVersion: 3,
        sections: { general: { responses: { preferredName: 'Sammy' } } },
      });
    });
  });

  it('sends nothing at all when the button is pressed with no change made', async () => {
    const saveSection = vi.fn(() => ok({ item: { version: 2 } }));
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        saveSection={saveSection}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
            }),
          )
        }
      />,
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'Save this section' }))[0]!);
    await waitFor(() => {
      expect(saveSection).not.toHaveBeenCalled();
    });
  });

  it('reports a 409 as a conflict and reloads, rather than as a generic error', async () => {
    let calls = 0;
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        saveSection={() => Promise.resolve({ ok: false, status: 409 } as Response)}
        fetchForm={() => {
          calls += 1;
          return ok(
            payloadFor({
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
            }),
          );
        }}
      />,
    );

    // `fireEvent.change`, not a bare `.value =` plus a dispatched event:
    // React keeps its own value tracker, and a direct assignment leaves the
    // two in step so no `onChange` fires at all.
    fireEvent.change(await screen.findByLabelText('Preferred name'), {
      target: { value: 'Sammy' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save this section' })[0]!);

    // Reported at both save controls — the message has to reach whoever
    // is at the top of a long section as well as the bottom.
    expect(await screen.findAllByText(STRINGS.conflictLabel)).toHaveLength(2);
    // Re-read, because the draft was computed against a version that no
    // longer exists.
    expect(calls).toBeGreaterThan(1);
  });

  it('reports a 403 in its own words', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        saveSection={() => Promise.resolve({ ok: false, status: 403 } as Response)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [GENERAL_SECTION],
              permissions: [{ fieldSet: 'general', read: true, write: true }],
            }),
          )
        }
      />,
    );

    // `fireEvent.change`, not a bare `.value =` plus a dispatched event:
    // React keeps its own value tracker, and a direct assignment leaves the
    // two in step so no `onChange` fires at all.
    fireEvent.change(await screen.findByLabelText('Preferred name'), {
      target: { value: 'Sammy' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save this section' })[0]!);

    expect(await screen.findAllByText(STRINGS.saveForbiddenLabel)).toHaveLength(2);
  });
});

// 2026-09-07: the owner's rework gives each section of the record a named
// area of the page, and two of those areas carry non-assessment content
// too. So a page mounts this component once per area and tells each mount
// which sections belong to it. These pin the three props that makes
// possible — and, more importantly, pin that `fieldSets` cannot widen what
// the server sent.
describe('one component, several placements', () => {
  const ALL_SECTIONS = [GENERAL_SECTION, PRESCRIPTION_SECTION, PRIVATE_SECTION, CALENDAR_SECTION];
  const ALL_WRITABLE = [
    { fieldSet: 'general', read: true, write: true },
    { fieldSet: 'prescription', read: true, write: true },
    { fieldSet: 'private', read: true, write: true },
    { fieldSet: 'calendar', read: true, write: true },
  ];

  it('renders only the sections a placement names', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        fieldSets={['prescription']}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => ok(payloadFor({ template: ALL_SECTIONS, permissions: ALL_WRITABLE }))}
      />,
    );

    expect(await screen.findByText('Patient Prescription')).toBeDefined();
    expect(screen.queryByText('Patient Details')).toBeNull();
    expect(screen.queryByText('Patient Assessment Form')).toBeNull();
    expect(screen.queryByText('Patient Appointments')).toBeNull();
  });

  // The property the whole arrangement rests on. A page is free to ask for
  // a section on behalf of someone who may not read it — `patient-record`
  // does exactly that for a helpdesk session, gated only by a role guess —
  // and the answer has to be "nothing", decided by the payload rather than
  // by the page's guess.
  it('renders nothing at all when the server did not send the named section', async () => {
    const { container } = render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        fieldSets={['private']}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              // A patient's payload: the clinician section is absent, not
              // present-and-empty.
              template: [GENERAL_SECTION, PRESCRIPTION_SECTION, CALENDAR_SECTION],
              permissions: [
                { fieldSet: 'general', read: true, write: true },
                { fieldSet: 'prescription', read: true, write: false },
                { fieldSet: 'private', read: false, write: false },
                { fieldSet: 'calendar', read: true, write: false },
              ],
            }),
          )
        }
      />,
    );

    // Not even the version line, which would otherwise stand alone under a
    // heading the page has already written.
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('omits the section title when the page has written the heading itself', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        fieldSets={['general']}
        showTitles={false}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => ok(payloadFor({ template: ALL_SECTIONS, permissions: ALL_WRITABLE }))}
      />,
    );

    // The field is there, so the section rendered; only its own title is
    // gone.
    expect(await screen.findByLabelText('Preferred name')).toBeDefined();
    expect(screen.queryByText('Patient Details')).toBeNull();
  });

  it('omits the version line on the placements that are not the first on the page', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        fieldSets={['calendar']}
        showVersion={false}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => ok(payloadFor({ template: ALL_SECTIONS, permissions: ALL_WRITABLE }))}
      />,
    );

    expect(await screen.findByText('Patient Appointments')).toBeDefined();
    expect(screen.queryByText(STRINGS.versionLabel)).toBeNull();
  });

  // The 409 this exists to prevent: two placements of one record each hold
  // a `currentVersion`, and the first save moves the record past the
  // second one's copy. Without the listener the second save is refused by a
  // concurrency check meant for two people, not two halves of one page.
  it('re-reads when another placement on the page saves', async () => {
    const fetchForm = vi
      .fn()
      .mockReturnValueOnce(
        ok(payloadFor({ template: ALL_SECTIONS, permissions: ALL_WRITABLE, currentVersion: 1 })),
      )
      .mockReturnValue(
        ok(payloadFor({ template: ALL_SECTIONS, permissions: ALL_WRITABLE, currentVersion: 2 })),
      );

    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        fieldSets={['general']}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={fetchForm}
      />,
    );

    expect(await screen.findByText('Version: 1')).toBeDefined();

    window.dispatchEvent(new Event(ASSESSMENT_SAVED_EVENT));

    expect(await screen.findByText('Version: 2')).toBeDefined();
  });
});

// 2026-09-07 — the owner's Patient Details form puts an "Age: ___ yrs" box
// beside the date of birth and a "BMI: ___ kg/m²" box beside the height and
// weight. `AssessmentForm.test.ts` pins the arithmetic; this pins that the
// component actually wires it up — that the two boxes are text showing a
// computed number and not inputs someone can type a second answer into.
describe('the general section’s derived pair', () => {
  const DETAILS_SECTION = {
    fieldSet: 'general',
    title: 'Patient Details',
    fields: [
      { id: 'dateOfBirth', label: 'Date of birth', type: 'date' },
      { id: 'age', label: 'Age (years)', type: 'number', derived: true },
      { id: 'heightCm', label: 'Height (cm)', type: 'number' },
      { id: 'weightKg', label: 'Weight (kg)', type: 'number' },
      { id: 'bmi', label: 'BMI (kg/m²)', type: 'number', derived: true },
    ],
  };

  const WRITABLE_GENERAL = [
    { fieldSet: 'general', read: true, write: true },
    { fieldSet: 'prescription', read: false, write: false },
    { fieldSet: 'private', read: false, write: false },
    { fieldSet: 'calendar', read: false, write: false },
  ];

  /**
   * A date of birth that is exactly 40 years old on every day of the year:
   * 1 January has always already come round, whatever today is. That keeps
   * the assertion honest against the component's real clock without
   * installing fake timers — which, once installed, leave
   * `@testing-library`'s polling unable to advance and hang every test
   * after this one.
   */
  function fortyYearsOld(): string {
    return `${new Date().getUTCFullYear() - 40}-01-01`;
  }

  function renderDetails(dateOfBirth = '1990-05-14') {
    return render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [DETAILS_SECTION],
              permissions: WRITABLE_GENERAL,
              items: [
                {
                  version: 1,
                  updated_at: '2026-09-01T09:00:00.000Z',
                  general: {
                    responses: { dateOfBirth, heightCm: 170, weightKg: 70 },
                    attachments: [],
                  },
                },
              ],
            }),
          )
        }
      />,
    );
  }

  it('shows the age computed from the date of birth, as text', async () => {
    renderDetails(fortyYearsOld());
    await screen.findByText('Patient Details');
    expect(screen.getByText('40')).toBeDefined();
    // Never an input: a typed age is a second answer to a question the
    // date of birth already answers, and the API refuses to store one.
    expect(screen.queryByLabelText('Age (years)')).toBeNull();
    // The answer it is computed from is still editable.
    expect(screen.getByLabelText('Date of birth')).toBeDefined();
  });

  it('shows the BMI computed from the height and weight, as text', async () => {
    renderDetails();
    await screen.findByText('Patient Details');
    // 70 / 1.7² = 24.2214…
    expect(screen.getByText('24.2')).toBeDefined();
    expect(screen.queryByLabelText('BMI (kg/m²)')).toBeNull();
  });

  it('moves the BMI as a new weight is typed, before anything is saved', async () => {
    // The whole reason this arithmetic is the form's rather than the
    // server's: the corrected weight exists only here until someone saves.
    renderDetails();
    await screen.findByText('Patient Details');
    fireEvent.change(screen.getByLabelText('Weight (kg)'), { target: { value: '80' } });
    await waitFor(() => {
      expect(screen.getByText('27.7')).toBeDefined();
    });
  });
});

// 2026-09-07, second amendment. `AssessmentForm.test.ts` pins `groupsOf`
// and `rowsOf`; this pins what a clinician actually meets — a heading per
// numbered section of the paper form, and a grid they can add a row to and
// take one away from without saving in between.
describe('groups and grids', () => {
  const MEDICATIONS = {
    id: 'medications',
    label: 'Medications',
    type: 'rows',
    group: '7. Medication review',
    columns: [
      { id: 'drug', label: 'Drug (generic)', type: 'text' },
      { id: 'dose', label: 'Dose', type: 'text' },
      { id: 'route', label: 'Route', type: 'select', options: ['PO', 'IV'] },
      { id: 'taughtAndChecked', label: 'Checked', type: 'checkbox' },
    ],
  };
  const ASSESSMENT_SECTION = {
    fieldSet: 'private',
    title: 'Patient Assessment Form',
    fields: [
      {
        id: 'clinicianImpression',
        label: 'Clinical impression',
        type: 'textarea',
        group: '35. Clinical impression',
      },
      MEDICATIONS,
    ],
  };
  const PERMISSIONS = (write: boolean) => [
    { fieldSet: 'general', read: false, write: false },
    { fieldSet: 'prescription', read: false, write: false },
    { fieldSet: 'private', read: true, write },
    { fieldSet: 'calendar', read: false, write: false },
  ];

  function renderAssessment(options: { write?: boolean; rows?: unknown[] } = {}) {
    const rows = options.rows;
    return render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [ASSESSMENT_SECTION],
              permissions: PERMISSIONS(options.write ?? true),
              items:
                rows === undefined
                  ? []
                  : [
                      {
                        version: 1,
                        updated_at: '2026-09-07T09:00:00.000Z',
                        private: { responses: { medications: rows }, attachments: [] },
                      },
                    ],
            }),
          )
        }
      />,
    );
  }

  it('writes a heading for each numbered section of the paper form', async () => {
    renderAssessment();
    // Under the section's own title, not beside it: the form is 44 of these
    // and a flat run of controls under one title is not a form.
    expect(await screen.findByRole('heading', { name: '35. Clinical impression' })).toBeDefined();
    expect(screen.getByRole('heading', { name: '7. Medication review' })).toBeDefined();
  });

  // 2026-09-08: a group heading nests under the section title when there
  // *is* one, and takes the section's own level when the page wrote the
  // title itself. Both pages that mount this component pass
  // `showTitles={false}`, so the second case is the one they actually
  // render — and getting it wrong put an <h4> directly under the page's
  // <h2>, which axe reports as a skipped heading level. Asserted at the
  // level rather than by name because the level is the whole point.
  it('nests a group heading under the section title', async () => {
    renderAssessment();
    expect(
      await screen.findByRole('heading', { name: '35. Clinical impression', level: 3 }),
    ).toBeDefined();
  });

  it('takes the section level for a group heading when the page wrote the title', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        headingLevel={3}
        showTitles={false}
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [ASSESSMENT_SECTION],
              permissions: PERMISSIONS(true),
              items: [],
            }),
          )
        }
      />,
    );
    expect(
      await screen.findByRole('heading', { name: '35. Clinical impression', level: 3 }),
    ).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Patient Assessment Form' })).toBeNull();
  });

  it('renders a grid as a table with a column per declared column', async () => {
    renderAssessment({ rows: [{ drug: 'Gabapentin', dose: '300 mg' }] });
    await screen.findByRole('table');
    for (const header of ['Drug (generic)', 'Dose', 'Route', 'Checked']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeDefined();
    }
    expect(screen.getByDisplayValue('Gabapentin')).toBeDefined();
    expect(screen.getByDisplayValue('300 mg')).toBeDefined();
  });

  it('names every cell by its column and its row number', async () => {
    // A `<th>` names a column; it does not name an input in the body of
    // that column. Without this a four-row table is four boxes all called
    // "Dose" as far as a screen reader is concerned.
    renderAssessment({ rows: [{ drug: 'Gabapentin' }, { drug: 'Amitriptyline' }] });
    await screen.findByRole('table');
    expect(screen.getByLabelText('Medications — Drug (generic), row 1')).toBeDefined();
    expect(screen.getByLabelText('Medications — Drug (generic), row 2')).toBeDefined();
  });

  it('adds a row, and the new row is editable straight away', async () => {
    renderAssessment({ rows: [] });
    const add = await screen.findByRole('button', { name: 'Add a row to Medications' });
    fireEvent.click(add);
    await waitFor(() => {
      expect(screen.getByLabelText('Medications — Drug (generic), row 1')).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText('Medications — Drug (generic), row 1'), {
      target: { value: 'Gabapentin' },
    });
    expect(screen.getByDisplayValue('Gabapentin')).toBeDefined();
  });

  it('removes the row it was asked to remove, not the last one', async () => {
    // The row key is the array index, which is honest only because rows are
    // appended and removed and never reordered — this is the assertion that
    // says so.
    renderAssessment({ rows: [{ drug: 'Gabapentin' }, { drug: 'Amitriptyline' }] });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 1 from Medications' }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue('Gabapentin')).toBeNull();
    });
    expect(screen.getByDisplayValue('Amitriptyline')).toBeDefined();
  });

  it('renders a grid as a plain table, with no inputs, for a reader who may not edit', async () => {
    renderAssessment({ write: false, rows: [{ drug: 'Gabapentin', dose: '300 mg' }] });
    await screen.findByRole('table');
    expect(screen.getByText('Gabapentin')).toBeDefined();
    expect(screen.queryByLabelText('Medications — Drug (generic), row 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a row to Medications' })).toBeNull();
  });

  it('renders an empty grid without a table rather than an empty one', async () => {
    renderAssessment({ write: false, rows: [] });
    await screen.findByText('Medications');
    expect(screen.queryByRole('table')).toBeNull();
  });
});

// 2026-09-07: the resync no longer throws away what you were typing.
//
// `ASSESSMENT_SAVED_EVENT` exists because a page can mount this form more
// than once and each placement holds its own `currentVersion`. The listener
// re-read — and `load` cleared *every* draft on the way through, so a
// sibling placement saving its own section wiped this one's in-progress
// typing. Latent while saves were clicks; guaranteed every thirty seconds
// once `AUTOSAVE_INTERVAL_MS` existed, which is what surfaced it.
describe('a resync from another placement', () => {
  const SECTION = {
    fieldSet: 'general',
    title: 'Patient Details',
    fields: [{ id: 'preferredName', label: 'Preferred name', type: 'text' }],
  };

  function renderForm(fetchForm: () => Promise<Response>) {
    return render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={fetchForm}
      />,
    );
  }

  it('keeps unsaved typing, and takes the newer version', async () => {
    let currentVersion = 3;
    renderForm(() =>
      ok(
        payloadFor({
          currentVersion,
          template: [SECTION],
          permissions: [
            { fieldSet: 'general', read: true, write: true },
            { fieldSet: 'prescription', read: false, write: false },
            { fieldSet: 'private', read: false, write: false },
            { fieldSet: 'calendar', read: false, write: false },
          ],
        }),
      ),
    );
    await screen.findByText('Patient Details');
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: 'Sammy' } });

    // The sibling placement saves its own section and announces it.
    currentVersion = 4;
    fireEvent(window, new Event(ASSESSMENT_SAVED_EVENT));

    // The version moved — which is the whole reason for the event — and
    // the half-typed name is still there.
    await waitFor(() => {
      expect(screen.getByText(/4/)).toBeDefined();
    });
    expect(screen.getByDisplayValue('Sammy')).toBeDefined();
  });

  it('does not blank the form to a loading message while it re-reads', async () => {
    // Thirty seconds is not long enough to tolerate a flash of "Loading…"
    // — and the owner asked for this to work during a video call.
    renderForm(() =>
      ok(
        payloadFor({
          template: [SECTION],
          permissions: [
            { fieldSet: 'general', read: true, write: true },
            { fieldSet: 'prescription', read: false, write: false },
            { fieldSet: 'private', read: false, write: false },
            { fieldSet: 'calendar', read: false, write: false },
          ],
        }),
      ),
    );
    await screen.findByText('Patient Details');
    fireEvent(window, new Event(ASSESSMENT_SAVED_EVENT));
    expect(screen.queryByText(STRINGS.loadingLabel)).toBeNull();
    expect(screen.getByLabelText('Preferred name')).toBeDefined();
  });
});

// 2026-09-07: the owner, on autosave — *"but also have a save button just
// in case someone wants to click it before autosave hits."*
//
// The button had existed since the form did. What had changed is how far
// away it was: Patient Assessment Form is 597 controls under 44
// sub-headings, so one button after the last of them is a button you have
// to scroll past the whole form to reach — which is not a control you can
// use to pre-empt a thirty-second timer.
describe('save controls', () => {
  const SECTION = {
    fieldSet: 'general',
    title: 'Patient Details',
    fields: [
      { id: 'preferredName', label: 'Preferred name', type: 'text' },
      { id: 'email', label: 'Email', type: 'text' },
    ],
  };
  const PERMISSIONS = [
    { fieldSet: 'general', read: true, write: true },
    { fieldSet: 'prescription', read: false, write: false },
    { fieldSet: 'private', read: false, write: false },
    { fieldSet: 'calendar', read: false, write: false },
  ];

  function renderSection(extra: Record<string, unknown> = {}) {
    const saveSection = vi.fn(() => ok({ item: { version: 2 } }));
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() => ok(payloadFor({ template: [SECTION], permissions: PERMISSIONS }))}
        saveSection={saveSection as never}
        {...extra}
      />,
    );
    return saveSection;
  }

  it('puts one above the fields and one below them', async () => {
    renderSection();
    await screen.findByText('Patient Details');
    const buttons = screen.getAllByRole('button', { name: 'Save this section' });
    expect(buttons).toHaveLength(2);
    // DOM order, which is what decides whether the top one is reachable
    // without scrolling: heading, save, fields, save.
    const firstField = screen.getByLabelText('Preferred name');
    expect(buttons[0]!.compareDocumentPosition(firstField)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(buttons[1]!.compareDocumentPosition(firstField)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it('saves from the top control, not only the bottom one', async () => {
    const saveSection = renderSection();
    await screen.findByText('Patient Details');
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: 'Sam' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save this section' })[0]!);
    await waitFor(() => {
      expect(saveSection).toHaveBeenCalledTimes(1);
    });
  });

  it('offers neither to a reader who may not write the section', async () => {
    render(
      <AssessmentForm
        strings={STRINGS}
        patientId="pat-1"
        client={client(UNKNOWN_POOL_TOKEN)}
        fetchForm={() =>
          ok(
            payloadFor({
              template: [SECTION],
              permissions: [
                { fieldSet: 'general', read: true, write: false },
                { fieldSet: 'prescription', read: false, write: false },
                { fieldSet: 'private', read: false, write: false },
                { fieldSet: 'calendar', read: false, write: false },
              ],
            }),
          )
        }
      />,
    );
    await screen.findByText('Patient Details');
    expect(screen.queryAllByRole('button', { name: 'Save this section' })).toHaveLength(0);
  });
});
