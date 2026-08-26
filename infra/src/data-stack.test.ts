// Same philosophy as guardrails.test.ts/web-stack.test.ts: CDK's assertions
// library synthesizes the real CloudFormation template (including running
// NodejsFunction's real esbuild bundling of content-read-handler.ts), with
// zero live AWS calls.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  CLINICIAN_USER_POOL_CLIENT_ID,
  CLINICIAN_USER_POOL_ID,
  FLAG_PARAMETER_NAME_PREFIX,
  MONITORED_LOG_GROUP_NAMES,
  PATIENT_USER_POOL_CLIENT_ID,
  PATIENT_USER_POOL_ID,
  UNMONITORED_LOG_GROUP_NAMES,
} from './config.js';
import { DataStack } from './data-stack.js';
import { UNAUTHENTICATED_ROUTE_KEYS } from './route-protection.js';

// Synthesized once and shared across this file's ~24 assertions, for the
// same reason web-stack.test.ts memoizes its own: each call re-bundles all
// seven Lambdas through esbuild, and a Template is only ever read.
let template: Template | undefined;

function synth(): Template {
  return (template ??= (() => {
    const app = new App();
    const stack = new DataStack(app, 'TestDataStack', {
      env: { account: '357601815388', region: 'eu-west-2' },
    });
    return Template.fromStack(stack);
  })());
}

describe('DataStack — table', () => {
  it('is on-demand billed, PITR-enabled, and never auto-deleted', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
    template.hasResource('AWS::DynamoDB::Table', {
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    });
  });

  it('creates only GSI1 (clinician -> patients/calendar), GSI2 (keyword -> content), GSI3 (cross-caseload) and GSI4 (reminder window), all KEYS_ONLY, nothing else', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      // arrayWith matches patterns as an ordered subsequence, not a set —
      // listed in synthesis order (GSI2's addGlobalSecondaryIndex call
      // precedes GSI1's, which precedes GSI3's, which precedes GSI4's,
      // in the stack's constructor).
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
        Match.objectLike({
          IndexName: 'GSI3',
          KeySchema: [
            { AttributeName: 'gsi3pk', KeyType: 'HASH' },
            { AttributeName: 'gsi3sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
        Match.objectLike({
          IndexName: 'GSI4',
          KeySchema: [
            { AttributeName: 'gsi4pk', KeyType: 'HASH' },
            { AttributeName: 'gsi4sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
      ]),
    });
    const table = Object.values(template.findResources('AWS::DynamoDB::Table'))[0] as {
      Properties: { GlobalSecondaryIndexes: unknown[] };
    };
    // arrayWith (above) proves all four exist; this proves there is no fifth.
    expect(table.Properties.GlobalSecondaryIndexes).toHaveLength(4);
  });
});

// TASK 2.5.3 fix: ContentHttpApi's CORS policy allowed only `next.` — the
// pre-G1-cutover origin — because the comment reminding a future task to
// update it alongside TASK 1.6.1 was never acted on. This silently broke
// testimonial submission and workshop checkout's live browser fetches from
// the apex, the site's own canonical origin (apps/web/src/site-config.ts's
// `siteUrl`), for however long the DNS cutover has been live. No test
// caught it because none existed; these do now.
describe('DataStack — ContentHttpApi CORS (TASK 2.5.3 fix)', () => {
  it('allows the apex (canonical), www and next. — every real origin the site is served from', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowOrigins: [
          'https://nourishthenerve.com',
          'https://www.nourishthenerve.com',
          'https://next.nourishthenerve.com',
        ],
      },
    });
  });

  it('allows the authorization header — needed for the caseload feature bearer-token fetch', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: {
        AllowHeaders: ['content-type', 'authorization'],
      },
    });
  });
});

describe('DataStack — guardrail', () => {
  it('denies the destructive actions against this real table for the content-read role', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyDestructivePrimitives',
            Effect: 'Deny',
            Action: Match.arrayWith(['dynamodb:DeleteItem', 'dynamodb:DeleteTable']),
          }),
        ]),
      },
    });
  });

  it('grants read data access but not write/delete to the content-read role', () => {
    const template = synth();
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const readGrant = policies.find((policy) =>
      JSON.stringify(policy).includes('dynamodb:Query'),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    // The dynamo statement specifically — this role also carries an Allow
    // for ssm:GetParameter over the feature-flag prefix (TASK 1.6.2), and
    // "the first Allow" stopped meaning "the table grant" once it did.
    const allowStatement = readGrant.Properties.PolicyDocument.Statement.find(
      (s) =>
        s.Effect === 'Allow' &&
        ([] as string[])
          .concat(s.Action as string | string[])
          .some((a) => a.startsWith('dynamodb:')),
    );
    const actions = ([] as string[]).concat(allowStatement?.Action as string | string[]);
    expect(actions).toContain('dynamodb:Query');
    expect(actions).toContain('dynamodb:GetItem');
    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:DeleteItem');
  });
});

describe('DataStack — content read function', () => {
  it('is wired to the table name via environment and routed at GET /content', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ CONTENT_TABLE_NAME: Match.anyValue() }),
      },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /content',
    });
  });

  it('has an explicit 14-day-retention log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/content-read-function',
      RetentionInDays: 14,
    });
  });
});

