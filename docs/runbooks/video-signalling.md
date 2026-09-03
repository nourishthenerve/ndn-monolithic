# WebSocket signalling channel: connect, disconnect, the connection table, the call join, and the relay (TASK 4.1.1, TASK 4.2.1, TASK 4.2.2)

**Date:** 2026-08-26 · **Tasks:** [05-execution-plan.md § TASK 4.1.1](../plan/05-execution-plan.md), § TASK 4.2.1, § TASK 4.2.2 · **Requirements:** D-12, R-03 (TASK 4.2.1) · **Decisions:** ADR-0007 (amended by TASK 4.1.1) · **Depends on:** 2.2.1, 2.2.2 (TASK 4.1.1); 4.1.1, 3.4.1, 3.4.2 (TASK 4.2.1); 4.2.1 (TASK 4.2.2) · **Blocks:** every later Phase 4 task

## What this covers

**TASK 4.1.1** is the first WebSocket surface this codebase has built. An authenticated patient or clinician can open a `wss://` connection, have it recorded in a DynamoDB connection row, and close it cleanly. `docs/adr/0007-signalling.md`'s amendment records the one real constraint it surfaced: a browser's `WebSocket` constructor cannot set an `Authorization` header on the handshake, so the Cognito ID token rides as `?token=` on the connect URL instead.

**TASK 4.2.1** answers the question 4.1.1 deliberately left open: a socket proves *who* is connected, not *whether they may join a given appointment's call, right now*. A `{ type: 'join', appointmentId }` message runs `can()`'s new `'join-call'` action (a stricter claim than `'read'` on the same `Appointments` row — granted only to the owning patient and the assigned sub-clinician, never the principal clinician), then checks the record is still `scheduled` and that `now` sits inside a named window around `scheduledAt`. Every attempt — allowed or denied — is audited; a denial always carries a typed reason on the same socket, never a bare close.

**TASK 4.2.2** is the small handshake two joined parties still need before WebRTC can talk P2P: `{ appointmentId, type: 'offer' | 'answer' | 'ice-candidate' | 'leave', payload }`, relayed from one authorised party's socket to the other's, and to no one else. It never re-runs 4.2.1's own authorisation decision — the `CALL#<appointmentId>` partition 4.2.1 writes at join time is the sole source of truth for "who is the other party," queried directly rather than re-checked against `can()` a second time. Nothing here is video or audio media, only SDP/ICE messages, and the payload itself is never logged.

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
- **`services/api/src/ws-join.ts`** — `createJoinMessageHandler`: the SDK-free decision. The window was a fixed `−10 min`/`+30 min` pair of named constants when this task shipped; since 2026-09-03 it is the booked slot itself, `[scheduledAt, scheduledAt + durationMinutes)` — see "The window ignored the booked duration" below. Denial reasons: `too-early`, `too-late`, `cancelled`, `not-your-appointment` (every `can()` denial, an unknown appointment id, and a missing directory record all fold into this one, so existence is never leaked), and `not-available` (the `video.callAuthz.enabled` flag is off — not one of the plan's own four named reasons, added because this is a real outcome a live join can reach and every denial needs a reason).
- **`services/api/src/ws-join-handler.ts`** — the AWS wiring: resolves the caller's connection (`findById`), calls the decision, and answers the caller on their own socket via `ApiGatewayManagementApiClient`'s `PostToConnectionCommand` — the first place this codebase has needed to push a message back down an already-open connection (`$default`'s Lambda proxy return value is not delivered to the client the way `$connect`/`$disconnect`'s is).
- **`services/api/src/ws-default-handler.ts`** (amended) — TASK 4.1.1's two-line stub is now the real `$default` dispatcher: Zod-validates the message shape and hands a `'join'` message to `ws-join-handler.ts`. Every message this codebase sends uses a `type` field, never `action`, so nothing ever matches a named WebSocket route — everything arrives here.
- **`infra/src/data-stack.ts`** — `WsDefaultFunction`'s role gains: `GetItem` on `CONN#*`/`PAT#*`/`CLI#*` (the connection, directory and appointment reads — the same prefix covers both a principal's profile and an appointment row, since appointments live under `PAT#<patientId>` too); `PutItem` on `CALL#*` and `AUDIT#*`; `ssm:GetParameter` for `video.callAuthz.enabled`; and `execute-api:ManageConnections` on the WebSocket stage (`WebSocketStage.grantManagementApiAccess`) — the one IAM action no other role in this stack has needed.
- **`services/api/package.json`** — new dependency, `@aws-sdk/client-apigatewaymanagementapi`, pinned to the same `3.1109.0` release train as every other `@aws-sdk/client-*` package here. **`pnpm-workspace.yaml`** gained a `@smithy/types: '4.17.0'` override: the new package's own transitive dependencies briefly pulled a second, newer copy of `@smithy/types` into the tree, which broke structural typing between it and every other `@aws-sdk/client-*` package (two installed copies of the same interface are nominally different types to TypeScript) — pinned to the version already used everywhere else so pnpm converges on one copy.

