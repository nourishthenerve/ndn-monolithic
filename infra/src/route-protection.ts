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
 * **Temporary, and this is the register of it.** Each of these stands
 * behind `services/api/src/admin-auth.ts`'s single shared bearer secret —
 * no user identity, no session, no scopes. TASK 2.5.4 retires that by
 * moving them onto this authorizer and `can()`.
 *
 * Every route marked with this is one whose audit rows say `admin-token`
 * where they should say a person (TASK 2.1.3's `actorRole`), so the size
 * of `ADMIN_TOKEN_ROUTE_KEYS` below is the size of that debt, countable.
 */
export const ADMIN_TOKEN_ROUTE = new HttpNoneAuthorizer();

/**
 * The four routes with no caller identity at all, by design.
 *
 * `POST /stripe/webhook` is here because its authentication is a
 * signature over the request body (`stripe-webhook.ts`), not a token —
 * putting it behind a bearer authorizer would break it, and Stripe has no
 * Cognito account.
 *
 * `POST /registrations` (TASK 2.2.3) is here by necessity: the caller has
 * no account, because an account is what they are asking for. Turnstile
 * and a per-IP rate limit are its gate, and its flag is default-off until
 * TASK 2.5.1 can approve anyone.
 *
 * The four `/auth/*` routes (TASK 2.2.4) are here by definition: they are
 * what a caller uses when they have no token yet or are giving one up.
 * Putting them behind the authorizer would make signing in require being
 * signed in. Their own gate is the PKCE state cookie, `SameSite=Lax` and
 * the `auth.webSignIn.enabled` flag.
 */
export const PUBLIC_ROUTE_KEYS: readonly string[] = [
  'GET /auth/signin',
  'GET /content',
  'GET /health',
  'GET /workshops',
  'POST /contact',
  'POST /stripe/webhook',
  'POST /auth/refresh',
  'POST /auth/signout',
  'POST /auth/token',
  'POST /registrations',
  'POST /testimonials',
  'POST /workshops/{id}/checkout',
];

/**
 * TASK 2.5.4's work list, as data. Its own step 4 names four *functions*
 * — content authoring, workshop authoring, testimonial moderation and
 * media upload — which is thirteen routes, **and misses `GET /audit`**:
 * TASK 2.1.3 added that endpoint after Phase 2 was elaborated, and put it
 * behind the same shared secret with an explicit "TASK 2.2.2 replaces
 * `resolvePrincipal`" note in audit-read-handler.ts. It is listed here so
 * 2.5.4 finds it by reading this file rather than by remembering.
 */
export const ADMIN_TOKEN_ROUTE_KEYS: readonly string[] = [
  'GET /audit',
  'GET /testimonials',
  'PATCH /content/{id}',
  'PATCH /workshops/{id}',
  'POST /content',
  'POST /content/{id}/publish',
  'POST /content/{id}/unpublish',
  'POST /testimonials/{id}/publish',
  'POST /testimonials/{id}/reject',
  'POST /workshops',
  'POST /workshops/{id}/cancel',
  'POST /workshops/{id}/publish',
  'POST /workshops/media-upload-url',
];

/** Every route that is *not* behind the authorizer today, for the two synth tests. */
export const UNAUTHENTICATED_ROUTE_KEYS: readonly string[] = [
  ...PUBLIC_ROUTE_KEYS,
  ...ADMIN_TOKEN_ROUTE_KEYS,
].sort();

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
