// 2026-09-02: everything the practice has written, with its status and a
// way to change it.
//
// It exists because a draft was unreachable. Content saved before the
// authoring form began publishing by default carries `status: 'draft'`,
// the public read returns published items only (by design, and correctly),
// and **nothing in the account area listed anything else** — so a post
// that had been written and saved perfectly well was invisible, with no
// way to find it, publish it, or even confirm it existed.
//
// The owner met that as "why is nothing appearing at /en/blog", which is a
// fair reading of a site where the answer was "your posts are all here,
// and there is no screen that will ever show them to you."
//
// So this is deliberately a *management* view rather than a preview: the
// thing it shows for each item is its status, because status is the whole
// question. Titles are shown to identify a row, not to read it.
import { Button, Heading } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import type { PanelHeadingLevel } from './heading-level.js';

/** Which of the two authoring surfaces a list is for. They differ only in their URLs and their title field. */
export type AuthoredKind = 'blog' | 'workshop';

export interface AuthoredItem {
  readonly id: string;
  readonly status: string;
  /** Blog posts key their text by locale under `translations`; workshops under `details`. */
  readonly translations?: Readonly<Record<string, { readonly title: string } | undefined>>;
  readonly details?: Readonly<Record<string, { readonly title: string } | undefined>>;
}

type ViewState = 'loading' | 'ready' | 'forbidden' | 'error';

export interface AuthoredContentListStrings {
  readonly heading: string;
  readonly loading: string;
  readonly forbidden: string;
  readonly error: string;
  readonly empty: string;
  readonly titleColumn: string;
  readonly statusColumn: string;
  readonly actionColumn: string;
  readonly publish: string;
  readonly unpublish: string;
  readonly working: string;
  readonly actionFailed: string;
  readonly viewLabel: string;
}

