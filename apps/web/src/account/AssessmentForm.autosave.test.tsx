// @vitest-environment jsdom
//
// 2026-09-07. The owner: *"while editing Patient Assessment Form, make it
// auto saved every 30 seconds, both while filling it normally as well as
// filling it during Video Call."*
//
// **Its own file, and that is not tidiness.** These tests need
// `vi.useFakeTimers()`, and installing fake timers leaves
// `@testing-library`'s `waitFor`/`findBy*` polling unable to advance — so
// every test after them in the same file hangs. (Learned the hard way in
// `AssessmentForm.render.test.tsx`, where a single fake-timer test took its
// two neighbours down with it.) Vitest gives each file its own environment,
// so the isolation is the file boundary. Nothing here uses an async RTL
// query: `act` flushes the microtasks instead.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssessmentForm, AUTOSAVE_INTERVAL_MS } from './AssessmentForm.js';
import type { AssessmentFormStrings } from './AssessmentForm.js';

const STRINGS: AssessmentFormStrings = {
  heading: 'Assessment form',
  loadingLabel: 'Loading…',
  forbiddenLabel: 'No access.',
  notFoundLabel: 'Not found.',
  errorLabel: 'Something went wrong.',
  missingIdLabel: 'Choose a patient.',
  saveLabel: 'Save this section',
  savingLabel: 'Saving…',
  savedLabel: 'Saved.',
  autosavedLabel: 'Saved automatically.',
  conflictLabel: 'Someone else changed this form.',
  saveForbiddenLabel: 'You may not change this section.',
  readOnlyLabel: 'Read only.',
  attachmentsHeading: 'Files',
  attachmentsEmpty: 'No files.',
  addFileLabel: 'Add a file',
  uploadingLabel: 'Uploading…',
  uploadFailedLabel: 'Upload failed.',
  downloadLabel: 'Open',
  addRowLabel: 'Add a row',
  removeRowLabel: 'Remove this row',
  addRowAriaTemplate: 'Add a row to {field}',
  removeRowAriaTemplate: 'Remove row {row} from {field}',
  cellLabelTemplate: '{field} — {column}, row {row}',
  noNextAppointmentLabel: 'No appointment booked.',
  versionLabel: 'Version:',
};

const ASSESSMENT_SECTION = {
  fieldSet: 'private',
  title: 'Patient Assessment Form',
  fields: [
    { id: 'clinicianImpression', label: 'Clinical impression', type: 'textarea' },
    { id: 'workingDiagnosis', label: 'Working diagnosis', type: 'textarea' },
  ],
};
const DETAILS_SECTION = {
  fieldSet: 'general',
  title: 'Patient Details',
  fields: [{ id: 'preferredName', label: 'Preferred name', type: 'text' }],
};

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

function payload(options: { readonly writable?: readonly string[] } = {}) {
  const writable = options.writable ?? ['private', 'general'];
  return {
    currentVersion: 3,
    template: [DETAILS_SECTION, ASSESSMENT_SECTION],
    permissions: [
      { fieldSet: 'general', read: true, write: writable.includes('general') },
      { fieldSet: 'prescription', read: false, write: false },
      { fieldSet: 'private', read: true, write: writable.includes('private') },
      { fieldSet: 'calendar', read: false, write: false },
    ],
    items: [],
  };
}

/** A token this bundle cannot place in a pool — "cannot tell", which leaves every field editable and lets the server decide. */
const TOKEN = `header.${Buffer.from('{}').toString('base64url')}.signature`;
const client = { authorization: () => Promise.resolve(TOKEN) } as never;

type Saved = { baseVersion: number; sections: Record<string, { responses: unknown }> };

function mount(options: { readonly writable?: readonly string[] } = {}) {
  const saveSection = vi.fn((_token: string, _id: string, body: unknown) =>
    ok({ item: { version: 4 } }).then((response) => {
      void (body as Saved);
      return response;
    }),
  );
  const view = render(
    <AssessmentForm
      strings={STRINGS}
      patientId="pat-1"
      client={client}
      fetchForm={() => ok(payload(options))}
      saveSection={saveSection as never}
    />,
  );
  return { saveSection, view };
}

