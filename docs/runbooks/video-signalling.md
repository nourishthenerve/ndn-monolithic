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

## Amendment, 2026-09-04 — both parties joined, and each saw only themselves

> *"When it's the time both the patient as well as assigned clinician sees a join call button. However, when we click we only see our own video."*

The join was authorised, the sockets were open, and the signalling messages were being relayed — to a connection that had been dead for hours.

### The `CALL#` partition never forgot anyone

`recordCallJoin` writes `CALL#<appointmentId>` / `CONN#<connectionId>`. **The sort key is the connectionId**, which is new on every WebSocket connection — so every join wrote another row: every page reload, every retry, every earlier attempt at the same appointment, each alive for the twelve hours its `ttl` carries.

Nothing ever retired one. Both `$disconnect` and the relay's own `GoneException` path call `markDisconnected`, which updates `CONN#<id>/PROFILE` — **a different row**. The `CALL#` row it was meant to invalidate sat there untouched, still a candidate.

`ws-relay.ts` then chose the other party like this:

```js
const other = participants.find((p) => p.connectionId !== input.senderConnectionId);
```

`find` over every row the partition had ever held returns the first in sort-key order: an arbitrary dead connection from an earlier session. Every offer, answer and ICE candidate went to a socket nobody was listening on, so neither side ever received the other's tracks and both sat looking at their own camera. And because the dead row was never retired, the next message chose it again — the call could not recover on its own, and neither could the next one.

Four changes, and the first is the one that makes it deterministic rather than merely likelier to work:

- **`recordCallJoin` retires this principal's own earlier rows in the same call.** One principal, one live row. Both parties open a fresh connection per call, so once the second has joined the partition holds exactly the two of them. The new row is written *before* the old ones are retired, so a failure can never leave a joiner with no row at all.
- **`liveParticipants` (`ws-relay.ts`) filters before anything is chosen** — no `leftAt`, and `ttl` still ahead. The `ttl` half is not redundant with DynamoDB's own sweep: TTL deletion is best-effort and AWS documents up to 48 hours of lag.
- **A `GoneException` now retires the `CALL#` row too**, and answers the sender `peer-unavailable` instead of swallowing the failure. This is what makes an already-poisoned partition self-heal: the first message to a dead peer removes it and tells the sender to retry.
- **`turn-credentials.ts` honours `leftAt`.** Its relay cap counted the other party's `turnActive` rows without checking whether they were live, so one earlier attempt that had used TURN could refuse TURN to the other party for the rest of that row's twelve hours — failing exactly the calls that need it most.

### Two people clicking a button had 30 seconds to find each other

The offerer discovered its peer only by re-offering into `peer-unavailable` on a 2-second timer, 15 times, then declaring `call-failed`. Whoever clicked first started that clock, and it was unrecoverable once it blew.

`'ready'` is a new relayed message type — no payload, no peer connection, just "I am on this call, offer to me". Both sides send it on joining, which covers both orderings without either having to guess: join second and your `ready` reaches someone already there; join first and theirs reaches you. The retry loop stays as a safety net rather than the mechanism, and `peer-unavailable` now puts *both* sides into "waiting for the other participant" — a clinician who arrived first used to sit on "Connecting…" with nothing to explain it.

### Two ways a working call could still be thrown away

- **A duplicate answer killed it.** Two offers could be in flight at once (the one sent on joining plus one from the retry timer), and the other side answers both. `setRemoteDescription(answer)` on a connection already back in `stable` throws `InvalidStateError`, which reached the catch-all and replaced a connected call with the error screen. An answer is now applied only while an offer is actually outstanding (`signalingState === 'have-local-offer'`), and anything from the peer clears the retry timer.
- **One rejected ICE candidate killed it.** `addIceCandidate` rejections propagated to the same catch-all. ICE gathers many candidates and some are legitimately unusable; one discarded network path is not a failed call.

### The remote stream had one chance to attach

`ontrack` wrote straight into `remoteVideoRef.current`. If that ref was null at the instant the track arrived, the stream was dropped with nothing to re-attach it. It is now held in React state and attached by an effect — the same shape the local preview has always used — and `play()` is called explicitly, because `autoPlay` alone can be refused for a stream carrying audio.

### The layout

> *"Fix it so that we see each other's videos (along with ours in a small box in bottom right)."*

