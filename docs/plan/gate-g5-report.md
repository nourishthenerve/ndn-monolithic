# Gate G5 report — Phase 5 (hardening & launch)

**Date:** 2026-08-29 · **Scope:** TASK 5.1.1 through 5.5.3 · **Checklist:** [06-gate-checklists.md](06-gate-checklists.md) · **Previous gate:** [gate-g4-report.md](gate-g4-report.md)

## Go/no-go

**GO on this gate's own defining criterion — the first GO on a gate's own criterion since G1.** Gate G5's own line in `06-gate-checklists.md` is explicit: "restore drill evidence; load test at 10×." Both are real, dated events, not descriptions of a mechanism: TASK 5.1.1's 10×-derived load run executed 2026-08-22 (see [load-testing.md](../runbooks/load-testing.md)), and TASK 5.4.1's DynamoDB PITR restore drill executed 2026-08-28 (see [restore-drill.md](../runbooks/restore-drill.md)), both against disposable copies of production, both measured and recorded. Unlike Gate G4's own NO-GO on its criterion (no real TURN key provisioned), nothing blocks this gate's narrower criterion from being true today.

**That is a narrower claim than the stub table's own "G5 = WEB IS DONE" label, and this report does not conflate the two.** TASK 5.5.3's own DoD ties "the web product is live for real patients and clinicians" to that label, and it is not yet true: LL-05 (DPIA) and LL-06 (solicitor sign-off on R-04) remain deliberately deferred by the owner (D-29), and every patient-facing flag beyond the four already on for D-29's own synthetic-patient proof stays off until the owner closes both and separately, explicitly approves each flip — [go-live.md](../runbooks/go-live.md) (merged this gate, PR #130) is the sequence and the gate check, not the approval itself. Per `06-gate-checklists.md`'s standing structure, elaboration of the next phase's stubs ran regardless of this distinction (Phase 6, §10 below).

## 1. Full test suite

`pnpm -r lint && pnpm -r typecheck && pnpm test` run fresh against `main` (`b1f7f4d`) on 2026-08-29:

- **Lint:** clean across all 12 workspace packages.
- **Typecheck:** clean across all 12 workspace packages.
- **Tests:** **1,879 tests / 139 files, 0 failures.** Per package: `services/api` 1,397 (81 files), `infra` 244 (8), `packages/ui` 74 (16), `apps/web` 122 (21), `packages/i18n` 17 (3), `packages/eslint-plugin-no-destructive` 12 (2), `packages/shared-types` 4 (1), `packages/eslint-plugin-i18n` 2 (1), `apps/mobile` 1 (1), `packages/api-client` 1 (1), `services/workers` 1 (1), `tests` 4 (3).
- **`pnpm audit --audit-level=high`:** no known vulnerabilities.
- **`pnpm run test:coverage`:** **91.49% statements / 82.12% branches / 90.81% functions / 91.83% lines**, against the 80% branch floor. `services/api/src/projection.ts`'s own CI-enforced 100%/100%/100%/100% gate held with no error.
- **`pnpm lint:no-destructive`:** the fixture still fails as designed — 11 problems, 11 errors, unchanged since G3/G4, exit non-zero.
- **CI on `main`:** every push since G4 (PRs #105–#130) green.

## 1b. Regression diff against the previous gate

| Measure | G4 (2026-08-27) | G5 (2026-08-29) | Δ |
|---|---|---|---|
| Tests / files | 1,753 / 131 | 1,879 / 139 | +126 / +8 |
| Workspace packages | 12 | 12 | — |
| CloudFormation stacks (excl. `CDKToolkit`) | 4 | 4 | — |
| Lambda functions | 33 | 33 | **Net zero, reconciled by name, not assumed:** D-29 removed `RegistrationFunction`/`PostConfirmationFunction` and added `PatientAdminFunction` (net −1); TASK 5.4.1's D-22 backup pipeline added `BackupExportFunction` (+1) — the two cancel exactly. |
| Log groups, all with retention | 48 / 0 without | 48 / 0 without, **after a same-day fix — see §4** | 0 net, but not a quiet zero: 20 orphans accumulated and were found and removed this gate |
| DynamoDB tables | 1 | 1 | — |
| DynamoDB GSIs | 4 (GSI1–GSI4, all `ACTIVE`) | 4, all `ACTIVE` | — |
| CloudWatch alarms | 6 | 8 (`+ ndn-backup-export-errors, + ndn-backup-export-missed`) | +2, all `OK` |
| `ndn-prod` month-to-date spend | $0.492 (Aug 1–26) | $0.711 (Aug 1–29) | +$0.073/day — in line with G4's own run rate; no new recurring line this phase added (TASK 5.1.1/5.4.1's own costs are one-off and already reconciled at TASK 5.5.1) |

