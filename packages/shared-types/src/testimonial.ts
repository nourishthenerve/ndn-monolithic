// TASK 1.4.2: docs/plan/05-execution-plan.md's testimonial entity —
// `PK = TESTIMONIAL#<id>` / `SK = META` in the same single-table design
// content.ts already uses (services/api/src/testimonial-repository.ts,
// infra/src/data-stack.ts) — same table, no new resource type.
import type { Locale } from '@ndn/i18n';

import type { BaseRecord } from './types.js';

export type TestimonialStatus = 'pending_review' | 'published' | 'rejected';

export interface TestimonialConsent {
  readonly textVersion: string;
  readonly consentedAt: string;
  /** Hash of the submitter's contact detail — never the raw address (see testimonial-submission-handler.ts). */
  readonly submitterContactHash: string;
}

export interface TestimonialAttribution {
  readonly display: 'full' | 'firstNameOnly' | 'anonymous';
  readonly name?: string;
}

export interface Testimonial extends BaseRecord<TestimonialStatus> {
  id: string;
  /** Never 'deleted' — reject (TASK 1.4.2) only ever transitions status, same discipline as ContentItem. */
  status: TestimonialStatus;
  quote: Record<Locale, string>;
  attribution: TestimonialAttribution;
  /**
   * Stamped once at submission (testimonial-repository.ts's `submit`) and
   * never mutated afterwards — TestimonialStore.update rejects any write
   * that changes it, mirroring 0.3.3's versioned-record guarantee.
   */
  readonly consent: TestimonialConsent;
}
