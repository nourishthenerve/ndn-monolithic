// TASK 1.3.1: first data-plane stack — one DynamoDB table
// (docs/plan/04-data-model-rbac.md's single-table design), on-demand
// billing (D-07), point-in-time recovery (D-21 — cheap even unused today,
// and turning it on later would lose the window between "table exists" and
// "PITR enabled"), RemovalPolicy.RETAIN (matches every other protected
// resource in this repo — 0.4.1's site bucket). Only GSI2 (keyword ->
// content) was created at this task's own commit; GSI1 (2.5.1), GSI3
// (2.5.3) and GSI4 (3.4.3) each landed additively with the Phase 2/3 task
// that first needed them — adding a GSI later is additive, not a
// migration, and every one of the four was proved in docs/adr/0002-
// database.md before its own `addGlobalSecondaryIndex` call.
//
// Also the guardrail's (0.3.2) first real exercise against a deployed table
// and a deployed runtime role — see attachDestructiveActionGuardrail below.
//
// This stack owns its own small HttpApi for GET /content (TASK 1.3.1 step
// 5, "minimal read API only") rather than extending web-stack.ts's — no
// CloudFront behavior routes to it yet, so it isn't reachable from the
// public site. TASK 1.3.2's blog pages consume it by calling the API's own
// execute-api.amazonaws.com URL directly at `astro build` time instead
// (see docs/runbooks/content-authoring.md) — same-origin CloudFront
// proxying stays deferred, since nothing needs a runtime browser call.
//
// TASK 1.3.2 adds the write side alongside it: ContentAuthoringFunction,
// its own least-privilege role (read + exactly the write actions it uses,
// not the broader grantWriteData()), and the four authoring routes.

import { fileURLToPath } from 'node:url';

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  WebSocketApi,
  WebSocketStage,
} from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpLambdaIntegration,
  WebSocketLambdaIntegration,
} from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

import { createBackupExportPipeline } from './backup-export.js';
import {
  CLINICIAN_ADMIN_AUTH_CLIENT_ID,
  CLINICIAN_USER_POOL_CLIENT_ID,
  CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME,
  CLOUDFLARE_TURN_KEY_ID,
  CLINICIAN_USER_POOL_ID,
  DOMAIN_NAME,
  PATIENT_USER_POOL_CLIENT_ID,
  PATIENT_USER_POOL_ID,
  SITE_ORIGIN,
  STRIPE_SECRET_KEY_PARAMETER_NAME,
  TURNSTILE_SECRET_PARAMETER_NAME,
  WWW_DOMAIN_NAME,
} from './config.js';
import { FLAG_ENVIRONMENT, grantFlagReads } from './flag-parameters.js';
import {
  attachAuditPartitionReadGuardrail,
  attachDestructiveActionGuardrail,
  AUDIT_PARTITION_KEY_PREFIX,
} from './guardrails.js';
import { createLogGroup } from './log-retention.js';
import { createRequestAuthorizer, PUBLIC_ROUTE } from './route-protection.js';
import { createWebSocketConnectAuthorizer } from './ws-authorizer.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

const GSI1_INDEX_NAME = 'GSI1';
const GSI2_INDEX_NAME = 'GSI2';
const GSI3_INDEX_NAME = 'GSI3';


export interface DataStackProps extends StackProps {
  /**
   * TASK 5.1.1: true for the disposable stack `LOAD_TEST=1` (bin/app.ts)
   * synthesizes. Unlike `WebStack`'s own `ephemeral` (TASK 0.6.3, one
   * per open PR, torn down within the same CI run), exactly one load-test
   * copy exists at a time, deployed and destroyed by a human running
   * `docs/runbooks/load-testing.md`'s own steps — so this flag only needs
   * to make `cdk destroy` actually work, not additionally guard against
   * concurrent collisions the way `prLabel` below does for two open PRs.
   * Toggles `DataTable`'s `removalPolicy` to `DESTROY`; every other
   * resource in this stack (the WebSocket/HTTP APIs, every Lambda) is
   * already unprotected and destroys cleanly regardless. Defaults to
   * false (production shape, unchanged) — `NdnDataStack` never sets this.
   */
  readonly ephemeral?: boolean;
  /**
   * TASK 0.6.3-style label mixed into every explicit log group name below,
   * the same collision-avoidance `WebStack`'s own `prLabel` documents.
   * First real caller is TASK 5.1.1's load-test stack (`'load-test'`) —
   * a fixed, reused label is fine there (one copy at a time, per
   * `ephemeral`'s own comment above), unlike a per-PR label's need for
   * per-PR uniqueness.
   */
  readonly prLabel?: string;
}

export class DataStack extends Stack {
  public readonly table: Table;
  /**
   * TASK 2.2.2: handed to `WebStack` (bin/app.ts) so both HTTP APIs put
   * the same function in front of their protected routes. Two authorizer
   * constructs, one implementation.
   */
  public readonly authorizerFunction: IFunction;

  constructor(scope: Construct, id: string, props: DataStackProps = {}) {
    super(scope, id, props);

    this.table = new Table(this, 'DataTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // TASK 5.1.1: `DESTROY` for the load-test stack alone — a table full
      // of synthetic 10x-derived traffic is exactly the data `RETAIN`
      // exists to protect *against* leaving behind, not protect. PITR
      // stays on either way; it governs recovery, not deletion, and
      // matching production's own shape here means a restore drilled
      // against this table (never done — TASK 5.4.1 restores production's)
      // would behave identically if it ever needed to.
      removalPolicy: props.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      // TASK 5.2.1: the same two-layer reasoning `auth-stack.ts`'s Cognito
      // pools already state for themselves — "RETAIN only governs what
      // CloudFormation does" — applied here for the first time. Neither
      // layer alone stops a direct `aws dynamodb delete-table` by a
      // principal outside CloudFormation (`ndn-deploy`, `ndn-admin`);
      // this table's own runtime-role IAM Deny (`guardrails.ts`) protects
      // every *application* Lambda from that action, but not those two.
      // `deletionProtection` is DynamoDB's own server-side refusal,
      // exactly Cognito's `deletionProtection` prop's own analogue,
      // applied to the one table holding every patient/clinical record
      // this system has — found holistically reviewing the whole account
      // rather than one gate's diff, since TASK 1.3.1 (this table) predates
      // TASK 2.2.1 (where the two-layer pattern was first established) by
      // weeks and was never revisited. `false` for the load-test copy —
      // it must stay freely destroyable, the same reasoning `removalPolicy`
      // above already gives.
      deletionProtection: !props.ephemeral,
      // TASK 4.1.1: enabled for the first time here, for the connection
      // table's own `ttl` attribute (connection-repository.ts) — sparse,
      // the same way GSI1-4's own projections are: only a `CONN#<id>` row
      // ever carries it, so no other entity's row is affected by turning
      // this on. An additive, in-place update (TimeToLiveSpecification is
      // mutable, confirmed against CloudFormation's own resource
      // reference), not a table replacement.
      timeToLiveAttribute: 'ttl',
    });

