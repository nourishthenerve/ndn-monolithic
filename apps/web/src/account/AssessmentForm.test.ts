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
  ageFromDateOfBirth,
  groupsOf,
  rowsOf,
  bmiFromHeightAndWeight,
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
    expect(fieldValue('prescription', CONSENT_FIELD, {}, latest, undefined)).toBe(false);
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
    // keeps a prescription-section edit out of a general-section save.
    expect(responsesToSave(section, { [draftKey('prescription', 'preferredName')]: 'x' })).toEqual({});
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
      prescription: { responses: { goals: 'walk unaided' }, attachments: [] },
    };
    expect(sectionOf(latest, 'prescription').responses.goals).toBe('walk unaided');
  });
});

// 2026-09-07 — the owner's Patient Details form prints an "Age: ___ yrs"
// box and a "BMI: ___ kg/m²" box beside the answers they are computed
// from. Both are `derived` on the template, so neither is typed and
// neither is saved; the arithmetic is the form's because the inputs are
// answers this client is already holding. See `fieldValue`'s doc for why
// that is the opposite choice from the calendar's figures.

describe('ageFromDateOfBirth', () => {
  // Every case is measured against one fixed "today" so the assertions do
  // not go stale on a real calendar.
  const today = new Date('2026-09-07T00:00:00.000Z');

  it('counts whole years when the birthday has already come round', () => {
    expect(ageFromDateOfBirth('1990-05-14', today)).toBe(36);
  });

  it('does not count the year whose birthday has not arrived yet', () => {
    expect(ageFromDateOfBirth('1990-11-14', today)).toBe(35);
  });

  it('counts the year on the birthday itself, not the day after', () => {
    expect(ageFromDateOfBirth('1990-09-07', today)).toBe(36);
  });

  it('still withholds the year the day before the birthday', () => {
    expect(ageFromDateOfBirth('1990-09-08', today)).toBe(35);
  });

  it('is blank when there is no date of birth to compute from', () => {
    // The state every record is in the moment it is created — an empty age
    // box, not a `NaN` next to the empty date.
    expect(ageFromDateOfBirth('', today)).toBe('');
  });

  it('is blank for a date it cannot parse', () => {
    expect(ageFromDateOfBirth('14/05/1990', today)).toBe('');
    expect(ageFromDateOfBirth('sometime in the nineties', today)).toBe('');
  });

  it('is blank rather than negative for a date of birth in the future', () => {
    // A mistyped year, which is a blank box to go and fix — not a patient
    // aged minus four.
    expect(ageFromDateOfBirth('2030-01-01', today)).toBe('');
  });

  it('is blank for a value that is not a string at all', () => {
    // `AssessmentValue` also covers numbers and booleans, and a stored
    // answer from an older version is whatever it was written as.
    expect(ageFromDateOfBirth(0, today)).toBe('');
    expect(ageFromDateOfBirth(false, today)).toBe('');
  });

  it('reads a stored answer that carries a time as well as a date', () => {
    expect(ageFromDateOfBirth('1990-05-14T00:00:00.000Z', today)).toBe(36);
  });

  it('is the same age either side of midnight local time, because both sides are read in UTC', () => {
    // The bug this guards is a viewer west of Greenwich reading an age a
    // day early on the morning of a birthday.
    expect(ageFromDateOfBirth('1990-09-07', new Date('2026-09-07T23:59:00.000Z'))).toBe(36);
    expect(ageFromDateOfBirth('1990-09-07', new Date('2026-09-07T00:01:00.000Z'))).toBe(36);
  });
});

describe('bmiFromHeightAndWeight', () => {
  it('is kg over metres squared', () => {
    expect(bmiFromHeightAndWeight(180, 81)).toBe(25);
  });

  it('rounds to one decimal place, the precision a BMI is quoted to', () => {
    // 70 / 1.7² = 24.2214…
    expect(bmiFromHeightAndWeight(170, 70)).toBe(24.2);
  });

  it('reads numbers that arrived as strings', () => {
    // A number input's value is a string, so a draft holds one.
    expect(bmiFromHeightAndWeight('170', '70')).toBe(24.2);
  });

  it('is blank until both boxes are answered', () => {
    // The guard against `Infinity`: `Number('')` is `0`, and a height of
    // zero would otherwise divide.
    expect(bmiFromHeightAndWeight('', 70)).toBe('');
    expect(bmiFromHeightAndWeight(170, '')).toBe('');
    expect(bmiFromHeightAndWeight('', '')).toBe('');
  });

  it('is blank for a height or weight that is not a positive number', () => {
    expect(bmiFromHeightAndWeight(0, 70)).toBe('');
    expect(bmiFromHeightAndWeight(-170, 70)).toBe('');
    expect(bmiFromHeightAndWeight(170, 0)).toBe('');
    expect(bmiFromHeightAndWeight('tall', 70)).toBe('');
  });
});

