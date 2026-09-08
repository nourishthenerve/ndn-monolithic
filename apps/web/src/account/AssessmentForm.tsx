// 2026-09-01: the assessment form — four sections, four different sets of
// writers, one screen.
//
// **The server tells this component what it may show and edit; it never
// works it out.** The `GET` returns `template` (only the sections the
// caller may read) and `permissions` (`read`/`write` per section), and
// every rendering decision here reads those two. That is deliberate and it
// is the opposite of how the rest of this codebase's islands hide things:
// `RequireAuth`/`token-claims.ts` guess a role from an unverified claim to
// decide what to *offer*, which is fine for a nav link. It is not fine
// here, where the same page shows five roles five different subsets of one
// record — a guess that drifted from `authz-matrix.ts` would either hide a
// clinician's own notes from them or render an editor for a section the
// save is going to refuse. The server already computed the answer while
// authorising the read; this asks it rather than re-deriving it.
//
// The one thing read from the token is the viewer's role, and only to grey
// out the `staffOnly` tag field for a patient — a field-level rule the
// section's own `write` flag cannot express. Getting it wrong shows a
// patient an input whose save returns 403, which is the ordinary failure
// mode of every island in this codebase, not a disclosure.
//
// **Saving is per section**, and that follows from the API rather than
// being a layout preference: a section patch is the unit the server
// authorises, so a per-section button is the only arrangement where the
// thing a person is offered and the thing that succeeds or fails are the
// same thing. A single "save everything" button would send sections the
// caller cannot write and be refused whole (`assessment.ts` is atomic).
//
// ## 2026-09-07 — one component, still; several placements on a page
//
// The owner's rework makes each section a *named area of the patient
// record* — "Patient Details", "Patient Assessment Form", "Patient
// Prescription", "Patient Appointments" — and two of those areas carry
// non-assessment content as well (the identity form under Details, the
// calendar under Appointments). So a page now mounts this component once
// per area, passing `fieldSets` to say which of the record's sections
// belong in *this* area, and `showTitles={false}` when the page has
// already written the heading itself.
//
// `fieldSets` is a **placement filter, never a permission**. It can only
// narrow what the server already chose to send: a page asking for
// `['private']` on behalf of a patient renders nothing at all, because
// `template` came back without that section. Nothing here decides who sees
// what — that is still, entirely, the paragraph above.
//
// **Instances resync after any save**, via a `window` event rather than
// shared React state: Astro mounts each `client:only` island as its own
// React root, so there is no tree for a context to span. Without it, two
// areas on one page hold two copies of `currentVersion`, the first save
// bumps the record, and the second area's save is refused 409 by a
// concurrency check meant for two *people* editing at once — a conflict
// the person would have to resolve by re-reading a page they never left.
// The listener is the whole fix: one save, every mounted section re-reads.
import { Button, Heading } from '@ndn/ui';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { viewerRoleFromAccessToken } from '../auth/token-claims.js';
import { contentApiUrl } from '../site-config.js';

import type { PanelHeadingLevel } from './heading-level.js';
import { nestedHeadingLevel } from './heading-level.js';
import { PanelPlaceholder } from './PanelPlaceholder.js';

/** The form every patient's record is instantiated from. One template, one form per patient — `assessment-repository.ts`'s `DEFAULT_ASSESSMENT_ID`. */
export const ASSESSMENT_ID = 'intake-v1';

/**
 * Dispatched on `window` after any section of the record is written, so the
 * other placements of this form on the same page re-read rather than going
 * on holding a version the server has moved past. See this file's header.
 */
export const ASSESSMENT_SAVED_EVENT = 'ndn:assessment-saved';

/** The owner asked for thirty seconds. Exported so a test can assert the interval rather than wait one out. */
export const AUTOSAVE_INTERVAL_MS = 30_000;

// The response shapes, declared locally rather than imported from
// `@ndn/shared-types` — the same choice `PatientRecordPanel.tsx` and every
// other island here already makes, and `apps/web`'s dependency list is the
// enforcement: this bundle depends on `@ndn/i18n` and `@ndn/ui` and
// nothing server-side. What arrives here is *whatever the server chose to
// send this caller*, which is a narrower thing than the stored record —
// `general?`/`patient?`/`private?`/`calendar?` are optional here precisely
// because a section the caller may not read is absent, not empty.
export type AssessmentFieldSet = 'general' | 'private' | 'prescription' | 'calendar';

/** One box's answer. */
export type AssessmentRowValue = string | number | boolean;

/** One row of a `type: 'rows'` field, keyed by that field's column ids. */
export type AssessmentRow = Readonly<Record<string, AssessmentRowValue>>;

/** A scalar, or the rows of a grid — see `AssessmentValue` in @ndn/shared-types for why a field may hold rows at all. */
export type AssessmentValue = AssessmentRowValue | readonly AssessmentRow[];

export type AssessmentFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'date'
  | 'datetime'
  | 'number'
  | 'checkbox'
  | 'rows';

/** One column of a grid. Cannot itself be a grid, so a table never nests. */
export interface AssessmentColumnDef {
  readonly id: string;
  readonly label: string;
  readonly type: Exclude<AssessmentFieldType, 'rows' | 'textarea'>;
  readonly options?: readonly string[];
}

export interface AssessmentFieldDef {
  readonly id: string;
  readonly label: string;
  readonly type: AssessmentFieldType;
  readonly options?: readonly string[];
  readonly columns?: readonly AssessmentColumnDef[];
  /** A sub-heading, rendered once above the run of fields that name it. Presentation only — the server neither reads nor enforces it. */
  readonly group?: string;
  readonly staffOnly?: boolean;
  readonly derived?: boolean;
}

export interface AssessmentSectionDef {
  readonly fieldSet: AssessmentFieldSet;
  readonly title: string;
  readonly fields: readonly AssessmentFieldDef[];
}

interface Attachment {
  readonly key: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly uploadedAt: string;
}

export interface SectionData {
  readonly responses: Readonly<Record<string, AssessmentValue>>;
  readonly attachments: readonly Attachment[];
}

export type VersionItem = {
  readonly version: number;
  readonly updated_at: string;
} & Partial<Readonly<Record<AssessmentFieldSet, SectionData>>>;

