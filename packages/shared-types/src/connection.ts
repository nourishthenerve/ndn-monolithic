// TASK 4.1.1: docs/plan/04-data-model-rbac.md's `CONN#<connectionId>` /
// `PROFILE` row — operational metadata for an open or recently-closed
// WebSocket, not a clinical or personal record. No `private{}` half
// (containsPrivateField, services/api/src/projection.ts, confirms this at
// every write, the same no-op-now/closed-door-later reasoning every prior
// entity carries) and no audit wiring — connection-repository.ts's own
// header states why this is not an `AuditAction` (audit.ts, TASK 2.1.3).
import type { Role } from './principal.js';
import type { BaseRecord } from './types.js';

export type ConnectionStatus = 'connected' | 'disconnected';

export interface Connection extends BaseRecord<ConnectionStatus> {
  readonly connectionId: string;
  /** The Cognito `sub` that authenticated this socket — `Principal.subjectId`, not a `patientId`/`clinicianId`. */
  readonly principalId: string;
  readonly role: Role;
  status: ConnectionStatus;
  /** `created_at` doubles as "connectedAt" — set once, by $connect, never rewritten. */
  readonly created_at: string;
  /** Set once, by $disconnect, on the same row $connect created — never a second row. Absent while still connected. */
  disconnectedAt?: string;
  /**
   * DynamoDB native TTL — epoch seconds, `created_at` + 12h, set once at
   * $connect and never extended. The only cleanup mechanism this row has:
   * no code path issues `DeleteItem` against it, ever — DynamoDB's own
   * background TTL sweep reclaims the row instead.
   */
  readonly ttl: number;
}
