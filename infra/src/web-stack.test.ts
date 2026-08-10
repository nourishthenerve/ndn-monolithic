// "Integration against emulated AWS" (TASK 0.4.1's Tests line), same
// philosophy as guardrails.test.ts: CDK's assertions library synthesizes
// the exact CloudFormation template AWS would receive, with zero live AWS
// calls. What can't be proven this way — TLS actually terminating, headers
// actually reaching a browser, a direct S3 URL actually 403ing — is proven
// for real post-deploy and recorded in docs/runbooks/iac-baseline.md.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { DOMAIN_NAME } from './config.js';
import { WebStack } from './web-stack.js';

function synth() {
  const app = new App();
  const stack = new WebStack(app, 'TestWebStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
  });
  return Template.fromStack(stack);
}

describe('WebStack — site bucket', () => {
  it('is private, versioned, and SSL-enforced', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('never auto-deletes on stack destroy', () => {
    const template = synth();
    template.hasResource('AWS::S3::Bucket', {
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    });
  });

  it('denies non-TLS access to everyone', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Principal: { AWS: '*' },
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('only allows GetObject to CloudFront via OAC — no public or wildcard access', () => {
    const template = synth();
    const policies = template.findResources('AWS::S3::BucketPolicy');
    const [policy] = Object.values(policies);
    const statements = (
      policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
    ).Properties.PolicyDocument.Statement;
    const allowStatements = statements.filter((s) => s.Effect === 'Allow');
    expect(allowStatements).toHaveLength(1);
    expect(allowStatements[0]).toMatchObject({
      Action: 's3:GetObject',
      Principal: { Service: 'cloudfront.amazonaws.com' },
    });
    // Scoped to this exact distribution via SourceArn — not principal "*",
    // not a bare service-principal grant.
    expect(JSON.stringify(allowStatements[0])).toContain('AWS:SourceArn');
  });
});

describe('WebStack — CloudFront distribution', () => {
  it('uses Origin Access Control for the S3 origin (no OAI, no public origin)', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({ SigningBehavior: 'always' }),
    });
  });

  it('serves the staging hostname only, over TLS, at PriceClass_100', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [DOMAIN_NAME],
        PriceClass: 'PriceClass_100',
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  it('proxies /health to the HTTP API same-origin, with caching disabled', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/health',
            // CachePolicy.CACHING_DISABLED's well-known managed policy ID —
            // R-14: no-store, matching "no patient data traverses
            // CloudFront" even though /health itself carries none.
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      }),
    });
  });

  it('attaches the security headers policy to both behaviors', () => {
    const template = synth();
    const [headersPolicyLogicalId] = Object.keys(
      template.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
    );
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: { Ref: headersPolicyLogicalId },
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ ResponseHeadersPolicyId: { Ref: headersPolicyLogicalId } }),
        ]),
      }),
    });
  });
});

describe('WebStack — security headers policy', () => {
  it('sets HSTS, CSP, nosniff, deny-framing, and a referrer policy', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            Override: true,
            IncludeSubdomains: true,
            Preload: true,
          }),
          ContentTypeOptions: { Override: true },
          FrameOptions: Match.objectLike({ Override: true, FrameOption: 'DENY' }),
          ReferrerPolicy: Match.objectLike({ Override: true }),
          ContentSecurityPolicy: Match.objectLike({ Override: true }),
        }),
      }),
    });
  });
});

describe('WebStack — health Lambda', () => {
  it('runs on arm64 / Node 22, with the deploy version wired through', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Environment: { Variables: { DEPLOY_VERSION: 'test-sha' } },
    });
  });

  it('is reachable via a GET /health route on the HTTP API', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /health',
    });
  });

  it('sends logs to an explicit log group with 14-day retention (TASK 0.5.2, R-11)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/health-function',
      RetentionInDays: 14,
    });
    const [logGroupLogicalId] = Object.keys(template.findResources('AWS::Logs::LogGroup'));
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({
        LogGroup: { Ref: logGroupLogicalId },
      }),
    });
  });
});

describe('WebStack — outputs', () => {
  it('exposes the values the manual DNS step needs', () => {
    const template = synth();
    template.hasOutput('DistributionDomainName', {});
    template.hasOutput('SiteBucketName', {});
    template.hasOutput('HttpApiUrl', {});
  });
});