No test regressed. No previously-passing check now fails.

## 2. Requirement traceability

| Task | DoD | Status | Note |
|---|---|---|---|
| 5.1.1 Load-test harness, 10× run | A repeatable, documented 10×-derived run executed at least once | **COMPLETE** | Run executed 2026-08-22 against a disposable `DataStack`+`WebStack` copy; per-route p50/p95/p99/error/throttle captured. |
| 5.1.2 Cold-start p95 finding | NFR-05 (<500ms p95 cold) measured; fixed or priced | **COMPLETE (priced, not fixed)** | R-10: 6 of 6 sampled functions missed, root-caused to first-connection TLS setup via a live `SSMClient` flag read, not bundle size. Provisioned concurrency priced (~$32–33/mo for all 26 affected) and **not enabled** — an owner decision, named, not this gate's to make. |
| 5.2.1 Full-codebase security review | A holistic pass across the whole accumulated surface, not scoped to one gate's diff | **COMPLETE** | [gate-g4-security-review.md](gate-g4-security-review.md); 3 findings, 2 fixed (`deletionProtection`, ephemeral bucket `removalPolicy`/`autoDeleteObjects`), 1 named-and-accepted residual (the `autoDeleteObjects` log-group gap — see §4 below, where this gate's own periodic check confirmed the residual is exactly as small and as accumulating as predicted). |
| 5.2.2 DPIA skeleton updated | Reflects what Phases 2–4 actually built | **COMPLETE** | `docs/compliance/dpia-skeleton.md`, gained a section at TASK 2.1.3, amended for D-29's data flow at `patient-account-provisioning.md`'s own note — still explicitly a skeleton, LL-05's to finish, not this gate's. |
| 5.3.1 Live-session a11y check | At least one real, signed-in axe/keyboard pass, scheduled | **COMPLETE** | Landed in two parts, named honestly: the mechanism (routes, Playwright spec, CI job) is built and green; the owner actions (real test identities, GitHub secrets, a rolling test-appointment fixture) are named outstanding in [live-session-accessibility.md](../runbooks/live-session-accessibility.md), unchanged this gate. |
| 5.3.2 Full sweep + remediation | Zero findings against every account-shell route | **COMPLETE** | Run 2026-08-27, green, zero findings — a real principal clinician session and a keyboard-completeness sweep across the account shell. |
| 5.4.1 Restore drill | A real DynamoDB PITR restore, executed | **COMPLETE** | Executed 2026-08-28; found D-22's export layer missing mid-drill, which TASK immediately after this one built and re-drilled from — the drill finding real work for itself, not a rehearsal of an already-solved problem. |
| 5.5.1 Cost reconciliation | Actual Cost Explorer data vs. model, whole C-01 envelope | **COMPLETE** | `$0.08/mo` AWS Cost Explorer flat fee found live, the one real unmodelled line; M12 total corrected $10.52→$10.60 (£8.69→£8.76), rounding-level, headroom-to-cap updated to £11.24/month. |
| 5.5.2 Runbook consolidation + index | One index above 48+ files, no runbook merged or deleted | **COMPLETE** | `docs/runbooks/README.md`; found and closed 3 stale items live during the pass, named 6 genuinely-open owner items honestly rather than silently. |
| 5.5.3 Close named gaps, flip go-live flags | Every named gap closed; sequence documented; LL-05/LL-06 confirmed before any clinical-data flip; live for real patients | **MECHANISM COMPLETE, OWNER ACTION OUTSTANDING** | Step 1 (the "no reachable link" gap, both halves) closed 2026-08-28. Step 2 (the flag sequence itself) closed 2026-08-29 — [go-live.md](../runbooks/go-live.md), PR #130: two independent tracks, current live state verified, `video.turn.enabled`'s own separate blocker named. Steps 3–4 (LL-05/LL-06 closure; the owner's own approval to flip any patient-facing flag for a real patient) are **not this task's or this gate's to execute** — see Go/no-go. |
| **Gate G5's own criterion** | Restore drill evidence; load test at 10× | **MET** | See Go/no-go. |

