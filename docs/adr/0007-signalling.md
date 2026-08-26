# ADR 0007 — Signalling

**Decision:** API Gateway WebSocket + DynamoDB connection table
**Options rejected:** Self-hosted socket server (always-on cost)
**£/mo:** ~£0.10
**Reversal cost:** Low

## Amendment (TASK 4.1.1) — the token travels as a querystring parameter, not a header

Built for the first time at this task, which surfaced a constraint this
ADR's original one-line decision didn't anticipate: a browser's
`WebSocket` constructor cannot set arbitrary headers on the handshake
request, so the `$connect` route's Lambda REQUEST authorizer cannot read
`Authorization` the way every HTTP route's authorizer does
(`infra/src/route-protection.ts`). The Cognito ID token instead rides as
`?token=` on the connect URL — `wss://.../{stage}?token=<token>` — and
`infra/src/ws-authorizer.ts` sets `identitySource:
['route.request.querystring.token']` accordingly, so API Gateway's own
authorizer-result cache keys on that value the same way the HTTP
authorizer's cache keys on the header.

**Consequence, recorded rather than discovered later:** the token sits in
the connect URL, which is exactly the kind of value this codebase's "never
log PII" discipline (`00-conventions.md`) does not let API Gateway's own
access log capture — `infra/src/data-stack.ts`'s `SignallingWebSocketStage`
carries no `accessLogSettings`, deliberately, for this reason.

**A second consequence this amendment also settles:** `WebSocketLambdaAuthorizer`
(`aws-cdk-lib/aws-apigatewayv2-authorizers`) offers no simple-response
option — every WebSocket REQUEST authorizer returns the classic IAM policy
document, never the HTTP APIs' `{isAuthorized, context}` shape
`services/api/src/authorizer.ts` returns. The two response shapes cannot
share one deployed Lambda, so this task deploys a second authorizer
function (`WsAuthorizerFunction`) alongside the existing HTTP one
(`AuthorizerFunction`) — both call the identical verify → look-up →
role-resolve pipeline (`resolvePrincipal`, `authorizer.ts`), wrapped
differently at the edges.
