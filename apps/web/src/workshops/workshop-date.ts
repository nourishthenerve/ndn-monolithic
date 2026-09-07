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
import { formatDateTime } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

/** When the workshop happens — never when it was announced, which is `publication-date.ts`'s job. */
export function formatWorkshopDate(dateTimeUtc: string, locale: Locale): string {
  return formatDateTime(dateTimeUtc, locale);
}
