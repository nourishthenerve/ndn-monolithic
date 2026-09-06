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
};

function workshop(id: string): LiveWorkshop {
  return {
    id,
    dateTimeUtc: '2026-10-01T10:00:00.000Z',
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
