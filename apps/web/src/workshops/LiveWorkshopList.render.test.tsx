// @vitest-environment jsdom
//
// 2026-09-06: `LiveWorkshopList.test.ts` covers this component's pure
// helpers — which link shape a workshop gets, and the interpolated poster
// alt text. This file is the rendered half, added for the homepage's
// "next three" strip: a `limit` that must be applied *after* the
// reconciliation, and a heading level the surrounding page chooses.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveWorkshopList } from './LiveWorkshopList.js';
import type { LiveWorkshop } from './LiveWorkshopList.js';

afterEach(cleanup);

const STRINGS = {
  empty: 'No workshops yet.',
  viewDetails: 'View details',
  posterAltTemplate: 'Poster for {title}',
  publishedOnTemplate: 'Announced {date}',
  happeningOnTemplate: 'Happening {date}',
};

function workshop(id: string): LiveWorkshop {
  return {
    id,
    dateTimeUtc: '2026-10-01T10:00:00.000Z',
    publishedAt: '2026-09-03T09:00:00.000Z',
    details: { en: { title: `${id} title`, description: `${id} description` } },
  };
}

const built = [workshop('a'), workshop('b'), workshop('c'), workshop('d')];

describe('the homepage strip', () => {
  it('shows only the first `limit` workshops', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={built}
        limit={3}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );
    expect(screen.getAllByRole('link', { name: 'View details' })).toHaveLength(3);
    expect(screen.queryByText('d title')).toBeNull();
  });

  it('still shows a workshop published since the build, rather than trimming the seed first', async () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={built}
        limit={3}
        fetchWorkshops={() => Promise.resolve([workshop('brand-new'), ...built])}
      />,
    );
    expect(await screen.findByText('brand-new title')).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'View details' })).toHaveLength(3);
  });

  it('is unlimited when no limit is given — the /workshops listing is unchanged', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={built}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );
    expect(screen.getAllByRole('link', { name: 'View details' })).toHaveLength(4);
  });

  it('renders workshop titles at the level the page asks for', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[workshop('a')]}
        headingLevel={3}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByRole('heading', { name: 'a title', level: 3 })).toBeDefined();
  });

  it('defaults to level 2 — the listing page, where the page title is the h1', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[workshop('a')]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByRole('heading', { name: 'a title', level: 2 })).toBeDefined();
  });
});

// 2026-09-07: the announcement date on a workshop card.
describe('the announcement date', () => {
  /** The announcement line specifically — the card carries the workshop's own date above it. */
  const announcedText = (): string => screen.queryByText(/^Announced/)?.textContent ?? '';

  it('says announced, and says it about the announcement rather than the workshop', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[workshop('a')]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    // The workshop is in October and was announced in September. Both are
    // on the card (2026-09-07), so what matters is that each date is
    // attached to its own label rather than merely present somewhere.
    const announced = screen.getByText(/^Announced/);
    expect(announced.textContent).toContain('September');
    expect(announced.textContent).not.toContain('October');
  });

  it('falls back to created_at for a workshop announced before publishedAt existed', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[
          {
            id: 'legacy',
            dateTimeUtc: '2026-10-01T10:00:00.000Z',
            created_at: '2026-07-04T09:00:00.000Z',
            details: { en: { title: 'legacy title', description: 'legacy description' } },
          },
        ]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    expect(announcedText()).toContain('July');
  });

  it('drops the announcement line, and only that line, when the record carries neither timestamp', () => {
    render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[
          {
            id: 'dateless',
            dateTimeUtc: '2026-10-01T10:00:00.000Z',
            details: { en: { title: 'dateless title', description: 'x' } },
          },
        ]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    expect(screen.getByText('dateless title')).toBeDefined();
    expect(screen.queryByText(/^Announced/)).toBeNull();
    // The workshop's own date is not optional and does not go with it.
    expect(screen.getByText(/^Happening/)).toBeDefined();
  });
});

// 2026-09-07: the owner, on the first cut of the card: *"For workshop cards
// show when the workshop is actually happening."* The announcement date
// alone left the listing silent about the one fact someone reading it is
// looking for.
describe('the workshop’s own date', () => {
  it('is on the card, ahead of the announcement date', () => {
    const { container } = render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[workshop('a')]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    const meta = [...container.querySelectorAll('.ndn-card-meta')].map(
      (node) => node.textContent ?? '',
    );
    expect(meta).toHaveLength(2);
    expect(meta[0]).toContain('Happening');
    expect(meta[0]).toContain('October');
    expect(meta[1]).toContain('Announced');
  });

  it('names the time zone, so an online workshop cannot be read an hour out', () => {
    const { container } = render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[workshop('a')]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    // The stored instant is UTC and every reader's browser renders it in
    // their own zone — `@ndn/i18n`'s `formatDateTime` is what labels it.
    expect(container.querySelector('.ndn-card-meta')?.textContent).toMatch(/(GMT|UTC)/);
  });

  it('shows the workshop date even on a card with no announcement date', () => {
    // `dateTimeUtc` is required on the record; `publishedAt`/`created_at`
    // are not, so the two lines fail independently.
    const { container } = render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[
          {
            id: 'dateless',
            dateTimeUtc: '2026-10-01T10:00:00.000Z',
            details: { en: { title: 'dateless title', description: 'x' } },
          },
        ]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    const meta = [...container.querySelectorAll('.ndn-card-meta')].map(
      (node) => node.textContent ?? '',
    );
    expect(meta).toHaveLength(1);
    expect(meta[0]).toContain('Happening');
  });
});
