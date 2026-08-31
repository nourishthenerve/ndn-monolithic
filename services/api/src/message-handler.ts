// TASK 3.6.1: the deployed Lambda entry for POST /patients/{id}/messages
// and GET /patients/{id}/messages (infra/src/data-stack.ts). Same split
// every other endpoint uses: message.ts is SDK-free and unit-testable,
// this file wires the real DynamoDB-backed repositories.
//
// D-32 (2026-08-30): the Notifier/SES wiring this file used to construct
// for the "you have a new message" notice — and the one Cognito
// `AdminGetUser` call that resolved an assigned clinician's email for it
// — are deleted along with the notice itself. This function now touches
// nothing outside DynamoDB.

import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { createPatientProfileStore, DynamoMessageStore } from './dynamo-store.js';
import { MessageRepository } from './message-repository.js';
import {
  MESSAGE_RATE_LIMIT_PER_PRINCIPAL,
  MESSAGE_RATE_LIMIT_WINDOW_MS,
  createMessageHandler,
} from './message.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const patients = new PatientRepository(
  createPatientProfileStore(tableName),
  audit,
  systemClock,
);

const messages = new MessageRepository(new DynamoMessageStore({ tableName }), audit, systemClock);

// One rate limiter per warm Lambda container — resets on cold start, the
// same accepted limitation this codebase's own low-volume, authenticated
// traffic already tolerates elsewhere: this feature's volume (a signed-in
// patient/clinician's own conversation) doesn't justify a persistent
// counter the way TASK 3.4.3's real SMS spend cap did.
const rateLimiter: RateLimiter = new InMemoryRateLimiter({
  clock: systemClock,
  limit: MESSAGE_RATE_LIMIT_PER_PRINCIPAL,
  windowMs: MESSAGE_RATE_LIMIT_WINDOW_MS,
});

export const handler = createMessageHandler({
  patients,
  messages,
  flags,
  rateLimiter,
});
