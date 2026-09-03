// 2026-09-01: "When a clinician/principal clinician edits a calender for a
// given patient it will appear as a notification on patients logged in
// dashboard." This is that dashboard panel.
//
// **The wording is here, not in the record.** `PatientNotification` carries
// a kind, a time and an actor id and no prose at all — so the sentence a
// patient reads is rendered from `@ndn/i18n` off `kind`, which is what
// makes the feed translatable without a migration and keeps text a patient
// will read out of a row that no clinician authored.
//
// A kind this bundle has no wording for falls back to a generic line
// rather than rendering an empty item: the API and the site deploy
// separately, so a newly-added kind will reach a browser running the
// previous build, and "something changed about your appointments" is a
// better answer than a blank row or a crash.
import { defaultLocale, formatDateTime } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Heading } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export interface PatientNotificationItem {
  readonly notificationId: string;
  readonly kind: string;
  readonly subjectAt?: string;
  readonly created_at: string;
  readonly read: boolean;
}

type ViewState = 'loading' | 'ready' | 'forbidden' | 'error';

export interface PatientNotificationsStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly dismissLabel: string;
  /** Keyed by `PatientNotificationKind`. A kind absent from here falls back to `genericLabel`. */
  readonly kindLabels: Readonly<Record<string, string>>;
  readonly genericLabel: string;
  readonly forLabel: string;
}

export interface PatientNotificationsProps {
  readonly strings: PatientNotificationsStrings;
  /**
   * 2026-09-03: needed for the one thing on this panel that is not a
   * pre-resolved string — the appointment time inside each notice. Without
   * it the row fell back to the *browser's* locale, which is how the same
   * appointment came to read `9/3/2026` here and `03/09/2026` on the
   * clinician's screen. Optional, defaulting to `defaultLocale`, so no
   * caller is broken by its arrival.
   */
  readonly locale?: Locale;
  readonly client?: SessionClient;
  readonly fetchNotifications?: (accessToken: string) => Promise<Response>;
  readonly markRead?: (accessToken: string, notificationId: string) => Promise<Response>;
}

/**
 * The sentence a patient reads, chosen by `kind`. **The fallback is the
 * point of extracting this**: the API and this site deploy separately, so a
 * kind added server-side reaches a browser running the previous build, and
 * "something changed about your appointments" is a better answer there than
 * a blank list item.
 */
export function notificationLabel(
  kind: string,
  kindLabels: Readonly<Record<string, string>>,
  genericLabel: string,
): string {
  // `Object.hasOwn`, not a plain index: `kind` arrives from the API, and
  // `kindLabels['toString']` on a plain object resolves to a function off
  // `Object.prototype`, which React would then try to render. An unknown
  // kind must reach the generic line, whatever it is called.
  return Object.hasOwn(kindLabels, kind) ? kindLabels[kind] as string : genericLabel;
}

/**
 * What the panel actually lists. A dashboard shows what still needs
 * attention, so a dismissed notice leaves the list — it is not deleted
 * (nothing in this codebase deletes), it is `read`, and this is the one
 * place that distinction becomes a visible one.
 */
export function unreadOf(
  items: readonly PatientNotificationItem[],
): readonly PatientNotificationItem[] {
  return items.filter((item) => !item.read);
}

const defaultClient = createSessionClient();

function defaultFetchNotifications(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/notifications`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultMarkRead(accessToken: string, notificationId: string): Promise<Response> {
  return fetch(
    `${contentApiUrl}/patients/me/notifications/${encodeURIComponent(notificationId)}/read`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
}

export function PatientNotifications({
  strings,
  locale = defaultLocale,
  client = defaultClient,
  fetchNotifications = defaultFetchNotifications,
  markRead = defaultMarkRead,
}: PatientNotificationsProps): ReactNode {
  const [state, setState] = useState<ViewState>('loading');
  const [items, setItems] = useState<readonly PatientNotificationItem[]>([]);

  const load = useCallback(async () => {
    setState('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    try {
      const response = await fetchNotifications(accessToken);
      // A clinician landing on a patient page gets a 403 here, which is an
      // ordinary outcome rather than an error — the same posture every
      // account island in this codebase takes.
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      const payload = (await response.json()) as { items?: readonly PatientNotificationItem[] };
      setItems(payload.items ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchNotifications]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = async (notificationId: string) => {
    const accessToken = await client.authorization();
    if (!accessToken) {
      return;
    }
    try {
      const response = await markRead(accessToken, notificationId);
      if (response.ok) {
        // Updated in place rather than re-fetched: the row's only change is
        // one boolean, and a reload would reorder nothing and cost a query.
        setItems((current) =>
          current.map((item) =>
            item.notificationId === notificationId ? { ...item, read: true } : item,
          ),
        );
      }
    } catch {
      // Dismissing is a convenience; a failure leaves the notice where it
      // was, which is a state the person can act on again.
    }
  };

  if (state === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (state === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (state === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const unread = unreadOf(items);

  return (
    <section aria-labelledby="patient-notifications-heading">
      <Heading level={2} id="patient-notifications-heading">
        {strings.heading}
      </Heading>
      {unread.length === 0 ? (
        <p>{strings.emptyLabel}</p>
      ) : (
        <ul>
          {unread.map((item) => (
            <li key={item.notificationId}>
              {notificationLabel(item.kind, strings.kindLabels, strings.genericLabel)}
              {item.subjectAt !== undefined && (
                <>
                  {' '}
                  {strings.forLabel}{' '}
                  {/* The stored value is UTC ISO-8601; `<time>` carries it
                      machine-readably while the text renders in the site's
                      own locale, in whatever timezone the reader is
                      actually in. `formatDateTime`, never
                      `toLocaleString()` — this feed is one of the two
                      screens the owner compared. See
                      `packages/i18n/src/datetime.ts`. */}
                  <time dateTime={item.subjectAt}>{formatDateTime(item.subjectAt, locale)}</time>
                </>
              )}{' '}
              <button type="button" onClick={() => void dismiss(item.notificationId)}>
                {strings.dismissLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
