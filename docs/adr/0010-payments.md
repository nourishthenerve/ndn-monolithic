# ADR 0010 — Payments

**Decision:** Stripe Checkout, webhook-driven, idempotent
**Options rejected:** Direct card handling (never); PayPal
**£/mo:** £0 recurring
**Reversal cost:** Low

## Amendment, D-31 (2026-08-29) — abandoned before its first real use

**Superseded, not merely deferred.** This ADR's own low reversal cost turned out to matter for exactly this: the owner decided against any online payment or registration on the public site at all — a workshop announcement states what and when, nothing is booked or paid for through the website, and anything requiring an actual reservation (a paid place, a targeted invite, a 1:1 session) goes through WhatsApp directly, the same human-mediated channel D-29/D-30 already established elsewhere. TASK 1.5.2's own code (`stripe-checkout.ts`, `stripe-webhook.ts`, `registration-repository.ts`) is built, tested, and was never reachable from any page `apps/web` serves — it stays in place, unused, `payments.stripeCheckout.enabled` never turned on. Full reasoning: `docs/plan/01-decisions.md`'s D-31.
