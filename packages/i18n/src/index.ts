// TASK 1.1.2: catalogue-based i18n per ADR-0012/D-04 — English only at launch,
// but every seam (Locale union, direction lookup, fallback path) is shaped for
// N languages so a second locale is additive routing/catalogue work later, not
// a rewrite.

import { formatMessage } from './format.js';
import type { MessageVars } from './format.js';
import en from './locales/en.json' with { type: 'json' };

// TASK 2.3.1: the notification template registry — re-exported from the
// package root so services/api imports it the same way it imports `t()`,
// rather than reaching into a subpath this package's `exports` map doesn't
// declare.
export * from './notifications/index.js';

export type Locale = 'en'; // extended additively when a language is named (LL-08)

export const defaultLocale: Locale = 'en';

export const supportedLocales: readonly Locale[] = ['en'];

type MessageCatalogue = Record<string, string>;

// Keyed by plain `string`, not the narrower `Locale` union, so the
// locale-entirely-missing fallback path below is a real lookup miss today —
// exercised in index.test.ts — not just a theoretical branch that only
// becomes reachable once a second language ships.
const catalogues: Record<string, MessageCatalogue> = { en };

// Extended additively alongside `Locale` itself — empty until an RTL
// language is actually named, per D-04's "RTL-safe primitives from day one"
// (the primitives must be ready; no locale needs them yet).
const rtlLocales = new Set<string>([]);

/** `dir` a `<html>`/layout element should use for this locale. Defaults `ltr`. */
export function localeDirection(locale: Locale): 'ltr' | 'rtl' {
  return rtlLocales.has(locale) ? 'rtl' : 'ltr';
}

export interface MissingTranslationEvent {
  readonly key: string;
  readonly locale: string;
}

type MissingTranslationHandler = (event: MissingTranslationEvent) => void;

/** The production default — exported so index.test.ts can prove its actual logging behaviour, not just that some handler ran. */
export function defaultMissingTranslationHandler(event: MissingTranslationEvent): void {
  // Structured and non-PII: a message key + locale code only, never the
  // surrounding `vars`, which may carry user input. `console.warn`, not
  // `console.log` (00-conventions.md bans debug-level logging, not warnings).
  console.warn(JSON.stringify({ msg: 'i18n.missing_translation', ...event }));
}

let missingTranslationHandler: MissingTranslationHandler = defaultMissingTranslationHandler;

/** Test/host seam for observing missing-translation events — production code never calls this. */
export function setMissingTranslationHandler(handler: MissingTranslationHandler): void {
  missingTranslationHandler = handler;
}

/**
 * Looks up `key` in `locale`'s catalogue and ICU-formats it with `vars`.
 * Falls back to the `en` catalogue on a miss, logging one structured warning.
 * Never throws; a key missing from every catalogue returns `''`, never the
 * raw key (which would otherwise leak an internal identifier into the UI).
 */
export function t(key: string, vars?: MessageVars, locale: Locale = defaultLocale): string {
  const template = catalogues[locale]?.[key];
  if (template !== undefined) {
    return formatMessage(template, vars, locale);
  }

  missingTranslationHandler({ key, locale });

  const fallbackTemplate = catalogues[defaultLocale]?.[key];
  if (fallbackTemplate !== undefined) {
    return formatMessage(fallbackTemplate, vars, defaultLocale);
  }

  return '';
}
