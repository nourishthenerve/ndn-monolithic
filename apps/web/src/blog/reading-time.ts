// 2026-09-07: roughly how long a post takes to read. The owner: *"based on
// the number of words, roughly show how long will it take to read the blog
// on blog card as well as on the blog page itself."*
//
// ## "Roughly" is the specification, and it is worth honouring literally
//
// Nobody reads at exactly 200 words a minute, and the number is useful
// anyway: what a reader wants from it is "is this a two-minute skim or a
// ten-minute sit-down", and that answer survives being 30% wrong. So this
// counts words, divides, and rounds — no adjustment for images, no
// per-locale reading speeds, no attempt to be more precise than the
// question is.
//
// 200 words a minute is the low end of the usual 200–250 range, chosen
// because it rounds *up* the estimate: a post that takes longer than
// advertised is a worse surprise than one that takes less.
//
// ## Counted from the body, after the markup is stripped
//
// A post written in the rich-text editor is HTML, and `<p class="x">` is
// not two words. `richTextToPlainText` is the same function the workshop
// cards use to flatten a description, and the same one `[slug].astro` and
// the live post page already reach for — so what is counted here is
// exactly the text a reader sees, and a post gaining a wrapper element
// does not gain a minute.
import { richTextToPlainText } from '../rich-text/render.js';

/** Words per minute. See this file's header for why the low end of the range. */
export const READING_WORDS_PER_MINUTE = 200;

/**
 * How many words a reader actually reads.
 *
 * Whitespace-separated runs, which counts "well-being" as one word and
 * "e.g." as one — both of which is what a person skimming would say too.
 */
export function wordCount(body: string): number {
  const text = richTextToPlainText(body);
  return text.length === 0 ? 0 : text.split(/\s+/).filter(Boolean).length;
}

/**
 * Minutes to read, **never zero**.
 *
 * A one-line post is "1 min read", not "0 min read": the floor is what the
 * label means (this is short) rather than a rounding artefact, and zero
 * would read as a bug on a post that plainly has words in it.
 *
 * Returns `undefined` for a body with no words at all — an image-only post,
 * or a record whose body did not reach the page. The card then shows no
 * estimate rather than claiming a minute for nothing, which is the same
 * choice `publication-date.ts` makes about a missing date.
 */
export function readingMinutes(body: string | undefined): number | undefined {
  if (!body) {
    return undefined;
  }
  const words = wordCount(body);
  if (words === 0) {
    return undefined;
  }
  return Math.max(1, Math.round(words / READING_WORDS_PER_MINUTE));
}
