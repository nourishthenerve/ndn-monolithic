// TASK 2.5.3 step 6: the principal clinician's cross-caseload view.
// Rendered only inside `RequireAuth` (caseload.astro), so this component
// never mounts before a session exists — but it still treats a `403` from
// the API as an ordinary, expected outcome rather than an error: a
// signed-in sub-clinician or patient can reach this *page* (RequireAuth
// only knows "signed in", not role), and the server-side `can()` check
// (services/api/src/caseload.ts) is the real boundary. This component's
// job is to say so plainly, not to guess at roles client-side.
//
// One page of results in state at a time — never every page accumulated,
// matching the backend's own "never accumulate a caseload in memory"
// (step 5) at the UI layer too. Previous pages are recoverable via a
// client-side cursor stack, not by holding their data.
//
// ## Amendment, 2026-08-31 — the principal's dashboard
//
// The owner asked for "an overall dashboard showing how many patients are
// there in the system with active ones being at the top. which clinicians
// each patient has been assigned to with having the option to reassign to
// a new clinician". This view was two-thirds of that already; the three
// things it lacked all landed together:
//
//   * **counts** — `GET /caseload` returns `counts` on the first page
//     (caseload-repository.ts explains why only the first);
//   * **every patient, active first** — GSI3 was sparse on assignment, so
//     a just-registered patient was structurally invisible here. It now
//     indexes every patient and ranks by status, so ordering and
//     completeness are both the index's doing, not this component's;
//   * **assign / reassign in place** — a `<select>` of active colleagues
//     (`GET /clinicians`) and one button per row, calling
//     `POST /patients/{id}/approve` for a patient nobody has yet and
//     `POST /patients/{id}/reassign` for one who is already assigned.
//     Which of the two is correct is a fact about the patient's status,
//     not a choice the principal should have to make, so this component
//     picks it from `accountStatus` — the API rejects the wrong one with a
//     409 (`ALREADY_ASSIGNED` / `NOT_ASSIGNED`) regardless, so the server
//     stays the authority and this is only about not asking a pointless
//     question.
//
// A mutation reloads the current page rather than patching a row in state:
// approval changes the patient's *status*, which changes their position in
// the index, so the honest thing to show afterwards is what the index
// actually returns now.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export type PatientAccountStatus = 'pending' | 'approved' | 'declined' | 'suspended';

export interface CaseloadEntry {
  readonly patientId: string;
  readonly fullName: string;
  readonly accountStatus: PatientAccountStatus;
  readonly assignedClinicianId?: string;
  readonly assignedClinicianName?: string;
}

export interface CaseloadCounts {
  readonly total: number;
  readonly active: number;
}

interface CaseloadPage {
  readonly items: readonly CaseloadEntry[];
  readonly nextCursor?: string;
  readonly counts?: CaseloadCounts;
}

/** One assignable colleague, from `GET /clinicians`. Deactivated ones are filtered out before they reach the dropdown. */
interface AssignableClinician {
  readonly id: string;
  readonly displayName: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly page: CaseloadPage };

export interface CaseloadViewStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly patientColumnLabel: string;
  readonly statusColumnLabel: string;
  readonly clinicianColumnLabel: string;
  readonly assignColumnLabel: string;
  readonly nextPageLabel: string;
  readonly previousPageLabel: string;
  readonly caption: string;
  readonly totalPatientsLabel: string;
  readonly activePatientsLabel: string;
  readonly statusPendingLabel: string;
  readonly statusApprovedLabel: string;
  readonly statusDeclinedLabel: string;
  readonly statusSuspendedLabel: string;
  readonly unassignedLabel: string;
  readonly chooseClinicianLabel: string;
  readonly assignButton: string;
  readonly reassignButton: string;
  readonly working: string;
  readonly assignError: string;
  readonly noCliniciansLabel: string;
  readonly openRecordLabel: string;
  readonly removeColumnLabel: string;
  readonly suspendButton: string;
  readonly restoreButton: string;
  readonly suspendConfirm: string;
  readonly statusError: string;
}

