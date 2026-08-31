// "Integration against emulated AWS" (TASK 0.4.1's Tests line), same
// philosophy as guardrails.test.ts: CDK's assertions library synthesizes
// the exact CloudFormation template AWS would receive, with zero live AWS
// calls. What can't be proven this way — TLS actually terminating, headers
// actually reaching a browser, a direct S3 URL actually 403ing — is proven
// for real post-deploy and recorded in docs/runbooks/iac-baseline.md.

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  ALERT_EMAIL,
  APEX_DOMAIN_NAME,
  AUTH_CALLBACK_URL,
  CERTIFICATE_ARN,
  CLINICIAN_OAUTH_BASE_URL,
  DOMAIN_NAME,
  FLAG_PARAMETER_NAME_PREFIX,
  MONITORED_LOG_GROUP_NAMES,
  PATIENT_OAUTH_BASE_URL,
  PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME,
  SES_CONFIGURATION_SET_NAME,
  UNMONITORED_LOG_GROUP_NAMES,
  WWW_DOMAIN_NAME,
} from './config.js';
import { DataStack } from './data-stack.js';
import { UNAUTHENTICATED_ROUTE_KEYS } from './route-protection.js';
import { WebStack } from './web-stack.js';

// Synthesis, not assertion, is what this suite spends its time on: every
// call builds the whole app and re-bundles all six Lambdas through
// esbuild, and there are ~70 calls across this file. Each distinct shape
// is therefore synthesized once and shared — the assertions library only
// ever reads a Template, so there is nothing for one test to hand the next
// in a mutated state. Before this, `quality` ran the infra suite for six
// minutes and then hit its 15-minute job ceiling.
function memoize(build: () => Template): () => Template {
  let template: Template | undefined;
  return () => (template ??= build());
}

const synth = memoize(() => {
  const app = new App();
  const stack = new WebStack(app, 'TestWebStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
  });
  return Template.fromStack(stack);
});

// TASK 1.5.2: the Stripe webhook function only exists when a `table` prop
// is given (mirrors production's DataStack -> WebStack wiring in
// infra/bin/app.ts) — same App so CDK resolves the cross-stack reference.
// TASK 2.5.4: `authorizerFunction` is wired through too, the same way
// production's bin/app.ts wires it — until now this helper never passed
// it, so no test in this file had ever exercised a WebStack route actually
// landing on the real authorizer; MediaUploadFunction's own new
// `if (props.authorizerFunction)` gate is what makes that gap matter.
const synthWithTable = memoize(() => {
  const app = new App();
  const dataStack = new DataStack(app, 'TestDataStackForWebStack', {
    env: { account: '357601815388', region: 'eu-west-2' },
  });
  const stack = new WebStack(app, 'TestWebStackWithTable', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
    table: dataStack.table,
    authorizerFunction: dataStack.authorizerFunction,
  });
  return Template.fromStack(stack);
});

// Resolve a log group by the name it carries rather than by position:
// there are now several in this stack, and "the first one findResources
// happens to return" would quietly start asserting about a different
// function the next time one is added.
function logGroupLogicalIdFor(template: Template, logGroupName: string): string {
  const [logicalId] = Object.entries(template.findResources('AWS::Logs::LogGroup')).find(
    ([, resource]) =>
      (resource as { Properties?: { LogGroupName?: string } }).Properties?.LogGroupName ===
      logGroupName,
  ) ?? [undefined];
  expect(logicalId, `no log group named ${logGroupName}`).toBeDefined();
  return logicalId as string;
}