The two `<video>` elements carried no styling at all and stacked as inline boxes at their intrinsic size. The call now renders as a 16:9 stage holding the remote video, with the self-view inset at the bottom right, mirrored the way every video call mirrors a self-view (the remote never is — flipping another person reverses any text they hold up). The stage owns the aspect ratio so the frame does not resize as streams come and go, and a placeholder carries the status line inside the frame while the other party's video is still absent, where black alone is indistinguishable from a broken call.

Inline styles, not a stylesheet: `apps/web` ships no CSS pipeline for islands, and the CSP already allows `style-src 'unsafe-inline'`.

### Verifying it

The regression is invisible on a partition that happens to be clean, so verify it on an appointment that has **already been joined at least once before** — that is the state every real call reaches by its second attempt:

1. Join, leave, and reload on both sides a few times, then join again from both. The call must connect on that attempt, not only the first.
2. Join as one party, wait more than a minute, then join as the other. The first party must move from "waiting for the other participant" to connected when the second arrives — the old 30-second fuse is gone.
3. Both sides show the other person full-frame with their own camera inset at the bottom right.

## Amendment, 2026-09-04 (evening) — the self-view was black, and two features

> *"i'm not seeing my own video in the smaller box. Also, add one more feature that if the video call length is 30 mins the call should be dropped automatically. Also, start the video call by default with audio only and have a separate button to turn the video on."*

The screenshot showed the fix from earlier that day working — the other person full-frame — with the inset box solid black.

### Attaching a stream needs two things, and a ref tells you about one

The local preview attached in an effect keyed on `[deviceStream]`. That is set the moment `DeviceCheck` hands the stream over — **while the render is still showing the Join button**. No `<video>` was mounted yet, so `localVideoRef.current` was `null`, the effect did nothing, and it never ran again. The element mounted a moment later with no `srcObject` and stayed that way for the whole call.

The morning's remote-stream fix moved that stream into state but kept the same shape for the element, so the local half still had the flaw the remote half had just been cured of. Both video elements are now held in state via a callback ref, which makes the element's arrival an ordinary dependency: the effect runs when *either* half becomes available, in whichever order they do. `setState` is a stable identity, so React calls it once on mount and once with `null` on unmount — never the per-render detach/reattach an inline callback ref causes.

### Audio only, with a camera button

The call starts with the video track `enabled = false` and a toggle turns it on. A disabled track transmits black frames, so the other party sees no image, which is what "audio only" has to mean on the wire.

Implemented on the track rather than by withholding it from the peer connection: the sender stays in place, so switching on transmits immediately with no renegotiation, no second offer/answer round trip, and no second `getUserMedia` — which would also break `DeviceCheck.tsx`'s standing position as the only place in this codebase that requests camera permission.

**The honest limit:** the camera device stays held for the call, so its indicator light stays on while nothing is being shown. Releasing it properly means stopping the track and re-acquiring one on toggle — a `getUserMedia` call from `VideoCall.tsx` and a real change to that boundary, worth doing deliberately rather than as a side effect of this request.

The self-view says "Your camera is off" over the inset box while it is. A deliberate camera-off and a preview that failed to attach must not look the same — the owner has now reported the second one as a bug, and it looked exactly like the first.

### The 30-minute limit

`MAX_CALL_MINUTES = 30`, measured from the moment this side joins rather than from when the peer connects: a call that never connects must still stop holding a camera and a socket open, and "when did the call start" is a question the person on it would answer by when they pressed the button.

Its own effect, keyed on `joinRequested` alone — deliberately separate from the join sequence, which tears down and rebuilds on a retry. A limit that restarted whenever the peer connection was rebuilt would not be a limit.

Ending goes through exactly the state "Leave call" sets, so the teardown, the `leave` sent to the other party and the released camera are the one path that already worked. The ended message says the time ran out rather than the generic "The call has ended", because on a call nobody ended that reads as a failure, and the difference decides whether the person tries again.

**This is a client-side limit and is honest about being one.** The boundary on a call's *span* stays server-side where it already is — `ws-join.ts` refuses a join outside the booked slot, so nobody starts one at will. What this adds is that a call under way ends by itself rather than running until somebody closes a tab. Both parties run their own timer and each receives the other's `leave`, so the two sides end together whichever fires first.

### `VideoCall.tsx` has a render test now