export interface CaseloadViewProps {
  readonly strings: CaseloadViewStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchPage?: (cursor: string | undefined, accessToken: string) => Promise<Response>;
  readonly listClinicians?: (accessToken: string) => Promise<Response>;
  readonly assignPatient?: (
    accessToken: string,
    patientId: string,
    clinicianId: string,
    alreadyAssigned: boolean,
  ) => Promise<Response>;
  readonly setPatientActive?: (
    accessToken: string,
    patientId: string,
    active: boolean,
  ) => Promise<Response>;
  /** Injectable for tests; defaults to the browser's own `confirm`. Suspension locks a patient out the moment it lands. */
  readonly confirmSuspend?: (message: string) => boolean;
  /** Where a patient's name links to — `/{locale}/account/patient-record`, with the id appended. */
  readonly recordHrefBase: string;
}

const defaultClient = createSessionClient();

function defaultFetchPage(cursor: string | undefined, accessToken: string): Promise<Response> {
  const url = new URL(`${contentApiUrl}/caseload`);
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

function defaultListClinicians(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultSetPatientActive(
  accessToken: string,
  patientId: string,
  active: boolean,
): Promise<Response> {
  const action = active ? 'restore' : 'suspend';
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultAssignPatient(
  accessToken: string,
  patientId: string,
  clinicianId: string,
  alreadyAssigned: boolean,
): Promise<Response> {
  const action = alreadyAssigned ? 'reassign' : 'approve';
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ assignedClinicianId: clinicianId }),
  });
}

