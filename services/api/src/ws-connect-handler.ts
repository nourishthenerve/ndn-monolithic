// TASK 4.1.1 step 3: the $connect route's Lambda proxy integration — runs
// only after ws-authorizer-handler.ts has already verified the token and
// resolved a Principal, so this file's whole job is one PutItem. No JWT
// verification here: the identical "the authorizer decides, the handler
// trusts the context it's handed" split every HTTP route in this codebase
// already follows (request-principal.ts) applies to this route too.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Role } from '@ndn/shared-types';
import type {
  APIGatewayEventWebsocketRequestContextV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2WithRequestContext,
} from 'aws-lambda';

import { systemClock } from './clock.js';
import { DynamoConnectionRepository } from './connection-repository.js';

// The flat string context `ws-authorizer.ts`'s `principalContext()` builds
// — `subjectId` and `role` are the only two this handler needs.
type ConnectRequestContext = APIGatewayEventWebsocketRequestContextV2 & {
  readonly authorizer: { readonly subjectId: string; readonly role: Role };
};

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const connections = new DynamoConnectionRepository({
  tableName: process.env.CONNECTION_TABLE_NAME ?? '',
  clock: systemClock,
  client,
});

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2WithRequestContext<ConnectRequestContext>,
): Promise<APIGatewayProxyResultV2> => {
  const { connectionId, authorizer } = event.requestContext;
  await connections.create({
    connectionId,
    principalId: authorizer.subjectId,
    role: authorizer.role,
  });
  return { statusCode: 200 };
};