`video-calls.md` records why it never did: importing it pulls its whole `RTCPeerConnection`-touching body into the repo's 80% coverage gate. That reasoning held while nothing here was reported broken. It stopped holding after two reports in one day, the second of which was a **render-ordering** bug no amount of testing the pure helpers could have caught.

`VideoCall.render.test.tsx` drives a fake socket and peer connection by hand — nothing opens or negotiates on its own, so each test states how far the call got before asserting. It covers the self-view attachment, the camera toggle, the 30-minute limit, and the signalling sequence itself: who offers, who answers, the `ready` handshake, the duplicate-answer guard, `join-denied`, `peer-unavailable`, and the `leave` in both directions. Branch coverage went **up** (81.25%) despite the file's 150 branches joining the count.

## Amendment, 2026-09-05 — the offer storm

> *"now I see myself in the smaller box but dont see the other persons video. before that was working."*

The self-view fix worked. The screenshot showed the other half stuck: **"Connecting…"**, the in-frame placeholder still up — so no remote track had arrived and the peer connection had never reached `connected`. Three defects, in a chain, all introduced by the two previous fixes.

### 1. Retry timers doubled every two seconds

`retryTimer = setTimeout(…)` re-armed without cancelling what was already pending. Harmless while exactly one message could bounce — but `ready` (2026-09-04) meant a caller waiting alone now got **two** `peer-unavailable` replies per round, one for the `ready` and one for the offer. Each armed a timer; only the last handle was kept. Each fired timer sent an offer, which bounced, which armed more. `clearTimeout(retryTimer)` could only ever cancel one of them.

`armRetry()`/`cancelRetry()` are now the only way a retry is scheduled, and `armRetry` cancels first.

### 2. Nothing stopped several offers being in flight at once

Every one of those timers called `sendOffer()` with no guard, so several offers went out together and came back several answers. `offerInFlight` allows one at a time, with an explicit `force` for the two cases where a fresh offer is genuinely warranted — the peer has just announced itself, or this side has rebuilt its peer connection — because the outstanding offer was addressed to a peer or a connection that no longer exists.

### 3. Dropping an answer stranded the ICE candidates — this is what killed the call

The duplicate-answer guard skipped on `signalingState !== 'have-local-offer'` and returned **without setting `remoteDescriptionSet`**. Nothing flushes `pendingCandidates` but a successful `setRemoteDescription`, so every candidate the peer sent queued and was never applied. With no remote candidates there is nothing for ICE to pair: the connection never completes, no track ever arrives, and the call sits on "Connecting…" behind a black frame until somebody gives up.

The two cases no longer share an exit. A browser refuses an answer in the wrong state, so forcing it through is not available — the fix is to get back in step:

- **already answered** → genuinely redundant, skip;
- **nothing negotiated and no offer outstanding** → the two sides are out of step, so send a fresh offer, which is also what unsticks the queued candidates.

A failed negotiation step no longer drops the call onto the error screen either. It was reaching a catch-all that replaced a recoverable SDP race with "Something went wrong"; real terminal failure is the connection state machine's to report.

### 4. And waiting for someone is not a failure

Found while tracing the fix rather than reported. Two bounces per round also burned the 15-retry budget in about fourteen seconds, and the patient was then told **"This call could not connect"** — while their clinician simply had not arrived yet. Nothing had failed: the socket was open and the join accepted.

The budget now counts offers actually re-sent, not bounces received (~30 seconds again), and running out of nudges leaves the honest "waiting for the other participant" up instead of declaring failure. Discovery no longer depends on it: the other party's `ready` reaches this side the moment they join. A call nobody ever joins is ended by the 30-minute limit.

### The black frame that is not a bug

A call now starts audio-only on both sides, so the ordinary state of a freshly connected call is two people looking at a black rectangle — the app working exactly as asked, and indistinguishable from the fault reported twice. The frame now says **"The other participant's camera is off."**, read from the remote track's own `muted` flag and kept current from its `mute`/`unmute` events. Not inferred from anything we send: it is a fact about them, and their track is the only honest source for it.

### Coverage

`VideoCall.render.test.tsx` grew to 48 tests. The ones that pin this amendment: one retry armed however many messages bounce; retries that do not multiply over successive rounds; the loop stopping the moment the peer speaks; an unapplicable answer restarting negotiation rather than dying silently; queued candidates flushed once a remote description lands; a genuine duplicate still ignored; a failed negotiation step not ending the call; waiting indefinitely without a failure message; and the remote camera notice appearing, clearing and returning.