`07-traceability.md` still points at itself for the FR/NFR matrix, unchanged in kind since G1 — Phase 5 cited no new FR (an operational phase, tied to NFR/decision/risk IDs instead), so this gate added nothing new to the matrix even in principle, exactly as `09-self-audit.md` already recorded. Repeated here rather than re-argued.

## 3. Authorisation-boundary re-audit (from scratch, live)

**R-09's own standing rule: re-audited at every gate, not only when the code changes.** Phase 5 introduced two new server-side entities beyond what Phase 4 left: the D-22 backup-export pipeline (an S3 object, not a DynamoDB row — no `private{}`/`visible{}` shape applies) and D-29's staff-mediated patient administration (`PatientAdminFunction`: `POST /patients`, `POST /patients/{id}/reset-password`, `GET /patients?email=`). Checked directly against `04-data-model-rbac.md`'s own `Patient profile` row — still a plain `R U` (self) / `C R U P` (Principal) row, **no `visible{}`/`private{}` split** — and against `patient-admin.ts`'s own handler: every field it reads or writes is account-identity metadata (email, name, Cognito `sub`, `account_status`), never a `clinical{}` value, confirmed by reading the handler directly rather than inferred from the RBAC table alone. `services/api/src/projection.ts` itself is unchanged since TASK 2.1.2 and every gate's own re-read since; its CI-enforced 100% coverage gate held with no error this gate too (§1). **Result: the boundary holds. Phase 5 needed no new entry in `ROLE_GATED_PRIVATE_ENTITY_TYPES`/`ASSESSMENT_SPLIT_ENTITY_TYPES`, and adds none.**

## 4. Destructive-code audit, and a periodic-check finding closed the same day

Full-repo `pnpm -r lint` (§1) is clean; the fixture proof (§1) still fires as designed. No `DeleteItem`/`DeleteObject`/`TRUNCATE`/`DROP` anywhere in the Phase 5 diff, confirmed directly — D-22's backup pipeline and D-29's account administration both follow the established "mark, never remove" discipline (`account_status` transitions, append-only audit rows).

**A periodic check this gate ran for real, per `aws-account-baseline.md`'s own standing instruction.** TASK 5.2.1's security review (Gate G4) found and accepted a residual: `s3.Bucket({autoDeleteObjects: true})`'s own singleton `Custom::S3AutoDeleteObjectsCustomResourceProvider` Lambda is built via a raw `CfnResource`, not `aws-cdk-lib/aws-lambda`'s `CfnFunction` class, so `log-retention.ts`'s `ExplicitLambdaLogGroupAspect` (`node instanceof CfnFunction`) cannot see it and cannot give it an explicit, retention-managed log group the way every Lambda this repo owns gets one. `aws-account-baseline.md` names the exact two-part check to run periodically until a real fix lands (a CDK upstream fix, or widening the aspect to match by CloudFormation resource type rather than TS class — both named there as "bigger than this task's own scope," a judgement this gate does not revisit). Run live this gate, 2026-08-29:

```text
$ aws --profile ndn-prod s3api list-buckets --query "Buckets[?starts_with(Name,'ndnwebstackpr')]"
(empty — no orphaned ephemeral buckets)
$ aws --profile ndn-prod logs describe-log-groups --query "logGroups[?retentionInDays==null].logGroupName"
20 groups: 19 × /aws/lambda/NdnWebStackPr<106..129>-CustomS3AutoDeleteObjectsCustomRe..., 1 × /aws/lambda/NdnLoadTestWebStack-CustomS3AutoDeleteObjectsCusto...
```

Every one of the 20 belongs to a stack `cloudformation list-stacks` confirms no longer exists (only `NdnAuthStack`/`NdnDataStack`/`NdnBudgetStack`/`NdnWebStack`/`CDKToolkit` remain) — pure orphaned metadata from destroyed ephemeral PR environments (TASK 0.6.3) and TASK 5.1.1's own disposable load-test stack, zero patient/clinical/content/media data. All 20 deleted directly (`aws logs delete-log-group`), under this repo's standing authority to remove unneeded infrastructure named in `aws-account-baseline.md` itself. Re-checked immediately after: **0 log groups without retention, 48 total** — the same figure Gate G4 reported, restored rather than newly achieved. The underlying gap this check exists for is unchanged and not re-litigated here; the count will grow again with the next batch of ephemeral PR runs until one of the two named fixes lands, which is exactly why the check is periodic rather than one-off.