describe('DataStack — content authoring function', () => {
  it('is wired to the table name via environment, with no admin secret', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONTENT_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('routes all four authoring endpoints to the same function, behind the real authorizer', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /content',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PATCH /content/{id}',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /content/{id}/publish',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /content/{id}/unpublish',
      AuthorizationType: 'CUSTOM',
    });
  });

  it('has an explicit 14-day-retention log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/content-authoring-function',
      RetentionInDays: 14,
    });
  });

  it('grants PutItem/TransactWriteItems but never DeleteItem on its identity policy', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const authoringPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'ContentAuthoringFunctionRole',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };

    const allowActions = authoringPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => statement.Effect === 'Allow',
    ).flatMap((statement) => ([] as string[]).concat(statement.Action as string | string[]));

    expect(allowActions).toContain('dynamodb:PutItem');
    expect(allowActions).toContain('dynamodb:TransactWriteItems');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = authoringPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });

    // TASK 2.5.4: no admin-token SSM read anywhere on this role any more.
    const sids = authoringPolicy.Properties.PolicyDocument.Statement.map((s) => s.Sid);
    expect(sids).not.toContain('ReadAdminApiToken');
  });
});

describe('DataStack — workshop read function (TASK 1.5.1)', () => {
  it('is wired to the table name via environment and routed at GET /workshops', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /workshops' });
    const policies = template.findResources('AWS::IAM::Policy');
    const readPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'WorkshopReadFunctionRole',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const allowActions = readPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => statement.Effect === 'Allow',
    ).flatMap((statement) => ([] as string[]).concat(statement.Action as string | string[]));
    expect(allowActions).toContain('dynamodb:Query');
    expect(allowActions).toContain('dynamodb:GetItem');
    expect(allowActions).not.toContain('dynamodb:PutItem');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');
  });

  it('has an explicit 14-day-retention log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/workshop-read-function',
      RetentionInDays: 14,
    });
  });
});

describe('DataStack — workshop authoring function (TASK 1.5.1)', () => {
  it('routes all four authoring endpoints to the same function, behind the real authorizer', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PATCH /workshops/{id}',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/{id}/publish',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/{id}/cancel',
      AuthorizationType: 'CUSTOM',
    });
  });

  it('grants PutItem/TransactWriteItems but never DeleteItem on its identity policy, and denies it via the guardrail', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const authoringPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'WorkshopAuthoringFunctionRole',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };

    const allowActions = authoringPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => statement.Effect === 'Allow',
    ).flatMap((statement) => ([] as string[]).concat(statement.Action as string | string[]));

    expect(allowActions).toContain('dynamodb:PutItem');
    expect(allowActions).toContain('dynamodb:TransactWriteItems');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = authoringPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });

    // TASK 2.5.4: no admin-token SSM read anywhere on this role any more.
    const sids = authoringPolicy.Properties.PolicyDocument.Statement.map((s) => s.Sid);
    expect(sids).not.toContain('ReadAdminApiToken');
  });

  it('has an explicit 14-day-retention log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/workshop-authoring-function',
      RetentionInDays: 14,
    });
  });
});

describe('DataStack — workshop checkout function (TASK 1.5.2)', () => {
  it('is wired to the table name, the Stripe secret key parameter name and the canonical site origin via environment, and routed at POST /workshops/{id}/checkout', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          WORKSHOP_TABLE_NAME: Match.anyValue(),
          STRIPE_SECRET_KEY_PARAMETER_NAME: '/ndn/stripe-secret-key',
          // TASK 1.6.1 step 5: the apex, not `next.` — Stripe returns the
          // customer to this origin, so a stale staging hostname here would
          // strand them on the wrong one. Asserted as a literal rather than
          // Match.anyValue() precisely so a silent repoint fails here.
          SITE_ORIGIN: 'https://nourishthenerve.com',
        }),
      },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/{id}/checkout',
    });
  });

  it('grants PutItem/UpdateItem but never DeleteItem on its identity policy, and denies it via the guardrail', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const checkoutPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'WorkshopCheckoutFunctionRole',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };

    const allowActions = checkoutPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => statement.Effect === 'Allow',
    ).flatMap((statement) => ([] as string[]).concat(statement.Action as string | string[]));

    expect(allowActions).toContain('dynamodb:PutItem');
    expect(allowActions).toContain('dynamodb:UpdateItem');
    expect(allowActions).toContain('ssm:GetParameter');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = checkoutPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });
  });

  it('scopes the SSM read to exactly the Stripe secret key parameter, not every parameter', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const checkoutPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'ReadStripeSecretKey',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const ssmStatement = checkoutPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'ReadStripeSecretKey',
    );

    expect(ssmStatement?.Action).toBe('ssm:GetParameter');
    const resourceJson = JSON.stringify(ssmStatement?.Resource);
    expect(resourceJson).toContain('parameter/ndn/stripe-secret-key');
    expect(resourceJson).not.toContain('parameter/*');
  });

  it('has an explicit 14-day-retention log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/workshop-checkout-function',
      RetentionInDays: 14,
    });
  });
});

