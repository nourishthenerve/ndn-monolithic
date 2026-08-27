// TASK 4.2.2: the deployed wiring for `{ appointmentId, type: 'offer' |
// 'answer' | 'ice-candidate' | 'leave', payload }` — `ws-default-handler.ts`
// validates the message shape and dispatches here; this file owns the
// whole of relaying it once dispatched to, mirroring ws-join-handler.ts's
// own "fully self-contained response" shape.
//
// The payload itself is never logged — only `type` and `appointmentId` —
// an SDP payload can carry network-topology information about a caller's
// device, the first plausibly-sensitive shape this discipline has met
// since `00-conventions.md` first stated "identifiers only."
//
// TASK 4.4.2: the one AWS-specific step `ws-relay.ts`'s own SDK-free
// estimate can't do itself — emitting the `EstimatedTurnRelayGB` custom
// metric `infra/src/budget-stack.ts`'s new alarm watches. A metric-emission
// failure never fails the relay itself, the same "an internal failure here
// is not a reason to break the call" discipline this file already keeps
// for a `GoneException` below.
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { systemClock } from './clock.js';
import { DynamoConnectionRepository } from './connection-repository.js';
import { managementApiClientFor } from './ws-management-client.js';
import { createRelayMessageHandler, type RelayMessageType } from './ws-relay.js';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.CONNECTION_TABLE_NAME ?? '';

const connections = new DynamoConnectionRepository({ tableName, clock: systemClock, client });

const relay = createRelayMessageHandler({ connections });

// Mirrors infra/src/config.ts's TURN_RELAY_METRIC_NAMESPACE/
// TURN_RELAY_METRIC_NAME — those constants are what budget-stack.ts's own
// alarm reads; the literals here are the identical strings, duplicated
// rather than imported since services/api and infra are two separate
// deployables with no shared runtime package between them for this value
// (the same convention contact-form-handler.ts documents for a secret
// parameter name).
const TURN_RELAY_METRIC_NAMESPACE = 'Ndn/Video';
const TURN_RELAY_METRIC_NAME = 'EstimatedTurnRelayGB';

const cloudWatchClient = new CloudWatchClient({});

async function recordEstimatedTurnRelay(estimatedGb: number): Promise<void> {
  try {
    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: TURN_RELAY_METRIC_NAMESPACE,
        MetricData: [
          {
            MetricName: TURN_RELAY_METRIC_NAME,
            Value: estimatedGb,
            Unit: 'Gigabytes',
            Timestamp: new Date(),
          },
        ],
      }),
    );
  } catch {
    // A missed data point degrades the alarm's own early-warning margin,
    // never the call this metric is only ever a side-effect of reporting.
  }
}

/** The subset of a real WebSocket message event this file needs — the identical structural shape ws-join-handler.ts's own `JoinRequestEvent` names, minus the fields relaying has no use for. */
export interface RelayRequestEvent {
  readonly requestContext: {
    readonly connectionId: string;
    readonly domainName: string;
    readonly stage: string;
  };
}

export interface RelayMessage {
  readonly appointmentId: string;
  readonly type: RelayMessageType;
  readonly payload: unknown;
}

function logIdentifiersOnly(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ route: '$default', ...fields }) + '\n');
}

/**
 * `ws-default-handler.ts`'s only call into this file — everything else
 * here is wiring. The message arrives already Zod-validated; this
 * function's own job starts at "who sent this, and are they one of this
 * call's two authorised parties."
 */
export async function handleRelayMessage(event: RelayRequestEvent, message: RelayMessage): Promise<void> {
  const { connectionId, domainName, stage } = event.requestContext;
  const management = managementApiClientFor(domainName, stage);

  const decision = await relay({
    appointmentId: message.appointmentId,
    senderConnectionId: connectionId,
    type: message.type,
    payload: message.payload,
  });

  if (decision.kind === 'not-authorised') {
    // No lookup beyond the CALL# query above runs, and nothing is sent
    // back — there is no authorised recipient for a sender who never
    // joined this call, and unlike 4.2.1's own join decision this is not
    // an access decision worth auditing: the join itself already recorded
    // that fact, once, when it happened (or didn't).
    logIdentifiersOnly({ type: message.type, appointmentId: message.appointmentId, relayed: false });
    return;
  }

  if (decision.estimatedTurnRelayGb !== undefined) {
    await recordEstimatedTurnRelay(decision.estimatedTurnRelayGb);
  }

  if (decision.kind === 'peer-unavailable') {
    await postToConnection(management, connectionId, { type: 'peer-unavailable' });
    return;
  }

  try {
    await management.send(
      new PostToConnectionCommand({
        ConnectionId: decision.targetConnectionId,
        Data: new TextEncoder().encode(
          JSON.stringify({ appointmentId: message.appointmentId, type: message.type, payload: message.payload }),
        ),
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'GoneException') {
      // A stale connectionId whose row `ttl` has not yet expired — the
      // identical soft-mark $disconnect itself makes, never a delete.
      await connections.markDisconnected(decision.targetConnectionId);
      logIdentifiersOnly({
        type: message.type,
        appointmentId: message.appointmentId,
        relayed: false,
      });
      return;
    }
    throw error;
  }
}

async function postToConnection(
  management: ApiGatewayManagementApiClient,
  connectionId: string,
  payload: { type: 'peer-unavailable' },
): Promise<void> {
  try {
    await management.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  } catch {
    // The sender's own socket may already be gone by the time this runs —
    // nothing actionable follows, the same "identifiers only, no retry"
    // discipline ws-join-handler.ts's own postToConnection already keeps.
    logIdentifiersOnly({ connectionId, posted: false });
  }
}
