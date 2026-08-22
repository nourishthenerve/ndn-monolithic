// TASK 2.2.3 step 3: the Cognito Post-Confirmation trigger. It runs after
// the patient has proved they can read the mailbox they signed up with,
// and it is the only thing that creates a `PAT#` record.
//
// **Two properties, and Cognito's retry behaviour is why both matter.**
//
// Idempotent: Cognito re-invokes this trigger with the same event when it
// fails, so a second run must not write a second record or a second audit
// row. `PatientRepository.register` returns the existing record instead —
// one registration, one row, however many times Cognito asks.
//
// Failures surface: an exception here fails the trigger, which Cognito
// reports to the caller. That is the correct trade. The alternative —
// swallowing the error so sign-up "succeeds" — leaves a confirmed Cognito
// account with no record in this system, which the authorizer (2.2.2)
// denies on every request. A user who cannot sign in and does not know why
// is worse than one whose confirmation visibly failed.
import type { Patient } from '@ndn/shared-types';

import { actorContext, type ActorContext } from './audit.js';
import type { PatientRepository } from './patient-repository.js';
import type { Unprojected } from './projection.js';
import type { IntakeStore } from './registration.js';

/**
 * The slice of Cognito's Post-Confirmation event this needs. Declared
 * structurally rather than imported from `aws-lambda` so the tests can
 * build one without the whole event shape, and so a missing attribute is
 * a value this file has to handle rather than a type it can assume.
 */
export interface PostConfirmationEvent {
  readonly triggerSource?: string;
  readonly userName?: string;
  readonly request?: {
    readonly userAttributes?: Record<string, string | undefined>;
    readonly clientMetadata?: Record<string, string | undefined>;
  };
}

/** Only the sign-up confirmation. The same trigger also fires for forgot-password flows. */
export const POST_CONFIRMATION_SIGN_UP = 'PostConfirmation_ConfirmSignUp';

export interface PostConfirmationDeps {
  readonly patients: PatientRepository;
  /** Where registration.ts parked the fields Cognito cannot hold. */
  readonly intake: IntakeStore;
  /** Content-free by contract — see ses-registration.ts. */
  readonly sendConfirmationEmail: (to: string) => Promise<void>;
  readonly log?: (line: Record<string, unknown>) => void;
}

export class MissingSubjectError extends Error {}

/**
 * Returns the event, as Cognito requires a trigger to. Throws only when
 * the record could not be written — see the header.
 */
export function createPostConfirmationHandler(deps: PostConfirmationDeps) {
  const log = deps.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));

  return async (event: PostConfirmationEvent): Promise<PostConfirmationEvent> => {
    if (event.triggerSource !== POST_CONFIRMATION_SIGN_UP) {
      // A password reset is not a registration. Returning unchanged is how
      // a Cognito trigger says "not mine".
      return event;
    }

    const attributes = event.request?.userAttributes ?? {};
    const subjectId = attributes.sub;
    const email = attributes.email;
    if (!subjectId || !email) {
      // Without a `sub` there is no key to write under, and without an
      // address there is no account. Cognito always sends both; if it ever
      // does not, that is a failure to surface rather than a record to
      // improvise.
      throw new MissingSubjectError('post-confirmation event carried no sub or email');
    }

    // The patient is registering *themselves*, so they are the actor. This
    // is the first audit row in the system whose actor is a real person
    // rather than `admin-token`, `public` or `system` (audit.ts's three
    // widened members) — which is the point of having built 2.1.3 first.
    const actor: ActorContext = actorContext(
      { subjectId, role: 'patient' },
      {
        // Cognito triggers carry no API Gateway request id and no client
        // address. `awsRequestId` is not on the event either, so the join
        // key is the subject itself and the source is recorded as empty
        // rather than as a fabricated address.
        requestId: event.request?.clientMetadata?.requestId ?? subjectId,
        sourceIp: '',
      },
    );

    // The name, phone and marketing preference the patient typed, which
    // could not travel through a directory that holds one attribute.
    // `take` also clears the row's payload, so from here the only copy
    // lives under `personal{}`.
    //
    // Absent is survivable rather than fatal: an account created outside
    // `POST /registrations` (an operator using the Cognito console, say)
    // still gets a record, with the address Cognito verified and nothing
    // invented around it. A `pending` record grants nothing, and a
    // clinician filling in a name at approval is a better failure than a
    // confirmed account with no record at all.
    const intake = await deps.intake.take(subjectId);
    if (!intake) {
      log({ event: 'registration-intake-missing', subjectId });
    }

    const patient: Unprojected<Patient> = await deps.patients.register(
      {
        subjectId,
        personal: {
          fullName: intake?.fullName ?? '',
          // Cognito's verified address wins over the intake row's copy.
          // They are the same value in every ordinary flow; when they are
          // not, the one the patient proved they can read is the true one.
          email,
          phone: intake?.phone,
          marketingOptIn: intake?.marketingOptIn ?? false,
        },
      },
      actor,
    );

    // Sent after the record exists, and never before: an email promising
    // that a registration was received must not be the only trace of one.
    // A send failure is caught — the account and the record are both real
    // at this point, and failing the trigger would undo neither while
    // telling the patient their confirmation broke.
    try {
      await deps.sendConfirmationEmail(email);
    } catch {
      log({ event: 'registration-email-failed', subjectId });
    }

    log({ event: 'patient-registered', subjectId, accountStatus: patient.account_status });
    return event;
  };
}
