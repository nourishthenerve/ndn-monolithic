// TASK 2.4.1: `POST /clinicians`, `POST /clinicians/{id}/deactivate`,
// `POST /clinicians/{id}/reactivate` — SDK-free and unit-testable, the
// same split every other authoring endpoint uses (content-authoring.ts /
// clinician-admin-handler.ts wires the real AWS clients).
//
// **The first production route to use the real Lambda authorizer**
// (request-principal.ts's `requirePrincipal`) rather than the admin-token
// bridge every other admin-shaped route still stands behind until TASK
// 2.5.4 retires it. This route never used the bridge to begin with: its
// entire subject is clinician *identity*, and a real clinician principal
// has existed to authenticate as since 2.2.1/2.2.2 landed — gating it with
// a shared secret that carries no identity would make its own audit rows
// say `admin-token` for exactly the operation whose audit trail most needs
// to say *which* clinician acted.
//
// ## Amendment, D-30 (2026-08-29) — no invite email, ever
//
// This file's own header used to explain why the invite email went
// through Cognito's own `AdminCreateUser` delivery rather than the
// Notifier — that reasoning is gone, not superseded in place: D-30
// removes the invite email entirely, the same "staff-issued credentials,
// no email" pivot D-29 already made for patients. `createUser` now
// suppresses Cognito's own delivery (`MessageAction: SUPPRESS`,
// `clinician-admin-handler.ts`); this file generates a permanent
// password (`password-generator.ts`, the identical function D-29 already
// built) and completes the clinician pool's mandatory TOTP enrolment on
// the new clinician's own behalf (`AdminCreateClinicianPort.provisionTotp`,
// wired against `auth-stack.ts`'s `ClinicianAdminAuthClient`), returning
// both to the principal once, in the `POST /clinicians` response body —
// never stored beyond that response, never logged. The principal relays
// both however staff already communicate — in person, phone, WhatsApp —
// the same channel-agnostic handoff D-29 already established, now on the
// clinician side too. See `docs/plan/01-decisions.md`'s D-30 and
// `docs/plan/02-risk-register.md`'s R-17 for the trade-off this accepts.
//
// ## Amendment, D-32 (2026-08-30) — no deactivation notice, ever
//
// The deactivation notice this file's own header used to describe as
// "still goes through the Notifier, unchanged" is deleted, not darkened
// — the owner's own words, "any notification will go via whatsapp." The
// deactivate/reactivate mechanics below (`disable`/`revokeTokens`,
// `enable`, the audit row each writes) are entirely unchanged; only the
// "then tell the clinician by email" step is gone. `AdminDeactivateClinicianPort`
// no longer needs to resolve an email at all.
import type { ClinicianRole, Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { HELPDESK_GROUP, PRINCIPAL_CLINICIAN_GROUP } from './authorizer.js';
import { can } from './authz.js';
import type { ClinicianRepository } from './clinician-repository.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { extractBearerToken } from './jwt-verify.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { generatePassword } from './password-generator.js';
import { requirePrincipal } from './request-principal.js';

const CLINICIAN_ADMIN_FLAG = 'clinicians.administration.enabled';
const CLINICIAN_RESOURCE = { entityType: 'clinician-account' } as const;

/**
 * The one place a `ClinicianRole` becomes a `cognito:groups` membership.
 * `roleFor()` (authorizer.ts) reads the same two group names back off a
 * verified token, and both constants are that file's — so the record's
 * `role`, the group granted here, and the role the authorizer derives
 * cannot drift into three different opinions.
 *
 * `sub` is `undefined`, not a group name: a sub-clinician is a
 * clinician-pool token in *no* named group, which is `roleFor`'s own
 * fallback.
 */
const GROUP_FOR_CLINICIAN_ROLE: Readonly<Record<ClinicianRole, string | undefined>> = {
  principal: PRINCIPAL_CLINICIAN_GROUP,
  helpdesk: HELPDESK_GROUP,
  sub: undefined,
};

// Every request, unsampled — the lowest-volume admin surface in the
// estate (one principal, acting rarely) and the one whose own access a
// reviewer is most likely to want to reconstruct later, same reasoning
// audit-read.ts states for its own sample rate.
const CLINICIAN_ADMIN_LOG_SAMPLE_RATE = 1;

// Amendment, 2026-08-31 (D-34): `POST /clinicians/me/change-password` —
// the self-service change every clinician needs once they are the one
// signing in, not the principal setting a password for them. Deliberately
// not routed through `can()`/authz-matrix.ts: every row there governs a
// principal or clinician acting on an *entity* (a patient, an
// appointment, a colleague's account), and this acts on nothing but the
// caller's own Cognito credential — the same reason `requirePrincipal`
// alone, not the matrix, already gates `/auth/*`. The one access rule
// this needs — clinicians only, never a patient — is a role check, not a
// resource permission, so it is written as one below rather than
// stretched to fit a matrix row that would otherwise gain a column no
// other row needs. Cognito's own `ChangePassword` API is the real
// boundary regardless: it requires the caller's own current password,
// which nothing on this side of the call ever sees or could forge.
const changeOwnPasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

/**
 * `ChangePassword` is a *user* Cognito API, not an Admin* one — it takes
 * the caller's own access token as proof of an active session, not a
 * `UserPoolId`/`Username`. `accessToken` is read directly off the
 * incoming request's `Authorization` header (the handler does this, not
 * `requirePrincipal` — that function derives *identity* from the
 * authorizer's own verified context and deliberately takes no header;
 * this needs the raw token *string* for an entirely separate reason,
 * to hand back to Cognito, which re-validates it independently on
 * every call).
 */
export interface ChangeOwnPasswordPort {
  changePassword(accessToken: string, currentPassword: string, newPassword: string): Promise<void>;
}

// Amendment, 2026-08-31 — `GET /clinicians`, and a password the principal
// may choose.
//
// Both come from the same request: "an option to add or remove a
// clinicians — with which the old one will not have access to login and
// the new one will now have access after principal clinician has provided
// email and password for him."
//
//   * **The list.** Adding and removing colleagues through a UI needs a
//     UI that can *see* them — `POST /clinicians/{id}/deactivate` has
//     existed since TASK 2.4.1 with no way to discover an id to pass it,
//     and the dashboard's "reassign to…" needs the same list. Governed by
//     `read` on the row this file's other routes already use
//     (`'Clinician accounts'`, Principal-only) — no new matrix cell, the
//     doc already grants `R` there.
//   * **The password.** D-30 generates one and shows it once, which stays
//     the default and the recommendation — a generated password is longer
//     and less guessable than a chosen one, and it is the shape the
//     WhatsApp handoff was designed around. `password` is *optional*, and
//     when present it is used verbatim instead: the owner asked to set a
//     colleague's first password themselves, and Cognito's own policy
//     (auth-stack.ts) is the thing that judges it — a rejected password
//     comes back as a 400 the form can show, never a silently weakened
//     account. Nothing else changes: still `Permanent: true`, still shown
//     once, still never stored or logged on this side.
//
// "Remove" is deactivation, not deletion, and deliberately:
// `AdminDeleteUserCommand` is a banned identifier repo-wide
// (packages/eslint-plugin-no-destructive) and C-03 keeps every record
// readable. Deactivation is what the request actually asks for — "the old
// one will not have access to login" — and it is what `disable` +
// `revokeTokens` already deliver, immediately and for any live session.
const createClinicianBodySchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().min(1).max(200),
  // `'helpdesk'` (2026-08-31) — a third role in the same pool, created
  // through this same route because it is administered identically
  // (shared-types' `ClinicianRole` has the reasoning). The only thing
  // that differs is which `cognito:groups` membership it gets below.
  role: z.enum(['principal', 'sub', 'helpdesk']),
  // Bounded, not policy-checked here: Cognito owns the password policy,
  // and duplicating it in a Zod schema would be a second copy to drift.
  // The floor is Cognito's own absolute minimum, so an obviously-empty
  // field fails fast rather than costing a round trip.
  password: z.string().min(6).max(256).optional(),
});