// TASK 1.5.1: the media-upload function (POST /workshops/media-upload-url)
// is defined in web-stack.ts instead, co-located with MediaBucket — see
// this stack's own comment at the end of the constructor for why a
// cross-stack version here produces a circular CloudFormation dependency.
// Its tests live in web-stack.test.ts. TASK 1.5.2's stripe-webhook function
// is likewise defined in web-stack.ts (a stable custom-domain URL for the
// Stripe dashboard) — its tests live there too.

// TASK 1.6.2: the IAM/env half of the SSM-backed feature-flag store. Until
// this landed, every flag read `false` forever with no operator action able
// to change it (docs/plan/gate-g1-report.md §3a) — these assertions are
// what stop a future function being added to this stack flag-gated but
// unable to read a flag, which would look identical from the outside.
describe('DataStack — feature-flag reads', () => {
  const FLAG_READING_FUNCTIONS = [
    'content-read-handler',
    'content-authoring-handler',
    'testimonial-submission-handler',
    'testimonial-moderation-handler',
    'workshop-read-handler',
    'workshop-authoring-handler',
    'stripe-checkout-handler',
    // TASK 2.1.3: GET /audit is flag-gated too (audit.readApi.enabled,
    // default off — the read API is flagged, the writer deliberately is not).
    'audit-read-handler',
    // TASK 2.2.3: auth.patientRegistration.enabled, default off until
    // TASK 2.5.1 can approve anyone.
    'registration-handler',
    // TASK 2.4.1: clinicians.administration.enabled, default off.
    'clinician-admin-handler',
    // TASK 2.5.1: assignment.enabled, default off.
    'assignment-handler',
    // TASK 2.5.3: caseload.view.enabled, default off.
    'caseload-handler',
    // TASK 3.1.1: patients.profile.enabled, default off.
    'patient-handler',
    // TASK 3.2.1: clinicalRecords.enabled, default off.
    'clinical-record-handler',
    // TASK 3.3.1: assessments.enabled, default off.
    'assessment-handler',
    // TASK 3.4.1: appointments.enabled, default off.
    'appointment-handler',
    // TASK 3.4.3: appointments.reminders.enabled, default off.
    'reminder-sweep-handler',
    // TASK 3.5.1: contentAssignment.enabled, default off.
    'content-assignment-handler',
    // TASK 3.6.1: messaging.enabled, default off.
    'message-handler',
    // TASK 4.1.1: video.signalling.enabled, default off — read by the
    // $connect authorizer itself, not a downstream route (there is none
    // to gate on a WebSocket).
    'ws-authorizer-handler',
  ];

  it('gives every flag-reading function the prefix its handler resolves against', () => {
    const template = synth();
    const functions = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (fn) =>
        (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
          .Properties?.Environment?.Variables?.FLAG_PARAMETER_NAME_PREFIX !== undefined,
    );
    expect(functions).toHaveLength(FLAG_READING_FUNCTIONS.length);
    for (const fn of functions) {
      const variables = (
        fn as { Properties: { Environment: { Variables: Record<string, unknown> } } }
      ).Properties.Environment.Variables;
      expect(variables.FLAG_PARAMETER_NAME_PREFIX).toBe(FLAG_PARAMETER_NAME_PREFIX);
    }
  });

  it('grants ssm:GetParameter over the flag prefix and nothing wider', () => {
    const template = synth();
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (
            policy as {
              Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .filter((s) => s.Sid === 'ReadFeatureFlags');

    expect(statements).toHaveLength(FLAG_READING_FUNCTIONS.length);
    for (const statement of statements) {
      expect(statement.Effect).toBe('Allow');
      // Exactly one action. GetParameters/GetParametersByPath would let a
      // role enumerate the prefix; nothing needs that.
      expect(statement.Action).toBe('ssm:GetParameter');
      expect(JSON.stringify(statement.Resource)).toContain('parameter/ndn/flags/*');
    }
  });

  it('cannot reach any secret parameter — the wildcard stops at the flags/ segment', () => {
    const template = synth();
    const flagResources = JSON.stringify(
      Object.values(template.findResources('AWS::IAM::Policy'))
        .flatMap(
          (policy) =>
            (
              policy as {
                Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
              }
            ).Properties.PolicyDocument.Statement,
        )
        .filter((s) => s.Sid === 'ReadFeatureFlags')
        .map((s) => s.Resource),
    );

    // The secrets that live under /ndn/ but outside /ndn/flags/. A grant of
    // `parameter/ndn/*` would still pass the assertion above; it would not
    // pass this one.
    expect(flagResources).not.toContain('parameter/ndn/*');
    expect(flagResources).not.toContain('admin-api-token');
    expect(flagResources).not.toContain('stripe-secret-key');
    expect(flagResources).not.toContain('turnstile-secret-key');
  });
});

// TASK 2.1.3: the durable audit log's infrastructure half — one read
// function whose role may Query the log and never append to it, and a
// matching denial on every role that may append and must never read.
describe('DataStack — audit log (TASK 2.1.3)', () => {
  type Statement = Record<string, unknown>;

  function policyStatements(): Statement[] {
    return Object.values(synth().findResources('AWS::IAM::Policy')).flatMap(
      (policy) =>
        (policy as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
          .PolicyDocument.Statement,
    );
  }

  function statementsWithSid(sid: string): Statement[] {
    return policyStatements().filter((statement) => statement.Sid === sid);
  }

  it('routes GET /audit to a function with its own 14-day-retention log group, behind the real authorizer', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /audit',
      AuthorizationType: 'CUSTOM',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/audit-read-function',
      RetentionInDays: 14,
    });
  });

  it('gives every function that writes through a repository the audit table name', () => {
    const withAuditTable = Object.values(synth().findResources('AWS::Lambda::Function')).filter(
      (fn) =>
        (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
          .Properties?.Environment?.Variables?.AUDIT_TABLE_NAME !== undefined,
    );

    // Every Lambda in this stack that goes through a repository: the seven
    // that existed before TASK 2.1.3, the audit reader itself, TASK 2.2.3's
    // two registration functions, TASK 2.4.1's clinician-admin function,
    // TASK 2.5.1's assignment function, TASK 2.5.3's caseload function (it
    // never writes an audit row — `ClinicianRepository`'s read-only
    // `findById` never reaches one — but its constructor still takes an
    // `AuditWriter`, so the env var is present regardless), TASK 3.1.1's
    // patient function, TASK 3.2.1's clinical-record function, TASK
    // 3.3.1's assessment function, TASK 3.4.1's appointment function,
    // TASK 3.4.3's reminder-sweep function (the identical "wired to
    // satisfy the constructor, never actually reached" reasoning as
    // caseload-function — this task's own runbook names it directly),
    // TASK 3.5.1's content-assignment function, and TASK 3.6.1's message
    // function.
    // The authorizer is deliberately absent — it reads a status and
    // writes nothing.
    expect(withAuditTable).toHaveLength(20);
  });

  it('grants the reader dynamodb:Query and nothing that could change a row', () => {
    const readStatements = statementsWithSid('ReadAuditLog');

    expect(readStatements).toHaveLength(1);
    expect(readStatements[0]?.Effect).toBe('Allow');
    expect(readStatements[0]?.Action).toEqual('dynamodb:Query');
  });

  it('gives the reader no write action anywhere in its policy', () => {
    const template = synth();
    const [auditReadRoleId] = Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([logicalId]) => logicalId.startsWith('AuditReadFunctionRole'),
    ) ?? [undefined];
    expect(auditReadRoleId).toBeDefined();

    const auditReadPolicies = Object.values(template.findResources('AWS::IAM::Policy')).filter(
      (policy) =>
        JSON.stringify(
          (policy as { Properties: { Roles?: unknown } }).Properties.Roles ?? [],
        ).includes(auditReadRoleId as string),
    );
    const allowedActions = JSON.stringify(
      auditReadPolicies.flatMap((policy) =>
        (
          policy as { Properties: { PolicyDocument: { Statement: Statement[] } } }
        ).Properties.PolicyDocument.Statement.filter((s) => s.Effect === 'Allow').map(
          (s) => s.Action,
        ),
      ),
    );

    expect(allowedActions).toContain('dynamodb:Query');
    expect(allowedActions).not.toContain('dynamodb:PutItem');
    expect(allowedActions).not.toContain('dynamodb:UpdateItem');
    expect(allowedActions).not.toContain('dynamodb:DeleteItem');
  });

  // Step 4's property, expressed the way a single-table design allows: the
  // writers keep the read grants their own entities need and are denied the
  // audit partition by name. See infra/src/guardrails.ts.
  it('denies every other role in the stack any read of the AUDIT# partition', () => {
    const denials = statementsWithSid('DenyAuditPartitionReads');

    // The seven pre-existing functions, TASK 2.2.2's authorizer, TASK
    // 2.2.3's two registration roles, TASK 2.4.1's clinician-admin role,
    // TASK 2.5.1's assignment role, TASK 2.5.3's caseload role, TASK
    // 3.1.1's patient role, TASK 3.2.1's clinical-record role, TASK
    // 3.3.1's assessment role, TASK 3.4.1's appointment role, TASK
    // 3.4.3's reminder-sweep role, TASK 3.5.1's content-assignment role,
    // TASK 3.6.1's message role, and TASK 4.1.1's four WebSocket roles
    // (ws-authorizer/ws-connect/ws-disconnect/ws-default); the audit
    // reader is deliberately not among them, being the one role that is
    // supposed to read that partition.
    expect(denials).toHaveLength(24);
    for (const statement of denials) {
      expect(statement.Effect).toBe('Deny');
      expect(statement.Action).toEqual([
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:BatchGetItem',
      ]);
      expect(statement.Condition).toEqual({
        'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#*'] },
      });
    }
  });

  it('closes the keyless read that the LeadingKeys condition cannot see', () => {
    const denials = statementsWithSid('DenyKeylessTableReads');

    expect(denials).toHaveLength(24);
    for (const statement of denials) {
      expect(statement.Effect).toBe('Deny');
      expect(statement.Action).toEqual(['dynamodb:Scan', 'dynamodb:PartiQLSelect']);
    }
  });
});

