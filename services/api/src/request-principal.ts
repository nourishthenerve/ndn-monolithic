// TASK 2.2.2 step 5: how a handler gets its caller, and the only way it
// can. `requirePrincipal` reads the authorizer's context and nothing else
// — there is no parameter for a header, no fallback, and no overload that
// takes claims. A handler that wanted to build a `Principal` from an
// `Authorization` header would have to write the parsing itself, in front
// of a reviewer.
//
// The context arrives as data from another Lambda, so it is validated at
// the boundary like every other input in this service (00-conventions.md:
// "Zod for runtime validation at every boundary"). That is not paranoia
// about API Gateway: it is that a shape mismatch after a future change to
// authorizer.ts must fail as `UNAUTHENTICATED` rather than as a Principal
// with `role: undefined` reaching `can()`.
import type { Principal, Role } from '@ndn/shared-types';
import { z } from 'zod';

import { AppError } from './errors.js';

/**
 * **This list is the single most dangerous place in this file to be out
 * of date, and on 2026-08-31 it was.** `Role` gained `'helpdesk'` earlier
 * the same day; this array did not, so `z.enum(ROLES)` rejected every
 * helpdesk context the authorizer produced and `requirePrincipal` threw —
 * turning a correctly-authorised helpdesk caller into a blanket **401 on
 * every route**, before any handler or `can()` check ran. Nothing caught
 * it: the array is a literal tuple, so widening `Role` was not a type
 * error anywhere, and the matrix suite exercises `can()` directly rather
 * than through this boundary.
 *
 * Fixed so it cannot recur: `satisfies` rejects a value that is not a
 * `Role`, and the exhaustiveness check below rejects a `Role` that is
 * missing from the list. Adding a role without editing this line is now
 * a compile error rather than a production 401 — and it earned its keep
 * within the hour: `'visitor'`, added later the same day, failed the
 * build here before it could reach anything.
 */
const ROLES = [
  'patient',
  'sub-clinician',
  'principal-clinician',
  'helpdesk',
  'visitor',
] as const satisfies readonly Role[];

/** Compile-time proof that `ROLES` covers `Role` — see the note above. `never` here means a role is missing. */
type UnlistedRole = Exclude<Role, (typeof ROLES)[number]>;
const _everyRoleIsListed: UnlistedRole extends never ? true : never = true;
void _everyRoleIsListed;
const ACCOUNT_STATUSES = [
  'pending',
  'approved',
  'declined',
  'suspended',
  'active',
  'deactivated',
] as const;

const principalContextSchema = z
  .object({
    subjectId: z.string().min(1),
    role: z.enum(ROLES),
    accountStatus: z.enum(ACCOUNT_STATUSES),
    patientId: z.string().min(1).optional(),
    clinicianId: z.string().min(1).optional(),
  })
  // The identity link has to match the role, here as well as in `can()`.
  // authz.ts denies a mismatched principal with `malformed-principal`, so
  // this is belt and braces — but it is the difference between a 403 that
  // says the matrix refused and a 401 that says the request never had a
  // usable identity, and those are different facts for whoever reads the
  // log afterwards.
  .refine(
    (value) =>
      value.role === 'patient'
        ? value.patientId !== undefined && value.clinicianId === undefined
        : value.clinicianId !== undefined && value.patientId === undefined,
    { message: 'identity link does not match role' },
  );

/**
 * The slice of an API Gateway v2 event this function needs. Declared
 * structurally rather than importing `APIGatewayProxyEventV2WithLambdaAuthorizer`
 * so a handler can pass its own event type without a cast, and so the
 * tests can construct one without pulling in the full event shape.
 */
export interface EventWithAuthorizerContext {
  readonly requestContext?: {
    readonly authorizer?: {
      readonly lambda?: unknown;
    };
  };
}

/**
 * @throws AppError('UNAUTHENTICATED') when the authorizer context is
 * absent or does not parse. Absent is the ordinary case for a route that
 * is not behind the authorizer at all — which is why this throws rather
 * than returning `undefined`: a handler that forgot to be protected
 * should fail loudly on its first request, not run as nobody.
 */
export function requirePrincipal(event: EventWithAuthorizerContext): Principal {
  const parsed = principalContextSchema.safeParse(event.requestContext?.authorizer?.lambda);
  if (!parsed.success) {
    // No detail from the parse error: it is derived from caller-adjacent
    // data, and an authorisation failure must not describe what would have
    // been accepted.
    throw new AppError('UNAUTHENTICATED', 'no verified principal on this request');
  }
  return parsed.data;
}

/** Non-throwing form, for the handlers whose 401 is a response rather than an exception. */
export function optionalPrincipal(event: EventWithAuthorizerContext): Principal | undefined {
  try {
    return requirePrincipal(event);
  } catch {
    return undefined;
  }
}