No IAM grant wider than the resource it needs, checked against every Phase 5 role addition (`BackupExportFunctionRole`, widened `PatientAdminFunctionRole`) — each scoped to its own table partition prefix or, for `cognito-idp:AdminGetUser`/`AdminCreateUser`/`AdminSetUserPassword`, to the patient pool's own ARN.

## 5. Actual spend vs model

`ndn-prod` (357601815388) budget `ndn-monthly-cost-cap`, checked live 2026-08-29: **$0.711 month-to-date** (Aug 1–29), `HEALTHY`, against a $24.21 cap. 0 of 8 CloudWatch alarms in `ALARM` state. `03-cost-model.md`'s own M12 total was already reconciled against real Cost Explorer data at TASK 5.5.1 (2026-08-28, inside this same phase): $10.52→$10.60 (£8.69→£8.76), the one real unmodelled line being AWS Cost Explorer's own $0.08/mo flat fee, headroom-to-cap now £11.24/month. This gate's own re-check finds nothing further to reconcile — no new recurring line since that pass, TASK 5.1.1/5.4.1's own costs both one-off and already priced in their own sections.

## 6. Security + dependency check

`pnpm audit --audit-level=high`: no known vulnerabilities (§1). No new IAM grant wider than the resource it needs (§4). No new secret-bearing constant committed as a literal — every credential this phase touches (D-29's generated patient passwords) is generated server-side with `node:crypto`'s `randomInt`, returned once in a response body, never logged, never stored (`patient-account-provisioning.md`'s own "Least privilege"/"The password" sections). No new finding of the TASK 4.4.1-era `stripe` dependency-behaviour kind surfaced this gate.

## 7. a11y / i18n on new surfaces

The i18n hardcoded-string lint rule ran clean across every Phase 5 surface (§1). Every new account-shell page this phase added — `PatientAdminPanel.tsx` (D-29), `ClinicianCalendar.tsx` (TASK 5.5.3) — is registered in `account-routes.ts`, so both are automatically swept by TASK 5.3.1's own live-session axe/keyboard suite the moment its owner-side setup (real test identities, GitHub secrets) lands; neither page needed a separate, bespoke a11y task the way every earlier phase's UI work did, because this is the first phase built *after* that gap closed rather than before it — TASK 5.3.1's own point in naming it "closed... rather than let it repeat a seventh time in Phase 6" (its own words, at Gate G4) now reads correctly: it did not repeat in the rest of Phase 5 either.

## 8. Production health

`ndn-prod`, checked live 2026-08-29:

- **Lambda functions:** 33, net unchanged since G4 (§1b's own by-name reconciliation).
- **CloudWatch alarms:** 8, **0 in `ALARM` state** — `HealthAliasErrorsAlarm`, `HealthAliasLatencyAlarm`, `ndn-backup-export-errors` (new), `ndn-backup-export-missed` (new), `ndn-email-bounce-rate`, `ndn-email-complaint-rate`, `ndn-log-ingestion-volume`, `ndn-turn-relay-volume`, all `OK`.
- **DynamoDB:** 1 table, GSI1–GSI4 all `ACTIVE`, unchanged.
- **CloudFront:** 1 distribution, `Deployed`, `nourishthenerve.com`/`www.`/`next.` all served.
- **Flags:** `aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/ndn/flags/` returns **4 parameters, all `true`**: `auth.webSignIn.enabled`, `clinicians.administration.enabled`, `patients.administration.enabled`, `assignment.enabled` — all for D-29's synthetic-patient proof, per `go-live.md`'s own current-state table (§ that document, re-confirmed live this gate, unchanged since it was written). Every other flag, Phase 1 through Phase 4, still off.
- **Log groups:** 48 total, **0 without a retention policy**, after this gate's own §4 fix.
- **S3 buckets:** 5 (2 production, 1 CDK bootstrap assets, 1 backup-export, 1 CloudTrail) — no orphaned ephemeral bucket, confirmed live (§4).
- **Rollbacks this phase:** none observed across PRs #105–#130's own CI runs.

## 9. Price re-verification

**Apple Developer Program and Google Play registration, both re-verified live this gate** (WebSearch, cross-checked against multiple current sources): $99/yr and $25 one-off respectively, **both unchanged** since D-26's own original estimate. Converted at this plan's own £1=$1.2105 planning rate: £81.78/yr, £20.65. Struck from `09-self-audit.md`'s `UNVERIFIED` list — the third of the original six to move from deferred to resolved, at exactly the gate that document named for it ("Apple/EBS before Phase 6"). Three remain (Vonage UK SMS, MEF lead time, EBS gp3+IPv4), all for services no task has provisioned — re-confirmed, again, that none is silently relied upon.

## 10. Elaboration of Phase 6's stubs

Done — `05-execution-plan.md`'s Phase 6 section, fourteen tasks across seven milestones (M6.1 Expo scaffold + shared `api-client` + mobile sign-in; M6.2 patient-facing reads + profile/content; M6.3 appointments + push notifications; M6.4 messaging + its own push; M6.5 WebRTC on React Native + the join flow; M6.6 store readiness + observability; M6.7 submission + post-launch reconciliation), replacing the prior stub row. The stub table's own "~14" estimate landed exactly on fourteen, the same way Phase 5's own elaboration landed exactly on its own "~10" at Gate G4.

Two things worth reading even if the task specs are not:

1. **Phase 6 has less to cite than any phase before it.** Every earlier phase's elaboration could reach for an FR, an NFR, a decision or a risk the brief or this plan's own committed docs already anchored. Phase 6's own brief row is three cells with no milestone names and no FR/NFR at all — this elaboration cites D-26/ADR-0013, R-01's own forward-citation, LL-09/LL-10, and C-01/C-10, because that is genuinely everything there is to point at; the standing FR/NFR traceability gap (§2) is unaffected either way.
2. **TASK 6.3.2 is R-01's own forward-citation landing for real.** Every risk-register entry and self-audit red-team pass since TASK 2.3.1 has named "push notifications in Phase 6" as the answer to SMS reminder volume outrunning its own cap at scale; this is the task where that stops being a citation and becomes a third channel on the existing notification abstraction, on the same degradation ladder, not a parallel mechanism.

`03-cost-model.md` needed one change this gate (§9, the Apple/Google GBP conversion — not a model-total change, since both are already excluded per C-01). `09-self-audit.md` is updated to record this gate's pass, its one closed periodic-check finding, and the third `UNVERIFIED` price struck. `07-traceability.md`'s standing note is repeated for Phase 6 rather than re-argued (§2). `06-gate-checklists.md` gains a Gate G6 criterion, the same way each earlier phase's own elaboration named its gate.

## 11. Files changed by this gate pass

- `docs/plan/05-execution-plan.md` — Phase 6 elaborated to full detail; TASK 5.5.3's own status updated; stub table reduced to Phase 7 only.
- `docs/plan/06-gate-checklists.md` — Gate G6 criterion added.
- `docs/plan/07-traceability.md` — standing note extended to Phase 6/Gate G5.
- `docs/plan/09-self-audit.md` — this gate's pass recorded; the third `UNVERIFIED` price struck.
- `docs/plan/03-cost-model.md` — Apple/Google fees re-verified with GBP figures.
- `docs/plan/gate-g5-report.md` — this report.

## Action items

**Two, both owner-side, both already named elsewhere — repeated here, not re-argued:**

1. **LL-05 (DPIA) and LL-06 (solicitor sign-off, R-04)**, and the owner's own explicit, named, per-flag approval `go-live.md` requires before any patient-facing flag flips for a real (non-synthetic) patient. Not blocking this gate's own GO (see Go/no-go) — blocking only the broader "web is done" label TASK 5.5.3's own DoD ties to it.
2. **LL-09 (Apple Developer enrolment) and LL-10 (Google Play data-safety declarations)** — both start now, per `08-long-lead.md`'s own "After G5," as TASK 6.6.1's own first step. Real lead times (2–4 weeks, ~1 week) mean neither should be deferred past this gate's own pass.

**One standing item, unchanged in kind since Gate G1 and not this gate's to close:** the FR/NFR traceability matrix still needs the source requirements brief from its owner (§2).

**One periodic-check item, not fully closed, deliberately:** the `autoDeleteObjects` log-group residual (§4) is fixed *for today's account state*, not fixed *in the code* — the next batch of ephemeral PR runs will produce the identical orphans again until a real fix (a CDK upstream change, or widening `ExplicitLambdaLogGroupAspect` to match by CloudFormation resource type) lands. `aws-account-baseline.md` already names this as its own periodic check for exactly this reason; this gate's own contribution is running that check for real, not closing the gap it checks for.
