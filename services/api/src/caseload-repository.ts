// TASK 2.5.3: FR-DP-02's cross-caseload admin view — the principal
// clinician sees every patient across every clinician's caseload, one
// paginated list, grouped by clinician (GSI3's own sort order —
// docs/adr/0002-database.md's proof).
//
// ## Amendment, 2026-08-31 — this is the patient directory, not just the
// assigned caseload
//
// The owner asked for "an overall dashboard showing how many patients are
// there in the system with active ones being at the top", which this view
// could not answer in either half: it had no count, and it structurally
// could not list an unassigned patient, because GSI3 was sparse on
// `assigned_clinician_id`. Both are now GSI3's job (dynamo-store.ts's own
// amendment on that index) — the index carries every patient, ranked by
// status — and this file's two changes follow from it: an unassigned
// patient is a row with no clinician rather than a row that is skipped,
// and `listPage` asks the store for the two counts on the first page.
// Nothing about the authorisation posture changes: still Principal-only,
// still `'Patient profile'`'s own row, still `projectFor` on every record.
//
// Read-only, and deliberately so: the write side of GSI3's projection is
// `dynamo-store.ts`'s `DynamoAssignmentStore.writeDecision` — the same
// write that already derives GSI1's projection from
// `assigned_clinician_id` derives GSI3's from the identical field, in the
// identical write. This file has no `write*` method because there is
// nothing for it to write; a caseload is a *view* of assignment decisions
// already made elsewhere.
import type { Patient, PatientAccountStatus, Principal } from '@ndn/shared-types';

import type { ClinicianRepository } from './clinician-repository.js';
import { projectFor } from './projection.js';

/** The matrix row this view's own reads are governed by — the same row 'Own profile'/'Patient profile' style reads use, per step 4. */
const PATIENT_PROFILE_ENTITY_TYPE = 'patient-profile';

export interface CaseloadStore {
  /**
   * One page of GSI3, in the index's own order — active patients first,
   * then grouped by clinician within each status rank. Never a `Scan`,
   * never more than `limit` rows read.
   */
  queryPage(cursor: string | undefined, limit: number): Promise<{ patientIds: string[]; nextCursor?: string }>;
  getPatient(patientId: string): Promise<Patient | undefined>;
  /** How many patients exist, and how many of those are active — the dashboard's own header figures. */
  count(): Promise<CaseloadCounts>;
}

export interface CaseloadEntry {
  readonly patientId: string;
  readonly fullName: string;
  readonly accountStatus: PatientAccountStatus;
  /**
   * Absent for a patient nobody is responsible for yet — a freshly
   * registered `pending` account, or a `declined` one. Before 2026-08-31
   * such a patient could not appear in this view at all (GSI3 was sparse
   * on assignment); they are exactly the rows the principal most needs to
   * act on, so the field is optional rather than the row being dropped.
   */
  readonly assignedClinicianId?: string;
  readonly assignedClinicianName?: string;
}

export interface CaseloadCounts {
  readonly total: number;
  readonly active: number;
}

export interface CaseloadPage {
  readonly items: readonly CaseloadEntry[];
  readonly nextCursor?: string;
  /**
   * Present on the first page only. A count is a fact about the whole
   * directory, not about the page in hand — re-counting it on every page
   * turn would be two extra Queries to tell the caller something it was
   * already told, and the UI shows it once, above the table.
   */
  readonly counts?: CaseloadCounts;
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
    // clinician (GSI3 sorts by clinician within a status rank for exactly
    // this reason), and re-fetching the same clinician's name once per
    // patient would be a wasted read every time.
    const clinicianNames = new Map<string, string>();
    const items: CaseloadEntry[] = [];

    for (const patientId of patientIds) {
      const patient = await this.store.getPatient(patientId);
      // A patient can disappear between the index read and this GetItem —
      // GSI3 is eventually consistent with the write that produced it, so
      // a row with no record behind it is skipped rather than surfaced
      // stale. Missing an *assignment* is no longer a reason to skip:
      // since 2026-08-31 an unassigned patient is a first-class row here
      // (see `CaseloadEntry.assignedClinicianId`).
      if (!patient) {
        continue;
      }
      const projected = projectFor(principal, patient, {
        entityType: PATIENT_PROFILE_ENTITY_TYPE,
        assignedClinicianId: patient.assigned_clinician_id,
      });

      const assignedClinicianId = patient.assigned_clinician_id;
      let clinicianName: string | undefined;
      if (assignedClinicianId) {
        clinicianName = clinicianNames.get(assignedClinicianId);
        if (clinicianName === undefined) {
          const clinician = await this.clinicians.findById(assignedClinicianId);
          clinicianName = clinician?.displayName ?? assignedClinicianId;
          clinicianNames.set(assignedClinicianId, clinicianName);
        }
      }

      items.push({
        patientId,
        fullName: projected.personal?.fullName ?? '',
        accountStatus: patient.account_status,
        ...(assignedClinicianId
          ? { assignedClinicianId, assignedClinicianName: clinicianName }
          : {}),
      });
    }

    // First page only — see `CaseloadPage.counts`.
    const counts = cursor === undefined ? await this.store.count() : undefined;

    return { items, nextCursor, ...(counts ? { counts } : {}) };
  }
}
