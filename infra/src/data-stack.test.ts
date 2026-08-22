// Same philosophy as guardrails.test.ts/web-stack.test.ts: CDK's assertions
// library synthesizes the real CloudFormation template (including running
// NodejsFunction's real esbuild bundling of content-read-handler.ts), with
// zero live AWS calls.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { FLAG_PARAMETER_NAME_PREFIX } from './config.js';
import { DataStack } from './data-stack.js';

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

  it('creates only GSI2 (keyword -> content), KEYS_ONLY, nothing else', () => {
    const template = synth();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'gsi2pk', KeyType: 'HASH' },
            { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
      ],
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
  it('is wired to the table name and admin token parameter name via environment', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONTENT_TABLE_NAME: Match.anyValue(),
          ADMIN_TOKEN_PARAMETER_NAME: '/ndn/admin-api-token',
        }),
      },
    });
  });

  it('routes all four authoring endpoints to the same function', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /content' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PATCH /content/{id}',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /content/{id}/publish',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /content/{id}/unpublish',
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
    expect(allowActions).toContain('ssm:GetParameter');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = authoringPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });
  });

  it('scopes the SSM read to exactly the admin token parameter, not every parameter', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const authoringPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes('ReadAdminApiToken'),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const ssmStatement = authoringPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'ReadAdminApiToken',
    );

    expect(ssmStatement?.Action).toBe('ssm:GetParameter');
    // A CloudFormation intrinsic (Fn::Join with the account/region
    // pseudo-parameters), not a literal string — resolved at deploy time
    // to arn:aws:ssm:<region>:<account>:parameter/ndn/admin-api-token.
    // Serialising it is the simplest way to prove the parameter *name*
    // segment is baked in literally, rather than a wildcard covering every
    // parameter in the account.
    const resourceJson = JSON.stringify(ssmStatement?.Resource);
    expect(resourceJson).toContain('parameter/ndn/admin-api-token');
    expect(resourceJson).not.toContain('parameter/*');
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
  it('routes all four authoring endpoints to the same function', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /workshops' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PATCH /workshops/{id}',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/{id}/publish',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/{id}/cancel',
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
    expect(allowActions).toContain('ssm:GetParameter');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = authoringPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });
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

  it('routes GET /audit to a function with its own 14-day-retention log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'GET /audit' });
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

    // Every Lambda in this stack: the seven that existed before this task
    // plus the audit reader itself.
    expect(withAuditTable).toHaveLength(8);
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

    // The seven pre-existing functions; the audit reader is deliberately
    // not among them.
    expect(denials).toHaveLength(7);
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

    expect(denials).toHaveLength(7);
    for (const statement of denials) {
      expect(statement.Effect).toBe('Deny');
      expect(statement.Action).toEqual(['dynamodb:Scan', 'dynamodb:PartiQLSelect']);
    }
  });
});
