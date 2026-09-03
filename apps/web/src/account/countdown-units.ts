// 2026-09-03: the unit words `formatCountdown` needs, in one place.
//
// `join-window.ts` is pure arithmetic and deliberately has no locale — it
// takes its words as an argument. Three components now render the same
// countdown, so this is where they agree on which words, rather than each
// spelling out the same seven `t()` calls.
import { t } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

export function countdownUnits(locale: Locale) {
  return {
    day: t('countdown.day', undefined, locale),
    days: t('countdown.days', undefined, locale),
    hour: t('countdown.hour', undefined, locale),
    hours: t('countdown.hours', undefined, locale),
    minute: t('countdown.minute', undefined, locale),
    minutes: t('countdown.minutes', undefined, locale),
    and: t('countdown.and', undefined, locale),
  };
}
