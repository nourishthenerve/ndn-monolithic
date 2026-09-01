// TASK 3.3.1: the deployed Lambda entry for POST
// /patients/{id}/assessments/{assessmentId} (infra/src/data-stack.ts) —
// same split every other endpoint uses: assessment.ts is SDK-free and
// unit-testable, this file wires the real DynamoDB-backed repositories
// together.

import { AppointmentRepository } from './appointment-repository.js';
import { AssessmentRepository } from './assessment-repository.js';
import { createAssessmentHandler } from './assessment.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import {
  createPatientProfileStore,
  DynamoAppointmentStore,
  DynamoAssessmentStore,
  DynamoPatientNotificationStore,
} from './dynamo-store.js';
import { PatientNotificationRepository } from './patient-notification-repository.js';
import { PatientRepository } from './patient-repository.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const patients = new PatientRepository(
  createPatientProfileStore(tableName),
  audit,
  systemClock,
);

const assessments = new AssessmentRepository(
  new DynamoAssessmentStore({ tableName }),
  audit,
  systemClock,
);

// 2026-09-01: read-only here, and the calendar section is why — its "next
// appointment", "sessions so far" and "awaiting approval" figures are
// derived from the `APPT#` rows on every read rather than stored. Booking
// stays on the appointment endpoints; this function's IAM grants it
// `Query` on the patient partition and nothing that could write one.
const appointments = new AppointmentRepository(
  new DynamoAppointmentStore({ tableName }),
  audit,
  systemClock,
);

// A calendar-section edit is a calendar change, so it notifies the patient
// exactly as booking does — see assessment.ts's own write path for why
// only that one section triggers a notice.
const notifications = new PatientNotificationRepository(
  new DynamoPatientNotificationStore({ tableName }),
  systemClock,
);

export const handler = createAssessmentHandler({
  patients,
  assessments,
  appointments,
  notifications,
  flags,
});
