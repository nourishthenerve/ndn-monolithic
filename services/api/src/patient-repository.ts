// TASK 2.2.3: the patient record and the transitions a clinician can put
// it through. Built on `Repository` (0.3.3), which already enforces
// created_at/updated_at/status on every write, audits every write, and —
// the part that matters here — **has no method that removes a row**.
//
// So the shape of this file is: one `register`, one status transition,
// and no delete. `declined` and `suspended` are values of
// `account_status`, and the record stays fully readable in both. That is
// not a policy this layer restates; it is the only thing the base class
// can express.
//
// TASK 2.5.1: `approve`/`decline` are gone from `PatientTransition`.
// Approving or declining a patient is now `assignment-repository.ts`'s
// job — it needs an atomic, three-way `TransactWriteItems` (the new
// `ASSIGNREQ#` decision row, the patient's own `account_status`/
// `assigned_clinician_id`, and GSI1's projection) that this class's
// single-item `KeyValueStore` cannot express, the same reason
// `content-repository.ts`/`testimonial-repository.ts` are bespoke rather
// than `Repository<T>`-based. Nothing in production ever called
// `transition(id, 'approve' | 'decline', …)` — it would have written a
// `account_status: 'approved'` with no `ASSIGNREQ#` row and no GSI1
// projection behind it, silently producing exactly the "an approved
// patient nobody is responsible for" state 2.5.1's own text warns
// against — so narrowing this type is closing a footgun, not removing a
// used feature. `suspend` is untouched: it is not an assignment decision
// and has no atomicity requirement beyond what this class already gives it.
import type { Patient, PatientClinical, PatientPersonal } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import type { NotificationRecipient } from './notifications.js';
import type { Unprojected } from './projection.js';
import { Repository } from './repository.js';
import type { KeyValueStore } from './store.js';

export const PATIENT_ENTITY_TYPE = 'patient';

/** What account creation is allowed to write. Nothing clinical beyond the two declared fields. */
export interface PatientRegistration {
  /** The Cognito `sub`. The record's own id, so the authorizer's lookup is one keyed read. */
  readonly subjectId: string;
  readonly personal: PatientPersonal;
  readonly clinical?: PatientClinical;
  /** 2026-08-31: which programme the patient came in through. `POST /patients` always supplies one (defaulting to `NDN`); absent here means an older caller, and stays absent on the record. */
  readonly tag?: Patient['tag'];
}

/**
 * The one move left in this class's own closed set — see this file's
 * header for why `approve`/`decline` moved to `assignment-repository.ts`.
 * Not a free `account_status` patch: "set the status to whatever you
 * pass" is how a record ends up in a state nobody designed, and it is
 * also how a `deleted` sneaks into a field that has no such value.
 */
/**
 * `'restore'` (2026-08-31): the way back out of `suspended`. `suspend`
 * has existed since TASK 2.2.3 with nothing calling it; `POST
 * /patients/{id}/suspend` (patient-admin.ts, Principal-only) now does,
 * and a revocation with no reversal is a trap rather than a control —
 * the same reason `deactivate` has always shipped beside `reactivate` on
 * the clinician side.
 *
 * Restoring returns a patient to `approved`, not to `pending`.
 * `assigned_clinician_id` is untouched by both transitions, so a
 * suspended patient keeps the clinician they had and gets them back on
 * restore — which is what makes this a suspension rather than a
 * disguised unassignment (2.5.2's "there is no unassign" still holds:
 * only `reassign` moves a patient between clinicians).
 */
export type PatientTransition = 'suspend' | 'restore';

const TRANSITIONS: Record<PatientTransition, Patient['account_status']> = {
  suspend: 'suspended',
  restore: 'approved',
};

/** The audit action this transition is recorded as, from `AUDIT_ACTIONS`'s existing vocabulary. */
const TRANSITION_AUDIT_ACTIONS = {
  suspend: 'update',
  restore: 'update',
} as const;

/**
 * TASK 3.1.1's own patch shape: `personal{}`/`clinical{}` merge into the
 * *existing* sub-object field by field, never replace it wholesale — a
 * caller that PATCHes `{ personal: { phone } }` must not silently wipe
 * `fullName`/`email`/`marketingOptIn`. Which of the two halves a given
 * caller may populate is a handler/schema decision (`patient.ts`'s two
 * Zod schemas), not this method's — `Repository.update`'s own shallow
 * merge is exactly wrong for nested objects, which is the reason this
 * wrapper exists rather than calling it directly with a raw patch.
 */
