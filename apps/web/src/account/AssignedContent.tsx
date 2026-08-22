// TASK 3.5.2 step 2: the patient's own assigned-content list. Same posture
// as `ClinicalRecordTimeline.tsx`/`CaseloadView.tsx`: rendered only inside
// `RequireAuth`, so a `403` here is an ordinary, expected outcome (the
// server-side `can()` check in `content-assignment.ts` is the real
// boundary), not an error.
//
// Links into the existing public blog article page (`/${locale}/blog/
// {contentId}`, TASK 1.3.2) — no new content-rendering surface, matching
// this task's own "Do NOT: build a second content-rendering surface
// distinct from the public blog page."
import { Card, Heading, Link } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export interface AssignedContentEntry {
  readonly contentId: string;
  readonly assignedAt: string;
  readonly title: string;
  readonly excerpt: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly AssignedContentEntry[] };

export interface AssignedContentStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly readMoreLabel: string;
}

export interface AssignedContentProps {
  readonly locale: string;
  readonly strings: AssignedContentStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchAssigned?: (accessToken: string) => Promise<Response>;
}

const defaultClient = createSessionClient();

// `/patients/me/content` rather than a real id — the identical reason
// `ClinicalRecordTimeline.tsx`'s own header gives for `/patients/me/{kind}`:
// this component has no way to know its own patient id, so the server
// resolves `me` from the verified principal instead (`content-assignment.ts`).
function defaultFetchAssigned(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/content`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function AssignedContent({
  locale,
  strings,
  client = defaultClient,
  fetchAssigned = defaultFetchAssigned,
}: AssignedContentProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await fetchAssigned(accessToken);
      if (response.status === 403 || response.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly AssignedContentEntry[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchAssigned]);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (state.items.length === 0) {
    return <p>{strings.emptyLabel}</p>;
  }

  return (
    <>
      {state.items.map((item) => (
        <Card key={item.contentId}>
          <Heading level={2}>{item.title}</Heading>
          <p>{item.excerpt}</p>
          <Link href={`/${locale}/blog/${item.contentId}`}>{strings.readMoreLabel}</Link>
        </Card>
      ))}
    </>
  );
}
