// TASK 3.4.1: the deployed Lambda entry for POST /patients/{id}/appointments,
// GET /clinicians/me/calendar, and GET /patients/{id}/appointments
// (infra/src/data-stack.ts) — same split every other endpoint uses:
// appointment.ts is SDK-free and unit-testable, this file wires the real
// DynamoDB-backed repositories together.

import { AppointmentRepository } from './appointment-repository.js';
import { createAppointmentHandler } from './appointment.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { createPatientProfileStore, DynamoAppointmentStore } from './dynamo-store.js';
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

export const handler = createAppointmentHandler({ patients, appointments, flags });
