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
  const metaText = (container: HTMLElement): string =>
    container.querySelector('.ndn-card-meta')?.textContent ?? '';

  it('says announced, not published, and never the workshop’s own date', () => {
    const { container } = render(
      <LiveWorkshopList
        strings={STRINGS}
        locale="en"
        initialWorkshops={[workshop('a')]}
        fetchWorkshops={() => new Promise(() => {})}
      />,
    );

    // The workshop itself is on 1 October; this line is about the day the
    // listing went up, and a card showing one bare date would be read as
    // the other one.
    expect(metaText(container)).toContain('Announced');
    expect(metaText(container)).toContain('September');
    expect(screen.queryByText(/October/)).toBeNull();
  });

  it('falls back to created_at for a workshop announced before publishedAt existed', () => {
    const { container } = render(
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

    expect(metaText(container)).toContain('July');
  });

  it('renders a card with no date rather than a broken one when the record has neither', () => {
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
    expect(screen.queryByText(/Announced/)).toBeNull();
  });
});
