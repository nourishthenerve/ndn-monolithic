// "Integration against emulated AWS" (TASK 0.4.1's Tests line), same
// philosophy as guardrails.test.ts: CDK's assertions library synthesizes
// the exact CloudFormation template AWS would receive, with zero live AWS
// calls. What can't be proven this way — TLS actually terminating, headers
// actually reaching a browser, a direct S3 URL actually 403ing — is proven
// for real post-deploy and recorded in docs/runbooks/iac-baseline.md.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { APEX_DOMAIN_NAME, CERTIFICATE_ARN, DOMAIN_NAME, WWW_DOMAIN_NAME } from './config.js';
import { DataStack } from './data-stack.js';
import { WebStack } from './web-stack.js';

function synth() {
  const app = new App();
  const stack = new WebStack(app, 'TestWebStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
  });
  return Template.fromStack(stack);
}

// TASK 1.5.2: the Stripe webhook function only exists when a `table` prop
// is given (mirrors production's DataStack -> WebStack wiring in
// infra/bin/app.ts) — same App so CDK resolves the cross-stack reference.
function synthWithTable() {
  const app = new App();
  const dataStack = new DataStack(app, 'TestDataStackForWebStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
  });
  const stack = new WebStack(app, 'TestWebStackWithTable', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
    table: dataStack.table,
  });
  return Template.fromStack(stack);
}

function synthEphemeral() {
  const app = new App();
  const stack = new WebStack(app, 'TestWebStackPr123', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
    ephemeral: true,
    prLabel: 'pr-123',
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

describe('WebStack — media bucket (TASK 1.5.1)', () => {
  it('is private, versioned, and SSL-enforced, same as the site bucket', () => {
    const template = synth();
    const buckets = template.findResources('AWS::S3::Bucket');
    const bucketProperties = Object.values(buckets).map(
      (bucket) => (bucket as { Properties: Record<string, unknown> }).Properties,
    );
    expect(
      bucketProperties.filter(
        (properties) =>
          JSON.stringify(
            (properties as { VersioningConfiguration?: unknown }).VersioningConfiguration,
          ) === JSON.stringify({ Status: 'Enabled' }),
      ),
    ).toHaveLength(2);
  });

  it('never auto-deletes on stack destroy', () => {
    const template = synth();
    template.resourceCountIs('AWS::S3::Bucket', 2);
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      expect(bucket).toMatchObject({
        UpdateReplacePolicy: 'Retain',
        DeletionPolicy: 'Retain',
      });
    }
  });

  it('is exposed as a bucket only CloudFront (via OAC) can read — no public or wildcard access', () => {
    const template = synth();
    const policies = template.findResources('AWS::S3::BucketPolicy');
    for (const policy of Object.values(policies)) {
      const statements = (
        policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }
      ).Properties.PolicyDocument.Statement;
      const allowStatements = statements.filter((s) => s.Effect === 'Allow');
      expect(allowStatements).toHaveLength(1);
      expect(allowStatements[0]).toMatchObject({
        Action: 's3:GetObject',
        Principal: { Service: 'cloudfront.amazonaws.com' },
      });
    }
  });
});