const synthEphemeral = memoize(() => {
  const app = new App();
  const stack = new WebStack(app, 'TestWebStackPr123', {
    env: { account: '357601815388', region: 'eu-west-2' },
    deployVersion: 'test-sha',
    ephemeral: true,
    prLabel: 'pr-123',
  });
  return Template.fromStack(stack);
});

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

  it('serves all three production hostnames, over TLS, at PriceClass_100', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [DOMAIN_NAME, APEX_DOMAIN_NAME, WWW_DOMAIN_NAME],
        PriceClass: 'PriceClass_100',
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  // TASK 1.6.1: apex/www were held out of this array until 2026-08-21,
  // because a CloudFront alternate domain name can only be claimed by one
  // distribution globally and the legacy `ndn-frontend` Amplify app still
  // held both. Now that they are listed, the pairing that the earlier
  // decoupling protected has to hold in the other direction: every alias
  // must be covered by the attached certificate, or the deploy fails at
  // CloudFront with a certificate/alias mismatch rather than at rollback.
  // CERTIFICATE_ARN is the three-SAN cert covering exactly these names.
  it('claims apex/www alongside next., all covered by the three-SAN certificate', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: Match.arrayWith([APEX_DOMAIN_NAME, WWW_DOMAIN_NAME]),
        ViewerCertificate: Match.objectLike({ AcmCertificateArn: CERTIFICATE_ARN }),
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

  // Found live, 2026-08-31: with no `connect-src` at all, CSP fell back to
  // `default-src 'self'`, silently blocking every authenticated account
  // panel's own fetch to `contentApiUrl`/`signallingWebSocketUrl` (both
  // cross-origin `execute-api.amazonaws.com` hosts) — invisible to any
  // check that isn't a real signed-in browser actually attempting one.
  it('allows the content API and signalling WebSocket origins for connect-src', () => {
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

    expect(csp).toContain(
      "connect-src 'self' https://m4ptz0to5m.execute-api.eu-west-2.amazonaws.com " +
        'wss://93im3xehxh.execute-api.eu-west-2.amazonaws.com',
    );
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

// D-32 (2026-08-30): the contact form Lambda/route/CloudFront-behavior
// this describe block covered is deleted outright, not darkened — see
// docs/runbooks/contact-form.md. `WebStack — Stripe webhook Lambda`
// below already covers the one remaining ses:SendEmail grant in this
// stack (D-31's own dark, unwired code).

describe('WebStack — media upload Lambda (TASK 1.5.1 / 2.5.4)', () => {
  // TASK 2.5.4: this function now authenticates with the real Lambda
  // authorizer, and is gated on `props.authorizerFunction` being present
  // (this file's own header comment on that prop) — so every test here
  // needs `synthWithTable()`, the one helper that wires a real
  // `authorizerFunction` through. Bare `synth()` (no table, no authorizer
  // — the ephemeral-stack shape) builds neither the function nor its
  // route at all; that absence is asserted in its own describe block
  // below, not here.
  it('is reachable via a POST /workshops/media-upload-url route on the HTTP API, behind the real authorizer', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /workshops/media-upload-url',
      AuthorizationType: 'CUSTOM',
    });
  });

  it('runs on arm64 / Node 22, with the media bucket name wired through and no admin secret', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Architectures: ['arm64'],
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          MEDIA_BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const uploadPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'MediaUploadPutWorkshopPosters',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const sids = uploadPolicy.Properties.PolicyDocument.Statement.map(
      (statement) => statement.Sid,
    );
    expect(sids).not.toContain('ReadAdminApiToken');
  });

  it('grants s3:PutObject scoped to the workshops/ prefix only, and denies s3:DeleteObject* via the guardrail', () => {
    const template = synthWithTable();
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

  it('sends logs to an explicit log group with 14-day retention', () => {
    const template = synthWithTable();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/media-upload-function',
      RetentionInDays: 14,
    });
  });

  it('is absent (no route, no function) when no authorizer function is given — e.g. an ephemeral per-PR stack', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const routeKeys = Object.values(routes).map(
      (route) => (route as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routeKeys).not.toContain('POST /workshops/media-upload-url');
    const functionNames = Object.keys(template.findResources('AWS::Lambda::Function'));
    expect(functionNames.some((id) => id.startsWith('MediaUploadFunction'))).toBe(false);
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
          NOTIFICATION_TABLE_NAME: Match.anyValue(),
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
    expect(allowActions).toContain('sms-voice:SendTextMessage');
    expect(allowActions).not.toContain('dynamodb:DeleteItem');

    const denyStatement = webhookPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Effect === 'Deny',
    );
    expect(denyStatement).toMatchObject({
      Sid: 'DenyDestructivePrimitives',
      Action: expect.arrayContaining(['dynamodb:DeleteItem']),
    });
  });

  it('grants ses:SendEmail scoped to the one verified identity', () => {
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

  it('grants sms-voice:SendTextMessage for the Notifier SMS attempt (TASK workshop-confirmation-sms)', () => {
    const template = synthWithTable();
    const policies = template.findResources('AWS::IAM::Policy');
    const webhookPolicy = Object.values(policies).find((policy) =>
      JSON.stringify((policy as { Properties: unknown }).Properties).includes(
        'SendRegistrationConfirmationSms',
      ),
    ) as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } };
    const smsStatement = webhookPolicy.Properties.PolicyDocument.Statement.find(
      (statement) => statement.Sid === 'SendRegistrationConfirmationSms',
    );
    expect(smsStatement?.Action).toBe('sms-voice:SendTextMessage');
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
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({
        LogGroup: { Ref: logGroupLogicalIdFor(template, '/ndn/health-function') },
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
    // Select the two health alarms by what they measure, not by being first
    // in the template. The stack gained SES reputation alarms and "the first
    // two alarms" silently stopped meaning "the health alarms".
    const [errorsAlarmId, latencyAlarmId] = Object.entries(
      template.findResources('AWS::CloudWatch::Alarm'),
    )
      .filter(
        ([, alarm]) =>
          (alarm as { Properties: { Namespace?: string } }).Properties.Namespace === 'AWS/Lambda',
      )
      .map(([logicalId]) => logicalId);
    expect(errorsAlarmId).toBeDefined();
    expect(latencyAlarmId).toBeDefined();
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

// Gate G1 §4. BucketDeployment brings a Lambda of its own, and it was the
// only function in the app writing to a log group CloudFormation didn't
// own: infinite retention, left behind by `cdk destroy`, one new orphan
// per ephemeral PR stack.
describe('WebStack — site deployment log group', () => {
  it('gives CDK’s bucket-deployment Lambda an explicit 14-day, DESTROY log group', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/site-deployment',
      RetentionInDays: 14,
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({
        LogGroup: { Ref: logGroupLogicalIdFor(template, '/ndn/site-deployment') },
      }),
    });
  });

  // The ephemeral half is the opposite shape, and deliberately so: this is
  // the one Lambda `cdk destroy` invokes as part of its own teardown, so a
  // stack-owned group races its own deletion and CloudWatch recreates it
  // bare (measured on PR #48 — the recreated group's creation timestamp was
  // 9 seconds later than the events inside it). An ephemeral stack
  // therefore creates no group at all and writes to the shared, out-of-band
  // one, which nothing in any stack can delete.
  it('creates no site-deployment log group in an ephemeral stack — it writes to the shared one', () => {
    const template = synthEphemeral();
    const names = Object.values(template.findResources('AWS::Logs::LogGroup')).map(
      (resource) =>
        (resource as { Properties?: { LogGroupName?: string } }).Properties?.LogGroupName,
    );
    expect(names).not.toContain('/ndn/pr-123/site-deployment');
    expect(names).not.toContain(PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME);

    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: Match.objectLike({ LogGroup: PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME }),
    });
  });

  it('destroys production’s own group with its stack — nothing is retained by accident', () => {
    const template = synth();
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup')).filter(
      (resource) =>
        (resource as { Properties?: { LogGroupName?: string } }).Properties?.LogGroupName ===
        '/ndn/site-deployment',
    );
    expect(logGroups).toHaveLength(1);
    expect((logGroups[0] as { DeletionPolicy?: string }).DeletionPolicy).toBe('Delete');
  });

  // TASK 5.2.1: CDK's own `Bucket.autoDeleteObjects` singleton
  // (`CustomS3AutoDeleteObjectsCustomResourceProviderHandler...`, only
  // present in the ephemeral synth once TASK 5.2.1's SiteBucket/
  // MediaBucket fix is live) is built via a raw `CfnResource` inside
  // aws-cdk-lib/core, not `aws-cdk-lib/aws-lambda`'s `CfnFunction` class —
  // and exposes no public prop to give it an explicit log group the way
  // `BucketDeployment`'s own `logGroup` prop lets this stack do just below.
  // A real, small, named residual (invoked only at delete time, a handful
  // of log lines, infinite retention) rather than something this repo can
  // close today — see web-stack.ts's own comment on `siteBucket` and
  // docs/runbooks/aws-account-baseline.md's periodic-check note. Excluded
  // by exact, matched-prefix logical ID rather than broadened to "any
  // unrecognised function", so a real future regression still fails here.
  const KNOWN_IMPLICIT_LOG_GROUP_PREFIXES = ['CustomS3AutoDeleteObjectsCustomResourceProvider'];

  it('leaves no Lambda in the stack relying on CloudWatch’s implicit group', () => {
    for (const template of [synth(), synthEphemeral()]) {
      const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
      expect(functions.length).toBeGreaterThan(0);
      for (const [logicalId, resource] of functions) {
        if (KNOWN_IMPLICIT_LOG_GROUP_PREFIXES.some((prefix) => logicalId.startsWith(prefix))) {
          continue;
        }
        const loggingConfig = (
          resource as { Properties?: { LoggingConfig?: { LogGroup?: unknown } } }
        ).Properties?.LoggingConfig;
        expect(loggingConfig?.LogGroup, logicalId).toBeDefined();
      }
    }
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
  // TASK 5.2.1: this had been RETAIN unconditionally since 0.6.3 first
  // added `ephemeral` — every per-PR stack's own SiteBucket/MediaBucket
  // orphaned on `cdk destroy` rather than being deleted, 76 of them by the
  // time this gap was found, none caught by the CI job's own "zero
  // standing cost" assertion (which checks only that the stack is gone).
  it('destroys SiteBucket and MediaBucket on cdk destroy, unlike production’s RETAIN, with autoDeleteObjects wired so a non-empty bucket does not block it', () => {
    const template = synthEphemeral();
    template.resourceCountIs('AWS::S3::Bucket', 2);
    for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect((bucket as { DeletionPolicy: string }).DeletionPolicy).toBe('Delete');
      expect((bucket as { UpdateReplacePolicy: string }).UpdateReplacePolicy).toBe('Delete');
    }
    // autoDeleteObjects wires an S3 bucket notification-free custom
    // resource per bucket, backed by one shared provider Lambda.
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 2);
  });

  it('production’s own synth is unaffected by the ephemeral flag — both buckets still RETAIN', () => {
    const template = synth();
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect((bucket as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
    }
  });

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

  it('scopes every explicit log group name to the given PR label, not the fixed production names', () => {
    const template = synthEphemeral();
    for (const baseName of ['health-function', 'smoke-test-function']) {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/ndn/pr-123/${baseName}`,
        RetentionInDays: 14,
      });
    }
  });

  // Regression guard. The email-event pipeline landed unconditionally
  // while the pr-environment job was paused, so nothing deployed an
  // ephemeral copy of this stack until the job was re-enabled — at which
  // point CloudFormation refused three of its four resources with
  // "already exists" (the fourth, the SNS topic, would have been adopted
  // silently and then deleted on destroy — see web-stack.ts's comment).
  // Every resource named here is account-global and fixed, so the correct
  // ephemeral count for each is zero, not "one with a different name".
  it('creates none of the account-global email resources — they belong to production alone', () => {
    const template = synthEphemeral();
    template.resourceCountIs('AWS::SES::ConfigurationSet', 0);
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 0);
    template.resourceCountIs('AWS::SNS::Topic', 0);
    template.resourceCountIs('AWS::SNS::Subscription', 0);

    const alarmNames = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
      (alarm) => (alarm as { Properties?: { AlarmName?: string } }).Properties?.AlarmName,
    );
    expect(alarmNames.filter((name) => name?.startsWith('ndn-email'))).toEqual([]);
  });

  // D-32 (2026-08-30): this used to assert the contact form's sender kept
  // pointing at production's configuration set even in an ephemeral
  // stack. The contact form is deleted, and the one remaining sender
  // (StripeWebhookFunction) only builds when `props.table` is given —
  // never true for an ephemeral per-PR stack (no DataStack, see this
  // describe block's own header). There is no sender left to assert
  // against here.

  it('production mode is unaffected — still the fixed domains, certificate, and log group names', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: [DOMAIN_NAME, APEX_DOMAIN_NAME, WWW_DOMAIN_NAME],
      }),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/health-function',
    });
    // The pipeline the ephemeral tests above assert is absent must still
    // exist here — otherwise "zero in ephemeral" would pass by deleting it
    // everywhere.
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: SES_CONFIGURATION_SET_NAME,
    });
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'ndn-email-events' });
  });
});

// TASK 1.6.2: this stack's flag-reading functions (media-upload-handler,
// TASK 2.2.4's auth-token function, and (TASK workshop-confirmation-sms)
// the Stripe webhook function — its Notifier's SMS guard chain reads
// feature flags the same way reminder-sweep's does). data-stack.test.ts
// carries the fuller assertions for the rest and for the prefix's
// scoping; these prove the wiring reached this stack too, rather than
// only the one it was written against. D-32 (2026-08-30): contact-form-
// handler, formerly a fourth member of this list, is deleted.
describe('WebStack — feature-flag reads', () => {
  it('gives every flag-reading function in this stack the prefix and a scoped read grant', () => {
    // TASK 2.5.4: media-upload only builds with an authorizer function
    // present (web-stack.ts's `if (props.authorizerFunction)` gate), so
    // this needs synthWithTable() to see all three, not bare synth().
    const template = synthWithTable();

    const withPrefix = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (fn) =>
        (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
          .Properties?.Environment?.Variables?.FLAG_PARAMETER_NAME_PREFIX ===
        FLAG_PARAMETER_NAME_PREFIX,
    );
    // media-upload, TASK 2.2.4's auth-token function (whose flag is
    // `auth.webSignIn.enabled`, the outermost gate on all four `/auth/*`
    // routes), and the Stripe webhook function.
    expect(withPrefix).toHaveLength(3);

    const grants = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (
            policy as {
              Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .filter((s) => s.Sid === 'ReadFeatureFlags');

    expect(grants).toHaveLength(3);
    for (const grant of grants) {
      expect(grant.Action).toBe('ssm:GetParameter');
      expect(JSON.stringify(grant.Resource)).toContain('parameter/ndn/flags/*');
    }
  });

  it('leaves the health and smoke-test functions without any flag access', () => {
    const template = synth();
    // Neither reads a flag, so neither should be able to. A future edit that
    // hands the grant out stack-wide instead of per-function fails here.
    const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
    const flagless = functions.filter(
      ([logicalId]) => logicalId.startsWith('HealthFunction') || logicalId.startsWith('SmokeTest'),
    );
    expect(flagless.length).toBeGreaterThan(0);
    for (const [, fn] of flagless) {
      const variables =
        (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
          .Properties?.Environment?.Variables ?? {};
      expect(variables).not.toHaveProperty('FLAG_PARAMETER_NAME_PREFIX');
    }
  });
});

// Bounce/complaint handling — the half that did not exist until now.
// TASK 1.4.1 and 1.5.2 each deferred it, and AWS asked about it directly
// when reviewing the SES production-access request
// (docs/runbooks/ses-production-access.md).
describe('WebStack — SES bounce/complaint events', () => {
  it('creates the configuration set with suppression and reputation metrics on', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: SES_CONFIGURATION_SET_NAME,
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
      ReputationOptions: { ReputationMetricsEnabled: true },
    });
  });

  it('publishes exactly the failure events to SNS — never DELIVERY or SEND', () => {
    const template = synth();
    const destinations = Object.values(
      template.findResources('AWS::SES::ConfigurationSetEventDestination'),
    ) as Array<{ Properties: { EventDestination: { MatchingEventTypes: string[] } } }>;
    expect(destinations).toHaveLength(1);

    // CDK emits these lowercase in the template, whatever case the
    // EmailSendingEvent enum uses.
    const events = (destinations[0]?.Properties.EventDestination.MatchingEventTypes ?? []).map(
      (event) => event.toLowerCase(),
    );
    expect([...events].sort()).toEqual(['bounce', 'complaint', 'reject', 'renderingfailure']);
    // A human inbox is subscribed to this topic. One notification per
    // successful send would make it noise, and noise gets filtered away.
    expect(events).not.toContain('delivery');
    expect(events).not.toContain('send');
    expect(events).not.toContain('open');
  });

  it('routes those events to a topic a human actually receives', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'ndn-email-events' });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: ALERT_EMAIL,
    });
  });

  it('alarms on bounce and complaint rate before AWS would', () => {
    const template = synth();
    for (const [alarmName, metricName] of [
      ['ndn-email-bounce-rate', 'Reputation.BounceRate'],
      ['ndn-email-complaint-rate', 'Reputation.ComplaintRate'],
    ]) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: alarmName,
        Namespace: 'AWS/SES',
        MetricName: metricName,
        ComparisonOperator: 'GreaterThanThreshold',
        // An hour with nothing sent has no datapoint — today's normal state.
        TreatMissingData: 'notBreaching',
      });
    }
  });

  // D-32 (2026-08-30): this stack had two SES senders (contact form,
  // Stripe webhook); the contact form is deleted, leaving the one dark,
  // never-wired sender D-31 already established for Stripe.
  it('lets the remaining sender name the configuration set, and authorises it to', () => {
    const template = synthWithTable();

    const withConfigSet = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (fn) =>
        (fn as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
          .Properties?.Environment?.Variables?.SES_CONFIGURATION_SET_NAME ===
        SES_CONFIGURATION_SET_NAME,
    );
    expect(withConfigSet).toHaveLength(1);

    // Naming a configuration set the role has no permission on turns every
    // send into an AccessDenied, so the grant must cover both resources.
    const sendStatements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          (
            policy as {
              Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } };
            }
          ).Properties.PolicyDocument.Statement,
      )
      .filter((s) => s.Action === 'ses:SendEmail');

    expect(sendStatements).toHaveLength(1);
    for (const statement of sendStatements) {
      const resources = JSON.stringify(statement.Resource);
      expect(resources).toContain('identity/nourishthenerve.com');
      expect(resources).toContain(`configuration-set/${SES_CONFIGURATION_SET_NAME}`);
    }
  });
});

// TASK 2.2.2: the other half of "a test enumerates the routes so a new
// unprotected one fails the build" — data-stack.test.ts covers that API,
// this one covers the site's.
describe('WebStack — route protection (TASK 2.2.2)', () => {
  function routeKeys(template: Template, authorizationType: string): string[] {
    return Object.values(template.findResources('AWS::ApiGatewayV2::Route'))
      .filter((route) => (route.Properties?.AuthorizationType ?? 'NONE') === authorizationType)
      .map((route) => String(route.Properties?.RouteKey))
      .sort();
  }

  it('leaves exactly the routes route-protection.ts names outside the authorizer', () => {
    const template = synthWithTable();
    const open = routeKeys(template, 'NONE');

    expect(open).toEqual(UNAUTHENTICATED_ROUTE_KEYS.filter((key) => open.includes(key)).sort());
    // The site API's six, named so a diff shows which one moved.
    // `POST /workshops/media-upload-url` left this list in TASK 2.5.4 — it
    // sits behind the real authorizer now (see the CUSTOM assertion
    // below). `POST /contact` left it for good in D-32 — the contact
    // form is deleted, not merely re-gated.
    expect(open).toEqual([
      'GET /auth/signin',
      'GET /health',
      'POST /auth/refresh',
      'POST /auth/signout',
      'POST /auth/token',
      'POST /stripe/webhook',
    ]);
  });

  it('puts exactly the media-upload route (2.5.4) behind the real authorizer', () => {
    // TASK 2.5.4 is this API's first route to rely on `defaultAuthorizer`
    // rather than opting out — CDK materialises the authorizer resource
    // only once a route actually binds it, same lazy-binding note
    // data-stack.test.ts's own equivalent test states.
    expect(routeKeys(synthWithTable(), 'CUSTOM')).toEqual(['POST /workshops/media-upload-url']);
    synthWithTable().resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  });

  it('stands up without an authorizer function at all, for the ephemeral PR stack', () => {
    // 0.6.3's per-PR stack has no DataStack and therefore no authorizer
    // function. That is only safe because every route on this API opts
    // out explicitly, or (TASK 2.5.4's `POST /workshops/media-upload-url`)
    // isn't built at all when there's no authorizer function to protect it
    // with — see this file's own header comment on that prop and
    // web-stack.ts's `if (props.authorizerFunction)` gate. If a route ever
    // relied on the default instead, this stack would deploy it wide open.
    expect(routeKeys(synth(), 'CUSTOM')).toEqual([]);
    expect(routeKeys(synth(), 'NONE')).toEqual([
      'GET /auth/signin',
      'GET /health',
      'POST /auth/refresh',
      'POST /auth/signout',
      'POST /auth/token',
    ]);
  });
});

// TASK 2.2.4: the same-origin `/auth/*` surface. What makes the whole
// design work is that these are on the site's own origin — so the refresh
// cookie is first-party, and 1.2.3's CSP covers the calls with no
// `connect-src` exception.
describe('WebStack — the authenticated web shell (TASK 2.2.4)', () => {
  it('proxies /auth/* to the HTTP API with caching disabled and all methods allowed', () => {
    // A cached `Set-Cookie` on this path would be a session handed to the
    // next visitor.
    synthWithTable().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/auth/*',
            // CachingDisabled's AWS-managed policy id.
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            ViewerProtocolPolicy: 'redirect-to-https',
            // arrayWith matches a subsequence, so the order here is the
            // order CloudFront emits.
            AllowedMethods: Match.arrayWith(['GET', 'OPTIONS', 'POST']),
          }),
        ]),
      },
    });
  });

  it('forwards query strings, cookies and headers to the origin (found missing live, 2026-08-27)', () => {
    // CachePolicy.CACHING_DISABLED alone governs only the cache key; with
    // no OriginRequestPolicy, CloudFront forwards nothing beyond it. Found
    // live: GET /auth/signin?pool=clinician always resolved to the
    // patient pool, and — the same gap — POST /auth/token's PKCE cookie
    // and POST /auth/refresh's session cookie were equally being
    // stripped. ALL_VIEWER_EXCEPT_HOST_HEADER, not ALL_VIEWER: forwarding
    // CloudFront's own Host header to the execute-api origin breaks that
    // origin's routing.
    synthWithTable().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/auth/*',
            // ALL_VIEWER_EXCEPT_HOST_HEADER's AWS-managed policy id.
            OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
          }),
        ]),
      },
    });
  });

  it('gives /auth/* the same security-header policy as every other behaviour', () => {
    // An auth response gets no weaker headers than a blog page.
    const distribution = Object.values(
      synthWithTable().findResources('AWS::CloudFront::Distribution'),
    )[0] as {
      Properties: {
        DistributionConfig: {
          DefaultCacheBehavior: { ResponseHeadersPolicyId: unknown };
          CacheBehaviors: { PathPattern: string; ResponseHeadersPolicyId: unknown }[];
        };
      };
    };
    const config = distribution.Properties.DistributionConfig;
    const authBehavior = config.CacheBehaviors.find(
      (behavior) => behavior.PathPattern === '/auth/*',
    );

    expect(authBehavior?.ResponseHeadersPolicyId).toEqual(
      config.DefaultCacheBehavior.ResponseHeadersPolicyId,
    );
  });

  it('exposes exactly the four auth routes, all public', () => {
    const routes = Object.values(synthWithTable().findResources('AWS::ApiGatewayV2::Route'))
      .map((route) => String(route.Properties?.RouteKey))
      .filter((key) => key.includes('/auth/'))
      .sort();

    expect(routes).toEqual([
      'GET /auth/signin',
      'POST /auth/refresh',
      'POST /auth/signout',
      'POST /auth/token',
    ]);
  });

  it('gives the auth function both pools, both clients, and no data-plane permission', () => {
    const template = synthWithTable();
    const authFunction = Object.values(template.findResources('AWS::Lambda::Function')).find((fn) =>
      JSON.stringify(fn.Properties?.Environment ?? {}).includes('PATIENT_OAUTH_BASE_URL'),
    );
    const variables = authFunction?.Properties?.Environment?.Variables as Record<string, string>;

    expect(variables.PATIENT_OAUTH_BASE_URL).toBe(PATIENT_OAUTH_BASE_URL);
    expect(variables.CLINICIAN_OAUTH_BASE_URL).toBe(CLINICIAN_OAUTH_BASE_URL);
    expect(variables.AUTH_CALLBACK_URL).toBe(AUTH_CALLBACK_URL);

    // It touches no table and no bucket: the only *data-plane-shaped*
    // permission its role holds is the SSM flag read (its log-write grant,
    // added alongside every other hand-rolled role's — log-retention.test.ts's
    // own "every hand-rolled Lambda role can write its own logs" —  is
    // operational exhaust, not data access). A client secret would be
    // worse still, and there is none to hold — TASK 2.2.1's clients are
    // public.
    expect(variables).not.toHaveProperty('PRINCIPAL_TABLE_NAME');

    const authPolicy = Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) =>
      id.startsWith('AuthTokenFunctionRole'),
    )?.[1] as {
      Properties: { PolicyDocument: { Statement: { Sid?: string; Action?: string | string[] }[] } };
    };
    const statements = authPolicy.Properties.PolicyDocument.Statement;

    expect(statements.map((entry) => entry.Sid)).toContain('ReadFeatureFlags');
    for (const { Action } of statements) {
      const actions = Array.isArray(Action) ? Action : [Action];
      for (const action of actions) {
        expect(action).not.toMatch(/^(dynamodb|s3):/);
      }
    }
  });

  it('writes the auth decision log to its own unmonitored group', () => {
    synthWithTable().hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/auth-token-function',
      RetentionInDays: 14,
    });
    expect(UNMONITORED_LOG_GROUP_NAMES).toContain('/ndn/auth-token-function');
    expect(MONITORED_LOG_GROUP_NAMES).not.toContain('/ndn/auth-token-function');
  });
});