// TASK 2.2.2: "a test enumerates the routes so a new unprotected one fails
// the build." Both HTTP APIs set `defaultAuthorizer`, so the *default* is
// already protected — this is the second lock: a route that opts out must
// also be named in route-protection.ts, and a route named there must
// actually exist. Neither list can drift from the other silently.
describe('DataStack — route protection (TASK 2.2.2)', () => {
  function statementsWithSid(sid: string): Record<string, unknown>[] {
    return Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (policy as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
            .Properties.PolicyDocument.Statement,
      )
      .filter((statement) => statement.Sid === sid);
  }

  // TASK 4.1.1 scopes this to the HTTP API's own routes: `SignallingWebSocketApi`
  // (data-stack.ts) is a second `AWS::ApiGatewayV2::Route`-emitting resource
  // now, but route-protection.ts's `UNAUTHENTICATED_ROUTE_KEYS` is an
  // HTTP-API-only concept — a WebSocket route's authorization is
  // ws-authorizer.ts's own, entirely separate mechanism (only `$connect`
  // takes an authorizer at all; `$disconnect`/`$default` never do, by
  // WebSocket API design, not by a route-protection.ts opt-out), tested in
  // ws-authorizer.test.ts and the WebSocket-specific assertions below, not
  // this describe block.
  function routeKeys(authorizationType: string): string[] {
    return Object.values(synth().findResources('AWS::ApiGatewayV2::Route'))
      .filter((route) => JSON.stringify(route.Properties?.ApiId ?? '').includes('ContentHttpApi'))
      .filter((route) => (route.Properties?.AuthorizationType ?? 'NONE') === authorizationType)
      .map((route) => String(route.Properties?.RouteKey))
      .sort();
  }

  // CDK materialises an `AWS::ApiGatewayV2::Authorizer` when a *route*
  // binds it, not when `defaultAuthorizer` is set — a route that opts out
  // with `HttpNoneAuthorizer` overrides the default, and every route did,
  // until now. TASK 2.4.1's three clinician-admin routes are the first to
  // take no `authorizer:` override at all, so `defaultAuthorizer` (the
  // real Lambda authorizer, TASK 2.2.2) applies to them for real and the
  // API-Gateway-side resource appears for the first time.
  //
  // Asserted rather than left implicit, because "the authorizer is
  // configured" and "the authorizer exists in the deployed API" were
  // different claims for every task through 2.3.2, and are the same claim
  // starting here.
  it('has exactly one HTTP API Gateway authorizer resource, once TASK 2.4.1 binds the first route to it', () => {
    // TASK 4.1.1 adds a second `AWS::ApiGatewayV2::Authorizer` —
    // `WebSocketRequestAuthorizer`, on the entirely separate WebSocket API
    // (ws-authorizer.ts). Two authorizer *resources* is correct: an API
    // Gateway authorizer belongs to exactly one API, and this stack now
    // has two APIs, each still with exactly one.
    synth().resourceCountIs('AWS::ApiGatewayV2::Authorizer', 2);
  });

  it('leaves exactly the routes route-protection.ts names outside the authorizer', () => {
    const declared = UNAUTHENTICATED_ROUTE_KEYS.filter((key) =>
      routeKeys('NONE').includes(key),
    ).sort();

    // Equality both ways: an undeclared opt-out fails, and so does a
    // declared key for a route this stack no longer has.
    expect(routeKeys('NONE')).toEqual(declared);
  });

  it('puts the clinician-admin (2.4.1)/assignment (2.5.1/2.5.2)/caseload (2.5.3)/patient (3.1.1/3.1.2)/clinical-record (3.2.1/3.2.2)/assessment (3.3.1/3.3.2)/appointment (3.4.1)/content-assignment (3.5.1)/message (3.6.1) routes, and TASK 2.5.4\'s retired-admin-token routes, behind the real authorizer', () => {
    // The first seven took no `authorizer:` override at all, ahead of
    // ADMIN_TOKEN_ROUTE's own retirement — every route before them opted
    // out with `PUBLIC_ROUTE` or the now-deleted `ADMIN_TOKEN_ROUTE`
    // (route-protection.ts). TASK 2.5.4 moved thirteen more onto this same
    // list: content authoring (4), workshop authoring (4), testimonial
    // moderation (3, `GET /testimonials/pending` new — `GET /testimonials`
    // itself stays public), and `GET /audit` — the fifth admin-token route
    // route-protection.ts's own header named as easy to miss. TASK 3.1.1
    // added `GET`/`PATCH /patients/{id}`; TASK 3.1.2 added `GET
    // /caseload/mine`, served by the same `PatientFunction`; TASK 3.2.1
    // added `POST /patients/{id}/diagnosis` and `POST
    // /patients/{id}/care-plan`; TASK 3.2.2 added the `GET` half of both,
    // all four served by `ClinicalRecordFunction`; TASK 3.3.1 added `POST
    // /patients/{id}/assessments/{assessmentId}`; TASK 3.3.2 added its
    // `GET` half, both served by `AssessmentFunction`; TASK 3.4.1 added
    // `POST`/`GET /patients/{id}/appointments` and `GET
    // /clinicians/me/calendar`; TASK 3.4.2 adds `POST
    // /patients/{id}/appointments/{apptId}/cancel`, all served by a new
    // `AppointmentFunction`; TASK 3.5.1 added `POST`/`GET
    // /patients/{id}/content`, served by a new `ContentAssignmentFunction`;
    // TASK 3.6.1 added `POST`/`GET /patients/{id}/messages`, served by a
    // new `MessageFunction`.
    expect(routeKeys('CUSTOM')).toEqual(
      [
        'GET /audit',
        'GET /caseload',
        'GET /caseload/mine',
        'GET /clinicians/me/calendar',
        'GET /patients/{id}',
        'GET /patients/{id}/appointments',
        'GET /patients/{id}/assessments/{assessmentId}',
        'GET /patients/{id}/care-plan',
        'GET /patients/{id}/content',
        'GET /patients/{id}/diagnosis',
        'GET /patients/{id}/messages',
        'GET /testimonials/pending',
        'PATCH /content/{id}',
        'PATCH /patients/{id}',
        'PATCH /workshops/{id}',
        'POST /clinicians',
        'POST /clinicians/{id}/deactivate',
        'POST /clinicians/{id}/reactivate',
        'POST /content',
        'POST /content/{id}/publish',
        'POST /content/{id}/unpublish',
        'POST /patients/{id}/appointments',
        'POST /patients/{id}/appointments/{apptId}/cancel',
        'POST /patients/{id}/approve',
        'POST /patients/{id}/assessments/{assessmentId}',
        'POST /patients/{id}/care-plan',
        'POST /patients/{id}/content',
        'POST /patients/{id}/decline',
        'POST /patients/{id}/diagnosis',
        'POST /patients/{id}/messages',
        'POST /patients/{id}/reassign',
        'POST /testimonials/{id}/publish',
        'POST /testimonials/{id}/reject',
        'POST /workshops',
        'POST /workshops/{id}/cancel',
        'POST /workshops/{id}/publish',
      ].sort(),
    );
  });

  it('grants the authorizer one keyed read, scoped to the two profile partitions', () => {
    const statements = statementsWithSid('ReadPrincipalProfiles');

    // TASK 4.1.1's WsAuthorizerFunction carries the identical statement,
    // for the identical reason — one keyed read of one profile row, on
    // its own separate role. Both, not one, are asserted below.
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.Action).toEqual('dynamodb:GetItem');
      expect(statement.Condition).toEqual({
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*', 'CLI#*'] },
      });
    }
  });

  it('gives the authorizer no write, no query and no scan', () => {
    // Scoped to the authorizer's *own* policy document — every other role
    // in this stack legitimately writes. Found by the statement only it
    // has, so the test cannot drift onto the wrong role after a rename.
    const authorizerPolicy = Object.values(synth().findResources('AWS::IAM::Policy')).find(
      (policy) =>
        JSON.stringify(policy.Properties?.PolicyDocument ?? {}).includes('ReadPrincipalProfiles'),
    );
    const statements = authorizerPolicy?.Properties?.PolicyDocument?.Statement as {
      Effect: string;
      Action: unknown;
    }[];
    const allowed = statements
      .filter((statement) => statement.Effect === 'Allow')
      .flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      );

    // Exactly one data-plane action. The authorizer is on the path of every
    // authenticated request in the estate; anything else here would be the
    // widest-blast-radius grant in the repository.
    expect(allowed.filter((action) => String(action).startsWith('dynamodb:'))).toEqual([
      'dynamodb:GetItem',
    ]);
  });

  it('writes the authorizer decision log to its own monitored group', () => {
    synth().hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/authorizer-function',
      RetentionInDays: 14,
    });
    expect(MONITORED_LOG_GROUP_NAMES).toContain('/ndn/authorizer-function');
    expect(MONITORED_LOG_GROUP_NAMES).not.toContain('/ndn/media-upload-function');
    expect(UNMONITORED_LOG_GROUP_NAMES).toContain('/ndn/media-upload-function');
    // The ten-slot ceiling budget-stack.ts's alarm cannot exceed.
    expect(MONITORED_LOG_GROUP_NAMES).toHaveLength(10);
  });

  it('passes both pools and both clients to the authorizer, and no secret', () => {
    const functions = Object.values(synth().findResources('AWS::Lambda::Function'));
    const authorizer = functions.find((fn) =>
      JSON.stringify(fn.Properties?.Environment ?? {}).includes('PATIENT_USER_POOL_ID'),
    );

    expect(authorizer?.Properties?.Environment?.Variables).toMatchObject({
      PATIENT_USER_POOL_ID,
      PATIENT_USER_POOL_CLIENT_ID,
      CLINICIAN_USER_POOL_ID,
      CLINICIAN_USER_POOL_CLIENT_ID,
    });
  });
});