export function CaseloadView({
  strings,
  client = defaultClient,
  fetchPage = defaultFetchPage,
  listClinicians = defaultListClinicians,
  assignPatient = defaultAssignPatient,
  setPatientActive = defaultSetPatientActive,
  confirmSuspend,
  recordHrefBase,
}: CaseloadViewProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // The cursor that produced the page currently on screen, and the stack
  // of cursors that got here — popping it is how "previous page" works
  // without ever holding more than one page's data.
  const [cursorStack, setCursorStack] = useState<readonly (string | undefined)[]>([undefined]);
  const [clinicians, setClinicians] = useState<readonly AssignableClinician[]>([]);
  /** patientId -> the clinician chosen in that row's dropdown, before the button is pressed. */
  const [choices, setChoices] = useState<Readonly<Record<string, string>>>({});
  const [pendingPatientId, setPendingPatientId] = useState<string | undefined>();
  const [assignFailed, setAssignFailed] = useState(false);
  /**
   * 2026-08-31: helpdesk reads this dashboard but is denied the `Patient
   * assignment` row outright, so the assign column is not merely
   * inoperative for them — it is an offer the API will always refuse, and
   * the whole column is dropped rather than shown broken. `undefined`
   * (token unreadable) keeps the column, on this file's own "hide only on
   * a positive answer" rule.
   */
  const [canAssign, setCanAssign] = useState(true);
  /**
   * Suspending a patient is `Patient assignment`'s own `update` —
   * Principal-only, exactly like assignment itself, and deliberately not
   * `Patient profile`'s `update`, which helpdesk holds. So the two
   * columns appear and disappear together, and one flag is the honest
   * model of that rather than two that could drift.
   */
  const [statusFailed, setStatusFailed] = useState(false);

  const load = useCallback(
    async (cursor: string | undefined) => {
      setState({ status: 'loading' });
      const accessToken = await client.authorization();
      if (!accessToken) {
        // RequireAuth already guarantees a session exists to get this far,
        // but a token can still expire mid-visit — treated the same as a
        // real 401 would be: `forbidden` is closer than `error` when the
        // real answer is "sign in again", but this component has no
        // sign-in control of its own, so it says the plain, honest thing.
        setState({ status: 'forbidden' });
        return;
      }
      try {
        const response = await fetchPage(cursor, accessToken);
        if (response.status === 403 || response.status === 401) {
          setState({ status: 'forbidden' });
          return;
        }
        if (!response.ok) {
          setState({ status: 'error' });
          return;
        }
        const payload = (await response.json()) as Partial<CaseloadPage>;
        setState({
          status: 'ready',
          page: {
            items: payload.items ?? [],
            nextCursor: payload.nextCursor,
            counts: payload.counts,
          },
        });
      } catch {
        setState({ status: 'error' });
      }
    },
    [client, fetchPage],
  );

  useEffect(() => {
    void load(cursorStack.at(-1));
  }, [cursorStack, load]);

  // The colleague list is loaded once, not per page: it changes when the
  // principal adds or deactivates someone on a different page entirely,
  // and re-fetching it on every page turn would be a read per turn to get
  // the same handful of names back.
  useEffect(() => {
    let cancelled = false;
    const loadClinicians = async () => {
      const state = await client.resolve();
      if (!cancelled && state.status === 'signed-in' && state.session.viewerRole === 'helpdesk') {
        setCanAssign(false);
        // No colleague list either: `GET /clinicians` is Principal-only
        // and would 403, and there is nothing left on this page for the
        // answer to feed.
        return;
      }
      const accessToken = await client.authorization();
      if (!accessToken) {
        return;
      }
      try {
        const response = await listClinicians(accessToken);
        if (!response.ok) {
          // A sub-clinician or patient who reached this page gets a 403
          // here as well as on the caseload itself — the empty list that
          // follows is not an error state of its own, it is the same
          // refusal already reported above the table.
          return;
        }
        const payload = (await response.json()) as {
          items?: readonly { id: string; displayName: string; account_status: string }[];
        };
        if (cancelled) {
          return;
        }
        setClinicians(
          (payload.items ?? [])
            // Only active colleagues can take a patient —
            // `AssignmentRepository` rejects a deactivated one with
            // `CLINICIAN_NOT_AVAILABLE`, so offering them here would be
            // offering an action guaranteed to fail.
            .filter((clinician) => clinician.account_status === 'active')
            .map(({ id, displayName }) => ({ id, displayName })),
        );
      } catch {
        // Left empty — the dropdown renders its "no colleagues" hint, and
        // the table itself is still useful without the assign control.
      }
    };
    void loadClinicians();
    return () => {
      cancelled = true;
    };
  }, [client, listClinicians]);

  const goNext = (nextCursor: string) => {
    setCursorStack((stack) => [...stack, nextCursor]);
  };
  const goPrevious = () => {
    setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  };

  const statusLabel = (accountStatus: PatientAccountStatus): string => {
    switch (accountStatus) {
      case 'approved':
        return strings.statusApprovedLabel;
      case 'pending':
        return strings.statusPendingLabel;
      case 'declined':
        return strings.statusDeclinedLabel;
      case 'suspended':
        return strings.statusSuspendedLabel;
    }
  };

  const handleAssign = async (entry: CaseloadEntry) => {
    const clinicianId = choices[entry.patientId];
    if (!clinicianId) {
      return;
    }
    setAssignFailed(false);
    setPendingPatientId(entry.patientId);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setPendingPatientId(undefined);
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await assignPatient(
        accessToken,
        entry.patientId,
        clinicianId,
        Boolean(entry.assignedClinicianId),
      );
      if (!response.ok) {
        setAssignFailed(true);
        return;
      }
      setChoices((current) => {
        const next = { ...current };
        delete next[entry.patientId];
        return next;
      });
      await load(cursorStack.at(-1));
    } catch {
      setAssignFailed(true);
    } finally {
      setPendingPatientId(undefined);
    }
  };

  const handleSetActive = async (entry: CaseloadEntry, active: boolean) => {
    if (!active) {
      const confirmed = confirmSuspend
        ? confirmSuspend(strings.suspendConfirm)
        : globalThis.confirm?.(strings.suspendConfirm) !== false;
      if (!confirmed) {
        return;
      }
    }
    setStatusFailed(false);
    setPendingPatientId(entry.patientId);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setPendingPatientId(undefined);
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await setPatientActive(accessToken, entry.patientId, active);
      if (!response.ok) {
        setStatusFailed(true);
        return;
      }
      // Status decides the row's rank in the index, so the page it belongs
      // on can change — re-read rather than patch.
      await load(cursorStack.at(-1));
    } catch {
      setStatusFailed(true);
    } finally {
      setPendingPatientId(undefined);
    }
  };

  if (state.status === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (state.status === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (state.status === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const { counts } = state.page;

  if (state.page.items.length === 0 && cursorStack.length === 1) {
    return (
      <>
        {counts && <PatientCounts counts={counts} strings={strings} />}
        <p>{strings.emptyLabel}</p>
      </>
    );
  }

  return (
    <>
      {counts && <PatientCounts counts={counts} strings={strings} />}
      {assignFailed && <p role="alert">{strings.assignError}</p>}
      {statusFailed && <p role="alert">{strings.statusError}</p>}
      <table>
        <caption>{strings.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{strings.patientColumnLabel}</th>
            <th scope="col">{strings.statusColumnLabel}</th>
            <th scope="col">{strings.clinicianColumnLabel}</th>
            {canAssign && <th scope="col">{strings.assignColumnLabel}</th>}
            {canAssign && <th scope="col">{strings.removeColumnLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {state.page.items.map((item) => {
            const isBusy = pendingPatientId === item.patientId;
            const selectId = `assign-${item.patientId}`;
            return (
              <tr key={item.patientId}>
                <td>
                  {/* The dashboard's only way into a named patient — the
                      screen that did not exist until today. */}
                  <a href={`${recordHrefBase}?id=${encodeURIComponent(item.patientId)}`}>
                    {item.fullName || strings.openRecordLabel}
                  </a>
                </td>
                <td>{statusLabel(item.accountStatus)}</td>
                <td>{item.assignedClinicianName ?? strings.unassignedLabel}</td>
                {canAssign && (
                <td>
                  {clinicians.length === 0 ? (
                    strings.noCliniciansLabel
                  ) : (
                    <>
                      {/* The column header names the control's purpose but
                          not *whose* row it is, and a `<td>` is not a
                          label — so each control carries its own
                          accessible name, patient included, for anyone
                          navigating by form control alone. */}
                      <select
                        id={selectId}
                        aria-label={`${strings.chooseClinicianLabel} — ${item.fullName}`}
                        disabled={isBusy}
                        value={choices[item.patientId] ?? ''}
                        onChange={(event) =>
                          setChoices((current) => ({
                            ...current,
                            [item.patientId]: event.target.value,
                          }))
                        }
                      >
                        <option value="">{strings.chooseClinicianLabel}</option>
                        {clinicians.map((clinician) => (
                          <option key={clinician.id} value={clinician.id}>
                            {clinician.displayName}
                          </option>
                        ))}
                      </select>{' '}
                      <button
                        type="button"
                        aria-label={`${item.assignedClinicianId ? strings.reassignButton : strings.assignButton} — ${item.fullName}`}
                        disabled={isBusy || !choices[item.patientId]}
                        onClick={() => void handleAssign(item)}
                      >
                        {isBusy
                          ? strings.working
                          : item.assignedClinicianId
                            ? strings.reassignButton
                            : strings.assignButton}
                      </button>
                    </>
                  )}
                </td>
                )}
                {canAssign && (
                <td>
                  <button
                    type="button"
                    aria-label={`${item.accountStatus === 'suspended' ? strings.restoreButton : strings.suspendButton} — ${item.fullName}`}
                    disabled={isBusy}
                    onClick={() =>
                      void handleSetActive(item, item.accountStatus === 'suspended')
                    }
                  >
                    {isBusy
                      ? strings.working
                      : item.accountStatus === 'suspended'
                        ? strings.restoreButton
                        : strings.suspendButton}
                  </button>
                </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <nav aria-label={strings.caption}>
        <button type="button" onClick={goPrevious} disabled={cursorStack.length <= 1}>
          {strings.previousPageLabel}
        </button>
        <button
          type="button"
          onClick={() => state.page.nextCursor && goNext(state.page.nextCursor)}
          disabled={!state.page.nextCursor}
        >
          {strings.nextPageLabel}
        </button>
      </nav>
    </>
  );
}

/** The two figures above the table. A `<dl>`, not a paragraph — each is a labelled value, which is what a description list is for. */
function PatientCounts({
  counts,
  strings,
}: {
  readonly counts: CaseloadCounts;
  readonly strings: CaseloadViewStrings;
}): ReactNode {
  return (
    <dl>
      <dt>{strings.totalPatientsLabel}</dt>
      <dd>{counts.total}</dd>
      <dt>{strings.activePatientsLabel}</dt>
      <dd>{counts.active}</dd>
    </dl>
  );
}