    // Sparse on purpose: only keyword-projection rows (content-repository.ts
    // in services/api) carry gsi2pk/gsi2sk, so a content item's own META
    // row never appears in a GSI2 query result. KEYS_ONLY is enough — the
    // read side follows up with a GetItem on the table's own pk/sk.
    this.table.addGlobalSecondaryIndex({
      indexName: GSI2_INDEX_NAME,
      partitionKey: { name: 'gsi2pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    // TASK 2.5.1: clinician → patients, and (TASK 3.4.x, not built here)
    // the clinician calendar — both proved against this one shape in
    // docs/adr/0002-database.md before this GSI was added. Sparse: only a
    // patient's PROFILE row carries gsi1pk/gsi1sk, and only while
    // assigned_clinician_id is set (dynamo-store.ts's DynamoAssignmentStore).
    // KEYS_ONLY, same reasoning GSI2 states — this task's own read
    // (assignment-repository.ts's listPatientIdsForClinician) only ever
    // needs the id off gsi1sk, and 3.4.x's future appointment rows would
    // need their own real content read separately regardless of what this
    // index projects.
    this.table.addGlobalSecondaryIndex({
      indexName: GSI1_INDEX_NAME,
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    // TASK 2.5.3: FR-DP-02's cross-caseload admin view, proved against
    // this shape in docs/adr/0002-database.md before this index was
    // added. Sparse: only a patient's PROFILE row carries gsi3pk, and only
    // while approved and assigned (dynamo-store.ts's DynamoAssignmentStore
    // — the same write that already derives GSI1's projection derives
    // this one). KEYS_ONLY: caseload-repository.ts's own read follows up
    // with a GetItem per id, the same shape GSI1/GSI2's own reads take.
    this.table.addGlobalSecondaryIndex({
      indexName: GSI3_INDEX_NAME,
      partitionKey: { name: 'gsi3pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    // TASK 3.4.3 added GSI4 here for appointment-window lookups feeding
    // the reminder sweep — D-32 (2026-08-30) deletes the sweep outright
    // (a clinician now reminds a patient over WhatsApp, by hand), and
    // GSI4 was its only caller (docs/adr/0002-database.md's own proof),
    // so this index is removed with it rather than left querying nothing.

    const logGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/content-read-function`
      : '/ndn/content-read-function';
    const authorizerLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/authorizer-function`
      : '/ndn/authorizer-function';
    const patientAdminLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/patient-admin-function`
      : '/ndn/patient-admin-function';
    const clinicianAdminLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/clinician-admin-function`
      : '/ndn/clinician-admin-function';
    const assignmentLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/assignment-function`
      : '/ndn/assignment-function';
    const caseloadLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/caseload-function`
      : '/ndn/caseload-function';
    const patientLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/patient-function`
      : '/ndn/patient-function';
    const clinicalRecordLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/clinical-record-function`
      : '/ndn/clinical-record-function';
    const assessmentLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/assessment-function`
      : '/ndn/assessment-function';
    const appointmentLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/appointment-function`
      : '/ndn/appointment-function';
    const contentAssignmentLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/content-assignment-function`
      : '/ndn/content-assignment-function';
    const messageLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/message-function`
      : '/ndn/message-function';
    const wsAuthorizerLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/ws-authorizer-function`
      : '/ndn/ws-authorizer-function';
    const wsConnectLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/ws-connect-function`
      : '/ndn/ws-connect-function';
    const wsDisconnectLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/ws-disconnect-function`
      : '/ndn/ws-disconnect-function';
    const wsDefaultLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/ws-default-function`
      : '/ndn/ws-default-function';
    const turnCredentialsLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/turn-credentials-function`
      : '/ndn/turn-credentials-function';

    // Explicit Role (rather than the NodejsFunction default) so the
    // guardrail below has a concrete construct to attach to, and so this
    // function's permissions are exactly "read the table, write its own
    // logs" — no broader default policy.
    const contentReadRole = new Role(this, 'ContentReadFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const contentReadFunction = new NodejsFunction(this, 'ContentReadFunction', {
      entry: `${moduleDir}../../services/api/src/content-read-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      role: contentReadRole,
      environment: {
        CONTENT_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'ContentReadFunctionLogGroup', logGroupName, contentReadRole),
    });
    grantFlagReads(this, contentReadRole);

    // TASK 1.3.1 step 5: "minimal read API only" — no PutItem/DeleteItem
    // grant here. Authoring (1.3.2) gets its own function and its own grant
    // when it exists.
    this.table.grantReadData(contentReadRole);

    // TASK 0.3.2's guardrail, first real exercise against a deployed table
    // and a deployed runtime role.
    attachDestructiveActionGuardrail(contentReadRole, { buckets: [], tables: [this.table] });
    // TASK 2.1.3 step 4: this role reads the table, and on a single-table
    // design that reach includes `AUDIT#<date>` unless it is denied
    // explicitly. Every role below carries the same pair.
    attachAuditPartitionReadGuardrail(contentReadRole, this.table);

    // TASK 1.3.2: the write side. A separate function/role from
    // ContentReadFunction — the read path stays exactly "read the table,
    // write its own logs" (comment above); this one additionally needs to
    // write content.
    const authoringLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/content-authoring-function`
      : '/ndn/content-authoring-function';

    const contentAuthoringRole = new Role(this, 'ContentAuthoringFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const contentAuthoringFunction = new NodejsFunction(this, 'ContentAuthoringFunction', {
      entry: `${moduleDir}../../services/api/src/content-authoring-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      role: contentAuthoringRole,
      environment: {
        CONTENT_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'ContentAuthoringFunctionLogGroup', authoringLogGroupName, contentAuthoringRole),
    });
    grantFlagReads(this, contentAuthoringRole);

    this.table.grantReadData(contentAuthoringRole);
    // Precise write actions only — deliberately not table.grantWriteData(),
    // whose action list includes dynamodb:DeleteItem (an Allow the
    // guardrail below denies right back, but the narrower grant means
    // there's no delete permission on this role's own identity policy to
    // begin with, not just one blocked by a second layer). ContentStore's
    // real writes (dynamo-store.ts) all go through TransactWriteCommand,
    // which needs both actions: TransactWriteItems for the transaction
    // itself, PutItem for what's inside it (AWS's IAM reference for
    // TransactWriteItems — permission is checked per enclosed operation
    // too, not just the transaction as a whole).
    contentAuthoringRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ContentAuthoringWrite',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
        resources: [this.table.tableArn],
      }),
    );

    // TASK 2.1.3: the same `dynamodb:PutItem` above is what appends this
    // function's audit rows — the audit partition lives in this table like
    // every other entity, so no second grant is needed. What *is* needed
    // is the matching read denial, attached below: a writer must not be
    // able to read the log it appends to.
    //
    // TASK 0.3.2's guardrail against this role too — defence in depth even
    // though the identity policy above never grants DeleteItem in the
    // first place (see the comment on the write grant just above).
    attachDestructiveActionGuardrail(contentAuthoringRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(contentAuthoringRole, this.table);

    // TASK 2.2.2: the Lambda authorizer, and the single most
    // security-sensitive function in this repository — everything
    // downstream trusts the `Principal` it produces.
    //
    // It lives in this stack because the account-status lookup it performs
    // is a GetItem on this table, and it is handed to `WebStack` as a prop
    // (bin/app.ts) so both HTTP APIs share one function rather than
    // deploying two copies of the same decision. One authorizer *construct*
    // per API is unavoidable — an API Gateway authorizer belongs to exactly
    // one API — but one function is not.
    const authorizerRole = new Role(this, 'AuthorizerFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    this.authorizerFunction = new NodejsFunction(this, 'AuthorizerFunction', {
      entry: `${moduleDir}../../services/api/src/authorizer-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Longer than the 5-second read functions: a cold invocation may
      // have to fetch a pool's JWKS over HTTPS before it can verify
      // anything. Still far below API Gateway's own 29-second ceiling.
      timeout: Duration.seconds(10),
      role: authorizerRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        PATIENT_USER_POOL_ID,
        PATIENT_USER_POOL_CLIENT_ID,
        CLINICIAN_USER_POOL_ID,
        CLINICIAN_USER_POOL_CLIENT_ID,
      },
      logGroup: createLogGroup(this, 'AuthorizerFunctionLogGroup', authorizerLogGroupName, authorizerRole),
    });

    // `dynamodb:GetItem`, on two partition prefixes, and nothing else.
    // Not `grantReadData()`, whose action list also carries Query, Scan
    // and BatchGetItem: this function performs exactly one keyed read of
    // one profile row, and a condition on `LeadingKeys` is what keeps a
    // future change from quietly widening that into a table-wide read on
    // the request path of every authenticated call.
    authorizerRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadPrincipalProfiles',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*', 'CLI#*'] },
        },
      }),
    );
    attachDestructiveActionGuardrail(authorizerRole, { buckets: [], tables: [this.table] });
    // It never writes an audit row (an authorizer decision is not a
    // repository write), so the audit partition is closed to it like every
    // other non-reader role.
    attachAuditPartitionReadGuardrail(authorizerRole, this.table);

    const authorizer = createRequestAuthorizer(this.authorizerFunction);

    const httpApi = new HttpApi(this, 'ContentHttpApi', {
      // TASK 1.4.2: testimonial submission is a live browser fetch (unlike
      // content, which apps/web only ever calls at `astro build` time —
      // see apps/web/src/blog/content-client.ts) — this API's own
      // execute-api.amazonaws.com origin differs from the site's own
      // origin, so a browser POST needs CORS.
      //
      // TASK 2.5.3 fix: this comment used to say "update DOMAIN_NAME here
      // alongside TASK 1.6.1's G1 cutover" — and TASK 1.6.1 never came
      // back to do it. `apps/web/src/site-config.ts`'s own `siteUrl` moved
      // to the apex at that cutover ("apex, not infra/src/config.ts's
      // DOMAIN_NAME"); this API's CORS policy did not, and has allowed
      // only `next.` ever since — silently breaking testimonial submission
      // and workshop checkout's live browser fetches from the apex, the
      // site's own canonical origin, for however long the DNS cutover has
      // been live. Fixed here, found only because this task's own caseload
      // fetch (the first authenticated browser call to this API) needed a
      // correct CORS policy to work at all. All three real origins are
      // listed — apex (canonical), www, and `next.` (kept as a staging
      // alias, config.ts's own DOMAIN_NAME comment) — and `authorization`
      // joins `content-type` in `allowHeaders`, the first header this API
      // needs for a bearer-token request rather than a public POST.
      // `PATCH` added 2026-08-31, and it was missing the whole time this
      // API has had a `PATCH` route on it. Found while working out why a
      // blog post would not save: `PATCH` is not a CORS-simple method, so
      // a browser preflights it, and a preflight response whose
      // `Access-Control-Allow-Methods` omits it makes the browser refuse
      // to send the real request at all. **Nothing reaches the API, so
      // nothing appears in any log** — the same silent shape as this
      // API's own 2026-08-22 CORS defect (`allowOrigins` still naming
      // only `next.`), and found the same way.
      //
      // Every `PATCH` this site makes from a browser was therefore dead:
      // a patient saving their own profile (`PATCH /patients/me`, live
      // since TASK 3.1.1), a clinician correcting a patient's details,
      // and a clinician renaming themselves. Only ever exercised by
      // handler tests and by `curl`, neither of which preflights.
      //
      // The list stays exactly the methods this API's routes actually
      // use — GET, POST, PATCH — rather than a wildcard: a method that is
      // not routed has no business being advertised as allowed.
      corsPreflight: {
        allowOrigins: [SITE_ORIGIN, `https://${WWW_DOMAIN_NAME}`, `https://${DOMAIN_NAME}`],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PATCH],
        allowHeaders: ['content-type', 'authorization'],
      },
      // TASK 2.2.2: **protected unless it says otherwise.** Every route on
      // this API takes the Lambda authorizer unless it explicitly passes
      // `HttpNoneAuthorizer`, so a route added without thinking about
      // authentication is closed rather than open. Each opt-out below
      // states why it is one, and data-stack.test.ts asserts the set of
      // opt-outs equals `UNAUTHENTICATED_ROUTE_KEYS` in config.ts — so
      // adding one is a two-file, deliberate act.
      defaultAuthorizer: authorizer,
    });
    httpApi.addRoutes({
      path: '/content',
      methods: [HttpMethod.GET],
      authorizer: PUBLIC_ROUTE,
      integration: new HttpLambdaIntegration('ContentReadIntegration', contentReadFunction),
    });

    // TASK 2.5.4: no `authorizer:` override on any of these four — the
    // real Lambda authorizer (`httpApi`'s `defaultAuthorizer`) applies,
    // same as the clinician-admin/assignment/caseload routes below.
    const contentAuthoringIntegration = new HttpLambdaIntegration(
      'ContentAuthoringIntegration',
      contentAuthoringFunction,
    );
    httpApi.addRoutes({
      path: '/content',
      methods: [HttpMethod.POST],
      integration: contentAuthoringIntegration,
    });
    httpApi.addRoutes({
      path: '/content/{id}',
      methods: [HttpMethod.PATCH],
      integration: contentAuthoringIntegration,
    });
    httpApi.addRoutes({
      path: '/content/{id}/publish',
      methods: [HttpMethod.POST],
      integration: contentAuthoringIntegration,
    });
    httpApi.addRoutes({
      path: '/content/{id}/unpublish',
      methods: [HttpMethod.POST],
      integration: contentAuthoringIntegration,
    });

