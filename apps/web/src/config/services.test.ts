import { t } from '@ndn/i18n';
import { describe, expect, it } from 'vitest';

import { serviceConfigSchema, services } from './services.js';

// 2026-09-06: the homepage renders one card per entry here, and a card
// whose heading resolves to `''` is what a missing catalogue entry looks
// like on screen — `t()` never throws and never renders the raw key. So the
// check that matters is not "the array has entries" but "every entry's two
// keys actually resolve".
describe('services config', () => {
  it('offers at least one service', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  it('every entry resolves to real copy in the default locale', () => {
    for (const entry of services) {
      expect(t(entry.titleKey), `${entry.id} has no title`).not.toBe('');
      expect(t(entry.bodyKey), `${entry.id} has no body`).not.toBe('');
    }
  });

  it('ids are unique — two cards sharing one would silently collapse a service', () => {
    expect(new Set(services.map((entry) => entry.id)).size).toBe(services.length);
  });

  it('the schema rejects an id that would address the wrong catalogue namespace', () => {
    expect(
      serviceConfigSchema.safeParse({
        id: 'speech.therapy',
        titleKey: 'services.item.speech.therapy.title',
        bodyKey: 'services.item.speech.therapy.body',
      }).success,
    ).toBe(false);
  });

  it('the schema rejects a malformed entry — the guard, not just a TS type', () => {
    expect(serviceConfigSchema.safeParse({ id: 'speech', bodyKey: 'x' }).success).toBe(false);
  });
});
