// 2026-09-14: the principal's "pending approvals" queue, above the patient
// dashboard.
//
// The owner: *"right above the Patient dashboard section, add a new section
// for those pending approvals for appointments that principal clinician need
// to approve. Basically, a table like format where he simply has to click
// Accept, Accept, Accept etc. and the rows will collapse as he clicks
// Accept."*
//
// ## Why a route of its own, and not the calendar
//
// A booking is keyed on the patient's *assigned* clinician, so a
// sub-clinician's pending request lands on that sub-clinician's calendar —
// the principal's own `GET /clinicians/me/calendar` returns only their own
// patients and never sees it. `GET /appointments/pending-approvals`
// (`services/api/src/appointment.ts`) is the practice-wide fan-out that
// gathers every waiting booking into one list; approving still rides the
// same `POST …/approve` route the calendar's day panel already uses, so a
// row accepted here and one accepted there are the identical write.
//
// ## Why it renders nothing when the queue is empty
//
// This is a queue to burn down, not a permanent panel. It mounts only for
// the principal (`account/index.astro`'s `allowRoles`), and returns `null`
// whenever there is nothing waiting — before the first fetch lands, and again
// the moment the last row is accepted — so an all-caught-up principal sees no
// empty band over their dashboard. A load that *fails* is the one non-empty
// exception: it says so in one line rather than vanishing, because a silent
// disappearance and "nothing to approve" would look identical and mean
// opposite things.
//
// ## Collapsing a row
//
// Accepting (or declining) a row fades it out and then drops it from state —
// the "collapse" the owner asked for. The write is confirmed first: the row
// is removed only once the server has said yes, so a failed approval leaves
// the row in place with its reason beside it rather than losing a booking
// that still needs a decision. The list is never re-fetched on success — the
// one row that changed is the one row removed, and re-reading the whole queue
// to learn what this component already knows would only make the burn-down
// flicker.
import { formatDateTime } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Heading } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

/** The fields this panel reads off a pending-approval row (`appointment.ts` sends more). */
export interface PendingApproval {
  readonly patientId: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
  /** Absent when the API would not disclose it — rendered as a fallback rather than a blank, so a nameless row is still actionable. */
  readonly patientName?: string;
  /** The clinician the patient is assigned to — whose session the principal is approving. */
  readonly assignedClinicianName?: string;
}

/** The one action this panel takes on a row, plus its inline outcome. */
export type ApprovalDecision = 'approve' | 'decline';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly PendingApproval[] };

export interface PendingApprovalsStrings {
  readonly heading: string;
  readonly errorLabel: string;
  readonly patientColumnLabel: string;
  readonly clinicianColumnLabel: string;
  readonly whenColumnLabel: string;
  readonly decisionColumnLabel: string;
  readonly caption: string;
  readonly acceptButton: string;
  readonly declineButton: string;
  readonly working: string;
  readonly decideFailed: string;
  /** Shown in the patient cell when the API sent no name. */
  readonly unnamedPatient: string;
  /** Shown in the clinician cell when nobody is assigned yet. */
  readonly unassignedLabel: string;
}

