// D-29 (2026-08-29): `POST /patients`, `POST /patients/{id}/reset-password`,
// `GET /patients?email=` — SDK-free and unit-testable, the same split
// every other authoring endpoint uses (clinician-admin.ts /
// patient-admin-handler.ts wires the real AWS clients). This replaces
// TASK 2.2.3's self-registration route (retired —
// docs/runbooks/patient-registration.md) and TASK 2.2.3's Post-Confirmation
// trigger (also retired, deleted outright): there is no more Cognito
// sign-up event for either to react to, because a patient never signs
// themselves up.
//
// **`GET /patients?email=` (follow-up, same day): the lookup this design's
// own first cut left as a named limitation.** Resetting a password needs
// the patient's account id, and staff have no way to find one except
// having kept it from account creation. Rather than a new DynamoDB index
// — which would duplicate the email this codebase already keeps exactly
// once, in Cognito, as the patient pool's own username/alias
// (`UsernameAttributes: ['email']`, TASK 2.2.1) — this calls
// `AdminGetUser` by email directly and reads the `sub` back off it. No
// GSI, no second copy of the address to keep consistent, no schema
// migration: the directory already answers "which account has this
// email" by construction, for free.
//
// **The model, in full, is on docs/runbooks/patient-account-provisioning.md.**
// In short: a patient contacts the clinic's WhatsApp Business number — a
// human-staffed channel, not an API integration this codebase touches —
// gives their details, and staff (trained on verifying who they are)
// create the account here on their behalf. This file generates the
// password (`password-generator.ts`) and hands it back once, in the API
// response, for staff to relay over WhatsApp; Cognito never emails or
// texts anything (`MessageAction: SUPPRESS`, patient-admin-handler.ts),
// because there is no address this design trusts to carry a credential
// automatically. The password is set **permanent**, not temporary — a
// patient has no self-service "choose your own password" step to land on,
// by design (the user's own words: "they won't have option to set their
// own password"), so a Cognito-forced change on first sign-in would be a
// dead end this pool's client (auth-stack.ts, USER_SRP only) cannot serve.
//
// **Both actions are Principal-only** — the same scoping
// `clinician-admin.ts` already gives clinician-account administration,
// not extended to the assigned sub-clinician. See
// docs/plan/04-data-model-rbac.md's own note on this row for why.
//
// **The approval step is untouched.** `PatientRepository.register` is the
// exact method TASK 2.2.3's Post-Confirmation trigger used to call — it
// still writes `account_status: 'pending'`, and only `assignment.ts`'s
// `POST /patients/{id}/approve` moves that forward. Account creation and
// account approval stay two distinct actions on two distinct RBAC rows.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, auditEventFor, requestOriginOf, type AuditWriter } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { generatePassword } from './password-generator.js';
import { PATIENT_ENTITY_TYPE, type PatientRepository } from './patient-repository.js';
import { requirePrincipal } from './request-principal.js';

const PATIENT_ADMIN_FLAG = 'patients.administration.enabled';
const PATIENT_PROFILE_RESOURCE = { entityType: 'patient-profile' } as const;

// Lowest-volume admin surface in the estate, same as clinician-admin.ts's
// own reasoning for its sample rate — one or two principals, acting per
// WhatsApp conversation, whose own access to this route a reviewer is most
// likely to want to reconstruct later.
const PATIENT_ADMIN_LOG_SAMPLE_RATE = 1;

const createPatientBodySchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  marketingOptIn: z.boolean(),
  // The two fields self-registration's own `PatientRegistration.clinical`
  // ever carried (patient-repository.ts) — staff collect the same two over
  // WhatsApp, nothing wider.
  referralSource: z.string().optional(),
  presentingCondition: z.string().optional(),
});

const findPatientQuerySchema = z.object({ email: z.string().email().max(254) });

/**
 * The Cognito call, as a port — same shape registration.ts's retired
 * `SignUpPort` took, for the same reason: keeping AWS behind an interface
 * is what lets every test below run without it. `exists` means the email
 * is already registered — `AdminCreateUser`'s own `UsernameExistsException`.
 * Unlike self-registration's identical-sounding case, this endpoint is
 * behind a real, authenticated principal, so there is no existence-oracle
 * concern in telling staff the truth: they need to know, so they don't
 * create a second account for someone who already has one.
 */