### TASK 4.2.2 additions

- **`services/api/src/connection-repository.ts`** — gains `findCallParticipants`, a `Query` (never `GetItem`) against the `CALL#<appointmentId>` partition 4.2.1's `recordCallJoin` writes to, returning every row as-is (at most two).
- **`services/api/src/ws-relay.ts`** — `createRelayMessageHandler`: the SDK-free decision, mirroring `ws-join.ts`'s own split. Given a sender's own `connectionId` and the `appointmentId` they name, it queries the `CALL#` partition once and returns `forward` (to the other participant), `peer-unavailable` (the sender joined, the other party has not), or `not-authorised` (the sender's own `connectionId` is not one of this call's participants — refused silently, never audited, since 4.2.1's own join decision is the one place that access decision is recorded). It never calls `can()` or re-derives anything 4.2.1 already decided.
- **`services/api/src/ws-management-client.ts`** (new) — the memoised `ApiGatewayManagementApiClient` construction TASK 4.2.1 first wrote inline in `ws-join-handler.ts`, extracted so `ws-relay-handler.ts` shares the identical cached client rather than keeping a second one: both handlers run inside the same Lambda container (`WsDefaultFunction`), since both `join` and the relay's own message types arrive at the same `$default` route.
- **`services/api/src/ws-relay-handler.ts`** — the AWS wiring: resolves the decision, then either does nothing (unauthorised), answers the sender with `{ type: 'peer-unavailable' }`, or forwards the original envelope (`appointmentId`, `type`, `payload`) to the other party's connection via `PostToConnectionCommand`. A `GoneException` from that call soft-marks the stale row via `connections.markDisconnected` — the identical update `$disconnect` itself makes, never a delete. The payload is never logged; only `type` and `appointmentId` are.
- **`services/api/src/ws-default-handler.ts`** (amended) — gains `RelayMessageSchema` alongside `JoinMessageSchema`; a message matching neither is still accepted and ignored, never a close.
- **`services/api/src/ws-join-handler.ts`** (amended) — its own inline management-client memoisation moved to `ws-management-client.ts`; no behavioural change.
- **`infra/src/data-stack.ts`** — `WsDefaultFunction`'s role gains two statements: `Query` on `CALL#*` (`QueryCallParticipants`) and `UpdateItem` on `CONN#*` (`MarkStaleConnectionRow`, for the `GoneException` soft-mark) — no new function, no new route, no new resource beyond these two IAM statements.

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

Once both parties have joined the same appointment's call (two separate `wscat` sessions, one per socket from the previous step):

```json
{ "appointmentId": "<patientId>#<scheduledAt-iso>", "type": "offer", "payload": { "sdp": "..." } }
```

- Sent by one joined party, the other party's own socket receives the identical envelope — `appointmentId`, `type`, `payload` unchanged.
- Sent by a socket that never joined this `appointmentId` (or joined a different one): nothing arrives on either socket, and no error is returned to the sender.
- Sent by a joined party before the other has joined: the sender receives `{ "type": "peer-unavailable" }`.
- In every case, `aws logs filter-log-events` against `WsDefaultFunction`'s log group shows `type` and `appointmentId` on each line — never `payload`.

## What was deliberately not built here

- **No peer connection, no media.** TASK 4.2.2 relays SDP/ICE messages between two already-joined sockets; nothing in this codebase yet constructs an `RTCPeerConnection` or touches a camera or microphone — TASK 4.3.1 is where that starts.
- **No `DeleteItem` anywhere, for any reason.** `$disconnect` marks a row; a denied or successful join never removes one either. DynamoDB's own background TTL sweep is the only reclaim mechanism, the same pattern `log-retention-volume-control.md` already establishes for CloudWatch log expiry, used here for the first time on a table row.
- **No persistent audit trail for a connection itself.** `connection-repository.ts`'s own header states why — operational metadata, not a clinical or personal record, not an `AuditAction`. A *join attempt* is the one exception this codebase now carries (TASK 4.2.1), and it is audited as an attempt against the appointment, not as an event about the connection row.
- **No reuse of the HTTP `AuthorizerFunction` Lambda for $connect.** `WebSocketLambdaAuthorizer`'s IAM-policy-only response contract rules it out; see `docs/adr/0007-signalling.md`'s amendment.
- **No re-running `can()`'s decision on a second, independent path.** TASK 4.2.2's relay confirms a sender's own `connectionId` is one of the `CALL#` partition's items — it does not re-authorise the join, because two independent authorisation paths for the same decision are a way for them to drift, not a safety margin.

## Cost

$0.01/month at M6, $0.02/month at M12 — `03-cost-model.md`'s API Gateway WebSocket line, live-priced at Gate G3 (2026-08-26) ahead of TASK 4.1.1 and unchanged by it: $1.00/million messages + $0.25/million connection-minutes, `eu-west-2` standard rate, no free tier assumed. TASK 4.2.1 adds £0.00 net-new — Lambda logic and audit writes inside the same DynamoDB line, no new resource beyond one CloudWatch alarm reserved in TASK 4.4.2's own budget. TASK 4.2.2 adds £0.00 net-new too — the relay's own messages are already inside 4.1.1's own modelled message count (~30 signalling messages per call), and its two new IAM statements carry no cost of their own.

## Amendment, 2026-09-03 — the join window is the appointment, and appointments belong to the treating clinician

> *"when I as a principal clinician approve a booking for an appointment for a patient in pathients account I see a join the call button. But the clinician who has been assigned this patient doesnt see any join the call button. Also, keep this join the call button active from the start of the appointment to the whole duration upto which this appointment has been booked - before this appointment time show to the patient that the appointment is yet to start in x days, y hours and z minutes and after the appointment slot time say "expired"."*

Two independent defects, reported together.

### 1. An appointment belonged to whoever booked it

`appointment.ts` set `clinicianId` to the caller's own id, on a comment asserting that "only the assigned sub-clinician ever reaches this line". True when written; false from 2026-08-31, when the matrix gave the principal `C R U J` on `Appointments`.

`clinicianId` is not bookkeeping. It is what `gsi1pk` keys the clinician calendar on, **and** what `ws-join.ts` checks `join-call` against. So a principal-booked appointment attached itself to the principal: on their calendar, joinable by them, and invisible and unjoinable to the clinician actually treating the patient.

It now takes the patient's `assigned_clinician_id`, falling back to the booker only when the patient has no clinician yet — a case only the principal can book for at all. Who typed it in is recorded in the audit log, which is where that belongs.

**Existing appointments are not migrated.** Any already booked by the principal for another clinician's patient still carry the principal's id and will stay on the wrong calendar. There are few enough that fixing them is a one-off write rather than a migration; say so if you want it done.

### 2. The window ignored the booked duration

| | Was | Now |
| --- | --- | --- |
| Opens | `scheduledAt − 10 min` | `scheduledAt` |
| Closes | `scheduledAt + 30 min` | `scheduledAt + durationMinutes` |

A 15-minute check-in and a 90-minute assessment got the identical 40 minutes — one joinable long after it ended, the other locked out halfway through.

`JOIN_WINDOW_OPENS_BEFORE_MINUTES` and `JOIN_WINDOW_CLOSES_AFTER_MINUTES` are gone, replaced by `joinWindowClosesAt(scheduledAt, durationMinutes)`. The end is **exclusive**: `scheduledAt + durationMinutes` is past the appointment, not the last moment of it, and the UI says "expired" at the same instant from `joinPhase`'s matching `>=`.

The 10-minute early grace is deliberately dropped, because the instruction is explicit about where the window starts. Reinstating it is one subtraction in `ws-join.ts` and the matching one in `apps/web/src/account/join-window.ts`.

### The three phases, in one component

`JoinCallCell.tsx` renders a countdown, a live link, or "expired" — and is used by **both** the patient's `NextAppointmentPanel` and the clinician's `ClinicianCalendar`. Both sides of a call face the same window and must not be able to disagree about it; and a link that looks live and is refused on arrival is worse than no link, because by then the person has already believed in it.

The phases are the three `ws-join.ts` enforces, so what a person can press and what the server will accept agree by construction rather than by two sets of constants being kept in step.

`useNow.ts` is what makes a countdown tick. **Its shape is load-bearing:** these components take a `now: () => Date` prop, and an inline `() => new Date()` default in a `useCallback` dependency array is what caused an unbounded fetch loop (and a crashed vitest worker) on 2026-09-01. The function stays stable; only a piece of state ticks, and that state is a dependency of nothing that fetches.

## Amendment, 2026-09-03 (later the same day) — the appointment vanished at the moment it started

> *"When the item of appointment arrived the 'join the call' button simply didnt appear for both the patient as well as the clinician. The dashboard simply started showing the next appointment item."*

The window fix above was correct and was never reached. **`JoinCallCell` was rendering the right phase for an appointment that the list around it had already dropped.**

Four places decided whether an appointment was still worth showing, and all four asked whether `scheduledAt` was still in the future. That stops being true at the exact instant the join window opens — so each surface discarded the appointment precisely when its button was due to appear:

| Surface | Was | Now |
| --- | --- | --- |
| `NextAppointmentPanel.findNext` (patient) | `scheduledAt >= now` | not finished: `isLiveOrUpcoming` |
| `ClinicianCalendar.calendarWindow` (clinician) | `from = now` | `from = now − CALENDAR_LOOKBACK_HOURS` |
| `assessment.ts` `summariseCalendar` | `scheduledAt <= now` → skip | `isAppointmentOver` |
| *(the window itself, `ws-join.ts`)* | already correct | unchanged |

The clinician's case is worth its own sentence, because it is not a comparison but a **query**. `from` becomes the GSI1 range key (`gsi1sk BETWEEN 'APPT#<from>' AND 'APPT#<to>'`), and a range query on the *start* key cannot express "still running" — so the window now opens `CALENDAR_LOOKBACK_HOURS = 12` behind the clock, wide enough to catch the start of anything that could still be under way, and each row then says which phase it is in. Nothing bounds `durationMinutes` server-side, so twelve hours is a deliberate over-estimate rather than a proof: too large costs a few finished rows on a 30-day calendar, too small brings this bug back for long appointments only. Those finished rows are kept rather than filtered, because they carry the "mark as attended"/"no-show" buttons and a clinician recording a session the moment it ends is the realistic flow — before this, those buttons were unreachable from the instant the appointment began.

**One definition each side of the wire.** `appointmentEndsAt`/`isAppointmentOver` (`@ndn/shared-types`) is the server's; `isLiveOrUpcoming` (`apps/web/src/account/join-window.ts`) mirrors it, restated rather than imported because `apps/web` deliberately does not depend on that package. Both treat an unparseable `scheduledAt` as **over** — `NaN` comparisons are all false, so without that guard a malformed row reads as live and offers a link the server is certain to refuse.

**A second-order fix, in the same pass.** `NextAppointmentPanel` decided *which* appointment was next once, when the fetch landed, and stored only that row. Which appointment is next is a question about the clock, and the panel already has a ticking one — so a page left open kept naming an appointment that had finished and would not roll on without a reload. It now stores the whole list and derives "next" per render.

### Dates said different things on different screens

> *"the dates are different, the timestamp has different format."*

They were the same instants. Every screen formatted with `new Date(iso).toLocaleString()` and no locale argument, which uses **the reader's browser locale, not the site's** — so the same appointment read `9/3/2026, 9:25:00 PM` on the patient's machine and `03/09/2026, 21:25:00` on the clinician's. `9/3` and `03/09` disagree about whether that is September or March, and nothing on either screen said which reading applied.

`formatDateTime(value, locale)` (`packages/i18n/src/datetime.ts`) is now the only date renderer in the app, used by `NextAppointmentPanel`, `ClinicianCalendar`, `PatientRecordPanel` and `PatientNotifications`. The site's locale decides; the month is spelled so no ordering convention can flip it; the zone is named, because a patient and a clinician in different timezones is the ordinary case for a video appointment. Each still reads the time in their own zone — the label is what stops that looking like a disagreement.
