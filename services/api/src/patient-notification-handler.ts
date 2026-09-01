// 2026-09-01: the deployed Lambda entry for `GET /patients/me/notifications`
// and `POST /patients/me/notifications/{notificationId}/read`
// (infra/src/data-stack.ts) — same split every other endpoint uses:
// patient-notification.ts is SDK-free and unit-testable, this file wires
// the real DynamoDB-backed store.
//
// **No `AuditWriter` here, and none in the repository either** — see
// patient-notification-repository.ts's own header on why an echo of an
// already-audited action is not itself an audit-worthy fact. That is also
// why this function's IAM carries no `AUDIT#*` statement, unlike every
// other writer in the stack: it has nothing to write there.
import { systemClock } from './clock.js';
import { DynamoPatientNotificationStore } from './dynamo-store.js';
import { PatientNotificationRepository } from './patient-notification-repository.js';
import { createPatientNotificationHandler } from './patient-notification.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();
const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';

const notifications = new PatientNotificationRepository(
  new DynamoPatientNotificationStore({ tableName }),
  systemClock,
);

export const handler = createPatientNotificationHandler({ notifications, flags });