export interface AuthoredContentListProps {
  readonly strings: AuthoredContentListStrings;
  readonly kind: AuthoredKind;
  readonly locale: string;
  /**
   * 2026-09-09: the level this list's own title renders at. It was a
   * hard-coded `<h3>` on a page whose composer heading is an `<h2>` — the
   * right depth by accident, and only for the arrangement those two pages
   * happen to use. Defaults to the 2 that makes it a sibling of the
   * composer, which is what both of them want: the list is not part of the
   * form.
   */
  readonly headingLevel?: PanelHeadingLevel;
  readonly client?: SessionClient;
  readonly fetchItems?: (accessToken: string) => Promise<Response>;
  readonly setPublished?: (
    accessToken: string,
    id: string,
    published: boolean,
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

/** The authoring list — a distinct path from the public read, so the published-only boundary stays one route with one behaviour. */
function listUrl(kind: AuthoredKind): string {
  return kind === 'blog'
    ? `${contentApiUrl}/content/authored?keyword=blog`
    : `${contentApiUrl}/workshops/authored`;
}

function transitionUrl(kind: AuthoredKind, id: string, published: boolean): string {
  const base = kind === 'blog' ? 'content' : 'workshops';
  // A workshop is never "unpublished" — its own withdrawal is `cancel`,
  // which is what that side of the API calls the same idea.
  const action = published ? 'publish' : kind === 'blog' ? 'unpublish' : 'cancel';
  return `${contentApiUrl}/${base}/${encodeURIComponent(id)}/${action}`;
}

/** The title for this locale, or the id when there is no text for it — a row must always be identifiable. */
export function titleOf(item: AuthoredItem, locale: string): string {
  return item.translations?.[locale]?.title ?? item.details?.[locale]?.title ?? item.id;
}

/** Where this item lives on the public site, once it is published. */
export function publicHref(kind: AuthoredKind, id: string, locale: string): string {
  return kind === 'blog' ? `/${locale}/blog/${id}` : `/${locale}/workshops/${id}`;
}

export function AuthoredContentList({
  strings,
  kind,
  locale,
  headingLevel = 2,
  client = defaultClient,
  fetchItems,
  setPublished,
}: AuthoredContentListProps): ReactNode {
  const [state, setState] = useState<ViewState>('loading');
  const [items, setItems] = useState<readonly AuthoredItem[]>([]);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    const request =
      fetchItems ??
      ((token: string) => fetch(listUrl(kind), { headers: { authorization: `Bearer ${token}` } }));
    try {
      const response = await request(accessToken);
      // Principal-only. Anyone else reaching this page gets the same
      // ordinary refusal every other island here treats as expected.
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      const payload = (await response.json()) as { items?: readonly AuthoredItem[] };
      setItems(payload.items ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchItems, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (id: string, published: boolean) => {
    setBusyId(id);
    setFailed(false);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setBusyId(undefined);
      setFailed(true);
      return;
    }
    const request =
      setPublished ??
      ((token: string, itemId: string, next: boolean) =>
        fetch(transitionUrl(kind, itemId, next), {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        }));
    try {
      const response = await request(accessToken, id, published);
      if (!response.ok) {
        setFailed(true);
        return;
      }
      // Re-read rather than patch the row: publishing is a status
      // transition the server owns, and this list exists to show statuses
      // honestly.
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusyId(undefined);
    }
  };

  if (state === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loading}
      </p>
    );
  }
  if (state === 'forbidden') {
    return (
      <p className="ndn-authoring-alert" role="alert">
        {strings.forbidden}
      </p>
    );
  }
  if (state === 'error') {
    return (
      <p className="ndn-authoring-alert" role="alert">
        {strings.error}
      </p>
    );
  }

  return (
    // 2026-09-09: the owner: *"the your blog post table is not a nice
    // table."* It was a bare `<table>` with no class on any of it — browser
    // default borders, no padding, columns sized by content, a raw status
    // word and a raw button. Everything below is the shape
    // `caseload-styles.ts` already gives the only other table in the account
    // area, so the two read as one system rather than two tables.
    <section className="ndn-authoring-sheet" aria-labelledby={`authored-${kind}-heading`}>
      <Heading level={headingLevel} id={`authored-${kind}-heading`}>
        {strings.heading}
      </Heading>
      {failed && (
        <p className="ndn-authoring-alert" role="alert">
          {strings.actionFailed}
        </p>
      )}
      {items.length === 0 ? (
        <p className="ndn-authoring-hint">{strings.empty}</p>
      ) : (
        <div className="ndn-authored-scroll">
          {/* The caption is gone rather than restyled: it held the same
              string as the heading directly above it, which is the heading
              read twice by a screen reader. The table is named by that
              heading through the section's own `aria-labelledby`. */}
          <table className="ndn-authored-table">
            <thead>
              <tr>
                <th scope="col">{strings.titleColumn}</th>
                <th scope="col">{strings.statusColumn}</th>
                <th scope="col">{strings.actionColumn}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const published = item.status === 'published';
                return (
                  <tr key={item.id}>
                    <td>
                      {published ? (
                        <a className="ndn-authored-title" href={publicHref(kind, item.id, locale)}>
                          {titleOf(item, locale)}
                        </a>
                      ) : (
                        titleOf(item, locale)
                      )}
                    </td>
                    <td>
                      {/* A badge, the same construction the caseload's own
                          status column uses: a shape and a colour before it
                          is a word. Two states only — a content item is
                          published or it is not — so a modifier per status
                          would be a class that never varies. */}
                      <span
                        className={`ndn-authored-status ${
                          published
                            ? 'ndn-authored-status--published'
                            : 'ndn-authored-status--draft'
                        }`}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant={published ? 'secondary' : 'primary'}
                        disabled={busyId === item.id}
                        onClick={() => void toggle(item.id, !published)}
                      >
                        {busyId === item.id
                          ? strings.working
                          : published
                            ? strings.unpublish
                            : strings.publish}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
