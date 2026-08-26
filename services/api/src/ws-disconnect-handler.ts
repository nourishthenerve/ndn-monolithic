// TASK 4.1.1 step 3: $disconnect. AWS does not guarantee this route
// fires — a lost network connection never triggers it — so the row's real
// cleanup is DynamoDB's own TTL sweep (connection-repository.ts's `ttl`,
// set at $connect); this handler is a best-effort mark, not the cleanup
// mechanism. Always returns success to API Gateway: the connection is
// already gone by the time this runs, and there is no client left to
// retry a failure to.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

import { systemClock } from './clock.js';
import { DynamoConnectionRepository } from './connection-repository.js';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const connections = new DynamoConnectionRepository({
  tableName: process.env.CONNECTION_TABLE_NAME ?? '',
  clock: systemClock,
  client,
});

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    await connections.markDisconnected(event.requestContext.connectionId);
  } catch {
    // A transient DynamoDB failure here has no retry path — API Gateway
    // does not re-invoke $disconnect — so surfacing it as a Lambda error
    // would accomplish nothing except an alarm for an event nobody can
    // act on. TTL still reclaims the row regardless.
    process.stdout.write(
      JSON.stringify({
        route: '$disconnect',
        connectionId: event.requestContext.connectionId,
        marked: false,
      }) + '\n',
    );
  }
  return { statusCode: 200 };
};