describe('fieldValue computes the general section’s derived pair', () => {
  const AGE_FIELD: AssessmentFieldDef = {
    id: 'age',
    label: 'Age (years)',
    type: 'number',
    derived: true,
  };
  const BMI_FIELD: AssessmentFieldDef = {
    id: 'bmi',
    label: 'BMI (kg/m²)',
    type: 'number',
    derived: true,
  };
  const today = new Date('2026-09-07T00:00:00.000Z');
  const stored: VersionItem = {
    version: 2,
    updated_at: '2026-09-01T09:00:00.000Z',
    general: {
      responses: { dateOfBirth: '1990-05-14', heightCm: 170, weightKg: 70 },
      attachments: [],
    },
  };

  it('reads age from the stored date of birth, never from a stored age', () => {
    expect(fieldValue('general', AGE_FIELD, {}, stored, undefined, today)).toBe(36);
  });

  it('reads BMI from the stored height and weight', () => {
    expect(fieldValue('general', BMI_FIELD, {}, stored, undefined, today)).toBe(24.2);
  });

  it('follows a date of birth that is still being typed, before any save', () => {
    // The reason this arithmetic is here and not on the server: the
    // corrected answer exists only in this client until someone saves.
    expect(
      fieldValue(
        'general',
        AGE_FIELD,
        { [draftKey('general', 'dateOfBirth')]: '2000-01-01' },
        stored,
        undefined,
        today,
      ),
    ).toBe(26);
  });

  it('follows a weight that is still being typed', () => {
    expect(
      fieldValue(
        'general',
        BMI_FIELD,
        { [draftKey('general', 'weightKg')]: '80' },
        stored,
        undefined,
        today,
      ),
    ).toBe(27.7);
  });

  it('is blank on a record nobody has filled in yet', () => {
    expect(fieldValue('general', AGE_FIELD, {}, undefined, undefined, today)).toBe('');
    expect(fieldValue('general', BMI_FIELD, {}, undefined, undefined, today)).toBe('');
  });

  it('ignores a stored answer under the derived id itself', () => {
    // A version written before these two became derived — or by any client
    // that sent one — must not be able to put a stale age on the screen.
    const withStaleAge: VersionItem = {
      version: 1,
      updated_at: '2020-01-01T00:00:00.000Z',
      general: { responses: { dateOfBirth: '1990-05-14', age: 29, bmi: 99 }, attachments: [] },
    };
    expect(fieldValue('general', AGE_FIELD, {}, withStaleAge, undefined, today)).toBe(36);
    expect(fieldValue('general', BMI_FIELD, {}, withStaleAge, undefined, today)).toBe('');
  });

  it('leaves the calendar’s derived figures to the server’s summary', () => {
    // The two kinds must not cross: a calendar figure has no inputs in this
    // client to compute from.
    const summary: CalendarSummary = {
      sessionsCompleted: 4,
      appointmentsAwaitingApproval: 1,
    };
    expect(fieldValue('calendar', SESSIONS_FIELD, {}, stored, summary, today)).toBe(4);
  });

  it('is never editable and is never sent to a save', () => {
    const writable: SectionPermission = { fieldSet: 'general', read: true, write: true };
    expect(isFieldEditable(AGE_FIELD, writable, false)).toBe(false);
    expect(isFieldEditable(BMI_FIELD, writable, false)).toBe(false);
    const section: AssessmentSectionDef = {
      fieldSet: 'general',
      title: 'Patient Details',
      fields: [AGE_FIELD, BMI_FIELD, NAME_FIELD],
    };
    expect(
      responsesToSave(section, {
        [draftKey('general', 'age')]: 41,
        [draftKey('general', 'bmi')]: 22,
        [draftKey('general', 'preferredName')]: 'Sam',
      }),
    ).toEqual({ preferredName: 'Sam' });
  });
});

