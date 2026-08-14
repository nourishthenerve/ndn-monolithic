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
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';

import { ADMIN_API_TOKEN_PARAMETER_NAME } from './config.js';
import { attachDestructiveActionGuardrail } from './guardrails.js';
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
      },
      logGroup: createLogGroup(this, 'ContentReadFunctionLogGroup', logGroupName),
    });

    // TASK 1.3.1 step 5: "minimal read API only" — no PutItem/DeleteItem
    // grant here. Authoring (1.3.2) gets its own function and its own grant
    // when it exists.
    this.table.grantReadData(contentReadRole);

    // TASK 0.3.2's guardrail, first real exercise against a deployed table
    // and a deployed runtime role.
    attachDestructiveActionGuardrail(contentReadRole, { buckets: [], tables: [this.table] });

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
        ADMIN_TOKEN_PARAMETER_NAME: ADMIN_API_TOKEN_PARAMETER_NAME,
      },
      logGroup: createLogGroup(this, 'ContentAuthoringFunctionLogGroup', authoringLogGroupName),
    });

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

    // TASK 0.3.2's guardrail against this role too — defence in depth even
    // though the identity policy above never grants DeleteItem in the
    // first place (see the comment on the write grant just above).
    attachDestructiveActionGuardrail(contentAuthoringRole, { buckets: [], tables: [this.table] });

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

    const httpApi = new HttpApi(this, 'ContentHttpApi');
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

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'ContentHttpApiUrl', { value: httpApi.apiEndpoint });
  }
}