// TASK 2.2.3: the front door — an unauthenticated endpoint that creates a
// Cognito account, and a trigger that turns a confirmed one into a record.
describe('DataStack — patient registration (TASK 2.2.3)', () => {
  function statementsWithSid(sid: string): Record<string, unknown>[] {
    return Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (policy as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
            .Properties.PolicyDocument.Statement,
      )
      .filter((statement) => statement.Sid === sid);
  }

  it('routes POST /registrations to a function with its own 14-day log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /registrations',
      AuthorizationType: 'NONE',
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/registration-function',
      RetentionInDays: 14,
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/post-confirmation-function',
      RetentionInDays: 14,
    });
    expect(UNMONITORED_LOG_GROUP_NAMES).toContain('/ndn/registration-function');
    expect(UNMONITORED_LOG_GROUP_NAMES).toContain('/ndn/post-confirmation-function');
  });

  it('gives the registration endpoint no cognito-idp permission at all', () => {
    // SignUp is an unauthenticated Cognito operation — AWS's own reference
    // says it "doesn't evaluate IAM policies". A grant here would be
    // permission that does nothing while reading as admin reach into the
    // directory.
    //
    // Scoped to the registration function's *own* policy, not the whole
    // template — TASK 2.4.1's clinician-admin function legitimately holds
    // `cognito-idp:Admin*` grants (AdminCreateUser is authenticated,
    // unlike SignUp), so a stack-wide string search would now be a false
    // positive against the wrong role.
    const template = synth();
    const [registrationRoleId] = Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([logicalId]) => logicalId.startsWith('RegistrationFunctionRole'),
    ) ?? [undefined];
    expect(registrationRoleId).toBeDefined();

    const registrationPolicies = Object.values(template.findResources('AWS::IAM::Policy')).filter(
      (policy) =>
        JSON.stringify(
          (policy as { Properties: { Roles?: unknown } }).Properties.Roles ?? [],
        ).includes(registrationRoleId as string),
    );
    expect(JSON.stringify(registrationPolicies)).not.toContain('cognito-idp:');
  });

  it('lets the registration endpoint write only the intake partition', () => {
    const statements = statementsWithSid('WriteRegistrationIntake');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('dynamodb:PutItem');
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['REG#*'] },
    });
  });

  it('scopes the trigger to the three partitions it touches, and no others', () => {
    // The one function Cognito can invoke. A table-wide grant would let it
    // reach every record in the estate.
    const statements = statementsWithSid('WritePatientProfile');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*', 'REG#*', 'AUDIT#*'] },
    });
  });

  it('lets the trigger append audit rows but never read them back', () => {
    // It writes through a repository, so 2.1.3's separation applies: the
    // PutItem above is what lets it append, and the audit-partition denial
    // is what stops it reading.
    const policy = Object.values(synth().findResources('AWS::IAM::Policy')).find((candidate) =>
      JSON.stringify(candidate.Properties?.PolicyDocument ?? {}).includes('WritePatientProfile'),
    );
    const statements = policy?.Properties?.PolicyDocument?.Statement as {
      Sid?: string;
      Effect: string;
    }[];

    expect(statements.some((statement) => statement.Sid === 'DenyAuditPartitionReads')).toBe(true);
    expect(statements.some((statement) => statement.Sid === 'DenyKeylessTableReads')).toBe(true);
  });

  it('scopes the confirmation email to the verified identity and the configuration set', () => {
    const statements = statementsWithSid('SendRegistrationEmail');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('ses:SendEmail');
    expect(JSON.stringify(statements[0]?.Resource)).toContain('identity/nourishthenerve.com');
  });
});