    // TASK 1.4.2: testimonials — same table (docs/plan/05-execution-plan.md's
    // own cost line: "same table, no new resource type"), two more
    // functions/roles. TestimonialSubmissionFunction is the public write
    // path (Turnstile + rate-limited, see services/api/src/testimonial-submission.ts)
    // reachable by a live browser fetch, hence the CORS config on httpApi
    // above; TestimonialModerationFunction serves the public published-only
    // read plus the clinician-gated moderation queue and publish/reject
    // actions (TASK 2.5.4) — see testimonial-moderation.ts's own header for
    // why the queue moved off `GET /testimonials` onto its own path.
    const testimonialSubmissionLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/testimonial-submission-function`
      : '/ndn/testimonial-submission-function';

    const testimonialSubmissionRole = new Role(this, 'TestimonialSubmissionFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const testimonialSubmissionFunction = new NodejsFunction(
      this,
      'TestimonialSubmissionFunction',
      {
        entry: `${moduleDir}../../services/api/src/testimonial-submission-handler.ts`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(10),
        role: testimonialSubmissionRole,
        environment: {
          TESTIMONIAL_TABLE_NAME: this.table.tableName,
          AUDIT_TABLE_NAME: this.table.tableName,
          TURNSTILE_SECRET_PARAMETER_NAME,
          ...FLAG_ENVIRONMENT,
        },
        logGroup: createLogGroup(
          this,
          'TestimonialSubmissionFunctionLogGroup',
          testimonialSubmissionLogGroupName,
          testimonialSubmissionRole,
        ),
      },
    );

    grantFlagReads(this, testimonialSubmissionRole);

    // Precise write actions only — same reasoning ContentAuthoringWrite
    // documents above: DynamoContentStore/DynamoTestimonialStore's real
    // writes go through TransactWriteCommand (needs both actions), never
    // table.grantWriteData()'s broader DeleteItem-including grant.
    testimonialSubmissionRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'TestimonialSubmissionWrite',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
        resources: [this.table.tableArn],
      }),
    );
    attachDestructiveActionGuardrail(testimonialSubmissionRole, {
      buckets: [],
      tables: [this.table],
    });
    attachAuditPartitionReadGuardrail(testimonialSubmissionRole, this.table);
    testimonialSubmissionRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadTurnstileSecret',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: TURNSTILE_SECRET_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    httpApi.addRoutes({
      path: '/testimonials',
      methods: [HttpMethod.POST],
      authorizer: PUBLIC_ROUTE,
      integration: new HttpLambdaIntegration(
        'TestimonialSubmissionIntegration',
        testimonialSubmissionFunction,
      ),
    });

    const testimonialModerationLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/testimonial-moderation-function`
      : '/ndn/testimonial-moderation-function';

    const testimonialModerationRole = new Role(this, 'TestimonialModerationFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const testimonialModerationFunction = new NodejsFunction(
      this,
      'TestimonialModerationFunction',
      {
        entry: `${moduleDir}../../services/api/src/testimonial-moderation-handler.ts`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(5),
        role: testimonialModerationRole,
        environment: {
          TESTIMONIAL_TABLE_NAME: this.table.tableName,
          AUDIT_TABLE_NAME: this.table.tableName,
          ...FLAG_ENVIRONMENT,
        },
        logGroup: createLogGroup(
          this,
          'TestimonialModerationFunctionLogGroup',
          testimonialModerationLogGroupName,
          testimonialModerationRole,
        ),
      },
    );

    grantFlagReads(this, testimonialModerationRole);

