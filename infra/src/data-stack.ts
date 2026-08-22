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
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

import {
  ADMIN_API_TOKEN_PARAMETER_NAME,
  DOMAIN_NAME,
  SITE_ORIGIN,
  STRIPE_SECRET_KEY_PARAMETER_NAME,
  TURNSTILE_SECRET_PARAMETER_NAME,
} from './config.js';
import { FLAG_ENVIRONMENT, grantFlagReads } from './flag-parameters.js';
import {
  attachAuditPartitionReadGuardrail,
  attachDestructiveActionGuardrail,
} from './guardrails.js';
import { createLogGroup } from './log-retention.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

const GSI2_INDEX_NAME = 'GSI2';

export interface DataStackProps extends StackProps {
  /** TASK 0.6.3-style label for a future ephemeral stack's log group names. Unused today — no ephemeral DataStack is deployed yet (bin/app.ts). */
  readonly prLabel?: string;
}

export class DataStack extends Stack {
  public readonly table: Table;

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

    const logGroupName = props.prLabel
      ? `/ndn/${props.prLabel}/content-read-function`
      : '/ndn/content-read-function';

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
    // write content and read the admin token.
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
        ADMIN_TOKEN_PARAMETER_NAME: ADMIN_API_TOKEN_PARAMETER_NAME,
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

    contentAuthoringRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAdminApiToken',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: ADMIN_API_TOKEN_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    const httpApi = new HttpApi(this, 'ContentHttpApi', {
      // TASK 1.4.2: testimonial submission is a live browser fetch (unlike
      // content, which apps/web only ever calls at `astro build` time —
      // see apps/web/src/blog/content-client.ts) — this API's own
      // execute-api.amazonaws.com origin differs from the site's own
      // origin, so a browser POST needs CORS. Scoped to the site's own
      // origin only; update DOMAIN_NAME here alongside TASK 1.6.1's G1
      // cutover, same convention apps/web/src/site-config.ts's siteUrl
      // documents.
      corsPreflight: {
        allowOrigins: [`https://${DOMAIN_NAME}`],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
      },
    });
    httpApi.addRoutes({
      path: '/content',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ContentReadIntegration', contentReadFunction),
    });

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
    // above; TestimonialModerationFunction is the admin-token-gated read/
    // publish/reject path, reusing the same ADMIN_API_TOKEN as content
    // authoring.
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
          ADMIN_TOKEN_PARAMETER_NAME: ADMIN_API_TOKEN_PARAMETER_NAME,
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
    testimonialModerationRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAdminApiToken',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: ADMIN_API_TOKEN_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    const testimonialModerationIntegration = new HttpLambdaIntegration(
      'TestimonialModerationIntegration',
      testimonialModerationFunction,
    );
    httpApi.addRoutes({
      path: '/testimonials',
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
        ADMIN_TOKEN_PARAMETER_NAME: ADMIN_API_TOKEN_PARAMETER_NAME,
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
    workshopAuthoringRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAdminApiToken',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: ADMIN_API_TOKEN_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

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
        ADMIN_TOKEN_PARAMETER_NAME: ADMIN_API_TOKEN_PARAMETER_NAME,
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
    auditReadRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAdminApiToken',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: ADMIN_API_TOKEN_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    httpApi.addRoutes({
      path: '/audit',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('AuditReadIntegration', auditReadFunction),
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