export interface PatientProfilePatch {
  readonly personal?: Partial<PatientPersonal>;
  readonly clinical?: Partial<PatientClinical>;
  /**
   * 2026-08-31. Top-level, replaced rather than merged — unlike the two
   * sub-objects above there is nothing to merge, a tag is one value.
   * Reachable only through `patient.ts`'s clinician patch schema, never
   * a patient's own: the tag decides which patients a `visitor` account
   * can see, so the subject of the record must not be able to set it.
   */
  readonly tag?: Patient['tag'];
}

export class PatientRepository {
  private readonly repository: Repository<Patient>;

  constructor(
    private readonly store: KeyValueStore<Patient>,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {
    this.repository = new Repository<Patient>(store, audit, clock, PATIENT_ENTITY_TYPE);
  }

  /**
   * **Idempotent.** Originally written for TASK 2.2.3's Post-Confirmation
   * trigger, whose own retry-on-throw behaviour a second `create` would
   * have either overwritten a record a clinician had already approved or
   * turned into a permanent `RECORD_ALREADY_EXISTS`. D-29's
   * `patient-admin.ts` is the only caller now, but the property still
   * matters: a Lambda invocation itself can be retried, and returning the
   * existing record is the correct answer to "this subject already has a
   * profile" either way — it writes no second audit row, one account, one
   * row, however many times the call lands.
   */
  async register(
    registration: PatientRegistration,
    actor: ActorContext,
  ): Promise<Unprojected<Patient>> {
    const existing = await this.repository.findById(registration.subjectId);
    if (existing) {
      return existing;
    }
    return this.repository.create(registration.subjectId, actor, {
      id: registration.subjectId,
      personal: registration.personal,
      // Self-registration writes at most `referralSource` and
      // `presentingCondition`, and the type is what enforces it — there is
      // no field on `PatientRegistration` through which anything else
      // could arrive.
      clinical: registration.clinical ?? {},
      account_status: 'pending',
      ...(registration.tag ? { tag: registration.tag } : {}),
      keywords: [],
    } as Omit<Patient, 'created_at' | 'updated_at' | 'status'>);
  }

  /**
   * The one place `account_status` changes. Audited with the acting
   * principal — which is the whole reason 2.1.3 landed before this task:
   * "a clinician approved this patient" is only a fact if the log says
   * *which* clinician.
   */
  async transition(
    id: string,
    transition: PatientTransition,
    actor: ActorContext,
  ): Promise<Unprojected<Patient>> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `patient ${id} not found`);
    }

    const now = this.clock.now().toISOString();
    const record: Patient = {
      ...existing,
      account_status: TRANSITIONS[transition],
      updated_at: now,
      // `status` is untouched on purpose. A declined patient's *row* is as
      // active as an approved one's; only their access differs.
      status: existing.status,
      created_at: existing.created_at,
    };
    await this.store.put(id, record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: TRANSITION_AUDIT_ACTIONS[transition],
        entityType: PATIENT_ENTITY_TYPE,
        entityId: id,
      }),
    );
    return this.repository.findById(id) as Promise<Unprojected<Patient>>;
  }

  /** Still readable in every status, `declined` and `suspended` included. */
  findById(id: string): Promise<Unprojected<Patient> | undefined> {
    return this.repository.findById(id);
  }

  /**
   * TASK 3.1.1: the patient's own profile, edited for real. Field-merges
   * each given sub-object into the *existing* one — see
   * `PatientProfilePatch`'s own comment for why a raw `Repository.update`
   * call would be wrong here. Throws `RECORD_NOT_FOUND` the same way
   * `transition` does; the caller (`patient.ts`) is expected to have
   * already resolved *who* may reach this record via `can()` before
   * calling it, the same contract every repository in this codebase keeps.
   */
  async update(
    id: string,
    actor: ActorContext,
    patch: PatientProfilePatch,
  ): Promise<Unprojected<Patient>> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `patient ${id} not found`);
    }
    return this.repository.update(id, actor, {
      ...(patch.personal ? { personal: { ...existing.personal, ...patch.personal } } : {}),
      ...(patch.clinical ? { clinical: { ...existing.clinical, ...patch.clinical } } : {}),
      ...(patch.tag ? { tag: patch.tag } : {}),
    });
  }
}

/**
 * TASK 2.3.1: what `Notifier.send` (notifications.ts) needs off a patient
 * record. `personal{}` already carries all of it — email, phone,
 * `marketingOptIn` — so this is a projection, not a new preference to
 * maintain; "channel preferences … marketing consent is already there."
 * A declined or suspended patient still resolves here: whether anything is
 * actually sent is the Notifier's own guards' decision, not this mapping's.
 */
export function notificationRecipientFor(patient: Unprojected<Patient>): NotificationRecipient {
  return {
    id: patient.id,
    email: patient.personal.email,
    phone: patient.personal.phone,
    marketingOptIn: patient.personal.marketingOptIn,
  };
}
