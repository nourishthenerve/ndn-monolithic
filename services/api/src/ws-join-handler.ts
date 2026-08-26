// TASK 4.2.1: the deployed wiring for a `{ type: 'join', appointmentId }`
// WebSocket message — `ws-default-handler.ts` is the $default route's real
// entry point (it validates the message shape and dispatches by `type`);
// this file owns the whole of *handling* a join once dispatched to,
// mirroring `ws-connect-handler.ts`'s own "fully self-contained response"
// shape rather than splitting decision from delivery across two files.
//
// The one thing this file does that no other handler in this codebase has
// needed yet: pushing a message back down an already-open connection.
// `$default`'s Lambda proxy return value is not delivered to the client —
// unlike $connect/$disconnect, where the return value *is* the handshake
// response — so the only way to answer the caller on their own socket is
// `ApiGatewayManagementApiClient`'s `PostToConnectionCommand`, addressed by
// `connectionId`.
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { AppointmentRepository } from './appointment-repository.js';
import { hashSourceIp } from './audit.js';
import { systemClock } from './clock.js';
import { DynamoConnectionRepository } from './connection-repository.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoPrincipalDirectory } from './dynamo-principal-directory.js';
import { DynamoAppointmentStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createJoinMessageHandler, type JoinResult } from './ws-join.js';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';

const connections = new DynamoConnectionRepository({ tableName, clock: systemClock, client });
const directory = new DynamoPrincipalDirectory({ tableName, client });
const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '', client });
const appointments = new AppointmentRepository(
  new DynamoAppointmentStore({ tableName, client }),
  audit,
  systemClock,
);
const flags = createSsmFlagReader();

const join = createJoinMessageHandler({
  directory,
  appointments,
  connections,
  audit,
  clock: systemClock,
  flags,
});

/**
 * The subset of a real WebSocket message event this file needs, named
 * structurally rather than by importing one specific `@types/aws-lambda`
 * shape — the real event carries `requestContext.identity.sourceIp`
 * (confirmed against AWS's own WebSocket event documentation) even though
 * the community types' "V2" WebSocket event omits it; declaring only what
 * is read here avoids depending on either package's exact naming.
 */
export interface JoinRequestEvent {
  readonly requestContext: {
    readonly connectionId: string;
    readonly domainName: string;
    readonly stage: string;
    readonly requestId: string;
    readonly identity?: { readonly sourceIp?: string };
  };
}

// One management-API client for the container's lifetime — domainName/stage
// are stable for the life of a deployment (there is exactly one WebSocket
// API in this app), the same "construct once per container, not per
// invocation" reasoning jwt-verify.ts's memoiseVerifier states generally.
let managementClient: ApiGatewayManagementApiClient | undefined;
function managementApiClientFor(domainName: string, stage: string): ApiGatewayManagementApiClient {
  return (managementClient ??= new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  }));
}

async function postToConnection(
  management: ApiGatewayManagementApiClient,
  connectionId: string,
  payload: JoinResult,
): Promise<void> {
  try {
    await management.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  } catch {
    // The caller's own socket may already be gone by the time this runs
    // (a join denial and a disconnect racing each other) — nothing
    // actionable follows from that, and there is no second caller to
    // retry a failure to. Identifiers only, never the payload.
    process.stdout.write(
      JSON.stringify({ route: '$default', type: 'join', connectionId, posted: false }) + '\n',
    );
  }
}

/**
 * `ws-default-handler.ts`'s only call into this file — everything else
 * here is wiring. `appointmentId` arrives already Zod-validated as a
 * non-empty string; this function's own job starts at "which connection
 * sent this."
 */
export async function handleJoinRequest(
  event: JoinRequestEvent,
  appointmentId: string,
): Promise<void> {
  const { connectionId, domainName, stage, requestId, identity } = event.requestContext;
  const management = managementApiClientFor(domainName, stage);

  const connection = await connections.findById(connectionId);
  if (!connection) {
    // No identity to authorise or audit against — a $default message
    // cannot arrive without a connection row existing (it was written at
    // $connect before this route could ever be reached), so this is
    // unreachable in practice rather than a real deny path; still denies
    // cleanly rather than crashing, the same "an internal failure is a
    // denial" discipline authorizer.ts's own directory-lookup catch keeps.
    await postToConnection(management, connectionId, {
      type: 'join-denied',
      reason: 'not-your-appointment',
    });
    return;
  }

  const result = await join({
    connectionId,
    connection: { principalId: connection.principalId, role: connection.role, ttl: connection.ttl },
    appointmentId,
    origin: {
      requestId,
      sourceIpHash: hashSourceIp(identity?.sourceIp ?? 'unknown'),
    },
  });

  await postToConnection(management, connectionId, result);
}