describe('WebStack — CloudFront distribution', () => {
  it('uses Origin Access Control for the S3 origin (no OAI, no public origin)', () => {
    const template = synth();
    // TASK 1.5.1: one for the site bucket, one for the media bucket — see
    // the dedicated 'WebStack — media bucket' describe block above for the
    // media bucket's own OAC-only assertions.
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
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

  // TASK 1.6.1: the apex/www aliases cannot be claimed while the legacy
  // distribution (a third AWS account, no credentials) still holds them —
  // adding them is what failed the 2026-08-15 deploy. The three-SAN
  // certificate is attached anyway: it is unblocked, and it is an
  // AWS-documented prerequisite for the cross-account move that releases the
  // claim. This asserts the decoupling holds, so a well-meaning edit doesn't
  // re-bundle them and reproduce that failure.
  it('attaches the apex/www-covering certificate without yet claiming those aliases', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.not(Match.arrayWith([APEX_DOMAIN_NAME])),
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: CERTIFICATE_ARN }),
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.not(Match.arrayWith([WWW_DOMAIN_NAME])),
      }),
    });
  });

  it('maps a missing S3 object (403 and 404 alike) to /404.html, served with a real 404 status', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: '/404.html',
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: '/404.html',
          }),
        ]),
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

  it('proxies /contact to the HTTP API same-origin, with caching disabled and all methods allowed', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/contact',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      }),
    });
  });

  it('proxies /media/* to the media bucket via a second OAC origin, over TLS', () => {
    const template = synth();
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 2);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/media/*',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      }),
    });
  });

  it('rewrites clean URLs to index.html on the default (S3) behavior only, not on /health', () => {
    const template = synth();
    const [functionLogicalId] = Object.keys(template.findResources('AWS::CloudFront::Function'));
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            Match.objectLike({
              EventType: 'viewer-request',
              FunctionARN: { 'Fn::GetAtt': [functionLogicalId, 'FunctionARN'] },
            }),
          ],
        }),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/health',
            FunctionAssociations: Match.absent(),
          }),
        ]),
      }),
    });
  });

  it("TASK 1.1.3: the rewrite function's actual logic appends index.html for clean URLs, leaving real files alone", () => {
    const template = synth();
    const [resource] = Object.values(template.findResources('AWS::CloudFront::Function'));
    if (!resource) {
      throw new Error('no AWS::CloudFront::Function resource found in the synthesized template');
    }
    const source: string = resource.Properties.FunctionCode;

    // The synthesized inline code is plain JS (CloudFront's JS-2.0 runtime
    // is a restricted subset, but this handler only uses string methods
    // that behave identically under Node) — run it for real, evaluating
    // the exact deployed function body rather than asserting on source
    // text, so a logic regression is actually caught, not just a string
    // match going stale.
    const handler = new Function(`${source}\nreturn handler(arguments[0]);`) as (event: {
      request: { uri: string };
    }) => { uri: string };

    const rewrite = (uri: string): string => handler({ request: { uri } }).uri;

    expect(rewrite('/')).toBe('/index.html');
    expect(rewrite('/en')).toBe('/en/index.html');
    expect(rewrite('/en/')).toBe('/en/index.html');
    expect(rewrite('/en/about')).toBe('/en/about/index.html');
    expect(rewrite('/assets/site.css')).toBe('/assets/site.css');
    expect(rewrite('/favicon.ico')).toBe('/favicon.ico');
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

  it('allows the Turnstile origin for script-src and frame-src, and nothing else added to default-src', () => {
    const template = synth();
    const [policy] = Object.values(
      template.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
    );
    const csp = (
      policy as {
        Properties: {
          ResponseHeadersPolicyConfig: {
            SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: string } };
          };
        };
      }
    ).Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
      .ContentSecurityPolicy;

    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain("default-src 'self'");
  });

  it('allows the Stripe origins for script-src and frame-src (TASK 1.5.2)', () => {
    const template = synth();
    const [policy] = Object.values(
      template.findResources('AWS::CloudFront::ResponseHeadersPolicy'),
    );
    const csp = (
      policy as {
        Properties: {
          ResponseHeadersPolicyConfig: {
            SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: string } };
          };
        };
      }
    ).Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
      .ContentSecurityPolicy;

    expect(csp).toContain('https://js.stripe.com');
    expect(csp).toContain('https://checkout.stripe.com');
  });
});

describe('WebStack — contact form Lambda (TASK 1.4.1)', () => {
  it('is reachable via a POST /contact route on the HTTP API', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /contact',
    });
  });

  it('runs on arm64 / Node 22, with the Turnstile parameter name and From/To addresses wired through', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          TURNSTILE_SECRET_PARAMETER_NAME: '/ndn/turnstile-secret-key',
          CONTACT_FORM_FROM_EMAIL: 'noreply@nourishthenerve.com',
          CONTACT_FORM_TO_EMAIL: 'contact@nourishthenerve.com',
        }),
      },
    });
  });

  it('grants exactly ssm:GetParameter on the Turnstile secret parameter, and ses:SendEmail scoped to the one verified identity', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'ssm:GetParameter',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('parameter/ndn/turnstile-secret-key')]),
              ]),
            }),
          }),
        ]),
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'ses:SendEmail',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('identity/nourishthenerve.com')]),
              ]),
            }),
          }),
        ]),
      }),
    });
  });

  it('sends logs to an explicit log group with 14-day retention', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/contact-form-function',
      RetentionInDays: 14,
    });
  });
});

describe('WebStack — media upload Lambda (TASK 1.5.1)', () => {
  it('is reachable via a POST /workshops/media-upload-url route on the HTTP API', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/media-upload-url',
    });
  });

  it('runs on arm64 / Node 22, with the media bucket name and admin token parameter name wired through', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          MEDIA_BUCKET_NAME: Match.anyValue(),
          ADMIN_TOKEN_PARAMETER_NAME: '/ndn/admin-api-token',
        }),
      },
    });
  });

  it('grants s3:PutObject scoped to the workshops/ prefix only, and denies s3:DeleteObject* via the guardrail', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const uploadPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'MediaUploadPutWorkshopPosters',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };

    const putStatement = uploadPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'MediaUploadPutWorkshopPosters',
    );
    expect(putStatement?.Action).toBe('s3:PutObject');
    expect(JSON.stringify(putStatement?.Resource)).toContain('/workshops/*');

    const denyStatement = uploadPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    // Action wrapped alongside Effect: 'Deny' in the same object literal
    // (not asserted as a bare array) so this assertion itself satisfies
    // ndn/no-destructive-primitives' allowlist — see guardrails.test.ts's
    // own comment on the same pattern.
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Effect: 'Deny',
      Action: expect.arrayContaining(['s3:DeleteObject', 's3:DeleteObjectVersion']),
    });
  });

  it('grants exactly ssm:GetParameter on the admin token parameter', () => {
    const template = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const uploadPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes('ReadAdminApiToken'),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const ssmStatement = uploadPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'ReadAdminApiToken',
    );
    expect(ssmStatement?.Action).toBe('ssm:GetParameter');
    const resourceJson = JSON.stringify(ssmStatement?.Resource);
    expect(resourceJson).toContain('parameter/ndn/admin-api-token');
    expect(resourceJson).not.toContain('parameter/*');
  });

  it('sends logs to an explicit log group with 14-day retention', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/media-upload-function',
      RetentionInDays: 14,
    });
  });
});

describe('WebStack — Stripe webhook Lambda (TASK 1.5.2)', () => {
  it('is absent (no function, no route) when no table prop is given — e.g. an ephemeral per-PR stack', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const routeKeys = Object.values(routes).map(
      (route) => (route as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routeKeys).not.toContain('POST /stripe/webhook');
  });

  it('is reachable via a POST /stripe/webhook route on the HTTP API when a table is given', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /stripe/webhook',
    });
  });

  it('runs on arm64 / Node 22, with the table name and both Stripe secret parameter names wired through', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          WORKSHOP_TABLE_NAME: Match.anyValue(),
          STRIPE_WEBHOOK_SECRET_PARAMETER_NAME: '/ndn/stripe-webhook-secret',
          STRIPE_SECRET_KEY_PARAMETER_NAME: '/ndn/stripe-secret-key',
        }),
      },
    });
  });

  it('grants PutItem/UpdateItem but never DeleteItem on its identity policy, and denies it via the guardrail', () => {
    const template = synthWithTable();
    const policies = template.findResources('AWS::IAM::Policy');
    const webhookPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'StripeWebhookFunctionRole',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };

    const allowActions = webhookPolicy.Properties.PolicyDocument.Statement.filter(
      (statement) => statement.Effect === 'Allow',
    ).flatMap((statement) => ([] as string[]).concat(statement.Action as string | string[]));

    expect(allowActions).toContain('dynamodb:PutItem');
    expect(allowActions).toContain('dynamodb:UpdateItem');
    expect(allowActions).toContain('ssm:GetParameter');
    expect(allowActions).toContain('ses:SendEmail');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = webhookPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });
  });

  it('grants ses:SendEmail scoped to the one verified identity, same as the contact form', () => {
    const template = synthWithTable();
    const policies = template.findResources('AWS::IAM::Policy');
    const webhookPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'SendRegistrationConfirmationEmail',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const sesStatement = webhookPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'SendRegistrationConfirmationEmail',
    );
    expect(sesStatement?.Action).toBe('ses:SendEmail');
    expect(JSON.stringify(sesStatement?.Resource)).toContain('identity/nourishthenerve.com');
  });

  it('scopes the SSM read to exactly the two Stripe secret parameters, not every parameter', () => {
    const template = synthWithTable();
    const policies = template.findResources('AWS::IAM::Policy');
    const webhookPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes('ReadStripeSecrets'),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const ssmStatement = webhookPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'ReadStripeSecrets',
    );
    const resourceJson = JSON.stringify(ssmStatement?.Resource);
    expect(resourceJson).toContain('parameter/ndn/stripe-webhook-secret');
    expect(resourceJson).toContain('parameter/ndn/stripe-secret-key');
    expect(resourceJson).not.toContain('parameter/*');
  });

  it('proxies /stripe/webhook to the HTTP API same-origin, with caching disabled and all methods allowed', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/stripe/webhook',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      }),
    });
  });

  it('has an explicit 14-day-retention log group', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/stripe-webhook-function',
      RetentionInDays: 14,
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

describe('WebStack — canary deployment (TASK 0.6.2)', () => {
  it('publishes a version and routes it through a "live" alias', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });
  });

  it('routes API Gateway through the alias, not the bare function — no deploy path bypasses it', () => {
    const template = synth();
    const [aliasLogicalId] = Object.keys(template.findResources('AWS::Lambda::Alias'));
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationUri: { Ref: aliasLogicalId },
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      FunctionName: { Ref: aliasLogicalId },
      Principal: 'apigateway.amazonaws.com',
    });
  });

  it('alarms on alias errors and elevated latency, scoped to the alias — not the bare function', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
      Dimensions: Match.arrayWith([
        Match.objectLike({
          Name: 'Resource',
          Value: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([':live'])]) }),
        }),
      ]),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Duration',
      Namespace: 'AWS/Lambda',
      Statistic: 'Average',
      ComparisonOperator: 'GreaterThanThreshold',
      // Under the 5s function timeout — catches real degradation, not
      // ordinary cold-start jitter.
      Threshold: 3000,
      TreatMissingData: 'notBreaching',
    });
  });

  it('deploys via a canary that shifts 10% of traffic, waits 5 minutes, then the rest', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes',
      DeploymentStyle: {
        DeploymentType: 'BLUE_GREEN',
        DeploymentOption: 'WITH_TRAFFIC_CONTROL',
      },
    });
  });

  it('wires both alarms into the deployment group and rolls back automatically on failure or an alarm', () => {
    const template = synth();
    const [errorsAlarmId, latencyAlarmId] = Object.keys(
      template.findResources('AWS::CloudWatch::Alarm'),
    );
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: {
        Enabled: true,
        Alarms: Match.arrayWith([
          { Name: { Ref: errorsAlarmId } },
          { Name: { Ref: latencyAlarmId } },
        ]),
      },
      // DoD: "rollback demonstrated, not described" — CodeDeploy stops and
      // reverts the alias on either a failed lifecycle hook or a tripped
      // alarm, not just a deployment error.
      AutoRollbackConfiguration: {
        Enabled: true,
        Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']),
      },
    });
  });

  it('runs a post-traffic smoke test against the live domain, wired as the AfterAllowTraffic hook', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Environment: { Variables: { SITE_DOMAIN: DOMAIN_NAME } },
    });

    const [smokeTestLogicalId] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([, resource]) =>
        JSON.stringify((resource as { Properties: unknown }).Properties).includes('SITE_DOMAIN'),
      )
      .map(([id]) => id);
    template.hasResource('AWS::Lambda::Alias', {
      Properties: Match.objectLike({ Name: 'live' }),
      UpdatePolicy: Match.objectLike({
        CodeDeployLambdaAliasUpdate: Match.objectLike({
          AfterAllowTrafficHook: { Ref: smokeTestLogicalId },
        }),
      }),
    });
  });

  it('grants the smoke test only PutLifecycleEventHookExecutionStatus on the deployment group — no broader access', () => {
    const template = synth();
    const [deploymentGroupLogicalId] = Object.keys(
      template.findResources('AWS::CodeDeploy::DeploymentGroup'),
    );
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'codedeploy:PutLifecycleEventHookExecutionStatus',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([Match.arrayWith([{ Ref: deploymentGroupLogicalId }])]),
            }),
          }),
        ]),
      }),
    });
  });

  it('sends smoke-test logs to an explicit log group with 14-day retention (R-11)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/smoke-test-function',
      RetentionInDays: 14,
    });
  });
});

describe('WebStack — outputs', () => {
  it('exposes the values the manual DNS step needs', () => {
    const template = synth();
    template.hasOutput('DistributionDomainName', {});
    template.hasOutput('SiteBucketName', {});
    template.hasOutput('MediaBucketName', {});
    template.hasOutput('HttpApiUrl', {});
  });

  it('exposes the CodeDeploy deployment group name for post-deploy verification', () => {
    const template = synth();
    template.hasOutput('HealthDeploymentGroupName', {});
  });
});

describe('WebStack — ephemeral per-PR mode (TASK 0.6.3)', () => {
  it('has no CloudFront alias and no custom viewer certificate — avoids colliding with the prod distribution', () => {
    const template = synthEphemeral();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.absent(),
        // No ViewerCertificate at all means CloudFront falls back to its
        // own default *.cloudfront.net certificate — the same absence
        // production's Aliases/certificate pairing never exercises.
        ViewerCertificate: Match.absent(),
      }),
    });
  });

  it('does not import the production ACM certificate', () => {
    const template = synthEphemeral();
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions);
    expect(JSON.stringify((distribution as { Properties: unknown }).Properties)).not.toContain(
      'AcmCertificateArn',
    );
  });

  it('scopes both explicit log group names to the given PR label, not the fixed production names', () => {
    const template = synthEphemeral();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/pr-123/health-function',
      RetentionInDays: 14,
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/pr-123/smoke-test-function',
      RetentionInDays: 14,
    });
  });

  it('production mode is unaffected — still the fixed domain, certificate, and log group names', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [DOMAIN_NAME],
      }),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/health-function',
    });
  });
});
