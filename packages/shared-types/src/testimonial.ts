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
