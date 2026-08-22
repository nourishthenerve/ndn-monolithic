# The persistent, append-only audit log (TASK 2.1.3)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.1.3](../plan/05-execution-plan.md) · **Milestone:** M2.1 · **Requirements:** §6.2–6.4, NFR-06 · **Decisions:** D-07, D-21 · **Depends on:** 2.1.1, 1.3.1

**Superseded in part by [TASK 2.5.4](admin-token-retirement.md), 2026-08-22.** "The principal source is a bridge" section below described `GET /audit`'s original admin-token stand-in for a real principal; that bridge is retired, and this route sits behind the real Lambda authorizer like every other admin-shaped route now does. See the linked runbook.

## The invariant

> Every repository write lands a durable row saying who did what, when, and from where. Nothing can amend or remove one. The principal clinician can read a day of them, and nobody else can.

`docs/plan/04-data-model-rbac.md` has specified this row since the plan was committed — `AUDIT#<date>` / `<ts>#<id>`, "**Append-only**, who/what/when/where" — and until this task it existed as `InMemoryAuditLog`, an array in a Lambda's memory. Every `create`, `update`, `soft-delete`, `publish`, `unpublish`, `reject`, `cancel` and `confirm` this platform has ever performed was appended to it and discarded when the invocation ended.

That was correctly deferred at TASK 0.3.3 (no table existed) and then never revisited, exactly like the flag source Gate G1 §3a found. **Audit is the mechanism that makes an authorisation boundary reviewable at all**, so nothing else in Phase 2 could be reviewed after the fact until it was fixed.

## What was built

- **`services/api/src/dynamo-audit-log.ts`** (new) — `DynamoAuditLog implements AuditWriter` and `DynamoAuditReader implements AuditReader`. Keys are the data model's, unchanged.
- **`services/api/src/audit.ts`** — `AuditEvent` gains `actorRole`, `requestId` and `sourceIpHash`; `ActorContext` replaces the bare `actor: string` every repository method used to take; `InMemoryAuditLog` is demoted to a test double.
- **`services/api/src/audit-read.ts` + `audit-read-handler.ts`** (new) — `GET /audit?date=`, behind `can(principal, 'read', { entityType: 'audit' })`.
- **`infra/src/data-stack.ts`** — `AuditReadFunction`, its role (`dynamodb:Query`, nothing else), the route, and `AUDIT_TABLE_NAME` on every function that writes through a repository.
- **`infra/src/guardrails.ts`** — `denyAuditPartitionReadStatements`, attached to every *other* runtime role.

## Append-only, three ways

Not a convention — three independent mechanisms, and all three have to fail at once:

| Mechanism | Where | What it stops |
|---|---|---|
| The interface exposes no update and no removal | `audit.ts` — `AuditWriter` has exactly `write` | an amendment being written at all |
| `ConditionExpression: attribute_not_exists(pk)` | `dynamo-audit-log.ts` | a colliding `<ts>#<id>` silently overwriting the row that is there |
| `attachDestructiveActionGuardrail` (TASK 0.3.2) | every runtime role | `dynamodb:DeleteItem` against this table |

**No TTL attribute is written, anywhere near this partition.** A row that expires is a row that disappears without anybody deciding it should. `dynamo-audit-log.test.ts` asserts no attribute name contains `ttl` or `expire`.

## Who can read it, and who cannot

`docs/plan/04-data-model-rbac.md`'s matrix gives the audit log one `R`, in the `Principal` column, and `—` everywhere else. The endpoint asks `can()` and does nothing else:

| Caller | Answer |
|---|---|
| flag off | `404` — before a principal is even resolved |
| no identity on the request | `401` |
| patient (any relationship) | `403` |
| sub-clinician (assigned or not) | `403` |
| principal clinician, `deactivated` | `403` — status gates before role does |
| principal clinician, `active` | `200`, the day's events |

The 403 is returned **before** the `date` parameter is parsed, so a denied caller cannot tell a well-formed date from a malformed one by the shape of the refusal.

### The writers cannot read what they append

TASK 2.1.3 step 4 says the writer's grant is "`dynamodb:PutItem` only — no read, no update — so a compromised writer cannot read the log it appends to." On a single-table design (D-07) that needs a second half, because every writing function already holds `grantReadData` on the same table for its own entity's partitions, and a table-wide read grant reaches `AUDIT#<date>` as surely as it reaches `CONTENT#<id>`.

So the property is expressed as an explicit **Deny**, attached to all seven pre-existing roles and deliberately not to the audit reader:

```jsonc
{
  "Sid": "DenyAuditPartitionReads",
  "Effect": "Deny",
  "Action": ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:BatchGetItem"],
  "Condition": { "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["AUDIT#*"] } }
}
```

