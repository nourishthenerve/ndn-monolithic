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
// Nothing about the authorisation posture changes: still `'Patient
// profile'`'s own row, still `projectFor` on every record.
//
// ## Amendment, 2026-08-31 (later the same day) — the visitor's view
//
// This file now holds one authorisation rule that the matrix does not:
// **a `visitor` sees only `IIC`-tagged patients**, and sees only their
// name, address and completed-appointment count. `can()` cannot express
// "rows where a field equals a value", and inventing a way for it to
// would complicate every other cell to serve one case — so the narrowing
// lives here, stated in the doc's own `Visitor` cell in words, and
// enforced by two things in `listPage`: a `continue` that skips a
// non-matching record entirely (never a redacted row, which would still
// disclose that the patient exists), and an entry built by omission
// rather than by trusting a caller not to render what it was sent.
//
// Read-only, and deliberately so: the write side of GSI3's projection is
// `dynamo-store.ts`'s `DynamoAssignmentStore.writeDecision` — the same
// write that already derives GSI1's projection from
// `assigned_clinician_id` derives GSI3's from the identical field, in the
// identical write. This file has no `write*` method because there is
// nothing for it to write; a caseload is a *view* of assignment decisions
// already made elsewhere.
import type { Patient, PatientAccountStatus, PatientTag, Principal } from '@ndn/shared-types';

import type { ClinicianRepository } from './clinician-repository.js';
import { projectFor } from './projection.js';

/** The matrix row this view's own reads are governed by — the same row 'Own profile'/'Patient profile' style reads use, per step 4. */
const PATIENT_PROFILE_ENTITY_TYPE = 'patient-profile';

/**
 * 2026-08-31: the tag a `visitor` account is entitled to see. A constant,
 * not a parameter, and that is the security property: a visitor cannot
 * ask for another programme's patients because there is nowhere in the
 * request to ask. If a second partner ever needs an account, this becomes
 * a field on the `CLI#` record and is read from the caller's own
 * directory entry — still never from the request.
 */
const VISITOR_TAG: PatientTag = 'IIC';

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
  /**
   * How many appointments this patient has, all told — the shared
   * `countsTowardTotal` rule (`@ndn/shared-types`), which is `scheduled`,
   * `completed` and `no-show` and never `cancelled` or
   * `pending-approval`. One bounded Query on the patient's own partition.
   *
   * Called only for a `visitor`, whose whole view this is; nobody else's
   * page shows the number, and computing it for everyone would be a query
   * per patient per dashboard load to render nothing.
   *
   * **2026-09-01: was `countCompletedAppointments`.** The owner asked for
   * "total number of appointments", and the rule now lives in
   * shared-types so this figure and the assessment form's calendar
   * section cannot drift — a visitor sees both, for the same patient.
   */
  countAppointments(patientId: string): Promise<number>;
}

export interface CaseloadEntry {
  readonly patientId: string;
  readonly fullName: string;
  readonly accountStatus: PatientAccountStatus;
  /** 2026-08-31. Absent on records written before tagging existed — see `Patient.tag`. */
  readonly tag?: PatientTag;
  /** Present for a `visitor` only: their whole view is name, address and a count. */
  readonly address?: string;
  /** 2026-09-01: every appointment that stands, not only the ones that happened — see `CaseloadStore.countAppointments`. */
  readonly totalAppointments?: number;
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
    // 2026-08-31: the one place a visitor's reach is narrowed, and the
    // reason this file's header now says the matrix is not the whole
    // story for that role. `can()` has already answered "may this caller
    // read a patient profile"; only the record itself can answer "is this
    // one theirs to see", because the answer is a field on it.
    const isVisitor = principal.role === 'visitor';
    // 2026-09-01: the second such narrowing, and the same shape. A
    // sub-clinician may now reach this view at all (`caseload.ts` names
    // their own id on the resource), and the original spec's own sentence
    // is what bounds it: "will only be able to see those patients that
    // have been assigned to him."
    //
    // Deliberately *not* done by querying GSI1 (clinician→patients)
    // instead of GSI3. GSI1 would be the cheaper read, but this view's
    // ordering, its paging cursor and its counts are all GSI3's, and
    // maintaining a second paginated path for one role would be two
    // implementations of "the dashboard" that could disagree about what a
    // page even is. Filtering here keeps one view with one order, and
    // matches how the visitor's own narrowing already works.
    const assignedOnlyTo =
      principal.role === 'sub-clinician' ? principal.clinicianId : undefined;

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
      // Skipped, not redacted: a visitor must not be able to infer that a
      // non-IIC patient exists from a row appearing with its fields
      // blanked out. An untagged record (written before tagging existed)
      // is not `IIC`, so it is skipped too — absence is never read as
      // membership.
      if (isVisitor && patient.tag !== VISITOR_TAG) {
        continue;
      }
      // Skipped for the same reason and in the same way: a clinician sees
      // their own patients, and learns nothing about anyone else's — not
      // even that they exist. An unassigned patient is skipped too, since
      // `undefined` is nobody's id.
      if (assignedOnlyTo !== undefined && patient.assigned_clinician_id !== assignedOnlyTo) {
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

      if (isVisitor) {
        // The whole of a visitor's view, built by *omission* rather than
        // by the caller choosing not to render: no email, no phone, no
        // clinical field, no status, and no clinician — the fields simply
        // never leave this method. `Appointments: R (count only)` in the
        // doc is this line: a number, never a time and never a record.
        // (The visitor's *next appointment* is on the assessment form's
        // calendar section, not here — this list is one row per patient.)
        items.push({
          patientId,
          fullName: projected.personal?.fullName ?? '',
          accountStatus: patient.account_status,
          ...(patient.tag ? { tag: patient.tag } : {}),
          ...(projected.personal?.address ? { address: projected.personal.address } : {}),
          totalAppointments: await this.store.countAppointments(patientId),
        });
        continue;
      }

      items.push({
        patientId,
        fullName: projected.personal?.fullName ?? '',
        accountStatus: patient.account_status,
        ...(patient.tag ? { tag: patient.tag } : {}),
        ...(assignedClinicianId
          ? { assignedClinicianId, assignedClinicianName: clinicianName }
          : {}),
      });
    }

    // First page only — see `CaseloadPage.counts`.
    //
    // **Withheld from a filtered viewer**, 2026-09-01. `store.count()`
    // answers "how many patients exist", which is true of the practice and
    // not of the rows this caller was shown — a clinician with three
    // patients would otherwise read "48 patients, 3 active" above a table
    // of three. For a visitor it would additionally disclose the size of a
    // directory they are only allowed to see one programme of. Omitted
    // rather than recomputed: a per-caller count is a scan of the whole
    // index, which is exactly what this view exists not to do.
    const filtered = isVisitor || assignedOnlyTo !== undefined;
    const counts = cursor === undefined && !filtered ? await this.store.count() : undefined;

    return { items, nextCursor, ...(counts ? { counts } : {}) };
  }
}
