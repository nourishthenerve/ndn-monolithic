// TASK 2.5.1: the hinge of the whole authorisation model — `pending →
// approved | declined`, and `assigned_clinician_id` becomes a real fact
// about the data rather than a parameter in a unit test. Bespoke, not
// `Repository<T>`-based, for the same reason `content-repository.ts` and
// `testimonial-repository.ts` are: approval needs an atomic multi-row
// write (`ASSIGNREQ#<ts>` plus the patient's own `PROFILE` row and its
// GSI1 projection) that `KeyValueStore<T>`'s single-item shape can't
// express — the same shape `ContentStore.create`'s "main item + one row
// per keyword" already established for this table.
//
// **Append-only, the same three ways every other decision-shaped entity
// in this codebase is:** `AssignmentStore.writeDecision` only ever
// creates a *new* `ASSIGNREQ#` row (`attribute_not_exists(pk)` on the
// real implementation), never edits one; nothing here has a method that
// removes a row; and a declined patient's earlier `pending`/`declined`
// history and an approved patient's earlier `ASSIGNREQ#` rows all stay
// exactly as written. "A declined patient can be re-approved" is this
// property in one sentence — re-approving appends a new row, it does not
// resurrect or rewrite the old one.
//
// TASK 2.5.2 adds `reassign` — the same append-only shape again: a new
// `ASSIGNREQ#` row per reassignment, `assigned_clinician_id` (and GSI1's
// projection, derived from it) moved atomically in the same write. See
// `reassign`'s own doc for why this needs no second, stale GSI1 row and
// no read-side filter — a deliberate, reasoned departure from that half
// of the task's own step 3.
import { TREATING_CLINICIAN_ROLES } from '@ndn/shared-types';
import type { AssignmentRequest, Patient } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { ClinicianRepository } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { unprojected, type Unprojected } from './projection.js';

export const ASSIGNMENT_ENTITY_TYPE = 'patient-assignment';

/**
 * What `approve`/`decline` return: the decision row, and the patient
 * record as it now stands — so a caller (the notifier) never needs a
 * second read. `patient` is branded `Unprojected`, the same contract
 * every other repository read in this codebase keeps (projection.ts,
 * TASK 2.1.2) — this file builds the record itself rather than reading it
 * back through `Repository<T>`, so it mints the brand explicitly instead
 * of inheriting it.
 */
export interface AssignmentDecision {
  readonly request: AssignmentRequest;
  readonly patient: Unprojected<Patient>;
}

/** What `reassign` returns — `AssignmentDecision` plus the clinician who is losing the patient, so a caller can notify them without a second read. */
export interface ReassignmentDecision extends AssignmentDecision {
  readonly previousClinicianId: string;
}

export interface AssignmentStore {
  getPatient(patientId: string): Promise<Patient | undefined>;
  /**
   * Atomically writes the new `ASSIGNREQ#` row and overwrites the
   * patient's `PROFILE` row with `patient`'s own fields — GSI1's
   * projection (`gsi1pk`/`gsi1sk`) is derived by the real implementation
   * from `patient.assigned_clinician_id` alone, never a separate input:
   * there is exactly one fact ("who is this patient assigned to") and one
   * place it lives on the domain type, so the index cannot disagree with
   * the field it projects.
   */
  writeDecision(request: AssignmentRequest, patient: Patient): Promise<void>;
  /** GSI1: every patient id currently assigned to `clinicianId`, in no particular order. */
  listPatientIdsForClinician(clinicianId: string): Promise<string[]>;
}

