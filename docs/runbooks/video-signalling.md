# WebSocket signalling channel: connect, disconnect, the connection table (TASK 4.1.1)

**Date:** 2026-08-26 · **Task:** [05-execution-plan.md § TASK 4.1.1](../plan/05-execution-plan.md) · **Requirements:** D-12 · **Decisions:** ADR-0007 (amended by this task) · **Depends on:** 2.2.1, 2.2.2 · **Blocks:** every later Phase 4 task

## What this covers

The first WebSocket surface this codebase has built, and the foundation every other Phase 4 task (call authorisation, the signalling relay, the peer connection) is laid on. An authenticated patient or clinician can open a `wss://` connection, have it recorded in a DynamoDB connection row, and close it cleanly — nothing about a call itself exists yet (no join message, no relay, no peer connection). `docs/adr/0007-signalling.md`'s amendment records the one real constraint this task surfaced: a browser's `WebSocket` constructor cannot set an `Authorization` header on the handshake, so the Cognito ID token rides as `?token=` on the connect URL instead.

## What was built

- **`packages/shared-types/src/connection.ts`** — `Connection`, the `CONN#<connectionId>` / `PROFILE` row shape. `status: 'connected' | 'disconnected'`, no `private{}` half, `ttl` (epoch seconds) is the only cleanup mechanism.
- **`services/api/src/authorizer.ts`** (amended) — the verify → look-up → role-resolve pipeline factored out into `resolvePrincipal`, exported alongside `principalContext`, so the WebSocket authorizer reuses the identical two-pool check rather than a second implementation. `createAuthorizer`'s external behaviour is unchanged — every pre-existing test in `authorizer.test.ts` passes with no edit.
- **`services/api/src/ws-authorizer.ts`** — `createWebSocketAuthorizer`: the WebSocket-shaped twin of `authorizer.ts`. Reads the token from `event.queryStringParameters.token` instead of a header, returns an IAM policy document (`{principalId, policyDocument, context}`) instead of the HTTP APIs' `{isAuthorized, context}` simple format — `WebSocketLambdaAuthorizer` offers no simple-response option, so the two response shapes cannot share one deployed Lambda. Also the one place in this codebase that reads a feature flag (`video.signalling.enabled`) *in* an authorizer rather than in a route's business logic — there is no downstream handler to 404 once a socket is open, so "flag off" has to deny the connect itself.
- **`services/api/src/ws-authorizer-handler.ts`** — the deployed Lambda entry (`WsAuthorizerFunction`), thin AWS wiring only, mirroring `authorizer-handler.ts`.
- **`services/api/src/connection-repository.ts`** — `DynamoConnectionRepository`: `create` (PutItem, sets `ttl` to `created_at` + 12h), `markDisconnected` (UpdateItem, conditioned on `attribute_exists(pk)` so a disconnect can never create a phantom row; a `ConditionalCheckFailedException` is swallowed, not thrown — the row being already gone is not an error), `findById` (GetItem, for a later Phase 4 task to resolve a `connectionId` back to a principal). No `AuditWriter` dependency — a connection row is operational metadata, not an `AuditAction`.
- **`services/api/src/ws-connect-handler.ts`** / **`ws-disconnect-handler.ts`** / **`ws-default-handler.ts`** — the three route handlers. `$connect` trusts the context the authorizer already resolved and writes one row. `$disconnect` marks the row and always returns `{statusCode: 200}` regardless of outcome — AWS does not guarantee this route fires, and there is no client left to retry a failure to. `$default` is a stub that accepts and does nothing — message relay is TASK 4.2.2's job.
- **`infra/src/ws-authorizer.ts`** — `createWebSocketConnectAuthorizer`: pure CDK wiring, no runtime logic, wraps a handed-in Lambda in `WebSocketLambdaAuthorizer` with `identitySource: ['route.request.querystring.token']`.
- **`infra/src/data-stack.ts`** — the table gains `timeToLiveAttribute: 'ttl'` (additive, in-place — `TimeToLiveSpecification` is a mutable CloudFormation property, no replacement). Four new functions/roles (`WsAuthorizerFunction`, `WsConnectFunction`, `WsDisconnectFunction`, `WsDefaultFunction` — one more pair than the task's own text names, because the WebSocket authorizer cannot share the HTTP one's deployed Lambda and `$default` needs a route to deploy at all). A new `SignallingWebSocketApi` (`AWS::ApiGatewayV2::Api`, `ProtocolType: WEBSOCKET`) with `$connect`/`$disconnect`/`$default` routes and a `SignallingWebSocketStage` carrying **no** `accessLogSettings` — deliberate, not defaulted, since the token rides in the connect URL.
- **`infra/src/config.ts`** — the four new log groups added to `UNMONITORED_LOG_GROUP_NAMES`, displacing nothing (lowest volume in the estate, behind a default-off flag).

## Verification steps

Once `video.signalling.enabled` is turned on for a target environment:

```sh
# Resolve a real Cognito ID token first (see docs/runbooks/web-authentication.md), then:
wscat -c "wss://<api-id>.execute-api.eu-west-2.amazonaws.com/\$default?token=<id-token>"
```

- A valid token completes a normal handshake. `aws dynamodb get-item --table-name <table> --key '{"pk":{"S":"CONN#<connectionId>"},"sk":{"S":"PROFILE"}}'` shows the row with a `ttl` a few hours out.
- An invalid or expired token is refused before the connection opens — no row is written (confirm the same `get-item` call returns nothing).
- Closing the client connection, then re-running the same `get-item`, shows `status: "disconnected"` and a `disconnectedAt` — the row itself is still there, never removed.
- `aws dynamodb describe-table --table-name <table> --query TimeToLiveDescription` confirms `TimeToLiveStatus: ENABLED`, `AttributeName: ttl`.

## What was deliberately not built here

- **No join message, no call authorisation, no relay.** `$default` is a stub. TASK 4.2.1/4.2.2 build the actual call flow on top of this connection table.
- **No `DeleteItem` anywhere, for any reason.** `$disconnect` marks a row; it is never removed by application code. DynamoDB's own background TTL sweep is the only reclaim mechanism, the same pattern `log-retention-volume-control.md` already establishes for CloudWatch log expiry, used here for the first time on a table row.
- **No persistent audit trail for a connection.** `connection-repository.ts`'s own header states why — operational metadata, not a clinical or personal record, not an `AuditAction`.
- **No reuse of the HTTP `AuthorizerFunction` Lambda.** `WebSocketLambdaAuthorizer`'s IAM-policy-only response contract rules it out; see `docs/adr/0007-signalling.md`'s amendment.

## Cost

$0.01/month at M6, $0.02/month at M12 — `03-cost-model.md`'s API Gateway WebSocket line, live-priced at Gate G3 (2026-08-26) ahead of this task and unchanged by it: $1.00/million messages + $0.25/million connection-minutes, `eu-west-2` standard rate, no free tier assumed.
