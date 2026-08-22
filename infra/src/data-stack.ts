// TASK 1.3.1: first data-plane stack — one DynamoDB table
// (docs/plan/04-data-model-rbac.md's single-table design), on-demand
// billing (D-07), point-in-time recovery (D-21 — cheap even unused today,
// and turning it on later would lose the window between "table exists" and
// "PITR enabled"), RemovalPolicy.RETAIN (matches every other protected
// resource in this repo — 0.4.1's site bucket). Only GSI2 (keyword ->
// content) is created now; GSI1/3/4 land with the Phase 2/3 tasks that
// first need them (adding a GSI later is additive, not a migration).
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
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

import {
  CLINICIAN_USER_POOL_CLIENT_ID,
  CONTACT_FORM_FROM_EMAIL,
  CLINICIAN_USER_POOL_ID,
  DOMAIN_NAME,
  PATIENT_USER_POOL_CLIENT_ID,
  PATIENT_USER_POOL_ID,
  SES_CONFIGURATION_SET_NAME,
  SES_EMAIL_IDENTITY_DOMAIN,
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

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

const GSI1_INDEX_NAME = 'GSI1';
const GSI2_INDEX_NAME = 'GSI2';
const GSI3_INDEX_NAME = 'GSI3';


export interface DataStackProps extends StackProps {
  /** TASK 0.6.3-style label for a future ephemeral stack's log group names. Unused today — no ephemeral DataStack is deployed yet (bin/app.ts). */
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
  /**
   * TASK 2.2.3: attached to the patient pool's Post-Confirmation trigger
   * by `AuthStack` (bin/app.ts). The function lives here because
   * everything it writes — the patient profile, the intake row it
   * consumes, the audit row — is on this stack's table; the pool it fires
   * from lives there. One prop, one direction.
   */
  public readonly postConfirmationFunction: IFunction;

  constructor(scope: Construct, id: string, props: DataStackProps = {}) {
    super(scope, id, props);

    this.table = new Table(this, 'DataTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
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

    const logGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/content-read-function`
      : '/ndn/content-read-function';
    const authorizerLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/authorizer-function`
      : '/ndn/authorizer-function';
    const registrationLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/registration-function`
      : '/ndn/registration-function';
    const postConfirmationLogGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/post-confirmation-function`
      : '/ndn/post-confirmation-function';
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
      logGroup: createLogGroup(this, 'ContentReadFunctionLogGroup', logGroupName),
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
      logGroup: createLogGroup(this, 'ContentAuthoringFunctionLogGroup', authoringLogGroupName),
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
      logGroup: createLogGroup(this, 'AuthorizerFunctionLogGroup', authorizerLogGroupName),
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
      corsPreflight: {
        allowOrigins: [SITE_ORIGIN, `https://${WWW_DOMAIN_NAME}`, `https://${DOMAIN_NAME}`],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
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
      logGroup: createLogGroup(this, 'WorkshopReadFunctionLogGroup', workshopReadLogGroupName),
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
      logGroup: createLogGroup(this, 'AuditReadFunctionLogGroup', auditReadLogGroupName),
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

    // TASK 2.2.3: the front door. Two functions, deliberately — the plan
    // named one log group and this needs two, for a reason worth stating.
    //
    // `RegistrationFunction` is an ordinary HTTP endpoint because step 7
    // asks for a rate limit **per source IP**, and a Cognito Lambda
    // trigger cannot see one: Pre-SignUp events carry no client address,
    // and the address is only available on the paid threat-protection tier
    // TASK 2.2.1 declined. Behind API Gateway it is free.
    //
    // `PostConfirmationFunction` is the Cognito trigger that writes the
    // `PAT#` record, and it can only be a trigger — nothing else knows
    // when a patient has proved they can read the mailbox.
    const registrationRole = new Role(this, 'RegistrationFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const registrationFunction = new NodejsFunction(this, 'RegistrationFunction', {
      entry: `${moduleDir}../../services/api/src/registration-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Turnstile's siteverify round trip plus Cognito's SignUp, both
      // outbound HTTPS.
      timeout: Duration.seconds(10),
      role: registrationRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        PATIENT_USER_POOL_CLIENT_ID,
        TURNSTILE_SECRET_PARAMETER_NAME,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'RegistrationFunctionLogGroup', registrationLogGroupName),
    });
    grantFlagReads(this, registrationRole);

    // **No `cognito-idp` grant anywhere.** `SignUp` is an unauthenticated
    // Cognito operation — AWS's own API reference says it "doesn't evaluate
    // IAM policies" — so this function calls it with no credentials at
    // all. A grant here would be permission that does nothing, which is
    // worse than none: it reads as if the function had admin reach into
    // the directory.
    registrationRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteRegistrationIntake',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['REG#*'] } },
      }),
    );
    registrationRole.addToPrincipalPolicy(
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
    attachDestructiveActionGuardrail(registrationRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(registrationRole, this.table);

    const postConfirmationRole = new Role(this, 'PostConfirmationFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    this.postConfirmationFunction = new NodejsFunction(this, 'PostConfirmationFunction', {
      entry: `${moduleDir}../../services/api/src/post-confirmation-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: postConfirmationRole,
      environment: {
        PRINCIPAL_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        REGISTRATION_FROM_EMAIL: CONTACT_FORM_FROM_EMAIL,
        SES_CONFIGURATION_SET_NAME,
      },
      logGroup: createLogGroup(
        this,
        'PostConfirmationFunctionLogGroup',
        postConfirmationLogGroupName,
      ),
    });

    // Reads the intake row and the patient profile (to be idempotent),
    // writes the profile, the consumed marker and one audit row. Scoped to
    // the three partitions it touches — a table-wide grant would let the
    // one function Cognito can invoke reach every record in the estate.
    postConfirmationRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WritePatientProfile',
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['PAT#*', 'REG#*', `${AUDIT_PARTITION_KEY_PREFIX}*`],
          },
        },
      }),
    );
    postConfirmationRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'SendRegistrationEmail',
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: SES_EMAIL_IDENTITY_DOMAIN,
          }),
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: SES_CONFIGURATION_SET_NAME,
          }),
        ],
      }),
    );
    attachDestructiveActionGuardrail(postConfirmationRole, { buckets: [], tables: [this.table] });
    // Writes audit rows, so it must not be able to read them — the same
    // separation TASK 2.1.3 applies to every other writer. The `PutItem`
    // above is what lets it append; there is no matching read.
    attachAuditPartitionReadGuardrail(postConfirmationRole, this.table);

    httpApi.addRoutes({
      path: '/registrations',
      methods: [HttpMethod.POST],
      // Public by necessity: the caller has no account yet — that is what
      // they are asking for. Turnstile and the per-IP rate limit are the
      // gate, and the flag is default-off until TASK 2.5.1 can approve
      // anyone.
      authorizer: PUBLIC_ROUTE,
      integration: new HttpLambdaIntegration('RegistrationIntegration', registrationFunction),
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
      // Up to four sequential Cognito Admin* calls on the deactivate path
      // (disable, global sign-out, get-user, then the SES send), each its
      // own HTTPS round trip.
      timeout: Duration.seconds(15),
      role: clinicianAdminRole,
      environment: {
        CLINICIAN_TABLE_NAME: this.table.tableName,
        AUDIT_TABLE_NAME: this.table.tableName,
        NOTIFICATION_TABLE_NAME: this.table.tableName,
        CLINICIAN_USER_POOL_ID,
        CLINICIAN_ADMIN_FROM_EMAIL: CONTACT_FORM_FROM_EMAIL,
        SES_CONFIGURATION_SET_NAME,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'ClinicianAdminFunctionLogGroup', clinicianAdminLogGroupName),
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
    // The audit and delivery-log rows this function writes — `PutItem`
    // only, on both prefixes: it writes audit rows and delivery records,
    // never queries either back (attachAuditPartitionReadGuardrail below
    // closes the audit half of that; the delivery log has no reader at
    // all yet — dynamo-notification-log.ts's own header).
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'WriteAuditAndDeliveryRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`, 'NOTIFICATION#*'],
          },
        },
      }),
    );
    attachDestructiveActionGuardrail(clinicianAdminRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(clinicianAdminRole, this.table);

    // The four Admin* calls clinician-admin-handler.ts's ports use —
    // create, disable, enable, global-sign-out, get-user — and nothing
    // wider. No `AdminDeleteUser` here or anywhere: `AdminDeleteUserCommand`
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
          'cognito-idp:AdminGetUser',
        ],
        resources: [clinicianUserPoolArn],
      }),
    );
    // The deactivation notice, sent through 2.3.1's Notifier — same
    // verified identity every other SES sender in this stack uses.
    clinicianAdminRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'SendClinicianDeactivationEmail',
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: SES_EMAIL_IDENTITY_DOMAIN,
          }),
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: SES_CONFIGURATION_SET_NAME,
          }),
        ],
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

    // TASK 2.5.1: approval and first assignment. No `authorizer:`
    // override, same reasoning as ClinicianAdminFunction's own routes —
    // only the principal ever passes `can()` on this row
    // (authz-matrix.ts's 'Patient assignment'), so the real authorizer is
    // exactly the gate this needs.
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
        NOTIFICATION_TABLE_NAME: this.table.tableName,
        ASSIGNMENT_FROM_EMAIL: CONTACT_FORM_FROM_EMAIL,
        SES_CONFIGURATION_SET_NAME,
        // TASK 2.5.2: resolves a clinician's email for the reassignment
        // notice (AdminGetUser) — see this file's own comment on the
        // AssignmentFunctionRole IAM grant below.
        CLINICIAN_USER_POOL_ID,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(this, 'AssignmentFunctionLogGroup', assignmentLogGroupName),
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
        sid: 'WriteAuditAndDeliveryRows',
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [this.table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`, 'NOTIFICATION#*'],
          },
        },
      }),
    );
    attachDestructiveActionGuardrail(assignmentRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(assignmentRole, this.table);
    // TASK 2.5.2: `AdminGetUser` only, on the same clinician pool ARN
    // ClinicianAdminFunction's own grant uses — resolving an email to
    // notify, never a create/disable/enable action.
    assignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadClinicianEmailForReassignmentNotice',
        effect: Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [clinicianUserPoolArn],
      }),
    );
    assignmentRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'SendAssignmentDecisionEmail',
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: SES_EMAIL_IDENTITY_DOMAIN,
          }),
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: SES_CONFIGURATION_SET_NAME,
          }),
        ],
      }),
    );

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
      logGroup: createLogGroup(this, 'CaseloadFunctionLogGroup', caseloadLogGroupName),
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
      logGroup: createLogGroup(this, 'PatientFunctionLogGroup', patientLogGroupName),
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
    attachDestructiveActionGuardrail(patientRole, { buckets: [], tables: [this.table] });
    attachAuditPartitionReadGuardrail(patientRole, this.table);

    const patientIntegration = new HttpLambdaIntegration('PatientIntegration', patientFunction);
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

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'ContentHttpApiUrl', { value: httpApi.apiEndpoint });
  }
}
