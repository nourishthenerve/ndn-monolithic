// TASK 1.5.2 (ADR-0010): idempotent Stripe webhook handling —
// `checkout.session.completed` confirms a registration and sends the
// confirmation email; `checkout.session.expired` releases its capacity
// reservation. Kept deliberately SDK-free and HTTP-free, same shape as
// contact-form.ts/stripe-checkout.ts: signature verification is injected
// (`verifySignature`), so this file never imports the real `stripe`
// package and no test in this repo ever reaches Stripe's real API.
// stripe-webhook-handler.ts is the HTTP boundary: it extracts the raw
// request body/`stripe-signature` header from the Lambda event (signature
// verification needs the *literal* raw body, before any JSON parsing —
// this is why `verifySignature` takes a string, not a parsed object),
// resolves the real Stripe secrets, and maps `{ statusCode }` back into a
// Lambda proxy response.
import type { RegistrationRepository } from './registration-repository.js';
import type { RegistrationEmailSender } from './ses.js';
import type { WorkshopRepository } from './workshop-repository.js';

/**
 * A narrow, structural slice of Stripe's real `Stripe.Event` shape — only
 * the fields this handler ever reads. `data.object` covers exactly what a
 * `checkout.session.*` event carries (`Stripe.Checkout.Session`); other
 * event types are ignored by `createStripeWebhookHandler` before either
 * field is read.
 */
export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly object: {
      readonly client_reference_id?: string | null;
      readonly metadata?: Record<string, string> | null;
    };
  };
}

/**
 * Verifies the Stripe signature and parses the raw body into a `StripeEvent`
 * — throws (or rejects) on an invalid/unverifiable signature. Async because
 * the real implementation (stripe-webhook-handler.ts) needs an SSM-resolved
 * secret and a real `stripe` client before it can verify anything; the one
 * Stripe SDK call this file ever needs, injected so no test calls the real
 * Stripe API.
 */
export type VerifyStripeSignature = (
  rawBody: string,
  signatureHeader: string,
) => Promise<StripeEvent>;

export interface WebhookEventStore {
  /**
   * Atomically records that `eventId` has been seen. Returns `true` the
   * first time (the caller should process the event) and `false` on every
   * subsequent call with the same id (the caller should skip it without
   * reprocessing) — same "conditional write, no read-then-write gap" shape
   * as 0.5.3's SpendCounterStore/registration-repository.ts's
   * WorkshopCapacityStore.
   */
  tryClaim(eventId: string): Promise<boolean>;
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly seen = new Set<string>();

  async tryClaim(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) {
      return false;
    }
    this.seen.add(eventId);
    return true;
  }
}

const REGISTRATION_CLIENT_REFERENCE_PREFIX = 'REGISTRATION#';

export interface WebhookDeps {
  readonly verifySignature: VerifyStripeSignature;
  readonly eventStore: WebhookEventStore;
  readonly workshops: WorkshopRepository;
  readonly registrations: RegistrationRepository;
  readonly sendConfirmationEmail: RegistrationEmailSender;
}

export function createStripeWebhookHandler(
  deps: WebhookDeps,
): (rawBody: string, signatureHeader: string) => Promise<{ statusCode: 200 | 400 }> {
  return async (rawBody, signatureHeader) => {
    let event: StripeEvent;
    try {
      event = await deps.verifySignature(rawBody, signatureHeader);
    } catch {
      // An invalid/unverifiable signature mutates nothing — checked before
      // the idempotency store or any repository is ever touched.
      return { statusCode: 400 };
    }

    // Idempotency gate, before any state mutation: a re-delivered webhook
    // (Stripe retries on a non-2xx, or can simply redeliver) carries the
    // same event.id and is short-circuited here.
    const isFirstDelivery = await deps.eventStore.tryClaim(event.id);
    if (!isFirstDelivery) {
      return { statusCode: 200 };
    }

    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.expired') {
      // An event type this handler doesn't act on — 200 (not an error;
      // Stripe's own recommendation for unhandled event types).
      return { statusCode: 200 };
    }

    const object = event.data.object;
    const workshopId =
      typeof object.metadata?.workshopId === 'string' ? object.metadata.workshopId : undefined;
    const clientReferenceId = object.client_reference_id ?? undefined;
    if (!workshopId || !clientReferenceId?.startsWith(REGISTRATION_CLIENT_REFERENCE_PREFIX)) {
      // Not a session this handler created (missing/malformed
      // metadata/client_reference_id) — nothing to do.
      return { statusCode: 200 };
    }
    const registrationId = clientReferenceId.slice(REGISTRATION_CLIENT_REFERENCE_PREFIX.length);

    if (event.type === 'checkout.session.completed') {
      const registration = await deps.registrations.confirm(
        'stripe-webhook',
        workshopId,
        registrationId,
      );
      if (registration.status === 'confirmed') {
        const workshop = await deps.workshops.findById(workshopId);
        const workshopTitle = workshop
          ? (Object.values(workshop.details)[0]?.title ?? workshop.id)
          : workshopId;
        await deps.sendConfirmationEmail({
          to: registration.attendeeEmail,
          workshopTitle,
          dateTimeUtc: workshop?.dateTimeUtc ?? '',
        });
      }
    } else {
      await deps.registrations.cancel('stripe-webhook', workshopId, registrationId);
    }

    return { statusCode: 200 };
  };
}