export interface AdminCreatePatientPort {
  createUser(
    email: string,
  ): Promise<{ outcome: 'created'; subjectId: string } | { outcome: 'exists' }>;
}

/**
 * Shared by both routes: creating an account sets a password for the first
 * time, resetting one sets it again. One port, because both are the exact
 * same Cognito call (`AdminSetUserPassword`, `Permanent: true`) with no
 * meaningful difference in what it does.
 */
export interface AdminSetPatientPasswordPort {
  setPassword(subjectId: string, password: string): Promise<void>;
}

/**
 * `AdminGetUser` by email (the pool's own username), as a port. `undefined`
 * means no account exists with that address — `AdminGetUser`'s own
 * `UserNotFoundException` — which is the plain, useful answer for an
 * authenticated principal asking (unlike self-registration's retired
 * existence-oracle concern, which applied only to an unauthenticated caller).
 */
export interface AdminFindPatientPort {
  findByEmail(email: string): Promise<{ subjectId: string } | undefined>;
}

export interface PatientAdminDeps {
  readonly repository: PatientRepository;
  readonly flags: FlagReader;
  readonly audit: AuditWriter;
  readonly createPatientUser: AdminCreatePatientPort;
  readonly setPatientPassword: AdminSetPatientPasswordPort;
  readonly findPatientUser: AdminFindPatientPort;
  /** Overridable only so tests can assert against a known value; production never sets this. */
  readonly generatePassword?: () => string;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
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

export function createPatientAdminHandler(
  deps: PatientAdminDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: PATIENT_ADMIN_LOG_SAMPLE_RATE });
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
    if (!(await deps.flags.isEnabled(PATIENT_ADMIN_FLAG))) {
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
        case 'POST /patients': {
          if (!can(principal, 'create', PATIENT_PROFILE_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const parsed = createPatientBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          // **"An account with this email already exists" that no lookup
          // can then find.** Found live, 2026-08-31, and it is this
          // endpoint's own half-completed write staring back: the steps
          // below are `AdminCreateUser` → `AdminSetUserPassword` →
          // `repository.register`, and until an hour ago the third could
          // throw (the `undefined`-marshalling bug this file's own note
          // above records). When it did, the Cognito user survived with no
          // `PAT#` record behind it — an account that cannot sign in
          // (`dynamo-principal-directory.ts` has nothing to resolve, so
          // the authorizer denies every request), cannot be found by
          // `GET /patients?email=` (no record to return), does not appear
          // on the dashboard, and blocks its own email from ever being
          // registered again. The operator is told the account exists and
          // then that it does not, which is exactly as unhelpful as it
          // sounds.
          //
          // The marshalling bug is fixed, but the orphan it left is real
          // and this is the only endpoint that can clear it. So: a Cognito
          // user that already exists is a conflict **only when a record
          // exists behind it**. When none does, this call completes the
          // provisioning it started — sets a fresh password on the
          // existing user and writes the missing record — rather than
          // refusing forever.
          //
          // Deliberately not "always fall through to register":
          // `PatientRepository.register` is idempotent and returns an
          // existing record untouched, so an unguarded path here would
          // hand back a *real* patient's record alongside a newly-set
          // password — silently resetting a live credential on what the
          // operator thinks is a fresh account. The `findById` check below
          // is what keeps "complete an orphan" from becoming "take over an
          // account". Healing one is safe for the mirror-image reason: an
          // orphaned account has never been usable by anyone, so there is
          // no session, and no patient, to disturb.
          //
          // No `AdminDeleteUser` anywhere — a banned identifier repo-wide
          // and no part of this fix. The orphan is completed, never
          // removed.
          const created = await deps.createPatientUser.createUser(parsed.data.email);
          let subjectId: string;
          if (created.outcome === 'exists') {
            const existingUser = await deps.findPatientUser.findByEmail(parsed.data.email);
            if (!existingUser) {
              // `AdminCreateUser` said the username is taken and
              // `AdminGetUser` cannot find it — the two disagree about the
              // same pool, which no ordinary state produces. Refuse rather
              // than guess at a subject id to write a record against.
              throw new AppError(
                'COGNITO_ACCOUNT_ALREADY_EXISTS',
                'a Cognito account with this email already exists',
              );
            }
            if (await deps.repository.findById(existingUser.subjectId)) {
              throw new AppError(
                'COGNITO_ACCOUNT_ALREADY_EXISTS',
                'a Cognito account with this email already exists',
              );
            }
            subjectId = existingUser.subjectId;
          } else {
            subjectId = created.subjectId;
          }
          const password = makePassword();
          // Set before the record is written: a patient who exists in
          // Cognito with no password yet and no `PAT#` record is a
          // strictly worse intermediate state than one who exists in both
          // with the record still to come — the ordering
          // clinician-admin.ts's own header already accepts for the
          // identical create-then-record shape.
          await deps.setPatientPassword.setPassword(subjectId, password);
          // **An optional field the caller omitted must be an absent
          // property, never a present one holding `undefined`.** Found
          // live, 2026-08-31: this object literal named all four optional
          // fields unconditionally, so leaving the phone / referral
          // source / presenting condition blank on the form produced
          // `personal.phone === undefined` on the record — and the
          // DynamoDB document client refuses to marshal that ("Pass
          // options.removeUndefinedValues=true to remove undefined values
          // from map/array/set"), throwing out of `register` and reaching
          // the browser as a 500, i.e. "Something went wrong creating the
          // account." Every patient created before this had all three
          // fields filled in, which is why it had never been hit.
          //
          // `dynamo-store.ts`'s client now also sets
          // `removeUndefinedValues` so no *other* call site can reproduce
          // this. Both halves are deliberate: that option keeps a blank
          // optional field from ever being a 500 again, and this spread
          // keeps the record honest — "no phone was given" and "phone is
          // blank" stay different facts here, exactly as
          // `patient-admin-request.ts` already keeps them different on the
          // request.
          const patient = await deps.repository.register(
            {
              subjectId,
              personal: {
                fullName: parsed.data.fullName,
                email: parsed.data.email,
                marketingOptIn: parsed.data.marketingOptIn,
                ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
              },
              clinical: {
                ...(parsed.data.referralSource
                  ? { referralSource: parsed.data.referralSource }
                  : {}),
                ...(parsed.data.presentingCondition
                  ? { presentingCondition: parsed.data.presentingCondition }
                  : {}),
              },
            },
            actor,
          );
          // Returned once, in this response only — never logged, never
          // persisted anywhere this codebase controls. Staff relay it over
          // WhatsApp and it is gone from here.
          return respond(201, { item: patient, password });
        }
        case 'POST /patients/{id}/reset-password': {
          if (!can(principal, 'reset-password', PATIENT_PROFILE_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const existing = await deps.repository.findById(id);
          if (!existing) {
            throw new AppError('RECORD_NOT_FOUND', `patient ${id} not found`);
          }
          const password = makePassword();
          await deps.setPatientPassword.setPassword(id, password);
          // No repository write happens on this path — see audit.ts's own
          // header on why 'reset-password' is audited directly here
          // rather than riding a record mutation's existing audit call.
          await deps.audit.write(
            auditEventFor(actor, {
              at: clock.now().toISOString(),
              action: 'reset-password',
              entityType: PATIENT_ENTITY_TYPE,
              entityId: id,
            }),
          );
          return respond(200, { password });
        }
        case 'GET /patients': {
          if (!can(principal, 'read', PATIENT_PROFILE_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const parsed = findPatientQuerySchema.safeParse(event.queryStringParameters ?? {});
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_QUERY', issues: parsed.error.issues });
          }
          const found = await deps.findPatientUser.findByEmail(parsed.data.email);
          if (!found) {
            return respond(404, { error: 'NOT_FOUND' });
          }
          const patient = await deps.repository.findById(found.subjectId);
          if (!patient) {
            // A Cognito user with no matching `PAT#` record — an
            // inconsistent state no ordinary path in this codebase
            // produces (patient-admin.ts's own create writes both
            // together), but not this route's job to repair. The plain,
            // honest answer for a caller asking "does this patient exist"
            // is the same 404 a genuinely-absent email gets.
            return respond(404, { error: 'NOT_FOUND' });
          }
          return respond(200, { item: patient });
        }
        default:
          return respond(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
        return respond(404, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'COGNITO_ACCOUNT_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
