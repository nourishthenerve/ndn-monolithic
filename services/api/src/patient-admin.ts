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

import { DEFAULT_ASSESSMENT_ID, type AssessmentRepository } from './assessment-repository.js';
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
/** Suspension/restore's own row — Principal-only, deliberately *not* the profile row helpdesk can update. See the routes' own note. */
const PATIENT_ASSIGNMENT_RESOURCE = { entityType: 'patient-assignment' } as const;

// Lowest-volume admin surface in the estate, same as clinician-admin.ts's
// own reasoning for its sample rate — one or two principals, acting per
// WhatsApp conversation, whose own access to this route a reviewer is most
// likely to want to reconstruct later.
const PATIENT_ADMIN_LOG_SAMPLE_RATE = 1;

const createPatientBodySchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  address: z.string().max(500).optional(),
  marketingOptIn: z.boolean(),
  // 2026-08-31: which programme the patient came in through. Optional on
  // the wire and defaulted below rather than required, so a caller that
  // predates tagging still works — but the form always sends one, and
  // every patient created from today carries a tag rather than an
  // absence that later has to be interpreted.
  tag: z.enum(['IIC', 'NDN']).optional(),
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

/**
 * 2026-09-01: suspending a patient disables their Cognito user and revokes
 * their live tokens; restoring re-enables it.
 *
 * **This is what "remove access" was missing.** The owner: *"patient
 * dashboard - remove access is not working."* Suspension had, until now,
 * flipped `account_status` on the `PAT#` record and nothing else — so a
 * suspended patient could still sign in, and their existing session kept
 * working for up to the authorizer's five-minute result cache
 * (`route-protection.ts`). After that `can()` did gate them down to
 * reading their own profile, so the *data* boundary held; but "they can
 * still log in" is not what anyone means by removing access, and the
 * record said one thing while the directory said another.
 *
 * The clinician half of this has been right since TASK 2.4.1 —
 * `AdminDisableUser` plus `AdminUserGlobalSignOut`, and
 * `AdminEnableUser` to undo it. This is the same pair for the patient
 * pool, and the asymmetry between the two was the bug.
 *
 * `revokeTokens` is separate from `disable` because they fail
 * independently and only one of them is reversible: disabling is the
 * durable half, and a global sign-out that failed would leave a disabled
 * account with a live session for the rest of that cache window.
 *
 * **No `AdminDeleteUser`, here or anywhere** — C-03 and
 * 00-conventions.md. A suspended patient is disabled, never removed.
 */
export interface AdminSetPatientEnabledPort {
  disable(subjectId: string): Promise<void>;
  revokeTokens(subjectId: string): Promise<void>;
  enable(subjectId: string): Promise<void>;
}

export interface PatientAdminDeps {
  readonly repository: PatientRepository;
  /**
   * 2026-09-01: "Each patient will have an assessment form that will be
   * loaded from the template the moment his account is being created."
   * This is that moment — see the `POST /patients` case below for why a
   * failure here does not fail the account.
   */
  readonly assessments: AssessmentRepository;
  readonly flags: FlagReader;
  readonly audit: AuditWriter;
  readonly createPatientUser: AdminCreatePatientPort;
  readonly setPatientPassword: AdminSetPatientPasswordPort;
  readonly findPatientUser: AdminFindPatientPort;
  /** 2026-09-01: the directory half of suspend/restore — see `AdminSetPatientEnabledPort`. */
  readonly setPatientEnabled: AdminSetPatientEnabledPort;
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
                ...(parsed.data.address ? { address: parsed.data.address } : {}),
              },
              tag: parsed.data.tag ?? 'NDN',
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
          // 2026-09-01: the assessment form, instantiated from the
          // template at the moment the account is created.
          //
          // **Deliberately not fatal, and deliberately not silent.** The
          // account is the artifact this endpoint exists to produce, and
          // it is already fully written by this line — Cognito user,
          // password set, `PAT#` record. Throwing here would abandon a
          // usable account for a recoverable reason, and the retry would
          // not be clean: the orphan guard above would see both the
          // Cognito user *and* a record and answer 409 forever.
          //
          // Recoverable, because a form is not lost by being late. It is
          // instantiated idempotently, and `assessment.ts`'s own write
          // path instantiates one lazily for any patient that reaches it
          // without — which is the same path that already covers every
          // patient created before this feature existed. Until then `GET`
          // reports `currentVersion: 0` and the form renders empty, which
          // is what a fresh form looks like anyway.
          //
          // So the outcome is reported instead of swallowed: the caller
          // is told whether the form was written, rather than having to
          // infer it from a later screen.
          let assessmentFormCreated = true;
          try {
            await deps.assessments.instantiate(subjectId, DEFAULT_ASSESSMENT_ID, actor, {
              ...(patient.tag ? { tag: patient.tag } : {}),
            });
          } catch {
            assessmentFormCreated = false;
          }
          // Returned once, in this response only — never logged, never
          // persisted anywhere this codebase controls. Staff relay it over
          // WhatsApp and it is gone from here.
          return respond(201, { item: patient, password, assessmentFormCreated });
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
        // 2026-08-31: "Only the principal clinician would be able to
        // remove the patient/clinician." The clinician half has existed
        // since TASK 2.4.1 (`deactivate`/`reactivate`); this is the
        // patient half, and it had no route at all —
        // `PatientRepository.transition(id, 'suspend')` was written in
        // TASK 2.2.3 and never once called.
        //
        // **Governed by `'patient-assignment'`, not `'patient-profile'`,
        // and that is the whole point.** Helpdesk holds `update` on a
        // patient's *profile* — they correct phone numbers — and must not
        // thereby be able to revoke a patient's access. Those are two
        // different powers and they need two different cells; the
        // assignment row is the one that already means "decisions about
        // this patient's standing in the practice", and it is
        // Principal-only.
        //
        // Suspension is not deletion and not unassignment: the record
        // stays whole, `assigned_clinician_id` is untouched, and
        // `restore` puts them back to `approved` under the same clinician.
        case 'POST /patients/{id}/suspend':
        case 'POST /patients/{id}/restore': {
          if (!can(principal, 'update', PATIENT_ASSIGNMENT_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const suspending = routeKey === 'POST /patients/{id}/suspend';
          // The record first, the directory second, and the order is the
          // safe one in both directions. Suspending: if the record write
          // succeeds and the disable fails, the patient is already gated
          // to their own profile by `can()` — the fix is a retry, not a
          // hole. Restoring: the record is what `can()` reads, so a
          // failed enable leaves someone able to reach nothing rather
          // than able to sign in with no standing.
          //
          // `transition` throws `RECORD_NOT_FOUND` for an id that does
          // not exist, which is why it runs before anything touches the
          // directory: no Cognito call is made for a patient this
          // practice has never had.
          const patient = await deps.repository.transition(
            id,
            suspending ? 'suspend' : 'restore',
            actor,
          );
          // Reported, not swallowed, and deliberately not fatal: the
          // record has already moved, so throwing here would tell the
          // operator the suspension failed when the half that gates data
          // access succeeded. The same shape `POST /patients` uses for
          // the assessment form it instantiates.
          let directoryUpdated = true;
          try {
            if (suspending) {
              await deps.setPatientEnabled.disable(id);
              // Ends every live session immediately, rather than letting
              // the authorizer's five-minute result cache run down.
              await deps.setPatientEnabled.revokeTokens(id);
            } else {
              await deps.setPatientEnabled.enable(id);
            }
          } catch {
            directoryUpdated = false;
          }
          return respond(200, { item: patient, directoryUpdated });
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
