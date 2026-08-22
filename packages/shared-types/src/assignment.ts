// TASK 2.5.1: `PAT#<id>` / `ASSIGNREQ#<ts>` — one row per decision, never
// mutated after it is written. Approving an already-declined patient (or,
// at TASK 2.5.2, reassigning an already-approved one) appends a *new* row
// rather than editing this one, which is what makes "who decided what,
// and when" answerable forever from the row sequence alone — the same
// append-only discipline `audit.ts` follows, at the domain-record layer
// rather than the audit layer.
//
// `status` overrides `BaseRecord`'s generic `RecordStatus` the same way
// `ContentItem`'s does (types.ts's own header) — this entity's lifecycle
// is never 'deleted', only ever the outcome of the one decision it records.
import type { BaseRecord } from './types.js';

export interface AssignmentRequest extends BaseRecord<'pending' | 'approved' | 'declined'> {
  patientId: string;
  requestedAt: string;
  /** The deciding clinician's subjectId. Absent only for a genuinely still-`pending` row — see this file's header: today's flow never leaves one pending. */
  decidedBy?: string;
  decidedAt?: string;
  /** Set when `status === 'approved'`. The clinician the patient is assigned to. */
  assignedClinicianId?: string;
}
