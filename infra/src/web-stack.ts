// TASK 0.4.1: first CDK stack that deploys real resources — S3 site bucket,
// CloudFront (OAC-only, no public S3 access), an imported/pre-validated ACM
// certificate, a same-origin HTTP API + health Lambda behind CloudFront, and
// security response headers. See docs/plan/05-execution-plan.md and
// docs/runbooks/iac-baseline.md.

import { fileURLToPath } from 'node:url';

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Certificate, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import {
  LambdaApplication,
  LambdaDeploymentConfig,
  LambdaDeploymentGroup,
} from 'aws-cdk-lib/aws-codedeploy';
import { Alias, Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import { CERTIFICATE_ARN, DOMAIN_NAME } from './config.js';
import { createLogGroup } from './log-retention.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

export interface WebStackProps extends StackProps {
  /** Deploying commit SHA, surfaced by /health. Falls back to 'local'. */
  readonly deployVersion?: string;
}

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const siteBucket = new Bucket(this, 'SiteBucket', {
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Matches every other protected resource in this repo: never
      // auto-deleted by code, even on `cdk destroy` of this stack.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const certificate: ICertificate = Certificate.fromCertificateArn(
      this,
      'Certificate',
      CERTIFICATE_ARN,
    );

    const healthFunction = new NodejsFunction(this, 'HealthFunction', {
      entry: `${moduleDir}../../services/api/src/health.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      environment: {
        DEPLOY_VERSION: props.deployVersion ?? 'local',
      },
      // TASK 0.5.2 (R-11): explicit log group so retention is 14 days from
      // the first deploy — Lambda's own auto-created group defaults to
      // "never expire".
      logGroup: createLogGroup(this, 'HealthFunctionLogGroup', '/ndn/health-function'),
    });

    // TASK 0.6.2: publishing a Version + Alias, and routing every caller
    // (API Gateway below, CodeDeploy's traffic shift) through the alias
    // rather than the bare function, is what makes canary/rollback possible
    // at all — DoD's "Do NOT allow a deploy path that bypasses the alias."
    const healthAlias = new Alias(this, 'HealthAlias', {
      aliasName: 'live',
      version: healthFunction.currentVersion,
    });

    const httpApi = new HttpApi(this, 'HttpApi');
    httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', healthAlias),
    });

    // TASK 0.6.2: the AfterAllowTraffic hook (see docs/runbooks/rollback.md)
    // — runs once CodeDeploy has finished shifting traffic to the new
    // version, hits the live custom domain (proving DNS + cert + CDN +
    // origin + the new code all actually work), and reports Failed/
    // Succeeded back to CodeDeploy. A Failed report is what triggers the
    // automatic alias rollback.
    const smokeTestFunction = new NodejsFunction(this, 'SmokeTestFunction', {
      entry: `${moduleDir}../../services/api/src/smoke-test.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(30),
      environment: {
        SITE_DOMAIN: DOMAIN_NAME,
      },
      logGroup: createLogGroup(this, 'SmokeTestFunctionLogGroup', '/ndn/smoke-test-function'),
    });

    // TASK 0.6.2: CloudWatch alarms scoped to the alias (not the bare
    // function) so they reflect only traffic actually reaching the new
    // version during the canary window. Wired into the deployment group
    // below as the "stop and roll back automatically" trigger — separate
    // from, and faster than, the AfterAllowTraffic smoke test.
    const healthAliasErrorsAlarm = new Alarm(this, 'HealthAliasErrorsAlarm', {
      alarmDescription: 'Health Lambda alias is erroring during a canary deployment',
      metric: healthAlias.metricErrors({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const healthAliasLatencyAlarm = new Alarm(this, 'HealthAliasLatencyAlarm', {
      alarmDescription: 'Health Lambda alias latency is elevated during a canary deployment',
      // Function timeout is 5s; 3s is comfortably inside that while still
      // catching real degradation rather than ordinary cold-start jitter.
      metric: healthAlias.metricDuration({ period: Duration.minutes(1) }),
      threshold: Duration.seconds(3).toMilliseconds(),
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const healthDeploymentApplication = new LambdaApplication(this, 'HealthApplication');

    // TASK 0.6.2: this is what makes `cdk deploy` (CI's `deploy` job) shift
    // 10% of traffic to the new version, wait 5 minutes while the alarms
    // above watch it, then shift the rest — and automatically revert the
    // alias if either alarm trips or the smoke test reports Failed. See
    // docs/runbooks/rollback.md for how this was proven for real.
    const healthDeploymentGroup = new LambdaDeploymentGroup(this, 'HealthDeploymentGroup', {
      application: healthDeploymentApplication,
      alias: healthAlias,
      deploymentConfig: LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [healthAliasErrorsAlarm, healthAliasLatencyAlarm],
      postHook: smokeTestFunction,
    });

    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: HeadersFrameOption.DENY },
        referrerPolicy: {
          override: true,
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        },
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy:
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
        },
      },
    });

    const distribution = new Distribution(this, 'Distribution', {
      priceClass: PriceClass.PRICE_CLASS_100,
      domainNames: [DOMAIN_NAME],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        // Same-origin API (ADR 0003/D-08): /health is proxied through
        // CloudFront to the HTTP API rather than called cross-origin.
        // R-14: no-store — matches "no patient data traverses CloudFront"
        // even though /health itself carries none.
        '/health': {
          origin: new HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
      },
    });

    // Pruning superseded build assets on each deploy is ordinary deploy
    // hygiene, not deletion of "patient, clinical, content or media data"
    // (00-conventions.md) — this bucket holds nothing but built static
    // assets, and stays versioned regardless. See docs/runbooks/
    // iac-baseline.md for why guardrails.ts's runtime-role deny isn't
    // wired to this bucket.
    new BucketDeployment(this, 'SiteDeployment', {
      sources: [Source.asset(`${moduleDir}../assets/site`)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'HealthDeploymentGroupName', {
      value: healthDeploymentGroup.deploymentGroupName,
    });
  }
}
