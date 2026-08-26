# WebSocket signalling channel: connect, disconnect, the connection table, and the call join (TASK 4.1.1, TASK 4.2.1)

**Date:** 2026-08-26 · **Tasks:** [05-execution-plan.md § TASK 4.1.1](../plan/05-execution-plan.md), § TASK 4.2.1 · **Requirements:** D-12, R-03 (TASK 4.2.1) · **Decisions:** ADR-0007 (amended by TASK 4.1.1) · **Depends on:** 2.2.1, 2.2.2 (TASK 4.1.1); 4.1.1, 3.4.1, 3.4.2 (TASK 4.2.1) · **Blocks:** every later Phase 4 task

## What this covers

**TASK 4.1.1** is the first WebSocket surface this codebase has built. An authenticated patient or clinician can open a `wss://` connection, have it recorded in a DynamoDB connection row, and close it cleanly. `docs/adr/0007-signalling.md`'s amendment records the one real constraint it surfaced: a browser's `WebSocket` constructor cannot set an `Authorization` header on the handshake, so the Cognito ID token rides as `?token=` on the connect URL instead.

**TASK 4.2.1** answers the question 4.1.1 deliberately left open: a socket proves *who* is connected, not *whether they may join a given appointment's call, right now*. A `{ type: 'join', appointmentId }` message runs `can()`'s new `'join-call'` action (a stricter claim than `'read'` on the same `Appointments` row — granted only to the owning patient and the assigned sub-clinician, never the principal clinician), then checks the record is still `scheduled` and that `now` sits inside a named window around `scheduledAt`. Every attempt — allowed or denied — is audited; a denial always carries a typed reason on the same socket, never a bare close.

## What was built

- **`packages/shared-types/src/connection.ts`** — `Connection`, the `CONN#<connectionId>` / `PROFILE` row shape. `status: 'connected' | 'disconnected'`, no `private{}` half, `ttl` (epoch seconds) is the only cleanup mechanism.
- **`services/api/src/authorizer.ts`** (amended) — the verify → look-up → role-resolve pipeline factored out into `resolvePrincipal`, exported alongside `principalContext`, so the WebSocket authorizer reuses the identical two-pool check rather than a second implementation. `createAuthorizer`'s external behaviour is unchanged — every pre-existing test in `authorizer.test.ts` passes with no edit.
- **`services/api/src/ws-authorizer.ts`** — `createWebSocketAuthorizer`: the WebSocket-shaped twin of `authorizer.ts`. Reads the token from `event.queryStringParameters.token` instead of a header, returns an IAM policy document (`{principalId, policyDocument, context}`) instead of the HTTP APIs' `{isAuthorized, context}` simple format — `WebSocketLambdaAuthorizer` offers no simple-response option, so the two response shapes cannot share one deployed Lambda. Also the one place in this codebase that reads a feature flag (`video.signalling.enabled`) *in* an authorizer rather than in a route's business logic — there is no downstream handler to 404 once a socket is open, so "flag off" has to deny the connect itself.
- **`services/api/src/ws-authorizer-handler.ts`** — the deployed Lambda entry (`WsAuthorizerFunction`), thin AWS wiring only, mirroring `authorizer-handler.ts`.
- **`services/api/src/connection-repository.ts`** — `DynamoConnectionRepository`: `create` (PutItem, sets `ttl` to `created_at` + 12h), `markDisconnected` (UpdateItem, conditioned on `attribute_exists(pk)` so a disconnect can never create a phantom row; a `ConditionalCheckFailedException` is swallowed, not thrown — the row being already gone is not an error), `findById` (GetItem, for a later Phase 4 task to resolve a `connectionId` back to a principal). No `AuditWriter` dependency — a connection row is operational metadata, not an `AuditAction`.
- **`services/api/src/ws-connect-handler.ts`** / **`ws-disconnect-handler.ts`** — `$connect` trusts the context the authorizer already resolved and writes one row. `$disconnect` marks the row and always returns `{statusCode: 200}` regardless of outcome — AWS does not guarantee this route fires, and there is no client left to retry a failure to.
- **`infra/src/ws-authorizer.ts`** — `createWebSocketConnectAuthorizer`: pure CDK wiring, no runtime logic, wraps a handed-in Lambda in `WebSocketLambdaAuthorizer` with `identitySource: ['route.request.querystring.token']`.
- **`infra/src/config.ts`** — the four TASK 4.1.1 log groups added to `UNMONITORED_LOG_GROUP_NAMES`, displacing nothing (lowest volume in the estate, behind a default-off flag).

### TASK 4.2.1 additions

