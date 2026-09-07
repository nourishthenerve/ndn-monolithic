// 2026-09-07: how a workshop's own date and time reads, everywhere.
//
// It reads in three places now — the card on the homepage and the
// `/workshops` listing (new today, at the owner's word: *"For workshop cards
// show when the workshop is actually happening"*), the prerendered detail
// page, and the `?slug=` fallback page — and until today two of them each
// built their own `Intl.DateTimeFormat` with the options written out by
// hand, kept in step by a comment asking the next person to keep them in
// step. That is exactly the drift `@ndn/i18n`'s `datetime.ts` exists to end,
// and a third copy is what made it worth ending here.
//
// **`formatDateTime`, so a workshop time reads like every other time on the
// site**: "October 1, 2026 at 11:00 AM GMT+1" — the month spelled rather
// than numbered, in the *site's* locale rather than the reader's browser's,
// and with the zone named.
//
// The zone is the one visible change from what the two pages rendered
// before, and it is a fix rather than a side effect: a workshop is a time
// people have to turn up at, the stored instant is UTC, and every reader's
// browser renders it in their own zone. Without the label, two people in two
// countries comparing what the page told them would each be certain the
// other had misread it. `datetime.ts`'s own header argues this at length for
// appointments; a workshop is the same problem with more attendees.
//
// ## 2026-09-07, second pass: three zones, not the reader's own
//
// The owner: *"on workshop i want to show when it's happening in Indian
// time, in UK time and in Middle East time."*
//
// So a workshop no longer renders one time in whatever zone the reader's
// browser is in. It renders three, each labelled, the same three for
// everybody. That is a deliberate departure from `datetime.ts`'s rule 1 and
// the reasoning is in `formatDateTimeInZone`'s own note: an appointment is
// for the one person reading it, and a workshop is announced to an audience
// in three countries at once — including to a practice member who has to
// quote the time to somebody else.
//
// **Each row carries its own date, not just a time.** A 9:00 PM UK workshop
// is the next morning in India, and three times printed under one date
// would be wrong for a third of the audience on exactly the evenings a
// workshop is most likely to run.
import { formatDateTime, formatDateTimeInZone } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

/**
 * The three regions a workshop is announced to.
 *
 * `Asia/Dubai` is "Middle East" — Gulf Standard Time, GMT+4. It is a
 * choice, and the one to revisit first if the practice's audience is
 * really in Saudi Arabia or Egypt: `Asia/Riyadh` is GMT+3, an hour behind,
 * and changing this one string is the whole change. The offset is printed
 * on every row precisely so a reader outside the named zone is not left
 * guessing which of the two the label meant.
 *
 * Ordered as the owner named them.
 */
export const WORKSHOP_TIME_ZONES = [
  { key: 'india', timeZone: 'Asia/Kolkata' },
  { key: 'uk', timeZone: 'Europe/London' },
  { key: 'middleEast', timeZone: 'Asia/Dubai' },
] as const;

export type WorkshopTimeZoneKey = (typeof WORKSHOP_TIME_ZONES)[number]['key'];

/** One row of the "when is it" list: which region, and the instant as that region reads it. */
export interface WorkshopTime {
  readonly key: WorkshopTimeZoneKey;
  readonly text: string;
}

/**
 * When the workshop happens, in each of the three regions.
 *
 * Takes the labels rather than owning them: they are catalogue strings, and
 * this module is imported by an island that cannot call `t()` at runtime.
 */
export function workshopTimesFor(
  dateTimeUtc: string,
  locale: Locale,
): readonly WorkshopTime[] {
  return WORKSHOP_TIME_ZONES.map(({ key, timeZone }) => ({
    key,
    text: formatDateTimeInZone(dateTimeUtc, locale, timeZone),
  }));
}

/**
 * When the workshop happens, in the reader's own zone.
 *
 * Kept, and still exported, though no page renders it on its own any more:
 * it is what `<time datetime>` pairs with, and it is the fallback if the
 * three-zone list is ever reconsidered. Its own tests pin that a workshop
 * time reads like every other time on the site.
 */
export function formatWorkshopDate(dateTimeUtc: string, locale: Locale): string {
  return formatDateTime(dateTimeUtc, locale);
}
