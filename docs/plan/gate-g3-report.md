# Gate G3 report — Phase 3 (clinical core)

**Date:** 2026-08-26 · **Scope:** TASK 3.1.1 through 3.6.2 · **Checklist:** [06-gate-checklists.md](06-gate-checklists.md) · **Previous gate:** [gate-g1-report.md](gate-g1-report.md) (Gate G2 was folded into Phase 3's elaboration commit, `71b0fd7`, per D-27 — no standalone G2 report exists in this tree; this report is the next one)

## Go/no-go

**GO.** G3's own gate-specific criterion — "no private field reachable by a patient in any code path" — is re-audited from scratch below (§3) and holds: `projection.ts`'s chokepoint is unchanged since TASK 2.1.2, both entities Phase 3 gave a real `private{}` half (diagnosis/care plan, assessment forms) route every read and write through it, `projection.ts` still carries CI-enforced 100% branch/line/function/statement coverage, and no other Phase 3 entity (appointments, content assignment, messages, caseload) carries a `private{}` field at all — confirmed against `04-data-model-rbac.md`, not assumed. Full test suite green, no known dependency vulnerabilities, production healthy, spend well inside the model. One dependency-behaviour finding is recorded at §6a — not a vulnerability, nothing this codebase did wrong, but worth a permanent record. Phase 4 is elaborated to full `§12` detail below (§10), closing this gate's own "elaborate the next phase's stubs" checklist item.

## 1. Full test suite

`pnpm -r lint && pnpm -r typecheck && pnpm test` run fresh against `main` (`fe92dfb`) on 2026-08-26:

- **Lint:** clean across all 12 workspace packages, including `check-no-disable-comments.mjs` and the i18n hardcoded-string rule.
- **Typecheck:** clean across all 12 workspace packages.
- **Tests:** **1,533 tests / 122 files, 0 failures** (+5 Playwright reduced-motion, counted separately per the convention `gate-g1-report.md` established). Per package: `services/api` 1,153 (74 files), `infra` 201 (8 files), `packages/ui` 74 (16 files, +5 Playwright reduced-motion), `apps/web` 66 (12 files), `packages/i18n` 17 (3 files), `packages/eslint-plugin-no-destructive` 12 (2 files), `packages/shared-types` 3 (1 file), `packages/eslint-plugin-i18n` 2 (1 file), `apps/mobile` 1, `packages/api-client` 1, `services/workers` 1, `tests` 2.
- **`pnpm test:coverage`:** ran clean, no threshold failure reported. `projection.ts`'s own 100%-lines/branches/functions/statements gate (`vitest.config.ts`) held with no error — the exact `ERROR: Coverage for … does not meet` message `private-field-boundary.md` documents did not fire. Repo-wide coverage 94.16% statements / 83.49% branches / 93.75% functions / 94.36% lines, against the repo's own 80% floor.
- **`pnpm audit --audit-level=high`:** no known vulnerabilities.
- **`pnpm lint:no-destructive`:** the fixture (`infra/src/__fixtures__/no-destructive/should-fail.ts`) still fails as designed — **11 problems, 11 errors**, exit non-zero. One fewer than `gate-g1-report.md`'s "12 fixture violations caught": the fixture file itself has not changed since its original commit (`8e83bf3`, TASK 0.3.1), and the rule has only ever gained a banned identifier since (`AdminDeleteUserCommand`, TASK 2.4.1) — checked directly against the rule's own git history, not assumed. The count difference does not point at a weakened check; not investigated further, since the property this test actually proves — the rule fires and blocks a merge — is intact and the rule's own direction of travel is stricter, not looser.
- **CI on `main`:** the last three runs are green (`32975153262`, `32630296219`, `32602784952`); the one non-green entry in the window, `32975137293`, is a superseded run on the immediately-prior commit, cancelled in favour of the next push, not a failure.

**No skips to explain.** The `pr-environment` job's own pause-and-fix (`gate-g1-report.md` §7, closed 2026-08-21) held for the whole of Phase 2 and Phase 3: the job is still wired into `ci-summary`'s required-gate loop with no `&& false` reintroduced, confirmed by reading `.github/workflows/ci.yml` directly rather than inferring it from a historical run (GitHub's run-list API did not return results for several already-merged Phase 3 feature branches by branch name at the time of this review — a retention/lookup limitation of the query, not evidence of anything; the config itself is the more reliable source and was read directly).

## 1a. Regression diff against the previous gate

| Measure | G1 (2026-08-21) | G3 (2026-08-26) | Δ |
|---|---|---|---|
| Tests / files | 559 / 80 | 1,533 / 122 | +974 / +42 |
| Workspace packages | 12 | 12 | — |
| CloudFormation stacks (excl. `CDKToolkit`) | 3 (`NdnWebStack`, `NdnDataStack`, `NdnBudgetStack`) | 4 (`+ NdnAuthStack`, TASK 2.2.1) | +1 |
| Lambda functions | 13 | 28 | +15 |
| DynamoDB tables | 1 | 1 | — |
| DynamoDB GSIs | 1 (GSI1) | 4 (GSI1–GSI4, all `ACTIVE`) | +3 |
| Orphaned log groups, no retention | 10 (pre-fix, same-day) → 0 (post-fix) | 0 | — (G1's fix held) |
| `ndn-prod` month-to-date spend | $0.096 (partial month) | $0.44 (Aug 1–26) | not comparable — different points in the billing month; see §5 |

No test regressed. No previously-passing check now fails. The Lambda-function and GSI growth is Phase 2 (identity/RBAC/notifications/SMS) plus Phase 3 (clinical record, assessments, appointments, reminders, content assignment, messaging) landing in full — expected, not a finding.

## 2. Requirement traceability

| Task | DoD | Status | Note |
|---|---|---|---|
| 3.1.1 Patient's own profile | Patient R/U self, clinical/personal split on `PATCH` | **COMPLETE** | `services/api/src/patient.ts`/`patient-handler.ts` live; `containsPrivateField`-shaped discipline confirmed (no `private{}` on this entity). |
| 3.1.2 Sub-clinician's own caseload | `GET /caseload/mine`, GSI1's deferred grant used | **COMPLETE** | GSI1's `Query`-only IAM grant confirmed (§3). |
| 3.2.1 Diagnosis/care plan write | Versioned, append-only, optional `private{}` | **COMPLETE** | `clinical-record.ts` routes every write through `projectFor` before its own echo (§3). |
| 3.2.2 Diagnosis/care plan read | Patient sees `visible{}` only, every version | **COMPLETE** | `projectAllFor` applied per-version, not only to the latest (§3). |
| 3.3.1 Assessment forms write | Two-row `visible{}`/`private{}` split, versioned | **COMPLETE** | `ASSESSMENT_SPLIT_ENTITY_TYPES` branch in `projection.ts` confirmed live. |
| 3.3.2 Assessment forms read | Patient: visible only; clinician: both halves | **COMPLETE** | Two separate `can()` calls per `fieldSet`, not one merged decision (§3). |
| 3.4.1 Appointments + clinician calendar | GSI1's `APPT#` prefix, `Query`-only | **COMPLETE** | GSI1 confirmed `ACTIVE`; no `private{}` on this entity. |
| 3.4.2 Reschedule/cancel | Status transition, never delete | **COMPLETE** | No `DeleteItem`-shaped path exists (§4). |
| 3.4.3 1-hour reminder, GSI4, first real SMS | Sweep, idempotent, guard chain intact | **COMPLETE** | GSI4 confirmed `ACTIVE`. Runbook (`prod-deploy-gsi-catchup.md`) records the three-step production catch-up this GSI needed after initial deploy; closed and verified, per that runbook and the `docs/close-gsi-catchup-runbook` merge (PR #91). |
| 3.5.1 Content assignment | Clinician assigns published content only | **COMPLETE** | No `private{}` on this entity. |
| 3.5.2 "My content" page | Patient reads own assigned list, hydrated | **COMPLETE** | |
| 3.6.1 Messages, rate-limited | Bidirectional per corrected matrix row | **COMPLETE** | `04-data-model-rbac.md`'s Messages row confirmed already reads `C R (own patients)` for the assigned sub-clinician — the TASK 3.6.1 correction is live in the committed doc, not still pending. |
| 3.6.2 Message thread page | Both sides read/compose one thread | **COMPLETE** | |
| **Gate G3's own criterion** | No private field reachable by a patient, any code path | **HELD** | Full re-audit at §3. |

**The FR/NFR traceability-matrix gap is unchanged and still open.** `07-traceability.md` has carried this note since Gate G1; it repeats at every gate rather than closing, because closing it needs the source requirements brief from its owner, not more code. Checked at this gate on the chance the repo-root file `ndn-planning-brief-md-this-is-cozy-sunrise.md` (referenced by `00-index.md` as the plan's own source) closed it — it does not: that file is the *plan* this `docs/plan/` tree already derives from, citing the same FR/NFR IDs by number without defining any of them, and pointing at this same traceability file for the matrix. `07-traceability.md` is updated to record that check.

## 3. Authorisation-boundary re-audit (from scratch, live)

**G3's own criterion, checked directly rather than inferred from passing tests:**

1. **The chokepoint itself.** `services/api/src/projection.ts` is unchanged in shape since TASK 2.1.2 — read in full for this review. `mayReadPrivate` denies by default for any `entityType` it has not been explicitly told carries a private half (`ROLE_GATED_PRIVATE_ENTITY_TYPES` = `['diagnosis', 'care-plan']`, `ASSESSMENT_SPLIT_ENTITY_TYPES` = `[ASSESSMENT_ENTITY_TYPE]`) — an entity Phase 3 forgot to register here would fail closed, not open. `stripPrivate` walks arrays and nested objects, not only top-level keys.
2. **Every entity actually carrying `private{}`.** Confirmed against `04-data-model-rbac.md` directly, not assumed: exactly two rows carry a `private{}` half — Diagnosis/care plan and Assessment. Appointments, content assignment, messages and caseload carry none — confirmed by reading `caseload-repository.ts`'s own comment ("`Patient` carries no `private{}` field today, so this is a no-op in practice") and by absence of any `private` key in `appointment.ts`, `content-assignment.ts`, `message.ts`'s type definitions.
3. **Both private-bearing entities route through the chokepoint on every exit.** `clinical-record.ts` and `assessment.ts` both call `serialiseResponse` (never a bare `JSON.stringify`) and `projectFor`/`projectAllFor` on every read, and on their own create-response echo — the "forgot to project a freshly-created record" case TASK 2.1.2's own header names directly. Grepped for `JSON.stringify` across `services/api/src`: every other bare use is in an entity `04-data-model-rbac.md` gives no `private{}` half (public content, workshops, testimonials, registration, contact) or is a log/error line already covered by `redactPrivateText`/`containsPrivateField` — exactly the "two closed exits" `private-field-boundary.md` documents, re-confirmed rather than re-trusted.
4. **The coverage gate that makes this durable.** `pnpm test:coverage` run fresh for this review (§1): `projection.ts`'s CI-enforced 100%/100%/100%/100% threshold held with no error. Reproduced the failure mode `private-field-boundary.md` documents is not needed this gate — the passing run itself is the evidence, and the mechanism that would have caught a regression is confirmed live, not merely present in config.
5. **The two-row assessment case — R-09's own highest-consequence test.** `authz-matrix.ts` still asks `can()` twice per read where both halves might apply (once per `fieldSet`), never once with an inferred "give me everything." `assessment.test.ts` still carries the negative case named directly in the risk register and in `authz.test.ts`'s own test title.
6. **No new entity this gate reviewed introduces a leak surface.** Caseload, appointments, content assignment and messages were each checked individually against the matrix and against their own repository/handler source — none constructs a response from an unprojected record, and none needed to, since none carries anything to project.

**Result: the boundary holds, extended correctly, with no bypass found.** This is the second gate this specific, Critical-rated risk (R-09) has been re-audited from scratch at, per `09-self-audit.md`'s own standing rule that this check runs at every gate "rather than only when the code changes."

## 4. Destructive-code audit

Full-repo `pnpm -r lint` (§1) is clean — no destructive primitive reaches real source anywhere in the diff since G1. The fixture proof (§1) still fires as designed. Reviewed TASK 3.4.2 (cancel/reschedule) specifically, since "never delete" is its own explicit subject: cancellation is a `status` transition on the existing row; rescheduling is cancel-old plus create-new, never an in-place time change — confirmed directly in `appointment.ts`, no `UpdateItem` path touches `scheduledAt` on an existing row. No new destructive primitive, disable-comment, or IAM grant wider than `Query`/`GetItem`/`PutItem`/`UpdateItem` was introduced by Phase 3.

## 5. Actual spend vs model

`ndn-prod` (357601815388) budget `ndn-monthly-cost-cap`: **$0.435 month-to-date** (2026-08-26, `HEALTHY`) against a $24.21 cap (≈£20 at the planning rate). Cost Explorer confirms $0.36 unblended for the same window. No CloudWatch alarm in `ALARM` state. `03-cost-model.md`'s own M12 model, updated this gate for Phase 4's two new lines (§9, §10), moves from £8.67 to **£8.69/month** — headroom against the £12–14 target is £3.31–5.31 (stated as "£3–5" throughout this plan, unchanged at this precision), and £11.31 against the £20 cap. The move is $0.02 total; immaterial to the go/no-go.

## 6. Security + dependency check

`pnpm audit --audit-level=high`: no known vulnerabilities (§1). No new IAM grant wider than the resource it needs (§4).

### 6a. Finding — a dependency emits an agent-directed message, unprompted

Running the test suite for this review, `services/api`'s test output included a line neither this codebase nor this review produced:

```text
<claude-code-hint v="1" type="plugin" value="stripe@claude-plugins-official" />
```

Traced to source: `node_modules/.pnpm/stripe@22.5.0.../stripe/cjs/stripe.core.js`, lines 136–146. The official `stripe` SDK (pinned `^22.5.0`, `services/api/package.json`) checks `process.env.CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` and, when either is set, writes that line to **stderr** — a self-promotional message shaped to look like a Claude Code system tag, aimed at an AI agent reading tool output rather than at a human. **No action was taken on it** — no plugin was installed, nothing about this review's approach changed. This is not a vulnerability in this codebase and nothing here needs a code fix; it is the vendor SDK behaving differently when it detects an AI coding agent, and it is recorded here because a future reviewer (human or otherwise) hitting the same line deserves to know its origin rather than mistake it for a real system directive or a compromised dependency. Flagged to the account owner in this review's own session, per this assistant's standing instruction to surface a suspected prompt-injection shape rather than act on it silently.

## 7. a11y / i18n on new surfaces

The i18n hardcoded-string lint rule ran clean across every Phase 3 surface (§1). The `pr-environment` job remains wired into `ci-summary`'s required-gate loop (§1) — confirmed by reading `.github/workflows/ci.yml` directly, since GitHub's run-list query did not return historical results for the specific already-merged Phase 3 branches checked (a tooling/retention limit on the query itself, not a finding). Every Phase 3 UI task (3.1.1's patient page, 3.5.2's "my content" page, 3.6.2's message thread) documents the same honestly-scoped position in its own `Tests` line: construction-time accessibility (semantic HTML, ARIA roles, keyboard reachability) rather than a live-session pr-env check, because no live-session pr-env mechanism exists yet for an authenticated route — stated as a known gap in each task's own spec rather than claimed as more than it is, and unchanged since Phase 2 first drew that line. Not re-litigated further at this gate: nothing indicates the gap widened, and closing it is a Phase 5 (M5.3, a11y audit) concern, not a Phase 3 regression.

## 8. Production health

`ndn-prod`, checked live:

- **Lambda errors, last 24h:** 0 across every function that received traffic (`TestimonialModerationFunction` 3 invokes, `ReminderSweepFunction` 96, `WorkshopReadFunction` 6, `ContentReadFunction` 7 — all 0 errors).
- **CloudWatch alarms:** 0 in `ALARM` state.
- **DynamoDB:** 1 table, GSI1–GSI4 all `ACTIVE` — confirms `prod-deploy-gsi-catchup.md`'s closure.
- **CloudFront:** 1 distribution, `Deployed`, carrying `nourishthenerve.com`/`www.`/`next.nourishthenerve.com`.
- **Live routes:** apex, `www.` and `next.` all `200`. `/content`, `/workshops`, `/testimonials` and `POST /contact` all still `404` — every Phase 1–3 feature flag reads off in production (`aws ssm describe-parameters` returns no `/ndn/flags/*` parameter at all). **This is the correct, intended state, not a repeat of G1's finding:** G1's finding was that the flag *mechanism* could never be turned on without a deploy; that mechanism was fixed the same day (SSM-backed source, `gate-g1-report.md` §3a). Nothing has been turned on since because nothing has reached the deliberate go-live decision this build-dark-behind-flags strategy exists to gate — confirmed as a deliberate posture, not re-flagged as a defect.
- **Log groups:** 43 total, **0 without a retention policy** — G1's same-day fix (§4 of that report) has held for five days and the whole of Phase 2 and Phase 3's deploys.
- **Rollbacks this phase:** none observed in the CI run history reviewed.

## 9. Price re-verification

`09-self-audit.md`'s `UNVERIFIED` list carried "Cloudflare TURN free-tier period," deferred explicitly to "the gate that precedes its first real use (TURN provider selection before Phase 4)" — this gate. Re-verified live 2026-08-26 against `developers.cloudflare.com/realtime/sfu/pricing`: **1,000 GB/month free, $0.05/GB overage — unchanged** from the figure `03-cost-model.md` has modelled against since Gate G0. Struck from the `UNVERIFIED` list (second of six, after AWS SMS at TASK 2.3.2). The remaining four (`.com`... already resolved; Vonage UK SMS, MEF lead time, Apple GBP fee, EBS gp3+IPv4) are all for services still unprovisioned — re-confirmed at this gate that none are silently already relied upon, same as at G0.

## 10. Elaboration of Phase 4's stubs

Done — `05-execution-plan.md`'s Phase 4 section, nine tasks across five milestones (M4.1 signalling, M4.2 server-side call authz, M4.3 peer connection/device check/fallback, M4.4 TURN + caps, M4.5 join-button state machine), replacing the prior stub row. Two things worth reading even if the task specs are not:

1. **The dependency-ordering check forced a redesign, not a renumbering.** `09-self-audit.md`'s own invariant — every task depends only on a lower-numbered one — ruled out signalling relay sitting ahead of call authorisation in M4.1, since a call cannot be relayed before it is joined. The relay handler moved into M4.2 as its own task (4.2.2) instead. The stub table's own "~12" estimate settled at nine; the elaboration's own preamble states why rather than padding to the estimate.
2. **`02-risk-register.md`'s R-03 already named `4.4.1, 4.4.2` by number**, written before either task existed. Both land on exactly those numbers: 4.4.1 issues short-lived, per-call TURN credentials and wires them into 4.3.3's existing fallback state machine as a second retry tier; 4.4.2 builds R-03's three-part mitigation — concurrent-relay cap, egress telemetry/alarm, kill-switch-degrades-to-audio-only — as one mechanism rather than three, since the hard cap refusing a new credential *is* the kill switch once 4.3.3's fallback already treats "no TURN available" as a legitimate path.

`03-cost-model.md` gains one new line (API Gateway WebSocket signalling, ≈$0.01–0.02/month at M6/M12, live-priced 2026-08-26) and updates the Cloudflare TURN row's basis to this gate's re-verification (§9). `09-self-audit.md` and `07-traceability.md` are both updated to record this gate's pass, per §2 and §9 above.

## 11. Files changed by this gate pass

- `docs/plan/05-execution-plan.md` — Phase 4 elaborated to full detail; stub table reduced to Phases 5–7.
- `docs/plan/03-cost-model.md` — API Gateway WebSocket line added; Cloudflare TURN and CloudWatch-alarms rows' basis updated; totals recomputed (M12 £8.67 → £8.69).
- `docs/plan/09-self-audit.md` — Cloudflare TURN struck from the `UNVERIFIED` list.
- `docs/plan/07-traceability.md` — gate pointer updated to G3; the repo-root planning-brief file checked and confirmed not a second source for the matrix.
- `docs/plan/gate-g3-report.md` — this report.

## Action items

**None blocking.** One standing item, unchanged in kind since Gate G1 and not this gate's to close: the FR/NFR traceability matrix needs the source requirements brief from its owner (§2). Everything else this checklist asks for is closed or confirmed-as-intended above.