export class AssignmentRepository {
  constructor(
    private readonly store: AssignmentStore,
    private readonly clinicians: ClinicianRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Only ever reaches this far when `can()` has already granted the
   * `Principal` column (authz-matrix.ts's `'Patient assignment'` row) —
   * this method itself trusts the caller to have checked, the same
   * contract every other repository in this codebase keeps with its
   * handler.
   */
  async approve(
    patientId: string,
    assignedClinicianId: string,
    actor: ActorContext,
  ): Promise<AssignmentDecision> {
    const patient = await this.requirePatient(patientId);
    // Reassignment (a different clinician, or the same one re-confirmed)
    // is TASK 2.5.2's own operation, with its own append-only history
    // rule — this method's job ends at the *first* assignment.
    if (patient.account_status === 'approved') {
      throw new AppError(
        'ALREADY_ASSIGNED',
        `patient ${patientId} is already approved — use reassignment (2.5.2), not a second approval`,
      );
    }
    const clinician = await this.clinicians.findById(assignedClinicianId);
    // 2026-08-31: the role check joins the status check, and for the same
    // reason — a target that cannot actually hold this patient's care.
    // `helpdesk` accounts live in the same directory and are `active`,
    // so status alone would have let one be assigned a patient, leaving
    // that patient with nobody treating them while the record claimed
    // otherwise. See `TREATING_CLINICIAN_ROLES`.
    if (
      !clinician ||
      clinician.account_status !== 'active' ||
      !TREATING_CLINICIAN_ROLES.includes(clinician.role)
    ) {
      throw new AppError(
        'CLINICIAN_NOT_AVAILABLE',
        `clinician ${assignedClinicianId} does not exist, is not active, or does not treat patients`,
      );
    }

    const now = this.clock.now().toISOString();
    const request: AssignmentRequest = {
      patientId,
      requestedAt: now,
      decidedBy: actor.subjectId,
      decidedAt: now,
      assignedClinicianId,
      status: 'approved',
      created_at: now,
      updated_at: now,
    };
    const updatedPatient: Patient = {
      ...patient,
      account_status: 'approved',
      assigned_clinician_id: assignedClinicianId,
      updated_at: now,
    };

    await this.writeAndAudit(request, updatedPatient, actor, 'update');
    return { request, patient: unprojected(updatedPatient) };
  }

  /**
   * Only for a `pending` (or already-`declined`) patient — declining an
   * approved patient would be an ad-hoc unassignment, which 2.5.2 owns
   * ("there is no unassign") and this method deliberately does not
   * shortcut.
   */
  async decline(patientId: string, actor: ActorContext): Promise<AssignmentDecision> {
    const patient = await this.requirePatient(patientId);
    if (patient.account_status === 'approved') {
      throw new AppError(
        'ALREADY_ASSIGNED',
        `patient ${patientId} is already approved — declining an assigned patient is not this method's job`,
      );
    }

    const now = this.clock.now().toISOString();
    const request: AssignmentRequest = {
      patientId,
      requestedAt: now,
      decidedBy: actor.subjectId,
      decidedAt: now,
      status: 'declined',
      created_at: now,
      updated_at: now,
    };
    // No `assigned_clinician_id` to clear: a patient reaching this branch
    // was never approved (the guard above rules that out), so the field
    // was never set on their record to begin with.
    const updatedPatient: Patient = { ...patient, account_status: 'declined', updated_at: now };

    await this.writeAndAudit(request, updatedPatient, actor, 'reject');
    return { request, patient: unprojected(updatedPatient) };
  }

  /**
   * TASK 2.5.2. Only for an already-`approved` patient — `approve` is the
   * *first* assignment, this is every one after it. **There is no
   * "unassign":** the only shapes this method accepts are "move to this
   * other, active clinician", never "clear the field" — step 6's own DoD.
   *
   * **A single `TransactWriteItems`, exactly like `approve`/`decline` —
   * not a second projection row left stale beside a filter.** The task's
   * own step 3 describes GSI1 gaining a *new* projection row while "the
   * old row is left in place and filtered by the current
   * assigned_clinician_id on read" — the shape `ContentStore`'s keyword
   * rows use, where a *set*-valued relationship (many keywords) can only
   * grow without `DeleteItem`. A patient's clinician is not set-valued —
   * it is exactly one fact at a time — so `gsi1pk`/`gsi1sk` living as
   * plain attributes on the patient's own `PROFILE` row (the same design
   * `approve` already established) can be overwritten in the same Put
   * that already changes `assigned_clinician_id`, with no second row and
   * nothing to filter: a stale entry cannot exist to begin with, which is
   * a stronger guarantee than "existing, but always filtered out
   * correctly" — one less place a future read could forget the filter.
   * `AssignmentStore.writeDecision`'s own contract (this file's header)
   * already says GSI1's projection is derived from
   * `patient.assigned_clinician_id` alone; this method changes nothing
   * about that contract, it is simply the second caller of it.
   */
  async reassign(
    patientId: string,
    assignedClinicianId: string,
    actor: ActorContext,
  ): Promise<ReassignmentDecision> {
    const patient = await this.requirePatient(patientId);
    if (patient.account_status !== 'approved' || !patient.assigned_clinician_id) {
      throw new AppError(
        'NOT_ASSIGNED',
        `patient ${patientId} is not currently assigned — use approve, not reassignment`,
      );
    }
    const previousClinicianId = patient.assigned_clinician_id;

    const clinician = await this.clinicians.findById(assignedClinicianId);
    // 2026-08-31: the role check joins the status check, and for the same
    // reason — a target that cannot actually hold this patient's care.
    // `helpdesk` accounts live in the same directory and are `active`,
    // so status alone would have let one be assigned a patient, leaving
    // that patient with nobody treating them while the record claimed
    // otherwise. See `TREATING_CLINICIAN_ROLES`.
    if (
      !clinician ||
      clinician.account_status !== 'active' ||
      !TREATING_CLINICIAN_ROLES.includes(clinician.role)
    ) {
      throw new AppError(
        'CLINICIAN_NOT_AVAILABLE',
        `clinician ${assignedClinicianId} does not exist, is not active, or does not treat patients`,
      );
    }

    const now = this.clock.now().toISOString();
    const request: AssignmentRequest = {
      patientId,
      requestedAt: now,
      decidedBy: actor.subjectId,
      decidedAt: now,
      assignedClinicianId,
      status: 'approved',
      created_at: now,
      updated_at: now,
    };
    const updatedPatient: Patient = {
      ...patient,
      assigned_clinician_id: assignedClinicianId,
      updated_at: now,
    };

    await this.writeAndAudit(request, updatedPatient, actor, 'update');
    return { request, patient: unprojected(updatedPatient), previousClinicianId };
  }

  /** GSI1's own read, one hop removed from the DynamoDB shape — see AssignmentStore's own doc. */
  async listPatientIdsForClinician(clinicianId: string): Promise<string[]> {
    return this.store.listPatientIdsForClinician(clinicianId);
  }

  private async requirePatient(patientId: string): Promise<Patient> {
    const patient = await this.store.getPatient(patientId);
    if (!patient) {
      throw new AppError('RECORD_NOT_FOUND', `patient ${patientId} not found`);
    }
    return patient;
  }

  private async writeAndAudit(
    request: AssignmentRequest,
    patient: Patient,
    actor: ActorContext,
    action: 'update' | 'reject',
  ): Promise<void> {
    await this.store.writeDecision(request, patient);
    await this.audit.write(
      auditEventFor(actor, {
        at: request.decidedAt as string,
        action,
        entityType: ASSIGNMENT_ENTITY_TYPE,
        entityId: request.patientId,
      }),
    );
  }
}

/**
 * Wraps the *same* `KeyValueStore<Patient>` `PatientRepository` was built
 * with — in tests as in the real table, both repositories read and write
 * one shared patient row, never a copy of it. `ASSIGNREQ#` history and
 * GSI1's projection are modelled as separate in-memory maps, the same
 * separation the real `DynamoAssignmentStore` keeps between rows.
 */
export class InMemoryAssignmentStore implements AssignmentStore {
  private readonly requestHistory: AssignmentRequest[] = [];
  /** clinicianId -> patientIds, mirroring GSI1's own projection. */
  private readonly byClinicianId = new Map<string, Set<string>>();

  constructor(private readonly patients: { get(id: string): Promise<Patient | undefined>; put(id: string, item: Patient): Promise<void> }) {}

  async getPatient(patientId: string): Promise<Patient | undefined> {
    return this.patients.get(patientId);
  }

  async writeDecision(request: AssignmentRequest, patient: Patient): Promise<void> {
    this.requestHistory.push(request);
    // Drop this patient from every clinician's projection first — the
    // real GSI1 is derived from `assigned_clinician_id` alone, so a
    // decline (or, at 2.5.2, a reassignment) must not leave a stale entry
    // under a clinician the patient no longer belongs to.
    for (const patientIds of this.byClinicianId.values()) {
      patientIds.delete(patient.id);
    }
    if (patient.assigned_clinician_id) {
      const existing = this.byClinicianId.get(patient.assigned_clinician_id) ?? new Set<string>();
      existing.add(patient.id);
      this.byClinicianId.set(patient.assigned_clinician_id, existing);
    }
    await this.patients.put(patient.id, patient);
  }

  async listPatientIdsForClinician(clinicianId: string): Promise<string[]> {
    return [...(this.byClinicianId.get(clinicianId) ?? [])];
  }

  /** Test-only: every decision ever written, in write order — proves the append-only history directly. */
  history(): readonly AssignmentRequest[] {
    return [...this.requestHistory];
  }
}