- **`packages/shared-types/src/principal.ts`** — `Action` gains `'join-call'`.
- **`services/api/src/authz-matrix.ts`** / **`docs/plan/04-data-model-rbac.md`** — the `Appointments` row's `Patient (own)` and `Sub-clinician (assigned)` cells gain `join-call`; `Principal` does not — the principal clinician can read every appointment but is not one of the call's two parties.
- **`services/api/src/audit.ts`** — `AUDIT_ACTIONS` gains `'join'`/`'join-denied'`, the first *read-shaped* actions this union carries. A deliberate, narrow exception to `private-field-boundary.md`'s "reads are not recorded" note.
- **`services/api/src/appointment-repository.ts`**, **`dynamo-store.ts`** — `AppointmentStore`/`AppointmentRepository` gain `get(patientId, scheduledAt)`, a single `GetItem` on the appointment's own key. No `can()`/audit gate — the caller needs the record *before* it can decide whether `can()` grants the join.
- **`services/api/src/connection-repository.ts`** — gains `recordCallJoin`, writing `CALL#<appointmentId>` / `CONN#<connectionId>` (at most two live items per call). `ttl` is passed in from the caller's own connection row, never recomputed — a call row never outlives the connection it points at.
- **`services/api/src/ws-join.ts`** — `createJoinMessageHandler`: the SDK-free decision. `JOIN_WINDOW_OPENS_BEFORE_MINUTES = 10`, `JOIN_WINDOW_CLOSES_AFTER_MINUTES = 30` (both inclusive) — named constants, not magic numbers. Denial reasons: `too-early`, `too-late`, `cancelled`, `not-your-appointment` (every `can()` denial, an unknown appointment id, and a missing directory record all fold into this one, so existence is never leaked), and `not-available` (the `video.callAuthz.enabled` flag is off — not one of the plan's own four named reasons, added because this is a real outcome a live join can reach and every denial needs a reason).
- **`services/api/src/ws-join-handler.ts`** — the AWS wiring: resolves the caller's connection (`findById`), calls the decision, and answers the caller on their own socket via `ApiGatewayManagementApiClient`'s `PostToConnectionCommand` — the first place this codebase has needed to push a message back down an already-open connection (`$default`'s Lambda proxy return value is not delivered to the client the way `$connect`/`$disconnect`'s is).
- **`services/api/src/ws-default-handler.ts`** (amended) — TASK 4.1.1's two-line stub is now the real `$default` dispatcher: Zod-validates the message shape and hands a `'join'` message to `ws-join-handler.ts`. Every message this codebase sends uses a `type` field, never `action`, so nothing ever matches a named WebSocket route — everything arrives here.
- **`infra/src/data-stack.ts`** — `WsDefaultFunction`'s role gains: `GetItem` on `CONN#*`/`PAT#*`/`CLI#*` (the connection, directory and appointment reads — the same prefix covers both a principal's profile and an appointment row, since appointments live under `PAT#<patientId>` too); `PutItem` on `CALL#*` and `AUDIT#*`; `ssm:GetParameter` for `video.callAuthz.enabled`; and `execute-api:ManageConnections` on the WebSocket stage (`WebSocketStage.grantManagementApiAccess`) — the one IAM action no other role in this stack has needed.
- **`services/api/package.json`** — new dependency, `@aws-sdk/client-apigatewaymanagementapi`, pinned to the same `3.1109.0` release train as every other `@aws-sdk/client-*` package here. **`pnpm-workspace.yaml`** gained a `@smithy/types: '4.17.0'` override: the new package's own transitive dependencies briefly pulled a second, newer copy of `@smithy/types` into the tree, which broke structural typing between it and every other `@aws-sdk/client-*` package (two installed copies of the same interface are nominally different types to TypeScript) — pinned to the version already used everywhere else so pnpm converges on one copy.

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

Once `video.callAuthz.enabled` is also turned on, over the same connection:

```json
{ "type": "join", "appointmentId": "<patientId>#<scheduledAt-iso>" }
```

- Sent by the owning patient or the assigned sub-clinician, inside the window (`scheduledAt` − 10 minutes to `scheduledAt` + 30 minutes), for a `scheduled` appointment: the socket receives `{ "type": "joined" }`, and `GET /audit?date=<today>` shows a `join` event naming the appointment and the principal.
- Sent 40 minutes early: the socket receives `{ "type": "join-denied", "reason": "too-early" }`, and the same audit query shows a `join-denied` event — a denial is recorded, not only logged.
- Sent for an appointment the caller is not a party to: `{ "type": "join-denied", "reason": "not-your-appointment" }`, audited the same way.
- `aws dynamodb query` on `CALL#<appointmentId>` (main table, no index) shows one item per successful joiner, each `CONN#<connectionId>`.

## What was deliberately not built here

- **No message relay.** `$default` now handles `join`; `offer`/`answer`/`ice-candidate`/`leave` are still unhandled — TASK 4.2.2 builds the relay on top of the `CALL#` partition this task writes.
- **No `DeleteItem` anywhere, for any reason.** `$disconnect` marks a row; a denied or successful join never removes one either. DynamoDB's own background TTL sweep is the only reclaim mechanism, the same pattern `log-retention-volume-control.md` already establishes for CloudWatch log expiry, used here for the first time on a table row.
- **No persistent audit trail for a connection itself.** `connection-repository.ts`'s own header states why — operational metadata, not a clinical or personal record, not an `AuditAction`. A *join attempt* is the one exception this codebase now carries (TASK 4.2.1), and it is audited as an attempt against the appointment, not as an event about the connection row.
- **No reuse of the HTTP `AuthorizerFunction` Lambda for $connect.** `WebSocketLambdaAuthorizer`'s IAM-policy-only response contract rules it out; see `docs/adr/0007-signalling.md`'s amendment.
- **No re-running `can()`'s decision on a second, independent path.** TASK 4.2.2's relay confirms a sender's own `principalId` is one of the `CALL#` partition's two items — it does not re-authorise the join, because two independent authorisation paths for the same decision are a way for them to drift, not a safety margin.

## Cost

$0.01/month at M6, $0.02/month at M12 — `03-cost-model.md`'s API Gateway WebSocket line, live-priced at Gate G3 (2026-08-26) ahead of TASK 4.1.1 and unchanged by it: $1.00/million messages + $0.25/million connection-minutes, `eu-west-2` standard rate, no free tier assumed. TASK 4.2.1 adds £0.00 net-new — Lambda logic and audit writes inside the same DynamoDB line, no new resource beyond one CloudWatch alarm reserved in TASK 4.4.2's own budget.
