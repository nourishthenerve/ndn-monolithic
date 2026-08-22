// TASK 2.1.3: the deployed Lambda entry for `GET /audit?date=`
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// audit-read.ts is SDK-free and unit-testable, this file is the only place
// that wires the real DynamoDB-backed reader and the real principal source.
//
// **The principal source is a bridge, and it is temporary.** TASK 2.2.2
// builds the Lambda authorizer that verifies a Cognito token and resolves a
// real `Principal`; until it exists there is no identity system to resolve
// one from, exactly as admin-auth.ts has said since TASK 1.3.2 ("no user
// identity, no session, no scopes — just did the caller present the one
// shared secret"). So a verified `ADMIN_API_TOKEN` stands in for the
// principal clinician here, and the stand-in is confined to this file:
// audit-read.ts asks `can()` about a `Principal` and cannot tell where it
// came from, so 2.2.2 replaces `resolvePrincipal` and changes nothing else.
//
// Two things bound the risk of that bridge. The route is behind
// `audit.readApi.enabled`, which is off, so nothing is reachable until an
// operator turns it on; and the token already authorises content
// authoring, workshop authoring and testimonial moderation — reading a log
// of one's own actions is a strictly smaller power than performing them.
import type { Principal } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { verifyAdminToken } from './admin-auth.js';
import { createAdminTokenResolver } from './admin-token.js';
import { createAuditReadHandler } from './audit-read.js';
import { DynamoAuditReader } from './dynamo-audit-log.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const getAdminToken = createAdminTokenResolver();

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts.
const flags = createSsmFlagReader();

// No client option given — DynamoAuditReader defaults to a real
// DynamoDBDocumentClient (dynamo-audit-log.ts). This function's role holds
// `dynamodb:Query` on the table and no `PutItem`, which is the other half
// of TASK 2.1.3 step 4's separation: the writers cannot read the log, and
// the reader cannot append to it.
const reader = new DynamoAuditReader({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

/**
 * The bridge. A verified admin token resolves to the principal clinician —
 * the single human who operates this clinic today and the only column of
 * docs/plan/04-data-model-rbac.md's matrix the audit row grants a read to.
 * `subjectId` is `'admin-token'` rather than a person's identifier,
 * because that is the truth about what was proven: an authorised operator,
 * not *which* one (the same sentence testimonial-moderation.ts writes into
 * its own audit rows). An unverified or absent header resolves to
 * `undefined`, which audit-read.ts answers with 401.
 */
async function resolvePrincipal(
  event: Parameters<APIGatewayProxyHandlerV2>[0],
): Promise<Principal | undefined> {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!verifyAdminToken(header, await getAdminToken())) {
    return undefined;
  }
  return {
    subjectId: 'admin-token',
    role: 'principal-clinician',
    accountStatus: 'active',
    clinicianId: 'admin-token',
  };
}

export const handler = createAuditReadHandler({ reader, flags, resolvePrincipal });
