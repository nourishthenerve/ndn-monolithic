# Gate G4 report — Phase 4 (video calling)

**Date:** 2026-08-27 · **Scope:** TASK 4.1.1 through 4.5.1 · **Checklist:** [06-gate-checklists.md](06-gate-checklists.md) · **Previous gate:** [gate-g3-report.md](gate-g3-report.md)

## Go/no-go

**NO-GO on this gate's own criterion; every other checklist item holds.** G4's gate-specific criterion is explicit and singular: "real cross-network call; measured relay cost vs model." That has not happened. No task in Phase 4 provisions a real Cloudflare TURN key — `CLOUDFLARE_TURN_KEY_ID` is still the empty string TASK 4.4.1 left it as (`infra/src/config.ts`), by design, pending the site owner's own Cloudflare dashboard step named in that task's own runbook section. Without a real key, `video.turn.enabled` cannot mint a working credential, `video.call.enabled`'s own retry path has nothing to force through TURN, and the criterion's second half — comparing a real `EstimatedTurnRelayGB` reading against `03-cost-model.md`'s ≈85 GB worst case — has no real reading to compare. This is not a code defect: every mechanism the criterion needs (the credential endpoint, the concurrent-relay cap, the metric, the alarm) is built, tested, and live in production, confirmed below. It is a real, unclosed action item, the single blocking one at this gate.

Everything else this checklist runs is clean: full test suite green, coverage threshold held (after one same-day fix, §1a), no known vulnerabilities, the private-field boundary re-audited with nothing new to find (Phase 4 carries no `private{}` entity at all), production healthy, spend materially unchanged. Per D-27's own standing process, "elaboration of the next phase's stubs" runs at every gate regardless of that gate's own verdict — Phase 5 is elaborated in full at §10, closing that checklist item on schedule. **Phase 5's own work should proceed**; what should not proceed without the site owner's action is treating Phase 4's video-calling feature as proven at scale, or turning its flags on for a real patient, until the action item below closes.

## 1. Full test suite

`pnpm -r lint && pnpm -r typecheck && pnpm test` run fresh against `main` (`9245ef7`) on 2026-08-27:

- **Lint:** clean across all 12 workspace packages.
- **Typecheck:** clean across all 12 workspace packages.
- **Tests:** **1,753 tests / 131 files, 0 failures.** Per package: `services/api` 1,315 (79 files), `infra` 222 (8 files), `packages/ui` 74 (16 files), `apps/web` 102 (16 files), `packages/i18n` 17 (3 files), `packages/eslint-plugin-no-destructive` 12 (2 files), `packages/shared-types` 4 (1 file), `packages/eslint-plugin-i18n` 2 (1 file), `apps/mobile` 1, `packages/api-client` 1, `services/workers` 1, `tests` 2.
- **`pnpm audit --audit-level=high`:** no known vulnerabilities.
- **`pnpm lint:no-destructive`:** the fixture still fails as designed — **11 problems, 11 errors**, unchanged since G3, exit non-zero.
- **CI on `main`:** every push since G3 (PRs #95–#103) green.

### 1a. A same-day coverage-threshold near-miss, and its fix

`pnpm run test:coverage` enforces an 80% branch-coverage floor across the whole monorepo (`vitest.config.ts`). TASK 4.5.1's own first push failed it — 77.5% against the 80% floor — caught by CI within the same PR, not discovered at this gate. Root cause: the task's own test file imported `VideoCall.tsx` directly to reach one small exported helper (`parseScheduledAt`), and v8's coverage instrumentation counts a file's *entire* module graph once anything imports it — pulling that stateful, `RTCPeerConnection`-touching component's own ~130 largely-untested branches (deliberately untested, per every Phase 4 frontend task's own honestly-scoped Tests line — no jsdom/RTL pattern exists in this codebase) into the global count for the first time. `apps/web/src/account`'s own pre-existing untested components (`DeviceCheck.tsx` among them) had never individually carried enough branches to breach the floor on their own. Fixed the same day, before this gate, by moving the countdown's pure logic into its own file (`join-window.ts`) — the identical "SDK-free logic in its own file" split `webrtc-signalling-client.ts` and `call-state-machine.ts` already use next to this same component — so its test never touches `VideoCall.tsx`'s module graph at all. Branch coverage: 77.5% → 82.64%, confirmed both locally and by CI re-running green before merge.

