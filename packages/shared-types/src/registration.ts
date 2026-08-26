// TASK 1.5.2: docs/plan/05-execution-plan.md's registration entity —
// `PK = WORKSHOP#<id>` / `SK = REGISTRATION#<id>`, same single-table design
// content.ts/testimonial.ts/workshop.ts already use
// (services/api/src/registration-repository.ts,
// infra/src/data-stack.ts). Created `pending` at Stripe Checkout Session
// creation, never deleted — `cancelled` (a `checkout.session.expired`
// webhook) is the only lifecycle exit besides `confirmed`, same
// never-delete discipline as Workshop/ContentItem/Testimonial.
import type { BaseRecord } from './types.js';

export type RegistrationStatus = 'pending' | 'confirmed' | 'cancelled';

export interface Registration extends BaseRecord<RegistrationStatus> {
  id: string;
  workshopId: string;
  /** Never 'deleted' — a checkout.session.expired webhook only ever transitions status to 'cancelled', same discipline as Workshop/ContentItem/Testimonial. */
  status: RegistrationStatus;
  /** Needed to send the registration-confirmation email (ses.ts) — unlike Testimonial's hashed submitterContactHash, this record's own purpose requires delivering to the real address. */
  attendeeEmail: string;
  /** Optional — present only when the attendee gave a number at checkout. When present, the confirmation (notifications.ts's Notifier) tries SMS first and falls back to email; when absent, it goes straight to email, same as before this field existed. */
  attendeePhone?: string;
  stripeCheckoutSessionId: string;
}