/** Let the pending `fetchForm`/`saveSection` promises settle without an RTL poll. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    });
    await settle();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the interval', () => {
  it('is the thirty seconds the owner asked for', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBe(30_000);
  });

  it('saves a section that has unsaved edits when the interval elapses', async () => {
    const { saveSection } = mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Clinical impression'), {
      target: { value: 'Radicular presentation.' },
    });
    expect(saveSection).not.toHaveBeenCalled();
    await tick();
    expect(saveSection).toHaveBeenCalledTimes(1);
    const body = saveSection.mock.calls[0]?.[2] as Saved;
    expect(body.sections.private?.responses).toEqual({
      clinicianImpression: 'Radicular presentation.',
    });
  });

  it('says so, in words distinct from the button’s', async () => {
    // A clinician who cannot tell the form is saving itself will keep
    // reaching for the button, which defeats the point of the feature.
    mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Clinical impression'), { target: { value: 'x' } });
    await tick();
    expect(screen.getByText('Saved automatically.')).toBeDefined();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('sends only the fields that were touched', async () => {
    // The property that lets two clinicians work in one record: an
    // autosave cannot overwrite a field this person never looked at.
    const { saveSection } = mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Working diagnosis'), { target: { value: 'L5 radic.' } });
    await tick();
    const body = saveSection.mock.calls[0]?.[2] as Saved;
    expect(body.sections.private?.responses).toEqual({ workingDiagnosis: 'L5 radic.' });
  });

  it('does nothing at all when nothing has been edited', async () => {
    const { saveSection } = mount();
    await settle();
    await tick(3);
    expect(saveSection).not.toHaveBeenCalled();
  });

  it('does not save again once the edits are saved', async () => {
    const { saveSection } = mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Clinical impression'), { target: { value: 'x' } });
    await tick();
    expect(saveSection).toHaveBeenCalledTimes(1);
    // The drafts for that section are spent; the next two ticks have
    // nothing to write and must not write an empty patch.
    await tick(2);
    expect(saveSection).toHaveBeenCalledTimes(1);
  });

  it('picks up an edit made after the timer was already running', async () => {
    // The latest-callback ref. An effect with `[]` that closed over the
    // first render's drafts would spend the whole session saving whatever
    // was on screen thirty seconds after mount — which is to say nothing.
    const { saveSection } = mount();
    await settle();
    await tick(2);
    expect(saveSection).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Clinical impression'), { target: { value: 'later' } });
    await tick();
    const body = saveSection.mock.calls[0]?.[2] as Saved;
    expect(body.sections.private?.responses).toEqual({ clinicianImpression: 'later' });
  });

  it('covers every section on the placement, not only the assessment form', async () => {
    // The instruction named Patient Assessment Form, and it is the section
    // a clinician spends a consultation in — but the same screen shows
    // Patient Details above it, and a form whose lower half saves itself
    // while the upper half silently does not is a lost edit waiting to be
    // filed as a bug.
    const { saveSection } = mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: 'Sam' } });
    await tick();
    expect(saveSection).toHaveBeenCalledTimes(1);
    const body = saveSection.mock.calls[0]?.[2] as Saved;
    expect(body.sections.general?.responses).toEqual({ preferredName: 'Sam' });
  });

  it('never autosaves a section the server said is read-only', async () => {
    // The server is the boundary and would refuse it anyway; the point is
    // that a read-only section produces no request at all, so a reader
    // sitting on the page generates no traffic and no 403s.
    const { saveSection } = mount({ writable: ['general'] });
    await settle();
    expect(screen.queryByLabelText('Clinical impression')).toBeNull();
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: 'Sam' } });
    await tick();
    expect(saveSection).toHaveBeenCalledTimes(1);
    expect((saveSection.mock.calls[0]?.[2] as Saved).sections.private).toBeUndefined();
  });

  it('stops when the form is unmounted', async () => {
    // An interval left behind by a closed call screen would keep writing
    // to a record nobody is looking at any more.
    const { saveSection, view } = mount();
    await settle();
    fireEvent.change(screen.getByLabelText('Clinical impression'), { target: { value: 'x' } });
    view.unmount();
    await tick(2);
    expect(saveSection).not.toHaveBeenCalled();
  });
});
