// TASK 3.4.1: the deployed Lambda entry for POST /patients/{id}/appointments,
// GET /clinicians/me/calendar, and GET /patients/{id}/appointments
// (infra/src/data-stack.ts) — same split every other endpoint uses:
// appointment.ts is SDK-free and unit-testable, this file wires the real
// DynamoDB-backed repositories together.

import { AppointmentRepository } from './appointment-repository.js';
import { createAppointmentHandler } from './appointment.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import {
  createPatientProfileStore,
  DynamoAppointmentStore,
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

const appointments = new AppointmentRepository(
  new DynamoAppointmentStore({ tableName }),
  audit,
  systemClock,
);

// 2026-09-01: the patient's in-app dashboard feed. Written here as a side
// effect of booking, approving, declining and cancelling — never by a
// route of its own. No `AuditWriter` is passed because the repository
// takes none; see its own header on why an echo of an already-audited
// action is not itself audited.
const notifications = new PatientNotificationRepository(
  new DynamoPatientNotificationStore({ tableName }),
  systemClock,
);

export const handler = createAppointmentHandler({
  patients,
  appointments,
  notifications,
  flags,
});
