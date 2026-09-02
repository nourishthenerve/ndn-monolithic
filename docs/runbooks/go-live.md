# Go-live: the flag sequence, and its owner-approval gate (TASK 5.5.3)

**Depends on:** 5.5.1 (cost reconciliation), 5.5.2 (runbook index) · **Decisions:** D-27, D-29, **D-33** · **Risks:** R-04, R-16 · **Long-lead:** LL-05, LL-06

## The invariant

> Every flag from Phase 1 through Phase 4 ships default-off (D-23) and stays off until a named step below turns it on. This document is the sequence and the go/no-go gate — **it is not itself an approval, and running it does not flip anything.** Each flag flips only when the account owner names the step, at execution time, and confirms the gate condition that step's own row states. The mechanism that makes a flip safe (canary, smoke test, automatic rollback, TASK 0.6.2) is unchanged and already governs every flip below; this document adds the *order* and the *go/no-go*, not a new deployment path.

## Two independent tracks, not one line

`05-execution-plan.md`'s own TASK 5.5.3 text reads as a single ordered list — "authentication and profile before scheduling before messaging before video" — but that ordering is really two tracks that happen to interleave, and conflating them would either stall the public site behind a legal review it doesn't need, or rush patient data ahead of one it does.

- **Track A — public website.** `content.readApi.enabled`, `content.authoring.enabled`, `testimonials.enabled`, `workshops.enabled`. **`payments.stripeCheckout.enabled` removed from this track, permanently — D-31 (2026-08-29):** Stripe Checkout is abandoned before its first real use, not merely deferred; the owner's own decision is no online payment or registration on the website at all, ever. **`contact.form.enabled` removed from this track, permanently — D-32 (2026-08-30):** the contact form itself is deleted; a website visitor reaches the clinic over WhatsApp instead, a channel this document has no flag for because it isn't a technical integration. None of the remaining flags creates a patient record or touches `clinical{}`/`personal{}` data — a website visitor and a testimonial submitter are neither of them a patient in `04-data-model-rbac.md`'s sense. **Not gated by LL-05/LL-06 at all** — this track is a content/business readiness decision for the owner, the same kind of call TASK 1.6.1 already made turning on the apex.
- **Track B — the patient-facing platform.** `patients.administration.enabled`, `assignment.enabled`, `patients.profile.enabled`, `clinicalRecords.enabled`, `assessments.enabled`, `appointments.enabled`, `contentAssignment.enabled`, `messaging.enabled`, `caseload.view.enabled`, `video.signalling.enabled`, `video.callAuthz.enabled`, `video.turn.enabled`. Every one of these either creates or exposes a real patient's data. **Originally gated by LL-05/LL-06 for a real patient** — D-29's own words: "TASK 5.5.3's own go-live gate for real patient data is unaffected" by the synthetic-patient proof already run. **That gate was overridden by the owner's own explicit direction, D-33 (2026-08-30)** — "I will get it done legally later on but I want to go live now for real patients. go with it" — before LL-05/LL-06 closed, not after. This is not the gate condition being satisfied; it is the owner choosing to proceed without waiting for it, knowingly. `auth.webSignIn.enabled` and `clinicians.administration.enabled` sit outside both tracks: they authenticate *staff and clinicians*, not patients, and R-04/LL-05/LL-06 are about patient erasure, not clinician accounts — both are already on, for real clinicians, since Phase 2 (below). **`appointments.reminders.enabled` removed from this track, permanently — D-32 (2026-08-30):** the flag itself no longer exists; a clinician reminds a patient over WhatsApp, by hand.
- **`audit.readApi.enabled`** reads audit rows; per TASK 2.1.3's own design no row ever carries a `personal{}`/`clinical{}` value (repo-wide assertion, `dynamo-audit-log.test.ts`), so turning it on creates no new patient-data exposure regardless of which track's flags are already live. It can go on whenever a principal clinician needs the read, independent of the sequence below.

## Current live state, verified 2026-08-30

`aws --profile ndn-prod ssm describe-parameters --region eu-west-2 --parameter-filters Key=Name,Option=BeginsWith,Values=/ndn/flags/` — **19 parameters exist, all `true`; every other flag in `flags.ts`'s `FlagName` union has never been set and therefore reads `false` (D-23's "unset means off" default, `CachedFlagReader.isEnabled`):**

