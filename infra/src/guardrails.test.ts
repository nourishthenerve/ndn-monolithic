// "Integration against emulated AWS" (TASK 0.3.2's Tests line): CDK's
// assertions library synthesizes the exact CloudFormation template AWS
// would receive, with zero live AWS calls — a full, deterministic
// emulation of what gets evaluated at deploy time.
//
// The real-AWS half of the proof (the IAM policy *simulator*, run against
// the real evaluation engine, not an emulation of it) runs in CI against
// example-runtime-policy.json — see .github/workflows/ci.yml's
// oidc-dry-run job and docs/runbooks/iam-deny-guardrails.md. This file's
// job is to prove that fixture never drifts from what guardrails.ts
// actually produces (the "freshness" tests below) — a stale fixture would
// let the real CI proof quietly stop meaning anything.

import { readFileSync } from 'node:fs';

import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Table, AttributeType } from 'aws-cdk-lib/aws-dynamodb';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';

import {
  attachDestructiveActionGuardrail,
  BreakGlassRole,
  buildExampleRuntimePolicyDocument,
  denyBucketDeleteToPrincipalStatement,
  denyDestructiveActionsStatement,
  DENIED_DESTRUCTIVE_ACTIONS,
} from './guardrails.js';

const EXAMPLE_POLICY_FIXTURE_PATH = new URL(
  './__fixtures__/guardrails/example-runtime-policy.json',
  import.meta.url,
);

function buildTestStack() {
  const stack = new Stack();
  const role = new Role(stack, 'RuntimeRole', {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  });
  const bucket = new Bucket(stack, 'MediaBucket');
  const table = new Table(stack, 'DataTable', {
    partitionKey: { name: 'pk', type: AttributeType.STRING },
  });
  attachDestructiveActionGuardrail(role, { buckets: [bucket], tables: [table] });
  return { stack, role, bucket, table };
}

describe('denyDestructiveActionsStatement', () => {
  it('denies exactly the four destructive actions, nothing broader', () => {
    const bucket = new Bucket(new Stack(), 'B');
    const statement = denyDestructiveActionsStatement({ buckets: [bucket], tables: [] });
    const json = statement.toStatementJson();
    expect(json.Effect).toBe('Deny');
    expect(json.Action).toEqual(DENIED_DESTRUCTIVE_ACTIONS);
    expect(json.Action).not.toContain('s3:PutObject');
    expect(json.Action).not.toContain('dynamodb:PutItem');
  });

  it('scopes resources to the given buckets and tables only', () => {
    const stack = new Stack();
    const bucket = new Bucket(stack, 'B');
    const table = new Table(stack, 'T', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
    });
    const statement = denyDestructiveActionsStatement({ buckets: [bucket], tables: [table] });
    const json = statement.toStatementJson();
    const resources = json.Resource as unknown[];
    expect(resources).toHaveLength(3);
  });
});

describe('attachDestructiveActionGuardrail — runtime role', () => {
  it('attaches an explicit Deny on all four destructive actions', () => {
    const { stack } = buildTestStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyDestructivePrimitives',
            Effect: 'Deny',
            Action: Match.arrayWith([
              's3:DeleteObject',
              's3:DeleteObjectVersion',
              'dynamodb:DeleteItem',
              'dynamodb:DeleteTable',
            ]),
          }),
        ]),
      },
    });
  });

  it('does not deny ordinary read/write actions the role needs', () => {
    const { stack } = buildTestStack();
    const template = Template.fromStack(stack);
    const policies = template.findResources('AWS::IAM::Policy');
    const denyStatements = Object.values(policies).flatMap((policy) =>
      (
        policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
      ).Properties.PolicyDocument.Statement.filter((s) => s.Effect === 'Deny'),
    );
    for (const statement of denyStatements) {
      const actions = ([] as string[]).concat(statement.Action as string | string[]);
      expect(actions).not.toContain('s3:PutObject');
      expect(actions).not.toContain('s3:GetObject');
      expect(actions).not.toContain('dynamodb:PutItem');
      expect(actions).not.toContain('dynamodb:GetItem');
    }
  });
});

describe('attachDestructiveActionGuardrail — bucket policy', () => {
  it('adds a matching Deny to the bucket policy naming the runtime role as principal', () => {
    const { stack, role } = buildTestStack();
    const template = Template.fromStack(stack);
    const roleLogicalId = stack.getLogicalId(role.node.defaultChild as never);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyDeleteToRuntimePrincipal',
            Effect: 'Deny',
            Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
            Principal: {
              AWS: {
                'Fn::GetAtt': [roleLogicalId, 'Arn'],
              },
            },
          }),
        ]),
      },
    });
  });

  it('denyBucketDeleteToPrincipalStatement only ever names the two delete actions', () => {
    const stack = new Stack();
    const bucket = new Bucket(stack, 'B');
    const role = new Role(stack, 'R', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    const statement = denyBucketDeleteToPrincipalStatement(bucket, role);
    // Action wrapped alongside Effect: 'Deny' (not asserted as a bare array)
    // so this assertion itself satisfies ndn/no-destructive-primitives'
    // allowlist — see the file-header comment.
    expect(statement.toStatementJson()).toMatchObject({
      Effect: 'Deny',
      Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    });
  });
});

describe('BreakGlassRole', () => {
  function buildBreakGlassStack() {
    const stack = new Stack();
    const role = new BreakGlassRole(stack, 'BreakGlass', { accountId: '357601815388' });
    return { stack, role };
  }

  it('requires MFA in its trust policy', () => {
    const { stack } = buildBreakGlassStack();
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'ndn-break-glass',
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Condition: {
              Bool: { 'aws:MultiFactorAuthPresent': 'true' },
            },
          }),
        ]),
      },
    });
  });

  it('carries no permissions — no policy of any kind is attached', () => {
    const { stack } = buildBreakGlassStack();
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::IAM::Policy', 0);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  });
});

describe('buildExampleRuntimePolicyDocument', () => {
  it('matches the checked-in fixture CI feeds to the real IAM simulator', () => {
    const fixture = JSON.parse(readFileSync(EXAMPLE_POLICY_FIXTURE_PATH, 'utf8'));
    expect(buildExampleRuntimePolicyDocument()).toEqual(fixture);
  });

  it('is deny-first: the Deny statement outranks the baseline Allow for all four actions', () => {
    const document = buildExampleRuntimePolicyDocument();
    const [denyStatement, allowStatement] = document.Statement;
    expect(denyStatement.Effect).toBe('Deny');
    expect(allowStatement?.Effect).toBe('Allow');
    for (const action of DENIED_DESTRUCTIVE_ACTIONS) {
      expect(denyStatement?.Action).toContain(action);
      expect(allowStatement?.Action).not.toContain(action);
    }
  });
});