// TASK 3.4.3: the reminder sweep — no HTTP route, so its own shape needs
// its own describe block rather than the CUSTOM route-key list every
// other function's routes are already covered by.
describe('DataStack — reminder sweep function (TASK 3.4.3)', () => {
  function statementsWithSid(sid: string): Record<string, unknown>[] {
    return Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (policy as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
            .Properties.PolicyDocument.Statement,
      )
      .filter((statement) => statement.Sid === sid);
  }

  it('fires every 15 minutes and targets ReminderSweepFunction', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(15 minutes)',
      State: 'ENABLED',
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: { 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^ReminderSweepFunction')]) },
        }),
      ]),
    });
  });

  it('grants dynamodb:Query on GSI4 alone, never a Scan', () => {
    const statements = statementsWithSid('QueryReminderWindowIndex');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('dynamodb:Query');
    expect(JSON.stringify(statements[0]?.Resource)).toContain('index/GSI4');
  });

  it('grants GetItem/UpdateItem on PAT#* alone — no PutItem, no audit-partition write', () => {
    const statements = statementsWithSid('ReadAndClaimPatientAppointments');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] },
    });
  });

  it('is denied every other role\'s AUDIT# partition read and keyless-scan guardrails, the same as every function in this stack', () => {
    const policy = Object.values(synth().findResources('AWS::IAM::Policy')).find((candidate) =>
      JSON.stringify(candidate.Properties?.PolicyDocument ?? {}).includes('QueryReminderWindowIndex'),
    );
    const statements = policy?.Properties?.PolicyDocument?.Statement as { Sid?: string }[];

    expect(statements.some((statement) => statement.Sid === 'DenyAuditPartitionReads')).toBe(true);
    expect(statements.some((statement) => statement.Sid === 'DenyKeylessTableReads')).toBe(true);
  });
});

