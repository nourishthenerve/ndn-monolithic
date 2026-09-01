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
import { Heading } from '@ndn/ui';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { viewerRoleFromAccessToken } from '../auth/token-claims.js';
import { contentApiUrl } from '../site-config.js';

/** The form every patient's record is instantiated from. One template, one form per patient — `assessment-repository.ts`'s `DEFAULT_ASSESSMENT_ID`. */
export const ASSESSMENT_ID = 'intake-v1';

// The response shapes, declared locally rather than imported from
// `@ndn/shared-types` — the same choice `PatientRecordPanel.tsx` and every
// other island here already makes, and `apps/web`'s dependency list is the
// enforcement: this bundle depends on `@ndn/i18n` and `@ndn/ui` and
// nothing server-side. What arrives here is *whatever the server chose to
// send this caller*, which is a narrower thing than the stored record —
// `general?`/`patient?`/`private?`/`calendar?` are optional here precisely
// because a section the caller may not read is absent, not empty.
export type AssessmentFieldSet = 'general' | 'patient' | 'private' | 'calendar';

export type AssessmentValue = string | number | boolean;

export interface AssessmentFieldDef {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'textarea' | 'select' | 'date' | 'datetime' | 'number' | 'checkbox';
  readonly options?: readonly string[];
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
type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'forbidden' | 'error';

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
  readonly conflictLabel: string;
  readonly saveForbiddenLabel: string;
  readonly readOnlyLabel: string;
  readonly attachmentsHeading: string;
  readonly attachmentsEmpty: string;
  readonly addFileLabel: string;
  readonly uploadingLabel: string;
  readonly uploadFailedLabel: string;
  readonly downloadLabel: string;
  readonly noNextAppointmentLabel: string;
  readonly versionLabel: string;
}

export interface AssessmentFormProps {
  readonly strings: AssessmentFormStrings;
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

function defaultRequestUploadUrl(
  accessToken: string,
  patientId: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${formUrl(patientId)}/attachment-upload-url`, {
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
  return fetch(`${formUrl(patientId)}/attachment-download-url`, {
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
 * What a field shows: the draft if it was touched, the derived summary if
 * the field is derived, otherwise the stored answer — and a type-correct
 * blank when there is none, so a checkbox never renders as the string
 * `"undefined"`.
 */
export function fieldValue(
  fieldSet: AssessmentFieldSet,
  field: AssessmentFieldDef,
  drafts: Readonly<Record<string, AssessmentValue>>,
  latest: VersionItem | undefined,
  calendarSummary: CalendarSummary | undefined,
): AssessmentValue {
  const key = draftKey(fieldSet, field.id);
  if (key in drafts) {
    return drafts[key] as AssessmentValue;
  }
  if (field.derived) {
    const summary = calendarSummary as Record<string, AssessmentValue> | undefined;
    return summary?.[field.id] ?? '';
  }
  return sectionOf(latest, fieldSet).responses[field.id] ?? (field.type === 'checkbox' ? false : '');
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
  const [uploadFailed, setUploadFailed] = useState<Partial<Record<AssessmentFieldSet, boolean>>>({});
  const fileInputs = useRef<Partial<Record<AssessmentFieldSet, HTMLInputElement | null>>>({});

  const load = useCallback(async () => {
    setState('loading');
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
      // Drafts are cleared on every reload, including the reload after a
      // save: the server's copy is the truth, and a draft that survived it
      // would show an edit that may not have been the one stored.
      setDrafts({});
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchForm, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
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

  const setDraft = (fieldSet: AssessmentFieldSet, fieldId: string, value: AssessmentValue) => {
    setDrafts((current) => ({ ...current, [draftKey(fieldSet, fieldId)]: value }));
    setSaveStates((current) => ({ ...current, [fieldSet]: 'idle' }));
  };

  const handleSave = async (section: AssessmentSectionDef) => {
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
        await load();
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
      await load();
      setSaveStates((current) => ({ ...current, [section.fieldSet]: 'saved' }));
    } catch {
      setSaveStates((current) => ({ ...current, [section.fieldSet]: 'error' }));
    }
  };

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
      const response = await requestDownloadUrl(accessToken, resolvedId, { section: fieldSet, key });
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

  const renderField = (section: AssessmentSectionDef, field: AssessmentFieldDef): ReactNode => {
    const inputId = `assessment-${section.fieldSet}-${field.id}`;
    const value = valueOf(section, field);

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
      field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : field.type === 'number' ? 'number' : 'text';
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
                <button
                  type="button"
                  onClick={() => void handleDownload(section.fieldSet, attachment.key)}
                >
                  {strings.downloadLabel}
                </button>
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

  return (
    <>
      <p>
        {strings.versionLabel} {payload.currentVersion}
      </p>
      {payload.template.map((section) => {
        const writable = permissionFor(section.fieldSet)?.write === true;
        const saveState = saveStates[section.fieldSet] ?? 'idle';
        return (
          <section key={section.fieldSet} aria-labelledby={`assessment-${section.fieldSet}-heading`}>
            <Heading level={2} id={`assessment-${section.fieldSet}-heading`}>
              {section.title}
            </Heading>
            {!writable && <p>{strings.readOnlyLabel}</p>}
            {section.fieldSet === 'calendar' &&
              payload.calendarSummary?.nextAppointmentAt === undefined && (
                <p>{strings.noNextAppointmentLabel}</p>
              )}
            {/* Read-only answers are grouped into one definition list and
                editable ones follow as controls. Grouping is what `<dl>`
                requires — a term/value list is one list, not one per pair
                — and the consequence is that a section a caller can only
                partly edit shows its read-only half first. Worth the
                reordering: the alternative is either invalid markup or a
                `<dl>` per field. */}
            {section.fields.some((field) => !isEditable(section, field)) && (
              <dl>
                {section.fields
                  .filter((field) => !isEditable(section, field))
                  .map((field) => renderReadOnly(section, field))}
              </dl>
            )}
            {section.fields
              .filter((field) => isEditable(section, field))
              .map((field) => renderField(section, field))}
            {writable && (
              <p>
                <button
                  type="button"
                  disabled={saveState === 'saving'}
                  onClick={() => void handleSave(section)}
                >
                  {saveState === 'saving' ? strings.savingLabel : strings.saveLabel}
                </button>
                {saveState === 'saved' && <span role="status">{strings.savedLabel}</span>}
                {saveState === 'conflict' && <span role="alert">{strings.conflictLabel}</span>}
                {saveState === 'forbidden' && (
                  <span role="alert">{strings.saveForbiddenLabel}</span>
                )}
                {saveState === 'error' && <span role="alert">{strings.errorLabel}</span>}
              </p>
            )}
            {renderAttachments(section)}
          </section>
        );
      })}
    </>
  );
}