export interface PendingApprovalsPanelProps {
  readonly strings: PendingApprovalsStrings;
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchPending?: (accessToken: string) => Promise<Response>;
  /** Injectable for tests; defaults to `POST …/appointments/{scheduledAt}/{decision}`. */
  readonly decide?: (
    accessToken: string,
    entry: PendingApproval,
    decision: ApprovalDecision,
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

/**
 * How long the fade lasts before the row leaves the list — kept in step with
 * the CSS transition on `.ndn-approvals-row` so the state removal lands as the
 * fade finishes rather than snapping the row away mid-animation or leaving a
 * ghost after it.
 */
const ROW_COLLAPSE_MS = 220;

function defaultFetchPending(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/appointments/pending-approvals`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultDecide(
  accessToken: string,
  entry: PendingApproval,
  decision: ApprovalDecision,
): Promise<Response> {
  // The appointment's id in a path is its `scheduledAt`, the same `{apptId}`
  // segment the calendar's own decide call uses — not the composite a *call*
  // is identified by.
  return fetch(
    `${contentApiUrl}/patients/${encodeURIComponent(entry.patientId)}/appointments/${encodeURIComponent(entry.scheduledAt)}/${decision}`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
}

/** Each row's identity — patient plus instant, the same composite the calendar keys a row on. */
function rowKey(entry: PendingApproval): string {
  return `${entry.patientId}#${entry.scheduledAt}`;
}

export function PendingApprovalsPanel({
  strings,
  locale,
  client = defaultClient,
  fetchPending = defaultFetchPending,
  decide = defaultDecide,
}: PendingApprovalsPanelProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  /** Keyed by row — `busy` while its write is in flight, `failed` if it came back not-ok. */
  const [deciding, setDeciding] = useState<Record<string, 'busy' | 'failed'>>({});
  /** Rows mid-fade: still in `items`, drawn with the collapsing class, dropped once the fade ends. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());

  const load = useCallback(async () => {
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await fetchPending(accessToken);
      if (response.status === 401 || response.status === 403) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly PendingApproval[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchPending]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDecide = async (entry: PendingApproval, decision: ApprovalDecision) => {
    const key = rowKey(entry);
    setDeciding((current) => ({ ...current, [key]: 'busy' }));
    const accessToken = await client.authorization();
    if (!accessToken) {
      setDeciding((current) => ({ ...current, [key]: 'failed' }));
      return;
    }
    try {
      const response = await decide(accessToken, entry, decision);
      if (!response.ok) {
        // A 403 (not the principal) and a 409 (already decided elsewhere)
        // land here together: both mean "this row is not yours to change
        // now", and the honest thing is to say the decision did not save
        // rather than to collapse a row nothing happened to.
        setDeciding((current) => ({ ...current, [key]: 'failed' }));
        return;
      }
      // Confirmed — collapse it. Clear any stale `failed` on the same key,
      // start the fade, and drop the row from state as the fade ends.
      setDeciding((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setRemoving((current) => new Set(current).add(key));
      globalThis.setTimeout(() => {
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
        setState((current) =>
          current.status === 'ready'
            ? { status: 'ready', items: current.items.filter((item) => rowKey(item) !== key) }
            : current,
        );
      }, ROW_COLLAPSE_MS);
    } catch {
      setDeciding((current) => ({ ...current, [key]: 'failed' }));
    }
  };

  // Nothing before the first fetch lands, and nothing once the queue is empty
  // — the panel exists only while there is something to act on. A refusal is
  // silent too: a non-principal never reaches this mount, and one whose token
  // expired mid-visit has a whole page telling them so. Only a genuine load
  // failure speaks up.
  if (state.status === 'loading' || state.status === 'forbidden') {
    return null;
  }
  if (state.status === 'error') {
    return (
      <section className="ndn-record-area" aria-labelledby="pending-approvals-heading">
        <Heading level={2} id="pending-approvals-heading">
          {strings.heading}
        </Heading>
        <p role="alert">{strings.errorLabel}</p>
      </section>
    );
  }
  if (state.items.length === 0) {
    return null;
  }

  return (
    <section className="ndn-record-area" aria-labelledby="pending-approvals-heading">
      <Heading level={2} id="pending-approvals-heading">
        {strings.heading}
      </Heading>
      <div className="ndn-approvals">
        {/* A row carries two names, a time and two buttons — more than fits a
            phone at a readable size, so the table scrolls inside its own
            container rather than forcing the whole page sideways, exactly as
            the caseload table beneath it does. */}
        <div className="ndn-approvals-scroll">
          <table className="ndn-approvals-table">
            <caption className="ndn-approvals-caption">{strings.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{strings.patientColumnLabel}</th>
                <th scope="col">{strings.clinicianColumnLabel}</th>
                <th scope="col">{strings.whenColumnLabel}</th>
                <th scope="col">{strings.decisionColumnLabel}</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((entry) => {
                const key = rowKey(entry);
                const isBusy = deciding[key] === 'busy';
                const failed = deciding[key] === 'failed';
                const isRemoving = removing.has(key);
                return (
                  <tr
                    key={key}
                    className={`ndn-approvals-row${isRemoving ? ' ndn-approvals-row--removing' : ''}`}
                  >
                    <td>{entry.patientName || strings.unnamedPatient}</td>
                    <td>
                      {entry.assignedClinicianName ?? (
                        <span className="ndn-approvals-unassigned">{strings.unassignedLabel}</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={entry.scheduledAt}>
                        {formatDateTime(entry.scheduledAt, locale)}
                      </time>
                    </td>
                    <td className="ndn-approvals-actions">
                      <button
                        type="button"
                        className="ndn-approvals-button ndn-approvals-button--accept"
                        aria-label={`${strings.acceptButton} — ${entry.patientName || strings.unnamedPatient}`}
                        disabled={isBusy || isRemoving}
                        onClick={() => void handleDecide(entry, 'approve')}
                      >
                        {isBusy ? strings.working : strings.acceptButton}
                      </button>
                      <button
                        type="button"
                        className="ndn-approvals-button"
                        aria-label={`${strings.declineButton} — ${entry.patientName || strings.unnamedPatient}`}
                        disabled={isBusy || isRemoving}
                        onClick={() => void handleDecide(entry, 'decline')}
                      >
                        {strings.declineButton}
                      </button>
                      {failed && <span role="alert">{strings.decideFailed}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
