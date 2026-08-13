// TASK 1.1.2: ICU MessageFormat compilation/formatting, isolated from index.ts's
// catalogue lookup so format.test.ts can prove plural/date/number round-tripping
// directly against hand-written templates, independent of what's in en.json.

import { IntlMessageFormat } from 'intl-messageformat';

import type { Locale } from './index.js';

export type MessageVars = Record<string, string | number>;

/**
 * A fresh `IntlMessageFormat` per call, not cached — catalogue lookups happen
 * far less often than a render loop, and caching would need invalidation once
 * a second locale's catalogue can change at runtime.
 */
export function formatMessage(
  template: string,
  vars: MessageVars | undefined,
  locale: Locale,
): string {
  const formatter = new IntlMessageFormat(template, locale);
  const result = formatter.format(vars);
  if (typeof result !== 'string') {
    // Only reached if a catalogue entry uses rich-text tag syntax, which
    // this catalogue never does — a broken template should fail loudly
    // (same "fail the build" posture as 1.1.1's contrast-ratio checker),
    // not silently degrade.
    throw new Error(`ICU template did not resolve to a plain string: "${template}"`);
  }
  return result;
}
