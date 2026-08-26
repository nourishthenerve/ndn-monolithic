# The peer connection: offer/answer/ICE over the relay, STUN-only first attempt (TASK 4.3.1)

**Date:** 2026-08-26 · **Task:** [05-execution-plan.md § TASK 4.3.1](../plan/05-execution-plan.md) · **Requirements:** D-12 · **Depends on:** 4.2.2 · **Blocks:** 4.3.2, 4.3.3

## What this covers

Every prior Phase 4 task moved signalling messages between two joined sockets; nothing did anything with them. This is where `RTCPeerConnection` first appears in the codebase, on both sides of the account shell: a signed-in patient or clinician who reaches the call page, for a scheduled appointment they are a party to, gets a real STUN-only WebRTC call with the other party. No TURN credentials are requested here — that is TASK 4.4.1's job, reached only from TASK 4.3.3's fallback path.

## What was built

- **`apps/web/src/account/webrtc-signalling-client.ts`** — the SDK-free half of this task's own split, mirroring `services/api/src/ws-join.ts`/`ws-relay.ts`'s "business logic in one file, wiring in another" shape. `parseIncomingMessage` (Zod) rejects anything not matching one of `joined` / `join-denied` / `peer-unavailable` / the `offer`/`answer`/`ice-candidate`/`leave` relay envelope, returning `undefined` rather than throwing — the identical "not a recognised shape, dropped, never a crash" posture `ws-default-handler.ts` already takes for a message travelling the other way. `connectSignalling` opens the `WebSocket` with `?token=` (TASK 4.1.1's own constraint: a browser `WebSocket` cannot set an `Authorization` header on the handshake) and sends `{ type: 'join', appointmentId }` the moment the socket opens, not before.
- **`apps/web/src/account/VideoCall.tsx`** — one component, shared by both sides of the account shell. On `joined`, requests camera+microphone (`getUserMedia`), constructs `RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })`, attaches local tracks, and wires `ontrack` to a remote `<video>`. Offer/answer roles are fixed, not raced (this task's own step 2): the patient always offers, the clinician always answers. ICE candidates trickle over the same relay as they arrive. Connection-state transitions are exposed as one typed status, `CallConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed'` — this task defines and exports the type (via an optional `onConnectionStateChange` prop); TASK 4.3.3's `call-state-machine.ts` is its first real reader.
- **`apps/web/src/pages/[locale]/account/call.astro`** — the account-shell page. Statically generated and empty, same discipline every other authenticated account page in this codebase already states.
- **`packages/i18n/src/locales/en.json`** — the `videoCall.*` catalogue entries this page and component need (loading/forbidden/error/waiting/connection-state/join-denied-reason copy).
- **`apps/web/src/site-config.ts`** — `signallingWebSocketUrl`, the real deployed `wss://93im3xehxh.execute-api.eu-west-2.amazonaws.com/$default` (`NdnDataStack`'s `SignallingWebSocketUrl` output), hardcoded the same way `contentApiUrl` already is and for the identical reason stated there.

## Two real constraints this task surfaced

**Not `[appointmentId].astro`, on purpose.** The plan named this file with a dynamic path segment; the actual infra cannot serve one. ADR-0017's static build writes a fixed set of files to `dist/`, and `web-stack.ts`'s CloudFront distribution has no SPA-style fallback — a missing S3 object 403/404s straight to `404.html`. `[slug].astro` works for `blog`/`workshops` only because their own `getStaticPaths` enumerates every id that exists *at build time* (published content); an appointment id has no such enumeration, and nothing in this codebase queries DynamoDB from `astro build` for anything patient-identifying regardless. The actual, working route is one static page, `call.astro`, and the appointment id travels as `?appointmentId=`, read once client-side by `VideoCall.tsx` — the same "resolve everything at runtime, bake in nothing" posture `messages.astro`'s own `/patients/me/messages` `me` resolution already established for a different unknown. This is a gap named here rather than discovered mid-implementation, the same posture TASK 4.1.1's own header comment takes for the WebSocket auth-header constraint. TASK 4.5.1's join button is what will link here with the real query string.

**Where `role` comes from.** The fixed offer/answer roles mean this component has to know, before it does anything else, whether the signed-in caller is the appointment's patient or its clinician — and nothing hands it that directly. The WebSocket `joined` response carries no role (`ws-join.ts`), and `session.ts`'s own header states `SessionClient` deliberately never decodes the access token's claims. `VideoCall.tsx` resolves this the same way `PatientProfile.tsx`/`CaseloadView.tsx` already treat a `403` as an ordinary, expected outcome: it calls the existing `GET /clinicians/me/calendar` (`appointment.ts`, reachable by either clinician column on the `Appointments` matrix row, refused for a patient by construction) and reads `response.ok` as the role signal — `200` means clinician, anything else means patient. A wrong guess here is harmless: the real boundary stays server-side, in 4.2.1's own `can()`/window/status checks on the actual join.

**The `video.call.enabled` flag named in the plan's own Flag line has no code-level gate in this task.** This task's own Files list touches nothing under `services/api` or `flags.ts`, and no frontend flag-reading mechanism exists in this codebase yet (every prior flag is read server-side only). The page is reachable once built and deployed, but functionally inert unless `video.signalling.enabled` (WS `$connect`) and `video.callAuthz.enabled` (the join decision) are both on — the identical "off means functionally inert, not code-absent" shape TASK 2.2.4's `auth.webSignIn.enabled` already establishes for the account pages generally. A guessed or shared URL with a real `appointmentId` still cannot get past `join-denied: not-available` if `video.callAuthz.enabled` is off, and cannot even open the socket if `video.signalling.enabled` is off.

## What was built, continued: the `peer-unavailable` retry

A patient who joins moments before their clinician is the ordinary case, not a failure — 4.2.2's `ws-relay.ts` returns `peer-unavailable` to the sender whenever the other party has not joined yet, and nothing about the join window guarantees simultaneity. Only the offerer (the patient) ever sends a message that can bounce this way — the answerer sends nothing until it has received an offer. `VideoCall.tsx` retries the *offer* alone (never the join) every 2 seconds, up to 15 attempts (~30 seconds), surfacing a `waiting-for-peer` status meanwhile; exhausting the retries reaches the same `failed` connection state TASK 4.3.3's own terminal state will later own more fully. This is the minimum necessary for the happy path (two real people joining at slightly different times) to work at all — not a general reconnection/fallback mechanism, which stays TASK 4.3.3/4.4.1's job.

Trickle ICE candidates arriving before this side's own `setRemoteDescription` resolves (a well-known WebRTC race, more likely here given the relay's own network hop) are buffered and flushed once the remote description is set, rather than thrown past the caller.

## Verification steps

Two real browser sessions, signed in as the matched patient and clinician for a real scheduled test appointment (`video.signalling.enabled`, `video.callAuthz.enabled` both on):

1. Both open `https://<host>/en/account/call?appointmentId=<patientId>%23<scheduledAt-iso>` inside the appointment's join window.
2. Each grants camera/microphone permission when prompted.
3. Within a few seconds (or up to ~30 if one side joined well before the other), both sides show `connected` and see/hear each other — on a network where P2P is reachable; TURN's own case is 4.3.3/4.4.1's to verify.
4. Joining outside the window, or as someone other than the appointment's own two parties, shows the same typed `join-denied` reasons TASK 4.2.1 already proves at the WebSocket layer, rendered here as plain-language copy instead of a raw reason string.

## What was deliberately not built here

- **No TURN.** `iceServers` is STUN-only; TASK 4.4.1 owns issuing and wiring in TURN credentials.
- **No dedicated device-check/permission-preview step.** `getUserMedia` is called directly once `joined` arrives; TASK 4.3.2 moves this earlier behind its own accessible preview step, before either party can even attempt to join.
- **No general ICE-failure/reconnection state machine.** The `peer-unavailable` retry above is narrowly the "other party hasn't joined yet" case; TASK 4.3.3 owns what happens when ICE itself fails after a connection was attempted.
- **No join button, and no reachable link to this page from anywhere else in the account shell.** TASK 4.5.1 owns the button, on both sides, that will link here with a real `appointmentId`.
- **No code-level gate for `video.call.enabled`.** Named above — this task's own Files never touch `flags.ts`, and the page's real behaviour rides entirely on the two flags TASK 4.1.1/4.2.1 already built.

## Cost

£0.00 net-new. Cloudflare's STUN service is free and unlimited; every WebSocket message this task's signalling client sends is already inside TASK 4.1.1's own modelled message count.
