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
  conflictLabel: 'Someone else changed this form.',
  saveForbiddenLabel: 'You do not have permission to change this section.',
  readOnlyLabel: 'You can read this section but not change it.',
  attachmentsHeading: 'Files',
  attachmentsEmpty: 'No files have been added to this section.',
  addFileLabel: 'Add a file',
  uploadingLabel: 'Uploading…',
  uploadFailedLabel: 'That file could not be uploaded.',
  downloadLabel: 'Open',
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
    expect(screen.getAllByRole('button', { name: 'Save this section' })).toHaveLength(1);
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
    expect(screen.getAllByRole('button', { name: 'Save this section' })).toHaveLength(4);
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

describe('attachments', () => {
  it('lists a section\'s files with a way to open each', async () => {
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
    render(
      <AssessmentForm strings={STRINGS} patientId="" client={client(UNKNOWN_POOL_TOKEN)} />,
    );
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
    fireEvent.click(screen.getByRole('button', { name: 'Save this section' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Save this section' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Save this section' }));

    await screen.findByText(STRINGS.conflictLabel);
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
    fireEvent.click(screen.getByRole('button', { name: 'Save this section' }));

    expect(await screen.findByText(STRINGS.saveForbiddenLabel)).toBeDefined();
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
