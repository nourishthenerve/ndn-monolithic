import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { t } from '@ndn/i18n';
import { describe, expect, it } from 'vitest';

import { serviceConfigSchema, services } from './services.js';

// `apps/web/public/` — where Astro serves the icon files from, resolved
// relative to this test rather than the working directory so the check runs
// the same from any `vitest` invocation.
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));

// 2026-09-06: the homepage renders one tile per entry here, and a tile whose
// heading resolves to `''` is what a missing catalogue entry looks like on
// screen — `t()` never throws and never renders the raw key. So the check
// that matters is not "the array has entries" but "every entry's title
// resolves and its icon is a real file".
describe('services config', () => {
  it('offers at least one service', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  it('every entry resolves to a real title and detail in the default locale', () => {
    for (const entry of services) {
      expect(t(entry.titleKey), `${entry.id} has no title`).not.toBe('');
      expect(t(entry.detailKey), `${entry.id} has no detail`).not.toBe('');
    }
  });

  it('every entry points at an icon that actually exists in public/', () => {
    for (const entry of services) {
      // Strip the leading public-root slash before joining onto the directory.
      const file = join(publicDir, entry.icon.replace(/^\//, ''));
      expect(existsSync(file), `${entry.id} icon missing: ${entry.icon}`).toBe(true);
    }
  });

  it('ids are unique — two tiles sharing one would silently collapse a service', () => {
    expect(new Set(services.map((entry) => entry.id)).size).toBe(services.length);
  });

  it('the schema rejects an id that would address the wrong catalogue namespace', () => {
    expect(
      serviceConfigSchema.safeParse({
        id: 'speech.therapy',
        titleKey: 'services.item.speech.therapy.title',
        detailKey: 'services.item.speech.therapy.detail',
        icon: '/nourish_the_nerve_offer_neurorehabilitation.svg',
      }).success,
    ).toBe(false);
  });

  it('the schema rejects an icon that is not a public-root svg path', () => {
    expect(
      serviceConfigSchema.safeParse({
        id: 'assessment',
        titleKey: 'services.item.assessment.title',
        detailKey: 'services.item.assessment.detail',
        icon: 'nourish_the_nerve_offer_comprehensive_assessment.png',
      }).success,
    ).toBe(false);
  });

  it('the schema rejects a malformed entry — the guard, not just a TS type', () => {
    expect(serviceConfigSchema.safeParse({ id: 'speech', icon: 'x' }).success).toBe(false);
  });
});
