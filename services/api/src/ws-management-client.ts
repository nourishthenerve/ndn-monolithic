// TASK 4.2.1 built this memoisation once, inline in ws-join-handler.ts;
// TASK 4.2.2's ws-relay-handler.ts needs the identical client, and both
// files run inside the same Lambda container — WsDefaultFunction, the
// $default route's one deployed function, handling `join` and
// `offer`/`answer`/`ice-candidate`/`leave` alike (ws-default-handler.ts's
// own dispatcher). Two separately-cached clients in one process would
// still work, just wastefully; one shared cache is the same "construct
// once per container, not per invocation" reasoning jwt-verify.ts's
// memoiseVerifier states generally, applied here to whichever handler
// reaches this first.
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';

let managementClient: ApiGatewayManagementApiClient | undefined;

/** domainName/stage are stable for the life of a deployment — there is exactly one WebSocket API in this app. */
export function managementApiClientFor(domainName: string, stage: string): ApiGatewayManagementApiClient {
  return (managementClient ??= new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  }));
}
