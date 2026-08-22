// TASK 2.2.3 step 7: the front door's own gate. Turnstile, then a per-IP
// rate limit, then Cognito `SignUp` — the same gate-in-order shape
// contact-form.ts uses, for the same reason: the rate limiter's budget is
// spent only on requests a human has already passed.
//
// **Why this endpoint exists at all**, rather than the browser calling
// Cognito's `SignUp` directly (which it could — the API is unauthenticated):
// step 7 asks for a rate limit *per source IP*, and a Cognito Lambda
// trigger cannot see one. Pre-SignUp events carry `validationData`,
// `clientMetadata` and a caller context, but no client address; the
// address is only available with the paid threat-protection tier TASK
// 2.2.1 declined. Behind API Gateway we have it for free. So registration
// goes through us, and Cognito's own `SignUp` is called server-side.
//
// It is deliberately thin: it creates a Cognito account and nothing else.
// The `PAT#` record is written by the Post-Confirmation trigger
// (post-confirmation.ts), after the patient has proved they can read the
// mailbox — a record for an address nobody verified is a record nobody
// asked for.
import { z } from 'zod';

import type { FlagReader } from './flags.js';
import type { RateLimiter } from './rate-limiter.js';
import type { TurnstileVerifier } from './turnstile.js';

export const PATIENT_REGISTRATION_FLAG = 'auth.patientRegistration.enabled';

/**
 * Three per address per hour. Registration is a once-in-a-lifetime act for
 * a real patient, so the limit exists to bound abuse rather than to shape
 * legitimate use; three leaves room for a genuine retry after a typo
 * without leaving room for a signup flood against an email-sending quota
 * (Cognito's default sender is capped at 50 messages a day — see
 * docs/runbooks/cognito-user-pools.md, which is a smaller number than most
 * abuse).
 */
export const REGISTRATION_RATE_LIMIT = 3;
export const REGISTRATION_RATE_WINDOW_MS = 60 * 60 * 1000;

export const registrationRequestSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  marketingOptIn: z.boolean(),
  turnstileToken: z.string().min(1),
});

export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

/**
 * The Cognito call, as a port. `SignUp` needs no IAM credentials and no
 * client secret (TASK 2.2.1's clients are public), so this is a plain
 * HTTPS call the handler wires; keeping it behind an interface is what
 * lets every test below run without AWS.
 */
export interface SignUpPort {
  /**
   * `subjectId` is Cognito's `UserSub`. `exists` means the address is
   * already registered — Cognito's own `UsernameExistsException`, which
   * this endpoint must not reveal (see below).
   */
  signUp(email: string): Promise<{ outcome: 'created'; subjectId: string } | { outcome: 'exists' }>;
}

/**
 * The row that carries what Cognito cannot.
 *
 * TASK 2.2.1 put **one** attribute on the patient pool — a required,
 * mutable email — and the app client can write only that. A name, a phone
 * number and a marketing preference therefore have nowhere to live inside
 * the directory, and putting them there would reopen the "no personal data
 * in Cognito" decision the two-pool design rests on.
 *
 * So they are parked here, keyed by the `sub` that `SignUp` just returned,
 * and the Post-Confirmation trigger reads them back with one keyed
 * `GetItem`. The row is short-lived by design: once the `PAT#` record
 * exists, the trigger overwrites this one with a consumed marker, so the
 * only copy of the patient's name is the one under
 * `PersonRecord.personal{}` where R-04's erasure story can reach it. That
 * overwrite is an update, not a delete — the row stays, its payload does
 * not.
 */
export interface RegistrationIntake {
  readonly fullName: string;
  readonly email: string;
  readonly phone?: string;
  readonly marketingOptIn: boolean;
}

export interface IntakeStore {
  put(subjectId: string, intake: RegistrationIntake): Promise<void>;
  take(subjectId: string): Promise<RegistrationIntake | undefined>;
}

export type RegistrationResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'blocked'; readonly reason: 'turnstile' | 'rateLimited' }
  | { readonly kind: 'disabled' };

export interface RegistrationDeps {
  readonly flags: FlagReader;
  readonly verifyTurnstile: TurnstileVerifier;
  readonly rateLimiter: RateLimiter;
  readonly signUp: SignUpPort;
  readonly intake: IntakeStore;
}

export function createRegistration(deps: RegistrationDeps) {
  return async (
    request: RegistrationRequest,
    sourceIpHash: string,
  ): Promise<RegistrationResult> => {
    // Default off, and off means "this route does not exist". The flag is
    // not a convenience: until TASK 2.5.1 can approve anyone, registering
    // would put a person into `pending` with no route out of it.
    if (!(await deps.flags.isEnabled(PATIENT_REGISTRATION_FLAG))) {
      return { kind: 'disabled' };
    }

    if (!(await deps.verifyTurnstile(request.turnstileToken))) {
      return { kind: 'blocked', reason: 'turnstile' };
    }

    // Keyed on the *hashed* address, never the address itself — the same
    // rule audit.ts's `sourceIpHash` follows, and for the same reason: an
    // IP is personal data and this key outlives the request.
    if (!(await deps.rateLimiter.tryConsume(sourceIpHash))) {
      return { kind: 'blocked', reason: 'rateLimited' };
    }

    const result = await deps.signUp.signUp(request.email);

    if (result.outcome === 'created') {
      // Written *after* the account exists, so an intake row never
      // outlives a sign-up that failed. Nothing reads it until the
      // Post-Confirmation trigger, and nothing else can: it is keyed by a
      // `sub` only Cognito could have issued.
      await deps.intake.put(result.subjectId, {
        fullName: request.fullName,
        email: request.email,
        phone: request.phone,
        marketingOptIn: request.marketingOptIn,
      });
    }

    // **`created` and `exists` return the same thing, deliberately.** A
    // response that distinguishes them turns this endpoint into an oracle
    // for "is this person registered at a neuro-rehabilitation clinic",
    // which is disclosure of exactly the kind TASK 2.2.1's
    // `preventUserExistenceErrors` exists to prevent. Cognito emails the
    // address either way; only its owner learns which happened.
    return { kind: 'accepted' };
  };
}
