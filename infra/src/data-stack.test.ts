// Same philosophy as guardrails.test.ts/web-stack.test.ts: CDK's assertions
// library synthesizes the real CloudFormation template (including running
// NodejsFunction's real esbuild bundling of content-read-handler.ts), with
// zero live AWS calls.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { DataStack } from './data-stack.js';

function synth() {
  const app = new App();
  const stack = new DataStack(app, 'TestDataStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
  });
  return Template.fromStack(stack);
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
    const allowStatement = readGrant.Properties.PolicyDocument.Statement.find(
      (s) => s.Effect === 'Allow',
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
