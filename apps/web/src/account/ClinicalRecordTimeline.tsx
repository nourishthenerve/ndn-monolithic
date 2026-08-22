// TASK 3.2.2 step 3: a read-only diagnosis/care-plan timeline for the
// signed-in patient, added to `patient.astro` alongside `PatientProfile`.
// Same posture as `PatientProfile.tsx`/`CaseloadView.tsx`: rendered only
// inside `RequireAuth`, so a `403` here is an ordinary, expected outcome
// (the server-side `can()` check in `clinical-record.ts` is the real
// boundary), not an error.
//
// Rendered from exactly what `GET /patients/me/{diagnosis,care-plan}`
// already returned — every `private{}` key already stripped server-side
// for a patient caller (`projection.ts`). This component never filters a
// fuller payload client-side; that is the "allow-then-hide" anti-pattern
// `private-field-boundary.md` warns against, and there is nothing on
// `ClinicalRecordEntry` for a client-side filter to even remove.
//
// One component, two instantiations (`kind: 'diagnosis' | 'care-plan'`) —
// the same "one shape, two key prefixes" choice the backend already makes
// (`clinical-record-repository.ts`), not two near-identical components.
import { Heading } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export type ClinicalRecordKind = 'diagnosis' | 'care-plan';

export interface ClinicalRecordEntry {
  readonly version: number;
  readonly visible: { readonly summary: string };
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly ClinicalRecordEntry[] };

export interface ClinicalRecordTimelineStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  /** Prefixes each entry's version number — rendered as `"{versionLabel} {n}"`, never ICU-interpolated (a plain label keeps this component's props JSON-serialisable across the Astro island boundary). */
  readonly versionLabel: string;
}

export interface ClinicalRecordTimelineProps {
  readonly kind: ClinicalRecordKind;
  readonly strings: ClinicalRecordTimelineStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchHistory?: (kind: ClinicalRecordKind, accessToken: string) => Promise<Response>;
}

const defaultClient = createSessionClient();

// `/patients/me/{kind}` rather than a real id — the identical reason
// `PatientProfile.tsx`'s own header gives for `/patients/me`: this
// component has no way to know its own patient id, so the server resolves
// `me` from the verified principal instead (`clinical-record.ts`).
function defaultFetchHistory(kind: ClinicalRecordKind, accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/${kind}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function ClinicalRecordTimeline({
  kind,
  strings,
  client = defaultClient,
  fetchHistory = defaultFetchHistory,
}: ClinicalRecordTimelineProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await fetchHistory(kind, accessToken);
      if (response.status === 403 || response.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly ClinicalRecordEntry[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchHistory, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const headingId = `clinical-record-timeline-${kind}`;

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

  return (
    <section aria-labelledby={headingId}>
      <Heading level={2} id={headingId}>
        {strings.heading}
      </Heading>
      {state.items.length === 0 ? (
        <p>{strings.emptyLabel}</p>
      ) : (
        <ol>
          {state.items.map((item) => (
            <li key={item.version}>
              <Heading level={3}>
                {strings.versionLabel} {item.version}
              </Heading>
              <p>{item.visible.summary}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
