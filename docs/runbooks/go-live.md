# Go-live: the flag sequence, and its owner-approval gate (TASK 5.5.3)

**Depends on:** 5.5.1 (cost reconciliation), 5.5.2 (runbook index) · **Decisions:** D-27, D-29 · **Risks:** R-04, R-16 · **Long-lead:** LL-05, LL-06

## The invariant

> Every flag from Phase 1 through Phase 4 ships default-off (D-23) and stays off until a named step below turns it on. This document is the sequence and the go/no-go gate — **it is not itself an approval, and running it does not flip anything.** Each flag flips only when the account owner names the step, at execution time, and confirms the gate condition that step's own row states. The mechanism that makes a flip safe (canary, smoke test, automatic rollback, TASK 0.6.2) is unchanged and already governs every flip below; this document adds the *order* and the *go/no-go*, not a new deployment path.

## Two independent tracks, not one line

`05-execution-plan.md`'s own TASK 5.5.3 text reads as a single ordered list — "authentication and profile before scheduling before messaging before video" — but that ordering is really two tracks that happen to interleave, and conflating them would either stall the public site behind a legal review it doesn't need, or rush patient data ahead of one it does.

- **Track A — public website.** `content.readApi.enabled`, `content.authoring.enabled`, `contact.form.enabled`, `testimonials.submission.enabled`, `testimonials.moderationQueue.enabled`, `payments.stripeCheckout.enabled`, `workshops.enabled`. None of these creates a patient record or touches `clinical{}`/`personal{}` data — a website visitor, a contact-form sender and a workshop registrant are none of them a patient in `04-data-model-rbac.md`'s sense. **Not gated by LL-05/LL-06 at all** — this track is a content/business readiness decision for the owner, the same kind of call TASK 1.6.1 already made turning on the apex.
- **Track B — the patient-facing platform.** `patients.administration.enabled`, `assignment.enabled`, `patients.profile.enabled`, `clinicalRecords.enabled`, `assessments.enabled`, `appointments.enabled`, `appointments.reminders.enabled`, `contentAssignment.enabled`, `messaging.enabled`, `caseload.view.enabled`, `video.signalling.enabled`, `video.callAuthz.enabled`, `video.turn.enabled`. Every one of these either creates or exposes a real patient's data. **Gated by LL-05/LL-06 for a real patient** — D-29's own words: "TASK 5.5.3's own go-live gate for real patient data is unaffected" by the synthetic-patient proof already run. `auth.webSignIn.enabled` and `clinicians.administration.enabled` sit outside both tracks: they authenticate *staff and clinicians*, not patients, and R-04/LL-05/LL-06 are about patient erasure, not clinician accounts — both are already on, for real clinicians, since Phase 2 (below).
- **`audit.readApi.enabled`** reads audit rows; per TASK 2.1.3's own design no row ever carries a `personal{}`/`clinical{}` value (repo-wide assertion, `dynamo-audit-log.test.ts`), so turning it on creates no new patient-data exposure regardless of which track's flags are already live. It can go on whenever a principal clinician needs the read, independent of the sequence below.

## Current live state, verified 2026-08-29

`aws --profile ndn-prod ssm describe-parameters --region eu-west-2 --parameter-filters Key=Name,Option=BeginsWith,Values=/ndn/flags/` — **4 parameters exist, all `true`; every other flag in `flags.ts`'s `FlagName` union has never been set and therefore reads `false` (D-23's "unset means off" default, `CachedFlagReader.isEnabled`):**

