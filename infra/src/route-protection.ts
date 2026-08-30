// TASK 2.2.2: which routes are behind the Lambda authorizer, and which are
// not — as one declaration both stacks share, rather than a property you
// would have to read sixteen call sites to establish.
//
// The shape is deliberate. Both HTTP APIs set `defaultAuthorizer`, so a
// route is **protected unless it says otherwise**: a route added without
// thinking about authentication is closed, not open. Saying otherwise
// means naming one of the two constants below at the call site *and*
// adding the route key here, and `data-stack.test.ts`/`web-stack.test.ts`
// fail if those two disagree. "A test enumerates the routes so a new
// unprotected one fails the build" (the task's own Tests line), with the
// default arranged so that forgetting fails safe rather than failing open.
import { Duration } from 'aws-cdk-lib';
import { HttpNoneAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';

/**
 * TASK 2.2.2 step 1. Five minutes is API Gateway's maximum for a REQUEST
 * authorizer and the value the plan names. It is a real window, not a
 * formality: the cache is keyed on the `Authorization` header, so a token
 * revoked by TASK 2.4.1's clinician deactivation still authorises for up
 * to this long. Stated here and in the runbook rather than left to be
 * discovered during an incident. Shortening it would put a Lambda
 * invocation on every authenticated request; lengthening it is not
 * possible.
 */
export const AUTHORIZER_RESULT_CACHE_TTL = Duration.minutes(5);

/**
 * Permanent. A blog reader, a testimonial submitter and a workshop buyer
 * have no account in this system and are not meant to acquire one; the
 * Stripe webhook authenticates with a signature, not a bearer token.
 */
export const PUBLIC_ROUTE = new HttpNoneAuthorizer();

/**
 * The routes with no caller identity at all, by design.
 *
 * `POST /stripe/webhook` is here because its authentication is a
 * signature over the request body (`stripe-webhook.ts`), not a token —
 * putting it behind a bearer authorizer would break it, and Stripe has no
 * Cognito account.
 *
 * `POST /registrations` (TASK 2.2.3) stood here by necessity — the caller
 * had no account, because an account was what they were asking for.
 * Retired by D-29 (2026-08-29): a patient no longer registers themselves
 * at all, so there is no public front door left to name. `POST /patients`
 * (patient-admin.ts) is its replacement and takes no `authorizer:`
 * override — it is not in this list, and is behind the real authorizer
 * for exactly the reason `clinician-admin.ts`'s `POST /clinicians` is:
 * the caller is a real, authenticated principal, never an anonymous one.
 *
 * The four `/auth/*` routes (TASK 2.2.4) are here by definition: they are
 * what a caller uses when they have no token yet or are giving one up.
 * Putting them behind the authorizer would make signing in require being
 * signed in. Their own gate is the PKCE state cookie, `SameSite=Lax` and
 * the `auth.webSignIn.enabled` flag.
 *
 * `GET /testimonials` joined this list in TASK 2.5.4: it always was public
 * in practice (testimonial-moderation.ts never gated the published-only
 * read), but stood on `ADMIN_TOKEN_ROUTE` at the infra level because the
 * moderation queue used to overload the same path. The queue has its own
 * path now (`GET /testimonials/pending`, behind the real authorizer below)
 * — see docs/runbooks/testimonials.md for why the two couldn't stay one
 * route once a real authorizer, which denies outright on a missing bearer
 * token, replaced the admin-token bridge that tolerated an absent one.
 */
export const PUBLIC_ROUTE_KEYS: readonly string[] = [
  'GET /auth/signin',
  'GET /content',
  'GET /health',
  'GET /testimonials',
  'GET /workshops',
  'POST /stripe/webhook',
  'POST /auth/refresh',
  'POST /auth/signout',
  'POST /auth/token',
  'POST /testimonials',
  'POST /workshops/{id}/checkout',
];

/** Every route that is *not* behind the authorizer today, for the two synth tests. */
export const UNAUTHENTICATED_ROUTE_KEYS: readonly string[] = [...PUBLIC_ROUTE_KEYS].sort();

/**
 * One authorizer construct per API — an API Gateway authorizer belongs to
 * exactly one API — over one shared Lambda. `DataStack` owns the function
 * (its lookup reads that stack's table) and hands it to `WebStack`.
 */
export function createRequestAuthorizer(handler: IFunction): HttpLambdaAuthorizer {
  return new HttpLambdaAuthorizer('RequestAuthorizer', handler, {
    authorizerName: 'ndn-request-authorizer',
    identitySource: ['$request.header.Authorization'],
    // SIMPLE selects payload format 2.0 and the `{ isAuthorized, context }`
    // response authorizer.ts returns. The IAM-policy form would let a
    // future change express "allow this method but not that one" in a
    // second place, which is exactly the scattering `can()` exists to
    // prevent.
    responseTypes: [HttpLambdaResponseType.SIMPLE],
    resultsCacheTtl: AUTHORIZER_RESULT_CACHE_TTL,
  });
}