export interface SectionPermission {
  readonly fieldSet: AssessmentFieldSet;
  readonly read: boolean;
  readonly write: boolean;
}

export interface CalendarSummary {
  readonly nextAppointmentAt?: string;
  readonly nextAppointmentDurationMinutes?: number;
  readonly sessionsCompleted: number;
  readonly appointmentsAwaitingApproval: number;
}

interface FormPayload {
  readonly currentVersion: number;
  readonly template: readonly AssessmentSectionDef[];
  readonly permissions: readonly SectionPermission[];
  readonly calendarSummary?: CalendarSummary;
  readonly items: readonly VersionItem[];
}

type ViewState = 'loading' | 'ready' | 'forbidden' | 'notFound' | 'error';

/** Per section, because one section saving must not blank another's message. */
type SaveState = 'idle' | 'saving' | 'saved' | 'autosaved' | 'conflict' | 'forbidden' | 'error';

export interface AssessmentFormStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly notFoundLabel: string;
  readonly errorLabel: string;
  readonly missingIdLabel: string;
  readonly saveLabel: string;
  readonly savingLabel: string;
  readonly savedLabel: string;
  /** Distinct from `savedLabel` on purpose: a clinician needs to know the form is saving itself, or they will keep reaching for the button. */
  readonly autosavedLabel: string;
  readonly conflictLabel: string;
  readonly saveForbiddenLabel: string;
  readonly readOnlyLabel: string;
  readonly attachmentsHeading: string;
  readonly attachmentsEmpty: string;
  readonly addFileLabel: string;
  readonly uploadingLabel: string;
  readonly uploadFailedLabel: string;
  readonly downloadLabel: string;
  readonly addRowLabel: string;
  readonly removeRowLabel: string;
  /** `{field}` — the grid's own label. */
  readonly addRowAriaTemplate: string;
  /** `{row}` and `{field}`. */
  readonly removeRowAriaTemplate: string;
  /** `{field}`, `{column}` and `{row}` — see `renderCell` on why a cell needs its own name. */
  readonly cellLabelTemplate: string;
  readonly noNextAppointmentLabel: string;
  readonly versionLabel: string;
}

export interface AssessmentFormProps {
  readonly strings: AssessmentFormStrings;
  /** 2026-09-06: the level each form section's heading renders at — 2 on its own page, 3 inside a dashboard section. See `heading-level.ts`. */
  readonly headingLevel?: PanelHeadingLevel;
  /**
   * Which of the record's sections belong in *this* placement. A filter over
   * what the server sent, never a widening of it — see this file's header.
   * Omitted means every section the caller may read, which is what a page
   * that gives the form a screen of its own wants.
   */
  readonly fieldSets?: readonly AssessmentFieldSet[];
  /**
   * `false` when the page has already rendered this area's heading, which is
   * the case wherever `fieldSets` names a single section: the owner's four
   * area names live in the i18n catalogue with the rest of the page's copy,
   * and repeating the template's own title under them reads as a stutter.
   */
  readonly showTitles?: boolean;
  /**
   * `false` on every placement but the first on a page. The "version N" line
   * is a fact about the *record*, not about a section, so a page showing
   * three areas of one record should say it once.
   */
  readonly showVersion?: boolean;
  /** Injectable for tests. Defaults to `?id=` on the URL, or `me` when the viewer is a patient. */
  readonly patientId?: string;
  readonly client?: SessionClient;
  readonly fetchForm?: (accessToken: string, patientId: string) => Promise<Response>;
  readonly saveSection?: (
    accessToken: string,
    patientId: string,
    body: unknown,
  ) => Promise<Response>;
  readonly requestUploadUrl?: (
    accessToken: string,
    patientId: string,
    body: unknown,
  ) => Promise<Response>;
  readonly requestDownloadUrl?: (
    accessToken: string,
    patientId: string,
    body: unknown,
  ) => Promise<Response>;
  readonly uploadFile?: (uploadUrl: string, file: File) => Promise<Response>;
  /** Injectable for tests; the real one navigates the browser to a presigned URL. */
  readonly openUrl?: (url: string) => void;
}

const defaultClient = createSessionClient();

function formUrl(patientId: string): string {
  return `${contentApiUrl}/patients/${encodeURIComponent(patientId)}/assessments/${ASSESSMENT_ID}`;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
}

function defaultFetchForm(accessToken: string, patientId: string): Promise<Response> {
  return fetch(formUrl(patientId), { headers: { authorization: `Bearer ${accessToken}` } });
}