| Flag | Value | Why it's already on |
|---|---|---|
| `auth.webSignIn.enabled` | `true` | Real clinician sign-in has been live since the principal clinician account was created (`09-self-audit.md`'s Gate G1 pass); not patient data, outside both tracks. |
| `clinicians.administration.enabled` | `true` | Needed to create/manage clinician accounts — same reasoning, not patient data. |
| `patients.administration.enabled` | `true` | Turned on 2026-08-29 for D-29's synthetic-patient verification (`patient-account-provisioning.md`); **one real synthetic patient existed in production at that point** (`synthetic.test.patient1+ndn@example.com`). Superseded by Track B going live for real patients below — the flag itself is unchanged, only what it's used for. |
| `assignment.enabled` | `true` | Paired with `patients.administration.enabled`, same status. |
| `content.readApi.enabled` | `true` | **Track A, turned on 2026-08-30** — the owner's own explicit go-ahead, once every "human item" (Turnstile, TURN key, WhatsApp number, LL-04) was closed. `GET /content?keyword=blog` confirmed live (`{"items":[]}` — no posts authored yet). |
| `content.authoring.enabled` | `true` | Track A, same pass — the blog is now editable, not just readable. |
| `testimonials.enabled` | `true` | Track A. **2026-09-02 replaces `testimonials.submission.enabled` and `testimonials.moderationQueue.enabled`** — testimonials are written by signed-in patients and published on write, so there is no anonymous form to protect and no queue to open. Set the new flag on; the two old names are no longer read. |
| `workshops.enabled` | `true` | Track A, same pass — poster/detail pages are live, announcement-only (D-31). |
| `patients.profile.enabled` | `true` | **Track B, turned on 2026-08-30 — D-33's own explicit override, ahead of LL-05/LL-06 closing.** |
| `caseload.view.enabled` | `true` | Track B, same pass. |
| `clinicalRecords.enabled` | `true` | Track B, same pass. |
| `assessments.enabled` | `true` | Track B, same pass. |
| `appointments.enabled` | `true` | Track B, same pass. |
| `contentAssignment.enabled` | `true` | Track B, same pass — Track A's `content.authoring.enabled` already on means this can assign real content, not just the flag. |
| `messaging.enabled` | `true` | Track B, same pass. |
| `video.signalling.enabled` | `true` | Track B, same pass. |
| `video.callAuthz.enabled` | `true` | Track B, same pass. |
| `video.turn.enabled` | `true` | Track B, same pass — the real Cloudflare TURN key provisioned the same day means this one actually works, not just toggles on. |

`payments.stripeCheckout.enabled`, `sms.enabled`, `sms.killSwitchEngaged`, and `audit.readApi.enabled` remain off — see the note at the end of "Verification" below for why each one specifically.

**Track A is flags-on, not content-on.** Turning those five flags on makes the routes/pages reachable; it does not create a single blog post, workshop, or testimonial. `GET /content?keyword=blog` returning `{"items":[]}` above is the proof — the blog, testimonials and workshops pages will keep showing their empty states until a clinician actually authors something or a real testimonial is submitted and approved.

**Track B is flags-on for real patients, not LL-05/LL-06 closed.** See D-33 (`01-decisions.md`) and the Track B section below — this is the owner's own explicit, informed decision to proceed before that review, not a claim that it happened.

## Track A — sequence (no LL-05/LL-06 dependency; an owner content/business decision) — done, 2026-08-30

Ordered by what each later step displays or links to, not by any code dependency — nothing here technically requires the step before it.

1. ~~`content.readApi.enabled`, `content.authoring.enabled` — the blog becomes real and editable.~~ **Done.**
2. ~~`testimonials.submission.enabled`, then `testimonials.moderationQueue.enabled` — a queue with nothing in it is a safe intermediate state; open submission before the moderation UI is live only if that ordering is deliberately accepted.~~ **Done, in that order — and superseded 2026-09-02: both flags are replaced by `testimonials.enabled`, which has no ordering constraint because there is no queue.**
3. ~~`workshops.enabled` — poster/detail pages become real, announcement-only (D-31) — no capacity/price registration flow to sequence after it.~~ **Done.**

**`payments.stripeCheckout.enabled` is not step 4, or any step — it is never flipped, per D-31. `contact.form.enabled` is not a step either — the flag itself no longer exists, per D-32.** Both removed from this sequence rather than left as a step nobody runs, the same "named, not silently dropped" discipline this document already applies to `video.turn.enabled`'s own separate blocker.

## Track B — sequence — done, 2026-08-30, on the owner's own D-33 override, **not** on LL-05/LL-06 closing

**Original gate condition, repeated from D-29 and this task's own step 3: none of the steps below may run against a real patient until LL-05 (DPIA) and LL-06 (solicitor/DPO sign-off on R-04) are closed by their own owners.** That gate has **not** been satisfied — LL-05/LL-06 are still open, reframed for India rather than closed (`08-long-lead.md`). **The owner explicitly chose to proceed anyway — D-33 (2026-08-30):** "I will get it done legally later on but I want to go live now for real patients. go with it." `docs/compliance/dpia-skeleton.md` records this as a generic, clearly-labelled placeholder, not a completed review. The sequence below was already fully mechanism-proven against a synthetic patient (the status update dated 2026-08-29 in `patient-account-provisioning.md`); D-33 is the decision to run it for a real one before the legal review that was meant to precede that closes.

1. ~~`patients.administration.enabled` + `assignment.enabled` — already on, synthetic-proven (above). For a real patient: confirm LL-05/LL-06 closed, then the first `POST /patients` for a real WhatsApp-verified patient.~~ **Already on.** The first real, WhatsApp-verified patient account is a staff action from here — not gated by LL-05/LL-06 any further, per D-33.
2. ~~`patients.profile.enabled` (3.1.1/3.1.2)~~ — **Done.** The patient's own profile read/update, and the sub-clinician caseload list over the same approved patients.
3. ~~`caseload.view.enabled` (2.5.3)~~ — **Done.** The principal's cross-caseload view.
4. ~~`clinicalRecords.enabled` (3.2.1/3.2.2)~~ — **Done.** Diagnosis and care plan. **R-09's chokepoint** (`projection.ts`, TASK 2.1.2) is what this flag's first real row now exercises for real; the Gate G3 re-audit still holds (no code has changed the boundary since).
5. ~~`assessments.enabled` (3.3.1/3.3.2)~~ — **Done.** The `visible{}`/`private{}` split, same chokepoint.
6. ~~`appointments.enabled` (3.4.1)~~ — **Done.** Scheduling and the clinician calendar.
7. ~~`contentAssignment.enabled` (3.5.1)~~ — **Done.** Track A's `content.authoring.enabled` is already on, so this can actually assign real published content, not just the flag.
8. ~~`messaging.enabled` (3.6.1)~~ — **Done.** Patient↔clinician messaging.
9. ~~`video.signalling.enabled` (4.1.1), then `video.callAuthz.enabled` (4.2.1)~~ — **Done, in that order.**
10. ~~`video.turn.enabled` (4.4.1)~~ — **Done.** Its own separate, non-LL blocker (no real Cloudflare TURN key) closed 2026-08-30, same day as this Track B flip — `CLOUDFLARE_TURN_KEY_ID`/`/ndn/cloudflare-turn-api-token` are both real (`video-calls.md`).

**`appointments.reminders.enabled` was step 7 — it is not a step any more, per D-32 (2026-08-30): the flag itself no longer exists.** Removed from this sequence rather than left as a step nobody runs, the same "named, not silently dropped" discipline this document already applies to `payments.stripeCheckout.enabled`/`contact.form.enabled` in Track A.

**What this does and does not mean.** Every Track B feature now works for a real patient the same way it was already proven to work for the synthetic one. It does **not** mean LL-05/LL-06 are resolved, that a DPIA exists, or that Indian legal counsel has reviewed anything — `docs/compliance/dpia-skeleton.md`'s own D-33 section says this plainly. R-04 (the erasure tension) is exactly as unresolved now as it was before this flip; the difference is that real patient data is now the thing it's unresolved *against*, not a synthetic fixture.

## How a step actually runs, once approved

Same SSM parameter shape every flag in this codebase already uses (D-29's own commands are the template):

```bash
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/<flag-name> --type String --value true
```

Immediately after: watch the six CloudWatch alarms (`gate-g4-report.md` §8) for 15–30 minutes, and re-run `aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/ndn/flags/` to confirm only the intended parameter changed.

## Verification

`aws ssm describe-parameters ... Values=/ndn/flags/` shows flags coming on in the order recorded above (or an explicitly re-justified deviation, per this task's own "Do NOT" line). As of 2026-08-30, every Track A and Track B flag is `true` (19 of `flags.ts`'s 23 `FlagName` values) — the four left off are `payments.stripeCheckout.enabled` (never flipped, D-31), `sms.enabled`/`sms.killSwitchEngaged` (unreachable by any live code path since D-32 deleted their one caller), and `audit.readApi.enabled` (independent of this sequence, not flipped in this pass — turn on whenever a principal clinician actually needs the read).

## Rollback

Flip the one flag back off — the same "flag gates the decision, not the deploy" property every flag in this codebase has held since TASK 0.6.1:

```bash
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/<flag-name> --type String --value false
```

## Do NOT

- Run any command in this document unprompted. Every flip is the account owner's own named, explicit approval at execution time — this runbook is the sequence and the gate check, not a script to execute on its own authority.
- ~~Flip any Track B flag for a real patient before `08-long-lead.md` records LL-05 and LL-06 as closed.~~ **Overridden, 2026-08-30, D-33 — the owner's own explicit, informed choice, not a violation of this rule being ignored silently.** This line stood as the standing invariant right up until the owner named the override in so many words; it is kept here, struck through rather than deleted, so the fact that a real decision overrode it is part of the record, not papered over. Do not treat D-33 as blanket permission to flip *anything* else unprompted — it names this one override, once, and nothing broader.
- ~~Flip `video.turn.enabled` expecting it to work before a real Cloudflare TURN key is provisioned — it will not fail loudly, it will silently degrade every fallback to `call-failed`.~~ **Moot, 2026-08-30** — a real key is provisioned.
- Treat this document's existence, or TASK 5.5.3's own merge, as Gate G5 passing. Gate G5's own criterion (`06-gate-checklists.md`) is restore-drill evidence and a 10× load test — both already real, dated events (TASK 5.4.1, TASK 5.1.1/5.1.2) — separate from, and not satisfied by, anything in this file.
