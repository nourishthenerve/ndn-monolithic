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
      DistributionConfig: Match.objectLike({ Aliases: [DOMAIN_NAME] }),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ndn/health-function',
    });
  });
});