/**
 * The Cognito call, as a port — same shape patient-admin.ts's
 * `AdminCreatePatientPort` takes, for the same reason: keeping AWS behind
 * an interface is what lets every test below run without it. Returns the
 * `sub` `AdminCreateUser` minted, so the caller can write `CLI#<sub>` —
 * see clinician-repository.ts's header for why this ordering, not the
 * reverse the task text states.
 */
export interface AdminCreateClinicianPort {
  createUser(email: string): Promise<string>;
  /**
   * Found missing live, 2026-08-28: nothing in this codebase ever called
   * `AdminAddUserToGroup`, so `authorizer.ts`'s `roleFor()` — which reads
   * `cognito:groups`, never the `CLI#` record's own `role` field — could
   * never resolve anyone to `principal-clinician`, no matter what the
   * DynamoDB record said. Called only after `repository.create()` has
   * actually accepted the row (never before — a rejected
   * `PRINCIPAL_ALREADY_EXISTS` create must not have already granted the
   * group).
   *
   * Generalised from `addToPrincipalGroup` on 2026-08-31, when a second
   * group appeared. `groupName` comes from `GROUP_FOR_CLINICIAN_ROLE`
   * below, never from a caller's string — the mapping from role to group
   * is the single fact `roleFor()` reads back, and it lives in exactly
   * one place.
   */
  addToGroup(subjectId: string, groupName: string): Promise<void>;
  /**
   * D-30: a permanent password, set once — the same `AdminSetUserPassword`
   * shape `patient-admin.ts`'s own port already uses for D-29, `Permanent:
   * true` so no `NEW_PASSWORD_REQUIRED` challenge exists for this account
   * to get stuck on.
   */
  setPassword(subjectId: string, password: string): Promise<void>;
  /**
   * D-30: completes the clinician pool's `MFA_SETUP` challenge on the new
   * clinician's own behalf when Cognito issues one, so a working TOTP
   * secret exists before Cognito ever gets a chance to email anyone
   * about it — `AdminInitiateAuth` (against `auth-stack.ts`'s
   * `ClinicianAdminAuthClient`, never the browser-facing one) →
   * `AssociateSoftwareToken` → `VerifySoftwareToken` (the one-time code
   * computed by this codebase itself, `totp.ts`, not typed in by a
   * human) → `AdminRespondToAuthChallenge` → `AdminUserGlobalSignOut`,
   * so nothing this round trip mints outlives the request that
   * triggered it. Returns the secret and an `otpauth://` URI for the
   * principal to relay — never stored beyond the API response that
   * carries it once, never logged, the same discipline
   * `patient-admin.ts`'s own generated password already follows.
   *
   * Amendment, 2026-08-31: the pool's `mfa` is `OPTIONAL`, not
   * `REQUIRED`, as of this date (auth-stack.ts) — a brand-new clinician
   * with no device enrolled yet completes sign-in outright, no
   * challenge, so there is nothing to provision. Returns `undefined` in
   * that case; the caller omits `totpSecret`/`otpauthUri` from the
   * response rather than treating their absence as an error.
   */
  provisionTotp(
    subjectId: string,
    email: string,
    password: string,
  ): Promise<{ secret: string; otpauthUri: string } | undefined>;
}

