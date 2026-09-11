// 2026-09-07: the principal choosing which published testimonials the site
// shows, and where.
//
// The owner: *"on webpage the testimonials are shown in some random manner
// I assume. I want the principal clinician to have option to cherry pick top
// rated testimonials on the landing page. However, when someone clicks Read
// more testimonials, there will be more cherry picked shown in chronological
// order with recent at the top. Principal clinician will have option to
// cherry pick these testimonials that goes on the websites landing page and
// those that go inside read more testimonial page."*
//
// ## What this screen is not
//
// It is not a moderation queue, and the difference is not cosmetic. There is
// no publish, no reject, no edit, no delete — the words, the credit and the
// consent belong to the patient who wrote them (`authz-matrix.ts`'s
// `Testimonial (own)` row denies the principal every cell of it, still).
// This screen writes one record: which ids go where. A testimonial set to
// "not shown" is still published, still the patient's, and still theirs to
// withdraw; all that changed is that the practice is not putting it on its
// own front page.
//
// The quotes are shown in full because there is no other way to pick one.
//
// ## Three placements, one radio group per testimonial
//
// Rather than two checkbox columns, because the choices are exclusive and a
// reader of the page should not have to work out what "landing page: yes,
// testimonials page: no" would mean. It means nothing — a quote on the
// homepage is always in the archive behind it — and a radio group is how you
// say that in HTML rather than in a validation rule.
//
// ## Ordering lives in its own list
//
// The landing-page order is the "top rated" half of the request, and it
// cannot be expressed in a table of radios. So the picks appear again below,
// in order, with move-up/move-down buttons: keyboard-operable, screen-reader
// legible, and no drag-and-drop to reimplement accessibly.
import { formatDate } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export type Placement = 'landing' | 'page' | 'hidden';

export interface CuratableTestimonial {
  readonly id: string;
  readonly quote: Readonly<Record<string, string>>;
  readonly attribution: {
    readonly display: 'full' | 'firstNameOnly' | 'anonymous';
    readonly name?: string;
  };
  readonly publishedAt: string;
  readonly placement: Placement;
  readonly featuredRank?: number;
}

type ViewState = 'loading' | 'ready' | 'forbidden' | 'unavailable' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export interface TestimonialCurationStrings {
  readonly heading: string;
  readonly intro: string;
  readonly loading: string;
  readonly forbidden: string;
  /** The feature flag is off — a different fact from an error, and retrying cannot help. */
  readonly unavailable: string;
  readonly error: string;
  readonly empty: string;
  /** Shown until the first selection is saved: everything published is on the site right now. */
  readonly uncuratedNotice: string;
  readonly placementLegend: string;
  readonly placementLanding: string;
  readonly placementPage: string;
  readonly placementHidden: string;
  /** `{count}` / `{max}` — how many landing-page places are taken. */
  readonly featuredCountTemplate: string;
  readonly featuredFullHint: string;
  readonly orderHeading: string;
  readonly orderIntro: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly anonymous: string;
  /** `{date}` — when the patient first published it. */
  readonly publishedTemplate: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly saveFailed: string;
  readonly unsaved: string;
}

export interface TestimonialCurationProps {
  readonly strings: TestimonialCurationStrings;
  readonly locale: Locale;
  readonly client?: SessionClient;
  readonly fetchCuration?: (accessToken: string) => Promise<Response>;
  readonly saveCuration?: (accessToken: string, body: unknown) => Promise<Response>;
}

const defaultClient = createSessionClient();

const CURATION_URL = `${contentApiUrl}/testimonials/curation`;

/** The credit line — the same rule the public page applies, so the principal picks from what a visitor will read. */
export function creditOf(item: CuratableTestimonial, anonymousLabel: string): string {
  if (item.attribution.display === 'anonymous') {
    return anonymousLabel;
  }
  return item.attribution.name ?? anonymousLabel;
}

/** This locale's text, or the first written — never hide a testimonial from the person choosing it. */
export function quoteOf(item: CuratableTestimonial, locale: string): string {
  return item.quote[locale] ?? Object.values(item.quote)[0] ?? '';
}

