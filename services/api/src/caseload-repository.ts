// TASK 2.5.3: FR-DP-02's cross-caseload admin view — the principal
// clinician sees every patient across every clinician's caseload, one
// paginated list, grouped by clinician (GSI3's own sort order —
// docs/adr/0002-database.md's proof).
//
// Read-only, and deliberately so: the write side of GSI3's projection is
// `dynamo-store.ts`'s `DynamoAssignmentStore.writeDecision` — the same
// write that already derives GSI1's projection from
// `assigned_clinician_id` derives GSI3's from the identical field, in the
// identical write. This file has no `write*` method because there is
// nothing for it to write; a caseload is a *view* of assignment decisions
// already made elsewhere.
import type { Patient, Principal } from '@ndn/shared-types';

import type { ClinicianRepository } from './clinician-repository.js';
import { projectFor } from './projection.js';

/** The matrix row this view's own reads are governed by — the same row 'Own profile'/'Patient profile' style reads use, per step 4. */
const PATIENT_PROFILE_ENTITY_TYPE = 'patient-profile';

export interface CaseloadStore {
  /** One page of GSI3, sorted by clinician. Never a `Scan`, never more than `limit` rows read. */
  queryPage(cursor: string | undefined, limit: number): Promise<{ patientIds: string[]; nextCursor?: string }>;
  getPatient(patientId: string): Promise<Patient | undefined>;
}

export interface CaseloadEntry {
  readonly patientId: string;
  readonly fullName: string;
  readonly assignedClinicianId: string;
  readonly assignedClinicianName: string;
}

export interface CaseloadPage {
  readonly items: readonly CaseloadEntry[];
  readonly nextCursor?: string;
}

export class CaseloadRepository {
  constructor(
    private readonly store: CaseloadStore,
    private readonly clinicians: ClinicianRepository,
  ) {}

  /**
   * Only ever reaches this far when `can()` has already granted the
   * `Principal` column — this method trusts the caller to have checked,
   * the same contract every other repository in this codebase keeps.
   *
   * `principal` is still a parameter, not dropped once authorised:
   * step 4's projection is a data-shaping decision `projectFor` needs the
   * caller's identity for, and it is a *different* question from "may this
   * caller reach this method at all" — `can()` already answered that one.
   * `Patient` carries no `private{}` field today, so this is a no-op in
   * practice; it is here so that stays true by construction the day one is
   * added, not by someone remembering to revisit this file.
   */
  async listPage(principal: Principal, cursor: string | undefined, limit: number): Promise<CaseloadPage> {
    const { patientIds, nextCursor } = await this.store.queryPage(cursor, limit);

    // Per-page cache: several patients on one page routinely share a
    // clinician (GSI3 sorts by clinician for exactly this reason), and
    // re-fetching the same clinician's name once per patient would be a
    // wasted read every time.
    const clinicianNames = new Map<string, string>();
    const items: CaseloadEntry[] = [];

    for (const patientId of patientIds) {
      const patient = await this.store.getPatient(patientId);
      // A patient can fall out of the caseload between the index read and
      // this GetItem (declined, reassigned, deactivated clinician) — GSI3
      // is eventually consistent with the write that produced it, so a
      // row that no longer belongs is skipped rather than surfaced stale.
      if (!patient || !patient.assigned_clinician_id) {
        continue;
      }
      const projected = projectFor(principal, patient, {
        entityType: PATIENT_PROFILE_ENTITY_TYPE,
        assignedClinicianId: patient.assigned_clinician_id,
      });

      let clinicianName = clinicianNames.get(patient.assigned_clinician_id);
      if (clinicianName === undefined) {
        const clinician = await this.clinicians.findById(patient.assigned_clinician_id);
        clinicianName = clinician?.displayName ?? patient.assigned_clinician_id;
        clinicianNames.set(patient.assigned_clinician_id, clinicianName);
      }

      items.push({
        patientId,
        fullName: projected.personal?.fullName ?? '',
        assignedClinicianId: patient.assigned_clinician_id,
        assignedClinicianName: clinicianName,
      });
    }

    return { items, nextCursor };
  }
}