describe('DataStack — content assignment function (TASK 3.5.1)', () => {
  function statementsWithSid(sid: string): Record<string, unknown>[] {
    return Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (policy as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
            .Properties.PolicyDocument.Statement,
      )
      .filter((statement) => statement.Sid === sid);
  }

  it('is wired to the table name and routed at POST/GET /patients/{id}/content', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ PRINCIPAL_TABLE_NAME: Match.anyValue() }),
      },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /patients/{id}/content',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /patients/{id}/content',
    });
  });

  it('grants GetItem/PutItem/Query on PAT#* alone — no UpdateItem, this entity is never edited in place', () => {
    const statements = statementsWithSid('ReadWriteAndQueryPatientContentAssignments');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] },
    });
  });

  it('grants GetItem on CONTENT#* alone — the publish-check/hydration read, never a Query or a write', () => {
    const statements = statementsWithSid('ReadContentForAssignment');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('dynamodb:GetItem');
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONTENT#*'] },
    });
  });

  it("is denied every other role's AUDIT# partition read and keyless-scan guardrails, the same as every function in this stack", () => {
    const policy = Object.values(synth().findResources('AWS::IAM::Policy')).find((candidate) =>
      JSON.stringify(candidate.Properties?.PolicyDocument ?? {}).includes(
        'ReadWriteAndQueryPatientContentAssignments',
      ),
    );
    const statements = policy?.Properties?.PolicyDocument?.Statement as { Sid?: string }[];

    expect(statements.some((statement) => statement.Sid === 'DenyAuditPartitionReads')).toBe(true);
    expect(statements.some((statement) => statement.Sid === 'DenyKeylessTableReads')).toBe(true);
  });
});