`dynamodb:LeadingKeys` is evaluated against the partition key values in the request, so a `Scan` — which names no key at all — would not match the condition and would not be denied. That is why a second, unconditional statement denies `dynamodb:Scan` and `dynamodb:PartiQLSelect` on the same role. Nothing in this repo scans or uses PartiQL, so it costs nothing and closes the bypass.

The mirror image holds for the reader: `AuditReadFunctionRole` has `dynamodb:Query` and no `PutItem`, `UpdateItem` or `DeleteItem` anywhere in its policy. `data-stack.test.ts` asserts both directions at synth.

## What a row contains, and what it must never contain

Eight fields, and there is no ninth:

| Field | Example | Why |
|---|---|---|
| `at` | `2026-08-21T10:00:00.000Z` | when; also derives the partition |
| `actor` | `sub-9f3c…` / a source-address hash | who, as an identifier — never a name |
| `actorRole` | `sub-clinician` / `public` / `system` | what they were acting as |
| `action` | `update` | what |
| `entityType`, `entityId` | `CarePlan`, `plan-1` | which row |
| `requestId` | API Gateway's own | the join key to the CloudWatch log line |
| `sourceIpHash` | SHA-256 hex | where from |

**No PII and no clinical content, ever** (step 5). A row records that patient `PAT#123`'s care plan was updated; never what it now says. This is enforced structurally rather than by review: `DynamoAuditLog.write` builds its item field by field and never spreads the event object, so an event that somehow carried a `personal{}`, `clinical{}` or `private{}` attribute persists none of them. `dynamo-audit-log.test.ts` writes exactly such a contaminated event and asserts the stored item has ten keys (the eight above plus `pk`/`sk`) and contains none of the contaminated values.

### One deviation from the planned interface: `sourceIpHash`, not `sourceIp`

The plan names the field `sourceIp`. It is stored hashed, and the reason is on the same page as the rest of this task:

- An IP address is personal data under UK GDPR.
- An audit row is the one row in this system that is appended once, never amended, never expired (step 6) and never deleted (C-03).
- Putting a raw address in it would create precisely the erasure tension `docs/plan/02-risk-register.md`'s **R-04** leaves open for the DPO — in the one place where this plan's own answer to erasure is "we cannot."
- A hash still answers what an audit trail asks of an address: *was this the same origin as that?*

It is also the convention this repo already had. `contact-form-handler.ts`, `testimonial-submission-handler.ts` and `stripe-checkout-handler.ts` each hashed the source address with their own copy of the same function ("never the raw address itself, never logged"); that copy now lives once, in `audit.ts`'s `hashSourceIp`.

### `actorRole` is wider than `Role`, on purpose

The plan types it `Role`. It is `Role | 'public' | 'system'`, because two actors that write audit rows today predate the identity system: an unauthenticated visitor submitting a testimonial or buying a workshop place, and the Stripe webhook. Mapping either onto a clinical role would put a clinician's role on a row a clinician had nothing to do with. **An audit log that misattributes is worse than one that admits what it does not know.**

A third member, `'admin-token'`, stood here until TASK 2.5.4 — the bearer-token bridge (`admin-auth.ts`) that content authoring, workshop authoring and testimonial moderation all acted as. Retired along with the bridge: no code path can construct one any more, but historical rows written under it are real, permanent data this type no longer describes — nothing validates a row read back from storage against `AuditActorRole` (`dynamo-audit-log.ts` trusts the read), so an old row with `actorRole: 'admin-token'` still reads back exactly as written.

## The actor is a parameter, not a decoration

Every repository method now takes an `ActorContext` where it used to take `actor: string`:

```ts
await repository.update(actor, id, patch);   // actor: ActorContext, not a bare string
```

The alternative — a request-scoped writer that decorates events with the `where` on their way out — was rejected: it makes "the handler forgot to set the context" a blank field in a row nobody looks at until they need it. As a parameter, a caller that cannot say where a write came from does not compile. Handlers build one with `actorContext(who, requestOriginOf(event))`; from TASK 2.2.x on, `actorFromPrincipal(principal, origin)` does it straight from the authenticated caller.

## A failed audit write fails the operation

Step 8, and it is not caught anywhere: if `write` rejects, the repository call that triggered it rejects, and the handler returns a 500. **An unauditable change to clinical data is worse than a rejected one.** `dynamo-audit-log.test.ts` asserts this end to end — a failing `PutCommand` surfaces as `Repository.create`'s rejection.

The practical consequence to know before an incident: a DynamoDB outage on this table takes writes down rather than degrading them. That is the intended trade.

## Operating it

**Turn the read API on:**