**Repo-wide coverage at this gate:** 92.96% statements / **82.64% branches** / 91.77% functions / 93.33% lines, against the 80% floor. `services/api/src/projection.ts`'s own CI-enforced 100%/100%/100%/100% gate held with no error.

## 1b. Regression diff against the previous gate

| Measure | G3 (2026-08-26) | G4 (2026-08-27) | Δ |
|---|---|---|---|
| Tests / files | 1,533 / 122 | 1,753 / 131 | +220 / +9 |
| Workspace packages | 12 | 12 | — |
| CloudFormation stacks (excl. `CDKToolkit`) | 4 | 4 | — |
| Lambda functions | 28 | 33 | +5 (`WsAuthorizerFunction`, `WsConnectFunction`, `WsDisconnectFunction`, `WsDefaultFunction`, `TurnCredentialsFunction`) |
| Log groups, all with retention | 43 / 0 without | 48 / 0 without | +5, same posture held |
| DynamoDB tables | 1 | 1 | — |
| DynamoDB GSIs | 4 (GSI1–GSI4, all `ACTIVE`) | 4, all `ACTIVE` | — (Phase 4 needed none — the `CALL#`/`CONN#` partitions reuse the main table's own PK/SK, per D-07) |
| CloudWatch alarms | 5 | 6 (`+ ndn-turn-relay-volume`, TASK 4.4.2) | +1, all `OK` |
| `ndn-prod` month-to-date spend | $0.435 (Aug 1–26) | $0.492 (Aug 1–27) | +$0.057/day — in line with G3's own run rate, nothing Phase 4 turned on is live |

No test regressed. No previously-passing check now fails. Every added function/log group/alarm is exactly what Phase 4's own nine tasks named building.

## 2. Requirement traceability

| Task | DoD | Status | Note |
|---|---|---|---|
| 4.1.1 WebSocket signalling channel | Open/close cleanly, findable by id, nothing deleted | **COMPLETE** | `ws-connect-handler.ts`/`ws-disconnect-handler.ts` live; TTL is the only reclaim mechanism, confirmed no `DeleteItem` anywhere in the diff (§4). |
| 4.2.1 Server-side call authorisation | Only the appointment's own two parties, only in-window, only `scheduled`; every attempt audited | **COMPLETE** | `ws-join.ts`'s exhaustive denial-reason coverage confirmed; the join/join-denied audit action is this codebase's first *read*-shaped audited decision. |
| 4.2.2 Signalling relay | Offer/answer/ICE reaches only the other authorised party; payload never logged | **COMPLETE** | `ws-relay.ts` queries `CALL#` directly, never re-runs `can()`; log-line assertion confirmed at TASK 4.2.2's own review. |
| 4.3.1 The peer connection (STUN-only) | Two matched parties complete a STUN-only call end-to-end | **COMPLETE** (mechanism) | Automated coverage is `webrtc-signalling-client.ts`'s own parser tests, per this task's own honestly-scoped Tests line; a real end-to-end call has not been run live at this gate (no test appointment/flags turned on in production). |
| 4.3.2 Device check | Caller acts on device state before joining; denied permission legible | **COMPLETE** | `classifyMediaError` unit-tested directly; `getUserMedia` confirmed called exactly once per session (§ code review at merge). |
| 4.3.3 ICE-failure fallback | Exactly one automatic retry, then a legible terminal state | **COMPLETE** | `call-state-machine.test.ts`'s own three named cases (one retry, second failure terminal, `connected` resets the budget) plus the grace-period paths, all green. |
| 4.4.1 TURN credential issuance | Only a call's own joined party obtains a scoped credential; STUN failure's retry succeeds via relay | **MECHANISM COMPLETE, UNVERIFIED LIVE** | `turn-credentials.ts`'s 18 tests cover every denial path; the "succeeds via relay" half of the DoD needs a real Cloudflare key — this gate's own blocking action item. |
| 4.4.2 Concurrent-relay cap + telemetry | Cap enforced; estimated GB visible; a refusal degrades gracefully | **COMPLETE** | `ndn-turn-relay-volume` alarm confirmed live and `OK` in production (§1b); the cap and mark-on-issuance logic both unit-tested. |
| 4.5.1 Join-button state machine | Patient and clinician can find, join, conduct and end a call, every failure legible | **MECHANISM COMPLETE** | Every named state (`too-early`, `ready`, `in-call`, `call-failed`, `ended`) implemented and reachable; "find" is not — no page outside `call.astro` itself links to it yet (its own runbook names this honestly; not this task's Files to close). |
| **Gate G4's own criterion** | Real cross-network call, forced through TURN; measured cost vs model | **NOT MET** | The blocking action item — no Cloudflare TURN key is provisioned. See Go/no-go. |

**`07-traceability.md` still claims `FR-VID` 6/6** against the un-reconstructable source brief, unchanged in kind since G1 — checked again at this gate, still open, still not this gate's to close (needs the brief's owner, not more code). Repeated below at §11 rather than re-argued.

## 3. Authorisation-boundary re-audit (from scratch, live)

**R-09's own standing rule: re-audited at every gate, not only when the code changes.** Phase 4 introduces four new entities — the connection row (`CONN#`), the call-participant row (`CALL#`), the TURN-credential response, and the relay envelope — and **none of the four carries a `private{}` field**, confirmed against each one's own repository header rather than assumed:

1. `connection-repository.ts`'s own comment states it directly: "a connection row is operational metadata with no clinical content, not an entity the `AuditAction` union needs to know about" — no `projectFor`/`projectAllFor` call exists anywhere in this file, and none is needed.
2. The `CALL#` row (`connectionId`, `principalId`, `role`, `ttl`, `turnActive`) is the same shape — operational, not clinical.
3. The TURN credential response (`iceServer: { urls, username, credential }`) is a Cloudflare-issued, short-lived token, never a stored or user-owned record — nothing to project.
4. The relay envelope (`appointmentId`, `type`, `payload`) is forwarded byte-for-byte between two already-authorised parties; the payload itself is treated as sensitive for *logging* purposes (never written to a log line, confirmed at TASK 4.2.2) but is not a `private{}`-shaped field in `projection.ts`'s own sense — it never reaches a third party's response.

`services/api/src/projection.ts` itself is unchanged since TASK 2.1.2 and Gate G3's own re-read of it; its CI-enforced 100% coverage gate held with no error this gate too (§1a). **Result: the boundary holds. Phase 4 needed no new entry in `ROLE_GATED_PRIVATE_ENTITY_TYPES`/`ASSESSMENT_SPLIT_ENTITY_TYPES`, and adds none — confirmed by reading `projection.ts` directly, not inferred from the absence of a diff.**

## 4. Destructive-code audit

Full-repo `pnpm -r lint` (§1) is clean; the fixture proof (§1) still fires as designed. Phase 4's own connection/call rows introduce this codebase's *first* table rows reclaimed purely by DynamoDB's native TTL sweep rather than any application code path (TASK 4.1.1's own header names this directly, extending the identical pattern `log-retention-volume-control.md` already established for CloudWatch log expiry) — reviewed specifically since "never delete" is this phase's own first time relying on a *platform* mechanism rather than an application-level soft-delete flag for cleanup. No `DeleteItem`/`DeleteObject`/`TRUNCATE`/`DROP` anywhere in the Phase 4 diff, confirmed directly. `turnCredentialsRole`'s and `wsDefaultRole`'s IAM grants (§ infra review at each task's own merge) are each scoped to the narrowest action/prefix/resource the task needed — `cloudwatch:PutMetricData` (`wsDefaultRole`, TASK 4.4.2) is the one exception granted `resources: ['*']`, because that action supports no resource-level scoping at all (AWS's own constraint, confirmed against the action's own IAM reference, not a shortcut taken here).