function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce<string>(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

/**
 * The two arrays a save sends, derived from a placement change.
 *
 * Exported and pure because this is where the rules actually are: a
 * testimonial is in at most one list, promoting appends to the end of the
 * landing page (a new pick is not silently the most important one), and
 * demoting or hiding leaves the rest of the order untouched.
 */
export function withPlacement(
  picks: { readonly featured: readonly string[]; readonly listed: readonly string[] },
  id: string,
  placement: Placement,
): { featured: string[]; listed: string[] } {
  const featured = picks.featured.filter((other) => other !== id);
  const listed = picks.listed.filter((other) => other !== id);
  if (placement === 'landing') {
    featured.push(id);
  }
  if (placement === 'page') {
    listed.push(id);
  }
  return { featured, listed };
}

/** Swaps one landing-page pick with its neighbour. Out-of-range moves are no-ops rather than errors — the buttons are disabled at the ends anyway. */
export function moved(featured: readonly string[], index: number, delta: number): string[] {
  const target = index + delta;
  if (target < 0 || target >= featured.length) {
    return [...featured];
  }
  const next = [...featured];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as string);
  return next;
}

export function TestimonialCuration({
  strings,
  locale,
  client = defaultClient,
  fetchCuration,
  saveCuration,
}: TestimonialCurationProps): ReactNode {
  const [state, setState] = useState<ViewState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [items, setItems] = useState<readonly CuratableTestimonial[]>([]);
  const [curated, setCurated] = useState(true);
  const [maxFeatured, setMaxFeatured] = useState(6);
  const [featured, setFeatured] = useState<readonly string[]>([]);
  const [listed, setListed] = useState<readonly string[]>([]);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    const request =
      fetchCuration ??
      ((token: string) => fetch(CURATION_URL, { headers: { authorization: `Bearer ${token}` } }));
    try {
      const response = await request(accessToken);
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      // 404 is the flag being off, the same distinction `TestimonialPanel`
      // draws — "not switched on" is not "try again".
      if (response.status === 404) {
        setState('unavailable');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      const payload = (await response.json()) as {
        items?: readonly CuratableTestimonial[];
        curated?: boolean;
        maxFeatured?: number;
      };
      const loaded = payload.items ?? [];
      setItems(loaded);
      setCurated(payload.curated ?? true);
      setMaxFeatured(payload.maxFeatured ?? 6);
      // The server already knows the order; rebuilding it from ranks keeps
      // one source of truth for it rather than a second sort here.
      setFeatured(
        loaded
          .filter((item) => item.placement === 'landing')
          .sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0))
          .map((item) => item.id),
      );
      setListed(loaded.filter((item) => item.placement === 'page').map((item) => item.id));
      setDirty(false);
      setSaveState('idle');
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchCuration]);

  useEffect(() => {
    void load();
  }, [load]);

  const placementOf = (id: string): Placement =>
    featured.includes(id) ? 'landing' : listed.includes(id) ? 'page' : 'hidden';

  const choose = (id: string, placement: Placement) => {
    const next = withPlacement({ featured, listed }, id, placement);
    setFeatured(next.featured);
    setListed(next.listed);
    setDirty(true);
    setSaveState('idle');
  };

  const reorder = (index: number, delta: number) => {
    setFeatured(moved(featured, index, delta));
    setDirty(true);
    setSaveState('idle');
  };

  const save = async () => {
    setSaveState('saving');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setSaveState('failed');
      return;
    }
    const request =
      saveCuration ??
      ((token: string, body: unknown) =>
        fetch(CURATION_URL, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));
    try {
      const response = await request(accessToken, { featured, listed });
      if (!response.ok) {
        setSaveState('failed');
        return;
      }
      // Re-read rather than trust the local draft: the server decides what
      // is published, and a testimonial withdrawn while this page was open
      // should disappear from it on save.
      await load();
      setSaveState('saved');
    } catch {
      setSaveState('failed');
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
    return <p role="alert">{strings.forbidden}</p>;
  }
  if (state === 'unavailable') {
    return <p role="alert">{strings.unavailable}</p>;
  }
  if (state === 'error') {
    return <p role="alert">{strings.error}</p>;
  }

  const landingFull = featured.length >= maxFeatured;

  return (
    <section aria-labelledby="testimonial-curation-heading" className="ndn-curation ndn-record-area">
      <h2 className="ndn-heading" id="testimonial-curation-heading">
        {strings.heading}
      </h2>
      <p>{strings.intro}</p>
      {!curated && (
        <p className="ndn-record-note" role="note">
          {strings.uncuratedNotice}
        </p>
      )}

      {items.length === 0 ? (
        <p>{strings.empty}</p>
      ) : (
        <>
          <p aria-live="polite">
            {fill(strings.featuredCountTemplate, { count: featured.length, max: maxFeatured })}
            {landingFull ? ` ${strings.featuredFullHint}` : ''}
          </p>

          <ul className="ndn-curation-list">
            {items.map((item) => {
              const placement = placementOf(item.id);
              return (
                <li key={item.id} className="ndn-curation-item">
                  <blockquote>
                    <p>{quoteOf(item, locale)}</p>
                    <footer>
                      {creditOf(item, strings.anonymous)}
                      {' · '}
                      {fill(strings.publishedTemplate, { date: formatDate(item.publishedAt, locale) })}
                    </footer>
                  </blockquote>
                  <fieldset>
                    <legend>{strings.placementLegend}</legend>
                    {(
                      [
                        ['landing', strings.placementLanding],
                        ['page', strings.placementPage],
                        ['hidden', strings.placementHidden],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value} htmlFor={`placement-${item.id}-${value}`}>
                        <input
                          type="radio"
                          id={`placement-${item.id}-${value}`}
                          name={`placement-${item.id}`}
                          value={value}
                          checked={placement === value}
                          // The landing page has a fixed number of places.
                          // Disabled rather than refused on save, so the
                          // limit is visible while choosing.
                          disabled={value === 'landing' && landingFull && placement !== 'landing'}
                          onChange={() => choose(item.id, value)}
                        />{' '}
                        {label}
                      </label>
                    ))}
                  </fieldset>
                </li>
              );
            })}
          </ul>

          {featured.length > 0 && (
            <section aria-labelledby="testimonial-order-heading">
              <h3 className="ndn-heading ndn-record-subheading" id="testimonial-order-heading">
                {strings.orderHeading}
              </h3>
              <p>{strings.orderIntro}</p>
              <ol className="ndn-curation-order">
                {featured.map((id, index) => {
                  const item = items.find((candidate) => candidate.id === id);
                  const label = item ? creditOf(item, strings.anonymous) : id;
                  return (
                    <li key={id}>
                      <span className="ndn-curation-order-name">{label}</span>
                      <span className="ndn-curation-order-actions">
                        <button
                          className="ndn-button ndn-button--secondary ndn-button--sm ndn-interactive"
                          type="button"
                          disabled={index === 0}
                          onClick={() => reorder(index, -1)}
                        >
                          {fill(strings.moveUp, { name: label })}
                        </button>
                        <button
                          className="ndn-button ndn-button--secondary ndn-button--sm ndn-interactive"
                          type="button"
                          disabled={index === featured.length - 1}
                          onClick={() => reorder(index, 1)}
                        >
                          {fill(strings.moveDown, { name: label })}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          <p className="ndn-panel-actions">
            <button
              className="ndn-button ndn-button--primary ndn-interactive"
              type="button"
              disabled={saveState === 'saving'}
              onClick={() => void save()}
            >
              {saveState === 'saving' ? strings.saving : strings.save}
            </button>
          </p>
          <p role="status" aria-live="polite">
            {saveState === 'saved' && strings.saved}
            {saveState === 'idle' && dirty && strings.unsaved}
          </p>
          {saveState === 'failed' && <p role="alert">{strings.saveFailed}</p>}
        </>
      )}
    </section>
  );
}