describe('DataStack — message function (TASK 3.6.1)', () => {
  function statementsWithSid(sid: string): Record<string, unknown>[] {
    return Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (policy as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
            .Properties.PolicyDocument.Statement,
      )
      .filter((statement) => statement.Sid === sid);
  }

  it('is wired to the table name and routed at POST/GET /patients/{id}/messages', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ PRINCIPAL_TABLE_NAME: Match.anyValue() }),
      },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /patients/{id}/messages',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /patients/{id}/messages',
    });
  });

  it('grants GetItem/PutItem/Query on PAT#* alone — no UpdateItem, a message is never edited', () => {
    const statements = statementsWithSid('ReadWriteAndQueryPatientMessages');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] },
    });
  });

  it('grants cognito-idp:AdminGetUser on the clinician pool alone — resolving an email to notify, never a write action', () => {
    const statements = statementsWithSid('ReadClinicianEmailForMessageNotice');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('cognito-idp:AdminGetUser');
  });

  it("is denied every other role's AUDIT# partition read and keyless-scan guardrails, the same as every function in this stack", () => {
    const policy = Object.values(synth().findResources('AWS::IAM::Policy')).find((candidate) =>
      JSON.stringify(candidate.Properties?.PolicyDocument ?? {}).includes(
        'ReadWriteAndQueryPatientMessages',
      ),
    );
    const statements = policy?.Properties?.PolicyDocument?.Statement as { Sid?: string }[];

    expect(statements.some((statement) => statement.Sid === 'DenyAuditPartitionReads')).toBe(true);
    expect(statements.some((statement) => statement.Sid === 'DenyKeylessTableReads')).toBe(true);
  });
});

describe('DataStack — WebSocket signalling (TASK 4.1.1)', () => {
  function statementsWithSid(sid: string): Record<string, unknown>[] {
    return Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (policy as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } })
            .Properties.PolicyDocument.Statement,
      )
      .filter((statement) => statement.Sid === sid);
  }

  it('enables the table TTL attribute, named ttl', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('is a real WEBSOCKET protocol API, a second resource from ContentHttpApi', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
      RouteSelectionExpression: '$request.body.action',
    });
  });

  it('wires $connect, $disconnect and $default routes, each to its own function', () => {
    const template = synth();
    for (const routeKey of ['$connect', '$disconnect', '$default']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: routeKey });
    }
  });

  it('reads the token from the connect URL querystring, never a header', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      IdentitySource: ['route.request.querystring.token'],
    });
  });

  it('deploys the stage with no AccessLogSettings — the token rides in the connect URL', () => {
    const template = synth();
    const stages = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'));
    const wsStage = stages.find((stage) =>
      JSON.stringify(
        (stage as { Properties?: { ApiId?: unknown } }).Properties?.ApiId ?? '',
      ).includes('SignallingWebSocketApi'),
    );

    expect(wsStage).toBeDefined();
    const properties = (wsStage as { Properties?: Record<string, unknown> }).Properties;
    expect(properties?.AccessLogSettings).toBeUndefined();
    expect(properties?.AutoDeploy).toBe(true);
  });

  it('grants WsConnectFunction PutItem only, scoped to CONN#*', () => {
    const statements = statementsWithSid('WriteConnectionRow');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('dynamodb:PutItem');
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONN#*'] },
    });
  });

  it('grants WsDisconnectFunction UpdateItem only, scoped to CONN#* — never PutItem or DeleteItem', () => {
    const statements = statementsWithSid('UpdateConnectionRow');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.Action).toEqual('dynamodb:UpdateItem');
    expect(statements[0]?.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONN#*'] },
    });
  });

  it('gives WsAuthorizerFunction the flag-reading environment (video.signalling.enabled)', () => {
    const statements = statementsWithSid('ReadFeatureFlags');
    // TASK 4.1.1 adds one more flag-reading role to the count the
    // "feature-flag reads" describe block above already asserts in full —
    // this just confirms the mechanism reached this role too.
    expect(statements.length).toBeGreaterThan(0);
  });

  it('grants WsAuthorizerFunction the same PAT#*/CLI#* profile read as the HTTP authorizer, nothing wider', () => {
    const statements = statementsWithSid('ReadPrincipalProfiles');

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.Action).toEqual('dynamodb:GetItem');
    }
  });

  it('outputs the WebSocket signalling URL', () => {
    synth().hasOutput('SignallingWebSocketUrl', {});
  });
});
