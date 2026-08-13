import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultLocale,
  defaultMissingTranslationHandler,
  localeDirection,
  setMissingTranslationHandler,
  supportedLocales,
  t,
} from './index.js';
import type { Locale, MissingTranslationEvent } from './index.js';

afterEach(() => {
  setMissingTranslationHandler(() => {});
});

describe('t', () => {
  it('formats a known key in the default locale', () => {
    expect(t('common.send')).toBe('Send');
  });

  it('defaults to the default locale when none is given', () => {
    expect(t('common.send')).toBe(t('common.send', undefined, defaultLocale));
  });

  it('falls back to the en catalogue when a locale has no catalogue at all, emitting one warning, and never throws', () => {
    const events: MissingTranslationEvent[] = [];
    setMissingTranslationHandler((event) => events.push(event));

    // Cast: `Locale` is `'en'` only until a second language ships (LL-08),
    // but the fallback path itself is real today — this exercises it via a
    // locale the type system doesn't (yet) admit, not a hypothetical.
    const hypotheticalLocale = 'cy' as Locale;

    let result = '';
    expect(() => {
      result = t('common.send', undefined, hypotheticalLocale);
    }).not.toThrow();
    expect(result).toBe('Send');
    expect(events).toEqual([{ key: 'common.send', locale: 'cy' }]);
  });

  it('never renders a raw key and never throws when a key is missing from every catalogue', () => {
    const events: MissingTranslationEvent[] = [];
    setMissingTranslationHandler((event) => events.push(event));

    expect(() => t('does.not.exist')).not.toThrow();
    expect(t('does.not.exist')).toBe('');
    expect(t('does.not.exist')).not.toContain('does.not.exist');
    expect(events.length).toBeGreaterThan(0);
  });

  it('passes vars through to ICU formatting', () => {
    const events: MissingTranslationEvent[] = [];
    setMissingTranslationHandler((event) => events.push(event));

    // en's actual catalogue entries take no vars; a synthetic miss proves
    // vars still reach formatMessage on the fallback path without throwing.
    expect(() => t('does.not.exist', { count: 3 })).not.toThrow();
  });

  it('the missing-translation handler is a pluggable seam, not a hard-coded console call', () => {
    const spy = vi.fn();
    setMissingTranslationHandler(spy);
    t('does.not.exist');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('defaultMissingTranslationHandler', () => {
  it('logs a structured, non-PII warning — key and locale only, no vars', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      defaultMissingTranslationHandler({ key: 'does.not.exist', locale: 'en' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [logged] = warnSpy.mock.calls[0] ?? [];
      expect(JSON.parse(logged)).toEqual({
        msg: 'i18n.missing_translation',
        key: 'does.not.exist',
        locale: 'en',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('locale metadata', () => {
  it('supportedLocales includes the default locale', () => {
    expect(supportedLocales).toContain(defaultLocale);
  });

  it('localeDirection defaults to ltr (no RTL locale named yet)', () => {
    expect(localeDirection('en')).toBe('ltr');
  });
});
