// TASK 1.4.2: docs/plan/05-execution-plan.md's testimonial entity —
// `PK = TESTIMONIAL#<id>` / `SK = META` in the same single-table design
// content.ts already uses (services/api/src/testimonial-repository.ts,
// infra/src/data-stack.ts) — same table, no new resource type.
//
// **2026-09-02: rewritten around a patient author.** The owner: *"the
// testimonial page by default should be read only with all published
// testimonials by various patients. for patients, when logged in, should
// have option to upload maximum one testimonial with option to update it.
// otherwise, submit a testimonial shouldn't be available for public and
// all kinds of clinicians. Also, there is no concept of review a
// testimonial — it should go live as soon as patient submits it from his
// account."*
//
// What that replaces: an anonymous public form behind Turnstile and a rate
// limiter, writing `pending_review` rows for someone to approve. Three
// pieces of machinery — the challenge, the rate limit, and the moderation
// queue — all existing because the author was a stranger. Once the author
// is a signed-in patient, none of them has anything left to do: there is
// an account behind every submission, one record per account, and no
// review step for a rate limiter to protect.
import type { Locale } from '@ndn/i18n';

import type { BaseRecord } from './types.js';

/**
 * `'pending_review'` and `'rejected'` are **legacy, and nothing writes
 * them any more** (2026-09-02). They remain in the union because rows
 * carrying them still exist — anonymous submissions from the old public
 * form — and a narrower type would fail to parse a record that is really
 * there. Neither is publicly visible, which is where they were already,
 * and there is no longer any route that transitions out of them.
 *
 * `'withdrawn'` is new: a patient retracting their own published words.
 * Not a deletion — 00-conventions.md's no-delete rule holds here as
 * everywhere — and distinct from `'rejected'`, which meant somebody else
 * refused it.
 */
export type TestimonialStatus = 'pending_review' | 'published' | 'rejected' | 'withdrawn';

export interface TestimonialConsent {
  readonly textVersion: string;
  readonly consentedAt: string;
  /**
   * Legacy: a hash of the contact detail an anonymous submitter typed in.
   * Only ever present on pre-2026-09-02 rows. A patient-authored
   * testimonial has an account behind it, so there is nothing to hash and
   * nothing that would be learned by hashing it — `authorPatientId` is the
   * identity, and it is never public.
   */
  readonly submitterContactHash?: string;
}

export interface TestimonialAttribution {
  readonly display: 'full' | 'firstNameOnly' | 'anonymous';
  readonly name?: string;
}

/**
 * Where a published testimonial appears on the public site — the owner's
 * *"principal clinician will have option to cherry pick these testimonials
 * that goes on the websites landing page and those that go inside read more
 * testimonial page."*
 *
 * Three values rather than two booleans, because the landing page is a
 * subset of the testimonials page and never a separate set: a quote on the
 * homepage that vanished when a reader clicked "Read more testimonials"
 * would read as a bug. `'landing'` therefore means *both* surfaces.
 */
export type TestimonialPlacement = 'landing' | 'page' | 'hidden';

/**
 * The practice's picks — **one record for the whole site**, not a field on
 * each testimonial.
 *
 * That is the whole reason this type exists separately. `authz-matrix.ts`'s
 * `Testimonial (own)` row denies every clinician column, the principal's
 * included, and curation must not quietly reopen it: choosing which of a
 * patient's published words to put on the homepage is the practice's
 * decision about its own marketing, while the words, the credit and the
 * consent stay the patient's alone. Keeping the picks in a record the
 * patient does not own and the principal does means neither role can reach
 * the other's — a principal's write here cannot touch a quote, and a
 * patient's write to their own testimonial cannot promote it.
 *
 * It also removes a race: `TestimonialStore.update` overwrites the whole
 * item, so a placement field living on the testimonial would be lost by a
 * patient editing their quote at the wrong moment.
 *
 * `featured` is **ordered** — it is the landing page's order, the "top
 * rated" of the request, chosen by hand. `listed` is not: the testimonials
 * page is chronological, newest first, so any order stored here would be
 * discarded on the way out.
 */
export interface TestimonialCuration extends BaseRecord<'active'> {
  /** Testimonial ids on the landing page *and* the testimonials page, in the order the landing page shows them. */
  readonly featured: readonly string[];
  /** Testimonial ids on the testimonials page only. Order is not meaningful. */
  readonly listed: readonly string[];
}

/**
 * How many testimonials the landing page will carry. A cap rather than a
 * fixed count: the principal picks however many up to this, and picking
 * none is a legitimate (if empty-looking) choice. Six is two full rows of
 * the homepage's three-column grid — beyond that the strip stops being a
 * highlight and becomes the archive it links to.
 */
export const MAX_FEATURED_TESTIMONIALS = 6;

export interface Testimonial extends BaseRecord<TestimonialStatus> {
  /**
   * Derived from `authorPatientId` — see `testimonialIdForPatient`. This
   * is what makes "maximum one per patient" a property of the data rather
   * than a rule a handler has to remember to check: a second submission
   * addresses the same record, so it is an update whether or not anyone
   * intended it to be.
   *
   * **Never returned by the public read.** It is a function of a patient
   * id, and `testimonial-moderation.ts` projects it away along with
   * everything else the page does not render.
   */
  id: string;
  status: TestimonialStatus;
  /**
   * Who wrote it. Absent on legacy anonymous rows, which is exactly the
   * distinction that matters: a row with no author cannot be edited or
   * withdrawn by anybody, because nobody can prove it is theirs.
   *
   * Never leaves the API except to the patient themselves.
   */
  readonly authorPatientId?: string;
  quote: Record<Locale, string>;
  attribution: TestimonialAttribution;
  /**
   * Stamped at first submission and never mutated afterwards —
   * `TestimonialStore.update` rejects any write that changes it, mirroring
   * 0.3.3's versioned-record guarantee. An edit re-publishes under the
   * consent already given; withdrawing is how that consent is taken back.
   */
  readonly consent: TestimonialConsent;
}
