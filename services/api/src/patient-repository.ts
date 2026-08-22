// TASK 2.2.3: the patient record and the four transitions a clinician can
// put it through. Built on `Repository` (0.3.3), which already enforces
// created_at/updated_at/status on every write, audits every write, and —
// the part that matters here — **has no method that removes a row**.
//
// So the shape of this file is: one `register`, three status transitions,
// and no delete. `declined` and `suspended` are values of
// `account_status`, and the record stays fully readable in both. That is
// not a policy this layer restates; it is the only thing the base class
// can express.
import type { Patient, PatientClinical, PatientPersonal } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import type { Unprojected } from './projection.js';
import { Repository } from './repository.js';
import type { KeyValueStore } from './store.js';

export const PATIENT_ENTITY_TYPE = 'patient';

/** What self-registration is allowed to write. Nothing clinical beyond the two declared fields. */
export interface PatientRegistration {
  /** The Cognito `sub`. The record's own id, so the authorizer's lookup is one keyed read. */
  readonly subjectId: string;
  readonly personal: PatientPersonal;
  readonly clinical?: PatientClinical;
}

/**
 * The three moves a clinician makes on an account, as a closed set. Not a
 * free `account_status` patch: "set the status to whatever you pass" is
 * how a record ends up in a state nobody designed, and it is also how a
 * `deleted` sneaks into a field that has no such value.
 */
export type PatientTransition = 'approve' | 'decline' | 'suspend';

const TRANSITIONS: Record<PatientTransition, Patient['account_status']> = {
  approve: 'approved',
  decline: 'declined',
  suspend: 'suspended',
};

/**
 * The audit action each transition is recorded as, from `AUDIT_ACTIONS`'s
 * existing vocabulary. `decline` maps to `reject` because that is the word
 * the log already uses for "a human refused this"; approve and suspend are
 * `update`, because they are exactly that and inventing a verb per
 * transition would make a day of audit rows harder to read, not easier.
 */
const TRANSITION_AUDIT_ACTIONS = {
  approve: 'update',
  decline: 'reject',
  suspend: 'update',
} as const;

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
   * **Idempotent, because Cognito retries.** A Post-Confirmation trigger
   * that throws is invoked again with the same event, and a second
   * `create` would either overwrite a record a clinician has already
   * approved or throw `RECORD_ALREADY_EXISTS` into Cognito's face forever.
   * Returning the existing record is the only correct answer to "this
   * subject is already registered", and it writes no second audit row —
   * one registration, one row, however many times Cognito asks.
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
}
