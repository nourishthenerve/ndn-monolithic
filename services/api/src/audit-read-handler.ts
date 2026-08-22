// TASK 2.1.3: the deployed Lambda entry for `GET /audit?date=`
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// audit-read.ts is SDK-free and unit-testable, this file is the only place
// that wires the real DynamoDB-backed reader and the real principal source.
//
// TASK 2.5.4 is the replacement this file's own header predicted: the real
// Lambda authorizer (2.2.2) sits behind this route by default now (no
// `authorizer:` override in data-stack.ts), so `resolvePrincipal` reads it
// straight off the event via `optionalPrincipal` — the non-throwing form,
// since this route's own 401 is a response, not an exception.
// audit-read.ts itself asks `can()` about a `Principal` and never knew
// where it came from, so nothing there changes.
import { createAuditReadHandler } from './audit-read.js';
import { DynamoAuditReader } from './dynamo-audit-log.js';
import { optionalPrincipal } from './request-principal.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts.
const flags = createSsmFlagReader();

// No client option given — DynamoAuditReader defaults to a real
// DynamoDBDocumentClient (dynamo-audit-log.ts). This function's role holds
// `dynamodb:Query` on the table and no `PutItem`, which is the other half
// of TASK 2.1.3 step 4's separation: the writers cannot read the log, and
// the reader cannot append to it.
const reader = new DynamoAuditReader({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

// `optionalPrincipal` is synchronous; `resolvePrincipal`'s contract is
// `Promise<Principal | undefined>` (audit-read.ts's own deliberate async
// shape, so a future async principal source needs no interface change) —
// wrapped rather than widened.
export const handler = createAuditReadHandler({
  reader,
  flags,
  resolvePrincipal: async (event) => optionalPrincipal(event),
});