## 5. Actual spend vs model

`ndn-prod` (357601815388) budget `ndn-monthly-cost-cap`, checked live 2026-08-27: **$0.492 month-to-date**, `HEALTHY`, against a $24.21 cap. No CloudWatch alarm in `ALARM` state (6 alarms, all `OK`, confirmed live — §1b). `03-cost-model.md` needed **no change at this gate**: its own M12 line for API Gateway WebSocket signalling and Cloudflare TURN, and its CloudWatch-alarms line's "6th alarm" note, were already updated at Gate G3 *ahead* of Phase 4's own elaboration (visible in the file's own text today) — Phase 4 built exactly what that forward-dated model already priced, with nothing landing outside it. Total model unchanged at **£8.69/month (M12)**; headroom against the £12–14 target unchanged at £3–5/month, £11.31 against the £20 cap.

**This is not the same thing as the gate's own cost-comparison criterion.** §5's own job is "modelled vs currently-running spend," which holds; G4's *own* gate-specific criterion (§ Go/no-go) is "a real TURN-relayed call's own measured GB vs the ≈85 GB worst-case figure" — a different, narrower comparison this account has no real reading for yet, because nothing has used TURN in production. Both are true at once: the model is accurate for what is deployed, and the one figure that would prove the TURN line's own worst-case assumption has not been measured.

## 6. Security + dependency check

`pnpm audit --audit-level=high`: no known vulnerabilities (§1). No new IAM grant wider than the resource it needs (§4). No new secret-bearing constant committed as a literal — `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME` (TASK 4.4.1) follow the identical "name in code, value out-of-band via `aws ssm put-parameter --type SecureString`" convention `TURNSTILE_SECRET_PARAMETER_NAME` already established — checked directly, the key id is still the empty string in the committed source.

No new finding of the TASK 4.4.1-era `stripe` dependency-behaviour kind (`gate-g3-report.md` §6a) surfaced this gate; that finding itself needed no further action and none was taken.

## 7. a11y / i18n on new surfaces

The i18n hardcoded-string lint rule ran clean across every Phase 4 surface (§1). `call.astro` is the first page in this codebase to call `t()` from inside a React island at render time rather than only once at page-render time (the too-early countdown's own live minute count) — confirmed this does not bypass the lint rule, since the rule flags literal strings, not `t()` calls, and none of TASK 4.5.1's own new JSX carries a literal. Every Phase 4 UI task (4.3.1's call page, 4.3.2's device check, 4.5.1's join button) repeats the same honestly-scoped position every account-shell task has stated since Phase 2: construction-time accessibility (semantic HTML, ARIA roles, native keyboard-reachable controls) rather than a live-session pr-env check, because no live-session pr-env mechanism exists yet for an authenticated route. **This gap is now named for the sixth time across three phases** (2.2.4, 3.1.1, 3.5.2, 3.6.2, and now every Phase 4 UI task) — not re-litigated further here, but it is exactly the gap TASK 5.3.1 is written to close below, rather than let it repeat a seventh time in Phase 6.

## 8. Production health

`ndn-prod`, checked live 2026-08-27:

- **Lambda functions:** 33 (+5 since G3 — §1b). No error-rate check run this gate beyond the alarm state below, since none of Phase 4's own functions has received real traffic yet (every video flag is off).
- **CloudWatch alarms:** 6, **0 in `ALARM` state** — `HealthAliasErrorsAlarm`, `HealthAliasLatencyAlarm`, `ndn-email-bounce-rate`, `ndn-email-complaint-rate`, `ndn-log-ingestion-volume`, `ndn-turn-relay-volume` (new), all `OK`.
- **DynamoDB:** 1 table, GSI1–GSI4 all `ACTIVE`, unchanged — Phase 4 added two new partitions (`CONN#`, `CALL#`) on the same table, no new index.
- **CloudFront:** 1 distribution, `Deployed`, `nourishthenerve.com`/`www.`/`next.` all served.
- **WebSocket API:** `SignallingWebSocketApi` live alongside `ContentHttpApi`/`HttpApi` — confirmed provisioned, not merely coded.
- **Flags:** `aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/ndn/flags/` returns **zero parameters** — every flag, Phase 1 through Phase 4, is off in production. This is the same deliberate, correct, build-dark-behind-flags posture G3 confirmed for Phase 1–3; Phase 4's own four flags (`video.signalling.enabled`, `video.callAuthz.enabled`, `video.call.enabled`, `video.turn.enabled`) join it rather than break it.
- **Log groups:** 48 total, **0 without a retention policy**.
- **Rollbacks this phase:** none observed across PRs #95–#103's own CI runs.

## 9. Price re-verification

Nothing new due at this gate. Cloudflare TURN's free-tier figure was re-verified live at Gate G3, ahead of Phase 4's own elaboration, and Phase 4 built nothing that changes the basis of that figure. The remaining four `UNVERIFIED` prices (`09-self-audit.md`) are all for services still unprovisioned (Vonage/MEF, Apple, EBS) — re-confirmed at this gate that none is silently already relied upon, same as at every prior gate.

## 10. Elaboration of Phase 5's stubs

Done — `05-execution-plan.md`'s Phase 5 section, ten tasks across five milestones (M5.1 load test at 10×, M5.2 security review, M5.3 the live-session a11y mechanism this gate's own §7 names as overdue, M5.4 an executed restore drill, M5.5 cost reconciliation + runbook consolidation + closing the remaining honestly-named gaps before go-live), replacing the prior stub row. The stub table's own "~10" estimate landed exactly on ten.

Two things worth reading even if the task specs are not:

1. **M5.4's own restore drill is this plan's first task whose entire DoD is an event, not a deployed artefact.** Every prior "Verification" line in this plan proves a mechanism exists and behaves correctly; TASK 5.4.1's own verification *is* the task — the mechanism (DynamoDB PITR) has been billed for and running since `03-cost-model.md`'s own M1 row, unused for its actual purpose until this task.
2. **TASK 5.3.1 exists because this gate's own §7 named the same gap for the sixth time.** Every account-shell task since TASK 2.2.4 has stated, honestly, that construction-time accessibility is real coverage but a live-session check is not — this is the task that finally builds one, closing a debt six tasks named and none was positioned to close on its own.

`03-cost-model.md` needed no change this gate (§5). `09-self-audit.md` is updated to record this gate's pass and its one open action item. `07-traceability.md`'s gate pointer is updated to G4; its own standing note is otherwise unchanged, repeated rather than re-argued (§2).

## 11. Files changed by this gate pass

- `docs/plan/05-execution-plan.md` — Phase 5 elaborated to full detail; stub table reduced to Phases 6–7.
- `docs/plan/09-self-audit.md` — this gate's pass recorded; the TURN-verification action item logged.
- `docs/plan/07-traceability.md` — gate pointer updated to G4.
- `docs/plan/gate-g4-report.md` — this report.

## Action items

**One blocking, carried forward until closed:** provision a real Cloudflare Realtime/Calls TURN key (`docs/runbooks/video-calls.md`'s own Owner Action), turn on Phase 4's four flags in a test environment, and run a real cross-network call forced through TURN (e.g. by blocking UDP on one side) — then re-run this gate's own §5/§10-adjacent comparison against the real `EstimatedTurnRelayGB` reading before treating Phase 4 as proven, or before any real patient's call depends on it. **Not blocking Phase 5's own work**, which needs none of Phase 4's video flags turned on to proceed (load test, security review, the a11y mechanism, and the restore drill are all independent of this action item) — see Go/no-go.

One standing item, unchanged in kind since Gate G1 and not this gate's to close: the FR/NFR traceability matrix still needs the source requirements brief from its owner (§2).