| Flag | Value | Why it's already on |
|---|---|---|
| `auth.webSignIn.enabled` | `true` | Real clinician sign-in has been live since the principal clinician account was created (`09-self-audit.md`'s Gate G1 pass); not patient data, outside both tracks. |
| `clinicians.administration.enabled` | `true` | Needed to create/manage clinician accounts — same reasoning, not patient data. |
| `patients.administration.enabled` | `true` | Turned on 2026-08-29 for D-29's synthetic-patient verification (`patient-account-provisioning.md`); **one real synthetic patient exists in production today** (`synthetic.test.patient1+ndn@example.com`), left on deliberately for continued synthetic testing, not for a real patient. |
| `assignment.enabled` | `true` | Paired with `patients.administration.enabled` per that flag's own comment ("creating an account into a system with no route out of `pending` strands people there") — same synthetic-only status. |

Every other Track A and Track B flag is off. Nothing in this document changes that; it is a snapshot, re-checked at execution time, not assumed to still hold by the time any step below actually runs.

## Track A — sequence (no LL-05/LL-06 dependency; an owner content/business decision)

Ordered by what each later step displays or links to, not by any code dependency — nothing here technically requires the step before it, but turning on `payments.stripeCheckout.enabled` before `workshops.enabled` would sell a registration for a workshop page nobody can see yet.

1. `content.readApi.enabled`, `content.authoring.enabled` — the blog becomes real and editable.
2. `contact.form.enabled` — needs a real Turnstile widget/secret first; `contact-form.md` records the SSM `SecureString` for it as still absent — **a second, narrower owner action inside this step**, not this document's to resolve.
3. `testimonials.submission.enabled`, then `testimonials.moderationQueue.enabled` — a queue with nothing in it is a safe intermediate state; open submission before the moderation UI is live only if that ordering is deliberately accepted.
4. `workshops.enabled` — poster/detail pages become real.
5. `payments.stripeCheckout.enabled` — checkout against real workshop pages.

## Track B — sequence (blocked on LL-05/LL-06 for a real patient; already proven with synthetic patients)

**Gate condition, repeated from D-29 and this task's own step 3: none of the steps below may run against a real patient until LL-05 (DPIA) and LL-06 (solicitor/DPO sign-off on R-04) are closed by their own owners.** `docs/compliance/dpia-skeleton.md` and `08-long-lead.md` are the record of that closure; this document does not close either item itself and does not proceed past this check silently. Per `legal_compliance_deferred_by_owner`'s own standing status, both are **deliberately deferred** pending proof with synthetic patients — proof that TASK 5.5.3's own earlier work already delivered (the status update dated 2026-08-29 in `patient-account-provisioning.md`). The sequence below is therefore fully mechanism-proven and ready; what remains is the owner's own LL-05/LL-06 closure, then the same steps re-run for a real patient rather than the synthetic fixture.

1. `patients.administration.enabled` + `assignment.enabled` — **already on, synthetic-proven** (above). For a real patient: confirm LL-05/LL-06 closed, then the first `POST /patients` for a real WhatsApp-verified patient.
2. `patients.profile.enabled` (3.1.1/3.1.2) — the patient's own profile read/update, and the sub-clinician caseload list over the same approved patients.
3. `caseload.view.enabled` (2.5.3) — the principal's cross-caseload view, once more than a handful of assignments exist to make it meaningful.
4. `clinicalRecords.enabled` (3.2.1/3.2.2) — diagnosis and care plan. **R-09's chokepoint** (`projection.ts`, TASK 2.1.2) is what this flag's first real row exercises for real; re-confirm the Gate G3 re-audit still holds (it does — no code has changed the boundary since).
5. `assessments.enabled` (3.3.1/3.3.2) — the `visible{}`/`private{}` split, same chokepoint.
6. `appointments.enabled` (3.4.1) — scheduling and the clinician calendar.
7. `appointments.reminders.enabled` (3.4.3) — **independent flag by design (D-11)**, but sequenced after `appointments.enabled` here because a reminder needs a real appointment to remind about. This is also the first flag in this track that spends real money per use (SMS) — confirm `sms.enabled`/the SMS hard-cap (0.5.3) and `sms.killSwitchEngaged` are in the intended state first; both are a separate flag pair this document does not re-derive.
8. `contentAssignment.enabled` (3.5.1) — needs Track A's `content.authoring.enabled` already on with real published content to assign, not just the flag.
9. `messaging.enabled` (3.6.1) — patient↔clinician messaging.
10. `video.signalling.enabled` (4.1.1), then `video.callAuthz.enabled` (4.2.1) — a socket that connects but cannot join is the deliberately safe intermediate state TASK 4.2.1's own comment names; both are otherwise independent flags.
11. `video.turn.enabled` (4.4.1) — **has its own separate, non-LL blocker, unresolved as of Gate G4 and unchanged since:** no real Cloudflare Realtime/Calls TURN key is provisioned (`CLOUDFLARE_TURN_KEY_ID` still empty in `infra/src/config.ts`, confirmed absent from SSM at TASK 5.5.2's own pass). Turning this flag on before that key exists leaves TURN credential issuance non-functional and every fallback reaching `call-failed` after its one retry — not unsafe, just inert. Provisioning the key is the owner's own Cloudflare-dashboard step (`video-calls.md`), independent of LL-05/LL-06.

## How a step actually runs, once approved

Same SSM parameter shape every flag in this codebase already uses (D-29's own commands are the template):

```bash
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/<flag-name> --type String --value true
```

Immediately after: watch the six CloudWatch alarms (`gate-g4-report.md` §8) for 15–30 minutes, and re-run `aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/ndn/flags/` to confirm only the intended parameter changed.

## Verification

`aws ssm describe-parameters ... Values=/ndn/flags/` shows flags coming on in the order recorded above (or an explicitly re-justified deviation, per this task's own "Do NOT" line), never all at once; each Track B step past the current four is preceded by a dated confirmation that LL-05/LL-06 are closed, recorded in `08-long-lead.md`.

## Rollback

Flip the one flag back off — the same "flag gates the decision, not the deploy" property every flag in this codebase has held since TASK 0.6.1:

```bash
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/<flag-name> --type String --value false
```

## Do NOT

- Run any command in this document unprompted. Every flip is the account owner's own named, explicit approval at execution time — this runbook is the sequence and the gate check, not a script to execute on its own authority.
- Flip any Track B flag for a real patient before `08-long-lead.md` records LL-05 and LL-06 as closed. Continued synthetic-patient testing under the four already-on flags is the owner's own explicitly approved exception (D-29) and is not this gate.
- Flip `video.turn.enabled` expecting it to work before a real Cloudflare TURN key is provisioned — it will not fail loudly, it will silently degrade every fallback to `call-failed`.
- Treat this document's existence, or TASK 5.5.3's own merge, as Gate G5 passing. Gate G5's own criterion (`06-gate-checklists.md`) is restore-drill evidence and a 10× load test — both already real, dated events (TASK 5.4.1, TASK 5.1.1/5.1.2) — separate from, and not satisfied by, anything in this file.