function defaultSaveSection(
  accessToken: string,
  patientId: string,
  body: unknown,
): Promise<Response> {
  return fetch(formUrl(patientId), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

/**
 * **Same-origin, and not `contentApiUrl` — 2026-09-02.** These two
 * endpoints are served by `NdnWebStack`'s own API (the function needs the
 * media bucket, which lives in that stack) and reach the browser through a
 * CloudFront behaviour on `/attachments/*`. They were previously built
 * from `contentApiUrl`, which is `NdnDataStack`'s content API — a
 * different API, which had never heard of them and answered 404. Every
 * upload failed, and the page could only say the file could not be
 * uploaded.
 *
 * A relative URL is the point rather than an incidental: same-origin means
 * no CORS on this hop at all. The subsequent `PUT` still goes cross-origin
 * to S3, which has its own rule.
 */
function attachmentUrl(patientId: string, action: 'upload-url' | 'download-url'): string {
  return `/attachments/${encodeURIComponent(patientId)}/${ASSESSMENT_ID}/${action}`;
}

function defaultRequestUploadUrl(
  accessToken: string,
  patientId: string,
  body: unknown,
): Promise<Response> {
  return fetch(attachmentUrl(patientId, 'upload-url'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

function defaultRequestDownloadUrl(
  accessToken: string,
  patientId: string,
  body: unknown,
): Promise<Response> {
  return fetch(attachmentUrl(patientId, 'download-url'), {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
}

function defaultUploadFile(uploadUrl: string, file: File): Promise<Response> {
  return fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
}

function patientIdFromLocation(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

/** The stored answers for one section of the newest version, or an empty section when the form has never been written — or when the caller may not read it, which reaches here as the same absence. */
export function sectionOf(
  item: VersionItem | undefined,
  fieldSet: AssessmentFieldSet,
): SectionData {
  return item?.[fieldSet] ?? { responses: {}, attachments: [] };
}

/** The key a draft is held under. One function so the writer and the reader cannot disagree. */
export function draftKey(fieldSet: AssessmentFieldSet, fieldId: string): string {
  return `${fieldSet}.${fieldId}`;
}

/**
 * **The rendering rule this whole screen turns on**, extracted so it can be
 * asserted directly rather than inferred from a DOM this directory has no
 * pattern for rendering.
 *
 * Three gates, in order, and the order matters: a derived field is never
 * editable by anyone (its value is computed on the server and a write
 * naming it is a 400); then the section's own `write` permission, which is
 * the server's answer and not a guess; then the one field-level rule the
 * section's permission cannot express — a patient may write the general
 * section but not the `tag` inside it.
 */
export function isFieldEditable(
  field: AssessmentFieldDef,
  permission: SectionPermission | undefined,
  isPatientViewer: boolean,
): boolean {
  if (field.derived) {
    return false;
  }
  if (permission?.write !== true) {
    return false;
  }
  return !(field.staffOnly && isPatientViewer);
}

/**
 * The five `general` field ids the age and BMI arithmetic below names.
 *
 * Field ids are otherwise never written down outside the template — every
 * other part of this form iterates whatever sections the server sent. These
 * are the exception, for the same reason `ASSESSMENT_TAG_FIELD_ID` exists:
 * the arithmetic *is* about these specific boxes and cannot be expressed by
 * iterating. They are declared here rather than imported from
 * `@ndn/shared-types` because this bundle does not depend on it (see the
 * note above the local type declarations), so — exactly as
 * `caseload-styles.test.ts` says of its own restatement — nothing makes the
 * compiler check that these five still name fields the template ships. What
 * guards the other side is `assessment-template.test.ts`, which fails if the
 * ids move or if either derived field loses the answers it is computed from;
 * its failure message is the pointer back to this constant block.
 *
 * A drifted id is a blank box, not a wrong number: `answerOf` returns `''`
 * for a field that is not there, and `''` is what both functions below
 * return when they cannot compute.
 */
const DATE_OF_BIRTH_FIELD_ID = 'dateOfBirth';
const AGE_FIELD_ID = 'age';
const HEIGHT_FIELD_ID = 'heightCm';
const WEIGHT_FIELD_ID = 'weightKg';
const BMI_FIELD_ID = 'bmi';

/**
 * Whole years, counted the way a birthday is: the difference in years, less
 * one if this year's birthday has not come round yet.
 *
 * The paper form prints an "Age: ___ yrs" box next to the date of birth,
 * and a *typed* age is wrong from the patient's next birthday onward — so
 * the date of birth is the fact stored and this is a view of it, recomputed
 * on every render. Both sides are read in UTC so the answer does not depend
 * on which side of Greenwich the viewer is sitting.
 *
 * An empty, unparseable or future date of birth is `''` rather than a
 * number: an age box is blank until there is a date to compute it from, and
 * a date in the future is a typo, not a negative age.
 */
export function ageFromDateOfBirth(dateOfBirth: AssessmentValue, now: Date): number | '' {
  if (typeof dateOfBirth !== 'string') {
    return '';
  }
  // The value of an `<input type="date">`, and tolerant of a longer ISO
  // string in case an older stored answer carries a time as well.
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth);
  if (!parts) {
    return '';
  }
  const [, year, month, day] = parts;
  let age = now.getUTCFullYear() - Number(year);
  const monthsSinceBirthday = now.getUTCMonth() + 1 - Number(month);
  if (monthsSinceBirthday < 0 || (monthsSinceBirthday === 0 && now.getUTCDate() < Number(day))) {
    age -= 1;
  }
  return age < 0 ? '' : age;
}

/**
 * `kg / m²`, to one decimal place — the precision a BMI is quoted to.
 *
 * Blank unless both boxes hold a positive number, which is also what makes
 * a half-filled form render an empty BMI rather than `Infinity` or `NaN`:
 * an unanswered height is `''`, and `Number('')` is `0`.
 */
export function bmiFromHeightAndWeight(
  heightCm: AssessmentValue,
  weightKg: AssessmentValue,
): number | '' {
  const height = Number(heightCm);
  const weight = Number(weightKg);
  if (!Number.isFinite(height) || !Number.isFinite(weight) || height <= 0 || weight <= 0) {
    return '';
  }
  const metres = height / 100;
  return Math.round((weight / (metres * metres)) * 10) / 10;
}

/** One field's current answer — draft first, stored second — so the arithmetic above sees a height as it is being typed and not only once it is saved. */
function answerOf(
  fieldSet: AssessmentFieldSet,
  fieldId: string,
  drafts: Readonly<Record<string, AssessmentValue>>,
  latest: VersionItem | undefined,
): AssessmentValue {
  const key = draftKey(fieldSet, fieldId);
  if (key in drafts) {
    return drafts[key] as AssessmentValue;
  }
  return sectionOf(latest, fieldSet).responses[fieldId] ?? '';
}

/**
 * What a field shows: the draft if it was touched, the computed value if
 * the field is derived, otherwise the stored answer — and a type-correct
 * blank when there is none, so a checkbox never renders as the string
 * `"undefined"`.
 *
 * **A derived field has two kinds and this is the only place that knows
 * it.** The calendar's figures are facts about `APPT#` rows this client has
 * never read, so the server computes them and sends them alongside as
 * `calendarSummary`. `age` and `bmi` are arithmetic on other answers *in
 * their own section*, which this client is already holding — including the
 * ones typed and not yet saved, so a corrected weight moves the BMI beside
 * it immediately, which a server-computed value could not do. Neither kind
 * is editable and neither is ever sent to a save; `isFieldEditable` and
 * `responsesToSave` both key off the same `derived` flag.
 */
export function fieldValue(
  fieldSet: AssessmentFieldSet,
  field: AssessmentFieldDef,
  drafts: Readonly<Record<string, AssessmentValue>>,
  latest: VersionItem | undefined,
  calendarSummary: CalendarSummary | undefined,
  now: Date = new Date(),
): AssessmentValue {
  const key = draftKey(fieldSet, field.id);
  if (key in drafts) {
    return drafts[key] as AssessmentValue;
  }
  if (field.derived) {
    if (fieldSet === 'general' && field.id === AGE_FIELD_ID) {
      return ageFromDateOfBirth(answerOf(fieldSet, DATE_OF_BIRTH_FIELD_ID, drafts, latest), now);
    }
    if (fieldSet === 'general' && field.id === BMI_FIELD_ID) {
      return bmiFromHeightAndWeight(
        answerOf(fieldSet, HEIGHT_FIELD_ID, drafts, latest),
        answerOf(fieldSet, WEIGHT_FIELD_ID, drafts, latest),
      );
    }
    const summary = calendarSummary as Record<string, AssessmentValue> | undefined;
    return summary?.[field.id] ?? '';
  }
  const stored = sectionOf(latest, fieldSet).responses[field.id];
  if (stored !== undefined) {
    return stored;
  }
  // A type-correct blank: an unticked checkbox is `false` and an unfilled
  // grid is no rows. Both matter for the same reason the comment above
  // gives — `String(undefined)` in a `checked` prop is a permanently
  // ticked box, and `''.map` is a crash.
  if (field.type === 'checkbox') {
    return false;
  }
  return field.type === 'rows' ? [] : '';
}

/** A field's answer as rows, whatever shape it actually arrived in. A scalar stored under an id that later became a grid reads as no rows rather than as a crash. */
export function rowsOf(value: AssessmentValue): readonly AssessmentRow[] {
  return Array.isArray(value) ? (value as readonly AssessmentRow[]) : [];
}

/**
 * The section's fields cut into the runs that share a `group`, in
 * declaration order.
 *
 * Runs, not a map: two fields naming the same group with a different one
 * between them are two headings, because the template's order is the paper
 * form's order and reordering a clinical form to tidy its headings would be
 * the wrong way round. A field with no group starts an unnamed run, which
 * renders with no heading at all — which is what every section other than
 * the assessment form still is.
 */
export function groupsOf(
  fields: readonly AssessmentFieldDef[],
): readonly (readonly [string, readonly AssessmentFieldDef[]])[] {
  const runs: [string, AssessmentFieldDef[]][] = [];
  for (const field of fields) {
    const group = field.group ?? '';
    const last = runs.at(-1);
    if (last && last[0] === group) {
      last[1].push(field);
    } else {
      runs.push([group, [field]]);
    }
  }
  return runs;
}

/**
 * The `responses` a save sends: **only what was touched, and never a
 * derived field.** Both halves matter. Sending untouched fields would turn
 * every save into a full-section overwrite, which would let two people
 * editing different fields of the same section clobber each other; sending
 * a derived one is a 400 the person did nothing to deserve.
 */
export function responsesToSave(
  section: AssessmentSectionDef,
  drafts: Readonly<Record<string, AssessmentValue>>,
): Record<string, AssessmentValue> {
  const responses: Record<string, AssessmentValue> = {};
  for (const field of section.fields) {
    const key = draftKey(section.fieldSet, field.id);
    if (key in drafts && !field.derived) {
      responses[field.id] = drafts[key] as AssessmentValue;
    }
  }
  return responses;
}

export function AssessmentForm({
  strings,
  headingLevel = 2,
  fieldSets,
  showTitles = true,
  showVersion = true,
  patientId,
  client = defaultClient,
  fetchForm = defaultFetchForm,
  saveSection = defaultSaveSection,
  requestUploadUrl = defaultRequestUploadUrl,
  requestDownloadUrl = defaultRequestDownloadUrl,
  uploadFile = defaultUploadFile,
  openUrl = (url) => window.open(url, '_blank', 'noopener'),
}: AssessmentFormProps): ReactNode {
  const [state, setState] = useState<ViewState>('loading');
  const [payload, setPayload] = useState<FormPayload | undefined>();
  const [isPatientViewer, setIsPatientViewer] = useState(false);
  const [resolvedId, setResolvedId] = useState<string | undefined>(patientId);
  /** Draft values, keyed `<fieldSet>.<fieldId>`. Only fields the person has actually touched. */
  const [drafts, setDrafts] = useState<Record<string, AssessmentValue>>({});
  const [saveStates, setSaveStates] = useState<Partial<Record<AssessmentFieldSet, SaveState>>>({});
  const [uploading, setUploading] = useState<Partial<Record<AssessmentFieldSet, boolean>>>({});
  const [uploadFailed, setUploadFailed] = useState<Partial<Record<AssessmentFieldSet, boolean>>>(
    {},
  );
  const fileInputs = useRef<Partial<Record<AssessmentFieldSet, HTMLInputElement | null>>>({});

  /**
   * `silent` is the resync path, and it differs in exactly two ways that
   * both matter once a save can happen on a timer rather than only on a
   * click.
   *
   * It does not show the loading state, because a form that blanked itself
   * to "Loading…" every thirty seconds would be unusable — and unusable
   * mid-consultation, which is where the owner asked for this to work.
   *
   * It does not clear drafts. The unconditional clear below is right for
   * the initial read and for the reader's *own* save (the server's copy is
   * the truth, and a surviving draft would show an edit that may not have
   * been stored) — but a resync is triggered by a *different* placement of
   * this form saving a *different* section, and wiping this one's
   * in-progress typing because a sibling saved is losing work nobody asked
   * to discard. That was already true of the manual button; auto-save
   * would have made it happen to somebody every half minute.
   */
  const load = useCallback(async (options: { readonly silent?: boolean } = {}) => {
    if (options.silent !== true) {
      setState('loading');
    }
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    // The viewer's role decides one thing only: whether the `staffOnly`
    // tag field is editable. `undefined` — a token this bundle cannot read
    // — is not "patient"; it falls through to leaving the field editable
    // and letting the server refuse, the same "hide on a positive answer,
    // never on a shrug" rule token-claims.ts states.
    const role = viewerRoleFromAccessToken(accessToken);
    setIsPatientViewer(role === 'patient');
    const id = patientId ?? (role === 'patient' ? 'me' : patientIdFromLocation());
    setResolvedId(id);
    if (!id) {
      setState('ready');
      return;
    }
    try {
      const response = await fetchForm(accessToken, id);
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (response.status === 404) {
        setState('notFound');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      setPayload((await response.json()) as FormPayload);
      if (options.silent !== true) {
        setDrafts({});
      }
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchForm, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every other placement of this form on the page has just written a new
   * version; re-read so this one's `currentVersion` is the record's, not
   * the one it happened to load with. See this file's header on why the
   * channel is a DOM event and not React state.
   *
   * The saver dispatches too and re-reads itself, which is harmless: `load`
   * is idempotent and the second read returns what the first one did.
   */
  useEffect(() => {
    const resync = () => {
      void load({ silent: true });
    };
    window.addEventListener(ASSESSMENT_SAVED_EVENT, resync);
    return () => window.removeEventListener(ASSESSMENT_SAVED_EVENT, resync);
  }, [load]);

  /** One section's drafts, dropped. The bag is keyed `<fieldSet>.<fieldId>`, so a section's own entries are a prefix match. */
  const clearDraftsFor = (fieldSet: AssessmentFieldSet) => {
    const prefix = `${fieldSet}.`;
    setDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix))),
    );
  };

  const setDraft = (fieldSet: AssessmentFieldSet, fieldId: string, value: AssessmentValue) => {
    setDrafts((current) => ({ ...current, [draftKey(fieldSet, fieldId)]: value }));
    setSaveStates((current) => ({ ...current, [fieldSet]: 'idle' }));
  };

  const handleSave = async (section: AssessmentSectionDef, automatic = false) => {
    // These two are only ever unset before the first read finishes, and
    // nothing can click a button or fire the autosave timer into a form
    // that has not rendered — but this function now lives above the
    // loading branch, so it says so rather than asserting it.
    if (!payload || !resolvedId) {
      return;
    }
    const responses = responsesToSave(section, drafts);
    if (Object.keys(responses).length === 0) {
      return;
    }
    setSaveStates((current) => ({ ...current, [section.fieldSet]: 'saving' }));
    const accessToken = await client.authorization();
    if (!accessToken) {
      setSaveStates((current) => ({ ...current, [section.fieldSet]: 'forbidden' }));
      return;
    }
    try {
      const response = await saveSection(accessToken, resolvedId, {
        baseVersion: payload.currentVersion,
        sections: { [section.fieldSet]: { responses } },
      });
      if (response.status === 409) {
        // Someone else wrote a version while this form was open. Re-reading
        // is the only honest recovery: the draft was computed against a
        // record that no longer exists.
        setSaveStates((current) => ({ ...current, [section.fieldSet]: 'conflict' }));
        clearDraftsFor(section.fieldSet);
        await load({ silent: true });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setSaveStates((current) => ({ ...current, [section.fieldSet]: 'forbidden' }));
        return;
      }
      if (!response.ok) {
        setSaveStates((current) => ({ ...current, [section.fieldSet]: 'error' }));
        return;
      }
      window.dispatchEvent(new Event(ASSESSMENT_SAVED_EVENT));
      // Only *this* section's drafts are spent. Clearing the whole bag —
      // which `load()` used to do — threw away typing in every other
      // section a clinician had open, which on a page that mounts this
      // form twice is the ordinary case rather than an edge one.
      clearDraftsFor(section.fieldSet);
      await load({ silent: true });
      setSaveStates((current) => ({
        ...current,
        [section.fieldSet]: automatic ? 'autosaved' : 'saved',
      }));
    } catch {
      setSaveStates((current) => ({ ...current, [section.fieldSet]: 'error' }));
    }
  };

  /**
   * **Auto-save.** The owner: *"while editing Patient Assessment Form, make
   * it auto saved every 30 seconds, both while filling it normally as well
   * as filling it during Video Call."*
   *
   * The video-call half needs no code of its own — `CallScreen` renders
   * this same component, so the timer comes with it. That is worth saying
   * because the alternative reading (a second implementation on the call
   * screen) would have been two behaviours to keep in step.
   *
   * **It applies to every section this placement renders that the caller
   * may write, not only the assessment form.** The instruction named that
   * section, and it is the one a clinician spends a consultation in — but
   * the same screen shows Patient Details above it, and a form where the
   * lower half saves itself and the upper half silently does not is a lost
   * edit waiting to be reported as a bug. Auto-save that is conditional on
   * which heading you are under is not a feature anyone can hold in mind.
   *
   * Three properties this deliberately has:
   *
   *   * **It sends only what was touched.** Each section is saved by the
   *     same `handleSave` the button uses, and `responsesToSave` sends the
   *     dirty fields alone — so an autosave cannot overwrite a field this
   *     person never looked at, and two clinicians in different sections
   *     of one record do not fight.
   *   * **It never runs two at once.** A save re-reads the record on the
   *     way out, so an overlapping tick would compute its patch against a
   *     version being replaced. The ref is checked and set synchronously,
   *     which an interval callback makes sufficient.
   *   * **It does not retry a conflict.** A 409 means somebody else wrote
   *     while this form was open; the section is re-read and its drafts
   *     dropped, exactly as the manual button has always done. Retrying
   *     automatically would mean silently overwriting another clinician's
   *     edit to the same field thirty seconds later, which is not a thing
   *     to do to a clinical record without a person deciding to.
   */
  const autosaving = useRef(false);
  const runAutosave = async () => {
    if (state !== 'ready' || !payload || !resolvedId || autosaving.current) {
      return;
    }
    const candidates = (fieldSets
      ? payload.template.filter((section) => fieldSets.includes(section.fieldSet))
      : payload.template
    ).filter(
      (section) =>
        payload.permissions.find((permission) => permission.fieldSet === section.fieldSet)
          ?.write === true &&
        Object.keys(responsesToSave(section, drafts)).length > 0,
    );
    if (candidates.length === 0) {
      return;
    }
    autosaving.current = true;
    try {
      // Sequential, not `Promise.all`: each save bumps the record's
      // version and the next patch needs the new one, which the re-read
      // inside `handleSave` supplies.
      for (const section of candidates) {
        await handleSave(section, true);
      }
    } finally {
      autosaving.current = false;
    }
  };

  // The latest-callback pattern, and the reason for it is the interval
  // below: an effect with `[]` must not close over this render's `drafts`,
  // or the timer would spend the session saving whatever was on screen
  // thirty seconds after mount. Held in a ref updated after every render,
  // so the tick always runs the current one. Written in an effect rather
  // than during render because render has to stay pure.
  const autosave = useRef(runAutosave);
  useEffect(() => {
    autosave.current = runAutosave;
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      void autosave.current();
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (state === 'loading') {
    return <PanelPlaceholder label={strings.loadingLabel} shape="form" />;
  }
  if (!resolvedId) {
    return <p role="alert">{strings.missingIdLabel}</p>;
  }
  if (state === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (state === 'notFound') {
    return <p role="alert">{strings.notFoundLabel}</p>;
  }
  if (state === 'error' || !payload) {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const latest = payload.items[0];
  const permissionFor = (fieldSet: AssessmentFieldSet): SectionPermission | undefined =>
    payload.permissions.find((permission) => permission.fieldSet === fieldSet);

  const valueOf = (section: AssessmentSectionDef, field: AssessmentFieldDef): AssessmentValue =>
    fieldValue(section.fieldSet, field, drafts, latest, payload.calendarSummary);

  const isEditable = (section: AssessmentSectionDef, field: AssessmentFieldDef): boolean =>
    isFieldEditable(field, permissionFor(section.fieldSet), isPatientViewer);


  /**
   * Three steps, and the middle one does not go through this API at all:
   * ask for a presigned URL, `PUT` the bytes straight to S3, then record
   * the key on the record. The third call is authorised independently —
   * holding an upload URL is never permission for the file to appear on
   * the record.
   */
  const handleUpload = async (fieldSet: AssessmentFieldSet, file: File) => {
    setUploading((current) => ({ ...current, [fieldSet]: true }));
    setUploadFailed((current) => ({ ...current, [fieldSet]: false }));
    const fail = () => {
      setUploading((current) => ({ ...current, [fieldSet]: false }));
      setUploadFailed((current) => ({ ...current, [fieldSet]: true }));
    };
    const accessToken = await client.authorization();
    if (!accessToken) {
      fail();
      return;
    }
    try {
      const urlResponse = await requestUploadUrl(accessToken, resolvedId, {
        section: fieldSet,
        fileName: file.name,
        contentType: file.type,
      });
      if (!urlResponse.ok) {
        fail();
        return;
      }
      const { uploadUrl, key } = (await urlResponse.json()) as {
        uploadUrl: string;
        key: string;
      };
      const putResponse = await uploadFile(uploadUrl, file);
      if (!putResponse.ok) {
        fail();
        return;
      }
      const recorded = await saveSection(accessToken, resolvedId, {
        baseVersion: payload.currentVersion,
        sections: {
          [fieldSet]: {
            addAttachments: [{ key, fileName: file.name, contentType: file.type }],
          },
        },
      });
      if (!recorded.ok) {
        fail();
        return;
      }
      setUploading((current) => ({ ...current, [fieldSet]: false }));
      const input = fileInputs.current[fieldSet];
      if (input) {
        input.value = '';
      }
      // Recording the attachment wrote a version, exactly as a save does.
      window.dispatchEvent(new Event(ASSESSMENT_SAVED_EVENT));
      await load();
    } catch {
      fail();
    }
  };

  const handleDownload = async (fieldSet: AssessmentFieldSet, key: string) => {
    const accessToken = await client.authorization();
    if (!accessToken) {
      return;
    }
    try {
      const response = await requestDownloadUrl(accessToken, resolvedId, {
        section: fieldSet,
        key,
      });
      if (!response.ok) {
        return;
      }
      const { downloadUrl } = (await response.json()) as { downloadUrl: string };
      openUrl(downloadUrl);
    } catch {
      // A failed download is not worth a page-level error state: the file
      // is still listed, and trying again is the obvious recovery.
    }
  };

  /**
   * A read-only answer, as a `<dt>`/`<dd>` pair — the same markup
   * `PatientRecordPanel.tsx` already uses for the facts above its form,
   * and deliberately **not** a `<span aria-labelledby>` pair, which was
   * the first cut.
   *
   * That first cut was wrong in a way only a rendered test caught: a
   * labelled span is reachable by `getByLabelText`, so a section a caller
   * may only read was indistinguishable from one they may edit as far as
   * assistive tech (and any test) was concerned. `aria-labelledby` on a
   * non-interactive element labels something that takes no input. A
   * definition list says "term, value", which is what this is.
   */
  const renderReadOnly = (section: AssessmentSectionDef, field: AssessmentFieldDef): ReactNode => {
    const value = valueOf(section, field);
    const shown =
      field.type === 'checkbox'
        ? String(value === true)
        : value === '' || value === undefined
          ? '\u2014'
          : String(value);
    return (
      <Fragment key={field.id}>
        <dt>{field.label}</dt>
        <dd>{shown}</dd>
      </Fragment>
    );
  };

  /**
   * One cell of a grid.
   *
   * **Every cell carries its own `aria-label`** rather than relying on the
   * column's `<th>`. A header cell names a *column*, and an input inside
   * the body of that column is not reliably announced by it — so on a
   * four-row medication table a screen-reader user would meet four boxes
   * all called "Dose" and nothing to say which row they were in. The row
   * number is one-based because it is being read aloud to a person.
   */
  const renderCell = (
    section: AssessmentSectionDef,
    field: AssessmentFieldDef,
    column: AssessmentColumnDef,
    index: number,
    rows: readonly AssessmentRow[],
  ): ReactNode => {
    const cell = rows[index]?.[column.id];
    const label = strings.cellLabelTemplate
      .replace('{field}', field.label)
      .replace('{column}', column.label)
      .replace('{row}', String(index + 1));
    const write = (next: AssessmentRowValue) =>
      setDraft(
        section.fieldSet,
        field.id,
        rows.map((row, i) => (i === index ? { ...row, [column.id]: next } : row)),
      );

    if (column.type === 'select') {
      return (
        <select aria-label={label} value={String(cell ?? '')} onChange={(e) => write(e.target.value)}>
          <option value="">—</option>
          {(column.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    if (column.type === 'checkbox') {
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={cell === true}
          onChange={(e) => write(e.target.checked)}
        />
      );
    }
    const inputType = column.type === 'date' ? 'date' : column.type === 'number' ? 'number' : 'text';
    return (
      <input
        type={inputType}
        aria-label={label}
        value={cell === undefined ? '' : String(cell)}
        onChange={(e) => write(column.type === 'number' ? Number(e.target.value) : e.target.value)}
      />
    );
  };

  /**
   * A grid, editable — the paper form's tables, which are about a third of
   * the assessment form's sections.
   *
   * Rows are appended and removed, never reordered, which is why the array
   * index is an honest React key here: it identifies the same row across a
   * re-render for as long as that row exists, and a removal re-keys only
   * the rows after it. A row has no id of its own, and inventing one would
   * be a stored value nobody reads.
   */
  const renderRows = (section: AssessmentSectionDef, field: AssessmentFieldDef): ReactNode => {
    const labelId = `assessment-${section.fieldSet}-${field.id}-label`;
    const rows = rowsOf(valueOf(section, field));
    const columns = field.columns ?? [];
    const writeRows = (next: readonly AssessmentRow[]) =>
      setDraft(section.fieldSet, field.id, next);

    return (
      <div key={field.id}>
        <p id={labelId}>{field.label}</p>
        {/* Some grids run to seven columns. A table that cannot scroll
            inside its own box makes the whole page scroll sideways, which
            on a phone means the save button is off-screen. */}
        <div style={{ overflowX: 'auto' }}>
          <table aria-labelledby={labelId}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.id} scope="col">
                    {column.label}
                  </th>
                ))}
                {/* The remove column's header is deliberately empty: this
                    app has no visually-hidden utility class, and a visible
                    "Remove this row" above a column of buttons that each
                    already say so would be the label twice. Every button in
                    the column carries its own `aria-label` naming the row
                    it removes, which is the part that has to be right. */}
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column.id}>{renderCell(section, field, column, index, rows)}</td>
                  ))}
                  <td>
                    {/* 2026-09-08: `sm`, like every control that sits
                        inside a row of content rather than being the thing
                        the section is for. The save button below stays full
                        size and primary — that is the one action here. */}
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={strings.removeRowAriaTemplate
                        .replace('{row}', String(index + 1))
                        .replace('{field}', field.label)}
                      onClick={() => writeRows(rows.filter((_, i) => i !== index))}
                    >
                      {strings.removeRowLabel}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <Button
            size="sm"
            variant="secondary"
            aria-label={strings.addRowAriaTemplate.replace('{field}', field.label)}
            onClick={() => writeRows([...rows, {}])}
          >
            {strings.addRowLabel}
          </Button>
        </p>
      </div>
    );
  };

  /** The same grid for someone who may read it and not change it. A `<dl>` cannot hold a table, so a read-only grid sits beside the definition list rather than inside it. */
  const renderReadOnlyRows = (
    section: AssessmentSectionDef,
    field: AssessmentFieldDef,
  ): ReactNode => {
    const labelId = `assessment-${section.fieldSet}-${field.id}-label`;
    const rows = rowsOf(valueOf(section, field));
    const columns = field.columns ?? [];
    return (
      <div key={field.id}>
        <p id={labelId}>{field.label}</p>
        {rows.length === 0 ? (
          <p>{'\u2014'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table aria-labelledby={labelId}>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.id} scope="col">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => {
                      const cell = row[column.id];
                      return (
                        <td key={column.id}>
                          {column.type === 'checkbox'
                            ? String(cell === true)
                            : cell === undefined || cell === ''
                              ? '\u2014'
                              : String(cell)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderField = (section: AssessmentSectionDef, field: AssessmentFieldDef): ReactNode => {
    const inputId = `assessment-${section.fieldSet}-${field.id}`;
    const value = valueOf(section, field);
    if (field.type === 'rows') {
      return renderRows(section, field);
    }

    if (field.type === 'select') {
      return (
        <p key={field.id}>
          <label htmlFor={inputId}>{field.label}</label>
          <select
            id={inputId}
            value={String(value)}
            onChange={(event) => setDraft(section.fieldSet, field.id, event.target.value)}
          >
            <option value="">—</option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </p>
      );
    }

    if (field.type === 'checkbox') {
      return (
        <p key={field.id}>
          <label htmlFor={inputId}>
            <input
              id={inputId}
              type="checkbox"
              checked={value === true}
              onChange={(event) => setDraft(section.fieldSet, field.id, event.target.checked)}
            />{' '}
            {field.label}
          </label>
        </p>
      );
    }

    if (field.type === 'textarea') {
      return (
        <p key={field.id}>
          <label htmlFor={inputId}>{field.label}</label>
          <textarea
            id={inputId}
            value={String(value)}
            onChange={(event) => setDraft(section.fieldSet, field.id, event.target.value)}
          />
        </p>
      );
    }

    const inputType =
      field.type === 'date'
        ? 'date'
        : field.type === 'datetime'
          ? 'datetime-local'
          : field.type === 'number'
            ? 'number'
            : 'text';
    return (
      <p key={field.id}>
        <label htmlFor={inputId}>{field.label}</label>
        <input
          id={inputId}
          type={inputType}
          value={String(value)}
          onChange={(event) =>
            setDraft(
              section.fieldSet,
              field.id,
              field.type === 'number' ? Number(event.target.value) : event.target.value,
            )
          }
        />
      </p>
    );
  };

  const renderAttachments = (section: AssessmentSectionDef): ReactNode => {
    const attachments = sectionOf(latest, section.fieldSet).attachments;
    const writable = permissionFor(section.fieldSet)?.write === true;
    return (
      <>
        <h3>{strings.attachmentsHeading}</h3>
        {attachments.length === 0 ? (
          <p>{strings.attachmentsEmpty}</p>
        ) : (
          <ul>
            {attachments.map((attachment) => (
              <li key={attachment.key}>
                {attachment.fileName}{' '}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleDownload(section.fieldSet, attachment.key)}
                >
                  {strings.downloadLabel}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {writable && (
          <p>
            <label htmlFor={`assessment-file-${section.fieldSet}`}>{strings.addFileLabel}</label>
            <input
              id={`assessment-file-${section.fieldSet}`}
              type="file"
              ref={(element) => {
                fileInputs.current[section.fieldSet] = element;
              }}
              disabled={uploading[section.fieldSet] === true}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleUpload(section.fieldSet, file);
                }
              }}
            />
            {uploading[section.fieldSet] === true && (
              <span role="status">{strings.uploadingLabel}</span>
            )}
            {uploadFailed[section.fieldSet] === true && (
              <span role="alert">{strings.uploadFailedLabel}</span>
            )}
          </p>
        )}
      </>
    );
  };

  /**
   * A section's save button and its status message, **rendered twice — once
   * under the heading and once after the fields.**
   *
   * The button has always existed; what changed is how far away it was.
   * Patient Assessment Form is 597 controls under 44 sub-headings, so a
   * single button after the last of them is a button a clinician would
   * have to scroll past the entire form to reach. The owner asked for one
   * *"just in case someone wants to click it before autosave hits"*, and a
   * control you cannot reach in the thirty seconds you are trying to
   * pre-empt is not that control.
   *
   * Both copies carry the status too, and that half matters as much: it is
   * how "Saved automatically." reaches somebody working at the top of a
   * long section, who would otherwise never see the form confirm anything.
   *
   * Two buttons with the same accessible name in one section is
   * deliberate. They do the same thing, which is exactly why they should
   * read the same; top-and-bottom controls on a long form are a pattern
   * people already know, and inventing "Save (top)" would be naming an
   * implementation detail out loud.
   */
  const saveControls = (
    section: AssessmentSectionDef,
    saveState: SaveState,
    position: 'top' | 'bottom',
  ): ReactNode => {
    if (permissionFor(section.fieldSet)?.write !== true) {
      return null;
    }
    return (
      <p className="ndn-panel-actions" key={`${section.fieldSet}-save-${position}`}>
        <Button disabled={saveState === 'saving'} onClick={() => void handleSave(section)}>
          {saveState === 'saving' ? strings.savingLabel : strings.saveLabel}
        </Button>
        {saveState === 'saved' && <span role="status">{strings.savedLabel}</span>}
        {saveState === 'autosaved' && <span role="status">{strings.autosavedLabel}</span>}
        {saveState === 'conflict' && <span role="alert">{strings.conflictLabel}</span>}
        {saveState === 'forbidden' && <span role="alert">{strings.saveForbiddenLabel}</span>}
        {saveState === 'error' && <span role="alert">{strings.errorLabel}</span>}
      </p>
    );
  };

  // The placement filter. `template` already holds only what this caller
  // may read, so this can narrow and never widen — see the header.
  const shown = fieldSets
    ? payload.template.filter((section) => fieldSets.includes(section.fieldSet))
    : payload.template;

  // A placement whose section the server did not send has nothing to say.
  // Rendering the version line alone would be a stray "Version 3" under a
  // heading with no content — which is what a patient would see under
  // "Patient Assessment Form" if a page ever mounted that placement for
  // them.
  if (shown.length === 0) {
    return null;
  }

  return (
    <>
      {showVersion && (
        <p>
          {strings.versionLabel} {payload.currentVersion}
        </p>
      )}
      {shown.map((section) => {
        const writable = permissionFor(section.fieldSet)?.write === true;
        const saveState = saveStates[section.fieldSet] ?? 'idle';
        return (
          <section
            key={section.fieldSet}
            aria-labelledby={showTitles ? `assessment-${section.fieldSet}-heading` : undefined}
          >
            {showTitles && (
              <Heading level={headingLevel} id={`assessment-${section.fieldSet}-heading`}>
                {section.title}
              </Heading>
            )}
            {!writable && <p>{strings.readOnlyLabel}</p>}
            {section.fieldSet === 'calendar' &&
              payload.calendarSummary?.nextAppointmentAt === undefined && (
                <p>{strings.noNextAppointmentLabel}</p>
              )}
            {saveControls(section, saveState, 'top')}
            {/* Grouped first, then split.

                The owner's assessment form is 44 numbered headings and
                nearly six hundred controls; a flat run of those under one
                title is not a form anyone can fill in. So a heading is
                emitted above each run of fields that names a group
                (`groupsOf`). Sections whose fields name none — Patient
                Details, Prescription, Appointments — are one unnamed run
                and render exactly as they did.

                Within a run, read-only answers come first as one
                definition list, because grouping is what `<dl>` requires:
                a term/value list is one list, not one per pair. Read-only
                *grids* sit beside it rather than in it, since a `<dl>`
                cannot contain a table. The consequence is unchanged from
                when this was section-wide — a run a caller can only partly
                edit shows its read-only half first — and so is the reason
                for accepting it: the alternative is invalid markup. */}
            {groupsOf(section.fields).map(([group, fields], index) => {
              const readOnlyScalars = fields.filter(
                (field) => !isEditable(section, field) && field.type !== 'rows',
              );
              const readOnlyGrids = fields.filter(
                (field) => !isEditable(section, field) && field.type === 'rows',
              );
              const editable = fields.filter((field) => isEditable(section, field));
              return (
                <Fragment key={`${section.fieldSet}-${index}`}>
                  {group !== '' && (
                    <Heading level={nestedHeadingLevel(headingLevel)}>{group}</Heading>
                  )}
                  {readOnlyScalars.length > 0 && (
                    <dl>{readOnlyScalars.map((field) => renderReadOnly(section, field))}</dl>
                  )}
                  {readOnlyGrids.map((field) => renderReadOnlyRows(section, field))}
                  {editable.map((field) => renderField(section, field))}
                </Fragment>
              );
            })}
            {saveControls(section, saveState, 'bottom')}
            {renderAttachments(section)}
          </section>
        );
      })}
    </>
  );
}
