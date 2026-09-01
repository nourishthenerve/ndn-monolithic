// 2026-09-01. Deliberately does not render the component — this directory
// has no jsdom/RTL pattern (join-window.test.ts's own precedent, followed
// by NextAppointmentPanel.test.ts and ClinicianCalendar.test.ts) — so the
// pure functions every rendering decision on the form goes through are
// tested directly instead.
//
// What is worth pinning here is the *editability* rule. The server is the
// boundary and always refuses what it should, but a UI that offers an
// editor the save will refuse is the exact complaint that produced
// `token-claims.ts` in the first place ("it says at the very end that you
// dont have permission"). These assertions are what keep the four sections
// rendering the way `authz-matrix.ts` says they should.
import { describe, expect, it } from 'vitest';

import {
  draftKey,
  fieldValue,
  isFieldEditable,
  responsesToSave,
  sectionOf,
} from './AssessmentForm.js';
import type {
  AssessmentFieldDef,
  AssessmentSectionDef,
  CalendarSummary,
  SectionPermission,
  VersionItem,
} from './AssessmentForm.js';

const TAG_FIELD: AssessmentFieldDef = {
  id: 'tag',
  label: 'Programme tag',
  type: 'select',
  options: ['IIC', 'NDN'],
  staffOnly: true,
};
const NAME_FIELD: AssessmentFieldDef = {
  id: 'preferredName',
  label: 'Preferred name',
  type: 'text',
};
const SESSIONS_FIELD: AssessmentFieldDef = {
  id: 'sessionsCompleted',
  label: 'Sessions so far',
  type: 'number',
  derived: true,
};
const CONSENT_FIELD: AssessmentFieldDef = {
  id: 'consentToRecordSessions',
  label: 'Happy for sessions to be recorded',
  type: 'checkbox',
};

const WRITABLE: SectionPermission = { fieldSet: 'general', read: true, write: true };
const READ_ONLY: SectionPermission = { fieldSet: 'general', read: true, write: false };

describe('isFieldEditable', () => {
  it('is false for a derived field, whoever is asking', () => {
    const calendarWrite: SectionPermission = { fieldSet: 'calendar', read: true, write: true };
    expect(isFieldEditable(SESSIONS_FIELD, calendarWrite, false)).toBe(false);
    expect(isFieldEditable(SESSIONS_FIELD, calendarWrite, true)).toBe(false);
  });

  it('is false when the server said the section is not writable', () => {
    expect(isFieldEditable(NAME_FIELD, READ_ONLY, false)).toBe(false);
  });

  it('is false when the server said nothing about the section at all', () => {
    // A section absent from `permissions` is one this caller cannot reach.
    // Treating "no answer" as permission would be exactly the wrong default.
    expect(isFieldEditable(NAME_FIELD, undefined, false)).toBe(false);
  });

  it('is true for an ordinary field in a writable section', () => {
    expect(isFieldEditable(NAME_FIELD, WRITABLE, false)).toBe(true);
    expect(isFieldEditable(NAME_FIELD, WRITABLE, true)).toBe(true);
  });

  // The one field-level rule the section's own permission cannot express:
  // a patient may edit their general info, and the tag inside it decides
  // which patients a visitor account can see.
  it('is false for the staff-only tag when the viewer is a patient', () => {
    expect(isFieldEditable(TAG_FIELD, WRITABLE, true)).toBe(false);
  });

  it('is true for the staff-only tag when the viewer is staff', () => {
    expect(isFieldEditable(TAG_FIELD, WRITABLE, false)).toBe(true);
  });
});

describe('fieldValue', () => {
  const latest: VersionItem = {
    version: 3,
    updated_at: '2026-09-01T09:00:00.000Z',
    general: { responses: { preferredName: 'Sam', tag: 'IIC' }, attachments: [] },
  };
  const summary: CalendarSummary = {
    nextAppointmentAt: '2026-09-05T10:00:00.000Z',
    sessionsCompleted: 4,
    appointmentsAwaitingApproval: 1,
  };

  it('prefers a touched draft over the stored answer', () => {
    expect(
      fieldValue('general', NAME_FIELD, { [draftKey('general', 'preferredName')]: 'Sammy' }, latest, undefined),
    ).toBe('Sammy');
  });

  it('falls back to the stored answer when nothing was touched', () => {
    expect(fieldValue('general', NAME_FIELD, {}, latest, undefined)).toBe('Sam');
  });

  it('reads a derived field from the calendar summary, never from a stored response', () => {
    expect(fieldValue('calendar', SESSIONS_FIELD, {}, latest, summary)).toBe(4);
  });

  it('is an empty string for a derived field with no summary — the caller cannot read the calendar', () => {
    expect(fieldValue('calendar', SESSIONS_FIELD, {}, latest, undefined)).toBe('');
  });

  it('blanks a checkbox as false, not as an empty string', () => {
    // `String(undefined)` in a `checked` prop is how a checkbox ends up
    // permanently ticked; this is the guard against that.
    expect(fieldValue('patient', CONSENT_FIELD, {}, latest, undefined)).toBe(false);
  });

  it('blanks every other field type as an empty string', () => {
    expect(fieldValue('general', NAME_FIELD, {}, undefined, undefined)).toBe('');
  });
});

describe('responsesToSave', () => {
  const section: AssessmentSectionDef = {
    fieldSet: 'general',
    title: 'General info',
    fields: [TAG_FIELD, NAME_FIELD],
  };
  const calendar: AssessmentSectionDef = {
    fieldSet: 'calendar',
    title: 'Calendar',
    fields: [SESSIONS_FIELD, { id: 'schedulingNotes', label: 'Notes', type: 'textarea' }],
  };

  it('sends only the fields that were touched', () => {
    expect(
      responsesToSave(section, { [draftKey('general', 'preferredName')]: 'Sammy' }),
    ).toEqual({ preferredName: 'Sammy' });
  });

  it('sends nothing when nothing was touched', () => {
    expect(responsesToSave(section, {})).toEqual({});
  });

  it('never sends a derived field, even if one somehow reached the drafts', () => {
    expect(
      responsesToSave(calendar, {
        [draftKey('calendar', 'sessionsCompleted')]: 99,
        [draftKey('calendar', 'schedulingNotes')]: 'mornings only',
      }),
    ).toEqual({ schedulingNotes: 'mornings only' });
  });

  it('ignores a draft belonging to a different section', () => {
    // Drafts are one flat map across the whole form; the key prefix is what
    // keeps a patient-section edit out of a general-section save.
    expect(responsesToSave(section, { [draftKey('patient', 'preferredName')]: 'x' })).toEqual({});
  });
});

describe('sectionOf', () => {
  it('is an empty section when the form has never been written', () => {
    expect(sectionOf(undefined, 'general')).toEqual({ responses: {}, attachments: [] });
  });

  it('is an empty section when the caller may not read that half — an absent key, not a redacted one', () => {
    const latest: VersionItem = { version: 1, updated_at: '2026-09-01T09:00:00.000Z' };
    expect(sectionOf(latest, 'private')).toEqual({ responses: {}, attachments: [] });
  });

  it('returns the stored section when there is one', () => {
    const latest: VersionItem = {
      version: 1,
      updated_at: '2026-09-01T09:00:00.000Z',
      patient: { responses: { goals: 'walk unaided' }, attachments: [] },
    };
    expect(sectionOf(latest, 'patient').responses.goals).toBe('walk unaided');
  });
});