/** Both calls step 4 requires, as one port — deactivation is never "just" the disable. */
export interface AdminDeactivateClinicianPort {
  disable(subjectId: string): Promise<void>;
  revokeTokens(subjectId: string): Promise<void>;
}

export interface AdminReactivateClinicianPort {
  enable(subjectId: string): Promise<void>;
}

export interface ClinicianAdminDeps {
  readonly repository: ClinicianRepository;
  readonly flags: FlagReader;
  readonly createClinicianUser: AdminCreateClinicianPort;
  readonly deactivateClinicianUser: AdminDeactivateClinicianPort;
  readonly reactivateClinicianUser: AdminReactivateClinicianPort;
  readonly changeOwnPassword: ChangeOwnPasswordPort;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Overridable for test determinism only — `patient-admin.ts`'s own identical seam for D-29. */
  readonly generatePassword?: () => string;
}

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createClinicianAdminHandler(
  deps: ClinicianAdminDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CLINICIAN_ADMIN_LOG_SAMPLE_RATE });
  const makePassword = deps.generatePassword ?? generatePassword;

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Default off, and off means "this route does not exist" — same
    // convention every other flag-gated endpoint follows.
    if (!(await deps.flags.isEnabled(CLINICIAN_ADMIN_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      switch (routeKey) {
        case 'GET /clinicians': {
          if (!can(principal, 'read', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          // The whole directory, deactivated colleagues included — the
          // principal has to see a deactivated account in order to
          // reactivate it. No pagination: see
          // `ClinicianRepository.list`'s own doc.
          const items = await deps.repository.list();
          return respond(200, { items });
        }
        case 'POST /clinicians': {
          if (!can(principal, 'create', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const parsed = createClinicianBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          // TASK 2.2.2 having no `cognito-idp` grant does not apply here —
          // unlike `SignUp`, `AdminCreateUser` is an authenticated,
          // IAM-authorised operation; clinician-admin-handler.ts's role
          // carries exactly the Admin* grants this file's ports use.
          //
          // D-30: Cognito artefacts first, the `CLI#` record last — the
          // same ordering `clinician-repository.ts`'s own header already
          // chose and accepts the same failure mode for ("an orphaned
          // Cognito user is the failure mode, not an orphaned record").
          // If `repository.create()` throws below (most likely
          // `PRINCIPAL_ALREADY_EXISTS`), the password and TOTP secret
          // already minted are never returned to anyone and the Cognito
          // user is simply unusable — nobody ever learns its password.
          const subjectId = await deps.createClinicianUser.createUser(parsed.data.email);
          // The principal's own choice when they made one, a generated
          // password otherwise — see this file's 2026-08-31 amendment.
          const password = parsed.data.password ?? makePassword();
          await deps.createClinicianUser.setPassword(subjectId, password);
          const totp = await deps.createClinicianUser.provisionTotp(
            subjectId,
            parsed.data.email,
            password,
          );
          const clinician = await deps.repository.create(
            subjectId,
            { displayName: parsed.data.displayName, role: parsed.data.role },
            actor,
          );
          // `'sub'` maps to no group at all, and deliberately: `roleFor()`
          // treats "a clinician-pool token in none of the named groups" as
          // the sub-clinician case, so a sub-clinician is the absence of a
          // membership rather than a membership of its own. One less thing
          // that can be granted, revoked, or forgotten.
          const groupName = GROUP_FOR_CLINICIAN_ROLE[clinician.role];
          if (groupName) {
            await deps.createClinicianUser.addToGroup(subjectId, groupName);
          }
          // Shown once, here, and nowhere else — never stored, never
          // logged (`logger.logRequest` above logs only route/status/
          // duration), the identical discipline `patient-admin.ts`'s own
          // generated password already follows for D-29. `totp` is
          // `undefined` under the pool's current `OPTIONAL` MFA setting
          // when nothing was provisioned (`provisionTotp`'s own header) —
          // omitted rather than sent as null/empty, so a caller can tell
          // "no TOTP" from "TOTP, but blank" by the field's presence.
          return respond(201, {
            item: clinician,
            password,
            ...(totp ? { totpSecret: totp.secret, otpauthUri: totp.otpauthUri } : {}),
          });
        }
        case 'POST /clinicians/{id}/deactivate': {
          if (!can(principal, 'update', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const clinician = await deps.repository.deactivate(id, actor);
          // Record first, Cognito second (this file's header): `can()`
          // already re-resolves `account_status` fresh within the
          // authorizer's 5-minute cache window regardless of what happens
          // below, so the record change is the change that matters most —
          // these two calls close the remaining gap and are not caught: a
          // half-completed deactivation (record changed, session still
          // live) must surface loudly, not be swallowed as a success.
          await deps.deactivateClinicianUser.disable(id);
          await deps.deactivateClinicianUser.revokeTokens(id);
          return respond(200, { item: clinician });
        }
        case 'POST /clinicians/{id}/reactivate': {
          if (!can(principal, 'update', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const clinician = await deps.repository.reactivate(id, actor);
          await deps.reactivateClinicianUser.enable(id);
          return respond(200, { item: clinician });
        }
        case 'POST /clinicians/me/change-password': {
          // Clinicians only — D-29's "no self-service" model for patients
          // is untouched by D-34; relaxing MFA never meant relaxing this.
          if (principal.role === 'patient') {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const parsed = changeOwnPasswordBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const accessToken = extractBearerToken(
            event.headers?.authorization ?? event.headers?.Authorization,
          );
          if (!accessToken) {
            return respond(401, { error: 'UNAUTHORIZED' });
          }
          try {
            await deps.changeOwnPassword.changePassword(
              accessToken,
              parsed.data.currentPassword,
              parsed.data.newPassword,
            );
          } catch (error) {
            if (error instanceof AppError && error.code === 'INCORRECT_CURRENT_PASSWORD') {
              return respond(400, { error: error.code });
            }
            if (error instanceof AppError && error.code === 'PASSWORD_POLICY_VIOLATION') {
              return respond(400, { error: error.code });
            }
            throw error;
          }
          return respond(200, { status: 'password-changed' });
        }
        default:
          return respond(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
        return respond(404, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'PRINCIPAL_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'RECORD_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      // 2026-08-31, found while building the directory UI: a duplicate
      // email raised `UsernameExistsException` straight out of
      // `AdminCreateUser` and reached the caller as a 500, so the "an
      // account with this email already exists" message
      // `ClinicianAdminPanel` has always carried could never be shown.
      // `patient-admin.ts` has mapped the identical Cognito case to a 409
      // since D-29; this is the same mapping, on the same reasoning — the
      // caller is an authenticated principal, so telling them the truth
      // is no existence oracle.
      if (error instanceof AppError && error.code === 'COGNITO_ACCOUNT_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      // A principal-chosen password Cognito's own policy refused — a 400
      // the form can show, not a 500. Never reachable on the generated
      // path (`password-generator.ts` satisfies the pool's policy by
      // construction), only on the `password` field this file's own
      // 2026-08-31 amendment added.
      if (error instanceof AppError && error.code === 'PASSWORD_POLICY_VIOLATION') {
        return respond(400, { error: error.code });
      }
      throw error;
    }
  };
}