// 2026-09-07, second amendment: the owner's assessment form is 44 numbered
// headings and about a third grids, so the template grew a `group` string
// and a `rows` field type. Both are rendering concerns and neither is
// authorisation, which is why they are pinned here rather than in
// `assessment.test.ts` — the server neither reads a group nor cares which
// order two runs come in.

describe('groupsOf', () => {
  const field = (id: string, group?: string): AssessmentFieldDef => ({
    id,
    label: id,
    type: 'text',
    ...(group === undefined ? {} : { group }),
  });

  it('is one unnamed run when nothing names a group', () => {
    // Patient Details, Prescription and Appointments are all like this, and
    // must render exactly as they did before groups existed.
    const fields = [field('a'), field('b'), field('c')];
    expect(groupsOf(fields)).toEqual([['', fields]]);
  });

  it('cuts the list into runs of a shared group, in declaration order', () => {
    const [a, b, c, d] = [
      field('a', '2. Referral'),
      field('b', '2. Referral'),
      field('c', '3. Presenting complaint'),
      field('d', '3. Presenting complaint'),
    ];
    expect(groupsOf([a, b, c, d])).toEqual([
      ['2. Referral', [a, b]],
      ['3. Presenting complaint', [c, d]],
    ]);
  });

  it('emits a second run rather than reordering an interleaved group', () => {
    // The template's order is the paper form's order. If a group ever did
    // appear twice, two headings is the honest rendering — silently moving
    // a clinical field to sit under an earlier heading is not.
    // `assessment-template.test.ts` asserts the shipped template never
    // does this, so the two files together mean it cannot happen by
    // accident.
    const [a, b, c] = [field('a', 'X'), field('b', 'Y'), field('c', 'X')];
    expect(groupsOf([a, b, c]).map(([group]) => group)).toEqual(['X', 'Y', 'X']);
  });

  it('is empty for no fields', () => {
    expect(groupsOf([])).toEqual([]);
  });
});

describe('rowsOf', () => {
  it('passes a row array through', () => {
    const rows = [{ drug: 'Gabapentin' }, { drug: 'Amitriptyline' }];
    expect(rowsOf(rows)).toEqual(rows);
  });

  it('is no rows for a scalar stored under an id that later became a grid', () => {
    // A record is history and a template is the current form, so this is a
    // real state: the answer stays stored, and the grid renders empty
    // rather than crashing on `''.map`.
    expect(rowsOf('Gabapentin 300mg TDS')).toEqual([]);
    expect(rowsOf(0)).toEqual([]);
    expect(rowsOf(false)).toEqual([]);
    expect(rowsOf('')).toEqual([]);
  });
});

describe('fieldValue blanks a grid as no rows', () => {
  const GRID_FIELD: AssessmentFieldDef = {
    id: 'medications',
    label: 'Medications',
    type: 'rows',
    columns: [
      { id: 'drug', label: 'Drug', type: 'text' },
      { id: 'dose', label: 'Dose', type: 'text' },
    ],
  };

  it('is an empty array on a record nobody has filled in', () => {
    // The `''` every other blank uses would be a crash the first time the
    // table tried to map it.
    expect(fieldValue('private', GRID_FIELD, {}, undefined, undefined)).toEqual([]);
  });

  it('reads the stored rows when there are some', () => {
    const latest: VersionItem = {
      version: 1,
      updated_at: '2026-09-07T09:00:00.000Z',
      private: { responses: { medications: [{ drug: 'Gabapentin' }] }, attachments: [] },
    };
    expect(fieldValue('private', GRID_FIELD, {}, latest, undefined)).toEqual([
      { drug: 'Gabapentin' },
    ]);
  });

  it('prefers a touched draft, as for any other field', () => {
    const drafts = { [draftKey('private', 'medications')]: [{ drug: 'Amitriptyline' }] };
    expect(fieldValue('private', GRID_FIELD, drafts, undefined, undefined)).toEqual([
      { drug: 'Amitriptyline' },
    ]);
  });

  it('sends a touched grid to the save like any other answer', () => {
    const section: AssessmentSectionDef = {
      fieldSet: 'private',
      title: 'Patient Assessment Form',
      fields: [GRID_FIELD],
    };
    const rows = [{ drug: 'Gabapentin', dose: '300 mg' }];
    expect(
      responsesToSave(section, { [draftKey('private', 'medications')]: rows }),
    ).toEqual({ medications: rows });
  });
});