```bash
aws ssm put-parameter --name /ndn/flags/audit.readApi.enabled \
  --value true --type String --overwrite --region eu-west-2
```

Off is the default, and the writer is not flagged — audit rows are written whether or not anyone can read them through the API.

**Read a day**, with a real principal clinician's Cognito access token (TASK 2.5.4 — see [admin-token-retirement.md](admin-token-retirement.md) for how to obtain one):

```bash
curl -s -H "Authorization: Bearer $CLINICIAN_ACCESS_TOKEN" \
  "$API_URL/audit?date=2026-08-21" | jq '.items[] | {at, actor, actorRole, action, entityType, entityId}'
```

**Verify the writer really cannot read the log** (the plan's own verification line):

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::357601815388:role/<ContentAuthoringFunctionRole> \
  --action-names dynamodb:Query \
  --resource-arns arn:aws:dynamodb:eu-west-2:357601815388:table/<table> \
  --context-entries ContextKeyName=dynamodb:LeadingKeys,ContextKeyType=stringList,ContextKeyValues=AUDIT#2026-08-21 \
  --region eu-west-2 --query 'EvaluationResults[].EvalDecision'
```

Expect `explicitDeny` with the `AUDIT#` context entry, and `allowed` with a `CONTENT#` one — the second half matters as much as the first, since a Deny that also broke ordinary entity reads would be a regression, not a guard.

## The principal source, then and now

`audit-read-handler.ts` originally resolved a verified `ADMIN_API_TOKEN` into a stand-in principal-clinician `Principal` — there was no identity system yet, and TASK 2.2.2's Lambda authorizer was always the intended replacement. `audit-read.ts` itself never knew which bridge it was: it asks `can()` about a `Principal` and cannot tell where the `Principal` came from, so TASK 2.5.4's fix is confined entirely to `audit-read-handler.ts` — `resolvePrincipal` now reads `request-principal.ts`'s `optionalPrincipal(event)` off the real authorizer's context, and nothing in `audit-read.ts` changed.

Two things bounded the risk of the old bridge while it stood: the route was behind a default-off flag, and the token already authorised content authoring, workshop authoring and testimonial moderation — reading a log of one's own actions was a strictly smaller power than performing them. Both are moot now that the bridge is gone.

## What this does *not* record

**Reads are not audited.** `AuditAction` has no `'read'` member, and adding one is not this task's business — it would put a row on every page view of every patient record, which is a volume and cost decision (`03-cost-model.md`) rather than a boundary decision. It is worth knowing before an incident: `private-field-boundary.md`'s breach procedure says to "query the audit log for reads of the affected resource," and what the log can actually bound today is **who wrote what**, plus the `requestId` join into CloudWatch for the request that did it. Widening this belongs with 3.2.x, when the first entity with a `private{}` half is wired through the projection.

The audit read itself is also not audited, for the same reason and with the same caveat — the CloudWatch line for `/ndn/audit-read-function` is the record that a read happened, and that group is unmonitored by the log-volume alarm (see below) but retained for 14 days like every other.

## Log group and the alarm budget

`/ndn/audit-read-function` goes in `UNMONITORED_LOG_GROUP_NAMES` (`infra/src/config.ts`), **displacing nothing**. The alarm's ten metric slots are full against a hard `PutMetricAlarm` ceiling, and one principal clinician reading a day of rows behind a default-off flag is the smallest log volume any function in this estate can produce. `log-retention.test.ts` fails the build if a new `/ndn/*` group appears in neither list.

## Cost

£0.00 net-new. An audit row is a few hundred bytes and falls inside `03-cost-model.md`'s existing DynamoDB line; on-demand writes at this volume are rounding error. Re-check at G2 against real write volume — the number to watch is writes per authoring action, since every repository write is now two writes (the entity and its row).

## Verification

```bash
pnpm -r lint          # 12/12 packages clean
pnpm -r typecheck     # 12/12 packages clean
pnpm run test         # 86 files, 870 tests, all pass
pnpm run test:coverage
```

After deploy: an authoring action produces a queryable `AUDIT#<today>` row, and the `simulate-principal-policy` call above returns `explicitDeny` for `dynamodb:Query` on the writer role.

## If a row looks wrong

1. **Do not delete anything**, and do not try to correct it in place — there is no code path that can, and that is the point. A wrong row plus a later right row is the record; an amended row is not a record at all.
2. Join on `requestId` into the function's CloudWatch group to reconstruct the request.
3. If the row is *missing*, the operation that should have written it failed too (step 8) — look for the 500, not for a silent skip.
4. If a row carries something it should not, that is an R-09-class finding: follow `private-field-boundary.md`'s procedure, and fix at `DynamoAuditLog.write`, never at the call site.