    this.table.grantReadData(testimonialModerationRole);
    testimonialModerationRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'TestimonialModerationWrite',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
      }),
    );
    attachDestructiveActionGuardrail(testimonialModerationRole, {
      buckets: [],
      tables: [this.table],
    });
    attachAuditPartitionReadGuardrail(testimonialModerationRole, this.table);

    // TASK 2.5.4: `GET /testimonials` is genuinely public (PUBLIC_ROUTE —
    // published-only, unconditionally) — the real Lambda authorizer denies
    // outright on a missing bearer token, so it cannot also gate a route
    // an anonymous visitor must reach. The moderation queue moved to its
    // own path, `GET /testimonials/pending`, which takes no override and
    // so falls to `defaultAuthorizer` (the real one), same as publish/reject
    // below. See testimonial-moderation.ts's own header.
    const testimonialModerationIntegration = new HttpLambdaIntegration(
      'TestimonialModerationIntegration',
      testimonialModerationFunction,
    );
    httpApi.addRoutes({
      path: '/testimonials',
      methods: [HttpMethod.GET],
      authorizer: PUBLIC_ROUTE,
      integration: testimonialModerationIntegration,
    });
    httpApi.addRoutes({
      path: '/testimonials/pending',
      methods: [HttpMethod.GET],
      integration: testimonialModerationIntegration,
    });
    httpApi.addRoutes({
      path: '/testimonials/{id}/publish',
      methods: [HttpMethod.POST],
      integration: testimonialModerationIntegration,
    });
    httpApi.addRoutes({
      path: '/testimonials/{id}/reject',
      methods: [HttpMethod.POST],
      integration: testimonialModerationIntegration,
    });

    // TASK 1.5.1: workshops — same table, one more entity. Public read
    // (GET /workshops) and admin-token-gated authoring
    // (create/update/publish/cancel), same pattern as content/testimonials:
    // a read-only role and a table-write role, both guardrailed. The
    // presigned-upload endpoint for poster images lives in web-stack.ts
    // instead — see this constructor's own comment further down for why.
    const workshopReadLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/workshop-read-function`
      : '/ndn/workshop-read-function';

    const workshopReadRole = new Role(this, 'WorkshopReadFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const workshopReadFunction = new NodejsFunction(this, 'WorkshopReadFunction', {
      entry: `${moduleDir}../../services/api/src/workshop-read-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      role: workshopReadRole,
      environment: {
        WORKSHOP_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'WorkshopReadFunctionLogGroup', workshopReadLogGroupName, workshopReadRole),
    });
    grantFlagReads(this, workshopReadRole);

    this.table.grantReadData(workshopReadRole);
    attachDestructiveActionGuardrail(workshopReadRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(workshopReadRole, this.table);

    httpApi.addRoutes({
      path: '/workshops',
      methods: [HttpMethod.GET],
      authorizer: PUBLIC_ROUTE,
      integration: new HttpLambdaIntegration('WorkshopReadIntegration', workshopReadFunction),
    });

    const workshopAuthoringLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/workshop-authoring-function`
      : '/ndn/workshop-authoring-function';

    const workshopAuthoringRole = new Role(this, 'WorkshopAuthoringFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const workshopAuthoringFunction = new NodejsFunction(this, 'WorkshopAuthoringFunction', {
      entry: `${moduleDir}../../services/api/src/workshop-authoring-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      role: workshopAuthoringRole,
      environment: {
        WORKSHOP_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(
        this,
        'WorkshopAuthoringFunctionLogGroup',
        workshopAuthoringLogGroupName,
        workshopAuthoringRole,
      ),
    });
    grantFlagReads(this, workshopAuthoringRole);

    this.table.grantReadData(workshopAuthoringRole);
    // Precise write actions only — same reasoning ContentAuthoringWrite/
    // TestimonialSubmissionWrite document above: DynamoWorkshopStore's real
    // writes go through TransactWriteCommand (create) and PutCommand
    // (update), never table.grantWriteData()'s broader DeleteItem-including
    // grant.
    workshopAuthoringRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WorkshopAuthoringWrite',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
        resources: [this.table.tableArn],
      }),
    );
    attachDestructiveActionGuardrail(workshopAuthoringRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(workshopAuthoringRole, this.table);

    // TASK 2.5.4: no `authorizer:` override on any of these four —
    // `defaultAuthorizer` (the real one) applies.
    const workshopAuthoringIntegration = new HttpLambdaIntegration(
      'WorkshopAuthoringIntegration',
      workshopAuthoringFunction,
    );
    httpApi.addRoutes({
      path: '/workshops',
      methods: [HttpMethod.POST],
      integration: workshopAuthoringIntegration,
    });
    httpApi.addRoutes({
      path: '/workshops/{id}',
      methods: [HttpMethod.PATCH],
      integration: workshopAuthoringIntegration,
    });
    httpApi.addRoutes({
      path: '/workshops/{id}/publish',
      methods: [HttpMethod.POST],
      integration: workshopAuthoringIntegration,
    });
    httpApi.addRoutes({
      path: '/workshops/{id}/cancel',
      methods: [HttpMethod.POST],
      integration: workshopAuthoringIntegration,
    });

    // TASK 1.5.2 (ADR-0010): POST /workshops/{id}/checkout — same table,
    // one more function/role. Needs table read (look up the workshop),
    // dynamodb:PutItem (DynamoRegistrationStore.create — a plain
    // ConditionExpression-guarded PutCommand, not TransactWriteItems, since
    // a registration row has no companion projection row to write
    // alongside it) and dynamodb:UpdateItem (DynamoWorkshopCapacityStore's
    // atomic reserve/release against the WORKSHOP#<id>/CAPACITY row) plus
    // ssm:GetParameter on the Stripe secret key. The webhook function
    // (STRIPE_WEBHOOK_SECRET_PARAMETER_NAME, confirm/cancel + email) lives
    // in web-stack.ts instead — see that file's own TASK 1.5.2 comment for
    // why (a stable custom-domain URL for the Stripe dashboard).
    const workshopCheckoutLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/workshop-checkout-function`
      : '/ndn/workshop-checkout-function';

    const workshopCheckoutRole = new Role(this, 'WorkshopCheckoutFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const workshopCheckoutFunction = new NodejsFunction(this, 'WorkshopCheckoutFunction', {
      entry: `${moduleDir}../../services/api/src/stripe-checkout-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: workshopCheckoutRole,
      environment: {
        WORKSHOP_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        STRIPE_SECRET_KEY_PARAMETER_NAME,
        SITE_ORIGIN,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(
        this,
        'WorkshopCheckoutFunctionLogGroup',
        workshopCheckoutLogGroupName,
        workshopCheckoutRole,
      ),
    });
    grantFlagReads(this, workshopCheckoutRole);

    this.table.grantReadData(workshopCheckoutRole);
    // Precise write actions only — same reasoning ContentAuthoringWrite/
    // WorkshopAuthoringWrite document above, never table.grantWriteData()'s
    // broader DeleteItem-including grant.
    workshopCheckoutRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WorkshopCheckoutWrite',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
      }),
    );
    attachDestructiveActionGuardrail(workshopCheckoutRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(workshopCheckoutRole, this.table);
    workshopCheckoutRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadStripeSecretKey',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: STRIPE_SECRET_KEY_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    httpApi.addRoutes({
      path: '/workshops/{id}/checkout',
      methods: [HttpMethod.POST],
      authorizer: PUBLIC_ROUTE,
      integration: new HttpLambdaIntegration(
        'WorkshopCheckoutIntegration',
        workshopCheckoutFunction,
      ),
    });

    // TASK 2.1.3 step 7: `GET /audit?date=`, the principal clinician's read
    // of the append-only log. Its own function and its own role, holding
    // `dynamodb:Query` and nothing else — the mirror image of every role
    // above, which may append audit rows and may not read them.
    //
    // Log group `/ndn/audit-read-function` goes in
    // UNMONITORED_LOG_GROUP_NAMES (config.ts): the alarm's ten metric
    // slots are full, and a principal-only endpoint behind a
    // default-off flag is the lowest-volume group in the estate.
    const auditReadLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/audit-read-function`
      : '/ndn/audit-read-function';

    const auditReadRole = new Role(this, 'AuditReadFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const auditReadFunction = new NodejsFunction(this, 'AuditReadFunction', {
      entry: `${moduleDir}../../services/api/src/audit-read-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: auditReadRole,
      environment: {
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'AuditReadFunctionLogGroup', auditReadLogGroupName, auditReadRole),
    });
    grantFlagReads(this, auditReadRole);

    // `dynamodb:Query` alone — not table.grantReadData(), whose action list
    // also includes GetItem/Scan/BatchGetItem/DescribeTable. One day of
    // audit rows is one Query on one partition (dynamo-audit-log.ts), and
    // this role has no reason to reach the table any other way. No
    // PutItem, no UpdateItem: the reader cannot amend what it reads, which
    // is the other half of TASK 2.1.3 step 3's append-only property.
    auditReadRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAuditLog',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [this.table.tableArn],
      }),
    );
    // Deliberately *not* attachAuditPartitionReadGuardrail — this is the
    // one role that is supposed to read that partition.
    attachDestructiveActionGuardrail(auditReadRole, { buckets: [], tables: [this.table] });

    // D-29 (2026-08-29): the front door — `POST /patients` (staff create
    // an account on a patient's behalf, after a WhatsApp conversation) and
    // `POST /patients/{id}/reset-password` (staff issue a new one).
    // Replaces TASK 2.2.3's `RegistrationFunction`/`PostConfirmationFunction`
    // pair, both deleted outright: self sign-up is off (auth-stack.ts's own
    // header amendment), so there is no unauthenticated caller left to
    // rate-limit and no `ConfirmSignUp` event left for a trigger to react
    // to. Both routes here take no `authorizer:` override — the identical
    // shape `ClinicianAdminFunction`'s three routes below already use: the
    // caller is a real, authenticated principal, so the real authorizer
    // (2.2.2) is exactly the gate this needs, never `PUBLIC_ROUTE`.
    const patientAdminRole = new Role(this, 'PatientAdminFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const patientAdminFunction = new NodejsFunction(this, 'PatientAdminFunction', {
      entry: `${moduleDir}../../services/api/src/patient-admin-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Up to two sequential Cognito Admin* calls on the create path
      // (AdminCreateUser, then AdminSetUserPassword), one alone on the
      // reset path, each its own HTTPS round trip.
      timeout: Duration.seconds(10),
      role: patientAdminRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        PATIENT_USER_POOL_ID,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(
        this,
        'PatientAdminFunctionLogGroup',
        patientAdminLogGroupName,
        patientAdminRole,
      ),
    });
    grantFlagReads(this, patientAdminRole);

    // `GetItem` (the idempotent-register lookup on create, and the
    // existence check on reset) and `PutItem` (a new `PAT#` profile) on
    // the same `PAT#*` partition — the identical grant `PatientFunction`'s
    // own `ReadWritePatientProfile` statement already carries.
    //
    // 2026-09-01: unchanged, and it already covers the `ASSESS#…#v1` row
    // this function now writes at account creation ("the form is loaded
    // from the template the moment his account is being created"). Both
    // rows are on the same `PAT#<sub>` partition, and `LeadingKeys` is a
    // partition-key condition — IAM cannot express a sort-key one, which
    // is the same granularity limit every patient-scoped function in this
    // stack already accepts and names.
    patientAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWritePatientProfile',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // A separate statement, on `AUDIT#*` alone — account creation's audit
    // row rides `PatientRepository.register`'s own write (the same
    // `DynamoAuditLog` every repository uses); the reset-password route
    // writes one directly (patient-admin.ts's own header explains why).
    // The guardrail directly below is what stops this grant from ever
    // widening into a read of that partition.
    patientAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] },
        },
      }),
    );
    attachDestructiveActionGuardrail(patientAdminRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(patientAdminRole, this.table);

    // `AdminCreateUser`, `AdminSetUserPassword` and `AdminGetUser` only —
    // no `AdminDeleteUser` anywhere, the same repo-wide banned-identifier
    // guarantee `ClinicianAdminFunction`'s own grant comment below states.
    // `AdminGetUser` (D-29 follow-up, same day) is what `GET /patients?email=`
    // uses to find a patient's id by email — a direct lookup against the
    // pool's own username/alias, not a new DynamoDB index.
    const patientUserPoolArn = Stack.of(this).formatArn({
      service: 'cognito-idp',
      resource: 'userpool',
      resourceName: PATIENT_USER_POOL_ID,
    });
    patientAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'AdministerPatientCognitoUsers',
        effect: Effect.ALLOW,
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminGetUser',
          // 2026-09-01: suspend/restore. Until now suspension flipped
          // `account_status` and nothing else, so a "removed" patient
          // could still sign in — the clinician pool has had exactly
          // this trio since TASK 2.4.1, and the asymmetry was the bug.
          // `AdminDeleteUser` is absent here and denied outright by the
          // guardrail (C-03): a patient is disabled, never removed.
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminUserGlobalSignOut',
        ],
        resources: [patientUserPoolArn],
      }),
    );

    const patientAdminIntegration = new HttpLambdaIntegration(
      'PatientAdminIntegration',
      patientAdminFunction,
    );
    httpApi.addRoutes({
      path: '/patients',
      methods: [HttpMethod.POST],
      integration: patientAdminIntegration,
    });
    httpApi.addRoutes({
      path: '/patients',
      methods: [HttpMethod.GET],
      integration: patientAdminIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/reset-password',
      methods: [HttpMethod.POST],
      integration: patientAdminIntegration,
    });
    // 2026-08-31: "only the principal clinician would be able to remove
    // the patient". Governed by the `'Patient assignment'` row, not
    // `'Patient profile'` — see patient-admin.ts's own note on why those
    // two must not be the same permission.
    httpApi.addRoutes({
      path: '/patients/{id}/suspend',
      methods: [HttpMethod.POST],
      integration: patientAdminIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/restore',
      methods: [HttpMethod.POST],
      integration: patientAdminIntegration,
    });

    // TASK 2.5.4: no `authorizer:` override — `defaultAuthorizer` applies,
    // same as the content/testimonial/workshop authoring routes above.
    httpApi.addRoutes({
      path: '/audit',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('AuditReadIntegration', auditReadFunction),
    });

    // TASK 2.4.1: clinician accounts. `httpApi`'s `defaultAuthorizer` (the
    // real Lambda authorizer, TASK 2.2.2) applies as-is — these three
    // routes, like every other override-free route above, are not in
    // `route-protection.ts`'s `PUBLIC_ROUTE_KEYS`, and data-stack.test.ts's
    // opt-out-set assertion covers them by their absence.
    const clinicianAdminRole = new Role(this, 'ClinicianAdminFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const clinicianAdminFunction = new NodejsFunction(this, 'ClinicianAdminFunction', {
      entry: `${moduleDir}../../services/api/src/clinician-admin-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Up to six sequential Cognito Admin* calls on the create path
      // (create user, set password, then provisionTotp's own
      // AdminInitiateAuth/AssociateSoftwareToken/VerifySoftwareToken/
      // AdminRespondToAuthChallenge/AdminUserGlobalSignOut round trip),
      // each its own HTTPS round trip.
      timeout: Duration.seconds(15),
      role: clinicianAdminRole,
      environment: {
        CLINICIAN_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        CLINICIAN_USER_POOL_ID,
        // D-30: the server-side-only client `AdminInitiateAuth` runs
        // against to complete the new clinician's `MFA_SETUP` challenge —
        // never `CLINICIAN_USER_POOL_CLIENT_ID` above, which is the
        // browser's.
        CLINICIAN_ADMIN_AUTH_CLIENT_ID,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'ClinicianAdminFunctionLogGroup', clinicianAdminLogGroupName, clinicianAdminRole),
    });
    grantFlagReads(this, clinicianAdminRole);

    // Scoped to the `CLI#*` partition only — this function's repository
    // reach is exactly clinician-repository.ts's own, nothing wider.
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWriteClinicianAccounts',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CLI#*'] } },
      }),
    );
    // 2026-08-31: `GET /clinicians` — one `Query` against GSI2's fixed
    // `CLINICIAN_INDEX#all` partition (dynamo-store.ts), whose follow-up
    // `GetItem` per row is already covered by the statement above.
    // `dynamodb:Query` alone, never `grantReadData()` (whose action list
    // includes `Scan`) — `CaseloadFunctionRole`'s own `QueryCaseloadIndex`
    // statement states the same reasoning for GSI3. No `LeadingKeys`
    // condition: on an index query that condition matches the *index's*
    // partition key, which here is a fixed literal, not `CLI#*` — the
    // scoping that matters is the index ARN itself.
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'QueryClinicianDirectoryIndex',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/${GSI2_INDEX_NAME}`],
      }),
    );
    // The audit rows this function writes — `PutItem` only, never queried
    // back (attachAuditPartitionReadGuardrail below closes that).
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] },
        },
      }),
    );
    attachDestructiveActionGuardrail(clinicianAdminRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(clinicianAdminRole, this.table);

    // The Admin* calls clinician-admin-handler.ts's ports use — create,
    // disable, enable, global-sign-out — and nothing wider. D-32
    // (2026-08-30): `AdminGetUser` is removed — it existed only to
    // resolve an email for the now-deleted deactivation notice. No
    // `AdminDeleteUser` here or anywhere: `AdminDeleteUserCommand`
    // is a banned identifier repo-wide (packages/eslint-plugin-no-destructive),
    // so a future addition of it to this policy's own action list would
    // still leave no *code path* able to call it — the IAM grant and the
    // lint ban are independent guards on the same prohibition.
    const clinicianUserPoolArn = Stack.of(this).formatArn({
      service: 'cognito-idp',
      resource: 'userpool',
      resourceName: CLINICIAN_USER_POOL_ID,
    });
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'AdministerClinicianCognitoUsers',
        effect: Effect.ALLOW,
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminUserGlobalSignOut',
          // Found missing live, 2026-08-28 — see clinician-admin.ts's
          // AdminCreateClinicianPort header. Without this, a "principal"
          // clinician's own DynamoDB record was never reachable through
          // Cognito's `cognito:groups` claim, which is what
          // authorizer.ts's `roleFor()` actually reads.
          'cognito-idp:AdminAddUserToGroup',
          // D-30: the three Admin* calls `provisionTotp`'s own round trip
          // uses, and `AdminSetUserPassword` for the permanent password.
          // All four take a `UserPoolId`, so all four support this same
          // ARN-scoped resource condition — confirmed live via
          // `iam simulate-custom-policy` before this shipped, not assumed.
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:AdminRespondToAuthChallenge',
          // 2026-09-01: `AdminGetUser`, to tell an orphaned Cognito user
          // (a create that failed after minting one) from a genuine
          // duplicate address — the same lookup `patientAdminRole` has
          // carried since D-29's follow-up, for the same reason.
          'cognito-idp:AdminGetUser',
        ],
        resources: [clinicianUserPoolArn],
      }),
    );
    // D-30: `AssociateSoftwareToken`/`VerifySoftwareToken` operate on a
    // `Session` token, not a `UserPoolId` — confirmed live via
    // `iam simulate-custom-policy` that neither supports resource-level
    // scoping at all (a policy naming the clinician pool's own ARN
    // evaluates as `implicitDeny`; only `Resource: '*'` matches). The same
    // documented exception `wsDefaultRole`'s own `cloudwatch:PutMetricData`
    // grant already carries for the identical reason: some actions support
    // no resource-level scoping, and this is one of them, not a shortcut
    // taken here.
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ProvisionClinicianTotpSoftwareToken',
        effect: Effect.ALLOW,
        actions: ['cognito-idp:AssociateSoftwareToken', 'cognito-idp:VerifySoftwareToken'],
        resources: ['*'],
      }),
    );
    // D-34 (2026-08-31): `POST /clinicians/me/change-password`. Same
    // no-resource-level-scoping exception as `AssociateSoftwareToken`/
    // `VerifySoftwareToken` above, confirmed the same way those two
    // were — `ChangePasswordRequest`'s own SDK type
    // (@aws-sdk/client-cognito-identity-provider's models) has
    // `PreviousPassword`/`ProposedPassword`/`AccessToken` and no
    // `UserPoolId` field at all, so there is nothing in the request for
    // an ARN-scoped IAM condition to match against; `Resource: '*'` is
    // this action's only valid shape, not a shortcut taken here.
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ChangeOwnClinicianPassword',
        effect: Effect.ALLOW,
        actions: ['cognito-idp:ChangePassword'],
        resources: ['*'],
      }),
    );
    const clinicianAdminIntegration = new HttpLambdaIntegration(
      'ClinicianAdminIntegration',
      clinicianAdminFunction,
    );
    httpApi.addRoutes({
      path: '/clinicians',
      methods: [HttpMethod.POST],
      integration: clinicianAdminIntegration,
    });
    // 2026-08-31: the directory read. Same integration, same authorizer,
    // same Principal-only `can()` check inside — the principal's dashboard
    // needs a list of colleagues to reassign a patient to, and the
    // clinician-admin page needs one to deactivate from.
    httpApi.addRoutes({
      path: '/clinicians',
      methods: [HttpMethod.GET],
      integration: clinicianAdminIntegration,
    });
    httpApi.addRoutes({
      path: '/clinicians/{id}/deactivate',
      methods: [HttpMethod.POST],
      integration: clinicianAdminIntegration,
    });
    httpApi.addRoutes({
      path: '/clinicians/{id}/reactivate',
      methods: [HttpMethod.POST],
      integration: clinicianAdminIntegration,
    });
    // D-34: self-service, any signed-in clinician acting on their own
    // credential — never a patient, `clinician-admin.ts`'s own role
    // check enforces that, same "no `authorizer:` override" reasoning
    // every other route on this integration already states.
    httpApi.addRoutes({
      path: '/clinicians/me/change-password',
      methods: [HttpMethod.POST],
      integration: clinicianAdminIntegration,
    });
    // 2026-08-31: "other clinician would be able to update his details" —
    // the `Own profile` row's first endpoint, and self-service like
    // change-password above rather than principal-only. No `authorizer:`
    // override, same as every other route on this integration: the
    // route's own `can()` check on `'own-profile'` with the caller's own
    // clinician id is what scopes it.
    httpApi.addRoutes({
      path: '/clinicians/me',
      methods: [HttpMethod.GET, HttpMethod.PATCH],
      integration: clinicianAdminIntegration,
    });

    // TASK 2.5.1: approval and first assignment. No `authorizer:`
    // override, same reasoning as ClinicianAdminFunction's own routes —
    // only the principal ever passes `can()` on this row
    // (authz-matrix.ts's 'Patient assignment'), so the real authorizer is
    // exactly the gate this needs.
    //
    // D-32 (2026-08-30): TASK 2.5.2's own reassignment-notice grants
    // (`AdminGetUser` to resolve a clinician's email, `ses:SendEmail` to
    // notify) are deleted along with the notice itself — this role now
    // touches only DynamoDB.
    const assignmentRole = new Role(this, 'AssignmentFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const assignmentFunction = new NodejsFunction(this, 'AssignmentFunction', {
      entry: `${moduleDir}../../services/api/src/assignment-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: assignmentRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        CLINICIAN_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'AssignmentFunctionLogGroup', assignmentLogGroupName, assignmentRole),
    });
    grantFlagReads(this, assignmentRole);

    // The patient's own `PROFILE` row and the `ASSIGNREQ#` rows it writes
    // alongside it — both under the same `PAT#*` partition prefix
    // (dynamo-store.ts's DynamoAssignmentStore).
    assignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWritePatientAssignment',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // Read-only: this function only ever calls `ClinicianRepository.findById`
    // (validating the target of an approval) — it never creates,
    // deactivates or reactivates a clinician, so it gets none of
    // ClinicianAdminFunction's own write grant.
    assignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadClinicianAccounts',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CLI#*'] } },
      }),
    );
    assignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] },
        },
      }),
    );
    attachDestructiveActionGuardrail(assignmentRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(assignmentRole, this.table);

    const assignmentIntegration = new HttpLambdaIntegration('AssignmentIntegration', assignmentFunction);
    httpApi.addRoutes({
      path: '/patients/{id}/approve',
      methods: [HttpMethod.POST],
      integration: assignmentIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/decline',
      methods: [HttpMethod.POST],
      integration: assignmentIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/reassign',
      methods: [HttpMethod.POST],
      integration: assignmentIntegration,
    });

    // TASK 2.5.3: FR-DP-02's cross-caseload admin view. No `authorizer:`
    // override, same reasoning as the clinician-admin and assignment
    // routes — only the principal ever passes `can()` on `'Patient
    // profile'`'s Principal column for an unscoped resource (caseload.ts's
    // own comment on why that row, not a new one).
    const caseloadRole = new Role(this, 'CaseloadFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const caseloadFunction = new NodejsFunction(this, 'CaseloadFunction', {
      entry: `${moduleDir}../../services/api/src/caseload-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: caseloadRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        CLINICIAN_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'CaseloadFunctionLogGroup', caseloadLogGroupName, caseloadRole),
    });
    grantFlagReads(this, caseloadRole);

    // `dynamodb:Query` alone, on the table *and* GSI3's own index ARN —
    // not `table.grantReadData()`, whose action list also includes `Scan`
    // (the audit reader's own precedent, same reasoning: this task's DoD
    // is "no Scan reaches the table", not "no Scan happens to be called").
    caseloadRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'QueryCaseloadIndex',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/${GSI3_INDEX_NAME}`],
      }),
    );
    // The follow-up `GetItem` per page item (caseload-repository.ts's
    // `listPage`) — patient profiles only; this function never writes one.
    caseloadRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadPatientProfiles',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // The clinician-name lookup per distinct clinician on a page
    // (`ClinicianRepository.findById`) — read-only, same as
    // `AssignmentFunction`'s own `ReadClinicianAccounts` grant.
    caseloadRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadClinicianAccounts',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CLI#*'] } },
      }),
    );
    attachDestructiveActionGuardrail(caseloadRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(caseloadRole, this.table);

    httpApi.addRoutes({
      path: '/caseload',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('CaseloadIntegration', caseloadFunction),
    });

    // TASK 3.1.1: the patient's own profile, read and updated for real.
    // No `authorizer:` override, same reasoning as clinician-admin/
    // assignment/caseload — `authz-matrix.ts`'s `'Patient profile'` row
    // has stood implemented since TASK 2.1.1 with no handler to enforce
    // it until this one.
    const patientRole = new Role(this, 'PatientFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const patientFunction = new NodejsFunction(this, 'PatientFunction', {
      entry: `${moduleDir}../../services/api/src/patient-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: patientRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'PatientFunctionLogGroup', patientLogGroupName, patientRole),
    });
    grantFlagReads(this, patientRole);

    // Precise `GetItem`/`PutItem` on `PAT#*` only — not
    // `table.grantReadWriteData()`, whose write half also includes
    // `DeleteItem`. `PatientRepository.update` reads-then-writes the same
    // row (`repository.ts`'s own `requireActive` check), so both actions
    // are needed on the identical key prefix.
    patientRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWritePatientProfile',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // A separate statement, on `AUDIT#*` alone — `PatientRepository.update`
    // writes an audit row through the same `DynamoAuditLog` every other
    // writer in this stack uses; the guardrail directly below is what
    // stops this grant from ever widening into a read of that partition.
    patientRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] } },
      }),
    );
    // TASK 3.1.2: the GSI1 `Query` grant TASK 2.5.1's own runbook deferred
    // — "nothing this function's own routes call reaches
    // listPatientIdsForClinician; that grant lands with whichever future
    // task first calls it." This is that task. `dynamodb:Query` on the
    // table *and* GSI1's own index ARN, not `grantReadData()` (which also
    // carries `Scan`) — the identical shape `CaseloadFunction`'s own
    // `QueryCaseloadIndex` statement already uses for GSI3.
    patientRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'QueryOwnCaseloadIndex',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [this.table.tableArn, `${this.table.tableArn}/index/${GSI1_INDEX_NAME}`],
      }),
    );
    attachDestructiveActionGuardrail(patientRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(patientRole, this.table);

    const patientIntegration = new HttpLambdaIntegration('PatientIntegration', patientFunction);
    httpApi.addRoutes({
      path: '/caseload/mine',
      methods: [HttpMethod.GET],
      integration: patientIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}',
      methods: [HttpMethod.GET],
      integration: patientIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}',
      methods: [HttpMethod.PATCH],
      integration: patientIntegration,
    });

    // TASK 3.2.1: diagnosis and care plan — R-09's first real entity
    // through `projectFor`. A separate function and role from
    // `PatientFunction`, even though both read the `PAT#*` partition: this
    // one's write half reaches DynamoDB's `attribute_not_exists(pk)`
    // conditional `PutItem` path (`DynamoClinicalRecordStore`,
    // dynamo-store.ts) that a diagnosis/care-plan version needs and a
    // patient-profile edit does not, and keeping the two functions' IAM
    // roles separate means a change to one's policy can never silently
    // widen the other's.
    const clinicalRecordRole = new Role(this, 'ClinicalRecordFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const clinicalRecordFunction = new NodejsFunction(this, 'ClinicalRecordFunction', {
      entry: `${moduleDir}../../services/api/src/clinical-record-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: clinicalRecordRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'ClinicalRecordFunctionLogGroup', clinicalRecordLogGroupName, clinicalRecordRole),
    });
    grantFlagReads(this, clinicalRecordRole);

    // `GetItem` (the patient lookup `can()`'s relationship check needs)
    // and `PutItem` (a new `DIAG#v<n>`/`PLAN#v<n>` version) on the same
    // `PAT#*` partition — `dynamodb:LeadingKeys` restricts by partition
    // key only, the same granularity `PatientFunction`'s own
    // `ReadWritePatientProfile` statement already accepts, so this grant
    // is technically also capable of a `PAT#<id>`/`PROFILE` write; nothing
    // in `clinical-record.ts`/`clinical-record-repository.ts` ever issues
    // one — `patients` (`PatientDeps`) is called through `findById` only.
    clinicalRecordRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadPatientAndWriteClinicalRecords',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // A separate statement, on `AUDIT#*` alone — every version
    // `ClinicalRecordRepository.createVersion` writes reaches the same
    // `DynamoAuditLog` every other writer in this stack uses.
    clinicalRecordRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] } },
      }),
    );
    attachDestructiveActionGuardrail(clinicalRecordRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(clinicalRecordRole, this.table);

    const clinicalRecordIntegration = new HttpLambdaIntegration(
      'ClinicalRecordIntegration',
      clinicalRecordFunction,
    );
    httpApi.addRoutes({
      path: '/patients/{id}/diagnosis',
      methods: [HttpMethod.POST],
      integration: clinicalRecordIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/care-plan',
      methods: [HttpMethod.POST],
      integration: clinicalRecordIntegration,
    });
    // TASK 3.2.2: the read half, same integration — one Lambda already
    // serves both verbs on both paths.
    httpApi.addRoutes({
      path: '/patients/{id}/diagnosis',
      methods: [HttpMethod.GET],
      integration: clinicalRecordIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/care-plan',
      methods: [HttpMethod.GET],
      integration: clinicalRecordIntegration,
    });

    // TASK 3.3.1: assessment forms — a separate function/role from
    // `ClinicalRecordFunction`, even though both read/write `PAT#*`: this
    // is the entity `authz-matrix.ts` gives *two* matrix rows
    // (`visible{}`/`private{}`) rather than one row with an internal
    // split, and keeping it on its own role means a future change to
    // either entity's IAM policy can never silently widen the other's.
    const assessmentRole = new Role(this, 'AssessmentFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const assessmentFunction = new NodejsFunction(this, 'AssessmentFunction', {
      entry: `${moduleDir}../../services/api/src/assessment-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: assessmentRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'AssessmentFunctionLogGroup', assessmentLogGroupName, assessmentRole),
    });
    grantFlagReads(this, assessmentRole);

    // `GetItem` (the patient lookup) and `PutItem` (a new
    // `ASSESS#<assessmentId>#v<n>` version) on the same `PAT#*` partition
    // — the identical `ReadPatientAndWrite*` shape `ClinicalRecordFunction`
    // already carries, and the identical partition-key-only granularity
    // limit its own comment names.
    //
    // **2026-09-01 adds `Query`**, and only for the calendar section: its
    // "next appointment", "sessions so far" and "awaiting approval"
    // figures are derived from this patient's own `APPT#` rows on every
    // read rather than stored, so this function reads them. It writes no
    // appointment — booking stays on `AppointmentFunction`, and the
    // `PutItem` here is bounded to the `ASSESS#`/`NOTIF#` sort keys this
    // function actually writes by the code, not by IAM, which cannot
    // express a sort-key condition. That limit is the same one every
    // patient-scoped function in this stack already accepts.
    assessmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadPatientAndWriteAssessments',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    assessmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] } },
      }),
    );
    attachDestructiveActionGuardrail(assessmentRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(assessmentRole, this.table);

    const assessmentIntegration = new HttpLambdaIntegration('AssessmentIntegration', assessmentFunction);
    httpApi.addRoutes({
      path: '/patients/{id}/assessments/{assessmentId}',
      methods: [HttpMethod.POST],
      integration: assessmentIntegration,
    });
    // TASK 3.3.2: the read half, same integration — one Lambda already
    // serves both verbs on this path.
    httpApi.addRoutes({
      path: '/patients/{id}/assessments/{assessmentId}',
      methods: [HttpMethod.GET],
      integration: assessmentIntegration,
    });

    // TASK 3.4.1: appointments, and GSI1's second half — the clinician
    // calendar. `docs/adr/0002-database.md` proved this shape before
    // either GSI1 or this entity existed: `gsi1pk = CLI#<clinicianId>`,
    // `gsi1sk = APPT#<scheduledAt>`, on the identical partition TASK
    // 2.5.1's own clinician→patients projection already uses — the two
    // patterns never collide even sharing a partition, each query
    // scoping its own `gsi1sk` prefix.
    const appointmentRole = new Role(this, 'AppointmentFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const appointmentFunction = new NodejsFunction(this, 'AppointmentFunction', {
      entry: `${moduleDir}../../services/api/src/appointment-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: appointmentRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'AppointmentFunctionLogGroup', appointmentLogGroupName, appointmentRole),
    });
    grantFlagReads(this, appointmentRole);

    // `GetItem` (the patient lookup), `PutItem` (a new `APPT#<scheduledAt>`
    // row), `Query` (`listForPatient`'s own main-table `begins_with`
    // read), and `UpdateItem` (TASK 3.4.2's `cancel`, an atomic
    // `appointment_status` transition — never a new row, never
    // `scheduledAt`) — all on the same `PAT#*` partition, the same
    // partition-key-only granularity every other patient-scoped function
    // in this stack already accepts.
    appointmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWriteAndQueryPatientAppointments',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // A separate statement, GSI1's own index ARN — `dynamodb:Query` only
    // (never `Scan`), the identical shape `patientRole`'s own
    // `QueryOwnCaseloadIndex` statement already uses for the same index.
    // `listForClinicianCalendar`'s per-row follow-up `GetItem` (GSI1 is
    // `KEYS_ONLY`) reads the base table, already covered by the
    // statement above.
    appointmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'QueryClinicianCalendarIndex',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [`${this.table.tableArn}/index/${GSI1_INDEX_NAME}`],
      }),
    );
    // A separate statement, on `AUDIT#*` alone — every appointment
    // `AppointmentRepository.schedule` writes reaches the same
    // `DynamoAuditLog` every other writer in this stack uses.
    appointmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] } },
      }),
    );
    attachDestructiveActionGuardrail(appointmentRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(appointmentRole, this.table);

    const appointmentIntegration = new HttpLambdaIntegration(
      'AppointmentIntegration',
      appointmentFunction,
    );
    httpApi.addRoutes({
      path: '/patients/{id}/appointments',
      methods: [HttpMethod.POST],
      integration: appointmentIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/appointments',
      methods: [HttpMethod.GET],
      integration: appointmentIntegration,
    });
    httpApi.addRoutes({
      path: '/clinicians/me/calendar',
      methods: [HttpMethod.GET],
      integration: appointmentIntegration,
    });
    // TASK 3.4.2: cancel — same integration, no new route pattern beyond
    // one more path segment.
    httpApi.addRoutes({
      path: '/patients/{id}/appointments/{apptId}/cancel',
      methods: [HttpMethod.POST],
      integration: appointmentIntegration,
    });
    // 2026-09-01: "any new appointment booked by the clinician needs to be
    // approved by the principal clinician." Two more segments on the same
    // integration — the authorisation that makes them principal-only is
    // `authz-matrix.ts`'s own `Appointment approval` row, not anything at
    // this layer.
    httpApi.addRoutes({
      path: '/patients/{id}/appointments/{apptId}/approve',
      methods: [HttpMethod.POST],
      integration: appointmentIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/appointments/{apptId}/decline',
      methods: [HttpMethod.POST],
      integration: appointmentIntegration,
    });
    // 2026-09-01: marking attendance. TASK 3.4.2 named these two
    // transitions as the reason `appointment_status` has four states and
    // built no route for either; the calendar section's "sessions so far"
    // and the visitor's "number of appointments happened" both count
    // `'completed'`, so without these they would read zero forever.
    httpApi.addRoutes({
      path: '/patients/{id}/appointments/{apptId}/complete',
      methods: [HttpMethod.POST],
      integration: appointmentIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/appointments/{apptId}/no-show',
      methods: [HttpMethod.POST],
      integration: appointmentIntegration,
    });

    // 2026-09-01: the patient's in-app dashboard feed — "When a
    // clinician/principal clinician edits a calender for a given patient it
    // will appear as a notification on patients logged in dashboard."
    //
    // Its own function and role, and the only one in this stack with **no**
    // `AUDIT#*` write statement: the repository behind it takes no
    // `AuditWriter` at all, because every event that produces a notice is
    // already audited by the repository that performed it. A role granted
    // audit writes it never uses would be a standing capability with no
    // caller, which is exactly what these per-function roles exist to avoid.
    const patientNotificationRole = new Role(this, 'PatientNotificationFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const patientNotificationFunction = new NodejsFunction(this, 'PatientNotificationFunction', {
      entry: `${moduleDir}../../services/api/src/patient-notification-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: patientNotificationRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(
        this,
        'PatientNotificationFunctionLogGroup',
        props.prLabel
          ? `/ndn/${props.prLabel}/patient-notification-function`
          : '/ndn/patient-notification-function',
        patientNotificationRole,
      ),
    });
    grantFlagReads(this, patientNotificationRole);

    // `Query` (the feed) and `UpdateItem` (mark one read) on `PAT#*`. No
    // `PutItem`: this function has no route that creates a notice, and the
    // matrix grants `create` on this row to nobody — the two agree, and the
    // IAM is what makes the second one true even if the first were edited.
    patientNotificationRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAndMarkReadPatientNotifications',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    attachDestructiveActionGuardrail(patientNotificationRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(patientNotificationRole, this.table);

    const patientNotificationIntegration = new HttpLambdaIntegration(
      'PatientNotificationIntegration',
      patientNotificationFunction,
    );
    httpApi.addRoutes({
      path: '/patients/me/notifications',
      methods: [HttpMethod.GET],
      integration: patientNotificationIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/me/notifications/{notificationId}/read',
      methods: [HttpMethod.POST],
      integration: patientNotificationIntegration,
    });

    // TASK 3.4.3 built the 1-hour reminder sweep here — its own Lambda,
    // role, and `rate(15 minutes)` EventBridge rule, reaching a real SMS
    // provider send and a real SES send. D-32 (2026-08-30) deletes all of
    // it: a clinician now reminds a patient over WhatsApp, by hand — see
    // docs/runbooks/appointment-reminders.md.

    // TASK 3.5.1: content assignment — a clinician linking existing,
    // published content to a patient, and the patient's own hydrated
    // read of the list. `PAT#<id>` / `CONTENT#<id>`, no GSI of its own
    // (`04-data-model-rbac.md`'s own minimal key shape for this entity).
    const contentAssignmentRole = new Role(this, 'ContentAssignmentFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const contentAssignmentFunction = new NodejsFunction(this, 'ContentAssignmentFunction', {
      entry: `${moduleDir}../../services/api/src/content-assignment-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: contentAssignmentRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(
        this,
        'ContentAssignmentFunctionLogGroup',
        contentAssignmentLogGroupName,
        contentAssignmentRole,
      ),
    });
    grantFlagReads(this, contentAssignmentRole);

    // `GetItem` (the patient lookup), `PutItem` (a new `CONTENT#<id>`
    // assignment row), and `Query` (`listForPatient`'s own main-table
    // `begins_with` read) — all on `PAT#*` alone, the same
    // partition-key-only granularity `appointmentRole`'s own
    // `ReadWriteAndQueryPatientAppointments` statement already uses.
    contentAssignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWriteAndQueryPatientContentAssignments',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // A separate statement, `CONTENT#*` alone, `GetItem` only — the
    // publish-check `ContentAssignmentRepository.assign` performs before
    // writing, and the title/excerpt hydration `listForPatient` performs
    // on read (`content-assignment-repository.ts`). Never `Query`/`Scan`:
    // both call sites already hold the exact `contentId` they need.
    contentAssignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadContentForAssignment',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONTENT#*'] } },
      }),
    );
    // A separate statement, on `AUDIT#*` alone — every assignment
    // `ContentAssignmentRepository.assign` writes reaches the same
    // `DynamoAuditLog` every other writer in this stack uses.
    contentAssignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] },
        },
      }),
    );
    attachDestructiveActionGuardrail(contentAssignmentRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(contentAssignmentRole, this.table);

    const contentAssignmentIntegration = new HttpLambdaIntegration(
      'ContentAssignmentIntegration',
      contentAssignmentFunction,
    );
    httpApi.addRoutes({
      path: '/patients/{id}/content',
      methods: [HttpMethod.POST],
      integration: contentAssignmentIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/content',
      methods: [HttpMethod.GET],
      integration: contentAssignmentIntegration,
    });

    // TASK 3.6.1: patient<->clinician messaging, and the matrix
    // correction that makes it genuinely bidirectional — see message.ts's
    // own header for the doc-first correction and the real finding
    // against this task's own prose (the principal's cell was never
    // touched by the correction and stays read-only).
    //
    // D-32 (2026-08-30): the "new message" notice's own grants
    // (`AdminGetUser` to resolve an email, `ses:SendEmail` to notify) are
    // deleted along with the notice itself — this role now touches only
    // DynamoDB.
    const messageRole = new Role(this, 'MessageFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const messageFunction = new NodejsFunction(this, 'MessageFunction', {
      entry: `${moduleDir}../../services/api/src/message-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: messageRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'MessageFunctionLogGroup', messageLogGroupName, messageRole),
    });
    grantFlagReads(this, messageRole);

    // `GetItem` (the patient lookup), `PutItem` (a new `MSG#<ts>#<id>`
    // row), and `Query` (`listForThread`'s own main-table `begins_with`
    // read) — all on `PAT#*` alone. Deliberately no `UpdateItem`: a
    // message is never edited, so this role has no action that could.
    messageRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadWriteAndQueryPatientMessages',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    messageRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] },
        },
      }),
    );
    attachDestructiveActionGuardrail(messageRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(messageRole, this.table);

    const messageIntegration = new HttpLambdaIntegration('MessageIntegration', messageFunction);
    httpApi.addRoutes({
      path: '/patients/{id}/messages',
      methods: [HttpMethod.POST],
      integration: messageIntegration,
    });
    httpApi.addRoutes({
      path: '/patients/{id}/messages',
      methods: [HttpMethod.GET],
      integration: messageIntegration,
    });

    // TASK 1.5.1 step 3's presigned-upload endpoint (POST
    // /workshops/media-upload-url) lives in web-stack.ts instead, right
    // next to MediaBucket — it needs `s3:PutObject` against that bucket and
    // nothing from this table, and defining it here would need
    // web-stack.ts's bucket passed in as a cross-stack prop. That
    // reference, combined with the guardrail's bucket-policy half naming
    // this stack's role back in web-stack.ts's own template, produces a
    // real circular CloudFormation dependency (WebStack -> DataStack ->
    // WebStack) — confirmed by attempting exactly that shape here first.
    // Co-locating the function with the bucket avoids the cycle entirely.

    // TASK 4.1.1: the WebSocket signalling channel — ADR-0007's "API
    // Gateway WebSocket + DynamoDB connection table," first exercised
    // here. A second, separate API Gateway resource from `httpApi` above:
    // a WebSocket API is its own resource type (`AWS::ApiGatewayV2::Api`
    // with `ProtocolType: WEBSOCKET`), not a route on an HTTP API.
    //
    // Four functions, not the two the task's own text names — see
    // config.ts's `UNMONITORED_LOG_GROUP_NAMES` comment for why
    // `WsAuthorizerFunction` and `WsDefaultFunction` both exist.
    const wsAuthorizerRole = new Role(this, 'WsAuthorizerFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const wsAuthorizerFunction = new NodejsFunction(this, 'WsAuthorizerFunction', {
      entry: `${moduleDir}../../services/api/src/ws-authorizer-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Same reasoning AuthorizerFunction's own timeout comment states: a
      // cold invocation may fetch a pool's JWKS over HTTPS first.
      timeout: Duration.seconds(10),
      role: wsAuthorizerRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        PATIENT_USER_POOL_ID,
        PATIENT_USER_POOL_CLIENT_ID,
        CLINICIAN_USER_POOL_ID,
        CLINICIAN_USER_POOL_CLIENT_ID,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'WsAuthorizerFunctionLogGroup', wsAuthorizerLogGroupName, wsAuthorizerRole),
    });
    grantFlagReads(this, wsAuthorizerRole);

    // The identical `PAT#*`/`CLI#*` GetItem-only grant AuthorizerFunction's
    // own `ReadPrincipalProfiles` statement carries, for the identical
    // reason — one keyed read of one profile row, nothing broader.
    wsAuthorizerRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadPrincipalProfiles',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*', 'CLI#*'] },
        },
      }),
    );
    attachDestructiveActionGuardrail(wsAuthorizerRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(wsAuthorizerRole, this.table);

    const wsConnectRole = new Role(this, 'WsConnectFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const wsConnectFunction = new NodejsFunction(this, 'WsConnectFunction', {
      entry: `${moduleDir}../../services/api/src/ws-connect-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      role: wsConnectRole,
      environment: { CONNECTION_TABLE_NAME: this.table.tableName },
      logGroup: createLogGroup(this, 'WsConnectFunctionLogGroup', wsConnectLogGroupName, wsConnectRole),
    });
    // `PutItem` only, and only on `CONN#*` — this function never reads or
    // updates anything, including its own row.
    wsConnectRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteConnectionRow',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONN#*'] } },
      }),
    );
    attachDestructiveActionGuardrail(wsConnectRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(wsConnectRole, this.table);

    const wsDisconnectRole = new Role(this, 'WsDisconnectFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const wsDisconnectFunction = new NodejsFunction(this, 'WsDisconnectFunction', {
      entry: `${moduleDir}../../services/api/src/ws-disconnect-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      role: wsDisconnectRole,
      environment: { CONNECTION_TABLE_NAME: this.table.tableName },
      logGroup: createLogGroup(this, 'WsDisconnectFunctionLogGroup', wsDisconnectLogGroupName, wsDisconnectRole),
    });
    // `UpdateItem` only, and only on `CONN#*` — never `PutItem` (this
    // function creates nothing) and never `DeleteItem` (00-conventions.md's
    // prohibition; TTL is the only cleanup mechanism, connection-repository.ts's
    // own header states this explicitly).
    wsDisconnectRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'UpdateConnectionRow',
        effect: Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONN#*'] } },
      }),
    );
    attachDestructiveActionGuardrail(wsDisconnectRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(wsDisconnectRole, this.table);

    const wsDefaultRole = new Role(this, 'WsDefaultFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const wsDefaultFunction = new NodejsFunction(this, 'WsDefaultFunction', {
      entry: `${moduleDir}../../services/api/src/ws-default-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Longer than the other WS functions' 5 seconds: TASK 4.2.1's join
      // handling does a directory lookup, an appointment read and a
      // PostToConnection round trip in the same invocation (TASK 4.2.2's
      // relay handling is a shorter chain — one Query, one PostToConnection
      // — but shares this function and its timeout), the same "cold-start
      // JWKS fetch" reasoning the authorizer's own 10-second timeout
      // states, applied here to a different chain of I/O.
      timeout: Duration.seconds(10),
      role: wsDefaultRole,
      environment: {
        // TASK 4.2.1: no separate env var for the connection table — it's
        // the same table under every name every other function already
        // uses for it (PRINCIPAL_TABLE_NAME here, matching appointment-
        // handler.ts's own convention; ws-connect-handler.ts/ws-disconnect-
        // handler.ts call the identical value CONNECTION_TABLE_NAME, so
        // both are set to keep every wired repository reading the name
        // its own file already expects).
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        CONNECTION_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'WsDefaultFunctionLogGroup', wsDefaultLogGroupName, wsDefaultRole),
    });
    grantFlagReads(this, wsDefaultRole);
    // One `GetItem` statement, three leading-key prefixes: `CONN#*`
    // (ws-join-handler.ts's own connection lookup), `PAT#*`/`CLI#*` (the
    // principal-directory lookup, and — the same prefix, no second grant
    // needed — an appointment row, which lives at `PAT#<patientId>`
    // regardless of who is asking). The identical multi-prefix-in-one-
    // statement shape `messageRole`'s own `WriteAuditAndDeliveryRows`
    // statement already uses above.
    wsDefaultRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadConnectionPrincipalAndAppointmentRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONN#*', 'PAT#*', 'CLI#*'] },
        },
      }),
    );
    // `PutItem` only, on `CALL#*` (the call-participant row, TASK 4.2.1
    // step 3) and `AUDIT#*` (the join/join-denied audit event) — never
    // `UpdateItem`, since this function never modifies a row it did not
    // just create.
    wsDefaultRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteCallParticipantAndAuditRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['CALL#*', `${AUDIT_PARTITION_KEY_PREFIX}*`],
          },
        },
      }),
    );
    // TASK 4.2.2: `Query` (never `GetItem`) on `CALL#*` — `ws-relay.ts`'s
    // own lookup reads the whole partition (at most two items) to decide
    // who the sender is and who the other party is, the same
    // `findCallParticipants` shape `connection-repository.ts` exposes.
    wsDefaultRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'QueryCallParticipants',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CALL#*'] } },
      }),
    );
    // TASK 4.2.2: `UpdateItem` on `CONN#*` — the identical soft-mark
    // `WsDisconnectFunction`'s own `UpdateConnectionRow` statement grants,
    // needed here for the one case this function can discover a stale
    // connection itself: `PostToConnection` returning `GoneException`
    // mid-relay. Never `DeleteItem`, never `PutItem` — this function
    // creates no connection row, only ever marks one already written by
    // `WsConnectFunction`.
    wsDefaultRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'MarkStaleConnectionRow',
        effect: Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONN#*'] } },
      }),
    );
    // TASK 4.4.2 (R-03): `cloudwatch:PutMetricData`, for the
    // `EstimatedTurnRelayGB` custom metric `infra/src/budget-stack.ts`'s
    // own alarm watches — the first metric-publishing grant in this
    // stack. The action supports no resource-level scoping (AWS's own
    // constraint, not a shortcut taken here).
    wsDefaultRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'PutTurnRelayMetric',
        effect: Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      }),
    );
    attachDestructiveActionGuardrail(wsDefaultRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(wsDefaultRole, this.table);

    const webSocketAuthorizer = createWebSocketConnectAuthorizer(wsAuthorizerFunction);

    const signallingWebSocketApi = new WebSocketApi(this, 'SignallingWebSocketApi', {
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('WsConnectIntegration', wsConnectFunction),
        authorizer: webSocketAuthorizer,
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration(
          'WsDisconnectIntegration',
          wsDisconnectFunction,
        ),
      },
      // TASK 4.1.1 stubbed this only enough to deploy cleanly; TASK 4.2.1
      // makes it real (the join message dispatcher) — message relay is
      // still TASK 4.2.2's own job, not this one (ws-default-handler.ts's
      // own header).
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('WsDefaultIntegration', wsDefaultFunction),
      },
    });

    const signallingWebSocketStage = new WebSocketStage(this, 'SignallingWebSocketStage', {
      webSocketApi: signallingWebSocketApi,
      stageName: '$default',
      autoDeploy: true,
      // Deliberately no `accessLogSettings` — the Cognito ID token rides
      // in the connect URL's own querystring (this task's own header), and
      // the "never log PII" discipline 00-conventions.md states generally
      // extends to not letting API Gateway's own access log capture a
      // connect URL that carries one. data-stack.test.ts asserts this
      // stage's synthesized template carries no `AccessLogSettings`, so
      // the omission is enforced rather than merely intended.
    });

    // TASK 4.2.1: `WsDefaultFunction` is the only function in this stack
    // that ever answers a caller back over their own already-open
    // socket (`ws-join-handler.ts`'s `PostToConnectionCommand`) — the
    // one IAM action no other role here has ever needed.
    // `grantManagementApiAccess` is `WebSocketStage`'s own helper for
    // exactly this grant, scoped to this one stage's connections.
    signallingWebSocketStage.grantManagementApiAccess(wsDefaultRole);

    // TASK 4.4.1: TURN credential issuance, wired into TASK 4.3.3's
    // fallback as a second retry tier — the second half of D-12's own
    // "P2P first, Cloudflare TURN fallback" order. A real HTTP route
    // (`ContentHttpApi`, not the WebSocket API — a caller already knows
    // its own `appointmentId` at this point and gains nothing from
    // travelling over the signalling socket for one request/response).
    const turnCredentialsRole = new Role(this, 'TurnCredentialsFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const turnCredentialsFunction = new NodejsFunction(this, 'TurnCredentialsFunction', {
      entry: `${moduleDir}../../services/api/src/turn-credentials-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: turnCredentialsRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        CLOUDFLARE_TURN_KEY_ID,
        CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'TurnCredentialsFunctionLogGroup', turnCredentialsLogGroupName, turnCredentialsRole),
    });
    grantFlagReads(this, turnCredentialsRole);

    // `GetItem` on `PAT#*` — the appointment lookup `can()`'s own
    // `'join-call'` decision needs, the identical prefix `appointmentRole`'s
    // own read statement already uses for the same record.
    turnCredentialsRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadPatientAppointmentRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
      }),
    );
    // `Query` (never `GetItem`) on `CALL#*` — the identical
    // `findCallParticipants` shape `wsDefaultRole`'s own
    // `QueryCallParticipants` statement already grants, needed here to
    // confirm the caller's own row is still live before minting a
    // credential against it. A distinct sid (`data-stack.test.ts`'s own
    // TASK 4.2.2 test finds `wsDefaultRole`'s statement by this exact
    // name, and a second role reusing it would break that lookup).
    // TASK 4.4.2 adds `UpdateItem` on the same partition — `markTurnActive`,
    // the concurrent-relay cap's own write, conditioned in
    // `connection-repository.ts` on the row already existing, so this
    // grant can never create one.
    turnCredentialsRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'QueryCallParticipantsForTurnCredentials',
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CALL#*'] } },
      }),
    );
    // The matching Cloudflare TURN API token — same `ssm:GetParameter`,
    // single-parameter-ARN shape `contactFormRole`'s own
    // `ReadTurnstileSecret` statement (web-stack.ts) already uses for a
    // different Cloudflare secret.
    turnCredentialsRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadCloudflareTurnApiToken',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );
    attachDestructiveActionGuardrail(turnCredentialsRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(turnCredentialsRole, this.table);

    httpApi.addRoutes({
      path: '/calls/{appointmentId}/turn-credentials',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('TurnCredentialsIntegration', turnCredentialsFunction),
    });

    // D-22: a load-test/ephemeral copy is destroyed within the hour it's
    // created (props.ephemeral's own removalPolicy above) — nothing about
    // it is worth a year-long, object-locked backup, the identical
    // reasoning web-stack.ts's own `if (!props.ephemeral)` gate already
    // applies to the email-events pipeline.
    if (!props.ephemeral) {
      createBackupExportPipeline(this, this.table);
    }

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'ContentHttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'SignallingWebSocketUrl', { value: signallingWebSocketStage.url });
  }
}
