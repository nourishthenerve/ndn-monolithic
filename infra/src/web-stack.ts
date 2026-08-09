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
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import { CERTIFICATE_ARN, DOMAIN_NAME } from './config.js';

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
    });

    const httpApi = new HttpApi(this, 'HttpApi');
    httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', healthFunction),
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
  }
}
